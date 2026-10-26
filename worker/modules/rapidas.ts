// Consulta rápida de precios y operaciones rápidas (consumo de repuestos en una OT, bajas internas e historial).
//
// Nada de esto es un sistema paralelo: la consulta lee los artículos, las listas y las existencias reales; el consumo de OT agrega ítems a la orden
// (el stock lo descuenta la OT, una sola vez, al quedar «lista»); la baja interna genera movimientos de stock manuales (con el asiento de
// «diferencias de inventario» que ya existe); y la venta rápida es una venta común (POST /ventas) cuya clave de idempotencia empieza con «rapida:».
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, conflict, notFound, query, traducirErrorDb, zCantidad, zId, zTextoOpt } from '../lib/http';
import { all, auditar, first, hoy, like, lotes, SEQ_VALOR, seqIncrementar, uid, guard, type Stmt } from '../lib/db';
import { requireAny, requirePerm, tiene } from '../lib/auth';
import { exigirValorizado, puedeCosto, puedePrecioVenta, puedeValorizados } from '../lib/privacidad';
import { agrupar, permiteNegativo, resolverDeposito, sentenciasMovimiento, verificarDisponible } from '../lib/stock';
import { precioArticuloEnLista, type ReglaLista } from '../../shared/precios';
import { calcularTotales } from '../../shared/totals';
import { ESTADOS_OT_EDITABLES, ESTADO_OT_LABEL, MOTIVO_AJUSTE_LABEL, redondearCantidad as r3, type EstadoOT } from '../../shared/dominio';
import { MOTIVOS_BAJA } from '../../shared/rapidas';

export const rapidas = new Hono<AppEnv>();

const MAX_RESULTADOS = 25;

// ───────────── Consulta de precios ─────────────
/** Palabras de la búsqueda: todas deben aparecer (en el nombre, la marca, el SKU o el código de barras). */
function palabras(q: string): string[] {
  return q.trim().split(/\s+/).filter(Boolean).slice(0, 5).map((p) => p.slice(0, 40));
}

rapidas.get('/rapidas/consulta-precios', requirePerm('catalogo.ver'), async (c) => {
  const s = c.get('sesion');
  const f = query(c, z.object({ q: z.string().max(120).default(''), lista_id: z.string().max(64).optional(), limite: z.coerce.number().int().min(1).max(50).default(MAX_RESULTADOS) }));
  const verPrecio = puedePrecioVenta(s);
  const verStock = tiene(s, 'stock.ver');
  const verCosto = puedeCosto(s);
  let lista: (ReglaLista & { id: string; nombre: string }) | null = null;
  if (f.lista_id && verPrecio) {
    lista = await first<ReglaLista & { id: string; nombre: string }>(c.env.DB, 'SELECT id, nombre, base, porcentaje, redondeo, servicios_pct FROM listas_precios WHERE taller_id = ? AND id = ? AND activa = 1', s.tallerId, f.lista_id);
    if (!lista) throw badRequest('Lista de precios inexistente o desactivada');
  }
  const q = f.q.trim();
  if (!q) return c.json({ items: [], lista: lista ? { id: lista.id, nombre: lista.nombre } : null, hay_mas: false });
  const cond = ['a.taller_id = ?', 'a.activo = 1'];
  const params: unknown[] = [s.tallerId];
  for (const p of palabras(q)) {
    cond.push('(a.nombre LIKE ? OR a.marca LIKE ? OR a.codigo LIKE ? OR a.codigo_barras LIKE ?)');
    params.push(like(p), like(p), like(p), like(p));
  }
  const filas = await all<any>(
    c.env.DB,
    `SELECT a.id, a.codigo, a.codigo_barras, a.nombre, a.marca, a.unidad, a.stock, a.stock_minimo, a.precio, a.costo, ca.nombre AS categoria${lista ? ', li.precio AS precio_fijo' : ''}
       FROM articulos a
       LEFT JOIN categorias_articulo ca ON ca.taller_id = a.taller_id AND ca.id = a.categoria_id
       ${lista ? 'LEFT JOIN lista_precio_items li ON li.taller_id = a.taller_id AND li.articulo_id = a.id AND li.lista_id = ?' : ''}
      WHERE ${cond.join(' AND ')}
      ORDER BY (a.codigo_barras = ? OR a.codigo = ?) DESC, (a.nombre LIKE ?) DESC, a.nombre COLLATE NOCASE LIMIT ?`,
    ...(lista ? [lista.id] : []), ...params, q, q, `${q.replace(/[%_]/g, '')}%`, f.limite + 1,
  );
  const hayMas = filas.length > f.limite;
  const pagina = filas.slice(0, f.limite);
  // Existencias por depósito (sólo con más de un depósito activo): la misma fuente que el resto del sistema.
  const porDeposito = new Map<string, Array<{ deposito: string; stock: number }>>();
  if (verStock && pagina.length) {
    const deps = await first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM depositos WHERE taller_id = ? AND activo = 1', s.tallerId);
    if ((deps?.n ?? 0) > 1) {
      for (const lote of lotes(pagina.map((a) => a.id))) {
        const rows = await all<{ articulo_id: string; deposito: string; stock: number }>(
          c.env.DB,
          `SELECT sd.articulo_id, d.nombre AS deposito, sd.stock FROM stock_depositos sd JOIN depositos d ON d.taller_id = sd.taller_id AND d.id = sd.deposito_id
            WHERE sd.taller_id = ? AND d.activo = 1 AND ROUND(sd.stock, 3) <> 0 AND sd.articulo_id IN (${lote.map(() => '?').join(',')}) ORDER BY d.es_principal DESC, d.nombre`,
          s.tallerId, ...lote,
        );
        for (const r of rows) porDeposito.set(r.articulo_id, [...(porDeposito.get(r.articulo_id) ?? []), { deposito: r.deposito, stock: r3(r.stock) }]);
      }
    }
  }
  const items = pagina.map((a) => {
    const o: Record<string, unknown> = { id: a.id, codigo: a.codigo, codigo_barras: a.codigo_barras, nombre: a.nombre, marca: a.marca, unidad: a.unidad, categoria: a.categoria };
    if (verStock) Object.assign(o, { stock: r3(a.stock), stock_minimo: a.stock_minimo, stock_bajo: r3(a.stock) <= a.stock_minimo, depositos: porDeposito.get(a.id) ?? [] });
    if (verPrecio) {
      // Un artículo sin precio configurado se informa como tal: nunca se muestra un 0 como si fuera un precio ni se inventa uno.
      const precio = lista ? precioArticuloEnLista(lista, a, a.precio_fijo ?? null).precio : a.precio;
      Object.assign(o, { precio: precio > 0 ? precio : null, sin_precio: !(precio > 0), precio_origen: lista ? (a.precio_fijo != null ? 'fijo' : 'regla') : 'base' });
    }
    if (verCosto) o.costo = a.costo;
    return o;
  });
  return c.json({ items, lista: lista ? { id: lista.id, nombre: lista.nombre } : null, hay_mas: hayMas });
});

// ───────────── Datos comunes de una operación (idempotencia) ─────────────
interface OperacionPrevia { id: string; numero: number; tipo: string; orden_id: string | null }
const previaPorClave = (db: D1Database, tallerId: string, clave: string) =>
  first<OperacionPrevia>(db, 'SELECT id, numero, tipo, orden_id FROM operaciones_rapidas WHERE taller_id = ? AND idem_key = ?', tallerId, clave);

const zLineas = z.array(z.object({ articulo_id: zId, cantidad: zCantidad })).min(1, 'agregá al menos un artículo').max(50);

/** Une las líneas repetidas de un mismo artículo (escanear dos veces el mismo código suma una unidad, no duplica la línea). */
function unir(lineas: Array<{ articulo_id: string; cantidad: number }>): Array<{ articulo_id: string; cantidad: number }> {
  const m = agrupar(lineas);
  return [...m].map(([articulo_id, cantidad]) => ({ articulo_id, cantidad }));
}

async function articulosDe(db: D1Database, tallerId: string, ids: string[]) {
  const filas: Array<{ id: string; nombre: string; costo: number; precio: number; activo: number; unidad: string }> = [];
  for (const lote of lotes(ids)) filas.push(...(await all<any>(db, `SELECT id, nombre, costo, precio, activo, unidad FROM articulos WHERE taller_id = ? AND id IN (${lote.map(() => '?').join(',')})`, tallerId, ...lote)));
  if (filas.length !== ids.length) throw badRequest('Hay artículos inexistentes');
  const inactivo = filas.find((a) => !a.activo);
  if (inactivo) throw badRequest(`El artículo ${inactivo.nombre} está desactivado`);
  return filas;
}

// ───────────── Consumo de repuestos en una OT ─────────────
rapidas.post('/rapidas/consumo-ot', requirePerm('ordenes.modificar'), async (c) => {
  const s = c.get('sesion');
  // Agregar ítems con importes a una orden exige lo mismo que editarla: ver precios de venta y presupuestos valorizados.
  exigirValorizado(s);
  const d = await body(c, z.object({ orden_id: zId, items: zLineas, notas: zTextoOpt(300), idem_key: z.string().min(8).max(80) }));
  const clave = `consumo:${d.idem_key}`;
  const previa = await previaPorClave(c.env.DB, s.tallerId, clave);
  if (previa) {
    if (previa.tipo !== 'consumo_ot' || previa.orden_id !== d.orden_id) throw conflict('Esa clave de operación ya se usó para otra operación', 'duplicado');
    return c.json({ id: previa.id, numero: previa.numero, orden_id: previa.orden_id, duplicado: true });
  }
  const o = await first<{ estado: EstadoOT; version: number; stock_aplicado: number; deposito_id: string | null; numero: number; lista_precio_id: string | null; desc_global_pct: number; desc_global_monto: number; iva_pct: number; recargo_pct: number }>(
    c.env.DB,
    'SELECT estado, version, stock_aplicado, deposito_id, numero, lista_precio_id, desc_global_pct, desc_global_monto, iva_pct, recargo_pct FROM ordenes WHERE taller_id = ? AND id = ?',
    s.tallerId, d.orden_id,
  );
  if (!o) throw notFound('Orden de trabajo');
  // Mientras el stock no se descontó, los repuestos de la orden son una lista de ítems; al pasarla a «lista» se descuentan UNA vez.
  // Con la orden ya cerrada para el taller no se agregan repuestos por este camino: habría que descontarlos por separado y revertirlos a mano.
  if (!ESTADOS_OT_EDITABLES.includes(o.estado) || o.stock_aplicado) {
    throw conflict(`La orden #${o.numero} está en estado «${ESTADO_OT_LABEL[o.estado]}»: sus repuestos ya se descontaron del stock. Volvela a «En reparación» para agregar repuestos.`, 'orden_cerrada');
  }
  const lineas = unir(d.items);
  const arts = await articulosDe(c.env.DB, s.tallerId, lineas.map((l) => l.articulo_id));
  // Disponibilidad: lo que la orden ya tiene de esos artículos más lo que se agrega, contra el stock del depósito de la orden.
  const negativo = await permiteNegativo(c.env.DB, s.tallerId);
  const existentes = await all<{ articulo_id: string | null; cantidad: number }>(c.env.DB, "SELECT articulo_id, cantidad FROM orden_items WHERE taller_id = ? AND orden_id = ? AND tipo = 'articulo'", s.tallerId, d.orden_id);
  if (!negativo) {
    const yaEnOrden = agrupar(existentes);
    await verificarDisponible(c.env.DB, s.tallerId, new Map(lineas.map((l) => [l.articulo_id, r3(l.cantidad + (yaEnOrden.get(l.articulo_id) ?? 0))])), o.deposito_id);
  }
  // Precios: los de la lista de la orden (o el precio base), resueltos acá en el servidor. Sin precio configurado no se agrega nada.
  const regla = o.lista_precio_id
    ? await first<ReglaLista>(c.env.DB, 'SELECT base, porcentaje, redondeo, servicios_pct FROM listas_precios WHERE taller_id = ? AND id = ?', s.tallerId, o.lista_precio_id)
    : null;
  const fijos = new Map<string, number>();
  if (regla && o.lista_precio_id) {
    for (const lote of lotes(lineas.map((l) => l.articulo_id))) {
      for (const r of await all<{ articulo_id: string; precio: number }>(c.env.DB, `SELECT articulo_id, precio FROM lista_precio_items WHERE taller_id = ? AND lista_id = ? AND articulo_id IN (${lote.map(() => '?').join(',')})`, s.tallerId, o.lista_precio_id, ...lote)) fijos.set(r.articulo_id, r.precio);
    }
  }
  const nuevos = lineas.map((l) => {
    const a = arts.find((x) => x.id === l.articulo_id)!;
    const precio = regla ? precioArticuloEnLista(regla, a, fijos.get(a.id) ?? null).precio : a.precio;
    if (!(precio > 0)) throw badRequest(`${a.nombre} no tiene precio de venta configurado: cargalo en el artículo (o en la lista de la orden) antes de usarlo`);
    return { tipo: 'articulo' as const, articulo_id: a.id, descripcion: a.nombre, cantidad: l.cantidad, precio_unitario: precio, desc_pct: 0 };
  });
  const actuales = await all<{ tipo: 'articulo' | 'servicio' | 'libre'; cantidad: number; precio_unitario: number; desc_pct: number; orden: number }>(
    c.env.DB, 'SELECT tipo, cantidad, precio_unitario, desc_pct, orden FROM orden_items WHERE taller_id = ? AND orden_id = ? ORDER BY orden', s.tallerId, d.orden_id,
  );
  const t = calcularTotales([...actuales, ...nuevos], o);
  const base = actuales.length ? Math.max(...actuales.map((i) => i.orden)) + 1 : 0;
  const opId = uid();
  const stmts: Stmt[] = [
    // La orden no cambió desde que se leyó (estado, versión, stock): un reintento simultáneo o una edición ajena abortan todo el lote.
    guard(
      c.env.DB,
      `NOT EXISTS (SELECT 1 FROM ordenes WHERE taller_id = ? AND id = ? AND version = ? AND stock_aplicado = 0 AND estado IN (${ESTADOS_OT_EDITABLES.map(() => '?').join(',')}))`,
      s.tallerId, d.orden_id, o.version, ...ESTADOS_OT_EDITABLES,
    ),
    ...seqIncrementar(c.env.DB, s.tallerId, 'operacion_rapida'),
    c.env.DB
      .prepare(`INSERT INTO operaciones_rapidas (id, taller_id, numero, tipo, fecha, usuario_id, deposito_id, orden_id, notas, idem_key) VALUES (?, ?, ${SEQ_VALOR}, 'consumo_ot', ?, ?, ?, ?, ?, ?)`)
      .bind(opId, s.tallerId, s.tallerId, 'operacion_rapida', hoy(), s.usuarioId, o.deposito_id, d.orden_id, d.notas, clave),
    ...nuevos.map((n) =>
      c.env.DB
        .prepare('INSERT INTO operacion_rapida_items (id, taller_id, operacion_id, articulo_id, descripcion, cantidad) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(uid(), s.tallerId, opId, n.articulo_id, n.descripcion, n.cantidad),
    ),
    ...nuevos.map((n, i) =>
      c.env.DB
        .prepare('INSERT INTO orden_items (id, taller_id, orden_id, orden, tipo, articulo_id, descripcion, cantidad, precio_unitario, desc_pct, subtotal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)')
        .bind(uid(), s.tallerId, d.orden_id, base + i, n.tipo, n.articulo_id, n.descripcion, n.cantidad, n.precio_unitario, t.subtotales[actuales.length + i]),
    ),
    c.env.DB
      .prepare(
        `UPDATE ordenes SET subtotal_articulos = ?, subtotal_servicios = ?, descuento = ?, neto = ?, iva = ?, recargo = ?, total = ?, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE taller_id = ? AND id = ?`,
      )
      .bind(t.subtotal_articulos, t.subtotal_servicios, t.descuento, t.neto, t.iva, t.recargo, t.total, s.tallerId, d.orden_id),
    c.env.DB
      .prepare('INSERT INTO orden_notas (id, taller_id, orden_id, usuario_id, texto) VALUES (?, ?, ?, ?, ?)')
      .bind(uid(), s.tallerId, d.orden_id, s.usuarioId, `Repuestos agregados desde Operaciones rápidas: ${nuevos.map((n) => `${n.cantidad} × ${n.descripcion}`).join('; ')}`.slice(0, 1000)),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'operacion_rapida', opId, 'consumo_ot', { orden_id: d.orden_id, articulos: nuevos.length }),
  ];
  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    // Mismo reintento llegando dos veces a la vez: la segunda ve la operación ya registrada y devuelve la misma respuesta.
    const dup = await previaPorClave(c.env.DB, s.tallerId, clave);
    if (dup && dup.tipo === 'consumo_ot' && dup.orden_id === d.orden_id) return c.json({ id: dup.id, numero: dup.numero, orden_id: dup.orden_id, duplicado: true });
    throw traducirErrorDb(e) ?? e;
  }
  const op = await first<{ numero: number }>(c.env.DB, 'SELECT numero FROM operaciones_rapidas WHERE taller_id = ? AND id = ?', s.tallerId, opId);
  return c.json({ id: opId, numero: op?.numero, orden_id: d.orden_id, orden_numero: o.numero, agregados: nuevos.length, total_orden: puedeValorizados(s) ? t.total : undefined }, 201);
});

// ───────────── Baja interna de inventario ─────────────
rapidas.post('/rapidas/bajas', requirePerm('stock.ajustar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(
    c,
    z.object({
      deposito_id: zId.nullish(),
      motivo: z.enum(MOTIVOS_BAJA),
      notas: zTextoOpt(300),
      responsable: zTextoOpt(80),
      items: zLineas,
      idem_key: z.string().min(8).max(80),
    }),
  );
  if (d.motivo === 'otro' && (d.notas ?? '').trim().length < 3) throw badRequest('Con el motivo «otro» explicá qué pasó en las notas');
  const clave = `baja:${d.idem_key}`;
  const previa = await previaPorClave(c.env.DB, s.tallerId, clave);
  if (previa) {
    if (previa.tipo !== 'baja_interna') throw conflict('Esa clave de operación ya se usó para otra operación', 'duplicado');
    return c.json({ id: previa.id, numero: previa.numero, duplicado: true });
  }
  const deposito = await resolverDeposito(c.env.DB, s.tallerId, d.deposito_id);
  const lineas = unir(d.items);
  const arts = await articulosDe(c.env.DB, s.tallerId, lineas.map((l) => l.articulo_id));
  const negativo = await permiteNegativo(c.env.DB, s.tallerId);
  if (!negativo) await verificarDisponible(c.env.DB, s.tallerId, new Map(lineas.map((l) => [l.articulo_id, l.cantidad])), deposito);
  const opId = uid();
  const detalle = [`Baja interna (${MOTIVO_AJUSTE_LABEL[d.motivo]})`, d.responsable ? `resp.: ${d.responsable}` : '', d.notas ?? ''].filter(Boolean).join(' · ').slice(0, 300);
  const stmts: Stmt[] = [
    ...seqIncrementar(c.env.DB, s.tallerId, 'operacion_rapida'),
    c.env.DB
      .prepare(`INSERT INTO operaciones_rapidas (id, taller_id, numero, tipo, fecha, usuario_id, deposito_id, motivo, responsable, notas, idem_key) VALUES (?, ?, ${SEQ_VALOR}, 'baja_interna', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(opId, s.tallerId, s.tallerId, 'operacion_rapida', hoy(), s.usuarioId, deposito, d.motivo, d.responsable, d.notas, clave),
    ...lineas.map((l) =>
      c.env.DB
        .prepare('INSERT INTO operacion_rapida_items (id, taller_id, operacion_id, articulo_id, descripcion, cantidad) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(uid(), s.tallerId, opId, l.articulo_id, arts.find((a) => a.id === l.articulo_id)!.nombre, l.cantidad),
    ),
  ];
  // Cada artículo sale con un movimiento de stock manual (el mismo que usa el ajuste de inventario): atómico, con el costo vigente y su clave propia.
  // Sólo baja stock: no genera venta, cobro ni ingreso de caja.
  for (const l of lineas) {
    stmts.push(
      ...sentenciasMovimiento(
        c.env.DB, s.tallerId,
        { articuloId: l.articulo_id, depositoId: deposito, delta: -l.cantidad, tipo: 'salida', motivo: d.motivo, origenTipo: 'manual', origenId: opId, idemKey: `rapida:${d.idem_key}:${l.articulo_id}`, notas: detalle, usuarioId: s.usuarioId },
        negativo,
      ),
    );
  }
  stmts.push(auditar(c.env.DB, s.tallerId, s.usuarioId, 'operacion_rapida', opId, 'baja_interna', { motivo: d.motivo, articulos: lineas.length }));
  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    const dup = await previaPorClave(c.env.DB, s.tallerId, clave);
    if (dup && dup.tipo === 'baja_interna') return c.json({ id: dup.id, numero: dup.numero, duplicado: true });
    throw traducirErrorDb(e) ?? e;
  }
  const op = await first<{ numero: number }>(c.env.DB, 'SELECT numero FROM operaciones_rapidas WHERE taller_id = ? AND id = ?', s.tallerId, opId);
  return c.json({ id: opId, numero: op?.numero, articulos: lineas.length, unidades: r3(lineas.reduce((a, l) => a + l.cantidad, 0)) }, 201);
});

// ───────────── Historial de operaciones recientes ─────────────
rapidas.get('/rapidas/historial', requireAny('ventas.ver', 'stock.ver', 'ordenes.ver'), async (c) => {
  const s = c.get('sesion');
  const { limite } = query(c, z.object({ limite: z.coerce.number().int().min(1).max(100).default(30) }));
  const tipos = [tiene(s, 'ordenes.ver') && 'consumo_ot', tiene(s, 'stock.ver') && 'baja_interna'].filter(Boolean) as string[];
  const ops = tipos.length
    ? await all<any>(
        c.env.DB,
        `SELECT op.id, op.numero, op.tipo, op.fecha, op.created_at, op.motivo, op.responsable, op.notas, op.orden_id, o.numero AS orden_numero, u.nombre AS usuario, dep.nombre AS deposito,
                (SELECT COUNT(*) FROM operacion_rapida_items i WHERE i.taller_id = op.taller_id AND i.operacion_id = op.id) AS articulos,
                (SELECT COALESCE(SUM(i.cantidad), 0) FROM operacion_rapida_items i WHERE i.taller_id = op.taller_id AND i.operacion_id = op.id) AS unidades
           FROM operaciones_rapidas op
           LEFT JOIN ordenes o ON o.taller_id = op.taller_id AND o.id = op.orden_id
           LEFT JOIN usuarios u ON u.taller_id = op.taller_id AND u.id = op.usuario_id
           LEFT JOIN depositos dep ON dep.taller_id = op.taller_id AND dep.id = COALESCE(op.deposito_id, (SELECT id FROM depositos WHERE taller_id = op.taller_id AND es_principal = 1))
          WHERE op.taller_id = ? AND op.tipo IN (${tipos.map(() => '?').join(',')}) ORDER BY op.created_at DESC LIMIT ?`,
        s.tallerId, ...tipos, limite,
      )
    : [];
  const ventas = tiene(s, 'ventas.ver')
    ? await all<any>(
        c.env.DB,
        `SELECT ve.id, ve.numero, ve.fecha, ve.created_at, ve.total, ve.estado, ve.condicion, ve.cobrado, u.nombre AS usuario${tiene(s, 'clientes.ver') ? ', c.nombre AS cliente' : ''},
                (SELECT COUNT(*) FROM venta_items vi WHERE vi.taller_id = ve.taller_id AND vi.venta_id = ve.id) AS articulos
           FROM ventas ve JOIN clientes c ON c.taller_id = ve.taller_id AND c.id = ve.cliente_id
           LEFT JOIN usuarios u ON u.taller_id = ve.taller_id AND u.id = ve.created_by
          WHERE ve.taller_id = ? AND ve.idem_key LIKE 'rapida:%' ORDER BY ve.created_at DESC LIMIT ?`,
        s.tallerId, limite,
      )
    : [];
  const verImportes = puedeValorizados(s);
  const filas = [
    ...ops.map((o) => ({ ...o, usuario: o.usuario ?? null })),
    ...ventas.map((v) => ({ id: v.id, tipo: 'venta', numero: v.numero, fecha: v.fecha, created_at: v.created_at, usuario: v.usuario ?? null, cliente: v.cliente, articulos: v.articulos, estado: v.estado, condicion: v.condicion, ...(verImportes ? { total: v.total } : {}) })),
  ]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, limite);
  return c.json(filas);
});
