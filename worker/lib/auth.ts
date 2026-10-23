import type { MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv, Sesion } from '../env';
import { esRol, leerAjustes, nivelDeRol, permisosEfectivos, type Nivel, type Permiso, type Rol } from '../../shared/permisos';
import { ApiError, forbidden } from './http';
import { sha256Hex, tokenAleatorio } from './crypto';
import { ahora, first, run } from './db';

export const COOKIE = 'fierro_sid';

function esLocal(url: string) {
  const h = new URL(url).hostname;
  return h === 'localhost' || h === '127.0.0.1';
}

export async function crearSesion(c: Parameters<MiddlewareHandler<AppEnv>>[0], usuarioId: string, tallerId: string) {
  const token = tokenAleatorio();
  const dias = Number(c.env.SESSION_DAYS ?? 14);
  const expira = new Date(Date.now() + dias * 86400_000).toISOString();
  await run(
    c.env.DB,
    'INSERT INTO sesiones (token_hash, usuario_id, taller_id, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)',
    await sha256Hex(token),
    usuarioId,
    tallerId,
    expira,
    (c.req.header('user-agent') ?? '').slice(0, 200),
  );
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: !esLocal(c.req.url),
    sameSite: 'Lax',
    path: '/',
    maxAge: dias * 86400,
  });
}

export async function cerrarSesion(c: Parameters<MiddlewareHandler<AppEnv>>[0]) {
  const token = getCookie(c, COOKIE);
  if (token) await run(c.env.DB, 'DELETE FROM sesiones WHERE token_hash = ?', await sha256Hex(token));
  deleteCookie(c, COOKIE, { path: '/' });
}

/**
 * Autentica la solicitud y fija la sesión. El taller_id SIEMPRE proviene de la sesión del servidor,
 * nunca de parámetros de la solicitud: esa es la base de la separación entre empresas.
 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, COOKIE);
  if (!token) throw new ApiError(401, 'no_autenticado', 'Iniciá sesión para continuar');
  const fila = await first<{
    usuario_id: string; taller_id: string; expires_at: string; rol: Nivel; plantilla: string | null; permisos_ajustes: string | null; acceso_erp: number;
    nombre: string; apellido: string | null; email: string; usuario_activo: number; taller_activo: number; licencia_estado: string | null;
  }>(
    c.env.DB,
    `SELECT s.usuario_id, s.taller_id, s.expires_at, u.rol, u.plantilla, u.permisos_ajustes, u.acceso_erp, u.nombre, u.apellido, u.email, u.activo AS usuario_activo,
            t.activo AS taller_activo, l.estado AS licencia_estado
       FROM sesiones s
       JOIN usuarios u ON u.id = s.usuario_id AND u.taller_id = s.taller_id
       JOIN talleres t ON t.id = s.taller_id
       LEFT JOIN licencias l ON l.taller_id = s.taller_id
      WHERE s.token_hash = ?`,
    await sha256Hex(token),
  );
  if (!fila || fila.expires_at < ahora() || !fila.usuario_activo || !fila.taller_activo || !fila.acceso_erp) {
    deleteCookie(c, COOKIE, { path: '/' });
    throw new ApiError(401, 'sesion_invalida', 'Tu sesión expiró. Iniciá sesión nuevamente');
  }
  // El rol de plantilla y los ajustes individuales se leen de la base en cada solicitud: un cambio de permisos rige de inmediato.
  const rol: Rol = esRol(fila.plantilla) && nivelDeRol(fila.plantilla) === fila.rol ? fila.plantilla : fila.rol;
  const sesion: Sesion = {
    usuarioId: fila.usuario_id,
    tallerId: fila.taller_id,
    rol,
    nivel: fila.rol,
    nombre: fila.apellido ? `${fila.nombre} ${fila.apellido}` : fila.nombre,
    email: fila.email,
    permisos: new Set(permisosEfectivos(rol, leerAjustes(fila.permisos_ajustes))),
    licenciaActiva: fila.licencia_estado === 'activa',
  };
  // Con la licencia suspendida el taller conserva acceso de solo lectura a sus datos.
  if (!sesion.licenciaActiva && c.req.method !== 'GET' && !c.req.path.startsWith('/api/auth/')) {
    throw new ApiError(403, 'licencia_suspendida', 'La licencia del taller está suspendida: solo se permite consultar información');
  }
  c.set('sesion', sesion);
  await next();
};

/** ¿La sesión tiene el permiso? (permisos efectivos de la plantilla + ajustes individuales) */
export const tiene = (s: Sesion, p: Permiso): boolean => s.permisos.has(p);

/** Exige TODOS los permisos indicados. */
export function requirePerm(...permisos: Permiso[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const s = c.get('sesion');
    if (!permisos.every((p) => tiene(s, p))) throw forbidden();
    await next();
  };
}

/** Exige AL MENOS UNO de los permisos indicados. */
export function requireAny(...permisos: Permiso[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const s = c.get('sesion');
    if (!permisos.some((p) => tiene(s, p))) throw forbidden();
    await next();
  };
}

/** Separa lectura y escritura: las consultas (GET/HEAD) piden `lectura`; todo lo demás pide `escritura`. */
export function requireRW(lectura: Permiso, escritura: Permiso): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const s = c.get('sesion');
    const necesario = c.req.method === 'GET' || c.req.method === 'HEAD' ? lectura : escritura;
    if (!tiene(s, necesario)) throw forbidden();
    await next();
  };
}

/** Protección CSRF: las mutaciones deben enviarse como JSON (un formulario de otro sitio no puede hacerlo sin preflight CORS). */
export const requireJson: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const ct = c.req.header('content-type') ?? '';
    // Única excepción: la subida de fotos (multipart). Esa ruta exige además un encabezado propio y la sesión SameSite=Lax.
    const subidaDeFoto = c.req.method === 'POST' && c.req.path === '/api/fotos' && ct.startsWith('multipart/form-data') && c.req.header('x-fierro-subida') === '1';
    if (!ct.includes('application/json') && !subidaDeFoto) throw new ApiError(415, 'tipo_contenido', 'Las solicitudes deben enviarse como application/json');
  }
  await next();
};
