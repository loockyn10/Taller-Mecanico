// Impresos de compras: orden de compra y estado de cuenta de un proveedor (A4, "Guardar como PDF" desde el diálogo de impresión).
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { Printer } from 'lucide-react';
import { api } from '@/lib/api';
import { cantidad, fecha, money, numero } from '@/lib/format';
import { Boton, Cargando, ErrorCaja } from '@/components/ui';
import { ESTADO_OC_LABEL, type EstadoOrdenCompra } from '@shared/dominio';
import { Cabecera } from './ImprimirDinero';

export function ImprimirCompras() {
  const { tipo, id } = useParams();
  const esOrden = tipo === 'orden-compra';
  const { data: d, isLoading, error } = useQuery({ queryKey: ['imprimir', tipo, id], queryFn: () => api.get(esOrden ? `/ordenes-compra/${id}` : `/proveedores/${id}/cuenta`) });
  const { data: cfg } = useQuery({ queryKey: ['config'], queryFn: () => api.get('/taller/config') });
  useEffect(() => {
    if (d && cfg) {
      document.title = esOrden ? `orden-de-compra-${d.numero}` : `estado-de-cuenta-${d.proveedor.nombre}`;
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [d, cfg, esOrden]);
  if (isLoading || !cfg) return <Cargando />;
  if (error) return <div className="p-6"><ErrorCaja error={error} /></div>;

  return (
    <div className="mx-auto max-w-[210mm] bg-white p-8 text-[13px] text-black print:p-0">
      <div className="no-print mb-6 flex justify-end gap-2">
        <Boton variante="primario" icono={<Printer className="size-4" />} onClick={() => window.print()}>Imprimir / Guardar PDF</Boton>
        <Boton onClick={() => window.close()}>Cerrar</Boton>
      </div>
      {esOrden ? (
        <>
          <Cabecera cfg={cfg} titulo={`Orden de compra N° ${numero(d.numero)}`} aviso="DOCUMENTO INTERNO">
            <div>Fecha: {fecha(d.fecha)}</div>
            {d.fecha_prevista && <div>Entrega prevista: {fecha(d.fecha_prevista)}</div>}
            <div>Estado: {ESTADO_OC_LABEL[d.estado as EstadoOrdenCompra]}</div>
          </Cabecera>
          <section className="border-b border-slate-300 py-3">
            <div className="text-[11px] font-semibold uppercase text-slate-500">Proveedor</div>
            <div className="font-medium">{d.proveedor}</div>
            {d.proveedor_cuit && <div>CUIT: {d.proveedor_cuit}</div>}
          </section>
          <table className="mt-3 w-full border-collapse">
            <thead><tr className="border-b border-black text-left text-[11px] uppercase"><th className="py-1.5">Código</th><th className="py-1.5">Artículo</th><th className="py-1.5 text-right">Cant.</th><th className="py-1.5 text-right">Costo unit.</th><th className="py-1.5 text-right">Desc.</th><th className="py-1.5 text-right">Subtotal</th></tr></thead>
            <tbody>
              {d.items.map((i: any) => (
                <tr key={i.id} className="border-b border-slate-200">
                  <td className="py-1.5">{i.codigo ?? ''}</td>
                  <td className="py-1.5">{i.articulo}</td>
                  <td className="py-1.5 text-right">{cantidad(i.cantidad)} {i.unidad}</td>
                  <td className="py-1.5 text-right">{money(i.costo_unitario)}</td>
                  <td className="py-1.5 text-right">{i.desc_pct ? `${i.desc_pct}%` : ''}</td>
                  <td className="py-1.5 text-right">{money(i.subtotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="ml-auto mt-4 w-64 space-y-1">
            <div className="flex justify-between"><span>Subtotal</span><span>{money(d.subtotal)}</span></div>
            {d.descuento > 0 && <div className="flex justify-between"><span>Descuento {d.descuento_pct}%</span><span>-{money(d.descuento)}</span></div>}
            {d.iva > 0 && <div className="flex justify-between"><span>IVA {d.iva_pct}%</span><span>{money(d.iva)}</span></div>}
            <div className="flex justify-between border-t border-black pt-1 text-base font-bold"><span>Total</span><span>{money(d.total)}</span></div>
          </div>
          {d.observaciones && <p className="mt-4"><strong>Observaciones:</strong> {d.observaciones}</p>}
          {(cfg.config.pie_orden_compra || cfg.config.pie_documentos) && <p className="mt-6 border-t border-slate-300 pt-2 text-xs text-slate-600">{cfg.config.pie_orden_compra || cfg.config.pie_documentos}</p>}
          <div className="mt-16 grid grid-cols-2 gap-10 text-center text-xs">
            <div className="border-t border-black pt-1">Autorizó</div>
            <div className="border-t border-black pt-1">Recibí conforme (proveedor)</div>
          </div>
        </>
      ) : (
        <>
          <Cabecera cfg={cfg} titulo="Estado de cuenta de proveedor" aviso="DOCUMENTO INTERNO"><div>Emitido: {fecha(new Date().toISOString())}</div></Cabecera>
          <section className="border-b border-slate-300 py-3">
            <div className="text-[11px] font-semibold uppercase text-slate-500">Proveedor</div>
            <div className="font-medium">{d.proveedor.nombre}</div>
            {d.proveedor.cuit && <div>CUIT: {d.proveedor.cuit}</div>}
            {d.proveedor.telefono && <div>Tel.: {d.proveedor.telefono}</div>}
          </section>
          <table className="mt-3 w-full border-collapse">
            <thead><tr className="border-b border-black text-left text-[11px] uppercase"><th className="py-1.5">Fecha</th><th className="py-1.5">Concepto</th><th className="py-1.5 text-right">Pagos</th><th className="py-1.5 text-right">Compras / facturas</th><th className="py-1.5 text-right">Saldo</th></tr></thead>
            <tbody>
              {d.movimientos.map((m: any) => (
                <tr key={`${m.tipo}-${m.id}`} className={`border-b border-slate-200 ${m.anulado ? 'text-slate-400 line-through' : ''}`}>
                  <td className="py-1.5">{fecha(m.fecha)}</td>
                  <td className="py-1.5">{m.tipo === 'compra' ? `Compra #${numero(m.numero)}` : m.tipo === 'factura' ? `${m.haber || m.debe ? (m.debe ? 'Nota de crédito' : 'Factura') : 'Factura (asociada a una compra)'} ${m.detalle ?? ''}` : `Pago #${numero(m.numero)}`}{m.tipo === 'compra' && m.detalle ? ` (${m.detalle})` : ''}{m.anulado ? ' — anulado' : ''}</td>
                  <td className="py-1.5 text-right">{m.debe ? money(m.debe) : ''}</td>
                  <td className="py-1.5 text-right">{m.haber ? money(m.haber) : ''}</td>
                  <td className="py-1.5 text-right">{money(m.saldo)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="ml-auto mt-4 w-72"><div className="flex justify-between border-t border-black pt-1 text-base font-bold"><span>{d.saldo < 0 ? 'Saldo a favor' : 'Saldo a pagar'}</span><span>{money(Math.abs(d.saldo))}</span></div></div>
          {d.deuda.docs.length > 0 && (
            <section className="mt-6">
              <h2 className="mb-1 text-[11px] font-semibold uppercase text-slate-500">Comprobantes pendientes (pagos imputados al más antiguo)</h2>
              <table className="w-full border-collapse text-xs">
                <thead><tr className="border-b border-black text-left uppercase"><th className="py-1">Comprobante</th><th className="py-1">Fecha</th><th className="py-1">Vence</th><th className="py-1 text-right">Total</th><th className="py-1 text-right">Pendiente</th></tr></thead>
                <tbody>{d.deuda.docs.map((x: any) => <tr key={`${x.tipo}-${x.id}`} className="border-b border-slate-200"><td className="py-1">{x.tipo === 'compra' ? `Compra #${numero(x.numero)}` : 'Factura'} {x.detalle ?? ''}</td><td className="py-1">{fecha(x.fecha)}</td><td className={`py-1 ${x.dias_atraso > 0 ? 'font-semibold' : ''}`}>{fecha(x.vencimiento)}{x.dias_atraso > 0 ? ` (vencido ${x.dias_atraso} d)` : ''}</td><td className="py-1 text-right">{money(x.total)}</td><td className="py-1 text-right">{money(x.pendiente)}</td></tr>)}</tbody>
              </table>
            </section>
          )}
          {(cfg.config.pie_recibo || cfg.config.pie_documentos) && <p className="mt-6 border-t border-slate-300 pt-2 text-xs text-slate-600">{cfg.config.pie_recibo || cfg.config.pie_documentos}</p>}
        </>
      )}
    </div>
  );
}
