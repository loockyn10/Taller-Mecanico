import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ApiError, body } from '../lib/http';
import { ahora, first, run } from '../lib/db';
import { hashPassword, verificarPassword } from '../lib/crypto';
import { cerrarSesion, crearSesion, requireAuth } from '../lib/auth';
import { PERMISOS_POR_ROL, type Rol } from '../../shared/permisos';

const MAX_INTENTOS = 5;
const BLOQUEO_MIN = 15;

export const auth = new Hono<AppEnv>();

auth.post('/login', async (c) => {
  const { email, password } = await body(c, z.object({ email: z.string().trim().email(), password: z.string().min(1).max(200) }));
  const u = await first<{ id: string; taller_id: string; password_hash: string; activo: number; intentos_fallidos: number; bloqueado_hasta: string | null; taller_activo: number }>(
    c.env.DB,
    `SELECT u.id, u.taller_id, u.password_hash, u.activo, u.intentos_fallidos, u.bloqueado_hasta, t.activo AS taller_activo
       FROM usuarios u JOIN talleres t ON t.id = u.taller_id WHERE u.email = ?`,
    email,
  );
  const error = new ApiError(401, 'credenciales_invalidas', 'Email o contraseña incorrectos');
  if (!u) throw error;
  if (u.bloqueado_hasta && u.bloqueado_hasta > ahora()) {
    throw new ApiError(429, 'bloqueado', `Demasiados intentos fallidos. Probá de nuevo en ${BLOQUEO_MIN} minutos`);
  }
  const ok = await verificarPassword(password, u.password_hash);
  if (!ok) {
    const intentos = u.intentos_fallidos + 1;
    const bloqueo = intentos >= MAX_INTENTOS ? new Date(Date.now() + BLOQUEO_MIN * 60_000).toISOString() : null;
    await run(c.env.DB, 'UPDATE usuarios SET intentos_fallidos = ?, bloqueado_hasta = ? WHERE id = ?', bloqueo ? 0 : intentos, bloqueo, u.id);
    throw error;
  }
  if (!u.activo || !u.taller_activo) throw new ApiError(403, 'usuario_inactivo', 'El usuario o el taller están deshabilitados');
  await run(c.env.DB, 'UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL, ultimo_login = ? WHERE id = ?', ahora(), u.id);
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
  const taller = await first(c.env.DB, 'SELECT id, nombre, razon_social, cuit, condicion_iva, direccion, localidad, telefono, email FROM talleres WHERE id = ?', s.tallerId);
  const licencia = await first<{ plan: string; usuarios_incluidos: number; usuarios_adicionales: number; estado: string }>(
    c.env.DB,
    'SELECT plan, usuarios_incluidos, usuarios_adicionales, estado FROM licencias WHERE taller_id = ?',
    s.tallerId,
  );
  return c.json({
    usuario: { id: s.usuarioId, nombre: s.nombre, email: s.email, rol: s.rol },
    permisos: PERMISOS_POR_ROL[s.rol as Rol],
    taller,
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
