# Registro de auditoría — Caldén Sistemas (taller)

- URL: https://taller.caldensistemasapp.com/
- Fecha: 2026-10-19
- Usuario: DEMO (rol "Operador")
- Navegador: Claude in Chrome, sesión existente del usuario
- Modo: solo lectura (navegación y apertura de formularios sin guardar), salvo autorización explícita

## Menú lateral (extraído del DOM, observado)

GENERAL
- Dashboard `/`
- Agenda `/agenda`
- Presupuestos `/quotes`
- Estadísticas `/estadisticas`

OPERACIÓN
- Órdenes de Trabajo: Órdenes de Trabajo `/work-orders`, Informe OT `/work-orders/report`, Mecánicos `/empleados`
- Servicios: Historia Clínica `/servicios`, Vehículos Clientes `/servicios/vehiculos`, Notificaciones `/servicios/notificaciones`
- Ficha Técnica: Vehículos `/vehicles`, Tablas `/service-tables`

ADMINISTRACIÓN
- Ventas: Clientes `/clients`, Artículos `/inventory`, Categorías `/categories`, Lista de Precios `/price-lists`, Baja Rápida `/quick-discharge`, Venta rápida CF `/venta-rapida`, Prefacturas `/prefacturas`, CC Clientes `/cuenta-corriente`, Cobranzas `/ventas-cobranzas`, Subdiario Ventas `/subdiario-ventas`
- Compras: Generar Orden `/purchase-order/generate`, Informe OC `/purchase-order/report`, Proveedores `/suppliers`, Facturas Proveedores `/facturas-proveedores`, Remitos Proveedores `/supplier-remitos`, Sub-diario Compras `/subdiario-compras`, Pagos Proveedores `/compras-pagos`, CC Proveedores `/cuenta-corriente-proveedores`, Tablas `/compras/tablas`
- Stock: Reposición `/replenishment`, Depósitos `/warehouses`, Remitos Internos `/internal-transfers`, Movimientos `/movements`
- Tesorería: Caja Diaria `/caja-diaria`, Bancos `/bancos`, Cheques de terceros `/cheques`, Cheques propios `/cheques-propios`, Gastos Fijos `/gastos-fijos`
- Contabilidad: Informe Cobranzas `/cobranzas`, Informe Pagos `/pagos-proveedores`, Libro IVA Digital `/contabilidad#libro-iva`, Plan de Cuentas `/contabilidad#plan-cuentas`, Estado de Resultados `/contabilidad#resultados`
- Finanzas: Resumen Financiero `/resumen-financiero`
- Caldén Sistemas: Auditoría `/auditoria`, Configuración `/settings`, Tutoriales `/tutoriales`, Nosotros `/nosotros`, Términos & Condiciones `/terminos`

## Pantallas inspeccionadas

| Ruta | Estado | Notas |
|---|---|---|
| `/` Dashboard | OK | ver 01/02 |
| `/work-orders` | OK | Filtros estado (Pend/En prog/Completadas/Todas) + período; 47 OT completadas; acciones fila: check-list ingreso, PDF mecánico sin precios, ver detalle, prefactura vinculada, WhatsApp, eliminar (bloqueado si tiene prefactura) |
| Form Nueva OT | OK (sin guardar) | cliente (buscar/nuevo), patente texto libre, km (validación ≥ último km), mecánico, lista precios, artículos (buscador nombre/SKU/EAN/cód prov), servicios por categoría (catálogo con precio), tipo vehículo por línea, desc% por línea, observaciones, moneda ARS/USD, desc global %/monto, IVA (0/10.5/21/27), recargo % sobre neto. Totales: artículos, servicios, neto, IVA, recargo, total |
| Detalle OT | OK | cabecera + líneas + "Desde Presupuesto P-0026" |
| Check-list ingreso | OK | 6 pestañas: Exterior (daños, ejes, neumáticos por eje), Interior, Accesorios, Combustible, Mecánica (testigos, estado ingreso), Final (recibido por) |
| `/work-orders/report` | OK | Informe: total OT, completadas, facturación total; tabla con PDF por OT |
| `/empleados` | REDIRIGE a `/` | Mecánicos: no accesible con este usuario (o ruta rota). Mecánico "Prueba" existe en selector |
| `/quotes` | OK | 26 presupuestos; filtros estado (Todos/Pend/Aprob/Rech/Vencidos) + período; acciones: Convertir a OT, editar, PDF, WhatsApp, eliminar. Default "Hoy" oculta todo |
| Form Nuevo Presupuesto | OK (sin guardar) | igual a OT + patente obligatoria seleccionada de vehículos del cliente, km*, año, válido hasta; subform Nuevo Vehículo (patente*, año*, marca*, modelo*, chasis, descripción) |
| `/agenda` | OK | Calendario mensual + lista; KPIs hoy/agendados/confirmados/sin agendar; banner "presupuestos aprobados sin agendar" |
| `/estadisticas` | OK | Ventas por cliente / cliente×producto / producto; compras por proveedor / prov×producto / producto; ganancia por producto; gráfico barras + tabla |
| `/servicios` Historia clínica | OK | por cliente → vehículos → ingresos (fecha, OT, km, servicio, checks); carga rápida de service histórico |
| `/servicios/vehiculos` | OK | Lista vehículos con marca/modelo/año/chasis |
| `/servicios/notificaciones` | OK | Próximos services vencidos por km/fecha |
| `/vehicles` Ficha técnica | OK | Marcas(30) → Modelos → Variantes (motor, transmisión manual/auto, litros, filtro, notas, 3 imágenes); export Excel |
| `/service-tables` | OK | Catálogo de servicios por categoría: nombre, tipo vehículo, km intervalo, años, precio, checks incluidos; ajuste masivo % con redondeo; export Excel. Categorías duplicadas (Service Motor/Caja/Diferencial aparecen 2 veces) |
| `/clients` | OK | 20 clientes, código #0000.., CONSUMIDOR FINAL fijo; filas expandibles |
| `/inventory` | OK | 370 artículos; requiere filtro o "Mostrar todos"; columnas Producto/SKU/EAN/Marca/Categoría/Stock/Ubicación; acciones imagen, descripción, movimiento stock (Entrada/Salida/Ajuste), editar, eliminar. Form: nombre*, SKU, EAN, marca, desc, categoría, proveedor, cód prov, cantidad, mínimo, ubicación, unidad (un/lt/kg/m), imagen, IVA (0/2.5/5/10.5/21/27), cuentas contables venta/compra; edición: proveedores del producto con costo y moneda |
| `/categories` | OK | 17 categorías con conteo; export Excel |
| `/price-lists` | OK | Listas con margen % sobre costo (Mayorista +5, Minorista +10 predeterminada); modificar precios, predeterminada, editar, eliminar |
| `/quick-discharge` | OK | Baja rápida de stock con escáner/código, carrito |
| `/venta-rapida` | OK | POS consumidor final, atajos F2/F4; ARCA no configurado → guarda venta pendiente |
| `/prefacturas` | OK | Estados: Pendiente, Emitida, Facturada, Rechazada por ARCA, Anulada, borrador. Tipos PREFACTURA/PROFORMA (PV 99999). Acciones: Facturar, editar, eliminar, cobrar, revertir proforma, PDF. Form: letra, PV, cliente, comprobante (Factura/NC/ND), lista precios, forma pago, OC, vincular OT, divisa+cotización, ítems, bonif gral + extra, IVA, exento, ARBA % |
| Cobro de proforma | OK (sin guardar) | importe parcial, método, notas; saldo |
| `/cuenta-corriente` | OK | Saldos por cliente: facturado/cobrado/saldo, expandible |
| `/ventas-cobranzas` | OK (sin guardar) | Selección cliente → proformas/facturas pendientes, multi-forma de pago, recibo |
| `/subdiario-ventas` | OK | Facturación ARCA / Proformas; filtro período y letra A/B/C/E/N; export CSV |
| `/purchase-order/generate` | OK | OC desde faltantes: filtro categoría/proveedor, "solo faltantes", proveedor destino, PDF |
| `/purchase-order/report` | OK | OC con productos/unidades/recibidas/estado (Pendiente/Recibido)/notas |
| `/suppliers` | OK | 12 proveedores: razón social, condición IVA, CUIT, contacto |
| `/facturas-proveedores` | OK | Nº interno, Nº factura, venc., total, estado (Pendiente/Pago parcial/Pagada); "Cargar con OCR"; form: proveedor, OC, tipo comprobante, categoría de gasto (no se abrió el detalle de ítems) |
| `/supplier-remitos` | OK | Remito sin factura suma stock, se vincula luego a factura; por depósito |
| `/subdiario-compras` | OK | Neto, IVA, perc. IVA, exento, perc. IIBB, otros, por mes/proveedor |
| `/compras-pagos` | OK (sin guardar) | Orden de pago por proveedor, numeración PV-Número |
| `/cuenta-corriente-proveedores` | OK | Facturado/pagos/saldo por proveedor |
| `/compras/tablas` | OK | Medios de pago (11, incl. retenciones) y categorías de gasto |
| `/replenishment` | OK | 127 productos a reponer, sugerido, recibir stock, PDF |
| `/warehouses` | OK | 1 depósito |
| `/internal-transfers` | OK | Remitos internos entre depósitos (vacío) |
| `/movements` | OK | 126 movimientos con stock anterior/mov/actual y origen (Baja rápida, Prefactura, OT finalizada). Posible doble descuento: woe-340 descontado por "OT 0048 finalizada" y por "Prefactura #000043" |
| `/caja-diaria` | OK | Apertura, ingresos (cobros OT, manuales), egresos (gastos, pagos prov.), saldo esperado, cerrar caja, movimiento manual. Carga lenta (~5 s) |
| `/bancos` | OK | Cuentas, movimientos, conciliación, informe; saldo ARS/USD |
| `/cheques`, `/cheques-propios` | OK | Físicos y eCheq, cartera, origen en cobranza/OP |
| `/gastos-fijos` | OK | Conceptos recurrentes, obligaciones por mes, estados pagado/pendiente/vencido |
| `/cobranzas` (informe) | OK | Recibos RP (proforma) y RF (factura), valores por medio incl. retenciones |
| `/pagos-proveedores` (informe) | OK | OP por período, resumen por medio, export Excel |
| `/contabilidad` | OK | Archivos (plan de cuentas, parámetros, cuentas por defecto), Asientos (manuales/ventas/compras/fondos), Libro diario, Mayores, Balance, Cierres. Hash `#libro-iva` no abre pestaña específica |
| `/resumen-financiero` | OK | Cobranzas por tipo de pago y período |
| `/auditoria` | OK | Chequeo de registros huérfanos/inconsistencias |
| `/settings` | OK (sin guardar) | Empresa (logo, nombre, CUIT, inicio, divisa, cotización USD, dirección); ARCA (habilitar, ambiente, PV, condición IVA, probar conexión, certificado cargado). Versión 2.4.0 (14/10/2026). Sin gestión de usuarios visible |
| `/tutoriales` | OK | Índice de tutoriales por sección |
| Buscador global (⌘K) | OK | Clientes y OTs; muestra estado "completed" sin traducir |
| Mecánicos (desde menú) | REDIRIGE a `/` | Igual que por URL |
| Responsive | NO VERIFICADO | No se pudo redimensionar la ventana; existe botón "Abrir menú" (INFERIDO: sidebar colapsable en móvil) |

## Pruebas realizadas (todas sin guardar)
- Nueva OT: agregar servicio de catálogo (precio automático $343.200), agregar artículo (aplica lista minorista +10%), IVA 21% + recargo 3% → neto, IVA y recargo calculados correctamente.
- Subformulario Nuevo Cliente (campos y desplegables), Nuevo Vehículo, Nuevo Presupuesto con cliente existente.
- Diálogos: check-list (6 pestañas), cobro de proforma, nueva prefactura, nueva factura proveedor, nuevo producto, editar producto, movimiento de stock, nueva configuración de service, ajuste masivo, nueva variante, nuevo turno.
- No se creó, modificó ni eliminó ningún registro. No se emitieron comprobantes ni se enviaron mensajes.

## Limitaciones
- Usuario DEMO con rol "Operador": Mecánicos inaccesible; no se vio gestión de usuarios/roles.
- La cuenta tiene datos (aparentemente de demostración, nombres y montos de prueba), pero no se confirmó que sea un entorno aislado → no se ejecutaron flujos de escritura.
- No se descargaron PDFs ni se probó OCR, WhatsApp, ARCA, escáner ni cierre de caja.
- Responsive no verificado.
- Incidente menor: al desplegar el menú por script se alternó el tema claro/oscuro; se restauró a "light" al final.
