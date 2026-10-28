# Privacidad de los datos del cliente y permisos (Sprint 23)

El cliente piloto pidió que **los mecánicos no reciban datos personales innecesarios**. Esta nota fija las reglas y dónde se cumplen. Complementa `docs/HOJA_OT.md` (la hoja en PDF) y `shared/permisos.ts` (permisos granulares; no se creó ningún sistema de permisos paralelo).

## Regla 1 · La hoja del mecánico nunca lleva datos del cliente, imprima quien imprima
La privacidad depende del **tipo de documento**, no del rol de quien lo genera: si el propietario imprime la «Copia mecánico», tampoco aparecen datos personales.

- `worker/lib/hoja-orden.ts`: cada variante declara `datosCliente`. `mecanico: false`, `administracion: true`.
- **Defensa en tres capas**: (1) `datosHojaOrden` sólo consulta nombre y teléfono del cliente si alguna copia pedida los muestra **y** la sesión tiene `clientes.ver` (con una copia sólo-mecánico la consulta ni siquiera selecciona esas columnas ni une `clientes`); (2) la variante del mecánico no dibuja la fila de cliente; (3) aunque los datos llegaran, `dibujarVariante` reemplaza el cliente por uno vacío antes de dibujar.
- «Ambas copias»: el cliente aparece **sólo en la hoja de administración**.
- La copia del mecánico muestra: N° de OT, fecha, marca y modelo, patente, año, kilometraje, fotografía del vehículo (si hay), técnico asignado, entrega prometida, motivo, trabajos, repuestos (sólo cantidades), diagnóstico y observaciones, y la zona de anotaciones. **No** muestra cliente, teléfono, correo, documento, dirección, datos fiscales, precios, costos, márgenes ni importes (esto último ya valía desde el Sprint 19).
- La copia de administración mantiene el cliente responsable **de esa OT** (no el del vehículo) con los permisos de siempre (`ordenes.imprimir_administracion` + `clientes.ver`; sin `clientes.ver` imprime «No disponible con los permisos de quien imprime»).

## Regla 2 · El backend devuelve sólo lo autorizado (no alcanza con ocultar en pantalla)
| Respuesta | Sin `clientes.ver` (p. ej. mecánico) |
|---|---|
| `GET /api/ordenes` y `GET /api/ordenes/:id` | sin `cliente`, `cliente_telefono`, `cliente_codigo`; quien sólo ve órdenes asignadas **tampoco recibe `cliente_id`**; sin importes sin `presupuestos.valorizados.ver` |
| `GET /api/vehiculos`, `/:id` | sin `clientes`, `clientes_vinculados`, `clientes_anteriores` ni el cliente de cada OT del historial; no se puede **buscar** por nombre de cliente ni filtrar `?cliente_id=` (403) |
| `GET /api/vehiculos/:id/clientes` y alta/edición de vínculos | 403 |
| `GET /api/vehiculos/:id/historial-tecnico` | sin cliente por OT |
| `GET /api/mantenimientos` | sin contacto del cliente; **la búsqueda ya no filtra por nombre de cliente** (antes un mecánico podía averiguarlo así) |
| `GET /api/buscar` (búsqueda global) | los vehículos no traen nombre de cliente (antes lo traían a cualquiera con `vehiculos.ver`) |
| Checklist de recepción/entrega confirmado | `contexto.cliente` se omite; la huella (hash) se verifica en el servidor sobre el contexto completo |
| `GET /api/clientes`, `/api/ventas`, `/api/presupuestos` | 403 |

Todo lo anterior está cubierto por `tests/api/vehiculos-clientes.test.ts` (recorre las respuestas buscando nombre, teléfono, correo, documento y dirección de los clientes).

## Corregido en este sprint (fugas que ya existían)
1. `/api/buscar` devolvía el nombre del cliente de cada vehículo a cualquiera con `vehiculos.ver` (incluidos mecánicos).
2. `/api/mantenimientos?q=` filtraba también por nombre de cliente antes de limpiar la respuesta: una consulta por texto revelaba si un cliente tenía vehículos con servicios pendientes.
3. El contexto confirmado del checklist incluía el nombre del cliente para quien tuviera `checklists.ver` (los mecánicos).
4. El PDF «Copia mecánico» mostraba nombre y teléfono del cliente a quien tuviera `clientes.ver` (por ejemplo el propietario).
5. `GET /api/ordenes` devolvía `cliente_id` a los mecánicos.

## Límites conocidos (no resueltos; revisar con el cliente)
- **Texto libre**: el motivo, el diagnóstico, las observaciones de la OT, las tareas y las notas internas son texto que escribe el personal y que el mecánico asignado ve (en la hoja y en «Mis trabajos»). Si alguien escribe ahí un nombre, un teléfono o un dato de cobro, el sistema **no puede filtrarlo**. Por eso el campo «Observaciones internas» de la nueva OT aclara que lo ve el mecánico. No hay hoy un campo «nota administrativa privada» separado: haría falta si el taller lo necesita (migración nueva).
- La fotografía del vehículo puede mostrar una patente o a una persona: es la única imagen que lleva la hoja.
- Los permisos son granulares: un mecánico al que el propietario le otorgue `clientes.ver` volverá a ver clientes en pantalla y en la API (la **hoja del mecánico seguirá sin ellos**).
