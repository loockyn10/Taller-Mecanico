// Cartera de cheques y eCheq: alta, historial y sentencias que usan cobros, pagos y gastos.
//
// Un cheque que nace de un cobro/pago/gasto lleva (origen_tipo, origen_id) único: el mismo hecho no genera dos cheques.
// Los cambios de estado quedan en cheque_eventos. El dinero de un cheque ya entró (cobro) o salió (pago) en el libro de caja con
// medio 'cheque'; depositarlo/acreditarlo sólo mueve esa plata entre la cartera y el banco (no es un ingreso nuevo).
import { z } from 'zod';
import { first, guard, SEQ_VALOR, seqIncrementar, uid, type Stmt } from './db';
import { badRequest, conflict, zFecha, zTextoOpt } from './http';
import { cuitValido, DIAS_VALIDEZ_CHEQUE } from '../../shared/dominio';
import { sumarDias } from './fechas';

export const zChequeDatos = z.object({
  banco: z.string().trim().min(2).max(80),
  modalidad: z.enum(['fisico', 'echeq']).default('fisico'),
  echeq_id: zTextoOpt(60),
  librador: zTextoOpt(120),
  cuit: zTextoOpt(20),
  beneficiario: zTextoOpt(120),
  fecha_emision: zFecha.optional(),
  fecha_pago: zFecha.optional(),
  cuenta_id: z.string().min(1).max(64).nullish(),
  observaciones: zTextoOpt(300),
});
export type ChequeDatos = z.infer<typeof zChequeDatos>;

export function validarCuitOpcional(cuit: string | null | undefined) {
  if (cuit && !cuitValido(cuit)) throw badRequest('El CUIT del cheque no es válido');
}

export interface ChequeNuevo {
  id: string;
  direccion: 'recibido' | 'emitido';
  nroCheque: string;
  importe: number;
  estado: 'en_cartera' | 'entregado';
  fechaOperacion: string;
  datos: Partial<ChequeDatos> & { banco?: string };
  clienteId?: string | null;
  proveedorId?: string | null;
  cuentaId?: string | null;
  origenTipo: 'manual' | 'cobro_medio' | 'pago_proveedor' | 'gasto';
  origenId?: string | null;
  usuarioId: string;
}

/** Inserta el cheque y su primer evento. Debe ir dentro del batch de la operación que lo origina. */
export function sentenciasChequeNuevo(db: D1Database, tallerId: string, c: ChequeNuevo): Stmt[] {
  const fechaPago = c.datos.fecha_pago ?? c.fechaOperacion;
  const emision = c.datos.fecha_emision ?? (fechaPago < c.fechaOperacion ? fechaPago : c.fechaOperacion);
  const detalleEvento = c.origenTipo === 'manual' ? 'Registro manual' : c.origenTipo === 'cobro_medio' ? 'Recibido en un cobro' : c.origenTipo === 'pago_proveedor' ? 'Emitido en un pago a proveedor' : 'Emitido en un gasto';
  return [
    ...seqIncrementar(db, tallerId, 'cheque'),
    db
      .prepare(
        `INSERT INTO cheques (id, taller_id, numero, direccion, modalidad, banco, nro_cheque, echeq_id, librador, cuit, beneficiario, importe, fecha_emision, fecha_pago, fecha_vencimiento,
                              estado, cliente_id, proveedor_id, cuenta_id, origen_tipo, origen_id, observaciones, usuario_id)
         VALUES (?, ?, ${SEQ_VALOR}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        c.id, tallerId, tallerId, 'cheque', c.direccion, c.datos.modalidad ?? 'fisico', c.datos.banco ?? 'Sin especificar', c.nroCheque, c.datos.echeq_id ?? null,
        c.datos.librador ?? null, c.datos.cuit ?? null, c.datos.beneficiario ?? null, c.importe, emision, fechaPago, sumarDias(fechaPago, DIAS_VALIDEZ_CHEQUE),
        c.estado, c.clienteId ?? null, c.proveedorId ?? null, c.cuentaId ?? null, c.origenTipo, c.origenId ?? null, c.datos.observaciones ?? null, c.usuarioId,
      ),
    sentenciaEvento(db, tallerId, c.id, null, c.estado, c.fechaOperacion, detalleEvento, c.usuarioId),
  ];
}

export function sentenciaEvento(db: D1Database, tallerId: string, chequeId: string, desde: string | null, hacia: string, fecha: string, detalle: string | null, usuarioId: string, bancoMovId: string | null = null): Stmt {
  return db
    .prepare('INSERT INTO cheque_eventos (id, taller_id, cheque_id, estado_desde, estado_hacia, fecha, detalle, banco_mov_id, usuario_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(uid(), tallerId, chequeId, desde, hacia, fecha, detalle, bancoMovId, usuarioId);
}

/**
 * Antes de anular un cobro o un pago: sus cheques no pueden haber salido de la cartera (depositados, entregados o acreditados).
 * Devuelve el mensaje de error o null.
 */
export async function chequesBloqueanAnulacion(db: D1Database, tallerId: string, donde: string, params: unknown[], estados: readonly string[] = ['depositado', 'entregado', 'acreditado']): Promise<string | null> {
  const c = await first<{ nro_cheque: string; estado: string }>(
    db,
    `SELECT nro_cheque, estado FROM cheques WHERE taller_id = ? AND (${donde}) AND estado IN (${estados.map((e) => "'" + e + "'").join(',')}) LIMIT 1`,
    tallerId,
    ...params,
  );
  return c ? `El cheque ${c.nro_cheque} ya está ${c.estado}. Rechazalo o revertí su estado antes de anular la operación.` : null;
}

/** Cheques de los medios de un cobro: pasan a 'anulado' junto con el cobro. */
export function sentenciasAnularChequesDeCobro(db: D1Database, tallerId: string, cobroId: string, usuarioId: string, fecha: string): Stmt[] {
  const donde = "origen_tipo = 'cobro_medio' AND origen_id IN (SELECT id FROM cobro_medios WHERE taller_id = cheques.taller_id AND cobro_id = ?)";
  return [
    guard(db, `EXISTS (SELECT 1 FROM cheques WHERE taller_id = ? AND ${donde} AND estado IN ('depositado','entregado','acreditado'))`, tallerId, cobroId),
    db
      .prepare(
        `INSERT INTO cheque_eventos (id, taller_id, cheque_id, estado_desde, estado_hacia, fecha, detalle, usuario_id)
         SELECT lower(hex(randomblob(16))), taller_id, id, estado, 'anulado', ?, 'Anulado junto con el cobro', ? FROM cheques WHERE taller_id = ? AND ${donde} AND estado = 'en_cartera'`,
      )
      .bind(fecha, usuarioId, tallerId, cobroId),
    db.prepare(`UPDATE cheques SET estado = 'anulado', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ? AND ${donde} AND estado = 'en_cartera'`).bind(tallerId, cobroId),
  ];
}

/** Cheques emitidos por un pago/gasto anulado → anulados; cheques de cartera endosados en ese pago → vuelven a cartera. */
export function sentenciasAnularChequesDePago(db: D1Database, tallerId: string, origenTipo: 'pago_proveedor' | 'gasto', origenId: string, usuarioId: string, fecha: string): Stmt[] {
  const stmts: Stmt[] = [
    guard(db, "EXISTS (SELECT 1 FROM cheques WHERE taller_id = ? AND origen_tipo = ? AND origen_id = ? AND estado = 'acreditado')", tallerId, origenTipo, origenId),
    db
      .prepare(
        `INSERT INTO cheque_eventos (id, taller_id, cheque_id, estado_desde, estado_hacia, fecha, detalle, usuario_id)
         SELECT lower(hex(randomblob(16))), taller_id, id, estado, 'anulado', ?, 'Anulado junto con el pago', ? FROM cheques WHERE taller_id = ? AND origen_tipo = ? AND origen_id = ? AND estado IN ('en_cartera','entregado')`,
      )
      .bind(fecha, usuarioId, tallerId, origenTipo, origenId),
    db.prepare(`UPDATE cheques SET estado = 'anulado', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ? AND origen_tipo = ? AND origen_id = ? AND estado IN ('en_cartera','entregado')`).bind(tallerId, origenTipo, origenId),
  ];
  if (origenTipo === 'pago_proveedor') {
    stmts.push(
      db
        .prepare(
          `INSERT INTO cheque_eventos (id, taller_id, cheque_id, estado_desde, estado_hacia, fecha, detalle, usuario_id)
           SELECT lower(hex(randomblob(16))), taller_id, id, 'entregado', 'en_cartera', ?, 'Vuelve a cartera: se anuló el pago al que se entregó', ? FROM cheques WHERE taller_id = ? AND entrega_pago_id = ? AND estado = 'entregado'`,
        )
        .bind(fecha, usuarioId, tallerId, origenId),
      db.prepare(`UPDATE cheques SET estado = 'en_cartera', proveedor_id = NULL, entrega_pago_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ? AND entrega_pago_id = ? AND estado = 'entregado'`).bind(tallerId, origenId),
    );
  }
  return stmts;
}

export const conflictoDuplicado = () => conflict('Ese cheque ya está registrado (mismo banco, número y librador)', 'duplicado');
