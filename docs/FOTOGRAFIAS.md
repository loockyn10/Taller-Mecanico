# Fotografías de vehículos y órdenes de trabajo (Sprint 16)

Cualquier persona autorizada puede sacar o elegir fotos desde el celular o la tablet y asociarlas a un **vehículo** o a una **orden de trabajo** (etapas: recepción, reparación, entrega). Quedan disponibles al instante para el resto del taller. Los archivos viven en un bucket **privado** de Cloudflare R2; en D1 sólo hay referencias y metadatos.

## Estado de R2
- **R2 habilitado y en uso** (desde el 2026-10-24): bucket privado `fierro-fotos` (clase Standard, región ENAM, acceso `r2.dev` deshabilitado y sin dominios personalizados), binding `FIERRO_FOTOS` declarado en `wrangler.jsonc`. Workers Builds lo conserva: la versión activa de `taller-mecanico` lista `env.FIERRO_FOTOS (fierro-fotos) R2 Bucket` (`wrangler versions view`).
- Si el binding faltara (otro entorno, bucket borrado) el Worker sigue corriendo: `GET /api/fotos/estado` informa `habilitado: false`, la app avisa y subir/bajar devuelve `503 fotos_no_habilitadas`. No habilitar nunca un binding a un bucket inexistente: rompe el despliegue entero.
- En local y en las pruebas el bucket se simula en disco (Miniflare). Con `FIERRO_R2_REAL=1` el Worker local (D1 local) usa el **bucket real**, para verificar el almacenamiento de verdad; deja objetos de prueba que hay que borrar al terminar.
- Costos: R2 Standard cobra almacenamiento y operaciones por encima de la capa gratuita mensual vigente en el panel de Cloudflare, sin cargo por salida de datos; con el límite de 2 GB por taller el consumo máximo está acotado por la cantidad de talleres.

## Qué hace
- **Vehículo:** galería en el alta (se eligen antes de guardar y se suben cuando el vehículo ya existe; si alguna falla, el vehículo queda guardado y se puede reintentar sin duplicar), en la edición y en la ficha. Chips para filtrar por "del vehículo" y por etapa de OT.
- **OT:** pestaña *Fotografías* con Recepción / Reparación / Entrega (la etapa inicial se elige según el estado de la OT). Cada foto guarda taller, vehículo, OT, etapa, usuario, fecha y hora y descripción opcional. Las fotos de una OT se ven también en la ficha del vehículo (**un solo archivo**, una sola fila).
- **Mis trabajos:** el mecánico ve la tarjeta *Fotografías* en cada orden asignada (si tiene permiso).
- **Cámara:** botones grandes *Sacar foto* (`<input type="file" accept="image/*" capture="environment">`: abre la cámara trasera en celulares y tablets) y *Elegir de galería* (múltiple). Sin cámara disponible (p. ej. escritorio) el navegador ofrece elegir un archivo. Flujo: abrir OT → Sacar foto → Guardar.
- **Ampliar / eliminar / descripción:** visor con anterior/siguiente; eliminar pide confirmación.

## Optimización
- **En el navegador, antes de subir:** se redimensiona a ≤ 2000 px del lado mayor y se recomprime a JPEG probando calidades 0,86 → 0,62 hasta entrar en ~800 KB (si aun así supera 3,3 MB se reduce el tamaño). Redibujar en un canvas **elimina el EXIF, incluida la ubicación GPS**, y aplica la orientación. Se genera una miniatura de 480 px (~20–40 KB); los listados sólo bajan miniaturas y la foto completa se baja al ampliarla.
- **En el servidor (no se confía en el cliente):** se identifica el formato por su contenido (sólo JPEG y WebP), se valida la estructura (JPEG completo, RIFF/WebP), el tamaño (≤ 3,5 MB; miniatura ≤ 200 KB) y las dimensiones (≤ 4096 px), y se **reescribe el archivo quitando EXIF/XMP/ICC y comentarios**. Rechaza HTML, SVG, PNG, archivos cortados o disfrazados.

## Seguridad y permisos
- Bucket privado, sin URLs públicas ni firmadas permanentes: cada imagen se baja de `GET /api/fotos/:id/archivo|miniatura`, que exige sesión, permiso `fotos.ver` y acceso al vehículo/OT. La clave en R2 es `fotos/<taller_id>/<foto_id>[_m]` y se arma siempre con el taller de la sesión: un id alterado o de otro taller da 404. `foto_id` es un UUID aleatorio. Respuestas con `private, max-age=…, immutable`, `ETag` (304), `nosniff` y CSP `default-src 'none'`.
- **Permisos nuevos** (`shared/permisos.ts`): `fotos.ver`, `fotos.subir` (requiere ver), `fotos.eliminar` (requiere ver). Por defecto: propietario y administrador todos; **recepción, mecánico y empleado (heredado): ver y subir**; depósito y caja: ninguno.
- **Alcance:** fotos de OT → `ordenes.ver` (todas) o `ordenes.asignadas` (sólo las suyas). Subir a una OT → `ordenes.crear`/`ordenes.modificar`, o el mecánico con `ordenes.trabajar_asignadas` sobre una orden asignada; no en órdenes canceladas. Subir al vehículo sin OT → `vehiculos.crear` o `vehiculos.editar`. En la ficha del vehículo un mecánico ve las del vehículo y las de **sus** órdenes, no las de otras.
- La subida es `multipart/form-data` (excepción acotada al filtro "sólo JSON"): exige además el encabezado propio `x-fierro-subida: 1` (un formulario de otro sitio no puede enviarlo) y la cookie de sesión es `SameSite=Lax`.
- **Eliminar** deja registro en `auditoria` (usuario, fecha, vehículo, OT, tamaño, sha256).
- **Sin objetos huérfanos:** subir = (1) fila `pendiente` que reserva cupo, (2) objetos a R2, (3) fila `lista`; si R2 falla se deshace. Eliminar = (1) fila `eliminada` + auditoría en una transacción, (2) borrar objetos y fila. Lo que quede a medias (corte entre D1 y R2) lo termina el Cron de 5 minutos (`limpiarFotos`) o `npm run fotos -- limpiar`. `idem_key` (la genera el navegador) hace que reintentar no duplique.

## Control de almacenamiento
- Por taller: espacio usado (originales + miniaturas, incluidas las que se están guardando), cantidad de fotos y **límite configurable, provisorio de 2 GB** (tabla `taller_almacenamiento`; sin fila = 2 GB). No es todavía un plan comercial y no toca las licencias por usuario.
- Se valida **antes de guardar** (mensaje claro) y otra vez dentro de la transacción de la reserva (dos subidas simultáneas no pueden pasarse del límite).
- Se muestra en *Administración → Licencia*: "Fotografías: 450 MB de 2 GB utilizados" con barra. Sólo la plataforma cambia el límite: `npm run fotos -- limite <taller_id> <MB>` (o `PATCH /api/platform/talleres/:id/almacenamiento`); `npm run fotos -- uso` lista el consumo de todos los talleres.

## Respaldos de las imágenes
**Un respaldo de D1 (`npm run respaldo -- plataforma`, el Time Travel y los respaldos programados) NO incluye las imágenes**: R2 es otro almacenamiento. Los respaldos actuales **no protegen las fotos**; sólo conservan sus metadatos (fila, sha256). Para protegerlas:

1. **Exportar** (con el token de plataforma; en producción `FIERRO_API=https://taller-mecanico.estrubia455.workers.dev` y `PLATFORM_ADMIN_TOKEN` en el entorno):
   `npm run fotos -- exportar [--taller <id>] [--salida carpeta]` → carpeta `respaldos/fotos-<fecha>/<taller>/<foto>.jpg|webp` y `_m` + `manifiesto.json` con, por foto, `id`, `taller_id`, `vehiculo_id`, `orden_id`, `etapa`, `mime`, `bytes`, `sha256`, `miniatura_sha256` y las claves de R2. Cada archivo se compara con el sha256 guardado en D1 al bajarlo; es reanudable.
2. **Verificar** en cualquier momento (sin red): `npm run fotos -- verificar <carpeta>` → faltantes / corruptos / sobrantes.
3. **Comparar R2 con D1:** `npm run fotos -- auditar` → objetos huérfanos y fotos "lista" sin archivo.
4. **Recuperar:** (a) si se perdió D1: restaurar D1 (`docs/RESPALDOS.md`) y luego las imágenes; (b) si se perdió R2 (o el bucket): recrear el bucket y `npm run fotos -- restaurar <carpeta> --remoto` (verifica la carpeta antes de subir nada); (c) `npm run fotos -- auditar` debe terminar sin diferencias. Las filas de D1 y los archivos se relacionan por `foto_id`.
5. Las carpetas exportadas contienen **fotos privadas de clientes**: van en `respaldos/` (ignorado por git), nunca al repositorio, y no se entregan. Frecuencia recomendada: igual que el respaldo de D1, y siempre antes de una migración que toque `fotos`.
- **Probado con R2 real** (2026-10-24, Worker local contra el bucket `fierro-fotos`): exportar 3 fotos (sha256 verificado contra D1) → verificar → borrar los 3 originales del bucket → `auditar` (3 faltantes) → `restaurar --remoto` → `auditar` (0 diferencias) → nueva exportación con hashes idénticos. También en local con R2 simulado.
- Pendiente: la exportación no está automatizada en GitHub Actions (como sí lo está el respaldo cifrado de D1) y todavía no hay fotos en producción que respaldar; conviene automatizarla antes de que el taller empiece a usarlas en serio.

## Lo que NO se hizo (alcance)
Checklist de recepción, firmas digitales, manuales y fichas técnicas, cambios en el catálogo de marcas, ARCA o funciones comerciales nuevas.
