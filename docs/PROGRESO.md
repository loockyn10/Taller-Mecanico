# Progreso del desarrollo · Fierro v0.1.0

Última actualización: 2026-10-22 (ver la sección 39 en adelante: Sprint 09, devoluciones, anticipos y rentabilidad). Documento para retomar el trabajo en nuevas sesiones.

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
- ~~Multi-depósito~~ (resuelto en el Sprint 08); remitos internos de transferencia siguen pendientes.
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

---

# Sprint 03 · Expansión administrativa y ERP

Trabajo directo sobre `main`, sin ramas ni PR. Fecha: 2026-10-20. **No se tocó ninguna base remota ni se desplegó nada.** Hay una migración nueva (0005), por lo que el commit queda en `main` **sin `git push`** hasta que se apliquen las migraciones en Cloudflare (ver 19).

> Verificación del estado previo: el Sprint 01 está completo en el repositorio. **El Sprint 02 (historial clínico del vehículo, tempario, horas y comisiones por mecánico) no figura en el historial de git ni en el código**: sólo existen los mecánicos, la agenda y las OT del producto base. No se implementó en este sprint.

## 14. Qué se implementó

### Bancos (`/bancos`)
- Cuentas bancarias: banco, tipo, alias, CBU/CVU validado, titular, CUIT validado, moneda ARS/USD, saldo inicial, activa/inactiva. Con movimientos ya no se puede cambiar el saldo inicial ni la moneda.
- Libro por cuenta (`banco_movimientos`): ingresos/egresos manuales, depósitos y extracciones de efectivo (mueven la caja con un "traspaso"), transferencias entre cuentas propias (dos asientos con el mismo `transferencia_id`, misma moneda), ajustes autorizados (**sólo propietario**, con motivo) y anulaciones por contra-asiento.
- **Integración sin duplicar**: cobros, pagos a proveedores y gastos con transferencia/tarjeta pueden asignarse a una cuenta; el movimiento bancario se escribe en el mismo batch con `(origen_tipo, origen_id)` único. El espejo del cobro tiene `afecta_resultado = 0`: la plata se cuenta una vez (en el libro de caja).
- **Conciliación manual**: pendientes vs. extracto, fecha de corte, saldo del extracto, diferencia registrada, historial, detalle y "deshacer" (sólo la última).
- Sin integraciones bancarias externas.

### Cheques y eCheq (`/cheques`)
- Recibidos y emitidos, físico o eCheq (ID), banco, número, titular y CUIT, importe, emisión, fecha de pago, vencimiento (pago + 30 días), beneficiario, observaciones. Estados: en cartera, depositado, entregado, acreditado, rechazado, anulado, con historial de eventos.
- Nacen solos: un cobro con medio "cheque" deja el cheque en cartera; un pago a proveedor con cheque propio lo registra como emitido (o endosa uno de cartera: sale de la cartera y baja la deuda; si se anula el pago, vuelve).
- Depositar (valida fecha de pago y vencimiento), acreditar/debitar, rechazar (revierte el ingreso bancario si ya estaba acreditado y permite cargar la comisión), entregar, volver a cartera, anular.
- Un cheque ya depositado/acreditado bloquea la anulación del cobro que lo originó. Un mismo cheque (banco + número + librador) no se registra dos veces.
- Totales por estado, próximos a vencer (alerta configurable), vencidos, filtros, CSV.

### Tesorería (`/tesoreria`)
- Disponible (efectivo + bancos en pesos), efectivo en caja, saldo bancario, cheques pendientes, cuentas por cobrar/pagar (con vencidas), ingresos, egresos y **resultado financiero operativo** del período, obligaciones y gastos recurrentes vencidos, evolución diaria, CSV e impresión.
- Criterio anti-duplicación documentado en pantalla: depósitos, extracciones y transferencias internas **no** son ingresos ni egresos; lo cobrado/pagado cuenta una vez; lo a crédito se informa como cuenta por cobrar/pagar.

### Compras y proveedores avanzados
- **Órdenes de compra** (`/ordenes-compra`): borrador, pendiente, parcialmente recibida, recibida, cancelada; descuentos por ítem y global, IVA, fecha prevista, observaciones; edición mientras no haya recepciones; cierre "con faltante"; impresión.
- **Recepción total o parcial** con remito del proveedor (no repetible), control de cantidades (`CHECK` en base: dos recepciones simultáneas del mismo saldo no exceden la orden), diferencia contra lo pendiente y anulación que revierte stock, costo y estado.
- **Dos circuitos que no se mezclan**: (A) compra directa (existente: stock + deuda en un paso) y (B) orden → recepción (sólo stock) → factura (la deuda nace con la factura). Nunca se ingresa el stock dos veces ni se duplica la deuda.
- **Facturas de proveedores** (`/facturas-proveedor`): tipo, número normalizado `0001-00001234`, CUIT validado y coincidente con el del proveedor, IVA 21/10,5/27, otros tributos, total que debe cerrar con los importes, condición de pago y vencimiento; asociables a una compra existente (no duplican la deuda) o a una orden recibida; notas de crédito que restan; rechazo de comprobante duplicado (también contra el `numero_doc` de una compra).
- **Cuenta corriente y vencimientos**: pagos parciales imputados al comprobante más antiguo (derivado, sin elegir), pendiente por documento, vencido / por vencer, pestaña "Deuda y vencimientos", estado de cuenta imprimible y CSV. El saldo de proveedores se calcula con compras + facturas independientes − pagos en todos los módulos.
- Pagos a proveedor y compras de contado: cuenta bancaria de origen, cheque propio o endoso de cheque de cartera.

### Inventario avanzado (`/inventario`, `/reposicion`)
- **Valorizado** por categoría/proveedor (costo, precio, margen potencial, alertas de artículos sin costo o con stock negativo), con cantidades exactas a 3 decimales.
- **Historial de costos** mantenido por triggers de base (cubre compras, recepciones, edición y ajustes masivos) y visible en la ficha del artículo.
- **Reposición**: descuenta lo ya pedido (órdenes abiertas), compara con `ROUND(..., 3)` y genera **una orden de compra por proveedor** en borrador.
- **Conteo físico**: foto del stock, carga de lo contado, diferencias valorizadas, aplicación auditada (ajusta sólo la diferencia contada, conservando lo vendido mientras se contaba; hasta 250 ajustes por conteo) y cancelación.
- Todo ajuste o salida manual exige **motivo** (conteo, rotura, merma, robo, vencimiento, error de carga, uso interno, otro) y queda en el historial de movimientos.

### Contabilidad y registros internos (`/contabilidad`)
- Resumen de ingresos y egresos, **libro interno de ventas** (con desglose por alícuota), **libro interno de compras** (sin duplicar facturas asociadas; las notas de crédito restan), registro consolidado de operaciones y desglose de impuestos registrados. Datos reales, CSV e impresión; cada pantalla aclara que **no son libros fiscales ni declaraciones ante ARCA**.
- **No implementado**: contabilidad por partida doble (plan de cuentas, asientos, libro diario, mayor, balance de comprobación). Queda pendiente y no hay pantallas que la simulen.

### Informes (`/informes`)
- Ventas (por día, mes o comprobante), por artículo, por categoría, más vendidos, servicios más realizados, rentabilidad, cobranzas, deudores, compras, gastos, deuda con proveedores, inventario valorizado, rendimiento de mecánicos, órdenes de trabajo y actividad financiera.
- Filtros por fecha, estado, cliente, proveedor, artículo, categoría y mecánico. **CSV para Excel en español** (`;`, BOM, importes con coma decimal, fechas dd/mm/aaaa) e impresión/PDF del navegador. Los costos y márgenes exigen el permiso de valorización.

### Configuración y documentos
- Datos fiscales (CUIT validado, IIBB, inicio de actividades), sitio web, pies por tipo de documento (presupuesto, recibo/estado de cuenta, orden de compra), medios de pago habilitados (el efectivo siempre), tolerancia de diferencia en el cierre de caja, días de alerta de cheques y plazo de pago a proveedores. Todo separado por taller.
- **IVA por defecto y recargo por defecto ahora se aplican** como valores iniciales de presupuestos, OT y ventas (antes no tenían efecto).
- Impresos nuevos: orden de compra y estado de cuenta de proveedor; los demás muestran datos fiscales y el pie configurable. Los comprobantes siguen diciendo "documento no válido como factura".

### Seguridad
- Permisos nuevos verificados en el servidor: `bancos.gestionar`, `bancos.ajustar` (sólo propietario), `cheques.gestionar`, `tesoreria.ver`, `contabilidad.ver`, `stock.valorizar` (administrador y propietario). El empleado sólo ve un selector de cuentas sin saldos para poder cobrar.
- Todo filtrado por `taller_id` de la sesión; claves compuestas en las tablas nuevas; cuentas de otro taller rechazadas; operaciones atómicas con guards, idempotencia por clave y auditoría de cada operación.
- Las pantallas administrativas se cargan bajo demanda (el paquete inicial se mantiene en ~565 kB).

## 15. Migraciones generadas
| Archivo | Contenido |
|---|---|
| `0005_bancos_cheques_compras_inventario.sql` | **Reconstruye `caja_movimientos`** (copia completa) para admitir el rubro `traspaso` y el origen `banco`; crea `cuentas_bancarias`, `banco_movimientos`, `conciliaciones`, `cheques`, `cheque_eventos`, `ordenes_compra`, `orden_compra_items`, `recepciones`, `recepcion_items`, `facturas_proveedor`, `conteos`, `conteo_items`, `articulo_costos` (+ 2 triggers y backfill del costo vigente); agrega `cuenta_id` a `cobro_medios`/`pagos_proveedor`/`gastos`, `vencimiento` a `compras`, `motivo` a `stock_movimientos`, datos fiscales a `talleres` y parámetros administrativos a `taller_config`. |

Es aditiva: no se pierden datos. Una consecuencia de comportamiento: **para los talleres que nunca guardaron su configuración, `iva_default` pasa de 21 a 0** (el 21 de fábrica nunca se había usado en los formularios y ahora sí se usa; así no cambian los importes de sus documentos nuevos). Los que ya guardaron la configuración conservan su valor. Los talleres nuevos arrancan con 21 sólo si son responsables inscriptos.

## 16. Pruebas
- `npm test`: **22 unitarias + 140 de integración, todas OK** (antes 17 + 92). `npm run typecheck` y `npm run build` OK.
- Nuevas: `bancos.test.ts` (cobro → banco, cobro → caja, transferencias, depósito/extracción, cheque recibido → depósito → acreditación → rechazo, conciliación, tesorería sin doble conteo, aislamiento), `abastecimiento.test.ts` (OC → recepción parcial → stock, recepciones simultáneas, anulación, factura sin duplicar deuda ni comprobante, nota de crédito, pagos parciales y vencimientos, cheque endosado/propio, reposición → orden, valorización, costos, conteo físico, aislamiento), `informes.test.ts` (venta → reportes, libros internos, consolidado, configuración, medios deshabilitados, tolerancia de caja) y la prueba de migraciones ampliada (0005 sobre datos previos).
- Verificación en el navegador con una instancia aislada (puertos 8790/5180, datos demo): tesorería, bancos, cheques, órdenes de compra y recepción, facturas, deuda y vencimientos, inventario valorizado, informes, contabilidad, cobro con cheque desde la cuenta del cliente (el cheque quedó en cartera) y vista móvil. Sin errores de consola propios.

## 17. Cambios de comportamiento
- Los ajustes y salidas manuales de stock exigen `motivo` (la API devuelve 400 sin él).
- Un cobro/pago con medio "cheque" crea el cheque en la cartera; un mismo cheque no puede repetirse. Anular el cobro con el cheque ya depositado, entregado o acreditado (o el pago con el cheque propio ya acreditado) se rechaza con 409.
- El CUIT del taller se valida (dígito verificador) al guardar la configuración; el IVA por defecto sólo admite 0, 10,5, 21 o 27.
- El saldo de un proveedor suma las facturas independientes y resta las notas de crédito (antes sólo compras y pagos); las facturas asociadas a una compra no suman de nuevo.
- La caja distingue los traspasos con bancos (no entran en ingresos/egresos de los resúmenes).
- El saldo de los proveedores sigue visible con `catalogo.ver` (hallazgo E-10 de la auditoría, sin cambios).

## 18. Pendiente / no implementado
- **Contabilidad de partida doble** completa (plan de cuentas, asientos, libro diario/mayor, balance de comprobación) y cierre de períodos.
- ~~Sprint 02~~ (historial técnico, tempario, tiempos de mecánicos): completado en el Sprint 07 (secciones 27 a 32). Siguen pendientes las comisiones.
- El rechazo de un cheque no reabre solo la deuda del cliente: se avisa y hay que anular el cobro (que queda permitido). Tampoco se concilian cheques contra extractos importados.
- Cobros/pagos por tarjeta se acreditan en la cuenta el mismo día (no hay liquidaciones diferidas del procesador).
- Imputación de pagos a proveedores contra comprobantes específicos (hoy es automática al más antiguo); OCR de facturas; importación/exportación masiva de artículos; recuperación de contraseña por email.
- Los informes se imprimen/PDF desde el navegador (no hay generación de PDF en servidor); el `window.print()` real sigue sin verificarse de forma automatizada.
- Pruebas de interfaz automatizadas (E2E), prueba de carga y verificación contra un D1 remoto de staging.

## 19. Cómo actualizar Cloudflare
1. Revisá el commit en `main` (no se hizo push).
2. Aplicá **sólo** la migración nueva a la base remota (lo hacés vos): `npx wrangler d1 migrations apply DB --remote` (aplica `0005_bancos_cheques_compras_inventario.sql`; las anteriores ya figuran como aplicadas). Conviene tomar antes un punto de Time Travel de D1.
3. Recién después, `git push origin main` para que el despliegue automático publique el Worker y la SPA.
4. Los datos de caja existentes se conservan (la tabla se reconstruye copiando todas las filas).

---

# Preparación de la demostración comercial

Trabajo sobre `main`, sin ramas ni PR. **No se tocó ninguna base remota ni se desplegó nada.** Documentación completa en `docs/DEMO.md`.

## 20. Qué se agregó
- **Generador de datos de demostración** (`scripts/demo/`, `npm run demo -- simular|destino|cargar|cronologia|verificar|estado`): crea "Taller Demo Fierro" con ~3 meses de actividad (30 clientes, 35 vehículos, 4 mecánicos, 45 OT, 25 presupuestos, 30 turnos, 80 artículos, 8 proveedores, 26 compras + 5 órdenes de compra, 35 ventas de mostrador + 35 comprobantes de OT, cuentas corrientes, cajas diarias con cierres, gastos, 3 cuentas bancarias, cheques y eCheq, conteos, listas de precios).
- Todo se carga **por la API real** (sin insertar directamente), jornada por jornada. La API no permite fechar OT, comprobantes de OT ni sus cobros en el pasado, así que un SQL auditable (`UPDATE` de columnas de fecha del taller, sin tocar importes ni vínculos) reubica cada jornada en su día. El generador es idempotente (manifiesto), reanudable, sólo carga en talleres sin datos propios y exige `--remoto --confirmo <id>` para cualquier API no local.
- 90 comprobaciones de consistencia (`verificar`): stock exacto y sin negativos, cajas encadenadas, cobrado = suma de cobros, saldos de cuentas corrientes y bancos, libro de caja contra cobros/pagos/gastos, cronología sin fechas futuras, numeración sin saltos y 27 secciones/informes con datos.

## 21. Cambio en código de la aplicación
- `src/App.tsx`: el `import { lazy … }` estaba **después** de su primer uso (`const X = lazy(...)`). El build de producción lo toleraba, pero el servidor de desarrollo de Vite mostraba la pantalla en blanco ("Cannot access 'lazy' before initialization"). Se movieron los imports al principio; sin cambio funcional.

## 22. Pruebas realizadas
- Carga completa sobre una instancia aislada (puertos 8790/5180): 90/90 comprobaciones; reanudación tras cortar la carga a mitad (sin duplicados); recarga sobre cuenta ya cargada ("nada que hacer"); guardas de entorno remoto. `npm run typecheck` y `npm run test:unit` OK.
- Recorrido en el navegador de: inicio, órdenes (tablero), presupuestos, agenda, cuentas corrientes, caja, tesorería, bancos, cheques, inventario, órdenes de compra, reposición, recordatorios, informes y estadísticas.

---

# Sprint 06 — Usuarios, permisos granulares y control de personal

Trabajo sobre `main`, sin ramas ni PR. Se reutilizó la autenticación existente (sesión por cookie, tabla `usuarios`, licencias): no hay un segundo sistema de identidades.

## 23. Qué se implementó
- **Personal** (`worker/modules/personal.ts`, `src/pages/personal/Equipo.tsx`): cada persona tiene nombre, apellido, DNI, cargo, teléfono, fecha de incorporación, correo de acceso (opcional), rol, permisos individuales, estado y PIN. Quien solo ficha con PIN (`acceso_erp = 0`) no puede ingresar al sistema y **no ocupa un lugar de la licencia** (el cupo cuenta usuarios activos con acceso). Los usuarios de un taller nunca se ven ni se tocan desde otro (`taller_id` siempre sale de la sesión; las pruebas lo verifican).
- **Roles como plantillas** (`shared/permisos.ts`): Propietario, Administrador, Recepción, Mecánico, Depósito / Repuestos, Caja / Ventas, y el rol anterior "Empleado (general)" que conservan los usuarios ya creados (mismos accesos que tenían). Sobre cada plantilla el propietario otorga o retira permisos por persona (se guardan sólo las diferencias: `usuarios.permisos_ajustes`). Los permisos se calculan **en cada solicitud** desde la base: un cambio rige de inmediato, sin reingresar ni reinstalar.
- **53 permisos** con lectura y escritura separadas y dependencias (editar implica ver; margen implica ver precio y costo…): clientes/vehículos (ver, crear, editar), presupuestos, órdenes (todas, asignadas, trabajar asignadas, crear, modificar), agenda, precios de venta / costo / márgenes / importes valorizados, catálogo, stock (consultar, modificar, valorizar), ventas, cobros, compras (ver, gestionar), caja, gastos, bancos (ver, gestionar, ajustar), cheques, tesorería, contabilidad, estadísticas, exportar informes, administrar empleados, gestionar permisos, asistencia (fichar, ver, corregir), reloj, configuración, licencia, eliminar registros, fechas retroactivas.
- **Seguridad en el servidor** (`worker/lib/auth.ts`, `worker/lib/privacidad.ts`): `requirePerm` / `requireAny` / `requireRW` en todos los endpoints; además se **quitan de las respuestas** (listados, detalles, buscador, tablero, estadísticas, informes) los precios, costos, márgenes, importes de documentos, saldos y datos del cliente que la persona no puede ver. Cargar o editar ítems valorizados exige poder verlos. Exportar un informe es una acción aparte (`?exportar=1`, permiso `informes.exportar`, queda en la auditoría). Los PDF/impresiones se arman en el navegador con datos de la API, así que heredan el mismo filtrado.
- **Sin escalamiento de privilegios**: nadie modifica sus propios permisos, rol, estado ni acceso; un administrador sólo administra personal de nivel empleado, sólo asigna roles y otorga permisos que él mismo tiene (por defecto no tiene `permisos.gestionar` ni `bancos.ajustar`: son del propietario salvo que este se los otorgue); el propietario siempre conserva todos los permisos y no puede desactivarse.
- **Vista del mecánico** (`/mis-trabajos`, pensada para celular y tablet): sus órdenes asignadas con vehículo, patente, cliente (sólo si tiene `clientes.ver`), falla, diagnóstico, tareas pendientes (nuevas, tildables), repuestos requeridos con disponibilidad, estado, observaciones técnicas y cronómetro de reparación. Sin precios, costos, márgenes, facturación, caja ni estadísticas (lo decide el permiso, no la pantalla). Puede llevar su orden a diagnóstico / en reparación / esperando repuestos / lista; la entrega y la cancelación son del mostrador.
- **Asistencia** (`worker/modules/asistencia.ts`): entrada y salida con hora del servidor (UTC) y zona horaria configurable por taller (`taller_config.zona_horaria`, por defecto Buenos Aires); una jornada pertenece al día en que empezó y puede cruzar la medianoche; un índice único impide dos jornadas abiertas por persona (probado con solicitudes simultáneas) y una guarda de 3 s evita toques dobles. Cada persona consulta su jornada y su historial; no puede modificarlos.
- **Panel del propietario** (`/personal/asistencia`): presentes, ausentes, jornadas abiertas (con alerta a las 16 h), entradas y salidas, horas por persona, resumen por período (por persona o por día), filtros, exportación y **correcciones manuales** con permiso `asistencia.corregir` (nunca sobre los fichajes propios ni sobre los del propietario si no se es propietario): quedan quién, cuándo, valor anterior, valor nuevo y motivo en `asistencia_correcciones`; los registros se anulan, no se borran. Sin liquidación de sueldos.
- **Reloj compartido** (`worker/modules/reloj.ts`, `/reloj`): pantalla propia, sin menú ni acceso al ERP. El propietario registra el dispositivo (`/personal/reloj`) y obtiene un código de un solo uso (15 min); al activarlo el dispositivo recibe un token propio (cookie HttpOnly, hash en la base) que sólo habilita `/api/reloj/*`. La persona elige su nombre, escribe su PIN (4–8 dígitos, sin secuencias ni repeticiones; PBKDF2 salado) y ficha; la pantalla vuelve sola al inicio. Fuerza bruta: 5 errores bloquean el PIN 15 min (el propietario puede desbloquearlo), 10 errores en 10 min bloquean el dispositivo 30 min, y la activación se limita por IP. El propietario puede apagar el modo o revocar un dispositivo y el efecto es inmediato.
- **Órdenes y mecánicos**: el mecánico de las OT es el mismo registro que el usuario (`mecanicos.usuario_id`): al crear personal con rol Mecánico se crea o vincula (sin duplicar) su mecánico; los "mecánicos sin usuario" siguen existiendo para quien no usa el sistema. Antes no existía seguimiento de tiempos por OT: se agregó `orden_tiempos` (cronómetro por persona y OT), **separado** de las horas de asistencia al taller.

## 24. Migración generada
- `migrations/0006_personal_permisos_asistencia.sql` (aditiva: no elimina ni reescribe datos). Agrega columnas a `usuarios` (apellido, documento, cargo, teléfono, fecha de incorporación, plantilla, ajustes de permisos, acceso, PIN y su control de intentos), `taller_config.zona_horaria` y `reloj_activo`, y las tablas `asistencias`, `asistencia_correcciones`, `dispositivos_reloj`, `limites_intentos`, `orden_tareas`, `orden_notas`, `orden_tiempos`. Los usuarios existentes pasan a `plantilla = rol` y conservan sus accesos. La columna `usuarios.rol` mantiene su CHECK original (propietario | administrador | empleado = nivel de privilegio) para no reconstruir la tabla.
- Cubierta en `tests/api/migraciones.test.ts` (sobre datos previos).

## 25. Pruebas
- `tests/api/personal.test.ts` (31 pruebas de integración contra el Worker real): plantillas, ajustes y efecto inmediato, lectura/escritura, escalamiento de privilegios, aislamiento entre talleres (usuarios, asistencia, dispositivos, tareas), privacidad de precios/costos/márgenes/importes en cada endpoint, trabajo del mecánico, fichaje (duplicados y concurrencia), panel, correcciones, exportación, zona horaria y reloj (activación, PIN, bloqueos, revocación).
- `tests/unit/permisos.test.ts`: plantillas, dependencias, ajustes, zona horaria y jornadas nocturnas. Las 140 pruebas previas siguen pasando.

## 26. Cambios de comportamiento a tener en cuenta
- El rol "Empleado" ya no ve **costos** de artículos (sí precios de venta); antes el costo se devolvía a cualquier usuario con acceso al catálogo.
- Un administrador ya no puede crear otros administradores ni otorgar permisos que no tiene.
- La pestaña "Usuarios y permisos" de Configuración pasó a **Personal → Equipo y permisos**.
- Fuera de alcance, sin cambios: ARCA, el modelo comercial de licencias y los datos del Taller Demo Fierro.

---

# Sprint 07 — Gestión mecánica avanzada

Trabajo directo sobre `main` (sin ramas, PR ni `gh`). Completa la funcionalidad del antiguo "Sprint 02" (tempario, historial técnico, mantenimientos, horas de mecánicos) **reutilizando** lo que ya existía: no se crearon módulos, entidades ni sistemas de permisos paralelos.

## 27. Qué se implementó

### Tempario (`/tempario`, `worker/modules/tempario.ts`, `shared/tempario.ts`)
- **El tempario son los servicios del taller** (mano de obra, ya existían con categoría, precio e intervalos). Se les sumó: código, tiempo estimado general, modo de precio (`fijo` o `por tiempo`) y origen (`propio` / `plantilla` = tiempo orientativo sin revisar). Los servicios existentes quedan **intactos** (precio fijo, sin tiempo).
- **Tarifas de mano de obra por taller**: tarifa general por hora y, opcionalmente, una por categoría. Precio "por tiempo" = tiempo × tarifa, redondeado al peso. Sin tarifa o sin tiempo se conserva el precio cargado. Ver la tarifa exige `precios.venta.ver`; modificarla, `precios.gestionar`.
- **Tiempos específicos opcionales** (`servicio_tiempos`) por marca, modelo, motorización (texto contenido en el motor del vehículo) y rango de años. Gana la regla más precisa (modelo > marca > motor > años); si ninguna aplica se usa el tiempo general. Probado en `tests/unit/tempario.test.ts`.
- **Plantilla general orientativa** (47 operaciones: aceite, filtros, frenos, discos, embrague, distribución, amortiguadores, suspensión, diagnóstico electrónico, reparaciones generales, etc.). **No son datos oficiales de fabricantes**: la pantalla y la API lo dicen, y toda operación copiada queda marcada "Orientativo" hasta que el taller edita o confirma su tiempo. Se **copia** al taller (`POST /api/tempario/plantilla/importar`); a lo que el taller ya tenía solo se le completa el tiempo si estaba vacío (no se pisa ningún precio ni dato). Cada taller edita su copia; nada se comparte entre talleres.
- **Integración con presupuestos y OT**: al elegir una operación en el editor de ítems se incorpora la descripción, se sugiere el tiempo (el del vehículo elegido, si hay regla específica) y se calcula la mano de obra con la tarifa del taller. El tiempo (`tiempo_min`) queda en el ítem y es ajustable por quien puede editar ítems (exige permiso de precios e importes, como antes). La lista de precios elegida se aplica sobre el precio calculado.

### Historial técnico del vehículo (`GET /api/vehiculos/:id/historial-tecnico`, `HistorialTecnico.tsx`)
- Línea de tiempo con fecha, kilometraje, OT, diagnóstico, trabajos, repuestos, mecánicos participantes y su tiempo, tareas, observaciones técnicas y resultado. **Se lee de las órdenes de trabajo**; no se duplica nada.
- **Antecedentes anteriores a Fierro** (`vehiculo_antecedentes`): se cargan a mano (`vehiculos.editar`), se anulan sin borrarse, y se muestran **diferenciados** ("Hecho en Fierro" / "Antecedente cargado manualmente"). Si corresponden a una operación programable cuentan como su última realización.
- Los mecánicos con `vehiculos.ver` consultan todo **sin importes** (el total solo viaja con `presupuestos.valorizados.ver`; los ítems del historial no llevan precios ni costos).
- Nueva columna `ordenes.resultado` ("Resultado del trabajo"), editable por el mecánico.

### Mantenimientos programados (`/mantenimientos`, `worker/modules/mantenimientos.ts`, `worker/lib/mantenimiento.ts`)
- Una sola fuente de cálculo para la pantalla, la ficha del vehículo y `/recordatorios` (que sigue existiendo por compatibilidad). Estados: **vencido**, **próximo** (≤ 1.000 km o 30 días), **al día** y **sin registro**.
- La última realización se **calcula** de las OT terminadas (lista/entregada, con su kilometraje) y de los antecedentes; el kilometraje actual es el del vehículo (que las OT mantienen). No se guarda duplicada.
- Planes por vehículo (`vehiculo_mantenimientos`) con intervalos propios de km y/o meses que reemplazan a los del servicio, pausa, notas y "última vez" informada (queda como antecedente). Cada taller define sus mantenimientos con los intervalos de sus servicios.
- Desde un mantenimiento pendiente: **generar turno** (abre la agenda con cliente, vehículo y motivo cargados), **generar presupuesto** (abre el formulario con el vehículo y la operación) y **avisar por WhatsApp** (enlace manual). **No hay envíos automáticos** de WhatsApp, SMS ni correo.

### Mecánicos, tareas y cronómetro (reutilizando Sprint 06)
- **Sin segunda entidad de mecánicos**: el responsable sigue siendo `ordenes.mecanico_id` (el mecánico vinculado al usuario) y los **participantes** (`orden_participantes`) son usuarios del Sprint 06. El alcance de "órdenes asignadas" incluye ser responsable, participante o responsable de alguna tarea.
- **Tareas** (`orden_tareas`, reconstruida copiando las existentes): estado pendiente / en proceso / pausada / completada, responsable, tiempo estimado, observaciones técnicas, tiempo real y quién la completó. Se crean desde los trabajos con tiempo del tempario al crear la OT o convertir el presupuesto (idempotente, también por botón).
- **Mismo cronómetro de OT** (`orden_tiempos`): ahora puede atribuirse a una tarea (`tarea_id`). Empezar una tarea la pone en proceso (y a cargo de quien la empieza si estaba libre); detener o pausar deja la tarea pausada; completarla detiene el reloj. Un cronómetro a la vez por persona (índice único). Al pasar la OT a lista / entregada / cancelada se cierran los tramos abiertos.
- **Asignación sin importes**: `ordenes.asignar` (nuevo permiso; también lo tienen administración y recepción) permite fijar responsable, participantes y repartir tareas sin ver ni modificar precios. Un mecánico puede tomar una tarea libre o soltar la suya, pero no reasignar a otros.
- **Entrega**: un mecánico sin `ordenes.modificar` no puede entregar, cancelar ni reabrir (403 en la API; la pantalla ni siquiera ofrece esos estados).

### Productividad (`/productividad`, `worker/modules/productividad.ts`)
- **Por mecánico**: horas de asistencia (fichajes), horas registradas en OT (cronómetro), OT trabajadas, tareas completadas, estimado vs. real (solo tareas completadas con estimación **y** cronómetro) y carga actual (OT abiertas, tareas pendientes y su tiempo estimado).
- **Por taller**: órdenes pendientes, en proceso, completadas e ingresadas del período, tiempo promedio de ejecución (ingreso → lista y tiempo cronometrado por orden), tareas completadas y carga por empleado.
- **Asistencia ≠ productividad**: se muestran por separado y **no se calcula ningún "tiempo improductivo"** ni porcentaje de aprovechamiento; la pantalla aclara que la diferencia incluye diagnóstico sin cronómetro, esperas, limpieza, atención, etc.
- Permiso `productividad.ver` (administración y propietario; otorgable). El único indicador económico (mano de obra de las órdenes completadas) solo viaja con `presupuestos.valorizados.ver`. Cada persona ve sus propios números en "Mis trabajos" (`/productividad/mia`).

### Experiencia móvil (misma aplicación, sin segunda app)
- "Mis trabajos" rediseñada: tarjetas con patente grande, estado, avance de tareas y tiempo estimado; resumen del día propio; **barra de cronómetro** siempre visible (detener a un toque); botones de 48–56 px (Empezar / Pausar / Terminar por tarea); tareas agrupadas en **En curso / Pendientes / Finalizadas**; **observación rápida** flotante; navegación al trabajo anterior/siguiente; en tablet, dos columnas.

## 28. Integraciones reutilizadas
Usuarios, roles y 53 permisos del Sprint 06 (se sumaron 4: `ordenes.asignar`, `mantenimientos.ver`, `mantenimientos.gestionar`, `productividad.ver`, con sus dependencias y las plantillas de rol actualizadas); `mecanicos.usuario_id`; cronómetro `orden_tiempos`; tareas y notas de OT; asistencias y zona horaria del taller; `servicios` y categorías (el tempario); listas de precios; `vehiculos.km_actual` mantenido por las OT; filtrado de importes de `worker/lib/privacidad.ts`; agenda y presupuestos (prellenados desde mantenimientos). Todo con `taller_id` de la sesión y claves foráneas compuestas.

## 29. Migración
- `migrations/0007_gestion_mecanica.sql` (aditiva): columnas en `servicios` (código único por taller, tiempo, modo de precio, origen), `taller_config.tarifa_hora`, `categorias_servicio.tarifa_hora`, `presupuesto_items.tiempo_min`, `orden_items.tiempo_min`, `ordenes.resultado`, `orden_tiempos.tarea_id`; tablas `servicio_tiempos`, `orden_participantes`, `vehiculo_antecedentes`, `vehiculo_mantenimientos`; **reconstruye `orden_tareas`** copiando todas sus filas (las hechas pasan a `completada`).
- Probada en `tests/api/migraciones.test.ts` sobre datos previos del Sprint 06 (servicios, OT, tareas hechas y pendientes, tiempos) y ensayada sobre el respaldo de la D1 remota antes de aplicarla.

## 30. Pruebas
- `npm test`: **46 unitarias + 191 de integración, todas OK** (`npm run typecheck` y `npm run build` también). Nuevas: `tests/api/mecanica.test.ts` (19 pruebas contra el Worker real: plantilla y copia por taller, tarifas y precio por tiempo, regla específica vs. genérica, validación de reglas, permisos de precios, tareas generadas desde los trabajos, asignación y alcance de participantes, cronómetro por tarea, mecánico que no cambia importes ni entrega, cierre de cronómetros, historial con y sin importes, antecedentes, mantenimientos con kilometraje y antecedentes, productividad con/sin importes y aislamiento entre talleres), `tests/unit/tempario.test.ts` (11: resolución de tiempos específicos, precio por tiempo y vencimientos) y la prueba de migraciones ampliada con la 0007 sobre datos del Sprint 06.
- Las pruebas de integración se corrieron en dos tandas de archivos; una corrida única de toda la suite se colgó una vez en el servidor local de pruebas (dejó de responder a mitad de camino, sin error de las pruebas) y al repetirla por tandas pasó todo. No se identificó una causa en el código.
- Verificación en el navegador sobre una instancia aislada (puertos 8790/5180, sin tocar la instancia de desarrollo propia): vista móvil 375 px de "Mis trabajos" (barra de cronómetro, empezar/terminar tareas, avance), Tempario con tarifas y plantilla, ficha del vehículo con historial técnico y mantenimientos, turno prellenado desde un mantenimiento vencido, Mantenimientos, Productividad y la pestaña de equipo y tareas de la OT. Se corrigió un solape de la barra "Observación rápida" con la navegación inferior y las consultas de mecánicos que un mecánico no puede hacer.
- Despliegue: la migración 0007 se ensayó sobre el respaldo de la D1 remota (todas las filas conservadas, 0 violaciones de claves foráneas) antes de aplicarla.

## 31. Cambios de comportamiento a tener en cuenta
- "Recordatorios" pasó a **Mantenimientos** (`/recordatorios` redirige) y ahora requiere `mantenimientos.ver`. La pestaña **Configuración → Servicios** pasó al **Tempario**.
- Las OT nuevas (y las que salen de un presupuesto) crean una **tarea por cada trabajo** de mano de obra.
- El ajuste masivo de precios de servicios solo toca los de precio fijo; los de precio por tiempo cambian con la tarifa por hora.
- Los servicios que ya existían no cambian: siguen con precio fijo hasta que el taller decida pasarlos a "por tiempo".

## 32. Limitaciones pendientes
- Los tiempos de la plantilla son orientativos y genéricos: cada taller debe revisarlos. No hay tempario oficial de fabricantes ni sincronización con catálogos externos.
- La motorización se compara por texto contenido en el campo "motor" del vehículo; si el vehículo no lo tiene cargado, las reglas por motor no aplican.
- El tiempo real de una tarea sale del cronómetro; el tiempo trabajado sin cronómetro no se imputa. No hay comisiones, liquidación de sueldos ni costo por hora del mecánico.
- Los avisos de mantenimiento son manuales (enlace de WhatsApp): no hay envío automático por WhatsApp, SMS o correo.
- El historial no registra fotos ni archivos (requiere almacenamiento de archivos).
- Sin pruebas de interfaz automatizadas (E2E); la verificación visual fue manual en una instancia aislada.

---

# Sprint 08 — Integración comercial y control de stock

Trabajo directo sobre `main` (sin ramas, PR ni `gh`). Primero se revisó qué circuitos ya funcionaban (con las pruebas existentes) y se implementó solo lo que faltaba. **Sin ARCA** (los comprobantes siguen diciendo "documento no válido como factura"), sin cambios en licencias y sin integraciones externas.

## 33. Qué ya existía y se verificó (sin reimplementar)
- **Compras**: orden de compra con estados (borrador, pendiente, parcial, recibida, cancelada), recepciones totales y parciales con remito único y cantidades pendientes controladas por `CHECK`, stock por recepción, facturas de proveedor (la deuda nace una sola vez), pagos parciales imputados al comprobante más antiguo, cheques propios y endosados, anulaciones que revierten stock, costo y caja, idempotencia por clave en todo lo que mueve stock o dinero.
- **Ventas**: presupuesto → OT (conversión única) → comprobante interno (uno vigente por OT) → cobros completos y parciales con varios medios → caja, banco o cheque; venta de mostrador contado o a cuenta corriente; anulación con permiso (exige anular antes los cobros).
- **Inventario**: movimientos con motivo y usuario, stock mínimo y reposición, valorización, historial de costos, conteo físico, stock decimal exacto, y la regla de la OT (ver 34).
- **Precios**: listas de precios, ajustes masivos con simulación, descuentos, recargos; cada documento guarda los precios con los que se emitió (cambiar el precio de un artículo no modifica documentos ya emitidos).
- **Documentos**: presupuesto, OT, hoja de taller sin precios, comprobante interno, recibo, estado de cuenta de cliente, orden de compra y estado de cuenta de proveedor, con datos del taller y respeto de permisos de precios; CSV en la mayoría de los listados e informes.

## 34. Qué se completó
- **Depósitos por taller** (antes no existían). Cada taller tiene su *Depósito principal* y puede crear los que necesite (mostrador, camioneta, etc.); nada que ver con los talleres del SaaS. Existencias por depósito (`stock_depositos`), transferencias internas con historial, anulables y atómicas, y selección de depósito en: venta de mostrador, OT, compra directa, recepción de mercadería, movimientos manuales y conteo físico (que ahora cuenta un depósito). Pantalla `/depositos` (depósitos con su stock y valor al costo, transferencias, control de consistencia). El selector solo aparece si el taller tiene más de un depósito.
  - **Invariante**: `articulos.stock` sigue siendo el stock total y es **siempre la suma de los depósitos**; todo movimiento pasa por `worker/lib/stock.ts`, que actualiza ambos en la misma transacción (`/api/inventario/verificar` y la pestaña "Control" lo comprueban). Sin permitir stock negativo, un depósito no puede quedar en negativo aunque el total alcance. Los documentos guardan su depósito y **las anulaciones y reversos vuelven al mismo depósito** (anular una compra o recepción exige que la mercadería siga ahí).
  - **Regla de stock de la OT** (definida y mantenida): los repuestos se descuentan **una sola vez, al pasar a "Lista para entregar"** (o a "Entregada" desde un estado sin stock), del depósito de la orden; volver la OT a un estado de taller los repone en el mismo depósito; el comprobante generado desde la OT **no** vuelve a descontar. El depósito de la OT solo se cambia mientras el stock no está descontado. Probado con tres solicitudes simultáneas.
- **Código de barras**: campo `codigo_barras` único por taller; los lectores USB estándar (teclado + Enter) funcionan en el buscador de repuestos de presupuestos, OT y ventas de mostrador, compras, órdenes de compra, movimientos de stock, listado de artículos y transferencias: el código exacto agrega o abre el artículo. La búsqueda por texto también encuentra por código de barras. Sin integraciones de hardware.
- **Costo histórico**: `venta_items.costo_unitario` guarda el costo del artículo al emitir el comprobante (el de la OT, el que tenían los repuestos al descontarse). Los informes de rentabilidad y estadísticas usan ese costo, de modo que **actualizar costos o precios no cambia retroactivamente lo vendido**. Los comprobantes anteriores a este sprint usan el costo actual (no hay dato histórico). El costo del comprobante solo lo ve quien tiene permiso de costos.
- **Rentabilidad de la OT** (`/api/ordenes/:id/rentabilidad`, tarjeta en la OT con permiso de márgenes): repuestos (venta contra costo real del consumo; estimado antes de descontarse), mano de obra facturada y horas cronometradas.
- **Cuentas corrientes**: los estados de cuenta de clientes y proveedores aceptan `?desde=` y muestran el **saldo anterior** (también al imprimir); nuevo control `/api/cuentas-corrientes/verificar` (comprobantes vs. cobros aplicados vs. medios; requiere ventas y finanzas).
- **Documentos nuevos**: comprobante de recepción de mercadería (con depósito, remito, usuario; costos solo con permiso) y orden de pago a proveedor (desde el estado de cuenta del proveedor).
- **Trazabilidad**: cada movimiento de stock guarda usuario, origen, depósito y costo; las transferencias y los conteos guardan el responsable.

## 35. Circuitos operativos
- **COMPRA → STOCK → PAGO**: proveedor → orden de compra → recepción (parcial/total, a un depósito) → inventario → factura (deuda) → pago → cuenta del proveedor → caja/banco/cheque. Verificado de punta a punta con reintentos, anulaciones y controles de consistencia.
- **PRESUPUESTO → OT → REPUESTOS → VENTA → COBRO**: presupuesto → OT → consumo de repuestos (un solo descuento) → comprobante interno → cobros parciales con varios medios → caja/cuenta corriente; anulación autorizada; reposición de stock al reabrir. Verificado con saldo del cliente, stock y controles de consistencia.

## 36. Migración
- `migrations/0008_depositos_barras_costos.sql` (aditiva): `depositos`, `stock_depositos`, `transferencias_stock`, `transferencia_items`; `deposito_id` en `stock_movimientos`, `ventas`, `compras`, `recepciones`, `ordenes` y `conteos`; `articulos.codigo_barras` (único por taller); `venta_items.costo_unitario`. Crea el depósito principal de cada taller existente y le asigna el stock actual de cada artículo; los datos históricos sin depósito corresponden al principal.
- Probada en `tests/api/migraciones.test.ts` sobre datos previos y ensayada sobre el respaldo de la D1 remota antes de aplicarla. Los talleres nuevos reciben su depósito principal al darse de alta.

## 37. Pruebas
- `npm run build` (typecheck + Vite) y `npm test`: **46 unitarias + 208 de integración, todas OK**. Nuevas: `tests/api/depositos.test.ts` (16 pruebas contra el Worker real: depósito principal por taller, aislamiento entre talleres, transferencias con reintento, sin stock y anulación, venta de mostrador desde un depósito con reversa al mismo, OT con un único descuento ante solicitudes simultáneas y reposición en el depósito de origen, compra y recepción por depósito y anulaciones, movimientos manuales y conteo por depósito, desactivación, código de barras con permisos y aislamiento, costo histórico y rentabilidad de la OT, circuitos compra→pago y presupuesto→cobro→anulación con cuentas corrientes verificadas, saldo anterior y control de consistencia) y la prueba de migraciones ampliada con la 0008 sobre datos previos. Se actualizó una expectativa de `informes.test.ts` que fijaba el comportamiento anterior (rentabilidad con el costo actual): ahora usa el costo con el que se vendió.
- Las pruebas de integración se corrieron en tandas de archivos (como en el Sprint 07).
- Verificación en el navegador sobre una instancia aislada: pantalla de depósitos con stock y valor, nueva transferencia y lectura de un código de barras con Enter (agregó el artículo con su disponibilidad).
- Nota preexistente: `scripts/seed.mjs` falla de noche en esta máquina porque envía una fecha UTC que el servidor (UTC-3) considera futura; no está relacionado con este sprint.

## 38. Pendiente (no se publicó nada parcial)
- **Devoluciones parciales de ventas / notas de crédito internas**: hoy existe la anulación autorizada del comprobante (con sus cobros anulados antes) y la reposición del stock de la OT al reabrirla. Una devolución parcial exige una nota de crédito que reduzca la cuenta corriente y, si corresponde, reintegre dinero en caja, tocando clientes, cobros, caja, informes y tesorería: es demasiado extenso para cerrarlo de forma segura en este sprint y no se publicó una versión incompleta.
- Anticipos o saldo a favor de clientes (un cobro mayor al saldo sigue rechazándose); aplicación manual de pagos a proveedores contra un comprobante específico (sigue siendo automática al más antiguo).
- Costo de la mano de obra (no hay costo por hora del mecánico): la rentabilidad de la OT muestra la venta y las horas, no el margen de mano de obra.
- Reposición, inventario valorizado y stock mínimo trabajan con el stock **total** del artículo (no por depósito); no hay reserva de stock para presupuestos ni depósito por presupuesto.
- Las transferencias son inmediatas (sin estado "en tránsito").
- Importación masiva de artículos y exportaciones CSV adicionales siguen pendientes (el CSV existente cubre los listados principales y las pantallas nuevas).

---

# Sprint 09 — Devoluciones, anticipos y rentabilidad

Trabajo directo sobre `main` (sin ramas, PR ni `gh`). Sin ARCA, sin cambios en licencias. El sprint se desarrolló en dos tramos (el primero se cortó por límite de uso): el segundo reutilizó íntegramente la migración, el backend y los componentes ya escritos y completó interfaz, informes, impresión y pruebas.

## 39. Qué se implementó
- **Devoluciones parciales (nota de crédito comercial interna, no fiscal)** — `worker/modules/devoluciones.ts`, `shared/devoluciones.ts`.
  - Nacen de un comprobante y de sus líneas; el comprobante original nunca se modifica (solo `ventas.devuelto` y, cuando se libera lo ya pagado, `ventas.cobrado`). Saldo pendiente = `total − devuelto − cobrado` (actualizado en todas las consultas).
  - Se controla cantidad e importe acumulados por línea al calcular y de nuevo dentro del batch (guards), también ante devoluciones simultáneas. Servicios y mano de obra se devuelven por cantidad o por importe (bonificación); los repuestos pueden reingresar al inventario (depósito elegido, costo histórico del comprobante) o no (dañado/instalado). No se reincorpora nada sin indicarlo.
  - El crédito se reparte en deuda impaga que se cancela (`a_deuda`) y dinero ya cobrado (`liberado`), que se reintegra por los medios de pago (egreso de caja rubro `devolucion` y espejo bancario) y/o queda como saldo a favor. Consumidor final debe reintegrar el total cobrado.
  - Simulación previa (`POST /api/devoluciones/simular`) con las consecuencias sobre comprobante, cuenta corriente, dinero y stock; registro idempotente (`idem_key`); anulación de la devolución (revierte stock y comprobante) y de cada reintegro (contra-asiento). Un comprobante con devoluciones no se anula ni se le anula el cobro hasta deshacerlas.
  - Permisos: `ventas.anular` para devolver y `cobros.anular` para reintegrar dinero. Auditoría de cada operación.
- **Anticipos** — `worker/modules/anticipos.ts`, `worker/lib/creditos.ts`, `worker/lib/reintegros.ts`.
  - Un anticipo es un cobro `tipo='anticipo'` (mismo circuito de caja, banco, cheques, recibo y cuenta corriente), asociable a una OT o a un presupuesto; no es una venta. Se aplica total o parcialmente a una o varias ventas (`credito_aplicaciones`) sin mover dinero otra vez; los CHECK de la base impiden aplicarlo dos veces o más allá de lo disponible. Se puede devolver en dinero, deshacer una aplicación o anular (si no está en uso).
  - Consultas: pendientes, utilizados, devueltos y anulados, con los comprobantes que originaron cada movimiento. El saldo a favor (anticipos + crédito de devoluciones) figura en la cuenta corriente (saldo negativo = a favor).
  - Al emitir el comprobante de una OT se pueden imputar los anticipos disponibles en la misma transacción (`creditos` en `POST /api/ordenes/:id/comprobante`; el resto se cobra en el acto o queda a cuenta corriente).
- **Costo de mano de obra** — `worker/modules/costos.ts`, `worker/lib/rentabilidad.ts`.
  - Costo horario interno general y por persona (`/api/costos-mano-obra`), confidencial: exige `margenes.ver` (y `precios.gestionar` para editar), no viaja en `/taller/config`, en la ficha de la OT ni en listados para quien no lo tiene; la auditoría no guarda importes.
  - Se usa el mismo cronómetro de las OT (`orden_tiempos`): un trigger congela el costo horario vigente al cerrar cada tramo. La estimación (tiempo estimado de las tareas × costo del responsable) se congela cuando la OT queda lista/entregada y se descarta si se reabre. Cambiar costos después no altera lo ya trabajado; los tramos anteriores no se reconstruyen con costos actuales.
  - `GET /api/ordenes/:id/rentabilidad` devuelve `resumen`: mano de obra cobrada, costo estimado, costo real, repuestos (venta/costo), devoluciones, margen bruto, **calidad** (`definitivo`, `estimado`, `parcial`) y la lista de lo que falta. Un margen incompleto nunca se presenta como definitivo.
  - No hay liquidación de sueldos ni se imputa tiempo sin cronómetro.
- **Stock mínimo por depósito** — `stock_minimos_deposito`, `PUT /api/articulos/:id/minimos-deposito`, `GET /api/reposicion?deposito_id=<id|todos>`. Convive con el mínimo general (que sigue controlando el total). Alertas en reposición, existencias del depósito y tablero. Lo ya pedido en órdenes de compra abiertas se descuenta de los faltantes sin duplicar pedidos; nunca se crean órdenes automáticamente (las genera el usuario con "Generar orden de compra", sumando por artículo).
- **Informes y resúmenes**: ventas por día/mes/comprobante con devuelto y neto de devoluciones; ventas por artículo/categoría/servicios, rentabilidad y estadísticas netas de devoluciones (el costo de lo devuelto que no vuelve al inventario sigue siendo costo); cobranzas con tipo (los anticipos figuran el día que se cobran y no se vuelven a contar al aplicarse); deudores con saldo a favor; informes nuevos **Devoluciones**, **Anticipos**, **Rentabilidad por OT** y **Costo de mano de obra por mecánico**; Finanzas, Tesorería y Contabilidad separan los reintegros a clientes, informan anticipos y saldo a favor (una obligación, no un ingreso) y el libro interno de ventas resta las notas de crédito. Costos y márgenes respetan los permisos.
- **Interfaz** (sin pantallas nuevas): comprobante de venta (registrar devolución con consecuencias previas, aplicar saldo a favor, devoluciones y aplicaciones), cuentas corrientes (a favor, anticipos, notas de crédito y reintegros), Cobranzas (pestañas Anticipos y Devoluciones), OT (anticipos, imputación en el comprobante, rentabilidad con mano de obra y calidad del dato), presupuesto (anticipos), Tempario (costo interno de mano de obra), artículo (mínimos por depósito), Reposición (vista por depósito), Depósitos, Informes, Caja, Finanzas, Tesorería e Inicio. Impresión `/imprimir/devolucion/:id` (nota de crédito interna, marcada como documento comercial no fiscal) y recibo de anticipo.

## 40. Migración
`migrations/0009_devoluciones_anticipos_rentabilidad.sql`: reconstruye `caja_movimientos` (rubro `devolucion`, origen `reintegro`) y `banco_movimientos` (categoría `devolucion`) copiando todas las filas y recreando sus índices; agrega `ventas.devuelto`, columnas de anticipo en `cobros`, `devoluciones`, `devolucion_items`, `reintegros`, `reintegro_medios`, `credito_aplicaciones`, `usuarios.costo_hora`, `taller_config.costo_hora_general`, `orden_tiempos.costo_hora/costo_origen` (+ trigger), la estimación congelada en `ordenes` y `stock_minimos_deposito`. Aditiva para los datos de negocio. Probada en `tests/api/migraciones.test.ts` sobre datos previos.

## 41. Cambios de comportamiento
- El saldo de un comprobante pasa a ser `total − devuelto − cobrado`; `GET /ventas/:id` incluye `devoluciones` y `creditos`; `GET /cuentas-corrientes` agrega `a_favor` y `devuelto`.
- "Cobros" pasa a llamarse **Cobranzas** y suma las pestañas Anticipos y Devoluciones.
- Anular un cobro de un comprobante con devoluciones, o un anticipo en uso, se rechaza con 409 hasta deshacer esas operaciones.

## 42. Pruebas
`npm run typecheck` y `npm run build` OK. 50 unitarias (incluye `tests/unit/devoluciones.test.ts`) y 237 de integración (en tandas de archivos) OK. Nuevas: `tests/api/devoluciones.test.ts` (17 pruebas: devolución parcial, tope de cantidades e importes, devoluciones simultáneas, reintegro por caja, saldo a favor, anulaciones, consumidor final, permisos, aislamiento entre talleres, anticipos, aplicaciones simultáneas, devolución del anticipo, anticipos en el comprobante de la OT, informes sin doble conteo) y `tests/api/rentabilidad.test.ts` (11 pruebas: costo confidencial, margen parcial/estimado/definitivo, congelamiento histórico, repuestos y devoluciones, mínimos por depósito, informes). Se verifica la consistencia de cuentas corrientes, stock y dinero.

## 43. Pendiente
- Las órdenes de compra no tienen depósito: la reposición por depósito suma por artículo y el destino se elige al recibir.
- Las transferencias siguen siendo inmediatas (sin estado "en tránsito"); no hay comisiones ni liquidación de sueldos.
- Una venta de mostrador no imputa saldo a favor al emitirse: se aplica después desde el comprobante (la OT sí lo hace en el mismo paso).
- Sin pruebas de interfaz automatizadas; la verificación visual fue mínima.

## 44. Despliegue (2026-10-22)
- Respaldo de la D1 remota: `respaldos/d1-antes-sprint09-20261022.sql`; bookmark Time Travel `00000032-00000002-0000510c-8b43b3bf85c16397bf0a958435fd1679`.
- La migración 0009 se ensayó sobre ese respaldo (datos reales: 70 comprobantes, 67 cobros, 165 movimientos de caja, 107 bancarios): mismas filas y mismas sumas, 0 violaciones de claves foráneas, `integrity_check` ok. Luego se aplicó a la D1 remota (única migración pendiente) **antes** de publicar el código; los conteos remotos quedaron idénticos.
- Commit `e037f27` en `main` (push directo; Workers Builds desplegó a las 04:56 UTC). Comprobado: la SPA publicada tiene el mismo bundle que el build local y `/api/salud` responde. No se hicieron operaciones autenticadas en producción (no se usaron credenciales reales).

---

# Sprint 10 — Contabilidad integrada y control administrativo

Trabajo directo sobre `main` (sin ramas, PR ni `gh`). Sin ARCA, sin libros fiscales, sin liquidación de sueldos, sin cambios en licencias, sin integraciones externas. Todo lo contable es **información administrativa interna**; las pantallas y los CSV lo dicen.

## 45. Qué ya existía y se reutilizó
- La sección **Contabilidad** solo tenía registros internos (flujo de caja, libro interno de ventas y de compras, operaciones consolidadas). **No existía** plan de cuentas, asientos, diario, mayor ni balance (la sección 18 lo daba como pendiente). Esos registros se conservaron sin duplicarlos: pasaron a la pestaña **Registros internos** (el "Resumen" de caja se renombró **Flujo de caja** para no confundirlo con el resultado económico).
- Se reutilizaron: los permisos granulares (`contabilidad.ver`, `margenes.ver`, `stock.valorizar`, `informes.exportar`), la exportación autorizada con auditoría (`exportar=1`), el selector de período, los componentes de interfaz, los costos históricos de `venta_items.costo_unitario` (Sprint 08) y de `devolucion_items`, `lib/rentabilidad.ts` (costo de mano de obra, Sprint 09), `lib/proveedores.ts` y `lib/creditos.ts` (saldos de las cuentas corrientes) y los libros de caja y banco como fuente de verdad del dinero.

## 46. Qué se implementó
- **Plan de cuentas por taller** (`cuentas_contables`, `shared/contabilidad.ts`): plan inicial para un taller mecánico (activos: caja, valores a depositar, bancos —una cuenta por cada cuenta bancaria en pesos—, medios electrónicos sin cuenta, deudores, IVA crédito, inventario; pasivos: proveedores, mercadería recibida pendiente de facturar, anticipos y saldos a favor de clientes, cheques propios, IVA débito, obligaciones pendientes; patrimonio; ingresos por repuestos, servicios y otros, con devoluciones como cuentas regularizadoras; costo de repuestos vendidos y de mano de obra; gastos operativos, bancarios, comerciales y diferencias de inventario). Se crea sola y de forma idempotente (ids determinísticos) la primera vez que se consulta. El taller agrega, renombra, reubica y desactiva cuentas; las cuentas "del sistema" (las que usa la automatización) se pueden renombrar pero no eliminar ni desactivar; **una cuenta con movimientos no se elimina ni cambia de naturaleza** (trigger en la base y validación en la API). Cada categoría de gasto se puede asignar a una cuenta contable (por defecto se elige por nombre o tipo).
- **Asientos de partida doble** (`asientos`, `asiento_lineas`): fecha, número correlativo sin saltos (se asigna al registrar), descripción, cuenta, Debe, Haber, origen (tipo, id y evento), modo (manual / automático / histórico / contra-asiento), usuario responsable y taller. Estados **borrador → registrado → revertido**. La base (triggers de la migración 0010) rechaza: registrar un asiento desbalanceado, con menos de dos líneas, sin importes o con una cuenta que es un rubro o está inactiva; modificar o borrar un asiento registrado o sus líneas; revertir sin contra-asiento; revertir dos veces. Las correcciones se hacen con **revertir** (contra-asiento con importes invertidos, vinculado) o **corregir** (revierte y deja el nuevo asiento vinculado al original). Los asientos automáticos no se revierten a mano: se anula la operación de origen.
- **Asientos automáticos** (`worker/lib/contab/`): un proceso idempotente lee las operaciones existentes —sin modificarlas— y genera su asiento. Se ejecuta al consultar la contabilidad (y a pedido) y escribe en lotes atómicos. Idempotencia por **índice único (taller, origen_tipo, origen_id, evento)**: procesar dos veces, o dos consultas simultáneas, no duplica nada (probado). Un documento cuyos importes no cierran **no se contabiliza ni se ajusta**: queda en `contab_omitidos` con el motivo y se informa en Controles. Cada ejecución queda en `contab_corridas`.
- **Libro diario** (filtros por fechas, estado, origen, cuenta y texto; origen y responsable de cada asiento; CSV y PDF por impresión), **libro mayor** por cuenta o rubro (saldo anterior, movimientos con saldo acumulado y origen), **balance de sumas y saldos** (saldo inicial, débitos, créditos y saldo final deudor/acreedor, con inconsistencias a la vista), **estado de resultados**, **resumen contable** en lenguaje llano y **controles de consistencia**. Las exportaciones exigen `informes.exportar` y quedan en la auditoría.
- **Estado de resultados económico (devengado)**: ventas de repuestos, ingresos por servicios (netos de devoluciones), costo de repuestos vendidos (costo histórico), costo de mano de obra (sueldos y jornales registrados), gastos y resultado del período. Se marca **PARCIAL** y se listan los motivos cuando faltan costos históricos, hay operaciones sin contabilizar o con error. El costo de mano de obra imputado a las órdenes (cronómetro/estimación del Sprint 09) se muestra aparte como **información de gestión que no se suma** (los sueldos pagados ya están en el resultado) y con su calidad. Cuando hay ventas sin costo histórico se muestra una **estimación a costo actual separada y rotulada "no es resultado contable"**. Debajo se muestra el **flujo de caja** del mismo período para que no se confundan.
- **Permisos**: todo exige `contabilidad.ver`; se agrega `contabilidad.gestionar` (plan de cuentas, asientos manuales, actualizar/reintentar) que requiere `contabilidad.ver`; el estado de resultados exige además `margenes.ver` (el resumen omite resultados sin ese permiso) y el inventario de los controles `stock.valorizar`. Recepción, caja, mecánico y depósito no acceden a nada (probado). Todo se filtra por `taller_id` de la sesión; las cuentas de otro taller se rechazan.

## 47. Circuitos contabilizados
| Operación | Asiento |
|---|---|
| Venta (comprobante) | Debe Deudores · Haber Ventas de repuestos / Ingresos por servicios (reparto por línea, igual que las devoluciones) y IVA débito · Debe Costo de repuestos vendidos / Haber Inventario con el costo histórico de cada renglón |
| Cobro | Debe caja, banco (la cuenta del espejo bancario), valores a depositar (cheque) o medios sin cuenta · Haber Deudores. **No es un ingreso**: el ingreso nació con la venta |
| Anticipo | Haber **Anticipos y saldos a favor** (pasivo), no una venta |
| Aplicación de saldo a favor | Debe Anticipos · Haber Deudores, sin mover dinero |
| Devolución | Debe Devoluciones (regularizadora) e IVA · Haber Deudores (parte impaga) y Anticipos y saldos a favor (parte ya pagada) · si reingresa al stock: Debe Inventario / Haber Costo de repuestos |
| Reintegro | Debe Anticipos y saldos a favor · Haber caja/banco |
| Compra | Debe Inventario, IVA crédito, otros tributos · Haber Proveedores |
| Recepción de mercadería | Debe Inventario · Haber Mercadería recibida pendiente de facturar |
| Factura / nota de crédito de proveedor | Factura de una orden de compra: Debe Mercadería pendiente (cancela la recepción) · sin orden: Debe Compras sin stock · Haber Proveedores; nota de crédito al revés contra Bonificaciones. La factura asociada a una compra no genera asiento (la deuda ya está en la compra) |
| Pago a proveedor | Debe Proveedores · Haber caja, banco, cheques propios pendientes o valores (cheque endosado) |
| Gasto | Debe cuenta de la categoría · Haber caja/banco/cheques propios |
| Ingreso manual de caja | Debe caja · Haber Otros ingresos |
| Depósito / extracción | Entre caja y banco: sin resultado |
| Transferencia entre cuentas propias | Por una cuenta puente "a compensar" que debe quedar en cero: sin resultado |
| Intereses, comisiones, cheques sueltos | Resultado |
| Ajuste bancario (solo propietario) | Contra "Ajustes bancarios a clasificar" (no se inventa su causa) |
| Cheque acreditado / rechazado | Valores a depositar ↔ banco; el rechazo revierte la acreditación |
| Ajuste/entrada manual de stock, conteos y stock inicial de artículos | Inventario contra Diferencias de inventario (pérdidas y sobrantes) o contra "Entradas de mercadería sin compra (a clasificar)" |
| Saldo inicial de cuentas bancarias y primera caja | Contra "Saldos iniciales y ajustes de apertura" |
| **Anulaciones** (venta, cobro, compra, pago, gasto, devolución, reintegro, recepción, factura, aplicación, movimientos de caja y banco) | Contra-asiento con las líneas invertidas, con la fecha y el responsable de la anulación (de la auditoría o del libro) |

Las transferencias, depósitos y extracciones no generan ingresos; los anticipos no son ventas; los cobros no se cuentan dos veces; las operaciones económicas (devengado) están separadas de los movimientos de dinero.

## 48. Operaciones históricas
- No se modificó ni eliminó ningún comprobante. La migración `0010` solo **crea** tablas, índices y triggers y agrega una columna opcional (`categorias_gasto.cuenta_contable_id`).
- Los asientos de operaciones anteriores se generan con **el mismo proceso idempotente**, con la **fecha original** de la operación, en orden cronológico, marcados `histórico` y registrados en `contab_corridas`. Se pueden volver a ejecutar sin efecto.
- **No se inventa nada**: los comprobantes anteriores al Sprint 08 no tienen costo histórico, así que su costo de ventas **no se contabiliza** (el asiento queda marcado "costo incompleto" y el estado de resultados dice PARCIAL). Los saldos iniciales solo se toman de lo que el sistema registró (cuentas bancarias y primera caja); el inventario existente, las deudas y los créditos anteriores no tienen saldo inicial: se informa en Controles y se cargan con un asiento manual si corresponde. Los cheques cargados a mano sin cobro y las cuentas en moneda extranjera quedan fuera y se informan. Los faltantes/sobrantes de cierres de caja no se asientan (se informan).
- **Ensayo con datos reales** (copia local del respaldo remoto: 70 comprobantes, 67 cobros, 59 gastos, 107 movimientos bancarios…): la migración dejó **idénticas** todas las filas y sumas de las 79 tablas, `integrity_check` ok y 0 violaciones de claves foráneas; el proceso generó 377 asientos (375 históricos) en ~0,3 s, 0 omitidos, balancea (Debe = Haber = 469.213,05 pesos), y una segunda ejecución creó 0. Cuadran exactamente con las operaciones: deudores = cuentas corrientes de clientes, proveedores = deuda con proveedores, caja = libro de caja, cada cuenta bancaria = su saldo, medios electrónicos, cartera de cheques y cheques propios pendientes. El ensayo detectó y corrigió dos casos reales: pagos de compras de contado cuyo `cuenta_id` no se guarda (se usa la cuenta del espejo bancario) y el endoso de un cheque de terceros cargado a mano. Quedan como **avisos** (no como errores): el inventario contable supera al valorizado en ≈ lo que valdrían las ventas sin costo histórico (explicado en el control) y la cuenta de medios electrónicos sin cuenta asignada tiene saldo acreedor (se pagó por transferencia más de lo que se cobró sin indicar cuenta bancaria).

## 49. Controles de consistencia (solo informan: nunca crean movimientos para cuadrar)
Partida doble · cobertura (documentos / contabilizados / sin efecto / con error / pendientes por operación) · Deudores contra cuentas corrientes de clientes · Anticipos contra saldo a favor · Proveedores contra deuda · caja contra libro de caja · cada cuenta bancaria contra su saldo · medios electrónicos sin cuenta · cartera de cheques recibidos y emitidos · transferencias compensadas · inventario contable contra valorizado (con sus componentes: órdenes sin comprobante, ventas sin costo histórico, diferencia sin explicar) · mercadería pendiente de facturar · ajustes bancarios y entradas de stock a clasificar · cheques rechazados con cobro vigente · movimientos sin conciliar · diferencias de cierres de caja · saldos iniciales no determinados.

## 50. Migración y pruebas
- `migrations/0010_contabilidad.sql` (aditiva): `contab_config`, `cuentas_contables`, `asientos`, `asiento_lineas`, `contab_omitidos`, `contab_corridas`, columna `categorias_gasto.cuenta_contable_id` y los triggers de integridad.
- `npm run build` OK. **55 unitarias y 265 de integración** (en tandas de archivos), todas OK. Nuevas: `tests/api/contabilidad.test.ts` (27: plan y reglas de cuentas; cada circuito —compra, venta, cobros, anticipo, aplicación, devolución con reintegro, gastos, ingreso manual, anulaciones, bancos, cheques recibido y propio, ajuste de stock—; todos los controles en "ok"; balance que cuadra; estado de resultados con cifras verificadas y distinto del flujo de caja; reprocesar y consultas simultáneas sin duplicar; mayor con saldo acumulado; asientos manuales desbalanceados, borrador/registrado/revertido, corrección vinculada, automáticos no revertibles; cuentas con movimientos; permisos y aislamiento entre talleres), `tests/unit/contabilidad.test.ts` (plan y partida doble) y la prueba de migraciones ampliada con la 0010 (datos intactos y todos los triggers).
- Verificación en el navegador sobre la copia local con datos reales: resumen, libro diario, controles y estado de resultados.

## 51. Pendiente / fuera de este sprint
- **Cierre de períodos** (bloquear fechas ya cerradas) y asiento de cierre/refundición del resultado: hoy el resultado se calcula por período y no se refunde en patrimonio.
- **Moneda extranjera**: las cuentas bancarias en USD no se contabilizan.
- Los cheques cargados a mano en cartera y las notas de crédito de proveedores no mueven inventario ni se contabilizan hasta que se acreditan/entregan (se informa). Las notas de crédito de proveedor se llevan a "Bonificaciones" sin devolver mercadería al inventario.
- **IVA** solo informativo (no hay liquidación ni libros fiscales); no se distingue monotributo/responsable inscripto en el tratamiento del IVA de compras.
- El inventario se valúa al último costo (el sistema no usa costo promedio): las diferencias por cambios de costo se muestran en el control, no se ajustan.
- La contabilización corre al consultar (no dentro de cada operación): una operación recién cargada aparece en el diario al abrir la contabilidad. No hay presupuestos ni centros de costo.
- Las exportaciones PDF salen del navegador (impresión), igual que el resto de los informes.

## 52. Despliegue (2026-10-22)
- Respaldos de la D1 remota: `respaldos/d1-antes-sprint10-20261022.sql` y `respaldos/d1-antes-sprint10-20261022b.sql` (tomado inmediatamente antes de migrar); bookmark Time Travel previo a la migración `00000034-00000000-0000510c-efefdb1f4d1d168d7491a2656b5a8744`.
- La migración 0010 se ensayó sobre la copia local del respaldo (ver 48) y se aplicó a la D1 remota (única migración pendiente) **antes** de publicar el código. Verificado en remoto: 70 comprobantes (suma 10.691.200,63), 67 cobros, 165 movimientos de caja, 107 bancarios y 80 artículos, idénticos; 0 violaciones de claves foráneas; tablas contables creadas y vacías con sus triggers.
- Commit `a19a2e0` en `main` (push directo; Workers Builds). Comprobado: la SPA publicada es el mismo bundle que el build local (`index-Cgy4E9gR.js`), `/api/salud` responde y `/api/contabilidad/plan` exige sesión (401). No se hicieron operaciones autenticadas en producción (no se usaron credenciales reales): **el plan de cuentas y los asientos históricos del taller demo se generan la primera vez que el propietario abre Contabilidad** (en el ensayo local: 377 asientos, 0 omitidos).

---

# Sprint 11 — Puesta en marcha autónoma e importación de datos

Trabajo directo sobre `main` (sin ramas, PR ni `gh`). Sin ARCA, sin pasarelas de pago ni suscripciones, sin cambios en precios ni en el modelo de licencias. Guía operativa: `docs/IMPORTACION.md`.

## 53. Qué ya existía y se reutilizó
- **Alta de talleres**: `sentenciasAltaTaller` (módulo `provision`) y la API de plataforma (`PLATFORM_ADMIN_TOKEN`, CLI `scripts/platform.mjs`). El alta por invitación **usa la misma función** (no hay un segundo alta). Se le agregaron opciones (`servicios`, `asistente`, `origen`); el alta manual se conserva tal cual.
- **Plantillas**: las listas generales (marcas/modelos, tipos de gasto, categorías de repuestos) pasaron a `shared/plantillas.ts` (antes eran constantes privadas del alta) y se reutilizan para "agregar las que faltan". La plantilla del tempario (`/api/tempario/plantilla/importar`, tiempos orientativos, servicios sin precio) ya existía y es la que usa el asistente.
- **Configuración** (`/api/taller/config`, zona horaria, medios de pago, caja obligatoria, bancos, depósitos, tarifas, equipo y permisos, reloj): el asistente **navega y reutiliza** esas pantallas y endpoints; no los duplica.
- **Permisos granulares**, auditoría, `limites_intentos` (bloqueo por intentos), `sentenciasMovimiento` y el circuito contable de ajustes de stock del Sprint 10.

## 54. Qué se implementó
- **Activación por invitación** (`/api/platform/invitaciones`, `/api/activacion/*`, página `/activar`). Detalle de seguridad en 55.
- **Asistente de puesta en marcha** (*Administración › Puesta en marcha*): 9 pasos — datos del negocio (con provincia y logo), horarios y zona horaria, depósito principal y moneda, categorías y servicios iniciales, mano de obra y precios, listas de precios, empleados y accesos, caja/medios de cobro/bancos y traer datos. Cada paso se **detecta en los datos reales** (no solo en lo marcado), se puede marcar hecho, dejar "para después" o volver a pendiente, y nada bloquea el uso del sistema. Indicador "Configuración del taller: N de 9 pasos completos" en el asistente y en el Inicio. Aparece solo la primera vez en talleres activados por invitación (`asistente_pendiente`); los talleres anteriores no lo reciben.
- **Datos del negocio**: provincia, horarios de atención (hasta dos franjas por día) y logo (PNG/JPG/WebP ≤ 200 KB, validado por firma de archivo, servido con `nosniff` y CSP restrictiva; nunca SVG). El logo se imprime en presupuestos, órdenes y comprobantes.
- **Importación de Excel/CSV** de clientes, vehículos, artículos y proveedores (ver 56–58). Lector de `.xlsx` y CSV propio en el navegador, sin dependencias nuevas.
- **Permiso nuevo** `datos.importar` (propietario y administrador); además se exige el permiso de crear (y editar, si actualiza) de cada tipo, `stock.ajustar` para existencias y los de costo/precio si el archivo los trae.
- **Verificación**: `npm run verificar:online` (solo lectura) y `platform invitar | invitaciones | revocar`.

## 55. Proceso de alta y activación
1. `npm run platform -- invitar [--nombre] [--email] [--adicionales N] [--dias D] [--notas]` (con el token de plataforma, que **nunca llega al navegador**) imprime un enlace `…/activar#<token>` una única vez; en la base queda solo el SHA-256.
2. El propietario lo abre; la página consulta la invitación por POST (el token no viaja en la URL) y lo quita de la barra de direcciones.
3. Completa nombre del taller, su nombre, correo y contraseña (≥ 8; distinta del correo; correo fijo si la invitación lo indica).
4. En **un único batch atómico**: verificación de que la invitación siga pendiente y vigente + alta del taller (licencia con lo invitado, depósito, consumidor final, catálogos generales, **sin servicios con precios ajenos**) + invitación "usada" + auditoría. Inicia sesión y entra al asistente.
- **Un solo uso** (canjes simultáneos: uno 201 y el otro "enlace inválido", probado), **vencimiento** (1–30 días), **revocación**, respuesta idéntica para inválido/usado/vencido/revocado, **límite de intentos por origen** (10 fallos → 30 min), que también protege el token de plataforma. Un correo ya registrado o una contraseña débil **no consumen** la invitación.

## 56. Validaciones y duplicados de la importación
- **Servidor (autoridad)**: campos obligatorios, longitudes, formatos (email, CUIT con dígito verificador, DNI 6–8 dígitos, patente, año 1930–año+1, km, IVA 0/2,5/5/10,5/21/27, unidades, cantidades de hasta 3 decimales, importes en formato argentino o con punto), tamaño del cuerpo (413), lote ≤ 50 filas, total ≤ 5000, huella SHA-256, solo columnas conocidas (no se puede colar `taller_id`, `id`, `activo`, `codigo`…) y permisos por tipo.
- **Duplicados**: *dentro del archivo* (misma clave dos veces → la segunda es error con el número de la primera; también **entre lotes**, contra lo que la misma importación ya creó) y *contra lo existente*. Claves: documento/código anterior (clientes), CUIT/código (proveedores), patente (vehículos), código/código de barras sin distinguir mayúsculas (artículos). **Los nombres nunca son clave.** Un código que apunta a un artículo y un código de barras a otro → error. Los documentos de relleno (ceros, repetidos) se ignoran.
- **Modos**: *omitir duplicados* (carga nuevos; sin identificador se carga como nuevo con aviso), *actualizar existentes* (solo campos que cambian, con **antes → después** en la revisión; una celda vacía nunca borra; conflicto de identificador, otro titular o unidad con movimientos → error; km menor → aviso y no se baja), *solo nuevos* (omite filas sin identificador).
- **Relaciones**: vehículo → cliente por documento, código anterior o (solo si no hay ninguno) nombre exacto **único** con aviso; inexistente/ambiguo/dado de baja → **pendiente de resolver**: el asistente permite elegir el cliente (o crearlo con "Nuevo"), descargar la lista de faltantes o importar primero lo que falta; una resolución con un cliente de otro taller se rechaza. Artículo → categoría (crear opcional) y proveedor (CUIT/código/nombre único). Las marcas y modelos nuevos se crean antes que los vehículos (opcional).
- **Reintentos y lotes**: cada lote es un batch atómico y único por (importación, lote): reenviarlo devuelve lo ya procesado; el mismo archivo con las mismas opciones **retoma** la importación; si cambian datos únicos en medio se replanifica una vez.

## 57. Seguridad y trazabilidad de las importaciones
- Todo con `taller_id` de la sesión; referencias, resoluciones e ids de importación de otro taller → rechazadas o 404 (probado). Con la licencia suspendida solo hay lectura (la validación previa también se bloquea).
- Se registra usuario, fecha, nombre y huella del archivo (no el contenido), tipo, modo, opciones, mapeo, procesados/creados/actualizados/omitidos/errores por importación y por lote, y las filas con error u omitidas (número, referencia corta, motivo; tope 1000) más los registros creados o modificados. Auditoría al iniciar, completar y cancelar.

## 58. Catálogo vs. existencias vs. saldos (y contabilidad)
- Importar catálogos **no crea movimientos de stock, asientos ni saldos** (probado: el libro diario queda idéntico).
- **Existencias iniciales**: opción explícita, con confirmación, permiso `stock.ajustar`, solo artículos nuevos; registra una entrada manual por artículo valorizada al costo (origen = la importación). Se usa el origen `manual` a propósito: es el circuito que Contabilidad ya contabiliza (Inventario / *Entradas de mercadería sin compra (a clasificar)*), así **inventario contable e inventario valorizado siguen coincidiendo** (probado con los controles).
- Los saldos de caja, clientes y proveedores no se importan. Tratamiento en `docs/IMPORTACION.md` (con su límite: todavía no existe un documento de apertura de cuentas corrientes que no pase por resultados).
- El motor contable no se tocó. **Deuda técnica prioritaria**: la sincronización de asientos sigue corriendo al *consultar* Contabilidad. Revisado: está acotada (tope por corrida, idempotente, resumible), de modo que no compromete datos ni impide el uso; pero un `GET` que escribe es frágil frente a lecturas concurrentes y a límites de CPU en una cuenta grande. Trasladarla a un proceso propio (al registrar la operación, a una cola o a un cron) es lo primero del próximo sprint contable.

## 59. Migración
`migrations/0011_puesta_en_marcha_importacion.sql` (aditiva): columnas `talleres.provincia`, `taller_config.{horarios_atencion, logo, asistente_pendiente}`, `clientes.codigo_externo` y `proveedores.codigo_externo` (con índice único parcial por taller); tablas `puesta_marcha_pasos`, `invitaciones_activacion`, `importaciones`, `importacion_lotes`, `importacion_errores`, `importacion_registros`. No modifica ni elimina datos; los talleres existentes quedan con `asistente_pendiente = 0`. La prueba de migraciones comprueba datos intactos, índices únicos, claves foráneas (usuario o lotes de otro taller) y estados válidos.

## 60. Pruebas
- Unitarias: lectura de números y documentos, sugerencia de columnas, normalización por tipo, claves de duplicado y horarios (`importacion.test.ts`, 24); lector CSV/XLSX con un `.xlsx` generado en la prueba, codificaciones y archivo "bomba" (`archivo.test.ts`, 10).
- Integración (Worker real con D1 local aislada): `importacion.test.ts` (23: permisos, los cuatro tipos, modos, diferencias, duplicados entre lotes, referencias y resolución, catálogo sin stock ni asientos, existencias iniciales con controles contables en "ok", límites, aislamiento), `activacion.test.ts` (11: token de plataforma, huella, un solo uso incluso simultáneo, vencida o revocada, correo fijo, bloqueo por intentos), `puesta.test.ts` (11: progreso real, pasos manuales, plantillas idempotentes, catálogo privado no copiado entre talleres, logo seguro) y la migración 0011.
- Verificación en el navegador sobre una instancia local aislada: activación con enlace, asistente (guardado de un paso y avance), importación completa de clientes desde un CSV con errores, duplicado en el archivo y confirmación.

## 61. Despliegue (2026-10-22)
- Respaldo de la D1 remota: `respaldos/d1-antes-sprint11-20261022.sql`; bookmark Time Travel previo a la migración `00000035-00000000-0000510c-dc1b0b209446b5072aaeedb59600de2e`.
- La migración 0011 se ensayó sobre una copia de ese respaldo (86 tablas; 33 clientes, 80 artículos, 70 comprobantes, 4 usuarios, 2 talleres): mismas filas y mismo contenido en todas las tablas, columnas previas idénticas en las cuatro que ganaron columnas, 0 talleres con asistente pendiente, 0 violaciones de claves foráneas e `integrity_check` ok. Luego se aplicó a la D1 remota (única migración pendiente) **antes** de publicar el código. Verificado en remoto: 33 clientes, 80 artículos, 70 comprobantes (suma 10.691.200,63), 67 cobros, 165 movimientos de caja, 107 bancarios y 4 usuarios, idénticos; `foreign_key_check` vacío; tablas nuevas vacías (`PRAGMA integrity_check` no está autorizado en la D1 remota: se hizo sobre la copia).
- Commit `0f40a43` en `main` (push directo; Workers Builds). Comprobado: la SPA publicada es el mismo bundle que el build local (`index-D8e2wPt2.js`) y, **sin sesión**, `/api/salud` responde, `/activar` se sirve, `/api/puesta-en-marcha`, `/api/importaciones`, `/api/platform/*` y `/api/auth/me` exigen autenticación (401) y un enlace de activación inventado responde 404 con el mensaje genérico.
- **No se hizo la verificación con sesión contra producción**: autenticarme con contraseñas en un sitio que no está marcado como entorno de ensayo no está permitido en esta sesión, y la cuenta online no es un entorno aislado. Se dejó `npm run verificar:online` (solo lectura, 41 comprobaciones: disponibilidad, rutas sin sesión, inicio de sesión, navegación y permisos, configuración, asistente, Contabilidad y aislamiento entre talleres, opcional con un usuario de otro taller). Se probó completo contra una instancia local con dos talleres (41/41) y debe ejecutarlo el propietario con sus credenciales de prueba en variables de entorno. Aclaración: la primera consulta a Contabilidad genera el plan de cuentas y los asientos históricos del taller (proceso derivado e idempotente del Sprint 10).

## 62. Pendiente / fuera de este sprint
- **Deuda técnica prioritaria**: sacar la sincronización contable de las consultas de lectura (ver 58).
- **Documento de apertura de cuentas corrientes** (clientes y proveedores) que no pase por resultados, y asistente de saldos iniciales con controles específicos; hoy solo hay el paliativo documentado.
- No se importan listas de precios, servicios, vehículos sin cliente, órdenes ni historial de ventas; `.xls` antiguos no se leen (se pide guardar como `.xlsx` o CSV).
- Importar no se puede "deshacer" en bloque: la importación deja la lista de registros creados o modificados (`importacion_registros`), pero no hay botón de reversión.
- El alta por invitación es solo por línea de comandos (a propósito: el token de plataforma no sale del equipo del operador); no hay panel web de plataforma.
- No hay recuperación de contraseña por correo (no hay envío de mails): sigue siendo "pedile al propietario".
- Sin pruebas de interfaz automatizadas; la verificación visual fue mínima (activación, un paso del asistente y una importación de clientes en un viewport angosto).
