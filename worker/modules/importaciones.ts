// Importación de datos desde Excel/CSV. El navegador lee el archivo y envía las filas por lotes; el servidor valida TODO de nuevo, aplica cada
// lote de forma atómica y deja registro de quién importó qué. Nada se escribe en la validación previa.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ApiError, badRequest, body, conflict, notFound, zId } from '../lib/http';
import { all, auditar, ahora, first, uid } from '../lib/db';
import { requirePerm } from '../lib/auth';
import { LIMITES_IMPORTACION, MODOS_IMPORTACION, TIPOS_IMPORTACION, resumir, type ModoImportacion, type TipoImportacion } from '../../shared/importacion';
import type { Contexto, OpcionesImportacion } from '../lib/importacion/comun';
import { contar, erroresDeLote, exigirPermisos, limpiarFilas, planificar, sentenciasRegistro, validarOpciones } from '../lib/importacion/motor';

export const importaciones = new Hono<AppEnv>();
importaciones.use('*', requirePerm('datos.importar'));

// Un lote de hasta 50 filas con celdas de 500 caracteres no pasa de unos cientos de KB: más que eso no es un lote legítimo.
importaciones.use('*', async (c, next) => {
  if (Number(c.req.header('content-length') ?? 0) > 600_000) throw new ApiError(413, 'demasiado_grande', 'El lote es demasiado grande');
  await next();
});

const zCelda = z.union([z.string().max(LIMITES_IMPORTACION.maxCelda * 2), z.number().finite(), z.null()]);
const zFila = z.object({ n: z.number().int().min(1).max(1_000_000), v: z.record(z.string().max(40), zCelda) });
const zOpciones = z
  .object({
    decimal: z.enum([',', '.']).default(','),
    crear_catalogos: z.boolean().default(true),
    stock_inicial: z.object({ deposito_id: zId.nullish().transform((v) => v ?? null) }).nullish().transform((v) => v ?? null),
  })
  .default({});
const zResoluciones = z.record(z.string().max(220), zId).refine((r) => Object.keys(r).length <= 600, 'Demasiadas resoluciones');
const zTipo = z.enum(TIPOS_IMPORTACION);
const zModo = z.enum(MODOS_IMPORTACION);
const zFilas = z.array(zFila).min(1).max(LIMITES_IMPORTACION.tamanoLote);

interface Trabajo {
  id: string;
  taller_id: string;
  usuario_id: string;
  tipo: TipoImportacion;
  modo: ModoImportacion;
  opciones: string | null;
  archivo_nombre: string;
  archivo_hash: string;
  total_filas: number;
  estado: string;
  procesados: number;
  creados: number;
  actualizados: number;
  omitidos: number;
  errores: number;
  created_at: string;
  finalizada_at: string | null;
}

const leerOpciones = (json: string | null): OpcionesImportacion => zOpciones.parse(json ? JSON.parse(json) : {});

async function cargarTrabajo(db: D1Database, tallerId: string, id: string): Promise<Trabajo> {
  const t = await first<Trabajo>(db, 'SELECT * FROM importaciones WHERE taller_id = ? AND id = ?', tallerId, id);
  if (!t) throw notFound('Importación');
  return t;
}

// ───────────── Validación previa (no escribe nada) ─────────────
importaciones.post('/validar', async (c) => {
  const s = c.get('sesion');
  const d = await body(c, z.object({ tipo: zTipo, modo: zModo, opciones: zOpciones, resoluciones: zResoluciones.default({}), filas: zFilas }));
  const filas = limpiarFilas(d.tipo, d.filas);
  exigirPermisos(s, d.tipo, d.modo, d.opciones, filas);
  await validarOpciones(c.env.DB, s.tallerId, d.tipo, d.opciones);
  const ctx: Contexto = { db: c.env.DB, tallerId: s.tallerId, sesion: s, modo: d.modo, opciones: d.opciones, importacionId: null, resoluciones: d.resoluciones, aplicar: false };
  const plan = await planificar(d.tipo, ctx, filas);
  return c.json({ resultados: plan.resultados, resumen: resumir(plan.resultados) });
});

// ───────────── Historial ─────────────
importaciones.get('/', async (c) => {
  const s = c.get('sesion');
  const rows = await all(
    c.env.DB,
    `SELECT i.id, i.tipo, i.modo, i.archivo_nombre, i.total_filas, i.estado, i.procesados, i.creados, i.actualizados, i.omitidos, i.errores, i.created_at, i.finalizada_at, u.nombre AS usuario
       FROM importaciones i LEFT JOIN usuarios u ON u.taller_id = i.taller_id AND u.id = i.usuario_id
      WHERE i.taller_id = ? ORDER BY i.created_at DESC LIMIT 50`,
    s.tallerId,
  );
  return c.json(rows);
});

importaciones.get('/:id', async (c) => {
  const s = c.get('sesion');
  const t = await cargarTrabajo(c.env.DB, s.tallerId, c.req.param('id'));
  const usuario = await first<{ nombre: string }>(c.env.DB, 'SELECT nombre FROM usuarios WHERE taller_id = ? AND id = ?', s.tallerId, t.usuario_id);
  const lotes = await all<{ lote: number }>(c.env.DB, 'SELECT lote FROM importacion_lotes WHERE taller_id = ? AND importacion_id = ? ORDER BY lote', s.tallerId, t.id);
  const problemas = await all(
    c.env.DB,
    'SELECT fila, severidad, referencia, mensaje FROM importacion_errores WHERE taller_id = ? AND importacion_id = ? ORDER BY fila LIMIT ?',
    s.tallerId, t.id, LIMITES_IMPORTACION.maxErroresGuardados,
  );
  const { opciones, ...resto } = t;
  return c.json({ ...resto, opciones: leerOpciones(opciones), usuario: usuario?.nombre ?? null, lotes_hechos: lotes.map((l) => l.lote), problemas });
});

// ───────────── Alta (o reanudación) de la importación ─────────────
importaciones.post('/', async (c) => {
  const s = c.get('sesion');
  const d = await body(
    c,
    z.object({
      tipo: zTipo,
      modo: zModo,
      opciones: zOpciones,
      archivo: z.object({ nombre: z.string().trim().min(1).max(200), hash: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().min(0).max(LIMITES_IMPORTACION.maxBytesArchivo) }),
      total_filas: z.number().int().min(1).max(LIMITES_IMPORTACION.maxFilas),
      mapeo: z.record(z.string().max(40), z.string().max(120).nullable()).optional(),
    }),
  );
  exigirPermisos(s, d.tipo, d.modo, d.opciones);
  await validarOpciones(c.env.DB, s.tallerId, d.tipo, d.opciones);
  const opcionesJson = JSON.stringify(d.opciones);

  // ¿Hay una importación del mismo archivo y con las mismas opciones a medio hacer? Se continúa: los lotes ya aplicados no se repiten.
  const enCurso = await first<{ id: string }>(
    c.env.DB,
    "SELECT id FROM importaciones WHERE taller_id = ? AND tipo = ? AND archivo_hash = ? AND modo = ? AND opciones = ? AND estado = 'en_curso' ORDER BY created_at DESC LIMIT 1",
    s.tallerId, d.tipo, d.archivo.hash, d.modo, opcionesJson,
  );
  const previa = await first<{ id: string; created_at: string; usuario: string | null; creados: number; actualizados: number }>(
    c.env.DB,
    `SELECT i.id, i.finalizada_at AS created_at, u.nombre AS usuario, i.creados, i.actualizados FROM importaciones i LEFT JOIN usuarios u ON u.taller_id = i.taller_id AND u.id = i.usuario_id
      WHERE i.taller_id = ? AND i.tipo = ? AND i.archivo_hash = ? AND i.estado = 'completada' ORDER BY i.created_at DESC LIMIT 1`,
    s.tallerId, d.tipo, d.archivo.hash,
  );
  if (enCurso) {
    const lotes = await all<{ lote: number }>(c.env.DB, 'SELECT lote FROM importacion_lotes WHERE taller_id = ? AND importacion_id = ? ORDER BY lote', s.tallerId, enCurso.id);
    return c.json({ id: enCurso.id, reanudada: true, lotes_hechos: lotes.map((l) => l.lote), previa }, 200);
  }
  // Las importaciones abandonadas del mismo archivo con otras opciones se dan de baja para que no queden colgadas.
  const id = uid();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE importaciones SET estado = 'cancelada', finalizada_at = ? WHERE taller_id = ? AND tipo = ? AND archivo_hash = ? AND estado = 'en_curso'").bind(ahora(), s.tallerId, d.tipo, d.archivo.hash),
    c.env.DB.prepare(
      `INSERT INTO importaciones (id, taller_id, usuario_id, tipo, modo, opciones, archivo_nombre, archivo_hash, archivo_bytes, mapeo, total_filas)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(id, s.tallerId, s.usuarioId, d.tipo, d.modo, opcionesJson, d.archivo.nombre, d.archivo.hash, d.archivo.bytes, d.mapeo ? JSON.stringify(d.mapeo) : null, d.total_filas),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'importacion', id, 'iniciar', { tipo: d.tipo, modo: d.modo, archivo: d.archivo.nombre, filas: d.total_filas }),
  ]);
  return c.json({ id, reanudada: false, lotes_hechos: [], previa }, 201);
});

// ───────────── Aplicación de un lote ─────────────
importaciones.post('/:id/lotes/:n', async (c) => {
  const s = c.get('sesion');
  const n = Number(c.req.param('n'));
  if (!Number.isInteger(n) || n < 0) throw badRequest('Número de lote inválido');
  const d = await body(c, z.object({ filas: zFilas, resoluciones: zResoluciones.default({}) }));
  const t = await cargarTrabajo(c.env.DB, s.tallerId, c.req.param('id'));
  if (t.estado !== 'en_curso') throw conflict('La importación ya no está en curso', 'importacion_cerrada');
  if (n >= Math.ceil(t.total_filas / LIMITES_IMPORTACION.tamanoLote)) throw badRequest('El lote excede la cantidad de filas informada');
  const opciones = leerOpciones(t.opciones);
  const filas = limpiarFilas(t.tipo, d.filas);
  exigirPermisos(s, t.tipo, t.modo, opciones, filas);
  await validarOpciones(c.env.DB, s.tallerId, t.tipo, opciones);

  const yaHecho = async () => {
    const l = await first(c.env.DB, 'SELECT filas, creados, actualizados, omitidos, errores FROM importacion_lotes WHERE taller_id = ? AND importacion_id = ? AND lote = ?', s.tallerId, t.id, n);
    return l ? c.json({ ya_procesado: true, lote: n, ...l, problemas: await erroresDeLote(c.env.DB, s.tallerId, t.id, n) }) : null;
  };
  // Reintento de un lote que ya se aplicó (por ejemplo, se cortó la conexión antes de ver la respuesta): no se vuelve a aplicar.
  const previo = await yaHecho();
  if (previo) return previo;

  const ctx: Contexto = { db: c.env.DB, tallerId: s.tallerId, sesion: s, modo: t.modo, opciones, importacionId: t.id, resoluciones: d.resoluciones, aplicar: true };
  // Si entre la lectura y la escritura otra persona cambió los datos (algo único que ya existe), se vuelve a planificar una vez con los datos nuevos.
  for (let intento = 0; ; intento++) {
    const plan = await planificar(t.tipo, ctx, filas);
    const stmts = await sentenciasRegistro(c.env.DB, s.tallerId, t.id, n, plan);
    try {
      await c.env.DB.batch(stmts);
      return c.json({ ya_procesado: false, lote: n, resultados: plan.resultados, resumen: resumir(plan.resultados), contadores: contar(plan.resultados) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('importacion_lotes')) {
        const previo2 = await yaHecho();
        if (previo2) return previo2; // otra solicitud idéntica ganó la carrera
      }
      if (intento >= 1 || !/UNIQUE|FOREIGN KEY|tx_guard|ok = 1/.test(msg)) throw e;
    }
  }
});

// ───────────── Cierre ─────────────
importaciones.post('/:id/finalizar', async (c) => {
  const s = c.get('sesion');
  const t = await cargarTrabajo(c.env.DB, s.tallerId, c.req.param('id'));
  if (t.estado === 'completada') return c.json({ ok: true });
  if (t.estado !== 'en_curso') throw conflict('La importación ya no está en curso', 'importacion_cerrada');
  const hechas = (await first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM importacion_lotes WHERE taller_id = ? AND importacion_id = ?', s.tallerId, t.id))?.n ?? 0;
  const esperadas = Math.ceil(t.total_filas / LIMITES_IMPORTACION.tamanoLote);
  if (hechas < esperadas) throw conflict(`Faltan procesar ${esperadas - hechas} lote(s): continuá la importación para completarla`, 'importacion_incompleta');
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE importaciones SET estado = 'completada', finalizada_at = ? WHERE taller_id = ? AND id = ? AND estado = 'en_curso'").bind(ahora(), s.tallerId, t.id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'importacion', t.id, 'completar', {
      tipo: t.tipo, archivo: t.archivo_nombre, procesados: t.procesados, creados: t.creados, actualizados: t.actualizados, omitidos: t.omitidos, errores: t.errores,
    }),
  ]);
  return c.json({ ok: true });
});

importaciones.post('/:id/cancelar', async (c) => {
  const s = c.get('sesion');
  const t = await cargarTrabajo(c.env.DB, s.tallerId, c.req.param('id'));
  if (t.estado !== 'en_curso') throw conflict('La importación ya no está en curso', 'importacion_cerrada');
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE importaciones SET estado = 'cancelada', finalizada_at = ? WHERE taller_id = ? AND id = ? AND estado = 'en_curso'").bind(ahora(), s.tallerId, t.id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'importacion', t.id, 'cancelar', { procesados: t.procesados, creados: t.creados, actualizados: t.actualizados }),
  ]);
  return c.json({ ok: true });
});
