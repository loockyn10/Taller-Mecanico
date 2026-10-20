-- Fierro · 0004 · Listas de precios.
-- Migración ADITIVA. Los precios de documentos ya emitidos NO cambian: cada ítem conserva su precio_unitario;
-- las columnas lista_precio_* de los documentos sólo registran qué lista se usó al armarlos.
--
-- Cálculo del precio de un artículo en una lista:
--   1) si existe un precio fijo en lista_precio_items → ese precio;
--   2) si no, base ('costo' | 'precio' del artículo) × (1 + porcentaje/100), redondeado al múltiplo `redondeo` (centavos).
--   Si base = 'costo' y el artículo no tiene costo cargado, se parte del precio base.
-- Con la base 'costo', al cambiar el costo (p. ej. por una compra) los precios de la lista se actualizan solos.

CREATE TABLE listas_precios (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL COLLATE NOCASE,
  descripcion TEXT,
  base TEXT NOT NULL DEFAULT 'costo' CHECK (base IN ('costo','precio')),
  porcentaje REAL NOT NULL DEFAULT 0 CHECK (porcentaje >= -100 AND porcentaje <= 1000),
  redondeo INTEGER NOT NULL DEFAULT 0 CHECK (redondeo IN (0,100,1000,10000)),
  servicios_pct REAL CHECK (servicios_pct IS NULL OR (servicios_pct >= -100 AND servicios_pct <= 1000)),
  es_default INTEGER NOT NULL DEFAULT 0 CHECK (es_default IN (0,1)),
  activa INTEGER NOT NULL DEFAULT 1 CHECK (activa IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, nombre)
);
-- A lo sumo una lista predeterminada por taller.
CREATE UNIQUE INDEX idx_listas_default ON listas_precios(taller_id) WHERE es_default = 1;

CREATE TABLE lista_precio_items (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  lista_id TEXT NOT NULL,
  articulo_id TEXT NOT NULL,
  precio INTEGER NOT NULL CHECK (precio >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, lista_id, articulo_id),
  FOREIGN KEY (taller_id, lista_id) REFERENCES listas_precios(taller_id, id) ON DELETE CASCADE,
  FOREIGN KEY (taller_id, articulo_id) REFERENCES articulos(taller_id, id)
);
CREATE INDEX idx_lista_items_articulo ON lista_precio_items(taller_id, articulo_id);

-- Lista usada al armar cada documento (nombre copiado: la lista puede renombrarse o desactivarse después).
-- Sin FK a propósito: SQLite no permite agregar claves foráneas compuestas con ALTER TABLE; la API valida el vínculo
-- y las listas nunca se eliminan (sólo se desactivan).
ALTER TABLE presupuestos ADD COLUMN lista_precio_id TEXT;
ALTER TABLE presupuestos ADD COLUMN lista_precio_nombre TEXT;
ALTER TABLE ordenes ADD COLUMN lista_precio_id TEXT;
ALTER TABLE ordenes ADD COLUMN lista_precio_nombre TEXT;
ALTER TABLE ventas ADD COLUMN lista_precio_id TEXT;
ALTER TABLE ventas ADD COLUMN lista_precio_nombre TEXT;
