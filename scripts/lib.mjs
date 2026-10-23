// Utilidades compartidas por los scripts de desarrollo y pruebas.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

/**
 * Carpeta de estado local de D1/Miniflare. Por defecto `.wrangler/state` dentro del proyecto;
 * se puede cambiar con FIERRO_STATE (útil en Windows si la ruta del proyecto es muy larga).
 */
export function carpetaEstado(nombre = 'dev') {
  if (process.env.FIERRO_STATE) return path.join(process.env.FIERRO_STATE, nombre);
  if (nombre === 'dev') return path.join(ROOT, '.wrangler', 'state');
  return path.join(os.tmpdir(), `fierro-${nombre}-${process.pid}`);
}

/** Quita comentarios // y /* *\/ de un JSONC respetando las cadenas, y las comas finales. */
function jsoncAJson(t) {
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '"') {
      let j = i + 1;
      while (t[j] !== '"') j += t[j] === '\\' ? 2 : 1;
      out += t.slice(i, j + 1);
      i = j;
    } else if (c === '/' && t[i + 1] === '/') while (i < t.length && t[i] !== '\n') i++;
    else if (c === '/' && t[i + 1] === '*') i = t.indexOf('*/', i + 2) + 1;
    else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Configuración de Wrangler SÓLO para correr el Worker en local (dev y pruebas): la misma de wrangler.jsonc más el bucket R2 de fotos simulado en
 * disco (Miniflare). El bucket real se declara en wrangler.jsonc recién cuando existe en la cuenta; mientras tanto la producción no lo referencia.
 */
export function configLocal() {
  const cfg = JSON.parse(jsoncAJson(fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8')));
  if (!(cfg.r2_buckets ?? []).some((b) => b.binding === 'FIERRO_FOTOS')) cfg.r2_buckets = [...(cfg.r2_buckets ?? []), { binding: 'FIERRO_FOTOS', bucket_name: 'fierro-fotos' }];
  const destino = path.join(ROOT, 'wrangler.local.generado.jsonc');
  fs.writeFileSync(destino, JSON.stringify(cfg, null, 2));
  return destino;
}

export function wrangler(args, opts = {}) {
  if (args[0] === 'dev' && !args.includes('-c') && !args.includes('--config')) args = [...args, '-c', configLocal()];
  return spawn(process.execPath, [WRANGLER, ...args], { cwd: ROOT, stdio: opts.stdio ?? 'inherit', env: { ...process.env, ...opts.env } });
}

export function esperarProceso(p) {
  return new Promise((resolve, reject) => {
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`proceso terminó con código ${code}`))));
    p.on('error', reject);
  });
}

export async function migrar(persist) {
  await esperarProceso(wrangler(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist], { stdio: 'pipe' }));
}

export async function esperarServidor(url, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* todavía no levantó */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`El servidor no respondió en ${url}`);
}
