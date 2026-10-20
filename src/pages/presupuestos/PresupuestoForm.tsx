import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { hoyISO, sumarDias } from '@/lib/format';
import { Boton, Campo, Cargando, Encabezado, Input, Tarjeta, Textarea, useToast } from '@/components/ui';
import { SelectorCliente, SelectorVehiculo, type ClienteMin } from '@/components/selectores';
import { SelectorLista, useListaPorDefecto } from '@/components/SelectorLista';
import { EditorItems, itemsDesdeApi, itemsParaApi, paramsVacios, type ItemUI, type ParamsUI } from '@/components/EditorItems';

export function PresupuestoForm() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { data: cfg } = useQuery({ queryKey: ['config'], queryFn: () => api.get('/taller/config') });
  const { data: existente, isLoading } = useQuery({ queryKey: ['presupuesto', id], queryFn: () => api.get(`/presupuestos/${id}`), enabled: !!id });
  const [cliente, setCliente] = useState<ClienteMin | null>(null);
  const [vehiculoId, setVehiculoId] = useState<string | null>(null);
  const [km, setKm] = useState('');
  const [fecha, setFecha] = useState(hoyISO());
  const [valido, setValido] = useState('');
  const [obs, setObs] = useState('');
  const [items, setItems] = useState<ItemUI[]>([]);
  const [params, setParams] = useState<ParamsUI>(paramsVacios());
  const [lista, setLista] = useState<string | null>(null);
  useListaPorDefecto(!id, lista, setLista);

  useEffect(() => {
    if (cfg && !id && !valido) setValido(sumarDias(hoyISO(), cfg.config.validez_presupuesto_dias));
  }, [cfg, id, valido]);
  useEffect(() => {
    if (!existente) return;
    setCliente({ id: existente.cliente_id, codigo: 0, nombre: existente.cliente, telefono: existente.cliente_telefono });
    setVehiculoId(existente.vehiculo_id);
    setKm(existente.km != null ? String(existente.km) : '');
    setFecha(existente.fecha);
    setValido(existente.valido_hasta ?? '');
    setObs(existente.observaciones ?? '');
    setLista(existente.lista_precio_id ?? null);
    setItems(itemsDesdeApi(existente.items));
    setParams({ desc_global_pct: existente.desc_global_pct, desc_global_monto: existente.desc_global_monto, iva_pct: existente.iva_pct, recargo_pct: existente.recargo_pct });
  }, [existente]);

  const m = useMutation({
    mutationFn: () => {
      const datos = { cliente_id: cliente!.id, vehiculo_id: vehiculoId, km: km ? Number(km) : null, fecha, valido_hasta: valido || null, observaciones: obs, lista_precio_id: lista, items: itemsParaApi(items), ...params };
      return id ? api.put(`/presupuestos/${id}`, datos).then(() => ({ id })) : api.post('/presupuestos', datos);
    },
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ['presupuestos'] });
      qc.invalidateQueries({ queryKey: ['presupuesto'] });
      toast.ok(id ? 'Presupuesto actualizado' : 'Presupuesto creado');
      nav(`/presupuestos/${p.id}`, { replace: true });
    },
    onError: toast.error,
  });

  if (id && isLoading) return <Cargando />;
  if (existente && existente.estado !== 'pendiente') {
    return <p className="text-sm">Solo se pueden editar presupuestos pendientes.</p>;
  }

  return (
    <>
      <Encabezado titulo={id ? `Editar presupuesto P-${String(existente?.numero ?? '').padStart(4, '0')}` : 'Nuevo presupuesto'} volver />
      <div className="grid gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <Tarjeta titulo="Cliente y vehículo">
            <div className="space-y-4">
              <SelectorCliente valor={cliente} onCambio={(c) => { setCliente(c); setVehiculoId(null); }} />
              <SelectorVehiculo clienteId={cliente?.id ?? null} valor={vehiculoId} onCambio={(v, veh) => { setVehiculoId(v); if (veh && !km) setKm(String(veh.km_actual || '')); }} />
            </div>
          </Tarjeta>
          <Tarjeta titulo="Detalle">
            <div className="mb-4"><SelectorLista valor={lista} onCambio={setLista} items={items} onItems={setItems} nombreActual={existente?.lista_precio_nombre} /></div>
            <EditorItems items={items} onItems={setItems} params={params} onParams={setParams} listaId={lista} />
          </Tarjeta>
        </div>
        <div className="space-y-5">
          <Tarjeta titulo="Condiciones">
            <div className="space-y-3">
              <Campo label="Fecha"><Input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} /></Campo>
              <Campo label="Válido hasta"><Input type="date" value={valido} onChange={(e) => setValido(e.target.value)} /></Campo>
              <Campo label="Kilometraje"><Input value={km} onChange={(e) => setKm(e.target.value.replace(/\D/g, ''))} inputMode="numeric" /></Campo>
              <Campo label="Observaciones para el cliente"><Textarea value={obs} onChange={(e) => setObs(e.target.value)} rows={4} /></Campo>
            </div>
          </Tarjeta>
          <div className="flex gap-2">
            <Boton className="flex-1" onClick={() => nav(-1)}>Cancelar</Boton>
            <Boton className="flex-1" variante="primario" disabled={!cliente || !vehiculoId || !items.length} cargando={m.isPending} onClick={() => m.mutate()}>Guardar</Boton>
          </div>
        </div>
      </div>
    </>
  );
}
