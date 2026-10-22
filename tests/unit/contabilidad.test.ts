import { describe, expect, it } from 'vitest';
import { codigoCuentaValido, diferenciaAsiento, naturalezaDe, PLAN_INICIAL, rolDeGasto, ROLES_CUENTA, saldoNatural, validarLineas } from '../../shared/contabilidad';

describe('plan de cuentas inicial', () => {
  it('tiene códigos únicos y válidos, rubros que existen y un solo rol por cuenta', () => {
    const codigos = PLAN_INICIAL.map((c) => c.codigo);
    expect(new Set(codigos).size).toBe(codigos.length);
    for (const c of PLAN_INICIAL) {
      expect(codigoCuentaValido(c.codigo), c.codigo).toBe(true);
      if (c.padre) {
        const p = PLAN_INICIAL.find((x) => x.codigo === c.padre);
        expect(p, `${c.codigo}: rubro ${c.padre}`).toBeTruthy();
        expect(p!.imputable, `${c.padre} debe ser un rubro`).toBe(false);
        expect(p!.tipo).toBe(c.tipo);
      }
      if (c.rol) expect(c.imputable).toBe(true);
    }
    const roles = PLAN_INICIAL.map((c) => c.rol).filter(Boolean);
    expect(new Set(roles).size).toBe(roles.length);
    // toda cuenta de sistema que usa la contabilización automática está en el plan
    for (const r of ROLES_CUENTA) expect(roles, r).toContain(r);
  });

  it('cubre los rubros que pide un taller mecánico', () => {
    const nombres = PLAN_INICIAL.map((c) => c.nombre.toLowerCase()).join('|');
    for (const x of ['caja', 'bancos', 'deudores', 'proveedores', 'inventario', 'ventas de repuestos', 'servicios y mano de obra', 'anticipos', 'obligaciones', 'costo de repuestos', 'patrimonio', 'costos comerciales']) expect(nombres, x).toContain(x);
  });
});

describe('partida doble', () => {
  it('detecta asientos desbalanceados, de un solo lado o con importes inválidos', () => {
    expect(diferenciaAsiento([{ debe: 100, haber: 0 }, { debe: 0, haber: 100 }])).toBe(0);
    expect(validarLineas([{ debe: 100, haber: 0 }, { debe: 0, haber: 100 }])).toBeNull();
    expect(validarLineas([{ debe: 100, haber: 0 }, { debe: 0, haber: 90 }])).toMatch(/no balancea/);
    expect(validarLineas([{ debe: 100, haber: 0 }])).toMatch(/dos líneas/);
    expect(validarLineas([{ debe: 100, haber: 100 }, { debe: 0, haber: 0 }])).toMatch(/Debe o en el Haber/);
    expect(validarLineas([{ debe: 10.5, haber: 0 }, { debe: 0, haber: 10.5 }])).toMatch(/centavos/);
    expect(validarLineas([{ debe: -5, haber: 0 }, { debe: 0, haber: -5 }])).toMatch(/positivos/);
  });

  it('el saldo se expresa en el sentido natural de la cuenta', () => {
    expect(saldoNatural('deudora', 500, 200)).toBe(300);
    expect(saldoNatural('acreedora', 200, 500)).toBe(300);
    expect(naturalezaDe('activo')).toBe('deudora');
    expect(naturalezaDe('costo')).toBe('deudora');
    expect(naturalezaDe('pasivo')).toBe('acreedora');
    expect(naturalezaDe('ingreso')).toBe('acreedora');
  });
});

describe('cuenta contable de una categoría de gasto', () => {
  it('se elige por nombre y, si no, por tipo', () => {
    expect(rolDeGasto('Alquiler', 'fijo')).toBe('gasto_alquileres');
    expect(rolDeGasto('Servicios (luz, agua, internet)', 'fijo')).toBe('gasto_servicios');
    expect(rolDeGasto('Sueldos y jornales', 'fijo')).toBe('costo_mano_obra');
    expect(rolDeGasto('Impuestos y tasas', 'impuestos')).toBe('gasto_impuestos');
    expect(rolDeGasto('Combustible y fletes', 'operativo')).toBe('gasto_combustible');
    expect(rolDeGasto('Capacitación', 'fijo')).toBe('gasto_varios');
    expect(rolDeGasto('IIBB provincial', 'impuestos')).toBe('gasto_impuestos');
  });
});
