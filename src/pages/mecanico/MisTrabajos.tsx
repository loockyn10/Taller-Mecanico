// Vista del mecánico (celular o tablet del taller): sus órdenes, tareas con estado y cronómetro, sin precios ni datos comerciales.
// Pensada para uso rápido con las manos ocupadas: botones grandes, estados siempre visibles y pocos pasos.
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CalendarClock, ChevronLeft, ChevronRight, Clock, Package, PencilLine, Wrench } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { duracion, fecha, hoyISO, km, numero } from '@/lib/format';
import { Aviso, Boton, Cargando, Chip, Encabezado, ErrorCaja, Insignia, Modal, Tarjeta, Textarea, useToast, Vacio } from '@/components/ui';
import { EstadoOTBadge } from '@/components/estados';
import { BarraCronometro, Cronometro, EquipoOrden, NotasTecnicas, Tareas, useRefrescarOrden } from '@/components/TrabajoMecanico';
import { ESTADO_OT_LABEL, type EstadoOT } from '@shared/dominio';
import { formatearMinutos } from '@shared/tempario';

/** Estados a los que un mecánico puede llevar su orden (la entrega y la cancelación son del mostrador). */
const ESTADOS_TALLER: EstadoOT[] = ['diagnostico', 'en_reparacion', 'esperando_repuestos', 'lista'];

/** Resumen del día propio: dos medidas distintas, la asistencia (fichajes) y lo cronometrado en órdenes. */
function MiDia() {
  const hoy = hoyISO();
  const { data } = useQuery({ queryKey: ['productividad', 'mia', hoy], queryFn: () => api.get<any>(`/productividad/mia${qs({ desde: hoy, hasta: hoy })}`), refetchInterval: 120_000 });
  const y = data?.yo;
  if (!y) return null;
  return (
    <div className="mb-4 grid grid-cols-3 gap-2 text-center">
      {[
        ['En el taller', duracion(y.asistencia_seg)],
        ['Cronometrado en OT', duracion(y.registrado_ot_seg)],
        ['Tareas terminadas', String(y.tareas_completadas)],
      ].map(([t, v]) => (
        <div key={t} className="rounded-card border border-borde bg-white px-2 py-2.5">
          <p className="text-[11px] leading-tight text-tenue">{t}</p>
          <p className="text-base font-bold tabular-nums">{v}</p>
        </div>
      ))}
    </div>
  );
}

export function MisTrabajos() {
  const { me } = useAuth();
  const [ver, setVer] = useState<'abiertas' | 'todas'>('abiertas');
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['ordenes', 'mias', ver], queryFn: () => api.get<any[]>(`/ordenes?estado=${ver}`), refetchInterval: 60_000 });
  return (
    <>
      <BarraCronometro />
      <Encabezado titulo="Mis trabajos" subtitulo={`Hola ${me?.usuario.nombre.split(' ')[0]}: estas son tus órdenes`} />
      <MiDia />
      <div className="mb-4 flex gap-2">
        <Chip activo={ver === 'abiertas'} onClick={() => setVer('abiertas')}>En curso</Chip>
        <Chip activo={ver === 'todas'} onClick={() => setVer('todas')}>Todas</Chip>
      </div>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : !data?.length ? (
        <Tarjeta><Vacio icono={<Wrench className="size-5" />} titulo="No tenés trabajos asignados" texto="Cuando recepción te asigne una orden o una tarea, aparece acá." /></Tarjeta>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {data.map((o) => {
            const avance = o.tareas_total ? Math.round((o.tareas_completadas / o.tareas_total) * 100) : 0;
            return (
              <li key={o.id}>
                <Link to={`/mis-trabajos/${o.id}`} className="block rounded-card border border-borde bg-white p-4 shadow-card active:bg-slate-50">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-2xl font-extrabold tracking-wide">{o.patente}</p>
                      <p className="truncate text-sm text-tenue">{[o.marca, o.modelo, o.anio].filter(Boolean).join(' ') || 'Vehículo'}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      <EstadoOTBadge estado={o.estado} />
                      <span className="text-xs text-tenue">OT #{numero(o.numero)}</span>
                    </div>
                  </div>
                  {o.falla_reportada && <p className="mt-2 line-clamp-2 text-sm">{o.falla_reportada}</p>}
                  {o.tareas_total > 0 && (
                    <div className="mt-3">
                      <div className="mb-1 flex items-center justify-between text-xs text-tenue">
                        <span>{o.tareas_completadas} de {o.tareas_total} tareas{o.tareas_en_proceso ? ` · ${o.tareas_en_proceso} en curso` : ''}</span>
                        {o.tiempo_estimado_min ? <span className="inline-flex items-center gap-1"><Clock className="size-3.5" />{formatearMinutos(o.tiempo_estimado_min)} estimado</span> : null}
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-emerald-500" style={{ width: `${avance}%` }} /></div>
                    </div>
                  )}
                  <div className="mt-3 flex items-center justify-between text-xs text-tenue">
                    <span className="flex items-center gap-1">{o.fecha_prometida ? <><CalendarClock className="size-3.5" /> Prometida: {fecha(o.fecha_prometida)}</> : `Ingresó: ${fecha(o.fecha_ingreso)}`}</span>
                    <ChevronRight className="size-5 text-slate-500" />
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/** Registro rápido de una observación técnica, desde cualquier punto de la orden. */
function NotaRapida({ orden, abierto, onCerrar }: { orden: any; abierto: boolean; onCerrar: () => void }) {
  const toast = useToast();
  const refrescar = useRefrescarOrden(orden.id);
  const [texto, setTexto] = useState('');
  const guardar = useMutation({
    mutationFn: () => api.post(`/ordenes/${orden.id}/notas`, { texto }),
    onSuccess: () => { setTexto(''); refrescar(); toast.ok('Observación guardada'); onCerrar(); },
    onError: toast.error,
  });
  return (
    <Modal abierto={abierto} onCerrar={onCerrar} titulo="Observación rápida" pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" tam="lg" disabled={texto.trim().length < 2} cargando={guardar.isPending} onClick={() => guardar.mutate()}>Guardar</Boton></>}>
      <Textarea rows={5} autoFocus value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Ej.: discos con desgaste, avisar a recepción" className="text-base" />
    </Modal>
  );
}

export function MiTrabajo() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { puede } = useAuth();
  const [nota, setNota] = useState(false);
  const refrescar = useRefrescarOrden(id);
  const { data: o, isLoading, error, refetch } = useQuery({ queryKey: ['orden', id], queryFn: () => api.get(`/ordenes/${id}`), refetchInterval: 60_000 });
  // Para pasar de una orden a la siguiente sin volver al listado.
  const { data: lista } = useQuery({ queryKey: ['ordenes', 'mias', 'abiertas'], queryFn: () => api.get<any[]>('/ordenes?estado=abiertas'), staleTime: 30_000 });
  const estado = useMutation({
    mutationFn: (e: EstadoOT) => api.post(`/ordenes/${id}/estado`, { estado: e }),
    onSuccess: (r) => { refrescar(); toast.ok(r.stock === 'descontado' ? 'Orden lista. Se descontaron los repuestos del stock.' : 'Estado actualizado'); },
    onError: toast.error,
  });
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  const cerrada = o.estado === 'entregada' || o.estado === 'cancelada';
  const puedeEditar = !cerrada && (puede('ordenes.modificar') || (puede('ordenes.trabajar_asignadas') && o.asignada_a_mi));
  const repuestos = o.items.filter((i: any) => i.tipo === 'articulo');
  const trabajos = o.items.filter((i: any) => i.tipo !== 'articulo');
  const vehiculo = [o.marca, o.modelo, o.anio].filter(Boolean).join(' ');
  const c = o.checklist;
  const idx = lista ? lista.findIndex((x) => x.id === id) : -1;
  const anterior = idx > 0 ? lista![idx - 1] : null;
  const siguiente = idx >= 0 && idx < (lista?.length ?? 0) - 1 ? lista![idx + 1] : null;
  const sinTerminar = o.tareas.filter((t: any) => t.estado !== 'completada').length;

  return (
    <div className="mx-auto max-w-5xl pb-20">
      <BarraCronometro />
      <Encabezado volver="/mis-trabajos" titulo={<span className="flex flex-wrap items-center gap-2">{o.patente} <EstadoOTBadge estado={o.estado} /></span>} subtitulo={`OT #${numero(o.numero)}${vehiculo ? ` · ${vehiculo}` : ''}`} />
      {(anterior || siguiente) && (
        <div className="-mt-2 mb-4 flex gap-2">
          <Boton className="h-11 flex-1" icono={<ChevronLeft className="size-5" />} disabled={!anterior} onClick={() => anterior && nav(`/mis-trabajos/${anterior.id}`)}>{anterior ? anterior.patente : 'Anterior'}</Boton>
          <Boton className="h-11 flex-1" disabled={!siguiente} onClick={() => siguiente && nav(`/mis-trabajos/${siguiente.id}`)}>{siguiente ? siguiente.patente : 'Siguiente'}<ChevronRight className="size-5" /></Boton>
        </div>
      )}

      {puedeEditar && (
        <Tarjeta titulo="Estado del trabajo" className="mb-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {ESTADOS_TALLER.map((e) => (
              <Boton key={e} tam="lg" variante={o.estado === e ? 'primario' : 'secundario'} disabled={o.estado === e || estado.isPending} onClick={() => estado.mutate(e)} className="h-14 whitespace-normal text-center text-[15px] leading-tight">
                {ESTADO_OT_LABEL[e]}
              </Boton>
            ))}
          </div>
          {o.estado !== 'lista' && sinTerminar > 0 && <p className="mt-2 text-xs text-tenue">Quedan {sinTerminar} tarea{sinTerminar > 1 ? 's' : ''} sin terminar.</p>}
          {o.estado === 'lista' && <p className="mt-2 text-xs text-tenue">La entrega al cliente la registra el mostrador.</p>}
        </Tarjeta>
      )}
      {!puedeEditar && !cerrada && <Aviso tono="ambar" className="mb-4">Podés ver esta orden pero no actualizarla. Pedile a recepción que te habilite el permiso o que la asigne a tu nombre.</Aviso>}
      {cerrada && <Aviso className="mb-4">La orden está {ESTADO_OT_LABEL[o.estado as EstadoOT].toLowerCase()}: ya no admite cambios.</Aviso>}

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          <Tarjeta titulo="Tareas" subtitulo="Empezá una tarea para que corra el cronómetro; terminala cuando esté lista">
            <Tareas orden={o} puedeEditar={puedeEditar} grande />
          </Tarjeta>
          <Tarjeta titulo="Diagnóstico, resultado y observaciones"><NotasTecnicas orden={o} puedeEditar={puedeEditar} grande /></Tarjeta>
        </div>
        <div className="space-y-4 lg:col-span-2">
          <Tarjeta titulo="Vehículo y pedido">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div><dt className="text-xs text-tenue">Patente</dt><dd className="text-lg font-bold tracking-wide">{o.patente}</dd></div>
              <div><dt className="text-xs text-tenue">Kilometraje de ingreso</dt><dd>{km(o.km_ingreso)}</dd></div>
              {o.cliente && <div className="col-span-2"><dt className="text-xs text-tenue">Cliente</dt><dd>{o.cliente}{o.cliente_telefono ? ` · ${o.cliente_telefono}` : ''}</dd></div>}
              <div className="col-span-2"><dt className="text-xs text-tenue">Falla reportada</dt><dd className="whitespace-pre-wrap">{o.falla_reportada || '—'}</dd></div>
              {o.observaciones && <div className="col-span-2"><dt className="text-xs text-tenue">Observaciones de recepción</dt><dd className="whitespace-pre-wrap">{o.observaciones}</dd></div>}
              {o.fecha_prometida && <div className="col-span-2"><dt className="text-xs text-tenue">Fecha prometida</dt><dd>{fecha(o.fecha_prometida)}</dd></div>}
            </dl>
            {c && (c.datos.danos?.length > 0 || c.datos.testigos?.length > 0 || c.observaciones) && (
              <div className="mt-3 space-y-1 border-t border-borde pt-3 text-sm">
                {c.datos.danos?.length > 0 && <p><span className="text-xs text-tenue">Daños al ingresar: </span>{c.datos.danos.join(', ')}</p>}
                {c.datos.testigos?.length > 0 && <p><span className="text-xs text-tenue">Testigos encendidos: </span>{c.datos.testigos.join(', ')}</p>}
                {c.observaciones && <p><span className="text-xs text-tenue">Observaciones del ingreso: </span>{c.observaciones}</p>}
              </div>
            )}
            <div className="mt-3 border-t border-borde pt-3"><EquipoOrden orden={o} puedeAsignar={false} /></div>
            {puede('vehiculos.ver') && <Link to={`/vehiculos/${o.vehiculo_id}`} className="mt-3 block text-sm font-medium text-marca-700">Ver historial técnico del vehículo →</Link>}
          </Tarjeta>

          <Tarjeta titulo="Tiempo dedicado"><Cronometro orden={o} puedeEditar={puedeEditar} grande /></Tarjeta>

          <Tarjeta titulo={`Repuestos requeridos${repuestos.length ? ` (${repuestos.length})` : ''}`}>
            {repuestos.length === 0 ? <p className="text-sm text-tenue">Esta orden no lleva repuestos.</p> : (
              <ul className="divide-y divide-borde">
                {repuestos.map((i: any) => (
                  <li key={i.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <span className="flex min-w-0 items-center gap-2"><Package className="size-4 shrink-0 text-tenue" /><span className="truncate">{i.descripcion}</span></span>
                    <span className="flex shrink-0 items-center gap-2">
                      <strong className="tabular-nums">{i.cantidad} {i.unidad && i.unidad !== 'un' ? i.unidad : ''}</strong>
                      {o.stock_aplicado ? <Insignia tono="gris">Descontado</Insignia> : i.articulo_stock != null && <Insignia tono={i.articulo_stock >= i.cantidad ? 'verde' : 'rojo'}>{i.articulo_stock >= i.cantidad ? 'Hay stock' : 'Falta stock'}</Insignia>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Tarjeta>

          {trabajos.length > 0 && (
            <Tarjeta titulo="Trabajos a realizar">
              <ul className="list-disc space-y-1 pl-5 text-sm">{trabajos.map((i: any) => <li key={i.id}>{i.descripcion}{i.cantidad !== 1 ? ` ×${i.cantidad}` : ''}{i.tiempo_min ? ` · ${formatearMinutos(Math.round(i.tiempo_min * i.cantidad))}` : ''}</li>)}</ul>
            </Tarjeta>
          )}
        </div>
      </div>

      {puedeEditar && (
        <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 border-t border-borde bg-white/95 px-4 py-2.5 backdrop-blur lg:bottom-6 lg:left-auto lg:right-6 lg:w-auto lg:rounded-card lg:border lg:shadow-lg">
          <Boton variante="primario" tam="lg" className="h-12 w-full lg:w-auto" icono={<PencilLine className="size-5" />} onClick={() => setNota(true)}>Observación rápida</Boton>
        </div>
      )}
      <NotaRapida orden={o} abierto={nota} onCerrar={() => setNota(false)} />
    </div>
  );
}
