// Seguimiento público de órdenes de trabajo: cómo se le presenta al cliente el estado operativo de la OT.
//
// No existe un segundo sistema de estados: la OT tiene UN estado (`ordenes.estado`) y un registro de transiciones (`orden_eventos`, con la hora del servidor).
// Este módulo sólo TRADUCE eso a un lenguaje que entienda quien no conoce el taller y arma el recorrido sin forzar una progresión lineal:
// una reparación puede volver a diagnóstico o esperar repuestos más de una vez, y el recorrido refleja siempre lo que realmente pasó.
//
// Es código puro (sin acceso a datos): lo usan el servidor (página pública y JSON) y la pantalla del taller, y se prueba aparte.
import type { EstadoOT } from './dominio';

// ───────────────────────── Token ─────────────────────────

/** 32 bytes aleatorios en base64url (sin relleno) = 43 caracteres. Es la única credencial del enlace. */
export const TOKEN_LARGO = 43;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** Verifica el formato ANTES de consultar la base: lo que no tiene forma de token ni se busca. */
export const tokenConFormato = (t: unknown): t is string => typeof t === 'string' && TOKEN_RE.test(t);

export const RUTA_PUBLICA = '/seguimiento';
export const MENSAJE_MAX = 500;

// ───────────────────────── Estados públicos ─────────────────────────

export type TonoEstado = 'info' | 'trabajo' | 'espera' | 'listo' | 'cerrado' | 'cancelado';

export interface EstadoPublico {
  titulo: string;
  /** Una o dos frases, sin jerga del taller. */
  explicacion: string;
  tono: TonoEstado;
}

export const ESTADO_PUBLICO: Record<EstadoOT, EstadoPublico> = {
  recibida: { titulo: 'Vehículo recibido', explicacion: 'Recibimos tu vehículo. En breve lo revisa un mecánico del taller.', tono: 'info' },
  diagnostico: { titulo: 'En diagnóstico', explicacion: 'Estamos revisando tu vehículo para identificar qué necesita.', tono: 'trabajo' },
  esperando_repuestos: { titulo: 'Esperando repuestos', explicacion: 'Pedimos los repuestos necesarios. Retomamos la reparación apenas lleguen.', tono: 'espera' },
  en_reparacion: { titulo: 'En reparación', explicacion: 'Nuestros mecánicos están trabajando en tu vehículo.', tono: 'trabajo' },
  lista: { titulo: 'Listo para retirar', explicacion: '¡Tu vehículo está listo! Podés pasar a retirarlo por el taller.', tono: 'listo' },
  entregada: { titulo: 'Entregado', explicacion: 'Tu vehículo ya fue entregado. ¡Gracias por confiar en nosotros!', tono: 'cerrado' },
  cancelada: { titulo: 'Orden cancelada', explicacion: 'Esta orden fue cancelada. Si tenés dudas, consultá directamente con el taller.', tono: 'cancelado' },
};

// ───────────────────────── Recorrido ─────────────────────────

/** Orden "natural" del trabajo. No es una regla: sólo ordena cómo se dibuja el recorrido. */
const PASOS: Array<{ estado: Exclude<EstadoOT, 'cancelada'>; titulo: string; detalle: string; opcional?: boolean }> = [
  { estado: 'recibida', titulo: 'Vehículo recibido', detalle: 'Ingresó al taller.' },
  { estado: 'diagnostico', titulo: 'Diagnóstico', detalle: 'Revisión para saber qué necesita.' },
  { estado: 'esperando_repuestos', titulo: 'Espera de repuestos', detalle: 'Hay que esperar un repuesto para seguir.', opcional: true },
  { estado: 'en_reparacion', titulo: 'Reparación', detalle: 'El trabajo se está realizando.' },
  { estado: 'lista', titulo: 'Listo para retirar', detalle: 'Ya podés pasar a buscarlo.' },
  { estado: 'entregada', titulo: 'Entregado', detalle: 'Te lo entregamos.' },
];
const ORDEN_PASO = new Map<EstadoOT, number>(PASOS.map((p, i) => [p.estado, i]));

export interface EventoVisible {
  estado: EstadoOT;
  anterior: EstadoOT | null;
  /** Instante UTC (ISO) en que el servidor registró la transición. */
  at: string;
}

export type SituacionPaso = 'hecho' | 'actual' | 'pendiente';

export interface PasoRecorrido {
  estado: EstadoOT;
  titulo: string;
  detalle: string;
  situacion: SituacionPaso;
  /** Cuándo se llegó a este paso (sólo pasos hechos o actual, y sólo si esa transición es visible). */
  at: string | null;
}

/**
 * Pasos del recorrido para el estado actual.
 *  - Los pasos ANTERIORES al actual aparecen como hechos sólo si de verdad ocurrieron (hay una transición visible hacia ellos): un paso que se salteó no se
 *    marca como completado y uno que el taller ocultó no se muestra.
 *  - Los pasos POSTERIORES siempre aparecen como pendientes: nunca como completados. "Espera de repuestos" sólo se muestra si ocurre o ya ocurrió.
 *  - Si la reparación vuelve atrás (por ejemplo de reparación a diagnóstico), lo que ya no corresponde pasa a pendiente.
 *  - Una orden cancelada no tiene recorrido: se muestra el estado y el historial.
 */
export function recorrido(actual: EstadoOT, visibles: readonly EventoVisible[]): PasoRecorrido[] {
  if (actual === 'cancelada') return [];
  const idxActual = ORDEN_PASO.get(actual)!;
  const ultimaVez = (e: EstadoOT) => {
    let r: string | null = null;
    for (const v of visibles) if (v.estado === e && (r === null || v.at >= r)) r = v.at;
    return r;
  };
  const pasos: PasoRecorrido[] = [];
  PASOS.forEach((p, i) => {
    const at = ultimaVez(p.estado);
    if (i < idxActual) {
      if (at) pasos.push({ estado: p.estado, titulo: p.titulo, detalle: p.detalle, situacion: 'hecho', at });
    } else if (i === idxActual) {
      pasos.push({ estado: p.estado, titulo: p.titulo, detalle: p.detalle, situacion: 'actual', at });
    } else if (!p.opcional) {
      pasos.push({ estado: p.estado, titulo: p.titulo, detalle: p.detalle, situacion: 'pendiente', at: null });
    }
  });
  return pasos;
}

// ───────────────────────── Historial ─────────────────────────

/** Texto de una transición para el historial, según desde dónde vino (volver a diagnóstico no es lo mismo que empezarlo). */
export function tituloTransicion(estado: EstadoOT, anterior: EstadoOT | null): string {
  const idx = (e: EstadoOT | null) => (e ? ORDEN_PASO.get(e) ?? -1 : -1);
  const retrocede = anterior !== null && anterior !== 'cancelada' && idx(estado) !== -1 && idx(estado) < idx(anterior);
  switch (estado) {
    case 'recibida':
      return anterior === 'cancelada' ? 'Orden reabierta' : 'Vehículo recibido';
    case 'diagnostico':
      return retrocede ? 'Volvió a diagnóstico' : 'En diagnóstico';
    case 'esperando_repuestos':
      return 'Esperando repuestos';
    case 'en_reparacion':
      return anterior === 'lista' || anterior === 'entregada' ? 'Se retomó la reparación' : 'Reparación en curso';
    case 'lista':
      return 'Listo para retirar';
    case 'entregada':
      return 'Vehículo entregado';
    case 'cancelada':
      return 'Orden cancelada';
  }
}

// ───────────────────────── Patente ─────────────────────────

/**
 * Patente parcialmente oculta: alcanza para que el dueño reconozca su vehículo y no para identificarlo a simple vista.
 * AB123CD → AB•••CD · ABC123 → AB•••3 (formatos de 6 y 7 caracteres; lo demás se oculta casi por completo).
 */
export function enmascararPatente(patente: string | null | undefined): string {
  const p = (patente ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!p) return '';
  if (p.length <= 3) return '•'.repeat(p.length);
  const finales = p.length >= 7 ? 2 : 1;
  const inicio = p.slice(0, 2);
  const fin = p.slice(p.length - finales);
  return `${inicio}${'•'.repeat(p.length - 2 - finales)}${fin}`;
}

// ───────────────────────── Fecha estimada ─────────────────────────

export interface EntregaEstimada {
  /** AAAA-MM-DD, tal como la cargó el taller. */
  fecha: string;
  /** La fecha ya pasó y la orden sigue abierta: no se presenta como un compromiso vigente. */
  vencida: boolean;
}

const ABIERTOS: ReadonlySet<EstadoOT> = new Set<EstadoOT>(['recibida', 'diagnostico', 'esperando_repuestos', 'en_reparacion']);

/**
 * La fecha prometida de la OT sólo se muestra mientras el trabajo está en curso y el taller no la ocultó. `hoy` es la fecha local del taller (AAAA-MM-DD).
 * No modifica ni calcula nada de la planificación interna: es una lectura del dato existente.
 */
export function entregaEstimada(prometida: string | null | undefined, estado: EstadoOT, mostrar: boolean, hoy: string): EntregaEstimada | null {
  if (!mostrar || !prometida || !/^\d{4}-\d{2}-\d{2}$/.test(prometida) || !ABIERTOS.has(estado)) return null;
  return { fecha: prometida, vencida: prometida < hoy };
}
