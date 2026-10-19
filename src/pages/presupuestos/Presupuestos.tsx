import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { FileText, Plus } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { fecha, money, numero } from '@/lib/format';
import { Boton, Buscador, Cargando, Encabezado, ErrorCaja, Select, Tabla, Tarjeta, useDebounce, Vacio } from '@/components/ui';
import { EstadoPresupuestoBadge } from '@/components/estados';
import { ESTADOS_PRESUPUESTO, ESTADO_PRESUPUESTO_LABEL } from '@shared/dominio';

export function Presupuestos() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [estado, setEstado] = useState('');
  const dq = useDebounce(q);
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['presupuestos', { dq, estado }], queryFn: () => api.get<any[]>(`/presupuestos${qs({ q: dq, estado })}`) });
  return (
    <>
      <Encabezado titulo="Presupuestos" subtitulo="Cotizaciones para el cliente; al aprobarse se convierten en órdenes de trabajo" acciones={<Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => nav('/presupuestos/nuevo')}>Nuevo presupuesto</Boton>} />
      <div className="mb-4 flex flex-wrap gap-2">
        <Buscador value={q} onChange={setQ} placeholder="Cliente, patente o número" className="min-w-56 flex-1" />
        <Select value={estado} onChange={(e) => setEstado(e.target.value)} className="w-auto">
          <option value="">Todos los estados</option>
          {ESTADOS_PRESUPUESTO.map((e) => <option key={e} value={e}>{ESTADO_PRESUPUESTO_LABEL[e]}</option>)}
          <option value="vencido">Vencidos</option>
        </Select>
      </div>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={data}
            clave={(p) => p.id}
            onFila={(p) => nav(`/presupuestos/${p.id}`)}
            vacio={<Vacio icono={<FileText className="size-5" />} titulo="No hay presupuestos" accion={<Boton variante="primario" onClick={() => nav('/presupuestos/nuevo')}>Crear presupuesto</Boton>} />}
            columnas={[
              { clave: 'n', titulo: 'N°', render: (p) => <span className="font-medium">P-{numero(p.numero)}</span>, movil: 'meta' },
              { clave: 'f', titulo: 'Fecha', render: (p) => fecha(p.fecha), movil: 'meta' },
              { clave: 'c', titulo: 'Cliente', render: (p) => p.cliente, movil: 'titulo' },
              { clave: 'v', titulo: 'Vehículo', render: (p) => <span><span className="font-semibold tracking-wide">{p.patente}</span> <span className="text-tenue">{[p.marca, p.modelo].filter(Boolean).join(' ')}</span></span>, movil: 'subtitulo' },
              { clave: 'vh', titulo: 'Válido hasta', render: (p) => fecha(p.valido_hasta), movil: 'oculta' },
              { clave: 'e', titulo: 'Estado', render: (p) => <EstadoPresupuestoBadge estado={p.estado} vencido={p.vencido} />, movil: 'meta' },
              { clave: 't', titulo: 'Total', render: (p) => money(p.total), alinear: 'derecha', movil: 'derecha' },
            ]}
          />
        </Tarjeta>
      )}
    </>
  );
}
