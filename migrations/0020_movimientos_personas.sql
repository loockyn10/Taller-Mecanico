-- Fierro · Sprint 24: movimientos financieros con personas (aportes de capital, préstamos de socios, préstamos y adelantos al personal).
--
-- Migración EXPANSIVA: sólo crea tablas, índices y triggers nuevos. La única tabla existente que se reconstruye es caja_movimientos, para ampliar
-- los valores admitidos por sus CHECK (rubro `persona`, origen `persona_mov`) —el mismo procedimiento de las migraciones 0005 y 0009—: se copia completa,
-- ninguna otra tabla la referencia y sus índices y triggers se recrean idénticos. El código desplegado antes de esta migración sigue funcionando
-- (no escribe ni lee los valores nuevos), de modo que NO hay ventana de incompatibilidad entre aplicar la migración y publicar el código.
--
-- Modelo
--  * PERSONA (`personas_financieras`): quien entrega o recibe el dinero. NO es el usuario que opera el sistema. Un empleado se referencia por
--    `usuario_id` (el registro de personal existente, con o sin acceso al ERP: no se duplica su nombre); socios, propietarios y otras personas viven
--    sólo acá. Todo pertenece a un taller (empresa).
--  * CATEGORÍA (`categorias_movimiento`): clasifica el movimiento y fija su TIPO FINANCIERO, que decide dirección del dinero y tratamiento contable.
--    Las del sistema tienen `clave` estable; las personalizadas eligen uno de los tipos admitidos (nunca definen asientos propios).
--  * MOVIMIENTO (`movimientos_personas`): inmutable una vez registrado. Se corrige anulándolo (contra-asiento en caja/banco y en contabilidad).
--    Los movimientos que abren una obligación (préstamo recibido/otorgado, adelanto) acumulan en `regularizado` lo ya devuelto o aplicado; el CHECK
--    impide regularizar más que el importe, aun con operaciones simultáneas.
--  * Dinero: un movimiento en efectivo escribe una fila en caja_movimientos (rubro `persona`); uno por banco escribe en banco_movimientos (sin afectar
--    resultados). La aplicación de un adelanto no mueve dinero (`via = 'ninguna'`).
--  * Contabilidad: nueva fuente `mov_persona` (la cola contable se llena con triggers, igual que el resto de las operaciones).

-- ───────────── 1) caja_movimientos: rubro `persona` y origen `persona_mov` ─────────────
CREATE TABLE caja_movimientos_nueva (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  sesion_id TEXT,
  tipo TEXT NOT NULL CHECK (tipo IN ('ingreso','egreso')),
  rubro TEXT NOT NULL CHECK (rubro IN ('cobro','pago_proveedor','gasto','otro_ingreso','traspaso','devolucion','persona')),
  medio TEXT NOT NULL CHECK (medio IN ('efectivo','transferencia','debito','credito','cheque','otro')),
  importe INTEGER NOT NULL CHECK (importe > 0),
  concepto TEXT NOT NULL,
  referencia TEXT,
  origen_tipo TEXT NOT NULL CHECK (origen_tipo IN ('cobro','pago_proveedor','gasto','manual','reverso','banco','reintegro','persona_mov')),
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

-- Los dos triggers de la cola contable que cuelgan de caja_movimientos (0013) se pierden con el DROP: se recrean idénticos.
CREATE TRIGGER trg_cola_caja_manual AFTER INSERT ON caja_movimientos
WHEN NEW.origen_tipo = 'manual' AND EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'caja_manual', NEW.id, 'alta'); END;

CREATE TRIGGER trg_cola_caja_manual_anul AFTER INSERT ON caja_movimientos
WHEN NEW.origen_tipo = 'reverso' AND EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
 AND EXISTS (SELECT 1 FROM caja_movimientos t WHERE t.taller_id = NEW.taller_id AND t.id = NEW.origen_id AND t.origen_tipo = 'manual')
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'caja_manual', NEW.origen_id, 'anulacion'); END;

-- ───────────── 2) Personas ─────────────
CREATE TABLE personas_financieras (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('socio','propietario','empleado','otra')),
  -- Para un empleado el nombre se lee del registro de personal (usuario_id): acá queda vacío.
  nombre TEXT NOT NULL DEFAULT '',
  documento TEXT,
  usuario_id TEXT,
  activa INTEGER NOT NULL DEFAULT 1 CHECK (activa IN (0,1)),
  notas TEXT,
  creado_por TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  FOREIGN KEY (taller_id, usuario_id) REFERENCES usuarios(taller_id, id),
  CONSTRAINT ck_pf_identidad CHECK ((usuario_id IS NOT NULL AND tipo = 'empleado') OR (usuario_id IS NULL AND tipo <> 'empleado' AND length(trim(nombre)) >= 2))
);
-- Un empleado corresponde a una sola persona financiera.
CREATE UNIQUE INDEX idx_pf_usuario ON personas_financieras(taller_id, usuario_id) WHERE usuario_id IS NOT NULL;
CREATE INDEX idx_pf_taller ON personas_financieras(taller_id, activa);

-- El tipo y el vínculo con el personal no se reescriben: cambiarlos reasignaría el historial de otra persona.
CREATE TRIGGER trg_pf_inmutable BEFORE UPDATE ON personas_financieras
WHEN NEW.id <> OLD.id OR NEW.taller_id <> OLD.taller_id OR NEW.tipo <> OLD.tipo OR NEW.usuario_id IS NOT OLD.usuario_id
BEGIN SELECT RAISE(ABORT, 'ck_pf_inmutable'); END;

-- ───────────── 3) Categorías ─────────────
CREATE TABLE categorias_movimiento (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  clave TEXT,
  nombre TEXT NOT NULL COLLATE NOCASE,
  tipo_fin TEXT NOT NULL CHECK (tipo_fin IN ('aporte_capital','retiro_capital','prestamo_recibido','devolucion_prestamo_recibido','prestamo_otorgado','devolucion_prestamo_otorgado','adelanto_sueldo','aplicacion_adelanto')),
  activa INTEGER NOT NULL DEFAULT 1 CHECK (activa IN (0,1)),
  sistema INTEGER NOT NULL DEFAULT 0 CHECK (sistema IN (0,1)),
  creado_por TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, nombre),
  CONSTRAINT ck_cm_sistema CHECK ((sistema = 1) = (clave IS NOT NULL))
);
CREATE UNIQUE INDEX idx_cm_clave ON categorias_movimiento(taller_id, clave) WHERE clave IS NOT NULL;

-- ───────────── 4) Movimientos ─────────────
CREATE TABLE movimientos_personas (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  numero INTEGER NOT NULL,
  persona_id TEXT NOT NULL,
  categoria_id TEXT NOT NULL,
  -- Copia del tipo de la categoría al registrar: el tratamiento contable del movimiento no cambia aunque la categoría se renombre o desactive.
  tipo_fin TEXT NOT NULL CHECK (tipo_fin IN ('aporte_capital','retiro_capital','prestamo_recibido','devolucion_prestamo_recibido','prestamo_otorgado','devolucion_prestamo_otorgado','adelanto_sueldo','aplicacion_adelanto')),
  -- Sentido del dinero desde la empresa: entrada = ingresa a la empresa; salida = sale de la empresa. La aplicación de un adelanto no mueve dinero (entrada = no aplica).
  direccion TEXT NOT NULL CHECK (direccion IN ('entrada','salida','sin_dinero')),
  importe INTEGER NOT NULL CHECK (importe > 0),
  moneda TEXT NOT NULL DEFAULT 'ARS' CHECK (moneda IN ('ARS','USD')),
  fecha TEXT NOT NULL,
  -- caja = efectivo en la caja; banco = cuenta bancaria; ninguna = regularización sin movimiento de dinero (aplicación de un adelanto).
  via TEXT NOT NULL CHECK (via IN ('caja','banco','ninguna')),
  cuenta_id TEXT,
  motivo TEXT NOT NULL,
  referencia TEXT,
  -- Obligación que este movimiento cancela (devolución de un préstamo, aplicación de un adelanto).
  regulariza_id TEXT,
  -- Cuánto del importe de una obligación ya fue devuelto o aplicado.
  regularizado INTEGER NOT NULL DEFAULT 0,
  -- Aplicación de un adelanto: liquidación contra la que se aplica y quién autorizó el descuento.
  liquidacion_ref TEXT,
  autorizado_por TEXT,
  estado TEXT NOT NULL DEFAULT 'registrado' CHECK (estado IN ('registrado','anulado')),
  anulado_motivo TEXT,
  anulado_por TEXT,
  anulado_at TEXT,
  idem_key TEXT NOT NULL,
  usuario_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, numero),
  UNIQUE (taller_id, idem_key),
  FOREIGN KEY (taller_id, persona_id) REFERENCES personas_financieras(taller_id, id),
  FOREIGN KEY (taller_id, categoria_id) REFERENCES categorias_movimiento(taller_id, id),
  FOREIGN KEY (taller_id, regulariza_id) REFERENCES movimientos_personas(taller_id, id),
  FOREIGN KEY (taller_id, cuenta_id) REFERENCES cuentas_bancarias(taller_id, id),
  FOREIGN KEY (taller_id, usuario_id) REFERENCES usuarios(taller_id, id),
  CONSTRAINT ck_mp_direccion CHECK (
    (tipo_fin IN ('aporte_capital','prestamo_recibido','devolucion_prestamo_otorgado') AND direccion = 'entrada')
    OR (tipo_fin IN ('retiro_capital','devolucion_prestamo_recibido','prestamo_otorgado','adelanto_sueldo') AND direccion = 'salida')
    OR (tipo_fin = 'aplicacion_adelanto' AND direccion = 'sin_dinero')),
  CONSTRAINT ck_mp_via CHECK ((direccion = 'sin_dinero') = (via = 'ninguna') AND (via = 'banco') = (cuenta_id IS NOT NULL)),
  CONSTRAINT ck_mp_regulariza CHECK ((tipo_fin IN ('devolucion_prestamo_recibido','devolucion_prestamo_otorgado','aplicacion_adelanto')) = (regulariza_id IS NOT NULL)),
  CONSTRAINT ck_mp_regularizado CHECK (regularizado >= 0 AND regularizado <= importe AND (regularizado = 0 OR tipo_fin IN ('prestamo_recibido','prestamo_otorgado','adelanto_sueldo'))),
  CONSTRAINT ck_mp_aplicacion CHECK (tipo_fin <> 'aplicacion_adelanto' OR (length(trim(COALESCE(liquidacion_ref, ''))) >= 2 AND length(trim(COALESCE(autorizado_por, ''))) >= 2)),
  CONSTRAINT ck_mp_anulacion CHECK ((estado = 'anulado') = (anulado_motivo IS NOT NULL AND anulado_at IS NOT NULL))
);
CREATE INDEX idx_mp_fecha ON movimientos_personas(taller_id, fecha, numero);
CREATE INDEX idx_mp_persona ON movimientos_personas(taller_id, persona_id, fecha);
CREATE INDEX idx_mp_categoria ON movimientos_personas(taller_id, categoria_id, fecha);
CREATE INDEX idx_mp_regulariza ON movimientos_personas(taller_id, regulariza_id) WHERE regulariza_id IS NOT NULL;
-- Obligaciones con saldo: lo único que consulta el selector de «qué se devuelve» y los indicadores de pendientes.
CREATE INDEX idx_mp_pendientes ON movimientos_personas(taller_id, persona_id, tipo_fin)
  WHERE estado = 'registrado' AND tipo_fin IN ('prestamo_recibido','prestamo_otorgado','adelanto_sueldo') AND regularizado < importe;

-- Una devolución sólo cancela una obligación vigente de la MISMA persona, del tipo que corresponde, en la misma moneda y no anterior a ella.
CREATE TRIGGER trg_mp_regulariza BEFORE INSERT ON movimientos_personas
WHEN NEW.regulariza_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'ck_mp_origen_invalido') WHERE NOT EXISTS (
    SELECT 1 FROM movimientos_personas o
     WHERE o.taller_id = NEW.taller_id AND o.id = NEW.regulariza_id AND o.estado = 'registrado'
       AND o.persona_id = NEW.persona_id AND o.moneda = NEW.moneda AND o.fecha <= NEW.fecha
       AND o.tipo_fin = CASE NEW.tipo_fin WHEN 'devolucion_prestamo_recibido' THEN 'prestamo_recibido' WHEN 'devolucion_prestamo_otorgado' THEN 'prestamo_otorgado' ELSE 'adelanto_sueldo' END);
END;

-- Un movimiento registrado no se edita: sólo cambian lo regularizado (al devolver o anular una devolución) y su anulación, que tampoco se deshace.
CREATE TRIGGER trg_mp_inmutable BEFORE UPDATE ON movimientos_personas
WHEN OLD.estado = 'anulado'
  OR NEW.id <> OLD.id OR NEW.taller_id <> OLD.taller_id OR NEW.numero <> OLD.numero OR NEW.persona_id <> OLD.persona_id OR NEW.categoria_id <> OLD.categoria_id
  OR NEW.tipo_fin <> OLD.tipo_fin OR NEW.direccion <> OLD.direccion OR NEW.importe <> OLD.importe OR NEW.moneda <> OLD.moneda OR NEW.fecha <> OLD.fecha
  OR NEW.via <> OLD.via OR NEW.cuenta_id IS NOT OLD.cuenta_id OR NEW.motivo <> OLD.motivo OR NEW.referencia IS NOT OLD.referencia
  OR NEW.regulariza_id IS NOT OLD.regulariza_id OR NEW.liquidacion_ref IS NOT OLD.liquidacion_ref OR NEW.autorizado_por IS NOT OLD.autorizado_por
  OR NEW.idem_key <> OLD.idem_key OR NEW.usuario_id <> OLD.usuario_id OR NEW.created_at <> OLD.created_at
BEGIN SELECT RAISE(ABORT, 'ck_mp_inmutable'); END;

-- No se anula una obligación que todavía tiene devoluciones o aplicaciones vigentes: primero se anulan ellas.
CREATE TRIGGER trg_mp_anular BEFORE UPDATE OF estado ON movimientos_personas
WHEN NEW.estado = 'anulado' AND OLD.estado <> 'anulado' AND OLD.regularizado > 0
BEGIN SELECT RAISE(ABORT, 'ck_mp_con_regularizaciones'); END;

CREATE TRIGGER trg_mp_sin_borrado BEFORE DELETE ON movimientos_personas
BEGIN SELECT RAISE(ABORT, 'ck_mp_inmutable'); END;

-- Una categoría con movimientos, o del sistema, conserva su tipo financiero y no se elimina.
CREATE TRIGGER trg_cm_inmutable BEFORE UPDATE ON categorias_movimiento
WHEN NEW.id <> OLD.id OR NEW.taller_id <> OLD.taller_id
  OR ((NEW.tipo_fin <> OLD.tipo_fin OR NEW.clave IS NOT OLD.clave OR NEW.sistema <> OLD.sistema)
      AND (OLD.sistema = 1 OR EXISTS (SELECT 1 FROM movimientos_personas m WHERE m.taller_id = OLD.taller_id AND m.categoria_id = OLD.id)))
BEGIN SELECT RAISE(ABORT, 'ck_cm_inmutable'); END;

CREATE TRIGGER trg_cm_sin_borrado BEFORE DELETE ON categorias_movimiento
WHEN OLD.sistema = 1 OR EXISTS (SELECT 1 FROM movimientos_personas m WHERE m.taller_id = OLD.taller_id AND m.categoria_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'ck_cm_con_movimientos'); END;

-- ───────────── 5) Cola contable ─────────────
-- Misma mecánica que el resto de las operaciones (0013): el pedido nace en la transacción del movimiento y sólo en talleres con la contabilidad activada.
CREATE TRIGGER trg_cola_mov_persona AFTER INSERT ON movimientos_personas
WHEN EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'mov_persona', NEW.id, 'alta'); END;

CREATE TRIGGER trg_cola_mov_persona_anul AFTER UPDATE OF estado ON movimientos_personas
WHEN NEW.estado = 'anulado' AND OLD.estado <> 'anulado' AND EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'mov_persona', NEW.id, 'anulacion'); END;
