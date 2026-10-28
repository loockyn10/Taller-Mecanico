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

## Movimientos financieros con personas (Sprint 24)
Los aportes, préstamos y adelantos de sueldo son datos **sensibles** (dinero que una persona le debe a la empresa o al revés). Ver el detalle en `docs/MOVIMIENTOS_PERSONAS.md`; acá, las reglas de privacidad:
- Seis permisos propios `movpersonas.*`. Los tienen por defecto el propietario y el administrador; **ninguna plantilla operativa** (recepción, mecánico, depósito, caja, empleado) ni quien sólo ficha. Se verifican en cada ruta del servidor.
- No aparecen en ningún PDF (hoja del mecánico, hoja de administración), en el seguimiento público ni en consultas públicas. Los endpoints de personal (`/api/taller/usuarios`) no los incluyen.
- La lista de personas del módulo sólo expone nombre, relación y si la persona usa el sistema: **nunca** correo, PIN, hash ni documento del personal.
- Aislamiento entre empresas: toda consulta lleva el `taller_id` de la sesión y la base usa claves foráneas compuestas; un identificador de otra empresa responde 404/400.
- **Libro de caja y de bancos**: sin `movpersonas.ver`, las filas de estos movimientos (y sus reversos) se devuelven como «Movimiento con personas (reservado)», sin referencia, y **no se pueden buscar por texto** (la búsqueda delataría quién es). El monto y el medio siguen visibles: el arqueo y el cierre de caja tienen que contar ese efectivo.
- **Límites**: quien tiene `contabilidad.ver` ve la descripción de los asientos («Adelanto de sueldo #5 · nombre: motivo»); es un permiso financiero (no está en ninguna plantilla operativa). El texto libre de un movimiento (motivo, referencia) lo ve cualquiera con `movpersonas.ver`.

## Pago del cliente y portal público (Sprint 25)

Detalle en `docs/PAGOS_CLIENTE.md`.

- **Mecánico:** no accede a nada del pago del cliente. La tarjeta «Pago del cliente» y todos los endpoints de comprobantes exigen `ordenes.ver` + `ventas.ver` (el mecánico sólo tiene `ordenes.asignadas`); la copia del mecánico del PDF recibe los datos de la orden **sin** la sección de pago por tipo de copia (`DefVariante.datosPago`), imprima quien imprima. Probado con el rol mecánico (detalle de la OT, PDF y endpoints).
- **Recepción** ve el pago (tiene `ventas.ver`) pero no confirma ni rechaza (hace falta `cobros.registrar`); caja confirma. No se agregaron permisos.
- **Portal público:** muestra sólo el nombre del cliente **de esa orden** (no el titular del vehículo ni otros vinculados), importes globales y, si el cliente eligió transferencia, los datos de la cuenta receptora **de su taller** (titular, banco, alias, CBU/CVU; nunca el CUIT, el saldo ni el nombre interno de la cuenta). El cliente no puede ver archivos, ni de otros ni propios.
- **Comprobantes:** bucket R2 privado, acceso sólo con sesión y permisos, clave armada con el taller de la sesión; vista y descarga auditadas.
