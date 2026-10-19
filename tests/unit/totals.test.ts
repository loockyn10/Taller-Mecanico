import { describe, expect, it } from 'vitest';
import { aCentavos, calcularTotales } from '../../shared/totals';
import { normalizarPatente, TRANSICIONES_OT } from '../../shared/dominio';
import { tienePermiso } from '../../shared/permisos';

describe('calcularTotales', () => {
  it('reproduce el caso verificado en la auditoría (IVA 21% + recargo 3% sobre neto)', () => {
    const r = calcularTotales(
      [
        { tipo: 'articulo', cantidad: 1, precio_unitario: 1_540_000 },
        { tipo: 'servicio', cantidad: 1, precio_unitario: 34_320_000 },
      ],
      { iva_pct: 21, recargo_pct: 3 },
    );
    expect(r.subtotal_articulos).toBe(1_540_000);
    expect(r.subtotal_servicios).toBe(34_320_000);
    expect(r.neto).toBe(35_860_000);
    expect(r.iva).toBe(7_530_600);
    expect(r.recargo).toBe(1_075_800);
    expect(r.total).toBe(44_466_400);
  });

  it('aplica descuento por línea, descuento global % y monto, y redondea a centavos', () => {
    const r = calcularTotales(
      [
        { tipo: 'articulo', cantidad: 3, precio_unitario: 333, desc_pct: 10 }, // 899.1 → 899
        { tipo: 'libre', cantidad: 1, precio_unitario: 10_000 },
      ],
      { desc_global_pct: 5, desc_global_monto: 100 },
    );
    expect(r.subtotales).toEqual([899, 10_000]);
    expect(r.bruto).toBe(10_899);
    expect(r.descuento).toBe(545 + 100);
    expect(r.total).toBe(10_899 - 645);
  });

  it('el descuento nunca supera el bruto', () => {
    const r = calcularTotales([{ tipo: 'servicio', cantidad: 1, precio_unitario: 1000 }], { desc_global_monto: 999_999 });
    expect(r.neto).toBe(0);
    expect(r.total).toBe(0);
  });

  it('cantidades decimales (litros)', () => {
    expect(calcularTotales([{ tipo: 'articulo', cantidad: 4.5, precio_unitario: 1_200_00 }]).total).toBe(540_000);
  });
});

describe('utilidades de dominio', () => {
  it('convierte importes en formato argentino a centavos', () => {
    expect(aCentavos('1.234,56')).toBe(123_456);
    expect(aCentavos('1234.5')).toBe(123_450);
    expect(aCentavos(10.1)).toBe(1010);
  });
  it('normaliza patentes', () => {
    expect(normalizarPatente(' ab-123 cd ')).toBe('AB123CD');
  });
  it('una OT entregada solo puede volver a "lista"', () => {
    expect(TRANSICIONES_OT.entregada).toEqual(['lista']);
  });
  it('el empleado no gestiona usuarios ni configuración', () => {
    expect(tienePermiso('empleado', 'usuarios.gestionar')).toBe(false);
    expect(tienePermiso('empleado', 'config.editar')).toBe(false);
    expect(tienePermiso('empleado', 'operacion')).toBe(true);
    expect(tienePermiso('administrador', 'usuarios.gestionar')).toBe(true);
  });
});
