import { Insignia, type Tono } from './ui';
import { ESTADO_OT_LABEL, ESTADO_PRESUPUESTO_LABEL, ESTADO_TURNO_LABEL, type EstadoOT, type EstadoPresupuesto, type EstadoTurno } from '@shared/dominio';

export const TONO_OT: Record<EstadoOT, Tono> = {
  recibida: 'gris',
  diagnostico: 'violeta',
  en_reparacion: 'azul',
  esperando_repuestos: 'ambar',
  lista: 'verde',
  entregada: 'cian',
  cancelada: 'rojo',
};

export function EstadoOTBadge({ estado }: { estado: EstadoOT }) {
  return <Insignia tono={TONO_OT[estado]}>{ESTADO_OT_LABEL[estado]}</Insignia>;
}

export function EstadoPresupuestoBadge({ estado, vencido }: { estado: EstadoPresupuesto; vencido?: boolean | number }) {
  if (vencido && (estado === 'pendiente' || estado === 'aprobado')) return <Insignia tono="rojo">Vencido</Insignia>;
  const t: Record<EstadoPresupuesto, Tono> = { pendiente: 'ambar', aprobado: 'verde', rechazado: 'rojo', convertido: 'azul', anulado: 'gris' };
  return <Insignia tono={t[estado]}>{ESTADO_PRESUPUESTO_LABEL[estado]}</Insignia>;
}

export function EstadoTurnoBadge({ estado }: { estado: EstadoTurno }) {
  const t: Record<EstadoTurno, Tono> = { agendado: 'gris', confirmado: 'azul', en_taller: 'violeta', completado: 'verde', cancelado: 'rojo', ausente: 'ambar' };
  return <Insignia tono={t[estado]}>{ESTADO_TURNO_LABEL[estado]}</Insignia>;
}

export function EstadoCobroBadge({ total, cobrado, estado }: { total: number; cobrado: number; estado?: string }) {
  if (estado === 'anulada') return <Insignia tono="gris">Anulado</Insignia>;
  if (cobrado >= total) return <Insignia tono="verde">Cobrado</Insignia>;
  if (cobrado > 0) return <Insignia tono="ambar">Cobro parcial</Insignia>;
  return <Insignia tono="rojo">Pendiente de cobro</Insignia>;
}
