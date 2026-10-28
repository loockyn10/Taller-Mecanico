# Hoja de la orden de trabajo en PDF (Sprint 19)

Botón **Imprimir orden** en el detalle de la OT (y como aviso justo después de crearla): genera un PDF A4 vertical con los datos para trabajar y, en la mitad inferior, renglones para las anotaciones manuscritas del mecánico. Hay dos copias: **mecánico** y **administración** (o **ambas** en un único PDF de una hoja por copia).

## Uso
- La persona elige la copia, ve la vista previa, y **descarga**, **abre en otra pestaña** o **imprime**. No se imprime nada solo: el diálogo de impresión se abre únicamente al apretar «Imprimir». En el celular no hay vista previa embebida (los navegadores móviles no la muestran): se usa «Abrir en otra pestaña» o «Descargar».
- Endpoint: `GET /api/ordenes/:id/pdf?copia=mecanico|administracion|ambas` (por defecto `mecanico`). Responde `application/pdf`, `inline`, `no-store`.

## Qué lleva cada hoja
Taller (nombre, razón social, domicilio, teléfono, email y logo si es JPEG), recuadro con la copia («COPIA MECÁNICO» / «COPIA ADMINISTRACIÓN»), «ORDEN DE TRABAJO N° 0087» y fecha-hora de apertura; **cliente y teléfono (sólo en la copia de administración; ver abajo)**; marca y modelo, patente, año y kilometraje registrado; técnico asignado (y participantes); entrega prometida; **motivo de ingreso**; **trabajos solicitados** (con casilla «Hecho»); **repuestos y materiales** (sólo cantidades); diagnóstico previo y observaciones si existen; **«ANOTACIONES DEL MECÁNICO»** con renglones de 9 mm; pie con copia, N° de OT, «Hoja n de m» e impresión.
- **Nunca** lleva precios, costos, márgenes, totales, IVA, cobros ni notas internas (las `orden_notas`, el historial de eventos y el CUIT/datos fiscales quedan fuera). No es una decisión de pantalla: el servidor usa una consulta propia y acotada (`worker/lib/hoja-orden-datos.ts`) que **no lee** esas columnas, y los metadatos del PDF sólo tienen título, asunto y «Fierro» (sin autor).
- Lo que falta no se inventa: «No registrado.» (motivo), «No hay trabajos cargados en la orden.», «—» en los datos vacíos; las secciones opcionales vacías se omiten. En la copia de administración, sin permiso para ver clientes se indica «No disponible con los permisos de quien imprime» (ni nombre ni teléfono).
- **Privacidad (Sprint 23): la copia del MECÁNICO no lleva nunca datos del cliente**, ni siquiera si la imprime el propietario: la regla es del tipo de documento (`DefVariante.datosCliente`), no del rol de quien imprime. No tiene fila de cliente (ni el aviso «No disponible»); el espacio de anotaciones y la maquetación no cambian. La copia de administración muestra al cliente responsable **de esa orden**. Detalle y pruebas en `docs/PRIVACIDAD.md`.

## Maquetación
A4 (210 × 297 mm), márgenes de 15 mm a los lados y 10 mm arriba, Helvetica (estándar, no se incrusta), tonos de gris sólo en rótulos y fondos suaves: imprime bien en blanco y negro. La zona de anotaciones va de los 145 mm al pie (≈ 47 % de la hoja, 14 renglones). Nada se corta: las filas son indivisibles, los títulos viajan con su primera fila y los textos largos (incluidas palabras sin espacios) se parten en renglones sin comprimir la tipografía. Si el contenido llega hasta la zona de anotaciones, pasa a **hojas de continuación** (encabezado compacto, tablas con título repetido «(continuación)») y las anotaciones quedan en la última hoja o, si no entran, en **una hoja propia** con todo el espacio.

## Permisos (nuevos, en Personal → Permisos)
- `ordenes.imprimir`: copia del mecánico. Plantillas: propietario, administrador, recepción, empleado (heredado) y **mecánico** (sólo de sus órdenes asignadas). Depósito y caja no.
- `ordenes.imprimir_administracion`: copia de administración (exige ver todas las órdenes e `ordenes.imprimir`). Recepción, empleado, administrador, propietario.
- Además rigen las reglas de siempre: el taller sale de la sesión, quien sólo ve «asignadas» no imprime las ajenas (404, igual que el detalle) y «ambas» exige los dos permisos. Cada impresión queda en la auditoría (`ordenes · imprimir_pdf`, con copia y cantidad de hojas).

## Cómo ajustar las variantes sin rehacer nada
Todo está en `worker/lib/hoja-orden.ts`:
- `VARIANTES.mecanico` y `VARIANTES.administracion` son definiciones **independientes** (rótulo, permisos, lista de secciones, zona de anotaciones). Hoy tienen las mismas secciones. Para quitar, reordenar o agregar secciones a una copia se edita sólo su lista; `anotaciones: null` quita los renglones de esa copia.
- Una sección nueva = una función en `SECCIONES` que devuelve elementos (alto + dibujo). La paginación y el pie se resuelven solos.
- Si administración llegara a necesitar importes, hay que sumarlos a `DatosHoja` desde `hoja-orden-datos.ts` **exigiendo `presupuestos.valorizados.ver` (y los que correspondan) y sólo para esa variante**; la copia del mecánico no debe recibirlos nunca. Hay pruebas que fallan si aparece una cifra de dinero en el PDF.
- El escritor de PDF (`worker/lib/pdf/`) no depende de servicios externos ni de librerías.

## Referencia SistroFix y lo que falta
Se leyó el artículo público «Cómo recibir una reparación»: en SistroFix la orden se arma en la recepción (cliente, equipo, servicios/repuestos con seña, check-list, observaciones, firma, técnicos) y **al guardarla se imprime como comprobante de recepción para el cliente**. No se copió ningún diseño, marca ni recurso; la hoja de Fierro es propia.
- **Falta comparar con una muestra real** del comprobante que usa el cliente piloto (no se conoce su formato exacto): qué datos agrega o quita, si las copias deben ser idénticas o distintas, si administración necesita precios o firmas, y si la hoja del cliente (con firma) sigue siendo la existente «Imprimir» de la OT.
- Límites: logos PNG/WebP no se dibujan (sólo JPEG; sin logo aparece el nombre del taller); caracteres fuera de WinAnsi (emojis) salen como «?»; la hoja no incluye el checklist de recepción ni sus firmas (se mantiene separado); no se probó con impresoras físicas (sí con rasterizado a imagen y lectura del texto del PDF).
- La vieja vista «Hoja taller» (HTML sin renglones) se eliminó: la reemplaza el PDF.

## Copia para el cliente con QR de seguimiento (Sprint 20)
- Cuarta opción de «Imprimir orden»: `GET /api/ordenes/:id/pdf?copia=cliente`. **Es una hoja aparte** (`worker/lib/hoja-cliente.ts`): las copias del mecánico y de administración, y «ambas», no cambiaron.
- Una hoja A4 con el taller, «COPIA PARA EL CLIENTE», N° de orden, fecha de ingreso, marca/modelo/patente, el **código QR** del enlace de seguimiento (vectorial), la dirección escrita debajo y tres pasos para abrirlo. No lleva datos del cliente, motivo, diagnóstico, observaciones, importes ni notas.
- Exige `ordenes.imprimir` + `seguimiento.compartir` y que el seguimiento esté **activo** (409 si no: se activa desde el detalle de la orden; imprimir no activa nada). Cada impresión queda en la auditoría como las demás. Ver `docs/SEGUIMIENTO.md`.
