import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CalendarClock, ChevronLeft, ChevronRight, Plus, Wrench } from 'lucide-react';
import { api } from '@/lib/api';
import { hoyISO, money, numero, sumarDias } from '@/lib/format';
import { Aviso, Boton, BotonIcono, Campo, Cargando, cn, Encabezado, Input, Modal, Select, Tarjeta, Textarea, useConfirmar, useToast } from '@/components/ui';
import { EstadoTurnoBadge } from '@/components/estados';
import { SelectorCliente, SelectorVehiculo, useMecanicos, type ClienteMin } from '@/components/selectores';
import { ESTADOS_TURNO, ESTADO_TURNO_LABEL } from '@shared/dominio';

function lunesDe(iso: string) {
  const d = new Date(`${iso}T12:00:00`);
  const dia = (d.getDay() + 6) % 7;
  return sumarDias(iso, -dia);
}

function FormTurno({ inicial, onCerrar, extra }: { inicial: any; onCerrar: () => void; extra?: ReactNode }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: mecanicos = [] } = useMecanicos();
  const [cliente, setCliente] = useState<ClienteMin | null>(inicial.cliente_id ? { id: inicial.cliente_id, codigo: 0, nombre: inicial.cliente, telefono: inicial.cliente_telefono } : null);
  const [f, setF] = useState({
    fecha: inicial.fecha ?? hoyISO(),
    hora: inicial.hora ?? '09:00',
    duracion_min: inicial.duracion_min ?? 60,
    vehiculo_id: inicial.vehiculo_id ?? null,
    presupuesto_id: inicial.presupuesto_id ?? null,
    mecanico_id: inicial.mecanico_id ?? '',
    motivo: inicial.motivo ?? '',
    notas: inicial.notas ?? '',
    estado: inicial.estado ?? 'agendado',
  });
  const m = useMutation({
    mutationFn: () => {
      const d = { ...f, cliente_id: cliente!.id, mecanico_id: f.mecanico_id || null, duracion_min: Number(f.duracion_min) };
      return inicial.id ? api.put(`/turnos/${inicial.id}`, d) : api.post('/turnos', { ...d, estado: undefined });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['turnos'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast.ok('Turno guardado');
      onCerrar();
    },
    onError: toast.error,
  });
  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo={inicial.id ? 'Editar turno' : 'Nuevo turno'}
      ancho="lg"
      pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" disabled={!cliente} cargando={m.isPending} onClick={() => m.mutate()}>Guardar</Boton></>}
    >
      <div className="space-y-4">
        {extra && <div className="flex flex-wrap gap-2 rounded-ctl bg-slate-50 p-2">{extra}</div>}
        {inicial.presupuesto_numero && <Aviso>Vinculado al presupuesto P-{numero(inicial.presupuesto_numero)}</Aviso>}
        <SelectorCliente valor={cliente} onCambio={setCliente} />
        <SelectorVehiculo clienteId={cliente?.id ?? null} cliente={cliente} valor={f.vehiculo_id} onCambio={(v) => setF({ ...f, vehiculo_id: v })} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Campo label="Fecha" requerido><Input type="date" value={f.fecha} onChange={(e) => setF({ ...f, fecha: e.target.value })} /></Campo>
          <Campo label="Hora" requerido><Input type="time" value={f.hora} onChange={(e) => setF({ ...f, hora: e.target.value })} /></Campo>
          <Campo label="Duración">
            <Select value={f.duracion_min} onChange={(e) => setF({ ...f, duracion_min: Number(e.target.value) })}>
              {[30, 60, 90, 120, 180, 240, 480].map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h`}</option>)}
            </Select>
          </Campo>
          <Campo label="Motivo" className="sm:col-span-2"><Input value={f.motivo} onChange={(e) => setF({ ...f, motivo: e.target.value })} placeholder="Ej.: service 10.000 km" /></Campo>
          <Campo label="Mecánico">
            <Select value={f.mecanico_id} onChange={(e) => setF({ ...f, mecanico_id: e.target.value })}>
              <option value="">Sin asignar</option>
              {mecanicos.filter((m) => m.activo).map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
            </Select>
          </Campo>
          {inicial.id && (
            <Campo label="Estado">
              <Select value={f.estado} onChange={(e) => setF({ ...f, estado: e.target.value })}>
                {ESTADOS_TURNO.map((e) => <option key={e} value={e}>{ESTADO_TURNO_LABEL[e]}</option>)}
              </Select>
            </Campo>
          )}
          <Campo label="Notas" className="sm:col-span-3"><Textarea rows={2} value={f.notas} onChange={(e) => setF({ ...f, notas: e.target.value })} /></Campo>
        </div>
      </div>
    </Modal>
  );
}

export function Agenda() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { confirmar, dialogo } = useConfirmar();
  const [inicio, setInicio] = useState(lunesDe(hoyISO()));
  const [form, setForm] = useState<any | null>(null);
  const [sp, setSp] = useSearchParams();
  // Un mantenimiento pendiente abre el turno ya cargado con el cliente, el vehículo y el motivo.
  useEffect(() => {
    const vId = sp.get('vehiculo');
    if (sp.get('nuevo') && vId) {
      api.get(`/vehiculos/${vId}`).then((v) => {
        // El vehículo puede tener varios clientes (o ninguno): se propone el titular o el primero vinculado y se puede cambiar.
        const c = v.clientes_vinculados?.[0];
        setForm({ cliente_id: c?.cliente_id, cliente: c?.cliente, cliente_telefono: c?.cliente_telefono, vehiculo_id: v.id, motivo: sp.get('motivo') ?? '' });
      }).catch(() => undefined);
      setSp({}, { replace: true });
    }
  }, [sp, setSp]);
  const dias = useMemo(() => Array.from({ length: 7 }, (_, i) => sumarDias(inicio, i)), [inicio]);
  const { data: turnos = [], isLoading } = useQuery({ queryKey: ['turnos', inicio], queryFn: () => api.get<any[]>(`/turnos?desde=${dias[0]}&hasta=${dias[6]}`) });
  const { data: pendientes = [] } = useQuery({ queryKey: ['turnos', 'pendientes'], queryFn: () => api.get<any[]>('/turnos/pendientes') });
  const estado = useMutation({
    mutationFn: ({ id, estado }: { id: string; estado: string }) => api.put(`/turnos/${id}`, { estado }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['turnos'] }),
    onError: toast.error,
  });
  const borrar = useMutation({
    mutationFn: (id: string) => api.del(`/turnos/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['turnos'] });
      setForm(null);
      toast.ok('Turno eliminado');
    },
    onError: toast.error,
  });
  const hoy = hoyISO();

  return (
    <>
      {dialogo}
      <Encabezado
        titulo="Agenda de turnos"
        subtitulo={`Semana del ${new Date(`${dias[0]}T12:00:00`).toLocaleDateString('es-AR', { day: 'numeric', month: 'long' })}`}
        acciones={
          <>
            <Boton icono={<ChevronLeft className="size-4" />} onClick={() => setInicio(sumarDias(inicio, -7))} aria-label="Semana anterior" />
            <Boton onClick={() => setInicio(lunesDe(hoyISO()))}>Hoy</Boton>
            <Boton icono={<ChevronRight className="size-4" />} onClick={() => setInicio(sumarDias(inicio, 7))} aria-label="Semana siguiente" />
            <Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => setForm({ fecha: hoy })}>Nuevo turno</Boton>
          </>
        }
      />
      {pendientes.length > 0 && (
        <Tarjeta titulo="Presupuestos aprobados sin turno" className="mb-5" sinPadding>
          <ul className="divide-y divide-borde">
            {pendientes.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                <span><span className="font-medium">P-{numero(p.numero)}</span> · {p.cliente} · <span className="font-semibold tracking-wide">{p.patente}</span> · {money(p.total)}</span>
                <Boton tam="sm" icono={<CalendarClock className="size-4" />} onClick={() => setForm({ fecha: hoy, cliente_id: p.cliente_id, cliente: p.cliente, vehiculo_id: p.vehiculo_id, presupuesto_id: p.id, presupuesto_numero: p.numero })}>Agendar</Boton>
              </li>
            ))}
          </ul>
        </Tarjeta>
      )}
      {isLoading ? <Cargando /> : (
        <div className="grid gap-3 md:grid-cols-7">
          {dias.map((d) => {
            const delDia = turnos.filter((t) => t.fecha === d);
            const fechaD = new Date(`${d}T12:00:00`);
            return (
              <div key={d} className={cn('min-h-32 rounded-card border bg-white', d === hoy ? 'border-marca-300 ring-2 ring-marca-100' : 'border-borde')}>
                <div className="flex items-center justify-between border-b border-borde px-3 py-2">
                  <span className="text-sm font-semibold capitalize">{fechaD.toLocaleDateString('es-AR', { weekday: 'short' })} {fechaD.getDate()}</span>
                  <BotonIcono etiqueta="Agregar turno" className="-my-1 size-8" onClick={() => setForm({ fecha: d })}><Plus className="size-4" /></BotonIcono>
                </div>
                <div className="space-y-1.5 p-2">
                  {delDia.map((t) => (
                    <button key={t.id} type="button" onClick={() => setForm(t)} className={cn('w-full rounded-ctl border px-2 py-1.5 text-left text-xs hover:border-marca-300', t.estado === 'cancelado' || t.estado === 'ausente' ? 'border-borde bg-slate-50 text-tenue line-through' : 'border-marca-100 bg-marca-50/50')}>
                      <div className="font-semibold">{t.hora} · {t.patente ?? 'Sin vehículo'}</div>
                      <div className="truncate">{t.cliente}</div>
                      {t.motivo && <div className="truncate text-tenue">{t.motivo}</div>}
                      <div className="mt-1"><EstadoTurnoBadge estado={t.estado} /></div>
                    </button>
                  ))}
                  {!delDia.length && <p className="py-2 text-center text-xs text-slate-500">Libre</p>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {form && (
        <FormTurno
          inicial={form}
          onCerrar={() => setForm(null)}
          extra={
            form.id &&
            (form.orden_id ? (
              <Boton tam="sm" variante="primario" icono={<Wrench className="size-4" />} onClick={() => nav(`/ordenes/${form.orden_id}`)}>Ver OT #{numero(form.orden_numero)}</Boton>
            ) : (
              <>
                <Boton tam="sm" variante="primario" icono={<Wrench className="size-4" />} onClick={() => nav(`/ordenes/nueva?turno=${form.id}&cliente=${form.cliente_id}${form.vehiculo_id ? `&vehiculo=${form.vehiculo_id}` : ''}&motivo=${encodeURIComponent(form.motivo ?? '')}`)}>Recibir vehículo (crear OT)</Boton>
                {form.estado === 'agendado' && <Boton tam="sm" onClick={() => { estado.mutate({ id: form.id, estado: 'confirmado' }); setForm(null); }}>Confirmar</Boton>}
                <Boton tam="sm" onClick={() => { estado.mutate({ id: form.id, estado: 'ausente' }); setForm(null); }}>No asistió</Boton>
                <Boton tam="sm" variante="peligro" onClick={async () => { if (await confirmar('Eliminar turno', '¿Eliminar este turno?', true)) borrar.mutate(form.id); }}>Eliminar</Boton>
              </>
            ))
          }
        />
      )}
    </>
  );
}
