import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Columns3, List, Plus, Wrench } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fecha, money, numero } from '@/lib/format';
import { Boton, Buscador, Cargando, Encabezado, ErrorCaja, Select, Tabla, Tarjeta, useDebounce, Vacio, cn } from '@/components/ui';
import { EstadoOTBadge, TONO_OT } from '@/components/estados';
import { useMecanicos } from '@/components/selectores';
import { ESTADOS_OT, ESTADOS_OT_ABIERTOS, ESTADO_OT_LABEL } from '@shared/dominio';

const BORDE: Record<string, string> = {
  gris: 'border-t-slate-400', violeta: 'border-t-violet-500', azul: 'border-t-marca-500', ambar: 'border-t-amber-500', verde: 'border-t-emerald-500', cian: 'border-t-cyan-500', rojo: 'border-t-red-500',
};

export function Ordenes() {
  const nav = useNavigate();
  const { puede } = useAuth();
  const [sp, setSp] = useSearchParams();
  const estado = sp.get('estado') ?? 'abiertas';
  const [vista, setVista] = useState<'tablero' | 'lista'>(() => (localStorage.getItem('fierro.vistaOT') as 'tablero' | 'lista') ?? 'tablero');
  const [q, setQ] = useState('');
  const [mecanico, setMecanico] = useState('');
  const dq = useDebounce(q);
  const { data: mecanicos = [] } = useMecanicos();
  const { data = [], isLoading, error, refetch } = useQuery({
    queryKey: ['ordenes', { estado, dq, mecanico }],
    queryFn: () => api.get<any[]>(`/ordenes${qs({ estado, q: dq, mecanico_id: mecanico })}`),
  });
  const cambiarVista = (v: 'tablero' | 'lista') => {
    setVista(v);
    localStorage.setItem('fierro.vistaOT', v);
  };
  const tablero = vista === 'tablero' && estado === 'abiertas';

  return (
    <>
      <Encabezado titulo="Órdenes de trabajo" subtitulo="Seguimiento de los vehículos en el taller" acciones={puede('ordenes.crear') && <Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => nav('/ordenes/nueva')}>Nueva OT</Boton>} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Buscador value={q} onChange={setQ} placeholder="Patente, cliente o N° de OT" className="min-w-56 flex-1" />
        <Select value={estado} onChange={(e) => setSp(e.target.value === 'abiertas' ? {} : { estado: e.target.value })} className="w-auto">
          <option value="abiertas">Abiertas</option>
          {ESTADOS_OT.map((e) => <option key={e} value={e}>{ESTADO_OT_LABEL[e]}</option>)}
          <option value="todas">Todas</option>
        </Select>
        <Select value={mecanico} onChange={(e) => setMecanico(e.target.value)} className="w-auto">
          <option value="">Todos los mecánicos</option>
          {mecanicos.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
        </Select>
        {estado === 'abiertas' && (
          <div className="flex rounded-lg border border-borde bg-white p-0.5">
            <button type="button" onClick={() => cambiarVista('tablero')} className={cn('flex items-center gap-1 rounded-md px-2.5 py-1.5 text-sm', vista === 'tablero' ? 'bg-marca-50 text-marca-700' : 'text-tenue')}><Columns3 className="size-4" /> Tablero</button>
            <button type="button" onClick={() => cambiarVista('lista')} className={cn('flex items-center gap-1 rounded-md px-2.5 py-1.5 text-sm', vista === 'lista' ? 'bg-marca-50 text-marca-700' : 'text-tenue')}><List className="size-4" /> Lista</button>
          </div>
        )}
      </div>

      {isLoading ? (
        <Cargando />
      ) : error ? (
        <ErrorCaja error={error} reintentar={refetch} />
      ) : tablero ? (
        <div className="-mx-3 flex gap-3 overflow-x-auto px-3 pb-3 sm:mx-0 sm:px-0">
          {ESTADOS_OT_ABIERTOS.map((e) => {
            const col = data.filter((o) => o.estado === e);
            return (
              <div key={e} className={cn('w-72 shrink-0 rounded-xl border border-t-4 border-borde bg-slate-50/70', BORDE[TONO_OT[e]])}>
                <div className="flex items-center justify-between px-3 py-2.5">
                  <span className="text-sm font-semibold">{ESTADO_OT_LABEL[e]}</span>
                  <span className="rounded-full bg-white px-2 text-xs font-medium text-tenue ring-1 ring-borde">{col.length}</span>
                </div>
                <div className="space-y-2 px-2 pb-2">
                  {col.map((o) => (
                    <Link key={o.id} to={`/ordenes/${o.id}`} className="block rounded-lg border border-borde bg-white p-3 shadow-sm transition hover:border-marca-300 hover:shadow">
                      <div className="flex items-center justify-between">
                        <span className="font-bold tracking-wide">{o.patente}</span>
                        <span className="text-xs text-tenue">#{numero(o.numero)}</span>
                      </div>
                      <div className="truncate text-sm">{[o.marca, o.modelo].filter(Boolean).join(' ') || 'Vehículo'}</div>
                      <div className="truncate text-xs text-tenue">{o.cliente}</div>
                      <div className="mt-2 flex items-center justify-between text-xs">
                        <span className="text-tenue">{o.mecanico ?? 'Sin mecánico'}</span>
                        {o.total !== undefined && <span className="font-semibold tabular-nums">{money(o.total)}</span>}
                      </div>
                      {o.fecha_prometida && <div className={cn('mt-1 text-xs', o.fecha_prometida < new Date().toISOString().slice(0, 10) ? 'font-medium text-red-600' : 'text-tenue')}>Prometida: {fecha(o.fecha_prometida)}</div>}
                    </Link>
                  ))}
                  {!col.length && <p className="px-1 py-4 text-center text-xs text-slate-400">—</p>}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <Tarjeta sinPadding>
          <Tabla
            filas={data}
            clave={(o) => o.id}
            onFila={(o) => nav(`/ordenes/${o.id}`)}
            vacio={<Vacio icono={<Wrench className="size-5" />} titulo="No hay órdenes con este filtro" />}
            columnas={[
              { clave: 'n', titulo: 'OT', render: (o) => <span className="font-medium">#{numero(o.numero)}</span>, movil: 'meta' },
              { clave: 'p', titulo: 'Vehículo', render: (o) => <span><span className="font-semibold tracking-wide">{o.patente}</span> <span className="text-tenue">{[o.marca, o.modelo].filter(Boolean).join(' ')}</span></span>, movil: 'titulo' },
              { clave: 'c', titulo: 'Cliente', render: (o) => o.cliente ?? '—', movil: 'subtitulo' },
              { clave: 'm', titulo: 'Mecánico', render: (o) => o.mecanico ?? '—', movil: 'meta' },
              { clave: 'f', titulo: 'Ingreso', render: (o) => fecha(o.fecha_ingreso), movil: 'meta' },
              { clave: 'e', titulo: 'Estado', render: (o) => <EstadoOTBadge estado={o.estado} />, movil: 'meta' },
              ...(puede('presupuestos.valorizados.ver') ? [{ clave: 't', titulo: 'Total', render: (o: any) => money(o.total), alinear: 'derecha' as const, movil: 'derecha' as const }] : []),
            ]}
          />
        </Tarjeta>
      )}
    </>
  );
}
