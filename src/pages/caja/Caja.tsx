// Caja diaria: apertura, movimientos, arqueo, cierre, historial y reportes.
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Ban, Banknote, Calculator, Download, Lock, Plus, Receipt, Unlock, Wallet } from 'lucide-react';
import { api, nuevaClave, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { invalidarDinero, useEstadoCaja } from '@/lib/caja';
import { descargarCSV, pesosCSV } from '@/lib/csv';
import { fecha, fechaHora, hoyISO, money, numero, sumarDias } from '@/lib/format';
import { Aviso, Boton, Buscador, Campo, Cargando, Dato, Encabezado, ErrorCaja, Indicador, Input, InputMoneda, Insignia, Modal, Pestanas, Select, Tabla, Tarjeta, Textarea, useDebounce, useToast, Vacio } from '@/components/ui';
import { ModalGasto } from '@/components/FormGasto';
import { MEDIOS_PAGO, MEDIO_PAGO_LABEL, RUBRO_CAJA_LABEL, type MedioPago, type RubroCaja } from '@shared/dominio';

const DENOMINACIONES = [20000, 10000, 2000, 1000, 500, 200, 100, 50, 20, 10] as const; // pesos

/** Conteo de efectivo por denominación; devuelve el total en centavos. */
function ConteoEfectivo({ cantidades, onChange }: { cantidades: Record<string, number>; onChange: (c: Record<string, number>) => void }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
      {DENOMINACIONES.map((d) => (
        <label key={d} className="flex items-center justify-between gap-2 text-sm">
          <span className="text-tenue">$ {d.toLocaleString('es-AR')} ×</span>
          <Input
            type="number"
            min={0}
            inputMode="numeric"
            className="h-9 w-20 text-right"
            value={cantidades[String(d)] ?? ''}
            placeholder="0"
            aria-label={`Cantidad de billetes o monedas de ${d} pesos`}
            onChange={(e) => onChange({ ...cantidades, [String(d)]: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
          />
        </label>
      ))}
    </div>
  );
}
const totalConteo = (c: Record<string, number>) => Object.entries(c).reduce((a, [d, n]) => a + Number(d) * n * 100, 0);

function Diferencia({ valor }: { valor: number | null | undefined }) {
  if (valor == null) return <span className="text-tenue">—</span>;
  if (valor === 0) return <Insignia tono="verde">Sin diferencia</Insignia>;
  return <Insignia tono={valor < 0 ? 'rojo' : 'ambar'}>{valor < 0 ? 'Faltante' : 'Sobrante'} {money(Math.abs(valor))}</Insignia>;
}

// ───────────── Modales ─────────────
function ModalApertura({ sugerido, onCerrar }: { sugerido: number; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [saldo, setSaldo] = useState(sugerido);
  const [notas, setNotas] = useState('');
  const m = useMutation({
    mutationFn: () => api.post('/caja/abrir', { saldo_inicial: saldo, notas: notas || null }),
    onSuccess: () => {
      invalidarDinero(qc);
      toast.ok('Caja abierta');
      onCerrar();
    },
    onError: (e) => {
      invalidarDinero(qc);
      toast.error(e);
    },
  });
  return (
    <Modal abierto onCerrar={onCerrar} titulo="Abrir caja" ancho="sm" pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" cargando={m.isPending} onClick={() => m.mutate()}>Abrir caja</Boton></>}>
      <div className="space-y-3">
        <Campo label="Efectivo inicial en la caja" hint={sugerido > 0 ? `Sugerido: lo declarado en el último cierre (${money(sugerido)})` : undefined}>
          <InputMoneda value={saldo} onChange={setSaldo} autoFocus />
        </Campo>
        <Campo label="Notas (opcional)"><Input value={notas} onChange={(e) => setNotas(e.target.value)} /></Campo>
      </div>
    </Modal>
  );
}

function ModalIngreso({ onCerrar }: { onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ concepto: '', importe: 0, medio: 'efectivo' as MedioPago, referencia: '' });
  const [clave] = useState(nuevaClave());
  const m = useMutation({
    mutationFn: () => api.post('/caja/movimientos', { ...f, referencia: f.referencia || null, idem_key: clave }),
    onSuccess: () => {
      invalidarDinero(qc);
      toast.ok('Ingreso registrado');
      onCerrar();
    },
    onError: toast.error,
  });
  return (
    <Modal abierto onCerrar={onCerrar} titulo="Registrar ingreso" ancho="sm" pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" disabled={f.concepto.trim().length < 3 || f.importe <= 0} cargando={m.isPending} onClick={() => m.mutate()}>Registrar</Boton></>}>
      <div className="space-y-3">
        <Aviso>Para ingresos que no provienen de ventas ni cobros (aportes, sobrantes, reintegros). Los cobros de clientes se registran desde sus comprobantes.</Aviso>
        <Campo label="Concepto" requerido><Input value={f.concepto} onChange={(e) => setF({ ...f, concepto: e.target.value })} autoFocus /></Campo>
        <Campo label="Importe" requerido><InputMoneda value={f.importe} onChange={(v) => setF({ ...f, importe: v })} /></Campo>
        <Campo label="Medio">
          <Select value={f.medio} onChange={(e) => setF({ ...f, medio: e.target.value as MedioPago })}>
            {MEDIOS_PAGO.map((x) => <option key={x} value={x}>{MEDIO_PAGO_LABEL[x]}</option>)}
          </Select>
        </Campo>
        <Campo label="Referencia"><Input value={f.referencia} onChange={(e) => setF({ ...f, referencia: e.target.value })} /></Campo>
      </div>
    </Modal>
  );
}

function ModalArqueo({ esperado, onCerrar }: { esperado: number; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [cant, setCant] = useState<Record<string, number>>({});
  const [otros, setOtros] = useState(0);
  const [notas, setNotas] = useState('');
  const contado = totalConteo(cant) + otros;
  const dif = contado - esperado;
  const m = useMutation({
    mutationFn: () => api.post('/caja/arqueos', { contado, detalle: cant, notas: notas || null }),
    onSuccess: () => {
      invalidarDinero(qc);
      toast.ok('Arqueo registrado');
      onCerrar();
    },
    onError: toast.error,
  });
  return (
    <Modal abierto onCerrar={onCerrar} titulo="Arqueo de caja" ancho="lg" pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" cargando={m.isPending} onClick={() => m.mutate()}>Guardar arqueo</Boton></>}>
      <div className="space-y-4">
        <p className="text-sm text-tenue">Contá el efectivo de la caja. El arqueo queda registrado pero <strong>no cierra</strong> la caja.</p>
        <ConteoEfectivo cantidades={cant} onChange={setCant} />
        <Campo label="Otros importes en efectivo (monedas sueltas, vales…)"><InputMoneda value={otros} onChange={setOtros} /></Campo>
        <div className="grid grid-cols-3 gap-3 rounded-xl bg-slate-50 p-3 text-center text-sm">
          <div><div className="text-xs text-tenue">Esperado</div><div className="font-semibold tabular-nums">{money(esperado)}</div></div>
          <div><div className="text-xs text-tenue">Contado</div><div className="font-semibold tabular-nums">{money(contado)}</div></div>
          <div><div className="text-xs text-tenue">Diferencia</div><div className={dif === 0 ? 'font-semibold text-emerald-700' : 'font-semibold text-red-600'}>{money(dif)}</div></div>
        </div>
        <Campo label="Notas"><Input value={notas} onChange={(e) => setNotas(e.target.value)} /></Campo>
      </div>
    </Modal>
  );
}

function ModalCierre({ sesion, onCerrar }: { sesion: NonNullable<ReturnType<typeof useEstadoCaja>['data']>['sesion']; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const s = sesion!;
  const [cant, setCant] = useState<Record<string, number>>({});
  const [otros, setOtros] = useState(0);
  const [notas, setNotas] = useState('');
  const [declarados, setDeclarados] = useState<Record<string, number | null>>({});
  const esperado = s.resumen.efectivo_esperado;
  const contado = totalConteo(cant) + otros;
  const dif = contado - esperado;
  const otrosMedios = s.resumen.por_medio.filter((x) => x.medio !== 'efectivo');
  const m = useMutation({
    mutationFn: () =>
      api.post('/caja/cerrar', {
        declarados: [{ medio: 'efectivo', importe: contado }, ...otrosMedios.map((x) => ({ medio: x.medio, importe: declarados[x.medio] ?? x.neto }))],
        esperado_visto: esperado,
        notas: notas || null,
      }),
    onSuccess: () => {
      invalidarDinero(qc);
      toast.ok('Caja cerrada');
      onCerrar();
    },
    onError: (e) => {
      invalidarDinero(qc);
      toast.error(e);
    },
  });
  const valido = dif === 0 || notas.trim().length >= 3;
  return (
    <Modal abierto onCerrar={onCerrar} titulo={`Cerrar caja #${s.numero}`} ancho="xl" pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="peligro" icono={<Lock className="size-4" />} disabled={!valido} cargando={m.isPending} onClick={() => m.mutate()}>Cerrar caja</Boton></>}>
      <div className="space-y-5">
        <div>
          <h3 className="mb-2 text-sm font-semibold">Efectivo contado</h3>
          <ConteoEfectivo cantidades={cant} onChange={setCant} />
          <Campo label="Otros importes en efectivo" className="mt-3 sm:max-w-xs"><InputMoneda value={otros} onChange={setOtros} /></Campo>
        </div>
        <div className="grid grid-cols-3 gap-3 rounded-xl bg-slate-50 p-3 text-center text-sm">
          <div><div className="text-xs text-tenue">Esperado (inicial {money(s.saldo_inicial)} + movimientos)</div><div className="font-semibold tabular-nums">{money(esperado)}</div></div>
          <div><div className="text-xs text-tenue">Declarado</div><div className="font-semibold tabular-nums">{money(contado)}</div></div>
          <div><div className="text-xs text-tenue">Diferencia</div><div className={dif === 0 ? 'font-semibold text-emerald-700' : 'font-semibold text-red-600'}>{money(dif)}</div></div>
        </div>
        {otrosMedios.length > 0 && (
          <div>
            <h3 className="mb-1 text-sm font-semibold">Otros medios de pago</h3>
            <p className="mb-2 text-xs text-tenue">Para conciliar con el extracto bancario o el posnet. Si no cambiás el importe se toma el esperado.</p>
            <div className="space-y-2">
              {otrosMedios.map((x) => (
                <div key={x.medio} className="grid grid-cols-[1fr_auto_160px] items-center gap-3 text-sm">
                  <span>{MEDIO_PAGO_LABEL[x.medio as MedioPago]}</span>
                  <span className="text-tenue">esperado {money(x.neto)}</span>
                  <InputMoneda value={declarados[x.medio] ?? x.neto} onChange={(v) => setDeclarados({ ...declarados, [x.medio]: v })} />
                </div>
              ))}
            </div>
          </div>
        )}
        <Campo label={dif !== 0 ? 'Justificación de la diferencia (obligatoria)' : 'Notas del cierre'} requerido={dif !== 0}>
          <Textarea rows={2} value={notas} onChange={(e) => setNotas(e.target.value)} />
        </Campo>
        {dif !== 0 && <Aviso tono="ambar">El efectivo contado no coincide con el esperado. Revisá el conteo; si es correcto, explicá la diferencia para cerrar.</Aviso>}
      </div>
    </Modal>
  );
}

// ───────────── Hoy ─────────────
const TONO_RUBRO: Record<string, 'verde' | 'rojo' | 'azul' | 'gris'> = { cobro: 'verde', otro_ingreso: 'azul', pago_proveedor: 'rojo', gasto: 'rojo', devolucion: 'rojo' };

function TablaMovimientos({ filas, puedeAnular, onAnular }: { filas: any[]; puedeAnular?: boolean; onAnular?: (m: any) => void }) {
  const link = (m: any) =>
    m.ref_tipo === 'cobro' ? <Link className="text-marca-700" to={`/cobros?ver=${m.ref_id}`}>{m.concepto}</Link>
    : m.ref_tipo === 'gasto' ? <Link className="text-marca-700" to="/finanzas?tab=gastos">{m.concepto}</Link>
    : m.ref_tipo === 'pago_proveedor' ? <span>{m.concepto}</span>
    : <span>{m.concepto}</span>;
  return (
    <Tabla
      filas={filas}
      clave={(m) => m.id}
      vacio={<Vacio icono={<Banknote className="size-5" />} titulo="Sin movimientos" texto="Los cobros, pagos y gastos aparecen acá apenas se registran." />}
      columnas={[
        { clave: 'h', titulo: 'Hora', render: (m) => <span className="tabular-nums">{fechaHora(m.created_at)}</span>, movil: 'meta' },
        { clave: 'c', titulo: 'Concepto', render: (m) => <span className={m.origen_tipo === 'reverso' ? 'italic' : ''}>{link(m)}{m.revertido ? <Insignia tono="gris" className="ml-2">Anulado</Insignia> : null}</span>, movil: 'titulo' },
        { clave: 'r', titulo: 'Rubro', render: (m) => <Insignia tono={TONO_RUBRO[m.rubro] ?? 'gris'}>{RUBRO_CAJA_LABEL[m.rubro as RubroCaja]}</Insignia>, movil: 'subtitulo' },
        { clave: 'm', titulo: 'Medio', render: (m) => MEDIO_PAGO_LABEL[m.medio as MedioPago], movil: 'meta' },
        { clave: 'u', titulo: 'Usuario', render: (m) => m.usuario ?? '—', movil: 'oculta' },
        { clave: 'i', titulo: 'Ingreso', alinear: 'derecha', render: (m) => (m.tipo === 'ingreso' ? <span className="font-medium text-emerald-700">{money(m.importe)}</span> : ''), movil: 'oculta' },
        { clave: 'e', titulo: 'Egreso', alinear: 'derecha', render: (m) => (m.tipo === 'egreso' ? <span className="font-medium text-red-600">{money(m.importe)}</span> : ''), movil: 'oculta' },
        { clave: 'n', titulo: 'Importe', alinear: 'derecha', render: (m) => <span className={m.tipo === 'egreso' ? 'font-medium text-red-600' : 'font-medium text-emerald-700'}>{m.tipo === 'egreso' ? '−' : '+'}{money(m.importe)}</span>, movil: 'derecha', className: 'md:hidden' },
        {
          clave: 'a', titulo: '',
          render: (m) => puedeAnular && m.origen_tipo === 'manual' && !m.revertido ? <Boton tam="sm" variante="fantasma" icono={<Ban className="size-4" />} onClick={() => onAnular?.(m)}>Anular</Boton> : null,
          movil: 'meta',
        },
      ]}
    />
  );
}

function CajaHoy() {
  const { puede } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useEstadoCaja();
  const [modal, setModal] = useState<null | 'abrir' | 'ingreso' | 'gasto' | 'arqueo' | 'cerrar'>(null);
  const [q, setQ] = useState('');
  const [tipo, setTipo] = useState('');
  const [medio, setMedio] = useState('');
  const [anular, setAnular] = useState<any | null>(null);
  const [motivo, setMotivo] = useState('');
  const dq = useDebounce(q);
  const sesion = data?.sesion;
  const { data: movs = [], isLoading: cargandoMovs } = useQuery({
    queryKey: ['caja', 'movimientos', { id: sesion?.id, dq, tipo, medio }],
    queryFn: () => api.get<any[]>(`/caja/movimientos${qs({ sesion_id: sesion?.id, q: dq, tipo, medio })}`),
    enabled: !!sesion,
  });
  const m = useMutation({
    mutationFn: () => api.post(`/caja/movimientos/${anular.id}/anular`, { motivo }),
    onSuccess: () => {
      invalidarDinero(qc);
      toast.ok('Movimiento anulado');
      setAnular(null);
      setMotivo('');
    },
    onError: toast.error,
  });
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;

  if (!sesion) {
    return (
      <>
        <Tarjeta>
          <Vacio
            icono={<Lock className="size-5" />}
            titulo="La caja está cerrada"
            texto={data!.obligatoria ? 'Este taller exige caja abierta para registrar cobros, pagos y gastos.' : 'Abrí la caja para empezar la jornada: los cobros, pagos y gastos quedarán asentados en ella y podrás hacer el arqueo y el cierre.'}
            accion={<Boton variante="primario" tam="lg" icono={<Unlock className="size-5" />} onClick={() => setModal('abrir')}>Abrir caja</Boton>}
          />
          {data!.ultima_cierre && <p className="border-t border-borde px-4 py-3 text-center text-sm text-tenue">Última caja cerrada: #{numero(data!.ultima_cierre.numero)}{data!.ultima_cierre.cerrada_at ? ` el ${fecha(data!.ultima_cierre.cerrada_at)}` : ''}.</p>}
        </Tarjeta>
        {data!.sin_caja_hoy > 0 && <Aviso tono="ambar" className="mt-4">Hay {data!.sin_caja_hoy} movimiento(s) de hoy registrados sin caja abierta. Figuran en los reportes pero no en ningún arqueo.</Aviso>}
        {modal === 'abrir' && <ModalApertura sugerido={data!.ultima_cierre?.efectivo_declarado ?? 0} onCerrar={() => setModal(null)} />}
      </>
    );
  }

  const r = sesion.resumen;
  const ing = r.por_medio.reduce((a, x) => a + x.ingresos, 0);
  const egr = r.por_medio.reduce((a, x) => a + x.egresos, 0);
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-semibold"><Insignia tono="verde">Abierta</Insignia> Caja #{numero(sesion.numero)}</div>
          <div className="text-sm text-tenue">Abierta por {sesion.abierta_por_nombre ?? '—'} el {fechaHora(sesion.abierta_at)} · efectivo inicial {money(sesion.saldo_inicial)}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Boton icono={<Plus className="size-4" />} onClick={() => setModal('ingreso')}>Ingreso</Boton>
          <Boton icono={<Receipt className="size-4" />} onClick={() => setModal('gasto')}>Gasto</Boton>
          <Boton icono={<Calculator className="size-4" />} onClick={() => setModal('arqueo')}>Arqueo</Boton>
          <Boton variante="primario" icono={<Lock className="size-4" />} onClick={() => setModal('cerrar')}>Cerrar caja</Boton>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Indicador titulo="Efectivo esperado" valor={money(r.efectivo_esperado)} detalle="Inicial + movimientos en efectivo" icono={<Banknote className="size-5" />} tono="verde" />
        <Indicador titulo="Ingresos" valor={money(ing)} icono={<Wallet className="size-5" />} tono="azul" />
        <Indicador titulo="Egresos" valor={money(egr)} icono={<Receipt className="size-5" />} tono="rojo" />
        <Indicador titulo="Movimientos" valor={r.movimientos} icono={<Calculator className="size-5" />} tono="gris" />
      </div>

      <div className="mt-5 space-y-5">
        <Tarjeta titulo="Por medio de pago" sinPadding>
          {r.por_medio.length === 0 ? <p className="px-4 py-6 text-center text-sm text-tenue">Sin movimientos todavía</p> : (
            <ul className="flex flex-wrap divide-x divide-borde text-sm">
              {r.por_medio.map((x) => (
                <li key={x.medio} className="flex min-w-60 flex-1 items-center justify-between gap-3 px-4 py-2.5">
                  <div>
                    <div className="font-medium">{MEDIO_PAGO_LABEL[x.medio as MedioPago]}</div>
                    <div className="text-xs text-tenue tabular-nums">+{money(x.ingresos)} · −{money(x.egresos)}</div>
                  </div>
                  <div className="font-semibold tabular-nums">{money(x.neto)}</div>
                </li>
              ))}
            </ul>
          )}
        </Tarjeta>
        <Tarjeta titulo="Movimientos de esta caja" sinPadding>
          <div className="flex flex-wrap items-center gap-2 border-b border-borde p-3">
            <Buscador value={q} onChange={setQ} placeholder="Buscar concepto o referencia" className="min-w-48 flex-1" />
            <Select value={tipo} onChange={(e) => setTipo(e.target.value)} className="w-auto" aria-label="Tipo"><option value="">Ingresos y egresos</option><option value="ingreso">Sólo ingresos</option><option value="egreso">Sólo egresos</option></Select>
            <Select value={medio} onChange={(e) => setMedio(e.target.value)} className="w-auto" aria-label="Medio"><option value="">Todos los medios</option>{MEDIOS_PAGO.map((x) => <option key={x} value={x}>{MEDIO_PAGO_LABEL[x]}</option>)}</Select>
          </div>
          {cargandoMovs ? <Cargando /> : <TablaMovimientos filas={movs} puedeAnular={puede('gastos.gestionar')} onAnular={setAnular} />}
        </Tarjeta>
      </div>

      {modal === 'ingreso' && <ModalIngreso onCerrar={() => setModal(null)} />}
      {modal === 'gasto' && <ModalGasto onCerrar={() => setModal(null)} />}
      {modal === 'arqueo' && <ModalArqueo esperado={r.efectivo_esperado} onCerrar={() => setModal(null)} />}
      {modal === 'cerrar' && <ModalCierre sesion={sesion} onCerrar={() => setModal(null)} />}
      <Modal abierto={!!anular} onCerrar={() => setAnular(null)} titulo="Anular ingreso manual" ancho="sm" pie={<><Boton onClick={() => setAnular(null)}>Cancelar</Boton><Boton variante="peligro" disabled={motivo.trim().length < 3} cargando={m.isPending} onClick={() => m.mutate()}>Anular</Boton></>}>
        <div className="space-y-3">
          <p className="text-sm text-tenue">Se registra un contra-asiento por {anular ? money(anular.importe) : ''}; el movimiento original queda en el historial.</p>
          <Campo label="Motivo" requerido><Input value={motivo} onChange={(e) => setMotivo(e.target.value)} autoFocus /></Campo>
        </div>
      </Modal>
    </>
  );
}

// ───────────── Historial ─────────────
function DetalleSesion({ id, onCerrar }: { id: string; onCerrar: () => void }) {
  const { data: s } = useQuery({ queryKey: ['caja', 'sesion', id], queryFn: () => api.get(`/caja/sesiones/${id}`) });
  const { data: movs = [] } = useQuery({ queryKey: ['caja', 'movimientos', { sesion: id }], queryFn: () => api.get<any[]>(`/caja/movimientos?sesion_id=${id}&limite=500`) });
  return (
    <Modal abierto onCerrar={onCerrar} titulo={s ? `Caja #${numero(s.numero)} · ${fecha(s.fecha)}` : 'Caja'} ancho="xl">
      {!s ? <Cargando /> : (
        <div className="space-y-5">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Dato etiqueta="Abrió">{s.abierta_por_nombre}<div className="text-xs text-tenue">{fechaHora(s.abierta_at)}</div></Dato>
            <Dato etiqueta="Cerró">{s.cerrada_por_nombre ?? (s.estado === 'abierta' ? 'Abierta' : '—')}<div className="text-xs text-tenue">{s.cerrada_at ? fechaHora(s.cerrada_at) : ''}</div></Dato>
            <Dato etiqueta="Efectivo inicial">{money(s.saldo_inicial)}</Dato>
            <Dato etiqueta="Diferencia"><Diferencia valor={s.diferencia} /></Dato>
          </dl>
          {s.estado === 'cerrada' && (
            <div>
              <h3 className="mb-2 text-sm font-semibold">Cierre: esperado vs. declarado</h3>
              <table className="w-full text-sm">
                <thead><tr className="border-b border-borde text-left text-xs uppercase text-tenue"><th className="py-2">Medio</th><th className="py-2 text-right">Esperado</th><th className="py-2 text-right">Declarado</th><th className="py-2 text-right">Diferencia</th></tr></thead>
                <tbody>{s.cierre.map((c: any) => <tr key={c.medio} className="border-b border-borde last:border-0"><td className="py-2">{MEDIO_PAGO_LABEL[c.medio as MedioPago]}</td><td className="py-2 text-right tabular-nums">{money(c.esperado)}</td><td className="py-2 text-right tabular-nums">{money(c.declarado)}</td><td className="py-2 text-right tabular-nums">{money(c.diferencia)}</td></tr>)}</tbody>
              </table>
              {s.notas_cierre && <p className="mt-2 text-sm"><span className="font-medium">Notas del cierre:</span> {s.notas_cierre}</p>}
            </div>
          )}
          {s.arqueos.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold">Arqueos durante la jornada</h3>
              <ul className="divide-y divide-borde rounded-lg border border-borde text-sm">
                {s.arqueos.map((a: any) => <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"><span>{fechaHora(a.created_at)} · {a.usuario ?? '—'}</span><span className="tabular-nums">esperado {money(a.esperado)} · contado {money(a.contado)}</span><Diferencia valor={a.diferencia} /></li>)}
              </ul>
            </div>
          )}
          <div>
            <h3 className="mb-2 text-sm font-semibold">Movimientos ({movs.length})</h3>
            <div className="rounded-xl border border-borde"><TablaMovimientos filas={movs} /></div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Historial() {
  const [desde, setDesde] = useState(sumarDias(hoyISO(), -30));
  const [hasta, setHasta] = useState(hoyISO());
  const [conDif, setConDif] = useState(false);
  const [ver, setVer] = useState<string | null>(null);
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['caja', 'sesiones', { desde, hasta, conDif }], queryFn: () => api.get<any[]>(`/caja/sesiones${qs({ desde, hasta, con_diferencia: conDif })}`) });
  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Campo label="Desde"><Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} /></Campo>
        <Campo label="Hasta"><Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} /></Campo>
        <label className="mb-2 flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-marca-600" checked={conDif} onChange={(e) => setConDif(e.target.checked)} /> Sólo con diferencias</label>
      </div>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={data}
            clave={(s) => s.id}
            onFila={(s) => setVer(s.id)}
            vacio={<Vacio icono={<Lock className="size-5" />} titulo="Sin cajas en el período" />}
            columnas={[
              { clave: 'n', titulo: 'N°', render: (s) => <span className="font-medium">#{numero(s.numero)}</span>, movil: 'titulo' },
              { clave: 'f', titulo: 'Fecha', render: (s) => fecha(s.fecha), movil: 'subtitulo' },
              { clave: 'a', titulo: 'Abrió', render: (s) => s.abierta_por_nombre ?? '—', movil: 'meta' },
              { clave: 'c', titulo: 'Cerró', render: (s) => s.cerrada_por_nombre ?? (s.estado === 'abierta' ? <Insignia tono="verde">Abierta</Insignia> : '—'), movil: 'meta' },
              { clave: 'i', titulo: 'Inicial', alinear: 'derecha', render: (s) => money(s.saldo_inicial), movil: 'oculta' },
              { clave: 'e', titulo: 'Esperado', alinear: 'derecha', render: (s) => (s.efectivo_esperado != null ? money(s.efectivo_esperado) : '—'), movil: 'oculta' },
              { clave: 'd', titulo: 'Declarado', alinear: 'derecha', render: (s) => (s.efectivo_declarado != null ? money(s.efectivo_declarado) : '—'), movil: 'oculta' },
              { clave: 'x', titulo: 'Diferencia', alinear: 'derecha', render: (s) => <Diferencia valor={s.diferencia} />, movil: 'derecha' },
            ]}
          />
        </Tarjeta>
      )}
      {ver && <DetalleSesion id={ver} onCerrar={() => setVer(null)} />}
    </>
  );
}

// ───────────── Reportes ─────────────
function Reportes() {
  const [desde, setDesde] = useState(sumarDias(hoyISO(), -30));
  const [hasta, setHasta] = useState(hoyISO());
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['caja', 'reportes', { desde, hasta }], queryFn: () => api.get(`/caja/reportes?desde=${desde}&hasta=${hasta}`) });
  const exportar = () => {
    if (!data) return;
    descargarCSV(
      `caja-${desde}_${hasta}`,
      ['Fecha', 'Ingresos', 'Egresos', 'Neto'],
      data.por_dia.map((d: any) => [d.fecha, pesosCSV(d.ingresos), pesosCSV(d.egresos), pesosCSV(d.ingresos - d.egresos)]),
    );
  };
  const tabla = (titulo: string, filas: any[], etiqueta: (f: any) => string) => (
    <Tarjeta titulo={titulo} sinPadding>
      {filas.length === 0 ? <p className="px-4 py-6 text-center text-sm text-tenue">Sin datos</p> : (
        <table className="w-full text-sm">
          <thead><tr className="border-b border-borde text-left text-xs uppercase text-tenue"><th className="px-4 py-2" /><th className="px-2 py-2 text-right">Ingresos</th><th className="px-2 py-2 text-right">Egresos</th><th className="px-4 py-2 text-right">Neto</th></tr></thead>
          <tbody>
            {filas.map((f, i) => {
              const ing = f.ingresos ?? Math.max(f.neto, 0);
              const egr = f.egresos ?? Math.max(-f.neto, 0);
              return <tr key={i} className="border-b border-borde last:border-0"><td className="px-4 py-2">{etiqueta(f)}</td><td className="px-2 py-2 text-right tabular-nums">{money(ing)}</td><td className="px-2 py-2 text-right tabular-nums">{money(egr)}</td><td className="px-4 py-2 text-right font-medium tabular-nums">{money(f.neto ?? ing - egr)}</td></tr>;
            })}
          </tbody>
        </table>
      )}
    </Tarjeta>
  );
  const dias = useMemo(() => (data?.por_dia ?? []).map((d: any) => ({ ...d, neto: d.ingresos - d.egresos })), [data]);
  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Campo label="Desde"><Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} /></Campo>
        <Campo label="Hasta"><Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} /></Campo>
        <Boton icono={<Download className="size-4" />} disabled={!data} onClick={exportar}>Exportar CSV</Boton>
      </div>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Indicador titulo="Ingresos" valor={money(data.totales.ingresos)} tono="verde" />
            <Indicador titulo="Egresos" valor={money(data.totales.egresos)} tono="rojo" />
            <Indicador titulo="Neto" valor={money(data.totales.ingresos - data.totales.egresos)} />
            <Indicador titulo="Diferencias de caja" valor={money(data.diferencia_total)} detalle={`${data.sesiones.length} caja(s)`} tono={data.diferencia_total === 0 ? 'gris' : 'ambar'} />
          </div>
          {data.totales.sin_caja > 0 && <Aviso tono="ambar">{data.totales.sin_caja} movimiento(s) del período se registraron sin caja abierta.</Aviso>}
          <div className="grid gap-5 lg:grid-cols-2">
            {tabla('Por medio de pago', data.por_medio, (f) => MEDIO_PAGO_LABEL[f.medio as MedioPago])}
            {tabla('Por rubro (neto de anulaciones)', data.por_rubro, (f) => RUBRO_CAJA_LABEL[f.rubro as RubroCaja])}
            {tabla('Por usuario', data.por_usuario, (f) => `${f.usuario} (${f.movimientos})`)}
            {tabla('Por día', dias, (f) => fecha(f.fecha))}
          </div>
        </div>
      )}
    </>
  );
}

export function Caja() {
  const { puede } = useAuth();
  const [tab, setTab] = useState<'hoy' | 'historial' | 'reportes'>('hoy');
  const tabs = [{ clave: 'hoy' as const, titulo: 'Caja de hoy' }, ...(puede('finanzas.ver') ? [{ clave: 'historial' as const, titulo: 'Historial' }, { clave: 'reportes' as const, titulo: 'Reportes' }] : [])];
  return (
    <>
      <Encabezado titulo="Caja" subtitulo="Apertura, movimientos de efectivo y medios de pago, arqueo y cierre" />
      {tabs.length > 1 && <Pestanas items={tabs} activo={tab} onCambio={setTab} />}
      {tab === 'hoy' && <CajaHoy />}
      {tab === 'historial' && <Historial />}
      {tab === 'reportes' && <Reportes />}
    </>
  );
}
