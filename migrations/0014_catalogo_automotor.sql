-- Fierro · Sprint 15 · Catálogo automotor argentino compartido.
--
-- Migración ADITIVA: crea tablas globales nuevas (sin taller_id: son datos públicos compartidos por todos los talleres) y agrega columnas
-- opcionales a vehiculos, marcas y modelos. No modifica ni elimina ningún dato existente: los vehículos conservan su marca, modelo y datos.
--
-- Fuente: DNRPA, "Inscripciones iniciales de autos" (datos.jus.gob.ar, CC BY 4.0). Sólo datos del vehículo; nunca datos de titulares.
-- Las tablas se cargan con `npm run catalogo -- cargar` (no con esta migración: así las pruebas de migración siguen siendo livianas).
--
-- Niveles: marca → modelo (familia) → versión (descripción comercial tal como la informó el registro). La fuente NO trae motorización
-- estructurada: `motorizacion` sólo se completa cuando la descripción la menciona literalmente (cilindrada, TDI, V6…).

CREATE TABLE cat_marcas (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  clave TEXT NOT NULL,          -- minúsculas, sin tildes ni signos: para buscar
  busqueda TEXT,                -- apodos de búsqueda (p. ej. "vw"), ya en clave
  codigos TEXT NOT NULL,        -- JSON: códigos de marca originales de la DNRPA
  n INTEGER NOT NULL DEFAULT 0  -- inscripciones en el período procesado (para ordenar por frecuencia)
);

CREATE TABLE cat_modelos (
  id TEXT PRIMARY KEY,
  marca_id TEXT NOT NULL REFERENCES cat_marcas(id),
  nombre TEXT NOT NULL,
  clave TEXT NOT NULL,
  tipo TEXT,                    -- tipo de vehículo dominante según la fuente
  anios TEXT NOT NULL,          -- años modelo con inscripciones, separados por coma
  n INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_cat_modelos_marca ON cat_modelos(marca_id);

CREATE TABLE cat_versiones (
  id TEXT PRIMARY KEY,
  modelo_id TEXT NOT NULL REFERENCES cat_modelos(id),
  descripcion TEXT NOT NULL,    -- descripción completa original (normalizada a mayúsculas)
  version TEXT,                 -- lo que sigue al nombre del modelo
  motorizacion TEXT,            -- sólo si la descripción la menciona
  combustible TEXT,             -- sólo si la descripción lo indica (diésel, híbrido, eléctrico)
  tipo TEXT,
  codigos TEXT NOT NULL,        -- JSON: "marca/modelo/tipo" originales de la DNRPA
  anios TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_cat_versiones_modelo ON cat_versiones(modelo_id);

CREATE TABLE cat_meta (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);

-- Fichas técnicas por motorización: estructura lista, SIN datos. Cada ficha exige fuente y fecha de verificación, para que nada
-- (ni una persona ni una IA) pueda cargar una especificación sin respaldo. En este sprint no hay pantallas ni API para cargarlas.
CREATE TABLE cat_fichas (
  id TEXT PRIMARY KEY,
  modelo_id TEXT NOT NULL REFERENCES cat_modelos(id),
  version_id TEXT REFERENCES cat_versiones(id),
  motorizacion TEXT,
  anio_desde INTEGER,
  anio_hasta INTEGER,
  codigo_motor TEXT,
  aceite_recomendado TEXT,
  aceite_capacidad_l REAL CHECK (aceite_capacidad_l IS NULL OR aceite_capacidad_l > 0),
  refrigerante TEXT,
  filtros TEXT,                 -- JSON: {aceite, aire, combustible, habitaculo…} con sus referencias
  distribucion TEXT,            -- correa/cadena y su intervalo
  intervalos TEXT,              -- JSON: intervalos de mantenimiento (km / meses)
  documentacion_url TEXT,
  fuente TEXT NOT NULL CHECK (length(trim(fuente)) > 0),
  fecha_verificacion TEXT NOT NULL CHECK (length(fecha_verificacion) = 10),
  notas TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_cat_fichas_modelo ON cat_fichas(modelo_id);

-- Vínculos opcionales con el catálogo. Los textos que ya tenían los talleres no se tocan.
ALTER TABLE marcas ADD COLUMN cat_marca_id TEXT;
ALTER TABLE modelos ADD COLUMN cat_modelo_id TEXT;
ALTER TABLE vehiculos ADD COLUMN cat_modelo_id TEXT;
ALTER TABLE vehiculos ADD COLUMN cat_version_id TEXT;
ALTER TABLE vehiculos ADD COLUMN version TEXT;
