-- Fierro · Sprint 07: gestión mecánica avanzada (tempario, historial técnico, mantenimientos, tareas y participantes de las OT).
-- Migración ADITIVA: no elimina ni reescribe datos de negocio existentes. La única tabla reconstruida es orden_tareas (creada en el
-- Sprint 06), cuyas filas se copian íntegras: las tareas hechas pasan a "completada" y las demás a "pendiente".

-- ───────────────────────── Tempario ─────────────────────────
-- El tempario son los servicios (mano de obra) del taller: se les suma código, tiempo genérico y modo de cálculo del precio.
--   modo_precio 'fijo'       → el precio es el cargado en el servicio (comportamiento anterior de todos los servicios existentes).
--   modo_precio 'por_tiempo' → precio = tiempo estimado × tarifa horaria del taller (o de la categoría del servicio).
--   origen 'plantilla'       → tiempo orientativo copiado de la plantilla general y todavía no revisado por el taller.
ALTER TABLE servicios ADD COLUMN codigo TEXT;
ALTER TABLE servicios ADD COLUMN tiempo_min INTEGER CHECK (tiempo_min IS NULL OR (tiempo_min > 0 AND tiempo_min <= 6000));
ALTER TABLE servicios ADD COLUMN modo_precio TEXT NOT NULL DEFAULT 'fijo' CHECK (modo_precio IN ('fijo','por_tiempo'));
ALTER TABLE servicios ADD COLUMN origen TEXT NOT NULL DEFAULT 'propio' CHECK (origen IN ('propio','plantilla'));
CREATE UNIQUE INDEX idx_servicios_codigo ON servicios(taller_id, codigo) WHERE codigo IS NOT NULL AND codigo <> '';

-- Tarifas de mano de obra de cada taller (centavos por hora). 0 = sin configurar.
ALTER TABLE taller_config ADD COLUMN tarifa_hora INTEGER NOT NULL DEFAULT 0 CHECK (tarifa_hora >= 0);
ALTER TABLE categorias_servicio ADD COLUMN tarifa_hora INTEGER CHECK (tarifa_hora IS NULL OR tarifa_hora >= 0);

-- Tiempos específicos de una operación según marca, modelo, motorización y/o rango de años (todos los criterios son opcionales,
-- pero cada regla debe tener al menos uno; sin reglas se usa el tiempo genérico de la operación).
CREATE TABLE servicio_tiempos (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  servicio_id TEXT NOT NULL,
  marca_id TEXT,
  modelo_id TEXT,
  motor TEXT,
  anio_desde INTEGER CHECK (anio_desde IS NULL OR (anio_desde >= 1900 AND anio_desde <= 2100)),
  anio_hasta INTEGER CHECK (anio_hasta IS NULL OR (anio_hasta >= 1900 AND anio_hasta <= 2100)),
  tiempo_min INTEGER NOT NULL CHECK (tiempo_min > 0 AND tiempo_min <= 6000),
  notas TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  CHECK (marca_id IS NOT NULL OR modelo_id IS NOT NULL OR (motor IS NOT NULL AND motor <> '') OR anio_desde IS NOT NULL OR anio_hasta IS NOT NULL),
  CHECK (anio_desde IS NULL OR anio_hasta IS NULL OR anio_hasta >= anio_desde),
  FOREIGN KEY (taller_id, servicio_id) REFERENCES servicios(taller_id, id) ON DELETE CASCADE,
  FOREIGN KEY (taller_id, marca_id) REFERENCES marcas(taller_id, id),
  FOREIGN KEY (taller_id, modelo_id) REFERENCES modelos(taller_id, id)
);
CREATE INDEX idx_servicio_tiempos ON servicio_tiempos(taller_id, servicio_id);

-- Tiempo estimado (minutos por unidad) que traía la operación al incorporarla a un presupuesto o a una OT.
ALTER TABLE presupuesto_items ADD COLUMN tiempo_min INTEGER CHECK (tiempo_min IS NULL OR (tiempo_min >= 0 AND tiempo_min <= 6000));
ALTER TABLE orden_items ADD COLUMN tiempo_min INTEGER CHECK (tiempo_min IS NULL OR (tiempo_min >= 0 AND tiempo_min <= 6000));

-- ───────────────────────── Órdenes de trabajo ─────────────────────────
-- Resultado del trabajo (lo que quedó hecho y cómo terminó), cargado por quien lo realizó.
ALTER TABLE ordenes ADD COLUMN resultado TEXT;

-- Participantes de la OT además del mecánico responsable (ordenes.mecanico_id). Son los mismos usuarios del Sprint 06.
CREATE TABLE orden_participantes (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  orden_id TEXT NOT NULL,
  usuario_id TEXT NOT NULL,
  asignado_por TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, orden_id, usuario_id),
  FOREIGN KEY (taller_id, orden_id) REFERENCES ordenes(taller_id, id) ON DELETE CASCADE,
  FOREIGN KEY (taller_id, usuario_id) REFERENCES usuarios(taller_id, id)
);
CREATE INDEX idx_orden_participantes_usuario ON orden_participantes(taller_id, usuario_id);

-- Tareas: se reconstruye la tabla del Sprint 06 para agregar estado, responsable, tiempo estimado y observaciones con claves
-- foráneas compuestas (SQLite no permite agregarlas con ALTER TABLE).
CREATE TABLE orden_tareas_nueva (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  orden_id TEXT NOT NULL,
  posicion INTEGER NOT NULL DEFAULT 0,
  descripcion TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','en_proceso','pausada','completada')),
  responsable_id TEXT,
  servicio_id TEXT,
  tiempo_estimado_min INTEGER CHECK (tiempo_estimado_min IS NULL OR (tiempo_estimado_min >= 0 AND tiempo_estimado_min <= 60000)),
  observaciones TEXT,
  iniciada_at TEXT,
  hecha_at TEXT,
  hecha_por TEXT,
  creada_por TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  FOREIGN KEY (taller_id, orden_id) REFERENCES ordenes(taller_id, id) ON DELETE CASCADE,
  FOREIGN KEY (taller_id, responsable_id) REFERENCES usuarios(taller_id, id),
  FOREIGN KEY (taller_id, servicio_id) REFERENCES servicios(taller_id, id)
);
INSERT INTO orden_tareas_nueva (id, taller_id, orden_id, posicion, descripcion, estado, iniciada_at, hecha_at, hecha_por, creada_por, created_at)
  SELECT id, taller_id, orden_id, posicion, descripcion, CASE hecha WHEN 1 THEN 'completada' ELSE 'pendiente' END, NULL, hecha_at, hecha_por, creada_por, created_at
    FROM orden_tareas;
DROP TABLE orden_tareas;
ALTER TABLE orden_tareas_nueva RENAME TO orden_tareas;
CREATE INDEX idx_orden_tareas ON orden_tareas(taller_id, orden_id, posicion);
CREATE INDEX idx_orden_tareas_resp ON orden_tareas(taller_id, responsable_id, estado);

-- El cronómetro de la OT (Sprint 06) puede atribuirse a una tarea: el tiempo real de la tarea es la suma de esos tramos.
ALTER TABLE orden_tiempos ADD COLUMN tarea_id TEXT REFERENCES orden_tareas(id) ON DELETE SET NULL;
CREATE INDEX idx_orden_tiempos_tarea ON orden_tiempos(taller_id, tarea_id);
CREATE INDEX idx_orden_tiempos_inicio ON orden_tiempos(taller_id, inicio_at);

-- ───────────────────────── Historial técnico del vehículo ─────────────────────────
-- El historial se arma con las órdenes de trabajo existentes. Esta tabla guarda SOLO los antecedentes anteriores a Fierro (o
-- hechos en otro taller) cargados manualmente: no duplica nada de lo que ya figura en las OT.
CREATE TABLE vehiculo_antecedentes (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  vehiculo_id TEXT NOT NULL,
  fecha TEXT NOT NULL,
  km INTEGER CHECK (km IS NULL OR km >= 0),
  tipo TEXT NOT NULL DEFAULT 'reparacion' CHECK (tipo IN ('mantenimiento','reparacion','diagnostico','otro')),
  descripcion TEXT NOT NULL,
  servicio_id TEXT,
  repuestos TEXT,
  realizado_por TEXT,
  resultado TEXT,
  observaciones TEXT,
  anulado INTEGER NOT NULL DEFAULT 0 CHECK (anulado IN (0,1)),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  FOREIGN KEY (taller_id, vehiculo_id) REFERENCES vehiculos(taller_id, id),
  FOREIGN KEY (taller_id, servicio_id) REFERENCES servicios(taller_id, id)
);
CREATE INDEX idx_antecedentes_vehiculo ON vehiculo_antecedentes(taller_id, vehiculo_id, fecha);

-- ───────────────────────── Mantenimientos programados ─────────────────────────
-- Plan de mantenimiento de un vehículo para una operación del taller. Los intervalos en blanco heredan los del servicio.
-- Las fechas y kilómetros de la última realización NO se guardan acá: se calculan de las OT (lista/entregada) y de los antecedentes.
CREATE TABLE vehiculo_mantenimientos (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  vehiculo_id TEXT NOT NULL,
  servicio_id TEXT NOT NULL,
  intervalo_km INTEGER CHECK (intervalo_km IS NULL OR (intervalo_km > 0 AND intervalo_km <= 1000000)),
  intervalo_meses INTEGER CHECK (intervalo_meses IS NULL OR (intervalo_meses > 0 AND intervalo_meses <= 240)),
  activo INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0,1)),
  notas TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, vehiculo_id, servicio_id),
  FOREIGN KEY (taller_id, vehiculo_id) REFERENCES vehiculos(taller_id, id),
  FOREIGN KEY (taller_id, servicio_id) REFERENCES servicios(taller_id, id)
);
