# 04 — Modelo de datos

Hay dos niveles:
- **A. Modelo observado en Caldén**: lo que la interfaz expone. Sirve para dimensionar el alcance.
- **B. Modelo propuesto para nuestro MVP**: reducido a lo esencial de un taller y listo para implementar.

---

## A. Entidades observadas en Caldén (≈40)

| Dominio | Entidades | Evidencia |
|---|---|---|
| Maestros | Empresa, Usuario (rol), Cliente, Proveedor, Mecánico/Empleado, Marca, Modelo, Variante, Vehículo de cliente | OBS (Mecánico: solo nombre) |
| Catálogos | Categoría de artículo, Artículo, Artículo-Proveedor (costo), Lista de precios, Categoría de servicio, Servicio (tabla de service), Check incluido, Medio de pago, Categoría de gasto, Depósito | OBS |
| Operación | Presupuesto + líneas, OT + líneas (artículo/servicio), Registro de tiempo del mecánico, Check-list de ingreso, Turno, Ingreso de historia clínica | OBS (tiempo: INF por el cronómetro) |
| Ventas | Prefactura/Proforma/Factura/NC/ND + ítems, Recibo + valores, Venta rápida | OBS |
| Compras | Orden de compra + ítems, Remito de proveedor, Factura de proveedor, Orden de pago + valores | OBS |
| Stock | Movimiento de stock, Remito interno | OBS |
| Tesorería | Caja diaria + movimientos, Cuenta bancaria + movimientos + conciliación, Cheque de terceros, Cheque propio, Concepto de gasto fijo, Obligación mensual | OBS |
| Contabilidad | Cuenta contable (árbol), Asiento + renglones, Cierre, Parámetros/cuentas por defecto | OBS |
| Fiscal | Config. ARCA (certificado, PV, ambiente), CAE por comprobante | OBS (config) / INF (CAE) |

---

## B. Modelo propuesto (MVP de taller)

### Diagrama

```
empresa (1 fila)
cliente 1───* vehiculo 1───* orden_trabajo *───1 mecanico
   │                             │  1
   │                             ├──* ot_item (tipo: articulo|servicio) *───0..1 articulo / servicio
   │                             ├──0..1 checklist_ingreso
   │                             └──* pago
   ├──* presupuesto 1──* presupuesto_item          presupuesto 0..1───0..1 orden_trabajo
   └──* turno *───0..1 presupuesto
articulo *───1 categoria          articulo 1───* movimiento_stock *───0..1 orden_trabajo
servicio *───1 categoria_servicio
lista_precio (margen %)
```

### Tablas

**empresa**: id, nombre, cuit, direccion, telefono, logo, moneda, recargo_default, pie_presupuesto, siguiente_nro_ot, siguiente_nro_presupuesto

**cliente**
| Campo | Tipo | Regla |
|---|---|---|
| id | pk | |
| codigo | int, único | autoincremental (OBS) |
| nombre / razon_social | text | **obligatorio** (OBS) |
| documento (CUIT/DNI) | text | opcional; único si se carga (INF) |
| condicion_iva | enum RI, MONO, EXENTO, CF, EXT | default CF (OBS) |
| telefono, email, direccion, localidad, provincia | text | email con formato válido |
| notas | text | |
| created_at, updated_at, deleted_at | ts | baja lógica |

**vehiculo**
| Campo | Tipo | Regla |
|---|---|---|
| id, cliente_id | fk | obligatorio |
| patente | text | obligatoria, normalizada (mayúsculas, sin espacios), **única** |
| marca, modelo | text | obligatorios en Caldén (OBS); proponemos texto con sugerencias en lugar del árbol de marcas |
| anio | int | 1950..año+1 |
| chasis, motor, combustible | text | opcional |
| km_actual | int | se actualiza con cada OT; **no puede bajar** (OBS) |

**mecanico**: id, nombre, telefono, activo

**categoria_servicio**: id, nombre, orden

**servicio** (catálogo de mano de obra)
| Campo | Tipo | Regla |
|---|---|---|
| id, categoria_id | | |
| nombre | text | obligatorio |
| tipo_vehiculo | enum Todos, Auto, Camioneta, Camión, Moto, Tractor | OBS |
| precio | decimal | ≥ 0 |
| intervalo_km, intervalo_meses | int null | para recordatorios de service (OBS) |
| checks_incluidos | text[] / json | OBS |

**categoria**: id, nombre, descripcion

**articulo**
| Campo | Tipo | Regla |
|---|---|---|
| id, codigo/sku, ean | text | SKU único si se carga |
| nombre | text | obligatorio |
| marca, categoria_id, ubicacion, unidad (un/lt/kg/m) | | |
| costo | decimal | ≥ 0 (en Caldén el costo va por proveedor; en el MVP simplificamos a un único costo) |
| precio_venta | decimal | calculado (costo × (1+margen)) o manual |
| alicuota_iva | 0/10.5/21/27 | default 21 |
| stock, stock_minimo | decimal | stock puede quedar negativo (OBS); en el MVP, advertir |

**lista_precio**: id, nombre, margen_pct, predeterminada (bool), activa

**presupuesto**
| Campo | Tipo | Regla |
|---|---|---|
| id, numero | int | correlativo P-0001 (OBS) |
| cliente_id, vehiculo_id | fk | obligatorios (OBS) |
| fecha, valido_hasta | date | si valido_hasta < hoy y está pendiente → **Vencido** (OBS) |
| km | int | obligatorio en Caldén (OBS) |
| estado | enum pendiente, aprobado, rechazado, vencido, convertido | OBS (+ "convertido" propuesto) |
| lista_precio_id, moneda, desc_global_pct, desc_global_monto, iva_pct, recargo_pct, observaciones | | OBS |
| subtotal_articulos, subtotal_servicios, neto, iva, recargo, total | decimal | calculados y guardados |

**presupuesto_item / ot_item**
| Campo | Tipo | Regla |
|---|---|---|
| id, padre_id | | |
| tipo | articulo, servicio, libre | OBS |
| articulo_id / servicio_id | fk null | |
| descripcion | text | editable (OBS) |
| cantidad | decimal | > 0 |
| precio_unitario | decimal | ≥ 0; se congela al guardar |
| descuento_pct | 0..100 | OBS |
| subtotal | decimal | cantidad × precio × (1 − desc) |

**orden_trabajo**
| Campo | Tipo | Regla |
|---|---|---|
| id, numero | int | correlativo 0001 (OBS) |
| cliente_id, vehiculo_id | fk | obligatorios en el MVP (en Caldén la patente es libre: lo corregimos) |
| presupuesto_id | fk null | origen (OBS) |
| mecanico_id | fk null | OBS |
| fecha_ingreso, fecha_entrega_estimada, fecha_cierre | ts | |
| km_ingreso | int | ≥ vehiculo.km_actual (OBS) |
| estado | pendiente → en_progreso → completada → entregada; cancelada | OBS (pendiente, en progreso, completada); "entregada" y "cancelada" propuestos |
| falla_reportada, diagnostico, observaciones | text | |
| totales (igual que presupuesto) | | |
| saldo | decimal | total − pagos |

**checklist_ingreso**: id, ot_id (único), danos (json), interior (json), accesorios (json), combustible (enum), testigos (json), estado_ingreso (enum), observaciones, recibido_por, fotos (opcional, fase 2)

**turno**: id, fecha, hora, cliente_id (fk; en Caldén es texto libre, lo corregimos), vehiculo_id null, presupuesto_id null, estado (agendado, confirmado, completado, cancelado, ausente), notas

**pago**: id, ot_id, fecha, monto (> 0 y ≤ saldo), metodo (efectivo, transferencia, débito, crédito, cheque, cuenta corriente), referencia, notas

**movimiento_stock**: id, articulo_id, fecha, tipo (entrada, salida, ajuste), cantidad, stock_anterior, stock_nuevo, origen (ot, manual, compra), origen_id, notas — OBS (misma estructura de columnas)

---

## Reglas de negocio

| # | Regla | Nivel |
|---|---|---|
| R1 | El km de una OT no puede ser menor que el último km registrado de la patente | OBS (texto de ayuda) |
| R2 | El precio de un artículo en la OT o el presupuesto = costo × (1 + margen de la lista elegida); "Recalcular existentes" lo vuelve a aplicar | OBS |
| R3 | El precio de un servicio sale del catálogo y es editable en la línea | OBS |
| R4 | Totales: subtotal de líneas con desc%; descuento global (% o monto); IVA sobre el neto; recargo % sobre el neto; total = neto + IVA + recargo | OBS (verificado numéricamente) |
| R5 | El presupuesto vence al pasar la fecha "válido hasta" | OBS |
| R6 | Solo un presupuesto pendiente se puede editar o convertir a OT | OBS (botones solo en pendientes) |
| R7 | Una OT con factura o proforma asociada no se puede eliminar | OBS (tooltip) |
| R8 | Al completar una OT se descuenta el stock de sus artículos | OBS (movimiento "OT 0048 finalizada") |
| R9 | El stock puede quedar negativo | OBS |
| R10 | Los cobros pueden ser parciales y el saldo pasa a cuenta corriente | OBS |
| R11 | El próximo service se calcula con el intervalo de km y tiempo del servicio realizado | OBS (notificaciones) |
| R12 | Cliente "Consumidor Final" fijo (#0000) | OBS |
| R13 | El descuento de stock debe ocurrir **una sola vez** por consumo (evitar el doble descuento OT + prefactura que se vio en Caldén) | Propuesta |
| R14 | Numeración correlativa sin huecos para OT y presupuestos | INF |

## Operaciones CRUD del MVP
| Entidad | C | R | U | D |
|---|---|---|---|---|
| Cliente | ✓ | ✓ búsqueda | ✓ | baja lógica (si no tiene OT) |
| Vehículo | ✓ | ✓ por patente | ✓ | baja lógica |
| Servicio / Categoría | ✓ | ✓ | ✓ (+ ajuste masivo %) | ✓ si no está en uso |
| Artículo | ✓ | ✓ filtros | ✓ (+ movimiento) | baja lógica |
| Presupuesto | ✓ | ✓ | solo pendiente | solo pendiente |
| OT | ✓ | ✓ | hasta completada | solo sin pagos |
| Turno | ✓ | ✓ calendario | ✓ estado | ✓ |
| Pago | ✓ | ✓ | ✗ (anular con contra-movimiento) | anular |

## Dependencias entre módulos (orden de construcción)
`empresa` → `cliente` → `vehiculo` → `catálogo (servicios, artículos, listas)` → `presupuesto` → `orden_trabajo` (+ check-list, stock) → `pago` → `turno` → `historial y recordatorios` → `reportes`
