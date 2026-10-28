# Movimientos con personas (Sprint 24)

Finanzas › **Movimientos con personas**: registra, consulta y administra el dinero que se mueve entre la empresa y las personas vinculadas a ella —socios, propietarios y personal—: aportes y retiros de capital, préstamos de socios, préstamos al personal y adelantos de sueldo. Es un componente financiero **general** (no depende de que la empresa sea un taller): todo se identifica con la empresa (`taller_id`) y no usa nada específico del rubro.

> Estado de la migración y de la verificación en producción: ver `docs/PROGRESO.md` §137–§139 (se distingue siempre «creada en el repositorio», «aplicada en la D1 remota» y «comprobada en producción»).

## 1. Qué se reutilizó (y qué no se creó)
| Necesidad | Se reutiliza | Se agregó |
|---|---|---|
| Dinero en efectivo | El libro de caja `caja_movimientos` (mismas sesiones, arqueo, cierre, reversos, `caja_obligatoria`) | Rubro `persona` y origen `persona_mov` (ampliación de los CHECK) |
| Dinero en bancos | El libro `banco_movimientos` (mismos saldos, conciliación, reversos) con `categoria = 'manual'`, `afecta_resultado = 0` y `origen_tipo = 'persona_mov'` | Nada en el esquema |
| Contabilidad | El motor de asientos derivados e idempotentes (`worker/lib/contab`), la cola `contab_cola` con triggers, el plan de cuentas y los controles | Una fuente más (`mov_persona`), 4 cuentas del plan y 3 controles |
| Personas del personal | `usuarios` (con o sin acceso al ERP: el fichaje por PIN **no** necesita licencia) | Sólo `personas_financieras.usuario_id` apunta al empleado: no se copia su nombre ni su documento |
| Permisos | El sistema granular (`shared/permisos.ts`), `requirePerm`, `permisos_ajustes` | 6 permisos `movpersonas.*` |
| Auditoría, secuencias, idempotencia, fechas | `auditar`, `seqIncrementar`, `idem_key`, `fechaComercial` (retroactividad con permiso) | — |

**No** hay una caja paralela, un segundo libro contable ni una tabla de empleados duplicada. **No** hay multisucursal en el repositorio (no existe una entidad sucursal): el aislamiento es por empresa (`taller_id`), en cada consulta y con claves foráneas compuestas en la base.

## 2. Personas
- **Operador** = quien usa ORVELAN para cargar el movimiento (`movimientos_personas.usuario_id`, más `created_at`). **Persona** = quien entrega o recibe el dinero (`persona_id`). Son dos columnas distintas.
- `personas_financieras` (tipo `socio` | `propietario` | `empleado` | `otra`):
  - **Personal**: la ficha se crea sola al registrar el primer movimiento (`id = 'u:' + usuario_id`, `INSERT OR IGNORE` en el mismo lote) y sólo guarda el vínculo. El nombre se lee siempre del registro de personal. Un empleado que ficha sólo con PIN tiene movimientos igual que uno con acceso.
  - **Socios y otras personas** (no usan el sistema): se agregan desde «Nuevo movimiento › Agregar socio u otra persona» con nombre y documento opcional.
  - Una persona inactiva no recibe movimientos nuevos, **pero sí puede devolver lo que debe** (alguien que se fue y cancela su deuda).
  - El tipo y el vínculo no se reescriben (trigger).
- Adelantos de sueldo y su aplicación sólo corresponden a personal (`tipo = 'empleado'`).

## 3. Categorías
Una categoría **nombra** un *tipo financiero*; el tipo decide la dirección del dinero y el asiento. Hay ocho tipos y la categoría nunca los modifica:

| # | Categoría inicial (id estable = `clave`) | Tipo financiero | Dinero (visto desde la empresa) |
|---|---|---|---|
| 1 | Aporte de capital (`aporte_capital`) | `aporte_capital` | Entra |
| 2 | Retiro o devolución de capital (`retiro_capital`) | `retiro_capital` | Sale |
| 3 | Préstamo de persona a empresa (`prestamo_a_empresa`) | `prestamo_recibido` | Entra |
| 4 | Devolución de préstamo recibido — paga la empresa (`devolucion_prestamo_a_persona`) | `devolucion_prestamo_recibido` | Sale |
| 5 | Préstamo de empresa a persona (`prestamo_a_persona`) | `prestamo_otorgado` | Sale |
| 6 | Devolución de préstamo otorgado — paga la persona (`devolucion_prestamo_a_empresa`) | `devolucion_prestamo_otorgado` | Entra |
| 7 | Adelanto de sueldo (`adelanto_sueldo`) | `adelanto_sueldo` | Sale |
| 8 | Aplicación de adelanto de sueldo (`aplicacion_adelanto`) | `aplicacion_adelanto` | No mueve dinero |
| 9 | Reintegro de gastos realizados por una persona (`reintegro_gastos`) | — | **Pendiente** (ver §9) |

Las categorías 4 y 6 se distinguen **internamente por la obligación que regularizan** (`prestamo_recibido` vs `prestamo_otorgado`): una devolución de la categoría 6 nunca puede cancelar un préstamo de la 3, ni un adelanto.

- Las del sistema existen siempre (definidas en `shared/movpersonas.ts`); la fila de la empresa se crea la primera vez que se usan o se desactivan (`INSERT OR IGNORE` con id determinístico `<taller>:cat:<clave>`). Un `GET` no escribe nada.
- **Categorías propias**: nombre + uno de los 8 tipos. No pueden tener un tipo inventado (CHECK en la base) ni un nombre repetido. Se pueden desactivar. No se eliminan si tienen movimientos (trigger + FK); las del sistema no se renombran ni se eliminan. El tipo de una categoría con movimientos no cambia.
- El movimiento guarda una **copia** del tipo (`tipo_fin`) al registrarse: renombrar o desactivar una categoría no altera cómo se asentó lo anterior.

## 4. Cómo se registra
`POST /api/movimientos-personas/movimientos` (pantalla: «Nuevo movimiento»): persona → categoría → importe y motivo → caja o banco → confirmar. La pantalla muestra en verde «Ingreso de dinero a la empresa», en rojo «Salida de dinero de la empresa» o en gris «Sin movimiento de dinero», y para devoluciones el saldo pendiente y cuánto quedaría.

Validaciones en el servidor (la pantalla sólo las anticipa):
- Importe en **centavos enteros** positivos (`errorImporte`); nada de punto flotante.
- Moneda: la tabla admite `ARS` y `USD`, pero **sólo se aceptan pesos** (la caja y los bancos operan en pesos y la contabilidad es en pesos). Los totales se agrupan siempre por moneda y nunca se suman monedas.
- Fecha: `fechaComercial` (hoy; anterior sólo con `fechas.retroactivas`; nunca futura).
- Caja: si la empresa exige caja abierta, el efectivo requiere una caja abierta (prechequeo + `guardCajaObligatoria` en el lote). Banco: cuenta de la empresa, activa y en pesos (+ `guardCuentaActiva`).
- Categoría activa y disponible; la persona activa (salvo devoluciones); la obligación a regularizar debe ser de la misma persona, moneda y tipo, vigente y no posterior al movimiento.
- `idem_key` obligatoria: un reintento o un doble clic devuelve el mismo movimiento (`duplicado: true`) y no escribe nada más; dos solicitudes simultáneas con la misma clave dejan **un** movimiento (índice único `(taller_id, idem_key)`).

**Inmutabilidad.** No existe ninguna ruta para editar. Triggers en la base impiden modificar (aun con SQL directo) cualquier columna de un movimiento registrado, deshacer una anulación o borrarlo.

## 5. Saldos pendientes
- Un movimiento que **abre** una obligación (`prestamo_recibido`, `prestamo_otorgado`, `adelanto_sueldo`) lleva `regularizado`; cada devolución o aplicación apunta a ella con `regulariza_id` y suma a `regularizado` en el **mismo lote**.
- `CHECK (regularizado <= importe)` garantiza que nunca se devuelva de más, también con dos operadores a la vez (el segundo lote falla completo y no deja caja ni asiento).
- **Saldo pendiente = importe − regularizado**, sin anulados. Tres saldos distintos que **nunca se netean**: préstamos recibidos (la empresa debe), préstamos otorgados (la persona debe) y adelantos pendientes de aplicar.
- Ejemplo del encargo: Martín recibe $80.000 de préstamo y $50.000 de adelanto y devuelve $30.000 del préstamo → préstamo pendiente $50.000 y adelanto pendiente $50.000, por separado.
- Estados: *Registrado*, *Parcialmente regularizado*, *Regularizado* (sólo para préstamos y adelantos) y *Anulado*. Aportes, retiros, devoluciones y aplicaciones quedan «Registrado».
- Anular una devolución devuelve el saldo a la obligación; no se puede anular una obligación con devoluciones o aplicaciones vigentes (primero se anulan esas).

## 6. Adelantos de sueldo
Esta versión **no** liquida sueldos ni descuenta nada automáticamente.
- El adelanto sale de la caja o el banco y queda como *adelanto pendiente de aplicar*. **No es un gasto de sueldos.**
- La **aplicación** (permiso propio `movpersonas.regularizar`) se hace a mano contra una **liquidación identificada** y exige indicar **quién autorizó** el descuento. Queda la persona, la liquidación, la autorización, el operador y el momento. **No mueve dinero** (no hay una segunda salida de caja) y reconoce el costo de sueldos por lo ya adelantado.
- Escribir una categoría no equivale a una autorización legal para descontar remuneraciones: el sistema registra lo que el empleador declara y lo dice en pantalla.
- Para no contar dos veces: el gasto de sueldos de esa liquidación se carga por lo **efectivamente pagado** (neto del adelanto).
- No se integra con ninguna liquidación existente porque el sistema no tiene un módulo de liquidación de sueldos.

## 7. Impacto en caja, bancos y contabilidad
| Tipo | Caja o banco | Asiento (Debe / Haber) |
|---|---|---|
| Aporte de capital | + | Caja o banco / Capital y aportes (3.1.01) |
| Retiro de capital | − | (−) Retiros y devoluciones de capital (3.1.04, regularizadora) / Caja o banco |
| Préstamo recibido | + | Caja o banco / Préstamos recibidos de socios y otras personas (2.3.02, pasivo) |
| Devolución de préstamo recibido | − | Préstamos recibidos / Caja o banco |
| Préstamo otorgado | − | Préstamos otorgados a personas (1.2.04, activo) / Caja o banco |
| Devolución de préstamo otorgado | + | Caja o banco / Préstamos otorgados |
| Adelanto de sueldo | − | Adelantos de sueldo al personal (1.2.05, activo) / Caja o banco |
| Aplicación de adelanto | sin dinero | Sueldos y jornales (5.2.01) / Adelantos de sueldo al personal |

- Ningún aporte, retiro, préstamo, devolución ni adelanto toca **ventas, facturación, cuentas corrientes de clientes, IVA ni cuentas de ingresos o gastos**; sólo la aplicación de un adelanto reconoce el costo de sueldos (y recién entonces). El resultado económico no cambia con aportes y préstamos (probado).
- **Efectivo** → una fila en `caja_movimientos` (`rubro = 'persona'`, `origen_tipo = 'persona_mov'`), dentro del mismo lote. El rubro `persona` queda **fuera de los informes operativos de caja** (`rubro NOT IN ('traspaso','persona')`: caja diaria › reportes, resumen de finanzas, tesorería, informes, flujo de caja contable) para que el dinero de socios o préstamos no aparezca como ingreso o egreso del negocio; sí cuenta en el efectivo esperado, el arqueo y el cierre. Se ve en el libro de caja con su rubro.
- **Banco** → una fila en `banco_movimientos` (`afecta_resultado = 0`). No hay fila de caja (no pasó por la caja). La conciliación bancaria funciona igual.
- La contabilidad se **deriva** (no se escribe en la operación): trigger → `contab_cola` → fuente `mov_persona` → asiento idempotente por `(taller, origen_tipo, origen_id, evento)`. Las cuentas nuevas se crean solas en cada taller la primera vez que corre la sincronización (el plan inicial es idempotente y no pisa códigos propios).
- **Anulación**: el movimiento pasa a *anulado* con motivo, usuario y momento; en efectivo se genera un reverso en la caja abierta; en banco, un reverso bancario (no si está conciliado); en contabilidad, un contra-asiento con las líneas invertidas. Nada se borra.
- **Controles nuevos** (Contabilidad › Controles): cada cuenta (préstamos otorgados, adelantos, préstamos recibidos) se compara con la suma de saldos pendientes; los controles existentes de caja y bancos siguen cuadrando; la cobertura incluye la nueva fuente.
- Los movimientos en una cuenta bancaria o sin cuenta contable se informan como error de cobertura (no se ajusta ni se oculta).

## 8. Permisos y privacidad
| Permiso | Habilita |
|---|---|
| `movpersonas.ver` | Consultar movimientos, personas, categorías, obligaciones e indicadores |
| `movpersonas.registrar` | Registrar movimientos (salvo aplicar adelantos) y dar de alta socios y otras personas. Requiere `ver` |
| `movpersonas.regularizar` | Aplicar un adelanto de sueldo. Requiere `registrar` |
| `movpersonas.anular` | Anular un movimiento. Requiere `ver` |
| `movpersonas.administrar` | Categorías propias, activar/desactivar categorías y personas. Requiere `ver` |
| `movpersonas.reportes` | Totales por persona y por categoría. Requiere `ver` |

- Los tiene por defecto el **propietario** y el **administrador** (como el resto de las finanzas); **ninguna plantilla operativa** (recepción, mecánico, depósito, caja, empleado) y nadie con sólo fichaje. Se otorgan a medida desde Equipo y permisos.
- Se verifican **en el servidor** en cada ruta (el menú sólo oculta la opción). Toda consulta lleva `taller_id` de la sesión; un id de otra empresa responde 404/400. La base lo refuerza con claves foráneas compuestas (persona, categoría, cuenta, usuario y obligación del mismo taller).
- Toda operación deja auditoría (`movimiento_persona`, `categoria_movimiento`, `persona_financiera`).
- Estos datos no están en ningún PDF, en el seguimiento público ni en consultas públicas; los endpoints de personal (`/api/taller/usuarios`) no los incluyen; el listado de personas del módulo expone sólo nombre, relación y si usa el sistema (nunca correo, PIN ni documento del personal).

## 9. Límites y pendientes
1. **Reintegro de gastos** (categoría 9): **no se publica**. Los gastos del sistema siempre salen de la caja o de un banco de la empresa y generan su propio egreso y asiento: registrar el gasto y además reintegrarlo contaría el egreso dos veces. Hace falta poder registrar un gasto «pagado por una persona» (sin salida de caja) que el reintegro después cancele. Se muestra en Categorías como pendiente y no se puede usar.
2. **Sólo pesos**: la base admite USD, pero la API sólo acepta ARS hasta tener caja, bancos y contabilidad en moneda extranjera.
3. **Sin liquidación de sueldos**: la aplicación del adelanto es manual y trazable (§6). Devolver un adelanto en efectivo (en lugar de aplicarlo a una liquidación) no tiene categoría propia todavía.
4. **Sin intereses, sin cuotas, sin porcentajes societarios ni distribución de utilidades** (fuera del alcance).
5. No hay sucursales en el repositorio: el aislamiento es por empresa.
6. Los movimientos con personas aparecen en el libro de caja y en Bancos, pero esas pantallas no los enlazan al módulo (se identifican por el concepto «Categoría #n · Persona»). Quien no tiene `movpersonas.ver` los ve como «Movimiento con personas (reservado)» (ver `docs/PRIVACIDAD.md`); quien tiene `contabilidad.ver` ve la descripción de los asientos.
7. La exportación a CSV de movimientos no se incluyó.
