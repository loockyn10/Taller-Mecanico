import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Ban, PiggyBank, Plus, Printer, Receipt, ShoppingBag, Undo2, Wallet } from 'lucide-react';
import { api, nuevaClave, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fecha, money, numero } from '@/lib/format';
import { SelectorDeposito } from '@/components/SelectorDeposito';
import { Aviso, Boton, Buscador, Campo, Cargando, Dato, Encabezado, ErrorCaja, Input, Insignia, Modal, Select, Tabla, Tarjeta, Textarea, useDebounce, useToast, Vacio } from '@/components/ui';
import { EstadoCobroBadge } from '@/components/estados';
import { EditorItems, itemsDesdeApi, itemsParaApi, paramsVacios, useDefectosEnParams, type ItemUI, type ParamsUI } from '@/components/EditorItems';
import { SelectorCliente, type ClienteMin } from '@/components/selectores';
import { AvisoCaja, ModalCobro, useCajaBloqueada } from '@/components/Cobro';
import { ModalAplicarCreditos, ModalDevolucion } from '@/components/Devolucion';
import { SelectorLista, useListaPorDefecto } from '@/components/SelectorLista';
import { invalidarDinero } from '@/lib/caja';
import { calcularTotales } from '@shared/totals';
import { type MedioPago } from '@shared/dominio';
import { CamposMedio, errorMedio, extraAPayload, extraVacio, SelectorMedio, type ExtraMedio } from '@/components/MedioPago';

export function Ventas() {
  const nav = useNavigate();
  const { puede } = useAuth();
  const [q, setQ] = useState('');
  const [estado, setEstado] = useState('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const dq = useDebounce(q);
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['ventas', { dq, estado, desde, hasta }], queryFn: () => api.get<any[]>(`/ventas${qs({ q: dq, estado, desde, hasta })}`) });
  return (
    <>
      <Encabezado
        titulo="Ventas y comprobantes"
        subtitulo="Comprobantes internos generados desde OT o ventas de mostrador"
        acciones={puede('ventas.emitir') && <Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => nav('/ventas/nueva')}>Venta de mostrador</Boton>}
      />
      <Aviso className="mb-4">Los comprobantes son <strong>internos (no fiscales)</strong>. La facturación electrónica ARCA todavía no está integrada; el sistema está preparado para incorporarla sin rehacer ventas ni cobros.</Aviso>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Buscador value={q} onChange={setQ} placeholder="Cliente o número" className="min-w-56 flex-1" />
        <Select value={estado} onChange={(e) => setEstado(e.target.value)} className="w-auto" aria-label="Estado de cobro">
          <option value="">Todos los estados</option>
          <option value="pendientes">Pendientes de cobro</option>
          <option value="parciales">Con cobro parcial</option>
          <option value="cobradas">Cobradas</option>
          <option value="devueltas">Con devoluciones</option>
          <option value="anuladas">Anuladas</option>
        </Select>
        <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className="w-auto" aria-label="Desde" />
        <Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className="w-auto" aria-label="Hasta" />
      </div>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={data}
            clave={(v) => v.id}
            onFila={(v) => nav(`/ventas/${v.id}`)}
            vacio={<Vacio icono={<Receipt className="size-5" />} titulo="No hay comprobantes" />}
            columnas={[
              { clave: 'n', titulo: 'N°', render: (v) => <span className="font-medium">#{numero(v.numero)}</span>, movil: 'meta' },
              { clave: 'f', titulo: 'Fecha', render: (v) => fecha(v.fecha), movil: 'meta' },
              { clave: 'c', titulo: 'Cliente', render: (v) => v.cliente, movil: 'titulo' },
              { clave: 'o', titulo: 'Origen', render: (v) => (v.orden_numero ? `OT #${numero(v.orden_numero)}` : 'Mostrador'), movil: 'subtitulo' },
              { clave: 'e', titulo: 'Estado', render: (v) => <span className="flex flex-wrap gap-1"><EstadoCobroBadge total={v.total} cobrado={v.cobrado} devuelto={v.devuelto} estado={v.estado} />{v.devuelto > 0 && v.devuelto < v.total && <Insignia tono="violeta">Dev. parcial</Insignia>}</span>, movil: 'meta' },
              { clave: 's', titulo: 'Saldo', alinear: 'derecha', render: (v) => (v.estado === 'emitida' && v.saldo > 0 ? money(v.saldo) : '—'), movil: 'oculta' },
              { clave: 't', titulo: 'Total', alinear: 'derecha', render: (v) => money(v.total), movil: 'derecha' },
            ]}
          />
        </Tarjeta>
      )}
    </>
  );
}

export function VentaDetalle() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useAuth();
  const [cobro, setCobro] = useState(false);
  const [devolver, setDevolver] = useState(false);
  const [aplicar, setAplicar] = useState(false);
  const [anular, setAnular] = useState(false);
  const [motivo, setMotivo] = useState('');
  const { data: v, isLoading, error, refetch } = useQuery({ queryKey: ['venta', id], queryFn: () => api.get(`/ventas/${id}`) });
  const { data: cred } = useQuery({ queryKey: ['creditos', v?.cliente_id], queryFn: () => api.get<any>(`/creditos?cliente_id=${v.cliente_id}`), enabled: !!v && v.estado === 'emitida' && v.saldo > 0 && puede('cobros.registrar') });
  const [deshacer, setDeshacer] = useState<any>(null);
  const des = useMutation({
    mutationFn: () => api.post(`/credito-aplicaciones/${deshacer.id}/anular`, { motivo }),
    onSuccess: () => { invalidarDinero(qc); toast.ok('Aplicación deshecha'); setDeshacer(null); setMotivo(''); },
    onError: toast.error,
  });
  const m = useMutation({
    mutationFn: () => api.post(`/ventas/${id}/anular`, { motivo }),
    onSuccess: () => {
      invalidarDinero(qc);
      qc.invalidateQueries({ queryKey: ['articulos'] });
      toast.ok('Comprobante anulado');
      setAnular(false);
    },
    onError: toast.error,
  });
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  return (
    <>
      <Encabezado
        volver="/ventas"
        titulo={<span className="flex flex-wrap items-center gap-3">Comprobante interno #{numero(v.numero)} <EstadoCobroBadge total={v.total} cobrado={v.cobrado} devuelto={v.devuelto} estado={v.estado} /></span>}
        subtitulo={`${v.cliente} · ${fecha(v.fecha)} · ${v.condicion === 'cuenta_corriente' ? 'Cuenta corriente' : 'Contado'}`}
        acciones={
          <>
            <Boton icono={<Printer className="size-4" />} onClick={() => window.open(`/imprimir/venta/${v.id}`, '_blank')}>Imprimir</Boton>
            {v.estado === 'emitida' && v.saldo > 0 && puede('cobros.registrar') && <Boton variante="exito" icono={<Wallet className="size-4" />} onClick={() => setCobro(true)}>Cobrar {money(v.saldo)}</Boton>}
            {v.estado === 'emitida' && v.saldo > 0 && cred?.total > 0 && <Boton icono={<PiggyBank className="size-4" />} onClick={() => setAplicar(true)}>Aplicar saldo a favor {money(cred.total)}</Boton>}
            {v.estado === 'emitida' && puede('ventas.anular') && v.devuelto < v.total && <Boton icono={<Undo2 className="size-4" />} onClick={() => setDevolver(true)}>Registrar devolución</Boton>}
            {v.estado === 'emitida' && puede('ventas.anular') && <Boton icono={<Ban className="size-4" />} onClick={() => setAnular(true)}>Anular</Boton>}
          </>
        }
      />
      {v.estado === 'anulada' && <Aviso tono="rojo" className="mb-4">Comprobante anulado: {v.anulada_motivo}</Aviso>}
      <div className="grid gap-5 xl:grid-cols-3">
        <Tarjeta titulo="Detalle" className="xl:col-span-2">
          <EditorItems items={itemsDesdeApi(v.items)} onItems={() => undefined} params={v} onParams={() => undefined} soloLectura />
        </Tarjeta>
        <div className="space-y-5">
          <Tarjeta titulo="Datos">
            <dl className="grid grid-cols-2 gap-4">
              <Dato etiqueta="Cliente">{v.cliente}</Dato>
              <Dato etiqueta="Origen">{v.orden_id ? <Link className="text-marca-700" to={`/ordenes/${v.orden_id}`}>OT #{numero(v.orden_numero)}</Link> : 'Mostrador'}</Dato>
              <Dato etiqueta="Total">{money(v.total)}</Dato>
              <Dato etiqueta="Saldo">{money(v.saldo)}</Dato>
              {v.devuelto > 0 && <Dato etiqueta="Devuelto (notas de crédito)">{money(v.devuelto)}</Dato>}
              <Dato etiqueta="Tipo" className="col-span-2"><Insignia>Interno · no fiscal</Insignia></Dato>
              <Dato etiqueta="Observaciones" className="col-span-2">{v.observaciones}</Dato>
              {v.lista_precio_nombre && <Dato etiqueta="Lista de precios" className="col-span-2">{v.lista_precio_nombre}</Dato>}
            </dl>
          </Tarjeta>
          <Tarjeta titulo="Cobros aplicados" sinPadding>
            {v.cobros.length === 0 ? <p className="px-4 py-4 text-sm text-tenue">Sin cobros</p> : (
              <ul className="divide-y divide-borde text-sm">
                {v.cobros.map((c: any) => (
                  <li key={c.id} className="flex justify-between px-4 py-2.5">
                    <span><Link className="text-marca-700" to={`/cobros?ver=${c.id}`}>Cobro #{numero(c.numero)}</Link> · {fecha(c.fecha)} {c.estado === 'anulado' && <Insignia tono="gris">Anulado</Insignia>}</span>
                    <span className="tabular-nums">{money(c.importe)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Tarjeta>
          {v.devoluciones.length > 0 && (
            <Tarjeta titulo="Devoluciones" sinPadding>
              <ul className="divide-y divide-borde text-sm">
                {v.devoluciones.map((d: any) => (
                  <li key={d.id} className="flex justify-between px-4 py-2.5">
                    <span><Link className="text-marca-700" to={`/cobros?tab=devoluciones&ver=${d.id}`}>Nota de crédito interna #{numero(d.numero)}</Link> · {fecha(d.fecha)} {d.estado === 'anulada' && <Insignia tono="gris">Anulada</Insignia>}</span>
                    <span className="tabular-nums">{money(d.total)}</span>
                  </li>
                ))}
              </ul>
            </Tarjeta>
          )}
          {v.creditos.length > 0 && (
            <Tarjeta titulo="Saldo a favor aplicado" sinPadding>
              <ul className="divide-y divide-borde text-sm">
                {v.creditos.map((c: any) => (
                  <li key={c.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                    <span>{c.origen_tipo === 'anticipo' ? `Anticipo (recibo #${numero(c.origen_numero)})` : `Devolución #${numero(c.origen_numero)}`} · {fecha(c.fecha)} {c.estado === 'anulada' && <Insignia tono="gris">Deshecha</Insignia>}</span>
                    <span className="flex items-center gap-2"><span className="tabular-nums">{money(c.importe)}</span>{c.estado === 'vigente' && puede('cobros.anular') && <Boton tam="sm" variante="fantasma" onClick={() => setDeshacer(c)}>Deshacer</Boton>}</span>
                  </li>
                ))}
              </ul>
            </Tarjeta>
          )}
          <Tarjeta titulo="Facturación electrónica">
            <p className="text-sm text-tenue">{v.fiscal.mensaje}</p>
          </Tarjeta>
        </div>
      </div>
      {cobro && <ModalCobro abierto onCerrar={() => setCobro(false)} clienteId={v.cliente_id} ventaId={v.id} />}
      {devolver && <ModalDevolucion ventaId={v.id} onCerrar={() => setDevolver(false)} />}
      {aplicar && <ModalAplicarCreditos venta={{ id: v.id, cliente_id: v.cliente_id, numero: v.numero, saldo: v.saldo, orden_id: v.orden_id }} onCerrar={() => setAplicar(false)} />}
      <Modal abierto={!!deshacer} onCerrar={() => setDeshacer(null)} titulo="Deshacer aplicación de saldo a favor" ancho="sm" pie={<><Boton onClick={() => setDeshacer(null)}>Cancelar</Boton><Boton variante="peligro" disabled={motivo.trim().length < 3} cargando={des.isPending} onClick={() => des.mutate()}>Deshacer</Boton></>}>
        <div className="space-y-3">
          <p className="text-sm text-tenue">El comprobante recupera su deuda y el saldo a favor vuelve a quedar disponible. No se mueve dinero.</p>
          <Campo label="Motivo" requerido><Input value={motivo} onChange={(e) => setMotivo(e.target.value)} autoFocus /></Campo>
        </div>
      </Modal>
      <Modal abierto={anular} onCerrar={() => setAnular(false)} titulo="Anular comprobante" ancho="sm" pie={<><Boton onClick={() => setAnular(false)}>Cancelar</Boton><Boton variante="peligro" disabled={motivo.trim().length < 3} cargando={m.isPending} onClick={() => m.mutate()}>Anular</Boton></>}>
        <div className="space-y-3">
          <p className="text-sm text-tenue">{v.orden_id ? 'La OT quedará sin comprobante y podrá reabrirse.' : 'Los artículos vendidos volverán al stock.'} Si tiene cobros, primero hay que anularlos.</p>
          <Campo label="Motivo" requerido><Input value={motivo} onChange={(e) => setMotivo(e.target.value)} autoFocus /></Campo>
        </div>
      </Modal>
    </>
  );
}

export function VentaMostrador() {
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const bloqueada = useCajaBloqueada();
  const [cliente, setCliente] = useState<ClienteMin | null>(null);
  const [items, setItems] = useState<ItemUI[]>([]);
  const [params, setParams] = useState<ParamsUI>(paramsVacios());
  const [lista, setLista] = useState<string | null>(null);
  useListaPorDefecto(true, lista, setLista);
  useDefectosEnParams(true, setParams);
  const [condicion, setCondicion] = useState<'contado' | 'cuenta_corriente'>('contado');
  const [obs, setObs] = useState('');
  const [medio, setMedio] = useState<MedioPago>('efectivo');
  const [ref, setRef] = useState('');
  const [extra, setExtra] = useState<ExtraMedio>(extraVacio());
  const [clave] = useState(nuevaClave());
  const [deposito, setDeposito] = useState('');
  const total = calcularTotales(items, params).total;
  const chequeSinNumero = condicion === 'contado' && !!errorMedio(medio, ref, extra, 'cobro');
  // "Contado" se cobra en el acto; sin cliente identificado sólo se puede vender de contado.
  const cuentaCorrienteSinCliente = condicion === 'cuenta_corriente' && !cliente;
  const m = useMutation({
    mutationFn: () =>
      api.post('/ventas', {
        cliente_id: cliente?.id ?? null, condicion, observaciones: obs, items: itemsParaApi(items), idem_key: clave, lista_precio_id: lista, deposito_id: deposito || null, ...params,
        cobro: condicion === 'contado' ? { medio, referencia: ref.trim() || null, ...extraAPayload(medio, extra, 'cobro') } : null,
      }),
    onSuccess: (v) => {
      invalidarDinero(qc);
      qc.invalidateQueries({ queryKey: ['articulos'] });
      toast.ok(`Comprobante #${numero(v.numero)} emitido${v.cobrado ? ' y cobrado' : ''}`);
      nav(`/ventas/${v.id}`, { replace: true });
    },
    onError: toast.error,
  });
  return (
    <>
      <Encabezado titulo="Venta de mostrador" subtitulo="Venta directa de repuestos o servicios sin orden de trabajo" volver="/ventas" />
      <div className="grid gap-5 xl:grid-cols-3">
        <Tarjeta titulo="Ítems" className="xl:col-span-2">
          <div className="mb-4"><SelectorLista valor={lista} onCambio={setLista} items={items} onItems={setItems} /></div>
          <SelectorDeposito valor={deposito} onCambio={setDeposito} label="Depósito de salida" className="mb-4 max-w-sm" />
          <EditorItems items={items} onItems={setItems} params={params} onParams={setParams} listaId={lista} />
        </Tarjeta>
        <div className="space-y-5">
          <Tarjeta titulo="Cliente y cobro">
            <div className="space-y-3">
              <SelectorCliente valor={cliente} onCambio={(c) => { setCliente(c); if (!c && condicion === 'cuenta_corriente') setCondicion('contado'); }} />
              {!cliente && <p className="text-xs text-tenue">Sin cliente se registra como “Consumidor final” (sólo contado).</p>}
              <Campo label="Condición de venta">
                <Select value={condicion} onChange={(e) => setCondicion(e.target.value as 'contado' | 'cuenta_corriente')}>
                  <option value="contado">Contado (se cobra ahora)</option>
                  <option value="cuenta_corriente" disabled={!cliente}>Cuenta corriente (queda como deuda del cliente)</option>
                </Select>
              </Campo>
              {condicion === 'contado' && (
                <div className="space-y-2 rounded-lg bg-slate-50 p-3">
                  <Campo label="Medio de pago">
                    <SelectorMedio value={medio} onChange={setMedio} />
                  </Campo>
                  <Campo label={medio === 'cheque' ? 'N° de cheque' : 'Referencia (opcional)'} requerido={medio === 'cheque'}>
                    <Input value={ref} onChange={(e) => setRef(e.target.value)} />
                  </Campo>
                  <CamposMedio medio={medio} valor={extra} onChange={setExtra} ctx="cobro" importe={total} />
                </div>
              )}
              <Campo label="Observaciones"><Textarea rows={2} value={obs} onChange={(e) => setObs(e.target.value)} /></Campo>
            </div>
          </Tarjeta>
          <AvisoCaja />
          <Boton variante="primario" tam="lg" className="w-full" icono={<ShoppingBag className="size-5" />} disabled={!items.length || chequeSinNumero || cuentaCorrienteSinCliente || (condicion === 'contado' && bloqueada)} cargando={m.isPending} onClick={() => m.mutate()}>
            {condicion === 'contado' ? `Emitir y cobrar ${money(total)}` : 'Emitir a cuenta corriente'}
          </Boton>
          <p className="text-xs text-tenue">Comprobante interno (no fiscal).</p>
        </div>
      </div>
    </>
  );
}
