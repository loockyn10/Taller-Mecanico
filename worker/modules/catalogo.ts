// Servicios (mano de obra), artículos, categorías, proveedores y movimientos de stock.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, conflict, forbidden, notFound, query, zCentavos, zId, zTextoOpt } from '../lib/http';
import { all, auditar, delTaller, first, like, run, uid, updateParcial } from '../lib/db';
import { requireAny, requirePerm, tiene } from '../lib/auth';
import { exigirPermisoDePrecios, limpiarArticulo, limpiarMovimiento, limpiarServicio } from '../lib/privacidad';
import { permiteNegativo, resolverDeposito, sentenciasMovimiento } from '../lib/stock';
import { TIPOS_VEHICULO, CONDICIONES_IVA, MOTIVOS_AJUSTE, redondearCantidad, esCantidadValida } from '../../shared/dominio';
import { precioArticuloEnLista, precioServicioEnLista, type ReglaLista } from '../../shared/precios';
import { resolverLista } from '../lib/listas';
import { SALDO_PROVEEDOR_FILA_SQL } from '../lib/proveedores';
import { precioPorTiempo, resolverTiempo, type ReglaTiempo } from '../../shared/tempario';

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
  codigo: z.string().trim().max(30).nullish().transform((v) => v || null),
  nombre: z.string().trim().min(2).max(160),
  tiempo_min: z.number().int().min(1).max(6000).nullish(),
  modo_precio: z.enum(['fijo', 'por_tiempo']).default('fijo'),
  /** 'propio' confirma que el tiempo orientativo de la plantilla fue revisado por el taller. */
  origen: z.literal('propio').optional(),
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
  const { q, todos, lista_id, vehiculo_id } = query(c, z.object({ q: z.string().optional(), todos: z.string().optional(), lista_id: z.string().optional(), vehiculo_id: z.string().optional() }));
  const lst = lista_id ? await resolverLista(c.env.DB, s.tallerId, lista_id) : null;
  const reglaLista = lst ? await first<{ servicios_pct: number | null; redondeo: number }>(c.env.DB, 'SELECT servicios_pct, redondeo FROM listas_precios WHERE taller_id = ? AND id = ?', s.tallerId, lst.id) : null;
  const tarifas = await tarifasDelTaller(c.env.DB, s.tallerId);
  const veh = vehiculo_id ? await first<{ marca_id: string | null; modelo_id: string | null; motor: string | null; anio: number | null }>(c.env.DB, 'SELECT marca_id, modelo_id, motor, anio FROM vehiculos WHERE taller_id = ? AND id = ?', s.tallerId, vehiculo_id) : null;
  if (vehiculo_id && !veh) throw badRequest('Vehículo inexistente');
  const reglas = veh ? await all<ReglaTiempo & { servicio_id: string }>(c.env.DB, 'SELECT id, servicio_id, marca_id, modelo_id, motor, anio_desde, anio_hasta, tiempo_min FROM servicio_tiempos WHERE taller_id = ? ORDER BY created_at', s.tallerId) : [];
  const rows = await all<Record<string, unknown>>(
    c.env.DB,
    `SELECT se.*, cs.nombre AS categoria, cs.tarifa_hora AS categoria_tarifa FROM servicios se LEFT JOIN categorias_servicio cs ON cs.taller_id = se.taller_id AND cs.id = se.categoria_id
      WHERE se.taller_id = ? ${todos ? '' : 'AND se.activo = 1'} ${q ? 'AND se.nombre LIKE ?' : ''}
      ORDER BY cs.orden, cs.nombre, se.nombre`,
    s.tallerId,
    ...(q ? [like(q)] : []),
  );
  return c.json(
    rows.map((r) => {
      const t = resolverTiempo((r.tiempo_min as number | null) ?? null, reglas.filter((x) => x.servicio_id === r.id), veh);
      const { precio, tarifa } = precioDeServicio(r, t.tiempo_min, tarifas);
      const { categoria_tarifa: _ct, ...resto } = r;
      return limpiarServicio(s, {
        ...resto,
        precio,
        precio_cargado: r.precio,
        tarifa_hora: tarifa,
        tiempo_efectivo_min: t.tiempo_min,
        tiempo_origen: t.origen,
        checks: JSON.parse(String(r.checks ?? '[]')),
        ...(reglaLista ? { precio_lista: precioServicioEnLista(reglaLista, precio) } : {}),
      });
    }),
  );
});

/** Tarifas de mano de obra del taller (centavos por hora): la general y la de cada categoría que tenga una propia. */
export async function tarifasDelTaller(db: D1Database, tallerId: string) {
  const cfg = await first<{ tarifa_hora: number }>(db, 'SELECT tarifa_hora FROM taller_config WHERE taller_id = ?', tallerId);
  return { general: cfg?.tarifa_hora ?? 0 };
}

/** Precio de un servicio: el cargado, o (modo "por tiempo") tiempo × tarifa de su categoría o la general; sin tarifa o sin tiempo, el cargado. */
function precioDeServicio(r: Record<string, unknown>, tiempoMin: number | null, tarifas: { general: number }) {
  const tarifa = (r.categoria_tarifa as number | null) ?? tarifas.general;
  if (r.modo_precio === 'por_tiempo' && tiempoMin) {
    const calculado = precioPorTiempo(tiempoMin, tarifa);
    if (calculado > 0) return { precio: calculado, tarifa };
  }
  return { precio: r.precio as number, tarifa };
}

async function validarCategoriaServicio(db: D1Database, tallerId: string, id?: string | null) {
  if (id && !(await delTaller(db, 'categorias_servicio', tallerId, id, 'id'))) throw badRequest('Categoría inexistente');
}

catalogo.post('/servicios', requirePerm('catalogo.editar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zServicio);
  exigirPermisoDePrecios(s, { precio: d.precio || undefined });
  await validarCategoriaServicio(c.env.DB, s.tallerId, d.categoria_id);
  const id = uid();
  await run(
    c.env.DB,
    'INSERT INTO servicios (id, taller_id, categoria_id, codigo, nombre, descripcion, precio, tiempo_min, modo_precio, tipo_vehiculo, intervalo_km, intervalo_meses, checks) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, s.tallerId, d.categoria_id ?? null, d.codigo, d.nombre, d.descripcion, d.precio, d.tiempo_min ?? null, d.modo_precio, d.tipo_vehiculo, d.intervalo_km ?? null, d.intervalo_meses ?? null, JSON.stringify(d.checks),
  );
  return c.json({ id }, 201);
});

catalogo.put('/servicios/:id', requirePerm('catalogo.editar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, zServicio.partial().extend({ modo_precio: z.enum(['fijo', 'por_tiempo']).optional() }));
  exigirPermisoDePrecios(s, { precio: d.precio });
  // Cambiar el modo de cálculo del precio equivale a fijar un precio: exige poder verlos.
  if (d.modo_precio !== undefined && !tiene(s, 'precios.venta.ver')) throw forbidden('No tenés permiso para ver ni modificar precios de venta');
  if (!(await delTaller(c.env.DB, 'servicios', s.tallerId, id, 'id'))) throw notFound('Servicio');
  await validarCategoriaServicio(c.env.DB, s.tallerId, d.categoria_id);
  const datos: Record<string, unknown> = { ...d };
  if (d.checks) datos.checks = JSON.stringify(d.checks);
  if (d.activo !== undefined) datos.activo = d.activo ? 1 : 0;
  // Un tiempo modificado o confirmado por el taller deja de ser "orientativo".
  if (d.tiempo_min !== undefined || d.origen === 'propio') datos.origen = 'propio';
  const st = updateParcial(c.env.DB, 'servicios', s.tallerId, id, datos, ['categoria_id', 'codigo', 'nombre', 'descripcion', 'precio', 'tiempo_min', 'modo_precio', 'origen', 'tipo_vehiculo', 'intervalo_km', 'intervalo_meses', 'checks', 'activo'], false);
  if (st) await st.run();
  return c.json({ ok: true });
});

catalogo.post('/servicios/ajuste-masivo', requirePerm('catalogo.editar', 'precios.gestionar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(
    c,
    z.object({ categoria_id: zId.nullish(), porcentaje: z.number().min(-90).max(500), redondeo: z.enum(['ninguno', '10', '100', '1000']).default('100') }),
  );
  const r = d.redondeo === 'ninguno' ? 1 : Number(d.redondeo) * 100; // a centavos
  const factor = 1 + d.porcentaje / 100;
  const res = await run(
    c.env.DB,
    `UPDATE servicios SET precio = CAST(ROUND(precio * ? / ?) AS INTEGER) * ? WHERE taller_id = ? AND modo_precio = 'fijo' ${d.categoria_id ? 'AND categoria_id = ?' : ''}`,
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

catalogo.get('/proveedores', requireAny('catalogo.ver', 'compras.ver'), async (c) => {
  const s = c.get('sesion');
  const conSaldo = tiene(s, 'compras.ver');
  return c.json(
    (await all<Record<string, unknown>>(
      c.env.DB,
      `SELECT p.*, ${SALDO_PROVEEDOR_FILA_SQL} AS saldo
         FROM proveedores p WHERE p.taller_id = ? ORDER BY p.activo DESC, p.nombre`,
      s.tallerId,
    )).map((p) => (conSaldo ? p : { ...p, saldo: undefined })),
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
  /** Código de barras (EAN/UPC/propio): los lectores USB estándar lo escriben como un teclado. */
  codigo_barras: zTextoOpt(60),
  /** Depósito del stock inicial (sin indicar: el principal). */
  deposito_id: zId.nullish(),
  nombre: z.string().trim().min(2).max(200),
  marca: zTextoOpt(80),
  categoria_id: zId.nullish(),
  proveedor_id: zId.nullish(),
  costo: zCentavos.default(0),
  precio: zCentavos.default(0),
  alicuota_iva: z.number().refine((v) => [0, 2.5, 5, 10.5, 21, 27].includes(v), 'alícuota inválida').default(21),
  stock_inicial: z.number().min(0).max(1e9).refine(esCantidadValida, 'admite hasta 3 decimales').default(0),
  stock_minimo: z.number().min(0).max(1e9).refine(esCantidadValida, 'admite hasta 3 decimales').default(0),
  stock_objetivo: z.number().min(0).max(1e9).refine(esCantidadValida, 'admite hasta 3 decimales').nullish(),
  unidad: z.enum(['un', 'lt', 'kg', 'm', 'juego']).default('un'),
  ubicacion: zTextoOpt(80),
  activo: z.boolean().optional(),
});

catalogo.get('/articulos', requirePerm('catalogo.ver'), async (c) => {
  const s = c.get('sesion');
  const { q, categoria_id, bajo_stock, limite, lista_id } = query(
    c,
    z.object({ q: z.string().optional(), categoria_id: z.string().optional(), bajo_stock: z.string().optional(), lista_id: z.string().optional(), limite: z.coerce.number().int().min(1).max(1000).default(300) }),
  );
  const lst = lista_id ? await first<ReglaLista & { id: string }>(c.env.DB, 'SELECT id, base, porcentaje, redondeo, servicios_pct FROM listas_precios WHERE taller_id = ? AND id = ?', s.tallerId, lista_id) : null;
  if (lista_id && !lst) throw badRequest('Lista de precios inexistente');
  const cond = ['a.taller_id = ?', 'a.activo = 1'];
  const params: unknown[] = [s.tallerId];
  if (q) (cond.push('(a.nombre LIKE ? OR a.codigo LIKE ? OR a.marca LIKE ? OR a.codigo_barras LIKE ?)'), params.push(like(q), like(q), like(q), like(q)));
  if (categoria_id) (cond.push('a.categoria_id = ?'), params.push(categoria_id));
  if (bajo_stock) cond.push('a.stock <= a.stock_minimo');
  const filas = await all<{ costo: number; precio: number; precio_fijo?: number | null }>(
    c.env.DB,
    `SELECT a.*, ca.nombre AS categoria, p.nombre AS proveedor${lst ? ', li.precio AS precio_fijo' : ''} FROM articulos a
         LEFT JOIN categorias_articulo ca ON ca.taller_id = a.taller_id AND ca.id = a.categoria_id
         LEFT JOIN proveedores p ON p.taller_id = a.taller_id AND p.id = a.proveedor_id
         ${lst ? 'LEFT JOIN lista_precio_items li ON li.taller_id = a.taller_id AND li.articulo_id = a.id AND li.lista_id = ?' : ''}
        WHERE ${cond.join(' AND ')} ORDER BY a.nombre COLLATE NOCASE LIMIT ?`,
    ...(lst ? [lst.id] : []),
    ...params,
    limite,
  );
  if (!lst) return c.json(filas.map((a) => limpiarArticulo(s, a)));
  // La lista no modifica el artículo: agrega `precio_lista` (fijo de la lista o calculado por su regla).
  return c.json(filas.map((a) => limpiarArticulo(s, { ...a, precio_lista: precioArticuloEnLista(lst, a, a.precio_fijo ?? null).precio })));
});

/**
 * Búsqueda exacta por lector de códigos de barras (o por el código interno): devuelve el artículo o 404.
 * Los lectores USB estándar escriben el código como un teclado y terminan con Enter.
 */
catalogo.get('/articulos/lector/:codigo', requirePerm('catalogo.ver'), async (c) => {
  const s = c.get('sesion');
  const codigo = c.req.param('codigo').trim();
  if (!codigo) throw badRequest('Código vacío');
  const a = await first<Record<string, unknown>>(
    c.env.DB,
    `SELECT a.*, ca.nombre AS categoria FROM articulos a LEFT JOIN categorias_articulo ca ON ca.taller_id = a.taller_id AND ca.id = a.categoria_id
      WHERE a.taller_id = ? AND a.activo = 1 AND (a.codigo_barras = ? OR a.codigo = ?) ORDER BY (a.codigo_barras = ?) DESC LIMIT 1`,
    s.tallerId, codigo, codigo, codigo,
  );
  if (!a) throw notFound('Artículo con ese código');
  return c.json(limpiarArticulo(s, a));
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
  const depositos = await all(
    c.env.DB,
    `SELECT d.id, d.nombre, d.es_principal, COALESCE(sd.stock, 0) AS stock FROM depositos d
       LEFT JOIN stock_depositos sd ON sd.taller_id = d.taller_id AND sd.deposito_id = d.id AND sd.articulo_id = ?
      WHERE d.taller_id = ? AND (d.activo = 1 OR COALESCE(sd.stock, 0) <> 0) ORDER BY d.es_principal DESC, d.nombre`,
    c.req.param('id'), s.tallerId,
  );
  return c.json({ ...limpiarArticulo(s, a), depositos, movimientos: movimientos.map((m) => limpiarMovimiento(s, m)) });
});

async function validarRefsArticulo(db: D1Database, tallerId: string, d: { categoria_id?: string | null; proveedor_id?: string | null }) {
  if (d.categoria_id && !(await delTaller(db, 'categorias_articulo', tallerId, d.categoria_id, 'id'))) throw badRequest('Categoría inexistente');
  if (d.proveedor_id && !(await delTaller(db, 'proveedores', tallerId, d.proveedor_id, 'id'))) throw badRequest('Proveedor inexistente');
}

catalogo.post('/articulos', requirePerm('catalogo.editar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zArticulo);
  exigirPermisoDePrecios(s, { costo: d.costo || undefined, precio: d.precio || undefined });
  await validarRefsArticulo(c.env.DB, s.tallerId, d);
  const deposito = await resolverDeposito(c.env.DB, s.tallerId, d.deposito_id);
  const id = uid();
  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO articulos (id, taller_id, codigo, codigo_barras, nombre, marca, categoria_id, proveedor_id, costo, precio, alicuota_iva, stock, stock_minimo, stock_objetivo, unidad, ubicacion)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)`,
    ).bind(id, s.tallerId, d.codigo, d.codigo_barras, d.nombre, d.marca, d.categoria_id ?? null, d.proveedor_id ?? null, d.costo, d.precio, d.alicuota_iva, redondearCantidad(d.stock_minimo), d.stock_objetivo ?? null, d.unidad, d.ubicacion),
  ];
  // El stock inicial queda registrado como movimiento (trazabilidad completa del inventario).
  if (d.stock_inicial > 0) {
    stmts.push(...sentenciasMovimiento(c.env.DB, s.tallerId, { articuloId: id, depositoId: deposito, delta: d.stock_inicial, tipo: 'entrada', notas: 'Stock inicial', usuarioId: s.usuarioId, costoUnitario: d.costo }, true));
  }
  stmts.push(auditar(c.env.DB, s.tallerId, s.usuarioId, 'articulo', id, 'crear'));
  await c.env.DB.batch(stmts);
  return c.json({ id }, 201);
});

catalogo.put('/articulos/:id', requirePerm('catalogo.editar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, zArticulo.omit({ stock_inicial: true, deposito_id: true }).partial());
  exigirPermisoDePrecios(s, { costo: d.costo, precio: d.precio });
  if (!(await delTaller(c.env.DB, 'articulos', s.tallerId, id, 'id'))) throw notFound('Artículo');
  await validarRefsArticulo(c.env.DB, s.tallerId, d);
  const datos: Record<string, unknown> = { ...d };
  if (d.activo !== undefined) datos.activo = d.activo ? 1 : 0;
  // El stock NO se edita directamente: solo mediante movimientos.
  const st = updateParcial(c.env.DB, 'articulos', s.tallerId, id, datos, ['codigo', 'codigo_barras', 'nombre', 'marca', 'categoria_id', 'proveedor_id', 'costo', 'precio', 'alicuota_iva', 'stock_minimo', 'stock_objetivo', 'unidad', 'ubicacion', 'activo']);
  if (st) await c.env.DB.batch([st, auditar(c.env.DB, s.tallerId, s.usuarioId, 'articulo', id, 'modificar')]);
  return c.json({ ok: true });
});

// ───────────── Movimientos de stock ─────────────
catalogo.get('/stock/movimientos', requirePerm('stock.ver'), async (c) => {
  const s = c.get('sesion');
  const { articulo_id, tipo, desde, hasta, deposito_id } = query(c, z.object({ articulo_id: z.string().optional(), tipo: z.string().optional(), desde: z.string().optional(), hasta: z.string().optional(), deposito_id: z.string().optional() }));
  const cond = ['m.taller_id = ?'];
  const params: unknown[] = [s.tallerId];
  // Los movimientos anteriores a los depósitos (deposito_id vacío) pertenecen al depósito principal.
  if (deposito_id) (cond.push("COALESCE(m.deposito_id, (SELECT id FROM depositos WHERE taller_id = m.taller_id AND es_principal = 1)) = ?"), params.push(deposito_id));
  if (articulo_id) (cond.push('m.articulo_id = ?'), params.push(articulo_id));
  if (tipo) (cond.push('m.tipo = ?'), params.push(tipo));
  if (desde) (cond.push('m.created_at >= ?'), params.push(desde));
  if (hasta) (cond.push('m.created_at < ?'), params.push(`${hasta}T23:59:59.999Z`));
  return c.json(
    (await all(
      c.env.DB,
      `SELECT m.*, a.nombre AS articulo, a.codigo, u.nombre AS usuario, dp.nombre AS deposito FROM stock_movimientos m
         JOIN articulos a ON a.taller_id = m.taller_id AND a.id = m.articulo_id
         LEFT JOIN depositos dp ON dp.taller_id = m.taller_id AND dp.id = COALESCE(m.deposito_id, (SELECT id FROM depositos WHERE taller_id = m.taller_id AND es_principal = 1))
         LEFT JOIN usuarios u ON u.id = m.usuario_id AND u.taller_id = m.taller_id
        WHERE ${cond.join(' AND ')} ORDER BY m.created_at DESC LIMIT 300`,
      ...params,
    )).map((m) => limpiarMovimiento(s, m)),
  );
});

catalogo.post('/stock/movimientos', requirePerm('stock.ajustar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(
    c,
    z.object({
      articulo_id: zId,
      tipo: z.enum(['entrada', 'salida', 'ajuste']),
      cantidad: z.number().min(0).max(1e9).refine(esCantidadValida, 'admite hasta 3 decimales'), // entrada/salida: cantidad; ajuste: stock final contado
      motivo: z.enum(MOTIVOS_AJUSTE).nullish(),
      notas: zTextoOpt(300),
      /** Depósito del movimiento (sin indicar: el principal). */
      deposito_id: zId.nullish(),
      idem_key: z.string().min(8).max(80),
    }),
  );
  const deposito = await resolverDeposito(c.env.DB, s.tallerId, d.deposito_id);
  // Toda salida o ajuste de inventario deja su motivo: es lo que permite auditar mermas, roturas y diferencias.
  if (d.tipo !== 'entrada' && !d.motivo) throw badRequest('Indicá el motivo del ajuste');
  if (d.motivo === 'otro' && !(d.notas ?? '').trim()) throw badRequest('Con el motivo "otro" explicá qué pasó en las notas');
  const art = await delTaller<{ costo: number }>(c.env.DB, 'articulos', s.tallerId, d.articulo_id, 'costo');
  if (!art) throw notFound('Artículo');
  // Las cantidades se controlan contra el stock del depósito elegido (el total del artículo es la suma de todos).
  const a = {
    stock: (await first<{ stock: number }>(
      c.env.DB,
      `SELECT COALESCE((SELECT stock FROM stock_depositos WHERE taller_id = ? AND articulo_id = ? AND deposito_id = COALESCE(?, (SELECT id FROM depositos WHERE taller_id = ? AND es_principal = 1))), 0) AS stock`,
      s.tallerId, d.articulo_id, deposito, s.tallerId,
    ))!.stock,
  };
  const delta = redondearCantidad(d.tipo === 'entrada' ? d.cantidad : d.tipo === 'salida' ? -d.cantidad : d.cantidad - a.stock);
  if (d.tipo !== 'ajuste' && d.cantidad <= 0) throw badRequest('La cantidad debe ser mayor a cero');
  if (delta === 0) throw badRequest('El movimiento no modifica el stock');
  const negativo = await permiteNegativo(c.env.DB, s.tallerId);
  if (!negativo && redondearCantidad(a.stock + delta) < 0) throw conflict(`Stock insuficiente (disponible ${a.stock})`, 'stock_insuficiente');
  const stmts = [];
  if (d.tipo === 'ajuste') {
    // El ajuste fija el stock contado: si otro movimiento ocurrió entre la lectura y la escritura, se aborta.
    stmts.push(
      c.env.DB.prepare(
        'INSERT INTO tx_guard (ok) SELECT 0 WHERE COALESCE((SELECT stock FROM stock_depositos WHERE taller_id = ? AND articulo_id = ? AND deposito_id = COALESCE(?, (SELECT id FROM depositos WHERE taller_id = ? AND es_principal = 1))), 0) <> ?',
      ).bind(s.tallerId, d.articulo_id, deposito, s.tallerId, a.stock),
    );
  }
  stmts.push(
    ...sentenciasMovimiento(
      c.env.DB,
      s.tallerId,
      { articuloId: d.articulo_id, depositoId: deposito, delta, tipo: d.tipo, notas: d.notas, motivo: d.motivo ?? null, usuarioId: s.usuarioId, idemKey: `manual:${d.idem_key}`, origenTipo: 'manual' },
      negativo,
    ),
  );
  await c.env.DB.batch(stmts);
  const nuevo = await delTaller<{ stock: number }>(c.env.DB, 'articulos', s.tallerId, d.articulo_id, 'stock');
  return c.json({ ok: true, stock: nuevo?.stock }, 201);
});
