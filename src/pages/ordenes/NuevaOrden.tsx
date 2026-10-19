import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { km } from '@/lib/format';
import { Boton, Campo, Encabezado, Input, Select, Tarjeta, Textarea, useToast } from '@/components/ui';
import { SelectorCliente, SelectorVehiculo, useMecanicos, type ClienteMin } from '@/components/selectores';
import { EditorItems, itemsParaApi, paramsVacios, type ItemUI, type ParamsUI } from '@/components/EditorItems';

export function NuevaOrden() {
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [sp] = useSearchParams();
  const { data: mecanicos = [] } = useMecanicos();
  const [cliente, setCliente] = useState<ClienteMin | null>(null);
  const [vehiculoId, setVehiculoId] = useState<string | null>(null);
  const [kmActual, setKmActual] = useState<number | null>(null);
  const [kmIngreso, setKmIngreso] = useState('');
  const [mecanico, setMecanico] = useState('');
  const [falla, setFalla] = useState('');
  const [prometida, setPrometida] = useState('');
  const [obs, setObs] = useState('');
  const [items, setItems] = useState<ItemUI[]>([]);
  const [params, setParams] = useState<ParamsUI>(paramsVacios());
  const turnoId = sp.get('turno');

  // Precarga desde un turno de la agenda o desde la ficha de un cliente/vehículo.
  useEffect(() => {
    const cId = sp.get('cliente');
    if (cId) api.get(`/clientes/${cId}`).then((c) => setCliente(c)).catch(() => undefined);
    const vId = sp.get('vehiculo');
    if (vId) setVehiculoId(vId);
    if (sp.get('motivo')) setFalla(sp.get('motivo')!);
  }, [sp]);

  const m = useMutation({
    mutationFn: () =>
      api.post('/ordenes', {
        cliente_id: cliente!.id,
        vehiculo_id: vehiculoId,
        mecanico_id: mecanico || null,
        km_ingreso: kmIngreso ? Number(kmIngreso) : null,
        falla_reportada: falla,
        observaciones: obs,
        fecha_prometida: prometida || null,
        turno_id: turnoId,
        items: itemsParaApi(items),
        ...params,
      }),
    onSuccess: (o) => {
      qc.invalidateQueries({ queryKey: ['ordenes'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      qc.invalidateQueries({ queryKey: ['turnos'] });
      toast.ok(`OT #${String(o.numero).padStart(4, '0')} creada`);
      nav(`/ordenes/${o.id}`, { replace: true });
    },
    onError: toast.error,
  });

  return (
    <>
      <Encabezado titulo="Nueva orden de trabajo" volver="/ordenes" />
      <div className="grid gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <Tarjeta titulo="Cliente y vehículo">
            <div className="space-y-4">
              <SelectorCliente
                valor={cliente}
                onCambio={(c) => {
                  setCliente(c);
                  setVehiculoId(null);
                }}
              />
              <SelectorVehiculo
                clienteId={cliente?.id ?? null}
                valor={vehiculoId}
                onCambio={(id, v) => {
                  setVehiculoId(id);
                  if (v) setKmActual(v.km_actual);
                }}
              />
            </div>
          </Tarjeta>
          <Tarjeta titulo="Trabajos y repuestos" subtitulo="Podés completarlo ahora o después del diagnóstico">
            <EditorItems items={items} onItems={setItems} params={params} onParams={setParams} />
          </Tarjeta>
        </div>
        <div className="space-y-5">
          <Tarjeta titulo="Ingreso">
            <div className="space-y-3">
              <Campo label="Kilometraje de ingreso" hint={kmActual != null ? `Último registrado: ${km(kmActual)}` : undefined}>
                <Input value={kmIngreso} onChange={(e) => setKmIngreso(e.target.value.replace(/\D/g, ''))} inputMode="numeric" />
              </Campo>
              <Campo label="Falla reportada por el cliente">
                <Textarea value={falla} onChange={(e) => setFalla(e.target.value)} rows={3} placeholder="Ej.: ruido al frenar, luz de check engine…" />
              </Campo>
              <Campo label="Mecánico asignado">
                <Select value={mecanico} onChange={(e) => setMecanico(e.target.value)}>
                  <option value="">Sin asignar</option>
                  {mecanicos.filter((x) => x.activo).map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
                </Select>
              </Campo>
              <Campo label="Fecha prometida de entrega">
                <Input type="date" value={prometida} onChange={(e) => setPrometida(e.target.value)} />
              </Campo>
              <Campo label="Observaciones internas">
                <Textarea value={obs} onChange={(e) => setObs(e.target.value)} rows={2} />
              </Campo>
            </div>
          </Tarjeta>
          <div className="flex gap-2">
            <Boton className="flex-1" onClick={() => nav('/ordenes')}>Cancelar</Boton>
            <Boton className="flex-1" variante="primario" disabled={!cliente || !vehiculoId} cargando={m.isPending} onClick={() => m.mutate()}>Crear OT</Boton>
          </div>
        </div>
      </div>
    </>
  );
}
