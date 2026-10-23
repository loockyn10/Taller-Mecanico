# Catálogo automotor argentino (Sprint 15)

Catálogo compartido de marcas → modelos → versiones para el alta de vehículos. Se lee de D1 (sin APIs externas ni servicios pagos) y lo usan todos los talleres: **no se copia a cada taller**; un taller sólo materializa la marca y el modelo que efectivamente usa en un vehículo.

## Fuente y licencia
- DNRPA, *Inscripciones iniciales de autos* — <https://datos.jus.gob.ar/dataset/inscripciones-iniciales-de-autos> — **CC BY 4.0** (la pantalla de alta de vehículo muestra la atribución).
- Sólo se leen las columnas del vehículo (`automotor_*`). Las columnas `titular_*` y `registro_seccional_*` **nunca se leen ni se guardan**.
- Qué trae la fuente: marca (código + descripción), una descripción comercial completa del "modelo" (p. ej. `AMAROK TRENDLINE TDI MT 4X2 G2`), año modelo y tipo de vehículo. **No** trae motorización ni versión estructuradas.

## Proceso reproducible (`npm run catalogo -- <paso>`)
| Paso | Qué hace |
|---|---|
| `descargar` | Baja los ZIP/CSV del dataset (2018 en adelante) a `.cache/catalogo-auto/` (fuera de git). Reutiliza lo ya bajado; `--forzar` para rehacer. |
| `agregar` | Lee los CSV y deja `agregado.json` (combinaciones únicas con conteos por año). |
| `generar` | Normaliza y escribe `data/catalogo-auto/catalogo.json.gz` (~0,27 MB, versionado: permite cargar D1 sin volver a descargar). Reglas en `scripts/catalogo-auto/reglas.json`. |
| `validar` | Informa cuáles vehículos frecuentes existen realmente en el catálogo. |
| `cargar --local` / `--remoto` | Carga el catálogo en D1 (upsert por id estable; idempotente, no borra nada). |
| `actualizar` | `descargar` + `agregar` + `generar` + `validar`. Después `cargar`. |

## Normalización
- **Marca**: se agrupa por nombre normalizado (sin tildes, signos ni mayúsculas); los códigos originales se conservan en `cat_marcas.codigos`. Un mismo nombre puede tener varios códigos (nacional/importado), por eso la identidad es el nombre, no el código. `VW` no existe en la fuente: es sólo un apodo de búsqueda de Volkswagen (`busqueda`).
- **Modelo** = familia: primer término de la descripción, sin prefijos `NUEVO/NEW/ALL NEW` ni la marca repetida; un puñado de familias de varias palabras se declara a mano en `reglas.json` (`GOL TREND`, `COROLLA CROSS`, `GRAND CHEROKEE`…). Modelos que sólo difieren en la escritura (`CR-V`/`CRV`) se unifican; `Gol` y `Gol Trend`, `Onix` y `Onix Plus`, `Corolla` y `Corolla Cross` quedan **separados**.
- **Versión** = el resto de la descripción tal como la informó el registro (más sus códigos `marca/modelo/tipo` originales y los años en que aparece).
- **Motorización**: sólo se informa cuando la descripción la dice literalmente (cilindrada `1.6`, `V6`, `TDI`, `TSI`, `dCi`…). No se deduce nada que no esté escrito; el combustible sólo se sugiere para diésel, híbrido y eléctrico.
- Se excluyen acoplados, semirremolques, remolques, casas rodantes sin motor, cuatriciclos, motos y maquinaria; versiones con menos de 2 inscripciones (ruido de tipeo); marcas "SIN MARCA/NO POSEE".

## Datos y tablas (migración `0014`, aditiva)
- Globales (sin `taller_id`): `cat_marcas`, `cat_modelos`, `cat_versiones`, `cat_meta`, `cat_fichas`. Excluidas de la exportación por taller.
- Vínculos opcionales: `marcas.cat_marca_id`, `modelos.cat_modelo_id`, `vehiculos.cat_modelo_id`, `vehiculos.cat_version_id`, `vehiculos.version`.
- **Fichas técnicas** (`cat_fichas`): estructura lista y **vacía** (código de motor, aceite recomendado y capacidad, refrigerante, filtros, distribución, intervalos, documentación). `fuente` y `fecha_verificacion` son obligatorias a nivel base, para que no entre una especificación sin respaldo. No hay pantalla ni API de carga todavía, y nada se completa con IA.

## API (sólo lectura, requiere sesión)
`GET /api/catalogo-auto/marcas` · `/marcas/:id/modelos` · `/modelos/:id` (versiones + cantidad de fichas) · `/info` (fuente, licencia, fechas). Respuestas con `Cache-Control: private, max-age=3600`.

## Alta/edición de vehículo
`POST/PUT /api/vehiculos` acepta, además de `marca_id`/`modelo_id`: `cat_marca_id`, `cat_modelo_id`, `cat_version_id`, `version`, `marca_texto`, `modelo_texto`. El servidor reutiliza la marca/modelo que el taller ya tenga con ese nombre (sin distinguir mayúsculas, tildes ni signos) y **nunca renombra** una existente; si no hay, crea sólo esa. Lo escrito a mano se registra tal cual. Si el formulario no toca marca/modelo/versión al editar, no se envían y el vehículo conserva lo que tenía.
