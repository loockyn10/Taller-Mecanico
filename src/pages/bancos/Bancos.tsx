// Bancos: cuentas, movimientos (depósitos, extracciones, transferencias, ajustes) y conciliación manual.
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowLeftRight, Ban, Banknote, Download, Landmark, Pencil, Plus, Scale, Undo2 } from 'lucide-react';
import { api, nuevaClave, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { invalidarDinero } from '@/lib/caja';
import { descargarCSV, pesosCSV } from '@/lib/csv';
import { fecha, hoyISO, money, numero } from '@/lib/format';
import { Aviso, Boton, Buscador, Campo, Cargando, Check, Encabezado, ErrorCaja, Indicador, Input, InputMoneda, Insignia, Modal, Pestanas, Select, Tabla, Tarjeta, Textarea, useConfirmar, useDebounce, useToast, Vacio } from '@/components/ui';
import { AvisoCaja } from '@/components/Cobro';
import { CATEGORIA_BANCO_LABEL, MONEDAS, TIPOS_CUENTA_BANCARIA, TIPO_CUENTA_LABEL } from '@shared/dominio';

const SIGNO = (m: any) => (m.tipo === 'ingreso' ? m.importe : -m.importe);

// ───────────── Cuenta (alta / edición) ─────────────
function FormCuenta({ inicial, onCerrar }: { inicial?: any; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({
    nombre: inicial?.nombre ?? '', banco: inicial?.banco ?? '', tipo: inicial?.tipo ?? 'cuenta_corriente', alias: inicial?.alias ?? '', cbu: inicial?.cbu ?? '', titular: inicial?.titular ?? '',
    cuit_titular: inicial?.cuit_titular ?? '', moneda: inicial?.moneda ?? 'ARS', saldo_inicial: inicial?.saldo_inicial ?? 0, notas: inicial?.notas ?? '', activa: inicial ? !!inicial.activa : true,
  });
  const conMovs = !!inicial && (inicial.saldo !== inicial.saldo_inicial || inicial.pendientes > 0);
  const m = useMutation({
    mutationFn: () => {
      const datos = { ...f, alias: f.alias || null, cbu: f.cbu || null, titular: f.titular || null, cuit_titular: f.cuit_titular || null, notas: f.notas || null };
      return inicial ? api.put(`/bancos/cuentas/${inicial.id}`, datos) : api.post('/bancos/cuentas', datos);
    },
    onSuccess: () => {
      invalidarDinero(qc);
      toast.ok(inicial ? 'Cuenta actualizada' : 'Cuenta creada');
      onCerrar();
    },
    onError: toast.error,
  });
  return (
    <Modal abierto onCerrar={onCerrar} titulo={inicial ? 'Editar cuenta bancaria' : 'Nueva cuenta bancaria'} ancho="lg" pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" disabled={f.nombre.trim().length < 2 || f.banco.trim().length < 2} cargando={m.isPending} onClick={() => m.mutate()}>Guardar</Boton></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Campo label="Nombre interno" requerido hint="Cómo la vas a reconocer, ej.: Galicia CC $"><Input value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} autoFocus /></Campo>
        <Campo label="Banco" requerido><Input value={f.banco} onChange={(e) => setF({ ...f, banco: e.target.value })} placeholder="Banco Galicia" /></Campo>
        <Campo label="Tipo de cuenta"><Select value={f.tipo} onChange={(e) => setF({ ...f, tipo: e.target.value })}>{TIPOS_CUENTA_BANCARIA.map((t) => <option key={t} value={t}>{TIPO_CUENTA_LABEL[t]}</option>)}</Select></Campo>
        <Campo label="Moneda" hint={conMovs ? 'Con movimientos no se puede cambiar' : undefined}><Select value={f.moneda} disabled={conMovs} onChange={(e) => setF({ ...f, moneda: e.target.value })}>{MONEDAS.map((t) => <option key={t} value={t}>{t === 'ARS' ? 'Pesos (ARS)' : 'Dólares (USD)'}</option>)}</Select></Campo>
        <Campo label="Alias"><Input value={f.alias} onChange={(e) => setF({ ...f, alias: e.target.value })} /></Campo>
        <Campo label="CBU / CVU" hint="22 dígitos"><Input inputMode="numeric" value={f.cbu} onChange={(e) => setF({ ...f, cbu: e.target.value.replace(/\D/g, '').slice(0, 22) })} /></Campo>
        <Campo label="Titular"><Input value={f.titular} onChange={(e) => setF({ ...f, titular: e.target.value })} /></Campo>
        <Campo label="CUIT del titular"><Input value={f.cuit_titular} onChange={(e) => setF({ ...f, cuit_titular: e.target.value })} placeholder="30-12345678-9" /></Campo>
        <Campo label="Saldo inicial" hint={conMovs ? 'Con movimientos no se puede cambiar: usá un ajuste' : 'Saldo de la cuenta al empezar a usar Fierro'}><InputMoneda value={f.saldo_inicial} disabled={conMovs} onChange={(v) => setF({ ...f, saldo_inicial: v })} /></Campo>
        {inicial && <div className="flex items-end"><Check checked={f.activa} onChange={(v) => setF({ ...f, activa: v })} label="Cuenta activa (disponible para cobrar y pagar)" /></div>}
        <Campo label="Notas" className="sm:col-span-2"><Input value={f.notas} onChange={(e) => setF({ ...f, notas: e.target.value })} /></Campo>
      </div>
    </Modal>
  );
}

// ───────────── Operaciones sobre cuentas ─────────────
type Operacion = 'deposito' | 'extraccion' | 'transferencia' | 'manual' | 'ajuste';
const TITULO_OP: Record<Operacion, string> = { deposito: 'Depositar efectivo de la caja', extraccion: 'Extraer efectivo hacia la caja', transferencia: 'Transferir entre cuentas propias', manual: 'Movimiento manual del banco', ajuste: 'Ajuste de saldo autorizado' };

function ModalOperacion({ op, cuentas, cuentaInicial, onCerrar }: { op: Operacion; cuentas: any[]; cuentaInicial?: string; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const activas = cuentas.filter((c) => c.activa);
  const pesos = activas.filter((c) => c.moneda === 'ARS');
  const base = op === 'deposito' || op === 'extraccion' ? pesos : activas;
  const [f, setF] = useState({ cuenta_id: cuentaInicial && base.some((c) => c.id === cuentaInicial) ? cuentaInicial : base[0]?.id ?? '', destino_id: '', tipo: op === 'ajuste' ? 'ingreso' : op === 'manual' ? 'egreso' : 'ingreso', importe: 0, concepto: '', referencia: '', fecha: hoyISO() });
  const [clave] = useState(nuevaClave());
  const { puede } = useAuth();
  const m = useMutation({
    mutationFn: () => {
      if (op === 'transferencia') return api.post('/bancos/transferencias', { origen_id: f.cuenta_id, destino_id: f.destino_id, importe: f.importe, fecha: f.fecha, concepto: f.concepto || undefined, referencia: f.referencia || null, idem_key: clave });
      if (op === 'deposito') return api.post('/bancos/depositos', { cuenta_id: f.cuenta_id, importe: f.importe, fecha: f.fecha, concepto: f.concepto || undefined, referencia: f.referencia || null, idem_key: clave });
      if (op === 'extraccion') return api.post('/bancos/extracciones', { cuenta_id: f.cuenta_id, importe: f.importe, fecha: f.fecha, concepto: f.concepto || undefined, referencia: f.referencia || null, idem_key: clave });
      if (op === 'ajuste') return api.post('/bancos/ajustes', { cuenta_id: f.cuenta_id, tipo: f.tipo, importe: f.importe, fecha: f.fecha, motivo: f.concepto, referencia: f.referencia || null, idem_key: clave });
      return api.post('/bancos/movimientos', { cuenta_id: f.cuenta_id, tipo: f.tipo, importe: f.importe, fecha: f.fecha, concepto: f.concepto, referencia: f.referencia || null, idem_key: clave });
    },
    onSuccess: () => {
      invalidarDinero(qc);
      toast.ok('Operación registrada');
      onCerrar();
    },
    onError: toast.error,
  });
  const destinos = pesos.length && cuentas.find((c) => c.id === f.cuenta_id)?.moneda === 'USD' ? activas.filter((c) => c.moneda === 'USD') : activas.filter((c) => c.moneda === (cuentas.find((x) => x.id === f.cuenta_id)?.moneda ?? 'ARS'));
  const necesitaConcepto = op === 'manual' || op === 'ajuste';
  const valido = f.cuenta_id && f.importe > 0 && (!necesitaConcepto || f.concepto.trim().length >= (op === 'ajuste' ? 8 : 3)) && (op !== 'transferencia' || (f.destino_id && f.destino_id !== f.cuenta_id));
  return (
    <Modal abierto onCerrar={onCerrar} titulo={TITULO_OP[op]} ancho="md" pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" disabled={!valido} cargando={m.isPending} onClick={() => m.mutate()}>Confirmar</Boton></>}>
      <div className="space-y-3">
        {(op === 'deposito' || op === 'extraccion') && <AvisoCaja />}
        {op === 'deposito' && <Aviso>El efectivo sale de la caja y entra a la cuenta. No es un ingreso ni un egreso: sólo cambia de lugar.</Aviso>}
        {op === 'extraccion' && <Aviso>El dinero sale de la cuenta y entra como efectivo a la caja. No es un ingreso nuevo.</Aviso>}
        {op === 'transferencia' && <Aviso>Mueve plata entre cuentas propias. No se cuenta como ingreso ni como egreso del negocio.</Aviso>}
        {op === 'manual' && <Aviso tono="ambar">Para intereses, comisiones o débitos que no pasaron por la caja. Los pagos a proveedores y los gastos se cargan en sus pantallas, eligiendo la cuenta.</Aviso>}
        {op === 'ajuste' && <Aviso tono="ambar">Corrige una diferencia con el extracto. No es resultado del negocio y queda registrado a tu nombre con el motivo.</Aviso>}
        <Campo label={op === 'transferencia' ? 'Cuenta de origen' : 'Cuenta'} requerido>
          <Select value={f.cuenta_id} onChange={(e) => setF({ ...f, cuenta_id: e.target.value, destino_id: '' })}>{base.map((c) => <option key={c.id} value={c.id}>{c.nombre} ({c.moneda}) · {money(c.saldo)}</option>)}</Select>
        </Campo>
        {op === 'transferencia' && (
          <Campo label="Cuenta de destino" requerido>
            <Select value={f.destino_id} onChange={(e) => setF({ ...f, destino_id: e.target.value })}><option value="">— Elegir —</option>{destinos.filter((c) => c.id !== f.cuenta_id).map((c) => <option key={c.id} value={c.id}>{c.nombre} ({c.moneda})</option>)}</Select>
          </Campo>
        )}
        {(op === 'manual' || op === 'ajuste') && (
          <Campo label="Tipo"><Select value={f.tipo} onChange={(e) => setF({ ...f, tipo: e.target.value })}><option value="ingreso">Ingreso (suma al saldo)</option><option value="egreso">Egreso (resta del saldo)</option></Select></Campo>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Campo label="Importe" requerido><InputMoneda value={f.importe} onChange={(v) => setF({ ...f, importe: v })} autoFocus /></Campo>
          <Campo label="Fecha" hint={puede('fechas.retroactivas') ? undefined : 'Sólo hoy'}><Input type="date" value={f.fecha} max={hoyISO()} onChange={(e) => setF({ ...f, fecha: e.target.value })} /></Campo>
        </div>
        <Campo label={op === 'ajuste' ? 'Motivo del ajuste' : 'Concepto'} requerido={necesitaConcepto} hint={op === 'ajuste' ? 'Mínimo 8 caracteres' : undefined}>
          <Input value={f.concepto} onChange={(e) => setF({ ...f, concepto: e.target.value })} placeholder={op === 'manual' ? 'Ej.: comisión de mantenimiento' : undefined} />
        </Campo>
        <Campo label="Referencia (N° de operación)"><Input value={f.referencia} onChange={(e) => setF({ ...f, referencia: e.target.value })} /></Campo>
      </div>
    </Modal>
  );
}

// ───────────── Cuentas ─────────────
function Cuentas({ cuentas, onOp }: { cuentas: any[]; onOp: (op: Operacion, cuenta?: string) => void }) {
  const { puede } = useAuth();
  const [form, setForm] = useState<any | 'nueva' | null>(null);
  const [todas, setTodas] = useState(false);
  const visibles = cuentas.filter((c) => todas || c.activa);
  const totalARS = cuentas.filter((c) => c.activa && c.moneda === 'ARS').reduce((a, c) => a + c.saldo, 0);
  const usd = cuentas.filter((c) => c.activa && c.moneda === 'USD').reduce((a, c) => a + c.saldo, 0);
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Indicador titulo="Saldo en bancos (ARS)" valor={money(totalARS)} detalle={`${cuentas.filter((c) => c.activa && c.moneda === 'ARS').length} cuenta(s) en pesos`} icono={<Landmark className="size-5" />} />
        {usd !== 0 && <Indicador titulo="Saldo en dólares" valor={`US$ ${(usd / 100).toLocaleString('es-AR', { minimumFractionDigits: 2 })}`} tono="cian" />}
        <Indicador titulo="Movimientos sin conciliar" valor={String(cuentas.reduce((a, c) => a + c.pendientes, 0))} tono="ambar" />
      </div>
      <div className="filtros mb-4 flex flex-wrap gap-2">
        <Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => setForm('nueva')}>Nueva cuenta</Boton>
        <Boton icono={<Banknote className="size-4" />} disabled={!cuentas.some((c) => c.activa && c.moneda === 'ARS')} onClick={() => onOp('deposito')}>Depositar efectivo</Boton>
        <Boton disabled={!cuentas.some((c) => c.activa && c.moneda === 'ARS')} onClick={() => onOp('extraccion')}>Extraer efectivo</Boton>
        <Boton icono={<ArrowLeftRight className="size-4" />} disabled={cuentas.filter((c) => c.activa).length < 2} onClick={() => onOp('transferencia')}>Transferir</Boton>
        <Boton disabled={!cuentas.some((c) => c.activa)} onClick={() => onOp('manual')}>Movimiento manual</Boton>
        {puede('bancos.ajustar') && <Boton disabled={!cuentas.some((c) => c.activa)} onClick={() => onOp('ajuste')}>Ajuste de saldo</Boton>}
        <Check className="ml-auto self-center" checked={todas} onChange={setTodas} label="Ver cuentas inactivas" />
      </div>
      {visibles.length === 0 ? (
        <Tarjeta><Vacio icono={<Landmark className="size-5" />} titulo="Todavía no cargaste cuentas bancarias" texto="Creá tus cuentas para poder asignar cobros por transferencia, depositar efectivo y conciliar contra el extracto." accion={<Boton variante="primario" onClick={() => setForm('nueva')}>Nueva cuenta</Boton>} /></Tarjeta>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visibles.map((c) => (
            <Tarjeta key={c.id} titulo={<span className="flex items-center gap-2">{c.nombre}{!c.activa && <Insignia>Inactiva</Insignia>}</span>} subtitulo={`${c.banco} · ${TIPO_CUENTA_LABEL[c.tipo as keyof typeof TIPO_CUENTA_LABEL]}`} acciones={<Boton tam="sm" variante="fantasma" icono={<Pencil className="size-4" />} onClick={() => setForm(c)} aria-label="Editar" />}>
              <div className="text-2xl font-bold tabular-nums">{c.moneda === 'USD' ? `US$ ${(c.saldo / 100).toLocaleString('es-AR', { minimumFractionDigits: 2 })}` : money(c.saldo)}</div>
              <dl className="mt-2 space-y-0.5 text-xs text-tenue">
                {c.alias && <div>Alias: <span className="text-texto">{c.alias}</span></div>}
                {c.cbu && <div>CBU/CVU: <span className="text-texto">{c.cbu}</span></div>}
                {c.titular && <div>Titular: <span className="text-texto">{c.titular}</span></div>}
                <div>Conciliado: <span className="text-texto">{money(c.saldo_conciliado)}</span> · pendientes: <span className="text-texto">{c.pendientes}</span></div>
              </dl>
              {c.activa && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <Boton tam="sm" onClick={() => onOp('manual', c.id)}>Movimiento</Boton>
                  {c.moneda === 'ARS' && <Boton tam="sm" onClick={() => onOp('deposito', c.id)}>Depositar</Boton>}
                </div>
              )}
            </Tarjeta>
          ))}
        </div>
      )}
      {form && <FormCuenta inicial={form === 'nueva' ? undefined : form} onCerrar={() => setForm(null)} />}
    </>
  );
}

// ───────────── Movimientos ─────────────
function Movimientos({ cuentas }: { cuentas: any[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useAuth();
  const [cuenta, setCuenta] = useState('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [categoria, setCategoria] = useState('');
  const [conciliado, setConciliado] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounce(q);
  const [anular, setAnular] = useState<any | null>(null);
  const [motivo, setMotivo] = useState('');
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['bancos', 'movimientos', { cuenta, desde, hasta, categoria, conciliado, dq }], queryFn: () => api.get<any[]>(`/bancos/movimientos${qs({ cuenta_id: cuenta, desde, hasta, categoria, conciliado, q: dq })}`) });
  const m = useMutation({
    mutationFn: () => (anular.origen_tipo.startsWith('transferencia') ? api.post(`/bancos/transferencias/${anular.transferencia_id}/anular`, { motivo }) : api.post(`/bancos/movimientos/${anular.id}/anular`, { motivo })),
    onSuccess: () => {
      invalidarDinero(qc);
      toast.ok('Movimiento anulado');
      setAnular(null);
      setMotivo('');
    },
    onError: toast.error,
  });
  const anulable = (x: any) => !x.revertido && !x.conciliado && x.origen_tipo !== 'reverso' && ['manual', 'deposito', 'extraccion', 'transferencia_sal', 'transferencia_ent'].includes(x.origen_tipo) || (x.origen_tipo === 'ajuste' && puede('bancos.ajustar') && !x.revertido && !x.conciliado);
  const totales = data.reduce((a, x) => ({ i: a.i + (x.tipo === 'ingreso' ? x.importe : 0), e: a.e + (x.tipo === 'egreso' ? x.importe : 0) }), { i: 0, e: 0 });
  const exportar = () => descargarCSV('movimientos-bancarios', ['Fecha', 'Cuenta', 'Categoría', 'Concepto', 'Referencia', 'Ingreso', 'Egreso', 'Conciliado', 'Usuario'], data.map((x) => [x.fecha, x.cuenta, CATEGORIA_BANCO_LABEL[x.categoria] ?? x.categoria, x.concepto, x.referencia ?? '', x.tipo === 'ingreso' ? pesosCSV(x.importe) : '', x.tipo === 'egreso' ? pesosCSV(x.importe) : '', x.conciliado ? 'Sí' : 'No', x.usuario ?? '']));
  return (
    <>
      <div className="filtros mb-4 flex flex-wrap items-end gap-3">
        <Campo label="Cuenta"><Select value={cuenta} onChange={(e) => setCuenta(e.target.value)} className="w-auto"><option value="">Todas</option>{cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</Select></Campo>
        <Campo label="Desde"><Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} /></Campo>
        <Campo label="Hasta"><Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} /></Campo>
        <Campo label="Tipo"><Select value={categoria} onChange={(e) => setCategoria(e.target.value)} className="w-auto"><option value="">Todos</option>{Object.entries(CATEGORIA_BANCO_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Campo>
        <Campo label="Conciliación"><Select value={conciliado} onChange={(e) => setConciliado(e.target.value)} className="w-auto"><option value="">Todos</option><option value="0">Pendientes</option><option value="1">Conciliados</option></Select></Campo>
        <Buscador value={q} onChange={setQ} placeholder="Concepto o referencia…" className="min-w-52 flex-1" />
        <Boton icono={<Download className="size-4" />} onClick={exportar} disabled={!data.length}>CSV</Boton>
      </div>
      <Tarjeta sinPadding acciones={<span className="text-sm text-tenue">Ingresos {money(totales.i)} · Egresos {money(totales.e)}</span>} titulo="Movimientos bancarios">
        {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
          <Tabla
            filas={data}
            clave={(x: any) => x.id}
            vacio={<Vacio titulo="Sin movimientos" texto="Los cobros, pagos y gastos asignados a una cuenta aparecen acá automáticamente." />}
            columnas={[
              { clave: 'f', titulo: 'Fecha', render: (x: any) => fecha(x.fecha), movil: 'meta' },
              { clave: 'c', titulo: 'Cuenta', render: (x: any) => x.cuenta, movil: 'meta' },
              {
                clave: 'd', titulo: 'Concepto',
                render: (x: any) => (
                  <span className={x.revertido ? 'text-tenue line-through' : ''}>
                    {x.concepto}
                    {x.ref_tipo === 'cobro' && x.ref_id && <Link className="ml-1 text-marca-700 no-underline" to={`/cobros?ver=${x.ref_id}`}>↗</Link>}
                    {x.referencia ? <span className="text-tenue"> · {x.referencia}</span> : null}
                  </span>
                ),
                movil: 'titulo',
              },
              { clave: 't', titulo: 'Tipo', render: (x: any) => <Insignia tono={x.categoria === 'reverso' ? 'gris' : x.afecta_resultado ? 'ambar' : 'azul'}>{CATEGORIA_BANCO_LABEL[x.categoria] ?? x.categoria}</Insignia>, movil: 'subtitulo' },
              { clave: 'm', titulo: 'Importe', alinear: 'derecha', render: (x: any) => <span className={x.tipo === 'ingreso' ? 'text-emerald-700' : 'text-red-600'}>{x.tipo === 'ingreso' ? '+' : '−'}{money(x.importe)}</span>, movil: 'derecha' },
              { clave: 'k', titulo: 'Conc.', render: (x: any) => (x.conciliado ? <Insignia tono="verde">Conciliado</Insignia> : <span className="text-xs text-tenue">Pendiente</span>), movil: 'meta' },
              { clave: 'a', titulo: '', render: (x: any) => (anulable(x) ? <Boton tam="sm" variante="fantasma" icono={<Ban className="size-4" />} onClick={() => setAnular(x)}>Anular</Boton> : null), movil: 'meta' },
            ]}
          />
        )}
      </Tarjeta>
      <Modal abierto={!!anular} onCerrar={() => setAnular(null)} titulo="Anular movimiento" ancho="sm" pie={<><Boton onClick={() => setAnular(null)}>Cancelar</Boton><Boton variante="peligro" disabled={motivo.trim().length < 3} cargando={m.isPending} onClick={() => m.mutate()}>Anular</Boton></>}>
        <div className="space-y-3">
          <p className="text-sm text-tenue">{anular?.concepto}. Se registra un contra-asiento; el movimiento original no se borra.{anular?.origen_tipo?.startsWith('transferencia') ? ' Se anulan las dos puntas de la transferencia.' : ''}{anular && ['deposito', 'extraccion'].includes(anular.origen_tipo) ? ' El efectivo vuelve a la caja abierta.' : ''}</p>
          <Campo label="Motivo" requerido><Input value={motivo} onChange={(e) => setMotivo(e.target.value)} autoFocus /></Campo>
        </div>
      </Modal>
    </>
  );
}

// ───────────── Conciliación ─────────────
function Conciliacion({ cuentas }: { cuentas: any[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { confirmar, dialogo } = useConfirmar();
  const [cuentaId, setCuentaId] = useState(cuentas[0]?.id ?? '');
  const [corte, setCorte] = useState(hoyISO());
  const [saldoExtracto, setSaldoExtracto] = useState(0);
  const [notas, setNotas] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [detalle, setDetalle] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['bancos', 'conciliacion', cuentaId], queryFn: () => api.get(`/bancos/conciliacion/${cuentaId}`), enabled: !!cuentaId });
  const { data: historial = [] } = useQuery({ queryKey: ['bancos', 'conciliaciones', cuentaId], queryFn: () => api.get<any[]>(`/bancos/conciliaciones?cuenta_id=${cuentaId}`), enabled: !!cuentaId });
  const { data: det } = useQuery({ queryKey: ['bancos', 'conciliacion-detalle', detalle], queryFn: () => api.get(`/bancos/conciliaciones/${detalle}`), enabled: !!detalle });
  const pendientes: any[] = data?.pendientes ?? [];
  const elegibles = pendientes.filter((p) => p.fecha <= corte);
  const calc = useMemo(() => {
    if (!data) return { libros: 0, dif: 0 };
    const suma = pendientes.filter((p) => sel.has(p.id)).reduce((a, p) => a + SIGNO(p), 0);
    const libros = data.cuenta.saldo_conciliado + suma;
    return { libros, dif: saldoExtracto - libros };
  }, [data, pendientes, sel, saldoExtracto]);
  const ultima = historial.find((h) => h.estado === 'vigente');
  const m = useMutation({
    mutationFn: () => api.post('/bancos/conciliaciones', { cuenta_id: cuentaId, fecha_corte: corte, saldo_extracto: saldoExtracto, movimiento_ids: [...sel], notas: notas || null }),
    onSuccess: () => {
      invalidarDinero(qc);
      toast.ok(`Conciliación registrada (${sel.size} movimientos)`);
      setSel(new Set());
      setNotas('');
    },
    onError: toast.error,
  });
  const deshacer = useMutation({
    mutationFn: (id: string) => api.post(`/bancos/conciliaciones/${id}/deshacer`, {}),
    onSuccess: () => {
      invalidarDinero(qc);
      toast.ok('Conciliación deshecha');
    },
    onError: toast.error,
  });
  const alternar = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <>
      <div className="filtros mb-4 flex flex-wrap items-end gap-3">
        <Campo label="Cuenta"><Select value={cuentaId} onChange={(e) => { setCuentaId(e.target.value); setSel(new Set()); }} className="w-auto">{cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</Select></Campo>
        <Campo label="Fecha de corte del extracto"><Input type="date" value={corte} max={hoyISO()} onChange={(e) => setCorte(e.target.value)} /></Campo>
        <Campo label="Saldo según el extracto"><InputMoneda value={saldoExtracto} onChange={setSaldoExtracto} className="w-48" /></Campo>
      </div>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : data && (
        <div className="grid gap-5 xl:grid-cols-3">
          <Tarjeta titulo="Movimientos pendientes de conciliar" subtitulo="Tildá los que figuran en el extracto del banco" className="xl:col-span-2" sinPadding
            acciones={<><Boton tam="sm" onClick={() => setSel(new Set(elegibles.map((p) => p.id)))}>Tildar todos hasta el corte</Boton><Boton tam="sm" variante="fantasma" onClick={() => setSel(new Set())}>Limpiar</Boton></>}>
            {pendientes.length === 0 ? <Vacio titulo="Todo conciliado" texto="No quedan movimientos pendientes en esta cuenta." /> : (
              <ul className="max-h-[28rem] divide-y divide-borde overflow-y-auto text-sm">
                {pendientes.map((p) => (
                  <li key={p.id} className={`flex items-center gap-3 px-4 py-2 ${p.fecha > corte ? 'opacity-50' : ''}`}>
                    <input type="checkbox" className="size-4 accent-marca-600" checked={sel.has(p.id)} disabled={p.fecha > corte} onChange={() => alternar(p.id)} aria-label="Conciliar" />
                    <div className="min-w-0 flex-1"><div className="truncate">{p.concepto}</div><div className="text-xs text-tenue">{fecha(p.fecha)} · {CATEGORIA_BANCO_LABEL[p.categoria] ?? p.categoria}{p.referencia ? ` · ${p.referencia}` : ''}</div></div>
                    <span className={`tabular-nums ${p.tipo === 'ingreso' ? 'text-emerald-700' : 'text-red-600'}`}>{p.tipo === 'ingreso' ? '+' : '−'}{money(p.importe)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Tarjeta>
          <div className="space-y-5">
            <Tarjeta titulo="Resultado de la conciliación">
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between"><dt className="text-tenue">Saldo en libros (todo)</dt><dd className="tabular-nums">{money(data.cuenta.saldo)}</dd></div>
                <div className="flex justify-between"><dt className="text-tenue">Ya conciliado antes</dt><dd className="tabular-nums">{money(data.cuenta.saldo_conciliado)}</dd></div>
                <div className="flex justify-between"><dt className="text-tenue">Seleccionados ({sel.size})</dt><dd className="tabular-nums">{money(calc.libros - data.cuenta.saldo_conciliado)}</dd></div>
                <div className="flex justify-between border-t border-borde pt-2 font-medium"><dt>Libros conciliados</dt><dd className="tabular-nums">{money(calc.libros)}</dd></div>
                <div className="flex justify-between"><dt className="text-tenue">Saldo del extracto</dt><dd className="tabular-nums">{money(saldoExtracto)}</dd></div>
                <div className={`flex justify-between font-bold ${calc.dif === 0 ? 'text-emerald-700' : 'text-amber-700'}`}><dt>Diferencia</dt><dd className="tabular-nums">{money(calc.dif)}</dd></div>
              </dl>
              {calc.dif !== 0 && sel.size > 0 && <Aviso tono="ambar" className="mt-3">Hay una diferencia con el extracto. Podés guardar igual: queda registrada para revisarla (puede ser un movimiento que falta cargar).</Aviso>}
              <Campo label="Notas" className="mt-3"><Textarea rows={2} value={notas} onChange={(e) => setNotas(e.target.value)} /></Campo>
              <Boton variante="primario" className="mt-3 w-full" icono={<Scale className="size-4" />} disabled={!sel.size} cargando={m.isPending} onClick={() => m.mutate()}>Registrar conciliación</Boton>
            </Tarjeta>
          </div>
        </div>
      )}
      <Tarjeta titulo="Historial de conciliaciones" className="mt-5" sinPadding>
        <Tabla
          filas={historial}
          clave={(h: any) => h.id}
          onFila={(h: any) => setDetalle(h.id)}
          vacio={<p className="px-4 py-6 text-center text-sm text-tenue">Todavía no hay conciliaciones de esta cuenta</p>}
          columnas={[
            { clave: 'n', titulo: 'N°', render: (h: any) => `#${numero(h.numero)}`, movil: 'titulo' },
            { clave: 'f', titulo: 'Corte', render: (h: any) => fecha(h.fecha_corte), movil: 'subtitulo' },
            { clave: 'c', titulo: 'Movimientos', render: (h: any) => h.cantidad, movil: 'meta' },
            { clave: 'e', titulo: 'Extracto', alinear: 'derecha', render: (h: any) => money(h.saldo_extracto), movil: 'meta' },
            { clave: 'l', titulo: 'Libros', alinear: 'derecha', render: (h: any) => money(h.saldo_libros), movil: 'meta' },
            { clave: 'd', titulo: 'Diferencia', alinear: 'derecha', render: (h: any) => <span className={h.diferencia === 0 ? 'text-emerald-700' : 'font-medium text-amber-700'}>{money(h.diferencia)}</span>, movil: 'derecha' },
            { clave: 's', titulo: 'Estado', render: (h: any) => <Insignia tono={h.estado === 'vigente' ? 'verde' : 'gris'}>{h.estado === 'vigente' ? 'Vigente' : 'Deshecha'}</Insignia>, movil: 'meta' },
            { clave: 'u', titulo: '', render: (h: any) => (h.id === ultima?.id ? <Boton tam="sm" variante="fantasma" icono={<Undo2 className="size-4" />} onClick={async (e) => { e.stopPropagation(); if (await confirmar('Deshacer la última conciliación', 'Los movimientos vuelven a quedar pendientes. No se borra ningún movimiento.', true)) deshacer.mutate(h.id); }}>Deshacer</Boton> : null), movil: 'meta' },
          ]}
        />
      </Tarjeta>
      <Modal abierto={!!detalle} onCerrar={() => setDetalle(null)} titulo={det ? `Conciliación #${numero(det.numero)} · ${det.cuenta}` : 'Conciliación'} ancho="lg">
        {!det ? <Cargando /> : (
          <div className="space-y-3 text-sm">
            <p>Corte {fecha(det.fecha_corte)} · extracto {money(det.saldo_extracto)} · libros {money(det.saldo_libros)} · diferencia <strong>{money(det.diferencia)}</strong>{det.notas ? ` · ${det.notas}` : ''}</p>
            <ul className="divide-y divide-borde rounded-ctl border border-borde">{det.movimientos.map((x: any) => <li key={x.id} className="flex justify-between gap-3 px-3 py-1.5"><span className="truncate">{fecha(x.fecha)} · {x.concepto}</span><span className="tabular-nums">{x.tipo === 'ingreso' ? '+' : '−'}{money(x.importe)}</span></li>)}</ul>
          </div>
        )}
      </Modal>
      {dialogo}
    </>
  );
}

// ───────────── Pantalla ─────────────
export function Bancos() {
  const [tab, setTab] = useState<'cuentas' | 'movimientos' | 'conciliacion'>('cuentas');
  const [op, setOp] = useState<{ op: Operacion; cuenta?: string } | null>(null);
  const { data: cuentas = [], isLoading, error, refetch } = useQuery({ queryKey: ['bancos', 'cuentas'], queryFn: () => api.get<any[]>('/bancos/cuentas?todas=1') });
  return (
    <>
      <Encabezado titulo="Bancos" subtitulo="Cuentas, movimientos y conciliación contra el extracto" />
      <Pestanas items={[{ clave: 'cuentas', titulo: 'Cuentas' }, { clave: 'movimientos', titulo: 'Movimientos' }, { clave: 'conciliacion', titulo: 'Conciliación' }]} activo={tab} onCambio={setTab} />
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : tab === 'cuentas' ? <Cuentas cuentas={cuentas} onOp={(o, cuenta) => setOp({ op: o, cuenta })} /> : tab === 'movimientos' ? <Movimientos cuentas={cuentas} /> : cuentas.length ? <Conciliacion cuentas={cuentas.filter((c: any) => c.activa)} /> : <Vacio titulo="Primero creá una cuenta bancaria" />}
      {op && <ModalOperacion op={op.op} cuentas={cuentas} cuentaInicial={op.cuenta} onCerrar={() => setOp(null)} />}
    </>
  );
}
