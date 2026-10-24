// Editor del checklist de recepción o entrega: pantalla completa pensada para el celular o la tablet del taller (botones grandes, secciones plegables,
// progreso a la vista, guardado automático del borrador en el servidor y confirmación final con resumen).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Camera, Check, CheckCircle2, ChevronDown, Circle, Minus, MinusCircle, Plus, Trash2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { numero } from '@/lib/format';
import { BotonesCamara, ConfirmarSubida, GaleriaFotos, urlMiniatura, usePermisosFotos, type FotoApi } from '../Fotos';
import { Aviso, Boton, Campo, Chip, Input, Insignia, Modal, Textarea, cn, useConfirmar, useToast } from '../ui';
import { COMBUSTIBLE_NIVELES } from '@shared/dominio';
import {
  PERTENENCIAS_SUGERIDAS, SECCIONES_CHECKLIST, TIPO_REGISTRO_LABEL, ZONAS_DANO, ZONA_DANO_LABEL, progresoItems,
  type ContenidoChecklist, type Dano, type EstadoItem, type ZonaDano,
} from '@shared/checklist';
import { EsquemaAuto, POSICION_ZONA } from './EsquemaAuto';
import { ResumenRegistro, textoCombustible, type InfoOrden } from './Resumen';
import { aInputLocal, claveChecklists, deInputLocal, type Registro } from './tipos';

type Guardado = 'ok' | 'sucio' | 'guardando' | 'error' | 'conflicto';

const OPCIONES: Array<{ e: EstadoItem; corto: string; icono: React.ReactNode; on: string }> = [
  { e: 'correcto', corto: 'Correcto', icono: <CheckCircle2 className="size-5" />, on: 'border-exito-600 bg-exito-50 text-exito-700' },
  { e: 'con_observaciones', corto: 'Observación', icono: <AlertTriangle className="size-5" />, on: 'border-aviso-600 bg-aviso-50 text-amber-800' },
  { e: 'no_revisado', corto: 'Sin revisar', icono: <Circle className="size-5" />, on: 'border-slate-400 bg-slate-100 text-slate-700' },
  { e: 'no_corresponde', corto: 'No aplica', icono: <MinusCircle className="size-5" />, on: 'border-slate-400 bg-slate-100 text-slate-700' },
];

const nuevoIdDano = () => `dano-${crypto.randomUUID().slice(0, 8)}`;

export function EditorRegistro({ registro, info, vehiculoId, asignadaAMi, onCerrar, onConfirmado }: { registro: Registro; info: InfoOrden; vehiculoId: string; asignadaAMi: boolean; onCerrar: () => void; onConfirmado: (r: Registro) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { confirmar, dialogo } = useConfirmar();
  const permisosFotos = usePermisosFotos({ ordenId: registro.orden_id, asignadaAMi });
  const esEntrega = registro.tipo === 'entrega';

  const [datos, setDatos] = useState<ContenidoChecklist>(registro.datos);
  const datosRef = useRef(datos);
  datosRef.current = datos;
  const versionRef = useRef(registro.version);
  const sucio = useRef(false);
  const cola = useRef<Promise<boolean>>(Promise.resolve(true));
  const [guardado, setGuardado] = useState<Guardado>('ok');
  const [ultimo, setUltimo] = useState(registro.updated_at);
  const [errorGuardado, setErrorGuardado] = useState('');
  const [abierta, setAbierta] = useState<string | null>('ingreso');
  const [dano, setDano] = useState<Dano | 'nuevo' | null>(null);
  const [revisando, setRevisando] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const refs = useRef<Record<string, HTMLElement | null>>({});

  // ───── Guardado del borrador ─────
  const guardarUnaVez = useCallback(async (): Promise<boolean> => {
    if (!sucio.current) return true;
    sucio.current = false;
    setGuardado('guardando');
    try {
      const r = await api.put<Registro>(`/checklists/${registro.id}`, { version: versionRef.current, datos: datosRef.current });
      versionRef.current = r.version;
      setUltimo(r.updated_at);
      setGuardado(sucio.current ? 'sucio' : 'ok');
      return true;
    } catch (e: any) {
      sucio.current = true;
      setErrorGuardado(e?.message ?? 'No se pudo guardar');
      setGuardado(e?.code === 'conflicto_version' || e?.code === 'confirmado' ? 'conflicto' : 'error');
      return false;
    }
  }, [registro.id]);
  /** Guarda lo pendiente (de a una vez, en orden) y devuelve si quedó todo guardado. */
  const guardar = useCallback((): Promise<boolean> => {
    cola.current = cola.current.then(guardarUnaVez);
    return cola.current;
  }, [guardarUnaVez]);

  const cambiar = (fn: (d: ContenidoChecklist) => ContenidoChecklist) => {
    sucio.current = true;
    setGuardado((g) => (g === 'conflicto' ? g : 'sucio'));
    setDatos((d) => fn(d));
  };
  useEffect(() => {
    if (!sucio.current || guardado === 'conflicto') return;
    const t = setTimeout(() => void guardar(), 1200);
    return () => clearTimeout(t);
  }, [datos]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (sucio.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('beforeunload', h);
      document.body.style.overflow = '';
    };
  }, []);

  const recargarDelServidor = async () => {
    const r = await api.get<{ registros: Registro[] }>(`/ordenes/${registro.orden_id}/checklists`);
    const actual = r.registros.find((x) => x.id === registro.id);
    if (!actual || actual.estado !== 'borrador') {
      qc.invalidateQueries({ queryKey: claveChecklists(registro.orden_id) });
      toast.ok('Este registro ya fue confirmado por otra persona');
      return onCerrar();
    }
    versionRef.current = actual.version;
    sucio.current = false;
    setDatos(actual.datos);
    setGuardado('ok');
  };

  const cerrar = async () => {
    const ok = await guardar();
    if (!ok && !(await confirmar('Salir sin guardar', 'No se pudieron guardar los últimos cambios. Si salís ahora se pierden.', true))) return;
    qc.invalidateQueries({ queryKey: claveChecklists(registro.orden_id) });
    onCerrar();
  };

  const descartar = async () => {
    if (!(await confirmar('Descartar borrador', 'Se elimina este borrador con todo lo cargado. Las fotografías ya tomadas se conservan en la orden.', true))) return;
    try {
      await api.del(`/checklists/${registro.id}`);
      sucio.current = false;
      qc.invalidateQueries({ queryKey: claveChecklists(registro.orden_id) });
      toast.ok('Borrador descartado');
      onCerrar();
    } catch (e) {
      toast.error(e);
    }
  };

  const revisar = async () => {
    if (await guardar()) setRevisando(true);
    else toast.error(new Error('No se pudo guardar el borrador. Revisá la conexión y reintentá.'));
  };

  const confirmarRegistro = async () => {
    setConfirmando(true);
    try {
      const r = await api.post<Registro>(`/checklists/${registro.id}/confirmar`, { version: versionRef.current });
      sucio.current = false;
      qc.invalidateQueries({ queryKey: claveChecklists(registro.orden_id) });
      qc.invalidateQueries({ queryKey: ['fotos'] });
      toast.ok(`${TIPO_REGISTRO_LABEL[registro.tipo]} confirmada`);
      onConfirmado(r);
    } catch (e) {
      toast.error(e);
    } finally {
      setConfirmando(false);
    }
  };

  // ───── Avisos (blandos: nada es obligatorio) ─────
  const prog = progresoItems(datos);
  const avisos = useMemo(() => {
    const a: string[] = [];
    if (datos.km == null) a.push('No cargaste el kilometraje.');
    if (!datos.combustible) a.push('No indicaste el nivel de combustible.');
    if (datos.llaves == null) a.push('No indicaste cuántas llaves se reciben.');
    if (prog.revisados === 0) a.push('No marcaste ningún punto de control del estado del vehículo.');
    if (datos.danos.some((d) => !d.descripcion.trim() && !d.fotos.length)) a.push('Hay daños sin descripción ni fotografías.');
    return a;
  }, [datos, prog.revisados]);

  // ───── Secciones ─────
  const abrir = (clave: string) => {
    setAbierta(clave);
    setTimeout(() => refs.current[clave]?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  };
  const itemsDe = (s: (typeof SECCIONES_CHECKLIST)[number]) => s.items.filter((i) => (datos.items[`${s.clave}.${i.clave}`]?.estado ?? 'no_revisado') !== 'no_revisado').length;
  const pasos: Array<{ clave: string; titulo: string; hecho: boolean; detalle?: string }> = [
    { clave: 'ingreso', titulo: esEntrega ? 'Salida' : 'Ingreso', hecho: datos.km != null && !!datos.combustible, detalle: datos.km != null ? undefined : 'Falta km' },
    { clave: 'estado', titulo: 'Estado', hecho: prog.revisados > 0, detalle: `${prog.revisados}/${prog.total}` },
    { clave: 'danos', titulo: 'Daños', hecho: datos.danos.length > 0, detalle: datos.danos.length ? String(datos.danos.length) : undefined },
    { clave: 'pertenencias', titulo: 'Pertenencias', hecho: datos.pertenencias.length > 0, detalle: datos.pertenencias.length ? String(datos.pertenencias.length) : undefined },
    ...(esEntrega ? [{ clave: 'trabajos', titulo: 'Trabajos', hecho: datos.trabajos.length > 0 || !!datos.estado_general.trim() }] : []),
    { clave: 'fotos', titulo: 'Fotos', hecho: false },
  ];

  const setItem = (codigo: string, estado: EstadoItem) =>
    cambiar((d) => {
      const items = { ...d.items };
      if (estado === 'no_revisado') delete items[codigo];
      else items[codigo] = { estado, ...(estado === 'con_observaciones' && items[codigo]?.obs ? { obs: items[codigo].obs } : {}) };
      return { ...d, items };
    });
  const setObs = (codigo: string, obs: string) => cambiar((d) => ({ ...d, items: { ...d.items, [codigo]: { estado: 'con_observaciones', ...(obs ? { obs } : {}) } } }));
  const todoCorrecto = (s: (typeof SECCIONES_CHECKLIST)[number]) =>
    cambiar((d) => {
      const items = { ...d.items };
      for (const i of s.items) if (!items[`${s.clave}.${i.clave}`]) items[`${s.clave}.${i.clave}`] = { estado: 'correcto' };
      return { ...d, items };
    });

  const guardarDano = (x: Dano) =>
    cambiar((d) => ({ ...d, danos: d.danos.some((y) => y.id === x.id) ? d.danos.map((y) => (y.id === x.id ? x : y)) : [...d.danos, x] }));
  const quitarDano = (id: string) => cambiar((d) => ({ ...d, danos: d.danos.filter((y) => y.id !== id) }));
  const danoActual = dano && dano !== 'nuevo' ? dano : null;
  const danoExistente = !!danoActual && datos.danos.some((x) => x.id === danoActual.id);

  const estadoGuardado =
    guardado === 'guardando' ? 'Guardando…' : guardado === 'sucio' ? 'Cambios sin guardar' : guardado === 'error' ? 'No se pudo guardar' : guardado === 'conflicto' ? 'Conflicto' : `Guardado ${new Date(ultimo).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-fondo" role="dialog" aria-modal="true" aria-label={`${TIPO_REGISTRO_LABEL[registro.tipo]} de la orden #${numero(info.numero)}`}>
      {dialogo}
      {/* Encabezado fijo: título, estado del guardado y progreso */}
      <header className="border-b border-borde bg-white shadow-card">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold">
              {TIPO_REGISTRO_LABEL[registro.tipo]}{registro.revision > 0 ? ` · revisión ${registro.revision}` : ''} · OT #{numero(info.numero)}
            </h2>
            <p className="truncate text-xs text-tenue">{[info.patente, info.vehiculo, info.cliente].filter(Boolean).join(' · ')}</p>
            <p className={cn('text-xs sm:hidden', guardado === 'error' || guardado === 'conflicto' ? 'font-medium text-peligro-700' : 'text-tenue')} role="status" aria-live="polite">{estadoGuardado}</p>
          </div>
          <span className={cn('hidden shrink-0 text-xs sm:inline', guardado === 'error' || guardado === 'conflicto' ? 'font-medium text-peligro-700' : 'text-tenue')}>{estadoGuardado}</span>
          <Boton variante="fantasma" onClick={cerrar} aria-label="Guardar y salir" icono={<X className="size-5" />} />
        </div>
        <div className="mx-auto w-full max-w-3xl space-y-2 px-4 pb-2.5">
          <div className="flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuenow={prog.pct} aria-valuemin={0} aria-valuemax={100} aria-label="Puntos de control revisados">
              <div className="h-full bg-marca-500 transition-all" style={{ width: `${Math.max(prog.pct, prog.revisados ? 4 : 0)}%` }} />
            </div>
            <span className="shrink-0 text-xs tabular-nums text-tenue">{prog.revisados} de {prog.total} puntos</span>
          </div>
          <nav className="flex flex-wrap gap-1.5" aria-label="Secciones">
            {pasos.map((p) => (
              <button
                key={p.clave}
                type="button"
                onClick={() => abrir(p.clave)}
                className={cn('inline-flex h-8 items-center gap-1 rounded-full border px-2.5 text-xs font-medium', abierta === p.clave ? 'border-marca-400 bg-marca-50 text-marca-800' : 'border-borde bg-white text-slate-600')}
              >
                {p.hecho && <Check className="size-3.5 text-exito-600" aria-hidden />}
                {p.titulo}
                {p.detalle && <span className="tabular-nums text-tenue">{p.detalle}</span>}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* Contenido */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-3xl space-y-3 px-4 py-4">
          {guardado === 'conflicto' && (
            <Aviso tono="rojo">
              <p>{errorGuardado}</p>
              <Boton tam="sm" className="mt-2" onClick={recargarDelServidor}>Descartar mis últimos cambios y cargar la versión guardada</Boton>
            </Aviso>
          )}
          {guardado === 'error' && (
            <Aviso tono="ambar">
              <p>{errorGuardado}. Tus cambios siguen en esta pantalla.</p>
              <Boton tam="sm" className="mt-2" onClick={() => void guardar()}>Reintentar guardar</Boton>
            </Aviso>
          )}
          {registro.motivo && <Aviso tono="ambar"><strong>Corrección:</strong> {registro.motivo}. El registro original se conserva; esta será una revisión.</Aviso>}

          <Panel id="ingreso" refs={refs} titulo={esEntrega ? 'Datos de la entrega' : 'Datos del ingreso'} abierta={abierta === 'ingreso'} onAlternar={() => setAbierta(abierta === 'ingreso' ? null : 'ingreso')}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Campo label="Fecha y hora">
                <Input type="datetime-local" value={aInputLocal(datos.fecha_hora)} max={aInputLocal(new Date().toISOString())} onChange={(e) => e.target.value && cambiar((d) => ({ ...d, fecha_hora: deInputLocal(e.target.value) }))} className="h-12" />
              </Campo>
              <Campo label={esEntrega ? 'Kilometraje de salida' : 'Kilometraje'}>
                <Input value={datos.km ?? ''} inputMode="numeric" placeholder="Ej.: 125000" className="h-12 text-lg" onChange={(e) => cambiar((d) => ({ ...d, km: e.target.value.replace(/\D/g, '') === '' ? null : Math.min(5_000_000, Number(e.target.value.replace(/\D/g, ''))) }))} />
              </Campo>
            </div>
            <div>
              <p className="mb-1.5 text-[13px] font-medium text-slate-700">Nivel de combustible (aproximado)</p>
              <div className="grid grid-cols-5 gap-1.5">
                {COMBUSTIBLE_NIVELES.map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={datos.combustible === n}
                    onClick={() => cambiar((d) => ({ ...d, combustible: d.combustible === n ? null : n }))}
                    className={cn('h-12 rounded-ctl border text-sm font-semibold', datos.combustible === n ? 'border-marca-500 bg-marca-50 text-marca-800' : 'border-borde bg-white text-slate-600 active:bg-slate-100')}
                  >
                    {textoCombustible(n)}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-[13px] font-medium text-slate-700">{esEntrega ? 'Llaves que se entregan' : 'Llaves recibidas'}</p>
              <div className="flex items-center gap-3">
                <Boton className="size-12" aria-label="Una llave menos" disabled={!datos.llaves} onClick={() => cambiar((d) => ({ ...d, llaves: Math.max(0, (d.llaves ?? 0) - 1) }))} icono={<Minus className="size-5" />} />
                <span className="w-12 text-center text-2xl font-semibold tabular-nums" aria-live="polite">{datos.llaves ?? '—'}</span>
                <Boton className="size-12" aria-label="Una llave más" onClick={() => cambiar((d) => ({ ...d, llaves: Math.min(20, (d.llaves ?? 0) + 1) }))} icono={<Plus className="size-5" />} />
              </div>
            </div>
            <Campo label="Observaciones generales">
              <Textarea rows={3} value={datos.observaciones} maxLength={2000} placeholder="Lo que cuenta el cliente, ruidos, olores, pedidos especiales…" onChange={(e) => cambiar((d) => ({ ...d, observaciones: e.target.value }))} />
            </Campo>
          </Panel>

          <Panel id="estado" refs={refs} titulo="Estado del vehículo" detalle={`${prog.revisados} de ${prog.total} puntos`} abierta={abierta === 'estado'} onAlternar={() => setAbierta(abierta === 'estado' ? null : 'estado')}>
            <p className="text-xs text-tenue">Marcá sólo lo que revisás: ningún punto es obligatorio. Lo que no se toca queda como «Sin revisar».</p>
            <div className="space-y-4">
              {SECCIONES_CHECKLIST.map((s) => (
                <details key={s.clave} className="group rounded-card border border-borde bg-white" open={itemsDe(s) > 0}>
                  <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
                    <span className="font-medium">{s.titulo}</span>
                    <span className="flex items-center gap-2 text-xs text-tenue">
                      {itemsDe(s)} de {s.items.length}
                      <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden />
                    </span>
                  </summary>
                  <div className="space-y-3 border-t border-borde-suave px-3 py-3">
                    {s.items.map((i) => {
                      const codigo = `${s.clave}.${i.clave}`;
                      const it = datos.items[codigo];
                      const actual: EstadoItem = it?.estado ?? 'no_revisado';
                      return (
                        <div key={codigo} className="space-y-1.5">
                          <p className="text-sm">{i.titulo}</p>
                          <div className="grid grid-cols-4 gap-1.5" role="group" aria-label={i.titulo}>
                            {OPCIONES.map((o) => (
                              <button
                                key={o.e}
                                type="button"
                                aria-pressed={actual === o.e}
                                onClick={() => setItem(codigo, o.e)}
                                className={cn('flex h-14 min-w-0 flex-col items-center justify-center gap-0.5 rounded-ctl border px-1 text-[11px] font-medium leading-tight', actual === o.e ? o.on : 'border-borde bg-white text-slate-500 active:bg-slate-100')}
                              >
                                {o.icono}
                                <span className="truncate">{o.corto}</span>
                              </button>
                            ))}
                          </div>
                          {actual === 'con_observaciones' && (
                            <Input value={it?.obs ?? ''} maxLength={300} placeholder="¿Qué se observa? (opcional)" aria-label={`Observación: ${i.titulo}`} onChange={(e) => setObs(codigo, e.target.value)} />
                          )}
                        </div>
                      );
                    })}
                    <Boton tam="sm" icono={<CheckCircle2 className="size-4" />} onClick={() => todoCorrecto(s)}>Marcar lo que falta como correcto</Boton>
                  </div>
                </details>
              ))}
            </div>
          </Panel>

          <Panel id="danos" refs={refs} titulo="Daños" detalle={datos.danos.length ? `${datos.danos.length} registrados` : undefined} abierta={abierta === 'danos'} onAlternar={() => setAbierta(abierta === 'danos' ? null : 'danos')}>
            <p className="text-xs text-tenue">Tocá en el esquema donde hay un daño (o en «Interior»). Después agregá una descripción y fotografías.</p>
            <EsquemaAuto danos={datos.danos} onZona={(zona, x, y) => setDano({ id: nuevoIdDano(), zona, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, descripcion: '', fotos: [] })} onDano={(id) => setDano(datos.danos.find((x) => x.id === id) ?? null)} />
            {datos.danos.length > 0 && (
              <ol className="space-y-2">
                {datos.danos.map((x, i) => (
                  <li key={x.id}>
                    <button type="button" onClick={() => setDano(x)} className="flex min-h-14 w-full min-w-0 items-center gap-3 rounded-card border border-borde bg-white px-3 py-2 text-left active:bg-slate-50">
                      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-peligro-600 text-sm font-bold text-white">{i + 1}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{ZONA_DANO_LABEL[x.zona]}</span>
                        <span className="block truncate text-xs text-tenue">{x.descripcion || 'Sin descripción'}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-xs text-tenue"><Camera className="size-4" aria-hidden />{x.fotos.length}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
            <Boton icono={<Plus className="size-4" />} onClick={() => setDano('nuevo')}>Agregar daño sin tocar el esquema</Boton>
          </Panel>

          <Panel id="pertenencias" refs={refs} titulo="Elementos y pertenencias" detalle={datos.pertenencias.length ? `${datos.pertenencias.length}` : undefined} abierta={abierta === 'pertenencias'} onAlternar={() => setAbierta(abierta === 'pertenencias' ? null : 'pertenencias')}>
            <ListaTexto
              ayuda={esEntrega ? 'Lo que se le devuelve al cliente.' : 'Lo que el cliente deja con el vehículo (documentación, llaves extra, objetos personales).'}
              items={datos.pertenencias}
              sugeridas={PERTENENCIAS_SUGERIDAS}
              onCambio={(pertenencias) => cambiar((d) => ({ ...d, pertenencias }))}
              placeholder="Otro elemento…"
            />
          </Panel>

          {esEntrega && (
            <Panel id="trabajos" refs={refs} titulo="Trabajos realizados y estado general" abierta={abierta === 'trabajos'} onAlternar={() => setAbierta(abierta === 'trabajos' ? null : 'trabajos')}>
              <Campo label="Estado general al entregar">
                <Textarea rows={3} value={datos.estado_general} maxLength={1000} placeholder="Cómo queda el vehículo, recomendaciones, pendientes…" onChange={(e) => cambiar((d) => ({ ...d, estado_general: e.target.value }))} />
              </Campo>
              <ListaTexto ayuda="Se cargaron desde la orden de trabajo (sin precios); podés editarlos." items={datos.trabajos} onCambio={(trabajos) => cambiar((d) => ({ ...d, trabajos }))} placeholder="Agregar un trabajo realizado…" />
            </Panel>
          )}

          <Panel id="fotos" refs={refs} titulo={`Fotografías de ${esEntrega ? 'entrega' : 'recepción'}`} abierta={abierta === 'fotos'} onAlternar={() => setAbierta(abierta === 'fotos' ? null : 'fotos')}>
            {permisosFotos.ver ? (
              <>
                <p className="text-xs text-tenue">Las fotografías de esta etapa quedan incluidas en el registro al confirmarlo. Son las mismas de la pestaña Fotografías de la orden: se guardan una sola vez.</p>
                <GaleriaFotos vehiculoId={vehiculoId} ordenId={registro.orden_id} etapa={registro.tipo} puedeSubir={permisosFotos.subir} puedeEliminar={permisosFotos.eliminar} />
              </>
            ) : (
              <p className="text-sm text-tenue">No tenés permiso para ver ni sacar fotografías.</p>
            )}
          </Panel>

          <div className="pt-2">
            <Boton variante="fantasma" className="text-peligro-700" icono={<Trash2 className="size-4" />} onClick={descartar}>Descartar este borrador</Boton>
          </div>
        </div>
      </div>

      {/* Acciones fijas */}
      <footer className="border-t border-borde bg-white pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-modal">
        <div className="mx-auto flex w-full max-w-3xl gap-2 px-4 py-2.5">
          <Boton className="h-12 flex-1" onClick={cerrar}>Guardar y salir</Boton>
          <Boton variante="primario" className="h-12 flex-[2]" icono={<CheckCircle2 className="size-5" />} onClick={revisar} disabled={guardado === 'conflicto'}>
            Revisar y confirmar
          </Boton>
        </div>
      </footer>

      {dano && (
        <EditorDano
          key={danoActual?.id ?? 'nuevo'}
          inicial={danoActual}
          existente={danoExistente}
          tipo={registro.tipo}
          ordenId={registro.orden_id}
          vehiculoId={vehiculoId}
          puedeFotos={permisosFotos.subir}
          puedeVerFotos={permisosFotos.ver}
          onCerrar={() => setDano(null)}
          onGuardar={(x) => {
            guardarDano(x);
            setDano(null);
          }}
          onQuitar={danoExistente && danoActual ? () => { quitarDano(danoActual.id); setDano(null); } : undefined}
        />
      )}

      <Modal
        abierto={revisando}
        onCerrar={() => !confirmando && setRevisando(false)}
        titulo={`Revisá antes de confirmar`}
        ancho="lg"
        pie={
          <>
            <Boton onClick={() => setRevisando(false)} disabled={confirmando}>Seguir editando</Boton>
            <Boton variante="primario" tam="lg" cargando={confirmando} icono={<CheckCircle2 className="size-5" />} onClick={confirmarRegistro}>
              Confirmar {registro.tipo === 'recepcion' ? 'recepción' : 'entrega'}
            </Boton>
          </>
        }
      >
        <div className="space-y-4">
          <Aviso tono="azul">Al confirmar, el contenido queda congelado con un sello de fecha y hora del servidor. Después sólo se puede corregir creando una revisión: el original se conserva.</Aviso>
          {avisos.length > 0 && (
            <Aviso tono="ambar">
              <p className="font-medium">Podés confirmar igual, pero fijate:</p>
              <ul className="mt-1 list-disc pl-5">{avisos.map((a) => <li key={a}>{a}</li>)}</ul>
            </Aviso>
          )}
          <ResumenRegistro reg={{ ...registro, datos }} info={info} />
        </div>
      </Modal>
    </div>
  );
}

// ───────────── Panel plegable ─────────────
function Panel({ id, refs, titulo, detalle, abierta, onAlternar, children }: { id: string; refs: React.MutableRefObject<Record<string, HTMLElement | null>>; titulo: string; detalle?: string; abierta: boolean; onAlternar: () => void; children: React.ReactNode }) {
  return (
    <section ref={(el) => { refs.current[id] = el; }} className="scroll-mt-4 rounded-card border border-borde bg-white shadow-card">
      <h3>
        <button type="button" onClick={onAlternar} aria-expanded={abierta} className="flex min-h-14 w-full items-center justify-between gap-3 px-4 py-3 text-left">
          <span className="min-w-0 truncate text-base font-semibold">{titulo}</span>
          <span className="flex shrink-0 items-center gap-2 text-xs text-tenue">
            {detalle}
            <ChevronDown className={cn('size-5 transition-transform', abierta && 'rotate-180')} aria-hidden />
          </span>
        </button>
      </h3>
      {abierta && <div className="space-y-4 border-t border-borde-suave px-4 py-4">{children}</div>}
    </section>
  );
}

// ───────────── Lista de textos cortos (pertenencias, trabajos) ─────────────
function ListaTexto({ items, onCambio, sugeridas, placeholder, ayuda }: { items: Array<{ descripcion: string }>; onCambio: (x: Array<{ descripcion: string }>) => void; sugeridas?: readonly string[]; placeholder: string; ayuda?: string }) {
  const [texto, setTexto] = useState('');
  const tiene = (d: string) => items.some((x) => x.descripcion.toLowerCase() === d.toLowerCase());
  const agregar = (d: string) => {
    const limpio = d.trim().slice(0, 120);
    if (limpio && !tiene(limpio) && items.length < 40) onCambio([...items, { descripcion: limpio }]);
    setTexto('');
  };
  return (
    <div className="space-y-3">
      {ayuda && <p className="text-xs text-tenue">{ayuda}</p>}
      {sugeridas && (
        <div className="flex flex-wrap gap-2">
          {sugeridas.map((s) => (
            <Chip key={s} activo={tiene(s)} onClick={() => (tiene(s) ? onCambio(items.filter((x) => x.descripcion.toLowerCase() !== s.toLowerCase())) : agregar(s))}>{s}</Chip>
          ))}
        </div>
      )}
      {items.filter((x) => !sugeridas?.some((s) => s.toLowerCase() === x.descripcion.toLowerCase())).length > 0 && (
        <ul className="space-y-1.5">
          {items.map((x, i) =>
            sugeridas?.some((s) => s.toLowerCase() === x.descripcion.toLowerCase()) ? null : (
              <li key={`${x.descripcion}-${i}`} className="flex min-h-11 items-center gap-2 rounded-ctl border border-borde bg-white pl-3">
                <span className="min-w-0 flex-1 break-words text-sm">{x.descripcion}</span>
                <button type="button" aria-label={`Quitar ${x.descripcion}`} className="grid size-11 shrink-0 place-items-center text-slate-500 active:bg-slate-100" onClick={() => onCambio(items.filter((_, j) => j !== i))}>
                  <X className="size-4" />
                </button>
              </li>
            ),
          )}
        </ul>
      )}
      <div className="flex gap-2">
        <Input value={texto} maxLength={120} placeholder={placeholder} className="h-12" onChange={(e) => setTexto(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), agregar(texto))} />
        <Boton className="h-12" disabled={!texto.trim()} onClick={() => agregar(texto)} icono={<Plus className="size-4" />}>Agregar</Boton>
      </div>
    </div>
  );
}

// ───────────── Daño: zona, descripción y fotografías ─────────────
function EditorDano({ inicial, existente, tipo, ordenId, vehiculoId, puedeFotos, puedeVerFotos, onCerrar, onGuardar, onQuitar }: {
  inicial: Dano | null;
  existente: boolean;
  tipo: 'recepcion' | 'entrega';
  ordenId: string;
  vehiculoId: string;
  puedeFotos: boolean;
  puedeVerFotos: boolean;
  onCerrar: () => void;
  onGuardar: (d: Dano) => void;
  onQuitar?: () => void;
}) {
  const [d, setD] = useState<Dano>(() => inicial ?? { id: nuevoIdDano(), zona: 'frente', ...POSICION_ZONA.frente, descripcion: '', fotos: [] });
  const [archivos, setArchivos] = useState<{ files: File[]; n: number } | null>(null);
  const { data: delaOrden = [] } = useQuery({ queryKey: ['fotos', 'orden', ordenId], queryFn: () => api.get<FotoApi[]>(`/ordenes/${ordenId}/fotos`), enabled: puedeVerFotos });
  const candidatas = delaOrden.filter((f) => f.etapa === tipo && !d.fotos.includes(f.id));
  const cambiarZona = (zona: ZonaDano) => setD((x) => ({ ...x, zona, ...(inicial?.zona === zona && inicial.x != null ? { x: inicial.x, y: inicial.y } : POSICION_ZONA[zona]) }));
  const quitarFoto = (id: string) => setD((x) => ({ ...x, fotos: x.fotos.filter((f) => f !== id) }));
  const ok = d.descripcion.trim().length > 0 || d.fotos.length > 0;

  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo={existente ? 'Daño registrado' : 'Nuevo daño'}
      ancho="lg"
      pie={
        <>
          {onQuitar && <Boton variante="peligro" icono={<Trash2 className="size-4" />} onClick={onQuitar}>Quitar daño</Boton>}
          <Boton onClick={onCerrar}>Cancelar</Boton>
          <Boton variante="primario" tam="lg" disabled={!ok} onClick={() => onGuardar({ ...d, descripcion: d.descripcion.trim() })}>Guardar daño</Boton>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-slate-700">Zona</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {ZONAS_DANO.map((z) => (
              <button key={z} type="button" aria-pressed={d.zona === z} onClick={() => cambiarZona(z)} className={cn('h-12 rounded-ctl border px-2 text-sm font-medium', d.zona === z ? 'border-marca-500 bg-marca-50 text-marca-800' : 'border-borde bg-white text-slate-600 active:bg-slate-100')}>
                {ZONA_DANO_LABEL[z]}
              </button>
            ))}
          </div>
        </div>
        <Campo label="Descripción" hint="Qué se ve, tamaño aproximado, si el cliente avisó del daño…">
          <Textarea rows={3} value={d.descripcion} maxLength={500} autoFocus={!existente} onChange={(e) => setD((x) => ({ ...x, descripcion: e.target.value }))} placeholder="Ej.: Rayón profundo de unos 20 cm en el paragolpes" />
        </Campo>

        <div className="space-y-2">
          <p className="text-[13px] font-medium text-slate-700">Fotografías del daño · {d.fotos.length}</p>
          {d.fotos.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {d.fotos.map((id) => (
                <li key={id} className="relative">
                  <img src={urlMiniatura(id)} alt="Fotografía del daño" className="size-20 rounded-ctl border border-borde object-cover" />
                  <button type="button" aria-label="Quitar esta foto del daño" onClick={() => quitarFoto(id)} className="absolute -right-1.5 -top-1.5 grid size-7 place-items-center rounded-full border border-borde bg-white shadow">
                    <X className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {puedeFotos ? (
            <BotonesCamara onArchivos={(files) => setArchivos({ files, n: Date.now() })} />
          ) : (
            <p className="text-xs text-tenue">No tenés permiso para sacar fotografías.</p>
          )}
          {candidatas.length > 0 && (
            <details className="rounded-card border border-borde">
              <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium">Usar una foto ya tomada de esta orden ({candidatas.length})</summary>
              <ul className="grid grid-cols-4 gap-2 px-3 pb-3 sm:grid-cols-5">
                {candidatas.map((f) => (
                  <li key={f.id}>
                    <button type="button" aria-label="Agregar esta foto al daño" onClick={() => setD((x) => ({ ...x, fotos: x.fotos.length < 12 ? [...x.fotos, f.id] : x.fotos }))} className="block aspect-square w-full overflow-hidden rounded-ctl border border-borde active:opacity-70">
                      <img src={urlMiniatura(f.id)} alt="" loading="lazy" className="size-full object-cover" />
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
        {!ok && <Insignia tono="gris">Escribí una descripción o agregá una foto para guardar</Insignia>}
      </div>

      {archivos && (
        <ConfirmarSubida
          key={archivos.n}
          archivos={archivos.files}
          campos={{ vehiculo_id: vehiculoId, orden_id: ordenId, etapa: tipo }}
          titulo="Fotografías del daño"
          onCerrar={() => setArchivos(null)}
          onGuardadas={(ids) => setD((x) => ({ ...x, fotos: [...x.fotos, ...ids].slice(0, 12) }))}
        />
      )}
    </Modal>
  );
}
