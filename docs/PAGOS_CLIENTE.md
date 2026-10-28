# Pago del cliente desde el portal de seguimiento (Sprint 25)

El portal público de seguimiento (`/seguimiento/<token>`, Sprint 20) ahora permite que el cliente: vea el **importe total** de su reparación y el **saldo pendiente**, elija **cómo pagar** (efectivo o transferencia), copie los **datos bancarios del taller**, **adjunte el comprobante** de su transferencia y consulte la **verificación** de ese pago. El personal administrativo gestiona todo desde la OT: ve lo que el cliente eligió y envió, y **confirma el cobro** (usando el circuito de cobros de siempre) o **rechaza el comprobante** con un motivo.

> **Regla de fondo:** elegir un medio de pago o subir un comprobante **nunca** es un cobro. El dinero se reconoce **una sola vez**, cuando un administrativo confirma que ingresó; entonces se crea (o se enlaza) el cobro real del módulo financiero.

No se creó otro portal, ni otro sistema de cobros, ni otro libro de dinero, ni otro almacenamiento, ni otro registro de cuentas bancarias.

## 1. Qué se reutilizó

| Necesidad | Componente existente |
|---|---|
| Portal, tokens, revocación y regeneración | `seguimiento_enlaces`, `enlaceActivo()`, `/seguimiento/*` (Sprint 20). Todas las acciones del cliente vuelven a resolver el token con `activo = 1`. |
| Importe de la OT | `ordenes.total` y, si ya hay, el comprobante interno vigente (`ventas`). Lo cobrado sale de `ventas.cobrado` y de los anticipos de la OT. |
| Cobro | `lib/cobros.ts › sentenciasCobro` (el mismo código de `POST /cobros`, anticipos y comprobante de OT): cobro, medio, **ingreso de caja**, **movimiento bancario** y cola contable (asiento derivado). |
| Cuentas bancarias | `cuentas_bancarias` (Finanzas › Bancos): titular, banco, alias y CBU ya cargados. Se agregó **un solo campo**: `publica_en_portal`. |
| Almacenamiento | El bucket R2 **privado** de las fotografías (binding `FIERRO_FOTOS`), con otro prefijo de claves (`comprobantes/…`). Sin servicios nuevos. |
| Validación de imágenes | `lib/fotos.ts › validarImagen` (JPEG/WebP, limpieza de EXIF/GPS). PNG y PDF se validan en `lib/comprobantes.ts`. |
| Límites de abuso | `limites_intentos` (`lib/limites.ts`), el mismo mecanismo del inicio de sesión y del seguimiento. |
| Permisos | Los existentes. **No se agregó ningún permiso.** |
| Auditoría, caja obligatoria, medios habilitados, fechas comerciales | `auditar`, `exigirCajaAbiertaSiCorresponde`, `exigirMediosHabilitados`, `fechaComercial`. |
| PDF de la OT | La copia de administración (`VARIANTES.administracion`) suma la sección «Pago del cliente»; la del mecánico no se modificó. |

## 2. Cómo se obtiene el importe de la OT

`lib/pago-cliente.ts › finanzasOrden` (una sola consulta; nada se copia ni se guarda):

- **Total** = comprobante interno vigente (`ventas.total − ventas.devuelto`) si existe; si no, `ordenes.total`. Nunca costos, márgenes ni el detalle de ítems.
- **Abonado** = `ventas.cobrado` (incluye cobros normales y saldo a favor aplicado) + anticipos de la OT (o de su presupuesto) todavía disponibles (`total − credito_aplicado − devuelto`). **Sólo cobros confirmados en el sistema**: un comprobante pendiente de verificación no suma.
- **Pendiente** = `max(0, total − abonado)`. Como se calcula siempre en el momento, un cambio en el importe de la OT, una anulación de cobro o un cobro nuevo se reflejan solos.
- **Importe confirmado para comunicarlo** = hay comprobante interno emitido **o** el taller lo **informó** (botón «Informar $X al cliente» en la tarjeta «Pago del cliente»; permiso `seguimiento.gestionar` + `ventas.ver`; queda auditado). Mientras no se cumpla, la página dice **«Importe pendiente de confirmación por el taller»**, no muestra `$0` y no se puede elegir medio ni enviar comprobantes (el servidor lo rechaza, no sólo la pantalla). Una OT con total 0 no se puede informar.
- La página muestra el **importe global** («Importe total de la reparación», «Abonado», «Saldo pendiente»), sin repuestos, mano de obra, cantidades, precios ni costos, y sin detallar cada cobro.

Por qué hay un paso explícito de «informar»: el total de una OT cambia mientras se diagnostica; comunicárselo al cliente apenas se crea la orden (con un presupuesto a medio armar) sería publicar un importe no confirmado.

## 3. La elección del medio de pago

Tabla `pago_elecciones` (**historial inmutable**, un disparador impide modificar o borrar filas). Cada fila: medio (`efectivo` | `transferencia`), estado (`seleccionado` | `confirmado`), **importe total y saldo pendiente al momento**, fecha. La vigente es la última; cambiar de idea agrega una fila. Repetir la misma acción (recargar, doble clic) no agrega nada, y elegir «efectivo» estando ya confirmado no lo degrada.

- **Efectivo:** «Podés pagar en efectivo al retirar tu vehículo» + saldo + botón **«Confirmar pago en efectivo»**, que registra la **intención** (`confirmado`). En la OT del taller figura «Pago previsto en efectivo · Pendiente de cobro». No hay ingreso de caja ni la OT pasa a pagada: cuando el cliente entregue el dinero, el personal usa el cobro de siempre (la tarjeta tiene un acceso directo).
- **Transferencia:** sólo se ofrece si el taller publicó una cuenta receptora (ver §6). Muestra el importe pendiente, los datos del taller y el formulario del comprobante.

## 4. Cómo funciona la carga de comprobantes

Formulario común (`multipart/form-data`) que funciona **sin JavaScript**; un script en línea (con *nonce*) agrega copiar alias/CBU con confirmación visual («¡Copiado!»), vista previa y nombre/tamaño del archivo (en celulares abre el selector de capturas, fotos y archivos), validación de peso antes de enviar y bloqueo del doble envío.

Servidor (`POST /seguimiento/:token/comprobante`, `lib/pago-cliente.ts › recibirComprobante`):

1. Origen propio (decide `Sec-Fetch-Site`; sin esa cabecera se compara `Origin`; ojo: con `Referrer-Policy: no-referrer` el navegador manda `Origin: null` en los envíos al mismo sitio y se acepta sólo si `Sec-Fetch-Site` lo confirma), `Content-Length` obligatorio (se descarta lo gigante **antes** de leer el cuerpo), límites por origen (12 envíos/hora, cada intento cuenta) y por orden (30/hora).
2. Orden en estado válido: importe confirmado, saldo > 0, no cancelada, cuenta receptora publicada.
3. **Contenido real** (`lib/comprobantes.ts`): JPEG, PNG, WEBP y PDF por los *bytes*; si el nombre trae extensión, debe ser una permitida (jpg, jpeg, png, webp, pdf). Imágenes **reescritas sin metadatos** (EXIF/GPS, textos PNG); PNG con CRC verificado; PDF con `%PDF-`, `%%EOF` y **sin** `/JavaScript`, `/Launch`, `/EmbeddedFile`, `/RichMedia`, `/SubmitForm`, `/ImportData`.
4. **Tamaños:** 8 MB por imagen, 5 MB por PDF, lado máximo 12.000 px; por orden: 3 pendientes a la vez, 12 en toda su vida, 40 MB acumulados. Los topes por orden se comprueban **dentro de la transacción** (envíos simultáneos no los saltean).
5. **Duplicados:** la clave de reintento del formulario (`k`, nueva en cada carga de la página) y el SHA-256 del archivo (no se vuelve a guardar el mismo archivo si el anterior no fue rechazado): un doble clic o un reintento no duplica nada.
6. Reserva en D1 (`pago_comprobantes`, estado `subiendo`) → `put` en R2 → estado `pendiente` y registro de la elección «transferencia». Los envíos jamás sobrescriben nada: cada uno tiene su `id` (UUID) y su objeto.
7. Respuesta **303** con un código fijo (`?m=comprobante_ok`…), nunca texto del visitante. Mensaje: «Comprobante recibido — pendiente de verificación. El taller tiene que confirmar que recibió el dinero.» Nunca dice «pagado».

## 5. Cómo se protegen los archivos en R2

- Bucket **privado** (sin dominio público ni `r2.dev`). El único camino a un archivo es `GET /api/ordenes/:id/comprobantes/:cid/archivo` con **sesión** y permisos `ordenes.ver` + `ventas.ver`.
- La clave del objeto es `comprobantes/<taller_id>/<comprobante_id>`, armada con el taller **de la sesión** y un UUID interno: ni el nombre del archivo ni ningún dato del cliente participan. Una orden o un comprobante de otro taller o de otra orden da 404.
- Cabeceras de respuesta: `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, `Content-Disposition` con nombre armado por el servidor, CSP `default-src 'none'; sandbox` en imágenes y `frame-ancestors 'self'` en PDF. Cada visualización y descarga queda auditada.
- El token del cliente **no da acceso** a ningún archivo (ni al suyo): el cliente nunca descarga comprobantes. Un token revocado, regenerado o inexistente no puede elegir medio ni enviar comprobantes (404 idéntico al de la consulta).
- **Subidas cortadas / huérfanos:** si falla R2, se borra la reserva y no queda nada. Si se corta entre R2 y D1, el Cron (`limpiarComprobantes`, junto con `limpiarFotos`) borra primero el objeto y después la fila de los `subiendo` de más de una hora; si el borrado falla, la fila queda para reintentar (nunca un objeto sin fila que lo explique).
- Los comprobantes recibidos, confirmados y rechazados **no se borran ni se modifican** (disparadores): el historial es completo.

Límite: el bucket es el de fotografías (mismo binding y cuenta de Cloudflare) y **su respaldo programado (`npm run fotos`) no incluye todavía los comprobantes**; R2 es duradero, pero no hay copia externa de estos archivos. Pendiente documentado.

## 6. Datos bancarios por taller

Se reutiliza `cuentas_bancarias`. En **Finanzas › Bancos**, cada cuenta en pesos y activa tiene el botón **«Usar para transferencias de clientes»** (`PUT /api/bancos/cuentas/:id/portal`, permiso `bancos.gestionar`): exige titular y alias o CBU/CVU; **una sola por taller** (índice único parcial; publicar otra reemplaza a la anterior); desactivar la cuenta la despublica; todo auditado. El cliente ve **sólo** titular, banco, alias y CBU/CVU de **la cuenta de su taller** (nunca el CUIT, el saldo, el nombre interno ni cuentas de otros talleres) y sólo después de elegir transferencia. Sin cuenta publicada (o con «transferencia» deshabilitada en la configuración) la opción **no se ofrece** y el servidor la rechaza. El visitante no puede elegir cuenta ni importe: no existen esos parámetros.

## 7. Cómo se confirma un cobro sin duplicarlo

Tarjeta **«Pago del cliente»** en la OT (sólo con `ordenes.ver` + `ventas.ver`: el mecánico no la ve ni la pide): importe, abonado, saldo, medio elegido y su fecha, comprobantes con **Ver comprobante** (imagen o PDF), **Descargar**, **Confirmar cobro** y **Rechazar comprobante** (estas dos exigen `cobros.registrar`; la recepción puede ver y no resolver).

- **Confirmar** (`POST /api/ordenes/:id/comprobantes/:cid/confirmar`): importe recibido (por defecto el saldo; menos es un **pago parcial**; más que el saldo se rechaza), cuenta (por defecto la publicada), fecha comercial de siempre. Va por `sentenciasCobro`: **con comprobante interno emitido** el cobro se aplica a él; **sin comprobante** queda como **anticipo de la OT** (dinero recibido antes de la venta; se imputa al emitirlo), con su ingreso de caja, su movimiento bancario en la cuenta y su asiento. Registra quién y cuándo.
- **Una sola vez:** todo en **un batch** con una guarda sobre el estado `pendiente`; la clave del cobro es `pagoportal:<comprobante>` (única) y un índice único impide que un cobro respalde dos comprobantes. Doble clic, reintento o dos administrativos a la vez → un único cobro, un ingreso de caja, un movimiento de banco y un asiento (el segundo recibe el resultado del primero, `duplicado: true`). Probado con confirmaciones simultáneas.
- **Reconocer un cobro ya registrado:** si el taller ya cargó esa transferencia en el módulo financiero, la opción «Esa transferencia ya la registré» **enlaza** el comprobante al cobro existente (de la misma orden, por transferencia, no vinculado a otro comprobante): **no se crea ni se contabiliza nada otra vez**.
- **Si no se puede registrar** (caja obligatoria cerrada, cuenta inválida o inactiva, medio deshabilitado, saldo insuficiente) la API responde error, **el comprobante sigue pendiente** y no se marca nada como cobrado.
- **Rechazar:** motivo obligatorio (3–300 caracteres, lo ve el cliente); el comprobante rechazado queda en el historial y el cliente puede enviar otro. Confirmar y rechazar son definitivos (disparador): un comprobante resuelto no cambia de estado.
- **Cambios de importe:** si la OT cambia después de que el cliente eligió o envió, se conservan sus datos del momento, el saldo se recalcula, el cliente ve el importe nuevo y el administrativo ve una **advertencia con la diferencia**. Nada se confirma solo, y los asientos históricos no se tocan (el asiento corresponde al cobro, por el importe recibido).

Estados del pago (separados del estado de la reparación; una OT puede estar «Lista para retirar» y seguir pendiente de pago): **Pendiente de pago → Medio de pago seleccionado → Comprobante pendiente de verificación ⇄ Comprobante rechazado → Cobro confirmado** (`shared/pago-portal.ts › estadoPagoCliente`).

## 8. Aviso al personal y PDF

- **Aviso discreto:** «3 comprobantes pendientes de verificar» en Inicio y en Órdenes (sólo con `ordenes.ver` + `ventas.ver`); abre el listado `/ordenes?comprobantes=pendientes`. Sin WhatsApp automático, push ni servicios externos; se vuelve a leer cada minuto.
- **PDF de la OT:** la copia de **administración** muestra «PAGO DEL CLIENTE»: medio elegido, estado y saldo (sólo si hay elección o comprobantes y con `ventas.ver`). La del **mecánico** no lleva nada financiero (los datos se anulan por tipo de copia, igual que los datos del cliente del Sprint 23). El comprobante no se inserta en el PDF: queda disponible en la OT.

## 9. Datos (migración 0021, expansiva)

`cuentas_bancarias.publica_en_portal` (+ índice único parcial), `pago_importe_ot`, `pago_elecciones`, `pago_comprobantes` y sus disparadores. No modifica ni reconstruye ninguna tabla ni dato; el código del Sprint 24 sigue funcionando con este esquema (**migrar primero, publicar después, sin ventana de incompatibilidad**). Ensayo: `tests/api/migracion-0021.test.ts`.

## 10. El portal rediseñado

Cuatro bloques: **encabezado del taller** (logotipo del taller —se sirve con el mismo token en `/seguimiento/<token>/logo`— o un monograma, y su nombre; Orvelan no figura), **datos del vehículo y estado** (cliente responsable **de esa OT** —sólo el nombre, nunca teléfono, dirección, DNI/CUIT ni correo, ni otros clientes vinculados al vehículo—, marca/modelo, patente enmascarada como antes, N° de orden, estado, entrega estimada, mensaje del taller, recorrido e historial), **resumen de pago** y **pie discreto** («Gestionado con ORVELAN» + «Software de gestión para talleres.», isotipo de 20 px, sin enlaces). El pie ya no ocupa media pantalla: el SVG de marca traía `width=455` sin acotar.

Privacidad de la página: `Cache-Control: private, no-store`, `noindex`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, CSP `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' blob:; script-src 'nonce-…'; connect-src 'none'; form-action 'self'; frame-ancestors 'none'` (el nonce cambia en cada respuesta). El JSON público (`/api/seguimiento/:token`) trae `cliente`, `taller.logo` y `pago` con campos fijos (sin identificadores internos).

## 11. Pruebas

- `tests/unit/pago-portal.test.ts` (34): estados, importes, nombres, validación de JPG/PNG/WEBP/PDF (metadatos, CRC, contenido activo, tamaños, extensiones), cada variante de la sección de pago, encabezado y pie.
- `tests/unit/pago-cliente-db.test.ts` (6): fallo de R2 sin residuos, sin bucket, limpieza de huérfanos, borrado fallido, límites dentro de la transacción (base en memoria con todas las migraciones y un bucket falso).
- `tests/api/pago-cliente.test.ts` (39): contra un Worker real con R2 simulado; ver la lista de casos en el archivo (importe, elección, cuenta, comprobantes, tokens, rechazo, confirmación única, concurrencia, parciales, cambio de importe, comprobante interno, caja cerrada, vinculación, permisos, mecánico, PDF, aislamiento entre talleres).
- `tests/api/migracion-0021.test.ts`: la migración sobre datos tipo producción.
- Adaptadas: `tests/api/seguimiento.test.ts` y `tests/unit/seguimiento.test.ts` (ahora se muestra el nombre del cliente de la OT; el resto de las reglas de privacidad se mantienen).

## 12. Límites y pendientes

- Los comprobantes no están en el respaldo programado de fotos (§5).
- Un PDF con script dentro de un flujo de objetos comprimido, o con el nombre escrito con códigos `#xx`, no se detecta; por eso sólo se sirve con sesión, con `nosniff` y se abre en el visor del navegador.
- El cliente declara el comprobante pero **no** el importe transferido: el administrativo ingresa lo recibido. No hay verificación bancaria automática (a propósito).
- Con la OT de «Consumidor final» y sin comprobante no se puede confirmar como anticipo (exige cliente identificado): se emite el comprobante y se cobra desde ahí.
- Al confirmar sin comprobante interno el dinero queda como anticipo hasta que se emita el comprobante (comportamiento de siempre de los anticipos).
- Un cobro anulado en Cobros deja de contar en el saldo, pero el comprobante conserva su vínculo (se muestra «ANULADO»); el cliente puede volver a enviar uno.
- No se probó en teléfonos físicos (sí en emulación de ancho 375–1920 px) ni con transferencias bancarias reales.
