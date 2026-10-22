// Ventas (comprobantes internos), cobros y cuentas corrientes de clientes.
//
// Separación fiscal: `ventas` son comprobantes INTERNOS (no fiscales). Cuando se integre ARCA, cada venta podrá
// tener un registro en `comprobantes_fiscales` (CAE, tipo, punto de venta) sin alterar ventas ni cobros.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, conflict, notFound, query, zCentavos, zFecha, zId, zTextoOpt } from '../lib/http';
import { all, auditar, first, guard, hoy, like, lotes, SEQ_VALOR, seqIncrementar, uid, type Stmt } from '../lib/db';
import { requirePerm } from '../lib/auth';
import { medioDeCobroInmediato, sentenciasCobro, validarMediosCobro, zCobroInmediato } from '../lib/cobros';
import { reversoBancoDeCobro } from '../lib/banco';
import { chequesBloqueanAnulacion, sentenciasAnularChequesDeCobro, zChequeDatos } from '../lib/cheques';
import { exigirCajaAbiertaSiCorresponde, guardCajaObligatoria, reversoDeCobro } from '../lib/caja';
import { fechaComercial } from '../lib/fechas';
import { resolverLista, sentenciaListaEnDocumento } from '../lib/listas';
import { COLS_TOTALES, sentenciasItems, totales, validarItems, valoresTotales, zItem, zParametrosTotales } from '../lib/documentos';
import { agrupar, permiteNegativo, resolverDeposito, sentenciasMovimiento, verificarDisponible } from '../lib/stock';
import { puedeCosto } from '../lib/privacidad';
import { credito_cliente_sql, creditosDisponibles } from '../lib/creditos';
import { MEDIOS_PAGO } from '../../shared/dominio';

export const comercial = new Hono<AppEnv>();

const SELECT_VENTA = `SELECT ve.*, c.nombre AS cliente, c.documento, c.condicion_iva AS cliente_condicion_iva, o.numero AS orden_numero,
    (ve.total - ve.devuelto - ve.cobrado) AS saldo,
    (SELECT cf.estado FROM comprobantes_fiscales cf WHERE cf.taller_id = ve.taller_id AND cf.venta_id = ve.id ORDER BY cf.created_at DESC LIMIT 1) AS estado_fiscal
  FROM ventas ve
  JOIN clientes c ON c.taller_id = ve.taller_id AND c.id = ve.cliente_id
  LEFT JOIN ordenes o ON o.taller_id = ve.taller_id AND o.id = ve.orden_id`;

// ───────────── Ventas ─────────────
comercial.get('/ventas', requirePerm('ventas.ver'), async (c) => {
  const s = c.get('sesion');
  const { q, cliente_id, desde, hasta, pendientes, estado } = query(
    c,
    z.object({ q: z.string().optional(), cliente_id: z.string().optional(), desde: z.string().optional(), hasta: z.string().optional(), pendientes: z.string().optional(), estado: z.enum(['pendientes', 'parciales', 'cobradas', 'anuladas', 'devueltas']).optional() }),
  );
  const cond = ['ve.taller_id = ?'];
  const params: unknown[] = [s.tallerId];
  if (cliente_id) (cond.push('ve.cliente_id = ?'), params.push(cliente_id));
  if (q) (cond.push('(c.nombre LIKE ? OR CAST(ve.numero AS TEXT) = ?)'), params.push(like(q), q.replace(/\D/g, '')));
  if (desde) (cond.push('ve.fecha >= ?'), params.push(desde));
  if (hasta) (cond.push('ve.fecha <= ?'), params.push(hasta));
  if (pendientes || estado === 'pendientes') cond.push("ve.estado = 'emitida' AND ve.cobrado + ve.devuelto < ve.total");
  if (estado === 'parciales') cond.push("ve.estado = 'emitida' AND ve.cobrado > 0 AND ve.cobrado + ve.devuelto < ve.total");
  if (estado === 'cobradas') cond.push("ve.estado = 'emitida' AND ve.cobrado + ve.devuelto >= ve.total AND ve.devuelto < ve.total");
  if (estado === 'devueltas') cond.push("ve.estado = 'emitida' AND ve.devuelto > 0");
  if (estado === 'anuladas') cond.push("ve.estado = 'anulada'");
  return c.json(await all(c.env.DB, `${SELECT_VENTA} WHERE ${cond.join(' AND ')} ORDER BY ve.numero DESC LIMIT 300`, ...params));
});

comercial.get('/ventas/:id', requirePerm('ventas.ver'), async (c) => {
  const s = c.get('sesion');
  const v = await first(c.env.DB, `${SELECT_VENTA} WHERE ve.taller_id = ? AND ve.id = ?`, s.tallerId, c.req.param('id'));
  if (!v) throw notFound('Comprobante');
  // El costo con el que se emitió es un dato de costo: solo lo ve quien tiene permiso.
  const items = (
    await all<Record<string, unknown>>(
      c.env.DB,
      `SELECT vi.*, (SELECT COALESCE(SUM(di.cantidad), 0) FROM devolucion_items di JOIN devoluciones d ON d.taller_id = di.taller_id AND d.id = di.devolucion_id
                       WHERE di.taller_id = vi.taller_id AND di.venta_item_id = vi.id AND d.estado = 'registrada') AS cantidad_devuelta,
              (SELECT COALESCE(SUM(di.importe), 0) FROM devolucion_items di JOIN devoluciones d ON d.taller_id = di.taller_id AND d.id = di.devolucion_id
                WHERE di.taller_id = vi.taller_id AND di.venta_item_id = vi.id AND d.estado = 'registrada') AS importe_devuelto
         FROM venta_items vi WHERE vi.taller_id = ? AND vi.venta_id = ? ORDER BY vi.orden`,
      s.tallerId, v.id,
    )
  ).map((i) => {
    if (puedeCosto(s)) return i;
    const { costo_unitario: _c, ...resto } = i;
    return resto;
  });
  const devoluciones = await all(
    c.env.DB,
    `SELECT d.id, d.numero, d.fecha, d.estado, d.total, d.motivo, d.liberado, d.reintegrado, d.credito_aplicado FROM devoluciones d WHERE d.taller_id = ? AND d.venta_id = ? ORDER BY d.numero`,
    s.tallerId, v.id,
  );
  const creditos = await all(
    c.env.DB,
    `SELECT ca.id, ca.origen_tipo, ca.origen_id, ca.importe, ca.fecha, ca.estado,
            CASE ca.origen_tipo WHEN 'anticipo' THEN (SELECT co.numero FROM cobros co WHERE co.taller_id = ca.taller_id AND co.id = ca.origen_id)
                                ELSE (SELECT d.numero FROM devoluciones d WHERE d.taller_id = ca.taller_id AND d.id = ca.origen_id) END AS origen_numero
       FROM credito_aplicaciones ca WHERE ca.taller_id = ? AND ca.venta_id = ? ORDER BY ca.created_at`,
    s.tallerId, v.id,
  );
  const cobros = await all(
    c.env.DB,
    `SELECT co.id, co.numero, co.fecha, co.estado, ca.importe FROM cobro_aplicaciones ca JOIN cobros co ON co.taller_id = ca.taller_id AND co.id = ca.cobro_id
      WHERE ca.taller_id = ? AND ca.venta_id = ? ORDER BY co.fecha`,
    s.tallerId,
    v.id,
  );
  return c.json({ ...v, items, cobros, devoluciones, creditos, fiscal: { disponible: false, mensaje: 'Comprobante interno. La facturación electrónica ARCA todavía no está integrada.' } });
});

/** Venta de mostrador (sin OT): descuenta stock de los artículos vendidos. */
comercial.post('/ventas', requirePerm('ventas.emitir'), async (c) => {
  const s = c.get('sesion');
  const d = await body(
    c,
    zParametrosTotales.extend({
      cliente_id: zId.nullish(),
      fecha: zFecha.optional(),
      condicion: z.enum(['contado', 'cuenta_corriente']).default('contado'),
      observaciones: zTextoOpt(500),
      items: z.array(zItem).min(1).max(200),
      idem_key: z.string().min(8).max(80),
      lista_precio_id: zId.nullish(),
      /** Depósito del que salen los repuestos (sin indicar: el principal). */
      deposito_id: zId.nullish(),
      // Cobro inmediato del total (venta de contado): se registra en la misma transacción.
      cobro: zCobroInmediato.nullish(),
    }),
  );
  const previa = await first(c.env.DB, `${SELECT_VENTA} WHERE ve.taller_id = ? AND ve.idem_key = ?`, s.tallerId, d.idem_key);
  if (previa) return c.json({ ...previa, duplicado: true }, 200);
  if (d.condicion === 'cuenta_corriente' && d.cobro) throw badRequest('Una venta a cuenta corriente no se cobra en el acto: elegí contado o quitá el cobro');
  const cf = await first<{ id: string }>(c.env.DB, 'SELECT id FROM clientes WHERE taller_id = ? AND codigo = 0', s.tallerId);
  const clienteId = d.cliente_id || cf!.id;
  if (d.cliente_id && !(await first(c.env.DB, 'SELECT 1 FROM clientes WHERE taller_id = ? AND id = ?', s.tallerId, clienteId))) throw badRequest('Cliente inexistente');
  // La deuda siempre tiene que tener un cliente identificado: no se admite cuenta corriente a "Consumidor final".
  if (d.condicion === 'cuenta_corriente' && clienteId === cf!.id) throw badRequest('La cuenta corriente requiere un cliente identificado (no "Consumidor final")');
  const fecha = fechaComercial(s, d.fecha);
  const lista = await resolverLista(c.env.DB, s.tallerId, d.lista_precio_id);
  const items = await validarItems(c.env.DB, s.tallerId, d.items);
  const t = totales(items, d);
  // "Contado" significa cobrado: ya no es sólo una etiqueta que deja la venta impaga.
  if (d.condicion === 'contado' && t.total > 0 && !d.cobro) throw badRequest('Una venta de contado se cobra en el momento: elegí el medio de pago o pasala a cuenta corriente');
  if (d.cobro) await validarMediosCobro(c.env.DB, s.tallerId, [medioDeCobroInmediato(d.cobro, t.total)]);
  const cobrar = d.condicion === 'contado' && !!d.cobro && t.total > 0;
  if (cobrar) await exigirCajaAbiertaSiCorresponde(c.env.DB, s.tallerId);
  const porArticulo = agrupar(items.map((i) => ({ articulo_id: i.articulo_id ?? null, cantidad: i.cantidad })));
  const negativo = await permiteNegativo(c.env.DB, s.tallerId);
  const deposito = await resolverDeposito(c.env.DB, s.tallerId, d.deposito_id);
  if (!negativo) await verificarDisponible(c.env.DB, s.tallerId, porArticulo, deposito);
  const alicuotas = await alicuotasItems(c.env.DB, s.tallerId, items);
  const id = uid();
  const stmts: Stmt[] = [
    ...seqIncrementar(c.env.DB, s.tallerId, 'venta'),
    c.env.DB.prepare(
      `INSERT INTO ventas (id, taller_id, numero, cliente_id, fecha, condicion, observaciones, idem_key, created_by, deposito_id, ${COLS_TOTALES})
       VALUES (?, ?, ${SEQ_VALOR}, ?, ?, ?, ?, ?, ?, ?, ${COLS_TOTALES.split(',').map(() => '?').join(',')})`,
    ).bind(id, s.tallerId, s.tallerId, 'venta', clienteId, fecha, d.condicion, d.observaciones, d.idem_key, s.usuarioId, deposito, ...valoresTotales(d, t)),
    ...sentenciasItems(c.env.DB, 'venta_items', 'venta_id', s.tallerId, id, items, t.subtotales, alicuotas),
    // Costo vigente al emitir: el comprobante conserva su rentabilidad aunque el costo cambie después.
    c.env.DB.prepare("UPDATE venta_items SET costo_unitario = (SELECT a.costo FROM articulos a WHERE a.taller_id = venta_items.taller_id AND a.id = venta_items.articulo_id) WHERE taller_id = ? AND venta_id = ? AND tipo = 'articulo'").bind(s.tallerId, id),
    ...(lista ? [sentenciaListaEnDocumento(c.env.DB, 'ventas', s.tallerId, id, lista)] : []),
  ];
  for (const [articuloId, cant] of porArticulo) {
    stmts.push(
      ...sentenciasMovimiento(
        c.env.DB,
        s.tallerId,
        { articuloId, depositoId: deposito, delta: -cant, tipo: 'venta', origenTipo: 'venta', origenId: id, idemKey: `venta:${d.idem_key}:${articuloId}`, usuarioId: s.usuarioId },
        negativo,
      ),
    );
  }
  if (cobrar) {
    stmts.push(
      ...sentenciasCobro(c.env.DB, s, {
        id: uid(), clienteId, fecha, idemKey: `venta:${d.idem_key}`, notas: 'Cobro de venta de mostrador',
        medios: [medioDeCobroInmediato(d.cobro!, t.total)],
        aplicaciones: [{ ventaId: id, importe: t.total }],
      }),
    );
  }
  stmts.push(auditar(c.env.DB, s.tallerId, s.usuarioId, 'venta', id, 'crear', { total: t.total }));
  await c.env.DB.batch(stmts);
  return c.json(await first(c.env.DB, `${SELECT_VENTA} WHERE ve.taller_id = ? AND ve.id = ?`, s.tallerId, id), 201);
});

async function alicuotasItems(db: D1Database, tallerId: string, items: Array<{ tipo: string; articulo_id?: string | null }>): Promise<number[]> {
  const ids = [...new Set(items.map((i) => i.articulo_id).filter(Boolean) as string[])];
  const rows: Array<{ id: string; alicuota_iva: number }> = [];
  for (const lote of lotes(ids)) rows.push(...(await all<{ id: string; alicuota_iva: number }>(db, `SELECT id, alicuota_iva FROM articulos WHERE taller_id = ? AND id IN (${lote.map(() => '?').join(',')})`, tallerId, ...lote)));
  return items.map((i) => rows.find((r) => r.id === i.articulo_id)?.alicuota_iva ?? 21);
}

comercial.post('/ventas/:id/anular', requirePerm('ventas.anular'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const { motivo } = await body(c, z.object({ motivo: z.string().trim().min(3).max(300) }));
  const v = await first<{ estado: string; cobrado: number; orden_id: string | null; numero: number; deposito_id: string | null }>(
    c.env.DB,
    'SELECT estado, cobrado, orden_id, numero, deposito_id FROM ventas WHERE taller_id = ? AND id = ?',
    s.tallerId,
    id,
  );
  if (!v) throw notFound('Comprobante');
  if (v.estado !== 'emitida') throw conflict('El comprobante ya está anulado');
  if (v.cobrado > 0) throw conflict('El comprobante tiene cobros o saldo a favor aplicado. Anulá los cobros (o desaplicá el saldo a favor) primero.');
  if (await first(c.env.DB, "SELECT 1 FROM devoluciones WHERE taller_id = ? AND venta_id = ? AND estado = 'registrada'", s.tallerId, id)) {
    throw conflict('El comprobante tiene devoluciones registradas. Anulá las devoluciones primero.', 'tiene_devoluciones');
  }
  if (await first(c.env.DB, "SELECT 1 FROM comprobantes_fiscales WHERE taller_id = ? AND venta_id = ? AND estado = 'autorizado'", s.tallerId, id)) {
    throw conflict('El comprobante tiene una factura fiscal autorizada: requiere nota de crédito.');
  }
  const stmts: Stmt[] = [
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM ventas WHERE taller_id = ? AND id = ? AND estado = 'emitida' AND cobrado = 0 AND devuelto = 0)", s.tallerId, id),
    c.env.DB.prepare("UPDATE ventas SET estado = 'anulada', anulada_motivo = ? WHERE taller_id = ? AND id = ?").bind(motivo, s.tallerId, id),
  ];
  // Las ventas de mostrador devuelven el stock. Las ventas desde OT no movieron stock (lo movió la OT).
  if (!v.orden_id) {
    const items = await all<{ articulo_id: string | null; cantidad: number }>(c.env.DB, "SELECT articulo_id, cantidad FROM venta_items WHERE taller_id = ? AND venta_id = ? AND tipo = 'articulo'", s.tallerId, id);
    for (const [articuloId, cant] of agrupar(items)) {
      stmts.push(
        ...sentenciasMovimiento(
          c.env.DB,
          s.tallerId,
          { articuloId, depositoId: v.deposito_id, delta: cant, tipo: 'anulacion_venta', origenTipo: 'venta', origenId: id, idemKey: `anulacion_venta:${id}:${articuloId}`, notas: `Anulación comprobante #${v.numero}`, usuarioId: s.usuarioId },
          true,
        ),
      );
    }
  }
  stmts.push(auditar(c.env.DB, s.tallerId, s.usuarioId, 'venta', id, 'anular', { motivo }));
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

// ───────────── Cobros ─────────────
const zCobro = z.object({
  cliente_id: zId,
  fecha: zFecha.optional(),
  medios: z.array(z.object({ medio: z.enum(MEDIOS_PAGO), importe: zCentavos.refine((v) => v > 0, 'importe debe ser mayor a 0'), referencia: zTextoOpt(120), cuenta_id: zId.nullish(), cheque: zChequeDatos.partial().nullish() })).min(1).max(10),
  aplicaciones: z.array(z.object({ venta_id: zId, importe: zCentavos.refine((v) => v > 0, 'importe debe ser mayor a 0') })).min(1).max(50),
  notas: zTextoOpt(500),
  idem_key: z.string().min(8).max(80),
});

const SELECT_COBRO = `SELECT co.*, c.nombre AS cliente, c.codigo AS cliente_codigo, c.telefono AS cliente_telefono, c.documento AS cliente_documento, u.nombre AS usuario FROM cobros co
  JOIN clientes c ON c.taller_id = co.taller_id AND c.id = co.cliente_id
  LEFT JOIN usuarios u ON u.id = co.usuario_id AND u.taller_id = co.taller_id`;

comercial.get('/cobros', requirePerm('ventas.ver'), async (c) => {
  const s = c.get('sesion');
  const f = query(
    c,
    z.object({
      cliente_id: z.string().optional(), desde: z.string().optional(), hasta: z.string().optional(), estado: z.enum(['registrado', 'anulado']).optional(),
      medio: z.string().optional(), q: z.string().optional(), limite: z.coerce.number().int().min(1).max(500).default(300),
    }),
  );
  const cond = ['co.taller_id = ?'];
  const params: unknown[] = [s.tallerId];
  if (f.cliente_id) (cond.push('co.cliente_id = ?'), params.push(f.cliente_id));
  if (f.desde) (cond.push('co.fecha >= ?'), params.push(f.desde));
  if (f.hasta) (cond.push('co.fecha <= ?'), params.push(f.hasta));
  if (f.estado) (cond.push('co.estado = ?'), params.push(f.estado));
  if (f.medio) (cond.push('EXISTS (SELECT 1 FROM cobro_medios x WHERE x.taller_id = co.taller_id AND x.cobro_id = co.id AND x.medio = ?)'), params.push(f.medio));
  if (f.q) (cond.push('(c.nombre LIKE ? OR CAST(co.numero AS TEXT) = ?)'), params.push(like(f.q), f.q.replace(/\D/g, '')));
  const donde = cond.join(' AND ');
  // Los medios se leen con la misma condición (sin IN de ids): D1 limita las consultas a 100 parámetros.
  const [cobros, medios] = await Promise.all([
    all<{ id: string }>(c.env.DB, `${SELECT_COBRO} WHERE ${donde} ORDER BY co.numero DESC LIMIT ?`, ...params, f.limite),
    all<{ cobro_id: string }>(
      c.env.DB,
      `SELECT cm.cobro_id, cm.medio, cm.importe, cm.referencia FROM cobro_medios cm
         WHERE cm.taller_id = ? AND cm.cobro_id IN (SELECT co.id FROM cobros co JOIN clientes c ON c.taller_id = co.taller_id AND c.id = co.cliente_id WHERE ${donde} ORDER BY co.numero DESC LIMIT ?)`,
      s.tallerId, ...params, f.limite,
    ),
  ]);
  return c.json(cobros.map((co) => ({ ...co, medios: medios.filter((m) => m.cobro_id === co.id) })));
});

comercial.get('/cobros/:id', requirePerm('ventas.ver'), async (c) => {
  const s = c.get('sesion');
  const co = await first<{ id: string }>(c.env.DB, `${SELECT_COBRO} WHERE co.taller_id = ? AND co.id = ?`, s.tallerId, c.req.param('id'));
  if (!co) throw notFound('Cobro');
  const medios = await all(c.env.DB, 'SELECT medio, importe, referencia FROM cobro_medios WHERE taller_id = ? AND cobro_id = ?', s.tallerId, co.id);
  const aplicaciones = await all(
    c.env.DB,
    `SELECT ca.venta_id, ca.importe, ve.numero, ve.total, ve.cobrado, ve.fecha, o.numero AS orden_numero FROM cobro_aplicaciones ca
       JOIN ventas ve ON ve.taller_id = ca.taller_id AND ve.id = ca.venta_id LEFT JOIN ordenes o ON o.taller_id = ve.taller_id AND o.id = ve.orden_id
      WHERE ca.taller_id = ? AND ca.cobro_id = ? ORDER BY ve.numero`,
    s.tallerId,
    co.id,
  );
  return c.json({ ...co, medios, aplicaciones });
});

/**
 * Registra un cobro aplicado a uno o más comprobantes.
 * Protección contra duplicados: idem_key única por taller (un doble clic o reintento devuelve el cobro ya registrado)
 * y CHECK (cobrado <= total) en ventas: es imposible cobrar más que el saldo, incluso con solicitudes concurrentes.
 * El ingreso de caja se escribe en el mismo batch (ver lib/cobros.ts).
 */
comercial.post('/cobros', requirePerm('cobros.registrar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zCobro);
  const previo = await first(c.env.DB, 'SELECT id, numero FROM cobros WHERE taller_id = ? AND idem_key = ?', s.tallerId, d.idem_key);
  if (previo) return c.json({ ...previo, duplicado: true }, 200);

  const total = d.medios.reduce((a, m) => a + m.importe, 0);
  const aplicado = d.aplicaciones.reduce((a, m) => a + m.importe, 0);
  if (total !== aplicado) throw badRequest('La suma de los medios de pago debe coincidir con el importe aplicado a los comprobantes');
  await validarMediosCobro(c.env.DB, s.tallerId, d.medios.map((m) => ({ medio: m.medio, importe: m.importe, referencia: m.referencia, cuentaId: m.cuenta_id, cheque: m.cheque })));
  const ventaIds = d.aplicaciones.map((a) => a.venta_id);
  if (new Set(ventaIds).size !== ventaIds.length) throw badRequest('Un comprobante aparece más de una vez');
  if (!(await first(c.env.DB, 'SELECT 1 FROM clientes WHERE taller_id = ? AND id = ?', s.tallerId, d.cliente_id))) throw badRequest('Cliente inexistente');
  const fecha = fechaComercial(s, d.fecha);
  type FilaVenta = { id: string; cliente_id: string; estado: string; total: number; cobrado: number; devuelto: number; numero: number; fecha: string };
  const ventas: FilaVenta[] = [];
  for (const lote of lotes(ventaIds)) {
    ventas.push(
      ...(await all<FilaVenta>(
        c.env.DB,
        `SELECT id, cliente_id, estado, total, cobrado, devuelto, numero, fecha FROM ventas WHERE taller_id = ? AND id IN (${lote.map(() => '?').join(',')})`,
        s.tallerId,
        ...lote,
      )),
    );
  }
  if (ventas.length !== ventaIds.length) throw badRequest('Hay comprobantes inexistentes');
  for (const a of d.aplicaciones) {
    const v = ventas.find((x) => x.id === a.venta_id)!;
    if (v.cliente_id !== d.cliente_id) throw badRequest(`El comprobante #${v.numero} no pertenece al cliente`);
    if (v.estado !== 'emitida') throw conflict(`El comprobante #${v.numero} está anulado`);
    if (fecha < v.fecha) throw badRequest(`El cobro no puede ser anterior al comprobante #${v.numero} (${v.fecha})`);
    if (a.importe > v.total - v.devuelto - v.cobrado) throw conflict(`El importe supera el saldo del comprobante #${v.numero} (${(v.total - v.devuelto - v.cobrado) / 100})`, 'saldo_excedido');
  }
  await exigirCajaAbiertaSiCorresponde(c.env.DB, s.tallerId);
  const id = uid();
  try {
    await c.env.DB.batch(
      sentenciasCobro(c.env.DB, s, {
        id, clienteId: d.cliente_id, fecha, notas: d.notas, idemKey: d.idem_key,
        medios: d.medios.map((m) => ({ medio: m.medio, importe: m.importe, referencia: m.referencia, cuentaId: m.cuenta_id ?? null, cheque: m.cheque ?? null })),
        aplicaciones: d.aplicaciones.map((a) => ({ ventaId: a.venta_id, importe: a.importe })),
      }),
    );
  } catch (e) {
    // Carrera con un reintento idéntico: devolver el cobro existente.
    if (String(e).includes('idem_key')) {
      const ex = await first(c.env.DB, 'SELECT id, numero FROM cobros WHERE taller_id = ? AND idem_key = ?', s.tallerId, d.idem_key);
      if (ex) return c.json({ ...ex, duplicado: true }, 200);
    }
    throw e;
  }
  return c.json(await first(c.env.DB, 'SELECT id, numero, total FROM cobros WHERE taller_id = ? AND id = ?', s.tallerId, id), 201);
});

comercial.post('/cobros/:id/anular', requirePerm('cobros.anular'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const { motivo } = await body(c, z.object({ motivo: z.string().trim().min(3).max(300) }));
  const co = await first<{ estado: string; tipo: string; credito_aplicado: number; devuelto: number }>(c.env.DB, 'SELECT estado, tipo, credito_aplicado, devuelto FROM cobros WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!co) throw notFound('Cobro');
  if (co.estado !== 'registrado') throw conflict('El cobro ya está anulado');
  // Un anticipo ya aplicado a un comprobante o devuelto en dinero no se puede anular: primero hay que deshacer esas operaciones.
  if (co.tipo === 'anticipo' && (co.credito_aplicado > 0 || co.devuelto > 0)) {
    throw conflict('El anticipo ya se aplicó a un comprobante o se devolvió en dinero. Deshacé esas operaciones antes de anularlo.', 'anticipo_en_uso');
  }
  await exigirCajaAbiertaSiCorresponde(c.env.DB, s.tallerId);
  const bloqueo = await chequesBloqueanAnulacion(c.env.DB, s.tallerId, "origen_tipo = 'cobro_medio' AND origen_id IN (SELECT id FROM cobro_medios WHERE taller_id = cheques.taller_id AND cobro_id = ?)", [id]);
  if (bloqueo) throw conflict(bloqueo, 'cheque_comprometido');
  const aps = await all<{ venta_id: string; importe: number }>(c.env.DB, 'SELECT venta_id, importe FROM cobro_aplicaciones WHERE taller_id = ? AND cobro_id = ?', s.tallerId, id);
  // Con devoluciones registradas, lo cobrado del comprobante ya fue reasignado: primero se anulan las devoluciones.
  const conDevoluciones = aps.length
    ? await first<{ numero: number }>(
        c.env.DB,
        `SELECT ve.numero FROM cobro_aplicaciones ca JOIN ventas ve ON ve.taller_id = ca.taller_id AND ve.id = ca.venta_id WHERE ca.taller_id = ? AND ca.cobro_id = ? AND ve.devuelto > 0 LIMIT 1`,
        s.tallerId, id,
      )
    : null;
  if (conDevoluciones) throw conflict(`El comprobante #${conDevoluciones.numero} tiene devoluciones registradas. Anulá las devoluciones antes de anular este cobro.`, 'tiene_devoluciones');
  await c.env.DB.batch([
    guardCajaObligatoria(c.env.DB, s.tallerId),
    guard(c.env.DB, 'EXISTS (SELECT 1 FROM cobros WHERE taller_id = ? AND id = ? AND (credito_aplicado > 0 OR devuelto > 0))', s.tallerId, id),
    guard(c.env.DB, 'EXISTS (SELECT 1 FROM cobro_aplicaciones ca JOIN ventas ve ON ve.taller_id = ca.taller_id AND ve.id = ca.venta_id WHERE ca.taller_id = ? AND ca.cobro_id = ? AND ve.devuelto > 0)', s.tallerId, id),
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM cobros WHERE taller_id = ? AND id = ? AND estado = 'registrado')", s.tallerId, id),
    c.env.DB.prepare("UPDATE cobros SET estado = 'anulado', anulado_motivo = ? WHERE taller_id = ? AND id = ?").bind(motivo, s.tallerId, id),
    ...aps.map((a) => c.env.DB.prepare('UPDATE ventas SET cobrado = cobrado - ? WHERE taller_id = ? AND id = ?').bind(a.importe, s.tallerId, a.venta_id)),
    // El dinero devuelto sale de la caja abierta de hoy (contra-asiento): la caja histórica no se reescribe.
    reversoDeCobro(c.env.DB, s.tallerId, id, s.usuarioId),
    reversoBancoDeCobro(c.env.DB, s.tallerId, id, s.usuarioId),
    ...sentenciasAnularChequesDeCobro(c.env.DB, s.tallerId, id, s.usuarioId, hoy()),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'cobro', id, 'anular', { motivo }),
  ]);
  return c.json({ ok: true });
});

/// ───────────── Cuentas corrientes ─────────────
/**
 * Saldos por cliente con antigüedad de la deuda (días desde la fecha del comprobante).
 *  saldo   = deuda pendiente de los comprobantes vigentes (ya descontadas las devoluciones y lo cobrado)
 *  a_favor = saldo a favor del cliente (anticipos sin aplicar y crédito de devoluciones sin reintegrar ni aplicar)
 * estado: con_deuda (por defecto) | vencidas (deuda de más de 30 días) | al_dia (sin deuda, con movimientos) | a_favor | todos.
 */
comercial.get('/cuentas-corrientes', requirePerm('ventas.ver'), async (c) => {
  const s = c.get('sesion');
  const f = query(c, z.object({ q: z.string().optional(), estado: z.enum(['con_deuda', 'vencidas', 'al_dia', 'a_favor', 'todos']).default('con_deuda') }));
  const cond = ['c.taller_id = ?'];
  const params: unknown[] = [s.tallerId, s.tallerId];
  if (f.q) (cond.push('(c.nombre LIKE ? OR c.documento LIKE ? OR c.telefono LIKE ?)'), params.push(like(f.q), like(f.q), like(f.q)));
  const dias = "(julianday(date('now', '-3 hours')) - julianday(ve.fecha))";
  const donde =
    f.estado === 'con_deuda' ? 'x.saldo > 0'
    : f.estado === 'vencidas' ? 'x.v_30 + x.v_60 + x.v_90 > 0'
    : f.estado === 'al_dia' ? 'x.saldo = 0 AND x.comprobantes > 0'
    : f.estado === 'a_favor' ? 'x.a_favor > 0'
    : '(x.comprobantes > 0 OR x.a_favor > 0)';
  return c.json(
    await all(
      c.env.DB,
      `SELECT * FROM (
         SELECT c.id, c.codigo, c.nombre, c.telefono, COALESCE(v.facturado, 0) AS facturado, COALESCE(v.cobrado, 0) AS cobrado, COALESCE(v.devuelto, 0) AS devuelto, COALESCE(v.saldo, 0) AS saldo,
                COALESCE(v.comprobantes, 0) AS comprobantes, COALESCE(v.pendientes, 0) AS pendientes, v.deuda_desde,
                COALESCE(v.v_0, 0) AS v_0, COALESCE(v.v_30, 0) AS v_30, COALESCE(v.v_60, 0) AS v_60, COALESCE(v.v_90, 0) AS v_90,
                ${credito_cliente_sql('c')} AS a_favor
           FROM clientes c
           LEFT JOIN (
             SELECT ve.cliente_id, SUM(ve.total) AS facturado, SUM(ve.cobrado) AS cobrado, SUM(ve.devuelto) AS devuelto, SUM(ve.total - ve.devuelto - ve.cobrado) AS saldo,
                    COUNT(*) AS comprobantes, SUM(ve.cobrado + ve.devuelto < ve.total) AS pendientes,
                    MIN(CASE WHEN ve.cobrado + ve.devuelto < ve.total THEN ve.fecha END) AS deuda_desde,
                    SUM(CASE WHEN ${dias} <= 30 THEN ve.total - ve.devuelto - ve.cobrado ELSE 0 END) AS v_0,
                    SUM(CASE WHEN ${dias} > 30 AND ${dias} <= 60 THEN ve.total - ve.devuelto - ve.cobrado ELSE 0 END) AS v_30,
                    SUM(CASE WHEN ${dias} > 60 AND ${dias} <= 90 THEN ve.total - ve.devuelto - ve.cobrado ELSE 0 END) AS v_60,
                    SUM(CASE WHEN ${dias} > 90 THEN ve.total - ve.devuelto - ve.cobrado ELSE 0 END) AS v_90
               FROM ventas ve WHERE ve.taller_id = ? AND ve.estado = 'emitida' GROUP BY ve.cliente_id
           ) v ON v.cliente_id = c.id
          WHERE ${cond.join(' AND ')}
       ) x WHERE ${donde} ORDER BY x.saldo DESC, x.a_favor DESC, x.nombre COLLATE NOCASE LIMIT 500`,
      params[1], params[0], ...params.slice(2),
    ),
  );
});

/**
 * Control de consistencia de las cuentas corrientes de clientes. Devuelve las diferencias (vacío = todo en orden):
 *  * lo cobrado de un comprobante = cobros aplicados + saldo a favor aplicado − lo liberado por devoluciones; lo devuelto = suma de sus devoluciones vigentes;
 *  * cada cobro cierra contra sus medios y (los cobros comunes) contra lo aplicado;
 *  * cada anticipo y cada devolución cierran contra sus aplicaciones y reintegros vigentes.
 */
comercial.get('/cuentas-corrientes/verificar', requirePerm('ventas.ver', 'finanzas.ver'), async (c) => {
  const s = c.get('sesion');
  const APLICADO_COBROS = `COALESCE((SELECT SUM(ca.importe) FROM cobro_aplicaciones ca JOIN cobros co ON co.taller_id = ca.taller_id AND co.id = ca.cobro_id
                       WHERE ca.taller_id = ve.taller_id AND ca.venta_id = ve.id AND co.estado = 'registrado'), 0)`;
  const APLICADO_CREDITOS = "COALESCE((SELECT SUM(x.importe) FROM credito_aplicaciones x WHERE x.taller_id = ve.taller_id AND x.venta_id = ve.id AND x.estado = 'vigente'), 0)";
  const LIBERADO = "COALESCE((SELECT SUM(d.liberado) FROM devoluciones d WHERE d.taller_id = ve.taller_id AND d.venta_id = ve.id AND d.estado = 'registrada'), 0)";
  const DEVUELTO = "COALESCE((SELECT SUM(d.total) FROM devoluciones d WHERE d.taller_id = ve.taller_id AND d.venta_id = ve.id AND d.estado = 'registrada'), 0)";
  const comprobantes = await all(
    c.env.DB,
    `SELECT ve.id, ve.numero, ve.total, ve.cobrado, ve.devuelto, ${APLICADO_COBROS} + ${APLICADO_CREDITOS} - ${LIBERADO} AS aplicado, ${DEVUELTO} AS devuelto_real
       FROM ventas ve WHERE ve.taller_id = ? AND ve.estado = 'emitida'
        AND (ve.cobrado <> ${APLICADO_COBROS} + ${APLICADO_CREDITOS} - ${LIBERADO} OR ve.devuelto <> ${DEVUELTO} OR ve.cobrado + ve.devuelto > ve.total) LIMIT 200`,
    s.tallerId,
  );
  const cobros = await all(
    c.env.DB,
    `SELECT co.id, co.numero, co.total, COALESCE((SELECT SUM(ca.importe) FROM cobro_aplicaciones ca WHERE ca.taller_id = co.taller_id AND ca.cobro_id = co.id), 0) AS aplicado
       FROM cobros co WHERE co.taller_id = ? AND co.estado = 'registrado' AND co.tipo = 'cobro'
        AND co.total <> COALESCE((SELECT SUM(ca.importe) FROM cobro_aplicaciones ca WHERE ca.taller_id = co.taller_id AND ca.cobro_id = co.id), 0) LIMIT 200`,
    s.tallerId,
  );
  const medios = await all(
    c.env.DB,
    `SELECT co.id, co.numero, co.total, COALESCE((SELECT SUM(cm.importe) FROM cobro_medios cm WHERE cm.taller_id = co.taller_id AND cm.cobro_id = co.id), 0) AS medios
       FROM cobros co WHERE co.taller_id = ? AND co.estado = 'registrado'
        AND co.total <> COALESCE((SELECT SUM(cm.importe) FROM cobro_medios cm WHERE cm.taller_id = co.taller_id AND cm.cobro_id = co.id), 0) LIMIT 200`,
    s.tallerId,
  );
  const anticipos = await all(
    c.env.DB,
    `SELECT co.id, co.numero, co.total, co.credito_aplicado, co.devuelto,
            COALESCE((SELECT SUM(x.importe) FROM credito_aplicaciones x WHERE x.taller_id = co.taller_id AND x.origen_tipo = 'anticipo' AND x.origen_id = co.id AND x.estado = 'vigente'), 0) AS aplicado_real,
            COALESCE((SELECT SUM(r.total) FROM reintegros r WHERE r.taller_id = co.taller_id AND r.origen_tipo = 'anticipo' AND r.origen_id = co.id AND r.estado = 'registrado'), 0) AS devuelto_real
       FROM cobros co WHERE co.taller_id = ? AND co.tipo = 'anticipo' AND co.estado = 'registrado'
        AND (co.credito_aplicado <> COALESCE((SELECT SUM(x.importe) FROM credito_aplicaciones x WHERE x.taller_id = co.taller_id AND x.origen_tipo = 'anticipo' AND x.origen_id = co.id AND x.estado = 'vigente'), 0)
          OR co.devuelto <> COALESCE((SELECT SUM(r.total) FROM reintegros r WHERE r.taller_id = co.taller_id AND r.origen_tipo = 'anticipo' AND r.origen_id = co.id AND r.estado = 'registrado'), 0)) LIMIT 200`,
    s.tallerId,
  );
  const devoluciones = await all(
    c.env.DB,
    `SELECT d.id, d.numero, d.total, d.credito_aplicado, d.reintegrado,
            COALESCE((SELECT SUM(x.importe) FROM credito_aplicaciones x WHERE x.taller_id = d.taller_id AND x.origen_tipo = 'devolucion' AND x.origen_id = d.id AND x.estado = 'vigente'), 0) AS aplicado_real,
            COALESCE((SELECT SUM(r.total) FROM reintegros r WHERE r.taller_id = d.taller_id AND r.origen_tipo = 'devolucion' AND r.origen_id = d.id AND r.estado = 'registrado'), 0) AS reintegrado_real,
            COALESCE((SELECT SUM(i.importe) FROM devolucion_items i WHERE i.taller_id = d.taller_id AND i.devolucion_id = d.id), 0) AS items
       FROM devoluciones d WHERE d.taller_id = ? AND d.estado = 'registrada'
        AND (d.credito_aplicado <> COALESCE((SELECT SUM(x.importe) FROM credito_aplicaciones x WHERE x.taller_id = d.taller_id AND x.origen_tipo = 'devolucion' AND x.origen_id = d.id AND x.estado = 'vigente'), 0)
          OR d.reintegrado <> COALESCE((SELECT SUM(r.total) FROM reintegros r WHERE r.taller_id = d.taller_id AND r.origen_tipo = 'devolucion' AND r.origen_id = d.id AND r.estado = 'registrado'), 0)
          OR d.total <> COALESCE((SELECT SUM(i.importe) FROM devolucion_items i WHERE i.taller_id = d.taller_id AND i.devolucion_id = d.id), 0)) LIMIT 200`,
    s.tallerId,
  );
  return c.json({
    ok: !comprobantes.length && !cobros.length && !medios.length && !anticipos.length && !devoluciones.length,
    comprobantes_con_diferencia: comprobantes, cobros_sin_cuadrar: cobros, cobros_con_medios_distintos: medios, anticipos_con_diferencia: anticipos, devoluciones_con_diferencia: devoluciones,
  });
});

comercial.get('/cuentas-corrientes/:clienteId', requirePerm('ventas.ver'), async (c) => {
  const s = c.get('sesion');
  const clienteId = c.req.param('clienteId');
  const { desde } = query(c, z.object({ desde: zFecha.optional() }));
  const cli = await first(c.env.DB, 'SELECT id, codigo, nombre, telefono, documento, email FROM clientes WHERE taller_id = ? AND id = ?', s.tallerId, clienteId);
  if (!cli) throw notFound('Cliente');
  // Debe: comprobantes y reintegros de dinero. Haber: cobros (los anticipos incluidos) y devoluciones. Saldo negativo = a favor del cliente.
  const movs = await all<{ fecha: string; debe: number; haber: number }>(
    c.env.DB,
    `SELECT fecha, created_at, 'venta' AS tipo, id, numero, total AS debe, 0 AS haber, NULL AS detalle FROM ventas WHERE taller_id = ? AND cliente_id = ? AND estado = 'emitida'
     UNION ALL
     SELECT fecha, created_at, CASE tipo WHEN 'anticipo' THEN 'anticipo' ELSE 'cobro' END AS tipo, id, numero, 0 AS debe, total AS haber, notas AS detalle FROM cobros WHERE taller_id = ? AND cliente_id = ? AND estado = 'registrado'
     UNION ALL
     SELECT fecha, created_at, 'devolucion' AS tipo, id, numero, 0 AS debe, total AS haber, motivo AS detalle FROM devoluciones WHERE taller_id = ? AND cliente_id = ? AND estado = 'registrada'
     UNION ALL
     SELECT fecha, created_at, 'reintegro' AS tipo, id, numero, total AS debe, 0 AS haber, motivo AS detalle FROM reintegros WHERE taller_id = ? AND cliente_id = ? AND estado = 'registrado'
     ORDER BY fecha, created_at`,
    s.tallerId, clienteId, s.tallerId, clienteId, s.tallerId, clienteId, s.tallerId, clienteId,
  );
  let saldo = 0;
  const todos = movs.map((m) => ((saldo += m.debe - m.haber), { ...m, saldo }));
  // Con "desde", el estado de cuenta arranca con el saldo anterior (lo que se arrastra de antes de esa fecha).
  const saldoAnterior = desde ? ([...todos].reverse().find((m) => m.fecha < desde)?.saldo ?? 0) : 0;
  const conSaldo = desde ? todos.filter((m) => m.fecha >= desde) : todos;
  const pendientes = await all<{ saldo: number }>(c.env.DB, `${SELECT_VENTA} WHERE ve.taller_id = ? AND ve.cliente_id = ? AND ve.estado = 'emitida' AND ve.cobrado + ve.devuelto < ve.total ORDER BY ve.fecha`, s.tallerId, clienteId);
  const creditos = await creditosDisponibles(c.env.DB, s.tallerId, clienteId);
  // Historial de pagos del cliente, incluidos los anulados (con sus medios).
  const cobros = await all<{ id: string }>(c.env.DB, `${SELECT_COBRO} WHERE co.taller_id = ? AND co.cliente_id = ? ORDER BY co.numero DESC LIMIT 200`, s.tallerId, clienteId);
  const medios = await all<{ cobro_id: string }>(
    c.env.DB,
    `SELECT cm.cobro_id, cm.medio, cm.importe, cm.referencia FROM cobro_medios cm
      WHERE cm.taller_id = ? AND cm.cobro_id IN (SELECT id FROM cobros WHERE taller_id = ? AND cliente_id = ? ORDER BY numero DESC LIMIT 200)`,
    s.tallerId, s.tallerId, clienteId,
  );
  return c.json({
    cliente: cli, desde: desde ?? null, saldo_anterior: saldoAnterior, movimientos: conSaldo, saldo, pendientes, creditos,
    deuda: pendientes.reduce((a, v) => a + v.saldo, 0), a_favor: creditos.reduce((a, x) => a + x.disponible, 0),
    cobros: cobros.map((co) => ({ ...co, medios: medios.filter((m) => m.cobro_id === co.id) })),
  });
});
