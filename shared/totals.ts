// Cálculo de totales de documentos comerciales (presupuesto, OT, venta).
// Función pura compartida por el frontend (vista previa) y la API (valor autoritativo).
// Todos los importes en centavos (enteros).

export type TipoItem = 'articulo' | 'servicio' | 'libre';

export interface ItemCalculo {
  tipo: TipoItem;
  cantidad: number;
  precio_unitario: number; // centavos
  desc_pct?: number;
}

export interface ParametrosCalculo {
  desc_global_pct?: number;
  desc_global_monto?: number; // centavos
  iva_pct?: number;
  recargo_pct?: number;
}

export interface ResultadoCalculo {
  subtotales: number[];
  subtotal_articulos: number;
  subtotal_servicios: number;
  bruto: number;
  descuento: number;
  neto: number;
  iva: number;
  recargo: number;
  total: number;
}

const round = (n: number) => Math.round(n + Number.EPSILON * Math.sign(n));

export function subtotalItem(it: ItemCalculo): number {
  const desc = Math.min(Math.max(it.desc_pct ?? 0, 0), 100);
  return round(it.cantidad * it.precio_unitario * (1 - desc / 100));
}

export function calcularTotales(items: ItemCalculo[], p: ParametrosCalculo = {}): ResultadoCalculo {
  const subtotales = items.map(subtotalItem);
  let subtotal_articulos = 0;
  let subtotal_servicios = 0;
  items.forEach((it, i) => {
    if (it.tipo === 'articulo') subtotal_articulos += subtotales[i];
    else subtotal_servicios += subtotales[i];
  });
  const bruto = subtotal_articulos + subtotal_servicios;
  const pct = Math.min(Math.max(p.desc_global_pct ?? 0, 0), 100);
  const descuento = Math.min(bruto, round((bruto * pct) / 100) + Math.max(p.desc_global_monto ?? 0, 0));
  const neto = bruto - descuento;
  const iva = round((neto * Math.max(p.iva_pct ?? 0, 0)) / 100);
  const recargo = round((neto * Math.max(p.recargo_pct ?? 0, 0)) / 100);
  return { subtotales, subtotal_articulos, subtotal_servicios, bruto, descuento, neto, iva, recargo, total: neto + iva + recargo };
}

/** Convierte pesos (número o string "1.234,56" / "1234.56") a centavos. */
export function aCentavos(v: number | string): number {
  if (typeof v === 'number') return round(v * 100);
  const s = v.trim().replace(/\s/g, '');
  if (!s) return 0;
  const normal = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  const n = Number(normal);
  return Number.isFinite(n) ? round(n * 100) : NaN;
}

export function formatoMoneda(centavos: number): string {
  return (centavos / 100).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2 });
}
