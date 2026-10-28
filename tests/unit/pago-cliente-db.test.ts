// Sprint 25 · comprobantes y almacenamiento R2: qué pasa cuando se corta la subida. Se ejecuta el código real de `lib/pago-cliente.ts` sobre SQLite en memoria con TODAS las
// migraciones y un bucket falso, para poder provocar los fallos que un servidor real no permite (R2 caído, corte entre D1 y R2, borrado fallido).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { limpiarComprobantes, recibirComprobante, finanzasOrden } from '../../worker/lib/pago-cliente';
import { claveComprobante } from '../../worker/lib/comprobantes';
import { jpeg } from '../fixtures/archivos';

const RAIZ = path.resolve(__dirname, '../..');
let DatabaseSync: any = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  /* Node sin node:sqlite: se omite */
}

/** D1 mínima sobre node:sqlite (prepare/bind/first/all/run/batch con transacción), suficiente para el código bajo prueba. */
function d1(db: any): D1Database {
  const prep = (sql: string) => {
    let params: unknown[] = [];
    const st: any = {
      bind: (...p: unknown[]) => ((params = p), st),
      first: async () => (db.prepare(sql).get(...params) as any) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...params) }),
      run: async () => ({ meta: { changes: db.prepare(sql).run(...params).changes } }),
      _run: () => db.prepare(sql).run(...params),
    };
    return st;
  };
  return {
    prepare: prep,
    batch: async (stmts: any[]) => {
      db.exec('BEGIN');
      try {
        for (const s of stmts) s._run();
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return [];
    },
  } as unknown as D1Database;
}

function bucketFalso(opciones: { fallaPut?: boolean; fallaDelete?: boolean } = {}) {
  const objetos = new Map<string, Uint8Array>();
  const b = {
    objetos,
    put: async (k: string, v: Uint8Array) => {
      if (opciones.fallaPut) throw new Error('R2 caído');
      objetos.set(k, v);
    },
    delete: async (k: string | string[]) => {
      if (opciones.fallaDelete) throw new Error('R2 caído');
      for (const x of Array.isArray(k) ? k : [k]) objetos.delete(x);
    },
  };
  return b as typeof b & R2Bucket;
}

function nuevaBase() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const m of fs.readdirSync(path.join(RAIZ, 'migrations')).sort()) db.exec(fs.readFileSync(path.join(RAIZ, 'migrations', m), 'utf8'));
  db.exec(`
    INSERT INTO talleres (id, nombre) VALUES ('t1', 'Taller Uno');
    INSERT INTO clientes (id, taller_id, codigo, nombre) VALUES ('c1', 't1', 1, 'Juan');
    INSERT INTO vehiculos (id, taller_id, patente) VALUES ('v1', 't1', 'AE123BC');
    INSERT INTO ordenes (id, taller_id, numero, cliente_id, vehiculo_id, fecha_ingreso, total) VALUES ('o1', 't1', 1, 'c1', 'v1', '2026-10-01', 28500000);
    INSERT INTO cuentas_bancarias (id, taller_id, nombre, banco, alias, titular, saldo_inicial, publica_en_portal) VALUES ('cb1', 't1', 'Banco Uno', 'Banco', 'taller.uno', 'Taller Uno SRL', 0, 1);
    INSERT INTO pago_importe_ot (taller_id, orden_id, importe_al_informar) VALUES ('t1', 'o1', 28500000);
  `);
  return db;
}

const filas = (db: any, sql: string) => db.prepare(sql).all().map((r: any) => ({ ...r })) as any[];
const CTX = { tallerId: 't1', ordenId: 'o1' };

describe.skipIf(!DatabaseSync)('comprobantes: cortes y limpieza', () => {
  it('flujo normal: reserva en D1, guarda en R2 con la clave interna y queda «pendiente»', async () => {
    const db = nuevaBase();
    const bucket = bucketFalso();
    const r = await recibirComprobante({ DB: d1(db), FIERRO_FOTOS: bucket }, CTX, { bytes: jpeg(), nombre: '../x/captura.jpg' }, 'clave-de-envio-0001');
    expect(r).toBe('comprobante_ok');
    const [c] = filas(db, 'SELECT id, estado, mime, taller_id, orden_id, nombre FROM pago_comprobantes');
    expect(c).toMatchObject({ estado: 'pendiente', mime: 'image/jpeg', taller_id: 't1', orden_id: 'o1', nombre: 'captura.jpg' });
    expect([...bucket.objetos.keys()]).toEqual([claveComprobante('t1', c.id)]);
    // se registró la elección de transferencia que implica enviar un comprobante
    expect(filas(db, 'SELECT medio, estado, importe_pendiente FROM pago_elecciones')).toEqual([{ medio: 'transferencia', estado: 'seleccionado', importe_pendiente: 28500000 }]);
    expect(filas(db, 'SELECT COUNT(*) AS n FROM cobros')[0].n).toBe(0);
    expect((await finanzasOrden(d1(db), 't1', 'o1'))!.pendiente).toBe(28500000);
  });

  it('si R2 falla al guardar: se deshace la reserva, no queda ninguna fila ni objeto y el cliente puede reintentar con la misma clave', async () => {
    const db = nuevaBase();
    const caido = bucketFalso({ fallaPut: true });
    expect(await recibirComprobante({ DB: d1(db), FIERRO_FOTOS: caido }, CTX, { bytes: jpeg(), nombre: 'a.jpg' }, 'clave-de-envio-0002')).toBe('e_almacenamiento');
    expect(filas(db, 'SELECT * FROM pago_comprobantes')).toEqual([]);
    expect(caido.objetos.size).toBe(0);
    // sin ningún cobro, ninguna elección y ningún rastro de «pendiente»
    expect(filas(db, 'SELECT COUNT(*) AS n FROM pago_elecciones')[0].n).toBe(0);
    const sano = bucketFalso();
    expect(await recibirComprobante({ DB: d1(db), FIERRO_FOTOS: sano }, CTX, { bytes: jpeg(), nombre: 'a.jpg' }, 'clave-de-envio-0002')).toBe('comprobante_ok');
    expect(filas(db, 'SELECT estado FROM pago_comprobantes')).toEqual([{ estado: 'pendiente' }]);
  });

  it('sin bucket configurado no se acepta nada (y no se rompe el resto)', async () => {
    const db = nuevaBase();
    expect(await recibirComprobante({ DB: d1(db) }, CTX, { bytes: jpeg(), nombre: 'a.jpg' }, 'clave-de-envio-0003')).toBe('e_almacenamiento');
    expect(filas(db, 'SELECT * FROM pago_comprobantes')).toEqual([]);
    expect(await limpiarComprobantes(d1(db), undefined)).toEqual({ limpiados: 0 });
  });

  it('limpieza de huérfanos: una subida cortada hace más de una hora se borra de R2 y de D1; lo reciente y lo recibido no se toca', async () => {
    const db = nuevaBase();
    const bucket = bucketFalso();
    const comp = (id: string, estado: string, creado: string) =>
      db.exec(`INSERT INTO pago_comprobantes (id, taller_id, orden_id, estado, idem_key, mime, bytes, sha256, importe_total, importe_pendiente, created_at)
               VALUES ('${id}', 't1', 'o1', '${estado}', 'k-${id}', 'image/jpeg', 10, 'h-${id}', 28500000, 28500000, '${creado}')`);
    const hace = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    comp('viejo', 'subiendo', hace(180));
    comp('reciente', 'subiendo', hace(5));
    comp('recibido', 'pendiente', hace(600));
    for (const id of ['viejo', 'reciente', 'recibido']) await bucket.put(claveComprobante('t1', id), new Uint8Array([1]));
    await bucket.put(claveComprobante('t1', 'huerfano-sin-fila'), new Uint8Array([1])); // sin fila que lo explique: no se toca (no se listan objetos, sólo se borran los que tienen fila)

    expect(await limpiarComprobantes(d1(db), bucket)).toEqual({ limpiados: 1 });
    expect(filas(db, 'SELECT id, estado FROM pago_comprobantes ORDER BY id')).toEqual([{ id: 'recibido', estado: 'pendiente' }, { id: 'reciente', estado: 'subiendo' }]);
    expect([...bucket.objetos.keys()].sort()).toEqual([claveComprobante('t1', 'huerfano-sin-fila'), claveComprobante('t1', 'recibido'), claveComprobante('t1', 'reciente')].sort());
  });

  it('si el borrado en R2 falla, la fila se conserva para reintentar (nunca queda un objeto sin fila que lo explique)', async () => {
    const db = nuevaBase();
    db.exec(`INSERT INTO pago_comprobantes (id, taller_id, orden_id, estado, idem_key, mime, bytes, sha256, importe_total, importe_pendiente, created_at)
             VALUES ('viejo', 't1', 'o1', 'subiendo', 'k-viejo', 'image/jpeg', 10, 'h', 28500000, 28500000, '2020-01-01T00:00:00.000Z')`);
    const caido = bucketFalso({ fallaDelete: true });
    await caido.put(claveComprobante('t1', 'viejo'), new Uint8Array([1]));
    expect(await limpiarComprobantes(d1(db), caido)).toEqual({ limpiados: 0 });
    expect(filas(db, 'SELECT id FROM pago_comprobantes')).toEqual([{ id: 'viejo' }]);
    const sano = bucketFalso();
    await sano.put(claveComprobante('t1', 'viejo'), new Uint8Array([1]));
    expect(await limpiarComprobantes(d1(db), sano)).toEqual({ limpiados: 1 });
    expect(filas(db, 'SELECT id FROM pago_comprobantes')).toEqual([]);
    expect(sano.objetos.size).toBe(0);
  });

  it('los límites se aplican dentro de la transacción: con 3 pendientes no entra un cuarto aunque se omita la comprobación previa', async () => {
    const db = nuevaBase();
    const bucket = bucketFalso();
    const codigos: string[] = [];
    for (let i = 0; i < 5; i++) codigos.push(await recibirComprobante({ DB: d1(db), FIERRO_FOTOS: bucket }, CTX, { bytes: jpeg(200 + i * 13, false), nombre: `a${i}.jpg` }, `clave-de-envio-10${i}`));
    expect(codigos).toEqual(['comprobante_ok', 'comprobante_ok', 'comprobante_ok', 'e_pendientes', 'e_pendientes']);
    expect(filas(db, 'SELECT COUNT(*) AS n FROM pago_comprobantes')[0].n).toBe(3);
    expect(bucket.objetos.size).toBe(3);
  });
});
