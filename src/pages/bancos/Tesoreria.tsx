// Tesorería general: caja, bancos, cheques, cuentas por cobrar y por pagar, y resultado financiero operativo del período.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Banknote, Download, FileText, Landmark, Printer, Receipt, Scale, Truck, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { descargarCSV, pesosCSV } from '@/lib/csv';
import { fecha, hoyISO, money } from '@/lib/format';
import { Aviso, Boton, Cargando, Dato, Encabezado, ErrorCaja, Indicador, Tarjeta, Vacio } from '@/components/ui';
import { primerDiaMes, SelectorPeriodo } from '@/components/Periodo';

export function Tesoreria() {
  const [desde, setDesde] = useState(primerDiaMes());
  const [hasta, setHasta] = useState(hoyISO());
  const valido = desde && hasta && desde <= hasta;
  const { data: t, isLoading, error, refetch } = useQuery({ queryKey: ['tesoreria', { desde, hasta }], queryFn: () => api.get(`/tesoreria/resumen?desde=${desde}&hasta=${hasta}`), enabled: !!valido });
  const maxSerie = useMemo(() => Math.max(1, ...(t?.serie ?? []).map((s: any) => Math.max(s.ingresos, s.egresos))), [t]);
  const exportar = () => {
    if (!t) return;
    descargarCSV(`tesoreria-${desde}_${hasta}`, ['Concepto', 'Importe'], [
      ['Efectivo en caja', pesosCSV(t.efectivo.saldo)], ['Saldo en bancos (ARS)', pesosCSV(t.bancos.total)], ['Disponible', pesosCSV(t.disponible)],
      ['Cheques en cartera', pesosCSV(t.cheques.en_cartera)], ['Cheques depositados pendientes', pesosCSV(t.cheques.depositados_pendientes)], ['Cheques emitidos pendientes', pesosCSV(t.cheques.emitidos_pendientes)],
      ['Cuentas por cobrar', pesosCSV(t.cuentas_por_cobrar.total)], ['Cuentas por pagar', pesosCSV(t.cuentas_por_pagar.total)], ['Cuentas por pagar vencidas', pesosCSV(t.cuentas_por_pagar.vencido)],
      ['Ingresos del período', pesosCSV(t.periodo.ingresos.total)], ['Egresos del período', pesosCSV(t.periodo.egresos.total)], ['Resultado financiero operativo', pesosCSV(t.periodo.resultado)],
      ...t.bancos.cuentas.filter((c: any) => c.activa).map((c: any) => [`Cuenta ${c.nombre} (${c.moneda})`, pesosCSV(c.saldo)]),
    ]);
  };
  return (
    <>
      <Encabezado
        titulo="Tesorería"
        subtitulo="Todo el dinero del taller en un solo lugar"
        acciones={<><Boton icono={<Download className="size-4" />} onClick={exportar} disabled={!t}>CSV</Boton><Boton icono={<Printer className="size-4" />} onClick={() => window.print()}>Imprimir</Boton></>}
      />
      <SelectorPeriodo desde={desde} hasta={hasta} onCambio={(d, h) => { setDesde(d); setHasta(h); }} />
      {!valido ? <Aviso tono="ambar">Elegí un período válido.</Aviso> : isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : t && (
        <div className="space-y-5">
          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-tenue">Saldos al día de hoy</h2>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Indicador titulo="Disponible" valor={money(t.disponible)} detalle="Efectivo + bancos (pesos)" tono="azul" icono={<Scale className="size-5" />} />
              <Indicador titulo="Efectivo en caja" valor={money(t.efectivo.saldo)} detalle={t.efectivo.detalle} tono="verde" icono={<Banknote className="size-5" />} />
              <Indicador titulo="Saldo bancario" valor={money(t.bancos.total)} detalle={`${t.bancos.cuentas.filter((c: any) => c.activa && c.moneda === 'ARS').length} cuenta(s) en pesos`} tono="cian" icono={<Landmark className="size-5" />} />
              <Indicador titulo="Cheques pendientes" valor={money(t.cheques.en_cartera + t.cheques.depositados_pendientes)} detalle={`${money(t.cheques.en_cartera)} en cartera · ${money(t.cheques.depositados_pendientes)} depositados`} tono="violeta" icono={<FileText className="size-5" />} />
              <Indicador titulo="Cuentas por cobrar" valor={money(t.cuentas_por_cobrar.total)} detalle={`${money(t.cuentas_por_cobrar.vencido_30)} con más de 30 días`} tono="ambar" icono={<Receipt className="size-5" />} />
              <Indicador titulo="Cuentas por pagar" valor={money(t.cuentas_por_pagar.total)} detalle={`${money(t.cuentas_por_pagar.vencido)} vencidas`} tono={t.cuentas_por_pagar.vencido ? 'rojo' : 'gris'} icono={<Truck className="size-5" />} />
              <Indicador titulo="Cheques emitidos" valor={money(t.cheques.emitidos_pendientes)} detalle="Entregados, sin debitar" tono="gris" icono={<Wallet className="size-5" />} />
              {t.bancos.otras_monedas.map((o: any) => <Indicador key={o.moneda} titulo={`Saldo en ${o.moneda}`} valor={`${o.moneda} ${(o.total / 100).toLocaleString('es-AR', { minimumFractionDigits: 2 })}`} detalle="No se suma al disponible" tono="gris" />)}
            </div>
          </div>

          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-tenue">Período {fecha(desde)} — {fecha(hasta)}</h2>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Indicador titulo="Ingresos del período" valor={money(t.periodo.ingresos.total)} detalle={`Cobros ${money(t.periodo.ingresos.cobros)} · otros ${money(t.periodo.ingresos.otros + t.periodo.ingresos.bancarios)}`} tono="verde" />
              <Indicador titulo="Egresos del período" valor={money(t.periodo.egresos.total)} detalle={`Proveedores ${money(t.periodo.egresos.pagos_proveedor)} · gastos ${money(t.periodo.egresos.gastos)}${t.periodo.egresos.devoluciones_clientes ? ` · reintegros a clientes ${money(t.periodo.egresos.devoluciones_clientes)}` : ''}${t.periodo.egresos.bancarios ? ` · bancarios ${money(t.periodo.egresos.bancarios)}` : ''}`} tono="rojo" />
              <Indicador titulo="Resultado financiero operativo" valor={money(t.periodo.resultado)} detalle="Ingresos − egresos cobrados y pagados" tono={t.periodo.resultado >= 0 ? 'azul' : 'ambar'} />
              <Indicador titulo="A favor de clientes" valor={money(t.a_favor_clientes.total)} detalle={`Anticipos sin aplicar ${money(t.a_favor_clientes.anticipos)} · créditos de devoluciones ${money(t.a_favor_clientes.devoluciones)} (no es ingreso: se debe)`} tono="violeta" />
              <Indicador titulo="Ventas pendientes de cobro" valor={money(t.cuentas_por_cobrar.ventas_del_periodo)} detalle="Emitidas en el período, sin cobrar" tono="gris" />
            </div>
            <Aviso className="mt-3">Los ingresos y egresos cuentan sólo lo efectivamente cobrado y pagado, una vez. Depositar efectivo, extraerlo o transferir entre cuentas propias ({money(t.periodo.transferencias_internas.depositos)} en depósitos, {money(t.periodo.transferencias_internas.extracciones)} en extracciones, {money(t.periodo.transferencias_internas.entre_cuentas)} entre cuentas en el período) mueve plata de lugar y no se cuenta como ingreso ni egreso.</Aviso>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Tarjeta titulo="Cuentas bancarias" acciones={<Link className="text-sm text-marca-700" to="/bancos">Ver bancos</Link>} sinPadding>
              {t.bancos.cuentas.length === 0 ? <Vacio titulo="Sin cuentas bancarias" texto="Cargá tus cuentas en Bancos para ver sus saldos acá." /> : (
                <ul className="divide-y divide-borde text-sm">
                  {t.bancos.cuentas.map((c: any) => (
                    <li key={c.id} className={`flex items-center justify-between gap-3 px-4 py-2.5 ${c.activa ? '' : 'opacity-50'}`}>
                      <span><span className="font-medium">{c.nombre}</span> <span className="text-xs text-tenue">{c.banco}{c.pendientes ? ` · ${c.pendientes} sin conciliar` : ''}</span></span>
                      <span className="font-semibold tabular-nums">{c.moneda === 'ARS' ? money(c.saldo) : `${c.moneda} ${(c.saldo / 100).toLocaleString('es-AR', { minimumFractionDigits: 2 })}`}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Tarjeta>
            <Tarjeta titulo="Obligaciones y pendientes">
              <dl className="grid grid-cols-2 gap-4">
                <Dato etiqueta="Proveedores vencidos"><span className={t.obligaciones.proveedores_vencido ? 'font-semibold text-red-600' : ''}>{money(t.obligaciones.proveedores_vencido)}</span></Dato>
                <Dato etiqueta="Vence en 7 días">{money(t.cuentas_por_pagar.vence_7_dias)}</Dato>
                <Dato etiqueta="Proveedores con deuda">{t.cuentas_por_pagar.proveedores_con_deuda}</Dato>
                <Dato etiqueta="Gastos recurrentes vencidos">{t.obligaciones.gastos_recurrentes_vencidos ? `${t.obligaciones.gastos_recurrentes_vencidos} · ${money(t.obligaciones.gastos_recurrentes_importe)}` : 'Ninguno'}</Dato>
                <Dato etiqueta="Cheques a depositar / debitar">{t.cheques.proximos} en {t.cheques.dias_alerta} días</Dato>
                <Dato etiqueta="Cheques emitidos por debitar">{money(t.obligaciones.cheques_emitidos_pendientes)}</Dato>
              </dl>
              <div className="mt-4 flex flex-wrap gap-2 no-print">
                <Link to="/proveedores?tab=deuda"><Boton tam="sm">Deuda con proveedores</Boton></Link>
                <Link to="/cheques"><Boton tam="sm">Cheques</Boton></Link>
                <Link to="/finanzas"><Boton tam="sm">Gastos recurrentes</Boton></Link>
              </div>
            </Tarjeta>
          </div>

          <Tarjeta titulo="Evolución del período" subtitulo="Ingresos y egresos por día (sin transferencias internas)" sinPadding>
            {t.serie.length === 0 ? <p className="px-4 py-6 text-center text-sm text-tenue">Sin movimientos en el período</p> : (
              <ul className="max-h-80 divide-y divide-borde overflow-y-auto text-sm">
                {t.serie.map((s: any) => (
                  <li key={s.fecha} className="px-4 py-2">
                    <div className="flex justify-between"><span>{fecha(s.fecha)}</span><span className="tabular-nums text-tenue">{money(s.ingresos)} / {money(s.egresos)}</span></div>
                    <div className="mt-1 space-y-0.5"><div className="h-1.5 rounded-full bg-emerald-400" style={{ width: `${(s.ingresos / maxSerie) * 100}%` }} /><div className="h-1.5 rounded-full bg-red-400" style={{ width: `${(s.egresos / maxSerie) * 100}%` }} /></div>
                  </li>
                ))}
              </ul>
            )}
          </Tarjeta>
        </div>
      )}
    </>
  );
}
