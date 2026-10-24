-- Fierro · Sprint 20 · Seguimiento público de órdenes de trabajo (enlace individual para el cliente, sin iniciar sesión).
--
-- Migración ADITIVA: crea tablas, índices y un disparador nuevos. No modifica ni elimina ningún dato existente y NO toca `ordenes` ni `orden_eventos`:
-- el estado que ve el cliente se deriva del estado operativo de la OT y de sus eventos de siempre (no hay un segundo sistema de estados que mantener).
--
-- Modelo:
--   seguimiento_enlaces            Un enlace por OT. `token` (32 bytes aleatorios, base64url = 43 caracteres) es la ÚNICA credencial: nunca se deduce del número ni del id de
--                                  la orden. Se guarda tal cual (hay que poder volver a copiar o a mostrar el enlace); la tabla sólo se lee desde el servidor. Desactivar apaga el
--                                  enlace sin perder el token; regenerar REEMPLAZA el token (el anterior deja de existir en la base: falla de inmediato).
--   seguimiento_mensajes           Observaciones públicas del taller para el cliente, con historial y responsable. Son un campo aparte de las notas internas: nada se copia
--                                  de las notas ni de la nota del cambio de estado. El texto no se edita (para corregir se publica otro mensaje o se retira el vigente).
--   seguimiento_eventos_ocultos    Transiciones de estado que el taller decidió NO mostrar en el seguimiento (por ejemplo un paso interno sin interés para el cliente).
--
-- Importes: nada de esto contiene precios, costos ni datos personales del cliente.

CREATE TABLE seguimiento_enlaces (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  orden_id TEXT NOT NULL,
  token TEXT NOT NULL CHECK (length(token) = 43),
  activo INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
  -- Si la fecha de entrega prometida de la OT se muestra al cliente (siempre como estimación).
  mostrar_fecha_estimada INTEGER NOT NULL DEFAULT 1 CHECK (mostrar_fecha_estimada IN (0, 1)),
  -- Cuántas veces se generó un token nuevo (1 = el original).
  generacion INTEGER NOT NULL DEFAULT 1 CHECK (generacion >= 1),
  creado_por TEXT,
  creado_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  token_generado_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  activado_at TEXT,
  desactivado_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, orden_id),
  FOREIGN KEY (taller_id, orden_id) REFERENCES ordenes(taller_id, id) ON DELETE CASCADE
);
-- La consulta pública busca únicamente por token: índice único (dos órdenes nunca comparten token).
CREATE UNIQUE INDEX idx_seguimiento_token ON seguimiento_enlaces(token);

CREATE TABLE seguimiento_mensajes (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  orden_id TEXT NOT NULL,
  texto TEXT NOT NULL CHECK (length(trim(texto)) BETWEEN 1 AND 500),
  usuario_id TEXT,
  creado_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  retirado_at TEXT,
  retirado_por TEXT,
  FOREIGN KEY (taller_id, orden_id) REFERENCES ordenes(taller_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_seguimiento_mensajes ON seguimiento_mensajes(taller_id, orden_id, creado_at);

-- El historial de lo publicado no se reescribe: sólo se puede retirar un mensaje (retirado_at / retirado_por).
CREATE TRIGGER trg_seguimiento_mensajes_inmutable
BEFORE UPDATE OF texto, usuario_id, creado_at, orden_id, taller_id ON seguimiento_mensajes
BEGIN
  SELECT RAISE(ABORT, 'seguimiento_mensaje_inmutable');
END;

CREATE TABLE seguimiento_eventos_ocultos (
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  orden_id TEXT NOT NULL,
  evento_id TEXT NOT NULL REFERENCES orden_eventos(id) ON DELETE CASCADE,
  oculto_por TEXT,
  oculto_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (taller_id, evento_id),
  FOREIGN KEY (taller_id, orden_id) REFERENCES ordenes(taller_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_seguimiento_ocultos ON seguimiento_eventos_ocultos(taller_id, orden_id);
