// Mantenimientos programados: qué vehículos tienen mantenimientos vencidos o próximos, calculados con el kilometraje de las
// órdenes de trabajo y las fechas de las últimas realizaciones. Desde acá se genera un turno o un presupuesto.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, Bell, CheckCircle2, CircleHelp, Clock } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fecha, km } from '@/lib/format';
import { Buscador, Cargando, Encabezado, ErrorCaja, Indicador, Select, Tabla, Tarjeta, useDebounce, Vacio } from '@/components/ui';
import { AccionesMantenimiento, EstadoMantenimiento, proximoTexto, type MantenimientoApi } from '@/components/Mantenimientos';

type Filtro = 'pendientes' | 'vencido' | 'proximo' | 'sin_registro' | 'al_dia';

export function Mantenimientos() {
  const { me } = useAuth();
  const [filtro, setFiltro] = useState<Filtro>('pendientes');
  const [q, setQ] = useState('');
  const dq = useDebounce(q);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['mantenimientos', filtro, dq],
    queryFn: () => api.get<{ resumen: Record<'vencido' | 'proximo' | 'sin_registro' | 'al_dia', number>; items: MantenimientoApi[] }>(`/mantenimientos${qs({ estado: filtro, q: dq })}`),
  });
  const r = data?.resumen;
  return (
    <>
      <Encabezado titulo="Mantenimientos" subtitulo="Vencimientos por kilometraje y por tiempo. Desde acá generás un turno o un presupuesto; no se envía nada automáticamente" />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Indicador titulo="Vencidos" valor={r?.vencido ?? '—'} tono="rojo" icono={<AlertTriangle className="size-5" />} onClick={() => setFiltro('vencido')} />
        <Indicador titulo="Próximos" valor={r?.proximo ?? '—'} detalle="Hasta 1.000 km o 30 días" tono="ambar" icono={<Clock className="size-5" />} onClick={() => setFiltro('proximo')} />
        <Indicador titulo="Sin registro" valor={r?.sin_registro ?? '—'} detalle="Falta la última realización" tono="gris" icono={<CircleHelp className="size-5" />} onClick={() => setFiltro('sin_registro')} />
        <Indicador titulo="Al día" valor={r?.al_dia ?? '—'} tono="verde" icono={<CheckCircle2 className="size-5" />} onClick={() => setFiltro('al_dia')} />
      </div>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <Buscador value={q} onChange={setQ} placeholder="Patente, cliente o mantenimiento" className="flex-1" />
        <Select aria-label="Estado" className="sm:w-56" value={filtro} onChange={(e) => setFiltro(e.target.value as Filtro)}>
          <option value="pendientes">Vencidos y próximos</option>
          <option value="vencido">Solo vencidos</option>
          <option value="proximo">Solo próximos</option>
          <option value="sin_registro">Sin registro</option>
          <option value="al_dia">Al día</option>
        </Select>
      </div>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={data?.items ?? []}
            clave={(m) => `${m.vehiculo_id}-${m.servicio_id}`}
            vacio={<Vacio icono={<Bell className="size-5" />} titulo="No hay mantenimientos en este estado" texto="Se generan con los servicios que tienen intervalo de km o meses al terminar las órdenes de trabajo, o programándolos desde la ficha de cada vehículo." />}
            columnas={[
              { clave: 'p', titulo: 'Vehículo', render: (m) => <Link to={`/vehiculos/${m.vehiculo_id}`} className="font-semibold tracking-wide text-marca-700">{m.patente}</Link>, movil: 'titulo' },
              { clave: 'c', titulo: 'Cliente', render: (m) => m.cliente ?? '—', movil: 'subtitulo' },
              { clave: 's', titulo: 'Mantenimiento', render: (m) => <span><span className="font-medium">{m.servicio}</span>{m.programado && <span className="ml-1 text-xs text-tenue">(programado)</span>}</span>, movil: 'meta' },
              { clave: 'u', titulo: 'Última vez', render: (m) => m.fecha_realizado ? `${fecha(m.fecha_realizado)}${m.km_realizado != null ? ` · ${km(m.km_realizado)}` : ''}` : '—', movil: 'oculta' },
              { clave: 'k', titulo: 'Próximo', render: (m) => <span className="text-xs">{proximoTexto(m)}<span className="block text-tenue">Km actual: {km(m.km_actual)}</span></span>, movil: 'meta' },
              { clave: 'e', titulo: 'Estado', render: (m) => <EstadoMantenimiento m={m} />, movil: 'derecha' },
              { clave: 'a', titulo: '', render: (m) => (m.estado === 'al_dia' ? null : <AccionesMantenimiento m={m} clienteId={m.cliente_id} tallerNombre={me?.taller.nombre} />), movil: 'meta' },
            ]}
          />
        </Tarjeta>
      )}
    </>
  );
}
