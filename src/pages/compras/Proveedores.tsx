import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { Pencil, Plus, Truck, Wallet } from 'lucide-react';
import { api, nuevaClave } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fecha, hoyISO, money, numero } from '@/lib/format';
import { Boton, Campo, Cargando, Encabezado, ErrorCaja, Input, InputMoneda, Modal, Select, Tabla, Tarjeta, Textarea, useToast, Vacio } from '@/components/ui';
import { CONDICIONES_IVA, CONDICION_IVA_LABEL, MEDIOS_PAGO, MEDIO_PAGO_LABEL } from '@shared/dominio';

function FormProveedor({ inicial, onCerrar }: { inicial?: any; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ nombre: inicial?.nombre ?? '', cuit: inicial?.cuit ?? '', condicion_iva: inicial?.condicion_iva ?? 'responsable_inscripto', telefono: inicial?.telefono ?? '', email: inicial?.email ?? '', direccion: inicial?.direccion ?? '', notas: inicial?.notas ?? '' });
  const m = useMutation({
    mutationFn: () => (inicial?.id ? api.put(`/proveedores/${inicial.id}`, f) : api.post('/proveedores', f)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['proveedores'] });
      qc.invalidateQueries({ queryKey: ['proveedor'] });
      toast.ok('Proveedor guardado');
      onCerrar();
    },
    onError: toast.error,
  });
  return (
    <Modal abierto onCerrar={onCerrar} titulo={inicial ? 'Editar proveedor' : 'Nuevo proveedor'} ancho="lg" pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" disabled={f.nombre.trim().length < 2} cargando={m.isPending} onClick={() => m.mutate()}>Guardar</Boton></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Campo label="Razón social" requerido className="sm:col-span-2"><Input value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} autoFocus /></Campo>
        <Campo label="CUIT"><Input value={f.cuit} onChange={(e) => setF({ ...f, cuit: e.target.value })} /></Campo>
        <Campo label="Condición IVA">
          <Select value={f.condicion_iva} onChange={(e) => setF({ ...f, condicion_iva: e.target.value })}>
            {CONDICIONES_IVA.map((c) => <option key={c} value={c}>{CONDICION_IVA_LABEL[c]}</option>)}
          </Select>
        </Campo>
        <Campo label="Teléfono"><Input value={f.telefono} onChange={(e) => setF({ ...f, telefono: e.target.value })} /></Campo>
        <Campo label="Email"><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Campo>
        <Campo label="Dirección" className="sm:col-span-2"><Input value={f.direccion} onChange={(e) => setF({ ...f, direccion: e.target.value })} /></Campo>
        <Campo label="Notas" className="sm:col-span-2"><Textarea rows={2} value={f.notas} onChange={(e) => setF({ ...f, notas: e.target.value })} /></Campo>
      </div>
    </Modal>
  );
}

export function Proveedores() {
  const nav = useNavigate();
  const { puede } = useAuth();
  const [form, setForm] = useState(false);
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['proveedores'], queryFn: () => api.get<any[]>('/proveedores') });
  return (
    <>
      <Encabezado titulo="Proveedores" acciones={puede('compras.gestionar') && <Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => setForm(true)}>Nuevo proveedor</Boton>} />
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={data}
            clave={(p) => p.id}
            onFila={puede('compras.gestionar') ? (p) => nav(`/proveedores/${p.id}`) : undefined}
            vacio={<Vacio icono={<Truck className="size-5" />} titulo="Sin proveedores" />}
            columnas={[
              { clave: 'n', titulo: 'Proveedor', render: (p) => <span className="font-medium">{p.nombre}</span>, movil: 'titulo' },
              { clave: 'c', titulo: 'CUIT', render: (p) => p.cuit ?? '—', movil: 'subtitulo' },
              { clave: 't', titulo: 'Contacto', render: (p) => [p.telefono, p.email].filter(Boolean).join(' · ') || '—', movil: 'meta' },
              { clave: 's', titulo: 'Saldo a pagar', alinear: 'derecha', render: (p) => (p.saldo > 0 ? <span className="font-semibold text-red-600">{money(p.saldo)}</span> : '—'), movil: 'derecha' },
            ]}
          />
        </Tarjeta>
      )}
      {form && <FormProveedor onCerrar={() => setForm(false)} />}
    </>
  );
}

export function ProveedorDetalle() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [editar, setEditar] = useState(false);
  const [pago, setPago] = useState(false);
  const [p, setP] = useState({ importe: 0, medio: 'transferencia', referencia: '', fecha: hoyISO() });
  const [clave, setClave] = useState(nuevaClave());
  const { data: provs = [] } = useQuery({ queryKey: ['proveedores'], queryFn: () => api.get<any[]>('/proveedores') });
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['proveedor', id], queryFn: () => api.get(`/proveedores/${id}/cuenta`) });
  const prov = provs.find((x) => x.id === id);
  const m = useMutation({
    mutationFn: () => api.post('/pagos-proveedor', { proveedor_id: id, ...p, referencia: p.referencia || null, idem_key: clave }),
    onSuccess: () => {
      ['proveedor', 'proveedores'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.ok('Pago registrado');
      setPago(false);
      setClave(nuevaClave());
      setP({ importe: 0, medio: 'transferencia', referencia: '', fecha: hoyISO() });
    },
    onError: toast.error,
  });
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  return (
    <>
      <Encabezado
        volver="/proveedores"
        titulo={data.proveedor.nombre}
        subtitulo={<>Saldo a pagar: <span className={data.saldo > 0 ? 'font-semibold text-red-600' : 'font-semibold'}>{money(data.saldo)}</span></>}
        acciones={
          <>
            {prov && <Boton icono={<Pencil className="size-4" />} onClick={() => setEditar(true)}>Editar</Boton>}
            <Boton variante="primario" icono={<Wallet className="size-4" />} onClick={() => setPago(true)}>Registrar pago</Boton>
          </>
        }
      />
      <Tarjeta titulo="Cuenta corriente" sinPadding>
        <Tabla
          filas={data.movimientos}
          clave={(m: any) => m.id}
          vacio={<p className="px-4 py-6 text-center text-sm text-tenue">Sin movimientos</p>}
          columnas={[
            { clave: 'f', titulo: 'Fecha', render: (m: any) => fecha(m.fecha), movil: 'meta' },
            { clave: 'c', titulo: 'Concepto', render: (m: any) => (m.tipo === 'compra' ? `Compra #${numero(m.numero)} ${m.detalle ?? ''}` : `Pago #${numero(m.numero)} (${MEDIO_PAGO_LABEL[m.detalle as keyof typeof MEDIO_PAGO_LABEL] ?? m.detalle})`), movil: 'titulo' },
            { clave: 'd', titulo: 'Pagos', alinear: 'derecha', render: (m: any) => (m.debe ? money(m.debe) : ''), movil: 'meta' },
            { clave: 'h', titulo: 'Compras', alinear: 'derecha', render: (m: any) => (m.haber ? money(m.haber) : ''), movil: 'meta' },
            { clave: 's', titulo: 'Saldo', alinear: 'derecha', render: (m: any) => money(m.saldo), movil: 'derecha' },
          ]}
        />
      </Tarjeta>
      {editar && prov && <FormProveedor inicial={prov} onCerrar={() => setEditar(false)} />}
      <Modal abierto={pago} onCerrar={() => setPago(false)} titulo="Pago a proveedor" ancho="sm" pie={<><Boton onClick={() => setPago(false)}>Cancelar</Boton><Boton variante="primario" disabled={p.importe <= 0} cargando={m.isPending} onClick={() => m.mutate()}>Registrar</Boton></>}>
        <div className="space-y-3">
          <Campo label="Importe" requerido><InputMoneda value={p.importe} onChange={(v) => setP({ ...p, importe: v })} autoFocus /></Campo>
          <Campo label="Medio">
            <Select value={p.medio} onChange={(e) => setP({ ...p, medio: e.target.value })}>
              {MEDIOS_PAGO.map((x) => <option key={x} value={x}>{MEDIO_PAGO_LABEL[x]}</option>)}
            </Select>
          </Campo>
          <Campo label="Referencia"><Input value={p.referencia} onChange={(e) => setP({ ...p, referencia: e.target.value })} /></Campo>
          <Campo label="Fecha"><Input type="date" value={p.fecha} onChange={(e) => setP({ ...p, fecha: e.target.value })} /></Campo>
        </div>
      </Modal>
    </>
  );
}
