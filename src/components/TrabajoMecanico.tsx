// Trabajo del mecánico en una orden: tareas, observaciones técnicas y tiempo dedicado a la reparación.
// El tiempo de reparación (por OT) es independiente de las horas de asistencia al taller.
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Pause, Play, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { duracion, fechaHora } from '@/lib/format';
import { Boton, cn, Input, Insignia, Textarea, useToast } from './ui';

export function useRefrescarOrden(id: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['orden', id] });
    qc.invalidateQueries({ queryKey: ['ordenes'] });
  };
}

export function Tareas({ orden, puedeEditar }: { orden: any; puedeEditar: boolean }) {
  const toast = useToast();
  const refrescar = useRefrescarOrden(orden.id);
  const [nueva, setNueva] = useState('');
  const marcar = useMutation({
    mutationFn: ({ id, hecha }: { id: string; hecha: boolean }) => api.patch(`/ordenes/${orden.id}/tareas/${id}`, { hecha }),
    onSuccess: refrescar,
    onError: toast.error,
  });
  const agregar = useMutation({
    mutationFn: () => api.post(`/ordenes/${orden.id}/tareas`, { descripcion: nueva }),
    onSuccess: () => { setNueva(''); refrescar(); },
    onError: toast.error,
  });
  const quitar = useMutation({ mutationFn: (id: string) => api.del(`/ordenes/${orden.id}/tareas/${id}`), onSuccess: refrescar, onError: toast.error });
  const hechas = orden.tareas.filter((t: any) => t.hecha).length;
  return (
    <div className="space-y-3">
      {orden.tareas.length > 0 && <p className="text-xs text-tenue">{hechas} de {orden.tareas.length} tareas hechas</p>}
      <ul className="space-y-2">
        {orden.tareas.map((t: any) => (
          <li key={t.id} className="flex items-center gap-3 rounded-xl border border-borde bg-white px-3 py-3">
            <button
              type="button" disabled={!puedeEditar || marcar.isPending} onClick={() => marcar.mutate({ id: t.id, hecha: !t.hecha })}
              aria-label={t.hecha ? 'Marcar como pendiente' : 'Marcar como hecha'} aria-pressed={!!t.hecha}
              className={cn('grid size-8 shrink-0 place-items-center rounded-lg border-2 transition', t.hecha ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-300 bg-white text-transparent', puedeEditar && !t.hecha && 'hover:border-emerald-400')}
            >
              <Check className="size-5" />
            </button>
            <div className="min-w-0 flex-1">
              <p className={cn('text-[15px]', t.hecha && 'text-tenue line-through')}>{t.descripcion}</p>
              {t.hecha ? <p className="text-xs text-tenue">{t.hecha_por ? `${t.hecha_por} · ` : ''}{fechaHora(t.hecha_at)}</p> : null}
            </div>
            {puedeEditar && <Boton variante="fantasma" tam="sm" icono={<Trash2 className="size-4" />} aria-label="Quitar tarea" onClick={() => quitar.mutate(t.id)} />}
          </li>
        ))}
      </ul>
      {orden.tareas.length === 0 && <p className="text-sm text-tenue">Todavía no hay tareas cargadas.</p>}
      {puedeEditar && (
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (nueva.trim().length >= 2) agregar.mutate(); }}>
          <Input value={nueva} onChange={(e) => setNueva(e.target.value)} placeholder="Agregar una tarea (ej.: cambiar pastillas)" className="h-11" />
          <Boton type="submit" variante="primario" className="h-11" icono={<Plus className="size-4" />} cargando={agregar.isPending} disabled={nueva.trim().length < 2}>Agregar</Boton>
        </form>
      )}
    </div>
  );
}

export function NotasTecnicas({ orden, puedeEditar }: { orden: any; puedeEditar: boolean }) {
  const toast = useToast();
  const refrescar = useRefrescarOrden(orden.id);
  const [texto, setTexto] = useState('');
  const [diag, setDiag] = useState<string>(orden.diagnostico ?? '');
  useEffect(() => setDiag(orden.diagnostico ?? ''), [orden.diagnostico, orden.version]);
  const nota = useMutation({ mutationFn: () => api.post(`/ordenes/${orden.id}/notas`, { texto }), onSuccess: () => { setTexto(''); refrescar(); }, onError: toast.error });
  const guardarDiag = useMutation({ mutationFn: () => api.patch(`/ordenes/${orden.id}/tecnico`, { diagnostico: diag }), onSuccess: () => { toast.ok('Diagnóstico guardado'); refrescar(); }, onError: toast.error });
  return (
    <div className="space-y-5">
      <div>
        <h3 className="mb-1.5 text-sm font-semibold">Diagnóstico</h3>
        {puedeEditar ? (
          <>
            <Textarea rows={3} value={diag} onChange={(e) => setDiag(e.target.value)} placeholder="Qué se encontró y qué hay que hacer" />
            <div className="mt-2 flex justify-end"><Boton variante="primario" tam="sm" cargando={guardarDiag.isPending} disabled={diag === (orden.diagnostico ?? '')} onClick={() => guardarDiag.mutate()}>Guardar diagnóstico</Boton></div>
          </>
        ) : <p className="whitespace-pre-wrap text-sm">{orden.diagnostico || <span className="text-tenue">Sin diagnóstico cargado.</span>}</p>}
      </div>
      <div>
        <h3 className="mb-1.5 text-sm font-semibold">Observaciones técnicas</h3>
        {puedeEditar && (
          <form className="mb-3 space-y-2" onSubmit={(e) => { e.preventDefault(); if (texto.trim().length >= 2) nota.mutate(); }}>
            <Textarea rows={2} value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Ej.: los discos tienen desgaste, avisar a recepción" />
            <div className="flex justify-end"><Boton type="submit" tam="sm" variante="primario" cargando={nota.isPending} disabled={texto.trim().length < 2}>Agregar observación</Boton></div>
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
export function Cronometro({ orden, puedeEditar }: { orden: any; puedeEditar: boolean }) {
  const toast = useToast();
  const refrescar = useRefrescarOrden(orden.id);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const marcha = orden.mi_cronometro as { inicio_at: string } | null;
  const accion = useMutation({
    mutationFn: (a: 'iniciar' | 'detener') => api.post(`/ordenes/${orden.id}/tiempo/${a}`),
    onSuccess: (_r, a) => { refrescar(); toast.ok(a === 'iniciar' ? 'Cronómetro en marcha' : 'Tiempo registrado'); },
    onError: toast.error,
  });
  const propio = marcha ? Math.max(0, Math.floor((Date.now() - Date.parse(marcha.inicio_at)) / 1000)) : 0;
  const porPersona = new Map<string, number>();
  for (const t of orden.tiempos as any[]) porPersona.set(t.usuario, (porPersona.get(t.usuario) ?? 0) + (t.duracion_seg ?? 0));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs text-tenue">Tiempo total dedicado a esta reparación</p>
          <p className="text-2xl font-bold tabular-nums">{duracion(orden.tiempo_total_seg + propio)}</p>
        </div>
        {puedeEditar && (marcha
          ? <Boton variante="peligro" tam="lg" icono={<Pause className="size-5" />} cargando={accion.isPending} onClick={() => accion.mutate('detener')}>Detener ({duracion(propio)})</Boton>
          : <Boton variante="exito" tam="lg" icono={<Play className="size-5" />} cargando={accion.isPending} onClick={() => accion.mutate('iniciar')}>Empezar a trabajar</Boton>)}
      </div>
      {porPersona.size > 0 && (
        <ul className="flex flex-wrap gap-2">{[...porPersona].map(([u, s]) => <li key={u}><Insignia>{u}: {duracion(s)}</Insignia></li>)}</ul>
      )}
    </div>
  );
}
