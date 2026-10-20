// Compras a proveedores (ingresan stock y actualizan costos), pagos a proveedores, cuenta corriente y reposición.
//
// Pago a proveedor → egreso de caja en el mismo batch (ver lib/caja.ts). Una compra "de contado" genera su pago en la misma
// transacción; al anular la compra se anula ese pago y su movimiento de caja.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, conflict, notFound, query, zCantidad, zCentavos, zFecha, zId, zTextoOpt } from '../lib/http';
import { all, auditar, first, guard, like, lotes, SEQ_VALOR, seqIncrementar, uid, type Stmt } from '../lib/db';
import { requirePerm } from '../lib/auth';
import { agrupar, permiteNegativo, sentenciasMovimiento, verificarDisponible } from '../lib/stock';
import { exigirCajaAbiertaSiCorresponde, guardCajaObligatoria, reversoDeOrigen, sentenciaMovimiento, sentenciaReversos } from '../lib/caja';
import { fechaComercial } from '../lib/fechas';
import { MEDIOS_PAGO, redondearCantidad } from '../../shared/dominio';

export const compras = new Hono<AppEnv>();
// Middleware acotado a las rutas propias: este router se monta en la raíz de /api.
for (const ruta of ['/compras', '/compras/*', '/pagos-proveedor', '/pagos-proveedor/*', '/proveedores/:id/cuenta']) compras.use(ruta, requirePerm('compras.gestionar'));

const SELECT = `SELECT co.*, p.nombre AS proveedor,
    (SELECT COALESCE(SUM(pp.importe),0) FROM pagos_proveedor pp WHERE pp.taller_id = co.taller_id AND pp.compra_id = co.id AND pp.estado = 'registrado') AS pagado_contado
  FROM compras co JOIN proveedores p ON p.taller_id = co.taller_id AND p.id = co.proveedor_id`;

compras.get('/compras', async (c) => {
  const s = c.get('sesion');
  const f = query(c, z.object({ proveedor_id: z.string().optional(), desde: z.string().optional(), hasta: z.string().optional(), estado: z.enum(['registrada', 'anulada']).optional(), q: z.string().optional() }));
  const cond = ['co.taller_id = ?'];
  const params: unknown[] = [s.tallerId];
  if (f.proveedor_id) (cond.push('co.proveedor_id = ?'), params.push(f.proveedor_id));
  if (f.desde) (cond.push('co.fecha >= ?'), params.push(f.desde));
  if (f.hasta) (cond.push('co.fecha <= ?'), params.push(f.hasta));
  if (f.estado) (cond.push('co.estado = ?'), params.push(f.estado));
  if (f.q) (cond.push('(p.nombre LIKE ? OR co.numero_doc LIKE ? OR CAST(co.numero AS TEXT) = ?)'), params.push(like(f.q), like(f.q), f.q.replace(/\D/g, '')));
  return c.json(await all(c.env.DB, `${SELECT} WHERE ${cond.join(' AND ')} ORDER BY co.numero DESC LIMIT 300`, ...params));
});

compras.get('/compras/:id', async (c) => {
  const s = c.get('sesion');
  const co = await first(c.env.DB, `${SELECT} WHERE co.taller_id = ? AND co.id = ?`, s.tallerId, c.req.param('id'));
  if (!co) throw notFound('Compra');
  const items = await all(
    c.env.DB,
    'SELECT ci.*, a.nombre AS articulo, a.codigo FROM compra_items ci JOIN articulos a ON a.taller_id = ci.taller_id AND a.id = ci.articulo_id WHERE ci.taller_id = ? AND ci.compra_id = ?',
    s.tallerId,
    co.id,
  );
  const pagos = await all(c.env.DB, 'SELECT id, numero, fecha, importe, medio, estado FROM pagos_proveedor WHERE taller_id = ? AND compra_id = ? ORDER BY numero', s.tallerId, co.id);
  return c.json({ ...co, items, pagos });
});

/** Saldo con el proveedor en SQL (compras vigentes − pagos vigentes). Parámetros: taller, proveedor, taller, proveedor. */
const SALDO_PROVEEDOR_SQL = `((SELECT COALESCE(SUM(total),0) FROM compras WHERE taller_id = ? AND proveedor_id = ? AND estado = 'registrada')
  - (SELECT COALESCE(SUM(importe),0) FROM pagos_proveedor WHERE taller_id = ? AND proveedor_id = ? AND estado = 'registrado'))`;

compras.post('/compras', async (c) => {
  const s = c.get('sesion');
  const d = await body(
    c,
    z.object({
      proveedor_id: zId,
      fecha: zFecha.optional(),
      tipo_doc: z.enum(['factura', 'remito', 'ticket', 'otro']).default('factura'),
      numero_doc: zTextoOpt(40),
      iva: zCentavos.default(0),
      otros: zCentavos.default(0),
      actualizar_costos: z.boolean().default(true),
      notas: zTextoOpt(500),
      items: z.array(z.object({ articulo_id: zId, cantidad: zCantidad, costo_unitario: zCentavos })).min(1).max(200),
      idem_key: z.string().min(8).max(80),
      // Compra de contado: se paga en el acto (total o parcialmente) y sale de la caja si es en efectivo.
      pago: z.object({ medio: z.enum(MEDIOS_PAGO), importe: zCentavos.optional(), referencia: zTextoOpt(120) }).nullish(),
    }),
  );
  const prov = await first<{ activo: number }>(c.env.DB, 'SELECT activo FROM proveedores WHERE taller_id = ? AND id = ?', s.tallerId, d.proveedor_id);
  if (!prov) throw badRequest('Proveedor inexistente');
  if (!prov.activo) throw badRequest('El proveedor está desactivado');
  const ids = d.items.map((i) => i.articulo_id);
  if (new Set(ids).size !== ids.length) throw badRequest('Hay artículos repetidos: sumá las cantidades en una sola línea');
  let existentes = 0;
  for (const lote of lotes(ids)) existentes += (await all(c.env.DB, `SELECT id FROM articulos WHERE taller_id = ? AND id IN (${lote.map(() => '?').join(',')})`, s.tallerId, ...lote)).length;
  if (existentes !== ids.length) throw badRequest('Hay artículos inexistentes');
  const fecha = fechaComercial(s, d.fecha);
  const subtotales = d.items.map((i) => Math.round(i.cantidad * i.costo_unitario));
  const neto = subtotales.reduce((a, b) => a + b, 0);
  const total = neto + d.iva + d.otros;
  const pagoImporte = d.pago ? (d.pago.importe ?? total) : 0;
  if (d.pago) {
    if (pagoImporte <= 0) throw badRequest('El importe del pago debe ser mayor a 0');
    if (pagoImporte > total) throw badRequest('El pago no puede superar el total de la compra');
    if (d.pago.medio === 'cheque' && !d.pago.referencia) throw badRequest('Indicá el número de cheque en la referencia');
    await exigirCajaAbiertaSiCorresponde(c.env.DB, s.tallerId);
  }
  const id = uid();
  const stmts: Stmt[] = [
    ...seqIncrementar(c.env.DB, s.tallerId, 'compra'),
    c.env.DB.prepare(
      `INSERT INTO compras (id, taller_id, numero, proveedor_id, fecha, tipo_doc, numero_doc, neto, iva, otros, total, actualizar_costos, notas, created_by)
       VALUES (?, ?, ${SEQ_VALOR}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, s.tallerId, s.tallerId, 'compra', d.proveedor_id, fecha, d.tipo_doc, d.numero_doc, neto, d.iva, d.otros, total, d.actualizar_costos ? 1 : 0, d.notas, s.usuarioId),
  ];
  d.items.forEach((it, i) => {
    // Se conserva el costo previo para poder revertirlo si la compra se anula.
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO compra_items (id, taller_id, compra_id, articulo_id, cantidad, costo_unitario, subtotal, costo_anterior, costo_aplicado)
         VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT costo FROM articulos WHERE taller_id = ? AND id = ?), ?)`,
      ).bind(uid(), s.tallerId, id, it.articulo_id, it.cantidad, it.costo_unitario, subtotales[i], s.tallerId, it.articulo_id, d.actualizar_costos ? 1 : 0),
    );
  });
  // Un movimiento por artículo (idempotente por compra).
  for (const [articuloId, cant] of agrupar(d.items)) {
    const costo = d.items.find((x) => x.articulo_id === articuloId)!.costo_unitario;
    stmts.push(
      ...sentenciasMovimiento(
        c.env.DB,
        s.tallerId,
        { articuloId, delta: cant, tipo: 'compra', origenTipo: 'compra', origenId: id, idemKey: `compra:${d.idem_key}:${articuloId}`, costoUnitario: costo, usuarioId: s.usuarioId },
        true,
      ),
    );
    if (d.actualizar_costos) stmts.push(c.env.DB.prepare('UPDATE articulos SET costo = ? WHERE taller_id = ? AND id = ?').bind(costo, s.tallerId, articuloId));
  }
  if (d.pago) {
    const pagoId = uid();
    stmts.push(
      guardCajaObligatoria(c.env.DB, s.tallerId),
      ...seqIncrementar(c.env.DB, s.tallerId, 'pago_proveedor'),
      c.env.DB.prepare(
        `INSERT INTO pagos_proveedor (id, taller_id, numero, proveedor_id, fecha, importe, medio, referencia, idem_key, notas, usuario_id, compra_id)
         VALUES (?, ?, ${SEQ_VALOR}, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(pagoId, s.tallerId, s.tallerId, 'pago_proveedor', d.proveedor_id, fecha, pagoImporte, d.pago.medio, d.pago.referencia, `compra:${d.idem_key}`, 'Pago de contado de la compra', s.usuarioId, id),
      sentenciaMovimiento(c.env.DB, s.tallerId, {
        tipo: 'egreso', rubro: 'pago_proveedor', medio: d.pago.medio, importe: pagoImporte, concepto: 'Pago de contado de compra', referencia: d.pago.referencia,
        origenTipo: 'pago_proveedor', origenId: pagoId, fecha, usuarioId: s.usuarioId,
      }),
    );
  }
  stmts.push(auditar(c.env.DB, s.tallerId, s.usuarioId, 'compra', id, 'crear', { total, pagado: pagoImporte }));
  await c.env.DB.batch(stmts);
  return c.json({ id }, 201);
});

compras.post('/compras/:id/anular', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const co = await first<{ estado: string; numero: number }>(c.env.DB, 'SELECT estado, numero FROM compras WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!co) throw notFound('Compra');
  if (co.estado !== 'registrada') throw conflict('La compra ya está anulada');
  const items = await all<{ articulo_id: string; cantidad: number }>(c.env.DB, 'SELECT articulo_id, cantidad FROM compra_items WHERE taller_id = ? AND compra_id = ?', s.tallerId, id);
  const porArticulo = agrupar(items);
  const negativo = await permiteNegativo(c.env.DB, s.tallerId);
  if (!negativo) await verificarDisponible(c.env.DB, s.tallerId, porArticulo);
  const conPago = !!(await first(c.env.DB, "SELECT 1 FROM pagos_proveedor WHERE taller_id = ? AND compra_id = ? AND estado = 'registrado'", s.tallerId, id));
  if (conPago) await exigirCajaAbiertaSiCorresponde(c.env.DB, s.tallerId);
  const stmts: Stmt[] = [
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM compras WHERE taller_id = ? AND id = ? AND estado = 'registrada')", s.tallerId, id),
    c.env.DB.prepare("UPDATE compras SET estado = 'anulada' WHERE taller_id = ? AND id = ?").bind(s.tallerId, id),
  ];
  for (const [articuloId, cant] of porArticulo) {
    stmts.push(
      ...sentenciasMovimiento(
        c.env.DB,
        s.tallerId,
        { articuloId, delta: -cant, tipo: 'anulacion_compra', origenTipo: 'compra', origenId: id, idemKey: `anulacion_compra:${id}:${articuloId}`, notas: `Anulación compra #${co.numero}`, usuarioId: s.usuarioId },
        negativo,
      ),
    );
  }
  // Costo: se restituye el anterior sólo si el artículo conserva el costo que fijó esta compra (si cambió después, no se pisa).
  stmts.push(
    c.env.DB.prepare(
      `UPDATE articulos SET costo = (SELECT ci.costo_anterior FROM compra_items ci WHERE ci.taller_id = articulos.taller_id AND ci.compra_id = ? AND ci.articulo_id = articulos.id)
        WHERE taller_id = ? AND id IN (
          SELECT ci.articulo_id FROM compra_items ci
           WHERE ci.taller_id = ? AND ci.compra_id = ? AND ci.costo_aplicado = 1 AND ci.costo_anterior IS NOT NULL
             AND ci.costo_unitario = (SELECT a2.costo FROM articulos a2 WHERE a2.taller_id = ci.taller_id AND a2.id = ci.articulo_id))`,
    ).bind(id, s.tallerId, s.tallerId, id),
  );
  if (conPago) {
    stmts.push(
      guardCajaObligatoria(c.env.DB, s.tallerId),
      // Se anula el pago de contado junto con la compra y su egreso de caja se revierte.
      sentenciaReversos(c.env.DB, s.tallerId, "m.origen_tipo = 'pago_proveedor' AND m.origen_id IN (SELECT id FROM pagos_proveedor WHERE taller_id = m.taller_id AND compra_id = ? AND estado = 'registrado')", [id], s.usuarioId),
      c.env.DB.prepare("UPDATE pagos_proveedor SET estado = 'anulado' WHERE taller_id = ? AND compra_id = ? AND estado = 'registrado'").bind(s.tallerId, id),
    );
  }
  stmts.push(auditar(c.env.DB, s.tallerId, s.usuarioId, 'compra', id, 'anular'));
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

// ───────────── Pagos a proveedores y cuenta corriente ─────────────
compras.get('/pagos-proveedor', async (c) => {
  const s = c.get('sesion');
  const f = query(c, z.object({ proveedor_id: z.string().optional(), desde: z.string().optional(), hasta: z.string().optional(), estado: z.enum(['registrado', 'anulado']).optional() }));
  const cond = ['pp.taller_id = ?'];
  const params: unknown[] = [s.tallerId];
  if (f.proveedor_id) (cond.push('pp.proveedor_id = ?'), params.push(f.proveedor_id));
  if (f.desde) (cond.push('pp.fecha >= ?'), params.push(f.desde));
  if (f.hasta) (cond.push('pp.fecha <= ?'), params.push(f.hasta));
  if (f.estado) (cond.push('pp.estado = ?'), params.push(f.estado));
  return c.json(
    await all(
      c.env.DB,
      `SELECT pp.*, p.nombre AS proveedor, u.nombre AS usuario FROM pagos_proveedor pp JOIN proveedores p ON p.taller_id = pp.taller_id AND p.id = pp.proveedor_id
         LEFT JOIN usuarios u ON u.taller_id = pp.taller_id AND u.id = pp.usuario_id
        WHERE ${cond.join(' AND ')} ORDER BY pp.numero DESC LIMIT 300`,
      ...params,
    ),
  );
});

compras.post('/pagos-proveedor', async (c) => {
  const s = c.get('sesion');
  const d = await body(
    c,
    z.object({
      proveedor_id: zId,
      fecha: zFecha.optional(),
      importe: zCentavos.refine((v) => v > 0, 'importe debe ser mayor a 0'),
      medio: z.enum(MEDIOS_PAGO),
      referencia: zTextoOpt(120),
      notas: zTextoOpt(500),
      idem_key: z.string().min(8).max(80),
      // Por defecto no se paga más que la deuda; el anticipo (saldo a favor) debe pedirse explícitamente.
      permitir_anticipo: z.boolean().default(false),
    }),
  );
  const previo = await first(c.env.DB, 'SELECT id, numero FROM pagos_proveedor WHERE taller_id = ? AND idem_key = ?', s.tallerId, d.idem_key);
  if (previo) return c.json({ ...previo, duplicado: true });
  if (!(await first(c.env.DB, 'SELECT 1 FROM proveedores WHERE taller_id = ? AND id = ?', s.tallerId, d.proveedor_id))) throw badRequest('Proveedor inexistente');
  if (d.medio === 'cheque' && !d.referencia) throw badRequest('Indicá el número de cheque en la referencia');
  const fecha = fechaComercial(s, d.fecha);
  if (!d.permitir_anticipo) {
    const saldo = (await first<{ v: number }>(c.env.DB, `SELECT ${SALDO_PROVEEDOR_SQL} AS v`, s.tallerId, d.proveedor_id, s.tallerId, d.proveedor_id))?.v ?? 0;
    if (d.importe > saldo) throw conflict(`El pago supera la deuda con el proveedor (saldo ${(saldo / 100).toLocaleString('es-AR')}). Para registrar un anticipo, confirmalo expresamente.`, 'saldo_excedido');
  }
  await exigirCajaAbiertaSiCorresponde(c.env.DB, s.tallerId);
  const id = uid();
  try {
    await c.env.DB.batch([
      guardCajaObligatoria(c.env.DB, s.tallerId),
      // Con concurrencia, otro pago pudo agotar la deuda entre la lectura y la escritura.
      ...(d.permitir_anticipo ? [] : [guard(c.env.DB, `${SALDO_PROVEEDOR_SQL} < ?`, s.tallerId, d.proveedor_id, s.tallerId, d.proveedor_id, d.importe)]),
      ...seqIncrementar(c.env.DB, s.tallerId, 'pago_proveedor'),
      c.env.DB.prepare(
        `INSERT INTO pagos_proveedor (id, taller_id, numero, proveedor_id, fecha, importe, medio, referencia, idem_key, notas, usuario_id) VALUES (?, ?, ${SEQ_VALOR}, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, s.tallerId, s.tallerId, 'pago_proveedor', d.proveedor_id, fecha, d.importe, d.medio, d.referencia, d.idem_key, d.notas, s.usuarioId),
      sentenciaMovimiento(c.env.DB, s.tallerId, {
        tipo: 'egreso', rubro: 'pago_proveedor', medio: d.medio, importe: d.importe, concepto: 'Pago a proveedor', referencia: d.referencia,
        origenTipo: 'pago_proveedor', origenId: id, fecha, usuarioId: s.usuarioId,
      }),
      auditar(c.env.DB, s.tallerId, s.usuarioId, 'pago_proveedor', id, 'crear', { importe: d.importe }),
    ]);
  } catch (e) {
    if (String(e).includes('idem_key')) {
      const ex = await first(c.env.DB, 'SELECT id, numero FROM pagos_proveedor WHERE taller_id = ? AND idem_key = ?', s.tallerId, d.idem_key);
      if (ex) return c.json({ ...ex, duplicado: true });
    }
    throw e;
  }
  return c.json({ id }, 201);
});

compras.post('/pagos-proveedor/:id/anular', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const { motivo } = await body(c, z.object({ motivo: z.string().trim().min(3).max(300) }));
  const p = await first<{ estado: string }>(c.env.DB, 'SELECT estado FROM pagos_proveedor WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!p) throw notFound('Pago');
  if (p.estado !== 'registrado') throw conflict('El pago ya está anulado');
  await exigirCajaAbiertaSiCorresponde(c.env.DB, s.tallerId);
  await c.env.DB.batch([
    guardCajaObligatoria(c.env.DB, s.tallerId),
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM pagos_proveedor WHERE taller_id = ? AND id = ? AND estado = 'registrado')", s.tallerId, id),
    c.env.DB.prepare("UPDATE pagos_proveedor SET estado = 'anulado', notas = COALESCE(notas || ' · ', '') || ? WHERE taller_id = ? AND id = ?").bind(`Anulado: ${motivo}`, s.tallerId, id),
    reversoDeOrigen(c.env.DB, s.tallerId, 'pago_proveedor', id, s.usuarioId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'pago_proveedor', id, 'anular', { motivo }),
  ]);
  return c.json({ ok: true });
});

compras.get('/proveedores/:id/cuenta', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const p = await first(c.env.DB, 'SELECT id, nombre, cuit, telefono, email, activo FROM proveedores WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!p) throw notFound('Proveedor');
  // Incluye anulados (marcados) para trazabilidad; el saldo corrido sólo cuenta los vigentes.
  const movs = await all<{ debe: number; haber: number; anulado: number }>(
    c.env.DB,
    `SELECT fecha, created_at, 'compra' AS tipo, id, numero, numero_doc AS detalle, 0 AS debe, total AS haber, (estado = 'anulada') AS anulado FROM compras WHERE taller_id = ? AND proveedor_id = ?
     UNION ALL
     SELECT fecha, created_at, 'pago' AS tipo, id, numero, medio AS detalle, importe AS debe, 0 AS haber, (estado = 'anulado') AS anulado FROM pagos_proveedor WHERE taller_id = ? AND proveedor_id = ?
     ORDER BY fecha, created_at`,
    s.tallerId, id, s.tallerId, id,
  );
  let saldo = 0;
  return c.json({
    proveedor: p,
    movimientos: movs.map((m) => {
      if (!m.anulado) saldo += m.haber - m.debe;
      return { ...m, saldo };
    }),
    saldo,
  });
});

// ───────────── Reposición ─────────────
/** Artículos en o por debajo del stock mínimo, con la cantidad sugerida para reponer y su proveedor habitual. */
compras.get('/reposicion', requirePerm('stock.ver'), async (c) => {
  const s = c.get('sesion');
  const { proveedor_id } = query(c, z.object({ proveedor_id: z.string().optional() }));
  const filas = await all<{ stock: number; stock_minimo: number; stock_objetivo: number | null }>(
    c.env.DB,
    `SELECT a.id, a.codigo, a.nombre, a.marca, a.unidad, a.stock, a.stock_minimo, a.stock_objetivo, a.costo, a.proveedor_id, p.nombre AS proveedor
       FROM articulos a LEFT JOIN proveedores p ON p.taller_id = a.taller_id AND p.id = a.proveedor_id
      WHERE a.taller_id = ? AND a.activo = 1 AND a.stock_minimo > 0 AND a.stock <= a.stock_minimo ${proveedor_id ? 'AND a.proveedor_id = ?' : ''}
      ORDER BY p.nombre COLLATE NOCASE, a.nombre COLLATE NOCASE LIMIT 500`,
    s.tallerId,
    ...(proveedor_id ? [proveedor_id] : []),
  );
  // Cantidad sugerida: hasta el stock ideal (si está definido) o hasta el doble del mínimo.
  return c.json(
    filas.map((a) => ({
      ...a,
      objetivo: a.stock_objetivo ?? redondearCantidad(a.stock_minimo * 2),
      sugerido: Math.max(0, redondearCantidad((a.stock_objetivo ?? a.stock_minimo * 2) - a.stock)),
    })),
  );
});
