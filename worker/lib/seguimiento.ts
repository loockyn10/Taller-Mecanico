// Seguimiento público de órdenes: consulta del estado para el cliente y administración del enlace.
//
// Regla de datos: la consulta pública (`consultarSeguimiento`) es PROPIA y ACOTADA. Lee sólo las columnas que se muestran y arma `SeguimientoPublico`, el único
// objeto que sale hacia afuera: no reutiliza el detalle de la OT (importes, costos, notas internas) ni devuelve identificadores internos. Si algún día se
// agrega un campo, hay que agregarlo acá a propósito (y la prueba de privacidad lo va a revisar).
import { ahora, all, first } from './db';
import { tokenAleatorio } from './crypto';
import { zonaDelTaller, fechaLocal } from './zona';
import { ESTADOS_OT, type EstadoOT } from '../../shared/dominio';
import { ESTADO_PUBLICO, RUTA_PUBLICA, enmascararPatente, entregaEstimada, recorrido, tituloTransicion, tokenConFormato, type EntregaEstimada, type EstadoPublico, type EventoVisible, type PasoRecorrido } from '../../shared/seguimiento';

export const nuevoToken = tokenAleatorio;

/** Dirección pública del enlace, con el origen desde el que se llegó al servidor. El token es la última parte de la ruta. */
export const urlSeguimiento = (origen: string, token: string) => `${origen}${RUTA_PUBLICA}/${token}`;

/** Token del enlace de una orden si está ACTIVO (para la copia del cliente con QR del PDF de la orden); null si no hay enlace o está desactivado. */
export async function tokenActivo(db: D1Database, tallerId: string, ordenId: string): Promise<string | null> {
  const e = await first<{ token: string }>(db, 'SELECT token FROM seguimiento_enlaces WHERE taller_id = ? AND orden_id = ? AND activo = 1', tallerId, ordenId);
  return e?.token ?? null;
}

export interface SeguimientoPublico {
  taller: { nombre: string };
  orden: { referencia: string };
  vehiculo: { marca: string | null; modelo: string | null; patente: string };
  estado: EstadoPublico & { clave: EstadoOT; listo: boolean; cerrado: boolean };
  recorrido: Array<Pick<PasoRecorrido, 'titulo' | 'detalle' | 'situacion' | 'at'>>;
  historial: Array<{ titulo: string; at: string }>;
  entrega: EntregaEstimada | null;
  mensaje: { texto: string; at: string } | null;
  actualizado_at: string;
  /** Zona horaria del taller: la página muestra las horas en ella. */
  zona_horaria: string;
}

const numeroReferencia = (n: number) => String(n).padStart(4, '0');

/** Cada mensaje vigente es el último publicado (si no fue retirado): uno anterior no reaparece al retirar el último. */
async function mensajeVigente(db: D1Database, tallerId: string, ordenId: string) {
  const m = await first<{ texto: string; creado_at: string; retirado_at: string | null }>(
    db,
    'SELECT texto, creado_at, retirado_at FROM seguimiento_mensajes WHERE taller_id = ? AND orden_id = ? ORDER BY creado_at DESC, rowid DESC LIMIT 1',
    tallerId, ordenId,
  );
  return m && !m.retirado_at ? { texto: m.texto, at: m.creado_at } : null;
}

/** Transiciones de la OT, de la más vieja a la más nueva, con la marca de si el taller las ocultó. Sólo estado y hora: nunca la nota ni quién la hizo. */
export async function transiciones(db: D1Database, tallerId: string, ordenId: string) {
  const filas = await all<{ id: string; estado_anterior: string | null; estado_nuevo: string; created_at: string; oculto: number }>(
    db,
    `SELECT e.id, e.estado_anterior, e.estado_nuevo, e.created_at,
            EXISTS (SELECT 1 FROM seguimiento_eventos_ocultos x WHERE x.taller_id = e.taller_id AND x.evento_id = e.id) AS oculto
       FROM orden_eventos e WHERE e.taller_id = ? AND e.orden_id = ? ORDER BY e.created_at, e.rowid`,
    tallerId, ordenId,
  );
  const esEstado = (x: string | null): x is EstadoOT => !!x && (ESTADOS_OT as readonly string[]).includes(x);
  return filas
    .filter((f) => esEstado(f.estado_nuevo))
    .map((f) => ({ id: f.id, anterior: esEstado(f.estado_anterior) ? f.estado_anterior : null, estado: f.estado_nuevo as EstadoOT, at: f.created_at, oculto: !!f.oculto }));
}

/** Arma lo que ve el cliente a partir del estado actual y de las transiciones (ya filtradas por visibilidad). Pura: se prueba sin base. */
export function proyectar(
  d: { taller: string; numero: number; estado: EstadoOT; patente: string; marca: string | null; modelo: string | null; fechaPrometida: string | null; fechaIngreso: string; mostrarFecha: boolean; zona: string },
  visibles: readonly EventoVisible[],
  mensaje: { texto: string; at: string } | null,
  hoy: string,
): SeguimientoPublico {
  const base = ESTADO_PUBLICO[d.estado];
  const fechas = [...visibles.map((v) => v.at), ...(mensaje ? [mensaje.at] : [])];
  return {
    taller: { nombre: d.taller },
    orden: { referencia: numeroReferencia(d.numero) },
    vehiculo: { marca: d.marca, modelo: d.modelo, patente: enmascararPatente(d.patente) },
    estado: { ...base, clave: d.estado, listo: d.estado === 'lista', cerrado: d.estado === 'entregada' || d.estado === 'cancelada' },
    recorrido: recorrido(d.estado, visibles).map(({ titulo, detalle, situacion, at }) => ({ titulo, detalle, situacion, at })),
    // Historial: lo más reciente primero (es lo que el cliente quiere ver).
    historial: [...visibles].reverse().map((v) => ({ titulo: tituloTransicion(v.estado, v.anterior), at: v.at })),
    entrega: entregaEstimada(d.fechaPrometida, d.estado, d.mostrarFecha, hoy),
    mensaje,
    actualizado_at: fechas.length ? fechas.reduce((a, b) => (a > b ? a : b)) : d.fechaIngreso,
    zona_horaria: d.zona,
  };
}

/**
 * Consulta pública por token. Devuelve null si el token no tiene forma de token, no existe, fue reemplazado o el enlace está desactivado
 * (los cuatro casos son indistinguibles desde afuera). Nada de lo que se lee depende de datos que mande el visitante salvo el token.
 */
export async function consultarSeguimiento(db: D1Database, token: string): Promise<SeguimientoPublico | null> {
  if (!tokenConFormato(token)) return null;
  const r = await first<{
    taller_id: string; orden_id: string; mostrar: number; taller: string; numero: number; estado: string; fecha_prometida: string | null; fecha_ingreso: string;
    patente: string; marca: string | null; modelo: string | null;
  }>(
    db,
    `SELECT s.taller_id, s.orden_id, s.mostrar_fecha_estimada AS mostrar, t.nombre AS taller, o.numero, o.estado, o.fecha_prometida, o.fecha_ingreso,
            v.patente, ma.nombre AS marca, mo.nombre AS modelo
       FROM seguimiento_enlaces s
       JOIN ordenes o ON o.taller_id = s.taller_id AND o.id = s.orden_id
       JOIN talleres t ON t.id = s.taller_id
       JOIN vehiculos v ON v.taller_id = o.taller_id AND v.id = o.vehiculo_id
       LEFT JOIN marcas ma ON ma.taller_id = v.taller_id AND ma.id = v.marca_id
       LEFT JOIN modelos mo ON mo.taller_id = v.taller_id AND mo.id = v.modelo_id
      WHERE s.token = ? AND s.activo = 1`,
    token,
  );
  if (!r || !(ESTADOS_OT as readonly string[]).includes(r.estado)) return null;
  const [trans, mensaje, zona] = await Promise.all([transiciones(db, r.taller_id, r.orden_id), mensajeVigente(db, r.taller_id, r.orden_id), zonaDelTaller(db, r.taller_id)]);
  const visibles: EventoVisible[] = trans.filter((t) => !t.oculto).map((t) => ({ estado: t.estado, anterior: t.anterior, at: t.at }));
  return proyectar(
    { taller: r.taller, numero: r.numero, estado: r.estado as EstadoOT, patente: r.patente, marca: r.marca, modelo: r.modelo, fechaPrometida: r.fecha_prometida, fechaIngreso: r.fecha_ingreso, mostrarFecha: !!r.mostrar, zona },
    visibles,
    mensaje,
    fechaLocal(ahora(), zona),
  );
}
