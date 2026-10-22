// Compras avanzadas: órdenes de compra, recepción de mercadería, facturas de proveedores y deuda con vencimientos.
//
// Dos circuitos que NO se mezclan (así el stock y la deuda nunca se cuentan dos veces):
//   A) Compra directa (compras.ts): mercadería + comprobante en un solo paso → ingresa stock y genera la deuda.
//   B) Orden de compra → recepción(es) → factura: la recepción ingresa el stock; la deuda nace con la factura
//      (o con la compra a la que se la asocie, que ya la contiene).
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, conflict, notFound, query, zCantidad, zCentavos, zFecha, zId, zPct, zTextoOpt } from '../lib/http';
import { all, auditar, first, guard, hoy, like, lotes, SEQ_VALOR, seqIncrementar, uid, type Stmt } from '../lib/db';
import { requireRW } from '../lib/auth';
import { agrupar, permiteNegativo, resolverDeposito, sentenciaOrigenCosto, sentenciasMovimiento, verificarDisponible } from '../lib/stock';
import { fechaComercial, sumarDias } from '../lib/fechas';
import { deudaProveedores } from '../lib/proveedores';
import { calcularOC } from '../../shared/compras';
import { cuitValido, esNotaCredito, normalizarNroComprobante, TIPOS_COMPROBANTE_PROVEEDOR } from '../../shared/dominio';
import { redondearCantidad as r3 } from '../../shared/dominio';

export const abastecimiento = new Hono<AppEnv>();
for (const ruta of ['/ordenes-compra', '/ordenes-compra/*', '/recepciones', '/recepciones/*', '/facturas-proveedor', '/facturas-proveedor/*', '/deuda-proveedores', '/vencimientos-proveedores'])
  abastecimiento.use(ruta, requireRW('compras.ver', 'compras.gestionar'));

// ═════════════════════════ Órdenes de compra ═════════════════════════
const SELECT_OC = `SELECT oc.*, p.nombre AS proveedor, p.cuit AS proveedor_cuit,
    (SELECT COALESCE(SUM(cantidad), 0) FROM orden_compra_items i WHERE i.taller_id = oc.taller_id AND i.orden_id = oc.id) AS unidades,
    (SELECT COALESCE(SUM(cantidad_recibida), 0) FROM orden_compra_items i WHERE i.taller_id = oc.taller_id AND i.orden_id = oc.id) AS unidades_recibidas,
    (SELECT COUNT(*) FROM recepciones r WHERE r.taller_id = oc.taller_id AND r.orden_id = oc.id AND r.estado = 'registrada') AS recepciones
  FROM ordenes_compra oc JOIN proveedores p ON p.taller_id = oc.taller_id AND p.id = oc.proveedor_id`;

abastecimiento.get('/ordenes-compra', async (c) => {
  const s = c.get('sesion');
  const f = query(c, z.object({ estado: z.string().optional(), proveedor_id: z.string().optional(), desde: z.string().optional(), hasta: z.string().optional(), q: z.string().optional(), abiertas: z.string().optional() }));
  const cond = ['oc.taller_id = ?'];
  const params: unknown[] = [s.tallerId];
  if (f.estado) (cond.push('oc.estado = ?'), params.push(f.estado));
  if (f.abiertas) cond.push("oc.estado IN ('pendiente','parcial')");
  if (f.proveedor_id) (cond.push('oc.proveedor_id = ?'), params.push(f.proveedor_id));
  if (f.desde) (cond.push('oc.fecha >= ?'), params.push(f.desde));
  if (f.hasta) (cond.push('oc.fecha <= ?'), params.push(f.hasta));
  if (f.q) (cond.push('(p.nombre LIKE ? OR CAST(oc.numero AS TEXT) = ? OR oc.observaciones LIKE ?)'), params.push(like(f.q), f.q.replace(/\D/g, ''), like(f.q)));
  return c.json(await all(c.env.DB, `${SELECT_OC} WHERE ${cond.join(' AND ')} ORDER BY oc.numero DESC LIMIT 300`, ...params));
});

async function detalleOC(db: D1Database, tallerId: string, id: string) {
  const oc = await first<any>(db, `${SELECT_OC} WHERE oc.taller_id = ? AND oc.id = ?`, tallerId, id);
  if (!oc) return null;
  const [items, recepciones, facturas] = await Promise.all([
    all(db, `SELECT i.*, a.nombre AS articulo, a.codigo, a.unidad, a.stock, ROUND(i.cantidad - i.cantidad_recibida, 3) AS pendiente
               FROM orden_compra_items i JOIN articulos a ON a.taller_id = i.taller_id AND a.id = i.articulo_id WHERE i.taller_id = ? AND i.orden_id = ? ORDER BY i.posicion`, tallerId, id),
    all(db, "SELECT r.id, r.numero, r.fecha, r.remito, r.estado, (SELECT COUNT(*) FROM recepcion_items x WHERE x.taller_id = r.taller_id AND x.recepcion_id = r.id) AS lineas FROM recepciones r WHERE r.taller_id = ? AND r.orden_id = ? ORDER BY r.numero", tallerId, id),
    all(db, 'SELECT id, numero, tipo, nro_comprobante, fecha, total, estado FROM facturas_proveedor WHERE taller_id = ? AND orden_compra_id = ? ORDER BY numero', tallerId, id),
  ]);
  return { ...oc, items, recepciones_detalle: recepciones, facturas };
}

abastecimiento.get('/ordenes-compra/:id', async (c) => {
  const d = await detalleOC(c.env.DB, c.get('sesion').tallerId, c.req.param('id'));
  if (!d) throw notFound('Orden de compra');
  return c.json(d);
});

const zOC = z.object({
  proveedor_id: zId,
  fecha: zFecha.optional(),
  fecha_prevista: zFecha.nullish(),
  descuento_pct: zPct.default(0),
  iva_pct: z.number().refine((v) => [0, 10.5, 21, 27].includes(v), 'IVA inválido').default(0),
  actualizar_costos: z.boolean().default(true),
  observaciones: zTextoOpt(500),
  items: z.array(z.object({ articulo_id: zId, cantidad: zCantidad, costo_unitario: zCentavos, desc_pct: zPct.default(0) })).min(1, 'agregá al menos un artículo').max(200),
});

async function validarOC(db: D1Database, tallerId: string, d: z.infer<typeof zOC>) {
  const prov = await first<{ activo: number }>(db, 'SELECT activo FROM proveedores WHERE taller_id = ? AND id = ?', tallerId, d.proveedor_id);
  if (!prov) throw badRequest('Proveedor inexistente');
  if (!prov.activo) throw badRequest('El proveedor está desactivado');
  const ids = d.items.map((i) => i.articulo_id);
  if (new Set(ids).size !== ids.length) throw badRequest('Hay artículos repetidos: sumá las cantidades en una sola línea');
  let n = 0;
  for (const l of lotes(ids)) n += (await all(db, `SELECT id FROM articulos WHERE taller_id = ? AND id IN (${l.map(() => '?').join(',')})`, tallerId, ...l)).length;
  if (n !== ids.length) throw badRequest('Hay artículos inexistentes');
  if (d.fecha_prevista && d.fecha && d.fecha_prevista < d.fecha) throw badRequest('La fecha prevista de entrega no puede ser anterior a la fecha de la orden');
}

function sentenciasItemsOC(db: D1Database, tallerId: string, id: string, d: z.infer<typeof zOC>, t: ReturnType<typeof calcularOC>): Stmt[] {
  return d.items.map((it, i) =>
    db
      .prepare('INSERT INTO orden_compra_items (id, taller_id, orden_id, articulo_id, posicion, cantidad, costo_unitario, desc_pct, subtotal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(uid(), tallerId, id, it.articulo_id, i, it.cantidad, it.costo_unitario, it.desc_pct, t.subtotales[i]),
  );
}

abastecimiento.post('/ordenes-compra', async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zOC.extend({ emitir: z.boolean().default(false), origen: z.enum(['reposicion']).nullish(), idem_key: z.string().min(8).max(80) }));
  const previa = await first<{ id: string }>(c.env.DB, 'SELECT id FROM ordenes_compra WHERE taller_id = ? AND idem_key = ?', s.tallerId, d.idem_key);
  if (previa) return c.json({ id: previa.id, duplicado: true });
  await validarOC(c.env.DB, s.tallerId, d);
  const fecha = fechaComercial(s, d.fecha);
  const t = calcularOC(d.items, d);
  const id = uid();
  await c.env.DB.batch([
    ...seqIncrementar(c.env.DB, s.tallerId, 'orden_compra'),
    c.env.DB
      .prepare(
        `INSERT INTO ordenes_compra (id, taller_id, numero, proveedor_id, fecha, fecha_prevista, estado, descuento_pct, iva_pct, subtotal, descuento, neto, iva, total, actualizar_costos, observaciones, origen, idem_key, created_by)
         VALUES (?, ?, ${SEQ_VALOR}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, s.tallerId, s.tallerId, 'orden_compra', d.proveedor_id, fecha, d.fecha_prevista ?? null, d.emitir ? 'pendiente' : 'borrador', d.descuento_pct, d.iva_pct, t.subtotal, t.descuento, t.neto, t.iva, t.total, d.actualizar_costos ? 1 : 0, d.observaciones, d.origen ?? null, d.idem_key, s.usuarioId),
    ...sentenciasItemsOC(c.env.DB, s.tallerId, id, d, t),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'orden_compra', id, 'crear', { total: t.total, estado: d.emitir ? 'pendiente' : 'borrador' }),
  ]);
  return c.json({ id }, 201);
});

abastecimiento.put('/ordenes-compra/:id', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, zOC);
  const oc = await first<{ estado: string }>(c.env.DB, 'SELECT estado FROM ordenes_compra WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!oc) throw notFound('Orden de compra');
  if (!['borrador', 'pendiente'].includes(oc.estado)) throw conflict('Sólo se editan órdenes en borrador o pendientes sin recepciones');
  if (await first(c.env.DB, "SELECT 1 FROM recepciones WHERE taller_id = ? AND orden_id = ? AND estado = 'registrada'", s.tallerId, id)) throw conflict('La orden ya tiene recepciones registradas');
  await validarOC(c.env.DB, s.tallerId, d);
  const t = calcularOC(d.items, d);
  await c.env.DB.batch([
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM ordenes_compra WHERE taller_id = ? AND id = ? AND estado IN ('borrador','pendiente'))", s.tallerId, id),
    guard(c.env.DB, "EXISTS (SELECT 1 FROM recepciones WHERE taller_id = ? AND orden_id = ? AND estado = 'registrada')", s.tallerId, id),
    c.env.DB.prepare('DELETE FROM orden_compra_items WHERE taller_id = ? AND orden_id = ?').bind(s.tallerId, id),
    c.env.DB
      .prepare(
        `UPDATE ordenes_compra SET proveedor_id = ?, fecha = COALESCE(?, fecha), fecha_prevista = ?, descuento_pct = ?, iva_pct = ?, subtotal = ?, descuento = ?, neto = ?, iva = ?, total = ?,
                actualizar_costos = ?, observaciones = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ? AND id = ?`,
      )
      .bind(d.proveedor_id, d.fecha ?? null, d.fecha_prevista ?? null, d.descuento_pct, d.iva_pct, t.subtotal, t.descuento, t.neto, t.iva, t.total, d.actualizar_costos ? 1 : 0, d.observaciones, s.tallerId, id),
    ...sentenciasItemsOC(c.env.DB, s.tallerId, id, d, t),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'orden_compra', id, 'modificar', { total: t.total }),
  ]);
  return c.json({ ok: true });
});

abastecimiento.post('/ordenes-compra/:id/emitir', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const oc = await first<{ estado: string }>(c.env.DB, 'SELECT estado FROM ordenes_compra WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!oc) throw notFound('Orden de compra');
  if (oc.estado !== 'borrador') throw conflict('Sólo se emiten órdenes en borrador');
  await c.env.DB.batch([
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM ordenes_compra WHERE taller_id = ? AND id = ? AND estado = 'borrador')", s.tallerId, id),
    c.env.DB.prepare("UPDATE ordenes_compra SET estado = 'pendiente', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ? AND id = ?").bind(s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'orden_compra', id, 'emitir'),
  ]);
  return c.json({ ok: true });
});

abastecimiento.post('/ordenes-compra/:id/cancelar', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const { motivo } = await body(c, z.object({ motivo: z.string().trim().min(3).max(300) }));
  const oc = await first<{ estado: string }>(c.env.DB, 'SELECT estado FROM ordenes_compra WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!oc) throw notFound('Orden de compra');
  if (!['borrador', 'pendiente'].includes(oc.estado)) throw conflict(oc.estado === 'parcial' ? 'La orden ya recibió mercadería: cerrala con faltante en lugar de cancelarla' : 'La orden no se puede cancelar en este estado');
  await c.env.DB.batch([
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM ordenes_compra WHERE taller_id = ? AND id = ? AND estado IN ('borrador','pendiente'))", s.tallerId, id),
    guard(c.env.DB, "EXISTS (SELECT 1 FROM recepciones WHERE taller_id = ? AND orden_id = ? AND estado = 'registrada')", s.tallerId, id),
    c.env.DB.prepare("UPDATE ordenes_compra SET estado = 'cancelada', motivo_cancelacion = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ? AND id = ?").bind(motivo, s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'orden_compra', id, 'cancelar', { motivo }),
  ]);
  return c.json({ ok: true });
});

/** Cierra una orden parcialmente recibida: lo que falta no va a llegar. Queda como "recibida" con faltante registrado. */
abastecimiento.post('/ordenes-compra/:id/cerrar', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const { motivo } = await body(c, z.object({ motivo: z.string().trim().min(3).max(300) }));
  const oc = await first<{ estado: string }>(c.env.DB, 'SELECT estado FROM ordenes_compra WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!oc) throw notFound('Orden de compra');
  if (oc.estado !== 'parcial') throw conflict('Sólo se cierra con faltante una orden parcialmente recibida');
  await c.env.DB.batch([
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM ordenes_compra WHERE taller_id = ? AND id = ? AND estado = 'parcial')", s.tallerId, id),
    c.env.DB.prepare("UPDATE ordenes_compra SET estado = 'recibida', cerrada_con_faltante = 1, observaciones = COALESCE(observaciones || ' · ', '') || ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ? AND id = ?").bind(`Cerrada con faltante: ${motivo}`, s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'orden_compra', id, 'cerrar_con_faltante', { motivo }),
  ]);
  return c.json({ ok: true });
});

// ═════════════════════════ Recepción de mercadería ═════════════════════════
abastecimiento.get('/recepciones', async (c) => {
  const s = c.get('sesion');
  const f = query(c, z.object({ orden_id: z.string().optional(), proveedor_id: z.string().optional(), estado: z.string().optional(), desde: z.string().optional(), hasta: z.string().optional(), q: z.string().optional() }));
  const cond = ['r.taller_id = ?'];
  const params: unknown[] = [s.tallerId];
  if (f.orden_id) (cond.push('r.orden_id = ?'), params.push(f.orden_id));
  if (f.proveedor_id) (cond.push('r.proveedor_id = ?'), params.push(f.proveedor_id));
  if (f.estado) (cond.push('r.estado = ?'), params.push(f.estado));
  if (f.desde) (cond.push('r.fecha >= ?'), params.push(f.desde));
  if (f.hasta) (cond.push('r.fecha <= ?'), params.push(f.hasta));
  if (f.q) (cond.push('(r.remito LIKE ? OR p.nombre LIKE ? OR CAST(r.numero AS TEXT) = ?)'), params.push(like(f.q), like(f.q), f.q.replace(/\D/g, '')));
  return c.json(
    await all(
      c.env.DB,
      `SELECT r.*, p.nombre AS proveedor, oc.numero AS orden_numero, u.nombre AS usuario FROM recepciones r
         JOIN proveedores p ON p.taller_id = r.taller_id AND p.id = r.proveedor_id JOIN ordenes_compra oc ON oc.taller_id = r.taller_id AND oc.id = r.orden_id
         LEFT JOIN usuarios u ON u.taller_id = r.taller_id AND u.id = r.usuario_id WHERE ${cond.join(' AND ')} ORDER BY r.numero DESC LIMIT 300`,
      ...params,
    ),
  );
});

abastecimiento.get('/recepciones/:id', async (c) => {
  const s = c.get('sesion');
  const r = await first<any>(
    c.env.DB,
    `SELECT r.*, p.nombre AS proveedor, p.cuit AS proveedor_cuit, oc.numero AS orden_numero, u.nombre AS usuario,
            COALESCE(dp.nombre, (SELECT nombre FROM depositos WHERE taller_id = r.taller_id AND es_principal = 1)) AS deposito
       FROM recepciones r JOIN proveedores p ON p.taller_id = r.taller_id AND p.id = r.proveedor_id
       JOIN ordenes_compra oc ON oc.taller_id = r.taller_id AND oc.id = r.orden_id
       LEFT JOIN depositos dp ON dp.taller_id = r.taller_id AND dp.id = r.deposito_id
       LEFT JOIN usuarios u ON u.taller_id = r.taller_id AND u.id = r.usuario_id WHERE r.taller_id = ? AND r.id = ?`,
    s.tallerId, c.req.param('id'),
  );
  if (!r) throw notFound('Recepción');
  const items = await all(c.env.DB, 'SELECT ri.*, a.nombre AS articulo, a.codigo, a.unidad FROM recepcion_items ri JOIN articulos a ON a.taller_id = ri.taller_id AND a.id = ri.articulo_id WHERE ri.taller_id = ? AND ri.recepcion_id = ?', s.tallerId, r.id);
  return c.json({ ...r, items });
});

abastecimiento.post('/ordenes-compra/:id/recepciones', async (c) => {
  const s = c.get('sesion');
  const ordenId = c.req.param('id');
  const d = await body(
    c,
    z.object({
      fecha: zFecha.optional(),
      remito: zTextoOpt(40),
      notas: zTextoOpt(500),
      items: z.array(z.object({ orden_item_id: zId, cantidad: zCantidad })).min(1, 'indicá qué se recibió').max(200),
      /** Depósito donde se recibe la mercadería (sin indicar: el principal). */
      deposito_id: zId.nullish(),
      idem_key: z.string().min(8).max(80),
    }),
  );
  const previa = await first<{ id: string; numero: number }>(c.env.DB, 'SELECT id, numero FROM recepciones WHERE taller_id = ? AND idem_key = ?', s.tallerId, d.idem_key);
  if (previa) return c.json({ ...previa, duplicado: true });
  const oc = await first<{ estado: string; proveedor_id: string; actualizar_costos: number; descuento_pct: number; numero: number }>(
    c.env.DB, 'SELECT estado, proveedor_id, actualizar_costos, descuento_pct, numero FROM ordenes_compra WHERE taller_id = ? AND id = ?', s.tallerId, ordenId,
  );
  if (!oc) throw notFound('Orden de compra');
  if (!['pendiente', 'parcial'].includes(oc.estado)) throw conflict(oc.estado === 'borrador' ? 'Emití la orden antes de recibir mercadería' : `La orden está ${oc.estado}: no admite recepciones`);
  const deposito = await resolverDeposito(c.env.DB, s.tallerId, d.deposito_id);
  const ids = d.items.map((i) => i.orden_item_id);
  if (new Set(ids).size !== ids.length) throw badRequest('Una línea de la orden aparece más de una vez');
  const lineas = await all<{ id: string; articulo_id: string; cantidad: number; cantidad_recibida: number; costo_unitario: number; desc_pct: number; nombre: string }>(
    c.env.DB, 'SELECT i.id, i.articulo_id, i.cantidad, i.cantidad_recibida, i.costo_unitario, i.desc_pct, a.nombre FROM orden_compra_items i JOIN articulos a ON a.taller_id = i.taller_id AND a.id = i.articulo_id WHERE i.taller_id = ? AND i.orden_id = ?', s.tallerId, ordenId,
  );
  for (const it of d.items) {
    const l = lineas.find((x) => x.id === it.orden_item_id);
    if (!l) throw badRequest('Hay líneas que no pertenecen a la orden');
    const pendiente = r3(l.cantidad - l.cantidad_recibida);
    if (it.cantidad > pendiente) throw conflict(`${l.nombre}: se pueden recibir como máximo ${pendiente} (pedido ${l.cantidad}, ya recibido ${l.cantidad_recibida})`, 'recepcion_excedida');
  }
  if (d.remito && (await first(c.env.DB, "SELECT 1 FROM recepciones WHERE taller_id = ? AND proveedor_id = ? AND remito = ? AND estado = 'registrada'", s.tallerId, oc.proveedor_id, d.remito))) throw conflict('Ese remito del proveedor ya fue cargado', 'duplicado');
  const fecha = fechaComercial(s, d.fecha);
  const id = uid();
  const stmts: Stmt[] = [
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM ordenes_compra WHERE taller_id = ? AND id = ? AND estado IN ('pendiente','parcial'))", s.tallerId, ordenId),
    ...seqIncrementar(c.env.DB, s.tallerId, 'recepcion'),
    c.env.DB
      .prepare(`INSERT INTO recepciones (id, taller_id, numero, orden_id, proveedor_id, fecha, remito, notas, idem_key, usuario_id, deposito_id) VALUES (?, ?, ${SEQ_VALOR}, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, s.tallerId, s.tallerId, 'recepcion', ordenId, oc.proveedor_id, fecha, d.remito, d.notas, d.idem_key, s.usuarioId, deposito),
  ];
  for (const it of d.items) {
    const l = lineas.find((x) => x.id === it.orden_item_id)!;
    const costoNeto = Math.round(l.costo_unitario * (1 - l.desc_pct / 100) * (1 - oc.descuento_pct / 100));
    stmts.push(
      c.env.DB
        .prepare(
          `INSERT INTO recepcion_items (id, taller_id, recepcion_id, orden_item_id, articulo_id, pendiente_antes, cantidad, diferencia, costo_unitario, costo_anterior, costo_aplicado)
           SELECT ?, i.taller_id, ?, i.id, i.articulo_id, ROUND(i.cantidad - i.cantidad_recibida, 3), ?, ROUND(? - (i.cantidad - i.cantidad_recibida), 3), ?, (SELECT costo FROM articulos WHERE taller_id = i.taller_id AND id = i.articulo_id), ?
             FROM orden_compra_items i WHERE i.taller_id = ? AND i.id = ?`,
        )
        .bind(uid(), id, it.cantidad, it.cantidad, costoNeto, oc.actualizar_costos ? 1 : 0, s.tallerId, it.orden_item_id),
      // El CHECK (cantidad_recibida <= cantidad) aborta el lote si otro usuario recibió lo mismo entre la lectura y la escritura.
      c.env.DB.prepare('UPDATE orden_compra_items SET cantidad_recibida = ROUND(cantidad_recibida + ?, 3) WHERE taller_id = ? AND id = ?').bind(it.cantidad, s.tallerId, it.orden_item_id),
      ...sentenciasMovimiento(
        c.env.DB, s.tallerId,
        { articuloId: l.articulo_id, depositoId: deposito, delta: it.cantidad, tipo: 'compra', origenTipo: 'recepcion', origenId: id, idemKey: `recepcion:${d.idem_key}:${l.articulo_id}`, costoUnitario: costoNeto, notas: `Recepción orden de compra #${oc.numero}`, usuarioId: s.usuarioId },
        true,
      ),
    );
    if (oc.actualizar_costos) stmts.push(c.env.DB.prepare('UPDATE articulos SET costo = ? WHERE taller_id = ? AND id = ?').bind(costoNeto, s.tallerId, l.articulo_id), sentenciaOrigenCosto(c.env.DB, s.tallerId, l.articulo_id, `recepcion:${id}`));
  }
  stmts.push(
    c.env.DB
      .prepare(
        `UPDATE ordenes_compra SET estado = CASE WHEN (SELECT COUNT(*) FROM orden_compra_items WHERE taller_id = ? AND orden_id = ? AND cantidad_recibida < cantidad - 0.0005) = 0 THEN 'recibida' ELSE 'parcial' END,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ? AND id = ?`,
      )
      .bind(s.tallerId, ordenId, s.tallerId, ordenId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'recepcion', id, 'crear', { orden_id: ordenId, remito: d.remito, lineas: d.items.length }),
  );
  await c.env.DB.batch(stmts);
  const r = await first<{ id: string; numero: number }>(c.env.DB, 'SELECT id, numero FROM recepciones WHERE taller_id = ? AND id = ?', s.tallerId, id);
  return c.json(r, 201);
});

abastecimiento.post('/recepciones/:id/anular', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const { motivo } = await body(c, z.object({ motivo: z.string().trim().min(3).max(300) }));
  const r = await first<{ estado: string; orden_id: string; numero: number; deposito_id: string | null }>(c.env.DB, 'SELECT estado, orden_id, numero, deposito_id FROM recepciones WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!r) throw notFound('Recepción');
  if (r.estado !== 'registrada') throw conflict('La recepción ya está anulada');
  const oc = await first<{ cerrada_con_faltante: number }>(c.env.DB, 'SELECT cerrada_con_faltante FROM ordenes_compra WHERE taller_id = ? AND id = ?', s.tallerId, r.orden_id);
  if (oc?.cerrada_con_faltante) throw conflict('La orden fue cerrada con faltante: no se pueden anular sus recepciones');
  const items = await all<{ orden_item_id: string; articulo_id: string; cantidad: number }>(c.env.DB, 'SELECT orden_item_id, articulo_id, cantidad FROM recepcion_items WHERE taller_id = ? AND recepcion_id = ?', s.tallerId, id);
  const negativo = await permiteNegativo(c.env.DB, s.tallerId);
  if (!negativo) await verificarDisponible(c.env.DB, s.tallerId, agrupar(items), r.deposito_id);
  const stmts: Stmt[] = [
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM recepciones WHERE taller_id = ? AND id = ? AND estado = 'registrada')", s.tallerId, id),
    c.env.DB.prepare("UPDATE recepciones SET estado = 'anulada', notas = COALESCE(notas || ' · ', '') || ? WHERE taller_id = ? AND id = ?").bind(`Anulada: ${motivo}`, s.tallerId, id),
  ];
  for (const it of items) {
    stmts.push(
      c.env.DB.prepare('UPDATE orden_compra_items SET cantidad_recibida = ROUND(cantidad_recibida - ?, 3) WHERE taller_id = ? AND id = ?').bind(it.cantidad, s.tallerId, it.orden_item_id),
      ...sentenciasMovimiento(
        c.env.DB, s.tallerId,
        { articuloId: it.articulo_id, depositoId: r.deposito_id, delta: -it.cantidad, tipo: 'anulacion_compra', origenTipo: 'recepcion', origenId: id, idemKey: `anulacion_recepcion:${id}:${it.articulo_id}`, notas: `Anulación recepción #${r.numero}`, usuarioId: s.usuarioId },
        negativo,
      ),
    );
  }
  stmts.push(
    c.env.DB
      .prepare(
        `UPDATE articulos SET costo = (SELECT ri.costo_anterior FROM recepcion_items ri WHERE ri.taller_id = articulos.taller_id AND ri.recepcion_id = ? AND ri.articulo_id = articulos.id)
          WHERE taller_id = ? AND id IN (
            SELECT ri.articulo_id FROM recepcion_items ri WHERE ri.taller_id = ? AND ri.recepcion_id = ? AND ri.costo_aplicado = 1 AND ri.costo_anterior IS NOT NULL
               AND ri.costo_unitario = (SELECT a2.costo FROM articulos a2 WHERE a2.taller_id = ri.taller_id AND a2.id = ri.articulo_id))`,
      )
      .bind(id, s.tallerId, s.tallerId, id),
    c.env.DB
      .prepare(
        `UPDATE ordenes_compra SET estado = CASE
              WHEN (SELECT COUNT(*) FROM orden_compra_items WHERE taller_id = ? AND orden_id = ? AND cantidad_recibida < cantidad - 0.0005) = 0 THEN 'recibida'
              WHEN (SELECT COALESCE(SUM(cantidad_recibida), 0) FROM orden_compra_items WHERE taller_id = ? AND orden_id = ?) > 0 THEN 'parcial' ELSE 'pendiente' END,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ? AND id = ?`,
      )
      .bind(s.tallerId, r.orden_id, s.tallerId, r.orden_id, s.tallerId, r.orden_id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'recepcion', id, 'anular', { motivo }),
  );
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

// ═════════════════════════ Facturas de proveedores ═════════════════════════
const SELECT_FACTURA = `SELECT f.*, p.nombre AS proveedor, co.numero AS compra_numero, oc.numero AS orden_numero,
    CASE WHEN f.tipo LIKE 'nota_credito%' THEN -1 ELSE 1 END AS signo
  FROM facturas_proveedor f JOIN proveedores p ON p.taller_id = f.taller_id AND p.id = f.proveedor_id
  LEFT JOIN compras co ON co.taller_id = f.taller_id AND co.id = f.compra_id
  LEFT JOIN ordenes_compra oc ON oc.taller_id = f.taller_id AND oc.id = f.orden_compra_id`;

abastecimiento.get('/facturas-proveedor', async (c) => {
  const s = c.get('sesion');
  const f = query(c, z.object({ proveedor_id: z.string().optional(), estado: z.string().optional(), desde: z.string().optional(), hasta: z.string().optional(), q: z.string().optional(), vencidas: z.string().optional() }));
  const cond = ['f.taller_id = ?'];
  const params: unknown[] = [s.tallerId];
  if (f.proveedor_id) (cond.push('f.proveedor_id = ?'), params.push(f.proveedor_id));
  if (f.estado) (cond.push('f.estado = ?'), params.push(f.estado));
  if (f.desde) (cond.push('f.fecha >= ?'), params.push(f.desde));
  if (f.hasta) (cond.push('f.fecha <= ?'), params.push(f.hasta));
  if (f.vencidas) (cond.push("f.estado = 'registrada' AND f.vencimiento < ? AND f.tipo NOT LIKE 'nota_credito%'"), params.push(hoy()));
  if (f.q) (cond.push('(p.nombre LIKE ? OR f.nro_comprobante LIKE ? OR f.cuit LIKE ?)'), params.push(like(f.q), like(f.q), like(f.q)));
  return c.json(await all(c.env.DB, `${SELECT_FACTURA} WHERE ${cond.join(' AND ')} ORDER BY f.fecha DESC, f.numero DESC LIMIT 300`, ...params));
});

abastecimiento.get('/facturas-proveedor/:id', async (c) => {
  const f = await first(c.env.DB, `${SELECT_FACTURA} WHERE f.taller_id = ? AND f.id = ?`, c.get('sesion').tallerId, c.req.param('id'));
  if (!f) throw notFound('Factura');
  return c.json(f);
});

const zFactura = z.object({
  proveedor_id: zId,
  tipo: z.enum(TIPOS_COMPROBANTE_PROVEEDOR),
  nro_comprobante: z.string().trim().min(3).max(20),
  fecha: zFecha,
  cuit: zTextoOpt(20),
  neto_gravado: zCentavos.default(0),
  no_gravado: zCentavos.default(0),
  iva_21: zCentavos.default(0),
  iva_10_5: zCentavos.default(0),
  iva_27: zCentavos.default(0),
  otros_tributos: zCentavos.default(0),
  total: zCentavos,
  condicion_pago: z.enum(['contado', 'cuenta_corriente', 'plazo']).default('cuenta_corriente'),
  dias_plazo: z.number().int().min(1).max(365).nullish(),
  vencimiento: zFecha.nullish(),
  compra_id: zId.nullish(),
  orden_compra_id: zId.nullish(),
  notas: zTextoOpt(500),
  idem_key: z.string().min(8).max(80),
});

abastecimiento.post('/facturas-proveedor', async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zFactura);
  const previa = await first<{ id: string; numero: number }>(c.env.DB, 'SELECT id, numero FROM facturas_proveedor WHERE taller_id = ? AND idem_key = ?', s.tallerId, d.idem_key);
  if (previa) return c.json({ ...previa, duplicado: true });
  const prov = await first<{ cuit: string | null; activo: number; nombre: string }>(c.env.DB, 'SELECT cuit, activo, nombre FROM proveedores WHERE taller_id = ? AND id = ?', s.tallerId, d.proveedor_id);
  if (!prov) throw badRequest('Proveedor inexistente');
  const nro = normalizarNroComprobante(d.nro_comprobante);
  if (!nro) throw badRequest('El número de comprobante debe tener la forma 0001-00001234 (punto de venta y número)');
  if (d.total <= 0) throw badRequest('El total debe ser mayor a 0');
  const suma = d.neto_gravado + d.no_gravado + d.iva_21 + d.iva_10_5 + d.iva_27 + d.otros_tributos;
  if (suma !== d.total) throw badRequest(`El total (${d.total / 100}) no coincide con la suma de los importes discriminados (${suma / 100})`);
  const cuit = d.cuit || prov.cuit || null;
  if (d.cuit && !cuitValido(d.cuit)) throw badRequest('El CUIT no es válido');
  if (d.cuit && prov.cuit && d.cuit.replace(/\D/g, '') !== prov.cuit.replace(/\D/g, '')) throw badRequest(`El CUIT no coincide con el del proveedor (${prov.cuit})`);
  if (d.fecha > hoy()) throw badRequest('La fecha del comprobante no puede ser futura');
  if (d.compra_id && d.orden_compra_id) throw badRequest('Asociá la factura a una compra o a una orden de compra, no a las dos');
  if (d.condicion_pago === 'plazo' && !d.dias_plazo) throw badRequest('Indicá los días de plazo');

  let compra: { total: number; proveedor_id: string; estado: string } | null = null;
  if (d.compra_id) {
    compra = await first(c.env.DB, 'SELECT total, proveedor_id, estado FROM compras WHERE taller_id = ? AND id = ?', s.tallerId, d.compra_id);
    if (!compra || compra.proveedor_id !== d.proveedor_id) throw badRequest('La compra no existe o es de otro proveedor');
    if (compra.estado !== 'registrada') throw conflict('La compra está anulada');
    if (!esNotaCredito(d.tipo) && (await first(c.env.DB, "SELECT 1 FROM facturas_proveedor WHERE taller_id = ? AND compra_id = ? AND estado = 'registrada' AND tipo NOT LIKE 'nota_credito%'", s.tallerId, d.compra_id))) {
      throw conflict('La compra ya tiene una factura asociada', 'duplicado');
    }
  }
  if (d.orden_compra_id) {
    const oc = await first<{ proveedor_id: string; estado: string }>(c.env.DB, 'SELECT proveedor_id, estado FROM ordenes_compra WHERE taller_id = ? AND id = ?', s.tallerId, d.orden_compra_id);
    if (!oc || oc.proveedor_id !== d.proveedor_id) throw badRequest('La orden de compra no existe o es de otro proveedor');
    if (!['parcial', 'recibida'].includes(oc.estado)) throw conflict('Sólo se factura una orden que ya recibió mercadería');
  }
  // Un mismo comprobante no puede estar cargado como compra directa y, a la vez, como factura independiente.
  if (!d.compra_id) {
    const docs = await all<{ id: string; numero: number; numero_doc: string }>(c.env.DB, "SELECT id, numero, numero_doc FROM compras WHERE taller_id = ? AND proveedor_id = ? AND estado = 'registrada' AND numero_doc IS NOT NULL", s.tallerId, d.proveedor_id);
    const dup = docs.find((x) => normalizarNroComprobante(x.numero_doc) === nro);
    if (dup && !esNotaCredito(d.tipo)) throw conflict(`La compra #${dup.numero} ya tiene cargado ese comprobante: asociá la factura a esa compra para no duplicar la deuda`, 'duplicado');
  }
  const cfg = await first<{ plazo: number }>(c.env.DB, 'SELECT plazo_pago_dias AS plazo FROM taller_config WHERE taller_id = ?', s.tallerId);
  const vencimiento = d.vencimiento ?? (d.condicion_pago === 'contado' ? d.fecha : sumarDias(d.fecha, d.condicion_pago === 'plazo' ? d.dias_plazo! : cfg?.plazo ?? 30));
  if (vencimiento < d.fecha) throw badRequest('El vencimiento no puede ser anterior a la fecha del comprobante');
  const id = uid();
  await c.env.DB.batch([
    ...seqIncrementar(c.env.DB, s.tallerId, 'factura_proveedor'),
    c.env.DB
      .prepare(
        `INSERT INTO facturas_proveedor (id, taller_id, numero, proveedor_id, tipo, nro_comprobante, fecha, cuit, neto_gravado, no_gravado, iva_21, iva_10_5, iva_27, otros_tributos, total,
                                          condicion_pago, dias_plazo, vencimiento, compra_id, orden_compra_id, notas, idem_key, created_by)
         VALUES (?, ?, ${SEQ_VALOR}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, s.tallerId, s.tallerId, 'factura_proveedor', d.proveedor_id, d.tipo, nro, d.fecha, cuit, d.neto_gravado, d.no_gravado, d.iva_21, d.iva_10_5, d.iva_27, d.otros_tributos, d.total, d.condicion_pago, d.dias_plazo ?? null, vencimiento, d.compra_id ?? null, d.orden_compra_id ?? null, d.notas, d.idem_key, s.usuarioId),
    ...(d.compra_id ? [guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM compras WHERE taller_id = ? AND id = ? AND estado = 'registrada')", s.tallerId, d.compra_id)] : []),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'factura_proveedor', id, 'crear', { total: d.total, nro, compra_id: d.compra_id ?? null }),
  ]);
  return c.json(
    { id, nro_comprobante: nro, vencimiento, genera_deuda: !d.compra_id || esNotaCredito(d.tipo), diferencia_con_compra: compra ? d.total - compra.total : null },
    201,
  );
});

abastecimiento.post('/facturas-proveedor/:id/anular', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const { motivo } = await body(c, z.object({ motivo: z.string().trim().min(3).max(300) }));
  const f = await first<{ estado: string }>(c.env.DB, 'SELECT estado FROM facturas_proveedor WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!f) throw notFound('Factura');
  if (f.estado !== 'registrada') throw conflict('La factura ya está anulada');
  await c.env.DB.batch([
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM facturas_proveedor WHERE taller_id = ? AND id = ? AND estado = 'registrada')", s.tallerId, id),
    c.env.DB.prepare("UPDATE facturas_proveedor SET estado = 'anulada', notas = COALESCE(notas || ' · ', '') || ? WHERE taller_id = ? AND id = ?").bind(`Anulada: ${motivo}`, s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'factura_proveedor', id, 'anular', { motivo }),
  ]);
  return c.json({ ok: true });
});

// ═════════════════════════ Deuda con proveedores ═════════════════════════
abastecimiento.get('/deuda-proveedores', async (c) => {
  const s = c.get('sesion');
  const deudas = await deudaProveedores(c.env.DB, s.tallerId);
  const provs = await all<{ id: string; nombre: string; cuit: string | null; telefono: string | null; activo: number }>(c.env.DB, 'SELECT id, nombre, cuit, telefono, activo FROM proveedores WHERE taller_id = ?', s.tallerId);
  return c.json(
    deudas
      .filter((d) => d.saldo !== 0)
      .map((d) => {
        const p = provs.find((x) => x.id === d.proveedor_id);
        return { proveedor_id: d.proveedor_id, proveedor: p?.nombre ?? '—', cuit: p?.cuit, telefono: p?.telefono, saldo: d.saldo, vencido: d.vencido, por_vencer: d.por_vencer, comprobantes: d.docs.length, proximo_vencimiento: d.docs.map((x) => x.vencimiento).sort()[0] ?? null };
      })
      .sort((a, b) => b.vencido - a.vencido || b.saldo - a.saldo),
  );
});

abastecimiento.get('/vencimientos-proveedores', async (c) => {
  const s = c.get('sesion');
  const { proveedor_id, solo_vencidos } = query(c, z.object({ proveedor_id: z.string().optional(), solo_vencidos: z.string().optional() }));
  const deudas = await deudaProveedores(c.env.DB, s.tallerId, proveedor_id);
  const provs = await all<{ id: string; nombre: string }>(c.env.DB, 'SELECT id, nombre FROM proveedores WHERE taller_id = ?', s.tallerId);
  const docs = deudas.flatMap((d) => d.docs).map((x) => ({ ...x, proveedor: provs.find((p) => p.id === x.proveedor_id)?.nombre ?? '—' }));
  return c.json(docs.filter((x) => !solo_vencidos || x.dias_atraso > 0).sort((a, b) => (a.vencimiento < b.vencimiento ? -1 : 1)));
});
