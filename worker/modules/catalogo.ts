// Servicios (mano de obra), artículos, categorías, proveedores y movimientos de stock.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, conflict, notFound, query, zCentavos, zId, zTextoOpt } from '../lib/http';
import { all, auditar, delTaller, first, like, run, uid, updateParcial } from '../lib/db';
import { requirePerm } from '../lib/auth';
import { permiteNegativo, sentenciasMovimiento } from '../lib/stock';
import { TIPOS_VEHICULO, CONDICIONES_IVA } from '../../shared/dominio';

export const catalogo = new Hono<AppEnv>();

// ───────────── Categorías de servicio ─────────────
catalogo.get('/categorias-servicio', requirePerm('catalogo.ver'), async (c) => {
  const s = c.get('sesion');
  return c.json(await all(c.env.DB, 'SELECT id, nombre, orden FROM categorias_servicio WHERE taller_id = ? ORDER BY orden, nombre', s.tallerId));
});
catalogo.post('/categorias-servicio', requirePerm('catalogo.editar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, z.object({ nombre: z.string().trim().min(1).max(80), orden: z.number().int().default(0) }));
  const id = uid();
  await run(c.env.DB, 'INSERT INTO categorias_servicio (id, taller_id, nombre, orden) VALUES (?, ?, ?, ?)', id, s.tallerId, d.nombre, d.orden);
  return c.json({ id, ...d }, 201);
});
catalogo.put('/categorias-servicio/:id', requirePerm('catalogo.editar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, z.object({ nombre: z.string().trim().min(1).max(80).optional(), orden: z.number().int().optional() }));
  const st = updateParcial(c.env.DB, 'categorias_servicio', s.tallerId, c.req.param('id'), d, ['nombre', 'orden'], false);
  if (st) await st.run();
  return c.json({ ok: true });
});
catalogo.delete('/categorias-servicio/:id', requirePerm('catalogo.editar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  if (await first(c.env.DB, 'SELECT 1 FROM servicios WHERE taller_id = ? AND categoria_id = ?', s.tallerId, id)) throw conflict('La categoría tiene servicios asignados');
  await run(c.env.DB, 'DELETE FROM categorias_servicio WHERE taller_id = ? AND id = ?', s.tallerId, id);
  return c.json({ ok: true });
});

// ───────────── Servicios ─────────────
const zServicio = z.object({
  categoria_id: zId.nullish(),
  nombre: z.string().trim().min(2).max(160),
  descripcion: zTextoOpt(500),
  precio: zCentavos,
  tipo_vehiculo: z.enum(TIPOS_VEHICULO).default('todos'),
  intervalo_km: z.number().int().min(1).max(1_000_000).nullish(),
  intervalo_meses: z.number().int().min(1).max(240).nullish(),
  checks: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  activo: z.boolean().optional(),
});

catalogo.get('/servicios', requirePerm('catalogo.ver'), async (c) => {
  const s = c.get('sesion');
  const { q, todos } = query(c, z.object({ q: z.string().optional(), todos: z.string().optional() }));
  const rows = await all<Record<string, unknown>>(
    c.env.DB,
    `SELECT se.*, cs.nombre AS categoria FROM servicios se LEFT JOIN categorias_servicio cs ON cs.taller_id = se.taller_id AND cs.id = se.categoria_id
      WHERE se.taller_id = ? ${todos ? '' : 'AND se.activo = 1'} ${q ? 'AND se.nombre LIKE ?' : ''}
      ORDER BY cs.orden, cs.nombre, se.nombre`,
    s.tallerId,
    ...(q ? [like(q)] : []),
  );
  return c.json(rows.map((r) => ({ ...r, checks: JSON.parse(String(r.checks ?? '[]')) })));
});

async function validarCategoriaServicio(db: D1Database, tallerId: string, id?: string | null) {
  if (id && !(await delTaller(db, 'categorias_servicio', tallerId, id, 'id'))) throw badRequest('Categoría inexistente');
}

catalogo.post('/servicios', requirePerm('catalogo.editar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zServicio);
  await validarCategoriaServicio(c.env.DB, s.tallerId, d.categoria_id);
  const id = uid();
  await run(
    c.env.DB,
    'INSERT INTO servicios (id, taller_id, categoria_id, nombre, descripcion, precio, tipo_vehiculo, intervalo_km, intervalo_meses, checks) VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, s.tallerId, d.categoria_id ?? null, d.nombre, d.descripcion, d.precio, d.tipo_vehiculo, d.intervalo_km ?? null, d.intervalo_meses ?? null, JSON.stringify(d.checks),
  );
  return c.json({ id }, 201);
});

catalogo.put('/servicios/:id', requirePerm('catalogo.editar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, zServicio.partial());
  if (!(await delTaller(c.env.DB, 'servicios', s.tallerId, id, 'id'))) throw notFound('Servicio');
  await validarCategoriaServicio(c.env.DB, s.tallerId, d.categoria_id);
  const datos: Record<string, unknown> = { ...d };
  if (d.checks) datos.checks = JSON.stringify(d.checks);
  if (d.activo !== undefined) datos.activo = d.activo ? 1 : 0;
  const st = updateParcial(c.env.DB, 'servicios', s.tallerId, id, datos, ['categoria_id', 'nombre', 'descripcion', 'precio', 'tipo_vehiculo', 'intervalo_km', 'intervalo_meses', 'checks', 'activo'], false);
  if (st) await st.run();
  return c.json({ ok: true });
});

catalogo.post('/servicios/ajuste-masivo', requirePerm('catalogo.editar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(
    c,
    z.object({ categoria_id: zId.nullish(), porcentaje: z.number().min(-90).max(500), redondeo: z.enum(['ninguno', '10', '100', '1000']).default('100') }),
  );
  const r = d.redondeo === 'ninguno' ? 1 : Number(d.redondeo) * 100; // a centavos
  const factor = 1 + d.porcentaje / 100;
  const res = await run(
    c.env.DB,
    `UPDATE servicios SET precio = CAST(ROUND(precio * ? / ?) AS INTEGER) * ? WHERE taller_id = ? ${d.categoria_id ? 'AND categoria_id = ?' : ''}`,
    factor, r, r, s.tallerId, ...(d.categoria_id ? [d.categoria_id] : []),
  );
  await auditar(c.env.DB, s.tallerId, s.usuarioId, 'servicio', null, 'ajuste_masivo', d).run();
  return c.json({ actualizados: res.meta.changes });
});

// ───────────── Categorías de artículo ─────────────
catalogo.get('/categorias-articulo', requirePerm('catalogo.ver'), async (c) => {
  const s = c.get('sesion');
  return c.json(
    await all(
      c.env.DB,
      `SELECT ca.id, ca.nombre, ca.descripcion, (SELECT COUNT(*) FROM articulos a WHERE a.taller_id = ca.taller_id AND a.categoria_id = ca.id AND a.activo = 1) AS articulos
         FROM categorias_articulo ca WHERE ca.taller_id = ? ORDER BY ca.nombre`,
      s.tallerId,
    ),
  );
});
catalogo.post('/categorias-articulo', requirePerm('catalogo.editar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, z.object({ nombre: z.string().trim().min(1).max(80), descripcion: zTextoOpt(300) }));
  const id = uid();
  await run(c.env.DB, 'INSERT INTO categorias_articulo (id, taller_id, nombre, descripcion) VALUES (?, ?, ?, ?)', id, s.tallerId, d.nombre, d.descripcion);
  return c.json({ id, ...d }, 201);
});
catalogo.put('/categorias-articulo/:id', requirePerm('catalogo.editar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, z.object({ nombre: z.string().trim().min(1).max(80).optional(), descripcion: zTextoOpt(300) }));
  const st = updateParcial(c.env.DB, 'categorias_articulo', s.tallerId, c.req.param('id'), d, ['nombre', 'descripcion'], false);
  if (st) await st.run();
  return c.json({ ok: true });
});
catalogo.delete('/categorias-articulo/:id', requirePerm('catalogo.editar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  if (await first(c.env.DB, 'SELECT 1 FROM articulos WHERE taller_id = ? AND categoria_id = ?', s.tallerId, id)) throw conflict('La categoría tiene artículos asignados');
  await run(c.env.DB, 'DELETE FROM categorias_articulo WHERE taller_id = ? AND id = ?', s.tallerId, id);
  return c.json({ ok: true });
});

// ───────────── Proveedores ─────────────
const zProveedor = z.object({
  nombre: z.string().trim().min(2).max(160),
  cuit: zTextoOpt(20),
  condicion_iva: z.enum(CONDICIONES_IVA).default('responsable_inscripto'),
  telefono: zTextoOpt(40),
  email: zTextoOpt(120),
  direccion: zTextoOpt(200),
  notas: zTextoOpt(1000),
  activo: z.boolean().optional(),
});

catalogo.get('/proveedores', requirePerm('catalogo.ver'), async (c) => {
  const s = c.get('sesion');
  return c.json(
    await all(
      c.env.DB,
      `SELECT p.*,
              (SELECT COALESCE(SUM(total),0) FROM compras co WHERE co.taller_id = p.taller_id AND co.proveedor_id = p.id AND co.estado = 'registrada')
            - (SELECT COALESCE(SUM(importe),0) FROM pagos_proveedor pp WHERE pp.taller_id = p.taller_id AND pp.proveedor_id = p.id AND pp.estado = 'registrado') AS saldo
         FROM proveedores p WHERE p.taller_id = ? ORDER BY p.activo DESC, p.nombre`,
      s.tallerId,
    ),
  );
});
catalogo.post('/proveedores', requirePerm('compras.gestionar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zProveedor);
  const id = uid();
  await run(
    c.env.DB,
    'INSERT INTO proveedores (id, taller_id, nombre, cuit, condicion_iva, telefono, email, direccion, notas) VALUES (?,?,?,?,?,?,?,?,?)',
    id, s.tallerId, d.nombre, d.cuit, d.condicion_iva, d.telefono, d.email, d.direccion, d.notas,
  );
  return c.json({ id }, 201);
});
catalogo.put('/proveedores/:id', requirePerm('compras.gestionar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, zProveedor.partial());
  if (!(await delTaller(c.env.DB, 'proveedores', s.tallerId, id, 'id'))) throw notFound('Proveedor');
  const datos: Record<string, unknown> = { ...d };
  if (d.activo !== undefined) datos.activo = d.activo ? 1 : 0;
  const st = updateParcial(c.env.DB, 'proveedores', s.tallerId, id, datos, ['nombre', 'cuit', 'condicion_iva', 'telefono', 'email', 'direccion', 'notas', 'activo'], false);
  if (st) await st.run();
  return c.json({ ok: true });
});

// ───────────── Artículos ─────────────
const zArticulo = z.object({
  codigo: zTextoOpt(60),
  nombre: z.string().trim().min(2).max(200),
  marca: zTextoOpt(80),
  categoria_id: zId.nullish(),
  proveedor_id: zId.nullish(),
  costo: zCentavos.default(0),
  precio: zCentavos.default(0),
  alicuota_iva: z.number().refine((v) => [0, 2.5, 5, 10.5, 21, 27].includes(v), 'alícuota inválida').default(21),
  stock_inicial: z.number().min(0).max(1e9).default(0),
  stock_minimo: z.number().min(0).max(1e9).default(0),
  unidad: z.enum(['un', 'lt', 'kg', 'm', 'juego']).default('un'),
  ubicacion: zTextoOpt(80),
  activo: z.boolean().optional(),
});

catalogo.get('/articulos', requirePerm('catalogo.ver'), async (c) => {
  const s = c.get('sesion');
  const { q, categoria_id, bajo_stock, limite } = query(
    c,
    z.object({ q: z.string().optional(), categoria_id: z.string().optional(), bajo_stock: z.string().optional(), limite: z.coerce.number().int().min(1).max(1000).default(300) }),
  );
  const cond = ['a.taller_id = ?', 'a.activo = 1'];
  const params: unknown[] = [s.tallerId];
  if (q) (cond.push('(a.nombre LIKE ? OR a.codigo LIKE ? OR a.marca LIKE ?)'), params.push(like(q), like(q), like(q)));
  if (categoria_id) (cond.push('a.categoria_id = ?'), params.push(categoria_id));
  if (bajo_stock) cond.push('a.stock <= a.stock_minimo');
  return c.json(
    await all(
      c.env.DB,
      `SELECT a.*, ca.nombre AS categoria, p.nombre AS proveedor FROM articulos a
         LEFT JOIN categorias_articulo ca ON ca.taller_id = a.taller_id AND ca.id = a.categoria_id
         LEFT JOIN proveedores p ON p.taller_id = a.taller_id AND p.id = a.proveedor_id
        WHERE ${cond.join(' AND ')} ORDER BY a.nombre COLLATE NOCASE LIMIT ?`,
      ...params,
      limite,
    ),
  );
});

catalogo.get('/articulos/:id', requirePerm('catalogo.ver'), async (c) => {
  const s = c.get('sesion');
  const a = await first(
    c.env.DB,
    `SELECT a.*, ca.nombre AS categoria, p.nombre AS proveedor FROM articulos a
       LEFT JOIN categorias_articulo ca ON ca.taller_id = a.taller_id AND ca.id = a.categoria_id
       LEFT JOIN proveedores p ON p.taller_id = a.taller_id AND p.id = a.proveedor_id
      WHERE a.taller_id = ? AND a.id = ?`,
    s.tallerId,
    c.req.param('id'),
  );
  if (!a) throw notFound('Artículo');
  const movimientos = await all(
    c.env.DB,
    `SELECT m.*, u.nombre AS usuario FROM stock_movimientos m LEFT JOIN usuarios u ON u.id = m.usuario_id AND u.taller_id = m.taller_id
      WHERE m.taller_id = ? AND m.articulo_id = ? ORDER BY m.created_at DESC LIMIT 100`,
    s.tallerId,
    c.req.param('id'),
  );
  return c.json({ ...a, movimientos });
});

async function validarRefsArticulo(db: D1Database, tallerId: string, d: { categoria_id?: string | null; proveedor_id?: string | null }) {
  if (d.categoria_id && !(await delTaller(db, 'categorias_articulo', tallerId, d.categoria_id, 'id'))) throw badRequest('Categoría inexistente');
  if (d.proveedor_id && !(await delTaller(db, 'proveedores', tallerId, d.proveedor_id, 'id'))) throw badRequest('Proveedor inexistente');
}

catalogo.post('/articulos', requirePerm('catalogo.editar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zArticulo);
  await validarRefsArticulo(c.env.DB, s.tallerId, d);
  const id = uid();
  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO articulos (id, taller_id, codigo, nombre, marca, categoria_id, proveedor_id, costo, precio, alicuota_iva, stock, stock_minimo, unidad, ubicacion)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?)`,
    ).bind(id, s.tallerId, d.codigo, d.nombre, d.marca, d.categoria_id ?? null, d.proveedor_id ?? null, d.costo, d.precio, d.alicuota_iva, d.stock_minimo, d.unidad, d.ubicacion),
  ];
  // El stock inicial queda registrado como movimiento (trazabilidad completa del inventario).
  if (d.stock_inicial > 0) {
    stmts.push(...sentenciasMovimiento(c.env.DB, s.tallerId, { articuloId: id, delta: d.stock_inicial, tipo: 'entrada', notas: 'Stock inicial', usuarioId: s.usuarioId, costoUnitario: d.costo }, true));
  }
  stmts.push(auditar(c.env.DB, s.tallerId, s.usuarioId, 'articulo', id, 'crear'));
  await c.env.DB.batch(stmts);
  return c.json({ id }, 201);
});

catalogo.put('/articulos/:id', requirePerm('catalogo.editar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, zArticulo.omit({ stock_inicial: true }).partial());
  if (!(await delTaller(c.env.DB, 'articulos', s.tallerId, id, 'id'))) throw notFound('Artículo');
  await validarRefsArticulo(c.env.DB, s.tallerId, d);
  const datos: Record<string, unknown> = { ...d };
  if (d.activo !== undefined) datos.activo = d.activo ? 1 : 0;
  // El stock NO se edita directamente: solo mediante movimientos.
  const st = updateParcial(c.env.DB, 'articulos', s.tallerId, id, datos, ['codigo', 'nombre', 'marca', 'categoria_id', 'proveedor_id', 'costo', 'precio', 'alicuota_iva', 'stock_minimo', 'unidad', 'ubicacion', 'activo']);
  if (st) await c.env.DB.batch([st, auditar(c.env.DB, s.tallerId, s.usuarioId, 'articulo', id, 'modificar')]);
  return c.json({ ok: true });
});

// ───────────── Movimientos de stock ─────────────
catalogo.get('/stock/movimientos', requirePerm('stock.ver'), async (c) => {
  const s = c.get('sesion');
  const { articulo_id, tipo, desde, hasta } = query(c, z.object({ articulo_id: z.string().optional(), tipo: z.string().optional(), desde: z.string().optional(), hasta: z.string().optional() }));
  const cond = ['m.taller_id = ?'];
  const params: unknown[] = [s.tallerId];
  if (articulo_id) (cond.push('m.articulo_id = ?'), params.push(articulo_id));
  if (tipo) (cond.push('m.tipo = ?'), params.push(tipo));
  if (desde) (cond.push('m.created_at >= ?'), params.push(desde));
  if (hasta) (cond.push('m.created_at < ?'), params.push(`${hasta}T23:59:59.999Z`));
  return c.json(
    await all(
      c.env.DB,
      `SELECT m.*, a.nombre AS articulo, a.codigo, u.nombre AS usuario FROM stock_movimientos m
         JOIN articulos a ON a.taller_id = m.taller_id AND a.id = m.articulo_id
         LEFT JOIN usuarios u ON u.id = m.usuario_id AND u.taller_id = m.taller_id
        WHERE ${cond.join(' AND ')} ORDER BY m.created_at DESC LIMIT 300`,
      ...params,
    ),
  );
});

catalogo.post('/stock/movimientos', requirePerm('stock.ajustar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(
    c,
    z.object({
      articulo_id: zId,
      tipo: z.enum(['entrada', 'salida', 'ajuste']),
      cantidad: z.number().min(0).max(1e9), // entrada/salida: cantidad; ajuste: stock final contado
      notas: zTextoOpt(300),
      idem_key: z.string().min(8).max(80),
    }),
  );
  const a = await delTaller<{ stock: number; costo: number }>(c.env.DB, 'articulos', s.tallerId, d.articulo_id, 'stock, costo');
  if (!a) throw notFound('Artículo');
  let delta = d.tipo === 'entrada' ? d.cantidad : d.tipo === 'salida' ? -d.cantidad : d.cantidad - a.stock;
  if (d.tipo !== 'ajuste' && d.cantidad <= 0) throw badRequest('La cantidad debe ser mayor a cero');
  if (delta === 0) throw badRequest('El movimiento no modifica el stock');
  const negativo = await permiteNegativo(c.env.DB, s.tallerId);
  if (!negativo && a.stock + delta < 0) throw conflict(`Stock insuficiente (disponible ${a.stock})`, 'stock_insuficiente');
  const stmts = [];
  if (d.tipo === 'ajuste') {
    // El ajuste fija el stock contado: si otro movimiento ocurrió entre la lectura y la escritura, se aborta.
    stmts.push(c.env.DB.prepare('INSERT INTO tx_guard (ok) SELECT 0 WHERE (SELECT stock FROM articulos WHERE taller_id = ? AND id = ?) <> ?').bind(s.tallerId, d.articulo_id, a.stock));
  }
  stmts.push(
    ...sentenciasMovimiento(
      c.env.DB,
      s.tallerId,
      { articuloId: d.articulo_id, delta, tipo: d.tipo, notas: d.notas, usuarioId: s.usuarioId, idemKey: `manual:${d.idem_key}`, origenTipo: 'manual' },
      negativo,
    ),
  );
  await c.env.DB.batch(stmts);
  const nuevo = await delTaller<{ stock: number }>(c.env.DB, 'articulos', s.tallerId, d.articulo_id, 'stock');
  return c.json({ ok: true, stock: nuevo?.stock }, 201);
});
