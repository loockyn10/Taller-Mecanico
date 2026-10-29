import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Check, MessageCircle, Pencil, Printer, Wallet, Wrench, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fecha, km, money, numero, whatsapp } from '@/lib/format';
import { Aviso, Boton, Campo, Cargando, Dato, Encabezado, ErrorCaja, Input, Modal, Select, Tarjeta, useConfirmar, useToast } from '@/components/ui';
import { EstadoPresupuestoBadge } from '@/components/estados';
import { EditorItems, itemsDesdeApi } from '@/components/EditorItems';
import { useMecanicos } from '@/components/selectores';
import { ModalAnticipo } from '@/components/Devolucion';
import { mensajePresupuestoWhatsApp } from '@shared/mensaje-presupuesto';
import { ESTADO_ANTICIPO_LABEL, type EstadoAnticipo } from '@shared/dominio';

export function PresupuestoDetalle() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { me, puede } = useAuth();
  const { confirmar, dialogo } = useConfirmar();
  const { data: p, isLoading, error, refetch } = useQuery({ queryKey: ['presupuesto', id], queryFn: () => api.get(`/presupuestos/${id}`) });
  const { data: mecanicos = [] } = useMecanicos();
  const [convertir, setConvertir] = useState(false);
  const [anticipo, setAnticipo] = useState(false);
  const { data: anticipos = [] } = useQuery({ queryKey: ['anticipos', { presupuesto: id }], queryFn: () => api.get<any[]>(`/anticipos?presupuesto_id=${id}`), enabled: puede('ventas.ver') });
  const [mec, setMec] = useState('');
  const [prometida, setPrometida] = useState('');

  const estado = useMutation({
    mutationFn: (e: string) => api.post(`/presupuestos/${id}/estado`, { estado: e }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['presupuesto', id] });
      qc.invalidateQueries({ queryKey: ['presupuestos'] });
      toast.ok('Estado actualizado');
    },
    onError: toast.error,
  });
  const conv = useMutation({
    mutationFn: () => api.post(`/presupuestos/${id}/convertir`, { mecanico_id: mec || null, fecha_prometida: prometida || null }),
    onSuccess: (o) => {
      ['presupuesto', 'presupuestos', 'ordenes', 'dashboard', 'turnos'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.ok(`OT #${numero(o.numero)} creada desde el presupuesto`);
      nav(`/ordenes/${o.id}`);
    },
    onError: toast.error,
  });

  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  const abierto = p.estado === 'pendiente' || p.estado === 'aprobado';
  const wa = whatsapp(p.cliente_telefono, mensajePresupuestoWhatsApp({
    taller: me?.taller.nombre, cliente: p.cliente, vehiculo: [p.marca, p.modelo].filter(Boolean).join(' '), patente: p.patente,
    numero: numero(p.numero), total: p.total == null ? null : money(p.total), validez: p.valido_hasta ? fecha(p.valido_hasta) : null,
  }));

  return (
    <>
      {dialogo}
      <Encabezado
        volver="/presupuestos"
        titulo={<span className="flex flex-wrap items-center gap-3">Presupuesto P-{numero(p.numero)} <EstadoPresupuestoBadge estado={p.estado} vencido={p.vencido} /></span>}
        subtitulo={`${p.cliente} · ${p.patente} ${[p.marca, p.modelo].filter(Boolean).join(' ')}`}
        acciones={
          <>
            {wa && <a href={wa} target="_blank" rel="noreferrer"><Boton icono={<MessageCircle className="size-4" />}>WhatsApp</Boton></a>}
            <Boton icono={<Printer className="size-4" />} onClick={() => window.open(`/imprimir/presupuesto/${p.id}`, '_blank')}>Imprimir / PDF</Boton>
            {p.estado === 'pendiente' && <Boton icono={<Pencil className="size-4" />} onClick={() => nav(`/presupuestos/${p.id}/editar`)}>Editar</Boton>}
          </>
        }
      />
      {p.vencido ? <Aviso tono="ambar" className="mb-4">El presupuesto venció el {fecha(p.valido_hasta)}. Revisá los precios antes de convertirlo.</Aviso> : null}
      {p.estado === 'convertido' && p.orden_id && (
        <Aviso tono="verde" className="mb-4">Convertido en <Link className="font-semibold underline" to={`/ordenes/${p.orden_id}`}>OT #{numero(p.orden_numero)}</Link>.</Aviso>
      )}
      <div className="grid gap-5 xl:grid-cols-3">
        <Tarjeta titulo="Detalle" className="xl:col-span-2">
          <EditorItems items={itemsDesdeApi(p.items)} onItems={() => undefined} params={p} onParams={() => undefined} soloLectura />
        </Tarjeta>
        <div className="space-y-5">
          {abierto && (
            <Tarjeta titulo="Acciones">
              <div className="flex flex-col gap-2">
                <Boton variante="primario" icono={<Wrench className="size-4" />} onClick={() => setConvertir(true)}>Convertir en orden de trabajo</Boton>
                {p.estado === 'pendiente' && <Boton variante="exito" icono={<Check className="size-4" />} cargando={estado.isPending} onClick={() => estado.mutate('aprobado')}>Marcar aprobado</Boton>}
                {p.estado === 'aprobado' && <Boton onClick={() => estado.mutate('pendiente')}>Volver a pendiente</Boton>}
                <Boton icono={<X className="size-4" />} onClick={() => estado.mutate('rechazado')}>Rechazado por el cliente</Boton>
                <Boton
                  variante="fantasma"
                  onClick={async () => {
                    if (await confirmar('Anular presupuesto', 'El presupuesto quedará anulado y no podrá convertirse.', true)) estado.mutate('anulado');
                  }}
                >
                  Anular
                </Boton>
              </div>
            </Tarjeta>
          )}
          {p.estado === 'rechazado' && <Boton className="w-full" onClick={() => estado.mutate('pendiente')}>Reabrir presupuesto</Boton>}
          {puede('ventas.ver') && p.cliente_codigo !== 0 && (anticipos.length > 0 || (abierto && puede('cobros.registrar'))) && (
            <Tarjeta titulo="Anticipos" subtitulo="Dinero entregado antes de empezar (no es una venta)" acciones={abierto && puede('cobros.registrar') && <Boton tam="sm" icono={<Wallet className="size-4" />} onClick={() => setAnticipo(true)}>Registrar anticipo</Boton>}>
              {anticipos.length === 0 ? <p className="text-sm text-tenue">Sin anticipos.</p> : (
                <ul className="divide-y divide-borde text-sm">
                  {anticipos.map((a: any) => (
                    <li key={a.id} className="flex flex-wrap justify-between gap-2 py-1.5">
                      <span>Recibo #{numero(a.numero)} · {fecha(a.fecha)} · {ESTADO_ANTICIPO_LABEL[a.estado_uso as EstadoAnticipo]}</span>
                      <span className="tabular-nums">{money(a.total)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-tenue">Al convertir el presupuesto en OT los anticipos siguen vinculados: se aplican al comprobante de la orden.</p>
            </Tarjeta>
          )}
          <Tarjeta titulo="Datos">
            <dl className="grid grid-cols-2 gap-4">
              <Dato etiqueta="Fecha">{fecha(p.fecha)}</Dato>
              <Dato etiqueta="Válido hasta">{fecha(p.valido_hasta)}</Dato>
              <Dato etiqueta="Cliente"><Link to={`/clientes/${p.cliente_id}`} className="text-marca-700">{p.cliente}</Link></Dato>
              <Dato etiqueta="Vehículo"><Link to={`/vehiculos/${p.vehiculo_id}`} className="text-marca-700">{p.patente}</Link></Dato>
              <Dato etiqueta="Kilometraje">{km(p.km)}</Dato>
              <Dato etiqueta="Total"><span className="font-semibold">{money(p.total)}</span></Dato>
              <Dato etiqueta="Observaciones" className="col-span-2">{p.observaciones}</Dato>
            </dl>
          </Tarjeta>
        </div>
      </div>

      {anticipo && <ModalAnticipo clienteFijo={{ id: p.cliente_id, nombre: p.cliente } as any} presupuestoId={p.id} onCerrar={() => setAnticipo(false)} />}
      <Modal
        abierto={convertir}
        onCerrar={() => setConvertir(false)}
        titulo="Convertir en orden de trabajo"
        pie={<><Boton onClick={() => setConvertir(false)}>Cancelar</Boton><Boton variante="primario" cargando={conv.isPending} onClick={() => conv.mutate()}>Crear OT</Boton></>}
      >
        <div className="space-y-3">
          <p className="text-sm text-tenue">Se creará una OT con el cliente, el vehículo y todos los ítems del presupuesto. El presupuesto quedará vinculado a la OT.</p>
          <Campo label="Mecánico">
            <Select value={mec} onChange={(e) => setMec(e.target.value)}>
              <option value="">Sin asignar</option>
              {mecanicos.filter((m) => m.activo).map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
            </Select>
          </Campo>
          <Campo label="Fecha prometida"><Input type="date" value={prometida} onChange={(e) => setPrometida(e.target.value)} /></Campo>
        </div>
      </Modal>
    </>
  );
}
