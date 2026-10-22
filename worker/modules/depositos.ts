// Depósitos del taller, existencias por depósito y transferencias internas.
// Cada taller administra los suyos (nada que ver con los talleres del SaaS). `articulos.stock` es siempre la suma de los depósitos:
// todo movimiento pasa por worker/lib/stock.ts, que actualiza ambos en la misma transacción.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, conflict, notFound, query, zFecha, zId, zTextoOpt } from '../lib/http';
import { all, auditar, first, guard, like, SEQ_VALOR, seqIncrementar, uid, type Stmt } from '../lib/db';
import { requireAny, requirePerm, tiene } from '../lib/auth';
import { fechaComercial } from '../lib/fechas';
import { agrupar, resolverDeposito, sentenciasMovimiento, verificarDisponible } from '../lib/stock';
import { redondearCantidad as r3 } from '../../shared/dominio';
import { puedeCosto } from '../lib/privacidad';

export const depositos = new Hono<AppEnv>();

const zDeposito = z.object({ nombre: z.string().trim().min(2).max(80), notas: zTextoOpt(300) });

depositos.get('/depositos', requireAny('stock.ver', 'catalogo.ver'), async (c) => {
  const s = c.get('sesion');
  const conCosto = puedeCosto(s);
  const filas = await all<Record<string, unknown>>(
    c.env.DB,
    `SELECT d.id, d.nombre, d.es_principal, d.activo, d.notas,
            (SELECT COUNT(*) FROM stock_depositos sd WHERE sd.taller_id = d.taller_id AND sd.deposito_id = d.id AND sd.stock <> 0) AS articulos_con_stock,
            (SELECT COALESCE(SUM(sd.stock), 0) FROM stock_depositos sd WHERE sd.taller_id = d.taller_id AND sd.deposito_id = d.id) AS unidades,
            (SELECT COALESCE(SUM(sd.stock * a.costo), 0) FROM stock_depositos sd JOIN articulos a ON a.taller_id = sd.taller_id AND a.id = sd.articulo_id
              WHERE sd.taller_id = d.taller_id AND sd.deposito_id = d.id) AS valor_costo
       FROM depositos d WHERE d.taller_id = ? ORDER BY d.es_principal DESC, d.activo DESC, d.nombre`,
    s.tallerId,
  );
  return c.json(filas.map((f) => (conCosto && tiene(s, 'stock.valorizar') ? { ...f, valor_costo: Math.round(Number(f.valor_costo)) } : { ...f, valor_costo: undefined })));
});

depositos.post('/depositos', requirePerm('stock.ajustar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zDeposito);
  const id = uid();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO depositos (id, taller_id, nombre, notas) VALUES (?, ?, ?, ?)').bind(id, s.tallerId, d.nombre, d.notas),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'deposito', id, 'crear', { nombre: d.nombre }),
  ]);
  return c.json({ id }, 201);
});

depositos.put('/depositos/:id', requirePerm('stock.ajustar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, zDeposito.partial().extend({ activo: z.boolean().optional() }));
  const dep = await first<{ es_principal: number; activo: number }>(c.env.DB, 'SELECT es_principal, activo FROM depositos WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!dep) throw notFound('Depósito');
  if (d.activo === false) {
    if (dep.es_principal) throw conflict('El depósito principal no se puede desactivar');
    if (await first(c.env.DB, 'SELECT 1 FROM stock_depositos WHERE taller_id = ? AND deposito_id = ? AND stock <> 0', s.tallerId, id)) {
      throw conflict('El depósito todavía tiene mercadería: transferila a otro depósito antes de desactivarlo', 'deposito_con_stock');
    }
  }
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (d.nombre !== undefined) (sets.push('nombre = ?'), vals.push(d.nombre));
  if (d.notas !== undefined) (sets.push('notas = ?'), vals.push(d.notas));
  if (d.activo !== undefined) (sets.push('activo = ?'), vals.push(d.activo ? 1 : 0));
  if (!sets.length) return c.json({ ok: true });
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE depositos SET ${sets.join(', ')} WHERE taller_id = ? AND id = ?`).bind(...vals, s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'deposito', id, 'modificar', d),
  ]);
  return c.json({ ok: true });
});

/** Existencias de un depósito (con el valor al costo solo para quien puede ver costos y valorizar el inventario). */
depositos.get('/depositos/:id/stock', requirePerm('stock.ver'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const { q, todos } = query(c, z.object({ q: z.string().optional(), todos: z.string().optional() }));
  const dep = await first<{ id: string; nombre: string }>(c.env.DB, 'SELECT id, nombre FROM depositos WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!dep) throw notFound('Depósito');
  const cond = ['a.taller_id = ?', 'a.activo = 1'];
  const params: unknown[] = [s.tallerId];
  if (!todos) cond.push('COALESCE(sd.stock, 0) <> 0');
  if (q) (cond.push('(a.nombre LIKE ? OR a.codigo LIKE ? OR a.codigo_barras LIKE ?)'), params.push(like(q), like(q), like(q)));
  const valoriza = puedeCosto(s) && tiene(s, 'stock.valorizar');
  const filas = await all<Record<string, unknown>>(
    c.env.DB,
    `SELECT a.id AS articulo_id, a.codigo, a.codigo_barras, a.nombre, a.unidad, a.stock_minimo, ROUND(COALESCE(sd.stock, 0), 3) AS stock, a.stock AS stock_total, a.costo,
            sm.minimo AS minimo_deposito, sm.objetivo AS objetivo_deposito, CASE WHEN sm.minimo > 0 AND ROUND(COALESCE(sd.stock, 0), 3) <= ROUND(sm.minimo, 3) THEN 1 ELSE 0 END AS bajo_minimo
       FROM articulos a LEFT JOIN stock_depositos sd ON sd.taller_id = a.taller_id AND sd.articulo_id = a.id AND sd.deposito_id = ?
       LEFT JOIN stock_minimos_deposito sm ON sm.taller_id = a.taller_id AND sm.articulo_id = a.id AND sm.deposito_id = ?
      WHERE ${cond.join(' AND ')} ORDER BY a.nombre COLLATE NOCASE LIMIT 1000`,
    id, id, ...params,
  );
  return c.json({ deposito: dep, items: filas.map(({ costo, ...f }) => (valoriza ? { ...f, costo, valor_costo: Math.round(Number(f.stock) * Number(costo)) } : f)) });
});

// ───────────── Transferencias internas ─────────────
const zTransferencia = z.object({
  fecha: zFecha.optional(),
  origen_id: zId,
  destino_id: zId,
  notas: zTextoOpt(300),
  items: z.array(z.object({ articulo_id: zId, cantidad: z.number().positive().max(1e9) })).min(1, 'agregá al menos un artículo').max(200),
  idem_key: z.string().min(8).max(80),
});

const SELECT_TRANSF = `SELECT t.*, o.nombre AS origen, d.nombre AS destino, u.nombre AS usuario,
    (SELECT COUNT(*) FROM transferencia_items i WHERE i.taller_id = t.taller_id AND i.transferencia_id = t.id) AS lineas
  FROM transferencias_stock t JOIN depositos o ON o.taller_id = t.taller_id AND o.id = t.origen_id JOIN depositos d ON d.taller_id = t.taller_id AND d.id = t.destino_id
  LEFT JOIN usuarios u ON u.taller_id = t.taller_id AND u.id = t.usuario_id`;

depositos.get('/transferencias', requirePerm('stock.ver'), async (c) => {
  const s = c.get('sesion');
  const { desde, hasta, deposito_id, q } = query(c, z.object({ desde: z.string().optional(), hasta: z.string().optional(), deposito_id: z.string().optional(), q: z.string().optional() }));
  const cond = ['t.taller_id = ?'];
  const params: unknown[] = [s.tallerId];
  if (desde) (cond.push('t.fecha >= ?'), params.push(desde));
  if (hasta) (cond.push('t.fecha <= ?'), params.push(hasta));
  if (deposito_id) (cond.push('(t.origen_id = ? OR t.destino_id = ?)'), params.push(deposito_id, deposito_id));
  if (q) (cond.push('(CAST(t.numero AS TEXT) = ? OR t.notas LIKE ?)'), params.push(q.replace(/\D/g, ''), like(q)));
  return c.json(await all(c.env.DB, `${SELECT_TRANSF} WHERE ${cond.join(' AND ')} ORDER BY t.numero DESC LIMIT 300`, ...params));
});

depositos.get('/transferencias/:id', requirePerm('stock.ver'), async (c) => {
  const s = c.get('sesion');
  const t = await first<Record<string, unknown>>(c.env.DB, `${SELECT_TRANSF} WHERE t.taller_id = ? AND t.id = ?`, s.tallerId, c.req.param('id'));
  if (!t) throw notFound('Transferencia');
  const items = await all(
    c.env.DB,
    `SELECT i.articulo_id, a.codigo, a.nombre, a.unidad, i.cantidad FROM transferencia_items i JOIN articulos a ON a.taller_id = i.taller_id AND a.id = i.articulo_id
      WHERE i.taller_id = ? AND i.transferencia_id = ? ORDER BY a.nombre COLLATE NOCASE`,
    s.tallerId, t.id,
  );
  return c.json({ ...t, items });
});

depositos.post('/transferencias', requirePerm('stock.ajustar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zTransferencia);
  const previa = await first<{ id: string; numero: number }>(c.env.DB, 'SELECT id, numero FROM transferencias_stock WHERE taller_id = ? AND idem_key = ?', s.tallerId, d.idem_key);
  if (previa) return c.json({ ...previa, duplicado: true });
  if (d.origen_id === d.destino_id) throw badRequest('El depósito de origen y el de destino deben ser distintos');
  await resolverDeposito(c.env.DB, s.tallerId, d.origen_id);
  await resolverDeposito(c.env.DB, s.tallerId, d.destino_id);
  const ids = d.items.map((i) => i.articulo_id);
  if (new Set(ids).size !== ids.length) throw badRequest('Hay artículos repetidos: sumá las cantidades en una sola línea');
  const items = d.items.map((i) => ({ articulo_id: i.articulo_id, cantidad: r3(i.cantidad) }));
  if (items.some((i) => i.cantidad <= 0)) throw badRequest('Las cantidades deben ser mayores a cero (hasta 3 decimales)');
  // Una transferencia nunca deja negativo el depósito de origen, aunque el taller admita stock negativo en las ventas.
  await verificarDisponible(c.env.DB, s.tallerId, agrupar(items), d.origen_id);
  const fecha = fechaComercial(s, d.fecha);
  const id = uid();
  const stmts: Stmt[] = [
    ...seqIncrementar(c.env.DB, s.tallerId, 'transferencia'),
    c.env.DB.prepare(
      `INSERT INTO transferencias_stock (id, taller_id, numero, fecha, origen_id, destino_id, notas, idem_key, usuario_id) VALUES (?, ?, ${SEQ_VALOR}, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, s.tallerId, s.tallerId, 'transferencia', fecha, d.origen_id, d.destino_id, d.notas, d.idem_key, s.usuarioId),
  ];
  for (const it of items) {
    stmts.push(
      c.env.DB.prepare('INSERT INTO transferencia_items (id, taller_id, transferencia_id, articulo_id, cantidad) VALUES (?, ?, ?, ?, ?)').bind(uid(), s.tallerId, id, it.articulo_id, it.cantidad),
      // Salida del origen (con guarda de stock) y entrada al destino: el total del artículo no cambia.
      ...sentenciasMovimiento(c.env.DB, s.tallerId, { articuloId: it.articulo_id, depositoId: d.origen_id, delta: -it.cantidad, tipo: 'salida', motivo: 'transferencia', origenTipo: 'transferencia', origenId: id, idemKey: `transferencia:${id}:${it.articulo_id}:salida`, notas: 'Transferencia entre depósitos', usuarioId: s.usuarioId }, false),
      ...sentenciasMovimiento(c.env.DB, s.tallerId, { articuloId: it.articulo_id, depositoId: d.destino_id, delta: it.cantidad, tipo: 'entrada', motivo: 'transferencia', origenTipo: 'transferencia', origenId: id, idemKey: `transferencia:${id}:${it.articulo_id}:entrada`, notas: 'Transferencia entre depósitos', usuarioId: s.usuarioId }, true),
    );
  }
  stmts.push(auditar(c.env.DB, s.tallerId, s.usuarioId, 'transferencia', id, 'crear', { origen: d.origen_id, destino: d.destino_id, lineas: items.length }));
  await c.env.DB.batch(stmts);
  return c.json(await first(c.env.DB, `${SELECT_TRANSF} WHERE t.taller_id = ? AND t.id = ?`, s.tallerId, id), 201);
});

/** Anula la transferencia devolviendo la mercadería al origen (el destino debe conservarla). */
depositos.post('/transferencias/:id/anular', requirePerm('stock.ajustar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const { motivo } = await body(c, z.object({ motivo: z.string().trim().min(3).max(300) }));
  const t = await first<{ estado: string; origen_id: string; destino_id: string; numero: number }>(c.env.DB, 'SELECT estado, origen_id, destino_id, numero FROM transferencias_stock WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!t) throw notFound('Transferencia');
  if (t.estado !== 'registrada') throw conflict('La transferencia ya está anulada');
  const items = await all<{ articulo_id: string; cantidad: number }>(c.env.DB, 'SELECT articulo_id, cantidad FROM transferencia_items WHERE taller_id = ? AND transferencia_id = ?', s.tallerId, id);
  await verificarDisponible(c.env.DB, s.tallerId, agrupar(items), t.destino_id);
  const stmts: Stmt[] = [
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM transferencias_stock WHERE taller_id = ? AND id = ? AND estado = 'registrada')", s.tallerId, id),
    c.env.DB.prepare("UPDATE transferencias_stock SET estado = 'anulada', anulada_motivo = ? WHERE taller_id = ? AND id = ?").bind(motivo, s.tallerId, id),
  ];
  for (const it of items) {
    stmts.push(
      ...sentenciasMovimiento(c.env.DB, s.tallerId, { articuloId: it.articulo_id, depositoId: t.destino_id, delta: -it.cantidad, tipo: 'salida', motivo: 'transferencia', origenTipo: 'transferencia', origenId: id, idemKey: `anulacion_transferencia:${id}:${it.articulo_id}:salida`, notas: `Anulación transferencia #${t.numero}`, usuarioId: s.usuarioId }, false),
      ...sentenciasMovimiento(c.env.DB, s.tallerId, { articuloId: it.articulo_id, depositoId: t.origen_id, delta: it.cantidad, tipo: 'entrada', motivo: 'transferencia', origenTipo: 'transferencia', origenId: id, idemKey: `anulacion_transferencia:${id}:${it.articulo_id}:entrada`, notas: `Anulación transferencia #${t.numero}`, usuarioId: s.usuarioId }, true),
    );
  }
  stmts.push(auditar(c.env.DB, s.tallerId, s.usuarioId, 'transferencia', id, 'anular', { motivo }));
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

/** Control de consistencia: el stock total de cada artículo debe ser la suma de sus depósitos. */
depositos.get('/inventario/verificar', requirePerm('stock.ajustar'), async (c) => {
  const s = c.get('sesion');
  const diferencias = await all(
    c.env.DB,
    `SELECT a.id, a.codigo, a.nombre, ROUND(a.stock, 3) AS stock_total, ROUND(COALESCE((SELECT SUM(sd.stock) FROM stock_depositos sd WHERE sd.taller_id = a.taller_id AND sd.articulo_id = a.id), 0), 3) AS suma_depositos
       FROM articulos a WHERE a.taller_id = ? AND ROUND(a.stock, 3) <> ROUND(COALESCE((SELECT SUM(sd.stock) FROM stock_depositos sd WHERE sd.taller_id = a.taller_id AND sd.articulo_id = a.id), 0), 3) LIMIT 200`,
    s.tallerId,
  );
  const negativos = await all(
    c.env.DB,
    `SELECT a.id, a.nombre, d.nombre AS deposito, ROUND(sd.stock, 3) AS stock FROM stock_depositos sd JOIN articulos a ON a.taller_id = sd.taller_id AND a.id = sd.articulo_id
       JOIN depositos d ON d.taller_id = sd.taller_id AND d.id = sd.deposito_id WHERE sd.taller_id = ? AND sd.stock < 0 LIMIT 200`,
    s.tallerId,
  );
  return c.json({ ok: diferencias.length === 0, diferencias, depositos_negativos: negativos });
});
