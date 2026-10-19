# Progreso del desarrollo · Fierro v0.1.0

Última actualización: 2026-10-19. Documento para retomar el trabajo en nuevas sesiones.

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
- Listas de precios múltiples (hoy: precio por artículo y margen sugerido).
- Caja diaria (apertura y cierre), bancos, cheques y eCheq, gastos fijos, contabilidad: excluidos a propósito, ver la auditoría (07_VIABILIDAD).
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
5. Caja diaria simple (apertura, cierre, arqueo por medio de pago).
6. Integración ARCA (homologación primero), usando `comprobantes_fiscales`.
7. Panel web de plataforma para licencias.
