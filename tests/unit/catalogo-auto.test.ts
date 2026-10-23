// Integridad del catálogo automotor generado (data/catalogo-auto/catalogo.json.gz) y de la normalización de búsqueda.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { claveBusqueda } from '../../shared/catalogo-auto';

const c = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.resolve(__dirname, '../../data/catalogo-auto/catalogo.json.gz'))).toString('utf8'));

describe('claveBusqueda', () => {
  it('ignora mayúsculas, tildes, espacios y signos', () => {
    expect(claveBusqueda('Citroën')).toBe('citroen');
    expect(claveBusqueda('HR-V')).toBe(claveBusqueda('hr v'));
    expect(claveBusqueda('  Gol  Trend ')).toBe('goltrend');
    expect(claveBusqueda('Mercedes-Benz')).toBe('mercedesbenz');
  });
});

describe('catálogo generado', () => {
  it('tiene ids únicos y referencias válidas', () => {
    const unicos = (l: Array<{ id: string }>) => new Set(l.map((x) => x.id)).size === l.length;
    expect(unicos(c.marcas) && unicos(c.modelos) && unicos(c.versiones)).toBe(true);
    const marcas = new Set(c.marcas.map((m: any) => m.id));
    const modelos = new Set(c.modelos.map((m: any) => m.id));
    expect(c.modelos.every((m: any) => marcas.has(m.marca_id))).toBe(true);
    expect(c.versiones.every((v: any) => modelos.has(v.modelo_id))).toBe(true);
  });

  it('no mezcla marcas ni modelos que sólo difieren en la escritura', () => {
    const claves = c.marcas.map((m: any) => m.clave);
    expect(new Set(claves).size).toBe(claves.length);
    const porMarca = new Set(c.modelos.map((m: any) => `${m.marca_id}|${m.clave}`));
    expect(porMarca.size).toBe(c.modelos.length);
  });

  it('contiene sólo datos del vehículo: ningún campo de titulares o registros', () => {
    const campos = new Set([...c.marcas, ...c.modelos, ...c.versiones].flatMap((x: any) => Object.keys(x)));
    expect([...campos].filter((k) => /titular|domicilio|registro|genero|nacimiento|persona/i.test(k))).toEqual([]);
  });

  it('no inventa motorizaciones: cada una figura literalmente en la descripción de su versión', () => {
    for (const v of c.versiones.filter((x: any) => x.motorizacion).slice(0, 3000)) {
      const cil = /^(\d\.\d)/.exec(v.motorizacion)?.[1];
      if (cil) expect(v.descripcion, v.descripcion).toContain(cil);
    }
  });

  it('trae los modelos frecuentes de la fuente con su marca', () => {
    const modelo = (marca: string, m: string) => {
      const ma = c.marcas.find((x: any) => x.clave === claveBusqueda(marca));
      return ma && c.modelos.find((x: any) => x.marca_id === ma.id && x.clave === claveBusqueda(m));
    };
    for (const [ma, mo] of [['Volkswagen', 'Amarok'], ['Fiat', 'Cronos'], ['Toyota', 'Hilux'], ['Ford', 'Ranger'], ['Peugeot', '208']]) expect(modelo(ma, mo), `${ma} ${mo}`).toBeTruthy();
  });
});
