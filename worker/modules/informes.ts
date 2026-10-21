// Informes y estadísticas avanzadas (todos con datos reales) y registros internos de contabilidad.
//
// Cada informe devuelve una tabla genérica { columnas, filas, totales } para que el mismo componente la muestre, la imprima
// y la exporte a CSV. Importes en centavos; el formato argentino lo aplica el cliente.
//
// Los registros contables son INTERNOS: no son libros fiscales (IVA Ventas/Compras) ni declaraciones ante ARCA.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, notFound, query, zFecha } from '../lib/http';
import { all, first, like } from '../lib/db';
import { autorizarExportacion } from '../lib/exportar';
import { requirePerm, tiene } from '../lib/auth';
import type { Permiso } from '../../shared/permisos';
import { redondearCantidad as r3 } from '../../shared/dominio';
import { deudaProveedores } from '../lib/proveedores';
import { IMPORTE_FIRMADO_SQL } from '../lib/caja';
import { forbidden } from '../lib/http';

export const informes = new Hono<AppEnv>();

type TipoCol = 'texto' | 'fecha' | 'moneda' | 'numero' | 'entero' | 'pct';
interface Col { clave: string; titulo: string; tipo: TipoCol }
const col = (clave: string, titulo: string, tipo: TipoCol = 'texto'): Col => ({ clave, titulo, tipo });
interface Informe { titulo: string; columnas: Col[]; filas: Array<Record<string, any>>; totales?: Record<string, number | string>; nota?: string }

const sumar = (filas: Array<Record<string, any>>, claves: string[]) => Object.fromEntries(claves.map((k) => [k, filas.reduce((a, f) => a + (Number(f[k]) || 0), 0)]));
const pctMargen = (venta: number, costo: number) => (venta > 0 ? Math.round(((venta - costo) / venta) * 1000) / 10 : 0);

const zFiltros = z.object({
  desde: zFecha,
  hasta: zFecha,
  estado: z.string().optional(),
  cliente_id: z.string().optional(),
  proveedor_id: z.string().optional(),
  articulo_id: z.string().optional(),
  categoria_id: z.string().optional(),
  mecanico_id: z.string().optional(),
  agrupar: z.string().optional(),
  q: z.string().optional(),
});
type Filtros = z.infer<typeof zFiltros>;

interface Ctx { db: D1Database; t: string; f: Filtros; puedeCostos: boolean }

// ───────────── Ventas ─────────────
async function ventasPeriodo({ db, t, f }: Ctx): Promise<Informe> {
  const cond = ['ve.taller_id = ?', 've.fecha BETWEEN ? AND ?', 've.estado = ?'];
  const params: unknown[] = [t, f.desde, f.hasta, f.estado === 'anulada' ? 'anulada' : 'emitida'];
  if (f.cliente_id) (cond.push('ve.cliente_id = ?'), params.push(f.cliente_id));
  const detalle = f.agrupar === 'detalle';
  if (detalle) {
    const filas = await all(db, `SELECT ve.fecha, ve.numero, c.nombre AS cliente, ve.condicion, ve.neto, ve.iva, ve.total, ve.cobrado, ve.total - ve.cobrado AS saldo FROM ventas ve JOIN clientes c ON c.taller_id = ve.taller_id AND c.id = ve.cliente_id WHERE ${cond.join(' AND ')} ORDER BY ve.fecha, ve.numero LIMIT 5000`, ...params);
    return { titulo: 'Ventas por comprobante', columnas: [col('fecha', 'Fecha', 'fecha'), col('numero', 'N°', 'entero'), col('cliente', 'Cliente'), col('condicion', 'Condición'), col('neto', 'Neto', 'moneda'), col('iva', 'IVA', 'moneda'), col('total', 'Total', 'moneda'), col('cobrado', 'Cobrado', 'moneda'), col('saldo', 'Saldo', 'moneda')], filas, totales: sumar(filas, ['neto', 'iva', 'total', 'cobrado', 'saldo']) };
  }
  const clave = f.agrupar === 'mes' ? 'substr(ve.fecha,1,7)' : 've.fecha';
  const filas = await all(db, `SELECT ${clave} AS periodo, COUNT(*) AS comprobantes, SUM(ve.neto) AS neto, SUM(ve.iva) AS iva, SUM(ve.total) AS total, SUM(ve.cobrado) AS cobrado, SUM(ve.total - ve.cobrado) AS saldo FROM ventas ve WHERE ${cond.join(' AND ')} GROUP BY periodo ORDER BY periodo`, ...params);
  return { titulo: f.agrupar === 'mes' ? 'Ventas por mes' : 'Ventas por día', columnas: [col('periodo', f.agrupar === 'mes' ? 'Mes' : 'Fecha', f.agrupar === 'mes' ? 'texto' : 'fecha'), col('comprobantes', 'Comprobantes', 'entero'), col('neto', 'Neto', 'moneda'), col('iva', 'IVA', 'moneda'), col('total', 'Total', 'moneda'), col('cobrado', 'Cobrado', 'moneda'), col('saldo', 'Saldo', 'moneda')], filas, totales: sumar(filas, ['comprobantes', 'neto', 'iva', 'total', 'cobrado', 'saldo']) };
}

function baseItems(f: Filtros, t: string, tipo: 'articulo' | 'servicio'): { cond: string[]; params: unknown[] } {
  const cond = ['vi.taller_id = ?', "ve.estado = 'emitida'", 've.fecha BETWEEN ? AND ?'];
  const params: unknown[] = [t, f.desde, f.hasta];
  cond.push(tipo === 'articulo' ? "vi.tipo = 'articulo'" : "vi.tipo IN ('servicio','libre')");
  if (f.cliente_id) (cond.push('ve.cliente_id = ?'), params.push(f.cliente_id));
  if (tipo === 'articulo') {
    if (f.articulo_id) (cond.push('vi.articulo_id = ?'), params.push(f.articulo_id));
    if (f.categoria_id) (cond.push(f.categoria_id === 'sin' ? 'a.categoria_id IS NULL' : 'a.categoria_id = ?'), f.categoria_id !== 'sin' && params.push(f.categoria_id));
    if (f.proveedor_id) (cond.push('a.proveedor_id = ?'), params.push(f.proveedor_id));
  }
  if (f.q) (cond.push('vi.descripcion LIKE ?'), params.push(like(f.q)));
  return { cond, params };
}
const FROM_ITEMS = 'FROM venta_items vi JOIN ventas ve ON ve.taller_id = vi.taller_id AND ve.id = vi.venta_id LEFT JOIN articulos a ON a.taller_id = vi.taller_id AND a.id = vi.articulo_id LEFT JOIN categorias_articulo ca ON ca.taller_id = a.taller_id AND ca.id = a.categoria_id';

async function ventasArticulo({ db, t, f, puedeCostos }: Ctx, orden: 'cantidad' | 'total' | 'margen' = 'total', limite = 1000): Promise<Informe> {
  const { cond, params } = baseItems(f, t, 'articulo');
  const filas = await all<any>(
    db,
    `SELECT COALESCE(a.codigo, '') AS codigo, vi.descripcion AS articulo, COALESCE(ca.nombre, 'Sin categoría') AS categoria, SUM(vi.cantidad) AS cantidad, SUM(vi.subtotal) AS total,
            SUM(vi.cantidad * COALESCE(a.costo, 0)) AS costo
       ${FROM_ITEMS} WHERE ${cond.join(' AND ')} GROUP BY COALESCE(vi.articulo_id, vi.descripcion) ORDER BY ${orden === 'cantidad' ? 'cantidad' : orden === 'margen' ? '(total - costo)' : 'total'} DESC LIMIT ?`,
    ...params, limite,
  );
  const out = filas.map((x) => ({ ...x, cantidad: r3(x.cantidad), costo: Math.round(x.costo), margen: x.total - Math.round(x.costo), margen_pct: pctMargen(x.total, Math.round(x.costo)) }));
  const cols = [col('codigo', 'Código'), col('articulo', 'Artículo'), col('categoria', 'Categoría'), col('cantidad', 'Cantidad', 'numero'), col('total', 'Vendido', 'moneda')];
  if (puedeCostos) cols.push(col('costo', 'Costo', 'moneda'), col('margen', 'Margen', 'moneda'), col('margen_pct', 'Margen %', 'pct'));
  const tot: Record<string, number | string> = sumar(out, ['cantidad', 'total', ...(puedeCostos ? ['costo', 'margen'] : [])]);
  if (puedeCostos) tot.margen_pct = pctMargen(Number(tot.total), Number(tot.costo));
  return { titulo: orden === 'cantidad' ? 'Productos más vendidos' : orden === 'margen' ? 'Rentabilidad por artículo' : 'Ventas por artículo', columnas: cols, filas: out, totales: tot, nota: puedeCostos ? 'El costo se calcula con el costo actual del artículo.' : undefined };
}

async function ventasCategoria(ctx: Ctx): Promise<Informe> {
  const { db, t, f, puedeCostos } = ctx;
  const art = baseItems(f, t, 'articulo');
  const srv = baseItems(f, t, 'servicio');
  const [a, s] = await Promise.all([
    all<any>(db, `SELECT COALESCE(ca.nombre, 'Sin categoría') AS categoria, SUM(vi.cantidad) AS cantidad, SUM(vi.subtotal) AS total, SUM(vi.cantidad * COALESCE(a.costo, 0)) AS costo ${FROM_ITEMS} WHERE ${art.cond.join(' AND ')} GROUP BY categoria ORDER BY total DESC`, ...art.params),
    first<any>(db, `SELECT SUM(vi.cantidad) AS cantidad, SUM(vi.subtotal) AS total ${FROM_ITEMS} WHERE ${srv.cond.join(' AND ')}`, ...srv.params),
  ]);
  const filas = [...a.map((x) => ({ ...x, cantidad: r3(x.cantidad), costo: Math.round(x.costo) })), ...(s?.total ? [{ categoria: 'Servicios y mano de obra', cantidad: r3(s.cantidad), total: s.total, costo: 0 }] : [])].map((x) => ({ ...x, margen: x.total - x.costo, margen_pct: pctMargen(x.total, x.costo) }));
  const cols = [col('categoria', 'Categoría'), col('cantidad', 'Cantidad', 'numero'), col('total', 'Vendido', 'moneda')];
  if (puedeCostos) cols.push(col('costo', 'Costo', 'moneda'), col('margen', 'Margen', 'moneda'), col('margen_pct', 'Margen %', 'pct'));
  const tot: Record<string, number | string> = sumar(filas, ['cantidad', 'total', ...(puedeCostos ? ['costo', 'margen'] : [])]);
  if (puedeCostos) tot.margen_pct = pctMargen(Number(tot.total), Number(tot.costo));
  return { titulo: 'Ventas por categoría', columnas: cols, filas, totales: tot };
}

async function serviciosRealizados({ db, t, f }: Ctx): Promise<Informe> {
  const { cond, params } = baseItems(f, t, 'servicio');
  const filas = await all<any>(db, `SELECT vi.descripcion AS servicio, SUM(vi.cantidad) AS cantidad, SUM(vi.subtotal) AS total, ROUND(SUM(vi.subtotal) * 1.0 / SUM(vi.cantidad)) AS promedio ${FROM_ITEMS} WHERE ${cond.join(' AND ')} GROUP BY vi.descripcion ORDER BY cantidad DESC LIMIT 500`, ...params);
  const out = filas.map((x) => ({ ...x, cantidad: r3(x.cantidad) }));
  return { titulo: 'Servicios más realizados', columnas: [col('servicio', 'Servicio'), col('cantidad', 'Veces', 'numero'), col('total', 'Facturado', 'moneda'), col('promedio', 'Promedio', 'moneda')], filas: out, totales: sumar(out, ['cantidad', 'total']) };
}

// ───────────── Compras, gastos, cobranzas ─────────────
async function comprasInforme({ db, t, f }: Ctx): Promise<Informe> {
  const cond = ['co.taller_id = ?', 'co.fecha BETWEEN ? AND ?'];
  const params: unknown[] = [t, f.desde, f.hasta];
  cond.push(f.estado === 'anulada' ? "co.estado = 'anulada'" : "co.estado = 'registrada'");
  if (f.proveedor_id) (cond.push('co.proveedor_id = ?'), params.push(f.proveedor_id));
  if (f.articulo_id) (cond.push('EXISTS (SELECT 1 FROM compra_items ci WHERE ci.taller_id = co.taller_id AND ci.compra_id = co.id AND ci.articulo_id = ?)'), params.push(f.articulo_id));
  if (f.agrupar === 'proveedor') {
    const filas = await all(db, `SELECT p.nombre AS proveedor, COUNT(*) AS compras, SUM(co.neto) AS neto, SUM(co.iva) AS iva, SUM(co.total) AS total FROM compras co JOIN proveedores p ON p.taller_id = co.taller_id AND p.id = co.proveedor_id WHERE ${cond.join(' AND ')} GROUP BY co.proveedor_id ORDER BY total DESC`, ...params);
    return { titulo: 'Compras por proveedor', columnas: [col('proveedor', 'Proveedor'), col('compras', 'Compras', 'entero'), col('neto', 'Neto', 'moneda'), col('iva', 'IVA', 'moneda'), col('total', 'Total', 'moneda')], filas, totales: sumar(filas, ['compras', 'neto', 'iva', 'total']) };
  }
  const filas = await all(db, `SELECT co.fecha, co.numero, p.nombre AS proveedor, co.tipo_doc AS tipo, co.numero_doc AS comprobante, co.neto, co.iva, co.otros, co.total FROM compras co JOIN proveedores p ON p.taller_id = co.taller_id AND p.id = co.proveedor_id WHERE ${cond.join(' AND ')} ORDER BY co.fecha, co.numero LIMIT 5000`, ...params);
  return { titulo: 'Compras', columnas: [col('fecha', 'Fecha', 'fecha'), col('numero', 'N°', 'entero'), col('proveedor', 'Proveedor'), col('tipo', 'Tipo'), col('comprobante', 'Comprobante'), col('neto', 'Neto', 'moneda'), col('iva', 'IVA', 'moneda'), col('otros', 'Otros', 'moneda'), col('total', 'Total', 'moneda')], filas, totales: sumar(filas, ['neto', 'iva', 'otros', 'total']) };
}

async function gastosInforme({ db, t, f }: Ctx): Promise<Informe> {
  const cond = ['g.taller_id = ?', 'g.fecha BETWEEN ? AND ?', f.estado === 'anulado' ? "g.estado = 'anulado'" : "g.estado = 'registrado'"];
  const params: unknown[] = [t, f.desde, f.hasta];
  if (f.categoria_id) (cond.push('g.categoria_id = ?'), params.push(f.categoria_id));
  if (f.proveedor_id) (cond.push('g.proveedor_id = ?'), params.push(f.proveedor_id));
  if (f.agrupar === 'detalle') {
    const filas = await all(db, `SELECT g.fecha, g.numero, cg.nombre AS categoria, g.concepto, g.medio, g.importe FROM gastos g JOIN categorias_gasto cg ON cg.taller_id = g.taller_id AND cg.id = g.categoria_id WHERE ${cond.join(' AND ')} ORDER BY g.fecha, g.numero LIMIT 5000`, ...params);
    return { titulo: 'Gastos', columnas: [col('fecha', 'Fecha', 'fecha'), col('numero', 'N°', 'entero'), col('categoria', 'Categoría'), col('concepto', 'Concepto'), col('medio', 'Medio'), col('importe', 'Importe', 'moneda')], filas, totales: sumar(filas, ['importe']) };
  }
  const filas = await all(db, `SELECT cg.nombre AS categoria, cg.tipo, COUNT(*) AS cantidad, SUM(g.importe) AS importe FROM gastos g JOIN categorias_gasto cg ON cg.taller_id = g.taller_id AND cg.id = g.categoria_id WHERE ${cond.join(' AND ')} GROUP BY cg.id ORDER BY importe DESC`, ...params);
  return { titulo: 'Gastos por categoría', columnas: [col('categoria', 'Categoría'), col('tipo', 'Tipo'), col('cantidad', 'Cantidad', 'entero'), col('importe', 'Importe', 'moneda')], filas, totales: sumar(filas, ['cantidad', 'importe']) };
}

async function cobranzasInforme({ db, t, f }: Ctx): Promise<Informe> {
  if (f.agrupar === 'medio') {
    const filas = await all(db, `SELECT cm.medio, COUNT(*) AS cantidad, SUM(cm.importe) AS importe FROM cobro_medios cm JOIN cobros co ON co.taller_id = cm.taller_id AND co.id = cm.cobro_id WHERE cm.taller_id = ? AND co.estado = 'registrado' AND co.fecha BETWEEN ? AND ? ${f.cliente_id ? 'AND co.cliente_id = ?' : ''} GROUP BY cm.medio ORDER BY importe DESC`, t, f.desde, f.hasta, ...(f.cliente_id ? [f.cliente_id] : []));
    return { titulo: 'Cobranzas por medio de pago', columnas: [col('medio', 'Medio'), col('cantidad', 'Cobros', 'entero'), col('importe', 'Importe', 'moneda')], filas, totales: sumar(filas, ['cantidad', 'importe']) };
  }
  const cond = ['co.taller_id = ?', 'co.fecha BETWEEN ? AND ?', f.estado === 'anulado' ? "co.estado = 'anulado'" : "co.estado = 'registrado'"];
  const params: unknown[] = [t, f.desde, f.hasta];
  if (f.cliente_id) (cond.push('co.cliente_id = ?'), params.push(f.cliente_id));
  const filas = await all(db, `SELECT co.fecha, co.numero, c.nombre AS cliente, (SELECT GROUP_CONCAT(DISTINCT medio) FROM cobro_medios x WHERE x.taller_id = co.taller_id AND x.cobro_id = co.id) AS medios, co.total FROM cobros co JOIN clientes c ON c.taller_id = co.taller_id AND c.id = co.cliente_id WHERE ${cond.join(' AND ')} ORDER BY co.fecha, co.numero LIMIT 5000`, ...params);
  return { titulo: 'Cobranzas', columnas: [col('fecha', 'Fecha', 'fecha'), col('numero', 'Recibo', 'entero'), col('cliente', 'Cliente'), col('medios', 'Medios'), col('total', 'Total', 'moneda')], filas, totales: sumar(filas, ['total']) };
}

async function deudoresInforme({ db, t, f }: Ctx): Promise<Informe> {
  const dias = "(julianday(date('now', '-3 hours')) - julianday(ve.fecha))";
  const cond = ['ve.taller_id = ?', "ve.estado = 'emitida'", 've.cobrado < ve.total'];
  const params: unknown[] = [t];
  if (f.cliente_id) (cond.push('ve.cliente_id = ?'), params.push(f.cliente_id));
  const filas = await all(
    db,
    `SELECT c.nombre AS cliente, c.telefono, COUNT(*) AS comprobantes, MIN(ve.fecha) AS deuda_desde, SUM(ve.total - ve.cobrado) AS saldo,
            SUM(CASE WHEN ${dias} <= 30 THEN ve.total - ve.cobrado ELSE 0 END) AS v_0, SUM(CASE WHEN ${dias} > 30 AND ${dias} <= 60 THEN ve.total - ve.cobrado ELSE 0 END) AS v_30,
            SUM(CASE WHEN ${dias} > 60 AND ${dias} <= 90 THEN ve.total - ve.cobrado ELSE 0 END) AS v_60, SUM(CASE WHEN ${dias} > 90 THEN ve.total - ve.cobrado ELSE 0 END) AS v_90
       FROM ventas ve JOIN clientes c ON c.taller_id = ve.taller_id AND c.id = ve.cliente_id WHERE ${cond.join(' AND ')} GROUP BY c.id ORDER BY saldo DESC`,
    ...params,
  );
  return { titulo: 'Deudores (cuentas corrientes de clientes)', columnas: [col('cliente', 'Cliente'), col('telefono', 'Teléfono'), col('comprobantes', 'Comprob.', 'entero'), col('deuda_desde', 'Deuda desde', 'fecha'), col('v_0', '0-30 días', 'moneda'), col('v_30', '31-60', 'moneda'), col('v_60', '61-90', 'moneda'), col('v_90', '+90', 'moneda'), col('saldo', 'Saldo', 'moneda')], filas, totales: sumar(filas, ['comprobantes', 'v_0', 'v_30', 'v_60', 'v_90', 'saldo']), nota: 'Al día de hoy; no depende del período elegido.' };
}

async function proveedoresInforme({ db, t, f }: Ctx): Promise<Informe> {
  const deudas = await deudaProveedores(db, t, f.proveedor_id);
  const provs = await all<{ id: string; nombre: string; cuit: string | null }>(db, 'SELECT id, nombre, cuit FROM proveedores WHERE taller_id = ?', t);
  const filas = deudas.filter((d) => d.saldo !== 0).map((d) => ({ proveedor: provs.find((p) => p.id === d.proveedor_id)?.nombre ?? '—', cuit: provs.find((p) => p.id === d.proveedor_id)?.cuit ?? '', comprobantes: d.docs.length, vencido: d.vencido, por_vencer: d.por_vencer, saldo: d.saldo, proximo_vencimiento: d.docs.map((x) => x.vencimiento).sort()[0] ?? null })).sort((a, b) => b.saldo - a.saldo);
  return { titulo: 'Deuda con proveedores', columnas: [col('proveedor', 'Proveedor'), col('cuit', 'CUIT'), col('comprobantes', 'Comprob. pendientes', 'entero'), col('proximo_vencimiento', 'Próx. vencimiento', 'fecha'), col('vencido', 'Vencido', 'moneda'), col('por_vencer', 'Vence en 7 días', 'moneda'), col('saldo', 'Saldo', 'moneda')], filas, totales: sumar(filas, ['comprobantes', 'vencido', 'por_vencer', 'saldo']), nota: 'Al día de hoy. Los pagos se imputan al comprobante más antiguo.' };
}

async function inventarioValorizado({ db, t, f }: Ctx): Promise<Informe> {
  const cond = ['a.taller_id = ?', 'a.activo = 1'];
  const params: unknown[] = [t];
  if (f.categoria_id) (cond.push(f.categoria_id === 'sin' ? 'a.categoria_id IS NULL' : 'a.categoria_id = ?'), f.categoria_id !== 'sin' && params.push(f.categoria_id));
  if (f.proveedor_id) (cond.push('a.proveedor_id = ?'), params.push(f.proveedor_id));
  const filas = await all<any>(db, `SELECT a.codigo, a.nombre AS articulo, COALESCE(ca.nombre, 'Sin categoría') AS categoria, a.stock, a.costo, a.precio FROM articulos a LEFT JOIN categorias_articulo ca ON ca.taller_id = a.taller_id AND ca.id = a.categoria_id WHERE ${cond.join(' AND ')} ORDER BY categoria COLLATE NOCASE, a.nombre COLLATE NOCASE LIMIT 5000`, ...params);
  const out = filas.map((x) => ({ ...x, stock: r3(x.stock), valor_costo: Math.round(r3(x.stock) * x.costo), valor_venta: Math.round(r3(x.stock) * x.precio) }));
  return { titulo: 'Inventario valorizado', columnas: [col('codigo', 'Código'), col('articulo', 'Artículo'), col('categoria', 'Categoría'), col('stock', 'Stock', 'numero'), col('costo', 'Costo unit.', 'moneda'), col('valor_costo', 'Valor a costo', 'moneda'), col('precio', 'Precio unit.', 'moneda'), col('valor_venta', 'Valor a precio', 'moneda')], filas: out, totales: sumar(out, ['valor_costo', 'valor_venta']), nota: 'Valorización al día de hoy con el costo vigente de cada artículo.' };
}

// ───────────── Taller ─────────────
async function mecanicosInforme({ db, t, f }: Ctx): Promise<Informe> {
  const cond = ["o.taller_id = ?", "o.estado IN ('lista','entregada')", "substr(COALESCE(o.fecha_lista, o.fecha_ingreso),1,10) BETWEEN ? AND ?"];
  const params: unknown[] = [t, f.desde, f.hasta];
  if (f.mecanico_id) (cond.push(f.mecanico_id === 'sin' ? 'o.mecanico_id IS NULL' : 'o.mecanico_id = ?'), f.mecanico_id !== 'sin' && params.push(f.mecanico_id));
  const filas = await all<any>(db, `SELECT COALESCE(m.nombre, 'Sin asignar') AS mecanico, COUNT(*) AS ordenes, SUM(o.subtotal_servicios) AS mano_obra, SUM(o.subtotal_articulos) AS repuestos, SUM(o.total) AS total, ROUND(AVG(o.total)) AS ticket FROM ordenes o LEFT JOIN mecanicos m ON m.taller_id = o.taller_id AND m.id = o.mecanico_id WHERE ${cond.join(' AND ')} GROUP BY o.mecanico_id ORDER BY ordenes DESC`, ...params);
  return { titulo: 'Rendimiento de mecánicos', columnas: [col('mecanico', 'Mecánico'), col('ordenes', 'OT terminadas', 'entero'), col('mano_obra', 'Mano de obra', 'moneda'), col('repuestos', 'Repuestos', 'moneda'), col('total', 'Total OT', 'moneda'), col('ticket', 'Ticket promedio', 'moneda')], filas, totales: sumar(filas, ['ordenes', 'mano_obra', 'repuestos', 'total']), nota: 'Cuenta las OT que pasaron a "Lista para entregar" o "Entregada" en el período.' };
}

async function ordenesInforme({ db, t, f }: Ctx): Promise<Informe> {
  const cond = ['o.taller_id = ?', 'substr(o.fecha_ingreso,1,10) BETWEEN ? AND ?'];
  const params: unknown[] = [t, f.desde, f.hasta];
  if (f.estado) (cond.push('o.estado = ?'), params.push(f.estado));
  if (f.cliente_id) (cond.push('o.cliente_id = ?'), params.push(f.cliente_id));
  if (f.mecanico_id) (cond.push(f.mecanico_id === 'sin' ? 'o.mecanico_id IS NULL' : 'o.mecanico_id = ?'), f.mecanico_id !== 'sin' && params.push(f.mecanico_id));
  const filas = await all(db, `SELECT substr(o.fecha_ingreso,1,10) AS fecha, o.numero, c.nombre AS cliente, v.patente, COALESCE(m.nombre, 'Sin asignar') AS mecanico, o.estado, o.total FROM ordenes o JOIN clientes c ON c.taller_id = o.taller_id AND c.id = o.cliente_id JOIN vehiculos v ON v.taller_id = o.taller_id AND v.id = o.vehiculo_id LEFT JOIN mecanicos m ON m.taller_id = o.taller_id AND m.id = o.mecanico_id WHERE ${cond.join(' AND ')} ORDER BY o.fecha_ingreso, o.numero LIMIT 5000`, ...params);
  return { titulo: 'Órdenes de trabajo', columnas: [col('fecha', 'Ingreso', 'fecha'), col('numero', 'N°', 'entero'), col('cliente', 'Cliente'), col('patente', 'Patente'), col('mecanico', 'Mecánico'), col('estado', 'Estado'), col('total', 'Total', 'moneda')], filas, totales: sumar(filas, ['total']) };
}

async function actividadFinanciera({ db, t, f }: Ctx): Promise<Informe> {
  const clave = f.agrupar === 'mes' ? 'substr(fecha,1,7)' : 'fecha';
  const [caja, banco] = await Promise.all([
    all<any>(db, `SELECT ${clave} AS periodo, SUM(CASE WHEN tipo = 'ingreso' THEN importe ELSE 0 END) AS ingresos, SUM(CASE WHEN tipo = 'egreso' THEN importe ELSE 0 END) AS egresos FROM caja_movimientos WHERE taller_id = ? AND fecha BETWEEN ? AND ? AND rubro <> 'traspaso' GROUP BY periodo`, t, f.desde, f.hasta),
    all<any>(db, `SELECT ${clave.replace('fecha', 'm.fecha')} AS periodo, SUM(CASE WHEN m.tipo = 'ingreso' THEN m.importe ELSE 0 END) AS ingresos, SUM(CASE WHEN m.tipo = 'egreso' THEN m.importe ELSE 0 END) AS egresos FROM banco_movimientos m JOIN cuentas_bancarias cb ON cb.taller_id = m.taller_id AND cb.id = m.cuenta_id WHERE m.taller_id = ? AND m.fecha BETWEEN ? AND ? AND m.afecta_resultado = 1 AND cb.moneda = 'ARS' GROUP BY periodo`, t, f.desde, f.hasta),
  ]);
  const mapa = new Map<string, { periodo: string; ingresos: number; egresos: number }>();
  for (const r of [...caja, ...banco]) {
    const x = mapa.get(r.periodo) ?? { periodo: r.periodo, ingresos: 0, egresos: 0 };
    x.ingresos += r.ingresos;
    x.egresos += r.egresos;
    mapa.set(r.periodo, x);
  }
  const filas = [...mapa.values()].sort((a, b) => (a.periodo < b.periodo ? -1 : 1)).map((x) => ({ ...x, resultado: x.ingresos - x.egresos }));
  return { titulo: 'Actividad financiera', columnas: [col('periodo', f.agrupar === 'mes' ? 'Mes' : 'Fecha', f.agrupar === 'mes' ? 'texto' : 'fecha'), col('ingresos', 'Ingresos', 'moneda'), col('egresos', 'Egresos', 'moneda'), col('resultado', 'Resultado', 'moneda')], filas, totales: sumar(filas, ['ingresos', 'egresos', 'resultado']), nota: 'Base caja: lo efectivamente cobrado y pagado. Depósitos y transferencias entre cuentas propias no se cuentan.' };
}

const TIPOS: Record<string, { fn: (c: Ctx) => Promise<Informe>; permiso?: Permiso; costos?: boolean }> = {
  ventas: { fn: ventasPeriodo },
  'ventas-articulo': { fn: (c) => ventasArticulo(c, 'total') },
  'ventas-categoria': { fn: ventasCategoria },
  rentabilidad: { fn: (c) => ventasArticulo(c, 'margen'), permiso: 'margenes.ver', costos: true },
  'mas-vendidos': { fn: (c) => ventasArticulo(c, 'cantidad', 50) },
  servicios: { fn: serviciosRealizados },
  compras: { fn: comprasInforme },
  gastos: { fn: gastosInforme, permiso: 'finanzas.ver' },
  cobranzas: { fn: cobranzasInforme },
  deudores: { fn: deudoresInforme },
  proveedores: { fn: proveedoresInforme },
  'inventario-valorizado': { fn: inventarioValorizado, permiso: 'stock.valorizar' },
  mecanicos: { fn: mecanicosInforme },
  ordenes: { fn: ordenesInforme },
  'actividad-financiera': { fn: actividadFinanciera, permiso: 'finanzas.ver' },
};

informes.get('/informes/:tipo', requirePerm('reportes.ver'), async (c) => {
  const s = c.get('sesion');
  const def = TIPOS[c.req.param('tipo')];
  if (!def) throw notFound('Informe');
  if (def.permiso && !tiene(s, def.permiso)) throw forbidden();
  const f = query(c, zFiltros);
  if (f.desde > f.hasta) throw badRequest('El período es inválido');
  await autorizarExportacion(c, c.req.param('tipo'));
  const r = await def.fn({ db: c.env.DB, t: s.tallerId, f, puedeCostos: tiene(s, 'margenes.ver') });
  return c.json({ tipo: c.req.param('tipo'), filtros: f, generado: new Date().toISOString(), ...r });
});

// ═════════════════════ Registros internos (contabilidad) ═════════════════════
const NOTA_INTERNA = 'Registro INTERNO de gestión. No es un libro fiscal (IVA Ventas / IVA Compras) ni una declaración válida ante ARCA.';

informes.get('/contabilidad/libro-ventas', requirePerm('contabilidad.ver'), async (c) => {
  const s = c.get('sesion');
  await autorizarExportacion(c, 'contabilidad-libro-ventas');
  const f = query(c, z.object({ desde: zFecha, hasta: zFecha, estado: z.string().optional() }));
  const filas = await all<any>(
    c.env.DB,
    `SELECT ve.fecha, ve.numero, ve.estado, c.nombre AS cliente, COALESCE(c.documento, '') AS documento, c.condicion_iva, ve.condicion, ve.iva_pct, ve.neto, ve.iva, ve.recargo, ve.total,
            CASE WHEN EXISTS (SELECT 1 FROM comprobantes_fiscales cf WHERE cf.taller_id = ve.taller_id AND cf.venta_id = ve.id AND cf.estado = 'autorizado') THEN 'Con factura fiscal' ELSE 'Comprobante interno' END AS tipo
       FROM ventas ve JOIN clientes c ON c.taller_id = ve.taller_id AND c.id = ve.cliente_id
      WHERE ve.taller_id = ? AND ve.fecha BETWEEN ? AND ? ${f.estado ? 'AND ve.estado = ?' : ''} ORDER BY ve.fecha, ve.numero LIMIT 10000`,
    s.tallerId, f.desde, f.hasta, ...(f.estado ? [f.estado] : []),
  );
  const vigentes = filas.filter((x) => x.estado === 'emitida');
  const porAlicuota = new Map<number, { iva_pct: number; comprobantes: number; neto: number; iva: number; total: number }>();
  for (const x of vigentes) {
    const a = porAlicuota.get(x.iva_pct) ?? { iva_pct: x.iva_pct, comprobantes: 0, neto: 0, iva: 0, total: 0 };
    a.comprobantes++;
    a.neto += x.neto;
    a.iva += x.iva;
    a.total += x.total;
    porAlicuota.set(x.iva_pct, a);
  }
  return c.json({
    nota: NOTA_INTERNA, desde: f.desde, hasta: f.hasta, filas,
    totales: { ...sumar(vigentes, ['neto', 'iva', 'recargo', 'total']), comprobantes: vigentes.length, anulados: filas.length - vigentes.length },
    por_alicuota: [...porAlicuota.values()].sort((a, b) => a.iva_pct - b.iva_pct),
  });
});

informes.get('/contabilidad/libro-compras', requirePerm('contabilidad.ver'), async (c) => {
  const s = c.get('sesion');
  await autorizarExportacion(c, 'contabilidad-libro-compras');
  const f = query(c, z.object({ desde: zFecha, hasta: zFecha }));
  const [compras, facturas] = await Promise.all([
    all<any>(
      c.env.DB,
      `SELECT co.fecha, 'Compra' AS origen, co.numero, p.nombre AS proveedor, COALESCE(p.cuit, '') AS cuit,
              COALESCE((SELECT f.nro_comprobante FROM facturas_proveedor f WHERE f.taller_id = co.taller_id AND f.compra_id = co.id AND f.estado = 'registrada' AND f.tipo NOT LIKE 'nota_credito%' LIMIT 1), co.numero_doc, '') AS comprobante,
              co.tipo_doc AS tipo, co.neto AS neto_gravado, 0 AS no_gravado, 0 AS iva_21, 0 AS iva_10_5, 0 AS iva_27, co.iva AS iva_otros, co.otros AS otros_tributos, co.total
         FROM compras co JOIN proveedores p ON p.taller_id = co.taller_id AND p.id = co.proveedor_id
        WHERE co.taller_id = ? AND co.estado = 'registrada' AND co.fecha BETWEEN ? AND ?`,
      s.tallerId, f.desde, f.hasta,
    ),
    // Las facturas asociadas a una compra ya están contadas en la compra: no se suman dos veces (salvo notas de crédito).
    all<any>(
      c.env.DB,
      `SELECT fp.fecha, 'Factura de proveedor' AS origen, fp.numero, p.nombre AS proveedor, COALESCE(fp.cuit, p.cuit, '') AS cuit, fp.nro_comprobante AS comprobante, fp.tipo,
              CASE WHEN fp.tipo LIKE 'nota_credito%' THEN -fp.neto_gravado ELSE fp.neto_gravado END AS neto_gravado, CASE WHEN fp.tipo LIKE 'nota_credito%' THEN -fp.no_gravado ELSE fp.no_gravado END AS no_gravado,
              CASE WHEN fp.tipo LIKE 'nota_credito%' THEN -fp.iva_21 ELSE fp.iva_21 END AS iva_21, CASE WHEN fp.tipo LIKE 'nota_credito%' THEN -fp.iva_10_5 ELSE fp.iva_10_5 END AS iva_10_5,
              CASE WHEN fp.tipo LIKE 'nota_credito%' THEN -fp.iva_27 ELSE fp.iva_27 END AS iva_27, 0 AS iva_otros,
              CASE WHEN fp.tipo LIKE 'nota_credito%' THEN -fp.otros_tributos ELSE fp.otros_tributos END AS otros_tributos, CASE WHEN fp.tipo LIKE 'nota_credito%' THEN -fp.total ELSE fp.total END AS total
         FROM facturas_proveedor fp JOIN proveedores p ON p.taller_id = fp.taller_id AND p.id = fp.proveedor_id
        WHERE fp.taller_id = ? AND fp.estado = 'registrada' AND fp.fecha BETWEEN ? AND ? AND (fp.compra_id IS NULL OR fp.tipo LIKE 'nota_credito%')`,
      s.tallerId, f.desde, f.hasta,
    ),
  ]);
  const filas = [...compras, ...facturas].sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : a.numero - b.numero));
  return c.json({
    nota: NOTA_INTERNA, desde: f.desde, hasta: f.hasta,
    filas: filas.map((x) => ({ ...x, iva_total: x.iva_21 + x.iva_10_5 + x.iva_27 + x.iva_otros })),
    totales: { ...sumar(filas, ['neto_gravado', 'no_gravado', 'iva_21', 'iva_10_5', 'iva_27', 'iva_otros', 'otros_tributos', 'total']), comprobantes: filas.length },
  });
});

informes.get('/contabilidad/resumen', requirePerm('contabilidad.ver'), async (c) => {
  const s = c.get('sesion');
  await autorizarExportacion(c, 'contabilidad-resumen');
  const f = query(c, z.object({ desde: zFecha, hasta: zFecha }));
  const t = s.tallerId;
  const [rubros, bancarios, ventas, ivaCompras, ivaFacturas, porMes] = await Promise.all([
    all<{ rubro: string; neto: number }>(c.env.DB, `SELECT rubro, SUM(${IMPORTE_FIRMADO_SQL}) AS neto FROM caja_movimientos WHERE taller_id = ? AND fecha BETWEEN ? AND ? AND rubro <> 'traspaso' GROUP BY rubro`, t, f.desde, f.hasta),
    first<{ ingresos: number; egresos: number }>(c.env.DB, `SELECT COALESCE(SUM(CASE WHEN m.tipo='ingreso' THEN m.importe END),0) AS ingresos, COALESCE(SUM(CASE WHEN m.tipo='egreso' THEN m.importe END),0) AS egresos FROM banco_movimientos m JOIN cuentas_bancarias cb ON cb.taller_id=m.taller_id AND cb.id=m.cuenta_id WHERE m.taller_id = ? AND m.fecha BETWEEN ? AND ? AND m.afecta_resultado = 1 AND cb.moneda='ARS'`, t, f.desde, f.hasta),
    first<any>(c.env.DB, "SELECT COALESCE(SUM(neto),0) AS neto, COALESCE(SUM(iva),0) AS iva, COALESCE(SUM(total),0) AS total, COUNT(*) AS n FROM ventas WHERE taller_id = ? AND estado = 'emitida' AND fecha BETWEEN ? AND ?", t, f.desde, f.hasta),
    first<any>(c.env.DB, "SELECT COALESCE(SUM(neto),0) AS neto, COALESCE(SUM(iva),0) AS iva, COALESCE(SUM(total),0) AS total, COUNT(*) AS n FROM compras WHERE taller_id = ? AND estado = 'registrada' AND fecha BETWEEN ? AND ?", t, f.desde, f.hasta),
    first<any>(c.env.DB, "SELECT COALESCE(SUM(CASE WHEN tipo LIKE 'nota_credito%' THEN -(iva_21+iva_10_5+iva_27) ELSE iva_21+iva_10_5+iva_27 END),0) AS iva, COALESCE(SUM(CASE WHEN tipo LIKE 'nota_credito%' THEN -neto_gravado ELSE neto_gravado END),0) AS neto, COUNT(*) AS n FROM facturas_proveedor WHERE taller_id = ? AND estado = 'registrada' AND fecha BETWEEN ? AND ? AND (compra_id IS NULL OR tipo LIKE 'nota_credito%')", t, f.desde, f.hasta),
    all(c.env.DB, `SELECT substr(fecha,1,7) AS mes, SUM(CASE WHEN tipo='ingreso' THEN importe ELSE 0 END) AS ingresos, SUM(CASE WHEN tipo='egreso' THEN importe ELSE 0 END) AS egresos FROM caja_movimientos WHERE taller_id = ? AND fecha BETWEEN ? AND ? AND rubro <> 'traspaso' GROUP BY mes ORDER BY mes`, t, f.desde, f.hasta),
  ]);
  const neto = (r: string) => rubros.find((x) => x.rubro === r)?.neto ?? 0;
  const ingresos = { cobros: neto('cobro'), otros: neto('otro_ingreso'), bancarios: bancarios?.ingresos ?? 0 };
  const egresos = { pagos_proveedor: -neto('pago_proveedor'), gastos: -neto('gasto'), bancarios: bancarios?.egresos ?? 0 };
  const ti = ingresos.cobros + ingresos.otros + ingresos.bancarios;
  const te = egresos.pagos_proveedor + egresos.gastos + egresos.bancarios;
  return c.json({
    nota: NOTA_INTERNA, desde: f.desde, hasta: f.hasta,
    ingresos: { ...ingresos, total: ti }, egresos: { ...egresos, total: te }, resultado: ti - te,
    devengado: { ventas_netas: ventas?.neto ?? 0, ventas_total: ventas?.total ?? 0, ventas_comprobantes: ventas?.n ?? 0, compras_netas: (ivaCompras?.neto ?? 0) + (ivaFacturas?.neto ?? 0), compras_total: ivaCompras?.total ?? 0 },
    impuestos_registrados: { iva_ventas: ventas?.iva ?? 0, iva_compras: (ivaCompras?.iva ?? 0) + (ivaFacturas?.iva ?? 0), saldo_informativo: (ventas?.iva ?? 0) - ((ivaCompras?.iva ?? 0) + (ivaFacturas?.iva ?? 0)) },
    por_mes: porMes,
  });
});

informes.get('/contabilidad/operaciones', requirePerm('contabilidad.ver'), async (c) => {
  const s = c.get('sesion');
  await autorizarExportacion(c, 'contabilidad-operaciones');
  const f = query(c, z.object({ desde: zFecha, hasta: zFecha, tipo: z.string().optional(), q: z.string().optional(), limite: z.coerce.number().int().min(1).max(3000).default(1000) }));
  const t = s.tallerId;
  // Una fila por hecho económico. 'efecto' dice cómo mira el negocio ese hecho: ingreso/egreso (caja), devengado (a crédito), informativo o interno (movimiento entre cuentas).
  // D1 limita los SELECT compuestos: cada fuente es una consulta y se combinan acá.
  const rango = [t, f.desde, f.hasta];
  const fuentes = await Promise.all([
    all<any>(c.env.DB, `SELECT ve.fecha, 'venta' AS tipo, ve.numero, c.nombre AS tercero, 'Comprobante interno' AS concepto, ve.total AS importe, 'devengado' AS efecto, ve.estado FROM ventas ve JOIN clientes c ON c.taller_id = ve.taller_id AND c.id = ve.cliente_id WHERE ve.taller_id = ? AND ve.fecha BETWEEN ? AND ? LIMIT 3000`, ...rango),
    all<any>(c.env.DB, `SELECT co.fecha, 'cobro' AS tipo, co.numero, c.nombre AS tercero, 'Cobro de cliente' AS concepto, co.total AS importe, 'ingreso' AS efecto, co.estado FROM cobros co JOIN clientes c ON c.taller_id = co.taller_id AND c.id = co.cliente_id WHERE co.taller_id = ? AND co.fecha BETWEEN ? AND ? LIMIT 3000`, ...rango),
    all<any>(c.env.DB, `SELECT cp.fecha, 'compra' AS tipo, cp.numero, p.nombre AS tercero, 'Compra ' || COALESCE(cp.numero_doc, '') AS concepto, cp.total AS importe, 'devengado' AS efecto, cp.estado FROM compras cp JOIN proveedores p ON p.taller_id = cp.taller_id AND p.id = cp.proveedor_id WHERE cp.taller_id = ? AND cp.fecha BETWEEN ? AND ? LIMIT 3000`, ...rango),
    all<any>(c.env.DB, `SELECT fp.fecha, 'factura_proveedor' AS tipo, fp.numero, p.nombre AS tercero, fp.nro_comprobante AS concepto, fp.total AS importe, CASE WHEN fp.compra_id IS NULL THEN 'devengado' ELSE 'informativo' END AS efecto, fp.estado FROM facturas_proveedor fp JOIN proveedores p ON p.taller_id = fp.taller_id AND p.id = fp.proveedor_id WHERE fp.taller_id = ? AND fp.fecha BETWEEN ? AND ? LIMIT 3000`, ...rango),
    all<any>(c.env.DB, `SELECT pp.fecha, 'pago_proveedor' AS tipo, pp.numero, p.nombre AS tercero, 'Pago a proveedor (' || pp.medio || ')' AS concepto, pp.importe, 'egreso' AS efecto, pp.estado FROM pagos_proveedor pp JOIN proveedores p ON p.taller_id = pp.taller_id AND p.id = pp.proveedor_id WHERE pp.taller_id = ? AND pp.fecha BETWEEN ? AND ? LIMIT 3000`, ...rango),
    all<any>(c.env.DB, `SELECT g.fecha, 'gasto' AS tipo, g.numero, COALESCE((SELECT nombre FROM proveedores x WHERE x.taller_id = g.taller_id AND x.id = g.proveedor_id), '') AS tercero, g.concepto, g.importe, 'egreso' AS efecto, g.estado FROM gastos g WHERE g.taller_id = ? AND g.fecha BETWEEN ? AND ? LIMIT 3000`, ...rango),
    all<any>(c.env.DB, `SELECT m.fecha, 'ingreso_manual' AS tipo, 0 AS numero, '' AS tercero, m.concepto, m.importe, 'ingreso' AS efecto, 'registrado' AS estado FROM caja_movimientos m WHERE m.taller_id = ? AND m.fecha BETWEEN ? AND ? AND m.rubro = 'otro_ingreso' AND m.origen_tipo = 'manual' LIMIT 3000`, ...rango),
    all<any>(
      c.env.DB,
      `SELECT bm.fecha, 'banco_' || bm.categoria AS tipo, 0 AS numero, cb.nombre AS tercero, bm.concepto, bm.importe, CASE WHEN bm.afecta_resultado = 1 THEN bm.tipo ELSE 'interno' END AS efecto, 'registrado' AS estado
         FROM banco_movimientos bm JOIN cuentas_bancarias cb ON cb.taller_id = bm.taller_id AND cb.id = bm.cuenta_id
        WHERE bm.taller_id = ? AND bm.fecha BETWEEN ? AND ? AND bm.categoria IN ('manual','deposito','extraccion','transferencia','ajuste','cheque') AND bm.origen_tipo <> 'reverso' LIMIT 3000`,
      ...rango,
    ),
  ]);
  const q = f.q?.toLowerCase();
  const filas = fuentes
    .flat()
    .filter((x) => (!f.tipo || x.tipo === f.tipo) && (!q || `${x.tercero ?? ''} ${x.concepto ?? ''}`.toLowerCase().includes(q)))
    .sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : a.tipo < b.tipo ? -1 : a.tipo > b.tipo ? 1 : b.numero - a.numero))
    .slice(0, f.limite);
  return c.json({ nota: NOTA_INTERNA, desde: f.desde, hasta: f.hasta, filas });
});
