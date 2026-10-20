// Registro de cobros: varias formas de pago aplicadas a uno o más comprobantes pendientes, con pagos parciales.
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CheckCircle2, Plus, Printer, Trash2 } from 'lucide-react';
import { api, nuevaClave } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { invalidarDinero, useEstadoCaja } from '@/lib/caja';
import { fecha, hoyISO, money, numero } from '@/lib/format';
import { MEDIOS_PAGO, MEDIO_PAGO_LABEL, type MedioPago } from '@shared/dominio';
import { Aviso, Boton, Campo, Check, Input, InputMoneda, Modal, Select, useToast } from './ui';

/** Aviso (y bloqueo) cuando el taller exige caja abierta para registrar movimientos de dinero. */
export function AvisoCaja() {
  const { data } = useEstadoCaja();
  if (!data?.obligatoria || data.sesion) return null;
  return (
    <Aviso tono="rojo">
      La caja está cerrada y este taller exige caja abierta para cobrar. <Link className="font-semibold underline" to="/caja">Abrir la caja</Link>
    </Aviso>
  );
}
export function useCajaBloqueada() {
  const { data } = useEstadoCaja();
  return !!data?.obligatoria && !data.sesion;
}

function FormaPago({ x, onChange, onQuitar, soloUna }: { x: { medio: MedioPago; importe: number; referencia: string }; onChange: (v: { medio: MedioPago; importe: number; referencia: string }) => void; onQuitar: () => void; soloUna: boolean }) {
  return (
    <div className="grid grid-cols-[1fr_140px_auto] gap-2 sm:grid-cols-[180px_1fr_160px_auto]">
      <Select value={x.medio} onChange={(e) => onChange({ ...x, medio: e.target.value as MedioPago })} aria-label="Medio de pago">
        {MEDIOS_PAGO.map((mp) => <option key={mp} value={mp}>{MEDIO_PAGO_LABEL[mp]}</option>)}
      </Select>
      <Input
        className="col-span-3 row-start-2 sm:col-span-1 sm:row-start-auto"
        placeholder={x.medio === 'cheque' ? 'N° de cheque (obligatorio)' : 'Referencia (N° de operación…)'}
        value={x.referencia}
        onChange={(e) => onChange({ ...x, referencia: e.target.value })}
        aria-label="Referencia"
      />
      <InputMoneda value={x.importe} onChange={(v) => onChange({ ...x, importe: v })} />
      <Boton variante="fantasma" disabled={soloUna} onClick={onQuitar} icono={<Trash2 className="size-4" />} aria-label="Quitar forma de pago" />
    </div>
  );
}

export function ModalCobro({ abierto, onCerrar, clienteId, ventaId }: { abierto: boolean; onCerrar: () => void; clienteId: string; ventaId?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useAuth();
  const bloqueada = useCajaBloqueada();
  const { data } = useQuery({ queryKey: ['cuenta', clienteId], queryFn: () => api.get(`/cuentas-corrientes/${clienteId}`), enabled: abierto });
  const pendientes: any[] = data?.pendientes ?? [];
  const [sel, setSel] = useState<Record<string, number>>({});
  const [medios, setMedios] = useState<Array<{ medio: MedioPago; importe: number; referencia: string }>>([{ medio: 'efectivo', importe: 0, referencia: '' }]);
  const [fechaCobro, setFecha] = useState(hoyISO());
  const [notas, setNotas] = useState('');
  const [monto, setMonto] = useState(0);
  const [hecho, setHecho] = useState<{ id: string; numero: number } | null>(null);
  // La clave de idempotencia se genera al abrir el formulario: un doble clic o un reintento no duplica el cobro.
  const [clave, setClave] = useState(nuevaClave());

  useEffect(() => {
    if (!abierto || !pendientes.length) return;
    const inicial: Record<string, number> = {};
    for (const p of pendientes) if (!ventaId || p.id === ventaId) inicial[p.id] = p.saldo;
    setSel(inicial);
    const total = Object.values(inicial).reduce((a, b) => a + b, 0);
    setMedios([{ medio: 'efectivo', importe: total, referencia: '' }]);
    setMonto(total);
    setClave(nuevaClave());
  }, [abierto, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const aplicado = useMemo(() => Object.values(sel).reduce((a, b) => a + b, 0), [sel]);
  const pagado = medios.reduce((a, m) => a + m.importe, 0);
  const saldoTotal = pendientes.reduce((a, p) => a + p.saldo, 0);
  const chequeSinNumero = medios.some((m) => m.medio === 'cheque' && !m.referencia.trim());
  const valido = aplicado > 0 && aplicado === pagado && medios.every((m) => m.importe > 0) && !chequeSinNumero && !bloqueada;

  /** Reparte un monto entre los comprobantes empezando por el más antiguo (los pendientes llegan ordenados por fecha). */
  const distribuir = (importe: number) => {
    let resto = importe;
    const nuevo: Record<string, number> = {};
    for (const p of pendientes) {
      if (resto <= 0) break;
      const parte = Math.min(resto, p.saldo);
      nuevo[p.id] = parte;
      resto -= parte;
    }
    setSel(nuevo);
    const total = importe - resto;
    setMedios(medios.length === 1 ? [{ ...medios[0], importe: total }] : medios);
  };

  const m = useMutation({
    mutationFn: () =>
      api.post('/cobros', {
        cliente_id: clienteId,
        fecha: fechaCobro,
        notas,
        idem_key: clave,
        medios: medios.map((x) => ({ ...x, referencia: x.referencia.trim() || null })),
        aplicaciones: Object.entries(sel).filter(([, v]) => v > 0).map(([venta_id, importe]) => ({ venta_id, importe })),
      }),
    onSuccess: (r) => {
      invalidarDinero(qc);
      toast.ok(r.duplicado ? 'El cobro ya estaba registrado' : `Cobro #${numero(r.numero)} registrado`);
      setHecho({ id: r.id, numero: r.numero });
    },
    onError: toast.error,
  });

  if (hecho) {
    return (
      <Modal abierto={abierto} onCerrar={onCerrar} titulo="Cobro registrado" ancho="sm" pie={<><Boton onClick={onCerrar}>Cerrar</Boton><Boton variante="primario" icono={<Printer className="size-4" />} onClick={() => window.open(`/imprimir/recibo/${hecho.id}`, '_blank')}>Imprimir recibo</Boton></>}>
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <CheckCircle2 className="size-10 text-emerald-600" />
          <p className="font-semibold">Recibo N° {numero(hecho.numero)}</p>
          <p className="text-sm text-tenue">El importe quedó asentado en la cuenta del cliente y en la caja.</p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      abierto={abierto}
      onCerrar={onCerrar}
      titulo="Registrar cobro"
      ancho="lg"
      pie={
        <>
          <Boton onClick={onCerrar}>Cancelar</Boton>
          <Boton variante="exito" disabled={!valido} cargando={m.isPending} onClick={() => m.mutate()}>Cobrar {money(aplicado)}</Boton>
        </>
      }
    >
      {!data ? (
        <p className="text-sm text-tenue">Cargando…</p>
      ) : pendientes.length === 0 ? (
        <Aviso tono="verde">El cliente no tiene comprobantes pendientes de cobro.</Aviso>
      ) : (
        <div className="space-y-5">
          <AvisoCaja />
          <div>
            <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
              <h3 className="text-sm font-semibold">Comprobantes a cancelar</h3>
              {!ventaId && pendientes.length > 1 && (
                <div className="flex items-end gap-2">
                  <Campo label="Pago de un monto (se imputa al más antiguo)"><InputMoneda value={monto} onChange={setMonto} className="w-44" /></Campo>
                  <Boton disabled={monto <= 0} onClick={() => distribuir(Math.min(monto, saldoTotal))}>Distribuir</Boton>
                </div>
              )}
            </div>
            <ul className="divide-y divide-borde rounded-lg border border-borde">
              {pendientes.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <Check
                    checked={p.id in sel}
                    onChange={(v) => {
                      const n: Record<string, number> = { ...sel };
                      if (v) n[p.id] = p.saldo;
                      else delete n[p.id];
                      setSel(n);
                      const total = Object.values(n).reduce((a, b) => a + b, 0);
                      if (medios.length === 1) setMedios([{ ...medios[0], importe: total }]);
                    }}
                    label={
                      <span>
                        <span className="font-medium">Comprobante #{numero(p.numero)}</span>
                        <span className="text-tenue"> · {fecha(p.fecha)}{p.orden_numero ? ` · OT #${numero(p.orden_numero)}` : ''} · saldo {money(p.saldo)}</span>
                      </span>
                    }
                  />
                  {p.id in sel && (
                    <div className="flex items-center gap-2">
                      <InputMoneda
                        value={sel[p.id]}
                        onChange={(v) => {
                          const n: Record<string, number> = { ...sel, [p.id]: Math.min(v, p.saldo) };
                          setSel(n);
                          const total = Object.values(n).reduce((a, b) => a + b, 0);
                          if (medios.length === 1) setMedios([{ ...medios[0], importe: total }]);
                        }}
                        className="w-40"
                      />
                      {sel[p.id] < p.saldo && <span className="text-xs text-amber-700">Queda {money(p.saldo - sel[p.id])}</span>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-xs text-tenue">Saldo total del cliente: {money(saldoTotal)}. Tras este cobro quedará {money(saldoTotal - aplicado)}.</p>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold">Formas de pago</h3>
            <div className="space-y-2">
              {medios.map((x, i) => (
                <FormaPago key={i} x={x} soloUna={medios.length === 1} onChange={(v) => setMedios(medios.map((y, j) => (j === i ? v : y)))} onQuitar={() => setMedios(medios.filter((_, j) => j !== i))} />
              ))}
              <Boton tam="sm" variante="fantasma" icono={<Plus className="size-4" />} onClick={() => setMedios([...medios, { medio: 'transferencia', importe: Math.max(0, aplicado - pagado), referencia: '' }])}>Agregar forma de pago</Boton>
            </div>
            {aplicado !== pagado && <p className="mt-2 text-sm text-red-600">Las formas de pago suman {money(pagado)} y lo aplicado es {money(aplicado)}.</p>}
            {chequeSinNumero && <p className="mt-2 text-sm text-red-600">Indicá el número de cheque.</p>}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Campo label="Fecha" hint={puede('fechas.retroactivas') ? undefined : 'Sólo se puede registrar con la fecha de hoy'}>
              <Input type="date" value={fechaCobro} max={hoyISO()} disabled={!puede('fechas.retroactivas')} onChange={(e) => setFecha(e.target.value)} />
            </Campo>
            <Campo label="Notas">
              <Input value={notas} onChange={(e) => setNotas(e.target.value)} />
            </Campo>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Confirmación de "emitir y cobrar" un comprobante recién generado (OT lista para entregar). */
export function ModalEmitirCobrar({ total, cargando, onCerrar, onConfirmar }: { total: number; cargando?: boolean; onCerrar: () => void; onConfirmar: (cobro: { medio: string; referencia: string | null }) => void }) {
  const [medio, setMedio] = useState<MedioPago>('efectivo');
  const [ref, setRef] = useState('');
  const bloqueada = useCajaBloqueada();
  const falta = medio === 'cheque' && !ref.trim();
  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo="Emitir comprobante y cobrar"
      ancho="sm"
      pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="exito" disabled={falta || bloqueada} cargando={cargando} onClick={() => onConfirmar({ medio, referencia: ref.trim() || null })}>Cobrar {money(total)}</Boton></>}
    >
      <div className="space-y-3">
        <AvisoCaja />
        <p className="text-sm text-tenue">Se emite el comprobante interno y se registra el cobro del total en un solo paso.</p>
        <Campo label="Medio de pago">
          <Select value={medio} onChange={(e) => setMedio(e.target.value as MedioPago)}>
            {MEDIOS_PAGO.map((x) => <option key={x} value={x}>{MEDIO_PAGO_LABEL[x]}</option>)}
          </Select>
        </Campo>
        <Campo label={medio === 'cheque' ? 'N° de cheque' : 'Referencia (opcional)'} requerido={medio === 'cheque'}>
          <Input value={ref} onChange={(e) => setRef(e.target.value)} />
        </Campo>
      </div>
    </Modal>
  );
}
