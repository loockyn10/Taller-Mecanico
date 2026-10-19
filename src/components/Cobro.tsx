// Registro de cobros: varias formas de pago aplicadas a uno o más comprobantes pendientes.
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api, nuevaClave } from '@/lib/api';
import { fecha, hoyISO, money, numero } from '@/lib/format';
import { MEDIOS_PAGO, MEDIO_PAGO_LABEL, type MedioPago } from '@shared/dominio';
import { Aviso, Boton, Campo, Check, Input, InputMoneda, Modal, Select, useToast } from './ui';

export function ModalCobro({ abierto, onCerrar, clienteId, ventaId }: { abierto: boolean; onCerrar: () => void; clienteId: string; ventaId?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['cuenta', clienteId], queryFn: () => api.get(`/cuentas-corrientes/${clienteId}`), enabled: abierto });
  const pendientes: any[] = data?.pendientes ?? [];
  const [sel, setSel] = useState<Record<string, number>>({});
  const [medios, setMedios] = useState<Array<{ medio: MedioPago; importe: number; referencia: string }>>([{ medio: 'efectivo', importe: 0, referencia: '' }]);
  const [fechaCobro, setFecha] = useState(hoyISO());
  const [notas, setNotas] = useState('');
  // La clave de idempotencia se genera al abrir el formulario: un doble clic o un reintento no duplica el cobro.
  const [clave, setClave] = useState(nuevaClave());

  useEffect(() => {
    if (!abierto || !pendientes.length) return;
    const inicial: Record<string, number> = {};
    for (const p of pendientes) if (!ventaId || p.id === ventaId) inicial[p.id] = p.saldo;
    setSel(inicial);
    const total = Object.values(inicial).reduce((a, b) => a + b, 0);
    setMedios([{ medio: 'efectivo', importe: total, referencia: '' }]);
    setClave(nuevaClave());
  }, [abierto, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const aplicado = useMemo(() => Object.values(sel).reduce((a, b) => a + b, 0), [sel]);
  const pagado = medios.reduce((a, m) => a + m.importe, 0);
  const valido = aplicado > 0 && aplicado === pagado && medios.every((m) => m.importe > 0);

  const m = useMutation({
    mutationFn: () =>
      api.post('/cobros', {
        cliente_id: clienteId,
        fecha: fechaCobro,
        notas,
        idem_key: clave,
        medios: medios.map((x) => ({ ...x, referencia: x.referencia || null })),
        aplicaciones: Object.entries(sel).filter(([, v]) => v > 0).map(([venta_id, importe]) => ({ venta_id, importe })),
      }),
    onSuccess: (r) => {
      toast.ok(r.duplicado ? 'El cobro ya estaba registrado' : `Cobro #${numero(r.numero)} registrado`);
      ['cuenta', 'ventas', 'venta', 'orden', 'ordenes', 'cobros', 'cuentas', 'dashboard', 'cliente'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      onCerrar();
    },
    onError: toast.error,
  });

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
          <div>
            <h3 className="mb-2 text-sm font-semibold">Comprobantes a cancelar</h3>
            <ul className="divide-y divide-borde rounded-lg border border-borde">
              {pendientes.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <Check
                    checked={p.id in sel}
                    onChange={(v) => {
                      const n = { ...sel };
                      if (v) n[p.id] = p.saldo;
                      else delete n[p.id];
                      setSel(n);
                    }}
                    label={
                      <span>
                        <span className="font-medium">Comprobante #{numero(p.numero)}</span>
                        <span className="text-tenue"> · {fecha(p.fecha)}{p.orden_numero ? ` · OT #${numero(p.orden_numero)}` : ''} · saldo {money(p.saldo)}</span>
                      </span>
                    }
                  />
                  {p.id in sel && <InputMoneda value={sel[p.id]} onChange={(v) => setSel({ ...sel, [p.id]: Math.min(v, p.saldo) })} className="w-40" />}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold">Formas de pago</h3>
            <div className="space-y-2">
              {medios.map((x, i) => (
                <div key={i} className="grid grid-cols-[1fr_140px_auto] gap-2 sm:grid-cols-[180px_1fr_160px_auto]">
                  <Select value={x.medio} onChange={(e) => setMedios(medios.map((y, j) => (j === i ? { ...y, medio: e.target.value as MedioPago } : y)))}>
                    {MEDIOS_PAGO.map((mp) => <option key={mp} value={mp}>{MEDIO_PAGO_LABEL[mp]}</option>)}
                  </Select>
                  <Input className="col-span-3 row-start-2 sm:col-span-1 sm:row-start-auto" placeholder="Referencia (N° de operación, cheque…)" value={x.referencia} onChange={(e) => setMedios(medios.map((y, j) => (j === i ? { ...y, referencia: e.target.value } : y)))} />
                  <InputMoneda value={x.importe} onChange={(v) => setMedios(medios.map((y, j) => (j === i ? { ...y, importe: v } : y)))} />
                  <Boton variante="fantasma" disabled={medios.length === 1} onClick={() => setMedios(medios.filter((_, j) => j !== i))} icono={<Trash2 className="size-4" />} aria-label="Quitar" />
                </div>
              ))}
              <Boton tam="sm" variante="fantasma" icono={<Plus className="size-4" />} onClick={() => setMedios([...medios, { medio: 'transferencia', importe: Math.max(0, aplicado - pagado), referencia: '' }])}>Agregar forma de pago</Boton>
            </div>
            {aplicado !== pagado && <p className="mt-2 text-sm text-red-600">Las formas de pago suman {money(pagado)} y lo aplicado es {money(aplicado)}.</p>}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Campo label="Fecha">
              <Input type="date" value={fechaCobro} onChange={(e) => setFecha(e.target.value)} />
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
