// Sprint 18: respaldo programado de las fotografías — paquete, plan incremental, cifrado de punta a punta y restauración de la cadena.
// Un servidor HTTP de mentira hace de Worker (manifiesto + archivos), así que corre sin red ni Cloudflare.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
// @ts-expect-error módulo JS de scripts
import { desempaquetar, empaquetar, planIncremental, respaldarFotos, restaurarCadena } from '../../scripts/fotos-respaldo-lib.mjs';
// @ts-expect-error módulo JS de scripts
import { rutasDe, sha256, verificarCarpeta } from '../../scripts/fotos-lib.mjs';

const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'fierro-test-fotos-resp-'));
afterAll(() => fs.rmSync(carpeta, { recursive: true, force: true }));
const par = crypto.generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const otra = crypto.generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const TOKEN = 'token-de-solo-lectura-de-prueba-123456';

// ───────── Servidor de mentira ─────────
interface FotoFalsa { id: string; taller_id: string; vehiculo_id: string; orden_id: string | null; etapa: string | null; mime: string; bytes: number; miniatura_bytes: number; sha256: string; miniatura_sha256: string; created_at: string; clave: string; clave_miniatura: string; _a: Buffer; _m: Buffer }
const R2 = new Map<string, FotoFalsa>();
let n = 0;
function foto(taller = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', relleno = 'x'): FotoFalsa {
  n++;
  const id = `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const a = Buffer.from(`ORIGINAL-${id}-${relleno.repeat(500)}`);
  const m = Buffer.from(`MINI-${id}`);
  const f: FotoFalsa = { id, taller_id: taller, vehiculo_id: 'veh-1', orden_id: 'ot-1', etapa: 'recepcion', mime: 'image/jpeg', bytes: a.length, miniatura_bytes: m.length, sha256: sha256(a), miniatura_sha256: sha256(m), created_at: '2026-10-24T10:00:00Z', clave: `fotos/${taller}/${id}`, clave_miniatura: `fotos/${taller}/${id}_m`, _a: a, _m: m };
  R2.set(id, f);
  return f;
}
const publica = ({ _a, _m, ...resto }: FotoFalsa) => resto;
let servidor: http.Server;
let api = '';
const pedidos: string[] = [];
beforeAll(async () => {
  servidor = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    pedidos.push(u.pathname + u.search);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end('no');
    if (u.pathname === '/api/plataforma/fotos-respaldo/manifiesto') {
      const todas = [...R2.values()].sort((a, b) => a.id.localeCompare(b.id)).filter((f) => f.id > (u.searchParams.get('despues') ?? ''));
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ fotos: todas.slice(0, 3).map(publica), siguiente: todas.length > 3 ? todas[2].id : null }));
    }
    const m = /^\/api\/plataforma\/fotos-respaldo\/([^/]+)\/archivo$/.exec(u.pathname);
    const f = m && R2.get(m[1]);
    if (!f) return void res.writeHead(404).end('no');
    res.writeHead(200).end(u.searchParams.get('variante') === 'miniatura' ? f._m : f._a);
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  api = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});
afterAll(() => servidor.close());

const opciones = (extra: Record<string, unknown>) => ({ api, token: TOKEN, modo: 'respaldo', clavePublicaPem: par.publicKey, ...extra });
const paquetesDe = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith('.fbk')).sort();

describe('paquete de fotografías', () => {
  it('empaqueta y desempaqueta verificando cada entrada; detecta alteraciones, cortes y rutas peligrosas', () => {
    const d = path.join(carpeta, 'p1');
    fs.mkdirSync(d);
    const f = foto();
    fs.writeFileSync(path.join(d, 'manifiesto.json'), JSON.stringify({ fotos: [f.id] }));
    fs.writeFileSync(path.join(d, 'a.bin'), f._a);
    fs.writeFileSync(path.join(d, 'm.bin'), f._m);
    const r = rutasDe(f);
    const entradas = [{ p: 'manifiesto.json', archivo: path.join(d, 'manifiesto.json') }, { p: r.archivo, archivo: path.join(d, 'a.bin') }, { p: r.miniatura, archivo: path.join(d, 'm.bin') }];
    const pack = path.join(carpeta, 'p1.pack');
    expect(empaquetar(entradas, pack)).toMatchObject({ entradas: 3 });
    const out = path.join(carpeta, 'p1-out');
    expect(desempaquetar(pack, out)).toHaveLength(3);
    expect(fs.readFileSync(path.join(out, r.archivo))).toEqual(f._a);

    const crudo = fs.readFileSync(pack);
    const alterado = path.join(carpeta, 'p1-alt.pack');
    const i = crudo.indexOf('ORIGINAL-') + 12;
    fs.writeFileSync(alterado, Buffer.concat([crudo.subarray(0, i), Buffer.from('Z'), crudo.subarray(i + 1)]));
    expect(() => desempaquetar(alterado, path.join(carpeta, 'p1-alt-out'))).toThrow(/alterada/);
    const cortado = path.join(carpeta, 'p1-cort.pack');
    fs.writeFileSync(cortado, crudo.subarray(0, crudo.length - 20));
    expect(() => desempaquetar(cortado, path.join(carpeta, 'p1-cort-out'))).toThrow();
    expect(() => empaquetar([{ p: '../../etc/passwd', archivo: path.join(d, 'a.bin') }], path.join(carpeta, 'mala.pack'))).toThrow(/Ruta no válida/);
    // Un paquete armado a mano con una ruta fuera de la carpeta se rechaza al desempaquetar
    const falso = path.join(carpeta, 'falso.pack');
    const dato = Buffer.from('hola');
    fs.writeFileSync(falso, Buffer.concat([Buffer.from('FIERRO-FOTOPACK1\n'), Buffer.from(`${JSON.stringify({ p: '../fuera.jpg', n: 4, sha256: sha256(dato) })}\n`), dato, Buffer.from('\n'), Buffer.from('{"fin":true,"entradas":1}\n')]));
    expect(() => desempaquetar(falso, path.join(carpeta, 'falso-out'))).toThrow(/no válida/);
    expect(fs.existsSync(path.join(carpeta, 'fuera.jpg'))).toBe(false);
  });
});

describe('plan incremental', () => {
  it('copia sólo lo nuevo o cambiado e informa lo eliminado', () => {
    const a = foto();
    const b = foto();
    const c = foto();
    const base = { fotos: [a, b].map((f) => ({ id: f.id, sha256: f.sha256, miniatura_sha256: f.miniatura_sha256 })) };
    const hoy = [a, { ...b, sha256: 'otro' }, c];
    const p = planIncremental(hoy, base);
    expect(p.sinCambios.map((f: any) => f.id)).toEqual([a.id]);
    expect(p.nuevas.map((f: any) => f.id)).toEqual([b.id, c.id]);
    expect(planIncremental([c], base).eliminadas.sort()).toEqual([a.id, b.id].sort());
  });
});

describe('respaldo programado de fotografías (cadena completa → incremental → restauración)', () => {
  const salida1 = path.join(carpeta, 'ejec1');
  const salida2 = path.join(carpeta, 'ejec2');
  const salida3 = path.join(carpeta, 'ejec3');
  let f: FotoFalsa[];

  it('primera ejecución: copia completa, cifrada y verificada; el índice no revela datos de clientes', async () => {
    R2.clear();
    f = [foto(), foto(), foto(), foto(), foto()]; // 5 fotos → el manifiesto falso las pagina de a 3
    const t0 = new Date('2026-10-24T06:00:00Z');
    const logs: string[] = [];
    const i1 = await respaldarFotos(opciones({ salida: salida1, indiceBase: null, ahora: t0, log: (m: string) => logs.push(m) }));
    expect(i1).toMatchObject({ tipo: 'completo', fotos_total: 5, copiadas: 5 });
    expect(i1.cadena).toHaveLength(1);
    expect(paquetesDe(salida1)).toHaveLength(1);
    // El paquete en disco está cifrado: no contiene nada legible de las fotos.
    const cifrado = fs.readFileSync(path.join(salida1, paquetesDe(salida1)[0]));
    expect(cifrado.includes(Buffer.from('ORIGINAL-'))).toBe(false);
    expect(cifrado.includes(Buffer.from(f[0].id))).toBe(false);
    // El índice sólo tiene ids y hashes (nada de taller, vehículo ni OT)
    const idx = fs.readFileSync(path.join(salida1, 'indice.json'), 'utf8');
    expect(idx).not.toContain('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
    expect(idx).not.toContain('veh-1');
    expect(idx).not.toContain('ot-1');
    // Los registros del procedimiento no incluyen datos de clientes ni de fotos
    expect(logs.join('\n')).not.toContain('veh-1');
    // No quedan fotos en claro en la carpeta temporal del sistema
    expect(fs.readdirSync(os.tmpdir()).filter((x) => x.startsWith('fierro-fotos-resp-'))).toEqual([]);
  });

  it('segunda ejecución: baja sólo la foto nueva (las demás no se vuelven a pedir ni a guardar)', async () => {
    const nueva = foto();
    f.push(nueva);
    pedidos.length = 0;
    const base = JSON.parse(fs.readFileSync(path.join(salida1, 'indice.json'), 'utf8'));
    const i2 = await respaldarFotos(opciones({ salida: salida2, indiceBase: base, ahora: new Date('2026-10-25T06:00:00Z') }));
    expect(i2).toMatchObject({ tipo: 'incremental', fotos_total: 6, copiadas: 1, completo_desde: base.completo_desde });
    expect(i2.cadena.map((p: any) => p.tipo)).toEqual(['completo', 'incremental']);
    const archivosPedidos = pedidos.filter((p) => p.includes('/archivo'));
    expect(archivosPedidos).toHaveLength(2); // original + miniatura de la foto nueva y nada más
    expect(archivosPedidos.every((p) => p.includes(nueva.id))).toBe(true);
    expect(fs.statSync(path.join(salida2, i2.cadena[1].nombre)).size).toBeLessThan(fs.statSync(path.join(salida1, i2.cadena[0].nombre)).size);
  });

  it('sin cambios no genera paquete nuevo y conserva la cadena', async () => {
    const base = JSON.parse(fs.readFileSync(path.join(salida2, 'indice.json'), 'utf8'));
    const vacio = path.join(carpeta, 'ejec-vacia');
    const i = await respaldarFotos(opciones({ salida: vacio, indiceBase: base, ahora: new Date('2026-10-26T06:00:00Z') }));
    expect(i).toMatchObject({ tipo: 'sin_cambios', copiadas: 0 });
    expect(i.cadena).toHaveLength(2);
    expect(paquetesDe(vacio)).toHaveLength(0);
  });

  it('una foto eliminada deja de estar vigente y a los 30 días se hace una copia completa nueva', async () => {
    R2.delete(f[0].id);
    const base = JSON.parse(fs.readFileSync(path.join(salida2, 'indice.json'), 'utf8'));
    const i3 = await respaldarFotos(opciones({ salida: salida3, indiceBase: base, ahora: new Date('2026-11-30T06:00:00Z') }));
    expect(i3).toMatchObject({ tipo: 'completo', fotos_total: 5, copiadas: 5, eliminadas_desde_base: 1 });
    expect(i3.cadena).toHaveLength(1);
  });

  it('restaura la cadena (completo + incremental) con la clave privada y descarta lo eliminado después', async () => {
    const indice = JSON.parse(fs.readFileSync(path.join(salida2, 'indice.json'), 'utf8'));
    const paquetes = [...paquetesDe(salida1).map((x) => path.join(salida1, x)), ...paquetesDe(salida2).map((x) => path.join(salida2, x))];
    const destino = path.join(carpeta, 'restaurada');
    const r = await restaurarCadena({ paquetes, clavePrivadaPem: par.privateKey, indice, salida: destino });
    expect(r).toEqual({ fotos: 6, descartadas: 0 });
    expect(verificarCarpeta(destino)).toMatchObject({ total: 6, correctas: 6, faltantes: [], corruptas: [] });
    // Con el índice posterior (una foto eliminada) la restauración no la trae de vuelta
    const posterior = { ...indice, fotos: indice.fotos.filter((x: any) => x.id !== f[0].id) };
    const destino2 = path.join(carpeta, 'restaurada2');
    const r2 = await restaurarCadena({ paquetes, clavePrivadaPem: par.privateKey, indice: posterior, salida: destino2 });
    expect(r2).toEqual({ fotos: 5, descartadas: 1 });
    expect(fs.existsSync(path.join(destino2, rutasDe(f[0]).archivo))).toBe(false);
  });

  it('la restauración falla con otra clave, con un paquete alterado, sin un paquete de la cadena o sobre una carpeta ocupada', async () => {
    const indice = JSON.parse(fs.readFileSync(path.join(salida2, 'indice.json'), 'utf8'));
    const p1 = paquetesDe(salida1).map((x) => path.join(salida1, x));
    const p2 = paquetesDe(salida2).map((x) => path.join(salida2, x));
    await expect(restaurarCadena({ paquetes: [...p1, ...p2], clavePrivadaPem: otra.privateKey, indice, salida: path.join(carpeta, 'r-otra') })).rejects.toThrow();
    await expect(restaurarCadena({ paquetes: p1, clavePrivadaPem: par.privateKey, indice, salida: path.join(carpeta, 'r-falta') })).rejects.toThrow(/Falta el paquete/);
    const copia = path.join(carpeta, 'copia-alterada');
    fs.mkdirSync(copia);
    const alt = path.join(copia, path.basename(p2[0]));
    const b = fs.readFileSync(p2[0]);
    b[b.length - 40] ^= 0xff;
    fs.writeFileSync(alt, b);
    await expect(restaurarCadena({ paquetes: [...p1, alt], clavePrivadaPem: par.privateKey, indice, salida: path.join(carpeta, 'r-alt') })).rejects.toThrow(/no coincide|alterado/);
    const ocupada = path.join(carpeta, 'ocupada');
    fs.mkdirSync(ocupada);
    fs.writeFileSync(path.join(ocupada, 'algo.txt'), 'x');
    await expect(restaurarCadena({ paquetes: [...p1, ...p2], clavePrivadaPem: par.privateKey, indice, salida: ocupada })).rejects.toThrow(/no está vacía/);
  });

  it('si una foto no baja o su hash no coincide con D1, no se publica ningún respaldo', async () => {
    const mala = foto();
    mala._a = Buffer.from('CORRUPTA'); // R2 devuelve otra cosa que lo que dice D1
    const base = JSON.parse(fs.readFileSync(path.join(salida2, 'indice.json'), 'utf8'));
    const dir = path.join(carpeta, 'ejec-mala');
    await expect(respaldarFotos(opciones({ salida: dir, indiceBase: base, ahora: new Date('2026-10-27T06:00:00Z') }))).rejects.toThrow(/No se pudieron bajar/);
    expect(fs.existsSync(dir) ? paquetesDe(dir) : []).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'indice.json'))).toBe(false);
    expect(fs.readdirSync(os.tmpdir()).filter((x) => x.startsWith('fierro-fotos-resp-'))).toEqual([]);
    R2.delete(mala.id);
  });

  it('con el bucket vacío hace igual una copia completa (vacía) y deja el índice, que es lo que pasa en la primera ejecución real', async () => {
    const copia = new Map(R2);
    R2.clear();
    try {
      const dir = path.join(carpeta, 'ejec-vacio');
      const i = await respaldarFotos(opciones({ salida: dir, indiceBase: null, ahora: new Date('2026-10-28T06:00:00Z') }));
      expect(i).toMatchObject({ tipo: 'completo', fotos_total: 0, copiadas: 0 });
      expect(paquetesDe(dir)).toHaveLength(1);
      const restaurada = path.join(carpeta, 'restaurada-vacia');
      expect(await restaurarCadena({ paquetes: [path.join(dir, paquetesDe(dir)[0])], clavePrivadaPem: par.privateKey, indice: i, salida: restaurada })).toEqual({ fotos: 0, descartadas: 0 });
    } finally {
      for (const [k, v] of copia) R2.set(k, v);
    }
  });

  it('un token equivocado no obtiene nada', async () => {
    await expect(respaldarFotos(opciones({ token: 'otro', salida: path.join(carpeta, 'ejec-401'), indiceBase: null }))).rejects.toThrow(/401/);
  });
});
