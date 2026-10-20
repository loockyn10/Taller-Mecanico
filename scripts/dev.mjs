// Arranca el entorno local: aplica migraciones, levanta la API (wrangler dev + D1 local) y el frontend (Vite).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, carpetaEstado, migrar, wrangler } from './lib.mjs';

if (!fs.existsSync(path.join(ROOT, '.dev.vars'))) {
  fs.copyFileSync(path.join(ROOT, '.dev.vars.example'), path.join(ROOT, '.dev.vars'));
  console.log('Creado .dev.vars a partir de .dev.vars.example');
}
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true }); // wrangler exige la carpeta de assets

const estado = carpetaEstado('dev');
console.log(`Base de datos local: ${estado}`);
await migrar(estado);
console.log('Migraciones aplicadas.');

const puertoApi = process.env.FIERRO_API_PORT ?? '8787';
const api = wrangler(['dev', '--port', puertoApi, '--persist-to', estado, '--show-interactive-dev-session=false']);
const web = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')], { cwd: ROOT, stdio: 'inherit' });

const salir = () => {
  api.kill();
  web.kill();
  process.exit(0);
};
process.on('SIGINT', salir);
process.on('SIGTERM', salir);
api.on('exit', (c) => { console.log(`API terminó (${c})`); web.kill(); process.exit(c ?? 0); });
web.on('exit', (c) => { console.log(`Frontend terminó (${c})`); api.kill(); process.exit(c ?? 0); });
