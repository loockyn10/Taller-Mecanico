import { describe, expect, it } from 'vitest';
import { calcularOC } from '../../shared/compras';
import { cuitValido, normalizarNroComprobante, esNotaCredito } from '../../shared/dominio';

describe('orden de compra', () => {
  it('calcula descuentos por ítem y global, IVA y costo neto', () => {
    const t = calcularOC([{ cantidad: 10, costo_unitario: 10000, desc_pct: 10 }, { cantidad: 4, costo_unitario: 50000 }], { descuento_pct: 5, iva_pct: 21 });
    expect(t.subtotales).toEqual([90000, 200000]);
    expect(t).toMatchObject({ subtotal: 290000, descuento: 14500, neto: 275500, iva: 57855, total: 333355 });
    expect(t.costos_netos).toEqual([8550, 47500]);
  });
  it('tolera cantidades decimales y porcentajes fuera de rango', () => {
    const t = calcularOC([{ cantidad: 0.3, costo_unitario: 1000, desc_pct: 150 }], { descuento_pct: -5, iva_pct: 0 });
    expect(t.total).toBe(0);
    expect(calcularOC([{ cantidad: 0.3, costo_unitario: 1999 }]).total).toBe(600);
  });
});

describe('comprobantes de proveedor', () => {
  it('normaliza el número a PPPP-NNNNNNNN', () => {
    expect(normalizarNroComprobante('1-4521')).toBe('0001-00004521');
    expect(normalizarNroComprobante('0001 00004521')).toBe('0001-00004521');
    expect(normalizarNroComprobante('00003-00000010')).toBe('0003-00000010');
    expect(normalizarNroComprobante('ABC')).toBeNull();
    expect(normalizarNroComprobante('12345')).toBeNull();
  });
  it('valida CUIT con dígito verificador', () => {
    expect(cuitValido('20-12345678-6')).toBe(true);
    expect(cuitValido('30-71234567-1')).toBe(true);
    expect(cuitValido('20-12345678-0')).toBe(false);
    expect(cuitValido('123')).toBe(false);
  });
  it('reconoce notas de crédito', () => {
    expect(esNotaCredito('nota_credito_a')).toBe(true);
    expect(esNotaCredito('factura_a')).toBe(false);
  });
});
