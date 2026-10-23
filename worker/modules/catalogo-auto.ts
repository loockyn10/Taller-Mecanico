// Catálogo automotor compartido (DNRPA, CC BY 4.0). Datos públicos y globales: no llevan taller_id. Se lee de D1, sin APIs externas.
// Sólo lectura para los talleres; la carga es un proceso aparte (`npm run catalogo -- cargar`).
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { notFound } from '../lib/http';
import { all, first } from '../lib/db';

export const catalogoAuto = new Hono<AppEnv>();

// El catálogo cambia sólo cuando se recarga: el navegador puede reutilizar la respuesta un rato.
catalogoAuto.use('*', async (c, next) => {
  await next();
  if (c.req.method === 'GET' && c.res.status === 200) c.header('Cache-Control', 'private, max-age=3600');
});

const anios = (t: string) => (t ? t.split(',').map(Number) : []);

catalogoAuto.get('/catalogo-auto/marcas', async (c) => {
  const filas = await all<{ id: string; nombre: string; clave: string; busqueda: string | null; n: number }>(c.env.DB, 'SELECT id, nombre, clave, busqueda, n FROM cat_marcas ORDER BY n DESC');
  return c.json(filas);
});

catalogoAuto.get('/catalogo-auto/marcas/:id/modelos', async (c) => {
  const filas = await all<{ id: string; nombre: string; clave: string; tipo: string | null; anios: string; n: number }>(
    c.env.DB,
    'SELECT id, nombre, clave, tipo, anios, n FROM cat_modelos WHERE marca_id = ? ORDER BY n DESC',
    c.req.param('id'),
  );
  return c.json(filas.map((f) => ({ ...f, anios: anios(f.anios) })));
});

catalogoAuto.get('/catalogo-auto/modelos/:id', async (c) => {
  const id = c.req.param('id');
  const m = await first<{ id: string; marca_id: string; nombre: string; tipo: string | null; anios: string }>(c.env.DB, 'SELECT id, marca_id, nombre, tipo, anios FROM cat_modelos WHERE id = ?', id);
  if (!m) throw notFound('Modelo del catálogo');
  const versiones = await all<{ id: string; descripcion: string; version: string | null; motorizacion: string | null; combustible: string | null; anios: string; n: number }>(
    c.env.DB,
    'SELECT id, descripcion, version, motorizacion, combustible, anios, n FROM cat_versiones WHERE modelo_id = ? ORDER BY n DESC',
    id,
  );
  const fichas = await first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM cat_fichas WHERE modelo_id = ?', id);
  return c.json({ ...m, anios: anios(m.anios), fichas: fichas?.n ?? 0, versiones: versiones.map((v) => ({ ...v, anios: anios(v.anios) })) });
});

catalogoAuto.get('/catalogo-auto/info', async (c) => {
  const filas = await all<{ clave: string; valor: string }>(c.env.DB, 'SELECT clave, valor FROM cat_meta');
  return c.json(Object.fromEntries(filas.map((f) => [f.clave, f.valor])));
});
