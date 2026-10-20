import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, Banknote, CalendarDays, CheckCircle2, FileText, Package, Plus, Receipt, Wallet, Wrench } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { money, numero } from '@/lib/format';
import { useEstadoCaja } from '@/lib/caja';
import { Boton, Cargando, Encabezado, ErrorCaja, Indicador, Tarjeta, Vacio } from '@/components/ui';
import { EstadoOTBadge, EstadoTurnoBadge } from '@/components/estados';
import { ESTADOS_OT_ABIERTOS, ESTADO_OT_LABEL, type EstadoOT } from '@shared/dominio';

export function Inicio() {
  const { me, puede } = useAuth();
  const nav = useNavigate();
  const { data: caja } = useEstadoCaja();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get('/dashboard'), refetchInterval: 60_000 });
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  const cant = (e: EstadoOT) => data.porEstado.find((x: any) => x.estado === e)?.cantidad ?? 0;
  const abiertas = ESTADOS_OT_ABIERTOS.reduce((a, e) => a + cant(e), 0);
  const hora = new Date().getHours();
  const saludo = hora < 12 ? 'Buen día' : hora < 20 ? 'Buenas tardes' : 'Buenas noches';

  return (
    <>
      <Encabezado
        titulo={`${saludo}, ${me?.usuario.nombre.split(' ')[0]}`}
        subtitulo={new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' })}
        acciones={
          <>
            <Boton icono={<FileText className="size-4" />} onClick={() => nav('/presupuestos/nuevo')}>Presupuesto</Boton>
            <Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => nav('/ordenes/nueva')}>Nueva OT</Boton>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Indicador titulo="OT abiertas" valor={abiertas} detalle={`${cant('en_reparacion')} en reparación`} icono={<Wrench className="size-5" />} onClick={() => nav('/ordenes')} />
        <Indicador titulo="Listas p/ entregar" valor={cant('lista')} icono={<CheckCircle2 className="size-5" />} tono="verde" onClick={() => nav('/ordenes?estado=lista')} />
        <Indicador titulo="Turnos hoy" valor={data.turnosHoy.length} icono={<CalendarDays className="size-5" />} tono="violeta" onClick={() => nav('/agenda')} />
        <Indicador titulo="Presupuestos" valor={data.presupuestos?.pendientes ?? 0} detalle={`${data.presupuestos?.aprobados ?? 0} aprobados`} icono={<FileText className="size-5" />} tono="ambar" onClick={() => nav('/presupuestos')} />
        {caja && (
          <Indicador
            titulo="Caja"
            valor={caja.sesion ? money(caja.sesion.resumen.efectivo_esperado) : 'Cerrada'}
            detalle={caja.sesion ? `Abierta · efectivo esperado${caja.sesion.resumen.movimientos ? ` · ${caja.sesion.resumen.movimientos} mov.` : ''}` : caja.obligatoria ? 'Abrila para cobrar' : 'Tocá para abrirla'}
            icono={<Banknote className="size-5" />}
            tono={caja.sesion ? 'verde' : caja.obligatoria ? 'rojo' : 'gris'}
            onClick={() => nav('/caja')}
          />
        )}
        {data.finanzas && (
          <>
            <Indicador titulo="Ventas del mes" valor={money(data.finanzas.ventas_mes)} icono={<Receipt className="size-5" />} tono="cian" onClick={() => nav('/reportes')} />
            <Indicador titulo="Cobrado hoy" valor={money(data.finanzas.cobrado_hoy)} icono={<Wallet className="size-5" />} tono="verde" onClick={() => nav('/cobros')} />
            <Indicador titulo="Por cobrar" valor={money(data.finanzas.por_cobrar)} icono={<AlertTriangle className="size-5" />} tono="rojo" onClick={() => nav('/cuentas')} />
          </>
        )}
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <Tarjeta titulo="Trabajos en curso" className="lg:col-span-2" sinPadding acciones={<Link to="/ordenes" className="text-sm font-medium text-marca-700">Ver tablero</Link>}>
          {data.ordenesRecientes.length === 0 ? (
            <Vacio icono={<Wrench className="size-5" />} titulo="No hay órdenes abiertas" accion={<Boton variante="primario" onClick={() => nav('/ordenes/nueva')}>Crear orden de trabajo</Boton>} />
          ) : (
            <ul className="divide-y divide-borde">
              {data.ordenesRecientes.map((o: any) => (
                <li key={o.id}>
                  <Link to={`/ordenes/${o.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold tracking-wide">{o.patente}</span>
                        <span className="text-xs text-tenue">OT #{numero(o.numero)}</span>
                      </div>
                      <div className="truncate text-sm text-tenue">{o.cliente}</div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <EstadoOTBadge estado={o.estado} />
                      <span className="text-sm tabular-nums">{money(o.total)}</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Tarjeta>

        <div className="space-y-5">
          <Tarjeta titulo="Agenda de hoy" sinPadding acciones={<Link to="/agenda" className="text-sm font-medium text-marca-700">Abrir agenda</Link>}>
            {data.turnosHoy.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-tenue">Sin turnos para hoy</p>
            ) : (
              <ul className="divide-y divide-borde">
                {data.turnosHoy.map((t: any) => (
                  <li key={t.id} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
                    <div className="min-w-0">
                      <span className="font-semibold tabular-nums">{t.hora}</span> <span className="truncate">{t.cliente}</span>
                      <div className="truncate text-xs text-tenue">{[t.patente, t.motivo].filter(Boolean).join(' · ')}</div>
                    </div>
                    <EstadoTurnoBadge estado={t.estado} />
                  </li>
                ))}
              </ul>
            )}
          </Tarjeta>

          <Tarjeta titulo="Estado del taller">
            <ul className="space-y-2 text-sm">
              {ESTADOS_OT_ABIERTOS.map((e) => (
                <li key={e} className="flex items-center justify-between">
                  <span className="text-tenue">{ESTADO_OT_LABEL[e]}</span>
                  <span className="font-semibold tabular-nums">{cant(e)}</span>
                </li>
              ))}
            </ul>
          </Tarjeta>

          {puede('catalogo.ver') && data.stockBajo.length > 0 && (
            <Tarjeta titulo="Stock bajo" sinPadding acciones={<Link to="/articulos?bajo=1" className="text-sm font-medium text-marca-700">Ver</Link>}>
              <ul className="divide-y divide-borde">
                {data.stockBajo.map((a: any) => (
                  <li key={a.id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2"><Package className="size-4 shrink-0 text-tenue" /><span className="truncate">{a.nombre}</span></span>
                    <span className={a.stock <= 0 ? 'font-semibold text-red-600' : 'font-semibold text-amber-700'}>{a.stock} / {a.stock_minimo}</span>
                  </li>
                ))}
              </ul>
            </Tarjeta>
          )}
        </div>
      </div>
    </>
  );
}
