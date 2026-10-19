# 08 — Plan de implementación: "Taller Esencial"

Stack: **Tauri 2 + React + TypeScript + Vite + Tailwind/shadcn + SQLite** (ver 06).
Producto: aplicación de escritorio para Windows, un puesto, offline, con backup automático.

## Alcance
| Fase | Contenido | Horas | Entregable |
|---|---|---|---|
| **Fase 1 — Núcleo** (los "2 días") | Base, clientes, vehículos, catálogo de servicios, artículos simples, OT con totales y estados, PDF, historial por patente, backup | ~20 h | Instalador usable para registrar y cobrar trabajos |
| **Fase 2 — Esencial** | Presupuestos y conversión a OT, stock con movimientos, pagos y saldo, check-list, agenda, recordatorios de service, WhatsApp, reportes, exportar CSV, importar artículos | ~35 h | Producto completo para la venta |
| **QA y entrega** | Tests de cálculo, prueba E2E guiada, datos semilla, instalador, capacitación | ~8–10 h | Instalador final + manual de 2 páginas |
| **Total** | | **~63–65 h** | |

## Fase 1 — Núcleo (~20 h)

### Bloque 1 · Proyecto y base (4 h)
- [ ] `npm create tauri-app` (React + TS), Tailwind, shadcn/ui, React Router, TanStack Query, RHF + Zod.
- [ ] `tauri-plugin-sql` (SQLite) + runner de migraciones (`001_init.sql`) con todas las tablas de 04-B.
- [ ] Capa `data/` con repositorios tipados (interfaz por entidad).
- [ ] Layout: sidebar (Inicio, Órdenes, Clientes, Catálogo, Stock, Reportes, Configuración), header con buscador ⌘K por patente, cliente o N° de OT.
- [ ] Configuración de la empresa (nombre, CUIT, dirección, teléfono, logo, recargo por defecto, pie de documentos).
- **Hecho cuando**: la app abre, crea la base y guarda la configuración.

### Bloque 2 · Clientes y vehículos (3 h)
- [ ] Listado con búsqueda (nombre, teléfono, patente), alta y edición en un panel lateral, baja lógica.
- [ ] Vehículos dentro del cliente: patente normalizada y única, marca, modelo (autocompletado de lo ya cargado), año, chasis, km.
- [ ] Ficha de vehículo: datos + historial de OT.
- **Validaciones**: nombre obligatorio, patente única, año en rango, email válido.

### Bloque 3 · Catálogo (3 h)
- [ ] Categorías de servicio + servicios (nombre, precio, tipo de vehículo, intervalo km y meses).
- [ ] Ajuste masivo de precios por % y categoría, con redondeo.
- [ ] Artículos: código, nombre, marca, categoría, costo, precio (manual o costo + margen), IVA, stock, mínimo, ubicación.
- [ ] Datos semilla: ~20 servicios típicos (service motor, pastillas, distribución…).

### Bloque 4 · Orden de trabajo (7 h)
- [ ] `domain/totales.ts`: función pura para el cálculo (líneas con desc%, descuento global % o monto, IVA, recargo sobre el neto, redondeo a 2 decimales) + **tests con Vitest** (incluye el caso verificado en Caldén: 15.400 + 343.200 → IVA 21% 75.306 → recargo 3% 10.758).
- [ ] Pantalla OT (página completa, no modal): cliente y vehículo (buscar por patente o crear en línea), km (≥ último), mecánico, falla reportada.
- [ ] Líneas: buscar artículo (nombre o código) o servicio (por categoría), línea libre; cantidad, precio, desc%.
- [ ] Estados: Ingresado → En reparación → Esperando repuesto → Listo → Entregado | Cancelado.
- [ ] Listado de OT con vista **Kanban** por estado y vista de tabla con filtros (por defecto, todas las abiertas).
- [ ] Al pasar a "Entregado", actualizar el km del vehículo.

### Bloque 5 · Documentos y backup (3 h)
- [ ] Vista imprimible de la OT (con precios) y orden para el mecánico (sin precios) → imprimir o guardar PDF.
- [ ] Backup: comando Tauri `VACUUM INTO`, carpeta configurable, automático cada 24 h, rotación de 30 copias, botones "Respaldar ahora" y "Restaurar".
- **Hecho cuando**: se puede atender un auto de punta a punta e imprimir la orden, y el backup existe en disco.

## Fase 2 — Esencial (~35 h)

| Bloque | Tareas | h |
|---|---|---|
| 6 · Presupuestos | Mismo editor que la OT (componente compartido), válido hasta, estados (pendiente, aprobado, rechazado, vencido, convertido), "Convertir a OT" (copia líneas y congela precios), imprimir | 6 |
| 7 · Stock | Movimientos (entrada, salida, ajuste) con stock anterior y nuevo; **descuento único al pasar la OT a "Listo"** (reversible si vuelve atrás); alerta de stock bajo; listado con filtros; importar artículos desde CSV | 6 |
| 8 · Pagos | Pagos por OT (varios medios, parciales), saldo, estado de cobro; listado de clientes con saldo (cuenta corriente simple); recibo imprimible | 5 |
| 9 · Check-list | Una pantalla: daños (casillas), combustible, testigos, accesorios, observaciones, "recibido por"; se imprime con la OT | 3 |
| 10 · Agenda | Calendario semanal y mensual, turno vinculado a cliente, vehículo y presupuesto; estados; "convertir turno en OT" | 5 |
| 11 · Recordatorios de service | Calcular el próximo service por km y fecha según los servicios realizados; pantalla "Próximos y vencidos"; botón WhatsApp con mensaje armado | 4 |
| 12 · WhatsApp | Enlaces `wa.me` para presupuesto, OT lista para retirar y recordatorio (texto + total; el PDF se adjunta manualmente) | 2 |
| 13 · Inicio y reportes | Dashboard (OT por estado, turnos de hoy, stock bajo, cobros del día); reportes: ventas por período y medio de pago, servicios más vendidos, saldos de clientes; exportar CSV | 4 |

## QA y entrega (~8–10 h)
- [ ] Tests unitarios: totales, vencimiento de presupuesto, próximo service, stock (descuento y reversión).
- [ ] Recorrido E2E manual con checklist: cliente → vehículo → presupuesto → aprobar → turno → OT → check-list → listo (stock) → cobro parcial → cobro total → entregado → historial → recordatorio.
- [ ] Prueba de backup y restauración en otra PC.
- [ ] Build `.msi`, prueba de instalación limpia en Windows 10 y 11 (advertencia de SmartScreen documentada).
- [ ] Manual de 2 páginas + capacitación de 1 h + carga inicial (servicios del cliente).

## Orden de ejecución y puntos de control
1. Fin del bloque 4 → **demo interna**: ¿el flujo de la OT se entiende sin explicación?
2. Fin de la Fase 1 → entrega parcial opcional al cliente (instalable).
3. Fin del bloque 8 → congelar el alcance. Cualquier pedido nuevo va a "Fase 3, cotización aparte".
4. Entrega final → firma de conformidad y comienzo de la garantía de 30 días.

## Fase 3 (futuro, cotizar aparte)
Facturación electrónica ARCA · acceso móvil o multi-PC (migrar el repositorio a Supabase) · fotos y firma en el check-list · horas por mecánico y comisiones · compras y proveedores · usuarios con roles · actualizaciones automáticas firmadas.

## Instrucciones para ejecutar con IA (cuando se apruebe)
- Trabajar bloque por bloque, con commit por bloque y tests de `domain/` antes de la UI.
- Mantener toda la lógica de dinero en `domain/` (funciones puras), nunca en los componentes.
- Montos en enteros de centavos o `decimal` con redondeo explícito a 2 decimales.
- Cada pantalla nueva debe tener estado vacío, de carga y de error.
