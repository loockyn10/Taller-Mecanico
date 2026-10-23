import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Ban, Download, Eye, Printer, Wallet } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { invalidarDinero } from '@/lib/caja';
import { descargarCSV, pesosCSV } from '@/lib/csv';
import { fecha, hoyISO, money, numero, sumarDias } from '@/lib/format';
import { Aviso, Boton, Buscador, Campo, Cargando, Dato, Encabezado, ErrorCaja, Input, Insignia, Modal, Pestanas, Select, Tabla, Tarjeta, useDebounce, useToast, Vacio } from '@/components/ui';
import { AnticiposTab, DevolucionesTab } from './AnticiposDevoluciones';
import { MEDIOS_PAGO, MEDIO_PAGO_LABEL, type MedioPago } from '@shared/dominio';

function DetalleCobro({ id, onCerrar, onAnular }: { id: string; onCerrar: () => void; onAnular: (c: any) => void }) {
  const { puede } = useAuth();
  const { data: c, isLoading, error } = useQuery({ queryKey: ['cobro', id], queryFn: () => api.get(`/cobros/${id}`) });
  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo={c ? `${c.tipo === 'anticipo' ? 'Recibo de anticipo' : 'Recibo'} N° ${numero(c.numero)}` : 'Cobro'}
      ancho="lg"
      pie={c && (
        <>
          {c.estado === 'registrado' && puede('cobros.anular') && <Boton variante="peligro" icono={<Ban className="size-4" />} onClick={() => onAnular(c)}>Anular cobro</Boton>}
          <Boton variante="primario" icono={<Printer className="size-4" />} onClick={() => window.open(`/imprimir/recibo/${c.id}`, '_blank')}>Imprimir recibo</Boton>
        </>
      )}
    >
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} /> : (
        <div className="space-y-5">
          {c.estado === 'anulado' && <Aviso tono="rojo">Cobro anulado: {c.anulado_motivo}</Aviso>}
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Dato etiqueta="Cliente"><Link className="text-marca-700" to={`/cuentas/${c.cliente_id}`} onClick={onCerrar}>{c.cliente}</Link></Dato>
            <Dato etiqueta="Fecha">{fecha(c.fecha)}</Dato>
            <Dato etiqueta="Importe">{money(c.total)}</Dato>
            <Dato etiqueta="Registró">{c.usuario}</Dato>
          </dl>
          <div>
            <h3 className="mb-2 text-sm font-semibold">Formas de pago</h3>
            <ul className="divide-y divide-borde rounded-ctl border border-borde text-sm">
              {c.medios.map((m: any, i: number) => <li key={i} className="flex justify-between px-3 py-2"><span>{MEDIO_PAGO_LABEL[m.medio as MedioPago]}{m.referencia ? ` · ${m.referencia}` : ''}</span><span className="tabular-nums">{money(m.importe)}</span></li>)}
            </ul>
          </div>
          {c.tipo === 'anticipo' && <Aviso>Anticipo: dinero recibido antes de la venta (no es una venta). Aplicado {money(c.credito_aplicado)} · devuelto {money(c.devuelto)} · disponible {money(c.estado === 'registrado' ? c.total - c.credito_aplicado - c.devuelto : 0)}. El detalle de aplicaciones está en la pestaña Anticipos.</Aviso>}
          {c.tipo !== 'anticipo' && <div>
            <h3 className="mb-2 text-sm font-semibold">Comprobantes cancelados</h3>
            <ul className="divide-y divide-borde rounded-ctl border border-borde text-sm">
              {c.aplicaciones.map((a: any) => (
                <li key={a.venta_id} className="flex flex-wrap justify-between gap-2 px-3 py-2">
                  <span><Link className="text-marca-700" to={`/ventas/${a.venta_id}`} onClick={onCerrar}>Comprobante #{numero(a.numero)}</Link>{a.orden_numero ? ` · OT #${numero(a.orden_numero)}` : ''} · total {money(a.total)}</span>
                  <span className="tabular-nums">{money(a.importe)}</span>
                </li>
              ))}
            </ul>
          </div>}
          {c.notas && <p className="text-sm"><span className="font-medium">Notas:</span> {c.notas}</p>}
        </div>
      )}
    </Modal>
  );
}

export function Cobros() {
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useAuth();
  const [sp, setSp] = useSearchParams();
  const [desde, setDesde] = useState(sumarDias(hoyISO(), -30));
  const [hasta, setHasta] = useState(hoyISO());
  const [estado, setEstado] = useState('');
  const [medio, setMedio] = useState('');
  const [q, setQ] = useState('');
  const [anular, setAnular] = useState<any | null>(null);
  const [motivo, setMotivo] = useState('');
  const dq = useDebounce(q);
  const ver = sp.get('ver');
  const tab = (sp.get('tab') as 'cobros' | 'anticipos' | 'devoluciones' | null) ?? 'cobros';
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['cobros', { desde, hasta, estado, medio, dq }], queryFn: () => api.get<any[]>(`/cobros${qs({ desde, hasta, estado, medio, q: dq })}`) });
  const m = useMutation({
    mutationFn: () => api.post(`/cobros/${anular.id}/anular`, { motivo }),
    onSuccess: () => {
      invalidarDinero(qc);
      toast.ok('Cobro anulado');
      setAnular(null);
      setMotivo('');
    },
    onError: toast.error,
  });
  const vigentes = data.filter((c) => c.estado === 'registrado');
  const porMedio = new Map<string, number>();
  vigentes.forEach((c) => c.medios.forEach((x: any) => porMedio.set(x.medio, (porMedio.get(x.medio) ?? 0) + x.importe)));

  return (
    <>
      <Encabezado
        titulo="Cobranzas"
        subtitulo="Recibos, anticipos de clientes y devoluciones. Para cobrar, abrí la OT, el comprobante o la cuenta del cliente."
        acciones={tab === 'cobros' && data.length > 0 && (
          <Boton icono={<Download className="size-4" />} onClick={() => descargarCSV(`cobros-${desde}_${hasta}`, ['Recibo', 'Fecha', 'Cliente', 'Medios', 'Importe', 'Estado'], data.map((c) => [c.numero, c.fecha, c.cliente, c.medios.map((x: any) => MEDIO_PAGO_LABEL[x.medio as MedioPago]).join(' + '), pesosCSV(c.total), c.estado]))}>CSV</Boton>
        )}
      />
      <Pestanas items={[{ clave: 'cobros', titulo: 'Cobros' }, { clave: 'anticipos', titulo: 'Anticipos' }, { clave: 'devoluciones', titulo: 'Devoluciones' }]} activo={tab} onCambio={(k) => setSp(k === 'cobros' ? {} : { tab: k })} />
      {tab === 'anticipos' && <AnticiposTab />}
      {tab === 'devoluciones' && <DevolucionesTab abrirId={ver} />}
      {tab === 'cobros' && <>
      <div className="filtros mb-4 flex flex-wrap items-end gap-3">
        <Campo label="Desde"><Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} /></Campo>
        <Campo label="Hasta"><Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} /></Campo>
        <Campo label="Estado"><Select value={estado} onChange={(e) => setEstado(e.target.value)} className="w-auto"><option value="">Todos</option><option value="registrado">Vigentes</option><option value="anulado">Anulados</option></Select></Campo>
        <Campo label="Medio"><Select value={medio} onChange={(e) => setMedio(e.target.value)} className="w-auto"><option value="">Todos</option>{MEDIOS_PAGO.map((x) => <option key={x} value={x}>{MEDIO_PAGO_LABEL[x]}</option>)}</Select></Campo>
        <Buscador value={q} onChange={setQ} placeholder="Cliente o N° de recibo" className="min-w-48 flex-1" />
      </div>
      <div className="filtros mb-4 flex flex-wrap gap-2">
        <Insignia tono="verde" className="px-3 py-1 text-sm">Total vigente: {money(vigentes.reduce((a, c) => a + c.total, 0))}</Insignia>
        {[...porMedio.entries()].map(([medio, t]) => <Insignia key={medio} className="px-3 py-1 text-sm">{MEDIO_PAGO_LABEL[medio as MedioPago]}: {money(t)}</Insignia>)}
      </div>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={data}
            clave={(c) => c.id}
            onFila={(c) => setSp({ ver: c.id })}
            vacio={<Vacio icono={<Wallet className="size-5" />} titulo="Sin cobros con esos filtros" />}
            columnas={[
              { clave: 'n', titulo: 'Recibo', render: (c) => <span className="font-medium">#{numero(c.numero)}</span>, movil: 'meta' },
              { clave: 'f', titulo: 'Fecha', render: (c) => fecha(c.fecha), movil: 'meta' },
              { clave: 'c', titulo: 'Cliente', render: (c) => c.cliente, movil: 'titulo' },
              { clave: 'm', titulo: 'Medios', render: (c) => c.medios.map((x: any) => `${MEDIO_PAGO_LABEL[x.medio as MedioPago]}${x.referencia ? ` (${x.referencia})` : ''}`).join(', '), movil: 'subtitulo' },
              { clave: 'u', titulo: 'Registró', render: (c) => c.usuario ?? '—', movil: 'oculta' },
              { clave: 'e', titulo: 'Estado', render: (c) => (c.estado === 'anulado' ? <Insignia tono="gris">Anulado</Insignia> : c.tipo === 'anticipo' ? <Insignia tono="violeta">Anticipo</Insignia> : <Insignia tono="verde">Vigente</Insignia>), movil: 'meta' },
              { clave: 't', titulo: 'Importe', alinear: 'derecha', render: (c) => <span className={c.estado === 'anulado' ? 'text-tenue line-through' : ''}>{money(c.total)}</span>, movil: 'derecha' },
              {
                clave: 'a',
                titulo: '',
                render: (c) => (
                  <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                    <Boton tam="sm" variante="fantasma" icono={<Eye className="size-4" />} onClick={() => setSp({ ver: c.id })} aria-label="Ver detalle" />
                    <Boton tam="sm" variante="fantasma" icono={<Printer className="size-4" />} onClick={() => window.open(`/imprimir/recibo/${c.id}`, '_blank')} aria-label="Imprimir recibo" />
                    {c.estado === 'registrado' && puede('cobros.anular') ? <Boton tam="sm" variante="fantasma" icono={<Ban className="size-4" />} onClick={() => setAnular(c)} aria-label="Anular cobro" /> : null}
                  </div>
                ),
                movil: 'meta',
              },
            ]}
          />
        </Tarjeta>
      )}
      </>}
      {ver && tab === 'cobros' && <DetalleCobro id={ver} onCerrar={() => setSp({})} onAnular={(c) => { setSp({}); setAnular(c); }} />}
      <Modal abierto={!!anular} onCerrar={() => setAnular(null)} titulo={`Anular cobro #${anular ? numero(anular.numero) : ''}`} ancho="sm" pie={<><Boton onClick={() => setAnular(null)}>Cancelar</Boton><Boton variante="peligro" disabled={motivo.trim().length < 3} cargando={m.isPending} onClick={() => m.mutate()}>Anular cobro</Boton></>}>
        <div className="space-y-3">
          <p className="text-sm text-tenue">El importe volverá a figurar como saldo pendiente de los comprobantes y se registrará la salida en la caja abierta.</p>
          <Campo label="Motivo" requerido><Input value={motivo} onChange={(e) => setMotivo(e.target.value)} autoFocus /></Campo>
        </div>
      </Modal>
    </>
  );
}
