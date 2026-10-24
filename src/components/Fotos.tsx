// Fotografías de vehículos y órdenes de trabajo: cámara / galería, compresión en el navegador, cola de subida con reintento y galerías con miniaturas.
// Las imágenes se piden a endpoints con sesión (cookie): no hay enlaces públicos. Los listados sólo bajan miniaturas; la foto completa se baja al ampliarla.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, ChevronLeft, ChevronRight, Images, RotateCcw, Trash2, X } from 'lucide-react';
import { api, nuevaClave } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fechaHora } from '@/lib/format';
import { prepararFoto, subirFoto, type CamposSubida, type FotoPreparada } from '@/lib/imagen';
import { Aviso, Boton, Cargando, Chip, ErrorCaja, Input, Modal, cn, useConfirmar, useToast } from './ui';

export type Etapa = 'recepcion' | 'reparacion' | 'entrega';
export const ETAPAS: Array<{ clave: Etapa; titulo: string }> = [
  { clave: 'recepcion', titulo: 'Recepción' },
  { clave: 'reparacion', titulo: 'Reparación' },
  { clave: 'entrega', titulo: 'Entrega' },
];
const ETAPA_TITULO: Record<string, string> = Object.fromEntries(ETAPAS.map((e) => [e.clave, e.titulo]));
const MAX_POR_VEZ = 12;
/** Estos campos pueden estar dentro del formulario de un vehículo: Enter no debe guardarlo. */
const sinEnviar = (e: React.KeyboardEvent) => e.key === 'Enter' && e.preventDefault();

export interface FotoApi {
  id: string;
  vehiculo_id: string;
  orden_id: string | null;
  orden_numero: number | null;
  etapa: Etapa | null;
  descripcion: string | null;
  ancho: number;
  alto: number;
  bytes: number;
  created_at: string;
  usuario: string | null;
}

export const urlMiniatura = (id: string) => `/api/fotos/${id}/miniatura`;
export const urlFoto = (id: string) => `/api/fotos/${id}/archivo`;

export function useEstadoFotos(activo = true) {
  return useQuery({ queryKey: ['fotos', 'estado'], queryFn: () => api.get<{ habilitado: boolean; usado_bytes: number; cantidad: number; limite_bytes: number }>('/fotos/estado'), enabled: activo, staleTime: 30_000 });
}

/** Qué puede hacer la persona con las fotos de un vehículo o de una OT (el servidor lo vuelve a comprobar). */
export function usePermisosFotos(opciones: { ordenId?: string | null; asignadaAMi?: boolean } = {}) {
  const { puede } = useAuth();
  const subirOrden = puede('ordenes.modificar') || puede('ordenes.crear') || (puede('ordenes.trabajar_asignadas') && !!opciones.asignadaAMi);
  const subirVehiculo = puede('vehiculos.crear') || puede('vehiculos.editar');
  return {
    ver: puede('fotos.ver'),
    subir: puede('fotos.subir') && (opciones.ordenId ? subirOrden : subirVehiculo),
    eliminar: puede('fotos.eliminar'),
  };
}

// ───────────── Cola local de fotos (antes de subir) ─────────────
export interface ItemFoto {
  clave: string; // también es la clave de reintento: subir otra vez la misma foto no la duplica
  estado: 'preparando' | 'lista' | 'subiendo' | 'subida' | 'error';
  progreso: number;
  error?: string;
  vista?: string;
  preparada?: FotoPreparada;
  descripcion: string;
  /** Id de la fotografía ya guardada en el servidor (para asociarla a un daño del checklist). */
  fotoId?: string;
}

export function useFotosLocales() {
  const [items, setItems] = useState<ItemFoto[]>([]);
  const ref = useRef<ItemFoto[]>([]);
  const guardadas = useRef<string[]>([]);
  ref.current = items;
  const parchar = (clave: string, p: Partial<ItemFoto>) => setItems((a) => a.map((i) => (i.clave === clave ? { ...i, ...p } : i)));
  useEffect(() => () => ref.current.forEach((i) => i.vista && URL.revokeObjectURL(i.vista)), []);

  const agregar = (archivos: File[]) => {
    const nuevos = archivos.slice(0, Math.max(0, MAX_POR_VEZ - ref.current.length)).map<ItemFoto>((f) => ({ clave: nuevaClave(), estado: 'preparando', progreso: 0, descripcion: '' }));
    setItems((a) => [...a, ...nuevos]);
    nuevos.forEach((n, i) => {
      const f = archivos[i];
      prepararFoto(f).then(
        (p) => parchar(n.clave, { estado: 'lista', preparada: p, vista: URL.createObjectURL(p.miniatura) }),
        (e) => parchar(n.clave, { estado: 'error', error: e instanceof Error ? e.message : 'No se pudo preparar la foto' }),
      );
    });
  };
  const quitar = (clave: string) =>
    setItems((a) => {
      a.find((i) => i.clave === clave)?.vista && URL.revokeObjectURL(a.find((i) => i.clave === clave)!.vista!);
      return a.filter((i) => i.clave !== clave);
    });
  const descripcion = (clave: string, texto: string) => parchar(clave, { descripcion: texto });

  /** Sube (o reintenta) lo que falta. Devuelve cuántas quedaron con error. */
  const subirTodas = async (campos: Omit<CamposSubida, 'idem_key' | 'descripcion'>): Promise<number> => {
    const cola = ref.current.filter((i) => i.estado === 'lista' || (i.estado === 'error' && i.preparada));
    let subidas = 0;
    for (const it of cola) {
      parchar(it.clave, { estado: 'subiendo', progreso: 0, error: undefined });
      try {
        const guardada = await subirFoto({ ...campos, descripcion: it.descripcion.trim() || undefined, idem_key: it.clave }, it.preparada!, (p) => parchar(it.clave, { progreso: p }));
        parchar(it.clave, { estado: 'subida', progreso: 100, fotoId: guardada?.id });
        if (guardada?.id) guardadas.current.push(guardada.id);
        subidas++;
      } catch (e) {
        parchar(it.clave, { estado: 'error', error: e instanceof Error ? e.message : 'No se pudo subir' });
        if (e && typeof e === 'object' && 'code' in e && ['sin_espacio', 'fotos_no_habilitadas', 'forbidden'].includes((e as { code: string }).code)) {
          break; // no tiene sentido seguir intentando con el resto
        }
      }
    }
    return cola.length - subidas;
  };
  const pendientes = items.filter((i) => i.estado !== 'subida').length;
  /** Ids de las fotos que ya quedaron guardadas (se lleva aparte del estado de React, que se actualiza recién en el próximo render). */
  const idsSubidas = () => [...guardadas.current];
  return { items, agregar, quitar, descripcion, subirTodas, pendientes, idsSubidas, ocupado: items.some((i) => i.estado === 'preparando' || i.estado === 'subiendo') };
}

// ───────────── Botones de cámara y galería ─────────────
export function BotonesCamara({ onArchivos, deshabilitado, className }: { onArchivos: (f: File[]) => void; deshabilitado?: boolean; className?: string }) {
  const camara = useRef<HTMLInputElement>(null);
  const galeria = useRef<HTMLInputElement>(null);
  const alElegir = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = Array.from(e.target.files ?? []);
    e.target.value = ''; // permite volver a elegir la misma foto
    if (f.length) onArchivos(f);
  };
  return (
    <div className={cn('grid grid-cols-2 gap-2', className)}>
      {/* capture="environment" abre la cámara trasera en celulares y tablets; si el navegador no lo soporta, ofrece elegir un archivo. */}
      <input ref={camara} type="file" accept="image/*" capture="environment" className="hidden" onChange={alElegir} />
      <input ref={galeria} type="file" accept="image/*" multiple className="hidden" onChange={alElegir} />
      <Boton variante="primario" tam="lg" className="h-14 text-base" icono={<Camera className="size-6" />} disabled={deshabilitado} onClick={() => camara.current?.click()}>
        Sacar foto
      </Boton>
      <Boton tam="lg" className="h-14 text-base" icono={<Images className="size-6" />} disabled={deshabilitado} onClick={() => galeria.current?.click()}>
        Elegir de galería
      </Boton>
    </div>
  );
}

// ───────────── Lista de fotos por subir ─────────────
export function ListaLocal({ items, onDescripcion, onQuitar, onReintentar, bloqueada }: { items: ItemFoto[]; onDescripcion: (c: string, t: string) => void; onQuitar: (c: string) => void; onReintentar?: () => void; bloqueada?: boolean }) {
  if (!items.length) return null;
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {items.map((i) => (
        <li key={i.clave} className="flex min-w-0 gap-2 rounded-card border border-borde bg-white p-2">
          <div className="relative size-20 shrink-0 overflow-hidden rounded-ctl bg-slate-100">
            {i.vista ? <img src={i.vista} alt="" className="size-full object-cover" /> : <span className="grid size-full place-items-center text-[11px] text-tenue">{i.estado === 'error' ? 'Error' : 'Preparando…'}</span>}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Input value={i.descripcion} onKeyDown={sinEnviar} onChange={(e) => onDescripcion(i.clave, e.target.value)} placeholder="Descripción (opcional)" maxLength={300} disabled={bloqueada || i.estado === 'subiendo' || i.estado === 'subida'} className="h-9" />
            {i.estado === 'subiendo' && (
              <div className="h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={i.progreso}>
                <div className="h-full bg-marca-500 transition-all" style={{ width: `${Math.max(6, i.progreso)}%` }} />
              </div>
            )}
            {i.estado === 'subida' && <p className="text-xs font-medium text-emerald-700">Guardada ✓</p>}
            {i.estado === 'error' && (
              <p className="break-words text-xs text-peligro-700">
                {i.error}
                {i.preparada && onReintentar && (
                  <button type="button" className="ml-1.5 inline-flex items-center gap-1 font-semibold underline" onClick={onReintentar}>
                    <RotateCcw className="size-3" /> Reintentar
                  </button>
                )}
              </p>
            )}
            {i.estado === 'lista' && i.preparada && <p className="text-xs text-tenue">{Math.round(i.preparada.blob.size / 1024)} KB · {i.preparada.ancho}×{i.preparada.alto}</p>}
          </div>
          {i.estado !== 'subiendo' && i.estado !== 'subida' && (
            <button type="button" aria-label="Quitar foto" className="grid size-9 shrink-0 place-items-center rounded-ctl text-slate-500 hover:bg-slate-100" onClick={() => onQuitar(i.clave)}>
              <X className="size-4" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

// ───────────── Confirmar y guardar (Sacar foto → Confirmar → guardada) ─────────────
/** `onGuardadas` recibe los ids de las fotos nuevas apenas se guardan (el checklist las asocia a un daño); se llama una sola vez por foto. */
export function ConfirmarSubida({ archivos, campos, titulo, onCerrar, onGuardadas }: { archivos: File[]; campos: Omit<CamposSubida, 'idem_key' | 'descripcion'>; titulo: string; onCerrar: () => void; onGuardadas?: (ids: string[]) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const l = useFotosLocales();
  const iniciado = useRef(false);
  useEffect(() => {
    if (iniciado.current) return;
    iniciado.current = true;
    l.agregar(archivos);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [subiendo, setSubiendo] = useState(false);
  const avisadas = useRef(new Set<string>());
  const guardar = async () => {
    setSubiendo(true);
    const fallos = await l.subirTodas(campos);
    setSubiendo(false);
    qc.invalidateQueries({ queryKey: ['fotos'] });
    const nuevas = l.idsSubidas().filter((id) => !avisadas.current.has(id));
    nuevas.forEach((id) => avisadas.current.add(id));
    if (nuevas.length) onGuardadas?.(nuevas);
    if (fallos === 0) {
      toast.ok(l.items.length > 1 ? 'Fotografías guardadas' : 'Fotografía guardada');
      onCerrar();
    }
  };
  const listas = l.items.filter((i) => i.estado === 'lista' || (i.estado === 'error' && i.preparada)).length;
  return (
    <Modal
      abierto
      onCerrar={() => !subiendo && onCerrar()}
      titulo={titulo}
      pie={
        <>
          <Boton onClick={onCerrar} disabled={subiendo}>{l.items.some((i) => i.estado === 'subida') ? 'Cerrar' : 'Cancelar'}</Boton>
          <Boton variante="primario" tam="lg" className="h-12" cargando={subiendo} disabled={!listas || (l.ocupado && !subiendo)} onClick={guardar}>
            {l.items.some((i) => i.estado === 'error') ? 'Reintentar' : `Guardar ${listas > 1 ? `${listas} fotos` : 'foto'}`}
          </Boton>
        </>
      }
    >
      <ListaLocal items={l.items} onDescripcion={l.descripcion} onQuitar={l.quitar} onReintentar={guardar} bloqueada={subiendo} />
      {l.items.length === 0 && <Cargando texto="Preparando…" />}
    </Modal>
  );
}

// ───────────── Galería ─────────────
export function GaleriaFotos({ vehiculoId, ordenId, etapa, puedeSubir, puedeEliminar, filtros, tituloSubida }: {
  vehiculoId: string;
  ordenId?: string;
  /** En una OT: etapa que se muestra y a la que se asignan las fotos nuevas. */
  etapa?: Etapa;
  puedeSubir: boolean;
  puedeEliminar: boolean;
  /** En la ficha del vehículo: chips para filtrar por origen (vehículo / etapas de OT). */
  filtros?: boolean;
  tituloSubida?: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { confirmar, dialogo } = useConfirmar();
  const estado = useEstadoFotos();
  const clave = ['fotos', ordenId ? 'orden' : 'vehiculo', ordenId ?? vehiculoId];
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: clave, queryFn: () => api.get<FotoApi[]>(ordenId ? `/ordenes/${ordenId}/fotos` : `/vehiculos/${vehiculoId}/fotos`) });
  const [filtro, setFiltro] = useState<'todas' | 'vehiculo' | Etapa>('todas');
  const [seleccion, setSeleccion] = useState<{ archivos: File[]; n: number } | null>(null);
  const [abierta, setAbierta] = useState<string | null>(null);

  const visibles = useMemo(
    () => data.filter((f) => (ordenId && etapa ? f.etapa === etapa : filtro === 'todas' ? true : filtro === 'vehiculo' ? !f.orden_id : f.etapa === filtro)),
    [data, ordenId, etapa, filtro],
  );
  const indice = visibles.findIndex((f) => f.id === abierta);
  const actual = indice >= 0 ? visibles[indice] : null;
  const [desc, setDesc] = useState('');
  useEffect(() => setDesc(actual?.descripcion ?? ''), [actual?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const eliminar = useMutation({
    mutationFn: (id: string) => api.del(`/fotos/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fotos'] });
      toast.ok('Fotografía eliminada');
      setAbierta(null);
    },
    onError: toast.error,
  });
  const guardarDesc = useMutation({
    mutationFn: (v: { id: string; descripcion: string }) => api.patch(`/fotos/${v.id}`, { descripcion: v.descripcion }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fotos'] });
      toast.ok('Descripción guardada');
    },
    onError: toast.error,
  });

  const habilitado = estado.data?.habilitado !== false;
  const lleno = estado.data && estado.data.usado_bytes >= estado.data.limite_bytes;
  const campos = { vehiculo_id: vehiculoId, ...(ordenId ? { orden_id: ordenId, etapa: etapa ?? 'reparacion' } : {}) };
  const conOrden = data.some((f) => f.orden_id);

  return (
    <div className="space-y-3">
      {!habilitado && <Aviso tono="ambar">Las fotografías todavía no están habilitadas en este servidor. Consultá a la administración.</Aviso>}
      {habilitado && lleno && <Aviso tono="ambar">El taller alcanzó su límite de almacenamiento de fotografías. Eliminá fotos que ya no necesites o pedí ampliar el espacio.</Aviso>}
      {puedeSubir && habilitado && !lleno && <BotonesCamara onArchivos={(archivos) => setSeleccion({ archivos, n: Date.now() })} />}

      {filtros && conOrden && (
        <div className="flex flex-wrap gap-2">
          <Chip activo={filtro === 'todas'} onClick={() => setFiltro('todas')}>Todas ({data.length})</Chip>
          <Chip activo={filtro === 'vehiculo'} onClick={() => setFiltro('vehiculo')}>Del vehículo ({data.filter((f) => !f.orden_id).length})</Chip>
          {ETAPAS.map((e) => (
            <Chip key={e.clave} activo={filtro === e.clave} onClick={() => setFiltro(e.clave)}>{e.titulo} ({data.filter((f) => f.etapa === e.clave).length})</Chip>
          ))}
        </div>
      )}

      {isLoading ? (
        <Cargando />
      ) : error ? (
        <ErrorCaja error={error} reintentar={refetch} />
      ) : visibles.length === 0 ? (
        <p className="rounded-card border border-dashed border-borde px-3 py-6 text-center text-sm text-tenue">{puedeSubir ? 'Todavía no hay fotografías. Sacá la primera con el botón de arriba.' : 'No hay fotografías.'}</p>
      ) : (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
          {visibles.map((f) => (
            <li key={f.id} className="min-w-0">
              <button type="button" onClick={() => setAbierta(f.id)} className="group relative block aspect-square w-full overflow-hidden rounded-ctl border border-borde bg-slate-100 focus-visible:ring-2 focus-visible:ring-marca-300" aria-label={`Ampliar fotografía${f.descripcion ? `: ${f.descripcion}` : ''}`}>
                <img src={urlMiniatura(f.id)} alt={f.descripcion ?? 'Fotografía'} loading="lazy" decoding="async" className="size-full object-cover transition-transform group-hover:scale-[1.03]" />
                {f.orden_id && !etapa && <span className="absolute inset-x-0 bottom-0 truncate bg-petroleo-950/70 px-1.5 py-0.5 text-left text-[10px] font-medium text-white">OT #{f.orden_numero} · {ETAPA_TITULO[f.etapa ?? '']}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}

      {seleccion && <ConfirmarSubida key={seleccion.n} archivos={seleccion.archivos} campos={campos} titulo={tituloSubida ?? (ordenId && etapa ? `Fotografías · ${ETAPA_TITULO[etapa]}` : 'Fotografías del vehículo')} onCerrar={() => setSeleccion(null)} />}

      <Modal
        abierto={!!actual}
        onCerrar={() => setAbierta(null)}
        ancho="xl"
        titulo={actual ? <span className="text-sm">{actual.orden_id ? `OT #${actual.orden_numero} · ${ETAPA_TITULO[actual.etapa ?? '']}` : 'Vehículo'} · {fechaHora(actual.created_at)}{actual.usuario ? ` · ${actual.usuario}` : ''}</span> : ''}
        pie={
          actual && (
            <>
              {puedeEliminar && (
                <Boton
                  variante="peligro"
                  icono={<Trash2 className="size-4" />}
                  cargando={eliminar.isPending}
                  onClick={async () => (await confirmar('Eliminar fotografía', 'Se elimina para todos los usuarios del taller y no se puede recuperar. Queda registrado quién la eliminó.', true)) && eliminar.mutate(actual.id)}
                >
                  Eliminar
                </Boton>
              )}
              <Boton onClick={() => setAbierta(null)}>Cerrar</Boton>
            </>
          )
        }
      >
        {actual && (
          <div className="space-y-3">
            <div className="relative grid place-items-center rounded-card bg-slate-900">
              <img src={urlFoto(actual.id)} alt={actual.descripcion ?? 'Fotografía'} className="max-h-[62dvh] w-full object-contain" />
              {indice > 0 && <button type="button" aria-label="Anterior" className="absolute left-1 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-white/85 shadow" onClick={() => setAbierta(visibles[indice - 1].id)}><ChevronLeft className="size-6" /></button>}
              {indice < visibles.length - 1 && <button type="button" aria-label="Siguiente" className="absolute right-1 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-white/85 shadow" onClick={() => setAbierta(visibles[indice + 1].id)}><ChevronRight className="size-6" /></button>}
            </div>
            {puedeSubir ? (
              <div className="flex gap-2">
                <Input value={desc} onKeyDown={sinEnviar} onChange={(e) => setDesc(e.target.value)} placeholder="Descripción (opcional)" maxLength={300} />
                <Boton disabled={desc.trim() === (actual.descripcion ?? '')} cargando={guardarDesc.isPending} onClick={() => guardarDesc.mutate({ id: actual.id, descripcion: desc })}>Guardar</Boton>
              </div>
            ) : (
              actual.descripcion && <p className="break-words text-sm">{actual.descripcion}</p>
            )}
            <p className="text-xs text-tenue">{actual.ancho}×{actual.alto} px · {Math.round(actual.bytes / 1024)} KB · {indice + 1} de {visibles.length}</p>
          </div>
        )}
      </Modal>
      {dialogo}
    </div>
  );
}

// ───────────── Pestaña de la OT: tres etapas ─────────────
export function FotosOrden({ ordenId, vehiculoId, estadoOrden, asignadaAMi }: { ordenId: string; vehiculoId: string; estadoOrden: string; asignadaAMi?: boolean }) {
  const permisos = usePermisosFotos({ ordenId, asignadaAMi });
  const inicial: Etapa = estadoOrden === 'recibida' ? 'recepcion' : estadoOrden === 'lista' || estadoOrden === 'entregada' ? 'entrega' : 'reparacion';
  const [etapa, setEtapa] = useState<Etapa>(inicial);
  const { data = [] } = useQuery({ queryKey: ['fotos', 'orden', ordenId], queryFn: () => api.get<FotoApi[]>(`/ordenes/${ordenId}/fotos`), enabled: permisos.ver });
  if (!permisos.ver) return null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Etapa de las fotografías">
        {ETAPAS.map((e) => (
          <button
            key={e.clave}
            type="button"
            role="tab"
            aria-selected={etapa === e.clave}
            onClick={() => setEtapa(e.clave)}
            className={cn('flex h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-ctl border px-3 text-sm font-semibold', etapa === e.clave ? 'border-marca-400 bg-marca-50 text-marca-800' : 'border-borde bg-white text-slate-600 hover:bg-slate-50')}
          >
            {e.titulo}
            <span className="rounded-full bg-white/80 px-1.5 text-xs ring-1 ring-borde">{data.filter((f) => f.etapa === e.clave).length}</span>
          </button>
        ))}
      </div>
      <GaleriaFotos key={etapa} vehiculoId={vehiculoId} ordenId={ordenId} etapa={etapa} puedeSubir={permisos.subir} puedeEliminar={permisos.eliminar} />
    </div>
  );
}
