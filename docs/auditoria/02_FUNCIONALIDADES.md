# 02 — Inventario de funcionalidades

Etiquetas: **[OBS]** observado en la aplicación · **[INF]** inferido, no confirmado · **[DESC]** desconocido.
Ninguna acción se guardó: los formularios se abrieron y, cuando hizo falta, se completaron sin confirmar.

---

## 1. Dashboard `/`
- [OBS] Fecha y saludo con el nombre del usuario. Banner con imagen.
- [OBS] Accesos rápidos: Nueva orden de trabajo, Baja rápida, Prefactura, Agenda, Consultar precios, Carrito rápido.
- [OBS] KPIs: "Órdenes activas" (pendientes + en progreso) y "Finalizadas hoy".
- [OBS] Tarjetas: OT activas (con "Ver todas" y "Crear orden de trabajo"), Agenda de hoy, Recursos del taller (370 artículos, 20 clientes, 12 proveedores), Accesos frecuentes y Stock bajo (5 artículos bajo el mínimo, uno con stock **-1**).
- [OBS] Se permite stock negativo: el artículo WFC-213 figura con -1.

## 2. Órdenes de Trabajo `/work-orders`
**Listado**
- [OBS] Filtro por estado: Pendientes/En progreso (por defecto), Pendientes, En progreso, Completadas, Todas.
- [OBS] Filtro por período: Todo, Hoy, 7 días, 30 días, Este mes, Este año, rango de fechas.
- [OBS] Columnas: N° OT, Cliente, Patente, Mecánico (con cronómetro, p. ej. "Pausada · 0h 1m"), Estado, Total, Fecha, Acciones.
- [OBS] Acciones por fila:
  - cargar o ver el check-list de ingreso;
  - **PDF para el mecánico (sin precios)**;
  - ver detalle;
  - prefactura vinculada (#, borrador o emitida);
  - enviar por WhatsApp;
  - eliminar, **deshabilitado si la OT tiene factura o proforma asociada**.
- [OBS] Según el texto de ayuda, con mecánico asignado se puede iniciar y detener el trabajo desde la lista para registrar horas.
- [DESC] Botones exactos de cambio de estado (no había OT activas para verlos).

**Formulario Nueva OT (modal)**
| Sección | Campos y comportamiento [OBS] |
|---|---|
| Cliente | Buscador con autocompletado (código + nombre). Botón "Nuevo Cliente" abre un sub-modal. |
| Vehículo | Patente en **texto libre** (ej. "ABC 123"). Km opcional: "no puede ser menor al último km registrado para esta patente y se usa para calcular el próximo service". |
| Mecánico | Desplegable: Sin asignar / mecánicos cargados. |
| Artículos | Lista de precios (Sin lista, mayorista +5%, minorista +10%, otra) y "Recalcular existentes". Buscador por nombre, SKU, EAN o código de proveedor; muestra precio y stock. "Nuevo artículo" en línea. Tabla: producto, cantidad, precio, desc%, subtotal, eliminar. |
| Mano de obra / Servicios | Botones por categoría (Service Motor, Frenos, Distribución, etc.), cada uno con un menú de servicios del catálogo (ej. "Cambio de pastillas + discos DELANTEROS AG"). Al elegir uno se agrega una línea con categoría, **tipo de vehículo** (Auto/Camioneta/Camión/Moto/Tractor), descripción editable, precio (del catálogo), desc% y subtotal. También hay una línea libre (descripción + precio + Agregar). |
| Observaciones | Texto libre. |
| Totales | Moneda (ARS/USD), descuento global en % o monto, IVA (Sin IVA, 10,5, 21, 27), recargo % sobre el neto (casilla + valor, por defecto 3). Desglose: Artículos, Servicios, Neto gravado, IVA, Recargo, **Total**. |
| Acciones | Cancelar / Crear OT |

- [OBS] Cálculo verificado: artículo $15.400 + servicio $343.200 = neto $358.600; IVA 21% = $75.306; recargo 3% = $10.758 (sobre el neto).
- [OBS] La lista de precios se aplica sobre el costo (minorista +10%).

**Detalle OT**
- [OBS] Muestra: cliente, teléfono, patente, km, fecha y hora, mecánico, lista de precios, líneas (descripción, precio, desc, subtotal), observaciones (ej. "Desde Presupuesto P-0026"), subtotal y total.

**Check-list de ingreso (modal con 6 pestañas)**
- [OBS] Exterior: daños (rayones, golpes, abolladuras, vidrios rotos, llantas dañadas, neumáticos en mal estado), cantidad de ejes, estado de neumáticos por eje, observaciones.
- [OBS] Interior: tapizados, tablero, alfombras, volante, olores, limpieza; observaciones; objetos personales.
- [OBS] Accesorios: matafuego, balizas, rueda de auxilio, crique, llave de seguridad, manual, segunda llave, tuerca antirrobo; otros.
- [OBS] Combustible: Reserva, 1/4, 1/2, 3/4, Lleno.
- [OBS] Mecánica: testigos (Check Engine, Airbag, ABS, EPC, Temperatura, Aceite, Batería, otros); estado al ingreso (funcionando, en grúa, arranca con dificultad, no arranca); observaciones.
- [OBS] Final: "Recibido por". **Sin fotos ni firma del cliente.**

## 3. Informe OT `/work-orders/report`
- [OBS] Búsqueda (cliente, N° OT, patente), filtro por estado y fechas. KPIs: total OT (47), completadas (47), facturación total ($14.934.761,12). Tabla con PDF por OT.

## 4. Mecánicos `/empleados`
- [OBS] Redirige al Dashboard para el rol Operador. [INF] Restringido por rol.
- [OBS] Existe al menos un mecánico ("Prueba"). [DESC] Campos, valor hora, comisiones.

## 5. Presupuestos `/quotes`
- [OBS] Filtro por estado: Todos, Pendientes, Aprobados, Rechazados, Vencidos. Por período: Hoy (**por defecto**, oculta el historial), semana, mes, año, rango, Todos. Búsqueda por cliente o número.
- [OBS] Columnas: N° (P-0026), fecha, cliente, patente, válido hasta (marca "Vencido"), total, estado.
- [OBS] Acciones: **Convertir a OT** (solo pendientes), editar (solo pendientes), descargar PDF, WhatsApp, eliminar.
- [OBS] Formulario igual al de la OT, con estas diferencias:
  - la **patente es obligatoria** y se elige de los vehículos del cliente ("Elegí un cliente primero"; si no tiene, "Sin vehículos cargados" + "Nuevo Vehículo");
  - **km obligatorio**;
  - año del vehículo;
  - **válido hasta** (fecha).
- [OBS] Sub-formulario Nuevo Vehículo: patente*, año*, marca* (30 marcas de la ficha técnica), modelo* (depende de la marca), N° de chasis, descripción.
- [OBS] Inconsistencia: la OT acepta una patente libre, mientras que el presupuesto exige un vehículo registrado (el cliente "Leo Pepe" tiene una OT con la patente SVD 577 pero 0 vehículos).

## 6. Agenda `/agenda`
- [OBS] KPIs: hoy, agendados, confirmados, sin agendar. Banner con los presupuestos aprobados sin turno.
- [OBS] Vistas Calendario (mes) y Lista (fecha, hora, estado, cliente, patente). Estados: **Agendado, Confirmado, Completado**.
- [OBS] Nuevo turno: vincular presupuesto (opcional), fecha*, hora*, cliente* (**texto libre**), teléfono, patente, notas.
- [DESC] Duración del turno, recordatorios, capacidad por box o mecánico.

## 7. Estadísticas `/estadisticas`
- [OBS] Ventas: por cliente, cliente × producto, por producto. Compras: por proveedor, proveedor × producto, por producto. Rentabilidad: ganancia por producto.
- [OBS] Período (desde/hasta, mes actual, mes anterior, año). KPIs total, cantidad, registros. Gráfico de barras top 10 y tabla con porcentaje.

## 8. Servicios
**Historia clínica `/servicios`**
- [OBS] KPIs: clientes activos (18), vehículos (22), ingresos (43). Búsqueda por patente, cliente, marca o modelo.
- [OBS] Acordeón cliente → vehículos → ingresos (fecha, OT, km, servicio, detalle como "Filtros: Aceite, Habitáculo, Combustible, Aire"). Botón de PDF por cliente y por vehículo.
- [OBS] "Carga rápida de servicio histórico": cliente* (o nuevo), vehículo/patente* (o nuevo), fecha*, km, servicios realizados* (lista de casillas del catálogo, ~55 ítems).

**Vehículos de clientes `/servicios/vehiculos`**
- [OBS] Tarjetas: patente, marca/modelo/año, cliente, chasis.

**Notificaciones `/servicios/notificaciones`**
- [OBS] Servicios vencidos o próximos por km y por tiempo (ej. "Vencido por km (1.760.001 km pasado)", fecha próxima, intervalo y km actual).
- [DESC] Si envía avisos al cliente (no se vio botón de envío).

## 9. Ficha técnica
**Vehículos `/vehicles`**
- [OBS] Navegación en tres niveles: Marcas (30) → Modelos (ej. VW: 32) → Variantes. Exportar a Excel, búsqueda y alta en cada nivel.
- [OBS] Variante: hasta 3 imágenes, tipo de motor, transmisión (Manual/Automática), litros, notas, "Lleva filtro". Ej. AMAROK 2.0 → "ZF8HP Automática, TOP TEC 1800 1L, 10L, Filtro".

**Tablas de Service `/service-tables`**
- [OBS] Catálogo de mano de obra agrupado por categoría. Columnas: nombre, tipo de vehículo, intervalo en km, intervalo en años, precio, checks incluidos.
- [OBS] Nueva configuración: nombre, categoría, intervalo km, intervalo años, precio, checks incluidos (lista), tipo de vehículo.
- [OBS] Ajuste masivo de precios: categoría (o todas), tipo de ajuste (± %), porcentaje y redondeo (ej. al múltiplo de $100).
- [OBS] Categorías duplicadas en la interfaz (Service Motor, Service Caja y Service Diferencial aparecen dos veces).

## 10. Clientes `/clients`
- [OBS] Lista en tarjetas: código (#0000 = CONSUMIDOR FINAL fijo), nombre, teléfono, email, CUIT, cantidad de vehículos. Acciones: ver, editar, eliminar, expandir (vehículos).
- [OBS] Formulario: código autoasignado; CUIT/DNI con botón **ARCA** (consulta del padrón para autocompletar); razón social*; nombre de fantasía; rubro; teléfono; email; dirección; CP; localidad; provincia; país (Argentina); condición de IVA (RI, Monotributista, Exento, Consumidor Final, Exterior); Ingresos Brutos (No aplica, Local, Convenio Multilateral, Régimen Especial); imputación contable (árbol del plan de cuentas); medio de cobro preferido (Efectivo, Transferencia, Débito, Crédito, Cheque, Cuenta corriente, retenciones).

## 11. Artículos / Inventario `/inventory`
- [OBS] No lista nada hasta elegir un filtro o "Mostrar todos" (370 artículos). Selector de lista de precios. Filtros por categoría, marca y stock bajo.
- [OBS] Columnas: producto (N° interno), SKU, EAN, marca, categoría, stock, ubicación. **El listado no muestra precios.**
- [OBS] Acciones: ver imagen, ver descripción, movimiento de stock, editar, eliminar.
- [OBS] Alta: nombre*, SKU, EAN, marca (texto), descripción, categoría, proveedor, código de proveedor, cantidad, mínimo, ubicación, unidad (un/lt/kg/m), imagen, alícuota de IVA (0/2,5/5/10,5/21/27), cuenta de venta, cuenta de compra.
- [OBS] Edición: además, "Proveedores del producto" (proveedor, código, **costo**, moneda). [INF] Precio de venta = costo × (1 + margen de la lista).
- [OBS] Movimiento de stock: tipo (Entrada/Salida/Ajuste), cantidad, notas.

## 12. Categorías `/categories` y Listas de precios `/price-lists`
- [OBS] 17 categorías con descripción y cantidad de productos; exportar a Excel.
- [OBS] Listas: nombre, descripción, activa, **margen sobre costo %**, predeterminada. Acciones: modificar precios, marcar como predeterminada, editar, eliminar.

## 13. Baja rápida `/quick-discharge`
- [OBS] Búsqueda o escaneo (botón "Escanear", [INF] cámara o lector de código de barras), lista de precios, carrito, bajas recientes de la sesión.

## 14. Venta rápida CF `/venta-rapida`
- [OBS] Punto de venta para consumidor final. Atajos F2 (emitir) y F4 (identificar comprador). Buscador de productos (Enter agrega el primero), ítem libre, medio de pago, email para el comprobante, opción "solicita CUIT para Ganancias".
- [OBS] Aviso: "ARCA todavía no está lista… las ventas se guardan como pendientes".

## 15. Prefacturas `/prefacturas`
- [OBS] Estados: Pendiente, borrador, Emitida, Facturada, Rechazada por ARCA, Anulada. Tipos: PREFACTURA (PRE-000050) y PROFORMA (N-99999-000047).
- [OBS] Acciones: Facturar, Editar, Eliminar (pendientes); Cobrar, Revertir proforma a prefactura, PDF (emitidas).
- [OBS] Formulario:
  - Cabecera: operación, número, fecha, letra, punto de venta, cliente, comprobante (Factura / Nota de crédito / Nota de débito), lista de precios, forma de pago, orden de compra, **vincular OT** (carga ítems y cliente), divisa y cotización.
  - Ítems: cantidad, código, detalle, importe unitario, bonificación %, subtotal; líneas descriptivas.
  - Pie: bonificación general + extra, gravado, IVA %, IVA, exento, **ARBA %** (percepción provincial), observaciones.
- [OBS] Cobro de una proforma: importe (admite **cobro parcial**, muestra cobrado y saldo), método (efectivo o transferencia, o a cuenta corriente), notas.

## 16. Cuenta corriente, cobranzas y subdiario de ventas
- [OBS] CC Clientes: tarjetas por cliente con facturado, cobrado y saldo, expandibles.
- [OBS] Cobranzas: se elige un cliente → proformas y facturas pendientes con su saldo, selección múltiple, **varias formas de pago** por recibo, observaciones, "Cobrar y generar recibo". Numeración independiente para recibos de proforma (RP) y de factura (RF).
- [OBS] Subdiario de ventas: Facturación ARCA / Proformas, período, letras A/B/C/E/N, exportar CSV.

## 17. Compras
- [OBS] Generar OC desde faltantes (stock < mínimo), proveedor destino, PDF.
- [OBS] Informe OC: estado Pendiente/Recibido, unidades recibidas.
- [OBS] Proveedores: razón social, condición de IVA, CUIT, email, teléfono, dirección.
- [OBS] Facturas de proveedor: N° interno, N° de factura, vencimiento, estado (Pendiente / Pago parcial / Pagada), **carga con OCR**; formulario con proveedor, OC, tipo de comprobante y categoría de gasto.
- [OBS] Remitos de proveedor: ingreso sin factura que suma stock y se vincula luego a la factura.
- [OBS] Subdiario de compras: neto, IVA, percepción IVA, exento, percepción IIBB, otros.
- [OBS] Pagos a proveedores: Orden de Pago con numeración PV-Número; CC de proveedores con saldos.
- [OBS] Tablas: medios de pago activables (11, incluidas 5 retenciones) y categorías de gasto.

## 18. Stock
- [OBS] Reposición: 127 productos a reponer con cantidad sugerida, "Recibir stock", PDF.
- [OBS] Depósitos (multi-depósito) y remitos internos entre depósitos.
- [OBS] Movimientos: stock anterior, movimiento, stock actual y origen ("[Taller] Baja rápida", "Prefactura #000045 (Proforma)", "OT 0048 finalizada"). Filtros por fecha, categoría, marca, producto, canal y depósito.
- [OBS] **Posible doble descuento**: el artículo woe-340 se descontó con "OT 0048 finalizada" y también con "Prefactura #000043". [INF] Puede ser un error de la aplicación o dos consumos distintos; no se pudo confirmar.

## 19. Tesorería
- [OBS] Caja diaria: apertura, ingresos (cobros de OT, manuales), egresos (gastos, pagos a proveedores), saldo esperado, "Cerrar caja", "+ Movimiento", quién la abrió. Carga lenta (~5 s).
- [OBS] Bancos: cuentas (banco, tipo, N°, CBU, alias, moneda, saldo), movimientos, **conciliación**, informe.
- [OBS] Cheques de terceros y propios: físicos y **eCheq**, estados (Cartera, Entregado), vínculo con el recibo o la orden de pago de origen.
- [OBS] Gastos fijos: conceptos, generación de obligaciones mensuales, estados pagado/pendiente/vencido, historial.

## 20. Contabilidad y finanzas
- [OBS] Plan de cuentas jerárquico (1. ACTIVO → 1.1.3.1.01 DEUDORES EN CTA CTE…). Cuentas por defecto para asientos automáticos.
- [OBS] Asientos manuales y automáticos (ventas, compras, fondos), libro diario, mayores, balance, cierres, libro IVA digital.
- [OBS] Informe de cobranzas (recibos con valores, incluidas retenciones), informe de pagos (exportar a Excel), resumen financiero por medio de cobro.

## 21. Sistema
- [OBS] Auditoría: detecta registros huérfanos o inconsistencias ("Todo en orden").
- [OBS] Configuración: logo, nombre, CUIT, fecha de inicio, divisa, **cotización USD manual**, dirección.
- [OBS] ARCA: habilitar, ambiente (Producción), punto de venta, condición de IVA, probar conexión; "certificado digital ya cargado".
- [OBS] No se ve gestión de usuarios ni roles para el Operador. [DESC] Si existe para administradores.
- [OBS] Tutoriales por sección. Botón "Actualizar sistema" y novedades.

## 22. Transversales
- [OBS] Buscador global ⌘K (clientes y OTs; muestra el estado en inglés, "completed").
- [OBS] PDF: OT para el mecánico, informe OT, presupuesto, prefactura/proforma, OC, historia clínica.
- [OBS] WhatsApp desde OT y presupuesto. [INF] Enlace `wa.me` con texto, no la API oficial.
- [OBS] Exportar a Excel o CSV en varias pantallas.
- [OBS] Moneda dual ARS/USD con cotización manual.
- [OBS] Notificaciones tipo toast (región "Notifications").

## Resumen de magnitud
| Dimensión | Cantidad observada |
|---|---|
| Rutas con contenido | ~50 |
| Formularios o modales distintos | 30+ |
| Integraciones externas | ARCA (CAE + padrón), OCR, WhatsApp, escáner |
| Módulos que son un ERP completo | Compras, Tesorería, Contabilidad, Facturación |
