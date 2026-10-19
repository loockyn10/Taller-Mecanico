// Órdenes de trabajo: alta, edición, estados (con consumo/reposición de stock), check-list y comprobante.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, conflict, notFound, query, zFecha, zId, zTextoOpt } from '../lib/http';
import { all, auditar, first, guard, like, SEQ_VALOR, seqIncrementar, uid, type Stmt } from '../lib/db';
import { requirePerm } from '../lib/auth';
import { COLS_TOTALES, SET_TOTALES, sentenciasItems, totales, validarItems, valoresTotales, zItem, zParametrosTotales } from '../lib/documentos';
import { agrupar, permiteNegativo, sentenciasMovimiento, verificarDisponible } from '../lib/stock';
import { ESTADOS_OT, ESTADOS_OT_ABIERTOS, ESTADOS_OT_CON_STOCK, ESTADOS_OT_EDITABLES, ESTADO_OT_LABEL, TRANSICIONES_OT, normalizarPatente, type EstadoOT } from '../../shared/dominio';

export const ordenes = new Hono<AppEnv>();
ordenes.use('*', requirePerm('operacion'));

const SELECT = `SELECT o.*, c.nombre AS cliente, c.telefono AS cliente_telefono, v.patente, v.anio, ma.nombre AS marca, mo.nombre AS modelo,
    m.nombre AS mecanico, p.numero AS presupuesto_numero,
    ve.id AS venta_id, ve.numero AS venta_numero, ve.total AS venta_total, ve.cobrado AS venta_cobrado
  FROM ordenes o
  JOIN clientes c ON c.taller_id = o.taller_id AND c.id = o.cliente_id
  JOIN vehiculos v ON v.taller_id = o.taller_id AND v.id = o.vehiculo_id
  LEFT JOIN marcas ma ON ma.taller_id = v.taller_id AND ma.id = v.marca_id
  LEFT JOIN modelos mo ON mo.taller_id = v.taller_id AND mo.id = v.modelo_id
  LEFT JOIN mecanicos m ON m.taller_id = o.taller_id AND m.id = o.mecanico_id
  LEFT JOIN presupuestos p ON p.taller_id = o.taller_id AND p.id = o.presupuesto_id
  LEFT JOIN ventas ve ON ve.taller_id = o.taller_id AND ve.orden_id = o.id AND ve.estado = 'emitida'`;

const zOrden = zParametrosTotales.extend({
  cliente_id: zId,
  vehiculo_id: zId,
  mecanico_id: zId.nullish(),
  km_ingreso: z.number().int().min(0).max(5_000_000).nullish(),
  falla_reportada: zTextoOpt(2000),
  diagnostico: zTextoOpt(2000),
  observaciones: zTextoOpt(2000),
  fecha_prometida: zFecha.nullish(),
  turno_id: zId.nullish(),
  items: z.array(zItem).max(200).default([]),
});

async function validarCabecera(db: D1Database, tallerId: string, d: { cliente_id: string; vehiculo_id: string; mecanico_id?: string | null; km_ingreso?: number | null }, kmAnteriorPropio?: number | null) {
  const v = await first<{ cliente_id: string; km_actual: number }>(db, 'SELECT cliente_id, km_actual FROM vehiculos WHERE taller_id = ? AND id = ?', tallerId, d.vehiculo_id);
  if (!v) throw badRequest('Vehículo inexistente');
  if (v.cliente_id !== d.cliente_id) throw badRequest('El vehículo no pertenece al cliente');
  if (d.mecanico_id && !(await first(db, 'SELECT 1 FROM mecanicos WHERE taller_id = ? AND id = ? AND activo = 1', tallerId, d.mecanico_id))) throw badRequest('Mecánico inexistente o inactivo');
  // Regla observada en la referencia: el km de ingreso no puede ser menor al último registrado.
  const minimo = kmAnteriorPropio != null ? Math.min(v.km_actual, kmAnteriorPropio) : v.km_actual;
  if (d.km_ingreso != null && d.km_ingreso < minimo) throw badRequest(`El kilometraje no puede ser menor al último registrado (${v.km_actual} km)`);
}

ordenes.get('/', async (c) => {
  const s = c.get('sesion');
  const { estado, q, mecanico_id, desde, hasta, limite } = query(
    c,
    z.object({ estado: z.string().optional(), q: z.string().optional(), mecanico_id: z.string().optional(), desde: z.string().optional(), hasta: z.string().optional(), limite: z.coerce.number().int().min(1).max(500).default(300) }),
  );
  const cond = ['o.taller_id = ?'];
  const params: unknown[] = [s.tallerId];
  if (!estado || estado === 'abiertas') cond.push(`o.estado IN (${ESTADOS_OT_ABIERTOS.map(() => '?').join(',')})`), params.push(...ESTADOS_OT_ABIERTOS);
  else if (estado !== 'todas') (cond.push('o.estado = ?'), params.push(estado));
  if (q) (cond.push('(c.nombre LIKE ? OR v.patente LIKE ? OR CAST(o.numero AS TEXT) = ?)'), params.push(like(q), like(normalizarPatente(q) || q), q.replace(/\D/g, '')));
  if (mecanico_id) (cond.push('o.mecanico_id = ?'), params.push(mecanico_id));
  if (desde) (cond.push('o.fecha_ingreso >= ?'), params.push(desde));
  if (hasta) (cond.push('o.fecha_ingreso <= ?'), params.push(`${hasta}T23:59:59.999Z`));
  return c.json(await all(c.env.DB, `${SELECT} WHERE ${cond.join(' AND ')} ORDER BY o.numero DESC LIMIT ?`, ...params, limite));
});

ordenes.get('/:id', async (c) => {
  const s = c.get('sesion');
  const o = await first(c.env.DB, `${SELECT} WHERE o.taller_id = ? AND o.id = ?`, s.tallerId, c.req.param('id'));
  if (!o) throw notFound('Orden de trabajo');
  const [items, eventos, checklist] = await Promise.all([
    all(
      c.env.DB,
      `SELECT oi.*, a.stock AS articulo_stock, a.unidad FROM orden_items oi LEFT JOIN articulos a ON a.taller_id = oi.taller_id AND a.id = oi.articulo_id
        WHERE oi.taller_id = ? AND oi.orden_id = ? ORDER BY oi.orden`,
      s.tallerId,
      o.id,
    ),
    all(
      c.env.DB,
      `SELECT e.*, u.nombre AS usuario FROM orden_eventos e LEFT JOIN usuarios u ON u.id = e.usuario_id AND u.taller_id = e.taller_id
        WHERE e.taller_id = ? AND e.orden_id = ? ORDER BY e.created_at`,
      s.tallerId,
      o.id,
    ),
    first(c.env.DB, 'SELECT * FROM checklists WHERE taller_id = ? AND orden_id = ?', s.tallerId, o.id),
  ]);
  return c.json({ ...o, items, eventos, checklist: checklist ? { ...checklist, datos: JSON.parse(String(checklist.datos)) } : null });
});

ordenes.post('/', async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zOrden);
  await validarCabecera(c.env.DB, s.tallerId, d);
  if (d.turno_id && !(await first(c.env.DB, 'SELECT 1 FROM turnos WHERE taller_id = ? AND id = ? AND orden_id IS NULL', s.tallerId, d.turno_id))) {
    throw badRequest('Turno inexistente o ya vinculado a otra OT');
  }
  const items = await validarItems(c.env.DB, s.tallerId, d.items);
  const t = totales(items, d);
  const id = uid();
  const stmts: Stmt[] = [
    ...seqIncrementar(c.env.DB, s.tallerId, 'orden'),
    c.env.DB.prepare(
      `INSERT INTO ordenes (id, taller_id, numero, cliente_id, vehiculo_id, mecanico_id, km_ingreso, falla_reportada, diagnostico, observaciones, fecha_ingreso, fecha_prometida, created_by, ${COLS_TOTALES})
       VALUES (?, ?, ${SEQ_VALOR}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${COLS_TOTALES.split(',').map(() => '?').join(',')})`,
    ).bind(
      id, s.tallerId, s.tallerId, 'orden', d.cliente_id, d.vehiculo_id, d.mecanico_id ?? null, d.km_ingreso ?? null, d.falla_reportada, d.diagnostico, d.observaciones,
      new Date().toISOString(), d.fecha_prometida ?? null, s.usuarioId, ...valoresTotales(d, t),
    ),
    ...sentenciasItems(c.env.DB, 'orden_items', 'orden_id', s.tallerId, id, items, t.subtotales),
    c.env.DB.prepare("INSERT INTO orden_eventos (id, taller_id, orden_id, estado_nuevo, usuario_id) VALUES (?, ?, ?, 'recibida', ?)").bind(uid(), s.tallerId, id, s.usuarioId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'orden', id, 'crear', { total: t.total }),
  ];
  if (d.km_ingreso != null) stmts.push(c.env.DB.prepare('UPDATE vehiculos SET km_actual = MAX(km_actual, ?) WHERE taller_id = ? AND id = ?').bind(d.km_ingreso, s.tallerId, d.vehiculo_id));
  if (d.turno_id) {
    stmts.push(
      guard(c.env.DB, 'EXISTS (SELECT 1 FROM turnos WHERE taller_id = ? AND id = ? AND orden_id IS NOT NULL)', s.tallerId, d.turno_id),
      c.env.DB.prepare("UPDATE turnos SET orden_id = ?, estado = 'en_taller' WHERE taller_id = ? AND id = ?").bind(id, s.tallerId, d.turno_id),
    );
  }
  await c.env.DB.batch(stmts);
  return c.json(await first(c.env.DB, `${SELECT} WHERE o.taller_id = ? AND o.id = ?`, s.tallerId, id), 201);
});

/** Edición de cabecera e ítems. Solo en estados editables (el stock aún no fue descontado). Control optimista por versión. */
ordenes.put('/:id', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, zOrden.omit({ turno_id: true }).extend({ version: z.number().int().min(1) }));
  const o = await first<{ estado: EstadoOT; version: number; km_ingreso: number | null; vehiculo_id: string }>(
    c.env.DB,
    'SELECT estado, version, km_ingreso, vehiculo_id FROM ordenes WHERE taller_id = ? AND id = ?',
    s.tallerId,
    id,
  );
  if (!o) throw notFound('Orden de trabajo');
  if (!ESTADOS_OT_EDITABLES.includes(o.estado)) throw conflict(`No se puede editar una OT en estado "${ESTADO_OT_LABEL[o.estado]}". Volvela a "En reparación" para modificarla.`);
  if (o.version !== d.version) throw conflict('La OT fue modificada por otra persona. Recargá para ver los cambios.', 'version');
  await validarCabecera(c.env.DB, s.tallerId, d, o.vehiculo_id === d.vehiculo_id ? o.km_ingreso : null);
  const items = await validarItems(c.env.DB, s.tallerId, d.items);
  const t = totales(items, d);
  const stmts: Stmt[] = [
    guard(
      c.env.DB,
      `NOT EXISTS (SELECT 1 FROM ordenes WHERE taller_id = ? AND id = ? AND version = ? AND stock_aplicado = 0 AND estado IN (${ESTADOS_OT_EDITABLES.map(() => '?').join(',')}))`,
      s.tallerId, id, d.version, ...ESTADOS_OT_EDITABLES,
    ),
    c.env.DB.prepare(
      `UPDATE ordenes SET cliente_id = ?, vehiculo_id = ?, mecanico_id = ?, km_ingreso = ?, falla_reportada = ?, diagnostico = ?, observaciones = ?, fecha_prometida = ?,
              ${SET_TOTALES}, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ? AND id = ?`,
    ).bind(d.cliente_id, d.vehiculo_id, d.mecanico_id ?? null, d.km_ingreso ?? null, d.falla_reportada, d.diagnostico, d.observaciones, d.fecha_prometida ?? null, ...valoresTotales(d, t), s.tallerId, id),
    c.env.DB.prepare('DELETE FROM orden_items WHERE taller_id = ? AND orden_id = ?').bind(s.tallerId, id),
    ...sentenciasItems(c.env.DB, 'orden_items', 'orden_id', s.tallerId, id, items, t.subtotales),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'orden', id, 'modificar', { total: t.total }),
  ];
  if (d.km_ingreso != null) stmts.push(c.env.DB.prepare('UPDATE vehiculos SET km_actual = MAX(km_actual, ?) WHERE taller_id = ? AND id = ?').bind(d.km_ingreso, s.tallerId, d.vehiculo_id));
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

/**
 * Cambio de estado.
 *  - Al entrar en un estado con stock (lista/entregada) desde uno sin stock: descuenta los artículos (una sola vez: stock_aplicado 0→1).
 *  - Al volver a un estado sin stock: repone los artículos (stock_aplicado 1→0, version+1 para nuevas claves de idempotencia).
 *  - No se puede reabrir una OT con comprobante vigente (primero hay que anular el comprobante).
 */
ordenes.post('/:id/estado', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, z.object({ estado: z.enum(ESTADOS_OT), nota: zTextoOpt(500) }));
  const o = await first<{ estado: EstadoOT; stock_aplicado: number; version: number; numero: number; vehiculo_id: string }>(
    c.env.DB,
    'SELECT estado, stock_aplicado, version, numero, vehiculo_id FROM ordenes WHERE taller_id = ? AND id = ?',
    s.tallerId,
    id,
  );
  if (!o) throw notFound('Orden de trabajo');
  if (o.estado === d.estado) return c.json({ ok: true });
  if (!TRANSICIONES_OT[o.estado].includes(d.estado)) throw conflict(`No se puede pasar de "${ESTADO_OT_LABEL[o.estado]}" a "${ESTADO_OT_LABEL[d.estado]}"`);

  const conStockDestino = ESTADOS_OT_CON_STOCK.includes(d.estado);
  const aplicar = conStockDestino && !o.stock_aplicado;
  const reponer = !conStockDestino && !!o.stock_aplicado;

  if (reponer && (await first(c.env.DB, "SELECT 1 FROM ventas WHERE taller_id = ? AND orden_id = ? AND estado = 'emitida'", s.tallerId, id))) {
    throw conflict('La OT tiene un comprobante emitido. Anulá el comprobante antes de reabrirla o cancelarla.', 'tiene_comprobante');
  }

  const stmts: Stmt[] = [
    // La OT no cambió desde que la leímos (estado y versión): evita dobles transiciones concurrentes.
    guard(c.env.DB, 'NOT EXISTS (SELECT 1 FROM ordenes WHERE taller_id = ? AND id = ? AND estado = ? AND version = ? AND stock_aplicado = ?)', s.tallerId, id, o.estado, o.version, o.stock_aplicado),
  ];

  if (aplicar || reponer) {
    const items = await all<{ articulo_id: string | null; cantidad: number }>(c.env.DB, "SELECT articulo_id, cantidad FROM orden_items WHERE taller_id = ? AND orden_id = ? AND tipo = 'articulo'", s.tallerId, id);
    const porArticulo = agrupar(items);
    const negativo = await permiteNegativo(c.env.DB, s.tallerId);
    if (aplicar && !negativo) await verificarDisponible(c.env.DB, s.tallerId, porArticulo);
    for (const [articuloId, cant] of porArticulo) {
      stmts.push(
        ...sentenciasMovimiento(
          c.env.DB,
          s.tallerId,
          {
            articuloId,
            delta: aplicar ? -cant : cant,
            tipo: aplicar ? 'consumo_ot' : 'reverso_ot',
            origenTipo: 'orden',
            origenId: id,
            // Clave única por OT + ciclo (versión) + artículo + sentido: un reintento no duplica el movimiento.
            idemKey: `ot:${id}:v${o.version}:${aplicar ? 'consumo' : 'reverso'}:${articuloId}`,
            notas: `OT #${o.numero}`,
            usuarioId: s.usuarioId,
          },
          negativo || reponer,
        ),
      );
    }
  }

  const sets = ['estado = ?', "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')", 'version = version + 1'];
  const vals: unknown[] = [d.estado];
  if (aplicar) sets.push('stock_aplicado = 1');
  if (reponer) sets.push('stock_aplicado = 0');
  if (d.estado === 'lista') sets.push("fecha_lista = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  if (d.estado === 'entregada') sets.push("fecha_entregada = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  if (o.estado === 'entregada') sets.push('fecha_entregada = NULL');
  stmts.push(
    c.env.DB.prepare(`UPDATE ordenes SET ${sets.join(', ')} WHERE taller_id = ? AND id = ?`).bind(...vals, s.tallerId, id),
    c.env.DB.prepare('INSERT INTO orden_eventos (id, taller_id, orden_id, estado_anterior, estado_nuevo, nota, usuario_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(uid(), s.tallerId, id, o.estado, d.estado, d.nota, s.usuarioId),
  );
  if (d.estado === 'entregada') stmts.push(c.env.DB.prepare("UPDATE turnos SET estado = 'completado' WHERE taller_id = ? AND orden_id = ? AND estado IN ('agendado','confirmado','en_taller')").bind(s.tallerId, id));
  await c.env.DB.batch(stmts);
  return c.json({ ok: true, stock: aplicar ? 'descontado' : reponer ? 'repuesto' : 'sin_cambios' });
});

// ───── Check-list de ingreso ─────
const zChecklist = z.object({
  combustible: z.enum(['reserva', '1/4', '1/2', '3/4', 'lleno']).nullish(),
  km: z.number().int().min(0).max(5_000_000).nullish(),
  datos: z.object({
    danos: z.array(z.string().max(60)).max(30).default([]),
    testigos: z.array(z.string().max(60)).max(30).default([]),
    accesorios: z.array(z.string().max(60)).max(30).default([]),
    ingreso: z.string().max(60).nullish(),
    objetos_personales: z.string().max(500).nullish(),
  }),
  observaciones: zTextoOpt(2000),
  recibido_por: zTextoOpt(120),
});

ordenes.put('/:id/checklist', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, zChecklist);
  if (!(await first(c.env.DB, 'SELECT 1 FROM ordenes WHERE taller_id = ? AND id = ?', s.tallerId, id))) throw notFound('Orden de trabajo');
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO checklists (id, taller_id, orden_id, combustible, km, datos, observaciones, recibido_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (taller_id, orden_id) DO UPDATE SET combustible = excluded.combustible, km = excluded.km, datos = excluded.datos,
         observaciones = excluded.observaciones, recibido_por = excluded.recibido_por, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    ).bind(uid(), s.tallerId, id, d.combustible ?? null, d.km ?? null, JSON.stringify(d.datos), d.observaciones, d.recibido_por),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'orden', id, 'checklist'),
  ]);
  return c.json({ ok: true });
});

// ───── Comprobante interno desde la OT ─────
ordenes.post('/:id/comprobante', requirePerm('ventas.emitir'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, z.object({ condicion: z.enum(['contado', 'cuenta_corriente']).default('contado'), observaciones: zTextoOpt(500) }));
  const o = await first<{ estado: EstadoOT; total: number; numero: number }>(c.env.DB, 'SELECT estado, total, numero FROM ordenes WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!o) throw notFound('Orden de trabajo');
  if (!ESTADOS_OT_CON_STOCK.includes(o.estado)) throw conflict('El comprobante se genera cuando la OT está "Lista para entregar" o "Entregada"');
  if (await first(c.env.DB, "SELECT 1 FROM ventas WHERE taller_id = ? AND orden_id = ? AND estado = 'emitida'", s.tallerId, id)) throw conflict('La OT ya tiene un comprobante vigente', 'duplicado');
  const nItems = await first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM orden_items WHERE taller_id = ? AND orden_id = ?', s.tallerId, id);
  if (!nItems?.n) throw conflict('La OT no tiene ítems para facturar');
  const ventaId = uid();
  await c.env.DB.batch([
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM ordenes WHERE taller_id = ? AND id = ? AND estado IN ('lista','entregada'))", s.tallerId, id),
    ...seqIncrementar(c.env.DB, s.tallerId, 'venta'),
    // Copia los totales calculados de la OT: el comprobante refleja exactamente lo trabajado.
    c.env.DB.prepare(
      `INSERT INTO ventas (id, taller_id, numero, cliente_id, orden_id, fecha, condicion, observaciones, created_by, ${COLS_TOTALES})
       SELECT ?, taller_id, ${SEQ_VALOR}, cliente_id, id, date('now'), ?, ?, ?, ${COLS_TOTALES} FROM ordenes WHERE taller_id = ? AND id = ?`,
    ).bind(ventaId, s.tallerId, 'venta', d.condicion, d.observaciones ?? `OT #${o.numero}`, s.usuarioId, s.tallerId, id),
    c.env.DB.prepare(
      `INSERT INTO venta_items (id, taller_id, venta_id, orden, tipo, articulo_id, servicio_id, descripcion, cantidad, precio_unitario, desc_pct, alicuota_iva, subtotal)
       SELECT lower(hex(randomblob(16))), oi.taller_id, ?, oi.orden, oi.tipo, oi.articulo_id, oi.servicio_id, oi.descripcion, oi.cantidad, oi.precio_unitario, oi.desc_pct,
              COALESCE(a.alicuota_iva, 21), oi.subtotal
         FROM orden_items oi LEFT JOIN articulos a ON a.taller_id = oi.taller_id AND a.id = oi.articulo_id
        WHERE oi.taller_id = ? AND oi.orden_id = ?`,
    ).bind(ventaId, s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'venta', ventaId, 'crear_desde_ot', { orden_id: id }),
  ]);
  return c.json(await first(c.env.DB, 'SELECT id, numero, total FROM ventas WHERE taller_id = ? AND id = ?', s.tallerId, ventaId), 201);
});

// Resumen por estado para el tablero
ordenes.get('/resumen/estados', async (c) => {
  const s = c.get('sesion');
  return c.json(await all(c.env.DB, 'SELECT estado, COUNT(*) AS cantidad FROM ordenes WHERE taller_id = ? GROUP BY estado', s.tallerId));
});
