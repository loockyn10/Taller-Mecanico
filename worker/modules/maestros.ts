// Clientes, vehículos, marcas/modelos y mecánicos.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, conflict, notFound, query, zId, zTextoOpt } from '../lib/http';
import { all, auditar, delTaller, first, like, run, SEQ_VALOR, seqIncrementar, uid, updateParcial } from '../lib/db';
import { requireAny, requirePerm, tiene } from '../lib/auth';
import { limpiarDocumento, limpiarMantenimiento } from '../lib/privacidad';
import { estadoMantenimientos } from '../lib/mantenimiento';
import { CONDICIONES_IVA, normalizarPatente } from '../../shared/dominio';

export const maestros = new Hono<AppEnv>();

// ───────────── Clientes ─────────────
const zCliente = z.object({
  nombre: z.string().trim().min(2, 'mínimo 2 caracteres').max(160),
  documento_tipo: z.enum(['DNI', 'CUIT', 'CUIL', 'OTRO']).default('DNI'),
  documento: zTextoOpt(20),
  condicion_iva: z.enum(CONDICIONES_IVA).default('consumidor_final'),
  telefono: zTextoOpt(40),
  email: z.string().trim().email('email inválido').max(120).nullish().or(z.literal('')).transform((v) => v || null),
  direccion: zTextoOpt(200),
  localidad: zTextoOpt(120),
  notas: zTextoOpt(1000),
});

maestros.get('/clientes', requirePerm('clientes.ver'), async (c) => {
  const s = c.get('sesion');
  const { q, limite, inactivos } = query(c, z.object({ q: z.string().optional(), limite: z.coerce.number().int().min(1).max(500).default(100), inactivos: z.string().optional() }));
  const filtroQ = q ? 'AND (c.nombre LIKE ? OR c.documento LIKE ? OR c.telefono LIKE ? OR c.email LIKE ? OR EXISTS (SELECT 1 FROM vehiculos v WHERE v.taller_id = c.taller_id AND v.cliente_id = c.id AND v.patente LIKE ?))' : '';
  const params = q ? [like(q), like(q), like(q), like(q), like(normalizarPatente(q) || q)] : [];
  const rows = await all(
    c.env.DB,
    `SELECT c.id, c.codigo, c.nombre, c.documento_tipo, c.documento, c.condicion_iva, c.telefono, c.email, c.localidad, c.activo,
            (SELECT COUNT(*) FROM vehiculos v WHERE v.taller_id = c.taller_id AND v.cliente_id = c.id AND v.activo = 1) AS vehiculos,
            (SELECT COALESCE(SUM(total - cobrado), 0) FROM ventas ve WHERE ve.taller_id = c.taller_id AND ve.cliente_id = c.id AND ve.estado = 'emitida') AS saldo
       FROM clientes c
      WHERE c.taller_id = ? ${inactivos ? '' : 'AND c.activo = 1'} ${filtroQ}
      ORDER BY c.codigo = 0 DESC, c.nombre COLLATE NOCASE LIMIT ?`,
    s.tallerId,
    ...params,
    limite,
  );
  // El saldo es información de cuenta corriente: solo para quien puede ver ventas y cobranzas.
  return c.json(tiene(s, 'ventas.ver') ? rows : rows.map((r) => ({ ...r, saldo: undefined })));
});

maestros.get('/clientes/:id', requirePerm('clientes.ver'), async (c) => {
  const s = c.get('sesion');
  const cli = await delTaller(c.env.DB, 'clientes', s.tallerId, c.req.param('id'));
  if (!cli) throw notFound('Cliente');
  const vehiculos = await all(
    c.env.DB,
    `SELECT v.*, ma.nombre AS marca, mo.nombre AS modelo FROM vehiculos v
       LEFT JOIN marcas ma ON ma.taller_id = v.taller_id AND ma.id = v.marca_id
       LEFT JOIN modelos mo ON mo.taller_id = v.taller_id AND mo.id = v.modelo_id
      WHERE v.taller_id = ? AND v.cliente_id = ? AND v.activo = 1 ORDER BY v.patente`,
    s.tallerId,
    cli.id,
  );
  const ordenes = tiene(s, 'ordenes.ver')
    ? (await all(
        c.env.DB,
        `SELECT o.id, o.numero, o.estado, o.total, o.fecha_ingreso, v.patente FROM ordenes o JOIN vehiculos v ON v.taller_id = o.taller_id AND v.id = o.vehiculo_id
          WHERE o.taller_id = ? AND o.cliente_id = ? ORDER BY o.numero DESC LIMIT 50`,
        s.tallerId,
        cli.id,
      )).map((o) => limpiarDocumento(s, o))
    : [];
  const saldo = tiene(s, 'ventas.ver')
    ? (await first<{ saldo: number }>(c.env.DB, "SELECT COALESCE(SUM(total - cobrado), 0) AS saldo FROM ventas WHERE taller_id = ? AND cliente_id = ? AND estado = 'emitida'", s.tallerId, cli.id))?.saldo ?? 0
    : undefined;
  return c.json({ ...cli, vehiculos, ordenes, saldo });
});

maestros.post('/clientes', requirePerm('clientes.crear'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zCliente);
  const id = uid();
  await c.env.DB.batch([
    ...seqIncrementar(c.env.DB, s.tallerId, 'cliente'),
    c.env.DB.prepare(
      `INSERT INTO clientes (id, taller_id, codigo, nombre, documento_tipo, documento, condicion_iva, telefono, email, direccion, localidad, notas)
       VALUES (?, ?, ${SEQ_VALOR}, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, s.tallerId, s.tallerId, 'cliente', d.nombre, d.documento_tipo, d.documento, d.condicion_iva, d.telefono, d.email, d.direccion, d.localidad, d.notas),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'cliente', id, 'crear'),
  ]);
  return c.json(await delTaller(c.env.DB, 'clientes', s.tallerId, id), 201);
});

maestros.put('/clientes/:id', requirePerm('clientes.editar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, zCliente.partial().extend({ activo: z.boolean().optional() }));
  const cli = await delTaller<{ codigo: number }>(c.env.DB, 'clientes', s.tallerId, id, 'codigo');
  if (!cli) throw notFound('Cliente');
  const datos: Record<string, unknown> = { ...d };
  if (d.activo !== undefined) datos.activo = d.activo ? 1 : 0;
  const st = updateParcial(c.env.DB, 'clientes', s.tallerId, id, datos, ['nombre', 'documento_tipo', 'documento', 'condicion_iva', 'telefono', 'email', 'direccion', 'localidad', 'notas', 'activo']);
  if (st) await c.env.DB.batch([st, auditar(c.env.DB, s.tallerId, s.usuarioId, 'cliente', id, 'modificar')]);
  return c.json(await delTaller(c.env.DB, 'clientes', s.tallerId, id));
});

maestros.delete('/clientes/:id', requirePerm('registros.eliminar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const cli = await delTaller<{ codigo: number }>(c.env.DB, 'clientes', s.tallerId, id, 'codigo');
  if (!cli) throw notFound('Cliente');
  if (cli.codigo === 0) throw conflict('El cliente "Consumidor final" no se puede eliminar');
  // Baja lógica: conserva el historial comercial.
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE clientes SET activo = 0 WHERE taller_id = ? AND id = ?').bind(s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'cliente', id, 'desactivar'),
  ]);
  return c.json({ ok: true });
});

// ───────────── Vehículos ─────────────
const zVehiculo = z.object({
  cliente_id: zId,
  patente: z.string().trim().min(5, 'patente inválida').max(12),
  marca_id: zId.nullish(),
  modelo_id: zId.nullish(),
  // El año máximo se evalúa por solicitud: en Workers, Date al cargar el módulo vale 1970.
  anio: z.number().int().min(1930).refine((v) => v <= new Date().getFullYear() + 1, 'año inválido').nullish(),
  color: zTextoOpt(40),
  vin: zTextoOpt(40),
  motor: zTextoOpt(60),
  combustible: zTextoOpt(30),
  km_actual: z.number().int().min(0).max(5_000_000).default(0),
  notas: zTextoOpt(1000),
});

async function validarMarcaModelo(db: D1Database, tallerId: string, marcaId?: string | null, modeloId?: string | null) {
  if (marcaId && !(await delTaller(db, 'marcas', tallerId, marcaId, 'id'))) throw badRequest('Marca inexistente');
  if (modeloId) {
    const m = await delTaller<{ marca_id: string }>(db, 'modelos', tallerId, modeloId, 'marca_id');
    if (!m) throw badRequest('Modelo inexistente');
    if (marcaId && m.marca_id !== marcaId) throw badRequest('El modelo no corresponde a la marca');
  }
}

const SELECT_VEHICULO = `SELECT v.*, ma.nombre AS marca, mo.nombre AS modelo, c.nombre AS cliente, c.telefono AS cliente_telefono
  FROM vehiculos v
  JOIN clientes c ON c.taller_id = v.taller_id AND c.id = v.cliente_id
  LEFT JOIN marcas ma ON ma.taller_id = v.taller_id AND ma.id = v.marca_id
  LEFT JOIN modelos mo ON mo.taller_id = v.taller_id AND mo.id = v.modelo_id`;

maestros.get('/vehiculos', requirePerm('vehiculos.ver'), async (c) => {
  const s = c.get('sesion');
  const { q, cliente_id } = query(c, z.object({ q: z.string().optional(), cliente_id: z.string().optional() }));
  const cond: string[] = ['v.taller_id = ?', 'v.activo = 1'];
  const params: unknown[] = [s.tallerId];
  if (cliente_id) (cond.push('v.cliente_id = ?'), params.push(cliente_id));
  if (q) {
    cond.push('(v.patente LIKE ? OR c.nombre LIKE ? OR ma.nombre LIKE ? OR mo.nombre LIKE ?)');
    params.push(like(normalizarPatente(q) || q), like(q), like(q), like(q));
  }
  return c.json((await all(c.env.DB, `${SELECT_VEHICULO} WHERE ${cond.join(' AND ')} ORDER BY v.patente LIMIT 200`, ...params)).map((v) => limpiarDocumento(s, v)));
});

maestros.get('/vehiculos/:id', requirePerm('vehiculos.ver'), async (c) => {
  const s = c.get('sesion');
  const v = await first<Record<string, unknown>>(c.env.DB, `${SELECT_VEHICULO} WHERE v.taller_id = ? AND v.id = ?`, s.tallerId, c.req.param('id'));
  if (!v) throw notFound('Vehículo');
  // Historial de reparaciones: OT del vehículo con sus trabajos.
  const ordenes = await all<{ id: string }>(
    c.env.DB,
    `SELECT o.id, o.numero, o.estado, o.fecha_ingreso, o.fecha_entregada, o.km_ingreso, o.total, o.falla_reportada, o.diagnostico, m.nombre AS mecanico
       FROM ordenes o LEFT JOIN mecanicos m ON m.taller_id = o.taller_id AND m.id = o.mecanico_id
      WHERE o.taller_id = ? AND o.vehiculo_id = ? ORDER BY o.fecha_ingreso DESC`,
    s.tallerId,
    v.id,
  );
  // Los ítems se leen con una subconsulta (sin IN de ids): un vehículo con muchas OT superaría el límite de 100 parámetros de D1.
  const items = await all<{ orden_id: string }>(
    c.env.DB,
    `SELECT oi.orden_id, oi.tipo, oi.descripcion, oi.cantidad FROM orden_items oi JOIN ordenes o ON o.taller_id = oi.taller_id AND o.id = oi.orden_id
      WHERE oi.taller_id = ? AND o.vehiculo_id = ? ORDER BY oi.orden`,
    s.tallerId,
    v.id,
  );
  const historial = ordenes.map((o) => limpiarDocumento(s, { ...o, items: items.filter((i) => i.orden_id === o.id) }));
  const proximos = tiene(s, 'mantenimientos.ver') ? (await estadoMantenimientos(c.env.DB, s.tallerId, { vehiculoId: String(v.id) })).map((m) => limpiarMantenimiento(s, m)) : [];
  return c.json({ ...limpiarDocumento(s, v), historial, proximos });
});

maestros.post('/vehiculos', requirePerm('vehiculos.crear'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zVehiculo);
  const patente = normalizarPatente(d.patente);
  if (patente.length < 5) throw badRequest('Patente inválida');
  if (!(await delTaller(c.env.DB, 'clientes', s.tallerId, d.cliente_id, 'id'))) throw badRequest('Cliente inexistente');
  await validarMarcaModelo(c.env.DB, s.tallerId, d.marca_id, d.modelo_id);
  const ex = await first<{ id: string; cliente: string }>(
    c.env.DB,
    'SELECT v.id, c.nombre AS cliente FROM vehiculos v JOIN clientes c ON c.taller_id = v.taller_id AND c.id = v.cliente_id WHERE v.taller_id = ? AND v.patente = ?',
    s.tallerId,
    patente,
  );
  if (ex) throw conflict(`La patente ${patente} ya está registrada (cliente: ${ex.cliente})`, 'duplicado');
  const id = uid();
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO vehiculos (id, taller_id, cliente_id, patente, marca_id, modelo_id, anio, color, vin, motor, combustible, km_actual, notas) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).bind(id, s.tallerId, d.cliente_id, patente, d.marca_id ?? null, d.modelo_id ?? null, d.anio ?? null, d.color, d.vin, d.motor, d.combustible, d.km_actual, d.notas),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'vehiculo', id, 'crear', { patente }),
  ]);
  return c.json(limpiarDocumento(s, (await first(c.env.DB, `${SELECT_VEHICULO} WHERE v.taller_id = ? AND v.id = ?`, s.tallerId, id))!), 201);
});

maestros.put('/vehiculos/:id', requirePerm('vehiculos.editar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, zVehiculo.partial());
  const v = await delTaller<{ km_actual: number }>(c.env.DB, 'vehiculos', s.tallerId, id, 'km_actual');
  if (!v) throw notFound('Vehículo');
  if (d.cliente_id && !(await delTaller(c.env.DB, 'clientes', s.tallerId, d.cliente_id, 'id'))) throw badRequest('Cliente inexistente');
  await validarMarcaModelo(c.env.DB, s.tallerId, d.marca_id, d.modelo_id);
  const datos: Record<string, unknown> = { ...d };
  if (d.patente) datos.patente = normalizarPatente(d.patente);
  if (d.km_actual !== undefined && d.km_actual < v.km_actual) throw badRequest(`El kilometraje no puede ser menor al registrado (${v.km_actual} km)`);
  const st = updateParcial(c.env.DB, 'vehiculos', s.tallerId, id, datos, ['cliente_id', 'patente', 'marca_id', 'modelo_id', 'anio', 'color', 'vin', 'motor', 'combustible', 'km_actual', 'notas']);
  if (st) await c.env.DB.batch([st, auditar(c.env.DB, s.tallerId, s.usuarioId, 'vehiculo', id, 'modificar')]);
  return c.json(limpiarDocumento(s, (await first(c.env.DB, `${SELECT_VEHICULO} WHERE v.taller_id = ? AND v.id = ?`, s.tallerId, id))!));
});

maestros.delete('/vehiculos/:id', requirePerm('registros.eliminar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  if (!(await delTaller(c.env.DB, 'vehiculos', s.tallerId, id, 'id'))) throw notFound('Vehículo');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE vehiculos SET activo = 0 WHERE taller_id = ? AND id = ?').bind(s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'vehiculo', id, 'desactivar'),
  ]);
  return c.json({ ok: true });
});

// ───────────── Marcas y modelos ─────────────
maestros.get('/marcas', requireAny('vehiculos.ver', 'catalogo.ver'), async (c) => {
  const s = c.get('sesion');
  const marcas = await all<{ id: string; nombre: string }>(c.env.DB, 'SELECT id, nombre FROM marcas WHERE taller_id = ? ORDER BY nombre', s.tallerId);
  const modelos = await all<{ id: string; marca_id: string; nombre: string; motor: string | null }>(
    c.env.DB,
    'SELECT id, marca_id, nombre, motor FROM modelos WHERE taller_id = ? ORDER BY nombre',
    s.tallerId,
  );
  return c.json(marcas.map((m) => ({ ...m, modelos: modelos.filter((x) => x.marca_id === m.id) })));
});

maestros.post('/marcas', requireAny('vehiculos.crear', 'vehiculos.editar', 'catalogo.editar'), async (c) => {
  const s = c.get('sesion');
  const { nombre } = await body(c, z.object({ nombre: z.string().trim().min(1).max(60) }));
  const id = uid();
  await run(c.env.DB, 'INSERT INTO marcas (id, taller_id, nombre) VALUES (?, ?, ?)', id, s.tallerId, nombre);
  return c.json({ id, nombre }, 201);
});

maestros.post('/modelos', requireAny('vehiculos.crear', 'vehiculos.editar', 'catalogo.editar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, z.object({ marca_id: zId, nombre: z.string().trim().min(1).max(80), motor: zTextoOpt(80) }));
  if (!(await delTaller(c.env.DB, 'marcas', s.tallerId, d.marca_id, 'id'))) throw badRequest('Marca inexistente');
  const id = uid();
  await run(c.env.DB, 'INSERT INTO modelos (id, taller_id, marca_id, nombre, motor) VALUES (?, ?, ?, ?, ?)', id, s.tallerId, d.marca_id, d.nombre, d.motor);
  return c.json({ id, ...d }, 201);
});

maestros.delete('/modelos/:id', requirePerm('catalogo.editar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  if (await first(c.env.DB, 'SELECT 1 FROM vehiculos WHERE taller_id = ? AND modelo_id = ?', s.tallerId, id)) throw conflict('El modelo está asignado a vehículos');
  await run(c.env.DB, 'DELETE FROM modelos WHERE taller_id = ? AND id = ?', s.tallerId, id);
  return c.json({ ok: true });
});

maestros.delete('/marcas/:id', requirePerm('catalogo.editar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  if (await first(c.env.DB, 'SELECT 1 FROM vehiculos WHERE taller_id = ? AND marca_id = ?', s.tallerId, id)) throw conflict('La marca está asignada a vehículos');
  await run(c.env.DB, 'DELETE FROM marcas WHERE taller_id = ? AND id = ?', s.tallerId, id);
  return c.json({ ok: true });
});

// ───────────── Mecánicos ─────────────
const zMecanico = z.object({ nombre: z.string().trim().min(2).max(120), telefono: zTextoOpt(40), especialidad: zTextoOpt(120), activo: z.boolean().optional() });

maestros.get('/mecanicos', requireAny('ordenes.ver', 'ordenes.crear', 'turnos.ver', 'presupuestos.ver', 'usuarios.gestionar'), async (c) => {
  const s = c.get('sesion');
  return c.json(
    await all(
      c.env.DB,
      `SELECT m.*, (SELECT COUNT(*) FROM ordenes o WHERE o.taller_id = m.taller_id AND o.mecanico_id = m.id AND o.estado IN ('recibida','diagnostico','en_reparacion','esperando_repuestos')) AS ot_abiertas
         FROM mecanicos m WHERE m.taller_id = ? ORDER BY m.activo DESC, m.nombre`,
      s.tallerId,
    ),
  );
});

maestros.post('/mecanicos', requirePerm('usuarios.gestionar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zMecanico);
  const id = uid();
  await run(c.env.DB, 'INSERT INTO mecanicos (id, taller_id, nombre, telefono, especialidad) VALUES (?, ?, ?, ?, ?)', id, s.tallerId, d.nombre, d.telefono, d.especialidad);
  return c.json({ id }, 201);
});

maestros.put('/mecanicos/:id', requirePerm('usuarios.gestionar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, zMecanico.partial());
  if (!(await delTaller(c.env.DB, 'mecanicos', s.tallerId, id, 'id'))) throw notFound('Mecánico');
  const datos: Record<string, unknown> = { ...d };
  if (d.activo !== undefined) datos.activo = d.activo ? 1 : 0;
  const st = updateParcial(c.env.DB, 'mecanicos', s.tallerId, id, datos, ['nombre', 'telefono', 'especialidad', 'activo'], false);
  if (st) await st.run();
  return c.json({ ok: true });
});
