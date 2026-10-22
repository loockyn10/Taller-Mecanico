// Levanta un Worker real (wrangler dev + D1 local en una carpeta temporal) para las pruebas de integración.
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
// @ts-expect-error módulo JS de scripts
import { carpetaEstado, esperarServidor, migrar, wrangler } from '../../scripts/lib.mjs';

export const PUERTO = 8799;
export const PLATFORM_TOKEN = 'token-de-pruebas-de-plataforma-123';

let proc: ChildProcess | undefined;
let estado: string;

export async function setup() {
  // wrangler exige que exista la carpeta de assets (la SPA compilada); para la API alcanza con una vacía.
  fs.mkdirSync('dist', { recursive: true });
  estado = carpetaEstado('test');
  fs.rmSync(estado, { recursive: true, force: true });
  await migrar(estado);
  // Las pruebas que necesitan alterar el reloj de los datos (vencimientos) abren esta base local de ensayo; nunca una remota.
  process.env.FIERRO_TEST_ESTADO = estado;
  proc = wrangler(
    ['dev', '--port', String(PUERTO), '--persist-to', estado, '--var', `PLATFORM_ADMIN_TOKEN:${PLATFORM_TOKEN}`, '--var', 'PBKDF2_ITERATIONS:20000', '--var', 'CONTAB_SYNC:esperar', '--show-interactive-dev-session=false'],
    { stdio: 'pipe' },
  );
  let log = '';
  proc.stdout?.on('data', (d) => (log += d));
  proc.stderr?.on('data', (d) => (log += d));
  try {
    await esperarServidor(`http://127.0.0.1:${PUERTO}/api/salud`, 90_000);
  } catch (e) {
    console.error(log);
    throw e;
  }
}

export async function teardown() {
  proc?.kill();
  await new Promise((r) => setTimeout(r, 500));
  try {
    fs.rmSync(estado, { recursive: true, force: true });
  } catch {
    /* Windows puede mantener el archivo bloqueado unos instantes */
  }
}
