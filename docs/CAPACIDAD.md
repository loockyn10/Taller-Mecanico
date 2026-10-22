# Medición de capacidad de Fierro (Sprint 13)

Estado al **22/10/2026**. Este documento dice **qué se midió, en qué condiciones, qué se encontró y se corrigió, y qué NO se puede afirmar todavía**. Conclusión corta, para no leer entre líneas:

> **No hay evidencia suficiente para afirmar que Fierro soporta 100 talleres.** Lo que sí se demostró: (1) el costo de las operaciones críticas **ya no crece con el historial del taller** (antes crecía en forma lineal por tres motivos que se corrigieron); (2) sin errores, con la contabilidad al día y los asientos cuadrados, con 10 talleres y hasta 50 usuarios simultáneos sobre **una instancia local**; (3) un modelo de consumo de D1 que, **con supuestos explícitos que hay que validar con uso real**, entra holgado en el plan pago de D1 y **no** entra en el gratuito. Lo que falta medir está en §6.

## 1. Cómo se midió (y por qué hay que leerlo con cuidado)

`npm run carga` (`scripts/carga/carga.mjs`) levanta **su propio Worker local** (`wrangler dev` + D1 local de Miniflare en una carpeta temporal, puerto 8791) con datos **ficticios**, y mide con una instrumentación del Worker (`MEDIR_D1=1`, `worker/lib/observabilidad.ts`) que cuenta por solicitud: consultas a D1, sentencias, **filas leídas y escritas** (los metadatos que devuelve D1), tiempo en D1 y en el Worker, y las sentencias que más filas leyeron. **Nunca apunta a producción**: no acepta una URL y la medición está apagada en el Worker publicado.

| Se midió | No se midió (y por qué importa) |
|---|---|
| Latencia p50/p95/p99, errores, op/s bajo concurrencia | **Latencia de red de D1 real**: acá la base es SQLite local (≈ 0,1 ms por consulta). En Cloudflare cada consulta suma un viaje de ida y vuelta (decenas de ms si el Worker y la base están lejos). Una venta con 20 consultas puede tardar bastante más que acá |
| Consultas, filas leídas/escritas por operación (**estas sí son portables**: no dependen de la red) | **Contención de escrituras**: D1 serializa las escrituras de una base. Cien talleres comparten **una** base; acá hay un solo escritor local |
| Escalado del costo con el historial (0 → 3.000 ventas por taller) | **Escalado horizontal de Cloudflare**: acá todo corre en un único proceso; en producción cada solicitud puede correr en su propio aislado |
| Tiempo de contabilización por operación (incluida en cada escritura: `CONTAB_SYNC=esperar`) | Costo de CPU por solicitud en la plataforma (el límite depende del plan) |

Máquina de las pruebas: ver `scripts/carga/resultados/*.json` (ignorados por git; se regeneran con el comando). Reproducir:

```bash
npm run carga -- --modo escala --historiales 0,200,1000,3000        # costo vs. tamaño del historial
npm run carga -- --modo mixto  --talleres 10 --vus 20 --duracion 30 --historial 200   # carga mixta
npm run carga -- --modo curva  --talleres 10 --historial 150 --niveles 1,5,10,25,50   # latencia vs. usuarios
npm run carga -- --modo login  --vus 20                              # costo del inicio de sesión
```

La mezcla simula (sin pausas, así que es un **máximo**, no un uso normal) ~70 % de lecturas (consultas de clientes, buscador, búsqueda de artículos, listado de órdenes, tablero, informes de ventas, cuentas corrientes, inventario valorizado y balance contable) y ~30 % de escrituras (apertura de órdenes, ventas, cobros y movimientos de inventario). Cada taller tiene la contabilidad activada, así que **cada escritura incluye su contabilización**.

## 2. Hallazgos críticos y qué se corrigió

| # | Hallazgo (cómo se vio) | Corrección | Antes → después |
|---|---|---|---|
| 1 | **Cada operación recorría todo el historial contable.** Cada venta, cobro o movimiento relanzaba la contabilización releyendo todos los documentos de las 16 fuentes (Sprint 12). | **Cola persistente** (`contab_cola`) alimentada por triggers dentro de la transacción de la operación; el proceso lee solo lo nuevo. El recorrido completo queda como *reconciliación* por lotes (activación, verificación semanal). | Filas leídas por pasada con 3.000 ventas: **9.395 → 127** (la pasada completa de antes costaba 387 filas con 0 ventas y crece ~3 por venta). Consultas a D1 por venta: ≈ 60 → **19–21** (la pasada completa de antes hacía 49 consultas por sí sola) |
| 2 | **Asignar el número de asiento recorría el libro.** `MAX(numero)+1` sobre el índice equivocado (`idx_asientos_fecha`) en cada asiento; también el contador del estado contable. Lo reveló la prueba de escala (una venta pasaba de 163 a 3.170 filas). | `AND numero IS NOT NULL` para usar el índice parcial (una búsqueda). Medido en SQLite: **6,5 ms → 0,001 ms** con 200.000 asientos. | Una venta con 3.000 de historial: **3.170 → 127 filas**. Estado contable: **3.118 → 73 filas** |
| 3 | **Faltaban índices de los renglones de cobros** (`cobro_medios`, `cobro_aplicaciones` por `cobro_id`), también de compras y recepciones. Cada cobro (y cada contabilización de un cobro) recorría todos los del taller. | Migración 0013: 4 índices nuevos. | Un cobro con ~400 ventas de historial: **3.535 → 143 filas leídas**; movimiento de stock **280 → 130**; apertura de OT **138 → 97** |
| 4 | **El tablero (se abre y se refresca cada 60 s por cada pestaña) recorría todas las ventas del taller** (`substr(fecha,1,7)`; el pendiente de cobro sumaba todo el historial). | Rango de fechas (usa `idx_ventas_fecha`) y un índice parcial de ventas con saldo pendiente (`idx_ventas_por_cobrar`). | Ahora cuesta lo que se vendió **en el mes** y lo **pendiente**, no el historial. |

Detalle de la prueba de escala (un taller, una venta nueva; "completo" = lo que hacía cada operación en el Sprint 12, ahora disponible solo como reconciliación):

| Ventas previas | Venta: filas leídas **antes** → **ahora** | Pasada completa (Sprint 12), filas | Estado contable, filas **antes** → **ahora** | Detalle por origen, filas |
|---:|---|---:|---|---:|
| 0 | 164 → 123 | 387 | 115 → 71 | 288 |
| 200 | 366 → 124 | 987 | 315 → 71 | 1.088 |
| 1.000 | 1.170 → 124 | 3.387 | 1.118 → 71 | 4.288 |
| 3.000 | 3.170 → **127** | 9.395 | 3.118 → **73** | 12.295 |

El costo de una venta es **plano** (≈ 125 filas leídas, 39 escritas, 19 consultas) y el estado que consulta la pantalla cada 8 segundos mientras hay algo pendiente también. La "pasada completa" y el "detalle por origen" (`GET /contabilidad/estado?detalle=1`, solo en activación) siguen siendo lineales a propósito: son los únicos que miran todo el historial.

## 3. Resultados de la carga mixta

10 talleres ficticios (200 ventas de historial c/u, 60 clientes, 80 artículos, contabilidad activada), **20 usuarios simultáneos** durante 30 s sin pausas, un único proceso local:

| Operación | n | p50 ms | p95 ms | p99 ms | Consultas D1 | Filas leídas | Filas escritas |
|---|---:|---:|---:|---:|---:|---:|---:|
| Venta (con contabilización) | 242 | 375 | 623 | 806 | 20,7 | 160 | 58 |
| Cobro (con contabilización) | 100 | 377 | 592 | 729 | 21,1 | 149 | 53 |
| Movimiento de inventario | 122 | 356 | 525 | 776 | 17,6 | 136 | 33 |
| Apertura de orden | 175 | 319 | 493 | 587 | 12,1 | 95 | 19 |
| Cuentas corrientes | 65 | 235 | 431 | 606 | 2 | 524 | — |
| Tablero | 131 | 249 | 400 | 467 | 7 | 585 | — |
| Estado contable | 78 | 234 | 385 | 606 | 6 | 73 | — |
| Listado de órdenes | 169 | 212 | 366 | 435 | 2 | 48 | — |
| Inventario valorizado | 43 | 238 | 363 | 409 | 2 | 166 | — |
| Buscador global | 173 | 225 | 362 | 605 | 3 | 128 | — |
| Listado de ventas | 83 | 232 | 359 | 606 | 2 | 540 | — |
| Búsqueda de artículos | 311 | 222 | 357 | 454 | 2 | 96 | — |
| Consulta de clientes | 324 | 222 | 354 | 447 | 2 | 218 | — |
| Balance contable | 42 | 241 | 353 | 401 | 3 | 4.409 | — |
| Informe de ventas | 63 | 223 | 349 | 547 | 2 | 217 | — |
| Inicio de sesión (100.000 iteraciones PBKDF2) | 20 | 61 | 71 | 71 | 6 | 11 | 6 |

**2.121 operaciones en 30,3 s (70 op/s), 0 errores, 0 conflictos.** Al terminar: los 10 talleres con la contabilidad **al día** (cola vacía) y la **partida doble cuadrada** en todos. Las latencias de arriba son sobre todo **cola de espera de un único proceso** con 20 usuarios pegados sin pausa (con 1 usuario: p50 18 ms, p95 48 ms), no el tiempo de una operación aislada.

**Curva de usuarios simultáneos** (10 talleres, 150 ventas c/u, 15 s por nivel; mismo proceso único):

| Usuarios | op/s | p50 ms | p95 ms | p99 ms | p95 lecturas | p95 escrituras | Errores |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 41 | 19 | 48 | 58 | 23 | 55 | 0 |
| 5 | 69 | 64 | 133 | 165 | 97 | 150 | 0 |
| 10 | 69 | 128 | 251 | 352 | 201 | 313 | 0 |
| 25 | 71 | 316 | 554 | 617 | 421 | 603 | 0 |
| 50 | 71 | 646 | 1.083 | 1.220 | 921 | 1.187 | 0 |

El rendimiento **satura en ~70 op/s** de un único proceso local y la latencia crece linealmente con los usuarios (colas): sin errores, pero no es una medida de lo que hará Cloudflare. **Inicio de sesión:** 60 ms de CPU/espera con 100.000 iteraciones; con 20 inicios simultáneos en este proceso único, p50 945 ms (se serializan). En Cloudflare cada solicitud corre aparte, pero **el costo de CPU por inicio de sesión (~60 ms) debe compararse con el límite de CPU del plan contratado** (no verificado; el inicio de sesión funciona en producción hoy).

## 4. Tiempo de contabilización

La contabilización incremental de una operación es **parte de las 19–21 consultas** de arriba: ~6 consultas de coordinación (turno, configuración, plan), ~4–6 de lectura de lo nuevo y 2–3 de escritura. Con la base local cuesta ~10–15 ms; con D1 real cada consulta suma su viaje de red, por lo que **en producción corre fuera de la respuesta al usuario** (`waitUntil`) y, si se pierde, la recupera el Cron. Los costos de lectura **no dependen** del historial (§2). Una reconciliación (activación de un taller con historia) procesa hasta 400 asientos por pasada: con 430 ventas de historial, 2 pasadas.

## 5. Proyección de consumo de D1 para 100 talleres (**modelo con supuestos**, no medición)

Filas **escritas** por operación (medidas, incluyen índices y asientos): venta 58, cobro 53, orden 19, movimiento de stock 33. Supuestos **míos, sin datos de uso real**: por taller y por día 25 ventas, 20 cobros, 8 órdenes, 10 movimientos de stock, 3 usuarios con el tablero abierto 8 h (1 carga por minuto, ~585 filas con un mes de 200 ventas), ~250 consultas de ~150 filas.

| Concepto | Por taller / día | 100 talleres / mes (30 d) | Plan gratuito de D1 | Plan pago de D1 (incluido) |
|---|---:|---:|---|---|
| Filas escritas | ~3.000 | ~9 millones | 100.000 por día → **~33 talleres** como máximo | 50 millones por mes → ~18 % |
| Filas leídas (el tablero domina: ~840.000) | ~880.000 | ~2.600 millones | 5 millones por día → **~5 talleres** | 25.000 millones por mes → ~10 % |
| Almacenamiento (hoy 1,6 MB con 2 talleres de demo) | — | decenas–centenas de MB | 5 GB | 5 GB incluidos (luego tarifa) |

Conclusiones que el modelo **sí** sostiene: (a) con el plan gratuito de D1 **no se puede** operar 100 talleres (la lectura del tablero lo impide mucho antes que la escritura); (b) con el plan pago hay holgura **si los supuestos son razonables**; (c) la palanca barata es el tablero: pasar su refresco de 60 s a 5 min recorta ~80 % de las lecturas. Los precios y cuotas pueden cambiar: verificar contra la documentación vigente de Cloudflare (no se contrató ni consultó nada de la cuenta). **Hay que reemplazar los supuestos por datos reales** (Analytics de D1 en el panel) apenas haya talleres operando.

Otros límites a vigilar (documentados por Cloudflare, no medidos acá): cantidad máxima de consultas a D1 por invocación del Worker (distinta según el plan; una pasada de reconciliación de 400 asientos hace del orden de 40–80), tiempo máximo de CPU por solicitud y tamaño máximo de una base D1.

## 6. Qué falta para poder afirmar algo sobre 100 talleres

1. **Medir contra D1 real en un entorno de ensayo** (un Worker y una D1 aparte con datos ficticios, no la de producción): latencia por consulta, contención de escrituras con 100 talleres escribiendo, CPU por solicitud. Requiere crear esos recursos en la cuenta (decisión del propietario; hoy no se creó nada). El mismo `npm run carga` sirve si se le agrega esa dirección de ensayo.
2. **Datos de uso reales** de los primeros talleres para reemplazar los supuestos de §5 (Analytics de D1).
3. Revisar los informes pesados que siguen siendo proporcionales al historial **por diseño**: balance contable (4.409 filas con ~1.000 asientos en el período), cuentas corrientes (524) y listados de ventas (540, tope de 300 filas). Aceptables a este tamaño; con talleres de varios años de historia conviene paginar o pre-agregar.
4. Probar el inicio de sesión simultáneo y los límites de CPU en producción con el plan real.
