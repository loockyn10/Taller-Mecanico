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

// Todo lo siguiente requiere sesión: el taller se toma SIEMPRE de la sesión.
const api = new Hono<AppEnv>();
api.use('*', requireAuth);
api.route('/taller', taller);
api.route('/', maestros);
api.route('/', catalogo);
api.route('/presupuestos', presupuestos);
api.route('/ordenes', ordenes);
api.route('/', comercial);
api.route('/', compras);
api.route('/turnos', agenda);
api.route('/', reportes);
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
