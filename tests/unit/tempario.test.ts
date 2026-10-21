import { describe, expect, it } from 'vitest';
import { PLANTILLA_TEMPARIO, formatearMinutos, precioPorTiempo, puntajeRegla, resolverTiempo, type ReglaTiempo } from '../../shared/tempario';
import { evaluarVencimiento } from '../../worker/lib/mantenimiento';

const regla = (r: Partial<ReglaTiempo> & { id: string; tiempo_min: number }): ReglaTiempo => ({ marca_id: null, modelo_id: null, motor: null, anio_desde: null, anio_hasta: null, ...r });
const veh = { marca_id: 'fiat', modelo_id: 'cronos', motor: '1.3 Firefly 8V', anio: 2020 };

describe('plantilla del tempario', () => {
  it('tiene códigos únicos, tiempos razonables y nunca se presenta como dato oficial', () => {
    const codigos = PLANTILLA_TEMPARIO.map((o) => o.codigo);
    expect(new Set(codigos).size).toBe(codigos.length);
    const nombres = PLANTILLA_TEMPARIO.map((o) => o.nombre.toLowerCase());
    expect(new Set(nombres).size).toBe(nombres.length);
    for (const o of PLANTILLA_TEMPARIO) {
      expect(o.tiempo_min).toBeGreaterThan(0);
      expect(o.tiempo_min).toBeLessThanOrEqual(600);
      expect(o.codigo).toMatch(/^[A-Z]{3}-\d{3}$/);
    }
  });
});

describe('tiempos específicos por vehículo', () => {
  it('sin reglas o sin vehículo se usa el tiempo genérico; sin ningún dato, no hay tiempo', () => {
    expect(resolverTiempo(45, [], veh)).toEqual({ tiempo_min: 45, origen: 'generico', regla_id: null });
    expect(resolverTiempo(45, [regla({ id: 'r', modelo_id: 'cronos', tiempo_min: 60 })], null)).toMatchObject({ tiempo_min: 45, origen: 'generico' });
    expect(resolverTiempo(null, [], veh)).toEqual({ tiempo_min: null, origen: 'sin_dato', regla_id: null });
  });

  it('el criterio más específico gana: modelo > marca > motor > años', () => {
    const reglas = [
      regla({ id: 'marca', marca_id: 'fiat', tiempo_min: 50 }),
      regla({ id: 'modelo', marca_id: 'fiat', modelo_id: 'cronos', tiempo_min: 70 }),
      regla({ id: 'anios', anio_desde: 2015, anio_hasta: 2022, tiempo_min: 55 }),
      regla({ id: 'motor', motor: 'firefly', tiempo_min: 65 }),
    ];
    expect(resolverTiempo(45, reglas, veh)).toMatchObject({ tiempo_min: 70, regla_id: 'modelo' });
    expect(resolverTiempo(45, reglas.filter((r) => r.id !== 'modelo'), veh)).toMatchObject({ regla_id: 'marca' });
    expect(resolverTiempo(45, reglas.filter((r) => r.id === 'motor' || r.id === 'anios'), veh)).toMatchObject({ regla_id: 'motor' });
    expect(resolverTiempo(45, reglas.filter((r) => r.id === 'anios'), veh)).toMatchObject({ regla_id: 'anios', tiempo_min: 55 });
  });

  it('una regla que no coincide en algún criterio no aplica', () => {
    expect(puntajeRegla(regla({ id: 'x', marca_id: 'chevrolet', tiempo_min: 1 }), veh)).toBeNull();
    expect(puntajeRegla(regla({ id: 'x', modelo_id: 'onix', tiempo_min: 1 }), veh)).toBeNull();
    expect(puntajeRegla(regla({ id: 'x', anio_desde: 2021, tiempo_min: 1 }), veh)).toBeNull();
    expect(puntajeRegla(regla({ id: 'x', anio_hasta: 2019, tiempo_min: 1 }), veh)).toBeNull();
    expect(puntajeRegla(regla({ id: 'x', motor: '2.0 turbo', tiempo_min: 1 }), veh)).toBeNull();
    // si el vehículo no tiene año o motor cargado, las reglas que los exigen no aplican
    expect(puntajeRegla(regla({ id: 'x', anio_desde: 2000, tiempo_min: 1 }), { ...veh, anio: null })).toBeNull();
    expect(puntajeRegla(regla({ id: 'x', motor: 'firefly', tiempo_min: 1 }), { ...veh, motor: null })).toBeNull();
  });

  it('el motor se compara sin tildes ni mayúsculas', () => {
    expect(puntajeRegla(regla({ id: 'x', motor: '1.6 16V', tiempo_min: 1 }), { ...veh, motor: 'Motor 1.6 16v nafta' })).toBe(2);
    expect(puntajeRegla(regla({ id: 'x', motor: 'TURBODIÉSEL', tiempo_min: 1 }), { ...veh, motor: 'turbodiesel 2.8' })).toBe(2);
  });
});

describe('mano de obra por tiempo', () => {
  it('multiplica el tiempo por la tarifa horaria y redondea al peso', () => {
    expect(precioPorTiempo(60, 2400000)).toBe(2400000);
    expect(precioPorTiempo(45, 2400000)).toBe(1800000);
    expect(precioPorTiempo(25, 2400000)).toBe(1000000);
    expect(precioPorTiempo(7, 2500000)).toBe(291700); // 291.666,67 centavos → $2.917
    expect(precioPorTiempo(30, 0)).toBe(0);
    expect(precioPorTiempo(0, 2400000)).toBe(0);
  });
  it('formatea minutos legibles', () => {
    expect(formatearMinutos(45)).toBe('45 min');
    expect(formatearMinutos(60)).toBe('1 h');
    expect(formatearMinutos(90)).toBe('1 h 30 min');
    expect(formatearMinutos(null)).toBe('—');
  });
});

describe('vencimiento de mantenimientos', () => {
  const base = { intervalo_km: 10000, intervalo_meses: 12, km_actual: 50000, km_realizado: 42000, fecha_realizado: '2026-03-01', hoy: '2026-10-21' };
  it('al día, próximo y vencido por kilometraje', () => {
    expect(evaluarVencimiento(base)).toMatchObject({ estado: 'al_dia', proximo_km: 52000, km_restantes: 2000 });
    expect(evaluarVencimiento({ ...base, km_actual: 51200 })).toMatchObject({ estado: 'proximo', km_restantes: 800 });
    expect(evaluarVencimiento({ ...base, km_actual: 52000 })).toMatchObject({ estado: 'vencido', km_restantes: 0 });
    expect(evaluarVencimiento({ ...base, km_actual: 60000 })).toMatchObject({ estado: 'vencido', km_restantes: -8000 });
  });
  it('por tiempo: próximo a 30 días y vencido al llegar la fecha', () => {
    const b = { ...base, intervalo_km: null, km_realizado: null };
    expect(evaluarVencimiento(b)).toMatchObject({ estado: 'al_dia', proxima_fecha: '2027-03-01' });
    expect(evaluarVencimiento({ ...b, fecha_realizado: '2025-11-10' })).toMatchObject({ estado: 'proximo', proxima_fecha: '2026-11-10', dias_restantes: 20 });
    expect(evaluarVencimiento({ ...b, fecha_realizado: '2025-10-21' })).toMatchObject({ estado: 'vencido', dias_restantes: 0 });
    expect(evaluarVencimiento({ ...b, fecha_realizado: '2025-06-01' })).toMatchObject({ estado: 'vencido' });
  });
  it('gana lo que venza primero cuando hay km y tiempo, y sin realización registrada queda "sin registro"', () => {
    expect(evaluarVencimiento({ ...base, fecha_realizado: '2025-06-01' }).estado).toBe('vencido'); // km al día pero el tiempo venció
    expect(evaluarVencimiento({ ...base, km_realizado: null, fecha_realizado: null }).estado).toBe('sin_registro');
    // sin kilometraje de la última vez, el intervalo por tiempo sigue funcionando
    expect(evaluarVencimiento({ ...base, km_realizado: null }).estado).toBe('al_dia');
  });
  it('fin de mes: un mes después del 31 cae en el último día del mes siguiente', () => {
    expect(evaluarVencimiento({ ...base, intervalo_km: null, km_realizado: null, intervalo_meses: 1, fecha_realizado: '2026-01-31' }).proxima_fecha).toBe('2026-02-28');
  });
});
