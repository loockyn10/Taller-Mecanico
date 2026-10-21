// Editor de ítems y totales compartido por presupuestos, órdenes de trabajo y ventas.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clock, Package, Plus, Trash2, Wrench } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { money } from '@/lib/format';
import { useDefectosDocumento } from '@/lib/config';
import { calcularTotales } from '@shared/totals';
import { formatearMinutos } from '@shared/tempario';
import { Boton, Buscador, Campo, cn, Input, InputMoneda, Insignia, Select, useDebounce } from './ui';

export interface ItemUI {
  key: string;
  tipo: 'articulo' | 'servicio' | 'libre';
  articulo_id?: string | null;
  servicio_id?: string | null;
  descripcion: string;
  cantidad: number;
  precio_unitario: number;
  desc_pct: number;
  stock?: number | null;
  /** Tiempo estimado de mano de obra (minutos por unidad), sugerido por el tempario y ajustable. */
  tiempo_min?: number | null;
}

export interface ParamsUI {
  desc_global_pct: number;
  desc_global_monto: number;
  iva_pct: number;
  recargo_pct: number;
}

export const paramsVacios = (iva = 0, recargo = 0): ParamsUI => ({ desc_global_pct: 0, desc_global_monto: 0, iva_pct: iva, recargo_pct: recargo });

/**
 * Aplica una sola vez el IVA y el recargo por defecto de la configuración del taller a un documento nuevo.
 * (Antes esos parámetros se guardaban pero ningún formulario los usaba.)
 */
export function useDefectosEnParams(aplicar: boolean, setParams: (f: (p: ParamsUI) => ParamsUI) => void) {
  const { listo, iva, recargo } = useDefectosDocumento();
  const hecho = useRef(false);
  useEffect(() => {
    if (aplicar && listo && !hecho.current) {
      hecho.current = true;
      setParams((p) => ({ ...p, iva_pct: iva, recargo_pct: recargo }));
    }
  }, [aplicar, listo, iva, recargo, setParams]);
}

const k = () => Math.random().toString(36).slice(2);

export function itemsDesdeApi(items: any[]): ItemUI[] {
  return items.map((i) => ({
    key: k(),
    tipo: i.tipo,
    articulo_id: i.articulo_id,
    servicio_id: i.servicio_id,
    descripcion: i.descripcion,
    cantidad: i.cantidad,
    precio_unitario: i.precio_unitario,
    desc_pct: i.desc_pct ?? 0,
    stock: i.articulo_stock ?? null,
    tiempo_min: i.tiempo_min ?? null,
  }));
}

export function itemsParaApi(items: ItemUI[]) {
  return items.map(({ tipo, articulo_id, servicio_id, descripcion, cantidad, precio_unitario, desc_pct, tiempo_min }) => ({
    tipo,
    articulo_id: tipo === 'articulo' ? articulo_id : null,
    servicio_id: tipo === 'servicio' ? servicio_id : null,
    descripcion,
    cantidad,
    precio_unitario,
    desc_pct,
    tiempo_min: tipo === 'servicio' ? tiempo_min ?? null : null,
  }));
}

function AgregarServicio({ onAgregar, listaId, vehiculoId }: { onAgregar: (i: ItemUI) => void; listaId?: string | null; vehiculoId?: string | null }) {
  // Con un vehículo elegido, el tempario devuelve el tiempo (y el precio por tiempo) que corresponde a ese vehículo.
  const { data: servicios = [] } = useQuery({
    queryKey: ['servicios', { listaId: listaId ?? null, vehiculoId: vehiculoId ?? null }],
    queryFn: () => api.get<any[]>(`/servicios${qs({ lista_id: listaId, vehiculo_id: vehiculoId })}`),
    staleTime: 60_000,
  });
  const [cat, setCat] = useState<string>('');
  const [q, setQ] = useState('');
  const categorias = useMemo(() => [...new Map(servicios.map((s) => [s.categoria_id ?? '', s.categoria ?? 'Sin categoría'])).entries()], [servicios]);
  const lista = servicios.filter((s) => (!cat || (s.categoria_id ?? '') === cat) && (!q || s.nombre.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => setCat('')} className={cn('rounded-full border px-2.5 py-1 text-xs font-medium', !cat ? 'border-marca-300 bg-marca-50 text-marca-700' : 'border-borde bg-white text-tenue')}>Todas</button>
        {categorias.map(([id, nombre]) => (
          <button key={id} type="button" onClick={() => setCat(id)} className={cn('rounded-full border px-2.5 py-1 text-xs font-medium', cat === id ? 'border-marca-300 bg-marca-50 text-marca-700' : 'border-borde bg-white text-tenue')}>
            {nombre}
          </button>
        ))}
      </div>
      <Buscador value={q} onChange={setQ} placeholder="Filtrar servicios…" />
      <ul className="max-h-60 divide-y divide-borde overflow-y-auto rounded-lg border border-borde bg-white text-sm">
        {lista.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-marca-50"
              onClick={() => onAgregar({ key: k(), tipo: 'servicio', servicio_id: s.id, descripcion: s.nombre, cantidad: 1, precio_unitario: s.precio_lista ?? s.precio, desc_pct: 0, tiempo_min: s.tiempo_efectivo_min ?? null })}
            >
              <span className="min-w-0">
                <span className="block truncate">{s.nombre}</span>
                <span className="flex flex-wrap items-center gap-x-2 text-xs text-tenue">
                  {s.categoria ?? 'Sin categoría'}
                  {s.tiempo_efectivo_min ? <span className="inline-flex items-center gap-1"><Clock className="size-3" />{formatearMinutos(s.tiempo_efectivo_min)}{s.tiempo_origen === 'especifico' ? ' · para este vehículo' : s.origen === 'plantilla' ? ' · orientativo' : ''}</span> : null}
                </span>
              </span>
              <span className="shrink-0 font-medium tabular-nums">{money(s.precio_lista ?? s.precio)}</span>
            </button>
          </li>
        ))}
        {!lista.length && <li className="px-3 py-3 text-tenue">No hay servicios. Cargalos en Configuración → Servicios.</li>}
      </ul>
    </div>
  );
}

function AgregarArticulo({ onAgregar, listaId }: { onAgregar: (i: ItemUI) => void; listaId?: string | null }) {
  const [q, setQ] = useState('');
  const dq = useDebounce(q);
  const { data = [] } = useQuery({ queryKey: ['articulos', { q: dq, sel: 1, listaId: listaId ?? null }], queryFn: () => api.get<any[]>(`/articulos?limite=20&q=${encodeURIComponent(dq)}${listaId ? `&lista_id=${listaId}` : ''}`), enabled: dq.length >= 1 });
  return (
    <div className="space-y-2">
      <Buscador value={q} onChange={setQ} placeholder="Buscar repuesto por nombre, código o marca…" autoFocus />
      {dq && (
        <ul className="max-h-60 divide-y divide-borde overflow-y-auto rounded-lg border border-borde bg-white text-sm">
          {data.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-marca-50"
                onClick={() => {
                  onAgregar({ key: k(), tipo: 'articulo', articulo_id: a.id, descripcion: a.nombre, cantidad: 1, precio_unitario: a.precio_lista ?? a.precio, desc_pct: 0, stock: a.stock });
                  setQ('');
                }}
              >
                <span className="min-w-0">
                  <span className="block truncate">{a.nombre}</span>
                  <span className="text-xs text-tenue">{[a.codigo, a.marca].filter(Boolean).join(' · ')}</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block font-medium tabular-nums">{money(a.precio_lista ?? a.precio)}</span>
                  <span className={cn('text-xs', a.stock <= 0 ? 'text-red-600' : a.stock <= a.stock_minimo ? 'text-amber-700' : 'text-tenue')}>Stock: {a.stock} {a.unidad}</span>
                </span>
              </button>
            </li>
          ))}
          {!data.length && <li className="px-3 py-3 text-tenue">Sin resultados</li>}
        </ul>
      )}
    </div>
  );
}

function AgregarLibre({ onAgregar }: { onAgregar: (i: ItemUI) => void }) {
  const [d, setD] = useState('');
  const [p, setP] = useState(0);
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <Input value={d} onChange={(e) => setD(e.target.value)} placeholder="Descripción (ej.: mano de obra adicional)" className="flex-1" />
      <InputMoneda value={p} onChange={setP} className="sm:w-40" />
      <Boton
        variante="primario"
        icono={<Plus className="size-4" />}
        disabled={!d.trim()}
        onClick={() => {
          onAgregar({ key: k(), tipo: 'libre', descripcion: d.trim(), cantidad: 1, precio_unitario: p, desc_pct: 0 });
          setD('');
          setP(0);
        }}
      >
        Agregar
      </Boton>
    </div>
  );
}

export function EditorItems({
  items, onItems, params, onParams, soloLectura, conArticulos = true, listaId, vehiculoId,
}: { items: ItemUI[]; onItems: (i: ItemUI[]) => void; params: ParamsUI; onParams: (p: ParamsUI) => void; soloLectura?: boolean; conArticulos?: boolean; listaId?: string | null; vehiculoId?: string | null }) {
  const [modo, setModo] = useState<'servicio' | 'articulo' | 'libre' | null>(null);
  const t = calcularTotales(items, params);
  const upd = (key: string, cambios: Partial<ItemUI>) => onItems(items.map((i) => (i.key === key ? { ...i, ...cambios } : i)));
  const agregar = (i: ItemUI) => {
    // Si el mismo artículo ya está cargado, suma cantidad en vez de duplicar la línea.
    const ex = i.tipo === 'articulo' ? items.find((x) => x.tipo === 'articulo' && x.articulo_id === i.articulo_id) : null;
    if (ex) upd(ex.key, { cantidad: ex.cantidad + 1 });
    else onItems([...items, i]);
  };

  return (
    <div className="space-y-4">
      {!soloLectura && (
        <div>
          <div className="flex flex-wrap gap-2">
            <Boton variante={modo === 'servicio' ? 'primario' : 'secundario'} icono={<Wrench className="size-4" />} onClick={() => setModo(modo === 'servicio' ? null : 'servicio')}>Mano de obra / servicio</Boton>
            {conArticulos && <Boton variante={modo === 'articulo' ? 'primario' : 'secundario'} icono={<Package className="size-4" />} onClick={() => setModo(modo === 'articulo' ? null : 'articulo')}>Repuesto</Boton>}
            <Boton variante={modo === 'libre' ? 'primario' : 'secundario'} icono={<Plus className="size-4" />} onClick={() => setModo(modo === 'libre' ? null : 'libre')}>Línea libre</Boton>
          </div>
          {modo && (
            <div className="mt-3 rounded-xl border border-borde bg-slate-50/60 p-3">
              {modo === 'servicio' && <AgregarServicio onAgregar={agregar} listaId={listaId} vehiculoId={vehiculoId} />}
              {modo === 'articulo' && <AgregarArticulo onAgregar={agregar} listaId={listaId} />}
              {modo === 'libre' && <AgregarLibre onAgregar={agregar} />}
            </div>
          )}
        </div>
      )}

      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-borde px-4 py-6 text-center text-sm text-tenue">Todavía no hay ítems cargados</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-borde">
          <div className="hidden grid-cols-[minmax(0,1fr)_70px_130px_70px_120px_36px] gap-2 border-b border-borde bg-slate-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-tenue md:grid">
            <span>Descripción</span>
            <span className="text-right">Cant.</span>
            <span className="text-right">Precio unit.</span>
            <span className="text-right">Desc. %</span>
            <span className="text-right">Subtotal</span>
            <span />
          </div>
          <ul className="divide-y divide-borde">
            {items.map((i, idx) => (
              <li key={i.key} className="grid grid-cols-2 items-center gap-2 px-3 py-2.5 md:grid-cols-[minmax(0,1fr)_70px_130px_70px_120px_36px]">
                <div className="col-span-2 flex min-w-0 items-center gap-2 md:col-span-1">
                  <Insignia tono={i.tipo === 'articulo' ? 'cian' : i.tipo === 'servicio' ? 'azul' : 'gris'} className="shrink-0">
                    {i.tipo === 'articulo' ? 'Rep.' : i.tipo === 'servicio' ? 'M.O.' : 'Libre'}
                  </Insignia>
                  {soloLectura ? (
                    <span className="text-sm break-words">{i.descripcion}</span>
                  ) : (
                    <Input value={i.descripcion} onChange={(e) => upd(i.key, { descripcion: e.target.value })} className="h-9" aria-label="Descripción" />
                  )}
                </div>
                {soloLectura ? (
                  <>
                    <span className="text-right text-sm tabular-nums">{i.cantidad}</span>
                    <span className="text-right text-sm tabular-nums">{money(i.precio_unitario)}</span>
                    <span className="text-right text-sm tabular-nums">{i.desc_pct ? `${i.desc_pct}%` : '—'}</span>
                  </>
                ) : (
                  <>
                    <label className="flex items-center gap-1 text-xs text-tenue md:contents">
                      <span className="md:hidden">Cant.</span>
                      <Input type="number" min={0.01} step="any" value={i.cantidad} onChange={(e) => upd(i.key, { cantidad: Math.max(0, Math.round(Number(e.target.value) * 1000) / 1000) })} className="h-9 text-right" aria-label="Cantidad" />
                    </label>
                    <InputMoneda value={i.precio_unitario} onChange={(v) => upd(i.key, { precio_unitario: v })} className="[&_input]:h-9" />
                    <label className="flex items-center gap-1 text-xs text-tenue md:contents">
                      <span className="md:hidden">Desc. %</span>
                      <Input type="number" min={0} max={100} value={i.desc_pct} onChange={(e) => upd(i.key, { desc_pct: Math.min(100, Math.max(0, Number(e.target.value))) })} className="h-9 text-right" aria-label="Descuento" />
                    </label>
                  </>
                )}
                <span className="text-right text-sm font-semibold tabular-nums">{money(t.subtotales[idx])}</span>
                {!soloLectura && (
                  <Boton variante="fantasma" tam="sm" onClick={() => onItems(items.filter((x) => x.key !== i.key))} icono={<Trash2 className="size-4 text-red-600" />} aria-label="Quitar" />
                )}
                {i.tipo === 'servicio' && (soloLectura ? (
                  i.tiempo_min ? <p className="col-span-2 flex items-center gap-1 text-xs text-tenue md:col-span-6"><Clock className="size-3" /> Tiempo estimado: {formatearMinutos(Math.round(i.tiempo_min * i.cantidad))}</p> : null
                ) : (
                  <label className="col-span-2 flex flex-wrap items-center gap-2 text-xs text-tenue md:col-span-6">
                    <Clock className="size-3.5" /> Tiempo estimado por unidad (min)
                    <Input type="number" min={0} max={6000} value={i.tiempo_min ?? ''} onChange={(e) => upd(i.key, { tiempo_min: e.target.value === '' ? null : Math.min(6000, Math.max(0, Math.round(Number(e.target.value)))) })} className="h-8 w-24 text-right" aria-label="Tiempo estimado en minutos" />
                    {i.tiempo_min ? <span>{formatearMinutos(Math.round(i.tiempo_min * i.cantidad))} en total</span> : null}
                  </label>
                ))}
                {i.tipo === 'articulo' && i.stock != null && i.cantidad > i.stock && (
                  <p className="col-span-2 text-xs text-amber-700 md:col-span-6">Atención: stock disponible {i.stock}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div className={cn('grid grid-cols-2 gap-3', soloLectura && 'pointer-events-none opacity-80')}>
          <Campo label="Descuento general %">
            <Input type="number" min={0} max={100} value={params.desc_global_pct} onChange={(e) => onParams({ ...params, desc_global_pct: Math.min(100, Math.max(0, Number(e.target.value))) })} disabled={soloLectura} />
          </Campo>
          <Campo label="Descuento en $">
            <InputMoneda value={params.desc_global_monto} onChange={(v) => onParams({ ...params, desc_global_monto: v })} disabled={soloLectura} />
          </Campo>
          <Campo label="IVA">
            <Select value={params.iva_pct} onChange={(e) => onParams({ ...params, iva_pct: Number(e.target.value) })} disabled={soloLectura}>
              <option value={0}>Sin IVA / precios finales</option>
              <option value={10.5}>10,5 %</option>
              <option value={21}>21 %</option>
              <option value={27}>27 %</option>
            </Select>
          </Campo>
          <Campo label="Recargo % (financiación)">
            <Input type="number" min={0} max={100} value={params.recargo_pct} onChange={(e) => onParams({ ...params, recargo_pct: Math.min(100, Math.max(0, Number(e.target.value))) })} disabled={soloLectura} />
          </Campo>
        </div>
        <ResumenTotales t={t} params={params} />
      </div>
    </div>
  );
}

export function ResumenTotales({ t, params }: { t: ReturnType<typeof calcularTotales>; params: ParamsUI }) {
  const fila = (l: string, v: number, fuerte = false) => (
    <div className={cn('flex justify-between gap-4', fuerte && 'border-t border-borde pt-2 text-lg font-bold')}>
      <span className={fuerte ? '' : 'text-tenue'}>{l}</span>
      <span className="tabular-nums">{money(v)}</span>
    </div>
  );
  return (
    <div className="space-y-1.5 rounded-xl bg-slate-50 p-4 text-sm">
      {fila('Repuestos', t.subtotal_articulos)}
      {fila('Mano de obra y servicios', t.subtotal_servicios)}
      {t.descuento > 0 && fila('Descuento', -t.descuento)}
      {(params.iva_pct > 0 || params.recargo_pct > 0) && fila('Neto', t.neto)}
      {params.iva_pct > 0 && fila(`IVA ${params.iva_pct}%`, t.iva)}
      {params.recargo_pct > 0 && fila(`Recargo ${params.recargo_pct}%`, t.recargo)}
      {fila('Total', t.total, true)}
    </div>
  );
}
