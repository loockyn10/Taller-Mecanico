// Inventario avanzado: valorización, historial de costos, conteo físico y reposición con generación de órdenes de compra.
// El stock sigue cambiando sólo mediante movimientos (lib/stock.ts); las cantidades se comparan siempre redondeadas a 3 decimales.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, conflict, notFound, query, zCantidad, zId, zTextoOpt } from '../lib/http';
import { all, auditar, first, guard, hoy, lotes, SEQ_VALOR, seqIncrementar, uid, type Stmt } from '../lib/db';
import { requirePerm, tiene } from '../lib/auth';
import { permiteNegativo, sentenciasMovimiento } from '../lib/stock';
import { calcularOC } from '../../shared/compras';
import { redondearCantidad as r3 } from '../../shared/dominio';

export const inventario = new Hono<AppEnv>();

// ───────────── Valorización ─────────────
inventario.get('/inventario/valorizado', requirePerm('stock.valorizar'), async (c) => {
  const s = c.get('sesion');
  const f = query(c, z.object({ categoria_id: z.string().optional(), proveedor_id: z.string().optional(), q: z.string().optional(), con_stock: z.string().optional(), inactivos: z.string().optional() }));
  const cond = ['a.taller_id = ?'];
  const params: unknown[] = [s.tallerId];
  if (!f.inactivos) cond.push('a.activo = 1');
  if (f.categoria_id) (cond.push(f.categoria_id === 'sin' ? 'a.categoria_id IS NULL' : 'a.categoria_id = ?'), f.categoria_id !== 'sin' && params.push(f.categoria_id));
  if (f.proveedor_id) (cond.push('a.proveedor_id = ?'), params.push(f.proveedor_id));
  if (f.con_stock) cond.push('ROUND(a.stock, 3) > 0');
  if (f.q) (cond.push('(a.nombre LIKE ? OR a.codigo LIKE ?)'), params.push(`%${f.q.replace(/[%_]/g, '')}%`, `%${f.q.replace(/[%_]/g, '')}%`));
  const filas = await all<any>(
    c.env.DB,
    `SELECT a.id, a.codigo, a.nombre, a.unidad, a.stock, a.costo, a.precio, a.categoria_id, COALESCE(ca.nombre, 'Sin categoría') AS categoria, p.nombre AS proveedor
       FROM articulos a LEFT JOIN categorias_articulo ca ON ca.taller_id = a.taller_id AND ca.id = a.categoria_id LEFT JOIN proveedores p ON p.taller_id = a.taller_id AND p.id = a.proveedor_id
      WHERE ${cond.join(' AND ')} ORDER BY categoria COLLATE NOCASE, a.nombre COLLATE NOCASE LIMIT 5000`,
    ...params,
  );
  const items = filas.map((a) => ({ ...a, stock: r3(a.stock), valor_costo: Math.round(r3(a.stock) * a.costo), valor_venta: Math.round(r3(a.stock) * a.precio) }));
  const porCat = new Map<string, { categoria: string; articulos: number; unidades: number; valor_costo: number; valor_venta: number }>();
  for (const i of items) {
    const x = porCat.get(i.categoria) ?? { categoria: i.categoria, articulos: 0, unidades: 0, valor_costo: 0, valor_venta: 0 };
    x.articulos++;
    x.unidades = r3(x.unidades + i.stock);
    x.valor_costo += i.valor_costo;
    x.valor_venta += i.valor_venta;
    porCat.set(i.categoria, x);
  }
  const tot = items.reduce((a, i) => ({ articulos: a.articulos + 1, valor_costo: a.valor_costo + i.valor_costo, valor_venta: a.valor_venta + i.valor_venta }), { articulos: 0, valor_costo: 0, valor_venta: 0 });
  return c.json({
    items,
    por_categoria: [...porCat.values()].sort((a, b) => b.valor_costo - a.valor_costo),
    totales: { ...tot, margen_potencial: tot.valor_venta - tot.valor_costo, sin_costo: items.filter((i) => i.costo === 0 && i.stock > 0).length, stock_negativo: items.filter((i) => i.stock < 0).length },
  });
});

inventario.get('/inventario/costos/:articuloId', requirePerm('stock.valorizar'), async (c) => {
  const s = c.get('sesion');
  const a = await first<any>(c.env.DB, 'SELECT id, nombre, codigo, costo, precio FROM articulos WHERE taller_id = ? AND id = ?', s.tallerId, c.req.param('articuloId'));
  if (!a) throw notFound('Artículo');
  const historial = await all(c.env.DB, 'SELECT id, costo_anterior, costo_nuevo, origen, created_at FROM articulo_costos WHERE taller_id = ? AND articulo_id = ? ORDER BY id DESC LIMIT 200', s.tallerId, a.id);
  return c.json({ articulo: a, historial });
});

// ───────────── Reposición → órdenes de compra ─────────────
inventario.post('/reposicion/ordenes', requirePerm('compras.gestionar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(
    c,
    z.object({
      items: z.array(z.object({ articulo_id: zId, cantidad: zCantidad })).min(1).max(300),
      emitir: z.boolean().default(false),
      idem_key: z.string().min(8).max(80),
    }),
  );
  const ids = d.items.map((i) => i.articulo_id);
  if (new Set(ids).size !== ids.length) throw badRequest('Hay artículos repetidos');
  const arts: Array<{ id: string; nombre: string; costo: number; proveedor_id: string | null; activo: number }> = [];
  for (const l of lotes(ids)) arts.push(...(await all<any>(c.env.DB, `SELECT id, nombre, costo, proveedor_id, activo FROM articulos WHERE taller_id = ? AND id IN (${l.map(() => '?').join(',')})`, s.tallerId, ...l)));
  if (arts.length !== ids.length) throw badRequest('Hay artículos inexistentes');
  const sinProv = arts.filter((a) => !a.proveedor_id);
  if (sinProv.length) throw badRequest(`Asignale un proveedor habitual a: ${sinProv.map((a) => a.nombre).join(', ')}`);
  const porProv = new Map<string, typeof d.items>();
  for (const it of d.items) {
    const pid = arts.find((a) => a.id === it.articulo_id)!.proveedor_id!;
    porProv.set(pid, [...(porProv.get(pid) ?? []), it]);
  }
  const provs = await all<{ id: string; nombre: string; activo: number }>(c.env.DB, 'SELECT id, nombre, activo FROM proveedores WHERE taller_id = ?', s.tallerId);
  for (const pid of porProv.keys()) if (!provs.find((p) => p.id === pid)?.activo) throw badRequest(`El proveedor ${provs.find((p) => p.id === pid)?.nombre ?? ''} está desactivado`);
  const creadas: Array<{ id: string; numero?: number; proveedor: string; duplicado?: boolean }> = [];
  const stmts: Stmt[] = [];
  const nuevas: Array<{ id: string; pid: string }> = [];
  for (const [pid, items] of porProv) {
    const clave = `${d.idem_key}:${pid}`;
    const previa = await first<{ id: string; numero: number }>(c.env.DB, 'SELECT id, numero FROM ordenes_compra WHERE taller_id = ? AND idem_key = ?', s.tallerId, clave);
    if (previa) {
      creadas.push({ ...previa, proveedor: provs.find((p) => p.id === pid)!.nombre, duplicado: true });
      continue;
    }
    const filas = items.map((it) => ({ articulo_id: it.articulo_id, cantidad: it.cantidad, costo_unitario: arts.find((a) => a.id === it.articulo_id)!.costo, desc_pct: 0 }));
    const t = calcularOC(filas, {});
    const id = uid();
    nuevas.push({ id, pid });
    stmts.push(
      ...seqIncrementar(c.env.DB, s.tallerId, 'orden_compra'),
      c.env.DB
        .prepare(
          `INSERT INTO ordenes_compra (id, taller_id, numero, proveedor_id, fecha, estado, subtotal, neto, total, observaciones, origen, idem_key, created_by)
           VALUES (?, ?, ${SEQ_VALOR}, ?, ?, ?, ?, ?, ?, ?, 'reposicion', ?, ?)`,
        )
        .bind(id, s.tallerId, s.tallerId, 'orden_compra', pid, hoy(), d.emitir ? 'pendiente' : 'borrador', t.subtotal, t.neto, t.total, 'Generada desde reposición de stock', clave, s.usuarioId),
      ...filas.map((f, i) =>
        c.env.DB
          .prepare('INSERT INTO orden_compra_items (id, taller_id, orden_id, articulo_id, posicion, cantidad, costo_unitario, desc_pct, subtotal) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)')
          .bind(uid(), s.tallerId, id, f.articulo_id, i, f.cantidad, f.costo_unitario, t.subtotales[i]),
      ),
      auditar(c.env.DB, s.tallerId, s.usuarioId, 'orden_compra', id, 'crear_desde_reposicion', { articulos: filas.length, total: t.total }),
    );
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  for (const n of nuevas) {
    const oc = await first<{ id: string; numero: number }>(c.env.DB, 'SELECT id, numero FROM ordenes_compra WHERE taller_id = ? AND id = ?', s.tallerId, n.id);
    creadas.push({ ...oc!, proveedor: provs.find((p) => p.id === n.pid)!.nombre });
  }
  return c.json({ ordenes: creadas }, 201);
});

// ───────────── Conteo físico ─────────────
const SELECT_CONTEO = `SELECT cn.*, u.nombre AS usuario, ca.nombre AS categoria,
    (SELECT COUNT(*) FROM conteo_items i WHERE i.taller_id = cn.taller_id AND i.conteo_id = cn.id) AS articulos,
    (SELECT COUNT(*) FROM conteo_items i WHERE i.taller_id = cn.taller_id AND i.conteo_id = cn.id AND i.contado IS NOT NULL) AS contados,
    (SELECT COUNT(*) FROM conteo_items i WHERE i.taller_id = cn.taller_id AND i.conteo_id = cn.id AND i.contado IS NOT NULL AND ROUND(i.contado - i.stock_sistema, 3) <> 0) AS con_diferencia
  FROM conteos cn LEFT JOIN usuarios u ON u.taller_id = cn.taller_id AND u.id = cn.usuario_id LEFT JOIN categorias_articulo ca ON ca.taller_id = cn.taller_id AND ca.id = cn.categoria_id`;

inventario.get('/inventario/conteos', requirePerm('stock.ver'), async (c) => {
  const s = c.get('sesion');
  return c.json(await all(c.env.DB, `${SELECT_CONTEO} WHERE cn.taller_id = ? ORDER BY cn.numero DESC LIMIT 100`, s.tallerId));
});

inventario.post('/inventario/conteos', requirePerm('stock.ajustar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, z.object({ descripcion: zTextoOpt(200), categoria_id: zId.nullish(), solo_con_stock: z.boolean().default(false) }));
  if (d.categoria_id && !(await first(c.env.DB, 'SELECT 1 FROM categorias_articulo WHERE taller_id = ? AND id = ?', s.tallerId, d.categoria_id))) throw badRequest('Categoría inexistente');
  const abierto = await first(c.env.DB, "SELECT 1 FROM conteos WHERE taller_id = ? AND estado = 'abierto' AND COALESCE(categoria_id, '') = COALESCE(?, '')", s.tallerId, d.categoria_id ?? null);
  if (abierto) throw conflict('Ya hay un conteo abierto para ese alcance: terminalo o cancelalo antes de iniciar otro', 'conteo_abierto');
  const id = uid();
  await c.env.DB.batch([
    ...seqIncrementar(c.env.DB, s.tallerId, 'conteo'),
    c.env.DB.prepare(`INSERT INTO conteos (id, taller_id, numero, fecha, descripcion, categoria_id, usuario_id) VALUES (?, ?, ${SEQ_VALOR}, ?, ?, ?, ?)`).bind(id, s.tallerId, s.tallerId, 'conteo', hoy(), d.descripcion, d.categoria_id ?? null, s.usuarioId),
    c.env.DB
      .prepare(
        `INSERT INTO conteo_items (id, taller_id, conteo_id, articulo_id, stock_sistema, costo)
         SELECT lower(hex(randomblob(16))), taller_id, ?, id, ROUND(stock, 3), costo FROM articulos
          WHERE taller_id = ? AND activo = 1 ${d.categoria_id ? 'AND categoria_id = ?' : ''} ${d.solo_con_stock ? 'AND ROUND(stock, 3) <> 0' : ''}`,
      )
      .bind(id, s.tallerId, ...(d.categoria_id ? [d.categoria_id] : [])),
    guard(c.env.DB, 'NOT EXISTS (SELECT 1 FROM conteo_items WHERE taller_id = ? AND conteo_id = ?)', s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'conteo', id, 'iniciar'),
  ]).catch((e) => {
    if (String(e).includes('tx_guard') || String(e).includes('ok = 1')) throw badRequest('No hay artículos para contar con ese criterio');
    throw e;
  });
  return c.json(await first(c.env.DB, `${SELECT_CONTEO} WHERE cn.taller_id = ? AND cn.id = ?`, s.tallerId, id), 201);
});

inventario.get('/inventario/conteos/:id', requirePerm('stock.ver'), async (c) => {
  const s = c.get('sesion');
  const cn = await first<any>(c.env.DB, `${SELECT_CONTEO} WHERE cn.taller_id = ? AND cn.id = ?`, s.tallerId, c.req.param('id'));
  if (!cn) throw notFound('Conteo');
  const items = await all<any>(
    c.env.DB,
    `SELECT i.articulo_id, a.codigo, a.nombre, a.unidad, i.stock_sistema, i.contado, a.stock AS stock_actual, i.costo,
            CASE WHEN i.contado IS NULL THEN NULL ELSE ROUND(i.contado - i.stock_sistema, 3) END AS diferencia
       FROM conteo_items i JOIN articulos a ON a.taller_id = i.taller_id AND a.id = i.articulo_id WHERE i.taller_id = ? AND i.conteo_id = ? ORDER BY a.nombre COLLATE NOCASE`,
    s.tallerId, cn.id,
  );
  const conCosto = tiene(s, 'precios.costo.ver');
  const conValor = items.map((i) => ({ ...i, costo: conCosto ? i.costo : undefined, valor_diferencia: !conCosto || i.diferencia == null ? null : Math.round(i.diferencia * i.costo) }));
  const movimientos = cn.estado === 'aplicado' ? await all(c.env.DB, "SELECT id, articulo_id, cantidad, stock_resultante, created_at FROM stock_movimientos WHERE taller_id = ? AND origen_tipo = 'conteo' AND origen_id = ?", s.tallerId, cn.id) : [];
  return c.json({ ...cn, items: conValor, movimientos, valor_diferencia_total: conCosto ? conValor.reduce((a, i) => a + (i.valor_diferencia ?? 0), 0) : undefined });
});

inventario.put('/inventario/conteos/:id/items', requirePerm('stock.ajustar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, z.object({ items: z.array(z.object({ articulo_id: zId, contado: z.number().min(0).max(1e9).refine((v) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6, 'admite hasta 3 decimales').nullable() })).min(1).max(300) }));
  const cn = await first<{ estado: string }>(c.env.DB, 'SELECT estado FROM conteos WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!cn) throw notFound('Conteo');
  if (cn.estado !== 'abierto') throw conflict('El conteo ya no está abierto');
  await c.env.DB.batch([
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM conteos WHERE taller_id = ? AND id = ? AND estado = 'abierto')", s.tallerId, id),
    ...d.items.map((i) => c.env.DB.prepare('UPDATE conteo_items SET contado = ? WHERE taller_id = ? AND conteo_id = ? AND articulo_id = ?').bind(i.contado == null ? null : r3(i.contado), s.tallerId, id, i.articulo_id)),
  ]);
  return c.json({ ok: true });
});

const MAX_AJUSTES_POR_CONTEO = 250;

inventario.post('/inventario/conteos/:id/aplicar', requirePerm('stock.ajustar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const cn = await first<{ estado: string; numero: number }>(c.env.DB, 'SELECT estado, numero FROM conteos WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!cn) throw notFound('Conteo');
  if (cn.estado !== 'abierto') throw conflict('El conteo ya fue aplicado o cancelado');
  const dif = await all<{ articulo_id: string; nombre: string; stock_sistema: number; contado: number; stock_actual: number; costo: number }>(
    c.env.DB,
    `SELECT i.articulo_id, a.nombre, i.stock_sistema, i.contado, a.stock AS stock_actual, i.costo FROM conteo_items i JOIN articulos a ON a.taller_id = i.taller_id AND a.id = i.articulo_id
      WHERE i.taller_id = ? AND i.conteo_id = ? AND i.contado IS NOT NULL AND ROUND(i.contado - i.stock_sistema, 3) <> 0`,
    s.tallerId, id,
  );
  if (dif.length > MAX_AJUSTES_POR_CONTEO) throw badRequest(`Un conteo no puede ajustar más de ${MAX_AJUSTES_POR_CONTEO} artículos a la vez: dividilo por categoría`);
  const negativo = await permiteNegativo(c.env.DB, s.tallerId);
  // El ajuste aplica la diferencia contada respecto de la foto inicial: lo que se vendió o compró durante el conteo se conserva.
  const stmts: Stmt[] = [guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM conteos WHERE taller_id = ? AND id = ? AND estado = 'abierto')", s.tallerId, id)];
  const negados: string[] = [];
  for (const i of dif) {
    const delta = r3(i.contado - i.stock_sistema);
    if (!negativo && r3(i.stock_actual + delta) < 0) negados.push(`${i.nombre} (stock actual ${i.stock_actual}, diferencia ${delta})`);
    stmts.push(...sentenciasMovimiento(c.env.DB, s.tallerId, { articuloId: i.articulo_id, delta, tipo: 'ajuste', motivo: 'conteo', origenTipo: 'conteo', origenId: id, idemKey: `conteo:${id}:${i.articulo_id}`, notas: `Conteo físico #${cn.numero}`, costoUnitario: i.costo, usuarioId: s.usuarioId }, negativo));
  }
  if (negados.length) throw conflict(`El ajuste dejaría stock negativo: ${negados.join('; ')}`, 'stock_insuficiente');
  stmts.push(
    c.env.DB.prepare("UPDATE conteos SET estado = 'aplicado', aplicado_por = ?, aplicado_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ? AND id = ?").bind(s.usuarioId, s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'conteo', id, 'aplicar', { ajustes: dif.length }),
  );
  await c.env.DB.batch(stmts);
  return c.json({ ok: true, ajustes: dif.length });
});

inventario.post('/inventario/conteos/:id/cancelar', requirePerm('stock.ajustar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const cn = await first<{ estado: string }>(c.env.DB, 'SELECT estado FROM conteos WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!cn) throw notFound('Conteo');
  if (cn.estado !== 'abierto') throw conflict('Sólo se cancelan conteos abiertos');
  await c.env.DB.batch([
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM conteos WHERE taller_id = ? AND id = ? AND estado = 'abierto')", s.tallerId, id),
    c.env.DB.prepare("UPDATE conteos SET estado = 'cancelado' WHERE taller_id = ? AND id = ?").bind(s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'conteo', id, 'cancelar'),
  ]);
  return c.json({ ok: true });
});
