// Caja diaria: apertura, movimientos, arqueos, cierre, historial y reportes.
//
// El dinero que entra o sale por operaciones comerciales (cobros, pagos a proveedores, gastos) se registra en el libro
// `caja_movimientos` desde esos mismos módulos, dentro de su transacción. Acá sólo se administran las sesiones de caja
// y los ingresos manuales; los egresos manuales son gastos (ver gastos.ts) para no contabilizarlos dos veces.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, conflict, forbidden, notFound, query, zCentavos, zFecha, zTextoOpt } from '../lib/http';
import { all, auditar, first, guard, hoy, like, SEQ_VALOR, seqIncrementar, uid, type Stmt } from '../lib/db';
import { requirePerm } from '../lib/auth';
import { tienePermiso } from '../../shared/permisos';
import { MEDIOS_PAGO } from '../../shared/dominio';
import { estadoCaja, guardCajaObligatoria, IMPORTE_FIRMADO_SQL, reversoDeOrigen, sentenciaMovimiento } from '../lib/caja';
import { fechaComercial } from '../lib/fechas';

export const caja = new Hono<AppEnv>();

interface Sesion {
  id: string;
  numero: number;
  estado: 'abierta' | 'cerrada';
  fecha: string;
  saldo_inicial: number;
  abierta_por: string | null;
  abierta_at: string;
  cerrada_por: string | null;
  cerrada_at: string | null;
  efectivo_esperado: number | null;
  efectivo_declarado: number | null;
  diferencia: number | null;
  notas_apertura: string | null;
  notas_cierre: string | null;
  abierta_por_nombre?: string | null;
  cerrada_por_nombre?: string | null;
}

const SELECT_SESION = `SELECT cs.*, ua.nombre AS abierta_por_nombre, uc.nombre AS cerrada_por_nombre
  FROM caja_sesiones cs
  LEFT JOIN usuarios ua ON ua.taller_id = cs.taller_id AND ua.id = cs.abierta_por
  LEFT JOIN usuarios uc ON uc.taller_id = cs.taller_id AND uc.id = cs.cerrada_por`;

/** Totales de una sesión por medio y por rubro, con el efectivo esperado. */
async function resumenSesion(db: D1Database, tallerId: string, ses: Sesion) {
  const [porMedio, porRubro, cantidad] = await Promise.all([
    all<{ medio: string; ingresos: number; egresos: number }>(
      db,
      `SELECT medio, COALESCE(SUM(CASE tipo WHEN 'ingreso' THEN importe END),0) AS ingresos, COALESCE(SUM(CASE tipo WHEN 'egreso' THEN importe END),0) AS egresos
         FROM caja_movimientos WHERE taller_id = ? AND sesion_id = ? GROUP BY medio ORDER BY medio`,
      tallerId,
      ses.id,
    ),
    all<{ rubro: string; neto: number }>(db, `SELECT rubro, SUM(${IMPORTE_FIRMADO_SQL}) AS neto FROM caja_movimientos WHERE taller_id = ? AND sesion_id = ? GROUP BY rubro`, tallerId, ses.id),
    first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM caja_movimientos WHERE taller_id = ? AND sesion_id = ?', tallerId, ses.id),
  ]);
  const medios = porMedio.map((m) => ({ ...m, neto: m.ingresos - m.egresos }));
  const efectivoNeto = medios.find((m) => m.medio === 'efectivo')?.neto ?? 0;
  return {
    por_medio: medios,
    por_rubro: porRubro,
    movimientos: cantidad?.n ?? 0,
    efectivo_esperado: ses.saldo_inicial + efectivoNeto,
  };
}

// ───────────── Estado ─────────────
caja.get('/estado', requirePerm('caja.operar'), async (c) => {
  const s = c.get('sesion');
  const est = await estadoCaja(c.env.DB, s.tallerId);
  const ses = est.sesionId ? await first<Sesion>(c.env.DB, `${SELECT_SESION} WHERE cs.taller_id = ? AND cs.id = ?`, s.tallerId, est.sesionId) : null;
  const ultima = await first<{ efectivo_declarado: number | null; cerrada_at: string | null; numero: number }>(
    c.env.DB,
    "SELECT efectivo_declarado, cerrada_at, numero FROM caja_sesiones WHERE taller_id = ? AND estado = 'cerrada' ORDER BY numero DESC LIMIT 1",
    s.tallerId,
  );
  const sinCaja = await first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM caja_movimientos WHERE taller_id = ? AND sesion_id IS NULL AND fecha = ?', s.tallerId, hoy());
  return c.json({
    obligatoria: est.obligatoria,
    sesion: ses ? { ...ses, resumen: await resumenSesion(c.env.DB, s.tallerId, ses) } : null,
    ultima_cierre: ultima,
    sin_caja_hoy: sinCaja?.n ?? 0,
  });
});

// ───────────── Apertura ─────────────
caja.post('/abrir', requirePerm('caja.operar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, z.object({ saldo_inicial: zCentavos.default(0), notas: zTextoOpt(300) }));
  if ((await estadoCaja(c.env.DB, s.tallerId)).sesionId) throw conflict('Ya hay una caja abierta', 'caja_abierta');
  const id = uid();
  try {
    await c.env.DB.batch([
      ...seqIncrementar(c.env.DB, s.tallerId, 'caja'),
      c.env.DB.prepare(
        `INSERT INTO caja_sesiones (id, taller_id, numero, fecha, saldo_inicial, notas_apertura, abierta_por) VALUES (?, ?, ${SEQ_VALOR}, ?, ?, ?, ?)`,
      ).bind(id, s.tallerId, s.tallerId, 'caja', hoy(), d.saldo_inicial, d.notas, s.usuarioId),
      auditar(c.env.DB, s.tallerId, s.usuarioId, 'caja', id, 'abrir', { saldo_inicial: d.saldo_inicial }),
    ]);
  } catch (e) {
    // Dos usuarios abriendo a la vez: el índice único parcial deja pasar sólo a uno.
    if (String(e).includes('caja_sesiones')) throw conflict('Ya hay una caja abierta', 'caja_abierta');
    throw e;
  }
  return c.json(await first(c.env.DB, `${SELECT_SESION} WHERE cs.taller_id = ? AND cs.id = ?`, s.tallerId, id), 201);
});

// ───────────── Movimientos ─────────────
const SELECT_MOV = `SELECT m.*, u.nombre AS usuario, cs.numero AS sesion_numero,
    CASE m.origen_tipo WHEN 'reverso' THEN o.origen_tipo ELSE m.origen_tipo END AS ref_tipo,
    CASE WHEN m.origen_tipo = 'cobro' THEN cm.cobro_id
         WHEN m.origen_tipo = 'reverso' AND o.origen_tipo = 'cobro' THEN cmo.cobro_id
         WHEN m.origen_tipo = 'reverso' THEN o.origen_id
         ELSE m.origen_id END AS ref_id,
    EXISTS (SELECT 1 FROM caja_movimientos r WHERE r.taller_id = m.taller_id AND r.origen_tipo = 'reverso' AND r.origen_id = m.id) AS revertido
  FROM caja_movimientos m
  LEFT JOIN usuarios u ON u.taller_id = m.taller_id AND u.id = m.usuario_id
  LEFT JOIN caja_sesiones cs ON cs.taller_id = m.taller_id AND cs.id = m.sesion_id
  LEFT JOIN caja_movimientos o ON o.taller_id = m.taller_id AND o.id = m.origen_id AND m.origen_tipo = 'reverso'
  LEFT JOIN cobro_medios cm ON cm.taller_id = m.taller_id AND cm.id = m.origen_id AND m.origen_tipo = 'cobro'
  LEFT JOIN cobro_medios cmo ON cmo.taller_id = m.taller_id AND cmo.id = o.origen_id AND o.origen_tipo = 'cobro'`;

caja.get('/movimientos', requirePerm('caja.operar'), async (c) => {
  const s = c.get('sesion');
  const f = query(
    c,
    z.object({
      sesion_id: z.string().optional(),
      desde: z.string().optional(),
      hasta: z.string().optional(),
      medio: z.string().optional(),
      tipo: z.string().optional(),
      rubro: z.string().optional(),
      q: z.string().optional(),
      limite: z.coerce.number().int().min(1).max(500).default(300),
    }),
  );
  const cond = ['m.taller_id = ?'];
  const params: unknown[] = [s.tallerId];
  if (tienePermiso(s.rol, 'finanzas.ver')) {
    if (f.sesion_id) (cond.push('m.sesion_id = ?'), params.push(f.sesion_id));
    if (f.desde) (cond.push('m.fecha >= ?'), params.push(f.desde));
    if (f.hasta) (cond.push('m.fecha <= ?'), params.push(f.hasta));
  } else {
    // Sin permiso de finanzas sólo se ve la caja abierta actual.
    cond.push("m.sesion_id = (SELECT id FROM caja_sesiones WHERE taller_id = m.taller_id AND estado = 'abierta')");
  }
  if (f.medio) (cond.push('m.medio = ?'), params.push(f.medio));
  if (f.tipo) (cond.push('m.tipo = ?'), params.push(f.tipo));
  if (f.rubro) (cond.push('m.rubro = ?'), params.push(f.rubro));
  if (f.q) (cond.push('(m.concepto LIKE ? OR m.referencia LIKE ?)'), params.push(like(f.q), like(f.q)));
  return c.json(await all(c.env.DB, `${SELECT_MOV} WHERE ${cond.join(' AND ')} ORDER BY m.created_at DESC, m.id LIMIT ?`, ...params, f.limite));
});

/** Ingreso manual (aporte, venta no registrada, sobrante…). Los egresos manuales se cargan como gastos. */
caja.post('/movimientos', requirePerm('caja.operar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(
    c,
    z.object({
      medio: z.enum(MEDIOS_PAGO),
      importe: zCentavos.refine((v) => v > 0, 'el importe debe ser mayor a 0'),
      concepto: z.string().trim().min(3).max(200),
      referencia: zTextoOpt(120),
      fecha: zFecha.optional(),
      idem_key: z.string().min(8).max(80),
    }),
  );
  const previo = await first<{ id: string }>(c.env.DB, 'SELECT id FROM caja_movimientos WHERE taller_id = ? AND idem_key = ?', s.tallerId, d.idem_key);
  if (previo) return c.json({ id: previo.id, duplicado: true });
  const est = await estadoCaja(c.env.DB, s.tallerId);
  if (est.obligatoria && !est.sesionId) throw conflict('La caja está cerrada. Abrí la caja para registrar movimientos.', 'caja_cerrada');
  const fecha = fechaComercial(s, d.fecha);
  const id = uid();
  await c.env.DB.batch([
    guardCajaObligatoria(c.env.DB, s.tallerId),
    sentenciaMovimiento(c.env.DB, s.tallerId, {
      tipo: 'ingreso', rubro: 'otro_ingreso', medio: d.medio, importe: d.importe, concepto: d.concepto, referencia: d.referencia,
      origenTipo: 'manual', origenId: id, fecha, idemKey: d.idem_key, usuarioId: s.usuarioId,
    }),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'caja_movimiento', id, 'ingreso_manual', { importe: d.importe, medio: d.medio }),
  ]);
  return c.json({ id }, 201);
});

caja.post('/movimientos/:id/anular', requirePerm('caja.operar', 'gastos.gestionar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const { motivo } = await body(c, z.object({ motivo: z.string().trim().min(3).max(300) }));
  const m = await first<{ origen_tipo: string; tipo: string }>(c.env.DB, 'SELECT origen_tipo, tipo FROM caja_movimientos WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!m) throw notFound('Movimiento');
  if (m.origen_tipo !== 'manual') throw conflict('Sólo se anulan desde acá los ingresos manuales. Los cobros, pagos y gastos se anulan en su propio módulo.');
  if (await first(c.env.DB, "SELECT 1 FROM caja_movimientos WHERE taller_id = ? AND origen_tipo = 'reverso' AND origen_id = ?", s.tallerId, id)) throw conflict('El movimiento ya fue anulado');
  await c.env.DB.batch([
    guardCajaObligatoria(c.env.DB, s.tallerId),
    guard(c.env.DB, "EXISTS (SELECT 1 FROM caja_movimientos WHERE taller_id = ? AND origen_tipo = 'reverso' AND origen_id = ?)", s.tallerId, id),
    reversoDeOrigen(c.env.DB, s.tallerId, 'manual', id, s.usuarioId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'caja_movimiento', id, 'anular', { motivo }),
  ]);
  return c.json({ ok: true });
});

// ───────────── Arqueo y cierre ─────────────
const ESPERADO_EFECTIVO = `((SELECT saldo_inicial FROM caja_sesiones WHERE taller_id = ? AND id = ?)
  + COALESCE((SELECT SUM(${IMPORTE_FIRMADO_SQL}) FROM caja_movimientos WHERE taller_id = ? AND sesion_id = ? AND medio = 'efectivo'), 0))`;

async function sesionAbierta(db: D1Database, tallerId: string): Promise<Sesion> {
  const est = await estadoCaja(db, tallerId);
  if (!est.sesionId) throw conflict('No hay una caja abierta', 'caja_cerrada');
  return (await first<Sesion>(db, `${SELECT_SESION} WHERE cs.taller_id = ? AND cs.id = ?`, tallerId, est.sesionId))!;
}

/** Arqueo parcial: cuenta el efectivo y lo compara con lo esperado, sin cerrar la caja. */
caja.post('/arqueos', requirePerm('caja.operar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, z.object({ contado: zCentavos, detalle: z.record(z.string(), z.number().int().min(0).max(1e6)).optional(), notas: zTextoOpt(300) }));
  const ses = await sesionAbierta(c.env.DB, s.tallerId);
  const id = uid();
  await c.env.DB.batch([
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM caja_sesiones WHERE taller_id = ? AND id = ? AND estado = 'abierta')", s.tallerId, ses.id),
    c.env.DB.prepare(
      `INSERT INTO caja_arqueos (id, taller_id, sesion_id, esperado, contado, diferencia, detalle, notas, usuario_id)
       SELECT ?, ?, ?, e.v, ?, ? - e.v, ?, ?, ? FROM (SELECT ${ESPERADO_EFECTIVO} AS v) e`,
    ).bind(id, s.tallerId, ses.id, d.contado, d.contado, d.detalle ? JSON.stringify(d.detalle) : null, d.notas, s.usuarioId, s.tallerId, ses.id, s.tallerId, ses.id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'caja', ses.id, 'arqueo', { contado: d.contado }),
  ]);
  return c.json(await first(c.env.DB, 'SELECT * FROM caja_arqueos WHERE taller_id = ? AND id = ?', s.tallerId, id), 201);
});

caja.post('/cerrar', requirePerm('caja.operar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(
    c,
    z.object({
      declarados: z.array(z.object({ medio: z.enum(MEDIOS_PAGO), importe: zCentavos })).min(1).max(MEDIOS_PAGO.length),
      // Efectivo esperado que vio quien contó: si cambió (otro usuario registró algo), hay que volver a contar.
      esperado_visto: z.number().int().nullish(),
      notas: zTextoOpt(500),
    }),
  );
  const medios = d.declarados.map((x) => x.medio);
  if (new Set(medios).size !== medios.length) throw badRequest('Un medio de pago aparece más de una vez');
  const efectivo = d.declarados.find((x) => x.medio === 'efectivo');
  if (!efectivo) throw badRequest('Declará el efectivo contado');
  const ses = await sesionAbierta(c.env.DB, s.tallerId);
  const res = await resumenSesion(c.env.DB, s.tallerId, ses);
  if (d.esperado_visto != null && d.esperado_visto !== res.efectivo_esperado) {
    throw conflict('Los movimientos de la caja cambiaron mientras contabas. Revisá los importes y volvé a confirmar.', 'caja_cambio');
  }
  const diferencia = efectivo.importe - res.efectivo_esperado;
  if (diferencia !== 0 && (d.notas ?? '').length < 3) throw badRequest('Hay una diferencia de efectivo: explicala en las notas del cierre');

  // Medios con movimientos que no se declararon: se informa el esperado y queda sin diferencia (a conciliar con el extracto/posnet).
  const todos = new Set<string>([...medios, ...res.por_medio.map((m) => m.medio)]);
  const declarados = new Map(d.declarados.map((x) => [x.medio as string, x.importe]));
  const stmts: Stmt[] = [
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM caja_sesiones WHERE taller_id = ? AND id = ? AND estado = 'abierta')", s.tallerId, ses.id),
  ];
  if (d.esperado_visto != null) stmts.push(guard(c.env.DB, `${ESPERADO_EFECTIVO} <> ?`, s.tallerId, ses.id, s.tallerId, ses.id, d.esperado_visto));
  for (const medio of todos) {
    const esperado = `COALESCE((SELECT SUM(${IMPORTE_FIRMADO_SQL}) FROM caja_movimientos WHERE taller_id = ? AND sesion_id = ? AND medio = ?), 0)${medio === 'efectivo' ? ' + (SELECT saldo_inicial FROM caja_sesiones WHERE taller_id = ? AND id = ?)' : ''}`;
    const extra = medio === 'efectivo' ? [s.tallerId, ses.id] : [];
    const decl = declarados.get(medio);
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO caja_sesion_medios (taller_id, sesion_id, medio, esperado, declarado, diferencia)
         SELECT ?, ?, ?, e.v, COALESCE(?, e.v), COALESCE(?, e.v) - e.v FROM (SELECT ${esperado} AS v) e`,
      ).bind(s.tallerId, ses.id, medio, decl ?? null, decl ?? null, s.tallerId, ses.id, medio, ...extra),
    );
  }
  stmts.push(
    c.env.DB.prepare(
      `UPDATE caja_sesiones SET estado = 'cerrada', cerrada_por = ?, cerrada_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), notas_cierre = ?,
              efectivo_esperado = (SELECT esperado FROM caja_sesion_medios WHERE taller_id = ? AND sesion_id = ? AND medio = 'efectivo'),
              efectivo_declarado = (SELECT declarado FROM caja_sesion_medios WHERE taller_id = ? AND sesion_id = ? AND medio = 'efectivo'),
              diferencia = (SELECT diferencia FROM caja_sesion_medios WHERE taller_id = ? AND sesion_id = ? AND medio = 'efectivo')
        WHERE taller_id = ? AND id = ? AND estado = 'abierta'`,
    ).bind(s.usuarioId, d.notas, s.tallerId, ses.id, s.tallerId, ses.id, s.tallerId, ses.id, s.tallerId, ses.id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'caja', ses.id, 'cerrar', { declarado: efectivo.importe, esperado: res.efectivo_esperado }),
  );
  await c.env.DB.batch(stmts);
  return c.json(await detalleSesion(c.env.DB, s.tallerId, ses.id));
});

// ───────────── Historial ─────────────
async function detalleSesion(db: D1Database, tallerId: string, id: string) {
  const ses = await first<Sesion>(db, `${SELECT_SESION} WHERE cs.taller_id = ? AND cs.id = ?`, tallerId, id);
  if (!ses) return null;
  const [resumen, cierre, arqueos] = await Promise.all([
    resumenSesion(db, tallerId, ses),
    all(db, 'SELECT medio, esperado, declarado, diferencia FROM caja_sesion_medios WHERE taller_id = ? AND sesion_id = ? ORDER BY medio', tallerId, id),
    all(
      db,
      `SELECT ar.*, u.nombre AS usuario FROM caja_arqueos ar LEFT JOIN usuarios u ON u.taller_id = ar.taller_id AND u.id = ar.usuario_id
        WHERE ar.taller_id = ? AND ar.sesion_id = ? ORDER BY ar.created_at`,
      tallerId,
      id,
    ),
  ]);
  return { ...ses, resumen, cierre, arqueos };
}

caja.get('/sesiones', requirePerm('finanzas.ver'), async (c) => {
  const s = c.get('sesion');
  const f = query(c, z.object({ desde: z.string().optional(), hasta: z.string().optional(), estado: z.string().optional(), con_diferencia: z.string().optional(), limite: z.coerce.number().int().min(1).max(200).default(100) }));
  const cond = ['cs.taller_id = ?'];
  const params: unknown[] = [s.tallerId];
  if (f.desde) (cond.push('cs.fecha >= ?'), params.push(f.desde));
  if (f.hasta) (cond.push('cs.fecha <= ?'), params.push(f.hasta));
  if (f.estado) (cond.push('cs.estado = ?'), params.push(f.estado));
  if (f.con_diferencia) cond.push('COALESCE(cs.diferencia, 0) <> 0');
  return c.json(await all(c.env.DB, `${SELECT_SESION} WHERE ${cond.join(' AND ')} ORDER BY cs.numero DESC LIMIT ?`, ...params, f.limite));
});

caja.get('/sesiones/:id', requirePerm('caja.operar'), async (c) => {
  const s = c.get('sesion');
  const det = await detalleSesion(c.env.DB, s.tallerId, c.req.param('id'));
  if (!det) throw notFound('Caja');
  // Las cajas ya cerradas son historial: las ve quien tiene permiso de finanzas o quien participó en ella.
  const participa = det.abierta_por === s.usuarioId || det.cerrada_por === s.usuarioId;
  if (det.estado === 'cerrada' && !tienePermiso(s.rol, 'finanzas.ver') && !participa) throw forbidden();
  return c.json(det);
});

// ───────────── Reportes ─────────────
caja.get('/reportes', requirePerm('finanzas.ver'), async (c) => {
  const s = c.get('sesion');
  const { desde, hasta } = query(c, z.object({ desde: zFecha, hasta: zFecha }));
  const base = 'm.taller_id = ? AND m.fecha BETWEEN ? AND ?';
  const p = [s.tallerId, desde, hasta];
  const [porMedio, porRubro, porDia, porUsuario, sesiones, totales] = await Promise.all([
    all(c.env.DB, `SELECT m.medio, COALESCE(SUM(CASE m.tipo WHEN 'ingreso' THEN m.importe END),0) AS ingresos, COALESCE(SUM(CASE m.tipo WHEN 'egreso' THEN m.importe END),0) AS egresos FROM caja_movimientos m WHERE ${base} GROUP BY m.medio ORDER BY ingresos DESC`, ...p),
    all(c.env.DB, `SELECT m.rubro, SUM(CASE m.tipo WHEN 'ingreso' THEN m.importe ELSE -m.importe END) AS neto FROM caja_movimientos m WHERE ${base} GROUP BY m.rubro`, ...p),
    all(c.env.DB, `SELECT m.fecha, COALESCE(SUM(CASE m.tipo WHEN 'ingreso' THEN m.importe END),0) AS ingresos, COALESCE(SUM(CASE m.tipo WHEN 'egreso' THEN m.importe END),0) AS egresos FROM caja_movimientos m WHERE ${base} GROUP BY m.fecha ORDER BY m.fecha`, ...p),
    all(c.env.DB, `SELECT COALESCE(u.nombre, 'Sin usuario') AS usuario, COUNT(*) AS movimientos, COALESCE(SUM(CASE m.tipo WHEN 'ingreso' THEN m.importe END),0) AS ingresos, COALESCE(SUM(CASE m.tipo WHEN 'egreso' THEN m.importe END),0) AS egresos FROM caja_movimientos m LEFT JOIN usuarios u ON u.taller_id = m.taller_id AND u.id = m.usuario_id WHERE ${base} GROUP BY m.usuario_id ORDER BY movimientos DESC`, ...p),
    all(c.env.DB, `SELECT cs.numero, cs.fecha, cs.estado, cs.saldo_inicial, cs.efectivo_esperado, cs.efectivo_declarado, cs.diferencia FROM caja_sesiones cs WHERE cs.taller_id = ? AND cs.fecha BETWEEN ? AND ? ORDER BY cs.numero`, ...p),
    first(c.env.DB, `SELECT COUNT(*) AS movimientos, COALESCE(SUM(CASE m.tipo WHEN 'ingreso' THEN m.importe END),0) AS ingresos, COALESCE(SUM(CASE m.tipo WHEN 'egreso' THEN m.importe END),0) AS egresos, SUM(m.sesion_id IS NULL) AS sin_caja FROM caja_movimientos m WHERE ${base}`, ...p),
  ]);
  const difTotal = (sesiones as Array<{ diferencia: number | null }>).reduce((a, x) => a + (x.diferencia ?? 0), 0);
  return c.json({ por_medio: porMedio, por_rubro: porRubro, por_dia: porDia, por_usuario: porUsuario, sesiones, totales, diferencia_total: difTotal });
});
