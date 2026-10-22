// Órdenes de trabajo: alta, edición, estados (con consumo/reposición de stock), check-list y comprobante.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, conflict, forbidden, notFound, query, zFecha, zId, zTextoOpt } from '../lib/http';
import { all, auditar, first, guard, hoy, like, SEQ_VALOR, seqIncrementar, uid, type Stmt } from '../lib/db';
import { requireAny, requirePerm, tiene } from '../lib/auth';
import { exigirValorizado, limpiarDocumento, limpiarItems } from '../lib/privacidad';
import type { Sesion } from '../env';
import { medioDeCobroInmediato, sentenciasCobro, validarMediosCobro, zCobroInmediato } from '../lib/cobros';
import { exigirCajaAbiertaSiCorresponde } from '../lib/caja';
import { resolverLista, sentenciaListaEnDocumento } from '../lib/listas';
import { COLS_TOTALES, SET_TOTALES, sentenciasItems, totales, validarItems, valoresTotales, zItem, zParametrosTotales } from '../lib/documentos';
import { agrupar, permiteNegativo, resolverDeposito, sentenciasMovimiento, verificarDisponible } from '../lib/stock';
import { nombreUsuarioSql, sentenciaTareasDesdeTrabajos } from '../lib/tareas';
import { estimarManoObra, rentabilidadOrdenes } from '../lib/rentabilidad';
import { sentenciasAplicarCredito, validarOrigenCredito } from '../lib/creditos';
import { ESTADOS_TAREA } from '../../shared/tempario';
import { ESTADOS_OT, ESTADOS_OT_ABIERTOS, ESTADOS_OT_CON_STOCK, ESTADOS_OT_EDITABLES, ESTADO_OT_LABEL, TRANSICIONES_OT, normalizarPatente, type EstadoOT } from '../../shared/dominio';

export const ordenes = new Hono<AppEnv>();
// Quien solo tiene "órdenes asignadas" (mecánicos) ve y trabaja únicamente las OT donde figura como mecánico.
ordenes.use('*', requireAny('ordenes.ver', 'ordenes.asignadas'));

// Una orden es "mía" si soy el mecánico responsable, figuro entre los participantes o tengo alguna tarea a mi cargo.
const ASIGNADA_A_MI = `(o.mecanico_id IN (SELECT m.id FROM mecanicos m WHERE m.taller_id = o.taller_id AND m.usuario_id = ?)
    OR EXISTS (SELECT 1 FROM orden_participantes pa WHERE pa.taller_id = o.taller_id AND pa.orden_id = o.id AND pa.usuario_id = ?)
    OR EXISTS (SELECT 1 FROM orden_tareas ta WHERE ta.taller_id = o.taller_id AND ta.orden_id = o.id AND ta.responsable_id = ?))`;
/** Condición SQL de acceso a las OT según el alcance de la sesión (todas o solo las asignadas). */
function alcance(s: Sesion): { cond: string[]; params: unknown[] } {
  return tiene(s, 'ordenes.ver') ? { cond: [], params: [] } : { cond: [ASIGNADA_A_MI], params: [s.usuarioId, s.usuarioId, s.usuarioId] };
}
async function esAsignadaAMi(db: D1Database, s: Sesion, ordenId: string): Promise<boolean> {
  return !!(await first(db, `SELECT 1 FROM ordenes o WHERE o.taller_id = ? AND o.id = ? AND ${ASIGNADA_A_MI}`, s.tallerId, ordenId, s.usuarioId, s.usuarioId, s.usuarioId));
}
/** Asignar el responsable, los participantes y las tareas: lo hace quien administra las órdenes o tiene el permiso específico (sin tocar importes). */
const puedeAsignar = (s: Sesion) => tiene(s, 'ordenes.modificar') || tiene(s, 'ordenes.asignar');
/**
 * Autoriza una operación de trabajo sobre una OT: quien puede modificar órdenes lo hace sobre cualquiera;
 * quien solo puede "actualizar órdenes asignadas" únicamente sobre las suyas.
 */
async function autorizarTrabajo(db: D1Database, s: Sesion, ordenId: string) {
  if (tiene(s, 'ordenes.modificar')) return;
  if (tiene(s, 'ordenes.trabajar_asignadas') && (await esAsignadaAMi(db, s, ordenId))) return;
  throw forbidden('No tenés permiso para modificar esta orden de trabajo');
}
const ESTADOS_DE_TALLER = ['diagnostico', 'en_reparacion', 'esperando_repuestos', 'lista'];

const SELECT = `SELECT o.*, c.nombre AS cliente, c.codigo AS cliente_codigo, c.telefono AS cliente_telefono, v.patente, v.anio, ma.nombre AS marca, mo.nombre AS modelo,
    m.nombre AS mecanico, m.usuario_id AS mecanico_usuario_id, p.numero AS presupuesto_numero, dep.nombre AS deposito,
    (SELECT COUNT(*) FROM orden_tareas ta WHERE ta.taller_id = o.taller_id AND ta.orden_id = o.id) AS tareas_total,
    (SELECT COUNT(*) FROM orden_tareas ta WHERE ta.taller_id = o.taller_id AND ta.orden_id = o.id AND ta.estado = 'completada') AS tareas_completadas,
    (SELECT COUNT(*) FROM orden_tareas ta WHERE ta.taller_id = o.taller_id AND ta.orden_id = o.id AND ta.estado = 'en_proceso') AS tareas_en_proceso,
    (SELECT SUM(ta.tiempo_estimado_min) FROM orden_tareas ta WHERE ta.taller_id = o.taller_id AND ta.orden_id = o.id) AS tiempo_estimado_min,
    (SELECT COALESCE(SUM(ti.duracion_seg), 0) FROM orden_tiempos ti WHERE ti.taller_id = o.taller_id AND ti.orden_id = o.id) AS tiempo_real_seg,
    (SELECT COUNT(*) FROM orden_participantes pa WHERE pa.taller_id = o.taller_id AND pa.orden_id = o.id) AS participantes_n,
    ve.id AS venta_id, ve.numero AS venta_numero, ve.total AS venta_total, ve.cobrado AS venta_cobrado, ve.devuelto AS venta_devuelto
  FROM ordenes o
  JOIN clientes c ON c.taller_id = o.taller_id AND c.id = o.cliente_id
  JOIN vehiculos v ON v.taller_id = o.taller_id AND v.id = o.vehiculo_id
  LEFT JOIN marcas ma ON ma.taller_id = v.taller_id AND ma.id = v.marca_id
  LEFT JOIN modelos mo ON mo.taller_id = v.taller_id AND mo.id = v.modelo_id
  LEFT JOIN mecanicos m ON m.taller_id = o.taller_id AND m.id = o.mecanico_id
  LEFT JOIN presupuestos p ON p.taller_id = o.taller_id AND p.id = o.presupuesto_id
  LEFT JOIN depositos dep ON dep.taller_id = o.taller_id AND dep.id = o.deposito_id
  LEFT JOIN ventas ve ON ve.taller_id = o.taller_id AND ve.orden_id = o.id AND ve.estado = 'emitida'`;

const zOrden = zParametrosTotales.extend({
  /** Depósito del que se descuentan los repuestos al dejar la orden lista (sin indicar: el principal). */
  deposito_id: zId.nullish(),
  cliente_id: zId,
  vehiculo_id: zId,
  mecanico_id: zId.nullish(),
  km_ingreso: z.number().int().min(0).max(5_000_000).nullish(),
  falla_reportada: zTextoOpt(2000),
  diagnostico: zTextoOpt(2000),
  observaciones: zTextoOpt(2000),
  fecha_prometida: zFecha.nullish(),
  lista_precio_id: zId.nullish(),
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
  const ac = alcance(s);
  const cond = ['o.taller_id = ?', ...ac.cond];
  const params: unknown[] = [s.tallerId, ...ac.params];
  if (!estado || estado === 'abiertas') cond.push(`o.estado IN (${ESTADOS_OT_ABIERTOS.map(() => '?').join(',')})`), params.push(...ESTADOS_OT_ABIERTOS);
  else if (estado !== 'todas') (cond.push('o.estado = ?'), params.push(estado));
  if (q) {
    // Sin permiso para ver clientes no se puede buscar por nombre de cliente (sería una forma de averiguarlo).
    const porCliente = tiene(s, 'clientes.ver');
    cond.push(`(${porCliente ? 'c.nombre LIKE ? OR ' : ''}v.patente LIKE ? OR CAST(o.numero AS TEXT) = ?)`);
    params.push(...(porCliente ? [like(q)] : []), like(normalizarPatente(q) || q), q.replace(/\D/g, ''));
  }
  if (mecanico_id) (cond.push('o.mecanico_id = ?'), params.push(mecanico_id));
  if (desde) (cond.push('o.fecha_ingreso >= ?'), params.push(desde));
  if (hasta) (cond.push('o.fecha_ingreso <= ?'), params.push(`${hasta}T23:59:59.999Z`));
  return c.json((await all(c.env.DB, `${SELECT} WHERE ${cond.join(' AND ')} ORDER BY o.numero DESC LIMIT ?`, ...params, limite)).map((o) => limpiarDocumento(s, o)));
});

/** Mi cronómetro en marcha (si lo hay) y en qué orden y tarea: lo usa la barra de la vista del mecánico. */
ordenes.get('/cronometro/activo', async (c) => {
  const s = c.get('sesion');
  const x = await first(
    c.env.DB,
    `SELECT x.orden_id, o.numero AS orden_numero, v.patente, x.inicio_at, x.tarea_id, t.descripcion AS tarea
       FROM orden_tiempos x JOIN ordenes o ON o.taller_id = x.taller_id AND o.id = x.orden_id JOIN vehiculos v ON v.taller_id = o.taller_id AND v.id = o.vehiculo_id
       LEFT JOIN orden_tareas t ON t.taller_id = x.taller_id AND t.id = x.tarea_id
      WHERE x.taller_id = ? AND x.usuario_id = ? AND x.fin_at IS NULL`,
    s.tallerId, s.usuarioId,
  );
  return c.json(x);
});

ordenes.get('/:id', async (c) => {
  const s = c.get('sesion');
  const ac = alcance(s);
  const o = await first<any>(c.env.DB, `${SELECT} WHERE o.taller_id = ? AND o.id = ? ${ac.cond.map((x) => `AND ${x}`).join(' ')}`, s.tallerId, c.req.param('id'), ...ac.params);
  if (!o) throw notFound('Orden de trabajo');
  const [items, eventos, checklist, tareasDb, notas, tiempos, participantes] = await Promise.all([
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
    all(
      c.env.DB,
      `SELECT t.id, t.descripcion, t.estado, t.servicio_id, t.tiempo_estimado_min, t.observaciones, t.iniciada_at, t.hecha_at, t.responsable_id,
              ${nombreUsuarioSql('r')} AS responsable, ${nombreUsuarioSql('u')} AS hecha_por,
              (SELECT COALESCE(SUM(ti.duracion_seg), 0) FROM orden_tiempos ti WHERE ti.taller_id = t.taller_id AND ti.tarea_id = t.id) AS tiempo_real_seg
         FROM orden_tareas t
         LEFT JOIN usuarios u ON u.taller_id = t.taller_id AND u.id = t.hecha_por
         LEFT JOIN usuarios r ON r.taller_id = t.taller_id AND r.id = t.responsable_id
        WHERE t.taller_id = ? AND t.orden_id = ? ORDER BY t.posicion, t.created_at`,
      s.tallerId,
      o.id,
    ),
    all(
      c.env.DB,
      `SELECT n.id, n.texto, n.created_at, u.nombre AS usuario FROM orden_notas n LEFT JOIN usuarios u ON u.taller_id = n.taller_id AND u.id = n.usuario_id
        WHERE n.taller_id = ? AND n.orden_id = ? ORDER BY n.created_at DESC LIMIT 100`,
      s.tallerId,
      o.id,
    ),
    all<{ usuario_id: string; tarea_id: string | null; inicio_at: string; fin_at: string | null; duracion_seg: number | null; usuario: string }>(
      c.env.DB,
      `SELECT t.usuario_id, t.tarea_id, t.inicio_at, t.fin_at, t.duracion_seg, ${nombreUsuarioSql('u')} AS usuario FROM orden_tiempos t JOIN usuarios u ON u.taller_id = t.taller_id AND u.id = t.usuario_id
        WHERE t.taller_id = ? AND t.orden_id = ? ORDER BY t.inicio_at DESC LIMIT 200`,
      s.tallerId,
      o.id,
    ),
    all(
      c.env.DB,
      `SELECT p.usuario_id, ${nombreUsuarioSql('u')} AS nombre FROM orden_participantes p JOIN usuarios u ON u.taller_id = p.taller_id AND u.id = p.usuario_id
        WHERE p.taller_id = ? AND p.orden_id = ? ORDER BY p.created_at`,
      s.tallerId,
      o.id,
    ),
  ]);
  // Tiempo real de cada tarea = tramos cerrados + el tramo en marcha (si lo hay). `hecha` se conserva por compatibilidad.
  const ahoraMs = Date.now();
  const tareas = tareasDb.map((t: any) => {
    const abiertos = tiempos.filter((x) => x.tarea_id === t.id && !x.fin_at);
    const enMarcha = abiertos.reduce((a, x) => a + Math.max(0, Math.round((ahoraMs - Date.parse(x.inicio_at)) / 1000)), 0);
    return { ...t, hecha: t.estado === 'completada' ? 1 : 0, tiempo_cerrado_seg: t.tiempo_real_seg, tiempo_real_seg: t.tiempo_real_seg + enMarcha, en_marcha: abiertos.map((x) => ({ usuario_id: x.usuario_id, usuario: x.usuario, inicio_at: x.inicio_at })) };
  });
  // Tiempo dedicado a la reparación (no es asistencia al taller): total cerrado, y el cronómetro propio si está en marcha.
  const tiempoTotalSeg = tiempos.reduce((a, t) => a + (t.duracion_seg ?? 0), 0);
  const miCronometro = tiempos.find((t) => t.usuario_id === s.usuarioId && !t.fin_at) ?? null;
  const tareasEstimadoMin = tareas.reduce((a: number, t: any) => a + (t.tiempo_estimado_min ?? 0), 0);
  return c.json({
    ...limpiarDocumento(s, o),
    items: limpiarItems(s, items),
    eventos,
    checklist: checklist ? { ...checklist, datos: JSON.parse(String(checklist.datos)) } : null,
    tareas,
    notas,
    tiempos,
    tiempo_total_seg: tiempoTotalSeg,
    mi_cronometro: miCronometro ? { inicio_at: miCronometro.inicio_at, tarea_id: miCronometro.tarea_id } : null,
    participantes,
    tiempo_estimado_total_min: tareasEstimadoMin,
    asignada_a_mi: await esAsignadaAMi(c.env.DB, s, o.id),
  });
});

/**
 * Rentabilidad de la orden: repuestos (venta contra costo) y mano de obra facturada. El costo de los repuestos es el que tenían al
 * descontarse del stock (no cambia si el costo del artículo se actualiza después); antes de descontarse es una estimación con el costo actual.
 * La mano de obra no tiene costo cargado en Fierro (no hay costo por hora): se muestra su venta y las horas cronometradas.
 */
ordenes.get('/:id/rentabilidad', requirePerm('ordenes.ver', 'margenes.ver', 'presupuestos.valorizados.ver'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const o = await first<{ stock_aplicado: number; estado: string }>(c.env.DB, 'SELECT stock_aplicado, estado FROM ordenes WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!o) throw notFound('Orden de trabajo');
  const repuestos = await all<{ articulo_id: string; descripcion: string; cantidad: number; venta: number; costo_actual: number; costo_consumido: number | null }>(
    c.env.DB,
    `SELECT oi.articulo_id, oi.descripcion, SUM(oi.cantidad) AS cantidad, SUM(oi.subtotal) AS venta, COALESCE(a.costo, 0) AS costo_actual,
            (SELECT SUM(-sm.cantidad * COALESCE(sm.costo_unitario, a.costo, 0)) FROM stock_movimientos sm
              WHERE sm.taller_id = oi.taller_id AND sm.origen_tipo = 'orden' AND sm.origen_id = oi.orden_id AND sm.articulo_id = oi.articulo_id AND sm.tipo IN ('consumo_ot','reverso_ot')) AS costo_consumido
       FROM orden_items oi LEFT JOIN articulos a ON a.taller_id = oi.taller_id AND a.id = oi.articulo_id
      WHERE oi.taller_id = ? AND oi.orden_id = ? AND oi.tipo = 'articulo' GROUP BY oi.articulo_id`,
    s.tallerId, id,
  );
  const lineas = repuestos.map((r) => {
    const costo = o.stock_aplicado && r.costo_consumido != null ? Math.round(r.costo_consumido) : Math.round(r.cantidad * r.costo_actual);
    return { descripcion: r.descripcion, cantidad: r.cantidad, venta: r.venta, costo, margen: r.venta - costo };
  });
  const mo = await first<{ venta: number }>(c.env.DB, "SELECT COALESCE(SUM(subtotal), 0) AS venta FROM orden_items WHERE taller_id = ? AND orden_id = ? AND tipo IN ('servicio','libre')", s.tallerId, id);
  const t = await first<{ seg: number }>(c.env.DB, 'SELECT COALESCE(SUM(duracion_seg), 0) AS seg FROM orden_tiempos WHERE taller_id = ? AND orden_id = ?', s.tallerId, id);
  const venta = lineas.reduce((a, l) => a + l.venta, 0);
  const costo = lineas.reduce((a, l) => a + l.costo, 0);
  const resumen = (await rentabilidadOrdenes(c.env.DB, s.tallerId, [id])).get(id);
  return c.json({
    costo_estimado: !o.stock_aplicado,
    repuestos: lineas,
    totales_repuestos: { venta, costo, margen: venta - costo },
    mano_obra: { venta: mo?.venta ?? 0, horas_registradas_seg: t?.seg ?? 0 },
    // Resultado de la operación (neto de descuentos globales, sin IVA y neto de devoluciones), con la calidad del dato y lo que falta para que sea definitivo.
    resumen,
    nota: 'Las líneas muestran los importes antes de descuentos e impuestos globales de la orden; el resumen es neto de descuentos, sin IVA y neto de devoluciones.',
  });
});

ordenes.post('/', requirePerm('ordenes.crear'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zOrden);
  if (d.items.length) exigirValorizado(s);
  await validarCabecera(c.env.DB, s.tallerId, d);
  if (d.turno_id && !(await first(c.env.DB, 'SELECT 1 FROM turnos WHERE taller_id = ? AND id = ? AND orden_id IS NULL', s.tallerId, d.turno_id))) {
    throw badRequest('Turno inexistente o ya vinculado a otra OT');
  }
  const items = await validarItems(c.env.DB, s.tallerId, d.items);
  const t = totales(items, d);
  const lista = await resolverLista(c.env.DB, s.tallerId, d.lista_precio_id);
  const deposito = await resolverDeposito(c.env.DB, s.tallerId, d.deposito_id);
  const id = uid();
  const stmts: Stmt[] = [
    ...seqIncrementar(c.env.DB, s.tallerId, 'orden'),
    c.env.DB.prepare(
      `INSERT INTO ordenes (id, taller_id, numero, cliente_id, vehiculo_id, mecanico_id, km_ingreso, falla_reportada, diagnostico, observaciones, fecha_ingreso, fecha_prometida, created_by, deposito_id, ${COLS_TOTALES})
       VALUES (?, ?, ${SEQ_VALOR}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${COLS_TOTALES.split(',').map(() => '?').join(',')})`,
    ).bind(
      id, s.tallerId, s.tallerId, 'orden', d.cliente_id, d.vehiculo_id, d.mecanico_id ?? null, d.km_ingreso ?? null, d.falla_reportada, d.diagnostico, d.observaciones,
      new Date().toISOString(), d.fecha_prometida ?? null, s.usuarioId, deposito, ...valoresTotales(d, t),
    ),
    ...sentenciasItems(c.env.DB, 'orden_items', 'orden_id', s.tallerId, id, items, t.subtotales),
    sentenciaTareasDesdeTrabajos(c.env.DB, s.tallerId, id, s.usuarioId),
    ...(lista ? [sentenciaListaEnDocumento(c.env.DB, 'ordenes', s.tallerId, id, lista)] : []),
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
  return c.json(limpiarDocumento(s, (await first(c.env.DB, `${SELECT} WHERE o.taller_id = ? AND o.id = ?`, s.tallerId, id))!), 201);
});

/** Edición de cabecera e ítems. Solo en estados editables (el stock aún no fue descontado). Control optimista por versión. */
ordenes.put('/:id', requirePerm('ordenes.modificar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  exigirValorizado(s);
  const d = await body(c, zOrden.omit({ turno_id: true }).extend({ version: z.number().int().min(1) }));
  const o = await first<{ estado: EstadoOT; version: number; km_ingreso: number | null; vehiculo_id: string; lista_precio_id: string | null }>(
    c.env.DB,
    'SELECT estado, version, km_ingreso, vehiculo_id, lista_precio_id FROM ordenes WHERE taller_id = ? AND id = ?',
    s.tallerId,
    id,
  );
  if (!o) throw notFound('Orden de trabajo');
  if (!ESTADOS_OT_EDITABLES.includes(o.estado)) throw conflict(`No se puede editar una OT en estado "${ESTADO_OT_LABEL[o.estado]}". Volvela a "En reparación" para modificarla.`);
  if (o.version !== d.version) throw conflict('La OT fue modificada por otra persona. Recargá para ver los cambios.', 'version');
  await validarCabecera(c.env.DB, s.tallerId, d, o.vehiculo_id === d.vehiculo_id ? o.km_ingreso : null);
  const items = await validarItems(c.env.DB, s.tallerId, d.items);
  const t = totales(items, d);
  const lista = await resolverLista(c.env.DB, s.tallerId, d.lista_precio_id, o.lista_precio_id);
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
    sentenciaListaEnDocumento(c.env.DB, 'ordenes', s.tallerId, id, lista),
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
  await autorizarTrabajo(c.env.DB, s, id);
  // Quien solo puede actualizar sus órdenes asignadas no entrega ni cancela (eso es del mostrador) ni reabre órdenes cerradas.
  if (!tiene(s, 'ordenes.modificar') && !ESTADOS_DE_TALLER.includes(d.estado)) throw forbidden('Tu rol puede pasar la orden a diagnóstico, en reparación, esperando repuestos o lista');
  const o = await first<{ estado: EstadoOT; stock_aplicado: number; version: number; numero: number; vehiculo_id: string; deposito_id: string | null }>(
    c.env.DB,
    'SELECT estado, stock_aplicado, version, numero, vehiculo_id, deposito_id FROM ordenes WHERE taller_id = ? AND id = ?',
    s.tallerId,
    id,
  );
  if (!o) throw notFound('Orden de trabajo');
  if (o.estado === d.estado) return c.json({ ok: true });
  if (!tiene(s, 'ordenes.modificar') && ['entregada', 'cancelada'].includes(o.estado)) throw forbidden('La orden ya está cerrada');
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
    if (aplicar && !negativo) await verificarDisponible(c.env.DB, s.tallerId, porArticulo, o.deposito_id);
    for (const [articuloId, cant] of porArticulo) {
      stmts.push(
        ...sentenciasMovimiento(
          c.env.DB,
          s.tallerId,
          {
            articuloId,
            depositoId: o.deposito_id,
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
  // Rentabilidad: al quedar lista/entregada se congela la estimación de mano de obra con los costos horarios de ese momento; al reabrirla se descarta y se vuelve a congelar al cerrarla.
  const cierraAhora = d.estado === 'lista' || d.estado === 'entregada';
  if (cierraAhora && o.estado !== 'lista' && o.estado !== 'entregada') {
    const est = (await estimarManoObra(c.env.DB, s.tallerId, [id]))[0];
    sets.push("mo_estimado_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')", 'mo_costo_estimado = ?', 'mo_estimado_completo = ?');
    vals.push(est.importe, est.completo ? 1 : 0);
  } else if (!cierraAhora) {
    sets.push('mo_estimado_at = NULL', 'mo_costo_estimado = NULL', 'mo_estimado_completo = NULL');
  }
  stmts.push(
    c.env.DB.prepare(`UPDATE ordenes SET ${sets.join(', ')} WHERE taller_id = ? AND id = ?`).bind(...vals, s.tallerId, id),
    c.env.DB.prepare('INSERT INTO orden_eventos (id, taller_id, orden_id, estado_anterior, estado_nuevo, nota, usuario_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(uid(), s.tallerId, id, o.estado, d.estado, d.nota, s.usuarioId),
  );
  // Al dejar la orden lista, entregarla o cancelarla no pueden quedar cronómetros en marcha ni tareas "en proceso".
  if (['lista', 'entregada', 'cancelada'].includes(d.estado)) {
    const fin = new Date().toISOString();
    stmts.push(
      c.env.DB.prepare(
        "UPDATE orden_tiempos SET fin_at = ?, duracion_seg = MAX(0, CAST(ROUND((julianday(?) - julianday(inicio_at)) * 86400) AS INTEGER)) WHERE taller_id = ? AND orden_id = ? AND fin_at IS NULL",
      ).bind(fin, fin, s.tallerId, id),
      c.env.DB.prepare("UPDATE orden_tareas SET estado = 'pausada' WHERE taller_id = ? AND orden_id = ? AND estado = 'en_proceso'").bind(s.tallerId, id),
    );
  }
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
  await autorizarTrabajo(c.env.DB, s, id);
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
ordenes.post('/:id/comprobante', requirePerm('ventas.emitir', 'ordenes.ver'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(
    c,
    z.object({
      condicion: z.enum(['contado', 'cuenta_corriente']).default('cuenta_corriente'),
      observaciones: zTextoOpt(500),
      // Emitir y cobrar el total en el acto (contado): el cobro y su ingreso de caja van en la misma transacción.
      cobro: zCobroInmediato.nullish(),
      // Saldo a favor (anticipos de esta OT o del cliente) que se imputa al comprobante en la misma transacción.
      creditos: z.array(z.object({ origen_tipo: z.enum(['anticipo', 'devolucion']), origen_id: zId, importe: z.number().int().positive() })).max(20).default([]),
    }),
  );
  const o = await first<{ estado: EstadoOT; total: number; numero: number; cliente_id: string }>(c.env.DB, 'SELECT estado, total, numero, cliente_id FROM ordenes WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!o) throw notFound('Orden de trabajo');
  if (d.condicion === 'cuenta_corriente' && d.cobro) throw badRequest('Un comprobante a cuenta corriente no se cobra en el acto');
  const claves = d.creditos.map((x) => x.origen_tipo + ':' + x.origen_id);
  if (new Set(claves).size !== claves.length) throw badRequest('Un mismo saldo a favor aparece más de una vez');
  const totalCreditos = d.creditos.reduce((a, x) => a + x.importe, 0);
  if (totalCreditos > o.total) throw badRequest('El saldo a favor aplicado supera el total del comprobante');
  const fechaHoy = hoy();
  for (const x of d.creditos) await validarOrigenCredito(c.env.DB, s.tallerId, { clienteId: o.cliente_id, origenTipo: x.origen_tipo, origenId: x.origen_id, importe: x.importe, fecha: fechaHoy });
  const aCobrar = o.total - totalCreditos;
  // "Contado" significa cobrado; la cuenta corriente exige un cliente identificado.
  if (d.condicion === 'contado' && aCobrar > 0 && !d.cobro) throw badRequest('Un comprobante de contado se cobra en el momento: elegí el medio de pago o emitilo a cuenta corriente');
  if (d.cobro) await validarMediosCobro(c.env.DB, s.tallerId, [medioDeCobroInmediato(d.cobro, aCobrar)]);
  if (d.condicion === 'cuenta_corriente' && (await first(c.env.DB, 'SELECT 1 FROM clientes WHERE taller_id = ? AND id = ? AND codigo = 0', s.tallerId, o.cliente_id))) {
    throw badRequest('La cuenta corriente requiere un cliente identificado (no "Consumidor final")');
  }
  const cobrar = d.condicion === 'contado' && !!d.cobro && aCobrar > 0;
  if (cobrar) await exigirCajaAbiertaSiCorresponde(c.env.DB, s.tallerId);
  if (!ESTADOS_OT_CON_STOCK.includes(o.estado)) throw conflict('El comprobante se genera cuando la OT está "Lista para entregar" o "Entregada"');
  if (await first(c.env.DB, "SELECT 1 FROM ventas WHERE taller_id = ? AND orden_id = ? AND estado = 'emitida'", s.tallerId, id)) throw conflict('La OT ya tiene un comprobante vigente', 'duplicado');
  const nItems = await first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM orden_items WHERE taller_id = ? AND orden_id = ?', s.tallerId, id);
  if (!nItems?.n) throw conflict('La OT no tiene ítems para facturar');
  const ventaId = uid();
  const fechaVenta = hoy();
  await c.env.DB.batch([
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM ordenes WHERE taller_id = ? AND id = ? AND estado IN ('lista','entregada'))", s.tallerId, id),
    ...seqIncrementar(c.env.DB, s.tallerId, 'venta'),
    // Copia los totales calculados de la OT: el comprobante refleja exactamente lo trabajado.
    c.env.DB.prepare(
      `INSERT INTO ventas (id, taller_id, numero, cliente_id, orden_id, fecha, condicion, observaciones, created_by, ${COLS_TOTALES})
       SELECT ?, taller_id, ${SEQ_VALOR}, cliente_id, id, ?, ?, ?, ?, ${COLS_TOTALES} FROM ordenes WHERE taller_id = ? AND id = ?`,
    ).bind(ventaId, s.tallerId, 'venta', fechaVenta, d.condicion, d.observaciones ?? `OT #${o.numero}`, s.usuarioId, s.tallerId, id),
    c.env.DB.prepare('UPDATE ventas SET lista_precio_id = (SELECT lista_precio_id FROM ordenes WHERE taller_id = ? AND id = ?), lista_precio_nombre = (SELECT lista_precio_nombre FROM ordenes WHERE taller_id = ? AND id = ?) WHERE taller_id = ? AND id = ?')
      .bind(s.tallerId, id, s.tallerId, id, s.tallerId, ventaId),
    c.env.DB.prepare(
      `INSERT INTO venta_items (id, taller_id, venta_id, orden, tipo, articulo_id, servicio_id, descripcion, cantidad, precio_unitario, desc_pct, alicuota_iva, subtotal, costo_unitario)
       SELECT lower(hex(randomblob(16))), oi.taller_id, ?, oi.orden, oi.tipo, oi.articulo_id, oi.servicio_id, oi.descripcion, oi.cantidad, oi.precio_unitario, oi.desc_pct,
              COALESCE(a.alicuota_iva, 21), oi.subtotal,
              CASE WHEN oi.tipo = 'articulo' THEN COALESCE((SELECT sm.costo_unitario FROM stock_movimientos sm WHERE sm.taller_id = oi.taller_id AND sm.origen_tipo = 'orden' AND sm.origen_id = oi.orden_id
                      AND sm.articulo_id = oi.articulo_id AND sm.tipo = 'consumo_ot' ORDER BY sm.created_at DESC LIMIT 1), a.costo) END
         FROM orden_items oi LEFT JOIN articulos a ON a.taller_id = oi.taller_id AND a.id = oi.articulo_id
        WHERE oi.taller_id = ? AND oi.orden_id = ?`,
    ).bind(ventaId, s.tallerId, id),
    ...(cobrar
      ? sentenciasCobro(c.env.DB, s, {
          id: uid(), clienteId: o.cliente_id, fecha: fechaVenta, idemKey: `comprobante:${ventaId}`, notas: `Cobro del comprobante de OT #${o.numero}`,
          medios: [medioDeCobroInmediato(d.cobro!, aCobrar)],
          aplicaciones: [{ ventaId, importe: aCobrar }],
        })
      : []),
    ...d.creditos.flatMap((x, i) =>
      sentenciasAplicarCredito(c.env.DB, s, { ventaId, clienteId: o.cliente_id, origenTipo: x.origen_tipo, origenId: x.origen_id, importe: x.importe, fecha: fechaVenta, idemKey: `comprobante:${ventaId}:${i}` }),
    ),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'venta', ventaId, 'crear_desde_ot', { orden_id: id }),
  ]);
  return c.json(await first(c.env.DB, 'SELECT id, numero, total FROM ventas WHERE taller_id = ? AND id = ?', s.tallerId, ventaId), 201);
});

// Resumen por estado para el tablero
ordenes.get('/resumen/estados', async (c) => {
  const s = c.get('sesion');
  const ac = alcance(s);
  return c.json(await all(c.env.DB, `SELECT o.estado, COUNT(*) AS cantidad FROM ordenes o WHERE o.taller_id = ? ${ac.cond.map((x) => `AND ${x}`).join(' ')} GROUP BY o.estado`, s.tallerId, ...ac.params));
});

// ───── Depósito del que se descuentan los repuestos ─────
// Regla de stock de la OT: los repuestos se descuentan UNA sola vez, al pasar a "Lista para entregar" (o "Entregada" desde un estado sin stock),
// del depósito de la orden; al reabrirla vuelven al mismo depósito. Por eso el depósito solo se cambia mientras el stock no está descontado.
ordenes.patch('/:id/deposito', requirePerm('ordenes.modificar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, z.object({ deposito_id: zId.nullable() }));
  const o = await first<{ estado: EstadoOT; stock_aplicado: number }>(c.env.DB, 'SELECT estado, stock_aplicado FROM ordenes WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!o) throw notFound('Orden de trabajo');
  if (o.estado === 'entregada' || o.estado === 'cancelada') throw conflict('La orden está cerrada');
  if (o.stock_aplicado) throw conflict('Los repuestos ya se descontaron del depósito: volvé la orden a "En reparación" para cambiarlo');
  const dep = await resolverDeposito(c.env.DB, s.tallerId, d.deposito_id);
  await c.env.DB.batch([
    guard(c.env.DB, 'NOT EXISTS (SELECT 1 FROM ordenes WHERE taller_id = ? AND id = ? AND stock_aplicado = 0)', s.tallerId, id),
    c.env.DB.prepare("UPDATE ordenes SET deposito_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ? AND id = ?").bind(dep, s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'orden', id, 'deposito', { deposito_id: dep }),
  ]);
  return c.json({ ok: true });
});

// ───── Asignación: mecánico responsable y participantes ─────
// Quien asigna no necesita ver ni modificar importes: el permiso `ordenes.asignar` alcanza (o `ordenes.modificar`).
async function validarUsuariosActivos(db: D1Database, tallerId: string, ids: string[]) {
  if (!ids.length) return;
  const filas = await all(db, `SELECT id FROM usuarios WHERE taller_id = ? AND activo = 1 AND id IN (${ids.map(() => '?').join(',')})`, tallerId, ...ids);
  if (filas.length !== ids.length) throw badRequest('Hay personas inexistentes o inactivas');
}

ordenes.patch('/:id/responsable', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, z.object({ mecanico_id: zId.nullable() }));
  if (!puedeAsignar(s)) throw forbidden('No tenés permiso para asignar mecánicos');
  await ordenAbierta(c.env.DB, s.tallerId, id);
  if (d.mecanico_id && !(await first(c.env.DB, 'SELECT 1 FROM mecanicos WHERE taller_id = ? AND id = ? AND activo = 1', s.tallerId, d.mecanico_id))) throw badRequest('Mecánico inexistente o inactivo');
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE ordenes SET mecanico_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ? AND id = ?").bind(d.mecanico_id, s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'orden', id, 'asignar_responsable', { mecanico_id: d.mecanico_id }),
  ]);
  return c.json({ ok: true });
});

ordenes.put('/:id/participantes', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, z.object({ usuario_ids: z.array(zId).max(12) }));
  if (!puedeAsignar(s)) throw forbidden('No tenés permiso para asignar participantes');
  await ordenAbierta(c.env.DB, s.tallerId, id);
  const ids = [...new Set(d.usuario_ids)];
  await validarUsuariosActivos(c.env.DB, s.tallerId, ids);
  const actuales = (await all<{ usuario_id: string }>(c.env.DB, 'SELECT usuario_id FROM orden_participantes WHERE taller_id = ? AND orden_id = ?', s.tallerId, id)).map((x) => x.usuario_id);
  const stmts: Stmt[] = [
    ...actuales.filter((u) => !ids.includes(u)).map((u) => c.env.DB.prepare('DELETE FROM orden_participantes WHERE taller_id = ? AND orden_id = ? AND usuario_id = ?').bind(s.tallerId, id, u)),
    ...ids.filter((u) => !actuales.includes(u)).map((u) => c.env.DB.prepare('INSERT INTO orden_participantes (id, taller_id, orden_id, usuario_id, asignado_por) VALUES (?, ?, ?, ?, ?)').bind(uid(), s.tallerId, id, u, s.usuarioId)),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'orden', id, 'asignar_participantes', { usuario_ids: ids }),
  ];
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

// ───── Trabajo del mecánico: tareas, observaciones técnicas y tiempo dedicado a la reparación ─────
// Son datos propios de la OT, independientes de los ítems facturables y de la asistencia al taller.
async function ordenAbierta(db: D1Database, tallerId: string, id: string) {
  const o = await first<{ estado: EstadoOT }>(db, 'SELECT estado FROM ordenes WHERE taller_id = ? AND id = ?', tallerId, id);
  if (!o) throw notFound('Orden de trabajo');
  if (o.estado === 'entregada' || o.estado === 'cancelada') throw conflict('La orden está cerrada');
}

const zObsOpcional = z.string().trim().max(2000).optional();
ordenes.patch('/:id/tecnico', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, z.object({ diagnostico: zObsOpcional, resultado: zObsOpcional }));
  await autorizarTrabajo(c.env.DB, s, id);
  await ordenAbierta(c.env.DB, s.tallerId, id);
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (d.diagnostico !== undefined) (sets.push('diagnostico = ?'), vals.push(d.diagnostico || null));
  if (d.resultado !== undefined) (sets.push('resultado = ?'), vals.push(d.resultado || null));
  if (!sets.length) return c.json({ ok: true });
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE ordenes SET ${sets.join(', ')}, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ? AND id = ?`).bind(...vals, s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'orden', id, 'diagnostico'),
  ]);
  return c.json({ ok: true });
});

const zEstimado = z.number().int().min(0).max(60000);
const zTareaNueva = z.object({
  descripcion: z.string().trim().min(2).max(200),
  responsable_id: zId.nullish(),
  tiempo_estimado_min: zEstimado.nullish(),
  servicio_id: zId.nullish(),
  observaciones: z.string().trim().max(1000).nullish(),
});

/** Cambiar el responsable de una tarea: lo hace quien asigna; cualquiera puede tomar una tarea libre o soltar la suya. */
function autorizarResponsable(s: Sesion, actual: string | null, nuevo: string | null) {
  if (nuevo === actual) return;
  const toma = nuevo === s.usuarioId && !actual;
  const suelta = nuevo === null && actual === s.usuarioId;
  if (!puedeAsignar(s) && !toma && !suelta) throw forbidden('Solo quien asigna tareas puede cambiar el responsable');
}

ordenes.post('/:id/tareas', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, zTareaNueva);
  await autorizarTrabajo(c.env.DB, s, id);
  await ordenAbierta(c.env.DB, s.tallerId, id);
  if (d.responsable_id) {
    autorizarResponsable(s, null, d.responsable_id);
    await validarUsuariosActivos(c.env.DB, s.tallerId, [d.responsable_id]);
  }
  if (d.servicio_id && !(await first(c.env.DB, 'SELECT 1 FROM servicios WHERE taller_id = ? AND id = ?', s.tallerId, d.servicio_id))) throw badRequest('Servicio inexistente');
  const n = await first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM orden_tareas WHERE taller_id = ? AND orden_id = ?', s.tallerId, id);
  if ((n?.n ?? 0) >= 100) throw badRequest('La orden ya tiene el máximo de tareas');
  const tid = uid();
  await c.env.DB.prepare(
    'INSERT INTO orden_tareas (id, taller_id, orden_id, posicion, descripcion, responsable_id, servicio_id, tiempo_estimado_min, observaciones, creada_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(tid, s.tallerId, id, n?.n ?? 0, d.descripcion, d.responsable_id ?? null, d.servicio_id ?? null, d.tiempo_estimado_min ?? null, d.observaciones || null, s.usuarioId).run();
  return c.json({ id: tid }, 201);
});

/** Crea una tarea por cada trabajo de la OT que todavía no la tenga (con el tiempo estimado del tempario). */
ordenes.post('/:id/tareas/desde-trabajos', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  await autorizarTrabajo(c.env.DB, s, id);
  await ordenAbierta(c.env.DB, s.tallerId, id);
  const r = await sentenciaTareasDesdeTrabajos(c.env.DB, s.tallerId, id, s.usuarioId).run();
  return c.json({ creadas: r.meta.changes ?? 0 });
});

const zTareaPatch = z.object({
  hecha: z.boolean().optional(),
  estado: z.enum(ESTADOS_TAREA).optional(),
  descripcion: z.string().trim().min(2).max(200).optional(),
  responsable_id: zId.nullish(),
  tiempo_estimado_min: zEstimado.nullish(),
  observaciones: z.string().trim().max(1000).nullish(),
});

/** SQL que cierra el cronómetro propio de una tarea (pausar o completar la tarea detiene el reloj). */
const CERRAR_MI_TRAMO = `UPDATE orden_tiempos SET fin_at = ?, duracion_seg = MAX(0, CAST(ROUND((julianday(?) - julianday(inicio_at)) * 86400) AS INTEGER))
  WHERE taller_id = ? AND usuario_id = ? AND tarea_id = ? AND fin_at IS NULL`;

ordenes.patch('/:id/tareas/:tid', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const tid = c.req.param('tid');
  const d = await body(c, zTareaPatch);
  await autorizarTrabajo(c.env.DB, s, id);
  await ordenAbierta(c.env.DB, s.tallerId, id);
  const t = await first<{ estado: string; responsable_id: string | null }>(c.env.DB, 'SELECT estado, responsable_id FROM orden_tareas WHERE taller_id = ? AND orden_id = ? AND id = ?', s.tallerId, id, tid);
  if (!t) throw notFound('Tarea');
  const ahoraIso = new Date().toISOString();
  const sets: string[] = [];
  const vals: unknown[] = [];
  const stmts: Stmt[] = [];

  // `hecha` (versión anterior de la API) equivale a completada / pendiente.
  const estado = d.estado ?? (d.hecha === undefined ? undefined : d.hecha ? 'completada' : t.estado === 'completada' ? 'pendiente' : t.estado);
  let responsable = t.responsable_id;
  if (d.responsable_id !== undefined) {
    autorizarResponsable(s, t.responsable_id, d.responsable_id ?? null);
    if (d.responsable_id) await validarUsuariosActivos(c.env.DB, s.tallerId, [d.responsable_id]);
    responsable = d.responsable_id ?? null;
  }
  if (estado && estado !== t.estado) {
    sets.push('estado = ?');
    vals.push(estado);
    // Quien empieza o termina una tarea libre y está asignado a la orden pasa a ser su responsable.
    if ((estado === 'en_proceso' || estado === 'completada') && !responsable && (await esAsignadaAMi(c.env.DB, s, id))) responsable = s.usuarioId;
    if (estado === 'en_proceso') (sets.push('iniciada_at = COALESCE(iniciada_at, ?)'), vals.push(ahoraIso));
    if (estado === 'completada') (sets.push('hecha_at = ?', 'hecha_por = ?'), vals.push(ahoraIso, s.usuarioId));
    else if (t.estado === 'completada') sets.push('hecha_at = NULL', 'hecha_por = NULL');
    if (estado !== 'en_proceso') stmts.push(c.env.DB.prepare(CERRAR_MI_TRAMO).bind(ahoraIso, ahoraIso, s.tallerId, s.usuarioId, tid));
  }
  if (responsable !== t.responsable_id) (sets.push('responsable_id = ?'), vals.push(responsable));
  if (d.descripcion) (sets.push('descripcion = ?'), vals.push(d.descripcion));
  if (d.tiempo_estimado_min !== undefined) (sets.push('tiempo_estimado_min = ?'), vals.push(d.tiempo_estimado_min ?? null));
  if (d.observaciones !== undefined) (sets.push('observaciones = ?'), vals.push(d.observaciones || null));
  if (!sets.length) return c.json({ ok: true });
  stmts.push(
    c.env.DB.prepare(`UPDATE orden_tareas SET ${sets.join(', ')} WHERE taller_id = ? AND orden_id = ? AND id = ?`).bind(...vals, s.tallerId, id, tid),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'orden', id, 'tarea', { tarea_id: tid, estado: estado ?? undefined, responsable_id: responsable !== t.responsable_id ? responsable : undefined }),
  );
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

ordenes.delete('/:id/tareas/:tid', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  await autorizarTrabajo(c.env.DB, s, id);
  await ordenAbierta(c.env.DB, s.tallerId, id);
  const r = await c.env.DB.prepare('DELETE FROM orden_tareas WHERE taller_id = ? AND orden_id = ? AND id = ?').bind(s.tallerId, id, c.req.param('tid')).run();
  if (!r.meta.changes) throw notFound('Tarea');
  return c.json({ ok: true });
});

ordenes.post('/:id/notas', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, z.object({ texto: z.string().trim().min(2).max(1000) }));
  await autorizarTrabajo(c.env.DB, s, id);
  await ordenAbierta(c.env.DB, s.tallerId, id);
  const nid = uid();
  await c.env.DB.prepare('INSERT INTO orden_notas (id, taller_id, orden_id, usuario_id, texto) VALUES (?, ?, ?, ?, ?)').bind(nid, s.tallerId, id, s.usuarioId, d.texto).run();
  return c.json({ id: nid }, 201);
});

// ───── Cronómetro de la OT (un tramo por vez y por persona; puede atribuirse a una tarea) ─────
async function cuerpoOpcional<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
  const raw = await c.req.json().catch(() => ({}));
  const r = schema.safeParse(raw ?? {});
  if (!r.success) throw badRequest(`${r.error.issues[0].path.join('.') || 'datos'}: ${r.error.issues[0].message}`);
  return r.data;
}

ordenes.post('/:id/tiempo/iniciar', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await cuerpoOpcional(c, z.object({ tarea_id: zId.nullish() }));
  await autorizarTrabajo(c.env.DB, s, id);
  await ordenAbierta(c.env.DB, s.tallerId, id);
  const abierto = await first<{ orden_id: string; numero: number }>(
    c.env.DB,
    'SELECT t.orden_id, o.numero FROM orden_tiempos t JOIN ordenes o ON o.taller_id = t.taller_id AND o.id = t.orden_id WHERE t.taller_id = ? AND t.usuario_id = ? AND t.fin_at IS NULL',
    s.tallerId,
    s.usuarioId,
  );
  if (abierto) throw conflict(abierto.orden_id === id ? 'Ya estás trabajando en esta orden' : `Ya tenés el cronómetro en marcha en la OT #${abierto.numero}: detenelo antes de empezar otra`, 'cronometro_en_marcha');
  const ahoraIso = new Date().toISOString();
  const stmts: Stmt[] = [];
  if (d.tarea_id) {
    const t = await first<{ estado: string; responsable_id: string | null }>(c.env.DB, 'SELECT estado, responsable_id FROM orden_tareas WHERE taller_id = ? AND orden_id = ? AND id = ?', s.tallerId, id, d.tarea_id);
    if (!t) throw badRequest('La tarea no pertenece a esta orden');
    if (t.estado === 'completada') throw conflict('La tarea ya está completada: reabrila para seguir trabajando en ella');
    // Empezar a trabajar en una tarea la pone "en proceso" y, si estaba libre, queda a cargo de quien la empezó.
    stmts.push(
      c.env.DB.prepare("UPDATE orden_tareas SET estado = 'en_proceso', iniciada_at = COALESCE(iniciada_at, ?), responsable_id = COALESCE(responsable_id, ?) WHERE taller_id = ? AND orden_id = ? AND id = ?")
        .bind(ahoraIso, s.usuarioId, s.tallerId, id, d.tarea_id),
    );
  }
  stmts.push(c.env.DB.prepare('INSERT INTO orden_tiempos (id, taller_id, orden_id, usuario_id, inicio_at, tarea_id) VALUES (?, ?, ?, ?, ?, ?)').bind(uid(), s.tallerId, id, s.usuarioId, ahoraIso, d.tarea_id ?? null));
  await c.env.DB.batch(stmts);
  return c.json({ ok: true }, 201);
});

ordenes.post('/:id/tiempo/detener', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await cuerpoOpcional(c, z.object({ pausar_tarea: z.boolean().default(true) }));
  const t = await first<{ id: string; inicio_at: string; tarea_id: string | null }>(c.env.DB, 'SELECT id, inicio_at, tarea_id FROM orden_tiempos WHERE taller_id = ? AND orden_id = ? AND usuario_id = ? AND fin_at IS NULL', s.tallerId, id, s.usuarioId);
  if (!t) throw conflict('No tenés el cronómetro en marcha en esta orden');
  const fin = new Date();
  const seg = Math.max(0, Math.round((fin.getTime() - Date.parse(t.inicio_at)) / 1000));
  const stmts: Stmt[] = [c.env.DB.prepare('UPDATE orden_tiempos SET fin_at = ?, duracion_seg = ? WHERE taller_id = ? AND id = ? AND fin_at IS NULL').bind(fin.toISOString(), seg, s.tallerId, t.id)];
  // Detener el reloj deja la tarea "pausada" (salvo que se indique lo contrario) si seguía en proceso y nadie más trabaja en ella.
  if (t.tarea_id && d.pausar_tarea) {
    stmts.push(
      c.env.DB.prepare(
        `UPDATE orden_tareas SET estado = 'pausada' WHERE taller_id = ? AND id = ? AND estado = 'en_proceso'
           AND NOT EXISTS (SELECT 1 FROM orden_tiempos x WHERE x.taller_id = orden_tareas.taller_id AND x.tarea_id = orden_tareas.id AND x.fin_at IS NULL AND x.id <> ?)`,
      ).bind(s.tallerId, t.tarea_id, t.id),
    );
  }
  await c.env.DB.batch(stmts);
  return c.json({ ok: true, duracion_seg: seg });
});
