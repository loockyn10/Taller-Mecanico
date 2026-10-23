// Balance de sumas y saldos: saldos iniciales, débitos, créditos y saldos finales del período. Las inconsistencias se muestran, no se ocultan.
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { api } from '@/lib/api';
import { descargarCSV, exportarAutorizado, pesosCSV } from '@/lib/csv';
import { Aviso, Boton, Cargando, ErrorCaja, Insignia, TablaApilable, Tarjeta, useToast, Vacio } from '@/components/ui';
import { BotonImprimir, imp, nombreArchivo, Periodo } from './comun';

const deudor = (n: number) => (n > 0 ? n : 0);
const acreedor = (n: number) => (n < 0 ? -n : 0);

export function Balance({ desde, hasta }: { desde: string; hasta: string }) {
  const toast = useToast();
  const { data: b, isLoading, error, refetch } = useQuery({ queryKey: ['contab', 'balance', desde, hasta], queryFn: () => api.get(`/contabilidad/balance?desde=${desde}&hasta=${hasta}`) });
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  const t = b.totales;
  const exportar = () =>
    exportarAutorizado(`/contabilidad/balance?desde=${desde}&hasta=${hasta}`, () =>
      descargarCSV(nombreArchivo('balance-sumas-y-saldos', desde, hasta), ['Código', 'Cuenta', 'Saldo inicial deudor', 'Saldo inicial acreedor', 'Débitos', 'Créditos', 'Saldo final deudor', 'Saldo final acreedor'], [
        ...b.cuentas.map((c: any) => [c.codigo, c.nombre, pesosCSV(deudor(c.inicial)), pesosCSV(acreedor(c.inicial)), pesosCSV(c.debe), pesosCSV(c.haber), pesosCSV(deudor(c.final)), pesosCSV(acreedor(c.final))]),
        ['', 'TOTALES', pesosCSV(t.inicialD), pesosCSV(t.inicialH), pesosCSV(t.debe), pesosCSV(t.haber), pesosCSV(t.finalD), pesosCSV(t.finalH)],
      ]),
    ).catch((e) => toast.error(e));
  return (
    <div className="space-y-4">
      <div className="no-print flex justify-end gap-2"><Boton icono={<Download className="size-4" />} onClick={exportar} disabled={!b.cuentas.length}>CSV</Boton><BotonImprimir /></div>
      <Periodo desde={desde} hasta={hasta} />
      {b.cuadra ? <Aviso tono="verde">El balance cuadra: los débitos igualan a los créditos y los saldos deudores igualan a los acreedores.</Aviso> : <Aviso tono="rojo">El balance NO cuadra. No se ajustó nada: revisá los controles de consistencia.</Aviso>}
      {b.inconsistencias.length > 0 && (
        <Aviso tono="ambar">
          <strong>Inconsistencias detectadas</strong>
          <ul className="mt-1 list-disc pl-5">{b.inconsistencias.map((i: string) => <li key={i}>{i}</li>)}</ul>
        </Aviso>
      )}
      <Aviso>Los saldos iniciales son lo acumulado antes del {desde.split('-').reverse().join('/')}. Si el taller tenía inventario, deudas o créditos antes de usar Fierro, no figuran hasta que se carguen con un asiento manual de apertura.</Aviso>
      <Tarjeta sinPadding titulo="Balance de sumas y saldos">
        {!b.cuentas.length ? <Vacio titulo="Sin movimientos" texto="No hay asientos hasta la fecha del período elegido." /> : (
          <TablaApilable>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-borde bg-slate-50/70 text-xs font-semibold uppercase tracking-wide text-tenue">
                  <th className="px-4 py-2 text-left" rowSpan={2}>Cuenta</th>
                  <th className="px-4 py-1.5 text-center" colSpan={2}>Saldo inicial</th>
                  <th className="px-4 py-1.5 text-center" colSpan={2}>Movimientos del período</th>
                  <th className="px-4 py-1.5 text-center" colSpan={2}>Saldo final</th>
                </tr>
                <tr className="border-b border-borde bg-slate-50/70 text-xs font-semibold uppercase tracking-wide text-tenue">
                  {['Deudor', 'Acreedor', 'Débitos', 'Créditos', 'Deudor', 'Acreedor'].map((x, i) => <th key={i} className="px-3 py-1.5 text-right">{x}</th>)}
                </tr>
              </thead>
              <tbody>
                {b.cuentas.map((c: any) => (
                  <tr key={c.cuenta_id} className="border-b border-borde last:border-0">
                    <td className="px-4 py-2"><span className="tabular-nums text-tenue">{c.codigo}</span> {c.nombre}{c.alerta && <span className="ml-2"><Insignia tono="ambar">Revisar</Insignia></span>}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{imp(deudor(c.inicial))}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{imp(acreedor(c.inicial))}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{imp(c.debe)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{imp(c.haber)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{imp(deudor(c.final))}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{imp(acreedor(c.final))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-borde font-semibold">
                  <td className="px-4 py-2">TOTALES</td>
                  {[t.inicialD, t.inicialH, t.debe, t.haber, t.finalD, t.finalH].map((v, i) => <td key={i} className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{imp(v) || '0,00'}</td>)}
                </tr>
              </tfoot>
            </table>
          </TablaApilable>
        )}
      </Tarjeta>
    </div>
  );
}
