import { Hono } from 'hono';
import type { AppEnv, Env } from './env';
import { ApiError, body, traducirErrorDb } from './lib/http';
import { requireAuth, requireJson } from './lib/auth';
import { auth } from './modules/auth';
import { platform } from './modules/platform';
import { taller } from './modules/taller';
import { maestros } from './modules/maestros';
import { catalogoAuto } from './modules/catalogo-auto';
import { fotos } from './modules/fotos';
import { checklists } from './modules/checklists';
import { respaldoFotos } from './modules/respaldo-fotos';
import { seguimiento } from './modules/seguimiento';
import { paginaNoEncontrada, paginaPublica, seguimientoPublico } from './modules/seguimiento-publico';
import { limpiarFotos } from './lib/fotos';
import { catalogo } from './modules/catalogo';
import { presupuestos } from './modules/presupuestos';
import { ordenes } from './modules/ordenes';
import { comercial } from './modules/comercial';
import { compras } from './modules/compras';
import { agenda } from './modules/agenda';
import { reportes } from './modules/reportes';
import { informes } from './modules/informes';
import { caja } from './modules/caja';
import { gastos, finanzas } from './modules/gastos';
import { precios } from './modules/precios';
import { inventario } from './modules/inventario';
import { rapidas } from './modules/rapidas';
import { bancos } from './modules/bancos';
import { cheques } from './modules/cheques';
import { tesoreria } from './modules/tesoreria';
import { abastecimiento } from './modules/abastecimiento';
import { personal } from './modules/personal';
import { asistencia } from './modules/asistencia';
import { relojAdmin, relojPublico } from './modules/reloj';
import { tempario } from './modules/tempario';
import { historial } from './modules/historial';
import { mantenimientos } from './modules/mantenimientos';
import { productividad } from './modules/productividad';
import { depositos } from './modules/depositos';
import { anticipos } from './modules/anticipos';
import { devoluciones } from './modules/devoluciones';
import { costos } from './modules/costos';
import { contabilidad } from './modules/contabilidad';
import { activacion } from './modules/activacion';
import { puesta } from './modules/puesta';
import { importaciones } from './modules/importaciones';
import { aperturas } from './modules/aperturas';
import { movpersonas } from './modules/movpersonas';
import { mantenimientoContable, sincronizarTrasOperacion } from './lib/contab/sync';
import { ejecutarMantenimiento, latido, limpiarMensaje, medirD1, normalizarRuta, registrarErrorWorker, type Medicion } from './lib/observabilidad';
import { exigirNoBloqueado, limpiarFallos, registrarFallo } from './lib/limites';
import { igualSeguro } from './lib/crypto';
import { z } from 'zod';

const app = new Hono<AppEnv>();

app.use('/api/*', async (c, next) => {
  await next();
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
});
app.use('/api/*', requireJson);

// Medición de D1 por solicitud (sólo con MEDIR_D1=1, en una base aislada de pruebas de capacidad): consultas, sentencias, filas y tiempo en D1.
app.use('/api/*', async (c, next) => {
  if (c.env.MEDIR_D1 !== '1') return next();
  const m: Medicion = { consultas: 0, sentencias: 0, filasLeidas: 0, filasEscritas: 0, msD1: 0, top: [] };
  c.env = { ...c.env, DB: medirD1(c.env.DB, m) };
  const t0 = performance.now();
  await next();
  c.header('X-D1-Consultas', String(m.consultas));
  c.header('X-D1-Sentencias', String(m.sentencias));
  c.header('X-D1-Filas-Leidas', String(m.filasLeidas));
  c.header('X-D1-Filas-Escritas', String(m.filasEscritas));
  c.header('X-D1-Ms', m.msD1.toFixed(1));
  if (m.top.length) c.header('X-D1-Top', encodeURIComponent(m.top.map((t) => `${t.filas}:${t.sql}`).join(' || ')));
  c.header('X-Worker-Ms', (performance.now() - t0).toFixed(1));
});

app.get('/api/salud', (c) => c.json({ ok: true, version: '0.1.0' }));
app.route('/api/auth', auth);
app.route('/api/platform', platform);
// Canje de una invitación de activación: público (se autentica con el enlace de un solo uso).
app.route('/api/activacion', activacion);
// Aviso del respaldo externo (lo envía el procedimiento programado de GitHub Actions al terminar). Token propio, con un único permiso.
const zLatidoRespaldo = z.object({
  ok: z.boolean(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  bytes: z.number().int().nonnegative().optional(),
  tablas: z.number().int().nonnegative().optional(),
  filas: z.number().int().nonnegative().optional(),
  talleres: z.number().int().nonnegative().optional(),
  etiqueta: z.string().max(80).optional(),
  error: z.string().max(200).optional(),
});
app.post('/api/plataforma/respaldo-latido', async (c) => {
  const clave = `respaldo-latido:${c.req.header('cf-connecting-ip') ?? 'local'}`;
  await exigirNoBloqueado(c.env.DB, clave);
  const esperado = c.env.BACKUP_REPORT_TOKEN;
  const recibido = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!esperado || esperado.length < 16 || !igualSeguro(recibido, esperado)) {
    await registrarFallo(c.env.DB, clave, 10, 15, 30);
    throw new ApiError(401, 'no_autorizado', 'Token inválido');
  }
  await limpiarFallos(c.env.DB, clave);
  const d = await body(c, zLatidoRespaldo);
  await latido(c.env.DB, 'respaldo_externo', d.ok, { ...d, error: d.error ? limpiarMensaje(d.error) : undefined });
  return c.json({ ok: true });
});

// Lectura de las fotografías para el respaldo programado: token propio de sólo lectura (no el de plataforma).
app.route('/api/plataforma/fotos-respaldo', respaldoFotos);

// Seguimiento público de órdenes: sin sesión, se entra con el enlace individual (token). Ver worker/modules/seguimiento-publico.ts y docs/SEGUIMIENTO.md.
app.route('/api/seguimiento', seguimientoPublico);
app.get('/seguimiento/:token', paginaPublica);
app.all('/seguimiento/*', () => paginaNoEncontrada());

// Pantalla del reloj compartido: se autentica con el token del dispositivo, no con una sesión de usuario.
app.route('/api/reloj', relojPublico);

// Todo lo siguiente requiere sesión: el taller se toma SIEMPRE de la sesión.
const api = new Hono<AppEnv>();
api.use('*', requireAuth);

// Contabilidad al día: después de una operación que mueve plata, stock o deudas (y salió bien) se contabiliza lo nuevo. Sólo en talleres que ya activaron la
// contabilidad (la activación y la generación histórica son explícitas); nunca altera la respuesta de la operación y los GET no escriben nada.
const OPERACIONES_CONTABLES = /^\/api\/(ventas|cobros|anticipos|credito-aplicaciones|devoluciones|reintegros|compras|pagos-proveedor|facturas-proveedor|recepciones|ordenes-compra|gastos|gastos-recurrentes|caja|bancos|cheques|stock|inventario|articulos|ordenes|depositos|transferencias|aperturas|importaciones|movimientos-personas)(\/|$)/;
api.use('*', async (c, next) => {
  await next();
  if (c.req.method === 'GET' || c.res.status >= 400 || !OPERACIONES_CONTABLES.test(c.req.path)) return;
  const s = c.get('sesion');
  if (!s?.licenciaActiva) return;
  const tarea = sincronizarTrasOperacion(c.env.DB, s.tallerId, s.usuarioId);
  if (c.env.CONTAB_SYNC === 'esperar') await tarea;
  else c.executionCtx.waitUntil(tarea);
});
api.route('/taller', taller);
api.route('/taller', personal);
api.route('/asistencia', asistencia);
api.route('/asistencia', relojAdmin);
api.route('/', maestros);
api.route('/', catalogoAuto);
api.route('/', fotos);
api.route('/', checklists);
api.route('/', historial);
api.route('/', mantenimientos);
api.route('/tempario', tempario);
api.route('/productividad', productividad);
api.route('/', depositos);
api.route('/', catalogo);
api.route('/presupuestos', presupuestos);
api.route('/ordenes', ordenes);
api.route('/ordenes', seguimiento);
api.route('/', comercial);
api.route('/', anticipos);
api.route('/', devoluciones);
api.route('/', costos);
api.route('/', compras);
api.route('/turnos', agenda);
api.route('/', reportes);
api.route('/caja', caja);
api.route('/', gastos);
api.route('/finanzas', finanzas);
api.route('/', precios);
api.route('/bancos', bancos);
api.route('/', cheques);
api.route('/tesoreria', tesoreria);
api.route('/', abastecimiento);
api.route('/', inventario);
api.route('/', rapidas);
api.route('/', informes);
api.route('/contabilidad', contabilidad);
api.route('/puesta-en-marcha', puesta);
api.route('/importaciones', importaciones);
api.route('/aperturas', aperturas);
api.route('/movimientos-personas', movpersonas);
app.route('/api', api);

app.all('/api/*', (c) => c.json({ error: { code: 'no_encontrado', message: 'Ruta inexistente' } }, 404));

app.onError((err, c) => {
  const e = err instanceof ApiError ? err : traducirErrorDb(err);
  if (e) return c.json({ error: { code: e.code, message: e.message, details: e.details } }, e.status as 400);
  // Se registra sin datos del usuario: método, ruta normalizada y mensaje depurado (ver lib/observabilidad.ts). Los logs del Worker no llevan el cuerpo ni las cabeceras.
  const ruta = new URL(c.req.url).pathname;
  console.error('Error no controlado', c.req.method, normalizarRuta(ruta), err instanceof Error ? err.name : typeof err, limpiarMensaje(err instanceof Error ? err.message : String(err)));
  const tarea = registrarErrorWorker(c.env.DB, c.req.method, ruta, err, c.get('sesion')?.tallerId ?? null);
  try {
    c.executionCtx.waitUntil(tarea);
  } catch {
    /* sin ExecutionContext (pruebas): se deja correr */
  }
  return c.json({ error: { code: 'error_interno', message: 'Ocurrió un error inesperado' } }, 500);
});

// Fuera de /api, servir la SPA (en desarrollo la sirve Vite).
app.all('*', async (c) => (c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('ORVELAN Taller Mecánico API', 200)));

export default {
  fetch: app.fetch,
  // Cron Trigger (wrangler.jsonc › triggers.crons): drena las colas de contabilización pendientes, avanza reconciliaciones y deja un latido.
  async scheduled(_evento: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(ejecutarMantenimiento(env, mantenimientoContable));
    ctx.waitUntil(limpiarFotos(env.DB, env.FIERRO_FOTOS).catch(() => undefined));
  },
} satisfies ExportedHandler<Env>;
