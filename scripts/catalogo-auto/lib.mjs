// Utilidades del proceso del catálogo automotor: carpeta de trabajo, lector de ZIP y de CSV.
// Sólo se usan módulos de Node: no hay dependencias nuevas.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import zlib from 'node:zlib';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CACHE = process.env.CATALOGO_CACHE ?? path.join(ROOT, '.cache', 'catalogo-auto');
export const DATASET_API = 'https://datos.jus.gob.ar/api/3/action/package_show?id=inscripciones-iniciales-de-autos';

/** Lista las entradas de un ZIP y devuelve {nombre, datos()} usando el directorio central. */
export function leerZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70_000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP inválido: sin directorio central');
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entradas = [];
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP inválido: entrada corrupta');
    const metodo = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const nombre = buf.toString('utf8', p + 46, p + 46 + nlen);
    entradas.push({
      nombre,
      datos() {
        const lnlen = buf.readUInt16LE(off + 26);
        const lelen = buf.readUInt16LE(off + 28);
        const ini = off + 30 + lnlen + lelen;
        const crudo = buf.subarray(ini, ini + csize);
        return metodo === 0 ? crudo : zlib.inflateRawSync(crudo);
      },
    });
    p += 46 + nlen + elen + clen;
  }
  return entradas;
}

/** Decodifica el CSV (UTF-8; si trae caracteres inválidos, latin1) y quita el BOM. */
export function decodificar(buf) {
  let t = buf.toString('utf8');
  if (t.includes('�')) t = buf.toString('latin1');
  return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
}

/** Recorre un CSV (con o sin comillas) y llama a fila(objeto) con las columnas por nombre de encabezado. */
export function recorrerCsv(texto, columnas, fila) {
  let i = 0;
  const n = texto.length;
  let enc = null;
  let idx = null;
  const campos = [];
  while (i < n) {
    campos.length = 0;
    let fin = false;
    while (!fin) {
      let v;
      if (texto[i] === '"') {
        i++;
        let ini = i;
        v = '';
        for (;;) {
          const q = texto.indexOf('"', i);
          if (q < 0) {
            v += texto.slice(ini);
            i = n;
            break;
          }
          v += texto.slice(ini, q);
          if (texto[q + 1] === '"') {
            v += '"';
            i = q + 2;
            ini = i;
          } else {
            i = q + 1;
            break;
          }
        }
      } else {
        let j = i;
        while (j < n && texto[j] !== ',' && texto[j] !== '\n' && texto[j] !== '\r') j++;
        v = texto.slice(i, j);
        i = j;
      }
      campos.push(v);
      if (texto[i] === ',') i++;
      else {
        if (texto[i] === '\r') i++;
        if (texto[i] === '\n') i++;
        fin = true;
      }
    }
    if (!enc) {
      enc = campos.map((c) => c.trim());
      idx = columnas.map((c) => {
        const k = enc.indexOf(c);
        if (k < 0) throw new Error(`Falta la columna ${c} en el CSV`);
        return k;
      });
      continue;
    }
    if (campos.length < 2) continue;
    const o = {};
    for (let c = 0; c < columnas.length; c++) o[columnas[c]] = campos[idx[c]] ?? '';
    fila(o);
  }
}
