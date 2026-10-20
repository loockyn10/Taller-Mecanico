// Las migraciones 0002+ deben aplicarse sobre datos existentes sin perder nada (la base remota ya tiene la 0001 con datos).
// Se ejecutan sobre SQLite en memoria (D1 es SQLite): no depende del servidor de desarrollo ni toca ninguna base real.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const RAIZ = path.resolve(__dirname, '../..');
const leer = (...p: string[]) => fs.readFileSync(path.join(RAIZ, ...p), 'utf8');

let DatabaseSync: any = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  /* Node sin node:sqlite: la prueba se omite */
}

describe.skipIf(!DatabaseSync)('migraciones sobre datos existentes', () => {
  it('conservan los datos, normalizan el stock y asientan cobros y pagos vigentes en el libro de caja', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(leer('migrations', '0001_init.sql'));
    db.exec(leer('tests', 'fixtures', 'datos-previos-0002.sql'));
    for (const m of fs.readdirSync(path.join(RAIZ, 'migrations')).filter((f) => !f.startsWith('0001')).sort()) db.exec(leer('migrations', m));
    const uno = (sql: string) => db.prepare(sql).get() as Record<string, any>;
    const todos = (sql: string) => db.prepare(sql).all() as Array<Record<string, any>>;

    expect({ ...uno("SELECT stock, stock_minimo FROM articulos WHERE id = 'a1'") }).toEqual({ stock: 0.2, stock_minimo: 0.3 });
    // Cobros vigentes (dos medios) y pagos vigentes pasan al libro; lo anulado antes de la migración no genera movimiento.
    expect({ ...uno("SELECT COUNT(*) AS n, SUM(importe) AS t FROM caja_movimientos WHERE rubro = 'cobro' AND sesion_id IS NULL") }).toEqual({ n: 2, t: 10000 });
    expect({ ...uno("SELECT COUNT(*) AS n, SUM(importe) AS t FROM caja_movimientos WHERE rubro = 'pago_proveedor'") }).toEqual({ n: 1, t: 2000 });
    expect(uno("SELECT COUNT(*) AS n FROM caja_movimientos WHERE origen_id = 'cm3'").n).toBe(0);
    // Cada taller existente recibe sus categorías de gasto
    expect(todos('SELECT taller_id, COUNT(*) AS n FROM categorias_gasto GROUP BY taller_id ORDER BY taller_id').map((r) => ({ ...r }))).toEqual([{ taller_id: 't1', n: 11 }, { taller_id: 't2', n: 11 }]);
    // Nada se perdió y los saldos son los mismos
    expect({ ...uno('SELECT (SELECT COUNT(*) FROM ventas) AS ventas, (SELECT COUNT(*) FROM cobros) AS cobros, (SELECT SUM(total - cobrado) FROM ventas) AS saldo') }).toEqual({ ventas: 2, cobros: 2, saldo: 5000 });
    // La caja no es obligatoria por defecto: el comportamiento de los talleres existentes no cambia
    expect(uno("SELECT caja_obligatoria FROM taller_config WHERE taller_id = 't1'").caja_obligatoria).toBe(0);
    // Integridad referencial intacta tras migrar
    expect(todos('PRAGMA foreign_key_check')).toEqual([]);
    // El libro impide registrar dos veces el mismo hecho de origen (antiduplicación a nivel base)
    expect(() => db.exec("INSERT INTO caja_movimientos (id, taller_id, tipo, rubro, medio, importe, concepto, origen_tipo, origen_id, fecha) VALUES ('dup', 't1', 'ingreso', 'cobro', 'efectivo', 1, 'dup', 'cobro', 'cm1', '2026-05-01')")).toThrow(/UNIQUE/);
    db.close();
  });
});
