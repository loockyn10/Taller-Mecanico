// Libro de cada cuenta bancaria (banco_movimientos).
//
// Reglas:
//  * Cobros, pagos a proveedores y gastos que se asignan a una cuenta insertan su movimiento bancario en el MISMO batch que la
//    operación. El índice único (taller_id, origen_tipo, origen_id) impide que un mismo hecho genere dos movimientos.
//  * Las anulaciones no borran: generan un 'reverso' (un reverso por movimiento).
//  * afecta_resultado = 1 sólo para movimientos que no pasaron por el libro de caja (comisiones, intereses, cheques sueltos).
import { all, first, guard, hoy, uid, type Stmt } from './db';
import { badRequest } from './http';
import { MEDIOS_BANCARIOS } from '../../shared/dominio';

export const SIGNO_BANCO_SQL = "CASE tipo WHEN 'ingreso' THEN importe ELSE -importe END";

export interface CuentaMinima {
  id: string;
  nombre: string;
  moneda: string;
  activa: number;
}

/** Valida que la cuenta sea del taller, esté activa y sea en pesos (los cobros y pagos del negocio se llevan en pesos). */
export async function validarCuentaOperable(db: D1Database, tallerId: string, cuentaId: string, medio?: string): Promise<CuentaMinima> {
  const c = await first<CuentaMinima>(db, 'SELECT id, nombre, moneda, activa FROM cuentas_bancarias WHERE taller_id = ? AND id = ?', tallerId, cuentaId);
  if (!c) throw badRequest('Cuenta bancaria inexistente');
  if (!c.activa) throw badRequest(`La cuenta "${c.nombre}" está desactivada`);
  if (c.moneda !== 'ARS') throw badRequest(`La cuenta "${c.nombre}" es en ${c.moneda}: los cobros y pagos se registran en pesos`);
  if (medio && !MEDIOS_BANCARIOS.includes(medio)) throw badRequest('Sólo transferencias, tarjetas y otros medios electrónicos se acreditan en una cuenta bancaria');
  return c;
}

/** Aborta el batch si la cuenta dejó de estar activa (otro usuario la desactivó entre la validación y la escritura). */
export const guardCuentaActiva = (db: D1Database, tallerId: string, cuentaId: string): Stmt =>
  guard(db, 'NOT EXISTS (SELECT 1 FROM cuentas_bancarias WHERE taller_id = ? AND id = ? AND activa = 1)', tallerId, cuentaId);

export interface MovBanco {
  cuentaId: string;
  tipo: 'ingreso' | 'egreso';
  categoria: 'cobro' | 'pago_proveedor' | 'gasto' | 'deposito' | 'extraccion' | 'transferencia' | 'cheque' | 'manual' | 'ajuste' | 'devolucion';
  importe: number;
  concepto: string;
  referencia?: string | null;
  origenTipo: string;
  origenId: string;
  fecha: string;
  afectaResultado?: boolean;
  transferenciaId?: string | null;
  idemKey?: string | null;
  usuarioId: string;
  /** Id propio (por defecto, uno nuevo). */
  id?: string;
}

export function sentenciaMovBanco(db: D1Database, tallerId: string, m: MovBanco): Stmt {
  return db
    .prepare(
      `INSERT INTO banco_movimientos (id, taller_id, cuenta_id, fecha, tipo, categoria, importe, concepto, referencia, origen_tipo, origen_id, transferencia_id, afecta_resultado, idem_key, usuario_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(m.id ?? uid(), tallerId, m.cuentaId, m.fecha, m.tipo, m.categoria, m.importe, m.concepto, m.referencia ?? null, m.origenTipo, m.origenId, m.transferenciaId ?? null, m.afectaResultado ? 1 : 0, m.idemKey ?? null, m.usuarioId);
}

/** Movimientos bancarios de un cobro: uno por medio con cuenta asignada. Ejecutar DESPUÉS de insertar el cobro y sus medios. */
export function sentenciasBancoDeCobro(db: D1Database, tallerId: string, cobroId: string): Stmt[] {
  return [
    guard(
      db,
      `EXISTS (SELECT 1 FROM cobro_medios cm WHERE cm.taller_id = ? AND cm.cobro_id = ? AND cm.cuenta_id IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM cuentas_bancarias cb WHERE cb.taller_id = cm.taller_id AND cb.id = cm.cuenta_id AND cb.activa = 1))`,
      tallerId,
      cobroId,
    ),
    db
      .prepare(
        `INSERT INTO banco_movimientos (id, taller_id, cuenta_id, fecha, tipo, categoria, importe, concepto, referencia, origen_tipo, origen_id, afecta_resultado, usuario_id)
         SELECT lower(hex(randomblob(16))), cm.taller_id, cm.cuenta_id, co.fecha, 'ingreso', 'cobro', cm.importe,
                'Cobro #' || co.numero || ' · ' || cl.nombre, cm.referencia, 'cobro_medio', cm.id, 0, co.usuario_id
           FROM cobro_medios cm
           JOIN cobros co ON co.taller_id = cm.taller_id AND co.id = cm.cobro_id
           JOIN clientes cl ON cl.taller_id = co.taller_id AND cl.id = co.cliente_id
          WHERE cm.taller_id = ? AND cm.cobro_id = ? AND cm.cuenta_id IS NOT NULL`,
      )
      .bind(tallerId, cobroId),
  ];
}

/**
 * Contra-asiento de los movimientos bancarios que cumplan `donde` (SQL sobre el alias `m`). Cada movimiento se revierte una sola vez.
 * El reverso conserva afecta_resultado del original, de modo que el neto del resultado vuelve a cero.
 */
export function sentenciaReversosBanco(db: D1Database, tallerId: string, donde: string, paramsDonde: unknown[], usuarioId: string): Stmt {
  return db
    .prepare(
      `INSERT INTO banco_movimientos (id, taller_id, cuenta_id, fecha, tipo, categoria, importe, concepto, referencia, origen_tipo, origen_id, afecta_resultado, usuario_id)
       SELECT lower(hex(randomblob(16))), m.taller_id, m.cuenta_id, ?, CASE m.tipo WHEN 'ingreso' THEN 'egreso' ELSE 'ingreso' END, 'reverso', m.importe,
              'Anulación: ' || m.concepto, m.referencia, 'reverso', m.id, m.afecta_resultado, ?
         FROM banco_movimientos m
        WHERE m.taller_id = ? AND m.origen_tipo <> 'reverso' AND (${donde})
          AND NOT EXISTS (SELECT 1 FROM banco_movimientos r WHERE r.taller_id = m.taller_id AND r.origen_tipo = 'reverso' AND r.origen_id = m.id)`,
    )
    .bind(hoy(), usuarioId, tallerId, ...paramsDonde);
}

export const reversoBancoDeCobro = (db: D1Database, tallerId: string, cobroId: string, usuarioId: string) =>
  sentenciaReversosBanco(db, tallerId, "m.origen_tipo = 'cobro_medio' AND m.origen_id IN (SELECT id FROM cobro_medios WHERE taller_id = m.taller_id AND cobro_id = ?)", [cobroId], usuarioId);
export const reversoBancoDeOrigen = (db: D1Database, tallerId: string, origenTipo: string, origenId: string, usuarioId: string) =>
  sentenciaReversosBanco(db, tallerId, 'm.origen_tipo = ? AND m.origen_id = ?', [origenTipo, origenId], usuarioId);

/** Saldos de todas las cuentas del taller (inicial + movimientos), y cuánto de eso está conciliado. */
export async function saldosCuentas(db: D1Database, tallerId: string, cuentaId?: string) {
  return all<{ id: string; saldo: number; saldo_conciliado: number; pendientes: number }>(
    db,
    `SELECT cb.id,
            cb.saldo_inicial + COALESCE((SELECT SUM(${SIGNO_BANCO_SQL}) FROM banco_movimientos m WHERE m.taller_id = cb.taller_id AND m.cuenta_id = cb.id), 0) AS saldo,
            cb.saldo_inicial + COALESCE((SELECT SUM(${SIGNO_BANCO_SQL}) FROM banco_movimientos m WHERE m.taller_id = cb.taller_id AND m.cuenta_id = cb.id AND m.conciliado = 1), 0) AS saldo_conciliado,
            (SELECT COUNT(*) FROM banco_movimientos m WHERE m.taller_id = cb.taller_id AND m.cuenta_id = cb.id AND m.conciliado = 0) AS pendientes
       FROM cuentas_bancarias cb WHERE cb.taller_id = ? ${cuentaId ? 'AND cb.id = ?' : ''}`,
    tallerId,
    ...(cuentaId ? [cuentaId] : []),
  );
}
