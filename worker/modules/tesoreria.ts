// Tesorería general: centraliza caja, bancos, cheques, cobros y pagos pendientes.
//
// Criterio para no contar dos veces:
//   * Ingresos/egresos del período = libro de caja (cobros, otros ingresos, pagos a proveedores, gastos) + movimientos bancarios
//     que NO pasaron por caja (afecta_resultado = 1: intereses, comisiones, cheques sueltos).
//   * Depósitos, extracciones y transferencias entre cuentas propias se informan aparte: mueven plata, no generan resultado.
//   * Un cobro en transferencia figura en la caja (rubro cobro) y en el banco (espejo), pero cuenta una sola vez: el espejo tiene afecta_resultado = 0.
//   * Las ventas a crédito y las compras sin pagar son "cuentas por cobrar/pagar": no son ingresos ni egresos hasta cobrarse o pagarse.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, query, zFecha } from '../lib/http';
import { all, first, hoy } from '../lib/db';
import { requirePerm } from '../lib/auth';
import { IMPORTE_FIRMADO_SQL } from '../lib/caja';
import { saldosCuentas, SIGNO_BANCO_SQL } from '../lib/banco';
import { deudaProveedores } from '../lib/proveedores';
import { sumarDias } from '../lib/fechas';

export const tesoreria = new Hono<AppEnv>();
tesoreria.use('*', requirePerm('tesoreria.ver'));

/** Efectivo en caja: caja abierta (inicial + movimientos) o, sin caja abierta, lo declarado en el último cierre más lo movido después. */
async function efectivoEnCaja(db: D1Database, tallerId: string) {
  const abierta = await first<{ id: string; numero: number; saldo_inicial: number }>(db, "SELECT id, numero, saldo_inicial FROM caja_sesiones WHERE taller_id = ? AND estado = 'abierta'", tallerId);
  if (abierta) {
    const r = await first<{ v: number }>(db, `SELECT COALESCE(SUM(${IMPORTE_FIRMADO_SQL}), 0) AS v FROM caja_movimientos WHERE taller_id = ? AND sesion_id = ? AND medio = 'efectivo'`, tallerId, abierta.id);
    return { saldo: abierta.saldo_inicial + (r?.v ?? 0), caja_abierta: true, detalle: `Caja #${abierta.numero} abierta` };
  }
  const ult = await first<{ efectivo_declarado: number | null; cerrada_at: string | null; numero: number }>(
    db,
    "SELECT efectivo_declarado, cerrada_at, numero FROM caja_sesiones WHERE taller_id = ? AND estado = 'cerrada' ORDER BY numero DESC LIMIT 1",
    tallerId,
  );
  const suelto = await first<{ v: number }>(
    db,
    `SELECT COALESCE(SUM(${IMPORTE_FIRMADO_SQL}), 0) AS v FROM caja_movimientos WHERE taller_id = ? AND medio = 'efectivo' AND sesion_id IS NULL ${ult?.cerrada_at ? 'AND created_at > ?' : ''}`,
    tallerId, ...(ult?.cerrada_at ? [ult.cerrada_at] : []),
  );
  return { saldo: (ult?.efectivo_declarado ?? 0) + (suelto?.v ?? 0), caja_abierta: false, detalle: ult ? `Último cierre (caja #${ult.numero}) más movimientos posteriores` : 'Sin cajas cerradas' };
}

tesoreria.get('/resumen', async (c) => {
  const s = c.get('sesion');
  const { desde, hasta } = query(c, z.object({ desde: zFecha, hasta: zFecha }));
  if (desde > hasta) throw badRequest('El período es inválido');
  const db = c.env.DB;
  const h = hoy();
  const t = s.tallerId;
  const cfg = await first<{ d: number }>(db, 'SELECT alerta_cheques_dias AS d FROM taller_config WHERE taller_id = ?', t);
  const alerta = cfg?.d ?? 7;

  const [efectivo, cuentas, saldos, rubros, bancarios, internos, cxc, deudas, recurrentes, cheq, serieCaja, serieBanco] = await Promise.all([
    efectivoEnCaja(db, t),
    all<any>(db, 'SELECT id, nombre, banco, moneda, activa FROM cuentas_bancarias WHERE taller_id = ? ORDER BY activa DESC, nombre', t),
    saldosCuentas(db, t),
    all<{ rubro: string; neto: number }>(db, `SELECT rubro, SUM(${IMPORTE_FIRMADO_SQL}) AS neto FROM caja_movimientos WHERE taller_id = ? AND fecha BETWEEN ? AND ? AND rubro <> 'traspaso' GROUP BY rubro`, t, desde, hasta),
    first<{ ingresos: number; egresos: number }>(
      db,
      `SELECT COALESCE(SUM(CASE WHEN m.tipo = 'ingreso' THEN m.importe END), 0) AS ingresos, COALESCE(SUM(CASE WHEN m.tipo = 'egreso' THEN m.importe END), 0) AS egresos
         FROM banco_movimientos m JOIN cuentas_bancarias cb ON cb.taller_id = m.taller_id AND cb.id = m.cuenta_id
        WHERE m.taller_id = ? AND m.fecha BETWEEN ? AND ? AND m.afecta_resultado = 1 AND cb.moneda = 'ARS'`,
      t, desde, hasta,
    ),
    all<{ categoria: string; total: number }>(
      db,
      `SELECT m.categoria, SUM(m.importe) AS total FROM banco_movimientos m JOIN cuentas_bancarias cb ON cb.taller_id = m.taller_id AND cb.id = m.cuenta_id
        WHERE m.taller_id = ? AND m.fecha BETWEEN ? AND ? AND m.categoria IN ('deposito','extraccion','transferencia') AND m.origen_tipo <> 'reverso' AND cb.moneda = 'ARS'
          AND (m.categoria <> 'transferencia' OR m.tipo = 'egreso')
          AND NOT EXISTS (SELECT 1 FROM banco_movimientos r WHERE r.taller_id = m.taller_id AND r.origen_tipo = 'reverso' AND r.origen_id = m.id)
        GROUP BY m.categoria`,
      t, desde, hasta,
    ),
    first<{ por_cobrar: number; vencido: number; periodo: number }>(
      db,
      `SELECT COALESCE(SUM(total - cobrado), 0) AS por_cobrar,
              COALESCE(SUM(CASE WHEN julianday(?) - julianday(fecha) > 30 THEN total - cobrado END), 0) AS vencido,
              COALESCE(SUM(CASE WHEN fecha BETWEEN ? AND ? THEN total - cobrado END), 0) AS periodo
         FROM ventas WHERE taller_id = ? AND estado = 'emitida' AND cobrado < total`,
      h, desde, hasta, t,
    ),
    deudaProveedores(db, t),
    first<{ n: number; total: number }>(db, "SELECT COUNT(*) AS n, COALESCE(SUM(importe), 0) AS total FROM gastos_recurrentes WHERE taller_id = ? AND activo = 1 AND proxima_fecha <= ?", t, h),
    all<{ direccion: string; estado: string; n: number; total: number; prox: number }>(
      db,
      `SELECT direccion, estado, COUNT(*) AS n, COALESCE(SUM(importe), 0) AS total,
              SUM(CASE WHEN (direccion = 'recibido' AND estado = 'en_cartera' AND (fecha_pago BETWEEN ? AND ? OR fecha_vencimiento BETWEEN ? AND ?)) OR (direccion = 'emitido' AND estado = 'entregado' AND fecha_pago BETWEEN ? AND ?) THEN 1 ELSE 0 END) AS prox
         FROM cheques WHERE taller_id = ? AND estado IN ('en_cartera','depositado','entregado') GROUP BY direccion, estado`,
      h, sumarDias(h, alerta), h, sumarDias(h, alerta), h, sumarDias(h, alerta), t,
    ),
    all(db, `SELECT fecha, SUM(CASE WHEN tipo = 'ingreso' THEN importe ELSE 0 END) AS ingresos, SUM(CASE WHEN tipo = 'egreso' THEN importe ELSE 0 END) AS egresos FROM caja_movimientos WHERE taller_id = ? AND fecha BETWEEN ? AND ? AND rubro <> 'traspaso' GROUP BY fecha ORDER BY fecha`, t, desde, hasta),
    all(
      db,
      `SELECT m.fecha, SUM(CASE WHEN m.tipo = 'ingreso' THEN m.importe ELSE 0 END) AS ingresos, SUM(CASE WHEN m.tipo = 'egreso' THEN m.importe ELSE 0 END) AS egresos
         FROM banco_movimientos m JOIN cuentas_bancarias cb ON cb.taller_id = m.taller_id AND cb.id = m.cuenta_id
        WHERE m.taller_id = ? AND m.fecha BETWEEN ? AND ? AND m.afecta_resultado = 1 AND cb.moneda = 'ARS' GROUP BY m.fecha`,
      t, desde, hasta,
    ),
  ]);

  const cuentasConSaldo = cuentas.map((x) => ({ ...x, ...(saldos.find((v) => v.id === x.id) ?? { saldo: 0, saldo_conciliado: 0, pendientes: 0 }) }));
  const ars = cuentasConSaldo.filter((x) => x.moneda === 'ARS' && x.activa);
  const saldoBancos = ars.reduce((a, x) => a + x.saldo, 0);
  const otras = Object.entries(cuentasConSaldo.filter((x) => x.moneda !== 'ARS' && x.activa).reduce<Record<string, number>>((a, x) => ((a[x.moneda] = (a[x.moneda] ?? 0) + x.saldo), a), {})).map(([moneda, total]) => ({ moneda, total }));

  const neto = (r: string) => rubros.find((x) => x.rubro === r)?.neto ?? 0;
  const ingCaja = neto('cobro') + neto('otro_ingreso');
  const egrCaja = -(neto('pago_proveedor') + neto('gasto'));
  const ingBanco = bancarios?.ingresos ?? 0;
  const egrBanco = bancarios?.egresos ?? 0;
  const ingresos = ingCaja + ingBanco;
  const egresos = egrCaja + egrBanco;

  const chequeSuma = (dir: string, est: string) => cheq.find((x) => x.direccion === dir && x.estado === est)?.total ?? 0;
  const chequeProx = cheq.reduce((a, x) => a + x.prox, 0);
  const cxp = deudas.reduce((a, d) => a + Math.max(0, d.saldo), 0);
  const cxpVencido = deudas.reduce((a, d) => a + d.vencido, 0);
  const cxpSemana = deudas.reduce((a, d) => a + d.por_vencer, 0);
  const interno = (cat: string) => internos.find((x) => x.categoria === cat)?.total ?? 0;

  // Serie diaria: caja + banco (sólo lo que genera resultado).
  const dias = new Map<string, { fecha: string; ingresos: number; egresos: number }>();
  for (const r of [...(serieCaja as any[]), ...(serieBanco as any[])]) {
    const x = dias.get(r.fecha) ?? { fecha: r.fecha, ingresos: 0, egresos: 0 };
    x.ingresos += r.ingresos;
    x.egresos += r.egresos;
    dias.set(r.fecha, x);
  }

  return c.json({
    desde, hasta,
    disponible: efectivo.saldo + saldoBancos,
    efectivo,
    bancos: { total: saldoBancos, cuentas: cuentasConSaldo, otras_monedas: otras },
    cheques: {
      en_cartera: chequeSuma('recibido', 'en_cartera'),
      depositados_pendientes: chequeSuma('recibido', 'depositado'),
      emitidos_pendientes: chequeSuma('emitido', 'entregado'),
      proximos: chequeProx,
      dias_alerta: alerta,
    },
    cuentas_por_cobrar: { total: cxc?.por_cobrar ?? 0, vencido_30: cxc?.vencido ?? 0, ventas_del_periodo: cxc?.periodo ?? 0 },
    cuentas_por_pagar: { total: cxp, vencido: cxpVencido, vence_7_dias: cxpSemana, proveedores_con_deuda: deudas.filter((d) => d.saldo > 0).length },
    obligaciones: {
      gastos_recurrentes_vencidos: recurrentes?.n ?? 0,
      gastos_recurrentes_importe: recurrentes?.total ?? 0,
      cheques_emitidos_pendientes: chequeSuma('emitido', 'entregado'),
      proveedores_vencido: cxpVencido,
    },
    periodo: {
      ingresos: { cobros: neto('cobro'), otros: neto('otro_ingreso'), bancarios: ingBanco, total: ingresos },
      egresos: { pagos_proveedor: -neto('pago_proveedor'), gastos: -neto('gasto'), bancarios: egrBanco, total: egresos },
      resultado: ingresos - egresos,
      transferencias_internas: { depositos: interno('deposito'), extracciones: interno('extraccion'), entre_cuentas: interno('transferencia'), nota: 'Mueven plata entre caja y bancos: no son ingresos ni egresos.' },
    },
    serie: [...dias.values()].sort((a, b) => (a.fecha < b.fecha ? -1 : 1)),
  });
});

void SIGNO_BANCO_SQL;
