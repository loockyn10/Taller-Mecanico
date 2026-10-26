# Seguimiento público de órdenes de trabajo (Sprint 20)

Cada orden puede tener una **página pública de seguimiento**: el cliente recibe un enlace individual (por WhatsApp, copiado o con un QR impreso) y ve en qué estado está su vehículo **sin registrarse ni iniciar sesión**. La página muestra el estado que tiene la OT en Fierro cada vez que se abre o se recarga: no hay nada que actualizar dos veces.

## 1. Cómo se usa

1. El seguimiento queda **activo solo al crear la orden** (Mejora 20B); en el detalle de la OT, tarjeta **«Seguimiento del cliente»**, se puede desactivar, regenerar o (en órdenes anteriores o desactivadas) activar.
2. **Enviar WhatsApp al cliente** (botón único del encabezado de la orden: abre WhatsApp con el mensaje preparado y el enlace; no envía nada solo), **Copiar enlace** o **Mostrar código QR** (descargarlo o compartirlo como imagen).
3. En **Imprimir orden** hay una cuarta copia, **«Seguimiento del cliente»**: una hoja A4 con el QR y la dirección escrita, lista para entregar. Las copias del mecánico y de administración **no se modificaron**.
4. Cuando alguien cambia el estado de la OT (con los permisos de siempre) la página lo refleja al abrirla o recargarla.
5. **Mensaje para el cliente**: texto aparte de las notas internas (también se puede escribir al cambiar el estado, en un campo separado de la nota interna).
6. **Desactivar enlace** o **Regenerar enlace**: el enlace anterior deja de funcionar al instante.

## 2. Estados: se reutiliza el estado operativo de la OT

No se creó ningún sistema paralelo. `ordenes.estado` sigue siendo la única fuente y `orden_eventos` (con la hora del servidor) el único registro de cambios. `shared/seguimiento.ts` sólo **traduce**:

| Estado interno | Lo que ve el cliente |
|---|---|
| `recibida` | Vehículo recibido |
| `diagnostico` | En diagnóstico |
| `esperando_repuestos` | Esperando repuestos |
| `en_reparacion` | En reparación |
| `lista` | Listo para retirar (mensaje destacado) |
| `entregada` | Entregado |
| `cancelada` | Orden cancelada |

**«Esperando aprobación» y «En control final» no existen como estados de la OT** (hoy la aprobación vive en el presupuesto y no hay un paso de control final). No se inventaron: mostrarlos exigiría estados nuevos en la gestión de órdenes, que quedó fuera de este sprint. Si el taller los incorpora más adelante, alcanza con agregarlos a `ESTADO_PUBLICO` y `PASOS`.

**Recorrido** (la línea de tiempo): pasos *Recibido → Diagnóstico → [Espera de repuestos] → Reparación → Listo para retirar → Entregado*. Reglas, probadas en `tests/unit/seguimiento.test.ts`:

- El paso actual se destaca; los anteriores aparecen como hechos **sólo si de verdad ocurrieron** (un paso salteado no se marca como completado); los posteriores son siempre *pendientes*, nunca completados.
- No es lineal: si la reparación vuelve a diagnóstico, «Reparación» pasa de nuevo a pendiente y el historial dice «Volvió a diagnóstico». «Espera de repuestos» sólo se muestra si ocurre o ya ocurrió (puede repetirse).
- **Historial completo** (desplegable): cada transición con fecha y hora del servidor (en la zona horaria del taller).
- El taller puede **ocultar transiciones internas** del historial; la transición del **estado actual no se puede ocultar** (el cliente siempre ve dónde está y desde cuándo).
- Una orden cancelada no tiene recorrido: se muestra el estado y el historial.

## 3. Qué muestra la página (y qué no)

Muestra: nombre del taller, referencia de la orden (N° con ceros), marca y modelo, **patente parcialmente oculta** (`AB•••CD`, `ABC123` → `AB•••3`), estado actual con explicación breve, recorrido, historial, última actualización (último cambio de estado visible o mensaje publicado), fecha estimada de entrega (si existe y corresponde) y el mensaje público vigente.

**Nunca** muestra ni devuelve: nombre del cliente, teléfono, dirección, datos fiscales, precios, costos, márgenes, notas internas, la nota del cambio de estado, diagnósticos, fotografías, firmas, kilometraje, mecánico ni identificadores internos (ids de orden, taller, cliente, vehículo o evento). La consulta pública es **propia y acotada** (`consultarSeguimiento` en `worker/lib/seguimiento.ts`): lee sólo las columnas que se muestran y arma un objeto con campos fijos; no reutiliza el detalle de la OT. Dos pruebas automáticas lo verifican: buscan datos privados sembrados a propósito en la página y en el JSON, y comparan las claves del JSON contra la lista prevista.

**Fecha estimada.** Se reutiliza `ordenes.fecha_prometida` (no se modificó ningún cálculo ni planificación). Sólo se muestra mientras la orden está en curso, si el taller no la ocultó, y siempre como *estimación* («puede cambiar»). Una fecha **vencida** no se presenta como compromiso vigente: aparece «Estaba prevista para el dd/mm/aaaa… consultá con el taller».

**Mensajes públicos** (`seguimiento_mensajes`). Campo aparte de las notas internas: el texto sale únicamente de lo que se escribe en el campo «Mensaje para el cliente»; no se copia de notas ni de la nota del cambio de estado. Texto plano (se escapa al mostrarlo, nunca se interpreta como HTML), máximo 500 caracteres. Un mensaje nuevo reemplaza al anterior en la página; todos quedan en el historial con quién los publicó y cuándo. Retirar el vigente no revive uno anterior. El texto no se puede reescribir (disparador SQL).

## 4. Seguridad

| Requisito | Cómo se cumple |
|---|---|
| Token aleatorio de alta entropía | 32 bytes de `crypto.getRandomValues` en base64url (43 caracteres, 256 bits). No se deriva del número ni de ningún id de la orden. |
| Validez verificada de forma segura | Se verifica el formato antes de consultar la base; la búsqueda es por igualdad exacta sobre un índice único con `activo = 1`. |
| No consultar órdenes ajenas cambiando parámetros | La consulta pública sólo recibe el token: cualquier otro parámetro se ignora. Con el token alterado, truncado o ampliado: 404. |
| Revocar / regenerar | Desactivar pone `activo = 0` (cada consulta lo exige: efecto inmediato). Regenerar **reemplaza** el token (el anterior deja de existir en la base). |
| Enlace inválido, desactivado o reemplazado | Misma respuesta 404 y misma página para los tres casos: no se puede saber cuál es. |
| Rate limiting | Por origen (`cf-connecting-ip`), con el mecanismo de `limites_intentos` ya existente: 20 intentos fallidos en 10 minutos → bloqueo de 15 (429). Los accesos válidos no escriben nada en la base. |
| Sin indexación | `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet`, `<meta name="robots">` y `public/robots.txt` con `Disallow: /seguimiento/`. |
| Sin caché | `Cache-Control: private, no-store, max-age=0` + `Pragma: no-cache` (página, JSON y errores); sin cookies. |
| Token fuera de cabeceras de referencia | `Referrer-Policy: no-referrer`; la página no carga ningún recurso externo (ni tipografías, ni imágenes, ni scripts) y no tiene JavaScript. |
| CSP | `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` + `X-Frame-Options: DENY`. |
| Token fuera de los registros | La aplicación no lo imprime ni lo guarda en auditoría, errores ni límites (probado). Los errores se guardan con la ruta normalizada (`/seguimiento/:id`). |
| Aislamiento por `taller_id` | Todas las operaciones de gestión toman el taller de la sesión; con dos talleres se prueba que cada uno recibe 404 en todo lo del otro. |

**Límite honesto:** el token viaja en la dirección (`/seguimiento/<token>`), como en cualquier enlace de seguimiento de envíos, por lo que los registros de acceso de la infraestructura de Cloudflare pueden contener la dirección. Por eso la página sólo expone un estado de bajo riesgo (sin datos personales ni importes) y el enlace se puede revocar o regenerar en cualquier momento. El token se guarda tal cual en D1 (hace falta poder volver a copiar el enlace y mostrar el QR); sólo se lee desde el servidor y los respaldos de la base van cifrados.

El enlace **no vence solo**: sigue mostrando «Entregado» hasta que alguien lo desactive. Es una decisión a revisar con los talleres.

## 5. Permisos (`shared/permisos.ts`, grupo «Seguimiento del cliente»)

| Permiso | Permite |
|---|---|
| `seguimiento.ver` | Consultar la configuración del seguimiento de una orden (si está activo, mensajes, transiciones). **No incluye el enlace.** |
| `seguimiento.gestionar` | Activar, desactivar y regenerar el enlace; ocultar la fecha estimada y transiciones internas. |
| `seguimiento.compartir` | Recibir el enlace: copiarlo, QR, WhatsApp, selector nativo e impresión del QR. |
| `seguimiento.mensajes` | Publicar y retirar mensajes para el cliente. |

Gestionar, compartir y mensajes exigen *ver*. Además hay que poder ver la orden (`ordenes.ver`, o `ordenes.asignadas` sobre las propias). Por defecto: propietario y administrador todos; **recepción y el rol heredado «empleado» los cuatro**; mecánico, depósito y caja ninguno (el propietario puede otorgarlos en Personal → Permisos). El **estado de la OT se cambia con los permisos de siempre**; este módulo no lo toca. Para WhatsApp se usa el teléfono del cliente sólo si la persona puede ver clientes (`clientes.ver`); si no, WhatsApp pide elegir el contacto.

La copia del cliente del PDF (`GET /api/ordenes/:id/pdf?copia=cliente`) exige `ordenes.imprimir` + `seguimiento.compartir` y que el enlace esté **activo** (409 si no); queda registrada en la auditoría como las demás copias.

## 6. Datos (migración 0017, aditiva)

`seguimiento_enlaces` (un enlace por OT; `token` único de 43 caracteres, `activo`, `mostrar_fecha_estimada`, `generacion`, fechas), `seguimiento_mensajes` (historial con responsable; disparador que impide reescribir lo publicado), `seguimiento_eventos_ocultos`. No modifica `ordenes` ni `orden_eventos` ni ningún dato existente.

## 7. Endpoints

Públicos (sin sesión): `GET /seguimiento/:token` (página HTML) y `GET /api/seguimiento/:token` (JSON). El Worker atiende `/seguimiento/*` antes que los assets (`run_worker_first` en `wrangler.jsonc`).

Con sesión, bajo `/api/ordenes/:id/seguimiento`: `GET` · `POST /activar` · `POST /desactivar` · `POST /regenerar` · `PATCH` (`mostrar_fecha_estimada`) · `PUT /transiciones/:eventoId` (`visible`) · `POST /mensajes` · `DELETE /mensajes/:mid`. Todas devuelven el estado completo y ninguna incluye precios, costos, notas ni datos del cliente.

## 8. Código QR

Se genera **en el navegador** (y en el servidor para el PDF) con `qrcode-generator` (MIT, sin dependencias, sin servicios externos ni costos). Contiene **únicamente la dirección del enlace**; corrección de errores M; zona de silencio de 4 módulos. En pantalla: SVG; descarga/compartir como PNG; en el PDF: rectángulos vectoriales.

## 9. Costos y rendimiento

Sin servicios pagos: sólo Worker, D1 y el código. Una consulta pública = 1 lectura de D1 con joins por clave + 3 lecturas pequeñas en paralelo + 1 del límite de intentos; no escribe nada. Sin WebSockets ni tiempo real: la página se actualiza al abrirla o recargarla (botón «Actualizar»).

## 10. Límites y pendientes

- Estados «Esperando aprobación» y «Control final» no existen en la OT (ver §2).
- Sin vencimiento automático del enlace.
- Sin notificaciones automáticas al cliente (WhatsApp Business API no se contrató, a propósito).
- Verificado en emulación de ancho y en el servidor local; falta probar en celulares reales y en el lector de QR de un celular físico.
