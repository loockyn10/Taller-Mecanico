// Registros internos de contabilidad: resumen de ingresos y egresos, libro interno de ventas y de compras, y registro consolidado de operaciones.
// No son libros fiscales ni declaraciones ante ARCA. La contabilidad por partida doble (plan de cuentas, asientos, libro diario y mayor) queda pendiente.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Printer } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { descargarCSV, exportarAutorizado, pesosCSV } from '@/lib/csv';
import { fecha, hoyISO, money, numero } from '@/lib/format';
import { Aviso, Boton, Buscador, Campo, Cargando, Dato, Encabezado, ErrorCaja, Indicador, Insignia, Pestanas, Select, Tabla, Tarjeta, useDebounce, useToast, Vacio } from '@/components/ui';
import { primerDiaMes, SelectorPeriodo } from '@/components/Periodo';

type Tab = 'resumen' | 'ventas' | 'compras' | 'operaciones';
const NOMBRE_TIPO: Record<string, string> = {
  venta: 'Comprobante interno', cobro: 'Cobro', compra: 'Compra', factura_proveedor: 'Factura de proveedor', pago_proveedor: 'Pago a proveedor', gasto: 'Gasto', ingreso_manual: 'Ingreso manual',
  banco_manual: 'Mov. bancario', banco_deposito: 'Depósito', banco_extraccion: 'Extracción', banco_transferencia: 'Transferencia', banco_ajuste: 'Ajuste bancario', banco_cheque: 'Cheque',
};
const EFECTO: Record<string, { texto: string; tono: 'verde' | 'rojo' | 'gris' | 'azul' | 'ambar' }> = {
  ingreso: { texto: 'Ingreso', tono: 'verde' }, egreso: { texto: 'Egreso', tono: 'rojo' }, devengado: { texto: 'A crédito / devengado', tono: 'ambar' }, interno: { texto: 'Movimiento interno', tono: 'gris' }, informativo: { texto: 'Informativo', tono: 'azul' },
};

function Resumen({ desde, hasta }: { desde: string; hasta: string }) {
  const toast = useToast();
  const { data: r, isLoading, error, refetch } = useQuery({ queryKey: ['contabilidad', 'resumen', desde, hasta], queryFn: () => api.get(`/contabilidad/resumen?desde=${desde}&hasta=${hasta}`) });
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  const exportar = () => exportarAutorizado(`/contabilidad/resumen?desde=${desde}&hasta=${hasta}`, () => descargarCSV(`resumen-contable-${desde}_${hasta}`, ['Concepto', 'Importe'], [
    ['Cobros de clientes', pesosCSV(r.ingresos.cobros)], ['Otros ingresos', pesosCSV(r.ingresos.otros)], ['Ingresos bancarios', pesosCSV(r.ingresos.bancarios)], ['TOTAL INGRESOS', pesosCSV(r.ingresos.total)],
    ['Pagos a proveedores', pesosCSV(r.egresos.pagos_proveedor)], ['Gastos', pesosCSV(r.egresos.gastos)], ['Egresos bancarios', pesosCSV(r.egresos.bancarios)], ['TOTAL EGRESOS', pesosCSV(r.egresos.total)], ['RESULTADO', pesosCSV(r.resultado)],
    ['Ventas netas (devengado)', pesosCSV(r.devengado.ventas_netas)], ['Compras netas (devengado)', pesosCSV(r.devengado.compras_netas)], ['IVA registrado en ventas', pesosCSV(r.impuestos_registrados.iva_ventas)], ['IVA registrado en compras', pesosCSV(r.impuestos_registrados.iva_compras)],
  ])).catch((e) => toast.error(e));
  return (
    <div className="space-y-5">
      <div className="no-print flex justify-end gap-2"><Boton icono={<Download className="size-4" />} onClick={exportar}>CSV</Boton><Boton icono={<Printer className="size-4" />} onClick={() => window.print()}>Imprimir / PDF</Boton></div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Indicador titulo="Ingresos" valor={money(r.ingresos.total)} tono="verde" />
        <Indicador titulo="Egresos" valor={money(r.egresos.total)} tono="rojo" />
        <Indicador titulo="Resultado" valor={money(r.resultado)} tono={r.resultado >= 0 ? 'azul' : 'ambar'} detalle="Base caja" />
        <Indicador titulo="IVA registrado (saldo)" valor={money(r.impuestos_registrados.saldo_informativo)} detalle="Débito − crédito, informativo" tono="gris" />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Tarjeta titulo="Resumen de ingresos">
          <dl className="grid grid-cols-2 gap-4"><Dato etiqueta="Cobros de clientes">{money(r.ingresos.cobros)}</Dato><Dato etiqueta="Otros ingresos">{money(r.ingresos.otros)}</Dato><Dato etiqueta="Ingresos bancarios (intereses, etc.)">{money(r.ingresos.bancarios)}</Dato><Dato etiqueta="Total"><strong>{money(r.ingresos.total)}</strong></Dato></dl>
        </Tarjeta>
        <Tarjeta titulo="Resumen de egresos">
          <dl className="grid grid-cols-2 gap-4"><Dato etiqueta="Pagos a proveedores">{money(r.egresos.pagos_proveedor)}</Dato><Dato etiqueta="Gastos">{money(r.egresos.gastos)}</Dato><Dato etiqueta="Egresos bancarios (comisiones, etc.)">{money(r.egresos.bancarios)}</Dato><Dato etiqueta="Total"><strong>{money(r.egresos.total)}</strong></Dato></dl>
        </Tarjeta>
        <Tarjeta titulo="Devengado en el período" subtitulo="Lo facturado y comprado, cobrado o no">
          <dl className="grid grid-cols-2 gap-4"><Dato etiqueta={`Ventas netas (${r.devengado.ventas_comprobantes} comprobantes)`}>{money(r.devengado.ventas_netas)}</Dato><Dato etiqueta="Ventas con IVA incluido">{money(r.devengado.ventas_total)}</Dato><Dato etiqueta="Compras netas">{money(r.devengado.compras_netas)}</Dato></dl>
        </Tarjeta>
        <Tarjeta titulo="Impuestos registrados" subtitulo="Tal como figuran en los comprobantes cargados">
          <dl className="grid grid-cols-2 gap-4"><Dato etiqueta="IVA en comprobantes de venta">{money(r.impuestos_registrados.iva_ventas)}</Dato><Dato etiqueta="IVA en compras y facturas">{money(r.impuestos_registrados.iva_compras)}</Dato><Dato etiqueta="Diferencia (débito − crédito)">{money(r.impuestos_registrados.saldo_informativo)}</Dato></dl>
        </Tarjeta>
      </div>
      {r.por_mes.length > 0 && (
        <Tarjeta titulo="Por mes" sinPadding>
          <Tabla filas={r.por_mes} clave={(m: any) => m.mes} columnas={[{ clave: 'm', titulo: 'Mes', render: (m: any) => m.mes, movil: 'titulo' }, { clave: 'i', titulo: 'Ingresos', alinear: 'derecha', render: (m: any) => money(m.ingresos), movil: 'meta' }, { clave: 'e', titulo: 'Egresos', alinear: 'derecha', render: (m: any) => money(m.egresos), movil: 'meta' }, { clave: 'r', titulo: 'Resultado', alinear: 'derecha', render: (m: any) => money(m.ingresos - m.egresos), movil: 'derecha' }]} />
        </Tarjeta>
      )}
    </div>
  );
}

function LibroVentas({ desde, hasta }: { desde: string; hasta: string }) {
  const toast = useToast();
  const { data: l, isLoading, error, refetch } = useQuery({ queryKey: ['contabilidad', 'ventas', desde, hasta], queryFn: () => api.get(`/contabilidad/libro-ventas?desde=${desde}&hasta=${hasta}`) });
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  const exportar = () => exportarAutorizado(`/contabilidad/libro-ventas?desde=${desde}&hasta=${hasta}`, () => descargarCSV(`libro-interno-ventas-${desde}_${hasta}`, ['Fecha', 'N°', 'Tipo', 'Cliente', 'Documento', 'Condición IVA', 'Neto', 'Alícuota IVA', 'IVA', 'Recargo', 'Total', 'Estado'], l.filas.map((f: any) => [fecha(f.fecha), f.numero, f.tipo, f.cliente, f.documento, f.condicion_iva, pesosCSV(f.neto), String(f.iva_pct).replace('.', ','), pesosCSV(f.iva), pesosCSV(f.recargo), pesosCSV(f.total), f.estado === 'emitida' ? 'Vigente' : 'Anulado']))).catch((e) => toast.error(e));
  return (
    <div className="space-y-5">
      <div className="no-print flex justify-end gap-2"><Boton icono={<Download className="size-4" />} onClick={exportar} disabled={!l.filas.length}>CSV</Boton><Boton icono={<Printer className="size-4" />} onClick={() => window.print()}>Imprimir / PDF</Boton></div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Indicador titulo="Comprobantes vigentes" valor={String(l.totales.comprobantes)} detalle={l.totales.anulados ? `${l.totales.anulados} anulado(s)` : undefined} tono="azul" />
        <Indicador titulo="Neto" valor={money(l.totales.neto)} tono="gris" />
        <Indicador titulo="IVA" valor={money(l.totales.iva)} tono="ambar" />
        <Indicador titulo="Total" valor={money(l.totales.total)} tono="verde" />
      </div>
      {l.por_alicuota.length > 0 && (
        <Tarjeta titulo="Desglose por alícuota de IVA" sinPadding>
          <Tabla filas={l.por_alicuota} clave={(a: any) => String(a.iva_pct)} columnas={[{ clave: 'a', titulo: 'Alícuota', render: (a: any) => (a.iva_pct ? `${String(a.iva_pct).replace('.', ',')} %` : 'Sin IVA'), movil: 'titulo' }, { clave: 'c', titulo: 'Comprobantes', alinear: 'derecha', render: (a: any) => a.comprobantes, movil: 'meta' }, { clave: 'n', titulo: 'Neto', alinear: 'derecha', render: (a: any) => money(a.neto), movil: 'meta' }, { clave: 'i', titulo: 'IVA', alinear: 'derecha', render: (a: any) => money(a.iva), movil: 'meta' }, { clave: 't', titulo: 'Total', alinear: 'derecha', render: (a: any) => money(a.total), movil: 'derecha' }]} />
        </Tarjeta>
      )}
      <Tarjeta titulo="Libro interno de ventas" sinPadding>
        <Tabla
          filas={l.filas}
          clave={(f: any) => `${f.numero}`}
          vacio={<Vacio titulo="Sin comprobantes en el período" />}
          columnas={[
            { clave: 'f', titulo: 'Fecha', render: (f: any) => fecha(f.fecha), movil: 'meta' },
            { clave: 'n', titulo: 'Comprobante', render: (f: any) => <span className={f.estado === 'anulada' ? 'text-tenue line-through' : ''}>N° {numero(f.numero)}</span>, movil: 'titulo' },
            { clave: 'c', titulo: 'Cliente', render: (f: any) => <>{f.cliente}{f.documento ? <span className="text-tenue"> · {f.documento}</span> : null}</>, movil: 'subtitulo' },
            { clave: 'ne', titulo: 'Neto', alinear: 'derecha', render: (f: any) => money(f.neto), movil: 'meta' },
            { clave: 'iv', titulo: 'IVA', alinear: 'derecha', render: (f: any) => (f.iva ? `${money(f.iva)} (${String(f.iva_pct).replace('.', ',')}%)` : '—'), movil: 'meta' },
            { clave: 't', titulo: 'Total', alinear: 'derecha', render: (f: any) => money(f.total), movil: 'derecha' },
            { clave: 'e', titulo: '', render: (f: any) => (f.estado === 'anulada' ? <Insignia>Anulado</Insignia> : null), movil: 'meta' },
          ]}
        />
      </Tarjeta>
    </div>
  );
}

function LibroCompras({ desde, hasta }: { desde: string; hasta: string }) {
  const toast = useToast();
  const { data: l, isLoading, error, refetch } = useQuery({ queryKey: ['contabilidad', 'compras', desde, hasta], queryFn: () => api.get(`/contabilidad/libro-compras?desde=${desde}&hasta=${hasta}`) });
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  const exportar = () => exportarAutorizado(`/contabilidad/libro-compras?desde=${desde}&hasta=${hasta}`, () => descargarCSV(`libro-interno-compras-${desde}_${hasta}`, ['Fecha', 'Origen', 'Proveedor', 'CUIT', 'Comprobante', 'Neto gravado', 'No gravado', 'IVA 21', 'IVA 10,5', 'IVA 27', 'IVA (compras)', 'Otros tributos', 'Total'], l.filas.map((f: any) => [fecha(f.fecha), f.origen, f.proveedor, f.cuit, f.comprobante, pesosCSV(f.neto_gravado), pesosCSV(f.no_gravado), pesosCSV(f.iva_21), pesosCSV(f.iva_10_5), pesosCSV(f.iva_27), pesosCSV(f.iva_otros), pesosCSV(f.otros_tributos), pesosCSV(f.total)]))).catch((e) => toast.error(e));
  return (
    <div className="space-y-5">
      <div className="no-print flex justify-end gap-2"><Boton icono={<Download className="size-4" />} onClick={exportar} disabled={!l.filas.length}>CSV</Boton><Boton icono={<Printer className="size-4" />} onClick={() => window.print()}>Imprimir / PDF</Boton></div>
      <Aviso>Cada compra figura una vez: si tiene una factura asociada se muestra el número de esa factura y no se suma de nuevo. Las notas de crédito restan.</Aviso>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Indicador titulo="Comprobantes" valor={String(l.totales.comprobantes)} tono="azul" />
        <Indicador titulo="Neto gravado" valor={money(l.totales.neto_gravado)} tono="gris" />
        <Indicador titulo="IVA crédito registrado" valor={money(l.totales.iva_21 + l.totales.iva_10_5 + l.totales.iva_27 + l.totales.iva_otros)} tono="ambar" />
        <Indicador titulo="Total" valor={money(l.totales.total)} tono="rojo" />
      </div>
      <Tarjeta titulo="Libro interno de compras" sinPadding>
        <Tabla
          filas={l.filas}
          clave={(f: any) => `${f.origen}-${f.numero}`}
          vacio={<Vacio titulo="Sin compras en el período" />}
          columnas={[
            { clave: 'f', titulo: 'Fecha', render: (f: any) => fecha(f.fecha), movil: 'meta' },
            { clave: 'p', titulo: 'Proveedor', render: (f: any) => <><span className="font-medium">{f.proveedor}</span>{f.cuit ? <span className="text-tenue"> · {f.cuit}</span> : null}</>, movil: 'titulo' },
            { clave: 'c', titulo: 'Comprobante', render: (f: any) => `${f.origen}${f.comprobante ? ` · ${f.comprobante}` : ''}`, movil: 'subtitulo' },
            { clave: 'n', titulo: 'Neto', alinear: 'derecha', render: (f: any) => money(f.neto_gravado + f.no_gravado), movil: 'meta' },
            { clave: 'i', titulo: 'IVA', alinear: 'derecha', render: (f: any) => money(f.iva_total), movil: 'meta' },
            { clave: 'o', titulo: 'Otros', alinear: 'derecha', render: (f: any) => (f.otros_tributos ? money(f.otros_tributos) : '—'), movil: 'meta' },
            { clave: 't', titulo: 'Total', alinear: 'derecha', render: (f: any) => money(f.total), movil: 'derecha' },
          ]}
        />
      </Tarjeta>
    </div>
  );
}

function Operaciones({ desde, hasta }: { desde: string; hasta: string }) {
  const toast = useToast();
  const [tipo, setTipo] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounce(q);
  const { data: o, isLoading, error, refetch } = useQuery({ queryKey: ['contabilidad', 'operaciones', desde, hasta, tipo, dq], queryFn: () => api.get(`/contabilidad/operaciones${qs({ desde, hasta, tipo, q: dq })}`) });
  const exportar = () => o && exportarAutorizado(`/contabilidad/operaciones${qs({ desde, hasta, tipo, q: dq })}`, () => descargarCSV(`operaciones-${desde}_${hasta}`, ['Fecha', 'Tipo', 'N°', 'Tercero', 'Concepto', 'Importe', 'Efecto', 'Estado'], o.filas.map((f: any) => [fecha(f.fecha), NOMBRE_TIPO[f.tipo] ?? f.tipo, f.numero || '', f.tercero ?? '', f.concepto ?? '', pesosCSV(f.importe), EFECTO[f.efecto]?.texto ?? f.efecto, f.estado]))).catch((e) => toast.error(e));
  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap items-end gap-3">
        <Buscador value={q} onChange={setQ} placeholder="Tercero o concepto…" className="min-w-52 flex-1" />
        <Campo label="Tipo"><Select value={tipo} onChange={(e) => setTipo(e.target.value)} className="w-auto"><option value="">Todos</option>{Object.entries(NOMBRE_TIPO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Campo>
        <Boton icono={<Download className="size-4" />} onClick={exportar} disabled={!o?.filas.length}>CSV</Boton>
        <Boton icono={<Printer className="size-4" />} onClick={() => window.print()}>Imprimir / PDF</Boton>
      </div>
      <Aviso>Una fila por hecho económico. “Ingreso/Egreso” cuentan en el resultado (base caja); “A crédito / devengado” son ventas o compras todavía no cobradas o pagadas; “Movimiento interno” sólo mueve plata entre cuentas.</Aviso>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding titulo="Registro consolidado de operaciones" subtitulo={o.filas.length >= 1000 ? 'Se muestran las primeras 1000: acotá el período' : undefined}>
          <Tabla
            filas={o.filas}
            clave={(f: any) => `${f.tipo}-${f.numero}-${f.fecha}-${f.importe}-${f.concepto}`}
            vacio={<Vacio titulo="Sin operaciones en el período" />}
            columnas={[
              { clave: 'f', titulo: 'Fecha', render: (f: any) => fecha(f.fecha), movil: 'meta' },
              { clave: 't', titulo: 'Tipo', render: (f: any) => <span className={f.estado === 'anulada' || f.estado === 'anulado' ? 'text-tenue line-through' : ''}>{NOMBRE_TIPO[f.tipo] ?? f.tipo}{f.numero ? ` #${numero(f.numero)}` : ''}</span>, movil: 'titulo' },
              { clave: 'c', titulo: 'Detalle', render: (f: any) => [f.tercero, f.concepto].filter(Boolean).join(' · '), movil: 'subtitulo' },
              { clave: 'e', titulo: 'Efecto', render: (f: any) => <Insignia tono={EFECTO[f.efecto]?.tono ?? 'gris'}>{EFECTO[f.efecto]?.texto ?? f.efecto}</Insignia>, movil: 'meta' },
              { clave: 'i', titulo: 'Importe', alinear: 'derecha', render: (f: any) => money(f.importe), movil: 'derecha' },
            ]}
          />
        </Tarjeta>
      )}
    </div>
  );
}

export function Contabilidad() {
  const [tab, setTab] = useState<Tab>('resumen');
  const [desde, setDesde] = useState(primerDiaMes());
  const [hasta, setHasta] = useState(hoyISO());
  const valido = desde <= hasta;
  return (
    <>
      <Encabezado titulo="Registros contables internos" subtitulo="Ventas, compras, ingresos y egresos con datos reales del taller" />
      <Aviso tono="ambar" className="mb-4">Registros internos de gestión: <strong>no son libros fiscales</strong> (IVA Ventas / IVA Compras) ni declaraciones válidas ante ARCA. La contabilidad por partida doble (plan de cuentas, asientos, libro diario y mayor) todavía no está implementada.</Aviso>
      <div className="no-print"><Pestanas items={[{ clave: 'resumen', titulo: 'Resumen' }, { clave: 'ventas', titulo: 'Libro de ventas' }, { clave: 'compras', titulo: 'Libro de compras' }, { clave: 'operaciones', titulo: 'Operaciones' }]} activo={tab} onCambio={setTab} /></div>
      <div className="no-print"><SelectorPeriodo desde={desde} hasta={hasta} onCambio={(d, h) => { setDesde(d); setHasta(h); }} /></div>
      <p className="mb-3 hidden text-sm print:block">Período: {fecha(desde)} al {fecha(hasta)}</p>
      {!valido ? <Aviso tono="ambar">Elegí un período válido.</Aviso> : tab === 'resumen' ? <Resumen desde={desde} hasta={hasta} /> : tab === 'ventas' ? <LibroVentas desde={desde} hasta={hasta} /> : tab === 'compras' ? <LibroCompras desde={desde} hasta={hasta} /> : <Operaciones desde={desde} hasta={hasta} />}
    </>
  );
}
