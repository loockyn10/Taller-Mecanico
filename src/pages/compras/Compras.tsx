import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Ban, Plus, ShoppingCart, Trash2 } from 'lucide-react';
import { buscarPorCodigo } from '@/lib/lector';
import { api, nuevaClave, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { invalidarDinero } from '@/lib/caja';
import { cantidad, fecha, hoyISO, money, numero } from '@/lib/format';
import { SelectorDeposito } from '@/components/SelectorDeposito';
import { Aviso, Boton, Buscador, Campo, Cargando, Check, Encabezado, ErrorCaja, Input, InputMoneda, Insignia, Modal, Select, Tabla, Tarjeta, Textarea, useConfirmar, useDebounce, useToast, Vacio } from '@/components/ui';
import { AvisoCaja, useCajaBloqueada } from '@/components/Cobro';
import { MEDIO_PAGO_LABEL, type MedioPago } from '@shared/dominio';
import { CamposMedio, errorMedio, extraAPayload, extraVacio, SelectorMedio, type ExtraMedio } from '@/components/MedioPago';

export function Compras() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const { confirmar, dialogo } = useConfirmar();
  const [q, setQ] = useState(sp.get('q') ?? '');
  const [proveedor, setProveedor] = useState('');
  const [estado, setEstado] = useState('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const dq = useDebounce(q);
  const ver = sp.get('ver');
  const { data: provs = [] } = useQuery({ queryKey: ['proveedores'], queryFn: () => api.get<any[]>('/proveedores') });
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['compras', { dq, proveedor, estado, desde, hasta }], queryFn: () => api.get<any[]>(`/compras${qs({ q: dq, proveedor_id: proveedor, estado, desde, hasta })}`) });
  const { data: det } = useQuery({ queryKey: ['compra', ver], queryFn: () => api.get(`/compras/${ver}`), enabled: !!ver });
  const anular = useMutation({
    mutationFn: (id: string) => api.post(`/compras/${id}/anular`, {}),
    onSuccess: () => {
      invalidarDinero(qc);
      ['articulos', 'movimientos', 'reposicion'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.ok('Compra anulada: stock, costos y pagos revertidos');
      setSp({});
    },
    onError: toast.error,
  });
  return (
    <>
      {dialogo}
      <Encabezado titulo="Compras" subtitulo="Ingreso de mercadería de proveedores: suma stock, actualiza costos y genera deuda" acciones={<Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => nav('/compras/nueva')}>Registrar compra</Boton>} />
      <div className="filtros mb-4 flex flex-wrap items-end gap-3">
        <Buscador value={q} onChange={setQ} placeholder="Proveedor, N° de comprobante" className="min-w-52 flex-1" />
        <Select value={proveedor} onChange={(e) => setProveedor(e.target.value)} className="w-auto" aria-label="Proveedor"><option value="">Todos los proveedores</option>{provs.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</Select>
        <Select value={estado} onChange={(e) => setEstado(e.target.value)} className="w-auto" aria-label="Estado"><option value="">Todas</option><option value="registrada">Registradas</option><option value="anulada">Anuladas</option></Select>
        <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className="w-auto" aria-label="Desde" />
        <Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className="w-auto" aria-label="Hasta" />
      </div>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={data}
            clave={(c) => c.id}
            onFila={(c) => setSp({ ver: c.id })}
            vacio={<Vacio icono={<ShoppingCart className="size-5" />} titulo="Sin compras registradas" texto="Cuando registres una compra el stock y el costo de los artículos se actualizan solos." />}
            columnas={[
              { clave: 'n', titulo: 'N°', render: (c) => `#${numero(c.numero)}`, movil: 'meta' },
              { clave: 'f', titulo: 'Fecha', render: (c) => fecha(c.fecha), movil: 'meta' },
              { clave: 'p', titulo: 'Proveedor', render: (c) => <span className="font-medium">{c.proveedor}</span>, movil: 'titulo' },
              { clave: 'd', titulo: 'Comprobante', render: (c) => `${c.tipo_doc} ${c.numero_doc ?? ''}`, movil: 'subtitulo' },
              { clave: 'e', titulo: 'Estado', render: (c) => <Insignia tono={c.estado === 'anulada' ? 'gris' : 'verde'}>{c.estado === 'anulada' ? 'Anulada' : 'Registrada'}</Insignia>, movil: 'meta' },
              { clave: 'g', titulo: 'Pago contado', alinear: 'derecha', render: (c) => (c.pagado_contado ? money(c.pagado_contado) : '—'), movil: 'oculta' },
              { clave: 't', titulo: 'Total', alinear: 'derecha', render: (c) => money(c.total), movil: 'derecha' },
            ]}
          />
        </Tarjeta>
      )}
      <Modal
        abierto={!!ver && !!det}
        onCerrar={() => setSp({})}
        titulo={det ? `Compra #${numero(det.numero)} · ${det.proveedor}` : ''}
        ancho="lg"
        pie={det?.estado === 'registrada' && <Boton variante="peligro" icono={<Ban className="size-4" />} cargando={anular.isPending} onClick={async () => { if (await confirmar('Anular compra', 'Se descontará del stock la mercadería ingresada, se restituirá el costo anterior de los artículos (si no cambió desde entonces) y se anulará el pago de contado, si lo hubo. Si la mercadería ya se vendió, la anulación se rechaza.', true)) anular.mutate(det.id); }}>Anular compra</Boton>}
      >
        {det && (
          <div className="space-y-3 text-sm">
            <p className="text-tenue">{fecha(det.fecha)} · {det.tipo_doc} {det.numero_doc ?? ''} · <Link className="text-marca-700" to={`/proveedores/${det.proveedor_id}`}>Cuenta del proveedor</Link></p>
            {det.estado === 'anulada' && <Aviso tono="rojo">Compra anulada.</Aviso>}
            <ul className="divide-y divide-borde rounded-ctl border border-borde">
              {det.items.map((i: any) => (
                <li key={i.id} className="flex justify-between gap-2 px-3 py-2">
                  <span>{i.articulo} × {cantidad(i.cantidad)} <span className="text-tenue">a {money(i.costo_unitario)}</span></span>
                  <span className="tabular-nums">{money(i.subtotal)}</span>
                </li>
              ))}
            </ul>
            <div className="space-y-1 text-right">
              <div>Neto: {money(det.neto)}</div>
              <div>IVA: {money(det.iva)}</div>
              {det.otros > 0 && <div>Otros impuestos: {money(det.otros)}</div>}
              <div className="text-base font-bold">Total: {money(det.total)}</div>
            </div>
            {det.pagos.length > 0 && (
              <div>
                <h3 className="mb-1 font-semibold">Pago de contado</h3>
                <ul className="divide-y divide-borde rounded-ctl border border-borde">
                  {det.pagos.map((p: any) => <li key={p.id} className="flex justify-between px-3 py-2"><span>Pago #{numero(p.numero)} · {MEDIO_PAGO_LABEL[p.medio as MedioPago]} {p.estado === 'anulado' && <Insignia tono="gris">Anulado</Insignia>}</span><span className="tabular-nums">{money(p.importe)}</span></li>)}
                </ul>
              </div>
            )}
            {det.notas && <p><span className="font-medium">Notas:</span> {det.notas}</p>}
          </div>
        )}
      </Modal>
    </>
  );
}

interface LineaCompra {
  articulo: { id: string; nombre: string; codigo?: string | null; costo: number; stock: number };
  cantidad: number;
  costo: number;
}

export function NuevaCompra() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useAuth();
  const bloqueada = useCajaBloqueada();
  const precarga = (useLocation().state as any)?.precarga as { proveedor_id: string | null; items: LineaCompra[] } | undefined;
  const { data: provs = [] } = useQuery({ queryKey: ['proveedores'], queryFn: () => api.get<any[]>('/proveedores') });
  const [prov, setProv] = useState(precarga?.proveedor_id ?? '');
  const [f, setF] = useState({ fecha: hoyISO(), tipo_doc: 'factura', numero_doc: '', iva: 0, otros: 0, actualizar_costos: true, notas: '' });
  const [items, setItems] = useState<LineaCompra[]>(precarga?.items ?? []);
  const [contado, setContado] = useState(false);
  const [pago, setPago] = useState<{ medio: MedioPago; importe: number | null; referencia: string }>({ medio: 'efectivo', importe: null, referencia: '' });
  const [extra, setExtra] = useState<ExtraMedio>(extraVacio());
  const [vence, setVence] = useState('');
  const [deposito, setDeposito] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounce(q);
  const [clave] = useState(nuevaClave());
  const { data: res = [] } = useQuery({ queryKey: ['articulos', { q: dq, compra: 1 }], queryFn: () => api.get<any[]>(`/articulos?limite=15&q=${encodeURIComponent(dq)}`), enabled: dq.length >= 1 });
  const neto = items.reduce((a, i) => a + Math.round(i.cantidad * i.costo), 0);
  const total = neto + f.iva + f.otros;
  const importePago = pago.importe ?? total;
  const chequeSinNumero = contado && !!errorMedio(pago.medio, pago.referencia, extra, 'pago_proveedor');
  useEffect(() => {
    if (!prov && precarga?.proveedor_id) setProv(precarga.proveedor_id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const m = useMutation({
    mutationFn: () =>
      api.post('/compras', {
        proveedor_id: prov, ...f, deposito_id: deposito || null, numero_doc: f.numero_doc || null, vencimiento: !contado && vence ? vence : null,
        items: items.map((i) => ({ articulo_id: i.articulo.id, cantidad: i.cantidad, costo_unitario: i.costo })), idem_key: clave,
        pago: contado ? { medio: pago.medio, importe: importePago, referencia: pago.referencia.trim() || null, ...extraAPayload(pago.medio, extra, 'pago_proveedor') } : null,
      }),
    onSuccess: () => {
      invalidarDinero(qc);
      ['articulos', 'movimientos', 'reposicion'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.ok('Compra registrada. Stock y costos actualizados.');
      nav('/compras');
    },
    onError: toast.error,
  });
  const valido = !!prov && items.length > 0 && items.every((i) => i.cantidad > 0) && !chequeSinNumero && !(contado && (bloqueada || importePago <= 0 || importePago > total));
  return (
    <>
      <Encabezado titulo="Registrar compra" volver="/compras" />
      <div className="grid gap-5 xl:grid-cols-3">
        <Tarjeta titulo="Artículos recibidos" className="xl:col-span-2">
          <Buscador value={q} onChange={setQ} placeholder="Buscar artículo para agregar… (o escaneá el código de barras)" onEnter={async (codigo) => { const a = await buscarPorCodigo(codigo).catch(() => null); if (!a) return toast.error(new Error(`No hay ningún artículo con el código ${codigo}`)); setItems((prev) => (prev.some((i) => i.articulo.id === a.id) ? prev : [...prev, { articulo: a, cantidad: 1, costo: a.costo }])); setQ(''); }} />
          {dq && (
            <ul className="mt-1.5 max-h-56 divide-y divide-borde overflow-y-auto rounded-ctl border border-borde text-sm">
              {res.map((a) => (
                <li key={a.id}>
                  <button type="button" className="flex w-full justify-between px-3 py-2 text-left hover:bg-marca-50" onClick={() => { if (!items.some((i) => i.articulo.id === a.id)) setItems([...items, { articulo: a, cantidad: 1, costo: a.costo }]); setQ(''); }}>
                    <span>{a.nombre} <span className="text-tenue">{a.codigo ?? ''}</span></span>
                    <span className="text-tenue">Costo {money(a.costo)} · stock {cantidad(a.stock)}</span>
                  </button>
                </li>
              ))}
              {!res.length && <li className="px-3 py-2 text-tenue">Sin resultados. Crealo primero en Artículos.</li>}
            </ul>
          )}
          <ul className="mt-4 divide-y divide-borde rounded-card border border-borde">
            {items.map((i, idx) => (
              <li key={i.articulo.id} className="grid grid-cols-2 items-center gap-2 px-3 py-2 sm:grid-cols-[1fr_100px_150px_120px_40px]">
                <span className="col-span-2 break-words text-sm font-medium sm:col-span-1">{i.articulo.nombre}</span>
                <Input type="number" min={0.001} step="any" value={i.cantidad} onChange={(e) => setItems(items.map((x, j) => (j === idx ? { ...x, cantidad: Math.round(Number(e.target.value) * 1000) / 1000 } : x)))} className="h-9 text-right" aria-label="Cantidad" />
                <InputMoneda value={i.costo} onChange={(v) => setItems(items.map((x, j) => (j === idx ? { ...x, costo: v } : x)))} className="[&_input]:h-9" />
                <span className="text-right text-sm font-semibold tabular-nums">{money(Math.round(i.cantidad * i.costo))}</span>
                <Boton variante="fantasma" tam="sm" icono={<Trash2 className="size-4 text-red-600" />} onClick={() => setItems(items.filter((_, j) => j !== idx))} aria-label="Quitar" />
              </li>
            ))}
            {!items.length && <li className="px-4 py-6 text-center text-sm text-tenue">Agregá los artículos recibidos</li>}
          </ul>
        </Tarjeta>
        <div className="space-y-5">
          <Tarjeta titulo="Comprobante del proveedor">
            <div className="space-y-3">
              <Campo label="Proveedor" requerido>
                <Select value={prov} onChange={(e) => setProv(e.target.value)}>
                  <option value="">— Elegir —</option>
                  {provs.filter((p) => p.activo).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                </Select>
              </Campo>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Campo label="Tipo">
                  <Select value={f.tipo_doc} onChange={(e) => setF({ ...f, tipo_doc: e.target.value })}>
                    <option value="factura">Factura</option><option value="remito">Remito</option><option value="ticket">Ticket</option><option value="otro">Otro</option>
                  </Select>
                </Campo>
                <Campo label="Fecha"><Input type="date" value={f.fecha} max={hoyISO()} disabled={!puede('fechas.retroactivas')} onChange={(e) => setF({ ...f, fecha: e.target.value })} /></Campo>
                <SelectorDeposito valor={deposito} onCambio={setDeposito} label="Depósito de ingreso" />
              </div>
              <Campo label="Número"><Input value={f.numero_doc} onChange={(e) => setF({ ...f, numero_doc: e.target.value })} placeholder="A-0001-00001234" /></Campo>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Campo label="IVA"><InputMoneda value={f.iva} onChange={(v) => setF({ ...f, iva: v })} /></Campo>
                <Campo label="Otros impuestos"><InputMoneda value={f.otros} onChange={(v) => setF({ ...f, otros: v })} /></Campo>
              </div>
              <Check checked={f.actualizar_costos} onChange={(v) => setF({ ...f, actualizar_costos: v })} label="Actualizar el costo de los artículos" />
              <Campo label="Notas"><Textarea rows={2} value={f.notas} onChange={(e) => setF({ ...f, notas: e.target.value })} /></Campo>
              <div className="rounded-ctl bg-slate-50 p-3 text-right text-sm">
                <div>Neto: {money(neto)}</div>
                <div className="text-lg font-bold">Total: {money(total)}</div>
              </div>
            </div>
          </Tarjeta>
          <Tarjeta titulo="Forma de pago">
            <div className="space-y-3">
              <Check checked={contado} onChange={setContado} label="Pagar ahora (de contado)" />
              {!contado && (
                <>
                  <p className="text-xs text-tenue">Si no se paga ahora, queda como deuda en la cuenta corriente del proveedor.</p>
                  <Campo label="Vencimiento del pago (opcional)" hint="Por defecto, el plazo de pago configurado en el taller"><Input type="date" value={vence} min={f.fecha} onChange={(e) => setVence(e.target.value)} /></Campo>
                </>
              )}
              {contado && (
                <>
                  <AvisoCaja />
                  <Campo label="Medio de pago"><SelectorMedio value={pago.medio} onChange={(medio) => setPago({ ...pago, medio })} /></Campo>
                  <Campo label="Importe pagado" hint={importePago > total ? 'No puede superar el total' : importePago < total ? `Queda una deuda de ${money(total - importePago)}` : undefined}><InputMoneda value={importePago} onChange={(v) => setPago({ ...pago, importe: v })} /></Campo>
                  <Campo label={pago.medio === 'cheque' ? 'N° de cheque' : 'Referencia'} requerido={pago.medio === 'cheque'}><Input value={pago.referencia} onChange={(e) => setPago({ ...pago, referencia: e.target.value })} /></Campo>
                  <CamposMedio medio={pago.medio} valor={extra} onChange={setExtra} ctx="pago_proveedor" importe={importePago} />
                </>
              )}
            </div>
          </Tarjeta>
          <Boton variante="primario" tam="lg" className="w-full" disabled={!valido} cargando={m.isPending} onClick={() => m.mutate()}>{contado ? `Registrar y pagar ${money(importePago)}` : 'Registrar compra'}</Boton>
        </div>
      </div>
    </>
  );
}
