// Historial técnico del vehículo. Se arma con las órdenes de trabajo (nada se duplica en tablas aparte) más los antecedentes
// anteriores a Fierro, cargados a mano y claramente diferenciados. Quien no ve importes recibe el mismo historial sin ellos.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, notFound, query, zFecha, zId, zTextoOpt } from '../lib/http';
import { all, auditar, delTaller, first, hoy, uid } from '../lib/db';
import { requirePerm } from '../lib/auth';
import { limpiarDocumento } from '../lib/privacidad';
import { nombreUsuarioSql } from '../lib/tareas';

export const historial = new Hono<AppEnv>();

interface MecanicoOT {
  nombre: string;
  responsable: boolean;
  segundos: number;
}

historial.get('/vehiculos/:id/historial-tecnico', requirePerm('vehiculos.ver'), async (c) => {
  const s = c.get('sesion');
  const vid = c.req.param('id');
  const { incluir_canceladas } = query(c, z.object({ incluir_canceladas: z.string().optional() }));
  const v = await first<{ id: string; patente: string; km_actual: number }>(c.env.DB, 'SELECT id, patente, km_actual FROM vehiculos WHERE taller_id = ? AND id = ?', s.tallerId, vid);
  if (!v) throw notFound('Vehículo');
  const filtroEstado = incluir_canceladas ? '' : "AND o.estado <> 'cancelada'";

  const ordenes = await all<Record<string, any>>(
    c.env.DB,
    `SELECT o.id, o.numero, o.estado, o.fecha_ingreso, o.fecha_lista, o.fecha_entregada, o.km_ingreso, o.falla_reportada, o.diagnostico, o.resultado, o.observaciones, o.total,
            m.nombre AS responsable
       FROM ordenes o LEFT JOIN mecanicos m ON m.taller_id = o.taller_id AND m.id = o.mecanico_id
      WHERE o.taller_id = ? AND o.vehiculo_id = ? ${filtroEstado} ORDER BY o.fecha_ingreso DESC LIMIT 300`,
    s.tallerId, vid,
  );
  // Las tablas hijas se leen con subconsultas por vehículo (sin IN de ids): D1 admite hasta 100 parámetros por consulta.
  const [items, tareas, notas, participantes, tiempos, antecedentes] = await Promise.all([
    all<{ orden_id: string; tipo: string; descripcion: string; cantidad: number; tiempo_min: number | null }>(
      c.env.DB,
      `SELECT oi.orden_id, oi.tipo, oi.descripcion, oi.cantidad, oi.tiempo_min FROM orden_items oi JOIN ordenes o ON o.taller_id = oi.taller_id AND o.id = oi.orden_id
        WHERE oi.taller_id = ? AND o.vehiculo_id = ? ORDER BY oi.orden`,
      s.tallerId, vid,
    ),
    all<{ orden_id: string; descripcion: string; estado: string; observaciones: string | null; tiempo_estimado_min: number | null; tiempo_real_seg: number }>(
      c.env.DB,
      `SELECT t.orden_id, t.descripcion, t.estado, t.observaciones, t.tiempo_estimado_min,
              (SELECT COALESCE(SUM(x.duracion_seg), 0) FROM orden_tiempos x WHERE x.taller_id = t.taller_id AND x.tarea_id = t.id) AS tiempo_real_seg
         FROM orden_tareas t JOIN ordenes o ON o.taller_id = t.taller_id AND o.id = t.orden_id
        WHERE t.taller_id = ? AND o.vehiculo_id = ? ORDER BY t.posicion, t.created_at`,
      s.tallerId, vid,
    ),
    all<{ orden_id: string; texto: string; created_at: string; usuario: string | null }>(
      c.env.DB,
      `SELECT n.orden_id, n.texto, n.created_at, ${nombreUsuarioSql('u')} AS usuario FROM orden_notas n JOIN ordenes o ON o.taller_id = n.taller_id AND o.id = n.orden_id
         LEFT JOIN usuarios u ON u.taller_id = n.taller_id AND u.id = n.usuario_id
        WHERE n.taller_id = ? AND o.vehiculo_id = ? ORDER BY n.created_at`,
      s.tallerId, vid,
    ),
    all<{ orden_id: string; nombre: string }>(
      c.env.DB,
      `SELECT p.orden_id, ${nombreUsuarioSql('u')} AS nombre FROM orden_participantes p JOIN ordenes o ON o.taller_id = p.taller_id AND o.id = p.orden_id
         JOIN usuarios u ON u.taller_id = p.taller_id AND u.id = p.usuario_id WHERE p.taller_id = ? AND o.vehiculo_id = ?`,
      s.tallerId, vid,
    ),
    all<{ orden_id: string; nombre: string; segundos: number }>(
      c.env.DB,
      `SELECT x.orden_id, ${nombreUsuarioSql('u')} AS nombre, COALESCE(SUM(x.duracion_seg), 0) AS segundos FROM orden_tiempos x JOIN ordenes o ON o.taller_id = x.taller_id AND o.id = x.orden_id
         JOIN usuarios u ON u.taller_id = x.taller_id AND u.id = x.usuario_id WHERE x.taller_id = ? AND o.vehiculo_id = ? GROUP BY x.orden_id, x.usuario_id`,
      s.tallerId, vid,
    ),
    all<Record<string, any>>(
      c.env.DB,
      `SELECT a.id, a.fecha, a.km, a.tipo, a.descripcion, a.servicio_id, se.nombre AS servicio, a.repuestos, a.realizado_por, a.resultado, a.observaciones, a.created_at, ${nombreUsuarioSql('u')} AS cargado_por
         FROM vehiculo_antecedentes a LEFT JOIN servicios se ON se.taller_id = a.taller_id AND se.id = a.servicio_id LEFT JOIN usuarios u ON u.taller_id = a.taller_id AND u.id = a.created_by
        WHERE a.taller_id = ? AND a.vehiculo_id = ? AND a.anulado = 0 ORDER BY a.fecha DESC`,
      s.tallerId, vid,
    ),
  ]);

  const entradasOT = ordenes.map((o) => {
    const mias = items.filter((i) => i.orden_id === o.id);
    const mec = new Map<string, MecanicoOT>();
    if (o.responsable) mec.set(o.responsable, { nombre: o.responsable, responsable: true, segundos: 0 });
    for (const p of participantes.filter((x) => x.orden_id === o.id)) if (!mec.has(p.nombre)) mec.set(p.nombre, { nombre: p.nombre, responsable: false, segundos: 0 });
    for (const t of tiempos.filter((x) => x.orden_id === o.id)) {
      const m = mec.get(t.nombre) ?? { nombre: t.nombre, responsable: false, segundos: 0 };
      m.segundos += t.segundos;
      mec.set(t.nombre, m);
    }
    const { responsable: _r, ...resto } = o;
    const fecha = String(o.fecha_entregada ?? o.fecha_lista ?? o.fecha_ingreso).slice(0, 10);
    return limpiarDocumento(s, {
      ...resto,
      origen: 'fierro' as const,
      fecha,
      km: o.km_ingreso as number | null,
      trabajos: mias.filter((i) => i.tipo !== 'articulo').map((i) => ({ descripcion: i.descripcion, cantidad: i.cantidad, tiempo_min: i.tiempo_min })),
      repuestos: mias.filter((i) => i.tipo === 'articulo').map((i) => ({ descripcion: i.descripcion, cantidad: i.cantidad })),
      tareas: tareas.filter((t) => t.orden_id === o.id).map(({ orden_id: _o, ...t }) => t),
      observaciones_tecnicas: notas.filter((n) => n.orden_id === o.id).map(({ orden_id: _o, ...n }) => n),
      mecanicos: [...mec.values()],
      tiempo_real_seg: [...mec.values()].reduce((a, m) => a + m.segundos, 0),
    });
  });
  const entradasManuales = antecedentes.map((a) => ({ ...a, origen: 'manual' as const }));
  const entradas = [...entradasOT, ...entradasManuales].sort((a: any, b: any) => (b.fecha as string).localeCompare(a.fecha as string) || (b.km ?? 0) - (a.km ?? 0));
  const kms = entradas.map((e: any) => e.km).filter((k): k is number => typeof k === 'number');
  return c.json({
    vehiculo: v,
    entradas,
    resumen: { ordenes: entradasOT.length, antecedentes: entradasManuales.length, ultimo_km: kms.length ? Math.max(...kms, v.km_actual) : v.km_actual },
  });
});

// ───────────── Antecedentes anteriores a Fierro ─────────────
const zAntecedente = z.object({
  fecha: zFecha,
  km: z.number().int().min(0).max(5_000_000).nullish(),
  tipo: z.enum(['mantenimiento', 'reparacion', 'diagnostico', 'otro']).default('reparacion'),
  descripcion: z.string().trim().min(3, 'mínimo 3 caracteres').max(500),
  servicio_id: zId.nullish(),
  repuestos: zTextoOpt(500),
  realizado_por: zTextoOpt(120),
  resultado: zTextoOpt(300),
  observaciones: zTextoOpt(1000),
});

async function validarAntecedente(db: D1Database, tallerId: string, d: z.infer<typeof zAntecedente>) {
  if (d.fecha > hoy()) throw badRequest('Un antecedente no puede tener fecha futura');
  if (d.servicio_id && !(await delTaller(db, 'servicios', tallerId, d.servicio_id, 'id'))) throw badRequest('Operación inexistente');
}

historial.post('/vehiculos/:id/antecedentes', requirePerm('vehiculos.editar'), async (c) => {
  const s = c.get('sesion');
  const vid = c.req.param('id');
  const d = await body(c, zAntecedente);
  if (!(await delTaller(c.env.DB, 'vehiculos', s.tallerId, vid, 'id'))) throw notFound('Vehículo');
  await validarAntecedente(c.env.DB, s.tallerId, d);
  const id = uid();
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO vehiculo_antecedentes (id, taller_id, vehiculo_id, fecha, km, tipo, descripcion, servicio_id, repuestos, realizado_por, resultado, observaciones, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).bind(id, s.tallerId, vid, d.fecha, d.km ?? null, d.tipo, d.descripcion, d.servicio_id ?? null, d.repuestos, d.realizado_por, d.resultado, d.observaciones, s.usuarioId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'vehiculo', vid, 'antecedente', { antecedente_id: id }),
  ]);
  return c.json({ id }, 201);
});

historial.put('/antecedentes/:aid', requirePerm('vehiculos.editar'), async (c) => {
  const s = c.get('sesion');
  const aid = c.req.param('aid');
  const d = await body(c, zAntecedente);
  const a = await first<{ vehiculo_id: string }>(c.env.DB, 'SELECT vehiculo_id FROM vehiculo_antecedentes WHERE taller_id = ? AND id = ? AND anulado = 0', s.tallerId, aid);
  if (!a) throw notFound('Antecedente');
  await validarAntecedente(c.env.DB, s.tallerId, d);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE vehiculo_antecedentes SET fecha = ?, km = ?, tipo = ?, descripcion = ?, servicio_id = ?, repuestos = ?, realizado_por = ?, resultado = ?, observaciones = ? WHERE taller_id = ? AND id = ?')
      .bind(d.fecha, d.km ?? null, d.tipo, d.descripcion, d.servicio_id ?? null, d.repuestos, d.realizado_por, d.resultado, d.observaciones, s.tallerId, aid),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'vehiculo', a.vehiculo_id, 'antecedente_editar', { antecedente_id: aid }),
  ]);
  return c.json({ ok: true });
});

/** Los antecedentes no se borran: se anulan (queda constancia en la auditoría). */
historial.delete('/antecedentes/:aid', requirePerm('vehiculos.editar'), async (c) => {
  const s = c.get('sesion');
  const aid = c.req.param('aid');
  const a = await first<{ vehiculo_id: string }>(c.env.DB, 'SELECT vehiculo_id FROM vehiculo_antecedentes WHERE taller_id = ? AND id = ? AND anulado = 0', s.tallerId, aid);
  if (!a) throw notFound('Antecedente');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE vehiculo_antecedentes SET anulado = 1 WHERE taller_id = ? AND id = ?').bind(s.tallerId, aid),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'vehiculo', a.vehiculo_id, 'antecedente_anular', { antecedente_id: aid }),
  ]);
  return c.json({ ok: true });
});
