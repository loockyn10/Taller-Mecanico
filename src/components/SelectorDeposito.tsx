// Selector de depósito para las operaciones de stock. Si el taller tiene un único depósito no se muestra (todo va al principal).
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Campo, Select } from './ui';

export interface DepositoApi {
  id: string;
  nombre: string;
  es_principal: number;
  activo: number;
  notas: string | null;
  articulos_con_stock: number;
  unidades: number;
  valor_costo?: number;
}

export function useDepositos() {
  return useQuery({ queryKey: ['depositos'], queryFn: () => api.get<DepositoApi[]>('/depositos'), staleTime: 60_000, retry: false });
}

/** `valor` vacío = depósito principal. */
export function SelectorDeposito({ valor, onCambio, label = 'Depósito', hint, className }: { valor: string; onCambio: (id: string) => void; label?: string; hint?: string; className?: string }) {
  const { data = [] } = useDepositos();
  const activos = data.filter((d) => d.activo);
  if (activos.length < 2) return null;
  const principal = activos.find((d) => d.es_principal);
  return (
    <Campo label={label} hint={hint} className={className}>
      <Select value={valor} onChange={(e) => onCambio(e.target.value)}>
        <option value="">{principal?.nombre ?? 'Depósito principal'} (predeterminado)</option>
        {activos.filter((d) => !d.es_principal).map((d) => <option key={d.id} value={d.id}>{d.nombre}</option>)}
      </Select>
    </Campo>
  );
}
