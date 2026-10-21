// Reloj compartido: pantalla de fichaje para una tablet o computadora del taller.
//
// Seguridad:
//  * El dispositivo se registra con un código de un solo uso (vence en 15 minutos) que genera el propietario. Al activarlo recibe un
//    token propio (cookie HttpOnly; en la base solo se guarda su hash) que habilita ÚNICAMENTE estos endpoints: no abre el resto del sistema.
//  * El propietario puede apagar el modo reloj o revocar un dispositivo en cualquier momento; el efecto es inmediato.
//  * El PIN se guarda con hash salado (PBKDF2). Los intentos fallidos se limitan por persona (bloqueo temporal) y por dispositivo.
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ApiError, badRequest, body, conflict, forbidden, notFound } from '../lib/http';
import { ahora, all, auditar, first, run, uid } from '../lib/db';
import { requirePerm } from '../lib/auth';
import { sha256Hex, tokenAleatorio, verificarPassword } from '../lib/crypto';
import { exigirNoBloqueado, limpiarFallos, registrarFallo } from '../lib/limites';
import { PIN_BLOQUEO_MIN, PIN_MAX_INTENTOS } from '../lib/pin';
import { registrarEntrada, registrarSalida } from '../lib/asistencia';
import { horaLocal } from '../lib/zona';
import { esRol, leerAjustes, nivelDeRol, permisosEfectivos, type Nivel, type Rol } from '../../shared/permisos';

const COOKIE_RELOJ = 'fierro_reloj';
const CODIGO_VIDA_MIN = 15;
const MAX_DISPOSITIVOS = 10;
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const esLocal = (url: string) => ['localhost', '127.0.0.1'].includes(new URL(url).hostname);

function generarCodigo(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return [...b].map((x) => ALFABETO[x % ALFABETO.length]).join('');
}
const normalizarCodigo = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

interface DispositivoSesion {
  id: string;
  tallerId: string;
  nombre: string;
  taller: string;
  zona: string;
  licenciaActiva: boolean;
}

type EnvReloj = { Bindings: AppEnv['Bindings']; Variables: { dispositivo: DispositivoSesion } };

// ───────────────────────── Pantalla del dispositivo ─────────────────────────
export const relojPublico = new Hono<EnvReloj>();

relojPublico.post('/activar', async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  const claveLimite = `act:${ip}`;
  await exigirNoBloqueado(c.env.DB, claveLimite, 'Demasiados intentos de activación. Probá de nuevo en 30 minutos');
  const d = await body(c, z.object({ codigo: z.string().trim().min(6).max(20) }));
  const hash = await sha256Hex(normalizarCodigo(d.codigo));
  const dev = await first<{ id: string; taller_id: string; nombre: string; taller: string; taller_activo: number; reloj_activo: number }>(
    c.env.DB,
    `SELECT d.id, d.taller_id, d.nombre, t.nombre AS taller, t.activo AS taller_activo, COALESCE(cfg.reloj_activo, 0) AS reloj_activo
       FROM dispositivos_reloj d JOIN talleres t ON t.id = d.taller_id LEFT JOIN taller_config cfg ON cfg.taller_id = d.taller_id
      WHERE d.codigo_hash = ? AND d.estado = 'pendiente' AND d.codigo_expira > ?`,
    hash,
    ahora(),
  );
  if (!dev || !dev.taller_activo) {
    await registrarFallo(c.env.DB, claveLimite, 8, 15, 30);
    throw badRequest('El código es inválido o ya venció. Pedí uno nuevo al propietario del taller');
  }
  if (!dev.reloj_activo) throw forbidden('El modo reloj está desactivado en este taller');
  const token = tokenAleatorio();
  const r = await run(
    c.env.DB,
    "UPDATE dispositivos_reloj SET estado = 'activo', token_hash = ?, codigo_hash = NULL, codigo_expira = NULL, activado_at = ?, ultimo_uso = ?, user_agent = ? WHERE id = ? AND estado = 'pendiente'",
    await sha256Hex(token), ahora(), ahora(), (c.req.header('user-agent') ?? '').slice(0, 200), dev.id,
  );
  if (!r.meta.changes) throw badRequest('El código ya fue utilizado');
  await limpiarFallos(c.env.DB, claveLimite);
  await auditar(c.env.DB, dev.taller_id, null, 'reloj', dev.id, 'activar', { nombre: dev.nombre }).run();
  setCookie(c, COOKIE_RELOJ, token, { httpOnly: true, secure: !esLocal(c.req.url), sameSite: 'Strict', path: '/api/reloj', maxAge: 400 * 86400 });
  return c.json({ ok: true, dispositivo: dev.nombre, taller: dev.taller });
});

/** Autentica el dispositivo por su token. El taller sale siempre del dispositivo, nunca de la solicitud. */
const requireDispositivo: MiddlewareHandler<EnvReloj> = async (c, next) => {
  const token = getCookie(c, COOKIE_RELOJ);
  if (!token) throw new ApiError(401, 'dispositivo_no_activado', 'Este dispositivo no está activado como reloj');
  const f = await first<{ id: string; taller_id: string; nombre: string; taller: string; taller_activo: number; reloj_activo: number | null; zona_horaria: string | null; licencia: string | null; ultimo_uso: string | null }>(
    c.env.DB,
    `SELECT d.id, d.taller_id, d.nombre, t.nombre AS taller, t.activo AS taller_activo, cfg.reloj_activo, cfg.zona_horaria, l.estado AS licencia, d.ultimo_uso
       FROM dispositivos_reloj d JOIN talleres t ON t.id = d.taller_id LEFT JOIN taller_config cfg ON cfg.taller_id = d.taller_id LEFT JOIN licencias l ON l.taller_id = d.taller_id
      WHERE d.token_hash = ? AND d.estado = 'activo'`,
    await sha256Hex(token),
  );
  if (!f || !f.taller_activo) {
    deleteCookie(c, COOKIE_RELOJ, { path: '/api/reloj' });
    throw new ApiError(401, 'dispositivo_revocado', 'Este dispositivo ya no está autorizado como reloj');
  }
  if (!f.reloj_activo) throw new ApiError(403, 'reloj_desactivado', 'El modo reloj está desactivado');
  // Con la licencia suspendida el taller solo consulta (igual que el resto del sistema).
  if (f.licencia !== 'activa' && c.req.method !== 'GET') throw new ApiError(403, 'licencia_suspendida', 'La licencia del taller está suspendida');
  if (!f.ultimo_uso || Date.parse(f.ultimo_uso) < Date.now() - 5 * 60_000) await run(c.env.DB, 'UPDATE dispositivos_reloj SET ultimo_uso = ? WHERE id = ?', ahora(), f.id);
  c.set('dispositivo', { id: f.id, tallerId: f.taller_id, nombre: f.nombre, taller: f.taller, zona: f.zona_horaria ?? 'America/Argentina/Buenos_Aires', licenciaActiva: f.licencia === 'activa' });
  await next();
};
relojPublico.use('/estado', requireDispositivo);
relojPublico.use('/fichar', requireDispositivo);

interface FilaPersonal { id: string; nombre: string; apellido: string | null; rol: Nivel; plantilla: string | null; permisos_ajustes: string | null; pin_hash: string | null; pin_intentos: number; pin_bloqueado_hasta: string | null; activo: number }

const nombreDe = (u: { nombre: string; apellido: string | null }) => (u.apellido ? `${u.nombre} ${u.apellido}` : u.nombre);
const puedeFichar = (u: FilaPersonal) => {
  const rol: Rol = esRol(u.plantilla) && nivelDeRol(u.plantilla) === u.rol ? u.plantilla : u.rol;
  return permisosEfectivos(rol, leerAjustes(u.permisos_ajustes)).includes('asistencia.fichar');
};

/** Personas que pueden fichar en el reloj: activas, con PIN y con permiso de asistencia. Cada una indica si está dentro (jornada abierta). */
relojPublico.get('/estado', async (c) => {
  const dev = c.get('dispositivo');
  const [personal, abiertas] = await Promise.all([
    all<FilaPersonal>(c.env.DB, 'SELECT id, nombre, apellido, rol, plantilla, permisos_ajustes, pin_hash, pin_intentos, pin_bloqueado_hasta, activo FROM usuarios WHERE taller_id = ? AND activo = 1 AND pin_hash IS NOT NULL ORDER BY nombre COLLATE NOCASE, apellido COLLATE NOCASE', dev.tallerId),
    all<{ usuario_id: string }>(c.env.DB, 'SELECT usuario_id FROM asistencias WHERE taller_id = ? AND salida_at IS NULL AND anulado = 0', dev.tallerId),
  ]);
  const dentro = new Set(abiertas.map((a) => a.usuario_id));
  return c.json({
    taller: dev.taller,
    dispositivo: dev.nombre,
    zona: dev.zona,
    ahora: new Date().toISOString(),
    personal: personal.filter(puedeFichar).map((u) => ({ id: u.id, nombre: nombreDe(u), dentro: dentro.has(u.id) })),
  });
});

relojPublico.post('/fichar', async (c) => {
  const dev = c.get('dispositivo');
  const d = await body(c, z.object({ usuario_id: z.string().min(1).max(64), pin: z.string().regex(/^\d{4,8}$/, 'PIN inválido'), accion: z.enum(['entrada', 'salida']) }));
  const claveDispositivo = `pin:${dev.id}`;
  await exigirNoBloqueado(c.env.DB, claveDispositivo, 'Este reloj está bloqueado unos minutos por demasiados intentos fallidos');
  const u = await first<FilaPersonal>(
    c.env.DB,
    'SELECT id, nombre, apellido, rol, plantilla, permisos_ajustes, pin_hash, pin_intentos, pin_bloqueado_hasta, activo FROM usuarios WHERE taller_id = ? AND id = ?',
    dev.tallerId,
    d.usuario_id,
  );
  const incorrecto = async () => {
    await registrarFallo(c.env.DB, claveDispositivo, 10, 10, 30);
    return new ApiError(401, 'pin_invalido', 'PIN incorrecto');
  };
  if (!u || !u.activo || !u.pin_hash || !puedeFichar(u)) throw await incorrecto();
  if (u.pin_bloqueado_hasta && u.pin_bloqueado_hasta > ahora()) {
    throw new ApiError(429, 'pin_bloqueado', `El PIN está bloqueado por intentos fallidos. Esperá ${PIN_BLOQUEO_MIN} minutos o pedile al propietario que lo desbloquee`);
  }
  if (!(await verificarPassword(d.pin, u.pin_hash))) {
    const intentos = u.pin_intentos + 1;
    const bloquear = intentos >= PIN_MAX_INTENTOS;
    await run(
      c.env.DB,
      'UPDATE usuarios SET pin_intentos = ?, pin_bloqueado_hasta = ? WHERE taller_id = ? AND id = ?',
      bloquear ? 0 : intentos,
      bloquear ? new Date(Date.now() + PIN_BLOQUEO_MIN * 60_000).toISOString() : null,
      dev.tallerId,
      u.id,
    );
    await registrarFallo(c.env.DB, claveDispositivo, 10, 10, 30);
    if (bloquear) await auditar(c.env.DB, dev.tallerId, null, 'usuario', u.id, 'pin_bloqueado', { dispositivo: dev.nombre }).run();
    throw new ApiError(401, 'pin_invalido', bloquear ? `PIN incorrecto. Se bloqueó por ${PIN_BLOQUEO_MIN} minutos` : `PIN incorrecto. Te quedan ${PIN_MAX_INTENTOS - intentos} intento(s)`);
  }
  if (u.pin_intentos > 0 || u.pin_bloqueado_hasta) await run(c.env.DB, 'UPDATE usuarios SET pin_intentos = 0, pin_bloqueado_hasta = NULL WHERE taller_id = ? AND id = ?', dev.tallerId, u.id);
  const j = d.accion === 'entrada' ? await registrarEntrada(c.env.DB, dev.tallerId, u.id, 'reloj', dev.id) : await registrarSalida(c.env.DB, dev.tallerId, u.id, 'reloj', dev.id);
  return c.json({
    ok: true,
    accion: d.accion,
    empleado: nombreDe(u),
    hora: horaLocal(d.accion === 'entrada' ? j.entrada_at : j.salida_at!, dev.zona),
    duracion_seg: j.duracion_seg,
  });
});

// ───────────────────────── Administración (propietario) ─────────────────────────
export const relojAdmin = new Hono<AppEnv>();
relojAdmin.use('/dispositivos', requirePerm('reloj.administrar'));
relojAdmin.use('/dispositivos/*', requirePerm('reloj.administrar'));
relojAdmin.use('/reloj', requirePerm('reloj.administrar'));

relojAdmin.get('/dispositivos', async (c) => {
  const s = c.get('sesion');
  const cfg = await first<{ reloj_activo: number }>(c.env.DB, 'SELECT reloj_activo FROM taller_config WHERE taller_id = ?', s.tallerId);
  const filas = await all<any>(
    c.env.DB,
    `SELECT d.id, d.nombre, d.estado, d.codigo_expira, d.activado_at, d.ultimo_uso, d.revocado_at, d.user_agent, d.created_at, u.nombre AS creado_por
       FROM dispositivos_reloj d LEFT JOIN usuarios u ON u.taller_id = d.taller_id AND u.id = d.creado_por
      WHERE d.taller_id = ? ORDER BY d.created_at DESC LIMIT 50`,
    s.tallerId,
  );
  const ahoraIso = ahora();
  return c.json({
    reloj_activo: !!cfg?.reloj_activo,
    dispositivos: filas.map(({ codigo_expira, ...d }) => ({ ...d, vencido: d.estado === 'pendiente' && (!codigo_expira || codigo_expira <= ahoraIso) })),
  });
});

relojAdmin.put('/reloj', async (c) => {
  const s = c.get('sesion');
  const d = await body(c, z.object({ activo: z.boolean() }));
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE taller_config SET reloj_activo = ? WHERE taller_id = ?').bind(d.activo ? 1 : 0, s.tallerId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'reloj', null, d.activo ? 'activar_modo' : 'desactivar_modo'),
  ]);
  return c.json({ ok: true });
});

/** Registra un dispositivo nuevo: devuelve el código de activación (se muestra una sola vez). Activa el modo reloj del taller. */
relojAdmin.post('/dispositivos', async (c) => {
  const s = c.get('sesion');
  const d = await body(c, z.object({ nombre: z.string().trim().min(2).max(60) }));
  const n = await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM dispositivos_reloj WHERE taller_id = ? AND estado <> 'revocado'", s.tallerId);
  if ((n?.n ?? 0) >= MAX_DISPOSITIVOS) throw conflict(`Podés tener hasta ${MAX_DISPOSITIVOS} dispositivos: revocá alguno que ya no uses`);
  const codigo = generarCodigo();
  const id = uid();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO dispositivos_reloj (id, taller_id, nombre, codigo_hash, codigo_expira, creado_por) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, s.tallerId, d.nombre, await sha256Hex(codigo), new Date(Date.now() + CODIGO_VIDA_MIN * 60_000).toISOString(), s.usuarioId),
    c.env.DB.prepare('UPDATE taller_config SET reloj_activo = 1 WHERE taller_id = ?').bind(s.tallerId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'reloj', id, 'registrar_dispositivo', { nombre: d.nombre }),
  ]);
  return c.json({ id, codigo: `${codigo.slice(0, 4)}-${codigo.slice(4)}`, vence_en_min: CODIGO_VIDA_MIN }, 201);
});

relojAdmin.post('/dispositivos/:id/revocar', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const dev = await first<{ estado: string }>(c.env.DB, 'SELECT estado FROM dispositivos_reloj WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!dev) throw notFound('Dispositivo');
  if (dev.estado === 'revocado') return c.json({ ok: true });
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE dispositivos_reloj SET estado = 'revocado', token_hash = NULL, codigo_hash = NULL, codigo_expira = NULL, revocado_at = ?, revocado_por = ? WHERE taller_id = ? AND id = ?")
      .bind(ahora(), s.usuarioId, s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'reloj', id, 'revocar_dispositivo'),
  ]);
  return c.json({ ok: true });
});
