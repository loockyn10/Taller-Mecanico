// Herramientas de respaldo: verificación (ensayo de restauración) y exportación de UN taller sin secretos ni datos ajenos.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error módulo JS de scripts
import { aCsv, cargarRespaldo, ensayarMigraciones, escribirExportacion, exportarTaller, haySqlite, TABLAS_EXCLUIDAS, tablasDe, verificarRespaldo } from '../../scripts/respaldo-lib.mjs';

const RAIZ = path.resolve(__dirname, '../..');

/** Arma un volcado .sql con todas las migraciones y datos de dos talleres, como lo haría `wrangler d1 export`. */
function volcado(): string {
  const migraciones = fs.readdirSync(path.join(RAIZ, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  const partes = [
    "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);",
    ...migraciones.map((m) => fs.readFileSync(path.join(RAIZ, 'migrations', m), 'utf8')),
    ...migraciones.map((m) => `INSERT INTO d1_migrations (name) VALUES ('${m}');`),
    `INSERT INTO talleres (id, nombre) VALUES ('tA', 'Taller A'), ('tB', 'Taller B');`,
    `INSERT INTO usuarios (id, taller_id, email, nombre, rol, plantilla, password_hash, pin_hash) VALUES ('uA', 'tA', 'a@a.com', 'Dueño A', 'propietario', 'propietario', 'HASH-SECRETO-A', 'PIN-SECRETO-A'), ('uB', 'tB', 'b@b.com', 'Dueño B', 'propietario', 'propietario', 'HASH-SECRETO-B', NULL);`,
    `INSERT INTO sesiones (token_hash, usuario_id, taller_id, expires_at) VALUES ('TOKEN-SECRETO', 'uA', 'tA', '2030-01-01T00:00:00Z');`,
    `INSERT INTO clientes (id, taller_id, codigo, nombre, telefono) VALUES ('cA1', 'tA', 1, 'Cliente A1', '=cmd|calc'), ('cA2', 'tA', 2, 'Cliente, "con comas"', '1111'), ('cB1', 'tB', 1, 'Cliente de B', '2222');`,
    `INSERT INTO proveedores (id, taller_id, nombre) VALUES ('pA', 'tA', 'Proveedor A'), ('pB', 'tB', 'Proveedor B');`,
  ];
  return partes.join('\n');
}

describe.skipIf(!haySqlite())('respaldo y exportación', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fierro-respaldo-test-'));
  const archivo = path.join(dir, 'respaldo.sql');
  fs.writeFileSync(archivo, volcado());

  it('el ensayo de restauración carga el respaldo y informa integridad, claves foráneas, migraciones y talleres', () => {
    const db = cargarRespaldo(archivo);
    const migraciones = fs.readdirSync(path.join(RAIZ, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    const v = verificarRespaldo(db, { migracionesDelProyecto: migraciones });
    expect(v.integridadOk).toBe(true);
    expect(v.violacionesClaves).toBe(0);
    expect(v.migracionesPendientes).toEqual([]);
    expect(v.talleres.map((t: any) => t.nombre)).toEqual(['Taller A', 'Taller B']);
    expect(v.tablas.find((t: any) => t.tabla === 'clientes').filas).toBe(3);
    // un proyecto con una migración más reciente que el respaldo lo advierte
    expect(verificarRespaldo(db, { migracionesDelProyecto: [...migraciones, '9999_futura.sql'] }).migracionesPendientes).toEqual(['9999_futura.sql']);
    db.close();
  });

  it('detecta un respaldo con claves foráneas rotas', () => {
    const roto = path.join(dir, 'roto.sql');
    fs.writeFileSync(roto, `${volcado()}\nINSERT INTO proveedores (id, taller_id, nombre) VALUES ('pX', 'tNoExiste', 'Huérfano');`);
    const db = cargarRespaldo(roto);
    expect(verificarRespaldo(db).violacionesClaves).toBeGreaterThan(0);
    db.close();
  });

  it('la exportación de un taller trae solo sus filas, sin credenciales y sin tablas de la plataforma', () => {
    const db = cargarRespaldo(archivo);
    const exp = exportarTaller(db, 'tA');
    expect(exp.taller).toEqual({ id: 'tA', nombre: 'Taller A' });
    expect(exp.datos.clientes.map((c: any) => c.id)).toEqual(['cA1', 'cA2']);
    expect(exp.datos.proveedores.map((c: any) => c.id)).toEqual(['pA']);
    expect(exp.datos.talleres).toHaveLength(1);
    expect(exp.datos.usuarios).toHaveLength(1);
    // ni una fila de otro taller en ninguna tabla
    for (const [tabla, filas] of Object.entries(exp.datos) as Array<[string, any[]]>) {
      if (tabla === 'talleres') continue;
      expect(filas.every((f) => f.taller_id === 'tA'), tabla).toBe(true);
    }
    // sin secretos
    const texto = JSON.stringify(exp.datos);
    for (const secreto of ['HASH-SECRETO-A', 'HASH-SECRETO-B', 'PIN-SECRETO-A', 'TOKEN-SECRETO', 'Cliente de B', 'Proveedor B', 'Dueño B']) expect(texto, secreto).not.toContain(secreto);
    expect(Object.keys(exp.datos.usuarios[0])).not.toContain('password_hash');
    for (const t of TABLAS_EXCLUIDAS.keys()) expect(Object.keys(exp.datos)).not.toContain(t);
    expect(exp.omitidas.map((o: any) => o.tabla)).toEqual(expect.arrayContaining(['sesiones', 'invitaciones_activacion', 'd1_migrations']));
    expect(exp.sinTaller).toEqual([]); // hoy toda tabla de negocio tiene taller_id
    db.close();
  });

  it('una tabla de negocio sin taller_id no se exporta a ciegas', () => {
    const extra = path.join(dir, 'extra.sql');
    fs.writeFileSync(extra, `${volcado()}\nCREATE TABLE tabla_nueva (id TEXT PRIMARY KEY, dato TEXT);\nINSERT INTO tabla_nueva VALUES ('1', 'de cualquiera');`);
    const db = cargarRespaldo(extra);
    const exp = exportarTaller(db, 'tA');
    expect(exp.sinTaller).toEqual(['tabla_nueva']);
    expect(exp.datos.tabla_nueva).toBeUndefined();
    db.close();
  });

  it('un taller inexistente falla y la carpeta de salida no se pisa', () => {
    const db = cargarRespaldo(archivo);
    expect(() => exportarTaller(db, 'tZ')).toThrow(/no existe/);
    const exp = exportarTaller(db, 'tB');
    const salida = path.join(dir, 'salida-b');
    const r = escribirExportacion(exp, salida, { origenSha256: 'abc' });
    expect(r.manifiesto.totalFilas).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(salida, 'tablas', 'clientes.json'))).toBe(true);
    expect(fs.existsSync(path.join(salida, 'tablas', 'clientes.csv'))).toBe(true);
    expect(fs.readFileSync(path.join(salida, 'LEEME.txt'), 'utf8')).toContain('NO es un respaldo restaurable');
    const todo = fs.readdirSync(path.join(salida, 'tablas')).map((f) => fs.readFileSync(path.join(salida, 'tablas', f), 'utf8')).join('\n');
    expect(todo).not.toContain('Taller A');
    expect(todo).not.toContain('HASH-SECRETO');
    expect(() => escribirExportacion(exp, salida)).toThrow(/no se pisa nada/);
    db.close();
  });


  it('el ensayo de migraciones demuestra que los datos existentes quedan idénticos y detecta una migración que los toca', () => {
    const migraciones = fs.readdirSync(path.join(RAIZ, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    const previas = migraciones.filter((m) => m < '0012');
    const nueva = migraciones.find((m) => m.startsWith('0012'))!;
    const sql = [
      ...previas.map((m) => fs.readFileSync(path.join(RAIZ, 'migrations', m), 'utf8')),
      `INSERT INTO talleres (id, nombre) VALUES ('tA', 'Taller A');`,
      `INSERT INTO proveedores (id, taller_id, nombre) VALUES ('pA', 'tA', 'Proveedor A');`,
      `INSERT INTO contab_config (taller_id) VALUES ('tA');`,
    ].join('\n');
    const previo = path.join(dir, 'previo.sql');
    fs.writeFileSync(previo, sql);
    const db = cargarRespaldo(previo);
    const ok = ensayarMigraciones(db, [{ name: nueva, sql: fs.readFileSync(path.join(RAIZ, 'migrations', nueva), 'utf8') }]);
    expect(ok.ok).toBe(true);
    expect(ok.cambios).toEqual([]);
    expect(ok.nuevas).toEqual(expect.arrayContaining(['aperturas_saldos', 'aperturas_saldos_items']));
    expect(ok.columnasNuevas.find((c: any) => c.tabla === 'contab_config').columnas).toContain('sync_bloqueo_hasta');
    db.close();
    // una migración que modifica datos existentes se detecta
    const db2 = cargarRespaldo(previo);
    const mala = ensayarMigraciones(db2, [{ name: '9999_mala.sql', sql: "UPDATE proveedores SET nombre = 'Cambiado' WHERE id = 'pA';" }]);
    expect(mala.ok).toBe(false);
    expect(mala.cambios).toEqual([{ tabla: 'proveedores', motivo: expect.stringContaining('cambió el contenido') }]);
    // y una que falla se informa
    const db3 = cargarRespaldo(previo);
    expect(ensayarMigraciones(db3, [{ name: '9998_rota.sql', sql: 'ESTO NO ES SQL;' }]).errores[0]).toContain('9998_rota.sql');
    db2.close();
    db3.close();
  });

  it('el ensayo de la 0019 (reconstruye vehiculos y quita cliente_id) exige declarar la columna quitada y compara el resto fila por fila', () => {
    const migraciones = fs.readdirSync(path.join(RAIZ, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    const nueva = migraciones.find((m) => m.startsWith('0019'))!;
    const sql = [
      ...migraciones.filter((m) => m < '0019').map((m) => fs.readFileSync(path.join(RAIZ, 'migrations', m), 'utf8')),
      `INSERT INTO talleres (id, nombre) VALUES ('tA', 'Taller A');`,
      `INSERT INTO clientes (id, taller_id, codigo, nombre) VALUES ('c1', 'tA', 1, 'Juan'), ('c2', 'tA', 2, 'María');`,
      `INSERT INTO vehiculos (id, taller_id, cliente_id, patente, km_actual) VALUES ('v1', 'tA', 'c1', 'AA111AA', 10), ('v2', 'tA', 'c2', 'BB222BB', 20);`,
      `INSERT INTO ordenes (id, taller_id, numero, cliente_id, vehiculo_id, fecha_ingreso) VALUES ('o1', 'tA', 1, 'c2', 'v1', '2026-10-01');`,
    ].join('\n');
    const previo = path.join(dir, 'previo-0019.sql');
    fs.writeFileSync(previo, sql);
    const pendientes = [{ name: nueva, sql: fs.readFileSync(path.join(RAIZ, 'migrations', nueva), 'utf8') }];
    // Sin declarar la columna que desaparece, el ensayo falla (no se pierde nada sin que alguien lo decida).
    const db1 = cargarRespaldo(previo);
    const sinPermiso = ensayarMigraciones(db1, pendientes);
    expect(sinPermiso.ok).toBe(false);
    expect(sinPermiso.cambios).toEqual([{ tabla: 'vehiculos', motivo: 'desapareció la columna cliente_id' }]);
    db1.close();
    // Declarada, el resto de las columnas queda idéntico, hay 2 vínculos vigentes y la base es íntegra con las claves foráneas activas.
    const db2 = cargarRespaldo(previo);
    const ok = ensayarMigraciones(db2, pendientes, { quitadasPermitidas: ['vehiculos.cliente_id'] });
    expect(ok.errores).toEqual([]);
    expect(ok.ok).toBe(true);
    expect(ok.columnasQuitadas).toEqual(['vehiculos.cliente_id']);
    expect(ok.nuevas).toEqual(['vehiculo_clientes']);
    expect(db2.prepare('SELECT COUNT(*) AS n FROM vehiculo_clientes WHERE desvinculado_at IS NULL').get().n).toBe(2);
    expect(db2.prepare("SELECT cliente_id FROM ordenes WHERE id = 'o1'").get().cliente_id).toBe('c2'); // la OT conserva su cliente
    db2.close();
  });

  it('el CSV neutraliza fórmulas y escapa comas y comillas', () => {
    const csv = aCsv([{ a: '=cmd|calc', b: 'dice "hola", chau', c: -500, d: null }]);
    expect(csv).toContain("'=cmd|calc");
    expect(csv).toContain('"dice ""hola"", chau"');
    expect(csv).toContain(',-500,');
    expect(tablasDe).toBeTypeOf('function');
  });
});
