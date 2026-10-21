// Panel de asistencia del propietario: presentes y ausentes, jornadas, horas por persona, correcciones y exportación.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Download, History, Pencil, Plus, UserCheck, UserX, Ban } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { descargarCSV } from '@/lib/csv';
import { diaCorto, duracion, fechaHoraZona, horaZona, horasDecimal, hoyISO } from '@/lib/format';
import { Aviso, Boton, Campo, Cargando, Encabezado, ErrorCaja, Indicador, Input, Insignia, Modal, Pestanas, Select, Tabla, Tarjeta, Textarea, useToast } from '@/components/ui';
import { primerDiaMes, SelectorPeriodo } from '@/components/Periodo';

type Tab = 'hoy' | 'registros' | 'resumen';

export function PanelAsistencia() {
  const { puede } = useAuth();
  const [tab, setTab] = useState<Tab>('hoy');
  return (
    <>
      <Encabezado titulo="Panel de asistencia" subtitulo="Quién está en el taller, jornadas, horas trabajadas y correcciones" />
      <Pestanas items={[{ clave: 'hoy', titulo: 'Hoy' }, { clave: 'registros', titulo: 'Fichajes' }, { clave: 'resumen', titulo: 'Resumen por período' }]} activo={tab} onCambio={setTab} />
      {tab === 'hoy' && <Hoy />}
      {tab === 'registros' && <Registros puedeCorregir={puede('asistencia.corregir')} puedeExportar={puede('informes.exportar')} />}
      {tab === 'resumen' && <Resumen puedeExportar={puede('informes.exportar')} />}
    </>
  );
}

function Hoy() {
  const [fecha, setFecha] = useState('');
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['asistencia', 'panel', fecha], queryFn: () => api.get(`/asistencia/panel${qs({ fecha })}`), refetchInterval: 30_000 });
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  const zona = data.zona as string;
  const t = data.totales;
  const esHoy = data.fecha === data.hoy;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <Campo label="Día"><Input type="date" value={data.fecha} max={data.hoy} onChange={(e) => setFecha(e.target.value)} /></Campo>
        {!esHoy && <Boton onClick={() => setFecha('')}>Volver a hoy</Boton>}
        <p className="mb-2 text-xs text-tenue">Horarios en la zona horaria del taller ({zona.replace('America/', '').replace(/_/g, ' ')}).</p>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Indicador titulo="Presentes ahora" valor={t.presentes} detalle={`de ${t.personal} personas`} icono={<UserCheck className="size-5" />} tono="verde" />
        <Indicador titulo={esHoy ? 'Ausentes hoy' : 'Sin fichajes ese día'} valor={t.ausentes} icono={<UserX className="size-5" />} tono="ambar" />
        <Indicador titulo="Jornadas abiertas" valor={t.jornadas_abiertas} detalle={t.jornadas_largas ? `${t.jornadas_largas} con más de 16 h` : undefined} icono={<AlertTriangle className="size-5" />} tono={t.jornadas_largas ? 'rojo' : 'azul'} />
        <Indicador titulo="Horas del día" valor={duracion(t.horas_dia_seg)} icono={<History className="size-5" />} tono="violeta" />
      </div>

      {t.jornadas_largas > 0 && <Aviso tono="rojo">Hay jornadas abiertas hace más de 16 horas: probablemente falta registrar una salida. Corregilas desde la pestaña "Fichajes".</Aviso>}

      <div className="grid gap-5 lg:grid-cols-2">
        <Tarjeta titulo="Presentes (jornada abierta)" sinPadding>
          <Tabla
            filas={data.presentes as any[]}
            clave={(j) => j.id}
            vacio={<p className="px-4 py-6 text-center text-sm text-tenue">Nadie con jornada abierta.</p>}
            columnas={[
              { clave: 'n', titulo: 'Persona', render: (j) => <span className="font-medium">{j.empleado}{j.cargo ? <span className="block text-xs font-normal text-tenue">{j.cargo}</span> : null}</span>, movil: 'titulo' },
              { clave: 'e', titulo: 'Entró', render: (j) => (j.fecha === data.hoy ? horaZona(j.entrada_at, zona) : fechaHoraZona(j.entrada_at, zona)), movil: 'meta' },
              { clave: 'd', titulo: 'Lleva', render: (j) => <span className={j.larga ? 'font-semibold text-red-600' : ''}>{duracion(j.duracion_actual_seg)}</span>, movil: 'derecha' },
              { clave: 'o', titulo: 'Origen', render: (j) => <Insignia>{j.origen_entrada === 'reloj' ? 'Reloj' : j.origen_entrada === 'manual' ? 'Manual' : 'Sistema'}</Insignia>, movil: 'oculta' },
            ]}
          />
        </Tarjeta>
        <Tarjeta titulo={esHoy ? 'Ausentes hoy' : 'Sin fichajes ese día'} sinPadding>
          <Tabla
            filas={data.ausentes as any[]}
            clave={(a) => a.usuario_id}
            vacio={<p className="px-4 py-6 text-center text-sm text-tenue">Todo el personal fichó.</p>}
            columnas={[
              { clave: 'n', titulo: 'Persona', render: (a) => <span className="font-medium">{a.empleado}</span>, movil: 'titulo' },
              { clave: 'c', titulo: 'Cargo', render: (a) => a.cargo ?? '—', movil: 'subtitulo' },
            ]}
          />
        </Tarjeta>
      </div>

      <Tarjeta titulo="Entradas y salidas del día" sinPadding>
        <Tabla
          filas={data.jornadas as any[]}
          clave={(j) => j.id}
          vacio={<p className="px-4 py-6 text-center text-sm text-tenue">Sin fichajes ese día.</p>}
          columnas={[
            { clave: 'n', titulo: 'Persona', render: (j) => <span className="font-medium">{j.empleado}</span>, movil: 'titulo' },
            { clave: 'e', titulo: 'Entrada', render: (j) => horaZona(j.entrada_at, zona), movil: 'meta' },
            { clave: 's', titulo: 'Salida', render: (j) => (j.salida_at ? horaZona(j.salida_at, zona) : <Insignia tono="verde">En curso</Insignia>), movil: 'meta' },
            { clave: 'd', titulo: 'Horas', render: (j) => duracion(j.duracion_actual_seg), movil: 'derecha' },
            { clave: 'c', titulo: '', render: (j) => (j.corregido ? <Insignia tono="ambar">Corregido</Insignia> : null), movil: 'meta' },
          ]}
        />
      </Tarjeta>
    </div>
  );
}

function usePersonal() {
  return useQuery({ queryKey: ['asistencia', 'personal'], queryFn: () => api.get<Array<{ id: string; nombre: string }>>('/asistencia/personal'), staleTime: 60_000 });
}

function Registros({ puedeCorregir, puedeExportar }: { puedeCorregir: boolean; puedeExportar: boolean }) {
  const [desde, setDesde] = useState(primerDiaMes());
  const [hasta, setHasta] = useState(hoyISO());
  const [usuario, setUsuario] = useState('');
  const [soloAbiertas, setSoloAbiertas] = useState(false);
  const { data: personal = [] } = usePersonal();
  const params = qs({ desde, hasta, usuario_id: usuario, abiertas: soloAbiertas });
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['asistencia', 'registros', params], queryFn: () => api.get(`/asistencia/registros${params}`), enabled: desde <= hasta });
  const [corregir, setCorregir] = useState<any>(null);
  const [historial, setHistorial] = useState<any>(null);
  const [anular, setAnular] = useState<any>(null);
  const [manual, setManual] = useState(false);
  const toast = useToast();
  const exportar = async () => {
    try {
      const r = await api.get(`/asistencia/registros${params}&exportar=1`);
      descargarCSV(`asistencia-${desde}_${hasta}`, ['Fecha', 'Persona', 'Entrada', 'Salida', 'Horas', 'Duración (h)', 'Origen entrada', 'Origen salida', 'Corregido'],
        r.filas.map((j: any) => [j.fecha, j.empleado, horaZona(j.entrada_at, r.zona), j.salida_at ? horaZona(j.salida_at, r.zona) : 'abierta', duracion(j.duracion_actual_seg), horasDecimal(j.duracion_actual_seg), j.origen_entrada, j.origen_salida ?? '', j.corregido ? 'Sí' : 'No']));
    } catch (e) { toast.error(e); }
  };
  return (
    <>
      <SelectorPeriodo desde={desde} hasta={hasta} onCambio={(d, h) => { setDesde(d); setHasta(h); }} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Campo label="Persona"><Select value={usuario} onChange={(e) => setUsuario(e.target.value)} className="w-56"><option value="">Todas</option>{personal.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</Select></Campo>
        <label className="mb-2 flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-marca-600" checked={soloAbiertas} onChange={(e) => setSoloAbiertas(e.target.checked)} /> Solo jornadas abiertas</label>
        <div className="ml-auto flex gap-2">
          {puedeExportar && <Boton icono={<Download className="size-4" />} onClick={exportar} disabled={!data?.filas.length}>Exportar CSV</Boton>}
          {puedeCorregir && <Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => setManual(true)}>Cargar fichaje</Boton>}
        </div>
      </div>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={data.filas as any[]}
            clave={(j) => j.id}
            vacio={<p className="px-4 py-8 text-center text-sm text-tenue">No hay fichajes en el período.</p>}
            columnas={[
              { clave: 'f', titulo: 'Día', render: (j) => <span className="capitalize">{diaCorto(j.fecha)}</span>, movil: 'subtitulo' },
              { clave: 'n', titulo: 'Persona', render: (j) => <span className="font-medium">{j.empleado}</span>, movil: 'titulo' },
              { clave: 'e', titulo: 'Entrada', render: (j) => horaZona(j.entrada_at, data.zona), movil: 'meta' },
              { clave: 's', titulo: 'Salida', render: (j) => (j.salida_at ? horaZona(j.salida_at, data.zona) : <Insignia tono={j.larga ? 'rojo' : 'verde'}>{j.larga ? 'Abierta +16 h' : 'En curso'}</Insignia>), movil: 'meta' },
              { clave: 'd', titulo: 'Horas', render: (j) => duracion(j.duracion_actual_seg), movil: 'derecha' },
              { clave: 'o', titulo: 'Origen', render: (j) => <span className="text-tenue">{j.origen_entrada === 'reloj' ? 'Reloj' : j.origen_entrada === 'manual' ? 'Manual' : 'Sistema'}</span>, movil: 'oculta' },
              {
                clave: 'x', titulo: '', movil: 'meta',
                render: (j) => (
                  <div className="flex items-center justify-end gap-1">
                    {j.corregido ? <Insignia tono="ambar">Corregido</Insignia> : null}
                    {j.correcciones > 0 && <Boton tam="sm" variante="fantasma" icono={<History className="size-4" />} aria-label="Ver historial de correcciones" onClick={() => setHistorial(j)} />}
                    {puedeCorregir && <Boton tam="sm" variante="fantasma" icono={<Pencil className="size-4" />} aria-label="Corregir" onClick={() => setCorregir(j)} />}
                    {puedeCorregir && <Boton tam="sm" variante="fantasma" icono={<Ban className="size-4" />} aria-label="Anular" onClick={() => setAnular(j)} />}
                  </div>
                ),
              },
            ]}
          />
        </Tarjeta>
      )}
      {corregir && <CorreccionModal j={corregir} zona={data.zona} onCerrar={() => setCorregir(null)} />}
      {anular && <AnularModal j={anular} onCerrar={() => setAnular(null)} />}
      {historial && <HistorialModal j={historial} zona={data.zona} onCerrar={() => setHistorial(null)} />}
      {manual && <ManualModal personal={personal} onCerrar={() => setManual(false)} />}
    </>
  );
}

/** AAAA-MM-DD y HH:MM de un instante en la zona del taller. */
function partes(iso: string, zona: string) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const o: Record<string, string> = {};
  for (const p of f) o[p.type] = p.value;
  return { fecha: `${o.year}-${o.month}-${o.day}`, hora: `${o.hour}:${o.minute}` };
}

function CorreccionModal({ j, zona, onCerrar }: { j: any; zona: string; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const e0 = partes(j.entrada_at, zona);
  const s0 = j.salida_at ? partes(j.salida_at, zona) : { fecha: e0.fecha, hora: '' };
  const [e, setE] = useState(e0);
  const [s, setS] = useState(s0);
  const [motivo, setMotivo] = useState('');
  const m = useMutation({
    mutationFn: () => api.patch(`/asistencia/registros/${j.id}`, { entrada: e, ...(s.hora ? { salida: s } : {}), motivo }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['asistencia'] }); toast.ok('Fichaje corregido'); onCerrar(); },
    onError: toast.error,
  });
  return (
    <Modal abierto onCerrar={onCerrar} titulo={`Corregir fichaje · ${j.empleado}`} ancho="md" pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" cargando={m.isPending} disabled={motivo.trim().length < 5} onClick={() => m.mutate()}>Guardar corrección</Boton></>}>
      <div className="space-y-3">
        <Aviso tono="ambar">Queda registrado quién corrige, cuándo, el valor anterior, el nuevo y el motivo.</Aviso>
        <div className="grid gap-3 sm:grid-cols-2">
          <Campo label="Fecha de entrada"><Input type="date" value={e.fecha} onChange={(x) => setE({ ...e, fecha: x.target.value })} /></Campo>
          <Campo label="Hora de entrada"><Input type="time" value={e.hora} onChange={(x) => setE({ ...e, hora: x.target.value })} /></Campo>
          <Campo label="Fecha de salida" hint="Puede ser el día siguiente si cruza la medianoche"><Input type="date" value={s.fecha} onChange={(x) => setS({ ...s, fecha: x.target.value })} /></Campo>
          <Campo label="Hora de salida"><Input type="time" value={s.hora} onChange={(x) => setS({ ...s, hora: x.target.value })} /></Campo>
        </div>
        <Campo label="Motivo de la corrección" requerido><Textarea rows={2} value={motivo} onChange={(x) => setMotivo(x.target.value)} placeholder="Ej.: Olvidó fichar la salida" /></Campo>
      </div>
    </Modal>
  );
}

function AnularModal({ j, onCerrar }: { j: any; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [motivo, setMotivo] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/asistencia/registros/${j.id}/anular`, { motivo }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['asistencia'] }); toast.ok('Fichaje anulado'); onCerrar(); },
    onError: toast.error,
  });
  return (
    <Modal abierto onCerrar={onCerrar} titulo={`Anular fichaje · ${j.empleado}`} ancho="sm" pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="peligro" cargando={m.isPending} disabled={motivo.trim().length < 5} onClick={() => m.mutate()}>Anular</Boton></>}>
      <Campo label="Motivo" requerido hint="El registro no se borra: queda anulado con su historial."><Textarea rows={2} value={motivo} onChange={(x) => setMotivo(x.target.value)} /></Campo>
    </Modal>
  );
}

function ManualModal({ personal, onCerrar }: { personal: Array<{ id: string; nombre: string }>; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const hoy = hoyISO();
  const [f, setF] = useState({ usuario_id: '', ef: hoy, eh: '08:00', sf: hoy, sh: '17:00', motivo: '' });
  const m = useMutation({
    mutationFn: () => api.post('/asistencia/registros', { usuario_id: f.usuario_id, entrada: { fecha: f.ef, hora: f.eh }, ...(f.sh ? { salida: { fecha: f.sf, hora: f.sh } } : {}), motivo: f.motivo }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['asistencia'] }); toast.ok('Fichaje cargado'); onCerrar(); },
    onError: toast.error,
  });
  return (
    <Modal abierto onCerrar={onCerrar} titulo="Cargar un fichaje que faltó" ancho="md" pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" cargando={m.isPending} disabled={!f.usuario_id || f.motivo.trim().length < 5} onClick={() => m.mutate()}>Cargar</Boton></>}>
      <div className="space-y-3">
        <Campo label="Persona" requerido><Select value={f.usuario_id} onChange={(e) => setF({ ...f, usuario_id: e.target.value })}><option value="">Elegí una persona</option>{personal.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</Select></Campo>
        <div className="grid gap-3 sm:grid-cols-2">
          <Campo label="Fecha de entrada"><Input type="date" value={f.ef} max={hoy} onChange={(e) => setF({ ...f, ef: e.target.value })} /></Campo>
          <Campo label="Hora de entrada"><Input type="time" value={f.eh} onChange={(e) => setF({ ...f, eh: e.target.value })} /></Campo>
          <Campo label="Fecha de salida" hint="El día siguiente si cruza la medianoche"><Input type="date" value={f.sf} max={hoy} onChange={(e) => setF({ ...f, sf: e.target.value })} /></Campo>
          <Campo label="Hora de salida"><Input type="time" value={f.sh} onChange={(e) => setF({ ...f, sh: e.target.value })} /></Campo>
        </div>
        <Campo label="Motivo" requerido><Textarea rows={2} value={f.motivo} onChange={(e) => setF({ ...f, motivo: e.target.value })} placeholder="Ej.: No funcionaba la tablet" /></Campo>
        <p className="text-xs text-tenue">El fichaje queda marcado como manual y registra quién lo cargó.</p>
      </div>
    </Modal>
  );
}

function HistorialModal({ j, zona, onCerrar }: { j: any; zona: string; onCerrar: () => void }) {
  const { data, isLoading } = useQuery({ queryKey: ['asistencia', 'correcciones', j.id], queryFn: () => api.get(`/asistencia/registros/${j.id}/correcciones`) });
  const fmt = (x: any) => (x ? `${x.fecha} · ${horaZona(x.entrada_at, zona)} → ${x.salida_at ? horaZona(x.salida_at, zona) : 'abierta'} (${duracion(x.duracion_seg)})` : '—');
  return (
    <Modal abierto onCerrar={onCerrar} titulo={`Historial de correcciones · ${j.empleado}`} ancho="lg">
      {isLoading ? <Cargando /> : (
        <ul className="space-y-3 text-sm">
          {(data as any[]).map((c) => (
            <li key={c.id} className="rounded-lg border border-borde p-3">
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2"><Insignia tono={c.accion === 'anular' ? 'rojo' : c.accion === 'crear' ? 'azul' : 'ambar'}>{c.accion === 'crear' ? 'Carga manual' : c.accion === 'editar' ? 'Corrección' : 'Anulación'}</Insignia><span className="text-xs text-tenue">{fechaHoraZona(c.created_at, zona)} · {c.usuario}</span></div>
              <div className="grid gap-1 sm:grid-cols-2"><div><span className="text-xs text-tenue">Antes</span><div>{fmt(c.anterior)}</div></div><div><span className="text-xs text-tenue">Después</span><div>{fmt(c.nuevo)}</div></div></div>
              <p className="mt-1 text-tenue">Motivo: {c.motivo}</p>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function Resumen({ puedeExportar }: { puedeExportar: boolean }) {
  const [desde, setDesde] = useState(primerDiaMes());
  const [hasta, setHasta] = useState(hoyISO());
  const [usuario, setUsuario] = useState('');
  const [agrupar, setAgrupar] = useState<'empleado' | 'dia'>('empleado');
  const { data: personal = [] } = usePersonal();
  const params = qs({ desde, hasta, usuario_id: usuario, agrupar });
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['asistencia', 'resumen', params], queryFn: () => api.get(`/asistencia/resumen${params}`), enabled: desde <= hasta });
  const toast = useToast();
  const exportar = async () => {
    try {
      const r = await api.get(`/asistencia/resumen${params}&exportar=1`);
      descargarCSV(`resumen-asistencia-${desde}_${hasta}`, [...(agrupar === 'dia' ? ['Fecha'] : []), 'Persona', 'Jornadas', 'Días', 'Horas', 'Horas (decimal)', 'Promedio por día (h)', 'Jornadas abiertas'],
        r.filas.map((x: any) => [...(agrupar === 'dia' ? [x.fecha] : []), x.empleado, x.jornadas, x.dias, duracion(x.horas_seg), horasDecimal(x.horas_seg), horasDecimal(x.promedio_seg), x.abiertas]));
    } catch (e) { toast.error(e); }
  };
  return (
    <>
      <SelectorPeriodo desde={desde} hasta={hasta} onCambio={(d, h) => { setDesde(d); setHasta(h); }} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Campo label="Persona"><Select value={usuario} onChange={(e) => setUsuario(e.target.value)} className="w-56"><option value="">Todas</option>{personal.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</Select></Campo>
        <Campo label="Agrupar"><Select value={agrupar} onChange={(e) => setAgrupar(e.target.value as any)} className="w-44"><option value="empleado">Por persona</option><option value="dia">Por día</option></Select></Campo>
        {puedeExportar && <Boton className="ml-auto" icono={<Download className="size-4" />} onClick={exportar} disabled={!data?.filas.length}>Exportar CSV</Boton>}
      </div>
      <Aviso className="mb-4">Las horas de cada jornada se cuentan en el día en que empezó (una jornada nocturna que cruza la medianoche no se parte). Las jornadas abiertas suman hasta este momento.</Aviso>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding titulo={`Total del período: ${duracion(data.totales.horas_seg)} en ${data.totales.jornadas} jornadas`}>
          <Tabla
            filas={data.filas as any[]}
            clave={(x) => `${x.fecha ?? ''}|${x.usuario_id}`}
            vacio={<p className="px-4 py-8 text-center text-sm text-tenue">No hay fichajes en el período.</p>}
            columnas={[
              ...(agrupar === 'dia' ? [{ clave: 'f', titulo: 'Día', render: (x: any) => <span className="capitalize">{diaCorto(x.fecha)}</span>, movil: 'subtitulo' as const }] : []),
              { clave: 'n', titulo: 'Persona', render: (x: any) => <span className="font-medium">{x.empleado}</span>, movil: 'titulo' as const },
              { clave: 'j', titulo: 'Jornadas', render: (x: any) => x.jornadas, movil: 'meta' as const },
              ...(agrupar === 'empleado' ? [{ clave: 'd', titulo: 'Días', render: (x: any) => x.dias, movil: 'meta' as const }] : []),
              { clave: 'h', titulo: 'Horas trabajadas', render: (x: any) => <span className="font-semibold">{duracion(x.horas_seg)}</span>, movil: 'derecha' as const },
              { clave: 'p', titulo: 'Promedio / día', render: (x: any) => duracion(x.promedio_seg), movil: 'oculta' as const },
              { clave: 'a', titulo: '', render: (x: any) => (x.abiertas ? <Insignia tono="verde">{x.abiertas} abierta(s)</Insignia> : null), movil: 'meta' as const },
            ]}
          />
        </Tarjeta>
      )}
    </>
  );
}
