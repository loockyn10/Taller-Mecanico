// Ventas (comprobantes internos), cobros y cuentas corrientes de clientes.
//
// Separación fiscal: `ventas` son comprobantes INTERNOS (no fiscales). Cuando se integre ARCA, cada venta podrá
// tener un registro en `comprobantes_fiscales` (CAE, tipo, punto de venta) sin alterar ventas ni cobros.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, conflict, notFound, query, zCentavos, zFecha, zId, zTextoOpt } from '../lib/http';
import { all, auditar, first, guard, hoy, like, SEQ_VALOR, seqIncrementar, uid, type Stmt } from '../lib/db';
import { requirePerm } from '../lib/auth';
import { COLS_TOTALES, sentenciasItems, totales, validarItems, valoresTotales, zItem, zParametrosTotales } from '../lib/documentos';
import { agrupar, permiteNegativo, sentenciasMovimiento, verificarDisponible } from '../lib/stock';
import { MEDIOS_PAGO } from '../../shared/dominio';

export const comercial = new Hono<AppEnv>();

const SELECT_VENTA = `SELECT ve.*, c.nombre AS cliente, c.documento, c.condicion_iva AS cliente_condicion_iva, o.numero AS orden_numero,
    (ve.total - ve.cobrado) AS saldo,
    (SELECT cf.estado FROM comprobantes_fiscales cf WHERE cf.taller_id = ve.taller_id AND cf.venta_id = ve.id ORDER BY cf.created_at DESC LIMIT 1) AS estado_fiscal
  FROM ventas ve
  JOIN clientes c ON c.taller_id = ve.taller_id AND c.id = ve.cliente_id
  LEFT JOIN ordenes o ON o.taller_id = ve.taller_id AND o.id = ve.orden_id`;

// ───────────── Ventas ─────────────
comercial.get('/ventas', requirePerm('ventas.ver'), async (c) => {
  const s = c.get('sesion');
  const { q, cliente_id, desde, hasta, pendientes } = query(
    c,
    z.object({ q: z.string().optional(), cliente_id: z.string().optional(), desde: z.string().optional(), hasta: z.string().optional(), pendientes: z.string().optional() }),
  );
  const cond = ['ve.taller_id = ?'];
  const params: unknown[] = [s.tallerId];
  if (cliente_id) (cond.push('ve.cliente_id = ?'), params.push(cliente_id));
  if (q) (cond.push('(c.nombre LIKE ? OR CAST(ve.numero AS TEXT) = ?)'), params.push(like(q), q.replace(/\D/g, '')));
  if (desde) (cond.push('ve.fecha >= ?'), params.push(desde));
  if (hasta) (cond.push('ve.fecha <= ?'), params.push(hasta));
  if (pendientes) cond.push("ve.estado = 'emitida' AND ve.cobrado < ve.total");
  return c.json(await all(c.env.DB, `${SELECT_VENTA} WHERE ${cond.join(' AND ')} ORDER BY ve.numero DESC LIMIT 300`, ...params));
});

comercial.get('/ventas/:id', requirePerm('ventas.ver'), async (c) => {
  const s = c.get('sesion');
  const v = await first(c.env.DB, `${SELECT_VENTA} WHERE ve.taller_id = ? AND ve.id = ?`, s.tallerId, c.req.param('id'));
  if (!v) throw notFound('Comprobante');
  const items = await all(c.env.DB, 'SELECT * FROM venta_items WHERE taller_id = ? AND venta_id = ? ORDER BY orden', s.tallerId, v.id);
  const cobros = await all(
    c.env.DB,
    `SELECT co.id, co.numero, co.fecha, co.estado, ca.importe FROM cobro_aplicaciones ca JOIN cobros co ON co.taller_id = ca.taller_id AND co.id = ca.cobro_id
      WHERE ca.taller_id = ? AND ca.venta_id = ? ORDER BY co.fecha`,
    s.tallerId,
    v.id,
  );
  return c.json({ ...v, items, cobros, fiscal: { disponible: false, mensaje: 'Comprobante interno. La facturación electrónica ARCA todavía no está integrada.' } });
});

/** Venta de mostrador (sin OT): descuenta stock de los artículos vendidos. */
comercial.post('/ventas', requirePerm('ventas.emitir'), async (c) => {
  const s = c.get('sesion');
  const d = await body(
    c,
    zParametrosTotales.extend({
      cliente_id: zId.nullish(),
      fecha: zFecha.optional(),
      condicion: z.enum(['contado', 'cuenta_corriente']).default('contado'),
      observaciones: zTextoOpt(500),
      items: z.array(zItem).min(1).max(200),
      idem_key: z.string().min(8).max(80),
    }),
  );
  const previa = await first(c.env.DB, `${SELECT_VENTA} WHERE ve.taller_id = ? AND ve.idem_key = ?`, s.tallerId, d.idem_key);
  if (previa) return c.json({ ...previa, duplicado: true }, 200);
  let clienteId = d.cliente_id;
  if (!clienteId) {
    const cf = await first<{ id: string }>(c.env.DB, 'SELECT id FROM clientes WHERE taller_id = ? AND codigo = 0', s.tallerId);
    clienteId = cf!.id;
  } else if (!(await first(c.env.DB, 'SELECT 1 FROM clientes WHERE taller_id = ? AND id = ?', s.tallerId, clienteId))) {
    throw badRequest('Cliente inexistente');
  }
  const items = await validarItems(c.env.DB, s.tallerId, d.items);
  const t = totales(items, d);
  const porArticulo = agrupar(items.map((i) => ({ articulo_id: i.articulo_id ?? null, cantidad: i.cantidad })));
  const negativo = await permiteNegativo(c.env.DB, s.tallerId);
  if (!negativo) await verificarDisponible(c.env.DB, s.tallerId, porArticulo);
  const alicuotas = await alicuotasItems(c.env.DB, s.tallerId, items);
  const id = uid();
  const stmts: Stmt[] = [
    ...seqIncrementar(c.env.DB, s.tallerId, 'venta'),
    c.env.DB.prepare(
      `INSERT INTO ventas (id, taller_id, numero, cliente_id, fecha, condicion, observaciones, idem_key, created_by, ${COLS_TOTALES})
       VALUES (?, ?, ${SEQ_VALOR}, ?, ?, ?, ?, ?, ?, ${COLS_TOTALES.split(',').map(() => '?').join(',')})`,
    ).bind(id, s.tallerId, s.tallerId, 'venta', clienteId, d.fecha ?? hoy(), d.condicion, d.observaciones, d.idem_key, s.usuarioId, ...valoresTotales(d, t)),
    ...sentenciasItems(c.env.DB, 'venta_items', 'venta_id', s.tallerId, id, items, t.subtotales, alicuotas),
  ];
  for (const [articuloId, cant] of porArticulo) {
    stmts.push(
      ...sentenciasMovimiento(
        c.env.DB,
        s.tallerId,
        { articuloId, delta: -cant, tipo: 'venta', origenTipo: 'venta', origenId: id, idemKey: `venta:${d.idem_key}:${articuloId}`, usuarioId: s.usuarioId },
        negativo,
      ),
    );
  }
  stmts.push(auditar(c.env.DB, s.tallerId, s.usuarioId, 'venta', id, 'crear', { total: t.total }));
  await c.env.DB.batch(stmts);
  return c.json(await first(c.env.DB, `${SELECT_VENTA} WHERE ve.taller_id = ? AND ve.id = ?`, s.tallerId, id), 201);
});

async function alicuotasItems(db: D1Database, tallerId: string, items: Array<{ tipo: string; articulo_id?: string | null }>): Promise<number[]> {
  const ids = items.map((i) => i.articulo_id).filter(Boolean) as string[];
  const rows = ids.length ? await all<{ id: string; alicuota_iva: number }>(db, `SELECT id, alicuota_iva FROM articulos WHERE taller_id = ? AND id IN (${ids.map(() => '?').join(',')})`, tallerId, ...ids) : [];
  return items.map((i) => rows.find((r) => r.id === i.articulo_id)?.alicuota_iva ?? 21);
}

comercial.post('/ventas/:id/anular', requirePerm('ventas.anular'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const { motivo } = await body(c, z.object({ motivo: z.string().trim().min(3).max(300) }));
  const v = await first<{ estado: string; cobrado: number; orden_id: string | null; numero: number }>(
    c.env.DB,
    'SELECT estado, cobrado, orden_id, numero FROM ventas WHERE taller_id = ? AND id = ?',
    s.tallerId,
    id,
  );
  if (!v) throw notFound('Comprobante');
  if (v.estado !== 'emitida') throw conflict('El comprobante ya está anulado');
  if (v.cobrado > 0) throw conflict('El comprobante tiene cobros registrados. Anulá los cobros primero.');
  if (await first(c.env.DB, "SELECT 1 FROM comprobantes_fiscales WHERE taller_id = ? AND venta_id = ? AND estado = 'autorizado'", s.tallerId, id)) {
    throw conflict('El comprobante tiene una factura fiscal autorizada: requiere nota de crédito.');
  }
  const stmts: Stmt[] = [
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM ventas WHERE taller_id = ? AND id = ? AND estado = 'emitida' AND cobrado = 0)", s.tallerId, id),
    c.env.DB.prepare("UPDATE ventas SET estado = 'anulada', anulada_motivo = ? WHERE taller_id = ? AND id = ?").bind(motivo, s.tallerId, id),
  ];
  // Las ventas de mostrador devuelven el stock. Las ventas desde OT no movieron stock (lo movió la OT).
  if (!v.orden_id) {
    const items = await all<{ articulo_id: string | null; cantidad: number }>(c.env.DB, "SELECT articulo_id, cantidad FROM venta_items WHERE taller_id = ? AND venta_id = ? AND tipo = 'articulo'", s.tallerId, id);
    for (const [articuloId, cant] of agrupar(items)) {
      stmts.push(
        ...sentenciasMovimiento(
          c.env.DB,
          s.tallerId,
          { articuloId, delta: cant, tipo: 'anulacion_venta', origenTipo: 'venta', origenId: id, idemKey: `anulacion_venta:${id}:${articuloId}`, notas: `Anulación comprobante #${v.numero}`, usuarioId: s.usuarioId },
          true,
        ),
      );
    }
  }
  stmts.push(auditar(c.env.DB, s.tallerId, s.usuarioId, 'venta', id, 'anular', { motivo }));
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

// ───────────── Cobros ─────────────
const zCobro = z.object({
  cliente_id: zId,
  fecha: zFecha.optional(),
  medios: z.array(z.object({ medio: z.enum(MEDIOS_PAGO), importe: zCentavos.refine((v) => v > 0, 'importe debe ser mayor a 0'), referencia: zTextoOpt(120) })).min(1).max(10),
  aplicaciones: z.array(z.object({ venta_id: zId, importe: zCentavos.refine((v) => v > 0, 'importe debe ser mayor a 0') })).min(1).max(50),
  notas: zTextoOpt(500),
  idem_key: z.string().min(8).max(80),
});

const SELECT_COBRO = `SELECT co.*, c.nombre AS cliente, u.nombre AS usuario FROM cobros co
  JOIN clientes c ON c.taller_id = co.taller_id AND c.id = co.cliente_id
  LEFT JOIN usuarios u ON u.id = co.usuario_id AND u.taller_id = co.taller_id`;

comercial.get('/cobros', requirePerm('ventas.ver'), async (c) => {
  const s = c.get('sesion');
  const { cliente_id, desde, hasta } = query(c, z.object({ cliente_id: z.string().optional(), desde: z.string().optional(), hasta: z.string().optional() }));
  const cond = ['co.taller_id = ?'];
  const params: unknown[] = [s.tallerId];
  if (cliente_id) (cond.push('co.cliente_id = ?'), params.push(cliente_id));
  if (desde) (cond.push('co.fecha >= ?'), params.push(desde));
  if (hasta) (cond.push('co.fecha <= ?'), params.push(hasta));
  const cobros = await all<{ id: string }>(c.env.DB, `${SELECT_COBRO} WHERE ${cond.join(' AND ')} ORDER BY co.numero DESC LIMIT 300`, ...params);
  const medios = cobros.length
    ? await all<{ cobro_id: string }>(c.env.DB, `SELECT cobro_id, medio, importe, referencia FROM cobro_medios WHERE taller_id = ? AND cobro_id IN (${cobros.map(() => '?').join(',')})`, s.tallerId, ...cobros.map((x) => x.id))
    : [];
  return c.json(cobros.map((co) => ({ ...co, medios: medios.filter((m) => m.cobro_id === co.id) })));
});

comercial.get('/cobros/:id', requirePerm('ventas.ver'), async (c) => {
  const s = c.get('sesion');
  const co = await first(c.env.DB, `${SELECT_COBRO} WHERE co.taller_id = ? AND co.id = ?`, s.tallerId, c.req.param('id'));
  if (!co) throw notFound('Cobro');
  const medios = await all(c.env.DB, 'SELECT medio, importe, referencia FROM cobro_medios WHERE taller_id = ? AND cobro_id = ?', s.tallerId, co.id);
  const aplicaciones = await all(
    c.env.DB,
    `SELECT ca.venta_id, ca.importe, ve.numero, ve.total, o.numero AS orden_numero FROM cobro_aplicaciones ca
       JOIN ventas ve ON ve.taller_id = ca.taller_id AND ve.id = ca.venta_id LEFT JOIN ordenes o ON o.taller_id = ve.taller_id AND o.id = ve.orden_id
      WHERE ca.taller_id = ? AND ca.cobro_id = ?`,
    s.tallerId,
    co.id,
  );
  return c.json({ ...co, medios, aplicaciones });
});

/**
 * Registra un cobro aplicado a uno o más comprobantes.
 * Protección contra duplicados: idem_key única por taller (un doble clic o reintento devuelve el cobro ya registrado)
 * y CHECK (cobrado <= total) en ventas: es imposible cobrar más que el saldo, incluso con solicitudes concurrentes.
 */
comercial.post('/cobros', requirePerm('cobros.registrar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zCobro);
  const previo = await first(c.env.DB, 'SELECT id, numero FROM cobros WHERE taller_id = ? AND idem_key = ?', s.tallerId, d.idem_key);
  if (previo) return c.json({ ...previo, duplicado: true }, 200);

  const total = d.medios.reduce((a, m) => a + m.importe, 0);
  const aplicado = d.aplicaciones.reduce((a, m) => a + m.importe, 0);
  if (total !== aplicado) throw badRequest('La suma de los medios de pago debe coincidir con el importe aplicado a los comprobantes');
  const ventaIds = d.aplicaciones.map((a) => a.venta_id);
  if (new Set(ventaIds).size !== ventaIds.length) throw badRequest('Un comprobante aparece más de una vez');
  const ventas = await all<{ id: string; cliente_id: string; estado: string; total: number; cobrado: number; numero: number }>(
    c.env.DB,
    `SELECT id, cliente_id, estado, total, cobrado, numero FROM ventas WHERE taller_id = ? AND id IN (${ventaIds.map(() => '?').join(',')})`,
    s.tallerId,
    ...ventaIds,
  );
  if (ventas.length !== ventaIds.length) throw badRequest('Hay comprobantes inexistentes');
  for (const a of d.aplicaciones) {
    const v = ventas.find((x) => x.id === a.venta_id)!;
    if (v.cliente_id !== d.cliente_id) throw badRequest(`El comprobante #${v.numero} no pertenece al cliente`);
    if (v.estado !== 'emitida') throw conflict(`El comprobante #${v.numero} está anulado`);
    if (a.importe > v.total - v.cobrado) throw conflict(`El importe supera el saldo del comprobante #${v.numero} (${(v.total - v.cobrado) / 100})`, 'saldo_excedido');
  }
  const id = uid();
  const stmts: Stmt[] = [
    ...seqIncrementar(c.env.DB, s.tallerId, 'cobro'),
    c.env.DB.prepare(`INSERT INTO cobros (id, taller_id, numero, cliente_id, fecha, total, idem_key, notas, usuario_id) VALUES (?, ?, ${SEQ_VALOR}, ?, ?, ?, ?, ?, ?)`)
      .bind(id, s.tallerId, s.tallerId, 'cobro', d.cliente_id, d.fecha ?? hoy(), total, d.idem_key, d.notas, s.usuarioId),
    ...d.medios.map((m) =>
      c.env.DB.prepare('INSERT INTO cobro_medios (id, taller_id, cobro_id, medio, importe, referencia) VALUES (?, ?, ?, ?, ?, ?)').bind(uid(), s.tallerId, id, m.medio, m.importe, m.referencia),
    ),
  ];
  for (const a of d.aplicaciones) {
    stmts.push(
      guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM ventas WHERE taller_id = ? AND id = ? AND estado = 'emitida')", s.tallerId, a.venta_id),
      c.env.DB.prepare('INSERT INTO cobro_aplicaciones (id, taller_id, cobro_id, venta_id, importe) VALUES (?, ?, ?, ?, ?)').bind(uid(), s.tallerId, id, a.venta_id, a.importe),
      // El CHECK (cobrado <= total) aborta el batch si el saldo cambió entre la validación y la escritura.
      c.env.DB.prepare('UPDATE ventas SET cobrado = cobrado + ? WHERE taller_id = ? AND id = ?').bind(a.importe, s.tallerId, a.venta_id),
    );
  }
  stmts.push(auditar(c.env.DB, s.tallerId, s.usuarioId, 'cobro', id, 'crear', { total }));
  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    // Carrera con un reintento idéntico: devolver el cobro existente.
    if (String(e).includes('idem_key')) {
      const ex = await first(c.env.DB, 'SELECT id, numero FROM cobros WHERE taller_id = ? AND idem_key = ?', s.tallerId, d.idem_key);
      if (ex) return c.json({ ...ex, duplicado: true }, 200);
    }
    throw e;
  }
  return c.json(await first(c.env.DB, 'SELECT id, numero, total FROM cobros WHERE taller_id = ? AND id = ?', s.tallerId, id), 201);
});

comercial.post('/cobros/:id/anular', requirePerm('cobros.anular'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const { motivo } = await body(c, z.object({ motivo: z.string().trim().min(3).max(300) }));
  const co = await first<{ estado: string }>(c.env.DB, 'SELECT estado FROM cobros WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!co) throw notFound('Cobro');
  if (co.estado !== 'registrado') throw conflict('El cobro ya está anulado');
  const aps = await all<{ venta_id: string; importe: number }>(c.env.DB, 'SELECT venta_id, importe FROM cobro_aplicaciones WHERE taller_id = ? AND cobro_id = ?', s.tallerId, id);
  await c.env.DB.batch([
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM cobros WHERE taller_id = ? AND id = ? AND estado = 'registrado')", s.tallerId, id),
    c.env.DB.prepare("UPDATE cobros SET estado = 'anulado', anulado_motivo = ? WHERE taller_id = ? AND id = ?").bind(motivo, s.tallerId, id),
    ...aps.map((a) => c.env.DB.prepare('UPDATE ventas SET cobrado = cobrado - ? WHERE taller_id = ? AND id = ?').bind(a.importe, s.tallerId, a.venta_id)),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'cobro', id, 'anular', { motivo }),
  ]);
  return c.json({ ok: true });
});

// ───────────── Cuentas corrientes ─────────────
comercial.get('/cuentas-corrientes', requirePerm('ventas.ver'), async (c) => {
  const s = c.get('sesion');
  return c.json(
    await all(
      c.env.DB,
      `SELECT c.id, c.codigo, c.nombre, c.telefono, SUM(ve.total) AS facturado, SUM(ve.cobrado) AS cobrado, SUM(ve.total - ve.cobrado) AS saldo,
              COUNT(*) AS comprobantes, MIN(CASE WHEN ve.cobrado < ve.total THEN ve.fecha END) AS deuda_desde
         FROM ventas ve JOIN clientes c ON c.taller_id = ve.taller_id AND c.id = ve.cliente_id
        WHERE ve.taller_id = ? AND ve.estado = 'emitida'
        GROUP BY c.id HAVING saldo > 0 ORDER BY saldo DESC`,
      s.tallerId,
    ),
  );
});

comercial.get('/cuentas-corrientes/:clienteId', requirePerm('ventas.ver'), async (c) => {
  const s = c.get('sesion');
  const clienteId = c.req.param('clienteId');
  const cli = await first(c.env.DB, 'SELECT id, codigo, nombre, telefono, documento FROM clientes WHERE taller_id = ? AND id = ?', s.tallerId, clienteId);
  if (!cli) throw notFound('Cliente');
  const movs = await all<{ fecha: string; debe: number; haber: number }>(
    c.env.DB,
    `SELECT fecha, created_at, 'venta' AS tipo, id, numero, total AS debe, 0 AS haber, NULL AS detalle FROM ventas WHERE taller_id = ? AND cliente_id = ? AND estado = 'emitida'
     UNION ALL
     SELECT fecha, created_at, 'cobro' AS tipo, id, numero, 0 AS debe, total AS haber, notas AS detalle FROM cobros WHERE taller_id = ? AND cliente_id = ? AND estado = 'registrado'
     ORDER BY fecha, created_at`,
    s.tallerId, clienteId, s.tallerId, clienteId,
  );
  let saldo = 0;
  const conSaldo = movs.map((m) => ((saldo += m.debe - m.haber), { ...m, saldo }));
  const pendientes = await all(c.env.DB, `${SELECT_VENTA} WHERE ve.taller_id = ? AND ve.cliente_id = ? AND ve.estado = 'emitida' AND ve.cobrado < ve.total ORDER BY ve.fecha`, s.tallerId, clienteId);
  return c.json({ cliente: cli, movimientos: conSaldo, saldo, pendientes });
});
