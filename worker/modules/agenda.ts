// Agenda de turnos.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, notFound, query, zFecha, zId, zTextoOpt } from '../lib/http';
import { all, auditar, first, run, uid, updateParcial } from '../lib/db';
import { requirePerm, requireRW, tiene } from '../lib/auth';
import { ESTADOS_TURNO } from '../../shared/dominio';

export const agenda = new Hono<AppEnv>();
agenda.use('*', requireRW('turnos.ver', 'turnos.gestionar'));

const SELECT = `SELECT t.*, c.nombre AS cliente, c.telefono AS cliente_telefono, v.patente, ma.nombre AS marca, mo.nombre AS modelo,
    m.nombre AS mecanico, p.numero AS presupuesto_numero, o.numero AS orden_numero
  FROM turnos t
  JOIN clientes c ON c.taller_id = t.taller_id AND c.id = t.cliente_id
  LEFT JOIN vehiculos v ON v.taller_id = t.taller_id AND v.id = t.vehiculo_id
  LEFT JOIN marcas ma ON ma.taller_id = v.taller_id AND ma.id = v.marca_id
  LEFT JOIN modelos mo ON mo.taller_id = v.taller_id AND mo.id = v.modelo_id
  LEFT JOIN mecanicos m ON m.taller_id = t.taller_id AND m.id = t.mecanico_id
  LEFT JOIN presupuestos p ON p.taller_id = t.taller_id AND p.id = t.presupuesto_id
  LEFT JOIN ordenes o ON o.taller_id = t.taller_id AND o.id = t.orden_id`;

const zTurno = z.object({
  fecha: zFecha,
  hora: z.string().regex(/^\d{2}:\d{2}$/, 'hora inválida (HH:MM)'),
  duracion_min: z.number().int().min(15).max(600).default(60),
  cliente_id: zId,
  vehiculo_id: zId.nullish(),
  presupuesto_id: zId.nullish(),
  mecanico_id: zId.nullish(),
  motivo: zTextoOpt(300),
  notas: zTextoOpt(1000),
});

async function validarRefs(db: D1Database, tallerId: string, d: Partial<z.infer<typeof zTurno>>) {
  if (d.cliente_id && !(await first(db, 'SELECT 1 FROM clientes WHERE taller_id = ? AND id = ?', tallerId, d.cliente_id))) throw badRequest('Cliente inexistente');
  if (d.vehiculo_id) {
    const v = await first<{ cliente_id: string }>(db, 'SELECT cliente_id FROM vehiculos WHERE taller_id = ? AND id = ?', tallerId, d.vehiculo_id);
    if (!v) throw badRequest('Vehículo inexistente');
    if (d.cliente_id && v.cliente_id !== d.cliente_id) throw badRequest('El vehículo no pertenece al cliente');
  }
  if (d.presupuesto_id && !(await first(db, 'SELECT 1 FROM presupuestos WHERE taller_id = ? AND id = ?', tallerId, d.presupuesto_id))) throw badRequest('Presupuesto inexistente');
  if (d.mecanico_id && !(await first(db, 'SELECT 1 FROM mecanicos WHERE taller_id = ? AND id = ?', tallerId, d.mecanico_id))) throw badRequest('Mecánico inexistente');
}

agenda.get('/', async (c) => {
  const s = c.get('sesion');
  const { desde, hasta } = query(c, z.object({ desde: zFecha, hasta: zFecha }));
  return c.json(await all(c.env.DB, `${SELECT} WHERE t.taller_id = ? AND t.fecha BETWEEN ? AND ? ORDER BY t.fecha, t.hora`, s.tallerId, desde, hasta));
});

/** Presupuestos aprobados que todavía no tienen turno ni OT. */
agenda.get('/pendientes', requirePerm('presupuestos.ver'), async (c) => {
  const s = c.get('sesion');
  const sinImportes = !tiene(s, 'presupuestos.valorizados.ver');
  return c.json(
    (await all<Record<string, unknown>>(
      c.env.DB,
      `SELECT p.id, p.numero, p.total, p.cliente_id, p.vehiculo_id, c.nombre AS cliente, v.patente FROM presupuestos p
         JOIN clientes c ON c.taller_id = p.taller_id AND c.id = p.cliente_id JOIN vehiculos v ON v.taller_id = p.taller_id AND v.id = p.vehiculo_id
        WHERE p.taller_id = ? AND p.estado = 'aprobado'
          AND NOT EXISTS (SELECT 1 FROM turnos t WHERE t.taller_id = p.taller_id AND t.presupuesto_id = p.id AND t.estado NOT IN ('cancelado','ausente'))
        ORDER BY p.numero`,
      s.tallerId,
    )).map((p) => (sinImportes ? { ...p, total: undefined } : p)),
  );
});

agenda.post('/', async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zTurno);
  await validarRefs(c.env.DB, s.tallerId, d);
  const id = uid();
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO turnos (id, taller_id, fecha, hora, duracion_min, cliente_id, vehiculo_id, presupuesto_id, mecanico_id, motivo, notas) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ).bind(id, s.tallerId, d.fecha, d.hora, d.duracion_min, d.cliente_id, d.vehiculo_id ?? null, d.presupuesto_id ?? null, d.mecanico_id ?? null, d.motivo, d.notas),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'turno', id, 'crear'),
  ]);
  return c.json(await first(c.env.DB, `${SELECT} WHERE t.taller_id = ? AND t.id = ?`, s.tallerId, id), 201);
});

agenda.put('/:id', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, zTurno.partial().extend({ estado: z.enum(ESTADOS_TURNO).optional() }));
  const t = await first<{ cliente_id: string }>(c.env.DB, 'SELECT cliente_id FROM turnos WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!t) throw notFound('Turno');
  await validarRefs(c.env.DB, s.tallerId, { ...d, cliente_id: d.cliente_id ?? t.cliente_id });
  const st = updateParcial(c.env.DB, 'turnos', s.tallerId, id, d, ['fecha', 'hora', 'duracion_min', 'cliente_id', 'vehiculo_id', 'presupuesto_id', 'mecanico_id', 'motivo', 'notas', 'estado'], false);
  if (st) await st.run();
  return c.json(await first(c.env.DB, `${SELECT} WHERE t.taller_id = ? AND t.id = ?`, s.tallerId, id));
});

agenda.delete('/:id', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const r = await run(c.env.DB, 'DELETE FROM turnos WHERE taller_id = ? AND id = ? AND orden_id IS NULL', s.tallerId, id);
  if (!r.meta.changes) throw notFound('Turno (o ya tiene una OT asociada)');
  return c.json({ ok: true });
});
