// Descarga los ZIP/CSV de inscripciones iniciales de autos de la DNRPA (datos.jus.gob.ar, CC BY 4.0).
// Se guardan en .cache/catalogo-auto/ (fuera de git). Los ya descargados se reutilizan salvo --forzar.
import fs from 'node:fs/promises';
import path from 'node:path';
import { CACHE, DATASET_API } from './lib.mjs';

const forzar = process.argv.includes('--forzar');
const desde = Number((process.argv.find((a) => a.startsWith('--desde='))?.split('=')[1]) ?? 2018);

await fs.mkdir(path.join(CACHE, 'zips'), { recursive: true });
const meta = await (await fetch(DATASET_API)).json();
if (!meta.success) throw new Error('La API del dataset no respondió bien');
await fs.writeFile(path.join(CACHE, 'dataset.json'), JSON.stringify({ descargado: new Date().toISOString(), modificado: meta.result.metadata_modified, licencia: meta.result.license_title, recursos: meta.result.resources.map((r) => ({ nombre: r.name, formato: r.format, url: r.url })) }, null, 1));

for (const r of meta.result.resources) {
  const fmt = String(r.format).toUpperCase();
  const m = /autos-(\d{4,6})\.(zip|csv)$/i.exec(r.url);
  if (!m || (fmt !== 'ZIP' && fmt !== 'CSV')) continue;
  if (Number(m[1].slice(0, 4)) < desde) continue;
  const destino = path.join(CACHE, 'zips', `${m[1]}.${m[2].toLowerCase()}`);
  const existe = await fs.stat(destino).then(() => true, () => false);
  if (existe && !forzar) {
    console.log(`= ${path.basename(destino)} (ya estaba)`);
    continue;
  }
  const res = await fetch(r.url);
  if (!res.ok) throw new Error(`${r.url} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destino, buf);
  console.log(`+ ${path.basename(destino)} ${(buf.length / 1e6).toFixed(1)} MB`);
}
