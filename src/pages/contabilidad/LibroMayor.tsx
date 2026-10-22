// Libro mayor de una cuenta: movimientos del período con saldo acumulado y el origen de cada asiento.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { api } from '@/lib/api';
import { descargarCSV, exportarAutorizado, pesosCSV } from '@/lib/csv';
import { fecha, money } from '@/lib/format';
import { Aviso, Boton, Campo, Cargando, ErrorCaja, Select, Tarjeta, Vacio, useToast } from '@/components/ui';
import { ORIGEN_LABEL } from '@shared/contabilidad';
import { BotonImprimir, imp, OrigenLink, Periodo } from './comun';

export function LibroMayor({ desde, hasta }: { desde: string; hasta: string }) {
  const toast = useToast();
  const [cuentaId, setCuentaId] = useState('');
  const { data: plan } = useQuery<any[]>({ queryKey: ['contab', 'plan', 'form'], queryFn: () => api.get('/contabilidad/plan') });
  const { data: m, isLoading, error, refetch } = useQuery({
    queryKey: ['contab', 'mayor', cuentaId, desde, hasta], enabled: !!cuentaId,
    queryFn: () => api.get(`/contabilidad/mayor?desde=${desde}&hasta=${hasta}&cuenta_id=${cuentaId}`),
  });
  const exportar = () =>
    exportarAutorizado(`/contabilidad/mayor?desde=${desde}&hasta=${hasta}&cuenta_id=${cuentaId}`, () =>
      descargarCSV(`libro-mayor-${m.cuenta.codigo}-${desde}_${hasta}`, ['Fecha', 'Asiento', 'Origen', 'Descripción', 'Cuenta', 'Debe', 'Haber', 'Saldo'], [
        ['', '', '', 'Saldo anterior', '', '', '', pesosCSV(m.saldo_anterior)],
        ...m.movimientos.map((x: any) => [fecha(x.fecha), x.numero, ORIGEN_LABEL[x.origen_tipo] ?? x.origen_tipo, x.descripcion, `${x.cuenta_codigo} ${x.cuenta_nombre}`, x.debe ? pesosCSV(x.debe) : '', x.haber ? pesosCSV(x.haber) : '', pesosCSV(x.saldo)]),
      ]),
    ).catch((e) => toast.error(e));
  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap items-end gap-3">
        <Campo label="Cuenta" className="min-w-64 flex-1">
          <Select value={cuentaId} onChange={(e) => setCuentaId(e.target.value)}>
            <option value="">— Elegí una cuenta o un rubro —</option>
            {(plan ?? []).map((c) => <option key={c.id} value={c.id}>{c.imputable ? '' : '▸ '}{c.codigo} {c.nombre}</option>)}
          </Select>
        </Campo>
        <Boton icono={<Download className="size-4" />} onClick={exportar} disabled={!m?.movimientos?.length}>CSV</Boton>
        <BotonImprimir />
      </div>
      <Periodo desde={desde} hasta={hasta} />
      {!cuentaId ? <Tarjeta><Vacio titulo="Elegí una cuenta" texto="El libro mayor muestra todos los movimientos de una cuenta con su saldo acumulado." /></Tarjeta>
        : isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : m.error ? <Aviso tono="ambar">{m.error}</Aviso> : (
        <Tarjeta sinPadding titulo={`${m.cuenta.codigo} ${m.cuenta.nombre}`} subtitulo={`Saldo en sentido ${m.cuenta.naturaleza}`}>
          {m.truncado && <Aviso tono="ambar" className="m-3">Se muestran los primeros movimientos: acotá el período para ver el resto.</Aviso>}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-borde bg-slate-50/70 text-left text-xs font-semibold uppercase tracking-wide text-tenue">
                  <th className="px-4 py-2.5">Fecha</th><th className="px-4 py-2.5">N°</th><th className="px-4 py-2.5">Descripción</th><th className="px-4 py-2.5 text-right">Debe</th><th className="px-4 py-2.5 text-right">Haber</th><th className="px-4 py-2.5 text-right">Saldo</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-borde bg-slate-50/50 font-medium"><td className="px-4 py-2" colSpan={5}>Saldo anterior al {fecha(desde)}</td><td className="px-4 py-2 text-right tabular-nums">{money(m.saldo_anterior)}</td></tr>
                {m.movimientos.map((x: any, i: number) => (
                  <tr key={i} className="border-b border-borde last:border-0">
                    <td className="whitespace-nowrap px-4 py-2">{fecha(x.fecha)}</td>
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums">{x.numero}</td>
                    <td className="px-4 py-2">
                      <OrigenLink tipo={x.origen_tipo} id={x.origen_id}>{x.descripcion}</OrigenLink>
                      <div className="text-xs text-tenue">{ORIGEN_LABEL[x.origen_tipo] ?? x.origen_tipo}{m.cuenta.imputable ? '' : ` · ${x.cuenta_codigo} ${x.cuenta_nombre}`}{x.estado === 'revertido' ? ' · asiento revertido' : ''}</div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">{imp(x.debe)}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">{imp(x.haber)}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">{money(x.saldo)}</td>
                  </tr>
                ))}
                {!m.movimientos.length && <tr><td colSpan={6} className="px-4 py-6 text-center text-tenue">Sin movimientos en el período</td></tr>}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-borde font-semibold"><td className="px-4 py-2" colSpan={3}>Totales del período</td><td className="px-4 py-2 text-right tabular-nums">{money(m.debe)}</td><td className="px-4 py-2 text-right tabular-nums">{money(m.haber)}</td><td className="px-4 py-2 text-right tabular-nums">{money(m.saldo_final)}</td></tr>
              </tfoot>
            </table>
          </div>
        </Tarjeta>
      )}
    </div>
  );
}
