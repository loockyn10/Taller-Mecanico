-- Fierro · Sprint 22 · Operaciones rápidas (consumo de repuestos en una OT y bajas internas de inventario).
--
-- Migración ADITIVA: crea dos tablas y un disparador nuevos. No modifica ni elimina ningún dato existente.
--
-- Las operaciones rápidas NO tienen contabilidad ni stock propios: cada una se apoya en los mecanismos de siempre.
--   consumo_ot    agrega ítems de artículo a la orden (orden_items): el stock se descuenta UNA vez al pasar la orden a «lista», como siempre.
--   baja_interna  genera movimientos de stock de tipo salida/origen manual (el asiento de «diferencias de inventario» ya existe para ellos).
-- Estas tablas sólo guardan quién registró qué, cuándo y con qué clave de idempotencia (un reintento con la misma clave no repite nada).
-- Las ventas rápidas no necesitan tabla: son ventas comunes (ventas.idem_key empieza con «rapida:»).

CREATE TABLE operaciones_rapidas (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  numero INTEGER NOT NULL CHECK (numero >= 1),
  tipo TEXT NOT NULL CHECK (tipo IN ('consumo_ot', 'baja_interna')),
  fecha TEXT NOT NULL,
  usuario_id TEXT,
  deposito_id TEXT,
  orden_id TEXT,
  -- Baja interna: rotura, robo, merma, vencimiento, uso_interno u otro (las mismas causas que el ajuste manual de inventario).
  motivo TEXT,
  -- Quién tuvo a cargo lo dado de baja (texto libre, opcional); el usuario que registró queda en usuario_id.
  responsable TEXT,
  notas TEXT,
  idem_key TEXT NOT NULL CHECK (length(idem_key) BETWEEN 8 AND 80),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, idem_key),
  FOREIGN KEY (taller_id, orden_id) REFERENCES ordenes(taller_id, id),
  CHECK ((tipo = 'consumo_ot' AND orden_id IS NOT NULL) OR (tipo = 'baja_interna' AND orden_id IS NULL AND motivo IS NOT NULL))
);
CREATE INDEX idx_operaciones_rapidas_recientes ON operaciones_rapidas(taller_id, created_at DESC);
CREATE INDEX idx_operaciones_rapidas_orden ON operaciones_rapidas(taller_id, orden_id) WHERE orden_id IS NOT NULL;

CREATE TABLE operacion_rapida_items (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  operacion_id TEXT NOT NULL,
  articulo_id TEXT NOT NULL,
  descripcion TEXT NOT NULL,
  cantidad REAL NOT NULL CHECK (cantidad > 0),
  FOREIGN KEY (taller_id, operacion_id) REFERENCES operaciones_rapidas(taller_id, id) ON DELETE CASCADE,
  FOREIGN KEY (taller_id, articulo_id) REFERENCES articulos(taller_id, id),
  UNIQUE (taller_id, operacion_id, articulo_id)
);

-- El historial no se reescribe: sólo se agrega (borrar un taller entero sigue funcionando por cascada).
CREATE TRIGGER trg_operaciones_rapidas_inmutable
BEFORE UPDATE ON operaciones_rapidas
BEGIN
  SELECT RAISE(ABORT, 'operacion_rapida_inmutable');
END;

CREATE TRIGGER trg_operacion_rapida_items_inmutable
BEFORE UPDATE ON operacion_rapida_items
BEGIN
  SELECT RAISE(ABORT, 'operacion_rapida_inmutable');
END;
