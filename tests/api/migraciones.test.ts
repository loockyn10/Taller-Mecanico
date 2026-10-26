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

  it('0009 conserva caja, bancos, cobros y comprobantes del Sprint 08 y deja la base lista para devoluciones, anticipos y costos', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const migraciones = fs.readdirSync(path.join(RAIZ, 'migrations')).sort();
    for (const m of migraciones.filter((f) => f < '0009')) db.exec(leer('migrations', m));
    const uno = (sql: string) => db.prepare(sql).get() as Record<string, any>;
    const todos = (sql: string) => db.prepare(sql).all() as Array<Record<string, any>>;
    db.exec(`
      INSERT INTO talleres (id, nombre) VALUES ('t1', 'Taller Viejo');
      INSERT INTO usuarios (id, taller_id, email, nombre, rol, plantilla, password_hash) VALUES ('u1', 't1', 'a@a.com', 'Dueño', 'propietario', 'propietario', 'x');
      INSERT INTO taller_config (taller_id) VALUES ('t1');
      INSERT INTO clientes (id, taller_id, codigo, nombre) VALUES ('c1', 't1', 1, 'Cliente');
      INSERT INTO vehiculos (id, taller_id, cliente_id, patente) VALUES ('veh1', 't1', 'c1', 'AAA111');
      INSERT INTO ventas (id, taller_id, numero, cliente_id, fecha, total, cobrado) VALUES ('v1', 't1', 1, 'c1', '2026-10-01', 10000, 4000);
      INSERT INTO cobros (id, taller_id, numero, cliente_id, fecha, total, idem_key) VALUES ('co1', 't1', 1, 'c1', '2026-10-01', 4000, 'k1');
      INSERT INTO cobro_medios (id, taller_id, cobro_id, medio, importe) VALUES ('cm1', 't1', 'co1', 'efectivo', 4000);
      INSERT INTO cobro_aplicaciones (id, taller_id, cobro_id, venta_id, importe) VALUES ('ca1', 't1', 'co1', 'v1', 4000);
      INSERT INTO caja_movimientos (id, taller_id, tipo, rubro, medio, importe, concepto, origen_tipo, origen_id, fecha) VALUES ('mv1', 't1', 'ingreso', 'cobro', 'efectivo', 4000, 'Cobro', 'cobro', 'cm1', '2026-10-01');
      INSERT INTO cuentas_bancarias (id, taller_id, nombre, banco) VALUES ('cb1', 't1', 'Cuenta', 'Banco');
      INSERT INTO banco_movimientos (id, taller_id, cuenta_id, fecha, tipo, categoria, importe, concepto, origen_tipo, origen_id) VALUES ('bm1', 't1', 'cb1', '2026-10-01', 'ingreso', 'manual', 500, 'Manual', 'manual', 'bm1');
      INSERT INTO ordenes (id, taller_id, numero, cliente_id, vehiculo_id, fecha_ingreso) VALUES ('o1', 't1', 1, 'c1', 'veh1', '2026-10-01');
      INSERT INTO orden_tiempos (id, taller_id, orden_id, usuario_id, inicio_at, fin_at, duracion_seg) VALUES ('ti1', 't1', 'o1', 'u1', '2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z', 3600);
    `);
    db.exec(leer('migrations', migraciones.find((f) => f.startsWith('0009'))!));
    // Nada se perdió y los saldos son los mismos (devuelto arranca en 0)
    expect({ ...uno('SELECT total, cobrado, devuelto FROM ventas') }).toEqual({ total: 10000, cobrado: 4000, devuelto: 0 });
    expect(uno('SELECT COUNT(*) AS n FROM caja_movimientos').n).toBe(1);
    expect(uno('SELECT COUNT(*) AS n FROM banco_movimientos').n).toBe(1);
    expect({ ...uno('SELECT tipo, credito_aplicado, devuelto FROM cobros') }).toEqual({ tipo: 'cobro', credito_aplicado: 0, devuelto: 0 });
    expect(todos('PRAGMA foreign_key_check')).toEqual([]);
    // Los tramos anteriores no se reconstruyen con costos de hoy: quedan sin costo histórico
    expect({ ...uno('SELECT costo_hora, costo_origen FROM orden_tiempos') }).toEqual({ costo_hora: null, costo_origen: null });
    expect({ ...uno('SELECT mo_estimado_at, mo_costo_estimado FROM ordenes') }).toEqual({ mo_estimado_at: null, mo_costo_estimado: null });
    // Los índices antiduplicación sobrevivieron a la reconstrucción de la caja y del banco
    expect(() => db.exec("INSERT INTO caja_movimientos (id, taller_id, tipo, rubro, medio, importe, concepto, origen_tipo, origen_id, fecha) VALUES ('mv2', 't1', 'ingreso', 'cobro', 'efectivo', 1, 'Dup', 'cobro', 'cm1', '2026-10-01')")).toThrow(/UNIQUE/);
    expect(() => db.exec("INSERT INTO banco_movimientos (id, taller_id, cuenta_id, fecha, tipo, categoria, importe, concepto, origen_tipo, origen_id) VALUES ('bm2', 't1', 'cb1', '2026-10-01', 'ingreso', 'manual', 1, 'Dup', 'manual', 'bm1')")).toThrow(/UNIQUE/);
    // Nuevos rubros y categorías admitidos
    db.exec("INSERT INTO caja_movimientos (id, taller_id, tipo, rubro, medio, importe, concepto, origen_tipo, origen_id, fecha) VALUES ('mv3', 't1', 'egreso', 'devolucion', 'efectivo', 100, 'Reintegro', 'reintegro', 'rm1', '2026-10-02')");
    db.exec("INSERT INTO banco_movimientos (id, taller_id, cuenta_id, fecha, tipo, categoria, importe, concepto, origen_tipo, origen_id) VALUES ('bm3', 't1', 'cb1', '2026-10-02', 'egreso', 'devolucion', 100, 'Reintegro', 'reintegro_medio', 'rm1')");
    // No se puede devolver más de lo vendido ni aplicar un anticipo más de una vez
    expect(() => db.exec("UPDATE ventas SET devuelto = 7000 WHERE id = 'v1'")).toThrow(/CHECK/);
    db.exec("UPDATE ventas SET devuelto = 6000 WHERE id = 'v1'");
    expect(() => db.exec("UPDATE cobros SET tipo = 'anticipo', credito_aplicado = 3000, devuelto = 2000 WHERE id = 'co1'")).toThrow(/CHECK/);
    expect(() => db.exec("UPDATE cobros SET tipo = 'otro' WHERE id = 'co1'")).toThrow(/CHECK/);
    // El cierre de un tramo congela el costo vigente (de la persona o el general) y no se reescribe después
    db.exec("UPDATE taller_config SET costo_hora_general = 1000 WHERE taller_id = 't1'");
    db.exec("INSERT INTO orden_tiempos (id, taller_id, orden_id, usuario_id, inicio_at) VALUES ('ti2', 't1', 'o1', 'u1', '2026-10-02T10:00:00Z')");
    db.exec("UPDATE orden_tiempos SET fin_at = '2026-10-02T11:00:00Z', duracion_seg = 3600 WHERE id = 'ti2'");
    expect({ ...uno("SELECT costo_hora, costo_origen FROM orden_tiempos WHERE id = 'ti2'") }).toEqual({ costo_hora: 1000, costo_origen: 'general' });
    db.exec("UPDATE usuarios SET costo_hora = 5000 WHERE id = 'u1'");
    db.exec("UPDATE taller_config SET costo_hora_general = 9999 WHERE taller_id = 't1'");
    expect(uno("SELECT costo_hora FROM orden_tiempos WHERE id = 'ti2'").costo_hora).toBe(1000);
    db.exec("INSERT INTO orden_tiempos (id, taller_id, orden_id, usuario_id, inicio_at) VALUES ('ti3', 't1', 'o1', 'u1', '2026-10-03T10:00:00Z')");
    db.exec("UPDATE orden_tiempos SET fin_at = '2026-10-03T11:00:00Z', duracion_seg = 3600 WHERE id = 'ti3'");
    expect({ ...uno("SELECT costo_hora, costo_origen FROM orden_tiempos WHERE id = 'ti3'") }).toEqual({ costo_hora: 5000, costo_origen: 'persona' });
    expect(todos('PRAGMA foreign_key_check')).toEqual([]);
    db.close();
  });
  it('0010 no toca los datos existentes y la base impide asientos desbalanceados, modificar lo registrado y borrar cuentas con movimientos', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const migraciones = fs.readdirSync(path.join(RAIZ, 'migrations')).sort();
    for (const m of migraciones.filter((f) => f < '0010')) db.exec(leer('migrations', m));
    const uno = (sql: string) => db.prepare(sql).get() as Record<string, any>;
    const todos = (sql: string) => db.prepare(sql).all() as Array<Record<string, any>>;
    db.exec(`
      INSERT INTO talleres (id, nombre) VALUES ('t1', 'Taller Viejo'), ('t2', 'Otro');
      INSERT INTO usuarios (id, taller_id, email, nombre, rol, plantilla, password_hash) VALUES ('u1', 't1', 'a@a.com', 'Dueño', 'propietario', 'propietario', 'x');
      INSERT INTO taller_config (taller_id) VALUES ('t1'), ('t2');
      INSERT INTO clientes (id, taller_id, codigo, nombre) VALUES ('c1', 't1', 1, 'Cliente');
      INSERT INTO ventas (id, taller_id, numero, cliente_id, fecha, total, cobrado) VALUES ('v1', 't1', 1, 'c1', '2026-10-01', 10000, 4000);
      INSERT INTO venta_items (id, taller_id, venta_id, tipo, descripcion, cantidad, precio_unitario, subtotal) VALUES ('vi1', 't1', 'v1', 'libre', 'Trabajo', 1, 10000, 10000);
      INSERT INTO cobros (id, taller_id, numero, cliente_id, fecha, total, idem_key) VALUES ('co1', 't1', 1, 'c1', '2026-10-01', 4000, 'k1');
      INSERT INTO categorias_gasto (id, taller_id, nombre) VALUES ('g1', 't1', 'Alquiler');
    `);
    const foto = () => JSON.stringify({ ventas: todos('SELECT * FROM ventas'), items: todos('SELECT * FROM venta_items'), cobros: todos('SELECT * FROM cobros'), cat: todos('SELECT id, nombre FROM categorias_gasto') });
    const antes = foto();
    db.exec(leer('migrations', migraciones.find((f) => f.startsWith('0010'))!));
    // La migración es sólo estructural: ningún dato existente cambia y la categoría de gasto queda sin cuenta contable elegida
    expect(foto()).toBe(antes);
    expect(uno('SELECT cuenta_contable_id FROM categorias_gasto').cuenta_contable_id).toBeNull();
    expect(uno('SELECT COUNT(*) AS n FROM asientos').n).toBe(0);
    expect(todos('PRAGMA foreign_key_check')).toEqual([]);

    db.exec(`
      INSERT INTO cuentas_contables (id, taller_id, codigo, nombre, tipo, naturaleza, imputable) VALUES ('rubro', 't1', '1', 'ACTIVO', 'activo', 'deudora', 0);
      INSERT INTO cuentas_contables (id, taller_id, codigo, nombre, tipo, naturaleza, imputable, rol) VALUES ('caja', 't1', '1.1', 'Caja', 'activo', 'deudora', 1, 'caja_efectivo');
      INSERT INTO cuentas_contables (id, taller_id, codigo, nombre, tipo, naturaleza, imputable) VALUES ('ventas', 't1', '4.1', 'Ventas', 'ingreso', 'acreedora', 1);
      INSERT INTO cuentas_contables (id, taller_id, codigo, nombre, tipo, naturaleza, imputable) VALUES ('ajena', 't2', '4.1', 'Ventas ajenas', 'ingreso', 'acreedora', 1);
    `);
    const asiento = (id: string, lineas: Array<[string, number, number]>, registrado = false) => {
      db.exec(`INSERT INTO asientos (id, taller_id, fecha, descripcion, modo, origen_tipo) VALUES ('${id}', 't1', '2026-10-01', 'Prueba', 'manual', 'manual')`);
      lineas.forEach(([cuenta, d, h], i) => db.exec(`INSERT INTO asiento_lineas (id, taller_id, asiento_id, orden, cuenta_id, debe, haber) VALUES ('${id}-${i}', 't1', '${id}', ${i}, '${cuenta}', ${d}, ${h})`));
      if (registrado) db.exec(`UPDATE asientos SET estado = 'registrado', numero = (SELECT COALESCE(MAX(numero), 0) + 1 FROM asientos WHERE taller_id = 't1'), total = 1000 WHERE id = '${id}'`);
    };
    // Partida doble: no se registra un asiento desbalanceado, con una sola línea ni con un rubro
    asiento('a1', [['caja', 1000, 0], ['ventas', 0, 900]]);
    expect(() => db.exec("UPDATE asientos SET estado = 'registrado', numero = 1 WHERE id = 'a1'")).toThrow(/desbalanceado/);
    asiento('a2', [['caja', 1000, 0]]);
    expect(() => db.exec("UPDATE asientos SET estado = 'registrado', numero = 1 WHERE id = 'a2'")).toThrow(/al menos dos líneas/);
    asiento('a3', [['rubro', 1000, 0], ['ventas', 0, 1000]]);
    expect(() => db.exec("UPDATE asientos SET estado = 'registrado', numero = 1 WHERE id = 'a3'")).toThrow(/imputable/);
    // Una línea no puede tener importe en el Debe y en el Haber, ni importes negativos
    expect(() => db.exec("INSERT INTO asiento_lineas (id, taller_id, asiento_id, orden, cuenta_id, debe, haber) VALUES ('x', 't1', 'a1', 9, 'caja', 5, 5)")).toThrow(/CHECK/);
    expect(() => db.exec("INSERT INTO asiento_lineas (id, taller_id, asiento_id, orden, cuenta_id, debe, haber) VALUES ('x', 't1', 'a1', 9, 'caja', -5, 0)")).toThrow(/CHECK/);
    // Una cuenta de otro taller no puede usarse en un asiento (FK compuesta)
    expect(() => db.exec("INSERT INTO asiento_lineas (id, taller_id, asiento_id, orden, cuenta_id, debe, haber) VALUES ('x', 't1', 'a1', 9, 'ajena', 5, 0)")).toThrow(/FOREIGN KEY/);
    // Un borrador balanceado se registra; el número no se repite
    asiento('a4', [['caja', 1000, 0], ['ventas', 0, 1000]], true);
    expect({ ...uno("SELECT estado, numero FROM asientos WHERE id = 'a4'") }).toEqual({ estado: 'registrado', numero: 1 });
    asiento('a5', [['caja', 1000, 0], ['ventas', 0, 1000]], true);
    expect(uno("SELECT numero FROM asientos WHERE id = 'a5'").numero).toBe(2);
    // Lo registrado no se modifica ni se borra, ni sus líneas
    expect(() => db.exec("UPDATE asientos SET descripcion = 'Otra' WHERE id = 'a4'")).toThrow(/no se modifica/);
    expect(() => db.exec("UPDATE asientos SET fecha = '2026-01-01' WHERE id = 'a4'")).toThrow(/no se modifica/);
    expect(() => db.exec("DELETE FROM asientos WHERE id = 'a4'")).toThrow(/no se elimina/);
    expect(() => db.exec("UPDATE asiento_lineas SET debe = 5 WHERE id = 'a4-0'")).toThrow(/líneas/);
    expect(() => db.exec("DELETE FROM asiento_lineas WHERE id = 'a4-0'")).toThrow(/líneas/);
    expect(() => db.exec("INSERT INTO asiento_lineas (id, taller_id, asiento_id, orden, cuenta_id, debe, haber) VALUES ('x', 't1', 'a4', 9, 'caja', 5, 0)")).toThrow(/líneas/);
    // Sólo puede pasar a revertido si existe su contra-asiento (y uno solo)
    expect(() => db.exec("UPDATE asientos SET estado = 'revertido' WHERE id = 'a4'")).toThrow(/contra-asiento/);
    db.exec("INSERT INTO asientos (id, taller_id, fecha, descripcion, modo, origen_tipo, revierte_id) VALUES ('r4', 't1', '2026-10-02', 'Reversión', 'reversion', 'manual', 'a4')");
    db.exec("INSERT INTO asiento_lineas (id, taller_id, asiento_id, orden, cuenta_id, debe, haber) VALUES ('r4-0', 't1', 'r4', 0, 'ventas', 1000, 0), ('r4-1', 't1', 'r4', 1, 'caja', 0, 1000)");
    db.exec("UPDATE asientos SET estado = 'registrado', numero = 3, total = 1000 WHERE id = 'r4'");
    db.exec("UPDATE asientos SET estado = 'revertido' WHERE id = 'a4'");
    expect(uno("SELECT estado FROM asientos WHERE id = 'a4'").estado).toBe('revertido');
    expect(() => db.exec("INSERT INTO asientos (id, taller_id, fecha, descripcion, modo, origen_tipo, revierte_id) VALUES ('r4b', 't1', '2026-10-02', 'Otra reversión', 'reversion', 'manual', 'a4')")).toThrow(/UNIQUE/);
    expect(() => db.exec("UPDATE asientos SET estado = 'registrado' WHERE id = 'a4'")).toThrow(/no se modifica/);
    // Un asiento automático por documento y evento: la base impide el duplicado (idempotencia)
    db.exec("INSERT INTO asientos (id, taller_id, fecha, descripcion, modo, origen_tipo, origen_id, evento) VALUES ('d1', 't1', '2026-10-01', 'Venta #1', 'automatico', 'venta', 'v1', 'alta')");
    expect(() => db.exec("INSERT INTO asientos (id, taller_id, fecha, descripcion, modo, origen_tipo, origen_id, evento) VALUES ('d2', 't1', '2026-10-01', 'Venta #1', 'automatico', 'venta', 'v1', 'alta')")).toThrow(/UNIQUE/);
    db.exec("INSERT INTO asientos (id, taller_id, fecha, descripcion, modo, origen_tipo, origen_id, evento) VALUES ('d3', 't2', '2026-10-01', 'Venta #1 de otro taller', 'automatico', 'venta', 'v1', 'alta')");
    // Un borrador sí se puede descartar, con sus líneas
    db.exec("DELETE FROM asientos WHERE id = 'a1'");
    expect(uno("SELECT COUNT(*) AS n FROM asiento_lineas WHERE asiento_id = 'a1'").n).toBe(0);
    // Plan de cuentas: no se elimina una cuenta con movimientos ni una del sistema, ni se cambia su naturaleza con movimientos
    expect(() => db.exec("DELETE FROM cuentas_contables WHERE id = 'ventas'")).toThrow(/movimientos/);
    expect(() => db.exec("DELETE FROM cuentas_contables WHERE id = 'caja'")).toThrow(/sistema/);
    expect(() => db.exec("UPDATE cuentas_contables SET naturaleza = 'deudora', tipo = 'gasto' WHERE id = 'ventas'")).toThrow(/movimientos/);
    expect(() => db.exec("UPDATE cuentas_contables SET activa = 0 WHERE id = 'caja'")).toThrow(/sistema/);
    db.exec("UPDATE cuentas_contables SET nombre = 'Caja en efectivo (renombrada)', codigo = '1.9' WHERE id = 'caja'");
    db.exec("INSERT INTO cuentas_contables (id, taller_id, codigo, nombre, tipo, naturaleza, imputable) VALUES ('libre', 't1', '6.9', 'Libre', 'gasto', 'deudora', 1)");
    db.exec("DELETE FROM cuentas_contables WHERE id = 'libre'");
    expect(() => db.exec("INSERT INTO cuentas_contables (id, taller_id, codigo, nombre, tipo, naturaleza, imputable) VALUES ('dup', 't1', '1.9', 'Repetida', 'activo', 'deudora', 1)")).toThrow(/UNIQUE/);
    expect(todos('PRAGMA foreign_key_check')).toEqual([]);
    db.close();
  });

  it('0011 no toca los datos existentes, los talleres previos no ven el asistente y la base protege códigos, invitaciones e importaciones', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const migraciones = fs.readdirSync(path.join(RAIZ, 'migrations')).sort();
    for (const m of migraciones.filter((f) => f < '0011')) db.exec(leer('migrations', m));
    const uno = (sql: string) => db.prepare(sql).get() as Record<string, any>;
    const todos = (sql: string) => db.prepare(sql).all() as Array<Record<string, any>>;
    db.exec(`
      INSERT INTO talleres (id, nombre) VALUES ('t1', 'Taller Viejo'), ('t2', 'Otro');
      INSERT INTO usuarios (id, taller_id, email, nombre, rol, plantilla, password_hash) VALUES ('u1', 't1', 'a@a.com', 'Dueño', 'propietario', 'propietario', 'x'), ('u2', 't2', 'b@b.com', 'Otro', 'propietario', 'propietario', 'x');
      INSERT INTO taller_config (taller_id) VALUES ('t1'), ('t2');
      INSERT INTO clientes (id, taller_id, codigo, nombre, documento) VALUES ('c1', 't1', 1, 'Cliente', '30123456'), ('c2', 't2', 1, 'Cliente ajeno', '30123456');
      INSERT INTO proveedores (id, taller_id, nombre, cuit) VALUES ('p1', 't1', 'Proveedor', '30-71234567-1');
      INSERT INTO articulos (id, taller_id, codigo, nombre, costo, precio, stock) VALUES ('a1', 't1', 'A1', 'Filtro', 1000, 2000, 7.5);
    `);
    const foto = () => JSON.stringify({ c: todos('SELECT id, nombre, documento FROM clientes ORDER BY id'), p: todos('SELECT id, nombre, cuit FROM proveedores'), a: todos('SELECT id, codigo, stock FROM articulos'), u: todos('SELECT id, email FROM usuarios ORDER BY id') });
    const antes = foto();
    db.exec(leer('migrations', migraciones.find((f) => f.startsWith('0011'))!));
    expect(foto()).toBe(antes);
    // Los talleres que ya existían no reciben el asistente de primer inicio ni pierden nada
    expect(todos('SELECT taller_id, asistente_pendiente, horarios_atencion, logo FROM taller_config ORDER BY taller_id').map((r) => ({ ...r }))).toEqual([
      { taller_id: 't1', asistente_pendiente: 0, horarios_atencion: null, logo: null },
      { taller_id: 't2', asistente_pendiente: 0, horarios_atencion: null, logo: null },
    ]);
    expect(uno("SELECT provincia FROM talleres WHERE id = 't1'").provincia).toBeNull();
    expect(uno("SELECT codigo_externo FROM clientes WHERE id = 'c1'").codigo_externo).toBeNull();
    expect(todos('PRAGMA foreign_key_check')).toEqual([]);
    // El código del sistema anterior es único por taller (y puede repetirse entre talleres)
    db.exec("UPDATE clientes SET codigo_externo = 'X-1' WHERE id = 'c1'");
    db.exec("UPDATE clientes SET codigo_externo = 'X-1' WHERE id = 'c2'");
    expect(() => db.exec("INSERT INTO clientes (id, taller_id, codigo, nombre, codigo_externo) VALUES ('c3', 't1', 2, 'Otro', 'X-1')")).toThrow(/UNIQUE/);
    db.exec("INSERT INTO clientes (id, taller_id, codigo, nombre, codigo_externo) VALUES ('c3', 't1', 2, 'Sin código', NULL), ('c4', 't1', 3, 'Sin código 2', NULL)");
    db.exec("UPDATE proveedores SET codigo_externo = 'P-1' WHERE id = 'p1'");
    expect(() => db.exec("INSERT INTO proveedores (id, taller_id, nombre, codigo_externo) VALUES ('p2', 't1', 'Dup', 'P-1')")).toThrow(/UNIQUE/);
    // Invitaciones: un solo enlace por huella, estados válidos y licencia mínima
    db.exec("INSERT INTO invitaciones_activacion (id, token_hash, vence_at) VALUES ('i1', 'h1', '2030-01-01T00:00:00Z')");
    expect(() => db.exec("INSERT INTO invitaciones_activacion (id, token_hash, vence_at) VALUES ('i2', 'h1', '2030-01-01T00:00:00Z')")).toThrow(/UNIQUE/);
    expect(() => db.exec("UPDATE invitaciones_activacion SET estado = 'rara' WHERE id = 'i1'")).toThrow(/CHECK/);
    expect(uno("SELECT estado, usuarios_incluidos FROM invitaciones_activacion WHERE id = 'i1'")).toMatchObject({ estado: 'pendiente', usuarios_incluidos: 1 });
    // Importaciones: tipo y modo válidos, usuario del mismo taller, un solo registro por (importación, lote) y por entidad
    const imp = (id: string, taller: string, usuario: string) =>
      db.exec(`INSERT INTO importaciones (id, taller_id, usuario_id, tipo, modo, archivo_nombre, archivo_hash, total_filas) VALUES ('${id}', '${taller}', '${usuario}', 'clientes', 'omitir', 'a.csv', 'h', 10)`);
    imp('m1', 't1', 'u1');
    expect(() => imp('m2', 't1', 'u2')).toThrow(/FOREIGN KEY/); // el usuario es de otro taller
    expect(() => db.exec("UPDATE importaciones SET tipo = 'bancos' WHERE id = 'm1'")).toThrow(/CHECK/);
    expect(() => db.exec("UPDATE importaciones SET modo = 'pisar' WHERE id = 'm1'")).toThrow(/CHECK/);
    db.exec("INSERT INTO importacion_lotes (taller_id, importacion_id, lote, filas) VALUES ('t1', 'm1', 0, 10)");
    expect(() => db.exec("INSERT INTO importacion_lotes (taller_id, importacion_id, lote, filas) VALUES ('t1', 'm1', 0, 10)")).toThrow(/UNIQUE|PRIMARY/); // reintentar un lote no lo duplica
    expect(() => db.exec("INSERT INTO importacion_lotes (taller_id, importacion_id, lote, filas) VALUES ('t2', 'm1', 1, 10)")).toThrow(/FOREIGN KEY/); // lote de otro taller
    db.exec("INSERT INTO importacion_registros (taller_id, importacion_id, entidad_id, accion) VALUES ('t1', 'm1', 'c1', 'creado')");
    expect(() => db.exec("INSERT INTO importacion_registros (taller_id, importacion_id, entidad_id, accion) VALUES ('t1', 'm1', 'c1', 'creado')")).toThrow(/UNIQUE|PRIMARY/);
    // Al borrar una importación se van sus lotes, errores y registros (nunca los datos importados)
    db.exec("DELETE FROM importaciones WHERE id = 'm1'");
    expect(uno('SELECT COUNT(*) AS n FROM importacion_lotes').n).toBe(0);
    expect(uno("SELECT COUNT(*) AS n FROM clientes WHERE id = 'c1'").n).toBe(1);
    // Pasos de puesta en marcha: uno por taller y estado válido
    db.exec("INSERT INTO puesta_marcha_pasos (taller_id, paso, estado) VALUES ('t1', 'negocio', 'hecho')");
    expect(() => db.exec("INSERT INTO puesta_marcha_pasos (taller_id, paso, estado) VALUES ('t1', 'negocio', 'omitido')")).toThrow(/UNIQUE|PRIMARY/);
    expect(() => db.exec("INSERT INTO puesta_marcha_pasos (taller_id, paso, estado) VALUES ('t1', 'horarios', 'pendiente')")).toThrow(/CHECK/);
    expect(todos('PRAGMA foreign_key_check')).toEqual([]);
    db.close();
  });

  it('0012 conserva la contabilidad ya generada y las deudas con proveedores, y la base protege las aperturas de saldos', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const migraciones = fs.readdirSync(path.join(RAIZ, 'migrations')).sort();
    for (const m of migraciones.filter((f) => f < '0012')) db.exec(leer('migrations', m));
    const uno = (sql: string) => db.prepare(sql).get() as Record<string, any>;
    const todos = (sql: string) => db.prepare(sql).all() as Array<Record<string, any>>;
    db.exec(`
      INSERT INTO talleres (id, nombre) VALUES ('t1', 'Taller Viejo'), ('t2', 'Otro');
      INSERT INTO usuarios (id, taller_id, email, nombre, rol, plantilla, password_hash) VALUES ('u1', 't1', 'a@a.com', 'Dueño', 'propietario', 'propietario', 'x'), ('u2', 't2', 'b@b.com', 'Otro', 'propietario', 'propietario', 'x');
      INSERT INTO taller_config (taller_id) VALUES ('t1'), ('t2');
      INSERT INTO proveedores (id, taller_id, nombre) VALUES ('p1', 't1', 'Proveedor'), ('p2', 't1', 'Otro proveedor'), ('p9', 't2', 'Ajeno');
      INSERT INTO contab_config (taller_id, inicializado_at, ultima_corrida_at) VALUES ('t1', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z');
    `);
    const foto = () => JSON.stringify({ p: todos('SELECT id, nombre FROM proveedores ORDER BY id'), c: todos('SELECT taller_id, inicializado_at, plan_version, ultima_corrida_at FROM contab_config'), u: todos('SELECT id FROM usuarios ORDER BY id') });
    const antes = foto();
    db.exec(leer('migrations', migraciones.find((f) => f.startsWith('0012'))!));
    expect(foto()).toBe(antes);
    // Un taller que ya tenía la contabilidad generada sigue activado, sin turno tomado ni errores
    expect(uno("SELECT sync_bloqueo_hasta, sync_solicitada, ultimo_error, activada_por FROM contab_config WHERE taller_id = 't1'")).toMatchObject({ sync_bloqueo_hasta: null, sync_solicitada: 0, ultimo_error: null, activada_por: null });
    expect(todos('PRAGMA foreign_key_check')).toEqual([]);
    const apertura = (id: string, taller: string, usuario: string, numero: number) =>
      db.exec(`INSERT INTO aperturas_saldos (id, taller_id, numero, tipo, fecha_corte, origen, total, cantidad, idem_key, usuario_id) VALUES ('${id}', '${taller}', ${numero}, 'proveedores', '2026-09-30', 'Planilla del sistema anterior', 1500, 2, 'k-${id}', '${usuario}')`);
    const item = (id: string, taller: string, ap: string, prov: string, importe: number) =>
      db.exec(`INSERT INTO aperturas_saldos_items (id, taller_id, apertura_id, proveedor_id, importe) VALUES ('${id}', '${taller}', '${ap}', '${prov}', ${importe})`);
    apertura('ap1', 't1', 'u1', 1);
    expect(() => apertura('ap2', 't1', 'u2', 2)).toThrow(/FOREIGN KEY/); // el responsable es de otro taller
    expect(() => apertura('ap3', 't1', 'u1', 1)).toThrow(/UNIQUE/); // número correlativo único por taller
    expect(() => db.exec("INSERT INTO aperturas_saldos (id, taller_id, numero, tipo, fecha_corte, origen, total, cantidad, idem_key, usuario_id) VALUES ('ap4', 't1', 4, 'bancos', '2026-09-30', 'Planilla', 1, 1, 'k4', 'u1')")).toThrow(/CHECK/);
    expect(() => db.exec("INSERT INTO aperturas_saldos (id, taller_id, numero, tipo, fecha_corte, origen, total, cantidad, idem_key, usuario_id) VALUES ('ap5', 't1', 5, 'proveedores', '30/09/2026', 'Planilla', 1, 1, 'k5', 'u1')")).toThrow(/CHECK/);
    item('i1', 't1', 'ap1', 'p1', 1000);
    item('i2', 't1', 'ap1', 'p2', 500);
    expect(() => item('i3', 't1', 'ap1', 'p9', 5)).toThrow(/FOREIGN KEY/); // proveedor de otro taller
    expect(() => item('i4', 't2', 'ap1', 'p9', 5)).toThrow(); // apertura de otro taller
    expect(() => item('i5', 't1', 'ap1', 'p1', 0)).toThrow(/CHECK/); // saldo cero
    // Un proveedor, un solo saldo de apertura vigente: aunque se cargue otra apertura
    apertura('ap6', 't1', 'u1', 6);
    expect(() => item('i6', 't1', 'ap6', 'p1', 70)).toThrow(/UNIQUE/);
    // Inmutables: ni se editan, ni se borran, ni se desactiva un renglón por separado
    expect(() => db.exec("UPDATE aperturas_saldos SET total = 1 WHERE id = 'ap1'")).toThrow(/no se modifica/);
    expect(() => db.exec("DELETE FROM aperturas_saldos WHERE id = 'ap1'")).toThrow(/no se elimina/);
    expect(() => db.exec("UPDATE aperturas_saldos_items SET importe = 1 WHERE id = 'i1'")).toThrow(/no se modifican/);
    expect(() => db.exec("DELETE FROM aperturas_saldos_items WHERE id = 'i1'")).toThrow(/no se eliminan/);
    expect(() => db.exec("UPDATE aperturas_saldos_items SET activo = 0 WHERE id = 'i1'")).toThrow();
    // Anular: la cabecera pasa a anulada y recién entonces los renglones quedan inactivos; después ya nada se toca y el proveedor puede volver a cargarse
    expect(() => db.exec("UPDATE aperturas_saldos SET estado = 'anulada' WHERE id = 'ap1'")).toThrow(/CHECK/); // anulada exige fecha de anulación
    db.exec("UPDATE aperturas_saldos SET estado = 'anulada', anulada_at = '2026-10-22T00:00:00Z', anulada_por = 'u1', motivo_anulacion = 'Error' WHERE id = 'ap1'");
    db.exec("UPDATE aperturas_saldos_items SET activo = 0 WHERE apertura_id = 'ap1'");
    expect(() => db.exec("UPDATE aperturas_saldos SET motivo_anulacion = 'otro' WHERE id = 'ap1'")).toThrow(/no se modifica/);
    expect(() => db.exec("UPDATE aperturas_saldos_items SET activo = 1 WHERE id = 'i1'")).toThrow(/no se modifican/);
    expect(() => item('i7', 't1', 'ap1', 'p2', 9)).toThrow(/no admite/);
    item('i8', 't1', 'ap6', 'p1', 1000);
    expect(uno("SELECT COUNT(*) AS n FROM aperturas_saldos_items WHERE proveedor_id = 'p1' AND activo = 1").n).toBe(1);
    expect(todos('PRAGMA foreign_key_check')).toEqual([]);
    db.close();
  });

  it('0013 no toca los datos, marca para reconciliar los talleres ya activados y encola cada operación en SU transacción (si se revierte, no queda pedido)', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const migraciones = fs.readdirSync(path.join(RAIZ, 'migrations')).sort();
    for (const m of migraciones.filter((f) => f < '0013')) db.exec(leer('migrations', m));
    const uno = (sql: string) => db.prepare(sql).get() as Record<string, any>;
    const todos = (sql: string) => db.prepare(sql).all() as Array<Record<string, any>>;
    db.exec(`
      INSERT INTO talleres (id, nombre) VALUES ('t1', 'Taller Activado'), ('t2', 'Taller Sin Activar');
      INSERT INTO usuarios (id, taller_id, email, nombre, rol, plantilla, password_hash) VALUES ('u1', 't1', 'a@a.com', 'Dueño', 'propietario', 'propietario', 'x'), ('u2', 't2', 'b@b.com', 'Otro', 'propietario', 'propietario', 'x');
      INSERT INTO taller_config (taller_id) VALUES ('t1'), ('t2');
      INSERT INTO clientes (id, taller_id, codigo, nombre) VALUES ('c1', 't1', 1, 'Cliente Uno'), ('c2', 't2', 1, 'Cliente Dos');
      INSERT INTO ventas (id, taller_id, numero, cliente_id, fecha, total, neto, idem_key) VALUES ('v0', 't1', 1, 'c1', '2026-10-01', 1000, 1000, 'k0');
      INSERT INTO contab_config (taller_id, inicializado_at, ultima_corrida_at) VALUES ('t1', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z');
    `);
    const foto = () => JSON.stringify({ v: todos('SELECT id, total, estado FROM ventas ORDER BY id'), c: todos('SELECT taller_id, inicializado_at, plan_version, ultima_corrida_at FROM contab_config'), u: todos('SELECT id FROM usuarios ORDER BY id') });
    const antes = foto();
    db.exec(leer('migrations', migraciones.find((f) => f.startsWith('0013'))!));
    expect(foto()).toBe(antes);
    // El taller que ya tenía la contabilidad pasa una vez por la reconciliación (no tenía cola); la cola arranca vacía
    expect(uno("SELECT reconciliar_pendiente, reconciliada_at FROM contab_config WHERE taller_id = 't1'")).toMatchObject({ reconciliar_pendiente: 1, reconciliada_at: null });
    expect(uno('SELECT COUNT(*) AS n FROM contab_cola').n).toBe(0);
    // Taller activado: una venta deja su pedido en la misma operación; anularla deja el pedido de anulación; insertar dos veces no duplica
    db.exec("INSERT INTO ventas (id, taller_id, numero, cliente_id, fecha, total, neto, idem_key) VALUES ('v1', 't1', 2, 'c1', '2026-10-02', 500, 500, 'k1')");
    expect(todos('SELECT origen_tipo, origen_id, evento, estado, intentos FROM contab_cola').map((r) => ({ ...r }))).toEqual([{ origen_tipo: 'venta', origen_id: 'v1', evento: 'alta', estado: 'pendiente', intentos: 0 }]);
    db.exec("UPDATE ventas SET estado = 'anulada' WHERE id = 'v1'");
    db.exec("UPDATE ventas SET observaciones = 'x' WHERE id = 'v1'");
    expect(todos('SELECT evento FROM contab_cola ORDER BY evento').map((r) => r.evento)).toEqual(['alta', 'anulacion']);
    // Taller sin la contabilidad activada: nada se encola (la activación sigue siendo explícita)
    db.exec("INSERT INTO ventas (id, taller_id, numero, cliente_id, fecha, total, neto, idem_key) VALUES ('v2', 't2', 1, 'c2', '2026-10-02', 700, 700, 'k2')");
    expect(uno("SELECT COUNT(*) AS n FROM contab_cola WHERE taller_id = 't2'").n).toBe(0);
    // Atomicidad: si la operación se revierte (rollback del batch), el pedido también se revierte
    db.exec('BEGIN');
    db.exec("INSERT INTO ventas (id, taller_id, numero, cliente_id, fecha, total, neto, idem_key) VALUES ('v3', 't1', 3, 'c1', '2026-10-03', 900, 900, 'k3')");
    expect(uno("SELECT COUNT(*) AS n FROM contab_cola WHERE origen_id = 'v3'").n).toBe(1);
    db.exec('ROLLBACK');
    expect(uno("SELECT COUNT(*) AS n FROM contab_cola WHERE origen_id = 'v3'").n).toBe(0);
    expect(uno("SELECT COUNT(*) AS n FROM ventas WHERE id = 'v3'").n).toBe(0);
    // Una operación que viola una restricción (idem_key repetida) no deja pedido huérfano
    expect(() => db.exec("INSERT INTO ventas (id, taller_id, numero, cliente_id, fecha, total, neto, idem_key) VALUES ('v4', 't1', 4, 'c1', '2026-10-03', 900, 900, 'k1')")).toThrow(/UNIQUE/);
    expect(uno("SELECT COUNT(*) AS n FROM contab_cola WHERE origen_id = 'v4'").n).toBe(0);
    // Estados y claves válidos
    expect(() => db.exec("INSERT INTO contab_cola (taller_id, origen_tipo, origen_id, evento, estado) VALUES ('t1', 'venta', 'zz', 'alta', 'rara')")).toThrow(/CHECK/);
    expect(() => db.exec("INSERT INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES ('t1', 'venta', 'v1', 'alta')")).toThrow(/UNIQUE|PRIMARY/);
    // Índices nuevos para los hallazgos de capacidad
    for (const i of ['idx_cobro_medios_cobro', 'idx_cobro_aplicaciones_cobro', 'idx_compra_items_compra', 'idx_recepcion_items_recepcion', 'idx_ventas_por_cobrar']) {
      expect(uno(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = '${i}'`).n, i).toBe(1);
    }
    expect(todos('PRAGMA foreign_key_check')).toEqual([]);
    db.close();
  });

  it('0016 no toca ningún dato, conserva el check-list simple y la base protege lo confirmado, las firmas y las fotografías incluidas', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const m of fs.readdirSync(path.join(RAIZ, 'migrations')).sort().filter((x) => x < '0016')) db.exec(leer('migrations', m));
    db.exec(leer('tests', 'fixtures', 'datos-previos-0002.sql'));
    db.exec("INSERT INTO vehiculos (id, taller_id, cliente_id, patente, km_actual) VALUES ('v1', 't1', 'c1', 'AB123CD', 1000)");
    db.exec("INSERT INTO ordenes (id, taller_id, numero, cliente_id, vehiculo_id, fecha_ingreso) VALUES ('o1', 't1', 1, 'c1', 'v1', '2026-10-24')");
    db.exec("INSERT INTO checklists (id, taller_id, orden_id, combustible, km, datos) VALUES ('k1', 't1', 'o1', '1/2', 1000, '{\"danos\":[\"Rayones\"]}')");
    db.exec("INSERT INTO fotos (id, taller_id, vehiculo_id, orden_id, etapa, idem_key, mime, ancho, alto, bytes, miniatura_bytes, sha256, miniatura_sha256, estado) VALUES ('f1', 't1', 'v1', 'o1', 'recepcion', 'k1', 'image/jpeg', 800, 600, 1000, 100, 'a', 'b', 'lista')");
    const tablas = ['clientes', 'vehiculos', 'ordenes', 'checklists', 'fotos', 'ventas', 'cobros'];
    const antes = tablas.map((t) => db.prepare(`SELECT * FROM ${t}`).all().map((r: any) => ({ ...r })));
    db.exec(leer('migrations', '0016_checklist_recepcion_entrega.sql'));
    expect(tablas.map((t) => db.prepare(`SELECT * FROM ${t}`).all().map((r: any) => ({ ...r })))).toEqual(antes);
    for (const t of ['ck_registros', 'ck_firmas', 'ck_fotos']) expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n).toBe(0);

    const registro = (id: string, extra = '') => `INSERT INTO ck_registros (id, taller_id, orden_id, vehiculo_id, cliente_id, tipo, checklist_version, datos, fecha_hora, responsable_nombre${extra.split('|')[0]}) VALUES ('${id}', 't1', 'o1', 'v1', 'c1', 'recepcion', 1, '{}', '2026-10-24T10:00:00Z', 'Ana'${extra.split('|')[1] ?? ''})`;
    db.exec(registro('r1'));
    expect((db.prepare("SELECT estado, revision FROM ck_registros WHERE id = 'r1'").get() as any)).toMatchObject({ estado: 'borrador', revision: 0 });
    // Un solo borrador por OT y tipo; a otro taller no se le puede colgar una orden ajena
    expect(() => db.exec(registro('r2'))).toThrow(/UNIQUE/);
    expect(() => db.exec("INSERT INTO ck_registros (id, taller_id, orden_id, vehiculo_id, cliente_id, tipo, checklist_version, datos, fecha_hora, responsable_nombre) VALUES ('rx', 't2', 'o1', 'v1', 'c1', 'entrega', 1, '{}', '2026-10-24T10:00:00Z', 'x')")).toThrow(/FOREIGN/);
    // El borrador se edita y se descarta; confirmarlo exige la huella y el contexto
    db.exec("UPDATE ck_registros SET km = 1200, updated_at = '2026-10-24T11:00:00Z' WHERE id = 'r1'");
    expect(() => db.exec("UPDATE ck_registros SET estado = 'confirmado' WHERE id = 'r1'")).toThrow(/CHECK/);
    db.exec("UPDATE ck_registros SET estado = 'confirmado', contexto = '{}', contenido_sha256 = 'h1', confirmado_at = '2026-10-24T12:00:00Z' WHERE id = 'r1'");
    // Confirmado: inmutable (la corrección es una revisión nueva) y sin posibilidad de borrarse
    expect(() => db.exec("UPDATE ck_registros SET km = 5 WHERE id = 'r1'")).toThrow(/inmutable/);
    expect(() => db.exec("DELETE FROM ck_registros WHERE id = 'r1'")).toThrow(/inmutable/);
    expect(() => db.exec(registro('r3', ', revision, previo_id|, 1, NULL'))).toThrow(/CHECK/); // una revisión necesita su original y su motivo
    db.exec(registro('r3', ', revision, previo_id, motivo|, 1, \'r1\', \'Corrección\''));
    // Firmas: sólo sobre contenido confirmado y con el mismo hash; no se modifican ni se borran; una sola firma efectiva
    const firma = (id: string, resultado: string, hash = 'h1', extra = '') => `INSERT INTO ck_firmas (id, taller_id, registro_id, resultado, nombre_firmante, aclaracion, firma, firma_sha256, contenido_sha256, checklist_version, texto_conformidad, texto_version, registrado_por_nombre${extra}) VALUES ('${id}', 't1', 'r1', '${resultado}', 'Ana', ${resultado === 'firmada' ? 'NULL' : "'Aclaración'"}, ${resultado === 'firmada' ? "'{}'" : 'NULL'}, ${resultado === 'firmada' ? "'s'" : 'NULL'}, '${hash}', 1, 'texto', 1, 'Empleado')`;
    expect(() => db.exec(firma('fi0', 'firmada', 'otro-hash'))).toThrow(/contenido_distinto/);
    expect(() => db.exec("INSERT INTO ck_firmas (id, taller_id, registro_id, resultado, contenido_sha256, checklist_version, texto_conformidad, texto_version, registrado_por_nombre) VALUES ('fi1', 't1', 'r3', 'no_presente', 'x', 1, 't', 1, 'E')")).toThrow(/contenido_distinto|CHECK/); // r3 es un borrador
    db.exec(firma('fi2', 'no_presente'));
    db.exec(firma('fi3', 'firmada'));
    expect(() => db.exec(firma('fi4', 'firmada'))).toThrow(/UNIQUE/);
    expect(() => db.exec("UPDATE ck_firmas SET nombre_firmante = 'Otro' WHERE id = 'fi3'")).toThrow(/inmutable/);
    expect(() => db.exec("DELETE FROM ck_firmas WHERE id = 'fi3'")).toThrow(/inmutable/);
    // Fotografías incluidas: vínculo de sólo agregar y la foto no puede pasar a "eliminada"
    db.exec("INSERT INTO ck_fotos (taller_id, registro_id, foto_id, dano_id) VALUES ('t1', 'r1', 'f1', NULL)");
    expect(() => db.exec("UPDATE fotos SET estado = 'eliminada' WHERE id = 'f1'")).toThrow(/foto_en_checklist/);
    expect(() => db.exec("DELETE FROM fotos WHERE id = 'f1'")).toThrow(/FOREIGN/);
    expect(() => db.exec("DELETE FROM ck_fotos WHERE foto_id = 'f1'")).toThrow(/inmutable/);
    db.exec("UPDATE fotos SET descripcion = 'sigue editable' WHERE id = 'f1'");
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  it('0017 no toca ningún dato y la base protege el seguimiento público (un token por orden, tokens únicos y de largo fijo, mensajes que no se reescriben)', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const m of fs.readdirSync(path.join(RAIZ, 'migrations')).sort().filter((x) => x < '0017')) db.exec(leer('migrations', m));
    db.exec(leer('tests', 'fixtures', 'datos-previos-0002.sql'));
    db.exec("INSERT INTO vehiculos (id, taller_id, cliente_id, patente, km_actual) VALUES ('v1', 't1', 'c1', 'AB123CD', 1000)");
    db.exec("INSERT INTO ordenes (id, taller_id, numero, cliente_id, vehiculo_id, fecha_ingreso) VALUES ('o1', 't1', 1, 'c1', 'v1', '2026-10-24')");
    db.exec("INSERT INTO ordenes (id, taller_id, numero, cliente_id, vehiculo_id, fecha_ingreso) VALUES ('o2', 't1', 2, 'c1', 'v1', '2026-10-24')");
    db.exec("INSERT INTO orden_eventos (id, taller_id, orden_id, estado_nuevo) VALUES ('e1', 't1', 'o1', 'recibida')");
    const tablas = ['clientes', 'vehiculos', 'ordenes', 'orden_eventos', 'ventas', 'cobros'];
    const antes = tablas.map((t) => db.prepare(`SELECT * FROM ${t}`).all().map((r: any) => ({ ...r })));
    db.exec(leer('migrations', '0017_seguimiento_publico.sql'));
    expect(tablas.map((t) => db.prepare(`SELECT * FROM ${t}`).all().map((r: any) => ({ ...r })))).toEqual(antes);
    for (const t of ['seguimiento_enlaces', 'seguimiento_mensajes', 'seguimiento_eventos_ocultos']) expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n).toBe(0);

    const tok = (c: string) => c.repeat(43);
    db.exec(`INSERT INTO seguimiento_enlaces (id, taller_id, orden_id, token) VALUES ('s1', 't1', 'o1', '${tok('a')}')`);
    // Un enlace por orden y un token nunca se repite (ni entre órdenes)
    expect(() => db.exec(`INSERT INTO seguimiento_enlaces (id, taller_id, orden_id, token) VALUES ('s2', 't1', 'o1', '${tok('b')}')`)).toThrow(/UNIQUE/);
    expect(() => db.exec(`INSERT INTO seguimiento_enlaces (id, taller_id, orden_id, token) VALUES ('s2', 't1', 'o2', '${tok('a')}')`)).toThrow(/UNIQUE/);
    // Sólo tokens del largo previsto (256 bits en base64url) y una orden ajena no se puede colgar de otro taller
    expect(() => db.exec("INSERT INTO seguimiento_enlaces (id, taller_id, orden_id, token) VALUES ('s3', 't1', 'o2', 'corto')")).toThrow(/CHECK/);
    expect(() => db.exec(`INSERT INTO seguimiento_enlaces (id, taller_id, orden_id, token) VALUES ('s3', 't2', 'o2', '${tok('c')}')`)).toThrow(/FOREIGN/);
    expect(() => db.exec(`INSERT INTO seguimiento_enlaces (id, taller_id, orden_id, token, activo) VALUES ('s3', 't1', 'o2', '${tok('c')}', 2)`)).toThrow(/CHECK/);
    // Desactivar y regenerar son simples UPDATE
    db.exec("UPDATE seguimiento_enlaces SET activo = 0 WHERE id = 's1'");
    db.exec(`UPDATE seguimiento_enlaces SET token = '${tok('d')}', generacion = generacion + 1 WHERE id = 's1'`);
    expect((db.prepare("SELECT activo, generacion FROM seguimiento_enlaces WHERE id = 's1'").get() as any)).toMatchObject({ activo: 0, generacion: 2 });

    // Mensajes: vacíos o de más de 500 caracteres no entran; lo publicado no se reescribe, sólo se retira
    expect(() => db.exec("INSERT INTO seguimiento_mensajes (id, taller_id, orden_id, texto) VALUES ('m0', 't1', 'o1', '   ')")).toThrow(/CHECK/);
    expect(() => db.exec(`INSERT INTO seguimiento_mensajes (id, taller_id, orden_id, texto) VALUES ('m0', 't1', 'o1', '${'x'.repeat(501)}')`)).toThrow(/CHECK/);
    db.exec("INSERT INTO seguimiento_mensajes (id, taller_id, orden_id, texto, usuario_id) VALUES ('m1', 't1', 'o1', 'Esperando repuesto', 'u1')");
    expect(() => db.exec("UPDATE seguimiento_mensajes SET texto = 'otro' WHERE id = 'm1'")).toThrow(/inmutable/);
    expect(() => db.exec("UPDATE seguimiento_mensajes SET usuario_id = 'u2' WHERE id = 'm1'")).toThrow(/inmutable/);
    db.exec("UPDATE seguimiento_mensajes SET retirado_at = '2026-10-24T12:00:00Z', retirado_por = 'u1' WHERE id = 'm1'");

    // Transiciones ocultas: una vez por evento; si se borra la orden o el evento, se va la marca
    db.exec("INSERT INTO seguimiento_eventos_ocultos (taller_id, orden_id, evento_id) VALUES ('t1', 'o1', 'e1')");
    expect(() => db.exec("INSERT INTO seguimiento_eventos_ocultos (taller_id, orden_id, evento_id) VALUES ('t1', 'o1', 'e1')")).toThrow(/UNIQUE|PRIMARY/);
    expect(() => db.exec("INSERT INTO seguimiento_eventos_ocultos (taller_id, orden_id, evento_id) VALUES ('t1', 'o1', 'no-existe')")).toThrow(/FOREIGN/);
    db.exec("DELETE FROM orden_eventos WHERE id = 'e1'");
    expect((db.prepare('SELECT COUNT(*) AS n FROM seguimiento_eventos_ocultos').get() as any).n).toBe(0);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  it('0015 no toca ningún dato y la base protege las fotografías (etapa de OT, cupo y estados)', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const m of fs.readdirSync(path.join(RAIZ, 'migrations')).sort().filter((x) => x < '0015')) db.exec(leer('migrations', m));
    db.exec(leer('tests', 'fixtures', 'datos-previos-0002.sql'));
    db.exec("INSERT INTO vehiculos (id, taller_id, cliente_id, patente, km_actual) VALUES ('v1', 't1', 'c1', 'AB123CD', 1000)");
    const antes = db.prepare('SELECT * FROM vehiculos').all().map((r: any) => ({ ...r }));
    db.exec(leer('migrations', '0015_fotografias.sql'));
    expect(db.prepare('SELECT * FROM vehiculos').all().map((r: any) => ({ ...r }))).toEqual(antes);
    expect((db.prepare('SELECT COUNT(*) AS n FROM fotos').get() as any).n).toBe(0);
    const foto = (extra: string) => `INSERT INTO fotos (id, taller_id, vehiculo_id, idem_key, mime, ancho, alto, bytes, miniatura_bytes, sha256, miniatura_sha256${extra.split('|')[0]}) VALUES ('f1', 't1', 'v1', 'k1', 'image/jpeg', 800, 600, 1000, 100, 'a', 'b'${extra.split('|')[1] ?? ''})`;
    db.exec(foto('|'));
    expect((db.prepare("SELECT estado FROM fotos WHERE id = 'f1'").get() as any).estado).toBe('pendiente');
    // Una foto de otro taller no puede colgarse de un vehículo ajeno, ni repetirse la clave de reintento dentro del taller
    expect(() => db.exec("INSERT INTO fotos (id, taller_id, vehiculo_id, idem_key, mime, ancho, alto, bytes, miniatura_bytes, sha256, miniatura_sha256) VALUES ('f2', 't2', 'v1', 'kx', 'image/jpeg', 1, 1, 1, 1, 'a', 'b')")).toThrow(/FOREIGN/);
    expect(() => db.exec("INSERT INTO fotos (id, taller_id, vehiculo_id, idem_key, mime, ancho, alto, bytes, miniatura_bytes, sha256, miniatura_sha256) VALUES ('f3', 't1', 'v1', 'k1', 'image/jpeg', 1, 1, 1, 1, 'a', 'b')")).toThrow(/UNIQUE/);
    // Etapa: obligatoria con OT y prohibida sin OT; sólo formatos admitidos; sólo estados válidos
    expect(() => db.exec("INSERT INTO fotos (id, taller_id, vehiculo_id, etapa, idem_key, mime, ancho, alto, bytes, miniatura_bytes, sha256, miniatura_sha256) VALUES ('f4', 't1', 'v1', 'entrega', 'k4', 'image/jpeg', 1, 1, 1, 1, 'a', 'b')")).toThrow(/CHECK/);
    expect(() => db.exec("INSERT INTO fotos (id, taller_id, vehiculo_id, idem_key, mime, ancho, alto, bytes, miniatura_bytes, sha256, miniatura_sha256) VALUES ('f5', 't1', 'v1', 'k5', 'image/svg+xml', 1, 1, 1, 1, 'a', 'b')")).toThrow(/CHECK/);
    expect(() => db.exec("UPDATE fotos SET estado = 'rara' WHERE id = 'f1'")).toThrow(/CHECK/);
    expect(() => db.exec("INSERT INTO taller_almacenamiento (taller_id, fotos_limite_bytes) VALUES ('t1', 0)")).toThrow(/CHECK/);
    db.exec("INSERT INTO taller_almacenamiento (taller_id) VALUES ('t1')");
    expect((db.prepare("SELECT fotos_limite_bytes AS l FROM taller_almacenamiento WHERE taller_id = 't1'").get() as any).l).toBe(2 * 1024 ** 3);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  it('0014 no toca vehículos, marcas ni modelos de los talleres y deja las tablas del catálogo vacías y listas', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const m of fs.readdirSync(path.join(RAIZ, 'migrations')).sort().filter((x) => x < '0014')) db.exec(leer('migrations', m));
    db.exec(leer('tests', 'fixtures', 'datos-previos-0002.sql'));
    db.exec("INSERT INTO marcas (id, taller_id, nombre) VALUES ('ma1', 't1', 'VW viejo')");
    db.exec("INSERT INTO modelos (id, taller_id, marca_id, nombre) VALUES ('mo1', 't1', 'ma1', 'Gol a mano')");
    db.exec("INSERT INTO vehiculos (id, taller_id, cliente_id, patente, marca_id, modelo_id, anio, motor, km_actual) VALUES ('v1', 't1', 'c1', 'AB123CD', 'ma1', 'mo1', 2015, '1.6 16v', 90000)");
    const antes = db.prepare('SELECT * FROM vehiculos').all().map((r: any) => ({ ...r }));
    db.exec(leer('migrations', '0014_catalogo_automotor.sql'));
    const despues = db.prepare('SELECT * FROM vehiculos').all().map((r: any) => ({ ...r }));
    expect(despues).toEqual(antes.map((r: any) => ({ ...r, cat_modelo_id: null, cat_version_id: null, version: null })));
    expect(db.prepare("SELECT nombre FROM marcas WHERE id = 'ma1'").get()).toMatchObject({ nombre: 'VW viejo' });
    expect(db.prepare("SELECT nombre, cat_modelo_id FROM modelos WHERE id = 'mo1'").get()).toMatchObject({ nombre: 'Gol a mano', cat_modelo_id: null });
    for (const t of ['cat_marcas', 'cat_modelos', 'cat_versiones', 'cat_fichas']) expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n).toBe(0);
    // Una ficha técnica no se puede cargar sin fuente ni fecha de verificación
    db.exec("INSERT INTO cat_marcas (id, nombre, clave, codigos) VALUES ('ma_x', 'X', 'x', '[]')");
    db.exec("INSERT INTO cat_modelos (id, marca_id, nombre, clave, anios) VALUES ('mo_x', 'ma_x', 'Y', 'y', '2020')");
    expect(() => db.exec("INSERT INTO cat_fichas (id, modelo_id, aceite_recomendado, fuente, fecha_verificacion) VALUES ('f1', 'mo_x', '5W30', '', '2026-10-23')")).toThrow(/CHECK/);
    expect(() => db.exec("INSERT INTO cat_fichas (id, modelo_id, aceite_recomendado, fuente) VALUES ('f1', 'mo_x', '5W30', 'Manual del fabricante')")).toThrow(/NOT NULL/);
    db.exec("INSERT INTO cat_fichas (id, modelo_id, aceite_recomendado, fuente, fecha_verificacion) VALUES ('f1', 'mo_x', '5W30', 'Manual del fabricante', '2026-10-23')");
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });
  it('0018 no toca ningún dato y la base protege las operaciones rápidas (claves únicas, sólo consumo en OT o baja con motivo, historial que no se reescribe)', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const m of fs.readdirSync(path.join(RAIZ, 'migrations')).sort().filter((x) => x < '0018')) db.exec(leer('migrations', m));
    db.exec(leer('tests', 'fixtures', 'datos-previos-0002.sql'));
    db.exec("INSERT INTO vehiculos (id, taller_id, cliente_id, patente, km_actual) VALUES ('v1', 't1', 'c1', 'AB123CD', 1000)");
    db.exec("INSERT INTO ordenes (id, taller_id, numero, cliente_id, vehiculo_id, fecha_ingreso) VALUES ('o1', 't1', 1, 'c1', 'v1', '2026-10-26')");
    const tablas = ['clientes', 'vehiculos', 'ordenes', 'articulos', 'stock_movimientos', 'ventas', 'cobros'];
    const antes = tablas.map((t) => db.prepare(`SELECT * FROM ${t}`).all().map((r: any) => ({ ...r })));
    db.exec(leer('migrations', '0018_operaciones_rapidas.sql'));
    expect(tablas.map((t) => db.prepare(`SELECT * FROM ${t}`).all().map((r: any) => ({ ...r })))).toEqual(antes);
    for (const t of ['operaciones_rapidas', 'operacion_rapida_items']) expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n).toBe(0);

    const op = (id: string, extra: string) => `INSERT INTO operaciones_rapidas (id, taller_id, numero, tipo, fecha, ${extra.split('|')[0]}) VALUES ('${id}', 't1', 1, ${extra.split('|')[1]})`;
    // El consumo exige una orden; la baja exige un motivo y no lleva orden
    expect(() => db.exec(op('p0', "idem_key|'consumo_ot', '2026-10-26', 'clave-0001'"))).toThrow(/CHECK/);
    expect(() => db.exec(op('p0', "motivo, idem_key|'baja_interna', '2026-10-26', NULL, 'clave-0001'"))).toThrow(/CHECK/);
    expect(() => db.exec(op('p0', "orden_id, motivo, idem_key|'baja_interna', '2026-10-26', 'o1', 'rotura', 'clave-0001'"))).toThrow(/CHECK/);
    expect(() => db.exec(op('p0', "motivo, idem_key|'venta', '2026-10-26', 'rotura', 'clave-0001'"))).toThrow(/CHECK/);
    db.exec(op('p1', "orden_id, idem_key|'consumo_ot', '2026-10-26', 'o1', 'clave-0001'"));
    // Una clave de idempotencia se usa una sola vez por taller; la orden no puede ser de otro taller
    expect(() => db.exec("INSERT INTO operaciones_rapidas (id, taller_id, numero, tipo, fecha, orden_id, idem_key) VALUES ('p2', 't1', 2, 'consumo_ot', '2026-10-26', 'o1', 'clave-0001')")).toThrow(/UNIQUE/);
    expect(() => db.exec("INSERT INTO operaciones_rapidas (id, taller_id, numero, tipo, fecha, orden_id, idem_key) VALUES ('p2', 't2', 2, 'consumo_ot', '2026-10-26', 'o1', 'clave-0002')")).toThrow(/FOREIGN/);
    expect(() => db.exec("INSERT INTO operaciones_rapidas (id, taller_id, numero, tipo, fecha, orden_id, idem_key) VALUES ('p2', 't1', 2, 'consumo_ot', '2026-10-26', 'o1', 'corta')")).toThrow(/CHECK/);
    // Lo registrado no se reescribe
    expect(() => db.exec("UPDATE operaciones_rapidas SET notas = 'otra cosa' WHERE id = 'p1'")).toThrow(/inmutable/);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });
});
