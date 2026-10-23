// Comprueba qué vehículos frecuentes existen realmente en el catálogo generado (no inventa ni completa nada).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT } from './lib.mjs';

const c = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'data', 'catalogo-auto', 'catalogo.json.gz'))));
const clave = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const BUSCAR = [
  ['Volkswagen', 'Gol'], ['Volkswagen', 'Gol Trend'], ['Volkswagen', 'Amarok'], ['Fiat', 'Cronos'], ['Toyota', 'Etios'], ['Toyota', 'Hilux'], ['Ford', 'Ranger'],
  ['Renault', 'Kangoo'], ['Chevrolet', 'Onix'], ['Peugeot', '208'], ['Chevrolet', 'Corsa'], ['Chevrolet', 'Classic'],
];
const filas = [];
for (const [marca, modelo] of BUSCAR) {
  const ma = c.marcas.find((m) => m.clave === clave(marca));
  const mo = ma && c.modelos.find((x) => x.marca_id === ma.id && x.clave === clave(modelo));
  if (!mo) {
    filas.push({ marca, modelo, estado: 'NO ENCONTRADO', versiones: 0, anios: '', inscripciones: 0 });
    continue;
  }
  const vs = c.versiones.filter((v) => v.modelo_id === mo.id);
  filas.push({ marca, modelo: mo.nombre, estado: 'encontrado', versiones: vs.length, anios: `${mo.anios[0]}–${mo.anios.at(-1)}`, inscripciones: mo.n });
}
console.table(filas);
console.log(`Catálogo: ${c.marcas.length} marcas, ${c.modelos.length} modelos, ${c.versiones.length} versiones (fuente ${c.meta.meses_desde}–${c.meta.meses_hasta}, generado ${c.meta.generado}).`);
