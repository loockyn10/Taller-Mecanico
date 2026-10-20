-- Fierro · 0003 · Caja diaria, gastos y finanzas.
-- Migración ADITIVA. Los cobros y pagos a proveedores ya registrados se incorporan al libro de caja (backfill) sin sesión de caja.
--
-- Modelo:
--  * caja_movimientos es el LIBRO ÚNICO de movimientos de dinero (cobros, pagos a proveedores, gastos, otros ingresos).
--    Cada operación comercial inserta sus movimientos en el MISMO batch que la operación; el índice único
--    (taller_id, origen_tipo, origen_id) impide por diseño registrar dos veces el mismo hecho.
--  * Las anulaciones NO borran: generan un movimiento 'reverso' (contra-asiento) en la caja abierta del momento.
--  * Una caja (sesión) abierta por taller a la vez (índice único parcial). Los movimientos toman la sesión abierta
--    dentro de la misma sentencia, por lo que usuarios simultáneos no pueden quedar en cajas distintas.

ALTER TABLE taller_config ADD COLUMN caja_obligatoria INTEGER NOT NULL DEFAULT 0 CHECK (caja_obligatoria IN (0,1));

CREATE TABLE caja_sesiones (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  numero INTEGER NOT NULL,
  estado TEXT NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta','cerrada')),
  fecha TEXT NOT NULL,                       -- fecha comercial de apertura
  saldo_inicial INTEGER NOT NULL DEFAULT 0 CHECK (saldo_inicial >= 0),
  notas_apertura TEXT,
  abierta_por TEXT,
  abierta_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  cerrada_por TEXT,
  cerrada_at TEXT,
  notas_cierre TEXT,
  efectivo_esperado INTEGER,
  efectivo_declarado INTEGER,
  diferencia INTEGER,                        -- declarado - esperado (negativo = faltante)
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, numero)
);
CREATE UNIQUE INDEX idx_caja_abierta ON caja_sesiones(taller_id) WHERE estado = 'abierta';
CREATE INDEX idx_caja_sesiones_fecha ON caja_sesiones(taller_id, fecha);

-- Detalle del cierre por medio de pago (esperado vs. declarado).
CREATE TABLE caja_sesion_medios (
  taller_id TEXT NOT NULL,
  sesion_id TEXT NOT NULL,
  medio TEXT NOT NULL CHECK (medio IN ('efectivo','transferencia','debito','credito','cheque','otro')),
  esperado INTEGER NOT NULL,
  declarado INTEGER NOT NULL,
  diferencia INTEGER NOT NULL,
  PRIMARY KEY (taller_id, sesion_id, medio),
  FOREIGN KEY (taller_id, sesion_id) REFERENCES caja_sesiones(taller_id, id) ON DELETE CASCADE
);

-- Arqueos: conteos de efectivo durante la jornada (no cierran la caja).
CREATE TABLE caja_arqueos (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  sesion_id TEXT NOT NULL,
  esperado INTEGER NOT NULL,
  contado INTEGER NOT NULL CHECK (contado >= 0),
  diferencia INTEGER NOT NULL,               -- contado - esperado
  detalle TEXT,                              -- JSON opcional con el conteo por denominación
  notas TEXT,
  usuario_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  FOREIGN KEY (taller_id, sesion_id) REFERENCES caja_sesiones(taller_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_caja_arqueos_sesion ON caja_arqueos(taller_id, sesion_id);

CREATE TABLE categorias_gasto (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL COLLATE NOCASE,
  tipo TEXT NOT NULL DEFAULT 'operativo' CHECK (tipo IN ('operativo','fijo','impuestos','otro')),
  activa INTEGER NOT NULL DEFAULT 1 CHECK (activa IN (0,1)),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, nombre)
);

CREATE TABLE gastos (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  numero INTEGER NOT NULL,
  fecha TEXT NOT NULL,
  categoria_id TEXT NOT NULL,
  concepto TEXT NOT NULL,
  importe INTEGER NOT NULL CHECK (importe > 0),
  medio TEXT NOT NULL CHECK (medio IN ('efectivo','transferencia','debito','credito','cheque','otro')),
  referencia TEXT,
  proveedor_id TEXT,
  comprobante TEXT,
  estado TEXT NOT NULL DEFAULT 'registrado' CHECK (estado IN ('registrado','anulado')),
  anulado_motivo TEXT,
  recurrente_id TEXT,
  recurrente_fecha TEXT,                     -- ocurrencia del gasto recurrente que cubre
  idem_key TEXT NOT NULL,
  notas TEXT,
  usuario_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, numero),
  UNIQUE (taller_id, idem_key),
  FOREIGN KEY (taller_id, categoria_id) REFERENCES categorias_gasto(taller_id, id),
  FOREIGN KEY (taller_id, proveedor_id) REFERENCES proveedores(taller_id, id)
);
CREATE INDEX idx_gastos_fecha ON gastos(taller_id, fecha);
-- Una ocurrencia de un gasto recurrente se registra una sola vez.
CREATE UNIQUE INDEX idx_gastos_recurrente ON gastos(taller_id, recurrente_id, recurrente_fecha)
  WHERE recurrente_id IS NOT NULL AND estado = 'registrado';

CREATE TABLE gastos_recurrentes (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  categoria_id TEXT NOT NULL,
  concepto TEXT NOT NULL,
  importe INTEGER NOT NULL CHECK (importe > 0),
  medio TEXT NOT NULL CHECK (medio IN ('efectivo','transferencia','debito','credito','cheque','otro')),
  frecuencia TEXT NOT NULL CHECK (frecuencia IN ('semanal','mensual','bimestral','trimestral','anual')),
  dia INTEGER CHECK (dia IS NULL OR (dia >= 1 AND dia <= 31)),   -- día del mes preferido (frecuencias mensuales o mayores)
  proxima_fecha TEXT NOT NULL,
  activo INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0,1)),
  notas TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  FOREIGN KEY (taller_id, categoria_id) REFERENCES categorias_gasto(taller_id, id)
);

CREATE TABLE caja_movimientos (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  sesion_id TEXT,                            -- NULL = registrado sin caja abierta (sólo si la caja no es obligatoria)
  tipo TEXT NOT NULL CHECK (tipo IN ('ingreso','egreso')),
  rubro TEXT NOT NULL CHECK (rubro IN ('cobro','pago_proveedor','gasto','otro_ingreso')),
  medio TEXT NOT NULL CHECK (medio IN ('efectivo','transferencia','debito','credito','cheque','otro')),
  importe INTEGER NOT NULL CHECK (importe > 0),
  concepto TEXT NOT NULL,
  referencia TEXT,
  origen_tipo TEXT NOT NULL CHECK (origen_tipo IN ('cobro','pago_proveedor','gasto','manual','reverso')),
  origen_id TEXT NOT NULL,                   -- cobro_medios.id | pagos_proveedor.id | gastos.id | movimiento.id (manual / reverso)
  fecha TEXT NOT NULL,
  idem_key TEXT,
  usuario_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  FOREIGN KEY (taller_id, sesion_id) REFERENCES caja_sesiones(taller_id, id)
);
-- Antiduplicación: un hecho de origen genera como máximo un movimiento (y un reverso por movimiento).
CREATE UNIQUE INDEX idx_caja_mov_origen ON caja_movimientos(taller_id, origen_tipo, origen_id);
CREATE UNIQUE INDEX idx_caja_mov_idem ON caja_movimientos(taller_id, idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX idx_caja_mov_sesion ON caja_movimientos(taller_id, sesion_id);
CREATE INDEX idx_caja_mov_fecha ON caja_movimientos(taller_id, fecha);

-- ───── Datos existentes ─────
-- Categorías de gasto iniciales para los talleres ya creados (los nuevos las reciben al darse de alta).
-- (D1 limita los SELECT compuestos: una sentencia por categoría.)
INSERT INTO categorias_gasto (id, taller_id, nombre, tipo) SELECT lower(hex(randomblob(16))), id, 'Alquiler', 'fijo' FROM talleres;
INSERT INTO categorias_gasto (id, taller_id, nombre, tipo) SELECT lower(hex(randomblob(16))), id, 'Servicios (luz, agua, internet)', 'fijo' FROM talleres;
INSERT INTO categorias_gasto (id, taller_id, nombre, tipo) SELECT lower(hex(randomblob(16))), id, 'Sueldos y jornales', 'fijo' FROM talleres;
INSERT INTO categorias_gasto (id, taller_id, nombre, tipo) SELECT lower(hex(randomblob(16))), id, 'Impuestos y tasas', 'impuestos' FROM talleres;
INSERT INTO categorias_gasto (id, taller_id, nombre, tipo) SELECT lower(hex(randomblob(16))), id, 'Insumos de taller', 'operativo' FROM talleres;
INSERT INTO categorias_gasto (id, taller_id, nombre, tipo) SELECT lower(hex(randomblob(16))), id, 'Herramientas y equipos', 'operativo' FROM talleres;
INSERT INTO categorias_gasto (id, taller_id, nombre, tipo) SELECT lower(hex(randomblob(16))), id, 'Mantenimiento', 'operativo' FROM talleres;
INSERT INTO categorias_gasto (id, taller_id, nombre, tipo) SELECT lower(hex(randomblob(16))), id, 'Limpieza', 'operativo' FROM talleres;
INSERT INTO categorias_gasto (id, taller_id, nombre, tipo) SELECT lower(hex(randomblob(16))), id, 'Combustible y fletes', 'operativo' FROM talleres;
INSERT INTO categorias_gasto (id, taller_id, nombre, tipo) SELECT lower(hex(randomblob(16))), id, 'Publicidad', 'fijo' FROM talleres;
INSERT INTO categorias_gasto (id, taller_id, nombre, tipo) SELECT lower(hex(randomblob(16))), id, 'Varios', 'otro' FROM talleres;

-- Cobros vigentes → ingresos de caja (sin sesión: son anteriores al módulo).
INSERT INTO caja_movimientos (id, taller_id, sesion_id, tipo, rubro, medio, importe, concepto, referencia, origen_tipo, origen_id, fecha, usuario_id, created_at)
SELECT lower(hex(randomblob(16))), cm.taller_id, NULL, 'ingreso', 'cobro', cm.medio, cm.importe,
       'Cobro #' || co.numero || ' · ' || cl.nombre, cm.referencia, 'cobro', cm.id, co.fecha, co.usuario_id, co.created_at
  FROM cobro_medios cm
  JOIN cobros co ON co.taller_id = cm.taller_id AND co.id = cm.cobro_id
  JOIN clientes cl ON cl.taller_id = co.taller_id AND cl.id = co.cliente_id
 WHERE co.estado = 'registrado';

-- Pagos a proveedores vigentes → egresos de caja.
INSERT INTO caja_movimientos (id, taller_id, sesion_id, tipo, rubro, medio, importe, concepto, referencia, origen_tipo, origen_id, fecha, usuario_id, created_at)
SELECT lower(hex(randomblob(16))), pp.taller_id, NULL, 'egreso', 'pago_proveedor', pp.medio, pp.importe,
       'Pago #' || pp.numero || ' a ' || p.nombre, pp.referencia, 'pago_proveedor', pp.id, pp.fecha, pp.usuario_id, pp.created_at
  FROM pagos_proveedor pp
  JOIN proveedores p ON p.taller_id = pp.taller_id AND p.id = pp.proveedor_id
 WHERE pp.estado = 'registrado';
