// Medio de pago de un egreso (pago a proveedor o gasto): cuenta bancaria de la que sale, o cheque (propio o endosado de cartera).
// Se ejecuta dentro del mismo batch que el pago/gasto y su egreso de caja.
import { z } from 'zod';
import { first, guard, type Stmt } from './db';
import { badRequest, conflict, zId } from './http';
import { guardCuentaActiva, sentenciaMovBanco, validarCuentaOperable } from './banco';
import { sentenciaEvento, sentenciasChequeNuevo, validarCuitOpcional, zChequeDatos, type ChequeDatos } from './cheques';
import { MEDIOS_BANCARIOS } from '../../shared/dominio';
import { exigirMediosHabilitados } from './config';

export const zMedioEgreso = {
  cuenta_id: zId.nullish(),
  /** Cheque de la cartera (recibido) que se endosa para pagar. */
  cheque_id: zId.nullish(),
  /** Datos del cheque propio que se emite para pagar. */
  cheque: zChequeDatos.partial().nullish(),
};
export const zMedioEgresoObj = z.object(zMedioEgreso);
export type MedioEgreso = z.infer<typeof zMedioEgresoObj>;

export interface EgresoCtx {
  origenTipo: 'pago_proveedor' | 'gasto';
  origenId: string;
  medio: string;
  importe: number;
  referencia?: string | null;
  fecha: string;
  concepto: string;
  proveedorId?: string | null;
  usuarioId: string;
}

/** Validaciones previas con mensajes claros (las garantías reales son los guards dentro del batch). */
export async function validarMedioEgreso(db: D1Database, tallerId: string, ctx: Pick<EgresoCtx, 'origenTipo' | 'medio' | 'importe' | 'referencia'>, x: MedioEgreso): Promise<MedioEgreso> {
  await exigirMediosHabilitados(db, tallerId, [ctx.medio]);
  if (x.cuenta_id) {
    if (!MEDIOS_BANCARIOS.includes(ctx.medio)) throw badRequest('Sólo los medios electrónicos salen de una cuenta bancaria');
    await validarCuentaOperable(db, tallerId, x.cuenta_id, ctx.medio);
  }
  if (ctx.medio !== 'cheque') {
    if (x.cheque_id || x.cheque) throw badRequest('Los datos de cheque sólo corresponden al medio "cheque"');
    return x;
  }
  if (x.cheque_id) {
    if (ctx.origenTipo !== 'pago_proveedor') throw badRequest('Sólo se pueden endosar cheques de cartera en pagos a proveedores');
    const ch = await first<{ estado: string; direccion: string; importe: number; nro_cheque: string }>(db, 'SELECT estado, direccion, importe, nro_cheque FROM cheques WHERE taller_id = ? AND id = ?', tallerId, x.cheque_id);
    if (!ch || ch.direccion !== 'recibido') throw badRequest('Cheque inexistente');
    if (ch.estado !== 'en_cartera') throw conflict(`El cheque ${ch.nro_cheque} no está en cartera`, 'cheque_no_disponible');
    if (ch.importe !== ctx.importe) throw badRequest(`El importe del pago debe ser igual al del cheque endosado (${(ch.importe / 100).toLocaleString('es-AR')})`);
    return x;
  }
  if (!ctx.referencia?.trim()) throw badRequest('Indicá el número de cheque en la referencia');
  validarCuitOpcional(x.cheque?.cuit);
  const cuentaCheque = x.cheque?.cuenta_id;
  let banco = x.cheque?.banco;
  if (cuentaCheque) {
    const c = await first<{ banco: string }>(db, 'SELECT banco FROM cuentas_bancarias WHERE taller_id = ? AND id = ?', tallerId, cuentaCheque);
    if (!c) throw badRequest('La cuenta librada del cheque no existe');
    banco = banco || c.banco;
  }
  return { ...x, cheque: { ...(x.cheque ?? {}), banco } };
}

export function sentenciasMedioEgreso(db: D1Database, tallerId: string, ctx: EgresoCtx, x: MedioEgreso): Stmt[] {
  const s: Stmt[] = [];
  if (x.cuenta_id && MEDIOS_BANCARIOS.includes(ctx.medio)) {
    s.push(
      guardCuentaActiva(db, tallerId, x.cuenta_id),
      sentenciaMovBanco(db, tallerId, {
        cuentaId: x.cuenta_id, tipo: 'egreso', categoria: ctx.origenTipo, importe: ctx.importe, concepto: ctx.concepto, referencia: ctx.referencia,
        origenTipo: ctx.origenTipo, origenId: ctx.origenId, fecha: ctx.fecha, afectaResultado: false, usuarioId: ctx.usuarioId,
      }),
    );
  }
  if (ctx.medio !== 'cheque') return s;
  if (x.cheque_id) {
    s.push(
      guard(db, "NOT EXISTS (SELECT 1 FROM cheques WHERE taller_id = ? AND id = ? AND direccion = 'recibido' AND estado = 'en_cartera')", tallerId, x.cheque_id),
      db
        .prepare("UPDATE cheques SET estado = 'entregado', proveedor_id = ?, entrega_pago_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ? AND id = ?")
        .bind(ctx.proveedorId ?? null, ctx.origenId, tallerId, x.cheque_id),
      sentenciaEvento(db, tallerId, x.cheque_id, 'en_cartera', 'entregado', ctx.fecha, 'Endosado en un pago a proveedor', ctx.usuarioId),
    );
    return s;
  }
  const datos = (x.cheque ?? {}) as Partial<ChequeDatos>;
  s.push(
    ...sentenciasChequeNuevo(db, tallerId, {
      id: crypto.randomUUID(), direccion: 'emitido', nroCheque: ctx.referencia!.trim(), importe: ctx.importe, estado: 'entregado', fechaOperacion: ctx.fecha,
      datos, proveedorId: ctx.proveedorId ?? null, cuentaId: datos.cuenta_id ?? null, origenTipo: ctx.origenTipo, origenId: ctx.origenId, usuarioId: ctx.usuarioId,
    }),
  );
  return s;
}
