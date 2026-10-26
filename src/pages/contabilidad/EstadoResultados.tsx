// Estado de resultados económico (base devengado). Se distingue expresamente del flujo de caja y se marca como parcial cuando faltan datos.
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { api } from '@/lib/api';
import { descargarCSV, exportarAutorizado, pesosCSV } from '@/lib/csv';
import { money } from '@/lib/format';
import { Aviso, Boton, Cargando, ErrorCaja, Insignia, TablaApilable, Tarjeta, useToast } from '@/components/ui';
import { BotonImprimir, nombreArchivo, Periodo } from './comun';

export function EstadoResultados({ desde, hasta }: { desde: string; hasta: string }) {
  const toast = useToast();
  const { data: r, isLoading, error, refetch } = useQuery({ queryKey: ['contab', 'resultados', desde, hasta], queryFn: () => api.get(`/contabilidad/estado-resultados?desde=${desde}&hasta=${hasta}`) });
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  const parcial = r.calidad === 'parcial';
  const f = r.flujo_caja;
  const mo = r.mano_obra;
  const est = r.estimacion_costo_faltante;
  const exportar = () =>
    exportarAutorizado(`/contabilidad/estado-resultados?desde=${desde}&hasta=${hasta}`, () =>
      descargarCSV(nombreArchivo('estado-de-resultados', desde, hasta), ['Concepto', 'Importe'], [
        ...r.lineas.map((l: any) => [l.titulo, pesosCSV(l.monto)]),
        ['Calidad del resultado', parcial ? `PARCIAL: ${r.motivos.join(' | ')}` : 'Completo con los datos registrados'],
        ...(est ? [['Costo estimado sin dato histórico (NO incluido, a costo actual)', pesosCSV(est.costo_estimado)], ['Resultado estimado incluyendo ese costo (estimación)', pesosCSV(est.resultado_con_estimacion)]] : []),
        ['Flujo de caja neto del período (no es el resultado)', pesosCSV(f.neto)],
      ]),
    ).catch((e) => toast.error(e));
  return (
    <div className="space-y-5">
      <div className="no-print flex justify-end gap-2"><Boton icono={<Download className="size-4" />} onClick={exportar}>CSV</Boton><BotonImprimir /></div>
      <Periodo desde={desde} hasta={hasta} />
      {parcial ? (
        <Aviso tono="ambar">
          <strong>RESULTADO PARCIAL — no es una cifra definitiva.</strong>
          <ul className="mt-1 list-disc pl-5">{r.motivos.map((m: string) => <li key={m}>{m}</li>)}</ul>
        </Aviso>
      ) : <Aviso tono="verde">Resultado completo con los datos registrados en el período.</Aviso>}

      <Tarjeta sinPadding titulo="Resultado económico del período" subtitulo="Base devengado: cuenta lo vendido y lo comprado en el período, se haya cobrado o pagado o no.">
        <TablaApilable><table className="w-full text-sm">
          <tbody>
            {r.lineas.map((l: any) => (
              <tr key={l.clave} className={`border-b border-borde last:border-0 ${l.tipo === 'total' ? 'bg-marca-50/60 text-base font-bold' : l.tipo === 'subtotal' ? 'bg-slate-50/70 font-semibold' : ''}`}>
                <td className="px-4 py-2.5">{l.titulo}{l.clave === 'resultado' && parcial && <span className="ml-2 align-middle"><Insignia tono="ambar">Parcial</Insignia></span>}{l.ayuda && <div className="text-xs font-normal text-tenue">{l.ayuda}</div>}</td>
                <td className={`whitespace-nowrap px-4 py-2.5 text-right tabular-nums ${l.monto < 0 && l.tipo === 'total' ? 'text-red-700' : ''}`}>{money(l.monto)}</td>
              </tr>
            ))}
          </tbody>
        </table></TablaApilable>
      </Tarjeta>

      {est && (
        <Tarjeta titulo="Estimación del costo que falta (no es resultado contable)" subtitulo="Comprobantes anteriores al registro del costo histórico">
          <p className="text-sm">
            {est.renglones} renglón(es) de repuestos vendidos no tienen costo histórico. Valuados al <strong>costo actual</strong> costarían <strong>{money(est.costo_estimado)}</strong>; con esa estimación el resultado sería <strong>{money(est.resultado_con_estimacion)}</strong>.
          </p>
          <p className="mt-2 text-xs text-tenue">Es solo una referencia: ORVELAN no inventa costos históricos, por eso no se incluye en el resultado de arriba.</p>
        </Tarjeta>
      )}

      <Tarjeta titulo="No confundir con el flujo de caja" subtitulo="El dinero que entró y salió en el mismo período">
        <div className="grid gap-3 text-sm sm:grid-cols-3">
          <div><div className="text-xs text-tenue">Entró</div><div className="font-semibold tabular-nums">{money(f.entradas)}</div><div className="text-xs text-tenue">Cobros {money(f.cobrado)}</div></div>
          <div><div className="text-xs text-tenue">Salió</div><div className="font-semibold tabular-nums">{money(f.salidas)}</div><div className="text-xs text-tenue">Proveedores {money(f.pagado_proveedores)} · Gastos {money(f.gastos)}</div></div>
          <div><div className="text-xs text-tenue">Flujo neto</div><div className="font-semibold tabular-nums">{money(f.neto)}</div></div>
        </div>
        <p className="mt-3 text-xs text-tenue">Diferencias típicas: ventas a crédito sin cobrar, compras de mercadería (no son gasto hasta que se vende), anticipos de clientes (dinero que entró pero no es una venta) y depósitos o transferencias entre cuentas propias.</p>
      </Tarjeta>

      {mo && (
        <Tarjeta titulo="Mano de obra imputada a las órdenes (información de gestión)" subtitulo="Estimación según cronómetro y costos por hora. No se suma al resultado: los sueldos pagados ya figuran como costo de mano de obra.">
          <div className="grid gap-3 text-sm sm:grid-cols-4">
            <div><div className="text-xs text-tenue">Órdenes facturadas</div><div className="font-semibold">{mo.ordenes}</div></div>
            <div><div className="text-xs text-tenue">Mano de obra cobrada</div><div className="font-semibold tabular-nums">{money(mo.mano_obra_cobrada)}</div></div>
            <div><div className="text-xs text-tenue">Costo imputado</div><div className="font-semibold tabular-nums">{money(mo.costo_imputado)}</div></div>
            <div><div className="text-xs text-tenue">Calidad</div><Insignia tono={mo.calidad === 'definitivo' ? 'verde' : 'ambar'}>{mo.calidad}</Insignia></div>
          </div>
          {mo.faltantes?.length > 0 && <ul className="mt-3 list-disc pl-5 text-xs text-tenue">{mo.faltantes.map((x: string) => <li key={x}>{x}</li>)}</ul>}
        </Tarjeta>
      )}
    </div>
  );
}
