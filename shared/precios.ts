// Cálculo de precios por lista. Función pura compartida por la API (valor autoritativo) y la interfaz (vista previa).
// Importes en centavos (enteros).

export interface ReglaLista {
  base: 'costo' | 'precio';
  porcentaje: number; // >0 margen/recargo, <0 descuento
  redondeo: number; // múltiplo en centavos; 0 = sin redondeo
  servicios_pct?: number | null;
}

export interface DatosArticulo {
  costo: number;
  precio: number;
}

/** Redondea al múltiplo `paso` más cercano (paso 0 = sin redondeo). Nunca devuelve negativos. */
export function redondearPrecio(centavos: number, paso: number): number {
  const v = paso > 0 ? Math.round(centavos / paso) * paso : Math.round(centavos);
  return Math.max(0, v);
}

/** Precio que resulta de aplicar la regla de la lista (ignora precios fijos). */
export function precioPorRegla(regla: ReglaLista, a: DatosArticulo): number {
  // Si la base es el costo y el artículo no lo tiene cargado, se parte del precio base para no ofrecer $0.
  const base = regla.base === 'costo' && a.costo > 0 ? a.costo : a.precio;
  return redondearPrecio(base * (1 + regla.porcentaje / 100), regla.redondeo);
}

/** Precio final de un artículo en una lista: precio fijo si existe, si no, el de la regla. */
export function precioArticuloEnLista(regla: ReglaLista, a: DatosArticulo, fijo?: number | null): { precio: number; origen: 'fijo' | 'regla' } {
  if (fijo != null) return { precio: fijo, origen: 'fijo' };
  return { precio: precioPorRegla(regla, a), origen: 'regla' };
}

/** Precio de un servicio en una lista (sin porcentaje definido para servicios, queda el precio base). */
export function precioServicioEnLista(regla: Pick<ReglaLista, 'servicios_pct' | 'redondeo'>, precioBase: number): number {
  if (regla.servicios_pct == null) return precioBase;
  return redondearPrecio(precioBase * (1 + regla.servicios_pct / 100), regla.redondeo);
}

/** Fecha (AAAA-MM-DD) de la ocurrencia siguiente de un gasto recurrente. */
export function siguienteOcurrencia(desde: string, frecuencia: 'semanal' | 'mensual' | 'bimestral' | 'trimestral' | 'anual', dia?: number | null): string {
  const [y, m, d] = desde.split('-').map(Number);
  if (frecuencia === 'semanal') {
    const f = new Date(Date.UTC(y, m - 1, d + 7));
    return f.toISOString().slice(0, 10);
  }
  const meses = { mensual: 1, bimestral: 2, trimestral: 3, anual: 12 }[frecuencia];
  const total = y * 12 + (m - 1) + meses;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const ultimo = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const nd = Math.min(dia ?? d, ultimo);
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}
