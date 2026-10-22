import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ApiError, body } from '../lib/http';
import { ahora, first, run } from '../lib/db';
import { hashPassword, verificarPassword } from '../lib/crypto';
import { cerrarSesion, crearSesion, requireAuth } from '../lib/auth';
import { bloqueoVigente, clavesLogin, hashDeRelleno, registrarExitoLogin, registrarFalloLogin } from '../lib/seguridad';

export const auth = new Hono<AppEnv>();

const MENSAJE_BLOQUEO = 'Demasiados intentos fallidos. Probá de nuevo en unos minutos';

auth.post('/login', async (c) => {
  const { email, password } = await body(c, z.object({ email: z.string().trim().email(), password: z.string().min(1).max(200) }));
  const claves = await clavesLogin(c, email);
  // 1) Bloqueo temporal: se decide sólo con lo que mandó quien intenta (origen y correo), exista o no la cuenta.
  const bloqueo = await bloqueoVigente(c.env.DB, claves);
  if (bloqueo) throw new ApiError(429, 'bloqueado', MENSAJE_BLOQUEO); // el evento se registró una sola vez, al aplicar el bloqueo
  const u = await first<{ id: string; taller_id: string; password_hash: string; activo: number; acceso_erp: number; taller_activo: number }>(
    c.env.DB,
    `SELECT u.id, u.taller_id, u.password_hash, u.activo, u.acceso_erp, t.activo AS taller_activo
       FROM usuarios u JOIN talleres t ON t.id = u.taller_id WHERE u.email = ?`,
    email,
  );
  // 2) Siempre se verifica una contraseña (contra un hash de relleno si la cuenta no existe o no tiene acceso): mismo costo, mismo tiempo, misma respuesta.
  const tieneAcceso = !!u && !!u.acceso_erp;
  const hash = tieneAcceso ? u.password_hash : await hashDeRelleno(Number(c.env.PBKDF2_ITERATIONS ?? 100000));
  const ok = (await verificarPassword(password, hash)) && tieneAcceso;
  if (!ok) {
    await registrarFalloLogin(c.env.DB, claves, 'credenciales');
    throw new ApiError(401, 'credenciales_invalidas', 'Email o contraseña incorrectos');
  }
  // La contraseña es correcta: recién ahora se informa que el usuario o el taller están deshabilitados.
  if (!u.activo || !u.taller_activo) throw new ApiError(403, 'usuario_inactivo', 'El usuario o el taller están deshabilitados');
  await registrarExitoLogin(c.env.DB, claves);
  await run(c.env.DB, 'UPDATE usuarios SET ultimo_login = ? WHERE id = ?', ahora(), u.id);
  // Limpieza oportunista de sesiones vencidas del usuario.
  await run(c.env.DB, 'DELETE FROM sesiones WHERE usuario_id = ? AND expires_at < ?', u.id, ahora());
  await crearSesion(c, u.id, u.taller_id);
  return c.json({ ok: true });
});

auth.post('/logout', async (c) => {
  await cerrarSesion(c);
  return c.json({ ok: true });
});

auth.get('/me', requireAuth, async (c) => {
  const s = c.get('sesion');
  const taller = await first(c.env.DB, 'SELECT id, nombre, razon_social, cuit, condicion_iva, direccion, localidad, provincia, telefono, email FROM talleres WHERE id = ?', s.tallerId);
  const licencia = await first<{ plan: string; usuarios_incluidos: number; usuarios_adicionales: number; estado: string }>(
    c.env.DB,
    'SELECT plan, usuarios_incluidos, usuarios_adicionales, estado FROM licencias WHERE taller_id = ?',
    s.tallerId,
  );
  const cfg = await first<{ zona_horaria: string; reloj_activo: number; asistente_pendiente: number; tiene_logo: number }>(c.env.DB, 'SELECT zona_horaria, reloj_activo, asistente_pendiente, (logo IS NOT NULL) AS tiene_logo FROM taller_config WHERE taller_id = ?', s.tallerId);
  const yo = await first<{ pin_hash: string | null }>(c.env.DB, 'SELECT pin_hash FROM usuarios WHERE taller_id = ? AND id = ?', s.tallerId, s.usuarioId);
  return c.json({
    usuario: { id: s.usuarioId, nombre: s.nombre, email: s.email, rol: s.rol, nivel: s.nivel, tiene_pin: !!yo?.pin_hash },
    // Permisos efectivos (plantilla del rol + ajustes individuales): el frontend los usa solo para mostrar u ocultar opciones.
    permisos: [...s.permisos],
    taller: { ...taller, zona_horaria: cfg?.zona_horaria ?? 'America/Argentina/Buenos_Aires', reloj_activo: !!cfg?.reloj_activo, asistente_pendiente: !!cfg?.asistente_pendiente, tiene_logo: !!cfg?.tiene_logo },
    licencia,
  });
});

auth.post('/password', requireAuth, async (c) => {
  const s = c.get('sesion');
  const { actual, nueva } = await body(c, z.object({ actual: z.string().min(1), nueva: z.string().min(8, 'mínimo 8 caracteres').max(200) }));
  const u = await first<{ password_hash: string }>(c.env.DB, 'SELECT password_hash FROM usuarios WHERE id = ? AND taller_id = ?', s.usuarioId, s.tallerId);
  if (!u || !(await verificarPassword(actual, u.password_hash))) throw new ApiError(400, 'password_incorrecta', 'La contraseña actual no es correcta');
  const hash = await hashPassword(nueva, Number(c.env.PBKDF2_ITERATIONS ?? 100000));
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE usuarios SET password_hash = ? WHERE id = ? AND taller_id = ?').bind(hash, s.usuarioId, s.tallerId),
    // Cierra las demás sesiones del usuario
    c.env.DB.prepare('DELETE FROM sesiones WHERE usuario_id = ?').bind(s.usuarioId),
  ]);
  await crearSesion(c, s.usuarioId, s.tallerId);
  return c.json({ ok: true });
});
