// Informes avanzados: ventas, rentabilidad, compras, gastos, cobranzas, deudores, proveedores, inventario, mecánicos y actividad financiera.
// Todos con datos reales, filtros, exportación a CSV (Excel en español) e impresión / PDF.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Printer } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { descargarCSV, pesosCSV } from '@/lib/csv';
import { fecha, hoyISO, money, numero } from '@/lib/format';
import { Aviso, Boton, Buscador, Campo, Cargando, Encabezado, ErrorCaja, Select, Tarjeta, useDebounce, useToast, Vacio } from '@/components/ui';
import { primerDiaMes, SelectorPeriodo } from '@/components/Periodo';
import { ESTADO_OT_LABEL, ESTADOS_OT, MEDIO_PAGO_LABEL, type EstadoOT, type MedioPago } from '@shared/dominio';

type Filtro = 'cliente' | 'proveedor' | 'articulo' | 'categoria' | 'categoria_gasto' | 'mecanico' | 'estado_ot' | 'estado_doc' | 'agrupar' | 'q';
interface Def { clave: string; titulo: string; grupo: string; filtros: Filtro[]; agrupar?: Array<[string, string]>; periodo?: boolean; permiso?: 'stock.valorizar' | 'finanzas.ver' | 'margenes.ver'; estados?: Array<[string, string]> }

const INFORMES: Def[] = [
  { clave: 'ventas', titulo: 'Ventas por período', grupo: 'Ventas', filtros: ['cliente', 'agrupar', 'estado_doc'], agrupar: [['dia', 'Por día'], ['mes', 'Por mes'], ['detalle', 'Por comprobante']], estados: [['emitida', 'Vigentes'], ['anulada', 'Anuladas']] },
  { clave: 'ventas-articulo', titulo: 'Ventas por artículo', grupo: 'Ventas', filtros: ['cliente', 'articulo', 'categoria', 'proveedor', 'q'] },
  { clave: 'ventas-categoria', titulo: 'Ventas por categoría', grupo: 'Ventas', filtros: ['cliente', 'proveedor', 'q'] },
  { clave: 'mas-vendidos', titulo: 'Productos más vendidos', grupo: 'Ventas', filtros: ['cliente', 'categoria', 'proveedor'] },
  { clave: 'servicios', titulo: 'Servicios más realizados', grupo: 'Ventas', filtros: ['cliente', 'q'] },
  { clave: 'rentabilidad', titulo: 'Rentabilidad por artículo', grupo: 'Ventas', filtros: ['cliente', 'categoria', 'proveedor', 'articulo'], permiso: 'margenes.ver' },
  { clave: 'cobranzas', titulo: 'Cobranzas', grupo: 'Cobranzas', filtros: ['cliente', 'agrupar', 'estado_doc'], agrupar: [['detalle', 'Por recibo'], ['medio', 'Por medio de pago']], estados: [['registrado', 'Vigentes'], ['anulado', 'Anulados']] },
  { clave: 'anticipos', titulo: 'Anticipos de clientes', grupo: 'Cobranzas', filtros: ['cliente', 'estado_doc'], estados: [['', 'Vigentes'], ['pendientes', 'Pendientes de aplicar'], ['utilizados', 'Utilizados'], ['devueltos', 'Devueltos'], ['anulados', 'Anulados']] },
  { clave: 'devoluciones', titulo: 'Devoluciones (notas de crédito internas)', grupo: 'Cobranzas', filtros: ['cliente', 'agrupar', 'estado_doc'], agrupar: [['detalle', 'Por devolución'], ['medio', 'Reintegros por medio de pago']], estados: [['registrada', 'Vigentes'], ['anulada', 'Anuladas']] },
  { clave: 'deudores', titulo: 'Deudores', grupo: 'Cobranzas', filtros: ['cliente'], periodo: false },
  { clave: 'compras', titulo: 'Compras', grupo: 'Compras', filtros: ['proveedor', 'articulo', 'agrupar', 'estado_doc'], agrupar: [['detalle', 'Por compra'], ['proveedor', 'Por proveedor']], estados: [['registrada', 'Vigentes'], ['anulada', 'Anuladas']] },
  { clave: 'proveedores', titulo: 'Deuda con proveedores', grupo: 'Compras', filtros: ['proveedor'], periodo: false },
  { clave: 'gastos', titulo: 'Gastos', grupo: 'Finanzas', filtros: ['categoria_gasto', 'proveedor', 'agrupar', 'estado_doc'], agrupar: [['categoria', 'Por categoría'], ['detalle', 'Por gasto']], estados: [['registrado', 'Vigentes'], ['anulado', 'Anulados']], permiso: 'finanzas.ver' },
  { clave: 'actividad-financiera', titulo: 'Actividad financiera', grupo: 'Finanzas', filtros: ['agrupar'], agrupar: [['dia', 'Por día'], ['mes', 'Por mes']], permiso: 'finanzas.ver' },
  { clave: 'inventario-valorizado', titulo: 'Inventario valorizado', grupo: 'Inventario', filtros: ['categoria', 'proveedor'], periodo: false, permiso: 'stock.valorizar' },
  { clave: 'mecanicos', titulo: 'Rendimiento de mecánicos', grupo: 'Taller', filtros: ['mecanico'] },
  { clave: 'rentabilidad-ot', titulo: 'Rentabilidad por orden de trabajo', grupo: 'Taller', filtros: ['cliente', 'mecanico'], permiso: 'margenes.ver' },
  { clave: 'mano-obra', titulo: 'Costo de mano de obra por mecánico', grupo: 'Taller', filtros: [], permiso: 'margenes.ver' },
  { clave: 'ordenes', titulo: 'Órdenes de trabajo', grupo: 'Taller', filtros: ['estado_ot', 'cliente', 'mecanico'] },
];

interface Col { clave: string; titulo: string; tipo: 'texto' | 'fecha' | 'moneda' | 'numero' | 'entero' | 'pct' }

const COMA = (n: number) => String(n).replace('.', ',');
function mostrar(c: Col, v: any): string {
  if (v == null || v === '') return '';
  switch (c.tipo) {
    case 'moneda': return money(v);
    case 'fecha': return fecha(v);
    case 'numero': return Number(v).toLocaleString('es-AR', { maximumFractionDigits: 3 });
    case 'pct': return `${Number(v).toLocaleString('es-AR', { maximumFractionDigits: 1 })} %`;
    case 'entero': return String(v);
    default: return MEDIO_PAGO_LABEL[v as MedioPago] ?? ESTADO_OT_LABEL[v as EstadoOT] ?? String(v);
  }
}
/** Formato para planillas en español: importes con coma decimal y sin símbolo, fechas dd/mm/aaaa. */
function paraCSV(c: Col, v: any): string | number {
  if (v == null || v === '') return '';
  switch (c.tipo) {
    case 'moneda': return pesosCSV(v);
    case 'fecha': return fecha(v);
    case 'numero': case 'pct': return COMA(v);
    default: return mostrar(c, v);
  }
}

export function Informes() {
  const { puede, me } = useAuth();
  const disponibles = INFORMES.filter((i) => !i.permiso || puede(i.permiso));
  const [clave, setClave] = useState(disponibles[0]?.clave ?? 'ventas');
  const def = disponibles.find((i) => i.clave === clave) ?? disponibles[0];
  const [desde, setDesde] = useState(primerDiaMes());
  const [hasta, setHasta] = useState(hoyISO());
  const [f, setF] = useState<Record<string, string>>({});
  const dq = useDebounce(f.q ?? '');
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const cambiar = (k: string) => { setClave(k); setF({}); };

  const quiere = (x: Filtro) => def.filtros.includes(x);
  const { data: clientes = [] } = useQuery({ queryKey: ['clientes', 'lista'], queryFn: () => api.get<any[]>('/clientes?limite=500'), enabled: quiere('cliente'), staleTime: 60_000 });
  const { data: provs = [] } = useQuery({ queryKey: ['proveedores'], queryFn: () => api.get<any[]>('/proveedores'), enabled: quiere('proveedor'), staleTime: 60_000 });
  const { data: cats = [] } = useQuery({ queryKey: ['categorias-articulo'], queryFn: () => api.get<any[]>('/categorias-articulo'), enabled: quiere('categoria'), staleTime: 60_000 });
  const { data: catsG = [] } = useQuery({ queryKey: ['gastos', 'categorias', 'todas'], queryFn: () => api.get<any[]>('/categorias-gasto?todas=1'), enabled: quiere('categoria_gasto') });
  const { data: mecs = [] } = useQuery({ queryKey: ['mecanicos'], queryFn: () => api.get<any[]>('/mecanicos'), enabled: quiere('mecanico'), staleTime: 60_000 });
  const { data: arts = [] } = useQuery({ queryKey: ['articulos', { informes: 1 }], queryFn: () => api.get<any[]>('/articulos?limite=1000'), enabled: quiere('articulo'), staleTime: 60_000 });

  const periodo = def.periodo !== false;
  const params = qs({
    desde: periodo ? desde : '2000-01-01', hasta: periodo ? hasta : hoyISO(),
    cliente_id: quiere('cliente') ? f.cliente_id : undefined, proveedor_id: quiere('proveedor') ? f.proveedor_id : undefined, articulo_id: quiere('articulo') ? f.articulo_id : undefined,
    categoria_id: quiere('categoria') ? f.categoria_id : quiere('categoria_gasto') ? f.categoria_gasto_id : undefined, mecanico_id: quiere('mecanico') ? f.mecanico_id : undefined,
    estado: quiere('estado_ot') ? f.estado_ot : quiere('estado_doc') ? f.estado_doc : undefined, agrupar: quiere('agrupar') ? f.agrupar || def.agrupar?.[0][0] : undefined, q: quiere('q') ? dq : undefined,
  });
  const valido = !periodo || (desde && hasta && desde <= hasta);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['informes', def.clave, params], queryFn: () => api.get(`/informes/${def.clave}${params}`), enabled: !!valido });
  const grupos = useMemo(() => [...new Set(disponibles.map((i) => i.grupo))], [disponibles]);

  const toast = useToast();
  const exportar = async () => {
    if (!data) return;
    // La exportación es una acción con permiso propio: el servidor la autoriza y la deja registrada.
    try {
      await api.get(`/informes/${def.clave}${params}&exportar=1`);
    } catch (e) {
      toast.error(e);
      return;
    }
    const cols: Col[] = data.columnas;
    const filas = data.filas.map((r: any) => cols.map((c) => paraCSV(c, r[c.clave])));
    if (data.totales) filas.push(cols.map((c, i) => (i === 0 ? 'TOTAL' : data.totales[c.clave] != null ? paraCSV(c, data.totales[c.clave]) : '')));
    descargarCSV(`${def.clave}${periodo ? `-${desde}_${hasta}` : ''}`, cols.map((c) => c.titulo), filas);
  };

  return (
    <>
      <Encabezado titulo="Informes" subtitulo="Reportes con datos reales, exportables a Excel (CSV) y a PDF" acciones={<>{puede('informes.exportar') && <Boton icono={<Download className="size-4" />} onClick={exportar} disabled={!data?.filas.length}>CSV (Excel)</Boton>}<Boton icono={<Printer className="size-4" />} onClick={() => window.print()} disabled={!data}>Imprimir / PDF</Boton></>} />
      <div className="grid gap-5 lg:grid-cols-[220px_1fr]">
        <nav className="no-print space-y-4 lg:sticky lg:top-4 lg:self-start">
          {grupos.map((g) => (
            <div key={g}>
              <div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{g}</div>
              <ul className="flex flex-wrap gap-1 lg:block lg:space-y-0.5">
                {disponibles.filter((i) => i.grupo === g).map((i) => (
                  <li key={i.clave}><button type="button" onClick={() => cambiar(i.clave)} className={`w-full rounded-lg px-2.5 py-1.5 text-left text-sm font-medium ${i.clave === def.clave ? 'bg-marca-50 text-marca-700' : 'text-slate-600 hover:bg-slate-100'}`}>{i.titulo}</button></li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="min-w-0">
          <div className="no-print">
            {periodo && <SelectorPeriodo desde={desde} hasta={hasta} onCambio={(d, h) => { setDesde(d); setHasta(h); }} />}
            <div className="mb-4 flex flex-wrap items-end gap-3">
              {quiere('agrupar') && def.agrupar && <Campo label="Agrupar"><Select className="w-auto" value={f.agrupar ?? def.agrupar[0][0]} onChange={(e) => set('agrupar', e.target.value)}>{def.agrupar.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</Select></Campo>}
              {quiere('estado_doc') && def.estados && <Campo label="Estado"><Select className="w-auto" value={f.estado_doc ?? ''} onChange={(e) => set('estado_doc', e.target.value)}><option value="">{def.estados[0][1]}</option>{def.estados.slice(1).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</Select></Campo>}
              {quiere('estado_ot') && <Campo label="Estado de la OT"><Select className="w-auto" value={f.estado_ot ?? ''} onChange={(e) => set('estado_ot', e.target.value)}><option value="">Todos</option>{ESTADOS_OT.map((e) => <option key={e} value={e}>{ESTADO_OT_LABEL[e]}</option>)}</Select></Campo>}
              {quiere('cliente') && <Campo label="Cliente"><Select className="w-auto max-w-56" value={f.cliente_id ?? ''} onChange={(e) => set('cliente_id', e.target.value)}><option value="">Todos</option>{clientes.map((c: any) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</Select></Campo>}
              {quiere('proveedor') && <Campo label="Proveedor"><Select className="w-auto max-w-56" value={f.proveedor_id ?? ''} onChange={(e) => set('proveedor_id', e.target.value)}><option value="">Todos</option>{provs.map((p: any) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</Select></Campo>}
              {quiere('articulo') && <Campo label="Artículo"><Select className="w-auto max-w-56" value={f.articulo_id ?? ''} onChange={(e) => set('articulo_id', e.target.value)}><option value="">Todos</option>{arts.map((a: any) => <option key={a.id} value={a.id}>{a.nombre}</option>)}</Select></Campo>}
              {quiere('categoria') && <Campo label="Categoría"><Select className="w-auto" value={f.categoria_id ?? ''} onChange={(e) => set('categoria_id', e.target.value)}><option value="">Todas</option>{cats.map((c: any) => <option key={c.id} value={c.id}>{c.nombre}</option>)}<option value="sin">Sin categoría</option></Select></Campo>}
              {quiere('categoria_gasto') && <Campo label="Categoría de gasto"><Select className="w-auto" value={f.categoria_gasto_id ?? ''} onChange={(e) => set('categoria_gasto_id', e.target.value)}><option value="">Todas</option>{catsG.map((c: any) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</Select></Campo>}
              {quiere('mecanico') && <Campo label="Mecánico"><Select className="w-auto" value={f.mecanico_id ?? ''} onChange={(e) => set('mecanico_id', e.target.value)}><option value="">Todos</option>{mecs.map((m: any) => <option key={m.id} value={m.id}>{m.nombre}</option>)}<option value="sin">Sin asignar</option></Select></Campo>}
              {quiere('q') && <Buscador value={f.q ?? ''} onChange={(v) => set('q', v)} placeholder="Texto…" className="min-w-48" />}
            </div>
          </div>
          {!valido ? <Aviso tono="ambar">Elegí un período válido.</Aviso> : isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : data && (
            <Tarjeta titulo={data.titulo} subtitulo={periodo ? `Del ${fecha(desde)} al ${fecha(hasta)}` : `Al ${fecha(hoyISO())}`} sinPadding>
              {data.filas.length === 0 ? <Vacio titulo="Sin datos" texto="No hay registros con esos filtros en el período." /> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-borde bg-slate-50/70 text-left text-xs font-semibold uppercase tracking-wide text-tenue">
                        {data.columnas.map((c: Col) => <th key={c.clave} className={`px-3 py-2.5 ${['moneda', 'numero', 'entero', 'pct'].includes(c.tipo) ? 'text-right' : ''}`}>{c.titulo}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {data.filas.map((r: any, i: number) => (
                        <tr key={i} className="border-b border-borde last:border-0">
                          {data.columnas.map((c: Col) => <td key={c.clave} className={`px-3 py-2 ${['moneda', 'numero', 'entero', 'pct'].includes(c.tipo) ? 'text-right tabular-nums' : ''}`}>{c.clave === 'numero' && c.tipo === 'entero' ? numero(r[c.clave]) : mostrar(c, r[c.clave])}</td>)}
                        </tr>
                      ))}
                    </tbody>
                    {data.totales && (
                      <tfoot>
                        <tr className="border-t-2 border-borde bg-slate-50 font-semibold">
                          {data.columnas.map((c: Col, i: number) => <td key={c.clave} className={`px-3 py-2.5 ${['moneda', 'numero', 'entero', 'pct'].includes(c.tipo) ? 'text-right tabular-nums' : ''}`}>{i === 0 ? 'Total' : data.totales[c.clave] != null ? mostrar(c, data.totales[c.clave]) : ''}</td>)}
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              )}
            </Tarjeta>
          )}
          {data?.nota && <p className="mt-2 text-xs text-tenue">{data.nota}</p>}
          <p className="mt-1 hidden text-xs text-tenue print:block">{me?.taller.nombre} — informe interno de gestión (no es un documento fiscal). Generado el {fecha(new Date().toISOString())}.</p>
        </div>
      </div>
    </>
  );
}
