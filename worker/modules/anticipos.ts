// Anticipos de clientes y saldo a favor.
//
// Un anticipo es dinero que el cliente entrega ANTES de la venta (p. ej. para empezar una reparación). Es un cobro (`cobros.tipo = 'anticipo'`):
// usa el mismo circuito que cualquier cobro (caja, banco, cheques, recibo, cuenta corriente) pero no se aplica a ningún comprobante. No es una venta
// ni genera comprobante. Después se aplica, total o parcialmente, a una o varias ventas (sin mover dinero otra vez) o se devuelve en dinero.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, conflict, notFound, query, zCentavos, zFecha, zId, zTextoOpt } from '../lib/http';
import { all, auditar, first, guard, like, uid, type Stmt } from '../lib/db';
import { requirePerm } from '../lib/auth';
import { sentenciasCobro, validarMediosCobro } from '../lib/cobros';
import { zChequeDatos } from '../lib/cheques';
import { exigirCajaAbiertaSiCorresponde } from '../lib/caja';
import { fechaComercial } from '../lib/fechas';
import { creditosDisponibles, sentenciasAplicarCredito, validarAplicacion, type OrigenCredito } from '../lib/creditos';
import { aMedioReintegro, guardReintegroVigente, sentenciasReintegro, validarMediosReintegro, zMedioReintegro } from '../lib/reintegros';
import { estadoAnticipo, MEDIOS_PAGO } from '../../shared/dominio';

export const anticipos = new Hono<AppEnv>();

const SELECT_ANTICIPO = `SELECT co.id, co.numero, co.cliente_id, c.nombre AS cliente, co.fecha, co.estado, co.total, co.credito_aplicado, co.devuelto,
    (CASE WHEN co.estado = 'registrado' THEN co.total - co.credito_aplicado - co.devuelto ELSE 0 END) AS disponible,
    co.orden_id, o.numero AS orden_numero, co.presupuesto_id, p.numero AS presupuesto_numero, co.notas, co.anulado_motivo, u.nombre AS usuario, co.created_at,
    (SELECT GROUP_CONCAT(DISTINCT cm.medio) FROM cobro_medios cm WHERE cm.taller_id = co.taller_id AND cm.cobro_id = co.id) AS medios
  FROM cobros co
  JOIN clientes c ON c.taller_id = co.taller_id AND c.id = co.cliente_id
  LEFT JOIN ordenes o ON o.taller_id = co.taller_id AND o.id = co.orden_id
  LEFT JOIN presupuestos p ON p.taller_id = co.taller_id AND p.id = co.presupuesto_id
  LEFT JOIN usuarios u ON u.taller_id = co.taller_id AND u.id = co.usuario_id`;

const conEstado = <T extends { estado: string; total: number; credito_aplicado: number; devuelto: number }>(a: T) => ({ ...a, estado_uso: estadoAnticipo(a) });

// ───────────── Consultas ─────────────
/**
 * Anticipos de un cliente, de una OT o de un presupuesto. Con `orden_id` también aparecen los del presupuesto del que nació la OT.
 * estado: pendientes (con saldo para aplicar) | utilizados (con algo aplicado) | devueltos (con algo devuelto en dinero) | anulados | todos.
 */
anticipos.get('/anticipos', requirePerm('ventas.ver'), async (c) => {
  const s = c.get('sesion');
  const f = query(
    c,
    z.object({
      cliente_id: z.string().optional(), orden_id: z.string().optional(), presupuesto_id: z.string().optional(), desde: z.string().optional(), hasta: z.string().optional(),
      estado: z.enum(['pendientes', 'utilizados', 'devueltos', 'anulados', 'todos']).default('todos'), q: z.string().optional(),
    }),
  );
  const cond = ["co.taller_id = ?", "co.tipo = 'anticipo'"];
  const params: unknown[] = [s.tallerId];
  if (f.cliente_id) (cond.push('co.cliente_id = ?'), params.push(f.cliente_id));
  if (f.orden_id) {
    cond.push('(co.orden_id = ? OR (co.presupuesto_id IS NOT NULL AND co.presupuesto_id = (SELECT presupuesto_id FROM ordenes WHERE taller_id = co.taller_id AND id = ?)))');
    params.push(f.orden_id, f.orden_id);
  }
  if (f.presupuesto_id) (cond.push('co.presupuesto_id = ?'), params.push(f.presupuesto_id));
  if (f.desde) (cond.push('co.fecha >= ?'), params.push(f.desde));
  if (f.hasta) (cond.push('co.fecha <= ?'), params.push(f.hasta));
  if (f.q) (cond.push('(c.nombre LIKE ? OR CAST(co.numero AS TEXT) = ?)'), params.push(like(f.q), f.q.replace(/\D/g, '')));
  if (f.estado === 'pendientes') cond.push("co.estado = 'registrado' AND co.total - co.credito_aplicado - co.devuelto > 0");
  if (f.estado === 'utilizados') cond.push("co.estado = 'registrado' AND co.credito_aplicado > 0");
  if (f.estado === 'devueltos') cond.push("co.estado = 'registrado' AND co.devuelto > 0");
  if (f.estado === 'anulados') cond.push("co.estado = 'anulado'");
  const filas = await all<{ estado: string; total: number; credito_aplicado: number; devuelto: number; disponible: number }>(
    c.env.DB, `${SELECT_ANTICIPO} WHERE ${cond.join(' AND ')} ORDER BY co.numero DESC LIMIT 300`, ...params,
  );
  return c.json(filas.map(conEstado));
});

anticipos.get('/anticipos/:id', requirePerm('ventas.ver'), async (c) => {
  const s = c.get('sesion');
  const a = await first<{ id: string; estado: string; total: number; credito_aplicado: number; devuelto: number }>(c.env.DB, `${SELECT_ANTICIPO} WHERE co.taller_id = ? AND co.id = ? AND co.tipo = 'anticipo'`, s.tallerId, c.req.param('id'));
  if (!a) throw notFound('Anticipo');
  const [medios, aplicaciones, reintegros] = await Promise.all([
    all(c.env.DB, 'SELECT medio, importe, referencia FROM cobro_medios WHERE taller_id = ? AND cobro_id = ?', s.tallerId, a.id),
    all(
      c.env.DB,
      `SELECT ca.id, ca.importe, ca.fecha, ca.estado, ca.anulada_motivo, ca.venta_id, ve.numero AS venta_numero, ve.total AS venta_total, ve.orden_id, o.numero AS orden_numero, u.nombre AS usuario
         FROM credito_aplicaciones ca JOIN ventas ve ON ve.taller_id = ca.taller_id AND ve.id = ca.venta_id
         LEFT JOIN ordenes o ON o.taller_id = ve.taller_id AND o.id = ve.orden_id LEFT JOIN usuarios u ON u.taller_id = ca.taller_id AND u.id = ca.usuario_id
        WHERE ca.taller_id = ? AND ca.origen_tipo = 'anticipo' AND ca.origen_id = ? ORDER BY ca.created_at`,
      s.tallerId, a.id,
    ),
    all(
      c.env.DB,
      `SELECT r.id, r.numero, r.fecha, r.total, r.estado, r.motivo, u.nombre AS usuario,
              (SELECT GROUP_CONCAT(DISTINCT rm.medio) FROM reintegro_medios rm WHERE rm.taller_id = r.taller_id AND rm.reintegro_id = r.id) AS medios
         FROM reintegros r LEFT JOIN usuarios u ON u.taller_id = r.taller_id AND u.id = r.usuario_id
        WHERE r.taller_id = ? AND r.origen_tipo = 'anticipo' AND r.origen_id = ? ORDER BY r.numero`,
      s.tallerId, a.id,
    ),
  ]);
  return c.json({ ...conEstado(a), medios_detalle: medios, aplicaciones, reintegros });
});

/** Saldo a favor disponible (anticipos y créditos de devoluciones) de un cliente: lo que se puede aplicar a un comprobante. */
anticipos.get('/creditos', requirePerm('ventas.ver'), async (c) => {
  const s = c.get('sesion');
  const { cliente_id } = query(c, z.object({ cliente_id: zId }));
  if (!(await first(c.env.DB, 'SELECT 1 FROM clientes WHERE taller_id = ? AND id = ?', s.tallerId, cliente_id))) throw notFound('Cliente');
  const lista = await creditosDisponibles(c.env.DB, s.tallerId, cliente_id);
  return c.json({ creditos: lista, total: lista.reduce((a, x) => a + x.disponible, 0) });
});

// ───────────── Registro de un anticipo ─────────────
const zAnticipo = z.object({
  cliente_id: zId,
  fecha: zFecha.optional(),
  medios: z.array(z.object({ medio: z.enum(MEDIOS_PAGO), importe: zCentavos.refine((v) => v > 0, 'importe debe ser mayor a 0'), referencia: zTextoOpt(120), cuenta_id: zId.nullish(), cheque: zChequeDatos.partial().nullish() })).min(1).max(10),
  orden_id: zId.nullish(),
  presupuesto_id: zId.nullish(),
  notas: zTextoOpt(500),
  idem_key: z.string().min(8).max(80),
});

anticipos.post('/anticipos', requirePerm('cobros.registrar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zAnticipo);
  const previo = await first(c.env.DB, 'SELECT id, numero, total FROM cobros WHERE taller_id = ? AND idem_key = ?', s.tallerId, d.idem_key);
  if (previo) return c.json({ ...previo, duplicado: true }, 200);
  const cli = await first<{ codigo: number }>(c.env.DB, 'SELECT codigo FROM clientes WHERE taller_id = ? AND id = ?', s.tallerId, d.cliente_id);
  if (!cli) throw badRequest('Cliente inexistente');
  // El saldo a favor tiene que poder asignarse a alguien: no se aceptan anticipos de "Consumidor final".
  if (cli.codigo === 0) throw badRequest('Un anticipo requiere un cliente identificado (no "Consumidor final")');
  if (d.orden_id) {
    const o = await first<{ cliente_id: string; estado: string; presupuesto_id: string | null }>(c.env.DB, 'SELECT cliente_id, estado, presupuesto_id FROM ordenes WHERE taller_id = ? AND id = ?', s.tallerId, d.orden_id);
    if (!o) throw badRequest('Orden de trabajo inexistente');
    if (o.cliente_id !== d.cliente_id) throw badRequest('La orden de trabajo pertenece a otro cliente');
    if (o.estado === 'cancelada') throw conflict('La orden de trabajo está cancelada');
  }
  if (d.presupuesto_id) {
    const p = await first<{ cliente_id: string; estado: string }>(c.env.DB, 'SELECT cliente_id, estado FROM presupuestos WHERE taller_id = ? AND id = ?', s.tallerId, d.presupuesto_id);
    if (!p) throw badRequest('Presupuesto inexistente');
    if (p.cliente_id !== d.cliente_id) throw badRequest('El presupuesto pertenece a otro cliente');
    if (['rechazado', 'anulado'].includes(p.estado)) throw conflict('El presupuesto está rechazado o anulado');
  }
  await validarMediosCobro(c.env.DB, s.tallerId, d.medios.map((m) => ({ medio: m.medio, importe: m.importe, referencia: m.referencia, cuentaId: m.cuenta_id, cheque: m.cheque })));
  const fecha = fechaComercial(s, d.fecha);
  await exigirCajaAbiertaSiCorresponde(c.env.DB, s.tallerId);
  const id = uid();
  try {
    await c.env.DB.batch([
      ...sentenciasCobro(c.env.DB, s, {
        id, clienteId: d.cliente_id, fecha, notas: d.notas ?? 'Anticipo de cliente', idemKey: d.idem_key, tipo: 'anticipo', ordenId: d.orden_id ?? null, presupuestoId: d.presupuesto_id ?? null,
        medios: d.medios.map((m) => ({ medio: m.medio, importe: m.importe, referencia: m.referencia, cuentaId: m.cuenta_id ?? null, cheque: m.cheque ?? null })),
        aplicaciones: [],
      }),
    ]);
  } catch (e) {
    // Carrera con un reintento idéntico: devolver el anticipo ya registrado.
    if (String(e).includes('idem_key')) {
      const ex = await first(c.env.DB, 'SELECT id, numero, total FROM cobros WHERE taller_id = ? AND idem_key = ?', s.tallerId, d.idem_key);
      if (ex) return c.json({ ...ex, duplicado: true }, 200);
    }
    throw e;
  }
  return c.json(await first(c.env.DB, 'SELECT id, numero, total FROM cobros WHERE taller_id = ? AND id = ?', s.tallerId, id), 201);
});

// ───────────── Devolución del anticipo en dinero ─────────────
anticipos.post('/anticipos/:id/devolver', requirePerm('cobros.anular'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, z.object({ medios: z.array(zMedioReintegro).min(1).max(10), motivo: z.string().trim().min(3).max(300), fecha: zFecha.optional(), idem_key: z.string().min(8).max(80) }));
  const previo = await first(c.env.DB, 'SELECT id, numero FROM reintegros WHERE taller_id = ? AND idem_key = ?', s.tallerId, d.idem_key);
  if (previo) return c.json({ ...previo, duplicado: true }, 200);
  const a = await first<{ estado: string; cliente_id: string; total: number; credito_aplicado: number; devuelto: number; numero: number; fecha: string }>(
    c.env.DB, "SELECT estado, cliente_id, total, credito_aplicado, devuelto, numero, fecha FROM cobros WHERE taller_id = ? AND id = ? AND tipo = 'anticipo'", s.tallerId, id,
  );
  if (!a) throw notFound('Anticipo');
  if (a.estado !== 'registrado') throw conflict('El anticipo está anulado');
  const medios = d.medios.map(aMedioReintegro);
  const total = medios.reduce((x, m) => x + m.importe, 0);
  const disponible = a.total - a.credito_aplicado - a.devuelto;
  if (total > disponible) throw conflict(`El anticipo solo tiene ${(disponible / 100).toFixed(2)} disponible para devolver`, 'credito_insuficiente');
  const fecha = fechaComercial(s, d.fecha);
  if (fecha < a.fecha) throw badRequest('La devolución no puede ser anterior al anticipo');
  await validarMediosReintegro(c.env.DB, s.tallerId, medios);
  await exigirCajaAbiertaSiCorresponde(c.env.DB, s.tallerId);
  const rid = uid();
  try {
    await c.env.DB.batch([
      guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM cobros WHERE taller_id = ? AND id = ? AND tipo = 'anticipo' AND estado = 'registrado')", s.tallerId, id),
      ...sentenciasReintegro(c.env.DB, s, { id: rid, clienteId: a.cliente_id, origenTipo: 'anticipo', origenId: id, fecha, medios, motivo: d.motivo, idemKey: d.idem_key }),
      // CHECK (credito_aplicado + devuelto <= total): no se devuelve lo que ya se aplicó, ni dos veces lo mismo.
      c.env.DB.prepare('UPDATE cobros SET devuelto = devuelto + ? WHERE taller_id = ? AND id = ?').bind(total, s.tallerId, id),
      guardReintegroVigente(c.env.DB, s.tallerId, rid),
      auditar(c.env.DB, s.tallerId, s.usuarioId, 'cobro', id, 'devolver_anticipo', { total, motivo: d.motivo }),
    ]);
  } catch (e) {
    if (String(e).includes('idem_key')) {
      const ex = await first(c.env.DB, 'SELECT id, numero FROM reintegros WHERE taller_id = ? AND idem_key = ?', s.tallerId, d.idem_key);
      if (ex) return c.json({ ...ex, duplicado: true }, 200);
    }
    throw e;
  }
  return c.json(await first(c.env.DB, 'SELECT id, numero, total FROM reintegros WHERE taller_id = ? AND id = ?', s.tallerId, rid), 201);
});

// ───────────── Aplicación de saldo a favor a un comprobante ─────────────
const zAplicar = z.object({
  aplicaciones: z.array(z.object({ origen_tipo: z.enum(['anticipo', 'devolucion']), origen_id: zId, importe: zCentavos.refine((v) => v > 0, 'importe debe ser mayor a 0') })).min(1).max(20),
  fecha: zFecha.optional(),
  idem_key: z.string().min(8).max(80),
});

anticipos.post('/ventas/:id/aplicar-creditos', requirePerm('cobros.registrar'), async (c) => {
  const s = c.get('sesion');
  const ventaId = c.req.param('id');
  const d = await body(c, zAplicar);
  const previa = await first(c.env.DB, "SELECT id FROM credito_aplicaciones WHERE taller_id = ? AND idem_key = ?", s.tallerId, `${d.idem_key}:0`);
  if (previa) return c.json({ ok: true, duplicado: true }, 200);
  const v = await first<{ cliente_id: string; estado: string; total: number; cobrado: number; devuelto: number; numero: number }>(
    c.env.DB, 'SELECT cliente_id, estado, total, cobrado, devuelto, numero FROM ventas WHERE taller_id = ? AND id = ?', s.tallerId, ventaId,
  );
  if (!v) throw notFound('Comprobante');
  if (v.estado !== 'emitida') throw conflict(`El comprobante #${v.numero} está anulado`);
  const claves = d.aplicaciones.map((a) => `${a.origen_tipo}:${a.origen_id}`);
  if (new Set(claves).size !== claves.length) throw badRequest('Un mismo saldo a favor aparece más de una vez');
  const total = d.aplicaciones.reduce((x, a) => x + a.importe, 0);
  if (total > v.total - v.devuelto - v.cobrado) throw conflict(`El importe supera el saldo pendiente del comprobante #${v.numero}`, 'saldo_excedido');
  const fecha = fechaComercial(s, d.fecha);
  const stmts: Stmt[] = [];
  for (let i = 0; i < d.aplicaciones.length; i++) {
    const a = { ventaId, clienteId: v.cliente_id, origenTipo: d.aplicaciones[i].origen_tipo as OrigenCredito, origenId: d.aplicaciones[i].origen_id, importe: d.aplicaciones[i].importe, fecha, idemKey: `${d.idem_key}:${i}` };
    await validarAplicacion(c.env.DB, s.tallerId, a);
    stmts.push(...sentenciasAplicarCredito(c.env.DB, s, a));
  }
  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    if (String(e).includes('idem_key')) return c.json({ ok: true, duplicado: true }, 200);
    throw e;
  }
  return c.json({ ok: true, aplicado: total }, 201);
});

/** Deshace una aplicación de saldo a favor: el comprobante recupera su deuda y el saldo vuelve a estar disponible. No mueve dinero. */
anticipos.post('/credito-aplicaciones/:id/anular', requirePerm('cobros.anular'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const { motivo } = await body(c, z.object({ motivo: z.string().trim().min(3).max(300) }));
  const a = await first<{ estado: string; venta_id: string; origen_tipo: OrigenCredito; origen_id: string; importe: number }>(
    c.env.DB, 'SELECT estado, venta_id, origen_tipo, origen_id, importe FROM credito_aplicaciones WHERE taller_id = ? AND id = ?', s.tallerId, id,
  );
  if (!a) throw notFound('Aplicación');
  if (a.estado !== 'vigente') throw conflict('La aplicación ya está anulada');
  const v = await first<{ devuelto: number; numero: number }>(c.env.DB, 'SELECT devuelto, numero FROM ventas WHERE taller_id = ? AND id = ?', s.tallerId, a.venta_id);
  if (v && v.devuelto > 0) throw conflict(`El comprobante #${v.numero} tiene devoluciones registradas. Anulá las devoluciones antes de deshacer esta aplicación.`, 'tiene_devoluciones');
  await c.env.DB.batch([
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM credito_aplicaciones WHERE taller_id = ? AND id = ? AND estado = 'vigente')", s.tallerId, id),
    guard(c.env.DB, 'EXISTS (SELECT 1 FROM ventas WHERE taller_id = ? AND id = ? AND devuelto > 0)', s.tallerId, a.venta_id),
    c.env.DB.prepare("UPDATE credito_aplicaciones SET estado = 'anulada', anulada_motivo = ? WHERE taller_id = ? AND id = ?").bind(motivo, s.tallerId, id),
    // CHECK cobrado >= 0 y credito_aplicado >= 0: no se puede deshacer dos veces ni más de lo aplicado.
    c.env.DB.prepare('UPDATE ventas SET cobrado = cobrado - ? WHERE taller_id = ? AND id = ?').bind(a.importe, s.tallerId, a.venta_id),
    a.origen_tipo === 'anticipo'
      ? c.env.DB.prepare('UPDATE cobros SET credito_aplicado = credito_aplicado - ? WHERE taller_id = ? AND id = ?').bind(a.importe, s.tallerId, a.origen_id)
      : c.env.DB.prepare('UPDATE devoluciones SET credito_aplicado = credito_aplicado - ? WHERE taller_id = ? AND id = ?').bind(a.importe, s.tallerId, a.origen_id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'venta', a.venta_id, 'anular_aplicacion_credito', { aplicacion_id: id, importe: a.importe, motivo }),
  ]);
  return c.json({ ok: true });
});
