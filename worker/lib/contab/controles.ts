// Controles internos de consistencia entre la contabilidad y las operaciones registradas (caja, bancos, cuentas corrientes, inventario).
// Sólo comparan y informan: JAMÁS crean movimientos ni ajustes para hacer coincidir saldos. Una diferencia se muestra tal cual, con su explicación.
import { all, first } from '../db';
import { DEUDA_TOTAL_SQL } from '../proveedores';
import { FUENTES } from './fuentes';
import { saldoNatural, ORIGEN_LABEL, type Naturaleza } from '../../../shared/contabilidad';
import { pendientesContabilizar } from './informes';

export type EstadoControl = 'ok' | 'diferencia' | 'aviso' | 'info';

export interface Control {
  clave: string;
  titulo: string;
  estado: EstadoControl;
  /** Lo que dice la contabilidad. */
  contable?: number;
  /** Lo que dicen las operaciones (cuentas corrientes, caja, banco…). */
  operativo?: number;
  diferencia?: number;
  detalle: string;
  items?: Array<Record<string, unknown>>;
}

const cmp = (clave: string, titulo: string, contable: number, operativo: number, detalle: string, ayuda?: string): Control => ({
  clave, titulo, contable, operativo, diferencia: contable - operativo, estado: contable === operativo ? 'ok' : 'diferencia', detalle: contable === operativo ? detalle : `${detalle}${ayuda ? ' ' + ayuda : ''}`,
});

export async function controles(db: D1Database, tallerId: string, opciones: { valorizar: boolean }): Promise<Control[]> {
  const t = tallerId;
  const cuentas = await all<{ id: string; rol: string | null; cuenta_bancaria_id: string | null; naturaleza: Naturaleza; nombre: string; debe: number; haber: number }>(
    db,
    `SELECT c.id, c.rol, c.cuenta_bancaria_id, c.naturaleza, c.nombre, COALESCE(m.debe, 0) AS debe, COALESCE(m.haber, 0) AS haber FROM cuentas_contables c
       LEFT JOIN (SELECT l.cuenta_id, SUM(l.debe) AS debe, SUM(l.haber) AS haber FROM asiento_lineas l JOIN asientos a ON a.taller_id = l.taller_id AND a.id = l.asiento_id
                   WHERE l.taller_id = ? AND a.estado <> 'borrador' GROUP BY l.cuenta_id) m ON m.cuenta_id = c.id WHERE c.taller_id = ?`,
    t, t,
  );
  const saldoRol = (rol: string) => {
    const c = cuentas.find((x) => x.rol === rol);
    return c ? saldoNatural(c.naturaleza, c.debe, c.haber) : 0;
  };
  const out: Control[] = [];

  // ── Partida doble y cobertura
  const desbal = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM (SELECT a.id FROM asientos a JOIN asiento_lineas l ON l.taller_id = a.taller_id AND l.asiento_id = a.id
                                 WHERE a.taller_id = ? AND a.estado <> 'borrador' GROUP BY a.id HAVING SUM(l.debe) <> SUM(l.haber))`,
    t,
  );
  const globales = await first<{ debe: number; haber: number }>(
    db, "SELECT COALESCE(SUM(l.debe), 0) AS debe, COALESCE(SUM(l.haber), 0) AS haber FROM asiento_lineas l JOIN asientos a ON a.taller_id = l.taller_id AND a.id = l.asiento_id WHERE l.taller_id = ? AND a.estado <> 'borrador'", t,
  );
  out.push({
    clave: 'partida_doble', titulo: 'Partida doble: el Debe y el Haber coinciden', estado: !desbal?.n && globales?.debe === globales?.haber ? 'ok' : 'diferencia',
    contable: globales?.debe, operativo: globales?.haber, diferencia: (globales?.debe ?? 0) - (globales?.haber ?? 0),
    detalle: !desbal?.n && globales?.debe === globales?.haber ? 'Todos los asientos registrados balancean.' : `${desbal?.n} asiento(s) no balancean. No debería ocurrir: la base lo impide al registrar.`,
  });

  const altas = new Map((await all<{ origen_tipo: string; n: number }>(db, "SELECT origen_tipo, COUNT(*) AS n FROM asientos WHERE taller_id = ? AND evento = 'alta' GROUP BY origen_tipo", t)).map((r) => [r.origen_tipo, r.n]));
  const omit = await all<{ origen_tipo: string; tipo: string; motivo: string; n: number }>(db, "SELECT origen_tipo, tipo, MAX(motivo) AS motivo, COUNT(*) AS n FROM contab_omitidos WHERE taller_id = ? AND evento = 'alta' GROUP BY origen_tipo, tipo", t);
  const cobertura: Array<Record<string, unknown>> = [];
  let pend = 0, err = 0;
  for (const f of FUENTES) {
    const docs = (await first<{ docs: number }>(db, f.cobertura.sql, t))?.docs ?? 0;
    const o = (tp: string) => omit.find((x) => x.origen_tipo === f.tipo && x.tipo === tp);
    const contab = altas.get(f.tipo) ?? 0;
    const sinEfecto = o('sin_efecto')?.n ?? 0, errores = o('error')?.n ?? 0;
    const pendientes = Math.max(0, docs - contab - sinEfecto - errores);
    pend += pendientes;
    err += errores;
    cobertura.push({ origen: f.tipo, etiqueta: ORIGEN_LABEL[f.tipo] ?? f.etiqueta, documentos: docs, contabilizados: contab, sin_efecto: sinEfecto, con_error: errores, pendientes, motivo_error: o('error')?.motivo ?? null });
  }
  out.push({
    clave: 'cobertura', titulo: 'Operaciones contabilizadas', estado: err ? 'diferencia' : pend ? 'aviso' : 'ok',
    detalle: err ? `${err} operación(es) no se pudieron contabilizar porque sus importes no cierran: se muestran abajo con el motivo. No se ajustaron ni se ocultaron.` : pend ? `${pend} operación(es) esperan contabilizarse: se procesan después de la próxima operación comercial o con "Actualizar ahora" (consultar la contabilidad no las contabiliza).` : 'Cada operación tiene su asiento (o no tiene efecto contable).',
    items: cobertura,
  });

  // ── Cuentas corrientes
  const cli = await first<{ v: number }>(db, "SELECT COALESCE(SUM(total - devuelto - cobrado), 0) AS v FROM ventas WHERE taller_id = ? AND estado = 'emitida'", t);
  out.push(cmp('clientes', 'Deudores por ventas = saldos de las cuentas corrientes de clientes', saldoRol('deudores'), cli?.v ?? 0, 'La cuenta Deudores por ventas coincide con lo que deben los clientes.', 'Revisá si hay comprobantes, cobros o devoluciones sin contabilizar.'));
  const fav = await first<{ v: number }>(
    db,
    `SELECT (SELECT COALESCE(SUM(total - credito_aplicado - devuelto), 0) FROM cobros WHERE taller_id = ? AND tipo = 'anticipo' AND estado = 'registrado')
          + (SELECT COALESCE(SUM(liberado - reintegrado - credito_aplicado), 0) FROM devoluciones WHERE taller_id = ? AND estado = 'registrada') AS v`,
    t, t,
  );
  out.push(cmp('anticipos', 'Anticipos y saldos a favor = saldo a favor de los clientes', saldoRol('anticipos'), fav?.v ?? 0, 'El pasivo con los clientes coincide con anticipos sin aplicar y créditos por devoluciones.'));
  const prov = await first<{ v: number }>(db, `SELECT ${DEUDA_TOTAL_SQL} AS v`, t, t, t, t);
  out.push(cmp('proveedores', 'Proveedores = deuda de las cuentas corrientes de proveedores', saldoRol('proveedores'), prov?.v ?? 0, 'La cuenta Proveedores coincide con lo que se debe a los proveedores.'));

  // ── Caja y bancos
  const cajaEf = await first<{ ini: number; mov: number }>(
    db,
    `SELECT COALESCE((SELECT saldo_inicial FROM caja_sesiones WHERE taller_id = ? AND numero = (SELECT MIN(numero) FROM caja_sesiones WHERE taller_id = ?)), 0) AS ini,
            COALESCE((SELECT SUM(CASE tipo WHEN 'ingreso' THEN importe ELSE -importe END) FROM caja_movimientos WHERE taller_id = ? AND medio = 'efectivo'), 0) AS mov`,
    t, t, t,
  );
  out.push(cmp('caja', 'Caja en efectivo = saldo inicial + movimientos de efectivo del libro de caja', saldoRol('caja_efectivo'), (cajaEf?.ini ?? 0) + (cajaEf?.mov ?? 0), 'El efectivo contable coincide con el libro de caja.'));
  const dif = await first<{ v: number; n: number }>(db, "SELECT COALESCE(SUM(diferencia), 0) AS v, COUNT(*) AS n FROM caja_sesiones WHERE taller_id = ? AND estado = 'cerrada' AND COALESCE(diferencia, 0) <> 0", t);
  if (dif?.n) out.push({ clave: 'cierres_caja', titulo: 'Diferencias declaradas en cierres de caja', estado: 'info', diferencia: dif.v, detalle: `${dif.n} cierre(s) tuvieron faltante o sobrante de efectivo (neto ${dif.v / 100}). Quedan informados en la caja: no se asentaron para no crear movimientos artificiales.` });

  const bancos = await all<{ id: string; nombre: string; saldo: number }>(
    db,
    `SELECT cb.id, cb.nombre, cb.saldo_inicial + COALESCE((SELECT SUM(CASE m.tipo WHEN 'ingreso' THEN m.importe ELSE -m.importe END) FROM banco_movimientos m WHERE m.taller_id = cb.taller_id AND m.cuenta_id = cb.id), 0) AS saldo
       FROM cuentas_bancarias cb WHERE cb.taller_id = ? AND cb.moneda = 'ARS' ORDER BY cb.nombre`,
    t,
  );
  const itemsB = bancos.map((b) => {
    const c = cuentas.find((x) => x.cuenta_bancaria_id === b.id);
    const contable = c ? saldoNatural(c.naturaleza, c.debe, c.haber) : 0;
    return { cuenta: b.nombre, contable, operativo: b.saldo, diferencia: contable - b.saldo };
  });
  const difB = itemsB.reduce((a, i) => a + Math.abs(i.diferencia), 0);
  out.push({
    clave: 'bancos', titulo: 'Bancos = saldo de cada cuenta bancaria (inicial + movimientos)', estado: difB ? 'diferencia' : 'ok',
    contable: itemsB.reduce((a, i) => a + i.contable, 0), operativo: itemsB.reduce((a, i) => a + i.operativo, 0), diferencia: itemsB.reduce((a, i) => a + i.diferencia, 0),
    detalle: difB ? 'Alguna cuenta bancaria difiere de su cuenta contable: revisá movimientos sin contabilizar o un saldo inicial modificado.' : bancos.length ? 'Cada cuenta bancaria coincide con su cuenta contable.' : 'No hay cuentas bancarias en pesos.', items: itemsB,
  });

  const noEf = await first<{ v: number }>(
    db, "SELECT COALESCE(SUM(CASE tipo WHEN 'ingreso' THEN importe ELSE -importe END), 0) AS v FROM caja_movimientos WHERE taller_id = ? AND medio NOT IN ('efectivo','cheque')", t,
  );
  const espejos = await first<{ v: number }>(
    db,
    `SELECT COALESCE(SUM(CASE m.tipo WHEN 'ingreso' THEN m.importe ELSE -m.importe END), 0) AS v
       FROM banco_movimientos m JOIN cuentas_bancarias cb ON cb.taller_id = m.taller_id AND cb.id = m.cuenta_id AND cb.moneda = 'ARS'
      WHERE m.taller_id = ? AND (m.origen_tipo IN ('cobro_medio','pago_proveedor','gasto','reintegro_medio')
         OR (m.origen_tipo = 'reverso' AND EXISTS (SELECT 1 FROM banco_movimientos o WHERE o.taller_id = m.taller_id AND o.id = m.origen_id AND o.origen_tipo IN ('cobro_medio','pago_proveedor','gasto','reintegro_medio'))))`,
    t,
  );
  out.push(cmp('electronicos', 'Medios electrónicos sin cuenta asignada = cobros y pagos electrónicos sin cuenta bancaria', saldoRol('electronicos_sin_cuenta'), (noEf?.v ?? 0) - (espejos?.v ?? 0), 'Coincide con los cobros y pagos por transferencia o tarjeta que no se asignaron a una cuenta.'));

  const cart = await first<{ v: number }>(
    db,
    `SELECT COALESCE(SUM(ch.importe), 0) AS v FROM cheques ch JOIN cobro_medios cm ON cm.taller_id = ch.taller_id AND cm.id = ch.origen_id JOIN cobros co ON co.taller_id = cm.taller_id AND co.id = cm.cobro_id
      WHERE ch.taller_id = ? AND ch.direccion = 'recibido' AND ch.origen_tipo = 'cobro_medio' AND co.estado = 'registrado' AND ch.estado IN ('en_cartera','depositado','rechazado')`,
    t,
  );
  const valores = cmp('valores', 'Valores a depositar = cheques recibidos que siguen en cartera o en depósito', saldoRol('valores_depositar'), cart?.v ?? 0, 'La cartera de cheques coincide con la cuenta contable.', 'Un cheque rechazado sigue figurando hasta que se anule el cobro que lo originó.');
  const manuales = await first<{ n: number; v: number }>(db, "SELECT COUNT(*) AS n, COALESCE(SUM(importe), 0) AS v FROM cheques WHERE taller_id = ? AND direccion = 'recibido' AND origen_tipo = 'manual' AND estado IN ('en_cartera','depositado')", t);
  if (manuales?.n) valores.detalle += ` Además hay ${manuales.n} cheque(s) cargado(s) a mano por ${manuales.v / 100} que no nacieron de un cobro: no se contabilizan hasta que se acreditan o se entregan a un proveedor.`;
  out.push(valores);
  const emi = await first<{ v: number }>(
    db, "SELECT COALESCE(SUM(importe), 0) AS v FROM cheques WHERE taller_id = ? AND direccion = 'emitido' AND origen_tipo IN ('pago_proveedor','gasto') AND estado IN ('entregado','rechazado')", t,
  );
  out.push(cmp('cheques_emitidos', 'Cheques propios pendientes = cheques emitidos entregados sin acreditar', saldoRol('cheques_emitidos'), emi?.v ?? 0, 'Los cheques propios pendientes coinciden con la cartera de cheques emitidos.'));

  // ── Movimientos con personas: cada obligación pendiente (saldo = importe − regularizado, sin anulados) debe coincidir con su cuenta contable.
  const obl = await all<{ tipo_fin: string; v: number }>(
    db,
    `SELECT tipo_fin, COALESCE(SUM(importe - regularizado), 0) AS v FROM movimientos_personas
      WHERE taller_id = ? AND estado = 'registrado' AND moneda = 'ARS' AND tipo_fin IN ('prestamo_recibido','prestamo_otorgado','adelanto_sueldo') GROUP BY tipo_fin`,
    t,
  );
  const pendTf = (tf: string) => obl.find((x) => x.tipo_fin === tf)?.v ?? 0;
  out.push(cmp('prestamos_personal', 'Préstamos otorgados = lo que las personas deben a la empresa por préstamos', saldoRol('prestamos_al_personal'), pendTf('prestamo_otorgado'), 'La cuenta contable coincide con los saldos pendientes de préstamos otorgados.', 'Revisá movimientos con personas sin contabilizar o asientos manuales sobre esa cuenta.'));
  out.push(cmp('adelantos_personal', 'Adelantos de sueldo = adelantos pendientes de aplicar', saldoRol('adelantos_personal'), pendTf('adelanto_sueldo'), 'La cuenta contable coincide con los adelantos de sueldo pendientes de aplicar.', 'Revisá movimientos con personas sin contabilizar o asientos manuales sobre esa cuenta.'));
  out.push(cmp('prestamos_de_personas', 'Préstamos recibidos = lo que la empresa debe a socios y otras personas', saldoRol('prestamos_de_personas'), pendTf('prestamo_recibido'), 'La cuenta contable coincide con los saldos pendientes de préstamos recibidos.', 'Revisá movimientos con personas sin contabilizar o asientos manuales sobre esa cuenta.'));

  const trans = saldoRol('transferencias_transito');
  out.push({ clave: 'transferencias', titulo: 'Transferencias entre cuentas propias compensadas', estado: trans === 0 ? 'ok' : 'diferencia', contable: trans, operativo: 0, diferencia: trans, detalle: trans === 0 ? 'Cada transferencia tiene su salida y su entrada: no generó ingresos ni gastos.' : 'Hay transferencias con una sola pata registrada.' });
  const ajb = saldoRol('ajustes_bancarios');
  if (ajb !== 0) out.push({ clave: 'ajustes_bancarios', titulo: 'Ajustes bancarios pendientes de clasificar', estado: 'aviso', contable: ajb, detalle: 'Hay ajustes manuales de saldo bancario sin una causa identificada (comisión, interés, error). Se ven en la cuenta 1.1.06; clasificalos con un asiento manual.' });
  const mxn = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM cuentas_bancarias WHERE taller_id = ? AND moneda <> 'ARS'", t);
  if (mxn?.n) out.push({ clave: 'moneda', titulo: 'Cuentas en moneda extranjera', estado: 'aviso', detalle: `${mxn.n} cuenta(s) bancaria(s) no están en pesos y no se contabilizan: esta versión lleva la contabilidad sólo en pesos.` });
  const sinConc = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM banco_movimientos m JOIN cuentas_bancarias cb ON cb.taller_id = m.taller_id AND cb.id = m.cuenta_id WHERE m.taller_id = ? AND m.conciliado = 0 AND cb.moneda = 'ARS'", t);
  if (sinConc?.n) out.push({ clave: 'conciliacion', titulo: 'Movimientos bancarios sin conciliar', estado: 'info', detalle: `${sinConc.n} movimiento(s) bancario(s) todavía no se conciliaron con el extracto (la conciliación se hace en Bancos).` });
  const rech = await first<{ n: number; v: number }>(
    db,
    `SELECT COUNT(*) AS n, COALESCE(SUM(ch.importe), 0) AS v FROM cheques ch JOIN cobro_medios cm ON cm.taller_id = ch.taller_id AND cm.id = ch.origen_id JOIN cobros co ON co.taller_id = cm.taller_id AND co.id = cm.cobro_id
      WHERE ch.taller_id = ? AND ch.direccion = 'recibido' AND ch.origen_tipo = 'cobro_medio' AND ch.estado = 'rechazado' AND co.estado = 'registrado'`,
    t,
  );
  if (rech?.n) out.push({ clave: 'cheques_rechazados', titulo: 'Cheques rechazados con el cobro vigente', estado: 'aviso', contable: rech.v, detalle: `${rech.n} cheque(s) rechazado(s) cuyo cobro sigue registrado: la deuda del cliente no volvió a figurar. Anulá el cobro para regularizarlo.` });

  // ── Inventario valorizado
  if (opciones.valorizar) {
    const inv = await first<{ v: number }>(db, 'SELECT COALESCE(SUM(ROUND(stock * costo)), 0) AS v FROM articulos WHERE taller_id = ?', t);
    const enOt = await first<{ v: number }>(
      db,
      `SELECT COALESCE(SUM(ROUND(-sm.cantidad * COALESCE(sm.costo_unitario, 0))), 0) AS v FROM stock_movimientos sm
        WHERE sm.taller_id = ? AND sm.origen_tipo = 'orden' AND sm.tipo IN ('consumo_ot','reverso_ot')
          AND NOT EXISTS (SELECT 1 FROM ventas v WHERE v.taller_id = sm.taller_id AND v.orden_id = sm.origen_id AND v.estado = 'emitida')`,
      t,
    );
    // Ventas anteriores al registro del costo histórico: su costo no se contabilizó (no se inventa), así que el inventario contable conserva esa mercadería.
    const sinHistorico = await first<{ v: number; n: number }>(
      db,
      `SELECT COALESCE(SUM(ROUND(vi.cantidad * a.costo)), 0) AS v, COUNT(*) AS n FROM venta_items vi JOIN ventas ve ON ve.taller_id = vi.taller_id AND ve.id = vi.venta_id
         JOIN articulos a ON a.taller_id = vi.taller_id AND a.id = vi.articulo_id
        WHERE vi.taller_id = ? AND ve.estado = 'emitida' AND vi.tipo = 'articulo' AND vi.costo_unitario IS NULL`,
      t,
    );
    const contable = saldoRol('inventario');
    const operativo = (inv?.v ?? 0) + (enOt?.v ?? 0);
    const diferencia = contable - operativo;
    const restante = diferencia - (sinHistorico?.v ?? 0);
    out.push({
      clave: 'inventario', titulo: 'Inventario contable vs. inventario valorizado', estado: diferencia === 0 ? 'ok' : 'aviso', contable, operativo, diferencia,
      detalle:
        diferencia === 0
          ? 'El inventario contable coincide con el stock valorizado.'
          : `El stock valorizado (${(inv?.v ?? 0) / 100}) se calcula al último costo de cada artículo; los repuestos consumidos en órdenes aún sin comprobante (${(enOt?.v ?? 0) / 100}) todavía están en el inventario contable. La diferencia restante se explica por cambios de costo desde cada compra o por mercadería existente antes del uso de ORVELAN sin saldo inicial cargado. No se ajustó: si corresponde, registralo con un asiento manual.`,
      items: [
        { concepto: 'Stock valorizado al costo actual', importe: inv?.v ?? 0 },
        { concepto: 'Repuestos en órdenes sin comprobante', importe: enOt?.v ?? 0 },
        ...(sinHistorico?.n ? [{ concepto: `Costo de ${sinHistorico.n} renglón(es) vendidos antes de registrarse el costo histórico (estimado a costo actual, NO contabilizado)`, importe: sinHistorico.v }] : []),
        { concepto: 'Diferencia sin explicar (cambios de costo, mercadería sin saldo inicial u otros)', importe: restante },
      ],
    });
    const sinCompra = saldoRol('entradas_stock_sin_compra');
    if (sinCompra !== 0) out.push({ clave: 'entradas_stock', titulo: 'Entradas de mercadería sin compra, a clasificar', estado: 'aviso', contable: sinCompra, detalle: 'Hay altas manuales de stock sin una compra registrada (por ejemplo, la carga inicial). Clasificalas con un asiento manual (saldo inicial, aporte o diferencia de inventario).' });
  }
  const mer = saldoRol('mercaderia_a_facturar');
  out.push({
    clave: 'mercaderia', titulo: 'Mercadería recibida pendiente de facturar', estado: mer < 0 ? 'aviso' : 'info', contable: mer,
    detalle: mer < 0 ? 'Se facturó más de lo recibido: revisá las facturas de proveedor asociadas a órdenes de compra.' : mer === 0 ? 'No hay mercadería recibida sin factura.' : 'Es lo que se recibió y todavía no se facturó (es una deuda en formación con los proveedores).',
  });

  const p = await pendientesContabilizar(db, t);
  out.push({
    clave: 'saldos_iniciales', titulo: 'Saldos iniciales', estado: 'info',
    detalle: `Los saldos iniciales de caja, de las cuentas bancarias y de las deudas con proveedores (Administración › Apertura de saldos) se toman de lo cargado. Los de clientes (deudas anteriores al uso de ORVELAN) todavía no tienen documento de apertura y no se inventan; el inventario existente se carga como entrada de stock inicial (queda a clasificar). ${p.sin_efecto ? `${p.sin_efecto} documento(s) sin importes no generan asiento.` : ''}`,
  });
  return out;
}
