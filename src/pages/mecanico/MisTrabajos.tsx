// Vista simplificada del mecánico (celular o tablet): sus órdenes asignadas, sin precios, costos ni datos comerciales.
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CalendarClock, ChevronRight, Package, Wrench } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fecha, km, numero } from '@/lib/format';
import { Aviso, Boton, Cargando, Chip, Encabezado, ErrorCaja, Insignia, Tarjeta, useToast, Vacio } from '@/components/ui';
import { EstadoOTBadge } from '@/components/estados';
import { Cronometro, NotasTecnicas, Tareas, useRefrescarOrden } from '@/components/TrabajoMecanico';
import { ESTADO_OT_LABEL, type EstadoOT } from '@shared/dominio';

/** Estados a los que un mecánico puede llevar su orden (la entrega y la cancelación son del mostrador). */
const ESTADOS_TALLER: EstadoOT[] = ['diagnostico', 'en_reparacion', 'esperando_repuestos', 'lista'];

export function MisTrabajos() {
  const { me } = useAuth();
  const [ver, setVer] = useState<'abiertas' | 'todas'>('abiertas');
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['ordenes', 'mias', ver], queryFn: () => api.get<any[]>(`/ordenes?estado=${ver}`), refetchInterval: 60_000 });
  return (
    <>
      <Encabezado titulo="Mis trabajos" subtitulo={`Hola ${me?.usuario.nombre.split(' ')[0]}: estas son tus órdenes asignadas`} />
      <div className="mb-4 flex gap-2">
        <Chip activo={ver === 'abiertas'} onClick={() => setVer('abiertas')}>En curso</Chip>
        <Chip activo={ver === 'todas'} onClick={() => setVer('todas')}>Todas</Chip>
      </div>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : !data?.length ? (
        <Tarjeta><Vacio icono={<Wrench className="size-5" />} titulo="No tenés trabajos asignados" texto="Cuando recepción te asigne una orden, aparece acá." /></Tarjeta>
      ) : (
        <ul className="space-y-3">
          {data.map((o) => (
            <li key={o.id}>
              <Link to={`/mis-trabajos/${o.id}`} className="block rounded-2xl border border-borde bg-white p-4 shadow-sm active:bg-slate-50">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-2xl font-extrabold tracking-wide">{o.patente}</p>
                    <p className="truncate text-sm text-tenue">{[o.marca, o.modelo, o.anio].filter(Boolean).join(' ') || 'Vehículo'}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <EstadoOTBadge estado={o.estado} />
                    <span className="text-xs text-tenue">OT #{numero(o.numero)}</span>
                  </div>
                </div>
                {o.falla_reportada && <p className="mt-2 line-clamp-2 text-sm">{o.falla_reportada}</p>}
                <div className="mt-2 flex items-center justify-between text-xs text-tenue">
                  <span className="flex items-center gap-1">{o.fecha_prometida ? <><CalendarClock className="size-3.5" /> Prometida: {fecha(o.fecha_prometida)}</> : `Ingresó: ${fecha(o.fecha_ingreso)}`}</span>
                  <ChevronRight className="size-5 text-slate-400" />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function MiTrabajo() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { puede } = useAuth();
  const refrescar = useRefrescarOrden(id);
  const { data: o, isLoading, error, refetch } = useQuery({ queryKey: ['orden', id], queryFn: () => api.get(`/ordenes/${id}`), refetchInterval: 60_000 });
  const estado = useMutation({
    mutationFn: (e: EstadoOT) => api.post(`/ordenes/${id}/estado`, { estado: e }),
    onSuccess: (r) => { refrescar(); toast.ok(r.stock === 'descontado' ? 'Orden lista. Se descontaron los repuestos del stock.' : 'Estado actualizado'); },
    onError: toast.error,
  });
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  const cerrada = o.estado === 'entregada' || o.estado === 'cancelada';
  const puedeEditar = !cerrada && (puede('ordenes.modificar') || (puede('ordenes.trabajar_asignadas') && o.asignada_a_mi));
  const repuestos = o.items.filter((i: any) => i.tipo === 'articulo');
  const trabajos = o.items.filter((i: any) => i.tipo !== 'articulo');
  const vehiculo = [o.marca, o.modelo, o.anio].filter(Boolean).join(' ');
  const c = o.checklist;

  return (
    <div className="mx-auto max-w-2xl space-y-4 pb-10">
      <Encabezado volver="/mis-trabajos" titulo={<span className="flex flex-wrap items-center gap-2">{o.patente} <EstadoOTBadge estado={o.estado} /></span>} subtitulo={`OT #${numero(o.numero)}${vehiculo ? ` · ${vehiculo}` : ''}`} />

      <Tarjeta titulo="Vehículo y pedido">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <div><dt className="text-xs text-tenue">Patente</dt><dd className="text-lg font-bold tracking-wide">{o.patente}</dd></div>
          <div><dt className="text-xs text-tenue">Kilometraje de ingreso</dt><dd>{km(o.km_ingreso)}</dd></div>
          {o.cliente && <div className="col-span-2"><dt className="text-xs text-tenue">Cliente</dt><dd>{o.cliente}{o.cliente_telefono ? ` · ${o.cliente_telefono}` : ''}</dd></div>}
          <div className="col-span-2"><dt className="text-xs text-tenue">Falla reportada</dt><dd className="whitespace-pre-wrap">{o.falla_reportada || '—'}</dd></div>
          {o.observaciones && <div className="col-span-2"><dt className="text-xs text-tenue">Observaciones de recepción</dt><dd className="whitespace-pre-wrap">{o.observaciones}</dd></div>}
          {o.fecha_prometida && <div className="col-span-2"><dt className="text-xs text-tenue">Fecha prometida</dt><dd>{fecha(o.fecha_prometida)}</dd></div>}
        </dl>
        {c && (c.datos.danos?.length > 0 || c.datos.testigos?.length > 0 || c.observaciones) && (
          <div className="mt-3 space-y-1 border-t border-borde pt-3 text-sm">
            {c.datos.danos?.length > 0 && <p><span className="text-xs text-tenue">Daños al ingresar: </span>{c.datos.danos.join(', ')}</p>}
            {c.datos.testigos?.length > 0 && <p><span className="text-xs text-tenue">Testigos encendidos: </span>{c.datos.testigos.join(', ')}</p>}
            {c.observaciones && <p><span className="text-xs text-tenue">Observaciones del ingreso: </span>{c.observaciones}</p>}
          </div>
        )}
      </Tarjeta>

      {puedeEditar && (
        <Tarjeta titulo="Estado del trabajo">
          <div className="grid grid-cols-2 gap-2">
            {ESTADOS_TALLER.map((e) => (
              <Boton key={e} tam="lg" variante={o.estado === e ? 'primario' : 'secundario'} disabled={o.estado === e || estado.isPending} onClick={() => estado.mutate(e)} className="h-14 whitespace-normal text-center text-[15px] leading-tight">
                {ESTADO_OT_LABEL[e]}
              </Boton>
            ))}
          </div>
          {o.estado === 'lista' && <p className="mt-2 text-xs text-tenue">La entrega al cliente la registra el mostrador.</p>}
        </Tarjeta>
      )}
      {!puedeEditar && !cerrada && <Aviso tono="ambar">Podés ver esta orden pero no actualizarla. Pedile a recepción que te habilite el permiso o que la asigne a tu nombre.</Aviso>}
      {cerrada && <Aviso>La orden está {ESTADO_OT_LABEL[o.estado as EstadoOT].toLowerCase()}: ya no admite cambios.</Aviso>}

      <Tarjeta titulo="Tareas pendientes"><Tareas orden={o} puedeEditar={puedeEditar} /></Tarjeta>

      <Tarjeta titulo={`Repuestos requeridos${repuestos.length ? ` (${repuestos.length})` : ''}`}>
        {repuestos.length === 0 ? <p className="text-sm text-tenue">Esta orden no lleva repuestos.</p> : (
          <ul className="divide-y divide-borde">
            {repuestos.map((i: any) => (
              <li key={i.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <span className="flex min-w-0 items-center gap-2"><Package className="size-4 shrink-0 text-tenue" /><span className="truncate">{i.descripcion}</span></span>
                <span className="flex shrink-0 items-center gap-2">
                  <strong className="tabular-nums">{i.cantidad} {i.unidad && i.unidad !== 'un' ? i.unidad : ''}</strong>
                  {o.stock_aplicado ? <Insignia tono="gris">Descontado</Insignia> : i.articulo_stock != null && <Insignia tono={i.articulo_stock >= i.cantidad ? 'verde' : 'rojo'}>{i.articulo_stock >= i.cantidad ? 'Hay stock' : 'Falta stock'}</Insignia>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Tarjeta>

      {trabajos.length > 0 && (
        <Tarjeta titulo="Trabajos a realizar">
          <ul className="list-disc space-y-1 pl-5 text-sm">{trabajos.map((i: any) => <li key={i.id}>{i.descripcion}{i.cantidad !== 1 ? ` ×${i.cantidad}` : ''}</li>)}</ul>
        </Tarjeta>
      )}

      <Tarjeta titulo="Diagnóstico y observaciones técnicas"><NotasTecnicas orden={o} puedeEditar={puedeEditar} /></Tarjeta>
      <Tarjeta titulo="Tiempo dedicado"><Cronometro orden={o} puedeEditar={puedeEditar} /></Tarjeta>
      <Boton variante="fantasma" className="w-full" onClick={() => nav('/mis-trabajos')}>Volver a mis trabajos</Boton>
    </div>
  );
}
