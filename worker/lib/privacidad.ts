// Filtrado de respuestas según los permisos de la sesión. Ocultar un dato en la pantalla no alcanza: acá se lo quita de la respuesta
// de la API, de modo que quien no tiene permiso para ver precios, costos o importes no pueda recuperarlos consultando el endpoint.
import type { Sesion } from '../env';
import { forbidden } from './http';
import { tiene } from './auth';

type Fila = Record<string, unknown>;

function sin<T extends Fila>(o: T, campos: readonly string[]): T {
  const r: Fila = { ...o };
  for (const c of campos) delete r[c];
  return r as T;
}

/** Importes y totales de un presupuesto, orden o documento similar. */
export const CAMPOS_TOTALES = [
  'desc_global_pct', 'desc_global_monto', 'iva_pct', 'recargo_pct', 'subtotal_articulos', 'subtotal_servicios', 'descuento', 'neto', 'iva', 'recargo', 'total',
] as const;

/** Costo interno de la mano de obra guardado en la orden. */
export const CAMPOS_COSTO_MO = ['mo_costo_estimado', 'mo_estimado_at', 'mo_estimado_completo'] as const;

export const puedeValorizados = (s: Sesion) => tiene(s, 'presupuestos.valorizados.ver');
export const puedePrecioVenta = (s: Sesion) => tiene(s, 'precios.venta.ver');
export const puedeCosto = (s: Sesion) => tiene(s, 'precios.costo.ver');
export const puedeMargenes = (s: Sesion) => tiene(s, 'margenes.ver');

/** Cargar ítems valorizados exige poder ver los importes y los precios de venta (si no, la persona fijaría precios a ciegas). */
export function exigirValorizado(s: Sesion) {
  if (!puedeValorizados(s) || !puedePrecioVenta(s)) {
    throw forbidden('Para cargar o modificar ítems con importes necesitás permiso para ver presupuestos valorizados y precios de venta');
  }
}

/** Presupuesto, orden de trabajo u otro documento con cabecera valorizada y datos del cliente. */
export function limpiarDocumento<T extends Fila>(s: Sesion, d: T): T {
  let r: Fila = d;
  if (!puedeValorizados(s)) r = sin(r, [...CAMPOS_TOTALES, 'venta_total', 'venta_cobrado', 'venta_devuelto']);
  if (!tiene(s, 'ventas.ver')) r = sin(r, ['venta_id', 'venta_numero', 'venta_total', 'venta_cobrado', 'venta_devuelto']);
  if (!tiene(s, 'clientes.ver')) r = sin(r, ['cliente', 'cliente_telefono', 'cliente_codigo']);
  // Estimación congelada del costo de mano de obra: dato de costo interno, solo con permiso de márgenes.
  if (!puedeMargenes(s)) r = sin(r, [...CAMPOS_COSTO_MO]);
  return r as T;
}

/** Ítems de un documento: precio unitario, descuento y subtotal. */
export function limpiarItems<T extends Fila>(s: Sesion, items: T[]): T[] {
  return puedeValorizados(s) ? items : items.map((i) => sin(i, ['precio_unitario', 'desc_pct', 'subtotal', 'alicuota_iva']));
}

/** Artículo del catálogo: costo y precios (incluidos los de lista). */
export function limpiarArticulo<T extends Fila>(s: Sesion, a: T): T {
  let r: Fila = a;
  if (!puedeCosto(s)) r = sin(r, ['costo']);
  if (!puedePrecioVenta(s)) r = sin(r, ['precio', 'precio_lista', 'precio_fijo']);
  return r as T;
}

export function limpiarServicio<T extends Fila>(s: Sesion, a: T): T {
  return puedePrecioVenta(s) ? a : sin(a, ['precio', 'precio_lista', 'precio_cargado', 'tarifa_hora']);
}

/** Movimientos de stock: el costo unitario es un dato de costo. */
export function limpiarMovimiento<T extends Fila>(s: Sesion, m: T): T {
  return puedeCosto(s) ? m : sin(m, ['costo_unitario']);
}

/** Las modificaciones de costo/precio exigen poder verlos (no se fijan valores a ciegas). */
export function exigirPermisoDePrecios(s: Sesion, datos: { costo?: unknown; precio?: unknown }) {
  if (datos.costo !== undefined && !puedeCosto(s)) throw forbidden('No tenés permiso para ver ni modificar costos');
  if (datos.precio !== undefined && !puedePrecioVenta(s)) throw forbidden('No tenés permiso para ver ni modificar precios de venta');
}

/** Mantenimiento programado: los datos de contacto del cliente solo se muestran a quien puede ver clientes. */
export function limpiarMantenimiento<T extends Fila>(s: Sesion, m: T): T {
  return tiene(s, 'clientes.ver') ? m : sin(m, ['cliente_id', 'cliente', 'cliente_telefono']);
}
