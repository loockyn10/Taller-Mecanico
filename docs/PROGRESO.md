# Progreso del desarrollo · Fierro v0.1.0

Última actualización: 2026-10-20 (ver la sección 8 en adelante: expansión funcional 01). Documento para retomar el trabajo en nuevas sesiones.

## 1. Arquitectura implementada
- **Un único Worker** (`worker/index.ts`, Hono) sirve la API en `/api/*` y la SPA compilada (assets estáticos). En desarrollo, Vite sirve la SPA y redirige `/api` a `wrangler dev`.
- **D1 multiempresa en una sola base**: todas las tablas de negocio tienen `taller_id`. Las relaciones usan **claves foráneas compuestas `(taller_id, x_id)`** contra `UNIQUE(taller_id, id)`: la propia base impide vincular, por ejemplo, una OT con un vehículo de otro taller.
- **El taller sale siempre de la sesión** (`requireAuth`), nunca de la solicitud. Todas las consultas filtran por `taller_id`. Un ID de otro taller devuelve 404, no 403, para no revelar su existencia.
- **Sesiones**: token aleatorio de 256 bits en cookie `HttpOnly; SameSite=Lax; Secure` (salvo localhost). En la base se guarda solo el hash SHA-256. Se revocan al cerrar sesión, cambiar la contraseña, cambiar el rol o desactivar al usuario.
- **Contraseñas**: PBKDF2-SHA256 (WebCrypto), 100.000 iteraciones configurables, formato versionado `pbkdf2$iter$salt$hash`. Bloqueo de 15 minutos tras 5 intentos fallidos.
- **CSRF**: las mutaciones exigen `Content-Type: application/json`, y la cookie es SameSite=Lax.
- **Transacciones**: D1 no tiene BEGIN/COMMIT interactivos. Cada operación de varios registros se ejecuta en `db.batch()`, que es atómico. Las condiciones que deben evaluarse dentro de la transacción usan `guard()`, que inserta en `tx_guard` una fila que viola un CHECK si la condición de error se cumple: así se revierte todo el lote (ver `worker/lib/db.ts`).
- **Importes en centavos** (enteros). Un único cálculo de totales en `shared/totals.ts`, compartido por el frontend (vista previa) y el backend (valor autoritativo: el servidor recalcula siempre).
- **Roles**: propietario, administrador, empleado (`shared/permisos.ts`). La API verifica cada permiso; el frontend solo oculta opciones.
- **Licencias**: tabla `licencias` (usuarios incluidos + adicionales, estado). El cupo se verifica dentro del batch con un guard, así que dos altas simultáneas no superan el límite. Con la licencia suspendida, el taller queda en solo lectura. Se administra con la API de plataforma o con `npm run platform`.
- **Separación fiscal**: `ventas` son **comprobantes internos** (`tipo = 'interno'`). La tabla `comprobantes_fiscales` (CAE, tipo, punto de venta) está reservada para ARCA y referencia a la venta; ningún endpoint la escribe todavía. Los cobros se aplican a ventas, de modo que la factura fiscal se podrá agregar sin tocar ventas ni cobros. Los impresos dicen "DOCUMENTO NO VÁLIDO COMO FACTURA".
- **Fechas de negocio** en UTC-3 (Argentina), tanto en el servidor como en las consultas SQL.

## 2. Módulos terminados (funcionan de punta a punta y persisten en D1)
| Módulo | Backend | Frontend | Pruebas |
|---|---|---|---|
| Autenticación, sesiones, cambio de contraseña | ✅ | ✅ Login, Mi cuenta | ✅ |
| Multiempresa + plataforma (alta de talleres, licencias) | ✅ | CLI `npm run platform` | ✅ |
| Usuarios, roles y permisos, cupo de licencia | ✅ | ✅ Configuración → Usuarios | ✅ |
| Configuración del taller y preferencias | ✅ | ✅ | parcial |
| Dashboard | ✅ | ✅ (indicadores financieros solo con permiso) | ✅ |
| Clientes (código correlativo, baja lógica) | ✅ | ✅ lista, ficha, alta rápida | ✅ |
| Vehículos (patente única por taller, km no regresivo) | ✅ | ✅ lista, ficha, historial | ✅ |
| Marcas y modelos (catálogo inicial por taller) | ✅ | ✅ | ✅ |
| Mecánicos | ✅ | ✅ | — |
| Servicios / mano de obra (categorías, intervalos, ajuste masivo) | ✅ | ✅ | ✅ |
| Presupuestos (estados, vencimiento, edición, conversión única a OT) | ✅ | ✅ | ✅ concurrencia |
| Órdenes de trabajo (estados, tablero Kanban, edición con control de versión) | ✅ | ✅ | ✅ |
| Descuento y reposición de stock por OT (una sola vez, idempotente) | ✅ | ✅ | ✅ concurrencia |
| Check-list de ingreso | ✅ | ✅ | ✅ |
| Historial de reparaciones y recordatorios de service (km/meses) | ✅ | ✅ | ✅ |
| Agenda de turnos (vinculada a presupuesto y OT) | ✅ | ✅ semanal | ✅ |
| Artículos, categorías, stock inicial | ✅ | ✅ | ✅ |
| Movimientos de stock (entrada, salida, ajuste por conteo) | ✅ | ✅ | ✅ |
| Proveedores, compras (suman stock y actualizan costo), anulación | ✅ | ✅ | ✅ |
| Pagos a proveedores y cuenta corriente de proveedores | ✅ | ✅ | ✅ |
| Comprobante interno desde OT (uno vigente por OT) | ✅ | ✅ | ✅ concurrencia |
| Venta de mostrador (con cobro inmediato opcional) y anulación | ✅ | ✅ | ✅ |
| Cobros (varios medios, varios comprobantes, parciales, idempotentes, anulación) | ✅ | ✅ | ✅ concurrencia |
| Cuentas corrientes de clientes | ✅ | ✅ | ✅ |
| Estadísticas (ventas por día, medios, top servicios y repuestos, por mecánico) | ✅ | ✅ | ✅ |
| Búsqueda global (Ctrl+K: patente, cliente, N° OT) | ✅ | ✅ | ✅ |
| Impresión / PDF (presupuesto, OT, hoja de taller sin precios, comprobante) | — | ✅ | sin prueba automatizada |
| WhatsApp (enlaces wa.me con mensaje armado) | — | ✅ | — |
| Registro de actividad (auditoría) | ✅ | ✅ | — |
| PWA (manifiesto, íconos, service worker que no cachea `/api`) | — | ✅ | build |

## 3. Módulos pendientes o fuera de alcance de v0.1
- **Facturación electrónica ARCA** (WSAA/WSFE, CAE, notas de crédito). El modelo de datos está preparado; no hay integración.
- Bancos, cheques y eCheq, contabilidad de partida doble: excluidos a propósito (ver la auditoría 07_VIABILIDAD). La caja diaria, los gastos y las listas de precios se implementaron en la expansión 01 (sección 8).
- Multi-depósito y remitos internos.
- Fotos y firma del cliente en el check-list (requiere R2 para archivos).
- Cronómetro y horas por mecánico, comisiones.
- Exportación a Excel/CSV e importación masiva de artículos o clientes.
- Recuperación de contraseña por email (hoy la restablece el propietario o un administrador).
- Aplicación de pagos a proveedores contra facturas específicas; anticipos o saldo a favor de clientes.
- Envío automático de recordatorios (hoy son enlaces de WhatsApp que se abren manualmente).
- Panel web de plataforma (hoy, CLI y API).

## 4. Decisiones técnicas
- **Un Worker para API + SPA**: un solo despliegue, sin CORS y sin costo extra.
- **IDs UUID generados en la API**: permiten insertar padre e hijos en el mismo batch atómico.
- **Numeración correlativa por taller** (`secuencias`): se incrementa dentro del mismo batch que crea el documento.
- **Stock**: solo cambia mediante movimientos (`stock_movimientos` con `idem_key` única). La OT descuenta al pasar a "Lista para entregar" y repone si se reabre. El comprobante generado desde una OT **no** vuelve a descontar (esto evita el doble descuento observado en Caldén).
- **No se puede reabrir una OT con comprobante vigente**: primero se anula el comprobante, y para eso antes hay que anular sus cobros. Así se mantiene la coherencia entre trabajo, deuda y stock.
- **Cobros**: `CHECK (cobrado <= total)` en ventas garantiza a nivel base que nunca se cobra más que el saldo, incluso con solicitudes concurrentes. `idem_key` evita duplicados por doble clic o reintento.
- **Bajas lógicas** en clientes y vehículos para conservar el historial.
- **Sin cachear datos en el service worker**: un dispositivo compartido nunca muestra datos de otro taller o usuario desde la caché.
- **Tailwind 4 con tokens propios** (`src/index.css`) y kit de componentes único (`src/components/ui.tsx`). Identidad visual propia ("Fierro", azul y ámbar), distinta de la referencia.

## 5. Problemas conocidos y riesgos
1. **Límite de CPU del plan gratuito de Workers (10 ms por request)**: PBKDF2 con 100.000 iteraciones probablemente lo supere en el login. No se pudo medir localmente (wrangler dev no aplica ese límite). Antes de producción: medir en Cloudflare. Si falla, bajar `PBKDF2_ITERATIONS` (el formato admite migrar los hashes) o pasar a Workers Paid (USD 5/mes).
2. **Límites de D1 en el plan gratuito** (filas leídas y escritas por día, tamaño por base): suficientes para pocos talleres. Verificar los valores vigentes y monitorear antes de escalar.
3. **No se desplegó a producción**: `database_id` es un marcador en `wrangler.jsonc`.
4. **Vista de impresión**: llama a `window.print()` automáticamente; se compila, pero no se verificó visualmente.
5. **Búsquedas con `LIKE '%…%'`**: no usan índices. Correcto para volúmenes de un taller; revisar con miles de registros.
6. **Rate limiting** de login solo por usuario (no por IP).
7. **Ruta larga en Windows**: ver la nota del README (`FIERRO_STATE`).
8. **Zona horaria fija UTC-3**: si se vende fuera de Argentina, hay que hacerla configurable por taller.

## 6. Pruebas realizadas
- `npm test`: **8 unitarias + 37 de integración, todas OK** (Worker real + D1 local).
  - Flujo completo: cliente → vehículo → presupuesto → aprobación → conversión (única, con 2 solicitudes simultáneas) → check-list → finalización (3 solicitudes simultáneas → un solo descuento de stock) → reapertura (repone) → comprobante (único) → cobros parciales con doble envío (sin duplicar) → intento de cobro excedente (409) → anulación de cobro → entrega → historial → recordatorio de service.
  - Stock: venta de mostrador idempotente, anulación que repone, venta sin stock rechazada, rollback atómico de OT sin stock, compras y anulación, ajuste por conteo.
  - Seguridad: un taller no puede listar, leer, modificar ni referenciar datos de otro (clientes, vehículos, artículos, presupuestos, OT, ventas, cobros, cuentas); patentes repetidas entre talleres; permisos del empleado; cupo de licencia; desactivación de usuario (cierra sesiones); el propietario no se puede desactivar; licencia suspendida en solo lectura; token de plataforma; credenciales inválidas; bloqueo por intentos; CSRF (415); logout invalida la sesión.
- **Prueba manual en el navegador**: login; dashboard; tablero de OT; cambio de estado con descuento de stock; generación de comprobante; cobro con doble clic (se registró uno solo); alta de OT con búsqueda por patente y servicio del catálogo; vista móvil (375 px); usuario de otro taller (no ve datos ajenos, OT ajena da 404); vista del empleado (sin finanzas, compras ni estadísticas).
- `npm run build`: OK (PWA generada).

## 7. Próximos pasos sugeridos
1. Desplegar en una cuenta de Cloudflare de prueba y medir la CPU del login (riesgo 1).
2. Validar con el primer taller: carga real de servicios y precios, y ajustes de flujo.
3. Exportación a Excel/CSV e importación de artículos y clientes (migración desde el sistema anterior).
4. Fotos en el check-list (R2) y firma.
6. Integración ARCA (homologación primero), usando `comprobantes_fiscales`.
7. Panel web de plataforma para licencias.

---

# Expansión funcional 01 · Caja, finanzas, listas de precios, cobranzas y compras

Rama `feature/expansion-comercial-01` (local; **no se desplegó ni se tocó la D1 remota**). Fecha: 2026-10-20.

## 8. Qué se implementó

### Caja diaria (`/caja`)
- **Apertura** con efectivo inicial (sugiere lo declarado en el último cierre), **una sola caja abierta por taller** (índice único parcial: dos aperturas simultáneas → una sola prospera).
- **Libro único de movimientos** (`caja_movimientos`): cobros, pagos a proveedores, gastos e ingresos manuales. Cada operación comercial asienta su movimiento **en el mismo batch** y la sesión se toma de la caja abierta **dentro de la misma sentencia SQL**, de modo que usuarios simultáneos nunca quedan en cajas distintas ni a medio cerrar.
- **Sin duplicados por diseño**: índice único `(taller_id, origen_tipo, origen_id)`; los cobros, ventas de contado y comprobantes de OT con cobro usan **un solo camino** (`worker/lib/cobros.ts`).
- **Anulaciones = contra-asiento** (`reverso`) en la caja abierta del momento; el original nunca se borra. Un movimiento se revierte una sola vez.
- **Arqueo** parcial (conteo por denominación, no cierra) y **cierre** con esperado vs. declarado por medio de pago, diferencia justificada obligatoria, y control de concurrencia (`esperado_visto`: si otro usuario movió caja mientras se contaba, el cierre se rechaza y hay que recontar).
- **Historial** de cajas con diferencias, **reportes** (por medio, rubro, usuario y día) y exportación CSV.
- **Caja obligatoria** configurable por taller (Configuración): con ella, cobros/pagos/gastos exigen caja abierta (prechequeo + `guard` en el batch). Por defecto **no** es obligatoria: los talleres existentes siguen operando igual y los movimientos sin caja quedan marcados.
- Egresos manuales = **gastos** (no hay otra vía, para no contabilizar dos veces). Ingresos manuales (aportes, sobrantes) con anulación.

### Gastos y finanzas (`/finanzas`)
- Gastos con categorías (11 iniciales por taller, editables), proveedor y comprobante opcionales, anulación con contra-asiento.
- **Gastos recurrentes** (semanal a anual): vencidos resaltados; "Registrar" (con importe/medio reales) y "Saltear" son atómicos y rechazan el doble registro de una misma ocurrencia.
- **Resumen en base caja**: ingresos (cobros + otros), egresos (pagos a proveedores + gastos), resultado, por medio de pago, gastos por categoría, evolución diaria/mensual. Compras y ventas a crédito se informan aparte como "devengado" (no cuentan dos veces).

### Listas de precios (`/listas-precios`)
- Listas con **margen sobre el costo** o **recargo/descuento sobre el precio base**, redondeo, porcentaje propio para servicios, precios **fijos** por artículo, predeterminada única, activar/desactivar (nunca se borran).
- Con base "costo", los precios **siguen al costo** (una compra los actualiza sin editar artículos).
- **Actualización masiva**: ajuste de precios fijos de una lista, "fijar precios calculados", y ajuste masivo de **costos o precios base** por categoría/proveedor (porcentaje o margen sobre costo) con **simulación previa**.
- Selector de lista en presupuestos, OT y ventas (recalcula los ítems si el usuario lo confirma). Cada documento conserva el precio con el que se emitió y el **nombre de la lista usada**; presupuesto → OT → comprobante arrastran la lista.

### Cobranzas y cuentas corrientes
- Recibo imprimible (con importe en letras) y estado de cuenta imprimible; detalle de cobro; historial de pagos del cliente; filtros por estado/medio/cliente/N°.
- Cuentas corrientes con **antigüedad de la deuda** (0-30/31-60/61-90/+90), filtros (con deuda, vencidas, al día), recordatorio por WhatsApp.
- Cobro parcial mejorado: imputación al más antiguo a partir de un monto, saldo restante visible, cheque exige número, fecha limitada.
- **Correcciones de la auditoría**: venta *contado* sin cobro (ahora exige medio de pago y cobra en el acto; en OT, "emitir y cobrar" atómico), cuenta corriente a *Consumidor final* (rechazada en API y UI), **fechas comerciales** (no futuras; el empleado sólo hoy; administrador hasta 400 días atrás; cobro no anterior al comprobante), guardas de ruta por permiso en el frontend.

### Inventario y compras
- **Stock decimal exacto**: operaciones con `ROUND(…, 3)` en SQL y TS, cantidades con ≤ 3 decimales (0,3 − 0,1 = 0,2 y se puede sacar 0,2). Se normalizó el stock existente.
- **Reposición** (`/reposicion`): artículos en o bajo el mínimo, cantidad sugerida (a "stock ideal" opcional o al doble del mínimo), agrupados por proveedor, "Armar compra" precargada.
- Compras: filtros, detalle, **compra de contado** (pago + egreso de caja en la misma transacción), artículos repetidos rechazados, **reversión del costo al anular** (sólo si el artículo conserva el costo que fijó esa compra), anulación del pago de contado.
- Pagos a proveedor: tope contra la deuda (anticipo sólo si se pide expresamente, con `guard` anti-concurrencia), egreso de caja, **anulación atómica** (antes no lo era) con UI; cuenta corriente muestra las operaciones anuladas tachadas. Proveedores: activar/desactivar, deuda total.
- Movimientos de stock: filtros por artículo, tipo y fechas; origen enlazado (OT, venta, compra); CSV.
- Los `IN (?,…)` de documentos, stock, ventas, compras y ficha de vehículo se parten en **lotes de ≤ 90 parámetros** (límite de D1; hallazgo E-01).

### Otros
- Nuevos permisos: `caja.operar` (empleado, administrador, propietario), `finanzas.ver`, `gastos.gestionar`, `precios.gestionar`, `fechas.retroactivas` (administrador y propietario).
- Indicadores del dashboard ya no parten los importes en dos líneas; indicador de **Caja** en Inicio; exportación CSV en listados nuevos.
- Puertos de desarrollo configurables: `FIERRO_API_PORT` / `FIERRO_WEB_PORT` (permite una segunda instancia sin pisar la habitual).
- `scripts/seed.mjs` actualizado a las nuevas reglas y con caja abierta, gastos, un gasto recurrente vencido y dos listas de precios de ejemplo.

## 9. Migraciones creadas (todas aditivas, compatibles con los datos existentes)
| Archivo | Contenido |
|---|---|
| `0002_stock_precision_indices.sql` | Normaliza el stock a 3 decimales; `articulos.stock_objetivo`; `compra_items.costo_anterior/costo_aplicado`; `pagos_proveedor.compra_id`; 9 índices de lectura (F-02). |
| `0003_caja_finanzas.sql` | `taller_config.caja_obligatoria`; `caja_sesiones`, `caja_sesion_medios`, `caja_arqueos`, `caja_movimientos`, `categorias_gasto`, `gastos`, `gastos_recurrentes`. **Backfill**: categorías de gasto para los talleres existentes y los cobros/pagos vigentes ya registrados pasan al libro (sin caja asignada); lo anulado antes no genera movimiento. |
| `0004_listas_precios.sql` | `listas_precios`, `lista_precio_items`; `lista_precio_id/nombre` en presupuestos, órdenes y ventas (sin FK: SQLite no permite agregarlas con ALTER; la API valida y las listas no se eliminan). |

**Antes de aplicarlas en producción:** `wrangler d1 migrations apply DB --remote` (lo hace el usuario). Se probaron sobre una copia de datos "previos" (ver Pruebas). Time Travel de D1 permite volver atrás si hiciera falta. D1 limita los `SELECT` compuestos: las categorías iniciales se insertan con una sentencia por categoría.

## 10. Pruebas realizadas
- `npm test`: **17 unitarias + 92 de integración, todas OK** (antes 8 + 37). `npm run typecheck` y `npm run build` OK.
- Nuevas suites de integración (Worker real + D1 local): `caja.test.ts` (apertura simultánea, venta → cobro → movimiento sin duplicar, arqueo, cierre con diferencias, `esperado_visto`, anulaciones, permisos, aislamiento, caja obligatoria, 5 cobros simultáneos del mismo saldo), `finanzas.test.ts` (gastos, recurrentes con doble registro simultáneo, resumen sin doble conteo, fechas, validaciones de la auditoría, cuentas corrientes, stock decimal, aislamiento), `compras.test.ts` (compra → stock → cuenta del proveedor, pago → egreso, anulaciones, compra de contado, pagos simultáneos, reposición, documentos de 110 artículos, aislamiento), `precios.test.ts` (listas, fijos, ajustes masivos, cambio de lista → presupuesto → OT → venta con precio histórico, permisos y aislamiento), `migraciones.test.ts` (0002-0004 sobre datos previos con SQLite en memoria: conserva todo, backfill, integridad referencial).
- Pruebas unitarias nuevas: cálculo de listas, próxima ocurrencia de gastos recurrentes, cantidades de stock e importe en letras.
- Verificación en el navegador (instancia aislada con datos demo, puertos 8790/5180): caja (apertura demo, cierre con arqueo, historial), resumen y recurrentes, listas, venta de mostrador con lista Mayorista y cobro (precio $5.625 = costo × 1,25), detalle de cobro, recibo imprimible, cuentas corrientes y modal de cobro, vista móvil. Sin errores en consola.
- El `window.print()` del diálogo real del navegador sigue sin poder verificarse (se comprobó el contenido y el estilo en pantalla).

## 11. Problemas detectados durante el desarrollo
- **Bug propio hallado por las pruebas**: el id de un ingreso manual de caja no coincidía con su `origen_id`, lo que impedía anularlo; corregido (el id del movimiento manual es su propio origen).
- D1 limita los `SELECT` compuestos (`UNION ALL` de 11 filas falló); resuelto con sentencias separadas.
- Con una instancia de `wrangler dev` activa, `wrangler d1 execute --local` puede operar sobre esa instancia; por eso la prueba de migraciones usa SQLite en memoria (`node:sqlite`; se omite si el Node no lo trae).
- Cambio de comportamiento deliberado (corrige la auditoría): una venta de mostrador **contado** ahora exige `cobro`; el comprobante de OT por defecto es a cuenta corriente y "contado" exige `cobro`. Los clientes de la API que no lo envíen recibirán 400.

## 12. Pendiente / decisiones abiertas
- **No se aplicó** `iva_default`/`recargo_default` (siguen inertes): las bases existentes tienen `iva_default = 21` por defecto y aplicarlo cambiaría los importes de documentos nuevos sin aviso. Decidir si se aplica y qué hacer con los valores actuales.
- Varias cajas simultáneas (puestos) y cierre de períodos contables (bloqueo de fechas ya cerradas).
- Gastos "a pagar" (devengados) y pagos de proveedores aplicados a compras específicas; conciliación bancaria.
- Contabilidad de partida doble (fuera de alcance por pedido); facturación ARCA.
- Importación/exportación masiva de artículos y clientes (hoy sólo CSV de listados nuevos); el empleado sigue viendo costos y saldos de proveedores (E-10).
- Pruebas de interfaz automatizadas (E2E) y prueba de carga; verificación contra D1 remoto de staging (parámetros por consulta, plan de CPU).
- Code-splitting: el bundle subió de 415 kB a ~556 kB (se mantiene dentro de lo razonable; conviene cargar por rutas).
- Resto de la auditoría (despliegue verificado, backups, autenticación, cabeceras, dependencias) sin tocar en esta etapa.

## 13. Cómo retomar
1. `npm test` (debe dar 17 + 92 OK) y `npm run typecheck`.
2. Revisar la rama `feature/expansion-comercial-01`; aplicar migraciones en un D1 de **staging** antes de producción.
3. Para probar a mano sin pisar tu entorno: `FIERRO_STATE=<carpeta> FIERRO_API_PORT=8790 FIERRO_WEB_PORT=5180 npm run dev` y `FIERRO_API=http://127.0.0.1:8790 npm run db:seed`.
