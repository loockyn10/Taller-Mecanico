// Migración 0021 (Sprint 25): pago del cliente desde el portal. Se ensaya sobre SQLite en memoria (D1 es SQLite) con datos como los de producción:
// es expansiva (no toca ningún dato ni reconstruye tablas) y la base protege comprobantes, elecciones y la cuenta publicada en el portal.
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

describe.skipIf(!DatabaseSync)('migración 0021', () => {
  it('es expansiva: no toca ningún dato (ni cobros, caja, bancos ni órdenes), las cuentas quedan sin publicar y la base protege comprobantes, elecciones y la cuenta del portal', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const m of fs.readdirSync(path.join(RAIZ, 'migrations')).sort().filter((x) => x < '0021')) db.exec(leer('migrations', m));
    const uno = (sql: string) => db.prepare(sql).get() as Record<string, any>;
    const todos = (sql: string) => db.prepare(sql).all().map((r: any) => ({ ...r })) as Array<Record<string, any>>;
    // Datos como los de producción: dos talleres, clientes, vehículos, órdenes y cobros por transferencia.
    db.exec(`
      INSERT INTO talleres (id, nombre) VALUES ('t1', 'Taller Uno'), ('t2', 'Taller Dos');
      INSERT INTO usuarios (id, taller_id, email, nombre, rol, plantilla, password_hash) VALUES ('u1', 't1', 'a@a.com', 'Dueño', 'propietario', 'propietario', 'x');
      INSERT INTO clientes (id, taller_id, codigo, nombre) VALUES ('c1', 't1', 1, 'Juan'), ('c2', 't2', 1, 'Ajeno');
      INSERT INTO vehiculos (id, taller_id, patente) VALUES ('v1', 't1', 'AE123BC'), ('v2', 't2', 'AA111AA');
      INSERT INTO ordenes (id, taller_id, numero, cliente_id, vehiculo_id, fecha_ingreso, total) VALUES ('o1', 't1', 1, 'c1', 'v1', '2026-10-01', 28500000), ('o2', 't2', 1, 'c2', 'v2', '2026-10-01', 100);
      INSERT INTO cuentas_bancarias (id, taller_id, nombre, banco, alias, titular, saldo_inicial) VALUES ('cb1', 't1', 'Banco Uno', 'Banco', 'taller.uno', 'Taller Uno SRL', 0), ('cb2', 't1', 'Banco Dos', 'Banco', 'taller.dos', 'Taller Uno SRL', 0), ('cb3', 't2', 'Ajena', 'Banco', 'ajena', 'Otro', 0);
      INSERT INTO cobros (id, taller_id, numero, cliente_id, fecha, total, idem_key, tipo, orden_id) VALUES ('co1', 't1', 1, 'c1', '2026-10-02', 1000, 'k1', 'anticipo', 'o1'), ('co2', 't1', 2, 'c1', '2026-10-03', 500, 'k2', 'anticipo', 'o1');
      INSERT INTO cobro_medios (id, taller_id, cobro_id, medio, importe, cuenta_id) VALUES ('cm1', 't1', 'co1', 'transferencia', 1000, 'cb1'), ('cm2', 't1', 'co2', 'transferencia', 500, 'cb1');
    `);
    const tablas = ['talleres', 'usuarios', 'clientes', 'vehiculos', 'ordenes', 'cobros', 'cobro_medios', 'caja_movimientos', 'banco_movimientos', 'seguimiento_enlaces'];
    const antes = tablas.map((t) => todos(`SELECT * FROM ${t} ORDER BY 1`));
    const columnas = 'id, taller_id, nombre, banco, tipo, alias, cbu, titular, cuit_titular, moneda, saldo_inicial, activa';
    const cuentasAntes = todos(`SELECT ${columnas} FROM cuentas_bancarias ORDER BY id`);
    // D1 aplica cada migración dentro de una transacción: así se ensaya.
    db.exec('BEGIN');
    db.exec(leer('migrations', '0021_pagos_cliente_portal.sql'));
    db.exec('COMMIT');

    // Nada cambió: mismas filas en todo lo existente; las cuentas conservan todo y ninguna queda publicada.
    expect(tablas.map((t) => todos(`SELECT * FROM ${t} ORDER BY 1`))).toEqual(antes);
    expect(todos(`SELECT ${columnas} FROM cuentas_bancarias ORDER BY id`)).toEqual(cuentasAntes);
    expect(todos('SELECT id, publica_en_portal FROM cuentas_bancarias ORDER BY id')).toEqual([{ id: 'cb1', publica_en_portal: 0 }, { id: 'cb2', publica_en_portal: 0 }, { id: 'cb3', publica_en_portal: 0 }]);
    for (const t of ['pago_importe_ot', 'pago_elecciones', 'pago_comprobantes']) expect(uno(`SELECT COUNT(*) AS n FROM ${t}`).n).toBe(0);
    expect(todos('PRAGMA foreign_key_check')).toEqual([]);
    expect(uno('PRAGMA integrity_check').integrity_check).toBe('ok');
    // El código anterior (que no conoce la columna nueva) sigue pudiendo crear cuentas.
    db.exec("INSERT INTO cuentas_bancarias (id, taller_id, nombre, banco, saldo_inicial) VALUES ('cb4', 't1', 'Compatible', 'Banco', 0)");
    expect(uno("SELECT publica_en_portal FROM cuentas_bancarias WHERE id = 'cb4'").publica_en_portal).toBe(0);

    // Una sola cuenta publicada por taller (otro taller puede tener la suya).
    db.exec("UPDATE cuentas_bancarias SET publica_en_portal = 1 WHERE id = 'cb1'");
    db.exec("UPDATE cuentas_bancarias SET publica_en_portal = 1 WHERE id = 'cb3'");
    expect(() => db.exec("UPDATE cuentas_bancarias SET publica_en_portal = 1 WHERE id = 'cb2'")).toThrow(/UNIQUE/);
    expect(() => db.exec("UPDATE cuentas_bancarias SET publica_en_portal = 2 WHERE id = 'cb2'")).toThrow(/CHECK/);

    // Importe informado: del taller de la orden y mayor que cero.
    db.exec("INSERT INTO pago_importe_ot (taller_id, orden_id, importe_al_informar, informado_por) VALUES ('t1', 'o1', 28500000, 'u1')");
    expect(() => db.exec("INSERT INTO pago_importe_ot (taller_id, orden_id, importe_al_informar) VALUES ('t1', 'o2', 100)")).toThrow(/FOREIGN KEY/); // orden de otro taller
    expect(() => db.exec("INSERT INTO pago_importe_ot (taller_id, orden_id, importe_al_informar) VALUES ('t2', 'o2', 0)")).toThrow(/CHECK/);

    // Elecciones: sólo efectivo o transferencia, con importe; el historial no se reescribe ni se borra.
    const eleccion = (id: string, medio: string, estado = 'seleccionado', orden = 'o1', taller = 't1') =>
      `INSERT INTO pago_elecciones (id, taller_id, orden_id, medio, estado, importe_total, importe_pendiente) VALUES ('${id}', '${taller}', '${orden}', '${medio}', '${estado}', 28500000, 28500000)`;
    db.exec(eleccion('e1', 'efectivo'));
    db.exec(eleccion('e2', 'transferencia'));
    expect(() => db.exec(eleccion('e3', 'tarjeta'))).toThrow(/CHECK/);
    expect(() => db.exec(eleccion('e3', 'efectivo', 'pagado'))).toThrow(/CHECK/);
    expect(() => db.exec(eleccion('e3', 'efectivo', 'seleccionado', 'o2', 't1'))).toThrow(/FOREIGN KEY/);
    expect(() => db.exec("UPDATE pago_elecciones SET medio = 'transferencia' WHERE id = 'e1'")).toThrow(/pago_eleccion_inmutable/);
    expect(() => db.exec("DELETE FROM pago_elecciones WHERE id = 'e1'")).toThrow(/pago_eleccion_inmutable/);

    // Comprobantes.
    const comp = (id: string, orden = 'o1', taller = 't1') =>
      `INSERT INTO pago_comprobantes (id, taller_id, orden_id, idem_key, mime, bytes, sha256, importe_total, importe_pendiente) VALUES ('${id}', '${taller}', '${orden}', 'k-${id}', 'image/jpeg', 1000, 'h', 28500000, 28500000)`;
    db.exec(comp('p1'));
    expect(uno("SELECT estado FROM pago_comprobantes WHERE id = 'p1'").estado).toBe('subiendo');
    expect(() => db.exec(comp('p1'))).toThrow(/UNIQUE/);
    expect(() => db.exec("INSERT INTO pago_comprobantes (id, taller_id, orden_id, idem_key, mime, bytes, sha256, importe_total, importe_pendiente) VALUES ('p2', 't1', 'o1', 'k-p1', 'image/jpeg', 1, 'h', 1, 1)")).toThrow(/UNIQUE/); // misma clave de reintento
    expect(() => db.exec("INSERT INTO pago_comprobantes (id, taller_id, orden_id, idem_key, mime, bytes, sha256, importe_total, importe_pendiente) VALUES ('p2', 't1', 'o1', 'k2', 'image/gif', 1, 'h', 1, 1)")).toThrow(/CHECK/); // sólo JPG, PNG, WEBP y PDF
    expect(() => db.exec("INSERT INTO pago_comprobantes (id, taller_id, orden_id, idem_key, mime, bytes, sha256, importe_total, importe_pendiente) VALUES ('p2', 't1', 'o1', 'k2', 'image/jpeg', 0, 'h', 1, 1)")).toThrow(/CHECK/);
    expect(() => db.exec(comp('p3', 'o2', 't1'))).toThrow(/FOREIGN KEY/); // orden de otro taller
    // Estados válidos: pendiente → confirmado (con cobro) o rechazado (con motivo); nada sin sus datos.
    db.exec("UPDATE pago_comprobantes SET estado = 'pendiente' WHERE id = 'p1'");
    expect(() => db.exec("UPDATE pago_comprobantes SET estado = 'rechazado', revisado_at = '2026-10-28T10:00:00Z' WHERE id = 'p1'")).toThrow(/CHECK/); // sin motivo
    expect(() => db.exec("UPDATE pago_comprobantes SET estado = 'confirmado', revisado_at = '2026-10-28T10:00:00Z' WHERE id = 'p1'")).toThrow(/CHECK/); // sin cobro
    expect(() => db.exec("UPDATE pago_comprobantes SET estado = 'confirmado', cobro_id = 'inexistente', importe_confirmado = 1, vinculo = 'nuevo', revisado_at = '2026-10-28T10:00:00Z' WHERE id = 'p1'")).toThrow(/FOREIGN KEY/);
    expect(() => db.exec("UPDATE pago_comprobantes SET sha256 = 'otro' WHERE id = 'p1'")).toThrow(/pago_comprobante_inmutable/);
    expect(() => db.exec("UPDATE pago_comprobantes SET orden_id = 'o2' WHERE id = 'p1'")).toThrow(/pago_comprobante_inmutable/);
    expect(() => db.exec("DELETE FROM pago_comprobantes WHERE id = 'p1'")).toThrow(/pago_comprobante_inmutable/); // recibido: es parte del historial
    db.exec("UPDATE pago_comprobantes SET estado = 'confirmado', cobro_id = 'co1', importe_confirmado = 1000, vinculo = 'existente', revisado_por = 'u1', revisado_at = '2026-10-28T10:00:00Z' WHERE id = 'p1'");
    expect(() => db.exec("UPDATE pago_comprobantes SET estado = 'rechazado', motivo_rechazo = 'cambié de idea', revisado_at = '2026-10-28T11:00:00Z' WHERE id = 'p1'")).toThrow(/pago_comprobante_resuelto/);
    // Un cobro respalda a lo sumo un comprobante.
    db.exec(comp('p4'));
    db.exec("UPDATE pago_comprobantes SET estado = 'pendiente' WHERE id = 'p4'");
    expect(() => db.exec("UPDATE pago_comprobantes SET estado = 'confirmado', cobro_id = 'co1', importe_confirmado = 1, vinculo = 'existente', revisado_at = '2026-10-28T10:00:00Z' WHERE id = 'p4'")).toThrow(/UNIQUE/);
    db.exec("UPDATE pago_comprobantes SET estado = 'rechazado', motivo_rechazo = 'No figura', revisado_at = '2026-10-28T10:00:00Z' WHERE id = 'p4'");
    // Una subida cortada (nunca recibida) sí se puede limpiar.
    db.exec(comp('p5'));
    db.exec("DELETE FROM pago_comprobantes WHERE id = 'p5'");
    expect(todos('PRAGMA foreign_key_check')).toEqual([]);
    db.close();
  });
});
