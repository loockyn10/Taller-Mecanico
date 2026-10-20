// Órdenes de compra: alta/edición, emisión, recepción de mercadería (total o parcial), diferencias y facturas asociadas.
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Ban, CheckCheck, FilePlus2, PackageCheck, Pencil, Plus, Printer, Send, Trash2, Truck } from 'lucide-react';
import { api, nuevaClave, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { invalidarDinero } from '@/lib/caja';
import { cantidad, fecha, hoyISO, money, numero } from '@/lib/format';
import { Aviso, Boton, Buscador, Campo, Cargando, Check, Encabezado, ErrorCaja, Input, InputMoneda, Insignia, Modal, Select, Tabla, Tarjeta, Textarea, useDebounce, useToast, Vacio, type Tono } from '@/components/ui';
import { calcularOC } from '@shared/compras';
import { ESTADO_OC_LABEL, ESTADOS_ORDEN_COMPRA, type EstadoOrdenCompra } from '@shared/dominio';
import { useConfigTaller } from '@/lib/config';

const TONO: Record<EstadoOrdenCompra, Tono> = { borrador: 'gris', pendiente: 'azul', parcial: 'ambar', recibida: 'verde', cancelada: 'rojo' };
export const EstadoOC = ({ estado }: { estado: string }) => <Insignia tono={TONO[estado as EstadoOrdenCompra] ?? 'gris'}>{ESTADO_OC_LABEL[estado as EstadoOrdenCompra] ?? estado}</Insignia>;

// ───────────── Listado ─────────────
export function OrdenesCompra() {
  const nav = useNavigate();
  const [estado, setEstado] = useState('');
  const [proveedor, setProveedor] = useState('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounce(q);
  const { data: provs = [] } = useQuery({ queryKey: ['proveedores'], queryFn: () => api.get<any[]>('/proveedores') });
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['ordenes-compra', { estado, proveedor, desde, hasta, dq }], queryFn: () => api.get<any[]>(`/ordenes-compra${qs({ estado, proveedor_id: proveedor, desde, hasta, q: dq })}`) });
  const abiertas = data.filter((o) => ['pendiente', 'parcial'].includes(o.estado));
  return (
    <>
      <Encabezado titulo="Órdenes de compra" subtitulo={abiertas.length ? `${abiertas.length} orden(es) esperando mercadería` : 'Pedidos a proveedores y recepción de mercadería'} acciones={<Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => nav('/ordenes-compra/nueva')}>Nueva orden</Boton>} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Buscador value={q} onChange={setQ} placeholder="Proveedor, número u observaciones…" className="min-w-52 flex-1" />
        <Campo label="Estado"><Select value={estado} onChange={(e) => setEstado(e.target.value)} className="w-auto"><option value="">Todos</option>{ESTADOS_ORDEN_COMPRA.map((e) => <option key={e} value={e}>{ESTADO_OC_LABEL[e]}</option>)}</Select></Campo>
        <Campo label="Proveedor"><Select value={proveedor} onChange={(e) => setProveedor(e.target.value)} className="w-auto"><option value="">Todos</option>{provs.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</Select></Campo>
        <Campo label="Desde"><Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} /></Campo>
        <Campo label="Hasta"><Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} /></Campo>
      </div>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={data}
            clave={(o: any) => o.id}
            onFila={(o: any) => nav(`/ordenes-compra/${o.id}`)}
            vacio={<Vacio icono={<Truck className="size-5" />} titulo="Sin órdenes de compra" texto="Armá una orden desde cero o generala desde Reposición con los artículos bajo mínimo." accion={<Boton variante="primario" onClick={() => nav('/ordenes-compra/nueva')}>Nueva orden</Boton>} />}
            columnas={[
              { clave: 'n', titulo: 'N°', render: (o: any) => <span className="font-medium">OC #{numero(o.numero)}</span>, movil: 'titulo' },
              { clave: 'p', titulo: 'Proveedor', render: (o: any) => o.proveedor, movil: 'subtitulo' },
              { clave: 'f', titulo: 'Fecha', render: (o: any) => fecha(o.fecha), movil: 'meta' },
              { clave: 'e', titulo: 'Entrega prevista', render: (o: any) => (o.fecha_prevista ? <span className={['pendiente', 'parcial'].includes(o.estado) && o.fecha_prevista < hoyISO() ? 'font-medium text-red-600' : ''}>{fecha(o.fecha_prevista)}</span> : '—'), movil: 'meta' },
              { clave: 'r', titulo: 'Recibido', render: (o: any) => (o.estado === 'borrador' || o.estado === 'cancelada' ? '—' : `${cantidad(o.unidades_recibidas)} de ${cantidad(o.unidades)}`), movil: 'meta' },
              { clave: 's', titulo: 'Estado', render: (o: any) => <EstadoOC estado={o.estado} />, movil: 'meta' },
              { clave: 't', titulo: 'Total', alinear: 'derecha', render: (o: any) => money(o.total), movil: 'derecha' },
            ]}
          />
        </Tarjeta>
      )}
    </>
  );
}

// ───────────── Alta / edición ─────────────
interface Linea { articulo_id: string; nombre: string; codigo?: string | null; cantidad: number; costo_unitario: number; desc_pct: number }

export function OrdenCompraForm() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const precarga = (useLocation().state as any)?.precarga as { proveedor_id: string | null; items: Linea[] } | undefined;
  const { data: cfg } = useConfigTaller();
  const { data: provs = [] } = useQuery({ queryKey: ['proveedores'], queryFn: () => api.get<any[]>('/proveedores') });
  const { data: existente } = useQuery({ queryKey: ['ordenes-compra', 'detalle', id], queryFn: () => api.get(`/ordenes-compra/${id}`), enabled: !!id });
  const [prov, setProv] = useState(precarga?.proveedor_id ?? '');
  const [f, setF] = useState({ fecha: hoyISO(), fecha_prevista: '', descuento_pct: 0, iva_pct: 0, actualizar_costos: true, observaciones: '' });
  const [items, setItems] = useState<Linea[]>(precarga?.items ?? []);
  const [q, setQ] = useState('');
  const dq = useDebounce(q);
  const [clave] = useState(nuevaClave());
  const { data: res = [] } = useQuery({ queryKey: ['articulos', { q: dq, oc: 1 }], queryFn: () => api.get<any[]>(`/articulos?limite=15&q=${encodeURIComponent(dq)}`), enabled: dq.length >= 1 });
  useEffect(() => {
    if (existente) {
      setProv(existente.proveedor_id);
      setF({ fecha: existente.fecha, fecha_prevista: existente.fecha_prevista ?? '', descuento_pct: existente.descuento_pct, iva_pct: existente.iva_pct, actualizar_costos: !!existente.actualizar_costos, observaciones: existente.observaciones ?? '' });
      setItems(existente.items.map((i: any) => ({ articulo_id: i.articulo_id, nombre: i.articulo, codigo: i.codigo, cantidad: i.cantidad, costo_unitario: i.costo_unitario, desc_pct: i.desc_pct })));
    }
  }, [existente]);
  const t = useMemo(() => calcularOC(items, f), [items, f]);
  const editable = !existente || ['borrador', 'pendiente'].includes(existente.estado);
  const m = useMutation({
    mutationFn: (emitir: boolean) => {
      const datos = { proveedor_id: prov, fecha: f.fecha, fecha_prevista: f.fecha_prevista || null, descuento_pct: f.descuento_pct, iva_pct: f.iva_pct, actualizar_costos: f.actualizar_costos, observaciones: f.observaciones || null, items: items.map((i) => ({ articulo_id: i.articulo_id, cantidad: i.cantidad, costo_unitario: i.costo_unitario, desc_pct: i.desc_pct })) };
      return id ? api.put(`/ordenes-compra/${id}`, datos).then(() => ({ id })) : api.post('/ordenes-compra', { ...datos, emitir, idem_key: clave, origen: precarga ? 'reposicion' : null });
    },
    onSuccess: (r: any) => {
      invalidarDinero(qc);
      toast.ok(id ? 'Orden actualizada' : 'Orden creada');
      nav(`/ordenes-compra/${r.id}`);
    },
    onError: toast.error,
  });
  const valido = !!prov && items.length > 0 && items.every((i) => i.cantidad > 0) && editable;
  return (
    <>
      <Encabezado titulo={id ? `Editar orden de compra${existente ? ` #${numero(existente.numero)}` : ''}` : 'Nueva orden de compra'} volver={id ? `/ordenes-compra/${id}` : '/ordenes-compra'} />
      {id && !existente ? <Cargando /> : !editable ? <Aviso tono="ambar">Esta orden ya no se puede editar.</Aviso> : (
        <div className="grid gap-5 xl:grid-cols-3">
          <Tarjeta titulo="Artículos a pedir" className="xl:col-span-2">
            <Buscador value={q} onChange={setQ} placeholder="Buscar artículo para agregar…" />
            {dq && (
              <ul className="mt-1.5 max-h-56 divide-y divide-borde overflow-y-auto rounded-lg border border-borde text-sm">
                {res.map((a) => (
                  <li key={a.id}>
                    <button type="button" className="flex w-full justify-between px-3 py-2 text-left hover:bg-marca-50" onClick={() => { if (!items.some((i) => i.articulo_id === a.id)) setItems([...items, { articulo_id: a.id, nombre: a.nombre, codigo: a.codigo, cantidad: Math.max(1, a.stock_objetivo ? a.stock_objetivo - a.stock : 1), costo_unitario: a.costo, desc_pct: 0 }]); setQ(''); }}>
                      <span>{a.nombre} <span className="text-tenue">{a.codigo ?? ''}</span></span>
                      <span className="text-tenue">Costo {money(a.costo)} · stock {cantidad(a.stock)}</span>
                    </button>
                  </li>
                ))}
                {!res.length && <li className="px-3 py-2 text-tenue">Sin resultados. Crealo primero en Artículos.</li>}
              </ul>
            )}
            <ul className="mt-4 divide-y divide-borde rounded-xl border border-borde">
              {items.map((i, idx) => (
                <li key={i.articulo_id} className="grid grid-cols-2 items-center gap-2 px-3 py-2 sm:grid-cols-[1fr_90px_140px_80px_110px_40px]">
                  <span className="col-span-2 truncate text-sm font-medium sm:col-span-1">{i.nombre}</span>
                  <Input type="number" min={0.001} step="any" value={i.cantidad} onChange={(e) => setItems(items.map((x, j) => (j === idx ? { ...x, cantidad: Math.round(Number(e.target.value) * 1000) / 1000 } : x)))} className="h-9 text-right" aria-label="Cantidad" />
                  <InputMoneda value={i.costo_unitario} onChange={(v) => setItems(items.map((x, j) => (j === idx ? { ...x, costo_unitario: v } : x)))} className="[&_input]:h-9" />
                  <Input type="number" min={0} max={100} step="any" value={i.desc_pct} onChange={(e) => setItems(items.map((x, j) => (j === idx ? { ...x, desc_pct: Math.min(100, Math.max(0, Number(e.target.value))) } : x)))} className="h-9 text-right" aria-label="Descuento %" title="Descuento %" />
                  <span className="text-right text-sm font-semibold tabular-nums">{money(t.subtotales[idx] ?? 0)}</span>
                  <Boton variante="fantasma" tam="sm" icono={<Trash2 className="size-4 text-red-600" />} onClick={() => setItems(items.filter((_, j) => j !== idx))} aria-label="Quitar" />
                </li>
              ))}
              {!items.length && <li className="px-4 py-6 text-center text-sm text-tenue">Agregá los artículos que vas a pedir</li>}
            </ul>
            {items.length > 0 && <p className="mt-1.5 text-xs text-tenue">Columnas: cantidad · costo unitario · descuento % · subtotal.</p>}
          </Tarjeta>
          <div className="space-y-5">
            <Tarjeta titulo="Datos de la orden">
              <div className="space-y-3">
                <Campo label="Proveedor" requerido>
                  <Select value={prov} disabled={!!id} onChange={(e) => setProv(e.target.value)}>
                    <option value="">— Elegir —</option>
                    {provs.filter((p) => p.activo).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                  </Select>
                </Campo>
                <div className="grid grid-cols-2 gap-3">
                  <Campo label="Fecha"><Input type="date" value={f.fecha} max={hoyISO()} onChange={(e) => setF({ ...f, fecha: e.target.value })} /></Campo>
                  <Campo label="Entrega prevista"><Input type="date" value={f.fecha_prevista} min={f.fecha} onChange={(e) => setF({ ...f, fecha_prevista: e.target.value })} /></Campo>
                  <Campo label="Descuento global %"><Input type="number" min={0} max={100} step="any" value={f.descuento_pct} onChange={(e) => setF({ ...f, descuento_pct: Math.min(100, Math.max(0, Number(e.target.value))) })} /></Campo>
                  <Campo label="IVA"><Select value={f.iva_pct} onChange={(e) => setF({ ...f, iva_pct: Number(e.target.value) })}>{[0, 10.5, 21, 27].map((v) => <option key={v} value={v}>{v ? `${v}%` : 'Sin IVA'}</option>)}</Select></Campo>
                </div>
                <Check checked={f.actualizar_costos} onChange={(v) => setF({ ...f, actualizar_costos: v })} label="Actualizar el costo de los artículos al recibir" />
                <Campo label="Observaciones"><Textarea rows={2} value={f.observaciones} onChange={(e) => setF({ ...f, observaciones: e.target.value })} /></Campo>
                <div className="space-y-0.5 rounded-lg bg-slate-50 p-3 text-right text-sm">
                  <div>Subtotal: {money(t.subtotal)}</div>
                  {t.descuento > 0 && <div>Descuento: −{money(t.descuento)}</div>}
                  {f.iva_pct > 0 && <div>IVA {f.iva_pct}%: {money(t.iva)}</div>}
                  <div className="text-lg font-bold">Total: {money(t.total)}</div>
                </div>
              </div>
            </Tarjeta>
            <div className="flex flex-col gap-2">
              {id ? (
                <Boton variante="primario" tam="lg" disabled={!valido} cargando={m.isPending} onClick={() => m.mutate(false)}>Guardar cambios</Boton>
              ) : (
                <>
                  <Boton variante="primario" tam="lg" icono={<Send className="size-4" />} disabled={!valido} cargando={m.isPending} onClick={() => m.mutate(true)}>Guardar y emitir</Boton>
                  <Boton disabled={!valido} cargando={m.isPending} onClick={() => m.mutate(false)}>Guardar como borrador</Boton>
                </>
              )}
              {cfg && <p className="text-xs text-tenue">Plazo de pago habitual: {cfg.config.plazo_pago_dias} días.</p>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ───────────── Recepción ─────────────
function ModalRecepcion({ orden, onCerrar }: { orden: any; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const pendientes = orden.items.filter((i: any) => i.pendiente > 0);
  const [cant, setCant] = useState<Record<string, number>>(() => Object.fromEntries(pendientes.map((i: any) => [i.id, i.pendiente])));
  const [remito, setRemito] = useState('');
  const [notas, setNotas] = useState('');
  const [fechaR, setFechaR] = useState(hoyISO());
  const [clave] = useState(nuevaClave());
  const { puede } = useAuth();
  const m = useMutation({
    mutationFn: () => api.post(`/ordenes-compra/${orden.id}/recepciones`, { fecha: fechaR, remito: remito.trim() || null, notas: notas || null, idem_key: clave, items: Object.entries(cant).filter(([, v]) => v > 0).map(([orden_item_id, cantidad]) => ({ orden_item_id, cantidad })) }),
    onSuccess: (r: any) => {
      invalidarDinero(qc);
      ['articulos', 'movimientos', 'reposicion', 'recepciones'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.ok(`Recepción #${numero(r.numero)} registrada. Stock actualizado.`);
      onCerrar();
    },
    onError: toast.error,
  });
  const algo = Object.values(cant).some((v) => v > 0);
  const faltan = pendientes.filter((i: any) => (cant[i.id] ?? 0) < i.pendiente);
  return (
    <Modal abierto onCerrar={onCerrar} titulo={`Recibir mercadería · OC #${numero(orden.numero)}`} ancho="lg" pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" icono={<PackageCheck className="size-4" />} disabled={!algo} cargando={m.isPending} onClick={() => m.mutate()}>Registrar recepción</Boton></>}>
      <div className="space-y-4">
        <Aviso>Al confirmar, el stock de los artículos recibidos aumenta una sola vez. La deuda con el proveedor nace con su factura (Facturas de proveedores).</Aviso>
        <div className="grid gap-3 sm:grid-cols-3">
          <Campo label="Remito del proveedor" hint="Un mismo remito no se carga dos veces"><Input value={remito} onChange={(e) => setRemito(e.target.value)} placeholder="0001-00001234" /></Campo>
          <Campo label="Fecha de recepción"><Input type="date" value={fechaR} max={hoyISO()} disabled={!puede('fechas.retroactivas')} onChange={(e) => setFechaR(e.target.value)} /></Campo>
          <Campo label="Notas"><Input value={notas} onChange={(e) => setNotas(e.target.value)} /></Campo>
        </div>
        <ul className="divide-y divide-borde rounded-xl border border-borde">
          {pendientes.map((i: any) => {
            const c = cant[i.id] ?? 0;
            return (
              <li key={i.id} className="grid grid-cols-[1fr_auto] items-center gap-2 px-3 py-2 sm:grid-cols-[1fr_120px_130px_100px]">
                <div className="min-w-0"><div className="truncate text-sm font-medium">{i.articulo}</div><div className="text-xs text-tenue">Pedido {cantidad(i.cantidad)} · ya recibido {cantidad(i.cantidad_recibida)}</div></div>
                <div className="text-right text-sm text-tenue sm:order-none">Pendiente <strong className="text-texto">{cantidad(i.pendiente)}</strong></div>
                <Input type="number" min={0} max={i.pendiente} step="any" value={c} onChange={(e) => setCant({ ...cant, [i.id]: Math.max(0, Math.min(i.pendiente, Math.round(Number(e.target.value) * 1000) / 1000)) })} className="h-9 text-right" aria-label={`Cantidad recibida de ${i.articulo}`} />
                <span className={`text-right text-xs ${c < i.pendiente ? 'font-medium text-amber-700' : 'text-emerald-700'}`}>{c < i.pendiente ? `Faltan ${cantidad(Math.round((i.pendiente - c) * 1000) / 1000)}` : 'Completo'}</span>
              </li>
            );
          })}
        </ul>
        <div className="flex gap-2">
          <Boton tam="sm" onClick={() => setCant(Object.fromEntries(pendientes.map((i: any) => [i.id, i.pendiente])))}>Recibir todo lo pendiente</Boton>
          <Boton tam="sm" variante="fantasma" onClick={() => setCant({})}>Poner todo en cero</Boton>
        </div>
        {algo && faltan.length > 0 && <Aviso tono="ambar">Quedan {faltan.length} artículo(s) con faltante: la orden quedará “Parcialmente recibida” hasta que llegue el resto (o la cierres con faltante).</Aviso>}
      </div>
    </Modal>
  );
}

// ───────────── Detalle ─────────────
export function OrdenCompraDetalle() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [recibir, setRecibir] = useState(false);
  const [motivoModal, setMotivoModal] = useState<null | { tipo: 'cancelar' | 'cerrar' | 'anular-recepcion'; recepcion?: any }>(null);
  const [motivo, setMotivo] = useState('');
  const { data: o, isLoading, error, refetch } = useQuery({ queryKey: ['ordenes-compra', 'detalle', id], queryFn: () => api.get(`/ordenes-compra/${id}`) });
  const refrescar = () => {
    invalidarDinero(qc);
    ['articulos', 'movimientos', 'reposicion'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  };
  const emitir = useMutation({ mutationFn: () => api.post(`/ordenes-compra/${id}/emitir`, {}), onSuccess: () => { refrescar(); toast.ok('Orden emitida'); }, onError: toast.error });
  const accion = useMutation({
    mutationFn: () => {
      if (motivoModal?.tipo === 'anular-recepcion') return api.post(`/recepciones/${motivoModal.recepcion.id}/anular`, { motivo });
      return api.post(`/ordenes-compra/${id}/${motivoModal!.tipo === 'cancelar' ? 'cancelar' : 'cerrar'}`, { motivo });
    },
    onSuccess: () => {
      refrescar();
      toast.ok('Listo');
      setMotivoModal(null);
      setMotivo('');
    },
    onError: toast.error,
  });
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  const abierta = ['pendiente', 'parcial'].includes(o.estado);
  const faltante = o.items.reduce((a: number, i: any) => a + (o.estado === 'recibida' ? Math.max(0, i.pendiente) : 0), 0);
  return (
    <>
      <Encabezado
        volver="/ordenes-compra"
        titulo={<span className="flex items-center gap-2">Orden de compra #{numero(o.numero)} <EstadoOC estado={o.estado} /></span>}
        subtitulo={<>{o.proveedor} · {fecha(o.fecha)}{o.fecha_prevista ? ` · entrega prevista ${fecha(o.fecha_prevista)}` : ''}</>}
        acciones={
          <>
            <Boton icono={<Printer className="size-4" />} onClick={() => window.open(`/imprimir/orden-compra/${o.id}`, '_blank')}>Imprimir</Boton>
            {['borrador', 'pendiente'].includes(o.estado) && o.recepciones === 0 && <Boton icono={<Pencil className="size-4" />} onClick={() => nav(`/ordenes-compra/${o.id}/editar`)}>Editar</Boton>}
            {o.estado === 'borrador' && <Boton variante="primario" icono={<Send className="size-4" />} cargando={emitir.isPending} onClick={() => emitir.mutate()}>Emitir</Boton>}
            {abierta && <Boton variante="exito" icono={<PackageCheck className="size-4" />} onClick={() => setRecibir(true)}>Recibir mercadería</Boton>}
            {['parcial', 'recibida'].includes(o.estado) && <Boton icono={<FilePlus2 className="size-4" />} onClick={() => nav('/facturas-proveedor', { state: { nueva: { proveedor_id: o.proveedor_id, orden_compra_id: o.id, total: o.total } } })}>Cargar factura</Boton>}
          </>
        }
      />
      {o.estado === 'recibida' && o.cerrada_con_faltante ? <Aviso tono="ambar" className="mb-4">Cerrada con faltante: {o.observaciones}</Aviso> : null}
      {o.estado === 'cancelada' && <Aviso tono="rojo" className="mb-4">Cancelada: {o.motivo_cancelacion}</Aviso>}
      <div className="grid gap-5 xl:grid-cols-3">
        <Tarjeta titulo="Artículos" className="xl:col-span-2" sinPadding>
          <Tabla
            filas={o.items}
            clave={(i: any) => i.id}
            columnas={[
              { clave: 'a', titulo: 'Artículo', render: (i: any) => <span><span className="font-medium">{i.articulo}</span> <span className="text-tenue">{i.codigo ?? ''}</span></span>, movil: 'titulo' },
              { clave: 'c', titulo: 'Pedido', alinear: 'derecha', render: (i: any) => cantidad(i.cantidad), movil: 'meta' },
              { clave: 'r', titulo: 'Recibido', alinear: 'derecha', render: (i: any) => cantidad(i.cantidad_recibida), movil: 'meta' },
              { clave: 'd', titulo: 'Diferencia', alinear: 'derecha', render: (i: any) => (i.pendiente > 0 && o.estado !== 'borrador' && o.estado !== 'pendiente' ? <span className={o.estado === 'recibida' ? 'font-medium text-red-600' : 'text-amber-700'}>Faltan {cantidad(i.pendiente)}</span> : ''), movil: 'meta' },
              { clave: 'k', titulo: 'Costo', alinear: 'derecha', render: (i: any) => <>{money(i.costo_unitario)}{i.desc_pct ? <span className="text-xs text-tenue"> −{i.desc_pct}%</span> : null}</>, movil: 'meta' },
              { clave: 's', titulo: 'Subtotal', alinear: 'derecha', render: (i: any) => money(i.subtotal), movil: 'derecha' },
            ]}
          />
        </Tarjeta>
        <Tarjeta titulo="Totales">
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-tenue">Subtotal</dt><dd className="tabular-nums">{money(o.subtotal)}</dd></div>
            {o.descuento > 0 && <div className="flex justify-between"><dt className="text-tenue">Descuento {o.descuento_pct}%</dt><dd className="tabular-nums">−{money(o.descuento)}</dd></div>}
            {o.iva > 0 && <div className="flex justify-between"><dt className="text-tenue">IVA {o.iva_pct}%</dt><dd className="tabular-nums">{money(o.iva)}</dd></div>}
            <div className="flex justify-between border-t border-borde pt-2 text-base font-bold"><dt>Total</dt><dd className="tabular-nums">{money(o.total)}</dd></div>
          </dl>
          {o.observaciones && o.estado !== 'recibida' && <p className="mt-3 text-sm text-tenue">{o.observaciones}</p>}
          <div className="mt-4 flex flex-wrap gap-2">
            {['borrador', 'pendiente'].includes(o.estado) && o.recepciones === 0 && <Boton variante="peligro" tam="sm" icono={<Ban className="size-4" />} onClick={() => setMotivoModal({ tipo: 'cancelar' })}>Cancelar orden</Boton>}
            {o.estado === 'parcial' && <Boton tam="sm" icono={<CheckCheck className="size-4" />} onClick={() => setMotivoModal({ tipo: 'cerrar' })}>Cerrar con faltante</Boton>}
          </div>
          {faltante > 0 && <p className="mt-2 text-xs text-amber-700">La orden se cerró con {cantidad(faltante)} unidad(es) sin recibir.</p>}
        </Tarjeta>
      </div>
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Tarjeta titulo="Recepciones" sinPadding>
          {o.recepciones_detalle.length === 0 ? <p className="px-4 py-6 text-center text-sm text-tenue">Todavía no se recibió mercadería</p> : (
            <ul className="divide-y divide-borde text-sm">
              {o.recepciones_detalle.map((r: any) => (
                <li key={r.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                  <span className={r.estado === 'anulada' ? 'text-tenue line-through' : ''}>Recepción #{numero(r.numero)} · {fecha(r.fecha)}{r.remito ? ` · remito ${r.remito}` : ''} · {r.lineas} línea(s)</span>
                  {r.estado === 'registrada' ? o.cerrada_con_faltante ? null : <Boton tam="sm" variante="fantasma" icono={<Ban className="size-4" />} onClick={() => setMotivoModal({ tipo: 'anular-recepcion', recepcion: r })}>Anular</Boton> : <Insignia>Anulada</Insignia>}
                </li>
              ))}
            </ul>
          )}
        </Tarjeta>
        <Tarjeta titulo="Facturas del proveedor" sinPadding>
          {o.facturas.length === 0 ? <p className="px-4 py-6 text-center text-sm text-tenue">Sin facturas asociadas{['parcial', 'recibida'].includes(o.estado) ? ': cargala para registrar la deuda con el proveedor' : ''}</p> : (
            <ul className="divide-y divide-borde text-sm">
              {o.facturas.map((f: any) => <li key={f.id} className="flex justify-between gap-2 px-4 py-2.5"><span className={f.estado === 'anulada' ? 'text-tenue line-through' : ''}>{f.nro_comprobante} · {fecha(f.fecha)}</span><span className="tabular-nums">{money(f.total)}</span></li>)}
            </ul>
          )}
        </Tarjeta>
      </div>
      {recibir && <ModalRecepcion orden={o} onCerrar={() => setRecibir(false)} />}
      <Modal
        abierto={!!motivoModal}
        onCerrar={() => setMotivoModal(null)}
        titulo={motivoModal?.tipo === 'cancelar' ? 'Cancelar la orden' : motivoModal?.tipo === 'cerrar' ? 'Cerrar con faltante' : `Anular recepción #${motivoModal?.recepcion ? numero(motivoModal.recepcion.numero) : ''}`}
        ancho="sm"
        pie={<><Boton onClick={() => setMotivoModal(null)}>Volver</Boton><Boton variante="peligro" disabled={motivo.trim().length < 3} cargando={accion.isPending} onClick={() => accion.mutate()}>Confirmar</Boton></>}
      >
        <div className="space-y-3">
          <p className="text-sm text-tenue">
            {motivoModal?.tipo === 'cancelar' ? 'La orden no se podrá recibir ni facturar.' : motivoModal?.tipo === 'cerrar' ? 'Lo que falta recibir no va a llegar: la orden queda como recibida y el faltante registrado.' : 'Se descuenta del stock lo que ingresó con esa recepción y la orden vuelve a esperar esa mercadería.'}
          </p>
          <Campo label="Motivo" requerido><Input value={motivo} onChange={(e) => setMotivo(e.target.value)} autoFocus /></Campo>
        </div>
      </Modal>
    </>
  );
}
