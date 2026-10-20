import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Ban, Pencil, Plus, ShoppingCart, Truck, Wallet } from 'lucide-react';
import { api, nuevaClave } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { invalidarDinero } from '@/lib/caja';
import { fecha, hoyISO, money, numero } from '@/lib/format';
import { Aviso, Boton, Buscador, Campo, Cargando, Check, Encabezado, ErrorCaja, Input, InputMoneda, Insignia, Modal, Select, Tabla, Tarjeta, Textarea, useToast, Vacio } from '@/components/ui';
import { AvisoCaja, useCajaBloqueada } from '@/components/Cobro';
import { CONDICIONES_IVA, CONDICION_IVA_LABEL, MEDIOS_PAGO, MEDIO_PAGO_LABEL } from '@shared/dominio';

function FormProveedor({ inicial, onCerrar }: { inicial?: any; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ nombre: inicial?.nombre ?? '', cuit: inicial?.cuit ?? '', condicion_iva: inicial?.condicion_iva ?? 'responsable_inscripto', telefono: inicial?.telefono ?? '', email: inicial?.email ?? '', direccion: inicial?.direccion ?? '', notas: inicial?.notas ?? '', activo: inicial ? !!inicial.activo : true });
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
        {inicial && <div className="sm:col-span-2"><Check checked={f.activo} onChange={(v) => setF({ ...f, activo: v })} label="Proveedor activo (los inactivos no aparecen al registrar compras)" /></div>}
      </div>
    </Modal>
  );
}

export function Proveedores() {
  const nav = useNavigate();
  const { puede } = useAuth();
  const [form, setForm] = useState(false);
  const [q, setQ] = useState('');
  const [inactivos, setInactivos] = useState(false);
  const [conDeuda, setConDeuda] = useState(false);
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['proveedores'], queryFn: () => api.get<any[]>('/proveedores') });
  const filas = data.filter((p) => (inactivos || p.activo) && (!conDeuda || p.saldo > 0) && (!q || `${p.nombre} ${p.cuit ?? ''}`.toLowerCase().includes(q.toLowerCase())));
  const deuda = data.reduce((a, p) => a + Math.max(0, p.saldo), 0);
  return (
    <>
      <Encabezado titulo="Proveedores" subtitulo={puede('compras.gestionar') ? `Deuda total con proveedores: ${money(deuda)}` : undefined} acciones={puede('compras.gestionar') && <Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => setForm(true)}>Nuevo proveedor</Boton>} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Buscador value={q} onChange={setQ} placeholder="Nombre o CUIT" className="min-w-52 flex-1" />
        <Check checked={conDeuda} onChange={setConDeuda} label="Con deuda" />
        <Check checked={inactivos} onChange={setInactivos} label="Mostrar inactivos" />
      </div>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={filas}
            clave={(p) => p.id}
            onFila={puede('compras.gestionar') ? (p) => nav(`/proveedores/${p.id}`) : undefined}
            vacio={<Vacio icono={<Truck className="size-5" />} titulo="Sin proveedores" texto="Cargá a tus proveedores para registrar compras y llevar su cuenta corriente." />}
            columnas={[
              { clave: 'n', titulo: 'Proveedor', render: (p) => <span className="flex items-center gap-2 font-medium">{p.nombre}{!p.activo && <Insignia tono="gris">Inactivo</Insignia>}</span>, movil: 'titulo' },
              { clave: 'c', titulo: 'CUIT', render: (p) => p.cuit ?? '—', movil: 'subtitulo' },
              { clave: 't', titulo: 'Contacto', render: (p) => [p.telefono, p.email].filter(Boolean).join(' · ') || '—', movil: 'meta' },
              { clave: 's', titulo: 'Saldo a pagar', alinear: 'derecha', render: (p) => (p.saldo > 0 ? <span className="font-semibold text-red-600">{money(p.saldo)}</span> : p.saldo < 0 ? <span className="text-emerald-700">A favor {money(-p.saldo)}</span> : '—'), movil: 'derecha' },
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
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const bloqueada = useCajaBloqueada();
  const [editar, setEditar] = useState(false);
  const [pago, setPago] = useState(false);
  const [anular, setAnular] = useState<any | null>(null);
  const [motivo, setMotivo] = useState('');
  const [p, setP] = useState({ importe: 0, medio: 'transferencia', referencia: '', fecha: hoyISO(), anticipo: false });
  const [clave, setClave] = useState(nuevaClave());
  const { puede } = useAuth();
  const { data: provs = [] } = useQuery({ queryKey: ['proveedores'], queryFn: () => api.get<any[]>('/proveedores') });
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['proveedor', id], queryFn: () => api.get(`/proveedores/${id}/cuenta`) });
  const prov = provs.find((x) => x.id === id);
  const excede = pago && p.importe > Math.max(0, data?.saldo ?? 0);
  const m = useMutation({
    mutationFn: () => api.post('/pagos-proveedor', { proveedor_id: id, importe: p.importe, medio: p.medio, fecha: p.fecha, referencia: p.referencia || null, idem_key: clave, permitir_anticipo: p.anticipo }),
    onSuccess: () => {
      invalidarDinero(qc);
      toast.ok('Pago registrado');
      setPago(false);
      setClave(nuevaClave());
      setP({ importe: 0, medio: 'transferencia', referencia: '', fecha: hoyISO(), anticipo: false });
    },
    onError: toast.error,
  });
  const anularPago = useMutation({
    mutationFn: () => api.post(`/pagos-proveedor/${anular.id}/anular`, { motivo }),
    onSuccess: () => {
      invalidarDinero(qc);
      toast.ok('Pago anulado');
      setAnular(null);
      setMotivo('');
    },
    onError: toast.error,
  });
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  const validoPago = p.importe > 0 && !(p.medio === 'cheque' && !p.referencia.trim()) && (!excede || p.anticipo) && !bloqueada;
  return (
    <>
      <Encabezado
        volver="/proveedores"
        titulo={<span className="flex items-center gap-2">{data.proveedor.nombre}{!data.proveedor.activo && <Insignia tono="gris">Inactivo</Insignia>}</span>}
        subtitulo={<>{data.saldo < 0 ? 'Saldo a favor: ' : 'Saldo a pagar: '}<span className={data.saldo > 0 ? 'font-semibold text-red-600' : 'font-semibold'}>{money(Math.abs(data.saldo))}</span></>}
        acciones={
          <>
            {prov && <Boton icono={<Pencil className="size-4" />} onClick={() => setEditar(true)}>Editar</Boton>}
            <Boton icono={<ShoppingCart className="size-4" />} onClick={() => nav(`/compras?q=${encodeURIComponent(data.proveedor.nombre)}`)}>Ver compras</Boton>
            <Boton variante="primario" icono={<Wallet className="size-4" />} onClick={() => setPago(true)}>Registrar pago</Boton>
          </>
        }
      />
      <Tarjeta titulo="Cuenta corriente" subtitulo="Las operaciones anuladas se muestran tachadas y no suman al saldo" sinPadding>
        <Tabla
          filas={data.movimientos}
          clave={(m: any) => `${m.tipo}-${m.id}`}
          vacio={<p className="px-4 py-6 text-center text-sm text-tenue">Sin movimientos</p>}
          columnas={[
            { clave: 'f', titulo: 'Fecha', render: (m: any) => fecha(m.fecha), movil: 'meta' },
            {
              clave: 'c', titulo: 'Concepto',
              render: (m: any) => (
                <span className={m.anulado ? 'text-tenue line-through' : ''}>
                  {m.tipo === 'compra' ? <Link className="text-marca-700" to={`/compras?ver=${m.id}`}>Compra #{numero(m.numero)}</Link> : `Pago #${numero(m.numero)}`}{' '}
                  {m.tipo === 'compra' ? m.detalle ?? '' : `(${MEDIO_PAGO_LABEL[m.detalle as keyof typeof MEDIO_PAGO_LABEL] ?? m.detalle})`}
                  {m.anulado ? <Insignia tono="gris" className="ml-2 no-underline">Anulado</Insignia> : null}
                </span>
              ),
              movil: 'titulo',
            },
            { clave: 'd', titulo: 'Pagos', alinear: 'derecha', render: (m: any) => (m.debe ? money(m.debe) : ''), movil: 'meta' },
            { clave: 'h', titulo: 'Compras', alinear: 'derecha', render: (m: any) => (m.haber ? money(m.haber) : ''), movil: 'meta' },
            { clave: 's', titulo: 'Saldo', alinear: 'derecha', render: (m: any) => money(m.saldo), movil: 'derecha' },
            { clave: 'a', titulo: '', render: (m: any) => m.tipo === 'pago' && !m.anulado ? <Boton tam="sm" variante="fantasma" icono={<Ban className="size-4" />} onClick={() => setAnular(m)}>Anular</Boton> : null, movil: 'meta' },
          ]}
        />
      </Tarjeta>
      {editar && prov && <FormProveedor inicial={prov} onCerrar={() => setEditar(false)} />}
      <Modal abierto={pago} onCerrar={() => setPago(false)} titulo="Pago a proveedor" ancho="sm" pie={<><Boton onClick={() => setPago(false)}>Cancelar</Boton><Boton variante="primario" disabled={!validoPago} cargando={m.isPending} onClick={() => m.mutate()}>Registrar pago</Boton></>}>
        <div className="space-y-3">
          <AvisoCaja />
          <p className="text-sm text-tenue">Deuda actual: <strong>{money(Math.max(0, data.saldo))}</strong></p>
          <Campo label="Importe" requerido><InputMoneda value={p.importe} onChange={(v) => setP({ ...p, importe: v })} autoFocus /></Campo>
          {excede && <Aviso tono="ambar"><Check checked={p.anticipo} onChange={(v) => setP({ ...p, anticipo: v })} label="El pago supera la deuda: registrarlo como anticipo (saldo a favor)" /></Aviso>}
          <Campo label="Medio">
            <Select value={p.medio} onChange={(e) => setP({ ...p, medio: e.target.value })}>
              {MEDIOS_PAGO.map((x) => <option key={x} value={x}>{MEDIO_PAGO_LABEL[x]}</option>)}
            </Select>
          </Campo>
          <Campo label={p.medio === 'cheque' ? 'N° de cheque' : 'Referencia'} requerido={p.medio === 'cheque'}><Input value={p.referencia} onChange={(e) => setP({ ...p, referencia: e.target.value })} /></Campo>
          <Campo label="Fecha" hint={puede('fechas.retroactivas') ? undefined : 'Sólo hoy'}><Input type="date" value={p.fecha} max={hoyISO()} disabled={!puede('fechas.retroactivas')} onChange={(e) => setP({ ...p, fecha: e.target.value })} /></Campo>
        </div>
      </Modal>
      <Modal abierto={!!anular} onCerrar={() => setAnular(null)} titulo={`Anular pago #${anular ? numero(anular.numero) : ''}`} ancho="sm" pie={<><Boton onClick={() => setAnular(null)}>Cancelar</Boton><Boton variante="peligro" disabled={motivo.trim().length < 3} cargando={anularPago.isPending} onClick={() => anularPago.mutate()}>Anular pago</Boton></>}>
        <div className="space-y-3">
          <p className="text-sm text-tenue">La deuda con el proveedor vuelve a aumentar y se registra el reintegro en la caja abierta.</p>
          <Campo label="Motivo" requerido><Input value={motivo} onChange={(e) => setMotivo(e.target.value)} autoFocus /></Campo>
        </div>
      </Modal>
    </>
  );
}
