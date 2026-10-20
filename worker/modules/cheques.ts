// Cartera de cheques y eCheq (registro y control administrativo; no hay conexión con plataformas bancarias).
//
// Estados: en_cartera → depositado → acreditado | rechazado · en_cartera → entregado (endoso a un proveedor, vía pago) · anulado.
// Los cheques que nacen de un cobro o de un pago se crean desde esas operaciones (lib/cobros.ts, lib/pagos.ts); acá se les da curso.
// Depositar/acreditar un cheque recibido mueve plata entre la cartera y el banco: el ingreso ya se contó al cobrarlo.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, conflict, notFound, query, zCentavos, zFecha, zId, zTextoOpt } from '../lib/http';
import { all, auditar, first, guard, hoy, like, uid, type Stmt } from '../lib/db';
import { requirePerm } from '../lib/auth';
import { ESTADOS_CHEQUE } from '../../shared/dominio';
import { sentenciaMovBanco, reversoBancoDeOrigen, validarCuentaOperable } from '../lib/banco';
import { sentenciaEvento, sentenciasChequeNuevo, validarCuitOpcional, zChequeDatos } from '../lib/cheques';
import { fechaComercial, sumarDias } from '../lib/fechas';

export const cheques = new Hono<AppEnv>();

// Cartera disponible para endosar en un pago a proveedor (la ve quien gestiona compras).
cheques.get('/cheques-cartera', requirePerm('compras.gestionar'), async (c) => {
  const s = c.get('sesion');
  return c.json(
    await all(
      c.env.DB,
      `SELECT id, numero, banco, nro_cheque, importe, fecha_pago, fecha_vencimiento, librador, modalidad FROM cheques
        WHERE taller_id = ? AND direccion = 'recibido' AND estado = 'en_cartera' ORDER BY fecha_pago LIMIT 300`,
      s.tallerId,
    ),
  );
});

for (const ruta of ['/cheques', '/cheques/*']) cheques.use(ruta, requirePerm('cheques.gestionar'));

const SELECT = `SELECT ch.*, cl.nombre AS cliente, pr.nombre AS proveedor, cb.nombre AS cuenta, u.nombre AS usuario,
    CASE ch.origen_tipo WHEN 'cobro_medio' THEN (SELECT cobro_id FROM cobro_medios cm WHERE cm.taller_id = ch.taller_id AND cm.id = ch.origen_id) WHEN 'pago_proveedor' THEN ch.origen_id END AS origen_ref
  FROM cheques ch
  LEFT JOIN clientes cl ON cl.taller_id = ch.taller_id AND cl.id = ch.cliente_id
  LEFT JOIN proveedores pr ON pr.taller_id = ch.taller_id AND pr.id = ch.proveedor_id
  LEFT JOIN cuentas_bancarias cb ON cb.taller_id = ch.taller_id AND cb.id = ch.cuenta_id
  LEFT JOIN usuarios u ON u.taller_id = ch.taller_id AND u.id = ch.usuario_id`;

cheques.get('/cheques', async (c) => {
  const s = c.get('sesion');
  const f = query(
    c,
    z.object({
      direccion: z.enum(['recibido', 'emitido']).optional(), estado: z.string().optional(), q: z.string().optional(), desde: z.string().optional(), hasta: z.string().optional(),
      vence_en: z.coerce.number().int().min(0).max(365).optional(), vencidos: z.string().optional(), pendientes: z.string().optional(),
      cliente_id: z.string().optional(), proveedor_id: z.string().optional(), cuenta_id: z.string().optional(), modalidad: z.enum(['fisico', 'echeq']).optional(),
      limite: z.coerce.number().int().min(1).max(1000).default(400),
    }),
  );
  const cond = ['ch.taller_id = ?'];
  const params: unknown[] = [s.tallerId];
  if (f.direccion) (cond.push('ch.direccion = ?'), params.push(f.direccion));
  if (f.estado) (cond.push('ch.estado = ?'), params.push(f.estado));
  if (f.modalidad) (cond.push('ch.modalidad = ?'), params.push(f.modalidad));
  if (f.cliente_id) (cond.push('ch.cliente_id = ?'), params.push(f.cliente_id));
  if (f.proveedor_id) (cond.push('ch.proveedor_id = ?'), params.push(f.proveedor_id));
  if (f.cuenta_id) (cond.push('ch.cuenta_id = ?'), params.push(f.cuenta_id));
  if (f.desde) (cond.push('ch.fecha_pago >= ?'), params.push(f.desde));
  if (f.hasta) (cond.push('ch.fecha_pago <= ?'), params.push(f.hasta));
  if (f.pendientes) cond.push("ch.estado IN ('en_cartera','depositado','entregado')");
  if (f.vence_en != null) {
    // Próximos a vencer: recibidos que vencen para depositarlos, o emitidos que se van a debitar.
    cond.push("((ch.direccion = 'recibido' AND ch.estado = 'en_cartera' AND (ch.fecha_pago BETWEEN ? AND ? OR ch.fecha_vencimiento BETWEEN ? AND ?)) OR (ch.direccion = 'emitido' AND ch.estado = 'entregado' AND ch.fecha_pago BETWEEN ? AND ?))");
    params.push(hoy(), sumarDias(hoy(), f.vence_en), hoy(), sumarDias(hoy(), f.vence_en), hoy(), sumarDias(hoy(), f.vence_en));
  }
  if (f.vencidos) (cond.push("ch.direccion = 'recibido' AND ch.estado = 'en_cartera' AND ch.fecha_vencimiento < ?"), params.push(hoy()));
  if (f.q) {
    cond.push('(ch.nro_cheque LIKE ? OR ch.banco LIKE ? OR ch.librador LIKE ? OR ch.cuit LIKE ? OR ch.beneficiario LIKE ? OR ch.echeq_id LIKE ? OR cl.nombre LIKE ? OR pr.nombre LIKE ?)');
    params.push(...Array(8).fill(like(f.q)));
  }
  return c.json(await all(c.env.DB, `${SELECT} WHERE ${cond.join(' AND ')} ORDER BY ch.fecha_pago, ch.numero LIMIT ?`, ...params, f.limite));
});

cheques.get('/cheques/resumen', async (c) => {
  const s = c.get('sesion');
  const cfg = await first<{ d: number }>(c.env.DB, 'SELECT alerta_cheques_dias AS d FROM taller_config WHERE taller_id = ?', s.tallerId);
  const dias = cfg?.d ?? 7;
  const h = hoy();
  const lim = sumarDias(h, dias);
  const [porEstado, proximos, vencidos] = await Promise.all([
    all(c.env.DB, 'SELECT direccion, estado, COUNT(*) AS cantidad, COALESCE(SUM(importe), 0) AS total FROM cheques WHERE taller_id = ? GROUP BY direccion, estado', s.tallerId),
    all(
      c.env.DB,
      `${SELECT} WHERE ch.taller_id = ? AND ((ch.direccion = 'recibido' AND ch.estado = 'en_cartera' AND (ch.fecha_pago BETWEEN ? AND ? OR ch.fecha_vencimiento BETWEEN ? AND ?)) OR (ch.direccion = 'emitido' AND ch.estado = 'entregado' AND ch.fecha_pago BETWEEN ? AND ?)) ORDER BY ch.fecha_pago LIMIT 50`,
      s.tallerId, h, lim, h, lim, h, lim,
    ),
    all(c.env.DB, `${SELECT} WHERE ch.taller_id = ? AND ch.direccion = 'recibido' AND ch.estado = 'en_cartera' AND ch.fecha_vencimiento < ? ORDER BY ch.fecha_vencimiento LIMIT 50`, s.tallerId, h),
  ]);
  const suma = (dir: string, estados: string[]) => (porEstado as any[]).filter((r) => r.direccion === dir && estados.includes(r.estado)).reduce((a, r) => a + r.total, 0);
  return c.json({
    dias_alerta: dias,
    por_estado: porEstado,
    cartera: suma('recibido', ['en_cartera']),
    depositados_pendientes: suma('recibido', ['depositado']),
    emitidos_pendientes: suma('emitido', ['entregado']),
    proximos,
    vencidos,
  });
});

cheques.get('/cheques/:id', async (c) => {
  const s = c.get('sesion');
  const ch = await first<{ id: string }>(c.env.DB, `${SELECT} WHERE ch.taller_id = ? AND ch.id = ?`, s.tallerId, c.req.param('id'));
  if (!ch) throw notFound('Cheque');
  const eventos = await all(c.env.DB, 'SELECT e.*, u.nombre AS usuario FROM cheque_eventos e LEFT JOIN usuarios u ON u.taller_id = e.taller_id AND u.id = e.usuario_id WHERE e.taller_id = ? AND e.cheque_id = ? ORDER BY e.created_at, e.rowid', s.tallerId, ch.id);
  return c.json({ ...ch, eventos });
});

// ───────────── Alta manual ─────────────
cheques.post('/cheques', async (c) => {
  const s = c.get('sesion');
  const d = await body(
    c,
    zChequeDatos.extend({
      direccion: z.enum(['recibido', 'emitido']),
      nro_cheque: z.string().trim().min(1).max(30),
      importe: zCentavos.refine((v) => v > 0, 'el importe debe ser mayor a 0'),
      fecha_emision: zFecha,
      fecha_pago: zFecha,
      cliente_id: zId.nullish(),
      proveedor_id: zId.nullish(),
      entregado: z.boolean().default(false),
    }),
  );
  validarCuitOpcional(d.cuit);
  if (d.modalidad === 'echeq' && !d.echeq_id) throw badRequest('Indicá el ID del eCheq');
  if (d.fecha_pago < d.fecha_emision) throw badRequest('La fecha de pago no puede ser anterior a la de emisión');
  if (d.direccion === 'recibido' && d.proveedor_id) throw badRequest('Un cheque recibido no tiene proveedor');
  if (d.direccion === 'emitido' && d.cliente_id) throw badRequest('Un cheque emitido no tiene cliente');
  if (d.cliente_id && !(await first(c.env.DB, 'SELECT 1 FROM clientes WHERE taller_id = ? AND id = ?', s.tallerId, d.cliente_id))) throw badRequest('Cliente inexistente');
  if (d.proveedor_id && !(await first(c.env.DB, 'SELECT 1 FROM proveedores WHERE taller_id = ? AND id = ?', s.tallerId, d.proveedor_id))) throw badRequest('Proveedor inexistente');
  let banco = d.banco;
  if (d.cuenta_id) {
    const cu = await first<{ banco: string }>(c.env.DB, 'SELECT banco FROM cuentas_bancarias WHERE taller_id = ? AND id = ?', s.tallerId, d.cuenta_id);
    if (!cu) throw badRequest('Cuenta bancaria inexistente');
    if (d.direccion === 'emitido') banco = banco || cu.banco;
  }
  if (d.direccion === 'emitido' && !d.cuenta_id) throw badRequest('Elegí la cuenta contra la que se libra el cheque');
  const id = uid();
  await c.env.DB.batch([
    ...sentenciasChequeNuevo(c.env.DB, s.tallerId, {
      id, direccion: d.direccion, nroCheque: d.nro_cheque, importe: d.importe, estado: d.direccion === 'emitido' && d.entregado ? 'entregado' : 'en_cartera', fechaOperacion: hoy(),
      datos: { ...d, banco }, clienteId: d.cliente_id ?? null, proveedorId: d.proveedor_id ?? null, cuentaId: d.direccion === 'emitido' ? d.cuenta_id ?? null : null,
      origenTipo: 'manual', origenId: null, usuarioId: s.usuarioId,
    }),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'cheque', id, 'crear', { direccion: d.direccion, importe: d.importe, nro: d.nro_cheque }),
  ]);
  return c.json(await first(c.env.DB, `${SELECT} WHERE ch.taller_id = ? AND ch.id = ?`, s.tallerId, id), 201);
});

// ───────────── Cambios de estado ─────────────
interface Ch {
  id: string; numero: number; direccion: 'recibido' | 'emitido'; estado: string; importe: number; nro_cheque: string; banco: string; cuenta_id: string | null;
  fecha_pago: string; fecha_vencimiento: string; origen_tipo: string; proveedor_id: string | null;
}
async function cargar(db: D1Database, tallerId: string, id: string): Promise<Ch> {
  const ch = await first<Ch>(db, 'SELECT * FROM cheques WHERE taller_id = ? AND id = ?', tallerId, id);
  if (!ch) throw notFound('Cheque');
  return ch;
}
const guardEstado = (db: D1Database, tallerId: string, id: string, estado: string) =>
  guard(db, 'NOT EXISTS (SELECT 1 FROM cheques WHERE taller_id = ? AND id = ? AND estado = ?)', tallerId, id, estado);
const setEstado = (db: D1Database, tallerId: string, id: string, estado: string, extra = '', ...params: unknown[]) =>
  db.prepare(`UPDATE cheques SET estado = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')${extra} WHERE taller_id = ? AND id = ?`).bind(estado, ...params, tallerId, id);

cheques.post('/cheques/:id/depositar', async (c) => {
  const s = c.get('sesion');
  const d = await body(c, z.object({ cuenta_id: zId, fecha: zFecha.optional(), confirmar_vencido: z.boolean().default(false) }));
  const ch = await cargar(c.env.DB, s.tallerId, c.req.param('id'));
  if (ch.direccion !== 'recibido' || ch.estado !== 'en_cartera') throw conflict('Sólo se depositan cheques recibidos que están en cartera');
  const fecha = fechaComercial(s, d.fecha);
  if (fecha < ch.fecha_pago) throw conflict(`El cheque no se puede depositar antes de su fecha de pago (${ch.fecha_pago})`, 'antes_de_fecha_pago');
  if (ch.fecha_vencimiento < fecha && !d.confirmar_vencido) throw conflict(`El cheque venció el ${ch.fecha_vencimiento}. Confirmá para depositarlo igual.`, 'cheque_vencido');
  await validarCuentaOperable(c.env.DB, s.tallerId, d.cuenta_id);
  await c.env.DB.batch([
    guardEstado(c.env.DB, s.tallerId, ch.id, 'en_cartera'),
    setEstado(c.env.DB, s.tallerId, ch.id, 'depositado', ', cuenta_id = ?', d.cuenta_id),
    sentenciaEvento(c.env.DB, s.tallerId, ch.id, 'en_cartera', 'depositado', fecha, 'Depositado en la cuenta elegida', s.usuarioId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'cheque', ch.id, 'depositar', { cuenta_id: d.cuenta_id }),
  ]);
  return c.json({ ok: true });
});

cheques.post('/cheques/:id/volver-a-cartera', async (c) => {
  const s = c.get('sesion');
  const ch = await cargar(c.env.DB, s.tallerId, c.req.param('id'));
  if (ch.direccion !== 'recibido' || ch.estado !== 'depositado') throw conflict('Sólo se puede volver a cartera un cheque depositado que todavía no se acreditó');
  await c.env.DB.batch([
    guardEstado(c.env.DB, s.tallerId, ch.id, 'depositado'),
    setEstado(c.env.DB, s.tallerId, ch.id, 'en_cartera', ', cuenta_id = NULL'),
    sentenciaEvento(c.env.DB, s.tallerId, ch.id, 'depositado', 'en_cartera', hoy(), 'Depósito deshecho', s.usuarioId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'cheque', ch.id, 'volver_a_cartera'),
  ]);
  return c.json({ ok: true });
});

cheques.post('/cheques/:id/entregar', async (c) => {
  const s = c.get('sesion');
  const d = await body(c, z.object({ proveedor_id: zId.nullish(), beneficiario: zTextoOpt(120), fecha: zFecha.optional() }));
  const ch = await cargar(c.env.DB, s.tallerId, c.req.param('id'));
  if (ch.direccion !== 'emitido' || ch.estado !== 'en_cartera') throw conflict('Sólo se entregan cheques emitidos que todavía están sin entregar. Para pagar con un cheque recibido, registrá el pago al proveedor.');
  if (d.proveedor_id && !(await first(c.env.DB, 'SELECT 1 FROM proveedores WHERE taller_id = ? AND id = ?', s.tallerId, d.proveedor_id))) throw badRequest('Proveedor inexistente');
  const fecha = fechaComercial(s, d.fecha);
  await c.env.DB.batch([
    guardEstado(c.env.DB, s.tallerId, ch.id, 'en_cartera'),
    setEstado(c.env.DB, s.tallerId, ch.id, 'entregado', ', proveedor_id = COALESCE(?, proveedor_id), beneficiario = COALESCE(?, beneficiario)', d.proveedor_id ?? null, d.beneficiario ?? null),
    sentenciaEvento(c.env.DB, s.tallerId, ch.id, 'en_cartera', 'entregado', fecha, 'Entregado al beneficiario', s.usuarioId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'cheque', ch.id, 'entregar'),
  ]);
  return c.json({ ok: true });
});

/** Acreditación: un recibido depositado entra al banco; un emitido entregado se debita de la cuenta librada. */
cheques.post('/cheques/:id/acreditar', async (c) => {
  const s = c.get('sesion');
  const d = await body(c, z.object({ fecha: zFecha.optional(), cuenta_id: zId.nullish() }));
  const ch = await cargar(c.env.DB, s.tallerId, c.req.param('id'));
  const esperado = ch.direccion === 'recibido' ? 'depositado' : 'entregado';
  if (ch.estado !== esperado) throw conflict(ch.direccion === 'recibido' ? 'Sólo se acredita un cheque recibido que fue depositado' : 'Sólo se debita un cheque emitido que fue entregado');
  const fecha = fechaComercial(s, d.fecha);
  const cuentaId = ch.cuenta_id ?? d.cuenta_id ?? null;
  if (!cuentaId) throw badRequest('Elegí la cuenta bancaria en la que se acredita el cheque');
  await validarCuentaOperable(c.env.DB, s.tallerId, cuentaId);
  // Un cheque que no nació de un cobro/pago (carga manual) nunca pasó por la caja: su acreditación sí es un ingreso/egreso del negocio.
  const afecta = ch.origen_tipo === 'manual';
  const movId = uid();
  await c.env.DB.batch([
    guardEstado(c.env.DB, s.tallerId, ch.id, esperado),
    setEstado(c.env.DB, s.tallerId, ch.id, 'acreditado', ', cuenta_id = ?', cuentaId),
    sentenciaMovBanco(c.env.DB, s.tallerId, {
      id: movId, cuentaId, tipo: ch.direccion === 'recibido' ? 'ingreso' : 'egreso', categoria: 'cheque', importe: ch.importe,
      concepto: `${ch.direccion === 'recibido' ? 'Acreditación' : 'Débito'} de cheque ${ch.banco} N° ${ch.nro_cheque}`, referencia: ch.nro_cheque,
      origenTipo: 'cheque', origenId: ch.id, fecha, afectaResultado: afecta, usuarioId: s.usuarioId,
    }),
    sentenciaEvento(c.env.DB, s.tallerId, ch.id, esperado, 'acreditado', fecha, ch.direccion === 'recibido' ? 'Acreditado en el banco' : 'Debitado de la cuenta', s.usuarioId, movId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'cheque', ch.id, 'acreditar', { cuenta_id: cuentaId, importe: ch.importe }),
  ]);
  return c.json({ ok: true });
});

cheques.post('/cheques/:id/rechazar', async (c) => {
  const s = c.get('sesion');
  const d = await body(c, z.object({ motivo: z.string().trim().min(3).max(300), fecha: zFecha.optional(), comision: zCentavos.default(0) }));
  const ch = await cargar(c.env.DB, s.tallerId, c.req.param('id'));
  const permitidos = ch.direccion === 'recibido' ? ['depositado', 'acreditado', 'entregado'] : ['entregado'];
  if (!permitidos.includes(ch.estado)) throw conflict(`Un cheque ${ch.estado.replace('_', ' ')} no se puede rechazar`);
  const fecha = fechaComercial(s, d.fecha);
  const stmts: Stmt[] = [guardEstado(c.env.DB, s.tallerId, ch.id, ch.estado)];
  // Si ya se había acreditado, se revierte el ingreso bancario (contra-asiento).
  if (ch.estado === 'acreditado') stmts.push(reversoBancoDeOrigen(c.env.DB, s.tallerId, 'cheque', ch.id, s.usuarioId));
  if (d.comision > 0) {
    if (!ch.cuenta_id) throw badRequest('Para cargar la comisión del banco, el cheque tiene que haber pasado por una cuenta');
    stmts.push(
      sentenciaMovBanco(c.env.DB, s.tallerId, {
        cuentaId: ch.cuenta_id, tipo: 'egreso', categoria: 'manual', importe: d.comision, concepto: `Comisión por cheque rechazado N° ${ch.nro_cheque}`, referencia: ch.nro_cheque,
        origenTipo: 'cheque_comision', origenId: ch.id, fecha, afectaResultado: true, usuarioId: s.usuarioId,
      }),
    );
  }
  stmts.push(
    setEstado(c.env.DB, s.tallerId, ch.id, 'rechazado', ', motivo_rechazo = ?', d.motivo),
    sentenciaEvento(c.env.DB, s.tallerId, ch.id, ch.estado, 'rechazado', fecha, d.motivo, s.usuarioId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'cheque', ch.id, 'rechazar', { motivo: d.motivo, desde: ch.estado }),
  );
  await c.env.DB.batch(stmts);
  return c.json({
    ok: true,
    aviso: ch.direccion === 'recibido' && ch.origen_tipo === 'cobro_medio' ? 'El cobro que originó este cheque sigue registrado: anulalo para que la deuda del cliente vuelva a figurar.' : null,
  });
});

cheques.post('/cheques/:id/anular', async (c) => {
  const s = c.get('sesion');
  const { motivo } = await body(c, z.object({ motivo: z.string().trim().min(3).max(300) }));
  const ch = await cargar(c.env.DB, s.tallerId, c.req.param('id'));
  if (ch.origen_tipo !== 'manual') throw conflict('Este cheque nació de un cobro o un pago: se anula junto con esa operación.');
  if (!['en_cartera', 'entregado'].includes(ch.estado)) throw conflict(`Un cheque ${ch.estado.replace('_', ' ')} no se puede anular`);
  await c.env.DB.batch([
    guardEstado(c.env.DB, s.tallerId, ch.id, ch.estado),
    setEstado(c.env.DB, s.tallerId, ch.id, 'anulado'),
    sentenciaEvento(c.env.DB, s.tallerId, ch.id, ch.estado, 'anulado', hoy(), motivo, s.usuarioId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'cheque', ch.id, 'anular', { motivo }),
  ]);
  return c.json({ ok: true });
});

void ESTADOS_CHEQUE;
