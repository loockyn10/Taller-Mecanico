// Exportación y verificación de las fotografías de R2 (un respaldo de D1 NO las incluye). Ver docs/FOTOGRAFIAS.md.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const extension = (mime) => (mime === 'image/webp' ? 'webp' : 'jpg');

/** Ruta relativa (dentro de la carpeta de exportación) del archivo y de la miniatura de una foto del manifiesto de la API. */
export function rutasDe(f) {
  const base = path.posix.join(f.taller_id, f.id);
  return { archivo: `${base}.${extension(f.mime)}`, miniatura: `${base}_m.${extension(f.mime)}` };
}

/**
 * Comprueba una carpeta exportada contra su manifiesto: cada archivo y miniatura debe existir, pesar lo que dice y tener el mismo sha256.
 * Devuelve { total, correctas, faltantes, corruptas, sobrantes }. Nada se modifica.
 */
export function verificarCarpeta(dir) {
  const archivoManifiesto = path.join(dir, 'manifiesto.json');
  if (!fs.existsSync(archivoManifiesto)) throw new Error(`No hay manifiesto.json en ${dir}`);
  const m = JSON.parse(fs.readFileSync(archivoManifiesto, 'utf8'));
  const faltantes = [];
  const corruptas = [];
  const esperadas = new Set(['manifiesto.json']);
  let correctas = 0;
  for (const f of m.fotos) {
    let ok = true;
    for (const [ruta, sha, bytes] of [
      [f.archivo, f.sha256, f.bytes],
      [f.miniatura, f.miniatura_sha256, f.miniatura_bytes],
    ]) {
      esperadas.add(ruta);
      const p = path.join(dir, ruta);
      if (!fs.existsSync(p)) {
        faltantes.push(ruta);
        ok = false;
        continue;
      }
      const b = fs.readFileSync(p);
      if (b.length !== bytes || sha256(b) !== sha) {
        corruptas.push(ruta);
        ok = false;
      }
    }
    if (ok) correctas++;
  }
  const sobrantes = [];
  const recorrer = (d, rel = '') => {
    for (const e of fs.readdirSync(path.join(dir, d), { withFileTypes: true })) {
      const r = path.posix.join(rel, e.name);
      if (e.isDirectory()) recorrer(path.join(d, e.name), r);
      else if (!esperadas.has(r)) sobrantes.push(r);
    }
  };
  recorrer('.');
  return { total: m.fotos.length, correctas, faltantes, corruptas, sobrantes, generado: m.generado, origen: m.origen };
}
