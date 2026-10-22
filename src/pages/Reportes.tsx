import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { fecha, hoyISO, money, sumarDias } from '@/lib/format';
import { Boton, Campo, Cargando, Encabezado, ErrorCaja, Indicador, Input, Tarjeta } from '@/components/ui';
import { MEDIO_PAGO_LABEL, type MedioPago } from '@shared/dominio';

function Barras({ filas, etiqueta, valor, formato = money }: { filas: any[]; etiqueta: (f: any) => string; valor: (f: any) => number; formato?: (n: number) => string }) {
  const max = Math.max(1, ...filas.map(valor));
  if (!filas.length) return <p className="py-4 text-center text-sm text-tenue">Sin datos en el período</p>;
  return (
    <ul className="space-y-2.5">
      {filas.map((f, i) => (
        <li key={i}>
          <div className="mb-1 flex justify-between gap-3 text-sm">
            <span className="truncate">{etiqueta(f)}</span>
            <span className="shrink-0 font-medium tabular-nums">{formato(valor(f))}</span>
          </div>
          <div className="h-2 rounded-full bg-slate-100">
            <div className="h-2 rounded-full bg-marca-500" style={{ width: `${(valor(f) / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

const RANGOS = [
  { t: 'Este mes', f: () => [`${hoyISO().slice(0, 8)}01`, hoyISO()] },
  { t: 'Últimos 7 días', f: () => [sumarDias(hoyISO(), -6), hoyISO()] },
  { t: 'Últimos 30 días', f: () => [sumarDias(hoyISO(), -29), hoyISO()] },
  { t: 'Este año', f: () => [`${hoyISO().slice(0, 4)}-01-01`, hoyISO()] },
];

export function Reportes() {
  const [[desde, hasta], setRango] = useState<string[]>(RANGOS[0].f());
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['reportes', desde, hasta], queryFn: () => api.get(`/reportes?desde=${desde}&hasta=${hasta}`) });
  return (
    <>
      <Encabezado titulo="Estadísticas" subtitulo={`Del ${fecha(desde)} al ${fecha(hasta)}`} />
      <div className="mb-5 flex flex-wrap items-end gap-2">
        {RANGOS.map((r) => <Boton key={r.t} tam="sm" onClick={() => setRango(r.f())}>{r.t}</Boton>)}
        <Campo label="Desde"><Input type="date" value={desde} onChange={(e) => setRango([e.target.value, hasta])} /></Campo>
        <Campo label="Hasta"><Input type="date" value={hasta} onChange={(e) => setRango([desde, e.target.value])} /></Campo>
      </div>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Indicador titulo="Facturado (interno)" valor={money(data.resumen.total)} detalle={`${data.resumen.comprobantes} comprobantes`} />
            <Indicador titulo="Mano de obra" valor={money(data.resumen.servicios)} tono="violeta" />
            <Indicador titulo="Repuestos" valor={money(data.resumen.articulos)} tono="cian" />
            <Indicador titulo="Ticket promedio" valor={money(Math.round(data.resumen.ticket_promedio))} tono="verde" />
            {data.devoluciones && <Indicador titulo="Devoluciones (notas de crédito)" valor={money(data.devoluciones.total)} detalle={`${data.devoluciones.cantidad} en el período · reintegrado ${money(data.devoluciones.reintegrado)}`} tono="rojo" />}
            {data.anticipos && <Indicador titulo="Anticipos recibidos" valor={money(data.anticipos.total)} detalle={`${data.anticipos.cantidad} · no son ventas`} tono="ambar" />}
            <Indicador titulo="OT ingresadas" valor={data.ordenesPeriodo.ingresadas ?? 0} detalle={`${data.ordenesPeriodo.entregadas ?? 0} entregadas · ${data.ordenesPeriodo.canceladas ?? 0} canceladas`} tono="gris" />
            <Indicador titulo="Compras" valor={money(data.compras.total)} detalle={`${data.compras.cantidad} comprobantes`} tono="ambar" />
          </div>
          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <Tarjeta titulo="Ventas por día"><Barras filas={data.porDia} etiqueta={(f) => fecha(f.fecha)} valor={(f) => f.total} /></Tarjeta>
            <Tarjeta titulo="Cobros por medio de pago (incluye anticipos)"><Barras filas={data.porMedio} etiqueta={(f) => MEDIO_PAGO_LABEL[f.medio as MedioPago]} valor={(f) => f.total} /></Tarjeta>
            <Tarjeta titulo="Servicios más vendidos"><Barras filas={data.topServicios} etiqueta={(f) => `${f.descripcion} (${f.cantidad})`} valor={(f) => f.total} /></Tarjeta>
            <Tarjeta titulo="Repuestos más vendidos">
              <Barras filas={data.topArticulos} etiqueta={(f) => `${f.descripcion} (${f.cantidad})${f.costo ? ` · margen ${money(f.total - f.costo)}` : ''}`} valor={(f) => f.total} />
            </Tarjeta>
            <Tarjeta titulo="Trabajos por mecánico" className="lg:col-span-2">
              <Barras filas={data.porMecanico} etiqueta={(f) => `${f.mecanico} · ${f.ordenes} OT`} valor={(f) => f.mano_obra ?? 0} />
            </Tarjeta>
          </div>
          <p className="mt-4 text-xs text-tenue">Importes sobre comprobantes internos emitidos (no anulados). El margen de repuestos se calcula con el costo actual del artículo.</p>
        </>
      )}
    </>
  );
}
