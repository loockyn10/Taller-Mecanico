-- Fierro · Sprint 23 · Vehículos independientes de los clientes y vínculos vehículo-cliente muchos a muchos.
--
-- Qué cambia
--   1. `vehiculos.cliente_id` (NOT NULL, con clave foránea) desaparece: un vehículo puede existir sin ningún cliente.
--   2. Nace `vehiculo_clientes`: un vehículo puede tener ningún cliente, uno o varios al mismo tiempo, con un tipo de relación opcional
--      (titular, familiar, conductor, responsable comercial, otro) y su historial (fecha de vinculación y de desvinculación).
--   3. Cada vínculo actual de un vehículo existente pasa a `vehiculo_clientes` como «titular» vigente (antes la pantalla lo llamaba «Dueño»).
--      No queda ninguna otra fuente de verdad: la columna vieja se elimina en esta misma migración.
--
-- Lo que NO cambia: `ordenes`, `presupuestos`, `turnos`, `ventas`, `ck_registros`, etc. conservan su propio `cliente_id` (el responsable de
-- ESA operación en el momento de crearla). Ninguna fila de ninguna otra tabla se modifica ni se elimina.
--
-- SQLite no permite quitar una columna que forma parte de una clave foránea, así que se reconstruye `vehiculos`. Otras tablas la referencian
-- (ordenes, presupuestos, turnos, fotos, checklists, mantenimientos, antecedentes…): con las claves foráneas activas, DROP TABLE cuenta cada fila
-- hija como una violación; `defer_foreign_keys` las difiere hasta el final de la transacción y cada INSERT de la tabla nueva las resuelve.
-- Las filas se copian desde una tabla de resguardo y ésta se elimina al final; los índices, las restricciones y las claves se vuelven a declarar.
PRAGMA defer_foreign_keys = on;

-- Si un intento anterior se interrumpió a mitad de camino, no quedó nada que estorbe (el resguardo es descartable: `vehiculos` sigue intacto hasta el DROP).
DROP TABLE IF EXISTS vehiculos_resguardo;

CREATE TABLE vehiculos_resguardo AS SELECT * FROM vehiculos;

DROP TABLE vehiculos;

CREATE TABLE vehiculos (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  patente TEXT NOT NULL,
  marca_id TEXT,
  modelo_id TEXT,
  anio INTEGER,
  color TEXT,
  vin TEXT,
  motor TEXT,
  combustible TEXT,
  km_actual INTEGER NOT NULL DEFAULT 0 CHECK (km_actual >= 0),
  notas TEXT,
  activo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  cat_modelo_id TEXT,
  cat_version_id TEXT,
  version TEXT,
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, patente),
  FOREIGN KEY (taller_id, marca_id) REFERENCES marcas(taller_id, id),
  FOREIGN KEY (taller_id, modelo_id) REFERENCES modelos(taller_id, id)
);

INSERT INTO vehiculos (id, taller_id, patente, marca_id, modelo_id, anio, color, vin, motor, combustible, km_actual, notas, activo, created_at, updated_at, cat_modelo_id, cat_version_id, version)
  SELECT id, taller_id, patente, marca_id, modelo_id, anio, color, vin, motor, combustible, km_actual, notas, activo, created_at, updated_at, cat_modelo_id, cat_version_id, version
    FROM vehiculos_resguardo;

-- Vínculos vehículo-cliente. Un vínculo cerrado (desvinculado_at) se conserva como historial: la desvinculación normal nunca borra la fila.
CREATE TABLE vehiculo_clientes (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  vehiculo_id TEXT NOT NULL,
  cliente_id TEXT NOT NULL,
  -- titular | familiar | conductor | responsable_comercial | otro; opcional (se valida en la API, así se pueden sumar tipos sin reconstruir la tabla).
  relacion TEXT CHECK (relacion IS NULL OR length(relacion) BETWEEN 1 AND 40),
  vinculado_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  vinculado_por TEXT,
  desvinculado_at TEXT,
  desvinculado_por TEXT,
  UNIQUE (taller_id, id),
  CHECK (desvinculado_at IS NULL OR desvinculado_at >= vinculado_at),
  CHECK (desvinculado_por IS NULL OR desvinculado_at IS NOT NULL),
  FOREIGN KEY (taller_id, vehiculo_id) REFERENCES vehiculos(taller_id, id),
  FOREIGN KEY (taller_id, cliente_id) REFERENCES clientes(taller_id, id),
  FOREIGN KEY (taller_id, vinculado_por) REFERENCES usuarios(taller_id, id),
  FOREIGN KEY (taller_id, desvinculado_por) REFERENCES usuarios(taller_id, id)
);
-- Un mismo cliente no puede estar vinculado dos veces (vigente) al mismo vehículo; los vínculos cerrados no cuentan.
CREATE UNIQUE INDEX uq_vehiculo_clientes_vigente ON vehiculo_clientes(taller_id, vehiculo_id, cliente_id) WHERE desvinculado_at IS NULL;
CREATE INDEX idx_vehiculo_clientes_vehiculo ON vehiculo_clientes(taller_id, vehiculo_id, desvinculado_at);
CREATE INDEX idx_vehiculo_clientes_cliente ON vehiculo_clientes(taller_id, cliente_id, desvinculado_at);

-- Cada asociación que existía hasta ahora (un cliente por vehículo, incluidos los vehículos dados de baja) queda como vínculo vigente.
INSERT INTO vehiculo_clientes (id, taller_id, vehiculo_id, cliente_id, relacion, vinculado_at)
  SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-a' || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
         taller_id, id, cliente_id, 'titular', created_at
    FROM vehiculos_resguardo;

DROP TABLE vehiculos_resguardo;
