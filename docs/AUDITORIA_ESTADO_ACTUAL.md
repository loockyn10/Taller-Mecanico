# Fierro v0.1.0 — Auditoría integral del estado actual

- **Fecha:** 2026-10-19
- **Alcance:** repositorio completo (97 archivos versionados, 2 commits), documentos de progreso y de la auditoría de Caldén.
- **Naturaleza:** auditoría independiente y crítica. **No se modificó código de producción, migraciones ni configuración.** Lo único agregado al repositorio es este documento.
- **Cómo se verificó** (cada hallazgo importante lleva una de estas marcas):
  - **[L]** leído en el código (archivo:línea). No implica que funcione.
  - **[E]** ejecutado: compilación, pruebas automáticas o sonda contra una instancia **aislada** (Worker + D1 local en un directorio temporal, puerto 8801, con los datos demo del seed). La base de desarrollo del usuario (`.wrangler/state`, puertos 5173/8787) **no se tocó**.
  - **[N]** observado en el navegador sobre la instancia aislada.
  - **[I]** inferido (documentación de Cloudflare u otra fuente, o razonamiento). No reproducido.
- **Fuentes externas consultadas:** límites y precios vigentes de [D1](https://developers.cloudflare.com/d1/platform/limits/), [precios de D1](https://developers.cloudflare.com/d1/platform/pricing/) y [límites de Workers](https://developers.cloudflare.com/workers/platform/limits/) (consultados hoy; pueden cambiar).

---

## A. Resumen ejecutivo

**Veredicto:** Fierro es una **buena base funcional con un backend sorprendentemente sólido para ser v0.1**, pero **todavía no es vendible**: nunca corrió fuera de la máquina de desarrollo, no tiene backups ni forma de administrar talleres/licencias salvo una CLI, y hay un grupo de problemas de producción que las pruebas locales no pueden detectar.

Lo que está bien (y verificado):
- Arquitectura **React + TypeScript + Cloudflare Workers (Hono) + D1** realmente implementada, tal como estaba prevista. Compila sin errores de tipos [E].
- **Aislamiento multiempresa bien diseñado**: `taller_id` sale siempre de la sesión del servidor y las relaciones usan claves foráneas compuestas `(taller_id, id)`. Revisé todos los módulos del backend y **no encontré IDOR ni consultas sin filtro por taller** [L]; las 37 pruebas de integración (incluye el aislamiento) pasan [E].
- Operaciones comerciales **atómicas e idempotentes** (batch + `tx_guard`, `idem_key`, `CHECK (cobrado <= total)`), con pruebas de concurrencia reales.
- Roles/permisos verificados en el servidor; cupo de usuarios por licencia aplicado dentro de la transacción.

Lo que preocupa:
1. **Nunca se desplegó.** `database_id` es un marcador (`wrangler.jsonc:17`); el hash de contraseñas (PBKDF2 100.000 it.) tarda ~35–60 ms localmente y el plan gratuito de Workers permite 10 ms de CPU por solicitud [I]. No hay entorno de staging, CI ni monitoreo.
2. **Consultas con `IN (?, ?, …)` sin tope** que en D1 de producción (límite documentado: **100 parámetros por consulta**) fallarán con volúmenes reales, p. ej. listado de cobros con más de 99 resultados o ficha de un vehículo con más de 98 OT [I, L]. Localmente funcionan, por eso las pruebas no lo detectan.
3. **Sin backups, sin exportación, sin recuperación de contraseña por email, sin panel de plataforma.** El plan original (`08_PLAN_IMPLEMENTACION.md`) marcaba el backup como imprescindible.
4. **Integridad comercial con huecos de negocio** (reproducidos [E]): fechas libres retroactivas/futuras sin cierre de caja, venta "contado" sin cobro, deuda a "Consumidor final", stock con decimales que bloquea una salida legítima por error de coma flotante.
5. **Seguridad de autenticación mejorable** (bloqueo de cuenta explotable por terceros, enumeración de usuarios por tiempos y mensajes, chequeo CSRF débil, sin cabeceras de seguridad HTTP) y **dependencias con 11 avisos de `npm audit`** (4 de ellos en dependencias de producción, incluido `hono`).
6. **Cero pruebas de interfaz**; solo ~56 % de los endpoints se ejercita en alguna prueba.

**Porcentajes (definición en §12):** ~**77 %** del alcance previsto implementado (estimativo), ~**56 %** respaldado por pruebas automáticas (API únicamente). Esfuerzo estimado a v1.0 vendible: **~120–180 h** (§12.7).

---

## B. Arquitectura actual

| Capa | Implementado | Evidencia |
|---|---|---|
| Frontend | React 18.3 + TypeScript 5.8 + Vite 6 + Tailwind 4 + TanStack Query 5 + React Router 6; PWA (vite-plugin-pwa, sin caché de `/api`) | `package.json`, `vite.config.ts`; build OK: JS 415 kB (115 kB gzip) [E] |
| Backend | **Un solo Worker** (Hono 4.7.7) que sirve `/api/*` y la SPA como assets estáticos; 12 módulos en `worker/modules/`, 94 rutas | `worker/index.ts`, `wrangler.jsonc` (`run_worker_first: ["/api/*"]`) |
| Base de datos | D1 (SQLite) **única y compartida**, 36 tablas, 22 índices, una sola migración `0001_init.sql` (629 líneas) | `migrations/0001_init.sql` |
| Autenticación | Email + contraseña; sesión por token aleatorio de 256 bits en cookie `HttpOnly; SameSite=Lax; Secure` (excepto localhost); en la base solo el hash SHA-256; PBKDF2-SHA256 100.000 it. con comparación en tiempo constante; bloqueo 15 min tras 5 fallos | `worker/lib/auth.ts`, `worker/lib/crypto.ts`, `worker/modules/auth.ts` |
| Permisos | 3 roles (propietario, administrador, empleado), 16 permisos, verificados por endpoint con `requirePerm`; el frontend solo oculta menús | `shared/permisos.ts` |
| Multiempresa | `taller_id` en toda tabla de negocio, tomado de la sesión; FK compuestas; 404 (no 403) ante IDs ajenos | `worker/lib/db.ts` (`delTaller`, `updateParcial`), todos los módulos [L] |
| Licencias | Tabla `licencias` (incluidos + adicionales, activa/suspendida); cupo verificado con `guard()` dentro del batch; suspendida = solo lectura | `worker/modules/taller.ts:81`, `worker/lib/auth.ts:78` |
| Gestión de estado (front) | Servidor = React Query (`staleTime` 15 s); sesión = contexto; estado local por formulario. Sin Redux/Zustand | `src/main.tsx`, `src/lib/auth.tsx` |
| Manejo de errores | Backend: `ApiError` + traducción de errores SQLite a mensajes (`traducirErrorDb`); 500 genérico. Front: `ApiError` + toasts/`ErrorCaja`. **Sin ErrorBoundary de React; `JSON.parse` sin protección en `api.ts:27`** (una respuesta HTML de Cloudflare rompe con un error técnico) | `worker/lib/http.ts`, `src/lib/api.ts` |
| Dependencias principales | hono, zod, react, react-router-dom, @tanstack/react-query, lucide-react (todas con versión fija) | `package.json` |
| Pruebas | Vitest: 8 unitarias + 37 integración contra un Worker real con D1 local temporal | `tests/` |
| Migraciones | Archivo único, aplicado con `wrangler d1 migrations apply`. Sin estrategia documentada para migrar datos entre versiones | `scripts/lib.mjs` |

**¿Se implementó la arquitectura prevista?** Sí: React + TS + Workers + D1. Nota: el plan original (`docs/auditoria/06_ARQUITECTURA.md` / `08`) era **Tauri + SQLite de escritorio, offline y monopuesto**; el producto pivotó a SaaS multiempresa online. Es coherente con el objetivo comercial, pero implica que varios requisitos del plan viejo (backup local, funcionamiento sin internet) **ya no aplican y no fueron reemplazados** por equivalentes en la nube (§H).

**¿Funciona o está preparado?**

| Componente | Estado |
|---|---|
| API completa sobre Worker local + D1 local | **Funciona** [E] |
| SPA servida por el mismo Worker (assets) | **Funciona localmente** [E] (se probó con `wrangler dev --assets` sobre un build aislado) |
| Despliegue en Cloudflare | **Preparado pero NO verificado.** Falta `database_id` real, secretos, dominio/rutas, entorno de staging, `observability`. Ninguna prueba corrió contra D1 remoto |
| Límite de CPU en plan gratuito | **Sin medir** (ver §H) |
| Restricciones propias de D1 remoto (100 parámetros/consulta, patrón LIKE ≤ 50 bytes, 50 consultas/invocación en gratis) | **No contempladas en el código** [I] |

---

## C. Inventario funcional

**Clasificación** (no se confunde código con verificación):
- **COMPLETO Y VERIFICADO (CV):** funciona de punta a punta, con prueba automatizada que ejerce el camino principal **y** verificación manual/sonda. Ningún módulo califica sin reservas porque **no hay pruebas de interfaz**; se usa CV cuando backend y UI se vieron funcionando [E/N] y hay prueba de API.
- **IMPLEMENTADO SIN VERIFICACIÓN COMPLETA (ISV):** código completo, pero sin prueba automatizada del camino principal o sin verificación de UI.
- **PARCIALMENTE FUNCIONAL (PF), SOLO INTERFAZ (SI), NO IMPLEMENTADO (NI).**

Datos: todo lo persistido es real (D1). **No hay datos simulados en el código de la aplicación**; los datos ficticios están solo en `scripts/seed.mjs` (demo). Búsqueda de `mock|fake|simulad|TODO` en `src/worker/shared`: sin coincidencias relevantes [E].

| Módulo | Qué hace y qué se verificó | Validaciones destacadas | Estado | Reservas / defectos |
|---|---|---|---|---|
| Autenticación y sesión | Login/logout/cambio de contraseña/`me` [E] | email válido, contraseña ≥ 8, bloqueo por intentos | **ISV** | `POST /auth/password` sin prueba. Ver hallazgos E-05 a E-08 |
| Plataforma (talleres/licencias) | Alta de taller con catálogo inicial, cambio de licencia, suspensión (API + CLI) [E] | token ≥ 16 caracteres | **PF** | Sin panel web, sin baja/suspensión de taller (`talleres.activo` sin endpoint), sin vencimiento de licencia, sin registro de pagos |
| Usuarios y roles | Alta/edición/desactivación, cupo por licencia [E] | no se desactiva al propietario ni a uno mismo; cupo dentro de la transacción | **CV** | Email único **global** (un mecánico no puede estar en dos talleres) |
| Configuración del taller | Datos fiscales/comerciales, preferencias, usuarios, mecánicos, servicios, marcas, auditoría [N] | rangos numéricos | **PF** | `iva_default` y `recargo_default` se guardan pero **nunca se aplican** (`paramsVacios()` sin argumentos en `NuevaOrden.tsx:25`, `PresupuestoForm.tsx:24`, `Ventas.tsx:141`); sin logo; CUIT sin validar |
| Dashboard | KPIs, OT por estado, agenda, stock bajo [N][E] | permiso para finanzas | **ISV** | Importes se parten en dos líneas en las tarjetas a 1024 px [N]; cada carga recorre filas de varias tablas (§F) |
| Clientes | CRUD, código correlativo, baja lógica, saldo, búsqueda [E] | nombre ≥ 2, email, tipo de documento | **ISV** | Documento sin validar ni unicidad; edición/baja sin pruebas |
| Vehículos | Patente única por taller, km no regresivo, ficha e historial [E] | patente normalizada ≥ 5, año, km | **PF** | **No hay UI ni forma de reactivar un vehículo dado de baja y su patente queda bloqueada** (P1 [E]); `PUT {activo:true}` responde 200 y se ignora en silencio |
| Marcas y modelos | Catálogo inicial por taller, alta/baja [N] | unicidad por taller | **ISV** | Sin pruebas de ningún endpoint |
| Mecánicos | CRUD simple | — | **ISV** | Sin pruebas; sin vínculo con usuarios; sin horas/comisiones |
| Servicios / mano de obra | Categorías, intervalos, ajuste masivo [N] | precio ≥ 0 | **ISV** | Ningún endpoint de servicios ni ajuste masivo tiene prueba; `POST /servicios/ajuste-masivo` + auditoría no atómicos |
| Presupuestos | Alta, edición, estados, vencimiento, conversión única a OT [E] | cliente/vehículo coherentes, ≥ 1 ítem | **CV** | Editar un presupuesto sin enviar `valido_hasta` **borra** la fecha de validez (P18 [E]) |
| Órdenes de trabajo | Alta, edición con control de versión, estados, Kanban, check-list [E][N] | transiciones válidas, km no regresivo | **CV** | Detalle en §D |
| Stock por OT | Descuento una sola vez, reposición al reabrir [E] | `guard` + `idem_key` | **CV** | Comparaciones en coma flotante (E-14) |
| Check-list de ingreso | Guardar/leer [E][N] | listas acotadas | **CV** | Sin fotos/firma (declarado); no se imprime en la "orden" con precios |
| Agenda | Semanal, turnos con presupuesto/OT [E][N] | fecha/hora, refs del taller | **PF** | Sin vista mensual, sin detección de solapamientos ni de capacidad, `PUT`/`DELETE` de turnos sin prueba, borrado sin auditoría |
| Recordatorios de service | Cálculo por km y meses [E] | — | **ISV** | Probado solo de pasada; `setMonth` desborda fin de mes |
| Artículos | CRUD, stock inicial como movimiento [E][N] | alícuota válida, código único | **ISV** | `PUT`/listado sin pruebas; `costo` visible al empleado (P10) |
| Movimientos de stock | Entrada/salida/ajuste idempotentes [E] | stock no negativo (configurable) | **CV** | E-14 |
| Proveedores y compras | Compra suma stock y costo; anulación [E][N] | artículos del taller | **ISV** | **Anulación de compra sin prueba**; costo no se revierte al anular; solo artículos existentes (no gastos) |
| Pagos a proveedores / cuenta corriente | Alta y cuenta [E] | importe > 0 | **ISV** | Anular pago: sin prueba, sin UI, no atómico (UPDATE + auditoría por separado); sin tope contra saldo |
| Comprobante interno desde OT | Uno vigente por OT [E] | OT lista/entregada | **CV** | Carrera teórica con reapertura (E-12) |
| Venta de mostrador | Idempotente, descuenta stock, cobro inmediato [E] | stock, idem_key | **ISV** | Hallazgos P4–P6 [E]; con `idem_key` repetido y carrera devuelve 409, no la venta previa |
| Cobros | Multimedio, parciales, idempotentes, anulación [E] | `CHECK(cobrado<=total)` | **CV** | Sin anticipos/saldo a favor; fecha libre; sin recibo imprimible |
| Cuentas corrientes de clientes | Libro y pendientes [E][N] | — | **CV** | Incluye a "Consumidor final" |
| Estadísticas | Ventas, medios, top servicios/repuestos, por mecánico [E][N] | rango de fechas | **ISV** | Margen usa el costo **actual** del artículo (no el histórico); agrupación por fecha UTC |
| Búsqueda global (Ctrl+K) | Patente, cliente, N° OT [E][N] | mínimo 2 caracteres | **CV** | Patrón LIKE > 50 bytes falla en D1 remoto [I] |
| Impresión/PDF | Presupuesto, OT, hoja de taller, comprobante [N] | — | **ISV** | Se ven bien en pantalla [N]; **el diálogo de impresión real no se pudo verificar**; sin recibo de cobro |
| WhatsApp | Enlaces `wa.me` con texto armado | — | **ISV** | Sin pruebas; asume prefijo 549 |
| Registro de actividad | Lista de las últimas 200 acciones [L] | — | **ISV** | Sin paginación ni purga; no todas las operaciones auditan (turnos, mecánicos, catálogo) |
| PWA | Manifiesto, íconos, service worker [E] | — | **ISV** | Build OK; sin prueba de instalación/actualización |
| Facturación ARCA | — | — | **NI** | Excluida a propósito; tabla `comprobantes_fiscales` reservada |
| Backups / exportación / importación | — | — | **NI** | |
| Recuperación de contraseña por email | — | — | **NI** | |

Botones/acciones sin función: no encontré botones que no hagan nada [L/N]. Sí hay **acciones del backend sin interfaz**: baja de vehículos, borrado de marcas/categorías de servicio, edición de categorías, anulación de pagos a proveedor, listado de pagos. Y configuración que no tiene efecto (IVA/recargo por defecto).

---

## D. Flujos operativos

| Flujo | Estado | Observaciones |
|---|---|---|
| Clientes → Vehículos → Presupuestos → OT | **Funciona** [E] | Conversión única (índice único + guard) probada con solicitudes simultáneas. El vehículo debe pertenecer al cliente (validado). |
| OT → Servicios → Repuestos → Finalización | **Funciona** [E] | Stock se descuenta al pasar a "lista", se repone al reabrir; rollback atómico si falta stock (probado). Reabrir con comprobante vigente está bloqueado. |
| Inventario → Movimientos → Existencias | **Funciona con una falla** | Movimientos idempotentes e inmutables, libro con stock resultante. **E-14:** `stock` es `REAL`; con 0,3 − 0,1 el stock queda en 0,19999999999999998 y una salida de 0,2 se rechaza por "stock insuficiente" [E]. Afecta aceite/líquidos a granel. |
| Ventas → Cobros → Cuentas corrientes | **Funciona** [E] | Sin doble cobro (probado), sin sobrecobro (CHECK). Huecos de negocio abajo. |
| Agenda → Turnos → Atención | **Funciona parcialmente** [E] | Turno ligado a presupuesto pasa a "en taller" al convertir y a "completado" al entregar. Sin control de solapamientos ni capacidad. |

**Procesos que NO funcionan de punta a punta todavía:**
1. Cualquier flujo con más de 99 registros relacionados en **D1 remoto** (listado de cobros, ficha de vehículo con muchas OT, documentos con muchos artículos distintos): fallarían por el límite de parámetros [I].
2. Backup/restauración de un taller. 3. Alta de taller desde una interfaz. 4. Recuperación de contraseña. 5. Facturación fiscal. 6. Recibo imprimible de cobro. 7. Migración de clientes/artículos desde el sistema anterior (sin importación).

**Consistencia de datos, integridad, transiciones, duplicados:**
- Integridad referencial: FK compuestas en todas las relaciones; FK enforced por D1 [L].
- Transiciones de OT (`shared/dominio.ts`) y de presupuesto (`presupuestos.ts:106`) centralizadas y verificadas en servidor.
- Duplicados: `idem_key` en cobros, ventas, movimientos, pagos y compras (en compras indirectamente por el movimiento de stock → un reintento devuelve 409, no el original).
- Hallazgos de inconsistencia comercial **reproducidos** en la instancia aislada [E]:
  - **P4:** venta a `cuenta_corriente` sin cliente queda a nombre de "Consumidor final" (deuda anónima, imposible de cobrar con criterio).
  - **P5:** venta "contado" sin `cobro` queda impaga (el campo `condicion` es solo una etiqueta).
  - **P6/P6b:** `fecha` aceptada arbitrariamente (1999, 2099), **también por el rol empleado** en ventas y cobros: permite alterar reportes y no hay cierre de períodos ni de caja.
  - **E-12 (teórico, no reproducido en 12 intentos):** `POST /ordenes/:id/estado` verifica la existencia de comprobante antes del batch pero el batch no lo vuelve a comprobar; una emisión de comprobante concurrente podría dejar una OT reabierta con comprobante vigente.

---

## E. Seguridad y multiempresa

**Resultado central:** no encontré fallas de aislamiento entre talleres ni IDOR. Se revisó cada consulta de los 12 módulos: todas filtran por `taller_id` de la sesión, los IDs de entrada se validan contra el taller antes de usarse (`delTaller`, `validarItems`, `validarCabecera`, `validarRefs`) y la base lo refuerza con FK compuestas [L]. Las pruebas de `seguridad.test.ts` cubren listados, lectura, modificación y referencias cruzadas sobre clientes, vehículos, artículos, presupuestos, OT, ventas, cobros y cuentas [E]. **Reservas:** no hay pruebas de aislamiento sobre compras, proveedores, pagos, turnos, mecánicos, servicios y categorías (el código es correcto por lectura, pero no está protegido contra regresiones).

### Hallazgos

| ID | Gravedad | Hallazgo | Evidencia |
|---|---|---|---|
| E-01 | **ALTO** | **Producción: consultas con `IN (?,…)` sin tope.** D1 limita a 100 parámetros por consulta. Rompen en producción: listado de cobros con >99 filas (`comercial.ts:191`, LIMIT 300), ficha de vehículo con >98 OT (`maestros.ts:171`, sin LIMIT), documentos/ventas con >98 artículos distintos (`documentos.ts:35`, `stock.ts:35`, `comercial.ts:124,230`, `compras.ts:60`). Localmente SQLite lo tolera, por eso no falla en pruebas. | [L][I] límite de [D1](https://developers.cloudflare.com/d1/platform/limits/) |
| E-02 | **ALTO** | **Hash de contraseñas vs. CPU de Workers.** PBKDF2-SHA256 100.000 it. toma 35–60 ms localmente [E]; el plan gratuito permite 10 ms de CPU por solicitud [I]. Además, hay reportes de que Workers no admite más de 100.000 iteraciones (no confirmado en la documentación; localmente sí se aceptaron 600.000 [E]), por lo que podría no haber margen para subir a las 600.000 que recomienda OWASP. Requiere medir en Cloudflare antes de decidir. | `wrangler.jsonc:22`; `worker/lib/crypto.ts` |
| E-03 | **MEDIO** | **Sin cabeceras de seguridad HTTP en la SPA** (CSP, X-Frame-Options/frame-ancestors, HSTS, Referrer-Policy, Permissions-Policy). Las respuestas del HTML no las incluyen [E]; no existe `public/_headers`. Las del API solo llevan `nosniff` y `no-store`. Riesgo de clickjacking y menor defensa ante XSS. | `curl -I /` [E]; `worker/index.ts:19` |
| E-04 | **MEDIO** | **Dependencias con vulnerabilidades conocidas.** `npm audit`: 11 avisos (2 críticos y 8 altos, 1 moderado). De producción: `hono` 4.7.7 (decenas de avisos; entre ellos `getCookie` con nombre alterado, CORS/JWT/serveStatic que **esta app no usa**, por lo que la explotabilidad real parece baja) y `react-router-dom` (redirecciones abiertas). Críticos: `vitest`/`tinypool` (solo desarrollo). Sin CI ni Dependabot. | `npm audit` [E] |
| E-05 | **MEDIO** | **Bloqueo de cuenta explotable por terceros.** Cualquiera que conozca el email del propietario puede bloquearlo 15 minutos enviando 5 contraseñas erróneas; el bloqueo se repite indefinidamente. Sin límite por IP. | P2b [E]; `auth.ts:25-33` |
| E-06 | **MEDIO** | **Enumeración de usuarios.** (a) Email existente vs. inexistente se distingue por **tiempo** (47–66 ms vs. 7–19 ms [E]) porque el hash solo se calcula si el usuario existe; (b) un email bloqueado responde 429 y uno inexistente 401 [E]; (c) cualquier administrador de un taller puede saber si un email existe **en otro taller** (alta de usuario → 409 "Ya existe un usuario con ese email") [E]. | P2a/P2c/P3 [E]; `taller.ts:111` |
| E-07 | **MEDIO** | **Chequeo CSRF por `Content-Type` débil.** `ct.includes('application/json')` acepta `text/plain;application/json`, un valor que el navegador envía **sin preflight** en peticiones `no-cors` (verificado: se creó un cliente [E]). Hoy lo contiene `SameSite=Lax`; deja de proteger si la cookie se comparte entre subdominios del mismo sitio (p. ej. un subdominio por taller). | P21 [E]; `auth.ts:97` |
| E-08 | **MEDIO** | **API de plataforma expuesta en el mismo host público** y protegida por un único token estático, sin límite de intentos (25 intentos erróneos → todos 401 [E]), sin auditoría y sin rotación. `.dev.vars.example` trae un token de ejemplo de 29 caracteres que **superaría** la validación de longitud si alguien lo copia a producción. | `platform.ts:13`; P13 [E]; `.dev.vars.example` |
| E-09 | **MEDIO** | **Fechas de negocio controladas por el cliente**, incluido el rol empleado (ventas, cobros, compras, pagos): permite retroactivar/adelantar comprobantes y cobros sin rastro más allá de la auditoría. | P6/P6b [E]; `comercial.ts:63,170` |
| E-10 | **BAJO** | **Visibilidad de costos y saldos de proveedores al rol empleado** (`catalogo.ver` incluye `costo`, y `GET /proveedores` devuelve `saldo`). Decisión de negocio, no falla técnica; conviene un permiso aparte. | P10 [E] |
| E-11 | **BAJO** | Sesiones: duración absoluta de 14 días sin expiración por inactividad; las sesiones vencidas solo se purgan en el próximo login de ese usuario; cookie sin prefijo `__Host-`. Se revocan correctamente al cambiar contraseña/rol/desactivar [E]. | `auth.ts:18-26`, `taller.ts:149` |
| E-12 | **BAJO** | Carrera teórica entre reapertura de OT y emisión de comprobante (ver §D). | `ordenes.ts:185-191` |
| E-13 | **BAJO** | Email único global: impide que una misma persona opere en dos talleres y expone E-06(c). Es una decisión de modelo que conviene tomar antes de tener datos reales. | `0001_init.sql:53` |
| E-14 | **MEDIO** | **Stock `REAL` con aritmética de coma flotante**: bloquea salidas legítimas (0,3−0,1=0,19999999999999998 → no se puede egresar 0,2) y deja residuos. | P7 [E]; `0001_init.sql:249`; `stock.ts` (verificarDisponible) |

**Contraseñas:** nunca se almacenan en claro; sal aleatoria de 16 bytes, formato versionado que permite subir iteraciones [L]. **Sesiones:** tokens de 256 bits, solo el hash en la base, cookie HttpOnly/Lax/Secure [L]. **Límites de usuarios por licencia:** aplicados de forma atómica en el servidor y probados [E]. **Roles:** el servidor revalida el rol en cada solicitud (un cambio de rol surte efecto de inmediato) [L]. **Licencia suspendida:** bloquea toda mutación (excepto `/api/auth/*`) [E].

---

## F. Base de datos

36 tablas (plataforma, maestros, catálogo, documentos, caja, compras), todas las de negocio con `taller_id`, `UNIQUE (taller_id, id)` y FK compuestas. Importes en centavos enteros; IDs UUID generados por la API; numeración por taller en `secuencias`; baja lógica en clientes/vehículos/artículos/servicios.

**Fortalezas [L]:** FK compuestas que impiden cruzar talleres a nivel de motor; `CHECK` de rangos y de `cobrado <= total`; índices únicos parciales (una OT por presupuesto, un comprobante vigente por OT, `idem_key`); `tx_guard` como mecanismo de aborte transaccional dentro de `db.batch()` (D1 ejecuta el batch como una transacción).

**Problemas y riesgos:**

| ID | Gravedad | Detalle |
|---|---|---|
| F-01 | **ALTO** | **Una sola migración y ninguna estrategia de evolución**: no hay convención para migraciones futuras con datos reales en N talleres (sin entorno de staging con datos, sin plan de rollback). Con D1, cada migración corre sobre la base compartida de todos los talleres. |
| F-02 | **MEDIO** | **Costo de lecturas por taller.** D1 factura filas **leídas**. El dashboard ejecuta ~8 consultas que recorren todas las filas del taller (`GROUP BY estado`, `SUM(total-cobrado)`, `substr(fecha,1,7)`); faltan índices por fecha/estado (`ventas(taller_id, fecha)`, `cobros(taller_id, fecha)`, `ordenes(taller_id, fecha_ingreso)`, `compras`, `pagos_proveedor(proveedor_id)`, `presupuestos(taller_id, estado)`, `ordenes(taller_id, cliente_id)`), y el front refresca al recuperar foco. Estimación [I]: un taller con 10.000 OT/ventas consume del orden de 40.000 filas por carga de dashboard. |
| F-03 | **MEDIO** | **Una única base D1 para todos los talleres.** Límite de 10 GB por base en el plan pago [D1 limits](https://developers.cloudflare.com/d1/platform/limits/); `LIKE '%…%'` sin índice recorre todas las filas del taller; una consulta lenta de un taller comparte instancia con los demás (SQLite de un solo escritor). Para decenas de talleres es viable; para cientos hay que prever **sharding por taller (una D1 por grupo de talleres)**, y el diseño actual (UUID + `taller_id` en cada fila) lo permite, pero no hay capa de enrutamiento. |
| F-04 | **MEDIO** | Sin purga de `sesiones`, `auditoria` ni `licencia_eventos` (crecen sin límite). |
| F-05 | **MEDIO** | `stock REAL` (E-14) y `cantidad REAL`: debería ser entero en milésimas o `NUMERIC` con redondeo explícito. |
| F-06 | **BAJO** | `talleres` sin estado de baja operativo ni fecha de vencimiento de licencia; `licencias` sin fechas ni plan con precio. |
| F-07 | **BAJO** | No se guarda el **costo histórico** en `venta_items`: los reportes de margen usan `articulos.costo` actual. |
| F-08 | **BAJO** | Algunas escrituras no atómicas con su auditoría: anulación de pago a proveedor y ajuste masivo de precios (`compras.ts:171-173`, `catalogo.ts:106-111`). |
| F-09 | **BAJO** | `ON DELETE CASCADE` desde `talleres` hacia todo: un borrado accidental de un taller destruye todo su historial (no hay endpoint que lo haga hoy). |

**¿Es adecuada para un producto multiempresa comercial?** Sí como punto de partida (el aislamiento por esquema es mejor que el habitual `WHERE taller_id` sin refuerzo). Las decisiones que dolerán con decenas/cientos de talleres: base única sin sharding (F-03), lecturas por dashboard sin índices adecuados (F-02), migraciones sin proceso (F-01), email global (E-13), `REAL` para stock (E-14) y la ausencia de IVA por alícuota para la facturación fiscal (§I).

---

## G. UX/UI

Se revisó en el navegador sobre la instancia aislada, escritorio (~1024 px) y móvil (375 px) [N].

**Fortalezas:** identidad visual propia y coherente (azul/ámbar), kit de componentes único (`src/components/ui.tsx`), **diseño móvil bien resuelto** (tablas convertidas en tarjetas, navegación inferior, menú lateral deslizable), búsqueda global con Ctrl+K, tablero Kanban de OT, vista de impresión limpia (OT con firma, hoja de taller sin precios) [N], estados de carga/vacío/error presentes, doble clic protegido en cobros con clave de idempotencia.

**Problemas detectados:**
1. **Configuración inerte:** "IVA por defecto" y "Recargo por defecto" no se aplican a ningún formulario (el selector de IVA siempre arranca en "Sin IVA / precios…") [N][L]. Confunde al usuario y afecta importes.
2. **Tarjetas del dashboard:** los importes se parten en dos líneas ("$ 265.9 / 20,00") a 1024 px [N]. El saludo dice "Buenas noches, Propietario" (usa el rol, no el nombre).
3. **Agenda:** solo vista semanal; los turnos aparecen truncados (cliente y motivo cortados) [N]; sin control de solapamientos.
4. **Rutas sin guarda por permiso** (`src/App.tsx`): un empleado que escriba `/reportes` o `/compras` ve la pantalla vacía/errónea en lugar de una redirección o un mensaje de "sin acceso" (el menú sí se oculta).
5. **Accesibilidad básica limitada:** 20 usos de `aria-*`/`role` en toda la app; los modales tienen `role="dialog"` pero **sin trampa de foco, sin devolver el foco y sin `aria-labelledby`** (`ui.tsx:335`); no se verificó contraste ni navegación por teclado completa.
6. **Faltan pantallas/acciones previstas:** recibo imprimible de cobro, baja/reactivación de vehículos, anulación de pagos a proveedor, exportación a Excel/CSV, importación de clientes/artículos, panel de plataforma, vista mensual de agenda.
7. **Impresión:** `window.print()` automático a los 400 ms; la pantalla se ve bien pero **el diálogo y los estilos `@media print` reales no se pudieron verificar**. El documento al cliente muestra "Estado" interno de la OT.
8. **Errores de red/servidor:** una respuesta no-JSON (p. ej. 502 de Cloudflare) rompe `api.ts` con un mensaje técnico; no hay `ErrorBoundary`.
9. **Sin paginación** en listados (límites duros de 200–500 filas), y la búsqueda de artículos/clientes carga hasta 300 filas.

No se rediseñó nada (solo observación).

---

## H. Preparación para producción

### Indispensable antes de vender
| # | Requisito | Estado |
|---|---|---|
| 1 | **Desplegar en una cuenta de Cloudflare (staging y producción separados)**, con `database_id`, secretos, dominio y `observability` | NO hecho |
| 2 | **Medir CPU del login en Cloudflare** y decidir: Workers Paid (USD 5/mes, 30 s de CPU por solicitud) o menos iteraciones/otro algoritmo | NO medido |
| 3 | **Eliminar los `IN (?,…)` sin tope** (trocear en lotes ≤ 90 o reescribir con subconsultas) y probar contra D1 **remoto** con volúmenes reales | NO hecho (E-01) |
| 4 | **Backups y recuperación:** D1 ofrece Time Travel (7 días gratis, 30 pagos, 10 restauraciones/10 min) pero no hay runbook, ni exportación por taller, ni prueba de restauración | NO hecho |
| 5 | **Recuperación de contraseña** (email transaccional) o procedimiento operativo asistido documentado | NO hecho |
| 6 | **Alta/baja de talleres y gestión de licencias** con interfaz mínima, vencimientos y registro de pagos; token de plataforma con rotación, y mejor aún protegido por Cloudflare Access/IP | Parcial (CLI) |
| 7 | **Cabeceras de seguridad** (CSP, frame-ancestors, HSTS, Referrer-Policy) vía `public/_headers` | NO hecho (E-03) |
| 8 | **Actualizar dependencias** (hono, react-router-dom, vite, vitest, wrangler) y agregar CI con tests + `npm audit` | NO hecho (E-04) |
| 9 | **Corregir E-14 (stock decimal) y los huecos de negocio** de §D (fecha libre, contado sin cobro, CC a consumidor final) | NO hecho |
| 10 | **Términos de servicio, política de privacidad y datos personales (Ley 25.326)**; acuerdo de nivel de servicio mínimo | NO hecho |
| 11 | **Monitoreo de errores y alertas** (Workers Logs / Logpush / Sentry), y trazabilidad de solicitudes | NO hecho |
| 12 | **Prueba E2E de interfaz** de los flujos principales y prueba de carga con varios talleres simulados | NO hecho |

### Deseables
Importación/exportación CSV/Excel; caja diaria; recibo de cobro; fotos y firma (R2); notificaciones automáticas; panel web de plataforma; vista mensual de agenda; permisos más finos (ocultar costos); idle timeout de sesión; MFA para propietarios.

### Costos y límites de infraestructura (no asumir costo cero)
Valores consultados hoy en la documentación de Cloudflare:

| Concepto | Plan gratuito | Plan Workers Paid |
|---|---|---|
| Solicitudes Workers | 100.000/día | sin límite (precio por uso) |
| CPU por solicitud | **10 ms** | 30 s por defecto (hasta 300 s) |
| D1 filas leídas | 5 millones/día | 25.000 M/mes incluidos, luego USD 0,001 por millón |
| D1 filas escritas | 100.000/día | 50 M/mes incluidos, luego USD 1 por millón |
| D1 almacenamiento | 5 GB total, **500 MB por base** | 5 GB incluidos, luego USD 0,75/GB-mes; **10 GB por base** |
| Consultas por invocación | **50** | 1.000 |
| Parámetros por consulta | 100 | 100 |
| Time Travel | 7 días | 30 días |

Conclusiones [I, a validar con el primer taller real]:
- **El plan gratuito no es viable como producción:** 10 ms de CPU choca con el login (E-02), 50 consultas por invocación limita al alta de taller (el batch de alta ejecuta ~170 sentencias, `provision.ts`) y el tope de 5 M lecturas/día puede agotarse con pocos talleres activos (F-02).
- **Con Workers Paid (USD 5/mes) el costo variable es muy bajo** para decenas de talleres, porque los volúmenes de un taller son chicos; el costo real pasa a ser el soporte, el email transaccional y el tiempo de operación. Aun así hay que sumar dominio, backups externos y posibles servicios de email/monitoreo.
- Con un precio de licencia de ARS 400.000, la infraestructura no es el factor limitante; **lo son el soporte y la administración manual de licencias**.

### Evaluación por tema
| Tema | Estado |
|---|---|
| Autenticación en producción | Base sólida; faltan E-02, E-05–E-08, recuperación de contraseña |
| Seguridad de los datos | Aislamiento sólido; faltan cabeceras, dependencias, backups, cifrado/retención documentados |
| Gestión de errores | Backend correcto; sin monitoreo ni ErrorBoundary |
| Actualizaciones | Frontend con `autoUpdate` del service worker (cambios incompatibles API↔SPA no contemplados: sin versionado de API); migraciones sin proceso |
| Administración de licencias / alta de talleres | CLI/API manual |
| Escalado | Hasta decenas de talleres sin cambios estructurales; cientos requieren sharding y mejoras de §F |

---

## I. Preparación para facturación electrónica ARCA (sin implementarla)

Fortalezas: `ventas` ya se separó de lo fiscal (`tipo = 'interno'`); existe `comprobantes_fiscales` (tipo, punto de venta, número, CAE, vencimiento, estado, respuesta) con `UNIQUE (taller_id, tipo_cbte, punto_venta, numero)`; los cobros se aplican a ventas, por lo que una factura puede sumarse sin tocar ventas ni cobros; los impresos dicen "DOCUMENTO NO VÁLIDO COMO FACTURA".

**Decisiones a resolver antes de empezar** (hoy el modelo **no** está listo para producir comprobantes válidos):

1. **IVA por alícuota.** Los totales usan **un solo `iva_pct` por documento** (`shared/totals.ts`); `venta_items.alicuota_iva` se guarda pero **no se usa** para calcular. ARCA exige discriminar base imponible e IVA por alícuota (y exento/no gravado). Hay que decidir cálculo por ítem y desglose por alícuota.
2. **¿Precios netos o finales?** Hoy el IVA se **suma** al neto. Para facturas B/C a consumidor final los precios se muestran con IVA incluido. Hay que fijar la convención por tipo de comprobante y condición del emisor (monotributo no discrimina IVA).
3. **Descuentos y recargo** (recargo "financiero" sobre neto): cómo se declaran fiscalmente.
4. **Datos fiscales del cliente:** CUIT/DNI sin validación (dígito verificador), sin unicidad, sin condición frente al IVA obligatoria por tipo, sin consulta al padrón.
5. **Datos fiscales del taller:** `cuit` libre, `condicion_iva` sin ingresos brutos, sin domicilio fiscal estructurado, sin inicio de actividades, **sin punto(s) de venta**.
6. **Numeración fiscal:** número asignado por ARCA (FECompUltimoAutorizado) con control de concurrencia por punto de venta y tipo; hoy `secuencias` sirve para numeración interna únicamente.
7. **Relación venta ↔ comprobante:** ¿una venta puede tener varios comprobantes (factura + NC)? Notas de crédito/débito, anulaciones y su efecto sobre stock, cobros y cuenta corriente (hoy una venta anulada no genera comprobante contrario).
8. **Orden de trabajo ↔ factura:** ¿se factura la OT completa o por tramos? Regla de inmutabilidad de la venta una vez autorizada (parcialmente prevista en `anular`).
9. **WSAA/WSFEv1 en Workers:** firma CMS/PKCS#7 con certificado X.509 del contribuyente (no hay librería estándar en Workers; hay que resolver con WebCrypto + ASN.1 propio o servicio auxiliar), caché del ticket de acceso (token/sign, ~12 h) por taller y entorno, tiempos de espera de los servicios de ARCA (SOAP) y reintentos idempotentes.
10. **Certificados y claves privadas por taller:** dónde y cómo se guardan (secretos cifrados con clave maestra en Workers Secrets/KV cifrado; **nunca** en D1 en claro), proceso de alta (CSR, subida del certificado, vencimiento y alertas), separación homologación/producción, y responsabilidad legal sobre la custodia.
11. **Moneda extranjera, percepciones (IIBB), CAEA/contingencia, factura de exportación:** definir qué queda fuera de v1 del módulo.
12. **Auditoría fiscal:** conservación de respuestas de ARCA y de comprobantes (el campo `respuesta` existe pero sin política de retención).

---

## J. Deuda técnica (consolidada y clasificada)

**CRÍTICO** — ninguno confirmado como explotable hoy, pero los siguientes bloquean la venta:
- *Bloqueante operativo:* ausencia de despliegue verificado y de backups (§H.1, H.4). Se clasifica ALTO por el riesgo técnico, y CRÍTICO como condición de venta.

**ALTO**
- E-01 `IN (?)` sin tope contra el límite de 100 parámetros de D1 remoto.
- E-02 Hash de contraseñas vs. CPU de Workers (y posible tope de iteraciones).
- F-01 Sin estrategia de migraciones/rollback con datos reales.
- Sin backups/exportación/recuperación de contraseña/panel de plataforma.
- Cobertura de pruebas: 0 pruebas de UI; ~44 % de los endpoints sin prueba.

**MEDIO**
- E-03 sin cabeceras de seguridad; E-04 dependencias vulnerables; E-05 bloqueo de cuenta explotable; E-06 enumeración de usuarios; E-07 CSRF débil; E-08 API de plataforma pública con token estático; E-09 fechas libres; E-14 stock `REAL`.
- F-02 lecturas sin índices adecuados; F-03 base única sin sharding; F-04 sin purga.
- Configuración inerte (IVA/recargo por defecto); vehículos sin reactivación; presupuesto pierde `valido_hasta` al editar; venta contado sin cobro; deuda a "Consumidor final".
- Modelo fiscal no preparado (§I): IVA único por documento.

**BAJO**
- E-10, E-11, E-12, E-13; F-05 a F-09; rutas sin guarda por permiso; accesibilidad de modales; `JSON.parse` sin protección en `api.ts`; sin `ErrorBoundary`; `setMonth` desborda fin de mes en próximos services; agrupación de reportes por fecha UTC (una OT ingresada a las 22:00 ART cae al día siguiente); patrones `LIKE` > 50 bytes fallarían en D1 remoto; `dev.log` y `npm-install.log` en la raíz del proyecto (no versionados); sin LICENSE, sin CI, sin `CONTRIBUTING`.

---

## K. Próximas etapas recomendadas (por prioridad)

**Etapa 0 — Desbloqueo de producción (1–2 semanas de trabajo, ~40–55 h)**
1. Cuenta de Cloudflare con staging + producción; despliegue real; medir CPU de login; decidir plan (Workers Paid recomendado).
2. Corregir E-01 (lotes de ≤ 90 parámetros) y agregar una prueba que cree >100 registros; ejecutar la suite contra D1 remoto de staging.
3. Backups: runbook de Time Travel + exportación por taller (JSON/CSV) + prueba de restauración.
4. Cabeceras de seguridad (`_headers`), actualización de dependencias, CI (typecheck + tests + audit).

**Etapa 1 — Integridad y seguridad (≈ 25–35 h)**
5. Reglas de negocio: fecha de ventas/cobros limitada (hoy ± N días, salvo permiso), `contado` exige cobro o se renombra, CC no permitida a "Consumidor final", reactivar vehículos, conservar `valido_hasta`.
6. Stock: representación entera/decimal exacta.
7. Autenticación: respuestas homogéneas (cálculo de hash ficticio para emails inexistentes), bloqueo por usuario+IP con retroceso, validación CSRF por tipo exacto + `Origin`, token de plataforma rotado/protegido.
8. Tests de aislamiento para los módulos que faltan (compras, proveedores, pagos, turnos, mecánicos, catálogo) y para roles `administrador`.

**Etapa 2 — Operación comercial (≈ 35–50 h)**
9. Panel web de plataforma (alta de talleres, licencias con vencimiento, estado), recuperación de contraseña por email, términos/privacidad.
10. Importación/exportación CSV (clientes, artículos), recibo de cobro imprimible, paginación, monitoreo.
11. Aplicar efectivamente IVA/recargo por defecto; guardas de ruta por permiso; accesibilidad de modales; pruebas E2E (Playwright) de los 5 flujos principales.

**Etapa 3 — Piloto con 1–2 talleres reales y ajustes (≈ 20–30 h de ajustes)**

**Etapa 4 — Facturación ARCA** (después de resolver las decisiones de §I; ver estimación en `07_VIABILIDAD.md`: ~50 h solo el servicio, más homologación y gestión de certificados).

---

## 12. Evaluación final

### Cómo se calcula cada porcentaje
- **Universo:** las 35 tareas del plan "Taller Esencial" (`docs/auditoria/08_PLAN_IMPLEMENTACION.md`: Fases 1 y 2 + QA) más 8 requisitos adicionales del modelo SaaS que el plan viejo no incluía (multiempresa, usuarios/roles, licencias, alta de talleres, panel de plataforma, despliegue verificado, recuperación de contraseña, backups por taller). Total **43**. La facturación ARCA queda **fuera del denominador** por decisión explícita.
- **% implementado = (tareas completas + 0,5 × parciales) / total.** Es una **estimación por criterio propio**, no una medida automática; no se cuentan pantallas.
- **% verificado = tareas cuyo comportamiento principal es ejercido por al menos una prueba automática que pasa / total.** Solo cubre la API; no existe ninguna prueba de interfaz. Coincide con la cobertura por endpoint (53 de 94 rutas, 56 %, contada con una búsqueda automática de rutas en `tests/api`; aproximada).

### 1. Porcentaje implementado
Plan Esencial: 27 completas + 4 parciales + 4 ausentes de 35 → **≈ 83 %**. Con los 8 requisitos SaaS (4 completos, 4 ausentes): 31 completas + 4 parciales + 8 ausentes de 43 → **≈ 77 %** (estimativo).
Ausentes del plan: backup, importación CSV, recibo imprimible, exportación CSV. Parciales: configuración (sin logo, IVA/recargo inertes), check-list impreso, agenda (sin mes), pruebas de QA.

### 2. Porcentaje verificado mediante pruebas
**≈ 56 %** (24 de 43 tareas; 53 de 94 endpoints). 45 pruebas pasan: 8 unitarias [E] + 37 de integración [E] con un Worker real y D1 local temporal; typecheck sin errores [E]; build correcto [E]. No hay pruebas de interfaz, de carga, de migraciones ni contra D1 remoto.

### 3. Los 10 problemas más importantes
1. **Nunca desplegado ni medido en Cloudflare** (CPU del login, plan, secretos, staging). [`wrangler.jsonc:17`, `crypto.ts`]
2. **Consultas `IN (?,…)` sin tope** que fallarán en D1 remoto con >99 registros (cobros, historial de vehículo, documentos). [E-01]
3. **Sin backups, exportación ni runbook de recuperación.** [H.4]
4. **Administración comercial inexistente:** sin panel de plataforma, vencimientos de licencia, recuperación de contraseña; API de plataforma pública con token estático. [E-08]
5. **Integridad comercial:** fechas libres (también para empleados), contado sin cobro, deuda a consumidor final. [P4–P6]
6. **Stock con coma flotante** bloquea salidas legítimas (reproducido). [E-14]
7. **Autenticación:** bloqueo de cuenta por terceros, enumeración por tiempo/mensajes/otro taller, CSRF débil. [E-05–E-07]
8. **Sin cabeceras de seguridad y dependencias con avisos** (incluidas `hono` y `react-router-dom` en producción). [E-03, E-04]
9. **Pruebas insuficientes:** 0 de UI, 44 % de endpoints sin cubrir, sin pruebas contra D1 remoto; módulos de compras/pagos/catálogo/aislamiento parcial. [§C, §12.2]
10. **Modelo no preparado para ARCA** (IVA único por documento, precios sin convención neto/final, datos fiscales sin validar) y base única sin proceso de migraciones/sharding. [§I, F-01, F-03]

### 4. Qué corregir antes de seguir agregando módulos
Los puntos 1, 2, 3, 5, 6 y 7 de arriba (Etapas 0 y 1). Agregar módulos nuevos (caja, ARCA, fotos) sobre una base sin despliegue ni backups multiplica el riesgo y el costo de corregir después.

### 5. Qué falta para que Fierro sea útil a un taller real
Backup/recuperación confiable; importación de clientes/artículos (migración desde el sistema anterior); recibo de cobro; caja diaria simple (opcional pero muy pedida); exportación a Excel; configuración de IVA/recargo que realmente se aplique; baja/reactivación de vehículos; vista mensual de agenda y control de solapamientos. Las funciones de la operación diaria (OT, presupuestos, historial por patente, stock, cobros) **ya existen y funcionan**.

### 6. Qué falta para venderlo comercialmente
Todo lo de §H "Indispensable": despliegue y staging, CPU/plan, correcciones E-01/E-02/E-14, backups, cabeceras y dependencias, panel de plataforma y recuperación de contraseña, términos/privacidad, monitoreo, pruebas E2E y de carga, piloto con un taller real. Además un modelo de soporte y de cobranza de licencias (hoy manual).

### 7. Esfuerzo estimado hasta una versión 1.0 vendible
**≈ 120–180 h** de trabajo (≈ 40–55 h Etapa 0 + 25–35 h Etapa 1 + 35–50 h Etapa 2 + 20–30 h de ajustes del piloto), **sin facturación ARCA**. Es una estimación por analogía con las horas del documento de viabilidad (`07_VIABILIDAD.md`), no un cálculo medido; el mayor factor de incertidumbre es lo que aparezca al desplegar por primera vez en Cloudflare. ARCA agrega ≈ 50–80 h más (más trámites de certificado y homologación).

### 8. ¿La arquitectura es adecuada para el modelo de licencias y múltiples talleres?
**Sí, en lo fundamental.** Un Worker + D1 compartida con aislamiento por `taller_id` reforzado con FK compuestas, cupo de usuarios transaccional y licencia como estado es una buena base para decenas de talleres a muy bajo costo. Condicionado a: usar **Workers Paid**, resolver los límites de D1 remoto (E-01), definir proceso de migraciones/backups y prever sharding antes de llegar a cientos de talleres.

### 9. Decisiones técnicas a cambiar ahora
1. **Representación de cantidades de stock** (entero en milésimas o decimal exacto) — barato hoy, caro con datos.
2. **Email global único** para usuarios: decidir ahora si un usuario puede pertenecer a más de un taller (afecta login, sesiones y E-06).
3. **IVA por alícuota por ítem** (y convención neto/final) antes de ARCA; hoy es un campo por documento.
4. **Fechas de negocio generadas por el servidor** (con excepción controlada por permiso) y **cierre de períodos**.
5. **Algoritmo de hash**: validar límites reales de Workers antes de que existan hashes en producción (el formato versionado lo permite, pero migrar hashes cuesta).
6. **Sesión/cookie:** prefijo `__Host-` y validación CSRF por `Origin`, antes de pensar en subdominios por taller.
7. **Estrategia de migraciones** (numeración, pruebas con datos, rollback) y **dónde vive la API de plataforma** (otro Worker/ruta protegida por Cloudflare Access).

### 10. Próxima etapa de desarrollo
**Etapa 0 del §K: desbloqueo de producción** (desplegar a staging en Cloudflare, medir, corregir E-01, backups, cabeceras/dependencias/CI). Es lo que convierte el prototipo en un producto verificable y reduce la incertidumbre de todo el cronograma. Después, Etapa 1 (integridad y seguridad) y recién entonces nuevas funciones (importación, caja, ARCA).

---

## Anexo — Evidencia y reproducción

**Ejecutado** (resultados reales de esta auditoría):
- `npm run typecheck` → sin errores. `npx vitest run` → 8/8. `npx vitest run --config vitest.api.config.ts` → **37/37**, 7 s, sobre D1 temporal en el directorio temporal del sistema (no toca la base de desarrollo).
- `vite build` (a un directorio temporal): OK, JS 415 kB / 115 kB gzip; PWA con 9 entradas precacheadas.
- Instancia aislada (puerto 8801, D1 en directorio temporal, datos del seed): sondas P1–P22 (`scratchpad/probe.mjs`, fuera del repositorio). Resultados citados en las secciones C, D y E.
- `npm audit` (completo y `--omit=dev`): 11 avisos / 4 en dependencias de producción.
- Prueba de PBKDF2 en `workerd` local: 100.000 it. = 35 ms; 600.000 it. = 238 ms (el límite de Workers remoto **no** se reproduce localmente).
- Navegador (instancia aislada): login, dashboard, tablero de OT, agenda, nuevo presupuesto, configuración, impresión de OT, y vista móvil de OT/artículos/ventas.

**No se pudo verificar:** comportamiento real en Cloudflare (CPU, límites de D1, 100 parámetros), el diálogo de impresión del navegador, accesibilidad con lector de pantalla, rendimiento con volúmenes grandes, la carrera E-12 (12 intentos sin reproducirla).

**No se hizo:** ninguna modificación de código, migración o configuración; ninguna operación sobre la base de desarrollo del usuario. Los datos de prueba (talleres "Taller Demo/Norte" y registros de sondas) existieron solo en la base aislada, que se eliminó al terminar.
