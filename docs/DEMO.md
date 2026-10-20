# Cuenta de demostración · "Taller Demo Fierro"

Generador reutilizable de datos ficticios para mostrar Fierro con un taller que lleva ~3 meses funcionando. Todo es ficticio (nombres, CUIT con dígito verificador válido pero inexistentes, patentes, teléfonos, bancos) y relacionado entre sí.

- Usuario propietario: `demo@fierro.local` · también se crean `administracion@fierro.local` (administrador) y `mostrador@fierro.local` (empleado).
- Código: `scripts/demo/` · comando: `npm run demo -- <comando>`.
- **No genera comprobantes fiscales ni envía WhatsApp, correos ni nada externo.** No borra ni modifica otros talleres.

## Qué genera (77 jornadas de lunes a sábado, de 90 días corridos hasta hoy)

| Rubro | Cantidad |
|---|---|
| Clientes / vehículos / mecánicos / proveedores / artículos | 30 / 35 / 4 / 8 / 80 |
| Presupuestos | 25 (17 convertidos en OT, 3 aprobados, 3 pendientes —uno vencido—, 2 rechazados) |
| Órdenes de trabajo | 45 (33 entregadas, 4 listas, 2 en reparación, 1 esperando repuestos, 1 en diagnóstico, 2 recibidas, 2 canceladas) |
| Turnos | 30 (completados, cancelados, ausentes y próximos días; algunos para hoy y mañana) |
| Ventas de mostrador | 35 (+ 35 comprobantes de OT) · 1 anulada |
| Compras directas / órdenes de compra | 26 / 5 (borrador, pendiente, parcial, recibida, cancelada) con facturas y una nota de crédito |
| Cobros y cuentas corrientes | cobros completos y parciales, 6 clientes con deuda con distinta antigüedad |
| Cajas | 77 aperturas y cierres (7 con diferencia justificada), arqueos, ingresos manuales; la de hoy queda abierta |
| Gastos | ~58 + 3 recurrentes (uno vencido) |
| Bancos | 3 cuentas, depósitos, transferencias, comisiones, 3 conciliaciones (una con diferencia) |
| Cheques | recibidos (físicos y eCheq), depositados, acreditados, un rechazado, uno vencido, próximos a vencer, endosado a un proveedor, cheques propios |
| Inventario | movimientos de stock, ajustes con motivo, conteo físico aplicado y otro abierto, artículos bajo mínimo, historial de costos, ajuste de precios |
| Listas de precios | "Mayorista / flotas" y "Tarjeta de crédito" |

Resultado típico del período: facturado ≈ $ 10,6 M (IVA incl., 69 comprobantes vigentes), cobrado ≈ $ 9,1 M en 67 cobros, resultado financiero positivo en el trimestre, inventario ≈ $ 6,8 M a costo.

## Cómo funciona (y por qué hay un paso de "cronología")

1. **Plan** (`simular`): se construye en memoria, de forma determinista (semilla fija), la actividad de cada jornada. Un libro de stock "sombra" garantiza que nada deje stock negativo; las compras de reposición se generan solas cuando algo baja del mínimo.
2. **Carga** (`cargar`): se ejecuta ese plan **sólo a través de la API real** del Worker, jornada por jornada: abre caja → opera → cierra caja con arqueo. Así se aplican todas las validaciones, transacciones, movimientos de stock, asientos de caja y banco, cheques y numeración. No se inserta nada directamente en la base.
3. **Cronología**: la API no permite fechar en el pasado las OT, los comprobantes de OT ni sus cobros (usan siempre "ahora"). Por eso cada jornada se ejecuta en tiempo real y luego se ejecuta un **SQL auditable** (`scripts/demo/salida/cronologia-*.sql`) que reubica las fechas de cada jornada en el día simulado. Contiene sólo `UPDATE` de columnas de fecha/hora **de ese taller** (sin cambiar importes, estados, vínculos ni cantidades) y se aborta solo si ya fue aplicado. La jornada de hoy no se modifica.
4. **Verificación** (`verificar`): 90 comprobaciones sólo de lectura (ver abajo).

Identificación de los registros: todo vive en el taller "Taller Demo Fierro"; además clientes, vehículos, proveedores y cuentas llevan `[DEMO]` en sus notas, las claves de idempotencia empiezan con `demo:`, y el manifiesto (`scripts/demo/estado/*.json`, no se versiona) lista los ids creados.

## Comandos

```bash
npm run demo -- simular      # plan completo y resumen de lo que se creará. SIN red y SIN escrituras
npm run demo -- destino      # muestra taller / id / licencia / cantidad de clientes del destino (hace login)
npm run demo -- cargar       # ejecuta el plan por la API (por defecto local: http://127.0.0.1:8787)
npm run demo -- cronologia   # regenera el SQL de cronología (con --aplicar-local lo aplica a la base local)
npm run demo -- verificar    # controles de consistencia y de que ninguna sección quede vacía
npm run demo -- estado       # avance guardado en el manifiesto
```

Opciones: `--api URL`, `--email`, `--semilla N`, `--dias N`, `--pausa-ms N`. Variables: `FIERRO_API`, `FIERRO_DEMO_PASSWORD` (por defecto `demo1234` sólo en local), `FIERRO_DEMO_PASSWORD_USUARIOS`, `PLATFORM_ADMIN_TOKEN` (sólo para crear el taller si no existe; en local se lee de `.dev.vars`).

**Idempotente y reanudable:** el manifiesto registra cada operación realizada. Si se corta (red, Ctrl+C), `cargar` continúa donde quedó sin duplicar nada; si ya está cargado, informa "nada que hacer". El generador **sólo carga en un taller sin clientes propios** (no mezcla datos) y no borra jamás: para repetir una demostración usá un taller vacío nuevo (`npm run platform -- crear-taller …`) y otro `--email`.

**Las fechas relativas son al día de ejecución.** La última jornada es "hoy": conviene cargar la cuenta el día de la demostración o la víspera (los turnos de "hoy" y "mañana" y la caja abierta quedan referidos a ese día).

## Ensayo local sin tocar tu entorno habitual (recomendado)

Usa otro puerto y otra carpeta de estado, así que no pisa tu `npm run dev` de 8787/5173.

```powershell
$env:FIERRO_STATE='C:\fierro-demo'; $env:FIERRO_API_PORT='8790'; $env:FIERRO_WEB_PORT='5180'
npm run dev                                   # terminal 1 (migra la base y levanta API en 8790 y web en 5180)

$env:FIERRO_API='http://127.0.0.1:8790'       # terminal 2
npm run demo -- simular
npm run demo -- cargar                        # ~1,5 min; crea el taller demo si no existe
# detener la API de la terminal 1 (Ctrl+C) y aplicar la cronología sobre su base:
$env:FIERRO_STATE='C:\fierro-demo'
npm run demo -- cronologia --aplicar-local
# volver a levantar `npm run dev` (terminal 1) y:
npm run demo -- verificar
```

Abrí http://localhost:5180 · `demo@fierro.local` / `demo1234`.

## Procedimiento para la D1 remota (requiere tu autorización)

El generador **nunca** toca el remoto por su cuenta: con una API que no es local exige `--remoto` y `--confirmo <id del taller>`, y no ejecuta `wrangler --remote`. Pasos:

1. **Confirmar entorno y taller de destino.** Con la contraseña en una variable de entorno (no se acepta por pantalla):
   ```powershell
   $env:FIERRO_API='https://<tu-worker>.workers.dev'; $env:FIERRO_DEMO_PASSWORD='<contraseña del usuario demo>'
   npm run demo -- destino
   ```
   Muestra nombre e **id** del taller, licencia y cuántos clientes tiene. Debe ser el taller demo y estar vacío. (El login crea una sesión; es lo único que escribe este comando.)
2. **Respaldo** (lectura del remoto, la hacés vos):
   ```powershell
   npx wrangler d1 export taller_mecanico --remote --output respaldo-antes-demo.sql
   npx wrangler d1 time-travel info taller_mecanico        # anotá el bookmark: permite volver atrás
   ```
3. **Ver qué se creará:** `npm run demo -- simular` (cantidades por rubro, importes e intervalo de fechas).
4. **Autorización** → recién entonces:
   ```powershell
   $env:PLATFORM_ADMIN_TOKEN='<token de plataforma>'   # sólo si el usuario/taller demo no existe todavía (usuarios adicionales: 2)
   npm run demo -- cargar --remoto --confirmo <id del taller>     # ~2.500 llamadas, ~5-6 min (pausa de 2,6 s entre jornadas)
   ```
5. **Cronología** (escritura en la D1: la hacés vos tras revisar el SQL generado):
   ```powershell
   npx wrangler d1 execute DB --remote --file scripts/demo/salida/cronologia-<host>__demo_fierro.local.sql
   ```
6. **Verificar:** `npm run demo -- verificar` (usa las mismas variables que el paso 1) y recorrer las pantallas.

Volumen en D1: ≈ 15.000 filas escritas en total (la cuota gratuita diaria es de 100.000). La migración 0005 debe estar aplicada en el remoto antes de cargar.

## Qué comprueba `verificar`

Volúmenes; stock exacto contra el libro esperado, sin negativos y con libro continuo por artículo; cajas encadenadas (saldo inicial = declarado del cierre anterior) y diferencias que cierran; cobrado de cada comprobante = suma de sus cobros, sin cobros de más; saldo de cuentas corrientes = comprobantes pendientes; una sola venta por OT; numeración correlativa; eventos de OT y fechas en orden (ingreso ≤ lista ≤ entrega; cobro nunca anterior al comprobante; nada en el futuro); saldo de cada cuenta bancaria = inicial + movimientos y sin negativos; libro de caja = cobros, pagos y gastos vigentes (la plata cuenta una sola vez); tesorería (disponible, resultado) coherente con caja y bancos; estados de OC, cheques, conteos; y que 27 secciones/informes (dashboard, estadísticas, agenda, libros, informes…) devuelvan datos.

## Límites conocidos

- Con una API en el plan gratuito de Workers, el login (PBKDF2) puede superar el límite de CPU (riesgo 1 de `PROGRESO.md`); si falla, el generador se detiene y se puede reanudar.
- La cronología deja las horas dentro de cada jornada entre 08:30 y 18:00 (comprimidas proporcionalmente); no hay horas "reales" de apertura.
- No simula usuarios concurrentes ni fallos: es una carga secuencial.
- Los gastos recurrentes se crean el último día (para que sus próximas fechas sean reales); los gastos de meses anteriores figuran como gastos comunes.
