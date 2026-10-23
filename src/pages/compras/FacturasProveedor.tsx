// Facturas de proveedores: registro de comprobantes (IVA, vencimiento, condición de pago), asociados a una compra u orden, sin duplicar.
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { Ban, Download, FileText, Plus } from 'lucide-react';
import { api, nuevaClave, qs } from '@/lib/api';
import { invalidarDinero } from '@/lib/caja';
import { useConfigTaller } from '@/lib/config';
import { descargarCSV, pesosCSV } from '@/lib/csv';
import { fecha, hoyISO, money, numero, sumarDias } from '@/lib/format';
import { Aviso, Boton, Buscador, Campo, Cargando, Check, Encabezado, ErrorCaja, Input, InputMoneda, Insignia, Modal, Select, Tabla, Tarjeta, Textarea, useDebounce, useToast, Vacio } from '@/components/ui';
import { esNotaCredito, normalizarNroComprobante, TIPO_COMPROBANTE_LABEL, TIPOS_COMPROBANTE_PROVEEDOR } from '@shared/dominio';

function FormFactura({ inicial, onCerrar }: { inicial?: { proveedor_id?: string; orden_compra_id?: string; compra_id?: string; total?: number }; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: cfg } = useConfigTaller();
  const { data: provs = [] } = useQuery({ queryKey: ['proveedores'], queryFn: () => api.get<any[]>('/proveedores') });
  const [f, setF] = useState({
    proveedor_id: inicial?.proveedor_id ?? '', tipo: 'factura_a', nro: '', fecha: hoyISO(), cuit: '', neto_gravado: 0, no_gravado: 0, iva_21: 0, iva_10_5: 0, iva_27: 0, otros_tributos: 0,
    condicion_pago: 'cuenta_corriente', dias_plazo: 30, vencimiento: '', asociar: inicial?.orden_compra_id ? 'orden' : inicial?.compra_id ? 'compra' : '', compra_id: inicial?.compra_id ?? '', orden_compra_id: inicial?.orden_compra_id ?? '', notas: '',
  });
  const [clave] = useState(nuevaClave());
  const prov = provs.find((p) => p.id === f.proveedor_id);
  const total = f.neto_gravado + f.no_gravado + f.iva_21 + f.iva_10_5 + f.iva_27 + f.otros_tributos;
  const nroNormalizado = normalizarNroComprobante(f.nro);
  const { data: compras = [] } = useQuery({ queryKey: ['compras', { proveedor: f.proveedor_id, para: 'factura' }], queryFn: () => api.get<any[]>(`/compras${qs({ proveedor_id: f.proveedor_id, estado: 'registrada' })}`), enabled: !!f.proveedor_id && f.asociar === 'compra' });
  const { data: ordenes = [] } = useQuery({ queryKey: ['ordenes-compra', { proveedor: f.proveedor_id, para: 'factura' }], queryFn: () => api.get<any[]>(`/ordenes-compra${qs({ proveedor_id: f.proveedor_id })}`), enabled: !!f.proveedor_id && f.asociar === 'orden' });
  const plazoCfg = cfg?.config.plazo_pago_dias ?? 30;
  const venc = f.vencimiento || (f.condicion_pago === 'contado' ? f.fecha : sumarDias(f.fecha, f.condicion_pago === 'plazo' ? f.dias_plazo : plazoCfg));
  useEffect(() => {
    if (inicial?.total && !f.neto_gravado && !f.iva_21) setF((x) => ({ ...x, neto_gravado: Math.round(inicial.total! / 1.21), iva_21: inicial.total! - Math.round(inicial.total! / 1.21) }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const compraSel = compras.find((c) => c.id === f.compra_id);
  const m = useMutation({
    mutationFn: () =>
      api.post('/facturas-proveedor', {
        proveedor_id: f.proveedor_id, tipo: f.tipo, nro_comprobante: f.nro, fecha: f.fecha, cuit: f.cuit || null, neto_gravado: f.neto_gravado, no_gravado: f.no_gravado, iva_21: f.iva_21, iva_10_5: f.iva_10_5, iva_27: f.iva_27,
        otros_tributos: f.otros_tributos, total, condicion_pago: f.condicion_pago, dias_plazo: f.condicion_pago === 'plazo' ? f.dias_plazo : null, vencimiento: f.vencimiento || null,
        compra_id: f.asociar === 'compra' ? f.compra_id || null : null, orden_compra_id: f.asociar === 'orden' ? f.orden_compra_id || null : null, notas: f.notas || null, idem_key: clave,
      }),
    onSuccess: (r: any) => {
      invalidarDinero(qc);
      toast.ok(r.genera_deuda ? 'Factura registrada. La deuda con el proveedor se actualizó.' : `Factura registrada y asociada a la compra${r.diferencia_con_compra ? ` (difiere ${money(Math.abs(r.diferencia_con_compra))} del total de la compra)` : ''}.`);
      onCerrar();
    },
    onError: toast.error,
  });
  const nc = esNotaCredito(f.tipo);
  const valido = !!f.proveedor_id && !!nroNormalizado && total > 0 && (f.asociar !== 'compra' || !!f.compra_id) && (f.asociar !== 'orden' || !!f.orden_compra_id);
  const setIva = (neto: number) => setF((x) => ({ ...x, neto_gravado: neto, iva_21: x.iva_10_5 || x.iva_27 ? x.iva_21 : Math.round(neto * 0.21) }));
  return (
    <Modal abierto onCerrar={onCerrar} titulo="Registrar factura de proveedor" ancho="xl" pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" disabled={!valido} cargando={m.isPending} onClick={() => m.mutate()}>Registrar {nc ? 'nota de crédito' : 'factura'}</Boton></>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <Campo label="Proveedor" requerido className="sm:col-span-2"><Select value={f.proveedor_id} onChange={(e) => { const p = provs.find((x) => x.id === e.target.value); setF({ ...f, proveedor_id: e.target.value, compra_id: '', orden_compra_id: '', cuit: p?.cuit ?? '' }); }}><option value="">— Elegir —</option>{provs.filter((p) => p.activo).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</Select></Campo>
          <Campo label="Tipo de comprobante"><Select value={f.tipo} onChange={(e) => setF({ ...f, tipo: e.target.value })}>{TIPOS_COMPROBANTE_PROVEEDOR.map((t) => <option key={t} value={t}>{TIPO_COMPROBANTE_LABEL[t]}</option>)}</Select></Campo>
          <Campo label="Fecha" requerido><Input type="date" value={f.fecha} max={hoyISO()} onChange={(e) => setF({ ...f, fecha: e.target.value })} /></Campo>
          <Campo label="Número" requerido error={f.nro && !nroNormalizado ? 'Formato 0001-00001234' : null} hint={nroNormalizado ? `Se guarda como ${nroNormalizado}` : undefined}><Input value={f.nro} onChange={(e) => setF({ ...f, nro: e.target.value })} placeholder="0001-00001234" /></Campo>
          <Campo label="CUIT del emisor" hint={prov?.cuit ? 'Debe coincidir con el del proveedor' : 'Opcional'}><Input value={f.cuit} onChange={(e) => setF({ ...f, cuit: e.target.value })} placeholder={prov?.cuit ?? '30-12345678-9'} /></Campo>
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold">Importes {nc && <span className="font-normal text-tenue">(nota de crédito: reduce la deuda)</span>}</h3>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Campo label="Neto gravado"><InputMoneda value={f.neto_gravado} onChange={setIva} /></Campo>
            <Campo label="No gravado / exento"><InputMoneda value={f.no_gravado} onChange={(v) => setF({ ...f, no_gravado: v })} /></Campo>
            <Campo label="IVA 21 %"><InputMoneda value={f.iva_21} onChange={(v) => setF({ ...f, iva_21: v })} /></Campo>
            <Campo label="IVA 10,5 %"><InputMoneda value={f.iva_10_5} onChange={(v) => setF({ ...f, iva_10_5: v })} /></Campo>
            <Campo label="IVA 27 %"><InputMoneda value={f.iva_27} onChange={(v) => setF({ ...f, iva_27: v })} /></Campo>
            <Campo label="Percepciones / otros"><InputMoneda value={f.otros_tributos} onChange={(v) => setF({ ...f, otros_tributos: v })} /></Campo>
          </div>
          <p className="mt-2 text-right text-lg font-bold">Total: {money(total)}</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          <Campo label="Condición de pago"><Select value={f.condicion_pago} onChange={(e) => setF({ ...f, condicion_pago: e.target.value, vencimiento: '' })}><option value="contado">Contado</option><option value="cuenta_corriente">Cuenta corriente ({plazoCfg} días)</option><option value="plazo">A plazo</option></Select></Campo>
          {f.condicion_pago === 'plazo' && <Campo label="Días de plazo"><Input type="number" min={1} max={365} value={f.dias_plazo} onChange={(e) => setF({ ...f, dias_plazo: Math.max(1, Number(e.target.value)) })} /></Campo>}
          <Campo label="Vencimiento" hint={f.vencimiento ? undefined : 'Calculado según la condición'}><Input type="date" value={f.vencimiento || venc} min={f.fecha} onChange={(e) => setF({ ...f, vencimiento: e.target.value })} /></Campo>
        </div>

        <div className="rounded-ctl border border-borde p-3">
          <Campo label="Asociar a">
            <Select value={f.asociar} onChange={(e) => setF({ ...f, asociar: e.target.value, compra_id: '', orden_compra_id: '' })}>
              <option value="">Nada: es una factura independiente (genera deuda)</option>
              <option value="orden">Una orden de compra ya recibida (genera deuda)</option>
              <option value="compra">Una compra ya registrada (no duplica la deuda)</option>
            </Select>
          </Campo>
          {f.asociar === 'orden' && (
            <Campo label="Orden de compra" className="mt-2">
              <Select value={f.orden_compra_id} onChange={(e) => setF({ ...f, orden_compra_id: e.target.value })}>
                <option value="">— Elegir —</option>
                {ordenes.filter((o) => ['parcial', 'recibida'].includes(o.estado)).map((o) => <option key={o.id} value={o.id}>OC #{numero(o.numero)} · {fecha(o.fecha)} · {money(o.total)}</option>)}
              </Select>
            </Campo>
          )}
          {f.asociar === 'compra' && (
            <>
              <Campo label="Compra" className="mt-2">
                <Select value={f.compra_id} onChange={(e) => setF({ ...f, compra_id: e.target.value })}>
                  <option value="">— Elegir —</option>
                  {compras.map((c) => <option key={c.id} value={c.id}>Compra #{numero(c.numero)} · {fecha(c.fecha)} · {money(c.total)}{c.numero_doc ? ` · ${c.numero_doc}` : ''}</option>)}
                </Select>
              </Campo>
              {compraSel && total !== compraSel.total && <Aviso tono="ambar" className="mt-2">El total de la factura ({money(total)}) difiere del de la compra ({money(compraSel.total)}). Se registra igual y la diferencia queda a la vista.</Aviso>}
            </>
          )}
          {f.asociar !== 'compra' && <p className="mt-2 text-xs text-tenue">La mercadería no se vuelve a sumar al stock: sólo se registra el comprobante y la deuda.</p>}
        </div>
        <Campo label="Notas"><Textarea rows={2} value={f.notas} onChange={(e) => setF({ ...f, notas: e.target.value })} /></Campo>
      </div>
    </Modal>
  );
}

export function FacturasProveedor() {
  const qc = useQueryClient();
  const toast = useToast();
  const loc = useLocation();
  const [nueva, setNueva] = useState<any | null>((loc.state as any)?.nueva ?? null);
  const [proveedor, setProveedor] = useState('');
  const [estado, setEstado] = useState('registrada');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [vencidas, setVencidas] = useState(false);
  const [q, setQ] = useState('');
  const dq = useDebounce(q);
  const [anular, setAnular] = useState<any | null>(null);
  const [motivo, setMotivo] = useState('');
  const { data: provs = [] } = useQuery({ queryKey: ['proveedores'], queryFn: () => api.get<any[]>('/proveedores') });
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['facturas', { proveedor, estado, desde, hasta, vencidas, dq }], queryFn: () => api.get<any[]>(`/facturas-proveedor${qs({ proveedor_id: proveedor, estado, desde, hasta, vencidas: vencidas ? 1 : undefined, q: dq })}`) });
  const m = useMutation({
    mutationFn: () => api.post(`/facturas-proveedor/${anular.id}/anular`, { motivo }),
    onSuccess: () => { invalidarDinero(qc); toast.ok('Factura anulada'); setAnular(null); setMotivo(''); },
    onError: toast.error,
  });
  const tot = useMemo(() => data.filter((f) => f.estado === 'registrada').reduce((a, f) => ({ total: a.total + f.signo * f.total, iva: a.iva + f.signo * (f.iva_21 + f.iva_10_5 + f.iva_27) }), { total: 0, iva: 0 }), [data]);
  const exportar = () => descargarCSV('facturas-proveedores', ['Fecha', 'Proveedor', 'CUIT', 'Tipo', 'Número', 'Neto gravado', 'No gravado', 'IVA 21', 'IVA 10,5', 'IVA 27', 'Otros', 'Total', 'Condición', 'Vencimiento', 'Asociada a', 'Estado'], data.map((f) => [f.fecha, f.proveedor, f.cuit ?? '', TIPO_COMPROBANTE_LABEL[f.tipo as keyof typeof TIPO_COMPROBANTE_LABEL], f.nro_comprobante, pesosCSV(f.signo * f.neto_gravado), pesosCSV(f.signo * f.no_gravado), pesosCSV(f.signo * f.iva_21), pesosCSV(f.signo * f.iva_10_5), pesosCSV(f.signo * f.iva_27), pesosCSV(f.signo * f.otros_tributos), pesosCSV(f.signo * f.total), f.condicion_pago, f.vencimiento, f.compra_numero ? `Compra #${f.compra_numero}` : f.orden_numero ? `OC #${f.orden_numero}` : '', f.estado]));
  return (
    <>
      <Encabezado titulo="Facturas de proveedores" subtitulo="Comprobantes de compra, IVA y vencimientos" acciones={<Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => setNueva({})}>Registrar factura</Boton>} />
      <div className="filtros mb-4 flex flex-wrap items-end gap-3">
        <Buscador value={q} onChange={setQ} placeholder="Proveedor, número o CUIT…" className="min-w-52 flex-1" />
        <Campo label="Proveedor"><Select value={proveedor} onChange={(e) => setProveedor(e.target.value)} className="w-auto"><option value="">Todos</option>{provs.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</Select></Campo>
        <Campo label="Estado"><Select value={estado} onChange={(e) => setEstado(e.target.value)} className="w-auto"><option value="">Todas</option><option value="registrada">Registradas</option><option value="anulada">Anuladas</option></Select></Campo>
        <Campo label="Desde"><Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} /></Campo>
        <Campo label="Hasta"><Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} /></Campo>
        <Check checked={vencidas} onChange={setVencidas} label="Vencidas" />
        <Boton icono={<Download className="size-4" />} disabled={!data.length} onClick={exportar}>CSV</Boton>
      </div>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding titulo="Comprobantes" acciones={<span className="text-sm text-tenue">Total {money(tot.total)} · IVA {money(tot.iva)}</span>}>
          <Tabla
            filas={data}
            clave={(f: any) => f.id}
            vacio={<Vacio icono={<FileText className="size-5" />} titulo="Sin facturas" texto="Registrá las facturas de tus proveedores para llevar la deuda y los vencimientos." accion={<Boton variante="primario" onClick={() => setNueva({})}>Registrar factura</Boton>} />}
            columnas={[
              { clave: 'f', titulo: 'Fecha', render: (f: any) => fecha(f.fecha), movil: 'meta' },
              { clave: 'p', titulo: 'Proveedor', render: (f: any) => <span className={f.estado === 'anulada' ? 'text-tenue line-through' : 'font-medium'}>{f.proveedor}</span>, movil: 'titulo' },
              { clave: 'n', titulo: 'Comprobante', render: (f: any) => <span>{TIPO_COMPROBANTE_LABEL[f.tipo as keyof typeof TIPO_COMPROBANTE_LABEL]} {f.nro_comprobante}</span>, movil: 'subtitulo' },
              { clave: 'a', titulo: 'Asociada', render: (f: any) => (f.compra_numero ? `Compra #${numero(f.compra_numero)}` : f.orden_numero ? `OC #${numero(f.orden_numero)}` : <span className="text-tenue">—</span>), movil: 'meta' },
              { clave: 'v', titulo: 'Vence', render: (f: any) => (esNotaCredito(f.tipo) ? '' : <span className={f.estado === 'registrada' && f.vencimiento < hoyISO() ? 'font-medium text-red-600' : ''}>{fecha(f.vencimiento)}</span>), movil: 'meta' },
              { clave: 'i', titulo: 'IVA', alinear: 'derecha', render: (f: any) => money(f.signo * (f.iva_21 + f.iva_10_5 + f.iva_27)), movil: 'meta' },
              { clave: 't', titulo: 'Total', alinear: 'derecha', render: (f: any) => <span className={esNotaCredito(f.tipo) ? 'text-emerald-700' : ''}>{money(f.signo * f.total)}</span>, movil: 'derecha' },
              { clave: 'x', titulo: '', render: (f: any) => (f.estado === 'registrada' ? <Boton tam="sm" variante="fantasma" icono={<Ban className="size-4" />} onClick={() => setAnular(f)}>Anular</Boton> : <Insignia>Anulada</Insignia>), movil: 'meta' },
            ]}
          />
        </Tarjeta>
      )}
      {nueva && <FormFactura inicial={nueva} onCerrar={() => setNueva(null)} />}
      <Modal abierto={!!anular} onCerrar={() => setAnular(null)} titulo="Anular factura" ancho="sm" pie={<><Boton onClick={() => setAnular(null)}>Cancelar</Boton><Boton variante="peligro" disabled={motivo.trim().length < 3} cargando={m.isPending} onClick={() => m.mutate()}>Anular</Boton></>}>
        <div className="space-y-3">
          <p className="text-sm text-tenue">{anular?.nro_comprobante}. Si generaba deuda, la deuda con el proveedor se reduce. Los pagos ya hechos no se tocan.</p>
          <Campo label="Motivo" requerido><Input value={motivo} onChange={(e) => setMotivo(e.target.value)} autoFocus /></Campo>
        </div>
      </Modal>
    </>
  );
}
