// Movimientos de stock atómicos e idempotentes.
import { all, first, guard, lotes, uid, type Stmt } from './db';
import { badRequest, conflict } from './http';
import { redondearCantidad as r3 } from '../../shared/dominio';

export interface Movimiento {
  articuloId: string;
  /** Depósito del movimiento; sin indicar (o null) es el depósito principal del taller. */
  depositoId?: string | null;
  delta: number; // positivo = entra, negativo = sale
  tipo: string;
  origenTipo?: string | null;
  origenId?: string | null;
  idemKey?: string | null; // único por taller: un segundo intento con la misma clave aborta el batch
  notas?: string | null;
  motivo?: string | null;
  costoUnitario?: number | null;
  usuarioId?: string | null;
}

export async function permiteNegativo(db: D1Database, tallerId: string): Promise<boolean> {
  const r = await first<{ p: number }>(db, 'SELECT permitir_stock_negativo AS p FROM taller_config WHERE taller_id = ?', tallerId);
  return !!r?.p;
}

/** Agrupa cantidades por artículo (varias líneas del mismo artículo = un movimiento). */
export function agrupar(items: Array<{ articulo_id: string | null; cantidad: number }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) if (it.articulo_id) m.set(it.articulo_id, r3((m.get(it.articulo_id) ?? 0) + it.cantidad));
  return m;
}

/** SQL del depósito de una operación: el indicado o, si no se indica, el principal del taller. */
const PRINCIPAL_SQL = '(SELECT id FROM depositos WHERE taller_id = ? AND es_principal = 1)';
const depSql = (depositoId?: string | null) => (depositoId ? '?' : PRINCIPAL_SQL);
const depParams = (tallerId: string, depositoId?: string | null) => (depositoId ? [depositoId] : [tallerId]);

/** Valida que el depósito exista, sea del taller y esté activo. Devuelve su id (o null si no se indicó: depósito principal). */
export async function resolverDeposito(db: D1Database, tallerId: string, depositoId?: string | null): Promise<string | null> {
  if (!depositoId) return null;
  const d = await first<{ activo: number }>(db, 'SELECT activo FROM depositos WHERE taller_id = ? AND id = ?', tallerId, depositoId);
  if (!d) throw badRequest('Depósito inexistente');
  if (!d.activo) throw badRequest('El depósito está desactivado');
  return depositoId;
}

/** Verificación previa (mensaje claro). El guard dentro del batch es la garantía real ante concurrencia. Controla el stock del depósito indicado. */
export async function verificarDisponible(db: D1Database, tallerId: string, salidas: Map<string, number>, depositoId?: string | null) {
  if (!salidas.size) return;
  const ids = [...salidas.keys()];
  const rows: Array<{ id: string; nombre: string; stock: number }> = [];
  for (const lote of lotes(ids)) {
    rows.push(
      ...(await all<{ id: string; nombre: string; stock: number }>(
        db,
        `SELECT a.id, a.nombre, COALESCE(sd.stock, 0) AS stock FROM articulos a
           LEFT JOIN stock_depositos sd ON sd.taller_id = a.taller_id AND sd.articulo_id = a.id AND sd.deposito_id = ${depSql(depositoId)}
          WHERE a.taller_id = ? AND a.id IN (${lote.map(() => '?').join(',')})`,
        ...depParams(tallerId, depositoId), tallerId, ...lote,
      )),
    );
  }
  const faltantes = rows.filter((r) => r3(r.stock) < r3(salidas.get(r.id) ?? 0)).map((r) => `${r.nombre} (disponible ${r.stock}, requerido ${salidas.get(r.id)})`);
  if (rows.length !== ids.length) throw conflict('Hay artículos inexistentes en el documento');
  if (faltantes.length) throw conflict(`Stock insuficiente: ${faltantes.join('; ')}`, 'stock_insuficiente');
}

/**
 * El stock se opera siempre redondeado a 3 decimales (ROUND en SQL y redondearCantidad en TS): evita los residuos de coma
 * flotante (0,3 − 0,1 = 0,19999999999999998) que bloqueaban salidas legítimas.
 */
export function sentenciasMovimiento(db: D1Database, tallerId: string, m: Movimiento, permitirNegativo: boolean): Stmt[] {
  const s: Stmt[] = [];
  const delta = r3(m.delta);
  const dep = depSql(m.depositoId);
  const dp = depParams(tallerId, m.depositoId);
  // La fila del depósito se crea la primera vez que el artículo se mueve allí (si el artículo no existe, el guard final lo informa).
  s.push(
    db.prepare(`INSERT OR IGNORE INTO stock_depositos (taller_id, articulo_id, deposito_id, stock) SELECT ?, ?, ${dep}, 0 WHERE EXISTS (SELECT 1 FROM articulos WHERE taller_id = ? AND id = ?)`)
      .bind(tallerId, m.articuloId, ...dp, tallerId, m.articuloId),
  );
  if (delta < 0 && !permitirNegativo) {
    s.push(guard(db, `ROUND(COALESCE((SELECT stock FROM stock_depositos WHERE taller_id = ? AND articulo_id = ? AND deposito_id = ${dep}), 0) + ?, 3) < 0`, tallerId, m.articuloId, ...dp, delta));
  }
  s.push(
    db.prepare(`UPDATE stock_depositos SET stock = ROUND(stock + ?, 3) WHERE taller_id = ? AND articulo_id = ? AND deposito_id = ${dep}`).bind(delta, tallerId, m.articuloId, ...dp),
    // articulos.stock es el total: siempre la suma de los depósitos.
    db.prepare("UPDATE articulos SET stock = ROUND(stock + ?, 3), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ? AND id = ?")
      .bind(delta, tallerId, m.articuloId),
  );
  // El costo del movimiento queda registrado: el del artículo en ese instante si no se indica otro (costo histórico).
  s.push(
    db.prepare(
      `INSERT INTO stock_movimientos (id, taller_id, articulo_id, tipo, cantidad, stock_resultante, costo_unitario, origen_tipo, origen_id, idem_key, notas, motivo, usuario_id, deposito_id)
       SELECT ?, taller_id, id, ?, ?, stock, COALESCE(?, costo), ?, ?, ?, ?, ?, ?, ${dep} FROM articulos WHERE taller_id = ? AND id = ?`,
    ).bind(uid(), m.tipo, delta, m.costoUnitario ?? null, m.origenTipo ?? null, m.origenId ?? null, m.idemKey ?? null, m.notas ?? null, m.motivo ?? null, m.usuarioId ?? null, ...dp, tallerId, m.articuloId),
  );
  // Si el artículo no existiera en el taller, el INSERT...SELECT no insertaría nada: lo detectamos.
  s.push(guard(db, 'NOT EXISTS (SELECT 1 FROM articulos WHERE taller_id = ? AND id = ?)', tallerId, m.articuloId));
  return s;
}

/** Etiqueta el último cambio de costo del artículo (el historial lo registran triggers): deja anotado qué operación lo provocó. */
export function sentenciaOrigenCosto(db: D1Database, tallerId: string, articuloId: string, origen: string): Stmt {
  return db
    .prepare('UPDATE articulo_costos SET origen = ? WHERE id = (SELECT MAX(id) FROM articulo_costos WHERE taller_id = ? AND articulo_id = ?) AND origen IS NULL')
    .bind(origen, tallerId, articuloId);
}
