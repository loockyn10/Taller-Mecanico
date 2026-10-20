// Alta de un gasto (egreso). Se usa desde la caja y desde Gastos y finanzas.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, nuevaClave } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { invalidarDinero } from '@/lib/caja';
import { hoyISO } from '@/lib/format';
import { MEDIOS_PAGO, MEDIO_PAGO_LABEL, type MedioPago } from '@shared/dominio';
import { AvisoCaja, useCajaBloqueada } from './Cobro';
import { Boton, Campo, Input, InputMoneda, Modal, Select, useToast } from './ui';

export function ModalGasto({ onCerrar, inicial }: { onCerrar: () => void; inicial?: { categoria_id?: string; concepto?: string; importe?: number; medio?: MedioPago } }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useAuth();
  const bloqueada = useCajaBloqueada();
  const { data: cats = [] } = useQuery({ queryKey: ['gastos', 'categorias'], queryFn: () => api.get<any[]>('/categorias-gasto') });
  const { data: provs = [] } = useQuery({ queryKey: ['proveedores'], queryFn: () => api.get<any[]>('/proveedores'), enabled: puede('catalogo.ver') });
  const [f, setF] = useState({ categoria_id: inicial?.categoria_id ?? '', concepto: inicial?.concepto ?? '', importe: inicial?.importe ?? 0, medio: (inicial?.medio ?? 'efectivo') as MedioPago, referencia: '', proveedor_id: '', comprobante: '', fecha: hoyISO(), notas: '' });
  const [clave] = useState(nuevaClave());
  useEffect(() => {
    if (!f.categoria_id && cats.length) setF((x) => ({ ...x, categoria_id: cats[0].id }));
  }, [cats]); // eslint-disable-line react-hooks/exhaustive-deps
  const m = useMutation({
    mutationFn: () =>
      api.post('/gastos', {
        categoria_id: f.categoria_id, concepto: f.concepto, importe: f.importe, medio: f.medio, fecha: f.fecha, idem_key: clave,
        referencia: f.referencia || null, proveedor_id: f.proveedor_id || null, comprobante: f.comprobante || null, notas: f.notas || null,
      }),
    onSuccess: () => {
      invalidarDinero(qc);
      toast.ok('Gasto registrado');
      onCerrar();
    },
    onError: toast.error,
  });
  const valido = f.categoria_id && f.concepto.trim().length >= 3 && f.importe > 0 && !bloqueada;
  return (
    <Modal abierto onCerrar={onCerrar} titulo="Registrar gasto" ancho="lg" pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" disabled={!valido} cargando={m.isPending} onClick={() => m.mutate()}>Registrar gasto</Boton></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><AvisoCaja /></div>
        <Campo label="Concepto" requerido className="sm:col-span-2"><Input value={f.concepto} onChange={(e) => setF({ ...f, concepto: e.target.value })} placeholder="Ej.: compra de trapos y desengrasante" autoFocus /></Campo>
        <Campo label="Categoría" requerido>
          <Select value={f.categoria_id} onChange={(e) => setF({ ...f, categoria_id: e.target.value })}>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </Select>
        </Campo>
        <Campo label="Importe" requerido><InputMoneda value={f.importe} onChange={(v) => setF({ ...f, importe: v })} /></Campo>
        <Campo label="Medio de pago" hint={f.medio === 'efectivo' ? 'Sale del efectivo de la caja' : 'No afecta al efectivo de la caja'}>
          <Select value={f.medio} onChange={(e) => setF({ ...f, medio: e.target.value as MedioPago })}>
            {MEDIOS_PAGO.map((x) => <option key={x} value={x}>{MEDIO_PAGO_LABEL[x]}</option>)}
          </Select>
        </Campo>
        <Campo label="Fecha" hint={puede('fechas.retroactivas') ? undefined : 'Sólo hoy'}><Input type="date" value={f.fecha} max={hoyISO()} disabled={!puede('fechas.retroactivas')} onChange={(e) => setF({ ...f, fecha: e.target.value })} /></Campo>
        {puede('catalogo.ver') && (
          <Campo label="Proveedor (opcional)">
            <Select value={f.proveedor_id} onChange={(e) => setF({ ...f, proveedor_id: e.target.value })}>
              <option value="">—</option>
              {provs.filter((p) => p.activo).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
            </Select>
          </Campo>
        )}
        <Campo label="N° de comprobante"><Input value={f.comprobante} onChange={(e) => setF({ ...f, comprobante: e.target.value })} /></Campo>
        <Campo label="Referencia de pago"><Input value={f.referencia} onChange={(e) => setF({ ...f, referencia: e.target.value })} /></Campo>
        <Campo label="Notas"><Input value={f.notas} onChange={(e) => setF({ ...f, notas: e.target.value })} /></Campo>
      </div>
    </Modal>
  );
}
