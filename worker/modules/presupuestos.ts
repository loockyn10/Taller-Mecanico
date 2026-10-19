// Presupuestos y conversión a orden de trabajo.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, conflict, notFound, query, zFecha, zId, zTextoOpt } from '../lib/http';
import { all, auditar, first, guard, hoy, like, SEQ_VALOR, seqIncrementar, uid } from '../lib/db';
import { requirePerm } from '../lib/auth';
import { COLS_TOTALES, SET_TOTALES, sentenciasItems, totales, validarItems, valoresTotales, zItem, zParametrosTotales } from '../lib/documentos';
import { normalizarPatente } from '../../shared/dominio';

export const presupuestos = new Hono<AppEnv>();
presupuestos.use('*', requirePerm('operacion'));

const zPresupuesto = zParametrosTotales.extend({
  cliente_id: zId,
  vehiculo_id: zId,
  fecha: zFecha.optional(),
  valido_hasta: zFecha.nullish(),
  km: z.number().int().min(0).max(5_000_000).nullish(),
  observaciones: zTextoOpt(2000),
  items: z.array(zItem).min(1, 'el presupuesto debe tener al menos un ítem').max(200),
});

const SELECT = `SELECT p.*, c.nombre AS cliente, c.telefono AS cliente_telefono, v.patente, ma.nombre AS marca, mo.nombre AS modelo,
    o.numero AS orden_numero,
    CASE WHEN p.estado IN ('pendiente','aprobado') AND p.valido_hasta IS NOT NULL AND p.valido_hasta < date('now', '-3 hours') THEN 1 ELSE 0 END AS vencido
  FROM presupuestos p
  JOIN clientes c ON c.taller_id = p.taller_id AND c.id = p.cliente_id
  JOIN vehiculos v ON v.taller_id = p.taller_id AND v.id = p.vehiculo_id
  LEFT JOIN marcas ma ON ma.taller_id = v.taller_id AND ma.id = v.marca_id
  LEFT JOIN modelos mo ON mo.taller_id = v.taller_id AND mo.id = v.modelo_id
  LEFT JOIN ordenes o ON o.taller_id = p.taller_id AND o.id = p.orden_id`;

async function validarClienteVehiculo(db: D1Database, tallerId: string, clienteId: string, vehiculoId: string) {
  const v = await first<{ cliente_id: string }>(db, 'SELECT cliente_id FROM vehiculos WHERE taller_id = ? AND id = ?', tallerId, vehiculoId);
  if (!v) throw badRequest('Vehículo inexistente');
  if (v.cliente_id !== clienteId) throw badRequest('El vehículo no pertenece al cliente');
}

presupuestos.get('/', async (c) => {
  const s = c.get('sesion');
  const { estado, q, desde, hasta } = query(c, z.object({ estado: z.string().optional(), q: z.string().optional(), desde: z.string().optional(), hasta: z.string().optional() }));
  const cond = ['p.taller_id = ?'];
  const params: unknown[] = [s.tallerId];
  if (estado === 'vencido') cond.push("p.estado IN ('pendiente','aprobado') AND p.valido_hasta < date('now', '-3 hours')");
  else if (estado) (cond.push('p.estado = ?'), params.push(estado));
  if (q) (cond.push('(c.nombre LIKE ? OR v.patente LIKE ? OR CAST(p.numero AS TEXT) = ?)'), params.push(like(q), like(normalizarPatente(q) || q), q.replace(/\D/g, '')));
  if (desde) (cond.push('p.fecha >= ?'), params.push(desde));
  if (hasta) (cond.push('p.fecha <= ?'), params.push(hasta));
  return c.json(await all(c.env.DB, `${SELECT} WHERE ${cond.join(' AND ')} ORDER BY p.numero DESC LIMIT 300`, ...params));
});

presupuestos.get('/:id', async (c) => {
  const s = c.get('sesion');
  const p = await first(c.env.DB, `${SELECT} WHERE p.taller_id = ? AND p.id = ?`, s.tallerId, c.req.param('id'));
  if (!p) throw notFound('Presupuesto');
  const items = await all(c.env.DB, 'SELECT * FROM presupuesto_items WHERE taller_id = ? AND presupuesto_id = ? ORDER BY orden', s.tallerId, p.id);
  return c.json({ ...p, items });
});

presupuestos.post('/', async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zPresupuesto);
  await validarClienteVehiculo(c.env.DB, s.tallerId, d.cliente_id, d.vehiculo_id);
  const items = await validarItems(c.env.DB, s.tallerId, d.items);
  const t = totales(items, d);
  const cfg = await first<{ validez_presupuesto_dias: number }>(c.env.DB, 'SELECT validez_presupuesto_dias FROM taller_config WHERE taller_id = ?', s.tallerId);
  const fecha = d.fecha ?? hoy();
  const valido = d.valido_hasta ?? new Date(Date.parse(fecha) + (cfg?.validez_presupuesto_dias ?? 15) * 86400_000).toISOString().slice(0, 10);
  const id = uid();
  await c.env.DB.batch([
    ...seqIncrementar(c.env.DB, s.tallerId, 'presupuesto'),
    c.env.DB.prepare(
      `INSERT INTO presupuestos (id, taller_id, numero, cliente_id, vehiculo_id, fecha, valido_hasta, km, observaciones, created_by, ${COLS_TOTALES})
       VALUES (?, ?, ${SEQ_VALOR}, ?, ?, ?, ?, ?, ?, ?, ${COLS_TOTALES.split(',').map(() => '?').join(',')})`,
    ).bind(id, s.tallerId, s.tallerId, 'presupuesto', d.cliente_id, d.vehiculo_id, fecha, valido, d.km ?? null, d.observaciones, s.usuarioId, ...valoresTotales(d, t)),
    ...sentenciasItems(c.env.DB, 'presupuesto_items', 'presupuesto_id', s.tallerId, id, items, t.subtotales),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'presupuesto', id, 'crear', { total: t.total }),
  ]);
  return c.json(await first(c.env.DB, `${SELECT} WHERE p.taller_id = ? AND p.id = ?`, s.tallerId, id), 201);
});

presupuestos.put('/:id', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, zPresupuesto);
  const p = await first<{ estado: string }>(c.env.DB, 'SELECT estado FROM presupuestos WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!p) throw notFound('Presupuesto');
  if (p.estado !== 'pendiente') throw conflict('Solo se pueden editar presupuestos pendientes');
  await validarClienteVehiculo(c.env.DB, s.tallerId, d.cliente_id, d.vehiculo_id);
  const items = await validarItems(c.env.DB, s.tallerId, d.items);
  const t = totales(items, d);
  await c.env.DB.batch([
    guard(c.env.DB, "(SELECT estado FROM presupuestos WHERE taller_id = ? AND id = ?) <> 'pendiente'", s.tallerId, id),
    c.env.DB.prepare(
      `UPDATE presupuestos SET cliente_id = ?, vehiculo_id = ?, fecha = COALESCE(?, fecha), valido_hasta = ?, km = ?, observaciones = ?, ${SET_TOTALES},
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ? AND id = ?`,
    ).bind(d.cliente_id, d.vehiculo_id, d.fecha ?? null, d.valido_hasta ?? null, d.km ?? null, d.observaciones, ...valoresTotales(d, t), s.tallerId, id),
    c.env.DB.prepare('DELETE FROM presupuesto_items WHERE taller_id = ? AND presupuesto_id = ?').bind(s.tallerId, id),
    ...sentenciasItems(c.env.DB, 'presupuesto_items', 'presupuesto_id', s.tallerId, id, items, t.subtotales),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'presupuesto', id, 'modificar', { total: t.total }),
  ]);
  return c.json({ ok: true });
});

const TRANSICIONES: Record<string, string[]> = {
  pendiente: ['aprobado', 'rechazado', 'anulado'],
  aprobado: ['pendiente', 'rechazado', 'anulado'],
  rechazado: ['pendiente', 'anulado'],
  convertido: [],
  anulado: [],
};

presupuestos.post('/:id/estado', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const { estado } = await body(c, z.object({ estado: z.enum(['pendiente', 'aprobado', 'rechazado', 'anulado']) }));
  const p = await first<{ estado: string }>(c.env.DB, 'SELECT estado FROM presupuestos WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!p) throw notFound('Presupuesto');
  if (!TRANSICIONES[p.estado]?.includes(estado)) throw conflict(`No se puede pasar de "${p.estado}" a "${estado}"`);
  await c.env.DB.batch([
    guard(c.env.DB, '(SELECT estado FROM presupuestos WHERE taller_id = ? AND id = ?) <> ?', s.tallerId, id, p.estado),
    c.env.DB.prepare("UPDATE presupuestos SET estado = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ? AND id = ?").bind(estado, s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'presupuesto', id, 'estado', { de: p.estado, a: estado }),
  ]);
  return c.json({ ok: true });
});

/** Convierte el presupuesto en OT copiando cliente, vehículo, ítems y condiciones. Atómico e irrepetible. */
presupuestos.post('/:id/convertir', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, z.object({ mecanico_id: zId.nullish(), fecha_prometida: zFecha.nullish(), km_ingreso: z.number().int().min(0).nullish() }));
  const p = await first<Record<string, unknown> & { estado: string; vehiculo_id: string; cliente_id: string; km: number | null }>(
    c.env.DB,
    'SELECT * FROM presupuestos WHERE taller_id = ? AND id = ?',
    s.tallerId,
    id,
  );
  if (!p) throw notFound('Presupuesto');
  if (!['pendiente', 'aprobado'].includes(p.estado)) throw conflict(p.estado === 'convertido' ? 'El presupuesto ya fue convertido en OT' : `Un presupuesto ${p.estado} no se puede convertir`);
  if (d.mecanico_id && !(await first(c.env.DB, 'SELECT 1 FROM mecanicos WHERE taller_id = ? AND id = ?', s.tallerId, d.mecanico_id))) throw badRequest('Mecánico inexistente');
  const veh = await first<{ km_actual: number }>(c.env.DB, 'SELECT km_actual FROM vehiculos WHERE taller_id = ? AND id = ?', s.tallerId, p.vehiculo_id);
  const km = d.km_ingreso ?? p.km ?? null;
  if (km != null && veh && km < veh.km_actual) throw badRequest(`El kilometraje no puede ser menor al último registrado (${veh.km_actual} km)`);
  const ordenId = uid();
  await c.env.DB.batch([
    guard(c.env.DB, "(SELECT estado FROM presupuestos WHERE taller_id = ? AND id = ?) NOT IN ('pendiente','aprobado')", s.tallerId, id),
    ...seqIncrementar(c.env.DB, s.tallerId, 'orden'),
    c.env.DB.prepare(
      `INSERT INTO ordenes (id, taller_id, numero, cliente_id, vehiculo_id, presupuesto_id, mecanico_id, km_ingreso, observaciones, fecha_ingreso, fecha_prometida, created_by, ${COLS_TOTALES})
       SELECT ?, taller_id, ${SEQ_VALOR}, cliente_id, vehiculo_id, id, ?, ?, observaciones, ?, ?, ?, ${COLS_TOTALES}
         FROM presupuestos WHERE taller_id = ? AND id = ?`,
    ).bind(ordenId, s.tallerId, 'orden', d.mecanico_id ?? null, km, new Date().toISOString(), d.fecha_prometida ?? null, s.usuarioId, s.tallerId, id),
    c.env.DB.prepare(
      `INSERT INTO orden_items (id, taller_id, orden_id, orden, tipo, articulo_id, servicio_id, descripcion, cantidad, precio_unitario, desc_pct, subtotal)
       SELECT lower(hex(randomblob(16))), taller_id, ?, orden, tipo, articulo_id, servicio_id, descripcion, cantidad, precio_unitario, desc_pct, subtotal
         FROM presupuesto_items WHERE taller_id = ? AND presupuesto_id = ?`,
    ).bind(ordenId, s.tallerId, id),
    c.env.DB.prepare("INSERT INTO orden_eventos (id, taller_id, orden_id, estado_nuevo, nota, usuario_id) VALUES (?, ?, ?, 'recibida', ?, ?)")
      .bind(uid(), s.tallerId, ordenId, `Generada desde presupuesto #${p.numero}`, s.usuarioId),
    c.env.DB.prepare("UPDATE presupuestos SET estado = 'convertido', orden_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ? AND id = ?")
      .bind(ordenId, s.tallerId, id),
    ...(km != null ? [c.env.DB.prepare('UPDATE vehiculos SET km_actual = MAX(km_actual, ?) WHERE taller_id = ? AND id = ?').bind(km, s.tallerId, p.vehiculo_id)] : []),
    // Vincula el turno asociado al presupuesto (si existe) con la nueva OT.
    c.env.DB.prepare("UPDATE turnos SET orden_id = ?, estado = CASE WHEN estado IN ('agendado','confirmado') THEN 'en_taller' ELSE estado END WHERE taller_id = ? AND presupuesto_id = ? AND orden_id IS NULL")
      .bind(ordenId, s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'presupuesto', id, 'convertir', { orden_id: ordenId }),
  ]);
  const o = await first(c.env.DB, 'SELECT id, numero FROM ordenes WHERE taller_id = ? AND id = ?', s.tallerId, ordenId);
  return c.json(o, 201);
});
