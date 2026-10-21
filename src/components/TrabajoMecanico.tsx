// Trabajo del mecánico en una orden: tareas con estado, responsable y tiempos, equipo, observaciones técnicas y cronómetro.
// El tiempo de reparación (por OT y por tarea) es independiente de las horas de asistencia al taller.
import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronUp, Clock, MessageSquarePlus, Pause, Play, Plus, RotateCcw, Trash2, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { duracion, fechaHora } from '@/lib/format';
import { formatearMinutos, ESTADO_TAREA_LABEL, type EstadoTarea } from '@shared/tempario';
import { Boton, Campo, cn, Input, Insignia, Select, Textarea, useToast, type Tono } from './ui';
import { useMecanicos } from './selectores';

export function useRefrescarOrden(id: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['orden', id] });
    qc.invalidateQueries({ queryKey: ['ordenes'] });
    qc.invalidateQueries({ queryKey: ['cronometro-activo'] });
    qc.invalidateQueries({ queryKey: ['productividad'] });
  };
}

/** Segundos transcurridos desde un instante (se actualiza solo cada segundo mientras el componente está montado). */
export function useSegundosDesde(inicio?: string | null) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!inicio) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [inicio]);
  return inicio ? Math.max(0, Math.floor((Date.now() - Date.parse(inicio)) / 1000)) : 0;
}

/** Reloj "h:mm:ss" para mostrar un cronómetro en marcha. */
export function relojHMS(seg: number): string {
  const h = Math.floor(seg / 3600);
  const m = Math.floor((seg % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(seg % 60).padStart(2, '0')}`;
}

const TONO_ESTADO: Record<EstadoTarea, Tono> = { pendiente: 'gris', en_proceso: 'azul', pausada: 'ambar', completada: 'verde' };

interface TareaApi {
  id: string;
  descripcion: string;
  estado: EstadoTarea;
  responsable_id: string | null;
  responsable: string | null;
  tiempo_estimado_min: number | null;
  tiempo_cerrado_seg: number;
  en_marcha: Array<{ usuario_id: string; usuario: string; inicio_at: string }>;
  observaciones: string | null;
  hecha_at: string | null;
  hecha_por: string | null;
}

/** Tiempo real de una tarea con el tramo en marcha corriendo en vivo. */
function useTiempoReal(t: TareaApi): number {
  const inicio = t.en_marcha[0]?.inicio_at ?? null;
  useSegundosDesde(inicio);
  const ahora = Date.now();
  return t.tiempo_cerrado_seg + t.en_marcha.reduce((a, x) => a + Math.max(0, Math.floor((ahora - Date.parse(x.inicio_at)) / 1000)), 0);
}

function TareaTarjeta({ orden, t, puedeEditar, puedeAsignar, grande, personas }: { orden: any; t: TareaApi; puedeEditar: boolean; puedeAsignar: boolean; grande: boolean; personas: Array<{ id: string; nombre: string }> }) {
  const toast = useToast();
  const refrescar = useRefrescarOrden(orden.id);
  const real = useTiempoReal(t);
  const [nota, setNota] = useState(false);
  const [obs, setObs] = useState(t.observaciones ?? '');
  useEffect(() => setObs(t.observaciones ?? ''), [t.observaciones]);
  const miCrono = orden.mi_cronometro as { inicio_at: string; tarea_id: string | null } | null;
  const trabajandoEsta = miCrono?.tarea_id === t.id;
  const onError = toast.error;

  const cambiar = useMutation({ mutationFn: (d: Record<string, unknown>) => api.patch(`/ordenes/${orden.id}/tareas/${t.id}`, d), onSuccess: refrescar, onError });
  // Empezar o retomar: arranca el cronómetro de la OT atribuido a esta tarea (si estaba otro tramo propio en esta OT, lo cierra antes).
  const empezar = useMutation({
    mutationFn: async () => {
      if (miCrono) await api.post(`/ordenes/${orden.id}/tiempo/detener`, { pausar_tarea: true });
      return api.post(`/ordenes/${orden.id}/tiempo/iniciar`, { tarea_id: t.id });
    },
    onSuccess: () => { refrescar(); toast.ok('Cronómetro en marcha'); },
    onError,
  });
  const pausar = useMutation({
    mutationFn: () => (trabajandoEsta ? api.post(`/ordenes/${orden.id}/tiempo/detener`, { pausar_tarea: true }) : api.patch(`/ordenes/${orden.id}/tareas/${t.id}`, { estado: 'pausada' })),
    onSuccess: refrescar,
    onError,
  });
  const quitar = useMutation({ mutationFn: () => api.del(`/ordenes/${orden.id}/tareas/${t.id}`), onSuccess: refrescar, onError });
  const guardarNota = useMutation({ mutationFn: () => api.patch(`/ordenes/${orden.id}/tareas/${t.id}`, { observaciones: obs }), onSuccess: () => { refrescar(); toast.ok('Observación guardada'); setNota(false); }, onError });
  const ocupado = cambiar.isPending || empezar.isPending || pausar.isPending;
  const altura = grande ? 'h-14 text-base' : 'h-11 text-sm';
  const excede = t.tiempo_estimado_min ? real > t.tiempo_estimado_min * 60 : false;

  return (
    <li className={cn('rounded-2xl border bg-white p-3.5 shadow-sm', t.estado === 'en_proceso' ? 'border-marca-300 ring-2 ring-marca-100' : 'border-borde', t.estado === 'completada' && 'bg-slate-50')}>
      <div className="flex items-start justify-between gap-2">
        <p className={cn('min-w-0 flex-1 text-[15px] font-medium leading-snug', t.estado === 'completada' && 'text-tenue line-through')}>{t.descripcion}</p>
        <Insignia tono={TONO_ESTADO[t.estado]}>{ESTADO_TAREA_LABEL[t.estado]}</Insignia>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-tenue">
        <span className="inline-flex items-center gap-1"><Users className="size-3.5" />{t.responsable ?? 'Sin responsable'}</span>
        {t.tiempo_estimado_min ? <span className="inline-flex items-center gap-1"><Clock className="size-3.5" />Estimado {formatearMinutos(t.tiempo_estimado_min)}</span> : null}
        {(real > 0 || t.en_marcha.length > 0) && (
          <span className={cn('inline-flex items-center gap-1 font-medium tabular-nums', t.en_marcha.length ? 'text-marca-700' : excede ? 'text-amber-700' : 'text-texto')}>
            <Clock className="size-3.5" />Real {t.en_marcha.length ? relojHMS(real) : duracion(real)}
          </span>
        )}
        {t.estado === 'completada' && t.hecha_at && <span>Terminada {fechaHora(t.hecha_at)}{t.hecha_por ? ` · ${t.hecha_por}` : ''}</span>}
      </div>
      {t.observaciones && !nota && <p className="mt-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-sm whitespace-pre-wrap">{t.observaciones}</p>}

      {puedeEditar && (
        <div className="mt-3 flex flex-wrap gap-2">
          {(t.estado === 'pendiente' || t.estado === 'pausada') && (
            <Boton variante="exito" className={cn('flex-1 min-w-32', altura)} icono={<Play className="size-5" />} cargando={empezar.isPending} disabled={ocupado} onClick={() => empezar.mutate()}>
              {t.estado === 'pausada' ? 'Retomar' : 'Empezar'}
            </Boton>
          )}
          {t.estado === 'en_proceso' && (
            <Boton variante="secundario" className={cn('flex-1 min-w-32', altura)} icono={<Pause className="size-5" />} cargando={pausar.isPending} disabled={ocupado} onClick={() => pausar.mutate()}>
              Pausar
            </Boton>
          )}
          {t.estado !== 'completada' && (
            <Boton variante="primario" className={cn('flex-1 min-w-32', altura)} icono={<Check className="size-5" />} cargando={cambiar.isPending} disabled={ocupado} onClick={() => cambiar.mutate({ estado: 'completada' })}>
              Terminar
            </Boton>
          )}
          {t.estado === 'completada' && (
            <Boton className={cn('min-w-32', altura)} icono={<RotateCcw className="size-4" />} disabled={ocupado} onClick={() => cambiar.mutate({ estado: 'pendiente' })}>Reabrir</Boton>
          )}
          <Boton className={altura} icono={<MessageSquarePlus className="size-5" />} onClick={() => setNota((v) => !v)} aria-label="Observación de la tarea" aria-expanded={nota}>Nota</Boton>
        </div>
      )}

      {nota && (
        <div className="mt-3 space-y-2">
          <Textarea rows={3} value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Observación técnica de esta tarea" autoFocus />
          <div className="flex justify-end gap-2">
            <Boton tam="sm" onClick={() => { setNota(false); setObs(t.observaciones ?? ''); }}>Cancelar</Boton>
            <Boton tam="sm" variante="primario" cargando={guardarNota.isPending} onClick={() => guardarNota.mutate()}>Guardar</Boton>
          </div>
        </div>
      )}

      {puedeAsignar && t.estado !== 'completada' && (
        <div className="mt-3 grid gap-2 border-t border-borde pt-3 sm:grid-cols-[1fr_9rem_auto]">
          <Select aria-label="Responsable de la tarea" value={t.responsable_id ?? ''} onChange={(e) => cambiar.mutate({ responsable_id: e.target.value || null })} className="h-9">
            <option value="">Sin responsable</option>
            {personas.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </Select>
          <label className="flex items-center gap-1.5 text-xs text-tenue">
            Estimado (min)
            <Input type="number" min={0} className="h-9 w-20 text-right" defaultValue={t.tiempo_estimado_min ?? ''} key={t.tiempo_estimado_min ?? 'x'}
              onBlur={(e) => { const v = e.target.value === '' ? null : Math.max(0, Math.round(Number(e.target.value))); if (v !== (t.tiempo_estimado_min ?? null)) cambiar.mutate({ tiempo_estimado_min: v }); }} />
          </label>
          <Boton variante="fantasma" tam="sm" icono={<Trash2 className="size-4 text-red-600" />} aria-label="Quitar tarea" onClick={() => quitar.mutate()} />
        </div>
      )}
    </li>
  );
}

/** Personas que pueden recibir tareas: el personal vinculado a un mecánico activo de la orden. */
function usePersonasAsignables(habilitado: boolean) {
  const { data: mecanicos = [] } = useMecanicos(habilitado);
  return mecanicos.filter((m: any) => m.usuario_id && m.activo).map((m: any) => ({ id: m.usuario_id as string, nombre: m.nombre as string }));
}

function Grupo({ titulo, cantidad, children, tono }: { titulo: string; cantidad: number; children: ReactNode; tono?: Tono }) {
  if (!cantidad) return null;
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">{titulo} <Insignia tono={tono}>{cantidad}</Insignia></h3>
      <ul className="space-y-2.5">{children}</ul>
    </section>
  );
}

/** Tareas de la orden agrupadas en: en curso, pendientes (incluye las pausadas) y finalizadas. */
export function Tareas({ orden, puedeEditar, puedeAsignar = false, grande = false }: { orden: any; puedeEditar: boolean; puedeAsignar?: boolean; grande?: boolean }) {
  const toast = useToast();
  const refrescar = useRefrescarOrden(orden.id);
  const personas = usePersonasAsignables(puedeAsignar);
  const [nueva, setNueva] = useState('');
  const [verFin, setVerFin] = useState(false);
  const tareas = orden.tareas as TareaApi[];
  const enCurso = tareas.filter((t) => t.estado === 'en_proceso');
  const pendientes = tareas.filter((t) => t.estado === 'pendiente' || t.estado === 'pausada');
  const fin = tareas.filter((t) => t.estado === 'completada');
  const agregar = useMutation({
    mutationFn: () => api.post(`/ordenes/${orden.id}/tareas`, { descripcion: nueva }),
    onSuccess: () => { setNueva(''); refrescar(); },
    onError: toast.error,
  });
  const desdeTrabajos = useMutation({
    mutationFn: () => api.post<{ creadas: number }>(`/ordenes/${orden.id}/tareas/desde-trabajos`),
    onSuccess: (r) => { refrescar(); toast.ok(r.creadas ? `${r.creadas} tarea${r.creadas > 1 ? 's' : ''} creada${r.creadas > 1 ? 's' : ''} desde los trabajos` : 'Todos los trabajos ya tienen su tarea'); },
    onError: toast.error,
  });
  const hay = (a: TareaApi[]) => a.map((t) => <TareaTarjeta key={t.id} orden={orden} t={t} puedeEditar={puedeEditar} puedeAsignar={puedeAsignar} grande={grande} personas={personas} />);
  const estimado = tareas.reduce((a, t) => a + (t.tiempo_estimado_min ?? 0), 0);
  return (
    <div className="space-y-4">
      {tareas.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span><strong>{fin.length}</strong> de {tareas.length} terminadas</span>
          {estimado > 0 && <span className="text-tenue">Tiempo estimado total: {formatearMinutos(estimado)}</span>}
          <div className="h-2 min-w-24 flex-1 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-emerald-500 transition-all" style={{ width: `${Math.round((fin.length / tareas.length) * 100)}%` }} /></div>
        </div>
      )}
      <Grupo titulo="En curso" cantidad={enCurso.length} tono="azul">{hay(enCurso)}</Grupo>
      <Grupo titulo="Pendientes" cantidad={pendientes.length} tono="gris">{hay(pendientes)}</Grupo>
      {fin.length > 0 && (
        <div>
          <button type="button" className="mb-2 flex items-center gap-2 text-sm font-semibold" onClick={() => setVerFin((v) => !v)} aria-expanded={verFin}>
            Finalizadas <Insignia tono="verde">{fin.length}</Insignia>{verFin ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </button>
          {verFin && <ul className="space-y-2.5">{hay(fin)}</ul>}
        </div>
      )}
      {tareas.length === 0 && <p className="text-sm text-tenue">Todavía no hay tareas cargadas.</p>}
      {puedeEditar && (
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (nueva.trim().length >= 2) agregar.mutate(); }}>
          <Input value={nueva} onChange={(e) => setNueva(e.target.value)} placeholder="Agregar una tarea (ej.: cambiar pastillas)" className={grande ? 'h-12' : 'h-11'} />
          <Boton type="submit" variante="primario" className={grande ? 'h-12' : 'h-11'} icono={<Plus className="size-4" />} cargando={agregar.isPending} disabled={nueva.trim().length < 2}>Agregar</Boton>
        </form>
      )}
      {puedeEditar && orden.items?.some((i: any) => i.tipo === 'servicio') && (
        <Boton tam="sm" cargando={desdeTrabajos.isPending} onClick={() => desdeTrabajos.mutate()}>Crear tareas desde los trabajos de la orden</Boton>
      )}
    </div>
  );
}

/** Responsable y participantes de la orden. Asignar no requiere permisos de precios ni de importes. */
export function EquipoOrden({ orden, puedeAsignar }: { orden: any; puedeAsignar: boolean }) {
  const toast = useToast();
  const refrescar = useRefrescarOrden(orden.id);
  const { data: mecanicos = [] } = useMecanicos(puedeAsignar);
  const participantes: Array<{ usuario_id: string; nombre: string }> = orden.participantes ?? [];
  const ids = new Set(participantes.map((p) => p.usuario_id));
  const responsable = useMutation({ mutationFn: (mecanico_id: string | null) => api.patch(`/ordenes/${orden.id}/responsable`, { mecanico_id }), onSuccess: () => { refrescar(); toast.ok('Responsable actualizado'); }, onError: toast.error });
  const guardar = useMutation({ mutationFn: (usuario_ids: string[]) => api.put(`/ordenes/${orden.id}/participantes`, { usuario_ids }), onSuccess: refrescar, onError: toast.error });
  const candidatos = mecanicos.filter((m: any) => m.usuario_id && m.activo && m.usuario_id !== orden.mecanico_usuario_id);
  const alternar = (uid: string) => guardar.mutate(ids.has(uid) ? [...ids].filter((x) => x !== uid) : [...ids, uid]);
  if (!puedeAsignar) {
    return (
      <p className="text-sm">
        <span className="text-tenue">Responsable:</span> <strong>{orden.mecanico ?? 'Sin asignar'}</strong>
        {participantes.length > 0 && <> · <span className="text-tenue">Participan:</span> {participantes.map((p) => p.nombre).join(', ')}</>}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <Campo label="Mecánico responsable">
        <Select value={orden.mecanico_id ?? ''} onChange={(e) => responsable.mutate(e.target.value || null)} disabled={responsable.isPending}>
          <option value="">Sin asignar</option>
          {mecanicos.filter((m: any) => m.activo || m.id === orden.mecanico_id).map((m: any) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
        </Select>
      </Campo>
      <div>
        <p className="mb-1.5 text-[13px] font-medium">Otros participantes</p>
        {candidatos.length === 0 ? <p className="text-sm text-tenue">No hay más personal vinculado a mecánicos.</p> : (
          <div className="flex flex-wrap gap-2">
            {candidatos.map((m: any) => {
              const on = ids.has(m.usuario_id);
              return (
                <button key={m.id} type="button" disabled={guardar.isPending} aria-pressed={on} onClick={() => alternar(m.usuario_id)}
                  className={cn('rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors', on ? 'border-marca-300 bg-marca-50 text-marca-700' : 'border-borde bg-white text-tenue hover:bg-slate-50')}>
                  {on ? '✓ ' : ''}{m.nombre}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function NotasTecnicas({ orden, puedeEditar, grande = false }: { orden: any; puedeEditar: boolean; grande?: boolean }) {
  const toast = useToast();
  const refrescar = useRefrescarOrden(orden.id);
  const [texto, setTexto] = useState('');
  const [diag, setDiag] = useState<string>(orden.diagnostico ?? '');
  const [res, setRes] = useState<string>(orden.resultado ?? '');
  useEffect(() => setDiag(orden.diagnostico ?? ''), [orden.diagnostico, orden.version]);
  useEffect(() => setRes(orden.resultado ?? ''), [orden.resultado, orden.version]);
  const nota = useMutation({ mutationFn: () => api.post(`/ordenes/${orden.id}/notas`, { texto }), onSuccess: () => { setTexto(''); refrescar(); toast.ok('Observación guardada'); }, onError: toast.error });
  const guardar = useMutation({ mutationFn: (d: { diagnostico?: string; resultado?: string }) => api.patch(`/ordenes/${orden.id}/tecnico`, d), onSuccess: () => { toast.ok('Guardado'); refrescar(); }, onError: toast.error });
  const campo = (titulo: string, valor: string, set: (v: string) => void, original: string, clave: 'diagnostico' | 'resultado', ayuda: string, vacio: string) => (
    <div>
      <h3 className="mb-1.5 text-sm font-semibold">{titulo}</h3>
      {puedeEditar ? (
        <>
          <Textarea rows={grande ? 4 : 3} value={valor} onChange={(e) => set(e.target.value)} placeholder={ayuda} className={grande ? 'text-base' : ''} />
          <div className="mt-2 flex justify-end"><Boton variante="primario" tam={grande ? 'md' : 'sm'} cargando={guardar.isPending} disabled={valor === original} onClick={() => guardar.mutate({ [clave]: valor })}>Guardar</Boton></div>
        </>
      ) : <p className="whitespace-pre-wrap text-sm">{original || <span className="text-tenue">{vacio}</span>}</p>}
    </div>
  );
  return (
    <div className="space-y-5">
      {campo('Diagnóstico', diag, setDiag, orden.diagnostico ?? '', 'diagnostico', 'Qué se encontró y qué hay que hacer', 'Sin diagnóstico cargado.')}
      {campo('Resultado del trabajo', res, setRes, orden.resultado ?? '', 'resultado', 'Cómo quedó: qué se hizo, pruebas realizadas, recomendaciones', 'Todavía sin resultado cargado.')}
      <div>
        <h3 className="mb-1.5 text-sm font-semibold">Observaciones técnicas</h3>
        {puedeEditar && (
          <form className="mb-3 space-y-2" onSubmit={(e) => { e.preventDefault(); if (texto.trim().length >= 2) nota.mutate(); }}>
            <Textarea rows={2} value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Ej.: los discos tienen desgaste, avisar a recepción" className={grande ? 'text-base' : ''} />
            <div className="flex justify-end"><Boton type="submit" tam={grande ? 'md' : 'sm'} variante="primario" cargando={nota.isPending} disabled={texto.trim().length < 2}>Agregar observación</Boton></div>
          </form>
        )}
        {orden.notas.length === 0 ? <p className="text-sm text-tenue">Sin observaciones.</p> : (
          <ul className="space-y-2">
            {orden.notas.map((n: any) => (
              <li key={n.id} className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
                <p className="whitespace-pre-wrap">{n.texto}</p>
                <p className="mt-0.5 text-xs text-tenue">{n.usuario ?? '—'} · {fechaHora(n.created_at)}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Cronómetro de la reparación: suma el tiempo dedicado a la OT por cada persona (no se confunde con las horas de asistencia). */
export function Cronometro({ orden, puedeEditar, grande = false }: { orden: any; puedeEditar: boolean; grande?: boolean }) {
  const toast = useToast();
  const refrescar = useRefrescarOrden(orden.id);
  const marcha = orden.mi_cronometro as { inicio_at: string; tarea_id: string | null } | null;
  const propio = useSegundosDesde(marcha?.inicio_at);
  const tareaActual = marcha?.tarea_id ? (orden.tareas as TareaApi[]).find((t) => t.id === marcha.tarea_id) : null;
  const accion = useMutation({
    mutationFn: (a: 'iniciar' | 'detener') => api.post(`/ordenes/${orden.id}/tiempo/${a}`),
    onSuccess: (_r, a) => { refrescar(); toast.ok(a === 'iniciar' ? 'Cronómetro en marcha' : 'Tiempo registrado'); },
    onError: toast.error,
  });
  const porPersona = new Map<string, number>();
  for (const t of orden.tiempos as any[]) porPersona.set(t.usuario, (porPersona.get(t.usuario) ?? 0) + (t.duracion_seg ?? 0));
  const estimado = orden.tiempo_estimado_total_min as number | undefined;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs text-tenue">Tiempo total dedicado a esta reparación{estimado ? ` · estimado ${formatearMinutos(estimado)}` : ''}</p>
          <p className="text-2xl font-bold tabular-nums">{duracion(orden.tiempo_total_seg + propio)}</p>
          {marcha && <p className="text-sm text-marca-700">En marcha: {relojHMS(propio)}{tareaActual ? ` · ${tareaActual.descripcion}` : ''}</p>}
        </div>
        {puedeEditar && (marcha
          ? <Boton variante="peligro" tam="lg" className={grande ? 'h-14' : ''} icono={<Pause className="size-5" />} cargando={accion.isPending} onClick={() => accion.mutate('detener')}>Detener ({relojHMS(propio)})</Boton>
          : <Boton variante="exito" tam="lg" className={grande ? 'h-14' : ''} icono={<Play className="size-5" />} cargando={accion.isPending} onClick={() => accion.mutate('iniciar')}>Empezar a trabajar</Boton>)}
      </div>
      {porPersona.size > 0 && (
        <ul className="flex flex-wrap gap-2">{[...porPersona].map(([u, s]) => <li key={u}><Insignia>{u}: {duracion(s)}</Insignia></li>)}</ul>
      )}
    </div>
  );
}

/** Barra con el cronómetro propio en marcha (en cualquier orden): siempre a un toque de detenerlo. */
export function BarraCronometro() {
  const { data } = useQuery({ queryKey: ['cronometro-activo'], queryFn: () => api.get<any | null>('/ordenes/cronometro/activo'), refetchInterval: 30_000 });
  const qc = useQueryClient();
  const toast = useToast();
  const seg = useSegundosDesde(data?.inicio_at);
  const detener = useMutation({
    mutationFn: () => api.post(`/ordenes/${data.orden_id}/tiempo/detener`, { pausar_tarea: true }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['cronometro-activo'] }); qc.invalidateQueries({ queryKey: ['orden'] }); qc.invalidateQueries({ queryKey: ['ordenes'] }); toast.ok('Tiempo registrado'); },
    onError: toast.error,
  });
  if (!data) return null;
  return (
    <div className="sticky top-0 z-20 -mx-4 mb-3 flex items-center justify-between gap-3 border-b border-marca-200 bg-marca-50/95 px-4 py-2 backdrop-blur md:mx-0 md:rounded-xl md:border">
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-lg font-bold tabular-nums text-marca-800"><Clock className="size-5" />{relojHMS(seg)}</p>
        <p className="truncate text-xs text-marca-800">OT #{String(data.orden_numero).padStart(4, '0')} · {data.patente}{data.tarea ? ` · ${data.tarea}` : ''}</p>
      </div>
      <Boton variante="peligro" className="h-11 shrink-0" icono={<Pause className="size-5" />} cargando={detener.isPending} onClick={() => detener.mutate()}>Detener</Boton>
    </div>
  );
}
