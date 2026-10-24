# Recepción y entrega de vehículos (Sprint 18)

Checklist de **ingreso** y de **salida** de cada orden de trabajo (OT), con estado del vehículo, daños señalados sobre un esquema, fotografías (las del Sprint 16), conformidad del cliente en pantalla táctil y un historial que no se puede reescribir. Sirve para cualquier taller: no hay textos, campos ni reglas de un cliente en particular. **Es opcional**: una OT se usa igual aunque el taller no complete nada.

## Cómo se usa (desde una tablet o un celular)
1. Abrir la OT → pestaña **Recepción y entrega** → **Iniciar recepción**.
2. Se abre una pantalla completa con secciones plegables y un indicador de progreso (*«12 de 32 puntos»*). Se guarda sola en el servidor cada vez que se cambia algo (se puede seguir desde otro dispositivo):
   - **Datos del ingreso:** fecha y hora (por defecto, ahora), kilometraje (viene de la OT), combustible (Reserva, ¼, ½, ¾, Lleno), llaves recibidas (− / +) y observaciones generales.
   - **Estado del vehículo:** carrocería, cristales, luces, neumáticos, interior, tablero y accesorios (32 puntos). Cada uno: **Correcto · Observación · Sin revisar · No aplica**, con un texto opcional por punto. **Ningún punto es obligatorio**; lo que no se toca queda «Sin revisar». Cada sección tiene «Marcar lo que falta como correcto».
   - **Daños:** esquema del vehículo visto desde arriba. Se toca la zona (frente, parte trasera, lateral izquierdo, lateral derecho, techo) o el recuadro **Interior**; queda un marcador numerado. Cada daño tiene descripción y fotografías: **Sacar foto** (abre la cámara trasera), **Elegir de galería** o **usar una foto ya tomada de la orden**.
   - **Elementos y pertenencias:** casillas rápidas (documentación, llaves de repuesto, matafuego…) y texto libre.
   - **Fotografías de recepción:** la galería de la etapa *Recepción* de la OT.
3. **Revisar y confirmar** → resumen → *Confirmar recepción*. Desde ese momento el contenido queda congelado.
4. Se abre enseguida la pantalla de **conformidad del cliente**: se le muestra el resumen, escribe su nombre y firma con el dedo o con un lápiz táctil. También se puede registrar **«No está presente»** o **«No desea firmar»** (con aclaración opcional); el cliente puede volver y firmar después, y queda todo el historial.
5. Al entregar: **Iniciar entrega** (misma pantalla): fecha y hora, kilometraje de salida, combustible, estado general, **trabajos realizados** (se precargan desde las tareas completadas o los servicios de la OT, **sin precios**), observaciones, fotografías de entrega y firma.
6. Cuando existen ambos registros, la OT muestra **Ingreso y salida, lado a lado**: kilómetros recorridos, combustible, llaves, cada punto de control que cambió, los daños de cada momento y los **elementos recibidos que no figuran en la entrega**.

La entrega **no pisa** la recepción y no cambia el estado de la OT: son dos registros enlazados (la entrega guarda cuál era la recepción vigente al confirmarse). Si no hubo recepción, la entrega se guarda igual (sin comparación).

## Qué se guarda y cómo se protege
| Dato | Dónde |
|---|---|
| Registro (tipo, revisión, fecha y hora, kilometraje, combustible, responsable, contenido) | `ck_registros` |
| Conformidad del cliente (firma, «no presente», «no desea firmar») | `ck_firmas` |
| Fotografías incluidas en un registro confirmado | `ck_fotos` → la misma fila de `fotos` del Sprint 16 (un solo archivo en R2) |

- **Borrador → confirmado:** el borrador se edita (control de versión: si dos personas editan a la vez, la segunda recibe un aviso en lugar de pisar). Al **confirmar**, el servidor arma el *contexto* (OT, cliente, vehículo, responsable y las fotografías incluidas con su sha256), calcula el **sha256 del contenido exacto** (JSON canónico) y lo guarda junto con la fecha y hora del servidor.
- **Inmutable en la base de datos** (no sólo en la pantalla): disparadores impiden modificar o borrar un registro confirmado, sus firmas y sus vínculos a fotografías, aun con acceso directo a SQL. `GET /api/checklists/:id/verificar` recalcula la huella y comprueba que las fotografías y las firmas siguen correspondiendo al contenido («Verificar integridad» en el resumen).
- **Correcciones = revisiones.** *Corregir* (permiso aparte) pide un **motivo** y crea la **revisión N+1** a partir del contenido vigente; el original, su firma y sus fotos se conservan. La OT muestra el historial («Qué cambió respecto de la original»: *Kilometraje: 120.000 → 125.000*, *Daño agregado…*) y la revisión necesita su propia conformidad. No se puede firmar un registro que ya tiene una revisión posterior confirmada.
- **Firma:** se guarda como **trazos vectoriales** (listas de puntos, ≤ 6.000), no como imagen: pesa unos pocos KB, no usa R2 y se redibuja idéntica. Además: nombre del firmante, fecha y hora **del servidor**, empleado que la registró, versión del checklist, **huella (sha256) del contenido aceptado** y el texto de conformidad (con su versión) que se le mostró. El servidor rechaza firmas vacías, demasiado cortas o fuera del lienzo. **No es una firma digital certificada** ni reemplaza una firma legal: es una constancia de conformidad (la pantalla lo aclara).
- **Fotografías:** una foto incluida en un registro confirmado **no se puede eliminar** (409 `foto_en_checklist`; además lo impide la base). Se incluyen al confirmar las de la etapa (*Recepción* o *Entrega*) de esa OT y las asociadas a los daños; cada una se puede usar en un daño sin duplicar el archivo.
- **Privacidad de importes:** ninguna respuesta de estos endpoints incluye precios, costos ni importes (hay una prueba que recorre las respuestas buscando claves de dinero), así que alguien sin permisos financieros nunca los recibe por acá.
- **Aislamiento:** todo se resuelve con el `taller_id` de la sesión y claves foráneas compuestas; un id de otro taller devuelve 404 (probado con dos talleres, incluido intentar colgar una foto ajena de un daño).
- **Auditoría:** `crear_borrador`, `descartar_borrador`, `confirmar` (con la huella), `conformidad`, `crear_revision` (con el motivo).

## Permisos (`shared/permisos.ts`, configurables por el propietario)
| Permiso | Permite | Por defecto |
|---|---|---|
| `checklists.ver` | Consultar recepciones y entregas de las OT a las que tiene acceso | Propietario, administrador, recepción, mecánico (sólo sus OT), empleado (heredado) |
| `checklists.recepcion` | Crear la recepción, registrar daños y obtener la conformidad | Propietario, administrador, recepción, empleado |
| `checklists.entrega` | Registrar la entrega | ídem |
| `checklists.corregir` | Crear revisiones de lo ya confirmado | Propietario y administrador |
| `checklists.firmas` | Ver el dibujo de la firma y el nombre de quien firmó | Propietario, administrador, recepción, empleado |

Escribir exige poder consultar (`REQUIERE`). Las fotografías siguen con `fotos.ver` / `fotos.subir`. Alcance: quien sólo tiene «órdenes asignadas» (mecánico) ve los checklists de las suyas; el vehículo muestra sólo los de sus órdenes. Sin `checklists.firmas` se ve que el registro está firmado, no la firma.

## Historial
- **En la OT:** recepción, daños con fotos, fotografías de ingreso y de entrega, firmas, revisiones con su motivo y cambios, estado de la entrega y comparación.
- **En la ficha del vehículo:** *Recepciones y entregas* con los checklists de todas sus OT (tipo, revisión, firma, km, cantidad de daños), cada uno enlazado a su OT.
- **Check-list simple anterior** (`checklists`, una fila por OT): se conserva. Si una OT ya tiene datos ahí se muestra plegado como «formato anterior»; quien no tiene el permiso nuevo sigue viendo el formulario de siempre.

## Endpoints (`worker/modules/checklists.ts`)
`GET /api/ordenes/:id/checklists` · `GET /api/vehiculos/:id/checklists` · `POST /api/ordenes/:id/checklists/:tipo/borrador` · `PUT /api/checklists/:id` · `DELETE /api/checklists/:id` (sólo borradores) · `POST /api/checklists/:id/confirmar` · `POST /api/checklists/:id/firma` · `POST /api/ordenes/:id/checklists/:tipo/corregir` · `GET /api/checklists/:id/verificar`. Todos validan con zod, `taller_id` de la sesión y permisos en el servidor.

## Migración 0016 (aditiva)
Crea `ck_registros`, `ck_firmas`, `ck_fotos`, sus índices y disparadores, y un disparador de protección sobre `fotos`. **No modifica ni elimina ningún dato.** Probada con SQLite sobre datos previos (`tests/api/migraciones.test.ts`) y ensayada sobre el respaldo de producción antes de aplicarla en remoto (ver `docs/PROGRESO.md`).

## Lo que no hace (a propósito)
- No es una firma digital certificada ni genera PDF/impresión del checklist. La hoja impresa de la **OT** (con renglones para anotaciones del mecánico y copia para administración) es un requerimiento aparte, **pendiente de definición** (ver `docs/PROGRESO.md`).
- No cambia el estado de la OT ni bloquea nada si el checklist no se completa.
- No edita fotografías ni cambia la etapa de una foto ya subida (para eso: eliminar y volver a sacarla, mientras no esté incluida en un registro confirmado).
- No tiene modo sin conexión: sin red el borrador no se guarda (la pantalla lo avisa y conserva lo escrito mientras siga abierta).
- No se probó con cámara real, Safari/iOS ni lápiz táctil físico (sólo emulación de ancho y eventos de puntero simulados).
