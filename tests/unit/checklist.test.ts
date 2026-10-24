// Sprint 18: modelo compartido del checklist — JSON canónico (hash estable), progreso, comparación entrada/salida y resumen de cambios de una revisión.
import { describe, expect, it } from 'vitest';
import { CODIGOS_ITEM, SECCIONES_CHECKLIST, TOTAL_ITEMS, compararContenidos, contenidoVacio, jsonCanonico, progresoItems, resumenCambios, tituloItem, type ContenidoChecklist } from '../../shared/checklist';
import { PERMISOS, PLANTILLAS, permisosEfectivos } from '../../shared/permisos';

const base = (): ContenidoChecklist => ({ ...contenidoVacio('2026-10-24T10:00:00.000Z'), km: 1000, combustible: '1/2', llaves: 2 });

describe('catálogo del checklist', () => {
  it('cada punto tiene un código único y ninguno es obligatorio', () => {
    expect(CODIGOS_ITEM.size).toBe(SECCIONES_CHECKLIST.reduce((n, s) => n + s.items.length, 0));
    expect(TOTAL_ITEMS).toBeGreaterThanOrEqual(25);
    expect(progresoItems(base())).toEqual({ revisados: 0, total: TOTAL_ITEMS, pct: 0 });
    expect(tituloItem('luces.stop')).toBe('Luces: Stop / freno');
  });
  it('el progreso cuenta sólo los puntos revisados (no los "No revisado") y descarta códigos desconocidos', () => {
    const c = base();
    c.items = { 'luces.stop': { estado: 'correcto' }, 'luces.giros': { estado: 'no_revisado' }, 'tablero.audio': { estado: 'no_corresponde' }, 'inventado.x': { estado: 'correcto' } };
    expect(progresoItems(c).revisados).toBe(2);
  });
});

describe('JSON canónico (base del hash del contenido)', () => {
  it('no depende del orden de las claves y distingue cualquier cambio', () => {
    expect(jsonCanonico({ b: 1, a: { d: [1, 2], c: null } })).toBe(jsonCanonico({ a: { c: null, d: [1, 2] }, b: 1 }));
    expect(jsonCanonico({ a: 1 })).not.toBe(jsonCanonico({ a: 2 }));
    expect(jsonCanonico({ a: [1, 2] })).not.toBe(jsonCanonico({ a: [2, 1] }));
    expect(jsonCanonico({ a: undefined, b: 1 })).toBe(jsonCanonico({ b: 1 }));
  });
});

describe('comparación entre el ingreso y la salida', () => {
  it('marca sólo los cambios entre puntos revisados en ambos lados y calcula kilómetros recorridos y pertenencias que faltan', () => {
    const a = base();
    a.items = { 'luces.stop': { estado: 'correcto' }, 'luces.giros': { estado: 'correcto' }, 'tablero.audio': { estado: 'no_revisado' } };
    a.pertenencias = [{ descripcion: 'Documentación' }, { descripcion: 'Llave de repuesto' }];
    a.danos = [{ id: 'dano-1', zona: 'frente', descripcion: 'Rayón', fotos: [] }];
    const b = { ...base(), km: 1080, combustible: '3/4' as const };
    b.items = { 'luces.stop': { estado: 'con_observaciones', obs: 'Quemada' }, 'luces.giros': { estado: 'correcto' }, 'tablero.audio': { estado: 'correcto' } };
    b.pertenencias = [{ descripcion: 'documentación' }];
    const c = compararContenidos(a, b);
    expect(c.km).toEqual({ ingreso: 1000, salida: 1080, recorridos: 80 });
    expect(c.cambios).toBe(1);
    expect(c.filas.find((f) => f.codigo === 'luces.stop')?.cambio).toBe(true);
    expect(c.filas.find((f) => f.codigo === 'tablero.audio')?.cambio).toBe(false); // el ingreso no se revisó: no se inventa un cambio
    expect(c.pertenencias.faltan).toEqual(['Llave de repuesto']);
    expect(c.danos.ingreso).toHaveLength(1);
  });
});

describe('resumen de cambios de una revisión', () => {
  it('describe en palabras lo que cambió y no dice nada si no cambió nada', () => {
    const a = base();
    expect(resumenCambios(a, JSON.parse(JSON.stringify(a)))).toEqual([]);
    const b: ContenidoChecklist = JSON.parse(JSON.stringify(a));
    b.km = 1500;
    b.items['luces.stop'] = { estado: 'con_observaciones', obs: 'x' };
    b.danos.push({ id: 'dano-9', zona: 'techo', descripcion: 'Abolladura', fotos: [] });
    b.pertenencias.push({ descripcion: 'Cargador' });
    const r = resumenCambios(a, b);
    expect(r).toContain('Kilometraje: 1.000 → 1.500');
    expect(r).toContain('Luces: Stop / freno: No revisado → Con observaciones');
    expect(r).toContain('Daño agregado (Techo): Abolladura');
    expect(r).toContain('Elementos y pertenencias');
  });
});

describe('permisos del checklist', () => {
  it('cada acción tiene su permiso; recepción registra, el mecánico sólo consulta y corregir queda para el propietario', () => {
    for (const p of ['checklists.ver', 'checklists.recepcion', 'checklists.entrega', 'checklists.corregir', 'checklists.firmas'] as const) expect(PERMISOS).toContain(p);
    const rec = permisosEfectivos('recepcion');
    for (const p of ['checklists.ver', 'checklists.recepcion', 'checklists.entrega', 'checklists.firmas'] as const) expect(rec).toContain(p);
    expect(rec).not.toContain('checklists.corregir');
    expect(permisosEfectivos('mecanico')).toContain('checklists.ver');
    expect(permisosEfectivos('mecanico')).not.toContain('checklists.recepcion');
    expect(permisosEfectivos('deposito')).not.toContain('checklists.ver');
    expect(permisosEfectivos('caja')).not.toContain('checklists.ver');
    expect(permisosEfectivos('administrador')).toContain('checklists.corregir');
    // Escribir exige poder consultar
    expect(permisosEfectivos('caja', { g: ['checklists.corregir'], r: [] })).toContain('checklists.ver');
    expect(PLANTILLAS.mecanico.permisos).not.toContain('presupuestos.valorizados.ver');
  });
});
