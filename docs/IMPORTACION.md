# Puesta en marcha e importación de datos

Guía para quien da de alta un taller nuevo y para quien lo configura. Complementa la sección del Sprint 11 de `PROGRESO.md`.

## 1. Alta comercial de un taller (sin intervención del desarrollador)

1. **La plataforma genera una invitación** (solo con el token de plataforma, desde la línea de comandos; el token nunca llega al navegador):

   ```bash
   PLATFORM_ADMIN_TOKEN=... FIERRO_API=https://taller-mecanico.estrubia455.workers.dev npm run platform -- invitar --adicionales 2 --dias 7
   ```

   Opciones: `--nombre` (sugerido), `--email` (si se indica, solo se activa con ese correo), `--adicionales` (usuarios extra de la licencia), `--dias` (vigencia, 1 a 30; por defecto 7), `--notas` (referencia interna, p. ej. "Venta #12"). Se imprime el **enlace una sola vez**. En la base solo queda su huella SHA-256.
   `npm run platform -- invitaciones` lista el estado (pendiente, usada, vencida, revocada) y `npm run platform -- revocar <id>` anula una pendiente.
2. **El propietario abre el enlace** (`/activar#<token>`; el token va en el fragmento, así no viaja al servidor ni en el Referer, y la página lo quita de la barra de direcciones).
3. **Crea sus credenciales y los datos mínimos del taller** (nombre, teléfono, su nombre, correo y contraseña). El alta es atómica: taller, licencia, propietario, depósito principal, cliente "Consumidor final", catálogos generales y marca de la invitación como usada ocurren juntos o no ocurren.
4. **Entra con la sesión iniciada** y ve el asistente de **Puesta en marcha**. Puede cerrarlo ("Empezar a usar Fierro") y retomarlo desde *Administración › Puesta en marcha*.

Reglas de seguridad: un solo uso (dos canjes simultáneos → uno gana y el otro recibe "enlace inválido"), vencimiento, revocación, respuesta idéntica ante enlace inválido/usado/vencido/revocado, límite de intentos por origen (10 fallos → bloqueo de 30 min), el mismo límite protege el token de plataforma. La licencia respeta el modelo existente (usuarios incluidos + adicionales; sin suscripciones ni cobros).

El taller nace **sin servicios con precios**: las operaciones del tempario se cargan desde la plantilla (tiempos orientativos) y su precio sale de la tarifa por hora que define el taller. Las altas manuales anteriores (`crear-taller`) conservan su catálogo de ejemplo y no reciben el asistente automático.

## 2. Qué se puede importar

| Tipo | Identificadores (para detectar repetidos) | Vínculos | Notas |
|---|---|---|---|
| Clientes | Documento (DNI 6-8 dígitos o CUIT/CUIL de 11 con dígito verificador) y/o código del sistema anterior | — | Los documentos de relleno (000000, 11111111) se ignoran |
| Vehículos | Patente (se normaliza: `ab 123 cd` → `AB123CD`) | Cliente por documento, por código del sistema anterior o, solo sin ninguno de los dos, por nombre exacto **único** | Crea marcas y modelos que falten (opcional). Nunca cambia de titular ni baja el kilometraje |
| Artículos | Código interno y/o código de barras (sin distinguir mayúsculas) | Categoría por nombre (opcional crear); proveedor por CUIT, código o nombre exacto único | Catálogo ≠ existencias (ver 4) |
| Proveedores | CUIT (con dígito verificador) y/o código del sistema anterior | — | |

**Los nombres comerciales nunca identifican a nadie.** Una fila sin identificador se carga como nueva (con aviso) o, en el modo "solo nuevos", se omite.

Formato: `.xlsx` o CSV (separador `;`, `,`, tabulación o `|`; UTF-8 o Windows-1252). No se leen `.xls` antiguos ni libros con contraseña. Máximo 5 MB y 5000 filas por archivo; se procesa en lotes de 50 filas. El archivo se lee en el navegador: al servidor solo viajan las filas ya mapeadas, que se validan de nuevo allí. Fierro guarda el **nombre y la huella** del archivo, no su contenido.

## 3. Cómo funciona el asistente

1. **Archivo**: tipo de datos, archivo (hoja y fila de títulos), conteo de filas.
2. **Columnas**: propuesta automática por nombres habituales ("DNI/CUIT", "Dominio", "Cód. Barras"…); se corrige a mano; vista previa.
3. **Opciones**: modo (omitir duplicados / actualizar existentes / solo nuevos), crear catálogos, existencias iniciales.
4. **Revisión** (el servidor valida todo sin escribir): nuevos, actualizaciones **con el detalle campo por campo (antes → después)**, omitidos y errores; referencias sin resolver (cliente/proveedor) con selector para resolverlas, y descarga del informe de errores y de la lista de faltantes.
5. **Importación** por lotes atómicos con progreso. Si se corta, se reanuda sin repetir (cada lote es único por importación; el mismo archivo y opciones retoman el trabajo). Al final: resumen y descarga del informe.

Garantías: ninguna fila con error se importa; una celda vacía nunca borra un dato; no se cambian identificadores existentes (conflicto → error); la unidad de un artículo con movimientos no se toca; los costos/precios solo los importa quien puede verlos; todo queda asociado al taller de la sesión (las referencias a registros de otro taller se rechazan).

Trazabilidad (`importaciones`): usuario, fecha, archivo (nombre y huella), tipo, modo, opciones, mapeo de columnas, procesados, creados, actualizados, omitidos y errores; por lote; y las filas con error/omitidas (número de fila, referencia corta y motivo, hasta 1000). Los registros creados o modificados quedan listados (`importacion_registros`).

## 4. Existencias y saldos: tratamiento correcto

**Importar el catálogo no genera stock, movimientos ni asientos.** Lo demás requiere un procedimiento explícito:

- **Existencias iniciales** (opción del paso 3, solo para artículos *nuevos* de esa importación, con permiso de ajustar stock y confirmación): crea una **entrada de stock** por artículo, valorizada al costo, en el depósito elegido. Es el mismo circuito que "stock inicial" al crear un artículo a mano; Contabilidad la registra como *Inventario / Entradas de mercadería sin compra (a clasificar)*. Para llevar ese importe a patrimonio se reclasifica con un asiento manual (Debe *Entradas… a clasificar* / Haber *Capital / resultados acumulados*) cuando el contador lo decida. Para un conteo posterior de artículos que ya existían se usa **Control de inventario**.
- **Saldos de clientes y de proveedores** (deudas anteriores a Fierro): **no se importan** y hoy **no existe un documento de "saldo de apertura"** que los registre sin pasar por resultados. La forma disponible es un comprobante interno (cliente) o una factura de proveedor sin ingreso de stock con **fecha de corte anterior al inicio de operaciones en Fierro** (requiere el permiso "fechas retroactivas"): queda en la cuenta corriente y en los saldos, pero impacta como venta o compra del período anterior al corte, no del período en curso. Es un paliativo, no el tratamiento ideal: el documento de apertura específico está registrado como pendiente. Hasta entonces, el control de Contabilidad "Deudores / Proveedores contra cuentas corrientes" lo señalará si se cargan de otra forma.
- **Caja y bancos**: la apertura de caja con su saldo inicial y el saldo inicial de cada cuenta bancaria (se asientan contra *Saldos iniciales y ajustes de apertura*).
- **Anticipos / saldos a favor**: anticipos de clientes con su fecha.
- Nada de esto se toma de las planillas genéricas: cada uno exige un comprobante o paso propio, con usuario, fecha y control de consistencia en Contabilidad.

## 5. Verificación de la instalación publicada

`npm run verificar:online` (solo lectura) con `FIERRO_URL`, `FIERRO_EMAIL` y `FIERRO_PASSWORD` en el entorno (y, opcionalmente, `FIERRO_EMAIL_B`/`FIERRO_PASSWORD_B` de otro taller para la prueba de aislamiento). No imprime credenciales ni tokens.
