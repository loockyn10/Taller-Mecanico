-- Fierro · Sprint 06: personal, roles y permisos granulares, control de asistencia y reloj compartido.
-- Migración ADITIVA: no elimina ni reescribe datos existentes.
--  * usuarios conserva su columna `rol` (propietario | administrador | empleado = nivel de privilegio, con su CHECK original)
--    y suma `plantilla` (rol de plantilla: recepcion, mecanico, ...) y `permisos_ajustes` (ajustes individuales).
--  * Los usuarios existentes pasan a plantilla = rol (empleado conserva exactamente los accesos que tenía).

-- ───────────────────────── Personal ─────────────────────────
ALTER TABLE usuarios ADD COLUMN apellido TEXT;
ALTER TABLE usuarios ADD COLUMN documento TEXT;
ALTER TABLE usuarios ADD COLUMN cargo TEXT;
ALTER TABLE usuarios ADD COLUMN telefono TEXT;
ALTER TABLE usuarios ADD COLUMN fecha_incorporacion TEXT;
ALTER TABLE usuarios ADD COLUMN plantilla TEXT;
ALTER TABLE usuarios ADD COLUMN permisos_ajustes TEXT;
-- 0 = persona sin acceso al sistema (solo ficha asistencia con PIN). No consume cupo de la licencia.
ALTER TABLE usuarios ADD COLUMN acceso_erp INTEGER NOT NULL DEFAULT 1;
ALTER TABLE usuarios ADD COLUMN pin_hash TEXT;
ALTER TABLE usuarios ADD COLUMN pin_intentos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usuarios ADD COLUMN pin_bloqueado_hasta TEXT;
ALTER TABLE usuarios ADD COLUMN pin_actualizado_at TEXT;

UPDATE usuarios SET plantilla = rol WHERE plantilla IS NULL;
CREATE UNIQUE INDEX idx_usuarios_documento ON usuarios(taller_id, documento) WHERE documento IS NOT NULL AND documento <> '';

-- Un mecánico (persona que se asigna a las OT) corresponde a lo sumo a un usuario.
CREATE UNIQUE INDEX idx_mecanicos_usuario ON mecanicos(taller_id, usuario_id) WHERE usuario_id IS NOT NULL;

-- ───────────────────────── Configuración ─────────────────────────
ALTER TABLE taller_config ADD COLUMN zona_horaria TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires';
ALTER TABLE taller_config ADD COLUMN reloj_activo INTEGER NOT NULL DEFAULT 0;

-- ───────────────────────── Asistencia ─────────────────────────
-- La hora siempre la fija el servidor (UTC). `fecha` es el día local de la entrada según la zona horaria del taller;
-- una jornada que cruza la medianoche pertenece al día en que empezó.
CREATE TABLE asistencias (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  usuario_id TEXT NOT NULL,
  fecha TEXT NOT NULL,
  entrada_at TEXT NOT NULL,
  salida_at TEXT,
  duracion_seg INTEGER,
  origen_entrada TEXT NOT NULL CHECK (origen_entrada IN ('app','reloj','manual')),
  origen_salida TEXT CHECK (origen_salida IN ('app','reloj','manual')),
  dispositivo_id TEXT,
  corregido INTEGER NOT NULL DEFAULT 0,
  anulado INTEGER NOT NULL DEFAULT 0,
  notas TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  CHECK (salida_at IS NULL OR salida_at >= entrada_at),
  FOREIGN KEY (taller_id, usuario_id) REFERENCES usuarios(taller_id, id)
);
-- Una sola jornada abierta por persona: impide fichajes de entrada duplicados aun con solicitudes simultáneas.
CREATE UNIQUE INDEX idx_asistencia_abierta ON asistencias(taller_id, usuario_id) WHERE salida_at IS NULL AND anulado = 0;
CREATE INDEX idx_asistencia_fecha ON asistencias(taller_id, fecha);
CREATE INDEX idx_asistencia_usuario ON asistencias(taller_id, usuario_id, entrada_at);

-- Historial inmutable de las correcciones administrativas (quién, cuándo, valor anterior, valor nuevo y motivo).
CREATE TABLE asistencia_correcciones (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  asistencia_id TEXT NOT NULL,
  usuario_id TEXT NOT NULL,
  accion TEXT NOT NULL CHECK (accion IN ('crear','editar','anular')),
  anterior TEXT,
  nuevo TEXT,
  motivo TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (taller_id, asistencia_id) REFERENCES asistencias(taller_id, id),
  FOREIGN KEY (taller_id, usuario_id) REFERENCES usuarios(taller_id, id)
);
CREATE INDEX idx_asist_corr ON asistencia_correcciones(taller_id, asistencia_id, created_at);

-- ───────────────────────── Reloj compartido ─────────────────────────
-- Un dispositivo se registra con un código de un solo uso (se guarda su hash) y recibe un token propio (también hasheado).
-- El token solo habilita los endpoints /api/reloj/*: no da acceso al resto del sistema. El propietario puede revocarlo.
CREATE TABLE dispositivos_reloj (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','activo','revocado')),
  codigo_hash TEXT,
  codigo_expira TEXT,
  token_hash TEXT,
  creado_por TEXT,
  activado_at TEXT,
  ultimo_uso TEXT,
  revocado_at TEXT,
  revocado_por TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id)
);
CREATE UNIQUE INDEX idx_reloj_codigo ON dispositivos_reloj(codigo_hash) WHERE codigo_hash IS NOT NULL;
CREATE UNIQUE INDEX idx_reloj_token ON dispositivos_reloj(token_hash) WHERE token_hash IS NOT NULL;

-- Contador de intentos fallidos con ventana y bloqueo (PIN del reloj por dispositivo, activación por origen).
CREATE TABLE limites_intentos (
  clave TEXT PRIMARY KEY,
  intentos INTEGER NOT NULL DEFAULT 0,
  desde TEXT NOT NULL,
  bloqueado_hasta TEXT
);

-- ───────────────────────── Órdenes de trabajo: trabajo del mecánico ─────────────────────────
-- Tareas técnicas (checklist de trabajo, independiente de los ítems facturables), observaciones y tiempos dedicados a la reparación.
-- Los tiempos de reparación (por OT) no se mezclan con las horas de asistencia al taller.
CREATE TABLE orden_tareas (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  orden_id TEXT NOT NULL,
  posicion INTEGER NOT NULL DEFAULT 0,
  descripcion TEXT NOT NULL,
  hecha INTEGER NOT NULL DEFAULT 0 CHECK (hecha IN (0,1)),
  hecha_at TEXT,
  hecha_por TEXT,
  creada_por TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (taller_id, orden_id) REFERENCES ordenes(taller_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_orden_tareas ON orden_tareas(taller_id, orden_id, posicion);

CREATE TABLE orden_notas (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  orden_id TEXT NOT NULL,
  usuario_id TEXT,
  texto TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (taller_id, orden_id) REFERENCES ordenes(taller_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_orden_notas ON orden_notas(taller_id, orden_id, created_at);

CREATE TABLE orden_tiempos (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  orden_id TEXT NOT NULL,
  usuario_id TEXT NOT NULL,
  inicio_at TEXT NOT NULL,
  fin_at TEXT,
  duracion_seg INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (taller_id, orden_id) REFERENCES ordenes(taller_id, id) ON DELETE CASCADE,
  FOREIGN KEY (taller_id, usuario_id) REFERENCES usuarios(taller_id, id)
);
-- Una persona trabaja en una sola OT a la vez.
CREATE UNIQUE INDEX idx_orden_tiempos_abierto ON orden_tiempos(taller_id, usuario_id) WHERE fin_at IS NULL;
CREATE INDEX idx_orden_tiempos ON orden_tiempos(taller_id, orden_id);
