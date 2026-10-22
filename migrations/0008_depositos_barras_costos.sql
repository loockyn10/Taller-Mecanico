-- Fierro · Sprint 08: depósitos por taller con existencias y transferencias, código de barras y costo histórico de las ventas.
-- Migración ADITIVA: no elimina ni reescribe datos de negocio.
--  * `articulos.stock` sigue siendo el stock TOTAL del artículo (todo lo existente lo usa) y es siempre la suma de `stock_depositos`.
--  * Cada taller recibe su "Depósito principal"; el stock actual de cada artículo pasa a ese depósito.
--  * Las filas con `deposito_id` NULL (movimientos históricos, documentos anteriores) corresponden al depósito principal.

-- ───────────────────────── Depósitos ─────────────────────────
CREATE TABLE depositos (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL COLLATE NOCASE,
  es_principal INTEGER NOT NULL DEFAULT 0 CHECK (es_principal IN (0,1)),
  activo INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0,1)),
  notas TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, nombre)
);
-- Un único depósito principal por taller (el que usan por defecto todas las operaciones).
CREATE UNIQUE INDEX idx_depositos_principal ON depositos(taller_id) WHERE es_principal = 1;
INSERT INTO depositos (id, taller_id, nombre, es_principal) SELECT lower(hex(randomblob(16))), id, 'Depósito principal', 1 FROM talleres;

-- Existencias por depósito. La suma por artículo es siempre igual a articulos.stock.
CREATE TABLE stock_depositos (
  taller_id TEXT NOT NULL,
  articulo_id TEXT NOT NULL,
  deposito_id TEXT NOT NULL,
  stock REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (taller_id, articulo_id, deposito_id),
  FOREIGN KEY (taller_id, articulo_id) REFERENCES articulos(taller_id, id),
  FOREIGN KEY (taller_id, deposito_id) REFERENCES depositos(taller_id, id)
);
CREATE INDEX idx_stock_depositos_dep ON stock_depositos(taller_id, deposito_id);
INSERT INTO stock_depositos (taller_id, articulo_id, deposito_id, stock)
  SELECT a.taller_id, a.id, d.id, ROUND(a.stock, 3) FROM articulos a JOIN depositos d ON d.taller_id = a.taller_id AND d.es_principal = 1;

-- Depósito de cada operación (NULL = depósito principal). Se guarda para que las anulaciones y reversos vuelvan al mismo lugar.
ALTER TABLE stock_movimientos ADD COLUMN deposito_id TEXT;
ALTER TABLE ventas ADD COLUMN deposito_id TEXT;
ALTER TABLE compras ADD COLUMN deposito_id TEXT;
ALTER TABLE recepciones ADD COLUMN deposito_id TEXT;
ALTER TABLE ordenes ADD COLUMN deposito_id TEXT;
ALTER TABLE conteos ADD COLUMN deposito_id TEXT;

-- ───────────────────────── Transferencias internas ─────────────────────────
CREATE TABLE transferencias_stock (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  numero INTEGER NOT NULL,
  fecha TEXT NOT NULL,
  origen_id TEXT NOT NULL,
  destino_id TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'registrada' CHECK (estado IN ('registrada','anulada')),
  notas TEXT,
  anulada_motivo TEXT,
  idem_key TEXT NOT NULL,
  usuario_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, numero),
  UNIQUE (taller_id, idem_key),
  CHECK (origen_id <> destino_id),
  FOREIGN KEY (taller_id, origen_id) REFERENCES depositos(taller_id, id),
  FOREIGN KEY (taller_id, destino_id) REFERENCES depositos(taller_id, id)
);
CREATE INDEX idx_transferencias_fecha ON transferencias_stock(taller_id, fecha);
CREATE TABLE transferencia_items (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  transferencia_id TEXT NOT NULL,
  articulo_id TEXT NOT NULL,
  cantidad REAL NOT NULL CHECK (cantidad > 0),
  FOREIGN KEY (taller_id, transferencia_id) REFERENCES transferencias_stock(taller_id, id) ON DELETE CASCADE,
  FOREIGN KEY (taller_id, articulo_id) REFERENCES articulos(taller_id, id)
);
CREATE INDEX idx_transferencia_items ON transferencia_items(taller_id, transferencia_id);

-- ───────────────────────── Código de barras ─────────────────────────
-- Los lectores USB estándar escriben el código como un teclado: el código de barras se busca por coincidencia exacta.
ALTER TABLE articulos ADD COLUMN codigo_barras TEXT;
CREATE UNIQUE INDEX idx_articulos_barras ON articulos(taller_id, codigo_barras) WHERE codigo_barras IS NOT NULL AND codigo_barras <> '';

-- ───────────────────────── Costo histórico ─────────────────────────
-- Costo unitario del artículo al emitir el comprobante: la rentabilidad no cambia cuando el costo se actualiza después.
-- (NULL en comprobantes anteriores: los informes usan el costo actual solo para esos.)
ALTER TABLE venta_items ADD COLUMN costo_unitario INTEGER;
