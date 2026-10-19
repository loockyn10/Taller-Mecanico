// Utilidades compartidas por los scripts de desarrollo y pruebas.
import { spawn } from 'node:child_process';
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

export function wrangler(args, opts = {}) {
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
