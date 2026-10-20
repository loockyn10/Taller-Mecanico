import { describe, expect, it } from 'vitest';
import { precioArticuloEnLista, precioPorRegla, precioServicioEnLista, redondearPrecio, siguienteOcurrencia } from '../../shared/precios';
import { esCantidadValida, redondearCantidad } from '../../shared/dominio';

describe('listas de precios (cálculo)', () => {
  it('redondea al múltiplo indicado y nunca devuelve negativos', () => {
    expect(redondearPrecio(12345, 0)).toBe(12345);
    expect(redondearPrecio(12345, 100)).toBe(12300);
    expect(redondearPrecio(12350, 100)).toBe(12400);
    expect(redondearPrecio(12345, 1000)).toBe(12000);
    expect(redondearPrecio(-50, 100)).toBe(0);
  });
  it('margen sobre costo; si no hay costo parte del precio base', () => {
    const regla = { base: 'costo' as const, porcentaje: 40, redondeo: 0 };
    expect(precioPorRegla(regla, { costo: 100000, precio: 1 })).toBe(140000);
    expect(precioPorRegla(regla, { costo: 0, precio: 50000 })).toBe(70000);
  });
  it('recargo o descuento sobre el precio base', () => {
    expect(precioPorRegla({ base: 'precio', porcentaje: 10, redondeo: 0 }, { costo: 1, precio: 10000 })).toBe(11000);
    expect(precioPorRegla({ base: 'precio', porcentaje: -15, redondeo: 0 }, { costo: 1, precio: 10000 })).toBe(8500);
  });
  it('el precio fijo gana sobre la regla', () => {
    const regla = { base: 'costo' as const, porcentaje: 40, redondeo: 0 };
    expect(precioArticuloEnLista(regla, { costo: 100, precio: 1 }, 999)).toEqual({ precio: 999, origen: 'fijo' });
    expect(precioArticuloEnLista(regla, { costo: 100, precio: 1 }, null)).toEqual({ precio: 140, origen: 'regla' });
    // un precio fijo de $0 es válido (artículo sin cargo)
    expect(precioArticuloEnLista(regla, { costo: 100, precio: 1 }, 0).precio).toBe(0);
  });
  it('servicios: sin porcentaje queda el precio base', () => {
    expect(precioServicioEnLista({ servicios_pct: null, redondeo: 0 }, 5000)).toBe(5000);
    expect(precioServicioEnLista({ servicios_pct: 20, redondeo: 100 }, 5050)).toBe(6100);
  });
});

describe('gastos recurrentes: próxima ocurrencia', () => {
  it('mensual conserva el día elegido y ajusta fin de mes', () => {
    expect(siguienteOcurrencia('2026-01-31', 'mensual', 31)).toBe('2026-02-28');
    expect(siguienteOcurrencia('2026-02-28', 'mensual', 31)).toBe('2026-03-31');
    expect(siguienteOcurrencia('2028-01-31', 'mensual', 31)).toBe('2028-02-29'); // bisiesto
    expect(siguienteOcurrencia('2026-05-10', 'mensual')).toBe('2026-06-10');
  });
  it('semanal, bimestral, trimestral y anual', () => {
    expect(siguienteOcurrencia('2026-12-28', 'semanal')).toBe('2027-01-04');
    expect(siguienteOcurrencia('2026-11-15', 'bimestral')).toBe('2027-01-15');
    expect(siguienteOcurrencia('2026-11-15', 'trimestral')).toBe('2027-02-15');
    expect(siguienteOcurrencia('2026-03-15', 'anual')).toBe('2027-03-15');
    expect(siguienteOcurrencia('2028-02-29', 'anual')).toBe('2029-02-28');
  });
});

describe('cantidades de stock', () => {
  it('se operan con 3 decimales exactos', () => {
    expect(redondearCantidad(0.3 - 0.1)).toBe(0.2);
    expect(redondearCantidad(0.1 + 0.2)).toBe(0.3);
    expect(esCantidadValida(1.234)).toBe(true);
    expect(esCantidadValida(1.2345)).toBe(false);
    expect(esCantidadValida(0.1 + 0.2)).toBe(true);
  });
});

describe('importe en letras (recibos)', () => {
  it('convierte importes comunes', async () => {
    const { importeEnLetras } = await import('../../shared/letras');
    expect(importeEnLetras(0)).toBe('Cero con 00/100');
    expect(importeEnLetras(100)).toBe('Uno con 00/100');
    expect(importeEnLetras(2100)).toBe('Veintiuno con 00/100');
    expect(importeEnLetras(10000)).toBe('Cien con 00/100');
    expect(importeEnLetras(10150)).toBe('Ciento uno con 50/100');
    expect(importeEnLetras(123456)).toBe('Mil doscientos treinta y cuatro con 56/100');
    expect(importeEnLetras(2100000)).toBe('Veintiún mil con 00/100');
    expect(importeEnLetras(100000000)).toBe('Un millón con 00/100');
    expect(importeEnLetras(250000000)).toBe('Dos millones quinientos mil con 00/100');
    expect(importeEnLetras(3100099)).toBe('Treinta y un mil con 99/100');
  });
});
