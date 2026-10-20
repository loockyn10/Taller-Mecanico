// Selección de la lista de precios de un documento (presupuesto, OT, venta).
// Cambiar de lista NO toca los ítems por sí solo: se ofrece recalcular los precios y el usuario decide.
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Boton, Campo, Select, useConfirmar, useToast } from './ui';
import type { ItemUI } from './EditorItems';

export interface ListaPrecio {
  id: string;
  nombre: string;
  base: 'costo' | 'precio';
  porcentaje: number;
  es_default: number;
  activa: number;
}

export function useListas() {
  const { puede } = useAuth();
  return useQuery({ queryKey: ['listas-precios', 'activas'], queryFn: () => api.get<ListaPrecio[]>('/listas-precios'), enabled: puede('catalogo.ver'), staleTime: 60_000 });
}

/** Preselecciona la lista predeterminada en documentos nuevos. */
export function useListaPorDefecto(activo: boolean, valor: string | null, setValor: (id: string | null) => void) {
  const { data: listas } = useListas();
  const [hecho, setHecho] = useState(false);
  useEffect(() => {
    if (!activo || hecho || !listas) return;
    setHecho(true);
    const def = listas.find((l) => l.es_default);
    if (def && !valor) setValor(def.id);
  }, [activo, hecho, listas, valor, setValor]);
}

export function SelectorLista({
  valor, onCambio, items, onItems, nombreActual,
}: { valor: string | null; onCambio: (id: string | null) => void; items: ItemUI[]; onItems: (i: ItemUI[]) => void; nombreActual?: string | null }) {
  const { data: listas = [] } = useListas();
  const { confirmar, dialogo } = useConfirmar();
  const toast = useToast();
  const [trabajando, setTrabajando] = useState(false);
  const repreciables = items.filter((i) => (i.tipo === 'articulo' && i.articulo_id) || (i.tipo === 'servicio' && i.servicio_id));
  // Si el documento usa una lista que luego se desactivó, se sigue mostrando para no perder la referencia.
  const opciones = listas.some((l) => l.id === valor) || !valor ? listas : [...listas, { id: valor, nombre: `${nombreActual ?? 'Lista'} (desactivada)`, base: 'precio', porcentaje: 0, es_default: 0, activa: 0 } as ListaPrecio];

  const recalcular = async (listaId: string | null) => {
    setTrabajando(true);
    try {
      const r = await api.post<{ articulos: Record<string, number>; servicios: Record<string, number> }>(`/listas-precios/${listaId ?? 'base'}/precios`, {
        articulos: [...new Set(repreciables.filter((i) => i.tipo === 'articulo').map((i) => i.articulo_id!))],
        servicios: [...new Set(repreciables.filter((i) => i.tipo === 'servicio').map((i) => i.servicio_id!))],
      });
      onItems(
        items.map((i) => {
          const p = i.tipo === 'articulo' ? r.articulos[i.articulo_id ?? ''] : i.tipo === 'servicio' ? r.servicios[i.servicio_id ?? ''] : undefined;
          return p == null ? i : { ...i, precio_unitario: p };
        }),
      );
      toast.ok('Precios recalculados');
    } catch (e) {
      toast.error(e);
    } finally {
      setTrabajando(false);
    }
  };

  const cambiar = async (id: string | null) => {
    onCambio(id);
    if (!repreciables.length) return;
    const nombre = id ? listas.find((l) => l.id === id)?.nombre : 'el precio base';
    if (await confirmar('Recalcular precios', <>¿Querés recalcular los precios de los {repreciables.length} ítem(s) del catálogo con <strong>{nombre}</strong>? Las líneas libres y los descuentos no se modifican.</>)) await recalcular(id);
  };

  return (
    <>
      {dialogo}
      <div className="flex items-end gap-2">
        <Campo label="Lista de precios" className="flex-1">
          <Select value={valor ?? ''} onChange={(e) => cambiar(e.target.value || null)}>
            <option value="">Precio base (sin lista)</option>
            {opciones.map((l) => (
              <option key={l.id} value={l.id}>
                {l.nombre}
                {l.es_default ? ' · predeterminada' : ''}
              </option>
            ))}
          </Select>
        </Campo>
        {repreciables.length > 0 && (
          <Boton tam="md" icono={<RefreshCw className="size-4" />} cargando={trabajando} onClick={() => recalcular(valor)} title="Volver a calcular los precios de los ítems con la lista elegida" aria-label="Recalcular precios">
            Recalcular
          </Boton>
        )}
      </div>
    </>
  );
}
