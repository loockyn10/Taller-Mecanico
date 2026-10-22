// Sprint 13: cifrado de los respaldos que salen de Cloudflare y controles contables de un respaldo.
import { afterAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error módulo JS de scripts
import { cifrarArchivo, descifrarArchivo, huellaClavePublica } from '../../scripts/respaldo-cifrado.mjs';
// @ts-expect-error módulo JS de scripts
import { controlesContables } from '../../scripts/respaldo-lib.mjs';

let DatabaseSync: any = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  /* Node sin node:sqlite */
}

const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'fierro-test-cifrado-'));
afterAll(() => fs.rmSync(carpeta, { recursive: true, force: true }));
const par = () => crypto.generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const A = par();
const B = par();
const SECRETO = 'DATO-COMERCIAL-SECRETO-pbkdf2$100000$abc';
const original = path.join(carpeta, 'respaldo.sql');
fs.writeFileSync(original, `${'INSERT INTO clientes VALUES (1, \'Juana\');\n'.repeat(5000)}-- ${SECRETO}\n`);

describe('cifrado de respaldos', () => {
  it('cifra, descifra con la clave privada y reproduce exactamente el original', async () => {
    const enc = path.join(carpeta, 'a.fbk');
    const c = await cifrarArchivo(original, enc, A.publicKey);
    expect(c.bytesCifrado).toBeLessThan(c.bytesOriginal); // se comprime antes de cifrar
    const salida = path.join(carpeta, 'a.sql');
    const d = await descifrarArchivo(enc, salida, { clavePrivadaPem: A.privateKey });
    expect(d.sha256).toBe(c.sha256Original);
    expect(fs.readFileSync(salida, 'utf8')).toBe(fs.readFileSync(original, 'utf8'));
  });

  it('el archivo cifrado no contiene nada legible del original', async () => {
    const enc = path.join(carpeta, 'b.fbk');
    await cifrarArchivo(original, enc, A.publicKey);
    const bytes = fs.readFileSync(enc).toString('latin1');
    expect(bytes).not.toContain('Juana');
    expect(bytes).not.toContain(SECRETO);
    expect(bytes).not.toContain('pbkdf2');
    expect(bytes.startsWith('FIERRO-BAK1\n')).toBe(true);
  });

  it('con otra clave privada no se puede abrir', async () => {
    const enc = path.join(carpeta, 'c.fbk');
    await cifrarArchivo(original, enc, A.publicKey);
    await expect(descifrarArchivo(enc, path.join(carpeta, 'c.sql'), { clavePrivadaPem: B.privateKey })).rejects.toThrow();
    expect(fs.existsSync(path.join(carpeta, 'c.sql'))).toBe(false);
  });

  it('detecta cualquier alteración o truncamiento del archivo cifrado y no deja un archivo a medias', async () => {
    const enc = path.join(carpeta, 'd.fbk');
    await cifrarArchivo(original, enc, A.publicKey);
    const buf = fs.readFileSync(enc);
    const alterado = path.join(carpeta, 'd-alterado.fbk');
    const copia = Buffer.from(buf);
    copia[copia.length - 40] ^= 0xff; // un byte del texto cifrado
    fs.writeFileSync(alterado, copia);
    await expect(descifrarArchivo(alterado, path.join(carpeta, 'd1.sql'), { clavePrivadaPem: A.privateKey })).rejects.toThrow(/clave incorrecta o archivo alterado/);
    const truncado = path.join(carpeta, 'd-truncado.fbk');
    fs.writeFileSync(truncado, buf.subarray(0, buf.length - 200));
    await expect(descifrarArchivo(truncado, path.join(carpeta, 'd2.sql'), { clavePrivadaPem: A.privateKey })).rejects.toThrow();
    // La cabecera está autenticada: cambiar la clave pública anotada también se detecta
    const cab = Buffer.from(buf);
    const i = cab.indexOf('"pub":"') + 7;
    cab[i] = cab[i] === 0x61 ? 0x62 : 0x61;
    fs.writeFileSync(path.join(carpeta, 'd-cab.fbk'), cab);
    await expect(descifrarArchivo(path.join(carpeta, 'd-cab.fbk'), path.join(carpeta, 'd3.sql'), { clavePrivadaPem: A.privateKey })).rejects.toThrow();
    for (const n of ['d1.sql', 'd2.sql', 'd3.sql']) expect(fs.existsSync(path.join(carpeta, n))).toBe(false);
  });

  it('rechaza archivos que no son respaldos de Fierro, claves débiles y no pisa archivos existentes', async () => {
    const otro = path.join(carpeta, 'otro.fbk');
    fs.writeFileSync(otro, 'hola');
    await expect(descifrarArchivo(otro, path.join(carpeta, 'o.sql'), { clavePrivadaPem: A.privateKey })).rejects.toThrow(/cabecera inválida/);
    const debil = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    await expect(cifrarArchivo(original, path.join(carpeta, 'w.fbk'), debil.publicKey)).rejects.toThrow(/3072/);
    const enc = path.join(carpeta, 'e.fbk');
    await cifrarArchivo(original, enc, A.publicKey);
    await expect(cifrarArchivo(original, enc, A.publicKey)).rejects.toThrow(); // flags: 'wx'
  });

  it('dos cifrados del mismo archivo son distintos (clave de datos y vector nuevos) y la huella identifica la clave pública', async () => {
    const x = path.join(carpeta, 'x.fbk');
    const y = path.join(carpeta, 'y.fbk');
    await cifrarArchivo(original, x, A.publicKey);
    await cifrarArchivo(original, y, A.publicKey);
    expect(fs.readFileSync(x).equals(fs.readFileSync(y))).toBe(false);
    expect(huellaClavePublica(A.publicKey)).toMatch(/^[0-9a-f]{16}$/);
    expect(huellaClavePublica(A.publicKey)).not.toBe(huellaClavePublica(B.publicKey));
  });
});

describe.skipIf(!DatabaseSync)('controles contables de un respaldo', () => {
  const crear = () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE talleres (id TEXT PRIMARY KEY, nombre TEXT);
      CREATE TABLE asientos (id TEXT PRIMARY KEY, taller_id TEXT, numero INTEGER, estado TEXT, origen_tipo TEXT, origen_id TEXT, evento TEXT, revierte_id TEXT);
      CREATE TABLE asiento_lineas (id TEXT PRIMARY KEY, taller_id TEXT, asiento_id TEXT, debe INTEGER, haber INTEGER);
      INSERT INTO talleres VALUES ('t1', 'Taller Uno'), ('t2', 'Taller Dos');
      INSERT INTO asientos VALUES ('a1', 't1', 1, 'registrado', 'venta', 'v1', 'alta', NULL), ('a2', 't1', 2, 'registrado', 'cobro', 'c1', 'alta', NULL), ('b1', 't2', 1, 'registrado', 'venta', 'v9', 'alta', NULL);
      INSERT INTO asiento_lineas VALUES ('l1', 't1', 'a1', 100, 0), ('l2', 't1', 'a1', 0, 100), ('l3', 't1', 'a2', 50, 0), ('l4', 't1', 'a2', 0, 50), ('l5', 't2', 'b1', 7, 0), ('l6', 't2', 'b1', 0, 7);
    `);
    return db;
  };

  it('una contabilidad sana pasa todos los controles y resume cada taller', () => {
    const db = crear();
    const r = controlesContables(db);
    expect(r.aplica).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.controles.every((c: any) => c.ok)).toBe(true);
    expect(r.porTaller).toEqual([{ id: 't2', nombre: 'Taller Dos', asientos: 1, lineas: 2, debe: 7, haber: 7 }, { id: 't1', nombre: 'Taller Uno', asientos: 2, lineas: 4, debe: 150, haber: 150 }]);
    db.close();
  });

  it('detecta asientos que no balancean, numeración con saltos, duplicados, huérfanos y reversiones sin contra-asiento', () => {
    const db = crear();
    db.exec("UPDATE asiento_lineas SET debe = 99 WHERE id = 'l1'");
    db.exec("UPDATE asientos SET numero = 5 WHERE id = 'a2'");
    db.exec("INSERT INTO asientos VALUES ('dup', 't1', 3, 'registrado', 'venta', 'v1', 'alta', NULL)");
    db.exec("INSERT INTO asiento_lineas VALUES ('l9', 't1', 'fantasma', 1, 0)");
    db.exec("INSERT INTO asientos VALUES ('rev', 't2', 2, 'revertido', 'venta', 'v8', 'alta', NULL)");
    const r = controlesContables(db);
    expect(r.ok).toBe(false);
    const malos = r.controles.filter((c: any) => !c.ok).map((c: any) => c.clave).sort();
    expect(malos).toEqual(['duplicados', 'lineas_huerfanas', 'numeracion', 'partida_doble', 'reversiones', 'sin_lineas'].sort());
    db.close();
  });

  it('en un respaldo anterior a la contabilidad no aplica', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE talleres (id TEXT, nombre TEXT)');
    expect(controlesContables(db)).toMatchObject({ aplica: false, ok: true });
    db.close();
  });
});
