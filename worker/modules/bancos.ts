// Cuentas bancarias, movimientos, transferencias, depósitos/extracciones de efectivo y conciliación manual.
//
// El libro de cada cuenta es banco_movimientos (ver lib/banco.ts). Los cobros, pagos y gastos asignados a una cuenta
// escriben su movimiento desde su propio módulo; acá sólo se cargan los hechos que nacen en el banco.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, conflict, forbidden, notFound, query, zCentavos, zFecha, zId, zTextoOpt } from '../lib/http';
import { all, auditar, first, guard, hoy, lotes, like, SEQ_VALOR, seqIncrementar, uid, type Stmt } from '../lib/db';
import { requirePerm } from '../lib/auth';
import { tienePermiso } from '../../shared/permisos';
import { MONEDAS, TIPOS_CUENTA_BANCARIA, cuitValido } from '../../shared/dominio';
import { guardCuentaActiva, saldosCuentas, sentenciaMovBanco, sentenciaReversosBanco, SIGNO_BANCO_SQL } from '../lib/banco';
import { exigirCajaAbiertaSiCorresponde, guardCajaObligatoria, IMPORTE_FIRMADO_SQL, reversoDeOrigen, sentenciaMovimiento } from '../lib/caja';
import { fechaComercial } from '../lib/fechas';

export const bancos = new Hono<AppEnv>();

// Selector mínimo para cobrar/pagar: lo usa quien registra operaciones (sin saldos).
bancos.get('/selector', requirePerm('caja.operar'), async (c) => {
  const s = c.get('sesion');
  return c.json(await all(c.env.DB, "SELECT id, nombre, banco, alias, moneda FROM cuentas_bancarias WHERE taller_id = ? AND activa = 1 AND moneda = 'ARS' ORDER BY nombre", s.tallerId));
});

bancos.use('*', async (c, next) => {
  if (c.req.path.endsWith('/selector')) return next();
  return requirePerm('bancos.gestionar')(c, next);
});

// ───────────── Cuentas ─────────────
const zCuenta = z.object({
  nombre: z.string().trim().min(2).max(80),
  banco: z.string().trim().min(2).max(80),
  tipo: z.enum(TIPOS_CUENTA_BANCARIA).default('cuenta_corriente'),
  alias: zTextoOpt(60),
  cbu: z.preprocess((v) => (v === '' ? null : v), z.string().trim().regex(/^\d{22}$/, 'el CBU/CVU tiene 22 dígitos').nullish()).transform((v) => v ?? null),
  titular: zTextoOpt(120),
  cuit_titular: zTextoOpt(20),
  moneda: z.enum(MONEDAS).default('ARS'),
  saldo_inicial: z.number().int().min(-1e13).max(1e13).default(0),
  fecha_saldo_inicial: zFecha.nullish(),
  notas: zTextoOpt(300),
  activa: z.boolean().optional(),
});

bancos.get('/cuentas', async (c) => {
  const s = c.get('sesion');
  const { todas } = query(c, z.object({ todas: z.string().optional() }));
  const cuentas = await all<any>(c.env.DB, `SELECT * FROM cuentas_bancarias WHERE taller_id = ? ${todas ? '' : 'AND activa = 1'} ORDER BY activa DESC, nombre`, s.tallerId);
  const saldos = await saldosCuentas(c.env.DB, s.tallerId);
  return c.json(cuentas.map((x) => ({ ...x, ...(saldos.find((v) => v.id === x.id) ?? { saldo: x.saldo_inicial, saldo_conciliado: x.saldo_inicial, pendientes: 0 }) })));
});

bancos.get('/cuentas/:id', async (c) => {
  const s = c.get('sesion');
  const cuenta = await first<any>(c.env.DB, 'SELECT * FROM cuentas_bancarias WHERE taller_id = ? AND id = ?', s.tallerId, c.req.param('id'));
  if (!cuenta) throw notFound('Cuenta bancaria');
  const [sal] = await saldosCuentas(c.env.DB, s.tallerId, cuenta.id);
  return c.json({ ...cuenta, ...sal });
});

function validarDatosCuenta(d: { cuit_titular?: string | null }) {
  if (d.cuit_titular && !cuitValido(d.cuit_titular)) throw badRequest('El CUIT del titular no es válido');
}

bancos.post('/cuentas', async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zCuenta);
  validarDatosCuenta(d);
  const id = uid();
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `INSERT INTO cuentas_bancarias (id, taller_id, nombre, banco, tipo, alias, cbu, titular, cuit_titular, moneda, saldo_inicial, fecha_saldo_inicial, notas)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, s.tallerId, d.nombre, d.banco, d.tipo, d.alias, d.cbu, d.titular, d.cuit_titular, d.moneda, d.saldo_inicial, d.fecha_saldo_inicial ?? hoy(), d.notas),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'cuenta_bancaria', id, 'crear', { nombre: d.nombre, saldo_inicial: d.saldo_inicial }),
  ]);
  return c.json({ id }, 201);
});

bancos.put('/cuentas/:id', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, zCuenta.partial());
  validarDatosCuenta(d);
  const actual = await first<{ moneda: string; saldo_inicial: number }>(c.env.DB, 'SELECT moneda, saldo_inicial FROM cuentas_bancarias WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!actual) throw notFound('Cuenta bancaria');
  const cambiaSaldo = (d.moneda !== undefined && d.moneda !== actual.moneda) || (d.saldo_inicial !== undefined && d.saldo_inicial !== actual.saldo_inicial);
  const movs = cambiaSaldo ? await first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM banco_movimientos WHERE taller_id = ? AND cuenta_id = ?', s.tallerId, id) : null;
  if (movs?.n) throw conflict('La cuenta ya tiene movimientos: no se puede cambiar su moneda ni su saldo inicial. Usá un ajuste autorizado.', 'cuenta_con_movimientos');
  if (d.activa === false) {
    const pend = await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM cheques WHERE taller_id = ? AND cuenta_id = ? AND estado = 'depositado'", s.tallerId, id);
    if (pend?.n) throw conflict('La cuenta tiene cheques depositados pendientes de acreditar', 'cuenta_con_cheques');
  }
  const cols = ['nombre', 'banco', 'tipo', 'alias', 'cbu', 'titular', 'cuit_titular', 'moneda', 'saldo_inicial', 'fecha_saldo_inicial', 'notas', 'activa'] as const;
  const datos: Record<string, unknown> = { ...d };
  if (d.activa !== undefined) datos.activa = d.activa ? 1 : 0;
  const keys = cols.filter((k) => datos[k] !== undefined);
  if (!keys.length) return c.json({ ok: true });
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE cuentas_bancarias SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE taller_id = ? AND id = ?`).bind(...keys.map((k) => datos[k]), s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'cuenta_bancaria', id, 'modificar', d),
  ]);
  return c.json({ ok: true });
});

// ───────────── Movimientos ─────────────
const SELECT_MOV = `SELECT m.*, cb.nombre AS cuenta, cb.moneda, u.nombre AS usuario,
    CASE m.origen_tipo WHEN 'cobro_medio' THEN 'cobro' WHEN 'reverso' THEN o.categoria ELSE m.categoria END AS ref_tipo,
    CASE WHEN m.origen_tipo = 'cobro_medio' THEN cm.cobro_id WHEN m.origen_tipo = 'reverso' THEN COALESCE(cmo.cobro_id, o.origen_id) ELSE m.origen_id END AS ref_id,
    EXISTS (SELECT 1 FROM banco_movimientos r WHERE r.taller_id = m.taller_id AND r.origen_tipo = 'reverso' AND r.origen_id = m.id) AS revertido
  FROM banco_movimientos m
  JOIN cuentas_bancarias cb ON cb.taller_id = m.taller_id AND cb.id = m.cuenta_id
  LEFT JOIN usuarios u ON u.taller_id = m.taller_id AND u.id = m.usuario_id
  LEFT JOIN banco_movimientos o ON o.taller_id = m.taller_id AND o.id = m.origen_id AND m.origen_tipo = 'reverso'
  LEFT JOIN cobro_medios cm ON cm.taller_id = m.taller_id AND cm.id = m.origen_id AND m.origen_tipo = 'cobro_medio'
  LEFT JOIN cobro_medios cmo ON cmo.taller_id = m.taller_id AND cmo.id = o.origen_id AND o.origen_tipo = 'cobro_medio'`;

bancos.get('/movimientos', async (c) => {
  const s = c.get('sesion');
  const f = query(
    c,
    z.object({
      cuenta_id: z.string().optional(), desde: z.string().optional(), hasta: z.string().optional(), tipo: z.string().optional(), categoria: z.string().optional(),
      conciliado: z.enum(['0', '1']).optional(), q: z.string().optional(), limite: z.coerce.number().int().min(1).max(1000).default(300),
    }),
  );
  const cond = ['m.taller_id = ?'];
  const params: unknown[] = [s.tallerId];
  if (f.cuenta_id) (cond.push('m.cuenta_id = ?'), params.push(f.cuenta_id));
  if (f.desde) (cond.push('m.fecha >= ?'), params.push(f.desde));
  if (f.hasta) (cond.push('m.fecha <= ?'), params.push(f.hasta));
  if (f.tipo) (cond.push('m.tipo = ?'), params.push(f.tipo));
  if (f.categoria) (cond.push('m.categoria = ?'), params.push(f.categoria));
  if (f.conciliado) (cond.push('m.conciliado = ?'), params.push(Number(f.conciliado)));
  if (f.q) (cond.push('(m.concepto LIKE ? OR m.referencia LIKE ?)'), params.push(like(f.q), like(f.q)));
  return c.json(await all(c.env.DB, `${SELECT_MOV} WHERE ${cond.join(' AND ')} ORDER BY m.fecha DESC, m.created_at DESC, m.id LIMIT ?`, ...params, f.limite));
});

/** Operación ya registrada con esa clave. Para una transferencia devuelve el id de la transferencia (no el del asiento). */
async function idemPrevio(db: D1Database, tallerId: string, key: string) {
  const r = await first<{ id: string; transferencia_id: string | null }>(db, 'SELECT id, transferencia_id FROM banco_movimientos WHERE taller_id = ? AND idem_key = ?', tallerId, key);
  return r && { id: r.transferencia_id ?? r.id };
}

async function cuentaActiva(db: D1Database, tallerId: string, id: string, soloPesos = false) {
  const cu = await first<{ nombre: string; activa: number; moneda: string }>(db, 'SELECT nombre, activa, moneda FROM cuentas_bancarias WHERE taller_id = ? AND id = ?', tallerId, id);
  if (!cu) throw badRequest('Cuenta bancaria inexistente');
  if (!cu.activa) throw badRequest(`La cuenta "${cu.nombre}" está desactivada`);
  if (soloPesos && cu.moneda !== 'ARS') throw badRequest('El efectivo de la caja se maneja en pesos: usá una cuenta en pesos');
  return cu;
}

const zMov = z.object({ cuenta_id: zId, importe: zCentavos.refine((v) => v > 0, 'el importe debe ser mayor a 0'), fecha: zFecha.optional(), concepto: z.string().trim().min(3).max(200), referencia: zTextoOpt(120), idem_key: z.string().min(8).max(80) });

/** Ingreso o egreso que nace en el banco y no pasó por caja (intereses, comisiones, débitos automáticos, acreditaciones sin comprobante). */
bancos.post('/movimientos', async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zMov.extend({ tipo: z.enum(['ingreso', 'egreso']) }));
  const previo = await idemPrevio(c.env.DB, s.tallerId, d.idem_key);
  if (previo) return c.json({ id: previo.id, duplicado: true });
  await cuentaActiva(c.env.DB, s.tallerId, d.cuenta_id);
  const fecha = fechaComercial(s, d.fecha);
  const id = uid();
  await c.env.DB.batch([
    guardCuentaActiva(c.env.DB, s.tallerId, d.cuenta_id),
    sentenciaMovBanco(c.env.DB, s.tallerId, {
      id, cuentaId: d.cuenta_id, tipo: d.tipo, categoria: 'manual', importe: d.importe, concepto: d.concepto, referencia: d.referencia,
      origenTipo: 'manual', origenId: id, fecha, afectaResultado: true, idemKey: d.idem_key, usuarioId: s.usuarioId,
    }),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'banco_movimiento', id, d.tipo === 'ingreso' ? 'ingreso_manual' : 'egreso_manual', { importe: d.importe, cuenta_id: d.cuenta_id }),
  ]);
  return c.json({ id }, 201);
});

const EFECTIVO_SESION_ABIERTA = `COALESCE((SELECT saldo_inicial FROM caja_sesiones WHERE taller_id = ? AND estado = 'abierta'), 0)
  + COALESCE((SELECT SUM(${IMPORTE_FIRMADO_SQL}) FROM caja_movimientos WHERE taller_id = ? AND medio = 'efectivo' AND sesion_id = (SELECT id FROM caja_sesiones WHERE taller_id = ? AND estado = 'abierta')), 0)`;

async function efectivoDisponible(db: D1Database, tallerId: string): Promise<number | null> {
  const r = await first<{ abierta: number; v: number }>(
    db,
    `SELECT EXISTS (SELECT 1 FROM caja_sesiones WHERE taller_id = ? AND estado = 'abierta') AS abierta, (${EFECTIVO_SESION_ABIERTA}) AS v`,
    tallerId, tallerId, tallerId, tallerId,
  );
  return r?.abierta ? r.v : null;
}

/** Depósito de efectivo de la caja en una cuenta: egreso de efectivo (traspaso) en la caja + ingreso en el banco, en una transacción. */
bancos.post('/depositos', async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zMov.extend({ concepto: z.string().trim().min(3).max(200).default('Depósito de efectivo') }));
  const previo = await idemPrevio(c.env.DB, s.tallerId, d.idem_key);
  if (previo) return c.json({ id: previo.id, duplicado: true });
  await cuentaActiva(c.env.DB, s.tallerId, d.cuenta_id, true);
  await exigirCajaAbiertaSiCorresponde(c.env.DB, s.tallerId);
  const disp = await efectivoDisponible(c.env.DB, s.tallerId);
  if (disp != null && d.importe > disp) throw conflict(`No hay tanto efectivo en la caja (disponible ${(disp / 100).toLocaleString('es-AR')})`, 'efectivo_insuficiente');
  const fecha = fechaComercial(s, d.fecha);
  const id = uid();
  await c.env.DB.batch([
    guardCajaObligatoria(c.env.DB, s.tallerId),
    guardCuentaActiva(c.env.DB, s.tallerId, d.cuenta_id),
    // Con caja abierta, el efectivo no puede quedar negativo (otro usuario pudo gastarlo en el medio).
    guard(c.env.DB, `EXISTS (SELECT 1 FROM caja_sesiones WHERE taller_id = ? AND estado = 'abierta') AND (${EFECTIVO_SESION_ABIERTA}) < ?`, s.tallerId, s.tallerId, s.tallerId, s.tallerId, d.importe),
    sentenciaMovBanco(c.env.DB, s.tallerId, {
      id, cuentaId: d.cuenta_id, tipo: 'ingreso', categoria: 'deposito', importe: d.importe, concepto: d.concepto, referencia: d.referencia,
      origenTipo: 'deposito', origenId: id, fecha, afectaResultado: false, idemKey: d.idem_key, usuarioId: s.usuarioId,
    }),
    sentenciaMovimiento(c.env.DB, s.tallerId, { tipo: 'egreso', rubro: 'traspaso', medio: 'efectivo', importe: d.importe, concepto: `Depósito en banco: ${d.concepto}`, referencia: d.referencia, origenTipo: 'banco', origenId: id, fecha, usuarioId: s.usuarioId }),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'banco_movimiento', id, 'deposito', { importe: d.importe, cuenta_id: d.cuenta_id }),
  ]);
  return c.json({ id }, 201);
});

/** Extracción de la cuenta hacia la caja (efectivo): egreso del banco + ingreso de efectivo (traspaso) en la caja. */
bancos.post('/extracciones', async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zMov.extend({ concepto: z.string().trim().min(3).max(200).default('Extracción de efectivo') }));
  const previo = await idemPrevio(c.env.DB, s.tallerId, d.idem_key);
  if (previo) return c.json({ id: previo.id, duplicado: true });
  await cuentaActiva(c.env.DB, s.tallerId, d.cuenta_id, true);
  await exigirCajaAbiertaSiCorresponde(c.env.DB, s.tallerId);
  const fecha = fechaComercial(s, d.fecha);
  const id = uid();
  await c.env.DB.batch([
    guardCajaObligatoria(c.env.DB, s.tallerId),
    guardCuentaActiva(c.env.DB, s.tallerId, d.cuenta_id),
    sentenciaMovBanco(c.env.DB, s.tallerId, {
      id, cuentaId: d.cuenta_id, tipo: 'egreso', categoria: 'extraccion', importe: d.importe, concepto: d.concepto, referencia: d.referencia,
      origenTipo: 'extraccion', origenId: id, fecha, afectaResultado: false, idemKey: d.idem_key, usuarioId: s.usuarioId,
    }),
    sentenciaMovimiento(c.env.DB, s.tallerId, { tipo: 'ingreso', rubro: 'traspaso', medio: 'efectivo', importe: d.importe, concepto: `Extracción de banco: ${d.concepto}`, referencia: d.referencia, origenTipo: 'banco', origenId: id, fecha, usuarioId: s.usuarioId }),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'banco_movimiento', id, 'extraccion', { importe: d.importe, cuenta_id: d.cuenta_id }),
  ]);
  return c.json({ id }, 201);
});

/** Transferencia entre cuentas propias: dos asientos con el mismo transferencia_id. No es un ingreso ni un egreso del negocio. */
bancos.post('/transferencias', async (c) => {
  const s = c.get('sesion');
  const d = await body(
    c,
    z.object({
      origen_id: zId, destino_id: zId, importe: zCentavos.refine((v) => v > 0, 'el importe debe ser mayor a 0'), fecha: zFecha.optional(),
      concepto: z.string().trim().min(3).max(200).default('Transferencia entre cuentas propias'), referencia: zTextoOpt(120), idem_key: z.string().min(8).max(80),
    }),
  );
  const previo = await idemPrevio(c.env.DB, s.tallerId, d.idem_key);
  if (previo) return c.json({ id: previo.id, duplicado: true });
  if (d.origen_id === d.destino_id) throw badRequest('La cuenta de origen y la de destino deben ser distintas');
  const [o, t] = [await cuentaActiva(c.env.DB, s.tallerId, d.origen_id), await cuentaActiva(c.env.DB, s.tallerId, d.destino_id)];
  if (o.moneda !== t.moneda) throw badRequest('Las dos cuentas deben ser de la misma moneda');
  const fecha = fechaComercial(s, d.fecha);
  const tid = uid();
  await c.env.DB.batch([
    guardCuentaActiva(c.env.DB, s.tallerId, d.origen_id),
    guardCuentaActiva(c.env.DB, s.tallerId, d.destino_id),
    sentenciaMovBanco(c.env.DB, s.tallerId, {
      cuentaId: d.origen_id, tipo: 'egreso', categoria: 'transferencia', importe: d.importe, concepto: `${d.concepto} → ${t.nombre}`, referencia: d.referencia,
      origenTipo: 'transferencia_sal', origenId: tid, transferenciaId: tid, fecha, idemKey: d.idem_key, usuarioId: s.usuarioId,
    }),
    sentenciaMovBanco(c.env.DB, s.tallerId, {
      cuentaId: d.destino_id, tipo: 'ingreso', categoria: 'transferencia', importe: d.importe, concepto: `${d.concepto} ← ${o.nombre}`, referencia: d.referencia,
      origenTipo: 'transferencia_ent', origenId: tid, transferenciaId: tid, fecha, usuarioId: s.usuarioId,
    }),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'banco_movimiento', tid, 'transferencia', { importe: d.importe, origen: d.origen_id, destino: d.destino_id }),
  ]);
  return c.json({ id: tid }, 201);
});

bancos.post('/transferencias/:id/anular', async (c) => {
  const s = c.get('sesion');
  const tid = c.req.param('id');
  const { motivo } = await body(c, z.object({ motivo: z.string().trim().min(3).max(300) }));
  const legs = await all<{ id: string; conciliado: number }>(c.env.DB, "SELECT id, conciliado FROM banco_movimientos WHERE taller_id = ? AND transferencia_id = ? AND origen_tipo IN ('transferencia_sal','transferencia_ent')", s.tallerId, tid);
  if (legs.length !== 2) throw notFound('Transferencia');
  if (legs.some((l) => l.conciliado)) throw conflict('La transferencia ya está conciliada: deshacé la conciliación primero', 'conciliado');
  if (await first(c.env.DB, "SELECT 1 FROM banco_movimientos WHERE taller_id = ? AND origen_tipo = 'reverso' AND origen_id = ?", s.tallerId, legs[0].id)) throw conflict('La transferencia ya fue anulada');
  await c.env.DB.batch([
    guard(c.env.DB, "EXISTS (SELECT 1 FROM banco_movimientos WHERE taller_id = ? AND transferencia_id = ? AND (conciliado = 1 OR EXISTS (SELECT 1 FROM banco_movimientos r WHERE r.taller_id = banco_movimientos.taller_id AND r.origen_tipo = 'reverso' AND r.origen_id = banco_movimientos.id)))", s.tallerId, tid),
    sentenciaReversosBanco(c.env.DB, s.tallerId, "m.transferencia_id = ? AND m.origen_tipo IN ('transferencia_sal','transferencia_ent')", [tid], s.usuarioId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'banco_movimiento', tid, 'anular_transferencia', { motivo }),
  ]);
  return c.json({ ok: true });
});

/** Ajuste de saldo autorizado (sólo propietario): corrige diferencias con el banco sin tocar el resto del libro. */
bancos.post('/ajustes', requirePerm('bancos.ajustar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zMov.omit({ concepto: true }).extend({ tipo: z.enum(['ingreso', 'egreso']), motivo: z.string().trim().min(8, 'explicá el motivo del ajuste').max(300) }));
  const previo = await idemPrevio(c.env.DB, s.tallerId, d.idem_key);
  if (previo) return c.json({ id: previo.id, duplicado: true });
  await cuentaActiva(c.env.DB, s.tallerId, d.cuenta_id);
  const fecha = fechaComercial(s, d.fecha);
  const id = uid();
  await c.env.DB.batch([
    guardCuentaActiva(c.env.DB, s.tallerId, d.cuenta_id),
    sentenciaMovBanco(c.env.DB, s.tallerId, {
      id, cuentaId: d.cuenta_id, tipo: d.tipo, categoria: 'ajuste', importe: d.importe, concepto: `Ajuste: ${d.motivo}`, referencia: d.referencia,
      origenTipo: 'ajuste', origenId: id, fecha, afectaResultado: false, idemKey: d.idem_key, usuarioId: s.usuarioId,
    }),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'banco_movimiento', id, 'ajuste', { tipo: d.tipo, importe: d.importe, motivo: d.motivo, cuenta_id: d.cuenta_id }),
  ]);
  return c.json({ id }, 201);
});

bancos.post('/movimientos/:id/anular', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const { motivo } = await body(c, z.object({ motivo: z.string().trim().min(3).max(300) }));
  const m = await first<{ origen_tipo: string; conciliado: number }>(c.env.DB, 'SELECT origen_tipo, conciliado FROM banco_movimientos WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!m) throw notFound('Movimiento');
  if (!['manual', 'deposito', 'extraccion', 'ajuste'].includes(m.origen_tipo)) {
    throw conflict(m.origen_tipo.startsWith('transferencia') ? 'Las transferencias se anulan desde la transferencia completa.' : 'Este movimiento nace de un cobro, pago, gasto o cheque: se anula en su propio módulo.');
  }
  if (m.origen_tipo === 'ajuste' && !tienePermiso(s.rol, 'bancos.ajustar')) throw forbidden('Sólo el propietario puede anular un ajuste');
  if (m.conciliado) throw conflict('El movimiento está conciliado: deshacé la conciliación primero', 'conciliado');
  if (await first(c.env.DB, "SELECT 1 FROM banco_movimientos WHERE taller_id = ? AND origen_tipo = 'reverso' AND origen_id = ?", s.tallerId, id)) throw conflict('El movimiento ya fue anulado');
  const conCaja = m.origen_tipo === 'deposito' || m.origen_tipo === 'extraccion';
  if (conCaja) await exigirCajaAbiertaSiCorresponde(c.env.DB, s.tallerId);
  const stmts: Stmt[] = [
    guard(c.env.DB, "EXISTS (SELECT 1 FROM banco_movimientos m WHERE m.taller_id = ? AND m.id = ? AND (m.conciliado = 1 OR EXISTS (SELECT 1 FROM banco_movimientos r WHERE r.taller_id = m.taller_id AND r.origen_tipo = 'reverso' AND r.origen_id = m.id)))", s.tallerId, id),
  ];
  if (conCaja) stmts.push(guardCajaObligatoria(c.env.DB, s.tallerId), reversoDeOrigen(c.env.DB, s.tallerId, 'banco', id, s.usuarioId));
  stmts.push(sentenciaReversosBanco(c.env.DB, s.tallerId, 'm.id = ?', [id], s.usuarioId), auditar(c.env.DB, s.tallerId, s.usuarioId, 'banco_movimiento', id, 'anular', { motivo }));
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

// ───────────── Conciliación manual ─────────────
bancos.get('/conciliacion/:cuentaId', async (c) => {
  const s = c.get('sesion');
  const cuenta = await first<any>(c.env.DB, 'SELECT * FROM cuentas_bancarias WHERE taller_id = ? AND id = ?', s.tallerId, c.req.param('cuentaId'));
  if (!cuenta) throw notFound('Cuenta bancaria');
  const [sal] = await saldosCuentas(c.env.DB, s.tallerId, cuenta.id);
  const pendientes = await all(c.env.DB, `${SELECT_MOV} WHERE m.taller_id = ? AND m.cuenta_id = ? AND m.conciliado = 0 ORDER BY m.fecha, m.created_at`, s.tallerId, cuenta.id);
  const ultima = await first(c.env.DB, "SELECT * FROM conciliaciones WHERE taller_id = ? AND cuenta_id = ? AND estado = 'vigente' ORDER BY numero DESC LIMIT 1", s.tallerId, cuenta.id);
  return c.json({ cuenta: { ...cuenta, ...sal }, pendientes, ultima });
});

bancos.get('/conciliaciones', async (c) => {
  const s = c.get('sesion');
  const { cuenta_id } = query(c, z.object({ cuenta_id: z.string().optional() }));
  return c.json(
    await all(
      c.env.DB,
      `SELECT co.*, cb.nombre AS cuenta, u.nombre AS usuario FROM conciliaciones co JOIN cuentas_bancarias cb ON cb.taller_id = co.taller_id AND cb.id = co.cuenta_id
         LEFT JOIN usuarios u ON u.taller_id = co.taller_id AND u.id = co.usuario_id
        WHERE co.taller_id = ? ${cuenta_id ? 'AND co.cuenta_id = ?' : ''} ORDER BY co.numero DESC LIMIT 200`,
      s.tallerId,
      ...(cuenta_id ? [cuenta_id] : []),
    ),
  );
});

bancos.get('/conciliaciones/:id', async (c) => {
  const s = c.get('sesion');
  const co = await first<any>(c.env.DB, 'SELECT co.*, cb.nombre AS cuenta FROM conciliaciones co JOIN cuentas_bancarias cb ON cb.taller_id = co.taller_id AND cb.id = co.cuenta_id WHERE co.taller_id = ? AND co.id = ?', s.tallerId, c.req.param('id'));
  if (!co) throw notFound('Conciliación');
  const movimientos = await all(c.env.DB, `${SELECT_MOV} WHERE m.taller_id = ? AND m.conciliacion_id = ? ORDER BY m.fecha, m.created_at`, s.tallerId, co.id);
  return c.json({ ...co, movimientos });
});

bancos.post('/conciliaciones', async (c) => {
  const s = c.get('sesion');
  const d = await body(
    c,
    z.object({
      cuenta_id: zId, fecha_corte: zFecha, saldo_extracto: z.number().int().min(-1e13).max(1e13),
      movimiento_ids: z.array(zId).min(1, 'elegí al menos un movimiento').max(500), notas: zTextoOpt(500),
    }),
  );
  if (d.fecha_corte > hoy()) throw badRequest('La fecha de corte no puede ser futura');
  const ids = [...new Set(d.movimiento_ids)];
  const cuenta = await first<{ saldo_inicial: number }>(c.env.DB, 'SELECT saldo_inicial FROM cuentas_bancarias WHERE taller_id = ? AND id = ?', s.tallerId, d.cuenta_id);
  if (!cuenta) throw badRequest('Cuenta bancaria inexistente');
  const sel: Array<{ id: string; conciliado: number; fecha: string; cuenta_id: string }> = [];
  for (const l of lotes(ids)) sel.push(...(await all<any>(c.env.DB, `SELECT id, conciliado, fecha, cuenta_id FROM banco_movimientos WHERE taller_id = ? AND id IN (${l.map(() => '?').join(',')})`, s.tallerId, ...l)));
  if (sel.length !== ids.length || sel.some((m) => m.cuenta_id !== d.cuenta_id)) throw badRequest('Hay movimientos inexistentes o de otra cuenta');
  if (sel.some((m) => m.conciliado)) throw conflict('Hay movimientos que ya fueron conciliados. Actualizá la lista.', 'conciliado');
  if (sel.some((m) => m.fecha > d.fecha_corte)) throw badRequest('Hay movimientos posteriores a la fecha de corte');
  const id = uid();
  const sumaSel = lotes(ids)
    .map((l) => `(SELECT COALESCE(SUM(${SIGNO_BANCO_SQL}), 0) FROM banco_movimientos WHERE taller_id = ? AND id IN (${l.map(() => '?').join(',')}))`)
    .join(' + ');
  const sumaParams = lotes(ids).flatMap((l) => [s.tallerId, ...l]);
  const stmts: Stmt[] = [];
  for (const l of lotes(ids)) {
    stmts.push(guard(c.env.DB, `(SELECT COUNT(*) FROM banco_movimientos WHERE taller_id = ? AND cuenta_id = ? AND conciliado = 0 AND id IN (${l.map(() => '?').join(',')})) <> ?`, s.tallerId, d.cuenta_id, ...l, l.length));
  }
  stmts.push(
    ...seqIncrementar(c.env.DB, s.tallerId, 'conciliacion'),
    c.env.DB
      .prepare(
        `INSERT INTO conciliaciones (id, taller_id, numero, cuenta_id, fecha_corte, saldo_extracto, saldo_libros, diferencia, cantidad, notas, usuario_id)
         SELECT ?, ?, ${SEQ_VALOR}, ?, ?, ?, l.v, ? - l.v, ?, ?, ?
           FROM (SELECT (SELECT saldo_inicial FROM cuentas_bancarias WHERE taller_id = ? AND id = ?)
                        + COALESCE((SELECT SUM(${SIGNO_BANCO_SQL}) FROM banco_movimientos WHERE taller_id = ? AND cuenta_id = ? AND conciliado = 1), 0)
                        + ${sumaSel} AS v) l`,
      )
      .bind(id, s.tallerId, s.tallerId, 'conciliacion', d.cuenta_id, d.fecha_corte, d.saldo_extracto, d.saldo_extracto, ids.length, d.notas, s.usuarioId, s.tallerId, d.cuenta_id, s.tallerId, d.cuenta_id, ...sumaParams),
  );
  for (const l of lotes(ids)) {
    stmts.push(
      c.env.DB
        .prepare(`UPDATE banco_movimientos SET conciliado = 1, conciliacion_id = ?, conciliado_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ? AND cuenta_id = ? AND conciliado = 0 AND id IN (${l.map(() => '?').join(',')})`)
        .bind(id, s.tallerId, d.cuenta_id, ...l),
    );
  }
  stmts.push(auditar(c.env.DB, s.tallerId, s.usuarioId, 'conciliacion', id, 'crear', { cuenta_id: d.cuenta_id, cantidad: ids.length, saldo_extracto: d.saldo_extracto }));
  await c.env.DB.batch(stmts);
  return c.json(await first(c.env.DB, 'SELECT * FROM conciliaciones WHERE taller_id = ? AND id = ?', s.tallerId, id), 201);
});

bancos.post('/conciliaciones/:id/deshacer', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const co = await first<{ cuenta_id: string; numero: number; estado: string }>(c.env.DB, 'SELECT cuenta_id, numero, estado FROM conciliaciones WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!co) throw notFound('Conciliación');
  if (co.estado !== 'vigente') throw conflict('La conciliación ya fue deshecha');
  const mayor = await first(c.env.DB, "SELECT 1 FROM conciliaciones WHERE taller_id = ? AND cuenta_id = ? AND estado = 'vigente' AND numero > ?", s.tallerId, co.cuenta_id, co.numero);
  if (mayor) throw conflict('Sólo se puede deshacer la última conciliación de la cuenta', 'no_es_la_ultima');
  await c.env.DB.batch([
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM conciliaciones WHERE taller_id = ? AND id = ? AND estado = 'vigente')", s.tallerId, id),
    guard(c.env.DB, "EXISTS (SELECT 1 FROM conciliaciones WHERE taller_id = ? AND cuenta_id = ? AND estado = 'vigente' AND numero > ?)", s.tallerId, co.cuenta_id, co.numero),
    c.env.DB.prepare('UPDATE banco_movimientos SET conciliado = 0, conciliacion_id = NULL, conciliado_at = NULL WHERE taller_id = ? AND conciliacion_id = ?').bind(s.tallerId, id),
    c.env.DB.prepare("UPDATE conciliaciones SET estado = 'deshecha', deshecha_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ? AND id = ?").bind(s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'conciliacion', id, 'deshacer'),
  ]);
  return c.json({ ok: true });
});
