-- Fierro · Sprint 18 · Checklist de recepción y entrega de vehículos (con registro de daños y conformidad del cliente).
--
-- Migración ADITIVA: crea tablas, índices y disparadores nuevos y agrega UN disparador de protección sobre `fotos`. No modifica ni elimina ningún dato existente.
-- El check-list simple anterior (tabla `checklists`, una fila por OT) NO se toca: sigue funcionando y sus datos se conservan.
--
-- Modelo:
--   ck_registros  Una recepción o una entrega de una OT. Nace como BORRADOR (editable, se guarda en el servidor) y al confirmarlo queda CONGELADA: el servidor calcula el
--                 sha256 del contenido exacto (contenido + contexto: cliente, vehículo, responsable y fotos incluidas). Una corrección no pisa nada: crea una REVISIÓN
--                 (revision + 1, previo_id) con su motivo; la vigente es la última confirmada y el original sigue consultable.
--   ck_firmas     Conformidad del cliente: firma manuscrita capturada en pantalla (trazos vectoriales, no una imagen), "no está presente" o "no desea firmar".
--                 Guarda el hash del contenido que se aceptó y el texto que se le mostró. Sólo se agrega; nunca se modifica ni se borra. NO es una firma digital certificada.
--   ck_fotos      Fotografías del Sprint 16 (siempre las mismas filas de `fotos`, un solo archivo en R2) que quedaron incluidas en un registro confirmado.
--                 Mientras exista este vínculo la fotografía no se puede eliminar (evidencia).
--
-- Importes: nada de esto contiene precios ni costos.

CREATE TABLE ck_registros (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  orden_id TEXT NOT NULL,
  vehiculo_id TEXT NOT NULL,
  cliente_id TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('recepcion', 'entrega')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  previo_id TEXT,
  motivo TEXT,
  -- En una entrega: la recepción vigente al momento de confirmarla (para compararlas). Sin recepción previa queda vacío.
  recepcion_id TEXT,
  estado TEXT NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador', 'confirmado')),
  -- Control de concurrencia del borrador (dos personas editando a la vez).
  version INTEGER NOT NULL DEFAULT 1,
  checklist_version INTEGER NOT NULL,
  datos TEXT NOT NULL,
  contexto TEXT,
  contenido_sha256 TEXT,
  fecha_hora TEXT NOT NULL,
  km INTEGER CHECK (km IS NULL OR km >= 0),
  combustible TEXT CHECK (combustible IS NULL OR combustible IN ('reserva', '1/4', '1/2', '3/4', 'lleno')),
  responsable_id TEXT,
  responsable_nombre TEXT NOT NULL,
  creado_por TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  confirmado_at TEXT,
  confirmado_por TEXT,
  confirmado_por_nombre TEXT,
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, orden_id, tipo, revision),
  CHECK ((revision = 0 AND previo_id IS NULL) OR (revision > 0 AND previo_id IS NOT NULL AND motivo IS NOT NULL)),
  CHECK (estado = 'borrador' OR (contenido_sha256 IS NOT NULL AND contexto IS NOT NULL AND confirmado_at IS NOT NULL)),
  FOREIGN KEY (taller_id, orden_id) REFERENCES ordenes(taller_id, id),
  FOREIGN KEY (taller_id, vehiculo_id) REFERENCES vehiculos(taller_id, id),
  FOREIGN KEY (taller_id, cliente_id) REFERENCES clientes(taller_id, id),
  FOREIGN KEY (taller_id, previo_id) REFERENCES ck_registros(taller_id, id),
  FOREIGN KEY (taller_id, recepcion_id) REFERENCES ck_registros(taller_id, id)
);
-- A lo sumo un borrador abierto por OT y tipo (una recepción o su corrección en curso).
CREATE UNIQUE INDEX idx_ck_borrador ON ck_registros(taller_id, orden_id, tipo) WHERE estado = 'borrador';
CREATE INDEX idx_ck_orden ON ck_registros(taller_id, orden_id, tipo, revision);
CREATE INDEX idx_ck_vehiculo ON ck_registros(taller_id, vehiculo_id, created_at);

-- Un registro confirmado no se modifica ni se borra: la corrección es una revisión nueva.
CREATE TRIGGER trg_ck_registros_inmutable BEFORE UPDATE ON ck_registros
WHEN OLD.estado = 'confirmado'
BEGIN SELECT RAISE(ABORT, 'ck_registro_confirmado_inmutable'); END;

CREATE TRIGGER trg_ck_registros_sin_borrar BEFORE DELETE ON ck_registros
WHEN OLD.estado = 'confirmado'
BEGIN SELECT RAISE(ABORT, 'ck_registro_confirmado_inmutable'); END;

CREATE TABLE ck_firmas (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  registro_id TEXT NOT NULL,
  resultado TEXT NOT NULL CHECK (resultado IN ('firmada', 'no_presente', 'se_niega')),
  nombre_firmante TEXT,
  aclaracion TEXT,
  -- Trazos de la firma (JSON: lienzo y listas de puntos). Es un dibujo vectorial, no una fotografía: no usa el almacenamiento de imágenes.
  firma TEXT,
  firma_sha256 TEXT,
  -- Hash del contenido del registro que se mostró y se aceptó, y texto de conformidad (con su versión) que leyó el cliente.
  contenido_sha256 TEXT NOT NULL,
  checklist_version INTEGER NOT NULL,
  texto_conformidad TEXT NOT NULL,
  texto_version INTEGER NOT NULL,
  registrado_por TEXT,
  registrado_por_nombre TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  CHECK (resultado <> 'firmada' OR (firma IS NOT NULL AND firma_sha256 IS NOT NULL AND nombre_firmante IS NOT NULL AND length(trim(nombre_firmante)) > 0)),
  CHECK (resultado = 'firmada' OR aclaracion IS NOT NULL),
  FOREIGN KEY (taller_id, registro_id) REFERENCES ck_registros(taller_id, id)
);
CREATE INDEX idx_ck_firmas ON ck_firmas(taller_id, registro_id, created_at);
-- Una sola firma efectiva por registro. "No presente" / "se niega" no la impiden: el cliente puede volver y firmar después (queda todo el historial).
CREATE UNIQUE INDEX idx_ck_firma_unica ON ck_firmas(taller_id, registro_id) WHERE resultado = 'firmada';

-- La firma sólo puede referirse a un registro ya confirmado y a su contenido exacto.
CREATE TRIGGER trg_ck_firmas_contenido BEFORE INSERT ON ck_firmas
WHEN NOT EXISTS (SELECT 1 FROM ck_registros r WHERE r.taller_id = NEW.taller_id AND r.id = NEW.registro_id AND r.estado = 'confirmado' AND r.contenido_sha256 = NEW.contenido_sha256)
BEGIN SELECT RAISE(ABORT, 'ck_firma_contenido_distinto'); END;

CREATE TRIGGER trg_ck_firmas_inmutable BEFORE UPDATE ON ck_firmas
BEGIN SELECT RAISE(ABORT, 'ck_firma_inmutable'); END;

CREATE TRIGGER trg_ck_firmas_sin_borrar BEFORE DELETE ON ck_firmas
BEGIN SELECT RAISE(ABORT, 'ck_firma_inmutable'); END;

CREATE TABLE ck_fotos (
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  registro_id TEXT NOT NULL,
  foto_id TEXT NOT NULL,
  -- Daño al que se asoció la fotografía (id interno del contenido del registro); vacío = fotografía general de la etapa.
  dano_id TEXT,
  PRIMARY KEY (registro_id, foto_id),
  FOREIGN KEY (taller_id, registro_id) REFERENCES ck_registros(taller_id, id),
  FOREIGN KEY (taller_id, foto_id) REFERENCES fotos(taller_id, id)
);
CREATE INDEX idx_ck_fotos_foto ON ck_fotos(taller_id, foto_id);

CREATE TRIGGER trg_ck_fotos_inmutable BEFORE UPDATE ON ck_fotos
BEGIN SELECT RAISE(ABORT, 'ck_foto_inmutable'); END;

CREATE TRIGGER trg_ck_fotos_sin_borrar BEFORE DELETE ON ck_fotos
BEGIN SELECT RAISE(ABORT, 'ck_foto_inmutable'); END;

-- Protección de la evidencia: una fotografía incluida en una recepción o entrega confirmada no puede pasar a "eliminada" (ni, por la clave foránea, borrarse).
CREATE TRIGGER trg_fotos_en_checklist BEFORE UPDATE OF estado ON fotos
WHEN NEW.estado = 'eliminada' AND EXISTS (SELECT 1 FROM ck_fotos k WHERE k.taller_id = OLD.taller_id AND k.foto_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'foto_en_checklist'); END;
