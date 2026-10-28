import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Car, History, Link2Off, Pencil, Plus, Wrench } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fecha, km } from '@/lib/format';
import { Aviso, Boton, BotonIcono, Buscador, Cargando, Dato, Encabezado, ErrorCaja, Insignia, Modal, Tabla, Tarjeta, useConfirmar, useDebounce, useToast, Vacio } from '@/components/ui';
import { HistorialTecnico } from '@/components/HistorialTecnico';
import { AccionesMantenimiento, EstadoMantenimiento, FormPlanMantenimiento, proximoTexto, type MantenimientoApi } from '@/components/Mantenimientos';
import { FormVehiculo, SelectRelacion, SelectorCliente, type ClienteMin } from '@/components/selectores';
import { RELACION_VEHICULO_LABEL, type RelacionVehiculo } from '@shared/dominio';
import { GaleriaFotos, usePermisosFotos } from '@/components/Fotos';
import { ChecklistsVehiculo } from '@/components/checklist/Checklist';

export function Vehiculos() {
  const nav = useNavigate();
  const { puede } = useAuth();
  const [q, setQ] = useState('');
  const [sinClientes, setSinClientes] = useState(false);
  const [alta, setAlta] = useState(false);
  const dq = useDebounce(q);
  const verClientes = puede('clientes.ver');
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['vehiculos', { q: dq, sinClientes }], queryFn: () => api.get<any[]>(`/vehiculos?q=${encodeURIComponent(dq)}${sinClientes ? '&sin_clientes=1' : ''}`) });
  return (
    <>
      <Encabezado
        titulo="Vehículos"
        subtitulo="Cada vehículo tiene su propio historial; puede tener ningún cliente, uno o varios vinculados"
        acciones={puede('vehiculos.crear') && <Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => setAlta(true)}>Nuevo vehículo</Boton>}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Buscador value={q} onChange={setQ} placeholder={verClientes ? 'Patente, cliente, marca o modelo' : 'Patente, marca o modelo'} className="min-w-0 flex-1 basis-64" />
        <button
          type="button"
          aria-pressed={sinClientes}
          onClick={() => setSinClientes((v) => !v)}
          className={`h-10 rounded-ctl border px-3 text-sm ${sinClientes ? 'border-marca-400 bg-marca-50 text-marca-700' : 'border-borde bg-white text-slate-600 hover:bg-slate-50'}`}
        >
          Sin clientes vinculados
        </button>
      </div>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={data}
            clave={(v) => v.id}
            onFila={(v) => nav(`/vehiculos/${v.id}`)}
            vacio={<Vacio icono={<Car className="size-5" />} titulo={sinClientes ? 'No hay vehículos sin clientes' : 'No hay vehículos'} />}
            columnas={[
              { clave: 'p', titulo: 'Patente', render: (v) => <span className="font-semibold tracking-wide">{v.patente}</span>, movil: 'titulo' },
              { clave: 'm', titulo: 'Vehículo', render: (v) => [v.marca, v.modelo, v.anio].filter(Boolean).join(' ') || '—', movil: 'subtitulo' },
              ...(verClientes ? [{ clave: 'c', titulo: 'Clientes', render: (v: any) => (v.clientes ? <span className="break-words">{v.clientes}</span> : <span className="text-tenue">Sin clientes vinculados</span>), movil: 'meta' as const }] : []),
              { clave: 'k', titulo: 'Km', alinear: 'derecha', render: (v) => km(v.km_actual), movil: 'derecha' },
            ]}
          />
        </Tarjeta>
      )}
      <Modal abierto={alta} onCerrar={() => setAlta(false)} titulo="Nuevo vehículo" ancho="lg">
        <FormVehiculo onCancelar={() => setAlta(false)} onGuardado={(v) => { setAlta(false); nav(`/vehiculos/${v.id}`); }} />
      </Modal>
    </>
  );
}

interface Vinculo {
  id: string;
  cliente_id: string;
  cliente: string;
  cliente_codigo: number;
  cliente_telefono: string | null;
  cliente_activo: number;
  relacion: RelacionVehiculo | null;
  vinculado_at: string;
  vinculado_por_nombre: string | null;
  desvinculado_at: string | null;
  desvinculado_por_nombre: string | null;
}

const relacionTexto = (r: RelacionVehiculo | null) => (r ? RELACION_VEHICULO_LABEL[r] : 'Sin especificar');

/** Clientes vinculados al vehículo (varios a la vez, ninguno es obligatorio) y, aparte, las asociaciones anteriores. Sólo con permiso para ver clientes. */
function ClientesVinculados({ v }: { v: any }) {
  const { puede } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const { confirmar, dialogo } = useConfirmar();
  const [vincular, setVincular] = useState(false);
  const [editar, setEditar] = useState<Vinculo | null>(null);
  const [anteriores, setAnteriores] = useState(false);
  const vigentes: Vinculo[] = v.clientes_vinculados ?? [];
  const previos: Vinculo[] = v.clientes_anteriores ?? [];
  const puedeEditar = puede('vehiculos.editar');
  const refrescar = () => {
    qc.invalidateQueries({ queryKey: ['vehiculo', v.id] });
    qc.invalidateQueries({ queryKey: ['vehiculo-clientes'] });
    qc.invalidateQueries({ queryKey: ['vehiculos'] });
    qc.invalidateQueries({ queryKey: ['cliente'] });
  };
  const desvincular = useMutation({
    mutationFn: (x: Vinculo) => api.del(`/vehiculos/${v.id}/clientes/${x.id}`),
    onSuccess: () => { refrescar(); toast.ok('Cliente desvinculado'); },
    onError: toast.error,
  });
  return (
    <Tarjeta
      titulo="Clientes vinculados"
      subtitulo="Pueden ser varios a la vez. Cada orden conserva su propio cliente responsable"
      acciones={puedeEditar && <Boton tam="sm" icono={<Plus className="size-4" />} onClick={() => setVincular(true)}>Vincular cliente</Boton>}
    >
      {dialogo}
      {vigentes.length === 0 ? (
        <p className="rounded-ctl border border-dashed border-borde px-3 py-3 text-sm"><strong className="font-semibold">Sin clientes vinculados</strong><span className="block text-tenue">Podés registrar órdenes igual, eligiendo el cliente responsable en cada una.</span></p>
      ) : (
        <ul className="divide-y divide-borde">
          {vigentes.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <Link to={`/clientes/${x.cliente_id}`} className="break-words font-medium text-marca-700">{x.cliente}</Link>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-tenue">
                  <Insignia tono={x.relacion === 'titular' ? 'azul' : 'gris'}>{relacionTexto(x.relacion)}</Insignia>
                  {x.cliente_telefono && <span>{x.cliente_telefono}</span>}
                  <span>desde {fecha(x.vinculado_at)}</span>
                </div>
              </div>
              {puedeEditar && (
                <div className="flex shrink-0 items-center">
                  <BotonIcono etiqueta={`Editar relación de ${x.cliente}`} onClick={() => setEditar(x)}><Pencil className="size-4" /></BotonIcono>
                  <BotonIcono
                    etiqueta={`Desvincular a ${x.cliente}`}
                    peligro
                    onClick={async () => {
                      if (await confirmar('Desvincular cliente', <>¿Desvincular a <b>{x.cliente}</b> de este vehículo? El cliente, el vehículo y las órdenes anteriores no se modifican; el vínculo queda en el historial.</>, true)) desvincular.mutate(x);
                    }}
                  >
                    <Link2Off className="size-4" />
                  </BotonIcono>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {previos.length > 0 && (
        <div className="mt-4 border-t border-borde pt-3">
          <button type="button" className="flex items-center gap-1.5 text-sm font-medium text-slate-600" aria-expanded={anteriores} onClick={() => setAnteriores((a) => !a)}>
            <History className="size-4" /> {anteriores ? 'Ocultar' : 'Ver'} clientes anteriores ({previos.length})
          </button>
          {anteriores && (
            <ul className="mt-2 space-y-1.5 text-sm">
              {previos.map((x) => (
                <li key={x.id} className="rounded-ctl bg-slate-50 px-3 py-2">
                  <Link to={`/clientes/${x.cliente_id}`} className="break-words font-medium text-slate-700">{x.cliente}</Link>
                  <span className="block text-xs text-tenue">{relacionTexto(x.relacion)} · del {fecha(x.vinculado_at)} al {fecha(x.desvinculado_at!)}{x.desvinculado_por_nombre ? ` · desvinculó ${x.desvinculado_por_nombre}` : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {vincular && <ModalVincular vehiculoId={v.id} yaVinculados={vigentes.map((x) => x.cliente_id)} hayTitular={vigentes.some((x) => x.relacion === 'titular')} onCerrar={() => setVincular(false)} onListo={refrescar} />}
      {editar && <ModalRelacion vehiculoId={v.id} vinculo={editar} onCerrar={() => setEditar(null)} onListo={refrescar} />}
    </Tarjeta>
  );
}

function ModalVincular({ vehiculoId, yaVinculados, hayTitular, onCerrar, onListo }: { vehiculoId: string; yaVinculados: string[]; hayTitular: boolean; onCerrar: () => void; onListo: () => void }) {
  const toast = useToast();
  const [cliente, setCliente] = useState<ClienteMin | null>(null);
  const [relacion, setRelacion] = useState(hayTitular ? '' : 'titular');
  const repetido = !!cliente && yaVinculados.includes(cliente.id);
  const m = useMutation({
    mutationFn: () => api.post(`/vehiculos/${vehiculoId}/clientes`, { cliente_id: cliente!.id, relacion: relacion || null }),
    onSuccess: () => { onListo(); toast.ok('Cliente vinculado'); onCerrar(); },
    onError: toast.error,
  });
  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo="Vincular cliente"
      pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" disabled={!cliente || repetido} cargando={m.isPending} onClick={() => m.mutate()}>Vincular</Boton></>}
    >
      <div className="space-y-3">
        <SelectorCliente valor={cliente} onCambio={setCliente} etiqueta="Buscar cliente" />
        {repetido && <Aviso tono="ambar">{cliente!.nombre} ya está vinculado a este vehículo.</Aviso>}
        <div>
          <p className="mb-1 text-[13px] font-medium text-slate-700">Relación con el vehículo <span className="font-normal text-tenue">(opcional)</span></p>
          <SelectRelacion valor={relacion} onCambio={setRelacion} />
        </div>
        <p className="text-xs text-tenue">¿No está cargado? Usá “Nuevo” en el buscador: no se crea ningún cliente automáticamente.</p>
      </div>
    </Modal>
  );
}

function ModalRelacion({ vehiculoId, vinculo, onCerrar, onListo }: { vehiculoId: string; vinculo: Vinculo; onCerrar: () => void; onListo: () => void }) {
  const toast = useToast();
  const [relacion, setRelacion] = useState<string>(vinculo.relacion ?? '');
  const m = useMutation({
    mutationFn: () => api.put(`/vehiculos/${vehiculoId}/clientes/${vinculo.id}`, { relacion: relacion || null }),
    onSuccess: () => { onListo(); toast.ok('Relación actualizada'); onCerrar(); },
    onError: toast.error,
  });
  return (
    <Modal abierto onCerrar={onCerrar} titulo={`Relación de ${vinculo.cliente}`} pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" cargando={m.isPending} onClick={() => m.mutate()}>Guardar</Boton></>}>
      <SelectRelacion valor={relacion} onCambio={setRelacion} />
    </Modal>
  );
}

function MantenimientosVehiculo({ v }: { v: any }) {
  const { puede, me } = useAuth();
  const [form, setForm] = useState<{ inicial: MantenimientoApi | null } | null>(null);
  // Aviso al cliente: el titular vinculado (o el primero); sin clientes vinculados no hay a quién avisar por WhatsApp.
  const contacto = (v.clientes_vinculados ?? [])[0] as Vinculo | undefined;
  const { data = [], isLoading } = useQuery({ queryKey: ['mantenimientos', 'vehiculo', v.id], queryFn: () => api.get<MantenimientoApi[]>(`/vehiculos/${v.id}/mantenimientos`) });
  return (
    <Tarjeta titulo="Mantenimientos" subtitulo="Próximos vencimientos por kilometraje y tiempo" acciones={puede('mantenimientos.gestionar') && <Boton tam="sm" icono={<Plus className="size-4" />} onClick={() => setForm({ inicial: null })}>Programar</Boton>}>
      {isLoading ? <Cargando /> : data.length === 0 ? (
        <p className="text-sm text-tenue">Sin mantenimientos programados. Se arman solos con los servicios que tienen intervalo, o podés programarlos a mano.</p>
      ) : (
        <ul className="space-y-3 text-sm">
          {data.map((m) => (
            <li key={m.servicio_id} className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <button type="button" className="text-left" onClick={() => puede('mantenimientos.gestionar') && setForm({ inicial: m })}>
                  <span className="block font-medium">{m.servicio}</span>
                  <span className="block text-xs text-tenue">{m.fecha_realizado ? `Último: ${fecha(m.fecha_realizado)}${m.km_realizado != null ? ` · ${km(m.km_realizado)}` : ''}${m.origen_realizado === 'antecedente' ? ' (antecedente)' : ''}` : 'Sin realización registrada'}</span>
                  <span className="block text-xs text-tenue">Próximo: {proximoTexto(m)}</span>
                </button>
                <EstadoMantenimiento m={m} />
              </div>
              {m.estado !== 'al_dia' && <AccionesMantenimiento m={{ ...m, cliente: contacto?.cliente, cliente_telefono: contacto?.cliente_telefono }} clienteId={contacto?.cliente_id} tallerNombre={me?.taller.nombre} />}
            </li>
          ))}
        </ul>
      )}
      {form && <FormPlanMantenimiento vehiculoId={v.id} inicial={form.inicial} onCerrar={() => setForm(null)} />}
    </Tarjeta>
  );
}

export function VehiculoDetalle() {
  const { id } = useParams();
  const { puede } = useAuth();
  const nav = useNavigate();
  const [editar, setEditar] = useState(false);
  const permisosFotos = usePermisosFotos();
  const { data: v, isLoading, error, refetch } = useQuery({ queryKey: ['vehiculo', id], queryFn: () => api.get(`/vehiculos/${id}`) });
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  return (
    <>
      <Encabezado
        volver
        titulo={<span className="tracking-wide">{v.patente}</span>}
        subtitulo={[v.marca, v.modelo, v.anio, v.color].filter(Boolean).join(' · ') || 'Sin datos del modelo'}
        acciones={
          <>
            <Boton icono={<Pencil className="size-4" />} onClick={() => setEditar(true)}>Editar</Boton>
            <Boton variante="primario" icono={<Wrench className="size-4" />} onClick={() => nav(`/ordenes/nueva?vehiculo=${v.id}`)}>Nueva OT</Boton>
          </>
        }
      />
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {puede('clientes.ver') && <div className="lg:hidden"><ClientesVinculados v={v} /></div>}
          {permisosFotos.ver && (
            <Tarjeta titulo="Fotografías" subtitulo="Del vehículo y de sus órdenes de trabajo (cada foto se guarda una sola vez)">
              <GaleriaFotos vehiculoId={v.id} puedeSubir={permisosFotos.subir} puedeEliminar={permisosFotos.eliminar} filtros />
            </Tarjeta>
          )}
          {puede('checklists.ver') && <ChecklistsVehiculo vehiculoId={v.id} />}
          <HistorialTecnico vehiculoId={v.id} />
        </div>
        <div className="space-y-5">
          {/* En pantallas angostas los clientes vinculados van arriba de todo; en anchas, en la columna lateral. */}
          {puede('clientes.ver') && <div className="hidden lg:block"><ClientesVinculados v={v} /></div>}
          <Tarjeta titulo="Ficha">
            <dl className="grid grid-cols-2 gap-4">
              <Dato etiqueta="Kilometraje">{km(v.km_actual)}</Dato>
              <Dato etiqueta="Combustible">{v.combustible}</Dato>
              <Dato etiqueta="Versión">{v.version}</Dato>
              <Dato etiqueta="Motor">{v.motor}</Dato>
              <Dato etiqueta="Chasis">{v.vin}</Dato>
              <Dato etiqueta="Notas" className="col-span-2">{v.notas}</Dato>
            </dl>
          </Tarjeta>
          {puede('mantenimientos.ver') && <MantenimientosVehiculo v={v} />}
        </div>
      </div>
      <Modal abierto={editar} onCerrar={() => setEditar(false)} titulo="Editar vehículo" ancho="lg">
        <FormVehiculo inicial={v} onCancelar={() => setEditar(false)} onGuardado={() => setEditar(false)} />
      </Modal>
    </>
  );
}
