-- Fierro · 0005 · Bancos, cheques, compras avanzadas, inventario avanzado y configuración administrativa.
-- Migración ADITIVA: no se pierden datos. La única tabla reconstruida es caja_movimientos (para admitir el rubro 'traspaso'
-- y el origen 'banco'); se copia completa y ninguna otra tabla la referencia.
--
-- Modelo:
--  * banco_movimientos es el libro de cada cuenta bancaria. Cuando un cobro, un pago o un gasto se asigna a una cuenta,
--    su movimiento bancario se inserta en el MISMO batch con (origen_tipo, origen_id) único: un hecho = un movimiento.
--  * afecta_resultado = 1 sólo en movimientos que NO pasaron por el libro de caja (comisiones, intereses): el resto
--    (cobros, pagos, depósitos, transferencias, cheques) mueve plata entre lugares pero no es un ingreso/egreso nuevo.
--  * Un depósito/extracción mueve efectivo de la caja: asienta un 'traspaso' en caja_movimientos (no es ingreso ni egreso).

-- ───────────── caja_movimientos: admitir traspasos a/desde banco ─────────────
CREATE TABLE caja_movimientos_nueva (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  sesion_id TEXT,
  tipo TEXT NOT NULL CHECK (tipo IN ('ingreso','egreso')),
  rubro TEXT NOT NULL CHECK (rubro IN ('cobro','pago_proveedor','gasto','otro_ingreso','traspaso')),
  medio TEXT NOT NULL CHECK (medio IN ('efectivo','transferencia','debito','credito','cheque','otro')),
  importe INTEGER NOT NULL CHECK (importe > 0),
  concepto TEXT NOT NULL,
  referencia TEXT,
  origen_tipo TEXT NOT NULL CHECK (origen_tipo IN ('cobro','pago_proveedor','gasto','manual','reverso','banco')),
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

-- ───────────── Bancos ─────────────
CREATE TABLE cuentas_bancarias (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL COLLATE NOCASE,
  banco TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'cuenta_corriente' CHECK (tipo IN ('cuenta_corriente','caja_ahorro','billetera_virtual','otra')),
  alias TEXT,
  cbu TEXT,
  titular TEXT,
  cuit_titular TEXT,
  moneda TEXT NOT NULL DEFAULT 'ARS' CHECK (moneda IN ('ARS','USD')),
  saldo_inicial INTEGER NOT NULL DEFAULT 0,
  fecha_saldo_inicial TEXT,
  activa INTEGER NOT NULL DEFAULT 1 CHECK (activa IN (0,1)),
  notas TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, nombre)
);

CREATE TABLE conciliaciones (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  numero INTEGER NOT NULL,
  cuenta_id TEXT NOT NULL,
  fecha_corte TEXT NOT NULL,
  saldo_extracto INTEGER NOT NULL,
  saldo_libros INTEGER NOT NULL,             -- saldo inicial + movimientos conciliados (incluidos los de esta conciliación)
  diferencia INTEGER NOT NULL,               -- extracto - libros
  cantidad INTEGER NOT NULL,
  notas TEXT,
  estado TEXT NOT NULL DEFAULT 'vigente' CHECK (estado IN ('vigente','deshecha')),
  deshecha_at TEXT,
  usuario_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, numero),
  FOREIGN KEY (taller_id, cuenta_id) REFERENCES cuentas_bancarias(taller_id, id)
);

CREATE TABLE banco_movimientos (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  cuenta_id TEXT NOT NULL,
  fecha TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('ingreso','egreso')),
  categoria TEXT NOT NULL CHECK (categoria IN ('cobro','pago_proveedor','gasto','deposito','extraccion','transferencia','cheque','manual','ajuste','reverso')),
  importe INTEGER NOT NULL CHECK (importe > 0),
  concepto TEXT NOT NULL,
  referencia TEXT,
  origen_tipo TEXT NOT NULL,                 -- cobro_medio | pago_proveedor | gasto | deposito | extraccion | transferencia_sal | transferencia_ent | cheque | manual | ajuste | reverso
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
-- Antiduplicación: un hecho de origen genera como máximo un movimiento bancario (y un reverso por movimiento).
CREATE UNIQUE INDEX idx_banco_mov_origen ON banco_movimientos(taller_id, origen_tipo, origen_id);
CREATE UNIQUE INDEX idx_banco_mov_idem ON banco_movimientos(taller_id, idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX idx_banco_mov_cuenta ON banco_movimientos(taller_id, cuenta_id, fecha);
CREATE INDEX idx_banco_mov_concil ON banco_movimientos(taller_id, conciliacion_id);

-- Cuenta bancaria asignada a los medios no-efectivo de cobros, pagos y gastos (sin FK: SQLite no la admite en ALTER;
-- la API valida y banco_movimientos tiene la FK compuesta que impide cuentas de otro taller).
ALTER TABLE cobro_medios ADD COLUMN cuenta_id TEXT;
ALTER TABLE pagos_proveedor ADD COLUMN cuenta_id TEXT;
ALTER TABLE gastos ADD COLUMN cuenta_id TEXT;

-- ───────────── Cheques y eCheq ─────────────
CREATE TABLE cheques (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  numero INTEGER NOT NULL,
  direccion TEXT NOT NULL CHECK (direccion IN ('recibido','emitido')),
  modalidad TEXT NOT NULL DEFAULT 'fisico' CHECK (modalidad IN ('fisico','echeq')),
  banco TEXT NOT NULL,
  nro_cheque TEXT NOT NULL,
  echeq_id TEXT,
  librador TEXT,
  cuit TEXT,
  beneficiario TEXT,
  importe INTEGER NOT NULL CHECK (importe > 0),
  fecha_emision TEXT NOT NULL,
  fecha_pago TEXT NOT NULL,
  fecha_vencimiento TEXT NOT NULL,           -- último día para depositarlo / presentarlo
  estado TEXT NOT NULL DEFAULT 'en_cartera' CHECK (estado IN ('en_cartera','depositado','entregado','acreditado','rechazado','anulado')),
  cliente_id TEXT,
  proveedor_id TEXT,
  cuenta_id TEXT,                            -- recibido: cuenta de depósito · emitido: cuenta librada
  origen_tipo TEXT NOT NULL DEFAULT 'manual' CHECK (origen_tipo IN ('manual','cobro_medio','pago_proveedor','gasto')),
  origen_id TEXT,
  entrega_pago_id TEXT,                      -- recibido endosado a un proveedor: pago que lo canceló
  motivo_rechazo TEXT,
  observaciones TEXT,
  usuario_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, numero),
  FOREIGN KEY (taller_id, cliente_id) REFERENCES clientes(taller_id, id),
  FOREIGN KEY (taller_id, proveedor_id) REFERENCES proveedores(taller_id, id),
  FOREIGN KEY (taller_id, cuenta_id) REFERENCES cuentas_bancarias(taller_id, id)
);
CREATE UNIQUE INDEX idx_cheques_origen ON cheques(taller_id, origen_tipo, origen_id) WHERE origen_id IS NOT NULL;
-- El mismo cheque (banco + número + librador) no se registra dos veces, salvo que el anterior esté anulado.
CREATE UNIQUE INDEX idx_cheques_duplicado ON cheques(taller_id, direccion, lower(banco), nro_cheque, COALESCE(cuit, '')) WHERE estado <> 'anulado';
CREATE INDEX idx_cheques_estado ON cheques(taller_id, estado, fecha_pago);

CREATE TABLE cheque_eventos (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  cheque_id TEXT NOT NULL,
  estado_desde TEXT,
  estado_hacia TEXT NOT NULL,
  fecha TEXT NOT NULL,
  detalle TEXT,
  banco_mov_id TEXT,
  usuario_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (taller_id, cheque_id) REFERENCES cheques(taller_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_cheque_eventos ON cheque_eventos(taller_id, cheque_id, created_at);

-- ───────────── Compras avanzadas ─────────────
ALTER TABLE compras ADD COLUMN vencimiento TEXT;

CREATE TABLE ordenes_compra (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  numero INTEGER NOT NULL,
  proveedor_id TEXT NOT NULL,
  fecha TEXT NOT NULL,
  fecha_prevista TEXT,
  estado TEXT NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador','pendiente','parcial','recibida','cancelada')),
  descuento_pct REAL NOT NULL DEFAULT 0,
  iva_pct REAL NOT NULL DEFAULT 0,
  subtotal INTEGER NOT NULL DEFAULT 0,
  descuento INTEGER NOT NULL DEFAULT 0,
  neto INTEGER NOT NULL DEFAULT 0,
  iva INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  actualizar_costos INTEGER NOT NULL DEFAULT 1,
  cerrada_con_faltante INTEGER NOT NULL DEFAULT 0,
  observaciones TEXT,
  motivo_cancelacion TEXT,
  origen TEXT,                               -- 'reposicion' cuando se generó desde sugerencias de reposición
  idem_key TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, numero),
  FOREIGN KEY (taller_id, proveedor_id) REFERENCES proveedores(taller_id, id)
);
CREATE INDEX idx_oc_estado ON ordenes_compra(taller_id, estado);
CREATE UNIQUE INDEX idx_oc_idem ON ordenes_compra(taller_id, idem_key) WHERE idem_key IS NOT NULL;

CREATE TABLE orden_compra_items (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  orden_id TEXT NOT NULL,
  articulo_id TEXT NOT NULL,
  posicion INTEGER NOT NULL DEFAULT 0,
  cantidad REAL NOT NULL CHECK (cantidad > 0),
  cantidad_recibida REAL NOT NULL DEFAULT 0 CHECK (cantidad_recibida >= 0 AND cantidad_recibida <= cantidad + 0.0005),
  costo_unitario INTEGER NOT NULL CHECK (costo_unitario >= 0),
  desc_pct REAL NOT NULL DEFAULT 0,
  subtotal INTEGER NOT NULL,
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, orden_id, articulo_id),
  FOREIGN KEY (taller_id, orden_id) REFERENCES ordenes_compra(taller_id, id) ON DELETE CASCADE,
  FOREIGN KEY (taller_id, articulo_id) REFERENCES articulos(taller_id, id)
);

CREATE TABLE recepciones (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  numero INTEGER NOT NULL,
  orden_id TEXT NOT NULL,
  proveedor_id TEXT NOT NULL,
  fecha TEXT NOT NULL,
  remito TEXT,                               -- N° de remito del proveedor
  estado TEXT NOT NULL DEFAULT 'registrada' CHECK (estado IN ('registrada','anulada')),
  notas TEXT,
  idem_key TEXT NOT NULL,
  usuario_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, numero),
  UNIQUE (taller_id, idem_key),
  FOREIGN KEY (taller_id, orden_id) REFERENCES ordenes_compra(taller_id, id),
  FOREIGN KEY (taller_id, proveedor_id) REFERENCES proveedores(taller_id, id)
);
-- Un mismo remito de un proveedor no se carga dos veces.
CREATE UNIQUE INDEX idx_recepciones_remito ON recepciones(taller_id, proveedor_id, remito) WHERE remito IS NOT NULL AND estado = 'registrada';

CREATE TABLE recepcion_items (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  recepcion_id TEXT NOT NULL,
  orden_item_id TEXT NOT NULL,
  articulo_id TEXT NOT NULL,
  pendiente_antes REAL NOT NULL,             -- lo que faltaba recibir al momento de la recepción
  cantidad REAL NOT NULL CHECK (cantidad > 0),
  diferencia REAL NOT NULL,                  -- cantidad - pendiente_antes (negativa = faltante)
  costo_unitario INTEGER NOT NULL,
  costo_anterior INTEGER,
  costo_aplicado INTEGER NOT NULL DEFAULT 0,
  UNIQUE (taller_id, id),
  FOREIGN KEY (taller_id, recepcion_id) REFERENCES recepciones(taller_id, id) ON DELETE CASCADE,
  FOREIGN KEY (taller_id, orden_item_id) REFERENCES orden_compra_items(taller_id, id),
  FOREIGN KEY (taller_id, articulo_id) REFERENCES articulos(taller_id, id)
);

CREATE TABLE facturas_proveedor (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  numero INTEGER NOT NULL,
  proveedor_id TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('factura_a','factura_b','factura_c','factura_m','nota_credito_a','nota_credito_b','nota_credito_c','nota_debito_a','nota_debito_b','nota_debito_c','ticket','otro')),
  nro_comprobante TEXT NOT NULL,             -- normalizado PPPP-NNNNNNNN
  fecha TEXT NOT NULL,
  cuit TEXT,
  neto_gravado INTEGER NOT NULL DEFAULT 0,
  no_gravado INTEGER NOT NULL DEFAULT 0,
  iva_21 INTEGER NOT NULL DEFAULT 0,
  iva_10_5 INTEGER NOT NULL DEFAULT 0,
  iva_27 INTEGER NOT NULL DEFAULT 0,
  otros_tributos INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL CHECK (total > 0),
  condicion_pago TEXT NOT NULL DEFAULT 'cuenta_corriente' CHECK (condicion_pago IN ('contado','cuenta_corriente','plazo')),
  dias_plazo INTEGER,
  vencimiento TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'registrada' CHECK (estado IN ('registrada','anulada')),
  compra_id TEXT,                            -- asociada a una compra existente: la deuda ya está en la compra
  orden_compra_id TEXT,                      -- factura de una orden recibida: la deuda nace con la factura
  notas TEXT,
  idem_key TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, numero),
  UNIQUE (taller_id, idem_key),
  FOREIGN KEY (taller_id, proveedor_id) REFERENCES proveedores(taller_id, id),
  FOREIGN KEY (taller_id, compra_id) REFERENCES compras(taller_id, id),
  FOREIGN KEY (taller_id, orden_compra_id) REFERENCES ordenes_compra(taller_id, id),
  CHECK (total = neto_gravado + no_gravado + iva_21 + iva_10_5 + iva_27 + otros_tributos)
);
CREATE UNIQUE INDEX idx_facturas_prov_dup ON facturas_proveedor(taller_id, proveedor_id, tipo, nro_comprobante) WHERE estado = 'registrada';
-- Una compra tiene una sola factura (las notas de crédito pueden ser varias).
CREATE UNIQUE INDEX idx_facturas_prov_compra ON facturas_proveedor(taller_id, compra_id) WHERE compra_id IS NOT NULL AND estado = 'registrada' AND tipo NOT LIKE 'nota_credito%';
CREATE INDEX idx_facturas_prov_venc ON facturas_proveedor(taller_id, proveedor_id, vencimiento);

-- ───────────────────── Inventario avanzado ─────────────────────
ALTER TABLE stock_movimientos ADD COLUMN motivo TEXT;

CREATE TABLE conteos (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  numero INTEGER NOT NULL,
  fecha TEXT NOT NULL,
  descripcion TEXT,
  categoria_id TEXT,
  estado TEXT NOT NULL DEFAULT 'abierto' CHECK (estado IN ('abierto','aplicado','cancelado')),
  usuario_id TEXT,
  aplicado_por TEXT,
  aplicado_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, numero)
);

CREATE TABLE conteo_items (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  conteo_id TEXT NOT NULL,
  articulo_id TEXT NOT NULL,
  stock_sistema REAL NOT NULL,               -- foto del stock al iniciar el conteo
  contado REAL,                              -- NULL = todavía sin contar
  costo INTEGER NOT NULL DEFAULT 0,
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, conteo_id, articulo_id),
  FOREIGN KEY (taller_id, conteo_id) REFERENCES conteos(taller_id, id) ON DELETE CASCADE,
  FOREIGN KEY (taller_id, articulo_id) REFERENCES articulos(taller_id, id)
);

-- Historial de costos: lo mantienen triggers, así cualquier camino que cambie el costo (compra, recepción, edición, ajuste masivo) queda registrado.
CREATE TABLE articulo_costos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taller_id TEXT NOT NULL,
  articulo_id TEXT NOT NULL,
  costo_anterior INTEGER,
  costo_nuevo INTEGER NOT NULL,
  origen TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (taller_id, articulo_id) REFERENCES articulos(taller_id, id)
);
CREATE INDEX idx_articulo_costos ON articulo_costos(taller_id, articulo_id, id);
INSERT INTO articulo_costos (taller_id, articulo_id, costo_anterior, costo_nuevo, origen) SELECT taller_id, id, NULL, costo, 'inicial' FROM articulos;

CREATE TRIGGER trg_articulo_costo_alta AFTER INSERT ON articulos
BEGIN
  INSERT INTO articulo_costos (taller_id, articulo_id, costo_anterior, costo_nuevo, origen) VALUES (NEW.taller_id, NEW.id, NULL, NEW.costo, 'alta');
END;
CREATE TRIGGER trg_articulo_costo_cambio AFTER UPDATE OF costo ON articulos WHEN OLD.costo <> NEW.costo
BEGIN
  INSERT INTO articulo_costos (taller_id, articulo_id, costo_anterior, costo_nuevo) VALUES (NEW.taller_id, NEW.id, OLD.costo, NEW.costo);
END;

-- ───────────────────── Configuración administrativa ─────────────────────
ALTER TABLE talleres ADD COLUMN ingresos_brutos TEXT;
ALTER TABLE talleres ADD COLUMN inicio_actividades TEXT;
ALTER TABLE talleres ADD COLUMN sitio_web TEXT;

ALTER TABLE taller_config ADD COLUMN medios_pago TEXT;                                   -- JSON con los medios habilitados (NULL = todos)
ALTER TABLE taller_config ADD COLUMN pie_presupuesto TEXT;
ALTER TABLE taller_config ADD COLUMN pie_recibo TEXT;
ALTER TABLE taller_config ADD COLUMN pie_orden_compra TEXT;
ALTER TABLE taller_config ADD COLUMN tolerancia_caja INTEGER NOT NULL DEFAULT 0;         -- diferencia de efectivo (centavos) que no exige justificación
ALTER TABLE taller_config ADD COLUMN alerta_cheques_dias INTEGER NOT NULL DEFAULT 7;
ALTER TABLE taller_config ADD COLUMN plazo_pago_dias INTEGER NOT NULL DEFAULT 30;

-- iva_default/recargo_default pasan a aplicarse en los formularios. Los talleres que nunca guardaron su configuración conservan el
-- 21 % de fábrica sin que nadie lo haya elegido: se los deja en 0 para que sus documentos nuevos no cambien de importe sin aviso.
UPDATE taller_config SET iva_default = 0
 WHERE NOT EXISTS (SELECT 1 FROM auditoria a WHERE a.taller_id = taller_config.taller_id AND a.entidad = 'config' AND a.accion = 'actualizar');
