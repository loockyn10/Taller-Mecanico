// Listas de precios y ajustes masivos de costos y precios.
//
// Un documento (presupuesto, OT, venta) guarda el precio de cada ítem al momento de armarlo: cambiar una lista o un costo
// después NO modifica operaciones ya realizadas. Las listas sólo sugieren precios para los documentos nuevos.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, conflict, notFound, query, zCentavos, zId, zTextoOpt } from '../lib/http';
import { all, auditar, first, like, lotes, uid } from '../lib/db';
import { requirePerm } from '../lib/auth';
import { precioArticuloEnLista, precioServicioEnLista, type ReglaLista } from '../../shared/precios';
import { REDONDEOS_PRECIO } from '../../shared/dominio';

export const precios = new Hono<AppEnv>();

interface Lista extends ReglaLista {
  id: string;
  nombre: string;
  descripcion: string | null;
  es_default: number;
  activa: number;
}

const LISTA_COLS = 'id, nombre, descripcion, base, porcentaje, redondeo, servicios_pct, es_default, activa, created_at, updated_at';

async function lista(db: D1Database, tallerId: string, id: string): Promise<Lista> {
  const l = await first<Lista>(db, `SELECT ${LISTA_COLS} FROM listas_precios WHERE taller_id = ? AND id = ?`, tallerId, id);
  if (!l) throw notFound('Lista de precios');
  return l;
}

const zLista = z.object({
  nombre: z.string().trim().min(2).max(80),
  descripcion: zTextoOpt(300),
  base: z.enum(['costo', 'precio']).default('costo'),
  porcentaje: z.number().min(-100).max(1000).default(0),
  redondeo: z.number().refine((v) => (REDONDEOS_PRECIO as readonly number[]).includes(v), 'redondeo inválido').default(0),
  servicios_pct: z.number().min(-100).max(1000).nullish(),
  es_default: z.boolean().optional(),
  activa: z.boolean().optional(),
});

// ───────────── Listas ─────────────
precios.get('/listas-precios', requirePerm('catalogo.ver'), async (c) => {
  const s = c.get('sesion');
  const { todas } = query(c, z.object({ todas: z.string().optional() }));
  return c.json(
    await all(
      c.env.DB,
      `SELECT ${LISTA_COLS.split(', ').map((x) => `lp.${x}`).join(', ')},
              (SELECT COUNT(*) FROM lista_precio_items li WHERE li.taller_id = lp.taller_id AND li.lista_id = lp.id) AS precios_fijos
         FROM listas_precios lp WHERE lp.taller_id = ? ${todas ? '' : 'AND lp.activa = 1'} ORDER BY lp.es_default DESC, lp.activa DESC, lp.nombre`,
      s.tallerId,
    ),
  );
});

precios.get('/listas-precios/:id', requirePerm('catalogo.ver'), async (c) => c.json(await lista(c.env.DB, c.get('sesion').tallerId, c.req.param('id'))));

precios.post('/listas-precios', requirePerm('precios.gestionar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zLista);
  const id = uid();
  const esDefault = d.es_default && d.activa !== false;
  await c.env.DB.batch([
    ...(esDefault ? [c.env.DB.prepare('UPDATE listas_precios SET es_default = 0 WHERE taller_id = ?').bind(s.tallerId)] : []),
    c.env.DB.prepare('INSERT INTO listas_precios (id, taller_id, nombre, descripcion, base, porcentaje, redondeo, servicios_pct, es_default, activa) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(id, s.tallerId, d.nombre, d.descripcion, d.base, d.porcentaje, d.redondeo, d.servicios_pct ?? null, esDefault ? 1 : 0, d.activa === false ? 0 : 1),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'lista_precios', id, 'crear', d),
  ]);
  return c.json(await lista(c.env.DB, s.tallerId, id), 201);
});

precios.put('/listas-precios/:id', requirePerm('precios.gestionar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, zLista.partial());
  const actual = await lista(c.env.DB, s.tallerId, id);
  const activa = d.activa ?? !!actual.activa;
  // Una lista desactivada no puede ser la predeterminada.
  const esDefault = activa && (d.es_default ?? !!actual.es_default);
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const k of ['nombre', 'descripcion', 'base', 'porcentaje', 'redondeo', 'servicios_pct'] as const) {
    if (d[k] !== undefined) (sets.push(`${k} = ?`), vals.push(d[k] ?? null));
  }
  sets.push('es_default = ?', 'activa = ?', "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  vals.push(esDefault ? 1 : 0, activa ? 1 : 0);
  await c.env.DB.batch([
    ...(esDefault && !actual.es_default ? [c.env.DB.prepare('UPDATE listas_precios SET es_default = 0 WHERE taller_id = ?').bind(s.tallerId)] : []),
    c.env.DB.prepare(`UPDATE listas_precios SET ${sets.join(', ')} WHERE taller_id = ? AND id = ?`).bind(...vals, s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'lista_precios', id, 'modificar', d),
  ]);
  return c.json(await lista(c.env.DB, s.tallerId, id));
});

// ───────────── Precios de artículos en una lista ─────────────
precios.get('/listas-precios/:id/articulos', requirePerm('precios.gestionar'), async (c) => {
  const s = c.get('sesion');
  const l = await lista(c.env.DB, s.tallerId, c.req.param('id'));
  const f = query(c, z.object({ q: z.string().optional(), categoria_id: z.string().optional(), solo_fijos: z.string().optional(), limite: z.coerce.number().int().min(1).max(500).default(100), pagina: z.coerce.number().int().min(0).default(0) }));
  const cond = ['a.taller_id = ?', 'a.activo = 1'];
  const params: unknown[] = [l.id, s.tallerId];
  if (f.q) (cond.push('(a.nombre LIKE ? OR a.codigo LIKE ? OR a.marca LIKE ?)'), params.push(like(f.q), like(f.q), like(f.q)));
  if (f.categoria_id) (cond.push('a.categoria_id = ?'), params.push(f.categoria_id));
  if (f.solo_fijos) cond.push('li.id IS NOT NULL');
  const filas = await all<{ costo: number; precio: number; precio_fijo: number | null }>(
    c.env.DB,
    `SELECT a.id, a.codigo, a.nombre, a.marca, a.costo, a.precio, li.precio AS precio_fijo, ca.nombre AS categoria
       FROM articulos a
       LEFT JOIN lista_precio_items li ON li.taller_id = a.taller_id AND li.articulo_id = a.id AND li.lista_id = ?
       LEFT JOIN categorias_articulo ca ON ca.taller_id = a.taller_id AND ca.id = a.categoria_id
      WHERE ${cond.join(' AND ')} ORDER BY a.nombre COLLATE NOCASE LIMIT ? OFFSET ?`,
    ...params,
    f.limite,
    f.pagina * f.limite,
  );
  return c.json(filas.map((a) => ({ ...a, ...tradPrecio(l, a) })));
});

function tradPrecio(l: ReglaLista, a: { costo: number; precio: number; precio_fijo?: number | null }) {
  const r = precioArticuloEnLista(l, a, a.precio_fijo ?? null);
  return { precio_lista: r.precio, precio_origen: r.origen };
}

precios.put('/listas-precios/:id/items/:articuloId', requirePerm('precios.gestionar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const articuloId = c.req.param('articuloId');
  const d = await body(c, z.object({ precio: zCentavos }));
  await lista(c.env.DB, s.tallerId, id);
  if (!(await first(c.env.DB, 'SELECT 1 FROM articulos WHERE taller_id = ? AND id = ?', s.tallerId, articuloId))) throw notFound('Artículo');
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO lista_precio_items (id, taller_id, lista_id, articulo_id, precio) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (taller_id, lista_id, articulo_id) DO UPDATE SET precio = excluded.precio, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    ).bind(uid(), s.tallerId, id, articuloId, d.precio),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'lista_precios', id, 'precio_fijo', { articulo_id: articuloId, precio: d.precio }),
  ]);
  return c.json({ ok: true });
});

precios.delete('/listas-precios/:id/items/:articuloId', requirePerm('precios.gestionar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  await lista(c.env.DB, s.tallerId, id);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM lista_precio_items WHERE taller_id = ? AND lista_id = ? AND articulo_id = ?').bind(s.tallerId, id, c.req.param('articuloId')),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'lista_precios', id, 'quitar_precio_fijo', { articulo_id: c.req.param('articuloId') }),
  ]);
  return c.json({ ok: true });
});

/** Ajusta en un porcentaje los precios FIJOS de la lista (los calculados siguen a la regla de la lista). */
precios.post('/listas-precios/:id/ajuste-masivo', requirePerm('precios.gestionar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, z.object({ porcentaje: z.number().min(-90).max(500), categoria_id: zId.nullish(), redondeo: z.number().refine((v) => (REDONDEOS_PRECIO as readonly number[]).includes(v)).default(100), simular: z.boolean().default(false) }));
  await lista(c.env.DB, s.tallerId, id);
  const filtro = d.categoria_id ? 'AND articulo_id IN (SELECT id FROM articulos WHERE taller_id = ? AND categoria_id = ?)' : '';
  const fp = d.categoria_id ? [s.tallerId, d.categoria_id] : [];
  const afectados = (await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM lista_precio_items WHERE taller_id = ? AND lista_id = ? ${filtro}`, s.tallerId, id, ...fp))?.n ?? 0;
  if (d.simular) return c.json({ afectados, simulado: true });
  const paso = d.redondeo;
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE lista_precio_items SET precio = ${expresionAjuste('precio', paso)}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ? AND lista_id = ? ${filtro}`,
    ).bind(...paramsAjuste(d.porcentaje, paso), s.tallerId, id, ...fp),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'lista_precios', id, 'ajuste_masivo', d),
  ]);
  return c.json({ afectados });
});

/** Convierte los precios calculados por la regla en precios fijos (para "congelar" la lista y editarlos uno a uno). */
precios.post('/listas-precios/:id/fijar', requirePerm('precios.gestionar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, z.object({ categoria_id: zId.nullish(), sobrescribir: z.boolean().default(false) }));
  const l = await lista(c.env.DB, s.tallerId, id);
  const base = l.base === 'costo' ? 'CASE WHEN a.costo > 0 THEN a.costo ELSE a.precio END' : 'a.precio';
  const r = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO lista_precio_items (id, taller_id, lista_id, articulo_id, precio)
       SELECT lower(hex(randomblob(16))), a.taller_id, ?, a.id, ${expresionAjuste(base, l.redondeo)}
         FROM articulos a WHERE a.taller_id = ? AND a.activo = 1 ${d.categoria_id ? 'AND a.categoria_id = ?' : ''}
       ON CONFLICT (taller_id, lista_id, articulo_id) DO ${d.sobrescribir ? "UPDATE SET precio = excluded.precio, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')" : 'NOTHING'}`,
    ).bind(id, ...paramsAjuste(l.porcentaje, l.redondeo), s.tallerId, ...(d.categoria_id ? [d.categoria_id] : [])),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'lista_precios', id, 'fijar_precios', d),
  ]);
  return c.json({ afectados: r[0].meta.changes });
});

/** `precio` se reemplaza por columna/expresión; el orden de parámetros es el que devuelve paramsAjuste(). */
function expresionAjuste(valor: string, paso: number): string {
  // Se arma con el paso literal (no es dato del usuario: sale de una lista cerrada) para que el plan no dependa de parámetros.
  const p = Number(paso);
  if (!(REDONDEOS_PRECIO as readonly number[]).includes(p)) throw new Error('redondeo inválido');
  return p > 0 ? `MAX(0, CAST(ROUND((${valor}) * ? / ${p}.0) AS INTEGER) * ${p})` : `MAX(0, CAST(ROUND((${valor}) * ?) AS INTEGER))`;
}
function paramsAjuste(porcentaje: number, _paso: number): number[] {
  return [1 + porcentaje / 100];
}

/** Precios resueltos de un conjunto de artículos/servicios en una lista (para recalcular los ítems de un documento al cambiar de lista). */
precios.post('/listas-precios/:id/precios', requirePerm('catalogo.ver'), async (c) => {
  const s = c.get('sesion');
  const l = await lista(c.env.DB, s.tallerId, c.req.param('id'));
  const d = await body(c, z.object({ articulos: z.array(zId).max(300).default([]), servicios: z.array(zId).max(300).default([]) }));
  const arts: Record<string, number> = {};
  for (const ids of lotes([...new Set(d.articulos)])) {
    const rows = await all<{ id: string; costo: number; precio: number; precio_fijo: number | null }>(
      c.env.DB,
      `SELECT a.id, a.costo, a.precio, li.precio AS precio_fijo FROM articulos a LEFT JOIN lista_precio_items li ON li.taller_id = a.taller_id AND li.articulo_id = a.id AND li.lista_id = ?
        WHERE a.taller_id = ? AND a.id IN (${ids.map(() => '?').join(',')})`,
      l.id,
      s.tallerId,
      ...ids,
    );
    for (const r of rows) arts[r.id] = tradPrecio(l, r).precio_lista;
  }
  const srvs: Record<string, number> = {};
  for (const ids of lotes([...new Set(d.servicios)])) {
    const rows = await all<{ id: string; precio: number }>(c.env.DB, `SELECT id, precio FROM servicios WHERE taller_id = ? AND id IN (${ids.map(() => '?').join(',')})`, s.tallerId, ...ids);
    for (const r of rows) srvs[r.id] = precioServicioEnLista(l, r.precio);
  }
  return c.json({ articulos: arts, servicios: srvs });
});

// ───────────── Ajuste masivo de costos y precios base ─────────────
precios.post('/articulos/ajuste-masivo', requirePerm('precios.gestionar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(
    c,
    z.object({
      aplicar_a: z.enum(['precio', 'costo']),
      modo: z.enum(['porcentaje', 'margen_sobre_costo']).default('porcentaje'),
      valor: z.number().min(-90).max(1000),
      categoria_id: zId.nullish(),
      proveedor_id: zId.nullish(),
      redondeo: z.number().refine((v) => (REDONDEOS_PRECIO as readonly number[]).includes(v)).default(100),
      simular: z.boolean().default(false),
    }),
  );
  if (d.modo === 'margen_sobre_costo' && d.aplicar_a !== 'precio') throw badRequest('El margen sobre costo sólo aplica al precio de venta');
  const cond = ['taller_id = ?', 'activo = 1'];
  const params: unknown[] = [s.tallerId];
  if (d.categoria_id) (cond.push('categoria_id = ?'), params.push(d.categoria_id));
  if (d.proveedor_id) (cond.push('proveedor_id = ?'), params.push(d.proveedor_id));
  if (d.modo === 'margen_sobre_costo') cond.push('costo > 0');
  const columnaOrigen = d.modo === 'margen_sobre_costo' ? 'costo' : d.aplicar_a;
  const where = cond.join(' AND ');
  const muestra = await all<{ id: string; nombre: string; costo: number; precio: number }>(c.env.DB, `SELECT id, nombre, costo, precio FROM articulos WHERE ${where} ORDER BY nombre COLLATE NOCASE LIMIT 8`, ...params);
  const total = (await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM articulos WHERE ${where}`, ...params))?.n ?? 0;
  const factor = 1 + d.valor / 100;
  const nuevo = (a: { costo: number; precio: number }) => {
    const origen = columnaOrigen === 'costo' ? a.costo : a.precio;
    const v = origen * factor;
    return Math.max(0, d.redondeo > 0 ? Math.round(v / d.redondeo) * d.redondeo : Math.round(v));
  };
  if (d.simular) {
    return c.json({ afectados: total, simulado: true, muestra: muestra.map((a) => ({ id: a.id, nombre: a.nombre, antes: d.aplicar_a === 'costo' ? a.costo : a.precio, despues: nuevo(a) })) });
  }
  if (total > 5000) throw conflict('Son demasiados artículos para un solo ajuste: filtrá por categoría o proveedor.');
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE articulos SET ${d.aplicar_a} = ${expresionAjuste(columnaOrigen, d.redondeo)}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${where}`).bind(...paramsAjuste(d.valor, d.redondeo), ...params),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'articulo', null, 'ajuste_masivo', d),
  ]);
  return c.json({ afectados: total });
});

/** Precio de un artículo en cada lista activa (ficha del artículo). */
precios.get('/articulos/:id/precios-lista', requirePerm('catalogo.ver'), async (c) => {
  const s = c.get('sesion');
  const a = await first<{ costo: number; precio: number }>(c.env.DB, 'SELECT costo, precio FROM articulos WHERE taller_id = ? AND id = ?', s.tallerId, c.req.param('id'));
  if (!a) throw notFound('Artículo');
  const filas = await all<Lista & { precio_fijo: number | null }>(
    c.env.DB,
    `SELECT ${LISTA_COLS.split(', ').map((x) => `lp.${x}`).join(', ')}, li.precio AS precio_fijo FROM listas_precios lp
       LEFT JOIN lista_precio_items li ON li.taller_id = lp.taller_id AND li.lista_id = lp.id AND li.articulo_id = ?
      WHERE lp.taller_id = ? AND lp.activa = 1 ORDER BY lp.es_default DESC, lp.nombre`,
    c.req.param('id'),
    s.tallerId,
  );
  return c.json(filas.map((l) => ({ lista_id: l.id, nombre: l.nombre, es_default: l.es_default, ...tradPrecio(l, { ...a, precio_fijo: l.precio_fijo }) })));
});
