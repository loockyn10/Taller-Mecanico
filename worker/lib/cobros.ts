// Registro de un cobro (recibo) aplicado a comprobantes, con su ingreso de caja, en un único batch.
// Lo usan POST /cobros, la venta de mostrador de contado y el comprobante de OT con cobro inmediato: así existe un solo camino
// que escribe cobros y ninguno de los tres puede duplicar movimientos de caja.
import { auditar, guard, SEQ_VALOR, seqIncrementar, uid, type Stmt } from './db';
import { guardCajaObligatoria, sentenciaIngresosDeCobro } from './caja';
import type { MedioPago } from '../../shared/dominio';

export interface DatosCobro {
  id: string;
  clienteId: string;
  fecha: string;
  medios: Array<{ medio: MedioPago; importe: number; referencia?: string | null }>;
  aplicaciones: Array<{ ventaId: string; importe: number }>;
  notas?: string | null;
  idemKey: string;
}

export function sentenciasCobro(db: D1Database, s: { tallerId: string; usuarioId: string }, c: DatosCobro): Stmt[] {
  const total = c.medios.reduce((a, m) => a + m.importe, 0);
  const stmts: Stmt[] = [
    guardCajaObligatoria(db, s.tallerId),
    ...seqIncrementar(db, s.tallerId, 'cobro'),
    db
      .prepare(`INSERT INTO cobros (id, taller_id, numero, cliente_id, fecha, total, idem_key, notas, usuario_id) VALUES (?, ?, ${SEQ_VALOR}, ?, ?, ?, ?, ?, ?)`)
      .bind(c.id, s.tallerId, s.tallerId, 'cobro', c.clienteId, c.fecha, total, c.idemKey, c.notas ?? null, s.usuarioId),
    ...c.medios.map((m) =>
      db.prepare('INSERT INTO cobro_medios (id, taller_id, cobro_id, medio, importe, referencia) VALUES (?, ?, ?, ?, ?, ?)').bind(uid(), s.tallerId, c.id, m.medio, m.importe, m.referencia ?? null),
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
  stmts.push(sentenciaIngresosDeCobro(db, s.tallerId, c.id), auditar(db, s.tallerId, s.usuarioId, 'cobro', c.id, 'crear', { total }));
  return stmts;
}
