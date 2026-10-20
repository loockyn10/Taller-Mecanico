// Cálculo de órdenes de compra. Función pura compartida por el frontend (vista previa) y la API (valor autoritativo).
// Importes en centavos (enteros).

export interface ItemOC {
  cantidad: number;
  costo_unitario: number; // centavos
  desc_pct?: number;
}

export interface ParamsOC {
  descuento_pct?: number;
  iva_pct?: number;
}

export interface TotalesOC {
  subtotales: number[];
  subtotal: number;
  descuento: number;
  neto: number;
  iva: number;
  total: number;
  /** Costo unitario efectivo de cada ítem tras sus descuentos y el descuento global (es el costo que se aplica al recibir). */
  costos_netos: number[];
}

const pct = (n = 0) => Math.min(Math.max(n, 0), 100);

export function calcularOC(items: ItemOC[], p: ParamsOC = {}): TotalesOC {
  const subtotales = items.map((i) => Math.round(i.cantidad * i.costo_unitario * (1 - pct(i.desc_pct) / 100)));
  const subtotal = subtotales.reduce((a, b) => a + b, 0);
  const descuento = Math.round((subtotal * pct(p.descuento_pct)) / 100);
  const neto = subtotal - descuento;
  const iva = Math.round((neto * Math.min(Math.max(p.iva_pct ?? 0, 0), 100)) / 100);
  const costos_netos = items.map((i) => Math.round(i.costo_unitario * (1 - pct(i.desc_pct) / 100) * (1 - pct(p.descuento_pct) / 100)));
  return { subtotales, subtotal, descuento, neto, iva, total: neto + iva, costos_netos };
}
