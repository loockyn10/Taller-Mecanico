// Seguridad de la autenticación y eventos de seguridad.
//
// Principios:
//  * Respuesta UNIFORME: un correo inexistente, una cuenta sin acceso y una contraseña incorrecta responden lo mismo y tardan lo mismo (se verifica contra un
//    hash falso). Un bloqueo también se decide sólo con lo que mandó quien intenta (huella del correo y origen), exista o no la cuenta.
//  * Tres contadores independientes (tabla `limites_intentos`, ya existente): por ORIGEN (muchas cuentas desde un mismo lugar), por CUENTA+ORIGEN (alguien que
//    se equivoca de clave) y por CUENTA (ataque repartido en muchos orígenes). Todos expiran solos: ningún bloqueo es permanente ni exige intervención.
//  * Un tercero no puede dejar afuera a la persona legítima: el bloqueo por CUENTA no rige para un origen desde el cual esa cuenta ya inició sesión bien
//    en los últimos 30 días (sólo rigen los contadores por origen).
//  * Los eventos de seguridad guardan HUELLAS cortas del origen y de la cuenta, nunca contraseñas, tokens, IP ni correos en claro.
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { ahora, all, run, uid } from './db';
import { hashPassword, sha256Hex } from './crypto';
import { registrarFallo } from './limites';

export const LIMITES_LOGIN = {
  origen: { max: 25, ventanaMin: 15, bloqueoMin: 15 },
  cuentaOrigen: { max: 5, ventanaMin: 15, bloqueoMin: 15 },
  cuenta: { max: 30, ventanaMin: 60, bloqueoMin: 10 },
} as const;
const CONOCIDO_DIAS = 30;

/** Origen de la solicitud (Cloudflare fija `cf-connecting-ip`; en desarrollo local no hay y todos comparten "local"). */
export function origenDe(c: Context<AppEnv>): string {
  return (c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0] ?? 'local').trim().slice(0, 64);
}

/** Huella corta y estable (12 hex de SHA-256) para correlacionar eventos sin guardar el dato. */
export async function huellaCorta(valor: string): Promise<string> {
  return (await sha256Hex(`fierro-huella:${valor.toLowerCase()}`)).slice(0, 12);
}

export interface EventoSeguridad {
  tipo: string;
  tallerId?: string | null;
  usuarioId?: string | null;
  origen?: string | null;
  cuenta?: string | null;
  detalle?: Record<string, unknown>;
}

/** Deja constancia de un evento de seguridad. Nunca interrumpe la operación que lo origina. */
export async function registrarEvento(db: D1Database, e: EventoSeguridad): Promise<void> {
  try {
    await run(
      db,
      'INSERT INTO eventos_seguridad (id, tipo, taller_id, usuario_id, origen, cuenta, detalle) VALUES (?, ?, ?, ?, ?, ?, ?)',
      uid(), e.tipo, e.tallerId ?? null, e.usuarioId ?? null, e.origen ?? null, e.cuenta ?? null, e.detalle ? JSON.stringify(e.detalle).slice(0, 500) : null,
    );
  } catch {
    /* la observabilidad no puede romper el inicio de sesión */
  }
}

export interface ClavesLogin {
  origen: string;
  cuentaOrigen: string;
  cuenta: string;
  conocido: string;
  huellaOrigen: string;
  huellaCuenta: string;
}

export async function clavesLogin(c: Context<AppEnv>, email: string): Promise<ClavesLogin> {
  const o = origenDe(c);
  const [huellaOrigen, huellaCuenta] = await Promise.all([huellaCorta(o), huellaCorta(email.trim())]);
  return {
    origen: `login:o:${huellaOrigen}`,
    cuentaOrigen: `login:co:${huellaCuenta}:${huellaOrigen}`,
    cuenta: `login:c:${huellaCuenta}`,
    conocido: `login:ok:${huellaCuenta}:${huellaOrigen}`,
    huellaOrigen,
    huellaCuenta,
  };
}

/** ¿Alguna de las claves está bloqueada ahora? (una sola consulta). Devuelve cuál. */
export async function bloqueoVigente(db: D1Database, k: ClavesLogin): Promise<'origen' | 'cuentaOrigen' | 'cuenta' | null> {
  const filas = await all<{ clave: string; bloqueado_hasta: string | null; desde: string }>(db, 'SELECT clave, bloqueado_hasta, desde FROM limites_intentos WHERE clave IN (?, ?, ?, ?)', k.origen, k.cuentaOrigen, k.cuenta, k.conocido);
  const vigente = (clave: string) => filas.find((f) => f.clave === clave && f.bloqueado_hasta && f.bloqueado_hasta > ahora());
  if (vigente(k.origen)) return 'origen';
  if (vigente(k.cuentaOrigen)) return 'cuentaOrigen';
  const conocido = filas.find((f) => f.clave === k.conocido);
  const esConocido = !!conocido && Date.parse(conocido.desde) > Date.now() - CONOCIDO_DIAS * 86400_000;
  if (!esConocido && vigente(k.cuenta)) return 'cuenta';
  return null;
}

/** Cuenta un inicio de sesión fallido en los tres contadores y deja constancia; si alguno se pasó, registra el bloqueo. */
export async function registrarFalloLogin(db: D1Database, k: ClavesLogin, motivo: 'credenciales'): Promise<void> {
  const L = LIMITES_LOGIN;
  const [o, co, c] = [
    await registrarFallo(db, k.origen, L.origen.max, L.origen.ventanaMin, L.origen.bloqueoMin),
    await registrarFallo(db, k.cuentaOrigen, L.cuentaOrigen.max, L.cuentaOrigen.ventanaMin, L.cuentaOrigen.bloqueoMin),
    await registrarFallo(db, k.cuenta, L.cuenta.max, L.cuenta.ventanaMin, L.cuenta.bloqueoMin),
  ];
  await registrarEvento(db, { tipo: 'login_fallido', origen: k.huellaOrigen, cuenta: k.huellaCuenta, detalle: { motivo } });
  const bloqueos = [o === 0 && 'origen', co === 0 && 'cuenta_origen', c === 0 && 'cuenta'].filter(Boolean);
  if (bloqueos.length) await registrarEvento(db, { tipo: 'login_bloqueo_aplicado', origen: k.huellaOrigen, cuenta: k.huellaCuenta, detalle: { por: bloqueos } });
}

/** Un inicio de sesión correcto levanta el bloqueo de la cuenta desde ese origen y lo marca como origen conocido. */
export async function registrarExitoLogin(db: D1Database, k: ClavesLogin): Promise<void> {
  const t = ahora();
  await db.batch([
    db.prepare('DELETE FROM limites_intentos WHERE clave IN (?, ?)').bind(k.cuentaOrigen, k.cuenta),
    db.prepare("INSERT INTO limites_intentos (clave, intentos, desde, bloqueado_hasta) VALUES (?, 0, ?, NULL) ON CONFLICT (clave) DO UPDATE SET desde = excluded.desde, intentos = 0, bloqueado_hasta = NULL").bind(k.conocido, t),
  ]);
}

// Hash falso con las mismas iteraciones que los reales: verificarlo cuesta lo mismo que verificar una contraseña real.
let hashFalso: { iteraciones: number; valor: Promise<string> } | null = null;
export function hashDeRelleno(iteraciones: number): Promise<string> {
  if (!hashFalso || hashFalso.iteraciones !== iteraciones) hashFalso = { iteraciones, valor: hashPassword(`relleno-${crypto.randomUUID()}`, iteraciones) };
  return hashFalso.valor;
}
