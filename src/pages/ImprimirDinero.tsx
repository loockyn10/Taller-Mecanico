// Impresos de cobranzas: recibo de cobro y estado de cuenta del cliente (A4, "Guardar como PDF" desde el diálogo de impresión).
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { Printer } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fecha, money, numero } from '@/lib/format';
import { Boton, Cargando, ErrorCaja } from '@/components/ui';
import { importeEnLetras } from '@shared/letras';
import { CONDICION_IVA_LABEL, MEDIO_PAGO_LABEL, type CondicionIva, type MedioPago } from '@shared/dominio';

export function Cabecera({ cfg, titulo, children, aviso = 'DOCUMENTO NO VÁLIDO COMO FACTURA' }: { cfg: any; titulo: string; children?: React.ReactNode; aviso?: string }) {
  const t = cfg.taller;
  return (
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
        {children}
        <div className="mt-1 border border-black px-2 py-0.5 text-xs font-semibold">{aviso}</div>
      </div>
    </header>
  );
}

export function ImprimirDinero() {
  const { tipo, id } = useParams();
  const { me } = useAuth();
  const esRecibo = tipo === 'recibo';
  const { data: d, isLoading, error } = useQuery({ queryKey: ['imprimir', tipo, id], queryFn: () => api.get(esRecibo ? `/cobros/${id}` : `/cuentas-corrientes/${id}`) });
  const { data: cfg } = useQuery({ queryKey: ['config'], queryFn: () => api.get('/taller/config') });
  useEffect(() => {
    if (d && cfg) {
      document.title = esRecibo ? `recibo-${d.numero}` : `estado-de-cuenta-${d.cliente.nombre}`;
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [d, cfg, esRecibo]);
  if (isLoading || !cfg) return <Cargando />;
  if (error) return <div className="p-6"><ErrorCaja error={error} /></div>;

  return (
    <div className="mx-auto max-w-[210mm] bg-white p-8 text-[13px] text-black print:p-0">
      <div className="no-print mb-6 flex justify-end gap-2">
        <Boton variante="primario" icono={<Printer className="size-4" />} onClick={() => window.print()}>Imprimir / Guardar PDF</Boton>
        <Boton onClick={() => window.close()}>Cerrar</Boton>
      </div>

      {esRecibo ? (
        <>
          <Cabecera cfg={cfg} titulo={`Recibo N° ${numero(d.numero)}`}>
            <div>Fecha: {fecha(d.fecha)}</div>
            {d.estado === 'anulado' && <div className="mt-1 text-base font-bold">ANULADO</div>}
          </Cabecera>
          <section className="border-b border-slate-300 py-4">
            <p>
              Recibimos de <strong>{d.cliente}</strong>
              {d.cliente_documento ? ` (Doc. ${d.cliente_documento})` : ''} la suma de <strong>{money(d.total)}</strong>
            </p>
            <p className="mt-1 italic">Son pesos: {importeEnLetras(d.total)}</p>
          </section>
          <section className="py-3">
            <h2 className="mb-1 text-[11px] font-semibold uppercase text-slate-500">Forma de pago</h2>
            <table className="w-full border-collapse">
              <tbody>
                {d.medios.map((m: any, i: number) => (
                  <tr key={i} className="border-b border-slate-200"><td className="py-1">{MEDIO_PAGO_LABEL[m.medio as MedioPago]}{m.referencia ? ` · ${m.referencia}` : ''}</td><td className="py-1 text-right">{money(m.importe)}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="py-3">
            <h2 className="mb-1 text-[11px] font-semibold uppercase text-slate-500">En concepto de pago de</h2>
            <table className="w-full border-collapse">
              <thead><tr className="border-b border-black text-left text-[11px] uppercase"><th className="py-1">Comprobante interno</th><th className="py-1">Fecha</th><th className="py-1 text-right">Total</th><th className="py-1 text-right">Este pago</th></tr></thead>
              <tbody>
                {d.aplicaciones.map((a: any) => (
                  <tr key={a.venta_id} className="border-b border-slate-200">
                    <td className="py-1">N° {numero(a.numero)}{a.orden_numero ? ` (OT #${numero(a.orden_numero)})` : ''}</td>
                    <td className="py-1">{fecha(a.fecha)}</td>
                    <td className="py-1 text-right">{money(a.total)}</td>
                    <td className="py-1 text-right">{money(a.importe)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <div className="ml-auto mt-3 w-64"><div className="flex justify-between border-t border-black pt-1 text-base font-bold"><span>Total recibido</span><span>{money(d.total)}</span></div></div>
          {d.notas && <p className="mt-4"><strong>Notas:</strong> {d.notas}</p>}
          {(cfg.config.pie_recibo || cfg.config.pie_documentos) && <p className="mt-4 border-t border-slate-300 pt-2 text-xs text-slate-600">{cfg.config.pie_recibo || cfg.config.pie_documentos}</p>}
          <div className="mt-16 grid grid-cols-2 gap-10 text-center text-xs">
            <div className="border-t border-black pt-1">Firma del cliente</div>
            <div className="border-t border-black pt-1">Recibió: {d.usuario ?? me?.taller.nombre}</div>
          </div>
        </>
      ) : (
        <>
          <Cabecera cfg={cfg} titulo="Estado de cuenta"><div>Emitido: {fecha(new Date().toISOString())}</div></Cabecera>
          <section className="border-b border-slate-300 py-3">
            <div className="text-[11px] font-semibold uppercase text-slate-500">Cliente</div>
            <div className="font-medium">{d.cliente.nombre}</div>
            {d.cliente.documento && <div>Doc.: {d.cliente.documento}</div>}
            {d.cliente.telefono && <div>Tel.: {d.cliente.telefono}</div>}
          </section>
          <table className="mt-3 w-full border-collapse">
            <thead><tr className="border-b border-black text-left text-[11px] uppercase"><th className="py-1.5">Fecha</th><th className="py-1.5">Concepto</th><th className="py-1.5 text-right">Debe</th><th className="py-1.5 text-right">Haber</th><th className="py-1.5 text-right">Saldo</th></tr></thead>
            <tbody>
              {d.movimientos.map((m: any) => (
                <tr key={`${m.tipo}-${m.id}`} className="border-b border-slate-200">
                  <td className="py-1.5">{fecha(m.fecha)}</td>
                  <td className="py-1.5">{m.tipo === 'venta' ? `Comprobante interno N° ${numero(m.numero)}` : `Recibo N° ${numero(m.numero)}`}</td>
                  <td className="py-1.5 text-right">{m.debe ? money(m.debe) : ''}</td>
                  <td className="py-1.5 text-right">{m.haber ? money(m.haber) : ''}</td>
                  <td className="py-1.5 text-right">{money(m.saldo)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="ml-auto mt-4 w-64"><div className="flex justify-between border-t border-black pt-1 text-base font-bold"><span>Saldo adeudado</span><span>{money(d.saldo)}</span></div></div>
          {d.pendientes.length > 0 && (
            <section className="mt-6">
              <h2 className="mb-1 text-[11px] font-semibold uppercase text-slate-500">Comprobantes pendientes</h2>
              <ul className="text-xs">{d.pendientes.map((p: any) => <li key={p.id}>N° {numero(p.numero)} del {fecha(p.fecha)} — saldo {money(p.saldo)}</li>)}</ul>
            </section>
          )}
          {(cfg.config.pie_recibo || cfg.config.pie_documentos) && <p className="mt-6 border-t border-slate-300 pt-2 text-xs text-slate-600">{cfg.config.pie_recibo || cfg.config.pie_documentos}</p>}
        </>
      )}
    </div>
  );
}
