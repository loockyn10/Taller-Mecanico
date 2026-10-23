// Carga el catálogo generado (data/catalogo-auto/catalogo.json.gz) en D1. Es idempotente: los ids son estables y se actualiza por id,
// de modo que los vehículos que ya apuntan al catálogo nunca quedan huérfanos.
//   node scripts/catalogo-auto/cargar.mjs --local [--persist-to <carpeta>]   (D1 local de desarrollo)
//   node scripts/catalogo-auto/cargar.mjs --remoto                           (D1 de Cloudflare; requiere wrangler logueado)
//   node scripts/catalogo-auto/cargar.mjs --sql <archivo>                    (sólo escribe el SQL)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import { ROOT } from './lib.mjs';
import { esperarProceso, wrangler } from '../lib.mjs';

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i < 0 ? undefined : (process.argv[i + 1] ?? '');
};
const c = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'data', 'catalogo-auto', 'catalogo.json.gz'))));

const q = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const lotes = (filas, n = 40) => Array.from({ length: Math.ceil(filas.length / n) }, (_, i) => filas.slice(i * n, i * n + n));
function upsert(tabla, cols, filas) {
  const set = cols.slice(1).map((k) => `${k} = excluded.${k}`).join(', ');
  return lotes(filas).map((l) => `INSERT INTO ${tabla} (${cols.join(', ')}) VALUES\n${l.map((f) => `(${f.map(q).join(', ')})`).join(',\n')}\nON CONFLICT(id) DO UPDATE SET ${set};`);
}

const sql = [
  ...upsert('cat_marcas', ['id', 'nombre', 'clave', 'busqueda', 'codigos', 'n'], c.marcas.map((m) => [m.id, m.nombre, m.clave, m.busqueda, JSON.stringify(m.codigos), m.n])),
  ...upsert('cat_modelos', ['id', 'marca_id', 'nombre', 'clave', 'tipo', 'anios', 'n'], c.modelos.map((m) => [m.id, m.marca_id, m.nombre, m.clave, m.tipo, m.anios.join(','), m.n])),
  ...upsert('cat_versiones', ['id', 'modelo_id', 'descripcion', 'version', 'motorizacion', 'combustible', 'tipo', 'codigos', 'anios', 'n'], c.versiones.map((v) => [v.id, v.modelo_id, v.descripcion, v.version, v.motorizacion, v.combustible, v.tipo, JSON.stringify(v.codigos), v.anios.join(','), v.n])),
  ...Object.entries({ ...c.meta, marcas: c.marcas.length, modelos: c.modelos.length, versiones: c.versiones.length }).map(([k, v]) => `INSERT INTO cat_meta (clave, valor) VALUES (${q(k)}, ${q(String(v ?? ''))}) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor;`),
];
const texto = sql.join('\n') + '\n';

const soloSql = arg('--sql');
if (soloSql) {
  fs.writeFileSync(soloSql, texto);
  console.log(`SQL escrito en ${soloSql} (${(texto.length / 1e6).toFixed(2)} MB, ${sql.length} sentencias)`);
} else {
  const remoto = process.argv.includes('--remoto');
  if (!remoto && !process.argv.includes('--local')) throw new Error('Indicá --local o --remoto');
  const tmp = path.join(os.tmpdir(), `catalogo-auto-${process.pid}.sql`);
  fs.writeFileSync(tmp, texto);
  const persist = arg('--persist-to');
  try {
    await esperarProceso(wrangler(['d1', 'execute', 'DB', remoto ? '--remote' : '--local', ...(persist ? ['--persist-to', persist] : []), '--file', tmp, '--yes']));
    console.log(`Catálogo cargado (${remoto ? 'remoto' : 'local'}): ${c.marcas.length} marcas, ${c.modelos.length} modelos, ${c.versiones.length} versiones.`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
