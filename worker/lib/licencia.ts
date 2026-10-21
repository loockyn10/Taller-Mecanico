// Cupo de usuarios de la licencia. Los usuarios que cuentan son los que pueden ingresar al sistema (acceso_erp = 1) y están activos:
// una persona que solo ficha su asistencia con PIN en el reloj compartido no ocupa un lugar de la licencia.
import { first, guard, type Stmt } from './db';

export async function datosLicencia(db: D1Database, tallerId: string) {
  const lic = await first<{ plan: string; usuarios_incluidos: number; usuarios_adicionales: number; estado: string; updated_at: string }>(
    db,
    'SELECT plan, usuarios_incluidos, usuarios_adicionales, estado, updated_at FROM licencias WHERE taller_id = ?',
    tallerId,
  );
  const activos = await first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM usuarios WHERE taller_id = ? AND activo = 1 AND acceso_erp = 1', tallerId);
  const max = lic ? lic.usuarios_incluidos + lic.usuarios_adicionales : 0;
  return { ...lic, usuarios_max: max, usuarios_activos: activos?.n ?? 0, disponibles: Math.max(0, max - (activos?.n ?? 0)) };
}

/** Sentencia que aborta el batch si el taller ya alcanzó el máximo de usuarios con acceso activos de su licencia. */
export const guardCupo = (db: D1Database, tallerId: string): Stmt =>
  guard(
    db,
    `(SELECT COUNT(*) FROM usuarios WHERE taller_id = ? AND activo = 1 AND acceso_erp = 1) >=
     (SELECT usuarios_incluidos + usuarios_adicionales FROM licencias WHERE taller_id = ?)`,
    tallerId,
    tallerId,
  );
