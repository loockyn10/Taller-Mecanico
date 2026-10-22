-- Fierro · Sprint 09: devoluciones parciales (nota de crédito comercial interna), anticipos de clientes, costo de mano de obra y
-- stock mínimo por depósito.
-- Migración ADITIVA para los datos de negocio: nada se elimina ni se reescribe. La única tabla reconstruida es caja_movimientos
-- (para admitir el rubro `devolucion` y el origen `reintegro`); se copia completa y ninguna otra tabla la referencia (igual que en la 0005).
--
-- Modelo comercial
--  * Una DEVOLUCIÓN (nota de crédito interna, NO fiscal) nace siempre de un comprobante (`ventas`) y de sus ítems. Nunca modifica el
--    comprobante original: solo registra `ventas.devuelto` (acumulado devuelto). Saldo pendiente de un comprobante = total − devuelto − cobrado.
--  * El importe de la devolución se reparte en dos partes: `a_deuda` (cancela deuda todavía impaga del comprobante) y `liberado` (la parte que el cliente ya había
--    pagado: se "libera" del comprobante, baja `ventas.cobrado` y pasa a ser dinero a favor del cliente). Ese dinero se reintegra por un medio de pago
--    (`reintegros`) y/o queda como saldo a favor, aplicable después a otro comprobante (`credito_aplicaciones`).
--  * Un ANTICIPO es un cobro (`cobros.tipo = 'anticipo'`) que todavía no se aplica a ningún comprobante: reutiliza todo el circuito de cobros
--    (caja, banco, cheques, recibo, cuenta corriente). Se aplica después, total o parcialmente, a uno o varios comprobantes sin mover dinero.
--  * Cuenta corriente del cliente: debe = comprobantes + reintegros; haber = cobros (incluidos anticipos) + devoluciones.
--    Saldo negativo = saldo a favor del cliente.

-- ───────────── caja_movimientos: rubro `devolucion` y origen `reintegro` ─────────────
CREATE TABLE caja_movimientos_nueva (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  sesion_id TEXT,
  tipo TEXT NOT NULL CHECK (tipo IN ('ingreso','egreso')),
  rubro TEXT NOT NULL CHECK (rubro IN ('cobro','pago_proveedor','gasto','otro_ingreso','traspaso','devolucion')),
  medio TEXT NOT NULL CHECK (medio IN ('efectivo','transferencia','debito','credito','cheque','otro')),
  importe INTEGER NOT NULL CHECK (importe > 0),
  concepto TEXT NOT NULL,
  referencia TEXT,
  origen_tipo TEXT NOT NULL CHECK (origen_tipo IN ('cobro','pago_proveedor','gasto','manual','reverso','banco','reintegro')),
  origen_id TEXT NOT NULL,
  fecha TEXT NOT NULL,
  idem_key TEXT,
  usuario_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  FOREIGN KEY (taller_id, sesion_id) REFERENCES caja_sesiones(taller_id, id)
);
INSERT INTO caja_movimientos_nueva (id, taller_id, sesion_id, tipo, rubro, medio, importe, concepto, referencia, origen_tipo, origen_id, fecha, idem_key, usuario_id, created_at)
  SELECT id, taller_id, sesion_id, tipo, rubro, medio, importe, concepto, referencia, origen_tipo, origen_id, fecha, idem_key, usuario_id, created_at FROM caja_movimientos;
DROP TABLE caja_movimientos;
ALTER TABLE caja_movimientos_nueva RENAME TO caja_movimientos;
CREATE UNIQUE INDEX idx_caja_mov_origen ON caja_movimientos(taller_id, origen_tipo, origen_id);
CREATE UNIQUE INDEX idx_caja_mov_idem ON caja_movimientos(taller_id, idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX idx_caja_mov_sesion ON caja_movimientos(taller_id, sesion_id);
CREATE INDEX idx_caja_mov_fecha ON caja_movimientos(taller_id, fecha);

-- ───────────── banco_movimientos: categoría `devolucion` (reintegros acreditados/debitados en una cuenta) ─────────────
CREATE TABLE banco_movimientos_nueva (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  cuenta_id TEXT NOT NULL,
  fecha TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('ingreso','egreso')),
  categoria TEXT NOT NULL CHECK (categoria IN ('cobro','pago_proveedor','gasto','deposito','extraccion','transferencia','cheque','manual','ajuste','reverso','devolucion')),
  importe INTEGER NOT NULL CHECK (importe > 0),
  concepto TEXT NOT NULL,
  referencia TEXT,
  origen_tipo TEXT NOT NULL,
  origen_id TEXT NOT NULL,
  transferencia_id TEXT,
  afecta_resultado INTEGER NOT NULL DEFAULT 0 CHECK (afecta_resultado IN (0,1)),
  conciliado INTEGER NOT NULL DEFAULT 0 CHECK (conciliado IN (0,1)),
  conciliacion_id TEXT,
  conciliado_at TEXT,
  idem_key TEXT,
  usuario_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  FOREIGN KEY (taller_id, cuenta_id) REFERENCES cuentas_bancarias(taller_id, id),
  FOREIGN KEY (taller_id, conciliacion_id) REFERENCES conciliaciones(taller_id, id)
);
INSERT INTO banco_movimientos_nueva (id, taller_id, cuenta_id, fecha, tipo, categoria, importe, concepto, referencia, origen_tipo, origen_id, transferencia_id, afecta_resultado, conciliado, conciliacion_id, conciliado_at, idem_key, usuario_id, created_at)
  SELECT id, taller_id, cuenta_id, fecha, tipo, categoria, importe, concepto, referencia, origen_tipo, origen_id, transferencia_id, afecta_resultado, conciliado, conciliacion_id, conciliado_at, idem_key, usuario_id, created_at FROM banco_movimientos;
DROP TABLE banco_movimientos;
ALTER TABLE banco_movimientos_nueva RENAME TO banco_movimientos;
CREATE UNIQUE INDEX idx_banco_mov_origen ON banco_movimientos(taller_id, origen_tipo, origen_id);
CREATE UNIQUE INDEX idx_banco_mov_idem ON banco_movimientos(taller_id, idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX idx_banco_mov_cuenta ON banco_movimientos(taller_id, cuenta_id, fecha);
CREATE INDEX idx_banco_mov_concil ON banco_movimientos(taller_id, conciliacion_id);

-- ───────────── Comprobantes: acumulado devuelto ─────────────
-- cobrado + devuelto <= total: la base impide cobrar o devolver más de lo vendido, aun con solicitudes simultáneas.
ALTER TABLE ventas ADD COLUMN devuelto INTEGER NOT NULL DEFAULT 0 CHECK (devuelto >= 0 AND cobrado + devuelto <= total);

-- ───────────── Anticipos (cobros que todavía no se aplicaron) ─────────────
ALTER TABLE cobros ADD COLUMN tipo TEXT NOT NULL DEFAULT 'cobro' CHECK (tipo IN ('cobro','anticipo'));
ALTER TABLE cobros ADD COLUMN orden_id TEXT;          -- OT a la que se asocia el anticipo (sin FK: lo valida la API)
ALTER TABLE cobros ADD COLUMN presupuesto_id TEXT;    -- presupuesto al que se asocia el anticipo
-- Cuánto del anticipo ya se aplicó a comprobantes y cuánto se devolvió en dinero. aplicado + devuelto <= total: no se puede aplicar dos veces.
ALTER TABLE cobros ADD COLUMN credito_aplicado INTEGER NOT NULL DEFAULT 0 CHECK (credito_aplicado >= 0);
ALTER TABLE cobros ADD COLUMN devuelto INTEGER NOT NULL DEFAULT 0 CHECK (devuelto >= 0 AND credito_aplicado + devuelto <= total);
CREATE INDEX idx_cobros_anticipo_orden ON cobros(taller_id, orden_id) WHERE orden_id IS NOT NULL;
CREATE INDEX idx_cobros_anticipo_presupuesto ON cobros(taller_id, presupuesto_id) WHERE presupuesto_id IS NOT NULL;

-- ───────────── Devoluciones (nota de crédito comercial interna) ─────────────
CREATE TABLE devoluciones (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  numero INTEGER NOT NULL,
  venta_id TEXT NOT NULL,
  cliente_id TEXT NOT NULL,
  orden_id TEXT,                                   -- OT del comprobante original (si tenía)
  fecha TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'registrada' CHECK (estado IN ('registrada','anulada')),
  motivo TEXT NOT NULL,
  total INTEGER NOT NULL CHECK (total > 0),        -- crédito al cliente, con impuestos
  neto INTEGER NOT NULL DEFAULT 0,                 -- parte sin IVA (proporcional al comprobante)
  iva INTEGER NOT NULL DEFAULT 0,
  a_deuda INTEGER NOT NULL DEFAULT 0 CHECK (a_deuda >= 0),   -- cancela deuda impaga del comprobante
  liberado INTEGER NOT NULL DEFAULT 0 CHECK (liberado >= 0), -- ya estaba pagado: pasa a ser dinero a favor del cliente
  reintegrado INTEGER NOT NULL DEFAULT 0 CHECK (reintegrado >= 0),
  credito_aplicado INTEGER NOT NULL DEFAULT 0 CHECK (credito_aplicado >= 0),
  idem_key TEXT NOT NULL,
  usuario_id TEXT,
  anulada_motivo TEXT,
  anulada_por TEXT,
  anulada_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, numero),
  UNIQUE (taller_id, idem_key),
  CHECK (a_deuda + liberado = total),
  CHECK (reintegrado + credito_aplicado <= liberado),
  FOREIGN KEY (taller_id, venta_id) REFERENCES ventas(taller_id, id),
  FOREIGN KEY (taller_id, cliente_id) REFERENCES clientes(taller_id, id)
);
CREATE INDEX idx_devoluciones_venta ON devoluciones(taller_id, venta_id);
CREATE INDEX idx_devoluciones_cliente ON devoluciones(taller_id, cliente_id);
CREATE INDEX idx_devoluciones_fecha ON devoluciones(taller_id, fecha);

CREATE TABLE devolucion_items (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  devolucion_id TEXT NOT NULL,
  venta_item_id TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('articulo','servicio','libre')),
  articulo_id TEXT,
  servicio_id TEXT,
  descripcion TEXT NOT NULL,
  cantidad REAL NOT NULL CHECK (cantidad > 0),
  subtotal INTEGER NOT NULL CHECK (subtotal >= 0),      -- mismo criterio que venta_items.subtotal (antes de descuento global e impuestos)
  importe INTEGER NOT NULL CHECK (importe >= 0),        -- crédito al cliente por la línea, con impuestos
  importe_neto INTEGER NOT NULL DEFAULT 0,              -- sin IVA (para márgenes)
  valor_origen INTEGER NOT NULL,                        -- importe máximo devolvible de la línea vendida (tope)
  costo_unitario INTEGER,                               -- costo con el que se vendió (histórico)
  reingresa INTEGER NOT NULL DEFAULT 0 CHECK (reingresa IN (0,1)),
  deposito_id TEXT,                                     -- depósito al que vuelve (NULL con reingresa = depósito principal)
  FOREIGN KEY (taller_id, devolucion_id) REFERENCES devoluciones(taller_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_devolucion_items_dev ON devolucion_items(taller_id, devolucion_id);
CREATE INDEX idx_devolucion_items_linea ON devolucion_items(taller_id, venta_item_id);

-- ───────────── Reintegros de dinero al cliente (devolución de una nota de crédito o de un anticipo) ─────────────
CREATE TABLE reintegros (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  numero INTEGER NOT NULL,
  cliente_id TEXT NOT NULL,
  origen_tipo TEXT NOT NULL CHECK (origen_tipo IN ('devolucion','anticipo')),
  origen_id TEXT NOT NULL,                          -- devoluciones.id o cobros.id (el anticipo)
  fecha TEXT NOT NULL,
  total INTEGER NOT NULL CHECK (total > 0),
  estado TEXT NOT NULL DEFAULT 'registrado' CHECK (estado IN ('registrado','anulado')),
  motivo TEXT,
  anulado_motivo TEXT,
  idem_key TEXT NOT NULL,
  usuario_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, numero),
  UNIQUE (taller_id, idem_key),
  FOREIGN KEY (taller_id, cliente_id) REFERENCES clientes(taller_id, id)
);
CREATE INDEX idx_reintegros_origen ON reintegros(taller_id, origen_tipo, origen_id);
CREATE INDEX idx_reintegros_cliente ON reintegros(taller_id, cliente_id);
CREATE TABLE reintegro_medios (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  reintegro_id TEXT NOT NULL,
  medio TEXT NOT NULL CHECK (medio IN ('efectivo','transferencia','debito','credito','otro')),
  importe INTEGER NOT NULL CHECK (importe > 0),
  referencia TEXT,
  cuenta_id TEXT,
  FOREIGN KEY (taller_id, reintegro_id) REFERENCES reintegros(taller_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_reintegro_medios ON reintegro_medios(taller_id, reintegro_id);

-- ───────────── Aplicación de saldo a favor (anticipos y créditos de devoluciones) a comprobantes ─────────────
CREATE TABLE credito_aplicaciones (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  venta_id TEXT NOT NULL,
  origen_tipo TEXT NOT NULL CHECK (origen_tipo IN ('anticipo','devolucion')),
  origen_id TEXT NOT NULL,
  importe INTEGER NOT NULL CHECK (importe > 0),
  fecha TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'vigente' CHECK (estado IN ('vigente','anulada')),
  idem_key TEXT NOT NULL,
  usuario_id TEXT,
  anulada_motivo TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, idem_key),
  FOREIGN KEY (taller_id, venta_id) REFERENCES ventas(taller_id, id)
);
CREATE INDEX idx_credito_aplic_venta ON credito_aplicaciones(taller_id, venta_id);
CREATE INDEX idx_credito_aplic_origen ON credito_aplicaciones(taller_id, origen_tipo, origen_id);

-- ───────────── Costo de mano de obra ─────────────
-- Costo horario INTERNO (confidencial): por persona y un costo general del taller para quien no tenga uno propio.
-- NULL = sin configurar (la rentabilidad se informa como parcial; nunca se asume cero).
ALTER TABLE usuarios ADD COLUMN costo_hora INTEGER CHECK (costo_hora IS NULL OR costo_hora >= 0);
ALTER TABLE taller_config ADD COLUMN costo_hora_general INTEGER CHECK (costo_hora_general IS NULL OR costo_hora_general >= 0);
-- Cada tramo del cronómetro de la OT (el mismo `orden_tiempos` del Sprint 06/07) congela el costo horario vigente al cerrarse:
-- cambiar los costos configurados después no altera la rentabilidad de lo ya trabajado.
ALTER TABLE orden_tiempos ADD COLUMN costo_hora INTEGER;
ALTER TABLE orden_tiempos ADD COLUMN costo_origen TEXT CHECK (costo_origen IS NULL OR costo_origen IN ('persona','general'));
CREATE TRIGGER trg_orden_tiempos_costo AFTER UPDATE OF fin_at ON orden_tiempos
WHEN OLD.fin_at IS NULL AND NEW.fin_at IS NOT NULL
BEGIN
  UPDATE orden_tiempos SET
    costo_hora = COALESCE(
      (SELECT u.costo_hora FROM usuarios u WHERE u.taller_id = NEW.taller_id AND u.id = NEW.usuario_id),
      (SELECT c.costo_hora_general FROM taller_config c WHERE c.taller_id = NEW.taller_id)),
    costo_origen = CASE
      WHEN (SELECT u.costo_hora FROM usuarios u WHERE u.taller_id = NEW.taller_id AND u.id = NEW.usuario_id) IS NOT NULL THEN 'persona'
      WHEN (SELECT c.costo_hora_general FROM taller_config c WHERE c.taller_id = NEW.taller_id) IS NOT NULL THEN 'general'
      ELSE NULL END
  WHERE id = NEW.id;
END;
-- Estimación de mano de obra congelada cuando la OT queda lista/entregada (se borra si se reabre y se vuelve a congelar al cerrarla).
ALTER TABLE ordenes ADD COLUMN mo_estimado_at TEXT;
ALTER TABLE ordenes ADD COLUMN mo_costo_estimado INTEGER;
ALTER TABLE ordenes ADD COLUMN mo_estimado_completo INTEGER CHECK (mo_estimado_completo IS NULL OR mo_estimado_completo IN (0,1));

-- ───────────── Stock mínimo por depósito ─────────────
-- Complementa al mínimo general del artículo (`articulos.stock_minimo`, sobre el total): ambos pueden coexistir.
CREATE TABLE stock_minimos_deposito (
  taller_id TEXT NOT NULL,
  articulo_id TEXT NOT NULL,
  deposito_id TEXT NOT NULL,
  minimo REAL NOT NULL CHECK (minimo >= 0),
  objetivo REAL CHECK (objetivo IS NULL OR objetivo >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (taller_id, articulo_id, deposito_id),
  FOREIGN KEY (taller_id, articulo_id) REFERENCES articulos(taller_id, id),
  FOREIGN KEY (taller_id, deposito_id) REFERENCES depositos(taller_id, id)
);
CREATE INDEX idx_stock_minimos_deposito ON stock_minimos_deposito(taller_id, deposito_id);
