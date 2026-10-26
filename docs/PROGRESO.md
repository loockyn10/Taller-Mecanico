# Progreso del desarrollo · Fierro v0.1.0

Última actualización: 2026-10-24 (Sprint 20: seguimiento público de órdenes, secciones 123 a 129; Sprint 19: hoja de OT en PDF, §118 a §122; Sprint 18: checklist de recepción y entrega, §109 a §117). Documento para retomar el trabajo en nuevas sesiones.

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
| Check-list de ingreso (simple, anterior) | ✅ | ✅ | ✅ |
| Recepción y entrega con daños, fotografías y firma del cliente (Sprint 18, `docs/CHECKLIST.md`) | ✅ | ✅ tablet/celular | ✅ |
| Seguimiento público de la OT con enlace individual, QR y WhatsApp (Sprint 20, `docs/SEGUIMIENTO.md`) | ✅ página pública + gestión | ✅ celular, tablet y escritorio | ✅ |
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

---

# Sprint 12 — Comparación con Caldén y cierre de brechas críticas

Trabajo directo sobre `main` (sin ramas, PR ni `gh`). Sin ARCA, sin servicios externos, sin cambios de precios ni de licencias. Documentos nuevos: `docs/COMPARATIVA_CALDEN.md` (comparativa y plan) y `docs/RESPALDOS.md` (respaldos y recuperación).

## 63. Comparativa (Fases 1 a 3)
- Inventario de **77 funcionalidades** de Fierro verificadas en el código (no en los informes anteriores): 48 completas, 16 implementadas con limitaciones, 4 parciales y 9 no implementadas, cada una con su ruta, módulo o prueba (`docs/COMPARATIVA_CALDEN.md` §2).
- Caldén se compara con tres niveles de evidencia que no se mezclan: **W** (lo anuncia la página pública, leída el 22/10/2026), **O** (lo observó la auditoría de solo lectura del 19/10 en `docs/auditoria/`) y **M** (páginas de módulos generales, que no dicen si forman parte del producto Taller). No se supone nada del funcionamiento interno de Caldén.
- La matriz separa **faltantes**, **errores o inconsistencias de Fierro**, **mejoras de experiencia** e **integraciones externas**, con evidencia de Caldén, estado real, brecha, importancia comercial, complejidad y prioridad (P0–P3). Plan de sprints 13 a 17 en §7 del documento.
- Conclusión explícita: **no hay evidencia suficiente para afirmar que Fierro está listo para 100 talleres** (capacidad no medida, sin copias programadas, sin comprobantes fiscales, sin pruebas de interfaz).

## 64. A — Sincronización contable controlada (P0 resuelto)
- **Antes:** consultar Contabilidad ejecutaba `sincronizar` (un `GET` que escribía asientos).
- **Ahora:** ningún `GET` contable escribe. Sin activación responden `409 contabilidad_no_activada`. `POST /contabilidad/activar` (permiso `contabilidad.gestionar`) crea el plan y contabiliza **una sola vez** lo ya operado como *histórico* (idempotente, reanudable); `POST /contabilidad/sincronizar` queda como acción explícita; `GET /contabilidad/estado` informa si está activada, al día, pendientes por origen, anulaciones pendientes, errores, proceso en curso y último error.
- **Mantenimiento automático** (`worker/index.ts`): después de una operación comercial exitosa (ventas, cobros, anticipos, devoluciones, compras, pagos, gastos, caja, bancos, cheques, stock, órdenes, depósitos, aperturas, importaciones) se contabiliza lo nuevo en segundo plano (`waitUntil`; en las pruebas la variable `CONTAB_SYNC=esperar` lo hace determinista), solo en talleres activados y sin alterar nunca la respuesta de la operación.
- **Coordinación** (`sincronizarControlado`): un turno con vencimiento (90 s) por taller en `contab_config`; si llega una operación con otro proceso corriendo se deja un pedido y el proceso en curso repite; un proceso caído no bloquea para siempre.
- **Interfaz:** Contabilidad › Activación (con vista previa por origen), aviso «N operaciones todavía no se contabilizaron» con «Actualizar ahora» y refresco automático mientras haya pendientes.
- **Integridad:** índice único `(taller, origen, id, evento)` (sin duplicados), numeración correlativa, comprobantes originales intactos. Probado en `tests/api/sync-contable.test.ts` (14 pruebas): sin activar no se escribe nada (se compara la base antes y después), activar crea lo histórico una vez, activar de nuevo es inocuo, ningún `GET` crea asientos, venta y cobro se contabilizan solos, anulación genera el contra-asiento, 6 operaciones simultáneas = 6 asientos correlativos sin duplicados, estado pendiente visible con otro proceso en curso, turno vencido, aislamiento entre talleres.
- **Hallazgo propio corregido:** al sumar la fuente de aperturas, un alias SQL (`a`) coincidía con el de la subconsulta `sinAsiento` y la fuente volvía a proponer su alta en cada pasada (inocuo por la idempotencia, pero impedía el contra-asiento de la anulación). La prueba de anulación lo detectó; ahora la fuente usa otro alias y el código lo advierte.
- **Límite:** el costo de cada pasada crece con la cantidad de documentos del taller (se relee cada fuente). Correcto y acotado; la contabilización incremental queda como P1 (§7 de la comparativa).

## 65. B — Saldos de apertura
- **Ya existían:** caja (efectivo inicial de la primera caja), bancos (saldo y fecha al crear la cuenta) e inventario (stock inicial valorizado), todos contra patrimonio.
- **Nuevo — proveedores** (`worker/modules/aperturas.ts`, `src/pages/config/AperturaSaldos.tsx`, migración 0012): saldos con fecha de corte, sistema de origen, usuario y fecha; tipeados o leídos de Excel/CSV con **revisión previa sin escritura**; proveedor por id, CUIT, código anterior o nombre único; una sola apertura vigente por proveedor (índice único: reintentos y cargas repetidas no duplican); aviso y confirmación expresa si el proveedor ya tiene compras o pagos anteriores al corte; saldos a favor admitidos; entra a la cuenta corriente, a los vencimientos y a la deuda total (`lib/proveedores.ts`); se paga con los pagos de siempre; **no crea compras, stock ni ventas**; en contabilidad Debe *Saldos iniciales y ajustes de apertura* (patrimonio) / Haber *Proveedores*, así que **no toca el estado de resultados**; inmutable en la base (triggers), se anula —solo si no tiene pagos aplicados— con contra-asiento. Permiso nuevo `aperturas.gestionar` (propietario y administrador). `tests/api/aperturas.test.ts` (18 pruebas) y la prueba de migración 0012.
- **Abierto — clientes:** requiere un documento de apertura que se pueda **cobrar** sin pasar por `ventas`; hay 61 consultas sobre `ventas` en 15 archivos, 10 sobre `cobro_aplicaciones` y 16 sobre `credito_aplicaciones`. No se publicó nada a medias; el diseño está en `docs/COMPARATIVA_CALDEN.md` §6.B (dependencia: hacerlo antes de ARCA).
- Cuando el origen es incompleto la pantalla informa fila por fila (error o aviso con el motivo) y no guarda hasta corregir o confirmar.

## 66. C — Verificación online
- `scripts/verificar-online.mjs` reescrito: solo lectura **forzada por el propio script** (bloquea todo pedido que no sea `GET` salvo iniciar/cerrar sesión, la validación previa de importaciones y una consulta de activación con un enlace inventado); no activa ni sincroniza la contabilidad; si está activada comprueba que consultarla no cambia nada; cubre login, permisos y navegación (incluido un usuario limitado opcional, `FIERRO_EMAIL_C`), clientes, vehículos, OT, inventario (stock por depósito, negativos, valorizado), cuentas corrientes, contabilidad y aislamiento multiempresa (`FIERRO_EMAIL_B`). Credenciales solo por variables de entorno; no imprime contraseñas ni cookies.
- Ensayado contra una instancia local aislada con dos talleres y tres usuarios: **88/88** con la contabilidad sin activar y **91/91** activada (corregí en el camino tres expectativas del propio script).

## 67. Respaldos y recuperación (Fase 5)
- `scripts/respaldo.mjs` + `scripts/respaldo-lib.mjs` (`npm run respaldo`): `plataforma` (export remoto + bookmark de Time Travel + ensayo de restauración en memoria + manifiesto con SHA-256), `verificar`, `ensayar-migraciones` (aplica las pendientes a una copia en memoria y demuestra que los datos previos quedan idénticos), `talleres` y `exportar-taller` (JSON + CSV de **un** taller, sin credenciales ni tablas de la plataforma, abortando ante cualquier fila ajena y omitiendo tablas sin `taller_id`). `tests/unit/respaldo.test.ts` (7 pruebas) y ejecución real sobre el respaldo de producción.
- **Evaluación** (`docs/RESPALDOS.md`): respaldo de plataforma disponible pero manual y sin copia fuera de la cuenta; exportación por taller disponible solo para el operador; restauración ante incidente por Time Travel (toda la base) o `.sql` en una base nueva; **no existe restaurar un solo taller y no se improvisó** (claves compuestas, secuencias, stock y contabilidad inmutable); propuesta segura en cuatro pasos (restaurar siempre a un taller nuevo con remapeo de ids y controles) priorizada como P2; exportación por el propietario como P1; copias programadas y externas como P0 operativo abierto.

## 68. Migración 0012 (aditiva)
`migrations/0012_sincronizacion_contable_aperturas.sql`: columnas de `contab_config` (`sync_bloqueo_hasta`, `sync_solicitada`, `ultimo_error`, `ultimo_error_at`, `activada_por`); tablas `aperturas_saldos` y `aperturas_saldos_items` con claves compuestas, índice único de un solo saldo vigente por proveedor y triggers de inmutabilidad. No modifica ni elimina datos. La prueba de migraciones (`tests/api/migraciones.test.ts`) comprueba datos intactos, que un taller con la contabilidad ya generada sigue activado, y todas las restricciones nuevas.

## 69. Pruebas
`npm run typecheck` y `npm run build` OK. **96 unitarias y 344 de integración (21 archivos), todas OK** en una única corrida completa. Nuevas: `tests/api/sync-contable.test.ts` (14), `tests/api/aperturas.test.ts` (18), la prueba de la migración 0012 en `tests/api/migraciones.test.ts` y `tests/unit/respaldo.test.ts` (7). Las suites de contabilidad e importación se adaptaron a la activación explícita (se activa en la preparación de la prueba). `tests/api/global-setup.ts` levanta el Worker con `CONTAB_SYNC=esperar` para que la contabilización posterior a cada operación sea determinista. Verificación en el navegador sobre una instancia local aislada (no se tocó la instancia del usuario en 5173/8787): panel de activación y activación (24 operaciones históricas), pantalla de Apertura de saldos con revisión previa y aviso por operaciones previas del proveedor.

## 70. Despliegue (2026-10-22)
- **Respaldo** previo a la migración con `npm run respaldo -- plataforma --etiqueta antes-sprint12`: `respaldos/d1-antes-sprint12-20261022-1908.sql` (SHA-256 `8aba0de92f446456a73382e6359847ce49628ff6ff2e488faf8ef91fb8bd181e`), verificado en memoria (integridad ok, 0 claves foráneas rotas, 92 tablas, 3.749 filas, 2 talleres, 11 migraciones aplicadas); bookmark de Time Travel `0000003a-00000004-0000510c-f200400936d58420cda5d3c711a63316`.
- **Ensayo** de la migración 0012 sobre la copia en memoria de ese respaldo (`npm run respaldo -- ensayar-migraciones`): 92 tablas y 3.749 filas **idénticas** (mismo contenido en las columnas previas), 2 tablas nuevas, 5 columnas nuevas en `contab_config`, integridad ok y 0 claves foráneas rotas.
- **Aplicada** a la D1 remota (única migración pendiente) **antes** de publicar el código, que es compatible con la base anterior y con la nueva. Comprobado en remoto después de migrar: 90 tablas de negocio con **3.738 filas, 0 diferencias** frente al respaldo (excluidas `d1_migrations` y `tx_guard`), `PRAGMA foreign_key_check` vacío, 12 migraciones registradas, ventas por 10.691.200,63 y 67 cobros, igual que antes; `aperturas_saldos` y `aperturas_saldos_items` vacías; `contab_config` vacía (ningún taller tiene la contabilidad activada: se activa desde Contabilidad › Activación, ya no al consultar). No se borró ningún dato comercial.
- **Publicación:** commit `439bc5e` en `main` (push directo; Workers Builds). Comprobado: la SPA publicada es el mismo bundle que el build local (`index-Dq-pKuD8.js`), `/api/salud` responde y, **sin sesión**, `/api/contabilidad/estado`, `/api/contabilidad/plan`, `/api/aperturas`, `/api/aperturas/estado`, `/api/clientes` y `/api/auth/me` exigen autenticación (401), `/activar` y `/apertura-saldos` se sirven y un enlace de activación inventado responde 404.
- **Verificación con sesión contra producción: no la ejecuté yo.** Autenticarme con contraseñas en un sitio que no está marcado como entorno de ensayo no está permitido en esta sesión y el entorno no tenía `FIERRO_EMAIL`/`FIERRO_PASSWORD`. Para correrla (solo lectura, no activa la contabilidad): `FIERRO_URL=https://taller-mecanico.estrubia455.workers.dev FIERRO_EMAIL=… FIERRO_PASSWORD=… npm run verificar:online` (opcionales `FIERRO_EMAIL_B`/`FIERRO_PASSWORD_B` de otro taller y `FIERRO_EMAIL_C`/`FIERRO_PASSWORD_C` de un rol limitado). El mismo script se ejecutó completo contra la instancia local aislada (88/88 y 91/91).
- **Para los talleres existentes:** la contabilidad de ninguno está activada (`contab_config` vacía). Al abrir Contabilidad el propietario ve el panel de activación con la vista previa de lo que se va a generar; hasta que la active, las pantallas contables quedan vacías y las operaciones no se contabilizan.

## 71. Pendiente / fuera de este sprint
- **Saldos de apertura de clientes** (P0 abierto, diseño en la comparativa §6.B).
- **Copias programadas y fuera de la cuenta de Cloudflare** (P0 operativo, requiere decisión) y **medición de capacidad** (CPU del login, filas leídas/escritas, proyección a 100 talleres).
- **Contabilización incremental** (P1) para que el costo por operación no crezca con el historial.
- Plan ordenado de sprints 13 a 17 (P1 y P2) en `docs/COMPARATIVA_CALDEN.md` §7.
- Quien tenga su instancia local abierta (`npm run dev`) debe aplicar la migración 0012 (`npm run db:migrate`) y reiniciarla: el código nuevo usa columnas y tablas nuevas.

---

# Sprint 13 — Estabilidad, escalabilidad y respaldos

Trabajo directo sobre `main` (sin ramas, PR ni `gh`). Sin ARCA, sin funciones comerciales nuevas, sin cambios de precios, licencias ni rediseño de la interfaz. Documentos nuevos: `docs/CAPACIDAD.md` (medición de capacidad) y `docs/INCIDENTES.md` (guía de recuperación ante incidentes); `docs/RESPALDOS.md` se amplió (§7 y §8).

## 72. Contabilización incremental y recuperable (Objetivo 1)
- **Problema (Sprint 12):** cada operación comercial releía todos los documentos de las 16 fuentes contables (costo proporcional al historial) y dependía de una tarea en segundo plano (`waitUntil`) que podía perderse.
- **Cola persistente `contab_cola`** (migración 0013). Triggers `AFTER INSERT / AFTER UPDATE OF estado` sobre las tablas de origen (ventas, cobros, aplicaciones de crédito, devoluciones, reintegros, compras, recepciones, facturas y pagos de proveedor, gastos, ingresos manuales de caja, movimientos bancarios propios, ajustes de inventario, saldos de apertura) dejan el pedido **en la misma transacción que la operación**: si se confirma, el pedido existe; si se revierte, no (probado a nivel SQL en `tests/api/migraciones.test.ts`). Solo se encola en talleres con la contabilidad **activada** (la activación sigue siendo explícita; nada se activó automáticamente).
- **Proceso (`worker/lib/contab/sync.ts`):** el modo `cola` lee los pedidos vencidos y consulta **solo esos documentos** (las fuentes aceptan una lista de ids). El pedido sale de la cola en el **mismo batch atómico que su asiento** y únicamente si el asiento quedó registrado (`DELETE … WHERE EXISTS (asiento registrado)`): nunca figura como contabilizado antes de tiempo. Se conservan la partida doble (triggers de la base), la idempotencia (índice único por taller/origen/evento), el turno por taller, las anulaciones con contra-asiento y el aislamiento por `taller_id`.
- **Reintentos y recuperación:** un pedido que falla vuelve a la cola con su motivo y una espera creciente (1, 5, 15, 60, 240 min); a los 6 intentos pasa a `fallida` (visible, sin perderse, sin bucles) y se destraba con «Reintentar». Una anulación cuyo alta todavía no está contabilizada **espera** (no se descarta). Una fuente que no se puede leer deja en espera a todos sus pedidos. La operación comercial nunca se bloquea ni se pierde.
- **Cron Trigger gratuito** (`wrangler.jsonc › triggers.crons`, cada 5 min): drena colas pendientes de cualquier taller, avanza reconciliaciones y deja un latido. Así, aunque un Worker termine antes de contabilizar, nadie tiene que volver a operar para que se recupere.
- **Datos históricos y activación:** la **reconciliación** (el recorrido completo de siempre) pasó a ser un proceso **por lotes y reanudable**: hasta 400 asientos por pedido HTTP o tick del Cron, con el progreso en `contab_config.reconciliar_pendiente`. `POST /contabilidad/activar` la dispara una vez; mientras corre, las operaciones nuevas entran por la cola sin esperar. `POST /contabilidad/sincronizar {"completa": true}` pide una verificación completa; el mantenimiento agenda una por taller por semana, escalonada. Probado con 430 ventas de historial (`tests/api/cola-contable.test.ts`): 2 pasadas, 431 asientos, sin duplicados, numeración correlativa, partida doble cuadrada.
- **Consultas:** los `GET` siguen sin escribir. `GET /contabilidad/estado` ahora es **liviano** (sale de la cola y de contadores, 73 filas leídas con 3.000 ventas); la cobertura por tipo de operación (`?detalle=1`, recorre el historial) solo se pide en la activación. Nuevo `GET /contabilidad/cola` (pedidos con su último error). La pantalla muestra «Reintentar» / «Continuar» según el caso.
- **No se modifican comprobantes originales** (verificado en las pruebas).
- 14 pruebas nuevas de integración (`tests/api/cola-contable.test.ts`): pedido persistido cuando el proceso no llega a correr y recuperado por el mantenimiento; fallo inyectado en el asiento con reintento y espera; agotamiento de reintentos → `fallida` + alerta de plataforma; anulación esperando su alta; aislamiento entre talleres; lectura sin escritura; reconciliación por lotes; pérdida simulada del pedido recuperada por la verificación completa; agenda semanal.

## 73. Cuellos de botella encontrados y corregidos (Objetivo 4)
Detalle y cifras en `docs/CAPACIDAD.md` §2. Resumen:
1. Recorrido completo de las 16 fuentes por operación → cola incremental (**9.395 → 127 filas leídas** por venta con 3.000 de historial; ~60 → 19–21 consultas a D1).
2. **El número de asiento (`MAX(numero)+1`) y el contador del estado recorrían el libro del taller** por usar el índice equivocado → `AND numero IS NOT NULL` usa el índice parcial (**6,5 ms → 0,001 ms** con 200.000 asientos; una venta con 3.000 de historial pasó de 3.170 a 127 filas).
3. **Faltaban índices** de `cobro_medios`, `cobro_aplicaciones`, `compra_items` y `recepcion_items` por documento (un cobro leía 3.535 filas → 143).
4. **El tablero** (se refresca cada 60 s por pestaña) recorría todas las ventas → rango de fechas + índice parcial de lo pendiente de cobro.
- Pendientes de rendimiento (no críticos hoy): informes proporcionales al historial por diseño (balance contable, cuentas corrientes); ver `docs/CAPACIDAD.md` §6.

## 74. Respaldos automáticos (Objetivo 2) — estado real
- **Reutiliza** `npm run respaldo`. Nuevos subcomandos: `programado` (exporta la D1 completa, la verifica —integridad, claves foráneas, migraciones, controles contables—, la comprime y **cifra** con una clave pública RSA-4096 + AES-256-GCM, comprueba que el cifrado se deshace y deja el `.fbk` y un manifiesto sin datos comerciales; avisa a la plataforma si hay token), `generar-claves`, `descifrar` y `restaurar-aislado`. El SQL sin cifrar solo existe en una carpeta temporal que se borra siempre; **nada de esto se guarda en git** (`respaldos/` sigue ignorado).
- **Workflow de GitHub Actions** `.github/workflows/respaldo-d1.yml` (gratuito): todos los días a las 03:17 hora de Argentina, artefacto cifrado con retención de 14 días (domingos: 90), falla ruidosamente si falta configuración. El repositorio es **público**: por eso nada se sube sin cifrar y los registros solo muestran cantidades.
- **Ejecutado de verdad:** el procedimiento completo (`programado` contra la D1 de producción, cifrado, descifrado con la clave privada y restauración) corrió desde esta computadora con claves descartables: respaldo de 1,58 MB → 0,23 MB cifrado, SHA-256 idéntico al respaldo manual hecho aparte (ver §75). 9 pruebas unitarias del cifrado (alteración, truncamiento, otra clave, cabecera modificada, claves débiles).
- ❌ **El workflow de GitHub Actions NO se ejecutó todavía** y **no hay copia automática fuera de Cloudflare hasta que lo haga**. Falta, y solo puede hacerlo el propietario (detalle y pasos en `docs/RESPALDOS.md` §7): (1) generar el par de claves y guardar la **privada** fuera de GitHub y Cloudflare; (2) variable `FIERRO_RESPALDO_CLAVE_PUBLICA`; (3) secretos `CLOUDFLARE_API_TOKEN` (permiso «D1: Edit») y `CLOUDFLARE_ACCOUNT_ID`; (4) opcional: secreto `BACKUP_REPORT_TOKEN` (también en el Worker) y variable `FIERRO_URL` para el aviso; (5) correr *Run workflow* una vez y probar abrir el artefacto. No se contrató ni se creó ningún servicio; el límite de retención (90 días) y el cupo de artefactos (500 MB) están documentados con la cuenta de cuánto dura.

## 75. Recuperación verificada sobre una instancia aislada
`npm run respaldo -- restaurar-aislado <archivo> [--clave-privada …] [--migrar] [--servir]`: restaura en un D1 **local** temporal (no acepta `--remote`), compara tabla por tabla, corre integridad, claves foráneas y controles contables, y con `--servir` levanta el Worker sobre lo restaurado.
- **Producción (cifrado → restauración):** 94 tablas y 3.750 filas idénticas, integridad ok, 0 claves foráneas rotas, 2 talleres; con `--migrar` el Worker arrancó y la API de plataforma listó los 2 talleres. (Los talleres de producción aún no tienen la contabilidad activada: sin asientos reales en esta prueba.)
- **Base con contabilidad** (4 talleres ficticios, 2.048 asientos, 7.480 líneas): tablas, índices y triggers recuperados; 0 asientos descuadrados, sin líneas ni duplicados, numeración sin saltos, Debe = Haber en cada taller, cola vacía, aplicación funcionando.
- **No se implementó la restauración de un solo taller** (la integridad no puede garantizarse; igual que en el Sprint 12). Guía de incidentes: `docs/INCIDENTES.md`.

## 76. Seguridad de la autenticación (Objetivo 3)
Revisado: el inicio de sesión bloqueaba por cuenta (5 fallos → 15 min), lo que permitía a un tercero dejar afuera a cualquiera repetidamente, **respondía distinto** según existiera o no la cuenta (429 solo para las existentes; el correo inexistente salía sin verificar contraseña: filtración por respuesta y por tiempo) y no dejaba constancia. Ahora (`worker/lib/seguridad.ts`, reutilizando `limites_intentos`):
- Tres contadores: **origen** (25 fallos/15 min → 15 min), **cuenta + origen** (5/15 min → 15 min) y **cuenta** (30/60 min → 10 min, que **no rige** para orígenes desde los que esa cuenta ya entró bien en los últimos 30 días: un tercero no puede dejar afuera a la persona legítima). Todos vencen solos; no hay bloqueos permanentes.
- **Respuesta uniforme:** correo inexistente, cuenta sin acceso y clave incorrecta responden lo mismo; siempre se verifica una contraseña (hash de relleno con las mismas iteraciones), así el tiempo tampoco delata; el bloqueo depende solo de lo que mandó quien intenta.
- **Eventos de seguridad** (`eventos_seguridad`, 90 días): fallos, bloqueos aplicados y token de plataforma inválido, con **huellas de 12 caracteres** del origen y la cuenta: nunca contraseñas, correos ni IP.
- 11 pruebas nuevas (`tests/api/login-seguridad.test.ts`).

## 77. Observabilidad mínima (Objetivo 6)
Sin plataformas externas ni costo: (a) `GET /api/platform/salud` y `npm run platform -- salud` (mantenimiento y su latido, cola contable por taller, fallidas, errores de contabilización, eventos de seguridad de 24 h, errores del Worker y último aviso de respaldo externo, con **alertas** en lenguaje claro); (b) `errores_worker`: los 500 se agrupan por método + ruta normalizada + mensaje depurado (sin correos, números largos ni valores entre comillas), con contador; los registros del Worker tampoco llevan datos; (c) `POST /api/plataforma/respaldo-latido` con un token propio y mínimo (`BACKUP_REPORT_TOKEN`, distinto del de plataforma) para que el respaldo externo avise éxito o fallo; (d) `npm run platform -- mantenimiento` fuerza el mismo mantenimiento que el Cron. 8 pruebas de integración y 2 unitarias nuevas.

## 78. Medición de capacidad (Objetivo 4)
`npm run carga` (`scripts/carga/`): instancia **local y aislada** con datos ficticios, medición de D1 por solicitud, modos `escala`, `mixto`, `curva` y `login`. Resultados y condiciones en `docs/CAPACIDAD.md`. Resumen: 10 talleres, 20 usuarios simultáneos, 2.121 operaciones en 30 s (70 op/s en un proceso local), **0 errores**, contabilidad al día y asientos cuadrados en todos; el costo por operación ya no crece con el historial. **No se afirma que Fierro soporte 100 talleres**: no se midió contra D1 real (latencia de red, contención de escrituras) ni se tienen datos de uso reales; con el plan gratuito de D1 el modelo indica que no alcanza (≈ 5 talleres por las lecturas del tablero), con el pago hay holgura bajo supuestos a validar.

## 79. Verificación online (Objetivo 5)
- `npm run verificar:online` conserva su garantía de **solo lectura** y ahora acepta `--url=` y `--env-file=` (carga las variables desde un archivo local ignorado por git, p. ej. `.env.demo-remoto`, para que las contraseñas no pasen por la línea de comandos; con ese archivo usa demo@fierro.local como taller A y pruebas@fierro.local como taller B para el aislamiento). Verifica además la cola contable (Sprint 13).
- **Ejecutada contra una instancia local aislada** (dos talleres, un usuario de rol limitado, contabilidad activada): **94 de 94** comprobaciones (autenticación, permisos, navegación, clientes, vehículos, órdenes, inventario, contabilidad, aislamiento multiempresa, configuración); la salida no contiene contraseñas. Corregí una expectativa del propio script (proveedores es visible también con `catalogo.ver`).
- ❌ **Contra producción con sesión: no la ejecuté.** Las credenciales DEMO y PRUEBAS están en `.env.demo-remoto` (ignorado por git), pero esta sesión **no inicia sesión con contraseñas en un sitio que no es de ensayo**, aunque el archivo exista; no leí ese archivo. Comando preparado, para correr en tu terminal:
  ```bash
  npm run verificar:online -- --url=https://taller-mecanico.estrubia455.workers.dev --env-file=.env.demo-remoto
  ```
  Sin sesión, lo publicado sí se verificó (ver §82).

## 80. Migración 0013 (aditiva)
`migrations/0013_cola_contable_seguridad_observabilidad.sql`: tabla `contab_cola` y sus índices; columnas `reconciliar_pendiente` y `reconciliada_at` en `contab_config` (marca para reconciliar a los talleres que ya tuvieran la contabilidad generada: hoy ninguno); 30 triggers de encolado; tablas `eventos_seguridad`, `errores_worker` y `plataforma_latidos`; 5 índices (`cobro_medios`, `cobro_aplicaciones`, `compra_items`, `recepcion_items` y el parcial `idx_ventas_por_cobrar`). No modifica ni elimina datos. Ensayada sobre el respaldo de producción (94 tablas / 3.750 filas idénticas) y cubierta por `tests/api/migraciones.test.ts` (atomicidad del pedido con la operación, taller sin activar, claves y estados).

## 81. Pruebas
`npm run typecheck`, `npm run build` OK. **107 unitarias y 378 de integración (24 archivos), todas OK** en una única corrida completa. Nuevas: `cola-contable` (14), `login-seguridad` (11), `observabilidad` (8 + 2 unitarias), `respaldo-cifrado` (9), la de la migración 0013 y los ajustes de `seguridad` (el cliente de pruebas ahora se presenta con su propio origen). Una prueba de concurrencia del Sprint 12 falló **una sola vez** durante una corrida completa en paralelo con otros procesos y no se reprodujo en 3 ejecuciones aisladas del archivo, 510 ventas concurrentes adicionales (parte de ellas con carga de CPU artificial) ni en las dos corridas completas posteriores; se dejó la aserción con el detalle de las respuestas para diagnosticarla si reaparece.

## 82. Despliegue (2026-10-22)
- **Respaldo previo** con `npm run respaldo -- plataforma --etiqueta antes-sprint13`: `respaldos/d1-antes-sprint13-20261022-2211.sql` (SHA-256 `c5efac88b673e007454b064e35e12c0f0089a87774eacfb875c67a94f0f49406`), verificado en memoria (integridad ok, 0 claves foráneas rotas, 94 tablas, 3.750 filas, 2 talleres, 12 migraciones); bookmark de Time Travel `0000003c-00000000-0000510c-3035fad2b458386e57c964721c6cb8b3`.
- **Ensayo** de la 0013 sobre ese respaldo (`ensayar-migraciones`): 94 tablas y 3.750 filas **idénticas**, 4 tablas nuevas, 2 columnas nuevas en `contab_config`, integridad ok.
- **Aplicada** a la D1 remota (única migración pendiente) **antes** de publicar el código (que es compatible con la base anterior y con la nueva). Comprobado con un segundo respaldo (`d1-despues-sprint13-20261022-2235.sql`): las 94 tablas existentes, **sin ninguna diferencia** de contenido; integridad ok; 0 claves foráneas rotas; 13 migraciones; ventas 70 por 10.691.200,63 y 67 cobros, igual que antes; contabilidad de ningún taller activada (cola vacía).
- **Publicación:** commit `622a988` en `main` (push directo; Workers Builds). La SPA publicada es el mismo bundle que el build local (`index-CqXTeBBk.js`). Sin sesión: `/api/salud` 200; `/api/auth/me`, `/api/clientes`, `/api/contabilidad/estado` y `/api/contabilidad/cola` 401; `/api/platform/salud` sin token 401 (y quedó el primer evento de seguridad registrado); el aviso de respaldo sin token 401 (antes del despliegue esa ruta no existía: confirma que corre el código nuevo); `/activar` 200. En la D1 remota: 0 errores del Worker, cola vacía, `PRAGMA foreign_key_check` vacío.
- **Hallazgo de despliegue:** Workers Builds publica con `wrangler versions upload` (la versión figura como `version_upload`), y ese camino **no registra los Cron Triggers**. El Worker ya exponía el manejador `scheduled`, pero el Cron no corría. Lo registré a mano con `npx wrangler triggers deploy --name taller-mecanico` (gratuito; muestra `schedule: */5 * * * *`) y **verifiqué una ejecución real**: `plataforma_latidos.mantenimiento` = 2026-10-22T22:50:59Z, `ok`, 0 talleres con cola, 0 errores. Los Cron Triggers son una configuración del Worker (no de cada versión), así que los despliegues siguientes la conservan; si algún día se cambia la lista de crons en `wrangler.jsonc`, hay que repetir ese comando (anotado en `docs/INCIDENTES.md` §1).
- **Para los talleres existentes:** la contabilidad de ninguno está activada; sigue siendo explícita (Contabilidad › Activación). Al activarla se genera lo histórico por lotes y después se mantiene por la cola.
- **Quien tenga su instancia local abierta** (`npm run dev`) debe aplicar la migración 0013 (`npm run db:migrate`) y reiniciarla.

## 83. Estado de los entregables y limitaciones pendientes
| Entregable | Estado |
|---|---|
| Sincronización contable incremental y recuperable | ✅ Publicada y probada (local: 378 pruebas de integración). El Cron corre en producción. Ningún taller de producción tiene la contabilidad activada todavía, por lo que **no se ejercitó con datos reales de producción** |
| Respaldos programados | 🟡 **Preparados, no operativos**: el workflow de GitHub Actions no se ejecutó (faltan variables y secretos del propietario). El procedimiento sí se ejecutó y verificó de punta a punta desde esta computadora contra la D1 de producción |
| Protección del inicio de sesión | ✅ Publicada y probada |
| Mediciones de rendimiento | ✅ Hechas en instancia local aislada. 🟡 **Sin medición contra D1 real**: no se puede afirmar que soporte 100 talleres |
| Verificación online autenticada | 🟡 94/94 contra una instancia local aislada; **no ejecutada contra producción con sesión** (restricción de esta sesión: no inicia sesión con contraseñas en un sitio que no es de ensayo). Comando listo en §79 |
| Documentación de recuperación | ✅ `docs/INCIDENTES.md`, `docs/RESPALDOS.md` §7–§8 |

**Problemas críticos / pendientes (ordenados):**
1. **P0 operativo:** cargar la configuración de `docs/RESPALDOS.md` §7 y lograr **una ejecución real en verde** del workflow *Respaldo D1* (más una prueba de apertura del artefacto con la clave privada). Hasta entonces una pérdida de la cuenta de Cloudflare no es recuperable.
2. **P0:** saldos de apertura de **clientes** (diseño en `docs/COMPARATIVA_CALDEN.md` §6.B), antes de ARCA (sin cambios desde el Sprint 12).
3. **P1:** medición de capacidad contra una D1 real **de ensayo** (no la de producción): requiere crear un Worker y una D1 aparte (decisión del propietario) y reemplazar los supuestos de `docs/CAPACIDAD.md` §5 con Analytics de D1 de uso real. Verificar de qué plan de Cloudflare se trata: con el gratuito de D1 el modelo indica que no alcanza para más de unos pocos talleres.
4. **P1:** correr `npm run verificar:online -- --url=… --env-file=.env.demo-remoto` contra producción desde la terminal del propietario.
5. **P1:** límites por invocación de Cloudflare (consultas a D1, CPU del inicio de sesión de ~60 ms con 100.000 iteraciones) no verificados con el plan real; una pasada de reconciliación de 400 asientos hace decenas de consultas.
6. **P2:** el tablero se refresca cada 60 s y concentra las lecturas del modelo de consumo (pasarlo a 5 min recorta ~80 %); informes proporcionales al historial (balance contable, cuentas corrientes) sin paginar.
7. **P2:** una prueba de concurrencia del Sprint 12 falló una vez en una corrida completa sin reproducirse (§81); está instrumentada para diagnosticarla.
8. Heredados: exportación de datos por el propietario desde la app, restauración de un taller a un taller nuevo, interfaz sin pruebas automáticas.

---

# Sprint 14 · Evolución visual y responsive integral (2026-10-23)

Sólo interfaz: **sin cambios en el servidor, la base, las migraciones, los permisos ni los cálculos** (el diff toca únicamente `src/`, `public/`, `index.html`, `vite.config.ts`, `scripts/icons.mjs` y este documento).

## 84. Sistema visual adoptado
Todo sale de los tokens de `src/index.css` (`@theme`); ninguna pantalla define los suyos. Para cambiar la identidad basta con tocar ese bloque.
- **Fondo y superficies:** `fondo` gris azulado (#edf1f5), `superficie` blanca, `superficie-2` gris muy claro (cabeceras de tabla, pies de modal, paneles), bordes `borde` / `borde-suave` / `borde-fuerte` (campos).
- **Marca:** escala `marca-*` en **azul acero** (600 = #2d5b87) para acciones principales, foco y estados activos. El ícono, los PNG de la PWA, `theme-color` y el manifiesto usan el mismo azul.
- **Navegación:** escala `petroleo-*` (azul petróleo) para la barra lateral, el menú móvil y el panel de Login/Activación; ítem activo con relleno translúcido y barra celeste.
- **Estados:** alias semánticos `exito-*`, `aviso-*`, `peligro-*` (verde, ámbar, rojo) usados por insignias, avisos, botones y alertas. La escala `slate` se redefinió con grises azulados; los textos que usaban `slate-400` pasaron a `slate-500` (texto secundario ≥ 5:1 sobre blanco y sobre el fondo).
- **Radios:** `rounded-ctl` (8 px: botones y campos), `rounded-card` (12 px: tarjetas, paneles), `rounded-modal` (16 px). **Sombras:** `shadow-card` (casi plana), `shadow-pop` (menús), `shadow-modal`.
- **Layout:** `max-w-contenido` = **1600 px** (centrado en monitores grandes), `max-w-formulario` = 960 px (Configuración y Puesta en marcha no estiran los campos), `w-menu` = 16 rem. **Tipografía:** Inter/Segoe UI; `text-micro` para etiquetas mínimas; los campos usan 16 px en celular (evita el zoom de iOS) y 14 px desde `sm`.
- Reemplazo mecánico en todo `src/`: `rounded-xl/lg/2xl` → `rounded-card/ctl/modal`; `shadow-sm/lg` sueltas → tokens.

## 85. Componentes compartidos mejorados (`src/components/ui.tsx`)
- **Botones** (`Boton`: principal relleno, secundario con borde, fantasma, peligro, éxito; alto táctil en celular) y **`BotonIcono`** nuevo (36 px, etiqueta obligatoria) que reemplazó a botones de ícono sueltos de 24 px (Plan de cuentas, Libro diario, Agenda, Configuración).
- **Campos** (`Input`, `Select`, `Textarea`, `InputMoneda`, `Campo`, `Check`, `Chip`) con el mismo borde, foco y tamaño; **`Grilla`** (1 columna en celular → 2 → 3/4), **`Seccion`** y **`AccionesForm`** (botonera fija al pie de un formulario dentro de un modal) nuevos. Los formularios de modales con importes, fechas o selectores pasaron a 1 columna en celular. `Grilla` y `Seccion` quedan disponibles pero todavía no se usan en las pantallas existentes (se conservó su maquetación).
- **`Tabla`:** decide por el **ancho real del contenedor** (no por el de la pantalla, que con el menú abierto engaña): si la tabla no entra pasa sola a tarjetas (título, subtítulo, importe, datos secundarios agrupados) y vuelve a tabla apenas hay lugar. **`TablaApilable`** nueva aplica lo mismo a las `<table>` escritas a mano (libros contables, informes, balance, caja, importación): cada fila se apila con las etiquetas de su columna; sólo en pantalla (al imprimir vuelve a ser tabla).
- **`Modal`:** `dvh`, cuerpo con desplazamiento vertical propio, título y pie siempre visibles; en celular sube desde abajo, con botones a todo el ancho y respeto del área segura.
- **`Pestanas`** como control segmentado que se reparte en varias filas (ya no hay pestañas con desplazamiento horizontal); **`Segmentado`** nuevo (Tablero/Lista); **`Indicador`** con letra proporcional al ancho real de la tarjeta (consulta de contenedor) y valores compuestos ("a / b") que pasan de línea sin cortar cada importe; `Encabezado` sin truncar el título; `Aviso`, `ErrorCaja`, `Cargando`, `Vacio`, toasts y confirmaciones con los mismos tokens y roles de accesibilidad; clase **`.filtros`** que reparte los filtros de 28 listados en celular; `SelectorPeriodo` rehecho (dos fechas en una fila, atajos debajo) y reutilizado por Estadísticas.
- **Layout y navegación (`Layout.tsx`):** barra lateral petróleo con buscador, categorías desplegables, ítem activo resaltado y migas, todo conservado; encabezado, barra inferior móvil y búsqueda global con los tokens nuevos; `main` con `min-w-0`.
- Texto largo: los nombres de artículos y clientes en listas y selectores ya no se cortan con puntos suspensivos (se parten); los truncados que quedan son de una línea.

## 86. Pantallas revisadas
Las 52 rutas (incluidas las de detalle) más las pestañas de cada pantalla que las tiene: Inicio, Clientes, Vehículos, Órdenes de trabajo (tablero y lista), Presupuestos, Agenda, Tempario, Mantenimientos, Personal (Equipo, Asistencia, Panel, Reloj compartido), Mis trabajos, Inventario, Depósitos, Compras, Órdenes de compra, Facturas de proveedor, Ventas, Cobranzas, Cuentas corrientes, Caja, Finanzas, Tesorería, Bancos, Cheques, Contabilidad (todas sus pestañas), Estadísticas, Informes, Configuración, Puesta en marcha, Importación, Apertura de saldos, Login y Activación. El Reloj compartido (pantalla oscura de kiosco) sólo toma los radios y la escala de grises nuevos.

## 87. Problemas de desborde corregidos (causas, no `overflow-x: hidden`)
| Causa | Dónde se veía | Corrección |
|---|---|---|
| Hijos de una grilla que no se achican por debajo de su contenido | Ficha de OT, Estadísticas, Finanzas, detalle de orden de compra (hasta 640 px en un celular de 375) | `.grid > * { min-width: 0 }` global + `min-w-0` en `Tarjeta`, `Campo`, `Dato` e inputs |
| Tablas con `overflow-x-auto` interno al abrir el menú lateral (contenido de ~705 px en 1024) | Todas las listas con `Tabla` y 12 tablas escritas a mano | Cambio automático a tarjetas por ancho real del contenedor (`Tabla` / `TablaApilable`) |
| Tablero Kanban de 6 columnas fijas de 288 px (1.512 px) | Órdenes de trabajo | Grilla `auto-fill` que reparte las columnas en filas |
| Pestañas con scroll horizontal | Configuración (779 px), Finanzas, ficha de OT | Control segmentado con salto de línea |
| Importes en tarjetas de dos columnas (`whitespace-nowrap`) y valores compuestos | Finanzas, Productividad, Contabilidad | Letra proporcional por consulta de contenedor; "a / b" divisible |
| Lista de informes (cuatro pantallas de alto en celular) | Informes | Selector agrupado en celular, lista lateral desde `lg` |
| Controles de período desalineados | Estadísticas | `SelectorPeriodo` compartido con `atajos` |
| Formularios dentro de modales sin botonera visible | Alta/edición de cliente y vehículo | `AccionesForm` fija al pie |

## 88. Comprobaciones responsive
Instancia local aislada (puertos 8790/5180, base temporal con el generador de demo y usuarios de otros roles; nunca se tocó la instancia habitual ni la D1 remota). Un arnés temporal (no versionado) recorrió **todas las rutas, las pestañas y entre 14 y 28 ventanas modales por ancho**, midiendo el ancho del documento y del contenido, elementos fuera de pantalla, contenedores con scroll horizontal propio, pies de modal fuera de la pantalla y la pantalla de error del compilador:
- **360, 375, 768, 1024 y 1366 px:** 0 desbordes de página, 0 contenedores con scroll horizontal, 0 modales o botones fuera de pantalla. **1920 px:** contenido centrado de exactamente 1600 px.
- **Roles:** propietario, recepción y mecánico (Mis trabajos, su detalle y Asistencia) a 375 px. Caja y depósito sólo se dieron de alta: su menú depende de los mismos permisos, que no se tocaron.
- Capturas de revisión visual en 390, 1366 y 1920 px de Inicio, Órdenes, Clientes, Ventas, Caja, Configuración, Puesta en marcha, Informes, Agenda, Estadísticas, Login y Mis trabajos.
- `npm run typecheck` y `npm run build` OK; **107 pruebas unitarias OK**. No se corrió la suite de integración (`vitest.api`): no se tocó nada de `worker/`, `shared/` ni `migrations/`.
- **No comprobado:** dispositivos reales (se usó la emulación de tamaño del navegador integrado, no un celular físico ni Safari/iOS); impresión/PDF de los comprobantes (sólo cambia la escala de grises, no se imprimieron); el Reloj compartido con un dispositivo activado.
- Hallazgo del arnés: la primera versión de `TablaApilable` aplicaba la clase de apilado desde otro efecto y a veces medía la tabla ya apilada; ahora la clase la maneja React en el mismo render (probado con 12 navegaciones seguidas).

## 89. Despliegue
- Sólo código de interfaz: no hubo migraciones, respaldo ni cambios en la D1 remota ni en el Worker de la API.
- **Publicación:** commit `4ca4992` en `main` (push directo; Workers Builds). Comprobado en https://taller-mecanico.estrubia455.workers.dev que la SPA publicada sirve exactamente el bundle del build local (`index-TsVhzpOR.js` y `index-DHxDee46.css`, que contiene los tokens nuevos) con `theme-color` #13252d, y que `/api/salud` responde `{"ok":true}`. El cambio apareció en pocos minutos.
- **No verificado online:** no se inició sesión en producción (se usó sólo la instancia local); el aspecto autenticado en la URL pública se comprobó por equivalencia de bundle, no mirándolo.

# Sprint 15 — Catálogo automotor argentino

## 90. Qué se hizo
Catálogo compartido marca → modelo → año → motorización → versión, con datos abiertos de la DNRPA (CC BY 4.0), sin APIs externas ni costos recurrentes. Detalle técnico, reglas y proceso en `docs/CATALOGO_AUTO.md`.
- **Proceso local reproducible** (`npm run catalogo -- descargar|agregar|generar|validar|cargar|actualizar`, `scripts/catalogo-auto/`): bajó 9 ZIP/CSV (2018-01 a 2026-09, 105 meses, **4.327.311 inscripciones**), leyó sólo columnas del vehículo (nunca titulares) y generó `data/catalogo-auto/catalogo.json.gz` (0,27 MB). Los CSV quedan en `.cache/` (fuera de git).
- **Resultado:** 211 marcas, 1.548 modelos, 5.674 versiones.
- **D1** (migración `0014`, aditiva): tablas globales `cat_marcas`, `cat_modelos`, `cat_versiones`, `cat_meta` y `cat_fichas` (vacía, con fuente y fecha de verificación obligatorias); columnas opcionales en `marcas`, `modelos` y `vehiculos`.
- **API:** `GET /api/catalogo-auto/{marcas, marcas/:id/modelos, modelos/:id, info}` (sólo lectura, con caché de una hora en el navegador). `POST/PUT /api/vehiculos` resuelve marca/modelo del taller en el servidor.
- **Formulario de vehículo:** marca y modelo con búsqueda sin tildes ni mayúsculas (`vw` encuentra Volkswagen, `hrv` encuentra HR-V), año con atajos de los años del modelo, motorización y versión filtradas por año; todo se puede escribir a mano. La lista va en el flujo de la página (no flotante), sin desplazamiento horizontal a 375 px. Los vehículos existentes no se tocan: al editar sin cambiar marca/modelo/versión no se envía nada de eso.
- Se agregó "Versión" a la ficha del vehículo.

## 91. Decisiones y límites
- **La fuente no trae versión ni motorización estructuradas**: el "modelo" de la DNRPA es una descripción comercial completa. Modelo = familia (primer término, con unas pocas familias de varias palabras declaradas en `reglas.json`); versión = el resto de la descripción; motorización sólo cuando la descripción la menciona literalmente (cilindrada, V6, TDI…). Nada se inventa ni se completa con IA.
- **Alcance temporal:** sólo hay inscripciones iniciales desde 2018; modelos descontinuados antes (p. ej. Corsa) aparecen con muy pocos registros o sólo por vehículos importados/usados inscriptos después.
- **Plantilla inicial de los talleres:** los talleres nuevos siguen recibiendo ~18 marcas y ~100 modelos de plantilla (`MARCAS_PLANTILLA`). No se quitó (varias pruebas dependen de ella); en el selector se deduplica contra el catálogo. Pendiente a propósito: dejar de sembrarla.
- Ningún modelo ni marca previos de un taller se renombra ni se borra; sólo se completa su vínculo con el catálogo (`cat_*_id`) si estaba vacío.
- Los respaldos por taller excluyen las tablas `cat_*` (son públicas y compartidas).

## 92. Validación de vehículos frecuentes (realmente encontrados en la fuente)
| Vehículo pedido | En el catálogo | Versiones | Años modelo | Inscripciones |
|---|---|---|---|---|
| Volkswagen Gol | Sí (`Gol`) | 5 | 1994–2022 | 35 |
| Volkswagen Gol Trend | Sí (`Gol Trend`) | 12 | 2009–2022 | 70.593 |
| Volkswagen Amarok | Sí | 127 | 2011–2026 | 168.221 |
| Fiat Cronos | Sí | 11 | 2018–2026 | 241.055 |
| Toyota Etios | Sí | 16 | 2014–2024 | 115.173 |
| Toyota Hilux | Sí | 96 | 1993–2026 | 244.427 |
| Ford Ranger | Sí | 55 | 2003–2027 | 156.319 |
| Renault Kangoo | Sí | 44 | 2004–2026 | 104.920 |
| Chevrolet Onix | Sí | 22 | 2013–2026 | 87.542 |
| Peugeot 208 | Sí | 112 | 2012–2026 | 197.041 |
| Chevrolet Corsa | Sí, muy poco (`Corsa`; además `Classic`, el Corsa Classic, 31 inscripciones) | 2 | 2006–2010 | 5 |

Las 10 familias pedidas aparecen; ninguna se agregó a mano. `Gol` (35) es residual: casi todo el Gol de la época figura como Gol Trend.

## 93. Pruebas y verificación
- `npm run build` y `npm test`: **113 unitarias + 384 de integración, todas OK** (nuevas: `tests/unit/catalogo-auto.test.ts` —integridad del catálogo generado, sin campos personales, motorizaciones literales—, `tests/api/catalogo-auto.test.ts` —lectura, alta desde catálogo, reutilización sin renombrar, alta manual, validaciones, edición— y `0014` en `tests/api/migraciones.test.ts`).
- Prueba manual en instancia local aislada (8790/5180, base temporal, catálogo real cargado): alta de un vehículo `vw` → Volkswagen → `ámar` → Amarok → 2022 → Highline V6 guarda marca, modelo, versión, motor y los vínculos al catálogo; edición con la lista de versiones abierta a 375 px sin desbordes.
- **No comprobado:** dispositivos reales (sólo emulación de ancho); el alta autenticada en la URL pública (ver §94).

## 94. Despliegue (2026-10-23)
- Respaldo previo de la D1 remota: `respaldos/d1-antes-sprint15-20261023-1705.sql` (fuera de git; 98 tablas, 4.023 filas, integridad OK, SHA-256 `2eb6772b…f234`). Bookmark de Time Travel: `00000116-00000008-0000510d-d7ffa6587a25d70691ae779660922644`.
- Ensayo de la migración sobre el respaldo (en memoria): filas existentes todas idénticas, integridad OK, 0 claves foráneas rotas.
- `wrangler d1 migrations apply DB --remote` (0014) y luego `npm run catalogo -- cargar --remoto` (7.446 filas; 22.112 filas escritas contando índices): 211 marcas, 1.548 modelos, 5.674 versiones; los 37 vehículos existentes siguen intactos.
- Código: commit directo a `main` (Workers Builds). Resultado de la verificación online más abajo.
- **Verificación online:** commit `d2d35b7` en `main`; en https://taller-mecanico.estrubia455.workers.dev la SPA publicada sirve el bundle `index-BAymvuGP.js`, idéntico al build local y con el código del catálogo; `/api/salud` responde 200 y `/api/catalogo-auto/*` existe y exige sesión (401 sin ella). El contenido del catálogo en D1 remota se comprobó con `wrangler d1 execute` (211/1.548/5.674). **No se inició sesión en producción** (no se usan credenciales reales): el alta autenticada con el catálogo se probó en la instancia local equivalente, no mirándola en la URL pública.

# Sprint 16 — Fotografías de vehículos y órdenes de trabajo

Detalle completo (arquitectura, seguridad, procedimiento de respaldo y activación de R2) en `docs/FOTOGRAFIAS.md`.

## 95. Estado de R2 (histórico: al cierre del primer día R2 no estaba habilitado; ver §103 para el estado actual)
- **R2 no está habilitado en la cuenta de Cloudflare** (`wrangler r2 bucket list` → `10042 Please enable R2 through the Cloudflare Dashboard`). Habilitarlo es una acción del titular en el panel y puede requerir medio de pago: **no se hizo ni se aceptó ningún costo**. Se detuvo sólo ese paso.
- Por eso **no existe el bucket `fierro-fotos`** y el binding `FIERRO_FOTOS` está **comentado en `wrangler.jsonc`** (un binding a un bucket inexistente rompería el despliegue de Workers Builds). El código está desplegado y **degrada sin romper nada**: sin binding, `/api/fotos/estado` → `habilitado: false`, la app muestra un aviso en vez de los botones y subir/bajar da `503 fotos_no_habilitadas` (comprobado levantando el Worker sin binding). Los listados y el resto de Fierro funcionan igual.
- Pasos para activarlo (4, en `docs/FOTOGRAFIAS.md`): habilitar R2 en el panel → `npx wrangler r2 bucket create fierro-fotos` → descomentar el binding → push a `main`. Que Workers Builds conserve el binding se confirma después de ese push (el binding vive en el archivo de configuración, no en el panel); **no se pudo comprobar en producción**.
- En local y en las pruebas el bucket se **simula en disco** (Miniflare): `scripts/lib.mjs › configLocal()` genera `wrangler.local.generado.jsonc` (ignorado por git) con el binding y `wrangler dev` lo usa.

## 96. Fotografías implementadas
- **Vehículo:** galería en alta (selección previa; se suben tras crear el vehículo, con clave de reintento; si falla alguna el vehículo queda creado y se puede reintentar sin duplicar), edición y ficha, con filtros por origen/etapa. **OT:** pestaña *Fotografías* con Recepción/Reparación/Entrega; también en *Mis trabajos*. Cada foto guarda taller, vehículo, OT, etapa, usuario, fecha/hora y descripción; la foto de una OT se ve en la ficha del vehículo sin duplicar el archivo.
- **Cámara:** *Sacar foto* (`capture="environment"`, cámara trasera) y *Elegir de galería* (múltiple), botones de 56 px; flujo OT → Sacar foto → Guardar. Visor con anterior/siguiente, descripción editable y eliminación con confirmación. Progreso real de subida (XHR) y errores comprensibles con *Reintentar*.
- **Optimización:** en el navegador ≤ 2000 px, JPEG con calidad decreciente hasta ~800 KB, miniatura de 480 px, sin EXIF/GPS (el redibujo en canvas lo descarta). En el servidor se valida el contenido real (JPEG/WebP por firma y estructura, ≤ 3,5 MB, ≤ 4096 px) y **se reescribe el archivo quitando EXIF/XMP/ICC**. Medido en el navegador integrado: PNG sintético de 2,2 MB (3000×2000) → 298 KB (2000×1333); JPEG 1,1 MB (4000×3000) → 341 KB (2000×1500). Con fotos reales de celular el peso depende del contenido: no se midió con cámara real.
- Listados sólo con miniaturas (`loading=lazy`); la foto completa se baja al ampliar; caché privada inmutable y `ETag`/304.

## 97. Consumo y límites
- Tabla `taller_almacenamiento` (límite por taller, **2 GB por defecto, provisorio**, sólo lo ajusta la plataforma: `npm run fotos -- limite <taller> <MB>` o `PATCH /api/platform/talleres/:id/almacenamiento`). Usado = originales + miniaturas (incluye las que se están guardando). Se valida antes de guardar y otra vez dentro de la transacción que reserva el cupo. Se muestra en *Administración → Licencia*: "Fotografías: X MB de 2 GB utilizados" con barra; `npm run fotos -- uso` lista todos los talleres. No toca las licencias por usuario.

## 98. Permisos
- Nuevos: `fotos.ver`, `fotos.subir`, `fotos.eliminar` (los dos últimos requieren ver). Por defecto: propietario y administrador todos; recepción, mecánico y empleado (heredado) ver y subir; depósito y caja ninguno. Alcance por OT/vehículo igual que el resto: el mecánico sólo ve y sube en sus órdenes asignadas (y ve las del vehículo y las de sus órdenes). Todo se verifica en el backend; aislamiento entre talleres probado (404 con ids ajenos o alterados). Eliminar queda en `auditoria` (usuario y fecha) y no deja objetos huérfanos (reserva `pendiente` → R2 → `lista`; `eliminada` → R2 → borrado; el Cron de 5 min termina lo que quede a medias).

## 99. Migración 0015 (aditiva)
- Tablas `fotos` (CHECK: etapa obligatoria con OT y prohibida sin OT, sólo `image/jpeg|webp`, estados `pendiente|lista|eliminada`; FK compuestas a vehículo y OT del mismo taller; `UNIQUE(taller_id, idem_key)`) y `taller_almacenamiento`. No toca datos existentes (ensayo sobre el respaldo: 103 tablas / 11.469 filas idénticas, integridad OK). Prueba propia en `tests/api/migraciones.test.ts`.

## 100. Pruebas realizadas
- `npm run build` y `npm test`: **116 unitarias + 395 de integración, todas OK** (nuevas: `tests/api/fotos.test.ts` —10 pruebas: subida, EXIF quitado, reintento sin duplicar, contenido inválido/gigante, etapas de OT, aislamiento entre talleres, permisos del mecánico, eliminación, cupo, exportación/auditoría—; `tests/unit/fotos-export.test.ts`; migración 0015; cabeceras de caché).
- En una instancia local aislada con R2 simulado: alta de un vehículo con 2 fotos elegidas (comprimidas y subidas al guardar), OT con foto de recepción desde una vista de 375 px (botones, confirmación, "Fotografía guardada", visor), ficha del vehículo con la foto de la OT marcada "OT #6 · Recepción", sin desbordes horizontales.
- **Hallazgo corregido durante la prueba:** el filtro de caché del catálogo (Sprint 15) estaba montado en `/` y, al dejar de pisarse con `no-store`, habría dejado **toda la API GET cacheada una hora en el navegador**; ahora es sólo para `/api/catalogo-auto/*` y hay una prueba que lo exige. (En producción nunca ocurrió: el filtro global lo sobrescribía.)
- **No comprobado:** cámara física de un celular real (se inyectaron archivos en el `<input>`), Safari/iOS, HEIC (los navegadores que no lo decodifican muestran un mensaje), R2 real.

## 101. Respaldo de las imágenes
- **Un respaldo de D1 no incluye las imágenes y los respaldos actuales NO las protegen** (sólo conservan filas y sha256). Se agregó `npm run fotos -- exportar | verificar | restaurar | auditar | uso | limite | limpiar` (`scripts/fotos.mjs`, `scripts/fotos-lib.mjs`) y endpoints de plataforma (`/api/platform/fotos/manifiesto`, `/:id/archivo`, `/auditoria`, `/limpiar`, `/almacenamiento`). La exportación genera `manifiesto.json` con la relación con D1 (foto, taller, vehículo, OT, etapa) y el sha256 de cada archivo y miniatura, comprobado contra D1 al bajar. Las carpetas van en `respaldos/` (ignorado por git).
- **Probado en local:** exportar → verificar → borrar el R2 simulado → `auditar` (6 faltantes) → `restaurar` → `auditar` (0 diferencias) → re-exportar con hashes idénticos. **Pendiente:** probarlo contra R2 real y automatizarlo en GitHub Actions como el respaldo cifrado de D1.

## 102. Despliegue (2026-10-23)
- Respaldo previo de la D1 remota `respaldos/d1-antes-sprint16-20261023-1810.sql` (fuera de git; 103 tablas, 11.469 filas, integridad OK, SHA-256 `635dbe40…aba`). Bookmark de Time Travel: `0000011e-00000000-0000510d-213f46991d5f391b0f9fba688f859742`. Ensayo de la migración sobre el respaldo y `wrangler d1 migrations apply DB --remote` (0015) aplicados antes de publicar el código.
- **Verificación online:** commit `b27e3f8` en `main`; en https://taller-mecanico.estrubia455.workers.dev la SPA publicada sirve el bundle `index-CRUbOq1k.js` (idéntico al build local y con el código de fotografías), `/api/salud` responde 200 y `/api/fotos/estado` y `/api/platform/almacenamiento` existen y exigen sesión/token. **Fotografías deshabilitadas en producción hasta habilitar R2** (§95). No se inició sesión en producción.

## 103. Activación de R2 y verificación con R2 real (2026-10-24)
- R2 habilitado por el titular y bucket privado `fierro-fotos` creado (Standard, ENAM, `r2.dev` deshabilitado, sin dominios). Se activó el binding `FIERRO_FOTOS` en `wrangler.jsonc` (commit `4222674`; `wrangler deploy --dry-run` lo reconoce). La migración 0015 ya estaba aplicada (`d1 migrations list`: nada pendiente); no hubo migraciones nuevas ni cambios a datos de talleres.
- **Despliegue:** Workers Builds publicó la versión `c4948260…` de `taller-mecanico`; `wrangler versions view` lista `env.FIERRO_FOTOS (fierro-fotos) R2 Bucket` (el binding se conserva) además de D1 y el secreto de plataforma. La SPA servida es el mismo bundle `index-CRUbOq1k.js`; `/api/salud` 200; las rutas de fotos y de plataforma exigen sesión/token.
- **Verificación contra R2 real** (nuevo `FIERRO_R2_REAL=1` en `scripts/lib.mjs`: Worker local con D1 local y binding remoto):
  - Suite `tests/api/fotos.test.ts` completa (10/10) contra el bucket real: subida, EXIF quitado, reintento sin duplicar, contenido inválido, etapas de OT, aislamiento entre talleres, permisos del mecánico, eliminación, cupo, exportación/auditoría.
  - Un objeto subido por la API se bajó con `wrangler r2 object get --remote`: mismo sha256 que D1, sin rastro de GPS, miniatura aparte.
  - Escenario con dos talleres: Demo sube 3 fotos (vehículo, recepción y entrega de una OT); Norte recibe **404** al pedir la foto, la lista de la OT y al subir a un vehículo ajeno; Demo la ve (200, `image/jpeg`). Eliminar vía API → 200, luego 404, objetos borrados del bucket.
  - **Recuperación:** exportar → verificar → borrar los 3 originales del bucket → `auditar` (3 faltantes) → `restaurar --remoto` → `auditar` (0 diferencias) → re-exportar: hashes idénticos. La auditoría también detectó correctamente los 20 objetos huérfanos que dejó la suite.
  - **Limpieza:** todos los objetos de prueba se borraron del bucket (auditoría final: 0 objetos); el bucket de producción queda vacío.
- **No verificado online:** no se inició sesión en producción (no se usan credenciales reales), así que la subida desde la URL pública con un usuario real no se probó; sí el binding, la configuración y el código idéntico. Tampoco cámara física ni Safari/iOS.

# Sprint 17 — Explorador del catálogo automotor

## 104. Qué se hizo
- **Pantalla "Catálogo automotor"** (Taller → Catálogo automotor, `/catalogo-automotor`, `src/pages/CatalogoAutomotor.tsx`): buscador + filtros Marca, Modelo, Año, Versión y Motorización, todos relacionados entre sí (cada lista ofrece sólo opciones que dan resultados). Se puede buscar "Amarok" sin elegir marca; ignora mayúsculas, tildes y signos; el apodo `vw` también encuentra Volkswagen. Estado en la dirección (`?q=&marca=&modelo=&anio=&version=&motor=`): se puede compartir y funciona Atrás. Resultados en tarjetas con paginación ("Ver más modelos", 24 por vez) y versiones con "Ver más".
- **Ficha de la versión:** *Identificación* (marca, modelo, año, versión, descripción registral, motorización y combustible sólo si el registro los dice, fuente DNRPA/CC BY 4.0 con enlace al dataset), *Información técnica* (motor, lubricantes, capacidades, filtros, intervalos) y *Documentación* (manual del propietario, manual técnico, mantenimiento). Reutiliza `cat_fichas` (Sprint 15), que sigue **vacía**: todo campo sin dato dice "Sin datos verificados" y un aviso aclara que la descripción registral **no** es una especificación oficial del fabricante. Nada se estima ni se deduce. En escritorio la ficha va al costado; en tablet y celular se abre a pantalla completa.
- **Documentación:** sólo estructura visual; no hay enlaces ficticios ni manuales descargados. Si una ficha verificada trae `documentacion_url`, se muestra únicamente si es `https` (el servidor descarta el resto).
- **Integración con el taller:** *Registrar vehículo* (con `vehiculos.crear`): elige el cliente y abre el alta de siempre con marca, modelo, versión, año, motor y combustible ya cargados, vinculada al catálogo; al guardar lleva a la ficha del vehículo. *En tu taller*: vehículos de ese modelo (marca "Misma versión" si coincide), con `vehiculos.ver`.

## 105. Endpoints (sin migraciones, sin tocar datos)
- Se reutilizan `/api/catalogo-auto/marcas`, `/marcas/:id/modelos`, `/modelos/:id` e `/info`. Se agregaron **dos de sólo lectura**: `GET /api/catalogo-auto/buscar?q&marca&anio&limite&desde` (modelos paginados + facetas de marcas, modelos y años; cada palabra debe aparecer en marca/apodo, modelo o alguna versión) y `GET /api/catalogo-auto/modelos/:id/fichas`. Además `GET /api/vehiculos` acepta `cat_modelo_id` (siempre acotado al taller de la sesión). Una búsqueda necesita cruzar marcas, modelos y versiones, algo que los endpoints existentes no podían resolver sin bajar todo al navegador.
- Consultas con parámetros, `LIKE` sobre claves normalizadas (sin comodines del usuario) e índices existentes; las respuestas del catálogo siguen con `Cache-Control: private, max-age=3600`.

## 106. Permisos
- Sin permiso nuevo. Se ve con **cualquiera** de `vehiculos.ver`, `catalogo.ver` u `ordenes.asignadas` (el mecánico entra sin permisos de precios, finanzas ni estadísticas). Menú, ruta y los endpoints nuevos lo exigen; sin sesión → 401. El catálogo es compartido; clientes y vehículos siguen siendo privados de cada taller (comprobado con dos talleres que tienen vehículos del mismo modelo).

## 107. Pruebas
- `npm run build` y `npm test`: **116 unitarias + 398 de integración, todas OK** (3 pruebas nuevas en `tests/api/catalogo-auto.test.ts`: búsqueda sin marca/tildes/apodo/versión, filtros relacionados y paginación, entradas hostiles; fichas vacías y enlaces no https descartados; mecánico y caja sin permisos económicos, 401 sin sesión, aislamiento entre talleres).
- A mano, instancia local aislada (8790/5180) con el catálogo real (211/1.548/5.674): "amarok" → 1 modelo, 127 versiones; Volkswagen → Amarok → 2022 → Highline V6 3.0L 258 CV muestra la ficha con "Sin datos verificados"; alta de un vehículo desde la ficha (cliente → formulario precargado → guardado) y su aparición en "En tu taller". Sin scroll horizontal a 375, 768 y escritorio.
- **Hallazgo corregido:** el primer ensayo mostró un 400 al abrir la pantalla (el cliente enviaba `anio=` vacío); ahora sólo envía los filtros con valor.
- **No comprobado:** dispositivos reales (sólo emulación de ancho) ni cómo se ve una ficha con datos (no hay ninguna cargada; se probó en la API con una ficha de prueba, luego borrada).

## 108. Despliegue y pendientes
- Sin migraciones ni cambios de datos; commit directo a `main` (Workers Builds). Resultado de la verificación online al final de esta sección.
- Pendiente a propósito: **carga masiva de especificaciones** (cada ficha exige fuente y fecha), documentos reales con licencia verificada, y vínculo versión↔ficha por motorización cuando existan fichas.
- **Verificación online (2026-10-24):** commit `ef36a0a` en `main`; en https://taller-mecanico.estrubia455.workers.dev la SPA publicada sirve `index-DiQDXGQr.js` (idéntico al build local, con la ruta `/catalogo-automotor` y el módulo `CatalogoAutomotor-CgwCcjyi.js`), `/api/salud` responde 200 y `/api/catalogo-auto/buscar` y `/modelos/:id/fichas` existen y exigen sesión (401). **No se inició sesión en producción** (no se usan credenciales reales): la pantalla autenticada se probó en la instancia local equivalente con el catálogo real, no mirándola en la URL pública.

# Sprint 18 — Checklist de recepción y entrega de vehículos + respaldo de fotografías

> ~~PENDIENTE PRIORITARIO → §115: hoja A4 de la OT con renglones y copia para administración.~~ **Implementado en el Sprint 19 (§118 en adelante)** como base flexible; sigue pendiente comparar con una muestra real del cliente piloto.

## 109. Qué se hizo
- **Etapa 1 · Respaldo de fotografías** (preparado, sin ejecución real: ver §110). `npm run fotos -- respaldo` (copia incremental cifrada y verificada de punta a punta) y `respaldo-restaurar` (cadena completa + incrementales → carpeta verificada → `restaurar` → `auditar`); `.github/workflows/respaldo-fotos.yml`; endpoint de **sólo lectura** con credencial propia `FOTOS_BACKUP_TOKEN` (`/api/plataforma/fotos-respaldo/manifiesto|:id/archivo`, `worker/modules/respaldo-fotos.ts`) para no cargar el token de plataforma en GitHub. Reutiliza el manifiesto de D1, `verificarCarpeta` y el cifrado híbrido del respaldo de D1; `manifiestoFotos`/`archivoParaExportar` ahora se comparten en `worker/lib/fotos.ts` con la API de plataforma.
- **Etapas 2 a 5 · Checklist de recepción y entrega** (`docs/CHECKLIST.md`): ingreso (fecha y hora, responsable, vehículo, cliente, km, combustible, llaves, observaciones), 32 puntos de control con *Correcto / Con observaciones / No revisado / No corresponde* y observación por punto (ninguno obligatorio), **esquema del vehículo** para marcar daños (frente, trasera, laterales, techo, interior) con descripción y fotografías, **firma manuscrita en pantalla táctil** (trazos vectoriales; nombre, fecha y hora del servidor, responsable, versión del checklist y huella del contenido aceptado; «no presente» / «no desea firmar»), inmutabilidad (borrador → confirmado → correcciones como **revisiones**) y entrega enlazada a la recepción sin pisarla, con **comparación ingreso/salida**.
- **Etapa 6 · Fotografías:** reutiliza el Sprint 16 sin cambiar su almacenamiento: las etapas *recepción / reparación / entrega* ya existían; el checklist abre la cámara (`capture="environment"`) desde la sección de fotos y desde cada daño, o elige fotos ya tomadas de la OT (un solo archivo, una sola fila en `fotos`). Cambios mínimos en `Fotos.tsx` (`ConfirmarSubida` exportado con `onGuardadas`, ids de lo subido). Una foto incluida en un registro confirmado **no se puede eliminar** (API 409 + disparador).
- **Etapa 7 · Móvil/tablet:** pantalla completa con encabezado fijo (progreso «12 de 32 puntos», estado del guardado, atajos a cada sección), secciones plegables, botones de 44 a 56 px, borrador guardado solo en el servidor (control de versión), confirmación final con resumen y avisos blandos (sin km, sin combustible…), firma táctil a lo ancho. Sistema visual del Sprint 14 (tokens, `Modal`, `Pestanas`, `Insignia`, `Aviso`). **Es opcional:** nada bloquea la OT. Sin scroll horizontal (verificado a 375 y 768 px).
- **Etapa 8 · Historial:** en la OT (pestaña *Recepción y entrega*: tarjetas, comparación, historial con motivo y «qué cambió») y en la ficha del vehículo (*Recepciones y entregas* de todas sus OT, con enlace a cada una; `?tab=checklist`). El check-list simple anterior se conserva.
- **Etapa 9 · Permisos y privacidad:** 5 permisos nuevos (§113), validados en el servidor; ninguna respuesta incluye precios ni costos (prueba automática sobre las claves de las respuestas); `taller_id` siempre de la sesión.
- **Etapa 10 · Hoja de OT:** sólo se registra el requerimiento (§115). No se tocó la impresión de la OT ni se mezcló con el checklist.
- Sin cambios en ARCA, licencias, contabilidad ni en el almacenamiento de fotografías.

## 110. Estado real de los respaldos (verificado el 2026-10-24)
- **D1 · Time Travel:** activo (único respaldo automático real; misma cuenta de Cloudflare).
- **D1 · respaldo programado cifrado en GitHub Actions: NO operativo.** El workflow `Respaldo D1` se ejecutó solo dos veces (2026-10-23 11:34 UTC y 2026-10-24 10:54 UTC, según la API pública de GitHub) y **las dos fallaron en «Comprobar configuración»**: faltan secretos o variables que sólo puede cargar el titular (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `FIERRO_RESPALDO_CLAVE_PUBLICA`). No existe ningún artefacto de respaldo en GitHub.
- **Fotografías: sin copia automática.** Lo preparado (§109) **no se ejecutó nunca en GitHub**: faltan `FOTOS_BACKUP_TOKEN` (en el Worker y en GitHub), la variable `FIERRO_RESPALDO_CLAVE_PUBLICA` y `FIERRO_URL`. La D1 de producción ya registra **2 fotografías «lista» (2026-10-24 15:16 UTC)**: hoy no tienen copia; para protegerlas ya mismo, `npm run fotos -- exportar` (token de plataforma, carpeta fuera de git).
- **Lo que sí se probó:** la cadena completo → incremental → restauración con el Worker de pruebas (`tests/api/fotos.test.ts`, R2 simulado) y 11 pruebas unitarias del paquete, el plan incremental, la restauración con clave equivocada, paquete alterado o cadena incompleta y la limpieza de la carpeta temporal (`tests/unit/fotos-respaldo.test.ts`). Con R2 real sólo se probó antes la exportación y restauración manual (Sprint 16).
- **No se afirma que existan respaldos automáticos operativos:** hace falta que el titular cargue la configuración (`docs/RESPALDOS.md` §7 y §9), una ejecución real termine en verde y se pruebe abrir su resultado.
- **Qué debe hacer el titular de la plataforma:** (1) completar §7 (respaldo de D1); (2) generar un valor aleatorio de 32 o más caracteres y cargarlo como `FOTOS_BACKUP_TOKEN` con `wrangler secret put FOTOS_BACKUP_TOKEN --name taller-mecanico` y como secreto de GitHub; (3) cargar las variables `FIERRO_RESPALDO_CLAVE_PUBLICA` y `FIERRO_URL`; (4) ejecutar a mano *Respaldo D1* y *Respaldo fotos* y probar abrir los artefactos con la clave privada; (5) decidir un destino con más espacio antes de que las fotos pasen de unos cientos (cupo gratuito de artefactos). No se contrató ningún servicio ni se cargó ningún secreto en nombre del titular.

## 111. Integración con fotografías (resumen)
- Mismo bucket, mismas filas, mismas claves (`fotos/<taller>/<id>`); el checklist guarda **referencias** (`ck_fotos`, ids en los daños) y el sha256 de cada foto dentro del contenido que se firma.
- Etapas: la recepción incluye las fotos de etapa *Recepción* de la OT y las asociadas a daños; la entrega, las de etapa *Entrega*. Las de *Reparación* no entran.
- Permisos de fotos intactos: sacar, ver y eliminar siguen con `fotos.subir`, `fotos.ver` y `fotos.eliminar` y el alcance por OT. El cupo de 2 GB por taller sigue valiendo.

## 112. Migración 0016 (aditiva)
- `ck_registros`, `ck_firmas`, `ck_fotos` + índices + 7 disparadores de inmutabilidad (registros confirmados, firmas, vínculos a fotos, firma sólo sobre el contenido confirmado) y `trg_fotos_en_checklist` sobre `fotos`. No modifica ni borra datos. La tabla `checklists` anterior no se toca.
- **Procedimiento:** respaldo remoto previo `respaldos/d1-antes-sprint18-20261024-1656.sql` (fuera de git; 105 tablas, 11.478 filas, integridad OK, 0 claves foráneas rotas, SHA-256 `d3c7ed5b…0b8f`, bookmark de Time Travel `00000229-00000012-0000510e-6fb83805318cd81aff9d4f70ab9da32c`) → **ensayo sobre ese respaldo** (`respaldo -- ensayar-migraciones`: 105 tablas y 11.478 filas comparadas, **todas idénticas**; +3 tablas) → `wrangler d1 migrations apply DB --remote` **antes** de publicar el código → respaldo posterior `respaldos/d1-despues-sprint18-20261024-1657.sql` (108 tablas, 11.479 filas —la fila nueva es el registro de la migración—, integridad OK, 0 claves foráneas rotas, migraciones al día) y verificación en remoto de las 3 tablas, 6 índices y 8 disparadores.

## 113. Permisos
`checklists.ver`, `checklists.recepcion`, `checklists.entrega`, `checklists.corregir`, `checklists.firmas` (el propietario los asigna en Personal → Permisos, grupo «Recepción y entrega de vehículos»). Recepción y empleado (heredado): ver, recepción, entrega y firmas; mecánico: ver (sólo sus OT); administrador y propietario: todo. Depósito y caja: ninguno. Escribir exige ver. Sin `checklists.firmas` se ve que está firmado, no el dibujo ni el nombre.

## 114. Pruebas
- `npm run build` (tsc de la app y del Worker + Vite) y `npm test`: **133 unitarias + 422 de integración, todas OK** (nuevas: 21 de integración del checklist en `tests/api/checklists.test.ts`, 2 de respaldo de fotos contra el Worker de pruebas en `tests/api/fotos.test.ts`, 1 de migración 0016 en `tests/api/migraciones.test.ts`, 11 de respaldo en `tests/unit/fotos-respaldo.test.ts` y 6 del modelo compartido en `tests/unit/checklist.test.ts`).
- Cubierto: borrador idempotente y control de versión, validación estricta del contenido, fotos de otra OT o de otro taller rechazadas, confirmación con hash y contexto, **inmutabilidad también por SQL directo**, firmas (válidas, vacías, cortas, fuera de lienzo, doble firma, firma sobre otro hash), revisión con motivo y permiso, firma de una revisión vencida rechazada, entrega enlazada y sin pisar la recepción, firma posterior a un «no presente», protección de fotos incluidas, permisos (mecánico sólo sus OT; sin permiso 403; el cambio de permisos rige de inmediato), **dos talleres** (404 en todo), ausencia de precios en las respuestas, auditoría.
- A mano (instancia aislada 8790/5180, Taller Demo): recepción completa en tablet (768) y celular (375): datos de ingreso, puntos con observación, daño tocando el esquema con **foto subida por el flujo real de cámara y galería**, resumen, confirmación, firma táctil (eventos de puntero), entrega con comparación (km, combustible, cambios, elementos), historial en la ficha del vehículo, sin scroll horizontal. Hallazgos corregidos en el camino: un daño nuevo se mostraba como «registrado» con botón «Quitar»; el estado del guardado ocultaba el título en celular.
- **No comprobado:** cámara física, Safari/iOS, lápiz táctil real ni Android real (sólo emulación de ancho y eventos de puntero simulados); no se inició sesión en producción (ver §116).

## 115. PENDIENTE PRIORITARIO antes de la entrega comercial: hoja A4 de la OT con renglones y copia para administración
- **Requerimiento confirmado del cliente piloto:** al generar una orden de trabajo, imprimir una hoja **A4** con los datos de la OT y **renglones para anotaciones manuscritas del mecánico, aproximadamente desde la mitad de la hoja hacia abajo**; y **una copia para administración**.
- **Sin definir (hay que confirmar con el cliente antes de implementar):** cómo se diferencian las dos copias (¿rótulo «Original/Copia»?, ¿una versión con precios y otra sin?, ¿una sola hoja o dos?, ¿firmas?, ¿datos que sólo ve administración?). **No se implementó ni se asumió ningún formato.**
- **Estado actual:** la OT ya se imprime con *Imprimir* (`/imprimir/orden/:id`, con importes) y *Hoja taller* (`/imprimir/orden-taller/:id`, sin precios), ambas en `src/pages/Imprimir.tsx`; la segunda es la base natural, pero no tiene renglones de anotaciones ni copia. **Debe mantenerse separada del checklist de recepción** (el checklist no se imprime en esa hoja ni la hoja reemplaza al checklist).

## 116. Despliegue (2026-10-24)
- Orden seguido: respaldo de D1 → ensayo de la migración sobre el respaldo → migración 0016 aplicada en la D1 remota → recién después commit `03d5597` en `main` (sin ramas, sin PR, sin `gh`) → Workers Builds.
- **Verificación online:** Workers Builds publicó la versión `61c73271…` de `taller-mecanico` (17:00:55 UTC); `wrangler versions view` lista D1 y `env.FIERRO_FOTOS (fierro-fotos) R2 Bucket` además del secreto de plataforma (los bindings se conservan). La SPA servida es el bundle `index-BSjZV7K1.js`, **byte a byte idéntico** (sha256) al build local y con la pestaña «Recepción y entrega». `/api/salud` 200; `/api/ordenes/:id/checklists`, `/api/vehiculos/:id/checklists` y `/api/checklists/:id/verificar` existen y exigen sesión (401); `/api/plataforma/fotos-respaldo/manifiesto` responde 401 sin token y con un token falso (el secreto `FOTOS_BACKUP_TOKEN` todavía no está cargado en el Worker: el endpoint está dormido). GitHub reconoce el workflow `Respaldo fotos` como activo (YAML válido).
- **No verificado online:** no se inició sesión en producción (no se usan credenciales reales ni se crean datos en los talleres reales), así que el checklist autenticado no se probó en la URL pública; sí la migración, el código idéntico, los bindings y las rutas.

## 117. Lo que no se hizo / límites
- Firma digital certificada, PDF o impresión del checklist y la hoja de OT (§115).
- Reclasificar la etapa de una foto ya subida; modo sin conexión; aviso a la plataforma cuando el respaldo de fotos deja de llegar.
- Verificación en dispositivos reales y verificación autenticada en producción.

# Sprint 19 — PDF e impresión de órdenes de trabajo

## 118. Qué se hizo
- **Botón «Imprimir orden»** en el detalle de la OT (reemplaza a «Hoja taller») y aviso «Orden creada. ¿Querés imprimir…?» al crearla (`?nueva=1`). Ventana con: Mecánico / Administración / Ambas copias, vista previa del PDF, **Descargar**, **Abrir en otra pestaña** e **Imprimir** (sólo al apretarlo; nunca automático). `src/components/ImprimirOrden.tsx`.
- **PDF A4 vertical generado en el servidor**: `GET /api/ordenes/:id/pdf?copia=mecanico|administracion|ambas`. «Ambas» = un único PDF con una hoja por copia, cada una rotulada («COPIA MECÁNICO» / «COPIA ADMINISTRACIÓN»). Detalle completo, maquetación y cómo ajustar las variantes en `docs/HOJA_OT.md`.
- **Sin dependencias ni servicios externos**: escritor de PDF propio (`worker/lib/pdf/escritor.ts`, `metricas.ts`: Helvetica estándar, WinAnsi, JPEG), maquetación y variantes en `worker/lib/hoja-orden.ts`, datos en `worker/lib/hoja-orden-datos.ts`.
- **Variantes independientes sobre una sola lógica**: `VARIANTES.mecanico` y `VARIANTES.administracion` (rótulo, permisos, secciones, anotaciones). Hoy comparten los datos operativos básicos; no se asumió ningún precio en administración.
- **Contenido**: identidad del taller (y logo JPEG), N° y fecha de apertura, cliente y teléfono (sólo con `clientes.ver`), marca/modelo, patente, año, km registrado, técnico y participantes, entrega prometida, motivo, trabajos solicitados (con casilla), repuestos (sólo cantidades), diagnóstico y observaciones, y **«ANOTACIONES DEL MECÁNICO»** desde los 145 mm (~47 % de la hoja, 14 renglones de 9 mm). Contenido extenso → hojas de continuación; las anotaciones quedan en la última hoja o en una propia.
- **Seguridad**: consulta propia y acotada (no reutiliza el detalle administrativo ni lee importes/costos/notas internas); permisos nuevos `ordenes.imprimir` y `ordenes.imprimir_administracion` (el mecánico imprime sólo la suya y de sus órdenes asignadas); taller siempre de la sesión; metadatos del PDF sin autor ni datos de personas; cada impresión queda en la auditoría.
- La vista HTML «orden-taller» de `Imprimir.tsx` se eliminó (la reemplaza el PDF). «Imprimir» de la OT con importes para el cliente no se tocó.
- Sin cambios en ARCA, respaldos, contabilidad, inventario, licencias ni migración desde SistroFix. **Sin migraciones** (los permisos se derivan de las plantillas).

## 119. Referencia SistroFix y pendiente de validación
- Se leyó el artículo público de SistroFix sobre recibir una reparación: la orden se imprime al guardar como comprobante de recepción para el cliente. No se copió diseño, marca ni recurso.
- **Falta comparar el resultado con una muestra real del comprobante del cliente piloto** y confirmar: si las dos copias deben ser idénticas o distintas, si administración necesita precios/firmas/otros datos y qué rótulo prefiere. Cambiarlo es editar la definición de la variante (ver `docs/HOJA_OT.md`).

## 120. Pruebas
- `tests/unit/hoja-orden.test.ts` (12): estructura y xref del PDF, metadatos, datos legibles con acentos/ñ, ausencia de dinero, zona de anotaciones (≥13 renglones de ≥8,5 mm, nada de contenido dentro), «ambas», datos faltantes, orden extensa con continuación y ningún texto fuera del margen, anotaciones en hoja propia, textos sin espacios y caracteres raros, logo JPEG.
- `tests/api/hoja-orden.test.ts` (9): PDF real descargado y leído, cero cifras de dinero ni notas internas con precios y nota reservada en la OT, «ambas», permisos por copia, mecánico sólo lo suyo y sin datos del cliente, otorgar/retirar permisos rige al instante, dos talleres (404), auditoría.
- **Revisión visual** del PDF renderizado a imagen (PyMuPDF) de: copia mecánico, copia administración, orden extensa (4 hojas por copia, continuación con título repetido, hoja final sólo de anotaciones) y textos hostiles. Resultados de `npm run build` y `npm test` en §121.
- **No comprobado**: impresoras físicas ni lectores de PDF distintos del visor del navegador; Safari/iOS.

## 121. Resultado de las pruebas
- `npm run build` OK; `npm test`: **145 unitarias + 431 de integración, todas OK** (nuevas: 12 + 9). Pantalla probada en una instancia aislada (8790/5180): el botón «Imprimir orden» abre la ventana con las tres copias y el PDF se descarga como `application/pdf` válido (el visor de PDF del panel de prueba no pinta el iframe; la lectura visual se hizo rasterizando el PDF).

## 122. Despliegue (2026-10-24)
- Commit `77ef47a` en `main` (sin ramas ni PR; sin migraciones). Verificación online: la SPA publicada sirve `index-B73wq8_h.js`, idéntico en nombre al build local y con la llamada `/pdf?copia=`; `/api/salud` responde 200 y `GET /api/ordenes/:id/pdf` existe y exige sesión (401). **No se inició sesión en producción** (no se usan credenciales reales ni se crean datos en talleres reales): el PDF autenticado se probó en la instancia local equivalente y en las pruebas de integración, no en la URL pública.


# Sprint 20 — Seguimiento público de órdenes de trabajo

## 123. Qué se hizo
- **Enlace individual por OT** (`docs/SEGUIMIENTO.md`): en el detalle de la orden, tarjeta «Seguimiento del cliente» con *Activar seguimiento*, *Copiar enlace*, *Compartir por WhatsApp*, *Compartir…* (selector nativo si el navegador lo ofrece), *Mostrar código QR* (descargar o compartir la imagen), *Desactivar* y *Regenerar*. Al cambiar el estado de la OT hay un campo **aparte** «Mensaje para el cliente» (la nota interna no se publica nunca).
- **Página pública** `GET /seguimiento/:token` (HTML generado por el Worker, sin JavaScript ni recursos externos, celular primero, claro/oscuro) y su JSON `GET /api/seguimiento/:token`: taller, N° de orden, marca y modelo, **patente parcialmente oculta**, estado actual con explicación, recorrido (✓ ● ○), historial desplegable con fecha y hora del servidor (zona del taller), última actualización, fecha estimada (como estimación, con advertencia si venció) y mensaje del taller. **Listo para retirar** se destaca.
- **Estados reutilizados, sin sistema paralelo:** `ordenes.estado` y `orden_eventos` siguen siendo la única fuente; `shared/seguimiento.ts` sólo los traduce. No se fuerza una línea recta (puede volver a diagnóstico o esperar repuestos varias veces) y nunca una etapa futura figura como completada. El taller puede **ocultar transiciones internas** del historial (la del estado actual no).
- **Observaciones públicas** con historial y responsable, texto plano de hasta 500 caracteres, separadas de las notas internas; un mensaje nuevo reemplaza al anterior en la página; retirarlo no revive otro.
- **Código QR** local (`qrcode-generator`, MIT, sin servicios ni costos) con sólo la dirección del enlace; nueva copia **«Seguimiento del cliente»** en *Imprimir orden* (`?copia=cliente`: hoja A4 con el QR y la dirección escrita). Las copias del mecánico y de administración no se tocaron.
- **Migración aditiva:** `0017` agrega `seguimiento_enlaces`, `seguimiento_mensajes` y `seguimiento_eventos_ocultos` (+ un disparador que impide reescribir lo publicado). No se tocó contabilidad, inventario, licencias, ARCA ni la gestión de órdenes (el único cambio en `ordenes.ts` es la copia `cliente` del PDF).

## 124. Estados: lo que se adaptó a la estructura real
| Pedido | Existe en la OT | Se muestra como |
|---|---|---|
| Vehículo recibido | `recibida` | Vehículo recibido |
| En diagnóstico | `diagnostico` | En diagnóstico |
| Esperando aprobación | **no existe** (la aprobación vive en el presupuesto) | — |
| Esperando repuestos | `esperando_repuestos` | Esperando repuestos (paso «Espera de repuestos», sólo si ocurre) |
| En reparación | `en_reparacion` | En reparación |
| En control final | **no existe** | — |
| Listo para retirar | `lista` | Listo para retirar |
| Entregado | `entregada` | Entregado |
| (cancelada) | `cancelada` | Orden cancelada, sin recorrido |

Crear «esperando aprobación» o «control final» obligaba a modificar la gestión de órdenes (fuera de alcance). Si el taller los incorpora más adelante, alcanza con agregarlos a `shared/dominio.ts` y a `ESTADO_PUBLICO`/`PASOS` de `shared/seguimiento.ts`.

## 125. Seguridad (resumen; detalle y tabla de requisitos en `docs/SEGUIMIENTO.md` §4)
- Token de 32 bytes aleatorios (43 caracteres base64url), único por orden, no deducible del número ni de ningún id; formato verificado antes de consultar; búsqueda por igualdad exacta con índice único y `activo = 1`.
- **Desactivar** lo apaga al instante; **regenerar** reemplaza el token (el anterior deja de existir). Inexistente, desactivado y reemplazado dan la **misma** respuesta 404.
- **Límite de intentos** por origen con el mecanismo existente (20 fallidos en 10 min → bloqueo de 15; los accesos válidos no escriben).
- `Cache-Control: private, no-store`, `X-Robots-Tag: noindex…` + meta + `robots.txt`, `Referrer-Policy: no-referrer`, CSP `default-src 'none'`, `X-Frame-Options: DENY`, sin cookies; la página no carga nada externo ni ejecuta código; todo texto de la base se escapa.
- El token no se imprime ni se guarda en auditoría, errores ni límites (probado); los errores usan la ruta normalizada (también en el `console.error` del Worker).
- La consulta pública es propia y acotada: sin cliente, teléfono, dirección, datos fiscales, precios, costos, márgenes, notas, diagnósticos, kilometraje, mecánico, fotos, firmas ni ids internos (pruebas sobre la página y el JSON con datos privados sembrados).
- **Límite honesto:** el token viaja en la dirección (como en cualquier seguimiento de envíos), así que los registros de acceso de la infraestructura de Cloudflare pueden contener la URL; por eso la página expone sólo un estado de bajo riesgo y el enlace se puede revocar. Se guarda tal cual en D1 (hay que poder volver a mostrarlo y generar el QR).

## 126. Permisos
`seguimiento.ver` (configuración, **sin** el enlace), `seguimiento.gestionar` (activar/desactivar/regenerar, fecha estimada, transiciones), `seguimiento.compartir` (ver y copiar el enlace, QR, WhatsApp, imprimir el QR), `seguimiento.mensajes` (publicar y retirar). Gestionar, compartir y mensajes exigen *ver*. Por defecto: propietario y administrador todos; **recepción y empleado (heredado) los cuatro**; mecánico, depósito y caja ninguno (el propietario los otorga en Personal → Permisos, grupo «Seguimiento del cliente»). Además hay que poder ver la orden (las asignadas, para quien sólo tiene ese alcance). El cambio de estado sigue con los permisos de siempre. El teléfono del cliente se usa para WhatsApp sólo si la persona puede ver clientes. Otorgar o retirar permisos rige de inmediato (probado).

## 127. Pruebas
- `npm run build` OK. `npm test`: **171 unitarias + 467 de integración, todas OK** (nuevas: 26 unitarias en `tests/unit/seguimiento.test.ts`; 35 de integración en `tests/api/seguimiento.test.ts` y 1 de migración 0017 en `tests/api/migraciones.test.ts`; se ajustó una prueba de `hoja-orden` que usaba «cliente» como copia inválida).
- Cubierto de punta a punta contra el Worker real: generación del enlace (idempotente, token aleatorio, uno por orden), apertura anónima, **cambio de estado desde la OT (recepción y mecánico asignado) reflejado en la página y el JSON**, recorrido sin etapas futuras completadas y con vuelta a diagnóstico, mensajes (publicar, reemplazar, retirar, validar, HTML escapado, historial inmutable por SQL), fecha estimada (mostrar, ocultar, vencida, sin fecha, sin tocar la planificación), transiciones ocultas, copia del cliente del PDF (QR, permisos, 409 sin seguimiento, sin datos privados), **desactivación y regeneración inmediatas**, **aislamiento entre dos talleres** (404 en las 7 operaciones, tokens alterados/truncados/ampliados y parámetros que intentan elegir otra orden), ausencia de datos privados y financieros (texto y claves del JSON), cabeceras, token fuera de los registros, límite de intentos y permisos granulares.
- **Hallazgo corregido:** `scripts/lib.mjs` dejaba la salida de wrangler sin leer; desde la migración 0017 la tabla de `d1 migrations apply` supera el búfer de la tubería de Windows y la preparación de las pruebas se colgaba. Ahora la salida se consume siempre y la entrada se cierra.
- **A mano** (instancia aislada 8790/5180, Taller Demo): activar desde la OT, copiar/WhatsApp (con el teléfono del cliente, el mensaje pedido y el enlace)/QR, **página pública a 375, 768 y escritorio sin scroll horizontal** (claro y oscuro), cambio de estado con nota interna y mensaje al cliente (la página muestra el mensaje y el nuevo estado; la nota interna no aparece), desactivar → «Este enlace no está disponible», ventana *Imprimir orden* con la cuarta copia. El **QR del PDF se rasterizó y se decodificó con una librería de lectura (jsQR): devuelve exactamente la dirección del enlace**.
- **No comprobado:** teléfonos físicos, cámara real leyendo un QR impreso, WhatsApp real (sólo se verifica el enlace armado), impresoras, Safari/iOS.

## 128. Despliegue (2026-10-24)
- **Respaldo previo** de la D1 remota: `respaldos/d1-antes-sprint20-20261024-2228.sql` (fuera de git; 108 tablas, 11.485 filas, integridad OK, 0 claves foráneas rotas, SHA-256 `ab8da737…76ba`, bookmark de Time Travel `00000267-00000000-0000510e-7d33108749964230436ee431735903d0`).
- **Ensayo** de la migración sobre ese respaldo (`respaldo -- ensayar-migraciones`): 108 tablas y 11.485 filas comparadas, **todas idénticas**; +3 tablas; integridad OK.
- `wrangler d1 migrations apply DB --remote` **antes** de publicar el código; respaldo posterior `respaldos/d1-despues-sprint20-20261024-2247.sql`: 111 tablas, 11.486 filas (la nueva es el registro de la migración), integridad OK, 0 claves foráneas rotas, migraciones al día; en remoto existen las 3 tablas, sus índices y el disparador.
- `wrangler.jsonc`: `run_worker_first` incluye `/seguimiento/*` (la página la atiende el Worker, no los assets); `wrangler deploy --dry-run` reconoce D1, R2 y las variables.
- **Verificación online (2026-10-24):** commit `146f5cd` en `main` (sin ramas, sin PR, sin `gh`); Workers Builds publicó la versión `bccbfc5e…` de `taller-mecanico` (22:50:31 UTC) y conserva D1, `env.FIERRO_FOTOS` (R2) y los secretos `PLATFORM_ADMIN_TOKEN` y `FOTOS_BACKUP_TOKEN`. En https://taller-mecanico.estrubia455.workers.dev: la SPA publicada sirve `index-CaUv9kvQ.js` (el mismo nombre del build local); `/api/salud` 200; `GET /seguimiento/<token inexistente>` responde **404 con la página «Este enlace no está disponible» y las cabeceras de seguridad** (`Cache-Control: private, no-store`, `X-Robots-Tag: noindex…`, `Referrer-Policy: no-referrer`, CSP cerrada, `X-Frame-Options: DENY`) — es decir, el Worker atiende `/seguimiento/*` antes que los assets; `GET /api/seguimiento/<inexistente>` 404 JSON con las mismas cabeceras; `/seguimiento/uno/dos` 404; `/robots.txt` con `Disallow: /seguimiento/`; `GET /api/ordenes/:id/seguimiento` y `/pdf?copia=cliente` sin sesión → 401; `/api/plataforma/fotos-respaldo/manifiesto` sigue exigiendo token (401).
- **No verificado online:** **no se inició sesión en producción ni se activó ningún seguimiento real** (no se usan credenciales reales ni se crean datos en los talleres reales), así que el flujo completo con un enlace válido se probó en la instancia local equivalente y en las pruebas de integración, no en la URL pública; tampoco celulares físicos, WhatsApp real ni lectura de un QR impreso con una cámara.

## 129. Lo que no se hizo / pendientes
- «Esperando aprobación» y «En control final» (no existen en la OT; ver §124).
- El enlace no vence solo (sigue diciendo «Entregado» hasta que se desactive): decisión a revisar con los talleres.
- Sin avisos automáticos al cliente (no se contrató WhatsApp Business API, a propósito) ni tiempo real.
- Verificación en dispositivos físicos y verificación autenticada en producción (ver §128).

## 130. Mejora 20B: seguimiento automático, WhatsApp unificado y foto del vehículo en el PDF (2026-10-26)
- **Seguimiento automático.** Toda orden nueva nace con su enlace de seguimiento ACTIVO: `sentenciasEnlaceInicial` (`worker/lib/seguimiento.ts`) va en el mismo batch atómico que el `INSERT` de la OT, tanto en `POST /api/ordenes` como en `POST /api/presupuestos/:id/convertir` (cualquier pantalla que cree órdenes). Si algo falla no hay orden ni enlace (nunca se muestra un enlace que no existe). `ON CONFLICT DO NOTHING`: no duplica, no reactiva un enlace desactivado ni cambia un token. Editar la orden o cambiar su estado no toca el seguimiento. Las órdenes existentes conservan su estado (sin migración ni relleno retroactivo). Activar, desactivar, regenerar y reactivar siguen como en el Sprint 20 (mismo sistema de tokens). Auditoría: `seguimiento_activado` con `{automatico: true}`.
- **WhatsApp unificado.** Una sola acción, «Enviar WhatsApp al cliente» (`BotonWhatsAppOrden`, texto en `shared/mensaje-ingreso.ts`): abre WhatsApp con el mensaje armado con los datos reales (nombre, marca y modelo, patente, N.º de orden, nombre del taller y el enlace individual), al teléfono del cliente si existe y la persona puede ver clientes (si no, sin destinatario). No envía nada solo ni usa APIs pagas. Sin enlace disponible (desactivado o sin `seguimiento.compartir`) el mensaje sale sin esa parte. Con la orden «lista» avisa que puede retirarlo. Se oculta en órdenes entregadas/canceladas. Desaparecieron «Compartir por WhatsApp», «Compartir…» y el WhatsApp genérico del encabezado; quedan *Copiar enlace*, *Mostrar código QR*, *Ver como cliente*, *Regenerar* y *Desactivar*. Al crear la OT el aviso «Orden creada» ofrece *Imprimir orden* y *Enviar WhatsApp al cliente* (no se abre nada solo).
- **Foto del vehículo en el PDF** (copias mecánico y administración; la hoja QR del cliente no cambia). Sin concepto de «foto principal» en el modelo del Sprint 16, se elige: 1) la foto más reciente de la galería del vehículo (sin OT), 2) la foto de recepción de ESTA orden, 3) otra foto de esta orden. Nunca fotos de otras órdenes ni del catálogo. Se lee la **miniatura** (JPEG ≤ 200 KB, 480 px) de R2 desde el servidor (sin enlaces públicos), verificando tamaño y SHA-256 contra la fila de D1; exige `fotos.ver` (y `vehiculos.ver` para la galería) además de poder imprimir esa orden, y todo filtrado por el taller de la sesión. Cualquier problema (sin bucket, objeto faltante, hash distinto, formato no incrustable) pasa a la siguiente candidata y, al final, a ninguna: la hoja sale igual. Va a la derecha del bloque cliente/vehículo/técnico, ajustada **dentro de 30 × 23 mm sin deformarse** (horizontal 30 × 22,5; vertical ~17 × 23) con un marco fino; las filas se angostan sólo cuando hay foto, así que **no suma altura**: las anotaciones siguen desde los 145 mm con sus 14 renglones y no aparece una página extra (la paginación para órdenes extensas no cambió). Una sola imagen se comparte entre ambas copias del PDF.
- **Formatos.** El navegador recomprime siempre a JPEG al subir (PNG, WebP o la cámara llegan como JPEG, ya con la orientación aplicada y sin EXIF), así que en la práctica toda miniatura es incrustable. Una miniatura subida directo por API como WebP no se puede incrustar sin decodificarla (no hay decodificador en el Worker ni se contrató uno): se omite y se prueba con la siguiente foto.
- **Pruebas.** `npm run build` y `npm test` OK (unitarias +6; integración +16 en `tests/api/orden-20b.test.ts`; se ajustaron 2 pruebas del Sprint 20 que suponían «sin enlace al crear»). Cubierto: enlace único y activo al crear (también desde presupuesto), apertura sin sesión, desactivado que no se reactiva al editar/cambiar estado, orden vieja sin enlace que sigue sin enlace, PDF con y sin foto, prioridad de fotos, fotos de otra orden/vehículo/taller excluidas, foto eliminada, WebP omitida, permisos y hoja QR intacta; mensaje de WhatsApp (4 unitarias). A mano (instancia aislada 8790/5180): aviso de orden creada, botón con el teléfono y el enlace real; PDF rasterizado con PyMuPDF (foto horizontal y vertical, 14 renglones, 1 página por copia).
- **Sin migración** (no hizo falta respaldar ni ensayar la D1). Pendiente: probar con fotos reales de cámara y en WhatsApp real en el teléfono del taller piloto.

## 131. Sprint 21: identidad ORVELAN Sistemas · Taller Mecánico (2026-10-26)
- Marca integrada desde el kit oficial (ver `docs/BRANDING.md`): login, activación, menú, cabecera móvil, favicon, PWA (nombre, íconos, `theme_color`), título, pie de impresos, página pública de seguimiento y metadatos de PDF. Paleta `marca-*` y `petroleo-*` reemplazada por la del manual; el resto de los tokens no cambió.
- **Discrepancia de nombre:** el kit dice ORVELAN, el encargo decía «Overlan»; se respetó el kit.
- Sin cambios de datos, migraciones ni infraestructura. `npm run build` y `npm test` OK (177 unitarias + 483 de integración). Verificado a mano en local (login escritorio y móvil, menú con sesión); sin verificar en dispositivos físicos ni impresión real.

## 132. Sprint 22: consulta de precios y operaciones rápidas (2026-10-26)
**Qué se hizo.** Tres mejoras integradas, sobre los datos y reglas existentes (sin módulos paralelos):
1. **Consultar precios** (botón en Inicio, ventana sobre la pantalla actual, `src/components/ConsultaPrecios.tsx`, `GET /api/rapidas/consulta-precios`). Busca por nombre, marca, SKU y código de barras (todas las palabras deben coincidir; el código exacto sale primero). Foco automático, Escape cierra, Enter (lo que envía el lector USB) busca en el acto y deja el texto seleccionado para el próximo escaneo. Muestra marca, SKU, código de barras, stock (con el detalle por depósito si hay más de uno) y precio de venta, con selector de lista de precios (preselecciona la predeterminada). Un artículo sin precio configurado se muestra «Sin precio configurado» (el servidor devuelve `precio: null`; nunca un 0 ni un precio inventado, tampoco con listas sobre costo).
2. **Operaciones rápidas** (`/operaciones-rapidas`, `src/pages/OperacionesRapidas.tsx`, menú Ventas). Un campo de búsqueda/escaneo siempre enfocado (un escaneo suma una unidad; escanear dos veces el mismo código no duplica la línea; el campo se vacía en el acto para que un escaneo de corrido no se mezcle) y un carrito por tipo de operación, con confirmación antes de registrar:
   - **Venta rápida**: es una venta común, `POST /api/ventas` (stock, caja, cobros, cuentas corrientes y contabilidad de siempre); sólo la clave de idempotencia lleva el prefijo `rapida:` para poder listarla en el historial. Lista de precios (recalcula el carrito con el mismo endpoint que las ventas), descuento por línea, cliente, contado o cuenta corriente, medio de pago, depósito. Se pide ver precios de venta además de emitir.
   - **Consumo en OT** (`POST /api/rapidas/consumo-ot`): agrega los repuestos como **ítems de la orden** (el mecanismo de siempre: `orden_items`); el precio sale de la lista de la orden (o el precio base) y lo resuelve el servidor. **El stock no se toca**: lo descuenta la OT, una sola vez, al pasar a «lista» (por eso no hay descuento doble; probado de punta a punta). Sólo órdenes sin stock descontado (recibida, diagnóstico, en reparación, esperando repuestos); con la orden «lista» devuelve 409 `orden_cerrada` y pide volverla a «En reparación». Valida stock contra el depósito de la orden contando lo que la orden ya tenía; rechaza artículos sin precio; deja una nota interna en la OT; guarda con guard de versión (una edición ajena o un reintento simultáneo abortan todo el lote). Exige lo mismo que editar una OT con importes (`ordenes.modificar` + ver precios + presupuestos valorizados).
   - **Baja interna** (`POST /api/rapidas/bajas`): motivos rotura, pérdida/robo, consumo interno, merma, vencimiento u otro (con explicación obligatoria), depósito, responsable (texto libre, opcional), fecha (siempre hoy, para que coincida con el asiento) y quién registró. Genera **movimientos de stock manuales** (`tipo salida`, `origen_tipo manual`, costo vigente): el asiento de «diferencias de inventario» ya existente los toma sin cambios; **no crea ventas, cobros ni movimientos de caja** (probado). Exige `stock.ajustar`.
   - **Historial** (`GET /api/rapidas/historial`): ventas rápidas, consumos y bajas, de más nueva a más vieja, filtrado por permisos (ventas → `ventas.ver`, consumos → `ordenes.ver`, bajas → `stock.ver`; los importes sólo con presupuestos valorizados).
3. **Accesos rápidos en Inicio**: Nueva OT, Consultar precios, Operaciones rápidas, Presupuesto y Agenda, cada uno sólo si la persona tiene el permiso (los dos botones del encabezado pasaron a esta sección; los indicadores y tarjetas del tablero no cambiaron).

**Datos (migración 0018, aditiva).** `operaciones_rapidas` (consumos y bajas: quién, cuándo, depósito, orden, motivo, responsable, notas, `idem_key` única por taller) y `operacion_rapida_items`; el historial no se reescribe (disparadores `BEFORE UPDATE`) y los CHECK exigen orden para el consumo y motivo para la baja. Las operaciones son atómicas: una sola `batch` (guard de la orden o del stock + registro + movimientos + auditoría); un reintento con la misma clave devuelve la operación ya registrada (`duplicado: true`, 200) sin repetir nada, también si llegan dos a la vez.

**Seguridad y privacidad.** El costo sólo viaja con `precios.costo.ver`; el stock con `stock.ver`; el precio con `precios.venta.ver` (sin ese permiso tampoco llegan `precio`, `sin_precio` ni `precio_origen`, ni se aplica la lista). Todo se filtra por el taller de la sesión: artículos, listas, depósitos y órdenes de otro taller responden 400/404 (probado en las tres operaciones y en la consulta).

**Pruebas.** `npm run build` OK; `npm test`: **177 unitarias + 498 de integración, todas OK** (nuevas: 14 en `tests/api/rapidas.test.ts` —consulta, listas, privacidad de costo/stock/precio, aislamiento, consumo con y sin reintento y luego «lista» sin descuento doble, stock insuficiente, sin precio, permisos, bajas con depósito y atomicidad, sin ventas ni cobros, venta rápida con reintento, historial y permisos— y 1 de migración 0018 en `tests/api/migraciones.test.ts`). A mano (instancia aislada 8790/5180): modal desde Inicio (foco, búsqueda, Escape), escaneo con Enter, carrito, venta y consumo de punta a punta, **375 px sin scroll horizontal** en las tres operaciones y en el modal.

**Despliegue (2026-10-26).** Respaldo previo `respaldos/d1-antes-sprint22-20261026-2013.sql` (fuera de git; 111 tablas, 11.519 filas, integridad OK, 0 claves foráneas rotas, SHA-256 `4f8da2c0…9411`, bookmark Time Travel `00000489-00000000-00005110-f51e50a09b62cc05538998da9d61122d`). Ensayo de la migración sobre ese respaldo: 111 tablas y 11.519 filas **idénticas**, +2 tablas, integridad OK. `wrangler d1 migrations apply DB --remote` antes de publicar el código; respaldo posterior `respaldos/d1-despues-sprint22-20261026-2014.sql`: 113 tablas, 11.520 filas (la nueva es el registro de la migración), integridad OK, 0 claves foráneas rotas, migraciones al día.

**Decisiones y límites.**
- «Descuentos autorizados»: el sistema no tiene un permiso de descuentos; la venta rápida permite el descuento por línea igual que la venta de mostrador (quien emite ventas y ve precios). El precio no se edita en el carrito.
- El consumo en OT no descuenta stock por sí mismo (lo hace la OT al quedar lista) y no admite órdenes ya listas: así hay un solo mecanismo de descuento y de reverso. Pedir que se descuente en el acto, aun con la orden en reparación, exigiría un segundo circuito de stock en la OT.
- La baja no se anula como operación: se corrige con una entrada manual de stock. No hay «anular baja» (no estaba pedido).
- Quien sólo tiene permisos de depósito no puede cargar consumos (requiere editar órdenes con importes); el propietario puede otorgar los permisos.
- **No verificado:** lector de códigos físico (se simuló el Enter), tablets y celulares reales, y la verificación autenticada en producción (no se usan credenciales reales; ver §133 al publicar).

## 133. Verificación online del Sprint 22 (2026-10-26)
- Commit `0119d93` en `main` (sin ramas, sin PR, sin `gh`). Workers Builds publicó la versión nueva de `taller-mecanico`: https://taller-mecanico.estrubia455.workers.dev sirve `index-DFpr2IYu.js`, el mismo nombre del build local (antes servía `index-CJwHnOSu.js`).
- Sin sesión: `/api/salud` 200; `GET /api/rapidas/consulta-precios`, `GET /api/rapidas/historial` y `POST /api/rapidas/bajas` responden **401** (las rutas existen y exigen sesión); `/operaciones-rapidas` 200 (la SPA).
- La migración 0018 ya estaba aplicada en la D1 remota antes de publicar (ver §132).
- **No verificado online:** no se inició sesión en producción ni se registró ninguna operación en los talleres reales (no se usan credenciales reales ni se crean datos en ellos). El flujo completo con sesión se probó en las pruebas de integración y en la instancia local equivalente.
