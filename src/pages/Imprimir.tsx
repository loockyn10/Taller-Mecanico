// Vistas imprimibles (A4): presupuesto, OT (cliente y hoja de taller sin precios) y comprobante interno.
// "Guardar como PDF" desde el diálogo de impresión del navegador.
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { Printer } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fecha, km, money, numero, cantidad } from '@/lib/format';
import { Boton, Cargando, ErrorCaja } from '@/components/ui';
import { CONDICION_IVA_LABEL, ESTADO_OT_LABEL, type CondicionIva, type EstadoOT } from '@shared/dominio';
import { ImprimirDinero } from './ImprimirDinero';
import { ImprimirCompras } from './ImprimirCompras';

const RUTA: Record<string, string> = { presupuesto: '/presupuestos/', orden: '/ordenes/', 'orden-taller': '/ordenes/', venta: '/ventas/' };

/** Recibos y estados de cuenta tienen su propia vista; el resto de los documentos comparte ésta. */
export function Imprimir() {
  const { tipo = '' } = useParams();
  if (tipo === 'orden-compra' || tipo === 'cuenta-proveedor' || tipo === 'recepcion' || tipo === 'orden-pago') return <ImprimirCompras />;
  return tipo === 'recibo' || tipo === 'cuenta' ? <ImprimirDinero /> : <ImprimirDocumento />;
}

function ImprimirDocumento() {
  const { tipo = '', id } = useParams();
  const { me } = useAuth();
  const { data: d, isLoading, error } = useQuery({ queryKey: ['imprimir', tipo, id], queryFn: () => api.get(`${RUTA[tipo]}${id}`), enabled: !!RUTA[tipo] });
  const { data: cfg } = useQuery({ queryKey: ['config'], queryFn: () => api.get('/taller/config') });
  useEffect(() => {
    if (d && cfg) {
      document.title = `${tipo}-${d.numero}`;
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [d, cfg, tipo]);
  if (!RUTA[tipo]) return <p className="p-6">Documento inválido</p>;
  if (isLoading || !cfg) return <Cargando />;
  if (error) return <div className="p-6"><ErrorCaja error={error} /></div>;
  const t = cfg.taller;
  const sinPrecios = tipo === 'orden-taller';
  const titulo = tipo === 'presupuesto' ? `Presupuesto P-${numero(d.numero)}` : tipo === 'venta' ? `Comprobante interno N° ${numero(d.numero)}` : `Orden de trabajo N° ${numero(d.numero)}`;
  const vehiculo = [d.patente, d.marca, d.modelo, d.anio].filter(Boolean).join(' · ');

  return (
    <div className="mx-auto max-w-[210mm] bg-white p-8 text-[13px] text-black print:p-0">
      <div className="no-print mb-6 flex justify-end gap-2">
        <Boton variante="primario" icono={<Printer className="size-4" />} onClick={() => window.print()}>Imprimir / Guardar PDF</Boton>
        <Boton onClick={() => window.close()}>Cerrar</Boton>
      </div>
      <header className="flex items-start justify-between border-b-2 border-black pb-4">
        <div>
          <div className="text-xl font-bold">{t.nombre}</div>
          {t.razon_social && <div>{t.razon_social}</div>}
          <div>{[t.direccion, t.localidad].filter(Boolean).join(', ')}</div>
          <div>{[t.telefono, t.email].filter(Boolean).join(' · ')}</div>
          {t.cuit && <div>CUIT {t.cuit} · {CONDICION_IVA_LABEL[t.condicion_iva as CondicionIva]}</div>}
          {(t.ingresos_brutos || t.inicio_actividades) && <div>{[t.ingresos_brutos ? `IIBB ${t.ingresos_brutos}` : null, t.inicio_actividades ? `Inicio de actividades ${fecha(t.inicio_actividades)}` : null].filter(Boolean).join(' · ')}</div>}
        </div>
        <div className="text-right">
          <div className="text-lg font-bold">{titulo}</div>
          <div>Fecha: {fecha(d.fecha ?? d.fecha_ingreso)}</div>
          {tipo === 'presupuesto' && d.valido_hasta && <div>Válido hasta: {fecha(d.valido_hasta)}</div>}
          {tipo !== 'presupuesto' && tipo !== 'venta' && <div>Estado: {ESTADO_OT_LABEL[d.estado as EstadoOT]}</div>}
          {tipo === 'venta' && <div className="mt-1 border border-black px-2 py-0.5 text-xs font-semibold">DOCUMENTO NO VÁLIDO COMO FACTURA</div>}
        </div>
      </header>

      <section className="grid grid-cols-2 gap-4 border-b border-slate-300 py-3">
        <div>
          <div className="text-[11px] font-semibold uppercase text-slate-500">Cliente</div>
          <div className="font-medium">{d.cliente}</div>
          {d.cliente_telefono && <div>Tel.: {d.cliente_telefono}</div>}
          {d.documento && <div>Doc.: {d.documento}</div>}
        </div>
        {tipo !== 'venta' && (
          <div>
            <div className="text-[11px] font-semibold uppercase text-slate-500">Vehículo</div>
            <div className="font-medium">{vehiculo}</div>
            <div>Km: {km(d.km ?? d.km_ingreso)}</div>
            {d.mecanico && <div>Mecánico: {d.mecanico}</div>}
          </div>
        )}
      </section>

      {(d.falla_reportada || d.diagnostico) && (
        <section className="border-b border-slate-300 py-3">
          {d.falla_reportada && <p><strong>Motivo de ingreso:</strong> {d.falla_reportada}</p>}
          {d.diagnostico && <p><strong>Diagnóstico:</strong> {d.diagnostico}</p>}
        </section>
      )}

      <table className="mt-3 w-full border-collapse">
        <thead>
          <tr className="border-b border-black text-left text-[11px] uppercase">
            <th className="py-1.5">Descripción</th>
            <th className="py-1.5 text-right">Cant.</th>
            {!sinPrecios && <th className="py-1.5 text-right">P. unit.</th>}
            {!sinPrecios && <th className="py-1.5 text-right">Desc.</th>}
            {!sinPrecios && <th className="py-1.5 text-right">Subtotal</th>}
            {sinPrecios && <th className="w-16 py-1.5 text-center">Hecho</th>}
          </tr>
        </thead>
        <tbody>
          {d.items.map((i: any) => (
            <tr key={i.id} className="border-b border-slate-200">
              <td className="py-1.5">{i.descripcion}</td>
              <td className="py-1.5 text-right">{cantidad(i.cantidad)}</td>
              {!sinPrecios && <td className="py-1.5 text-right">{money(i.precio_unitario)}</td>}
              {!sinPrecios && <td className="py-1.5 text-right">{i.desc_pct ? `${i.desc_pct}%` : ''}</td>}
              {!sinPrecios && <td className="py-1.5 text-right">{money(i.subtotal)}</td>}
              {sinPrecios && <td className="py-1.5 text-center">☐</td>}
            </tr>
          ))}
        </tbody>
      </table>

      {!sinPrecios && (
        <div className="ml-auto mt-4 w-64 space-y-1">
          <div className="flex justify-between"><span>Repuestos</span><span>{money(d.subtotal_articulos)}</span></div>
          <div className="flex justify-between"><span>Mano de obra</span><span>{money(d.subtotal_servicios)}</span></div>
          {d.descuento > 0 && <div className="flex justify-between"><span>Descuento</span><span>-{money(d.descuento)}</span></div>}
          {d.iva > 0 && <div className="flex justify-between"><span>IVA {d.iva_pct}%</span><span>{money(d.iva)}</span></div>}
          {d.recargo > 0 && <div className="flex justify-between"><span>Recargo {d.recargo_pct}%</span><span>{money(d.recargo)}</span></div>}
          <div className="flex justify-between border-t border-black pt-1 text-base font-bold"><span>Total</span><span>{money(d.total)}</span></div>
        </div>
      )}

      {sinPrecios && d.checklist && (
        <section className="mt-4 border-t border-slate-300 pt-3 text-xs">
          <strong>Check-list:</strong> combustible {d.checklist.combustible ?? '—'}; daños: {d.checklist.datos.danos.join(', ') || 'ninguno'}; testigos: {d.checklist.datos.testigos.join(', ') || 'ninguno'}.
        </section>
      )}
      {d.observaciones && <p className="mt-4"><strong>Observaciones:</strong> {d.observaciones}</p>}
      {!sinPrecios && (tipo === 'presupuesto' ? cfg.config.pie_presupuesto || cfg.config.pie_documentos : cfg.config.pie_documentos) && <p className="mt-6 border-t border-slate-300 pt-2 text-xs text-slate-600">{tipo === 'presupuesto' ? cfg.config.pie_presupuesto || cfg.config.pie_documentos : cfg.config.pie_documentos}</p>}
      {tipo === 'orden' && (
        <div className="mt-16 grid grid-cols-2 gap-10 text-center text-xs">
          <div className="border-t border-black pt-1">Firma del cliente</div>
          <div className="border-t border-black pt-1">Por {me?.taller.nombre}</div>
        </div>
      )}
    </div>
  );
}
