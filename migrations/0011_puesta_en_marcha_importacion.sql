-- Fierro · Sprint 11 · Puesta en marcha autónoma e importación de datos.
-- Migración ADITIVA: sólo agrega columnas opcionales, tablas e índices nuevos. No modifica ni elimina ningún dato existente
-- (comprobantes, cobros, stock, asientos, usuarios...). Los talleres que ya existen no ven el asistente de primer inicio
-- (asistente_pendiente = 0 por defecto): sólo los que se activan desde una invitación lo reciben.

-- ───────────────────────── Datos del negocio ─────────────────────────
ALTER TABLE talleres ADD COLUMN provincia TEXT;
-- Horarios de atención (JSON: lista de 7 días con apertura y cierre) y logo (data URL png/jpeg/webp, tope de tamaño en la API).
ALTER TABLE taller_config ADD COLUMN horarios_atencion TEXT;
ALTER TABLE taller_config ADD COLUMN logo TEXT;
-- 1 = el taller recién activado todavía no cerró el asistente de configuración inicial.
ALTER TABLE taller_config ADD COLUMN asistente_pendiente INTEGER NOT NULL DEFAULT 0 CHECK (asistente_pendiente IN (0,1));

-- Código que el cliente / proveedor tenía en el sistema anterior: permite vincular vehículos y artículos sin depender de nombres.
ALTER TABLE clientes ADD COLUMN codigo_externo TEXT;
ALTER TABLE proveedores ADD COLUMN codigo_externo TEXT;
CREATE UNIQUE INDEX idx_clientes_codigo_externo ON clientes(taller_id, codigo_externo) WHERE codigo_externo IS NOT NULL AND codigo_externo <> '';
CREATE UNIQUE INDEX idx_proveedores_codigo_externo ON proveedores(taller_id, codigo_externo) WHERE codigo_externo IS NOT NULL AND codigo_externo <> '';

-- ───────────────────────── Puesta en marcha ─────────────────────────
-- Pasos que el taller marcó como hechos u omitidos a mano. Los demás se calculan a partir de los datos reales (ver worker/lib/puesta-en-marcha.ts).
CREATE TABLE puesta_marcha_pasos (
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  paso TEXT NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('hecho','omitido')),
  usuario_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (taller_id, paso)
);

-- ───────────────────────── Invitaciones de activación ─────────────────────────
-- La invitación la genera la plataforma (CLI con PLATFORM_ADMIN_TOKEN; ese token nunca llega al navegador). Sólo se guarda el hash del
-- enlace: el enlace en sí se muestra una única vez. Es de un solo uso y vence. Al activarla se crea el taller con su licencia.
CREATE TABLE invitaciones_activacion (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  nombre_sugerido TEXT,
  email_destino TEXT COLLATE NOCASE,
  plan TEXT NOT NULL DEFAULT 'base',
  usuarios_incluidos INTEGER NOT NULL DEFAULT 1 CHECK (usuarios_incluidos >= 1),
  usuarios_adicionales INTEGER NOT NULL DEFAULT 0 CHECK (usuarios_adicionales >= 0),
  notas TEXT,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','usada','revocada')),
  vence_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  usada_at TEXT,
  revocada_at TEXT,
  taller_id TEXT REFERENCES talleres(id) ON DELETE SET NULL
);
CREATE INDEX idx_invitaciones_estado ON invitaciones_activacion(estado, vence_at);

-- ───────────────────────── Importaciones ─────────────────────────
-- Cada importación es un trabajo trazable: quién, cuándo, qué archivo (nombre y huella, no el contenido), qué tipo, con qué modo y qué resultado.
-- Se procesa en lotes; el par (importación, lote) es único, de modo que reintentar un lote ya aplicado no duplica nada.
CREATE TABLE importaciones (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  usuario_id TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('clientes','vehiculos','articulos','proveedores')),
  modo TEXT NOT NULL CHECK (modo IN ('omitir','actualizar','solo_nuevos')),
  opciones TEXT,
  archivo_nombre TEXT NOT NULL,
  archivo_hash TEXT NOT NULL,
  archivo_bytes INTEGER NOT NULL DEFAULT 0,
  mapeo TEXT,
  total_filas INTEGER NOT NULL CHECK (total_filas >= 0),
  estado TEXT NOT NULL DEFAULT 'en_curso' CHECK (estado IN ('en_curso','completada','cancelada')),
  procesados INTEGER NOT NULL DEFAULT 0,
  creados INTEGER NOT NULL DEFAULT 0,
  actualizados INTEGER NOT NULL DEFAULT 0,
  omitidos INTEGER NOT NULL DEFAULT 0,
  errores INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finalizada_at TEXT,
  UNIQUE (taller_id, id),
  FOREIGN KEY (taller_id, usuario_id) REFERENCES usuarios(taller_id, id)
);
CREATE INDEX idx_importaciones_taller ON importaciones(taller_id, created_at);
CREATE INDEX idx_importaciones_hash ON importaciones(taller_id, tipo, archivo_hash);

CREATE TABLE importacion_lotes (
  taller_id TEXT NOT NULL,
  importacion_id TEXT NOT NULL,
  lote INTEGER NOT NULL CHECK (lote >= 0),
  filas INTEGER NOT NULL,
  creados INTEGER NOT NULL DEFAULT 0,
  actualizados INTEGER NOT NULL DEFAULT 0,
  omitidos INTEGER NOT NULL DEFAULT 0,
  errores INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (importacion_id, lote),
  FOREIGN KEY (taller_id, importacion_id) REFERENCES importaciones(taller_id, id) ON DELETE CASCADE
);

-- Filas con error u omitidas (con el motivo). No guarda los datos de la fila: sólo su número y una referencia corta (nombre, patente o código).
CREATE TABLE importacion_errores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taller_id TEXT NOT NULL,
  importacion_id TEXT NOT NULL,
  lote INTEGER NOT NULL,
  fila INTEGER NOT NULL,
  severidad TEXT NOT NULL CHECK (severidad IN ('error','omitido')),
  referencia TEXT,
  mensaje TEXT NOT NULL,
  FOREIGN KEY (taller_id, importacion_id) REFERENCES importaciones(taller_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_importacion_errores ON importacion_errores(importacion_id, fila);

-- Registros creados o modificados por la importación: sirve para detectar duplicados dentro del mismo archivo entre lotes y para la trazabilidad.
CREATE TABLE importacion_registros (
  taller_id TEXT NOT NULL,
  importacion_id TEXT NOT NULL,
  entidad_id TEXT NOT NULL,
  accion TEXT NOT NULL CHECK (accion IN ('creado','actualizado')),
  PRIMARY KEY (importacion_id, entidad_id),
  FOREIGN KEY (taller_id, importacion_id) REFERENCES importaciones(taller_id, id) ON DELETE CASCADE
);
