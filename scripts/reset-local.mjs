// Borra la base de datos local de desarrollo y vuelve a aplicar las migraciones (detener `npm run dev` antes).
import fs from 'node:fs';
import { carpetaEstado, migrar } from './lib.mjs';

const estado = carpetaEstado('dev');
fs.rmSync(estado, { recursive: true, force: true });
await migrar(estado);
console.log(`Base local recreada en ${estado}. Ejecutá "npm run dev" y luego "npm run db:seed".`);
