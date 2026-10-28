-- Fierro · Sprint 25 · Pago del cliente desde el portal de seguimiento (medio de pago, comprobantes de transferencia y verificación administrativa).
--
-- Migración EXPANSIVA y compatible hacia atrás: sólo agrega una columna con valor por defecto, tablas nuevas, índices y disparadores nuevos.
-- No modifica ni elimina datos, no reconstruye ninguna tabla y no toca el libro de caja, el de bancos, `cobros` ni `ordenes`. El código anterior (Sprint 24)
-- sigue funcionando con este esquema (no lee ni escribe nada de lo nuevo): se migra primero y se publica después, sin ventana de incompatibilidad.
--
-- Qué NO se crea (a propósito): un sistema de cobros, un libro de dinero ni un registro bancario paralelos. Confirmar una transferencia usa el cobro de siempre
-- (`cobros` / `cobro_medios` → caja, banco, cheques y asientos derivados); acá sólo queda la evidencia (el comprobante) y la decisión del administrativo.
--
-- Modelo:
--   cuentas_bancarias.publica_en_portal   La cuenta que el taller publica para que sus clientes le transfieran (a lo sumo una por taller). Se reutiliza la cuenta
--                                         bancaria ya cargada en Finanzas (titular, banco, alias, CBU): no se duplican datos.
--   pago_importe_ot                       Si el taller informó el importe de la OT al cliente (importe «confirmado» para comunicar). Sin esa marca (o sin comprobante
--                                         emitido) la página pública dice «Importe pendiente de confirmación» y no admite comprobantes.
--   pago_elecciones                       Historial inmutable de lo que eligió el cliente (efectivo / transferencia), con el importe de la OT y el saldo al momento.
--                                         La elección NO genera ningún cobro.
--   pago_comprobantes                     Comprobantes de transferencia enviados por el cliente (archivo en R2, bucket privado ya existente). Un comprobante no
--                                         demuestra por sí solo que el dinero ingresó: queda «pendiente» hasta que un administrativo lo confirma (y entonces se
--                                         enlaza al cobro real) o lo rechaza con un motivo. Los resueltos no se modifican ni se reemplazan.

ALTER TABLE cuentas_bancarias ADD COLUMN publica_en_portal INTEGER NOT NULL DEFAULT 0 CHECK (publica_en_portal IN (0, 1));
-- Una sola cuenta publicada por taller (la base lo garantiza aunque dos administradores publiquen a la vez).
CREATE UNIQUE INDEX idx_cuentas_portal ON cuentas_bancarias(taller_id) WHERE publica_en_portal = 1;

CREATE TABLE pago_importe_ot (
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  orden_id TEXT NOT NULL,
  informado INTEGER NOT NULL DEFAULT 1 CHECK (informado IN (0, 1)),
  -- Importe de la OT (centavos) en el momento en que se informó: sirve para advertir si cambió después.
  importe_al_informar INTEGER NOT NULL CHECK (importe_al_informar > 0),
  informado_por TEXT,
  informado_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  retirado_at TEXT,
  PRIMARY KEY (taller_id, orden_id),
  FOREIGN KEY (taller_id, orden_id) REFERENCES ordenes(taller_id, id)
);

CREATE TABLE pago_elecciones (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  orden_id TEXT NOT NULL,
  medio TEXT NOT NULL CHECK (medio IN ('efectivo', 'transferencia')),
  -- seleccionado: eligió el medio. confirmado: (sólo efectivo) confirmó que va a pagar en efectivo. Ninguno de los dos mueve dinero.
  estado TEXT NOT NULL CHECK (estado IN ('seleccionado', 'confirmado')),
  importe_total INTEGER NOT NULL CHECK (importe_total > 0),
  importe_pendiente INTEGER NOT NULL CHECK (importe_pendiente >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (taller_id, orden_id) REFERENCES ordenes(taller_id, id)
);
CREATE INDEX idx_pago_elecciones ON pago_elecciones(taller_id, orden_id, created_at);

-- El historial de elecciones no se reescribe ni se borra: cambiar de idea agrega una fila nueva.
CREATE TRIGGER trg_pago_elecciones_inmutable BEFORE UPDATE ON pago_elecciones
BEGIN
  SELECT RAISE(ABORT, 'pago_eleccion_inmutable');
END;
CREATE TRIGGER trg_pago_elecciones_sin_borrado BEFORE DELETE ON pago_elecciones
BEGIN
  SELECT RAISE(ABORT, 'pago_eleccion_inmutable');
END;

CREATE TABLE pago_comprobantes (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  orden_id TEXT NOT NULL,
  -- subiendo: reservó el lugar y todavía se guarda el archivo en R2 (si se corta, el mantenimiento lo limpia). pendiente: recibido, a la espera del administrativo.
  estado TEXT NOT NULL DEFAULT 'subiendo' CHECK (estado IN ('subiendo', 'pendiente', 'confirmado', 'rechazado')),
  -- Reintento de la misma subida (lo genera la página al mostrarse): el mismo formulario enviado dos veces no duplica el comprobante.
  idem_key TEXT NOT NULL,
  -- Formato reconocido por el CONTENIDO del archivo (nunca por el nombre ni por el tipo que declare el navegador).
  mime TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  sha256 TEXT NOT NULL,
  -- Nombre que mostró el cliente, depurado: sólo se muestra (escapado); la clave del objeto en R2 se deriva de `id` y del taller.
  nombre TEXT,
  -- Lo que valía la OT y lo que faltaba cobrar cuando el cliente envió el comprobante (para advertir si el importe cambió después).
  importe_total INTEGER NOT NULL CHECK (importe_total > 0),
  importe_pendiente INTEGER NOT NULL CHECK (importe_pendiente >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Decisión del administrativo.
  revisado_por TEXT,
  revisado_at TEXT,
  motivo_rechazo TEXT,
  -- Confirmación: el cobro real que respalda este comprobante (nuevo o ya registrado en el módulo financiero) y cuánto se confirmó.
  cobro_id TEXT,
  importe_confirmado INTEGER CHECK (importe_confirmado IS NULL OR importe_confirmado > 0),
  vinculo TEXT CHECK (vinculo IN ('nuevo', 'existente')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, idem_key),
  FOREIGN KEY (taller_id, orden_id) REFERENCES ordenes(taller_id, id),
  FOREIGN KEY (taller_id, cobro_id) REFERENCES cobros(taller_id, id),
  CHECK (estado <> 'rechazado' OR (motivo_rechazo IS NOT NULL AND length(trim(motivo_rechazo)) >= 3)),
  CHECK (estado <> 'confirmado' OR (cobro_id IS NOT NULL AND importe_confirmado IS NOT NULL AND vinculo IS NOT NULL)),
  CHECK (estado IN ('confirmado', 'rechazado') = (revisado_at IS NOT NULL))
);
CREATE INDEX idx_pago_comprobantes_orden ON pago_comprobantes(taller_id, orden_id, created_at);
CREATE INDEX idx_pago_comprobantes_pendientes ON pago_comprobantes(taller_id, estado) WHERE estado = 'pendiente';
-- Un cobro respalda a lo sumo un comprobante: ni doble clic, ni reintentos, ni dos comprobantes de la misma transferencia pueden contabilizarla dos veces.
CREATE UNIQUE INDEX idx_pago_comprobantes_cobro ON pago_comprobantes(taller_id, cobro_id) WHERE cobro_id IS NOT NULL;

-- Lo que identifica al archivo no cambia nunca, y una decisión tomada (confirmado / rechazado) es definitiva: el cliente envía otro comprobante si hace falta.
CREATE TRIGGER trg_pago_comprobantes_inmutable BEFORE UPDATE OF id, taller_id, orden_id, idem_key, mime, bytes, sha256, nombre, importe_total, importe_pendiente, created_at ON pago_comprobantes
BEGIN
  SELECT RAISE(ABORT, 'pago_comprobante_inmutable');
END;
CREATE TRIGGER trg_pago_comprobantes_resuelto BEFORE UPDATE ON pago_comprobantes
WHEN OLD.estado IN ('confirmado', 'rechazado')
BEGIN
  SELECT RAISE(ABORT, 'pago_comprobante_resuelto');
END;
-- Sólo se borra un comprobante que nunca llegó a recibirse (la subida que se cortó); los recibidos y resueltos son parte del historial.
CREATE TRIGGER trg_pago_comprobantes_sin_borrado BEFORE DELETE ON pago_comprobantes
WHEN OLD.estado <> 'subiendo'
BEGIN
  SELECT RAISE(ABORT, 'pago_comprobante_inmutable');
END;
