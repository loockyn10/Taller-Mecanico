import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Bell, MessageCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fecha, km, whatsapp } from '@/lib/format';
import { Boton, Cargando, Encabezado, ErrorCaja, Insignia, Tabla, Tarjeta, Vacio } from '@/components/ui';

export function Recordatorios() {
  const { me } = useAuth();
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['recordatorios'], queryFn: () => api.get<any[]>('/recordatorios') });
  return (
    <>
      <Encabezado titulo="Recordatorios de service" subtitulo="Services vencidos o próximos según kilometraje y tiempo, calculados a partir de los trabajos realizados" />
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={data}
            clave={(r) => `${r.vehiculo_id}-${r.servicio}`}
            vacio={<Vacio icono={<Bell className="size-5" />} titulo="No hay services vencidos ni próximos" texto="Los recordatorios se generan al entregar OT con servicios que tienen intervalo de km o meses." />}
            columnas={[
              { clave: 'p', titulo: 'Vehículo', render: (r) => <Link to={`/vehiculos/${r.vehiculo_id}`} className="font-semibold tracking-wide text-marca-700">{r.patente}</Link>, movil: 'titulo' },
              { clave: 'c', titulo: 'Cliente', render: (r) => r.cliente, movil: 'subtitulo' },
              { clave: 's', titulo: 'Service', render: (r) => r.servicio, movil: 'meta' },
              { clave: 'k', titulo: 'Próximo', render: (r) => [r.proximo_km ? km(r.proximo_km) : null, r.proxima_fecha ? fecha(r.proxima_fecha) : null].filter(Boolean).join(' / '), movil: 'meta' },
              { clave: 'e', titulo: 'Estado', render: (r) => <Insignia tono={r.estado === 'vencido' ? 'rojo' : 'ambar'}>{r.estado === 'vencido' ? 'Vencido' : 'Próximo'}</Insignia>, movil: 'derecha' },
              {
                clave: 'w',
                titulo: '',
                render: (r) => {
                  const wa = whatsapp(r.cliente_telefono, `Hola ${r.cliente}! Te recordamos desde ${me?.taller.nombre} que tu vehículo ${r.patente} tiene pendiente: ${r.servicio}. ¿Querés que te reservemos un turno?`);
                  return wa ? <a href={wa} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}><Boton tam="sm" icono={<MessageCircle className="size-4" />}>Avisar</Boton></a> : <span className="text-xs text-tenue">Sin teléfono</span>;
                },
                movil: 'meta',
              },
            ]}
          />
        </Tarjeta>
      )}
    </>
  );
}
