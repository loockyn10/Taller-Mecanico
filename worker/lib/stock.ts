// Movimientos de stock atómicos e idempotentes.
import { all, first, guard, lotes, uid, type Stmt } from './db';
import { conflict } from './http';
import { redondearCantidad as r3 } from '../../shared/dominio';

export interface Movimiento {
  articuloId: string;
  delta: number; // positivo = entra, negativo = sale
  tipo: string;
  origenTipo?: string | null;
  origenId?: string | null;
  idemKey?: string | null; // único por taller: un segundo intento con la misma clave aborta el batch
  notas?: string | null;
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

/** Verificación previa (mensaje claro). El guard dentro del batch es la garantía real ante concurrencia. */
export async function verificarDisponible(db: D1Database, tallerId: string, salidas: Map<string, number>) {
  if (!salidas.size) return;
  const ids = [...salidas.keys()];
  const rows: Array<{ id: string; nombre: string; stock: number }> = [];
  for (const lote of lotes(ids)) {
    rows.push(...(await all<{ id: string; nombre: string; stock: number }>(db, `SELECT id, nombre, stock FROM articulos WHERE taller_id = ? AND id IN (${lote.map(() => '?').join(',')})`, tallerId, ...lote)));
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
  if (delta < 0 && !permitirNegativo) {
    s.push(guard(db, 'ROUND((SELECT stock FROM articulos WHERE taller_id = ? AND id = ?) + ?, 3) < 0', tallerId, m.articuloId, delta));
  }
  s.push(
    db.prepare("UPDATE articulos SET stock = ROUND(stock + ?, 3), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ? AND id = ?")
      .bind(delta, tallerId, m.articuloId),
  );
  s.push(
    db.prepare(
      `INSERT INTO stock_movimientos (id, taller_id, articulo_id, tipo, cantidad, stock_resultante, costo_unitario, origen_tipo, origen_id, idem_key, notas, usuario_id)
       SELECT ?, taller_id, id, ?, ?, stock, ?, ?, ?, ?, ?, ? FROM articulos WHERE taller_id = ? AND id = ?`,
    ).bind(uid(), m.tipo, delta, m.costoUnitario ?? null, m.origenTipo ?? null, m.origenId ?? null, m.idemKey ?? null, m.notas ?? null, m.usuarioId ?? null, tallerId, m.articuloId),
  );
  // Si el artículo no existiera en el taller, el INSERT...SELECT no insertaría nada: lo detectamos.
  s.push(guard(db, 'NOT EXISTS (SELECT 1 FROM articulos WHERE taller_id = ? AND id = ?)', tallerId, m.articuloId));
  return s;
}
