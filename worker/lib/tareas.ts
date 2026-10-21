// Tareas técnicas de las órdenes de trabajo.
import type { Stmt } from './db';

/**
 * Crea una tarea pendiente por cada trabajo (mano de obra) de la OT que todavía no tenga una tarea con el mismo texto, con el tiempo
 * estimado del tempario (minutos por unidad × cantidad). Es idempotente: se puede ejecutar varias veces sin duplicar tareas.
 */
export function sentenciaTareasDesdeTrabajos(db: D1Database, tallerId: string, ordenId: string, usuarioId: string | null): Stmt {
  return db
    .prepare(
      `INSERT INTO orden_tareas (id, taller_id, orden_id, posicion, descripcion, servicio_id, tiempo_estimado_min, creada_por)
       SELECT lower(hex(randomblob(16))), oi.taller_id, oi.orden_id,
              (SELECT COALESCE(MAX(t.posicion), -1) + 1 FROM orden_tareas t WHERE t.taller_id = oi.taller_id AND t.orden_id = oi.orden_id) + oi.orden,
              substr(oi.descripcion, 1, 200), oi.servicio_id,
              CASE WHEN oi.tiempo_min IS NOT NULL THEN CAST(ROUND(oi.tiempo_min * oi.cantidad) AS INTEGER) END, ?
         FROM orden_items oi
        WHERE oi.taller_id = ? AND oi.orden_id = ? AND oi.tipo = 'servicio'
          AND NOT EXISTS (SELECT 1 FROM orden_tareas t WHERE t.taller_id = oi.taller_id AND t.orden_id = oi.orden_id AND lower(t.descripcion) = lower(substr(oi.descripcion, 1, 200)))`,
    )
    .bind(usuarioId, tallerId, ordenId);
}

/** Nombre completo de una persona del personal (nombre y apellido) como expresión SQL para el alias de tabla indicado. */
export const nombreUsuarioSql = (alias: string) => `TRIM(${alias}.nombre || ' ' || COALESCE(${alias}.apellido, ''))`;
