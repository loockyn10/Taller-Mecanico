// Deuda con proveedores: saldo, vencimientos e imputación de pagos.
//
// La deuda nace de tres fuentes que nunca se superponen:
//   * compras (ingresan stock y generan la deuda en un solo paso),
//   * facturas de proveedor NO asociadas a una compra (p. ej. la factura de una orden de compra ya recibida),
//   * saldos de apertura (aperturas_saldos_items vigentes): la deuda con que el taller empieza a operar, cargada una sola vez al migrar de otro sistema.
// Una factura asociada a una compra documenta esa deuda pero no la duplica. Las notas de crédito restan siempre.
// Los pagos se imputan al comprobante más antiguo (por vencimiento) en forma derivada: no hay que elegir contra qué se paga.
import { all, hoy } from './db';
import { sumarDias } from './fechas';

/** Saldo con un proveedor en SQL. Parámetros: (taller, proveedor) × 3. */
export const SALDO_PROVEEDOR_SQL = `((SELECT COALESCE(SUM(total),0) FROM compras WHERE taller_id = ? AND proveedor_id = ? AND estado = 'registrada')
  + (SELECT COALESCE(SUM(CASE WHEN tipo LIKE 'nota_credito%' THEN -total ELSE total END),0) FROM facturas_proveedor
       WHERE taller_id = ? AND proveedor_id = ? AND estado = 'registrada' AND (compra_id IS NULL OR tipo LIKE 'nota_credito%'))
  - (SELECT COALESCE(SUM(importe),0) FROM pagos_proveedor WHERE taller_id = ? AND proveedor_id = ? AND estado = 'registrado')
  + (SELECT COALESCE(SUM(importe),0) FROM aperturas_saldos_items WHERE taller_id = ? AND proveedor_id = ? AND activo = 1))`;
export const paramsSaldoProveedor = (tallerId: string, proveedorId: string) => [tallerId, proveedorId, tallerId, proveedorId, tallerId, proveedorId, tallerId, proveedorId];

/** Deuda total con todos los proveedores. Parámetro: taller × 4. */
export const DEUDA_TOTAL_SQL = `((SELECT COALESCE(SUM(total),0) FROM compras WHERE taller_id = ? AND estado = 'registrada')
  + (SELECT COALESCE(SUM(CASE WHEN tipo LIKE 'nota_credito%' THEN -total ELSE total END),0) FROM facturas_proveedor
       WHERE taller_id = ? AND estado = 'registrada' AND (compra_id IS NULL OR tipo LIKE 'nota_credito%'))
  - (SELECT COALESCE(SUM(importe),0) FROM pagos_proveedor WHERE taller_id = ? AND estado = 'registrado')
  + (SELECT COALESCE(SUM(importe),0) FROM aperturas_saldos_items WHERE taller_id = ? AND activo = 1))`;

export interface DocDeuda {
  tipo: 'compra' | 'factura' | 'apertura';
  id: string;
  proveedor_id: string;
  numero: number;
  detalle: string | null;
  fecha: string;
  vencimiento: string;
  total: number;
  pendiente: number;
  dias_atraso: number;
}

export interface DeudaProveedor {
  proveedor_id: string;
  saldo: number; // negativo = saldo a favor (anticipo)
  vencido: number;
  por_vencer: number;
  docs: DocDeuda[];
}

const diasEntre = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400_000);

/** Comprobantes pendientes por proveedor con pagos imputados al más antiguo. */
export async function deudaProveedores(db: D1Database, tallerId: string, proveedorId?: string): Promise<DeudaProveedor[]> {
  const filtro = proveedorId ? 'AND proveedor_id = ?' : '';
  const extra = proveedorId ? [proveedorId] : [];
  const [compras, facturas, pagos, notas, aperturas] = await Promise.all([
    all<any>(
      db,
      `SELECT id, proveedor_id, numero, numero_doc AS detalle, fecha, total,
              COALESCE(vencimiento, date(fecha, '+' || COALESCE((SELECT plazo_pago_dias FROM taller_config WHERE taller_id = compras.taller_id), 30) || ' days')) AS vencimiento
         FROM compras WHERE taller_id = ? AND estado = 'registrada' ${filtro}`,
      tallerId, ...extra,
    ),
    all<any>(
      db,
      `SELECT id, proveedor_id, numero, nro_comprobante AS detalle, fecha, total, vencimiento FROM facturas_proveedor
        WHERE taller_id = ? AND estado = 'registrada' AND compra_id IS NULL AND tipo NOT LIKE 'nota_credito%' ${filtro}`,
      tallerId, ...extra,
    ),
    all<{ proveedor_id: string; v: number }>(db, `SELECT proveedor_id, SUM(importe) AS v FROM pagos_proveedor WHERE taller_id = ? AND estado = 'registrado' ${filtro} GROUP BY proveedor_id`, tallerId, ...extra),
    all<{ proveedor_id: string; v: number }>(db, `SELECT proveedor_id, SUM(total) AS v FROM facturas_proveedor WHERE taller_id = ? AND estado = 'registrada' AND tipo LIKE 'nota_credito%' ${filtro} GROUP BY proveedor_id`, tallerId, ...extra),
    all<any>(
      db,
      `SELECT i.id, i.proveedor_id, a.numero, i.referencia AS detalle, a.fecha_corte AS fecha, i.importe AS total, COALESCE(i.vencimiento, a.fecha_corte) AS vencimiento
         FROM aperturas_saldos_items i JOIN aperturas_saldos a ON a.taller_id = i.taller_id AND a.id = i.apertura_id
        WHERE i.taller_id = ? AND i.activo = 1 ${filtro.replace('proveedor_id', 'i.proveedor_id')}`,
      tallerId, ...extra,
    ),
  ]);
  const h = hoy();
  const porProv = new Map<string, any[]>();
  // Un saldo de apertura a favor del taller (importe negativo) no es un comprobante a pagar: suma al crédito que cancela los más antiguos.
  const aFavor = new Map<string, number>();
  for (const a of aperturas.filter((x) => x.total < 0)) aFavor.set(a.proveedor_id, (aFavor.get(a.proveedor_id) ?? 0) - a.total);
  const docsApertura = aperturas.filter((x) => x.total > 0).map((x) => ({ ...x, tipo: 'apertura' }));
  for (const d of [...compras.map((x) => ({ ...x, tipo: 'compra' })), ...facturas.map((x) => ({ ...x, tipo: 'factura' })), ...docsApertura]) {
    if (!porProv.has(d.proveedor_id)) porProv.set(d.proveedor_id, []);
    porProv.get(d.proveedor_id)!.push(d);
  }
  for (const p of [...pagos, ...notas, ...[...aFavor.keys()].map((proveedor_id) => ({ proveedor_id }))]) if (!porProv.has(p.proveedor_id)) porProv.set(p.proveedor_id, []);
  const res: DeudaProveedor[] = [];
  for (const [pid, docs] of porProv) {
    let credito = (pagos.find((p) => p.proveedor_id === pid)?.v ?? 0) + (notas.find((p) => p.proveedor_id === pid)?.v ?? 0) + (aFavor.get(pid) ?? 0);
    docs.sort((a, b) => (a.vencimiento < b.vencimiento ? -1 : a.vencimiento > b.vencimiento ? 1 : a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : a.numero - b.numero));
    const salida: DocDeuda[] = [];
    for (const d of docs) {
      const aplicado = Math.min(credito, d.total);
      credito -= aplicado;
      const pendiente = d.total - aplicado;
      salida.push({ tipo: d.tipo, id: d.id, proveedor_id: pid, numero: d.numero, detalle: d.detalle, fecha: d.fecha, vencimiento: d.vencimiento, total: d.total, pendiente, dias_atraso: Math.max(0, diasEntre(d.vencimiento, h)) });
    }
    const pend = salida.filter((x) => x.pendiente > 0);
    const limite = sumarDias(h, 7);
    res.push({
      proveedor_id: pid,
      saldo: pend.reduce((a, x) => a + x.pendiente, 0) - credito,
      vencido: pend.filter((x) => x.vencimiento < h).reduce((a, x) => a + x.pendiente, 0),
      por_vencer: pend.filter((x) => x.vencimiento >= h && x.vencimiento <= limite).reduce((a, x) => a + x.pendiente, 0),
      docs: pend,
    });
  }
  return res;
}

/** Saldo con el proveedor de la fila `p` (consulta correlacionada sobre proveedores p). */
export const SALDO_PROVEEDOR_FILA_SQL = `((SELECT COALESCE(SUM(total),0) FROM compras co WHERE co.taller_id = p.taller_id AND co.proveedor_id = p.id AND co.estado = 'registrada')
  + (SELECT COALESCE(SUM(CASE WHEN f.tipo LIKE 'nota_credito%' THEN -f.total ELSE f.total END),0) FROM facturas_proveedor f
       WHERE f.taller_id = p.taller_id AND f.proveedor_id = p.id AND f.estado = 'registrada' AND (f.compra_id IS NULL OR f.tipo LIKE 'nota_credito%'))
  - (SELECT COALESCE(SUM(importe),0) FROM pagos_proveedor pp WHERE pp.taller_id = p.taller_id AND pp.proveedor_id = p.id AND pp.estado = 'registrado')
  + (SELECT COALESCE(SUM(importe),0) FROM aperturas_saldos_items ap WHERE ap.taller_id = p.taller_id AND ap.proveedor_id = p.id AND ap.activo = 1))`;
