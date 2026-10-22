// Saldo a favor de los clientes: anticipos (cobros `tipo = 'anticipo'`) y crédito que dejan las devoluciones (la parte ya pagada que no se reintegró).
//
// Un crédito se aplica a un comprobante SIN mover dinero (la plata ya entró cuando se cobró el anticipo / el comprobante original):
// sube `ventas.cobrado` y el contador `credito_aplicado` de su origen. Los CHECK de la base (`credito_aplicado + devuelto <= total`,
// `reintegrado + credito_aplicado <= liberado`, `cobrado + devuelto <= total`) impiden aplicarlo dos veces o por más de lo disponible,
// incluso con solicitudes simultáneas.
import { all, auditar, first, guard, uid, type Stmt } from './db';
import { badRequest, conflict } from './http';

export type OrigenCredito = 'anticipo' | 'devolucion';

/** Saldo a favor total de un cliente (SQL escalar). `alias` es el alias de la tabla clientes en la consulta que lo usa. */
export const credito_cliente_sql = (alias: string) =>
  `(COALESCE((SELECT SUM(co.total - co.credito_aplicado - co.devuelto) FROM cobros co WHERE co.taller_id = ${alias}.taller_id AND co.cliente_id = ${alias}.id AND co.tipo = 'anticipo' AND co.estado = 'registrado'), 0)
  + COALESCE((SELECT SUM(d.liberado - d.reintegrado - d.credito_aplicado) FROM devoluciones d WHERE d.taller_id = ${alias}.taller_id AND d.cliente_id = ${alias}.id AND d.estado = 'registrada'), 0))`;

export interface CreditoDisponible {
  origen_tipo: OrigenCredito;
  origen_id: string;
  numero: number;
  fecha: string;
  total: number;
  aplicado: number;
  devuelto: number;
  disponible: number;
  orden_id: string | null;
  orden_numero: number | null;
  presupuesto_id: string | null;
  presupuesto_numero: number | null;
  venta_numero: number | null;
}

/** Anticipos y créditos de devolución con saldo disponible de un cliente (los más antiguos primero). */
export async function creditosDisponibles(db: D1Database, tallerId: string, clienteId: string): Promise<CreditoDisponible[]> {
  const [anticipos, devoluciones] = await Promise.all([
    all<CreditoDisponible>(
      db,
      `SELECT 'anticipo' AS origen_tipo, co.id AS origen_id, co.numero, co.fecha, co.total, co.credito_aplicado AS aplicado, co.devuelto,
              (co.total - co.credito_aplicado - co.devuelto) AS disponible, co.orden_id, o.numero AS orden_numero, co.presupuesto_id, p.numero AS presupuesto_numero, NULL AS venta_numero
         FROM cobros co
         LEFT JOIN ordenes o ON o.taller_id = co.taller_id AND o.id = co.orden_id
         LEFT JOIN presupuestos p ON p.taller_id = co.taller_id AND p.id = co.presupuesto_id
        WHERE co.taller_id = ? AND co.cliente_id = ? AND co.tipo = 'anticipo' AND co.estado = 'registrado' AND co.total - co.credito_aplicado - co.devuelto > 0
        ORDER BY co.fecha, co.numero`,
      tallerId, clienteId,
    ),
    all<CreditoDisponible>(
      db,
      `SELECT 'devolucion' AS origen_tipo, d.id AS origen_id, d.numero, d.fecha, d.liberado AS total, d.credito_aplicado AS aplicado, d.reintegrado AS devuelto,
              (d.liberado - d.reintegrado - d.credito_aplicado) AS disponible, d.orden_id, o.numero AS orden_numero, NULL AS presupuesto_id, NULL AS presupuesto_numero, ve.numero AS venta_numero
         FROM devoluciones d
         JOIN ventas ve ON ve.taller_id = d.taller_id AND ve.id = d.venta_id
         LEFT JOIN ordenes o ON o.taller_id = d.taller_id AND o.id = d.orden_id
        WHERE d.taller_id = ? AND d.cliente_id = ? AND d.estado = 'registrada' AND d.liberado - d.reintegrado - d.credito_aplicado > 0
        ORDER BY d.fecha, d.numero`,
      tallerId, clienteId,
    ),
  ]);
  return [...anticipos, ...devoluciones].sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : a.numero - b.numero));
}

export interface AplicacionCredito {
  ventaId: string;
  clienteId: string;
  origenTipo: OrigenCredito;
  origenId: string;
  importe: number;
  fecha: string;
  idemKey: string;
}

/** Valida que el saldo a favor exista, sea del cliente, esté vigente y alcance para el importe. */
export async function validarOrigenCredito(db: D1Database, tallerId: string, a: { clienteId: string; origenTipo: OrigenCredito; origenId: string; importe: number; fecha: string }): Promise<void> {
  const origen =
    a.origenTipo === 'anticipo'
      ? await first<{ cliente_id: string; vigente: number; disponible: number; fecha: string }>(
          db, "SELECT cliente_id, estado = 'registrado' AS vigente, total - credito_aplicado - devuelto AS disponible, fecha FROM cobros WHERE taller_id = ? AND id = ? AND tipo = 'anticipo'", tallerId, a.origenId,
        )
      : await first<{ cliente_id: string; vigente: number; disponible: number; fecha: string }>(
          db, "SELECT cliente_id, estado = 'registrada' AS vigente, liberado - reintegrado - credito_aplicado AS disponible, fecha FROM devoluciones WHERE taller_id = ? AND id = ?", tallerId, a.origenId,
        );
  if (!origen) throw badRequest(a.origenTipo === 'anticipo' ? 'Anticipo inexistente' : 'Devolución inexistente');
  if (origen.cliente_id !== a.clienteId) throw badRequest('El saldo a favor pertenece a otro cliente');
  if (!origen.vigente) throw conflict('El saldo a favor está anulado');
  if (a.importe > origen.disponible) throw conflict('El saldo a favor disponible es menor al importe a aplicar', 'credito_insuficiente');
  if (a.fecha < origen.fecha) throw badRequest('La aplicación no puede ser anterior al saldo a favor');
}

/**
 * Valida (con mensajes claros) que el crédito pueda aplicarse a ese comprobante. La garantía real ante concurrencia son los CHECK de la base
 * y los guards del batch; esto solo evita llegar a ellos en el caso normal.
 */
export async function validarAplicacion(db: D1Database, tallerId: string, a: AplicacionCredito): Promise<void> {
  const v = await first<{ cliente_id: string; estado: string; total: number; cobrado: number; devuelto: number; numero: number; fecha: string }>(
    db, 'SELECT cliente_id, estado, total, cobrado, devuelto, numero, fecha FROM ventas WHERE taller_id = ? AND id = ?', tallerId, a.ventaId,
  );
  if (!v) throw badRequest('Comprobante inexistente');
  if (v.estado !== 'emitida') throw conflict(`El comprobante #${v.numero} está anulado`);
  if (v.cliente_id !== a.clienteId) throw badRequest(`El comprobante #${v.numero} no pertenece al cliente`);
  if (a.importe > v.total - v.devuelto - v.cobrado) throw conflict(`El importe supera el saldo pendiente del comprobante #${v.numero}`, 'saldo_excedido');
  if (a.fecha < v.fecha) throw badRequest(`La aplicación no puede ser anterior al comprobante #${v.numero} (${v.fecha})`);
  await validarOrigenCredito(db, tallerId, a);
}

/** Sentencias de una aplicación de crédito a un comprobante. Se ejecutan en un batch (atómico). */
export function sentenciasAplicarCredito(db: D1Database, s: { tallerId: string; usuarioId: string }, a: AplicacionCredito): Stmt[] {
  const id = uid();
  const sube =
    a.origenTipo === 'anticipo'
      ? db.prepare("UPDATE cobros SET credito_aplicado = credito_aplicado + ? WHERE taller_id = ? AND id = ? AND tipo = 'anticipo' AND estado = 'registrado' AND cliente_id = ?").bind(a.importe, s.tallerId, a.origenId, a.clienteId)
      : db.prepare("UPDATE devoluciones SET credito_aplicado = credito_aplicado + ? WHERE taller_id = ? AND id = ? AND estado = 'registrada' AND cliente_id = ?").bind(a.importe, s.tallerId, a.origenId, a.clienteId);
  return [
    guard(db, "NOT EXISTS (SELECT 1 FROM ventas WHERE taller_id = ? AND id = ? AND estado = 'emitida' AND cliente_id = ?)", s.tallerId, a.ventaId, a.clienteId),
    guard(
      db,
      a.origenTipo === 'anticipo'
        ? "NOT EXISTS (SELECT 1 FROM cobros WHERE taller_id = ? AND id = ? AND tipo = 'anticipo' AND estado = 'registrado' AND cliente_id = ?)"
        : "NOT EXISTS (SELECT 1 FROM devoluciones WHERE taller_id = ? AND id = ? AND estado = 'registrada' AND cliente_id = ?)",
      s.tallerId, a.origenId, a.clienteId,
    ),
    db
      .prepare('INSERT INTO credito_aplicaciones (id, taller_id, venta_id, origen_tipo, origen_id, importe, fecha, idem_key, usuario_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, s.tallerId, a.ventaId, a.origenTipo, a.origenId, a.importe, a.fecha, a.idemKey, s.usuarioId),
    sube,
    // CHECK (cobrado + devuelto <= total): aborta todo si el saldo cambió entre la validación y la escritura.
    db.prepare('UPDATE ventas SET cobrado = cobrado + ? WHERE taller_id = ? AND id = ?').bind(a.importe, s.tallerId, a.ventaId),
    auditar(db, s.tallerId, s.usuarioId, 'venta', a.ventaId, 'aplicar_credito', { origen: a.origenTipo, origen_id: a.origenId, importe: a.importe }),
  ];
}
