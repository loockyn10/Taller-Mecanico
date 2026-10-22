-- Sprint 12 · Sincronización contable controlada y saldos de apertura de proveedores.
--
-- Migración ADITIVA: no modifica ni elimina datos existentes.
--  1) contab_config gana columnas para coordinar la sincronización contable (un solo proceso por taller a la vez, con pedido de nueva corrida
--     si llegó una operación mientras corría) y para dejar a la vista el último error. La contabilidad deja de generarse al CONSULTAR:
--     se activa de forma explícita y después se mantiene al día desde las operaciones comerciales.
--  2) aperturas_saldos / aperturas_saldos_items: saldos con que un taller que migra de otro sistema empieza a operar. NO son ventas ni compras:
--     no pasan por el estado de resultados (su contrapartida contable es el patrimonio, "Saldos iniciales y ajustes de apertura").
--     Hoy admiten saldos de proveedores; el modelo ya contempla los de clientes (pendiente, ver docs/PROGRESO.md).

ALTER TABLE contab_config ADD COLUMN sync_bloqueo_hasta TEXT;
ALTER TABLE contab_config ADD COLUMN sync_solicitada INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contab_config ADD COLUMN ultimo_error TEXT;
ALTER TABLE contab_config ADD COLUMN ultimo_error_at TEXT;
ALTER TABLE contab_config ADD COLUMN activada_por TEXT;

CREATE TABLE aperturas_saldos (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  numero INTEGER NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('proveedores', 'clientes')),
  fecha_corte TEXT NOT NULL CHECK (fecha_corte GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- Sistema o planilla de la que salen los saldos y a qué corte corresponden (texto libre para auditar).
  origen TEXT NOT NULL CHECK (length(origen) BETWEEN 3 AND 200),
  notas TEXT,
  estado TEXT NOT NULL DEFAULT 'vigente' CHECK (estado IN ('vigente', 'anulada')),
  -- Suma de los importes de sus renglones (positivo = lo que se debe; negativo = saldo a favor).
  total INTEGER NOT NULL,
  cantidad INTEGER NOT NULL CHECK (cantidad > 0),
  idem_key TEXT NOT NULL,
  usuario_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  anulada_at TEXT,
  anulada_por TEXT,
  motivo_anulacion TEXT,
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, numero),
  UNIQUE (taller_id, idem_key),
  FOREIGN KEY (taller_id, usuario_id) REFERENCES usuarios(taller_id, id),
  FOREIGN KEY (taller_id, anulada_por) REFERENCES usuarios(taller_id, id),
  CHECK ((estado = 'anulada') = (anulada_at IS NOT NULL))
);
CREATE INDEX idx_aperturas_taller ON aperturas_saldos(taller_id, tipo, estado);

CREATE TABLE aperturas_saldos_items (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  apertura_id TEXT NOT NULL,
  proveedor_id TEXT NOT NULL,
  -- Positivo: deuda con el proveedor al corte. Negativo: saldo a favor del taller (anticipo ya entregado).
  importe INTEGER NOT NULL CHECK (importe <> 0),
  -- Número de comprobante o referencia del sistema anterior.
  referencia TEXT,
  vencimiento TEXT CHECK (vencimiento IS NULL OR vencimiento GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- 1 mientras la apertura está vigente; al anularla pasa a 0. El índice único de abajo impide dos saldos de apertura vigentes para un mismo proveedor.
  activo INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
  UNIQUE (taller_id, id),
  FOREIGN KEY (taller_id, apertura_id) REFERENCES aperturas_saldos(taller_id, id),
  FOREIGN KEY (taller_id, proveedor_id) REFERENCES proveedores(taller_id, id)
);
CREATE UNIQUE INDEX idx_apertura_item_vigente ON aperturas_saldos_items(taller_id, proveedor_id) WHERE activo = 1;
CREATE INDEX idx_apertura_item_apertura ON aperturas_saldos_items(taller_id, apertura_id);

-- Una apertura no se edita ni se borra: sólo pasa de vigente a anulada (y sus renglones a inactivos).
CREATE TRIGGER trg_apertura_no_borrar BEFORE DELETE ON aperturas_saldos
BEGIN
  SELECT RAISE(ABORT, 'Una apertura de saldos no se elimina: se anula');
END;
CREATE TRIGGER trg_apertura_inmutable BEFORE UPDATE ON aperturas_saldos
WHEN OLD.estado = 'anulada'
  OR NEW.taller_id <> OLD.taller_id OR NEW.numero <> OLD.numero OR NEW.tipo <> OLD.tipo OR NEW.fecha_corte <> OLD.fecha_corte OR NEW.origen <> OLD.origen
  OR NEW.notas IS NOT OLD.notas OR NEW.total <> OLD.total OR NEW.cantidad <> OLD.cantidad OR NEW.idem_key <> OLD.idem_key OR NEW.usuario_id <> OLD.usuario_id
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'Una apertura de saldos no se modifica: sólo se puede anular');
END;
CREATE TRIGGER trg_apertura_items_ins BEFORE INSERT ON aperturas_saldos_items
WHEN NOT EXISTS (SELECT 1 FROM aperturas_saldos WHERE taller_id = NEW.taller_id AND id = NEW.apertura_id AND estado = 'vigente')
  OR NEW.activo <> 1
BEGIN
  SELECT RAISE(ABORT, 'La apertura de saldos no admite nuevos renglones');
END;
CREATE TRIGGER trg_apertura_items_upd BEFORE UPDATE ON aperturas_saldos_items
WHEN NEW.taller_id <> OLD.taller_id OR NEW.apertura_id <> OLD.apertura_id OR NEW.proveedor_id <> OLD.proveedor_id OR NEW.importe <> OLD.importe
  OR NEW.referencia IS NOT OLD.referencia OR NEW.vencimiento IS NOT OLD.vencimiento OR (OLD.activo = 0 AND NEW.activo = 1)
  OR (NEW.activo = 0 AND NOT EXISTS (SELECT 1 FROM aperturas_saldos WHERE taller_id = OLD.taller_id AND id = OLD.apertura_id AND estado = 'anulada'))
BEGIN
  SELECT RAISE(ABORT, 'Los renglones de una apertura de saldos no se modifican');
END;
CREATE TRIGGER trg_apertura_items_del BEFORE DELETE ON aperturas_saldos_items
WHEN EXISTS (SELECT 1 FROM aperturas_saldos WHERE taller_id = OLD.taller_id AND id = OLD.apertura_id)
BEGIN
  SELECT RAISE(ABORT, 'Los renglones de una apertura de saldos no se eliminan');
END;
