// Registro de un cobro (recibo) aplicado a comprobantes, con su ingreso de caja, su movimiento bancario y su cheque, en un único batch.
// Lo usan POST /cobros, la venta de mostrador de contado y el comprobante de OT con cobro inmediato: así existe un solo camino
// que escribe cobros y ninguno de los tres puede duplicar movimientos de caja, de banco ni de cartera.
import { z } from 'zod';
import { auditar, guard, SEQ_VALOR, seqIncrementar, uid, type Stmt } from './db';
import { guardCajaObligatoria, sentenciaIngresosDeCobro } from './caja';
import { sentenciasBancoDeCobro, validarCuentaOperable } from './banco';
import { sentenciasChequeNuevo, validarCuitOpcional, zChequeDatos, type ChequeDatos } from './cheques';
import { badRequest, zId, zTextoOpt } from './http';
import { exigirMediosHabilitados } from './config';
import { MEDIOS_BANCARIOS, MEDIOS_PAGO, type MedioPago } from '../../shared/dominio';

export interface MedioCobro {
  medio: MedioPago;
  importe: number;
  referencia?: string | null;
  /** Cuenta bancaria en la que se acredita (transferencia, tarjetas y otros medios electrónicos). */
  cuentaId?: string | null;
  /** Datos del cheque recibido (medio 'cheque'): queda registrado en la cartera. */
  cheque?: Partial<ChequeDatos> | null;
}

export interface DatosCobro {
  id: string;
  clienteId: string;
  fecha: string;
  medios: MedioCobro[];
  aplicaciones: Array<{ ventaId: string; importe: number }>;
  notas?: string | null;
  idemKey: string;
  /** 'anticipo' = dinero recibido antes de la venta: no se aplica a ningún comprobante (se aplica después, ver lib/creditos.ts). */
  tipo?: 'cobro' | 'anticipo';
  ordenId?: string | null;
  presupuestoId?: string | null;
}

/** Validaciones previas (mensajes claros) de los medios: cuenta bancaria, cheque y medios habilitados. */
export async function validarMediosCobro(db: D1Database, tallerId: string, medios: MedioCobro[]) {
  await exigirMediosHabilitados(db, tallerId, medios.map((m) => m.medio));
  for (const m of medios) {
    if (m.medio === 'cheque' && !m.referencia?.trim()) throw badRequest('Indicá el número de cheque en la referencia');
    if (m.cuentaId) {
      if (!MEDIOS_BANCARIOS.includes(m.medio)) throw badRequest('Sólo los medios electrónicos se acreditan en una cuenta bancaria');
      await validarCuentaOperable(db, tallerId, m.cuentaId, m.medio);
    }
    if (m.medio === 'cheque') validarCuitOpcional(m.cheque?.cuit);
  }
}

export function sentenciasCobro(db: D1Database, s: { tallerId: string; usuarioId: string }, c: DatosCobro): Stmt[] {
  const total = c.medios.reduce((a, m) => a + m.importe, 0);
  const idsMedio = c.medios.map(() => uid());
  const stmts: Stmt[] = [
    guardCajaObligatoria(db, s.tallerId),
    ...seqIncrementar(db, s.tallerId, 'cobro'),
    db
      .prepare(`INSERT INTO cobros (id, taller_id, numero, cliente_id, fecha, total, idem_key, notas, usuario_id, tipo, orden_id, presupuesto_id) VALUES (?, ?, ${SEQ_VALOR}, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(c.id, s.tallerId, s.tallerId, 'cobro', c.clienteId, c.fecha, total, c.idemKey, c.notas ?? null, s.usuarioId, c.tipo ?? 'cobro', c.ordenId ?? null, c.presupuestoId ?? null),
    ...c.medios.map((m, i) =>
      db.prepare('INSERT INTO cobro_medios (id, taller_id, cobro_id, medio, importe, referencia, cuenta_id) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(idsMedio[i], s.tallerId, c.id, m.medio, m.importe, m.referencia ?? null, m.cuentaId ?? null),
    ),
  ];
  for (const a of c.aplicaciones) {
    stmts.push(
      guard(db, "NOT EXISTS (SELECT 1 FROM ventas WHERE taller_id = ? AND id = ? AND estado = 'emitida')", s.tallerId, a.ventaId),
      db.prepare('INSERT INTO cobro_aplicaciones (id, taller_id, cobro_id, venta_id, importe) VALUES (?, ?, ?, ?, ?)').bind(uid(), s.tallerId, c.id, a.ventaId, a.importe),
      // El CHECK (cobrado <= total) aborta el batch si el saldo cambió entre la validación y la escritura.
      db.prepare('UPDATE ventas SET cobrado = cobrado + ? WHERE taller_id = ? AND id = ?').bind(a.importe, s.tallerId, a.ventaId),
    );
  }
  stmts.push(sentenciaIngresosDeCobro(db, s.tallerId, c.id));
  if (c.medios.some((m) => m.cuentaId)) stmts.push(...sentenciasBancoDeCobro(db, s.tallerId, c.id));
  // Cada cheque recibido entra a la cartera (en cartera); depositarlo o acreditarlo después es un movimiento entre cartera y banco.
  c.medios.forEach((m, i) => {
    if (m.medio !== 'cheque') return;
    stmts.push(
      ...sentenciasChequeNuevo(db, s.tallerId, {
        id: uid(), direccion: 'recibido', nroCheque: m.referencia!.trim(), importe: m.importe, estado: 'en_cartera', fechaOperacion: c.fecha,
        datos: m.cheque ?? {}, clienteId: c.clienteId, origenTipo: 'cobro_medio', origenId: idsMedio[i], usuarioId: s.usuarioId,
      }),
    );
  });
  stmts.push(auditar(db, s.tallerId, s.usuarioId, 'cobro', c.id, 'crear', { total, tipo: c.tipo ?? 'cobro' }));
  return stmts;
}

/** Cobro inmediato (venta de contado / comprobante de OT): un medio por el total. */
export const zCobroInmediato = z.object({
  medio: z.enum(MEDIOS_PAGO),
  referencia: zTextoOpt(120),
  cuenta_id: zId.nullish(),
  cheque: zChequeDatos.partial().nullish(),
});
export const medioDeCobroInmediato = (c: z.infer<typeof zCobroInmediato>, importe: number): MedioCobro => ({
  medio: c.medio, importe, referencia: c.referencia, cuentaId: c.cuenta_id ?? null, cheque: c.cheque ?? null,
});
