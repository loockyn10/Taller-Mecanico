// Estado de la caja y utilidades comunes a las pantallas que mueven dinero.
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { api } from './api';
import { useAuth } from './auth';

export interface EstadoCaja {
  obligatoria: boolean;
  sesion: null | {
    id: string;
    numero: number;
    fecha: string;
    saldo_inicial: number;
    abierta_at: string;
    abierta_por_nombre: string | null;
    resumen: { por_medio: Array<{ medio: string; ingresos: number; egresos: number; neto: number }>; por_rubro: Array<{ rubro: string; neto: number }>; movimientos: number; efectivo_esperado: number };
  };
  ultima_cierre: null | { efectivo_declarado: number | null; cerrada_at: string | null; numero: number };
  sin_caja_hoy: number;
}

export function useEstadoCaja() {
  const { puede } = useAuth();
  return useQuery({ queryKey: ['caja', 'estado'], queryFn: () => api.get<EstadoCaja>('/caja/estado'), enabled: puede('caja.operar'), staleTime: 10_000 });
}

/** Claves de consulta que dependen del dinero: se invalidan después de cobrar, pagar, anular, abrir o cerrar caja. */
export const CLAVES_DINERO = [
  'cuenta', 'cuentas', 'ventas', 'venta', 'orden', 'ordenes', 'cobros', 'cobro', 'cliente', 'dashboard',
  'caja', 'finanzas', 'gastos', 'compras', 'compra', 'proveedor', 'proveedores',
];

export function invalidarDinero(qc: QueryClient) {
  CLAVES_DINERO.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
}
