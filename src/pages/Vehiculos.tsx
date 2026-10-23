import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Car, Pencil, Plus, Wrench } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fecha, km } from '@/lib/format';
import { Boton, Buscador, Cargando, Dato, Encabezado, ErrorCaja, Modal, Tabla, Tarjeta, useDebounce, Vacio } from '@/components/ui';
import { HistorialTecnico } from '@/components/HistorialTecnico';
import { AccionesMantenimiento, EstadoMantenimiento, FormPlanMantenimiento, proximoTexto, type MantenimientoApi } from '@/components/Mantenimientos';
import { FormVehiculo } from '@/components/selectores';
import { GaleriaFotos, usePermisosFotos } from '@/components/Fotos';

export function Vehiculos() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const dq = useDebounce(q);
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['vehiculos', { q: dq }], queryFn: () => api.get<any[]>(`/vehiculos?q=${encodeURIComponent(dq)}`) });
  return (
    <>
      <Encabezado titulo="Vehículos" subtitulo="Para registrar un vehículo, abrí la ficha de su dueño" />
      <Buscador value={q} onChange={setQ} placeholder="Patente, cliente, marca o modelo" className="mb-4" />
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={data}
            clave={(v) => v.id}
            onFila={(v) => nav(`/vehiculos/${v.id}`)}
            vacio={<Vacio icono={<Car className="size-5" />} titulo="No hay vehículos" />}
            columnas={[
              { clave: 'p', titulo: 'Patente', render: (v) => <span className="font-semibold tracking-wide">{v.patente}</span>, movil: 'titulo' },
              { clave: 'm', titulo: 'Vehículo', render: (v) => [v.marca, v.modelo, v.anio].filter(Boolean).join(' ') || '—', movil: 'subtitulo' },
              { clave: 'c', titulo: 'Cliente', render: (v) => v.cliente, movil: 'meta' },
              { clave: 'k', titulo: 'Km', alinear: 'derecha', render: (v) => km(v.km_actual), movil: 'derecha' },
            ]}
          />
        </Tarjeta>
      )}
    </>
  );
}

function MantenimientosVehiculo({ v }: { v: any }) {
  const { puede, me } = useAuth();
  const [form, setForm] = useState<{ inicial: MantenimientoApi | null } | null>(null);
  const { data = [], isLoading } = useQuery({ queryKey: ['mantenimientos', 'vehiculo', v.id], queryFn: () => api.get<MantenimientoApi[]>(`/vehiculos/${v.id}/mantenimientos`) });
  return (
    <Tarjeta titulo="Mantenimientos" subtitulo="Próximos vencimientos por kilometraje y tiempo" acciones={puede('mantenimientos.gestionar') && <Boton tam="sm" icono={<Plus className="size-4" />} onClick={() => setForm({ inicial: null })}>Programar</Boton>}>
      {isLoading ? <Cargando /> : data.length === 0 ? (
        <p className="text-sm text-tenue">Sin mantenimientos programados. Se arman solos con los servicios que tienen intervalo, o podés programarlos a mano.</p>
      ) : (
        <ul className="space-y-3 text-sm">
          {data.map((m) => (
            <li key={m.servicio_id} className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <button type="button" className="text-left" onClick={() => puede('mantenimientos.gestionar') && setForm({ inicial: m })}>
                  <span className="block font-medium">{m.servicio}</span>
                  <span className="block text-xs text-tenue">{m.fecha_realizado ? `Último: ${fecha(m.fecha_realizado)}${m.km_realizado != null ? ` · ${km(m.km_realizado)}` : ''}${m.origen_realizado === 'antecedente' ? ' (antecedente)' : ''}` : 'Sin realización registrada'}</span>
                  <span className="block text-xs text-tenue">Próximo: {proximoTexto(m)}</span>
                </button>
                <EstadoMantenimiento m={m} />
              </div>
              {m.estado !== 'al_dia' && <AccionesMantenimiento m={{ ...m, cliente: v.cliente, cliente_telefono: v.cliente_telefono }} clienteId={v.cliente_id} tallerNombre={me?.taller.nombre} />}
            </li>
          ))}
        </ul>
      )}
      {form && <FormPlanMantenimiento vehiculoId={v.id} inicial={form.inicial} onCerrar={() => setForm(null)} />}
    </Tarjeta>
  );
}

export function VehiculoDetalle() {
  const { id } = useParams();
  const { puede } = useAuth();
  const nav = useNavigate();
  const [editar, setEditar] = useState(false);
  const permisosFotos = usePermisosFotos();
  const { data: v, isLoading, error, refetch } = useQuery({ queryKey: ['vehiculo', id], queryFn: () => api.get(`/vehiculos/${id}`) });
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  return (
    <>
      <Encabezado
        volver
        titulo={<span className="tracking-wide">{v.patente}</span>}
        subtitulo={[v.marca, v.modelo, v.anio, v.color].filter(Boolean).join(' · ') || 'Sin datos del modelo'}
        acciones={
          <>
            <Boton icono={<Pencil className="size-4" />} onClick={() => setEditar(true)}>Editar</Boton>
            <Boton variante="primario" icono={<Wrench className="size-4" />} onClick={() => nav(`/ordenes/nueva?cliente=${v.cliente_id}&vehiculo=${v.id}`)}>Nueva OT</Boton>
          </>
        }
      />
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {permisosFotos.ver && (
            <Tarjeta titulo="Fotografías" subtitulo="Del vehículo y de sus órdenes de trabajo (cada foto se guarda una sola vez)">
              <GaleriaFotos vehiculoId={v.id} puedeSubir={permisosFotos.subir} puedeEliminar={permisosFotos.eliminar} filtros />
            </Tarjeta>
          )}
          <HistorialTecnico vehiculoId={v.id} />
        </div>
        <div className="space-y-5">
          <Tarjeta titulo="Ficha">
            <dl className="grid grid-cols-2 gap-4">
              <Dato etiqueta="Dueño"><Link to={`/clientes/${v.cliente_id}`} className="text-marca-700">{v.cliente}</Link></Dato>
              <Dato etiqueta="Teléfono">{v.cliente_telefono}</Dato>
              <Dato etiqueta="Kilometraje">{km(v.km_actual)}</Dato>
              <Dato etiqueta="Combustible">{v.combustible}</Dato>
              <Dato etiqueta="Versión">{v.version}</Dato>
              <Dato etiqueta="Motor">{v.motor}</Dato>
              <Dato etiqueta="Chasis">{v.vin}</Dato>
              <Dato etiqueta="Notas" className="col-span-2">{v.notas}</Dato>
            </dl>
          </Tarjeta>
          {puede('mantenimientos.ver') && <MantenimientosVehiculo v={v} />}
        </div>
      </div>
      <Modal abierto={editar} onCerrar={() => setEditar(false)} titulo="Editar vehículo" ancho="lg">
        <FormVehiculo clienteId={v.cliente_id} inicial={v} onCancelar={() => setEditar(false)} onGuardado={() => setEditar(false)} />
      </Modal>
    </>
  );
}
