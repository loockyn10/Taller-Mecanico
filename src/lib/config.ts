// Configuración del taller que consumen varias pantallas (IVA y recargo por defecto, medios de pago habilitados, pies de documentos).
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { MEDIOS_PAGO, type MedioPago } from '@shared/dominio';

export interface ConfigTaller {
  taller: Record<string, any>;
  config: {
    iva_default: number;
    recargo_default: number;
    validez_presupuesto_dias: number;
    margen_default: number;
    pie_documentos: string | null;
    pie_presupuesto: string | null;
    pie_recibo: string | null;
    pie_orden_compra: string | null;
    permitir_stock_negativo: number;
    caja_obligatoria: number;
    tolerancia_caja: number;
    alerta_cheques_dias: number;
    plazo_pago_dias: number;
    medios_pago: MedioPago[] | null;
  };
}

export function useConfigTaller() {
  return useQuery({ queryKey: ['config'], queryFn: () => api.get<ConfigTaller>('/taller/config'), staleTime: 60_000 });
}

/** Medios de pago habilitados en el taller (el efectivo siempre lo está). */
export function useMediosHabilitados(): readonly MedioPago[] {
  const { data } = useConfigTaller();
  const l = data?.config.medios_pago;
  return l ? MEDIOS_PAGO.filter((m) => m === 'efectivo' || l.includes(m)) : MEDIOS_PAGO;
}

/** IVA y recargo por defecto para documentos nuevos (presupuestos, órdenes, ventas). Se aplican una sola vez, cuando se abre el formulario. */
export function useDefectosDocumento() {
  const { data } = useConfigTaller();
  return { listo: !!data, iva: data?.config.iva_default ?? 0, recargo: data?.config.recargo_default ?? 0 };
}
