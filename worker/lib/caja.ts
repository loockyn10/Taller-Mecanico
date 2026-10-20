// Libro de caja (caja_movimientos): todo movimiento de dinero se registra acá, en el MISMO batch que la operación comercial.
//
// Reglas:
//  * La sesión de caja se toma de la caja abierta dentro de la propia sentencia SQL (no se lee antes): usuarios simultáneos
//    siempre caen en la misma caja y un cierre concurrente no deja movimientos "a medias".
//  * El índice único (taller_id, origen_tipo, origen_id) impide registrar dos veces el mismo hecho de origen.
//  * Las anulaciones no borran: generan un 'reverso' (contra-asiento) en la caja abierta al momento de anular.
import { first, guard, hoy, uid, type Stmt } from './db';
import { conflict } from './http';
import type { MedioPago, RubroCaja } from '../../shared/dominio';

export const SESION_ABIERTA_SQL = "(SELECT id FROM caja_sesiones WHERE taller_id = ? AND estado = 'abierta')";
/** Efecto neto de un movimiento sobre el saldo (ingreso suma, egreso resta). */
export const IMPORTE_FIRMADO_SQL = "CASE tipo WHEN 'ingreso' THEN importe ELSE -importe END";

export interface EstadoCaja {
  obligatoria: boolean;
  sesionId: string | null;
}

export async function estadoCaja(db: D1Database, tallerId: string): Promise<EstadoCaja> {
  const r = await first<{ obligatoria: number | null; sesion_id: string | null }>(
    db,
    `SELECT (SELECT caja_obligatoria FROM taller_config WHERE taller_id = ?) AS obligatoria,
            (SELECT id FROM caja_sesiones WHERE taller_id = ? AND estado = 'abierta') AS sesion_id`,
    tallerId,
    tallerId,
  );
  return { obligatoria: !!r?.obligatoria, sesionId: r?.sesion_id ?? null };
}

/** Prechequeo con mensaje claro. La garantía real ante concurrencia es `guardCajaObligatoria` dentro del batch. */
export async function exigirCajaAbiertaSiCorresponde(db: D1Database, tallerId: string): Promise<void> {
  const e = await estadoCaja(db, tallerId);
  if (e.obligatoria && !e.sesionId) throw conflict('La caja está cerrada. Abrí la caja para registrar cobros, pagos y gastos.', 'caja_cerrada');
}

/** Aborta el batch si el taller exige caja abierta y no hay ninguna (p. ej. cerró otro usuario en el medio). */
export function guardCajaObligatoria(db: D1Database, tallerId: string): Stmt {
  return guard(
    db,
    "COALESCE((SELECT caja_obligatoria FROM taller_config WHERE taller_id = ?), 0) = 1 AND NOT EXISTS (SELECT 1 FROM caja_sesiones WHERE taller_id = ? AND estado = 'abierta')",
    tallerId,
    tallerId,
  );
}

export interface MovimientoManual {
  tipo: 'ingreso' | 'egreso';
  rubro: RubroCaja;
  medio: MedioPago;
  importe: number;
  concepto: string;
  referencia?: string | null;
  origenTipo: 'pago_proveedor' | 'gasto' | 'manual';
  origenId: string;
  fecha: string;
  idemKey?: string | null;
  usuarioId: string;
}

/** Un movimiento de caja (pagos a proveedores, gastos, ingresos manuales). En los manuales el id del movimiento es su propio origen_id. */
export function sentenciaMovimiento(db: D1Database, tallerId: string, m: MovimientoManual): Stmt {
  return db
    .prepare(
      `INSERT INTO caja_movimientos (id, taller_id, sesion_id, tipo, rubro, medio, importe, concepto, referencia, origen_tipo, origen_id, fecha, idem_key, usuario_id)
       VALUES (?, ?, ${SESION_ABIERTA_SQL}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(m.origenTipo === 'manual' ? m.origenId : uid(), tallerId, tallerId, m.tipo, m.rubro, m.medio, m.importe, m.concepto, m.referencia ?? null, m.origenTipo, m.origenId, m.fecha, m.idemKey ?? null, m.usuarioId);
}

/** Ingresos de caja de un cobro: una línea por medio de pago. Debe ejecutarse DESPUÉS de insertar el cobro y sus medios, en el mismo batch. */
export function sentenciaIngresosDeCobro(db: D1Database, tallerId: string, cobroId: string): Stmt {
  return db
    .prepare(
      `INSERT INTO caja_movimientos (id, taller_id, sesion_id, tipo, rubro, medio, importe, concepto, referencia, origen_tipo, origen_id, fecha, usuario_id)
       SELECT lower(hex(randomblob(16))), cm.taller_id, ${SESION_ABIERTA_SQL.replace('?', 'cm.taller_id')}, 'ingreso', 'cobro', cm.medio, cm.importe,
              'Cobro #' || co.numero || ' · ' || cl.nombre, cm.referencia, 'cobro', cm.id, co.fecha, co.usuario_id
         FROM cobro_medios cm
         JOIN cobros co ON co.taller_id = cm.taller_id AND co.id = cm.cobro_id
         JOIN clientes cl ON cl.taller_id = co.taller_id AND cl.id = co.cliente_id
        WHERE cm.taller_id = ? AND cm.cobro_id = ?`,
    )
    .bind(tallerId, cobroId);
}

/**
 * Contra-asiento de los movimientos que cumplan `donde` (SQL sobre la tabla alias `m`). Cada movimiento se revierte una sola vez
 * (índice único origen 'reverso' + id del original).
 */
export function sentenciaReversos(db: D1Database, tallerId: string, donde: string, paramsDonde: unknown[], usuarioId: string): Stmt {
  return db
    .prepare(
      `INSERT INTO caja_movimientos (id, taller_id, sesion_id, tipo, rubro, medio, importe, concepto, referencia, origen_tipo, origen_id, fecha, usuario_id)
       SELECT lower(hex(randomblob(16))), m.taller_id, ${SESION_ABIERTA_SQL.replace('?', 'm.taller_id')},
              CASE m.tipo WHEN 'ingreso' THEN 'egreso' ELSE 'ingreso' END, m.rubro, m.medio, m.importe,
              'Anulación: ' || m.concepto, m.referencia, 'reverso', m.id, ?, ?
         FROM caja_movimientos m
        WHERE m.taller_id = ? AND m.origen_tipo <> 'reverso' AND (${donde})
          AND NOT EXISTS (SELECT 1 FROM caja_movimientos r WHERE r.taller_id = m.taller_id AND r.origen_tipo = 'reverso' AND r.origen_id = m.id)`,
    )
    .bind(hoy(), usuarioId, tallerId, ...paramsDonde);
}

export const reversoDeCobro = (db: D1Database, tallerId: string, cobroId: string, usuarioId: string) =>
  sentenciaReversos(db, tallerId, "m.origen_tipo = 'cobro' AND m.origen_id IN (SELECT id FROM cobro_medios WHERE taller_id = m.taller_id AND cobro_id = ?)", [cobroId], usuarioId);
export const reversoDeOrigen = (db: D1Database, tallerId: string, origenTipo: 'pago_proveedor' | 'gasto' | 'manual', origenId: string, usuarioId: string) =>
  sentenciaReversos(db, tallerId, 'm.origen_tipo = ? AND m.origen_id = ?', [origenTipo, origenId], usuarioId);
