-- Datos "de producción" previos a las migraciones 0002-0004 (esquema 0001).
INSERT INTO talleres (id, nombre) VALUES ('t1', 'Taller Viejo'), ('t2', 'Taller Viejo 2');
INSERT INTO taller_config (taller_id) VALUES ('t1'), ('t2');
INSERT INTO usuarios (id, taller_id, email, nombre, rol, password_hash) VALUES ('u1', 't1', 'a@a.com', 'Dueño', 'propietario', 'x');
INSERT INTO clientes (id, taller_id, codigo, nombre) VALUES ('c1', 't1', 1, 'Ana Gómez'), ('c2', 't2', 1, 'Otro');
INSERT INTO proveedores (id, taller_id, nombre) VALUES ('p1', 't1', 'Proveedor Viejo');
INSERT INTO articulos (id, taller_id, nombre, stock, stock_minimo, costo, precio) VALUES ('a1', 't1', 'Aceite', 0.19999999999999998, 0.30000000000000004, 1000, 2000);
INSERT INTO stock_movimientos (id, taller_id, articulo_id, tipo, cantidad, stock_resultante) VALUES ('m1', 't1', 'a1', 'entrada', 0.30000000000000004, 0.30000000000000004);
INSERT INTO ventas (id, taller_id, numero, cliente_id, fecha, total, cobrado) VALUES ('v1', 't1', 1, 'c1', '2026-05-01', 10000, 10000), ('v2', 't1', 2, 'c1', '2026-05-02', 5000, 0);
INSERT INTO cobros (id, taller_id, numero, cliente_id, fecha, total, estado, idem_key, usuario_id) VALUES
  ('co1', 't1', 1, 'c1', '2026-05-01', 10000, 'registrado', 'k1', 'u1'),
  ('co2', 't1', 2, 'c1', '2026-05-02', 3000, 'anulado', 'k2', 'u1');
INSERT INTO cobro_medios (id, taller_id, cobro_id, medio, importe, referencia) VALUES
  ('cm1', 't1', 'co1', 'efectivo', 6000, NULL), ('cm2', 't1', 'co1', 'transferencia', 4000, 'OP-1'), ('cm3', 't1', 'co2', 'efectivo', 3000, NULL);
INSERT INTO cobro_aplicaciones (id, taller_id, cobro_id, venta_id, importe) VALUES ('ca1', 't1', 'co1', 'v1', 10000);
INSERT INTO compras (id, taller_id, numero, proveedor_id, fecha, total) VALUES ('cp1', 't1', 1, 'p1', '2026-05-01', 8000);
INSERT INTO compra_items (id, taller_id, compra_id, articulo_id, cantidad, costo_unitario, subtotal) VALUES ('ci1', 't1', 'cp1', 'a1', 8, 1000, 8000);
INSERT INTO pagos_proveedor (id, taller_id, numero, proveedor_id, fecha, importe, medio, estado, idem_key, usuario_id) VALUES
  ('pp1', 't1', 1, 'p1', '2026-05-03', 2000, 'efectivo', 'registrado', 'kp1', 'u1'),
  ('pp2', 't1', 2, 'p1', '2026-05-04', 500, 'transferencia', 'anulado', 'kp2', 'u1');
