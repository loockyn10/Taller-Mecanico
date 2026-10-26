// Operaciones rápidas: un carrito para vender, cargar repuestos a una OT o dar de baja inventario sin recorrer varios módulos.
// No es un sistema aparte: la venta usa POST /ventas (con su caja, sus cobros y su contabilidad), el consumo agrega ítems a la orden (el stock lo descuenta
// la OT al quedar «lista») y la baja genera movimientos de stock manuales.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Barcode, ClipboardList, Minus, PackageMinus, Plus, ShoppingBag, Trash2, Wrench, Zap } from 'lucide-react';
import { api, nuevaClave, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cantidad, fechaHora, money, numero } from '@/lib/format';
import { Aviso, Boton, BotonIcono, Campo, Cargando, Encabezado, ErrorCaja, Input, Insignia, Segmentado, Select, Tabla, Tarjeta, Textarea, useConfirmar, useDebounce, useToast, Vacio } from '@/components/ui';
import { FilaResultado, useBuscarArticulos, type ResultadoPrecio } from '@/components/ConsultaPrecios';
import { SelectorDeposito } from '@/components/SelectorDeposito';
import { SelectorCliente, type ClienteMin } from '@/components/selectores';
import { useListas } from '@/components/SelectorLista';
import { AvisoCaja, useCajaBloqueada } from '@/components/Cobro';
import { CamposMedio, errorMedio, extraAPayload, extraVacio, SelectorMedio, type ExtraMedio } from '@/components/MedioPago';
import { paramsVacios, useDefectosEnParams, type ParamsUI } from '@/components/EditorItems';
import { invalidarDinero } from '@/lib/caja';
import { calcularTotales } from '@shared/totals';
import { ESTADOS_OT_EDITABLES, ESTADO_OT_LABEL, type EstadoOT, type MedioPago } from '@shared/dominio';
import { MOTIVOS_BAJA, MOTIVO_BAJA_LABEL, PREFIJO_VENTA_RAPIDA, type MotivoBaja } from '@shared/rapidas';

type Tipo = 'venta' | 'consumo' | 'baja';

interface Linea {
  articulo_id: string;
  nombre: string;
  marca?: string | null;
  codigo?: string | null;
  unidad: string;
  stock?: number;
  precio: number | null;
  cantidad: number;
  desc_pct: number;
}

const aLinea = (a: ResultadoPrecio): Linea => ({ articulo_id: a.id, nombre: a.nombre, marca: a.marca, codigo: a.codigo, unidad: a.unidad, stock: a.stock, precio: a.precio ?? null, cantidad: 1, desc_pct: 0 });

/** Suma una unidad si el artículo ya está en el carrito (escanear dos veces el mismo código no duplica la línea). */
function agregar(lineas: Linea[], a: ResultadoPrecio): Linea[] {
  const i = lineas.findIndex((l) => l.articulo_id === a.id);
  return i < 0 ? [...lineas, aLinea(a)] : lineas.map((l, k) => (k === i ? { ...l, cantidad: Math.round((l.cantidad + 1) * 1000) / 1000 } : l));
}

export function OperacionesRapidas() {
  const { puede } = useAuth();
  const permitidos = useMemo(
    () => ({
      venta: puede('ventas.emitir') && puede('precios.venta.ver'),
      consumo: puede('ordenes.modificar') && puede('presupuestos.valorizados.ver') && puede('precios.venta.ver'),
      baja: puede('stock.ajustar'),
    }),
    [puede],
  );
  const tipos = (['venta', 'consumo', 'baja'] as Tipo[]).filter((t) => permitidos[t]);
  const [tipo, setTipo] = useState<Tipo>(tipos[0] ?? 'venta');
  const [carritos, setCarritos] = useState<Record<Tipo, Linea[]>>({ venta: [], consumo: [], baja: [] });
  const activo = tipos.includes(tipo) ? tipo : tipos[0];
  if (!puede('catalogo.ver') || !activo) {
    return <Vacio icono={<Zap className="size-5" />} titulo="No tenés operaciones rápidas habilitadas" texto="Pedile al propietario o a un administrador que te habilite el permiso para vender, cargar repuestos a una OT o registrar bajas de inventario." />;
  }
  const items = carritos[activo];
  const setItems = (f: (l: Linea[]) => Linea[]) => setCarritos((c) => ({ ...c, [activo]: f(c[activo]) }));
  const vaciar = () => setCarritos((c) => ({ ...c, [activo]: [] }));

  return (
    <>
      <Encabezado
        titulo="Operaciones rápidas"
        subtitulo="Escaneá o buscá los artículos, armá el carrito y registrá todo de una vez"
        acciones={tipos.length > 1 && (
          <Segmentado
            activo={activo}
            onCambio={setTipo}
            items={tipos.map((t) => ({ clave: t, titulo: { venta: 'Venta rápida', consumo: 'Consumo en OT', baja: 'Baja interna' }[t], icono: { venta: <ShoppingBag className="size-4" />, consumo: <Wrench className="size-4" />, baja: <PackageMinus className="size-4" /> }[t] }))}
          />
        )}
      />
      <div className="grid gap-5 xl:grid-cols-5">
        <Tarjeta titulo="Artículos" className="xl:col-span-2">
          <Buscar tipo={activo} onElegir={(a) => setItems((l) => agregar(l, a))} />
        </Tarjeta>
        <div className="xl:col-span-3">
          {activo === 'venta' && <PanelVenta key="venta" items={items} setItems={setItems} vaciar={vaciar} />}
          {activo === 'consumo' && <PanelConsumo key="consumo" items={items} setItems={setItems} vaciar={vaciar} />}
          {activo === 'baja' && <PanelBaja key="baja" items={items} setItems={setItems} vaciar={vaciar} />}
        </div>
      </div>
      <Historial />
    </>
  );
}

// ───────────── Búsqueda / lector ─────────────
function Buscar({ tipo, onElegir }: { tipo: Tipo; onElegir: (a: ResultadoPrecio) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: listas = [] } = useListas();
  const [q, setQ] = useState('');
  const [enviada, setEnviada] = useState('');
  const entrada = useRef<HTMLInputElement>(null);
  const dq = useDebounce(q, 200);
  const texto = (enviada || dq).trim();
  // Sólo la venta se arma con los precios de la lista predeterminada; el consumo usa la lista de la orden (la resuelve el servidor) y la baja no lleva precios.
  const listaId = tipo === 'venta' ? listas.find((l) => l.es_default)?.id ?? '' : '';
  const { data, error, refetch } = useBuscarArticulos(texto, listaId);
  const sinPrecios = (a: ResultadoPrecio): ResultadoPrecio => (tipo === 'venta' ? a : { ...a, precio: undefined, sin_precio: undefined, costo: undefined });
  useEffect(() => { entrada.current?.focus(); }, [tipo]);
  const agregarYLimpiar = (a: ResultadoPrecio) => {
    onElegir(a);
    setQ('');
    setEnviada('');
    entrada.current?.focus();
  };
  const alEnter = async () => {
    const t = q.trim();
    if (!t) return;
    // El campo se vacía en el acto: un lector que escanea de corrido escribe el código siguiente mientras se resuelve el anterior.
    setQ('');
    setEnviada('');
    const reponer = () => { if (!entrada.current?.value) { setQ(t); setEnviada(t); } };
    try {
      // El lector escribe el código y envía Enter: si coincide exactamente con un código de barras o SKU (o es el único resultado) se agrega solo.
      const r = await qc.fetchQuery({ queryKey: ['consulta-precios', t, listaId], queryFn: () => api.get<{ items: ResultadoPrecio[] }>(`/rapidas/consulta-precios${qs({ q: t, lista_id: listaId || undefined })}`), staleTime: 0 });
      const exacto = r.items.find((a) => a.codigo_barras === t || a.codigo === t) ?? (r.items.length === 1 ? r.items[0] : null);
      if (exacto) onElegir(exacto);
      else if (!r.items.length) { toast.error(new Error(`No hay ningún artículo con «${t}»`)); reponer(); }
      else reponer();
    } catch (e) {
      toast.error(e);
      reponer();
    }
  };
  const items = texto ? data?.items ?? [] : [];
  return (
    <div className="space-y-3">
      <div className="relative">
        <Barcode className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
        <Input
          ref={entrada}
          value={q}
          onChange={(e) => { setQ(e.target.value); setEnviada(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void alEnter(); } }}
          placeholder="Escaneá un código o buscá por nombre, marca o SKU"
          className="pl-9"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
          aria-label="Buscar o escanear artículo"
        />
      </div>
      {error ? <ErrorCaja error={error} reintentar={refetch} /> : !texto ? (
        <p className="text-sm text-tenue">El cursor queda siempre en este campo: cada escaneo suma el artículo al carrito.</p>
      ) : !data ? <Cargando /> : items.length === 0 ? (
        <p className="py-4 text-center text-sm text-tenue">No hay artículos para «{texto}».</p>
      ) : (
        <ul className="divide-y divide-borde rounded-card border border-borde">
          {items.map((a) => (
            <FilaResultado
              key={a.id}
              a={sinPrecios(a)}
              acciones={<BotonIcono etiqueta={`Agregar ${a.nombre}`} onClick={() => agregarYLimpiar(a)}><Plus className="size-4" /></BotonIcono>}
            />
          ))}
        </ul>
      )}
      {data?.hay_mas && <p className="text-xs text-tenue">Hay más resultados: acotá la búsqueda.</p>}
    </div>
  );
}

// ───────────── Carrito ─────────────
function Carrito({ items, setItems, conPrecio, conDescuento, aviso }: { items: Linea[]; setItems: (f: (l: Linea[]) => Linea[]) => void; conPrecio: boolean; conDescuento?: boolean; aviso?: boolean }) {
  const cambiar = (id: string, parche: Partial<Linea>) => setItems((l) => l.map((x) => (x.articulo_id === id ? { ...x, ...parche } : x)));
  if (!items.length) return <Vacio icono={<ShoppingBag className="size-5" />} titulo="El carrito está vacío" texto="Escaneá un código o elegí un artículo de la lista." />;
  return (
    <ul className="divide-y divide-borde rounded-card border border-borde">
      {items.map((l) => {
        const falta = aviso && l.stock != null && l.cantidad > l.stock;
        return (
          <li key={l.articulo_id} className="space-y-2 px-3 py-3 sm:px-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="break-words font-semibold leading-snug">{l.nombre}</div>
                <div className="text-xs text-tenue">{[l.marca, l.codigo && `SKU ${l.codigo}`].filter(Boolean).join(' · ')}</div>
              </div>
              <BotonIcono etiqueta={`Quitar ${l.nombre}`} peligro onClick={() => setItems((x) => x.filter((y) => y.articulo_id !== l.articulo_id))}><Trash2 className="size-4" /></BotonIcono>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex items-center gap-1">
                <BotonIcono etiqueta="Una unidad menos" onClick={() => cambiar(l.articulo_id, { cantidad: Math.max(0.001, Math.round((l.cantidad - 1) * 1000) / 1000) })}><Minus className="size-4" /></BotonIcono>
                <Input
                  type="number" inputMode="decimal" min={0.001} step="any" value={l.cantidad}
                  onChange={(e) => { const v = Number(e.target.value); if (v > 0) cambiar(l.articulo_id, { cantidad: v }); }}
                  className="h-9 w-20 text-center tabular-nums" aria-label={`Cantidad de ${l.nombre}`}
                />
                <BotonIcono etiqueta="Una unidad más" onClick={() => cambiar(l.articulo_id, { cantidad: Math.round((l.cantidad + 1) * 1000) / 1000 })}><Plus className="size-4" /></BotonIcono>
                <span className="text-xs text-tenue">{l.unidad}</span>
              </div>
              {conDescuento && (
                <label className="flex items-center gap-1.5 text-xs text-tenue">
                  Desc. %
                  <Input type="number" inputMode="decimal" min={0} max={100} step="any" value={l.desc_pct} onChange={(e) => cambiar(l.articulo_id, { desc_pct: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} className="h-9 w-16 text-center tabular-nums" aria-label={`Descuento de ${l.nombre}`} />
                </label>
              )}
              {conPrecio && (
                <span className="ml-auto text-right text-sm tabular-nums">
                  {l.precio == null ? <Insignia tono="ambar">Sin precio</Insignia> : <><span className="text-tenue">{money(l.precio)} ×</span> <strong>{money(Math.round(l.cantidad * l.precio * (1 - l.desc_pct / 100)))}</strong></>}
                </span>
              )}
            </div>
            {falta && <p className="text-xs font-medium text-peligro-700">Stock disponible: {cantidad(l.stock!)} {l.unidad}. Si el taller no admite stock negativo, el registro se va a rechazar.</p>}
          </li>
        );
      })}
    </ul>
  );
}

function BotonRegistrar({ deshabilitado, cargando, onClick, children }: { deshabilitado: boolean; cargando: boolean; onClick: () => void; children: React.ReactNode }) {
  return <Boton variante="primario" tam="lg" className="w-full" disabled={deshabilitado} cargando={cargando} onClick={onClick}>{children}</Boton>;
}

const resumen = (items: Linea[]) => {
  const u = items.reduce((a, l) => a + l.cantidad, 0);
  return `${items.length} artículo${items.length === 1 ? '' : 's'} · ${cantidad(u)} unidad${u === 1 ? '' : 'es'}`;
};
const detalleLineas = (items: Linea[]) => (
  <ul className="mt-2 max-h-48 space-y-0.5 overflow-y-auto text-sm">
    {items.map((l) => <li key={l.articulo_id}>{cantidad(l.cantidad)} × {l.nombre}</li>)}
  </ul>
);

interface PanelProps { items: Linea[]; setItems: (f: (l: Linea[]) => Linea[]) => void; vaciar: () => void }

// ───────────── Venta rápida ─────────────
function PanelVenta({ items, setItems, vaciar }: PanelProps) {
  const toast = useToast();
  const qc = useQueryClient();
  const { confirmar, dialogo } = useConfirmar();
  const bloqueada = useCajaBloqueada();
  const { data: listas = [] } = useListas();
  const [lista, setLista] = useState<string | null>(null);
  const [listaInicial, setListaInicial] = useState(false);
  const [cliente, setCliente] = useState<ClienteMin | null>(null);
  const [condicion, setCondicion] = useState<'contado' | 'cuenta_corriente'>('contado');
  const [medio, setMedio] = useState<MedioPago>('efectivo');
  const [ref, setRef] = useState('');
  const [extra, setExtra] = useState<ExtraMedio>(extraVacio());
  const [deposito, setDeposito] = useState('');
  const [obs, setObs] = useState('');
  const [params, setParams] = useState<ParamsUI>(paramsVacios());
  useDefectosEnParams(true, setParams);
  const [clave, setClave] = useState(() => nuevaClave());
  useEffect(() => {
    if (!listaInicial && listas.length) { setListaInicial(true); setLista(listas.find((l) => l.es_default)?.id ?? null); }
  }, [listas, listaInicial]);

  // Cambiar de lista recalcula los precios del carrito con los precios que resuelve el servidor (el mismo mecanismo de las ventas).
  const cambiarLista = async (id: string | null) => {
    setLista(id);
    if (!items.length) return;
    try {
      const r = await api.post<{ articulos: Record<string, number> }>(`/listas-precios/${id ?? 'base'}/precios`, { articulos: items.map((l) => l.articulo_id) });
      setItems((ls) => ls.map((l) => ({ ...l, precio: (r.articulos[l.articulo_id] ?? 0) > 0 ? r.articulos[l.articulo_id] : null })));
    } catch (e) { toast.error(e); }
  };

  const sinPrecio = items.some((l) => l.precio == null);
  const total = calcularTotales(items.map((l) => ({ tipo: 'articulo' as const, cantidad: l.cantidad, precio_unitario: l.precio ?? 0, desc_pct: l.desc_pct })), params).total;
  const chequeSinNumero = condicion === 'contado' && !!errorMedio(medio, ref, extra, 'cobro');
  const m = useMutation({
    mutationFn: () =>
      api.post('/ventas', {
        cliente_id: cliente?.id ?? null, condicion, observaciones: obs, lista_precio_id: lista, deposito_id: deposito || null, idem_key: `${PREFIJO_VENTA_RAPIDA}${clave}`, ...params,
        items: items.map((l) => ({ tipo: 'articulo', articulo_id: l.articulo_id, descripcion: l.nombre, cantidad: l.cantidad, precio_unitario: l.precio ?? 0, desc_pct: l.desc_pct })),
        cobro: condicion === 'contado' ? { medio, referencia: ref.trim() || null, ...extraAPayload(medio, extra, 'cobro') } : null,
      }),
    onSuccess: (v: any) => {
      invalidarDinero(qc);
      qc.invalidateQueries({ queryKey: ['articulos'] });
      qc.invalidateQueries({ queryKey: ['rapidas'] });
      qc.invalidateQueries({ queryKey: ['consulta-precios'] });
      toast.ok(`Comprobante #${numero(v.numero)} emitido${v.cobrado ? ' y cobrado' : ''}${v.duplicado ? ' (ya estaba registrado)' : ''}`);
      vaciar(); setClave(nuevaClave()); setRef(''); setObs(''); setExtra(extraVacio());
    },
    onError: toast.error,
  });
  const registrar = async () => {
    const ok = await confirmar(
      condicion === 'contado' ? `Emitir y cobrar ${money(total)}` : `Emitir a cuenta corriente ${money(total)}`,
      <div><p>{resumen(items)}{cliente ? ` · ${cliente.nombre}` : ' · Consumidor final'}.</p>{detalleLineas(items)}<p className="mt-2 text-xs text-tenue">Se genera un comprobante interno (no fiscal), baja el stock y, si es de contado, se registra el cobro en la caja.</p></div>,
    );
    if (ok) m.mutate();
  };
  return (
    <Tarjeta titulo="Venta rápida" subtitulo="Comprobante interno con las reglas de siempre: stock, caja y cuentas corrientes">
      <div className="space-y-4">
        {listas.length > 0 && (
          <Campo label="Lista de precios">
            <Select value={lista ?? ''} onChange={(e) => void cambiarLista(e.target.value || null)}>
              <option value="">Precio base</option>
              {listas.map((l) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
            </Select>
          </Campo>
        )}
        <SelectorDeposito valor={deposito} onCambio={setDeposito} label="Depósito de salida" />
        <Carrito items={items} setItems={setItems} conPrecio conDescuento aviso />
        {sinPrecio && <Aviso tono="ambar">Hay artículos sin precio configurado: cargale el precio al artículo (o a la lista) antes de venderlo.</Aviso>}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-3">
            <SelectorCliente valor={cliente} onCambio={(c) => { setCliente(c); if (!c && condicion === 'cuenta_corriente') setCondicion('contado'); }} />
            {!cliente && <p className="text-xs text-tenue">Sin cliente se registra como «Consumidor final» (sólo contado).</p>}
          </div>
          <Campo label="Condición de venta">
            <Select value={condicion} onChange={(e) => setCondicion(e.target.value as 'contado' | 'cuenta_corriente')}>
              <option value="contado">Contado (se cobra ahora)</option>
              <option value="cuenta_corriente" disabled={!cliente}>Cuenta corriente</option>
            </Select>
          </Campo>
        </div>
        {condicion === 'contado' && (
          <div className="space-y-2 rounded-ctl bg-slate-50 p-3">
            <Campo label="Medio de pago"><SelectorMedio value={medio} onChange={setMedio} /></Campo>
            <Campo label={medio === 'cheque' ? 'N° de cheque' : 'Referencia (opcional)'} requerido={medio === 'cheque'}><Input value={ref} onChange={(e) => setRef(e.target.value)} /></Campo>
            <CamposMedio medio={medio} valor={extra} onChange={setExtra} ctx="cobro" importe={total} />
          </div>
        )}
        <Campo label="Observaciones"><Textarea rows={2} value={obs} onChange={(e) => setObs(e.target.value)} /></Campo>
        <AvisoCaja />
        <BotonRegistrar deshabilitado={!items.length || sinPrecio || chequeSinNumero || (condicion === 'contado' && bloqueada) || (condicion === 'cuenta_corriente' && !cliente)} cargando={m.isPending} onClick={() => void registrar()}>
          {condicion === 'contado' ? `Emitir y cobrar ${money(total)}` : `Emitir a cuenta corriente ${money(total)}`}
        </BotonRegistrar>
      </div>
      {dialogo}
    </Tarjeta>
  );
}

// ───────────── Consumo de repuestos en una OT ─────────────
function PanelConsumo({ items, setItems, vaciar }: PanelProps) {
  const toast = useToast();
  const qc = useQueryClient();
  const { confirmar, dialogo } = useConfirmar();
  const [qo, setQo] = useState('');
  const dqo = useDebounce(qo, 250);
  const [orden, setOrden] = useState<any>(null);
  const [notas, setNotas] = useState('');
  const [clave, setClave] = useState(() => nuevaClave());
  const { data: ordenes = [], isFetching } = useQuery({
    queryKey: ['rapidas', 'ordenes', dqo],
    queryFn: () => api.get<any[]>(`/ordenes${qs({ q: dqo, limite: 12 })}`),
    enabled: !orden,
  });
  const editables = ordenes.filter((o) => (ESTADOS_OT_EDITABLES as string[]).includes(o.estado));
  const m = useMutation({
    mutationFn: () => api.post<any>('/rapidas/consumo-ot', { orden_id: orden.id, notas: notas.trim() || null, idem_key: clave, items: items.map((l) => ({ articulo_id: l.articulo_id, cantidad: l.cantidad })) }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['rapidas'] });
      qc.invalidateQueries({ queryKey: ['orden', orden.id] });
      qc.invalidateQueries({ queryKey: ['ordenes'] });
      toast.ok(r.duplicado ? `Los repuestos ya estaban cargados en la OT #${numero(orden.numero)}` : `${r.agregados} repuesto${r.agregados === 1 ? '' : 's'} cargado${r.agregados === 1 ? '' : 's'} en la OT #${numero(orden.numero)}`);
      vaciar(); setClave(nuevaClave()); setNotas('');
    },
    onError: toast.error,
  });
  const registrar = async () => {
    const ok = await confirmar(
      `Cargar repuestos a la OT #${numero(orden.numero)}`,
      <div><p>{resumen(items)} · {orden.patente}{orden.cliente ? ` · ${orden.cliente}` : ''}.</p>{detalleLineas(items)}<p className="mt-2 text-xs text-tenue">Se agregan a la orden con los precios de su lista. El stock se descuenta una sola vez, cuando la orden pasa a «Lista para entregar».</p></div>,
    );
    if (ok) m.mutate();
  };
  return (
    <Tarjeta titulo="Consumo en una orden de trabajo" subtitulo="Cargá varios repuestos a la OT en un solo paso">
      <div className="space-y-4">
        {orden ? (
          <div className="flex items-center justify-between gap-3 rounded-ctl border border-marca-300 bg-marca-50 px-3 py-2.5 text-sm">
            <div className="min-w-0"><span className="font-semibold">OT #{numero(orden.numero)}</span> · {orden.patente}{orden.cliente ? ` · ${orden.cliente}` : ''}<div className="text-xs text-tenue">{ESTADO_OT_LABEL[orden.estado as EstadoOT]}{orden.deposito ? ` · Depósito ${orden.deposito}` : ''}</div></div>
            <Boton tam="sm" variante="fantasma" onClick={() => setOrden(null)}>Cambiar</Boton>
          </div>
        ) : (
          <div className="space-y-2">
            <Campo label="Orden de trabajo" requerido><Input value={qo} onChange={(e) => setQo(e.target.value)} placeholder="Patente, número de OT o cliente" autoComplete="off" /></Campo>
            {editables.length === 0 ? <p className="text-sm text-tenue">{isFetching ? 'Buscando…' : 'No hay órdenes abiertas para cargar repuestos con esa búsqueda.'}</p> : (
              <ul className="divide-y divide-borde rounded-card border border-borde">
                {editables.map((o) => (
                  <li key={o.id}>
                    <button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-marca-50" onClick={() => setOrden(o)}>
                      <span className="min-w-0"><span className="font-semibold">{o.patente}</span> <span className="text-xs text-tenue">OT #{numero(o.numero)}</span><span className="block truncate text-sm text-tenue">{o.cliente ?? ''}</span></span>
                      <Insignia>{ESTADO_OT_LABEL[o.estado as EstadoOT]}</Insignia>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-tenue">Una orden «lista» o entregada ya descontó sus repuestos: para cargarle más hay que volverla a «En reparación».</p>
          </div>
        )}
        <Carrito items={items} setItems={setItems} conPrecio={false} aviso />
        <Campo label="Notas (opcional)"><Input value={notas} onChange={(e) => setNotas(e.target.value)} maxLength={300} /></Campo>
        <BotonRegistrar deshabilitado={!orden || !items.length} cargando={m.isPending} onClick={() => void registrar()}>Cargar a la OT{orden ? ` #${numero(orden.numero)}` : ''}</BotonRegistrar>
      </div>
      {dialogo}
    </Tarjeta>
  );
}

// ───────────── Baja interna ─────────────
function PanelBaja({ items, setItems, vaciar }: PanelProps) {
  const toast = useToast();
  const qc = useQueryClient();
  const { me } = useAuth();
  const { confirmar, dialogo } = useConfirmar();
  const [motivo, setMotivo] = useState<MotivoBaja>('rotura');
  const [responsable, setResponsable] = useState('');
  const [notas, setNotas] = useState('');
  const [deposito, setDeposito] = useState('');
  const [clave, setClave] = useState(() => nuevaClave());
  const falta = motivo === 'otro' && notas.trim().length < 3;
  const m = useMutation({
    mutationFn: () => api.post<any>('/rapidas/bajas', { motivo, responsable: responsable.trim() || null, notas: notas.trim() || null, deposito_id: deposito || null, idem_key: clave, items: items.map((l) => ({ articulo_id: l.articulo_id, cantidad: l.cantidad })) }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['rapidas'] });
      qc.invalidateQueries({ queryKey: ['articulos'] });
      qc.invalidateQueries({ queryKey: ['movimientos'] });
      qc.invalidateQueries({ queryKey: ['consulta-precios'] });
      toast.ok(r.duplicado ? `La baja #${numero(r.numero)} ya estaba registrada` : `Baja #${numero(r.numero)} registrada`);
      vaciar(); setClave(nuevaClave()); setNotas(''); setResponsable('');
    },
    onError: toast.error,
  });
  const registrar = async () => {
    const ok = await confirmar(
      'Registrar baja interna',
      <div><p>{MOTIVO_BAJA_LABEL[motivo]} · {resumen(items)}.</p>{detalleLineas(items)}<p className="mt-2 text-xs text-tenue">Los artículos salen del stock. No se genera ninguna venta, cobro ni movimiento de caja.</p></div>,
      true,
    );
    if (ok) m.mutate();
  };
  return (
    <Tarjeta titulo="Baja interna de inventario" subtitulo="Rotura, pérdida, consumo interno u otro motivo justificado">
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Campo label="Motivo" requerido>
            <Select value={motivo} onChange={(e) => setMotivo(e.target.value as MotivoBaja)}>{MOTIVOS_BAJA.map((x) => <option key={x} value={x}>{MOTIVO_BAJA_LABEL[x]}</option>)}</Select>
          </Campo>
          <SelectorDeposito valor={deposito} onCambio={setDeposito} label="Depósito de salida" />
          <Campo label="Responsable (opcional)" hint={`Quién registra: ${me?.usuario.nombre ?? ''}`}><Input value={responsable} onChange={(e) => setResponsable(e.target.value)} maxLength={80} placeholder="Quién lo tenía a cargo" /></Campo>
          <Campo label="Fecha"><Input value="Hoy (se registra automáticamente)" readOnly disabled /></Campo>
        </div>
        <Campo label={motivo === 'otro' ? 'Explicación del motivo' : 'Notas (opcional)'} requerido={motivo === 'otro'}><Textarea rows={2} value={notas} onChange={(e) => setNotas(e.target.value)} maxLength={300} /></Campo>
        <Carrito items={items} setItems={setItems} conPrecio={false} aviso />
        <BotonRegistrar deshabilitado={!items.length || falta} cargando={m.isPending} onClick={() => void registrar()}>Registrar baja de {resumen(items)}</BotonRegistrar>
      </div>
      {dialogo}
    </Tarjeta>
  );
}

// ───────────── Historial ─────────────
const ETIQUETA_TIPO: Record<string, string> = { venta: 'Venta rápida', consumo_ot: 'Consumo en OT', baja_interna: 'Baja interna' };

function Historial() {
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['rapidas', 'historial'], queryFn: () => api.get<any[]>('/rapidas/historial'), refetchOnWindowFocus: true });
  return (
    <Tarjeta titulo="Operaciones recientes" className="mt-5" sinPadding>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tabla
          filas={data}
          clave={(o) => `${o.tipo}-${o.id}`}
          vacio={<Vacio icono={<ClipboardList className="size-5" />} titulo="Todavía no hay operaciones rápidas" />}
          columnas={[
            { clave: 't', titulo: 'Operación', render: (o) => <span className="font-medium">{ETIQUETA_TIPO[o.tipo] ?? o.tipo} #{numero(o.numero)}</span>, movil: 'titulo' },
            { clave: 'f', titulo: 'Fecha', render: (o) => fechaHora(o.created_at), movil: 'subtitulo' },
            {
              clave: 'd', titulo: 'Detalle', movil: 'meta',
              render: (o) =>
                o.tipo === 'venta' ? <span>{o.cliente ?? ''} <Link className="text-marca-700" to={`/ventas/${o.id}`}>Ver comprobante</Link>{o.estado === 'anulada' && <Insignia tono="gris" className="ml-1">Anulada</Insignia>}</span>
                : o.tipo === 'consumo_ot' ? <span><Link className="text-marca-700" to={`/ordenes/${o.orden_id}`}>OT #{numero(o.orden_numero)}</Link>{o.notas ? ` · ${o.notas}` : ''}</span>
                : <span>{MOTIVO_BAJA_LABEL[o.motivo as MotivoBaja] ?? o.motivo}{o.responsable ? ` · ${o.responsable}` : ''}{o.deposito ? ` · ${o.deposito}` : ''}{o.notas ? ` · ${o.notas}` : ''}</span>,
            },
            { clave: 'u', titulo: 'Registró', render: (o) => o.usuario ?? '—', movil: 'oculta' },
            { clave: 'a', titulo: 'Artículos', alinear: 'derecha', render: (o) => (o.unidades != null ? `${o.articulos} · ${cantidad(o.unidades)} u.` : o.articulos), movil: 'meta' },
            { clave: 'i', titulo: 'Importe', alinear: 'derecha', render: (o) => (o.total != null ? money(o.total) : '—'), movil: 'derecha' },
          ]}
        />
      )}
    </Tarjeta>
  );
}
