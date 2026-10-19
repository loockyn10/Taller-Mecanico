// Compras a proveedores (ingresan stock y actualizan costos) y pagos a proveedores.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, conflict, notFound, query, zCentavos, zFecha, zId, zTextoOpt } from '../lib/http';
import { all, auditar, first, guard, hoy, SEQ_VALOR, seqIncrementar, uid, type Stmt } from '../lib/db';
import { requirePerm } from '../lib/auth';
import { agrupar, permiteNegativo, sentenciasMovimiento, verificarDisponible } from '../lib/stock';
import { MEDIOS_PAGO } from '../../shared/dominio';

export const compras = new Hono<AppEnv>();
// Middleware acotado a las rutas propias: este router se monta en la raíz de /api.
for (const ruta of ['/compras', '/compras/*', '/pagos-proveedor', '/pagos-proveedor/*', '/proveedores/:id/cuenta']) compras.use(ruta, requirePerm('compras.gestionar'));

const SELECT = `SELECT co.*, p.nombre AS proveedor FROM compras co JOIN proveedores p ON p.taller_id = co.taller_id AND p.id = co.proveedor_id`;

compras.get('/compras', async (c) => {
  const s = c.get('sesion');
  const { proveedor_id, desde, hasta } = query(c, z.object({ proveedor_id: z.string().optional(), desde: z.string().optional(), hasta: z.string().optional() }));
  const cond = ['co.taller_id = ?'];
  const params: unknown[] = [s.tallerId];
  if (proveedor_id) (cond.push('co.proveedor_id = ?'), params.push(proveedor_id));
  if (desde) (cond.push('co.fecha >= ?'), params.push(desde));
  if (hasta) (cond.push('co.fecha <= ?'), params.push(hasta));
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
  return c.json({ ...co, items });
});

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
      items: z.array(z.object({ articulo_id: zId, cantidad: z.number().positive().max(1e6), costo_unitario: zCentavos })).min(1).max(200),
      idem_key: z.string().min(8).max(80),
    }),
  );
  if (!(await first(c.env.DB, 'SELECT 1 FROM proveedores WHERE taller_id = ? AND id = ?', s.tallerId, d.proveedor_id))) throw badRequest('Proveedor inexistente');
  const ids = [...new Set(d.items.map((i) => i.articulo_id))];
  const ok = await all(c.env.DB, `SELECT id FROM articulos WHERE taller_id = ? AND id IN (${ids.map(() => '?').join(',')})`, s.tallerId, ...ids);
  if (ok.length !== ids.length) throw badRequest('Hay artículos inexistentes');
  const subtotales = d.items.map((i) => Math.round(i.cantidad * i.costo_unitario));
  const neto = subtotales.reduce((a, b) => a + b, 0);
  const id = uid();
  const stmts: Stmt[] = [
    ...seqIncrementar(c.env.DB, s.tallerId, 'compra'),
    c.env.DB.prepare(
      `INSERT INTO compras (id, taller_id, numero, proveedor_id, fecha, tipo_doc, numero_doc, neto, iva, otros, total, actualizar_costos, notas, created_by)
       VALUES (?, ?, ${SEQ_VALOR}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, s.tallerId, s.tallerId, 'compra', d.proveedor_id, d.fecha ?? hoy(), d.tipo_doc, d.numero_doc, neto, d.iva, d.otros, neto + d.iva + d.otros, d.actualizar_costos ? 1 : 0, d.notas, s.usuarioId),
  ];
  d.items.forEach((it, i) => {
    stmts.push(
      c.env.DB.prepare('INSERT INTO compra_items (id, taller_id, compra_id, articulo_id, cantidad, costo_unitario, subtotal) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(uid(), s.tallerId, id, it.articulo_id, it.cantidad, it.costo_unitario, subtotales[i]),
    );
  });
  // Un movimiento por artículo (idempotente por compra).
  for (const [articuloId, cant] of agrupar(d.items)) {
    const ultimoCosto = [...d.items].reverse().find((x) => x.articulo_id === articuloId)!.costo_unitario;
    stmts.push(
      ...sentenciasMovimiento(
        c.env.DB,
        s.tallerId,
        { articuloId, delta: cant, tipo: 'compra', origenTipo: 'compra', origenId: id, idemKey: `compra:${d.idem_key}:${articuloId}`, costoUnitario: ultimoCosto, usuarioId: s.usuarioId },
        true,
      ),
    );
    if (d.actualizar_costos) stmts.push(c.env.DB.prepare('UPDATE articulos SET costo = ? WHERE taller_id = ? AND id = ?').bind(ultimoCosto, s.tallerId, articuloId));
  }
  stmts.push(auditar(c.env.DB, s.tallerId, s.usuarioId, 'compra', id, 'crear', { total: neto + d.iva + d.otros }));
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
  stmts.push(auditar(c.env.DB, s.tallerId, s.usuarioId, 'compra', id, 'anular'));
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

// ───────────── Pagos a proveedores y cuenta corriente ─────────────
compras.get('/pagos-proveedor', async (c) => {
  const s = c.get('sesion');
  const { proveedor_id } = query(c, z.object({ proveedor_id: z.string().optional() }));
  return c.json(
    await all(
      c.env.DB,
      `SELECT pp.*, p.nombre AS proveedor FROM pagos_proveedor pp JOIN proveedores p ON p.taller_id = pp.taller_id AND p.id = pp.proveedor_id
        WHERE pp.taller_id = ? ${proveedor_id ? 'AND pp.proveedor_id = ?' : ''} ORDER BY pp.numero DESC LIMIT 300`,
      s.tallerId,
      ...(proveedor_id ? [proveedor_id] : []),
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
    }),
  );
  const previo = await first(c.env.DB, 'SELECT id, numero FROM pagos_proveedor WHERE taller_id = ? AND idem_key = ?', s.tallerId, d.idem_key);
  if (previo) return c.json({ ...previo, duplicado: true });
  if (!(await first(c.env.DB, 'SELECT 1 FROM proveedores WHERE taller_id = ? AND id = ?', s.tallerId, d.proveedor_id))) throw badRequest('Proveedor inexistente');
  const id = uid();
  await c.env.DB.batch([
    ...seqIncrementar(c.env.DB, s.tallerId, 'pago_proveedor'),
    c.env.DB.prepare(
      `INSERT INTO pagos_proveedor (id, taller_id, numero, proveedor_id, fecha, importe, medio, referencia, idem_key, notas, usuario_id) VALUES (?, ?, ${SEQ_VALOR}, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, s.tallerId, s.tallerId, 'pago_proveedor', d.proveedor_id, d.fecha ?? hoy(), d.importe, d.medio, d.referencia, d.idem_key, d.notas, s.usuarioId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'pago_proveedor', id, 'crear', { importe: d.importe }),
  ]);
  return c.json({ id }, 201);
});

compras.post('/pagos-proveedor/:id/anular', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const r = await c.env.DB.prepare("UPDATE pagos_proveedor SET estado = 'anulado' WHERE taller_id = ? AND id = ? AND estado = 'registrado'").bind(s.tallerId, id).run();
  if (!r.meta.changes) throw notFound('Pago vigente');
  await auditar(c.env.DB, s.tallerId, s.usuarioId, 'pago_proveedor', id, 'anular').run();
  return c.json({ ok: true });
});

compras.get('/proveedores/:id/cuenta', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const p = await first(c.env.DB, 'SELECT id, nombre, cuit FROM proveedores WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!p) throw notFound('Proveedor');
  const movs = await all<{ debe: number; haber: number }>(
    c.env.DB,
    `SELECT fecha, created_at, 'compra' AS tipo, id, numero, numero_doc AS detalle, 0 AS debe, total AS haber FROM compras WHERE taller_id = ? AND proveedor_id = ? AND estado = 'registrada'
     UNION ALL
     SELECT fecha, created_at, 'pago' AS tipo, id, numero, medio AS detalle, importe AS debe, 0 AS haber FROM pagos_proveedor WHERE taller_id = ? AND proveedor_id = ? AND estado = 'registrado'
     ORDER BY fecha, created_at`,
    s.tallerId, id, s.tallerId, id,
  );
  let saldo = 0;
  return c.json({ proveedor: p, movimientos: movs.map((m) => ((saldo += m.haber - m.debe), { ...m, saldo })), saldo });
});
