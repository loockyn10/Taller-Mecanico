// Utilidades de acceso a D1.
//
// Consistencia: D1 no admite transacciones interactivas (BEGIN/COMMIT), pero `db.batch()` ejecuta
// todas las sentencias como una única transacción: si una falla, se revierte el lote completo.
// Para condiciones que deben evaluarse DENTRO de la transacción usamos `guard()`, que inserta en
// tx_guard una fila inválida cuando la condición de error se cumple → falla el CHECK → rollback.

export const uid = () => crypto.randomUUID();
export const ahora = () => new Date().toISOString();
/**
 * Fecha comercial del día en la zona horaria de Argentina (UTC-3, sin horario de verano).
 * Las fechas de negocio (comprobantes, cobros, turnos) no deben usar la fecha UTC: después de las 21 h serían "mañana".
 */
export const hoy = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);

export type Stmt = D1PreparedStatement;

/** Aborta el batch si `condicionDeError` (SQL booleano) es verdadera. */
export function guard(db: D1Database, condicionDeError: string, ...params: unknown[]): Stmt {
  return db.prepare(`INSERT INTO tx_guard (ok) SELECT 0 WHERE (${condicionDeError})`).bind(...params);
}

/** Incrementa la secuencia y deja el nuevo valor disponible vía `seqValor()` en el mismo batch. */
export function seqIncrementar(db: D1Database, tallerId: string, clave: string): Stmt[] {
  return [
    db.prepare('INSERT INTO secuencias (taller_id, clave, valor) VALUES (?, ?, 0) ON CONFLICT DO NOTHING').bind(tallerId, clave),
    db.prepare('UPDATE secuencias SET valor = valor + 1 WHERE taller_id = ? AND clave = ?').bind(tallerId, clave),
  ];
}
/** Subconsulta SQL que devuelve el valor actual de la secuencia (usar con 2 parámetros: taller, clave). */
export const SEQ_VALOR = '(SELECT valor FROM secuencias WHERE taller_id = ? AND clave = ?)';

export async function first<T = Record<string, unknown>>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...params).first<T>()) ?? null;
}

export async function all<T = Record<string, unknown>>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const r = await db.prepare(sql).bind(...params).all<T>();
  return r.results ?? [];
}

export async function run(db: D1Database, sql: string, ...params: unknown[]) {
  return db.prepare(sql).bind(...params).run();
}

export function auditar(db: D1Database, tallerId: string, usuarioId: string | null, entidad: string, entidadId: string | null, accion: string, detalle?: unknown): Stmt {
  return db
    .prepare('INSERT INTO auditoria (id, taller_id, usuario_id, entidad, entidad_id, accion, detalle) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(uid(), tallerId, usuarioId, entidad, entidadId, accion, detalle === undefined ? null : JSON.stringify(detalle));
}

/** Verifica que un id pertenezca al taller. Devuelve la fila o null. */
export async function delTaller<T = Record<string, unknown>>(db: D1Database, tabla: string, tallerId: string, id: string, columnas = '*'): Promise<T | null> {
  if (!/^[a-z_]+$/.test(tabla)) throw new Error('tabla inválida');
  return first<T>(db, `SELECT ${columnas} FROM ${tabla} WHERE taller_id = ? AND id = ?`, tallerId, id);
}

/** Construye un UPDATE parcial seguro a partir de un objeto con columnas permitidas. */
export function updateParcial(db: D1Database, tabla: string, tallerId: string, id: string, datos: Record<string, unknown>, permitidas: readonly string[], conUpdatedAt = true): Stmt | null {
  const cols = Object.keys(datos).filter((k) => permitidas.includes(k) && datos[k] !== undefined);
  if (!cols.length) return null;
  const sets = cols.map((k) => `${k} = ?`);
  if (conUpdatedAt) sets.push(`updated_at = '${ahora()}'`);
  return db.prepare(`UPDATE ${tabla} SET ${sets.join(', ')} WHERE taller_id = ? AND id = ?`).bind(...cols.map((k) => datos[k]), tallerId, id);
}

export function like(q: string) {
  return `%${q.replace(/[%_]/g, '')}%`;
}
