// Reintegro de dinero a un cliente (devolución de una nota de crédito o de un anticipo), con su egreso de caja y su movimiento bancario
// en el MISMO batch que la operación que lo origina. Mismo criterio que los cobros (lib/cobros.ts), en sentido contrario:
//  * un reintegro = un egreso de caja por medio de pago (rubro `devolucion`), con índice único (origen, id) que impide duplicarlo;
//  * si el medio se acredita/debita en una cuenta bancaria, su espejo bancario no genera resultado propio (la plata se cuenta una vez, en el libro de caja);
//  * anular un reintegro no borra nada: genera un contra-asiento en la caja abierta de ese momento.
import { z } from 'zod';
import { auditar, guard, SEQ_VALOR, seqIncrementar, uid, type Stmt } from './db';
import { guardCajaObligatoria, sentenciaReversos } from './caja';
import { guardCuentaActiva, sentenciaReversosBanco, validarCuentaOperable } from './banco';
import { badRequest, zCentavos, zId, zTextoOpt } from './http';
import { exigirMediosHabilitados } from './config';
import { MEDIOS_REINTEGRO, type MedioPago } from '../../shared/dominio';

export interface MedioReintegro {
  medio: MedioPago;
  importe: number;
  referencia?: string | null;
  cuentaId?: string | null;
}

export interface DatosReintegro {
  id: string;
  clienteId: string;
  origenTipo: 'devolucion' | 'anticipo';
  origenId: string;
  fecha: string;
  medios: MedioReintegro[];
  motivo?: string | null;
  idemKey: string;
}

export const zMedioReintegro = z.object({
  medio: z.enum(['efectivo', 'transferencia', 'debito', 'credito', 'otro']),
  importe: zCentavos.refine((v) => v > 0, 'importe debe ser mayor a 0'),
  referencia: zTextoOpt(120),
  cuenta_id: zId.nullish(),
});
export const aMedioReintegro = (m: z.infer<typeof zMedioReintegro>): MedioReintegro => ({ medio: m.medio, importe: m.importe, referencia: m.referencia, cuentaId: m.cuenta_id ?? null });

/** Validaciones previas (mensajes claros): medios permitidos y habilitados, cuenta bancaria operable. */
export async function validarMediosReintegro(db: D1Database, tallerId: string, medios: MedioReintegro[]) {
  for (const m of medios) if (!MEDIOS_REINTEGRO.includes(m.medio)) throw badRequest('Un reintegro no puede hacerse con cheque');
  await exigirMediosHabilitados(db, tallerId, medios.map((m) => m.medio));
  for (const m of medios) if (m.cuentaId) await validarCuentaOperable(db, tallerId, m.cuentaId, m.medio);
}

export function sentenciasReintegro(db: D1Database, s: { tallerId: string; usuarioId: string }, r: DatosReintegro): Stmt[] {
  const total = r.medios.reduce((a, m) => a + m.importe, 0);
  const stmts: Stmt[] = [
    guardCajaObligatoria(db, s.tallerId),
    ...seqIncrementar(db, s.tallerId, 'reintegro'),
    db
      .prepare(`INSERT INTO reintegros (id, taller_id, numero, cliente_id, origen_tipo, origen_id, fecha, total, motivo, idem_key, usuario_id) VALUES (?, ?, ${SEQ_VALOR}, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(r.id, s.tallerId, s.tallerId, 'reintegro', r.clienteId, r.origenTipo, r.origenId, r.fecha, total, r.motivo ?? null, r.idemKey, s.usuarioId),
    ...r.medios.map((m) =>
      db.prepare('INSERT INTO reintegro_medios (id, taller_id, reintegro_id, medio, importe, referencia, cuenta_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(uid(), s.tallerId, r.id, m.medio, m.importe, m.referencia ?? null, m.cuentaId ?? null),
    ),
    // Egreso de caja: una línea por medio. La sesión de caja se toma de la caja abierta dentro de la propia sentencia.
    db
      .prepare(
        `INSERT INTO caja_movimientos (id, taller_id, sesion_id, tipo, rubro, medio, importe, concepto, referencia, origen_tipo, origen_id, fecha, usuario_id)
         SELECT lower(hex(randomblob(16))), rm.taller_id, (SELECT id FROM caja_sesiones WHERE taller_id = rm.taller_id AND estado = 'abierta'), 'egreso', 'devolucion', rm.medio, rm.importe,
                'Reintegro #' || re.numero || ' · ' || cl.nombre, rm.referencia, 'reintegro', rm.id, re.fecha, re.usuario_id
           FROM reintegro_medios rm
           JOIN reintegros re ON re.taller_id = rm.taller_id AND re.id = rm.reintegro_id
           JOIN clientes cl ON cl.taller_id = re.taller_id AND cl.id = re.cliente_id
          WHERE rm.taller_id = ? AND rm.reintegro_id = ?`,
      )
      .bind(s.tallerId, r.id),
  ];
  for (const m of r.medios) if (m.cuentaId) stmts.push(guardCuentaActiva(db, s.tallerId, m.cuentaId));
  if (r.medios.some((m) => m.cuentaId)) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO banco_movimientos (id, taller_id, cuenta_id, fecha, tipo, categoria, importe, concepto, referencia, origen_tipo, origen_id, afecta_resultado, usuario_id)
           SELECT lower(hex(randomblob(16))), rm.taller_id, rm.cuenta_id, re.fecha, 'egreso', 'devolucion', rm.importe,
                  'Reintegro #' || re.numero || ' · ' || cl.nombre, rm.referencia, 'reintegro_medio', rm.id, 0, re.usuario_id
             FROM reintegro_medios rm
             JOIN reintegros re ON re.taller_id = rm.taller_id AND re.id = rm.reintegro_id
             JOIN clientes cl ON cl.taller_id = re.taller_id AND cl.id = re.cliente_id
            WHERE rm.taller_id = ? AND rm.reintegro_id = ? AND rm.cuenta_id IS NOT NULL`,
        )
        .bind(s.tallerId, r.id),
    );
  }
  stmts.push(auditar(db, s.tallerId, s.usuarioId, 'reintegro', r.id, 'crear', { total, origen: r.origenTipo, origen_id: r.origenId }));
  return stmts;
}

/** Contra-asientos de caja y banco de un reintegro (cada movimiento se revierte una sola vez). */
export function sentenciasReversoReintegro(db: D1Database, tallerId: string, reintegroId: string, usuarioId: string): Stmt[] {
  return [
    sentenciaReversos(db, tallerId, "m.origen_tipo = 'reintegro' AND m.origen_id IN (SELECT id FROM reintegro_medios WHERE taller_id = m.taller_id AND reintegro_id = ?)", [reintegroId], usuarioId),
    sentenciaReversosBanco(db, tallerId, "m.origen_tipo = 'reintegro_medio' AND m.origen_id IN (SELECT id FROM reintegro_medios WHERE taller_id = m.taller_id AND reintegro_id = ?)", [reintegroId], usuarioId),
  ];
}

/** Aborta el batch si el reintegro ya fue anulado entre la lectura y la escritura. */
export const guardReintegroVigente = (db: D1Database, tallerId: string, reintegroId: string): Stmt =>
  guard(db, "NOT EXISTS (SELECT 1 FROM reintegros WHERE taller_id = ? AND id = ? AND estado = 'registrado')", tallerId, reintegroId);
