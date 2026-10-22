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
    // 0006: los usuarios existentes conservan su rol como plantilla, siguen con acceso y la zona horaria por defecto es la argentina
    expect(uno("SELECT rol, plantilla, acceso_erp, permisos_ajustes FROM usuarios WHERE id = 'u1'")).toMatchObject({ rol: 'propietario', plantilla: 'propietario', acceso_erp: 1, permisos_ajustes: null });
    expect(uno("SELECT zona_horaria, reloj_activo FROM taller_config WHERE taller_id = 't1'")).toMatchObject({ zona_horaria: 'America/Argentina/Buenos_Aires', reloj_activo: 0 });
    // 0006: una sola jornada abierta por persona (a nivel base) y las jornadas cerradas no se ven afectadas
    db.exec("INSERT INTO asistencias (id, taller_id, usuario_id, fecha, entrada_at, origen_entrada) VALUES ('as1', 't1', 'u1', '2026-05-01', '2026-05-01T11:00:00Z', 'app')");
    expect(() => db.exec("INSERT INTO asistencias (id, taller_id, usuario_id, fecha, entrada_at, origen_entrada) VALUES ('as2', 't1', 'u1', '2026-05-01', '2026-05-01T11:05:00Z', 'app')")).toThrow(/UNIQUE/);
    db.exec("UPDATE asistencias SET salida_at = '2026-05-01T15:00:00Z', duracion_seg = 14400 WHERE id = 'as1'");
    db.exec("INSERT INTO asistencias (id, taller_id, usuario_id, fecha, entrada_at, origen_entrada) VALUES ('as2', 't1', 'u1', '2026-05-01', '2026-05-01T16:00:00Z', 'app')");
    expect(() => db.exec("UPDATE asistencias SET salida_at = '2026-05-01T10:00:00Z' WHERE id = 'as2'")).toThrow(/CHECK/);
    // Integridad referencial intacta tras migrar
    expect(todos('PRAGMA foreign_key_check')).toEqual([]);
    // El libro impide registrar dos veces el mismo hecho de origen (antiduplicación a nivel base)
    expect(() => db.exec("INSERT INTO caja_movimientos (id, taller_id, tipo, rubro, medio, importe, concepto, origen_tipo, origen_id, fecha) VALUES ('dup', 't1', 'ingreso', 'cobro', 'efectivo', 1, 'dup', 'cobro', 'cm1', '2026-05-01')")).toThrow(/UNIQUE/);
    db.close();
  });

  it('0007 conserva servicios, órdenes y tareas del Sprint 06 y deja la base lista para el tempario y las tareas con estado', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const migraciones = fs.readdirSync(path.join(RAIZ, 'migrations')).sort();
    for (const m of migraciones.filter((f) => f < '0007')) db.exec(leer('migrations', m));
    const uno = (sql: string) => db.prepare(sql).get() as Record<string, any>;
    const todos = (sql: string) => db.prepare(sql).all() as Array<Record<string, any>>;
    // Datos existentes antes del Sprint 07 (como los del Worker online): un taller con servicio, OT y tareas hechas y pendientes.
    db.exec(`
      INSERT INTO talleres (id, nombre) VALUES ('t1', 'Taller Viejo'), ('t2', 'Otro');
      INSERT INTO usuarios (id, taller_id, email, nombre, rol, plantilla, password_hash) VALUES ('u1', 't1', 'a@a.com', 'Dueño', 'propietario', 'propietario', 'x');
      INSERT INTO taller_config (taller_id) VALUES ('t1');
      INSERT INTO clientes (id, taller_id, codigo, nombre) VALUES ('c1', 't1', 1, 'Cliente');
      INSERT INTO vehiculos (id, taller_id, cliente_id, patente, km_actual) VALUES ('v1', 't1', 'c1', 'AAA111', 1000);
      INSERT INTO categorias_servicio (id, taller_id, nombre) VALUES ('cs1', 't1', 'Frenos');
      INSERT INTO servicios (id, taller_id, categoria_id, nombre, precio, intervalo_km) VALUES ('s1', 't1', 'cs1', 'Cambio de pastillas', 4500000, 20000);
      INSERT INTO ordenes (id, taller_id, numero, cliente_id, vehiculo_id, fecha_ingreso) VALUES ('o1', 't1', 1, 'c1', 'v1', '2026-10-01T10:00:00Z');
      INSERT INTO orden_items (id, taller_id, orden_id, tipo, servicio_id, descripcion, cantidad, precio_unitario, subtotal) VALUES ('i1', 't1', 'o1', 'servicio', 's1', 'Cambio de pastillas', 1, 4500000, 4500000);
      INSERT INTO orden_tareas (id, taller_id, orden_id, posicion, descripcion, hecha, hecha_at, hecha_por, creada_por) VALUES ('ta1', 't1', 'o1', 0, 'Cambiar pastillas', 1, '2026-10-02T10:00:00Z', 'u1', 'u1');
      INSERT INTO orden_tareas (id, taller_id, orden_id, posicion, descripcion) VALUES ('ta2', 't1', 'o1', 1, 'Probar frenos');
      INSERT INTO orden_tiempos (id, taller_id, orden_id, usuario_id, inicio_at, fin_at, duracion_seg) VALUES ('ti1', 't1', 'o1', 'u1', '2026-10-02T09:00:00Z', '2026-10-02T10:00:00Z', 3600);
    `);
    db.exec(leer('migrations', migraciones.find((f) => f.startsWith('0007'))!));
    // Nada se perdió: el servicio conserva su precio y pasa a "precio fijo" sin tiempo; las tareas conservan su estado
    expect(uno("SELECT precio, modo_precio, origen, tiempo_min, codigo FROM servicios WHERE id = 's1'")).toMatchObject({ precio: 4500000, modo_precio: 'fijo', origen: 'propio', tiempo_min: null, codigo: null });
    expect(todos('SELECT id, estado, hecha_at, hecha_por, responsable_id FROM orden_tareas ORDER BY id').map((r) => ({ ...r }))).toEqual([
      { id: 'ta1', estado: 'completada', hecha_at: '2026-10-02T10:00:00Z', hecha_por: 'u1', responsable_id: null },
      { id: 'ta2', estado: 'pendiente', hecha_at: null, hecha_por: null, responsable_id: null },
    ]);
    expect(uno("SELECT duracion_seg, tarea_id FROM orden_tiempos WHERE id = 'ti1'")).toMatchObject({ duracion_seg: 3600, tarea_id: null });
    expect(uno("SELECT tarifa_hora FROM taller_config WHERE taller_id = 't1'").tarifa_hora).toBe(0);
    expect(todos('PRAGMA foreign_key_check')).toEqual([]);
    // El cronómetro se puede atribuir a una tarea; al borrar la tarea el tiempo se conserva en la OT
    db.exec("INSERT INTO orden_tiempos (id, taller_id, orden_id, usuario_id, inicio_at, fin_at, duracion_seg, tarea_id) VALUES ('ti2', 't1', 'o1', 'u1', '2026-10-03T09:00:00Z', '2026-10-03T09:30:00Z', 1800, 'ta2')");
    db.exec("DELETE FROM orden_tareas WHERE id = 'ta2'");
    expect(uno("SELECT tarea_id, duracion_seg FROM orden_tiempos WHERE id = 'ti2'")).toMatchObject({ tarea_id: null, duracion_seg: 1800 });
    // Integridad multiempresa: una tarea no puede asignarse a un usuario de otro taller ni a un servicio ajeno
    db.exec("INSERT INTO usuarios (id, taller_id, email, nombre, rol, plantilla, password_hash) VALUES ('u2', 't2', 'b@b.com', 'Otro', 'propietario', 'propietario', 'x')");
    expect(() => db.exec("UPDATE orden_tareas SET responsable_id = 'u2' WHERE id = 'ta1'")).toThrow(/FOREIGN KEY/);
    expect(() => db.exec("INSERT INTO servicio_tiempos (id, taller_id, servicio_id, motor, tiempo_min) VALUES ('r1', 't2', 's1', '1.6', 30)")).toThrow(/FOREIGN KEY/);
    // Reglas de tiempo: al menos un criterio, años coherentes
    expect(() => db.exec("INSERT INTO servicio_tiempos (id, taller_id, servicio_id, tiempo_min) VALUES ('r2', 't1', 's1', 30)")).toThrow(/CHECK/);
    expect(() => db.exec("INSERT INTO servicio_tiempos (id, taller_id, servicio_id, anio_desde, anio_hasta, tiempo_min) VALUES ('r3', 't1', 's1', 2020, 2010, 30)")).toThrow(/CHECK/);
    db.exec("INSERT INTO servicio_tiempos (id, taller_id, servicio_id, motor, tiempo_min) VALUES ('r4', 't1', 's1', '1.6', 30)");
    // Un plan de mantenimiento por vehículo y operación
    db.exec("INSERT INTO vehiculo_mantenimientos (id, taller_id, vehiculo_id, servicio_id) VALUES ('m1', 't1', 'v1', 's1')");
    expect(() => db.exec("INSERT INTO vehiculo_mantenimientos (id, taller_id, vehiculo_id, servicio_id) VALUES ('m2', 't1', 'v1', 's1')")).toThrow(/UNIQUE/);
    // Código de operación único por taller (si está cargado)
    db.exec("UPDATE servicios SET codigo = 'FRE-001' WHERE id = 's1'");
    db.exec("INSERT INTO servicios (id, taller_id, nombre, precio, codigo) VALUES ('s2', 't2', 'Otra', 0, 'FRE-001')");
    expect(() => db.exec("INSERT INTO servicios (id, taller_id, nombre, precio, codigo) VALUES ('s3', 't1', 'Dup', 0, 'FRE-001')")).toThrow(/UNIQUE/);
    db.close();
  });

  it('0008 crea el depósito principal de cada taller con el stock actual, sin perder datos, y deja la base lista para operar por depósito', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const migraciones = fs.readdirSync(path.join(RAIZ, 'migrations')).sort();
    for (const m of migraciones.filter((f) => f < '0008')) db.exec(leer('migrations', m));
    const uno = (sql: string) => db.prepare(sql).get() as Record<string, any>;
    const todos = (sql: string) => db.prepare(sql).all() as Array<Record<string, any>>;
    db.exec(`
      INSERT INTO talleres (id, nombre) VALUES ('t1', 'Taller Viejo'), ('t2', 'Otro');
      INSERT INTO usuarios (id, taller_id, email, nombre, rol, plantilla, password_hash) VALUES ('u1', 't1', 'a@a.com', 'Dueño', 'propietario', 'propietario', 'x');
      INSERT INTO clientes (id, taller_id, codigo, nombre) VALUES ('c1', 't1', 1, 'Cliente');
      INSERT INTO articulos (id, taller_id, codigo, nombre, costo, precio, stock) VALUES ('a1', 't1', 'A1', 'Filtro', 1000, 2000, 7.5), ('a2', 't1', 'A2', 'Aceite', 3000, 5000, 0), ('a3', 't2', 'A1', 'Filtro ajeno', 1000, 2000, 3);
      INSERT INTO stock_movimientos (id, taller_id, articulo_id, tipo, cantidad, stock_resultante) VALUES ('m1', 't1', 'a1', 'entrada', 7.5, 7.5);
      INSERT INTO ventas (id, taller_id, numero, cliente_id, fecha) VALUES ('v1', 't1', 1, 'c1', '2026-10-01');
      INSERT INTO venta_items (id, taller_id, venta_id, tipo, articulo_id, descripcion, cantidad, precio_unitario, subtotal) VALUES ('vi1', 't1', 'v1', 'articulo', 'a1', 'Filtro', 2, 2000, 4000);
    `);
    db.exec(leer('migrations', migraciones.find((f) => f.startsWith('0008'))!));
    // Cada taller recibe exactamente un depósito principal
    expect(todos('SELECT taller_id, nombre, es_principal, activo FROM depositos ORDER BY taller_id').map((r) => ({ ...r }))).toEqual([
      { taller_id: 't1', nombre: 'Depósito principal', es_principal: 1, activo: 1 },
      { taller_id: 't2', nombre: 'Depósito principal', es_principal: 1, activo: 1 },
    ]);
    // El stock de cada artículo pasa al principal de SU taller y la suma coincide con el total
    expect(todos('SELECT articulo_id, stock FROM stock_depositos ORDER BY articulo_id').map((r) => ({ ...r }))).toEqual([{ articulo_id: 'a1', stock: 7.5 }, { articulo_id: 'a2', stock: 0 }, { articulo_id: 'a3', stock: 3 }]);
    expect(uno("SELECT COUNT(*) AS n FROM articulos a WHERE ROUND(a.stock, 3) <> ROUND((SELECT SUM(stock) FROM stock_depositos s WHERE s.taller_id = a.taller_id AND s.articulo_id = a.id), 3)").n).toBe(0);
    // Los datos existentes siguen ahí; las operaciones anteriores corresponden al principal (deposito_id vacío) y sin costo histórico
    expect(uno("SELECT stock FROM articulos WHERE id = 'a1'").stock).toBe(7.5);
    expect(uno("SELECT deposito_id FROM stock_movimientos WHERE id = 'm1'").deposito_id).toBeNull();
    expect(uno("SELECT costo_unitario, subtotal FROM venta_items WHERE id = 'vi1'")).toMatchObject({ costo_unitario: null, subtotal: 4000 });
    expect(todos('PRAGMA foreign_key_check')).toEqual([]);
    // Un único principal por taller y nombres únicos por taller
    expect(() => db.exec("INSERT INTO depositos (id, taller_id, nombre, es_principal) VALUES ('d9', 't1', 'Otro principal', 1)")).toThrow(/UNIQUE/);
    expect(() => db.exec("INSERT INTO depositos (id, taller_id, nombre) VALUES ('d8', 't1', 'depósito PRINCIPAL')")).toThrow(/UNIQUE/);
    db.exec("INSERT INTO depositos (id, taller_id, nombre) VALUES ('d7', 't1', 'Mostrador')");
    // No se puede guardar stock de un artículo en el depósito de otro taller
    expect(() => db.exec("INSERT INTO stock_depositos (taller_id, articulo_id, deposito_id, stock) VALUES ('t1', 'a1', (SELECT id FROM depositos WHERE taller_id = 't2'), 1)")).toThrow(/FOREIGN KEY/);
    // Código de barras único por taller
    db.exec("UPDATE articulos SET codigo_barras = '779123' WHERE id = 'a1'");
    db.exec("UPDATE articulos SET codigo_barras = '779123' WHERE id = 'a3'");
    expect(() => db.exec("UPDATE articulos SET codigo_barras = '779123' WHERE id = 'a2'")).toThrow(/UNIQUE/);
    // Transferencias: origen y destino distintos, cantidades positivas
    expect(() => db.exec("INSERT INTO transferencias_stock (id, taller_id, numero, fecha, origen_id, destino_id, idem_key) VALUES ('x1', 't1', 1, '2026-10-01', 'd7', 'd7', 'k1')")).toThrow(/CHECK/);
    db.close();
  });
});
