// Historial técnico del vehículo: línea de tiempo con las intervenciones hechas en Fierro (se leen de las órdenes de trabajo)
// y los antecedentes anteriores cargados a mano, claramente diferenciados. Sin importes para quien no tiene permiso.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ClipboardList, FileClock, Plus, Wrench } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { duracion, fecha, hoyISO, km, money, numero } from '@/lib/format';
import { Boton, Campo, Cargando, Check, Chip, ErrorCaja, Input, Insignia, Modal, Select, Tarjeta, Textarea, useConfirmar, useToast, Vacio } from './ui';
import { EstadoOTBadge } from './estados';
import { ESTADO_TAREA_LABEL, formatearMinutos } from '@shared/tempario';

const TIPOS = { mantenimiento: 'Mantenimiento', reparacion: 'Reparación', diagnostico: 'Diagnóstico', otro: 'Otro' } as const;

function FormAntecedente({ vehiculoId, inicial, onCerrar }: { vehiculoId: string; inicial?: any; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: servicios = [] } = useQuery({ queryKey: ['servicios', 'todos'], queryFn: () => api.get<any[]>('/servicios?todos=1'), staleTime: 60_000, retry: false });
  const [f, setF] = useState({
    fecha: inicial?.fecha ?? hoyISO(),
    km: inicial?.km != null ? String(inicial.km) : '',
    tipo: inicial?.tipo ?? 'reparacion',
    descripcion: inicial?.descripcion ?? '',
    servicio_id: inicial?.servicio_id ?? '',
    repuestos: inicial?.repuestos ?? '',
    realizado_por: inicial?.realizado_por ?? '',
    resultado: inicial?.resultado ?? '',
    observaciones: inicial?.observaciones ?? '',
  });
  const guardar = useMutation({
    mutationFn: () => {
      const d = { ...f, km: f.km ? Number(f.km) : null, servicio_id: f.servicio_id || null };
      return inicial ? api.put(`/antecedentes/${inicial.id}`, d) : api.post(`/vehiculos/${vehiculoId}/antecedentes`, d);
    },
    onSuccess: () => { ['historial-tecnico', 'vehiculo', 'mantenimientos'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast.ok('Antecedente guardado'); onCerrar(); },
    onError: toast.error,
  });
  return (
    <Modal abierto onCerrar={onCerrar} titulo={inicial ? 'Editar antecedente' : 'Cargar antecedente anterior'} ancho="lg"
      pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" disabled={f.descripcion.trim().length < 3} cargando={guardar.isPending} onClick={() => guardar.mutate()}>Guardar</Boton></>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 sm:col-span-3">Para trabajos hechos antes de usar Fierro o en otro taller. Quedan marcados como “cargados manualmente”, separados de las órdenes de trabajo.</p>
        <Campo label="Fecha" requerido><Input type="date" max={hoyISO()} value={f.fecha} onChange={(e) => setF({ ...f, fecha: e.target.value })} /></Campo>
        <Campo label="Kilometraje"><Input value={f.km} onChange={(e) => setF({ ...f, km: e.target.value.replace(/\D/g, '') })} inputMode="numeric" /></Campo>
        <Campo label="Tipo"><Select value={f.tipo} onChange={(e) => setF({ ...f, tipo: e.target.value })}>{Object.entries(TIPOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Campo>
        <Campo label="Qué se hizo" requerido className="sm:col-span-3"><Textarea rows={2} value={f.descripcion} onChange={(e) => setF({ ...f, descripcion: e.target.value })} autoFocus /></Campo>
        <Campo label="Corresponde a la operación" className="sm:col-span-2" hint="Si es un mantenimiento programable, cuenta como su última realización">
          <Select value={f.servicio_id} onChange={(e) => setF({ ...f, servicio_id: e.target.value })}>
            <option value="">Ninguna en particular</option>{servicios.filter((s) => s.activo).map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
          </Select>
        </Campo>
        <Campo label="Realizado por"><Input value={f.realizado_por} onChange={(e) => setF({ ...f, realizado_por: e.target.value })} placeholder="Taller o mecánico" /></Campo>
        <Campo label="Repuestos utilizados" className="sm:col-span-3"><Input value={f.repuestos} onChange={(e) => setF({ ...f, repuestos: e.target.value })} /></Campo>
        <Campo label="Resultado" className="sm:col-span-3"><Input value={f.resultado} onChange={(e) => setF({ ...f, resultado: e.target.value })} /></Campo>
        <Campo label="Observaciones" className="sm:col-span-3"><Textarea rows={2} value={f.observaciones} onChange={(e) => setF({ ...f, observaciones: e.target.value })} /></Campo>
      </div>
    </Modal>
  );
}

function EntradaOrden({ e, puedeVerOrden }: { e: any; puedeVerOrden: boolean }) {
  const [abierta, setAbierta] = useState(false);
  const tieneDetalle = e.tareas.length > 0 || e.observaciones_tecnicas.length > 0;
  const terminada = e.estado === 'lista' || e.estado === 'entregada';
  return (
    <li>
      <span className="absolute -left-1.5 mt-1.5 size-3 rounded-full border-2 border-white bg-marca-500" />
      <div className="flex flex-wrap items-center gap-2">
        <Insignia tono="azul"><Wrench className="size-3" />Hecho en Fierro</Insignia>
        {puedeVerOrden ? <Link to={`/ordenes/${e.id}`} className="font-semibold text-marca-700">OT #{numero(e.numero)}</Link> : <span className="font-semibold">OT #{numero(e.numero)}</span>}
        <EstadoOTBadge estado={e.estado} />
        <span className="text-sm text-tenue">{fecha(e.fecha)} · {km(e.km)}</span>
      </div>
      {e.falla_reportada && <p className="mt-1 text-sm"><span className="text-tenue">Motivo:</span> {e.falla_reportada}</p>}
      {e.diagnostico && <p className="text-sm"><span className="text-tenue">Diagnóstico:</span> {e.diagnostico}</p>}
      {e.trabajos.length > 0 && (
        <div className="mt-1.5">
          <p className="text-xs font-medium text-tenue">{terminada ? 'Trabajos realizados' : 'Trabajos previstos'}</p>
          <ul className="mt-0.5 flex flex-wrap gap-1.5">{e.trabajos.map((t: any, i: number) => <li key={i}><Insignia tono="azul">{t.descripcion}{t.cantidad !== 1 ? ` ×${t.cantidad}` : ''}</Insignia></li>)}</ul>
        </div>
      )}
      {e.repuestos.length > 0 && (
        <div className="mt-1.5">
          <p className="text-xs font-medium text-tenue">{terminada ? 'Repuestos utilizados' : 'Repuestos previstos'}</p>
          <ul className="mt-0.5 flex flex-wrap gap-1.5">{e.repuestos.map((t: any, i: number) => <li key={i}><Insignia tono="cian">{t.descripcion}{t.cantidad !== 1 ? ` ×${t.cantidad}` : ''}</Insignia></li>)}</ul>
        </div>
      )}
      {e.resultado && <p className="mt-1.5 text-sm"><span className="text-tenue">Resultado:</span> {e.resultado}</p>}
      {e.observaciones && <p className="text-sm"><span className="text-tenue">Observaciones:</span> {e.observaciones}</p>}
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-tenue">
        {e.mecanicos.length > 0 && <span>Mecánicos: {e.mecanicos.map((m: any) => `${m.nombre}${m.responsable ? ' (resp.)' : ''}${m.segundos ? ` ${duracion(m.segundos)}` : ''}`).join(', ')}</span>}
        {e.total !== undefined && <span>{money(e.total)}</span>}
        {tieneDetalle && <button type="button" className="font-medium text-marca-700" onClick={() => setAbierta((v) => !v)}>{abierta ? 'Ocultar detalle técnico' : 'Ver tareas y observaciones'}</button>}
      </div>
      {abierta && (
        <div className="mt-2 space-y-2 rounded-lg bg-slate-50 p-3 text-sm">
          {e.tareas.length > 0 && (
            <ul className="space-y-1">
              {e.tareas.map((t: any, i: number) => (
                <li key={i} className="flex flex-wrap items-center justify-between gap-2">
                  <span>{t.descripcion}{t.observaciones ? <span className="text-tenue"> — {t.observaciones}</span> : null}</span>
                  <span className="flex items-center gap-2 text-xs text-tenue">
                    {t.tiempo_estimado_min ? <span>est. {formatearMinutos(t.tiempo_estimado_min)}</span> : null}
                    {t.tiempo_real_seg ? <span>real {duracion(t.tiempo_real_seg)}</span> : null}
                    <Insignia tono={t.estado === 'completada' ? 'verde' : 'gris'}>{ESTADO_TAREA_LABEL[t.estado as keyof typeof ESTADO_TAREA_LABEL]}</Insignia>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {e.observaciones_tecnicas.map((n: any, i: number) => (
            <p key={i} className="whitespace-pre-wrap border-t border-borde pt-2 first:border-0 first:pt-0">{n.texto}<span className="block text-xs text-tenue">{n.usuario ?? '—'}</span></p>
          ))}
        </div>
      )}
    </li>
  );
}

function EntradaManual({ e, puedeEditar, onEditar, onAnular }: { e: any; puedeEditar: boolean; onEditar: () => void; onAnular: () => void }) {
  return (
    <li>
      <span className="absolute -left-1.5 mt-1.5 size-3 rounded-full border-2 border-white bg-amber-400" />
      <div className="flex flex-wrap items-center gap-2">
        <Insignia tono="ambar"><FileClock className="size-3" />Antecedente cargado manualmente</Insignia>
        <Insignia tono="gris">{TIPOS[e.tipo as keyof typeof TIPOS]}</Insignia>
        <span className="text-sm text-tenue">{fecha(e.fecha)} · {km(e.km)}</span>
      </div>
      <p className="mt-1 text-sm font-medium">{e.descripcion}</p>
      {e.servicio && <p className="text-sm"><span className="text-tenue">Operación:</span> {e.servicio}</p>}
      {e.repuestos && <p className="text-sm"><span className="text-tenue">Repuestos:</span> {e.repuestos}</p>}
      {e.resultado && <p className="text-sm"><span className="text-tenue">Resultado:</span> {e.resultado}</p>}
      {e.observaciones && <p className="text-sm"><span className="text-tenue">Observaciones:</span> {e.observaciones}</p>}
      <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-tenue">
        {e.realizado_por && <span>Realizado por: {e.realizado_por}</span>}
        <span>Cargado por {e.cargado_por ?? '—'}</span>
        {puedeEditar && <><button type="button" className="font-medium text-marca-700" onClick={onEditar}>Editar</button><button type="button" className="font-medium text-red-700" onClick={onAnular}>Anular</button></>}
      </div>
    </li>
  );
}

export function HistorialTecnico({ vehiculoId, className }: { vehiculoId: string; className?: string }) {
  const { puede } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const { confirmar, dialogo } = useConfirmar();
  const [filtro, setFiltro] = useState<'todo' | 'fierro' | 'manual'>('todo');
  const [canceladas, setCanceladas] = useState(false);
  const [form, setForm] = useState<{ inicial?: any } | null>(null);
  const puedeEditar = puede('vehiculos.editar');
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['historial-tecnico', vehiculoId, canceladas], queryFn: () => api.get<any>(`/vehiculos/${vehiculoId}/historial-tecnico${qs({ incluir_canceladas: canceladas ? 1 : undefined })}`) });
  const anular = useMutation({
    mutationFn: (id: string) => api.del(`/antecedentes/${id}`),
    onSuccess: () => { ['historial-tecnico', 'mantenimientos', 'vehiculo'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast.ok('Antecedente anulado'); },
    onError: toast.error,
  });
  const entradas = (data?.entradas ?? []).filter((e: any) => filtro === 'todo' || (filtro === 'fierro' ? e.origen === 'fierro' : e.origen === 'manual'));
  return (
    <Tarjeta
      titulo="Historial técnico"
      subtitulo={data ? `${data.resumen.ordenes} órdenes en Fierro · ${data.resumen.antecedentes} antecedentes cargados` : undefined}
      className={className}
      acciones={puedeEditar && <Boton tam="sm" icono={<Plus className="size-4" />} onClick={() => setForm({})}>Cargar antecedente</Boton>}
    >
      {dialogo}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Chip activo={filtro === 'todo'} onClick={() => setFiltro('todo')}>Todo</Chip>
        <Chip activo={filtro === 'fierro'} onClick={() => setFiltro('fierro')}>Hechos en Fierro</Chip>
        <Chip activo={filtro === 'manual'} onClick={() => setFiltro('manual')}>Cargados manualmente</Chip>
        <Check checked={canceladas} onChange={setCanceladas} label="Incluir canceladas" className="ml-auto text-xs" />
      </div>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : entradas.length === 0 ? (
        <Vacio icono={<ClipboardList className="size-5" />} titulo="Sin intervenciones registradas" texto={puedeEditar ? 'Las órdenes de trabajo se suman solas. Podés cargar antecedentes anteriores a Fierro.' : 'Las órdenes de trabajo se suman solas.'} />
      ) : (
        <ol className="relative space-y-6 border-l border-borde pl-5">
          {entradas.map((e: any) => e.origen === 'fierro'
            ? <EntradaOrden key={`o-${e.id}`} e={e} puedeVerOrden={puede('ordenes.ver') || puede('ordenes.asignadas')} />
            : <EntradaManual key={`a-${e.id}`} e={e} puedeEditar={puedeEditar} onEditar={() => setForm({ inicial: e })} onAnular={async () => { if (await confirmar('Anular antecedente', 'Va a dejar de mostrarse en el historial (queda constancia en la actividad).')) anular.mutate(e.id); }} />)}
        </ol>
      )}
      {form && <FormAntecedente vehiculoId={vehiculoId} inicial={form.inicial} onCerrar={() => setForm(null)} />}
    </Tarjeta>
  );
}
