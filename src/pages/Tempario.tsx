// Tempario: operaciones de mantenimiento y reparación del taller con su tiempo estimado, su precio de mano de obra y, opcionalmente,
// tiempos específicos por marca, modelo, motorización o años. Cada taller configura lo suyo; la plantilla general es solo un punto de partida.
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, DownloadCloud, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { money } from '@/lib/format';
import { Aviso, Boton, Buscador, Campo, Check, Encabezado, Input, InputMoneda, Insignia, Modal, Select, Tabla, Tarjeta, Textarea, useConfirmar, useToast } from '@/components/ui';
import { useMarcas } from '@/components/selectores';
import { TIPOS_VEHICULO, TIPO_VEHICULO_LABEL } from '@shared/dominio';
import { AVISO_TIEMPOS_ORIENTATIVOS, formatearMinutos, precioPorTiempo } from '@shared/tempario';

/** Costo horario INTERNO de la mano de obra (confidencial): general y por persona. Solo con permisos económicos. */
function CostosManoObra() {
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useAuth();
  const edita = puede('precios.gestionar');
  const { data } = useQuery({ queryKey: ['costos-mano-obra'], queryFn: () => api.get<any>('/costos-mano-obra') });
  const [f, setF] = useState<{ general: number | null; personas: Record<string, number | null> } | null>(null);
  const actual = f ?? (data ? { general: data.general as number | null, personas: Object.fromEntries(data.personas.map((x: any) => [x.usuario_id, x.costo_hora])) as Record<string, number | null> } : null);
  const guardar = useMutation({
    mutationFn: () => api.put('/costos-mano-obra', { general: actual!.general, personas: Object.entries(actual!.personas).map(([usuario_id, costo_hora]) => ({ usuario_id, costo_hora })) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['costos-mano-obra'] }); setF(null); toast.ok('Costos guardados'); },
    onError: toast.error,
  });
  if (!actual || !data) return null;
  return (
    <Tarjeta titulo="Costo interno de la mano de obra" subtitulo="Confidencial: lo que le cuesta al taller una hora de trabajo. Se usa solo para calcular la rentabilidad; no se muestra a quienes no tienen permisos económicos" className="mb-5"
      acciones={edita && f && <><Boton tam="sm" onClick={() => setF(null)}>Descartar</Boton><Boton tam="sm" variante="primario" cargando={guardar.isPending} onClick={() => guardar.mutate()}>Guardar costos</Boton></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Campo label="Costo general por hora" hint="Se usa para quien no tiene un costo propio. En blanco = sin costo general (la rentabilidad queda parcial)">
          <InputMoneda value={actual.general ?? 0} onChange={(v) => setF({ ...actual, general: v || null })} disabled={!edita} />
        </Campo>
        <Aviso tono="ambar">Cambiar un costo no modifica la rentabilidad de lo ya trabajado: cada tramo del cronómetro guarda el costo vigente cuando se cierra.</Aviso>
      </div>
      <details className="mt-4" open={data.personas.some((x: any) => x.mecanico)}>
        <summary className="cursor-pointer text-sm font-medium">Costo por persona (opcional)</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.personas.filter((x: any) => x.activo).map((x: any) => (
            <Campo key={x.usuario_id} label={`${x.nombre}${x.mecanico ? ' · mecánico' : ''}`} hint="En blanco usa el general">
              <InputMoneda value={actual.personas[x.usuario_id] ?? 0} onChange={(v) => setF({ ...actual, personas: { ...actual.personas, [x.usuario_id]: v || null } })} disabled={!edita} />
            </Campo>
          ))}
        </div>
      </details>
      <p className="mt-3 text-xs text-tenue">No es una liquidación de sueldos. Tarifa de venta actual: {money(data.tarifa_hora)} por hora.</p>
    </Tarjeta>
  );
}

function Tarifas({ cats }: { cats: any[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useAuth();
  const edita = puede('precios.gestionar') && puede('catalogo.editar');
  const { data } = useQuery({ queryKey: ['tempario', 'tarifas'], queryFn: () => api.get<{ tarifa_hora: number; categorias: Array<{ id: string; nombre: string; tarifa_hora: number | null }> }>('/tempario/tarifas') });
  const [f, setF] = useState<{ tarifa_hora: number; categorias: Record<string, number | null> } | null>(null);
  const actual = f ?? (data ? { tarifa_hora: data.tarifa_hora, categorias: Object.fromEntries(data.categorias.map((c) => [c.id, c.tarifa_hora])) } : null);
  const guardar = useMutation({
    mutationFn: () => api.put('/tempario/tarifas', { tarifa_hora: actual!.tarifa_hora, categorias: Object.entries(actual!.categorias).map(([id, tarifa_hora]) => ({ id, tarifa_hora })) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tempario'] }); qc.invalidateQueries({ queryKey: ['servicios'] }); setF(null); toast.ok('Tarifas guardadas'); },
    onError: toast.error,
  });
  if (!actual) return null;
  const ejemplo = precioPorTiempo(60, actual.tarifa_hora);
  return (
    <Tarjeta titulo="Tarifas de mano de obra" subtitulo="Las operaciones con precio “por tiempo” cuestan: tiempo estimado × tarifa por hora" className="mb-5"
      acciones={edita && f && <><Boton tam="sm" onClick={() => setF(null)}>Descartar</Boton><Boton tam="sm" variante="primario" cargando={guardar.isPending} onClick={() => guardar.mutate()}>Guardar tarifas</Boton></>}>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Campo label="Tarifa general por hora" hint={actual.tarifa_hora ? `Una hora de trabajo: ${money(ejemplo)}` : 'Todavía sin configurar'}>
          <InputMoneda value={actual.tarifa_hora} onChange={(v) => setF({ ...actual, tarifa_hora: v })} disabled={!edita} />
        </Campo>
      </div>
      {cats.length > 0 && (
        <details className="mt-4 rounded-card border border-borde px-3 py-2" open={Object.values(actual.categorias).some((v) => v)}>
          <summary className="cursor-pointer text-sm font-medium">Tarifas por categoría (opcional)</summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {cats.map((c) => (
              <Campo key={c.id} label={`Tarifa de ${c.nombre}`} hint="En blanco usa la general">
                <InputMoneda value={actual.categorias[c.id] ?? 0} onChange={(v) => setF({ ...actual, categorias: { ...actual.categorias, [c.id]: v || null } })} disabled={!edita} />
              </Campo>
            ))}
          </div>
        </details>
      )}
    </Tarjeta>
  );
}

function TiemposEspecificos({ servicio, puedeEditar }: { servicio: any; puedeEditar: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: marcas = [] } = useMarcas();
  const { data: reglas = [] } = useQuery({ queryKey: ['tempario', 'tiempos', servicio.id], queryFn: () => api.get<any[]>(`/tempario/servicios/${servicio.id}/tiempos`) });
  const vacio = { marca_id: '', modelo_id: '', motor: '', anio_desde: '', anio_hasta: '', tiempo_min: '' };
  const [n, setN] = useState(vacio);
  const modelos = marcas.find((m) => m.id === n.marca_id)?.modelos ?? [];
  const inv = () => { qc.invalidateQueries({ queryKey: ['tempario', 'tiempos', servicio.id] }); qc.invalidateQueries({ queryKey: ['servicios'] }); };
  const agregar = useMutation({
    mutationFn: () => api.post(`/tempario/servicios/${servicio.id}/tiempos`, {
      marca_id: n.marca_id || null, modelo_id: n.modelo_id || null, motor: n.motor || null,
      anio_desde: n.anio_desde ? Number(n.anio_desde) : null, anio_hasta: n.anio_hasta ? Number(n.anio_hasta) : null, tiempo_min: Number(n.tiempo_min),
    }),
    onSuccess: () => { inv(); setN(vacio); toast.ok('Tiempo específico agregado'); },
    onError: toast.error,
  });
  const quitar = useMutation({ mutationFn: (id: string) => api.del(`/tempario/tiempos/${id}`), onSuccess: inv, onError: toast.error });
  const criterio = (r: any) => [r.modelo ? `${r.marca} ${r.modelo}` : r.marca, r.motor ? `motor ${r.motor}` : null, r.anio_desde || r.anio_hasta ? `años ${r.anio_desde ?? '…'}–${r.anio_hasta ?? '…'}` : null].filter(Boolean).join(' · ');
  return (
    <div className="space-y-3 rounded-card border border-borde bg-slate-50/60 p-3">
      <div>
        <h4 className="text-sm font-semibold">Tiempos específicos (opcional)</h4>
        <p className="text-xs text-tenue">Si el vehículo coincide con una regla, se usa su tiempo en lugar del general ({formatearMinutos(servicio.tiempo_min)}). Gana la regla más específica: modelo, marca, motorización, años.</p>
      </div>
      {reglas.length > 0 && (
        <ul className="divide-y divide-borde rounded-ctl border border-borde bg-white text-sm">
          {reglas.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="min-w-0 truncate">{criterio(r)}</span>
              <span className="flex shrink-0 items-center gap-2"><strong className="tabular-nums">{formatearMinutos(r.tiempo_min)}</strong>
                {puedeEditar && <Boton variante="fantasma" tam="sm" aria-label="Quitar" icono={<Trash2 className="size-4 text-red-600" />} onClick={() => quitar.mutate(r.id)} />}</span>
            </li>
          ))}
        </ul>
      )}
      {puedeEditar && (
        <div className="grid gap-2 sm:grid-cols-6">
          <Select aria-label="Marca" className="sm:col-span-2" value={n.marca_id} onChange={(e) => setN({ ...n, marca_id: e.target.value, modelo_id: '' })}>
            <option value="">Cualquier marca</option>{marcas.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
          </Select>
          <Select aria-label="Modelo" className="sm:col-span-2" value={n.modelo_id} disabled={!n.marca_id} onChange={(e) => setN({ ...n, modelo_id: e.target.value })}>
            <option value="">Cualquier modelo</option>{modelos.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
          </Select>
          <Input aria-label="Motorización" className="sm:col-span-2" placeholder="Motor (ej.: 1.6 16v)" value={n.motor} onChange={(e) => setN({ ...n, motor: e.target.value })} />
          <Input aria-label="Año desde" className="sm:col-span-1" placeholder="Año desde" inputMode="numeric" value={n.anio_desde} onChange={(e) => setN({ ...n, anio_desde: e.target.value.replace(/\D/g, '').slice(0, 4) })} />
          <Input aria-label="Año hasta" className="sm:col-span-1" placeholder="Año hasta" inputMode="numeric" value={n.anio_hasta} onChange={(e) => setN({ ...n, anio_hasta: e.target.value.replace(/\D/g, '').slice(0, 4) })} />
          <Input aria-label="Tiempo en minutos" className="sm:col-span-2" placeholder="Tiempo (min)" inputMode="numeric" value={n.tiempo_min} onChange={(e) => setN({ ...n, tiempo_min: e.target.value.replace(/\D/g, '') })} />
          <Boton variante="primario" className="sm:col-span-2" icono={<Plus className="size-4" />} cargando={agregar.isPending}
            disabled={!n.tiempo_min || Number(n.tiempo_min) < 1 || (!n.marca_id && !n.motor && !n.anio_desde && !n.anio_hasta)} onClick={() => agregar.mutate()}>Agregar regla</Boton>
        </div>
      )}
    </div>
  );
}

function ImportarPlantilla({ onCerrar }: { onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['tempario', 'plantilla'], queryFn: () => api.get<{ aviso: string; operaciones: any[] }>('/tempario/plantilla') });
  const [sel, setSel] = useState<Set<string> | null>(null);
  const ops = data?.operaciones ?? [];
  const pendientes = ops.filter((o) => o.estado !== 'existente');
  const elegidas = sel ?? new Set(pendientes.map((o) => o.codigo));
  const importar = useMutation({
    mutationFn: () => api.post<{ creadas: number; completadas: number }>('/tempario/plantilla/importar', { codigos: [...elegidas] }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['servicios'] }); qc.invalidateQueries({ queryKey: ['categorias-servicio'] }); qc.invalidateQueries({ queryKey: ['tempario'] }); toast.ok(`${r.creadas} operaciones nuevas, ${r.completadas} con tiempo completado`); onCerrar(); },
    onError: toast.error,
  });
  const cats = [...new Set(ops.map((o) => o.categoria))];
  return (
    <Modal abierto onCerrar={onCerrar} titulo="Plantilla general de operaciones" ancho="xl" pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" disabled={!elegidas.size} cargando={importar.isPending} onClick={() => importar.mutate()}>Copiar {elegidas.size} al taller</Boton></>}>
      <div className="space-y-4">
        <Aviso tono="ambar">{data?.aviso ?? AVISO_TIEMPOS_ORIENTATIVOS} Se copian a tu taller y quedan marcados como “orientativos” hasta que los revises. A las operaciones que ya tenés solo se les completa el tiempo si estaba vacío: no se tocan tus precios.</Aviso>
        {cats.map((cat) => (
          <div key={cat}>
            <h4 className="mb-1 text-sm font-semibold">{cat}</h4>
            <ul className="divide-y divide-borde rounded-ctl border border-borde text-sm">
              {ops.filter((o) => o.categoria === cat).map((o) => (
                <li key={o.codigo} className="flex items-center justify-between gap-3 px-3 py-2">
                  <Check checked={elegidas.has(o.codigo)} disabled={o.estado === 'existente'} onChange={(v) => { const s = new Set(elegidas); if (v) s.add(o.codigo); else s.delete(o.codigo); setSel(s); }} label={<span><span className="mr-2 font-mono text-xs text-tenue">{o.codigo}</span>{o.nombre}</span>} />
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="tabular-nums text-tenue">{formatearMinutos(o.tiempo_min)}</span>
                    {o.estado === 'existente' ? <Insignia tono="gris">Ya la tenés</Insignia> : o.estado === 'completa_tiempo' ? <Insignia tono="azul">Completa el tiempo</Insignia> : <Insignia tono="verde">Nueva</Insignia>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function Tempario() {
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useAuth();
  const { confirmar, dialogo } = useConfirmar();
  const edita = puede('catalogo.editar');
  const verPrecios = puede('precios.venta.ver');
  const { data: servicios = [] } = useQuery({ queryKey: ['servicios', 'todos'], queryFn: () => api.get<any[]>('/servicios?todos=1') });
  const { data: cats = [] } = useQuery({ queryKey: ['categorias-servicio'], queryFn: () => api.get<any[]>('/categorias-servicio') });
  const [f, setF] = useState<any>(null);
  const [ajuste, setAjuste] = useState<any>(null);
  const [plantilla, setPlantilla] = useState(false);
  const [nuevaCat, setNuevaCat] = useState('');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [soloOrient, setSoloOrient] = useState(false);
  const inv = () => { qc.invalidateQueries({ queryKey: ['servicios'] }); qc.invalidateQueries({ queryKey: ['categorias-servicio'] }); qc.invalidateQueries({ queryKey: ['tempario'] }); };

  const guardar = useMutation({
    mutationFn: () => {
      const d: Record<string, unknown> = {
        categoria_id: f.categoria_id || null, codigo: f.codigo || null, nombre: f.nombre, descripcion: f.descripcion, tipo_vehiculo: f.tipo_vehiculo,
        tiempo_min: f.tiempo_min ? Number(f.tiempo_min) : null,
        intervalo_km: f.intervalo_km ? Number(f.intervalo_km) : null, intervalo_meses: f.intervalo_meses ? Number(f.intervalo_meses) : null, checks: f.checks, activo: f.activo,
        ...(verPrecios ? { modo_precio: f.modo_precio, precio: f.modo_precio === 'fijo' ? f.precio : f.precio_cargado ?? f.precio } : f.id ? {} : { precio: 0 }),
      };
      // Confirmar un tiempo orientativo lo vuelve propio del taller.
      if (f.id && f.origen === 'plantilla' && f.confirmar) d.origen = 'propio';
      return f.id ? api.put(`/servicios/${f.id}`, d) : api.post('/servicios', d);
    },
    onSuccess: () => { inv(); setF(null); toast.ok('Operación guardada'); },
    onError: toast.error,
  });
  const masivo = useMutation({
    mutationFn: () => api.post('/servicios/ajuste-masivo', { categoria_id: ajuste.categoria_id || null, porcentaje: Number(ajuste.porcentaje), redondeo: ajuste.redondeo }),
    onSuccess: (r) => { inv(); setAjuste(null); toast.ok(`${r.actualizados} precios fijos actualizados (los precios por tiempo se ajustan con la tarifa)`); },
    onError: toast.error,
  });
  const crearCat = useMutation({ mutationFn: () => api.post('/categorias-servicio', { nombre: nuevaCat, orden: cats.length }), onSuccess: () => { inv(); setNuevaCat(''); }, onError: toast.error });

  const filtradas = useMemo(
    () => servicios.filter((s) => (!cat || (s.categoria_id ?? '') === cat) && (!soloOrient || s.origen === 'plantilla') && (!q || `${s.nombre} ${s.codigo ?? ''}`.toLowerCase().includes(q.toLowerCase()))),
    [servicios, q, cat, soloOrient],
  );
  const orientativas = servicios.filter((s) => s.origen === 'plantilla').length;
  const sinTiempo = servicios.filter((s) => s.activo && !s.tiempo_min).length;

  return (
    <>
      {dialogo}
      <Encabezado
        titulo="Tempario"
        subtitulo="Operaciones de mantenimiento y reparación con su tiempo estimado y su mano de obra"
        acciones={edita && (
          <>
            <Boton icono={<DownloadCloud className="size-4" />} onClick={() => setPlantilla(true)}>Plantilla de operaciones</Boton>
            {verPrecios && puede('precios.gestionar') && <Boton onClick={() => setAjuste({ categoria_id: '', porcentaje: 10, redondeo: '100' })}>Ajuste masivo de precios</Boton>}
            <Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => setF({ nombre: '', codigo: '', categoria_id: cats[0]?.id ?? '', precio: 0, modo_precio: 'fijo', tiempo_min: '', tipo_vehiculo: 'todos', intervalo_km: '', intervalo_meses: '', checks: [], activo: true, descripcion: '' })}>Nueva operación</Boton>
          </>
        )}
      />
      <Aviso tono="ambar" className="mb-5">{AVISO_TIEMPOS_ORIENTATIVOS}{orientativas ? ` Tenés ${orientativas} operaciones con tiempo orientativo para revisar.` : ''}</Aviso>
      {verPrecios && puede('catalogo.ver') && <Tarifas cats={cats} />}
      {puede('margenes.ver') && <CostosManoObra />}

      <Tarjeta
        titulo="Operaciones"
        subtitulo={sinTiempo ? `${sinTiempo} operaciones activas todavía sin tiempo estimado` : undefined}
        sinPadding
        acciones={<Check checked={soloOrient} onChange={setSoloOrient} label="Solo orientativas" className="text-xs" />}
      >
        <div className="flex flex-col gap-2 border-b border-borde p-3 sm:flex-row">
          <Buscador value={q} onChange={setQ} placeholder="Buscar por nombre o código" className="flex-1" />
          <Select aria-label="Categoría" value={cat} onChange={(e) => setCat(e.target.value)} className="sm:w-60">
            <option value="">Todas las categorías</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </Select>
        </div>
        <Tabla
          filas={filtradas}
          clave={(s) => s.id}
          onFila={edita ? (s) => setF({ ...s, activo: !!s.activo, tiempo_min: s.tiempo_min ?? '', intervalo_km: s.intervalo_km ?? '', intervalo_meses: s.intervalo_meses ?? '', codigo: s.codigo ?? '', precio: s.precio_cargado ?? s.precio, confirmar: false }) : undefined}
          columnas={[
            { clave: 'k', titulo: 'Código', render: (s) => <span className="font-mono text-xs text-tenue">{s.codigo ?? '—'}</span>, movil: 'oculta' },
            { clave: 'n', titulo: 'Operación', render: (s) => <span className={s.activo ? 'font-medium' : 'text-tenue line-through'}>{s.nombre}</span>, movil: 'titulo' },
            { clave: 'c', titulo: 'Categoría', render: (s) => s.categoria ?? '—', movil: 'subtitulo' },
            { clave: 't', titulo: 'Tiempo', className: 'whitespace-nowrap', render: (s) => s.tiempo_min ? <span className="inline-flex items-center gap-1.5"><Clock className="size-3.5 text-tenue" />{formatearMinutos(s.tiempo_min)}{s.origen === 'plantilla' && <Insignia tono="ambar">Orientativo</Insignia>}</span> : <span className="text-tenue">Sin tiempo</span>, movil: 'meta' },
            ...(verPrecios ? [{ clave: 'p', titulo: 'Mano de obra', alinear: 'derecha' as const, render: (s: any) => <span>{money(s.precio)}{s.modo_precio === 'por_tiempo' && <span className="ml-1 text-xs text-tenue">(por tiempo)</span>}</span>, movil: 'derecha' as const }] : []),
            { clave: 'i', titulo: 'Intervalo', render: (s) => [s.intervalo_km ? `${s.intervalo_km.toLocaleString('es-AR')} km` : null, s.intervalo_meses ? `${s.intervalo_meses} meses` : null].filter(Boolean).join(' / ') || '—', movil: 'oculta' },
          ]}
        />
      </Tarjeta>

      {edita && (
        <Tarjeta titulo="Categorías" className="mt-5">
          <div className="flex flex-wrap gap-2">{cats.map((c) => <Insignia key={c.id} className="px-3 py-1 text-sm">{c.nombre}</Insignia>)}</div>
          <div className="mt-3 flex max-w-md gap-2">
            <Input value={nuevaCat} onChange={(e) => setNuevaCat(e.target.value)} placeholder="Nueva categoría" />
            <Boton disabled={!nuevaCat.trim()} onClick={() => crearCat.mutate()}>Agregar</Boton>
          </div>
        </Tarjeta>
      )}

      {f && (
        <Modal abierto onCerrar={() => setF(null)} titulo={f.id ? 'Editar operación' : 'Nueva operación'} ancho="xl" pie={<><Boton onClick={() => setF(null)}>Cancelar</Boton><Boton variante="primario" disabled={f.nombre.trim().length < 2} cargando={guardar.isPending} onClick={() => guardar.mutate()}>Guardar</Boton></>}>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Campo label="Código"><Input value={f.codigo} onChange={(e) => setF({ ...f, codigo: e.target.value })} placeholder="Ej.: FRE-001" /></Campo>
              <Campo label="Nombre" requerido className="sm:col-span-2"><Input value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} autoFocus /></Campo>
              <Campo label="Categoría">
                <Select value={f.categoria_id ?? ''} onChange={(e) => setF({ ...f, categoria_id: e.target.value })}>
                  <option value="">Sin categoría</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                </Select>
              </Campo>
              <Campo label="Tiempo estimado (minutos)" hint={f.tiempo_min ? formatearMinutos(Number(f.tiempo_min)) : 'Tiempo general de la operación'}>
                <Input value={f.tiempo_min} onChange={(e) => setF({ ...f, tiempo_min: e.target.value.replace(/\D/g, '').slice(0, 4) })} inputMode="numeric" />
              </Campo>
              <Campo label="Tipo de vehículo">
                <Select value={f.tipo_vehiculo} onChange={(e) => setF({ ...f, tipo_vehiculo: e.target.value })}>{TIPOS_VEHICULO.map((t) => <option key={t} value={t}>{TIPO_VEHICULO_LABEL[t]}</option>)}</Select>
              </Campo>
              <Campo label="Descripción" className="sm:col-span-3" hint="Se incorpora al presupuesto o a la orden de trabajo"><Textarea rows={2} value={f.descripcion ?? ''} onChange={(e) => setF({ ...f, descripcion: e.target.value })} /></Campo>
            </div>
            {f.origen === 'plantilla' && f.id && (
              <Aviso tono="ambar">
                <Check checked={!!f.confirmar} onChange={(v) => setF({ ...f, confirmar: v })} label="Revisé este tiempo orientativo y lo confirmo como propio del taller" />
              </Aviso>
            )}
            {verPrecios && (
              <div className="grid gap-3 rounded-card border border-borde p-3 sm:grid-cols-2">
                <Campo label="Cómo se calcula la mano de obra">
                  <Select value={f.modo_precio} onChange={(e) => setF({ ...f, modo_precio: e.target.value })}>
                    <option value="fijo">Precio fijo</option>
                    <option value="por_tiempo">Por tiempo (tiempo × tarifa por hora)</option>
                  </Select>
                </Campo>
                {f.modo_precio === 'fijo' ? (
                  <Campo label="Precio de mano de obra"><InputMoneda value={f.precio} onChange={(v) => setF({ ...f, precio: v })} /></Campo>
                ) : (
                  <Campo label="Precio calculado" hint={f.tarifa_hora ? `Con la tarifa de ${money(f.tarifa_hora)} por hora` : 'Configurá la tarifa por hora para calcularlo'}>
                    <Input disabled value={f.tiempo_min && f.tarifa_hora ? money(precioPorTiempo(Number(f.tiempo_min), f.tarifa_hora)) : '—'} />
                  </Campo>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 sm:max-w-md">
              <Campo label="Mantenimiento cada (km)"><Input value={f.intervalo_km} onChange={(e) => setF({ ...f, intervalo_km: e.target.value.replace(/\D/g, '') })} inputMode="numeric" /></Campo>
              <Campo label="o cada (meses)"><Input value={f.intervalo_meses} onChange={(e) => setF({ ...f, intervalo_meses: e.target.value.replace(/\D/g, '') })} inputMode="numeric" /></Campo>
            </div>
            <Campo label="Incluye (uno por línea)" hint="Ej.: filtro de aceite, filtro de aire…">
              <Textarea rows={3} value={(f.checks ?? []).join('\n')} onChange={(e) => setF({ ...f, checks: e.target.value.split('\n').map((x: string) => x.trim()).filter(Boolean) })} />
            </Campo>
            {f.id && <Check checked={f.activo} onChange={(v) => setF({ ...f, activo: v })} label="Activa (visible al cargar trabajos)" />}
            {f.id ? <TiemposEspecificos servicio={f} puedeEditar={edita} /> : <p className="text-xs text-tenue">Guardá la operación para poder cargar tiempos específicos por marca, modelo, motorización o años.</p>}
          </div>
        </Modal>
      )}

      {ajuste && (
        <Modal abierto onCerrar={() => setAjuste(null)} titulo="Ajuste masivo de precios fijos" ancho="sm" pie={<><Boton onClick={() => setAjuste(null)}>Cancelar</Boton><Boton variante="primario" cargando={masivo.isPending} onClick={async () => { if (await confirmar('Aplicar ajuste', `Se modificarán los precios fijos ${ajuste.categoria_id ? 'de la categoría' : 'de todas las operaciones'} en ${ajuste.porcentaje}%.`)) masivo.mutate(); }}>Aplicar</Boton></>}>
          <div className="space-y-3">
            <Campo label="Categoría">
              <Select value={ajuste.categoria_id} onChange={(e) => setAjuste({ ...ajuste, categoria_id: e.target.value })}>
                <option value="">Todas</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </Select>
            </Campo>
            <Campo label="Porcentaje (negativo para bajar)"><Input type="number" value={ajuste.porcentaje} onChange={(e) => setAjuste({ ...ajuste, porcentaje: e.target.value })} /></Campo>
            <Campo label="Redondeo">
              <Select value={ajuste.redondeo} onChange={(e) => setAjuste({ ...ajuste, redondeo: e.target.value })}>
                <option value="ninguno">Sin redondeo</option><option value="10">A múltiplo de $10</option><option value="100">A múltiplo de $100</option><option value="1000">A múltiplo de $1.000</option>
              </Select>
            </Campo>
            <p className="text-xs text-tenue">Las operaciones con precio por tiempo no se ven afectadas: cambian al modificar la tarifa por hora.</p>
          </div>
        </Modal>
      )}
      {plantilla && <ImportarPlantilla onCerrar={() => setPlantilla(false)} />}
    </>
  );
}
