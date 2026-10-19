-- Fierro · esquema inicial
-- Convenciones:
--  * Toda entidad de negocio lleva taller_id. Las relaciones usan FK compuestas (taller_id, x_id)
--    contra UNIQUE(taller_id, id) del padre: la base impide vincular registros de talleres distintos.
--  * Importes en centavos (INTEGER). Cantidades en REAL.
--  * Fechas en TEXT ISO-8601 (UTC).
--  * IDs TEXT (UUID) generados por la API: permiten insertar padre e hijos en un mismo batch atómico.


-- Tabla auxiliar para abortar batches: INSERT ... SELECT 0 WHERE <condición inválida> viola el CHECK
-- y D1 revierte todo el batch. Nunca contiene filas.
CREATE TABLE tx_guard (
  ok INTEGER NOT NULL CHECK (ok = 1),
  motivo TEXT
);

-- ───────────────────────── Plataforma ─────────────────────────
CREATE TABLE talleres (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  razon_social TEXT,
  cuit TEXT,
  condicion_iva TEXT NOT NULL DEFAULT 'monotributo',
  direccion TEXT,
  localidad TEXT,
  telefono TEXT,
  email TEXT,
  activo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE licencias (
  taller_id TEXT PRIMARY KEY REFERENCES talleres(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'base',
  usuarios_incluidos INTEGER NOT NULL DEFAULT 1 CHECK (usuarios_incluidos >= 1),
  usuarios_adicionales INTEGER NOT NULL DEFAULT 0 CHECK (usuarios_adicionales >= 0),
  estado TEXT NOT NULL DEFAULT 'activa' CHECK (estado IN ('activa','suspendida')),
  notas TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE licencia_eventos (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  detalle TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE usuarios (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  nombre TEXT NOT NULL,
  rol TEXT NOT NULL CHECK (rol IN ('propietario','administrador','empleado')),
  password_hash TEXT NOT NULL,
  activo INTEGER NOT NULL DEFAULT 1,
  intentos_fallidos INTEGER NOT NULL DEFAULT 0,
  bloqueado_hasta TEXT,
  ultimo_login TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id)
);
CREATE INDEX idx_usuarios_taller ON usuarios(taller_id);

CREATE TABLE sesiones (
  token_hash TEXT PRIMARY KEY,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  taller_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX idx_sesiones_usuario ON sesiones(usuario_id);

-- Configuración y numeración por taller
CREATE TABLE taller_config (
  taller_id TEXT PRIMARY KEY REFERENCES talleres(id) ON DELETE CASCADE,
  iva_default REAL NOT NULL DEFAULT 21,
  recargo_default REAL NOT NULL DEFAULT 0,
  validez_presupuesto_dias INTEGER NOT NULL DEFAULT 15,
  margen_default REAL NOT NULL DEFAULT 40,
  pie_documentos TEXT,
  permitir_stock_negativo INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE secuencias (
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  clave TEXT NOT NULL,
  valor INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (taller_id, clave)
);

CREATE TABLE auditoria (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  usuario_id TEXT,
  entidad TEXT NOT NULL,
  entidad_id TEXT,
  accion TEXT NOT NULL,
  detalle TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_auditoria_taller ON auditoria(taller_id, created_at);

-- ───────────────────────── Maestros ─────────────────────────
CREATE TABLE mecanicos (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  telefono TEXT,
  especialidad TEXT,
  usuario_id TEXT,
  activo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  FOREIGN KEY (taller_id, usuario_id) REFERENCES usuarios(taller_id, id)
);

CREATE TABLE clientes (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  codigo INTEGER NOT NULL,
  nombre TEXT NOT NULL,
  documento_tipo TEXT NOT NULL DEFAULT 'DNI' CHECK (documento_tipo IN ('DNI','CUIT','CUIL','OTRO')),
  documento TEXT,
  condicion_iva TEXT NOT NULL DEFAULT 'consumidor_final',
  telefono TEXT,
  email TEXT,
  direccion TEXT,
  localidad TEXT,
  notas TEXT,
  activo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, codigo)
);
CREATE INDEX idx_clientes_nombre ON clientes(taller_id, nombre);

CREATE TABLE marcas (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL COLLATE NOCASE,
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, nombre)
);

CREATE TABLE modelos (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  marca_id TEXT NOT NULL,
  nombre TEXT NOT NULL COLLATE NOCASE,
  motor TEXT,
  notas TEXT,
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, marca_id, nombre),
  FOREIGN KEY (taller_id, marca_id) REFERENCES marcas(taller_id, id) ON DELETE CASCADE
);

CREATE TABLE vehiculos (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  cliente_id TEXT NOT NULL,
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
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, patente),
  FOREIGN KEY (taller_id, cliente_id) REFERENCES clientes(taller_id, id),
  FOREIGN KEY (taller_id, marca_id) REFERENCES marcas(taller_id, id),
  FOREIGN KEY (taller_id, modelo_id) REFERENCES modelos(taller_id, id)
);
CREATE INDEX idx_vehiculos_cliente ON vehiculos(taller_id, cliente_id);

-- ───────────────────────── Catálogo ─────────────────────────
CREATE TABLE categorias_servicio (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL COLLATE NOCASE,
  orden INTEGER NOT NULL DEFAULT 0,
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, nombre)
);

CREATE TABLE servicios (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  categoria_id TEXT,
  nombre TEXT NOT NULL,
  descripcion TEXT,
  precio INTEGER NOT NULL DEFAULT 0 CHECK (precio >= 0),
  tipo_vehiculo TEXT NOT NULL DEFAULT 'todos',
  intervalo_km INTEGER,
  intervalo_meses INTEGER,
  checks TEXT NOT NULL DEFAULT '[]',
  activo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  FOREIGN KEY (taller_id, categoria_id) REFERENCES categorias_servicio(taller_id, id)
);

CREATE TABLE categorias_articulo (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL COLLATE NOCASE,
  descripcion TEXT,
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, nombre)
);

CREATE TABLE proveedores (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  cuit TEXT,
  condicion_iva TEXT NOT NULL DEFAULT 'responsable_inscripto',
  telefono TEXT,
  email TEXT,
  direccion TEXT,
  notas TEXT,
  activo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id)
);

CREATE TABLE articulos (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  codigo TEXT,
  nombre TEXT NOT NULL,
  marca TEXT,
  categoria_id TEXT,
  proveedor_id TEXT,
  costo INTEGER NOT NULL DEFAULT 0 CHECK (costo >= 0),
  precio INTEGER NOT NULL DEFAULT 0 CHECK (precio >= 0),
  alicuota_iva REAL NOT NULL DEFAULT 21,
  stock REAL NOT NULL DEFAULT 0,
  stock_minimo REAL NOT NULL DEFAULT 0,
  unidad TEXT NOT NULL DEFAULT 'un',
  ubicacion TEXT,
  activo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  FOREIGN KEY (taller_id, categoria_id) REFERENCES categorias_articulo(taller_id, id),
  FOREIGN KEY (taller_id, proveedor_id) REFERENCES proveedores(taller_id, id)
);
CREATE UNIQUE INDEX idx_articulos_codigo ON articulos(taller_id, codigo) WHERE codigo IS NOT NULL AND codigo <> '';
CREATE INDEX idx_articulos_nombre ON articulos(taller_id, nombre);

-- Libro de stock. idem_key evita movimientos duplicados (p. ej. doble consumo de una OT).
CREATE TABLE stock_movimientos (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  articulo_id TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('entrada','salida','ajuste','consumo_ot','reverso_ot','venta','anulacion_venta','compra','anulacion_compra')),
  cantidad REAL NOT NULL,
  stock_resultante REAL NOT NULL,
  costo_unitario INTEGER,
  origen_tipo TEXT,
  origen_id TEXT,
  idem_key TEXT,
  notas TEXT,
  usuario_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (taller_id, articulo_id) REFERENCES articulos(taller_id, id)
);
CREATE UNIQUE INDEX idx_stock_idem ON stock_movimientos(taller_id, idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX idx_stock_articulo ON stock_movimientos(taller_id, articulo_id, created_at);

-- ───────────────────────── Presupuestos ─────────────────────────
CREATE TABLE presupuestos (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  numero INTEGER NOT NULL,
  cliente_id TEXT NOT NULL,
  vehiculo_id TEXT NOT NULL,
  fecha TEXT NOT NULL,
  valido_hasta TEXT,
  km INTEGER,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','aprobado','rechazado','convertido','anulado')),
  observaciones TEXT,
  desc_global_pct REAL NOT NULL DEFAULT 0,
  desc_global_monto INTEGER NOT NULL DEFAULT 0,
  iva_pct REAL NOT NULL DEFAULT 0,
  recargo_pct REAL NOT NULL DEFAULT 0,
  subtotal_articulos INTEGER NOT NULL DEFAULT 0,
  subtotal_servicios INTEGER NOT NULL DEFAULT 0,
  descuento INTEGER NOT NULL DEFAULT 0,
  neto INTEGER NOT NULL DEFAULT 0,
  iva INTEGER NOT NULL DEFAULT 0,
  recargo INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  orden_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, numero),
  FOREIGN KEY (taller_id, cliente_id) REFERENCES clientes(taller_id, id),
  FOREIGN KEY (taller_id, vehiculo_id) REFERENCES vehiculos(taller_id, id)
);

CREATE TABLE presupuesto_items (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  presupuesto_id TEXT NOT NULL,
  orden INTEGER NOT NULL DEFAULT 0,
  tipo TEXT NOT NULL CHECK (tipo IN ('articulo','servicio','libre')),
  articulo_id TEXT,
  servicio_id TEXT,
  descripcion TEXT NOT NULL,
  cantidad REAL NOT NULL CHECK (cantidad > 0),
  precio_unitario INTEGER NOT NULL CHECK (precio_unitario >= 0),
  desc_pct REAL NOT NULL DEFAULT 0 CHECK (desc_pct >= 0 AND desc_pct <= 100),
  subtotal INTEGER NOT NULL,
  FOREIGN KEY (taller_id, presupuesto_id) REFERENCES presupuestos(taller_id, id) ON DELETE CASCADE,
  FOREIGN KEY (taller_id, articulo_id) REFERENCES articulos(taller_id, id),
  FOREIGN KEY (taller_id, servicio_id) REFERENCES servicios(taller_id, id)
);
CREATE INDEX idx_pitems ON presupuesto_items(presupuesto_id);

-- ───────────────────────── Órdenes de trabajo ─────────────────────────
CREATE TABLE ordenes (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  numero INTEGER NOT NULL,
  cliente_id TEXT NOT NULL,
  vehiculo_id TEXT NOT NULL,
  presupuesto_id TEXT,
  mecanico_id TEXT,
  estado TEXT NOT NULL DEFAULT 'recibida' CHECK (estado IN ('recibida','diagnostico','en_reparacion','esperando_repuestos','lista','entregada','cancelada')),
  km_ingreso INTEGER,
  falla_reportada TEXT,
  diagnostico TEXT,
  observaciones TEXT,
  fecha_ingreso TEXT NOT NULL,
  fecha_prometida TEXT,
  fecha_lista TEXT,
  fecha_entregada TEXT,
  desc_global_pct REAL NOT NULL DEFAULT 0,
  desc_global_monto INTEGER NOT NULL DEFAULT 0,
  iva_pct REAL NOT NULL DEFAULT 0,
  recargo_pct REAL NOT NULL DEFAULT 0,
  subtotal_articulos INTEGER NOT NULL DEFAULT 0,
  subtotal_servicios INTEGER NOT NULL DEFAULT 0,
  descuento INTEGER NOT NULL DEFAULT 0,
  neto INTEGER NOT NULL DEFAULT 0,
  iva INTEGER NOT NULL DEFAULT 0,
  recargo INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  stock_aplicado INTEGER NOT NULL DEFAULT 0 CHECK (stock_aplicado IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, numero),
  FOREIGN KEY (taller_id, cliente_id) REFERENCES clientes(taller_id, id),
  FOREIGN KEY (taller_id, vehiculo_id) REFERENCES vehiculos(taller_id, id),
  FOREIGN KEY (taller_id, presupuesto_id) REFERENCES presupuestos(taller_id, id),
  FOREIGN KEY (taller_id, mecanico_id) REFERENCES mecanicos(taller_id, id)
);
-- Un presupuesto genera como máximo una OT (trazabilidad + evita conversiones dobles).
CREATE UNIQUE INDEX idx_ordenes_presupuesto ON ordenes(taller_id, presupuesto_id) WHERE presupuesto_id IS NOT NULL;
CREATE INDEX idx_ordenes_estado ON ordenes(taller_id, estado);
CREATE INDEX idx_ordenes_vehiculo ON ordenes(taller_id, vehiculo_id);

CREATE TABLE orden_items (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  orden_id TEXT NOT NULL,
  orden INTEGER NOT NULL DEFAULT 0,
  tipo TEXT NOT NULL CHECK (tipo IN ('articulo','servicio','libre')),
  articulo_id TEXT,
  servicio_id TEXT,
  descripcion TEXT NOT NULL,
  cantidad REAL NOT NULL CHECK (cantidad > 0),
  precio_unitario INTEGER NOT NULL CHECK (precio_unitario >= 0),
  desc_pct REAL NOT NULL DEFAULT 0 CHECK (desc_pct >= 0 AND desc_pct <= 100),
  subtotal INTEGER NOT NULL,
  FOREIGN KEY (taller_id, orden_id) REFERENCES ordenes(taller_id, id) ON DELETE CASCADE,
  FOREIGN KEY (taller_id, articulo_id) REFERENCES articulos(taller_id, id),
  FOREIGN KEY (taller_id, servicio_id) REFERENCES servicios(taller_id, id)
);
CREATE INDEX idx_oitems ON orden_items(orden_id);

CREATE TABLE orden_eventos (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  orden_id TEXT NOT NULL,
  estado_anterior TEXT,
  estado_nuevo TEXT NOT NULL,
  nota TEXT,
  usuario_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (taller_id, orden_id) REFERENCES ordenes(taller_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_oeventos ON orden_eventos(orden_id, created_at);

CREATE TABLE checklists (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  orden_id TEXT NOT NULL,
  combustible TEXT,
  km INTEGER,
  datos TEXT NOT NULL DEFAULT '{}',
  observaciones TEXT,
  recibido_por TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, orden_id),
  FOREIGN KEY (taller_id, orden_id) REFERENCES ordenes(taller_id, id) ON DELETE CASCADE
);

-- ───────────────────────── Agenda ─────────────────────────
CREATE TABLE turnos (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  fecha TEXT NOT NULL,          -- YYYY-MM-DD
  hora TEXT NOT NULL,           -- HH:MM
  duracion_min INTEGER NOT NULL DEFAULT 60,
  cliente_id TEXT NOT NULL,
  vehiculo_id TEXT,
  presupuesto_id TEXT,
  orden_id TEXT,
  mecanico_id TEXT,
  estado TEXT NOT NULL DEFAULT 'agendado' CHECK (estado IN ('agendado','confirmado','en_taller','completado','cancelado','ausente')),
  motivo TEXT,
  notas TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  FOREIGN KEY (taller_id, cliente_id) REFERENCES clientes(taller_id, id),
  FOREIGN KEY (taller_id, vehiculo_id) REFERENCES vehiculos(taller_id, id),
  FOREIGN KEY (taller_id, presupuesto_id) REFERENCES presupuestos(taller_id, id),
  FOREIGN KEY (taller_id, orden_id) REFERENCES ordenes(taller_id, id),
  FOREIGN KEY (taller_id, mecanico_id) REFERENCES mecanicos(taller_id, id)
);
CREATE INDEX idx_turnos_fecha ON turnos(taller_id, fecha);

-- ───────────────────────── Ventas (comprobantes internos) ─────────────────────────
-- Un comprobante interno ("venta") es el documento comercial que genera deuda del cliente.
-- Puede originarse en una OT (orden_id) o ser una venta de mostrador.
-- NO es un comprobante fiscal. La futura factura electrónica se registra en comprobantes_fiscales
-- referenciando a la venta, sin modificar ventas ni cobros.
CREATE TABLE ventas (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  numero INTEGER NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'interno' CHECK (tipo IN ('interno')),
  cliente_id TEXT NOT NULL,
  orden_id TEXT,
  fecha TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'emitida' CHECK (estado IN ('emitida','anulada')),
  condicion TEXT NOT NULL DEFAULT 'contado' CHECK (condicion IN ('contado','cuenta_corriente')),
  desc_global_pct REAL NOT NULL DEFAULT 0,
  desc_global_monto INTEGER NOT NULL DEFAULT 0,
  iva_pct REAL NOT NULL DEFAULT 0,
  recargo_pct REAL NOT NULL DEFAULT 0,
  subtotal_articulos INTEGER NOT NULL DEFAULT 0,
  subtotal_servicios INTEGER NOT NULL DEFAULT 0,
  descuento INTEGER NOT NULL DEFAULT 0,
  neto INTEGER NOT NULL DEFAULT 0,
  iva INTEGER NOT NULL DEFAULT 0,
  recargo INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  cobrado INTEGER NOT NULL DEFAULT 0 CHECK (cobrado >= 0),
  observaciones TEXT,
  anulada_motivo TEXT,
  idem_key TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, numero),
  CHECK (cobrado <= total),
  FOREIGN KEY (taller_id, cliente_id) REFERENCES clientes(taller_id, id),
  FOREIGN KEY (taller_id, orden_id) REFERENCES ordenes(taller_id, id)
);
-- Una OT genera como máximo un comprobante vigente.
CREATE UNIQUE INDEX idx_ventas_orden ON ventas(taller_id, orden_id) WHERE orden_id IS NOT NULL AND estado = 'emitida';
CREATE INDEX idx_ventas_cliente ON ventas(taller_id, cliente_id);
CREATE UNIQUE INDEX idx_ventas_idem ON ventas(taller_id, idem_key) WHERE idem_key IS NOT NULL;

CREATE TABLE venta_items (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  venta_id TEXT NOT NULL,
  orden INTEGER NOT NULL DEFAULT 0,
  tipo TEXT NOT NULL CHECK (tipo IN ('articulo','servicio','libre')),
  articulo_id TEXT,
  servicio_id TEXT,
  descripcion TEXT NOT NULL,
  cantidad REAL NOT NULL CHECK (cantidad > 0),
  precio_unitario INTEGER NOT NULL CHECK (precio_unitario >= 0),
  desc_pct REAL NOT NULL DEFAULT 0,
  alicuota_iva REAL NOT NULL DEFAULT 21,
  subtotal INTEGER NOT NULL,
  FOREIGN KEY (taller_id, venta_id) REFERENCES ventas(taller_id, id) ON DELETE CASCADE,
  FOREIGN KEY (taller_id, articulo_id) REFERENCES articulos(taller_id, id),
  FOREIGN KEY (taller_id, servicio_id) REFERENCES servicios(taller_id, id)
);
CREATE INDEX idx_vitems ON venta_items(venta_id);

-- Reservado para la integración ARCA (no implementada). Ningún endpoint crea filas aquí todavía.
CREATE TABLE comprobantes_fiscales (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  venta_id TEXT NOT NULL,
  tipo_cbte INTEGER NOT NULL,          -- código ARCA (1=Fact A, 6=Fact B, 11=Fact C, NC/ND...)
  punto_venta INTEGER NOT NULL,
  numero INTEGER,
  cae TEXT,
  cae_vencimiento TEXT,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','autorizado','rechazado')),
  respuesta TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, tipo_cbte, punto_venta, numero),
  FOREIGN KEY (taller_id, venta_id) REFERENCES ventas(taller_id, id)
);

-- ───────────────────────── Cobros ─────────────────────────
CREATE TABLE cobros (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  numero INTEGER NOT NULL,
  cliente_id TEXT NOT NULL,
  fecha TEXT NOT NULL,
  total INTEGER NOT NULL CHECK (total > 0),
  estado TEXT NOT NULL DEFAULT 'registrado' CHECK (estado IN ('registrado','anulado')),
  idem_key TEXT NOT NULL,
  notas TEXT,
  anulado_motivo TEXT,
  usuario_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, numero),
  UNIQUE (taller_id, idem_key),
  FOREIGN KEY (taller_id, cliente_id) REFERENCES clientes(taller_id, id)
);
CREATE INDEX idx_cobros_cliente ON cobros(taller_id, cliente_id);

CREATE TABLE cobro_medios (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  cobro_id TEXT NOT NULL,
  medio TEXT NOT NULL CHECK (medio IN ('efectivo','transferencia','debito','credito','cheque','otro')),
  importe INTEGER NOT NULL CHECK (importe > 0),
  referencia TEXT,
  FOREIGN KEY (taller_id, cobro_id) REFERENCES cobros(taller_id, id) ON DELETE CASCADE
);

CREATE TABLE cobro_aplicaciones (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  cobro_id TEXT NOT NULL,
  venta_id TEXT NOT NULL,
  importe INTEGER NOT NULL CHECK (importe > 0),
  FOREIGN KEY (taller_id, cobro_id) REFERENCES cobros(taller_id, id) ON DELETE CASCADE,
  FOREIGN KEY (taller_id, venta_id) REFERENCES ventas(taller_id, id)
);
CREATE INDEX idx_aplic_venta ON cobro_aplicaciones(venta_id);

-- ───────────────────────── Compras ─────────────────────────
CREATE TABLE compras (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  numero INTEGER NOT NULL,
  proveedor_id TEXT NOT NULL,
  fecha TEXT NOT NULL,
  tipo_doc TEXT NOT NULL DEFAULT 'factura' CHECK (tipo_doc IN ('factura','remito','ticket','otro')),
  numero_doc TEXT,
  estado TEXT NOT NULL DEFAULT 'registrada' CHECK (estado IN ('registrada','anulada')),
  neto INTEGER NOT NULL DEFAULT 0,
  iva INTEGER NOT NULL DEFAULT 0,
  otros INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  actualizar_costos INTEGER NOT NULL DEFAULT 1,
  notas TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, numero),
  FOREIGN KEY (taller_id, proveedor_id) REFERENCES proveedores(taller_id, id)
);

CREATE TABLE compra_items (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  compra_id TEXT NOT NULL,
  articulo_id TEXT NOT NULL,
  cantidad REAL NOT NULL CHECK (cantidad > 0),
  costo_unitario INTEGER NOT NULL CHECK (costo_unitario >= 0),
  subtotal INTEGER NOT NULL,
  FOREIGN KEY (taller_id, compra_id) REFERENCES compras(taller_id, id) ON DELETE CASCADE,
  FOREIGN KEY (taller_id, articulo_id) REFERENCES articulos(taller_id, id)
);

CREATE TABLE pagos_proveedor (
  id TEXT PRIMARY KEY,
  taller_id TEXT NOT NULL,
  numero INTEGER NOT NULL,
  proveedor_id TEXT NOT NULL,
  fecha TEXT NOT NULL,
  importe INTEGER NOT NULL CHECK (importe > 0),
  medio TEXT NOT NULL CHECK (medio IN ('efectivo','transferencia','debito','credito','cheque','otro')),
  referencia TEXT,
  estado TEXT NOT NULL DEFAULT 'registrado' CHECK (estado IN ('registrado','anulado')),
  idem_key TEXT NOT NULL,
  notas TEXT,
  usuario_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (taller_id, id),
  UNIQUE (taller_id, numero),
  UNIQUE (taller_id, idem_key),
  FOREIGN KEY (taller_id, proveedor_id) REFERENCES proveedores(taller_id, id)
);
