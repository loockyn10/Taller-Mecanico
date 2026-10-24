// Catálogo automotor compartido (DNRPA, CC BY 4.0). Datos públicos y globales: no llevan taller_id. Se lee de D1, sin APIs externas.
// Sólo lectura para los talleres; la carga es un proceso aparte (`npm run catalogo -- cargar`).
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { z } from 'zod';
import { notFound, query } from '../lib/http';
import { all, first } from '../lib/db';
import { requireAny } from '../lib/auth';
import { claveBusqueda } from '../../shared/catalogo-auto';

export const catalogoAuto = new Hono<AppEnv>();

// El catálogo cambia sólo cuando se recarga: el navegador puede reutilizar la respuesta un rato. SOLO sus rutas: este módulo se monta en '/', así que un
// use('*') sin filtrar alcanzaría a toda la API (y los datos de los talleres quedarían en la caché del navegador).
catalogoAuto.use('*', async (c, next) => {
  await next();
  if (c.req.method === 'GET' && c.res.status === 200 && c.req.path.startsWith('/api/catalogo-auto/')) c.header('Cache-Control', 'private, max-age=3600');
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

// ───────────── Explorador (Sprint 17) ─────────────
// Información técnica general, sin precios ni datos del taller: la consulta la pueden hacer quienes ven vehículos, el catálogo o sus órdenes asignadas.
const consulta = requireAny('vehiculos.ver', 'catalogo.ver', 'ordenes.asignadas');

/** Cada palabra buscada debe aparecer en la marca (o su apodo), en el modelo o en alguna versión del modelo. Sin tildes ni mayúsculas ni signos. */
function condiciones(q: string, marcaId: string | undefined, anio: number | undefined, params: unknown[]) {
  const cond: string[] = [];
  for (const t of q.split(/\s+/).map(claveBusqueda).filter(Boolean).slice(0, 6)) {
    cond.push(`(ma.clave LIKE ? OR COALESCE(ma.busqueda, '') LIKE ? OR m.clave LIKE ? OR EXISTS (SELECT 1 FROM cat_versiones v WHERE v.modelo_id = m.id AND v.descripcion LIKE ?))`);
    params.push(`%${t}%`, `%${t}%`, `%${t}%`, `%${t}%`);
  }
  if (marcaId) (cond.push('m.marca_id = ?'), params.push(marcaId));
  if (anio) (cond.push(`(',' || m.anios || ',') LIKE ?`), params.push(`%,${anio},%`));
  return cond.length ? `WHERE ${cond.join(' AND ')}` : '';
}

const zBuscar = z.object({
  q: z.string().trim().max(80).default(''),
  marca: z.string().max(64).optional(),
  anio: z.coerce.number().int().min(1900).max(2100).optional(),
  limite: z.coerce.number().int().min(1).max(60).default(24),
  desde: z.coerce.number().int().min(0).max(5000).default(0),
});

/** Modelos que cumplen todos los filtros (paginados) y, para que los filtros se relacionen entre sí, qué marcas, modelos y años quedan disponibles. */
catalogoAuto.get('/catalogo-auto/buscar', consulta, async (c) => {
  const { q, marca, anio, limite, desde } = query(c, zBuscar);
  const FROM = 'FROM cat_modelos m JOIN cat_marcas ma ON ma.id = m.marca_id';
  const pp: unknown[] = [];
  const dondePagina = condiciones(q, marca, anio, pp);
  const primera = claveBusqueda(q.split(/\s+/)[0] ?? '');
  const filas = await all<{ id: string; nombre: string; marca_id: string; marca: string; tipo: string | null; anios: string; n: number; versiones: number }>(
    c.env.DB,
    `SELECT m.id, m.nombre, m.marca_id, ma.nombre AS marca, m.tipo, m.anios, m.n, (SELECT COUNT(*) FROM cat_versiones v WHERE v.modelo_id = m.id) AS versiones
     ${FROM} ${dondePagina} ORDER BY (m.clave LIKE ?) DESC, m.n DESC, m.nombre LIMIT ? OFFSET ?`,
    ...pp, `${primera}%`, limite, desde,
  );
  const total = (await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n ${FROM} ${dondePagina}`, ...pp))?.n ?? 0;

  // Facetas: cada filtro se calcula con todos los demás aplicados (menos él mismo), para ofrecer sólo opciones que dan resultados.
  const pm: unknown[] = [];
  const marcas = await all<{ id: string; nombre: string; n: number }>(c.env.DB, `SELECT ma.id, ma.nombre, COUNT(*) AS n ${FROM} ${condiciones(q, undefined, anio, pm)} GROUP BY ma.id ORDER BY ma.nombre`, ...pm);
  const pd: unknown[] = [];
  const modelos = await all<{ id: string; nombre: string; marca_id: string; marca: string }>(
    c.env.DB,
    `SELECT m.id, m.nombre, m.marca_id, ma.nombre AS marca ${FROM} ${condiciones(q, marca, anio, pd)} ORDER BY ma.nombre, m.nombre LIMIT 400`,
    ...pd,
  );
  const pa: unknown[] = [];
  const aniosFila = await all<{ anios: string }>(c.env.DB, `SELECT m.anios ${FROM} ${condiciones(q, marca, undefined, pa)}`, ...pa);
  const aniosSet = new Set<number>();
  for (const f of aniosFila) for (const a of anios(f.anios)) aniosSet.add(a);
  return c.json({
    total,
    desde,
    modelos: filas.map((f) => ({ ...f, anios: anios(f.anios) })),
    facetas: { marcas, modelos, anios: [...aniosSet].sort((a, b) => b - a) },
  });
});

/** JSON de la ficha: si no se puede leer se descarta (no se muestra a medias). */
const jsonObjeto = (t: string | null): Record<string, unknown> | null => {
  if (!t) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

/** Fichas técnicas verificadas del modelo. Hoy la tabla está vacía a propósito: nada se completa sin fuente y fecha. Sólo se devuelven enlaces https. */
catalogoAuto.get('/catalogo-auto/modelos/:id/fichas', consulta, async (c) => {
  const id = c.req.param('id');
  if (!(await first(c.env.DB, 'SELECT 1 FROM cat_modelos WHERE id = ?', id))) throw notFound('Modelo del catálogo');
  const filas = await all<Record<string, any>>(
    c.env.DB,
    `SELECT id, version_id, motorizacion, anio_desde, anio_hasta, codigo_motor, aceite_recomendado, aceite_capacidad_l, refrigerante, filtros, distribucion, intervalos, documentacion_url, fuente, fecha_verificacion, notas
     FROM cat_fichas WHERE modelo_id = ? ORDER BY fecha_verificacion DESC`,
    id,
  );
  return c.json(filas.map((f) => ({ ...f, filtros: jsonObjeto(f.filtros), intervalos: jsonObjeto(f.intervalos), documentacion_url: typeof f.documentacion_url === 'string' && /^https:\/\//i.test(f.documentacion_url) ? f.documentacion_url : null })));
});

catalogoAuto.get('/catalogo-auto/info', async (c) => {
  const filas = await all<{ clave: string; valor: string }>(c.env.DB, 'SELECT clave, valor FROM cat_meta');
  return c.json(Object.fromEntries(filas.map((f) => [f.clave, f.valor])));
});
