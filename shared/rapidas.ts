// Operaciones rápidas: causas de baja interna de inventario (un subconjunto de las causas del ajuste manual de stock).
import type { MotivoAjuste } from './dominio';

export const MOTIVOS_BAJA = ['rotura', 'robo', 'uso_interno', 'merma', 'vencimiento', 'otro'] as const satisfies readonly MotivoAjuste[];
export type MotivoBaja = (typeof MOTIVOS_BAJA)[number];

/** Nombres que ve quien registra la baja. */
export const MOTIVO_BAJA_LABEL: Record<MotivoBaja, string> = {
  rotura: 'Rotura o daño',
  robo: 'Pérdida o robo',
  uso_interno: 'Consumo interno del taller',
  merma: 'Merma',
  vencimiento: 'Vencimiento',
  otro: 'Otro motivo (explicar)',
};

/** Prefijo de la clave de idempotencia de las ventas emitidas desde Operaciones rápidas (permite listarlas en el historial). */
export const PREFIJO_VENTA_RAPIDA = 'rapida:';
