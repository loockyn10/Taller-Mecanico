// Selector de medio de pago y datos que cada medio necesita: cuenta bancaria (transferencia, tarjetas) o cheque (propio o de cartera).
// Lo comparten cobros, venta de mostrador, pagos a proveedores, compras de contado y gastos.
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useMediosHabilitados } from '@/lib/config';
import { fecha, hoyISO, money } from '@/lib/format';
import { MEDIO_PAGO_LABEL, MEDIOS_BANCARIOS, type MedioPago } from '@shared/dominio';
import { Campo, Input, Select } from './ui';

export interface ExtraMedio {
  cuenta_id: string;
  // cheque
  modo: 'propio' | 'cartera';
  banco: string;
  modalidad: 'fisico' | 'echeq';
  echeq_id: string;
  librador: string;
  cuit: string;
  fecha_pago: string;
  cheque_id: string;
}
export const extraVacio = (): ExtraMedio => ({ cuenta_id: '', modo: 'propio', banco: '', modalidad: 'fisico', echeq_id: '', librador: '', cuit: '', fecha_pago: hoyISO(), cheque_id: '' });

export type ContextoMedio = 'cobro' | 'pago_proveedor' | 'gasto';

export function SelectorMedio({ value, onChange, className, excluir = [] }: { value: MedioPago; onChange: (m: MedioPago) => void; className?: string; excluir?: readonly MedioPago[] }) {
  const medios = useMediosHabilitados().filter((m) => !excluir.includes(m));
  // Si el medio actual quedó deshabilitado se sigue mostrando para no perder la selección; el servidor lo rechaza.
  const lista = medios.includes(value) ? medios : [...medios, value];
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value as MedioPago)} className={className} aria-label="Medio de pago">
      {lista.map((m) => <option key={m} value={m}>{MEDIO_PAGO_LABEL[m]}</option>)}
    </Select>
  );
}

/** Mensaje de error si faltan datos del medio (null = completo). */
export function errorMedio(medio: MedioPago, referencia: string, x: ExtraMedio, ctx: ContextoMedio): string | null {
  if (medio !== 'cheque') return null;
  if (ctx === 'pago_proveedor' && x.modo === 'cartera') return x.cheque_id ? null : 'Elegí el cheque de la cartera';
  if (!referencia.trim()) return 'Indicá el número de cheque';
  if (ctx === 'cobro' && x.banco.trim().length < 2) return 'Indicá el banco del cheque';
  if (x.modalidad === 'echeq' && !x.echeq_id.trim()) return 'Indicá el ID del eCheq';
  return null;
}

/** Campos adicionales para enviar a la API según el medio. */
export function extraAPayload(medio: MedioPago, x: ExtraMedio, ctx: ContextoMedio): Record<string, unknown> {
  if (MEDIOS_BANCARIOS.includes(medio)) return { cuenta_id: x.cuenta_id || null };
  if (medio !== 'cheque') return {};
  if (ctx === 'pago_proveedor' && x.modo === 'cartera') return { cheque_id: x.cheque_id };
  if (ctx === 'cobro') {
    return { cheque: { banco: x.banco.trim(), modalidad: x.modalidad, echeq_id: x.echeq_id.trim() || null, librador: x.librador.trim() || null, cuit: x.cuit.trim() || null, fecha_pago: x.fecha_pago } };
  }
  return { cheque: { cuenta_id: x.cuenta_id || null, banco: x.banco.trim() || undefined, modalidad: x.modalidad, echeq_id: x.echeq_id.trim() || null, fecha_pago: x.fecha_pago } };
}

export function CamposMedio({ medio, valor, onChange, ctx, importe }: { medio: MedioPago; valor: ExtraMedio; onChange: (v: ExtraMedio) => void; ctx: ContextoMedio; importe?: number }) {
  const bancario = MEDIOS_BANCARIOS.includes(medio);
  const { data: cuentas = [] } = useQuery({ queryKey: ['bancos', 'selector'], queryFn: () => api.get<any[]>('/bancos/selector'), enabled: bancario || medio === 'cheque', staleTime: 30_000 });
  const { data: cartera = [] } = useQuery({ queryKey: ['cheques', 'cartera'], queryFn: () => api.get<any[]>('/cheques-cartera'), enabled: medio === 'cheque' && ctx === 'pago_proveedor' });
  const set = (p: Partial<ExtraMedio>) => onChange({ ...valor, ...p });

  if (bancario) {
    if (!cuentas.length) return null;
    return (
      <Campo label={ctx === 'cobro' ? 'Se acredita en la cuenta' : 'Sale de la cuenta'} hint="Opcional: si no elegís cuenta, la operación queda sólo en la caja">
        <Select value={valor.cuenta_id} onChange={(e) => set({ cuenta_id: e.target.value })}>
          <option value="">Sin asignar a una cuenta</option>
          {cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre} · {c.banco}</option>)}
        </Select>
      </Campo>
    );
  }
  if (medio !== 'cheque') return null;

  if (ctx === 'cobro') {
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        <Campo label="Banco del cheque" requerido><Input value={valor.banco} onChange={(e) => set({ banco: e.target.value })} placeholder="Ej.: Banco Nación" /></Campo>
        <Campo label="Tipo">
          <Select value={valor.modalidad} onChange={(e) => set({ modalidad: e.target.value as ExtraMedio['modalidad'] })}><option value="fisico">Cheque físico</option><option value="echeq">eCheq</option></Select>
        </Campo>
        {valor.modalidad === 'echeq' && <Campo label="ID del eCheq" requerido className="sm:col-span-2"><Input value={valor.echeq_id} onChange={(e) => set({ echeq_id: e.target.value })} /></Campo>}
        <Campo label="Titular / librador"><Input value={valor.librador} onChange={(e) => set({ librador: e.target.value })} /></Campo>
        <Campo label="CUIT del librador"><Input value={valor.cuit} onChange={(e) => set({ cuit: e.target.value })} placeholder="20-12345678-6" /></Campo>
        <Campo label="Fecha de pago" hint="Un cheque diferido no se puede depositar antes de esta fecha"><Input type="date" value={valor.fecha_pago} onChange={(e) => set({ fecha_pago: e.target.value })} /></Campo>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {ctx === 'pago_proveedor' && (
        <Campo label="Cheque">
          <Select value={valor.modo} onChange={(e) => set({ modo: e.target.value as ExtraMedio['modo'] })}>
            <option value="propio">Emitir un cheque propio</option>
            <option value="cartera">Endosar un cheque de la cartera</option>
          </Select>
        </Campo>
      )}
      {valor.modo === 'cartera' && ctx === 'pago_proveedor' ? (
        <Campo label="Cheque de cartera" requerido hint={cartera.length ? 'El importe del pago debe ser igual al del cheque' : 'No hay cheques en cartera'}>
          <Select value={valor.cheque_id} onChange={(e) => set({ cheque_id: e.target.value })}>
            <option value="">— Elegir —</option>
            {cartera.map((c) => <option key={c.id} value={c.id} disabled={importe != null && importe > 0 && c.importe !== importe}>{c.banco} N° {c.nro_cheque} · {money(c.importe)} · cobra {fecha(c.fecha_pago)}</option>)}
          </Select>
        </Campo>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          <Campo label="Cuenta contra la que se libra" hint="Se usa para debitarlo al acreditarse">
            <Select value={valor.cuenta_id} onChange={(e) => set({ cuenta_id: e.target.value })}>
              <option value="">—</option>
              {cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre} · {c.banco}</option>)}
            </Select>
          </Campo>
          <Campo label="Fecha de pago"><Input type="date" value={valor.fecha_pago} onChange={(e) => set({ fecha_pago: e.target.value })} /></Campo>
          <Campo label="Tipo">
            <Select value={valor.modalidad} onChange={(e) => set({ modalidad: e.target.value as ExtraMedio['modalidad'] })}><option value="fisico">Cheque físico</option><option value="echeq">eCheq</option></Select>
          </Campo>
          {valor.modalidad === 'echeq' && <Campo label="ID del eCheq" requerido><Input value={valor.echeq_id} onChange={(e) => set({ echeq_id: e.target.value })} /></Campo>}
        </div>
      )}
    </div>
  );
}
