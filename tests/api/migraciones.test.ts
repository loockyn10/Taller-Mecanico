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
    // 0005: el libro de caja se reconstruyó sin perder filas, admite traspasos y conserva los índices antiduplicación
    expect(uno('SELECT COUNT(*) AS n FROM caja_movimientos').n).toBe(3);
    db.exec("INSERT INTO caja_movimientos (id, taller_id, tipo, rubro, medio, importe, concepto, origen_tipo, origen_id, fecha) VALUES ('tr1', 't1', 'egreso', 'traspaso', 'efectivo', 100, 'Depósito', 'banco', 'b1', '2026-05-01')");
    expect(() => db.exec("INSERT INTO caja_movimientos (id, taller_id, tipo, rubro, medio, importe, concepto, origen_tipo, origen_id, fecha) VALUES ('tr2', 't1', 'egreso', 'traspaso', 'efectivo', 100, 'Depósito', 'banco', 'b1', '2026-05-01')")).toThrow(/UNIQUE/);
    // 0005: el IVA por defecto de fábrica (nadie guardó la configuración) pasa a 0 para no cambiar importes de documentos nuevos
    expect(uno("SELECT iva_default, medios_pago, tolerancia_caja, plazo_pago_dias FROM taller_config WHERE taller_id = 't1'")).toMatchObject({ iva_default: 0, medios_pago: null, tolerancia_caja: 0, plazo_pago_dias: 30 });
    // 0005: el historial de costos arranca con el costo vigente de cada artículo y los triggers registran los cambios
    expect(uno("SELECT costo_nuevo, origen FROM articulo_costos WHERE articulo_id = 'a1'")).toMatchObject({ costo_nuevo: 1000, origen: 'inicial' });
    db.exec("UPDATE articulos SET costo = 1500 WHERE id = 'a1'");
    expect(todos("SELECT costo_anterior, costo_nuevo FROM articulo_costos WHERE articulo_id = 'a1' ORDER BY id").map((r) => ({ ...r }))).toEqual([{ costo_anterior: null, costo_nuevo: 1000 }, { costo_anterior: 1000, costo_nuevo: 1500 }]);
    // 0005: un cheque no puede repetirse (mismo banco + número + librador) salvo que el anterior esté anulado
    db.exec("INSERT INTO cheques (id, taller_id, numero, direccion, banco, nro_cheque, importe, fecha_emision, fecha_pago, fecha_vencimiento) VALUES ('c1', 't1', 1, 'recibido', 'Banco X', '10', 100, '2026-05-01', '2026-05-01', '2026-05-31')");
    expect(() => db.exec("INSERT INTO cheques (id, taller_id, numero, direccion, banco, nro_cheque, importe, fecha_emision, fecha_pago, fecha_vencimiento) VALUES ('c2', 't1', 2, 'recibido', 'banco x', '10', 100, '2026-05-01', '2026-05-01', '2026-05-31')")).toThrow(/UNIQUE/);
    db.exec("UPDATE cheques SET estado = 'anulado' WHERE id = 'c1'");
    db.exec("INSERT INTO cheques (id, taller_id, numero, direccion, banco, nro_cheque, importe, fecha_emision, fecha_pago, fecha_vencimiento) VALUES ('c2', 't1', 2, 'recibido', 'banco x', '10', 100, '2026-05-01', '2026-05-01', '2026-05-31')");
    // Integridad referencial intacta tras migrar
    expect(todos('PRAGMA foreign_key_check')).toEqual([]);
    // El libro impide registrar dos veces el mismo hecho de origen (antiduplicación a nivel base)
    expect(() => db.exec("INSERT INTO caja_movimientos (id, taller_id, tipo, rubro, medio, importe, concepto, origen_tipo, origen_id, fecha) VALUES ('dup', 't1', 'ingreso', 'cobro', 'efectivo', 1, 'dup', 'cobro', 'cm1', '2026-05-01')")).toThrow(/UNIQUE/);
    db.close();
  });
});
