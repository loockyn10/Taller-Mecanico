// Seguimiento público de órdenes: endpoints SIN sesión (el cliente entra con el enlace).
//   GET  /seguimiento/:token              página HTML (lo que abre el cliente desde su celular o desde el QR)
//   GET  /seguimiento/:token/logo         logotipo del taller de esa orden
//   POST /seguimiento/:token/medio        elegir cómo paga (efectivo / transferencia) o confirmar que pagará en efectivo — NO genera ningún cobro
//   POST /seguimiento/:token/comprobante  enviar el comprobante de una transferencia — queda pendiente de verificación, NO genera ningún cobro
//   GET  /api/seguimiento/:token          los mismos datos en JSON
//
// Seguridad (ver docs/SEGUIMIENTO.md y docs/PAGOS_CLIENTE.md):
//  * La única credencial es el token (256 bits). Se verifica el formato antes de tocar la base y la búsqueda es por igualdad exacta sobre un índice único con `activo = 1`:
//    revocar o regenerar el enlace corta TAMBIÉN el envío de comprobantes y la elección del medio de pago (todas las acciones vuelven a resolver el token).
//  * El token sólo determina taller y orden: ninguna acción acepta identificadores de orden, de comprobante, de cuenta ni importes del visitante.
//  * Enlace inexistente, desactivado o reemplazado: la misma respuesta 404 (no se puede distinguir cuál es el caso).
//  * Límites por origen: intentos fallidos de acceso, elecciones y envíos de comprobantes (cada intento cuenta), más topes por orden en `lib/pago-cliente.ts`.
//  * Cabeceras: sin caché (ni en el navegador ni en la red), sin indexación, sin Referer, sin marcos y CSP cerrada (un único script en línea con nonce, sin conexiones salientes).
//  * Los envíos exigen origen propio (`Origin` / `Sec-Fetch-Site`) y vuelven con redirección 303 (un reenvío del formulario no repite la acción).
//  * El token no se registra: los errores se guardan con la ruta normalizada y no se imprime nunca la dirección completa.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { exigirNoBloqueado, registrarFallo } from '../lib/limites';
import { ApiError } from '../lib/http';
import { consultarSeguimiento, enlaceActivo, logoDelEnlace, type SeguimientoPublico } from '../lib/seguimiento';
import { AVISOS, codigoPortal, paginaDemasiadosIntentos, paginaNoDisponible, paginaSeguimiento } from '../lib/seguimiento-html';
import { elegirMedio, recibirComprobante, type AccionMedio, type CodigoPortal } from '../lib/pago-cliente';
import { tokenConFormato } from '../../shared/seguimiento';
import { LIMITES_COMPROBANTE } from '../../shared/pago-portal';

/** Cabeceras comunes de las respuestas públicas. `private, no-store`: ningún proxy ni navegador guarda el estado de una orden. */
const CABECERAS: Record<string, string> = {
  'cache-control': 'private, no-store, max-age=0',
  pragma: 'no-cache',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()',
  'cross-origin-resource-policy': 'same-origin',
};
/** Página: sin recursos externos; el único script es el de la propia página (nonce por respuesta); las imágenes son el logotipo propio y la vista previa local del archivo elegido. */
const cspHtml = (nonce: string | null) =>
  `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' blob:; ${nonce ? `script-src 'nonce-${nonce}'; ` : ''}connect-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;

const VENTANA_MIN = 10;
const MAX_FALLOS = 20;
const BLOQUEO_MIN = 15;
// Elecciones del medio de pago: 60 cada 10 minutos por origen. Comprobantes: 12 por hora por origen y 30 por hora por orden (cuentan todos los intentos, no sólo los fallidos).
const MAX_MEDIOS = 60;
const MAX_ENVIOS_IP = 12;
const MAX_ENVIOS_ORDEN = 30;

const ip = (c: Context<AppEnv>) => c.req.header('cf-connecting-ip') ?? 'local';

type Resultado = { tipo: 'ok'; datos: SeguimientoPublico } | { tipo: 'no_disponible' } | { tipo: 'bloqueado' };

async function resolver(c: Context<AppEnv>, token: string): Promise<Resultado> {
  const clave = `seguimiento:${ip(c)}`;
  try {
    await exigirNoBloqueado(c.env.DB, clave);
  } catch (e) {
    if (e instanceof ApiError && e.status === 429) return { tipo: 'bloqueado' };
    throw e;
  }
  const datos = tokenConFormato(token) ? await consultarSeguimiento(c.env.DB, token) : null;
  if (!datos) {
    // Cada intento fallido suma; quien prueba enlaces al azar se bloquea sin afectar a quien abre su enlace.
    await registrarFallo(c.env.DB, clave, MAX_FALLOS, VENTANA_MIN, BLOQUEO_MIN);
    return { tipo: 'no_disponible' };
  }
  return { tipo: 'ok', datos };
}

function html(cuerpo: string, status: number, nonce: string | null = null): Response {
  return new Response(cuerpo, { status, headers: { ...CABECERAS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': cspHtml(nonce) } });
}

const nonceNuevo = () => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};

/** GET /seguimiento/:token */
export async function paginaPublica(c: Context<AppEnv>): Promise<Response> {
  const token = c.req.param('token') ?? '';
  const r = await resolver(c, token);
  if (r.tipo === 'ok') {
    const nonce = nonceNuevo();
    return html(paginaSeguimiento(r.datos, { token, nonce, aviso: codigoPortal(c.req.query('m')), claveEnvio: crypto.randomUUID() }), 200, nonce);
  }
  if (r.tipo === 'bloqueado') return html(paginaDemasiadosIntentos(), 429);
  return html(paginaNoDisponible(), 404);
}

/** Cualquier otra ruta bajo /seguimiento/: la misma página de «no disponible» (no se cae a la aplicación). */
export const paginaNoEncontrada = () => html(paginaNoDisponible(), 404);

/** GET /seguimiento/:token/logo — el logotipo del taller (sólo con un enlace activo). */
export async function logoPublico(c: Context<AppEnv>): Promise<Response> {
  const token = c.req.param('token') ?? '';
  const logo = tokenConFormato(token) ? await logoDelEnlace(c.env.DB, token) : null;
  if (!logo) return html(paginaNoDisponible(), 404);
  return new Response(logo.bytes, { headers: { ...CABECERAS, 'cache-control': 'private, max-age=300', 'content-type': logo.mime, 'content-disposition': 'inline', 'content-security-policy': "default-src 'none'; sandbox" } });
}

// ───────────────────────── Acciones de pago (formularios) ─────────────────────────

/**
 * Un formulario de otro sitio no puede enviar esto en nombre de un visitante. El navegador marca el origen de cada solicitud:
 *  · `Sec-Fetch-Site` (todos los navegadores actuales): sólo se acepta `same-origin` (o `none`, una acción del propio usuario).
 *  · Sin esa cabecera (navegadores viejos) se compara `Origin` con el sitio. OJO: esta página usa `Referrer-Policy: no-referrer` y, por especificación, el navegador manda
 *    entonces `Origin: null` incluso en un envío al mismo sitio: `null` sólo se acepta si `Sec-Fetch-Site` confirma el mismo origen, o si falta (no se puede comprobar; el token del
 *    enlace sigue siendo la credencial y estas acciones no mueven dinero).
 *  · Sin `Origin` (clientes que no son navegadores) no hay sesión que abusar: se acepta.
 */
function origenPropio(c: Context<AppEnv>): boolean {
  const sitio = c.req.header('sec-fetch-site');
  if (sitio) return sitio === 'same-origin' || sitio === 'none';
  const origen = c.req.header('origin');
  if (!origen || origen === 'null') return true;
  try {
    // En desarrollo local la URL que ve el Worker puede traer otro nombre de equipo (`localhost` en vez de `127.0.0.1`): se acepta la coincidencia con `Host` o con la URL.
    const host = new URL(origen).host;
    return host === c.req.header('host') || host === new URL(c.req.url).host;
  } catch {
    return false;
  }
}

/** Cuenta el intento y dice si el origen todavía puede seguir (los intentos de un origen bloqueado no llegan a la base de órdenes). */
async function permitido(c: Context<AppEnv>, clave: string, max: number, ventanaMin: number, bloqueoMin: number): Promise<boolean> {
  try {
    await exigirNoBloqueado(c.env.DB, clave);
  } catch (e) {
    if (e instanceof ApiError && e.status === 429) return false;
    throw e;
  }
  await registrarFallo(c.env.DB, clave, max, ventanaMin, bloqueoMin);
  return true;
}

/** Vuelve a la página con un aviso (PRG: recargar no repite la acción). El código es un valor fijo de una lista, nunca texto del visitante. */
function volver(token: string, codigo: CodigoPortal): Response {
  return new Response(null, { status: 303, headers: { ...CABECERAS, location: `/seguimiento/${token}?m=${codigo}#pago` } });
}

/** Resuelve el enlace de una acción de pago o devuelve la respuesta de error. Un enlace inválido suma al contador de fallos como en la consulta. */
async function enlaceDeAccion(c: Context<AppEnv>, token: string) {
  const e = tokenConFormato(token) ? await enlaceActivo(c.env.DB, token) : null;
  if (!e) {
    await registrarFallo(c.env.DB, `seguimiento:${ip(c)}`, MAX_FALLOS, VENTANA_MIN, BLOQUEO_MIN);
    return { error: html(paginaNoDisponible(), 404) };
  }
  return { enlace: e };
}

/** POST /seguimiento/:token/medio */
export async function accionMedio(c: Context<AppEnv>): Promise<Response> {
  const token = c.req.param('token') ?? '';
  if (!origenPropio(c)) return tokenConFormato(token) ? volver(token, 'e_origen') : html(paginaNoDisponible(), 404);
  try {
    await exigirNoBloqueado(c.env.DB, `seguimiento:${ip(c)}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 429) return html(paginaDemasiadosIntentos(), 429);
    throw e;
  }
  const r = await enlaceDeAccion(c, token);
  if (r.error) return r.error;
  if (!(await permitido(c, `pago-medio:${ip(c)}`, MAX_MEDIOS, VENTANA_MIN, BLOQUEO_MIN))) return volver(token, 'e_demasiados');
  let accion: unknown;
  try {
    accion = (await c.req.parseBody()).accion;
  } catch {
    return volver(token, 'e_dato');
  }
  if (accion !== 'efectivo' && accion !== 'transferencia' && accion !== 'confirmar_efectivo') return volver(token, 'e_dato');
  return volver(token, await elegirMedio(c.env.DB, r.enlace, accion as AccionMedio));
}

/** POST /seguimiento/:token/comprobante */
export async function accionComprobante(c: Context<AppEnv>): Promise<Response> {
  const token = c.req.param('token') ?? '';
  if (!origenPropio(c)) return tokenConFormato(token) ? volver(token, 'e_origen') : html(paginaNoDisponible(), 404);
  try {
    await exigirNoBloqueado(c.env.DB, `seguimiento:${ip(c)}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 429) return html(paginaDemasiadosIntentos(), 429);
    throw e;
  }
  const r = await enlaceDeAccion(c, token);
  if (r.error) return r.error;
  if (!(await permitido(c, `comprobante:${ip(c)}`, MAX_ENVIOS_IP, 60, 60)) || !(await permitido(c, `comprobante-orden:${r.enlace.ordenId}`, MAX_ENVIOS_ORDEN, 60, 60))) return volver(token, 'e_demasiados');
  // Se descarta lo gigante ANTES de leer el cuerpo (la cabecera la pone el navegador; si falta o miente, se vuelve a comprobar el tamaño real del archivo).
  const largo = Number(c.req.header('content-length') ?? NaN);
  if (!Number.isFinite(largo)) return volver(token, 'e_dato');
  if (largo > LIMITES_COMPROBANTE.imagenBytes + 200_000) return volver(token, 'e_tamano');
  const ct = c.req.header('content-type') ?? '';
  if (!ct.startsWith('multipart/form-data')) return volver(token, 'e_dato');
  let form: Record<string, unknown>;
  try {
    form = await c.req.parseBody();
  } catch {
    return volver(token, 'e_archivo');
  }
  const archivo = form.archivo;
  const clave = form.k;
  if (!(archivo instanceof File) || typeof clave !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(clave)) return volver(token, 'e_dato');
  if (archivo.size === 0) return volver(token, 'e_archivo');
  if (archivo.size > LIMITES_COMPROBANTE.imagenBytes) return volver(token, 'e_tamano');
  const bytes = new Uint8Array(await archivo.arrayBuffer());
  return volver(token, await recibirComprobante(c.env, r.enlace, { bytes, nombre: archivo.name }, clave));
}

/** Los avisos conocidos (para pruebas y documentación). */
export const CODIGOS_PORTAL = Object.keys(AVISOS) as CodigoPortal[];

export const seguimientoPublico = new Hono<AppEnv>();

seguimientoPublico.get('/:token', async (c) => {
  const r = await resolver(c, c.req.param('token'));
  const cab = { ...CABECERAS };
  if (r.tipo === 'ok') return c.json(r.datos, 200, cab);
  if (r.tipo === 'bloqueado') return c.json({ error: { code: 'bloqueado', message: 'Demasiados intentos. Probá de nuevo más tarde' } }, 429, cab);
  return c.json({ error: { code: 'no_encontrado', message: 'Enlace no disponible' } }, 404, cab);
});
