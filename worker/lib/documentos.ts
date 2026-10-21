// Ítems y totales compartidos por presupuestos, órdenes y ventas.
import { z } from 'zod';
import { calcularTotales, type ResultadoCalculo } from '../../shared/totals';
import { all, lotes, uid, type Stmt } from './db';
import { badRequest, zCantidad, zCentavos, zId, zPct } from './http';

export const zItem = z.object({
  tipo: z.enum(['articulo', 'servicio', 'libre']),
  articulo_id: zId.nullish(),
  servicio_id: zId.nullish(),
  descripcion: z.string().trim().min(1, 'descripción requerida').max(300),
  cantidad: zCantidad,
  precio_unitario: zCentavos,
  desc_pct: zPct.default(0),
  /** Tiempo estimado de mano de obra, en minutos por unidad (viene del tempario; solo tiene sentido en servicios). */
  tiempo_min: z.number().int().min(0).max(6000).nullish(),
});
export type ItemEntrada = z.infer<typeof zItem>;

export const zParametrosTotales = z.object({
  desc_global_pct: zPct.default(0),
  desc_global_monto: zCentavos.default(0),
  iva_pct: z.number().refine((v) => [0, 10.5, 21, 27].includes(v), 'IVA inválido').default(0),
  recargo_pct: zPct.default(0),
});
export type ParametrosTotales = z.infer<typeof zParametrosTotales>;

/** Valida tipo/referencias de cada ítem contra el taller y normaliza. */
export async function validarItems(db: D1Database, tallerId: string, items: ItemEntrada[]): Promise<ItemEntrada[]> {
  const artIds = [...new Set(items.filter((i) => i.tipo === 'articulo').map((i) => i.articulo_id).filter(Boolean))] as string[];
  const srvIds = [...new Set(items.filter((i) => i.tipo === 'servicio').map((i) => i.servicio_id).filter(Boolean))] as string[];
  for (const it of items) {
    if (it.tipo === 'articulo' && !it.articulo_id) throw badRequest('Los ítems de tipo artículo requieren articulo_id');
    if (it.tipo === 'servicio' && !it.servicio_id) throw badRequest('Los ítems de tipo servicio requieren servicio_id');
  }
  if (artIds.length) {
    let ok = 0;
    for (const lote of lotes(artIds)) ok += (await all(db, `SELECT id FROM articulos WHERE taller_id = ? AND id IN (${lote.map(() => '?').join(',')})`, tallerId, ...lote)).length;
    if (ok !== artIds.length) throw badRequest('Hay artículos inexistentes');
  }
  if (srvIds.length) {
    let ok = 0;
    for (const lote of lotes(srvIds)) ok += (await all(db, `SELECT id FROM servicios WHERE taller_id = ? AND id IN (${lote.map(() => '?').join(',')})`, tallerId, ...lote)).length;
    if (ok !== srvIds.length) throw badRequest('Hay servicios inexistentes');
  }
  return items.map((i) => ({
    ...i,
    articulo_id: i.tipo === 'articulo' ? i.articulo_id ?? null : null,
    servicio_id: i.tipo === 'servicio' ? i.servicio_id ?? null : null,
    tiempo_min: i.tipo === 'servicio' ? i.tiempo_min ?? null : null,
  }));
}

export function totales(items: ItemEntrada[], p: ParametrosTotales): ResultadoCalculo {
  return calcularTotales(items, p);
}

/** INSERT de ítems en la tabla indicada (presupuesto_items | orden_items | venta_items). */
export function sentenciasItems(
  db: D1Database,
  tabla: 'presupuesto_items' | 'orden_items' | 'venta_items',
  fk: 'presupuesto_id' | 'orden_id' | 'venta_id',
  tallerId: string,
  padreId: string,
  items: ItemEntrada[],
  subtotales: number[],
  alicuotas?: number[],
): Stmt[] {
  return items.map((it, i) => {
    const cols = ['id', 'taller_id', fk, 'orden', 'tipo', 'articulo_id', 'servicio_id', 'descripcion', 'cantidad', 'precio_unitario', 'desc_pct', 'subtotal'];
    const vals: unknown[] = [uid(), tallerId, padreId, i, it.tipo, it.articulo_id ?? null, it.servicio_id ?? null, it.descripcion, it.cantidad, it.precio_unitario, it.desc_pct ?? 0, subtotales[i]];
    if (alicuotas) (cols.push('alicuota_iva'), vals.push(alicuotas[i]));
    if (tabla !== 'venta_items') (cols.push('tiempo_min'), vals.push(it.tiempo_min ?? null));
    return db.prepare(`INSERT INTO ${tabla} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...vals);
  });
}

export const COLS_TOTALES = 'desc_global_pct, desc_global_monto, iva_pct, recargo_pct, subtotal_articulos, subtotal_servicios, descuento, neto, iva, recargo, total';
export function valoresTotales(p: ParametrosTotales, t: ResultadoCalculo): unknown[] {
  return [p.desc_global_pct, p.desc_global_monto, p.iva_pct, p.recargo_pct, t.subtotal_articulos, t.subtotal_servicios, t.descuento, t.neto, t.iva, t.recargo, t.total];
}
export const SET_TOTALES = COLS_TOTALES.split(', ').map((c) => `${c} = ?`).join(', ');
