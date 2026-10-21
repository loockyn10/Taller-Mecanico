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
import { agrupar, permiteNegativo, sentenciasMovimiento, verificarDisponible } from '../lib/stock';
import { ESTADOS_OT, ESTADOS_OT_ABIERTOS, ESTADOS_OT_CON_STOCK, ESTADOS_OT_EDITABLES, ESTADO_OT_LABEL, TRANSICIONES_OT, normalizarPatente, type EstadoOT } from '../../shared/dominio';

export const ordenes = new Hono<AppEnv>();
// Quien solo tiene "órdenes asignadas" (mecánicos) ve y trabaja únicamente las OT donde figura como mecánico.
ordenes.use('*', requireAny('ordenes.ver', 'ordenes.asignadas'));

const ASIGNADA_A_MI = 'o.mecanico_id IN (SELECT m.id FROM mecanicos m WHERE m.taller_id = o.taller_id AND m.usuario_id = ?)';
/** Condición SQL de acceso a las OT según el alcance de la sesión (todas o solo las asignadas). */
function alcance(s: Sesion): { cond: string[]; params: unknown[] } {
  return tiene(s, 'ordenes.ver') ? { cond: [], params: [] } : { cond: [ASIGNADA_A_MI], params: [s.usuarioId] };
}
async function esAsignadaAMi(db: D1Database, s: Sesion, ordenId: string): Promise<boolean> {
  return !!(await first(db, `SELECT 1 FROM ordenes o WHERE o.taller_id = ? AND o.id = ? AND ${ASIGNADA_A_MI}`, s.tallerId, ordenId, s.usuarioId));
}
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

ordenes.get('/:id', async (c) => {
  const s = c.get('sesion');
  const ac = alcance(s);
  const o = await first<any>(c.env.DB, `${SELECT} WHERE o.taller_id = ? AND o.id = ? ${ac.cond.map((x) => `AND ${x}`).join(' ')}`, s.tallerId, c.req.param('id'), ...ac.params);
  if (!o) throw notFound('Orden de trabajo');
  const [items, eventos, checklist, tareas, notas, tiempos] = await Promise.all([
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
      `SELECT t.id, t.descripcion, t.hecha, t.hecha_at, u.nombre AS hecha_por FROM orden_tareas t LEFT JOIN usuarios u ON u.taller_id = t.taller_id AND u.id = t.hecha_por
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
    all<{ usuario_id: string; inicio_at: string; fin_at: string | null; duracion_seg: number | null; usuario: string }>(
      c.env.DB,
      `SELECT t.usuario_id, t.inicio_at, t.fin_at, t.duracion_seg, u.nombre AS usuario FROM orden_tiempos t JOIN usuarios u ON u.taller_id = t.taller_id AND u.id = t.usuario_id
        WHERE t.taller_id = ? AND t.orden_id = ? ORDER BY t.inicio_at DESC LIMIT 200`,
      s.tallerId,
      o.id,
    ),
  ]);
  // Tiempo dedicado a la reparación (no es asistencia al taller): total cerrado, y el cronómetro propio si está en marcha.
  const tiempoTotalSeg = tiempos.reduce((a, t) => a + (t.duracion_seg ?? 0), 0);
  const miCronometro = tiempos.find((t) => t.usuario_id === s.usuarioId && !t.fin_at) ?? null;
  return c.json({
    ...limpiarDocumento(s, o),
    items: limpiarItems(s, items),
    eventos,
    checklist: checklist ? { ...checklist, datos: JSON.parse(String(checklist.datos)) } : null,
    tareas,
    notas,
    tiempos,
    tiempo_total_seg: tiempoTotalSeg,
    mi_cronometro: miCronometro ? { inicio_at: miCronometro.inicio_at } : null,
    asignada_a_mi: await esAsignadaAMi(c.env.DB, s, o.id),
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
  const o = await first<{ estado: EstadoOT; stock_aplicado: number; version: number; numero: number; vehiculo_id: string }>(
    c.env.DB,
    'SELECT estado, stock_aplicado, version, numero, vehiculo_id FROM ordenes WHERE taller_id = ? AND id = ?',
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
    }),
  );
  const o = await first<{ estado: EstadoOT; total: number; numero: number; cliente_id: string }>(c.env.DB, 'SELECT estado, total, numero, cliente_id FROM ordenes WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!o) throw notFound('Orden de trabajo');
  if (d.condicion === 'cuenta_corriente' && d.cobro) throw badRequest('Un comprobante a cuenta corriente no se cobra en el acto');
  // "Contado" significa cobrado; la cuenta corriente exige un cliente identificado.
  if (d.condicion === 'contado' && o.total > 0 && !d.cobro) throw badRequest('Un comprobante de contado se cobra en el momento: elegí el medio de pago o emitilo a cuenta corriente');
  if (d.cobro) await validarMediosCobro(c.env.DB, s.tallerId, [medioDeCobroInmediato(d.cobro, o.total)]);
  if (d.condicion === 'cuenta_corriente' && (await first(c.env.DB, 'SELECT 1 FROM clientes WHERE taller_id = ? AND id = ? AND codigo = 0', s.tallerId, o.cliente_id))) {
    throw badRequest('La cuenta corriente requiere un cliente identificado (no "Consumidor final")');
  }
  const cobrar = d.condicion === 'contado' && !!d.cobro && o.total > 0;
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
      `INSERT INTO venta_items (id, taller_id, venta_id, orden, tipo, articulo_id, servicio_id, descripcion, cantidad, precio_unitario, desc_pct, alicuota_iva, subtotal)
       SELECT lower(hex(randomblob(16))), oi.taller_id, ?, oi.orden, oi.tipo, oi.articulo_id, oi.servicio_id, oi.descripcion, oi.cantidad, oi.precio_unitario, oi.desc_pct,
              COALESCE(a.alicuota_iva, 21), oi.subtotal
         FROM orden_items oi LEFT JOIN articulos a ON a.taller_id = oi.taller_id AND a.id = oi.articulo_id
        WHERE oi.taller_id = ? AND oi.orden_id = ?`,
    ).bind(ventaId, s.tallerId, id),
    ...(cobrar
      ? sentenciasCobro(c.env.DB, s, {
          id: uid(), clienteId: o.cliente_id, fecha: fechaVenta, idemKey: `comprobante:${ventaId}`, notas: `Cobro del comprobante de OT #${o.numero}`,
          medios: [medioDeCobroInmediato(d.cobro!, o.total)],
          aplicaciones: [{ ventaId, importe: o.total }],
        })
      : []),
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

// ───── Trabajo del mecánico: tareas, observaciones técnicas y tiempo dedicado a la reparación ─────
// Son datos propios de la OT, independientes de los ítems facturables y de la asistencia al taller.
async function ordenAbierta(db: D1Database, tallerId: string, id: string) {
  const o = await first<{ estado: EstadoOT }>(db, 'SELECT estado FROM ordenes WHERE taller_id = ? AND id = ?', tallerId, id);
  if (!o) throw notFound('Orden de trabajo');
  if (o.estado === 'entregada' || o.estado === 'cancelada') throw conflict('La orden está cerrada');
}

ordenes.patch('/:id/tecnico', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, z.object({ diagnostico: zTextoOpt(2000) }));
  await autorizarTrabajo(c.env.DB, s, id);
  await ordenAbierta(c.env.DB, s.tallerId, id);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE ordenes SET diagnostico = ?, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ? AND id = ?").bind(d.diagnostico, s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'orden', id, 'diagnostico'),
  ]);
  return c.json({ ok: true });
});

ordenes.post('/:id/tareas', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, z.object({ descripcion: z.string().trim().min(2).max(200) }));
  await autorizarTrabajo(c.env.DB, s, id);
  await ordenAbierta(c.env.DB, s.tallerId, id);
  const n = await first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM orden_tareas WHERE taller_id = ? AND orden_id = ?', s.tallerId, id);
  if ((n?.n ?? 0) >= 100) throw badRequest('La orden ya tiene el máximo de tareas');
  const tid = uid();
  await c.env.DB.prepare('INSERT INTO orden_tareas (id, taller_id, orden_id, posicion, descripcion, creada_por) VALUES (?, ?, ?, ?, ?, ?)').bind(tid, s.tallerId, id, n?.n ?? 0, d.descripcion, s.usuarioId).run();
  return c.json({ id: tid }, 201);
});

ordenes.patch('/:id/tareas/:tid', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, z.object({ hecha: z.boolean().optional(), descripcion: z.string().trim().min(2).max(200).optional() }));
  await autorizarTrabajo(c.env.DB, s, id);
  await ordenAbierta(c.env.DB, s.tallerId, id);
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (d.hecha !== undefined) {
    sets.push('hecha = ?', 'hecha_at = ?', 'hecha_por = ?');
    vals.push(d.hecha ? 1 : 0, d.hecha ? new Date().toISOString() : null, d.hecha ? s.usuarioId : null);
  }
  if (d.descripcion) (sets.push('descripcion = ?'), vals.push(d.descripcion));
  if (!sets.length) return c.json({ ok: true });
  const r = await c.env.DB.prepare(`UPDATE orden_tareas SET ${sets.join(', ')} WHERE taller_id = ? AND orden_id = ? AND id = ?`).bind(...vals, s.tallerId, id, c.req.param('tid')).run();
  if (!r.meta.changes) throw notFound('Tarea');
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

ordenes.post('/:id/tiempo/iniciar', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  await autorizarTrabajo(c.env.DB, s, id);
  await ordenAbierta(c.env.DB, s.tallerId, id);
  const abierto = await first<{ orden_id: string; numero: number }>(
    c.env.DB,
    'SELECT t.orden_id, o.numero FROM orden_tiempos t JOIN ordenes o ON o.taller_id = t.taller_id AND o.id = t.orden_id WHERE t.taller_id = ? AND t.usuario_id = ? AND t.fin_at IS NULL',
    s.tallerId,
    s.usuarioId,
  );
  if (abierto) throw conflict(abierto.orden_id === id ? 'Ya estás trabajando en esta orden' : `Ya tenés el cronómetro en marcha en la OT #${abierto.numero}: detenelo antes de empezar otra`, 'cronometro_en_marcha');
  await c.env.DB.prepare('INSERT INTO orden_tiempos (id, taller_id, orden_id, usuario_id, inicio_at) VALUES (?, ?, ?, ?, ?)').bind(uid(), s.tallerId, id, s.usuarioId, new Date().toISOString()).run();
  return c.json({ ok: true }, 201);
});

ordenes.post('/:id/tiempo/detener', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const t = await first<{ id: string; inicio_at: string }>(c.env.DB, 'SELECT id, inicio_at FROM orden_tiempos WHERE taller_id = ? AND orden_id = ? AND usuario_id = ? AND fin_at IS NULL', s.tallerId, id, s.usuarioId);
  if (!t) throw conflict('No tenés el cronómetro en marcha en esta orden');
  const fin = new Date();
  const seg = Math.max(0, Math.round((fin.getTime() - Date.parse(t.inicio_at)) / 1000));
  await c.env.DB.prepare('UPDATE orden_tiempos SET fin_at = ?, duracion_seg = ? WHERE taller_id = ? AND id = ? AND fin_at IS NULL').bind(fin.toISOString(), seg, s.tallerId, t.id).run();
  return c.json({ ok: true, duracion_seg: seg });
});
