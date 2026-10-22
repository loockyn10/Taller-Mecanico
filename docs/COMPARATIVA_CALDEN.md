# Comparativa funcional Fierro ↔ Caldén Taller Mecánico

Sprint 12 · 22/10/2026 · Documento de trabajo para priorizar. **No** afirma que Fierro esté listo para 100 talleres (ver sección 8).

## 0. Cómo leer este documento

**Fuentes de la columna "Evidencia de Caldén"** (se distinguen a propósito; no se hace ninguna suposición sobre el funcionamiento interno de Caldén):

| Etiqueta | Qué significa | Qué *no* prueba |
|---|---|---|
| **W** | Lo **anuncia** la página pública del producto ([Caldén Taller Mecánico](https://www.caldensistemas.com/productos/calden-taller-mecanico), leída el 22/10/2026) | Que funcione como se describe, ni su alcance |
| **O §n** | Lo **observamos** funcionando en la auditoría de solo lectura del 19/10/2026 con el usuario DEMO (rol Operador), registrada en [`docs/auditoria/`](auditoria/02_FUNCIONALIDADES.md) (sección *n*). Sin guardar nada | Que sea igual en otras instalaciones o roles; **no se volvió a verificar hoy** |
| **M** | Lo anuncia una **página de módulo general** (Ventas, Compras, Stock, Fondos, Contabilidad, Sueldos). Esas páginas **no dicen si forman parte del producto Taller Mecánico**: se usan como contexto, no como evidencia de paridad | Que el taller las tenga contratadas |
| **—** | No hay evidencia pública ni observada | — |

**Clasificación de Fierro** (verificada en el código, no por existir una pantalla):

- **COMPLETA** — las operaciones principales están implementadas, integradas con el resto (stock, caja, cuentas corrientes, contabilidad) y probadas.
- **IMPLEMENTADA CON LIMITACIONES** — funciona de punta a punta pero con un alcance menor a lo que un taller suele esperar; la limitación se explica.
- **PARCIAL** — falta una parte sustancial de la función.
- **NO IMPLEMENTADA** — no existe.

**Prioridades:** **P0** impide usar Fierro de forma segura o consistente · **P1** importante para el funcionamiento cotidiano · **P2** mejora competitiva relevante · **P3** opcional o futura.
**Complejidad** (estimada): S (días) · M (≈ un sprint corto) · L (un sprint) · XL (varios sprints / dependencia externa).

La evidencia de Fierro se cita como `ruta` (módulo del servidor `worker/modules/…`, pantalla `src/pages/…`) y prueba de integración `tests/api/…`.

---

## 1. Resumen ejecutivo

- Se inventariaron **77 funcionalidades** de Fierro leyendo el código y las rutas (no los informes de sprints anteriores): **48 completas**, **16 implementadas con limitaciones**, **4 parciales** y **9 no implementadas** (sección 2).
- **Fortalezas verificadas:** multiempresa con aislamiento garantizado por la base (claves foráneas compuestas) y probado; operación comercial completa y consistente (stock por depósito, caja, bancos, cheques, cuentas corrientes, anticipos y devoluciones, contabilidad de partida doble derivada y con controles); permisos granulares (7 plantillas, ≈ 60 permisos); gestión mecánica con tempario, tareas con cronómetro, historial técnico y mantenimientos; puesta en marcha autónoma e importación de datos; 344 pruebas de integración y 96 unitarias.
- **Brecha comercial dominante:** no emite comprobantes fiscales (factura A/B/C con CAE) ni consulta padrones: es una **decisión de alcance** (ARCA queda fuera de estos sprints), pero es lo primero que un taller argentino preguntará (sección 5 · D).
- **Brechas funcionales de uso diario frente a lo anunciado/observado:** check-list de recepción más pobre y sin fotos ni firma; ficha técnica sin variantes (aceite, litros, transmisión); avisos al cliente solo manuales; sin liquidación de sueldos; sin retenciones; sin notas de débito; sin recuperación de contraseña por correo.
- **P0 de este sprint:** (A) la contabilidad dejó de generarse al consultarla — ya está **resuelto y desplegado**; (B) saldos de apertura de **proveedores** resueltos, los de **clientes** quedan **abiertos** por requerir un cambio financiero extenso (diseño en la sección 6); (C) verificación online de solo lectura mejorada; (D) respaldo/verificación/exportación por taller para el operador. **P0 que siguen abiertos:** saldos de apertura de clientes; copias de respaldo programadas y fuera de la cuenta de Cloudflare (requiere una decisión); capacidad no medida (sección 8).

---

## 2. Inventario de funcionalidades de Fierro (Fase 1)

### 2.1 Gestión mecánica

| # | Funcionalidad | Clasificación | Evidencia (código y pruebas) | Límites |
|---|---|---|---|---|
| 1 | Clientes (código correlativo, baja lógica, consumidor final) | COMPLETA | `modules/maestros.ts`, `pages/Clientes.tsx`; `flujo`, `seguridad` | — |
| 2 | Vehículos (patente única por taller, km no regresivo, motor/combustible/VIN) | COMPLETA | `modules/maestros.ts`, `pages/Vehiculos.tsx`; `flujo` | Sin ficha técnica por variante (ver 15) |
| 3 | Ingreso de vehículos / alta de OT (búsqueda por patente, km, falla reportada, mecánico, fecha prometida, depósito) | COMPLETA | `modules/ordenes.ts` `POST /`, `pages/ordenes/NuevaOrden.tsx`; `flujo` | — |
| 4 | Check-list de recepción | IMPLEMENTADA CON LIMITACIONES | `ordenes.ts` `PUT /:id/checklist`; `shared/dominio.ts` `CHECKLIST_ITEMS` (daños, testigos, accesorios, estado de ingreso) + combustible, km, observaciones y "recibido por" | **Sin fotos ni firma del cliente**; sin interior/limpieza ni neumáticos por eje |
| 5 | Estado del vehículo al ingreso | IMPLEMENTADA CON LIMITACIONES | Mismo check-list (funcionando / en grúa / arranca con dificultad / no arranca) | Texto y casillas; sin diagrama de carrocería |
| 6 | Diagnóstico | IMPLEMENTADA CON LIMITACIONES | Campo `diagnostico` de la OT y estado «Diagnóstico» en el tablero | Texto libre: sin fallas estructuradas ni adjuntos |
| 7 | Presupuestos (estados, vencimiento, edición, conversión única a OT, PDF, WhatsApp) | COMPLETA | `modules/presupuestos.ts`; `flujo` (conversión simultánea) | — |
| 8 | Órdenes de trabajo (estados, tablero, edición con control de versión, comprobante) | COMPLETA | `modules/ordenes.ts`, `pages/ordenes/*`; `flujo`, `mecanica` | — |
| 9 | Repuestos en OT (descuento de stock una sola vez, reposición al reabrir, por depósito) | COMPLETA | `ordenes.ts` `POST /:id/estado`, `lib/stock.ts`; `flujo`, `depositos` | — |
| 10 | Mano de obra (catálogo de servicios, precio fijo o por tiempo × tarifa) | COMPLETA | `modules/catalogo.ts`, `modules/tempario.ts`; `mecanica` | — |
| 11 | Tempario (tiempos orientativos, estimación, plantilla) | COMPLETA | `modules/tempario.ts`, `pages/Tempario.tsx`; `mecanica` | Tiempos orientativos, no de fábrica |
| 12 | Mecánicos (asignación, participantes, costo/hora) y productividad | COMPLETA | `ordenes.ts`, `modules/productividad.ts`, `modules/costos.ts`, `pages/Productividad.tsx`; `mecanica`, `rentabilidad` | — |
| 13 | Tiempos (cronómetro por orden, tareas con estado) | COMPLETA | `ordenes.ts` `/:id/tiempo/*`, `/:id/tareas`; `mecanica` | — |
| 14 | Historial técnico del vehículo | COMPLETA | `modules/historial.ts`, `components/HistorialTecnico.tsx`; `mecanica` | — |
| 15 | Fichas técnicas por marca/modelo/variante | PARCIAL | `maestros.ts` marcas y modelos (con `motor` y notas); `catalogo` de marcas por taller | **Sin variantes**, transmisión, litros/tipo de aceite, filtros ni imágenes |
| 16 | Mantenimientos programados (intervalos por km y por tiempo, vencidos y próximos) | COMPLETA | `modules/mantenimientos.ts`, `pages/Mantenimientos.tsx`; `mecanica` | El aviso al cliente es manual (ver 74) |
| 17 | Entrega del vehículo | IMPLEMENTADA CON LIMITACIONES | Estado «Entregada», comprobante y cobro integrados (`ordenes.ts`) | Sin acta/firma de conformidad |
| 18 | Agenda de turnos (semanal, vinculada a presupuesto/OT) | COMPLETA | `modules/agenda.ts`, `pages/Agenda.tsx`; `flujo` | Sin recordatorios automáticos |
| 19 | Hoja de taller sin precios / documentos imprimibles | COMPLETA | `pages/Imprimir.tsx` (orden, orden-taller, presupuesto, comprobante) | PDF vía impresión del navegador |
| 20 | Vista móvil del mecánico («Mis trabajos») | COMPLETA | `pages/mecanico/MisTrabajos.tsx`; `mecanica` | — |

### 2.2 Gestión comercial

| # | Funcionalidad | Clasificación | Evidencia | Límites |
|---|---|---|---|---|
| 21 | Proveedores (CUIT, condición de IVA, saldo, baja lógica) | COMPLETA | `catalogo.ts` `/proveedores`, `pages/compras/Proveedores.tsx`; `compras` | Sin consulta de padrón |
| 22 | Ventas: comprobante interno (mostrador y desde OT, con cobro inmediato opcional, anulación) | COMPLETA | `modules/comercial.ts`, `pages/comercial/Ventas.tsx`; `flujo`, `finanzas` | **No es un comprobante fiscal** (se imprime «no válido como factura») |
| 23 | Facturas A/B/C electrónicas con CAE y notas de crédito/débito fiscales | NO IMPLEMENTADA | — | Fuera de alcance (ARCA) |
| 24 | Notas de crédito internas (devoluciones, reingreso al stock opcional, reintegro) | COMPLETA | `modules/devoluciones.ts`; `devoluciones` | Internas, no fiscales |
| 25 | Notas de débito a clientes | NO IMPLEMENTADA | — | — |
| 26 | Anticipos y saldos a favor de clientes | COMPLETA | `modules/anticipos.ts`, `lib/creditos.ts`; `devoluciones` | — |
| 27 | Cuentas corrientes de clientes (saldos, resumen, verificación) | COMPLETA | `comercial.ts` `/cuentas-corrientes*`; `flujo`, `finanzas` | **Sin saldo de apertura de clientes** (ver 6) |
| 28 | Cobranzas (varios medios, parciales, varios comprobantes, idempotentes, anulación) | COMPLETA | `comercial.ts` `/cobros`, `lib/cobros.ts`; `flujo` (concurrencia), `caja`, `bancos` | Seis medios (sin retenciones) |
| 29 | Compras (stock, costos, compra de contado, anulación) | COMPLETA | `modules/compras.ts`; `compras` | — |
| 30 | Órdenes de compra, recepciones, facturas y notas de crédito de proveedor | COMPLETA | `modules/abastecimiento.ts`; `abastecimiento` | Sin carga por OCR |
| 31 | Pagos a proveedores / orden de pago imprimible | IMPLEMENTADA CON LIMITACIONES | `compras.ts` `/pagos-proveedor`, `pages/ImprimirCompras.tsx`; `compras` | El pago se imputa al comprobante **más antiguo**: no se eligen las facturas a cancelar |
| 32 | Cuenta corriente de proveedores, vencimientos y deuda | COMPLETA | `compras.ts` `/proveedores/:id/cuenta`, `abastecimiento.ts`, `lib/proveedores.ts`; `compras`, `aperturas` | Saldos de apertura de proveedores desde el Sprint 12 |
| 33 | Listas de precios (margen, precio fijo por artículo, ajuste masivo, uso en documentos) | COMPLETA | `modules/precios.ts`; `precios` | — |
| 34 | Descuentos y recargos (global en % o monto, por línea, recargo %, IVA) | COMPLETA | `shared/totals.ts` (cálculo único cliente/servidor) | — |

### 2.3 Inventario

| # | Funcionalidad | Clasificación | Evidencia | Límites |
|---|---|---|---|---|
| 35 | Artículos (categorías, unidades, IVA, costo/precio, mínimos, ubicación) | COMPLETA | `catalogo.ts` `/articulos`, `pages/stock/Articulos.tsx`; `flujo`, `precios` | — |
| 36 | Códigos de barras (campo propio y búsqueda por lector) | IMPLEMENTADA CON LIMITACIONES | `catalogo.ts` `GET /articulos/lector/:codigo`; `depositos` | Lector USB/teclado; **sin lectura por cámara** |
| 37 | Depósitos múltiples (stock por depósito, depósito principal) | COMPLETA | `modules/depositos.ts`, `pages/stock/Depositos.tsx`; `depositos` | — |
| 38 | Transferencias entre depósitos | IMPLEMENTADA CON LIMITACIONES | `depositos.ts` `/transferencias` | Inmediatas, **sin remito imprimible** ni estado «en tránsito» |
| 39 | Stock mínimo (global y por depósito) y alertas | COMPLETA | `catalogo.ts`, `reportes.ts` `/dashboard`; `depositos`, `rentabilidad` | — |
| 40 | Valorización del inventario | IMPLEMENTADA CON LIMITACIONES | `modules/inventario.ts` `/inventario/valorizado` | Al **último costo** (sin costo promedio); costo histórico solo desde el Sprint 08 |
| 41 | Reposición (sugerencias por faltante y orden de compra) | COMPLETA | `compras.ts` `/reposicion`, `inventario.ts`; `abastecimiento` | Sin punto de reposición/stock máximo |
| 42 | Trazabilidad (libro de movimientos con origen y costo, conteos de inventario) | COMPLETA | `catalogo.ts` `/stock/movimientos`, `inventario.ts` `/inventario/conteos`; `flujo`, `depositos` | Sin lotes ni números de serie |
| 43 | Baja rápida / venta de mostrador | COMPLETA | `ventas` de mostrador + `stock/movimientos` | Sin pantalla dedicada con atajos |

### 2.4 Administración

| # | Funcionalidad | Clasificación | Evidencia | Límites |
|---|---|---|---|---|
| 44 | Caja diaria (apertura, movimientos, arqueos, cierre, reportes) | COMPLETA | `modules/caja.ts`, `pages/caja/Caja.tsx`; `caja` | — |
| 45 | Bancos (cuentas, movimientos, depósitos, extracciones, transferencias, ajustes, conciliación) | COMPLETA | `modules/bancos.ts`; `bancos` | Sin importación de extracto |
| 46 | Cheques (cartera, propios, eCheq, depósito, acreditación, rechazo, entrega) | COMPLETA | `modules/cheques.ts`; `bancos` | Sin chequeras |
| 47 | Tesorería (tablero) | COMPLETA | `modules/tesoreria.ts`; `finanzas` | — |
| 48 | Gastos (categorías, gastos fijos recurrentes, anulación) | COMPLETA | `modules/gastos.ts`; `finanzas` | — |
| 49 | Contabilidad: plan de cuentas, asientos automáticos y manuales, diario, mayor, balance, estado de resultados, controles | COMPLETA | `modules/contabilidad.ts`, `lib/contab/*`; `contabilidad`, `sync-contable`, `aperturas` | Sin cierre de ejercicio ni estado patrimonial; IVA informativo; sin moneda extranjera. **Desde el Sprint 12 se activa de forma explícita y no se genera al consultar** |
| 50 | Informes (19 informes de ventas, compras, cobranzas, deudores, rentabilidad, mecánicos…) | IMPLEMENTADA CON LIMITACIONES | `modules/informes.ts`, `pages/Informes.tsx`, `modules/reportes.ts`, `pages/Reportes.tsx`; `informes` | Sin informes «por cliente» ni «cliente × producto»; gráficos solo de barras simples |
| 51 | Exportaciones | IMPLEMENTADA CON LIMITACIONES | CSV con permiso y auditoría (`lib/exportar.ts`, `src/lib/csv.ts`); PDF por impresión | **Sin Excel (.xlsx)** ni TXT para ARCA |
| 52 | Libros IVA internos (ventas y compras) | IMPLEMENTADA CON LIMITACIONES | `informes.ts` `/contabilidad/libro-ventas`, `/libro-compras` | **No son libros fiscales** ni Libro IVA Digital |
| 53 | Controles de consistencia | COMPLETA | Contabilidad › Controles, `comercial.ts` `/cuentas-corrientes/verificar`, `depositos.ts` `/inventario/verificar`; claves foráneas compuestas | No hay una pantalla única de «auditoría de huérfanos» |
| 54 | Sueldos y liquidación | NO IMPLEMENTADA | Solo costo de mano de obra imputado a órdenes (`costos.ts`) y gastos de sueldos | Sin legajos, liquidación, recibos ni cargas |

### 2.5 Personal

| # | Funcionalidad | Clasificación | Evidencia | Límites |
|---|---|---|---|---|
| 55 | Usuarios, roles y permisos (7 plantillas, ≈ 60 permisos, cupo de licencia) | COMPLETA | `modules/personal.ts`, `shared/permisos.ts`, `pages/personal/Equipo.tsx`; `personal`, `seguridad` | — |
| 56 | Empleados / mecánicos sin usuario | COMPLETA | `maestros.ts` `/mecanicos` | — |
| 57 | Asistencia y fichaje (propio, panel, correcciones, reloj compartido con PIN) | COMPLETA | `modules/asistencia.ts`, `reloj.ts`, `lib/asistencia.ts`; `personal` | Sin lector biométrico |
| 58 | Productividad por mecánico y por taller | COMPLETA | `modules/productividad.ts`; `mecanica` | — |
| 59 | Acceso móvil | IMPLEMENTADA CON LIMITACIONES | PWA instalable, diseño responsive, «Mis trabajos» | No guarda datos sin conexión (a propósito, por seguridad); sin pruebas de interfaz automatizadas |

### 2.6 Funciones generales

| # | Funcionalidad | Clasificación | Evidencia | Límites |
|---|---|---|---|---|
| 60 | Configuración por taller (datos, logo, horarios, medios de pago, tarifas, impresión) | COMPLETA | `modules/taller.ts`, `pages/config/Configuracion.tsx`; `puesta` | — |
| 61 | Multiempresa (aislamiento por `taller_id` de la sesión + claves foráneas compuestas) | COMPLETA | `worker/index.ts`, todos los módulos; `seguridad`, `migraciones` (aislamiento probado en cada suite) | Comparten una D1: la capacidad no está medida (sección 8) |
| 62 | Multimoneda | NO IMPLEMENTADA | Solo se registran cuentas bancarias en dólares (sin contabilizar) | Sin cotización ni conmutador ARS/USD |
| 63 | Importación (clientes, vehículos, artículos, proveedores; Excel/CSV) | COMPLETA | `modules/importaciones.ts`, `pages/config/Importar.tsx`; `importacion` | No importa saldos de clientes (ver 6) ni listas de precios |
| 64 | Apertura de saldos (proveedores; caja y bancos por sus pantallas) | IMPLEMENTADA CON LIMITACIONES | `modules/aperturas.ts`, `pages/config/AperturaSaldos.tsx`; `aperturas` | **Sin clientes** (sección 6) |
| 65 | Respaldos | PARCIAL | `scripts/respaldo.mjs` (operador); `docs/RESPALDOS.md` | Manual, sin programación ni copia fuera de Cloudflare |
| 66 | Restauración | PARCIAL | Time Travel de Cloudflare (toda la base) | **No existe restaurar un solo taller** (ver `RESPALDOS.md`) |
| 67 | Exportación de los datos de un taller | PARCIAL | `scripts/respaldo.mjs exportar-taller` (operador) | El propietario no puede hacerlo solo |
| 68 | Auditoría de actividad | IMPLEMENTADA CON LIMITACIONES | `taller.ts` `/auditoria`, `pages/config` «Actividad» | Últimos 200 eventos, sin filtros |
| 69 | Notificaciones | NO IMPLEMENTADA | Solo avisos en pantalla y listas de vencidos | Sin campana de novedades ni envíos |
| 70 | Búsqueda global (Ctrl+K) | IMPLEMENTADA CON LIMITACIONES | `reportes.ts` `/buscar` | Solo clientes, patentes y N° de OT: no artículos, proveedores ni comprobantes |
| 71 | Configuración de módulos activables | NO IMPLEMENTADA | El menú se adapta a los permisos, no a módulos contratados | — |
| 72 | Experiencia responsive | COMPLETA | `src/components/Layout.tsx`, tablas que pasan a tarjetas | Verificación visual manual y acotada |
| 73 | Activación de talleres por invitación y asistente de puesta en marcha | COMPLETA | `modules/activacion.ts`, `puesta.ts`, `pages/Activar.tsx`; `activacion`, `puesta` | Alta por línea de comandos |
| 74 | WhatsApp (enlaces con mensaje armado) | IMPLEMENTADA CON LIMITACIONES | `src/lib/format.ts` (`wa.me`) | Manual: no hay envío automático |
| 75 | Recuperación de contraseña por correo | NO IMPLEMENTADA | Hoy la restablece el propietario o un administrador | Requiere enviar correos |
| 76 | Ayuda y tutoriales integrados | NO IMPLEMENTADA | Solo el asistente de puesta en marcha | — |
| 77 | Modo oscuro | NO IMPLEMENTADA | — | — |

---

## 3. Qué anuncia y qué se pudo verificar de Caldén

Resumen para no confundir publicidad con verificación:

- **Anunciado (W):** órdenes de trabajo con check-list, tiempos y repuestos; ficha técnica por marca/modelo/variante (motor, cilindrada, transmisión, aceite y litros); historia clínica y vencimientos con avisos automáticos; agenda con recordatorios por WhatsApp; depósitos múltiples con remitos internos y lector de código de barras (cámara o USB); factura A/B/C, notas de crédito y débito, cuenta corriente y subdiario de ventas; órdenes de compra, remitos, facturas con OCR y órdenes de pago a varias facturas; caja, bancos y cheques; libro IVA digital, plan de cuentas y estado de resultados con gráficos; gastos fijos, sueldos, auditoría; roles (administrador, operador, mecánico), reseteo de contraseña por correo, datos por empresa, módulos activables, ARS/USD, backup y restauración, modo claro/oscuro, notificaciones, tutoriales y chat de ayuda con IA; integración ARCA/AFIP (CAE, padrón A5), Mercado Pago y WhatsApp; exportación PDF, Excel/CSV y TXT para ARCA.
- **Observado (O, 19/10/2026, usuario Operador):** ver la tabla de la sección 4; destaca el check-list de seis pestañas sin fotos ni firma (O §2), la ficha técnica con variantes e imágenes (O §9), prefacturas/proformas con ARCA configurado (O §15), carga de facturas con OCR (O §17), orden de pago (O §17), remitos internos (O §18), conciliación bancaria y eCheq (O §19), plan de cuentas y asientos (O §20) y la auditoría de «registros huérfanos» (O §21).
- **No verificable desde fuera:** sueldos, liquidación, módulos de producción, respaldos y restauración, chat de IA, reseteo de contraseña, rendimiento y límites de uso. No hay precios públicos (solo «Consultar precios»).
- **Cosas que la observación mostró como débiles en Caldén** (solo en esa demo; no implican nada sobre otras instalaciones): stock negativo permitido (O §1), posible doble descuento de stock entre OT y prefactura (O §18), patente en texto libre en OT y cliente en texto libre en turnos (O §2, §6). Fierro hoy rechaza los tres casos (`tests/api/flujo`, `depositos`).

---

## 4. Matriz de diferencias (Fase 3)

Las cuatro tablas **no se mezclan**: A) funcionalidades faltantes; B) errores o inconsistencias existentes en Fierro; C) mejoras de experiencia; D) integraciones externas.

### 4.A Funcionalidades faltantes o incompletas

| Funcionalidad | Evidencia pública de Caldén | Estado real de Fierro | Brecha | Importancia comercial | Compl. | Prioridad |
|---|---|---|---|---|---|---|
| **Saldo de apertura de clientes** (migrar deudas de cuentas corrientes) | — (no se observó cómo lo resuelve Caldén) | NO existe documento de apertura de clientes (sí de proveedores, caja y bancos) | Un taller que migra no puede cargar lo que le deben sin crear ventas ficticias | **Alta** (casi todo taller migrante tiene deudores) | L (cambio financiero extenso; ver 6) | **P0 (abierto)** |
| Exportación de los datos del taller por el propietario | W «Backup y restauración de datos»; Excel/CSV | Solo el operador, con script | El cliente depende de nosotros para llevarse sus datos | Alta (confianza, portabilidad) | M | **P1** |
| Cierre de períodos contables | O §20 «cierres»; M «ejercicios contables» | Se puede cargar o anular con fecha pasada; no hay cierre | El resultado de períodos ya informados puede cambiar | Media-Alta | M | **P1** |
| Check-list ampliado con **fotos y firma** | O §2: 6 pestañas (exterior, interior, accesorios, combustible, mecánica, final), «sin fotos ni firma» | 4 grupos + combustible/km; sin fotos ni firma | Menos detalle de recepción; sin respaldo visual ante reclamos | Alta (reclamos por daños) | L (adjuntos requieren almacenamiento de archivos) | **P1** |
| Avisos automáticos de mantenimiento y turnos | W recordatorios automáticos por WhatsApp; O §8 «vencidos por km/fecha» sin envío visible | Lista de vencidos + enlace `wa.me` manual | El taller debe acordarse de avisar | Alta (recompra) | L (WhatsApp API o correo; ver D) | **P1** |
| Notificaciones / campana de novedades | W | No existe | Sin centro de avisos internos | Media | M | **P2** |
| Orden de pago contra **facturas elegidas** | W «órdenes de pago que cancelan varias facturas»; O §17 | Imputa al más antiguo | No se puede decidir qué factura se cancela | Media | M | **P2** |
| Ficha técnica por **variante** (motor, transmisión, aceite, litros, filtros) | W; O §9 | Marcas y modelos con `motor`/notas | Sin datos de servicio por variante (clave para el cambio de aceite) | Media-Alta | M | **P2** |
| Remitos internos (transferencias) imprimibles, con estado «en tránsito» | W «depósitos múltiples… con remitos internos»; O §18 | Transferencia inmediata sin comprobante | Falta el papel que acompaña la mercadería entre sucursales | Media (solo con varias sucursales) | M | **P2** |
| Notas de débito a clientes | W; O §15 (comprobante Nota de débito en prefactura) | No existe (solo notas de crédito internas) | Ajustes de precio/intereses a clientes | Media | M | **P2** |
| Retenciones y más medios de cobro/pago | O §16–17 (11 medios, 5 retenciones) | 6 medios, sin retenciones | Talleres que atienden empresas o flotas | Media | M | **P2** |
| Estadísticas por cliente, cliente × producto y por proveedor | O §7 | 19 informes, sin esos cruces | Análisis comercial más fino | Media | M | **P2** |
| Búsqueda global ampliada (artículos, proveedores, comprobantes) | W; O §22 | Clientes, patentes y N° de OT | Menos productividad | Media | S | **P2** |
| Importación de extracto bancario | M «Fondos: importación de extracto» | Conciliación manual | Más trabajo administrativo | Media | L | **P2** |
| Lectura de códigos de barras con cámara | W «cámara o lector USB» | Solo lector/teclado | Taller sin lector no puede usar la cámara del celular | Media | S–M | **P2** |
| Multimoneda (ARS/USD con cotización) | W; O §21 | NO existe | Talleres que compran en dólares | Media-Baja | XL | **P2** |
| Configuración de módulos activables | W | Solo por permisos | No se puede empaquetar por plan | Media (comercial) | M | **P2** |
| Informes en Excel (.xlsx) | W; O §22 | CSV y PDF por impresión | Preferencia del administrador | Media | S–M | **P2** |
| Pantalla de «auditoría» de inconsistencias unificada | W «detección de registros huérfanos»; O §21 | Controles dispersos (contables, cuentas, stock) | Falta un único lugar | Baja-Media | M | **P2** |
| Sueldos: legajos, liquidación, recibos | W «Sueldos»; M (módulo con 59 funciones) | NO existe | Mucha complejidad legal; no hay evidencia de que el taller promedio lo use dentro del producto Taller | Media-Baja | XL | **P3** |
| Carga de facturas por OCR | W; O §17 | NO existe | Comodidad de carga | Baja | L (servicio externo) | **P3** |
| Chequeras, préstamos y leasing | M «Fondos» | NO existe | Administración financiera avanzada | Baja | L | **P3** |
| Lotes y números de serie | — | NO existe | Repuestos trazables | Baja | L | **P3** |
| Remitos de venta / entrega | M «Ventas: remitos» | NO existe | Circuitos factura-remito | Baja (taller) | M | **P3** |
| Tutoriales, ayuda en la aplicación | W «tutoriales… chat de ayuda con IA» | Solo el asistente de puesta en marcha | Menos autonomía del cliente | Baja-Media | M | **P3** |
| Modo oscuro | W | NO existe | Preferencia | Baja | S | **P3** |
| Gráficos del estado de resultados | W | Indicadores y tablas | Presentación | Baja | S | **P3** |

### 4.B Errores o inconsistencias existentes en Fierro

| Hallazgo | Evidencia | Estado | Brecha / riesgo | Importancia | Compl. | Prioridad |
|---|---|---|---|---|---|---|
| **Consultar Contabilidad generaba asientos** (un `GET` escribía) | `lib/contab/sync.ts`, `modules/contabilidad.ts` (hasta el Sprint 11) | **RESUELTO en el Sprint 12** (ver 6.A) | Escrituras silenciosas, frágiles ante lecturas concurrentes | Alta | M | **P0 ✔** |
| Verificación online podía disparar esa escritura | `scripts/verificar-online.mjs` | **RESUELTO**: no activa ni sincroniza; comprueba que consultar no cambia nada | Una «verificación de solo lectura» que escribía | Media | S | **P0 ✔** |
| Sin saldos de apertura de proveedores | — | **RESUELTO** (`aperturas`) | Deudas anteriores solo como compras ficticias | Alta | M | **P0 ✔** |
| **Sin copias de respaldo programadas ni fuera de Cloudflare** | `docs/RESPALDOS.md` | **ABIERTO** | Un incidente de cuenta o un olvido del operador no es recuperable | **Alta** | M (+ decisión) | **P0 (abierto)** |
| **Capacidad no medida** (CPU del login con PBKDF2, límites de D1, lecturas por operación) | `docs/PROGRESO.md` §5 riesgos 1–2 | **ABIERTO** | No hay evidencia de que 100 talleres funcionen bien | Alta | M | **P0 (abierto, de evidencia)** |
| Saldos de apertura de clientes | ver 4.A | ABIERTO | — | Alta | L | **P0 (abierto)** |
| La contabilización por operación relee todos los documentos del taller (costo O(n) por operación) | `lib/contab/sync.ts` (`pendientes` de cada fuente) | **NUEVO, ABIERTO** | Con talleres grandes sube el costo de lecturas de D1 y la latencia en segundo plano | Media-Alta | M | **P1** (contabilización incremental) |
| Bloqueo de login solo por usuario (no por origen) | `docs/PROGRESO.md` §5 riesgo 6, `lib/auth.ts` | ABIERTO | Se puede bloquear a un usuario a propósito; sin freno por IP | Media | S–M | **P1** |
| Sin recuperación de contraseña por correo | — | ABIERTO | Carga de soporte | Media | M (correo, ver D) | **P1** |
| Sin pruebas automatizadas de interfaz | `docs/PROGRESO.md` | ABIERTO | Una regresión visual llega a producción | Media | M | **P1** |
| Búsquedas con `LIKE '%…%'` sin índice | `docs/PROGRESO.md` §5 riesgo 5 | ABIERTO | Lentitud con miles de registros | Media | M | **P2** |
| Valorización al último costo | `lib/stock.ts`, controles contables | ABIERTO (limitación) | Diferencias por cambios de costo | Media | L | **P2** |
| Transferencias de stock sin estado «en tránsito» | `depositos.ts` | ABIERTO (limitación) | Mercadería «perdida» entre sucursales | Baja-Media | M | **P2** |
| Auditoría de actividad: solo 200 eventos, sin filtros | `taller.ts` `/auditoria` | ABIERTO | Difícil reconstruir un hecho antiguo | Media | S | **P2** |
| Cuentas bancarias en dólares sin contabilizar | `lib/contab/fuentes.ts` | ABIERTO (limitación) | Balance incompleto con cuentas en USD | Baja-Media | L | **P2** |
| Zona horaria de las fechas comerciales fija en UTC-3 | `lib/db.ts` `hoy()` | ABIERTO | Solo Argentina | Baja | S | **P3** |

### 4.C Mejoras de experiencia de usuario

| Mejora | Evidencia de referencia | Estado de Fierro | Prioridad |
|---|---|---|---|
| Atajos de teclado y pantalla de venta rápida (F2/F4) | O §14 | Venta de mostrador sin atajos | P2 |
| Check-list por pestañas con ayudas visuales | O §2 | Formulario único | P2 |
| Filtros por defecto que no ocultan el historial | O §5 («Hoy» oculta todo) — lo que **no** hay que copiar | Fierro lista por estado/período sin ocultar | — |
| Avisos de cuántos pasos de configuración faltan | — | Ya existe (asistente) | ✔ |
| Estado de la contabilidad visible (activada/al día/pendientes) | — | **Nuevo en el Sprint 12** | ✔ |
| Modo oscuro | W | No existe | P3 |
| Tutoriales contextuales | W | No existen | P3 |

### 4.D Integraciones externas (todas fuera de alcance de estos sprints salvo autorización expresa)

| Integración | Evidencia de Caldén | Estado de Fierro | Importancia comercial | Compl. | Prioridad / decisión |
|---|---|---|---|---|---|
| **ARCA/AFIP: factura electrónica (WSAA/WSFE, CAE), A/B/C, NC/ND** | W; O §15 y §21 (configuración, certificado, ambiente, probar conexión) | Comprobante interno «no válido como factura»; el modelo de datos está preparado | **Muy alta**: es lo que decide la compra de un sistema de gestión en Argentina | XL | **P1 comercial — requiere autorización** (la instrucción vigente la excluye) |
| ARCA Padrón A5 (CUIT → razón social, domicilio, IVA) | W; O §10 | No existe | Media | M | P2, depende de ARCA |
| Libro IVA Digital, TXT RG 4597, CITI | W; M | Libros IVA internos en CSV | Alta (si factura con ARCA) | L | P2, depende de ARCA |
| Mercado Pago (links de cobro) | W | No existe | Media | M | P3 — **no se incorporan funciones de pago sin autorización** |
| WhatsApp (envío de recordatorios) | W | Solo enlaces `wa.me` | Alta | L | P1 (ver 4.A) — requiere proveedor externo |
| Correo transaccional (recuperar contraseña, avisos) | W «reseteo por email» | No existe | Media | M | P1 — requiere proveedor externo |
| Almacenamiento de archivos (fotos del check-list, logo grande) | O §2 | Sin archivos más allá del logo | Media | M | P1 (con el check-list) |
| OCR de facturas | W; O §17 | No existe | Baja | L | P3 |
| Posnet, lector de huellas, reloj electrónico | M | No existe | Baja | M–L | P3 |

---

## 5. Lo que Fierro ya hace igual o mejor (verificado en código y pruebas)

- **Aislamiento entre talleres garantizado por la base** (claves foráneas compuestas `(taller_id, id)`), no solo por la aplicación: ningún registro de un taller puede referenciar otro (`seguridad`, `migraciones`, y una prueba de aislamiento en cada suite).
- **Stock sin negativos** y descuento **una sola vez** por consumo; el comprobante de una OT **no** vuelve a descontar (`flujo`, `depositos`).
- **Contabilidad derivada de las operaciones**, idempotente, con anulaciones por contra-asiento, triggers que impiden asientos desbalanceados o modificar lo registrado, y controles contra caja, bancos, cuentas corrientes e inventario (`contabilidad`, `sync-contable`).
- **Permisos granulares** y auditoría de exportaciones.
- **Puesta en marcha autónoma**: invitación de un solo uso, asistente de 9 pasos e importación con revisión previa (`activacion`, `puesta`, `importacion`).

Nada de esto implica que un cliente real lo perciba así: es lo verificable.

---

## 6. P0 de este sprint

### 6.A Sincronización contable — **resuelto**

**Antes:** abrir cualquier pantalla de Contabilidad ejecutaba el proceso que crea asientos pendientes (un `GET` que escribía).

**Ahora:**
- Los `GET` contables **solo leen**. Si la contabilidad no está activada responden `409 contabilidad_no_activada`; no se crea ninguna cuenta, asiento ni corrida (probado comparando el contenido de la base antes y después en `tests/api/sync-contable.test.ts`).
- **Activación explícita** (`POST /contabilidad/activar`, permiso `contabilidad.gestionar`, botón en Contabilidad › Activación con vista previa de lo que se generará): crea el plan y contabiliza **una sola vez** lo ya operado, como asientos *históricos* con la fecha original. Es idempotente y reanudable por tandas.
- **Mantenimiento automático:** después de cada operación comercial exitosa (ventas, cobros, anticipos, devoluciones, compras, pagos, gastos, caja, bancos, cheques, stock, órdenes, aperturas, importaciones) un middleware contabiliza lo nuevo, **solo en talleres activados**, en segundo plano (`waitUntil`) y sin alterar jamás la respuesta de la operación. Un bloqueo con vencimiento por taller evita procesos simultáneos; si llega una operación mientras otro proceso corre, se deja un pedido y el proceso en curso repite.
- **Estado visible:** `GET /contabilidad/estado` y un aviso en pantalla muestran si está activada, al día, qué origen tiene pendientes, errores, si hay un proceso corriendo y el último error. «Actualizar ahora» (`POST /contabilidad/sincronizar`) sigue disponible.
- **Sin duplicar ni perder:** índice único `(taller, origen, id, evento)` (como antes); 6 operaciones simultáneas producen exactamente 6 asientos con numeración correlativa; un proceso caído no bloquea para siempre (el bloqueo vence a los 90 s). Los comprobantes originales no se modifican.
- Se detectó y corrigió además un error propio durante las pruebas (un alias SQL que repetía el alta de una fuente nueva en cada pasada): ahora hay una advertencia en el código y la prueba de anulación lo cubre.

**Límite conocido:** el costo de la pasada crece con la cantidad de documentos del taller (ver 4.B). Se mantiene correcto y acotado; la contabilización incremental queda como P1.

### 6.B Saldos de apertura — **proveedores resueltos; clientes abiertos**

| Rubro | Estado | Cómo se carga | Contabilidad |
|---|---|---|---|
| Caja | Ya existía | Efectivo inicial al abrir la primera caja | Contra *Saldos iniciales y ajustes de apertura* (patrimonio) |
| Bancos | Ya existía | Saldo inicial y fecha al crear cada cuenta | Ídem (las cuentas en USD no se contabilizan) |
| Inventario | Ya existía | Stock inicial valorizado (al crear el artículo o con la importación «Existencias iniciales») | Contra *Entradas de mercadería sin compra (a clasificar)* (patrimonio) |
| **Proveedores** | **Nuevo (Sprint 12)** | Administración › Apertura de saldos (tipeado o Excel/CSV), con revisión previa | Debe *Saldos iniciales* / Haber *Proveedores*: **patrimonio, no resultados** |
| **Clientes** | **ABIERTO** | — | — |

**Propiedades de la apertura de proveedores** (`tests/api/aperturas.test.ts`, 18 pruebas): fecha de corte, sistema de origen, usuario y fecha de carga conservados; una sola apertura vigente por proveedor (índice único: reintentar, cargar dos veces o hacerlo en simultáneo no duplica la deuda); vista previa **sin escribir**; avisos si el proveedor ya tiene compras o pagos anteriores al corte (el saldo de apertura se *suma* a lo registrado, hay que confirmarlo); saldos a favor admitidos; queda en la cuenta corriente, en vencimientos y en la deuda total; se paga con los pagos de siempre y no admite pagar más de lo debido; **no crea compras, stock ni ventas ni toca el estado de resultados**; no se edita ni se borra (la base lo impide), se anula —y solo si no tiene pagos aplicados— con contra-asiento; aislada por taller. Cuando el origen es incompleto, la pantalla lo informa (filas con error o aviso, motivo por fila) y no guarda hasta que se corrija o confirme.

**Por qué los saldos de clientes NO se hicieron ahora (cambio financiero extenso):** un saldo inicial de cliente tiene que poder **cobrarse**, y hoy los cobros se aplican a comprobantes (`ventas`). Hay **61 consultas** sobre `ventas` en 15 archivos del servidor, 10 sobre `cobro_aplicaciones` y 16 sobre `credito_aplicaciones`: todas las de ingresos, estadísticas, IVA y rentabilidad tendrían que excluir el saldo, y todas las de deuda, cobranza y antigüedad incluirlo. Hacerlo a medias dejaría estadísticas o saldos inconsistentes (lo contrario de lo pedido).

**Diseño propuesto (siguiente sprint contable):** tabla `deudas_apertura` (cliente, fecha de corte, importe, vencimiento, referencia, usuario) sin pasar por `ventas`; `cobro_aplicaciones` y `credito_aplicaciones` pasan a admitir como destino un comprobante **o** una deuda de apertura (reconstrucción de tabla con prueba sobre datos previos); un único componente de saldo (`saldoCliente`) que unifica comprobantes + aperturas para cuentas corrientes, deudores, dashboard y límites; contabilidad Debe *Deudores* / Haber *Saldos iniciales* (patrimonio) y control «Deudores = cuentas corrientes» ampliado; importador de saldos de clientes con la misma revisión previa. **Dependencia:** conviene hacerlo antes de incorporar ARCA, que tocará los mismos comprobantes.

### 6.C Verificación online — **mejorada; ejecución con credenciales a cargo del propietario**

`npm run verificar:online` (solo lectura, sin imprimir credenciales) ahora: bloquea en el propio script cualquier pedido que no sea `GET` salvo iniciar/cerrar sesión, la validación previa de importaciones y una consulta de activación con un enlace inventado; **no activa ni sincroniza la contabilidad**; si está activada, comprueba que **consultarla no cambia nada** (mismos asientos, misma última sincronización); verifica login, permisos y navegación (por rol, incluido un usuario limitado opcional), clientes, vehículos, OT, inventario (stock por depósito, negativos, valorizado), cuentas corrientes y aislamiento multiempresa con un segundo taller (opcional). Variables: `FIERRO_URL`, `FIERRO_EMAIL`/`FIERRO_PASSWORD` y, opcionalmente, `…_B` (otro taller) y `…_C` (rol limitado).

Se ejecutó completo contra una instancia local aislada con tres usuarios y dos talleres (88/88 con la contabilidad sin activar y 91/91 activada). **Contra producción** se verificó sin sesión (sección de despliegue del Sprint 12 en `PROGRESO.md`); la parte autenticada **no la corrí yo**: autenticarme con contraseñas en un sitio que no está marcado como entorno de ensayo no está permitido en esta sesión y el entorno no tiene las variables definidas.

### 6.D Respaldos y recuperación — ver `docs/RESPALDOS.md`

---

## 7. Plan para cerrar lo pendiente (ordenado)

**Sprint 13 — Continuidad y seguridad operativa (cierra los P0 abiertos de evidencia y recuperación)**
1. Prueba de capacidad: medir CPU del login (PBKDF2), filas leídas/escritas por operación y por pasada contable en D1 real, y proyectar a 100 talleres; decidir plan de Cloudflare. *(P0 de evidencia)*
2. Respaldos programados y verificados + copia cifrada fuera de Cloudflare *(requiere decisión y, según el servicio, autorización)*.
3. Contabilización incremental (marca de agua por origen) para que el costo no crezca con el historial. *(P1)*
4. Límite de intentos de login por origen además de por usuario. *(P1)*
5. Exportación de datos del taller por el propietario (`datos.exportar`). *(P1)*
6. Cierre de períodos contables. *(P1)*

**Sprint 14 — Saldos de clientes y cuentas corrientes unificadas** (diseño de 6.B). *(P0 abierto)*

**Sprint 15 — Recepción y comunicación con el cliente** *(P1/P2)*: check-list ampliado con fotos y firma, acta de entrega, ficha técnica por variante, recordatorios (correo o WhatsApp según autorización), notificaciones internas, recuperación de contraseña.

**Sprint 16 — Administración comercial** *(P2)*: orden de pago contra facturas elegidas, retenciones, estadísticas por cliente/proveedor, búsqueda global ampliada, Excel, notas de débito, remitos internos imprimibles, lectura por cámara.

**Sprint 17+ — Decisiones de producto** *(según autorización)*: ARCA (factura electrónica, padrón, libros), multimoneda, módulos activables, extracto bancario, sueldos.

Pruebas de interfaz automatizadas (humo de las pantallas críticas) se incorporan desde el Sprint 13 y crecen con cada sprint.

---

## 8. Lo que **no** se puede afirmar todavía (sobre «100 talleres»)

Fierro **no está demostrado** para 100 talleres. Falta evidencia de:

1. **Capacidad:** no hay medición de CPU por solicitud en Cloudflare (login con PBKDF2 de 100.000 iteraciones), de filas leídas/escritas en D1 por taller y por día, ni de latencia con datos de varios años y muchos talleres compartiendo una base.
2. **Continuidad:** no hay copias programadas ni fuera de la cuenta (sección 6.D).
3. **Operación de soporte:** el alta es por línea de comandos; la recuperación de contraseña y la restauración por taller dependen del operador.
4. **Cumplimiento:** no emite comprobantes fiscales (decisión de alcance).
5. **Interfaz:** no hay pruebas automatizadas de pantallas; la verificación visual fue manual y acotada.

Lo que sí está respaldado por evidencia: 440 pruebas automáticas (96 unitarias y 344 de integración, con aislamiento entre talleres, concurrencia, idempotencia y migraciones sobre datos previos), una verificación online sin sesión de la versión publicada y los controles de consistencia contables y operativos.

---

## 9. Trazabilidad de este documento

- Fierro: lectura de `worker/modules/*`, `src/pages/*`, `shared/*`, `migrations/*` y las pruebas `tests/api/*` el 22/10/2026.
- Caldén: páginas públicas [Taller Mecánico](https://www.caldensistemas.com/productos/calden-taller-mecanico), [Ventas](https://www.caldensistemas.com/modulos/ventas), [Compras](https://www.caldensistemas.com/modulos/compras), [Stock](https://www.caldensistemas.com/modulos/stock), [Fondos](https://www.caldensistemas.com/modulos/fondos), [Contabilidad](https://www.caldensistemas.com/modulos/contabilidad) y [Sueldos](https://www.caldensistemas.com/modulos/sueldos) (22/10/2026) y la auditoría previa `docs/auditoria/` (19/10/2026).
- No se contrató, probó ni accedió a ninguna instalación de Caldén en este sprint.
