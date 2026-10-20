// Gastos (con su movimiento de caja), categorías, gastos recurrentes y resumen financiero.
//
// Criterio contable del resumen: base CAJA (lo efectivamente cobrado y pagado). Un cobro, un pago a proveedor o un gasto
// cuentan UNA sola vez, a través del libro caja_movimientos. Las compras y las ventas a crédito no son ingresos ni egresos
// hasta que se cobran o se pagan; se informan aparte como "devengado".
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, conflict, notFound, query, zCentavos, zFecha, zId, zTextoOpt } from '../lib/http';
import { all, auditar, delTaller, first, guard, hoy, like, SEQ_VALOR, seqIncrementar, uid, updateParcial, type Stmt } from '../lib/db';
import { requirePerm } from '../lib/auth';
import { FRECUENCIAS_GASTO, MEDIOS_PAGO, TIPOS_CATEGORIA_GASTO } from '../../shared/dominio';
import { siguienteOcurrencia } from '../../shared/precios';
import { exigirCajaAbiertaSiCorresponde, guardCajaObligatoria, IMPORTE_FIRMADO_SQL, reversoDeOrigen, sentenciaMovimiento } from '../lib/caja';
import { fechaComercial } from '../lib/fechas';

export const gastos = new Hono<AppEnv>();

// ───────────── Categorías ─────────────
gastos.get('/categorias-gasto', requirePerm('caja.operar'), async (c) => {
  const s = c.get('sesion');
  const { todas } = query(c, z.object({ todas: z.string().optional() }));
  return c.json(
    await all(
      c.env.DB,
      `SELECT cg.*, (SELECT COUNT(*) FROM gastos g WHERE g.taller_id = cg.taller_id AND g.categoria_id = cg.id AND g.estado = 'registrado') AS gastos
         FROM categorias_gasto cg WHERE cg.taller_id = ? ${todas ? '' : 'AND cg.activa = 1'} ORDER BY cg.activa DESC, cg.tipo, cg.nombre`,
      s.tallerId,
    ),
  );
});

const zCategoria = z.object({ nombre: z.string().trim().min(2).max(80), tipo: z.enum(TIPOS_CATEGORIA_GASTO).default('operativo'), activa: z.boolean().optional() });

gastos.post('/categorias-gasto', requirePerm('gastos.gestionar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zCategoria);
  const id = uid();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO categorias_gasto (id, taller_id, nombre, tipo) VALUES (?, ?, ?, ?)').bind(id, s.tallerId, d.nombre, d.tipo),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'categoria_gasto', id, 'crear', d),
  ]);
  return c.json({ id }, 201);
});

gastos.put('/categorias-gasto/:id', requirePerm('gastos.gestionar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, zCategoria.partial());
  if (!(await delTaller(c.env.DB, 'categorias_gasto', s.tallerId, id, 'id'))) throw notFound('Categoría');
  const datos: Record<string, unknown> = { ...d };
  if (d.activa !== undefined) datos.activa = d.activa ? 1 : 0;
  const st = updateParcial(c.env.DB, 'categorias_gasto', s.tallerId, id, datos, ['nombre', 'tipo', 'activa'], false);
  if (st) await c.env.DB.batch([st, auditar(c.env.DB, s.tallerId, s.usuarioId, 'categoria_gasto', id, 'modificar', d)]);
  return c.json({ ok: true });
});

// ───────────── Gastos ─────────────
const SELECT_GASTO = `SELECT g.*, cg.nombre AS categoria, cg.tipo AS categoria_tipo, p.nombre AS proveedor, u.nombre AS usuario
  FROM gastos g
  JOIN categorias_gasto cg ON cg.taller_id = g.taller_id AND cg.id = g.categoria_id
  LEFT JOIN proveedores p ON p.taller_id = g.taller_id AND p.id = g.proveedor_id
  LEFT JOIN usuarios u ON u.taller_id = g.taller_id AND u.id = g.usuario_id`;

gastos.get('/gastos', requirePerm('finanzas.ver'), async (c) => {
  const s = c.get('sesion');
  const f = query(
    c,
    z.object({ desde: z.string().optional(), hasta: z.string().optional(), categoria_id: z.string().optional(), medio: z.string().optional(), estado: z.string().optional(), q: z.string().optional(), limite: z.coerce.number().int().min(1).max(500).default(300) }),
  );
  const cond = ['g.taller_id = ?'];
  const params: unknown[] = [s.tallerId];
  if (f.desde) (cond.push('g.fecha >= ?'), params.push(f.desde));
  if (f.hasta) (cond.push('g.fecha <= ?'), params.push(f.hasta));
  if (f.categoria_id) (cond.push('g.categoria_id = ?'), params.push(f.categoria_id));
  if (f.medio) (cond.push('g.medio = ?'), params.push(f.medio));
  if (f.estado) (cond.push('g.estado = ?'), params.push(f.estado));
  if (f.q) (cond.push('(g.concepto LIKE ? OR g.comprobante LIKE ? OR p.nombre LIKE ?)'), params.push(like(f.q), like(f.q), like(f.q)));
  return c.json(await all(c.env.DB, `${SELECT_GASTO} WHERE ${cond.join(' AND ')} ORDER BY g.fecha DESC, g.numero DESC LIMIT ?`, ...params, f.limite));
});

gastos.get('/gastos/:id', requirePerm('finanzas.ver'), async (c) => {
  const s = c.get('sesion');
  const g = await first(c.env.DB, `${SELECT_GASTO} WHERE g.taller_id = ? AND g.id = ?`, s.tallerId, c.req.param('id'));
  if (!g) throw notFound('Gasto');
  return c.json(g);
});

const zGasto = z.object({
  fecha: zFecha.optional(),
  categoria_id: zId,
  concepto: z.string().trim().min(3).max(200),
  importe: zCentavos.refine((v) => v > 0, 'el importe debe ser mayor a 0'),
  medio: z.enum(MEDIOS_PAGO),
  referencia: zTextoOpt(120),
  proveedor_id: zId.nullish(),
  comprobante: zTextoOpt(60),
  notas: zTextoOpt(500),
  idem_key: z.string().min(8).max(80),
});

/** Sentencias que registran un gasto y su egreso de caja (para usar también desde gastos recurrentes). */
function sentenciasGasto(db: D1Database, s: { tallerId: string; usuarioId: string }, id: string, d: z.infer<typeof zGasto>, fecha: string, recurrente?: { id: string; fecha: string }): Stmt[] {
  return [
    guardCajaObligatoria(db, s.tallerId),
    ...seqIncrementar(db, s.tallerId, 'gasto'),
    db.prepare(
      `INSERT INTO gastos (id, taller_id, numero, fecha, categoria_id, concepto, importe, medio, referencia, proveedor_id, comprobante, recurrente_id, recurrente_fecha, idem_key, notas, usuario_id)
       VALUES (?, ?, ${SEQ_VALOR}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, s.tallerId, s.tallerId, 'gasto', fecha, d.categoria_id, d.concepto, d.importe, d.medio, d.referencia, d.proveedor_id ?? null, d.comprobante, recurrente?.id ?? null, recurrente?.fecha ?? null, d.idem_key, d.notas, s.usuarioId),
    sentenciaMovimiento(db, s.tallerId, {
      tipo: 'egreso', rubro: 'gasto', medio: d.medio, importe: d.importe, concepto: `Gasto: ${d.concepto}`, referencia: d.referencia,
      origenTipo: 'gasto', origenId: id, fecha, usuarioId: s.usuarioId,
    }),
    auditar(db, s.tallerId, s.usuarioId, 'gasto', id, 'crear', { importe: d.importe, categoria_id: d.categoria_id }),
  ];
}

async function validarRefsGasto(db: D1Database, tallerId: string, d: { categoria_id: string; proveedor_id?: string | null }) {
  const cat = await first<{ activa: number }>(db, 'SELECT activa FROM categorias_gasto WHERE taller_id = ? AND id = ?', tallerId, d.categoria_id);
  if (!cat) throw badRequest('Categoría inexistente');
  if (!cat.activa) throw badRequest('La categoría está desactivada');
  if (d.proveedor_id && !(await delTaller(db, 'proveedores', tallerId, d.proveedor_id, 'id'))) throw badRequest('Proveedor inexistente');
}

gastos.post('/gastos', requirePerm('caja.operar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zGasto);
  const previo = await first(c.env.DB, `${SELECT_GASTO} WHERE g.taller_id = ? AND g.idem_key = ?`, s.tallerId, d.idem_key);
  if (previo) return c.json({ ...previo, duplicado: true });
  await validarRefsGasto(c.env.DB, s.tallerId, d);
  await exigirCajaAbiertaSiCorresponde(c.env.DB, s.tallerId);
  const fecha = fechaComercial(s, d.fecha);
  const id = uid();
  try {
    await c.env.DB.batch(sentenciasGasto(c.env.DB, s, id, d, fecha));
  } catch (e) {
    if (String(e).includes('idem_key')) {
      const ex = await first(c.env.DB, `${SELECT_GASTO} WHERE g.taller_id = ? AND g.idem_key = ?`, s.tallerId, d.idem_key);
      if (ex) return c.json({ ...ex, duplicado: true });
    }
    throw e;
  }
  return c.json(await first(c.env.DB, `${SELECT_GASTO} WHERE g.taller_id = ? AND g.id = ?`, s.tallerId, id), 201);
});

gastos.post('/gastos/:id/anular', requirePerm('gastos.gestionar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const { motivo } = await body(c, z.object({ motivo: z.string().trim().min(3).max(300) }));
  const g = await first<{ estado: string }>(c.env.DB, 'SELECT estado FROM gastos WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!g) throw notFound('Gasto');
  if (g.estado !== 'registrado') throw conflict('El gasto ya está anulado');
  await exigirCajaAbiertaSiCorresponde(c.env.DB, s.tallerId);
  await c.env.DB.batch([
    guardCajaObligatoria(c.env.DB, s.tallerId),
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM gastos WHERE taller_id = ? AND id = ? AND estado = 'registrado')", s.tallerId, id),
    c.env.DB.prepare("UPDATE gastos SET estado = 'anulado', anulado_motivo = ? WHERE taller_id = ? AND id = ?").bind(motivo, s.tallerId, id),
    reversoDeOrigen(c.env.DB, s.tallerId, 'gasto', id, s.usuarioId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'gasto', id, 'anular', { motivo }),
  ]);
  return c.json({ ok: true });
});

// ───────────── Gastos recurrentes ─────────────
const zRecurrente = z.object({
  categoria_id: zId,
  concepto: z.string().trim().min(3).max(200),
  importe: zCentavos.refine((v) => v > 0, 'el importe debe ser mayor a 0'),
  medio: z.enum(MEDIOS_PAGO),
  frecuencia: z.enum(FRECUENCIAS_GASTO),
  dia: z.number().int().min(1).max(31).nullish(),
  proxima_fecha: zFecha,
  notas: zTextoOpt(300),
  activo: z.boolean().optional(),
});

const SELECT_REC = `SELECT r.*, cg.nombre AS categoria, CASE WHEN r.activo = 1 AND r.proxima_fecha <= ? THEN 1 ELSE 0 END AS vencido
  FROM gastos_recurrentes r JOIN categorias_gasto cg ON cg.taller_id = r.taller_id AND cg.id = r.categoria_id`;

gastos.get('/gastos-recurrentes', requirePerm('gastos.gestionar'), async (c) => {
  const s = c.get('sesion');
  const { pendientes } = query(c, z.object({ pendientes: z.string().optional() }));
  return c.json(await all(c.env.DB, `${SELECT_REC} WHERE r.taller_id = ? ${pendientes ? 'AND r.activo = 1 AND r.proxima_fecha <= ?' : ''} ORDER BY r.activo DESC, r.proxima_fecha`, hoy(), s.tallerId, ...(pendientes ? [hoy()] : [])));
});

gastos.post('/gastos-recurrentes', requirePerm('gastos.gestionar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zRecurrente);
  await validarRefsGasto(c.env.DB, s.tallerId, d);
  const id = uid();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO gastos_recurrentes (id, taller_id, categoria_id, concepto, importe, medio, frecuencia, dia, proxima_fecha, notas) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(id, s.tallerId, d.categoria_id, d.concepto, d.importe, d.medio, d.frecuencia, d.dia ?? null, d.proxima_fecha, d.notas),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'gasto_recurrente', id, 'crear', { concepto: d.concepto, importe: d.importe }),
  ]);
  return c.json({ id }, 201);
});

gastos.put('/gastos-recurrentes/:id', requirePerm('gastos.gestionar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, zRecurrente.partial());
  if (!(await delTaller(c.env.DB, 'gastos_recurrentes', s.tallerId, id, 'id'))) throw notFound('Gasto recurrente');
  if (d.categoria_id) await validarRefsGasto(c.env.DB, s.tallerId, { categoria_id: d.categoria_id });
  const datos: Record<string, unknown> = { ...d };
  if (d.activo !== undefined) datos.activo = d.activo ? 1 : 0;
  const st = updateParcial(c.env.DB, 'gastos_recurrentes', s.tallerId, id, datos, ['categoria_id', 'concepto', 'importe', 'medio', 'frecuencia', 'dia', 'proxima_fecha', 'notas', 'activo'], false);
  if (st) await c.env.DB.batch([st, auditar(c.env.DB, s.tallerId, s.usuarioId, 'gasto_recurrente', id, 'modificar', d)]);
  return c.json({ ok: true });
});

/**
 * Registra la ocurrencia pendiente de un gasto recurrente y avanza la próxima fecha, todo en una transacción.
 * `ocurrencia` es la fecha que vio quien registra: si otro usuario ya la registró, la próxima fecha cambió y la operación se rechaza.
 */
gastos.post('/gastos-recurrentes/:id/registrar', requirePerm('gastos.gestionar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(
    c,
    z.object({ ocurrencia: zFecha, importe: zCentavos.refine((v) => v > 0).optional(), medio: z.enum(MEDIOS_PAGO).optional(), fecha: zFecha.optional(), idem_key: z.string().min(8).max(80) }),
  );
  const previo = await first(c.env.DB, `${SELECT_GASTO} WHERE g.taller_id = ? AND g.idem_key = ?`, s.tallerId, d.idem_key);
  if (previo) return c.json({ ...previo, duplicado: true });
  const r = await first<{ categoria_id: string; concepto: string; importe: number; medio: string; frecuencia: any; dia: number | null; proxima_fecha: string; activo: number }>(
    c.env.DB,
    'SELECT * FROM gastos_recurrentes WHERE taller_id = ? AND id = ?',
    s.tallerId,
    id,
  );
  if (!r) throw notFound('Gasto recurrente');
  if (!r.activo) throw conflict('El gasto recurrente está desactivado');
  if (r.proxima_fecha !== d.ocurrencia) throw conflict('Esa ocurrencia ya fue registrada o salteada. Actualizá la lista.', 'ocurrencia_cambio');
  await validarRefsGasto(c.env.DB, s.tallerId, { categoria_id: r.categoria_id });
  await exigirCajaAbiertaSiCorresponde(c.env.DB, s.tallerId);
  const gid = uid();
  const datos = {
    categoria_id: r.categoria_id, concepto: r.concepto, importe: d.importe ?? r.importe, medio: (d.medio ?? r.medio) as (typeof MEDIOS_PAGO)[number],
    idem_key: d.idem_key, referencia: null, proveedor_id: null, comprobante: null, notas: null,
  };
  const siguiente = siguienteOcurrencia(r.proxima_fecha, r.frecuencia, r.dia);
  await c.env.DB.batch([
    guard(c.env.DB, 'NOT EXISTS (SELECT 1 FROM gastos_recurrentes WHERE taller_id = ? AND id = ? AND proxima_fecha = ? AND activo = 1)', s.tallerId, id, d.ocurrencia),
    ...sentenciasGasto(c.env.DB, s, gid, datos, fechaComercial(s, d.fecha), { id, fecha: d.ocurrencia }),
    c.env.DB.prepare('UPDATE gastos_recurrentes SET proxima_fecha = ? WHERE taller_id = ? AND id = ?').bind(siguiente, s.tallerId, id),
  ]);
  return c.json(await first(c.env.DB, `${SELECT_GASTO} WHERE g.taller_id = ? AND g.id = ?`, s.tallerId, gid), 201);
});

gastos.post('/gastos-recurrentes/:id/saltear', requirePerm('gastos.gestionar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, z.object({ ocurrencia: zFecha }));
  const r = await first<{ frecuencia: any; dia: number | null; proxima_fecha: string }>(c.env.DB, 'SELECT frecuencia, dia, proxima_fecha FROM gastos_recurrentes WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!r) throw notFound('Gasto recurrente');
  if (r.proxima_fecha !== d.ocurrencia) throw conflict('Esa ocurrencia ya fue registrada o salteada. Actualizá la lista.', 'ocurrencia_cambio');
  await c.env.DB.batch([
    guard(c.env.DB, 'NOT EXISTS (SELECT 1 FROM gastos_recurrentes WHERE taller_id = ? AND id = ? AND proxima_fecha = ?)', s.tallerId, id, d.ocurrencia),
    c.env.DB.prepare('UPDATE gastos_recurrentes SET proxima_fecha = ? WHERE taller_id = ? AND id = ?').bind(siguienteOcurrencia(r.proxima_fecha, r.frecuencia, r.dia), s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'gasto_recurrente', id, 'saltear', { ocurrencia: d.ocurrencia }),
  ]);
  return c.json({ ok: true });
});

// ───────────── Resumen financiero ─────────────
export const finanzas = new Hono<AppEnv>();

finanzas.get('/resumen', requirePerm('finanzas.ver'), async (c) => {
  const s = c.get('sesion');
  const { desde, hasta } = query(c, z.object({ desde: zFecha, hasta: zFecha }));
  if (desde > hasta) throw badRequest('El período es inválido');
  const db = c.env.DB;
  const rango = 'm.taller_id = ? AND m.fecha BETWEEN ? AND ?';
  const p = [s.tallerId, desde, hasta];
  const [rubros, porMedio, porMes, porDia, gastosCat, devengado] = await Promise.all([
    all<{ rubro: string; neto: number }>(db, `SELECT m.rubro, SUM(CASE m.tipo WHEN 'ingreso' THEN m.importe ELSE -m.importe END) AS neto FROM caja_movimientos m WHERE ${rango} GROUP BY m.rubro`, ...p),
    all(db, `SELECT m.medio, COALESCE(SUM(CASE m.tipo WHEN 'ingreso' THEN m.importe END),0) AS ingresos, COALESCE(SUM(CASE m.tipo WHEN 'egreso' THEN m.importe END),0) AS egresos FROM caja_movimientos m WHERE ${rango} GROUP BY m.medio ORDER BY ingresos DESC`, ...p),
    all(db, `SELECT substr(m.fecha,1,7) AS periodo, SUM(CASE m.tipo WHEN 'ingreso' THEN m.importe ELSE 0 END) AS ingresos, SUM(CASE m.tipo WHEN 'egreso' THEN m.importe ELSE 0 END) AS egresos FROM caja_movimientos m WHERE ${rango} GROUP BY periodo ORDER BY periodo`, ...p),
    all(db, `SELECT m.fecha AS periodo, SUM(CASE m.tipo WHEN 'ingreso' THEN m.importe ELSE 0 END) AS ingresos, SUM(CASE m.tipo WHEN 'egreso' THEN m.importe ELSE 0 END) AS egresos FROM caja_movimientos m WHERE ${rango} GROUP BY m.fecha ORDER BY m.fecha`, ...p),
    all(
      db,
      `SELECT cg.id, cg.nombre, cg.tipo, COUNT(*) AS cantidad, SUM(g.importe) AS total FROM gastos g JOIN categorias_gasto cg ON cg.taller_id = g.taller_id AND cg.id = g.categoria_id
        WHERE g.taller_id = ? AND g.estado = 'registrado' AND g.fecha BETWEEN ? AND ? GROUP BY cg.id ORDER BY total DESC`,
      ...p,
    ),
    first(
      db,
      `SELECT
         (SELECT COALESCE(SUM(total),0) FROM ventas WHERE taller_id = ? AND estado = 'emitida' AND fecha BETWEEN ? AND ?) AS ventas_emitidas,
         (SELECT COUNT(*) FROM ventas WHERE taller_id = ? AND estado = 'emitida' AND fecha BETWEEN ? AND ?) AS ventas_cantidad,
         (SELECT COALESCE(SUM(total),0) FROM compras WHERE taller_id = ? AND estado = 'registrada' AND fecha BETWEEN ? AND ?) AS compras_registradas,
         (SELECT COALESCE(SUM(total - cobrado),0) FROM ventas WHERE taller_id = ? AND estado = 'emitida') AS por_cobrar,
         (SELECT COALESCE(SUM(total),0) FROM compras WHERE taller_id = ? AND estado = 'registrada')
           - (SELECT COALESCE(SUM(importe),0) FROM pagos_proveedor WHERE taller_id = ? AND estado = 'registrado') AS por_pagar`,
      ...p, ...p, ...p, s.tallerId, s.tallerId, s.tallerId,
    ),
  ]);
  const neto = (r: string) => rubros.find((x) => x.rubro === r)?.neto ?? 0;
  const ingresos = neto('cobro') + neto('otro_ingreso');
  const egresos = -(neto('pago_proveedor') + neto('gasto'));
  return c.json({
    desde, hasta,
    ingresos: { cobros: neto('cobro'), otros: neto('otro_ingreso'), total: ingresos },
    egresos: { pagos_proveedor: -neto('pago_proveedor'), gastos: -neto('gasto'), total: egresos },
    resultado: ingresos - egresos,
    por_medio: porMedio,
    // Mensual si el período abarca más de 62 días; diario en otro caso.
    serie: (Date.parse(hasta) - Date.parse(desde)) / 86400_000 > 62 ? porMes : porDia,
    serie_tipo: (Date.parse(hasta) - Date.parse(desde)) / 86400_000 > 62 ? 'mes' : 'dia',
    gastos_por_categoria: gastosCat,
    devengado,
  });
});
void IMPORTE_FIRMADO_SQL;
