// Seguimiento público de órdenes: endpoints SIN sesión (el cliente entra con el enlace).
//   GET /seguimiento/:token       página HTML (lo que abre el cliente desde su celular o desde el QR)
//   GET /api/seguimiento/:token   los mismos datos en JSON
//
// Seguridad (ver docs/SEGUIMIENTO.md):
//  * La única credencial es el token (256 bits). Se verifica el formato antes de tocar la base y la búsqueda es por igualdad exacta sobre un índice único.
//  * Enlace inexistente, desactivado o reemplazado: la misma respuesta 404 (no se puede distinguir cuál es el caso).
//  * Límite de intentos fallidos por origen (ventana de 10 minutos, bloqueo de 15) con el mecanismo de límites ya existente. Los accesos válidos no escriben nada en la base.
//  * Cabeceras: sin caché (ni en el navegador ni en la red), sin indexación, sin Referer, sin marcos y CSP cerrada (la página no ejecuta ni carga nada).
//  * El token no se registra: los errores se guardan con la ruta normalizada y no se imprime nunca la dirección completa.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { exigirNoBloqueado, registrarFallo } from '../lib/limites';
import { ApiError } from '../lib/http';
import { consultarSeguimiento, type SeguimientoPublico } from '../lib/seguimiento';
import { paginaDemasiadosIntentos, paginaNoDisponible, paginaSeguimiento } from '../lib/seguimiento-html';
import { tokenConFormato } from '../../shared/seguimiento';

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
const CSP_HTML = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const VENTANA_MIN = 10;
const MAX_FALLOS = 20;
const BLOQUEO_MIN = 15;

type Resultado = { tipo: 'ok'; datos: SeguimientoPublico } | { tipo: 'no_disponible' } | { tipo: 'bloqueado' };

async function resolver(c: Context<AppEnv>, token: string): Promise<Resultado> {
  const clave = `seguimiento:${c.req.header('cf-connecting-ip') ?? 'local'}`;
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

function html(cuerpo: string, status: number): Response {
  return new Response(cuerpo, { status, headers: { ...CABECERAS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP_HTML } });
}

/** GET /seguimiento/:token */
export async function paginaPublica(c: Context<AppEnv>): Promise<Response> {
  const r = await resolver(c, c.req.param('token') ?? '');
  if (r.tipo === 'ok') return html(paginaSeguimiento(r.datos), 200);
  if (r.tipo === 'bloqueado') return html(paginaDemasiadosIntentos(), 429);
  return html(paginaNoDisponible(), 404);
}

/** Cualquier otra ruta bajo /seguimiento/: la misma página de «no disponible» (no se cae a la aplicación). */
export const paginaNoEncontrada = () => html(paginaNoDisponible(), 404);

export const seguimientoPublico = new Hono<AppEnv>();

seguimientoPublico.get('/:token', async (c) => {
  const r = await resolver(c, c.req.param('token'));
  const cab = { ...CABECERAS };
  if (r.tipo === 'ok') return c.json(r.datos, 200, cab);
  if (r.tipo === 'bloqueado') return c.json({ error: { code: 'bloqueado', message: 'Demasiados intentos. Probá de nuevo más tarde' } }, 429, cab);
  return c.json({ error: { code: 'no_encontrado', message: 'Enlace no disponible' } }, 404, cab);
});
