import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Ban, Plus, ShoppingCart, Trash2 } from 'lucide-react';
import { api, nuevaClave } from '@/lib/api';
import { cantidad, fecha, hoyISO, money, numero } from '@/lib/format';
import { Boton, Buscador, Campo, Cargando, Check, Encabezado, ErrorCaja, Input, InputMoneda, Insignia, Modal, Select, Tabla, Tarjeta, Textarea, useConfirmar, useDebounce, useToast, Vacio } from '@/components/ui';

export function Compras() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { confirmar, dialogo } = useConfirmar();
  const [ver, setVer] = useState<string | null>(null);
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['compras'], queryFn: () => api.get<any[]>('/compras') });
  const { data: det } = useQuery({ queryKey: ['compra', ver], queryFn: () => api.get(`/compras/${ver}`), enabled: !!ver });
  const anular = useMutation({
    mutationFn: (id: string) => api.post(`/compras/${id}/anular`, {}),
    onSuccess: () => {
      ['compras', 'compra', 'articulos', 'proveedores'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.ok('Compra anulada y stock revertido');
      setVer(null);
    },
    onError: toast.error,
  });
  return (
    <>
      {dialogo}
      <Encabezado titulo="Compras" subtitulo="Ingreso de mercadería de proveedores: suma stock y actualiza costos" acciones={<Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => nav('/compras/nueva')}>Registrar compra</Boton>} />
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={data}
            clave={(c) => c.id}
            onFila={(c) => setVer(c.id)}
            vacio={<Vacio icono={<ShoppingCart className="size-5" />} titulo="Sin compras registradas" />}
            columnas={[
              { clave: 'n', titulo: 'N°', render: (c) => `#${numero(c.numero)}`, movil: 'meta' },
              { clave: 'f', titulo: 'Fecha', render: (c) => fecha(c.fecha), movil: 'meta' },
              { clave: 'p', titulo: 'Proveedor', render: (c) => <span className="font-medium">{c.proveedor}</span>, movil: 'titulo' },
              { clave: 'd', titulo: 'Comprobante', render: (c) => `${c.tipo_doc} ${c.numero_doc ?? ''}`, movil: 'subtitulo' },
              { clave: 'e', titulo: 'Estado', render: (c) => <Insignia tono={c.estado === 'anulada' ? 'gris' : 'verde'}>{c.estado === 'anulada' ? 'Anulada' : 'Registrada'}</Insignia>, movil: 'meta' },
              { clave: 't', titulo: 'Total', alinear: 'derecha', render: (c) => money(c.total), movil: 'derecha' },
            ]}
          />
        </Tarjeta>
      )}
      <Modal
        abierto={!!ver && !!det}
        onCerrar={() => setVer(null)}
        titulo={det ? `Compra #${numero(det.numero)} · ${det.proveedor}` : ''}
        ancho="lg"
        pie={det?.estado === 'registrada' && <Boton variante="peligro" icono={<Ban className="size-4" />} cargando={anular.isPending} onClick={async () => { if (await confirmar('Anular compra', 'Se descontará del stock la mercadería ingresada con esta compra.', true)) anular.mutate(det.id); }}>Anular compra</Boton>}
      >
        {det && (
          <div className="space-y-3 text-sm">
            <p className="text-tenue">{fecha(det.fecha)} · {det.tipo_doc} {det.numero_doc ?? ''}</p>
            <ul className="divide-y divide-borde rounded-lg border border-borde">
              {det.items.map((i: any) => (
                <li key={i.id} className="flex justify-between gap-2 px-3 py-2">
                  <span>{i.articulo} × {cantidad(i.cantidad)}</span>
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
          </div>
        )}
      </Modal>
    </>
  );
}

export function NuevaCompra() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: provs = [] } = useQuery({ queryKey: ['proveedores'], queryFn: () => api.get<any[]>('/proveedores') });
  const [prov, setProv] = useState('');
  const [f, setF] = useState({ fecha: hoyISO(), tipo_doc: 'factura', numero_doc: '', iva: 0, otros: 0, actualizar_costos: true, notas: '' });
  const [items, setItems] = useState<Array<{ articulo: any; cantidad: number; costo: number }>>([]);
  const [q, setQ] = useState('');
  const dq = useDebounce(q);
  const [clave] = useState(nuevaClave());
  const { data: res = [] } = useQuery({ queryKey: ['articulos', { q: dq, compra: 1 }], queryFn: () => api.get<any[]>(`/articulos?limite=15&q=${encodeURIComponent(dq)}`), enabled: dq.length >= 1 });
  const neto = items.reduce((a, i) => a + Math.round(i.cantidad * i.costo), 0);
  const m = useMutation({
    mutationFn: () => api.post('/compras', { proveedor_id: prov, ...f, numero_doc: f.numero_doc || null, items: items.map((i) => ({ articulo_id: i.articulo.id, cantidad: i.cantidad, costo_unitario: i.costo })), idem_key: clave }),
    onSuccess: () => {
      ['compras', 'articulos', 'proveedores', 'movimientos'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.ok('Compra registrada. Stock actualizado.');
      nav('/compras');
    },
    onError: toast.error,
  });
  return (
    <>
      <Encabezado titulo="Registrar compra" volver="/compras" />
      <div className="grid gap-5 xl:grid-cols-3">
        <Tarjeta titulo="Artículos recibidos" className="xl:col-span-2">
          <Buscador value={q} onChange={setQ} placeholder="Buscar artículo para agregar…" />
          {dq && (
            <ul className="mt-1.5 max-h-56 divide-y divide-borde overflow-y-auto rounded-lg border border-borde text-sm">
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
          <ul className="mt-4 divide-y divide-borde rounded-xl border border-borde">
            {items.map((i, idx) => (
              <li key={i.articulo.id} className="grid grid-cols-2 items-center gap-2 px-3 py-2 sm:grid-cols-[1fr_100px_150px_120px_40px]">
                <span className="col-span-2 truncate text-sm font-medium sm:col-span-1">{i.articulo.nombre}</span>
                <Input type="number" min={0.01} step="any" value={i.cantidad} onChange={(e) => setItems(items.map((x, j) => (j === idx ? { ...x, cantidad: Number(e.target.value) } : x)))} className="h-9 text-right" aria-label="Cantidad" />
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
              <div className="grid grid-cols-2 gap-3">
                <Campo label="Tipo">
                  <Select value={f.tipo_doc} onChange={(e) => setF({ ...f, tipo_doc: e.target.value })}>
                    <option value="factura">Factura</option><option value="remito">Remito</option><option value="ticket">Ticket</option><option value="otro">Otro</option>
                  </Select>
                </Campo>
                <Campo label="Fecha"><Input type="date" value={f.fecha} onChange={(e) => setF({ ...f, fecha: e.target.value })} /></Campo>
              </div>
              <Campo label="Número"><Input value={f.numero_doc} onChange={(e) => setF({ ...f, numero_doc: e.target.value })} placeholder="A-0001-00001234" /></Campo>
              <div className="grid grid-cols-2 gap-3">
                <Campo label="IVA"><InputMoneda value={f.iva} onChange={(v) => setF({ ...f, iva: v })} /></Campo>
                <Campo label="Otros impuestos"><InputMoneda value={f.otros} onChange={(v) => setF({ ...f, otros: v })} /></Campo>
              </div>
              <Check checked={f.actualizar_costos} onChange={(v) => setF({ ...f, actualizar_costos: v })} label="Actualizar el costo de los artículos" />
              <Campo label="Notas"><Textarea rows={2} value={f.notas} onChange={(e) => setF({ ...f, notas: e.target.value })} /></Campo>
              <div className="rounded-lg bg-slate-50 p-3 text-right text-sm">
                <div>Neto: {money(neto)}</div>
                <div className="text-lg font-bold">Total: {money(neto + f.iva + f.otros)}</div>
              </div>
            </div>
          </Tarjeta>
          <Boton variante="primario" tam="lg" className="w-full" disabled={!prov || !items.length || items.some((i) => !(i.cantidad > 0))} cargando={m.isPending} onClick={() => m.mutate()}>Registrar compra</Boton>
        </div>
      </div>
    </>
  );
}
