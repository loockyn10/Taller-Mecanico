// Elección del vehículo y del cliente responsable de una operación (orden de trabajo, presupuesto).
// El historial técnico pertenece al vehículo; el cliente responsable pertenece a ESTA operación: puede ser cualquiera de los vinculados al vehículo
// o cualquier otro cliente del taller (y, si no estaba vinculado, se ofrece vincularlo en el mismo paso).
import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link2, UserRound } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { RELACION_VEHICULO_LABEL, type RelacionVehiculo } from '@shared/dominio';
import { Aviso, cn } from './ui';
import { SelectRelacion, SelectorCliente, SelectorVehiculo, type ClienteMin, type VehiculoMin } from './selectores';

export interface ValorClienteVehiculo {
  cliente: ClienteMin | null;
  vehiculoId: string | null;
  /** Vincular además al cliente con el vehículo (sólo si todavía no lo está). */
  vincular: boolean;
  /** Tipo de relación para ese vínculo ('' = sin especificar). */
  relacion: string;
}

export const valorClienteVehiculoVacio = (): ValorClienteVehiculo => ({ cliente: null, vehiculoId: null, vincular: false, relacion: '' });

/** Campos que se suman al cuerpo de la solicitud (`vincular_cliente`, `vinculo_relacion`). */
export const vinculoParaApi = (v: ValorClienteVehiculo) => (v.vincular ? { vincular_cliente: true, vinculo_relacion: (v.relacion || null) as RelacionVehiculo | null } : {});

interface Vinculado {
  id: string;
  cliente_id: string;
  cliente: string;
  cliente_codigo: number;
  cliente_telefono: string | null;
  relacion: RelacionVehiculo | null;
}

const comoCliente = (x: Vinculado): ClienteMin => ({ id: x.cliente_id, codigo: x.cliente_codigo, nombre: x.cliente, telefono: x.cliente_telefono });

export function ClienteVehiculo({ valor, onCambio, onVehiculo }: { valor: ValorClienteVehiculo; onCambio: (v: ValorClienteVehiculo) => void; onVehiculo?: (v: VehiculoMin | null) => void }) {
  const { puede } = useAuth();
  const verClientes = puede('clientes.ver');
  const puedeVincular = verClientes && puede('vehiculos.editar');
  const { data } = useQuery({
    queryKey: ['vehiculo-clientes', valor.vehiculoId],
    queryFn: () => api.get<{ vigentes: Vinculado[]; anteriores: Vinculado[] }>(`/vehiculos/${valor.vehiculoId}/clientes`),
    enabled: !!valor.vehiculoId && verClientes,
  });
  const vigentes = data?.vigentes ?? [];
  const yaVinculado = !!valor.cliente && vigentes.some((x) => x.cliente_id === valor.cliente!.id);

  // Si el vehículo tiene un único cliente vinculado y todavía no se eligió responsable, se propone ese (se puede cambiar).
  const propuesto = useRef<string | null>(null);
  useEffect(() => {
    if (!valor.vehiculoId || !data || propuesto.current === valor.vehiculoId) return;
    propuesto.current = valor.vehiculoId;
    if (!valor.cliente && data.vigentes.length === 1) onCambio({ ...valor, cliente: comoCliente(data.vigentes[0]) });
  }, [valor, data, onCambio]);

  const elegirCliente = (c: ClienteMin | null) => onCambio({ ...valor, cliente: c, vincular: false, relacion: '' });

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-[13px] font-medium text-slate-700">Vehículo</p>
        <SelectorVehiculo
          clienteId={valor.cliente?.id ?? null}
          cliente={valor.cliente}
          valor={valor.vehiculoId}
          onCambio={(id, v) => {
            onCambio({ ...valor, vehiculoId: id, vincular: false, relacion: '' });
            onVehiculo?.(v ?? null);
          }}
        />
      </div>

      <div>
        <p className="mb-1.5 text-[13px] font-medium text-slate-700">Cliente responsable de esta orden</p>
        {valor.vehiculoId && verClientes && vigentes.length > 0 && !valor.cliente && (
          <div className="mb-2">
            <p className="mb-1 text-xs text-tenue">Clientes vinculados a este vehículo</p>
            <div className="flex flex-wrap gap-2">
              {vigentes.map((x) => (
                <button key={x.id} type="button" onClick={() => elegirCliente(comoCliente(x))} className={cn('flex items-center gap-2 rounded-ctl border border-borde bg-white px-3 py-2 text-left text-sm hover:bg-slate-50')}>
                  <UserRound className="size-4 text-tenue" />
                  <span>
                    <span className="block font-medium">{x.cliente}</span>
                    <span className="block text-xs text-tenue">{x.relacion ? RELACION_VEHICULO_LABEL[x.relacion] : 'Sin relación indicada'}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        {valor.vehiculoId && verClientes && data && vigentes.length === 0 && !valor.cliente && (
          <p className="mb-2 text-xs text-tenue">Este vehículo no tiene clientes vinculados. Elegí a quien se le factura y se le avisa por esta orden.</p>
        )}
        <SelectorCliente valor={valor.cliente} onCambio={elegirCliente} etiqueta={vigentes.length ? 'Buscar otro cliente' : undefined} />
        {valor.vehiculoId && valor.cliente && verClientes && data && !yaVinculado && (
          <div className="mt-2 space-y-2">
            <Aviso tono="azul">
              {valor.cliente.nombre} no figura entre los clientes vinculados a este vehículo. La orden se le asigna igual; si querés, podés vincularlo ahora.
            </Aviso>
            {puedeVincular && (
              <div className="flex flex-wrap items-center gap-2 rounded-ctl border border-borde bg-white px-3 py-2">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input type="checkbox" checked={valor.vincular} onChange={(e) => onCambio({ ...valor, vincular: e.target.checked })} />
                  <Link2 className="size-4 text-tenue" />
                  Vincular a {valor.cliente.nombre} con este vehículo
                </label>
                {valor.vincular && <SelectRelacion valor={valor.relacion} onCambio={(r) => onCambio({ ...valor, relacion: r })} className="w-48" />}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
