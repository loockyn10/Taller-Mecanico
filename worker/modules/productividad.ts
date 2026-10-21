// Productividad operativa del taller y de cada mecánico.
//
// Dos cosas distintas que NUNCA se mezclan ni se restan entre sí:
//   · HORAS DE ASISTENCIA: tiempo que la persona estuvo en el taller (fichajes del Sprint 06).
//   · HORAS PRODUCTIVAS REGISTRADAS EN OT: tiempo que cronometró trabajando en órdenes (orden_tiempos).
// La diferencia entre ambas no es "improductividad": incluye diagnóstico sin cronómetro, esperas, limpieza, capacitación, atención, etc.
// Por eso no se calcula ningún porcentaje de "tiempo perdido". Los importes solo se incluyen con permiso de ver valorizados.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, query, zFecha } from '../lib/http';
import { all, first } from '../lib/db';
import { requireAny, tiene } from '../lib/auth';
import { instanteDesdeLocal, zonaDelTaller } from '../lib/zona';
import { nombreUsuarioSql } from '../lib/tareas';
import { puedeValorizados } from '../lib/privacidad';

export const productividad = new Hono<AppEnv>();
productividad.use('*', requireAny('productividad.ver', 'ordenes.asignadas'));

const ABIERTAS = "('recibida','diagnostico','en_reparacion','esperando_repuestos')";
const MAX_DIAS = 400;

/** Elapsed de un tramo de cronómetro: duración registrada o, si sigue abierto, hasta ahora. */
const SEG_TRAMO = "CASE WHEN fin_at IS NULL THEN CAST(ROUND((julianday('now') - julianday(inicio_at)) * 86400) AS INTEGER) ELSE COALESCE(duracion_seg, 0) END";

interface Rango {
  desde: string;
  hasta: string;
  desdeISO: string;
  hastaISO: string;
}

async function rangoDe(db: D1Database, tallerId: string, desde: string, hasta: string): Promise<Rango & { zona: string }> {
  if (desde > hasta) throw badRequest('El período es inválido');
  const dias = (Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86400_000 + 1;
  if (dias > MAX_DIAS) throw badRequest(`El período no puede superar ${MAX_DIAS} días`);
  const zona = await zonaDelTaller(db, tallerId);
  const siguiente = new Date(Date.parse(`${hasta}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
  return { desde, hasta, zona, desdeISO: instanteDesdeLocal(desde, '00:00', zona).toISOString(), hastaISO: instanteDesdeLocal(siguiente, '00:00', zona).toISOString() };
}

type Mapa<T> = Map<string, T>;
const porUsuario = <T extends { usuario_id: string }>(filas: T[]): Mapa<T> => new Map(filas.map((f) => [f.usuario_id, f]));

async function metricasPersonal(db: D1Database, tallerId: string, r: Rango, soloUsuario?: string) {
  const fu = (col: string) => (soloUsuario ? ` AND ${col} = ?` : '');
  const pu = soloUsuario ? [soloUsuario] : [];
  const staff = await all<{ id: string; nombre: string; cargo: string | null; plantilla: string | null }>(
    db,
    `SELECT id, ${nombreUsuarioSql('usuarios')} AS nombre, cargo, plantilla FROM usuarios WHERE taller_id = ? AND activo = 1 ${soloUsuario ? 'AND id = ?' : ''} ORDER BY nombre COLLATE NOCASE`,
    tallerId, ...pu,
  );
  const [asis, reg, ots, comp, estReal, carga, pend, activos] = await Promise.all([
    all<{ usuario_id: string; dias: number; seg: number }>(
      db,
      `SELECT usuario_id, COUNT(DISTINCT fecha) AS dias,
              COALESCE(SUM(CASE WHEN salida_at IS NULL THEN CAST(ROUND((julianday('now') - julianday(entrada_at)) * 86400) AS INTEGER) ELSE COALESCE(duracion_seg, 0) END), 0) AS seg
         FROM asistencias WHERE taller_id = ? AND anulado = 0 AND fecha BETWEEN ? AND ? ${fu('usuario_id')} GROUP BY usuario_id`,
      tallerId, r.desde, r.hasta, ...pu,
    ),
    all<{ usuario_id: string; seg: number }>(
      db,
      `SELECT usuario_id, COALESCE(SUM(${SEG_TRAMO}), 0) AS seg FROM orden_tiempos WHERE taller_id = ? AND inicio_at >= ? AND inicio_at < ? ${fu('usuario_id')} GROUP BY usuario_id`,
      tallerId, r.desdeISO, r.hastaISO, ...pu,
    ),
    all<{ usuario_id: string; n: number }>(
      db,
      `SELECT usuario_id, COUNT(DISTINCT orden_id) AS n FROM (
         SELECT usuario_id, orden_id FROM orden_tiempos WHERE taller_id = ? AND inicio_at >= ? AND inicio_at < ? ${fu('usuario_id')}
         UNION SELECT hecha_por, orden_id FROM orden_tareas WHERE taller_id = ? AND estado = 'completada' AND hecha_at >= ? AND hecha_at < ? AND hecha_por IS NOT NULL ${fu('hecha_por')}
       ) GROUP BY usuario_id`,
      tallerId, r.desdeISO, r.hastaISO, ...pu, tallerId, r.desdeISO, r.hastaISO, ...pu,
    ),
    all<{ usuario_id: string; n: number }>(
      db,
      `SELECT hecha_por AS usuario_id, COUNT(*) AS n FROM orden_tareas WHERE taller_id = ? AND estado = 'completada' AND hecha_at >= ? AND hecha_at < ? AND hecha_por IS NOT NULL ${fu('hecha_por')} GROUP BY hecha_por`,
      tallerId, r.desdeISO, r.hastaISO, ...pu,
    ),
    // Tiempo estimado vs real: solo tareas completadas con estimación y con tiempo cronometrado (sin cronómetro no hay "real" que comparar).
    all<{ usuario_id: string; n: number; estimado_min: number; real_seg: number }>(
      db,
      `SELECT usuario_id, COUNT(*) AS n, SUM(tiempo_estimado_min) AS estimado_min, SUM(real_seg) AS real_seg FROM (
         SELECT t.hecha_por AS usuario_id, t.tiempo_estimado_min,
                (SELECT COALESCE(SUM(${SEG_TRAMO.replace(/\b(fin_at|duracion_seg|inicio_at)\b/g, 'x.$1')}), 0) FROM orden_tiempos x WHERE x.taller_id = t.taller_id AND x.tarea_id = t.id) AS real_seg
           FROM orden_tareas t WHERE t.taller_id = ? AND t.estado = 'completada' AND t.hecha_at >= ? AND t.hecha_at < ? AND t.tiempo_estimado_min > 0 AND t.hecha_por IS NOT NULL ${fu('t.hecha_por')}
       ) WHERE real_seg > 0 GROUP BY usuario_id`,
      tallerId, r.desdeISO, r.hastaISO, ...pu,
    ),
    all<{ usuario_id: string; n: number }>(
      db,
      `SELECT usuario_id, COUNT(DISTINCT orden_id) AS n FROM (
         SELECT m.usuario_id AS usuario_id, o.id AS orden_id FROM ordenes o JOIN mecanicos m ON m.taller_id = o.taller_id AND m.id = o.mecanico_id
          WHERE o.taller_id = ? AND o.estado IN ${ABIERTAS} AND m.usuario_id IS NOT NULL
         UNION SELECT p.usuario_id, p.orden_id FROM orden_participantes p JOIN ordenes o ON o.taller_id = p.taller_id AND o.id = p.orden_id WHERE p.taller_id = ? AND o.estado IN ${ABIERTAS}
         UNION SELECT t.responsable_id, t.orden_id FROM orden_tareas t JOIN ordenes o ON o.taller_id = t.taller_id AND o.id = t.orden_id
          WHERE t.taller_id = ? AND t.estado <> 'completada' AND t.responsable_id IS NOT NULL AND o.estado IN ${ABIERTAS}
       ) WHERE 1 = 1 ${fu('usuario_id')} GROUP BY usuario_id`,
      tallerId, tallerId, tallerId, ...pu,
    ),
    all<{ usuario_id: string; n: number; estimado_min: number | null }>(
      db,
      `SELECT t.responsable_id AS usuario_id, COUNT(*) AS n, SUM(t.tiempo_estimado_min) AS estimado_min FROM orden_tareas t JOIN ordenes o ON o.taller_id = t.taller_id AND o.id = t.orden_id
        WHERE t.taller_id = ? AND t.estado <> 'completada' AND t.responsable_id IS NOT NULL AND o.estado IN ${ABIERTAS} ${fu('t.responsable_id')} GROUP BY t.responsable_id`,
      tallerId, ...pu,
    ),
    all<{ usuario_id: string; orden_id: string; numero: number }>(
      db,
      `SELECT x.usuario_id, x.orden_id, o.numero FROM orden_tiempos x JOIN ordenes o ON o.taller_id = x.taller_id AND o.id = x.orden_id WHERE x.taller_id = ? AND x.fin_at IS NULL ${fu('x.usuario_id')}`,
      tallerId, ...pu,
    ),
  ]);
  const mAsis = porUsuario(asis);
  const mReg = porUsuario(reg);
  const mOts = porUsuario(ots);
  const mComp = porUsuario(comp);
  const mER = porUsuario(estReal);
  const mCarga = porUsuario(carga);
  const mPend = porUsuario(pend);
  const mAct = porUsuario(activos);
  const filas = staff.map((u) => ({
    usuario_id: u.id,
    nombre: u.nombre,
    cargo: u.cargo,
    es_mecanico: u.plantilla === 'mecanico',
    // Horas de asistencia (fichajes) y horas productivas registradas en OT: dos medidas distintas, sin cruzar.
    asistencia_seg: mAsis.get(u.id)?.seg ?? 0,
    dias_asistencia: mAsis.get(u.id)?.dias ?? 0,
    registrado_ot_seg: mReg.get(u.id)?.seg ?? 0,
    ot_trabajadas: mOts.get(u.id)?.n ?? 0,
    tareas_completadas: mComp.get(u.id)?.n ?? 0,
    comparables: mER.get(u.id)?.n ?? 0,
    estimado_min: mER.get(u.id)?.estimado_min ?? 0,
    real_seg: mER.get(u.id)?.real_seg ?? 0,
    ot_abiertas: mCarga.get(u.id)?.n ?? 0,
    tareas_pendientes: mPend.get(u.id)?.n ?? 0,
    carga_estimada_min: mPend.get(u.id)?.estimado_min ?? 0,
    cronometro: mAct.get(u.id) ? { orden_id: mAct.get(u.id)!.orden_id, orden_numero: mAct.get(u.id)!.numero } : null,
  }));
  // Se listan quienes trabajan en el taller (mecánicos o con actividad); el resto del personal no aparece vacío.
  if (soloUsuario) return filas;
  return filas.filter((f) => f.es_mecanico || f.registrado_ot_seg || f.ot_trabajadas || f.tareas_completadas || f.ot_abiertas || f.tareas_pendientes || f.cronometro);
}

const zPeriodo = z.object({ desde: zFecha, hasta: zFecha });

productividad.get('/', async (c) => {
  const s = c.get('sesion');
  if (!tiene(s, 'productividad.ver')) return c.json({ error: { code: 'sin_permiso', message: 'No tenés permiso para esta acción' } }, 403);
  const q = query(c, zPeriodo);
  const r = await rangoDe(c.env.DB, s.tallerId, q.desde, q.hasta);
  const valorizado = puedeValorizados(s);
  const [mecanicos, estados, ingresadas, completadas, trabajado, totales, mo] = await Promise.all([
    metricasPersonal(c.env.DB, s.tallerId, r),
    all<{ estado: string; n: number }>(c.env.DB, 'SELECT estado, COUNT(*) AS n FROM ordenes WHERE taller_id = ? GROUP BY estado', s.tallerId),
    first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM ordenes WHERE taller_id = ? AND fecha_ingreso >= ? AND fecha_ingreso < ?', s.tallerId, r.desdeISO, r.hastaISO),
    first<{ n: number; horas_prom: number | null }>(
      c.env.DB,
      `SELECT COUNT(*) AS n, AVG((julianday(COALESCE(fecha_lista, fecha_entregada)) - julianday(fecha_ingreso)) * 24) AS horas_prom
         FROM ordenes WHERE taller_id = ? AND estado IN ('lista','entregada') AND COALESCE(fecha_lista, fecha_entregada) >= ? AND COALESCE(fecha_lista, fecha_entregada) < ?`,
      s.tallerId, r.desdeISO, r.hastaISO,
    ),
    first<{ prom_seg: number | null; ordenes: number }>(
      c.env.DB,
      `SELECT AVG(seg) AS prom_seg, COUNT(*) AS ordenes FROM (
         SELECT (SELECT COALESCE(SUM(${SEG_TRAMO.replace(/\b(fin_at|duracion_seg|inicio_at)\b/g, 'x.$1')}), 0) FROM orden_tiempos x WHERE x.taller_id = o.taller_id AND x.orden_id = o.id) AS seg
           FROM ordenes o WHERE o.taller_id = ? AND o.estado IN ('lista','entregada') AND COALESCE(o.fecha_lista, o.fecha_entregada) >= ? AND COALESCE(o.fecha_lista, o.fecha_entregada) < ?
       ) WHERE seg > 0`,
      s.tallerId, r.desdeISO, r.hastaISO,
    ),
    first<{ asistencia_seg: number; registrado_seg: number }>(
      c.env.DB,
      `SELECT
         (SELECT COALESCE(SUM(CASE WHEN salida_at IS NULL THEN CAST(ROUND((julianday('now') - julianday(entrada_at)) * 86400) AS INTEGER) ELSE COALESCE(duracion_seg, 0) END), 0)
            FROM asistencias WHERE taller_id = ? AND anulado = 0 AND fecha BETWEEN ? AND ?) AS asistencia_seg,
         (SELECT COALESCE(SUM(${SEG_TRAMO}), 0) FROM orden_tiempos WHERE taller_id = ? AND inicio_at >= ? AND inicio_at < ?) AS registrado_seg`,
      s.tallerId, r.desde, r.hasta, s.tallerId, r.desdeISO, r.hastaISO,
    ),
    valorizado
      ? first<{ total: number }>(
          c.env.DB,
          `SELECT COALESCE(SUM(oi.subtotal), 0) AS total FROM orden_items oi JOIN ordenes o ON o.taller_id = oi.taller_id AND o.id = oi.orden_id
            WHERE oi.taller_id = ? AND oi.tipo = 'servicio' AND o.estado IN ('lista','entregada') AND COALESCE(o.fecha_lista, o.fecha_entregada) >= ? AND COALESCE(o.fecha_lista, o.fecha_entregada) < ?`,
          s.tallerId, r.desdeISO, r.hastaISO,
        )
      : Promise.resolve(null),
  ]);
  const n = (e: string[]) => estados.filter((x) => e.includes(x.estado)).reduce((a, x) => a + x.n, 0);
  const sumaMec = (k: 'tareas_completadas' | 'estimado_min' | 'real_seg' | 'comparables') => mecanicos.reduce((a, m) => a + m[k], 0);
  return c.json({
    periodo: { desde: r.desde, hasta: r.hasta, zona: r.zona },
    nota: 'Las horas de asistencia (fichajes) y las horas registradas en OT (cronómetro) son medidas distintas: la diferencia no equivale a tiempo improductivo.',
    taller: {
      pendientes: n(['recibida', 'diagnostico', 'esperando_repuestos']),
      en_proceso: n(['en_reparacion']),
      listas_para_entregar: n(['lista']),
      ingresadas_periodo: ingresadas?.n ?? 0,
      completadas_periodo: completadas?.n ?? 0,
      tiempo_promedio_en_taller_horas: completadas?.horas_prom ?? null,
      tiempo_trabajado_promedio_seg: trabajado?.prom_seg ?? null,
      ordenes_con_tiempo_registrado: trabajado?.ordenes ?? 0,
      asistencia_seg: totales?.asistencia_seg ?? 0,
      registrado_ot_seg: totales?.registrado_seg ?? 0,
      tareas_completadas: sumaMec('tareas_completadas'),
      estimado_min: sumaMec('estimado_min'),
      real_seg: sumaMec('real_seg'),
      tareas_comparables: sumaMec('comparables'),
      ...(valorizado ? { mano_obra_completadas: mo?.total ?? 0 } : {}),
    },
    mecanicos,
  });
});

/** Mis indicadores (cualquier persona con órdenes asignadas ve los propios, sin importes). */
productividad.get('/mia', async (c) => {
  const s = c.get('sesion');
  const q = query(c, zPeriodo);
  const r = await rangoDe(c.env.DB, s.tallerId, q.desde, q.hasta);
  const filas = await metricasPersonal(c.env.DB, s.tallerId, r, s.usuarioId);
  return c.json({ periodo: { desde: r.desde, hasta: r.hasta, zona: r.zona }, yo: filas[0] ?? null });
});
