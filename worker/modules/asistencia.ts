// Control de asistencia: fichaje propio, panel del propietario, resúmenes, exportación y correcciones administrativas.
//
// Reglas:
//  * La hora la fija el servidor (UTC). Los horarios se muestran y se agrupan con la zona horaria configurada en el taller.
//  * Una jornada pertenece al día local en que empezó (puede terminar al día siguiente, cruzando la medianoche).
//  * Una persona no puede tener dos jornadas abiertas (índice único en la base). Nadie edita libremente sus registros históricos:
//    las correcciones las hace quien tiene `asistencia.corregir`, nunca sobre sus propios fichajes, y dejan historial inmutable.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Sesion } from '../env';
import { badRequest, body, conflict, forbidden, notFound, query, zFecha, zId } from '../lib/http';
import { all, auditar, first, uid, type Stmt } from '../lib/db';
import { requirePerm } from '../lib/auth';
import { autorizarExportacion } from '../lib/exportar';
import { JORNADA_LARGA_SEG, jornadaAbierta, registrarEntrada, registrarSalida } from '../lib/asistencia';
import { fechaLocal, instanteDesdeLocal, zonaDelTaller } from '../lib/zona';
import { esRol, leerAjustes, nivelDeRol, permisosEfectivos, type Nivel, type Rol } from '../../shared/permisos';

export const asistencia = new Hono<AppEnv>();

const MAX_JORNADA_SEG = 24 * 3600;

/** Fecha local de hoy en la zona del taller. */
const hoyLocal = (zona: string) => fechaLocal(new Date(), zona);

// ───────────── Fichaje propio ─────────────
asistencia.get('/mia', requirePerm('asistencia.fichar'), async (c) => {
  const s = c.get('sesion');
  const zona = await zonaDelTaller(c.env.DB, s.tallerId);
  const hasta = hoyLocal(zona);
  const q = query(c, z.object({ desde: zFecha.optional(), hasta: zFecha.optional() }));
  const desde = q.desde ?? new Date(Date.parse(`${hasta}T12:00:00Z`) - 31 * 86400_000).toISOString().slice(0, 10);
  const jornadas = await all<any>(
    c.env.DB,
    `SELECT id, fecha, entrada_at, salida_at, duracion_seg, origen_entrada, origen_salida, corregido FROM asistencias
      WHERE taller_id = ? AND usuario_id = ? AND anulado = 0 AND fecha BETWEEN ? AND ? ORDER BY entrada_at DESC LIMIT 400`,
    s.tallerId, s.usuarioId, desde, q.hasta ?? hasta,
  );
  const abierta = await jornadaAbierta(c.env.DB, s.tallerId, s.usuarioId);
  const ahoraMs = Date.now();
  const hoyStr = hoyLocal(zona);
  const horasHoy = jornadas
    .filter((j) => j.fecha === hoyStr)
    .reduce((a, j) => a + (j.duracion_seg ?? Math.max(0, Math.floor((ahoraMs - Date.parse(j.entrada_at)) / 1000))), 0);
  return c.json({ zona, ahora: new Date(ahoraMs).toISOString(), hoy: hoyStr, abierta, horas_hoy_seg: horasHoy, jornadas });
});

asistencia.post('/entrada', requirePerm('asistencia.fichar'), async (c) => {
  const s = c.get('sesion');
  const j = await registrarEntrada(c.env.DB, s.tallerId, s.usuarioId, 'app');
  return c.json(j, 201);
});

asistencia.post('/salida', requirePerm('asistencia.fichar'), async (c) => {
  const s = c.get('sesion');
  return c.json(await registrarSalida(c.env.DB, s.tallerId, s.usuarioId, 'app'));
});

// ───────────── Panel del propietario ─────────────
interface PersonaFila { id: string; nombre: string; apellido: string | null; cargo: string | null; rol: Nivel; plantilla: string | null; permisos_ajustes: string | null }

/** Personal activo que ficha (tiene el permiso de asistencia.fichar). */
async function personalQueFicha(db: D1Database, tallerId: string) {
  const filas = await all<PersonaFila>(db, 'SELECT id, nombre, apellido, cargo, rol, plantilla, permisos_ajustes FROM usuarios WHERE taller_id = ? AND activo = 1 ORDER BY nombre COLLATE NOCASE', tallerId);
  return filas.filter((u) => {
    const rol: Rol = esRol(u.plantilla) && nivelDeRol(u.plantilla) === u.rol ? u.plantilla : u.rol;
    return permisosEfectivos(rol, leerAjustes(u.permisos_ajustes)).includes('asistencia.fichar');
  });
}

const nombreDe = (u: { nombre: string; apellido: string | null }) => (u.apellido ? `${u.nombre} ${u.apellido}` : u.nombre);

const SELECT_JORNADA = `SELECT a.id, a.usuario_id, a.fecha, a.entrada_at, a.salida_at, a.duracion_seg, a.origen_entrada, a.origen_salida, a.corregido, a.anulado, a.notas,
    u.nombre AS u_nombre, u.apellido AS u_apellido, u.cargo AS u_cargo,
    (SELECT COUNT(*) FROM asistencia_correcciones k WHERE k.taller_id = a.taller_id AND k.asistencia_id = a.id) AS correcciones
  FROM asistencias a JOIN usuarios u ON u.taller_id = a.taller_id AND u.id = a.usuario_id`;

function presentarJornada(j: any, ahoraMs: number) {
  const abierta = !j.salida_at;
  const seg = j.duracion_seg ?? (abierta ? Math.max(0, Math.floor((ahoraMs - Date.parse(j.entrada_at)) / 1000)) : 0);
  const { u_nombre, u_apellido, u_cargo, ...resto } = j;
  return { ...resto, empleado: nombreDe({ nombre: u_nombre, apellido: u_apellido }), cargo: u_cargo, abierta, duracion_actual_seg: seg, larga: abierta && seg > JORNADA_LARGA_SEG };
}

asistencia.get('/panel', requirePerm('asistencia.ver'), async (c) => {
  const s = c.get('sesion');
  const zona = await zonaDelTaller(c.env.DB, s.tallerId);
  const q = query(c, z.object({ fecha: zFecha.optional() }));
  const hoyStr = hoyLocal(zona);
  const fecha = q.fecha ?? hoyStr;
  const ahoraMs = Date.now();
  const [personal, abiertas, delDia] = await Promise.all([
    personalQueFicha(c.env.DB, s.tallerId),
    all(c.env.DB, `${SELECT_JORNADA} WHERE a.taller_id = ? AND a.salida_at IS NULL AND a.anulado = 0 ORDER BY a.entrada_at`, s.tallerId),
    all(c.env.DB, `${SELECT_JORNADA} WHERE a.taller_id = ? AND a.fecha = ? AND a.anulado = 0 ORDER BY a.entrada_at`, s.tallerId, fecha),
  ]);
  const abiertasP = abiertas.map((j) => presentarJornada(j, ahoraMs));
  const delDiaP = delDia.map((j) => presentarJornada(j, ahoraMs));
  const presentesIds = new Set(abiertasP.map((j: any) => j.usuario_id));
  const conJornadaDia = new Set(delDiaP.map((j: any) => j.usuario_id));
  const ausentes = personal
    .filter((u) => !presentesIds.has(u.id) && !conJornadaDia.has(u.id))
    .map((u) => ({ usuario_id: u.id, empleado: nombreDe(u), cargo: u.cargo }));
  return c.json({
    zona,
    hoy: hoyStr,
    fecha,
    ahora: new Date(ahoraMs).toISOString(),
    presentes: abiertasP,
    ausentes,
    jornadas: delDiaP,
    totales: {
      personal: personal.length,
      presentes: abiertasP.length,
      ausentes: ausentes.length,
      jornadas_abiertas: abiertasP.length,
      jornadas_largas: abiertasP.filter((j: any) => j.larga).length,
      horas_dia_seg: delDiaP.reduce((a: number, j: any) => a + j.duracion_actual_seg, 0),
    },
  });
});

const zRango = z.object({ desde: zFecha, hasta: zFecha, usuario_id: zId.optional() });

asistencia.get('/registros', requirePerm('asistencia.ver'), async (c) => {
  const s = c.get('sesion');
  const f = query(c, zRango.extend({ anulados: z.string().optional(), abiertas: z.string().optional() }));
  if (f.desde > f.hasta) throw badRequest('El período es inválido');
  await autorizarExportacion(c, 'asistencia-registros');
  const cond = ['a.taller_id = ?', 'a.fecha BETWEEN ? AND ?'];
  const params: unknown[] = [s.tallerId, f.desde, f.hasta];
  if (f.usuario_id) (cond.push('a.usuario_id = ?'), params.push(f.usuario_id));
  if (!f.anulados) cond.push('a.anulado = 0');
  if (f.abiertas) cond.push('a.salida_at IS NULL');
  const filas = await all(c.env.DB, `${SELECT_JORNADA} WHERE ${cond.join(' AND ')} ORDER BY a.entrada_at DESC LIMIT 2000`, ...params);
  const zona = await zonaDelTaller(c.env.DB, s.tallerId);
  const ahoraMs = Date.now();
  return c.json({ zona, desde: f.desde, hasta: f.hasta, filas: filas.map((j) => presentarJornada(j, ahoraMs)) });
});

asistencia.get('/resumen', requirePerm('asistencia.ver'), async (c) => {
  const s = c.get('sesion');
  const f = query(c, zRango.extend({ agrupar: z.enum(['empleado', 'dia']).default('empleado') }));
  if (f.desde > f.hasta) throw badRequest('El período es inválido');
  await autorizarExportacion(c, 'asistencia-resumen');
  const cond = ['a.taller_id = ?', 'a.fecha BETWEEN ? AND ?', 'a.anulado = 0'];
  const params: unknown[] = [s.tallerId, f.desde, f.hasta];
  if (f.usuario_id) (cond.push('a.usuario_id = ?'), params.push(f.usuario_id));
  const filas = await all<any>(c.env.DB, `${SELECT_JORNADA} WHERE ${cond.join(' AND ')} ORDER BY a.entrada_at`, ...params);
  const zona = await zonaDelTaller(c.env.DB, s.tallerId);
  const ahoraMs = Date.now();
  const js = filas.map((j) => presentarJornada(j, ahoraMs));
  // Las horas de una jornada se atribuyen al día en que empezó. Las jornadas abiertas cuentan hasta ahora y se informan aparte.
  const porClave = new Map<string, { clave: string; usuario_id: string; empleado: string; cargo: string | null; fecha?: string; jornadas: number; dias: Set<string>; horas_seg: number; abiertas: number; corregidas: number }>();
  for (const j of js as any[]) {
    const clave = f.agrupar === 'dia' ? `${j.fecha}|${j.usuario_id}` : j.usuario_id;
    const x = porClave.get(clave) ?? { clave, usuario_id: j.usuario_id, empleado: j.empleado, cargo: j.cargo, fecha: f.agrupar === 'dia' ? j.fecha : undefined, jornadas: 0, dias: new Set<string>(), horas_seg: 0, abiertas: 0, corregidas: 0 };
    x.jornadas++;
    x.dias.add(j.fecha);
    x.horas_seg += j.duracion_actual_seg;
    if (j.abierta) x.abiertas++;
    if (j.corregido) x.corregidas++;
    porClave.set(clave, x);
  }
  const resultado = [...porClave.values()]
    .map(({ dias, clave: _c, ...x }) => ({ ...x, dias: dias.size, promedio_seg: dias.size ? Math.round(x.horas_seg / dias.size) : 0 }))
    .sort((a, b) => (a.fecha ?? '').localeCompare(b.fecha ?? '') || a.empleado.localeCompare(b.empleado));
  return c.json({
    zona, desde: f.desde, hasta: f.hasta, agrupar: f.agrupar, filas: resultado,
    totales: { jornadas: resultado.reduce((a, x) => a + x.jornadas, 0), horas_seg: resultado.reduce((a, x) => a + x.horas_seg, 0), abiertas: resultado.reduce((a, x) => a + x.abiertas, 0) },
  });
});

// ───────────── Correcciones administrativas ─────────────
const zHora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'hora inválida (HH:MM)');
const zMotivo = z.string().trim().min(5, 'explicá el motivo de la corrección (mínimo 5 caracteres)').max(300);

async function exigirPuedeCorregir(db: D1Database, s: Sesion, usuarioId: string) {
  const u = await first<{ rol: Nivel }>(db, 'SELECT rol FROM usuarios WHERE taller_id = ? AND id = ?', s.tallerId, usuarioId);
  if (!u) throw notFound('Empleado');
  if (usuarioId === s.usuarioId && s.nivel !== 'propietario') throw forbidden('No podés corregir tus propios fichajes: pedile a otra persona autorizada');
  if (u.rol === 'propietario' && s.nivel !== 'propietario') throw forbidden('Solo el propietario puede corregir sus propios fichajes');
}

async function haySolape(db: D1Database, tallerId: string, usuarioId: string, entrada: string, salida: string | null, excluirId: string | null) {
  return !!(await first(
    db,
    `SELECT 1 FROM asistencias WHERE taller_id = ? AND usuario_id = ? AND anulado = 0 AND id <> ? AND entrada_at < ? AND COALESCE(salida_at, '9999-12-31T00:00:00Z') > ?`,
    tallerId, usuarioId, excluirId ?? '', salida ?? '9999-12-31T00:00:00Z', entrada,
  ));
}

const estadoDe = (j: { entrada_at: string; salida_at: string | null; duracion_seg: number | null; fecha: string }) => ({ fecha: j.fecha, entrada_at: j.entrada_at, salida_at: j.salida_at, duracion_seg: j.duracion_seg });

/** Valida y resuelve entrada y salida (fecha y hora locales del taller) a instantes UTC. */
function resolverInstantes(zona: string, e: { fecha: string; hora: string }, sal: { fecha: string; hora: string } | null) {
  const entrada = instanteDesdeLocal(e.fecha, e.hora, zona);
  const salida = sal ? instanteDesdeLocal(sal.fecha, sal.hora, zona) : null;
  const ahora = Date.now();
  if (entrada.getTime() > ahora) throw badRequest('La entrada no puede ser futura');
  if (salida) {
    if (salida.getTime() > ahora) throw badRequest('La salida no puede ser futura');
    if (salida <= entrada) throw badRequest('La salida debe ser posterior a la entrada');
    if ((salida.getTime() - entrada.getTime()) / 1000 > MAX_JORNADA_SEG) throw badRequest('Una jornada no puede superar las 24 horas');
  }
  return { entrada, salida, fecha: fechaLocal(entrada, zona), duracion: salida ? Math.floor((salida.getTime() - entrada.getTime()) / 1000) : null };
}

const zMomento = z.object({ fecha: zFecha, hora: zHora });

asistencia.post('/registros', requirePerm('asistencia.corregir'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, z.object({ usuario_id: zId, entrada: zMomento, salida: zMomento.nullish(), motivo: zMotivo }));
  await exigirPuedeCorregir(c.env.DB, s, d.usuario_id);
  const zona = await zonaDelTaller(c.env.DB, s.tallerId);
  const r = resolverInstantes(zona, d.entrada, d.salida ?? null);
  if (await haySolape(c.env.DB, s.tallerId, d.usuario_id, r.entrada.toISOString(), r.salida?.toISOString() ?? null, null)) throw conflict('El horario se superpone con otra jornada de esa persona', 'solape');
  const id = uid();
  const nuevo = { fecha: r.fecha, entrada_at: r.entrada.toISOString(), salida_at: r.salida?.toISOString() ?? null, duracion_seg: r.duracion };
  const stmts: Stmt[] = [
    c.env.DB.prepare(
      `INSERT INTO asistencias (id, taller_id, usuario_id, fecha, entrada_at, salida_at, duracion_seg, origen_entrada, origen_salida, corregido, notas) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, 1, ?)`,
    ).bind(id, s.tallerId, d.usuario_id, r.fecha, nuevo.entrada_at, nuevo.salida_at, r.duracion, r.salida ? 'manual' : null, d.motivo),
    c.env.DB.prepare('INSERT INTO asistencia_correcciones (id, taller_id, asistencia_id, usuario_id, accion, anterior, nuevo, motivo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(uid(), s.tallerId, id, s.usuarioId, 'crear', null, JSON.stringify(nuevo), d.motivo),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'asistencia', id, 'crear_manual', { empleado: d.usuario_id, motivo: d.motivo }),
  ];
  await c.env.DB.batch(stmts);
  return c.json({ id }, 201);
});

asistencia.patch('/registros/:id', requirePerm('asistencia.corregir'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, z.object({ entrada: zMomento.optional(), salida: zMomento.optional(), motivo: zMotivo }));
  if (!d.entrada && !d.salida) throw badRequest('Indicá qué horario corregir');
  const j = await first<{ id: string; usuario_id: string; fecha: string; entrada_at: string; salida_at: string | null; duracion_seg: number | null; anulado: number }>(
    c.env.DB, 'SELECT id, usuario_id, fecha, entrada_at, salida_at, duracion_seg, anulado FROM asistencias WHERE taller_id = ? AND id = ?', s.tallerId, id,
  );
  if (!j) throw notFound('Registro de asistencia');
  if (j.anulado) throw conflict('El registro está anulado');
  await exigirPuedeCorregir(c.env.DB, s, j.usuario_id);
  const zona = await zonaDelTaller(c.env.DB, s.tallerId);
  const partesActuales = (iso: string) => ({ fecha: fechaLocal(iso, zona), hora: new Intl.DateTimeFormat('en-GB', { timeZone: zona, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)) });
  const entrada = d.entrada ?? partesActuales(j.entrada_at);
  const salida = d.salida ?? (j.salida_at ? partesActuales(j.salida_at) : null);
  const r = resolverInstantes(zona, entrada, salida);
  const nuevo = { fecha: r.fecha, entrada_at: r.entrada.toISOString(), salida_at: r.salida?.toISOString() ?? null, duracion_seg: r.duracion };
  if (nuevo.entrada_at === j.entrada_at && nuevo.salida_at === j.salida_at) throw badRequest('La corrección no cambia ningún horario');
  if (await haySolape(c.env.DB, s.tallerId, j.usuario_id, nuevo.entrada_at, nuevo.salida_at, id)) throw conflict('El horario se superpone con otra jornada de esa persona', 'solape');
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE asistencias SET fecha = ?, entrada_at = ?, salida_at = ?, duracion_seg = ?, origen_salida = CASE WHEN ? IS NULL THEN origen_salida ELSE COALESCE(origen_salida, 'manual') END, corregido = 1
        WHERE taller_id = ? AND id = ? AND anulado = 0`,
    ).bind(nuevo.fecha, nuevo.entrada_at, nuevo.salida_at, nuevo.duracion_seg, nuevo.salida_at, s.tallerId, id),
    c.env.DB.prepare('INSERT INTO asistencia_correcciones (id, taller_id, asistencia_id, usuario_id, accion, anterior, nuevo, motivo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(uid(), s.tallerId, id, s.usuarioId, 'editar', JSON.stringify(estadoDe(j)), JSON.stringify(nuevo), d.motivo),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'asistencia', id, 'corregir', { motivo: d.motivo }),
  ]);
  return c.json({ ok: true });
});

asistencia.post('/registros/:id/anular', requirePerm('asistencia.corregir'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, z.object({ motivo: zMotivo }));
  const j = await first<{ id: string; usuario_id: string; fecha: string; entrada_at: string; salida_at: string | null; duracion_seg: number | null; anulado: number }>(
    c.env.DB, 'SELECT id, usuario_id, fecha, entrada_at, salida_at, duracion_seg, anulado FROM asistencias WHERE taller_id = ? AND id = ?', s.tallerId, id,
  );
  if (!j) throw notFound('Registro de asistencia');
  if (j.anulado) throw conflict('El registro ya está anulado');
  await exigirPuedeCorregir(c.env.DB, s, j.usuario_id);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE asistencias SET anulado = 1, corregido = 1 WHERE taller_id = ? AND id = ? AND anulado = 0').bind(s.tallerId, id),
    c.env.DB.prepare('INSERT INTO asistencia_correcciones (id, taller_id, asistencia_id, usuario_id, accion, anterior, nuevo, motivo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(uid(), s.tallerId, id, s.usuarioId, 'anular', JSON.stringify(estadoDe(j)), null, d.motivo),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'asistencia', id, 'anular', { motivo: d.motivo }),
  ]);
  return c.json({ ok: true });
});

asistencia.get('/registros/:id/correcciones', requirePerm('asistencia.ver'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  if (!(await first(c.env.DB, 'SELECT 1 FROM asistencias WHERE taller_id = ? AND id = ?', s.tallerId, id))) throw notFound('Registro de asistencia');
  const filas = await all<any>(
    c.env.DB,
    `SELECT k.id, k.accion, k.anterior, k.nuevo, k.motivo, k.created_at, u.nombre AS u_nombre, u.apellido AS u_apellido
       FROM asistencia_correcciones k JOIN usuarios u ON u.taller_id = k.taller_id AND u.id = k.usuario_id
      WHERE k.taller_id = ? AND k.asistencia_id = ? ORDER BY k.created_at`,
    s.tallerId, id,
  );
  return c.json(filas.map(({ u_nombre, u_apellido, anterior, nuevo, ...k }) => ({ ...k, usuario: nombreDe({ nombre: u_nombre, apellido: u_apellido }), anterior: anterior ? JSON.parse(anterior) : null, nuevo: nuevo ? JSON.parse(nuevo) : null })));
});

/** Personal que ficha, para los filtros del panel. */
asistencia.get('/personal', requirePerm('asistencia.ver'), async (c) => {
  const s = c.get('sesion');
  return c.json((await personalQueFicha(c.env.DB, s.tallerId)).map((u) => ({ id: u.id, nombre: nombreDe(u), cargo: u.cargo })));
});

