-- Fierro · Sprint 16 · Fotografías de vehículos y órdenes de trabajo.
--
-- Migración ADITIVA: sólo crea tablas e índices nuevos. No modifica ningún dato existente.
--
-- Los archivos NO viven en D1: están en un bucket privado de Cloudflare R2 (binding FIERRO_FOTOS). Acá sólo hay referencias y metadatos.
-- Clave del objeto en R2 (se arma siempre con el taller de la sesión, nunca con datos del cliente): fotos/<taller_id>/<foto_id>[_m]
--   · `_m` es la miniatura. El archivo se guarda una sola vez: la misma foto se ve en la ficha del vehículo y en la OT.
--
-- Estados: pendiente (reservó cupo y todavía se está guardando el archivo), lista, eliminada (oculta; el Cron termina de borrar el objeto de R2 y la fila).
--   Un pendiente que quedó a medias (corte entre D1 y R2) o una eliminada con el borrado en R2 incompleto se limpian solos: no quedan objetos huérfanos.
-- `idem_key` la genera el navegador al elegir la foto: reintentar una subida interrumpida no la duplica.
-- sha256 (archivo y miniatura): permite verificar una exportación de las fotos contra esta tabla.

CREATE TABLE fotos (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  vehiculo_id TEXT NOT NULL,
  orden_id TEXT,
  etapa TEXT CHECK (etapa IN ('recepcion', 'reparacion', 'entrega')),
  descripcion TEXT,
  idem_key TEXT NOT NULL,
  mime TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/webp')),
  ancho INTEGER NOT NULL CHECK (ancho > 0),
  alto INTEGER NOT NULL CHECK (alto > 0),
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  miniatura_bytes INTEGER NOT NULL CHECK (miniatura_bytes > 0),
  sha256 TEXT NOT NULL,
  miniatura_sha256 TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'lista', 'eliminada')),
  usuario_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  eliminada_at TEXT,
  eliminada_por TEXT,
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, idem_key),
  -- Una foto de OT siempre tiene etapa; una del vehículo (sin OT) no.
  CHECK ((orden_id IS NULL AND etapa IS NULL) OR (orden_id IS NOT NULL AND etapa IS NOT NULL)),
  FOREIGN KEY (taller_id, vehiculo_id) REFERENCES vehiculos(taller_id, id),
  FOREIGN KEY (taller_id, orden_id) REFERENCES ordenes(taller_id, id)
);
CREATE INDEX idx_fotos_vehiculo ON fotos(taller_id, vehiculo_id, estado, created_at);
CREATE INDEX idx_fotos_orden ON fotos(taller_id, orden_id, estado, created_at);
CREATE INDEX idx_fotos_uso ON fotos(taller_id, estado);

-- Límite de almacenamiento de fotografías por taller (provisorio: 2 GB; lo ajusta la administración de la plataforma, no el taller).
-- Sin fila = límite por defecto. No es todavía un plan comercial ni toca las licencias por usuario.
CREATE TABLE taller_almacenamiento (
  taller_id TEXT PRIMARY KEY REFERENCES talleres(id) ON DELETE CASCADE,
  fotos_limite_bytes INTEGER NOT NULL DEFAULT 2147483648 CHECK (fotos_limite_bytes > 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
