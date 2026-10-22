import { describe, expect, it } from 'vitest';
import { calcularLinea, repartir, repartoDeuda, valoresPorLinea } from '../../shared/devoluciones';

describe('devoluciones: cálculo', () => {
  it('reparte el total sin perder centavos', () => {
    expect(repartir(100, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(100);
    expect(repartir(0, [1, 2])).toEqual([0, 0]);
    expect(repartir(10, [0, 0])).toEqual([0, 0]);
  });

  it('el valor por línea suma exactamente el total del comprobante', () => {
    const lineas = [{ cantidad: 3, subtotal: 3333 }, { cantidad: 1, subtotal: 1111 }, { cantidad: 2, subtotal: 777 }];
    const v = valoresPorLinea({ total: 6000, iva: 1041 }, lineas);
    expect(v.valor.reduce((a, b) => a + b, 0)).toBe(6000);
    expect(v.iva.reduce((a, b) => a + b, 0)).toBe(1041);
  });

  it('devolver todo lo que queda acredita exactamente el resto; no se puede devolver de más', () => {
    const origen = { cantidad: 3, subtotal: 1000, valor: 1000, iva: 0 };
    const a = calcularLinea(origen, { cantidad: 0, importe: 0, subtotal: 0 }, 1);
    expect(a).toMatchObject({ cantidad: 1, importe: 333, restante_cantidad: 2 });
    const b = calcularLinea(origen, { cantidad: 1, importe: 333, subtotal: 333 }, 2);
    expect(b).toMatchObject({ importe: 667, restante_importe: 0, restante_cantidad: 0 });
    expect(calcularLinea(origen, { cantidad: 3, importe: 1000, subtotal: 1000 }, 1)).toHaveProperty('error');
    expect(calcularLinea(origen, { cantidad: 1, importe: 333, subtotal: 333 }, 3)).toHaveProperty('error');
    expect(calcularLinea(origen, { cantidad: 0, importe: 0, subtotal: 0 }, 1, 1001)).toHaveProperty('error');
    expect(calcularLinea(origen, { cantidad: 0, importe: 0, subtotal: 0 }, 1, 200)).toMatchObject({ importe: 200 });
  });

  it('separa lo que cancela deuda de lo que ya estaba pagado', () => {
    expect(repartoDeuda(500, 300)).toEqual({ a_deuda: 300, liberado: 200 });
    expect(repartoDeuda(500, 0)).toEqual({ a_deuda: 0, liberado: 500 });
    expect(repartoDeuda(500, 900)).toEqual({ a_deuda: 500, liberado: 0 });
  });
});
