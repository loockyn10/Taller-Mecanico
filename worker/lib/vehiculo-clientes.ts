// Vínculos vehículo-cliente (muchos a muchos con historial). El vehículo no guarda cliente: cada OT, presupuesto o venta conserva el suyo.
// Un vínculo vigente tiene `desvinculado_at` NULL; al desvincular se cierra (nunca se borra) y el mismo cliente puede volver a vincularse.
import type { Sesion } from '../env';
import { badRequest, conflict, notFound } from './http';
import { all, auditar, delTaller, first, uid, type Stmt } from './db';
import { RELACIONES_VEHICULO, type RelacionVehiculo } from '../../shared/dominio';

export interface VinculoFila {
  id: string;
  vehiculo_id: string;
  cliente_id: string;
  relacion: RelacionVehiculo | null;
  vinculado_at: string;
  vinculado_por: string | null;
  vinculado_por_nombre: string | null;
  desvinculado_at: string | null;
  desvinculado_por_nombre: string | null;
  cliente: string;
  cliente_codigo: number;
  cliente_telefono: string | null;
  cliente_activo: number;
}

export const esRelacion = (r: unknown): r is RelacionVehiculo => typeof r === 'string' && (RELACIONES_VEHICULO as readonly string[]).includes(r);

/** Orden de los clientes vinculados: el titular primero, después por antigüedad del vínculo. */
const ORDEN = "CASE WHEN x.relacion = 'titular' THEN 0 ELSE 1 END, x.vinculado_at, x.id";

/**
 * Vínculos de un vehículo con los datos de cada cliente. `contacto`: incluye el teléfono (sólo con permiso de ver clientes; el llamador decide).
 * Los vigentes y los cerrados se devuelven por separado: los cerrados son el historial de asociaciones anteriores.
 */
export async function vinculosDeVehiculo(db: D1Database, tallerId: string, vehiculoId: string, opciones: { contacto: boolean }) {
  const filas = await all<VinculoFila>(
    db,
    `SELECT x.id, x.vehiculo_id, x.cliente_id, x.relacion, x.vinculado_at, x.vinculado_por, x.desvinculado_at,
            COALESCE(NULLIF(TRIM(uv.nombre), ''), uv.email) AS vinculado_por_nombre, COALESCE(NULLIF(TRIM(ud.nombre), ''), ud.email) AS desvinculado_por_nombre,
            c.nombre AS cliente, c.codigo AS cliente_codigo, ${opciones.contacto ? 'c.telefono' : 'NULL'} AS cliente_telefono, c.activo AS cliente_activo
       FROM vehiculo_clientes x
       JOIN clientes c ON c.taller_id = x.taller_id AND c.id = x.cliente_id
       LEFT JOIN usuarios uv ON uv.taller_id = x.taller_id AND uv.id = x.vinculado_por
       LEFT JOIN usuarios ud ON ud.taller_id = x.taller_id AND ud.id = x.desvinculado_por
      WHERE x.taller_id = ? AND x.vehiculo_id = ?
      ORDER BY x.desvinculado_at IS NOT NULL, ${ORDEN}, x.desvinculado_at DESC`,
    tallerId,
    vehiculoId,
  );
  const sinTel = (f: VinculoFila) => (opciones.contacto ? f : { ...f, cliente_telefono: null });
  return { vigentes: filas.filter((f) => !f.desvinculado_at).map(sinTel), anteriores: filas.filter((f) => f.desvinculado_at).map(sinTel) };
}

/** Sentencia que vincula un cliente vigente al vehículo sin duplicar (si ya está vinculado no hace nada). Para usar dentro de un batch. */
export function sentenciaVincular(db: D1Database, s: Sesion, vehiculoId: string, clienteId: string, relacion: RelacionVehiculo | null): Stmt {
  return db
    .prepare(
      `INSERT INTO vehiculo_clientes (id, taller_id, vehiculo_id, cliente_id, relacion, vinculado_por)
       SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM vehiculo_clientes WHERE taller_id = ? AND vehiculo_id = ? AND cliente_id = ? AND desvinculado_at IS NULL)`,
    )
    .bind(uid(), s.tallerId, vehiculoId, clienteId, relacion, s.usuarioId, s.tallerId, vehiculoId, clienteId);
}

/** Valida que el cliente exista en el taller y esté activo (se puede vincular o usar como responsable de una operación nueva). */
export async function exigirClienteActivo(db: D1Database, tallerId: string, clienteId: string) {
  const c = await delTaller<{ activo: number }>(db, 'clientes', tallerId, clienteId, 'activo');
  if (!c) throw badRequest('Cliente inexistente');
  if (!c.activo) throw badRequest('El cliente está dado de baja');
}

export async function vincularCliente(db: D1Database, s: Sesion, vehiculoId: string, clienteId: string, relacion: RelacionVehiculo | null) {
  if (!(await delTaller(db, 'vehiculos', s.tallerId, vehiculoId, 'id'))) throw notFound('Vehículo');
  await exigirClienteActivo(db, s.tallerId, clienteId);
  if (await first(db, 'SELECT 1 FROM vehiculo_clientes WHERE taller_id = ? AND vehiculo_id = ? AND cliente_id = ? AND desvinculado_at IS NULL', s.tallerId, vehiculoId, clienteId)) {
    throw conflict('El cliente ya está vinculado a este vehículo', 'duplicado');
  }
  await db.batch([sentenciaVincular(db, s, vehiculoId, clienteId, relacion), auditar(db, s.tallerId, s.usuarioId, 'vehiculo', vehiculoId, 'vincular_cliente', { cliente_id: clienteId, relacion })]);
}

/** Cierra el vínculo vigente (queda como historial). No toca al cliente, al vehículo ni a ninguna orden anterior. */
export async function desvincularCliente(db: D1Database, s: Sesion, vehiculoId: string, vinculoId: string) {
  const v = await first<{ cliente_id: string }>(db, 'SELECT cliente_id FROM vehiculo_clientes WHERE taller_id = ? AND id = ? AND vehiculo_id = ? AND desvinculado_at IS NULL', s.tallerId, vinculoId, vehiculoId);
  if (!v) throw notFound('Vínculo');
  await db.batch([
    db
      .prepare("UPDATE vehiculo_clientes SET desvinculado_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), desvinculado_por = ? WHERE taller_id = ? AND id = ? AND desvinculado_at IS NULL")
      .bind(s.usuarioId, s.tallerId, vinculoId),
    auditar(db, s.tallerId, s.usuarioId, 'vehiculo', vehiculoId, 'desvincular_cliente', { cliente_id: v.cliente_id }),
  ]);
}

export async function cambiarRelacion(db: D1Database, s: Sesion, vehiculoId: string, vinculoId: string, relacion: RelacionVehiculo | null) {
  const v = await first<{ cliente_id: string; relacion: string | null }>(db, 'SELECT cliente_id, relacion FROM vehiculo_clientes WHERE taller_id = ? AND id = ? AND vehiculo_id = ? AND desvinculado_at IS NULL', s.tallerId, vinculoId, vehiculoId);
  if (!v) throw notFound('Vínculo');
  await db.batch([
    db.prepare('UPDATE vehiculo_clientes SET relacion = ? WHERE taller_id = ? AND id = ? AND desvinculado_at IS NULL').bind(relacion, s.tallerId, vinculoId),
    auditar(db, s.tallerId, s.usuarioId, 'vehiculo', vehiculoId, 'relacion_cliente', { cliente_id: v.cliente_id, de: v.relacion, a: relacion }),
  ]);
}

/**
 * Expresiones SQL (alias de vehículo `v`) para listados: no hay un «cliente del vehículo», hay clientes vinculados vigentes.
 * El titular va primero y después los demás por antigüedad del vínculo.
 */
const VIGENTES = "x.taller_id = v.taller_id AND x.vehiculo_id = v.id AND x.desvinculado_at IS NULL";
const POR_TITULAR = "CASE WHEN x.relacion = 'titular' THEN 0 ELSE 1 END, x.vinculado_at, x.id";

/** Id del cliente de contacto del vehículo (titular vigente o, si no hay, el vinculado más antiguo); NULL si no tiene clientes. */
export const CLIENTE_PRINCIPAL_SQL = `(SELECT x.cliente_id FROM vehiculo_clientes x WHERE ${VIGENTES} ORDER BY ${POR_TITULAR} LIMIT 1)`;

/** Nombres de los clientes vigentes separados por coma: «Juan Pérez, María González». */
export const CLIENTES_TEXTO_SQL = `(SELECT GROUP_CONCAT(nombre, ', ') FROM (SELECT c.nombre AS nombre FROM vehiculo_clientes x JOIN clientes c ON c.taller_id = x.taller_id AND c.id = x.cliente_id WHERE ${VIGENTES} ORDER BY ${POR_TITULAR}))`;

/** Cantidad de clientes vigentes. */
export const CLIENTES_N_SQL = `(SELECT COUNT(*) FROM vehiculo_clientes x WHERE ${VIGENTES})`;

/**
 * Cliente responsable de una operación comercial nueva (OT, presupuesto, turno): puede ser cualquier cliente activo del taller, esté o no
 * vinculado al vehículo. Si la solicitud pide `vincular`, devuelve las sentencias que lo vinculan al vehículo en el mismo lote
 * (idempotente: si ya estaba vinculado no hace nada). Vincular exige poder editar vehículos y ver clientes.
 */
export async function validarResponsable(
  db: D1Database,
  s: Sesion,
  clienteId: string,
  vehiculoId: string,
  vincular?: { vincular?: boolean | null; relacion?: RelacionVehiculo | null },
  permisos?: { puedeVincular: boolean; conservaActual?: boolean },
): Promise<Stmt[]> {
  // Al editar una OT que ya tenía a ese cliente no se lo vuelve a exigir activo (pudo darse de baja después; la OT conserva su responsable).
  if (permisos?.conservaActual) {
    if (!(await delTaller(db, 'clientes', s.tallerId, clienteId, 'id'))) throw badRequest('Cliente inexistente');
  } else await exigirClienteActivo(db, s.tallerId, clienteId);
  if (!vincular?.vincular) return [];
  if (!permisos?.puedeVincular) throw badRequest('No tenés permiso para vincular clientes a vehículos');
  return [sentenciaVincular(db, s, vehiculoId, clienteId, vincular.relacion ?? null), auditar(db, s.tallerId, s.usuarioId, 'vehiculo', vehiculoId, 'vincular_cliente', { cliente_id: clienteId, relacion: vincular.relacion ?? null, desde: 'operacion' })];
}
