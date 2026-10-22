import { Hono } from 'hono';
import type { AppEnv } from './env';
import { ApiError, traducirErrorDb } from './lib/http';
import { requireAuth, requireJson } from './lib/auth';
import { auth } from './modules/auth';
import { platform } from './modules/platform';
import { taller } from './modules/taller';
import { maestros } from './modules/maestros';
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

const app = new Hono<AppEnv>();

app.use('/api/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
});
app.use('/api/*', requireJson);

app.get('/api/salud', (c) => c.json({ ok: true, version: '0.1.0' }));
app.route('/api/auth', auth);
app.route('/api/platform', platform);
// Pantalla del reloj compartido: se autentica con el token del dispositivo, no con una sesión de usuario.
app.route('/api/reloj', relojPublico);

// Todo lo siguiente requiere sesión: el taller se toma SIEMPRE de la sesión.
const api = new Hono<AppEnv>();
api.use('*', requireAuth);
api.route('/taller', taller);
api.route('/taller', personal);
api.route('/asistencia', asistencia);
api.route('/asistencia', relojAdmin);
api.route('/', maestros);
api.route('/', historial);
api.route('/', mantenimientos);
api.route('/tempario', tempario);
api.route('/productividad', productividad);
api.route('/', depositos);
api.route('/', catalogo);
api.route('/presupuestos', presupuestos);
api.route('/ordenes', ordenes);
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
api.route('/', informes);
api.route('/contabilidad', contabilidad);
app.route('/api', api);

app.all('/api/*', (c) => c.json({ error: { code: 'no_encontrado', message: 'Ruta inexistente' } }, 404));

app.onError((err, c) => {
  const e = err instanceof ApiError ? err : traducirErrorDb(err);
  if (e) return c.json({ error: { code: e.code, message: e.message, details: e.details } }, e.status as 400);
  console.error('Error no controlado', err);
  return c.json({ error: { code: 'error_interno', message: 'Ocurrió un error inesperado' } }, 500);
});

// Fuera de /api, servir la SPA (en desarrollo la sirve Vite).
app.all('*', async (c) => (c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('Fierro API', 200)));

export default app;
