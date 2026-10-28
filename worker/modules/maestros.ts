// Clientes, vehículos, marcas/modelos y mecánicos.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, conflict, forbidden, notFound, query, zId, zTextoOpt } from '../lib/http';
import { all, auditar, delTaller, first, like, run, SEQ_VALOR, seqIncrementar, uid, updateParcial } from '../lib/db';
import { requireAny, requirePerm, tiene } from '../lib/auth';
import { limpiarDocumento, limpiarMantenimiento } from '../lib/privacidad';
import { estadoMantenimientos } from '../lib/mantenimiento';
import { credito_cliente_sql, creditosDisponibles } from '../lib/creditos';
import { CONDICIONES_IVA, RELACIONES_VEHICULO, normalizarPatente } from '../../shared/dominio';
import { claveBusqueda } from '../../shared/catalogo-auto';
import { CLIENTES_N_SQL, CLIENTES_TEXTO_SQL, cambiarRelacion, desvincularCliente, exigirClienteActivo, sentenciaVincular, vincularCliente, vinculosDeVehiculo } from '../lib/vehiculo-clientes';

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
  const filtroQ = q ? 'AND (c.nombre LIKE ? OR c.documento LIKE ? OR c.telefono LIKE ? OR c.email LIKE ? OR EXISTS (SELECT 1 FROM vehiculo_clientes x JOIN vehiculos v ON v.taller_id = x.taller_id AND v.id = x.vehiculo_id WHERE x.taller_id = c.taller_id AND x.cliente_id = c.id AND x.desvinculado_at IS NULL AND v.patente LIKE ?))' : '';
  const params = q ? [like(q), like(q), like(q), like(q), like(normalizarPatente(q) || q)] : [];
  const rows = await all(
    c.env.DB,
    `SELECT c.id, c.codigo, c.nombre, c.documento_tipo, c.documento, c.condicion_iva, c.telefono, c.email, c.localidad, c.activo,
            (SELECT COUNT(*) FROM vehiculo_clientes x JOIN vehiculos v ON v.taller_id = x.taller_id AND v.id = x.vehiculo_id WHERE x.taller_id = c.taller_id AND x.cliente_id = c.id AND x.desvinculado_at IS NULL AND v.activo = 1) AS vehiculos,
            (SELECT COALESCE(SUM(total - devuelto - cobrado), 0) FROM ventas ve WHERE ve.taller_id = c.taller_id AND ve.cliente_id = c.id AND ve.estado = 'emitida') AS saldo,
            ${credito_cliente_sql('c')} AS a_favor
       FROM clientes c
      WHERE c.taller_id = ? ${inactivos ? '' : 'AND c.activo = 1'} ${filtroQ}
      ORDER BY c.codigo = 0 DESC, c.nombre COLLATE NOCASE LIMIT ?`,
    s.tallerId,
    ...params,
    limite,
  );
  // El saldo es información de cuenta corriente: solo para quien puede ver ventas y cobranzas.
  return c.json(tiene(s, 'ventas.ver') ? rows : rows.map((r) => ({ ...r, saldo: undefined, a_favor: undefined })));
});

maestros.get('/clientes/:id', requirePerm('clientes.ver'), async (c) => {
  const s = c.get('sesion');
  const cli = await delTaller(c.env.DB, 'clientes', s.tallerId, c.req.param('id'));
  if (!cli) throw notFound('Cliente');
  const vehiculos = await all(
    c.env.DB,
    `SELECT v.*, x.id AS vinculo_id, x.relacion, x.vinculado_at, ma.nombre AS marca, mo.nombre AS modelo FROM vehiculo_clientes x
       JOIN vehiculos v ON v.taller_id = x.taller_id AND v.id = x.vehiculo_id
       LEFT JOIN marcas ma ON ma.taller_id = v.taller_id AND ma.id = v.marca_id
       LEFT JOIN modelos mo ON mo.taller_id = v.taller_id AND mo.id = v.modelo_id
      WHERE x.taller_id = ? AND x.cliente_id = ? AND x.desvinculado_at IS NULL AND v.activo = 1 ORDER BY v.patente`,
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
    ? (await first<{ saldo: number }>(c.env.DB, "SELECT COALESCE(SUM(total - devuelto - cobrado), 0) AS saldo FROM ventas WHERE taller_id = ? AND cliente_id = ? AND estado = 'emitida'", s.tallerId, cli.id))?.saldo ?? 0
    : undefined;
  const aFavor = tiene(s, 'ventas.ver') ? (await creditosDisponibles(c.env.DB, s.tallerId, cli.id as string)).reduce((x, k) => x + k.disponible, 0) : undefined;
  return c.json({ ...cli, vehiculos, ordenes, saldo, a_favor: aFavor });
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
const zRelacion = z.enum(RELACIONES_VEHICULO).nullish();
const zVehiculo = z.object({
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
  version: zTextoOpt(120),
  // Catálogo automotor: la marca/modelo del taller se resuelve en el servidor (se reutiliza la que ya exista o se crea sólo la usada).
  cat_marca_id: zId.nullish(),
  cat_modelo_id: zId.nullish(),
  cat_version_id: zId.nullish(),
  marca_texto: zTextoOpt(60),
  modelo_texto: zTextoOpt(80),
});
/** Alta: el vehículo puede crearse sin clientes, con uno (`cliente_id`, forma abreviada) o con varios (`clientes`). Son vínculos, no un campo del vehículo. */
const zAltaVehiculo = zVehiculo.extend({
  cliente_id: zId.nullish(),
  relacion: zRelacion,
  clientes: z.array(z.object({ cliente_id: zId, relacion: zRelacion })).max(10).default([]),
});

type DatosVehiculo = z.infer<typeof zVehiculo> | Partial<z.infer<typeof zVehiculo>>;

/** Marca del taller con ese nombre (sin distinguir mayúsculas, tildes ni signos); si no existe la crea. Nunca modifica una existente. */
async function asegurarMarca(db: D1Database, tallerId: string, nombre: string, catId: string | null): Promise<string> {
  const buscar = async () => (await all<{ id: string; nombre: string; cat_marca_id: string | null }>(db, 'SELECT id, nombre, cat_marca_id FROM marcas WHERE taller_id = ?', tallerId)).find((m) => claveBusqueda(m.nombre) === claveBusqueda(nombre));
  let m = await buscar();
  if (!m) {
    await run(db, 'INSERT OR IGNORE INTO marcas (id, taller_id, nombre, cat_marca_id) VALUES (?, ?, ?, ?)', uid(), tallerId, nombre, catId);
    m = await buscar();
    if (!m) throw badRequest('No se pudo registrar la marca');
  }
  if (catId && !m.cat_marca_id) await run(db, 'UPDATE marcas SET cat_marca_id = ? WHERE taller_id = ? AND id = ? AND cat_marca_id IS NULL', catId, tallerId, m.id);
  return m.id;
}

async function asegurarModelo(db: D1Database, tallerId: string, marcaId: string, nombre: string, catId: string | null): Promise<string> {
  const buscar = async () => (await all<{ id: string; nombre: string; cat_modelo_id: string | null }>(db, 'SELECT id, nombre, cat_modelo_id FROM modelos WHERE taller_id = ? AND marca_id = ?', tallerId, marcaId)).find((m) => claveBusqueda(m.nombre) === claveBusqueda(nombre));
  let m = await buscar();
  if (!m) {
    await run(db, 'INSERT OR IGNORE INTO modelos (id, taller_id, marca_id, nombre, cat_modelo_id) VALUES (?, ?, ?, ?, ?)', uid(), tallerId, marcaId, nombre, catId);
    m = await buscar();
    if (!m) throw badRequest('No se pudo registrar el modelo');
  }
  if (catId && !m.cat_modelo_id) await run(db, 'UPDATE modelos SET cat_modelo_id = ? WHERE taller_id = ? AND id = ? AND cat_modelo_id IS NULL', catId, tallerId, m.id);
  return m.id;
}

/**
 * Si la solicitud trae datos del catálogo o marca/modelo escritos a mano (sin ids del taller), los resuelve a marca_id/modelo_id del taller.
 * Devuelve null cuando no hay nada que resolver (se mantiene el comportamiento de siempre con marca_id/modelo_id).
 */
async function resolverCatalogo(db: D1Database, tallerId: string, d: DatosVehiculo) {
  if (d.marca_id !== undefined || d.modelo_id !== undefined) return null;
  if (d.cat_marca_id === undefined && d.cat_modelo_id === undefined && d.marca_texto === undefined && d.modelo_texto === undefined) return null;
  const cm = d.cat_modelo_id ? await first<{ id: string; nombre: string; marca_id: string }>(db, 'SELECT id, nombre, marca_id FROM cat_modelos WHERE id = ?', d.cat_modelo_id) : null;
  if (d.cat_modelo_id && !cm) throw badRequest('Modelo del catálogo inexistente');
  const catMarcaId = cm?.marca_id ?? d.cat_marca_id ?? null;
  const cma = catMarcaId ? await first<{ id: string; nombre: string }>(db, 'SELECT id, nombre FROM cat_marcas WHERE id = ?', catMarcaId) : null;
  if (catMarcaId && !cma) throw badRequest('Marca del catálogo inexistente');
  const cv = d.cat_version_id ? await first<{ id: string; modelo_id: string }>(db, 'SELECT id, modelo_id FROM cat_versiones WHERE id = ?', d.cat_version_id) : null;
  if (d.cat_version_id && (!cv || (cm && cv.modelo_id !== cm.id))) throw badRequest('La versión no corresponde al modelo del catálogo');
  const marcaNombre = cma?.nombre ?? d.marca_texto ?? null;
  const modeloNombre = cm?.nombre ?? d.modelo_texto ?? null;
  if (!marcaNombre && modeloNombre) throw badRequest('Elegí la marca antes del modelo');
  const marca_id = marcaNombre ? await asegurarMarca(db, tallerId, marcaNombre, cma?.id ?? null) : null;
  const modelo_id = marca_id && modeloNombre ? await asegurarModelo(db, tallerId, marca_id, modeloNombre, cm?.id ?? null) : null;
  return { marca_id, modelo_id, cat_modelo_id: cm?.id ?? null, cat_version_id: cv?.id ?? null };
}

/** Con marca_id/modelo_id del taller en la solicitud, los ids del catálogo que la acompañen igual deben existir y ser coherentes. */
async function validarIdsCatalogo(db: D1Database, d: DatosVehiculo) {
  if (d.cat_modelo_id && !(await first(db, 'SELECT 1 FROM cat_modelos WHERE id = ?', d.cat_modelo_id))) throw badRequest('Modelo del catálogo inexistente');
  if (d.cat_version_id) {
    const v = await first<{ modelo_id: string }>(db, 'SELECT modelo_id FROM cat_versiones WHERE id = ?', d.cat_version_id);
    if (!v || (d.cat_modelo_id && v.modelo_id !== d.cat_modelo_id)) throw badRequest('La versión no corresponde al modelo del catálogo');
  }
}

async function validarMarcaModelo(db: D1Database, tallerId: string, marcaId?: string | null, modeloId?: string | null) {
  if (marcaId && !(await delTaller(db, 'marcas', tallerId, marcaId, 'id'))) throw badRequest('Marca inexistente');
  if (modeloId) {
    const m = await delTaller<{ marca_id: string }>(db, 'modelos', tallerId, modeloId, 'marca_id');
    if (!m) throw badRequest('Modelo inexistente');
    if (marcaId && m.marca_id !== marcaId) throw badRequest('El modelo no corresponde a la marca');
  }
}

/** Datos propios del vehículo. Los clientes vinculados (nombres) se agregan sólo para quien puede ver clientes. */
const selectVehiculo = (conClientes: boolean) => `SELECT v.*, ma.nombre AS marca, mo.nombre AS modelo, ma.cat_marca_id AS marca_cat_id, mo.cat_modelo_id AS modelo_cat_id, ${CLIENTES_N_SQL} AS clientes_n${conClientes ? `, ${CLIENTES_TEXTO_SQL} AS clientes` : ''}
  FROM vehiculos v
  LEFT JOIN marcas ma ON ma.taller_id = v.taller_id AND ma.id = v.marca_id
  LEFT JOIN modelos mo ON mo.taller_id = v.taller_id AND mo.id = v.modelo_id`;

const VINCULO_VIGENTE = 'EXISTS (SELECT 1 FROM vehiculo_clientes x WHERE x.taller_id = v.taller_id AND x.vehiculo_id = v.id AND x.desvinculado_at IS NULL';

maestros.get('/vehiculos', requirePerm('vehiculos.ver'), async (c) => {
  const s = c.get('sesion');
  const verClientes = tiene(s, 'clientes.ver');
  const { q, cliente_id, cat_modelo_id, sin_clientes } = query(c, z.object({ q: z.string().optional(), cliente_id: z.string().optional(), cat_modelo_id: z.string().max(64).optional(), sin_clientes: z.string().optional() }));
  const cond: string[] = ['v.taller_id = ?', 'v.activo = 1'];
  const params: unknown[] = [s.tallerId];
  // Los clientes vinculados son datos personales: sin permiso para verlos no se filtra ni se busca por ellos (sería una forma de averiguarlos).
  if (cliente_id) {
    if (!verClientes) throw forbidden('No tenés permiso para consultar los vehículos de un cliente');
    cond.push(`${VINCULO_VIGENTE} AND x.cliente_id = ?)`);
    params.push(cliente_id);
  }
  if (sin_clientes) cond.push(`NOT ${VINCULO_VIGENTE})`);
  // Vehículos del taller vinculados a un modelo del catálogo (directo o por el modelo del taller): sólo ve los suyos.
  if (cat_modelo_id) (cond.push('(v.cat_modelo_id = ? OR mo.cat_modelo_id = ?)'), params.push(cat_modelo_id, cat_modelo_id));
  if (q) {
    cond.push(`(v.patente LIKE ? OR ma.nombre LIKE ? OR mo.nombre LIKE ?${verClientes ? ` OR ${VINCULO_VIGENTE} AND x.cliente_id IN (SELECT id FROM clientes WHERE taller_id = v.taller_id AND nombre LIKE ?))` : ''})`);
    params.push(like(normalizarPatente(q) || q), like(q), like(q), ...(verClientes ? [like(q)] : []));
  }
  return c.json((await all(c.env.DB, `${selectVehiculo(verClientes)} WHERE ${cond.join(' AND ')} ORDER BY v.patente LIMIT 200`, ...params)).map((v) => limpiarDocumento(s, v)));
});

maestros.get('/vehiculos/:id', requirePerm('vehiculos.ver'), async (c) => {
  const s = c.get('sesion');
  const verClientes = tiene(s, 'clientes.ver');
  const v = await first<Record<string, unknown>>(c.env.DB, `${selectVehiculo(verClientes)} WHERE v.taller_id = ? AND v.id = ?`, s.tallerId, c.req.param('id'));
  if (!v) throw notFound('Vehículo');
  // Historial técnico: pertenece al vehículo (todas sus OT, de cualquier cliente). Cada OT conserva SU cliente responsable; sólo se muestra a quien puede ver clientes.
  const ordenes = await all<{ id: string; cliente_id: string }>(
    c.env.DB,
    `SELECT o.id, o.numero, o.estado, o.fecha_ingreso, o.fecha_entregada, o.km_ingreso, o.total, o.falla_reportada, o.diagnostico, m.nombre AS mecanico, o.cliente_id, cl.nombre AS cliente
       FROM ordenes o LEFT JOIN mecanicos m ON m.taller_id = o.taller_id AND m.id = o.mecanico_id
       JOIN clientes cl ON cl.taller_id = o.taller_id AND cl.id = o.cliente_id
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
  const historial = ordenes.map((o) => {
    const { cliente_id, ...resto } = limpiarDocumento(s, { ...o, items: items.filter((i) => i.orden_id === o.id) });
    return verClientes ? { ...resto, cliente_id } : resto;
  });
  const proximos = tiene(s, 'mantenimientos.ver') ? (await estadoMantenimientos(c.env.DB, s.tallerId, { vehiculoId: String(v.id) })).map((m) => limpiarMantenimiento(s, m)) : [];
  const vinculos = verClientes ? await vinculosDeVehiculo(c.env.DB, s.tallerId, String(v.id), { contacto: true }) : null;
  return c.json({ ...limpiarDocumento(s, v), historial, proximos, ...(vinculos ? { clientes_vinculados: vinculos.vigentes, clientes_anteriores: vinculos.anteriores } : {}) });
});

maestros.post('/vehiculos', requirePerm('vehiculos.crear'), async (c) => {
  const s = c.get('sesion');
  const { cliente_id, relacion, clientes, ...d } = await body(c, zAltaVehiculo);
  const patente = normalizarPatente(d.patente);
  if (patente.length < 5) throw badRequest('Patente inválida');
  // Clientes a vincular (opcional): forma abreviada + lista, sin repetidos. Vincular exige poder ver clientes.
  const vincular = [...(cliente_id ? [{ cliente_id, relacion: relacion ?? 'titular' }] : []), ...clientes].filter((x, i, a) => a.findIndex((y) => y.cliente_id === x.cliente_id) === i);
  if (vincular.length && !tiene(s, 'clientes.ver')) throw forbidden('Para vincular clientes necesitás permiso para ver clientes');
  for (const x of vincular) await exigirClienteActivo(c.env.DB, s.tallerId, x.cliente_id);
  if (await first(c.env.DB, 'SELECT 1 FROM vehiculos WHERE taller_id = ? AND patente = ?', s.tallerId, patente)) throw conflict(`La patente ${patente} ya está registrada`, 'duplicado');
  const cat = await resolverCatalogo(c.env.DB, s.tallerId, d);
  if (!cat) {
    await validarMarcaModelo(c.env.DB, s.tallerId, d.marca_id, d.modelo_id);
    await validarIdsCatalogo(c.env.DB, d);
  }
  const marcaId = cat ? cat.marca_id : (d.marca_id ?? null);
  const modeloId = cat ? cat.modelo_id : (d.modelo_id ?? null);
  const id = uid();
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO vehiculos (id, taller_id, patente, marca_id, modelo_id, anio, color, vin, motor, combustible, km_actual, notas, version, cat_modelo_id, cat_version_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).bind(id, s.tallerId, patente, marcaId, modeloId, d.anio ?? null, d.color, d.vin, d.motor, d.combustible, d.km_actual, d.notas, d.version ?? null, cat ? cat.cat_modelo_id : (d.cat_modelo_id ?? null), cat ? cat.cat_version_id : (d.cat_version_id ?? null)),
    ...vincular.map((x) => sentenciaVincular(c.env.DB, s, id, x.cliente_id, x.relacion ?? null)),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'vehiculo', id, 'crear', { patente, clientes: vincular.length }),
  ]);
  return c.json(limpiarDocumento(s, (await first(c.env.DB, `${selectVehiculo(tiene(s, 'clientes.ver'))} WHERE v.taller_id = ? AND v.id = ?`, s.tallerId, id))!), 201);
});

maestros.put('/vehiculos/:id', requirePerm('vehiculos.editar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, zVehiculo.partial());
  const v = await delTaller<{ km_actual: number }>(c.env.DB, 'vehiculos', s.tallerId, id, 'km_actual');
  if (!v) throw notFound('Vehículo');
  const cat = await resolverCatalogo(c.env.DB, s.tallerId, d);
  if (!cat) {
    await validarMarcaModelo(c.env.DB, s.tallerId, d.marca_id, d.modelo_id);
    await validarIdsCatalogo(c.env.DB, d);
  }
  const datos: Record<string, unknown> = { ...d };
  if (cat) Object.assign(datos, cat);
  if (d.patente) datos.patente = normalizarPatente(d.patente);
  if (d.km_actual !== undefined && d.km_actual < v.km_actual) throw badRequest(`El kilometraje no puede ser menor al registrado (${v.km_actual} km)`);
  const st = updateParcial(c.env.DB, 'vehiculos', s.tallerId, id, datos, ['patente', 'marca_id', 'modelo_id', 'anio', 'color', 'vin', 'motor', 'combustible', 'km_actual', 'notas', 'version', 'cat_modelo_id', 'cat_version_id']);
  if (st) await c.env.DB.batch([st, auditar(c.env.DB, s.tallerId, s.usuarioId, 'vehiculo', id, 'modificar')]);
  return c.json(limpiarDocumento(s, (await first(c.env.DB, `${selectVehiculo(tiene(s, 'clientes.ver'))} WHERE v.taller_id = ? AND v.id = ?`, s.tallerId, id))!));
});

// ───────────── Clientes vinculados a un vehículo ─────────────
// Ver los vínculos (nombres y teléfonos) exige poder ver clientes; modificarlos, poder editar vehículos. Los vínculos cerrados se conservan como historial.
const zVinculo = z.object({ cliente_id: zId, relacion: zRelacion });
const respuestaVinculos = async (c: Context<AppEnv>, vehiculoId: string) => {
  const r = await vinculosDeVehiculo(c.env.DB, c.get('sesion').tallerId, vehiculoId, { contacto: true });
  return { vigentes: r.vigentes, anteriores: r.anteriores };
};

maestros.get('/vehiculos/:id/clientes', requirePerm('vehiculos.ver', 'clientes.ver'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  if (!(await delTaller(c.env.DB, 'vehiculos', s.tallerId, id, 'id'))) throw notFound('Vehículo');
  return c.json(await respuestaVinculos(c, id));
});

maestros.post('/vehiculos/:id/clientes', requirePerm('vehiculos.editar', 'clientes.ver'), async (c) => {
  const d = await body(c, zVinculo);
  await vincularCliente(c.env.DB, c.get('sesion'), c.req.param('id'), d.cliente_id, d.relacion ?? null);
  return c.json(await respuestaVinculos(c, c.req.param('id')), 201);
});

maestros.put('/vehiculos/:id/clientes/:vinculoId', requirePerm('vehiculos.editar', 'clientes.ver'), async (c) => {
  const d = await body(c, z.object({ relacion: zRelacion }));
  await cambiarRelacion(c.env.DB, c.get('sesion'), c.req.param('id'), c.req.param('vinculoId'), d.relacion ?? null);
  return c.json(await respuestaVinculos(c, c.req.param('id')));
});

maestros.delete('/vehiculos/:id/clientes/:vinculoId', requirePerm('vehiculos.editar', 'clientes.ver'), async (c) => {
  await desvincularCliente(c.env.DB, c.get('sesion'), c.req.param('id'), c.req.param('vinculoId'));
  return c.json(await respuestaVinculos(c, c.req.param('id')));
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
