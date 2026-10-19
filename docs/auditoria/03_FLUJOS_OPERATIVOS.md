# 03 — Flujos operativos del taller

Cada flujo se reconstruyó a partir de pantallas, textos de ayuda y datos existentes. **No se ejecutó ningún flujo de punta a punta**: no se guardaron datos porque no se confirmó que la cuenta sea un entorno aislado. Cada paso indica su nivel de evidencia.

---

## F1. Recepción → presupuesto → turno → OT → facturación → cobro (flujo principal)

| # | Paso | Pantalla | Evidencia |
|---|---|---|---|
| 1 | Buscar el cliente o darlo de alta (con autocompletado desde el padrón de ARCA por CUIT) | Modal Nuevo Cliente | OBS (formulario); el autocompletado ARCA no se probó |
| 2 | Registrar el vehículo: patente, año, marca, modelo, chasis | Sub-form Nuevo Vehículo | OBS |
| 3 | Armar el presupuesto con artículos (precio = costo + margen de la lista) y servicios del catálogo, más descuentos, IVA, recargo y vigencia | Nuevo Presupuesto | OBS |
| 4 | Enviar el presupuesto por WhatsApp o en PDF | Listado de presupuestos | OBS (botones) |
| 5 | Presupuesto aprobado → aparece en "presupuestos aprobados sin agendar" | Agenda | OBS |
| 6 | Crear un turno vinculado al presupuesto (fecha, hora). Estados: Agendado → Confirmado → Completado | Nuevo Turno | OBS (formulario y estados); la transición en sí no se observó |
| 7 | "Convertir a OT": la OT hereda líneas y cliente ("Desde Presupuesto P-0026") | Presupuestos → OT | OBS (botón y rastro en la OT 0049) |
| 8 | Cargar el check-list de ingreso del vehículo | Modal Check-list | OBS |
| 9 | Asignar mecánico, iniciar y pausar el trabajo (horas registradas) | Listado de OT | OBS ("Pausada · 0h 1m"); botones no vistos |
| 10 | Imprimir el PDF para el mecánico (sin precios) | Listado de OT | OBS (botón) |
| 11 | Finalizar la OT → descuenta stock ("OT 0048 finalizada") y registra el ingreso en la historia clínica | Movimientos / Historia clínica | OBS (rastros) |
| 12 | Generar la prefactura vinculada a la OT (borrador → pendiente) | Prefacturas | OBS |
| 13a | "Facturar" → factura ARCA con CAE (letra A/B/C según condición de IVA) | Prefacturas → Subdiario | INF (ARCA no configurado; aparece "FAC B 00001-00000037" en cobranzas) |
| 13b | O bien emitir una proforma (PV 99999, no fiscal) | Prefacturas | OBS |
| 14 | Cobrar: total o parcial, varios medios (incluye cheques/eCheq y retenciones) → recibo RP/RF | Cobro / Cobranzas | OBS (formularios) |
| 15 | El cobro impacta en la caja diaria ("Cobro OT"), banco o cartera de cheques, y en la cuenta corriente | Caja, Bancos, Cheques, CC | OBS (rastros) |
| 16 | Asiento contable automático según las cuentas por defecto | Contabilidad | INF |

## F2. OT directa (sin presupuesto)
1. Dashboard → "Nueva orden de trabajo" (OBS).
2. Cliente (existente o nuevo), patente **libre**, km opcional con validación (no puede ser menor al último registrado) (OBS).
3. Artículos y servicios, totales, "Crear OT" (OBS, sin confirmar).
4. Sigue igual que F1 desde el paso 8.

## F3. Venta de mostrador (consumidor final)
1. Venta rápida CF: escanear o buscar el producto, o cargar un ítem libre (OBS).
2. Medio de pago; opcionalmente identificar al comprador o enviar el comprobante por email (OBS).
3. F2 emite el comprobante ARCA; si ARCA no está activo, la venta queda pendiente (OBS, texto de aviso).
4. [INF] Descuenta stock y registra el ingreso en caja.

## F4. Consumo interno o baja de stock
1. Baja rápida: escanear o buscar → carrito → registrar baja (OBS).
2. Genera un movimiento "[Taller] Baja rápida" con stock anterior y actual (OBS).

## F5. Reposición y compras
1. Reposición o "Generar OC": lista de productos con faltante (stock < mínimo) y cantidad sugerida (OBS).
2. Seleccionar el proveedor destino → generar la OC (PDF) (OBS).
3. Recepción: remito de proveedor (suma stock sin factura) o "Recibir stock" (OBS).
4. Factura de proveedor (manual u **OCR**) vinculada a la OC o al remito (OBS, OCR no probado).
5. Orden de pago (efectivo, transferencia, cheque propio o eCheq, saldo a favor) → CC de proveedores (OBS).
6. Subdiario de compras para el libro IVA (OBS).

## F6. Seguimiento de service (posventa)
1. Cada ingreso queda en la historia clínica con km y servicios (OBS).
2. Las tablas de service definen intervalos por km y por años por servicio (OBS).
3. Notificaciones lista los vencidos o próximos por km y fecha (OBS).
4. [DESC] Cómo se contacta al cliente (no se vio botón de envío; posiblemente WhatsApp manual).
5. "Carga rápida de servicio histórico" permite migrar historiales en papel (OBS).

## F7. Caja diaria
1. Apertura (monto inicial) → ingresos y egresos automáticos y manuales → saldo esperado → "Cerrar caja" (OBS, sin ejecutar).
2. [OBS] La caja del día muestra movimientos de cobros de OT de otras fechas. [INF] La caja no se cerró desde entonces, o se agrupa por "caja abierta" y no por día calendario.

## F8. Gastos fijos
1. Definir conceptos recurrentes → "Generar obligaciones del mes" → pagar → estado pagado, pendiente o vencido (OBS, formulario no abierto).

## F9. Contabilidad
1. Las operaciones generan asientos en el libro diario según la imputación de cliente, artículo o proveedor (INF a partir de la configuración de cuentas por defecto).
2. Mayores, balance y cierres de ejercicio (OBS, pestañas).

---

## Estados y transiciones observados

| Entidad | Estados vistos | Transiciones confirmadas |
|---|---|---|
| OT | Pendiente, En progreso, Completada (+ cronómetro: Pausada) | Presupuesto → OT; OT completada → descuenta stock |
| Presupuesto | Pendiente, Aprobado, Rechazado, Vencido | Pendiente → OT ("Convertir a OT"); la fecha de vigencia pasada lo marca Vencido |
| Turno | Agendado, Confirmado, Completado | DESC (la acción no se vio) |
| Prefactura | borrador, Pendiente, Emitida, Facturada, Rechazada por ARCA, Anulada | Pendiente → Facturar; Proforma emitida → "Revertir a prefactura" |
| Cobro de comprobante | Pendiente, Parcial (resta $X), Cobrada | Cobro parcial acumulable |
| Factura de proveedor | Pendiente, Pago parcial, Pagada | Por pagos |
| OC | Pendiente, Recibido | Por recepción |
| Cheque | Cartera, Entregado | DESC |
| Caja | Abierta, (Cerrada) | Cerrar caja |
| Gasto fijo | Pagado, Pendiente, Vencido | DESC |
