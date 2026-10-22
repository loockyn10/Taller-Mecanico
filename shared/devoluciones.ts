// Cálculo puro de devoluciones parciales (nota de crédito comercial interna). Lo usa la API (valor autoritativo, también en la
// simulación previa) y las pruebas. Importes en centavos; cantidades con hasta 3 decimales.
import { redondearCantidad as r3 } from './dominio';

/** Reparte `total` entre `pesos` en proporción a cada peso, sin perder ni inventar centavos (mayor resto). */
export function repartir(total: number, pesos: number[]): number[] {
  const suma = pesos.reduce((a, p) => a + p, 0);
  if (total <= 0 || suma <= 0) return pesos.map(() => 0);
  const exactos = pesos.map((p) => (total * p) / suma);
  const base = exactos.map(Math.floor);
  let resto = total - base.reduce((a, b) => a + b, 0);
  const orden = exactos.map((e, i) => ({ i, f: e - Math.floor(e) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (const o of orden) {
    if (resto <= 0) break;
    base[o.i]++;
    resto--;
  }
  return base;
}

export interface LineaOrigen {
  cantidad: number;
  /** Subtotal de la línea del comprobante (antes de descuento global e impuestos), como en venta_items.subtotal. */
  subtotal: number;
}

/**
 * Valor que el cliente pagó por cada línea del comprobante: el total (con descuento global, IVA y recargo) repartido en proporción al subtotal de
 * cada línea. La suma de las líneas es exactamente el total del comprobante. `iva` es la parte de IVA de cada valor.
 */
export function valoresPorLinea(venta: { total: number; iva: number }, lineas: LineaOrigen[]): { valor: number[]; iva: number[] } {
  const pesos = lineas.map((l) => Math.max(0, l.subtotal));
  return { valor: repartir(venta.total, pesos), iva: repartir(venta.iva, pesos) };
}

export interface Previo {
  /** Cantidad ya devuelta de esa línea (devoluciones vigentes). */
  cantidad: number;
  importe: number;
  subtotal: number;
}

export interface ResultadoLinea {
  cantidad: number;
  subtotal: number;
  importe: number;
  importe_neto: number;
  restante_cantidad: number;
  restante_importe: number;
}

/**
 * Importe a acreditar por devolver `cantidad` de una línea. Sin `importeManual` es proporcional al valor pagado por la línea; al devolver todo lo que
 * queda se acredita exactamente el resto (sin residuos de centavos). Con `importeManual` (p. ej. una bonificación parcial de un servicio) no puede superar lo que
 * todavía no se devolvió de la línea. Devuelve un `error` con un mensaje claro si no corresponde.
 */
export function calcularLinea(
  origen: LineaOrigen & { valor: number; iva: number },
  previo: Previo,
  cantidad: number,
  importeManual?: number | null,
): ResultadoLinea | { error: string } {
  const q = r3(cantidad);
  const restanteCant = r3(origen.cantidad - previo.cantidad);
  const restanteImp = origen.valor - previo.importe;
  if (!(q > 0)) return { error: 'La cantidad a devolver debe ser mayor a 0' };
  if (q > restanteCant) return { error: restanteCant <= 0 ? 'La línea ya fue devuelta por completo' : `Solo quedan ${restanteCant} por devolver de esta línea` };
  const completa = q === restanteCant;
  let importe: number;
  if (importeManual != null) {
    if (importeManual > restanteImp) return { error: 'El importe supera lo que queda por devolver de la línea' };
    importe = importeManual;
  } else {
    importe = completa ? restanteImp : Math.min(restanteImp, Math.round((origen.valor * q) / origen.cantidad));
  }
  if (importe < 0) importe = 0;
  const subtotal = completa ? Math.max(0, origen.subtotal - previo.subtotal) : Math.min(Math.max(0, origen.subtotal - previo.subtotal), Math.round((origen.subtotal * q) / origen.cantidad));
  const iva = origen.valor > 0 ? Math.round((importe * origen.iva) / origen.valor) : 0;
  return { cantidad: q, subtotal, importe, importe_neto: importe - iva, restante_cantidad: r3(restanteCant - q), restante_importe: restanteImp - importe };
}

/** Parte de la devolución que cancela deuda impaga del comprobante y parte que ya estaba pagada (queda a favor del cliente). */
export function repartoDeuda(total: number, saldoPendiente: number): { a_deuda: number; liberado: number } {
  const a_deuda = Math.max(0, Math.min(total, saldoPendiente));
  return { a_deuda, liberado: total - a_deuda };
}
