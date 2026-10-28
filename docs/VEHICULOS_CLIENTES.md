# Vehículos, clientes vinculados y cliente responsable de cada operación (Sprint 23)

Hasta el Sprint 22 un vehículo pertenecía a **un** cliente (`vehiculos.cliente_id`, obligatorio). Desde el Sprint 23:

1. **Un vehículo existe por sí mismo**: se puede registrar sin ningún cliente.
2. **Un vehículo puede tener varios clientes vinculados a la vez** (titular, familiar, conductor, responsable comercial, otro) y se pueden desvincular sin perder el historial.
3. **Cada operación comercial conserva su propio cliente responsable**: OT, presupuesto, turno, venta, checklist. El historial técnico es del vehículo; el cliente es de la operación.

## Modelo de datos (migración `0019_vehiculos_clientes_vinculados.sql`)

```
vehiculos            (id, taller_id, patente, marca_id, modelo_id, anio, …)   ← ya NO tiene cliente_id
vehiculo_clientes    (id, taller_id, vehiculo_id, cliente_id, relacion,
                      vinculado_at, vinculado_por, desvinculado_at, desvinculado_por)
ordenes / presupuestos / turnos / ventas / ck_registros   → siguen con su propio cliente_id
```

- **Una sola fuente de verdad**: la columna vieja se eliminó en la misma migración. No hay un «cliente principal» guardado en el vehículo.
- **Claves foráneas compuestas** `(taller_id, vehiculo_id)` y `(taller_id, cliente_id)`: la base impide vincular un cliente de un taller con un vehículo de otro (probado también escribiendo directo en SQL).
- **Sin duplicados vigentes**: índice único parcial `(taller_id, vehiculo_id, cliente_id) WHERE desvinculado_at IS NULL`. Un vínculo cerrado no cuenta, así que el mismo cliente puede volver a vincularse (queda otro tramo en el historial).
- **Historial**: desvincular **no borra** la fila: completa `desvinculado_at` y `desvinculado_por`. Un CHECK impide fechar la desvinculación antes que la vinculación.
- `relacion` es opcional (`titular | familiar | conductor | responsable_comercial | otro`). La lista vive en `shared/dominio.ts` (`RELACIONES_VEHICULO`) y se valida en la API: sumar un tipo no exige reconstruir la tabla. **No se exige que exista un titular.**
- Cada asociación que existía antes (incluidos los vehículos dados de baja) pasó a ser un vínculo vigente «titular» con `vinculado_at` = fecha de alta del vehículo. Los vehículos conservan id, patente, datos del catálogo, fotos, antecedentes, mantenimientos y checklists.

### Por qué se reconstruyó `vehiculos`
SQLite no permite quitar una columna que integra una clave foránea. La migración copia a una tabla de resguardo, recrea `vehiculos` con todos sus índices y restricciones (`UNIQUE (taller_id, id)`, `UNIQUE (taller_id, patente)`, `km_actual >= 0`, claves a marcas/modelos), reinserta, crea los vínculos y elimina el resguardo. Como otras 7 tablas referencian a `vehiculos`, usa `PRAGMA defer_foreign_keys = on` (D1 aplica el archivo en una transacción) y reinserta **después** del `DROP`, así cada fila de la tabla nueva resuelve las comprobaciones diferidas. Ver el ensayo y el despliegue en `docs/PROGRESO.md` §135.

## API

| Método y ruta | Permisos | Qué hace |
|---|---|---|
| `POST /api/vehiculos` | `vehiculos.crear` (+ `clientes.ver` si vincula) | Crea el vehículo. Acepta `clientes: [{cliente_id, relacion}]` o, abreviado, `cliente_id` (+`relacion`, por defecto `titular`). Sin ninguno, queda sin clientes. |
| `PUT /api/vehiculos/:id` | `vehiculos.editar` | Edita sólo datos del vehículo. **Ya no cambia clientes** (un `cliente_id` en el cuerpo se ignora). |
| `GET /api/vehiculos?sin_clientes=1` | `vehiculos.ver` | Vehículos sin clientes vinculados. `?cliente_id=` (con `clientes.ver`) lista los vinculados a ese cliente. `?q=` busca por patente, marca, modelo y —sólo con `clientes.ver`— por nombre de cliente. |
| `GET /api/vehiculos/:id` | `vehiculos.ver` | Ficha. Con `clientes.ver` suma `clientes_vinculados`, `clientes_anteriores` y el cliente de cada OT del historial. |
| `GET /api/vehiculos/:id/clientes` | `vehiculos.ver` + `clientes.ver` | `{ vigentes, anteriores }` con relación, fechas y quién vinculó/desvinculó. |
| `POST /api/vehiculos/:id/clientes` | `vehiculos.editar` + `clientes.ver` | Vincula `{cliente_id, relacion?}`. 409 si ya está vinculado; 400 si el cliente no existe, es de otro taller o está dado de baja. |
| `PUT /api/vehiculos/:id/clientes/:vinculoId` | ídem | Cambia la relación. |
| `DELETE /api/vehiculos/:id/clientes/:vinculoId` | ídem | Desvincula (cierra el vínculo; no borra nada). |

`POST/PUT /api/ordenes` y `POST/PUT /api/presupuestos` aceptan `vincular_cliente: true` (+ `vinculo_relacion`) para vincular, en el mismo lote atómico, al cliente elegido si todavía no estaba vinculado. Exige `vehiculos.editar` + `clientes.ver`.

## Reglas comerciales (qué se mantuvo y qué cambió)
- **Se mantuvo**: una OT, un presupuesto, un turno o una venta siguen exigiendo un cliente responsable existente, del taller y activo. No hay cliente genérico para «resolver» la falta de vínculo.
- **Cambió**: ya no se exige que el cliente de la OT/presupuesto/turno esté vinculado al vehículo (antes: «El vehículo no pertenece al cliente»). Puede ser cualquier cliente del taller.
- **Al editar** una OT o presupuesto que ya tenía un cliente, no se le vuelve a exigir estar activo (pudo darse de baja después; la operación conserva su responsable).
- **Cambio de propietario**: se desvincula a Juan, se vincula a Carlos (titular). Las OT anteriores siguen siendo de Juan; las nuevas pueden ser de Carlos; el historial técnico del vehículo queda completo.
- **Presupuesto → OT** copia el cliente del presupuesto (no el «titular» actual del vehículo).

## Integraciones adaptadas
- **Ficha del vehículo**: tarjeta «Clientes vinculados» (vincular, editar relación, desvincular con confirmación, y «Ver clientes anteriores»). «Sin clientes vinculados» se muestra explícitamente.
- **Alta de vehículo**: permite ninguno, uno o varios clientes (opcional) y fotos. También desde el catálogo automotor y desde la ficha del cliente.
- **Nueva OT / presupuesto** (`ClienteVehiculo`): se elige el vehículo (búsqueda por patente, marca, modelo o cliente), se muestran sus clientes vinculados como opciones, se puede buscar cualquier otro cliente y se ofrece vincularlo. Si el vehículo tiene un único cliente se propone como responsable.
- **Historial técnico** (`/vehiculos/:id/historial-tecnico`): cada OT muestra «Cliente de esta orden» (sólo con `clientes.ver`).
- **Mantenimientos y recordatorios**: el contacto es el **titular vigente** (o, si no hay, el vinculado más antiguo). Un vehículo sin clientes sigue apareciendo en los vencimientos, sin contacto para avisar por WhatsApp.
- **Importación de vehículos**: el cliente ya no es obligatorio. Con referencia (documento, código o nombre exacto único) se vincula como titular al vehículo **nuevo**; sin referencia se carga sin clientes; una referencia que no se resuelve sigue siendo un error. En un vehículo que ya existe la importación actualiza datos pero **no modifica vínculos** (avisa si el cliente del archivo no está vinculado).
- **Búsqueda global** (`/api/buscar`): los vehículos muestran los nombres de sus clientes sólo con `clientes.ver`.
- Sin cambios: contabilidad, ventas y cobranzas (siguen usando el `cliente_id` de cada comprobante), licencias, empleados, respaldos, catálogo, fotografías.

## Pendientes y límites
- Un cliente que se da de baja conserva sus vínculos vigentes (no se desvincula solo). Las pantallas lo siguen mostrando.
- No hay «transferir vehículo» como acción única: es desvincular + vincular (a propósito: es lo que se pidió y deja el historial explícito).
- El recordatorio usa un solo contacto por vehículo; si el titular ya no es quien debe recibir los avisos, hay que actualizar los vínculos.
