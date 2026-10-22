-- Fierro · Sprint 13 · Estabilidad, escalabilidad y observabilidad.
--
-- Migración ADITIVA: sólo crea tablas, índices y triggers nuevos y agrega columnas opcionales a contab_config. No modifica ni elimina
-- comprobantes, cobros, pagos, movimientos, saldos ni asientos.
--
-- 1) COLA CONTABLE PERSISTENTE (`contab_cola`). Hasta el Sprint 12 cada pasada contable releía todos los documentos de cada fuente (costo O(n) por
--    operación) y dependía de una tarea en segundo plano que podía perderse al terminar el Worker. Ahora cada operación comercial deja su pedido
--    de contabilización DENTRO de su propia transacción (triggers AFTER INSERT / AFTER UPDATE de estado sobre las tablas de origen): si la operación
--    se confirma, el pedido existe; si se revierte, no. El proceso contable sólo lee la cola (costo proporcional a lo nuevo), reintenta con espera
--    creciente los pedidos que fallan y NUNCA saca un pedido de la cola antes de que su asiento esté registrado (el borrado va en el mismo batch
--    atómico que el asiento). Un Cron Trigger drena las colas que hayan quedado pendientes aunque nadie vuelva a operar.
--    Los pedidos sólo se generan en talleres con la contabilidad ACTIVADA (la activación sigue siendo explícita; lo histórico se genera por lotes
--    con la reconciliación, no con la cola).
-- 2) RECONCILIACIÓN (`contab_config.reconciliar_pendiente`): recorrido completo, por lotes y reanudable, que detecta cualquier documento que no
--    tenga su asiento (histórico al activar, o una verificación periódica de seguridad). Es el único camino que todavía recorre el historial.
-- 2b) ÍNDICES FALTANTES detectados al medir (cobros, compras, recepciones y tablero).
-- 3) EVENTOS DE SEGURIDAD (`eventos_seguridad`), ERRORES DEL WORKER (`errores_worker`) y LATIDOS (`plataforma_latidos`): observabilidad mínima sin
--    plataformas externas. Sin contraseñas, tokens ni datos personales (el origen y la cuenta se guardan como huellas cortas, no en claro).

-- ───────────── 1) Cola contable ─────────────
CREATE TABLE contab_cola (
  taller_id TEXT NOT NULL,
  origen_tipo TEXT NOT NULL,
  origen_id TEXT NOT NULL,
  evento TEXT NOT NULL CHECK (evento IN ('alta', 'anulacion')),
  -- pendiente: se procesa (a su hora). fallida: agotó los reintentos automáticos; queda visible hasta que alguien pida reintentar.
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'fallida')),
  intentos INTEGER NOT NULL DEFAULT 0,
  ultimo_error TEXT,
  proximo_intento_at TEXT,
  creada_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actualizada_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (taller_id, origen_tipo, origen_id, evento)
);
CREATE INDEX idx_contab_cola_taller ON contab_cola(taller_id, estado, creada_at);
CREATE INDEX idx_contab_cola_estado ON contab_cola(estado, proximo_intento_at);

ALTER TABLE contab_config ADD COLUMN reconciliar_pendiente INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contab_config ADD COLUMN reconciliada_at TEXT;
-- Los talleres que ya habían activado la contabilidad antes de esta migración pasan una vez por la reconciliación (no tenían cola).
UPDATE contab_config SET reconciliar_pendiente = 1;

-- Triggers de encolado. Cada uno corre en la transacción de la operación que lo dispara.
-- Altas ------------------------------------------------------------------------------------------------------------------------------------
CREATE TRIGGER trg_cola_venta AFTER INSERT ON ventas
WHEN EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'venta', NEW.id, 'alta'); END;

CREATE TRIGGER trg_cola_cobro AFTER INSERT ON cobros
WHEN EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'cobro', NEW.id, 'alta'); END;

CREATE TRIGGER trg_cola_credito_aplicacion AFTER INSERT ON credito_aplicaciones
WHEN EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'credito_aplicacion', NEW.id, 'alta'); END;

CREATE TRIGGER trg_cola_devolucion AFTER INSERT ON devoluciones
WHEN EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'devolucion', NEW.id, 'alta'); END;

CREATE TRIGGER trg_cola_reintegro AFTER INSERT ON reintegros
WHEN EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'reintegro', NEW.id, 'alta'); END;

CREATE TRIGGER trg_cola_compra AFTER INSERT ON compras
WHEN EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'compra', NEW.id, 'alta'); END;

CREATE TRIGGER trg_cola_recepcion AFTER INSERT ON recepciones
WHEN EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'recepcion', NEW.id, 'alta'); END;

CREATE TRIGGER trg_cola_factura_proveedor AFTER INSERT ON facturas_proveedor
WHEN (NEW.compra_id IS NULL OR NEW.tipo LIKE 'nota_credito%') AND EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'factura_proveedor', NEW.id, 'alta'); END;

CREATE TRIGGER trg_cola_pago_proveedor AFTER INSERT ON pagos_proveedor
WHEN EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'pago_proveedor', NEW.id, 'alta'); END;

CREATE TRIGGER trg_cola_gasto AFTER INSERT ON gastos
WHEN EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'gasto', NEW.id, 'alta'); END;

-- Sólo los ingresos/egresos manuales de caja (los demás movimientos son espejo de un documento que ya tiene su asiento).
CREATE TRIGGER trg_cola_caja_manual AFTER INSERT ON caja_movimientos
WHEN NEW.origen_tipo = 'manual' AND EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'caja_manual', NEW.id, 'alta'); END;

-- Sólo los movimientos bancarios propios (depósitos, extracciones, transferencias, comisiones, cheques, ajustes y manuales).
CREATE TRIGGER trg_cola_banco_mov AFTER INSERT ON banco_movimientos
WHEN NEW.origen_tipo IN ('manual','deposito','extraccion','ajuste','cheque','cheque_comision','transferencia_sal','transferencia_ent')
 AND EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'banco_mov', NEW.id, 'alta'); END;

-- Sólo ajustes manuales, conteos físicos y el stock inicial del artículo (compras, ventas, consumos y devoluciones ya están en su documento).
CREATE TRIGGER trg_cola_stock_ajuste AFTER INSERT ON stock_movimientos
WHEN (NEW.origen_tipo IN ('manual','conteo') OR (NEW.origen_tipo IS NULL AND NEW.tipo = 'entrada' AND NEW.notas = 'Stock inicial'))
 AND COALESCE(NEW.motivo, '') <> 'transferencia'
 AND EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'stock_ajuste', NEW.id, 'alta'); END;

CREATE TRIGGER trg_cola_apertura_banco AFTER INSERT ON cuentas_bancarias
WHEN NEW.moneda = 'ARS' AND NEW.saldo_inicial <> 0 AND EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'apertura_banco', NEW.id, 'alta'); END;

CREATE TRIGGER trg_cola_apertura_banco_upd AFTER UPDATE OF saldo_inicial ON cuentas_bancarias
WHEN NEW.moneda = 'ARS' AND NEW.saldo_inicial <> 0 AND NEW.saldo_inicial <> OLD.saldo_inicial AND EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'apertura_banco', NEW.id, 'alta'); END;

CREATE TRIGGER trg_cola_apertura_caja AFTER INSERT ON caja_sesiones
WHEN NEW.saldo_inicial > 0 AND EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'apertura_caja', NEW.id, 'alta'); END;

CREATE TRIGGER trg_cola_apertura_proveedores AFTER INSERT ON aperturas_saldos
WHEN NEW.tipo = 'proveedores' AND EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'apertura_proveedores', NEW.id, 'alta'); END;

-- Anulaciones (cambio de estado a anulado) ---------------------------------------------------------------------------------------------------
CREATE TRIGGER trg_cola_venta_anul AFTER UPDATE OF estado ON ventas
WHEN NEW.estado = 'anulada' AND OLD.estado <> 'anulada' AND EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'venta', NEW.id, 'anulacion'); END;

CREATE TRIGGER trg_cola_cobro_anul AFTER UPDATE OF estado ON cobros
WHEN NEW.estado = 'anulado' AND OLD.estado <> 'anulado' AND EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'cobro', NEW.id, 'anulacion'); END;

CREATE TRIGGER trg_cola_credito_aplicacion_anul AFTER UPDATE OF estado ON credito_aplicaciones
WHEN NEW.estado = 'anulada' AND OLD.estado <> 'anulada' AND EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'credito_aplicacion', NEW.id, 'anulacion'); END;

CREATE TRIGGER trg_cola_devolucion_anul AFTER UPDATE OF estado ON devoluciones
WHEN NEW.estado = 'anulada' AND OLD.estado <> 'anulada' AND EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'devolucion', NEW.id, 'anulacion'); END;

CREATE TRIGGER trg_cola_reintegro_anul AFTER UPDATE OF estado ON reintegros
WHEN NEW.estado = 'anulado' AND OLD.estado <> 'anulado' AND EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'reintegro', NEW.id, 'anulacion'); END;

CREATE TRIGGER trg_cola_compra_anul AFTER UPDATE OF estado ON compras
WHEN NEW.estado = 'anulada' AND OLD.estado <> 'anulada' AND EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'compra', NEW.id, 'anulacion'); END;

CREATE TRIGGER trg_cola_recepcion_anul AFTER UPDATE OF estado ON recepciones
WHEN NEW.estado = 'anulada' AND OLD.estado <> 'anulada' AND EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'recepcion', NEW.id, 'anulacion'); END;

CREATE TRIGGER trg_cola_factura_proveedor_anul AFTER UPDATE OF estado ON facturas_proveedor
WHEN NEW.estado = 'anulada' AND OLD.estado <> 'anulada' AND (NEW.compra_id IS NULL OR NEW.tipo LIKE 'nota_credito%') AND EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'factura_proveedor', NEW.id, 'anulacion'); END;

CREATE TRIGGER trg_cola_pago_proveedor_anul AFTER UPDATE OF estado ON pagos_proveedor
WHEN NEW.estado = 'anulado' AND OLD.estado <> 'anulado' AND EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'pago_proveedor', NEW.id, 'anulacion'); END;

CREATE TRIGGER trg_cola_gasto_anul AFTER UPDATE OF estado ON gastos
WHEN NEW.estado = 'anulado' AND OLD.estado <> 'anulado' AND EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'gasto', NEW.id, 'anulacion'); END;

CREATE TRIGGER trg_cola_apertura_proveedores_anul AFTER UPDATE OF estado ON aperturas_saldos
WHEN NEW.tipo = 'proveedores' AND NEW.estado = 'anulada' AND OLD.estado <> 'anulada' AND EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'apertura_proveedores', NEW.id, 'anulacion'); END;

-- Los movimientos de caja y de banco se anulan con una fila "reverso" que apunta al original: el pedido es para el original (si era manual / propio).
CREATE TRIGGER trg_cola_caja_manual_anul AFTER INSERT ON caja_movimientos
WHEN NEW.origen_tipo = 'reverso' AND EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
 AND EXISTS (SELECT 1 FROM caja_movimientos t WHERE t.taller_id = NEW.taller_id AND t.id = NEW.origen_id AND t.origen_tipo = 'manual')
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'caja_manual', NEW.origen_id, 'anulacion'); END;

CREATE TRIGGER trg_cola_banco_mov_anul AFTER INSERT ON banco_movimientos
WHEN NEW.origen_tipo = 'reverso' AND EXISTS (SELECT 1 FROM contab_config WHERE taller_id = NEW.taller_id)
 AND EXISTS (SELECT 1 FROM banco_movimientos t WHERE t.taller_id = NEW.taller_id AND t.id = NEW.origen_id
             AND t.origen_tipo IN ('manual','deposito','extraccion','ajuste','cheque','cheque_comision','transferencia_sal','transferencia_ent'))
BEGIN INSERT OR IGNORE INTO contab_cola (taller_id, origen_tipo, origen_id, evento) VALUES (NEW.taller_id, 'banco_mov', NEW.origen_id, 'anulacion'); END;

-- ───────────── 2b) Índices que faltaban (hallazgos de la medición de capacidad, docs/CAPACIDAD.md) ─────────────
-- Buscar los medios y aplicaciones de un cobro recorría TODOS los cobros del taller (no había índice por cobro_id): costo proporcional al historial en
-- cada cobro y en cada contabilización de un cobro. Lo mismo para los renglones de compras y recepciones.
CREATE INDEX idx_cobro_medios_cobro ON cobro_medios(taller_id, cobro_id);
CREATE INDEX idx_cobro_aplicaciones_cobro ON cobro_aplicaciones(taller_id, cobro_id);
CREATE INDEX idx_compra_items_compra ON compra_items(taller_id, compra_id);
CREATE INDEX idx_recepcion_items_recepcion ON recepcion_items(taller_id, recepcion_id);
-- Tablero inicial (se consulta al abrir y cada 60 s): las ventas del mes ya usan idx_ventas_fecha (0002) ahora que la consulta es por rango de fechas; lo pendiente de cobro
-- se suma sólo sobre lo pendiente (índice parcial) en vez de sobre todo el historial.
CREATE INDEX idx_ventas_por_cobrar ON ventas(taller_id) WHERE estado = 'emitida' AND total <> devuelto + cobrado;

-- ───────────── 3) Observabilidad y seguridad ─────────────
-- Eventos de seguridad (inicios de sesión fallidos o bloqueados, token de plataforma inválido…). `origen` y `cuenta` son huellas cortas (SHA-256 truncado):
-- permiten ver "muchos intentos del mismo origen" sin guardar IP ni correos. `detalle` es JSON sin datos sensibles.
CREATE TABLE eventos_seguridad (
  id TEXT PRIMARY KEY,
  creado_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  tipo TEXT NOT NULL,
  taller_id TEXT,
  usuario_id TEXT,
  origen TEXT,
  cuenta TEXT,
  detalle TEXT
);
CREATE INDEX idx_eventos_seguridad_fecha ON eventos_seguridad(creado_at);
CREATE INDEX idx_eventos_seguridad_tipo ON eventos_seguridad(tipo, creado_at);

-- Errores no controlados del Worker (HTTP 500), agrupados por huella (método + ruta normalizada + mensaje): una fila por problema, con contador.
CREATE TABLE errores_worker (
  huella TEXT PRIMARY KEY,
  primera_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ultima_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  veces INTEGER NOT NULL DEFAULT 1,
  metodo TEXT NOT NULL,
  ruta TEXT NOT NULL,
  mensaje TEXT NOT NULL,
  taller_id TEXT
);
CREATE INDEX idx_errores_worker_ultima ON errores_worker(ultima_at);

-- Latidos de procesos periódicos (mantenimiento del Cron, aviso de respaldo externo): permiten detectar "dejó de correr".
CREATE TABLE plataforma_latidos (
  clave TEXT PRIMARY KEY,
  ultimo_at TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1 CHECK (ok IN (0, 1)),
  detalle TEXT
);
