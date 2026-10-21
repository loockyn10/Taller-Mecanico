// Tempario: tarifas de mano de obra, tiempos específicos por vehículo y plantilla general de operaciones.
// Las operaciones son los servicios del taller (catalogo.ts); acá se completan con lo propio del tempario. Cada taller guarda y
// configura lo suyo: la plantilla general es de solo lectura y se COPIA al taller (nunca se comparte ni se enlaza).
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, notFound, query, zId } from '../lib/http';
import { all, auditar, delTaller, first, uid, type Stmt } from '../lib/db';
import { requirePerm } from '../lib/auth';
import { AVISO_TIEMPOS_ORIENTATIVOS, PLANTILLA_TEMPARIO, normalizarTexto, resolverTiempo, type ReglaTiempo } from '../../shared/tempario';

export const tempario = new Hono<AppEnv>();

// ───────────── Tarifas de mano de obra ─────────────
// La tarifa es un precio de venta: se consulta con permiso de precios y se modifica con el de gestión de precios.
tempario.get('/tarifas', requirePerm('catalogo.ver', 'precios.venta.ver'), async (c) => {
  const s = c.get('sesion');
  const cfg = await first<{ tarifa_hora: number }>(c.env.DB, 'SELECT tarifa_hora FROM taller_config WHERE taller_id = ?', s.tallerId);
  const categorias = await all(c.env.DB, 'SELECT id, nombre, tarifa_hora FROM categorias_servicio WHERE taller_id = ? ORDER BY orden, nombre', s.tallerId);
  return c.json({ tarifa_hora: cfg?.tarifa_hora ?? 0, categorias });
});

tempario.put('/tarifas', requirePerm('precios.gestionar', 'catalogo.editar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(
    c,
    z.object({
      tarifa_hora: z.number().int().min(0).max(1e10),
      categorias: z.array(z.object({ id: zId, tarifa_hora: z.number().int().min(0).max(1e10).nullable() })).max(100).default([]),
    }),
  );
  for (const cat of d.categorias) if (!(await delTaller(c.env.DB, 'categorias_servicio', s.tallerId, cat.id, 'id'))) throw badRequest('Categoría inexistente');
  const stmts: Stmt[] = [
    c.env.DB.prepare('INSERT INTO taller_config (taller_id, tarifa_hora) VALUES (?, ?) ON CONFLICT (taller_id) DO UPDATE SET tarifa_hora = excluded.tarifa_hora').bind(s.tallerId, d.tarifa_hora),
    ...d.categorias.map((cat) => c.env.DB.prepare('UPDATE categorias_servicio SET tarifa_hora = ? WHERE taller_id = ? AND id = ?').bind(cat.tarifa_hora, s.tallerId, cat.id)),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'tempario', null, 'tarifas', { tarifa_hora: d.tarifa_hora, categorias: d.categorias.length }),
  ];
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

// ───────────── Tiempos específicos ─────────────
const SELECT_REGLA = `SELECT t.id, t.servicio_id, t.marca_id, t.modelo_id, t.motor, t.anio_desde, t.anio_hasta, t.tiempo_min, t.notas, ma.nombre AS marca, mo.nombre AS modelo
  FROM servicio_tiempos t LEFT JOIN marcas ma ON ma.taller_id = t.taller_id AND ma.id = t.marca_id LEFT JOIN modelos mo ON mo.taller_id = t.taller_id AND mo.id = t.modelo_id`;

tempario.get('/servicios/:id/tiempos', requirePerm('catalogo.ver'), async (c) => {
  const s = c.get('sesion');
  if (!(await delTaller(c.env.DB, 'servicios', s.tallerId, c.req.param('id'), 'id'))) throw notFound('Operación');
  return c.json(await all(c.env.DB, `${SELECT_REGLA} WHERE t.taller_id = ? AND t.servicio_id = ? ORDER BY ma.nombre, mo.nombre, t.anio_desde`, s.tallerId, c.req.param('id')));
});

const zRegla = z.object({
  marca_id: zId.nullish(),
  modelo_id: zId.nullish(),
  motor: z.string().trim().max(60).nullish().transform((v) => v || null),
  anio_desde: z.number().int().min(1900).max(2100).nullish(),
  anio_hasta: z.number().int().min(1900).max(2100).nullish(),
  tiempo_min: z.number().int().min(1).max(6000),
  notas: z.string().trim().max(300).nullish().transform((v) => v || null),
});

/** Normaliza y valida una regla: al menos un criterio, modelo de la marca indicada, años coherentes. */
async function validarRegla(db: D1Database, tallerId: string, d: z.infer<typeof zRegla>) {
  let marcaId = d.marca_id ?? null;
  const modeloId = d.modelo_id ?? null;
  if (modeloId) {
    const m = await delTaller<{ marca_id: string }>(db, 'modelos', tallerId, modeloId, 'marca_id');
    if (!m) throw badRequest('Modelo inexistente');
    if (marcaId && marcaId !== m.marca_id) throw badRequest('El modelo no corresponde a la marca');
    marcaId = m.marca_id;
  }
  if (marcaId && !(await delTaller(db, 'marcas', tallerId, marcaId, 'id'))) throw badRequest('Marca inexistente');
  if (!marcaId && !modeloId && !d.motor && d.anio_desde == null && d.anio_hasta == null) throw badRequest('Indicá al menos un criterio: marca, modelo, motorización o años');
  if (d.anio_desde != null && d.anio_hasta != null && d.anio_hasta < d.anio_desde) throw badRequest('El año final no puede ser anterior al inicial');
  return { marca_id: marcaId, modelo_id: modeloId };
}

tempario.post('/servicios/:id/tiempos', requirePerm('catalogo.editar'), async (c) => {
  const s = c.get('sesion');
  const servicioId = c.req.param('id');
  const d = await body(c, zRegla);
  if (!(await delTaller(c.env.DB, 'servicios', s.tallerId, servicioId, 'id'))) throw notFound('Operación');
  const ref = await validarRegla(c.env.DB, s.tallerId, d);
  const id = uid();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO servicio_tiempos (id, taller_id, servicio_id, marca_id, modelo_id, motor, anio_desde, anio_hasta, tiempo_min, notas) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(id, s.tallerId, servicioId, ref.marca_id, ref.modelo_id, d.motor, d.anio_desde ?? null, d.anio_hasta ?? null, d.tiempo_min, d.notas),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'tempario', servicioId, 'tiempo_especifico', { regla: id, tiempo_min: d.tiempo_min }),
  ]);
  return c.json({ id }, 201);
});

tempario.put('/tiempos/:rid', requirePerm('catalogo.editar'), async (c) => {
  const s = c.get('sesion');
  const rid = c.req.param('rid');
  const d = await body(c, zRegla);
  const actual = await delTaller<{ servicio_id: string }>(c.env.DB, 'servicio_tiempos', s.tallerId, rid, 'servicio_id');
  if (!actual) throw notFound('Tiempo específico');
  const ref = await validarRegla(c.env.DB, s.tallerId, d);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE servicio_tiempos SET marca_id = ?, modelo_id = ?, motor = ?, anio_desde = ?, anio_hasta = ?, tiempo_min = ?, notas = ? WHERE taller_id = ? AND id = ?')
      .bind(ref.marca_id, ref.modelo_id, d.motor, d.anio_desde ?? null, d.anio_hasta ?? null, d.tiempo_min, d.notas, s.tallerId, rid),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'tempario', actual.servicio_id, 'tiempo_especifico', { regla: rid, tiempo_min: d.tiempo_min }),
  ]);
  return c.json({ ok: true });
});

tempario.delete('/tiempos/:rid', requirePerm('catalogo.editar'), async (c) => {
  const s = c.get('sesion');
  const r = await c.env.DB.prepare('DELETE FROM servicio_tiempos WHERE taller_id = ? AND id = ?').bind(s.tallerId, c.req.param('rid')).run();
  if (!r.meta.changes) throw notFound('Tiempo específico');
  return c.json({ ok: true });
});

/** Tiempo de una operación para un vehículo (el específico más preciso o, si no hay, el genérico). */
tempario.get('/estimar', requirePerm('catalogo.ver'), async (c) => {
  const s = c.get('sesion');
  const { servicio_id, vehiculo_id } = query(c, z.object({ servicio_id: zId, vehiculo_id: zId.optional() }));
  const srv = await first<{ tiempo_min: number | null }>(c.env.DB, 'SELECT tiempo_min FROM servicios WHERE taller_id = ? AND id = ?', s.tallerId, servicio_id);
  if (!srv) throw notFound('Operación');
  const veh = vehiculo_id ? await first<{ marca_id: string | null; modelo_id: string | null; motor: string | null; anio: number | null }>(c.env.DB, 'SELECT marca_id, modelo_id, motor, anio FROM vehiculos WHERE taller_id = ? AND id = ?', s.tallerId, vehiculo_id) : null;
  if (vehiculo_id && !veh) throw notFound('Vehículo');
  const reglas = await all<ReglaTiempo>(c.env.DB, 'SELECT id, marca_id, modelo_id, motor, anio_desde, anio_hasta, tiempo_min FROM servicio_tiempos WHERE taller_id = ? AND servicio_id = ? ORDER BY created_at', s.tallerId, servicio_id);
  return c.json(resolverTiempo(srv.tiempo_min, reglas, veh));
});

// ───────────── Plantilla general (orientativa) ─────────────
type Estado = 'nueva' | 'completa_tiempo' | 'existente';
async function analizarPlantilla(db: D1Database, tallerId: string) {
  const existentes = await all<{ id: string; nombre: string; codigo: string | null; tiempo_min: number | null }>(db, 'SELECT id, nombre, codigo, tiempo_min FROM servicios WHERE taller_id = ?', tallerId);
  const porCodigo = new Map(existentes.filter((e) => e.codigo).map((e) => [normalizarTexto(e.codigo), e]));
  const porNombre = new Map(existentes.map((e) => [normalizarTexto(e.nombre), e]));
  return PLANTILLA_TEMPARIO.map((o) => {
    const ex = porCodigo.get(normalizarTexto(o.codigo)) ?? porNombre.get(normalizarTexto(o.nombre)) ?? null;
    const estado: Estado = !ex ? 'nueva' : ex.tiempo_min == null ? 'completa_tiempo' : 'existente';
    return { ...o, estado, servicio_id: ex?.id ?? null };
  });
}

tempario.get('/plantilla', requirePerm('catalogo.ver'), async (c) => {
  const s = c.get('sesion');
  return c.json({ aviso: AVISO_TIEMPOS_ORIENTATIVOS, operaciones: await analizarPlantilla(c.env.DB, s.tallerId) });
});

/**
 * Copia la plantilla al taller. Las operaciones nuevas se crean con su tiempo orientativo y precio calculado por tiempo (según la
 * tarifa del taller); a las que el taller ya tenía (mismo código o nombre) solo se les completa el tiempo si no lo tenían: no se pisa
 * ningún precio, tiempo ni dato ya cargado.
 */
tempario.post('/plantilla/importar', requirePerm('catalogo.editar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, z.object({ codigos: z.array(z.string().max(30)).max(200).optional() }));
  const analisis = await analizarPlantilla(c.env.DB, s.tallerId);
  const elegidas = analisis.filter((o) => !d.codigos || d.codigos.includes(o.codigo));
  const codigosUsados = new Set((await all<{ codigo: string }>(c.env.DB, "SELECT codigo FROM servicios WHERE taller_id = ? AND codigo IS NOT NULL AND codigo <> ''", s.tallerId)).map((x) => normalizarTexto(x.codigo)));
  const stmts: Stmt[] = [];
  let creadas = 0;
  let completadas = 0;
  const categorias = new Set<string>();
  for (const o of elegidas) {
    if (o.estado === 'existente') continue;
    if (o.estado === 'completa_tiempo') {
      completadas++;
      const poneCodigo = !codigosUsados.has(normalizarTexto(o.codigo));
      if (poneCodigo) codigosUsados.add(normalizarTexto(o.codigo));
      stmts.push(
        c.env.DB.prepare(`UPDATE servicios SET tiempo_min = ?, origen = 'plantilla'${poneCodigo ? ", codigo = COALESCE(NULLIF(codigo, ''), ?)" : ''} WHERE taller_id = ? AND id = ? AND tiempo_min IS NULL`)
          .bind(...[o.tiempo_min, ...(poneCodigo ? [o.codigo] : []), s.tallerId, o.servicio_id]),
      );
      continue;
    }
    creadas++;
    if (!categorias.has(o.categoria)) {
      categorias.add(o.categoria);
      stmts.push(
        c.env.DB.prepare('INSERT OR IGNORE INTO categorias_servicio (id, taller_id, nombre, orden) VALUES (?, ?, ?, (SELECT COALESCE(MAX(orden), -1) + 1 FROM categorias_servicio WHERE taller_id = ?))')
          .bind(uid(), s.tallerId, o.categoria, s.tallerId),
      );
    }
    const codigoLibre = !codigosUsados.has(normalizarTexto(o.codigo));
    if (codigoLibre) codigosUsados.add(normalizarTexto(o.codigo));
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO servicios (id, taller_id, categoria_id, codigo, nombre, descripcion, precio, tiempo_min, modo_precio, origen, intervalo_km, intervalo_meses)
         VALUES (?, ?, (SELECT id FROM categorias_servicio WHERE taller_id = ? AND nombre = ?), ?, ?, ?, 0, ?, 'por_tiempo', 'plantilla', ?, ?)`,
      ).bind(uid(), s.tallerId, s.tallerId, o.categoria, codigoLibre ? o.codigo : null, o.nombre, o.descripcion ?? null, o.tiempo_min, o.intervalo_km ?? null, o.intervalo_meses ?? null),
    );
  }
  if (!stmts.length) return c.json({ creadas: 0, completadas: 0 });
  stmts.push(auditar(c.env.DB, s.tallerId, s.usuarioId, 'tempario', null, 'importar_plantilla', { creadas, completadas }));
  await c.env.DB.batch(stmts);
  return c.json({ creadas, completadas });
});
