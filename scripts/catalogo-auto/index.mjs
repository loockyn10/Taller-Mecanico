// Proceso reproducible del catálogo automotor: npm run catalogo -- <paso>
//   descargar | agregar | generar | validar | cargar (--local|--remoto) | actualizar (descargar+agregar+generar+validar)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const [paso = 'ayuda', ...resto] = process.argv.slice(2);
const correr = (s, a = []) => {
  const r = spawnSync(process.execPath, [path.join(dir, `${s}.mjs`), ...a], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
if (paso === 'actualizar') for (const s of ['descargar', 'agregar', 'generar', 'validar']) correr(s, s === 'descargar' ? resto : []);
else if (['descargar', 'agregar', 'generar', 'validar', 'cargar'].includes(paso)) correr(paso, resto);
else console.log('Uso: npm run catalogo -- descargar | agregar | generar | validar | cargar --local|--remoto | actualizar');
