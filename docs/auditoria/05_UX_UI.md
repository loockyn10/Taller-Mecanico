# 05 — Análisis UX/UI

Las capturas se tomaron durante la auditoría y no se guardaron como archivos. Las descripciones que siguen se basan en ellas y en el DOM.

## 1. Lenguaje visual (OBS)
- **Estilo**: SaaS moderno. Sidebar oscuro fijo y contenido claro u oscuro (con selector de tema). Color de acento rojo (marca), verde para acciones positivas en el Dashboard. Tipografía de títulos condensada, deportiva. Banner del Dashboard con un auto de competición.
- **Base técnica** (INF por clases del DOM): React + Tailwind + componentes Radix/shadcn (Dialog, Select, Tabs, Toast) + íconos Lucide.
- **Densidad**: media-alta. Formularios largos dentro de modales con scroll interno.

## 2. Navegación
| Elemento | Observación | Valoración |
|---|---|---|
| Sidebar agrupado (General, Operación, Administración, Sistema) con submenús en acordeón | ~50 entradas | ✅ ordenado · ❌ abrumador para un taller chico |
| "Buscar módulo..." en el sidebar | Filtra el menú | ✅ buena idea dada la cantidad de pantallas |
| Buscador global ⌘K | Clientes y OTs por nombre o patente | ✅ muy útil · ❌ muestra el estado sin traducir ("completed") |
| Breadcrumb | Solo en el Dashboard y la ficha técnica | ⚠️ inconsistente |
| Accesos rápidos del Dashboard | 6 botones de acción | ✅ |
| Rutas inaccesibles | "Mecánicos" redirige al Dashboard sin aviso | ❌ debería mostrar "sin permisos" o no figurar en el menú |
| Botón "Actualizar sistema" | Recarga la versión | ⚠️ expone un detalle técnico al usuario |

## 3. Componentes reutilizables identificados
- **Page header**: ícono + título + subtítulo + acción primaria a la derecha (rojo).
- **Barra de filtros**: botones-chip de estado + chips de período + rango de fechas, o selects.
- **KPI cards**: número grande + etiqueta + ícono en un cuadro de color.
- **Tablas**: encabezado gris en mayúsculas, acciones con íconos (sin texto; tooltip con `title`), badges de estado en forma de píldora.
- **Tarjetas acordeón**: clientes, CC, historia clínica (cliente → vehículo → ingresos).
- **Grilla de tarjetas**: marcas, modelos, listas de precios.
- **Modales**: alta y edición de todo (OT, presupuesto, cliente, producto…), con sub-modales anidados (Nuevo Cliente dentro de Nueva OT).
- **Combobox con búsqueda** para cliente, artículo y cuenta contable.
- **Botón con menú** (servicios por categoría): una forma rápida de cargar mano de obra.
- **Tabs** en el check-list, la contabilidad y los bancos.
- **Toasts** de notificación.
- **Estados vacíos** con ícono + texto + llamado a la acción ("No hay órdenes activas · Crear orden de trabajo").

## 4. Formularios
✅ Bien resuelto
- Autocompletado de cliente y artículo (por nombre, SKU, EAN o código de proveedor) dentro del mismo formulario.
- Alta en línea de cliente, vehículo y artículo sin salir de la OT.
- Totales en vivo con desglose (artículos, servicios, neto, IVA, recargo).
- Textos de ayuda contextuales ("no puede ser menor al último km…").
- Catálogo de servicios con precio en 2 clics.
- Asterisco en los campos obligatorios.

❌ Mejorable
- Modal de OT muy largo (cliente, vehículo, mecánico, artículos, ~20 categorías de servicio, observaciones, totales): obliga a mucho scroll. Mejor una página completa o un asistente por pasos.
- ~20 botones de categoría, algunos duplicados (Service Motor, Caja y Diferencial aparecen dos veces): ruido visual.
- Inconsistencia entre la OT (patente libre) y el presupuesto (vehículo registrado obligatorio).
- En el turno, el cliente es texto libre: no queda vinculado a la ficha.
- Campos de cuentas contables visibles en el alta de cliente y producto: carga cognitiva innecesaria para un mecánico.
- No hay fotos ni firma en el check-list, algo muy valorado en recepción.

## 5. Tablas y listados
- ❌ **Filtros por defecto que esconden datos**: Presupuestos arranca en "Hoy" (lista vacía aunque hay 26), OT en "Pendientes/En progreso" y el inventario no muestra nada hasta filtrar. Un usuario nuevo puede creer que perdió datos.
- ❌ El inventario no muestra precio de venta ni costo en el listado.
- ✅ Íconos de acción con tooltip; el botón deshabilitado explica el motivo ("No se puede eliminar: tiene factura asociada").
- ⚠️ Acciones solo con íconos: poco descubribles en pantallas táctiles.

## 6. Indicadores de estado
- Píldoras: Completada, Aprobado, Pendiente, Vencido, Emitida, Cobrada, "Parcial · resta $X", Pagada, Activa, Predeterminada.
- Cronómetro del mecánico en la fila de la OT ("Pausada · 0h 1m").
- Alertas de stock bajo y de service vencido en rojo.
- Banner amarillo con "presupuestos aprobados sin agendar".

## 7. Responsive
- **No verificado**: no se pudo redimensionar la ventana del navegador. Existe un botón "Abrir menú" (INF: sidebar en drawer en pantallas chicas). Por las tablas anchas (8–10 columnas), INF: en móvil habrá scroll horizontal.

## 8. Rendimiento percibido
- La mayoría de las pantallas cargan en menos de 2 s; Caja Diaria tardó ~5 s (spinner).
- Contabilidad no abrió la pestaña indicada por el hash (`#libro-iva`).

## 9. Experiencia general
**Fortalezas**: cobertura enorme, flujo presupuesto → OT → prefactura → cobro bien encadenado, catálogo de servicios con precios, historia clínica por vehículo, check-list completo, buscador global.

**Debilidades para un taller chico**: demasiados módulos de ERP (contabilidad, cheques, eCheq, conciliación bancaria, gastos fijos, libro IVA) que un taller de 1 a 5 personas no usa; terminología contable; filtros por defecto confusos; inconsistencias de datos (patente libre, cliente libre en la agenda, posible doble descuento de stock).

## 10. Recomendaciones para nuestra interfaz
1. **Pocas secciones**: Inicio, Agenda, Órdenes, Presupuestos, Clientes y vehículos, Stock, Caja, Reportes, Configuración. Máximo 9 entradas, sin submenús.
2. **OT como pantalla completa** con 3 bloques: Vehículo y cliente | Trabajos y repuestos | Totales y cobro, con barra de acciones fija (Guardar, Cambiar estado, PDF, WhatsApp).
3. **Tablero tipo Kanban de OT** (Ingresado → En reparación → Esperando repuesto → Listo → Entregado). Es la vista más natural para un taller y no existe en Caldén.
4. **Patente como identificador primario**: buscar por patente desde cualquier lugar y abrir la ficha del vehículo con su historial.
5. Filtros por defecto que **muestren datos** (últimos 30 días, todos los estados abiertos).
6. Botones con texto en las acciones principales; íconos solo en las secundarias.
7. Check-list con **fotos desde el celular** y firma, en una fase 2.
8. Diseño responsive real: en móvil, tarjetas en lugar de tablas, para que el mecánico consulte la OT desde el teléfono.
9. Tema claro por defecto, alto contraste y botones grandes (uso con manos sucias o pantalla táctil).
10. Ocultar lo fiscal y contable: en el MVP no existe.
