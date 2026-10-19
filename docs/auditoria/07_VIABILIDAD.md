# 07 — Viabilidad técnica y comercial

## Veredicto

| Escenario | Veredicto |
|---|---|
| Construir un equivalente funcional de Caldén por ARS 400.000 en 1–2 días | **NO-GO** |
| Construir un "Taller Esencial" (sin fiscal, sin contabilidad, sin compras ni tesorería) por ARS 400.000 | **GO CON ALCANCE REDUCIDO**, con plazo realista de **6–8 días** de trabajo (≈ 60–70 h), no 1–2 |
| Lo que entra honestamente en 1–2 días (≈ 16–20 h) | Solo el **Núcleo**: clientes, vehículos, OT con totales, PDF, historial y backup. Vendible únicamente si el cliente acepta explícitamente esa reducción |

**Recomendación final: GO CON ALCANCE REDUCIDO.** Se ofrece el paquete "Taller Esencial" con alcance cerrado por escrito y plazo de entrega de 1,5 a 2 semanas calendario. Si el cliente necesita facturación electrónica ARCA o paridad con Caldén, **no aceptar** a este precio.

---

## 1. Evidencia: el tamaño real del sistema de referencia
- ~50 pantallas con contenido, 30+ formularios modales, ~40 entidades (ver 01, 02 y 04).
- Integraciones externas: **ARCA** (CAE, certificados, punto de venta y consulta de padrón), **OCR** de facturas, WhatsApp, escáner.
- Incluye módulos completos de ERP: compras, tesorería (caja, bancos con conciliación, cheques y eCheq, gastos fijos) y **contabilidad de partida doble** (plan de cuentas, asientos automáticos, diario, mayores, balance, cierres, libro IVA).
- Versión 2.4.0: producto maduro, con muchas iteraciones.

Caldén no es "un software de talleres": es un **ERP para pymes con módulo de taller**. Compararlo con un desarrollo de 2 días es comparar productos distintos.

## 2. Complejidad y horas por módulo (equivalencia con Caldén)
Horas estimadas **con asistencia de IA, incluyendo pruebas y corrección**: no son horas de "generar código", sino de entregar algo que no rompa datos.

| # | Módulo | Complejidad | Horas |
|---|---|---|---|
| 1 | Base: layout, navegación, ⌘K, configuración, usuarios y roles | MEDIA | 12 |
| 2 | Clientes | BAJA | 6 |
| 2b | Consulta de padrón ARCA para autocompletar | ALTA | 10 |
| 3 | Vehículos de clientes | BAJA | 4 |
| 4 | Ficha técnica (marcas → modelos → variantes con imágenes) | MEDIA | 10 |
| 5 | Catálogo de servicios con intervalos y ajuste masivo | MEDIA | 8 |
| 6 | Artículos, categorías, listas de precios, costo por proveedor | MEDIA | 16 |
| 7 | Presupuestos (cálculo, estados, vencimiento, PDF, WhatsApp, a OT) | ALTA | 20 |
| 8 | Órdenes de trabajo (estados, mecánico y cronómetro, km, stock, PDF) | ALTA | 28 |
| 9 | Check-list de ingreso | MEDIA | 8 |
| 10 | Agenda de turnos | MEDIA | 12 |
| 11 | Historia clínica, notificaciones de service, carga histórica | MEDIA | 12 |
| 12 | Stock: movimientos, baja con escáner, reposición, depósitos, remitos internos | ALTA | 24 |
| 13 | Venta rápida (POS) | MEDIA | 10 |
| 14 | Prefacturas, proformas, NC/ND, cobro parcial, CC clientes, cobranzas multi-medio con retenciones, recibos | ALTA | 40 |
| 15 | **Facturación electrónica ARCA** (WSAA/WSFE, certificados, CAE, letras, homologación) | ALTA | 50 |
| 16 | Compras: OC, proveedores, facturas, remitos, órdenes de pago, CC, subdiario | ALTA | 40 |
| 17 | OCR de facturas de proveedor | ALTA | 16 |
| 18 | Tesorería: caja diaria, bancos y conciliación, cheques y eCheq, gastos fijos | ALTA | 40 |
| 19 | **Contabilidad** (plan de cuentas, asientos automáticos, diario, mayores, balance, cierres, libro IVA) | ALTA | 70 |
| 20 | Estadísticas, informes, resumen financiero, exportaciones | MEDIA | 20 |
| 21 | Auditoría de consistencia, tutoriales | BAJA | 6 |
| 22 | QA integral, datos semilla, instalador, backups, capacitación, migración de datos | — | 40 |
| | **Total equivalente** | | **≈ 500 h** (rango razonable 420–650 h) |

## 3. Respuestas puntuales

**1. ¿Qué porcentaje se puede desarrollar en 1 día (~10 h productivas)?**
≈ **2 %** del esfuerzo equivalente, o ≈ 10 % de las pantallas: base de la app, clientes, vehículos y una OT simple con totales. Sin pruebas exhaustivas.

**2. ¿Y en 2 días (~20 h)?**
≈ **4 %** del esfuerzo equivalente, o ≈ 15–20 % de las pantallas: el Núcleo (ver 08, Fase 1). Cubre lo que un taller usa todos los días, pero no lo que Caldén ofrece.

**3. ¿Cuántas horas demanda una versión funcionalmente equivalente?**
**≈ 500 h** (420–650 h). Al ritmo de 10 h/día son 2 a 3 meses de una persona. El componente fiscal (ARCA) agrega además dependencia de trámites del cliente (certificado, punto de venta) y de homologación.

**4. Módulos de mayor riesgo**
| Riesgo | Por qué |
|---|---|
| ARCA / facturación | Requisitos legales; un error genera comprobantes fiscales inválidos. Requiere certificado del contribuyente y homologación. **Excluir.** |
| Contabilidad | Partida doble, cierres, libro IVA: exige un contador validando. **Excluir.** |
| Cálculo de totales | IVA, descuentos (de línea y global), recargo, redondeos: un error de centavos destruye la confianza. Requiere tests unitarios. |
| Stock | Consistencia (Caldén mismo muestra un posible doble descuento). Definir **un único punto** de descuento. |
| Backups y pérdida de datos | En escritorio, sin backup automático, un disco roto termina el negocio del cliente. |
| Alcance difuso / expectativas | El cliente vio una demo de un ERP; si no se firma el alcance, va a pedir "lo que tenía el otro". |
| Soporte no pago | "Sin mantenimiento" no evita las llamadas; acotarlo por contrato (p. ej. 30 días de garantía de bugs). |

**5. Funcionalidades que se pueden simplificar**
| En Caldén | En nuestro MVP |
|---|---|
| Marcas → Modelos → Variantes con imágenes | Marca y modelo en texto con autocompletado de lo ya cargado |
| Costo por proveedor con moneda + listas de precios | Costo + precio de venta por artículo; una lista de margen opcional |
| Prefactura → proforma → factura → recibo | La OT tiene "Pagos" (efectivo, transferencia, tarjeta, cuenta corriente) y saldo |
| Caja con apertura y cierre, bancos, cheques | Reporte de cobros por día y por medio de pago |
| Multi-depósito, remitos internos | Un depósito |
| Check-list de 6 pestañas | Una pantalla con casillas, combustible, km, observaciones |
| Cronómetro por mecánico | Mecánico asignado (horas: fase 2) |
| ARS/USD con cotización | Solo ARS |
| Estadísticas con gráficos | 4 reportes: ventas del período, OT por estado, servicios más vendidos, saldos de clientes |

**6. Funcionalidades imprescindibles para un taller**
Clientes y vehículos (por patente) · Orden de trabajo con repuestos y mano de obra · Estados de la OT · Presupuesto y su conversión a OT · Catálogo de servicios con precios · Historial por vehículo · Impresión o PDF y envío por WhatsApp · Cobros y saldo · Stock básico de repuestos · **Backup**.

**7. Funcionalidades a excluir inicialmente**
Facturación electrónica ARCA y consulta de padrón · Contabilidad completa · Compras (OC, facturas y pagos a proveedores, CC proveedores, OCR) · Tesorería (bancos, conciliación, cheques, eCheq, gastos fijos) · Multi-depósito · Venta rápida POS con escáner · Multi-moneda · Usuarios y roles múltiples · Ficha técnica con variantes e imágenes · Estadísticas avanzadas.

## 4. Evaluación económica
| Escenario | Horas | ARS/hora resultante con ARS 400.000 |
|---|---|---|
| Núcleo (Fase 1) | ~20 h | ≈ 20.000 |
| Taller Esencial (Fases 1 + 2) | ~60–70 h | ≈ 5.700–6.700 |
| Equivalente a Caldén | ~500 h | ≈ 800 |

- Comparar estos valores con la tarifa horaria propia. El escenario "equivalente" es inviable en cualquier mercado.
- El valor del producto se puede reutilizar: si se vende a varios talleres, el Taller Esencial se amortiza. **Esa es la verdadera tesis de negocio**: el primer cliente subsidia parcialmente un producto reutilizable.
- Costos ocultos que no cubre el precio: soporte post-venta, instalación presencial, migración de datos desde Excel o papel, certificado de firma de código.

## 5. Condiciones para aceptar (GO con alcance reducido)
1. Alcance cerrado por escrito: lista de funciones de 08 y lista explícita de exclusiones (sobre todo **sin facturación electrónica**).
2. Una PC con Windows 10/11, sin acceso multi-dispositivo.
3. Plazo de entrega de 1,5–2 semanas calendario (≈ 60–70 h). Si el cliente exige 2 días, se entrega solo la Fase 1, y la Fase 2 se cobra aparte.
4. Garantía de corrección de errores por 30 días; mejoras y cambios se cotizan aparte.
5. El cliente aporta: logo, datos del taller, lista de servicios con precios y (opcional) planilla de artículos para importar.
6. Pago: 50 % al inicio y 50 % a la entrega.

## 6. Qué decirle al cliente (argumento comercial)
"El sistema que estás viendo es un ERP completo con facturación electrónica y contabilidad. Si necesitás eso, conviene esa suscripción o licencia. Si lo que necesitás es **ordenar el taller** (clientes, vehículos, órdenes, presupuestos, historial, cobros y stock), te hacemos un sistema propio, más simple, que funciona sin internet, sin abono mensual y con tus datos en tu PC."
