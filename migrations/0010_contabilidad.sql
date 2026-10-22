-- Fierro · Sprint 10 · Contabilidad de partida doble integrada con las operaciones comerciales.
-- Migración ADITIVA: sólo crea tablas, índices y triggers nuevos y agrega una columna opcional a categorias_gasto.
-- No modifica ni elimina ningún comprobante, cobro, pago, movimiento ni saldo existente.
--
-- Modelo
--  * `cuentas_contables`: plan de cuentas propio de cada taller (jerárquico). Las cuentas con `rol` son las que usa la contabilización
--    automática (no se pueden eliminar, desactivar ni cambiar de naturaleza); el resto las administra el taller.
--  * `asientos` + `asiento_lineas`: partida doble. Estados: borrador (se puede editar o descartar) → registrado (contabilizado, inmutable) → revertido
--    (tiene un contra-asiento que lo anula). La base impide registrar un asiento desbalanceado, con menos de dos líneas o con cuentas no imputables,
--    modificar un asiento registrado, borrarlo o tocar sus líneas: las correcciones se hacen con contra-asientos y conservan la trazabilidad.
--  * Los asientos automáticos nacen de un documento de origen (`origen_tipo`, `origen_id`, `evento`). El índice único sobre esa terna es la garantía
--    de idempotencia: procesar dos veces el mismo documento (o dos procesos a la vez) no puede duplicar el asiento.
--  * `contab_omitidos`: documentos que no pudieron contabilizarse (con el motivo) o que no tienen efecto contable. Nunca se ocultan.
--  * `contab_corridas`: cada ejecución del proceso de contabilización (incluida la generación histórica), con sus resultados.

CREATE TABLE contab_config (
  taller_id TEXT PRIMARY KEY REFERENCES talleres(id) ON DELETE CASCADE,
  inicializado_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  plan_version INTEGER NOT NULL DEFAULT 1,
  ultima_corrida_at TEXT
);

CREATE TABLE cuentas_contables (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  codigo TEXT NOT NULL,
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('activo','pasivo','patrimonio','ingreso','costo','gasto')),
  naturaleza TEXT NOT NULL CHECK (naturaleza IN ('deudora','acreedora')),
  padre_id TEXT,
  imputable INTEGER NOT NULL DEFAULT 1 CHECK (imputable IN (0,1)),   -- 0 = rubro (agrupa cuentas, no recibe asientos)
  rol TEXT,                                                          -- cuenta que usa la contabilización automática
  cuenta_bancaria_id TEXT,                                           -- cuenta contable de una cuenta bancaria del taller
  activa INTEGER NOT NULL DEFAULT 1 CHECK (activa IN (0,1)),
  notas TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, codigo),
  FOREIGN KEY (taller_id, padre_id) REFERENCES cuentas_contables(taller_id, id)
);
CREATE UNIQUE INDEX idx_cuentas_rol ON cuentas_contables(taller_id, rol) WHERE rol IS NOT NULL;
CREATE UNIQUE INDEX idx_cuentas_banco ON cuentas_contables(taller_id, cuenta_bancaria_id) WHERE cuenta_bancaria_id IS NOT NULL;
CREATE INDEX idx_cuentas_padre ON cuentas_contables(taller_id, padre_id);

CREATE TABLE asientos (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  numero INTEGER,                                                    -- se asigna al registrar (sin saltos): un borrador no tiene número
  fecha TEXT NOT NULL,
  descripcion TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador','registrado','revertido')),
  modo TEXT NOT NULL CHECK (modo IN ('manual','automatico','historico','reversion')),
  origen_tipo TEXT NOT NULL,                                         -- venta | cobro | compra | ... | manual
  origen_id TEXT,                                                    -- id del documento de origen (NULL en los manuales)
  evento TEXT,                                                       -- alta | anulacion (documentos de origen)
  revierte_id TEXT,                                                  -- este asiento es el contra-asiento de ese otro
  corrige_id TEXT,                                                   -- este asiento corrige a ese otro (que fue revertido)
  motivo TEXT,
  idem_key TEXT,
  advertencia TEXT,                                                  -- dato faltante (p. ej. costo histórico no disponible)
  costo_incompleto INTEGER NOT NULL DEFAULT 0 CHECK (costo_incompleto IN (0,1)),
  total INTEGER NOT NULL DEFAULT 0,
  usuario_id TEXT,
  registrado_por TEXT,
  registrado_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  CHECK ((estado = 'borrador' AND numero IS NULL) OR (estado <> 'borrador' AND numero IS NOT NULL)),
  FOREIGN KEY (taller_id, revierte_id) REFERENCES asientos(taller_id, id),
  FOREIGN KEY (taller_id, corrige_id) REFERENCES asientos(taller_id, id)
);
CREATE UNIQUE INDEX idx_asientos_numero ON asientos(taller_id, numero) WHERE numero IS NOT NULL;
-- Idempotencia: un documento de origen genera como máximo un asiento por evento.
CREATE UNIQUE INDEX idx_asientos_origen ON asientos(taller_id, origen_tipo, origen_id, evento) WHERE origen_id IS NOT NULL;
CREATE UNIQUE INDEX idx_asientos_revierte ON asientos(taller_id, revierte_id) WHERE revierte_id IS NOT NULL;
CREATE UNIQUE INDEX idx_asientos_idem ON asientos(taller_id, idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX idx_asientos_fecha ON asientos(taller_id, fecha, numero);
CREATE INDEX idx_asientos_estado ON asientos(taller_id, estado);

CREATE TABLE asiento_lineas (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  asiento_id TEXT NOT NULL,
  orden INTEGER NOT NULL DEFAULT 0,
  cuenta_id TEXT NOT NULL,
  debe INTEGER NOT NULL DEFAULT 0 CHECK (debe >= 0),
  haber INTEGER NOT NULL DEFAULT 0 CHECK (haber >= 0),
  detalle TEXT,
  CHECK ((debe > 0 AND haber = 0) OR (haber > 0 AND debe = 0)),
  FOREIGN KEY (taller_id, asiento_id) REFERENCES asientos(taller_id, id) ON DELETE CASCADE,
  FOREIGN KEY (taller_id, cuenta_id) REFERENCES cuentas_contables(taller_id, id)
);
CREATE INDEX idx_asiento_lineas_asiento ON asiento_lineas(taller_id, asiento_id);
CREATE INDEX idx_asiento_lineas_cuenta ON asiento_lineas(taller_id, cuenta_id);

CREATE TABLE contab_omitidos (
  taller_id TEXT NOT NULL,
  origen_tipo TEXT NOT NULL,
  origen_id TEXT NOT NULL,
  evento TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('sin_efecto','error')),
  motivo TEXT NOT NULL,
  intentos INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (taller_id, origen_tipo, origen_id, evento)
);

CREATE TABLE contab_corridas (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  iniciada_at TEXT NOT NULL,
  terminada_at TEXT,
  usuario_id TEXT,
  disparador TEXT NOT NULL,                                          -- consulta | manual | inicial
  asientos_creados INTEGER NOT NULL DEFAULT 0,
  asientos_historicos INTEGER NOT NULL DEFAULT 0,
  omitidos INTEGER NOT NULL DEFAULT 0,
  restantes INTEGER NOT NULL DEFAULT 0,
  detalle TEXT,
  FOREIGN KEY (taller_id) REFERENCES talleres(id) ON DELETE CASCADE
);
CREATE INDEX idx_contab_corridas ON contab_corridas(taller_id, iniciada_at);

-- Cuenta contable de cada categoría de gasto (opcional: sin elegir, se usa la cuenta que corresponde por nombre o tipo).
ALTER TABLE categorias_gasto ADD COLUMN cuenta_contable_id TEXT;

-- ───────────── Integridad contable en la base ─────────────
-- Las líneas sólo se agregan, cambian o quitan mientras el asiento es un borrador.
CREATE TRIGGER trg_asiento_lineas_ins BEFORE INSERT ON asiento_lineas
WHEN NOT EXISTS (SELECT 1 FROM asientos WHERE taller_id = NEW.taller_id AND id = NEW.asiento_id AND estado = 'borrador')
BEGIN
  SELECT RAISE(ABORT, 'Un asiento registrado no admite cambios en sus líneas');
END;
CREATE TRIGGER trg_asiento_lineas_upd BEFORE UPDATE ON asiento_lineas
WHEN EXISTS (SELECT 1 FROM asientos WHERE taller_id = OLD.taller_id AND id = OLD.asiento_id AND estado <> 'borrador')
BEGIN
  SELECT RAISE(ABORT, 'Un asiento registrado no admite cambios en sus líneas');
END;
CREATE TRIGGER trg_asiento_lineas_del BEFORE DELETE ON asiento_lineas
WHEN EXISTS (SELECT 1 FROM asientos WHERE taller_id = OLD.taller_id AND id = OLD.asiento_id AND estado <> 'borrador')
BEGIN
  SELECT RAISE(ABORT, 'Un asiento registrado no admite cambios en sus líneas');
END;

-- Registrar: partida doble obligatoria.
CREATE TRIGGER trg_asientos_registrar BEFORE UPDATE OF estado ON asientos
WHEN OLD.estado = 'borrador' AND NEW.estado = 'registrado'
BEGIN
  SELECT RAISE(ABORT, 'El asiento debe tener al menos dos líneas')
   WHERE (SELECT COUNT(*) FROM asiento_lineas WHERE taller_id = OLD.taller_id AND asiento_id = OLD.id) < 2;
  SELECT RAISE(ABORT, 'El asiento está desbalanceado: el Debe no coincide con el Haber')
   WHERE (SELECT COALESCE(SUM(debe), 0) - COALESCE(SUM(haber), 0) FROM asiento_lineas WHERE taller_id = OLD.taller_id AND asiento_id = OLD.id) <> 0;
  SELECT RAISE(ABORT, 'El asiento no tiene importes')
   WHERE (SELECT COALESCE(SUM(debe), 0) FROM asiento_lineas WHERE taller_id = OLD.taller_id AND asiento_id = OLD.id) = 0;
  SELECT RAISE(ABORT, 'El asiento usa una cuenta que no es imputable o está inactiva')
   WHERE EXISTS (SELECT 1 FROM asiento_lineas l JOIN cuentas_contables c ON c.taller_id = l.taller_id AND c.id = l.cuenta_id
                  WHERE l.taller_id = OLD.taller_id AND l.asiento_id = OLD.id AND (c.imputable = 0 OR c.activa = 0));
END;

-- Un asiento registrado sólo puede pasar a revertido (y únicamente si ya existe su contra-asiento).
CREATE TRIGGER trg_asientos_inmutables BEFORE UPDATE ON asientos
WHEN OLD.estado <> 'borrador' AND NOT (
  OLD.estado = 'registrado' AND NEW.estado = 'revertido'
  AND NEW.taller_id = OLD.taller_id AND NEW.fecha = OLD.fecha AND NEW.descripcion = OLD.descripcion AND NEW.numero IS OLD.numero
  AND NEW.origen_tipo = OLD.origen_tipo AND NEW.origen_id IS OLD.origen_id AND NEW.evento IS OLD.evento AND NEW.modo = OLD.modo
  AND NEW.total = OLD.total AND NEW.usuario_id IS OLD.usuario_id AND NEW.revierte_id IS OLD.revierte_id)
BEGIN
  SELECT RAISE(ABORT, 'Un asiento registrado no se modifica: se corrige con un contra-asiento');
END;
CREATE TRIGGER trg_asientos_revertir BEFORE UPDATE OF estado ON asientos
WHEN OLD.estado = 'registrado' AND NEW.estado = 'revertido'
BEGIN
  SELECT RAISE(ABORT, 'No existe el contra-asiento que revierte a este asiento')
   WHERE NOT EXISTS (SELECT 1 FROM asientos r WHERE r.taller_id = OLD.taller_id AND r.revierte_id = OLD.id AND r.estado IN ('registrado','revertido'));
END;
CREATE TRIGGER trg_asientos_no_borrar BEFORE DELETE ON asientos
WHEN OLD.estado <> 'borrador'
BEGIN
  SELECT RAISE(ABORT, 'Un asiento registrado no se elimina: se revierte con un contra-asiento');
END;

-- Plan de cuentas: no se elimina una cuenta con movimientos, ni una cuenta del sistema; no cambia la naturaleza de una cuenta con movimientos.
CREATE TRIGGER trg_cuentas_no_borrar BEFORE DELETE ON cuentas_contables
WHEN EXISTS (SELECT 1 FROM asiento_lineas WHERE taller_id = OLD.taller_id AND cuenta_id = OLD.id) OR OLD.rol IS NOT NULL OR OLD.cuenta_bancaria_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'La cuenta tiene movimientos o es una cuenta del sistema: no se puede eliminar');
END;
CREATE TRIGGER trg_cuentas_con_movimientos BEFORE UPDATE OF tipo, naturaleza, imputable ON cuentas_contables
WHEN (NEW.tipo <> OLD.tipo OR NEW.naturaleza <> OLD.naturaleza OR NEW.imputable <> OLD.imputable)
 AND EXISTS (SELECT 1 FROM asiento_lineas WHERE taller_id = OLD.taller_id AND cuenta_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'La cuenta tiene movimientos: no se puede cambiar su tipo, naturaleza ni si es imputable');
END;
CREATE TRIGGER trg_cuentas_sistema BEFORE UPDATE OF tipo, naturaleza, imputable, rol, cuenta_bancaria_id, activa ON cuentas_contables
WHEN (OLD.rol IS NOT NULL OR OLD.cuenta_bancaria_id IS NOT NULL)
 AND (NEW.rol IS NOT OLD.rol OR NEW.cuenta_bancaria_id IS NOT OLD.cuenta_bancaria_id OR NEW.tipo <> OLD.tipo OR NEW.naturaleza <> OLD.naturaleza OR NEW.imputable <> OLD.imputable OR NEW.activa = 0)
BEGIN
  SELECT RAISE(ABORT, 'Es una cuenta del sistema: sólo se puede cambiar su nombre, código y notas');
END;
