// Devoluciones parciales de ventas: nota de crédito comercial INTERNA (no fiscal).
//
// Reglas:
//  * Nace siempre de un comprobante y de sus ítems; nunca modifica el comprobante original (solo `ventas.devuelto` y, si corresponde, `ventas.cobrado`).
//  * No se puede devolver más de lo vendido: cantidades e importes acumulados por línea se controlan al calcular y de nuevo DENTRO del batch (guards),
//    así que dos devoluciones simultáneas de la misma línea no la exceden.
//  * La mercadería vuelve al inventario solo si se indica (`reingresa`) y al depósito elegido, con el costo histórico con el que se vendió.
//  * Lo devuelto se reparte en: deuda impaga que se cancela (`a_deuda`) y lo que el cliente ya había pagado (`liberado`), que se reintegra por los medios de pago
//    elegidos y/o queda como saldo a favor aplicable a otro comprobante.
//  * Todo ocurre en un único batch con clave de idempotencia: un reintento no duplica stock ni dinero.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, conflict, notFound, query, zCantidad, zCentavos, zFecha, zId } from '../lib/http';
import { all, auditar, first, guard, like, lotes, SEQ_VALOR, seqIncrementar, uid, type Stmt } from '../lib/db';
import { requirePerm, tiene } from '../lib/auth';
import { exigirCajaAbiertaSiCorresponde, guardCajaObligatoria } from '../lib/caja';
import { fechaComercial } from '../lib/fechas';
import { puedeCosto } from '../lib/privacidad';
import { aMedioReintegro, sentenciasReintegro, sentenciasReversoReintegro, validarMediosReintegro, zMedioReintegro, type MedioReintegro } from '../lib/reintegros';
import { creditosDisponibles } from '../lib/creditos';
import { permiteNegativo, resolverDeposito, sentenciasMovimiento, verificarDisponible } from '../lib/stock';
import { calcularLinea, repartoDeuda, valoresPorLinea } from '../../shared/devoluciones';
import { redondearCantidad as r3 } from '../../shared/dominio';

export const devoluciones = new Hono<AppEnv>();

// ───────────── Cálculo (compartido por la simulación y el registro) ─────────────
const zEntrada = z.object({
  venta_id: zId,
  fecha: zFecha.optional(),
  motivo: z.string().trim().min(3, 'indicá el motivo').max(300),
  items: z
    .array(
      z.object({
        venta_item_id: zId,
        cantidad: zCantidad,
        /** Importe a acreditar de la línea (centavos). Sin indicar: proporcional a lo pagado. */
        importe: zCentavos.nullish(),
        /** ¿La mercadería vuelve físicamente al inventario? Solo para artículos. Por defecto no. */
        reingresa: z.boolean().default(false),
        deposito_id: zId.nullish(),
      }),
    )
    .min(1, 'elegí al menos una línea')
    .max(100),
  /** Dinero que se devuelve al cliente ahora (el resto de lo ya pagado queda como saldo a favor). */
  reintegro: z.object({ medios: z.array(zMedioReintegro).min(1).max(10) }).nullish(),
});
type Entrada = z.infer<typeof zEntrada>;

interface LineaPreparada {
  id: string;
  venta_item_id: string;
  tipo: 'articulo' | 'servicio' | 'libre';
  articulo_id: string | null;
  servicio_id: string | null;
  descripcion: string;
  cantidad: number;
  subtotal: number;
  importe: number;
  importe_neto: number;
  valor_origen: number;
  costo_unitario: number | null;
  reingresa: boolean;
  deposito_id: string | null;
  deposito: string | null;
  restante_cantidad: number;
}

async function preparar(db: D1Database, s: { tallerId: string; usuarioId: string }, d: Entrada, fecha: string, estricto = true) {
  const venta = await first<{ id: string; numero: number; cliente_id: string; estado: string; fecha: string; total: number; iva: number; cobrado: number; devuelto: number; orden_id: string | null }>(
    db, 'SELECT id, numero, cliente_id, estado, fecha, total, iva, cobrado, devuelto, orden_id FROM ventas WHERE taller_id = ? AND id = ?', s.tallerId, d.venta_id,
  );
  if (!venta) throw notFound('Comprobante');
  if (venta.estado !== 'emitida') throw conflict(`El comprobante #${venta.numero} está anulado`);
  if (fecha < venta.fecha) throw badRequest(`La devolución no puede ser anterior al comprobante (${venta.fecha})`);
  const cliente = (await first<{ codigo: number; nombre: string }>(db, 'SELECT codigo, nombre FROM clientes WHERE taller_id = ? AND id = ?', s.tallerId, venta.cliente_id))!;
  const origen = await all<{ id: string; tipo: 'articulo' | 'servicio' | 'libre'; articulo_id: string | null; servicio_id: string | null; descripcion: string; cantidad: number; subtotal: number; costo_unitario: number | null }>(
    db, 'SELECT id, tipo, articulo_id, servicio_id, descripcion, cantidad, subtotal, costo_unitario FROM venta_items WHERE taller_id = ? AND venta_id = ? ORDER BY orden', s.tallerId, venta.id,
  );
  const previos = await all<{ venta_item_id: string; cantidad: number; importe: number; subtotal: number }>(
    db,
    `SELECT di.venta_item_id, SUM(di.cantidad) AS cantidad, SUM(di.importe) AS importe, SUM(di.subtotal) AS subtotal
       FROM devolucion_items di JOIN devoluciones dv ON dv.taller_id = di.taller_id AND dv.id = di.devolucion_id
      WHERE di.taller_id = ? AND dv.venta_id = ? AND dv.estado = 'registrada' GROUP BY di.venta_item_id`,
    s.tallerId, venta.id,
  );
  const valores = valoresPorLinea(venta, origen);
  const ids = d.items.map((i) => i.venta_item_id);
  if (new Set(ids).size !== ids.length) throw badRequest('Una línea del comprobante aparece más de una vez');
  const lineas: LineaPreparada[] = [];
  const avisos: string[] = [];
  const faltaCosto: string[] = [];
  const depNombres = new Map<string, string>();
  for (const dep of await all<{ id: string; nombre: string }>(db, 'SELECT id, nombre FROM depositos WHERE taller_id = ?', s.tallerId)) depNombres.set(dep.id, dep.nombre);
  const principal = (await first<{ id: string }>(db, 'SELECT id FROM depositos WHERE taller_id = ? AND es_principal = 1', s.tallerId))?.id ?? null;
  for (const it of d.items) {
    const idx = origen.findIndex((o) => o.id === it.venta_item_id);
    if (idx < 0) throw badRequest('Hay líneas que no pertenecen al comprobante');
    const o = origen[idx];
    const p = previos.find((x) => x.venta_item_id === o.id) ?? { cantidad: 0, importe: 0, subtotal: 0 };
    const r = calcularLinea({ cantidad: o.cantidad, subtotal: o.subtotal, valor: valores.valor[idx], iva: valores.iva[idx] }, p, it.cantidad, it.importe ?? null);
    if ('error' in r) throw badRequest(`${o.descripcion}: ${r.error}`);
    if (it.reingresa && o.tipo !== 'articulo') throw badRequest(`${o.descripcion}: solo los artículos vuelven al inventario`);
    let deposito: string | null = null;
    if (it.reingresa) deposito = await resolverDeposito(db, s.tallerId, it.deposito_id);
    if (it.reingresa && o.costo_unitario == null) faltaCosto.push(o.descripcion);
    lineas.push({
      id: uid(), venta_item_id: o.id, tipo: o.tipo, articulo_id: o.articulo_id, servicio_id: o.servicio_id, descripcion: o.descripcion,
      cantidad: r.cantidad, subtotal: r.subtotal, importe: r.importe, importe_neto: r.importe_neto, valor_origen: valores.valor[idx], costo_unitario: o.costo_unitario,
      reingresa: it.reingresa, deposito_id: deposito, deposito: it.reingresa ? depNombres.get(deposito ?? principal ?? '') ?? null : null, restante_cantidad: r.restante_cantidad,
    });
  }
  if (faltaCosto.length) {
    // Comprobantes anteriores a la función de costo histórico: el reingreso usa el costo actual del artículo.
    avisos.push(`Sin costo histórico (comprobante anterior): ${faltaCosto.join(', ')}. El reingreso al inventario se registra con el costo actual del artículo.`);
    const arts = lineas.filter((l) => l.reingresa && l.costo_unitario == null && l.articulo_id);
    for (const grupo of lotes(arts.map((l) => l.articulo_id!))) {
      const filas = await all<{ id: string; costo: number }>(db, `SELECT id, costo FROM articulos WHERE taller_id = ? AND id IN (${grupo.map(() => '?').join(',')})`, s.tallerId, ...grupo);
      for (const l of arts) l.costo_unitario ??= filas.find((f) => f.id === l.articulo_id)?.costo ?? 0;
    }
  }
  const total = lineas.reduce((a, l) => a + l.importe, 0);
  if (total <= 0) throw badRequest('El importe de la devolución debe ser mayor a 0');
  const iva = lineas.reduce((a, l) => a + (l.importe - l.importe_neto), 0);
  const saldo = venta.total - venta.devuelto - venta.cobrado;
  const { a_deuda, liberado } = repartoDeuda(total, saldo);
  const medios: MedioReintegro[] = d.reintegro ? d.reintegro.medios.map(aMedioReintegro) : [];
  const reintegro = medios.reduce((a, m) => a + m.importe, 0);
  if (reintegro > liberado) {
    throw badRequest(liberado === 0 ? 'Esta devolución solo cancela deuda del comprobante: no hay dinero ya cobrado para reintegrar' : `Solo se puede reintegrar hasta ${(liberado / 100).toFixed(2)} (lo que el cliente ya había pagado)`);
  }
  const consumidorFinal = cliente.codigo === 0;
  if (estricto && consumidorFinal && reintegro !== liberado) {
    throw badRequest('Consumidor final no tiene cuenta corriente: el dinero ya cobrado se debe reintegrar por completo');
  }
  const aFavor = liberado - reintegro;
  if (venta.orden_id) {
    avisos.push('Comprobante de una orden de trabajo: los repuestos se descontaron del stock cuando la orden pasó a "Lista para entregar"; al reingresarlos vuelven al depósito que elijas. Devolver mano de obra no cambia los tiempos ya registrados.');
  }
  return { venta, cliente, lineas, total, neto: total - iva, iva, a_deuda, liberado, reintegro, medios, aFavor, consumidorFinal, avisos };
}

type Preparada = Awaited<ReturnType<typeof preparar>>;

/** Consecuencias para mostrar antes de confirmar: stock, dinero, comprobante y cuenta corriente. */
async function consecuencias(db: D1Database, tallerId: string, p: Preparada, verCosto: boolean) {
  const deuda = (await first<{ v: number }>(db, "SELECT COALESCE(SUM(total - devuelto - cobrado), 0) AS v FROM ventas WHERE taller_id = ? AND cliente_id = ? AND estado = 'emitida'", tallerId, p.venta.cliente_id))?.v ?? 0;
  const aFavorAntes = (await creditosDisponibles(db, tallerId, p.venta.cliente_id)).reduce((a, x) => a + x.disponible, 0);
  const saldoAntes = deuda - aFavorAntes;
  const saldoDespues = saldoAntes - p.total + p.reintegro;
  const articulos = p.lineas.filter((l) => l.tipo === 'articulo');
  return {
    comprobante: {
      numero: p.venta.numero, total: p.venta.total, cobrado_antes: p.venta.cobrado, cobrado_despues: p.venta.cobrado - p.liberado, devuelto_antes: p.venta.devuelto, devuelto_despues: p.venta.devuelto + p.total,
      saldo_antes: p.venta.total - p.venta.devuelto - p.venta.cobrado, saldo_despues: p.venta.total - (p.venta.devuelto + p.total) - (p.venta.cobrado - p.liberado),
    },
    credito: { total: p.total, neto: p.neto, iva: p.iva, cancela_deuda: p.a_deuda, ya_pagado: p.liberado },
    dinero: { reintegro: p.reintegro, por_medio: p.medios.map((m) => ({ medio: m.medio, importe: m.importe })), saldo_a_favor: p.aFavor, sale_de_caja: p.medios.some((m) => m.medio === 'efectivo') },
    stock: {
      reingresan: p.lineas.filter((l) => l.reingresa).map((l) => ({ descripcion: l.descripcion, cantidad: l.cantidad, deposito: l.deposito ?? 'Depósito principal', ...(verCosto ? { costo_unitario: l.costo_unitario } : {}) })),
      no_reingresan: articulos.filter((l) => !l.reingresa).map((l) => ({ descripcion: l.descripcion, cantidad: l.cantidad })),
    },
    cuenta_corriente: { cliente: p.cliente.nombre, saldo_antes: saldoAntes, saldo_despues: saldoDespues, nota: saldoDespues < 0 ? 'El saldo negativo es saldo a favor del cliente.' : undefined },
    avisos: p.avisos,
    lineas: p.lineas.map(({ id: _id, ...l }) => (verCosto ? l : { ...l, costo_unitario: undefined })),
  };
}

// ───────────── Consultas ─────────────
const SELECT_DEV = `SELECT d.*, c.nombre AS cliente, ve.numero AS venta_numero, o.numero AS orden_numero, u.nombre AS usuario,
    (d.liberado - d.reintegrado - d.credito_aplicado) AS credito_disponible
  FROM devoluciones d
  JOIN clientes c ON c.taller_id = d.taller_id AND c.id = d.cliente_id
  JOIN ventas ve ON ve.taller_id = d.taller_id AND ve.id = d.venta_id
  LEFT JOIN ordenes o ON o.taller_id = d.taller_id AND o.id = d.orden_id
  LEFT JOIN usuarios u ON u.taller_id = d.taller_id AND u.id = d.usuario_id`;

devoluciones.get('/devoluciones', requirePerm('ventas.ver'), async (c) => {
  const s = c.get('sesion');
  const f = query(c, z.object({ cliente_id: z.string().optional(), venta_id: z.string().optional(), desde: z.string().optional(), hasta: z.string().optional(), estado: z.enum(['registrada', 'anulada']).optional(), q: z.string().optional() }));
  const cond = ['d.taller_id = ?'];
  const params: unknown[] = [s.tallerId];
  if (f.cliente_id) (cond.push('d.cliente_id = ?'), params.push(f.cliente_id));
  if (f.venta_id) (cond.push('d.venta_id = ?'), params.push(f.venta_id));
  if (f.desde) (cond.push('d.fecha >= ?'), params.push(f.desde));
  if (f.hasta) (cond.push('d.fecha <= ?'), params.push(f.hasta));
  if (f.estado) (cond.push('d.estado = ?'), params.push(f.estado));
  if (f.q) (cond.push('(c.nombre LIKE ? OR CAST(d.numero AS TEXT) = ? OR CAST(ve.numero AS TEXT) = ?)'), params.push(like(f.q), f.q.replace(/\D/g, ''), f.q.replace(/\D/g, '')));
  return c.json(await all(c.env.DB, `${SELECT_DEV} WHERE ${cond.join(' AND ')} ORDER BY d.numero DESC LIMIT 300`, ...params));
});

devoluciones.get('/devoluciones/:id', requirePerm('ventas.ver'), async (c) => {
  const s = c.get('sesion');
  const d = await first<Record<string, any>>(c.env.DB, `${SELECT_DEV} WHERE d.taller_id = ? AND d.id = ?`, s.tallerId, c.req.param('id'));
  if (!d) throw notFound('Devolución');
  const items = (
    await all<Record<string, unknown>>(
      c.env.DB,
      `SELECT di.*, dep.nombre AS deposito FROM devolucion_items di LEFT JOIN depositos dep ON dep.taller_id = di.taller_id AND dep.id = COALESCE(di.deposito_id, (SELECT id FROM depositos WHERE taller_id = di.taller_id AND es_principal = 1))
        WHERE di.taller_id = ? AND di.devolucion_id = ? ORDER BY di.rowid`,
      s.tallerId, d.id,
    )
  ).map((i) => (puedeCosto(s) ? i : { ...i, costo_unitario: undefined }));
  const [reintegros, aplicaciones] = await Promise.all([
    all(
      c.env.DB,
      `SELECT r.id, r.numero, r.fecha, r.total, r.estado, r.motivo, u.nombre AS usuario,
              (SELECT GROUP_CONCAT(DISTINCT rm.medio) FROM reintegro_medios rm WHERE rm.taller_id = r.taller_id AND rm.reintegro_id = r.id) AS medios
         FROM reintegros r LEFT JOIN usuarios u ON u.taller_id = r.taller_id AND u.id = r.usuario_id
        WHERE r.taller_id = ? AND r.origen_tipo = 'devolucion' AND r.origen_id = ? ORDER BY r.numero`,
      s.tallerId, d.id,
    ),
    all(
      c.env.DB,
      `SELECT ca.id, ca.importe, ca.fecha, ca.estado, ve.numero AS venta_numero, ca.venta_id FROM credito_aplicaciones ca JOIN ventas ve ON ve.taller_id = ca.taller_id AND ve.id = ca.venta_id
        WHERE ca.taller_id = ? AND ca.origen_tipo = 'devolucion' AND ca.origen_id = ? ORDER BY ca.created_at`,
      s.tallerId, d.id,
    ),
  ]);
  return c.json({ ...d, items, reintegros, aplicaciones });
});

/** Qué se puede devolver de un comprobante: por línea, lo vendido, lo ya devuelto y lo que queda (cantidad e importe). */
devoluciones.get('/ventas/:id/devolvible', requirePerm('ventas.ver'), async (c) => {
  const s = c.get('sesion');
  const v = await first<{ id: string; numero: number; cliente_id: string; estado: string; total: number; iva: number; cobrado: number; devuelto: number; orden_id: string | null; condicion: string }>(
    c.env.DB, 'SELECT id, numero, cliente_id, estado, total, iva, cobrado, devuelto, orden_id, condicion FROM ventas WHERE taller_id = ? AND id = ?', s.tallerId, c.req.param('id'),
  );
  if (!v) throw notFound('Comprobante');
  const cli = await first<{ codigo: number; nombre: string }>(c.env.DB, 'SELECT codigo, nombre FROM clientes WHERE taller_id = ? AND id = ?', s.tallerId, v.cliente_id);
  const items = await all<{ id: string; tipo: string; articulo_id: string | null; descripcion: string; cantidad: number; subtotal: number; costo_unitario: number | null }>(
    c.env.DB, 'SELECT id, tipo, articulo_id, descripcion, cantidad, subtotal, costo_unitario FROM venta_items WHERE taller_id = ? AND venta_id = ? ORDER BY orden', s.tallerId, v.id,
  );
  const previos = await all<{ venta_item_id: string; cantidad: number; importe: number }>(
    c.env.DB,
    `SELECT di.venta_item_id, SUM(di.cantidad) AS cantidad, SUM(di.importe) AS importe FROM devolucion_items di JOIN devoluciones dv ON dv.taller_id = di.taller_id AND dv.id = di.devolucion_id
      WHERE di.taller_id = ? AND dv.venta_id = ? AND dv.estado = 'registrada' GROUP BY di.venta_item_id`,
    s.tallerId, v.id,
  );
  const { valor } = valoresPorLinea(v, items);
  return c.json({
    venta: { id: v.id, numero: v.numero, estado: v.estado, total: v.total, cobrado: v.cobrado, devuelto: v.devuelto, saldo: v.total - v.devuelto - v.cobrado, orden_id: v.orden_id, condicion: v.condicion },
    cliente: { id: v.cliente_id, nombre: cli?.nombre, consumidor_final: cli?.codigo === 0 },
    lineas: items.map((i, k) => {
      const p = previos.find((x) => x.venta_item_id === i.id);
      return {
        venta_item_id: i.id, tipo: i.tipo, articulo_id: i.articulo_id, descripcion: i.descripcion, cantidad: i.cantidad, valor: valor[k],
        devuelta: p?.cantidad ?? 0, importe_devuelto: p?.importe ?? 0, restante: r3(i.cantidad - (p?.cantidad ?? 0)), importe_restante: valor[k] - (p?.importe ?? 0),
        ...(puedeCosto(s) ? { costo_unitario: i.costo_unitario } : {}),
      };
    }),
  });
});

// ───────────── Simulación y registro ─────────────
/** Muestra las consecuencias de la devolución (stock, dinero, comprobante y cuenta corriente) sin registrar nada. */
devoluciones.post('/devoluciones/simular', requirePerm('ventas.anular'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zEntrada);
  if (d.reintegro && !tiene(s, 'cobros.anular')) throw conflict('Para reintegrar dinero necesitás permiso para anular cobros', 'sin_permiso');
  const fecha = fechaComercial(s, d.fecha);
  const p = await preparar(c.env.DB, s, d, fecha, false);
  if (p.medios.length) await validarMediosReintegro(c.env.DB, s.tallerId, p.medios);
  return c.json(await consecuencias(c.env.DB, s.tallerId, p, puedeCosto(s)));
});

devoluciones.post('/devoluciones', requirePerm('ventas.anular'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zEntrada.extend({ idem_key: z.string().min(8).max(80) }));
  const previa = await first(c.env.DB, `${SELECT_DEV} WHERE d.taller_id = ? AND d.idem_key = ?`, s.tallerId, d.idem_key);
  if (previa) return c.json({ ...previa, duplicado: true }, 200);
  if (d.reintegro && !tiene(s, 'cobros.anular')) throw conflict('Para reintegrar dinero necesitás permiso para anular cobros', 'sin_permiso');
  const fecha = fechaComercial(s, d.fecha);
  const p = await preparar(c.env.DB, s, d, fecha);
  if (p.medios.length) {
    await validarMediosReintegro(c.env.DB, s.tallerId, p.medios);
    await exigirCajaAbiertaSiCorresponde(c.env.DB, s.tallerId);
  }
  const negativo = await permiteNegativo(c.env.DB, s.tallerId);
  void negativo; // el reingreso suma stock: no depende de la configuración de stock negativo
  const id = uid();
  const T = s.tallerId;
  const stmts: Stmt[] = [
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM ventas WHERE taller_id = ? AND id = ? AND estado = 'emitida')", T, p.venta.id),
    ...(p.medios.length ? [guardCajaObligatoria(c.env.DB, T)] : []),
    ...seqIncrementar(c.env.DB, T, 'devolucion'),
    // a_deuda / liberado se calculan dentro de la transacción con el saldo real del comprobante (un cobro simultáneo no los desfasa).
    c.env.DB
      .prepare(
        `INSERT INTO devoluciones (id, taller_id, numero, venta_id, cliente_id, orden_id, fecha, motivo, total, neto, iva, a_deuda, liberado, idem_key, usuario_id)
         SELECT ?, ve.taller_id, ${SEQ_VALOR}, ve.id, ve.cliente_id, ve.orden_id, ?, ?, ?, ?, ?,
                MAX(0, MIN(?, ve.total - ve.devuelto - ve.cobrado)), ? - MAX(0, MIN(?, ve.total - ve.devuelto - ve.cobrado)), ?, ?
           FROM ventas ve WHERE ve.taller_id = ? AND ve.id = ? AND ve.estado = 'emitida'`,
      )
      .bind(id, T, 'devolucion', fecha, d.motivo, p.total, p.neto, p.iva, p.total, p.total, p.total, d.idem_key, s.usuarioId, T, p.venta.id),
    ...p.lineas.map((l) =>
      c.env.DB
        .prepare(
          `INSERT INTO devolucion_items (id, taller_id, devolucion_id, venta_item_id, tipo, articulo_id, servicio_id, descripcion, cantidad, subtotal, importe, importe_neto, valor_origen, costo_unitario, reingresa, deposito_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(l.id, T, id, l.venta_item_id, l.tipo, l.articulo_id, l.servicio_id, l.descripcion, l.cantidad, l.subtotal, l.importe, l.importe_neto, l.valor_origen, l.costo_unitario, l.reingresa ? 1 : 0, l.deposito_id),
    ),
    // No se devuelve más de lo vendido, ni en cantidad ni en importe, aunque otra devolución de la misma línea se haya registrado en el medio.
    guard(
      c.env.DB,
      `EXISTS (SELECT 1 FROM venta_items vi WHERE vi.taller_id = ? AND vi.venta_id = ? AND ROUND(COALESCE((SELECT SUM(di.cantidad) FROM devolucion_items di JOIN devoluciones dv ON dv.taller_id = di.taller_id AND dv.id = di.devolucion_id
                WHERE di.taller_id = vi.taller_id AND di.venta_item_id = vi.id AND dv.estado = 'registrada'), 0), 3) > ROUND(vi.cantidad, 3))`,
      T, p.venta.id,
    ),
    guard(
      c.env.DB,
      `EXISTS (SELECT 1 FROM devolucion_items di JOIN devoluciones dv ON dv.taller_id = di.taller_id AND dv.id = di.devolucion_id
                WHERE di.taller_id = ? AND dv.venta_id = ? AND dv.estado = 'registrada' GROUP BY di.venta_item_id HAVING SUM(di.importe) > MAX(di.valor_origen))`,
      T, p.venta.id,
    ),
    // Comprobante: suma lo devuelto y libera lo ya pagado (CHECK cobrado + devuelto <= total).
    c.env.DB
      .prepare('UPDATE ventas SET devuelto = devuelto + (SELECT total FROM devoluciones WHERE taller_id = ? AND id = ?), cobrado = cobrado - (SELECT liberado FROM devoluciones WHERE taller_id = ? AND id = ?) WHERE taller_id = ? AND id = ?')
      .bind(T, id, T, id, T, p.venta.id),
  ];
  // Stock: solo lo que el usuario indicó que vuelve físicamente, al depósito elegido y con el costo con el que se vendió.
  for (const l of p.lineas.filter((x) => x.reingresa && x.articulo_id)) {
    stmts.push(
      ...sentenciasMovimiento(
        c.env.DB, T,
        { articuloId: l.articulo_id!, depositoId: l.deposito_id, delta: l.cantidad, tipo: 'entrada', origenTipo: 'devolucion', origenId: id, idemKey: `devolucion:${id}:${l.id}`, costoUnitario: l.costo_unitario, notas: `Devolución del comprobante #${p.venta.numero}`, usuarioId: s.usuarioId },
        true,
      ),
    );
  }
  if (p.medios.length) {
    const rid = uid();
    stmts.push(
      ...sentenciasReintegro(c.env.DB, s, { id: rid, clienteId: p.venta.cliente_id, origenTipo: 'devolucion', origenId: id, fecha, medios: p.medios, motivo: `Devolución: ${d.motivo}`, idemKey: `${d.idem_key}:reintegro` }),
      // CHECK (reintegrado + credito_aplicado <= liberado): jamás se reintegra más de lo ya cobrado.
      c.env.DB.prepare('UPDATE devoluciones SET reintegrado = ? WHERE taller_id = ? AND id = ?').bind(p.reintegro, T, id),
    );
  }
  // Consumidor final no tiene cuenta corriente: lo cobrado debe salir íntegramente en dinero.
  if (p.consumidorFinal) stmts.push(guard(c.env.DB, 'EXISTS (SELECT 1 FROM devoluciones WHERE taller_id = ? AND id = ? AND liberado <> reintegrado)', T, id));
  stmts.push(auditar(c.env.DB, T, s.usuarioId, 'devolucion', id, 'crear', { venta_id: p.venta.id, total: p.total, reintegro: p.reintegro, a_favor: p.aFavor, motivo: d.motivo }));
  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    // Carrera con un reintento idéntico: devolver la devolución ya registrada.
    if (String(e).includes('idem_key')) {
      const ex = await first(c.env.DB, `${SELECT_DEV} WHERE d.taller_id = ? AND d.idem_key = ?`, T, d.idem_key);
      if (ex) return c.json({ ...ex, duplicado: true }, 200);
    }
    throw e;
  }
  return c.json(await first(c.env.DB, `${SELECT_DEV} WHERE d.taller_id = ? AND d.id = ?`, T, id), 201);
});

// ───────────── Anulación ─────────────
/**
 * Anula una devolución: el comprobante recupera lo devuelto y la mercadería reingresada vuelve a salir del depósito. No se borra nada.
 * Solo si todavía no se reintegró dinero ni se usó el saldo a favor (hay que deshacer eso primero).
 */
devoluciones.post('/devoluciones/:id/anular', requirePerm('ventas.anular'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const { motivo } = await body(c, z.object({ motivo: z.string().trim().min(3).max(300) }));
  const d = await first<{ estado: string; venta_id: string; total: number; liberado: number; reintegrado: number; credito_aplicado: number; numero: number }>(
    c.env.DB, 'SELECT estado, venta_id, total, liberado, reintegrado, credito_aplicado, numero FROM devoluciones WHERE taller_id = ? AND id = ?', s.tallerId, id,
  );
  if (!d) throw notFound('Devolución');
  if (d.estado !== 'registrada') throw conflict('La devolución ya está anulada');
  if (d.reintegrado > 0) throw conflict('Se reintegró dinero al cliente: anulá primero el reintegro.', 'tiene_reintegro');
  if (d.credito_aplicado > 0) throw conflict('El saldo a favor de esta devolución ya se aplicó a otro comprobante: deshacé esa aplicación primero.', 'credito_en_uso');
  const items = await all<{ id: string; articulo_id: string; cantidad: number; deposito_id: string | null }>(
    c.env.DB, 'SELECT id, articulo_id, cantidad, deposito_id FROM devolucion_items WHERE taller_id = ? AND devolucion_id = ? AND reingresa = 1 AND articulo_id IS NOT NULL', s.tallerId, id,
  );
  const negativo = await permiteNegativo(c.env.DB, s.tallerId);
  // La mercadería reingresada tiene que seguir estando para poder sacarla de nuevo.
  if (!negativo) {
    const porDeposito = new Map<string | null, Map<string, number>>();
    for (const i of items) {
      const m = porDeposito.get(i.deposito_id) ?? new Map<string, number>();
      m.set(i.articulo_id, r3((m.get(i.articulo_id) ?? 0) + i.cantidad));
      porDeposito.set(i.deposito_id, m);
    }
    for (const [dep, salidas] of porDeposito) await verificarDisponible(c.env.DB, s.tallerId, salidas, dep);
  }
  const stmts: Stmt[] = [
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM devoluciones WHERE taller_id = ? AND id = ? AND estado = 'registrada' AND reintegrado = 0 AND credito_aplicado = 0)", s.tallerId, id),
    c.env.DB.prepare("UPDATE devoluciones SET estado = 'anulada', anulada_motivo = ?, anulada_por = ?, anulada_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ? AND id = ?").bind(motivo, s.usuarioId, s.tallerId, id),
    // Inversa de la creación: baja lo devuelto y devuelve al comprobante lo que se había liberado (CHECK cobrado + devuelto <= total).
    c.env.DB.prepare('UPDATE ventas SET devuelto = devuelto - ?, cobrado = cobrado + ? WHERE taller_id = ? AND id = ?').bind(d.total, d.liberado, s.tallerId, d.venta_id),
  ];
  for (const i of items) {
    stmts.push(
      ...sentenciasMovimiento(
        c.env.DB, s.tallerId,
        { articuloId: i.articulo_id, depositoId: i.deposito_id, delta: -i.cantidad, tipo: 'salida', origenTipo: 'devolucion', origenId: id, idemKey: `anulacion_devolucion:${id}:${i.id}`, notas: `Anulación de la devolución #${d.numero}`, motivo: 'otro', usuarioId: s.usuarioId },
        negativo,
      ),
    );
  }
  stmts.push(auditar(c.env.DB, s.tallerId, s.usuarioId, 'devolucion', id, 'anular', { motivo }));
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

// ───────────── Reintegros ─────────────
/** Reintegra dinero de una devolución cuyo crédito quedó a favor del cliente. */
devoluciones.post('/devoluciones/:id/reintegrar', requirePerm('cobros.anular'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, z.object({ medios: z.array(zMedioReintegro).min(1).max(10), fecha: zFecha.optional(), idem_key: z.string().min(8).max(80) }));
  const previo = await first(c.env.DB, 'SELECT id, numero FROM reintegros WHERE taller_id = ? AND idem_key = ?', s.tallerId, d.idem_key);
  if (previo) return c.json({ ...previo, duplicado: true }, 200);
  const dv = await first<{ estado: string; cliente_id: string; liberado: number; reintegrado: number; credito_aplicado: number; fecha: string; numero: number }>(
    c.env.DB, 'SELECT estado, cliente_id, liberado, reintegrado, credito_aplicado, fecha, numero FROM devoluciones WHERE taller_id = ? AND id = ?', s.tallerId, id,
  );
  if (!dv) throw notFound('Devolución');
  if (dv.estado !== 'registrada') throw conflict('La devolución está anulada');
  const medios = d.medios.map(aMedioReintegro);
  const total = medios.reduce((a, m) => a + m.importe, 0);
  const disponible = dv.liberado - dv.reintegrado - dv.credito_aplicado;
  if (total > disponible) throw conflict(`El saldo a favor de la devolución es de ${(disponible / 100).toFixed(2)}`, 'credito_insuficiente');
  const fecha = fechaComercial(s, d.fecha);
  if (fecha < dv.fecha) throw badRequest('El reintegro no puede ser anterior a la devolución');
  await validarMediosReintegro(c.env.DB, s.tallerId, medios);
  await exigirCajaAbiertaSiCorresponde(c.env.DB, s.tallerId);
  const rid = uid();
  try {
    await c.env.DB.batch([
      guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM devoluciones WHERE taller_id = ? AND id = ? AND estado = 'registrada')", s.tallerId, id),
      ...sentenciasReintegro(c.env.DB, s, { id: rid, clienteId: dv.cliente_id, origenTipo: 'devolucion', origenId: id, fecha, medios, motivo: `Reintegro de la devolución #${dv.numero}`, idemKey: d.idem_key }),
      c.env.DB.prepare('UPDATE devoluciones SET reintegrado = reintegrado + ? WHERE taller_id = ? AND id = ?').bind(total, s.tallerId, id),
    ]);
  } catch (e) {
    if (String(e).includes('idem_key')) {
      const ex = await first(c.env.DB, 'SELECT id, numero FROM reintegros WHERE taller_id = ? AND idem_key = ?', s.tallerId, d.idem_key);
      if (ex) return c.json({ ...ex, duplicado: true }, 200);
    }
    throw e;
  }
  return c.json(await first(c.env.DB, 'SELECT id, numero, total FROM reintegros WHERE taller_id = ? AND id = ?', s.tallerId, rid), 201);
});

/** Anula un reintegro (de una devolución o de un anticipo): el dinero vuelve a la caja/cuenta con un contra-asiento y el saldo a favor se restablece. */
devoluciones.post('/reintegros/:id/anular', requirePerm('cobros.anular'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const { motivo } = await body(c, z.object({ motivo: z.string().trim().min(3).max(300) }));
  const r = await first<{ estado: string; total: number; origen_tipo: 'devolucion' | 'anticipo'; origen_id: string }>(c.env.DB, 'SELECT estado, total, origen_tipo, origen_id FROM reintegros WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!r) throw notFound('Reintegro');
  if (r.estado !== 'registrado') throw conflict('El reintegro ya está anulado');
  await exigirCajaAbiertaSiCorresponde(c.env.DB, s.tallerId);
  await c.env.DB.batch([
    guardCajaObligatoria(c.env.DB, s.tallerId),
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM reintegros WHERE taller_id = ? AND id = ? AND estado = 'registrado')", s.tallerId, id),
    c.env.DB.prepare("UPDATE reintegros SET estado = 'anulado', anulado_motivo = ? WHERE taller_id = ? AND id = ?").bind(motivo, s.tallerId, id),
    r.origen_tipo === 'devolucion'
      ? c.env.DB.prepare('UPDATE devoluciones SET reintegrado = reintegrado - ? WHERE taller_id = ? AND id = ?').bind(r.total, s.tallerId, r.origen_id)
      : c.env.DB.prepare('UPDATE cobros SET devuelto = devuelto - ? WHERE taller_id = ? AND id = ?').bind(r.total, s.tallerId, r.origen_id),
    ...sentenciasReversoReintegro(c.env.DB, s.tallerId, id, s.usuarioId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'reintegro', id, 'anular', { motivo, total: r.total }),
  ]);
  return c.json({ ok: true });
});
