// Mantenimientos programados por vehículo. El estado (vencido / próximo / al día) se calcula de las OT y los antecedentes
// (worker/lib/mantenimiento.ts); acá se administran los planes de cada vehículo y se consultan los vencimientos.
// No se envía nada automáticamente: los avisos al cliente son enlaces que la persona abre a mano.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, notFound, query, zFecha, zTextoOpt } from '../lib/http';
import { all, auditar, delTaller, first, hoy, uid } from '../lib/db';
import { requirePerm, tiene } from '../lib/auth';
import { limpiarMantenimiento } from '../lib/privacidad';
import { estadoMantenimientos, type EstadoMantenimiento } from '../lib/mantenimiento';

export const mantenimientos = new Hono<AppEnv>();

mantenimientos.get('/mantenimientos', requirePerm('mantenimientos.ver'), async (c) => {
  const s = c.get('sesion');
  const { estado, q } = query(c, z.object({ estado: z.enum(['pendientes', 'vencido', 'proximo', 'sin_registro', 'al_dia', 'todos']).default('pendientes'), q: z.string().optional() }));
  const todos = await estadoMantenimientos(c.env.DB, s.tallerId);
  const resumen: Record<EstadoMantenimiento, number> = { vencido: 0, proximo: 0, al_dia: 0, sin_registro: 0 };
  for (const m of todos) resumen[m.estado]++;
  const texto = (q ?? '').trim().toLowerCase();
  const items = todos
    .filter((m) => (estado === 'todos' ? true : estado === 'pendientes' ? m.estado === 'vencido' || m.estado === 'proximo' : m.estado === estado))
        // Sin permiso para ver clientes no se busca por su nombre (sería una forma de averiguarlo).
    .filter((m) => !texto || [m.patente, tiene(s, 'clientes.ver') ? m.cliente : null, m.servicio, m.marca, m.modelo].some((x) => (x ?? '').toLowerCase().includes(texto)))
    .map((m) => limpiarMantenimiento(s, m));
  return c.json({ resumen, items });
});

/** Compatibilidad: lista de vencidos y próximos (la pantalla anterior de recordatorios de service). */
mantenimientos.get('/recordatorios', requirePerm('mantenimientos.ver', 'clientes.ver'), async (c) => {
  const s = c.get('sesion');
  return c.json((await estadoMantenimientos(c.env.DB, s.tallerId)).filter((m) => m.estado === 'vencido' || m.estado === 'proximo'));
});

mantenimientos.get('/vehiculos/:id/mantenimientos', requirePerm('mantenimientos.ver'), async (c) => {
  const s = c.get('sesion');
  const vid = c.req.param('id');
  if (!(await delTaller(c.env.DB, 'vehiculos', s.tallerId, vid, 'id'))) throw notFound('Vehículo');
  return c.json((await estadoMantenimientos(c.env.DB, s.tallerId, { vehiculoId: vid })).map((m) => limpiarMantenimiento(s, m)));
});

/** Historial de un mantenimiento: cada vez que se realizó (OT terminadas y antecedentes cargados a mano). */
mantenimientos.get('/vehiculos/:id/mantenimientos/:servicioId/historial', requirePerm('mantenimientos.ver'), async (c) => {
  const s = c.get('sesion');
  const vid = c.req.param('id');
  const sid = c.req.param('servicioId');
  if (!(await delTaller(c.env.DB, 'vehiculos', s.tallerId, vid, 'id'))) throw notFound('Vehículo');
  const filas = await all(
    c.env.DB,
    `SELECT 'orden' AS origen, o.id AS orden_id, o.numero AS orden_numero, COALESCE(o.fecha_entregada, o.fecha_lista, o.fecha_ingreso) AS fecha, o.km_ingreso AS km, oi.descripcion
       FROM orden_items oi JOIN ordenes o ON o.taller_id = oi.taller_id AND o.id = oi.orden_id AND o.estado IN ('lista','entregada')
      WHERE oi.taller_id = ? AND o.vehiculo_id = ? AND oi.servicio_id = ?
     UNION ALL
     SELECT 'antecedente', NULL, NULL, a.fecha, a.km, a.descripcion FROM vehiculo_antecedentes a
      WHERE a.taller_id = ? AND a.vehiculo_id = ? AND a.servicio_id = ? AND a.anulado = 0
     ORDER BY fecha DESC`,
    s.tallerId, vid, sid, s.tallerId, vid, sid,
  );
  return c.json(filas);
});

const zPlan = z.object({
  intervalo_km: z.number().int().min(1).max(1_000_000).nullish(),
  intervalo_meses: z.number().int().min(1).max(240).nullish(),
  activo: z.boolean().default(true),
  notas: zTextoOpt(300),
  /** Última vez que se hizo, si fue antes de usar ORVELAN: queda como antecedente del vehículo. */
  ultima: z.object({ fecha: zFecha, km: z.number().int().min(0).max(5_000_000).nullish() }).nullish(),
});

mantenimientos.put('/vehiculos/:id/mantenimientos/:servicioId', requirePerm('mantenimientos.gestionar'), async (c) => {
  const s = c.get('sesion');
  const vid = c.req.param('id');
  const sid = c.req.param('servicioId');
  const d = await body(c, zPlan);
  if (!(await delTaller(c.env.DB, 'vehiculos', s.tallerId, vid, 'id'))) throw notFound('Vehículo');
  const srv = await first<{ nombre: string; intervalo_km: number | null; intervalo_meses: number | null }>(c.env.DB, 'SELECT nombre, intervalo_km, intervalo_meses FROM servicios WHERE taller_id = ? AND id = ?', s.tallerId, sid);
  if (!srv) throw notFound('Operación');
  if (!(d.intervalo_km ?? srv.intervalo_km) && !(d.intervalo_meses ?? srv.intervalo_meses)) throw badRequest('Definí un intervalo por kilómetros o por tiempo (propio del plan o de la operación)');
  if (d.ultima && d.ultima.fecha > hoy()) throw badRequest('La última realización no puede tener fecha futura');
  const id = uid();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO vehiculo_mantenimientos (id, taller_id, vehiculo_id, servicio_id, intervalo_km, intervalo_meses, activo, notas, created_by) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT (taller_id, vehiculo_id, servicio_id) DO UPDATE SET intervalo_km = excluded.intervalo_km, intervalo_meses = excluded.intervalo_meses, activo = excluded.activo,
         notas = excluded.notas, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    ).bind(id, s.tallerId, vid, sid, d.intervalo_km ?? null, d.intervalo_meses ?? null, d.activo ? 1 : 0, d.notas, s.usuarioId),
    ...(d.ultima
      ? [
          c.env.DB.prepare(
            "INSERT INTO vehiculo_antecedentes (id, taller_id, vehiculo_id, fecha, km, tipo, descripcion, servicio_id, realizado_por, created_by) VALUES (?, ?, ?, ?, ?, 'mantenimiento', ?, ?, 'Registro previo a ORVELAN', ?)",
          ).bind(uid(), s.tallerId, vid, d.ultima.fecha, d.ultima.km ?? null, `${srv.nombre} (última realización informada)`, sid, s.usuarioId),
        ]
      : []),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'vehiculo', vid, 'plan_mantenimiento', { servicio_id: sid, activo: d.activo }),
  ]);
  return c.json({ ok: true });
});

mantenimientos.delete('/vehiculos/:id/mantenimientos/:servicioId', requirePerm('mantenimientos.gestionar'), async (c) => {
  const s = c.get('sesion');
  const r = await c.env.DB.prepare('DELETE FROM vehiculo_mantenimientos WHERE taller_id = ? AND vehiculo_id = ? AND servicio_id = ?').bind(s.tallerId, c.req.param('id'), c.req.param('servicioId')).run();
  if (!r.meta.changes) throw notFound('Plan de mantenimiento');
  return c.json({ ok: true });
});
