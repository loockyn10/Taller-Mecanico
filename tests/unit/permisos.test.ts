import { describe, expect, it } from 'vitest';
import {
  ajustesDesde, alternarPermiso, leerAjustes, nivelDeRol, permisosEfectivos, PERMISOS, PLANTILLAS, REQUIERE, ROLES, type Permiso,
} from '../../shared/permisos';
import { fechaLocal, horaLocal, instanteDesdeLocal } from '../../worker/lib/zona';

describe('plantillas de permisos', () => {
  it('todas las plantillas usan permisos válidos y respetan las dependencias', () => {
    for (const r of ROLES) {
      const efectivos = new Set(permisosEfectivos(r));
      for (const p of PLANTILLAS[r].permisos) expect(PERMISOS, `${r}: ${p}`).toContain(p);
      for (const p of efectivos) for (const q of REQUIERE[p] ?? []) expect(efectivos.has(q), `${r}: ${p} requiere ${q}`).toBe(true);
    }
  });
  it('el propietario tiene todo; el administrador no gestiona permisos ni ajusta saldos bancarios', () => {
    expect(permisosEfectivos('propietario')).toHaveLength(PERMISOS.length);
    const adm = permisosEfectivos('administrador');
    expect(adm).not.toContain('permisos.gestionar');
    expect(adm).not.toContain('bancos.ajustar');
    expect(adm).toContain('usuarios.gestionar');
  });
  it('el mecánico no ve precios, costos, márgenes, facturación, caja ni bancos', () => {
    const m = permisosEfectivos('mecanico');
    for (const p of ['precios.venta.ver', 'precios.costo.ver', 'margenes.ver', 'presupuestos.valorizados.ver', 'ventas.ver', 'caja.operar', 'bancos.ver', 'reportes.ver'] as Permiso[]) expect(m).not.toContain(p);
    expect(m).toContain('ordenes.asignadas');
    expect(m).not.toContain('ordenes.ver');
  });
  it('los roles se mapean a un nivel de privilegio compatible con la base', () => {
    expect(nivelDeRol('propietario')).toBe('propietario');
    expect(nivelDeRol('administrador')).toBe('administrador');
    for (const r of ['recepcion', 'mecanico', 'deposito', 'caja', 'empleado'] as const) expect(nivelDeRol(r)).toBe('empleado');
  });
});

describe('ajustes individuales', () => {
  it('otorgar suma permisos (con sus dependencias) y retirar quita los que dependen', () => {
    const base = permisosEfectivos('mecanico', { g: ['clientes.editar'], r: [] });
    expect(base).toContain('clientes.editar');
    expect(base).toContain('clientes.ver');
    const sinVer = permisosEfectivos('recepcion', { g: [], r: ['clientes.ver'] });
    expect(sinVer).not.toContain('clientes.ver');
    expect(sinVer).not.toContain('clientes.crear');
    expect(sinVer).not.toContain('clientes.editar');
  });
  it('el propietario ignora los ajustes', () => {
    expect(permisosEfectivos('propietario', { g: [], r: ['config.editar'] })).toContain('config.editar');
  });
  it('ajustesDesde guarda solo la diferencia respecto del rol y es reversible', () => {
    const deseados = [...permisosEfectivos('recepcion').filter((p) => p !== 'turnos.gestionar'), 'caja.operar' as Permiso];
    const aj = ajustesDesde('recepcion', deseados);
    expect(aj.g).toEqual(['caja.operar']);
    expect(aj.r).toContain('turnos.gestionar');
    expect(new Set(permisosEfectivos('recepcion', aj))).toEqual(new Set(deseados));
    expect(ajustesDesde('recepcion', permisosEfectivos('recepcion'))).toEqual({ g: [], r: [] });
  });
  it('alternarPermiso arrastra dependencias', () => {
    const s = alternarPermiso(new Set(), 'stock.valorizar', true);
    expect(s.has('precios.costo.ver')).toBe(true);
    const t = alternarPermiso(s, 'precios.costo.ver', false);
    expect(t.has('stock.valorizar')).toBe(false);
  });
  it('leerAjustes tolera datos corruptos o de versiones futuras', () => {
    expect(leerAjustes(null)).toEqual({ g: [], r: [] });
    expect(leerAjustes('no es json')).toEqual({ g: [], r: [] });
    expect(leerAjustes('{"g":["caja.operar","permiso.inventado"],"r":5}')).toEqual({ g: ['caja.operar'], r: [] });
  });
});

describe('zona horaria del taller', () => {
  it('asigna el día local correcto a un instante UTC (una entrada a las 23:30 locales no es del día siguiente)', () => {
    // 2026-03-10 02:30 UTC = 2026-03-09 23:30 en Buenos Aires (UTC-3)
    expect(fechaLocal('2026-03-10T02:30:00Z', 'America/Argentina/Buenos_Aires')).toBe('2026-03-09');
    expect(horaLocal('2026-03-10T02:30:00Z', 'America/Argentina/Buenos_Aires')).toBe('23:30');
    expect(fechaLocal('2026-03-10T02:30:00Z', 'Europe/Madrid')).toBe('2026-03-10');
  });
  it('convierte fecha y hora locales a UTC, también cruzando la medianoche', () => {
    expect(instanteDesdeLocal('2026-03-09', '22:00', 'America/Argentina/Buenos_Aires').toISOString()).toBe('2026-03-10T01:00:00.000Z');
    const entrada = instanteDesdeLocal('2026-03-09', '22:00', 'America/Argentina/Buenos_Aires');
    const salida = instanteDesdeLocal('2026-03-10', '06:00', 'America/Argentina/Buenos_Aires');
    expect((salida.getTime() - entrada.getTime()) / 3600_000).toBe(8);
  });
  it('respeta el horario de verano de las zonas que lo usan', () => {
    expect(instanteDesdeLocal('2026-07-01', '12:00', 'Europe/Madrid').toISOString()).toBe('2026-07-01T10:00:00.000Z'); // UTC+2
    expect(instanteDesdeLocal('2026-01-15', '12:00', 'Europe/Madrid').toISOString()).toBe('2026-01-15T11:00:00.000Z'); // UTC+1
  });
});
