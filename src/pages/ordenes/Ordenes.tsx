import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Banknote, CheckCircle2, Clock, Columns3, Landmark, List, Plus, Wrench, XCircle } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fecha, money, numero } from '@/lib/format';
import { Boton, Buscador, Cargando, cn, Encabezado, ErrorCaja, Segmentado, Select, Tabla, Tarjeta, useDebounce, Vacio } from '@/components/ui';
import { EstadoOTBadge, TONO_OT } from '@/components/estados';
import { useMecanicos } from '@/components/selectores';
import { usePagosPendientes } from '@/components/PagoCliente';
import { ESTADOS_OT, ESTADOS_OT_ABIERTOS, ESTADO_OT_LABEL } from '@shared/dominio';

const BORDE: Record<string, string> = {
  gris: 'border-t-slate-400', violeta: 'border-t-violet-500', azul: 'border-t-marca-500', ambar: 'border-t-amber-500', verde: 'border-t-emerald-500', cian: 'border-t-cyan-500', rojo: 'border-t-red-500',
};

type Pago = { medio: 'efectivo' | 'transferencia'; estado: 'sin_comprobante' | 'pendiente' | 'verificado' | 'rechazado' | null } | null | undefined;

/** Colores del medio de pago elegido por el cliente (independientes del color de la columna) e indicador de la esquina inferior derecha. */
function estiloPago(p: Pago) {
  if (!p) return { clase: 'border-borde bg-white', ind: null as null | { texto: string; icono: JSX.Element } };
  if (p.medio === 'efectivo') return { clase: 'border-emerald-200 bg-emerald-50', ind: { texto: 'Pago previsto en efectivo', icono: <Banknote className="size-4 text-emerald-700" /> } };
  const ind = {
    sin_comprobante: { texto: 'Transferencia seleccionada — sin comprobante', icono: <Landmark className="size-4 text-sky-700" /> },
    pendiente: { texto: 'Comprobante pendiente de verificación', icono: <Clock className="size-4 text-amber-600" /> },
    verificado: { texto: 'Transferencia verificada', icono: <CheckCircle2 className="size-4 text-emerald-600" /> },
    rechazado: { texto: 'Comprobante rechazado', icono: <XCircle className="size-4 text-red-600" /> },
  }[p.estado ?? 'sin_comprobante'];
  return { clase: 'border-sky-200 bg-sky-50', ind };
}

export function Ordenes() {
  const nav = useNavigate();
  const { puede } = useAuth();
  const [sp, setSp] = useSearchParams();
  const estado = sp.get('estado') ?? 'abiertas';
  // Filtro de los comprobantes de transferencia pendientes de verificar (se abre desde el aviso discreto de esta pantalla y de Inicio).
  const comprobantes = sp.get('comprobantes') === 'pendientes' ? 'pendientes' : '';
  const { data: pagos } = usePagosPendientes();
  const [vista, setVista] = useState<'tablero' | 'lista'>(() => (localStorage.getItem('fierro.vistaOT') as 'tablero' | 'lista') ?? 'tablero');
  const [q, setQ] = useState('');
  const [mecanico, setMecanico] = useState('');
  const dq = useDebounce(q);
  const { data: mecanicos = [] } = useMecanicos();
  const { data = [], isLoading, error, refetch } = useQuery({
    queryKey: ['ordenes', { estado, dq, mecanico, comprobantes }],
    queryFn: () => api.get<any[]>(`/ordenes${qs({ estado: comprobantes ? 'todas' : estado, q: dq, mecanico_id: mecanico, comprobantes })}`),
  });
  const cambiarVista = (v: 'tablero' | 'lista') => {
    setVista(v);
    localStorage.setItem('fierro.vistaOT', v);
  };
  const tablero = vista === 'tablero' && estado === 'abiertas' && !comprobantes;

  return (
    <>
      <Encabezado titulo="Órdenes de trabajo" subtitulo="Seguimiento de los vehículos en el taller" acciones={puede('ordenes.crear') && <Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => nav('/ordenes/nueva')}>Nueva OT</Boton>} />
      {pagos && pagos.total > 0 && !comprobantes && (
        <Link to="/ordenes?comprobantes=pendientes" className="mb-3 flex items-center justify-between gap-3 rounded-card border border-amber-200 bg-amber-50 px-3.5 py-2 text-sm text-amber-900 hover:bg-amber-100">
          <span><strong>{pagos.total}</strong> {pagos.total === 1 ? 'comprobante pendiente' : 'comprobantes pendientes'} de verificar</span>
          <span className="font-medium">Ver órdenes →</span>
        </Link>
      )}
      {comprobantes && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-card border border-amber-200 bg-amber-50 px-3.5 py-2 text-sm text-amber-900">
          <span>Mostrando las órdenes con comprobantes de transferencia pendientes de verificar</span>
          <button type="button" className="font-medium underline" onClick={() => setSp({})}>Quitar filtro</button>
        </div>
      )}
      <div className="filtros mb-4 flex flex-wrap items-center gap-2">
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
          <Segmentado activo={vista} onCambio={cambiarVista} items={[{ clave: 'tablero', titulo: 'Tablero', icono: <Columns3 className="size-4" /> }, { clave: 'lista', titulo: 'Lista', icono: <List className="size-4" /> }]} />
        )}
      </div>

      {isLoading ? (
        <Cargando />
      ) : error ? (
        <ErrorCaja error={error} reintentar={refetch} />
      ) : tablero ? (
        // Las columnas se reparten en filas según el ancho disponible: el tablero nunca obliga a desplazarse en horizontal.
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(16.5rem,100%),1fr))] items-start gap-3">
          {ESTADOS_OT_ABIERTOS.map((e) => {
            const col = data.filter((o) => o.estado === e);
            return (
              <div key={e} className={cn('min-w-0 rounded-card border border-t-4 border-borde bg-superficie-2', BORDE[TONO_OT[e]])}>
                <div className="flex items-center justify-between px-3 py-2.5">
                  <span className="text-sm font-semibold">{ESTADO_OT_LABEL[e]}</span>
                  <span className="rounded-full bg-white px-2 text-xs font-medium text-tenue ring-1 ring-borde">{col.length}</span>
                </div>
                <div className="space-y-2 px-2 pb-2">
                  {col.map((o) => {
                    const est = estiloPago(o.pago);
                    return (
                    <Link key={o.id} to={`/ordenes/${o.id}`} className={cn('relative block rounded-ctl border p-3 shadow-card transition hover:border-marca-300 hover:shadow-pop', est.clase, est.ind && 'pb-7')}>
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
                      {est.ind && (
                        <span role="img" aria-label={est.ind.texto} title={est.ind.texto} className="absolute bottom-1.5 right-2 grid size-5 place-items-center rounded-full bg-white/80 ring-1 ring-black/5">
                          {est.ind.icono}
                        </span>
                      )}
                    </Link>
                    );
                  })}
                  {!col.length && <p className="px-1 py-4 text-center text-xs text-slate-500">—</p>}
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
