// Lee los CSV descargados y deja un agregado sin datos personales: sólo columnas del vehículo.
// Descarta explícitamente todo lo que empiece con titular_ o registro_seccional_ (nunca se lee).
import fs from 'node:fs/promises';
import path from 'node:path';
import { CACHE, decodificar, leerZip, recorrerCsv } from './lib.mjs';

const COLUMNAS = [
  'automotor_origen',
  'automotor_anio_modelo',
  'automotor_tipo_codigo',
  'automotor_tipo_descripcion',
  'automotor_marca_codigo',
  'automotor_marca_descripcion',
  'automotor_modelo_codigo',
  'automotor_modelo_descripcion',
];

const dir = path.join(CACHE, 'zips');
const archivos = (await fs.readdir(dir)).sort();
/** clave → { tipo, marcaCod, marca, modeloCod, modelo, anios:{año:n}, origen:{..} } */
const agg = new Map();
const mesesVistos = new Set();
let filas = 0;
let sinMarca = 0;

function procesar(texto, nombre) {
  const mes = /(\d{6})/.exec(nombre)?.[1];
  if (mes) {
    if (mesesVistos.has(mes)) return; // un mes ya leído desde un ZIP anual
    mesesVistos.add(mes);
  }
  recorrerCsv(texto, COLUMNAS, (f) => {
    filas++;
    const marca = f.automotor_marca_descripcion.trim();
    const modelo = f.automotor_modelo_descripcion.trim();
    if (!marca || !modelo) {
      sinMarca++;
      return;
    }
    const k = [f.automotor_tipo_codigo, f.automotor_marca_codigo, marca, f.automotor_modelo_codigo, modelo].join('\t');
    let e = agg.get(k);
    if (!e) {
      e = { tc: f.automotor_tipo_codigo.trim(), t: f.automotor_tipo_descripcion.trim(), mc: f.automotor_marca_codigo.trim(), m: marca, oc: f.automotor_modelo_codigo.trim(), o: modelo, a: {}, n: 0 };
      agg.set(k, e);
    }
    const anio = Number(f.automotor_anio_modelo);
    if (anio >= 1900 && anio <= 2100) e.a[anio] = (e.a[anio] ?? 0) + 1;
    e.n++;
  });
}

for (const a of archivos) {
  const buf = await fs.readFile(path.join(dir, a));
  if (a.endsWith('.zip')) {
    for (const ent of leerZip(buf)) if (ent.nombre.toLowerCase().endsWith('.csv')) procesar(decodificar(ent.datos()), ent.nombre);
  } else procesar(decodificar(buf), a);
  console.log(`${a}: ${filas} filas acumuladas, ${agg.size} combinaciones`);
}

const salida = { generado: new Date().toISOString(), meses: [...mesesVistos].sort(), filas, sinMarca, combinaciones: [...agg.values()] };
await fs.writeFile(path.join(CACHE, 'agregado.json'), JSON.stringify(salida));
console.log(`Meses: ${salida.meses[0]}–${salida.meses.at(-1)} (${salida.meses.length}); filas ${filas}; descartadas sin marca/modelo ${sinMarca}; combinaciones ${agg.size}`);
