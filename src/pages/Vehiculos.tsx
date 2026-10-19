import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Car, History, Pencil, Wrench } from 'lucide-react';
import { api } from '@/lib/api';
import { fecha, km, money, numero } from '@/lib/format';
import { Boton, Buscador, Cargando, Dato, Encabezado, ErrorCaja, Insignia, Modal, Tabla, Tarjeta, useDebounce, Vacio } from '@/components/ui';
import { EstadoOTBadge } from '@/components/estados';
import { FormVehiculo } from '@/components/selectores';

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

export function VehiculoDetalle() {
  const { id } = useParams();
  const nav = useNavigate();
  const [editar, setEditar] = useState(false);
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
        <Tarjeta titulo="Historial de reparaciones" className="lg:col-span-2" acciones={<Insignia>{v.historial.length} ingresos</Insignia>}>
          {v.historial.length === 0 ? (
            <Vacio icono={<History className="size-5" />} titulo="Sin trabajos registrados" />
          ) : (
            <ol className="relative space-y-5 border-l border-borde pl-5">
              {v.historial.map((o: any) => (
                <li key={o.id}>
                  <span className="absolute -left-1.5 mt-1.5 size-3 rounded-full border-2 border-white bg-marca-500" />
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to={`/ordenes/${o.id}`} className="font-semibold text-marca-700">OT #{numero(o.numero)}</Link>
                    <EstadoOTBadge estado={o.estado} />
                    <span className="text-sm text-tenue">{fecha(o.fecha_entregada ?? o.fecha_ingreso)} · {km(o.km_ingreso)}</span>
                  </div>
                  {o.falla_reportada && <p className="mt-1 text-sm"><span className="text-tenue">Motivo:</span> {o.falla_reportada}</p>}
                  {o.diagnostico && <p className="text-sm"><span className="text-tenue">Diagnóstico:</span> {o.diagnostico}</p>}
                  <ul className="mt-1.5 flex flex-wrap gap-1.5">
                    {o.items.map((i: any, idx: number) => <li key={idx}><Insignia tono={i.tipo === 'articulo' ? 'cian' : 'azul'}>{i.descripcion}{i.cantidad !== 1 ? ` ×${i.cantidad}` : ''}</Insignia></li>)}
                  </ul>
                  <div className="mt-1 text-xs text-tenue">{o.mecanico ? `Mecánico: ${o.mecanico} · ` : ''}{money(o.total)}</div>
                </li>
              ))}
            </ol>
          )}
        </Tarjeta>
        <div className="space-y-5">
          <Tarjeta titulo="Ficha">
            <dl className="grid grid-cols-2 gap-4">
              <Dato etiqueta="Dueño"><Link to={`/clientes/${v.cliente_id}`} className="text-marca-700">{v.cliente}</Link></Dato>
              <Dato etiqueta="Teléfono">{v.cliente_telefono}</Dato>
              <Dato etiqueta="Kilometraje">{km(v.km_actual)}</Dato>
              <Dato etiqueta="Combustible">{v.combustible}</Dato>
              <Dato etiqueta="Motor">{v.motor}</Dato>
              <Dato etiqueta="Chasis">{v.vin}</Dato>
              <Dato etiqueta="Notas" className="col-span-2">{v.notas}</Dato>
            </dl>
          </Tarjeta>
          <Tarjeta titulo="Próximos services">
            {v.proximos.length === 0 ? (
              <p className="text-sm text-tenue">Sin services con intervalo registrados todavía.</p>
            ) : (
              <ul className="space-y-3 text-sm">
                {v.proximos.map((p: any, i: number) => (
                  <li key={i} className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium">{p.servicio}</div>
                      <div className="text-xs text-tenue">{p.proximo_km ? `A los ${km(p.proximo_km)}` : ''}{p.proximo_km && p.proxima_fecha ? ' o ' : ''}{p.proxima_fecha ? `el ${fecha(p.proxima_fecha)}` : ''}</div>
                    </div>
                    <Insignia tono={p.estado === 'vencido' ? 'rojo' : p.estado === 'proximo' ? 'ambar' : 'verde'}>{p.estado === 'vencido' ? 'Vencido' : p.estado === 'proximo' ? 'Próximo' : 'Al día'}</Insignia>
                  </li>
                ))}
              </ul>
            )}
          </Tarjeta>
        </div>
      </div>
      <Modal abierto={editar} onCerrar={() => setEditar(false)} titulo="Editar vehículo" ancho="lg">
        <FormVehiculo clienteId={v.cliente_id} inicial={v} onCancelar={() => setEditar(false)} onGuardado={() => setEditar(false)} />
      </Modal>
    </>
  );
}
