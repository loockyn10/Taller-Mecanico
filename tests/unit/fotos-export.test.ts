// Verificación de una exportación de fotografías contra su manifiesto (sha256): detecta lo que falta, lo alterado y lo que sobra.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error módulo JS de scripts
import { rutasDe, sha256, verificarCarpeta } from '../../scripts/fotos-lib.mjs';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fotos-exp-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function armar(n = 2) {
  const fotos = [];
  for (let i = 0; i < n; i++) {
    const f: any = { id: `foto-${i}`, taller_id: 'taller-1', mime: 'image/jpeg' };
    const a = Buffer.from(`archivo-${i}`);
    const m = Buffer.from(`mini-${i}`);
    Object.assign(f, rutasDe(f), { bytes: a.length, sha256: sha256(a), miniatura_bytes: m.length, miniatura_sha256: sha256(m), clave: `fotos/taller-1/foto-${i}`, clave_miniatura: `fotos/taller-1/foto-${i}_m` });
    fs.mkdirSync(path.join(dir, 'taller-1'), { recursive: true });
    fs.writeFileSync(path.join(dir, f.archivo), a);
    fs.writeFileSync(path.join(dir, f.miniatura), m);
    fotos.push(f);
  }
  fs.writeFileSync(path.join(dir, 'manifiesto.json'), JSON.stringify({ generado: '2026-10-23', origen: 'prueba', fotos }));
  return fotos;
}

describe('verificarCarpeta', () => {
  it('una exportación íntegra da todo correcto', () => {
    armar();
    expect(verificarCarpeta(dir)).toMatchObject({ total: 2, correctas: 2, faltantes: [], corruptas: [], sobrantes: [] });
  });
  it('detecta archivos faltantes, alterados y sobrantes', () => {
    const f = armar(3);
    fs.rmSync(path.join(dir, f[0].miniatura));
    fs.writeFileSync(path.join(dir, f[1].archivo), 'alterado');
    fs.writeFileSync(path.join(dir, 'taller-1', 'suelta.jpg'), 'x');
    const v = verificarCarpeta(dir);
    expect(v.correctas).toBe(1);
    expect(v.faltantes).toEqual([f[0].miniatura]);
    expect(v.corruptas).toEqual([f[1].archivo]);
    expect(v.sobrantes).toEqual(['taller-1/suelta.jpg']);
  });
  it('sin manifiesto falla de forma explícita', () => {
    expect(() => verificarCarpeta(dir)).toThrow(/manifiesto/);
  });
});
