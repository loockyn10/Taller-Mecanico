import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, Banknote, Barcode, CalendarDays, CheckCircle2, FileText, Package, Plus, Receipt, Wallet, Wrench, Zap } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { money, numero } from '@/lib/format';
import { useEstadoCaja } from '@/lib/caja';
import { usePuesta } from '@/lib/puesta';
import { usePagosPendientes } from '@/components/PagoCliente';
import { ConsultaPrecios } from '@/components/ConsultaPrecios';
import { Boton, Cargando, Encabezado, ErrorCaja, Indicador, Tarjeta, Vacio } from '@/components/ui';
import { EstadoOTBadge, EstadoTurnoBadge } from '@/components/estados';
import { ESTADOS_OT_ABIERTOS, ESTADO_OT_LABEL, type EstadoOT } from '@shared/dominio';

/** Acceso directo a una acción operativa (misma presencia que los indicadores del tablero). */
function Accion({ titulo, detalle, icono, onClick }: { titulo: string; detalle: string; icono: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full min-w-0 items-center gap-3 rounded-card border border-borde bg-white p-3 text-left shadow-card transition hover:border-marca-300 hover:shadow-pop sm:p-3.5">
      <span className="grid size-10 shrink-0 place-items-center rounded-ctl bg-marca-50 text-marca-700 ring-1 ring-inset ring-marca-200">{icono}</span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold leading-snug">{titulo}</span>
        <span className="block text-xs text-tenue">{detalle}</span>
      </span>
    </button>
  );
}

export function Inicio() {
  const { me, puede } = useAuth();
  const nav = useNavigate();
  const [consulta, setConsulta] = useState(false);
  const puedeRapidas = (puede('ventas.emitir') && puede('precios.venta.ver')) || (puede('ordenes.modificar') && puede('presupuestos.valorizados.ver') && puede('precios.venta.ver')) || puede('stock.ajustar');
  const hayAcciones = puede('ordenes.crear') || puede('catalogo.ver') || puede('presupuestos.gestionar');
  const { data: caja } = useEstadoCaja();
  const { data: puesta } = usePuesta();
  const { data: pagos } = usePagosPendientes();
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
      />

      {hayAcciones && (
        <section aria-label="Acciones rápidas" className="mb-5">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-tenue">Acciones rápidas</h2>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(13rem,1fr))]">
            {puede('ordenes.crear') && <Accion titulo="Nueva OT" detalle="Recibir un vehículo" icono={<Plus className="size-5" />} onClick={() => nav('/ordenes/nueva')} />}
            {puede('catalogo.ver') && <Accion titulo="Consultar precios" detalle="Precio y stock al instante" icono={<Barcode className="size-5" />} onClick={() => setConsulta(true)} />}
            {puedeRapidas && <Accion titulo="Operaciones rápidas" detalle="Venta, consumo en OT y bajas" icono={<Zap className="size-5" />} onClick={() => nav('/operaciones-rapidas')} />}
            {puede('presupuestos.gestionar') && <Accion titulo="Presupuesto" detalle="Armar uno nuevo" icono={<FileText className="size-5" />} onClick={() => nav('/presupuestos/nuevo')} />}
          </div>
        </section>
      )}
      <ConsultaPrecios abierto={consulta} onCerrar={() => setConsulta(false)} />

      {pagos && pagos.total > 0 && (
        <Link to="/ordenes?comprobantes=pendientes" className="mb-4 flex items-center justify-between gap-3 rounded-card border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 hover:bg-amber-100">
          <span><strong>{pagos.total}</strong> {pagos.total === 1 ? 'comprobante pendiente' : 'comprobantes pendientes'} de verificar</span>
          <span className="font-medium">Ver →</span>
        </Link>
      )}

      {puesta && puesta.pendientes > 0 && (
        <Link to="/puesta-en-marcha" className="mb-4 block rounded-card border border-marca-200 bg-marca-50/60 px-4 py-3 hover:bg-marca-50">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-marca-800">Configuración del taller: {puesta.completos} de {puesta.total} pasos completos</span>
            <span className="text-sm text-marca-700">Continuar →</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${(puesta.completos / puesta.total) * 100}%` }} /></div>
        </Link>
      )}

      <div className="@container"><div className="grid grid-cols-1 gap-3 @[20rem]:grid-cols-2 @[42rem]:grid-cols-4">
        {puede('ordenes.ver') && <Indicador titulo="OT abiertas" valor={abiertas} detalle={`${cant('en_reparacion')} en reparación`} icono={<Wrench className="size-5" />} onClick={() => nav('/ordenes')} />}
        {puede('ordenes.ver') && <Indicador titulo="Listas p/ entregar" valor={cant('lista')} icono={<CheckCircle2 className="size-5" />} tono="verde" onClick={() => nav('/ordenes?estado=lista')} />}
        {puede('turnos.ver') && <Indicador titulo="Turnos hoy" valor={data.turnosHoy.length} icono={<CalendarDays className="size-5" />} tono="violeta" onClick={() => nav('/agenda')} />}
        {puede('presupuestos.ver') && <Indicador titulo="Presupuestos" valor={data.presupuestos?.pendientes ?? 0} detalle={`${data.presupuestos?.aprobados ?? 0} aprobados`} icono={<FileText className="size-5" />} tono="ambar" onClick={() => nav('/presupuestos')} />}
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
      </div></div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        {puede('ordenes.ver') && <Tarjeta titulo="Trabajos en curso" className="lg:col-span-2" sinPadding acciones={<Link to="/ordenes" className="text-sm font-medium text-marca-700">Ver tablero</Link>}>
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
                      <div className="truncate text-sm text-tenue">{o.cliente ?? ''}</div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <EstadoOTBadge estado={o.estado} />
                      {o.total !== undefined && <span className="text-sm tabular-nums">{money(o.total)}</span>}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Tarjeta>}

        <div className="space-y-5">
          {puede('turnos.ver') && <Tarjeta titulo="Agenda de hoy" sinPadding acciones={<Link to="/agenda" className="text-sm font-medium text-marca-700">Abrir agenda</Link>}>
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
          </Tarjeta>}

          {puede('ordenes.ver') && <Tarjeta titulo="Estado del taller">
            <ul className="space-y-2 text-sm">
              {ESTADOS_OT_ABIERTOS.map((e) => (
                <li key={e} className="flex items-center justify-between">
                  <span className="text-tenue">{ESTADO_OT_LABEL[e]}</span>
                  <span className="font-semibold tabular-nums">{cant(e)}</span>
                </li>
              ))}
            </ul>
          </Tarjeta>}

          {puede('stock.ver') && data.stockBajo.length > 0 && (
            <Tarjeta titulo="Stock bajo" sinPadding acciones={<Link to="/articulos?bajo=1" className="text-sm font-medium text-marca-700">Ver</Link>}>
              <ul className="divide-y divide-borde">
                {data.stockBajo.map((a: any) => (
                  <li key={`${a.id}-${a.deposito ?? ""}`} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2"><Package className="size-4 shrink-0 text-tenue" /><span className="truncate">{a.nombre}{a.deposito ? ` · ${a.deposito}` : ""}</span></span>
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
