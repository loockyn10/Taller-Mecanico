// Cartera de cheques y eCheq: registro y control administrativo (sin conexión con plataformas bancarias).
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Ban, Download, Plus } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { invalidarDinero } from '@/lib/caja';
import { descargarCSV, pesosCSV } from '@/lib/csv';
import { fecha, hoyISO, money, sumarDias } from '@/lib/format';
import { Aviso, Boton, Buscador, Campo, Cargando, Check, Encabezado, ErrorCaja, Indicador, Input, InputMoneda, Insignia, Modal, Pestanas, Select, Tabla, Tarjeta, Textarea, useDebounce, useToast, Vacio, type Tono } from '@/components/ui';
import { ESTADO_CHEQUE_LABEL, ESTADOS_CHEQUE, type EstadoCheque } from '@shared/dominio';

const TONO: Record<EstadoCheque, Tono> = { en_cartera: 'azul', depositado: 'cian', entregado: 'violeta', acreditado: 'verde', rechazado: 'rojo', anulado: 'gris' };
export const EstadoChequeInsignia = ({ estado }: { estado: string }) => <Insignia tono={TONO[estado as EstadoCheque] ?? 'gris'}>{ESTADO_CHEQUE_LABEL[estado as EstadoCheque] ?? estado}</Insignia>;

type Accion = 'depositar' | 'acreditar' | 'rechazar' | 'entregar' | 'anular' | 'volver-a-cartera';

function ModalAccion({ cheque, accion, cuentas, onCerrar }: { cheque: any; accion: Accion; cuentas: any[]; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const activas = cuentas.filter((c) => c.activa && c.moneda === 'ARS');
  const { data: provs = [] } = useQuery({ queryKey: ['proveedores'], queryFn: () => api.get<any[]>('/proveedores'), enabled: accion === 'entregar' });
  const [f, setF] = useState({ cuenta_id: cheque.cuenta_id ?? activas[0]?.id ?? '', fecha: hoyISO(), motivo: '', comision: 0, proveedor_id: '', beneficiario: '', vencido: false });
  const vencido = cheque.direccion === 'recibido' && cheque.estado === 'en_cartera' && cheque.fecha_vencimiento < hoyISO();
  const m = useMutation({
    mutationFn: () => {
      const base = `/cheques/${cheque.id}/${accion}`;
      if (accion === 'depositar') return api.post(base, { cuenta_id: f.cuenta_id, fecha: f.fecha, confirmar_vencido: f.vencido });
      if (accion === 'acreditar') return api.post(base, { fecha: f.fecha, cuenta_id: cheque.cuenta_id ? undefined : f.cuenta_id || undefined });
      if (accion === 'rechazar') return api.post(base, { motivo: f.motivo, fecha: f.fecha, comision: f.comision });
      if (accion === 'entregar') return api.post(base, { proveedor_id: f.proveedor_id || null, beneficiario: f.beneficiario || null, fecha: f.fecha });
      if (accion === 'anular') return api.post(base, { motivo: f.motivo });
      return api.post(base, {});
    },
    onSuccess: (r: any) => {
      invalidarDinero(qc);
      toast.ok(r?.aviso ? `Cheque rechazado. ${r.aviso}` : 'Listo');
      onCerrar();
    },
    onError: toast.error,
  });
  const titulos: Record<Accion, string> = { depositar: 'Depositar cheque', acreditar: cheque.direccion === 'recibido' ? 'Registrar acreditación' : 'Registrar débito del cheque', rechazar: 'Registrar rechazo', entregar: 'Entregar cheque', anular: 'Anular cheque', 'volver-a-cartera': 'Volver a cartera' };
  const valido = accion === 'depositar' ? !!f.cuenta_id && (!vencido || f.vencido) : accion === 'acreditar' ? !!(cheque.cuenta_id || f.cuenta_id) : accion === 'rechazar' || accion === 'anular' ? f.motivo.trim().length >= 3 : true;
  return (
    <Modal abierto onCerrar={onCerrar} titulo={`${titulos[accion]} · N° ${cheque.nro_cheque}`} ancho="sm" pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante={accion === 'rechazar' || accion === 'anular' ? 'peligro' : 'primario'} disabled={!valido} cargando={m.isPending} onClick={() => m.mutate()}>Confirmar</Boton></>}>
      <div className="space-y-3">
        <p className="text-sm text-tenue">{cheque.banco} · {money(cheque.importe)} · cobra el {fecha(cheque.fecha_pago)}</p>
        {accion === 'depositar' && (
          <>
            <Aviso>Al depositarlo, el cheque queda “depositado” hasta que lo registres como acreditado. El dinero ya se contó al cobrarlo: no se suma de nuevo a los ingresos.</Aviso>
            <Campo label="Cuenta de depósito" requerido><Select value={f.cuenta_id} onChange={(e) => setF({ ...f, cuenta_id: e.target.value })}>{activas.map((c) => <option key={c.id} value={c.id}>{c.nombre} · {c.banco}</option>)}</Select></Campo>
            {vencido && <Aviso tono="rojo"><Check checked={f.vencido} onChange={(v) => setF({ ...f, vencido: v })} label={`Venció el ${fecha(cheque.fecha_vencimiento)}: depositarlo de todas formas`} /></Aviso>}
          </>
        )}
        {accion === 'acreditar' && (
          <>
            <Aviso>{cheque.direccion === 'recibido' ? 'El importe entra al saldo de la cuenta. No es un ingreso nuevo del negocio.' : 'El importe se debita del saldo de la cuenta. El pago ya se había contado al entregar el cheque.'}</Aviso>
            {!cheque.cuenta_id && <Campo label="Cuenta" requerido><Select value={f.cuenta_id} onChange={(e) => setF({ ...f, cuenta_id: e.target.value })}><option value="">— Elegir —</option>{activas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</Select></Campo>}
          </>
        )}
        {accion === 'rechazar' && (
          <>
            <Aviso tono="ambar">{cheque.estado === 'acreditado' ? 'El ingreso bancario se revierte con un contra-asiento. ' : ''}{cheque.origen_tipo === 'cobro_medio' ? 'Después anulá el cobro para que la deuda del cliente vuelva a figurar.' : ''}</Aviso>
            <Campo label="Motivo del rechazo" requerido><Input value={f.motivo} onChange={(e) => setF({ ...f, motivo: e.target.value })} placeholder="Sin fondos, firma no coincide…" autoFocus /></Campo>
            {cheque.cuenta_id && <Campo label="Comisión del banco (opcional)" hint="Se carga como egreso bancario"><InputMoneda value={f.comision} onChange={(v) => setF({ ...f, comision: v })} /></Campo>}
          </>
        )}
        {accion === 'entregar' && (
          <>
            <Campo label="Proveedor"><Select value={f.proveedor_id} onChange={(e) => setF({ ...f, proveedor_id: e.target.value })}><option value="">—</option>{provs.filter((p: any) => p.activo).map((p: any) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</Select></Campo>
            <Campo label="Beneficiario (si no es un proveedor)"><Input value={f.beneficiario} onChange={(e) => setF({ ...f, beneficiario: e.target.value })} /></Campo>
          </>
        )}
        {accion === 'anular' && <Campo label="Motivo" requerido><Input value={f.motivo} onChange={(e) => setF({ ...f, motivo: e.target.value })} autoFocus /></Campo>}
        {accion === 'volver-a-cartera' && <p className="text-sm">El cheque deja de figurar como depositado y vuelve a la cartera.</p>}
        {['depositar', 'acreditar', 'rechazar', 'entregar'].includes(accion) && <Campo label="Fecha"><Input type="date" value={f.fecha} max={hoyISO()} onChange={(e) => setF({ ...f, fecha: e.target.value })} /></Campo>}
      </div>
    </Modal>
  );
}

function FormCheque({ cuentas, onCerrar }: { cuentas: any[]; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: clientes = [] } = useQuery({ queryKey: ['clientes', 'lista'], queryFn: () => api.get<any[]>('/clientes?limite=500') });
  const { data: provs = [] } = useQuery({ queryKey: ['proveedores'], queryFn: () => api.get<any[]>('/proveedores') });
  const [f, setF] = useState({ direccion: 'recibido', modalidad: 'fisico', echeq_id: '', banco: '', nro_cheque: '', importe: 0, fecha_emision: hoyISO(), fecha_pago: hoyISO(), librador: '', cuit: '', beneficiario: '', cliente_id: '', proveedor_id: '', cuenta_id: '', entregado: false, observaciones: '' });
  const emitido = f.direccion === 'emitido';
  const m = useMutation({
    mutationFn: () => api.post('/cheques', { ...f, echeq_id: f.echeq_id || null, librador: f.librador || null, cuit: f.cuit || null, beneficiario: f.beneficiario || null, cliente_id: f.cliente_id || null, proveedor_id: f.proveedor_id || null, cuenta_id: f.cuenta_id || null, observaciones: f.observaciones || null }),
    onSuccess: () => {
      invalidarDinero(qc);
      toast.ok('Cheque registrado');
      onCerrar();
    },
    onError: toast.error,
  });
  const valido = f.nro_cheque.trim() && f.importe > 0 && (emitido ? !!f.cuenta_id : f.banco.trim().length >= 2) && (f.modalidad !== 'echeq' || f.echeq_id.trim()) && f.fecha_pago >= f.fecha_emision;
  return (
    <Modal abierto onCerrar={onCerrar} titulo="Registrar cheque" ancho="lg" pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" disabled={!valido} cargando={m.isPending} onClick={() => m.mutate()}>Registrar</Boton></>}>
      <div className="space-y-3">
        <Aviso>Los cheques que recibís al cobrar y los que entregás al pagar se registran solos desde esas operaciones. Usá este formulario para cheques que no pasaron por ORVELAN.</Aviso>
        <div className="grid gap-3 sm:grid-cols-3">
          <Campo label="Dirección"><Select value={f.direccion} onChange={(e) => setF({ ...f, direccion: e.target.value })}><option value="recibido">Recibido</option><option value="emitido">Emitido (propio)</option></Select></Campo>
          <Campo label="Modalidad"><Select value={f.modalidad} onChange={(e) => setF({ ...f, modalidad: e.target.value })}><option value="fisico">Cheque físico</option><option value="echeq">eCheq</option></Select></Campo>
          {f.modalidad === 'echeq' && <Campo label="ID del eCheq" requerido><Input value={f.echeq_id} onChange={(e) => setF({ ...f, echeq_id: e.target.value })} /></Campo>}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {emitido ? (
            <Campo label="Cuenta librada" requerido><Select value={f.cuenta_id} onChange={(e) => setF({ ...f, cuenta_id: e.target.value })}><option value="">— Elegir —</option>{cuentas.filter((c) => c.activa).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</Select></Campo>
          ) : (
            <Campo label="Banco" requerido><Input value={f.banco} onChange={(e) => setF({ ...f, banco: e.target.value })} /></Campo>
          )}
          <Campo label="N° de cheque" requerido><Input value={f.nro_cheque} onChange={(e) => setF({ ...f, nro_cheque: e.target.value })} /></Campo>
          <Campo label="Importe" requerido><InputMoneda value={f.importe} onChange={(v) => setF({ ...f, importe: v })} /></Campo>
          <Campo label="Fecha de emisión"><Input type="date" value={f.fecha_emision} onChange={(e) => setF({ ...f, fecha_emision: e.target.value })} /></Campo>
          <Campo label="Fecha de pago" hint={`Vence para depositar el ${fecha(sumarDias(f.fecha_pago, 30))}`}><Input type="date" value={f.fecha_pago} onChange={(e) => setF({ ...f, fecha_pago: e.target.value })} /></Campo>
          <Campo label={emitido ? 'Titular (vos)' : 'Titular / librador'}><Input value={f.librador} onChange={(e) => setF({ ...f, librador: e.target.value })} /></Campo>
          <Campo label="CUIT del titular"><Input value={f.cuit} onChange={(e) => setF({ ...f, cuit: e.target.value })} placeholder="20-12345678-6" /></Campo>
          {emitido ? (
            <>
              <Campo label="Proveedor"><Select value={f.proveedor_id} onChange={(e) => setF({ ...f, proveedor_id: e.target.value })}><option value="">—</option>{provs.filter((p: any) => p.activo).map((p: any) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</Select></Campo>
              <Campo label="Beneficiario"><Input value={f.beneficiario} onChange={(e) => setF({ ...f, beneficiario: e.target.value })} /></Campo>
            </>
          ) : (
            <Campo label="Cliente que lo entregó"><Select value={f.cliente_id} onChange={(e) => setF({ ...f, cliente_id: e.target.value })}><option value="">—</option>{clientes.map((c: any) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</Select></Campo>
          )}
        </div>
        {emitido && <Check checked={f.entregado} onChange={(v) => setF({ ...f, entregado: v })} label="Ya fue entregado al beneficiario" />}
        <Campo label="Observaciones"><Textarea rows={2} value={f.observaciones} onChange={(e) => setF({ ...f, observaciones: e.target.value })} /></Campo>
      </div>
    </Modal>
  );
}

function Detalle({ id, onCerrar }: { id: string; onCerrar: () => void }) {
  const { data: c } = useQuery({ queryKey: ['cheques', 'detalle', id], queryFn: () => api.get(`/cheques/${id}`) });
  return (
    <Modal abierto onCerrar={onCerrar} titulo={c ? `Cheque N° ${c.nro_cheque} · ${c.banco}` : 'Cheque'} ancho="lg">
      {!c ? <Cargando /> : (
        <div className="space-y-4 text-sm">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div><dt className="text-xs text-tenue">Estado</dt><dd><EstadoChequeInsignia estado={c.estado} /></dd></div>
            <div><dt className="text-xs text-tenue">Importe</dt><dd className="font-semibold">{money(c.importe)}</dd></div>
            <div><dt className="text-xs text-tenue">Tipo</dt><dd>{c.direccion === 'recibido' ? 'Recibido' : 'Emitido'} · {c.modalidad === 'echeq' ? `eCheq ${c.echeq_id ?? ''}` : 'Físico'}</dd></div>
            <div><dt className="text-xs text-tenue">Emisión</dt><dd>{fecha(c.fecha_emision)}</dd></div>
            <div><dt className="text-xs text-tenue">Fecha de pago</dt><dd>{fecha(c.fecha_pago)}</dd></div>
            <div><dt className="text-xs text-tenue">Vence</dt><dd>{fecha(c.fecha_vencimiento)}</dd></div>
            <div><dt className="text-xs text-tenue">Titular</dt><dd>{c.librador ?? '—'}{c.cuit ? ` · ${c.cuit}` : ''}</dd></div>
            <div><dt className="text-xs text-tenue">{c.direccion === 'recibido' ? 'Cliente' : 'Proveedor'}</dt><dd>{(c.direccion === 'recibido' ? c.cliente : c.proveedor) ?? c.beneficiario ?? '—'}</dd></div>
            <div><dt className="text-xs text-tenue">Cuenta</dt><dd>{c.cuenta ?? '—'}</dd></div>
          </dl>
          {c.origen_tipo === 'cobro_medio' && c.origen_ref && <p>Origen: <Link className="text-marca-700" to={`/cobros?ver=${c.origen_ref}`}>cobro registrado</Link></p>}
          {c.origen_tipo === 'pago_proveedor' && c.origen_ref && <p>Origen: pago a proveedor</p>}
          {c.motivo_rechazo && <Aviso tono="rojo">Rechazado: {c.motivo_rechazo}</Aviso>}
          {c.observaciones && <p><span className="font-medium">Observaciones:</span> {c.observaciones}</p>}
          <div>
            <h3 className="mb-1 text-sm font-semibold">Historial</h3>
            <ul className="divide-y divide-borde rounded-ctl border border-borde">
              {c.eventos.map((e: any) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span>{e.estado_desde ? <>{ESTADO_CHEQUE_LABEL[e.estado_desde as EstadoCheque]} → </> : null}<strong>{ESTADO_CHEQUE_LABEL[e.estado_hacia as EstadoCheque]}</strong>{e.detalle ? <span className="text-tenue"> · {e.detalle}</span> : null}</span>
                  <span className="text-xs text-tenue">{fecha(e.fecha)}{e.usuario ? ` · ${e.usuario}` : ''}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function Cheques() {
  const [tab, setTab] = useState<'recibido' | 'emitido'>('recibido');
  const [estado, setEstado] = useState('');
  const [modalidad, setModalidad] = useState('');
  const [q, setQ] = useState('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [filtro, setFiltro] = useState<'' | 'proximos' | 'vencidos' | 'pendientes'>('');
  const dq = useDebounce(q);
  const [nuevo, setNuevo] = useState(false);
  const [accion, setAccion] = useState<{ cheque: any; accion: Accion } | null>(null);
  const [ver, setVer] = useState<string | null>(null);
  const { data: resumen } = useQuery({ queryKey: ['cheques', 'resumen'], queryFn: () => api.get('/cheques/resumen') });
  const { data: cuentas = [] } = useQuery({ queryKey: ['bancos', 'cuentas'], queryFn: () => api.get<any[]>('/bancos/cuentas?todas=1') });
  const params = qs({ direccion: tab, estado, modalidad, q: dq, desde, hasta, vence_en: filtro === 'proximos' ? resumen?.dias_alerta ?? 7 : undefined, vencidos: filtro === 'vencidos' ? 1 : undefined, pendientes: filtro === 'pendientes' ? 1 : undefined });
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['cheques', 'lista', params], queryFn: () => api.get<any[]>(`/cheques${params}`) });
  const por = (dir: string, est: string) => resumen?.por_estado?.find((x: any) => x.direccion === dir && x.estado === est) ?? { cantidad: 0, total: 0 };
  const totalesVista = ESTADOS_CHEQUE.map((e) => ({ e, ...data.filter((c: any) => c.estado === e).reduce((a: { n: number; t: number }, c: any) => ({ n: a.n + 1, t: a.t + c.importe }), { n: 0, t: 0 }) })).filter((x) => x.n);
  const exportar = () => descargarCSV(`cheques-${tab}`, ['N° interno', 'Banco', 'N° cheque', 'Tipo', 'Titular', 'CUIT', 'Importe', 'Emisión', 'Pago', 'Vence', 'Estado', 'Cliente/Proveedor'], data.map((c) => [c.numero, c.banco, c.nro_cheque, c.modalidad === 'echeq' ? 'eCheq' : 'Físico', c.librador ?? '', c.cuit ?? '', pesosCSV(c.importe), c.fecha_emision, c.fecha_pago, c.fecha_vencimiento, ESTADO_CHEQUE_LABEL[c.estado as EstadoCheque], c.cliente ?? c.proveedor ?? '']));
  const botones = (c: any) => {
    const b: Array<[Accion, string]> = [];
    if (c.direccion === 'recibido') {
      if (c.estado === 'en_cartera') b.push(['depositar', 'Depositar']);
      if (c.estado === 'depositado') b.push(['acreditar', 'Acreditar'], ['volver-a-cartera', 'Volver a cartera']);
      if (['depositado', 'acreditado', 'entregado'].includes(c.estado)) b.push(['rechazar', 'Rechazar']);
    } else {
      if (c.estado === 'en_cartera') b.push(['entregar', 'Entregar']);
      if (c.estado === 'entregado') b.push(['acreditar', 'Debitado'], ['rechazar', 'Rechazado']);
    }
    if (c.origen_tipo === 'manual' && ['en_cartera', 'entregado'].includes(c.estado)) b.push(['anular', 'Anular']);
    return b;
  };
  return (
    <>
      <Encabezado titulo="Cheques y eCheq" subtitulo="Cartera, depósitos y cheques emitidos" acciones={<Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => setNuevo(true)}>Registrar cheque</Boton>} />
      {resumen && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Indicador titulo="En cartera" valor={money(resumen.cartera)} detalle={`${por('recibido', 'en_cartera').cantidad} cheque(s)`} tono="azul" onClick={() => { setTab('recibido'); setEstado('en_cartera'); setFiltro(''); }} />
            <Indicador titulo="Depositados" valor={money(resumen.depositados_pendientes)} detalle="Pendientes de acreditar" tono="cian" onClick={() => { setTab('recibido'); setEstado('depositado'); setFiltro(''); }} />
            <Indicador titulo="Emitidos pendientes" valor={money(resumen.emitidos_pendientes)} detalle="Entregados, sin debitar" tono="violeta" onClick={() => { setTab('emitido'); setEstado('entregado'); setFiltro(''); }} />
            <Indicador titulo={`Próximos ${resumen.dias_alerta} días`} valor={String(resumen.proximos.length)} detalle="A depositar, vencer o debitar" tono="ambar" onClick={() => { setEstado(''); setFiltro('proximos'); }} />
            <Indicador titulo="Vencidos sin depositar" valor={String(resumen.vencidos.length)} detalle={resumen.vencidos.length ? 'Revisalos' : 'Ninguno'} tono={resumen.vencidos.length ? 'rojo' : 'verde'} onClick={() => { setTab('recibido'); setEstado(''); setFiltro('vencidos'); }} />
          </div>
          {(resumen.vencidos.length > 0 || resumen.proximos.length > 0) && (
            <Aviso tono={resumen.vencidos.length ? 'rojo' : 'ambar'} className="mb-4">
              <div>
                <div>
                  {resumen.vencidos.length > 0 && <p><strong>{resumen.vencidos.length}</strong> cheque(s) recibido(s) vencieron sin depositarse: {resumen.vencidos.slice(0, 3).map((c: any) => `N° ${c.nro_cheque} (${money(c.importe)})`).join(', ')}.</p>}
                  {resumen.proximos.length > 0 && <p>Próximos {resumen.dias_alerta} días: {resumen.proximos.slice(0, 4).map((c: any) => `${c.direccion === 'recibido' ? 'depositar' : 'debita'} N° ${c.nro_cheque} el ${fecha(c.fecha_pago)}`).join(' · ')}.</p>}
                </div>
              </div>
            </Aviso>
          )}
        </>
      )}
      <Pestanas items={[{ clave: 'recibido', titulo: 'Recibidos' }, { clave: 'emitido', titulo: 'Emitidos' }]} activo={tab} onCambio={(t) => { setTab(t); setEstado(''); }} />
      <div className="filtros mb-4 flex flex-wrap items-end gap-3">
        <Buscador value={q} onChange={setQ} placeholder="Número, banco, titular, CUIT, cliente…" className="min-w-56 flex-1" />
        <Campo label="Estado"><Select value={estado} onChange={(e) => setEstado(e.target.value)} className="w-auto"><option value="">Todos</option>{ESTADOS_CHEQUE.map((e) => <option key={e} value={e}>{ESTADO_CHEQUE_LABEL[e]}</option>)}</Select></Campo>
        <Campo label="Tipo"><Select value={modalidad} onChange={(e) => setModalidad(e.target.value)} className="w-auto"><option value="">Todos</option><option value="fisico">Físico</option><option value="echeq">eCheq</option></Select></Campo>
        <Campo label="Pago desde"><Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} /></Campo>
        <Campo label="Pago hasta"><Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} /></Campo>
        <Campo label="Vista"><Select value={filtro} onChange={(e) => setFiltro(e.target.value as typeof filtro)} className="w-auto"><option value="">Todos</option><option value="pendientes">Pendientes</option><option value="proximos">Próximos a vencer</option>{tab === 'recibido' && <option value="vencidos">Vencidos</option>}</Select></Campo>
        <Boton icono={<Download className="size-4" />} onClick={exportar} disabled={!data.length}>CSV</Boton>
      </div>
      <Tarjeta sinPadding titulo={tab === 'recibido' ? 'Cheques recibidos' : 'Cheques emitidos'} acciones={<span className="text-sm text-tenue">{totalesVista.map((x) => `${ESTADO_CHEQUE_LABEL[x.e as EstadoCheque]}: ${money(x.t)}`).join(' · ')}</span>}>
        {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
          <Tabla
            filas={data}
            clave={(c: any) => c.id}
            onFila={(c: any) => setVer(c.id)}
            vacio={<Vacio titulo="No hay cheques con esos filtros" texto="Los cheques se registran solos al cobrar o pagar con cheque, o a mano con “Registrar cheque”." />}
            columnas={[
              { clave: 'n', titulo: 'Cheque', render: (c: any) => <span><span className="font-medium">{c.banco}</span> N° {c.nro_cheque}{c.modalidad === 'echeq' && <Insignia tono="cian" className="ml-1.5">eCheq</Insignia>}</span>, movil: 'titulo' },
              { clave: 't', titulo: tab === 'recibido' ? 'Cliente / titular' : 'Proveedor / beneficiario', render: (c: any) => (tab === 'recibido' ? c.cliente ?? c.librador : c.proveedor ?? c.beneficiario) ?? '—', movil: 'subtitulo' },
              { clave: 'p', titulo: 'Fecha de pago', render: (c: any) => <span className={c.estado === 'en_cartera' && c.direccion === 'recibido' && c.fecha_vencimiento < hoyISO() ? 'font-medium text-red-600' : ''}>{fecha(c.fecha_pago)}</span>, movil: 'meta' },
              { clave: 'v', titulo: 'Vence', render: (c: any) => fecha(c.fecha_vencimiento), movil: 'meta' },
              { clave: 'i', titulo: 'Importe', alinear: 'derecha', render: (c: any) => money(c.importe), movil: 'derecha' },
              { clave: 'e', titulo: 'Estado', render: (c: any) => <EstadoChequeInsignia estado={c.estado} />, movil: 'meta' },
              {
                clave: 'a', titulo: '',
                render: (c: any) => (
                  <div className="flex flex-wrap justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                    {botones(c).map(([a, t]) => <Boton key={a} tam="sm" variante={a === 'anular' || a === 'rechazar' ? 'fantasma' : 'secundario'} icono={a === 'anular' ? <Ban className="size-4" /> : undefined} onClick={() => setAccion({ cheque: c, accion: a })}>{t}</Boton>)}
                  </div>
                ),
                movil: 'meta',
              },
            ]}
          />
        )}
      </Tarjeta>
      <p className="mt-3 text-xs text-tenue">Registro y control administrativo. ORVELAN no se conecta con plataformas bancarias: el estado de cada cheque lo actualizás vos al depositarlo, acreditarlo o rechazarlo.</p>
      {nuevo && <FormCheque cuentas={cuentas} onCerrar={() => setNuevo(false)} />}
      {accion && <ModalAccion cheque={accion.cheque} accion={accion.accion} cuentas={cuentas} onCerrar={() => setAccion(null)} />}
      {ver && <Detalle id={ver} onCerrar={() => setVer(null)} />}
    </>
  );
}
