// Fotografías de vehículos y órdenes de trabajo. Los archivos viven en un bucket PRIVADO de R2 (binding FIERRO_FOTOS); en D1 sólo hay referencias y metadatos.
// Nada es público: cada imagen se baja por un endpoint con sesión que comprueba taller, permiso y acceso al vehículo/OT. La clave del objeto se arma con el
// taller de la sesión y el id de la fila, jamás con datos que mande el cliente: una solicitud alterada no puede alcanzar objetos de otro taller.
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv, Sesion } from '../env';
import { ApiError, badRequest, body, conflict, forbidden, notFound, zId } from '../lib/http';
import { all, auditar, ahora, delTaller, first, guard, uid } from '../lib/db';
import { requireAny, requirePerm, tiene } from '../lib/auth';
import { nombreUsuarioSql } from '../lib/tareas';
import { ASIGNADA_A_MI, esAsignadaAMi } from './ordenes';
import { ETAPAS, MAX_FOTO_BYTES, MAX_LADO_FOTO, MAX_LADO_MINIATURA, MAX_MINIATURA_BYTES, claveFoto, claveMiniatura, sha256, usoFotos, validarImagen } from '../lib/fotos';

export const fotos = new Hono<AppEnv>();

const mb = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2).replace(/\.?0+$/, '')} GB` : `${Math.round(b / 1024 ** 2)} MB`);

function bucket(c: Context<AppEnv>): R2Bucket {
  const b = c.env.FIERRO_FOTOS;
  if (!b) throw new ApiError(503, 'fotos_no_habilitadas', 'El almacenamiento de fotografías todavía no está habilitado en este servidor');
  return b;
}

/** Acceso a las fotos de una OT: quien ve todas las órdenes, o el mecánico asignado a ella. */
async function veOrden(c: Context<AppEnv>, s: Sesion, ordenId: string): Promise<boolean> {
  if (tiene(s, 'ordenes.ver')) return true;
  return tiene(s, 'ordenes.asignadas') && (await esAsignadaAMi(c.env.DB, s, ordenId));
}
/** Subir a una OT: quien la gestiona (crear/modificar órdenes) o el mecánico con "actualizar órdenes asignadas" sobre una orden suya. */
async function trabajaOrden(c: Context<AppEnv>, s: Sesion, ordenId: string): Promise<boolean> {
  if (tiene(s, 'ordenes.modificar') || tiene(s, 'ordenes.crear')) return true;
  return tiene(s, 'ordenes.trabajar_asignadas') && (await esAsignadaAMi(c.env.DB, s, ordenId));
}

const COLUMNAS = `f.id, f.vehiculo_id, f.orden_id, o.numero AS orden_numero, f.etapa, f.descripcion, f.ancho, f.alto, f.bytes, f.created_at,
  ${nombreUsuarioSql('u')} AS usuario`;
const DESDE = `FROM fotos f LEFT JOIN ordenes o ON o.taller_id = f.taller_id AND o.id = f.orden_id LEFT JOIN usuarios u ON u.taller_id = f.taller_id AND u.id = f.usuario_id`;

// ───────────── Estado y consumo ─────────────
fotos.get('/fotos/estado', requireAny('fotos.ver', 'fotos.subir', 'config.editar', 'licencia.ver'), async (c) => {
  const s = c.get('sesion');
  const uso = await usoFotos(c.env.DB, s.tallerId);
  return c.json({ habilitado: !!c.env.FIERRO_FOTOS, ...uso });
});

// ───────────── Listados ─────────────
fotos.get('/vehiculos/:id/fotos', requirePerm('fotos.ver', 'vehiculos.ver'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  if (!(await delTaller(c.env.DB, 'vehiculos', s.tallerId, id, 'id'))) throw notFound('Vehículo');
  const soloAsignadas = !tiene(s, 'ordenes.ver');
  const filas = await all(
    c.env.DB,
    `SELECT ${COLUMNAS} ${DESDE} WHERE f.taller_id = ? AND f.vehiculo_id = ? AND f.estado = 'lista'
       ${soloAsignadas ? `AND (f.orden_id IS NULL OR (${tiene(s, 'ordenes.asignadas') ? ASIGNADA_A_MI : '0'}))` : ''}
       ORDER BY f.created_at DESC LIMIT 500`,
    s.tallerId,
    id,
    ...(soloAsignadas && tiene(s, 'ordenes.asignadas') ? [s.usuarioId, s.usuarioId, s.usuarioId] : []),
  );
  return c.json(filas);
});

fotos.get('/ordenes/:id/fotos', requirePerm('fotos.ver'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  if (!(await delTaller(c.env.DB, 'ordenes', s.tallerId, id, 'id'))) throw notFound('Orden de trabajo');
  if (!(await veOrden(c, s, id))) throw forbidden('No tenés acceso a esta orden de trabajo');
  return c.json(await all(c.env.DB, `SELECT ${COLUMNAS} ${DESDE} WHERE f.taller_id = ? AND f.orden_id = ? AND f.estado = 'lista' ORDER BY f.created_at DESC LIMIT 500`, s.tallerId, id));
});

// ───────────── Subida ─────────────
// Se recibe multipart (archivo + miniatura generados por el navegador). Como esta ruta no es JSON, exige un encabezado propio que un formulario de otro sitio no puede enviar.
const zSubida = z.object({
  vehiculo_id: zId,
  orden_id: zId.optional(),
  etapa: z.enum(ETAPAS).optional(),
  descripcion: z.string().trim().max(300).optional(),
  idem_key: z.string().regex(/^[A-Za-z0-9-]{8,64}$/, 'clave de reintento inválida'),
});

const leer = async (f: unknown, que: string) => {
  if (!(f instanceof File)) throw badRequest(`Falta ${que}`);
  return new Uint8Array(await f.arrayBuffer());
};

fotos.post('/fotos', requirePerm('fotos.subir'), async (c) => {
  const s = c.get('sesion');
  if (c.req.header('x-fierro-subida') !== '1') throw new ApiError(415, 'tipo_contenido', 'Subida no permitida desde este origen');
  const cl = Number(c.req.header('content-length') ?? 0);
  if (cl > MAX_FOTO_BYTES + MAX_MINIATURA_BYTES + 100_000) throw new ApiError(413, 'imagen_grande', 'La fotografía es demasiado pesada');
  const r2 = bucket(c);
  const form = await c.req.parseBody();
  const p = zSubida.safeParse({
    vehiculo_id: form.vehiculo_id,
    orden_id: form.orden_id || undefined,
    etapa: form.etapa || undefined,
    descripcion: typeof form.descripcion === 'string' && form.descripcion.trim() ? form.descripcion : undefined,
    idem_key: form.idem_key,
  });
  if (!p.success) throw badRequest(p.error.issues[0]?.message ?? 'Datos inválidos');
  const d = p.data;
  if (!!d.orden_id !== !!d.etapa) throw badRequest(d.orden_id ? 'Indicá la etapa de la fotografía (recepción, reparación o entrega)' : 'La etapa sólo corresponde a fotografías de una orden de trabajo');

  // Autorización: sobre el vehículo o sobre la OT, siempre dentro del taller de la sesión.
  const veh = await first<{ id: string; activo: number }>(c.env.DB, 'SELECT id, activo FROM vehiculos WHERE taller_id = ? AND id = ?', s.tallerId, d.vehiculo_id);
  if (!veh) throw notFound('Vehículo');
  if (d.orden_id) {
    const o = await first<{ vehiculo_id: string; estado: string }>(c.env.DB, 'SELECT vehiculo_id, estado FROM ordenes WHERE taller_id = ? AND id = ?', s.tallerId, d.orden_id);
    if (!o) throw notFound('Orden de trabajo');
    if (o.vehiculo_id !== d.vehiculo_id) throw badRequest('La orden no corresponde a ese vehículo');
    if (o.estado === 'cancelada') throw conflict('La orden de trabajo está cancelada');
    if (!(await trabajaOrden(c, s, d.orden_id))) throw forbidden('No tenés permiso para subir fotografías a esta orden de trabajo');
  } else if (!tiene(s, 'vehiculos.crear') && !tiene(s, 'vehiculos.editar')) {
    throw forbidden('No tenés permiso para subir fotografías a un vehículo');
  }

  // Reintento: la misma clave nunca crea una segunda foto.
  const previa = await first<{ id: string; estado: string; vehiculo_id: string; orden_id: string | null }>(
    c.env.DB,
    'SELECT id, estado, vehiculo_id, orden_id FROM fotos WHERE taller_id = ? AND idem_key = ?',
    s.tallerId,
    d.idem_key,
  );
  if (previa && (previa.vehiculo_id !== d.vehiculo_id || (previa.orden_id ?? null) !== (d.orden_id ?? null))) throw conflict('Esa clave de reintento ya se usó para otra fotografía', 'duplicado');
  if (previa?.estado === 'eliminada') throw conflict('Esa fotografía fue eliminada; elegila de nuevo', 'duplicado');
  if (previa?.estado === 'lista') return c.json(await fotoJson(c, s.tallerId, previa.id), 200);

  // Contenido real, tamaño y limpieza de metadatos (se re-escribe lo que se guarda).
  const img = validarImagen(await leer(form.foto, 'la fotografía'), MAX_FOTO_BYTES, MAX_LADO_FOTO, 'Fotografía');
  const mini = validarImagen(await leer(form.miniatura, 'la miniatura'), MAX_MINIATURA_BYTES, MAX_LADO_MINIATURA, 'Miniatura');
  const [h1, h2] = await Promise.all([sha256(img.bytes), sha256(mini.bytes)]);
  const nuevo = img.bytes.length + mini.bytes.length;

  // Cupo del taller (se reserva con la fila "pendiente" dentro de la misma transacción que lo comprueba).
  const uso = await usoFotos(c.env.DB, s.tallerId);
  const yaReservado = previa ? ((await first<{ n: number }>(c.env.DB, 'SELECT bytes + miniatura_bytes AS n FROM fotos WHERE taller_id = ? AND id = ?', s.tallerId, previa.id))?.n ?? 0) : 0;
  const sinEspacio = () => new ApiError(409, 'sin_espacio', `El taller alcanzó su límite de almacenamiento de fotografías (${mb(uso.usado_bytes)} de ${mb(uso.limite_bytes)}). Liberá espacio eliminando fotos o pedí ampliarlo a la administración.`);
  if (uso.usado_bytes - yaReservado + nuevo > uso.limite_bytes) throw sinEspacio();

  const id = previa?.id ?? uid();
  if (previa) {
    await c.env.DB.prepare('UPDATE fotos SET mime = ?, ancho = ?, alto = ?, bytes = ?, miniatura_bytes = ?, sha256 = ?, miniatura_sha256 = ?, descripcion = ? WHERE taller_id = ? AND id = ?')
      .bind(img.mime, img.ancho, img.alto, img.bytes.length, mini.bytes.length, h1, h2, d.descripcion ?? null, s.tallerId, id)
      .run();
  } else {
    try {
      await c.env.DB.batch([
        guard(
          c.env.DB,
          `(SELECT COALESCE(SUM(bytes + miniatura_bytes), 0) FROM fotos WHERE taller_id = ? AND estado IN ('pendiente', 'lista')) + ? > COALESCE((SELECT fotos_limite_bytes FROM taller_almacenamiento WHERE taller_id = ?), ?)`,
          s.tallerId,
          nuevo,
          s.tallerId,
          uso.limite_bytes,
        ),
        c.env.DB.prepare(
          `INSERT INTO fotos (id, taller_id, vehiculo_id, orden_id, etapa, descripcion, idem_key, mime, ancho, alto, bytes, miniatura_bytes, sha256, miniatura_sha256, estado, usuario_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pendiente', ?)`,
        ).bind(id, s.tallerId, d.vehiculo_id, d.orden_id ?? null, d.etapa ?? null, d.descripcion ?? null, d.idem_key, img.mime, img.ancho, img.alto, img.bytes.length, mini.bytes.length, h1, h2, s.usuarioId),
      ]);
    } catch (e) {
      if (/CHECK constraint/i.test(String(e))) throw sinEspacio();
      throw e;
    }
  }

  // Archivo y miniatura a R2; si algo falla se deshace la reserva y no queda nada.
  try {
    const meta = { customMetadata: { taller: s.tallerId, foto: id }, httpMetadata: { contentType: img.mime } };
    await r2.put(claveFoto(s.tallerId, id), img.bytes, { ...meta, sha256: h1 });
    await r2.put(claveMiniatura(s.tallerId, id), mini.bytes, { ...meta, httpMetadata: { contentType: mini.mime }, sha256: h2 });
  } catch {
    await c.env.DB.prepare("UPDATE fotos SET estado = 'eliminada', eliminada_at = ? WHERE taller_id = ? AND id = ? AND estado = 'pendiente'").bind(ahora(), s.tallerId, id).run();
    c.executionCtx.waitUntil(r2.delete([claveFoto(s.tallerId, id), claveMiniatura(s.tallerId, id)]).then(() => c.env.DB.prepare("DELETE FROM fotos WHERE taller_id = ? AND id = ? AND estado = 'eliminada'").bind(s.tallerId, id).run()).catch(() => {}));
    throw new ApiError(502, 'almacenamiento', 'No se pudo guardar la fotografía. Reintentá en unos segundos.');
  }
  await c.env.DB.prepare("UPDATE fotos SET estado = 'lista' WHERE taller_id = ? AND id = ?").bind(s.tallerId, id).run();
  return c.json(await fotoJson(c, s.tallerId, id), 201);
});

async function fotoJson(c: Context<AppEnv>, tallerId: string, id: string) {
  return first(c.env.DB, `SELECT ${COLUMNAS} ${DESDE} WHERE f.taller_id = ? AND f.id = ?`, tallerId, id);
}

// ───────────── Descarga (con sesión, permisos y acceso) ─────────────
async function cargarAutorizada(c: Context<AppEnv>) {
  const s = c.get('sesion');
  if (!tiene(s, 'fotos.ver')) throw forbidden();
  const f = await first<{ id: string; vehiculo_id: string; orden_id: string | null; mime: string; sha256: string; miniatura_sha256: string; bytes: number; miniatura_bytes: number; estado: string }>(
    c.env.DB,
    'SELECT id, vehiculo_id, orden_id, mime, sha256, miniatura_sha256, bytes, miniatura_bytes, estado FROM fotos WHERE taller_id = ? AND id = ?',
    s.tallerId,
    c.req.param('id'),
  );
  if (!f || f.estado !== 'lista') throw notFound('Fotografía');
  if (f.orden_id ? !(await veOrden(c, s, f.orden_id)) : !tiene(s, 'vehiculos.ver')) throw forbidden('No tenés acceso a esta fotografía');
  return { s, f };
}

async function servir(c: Context<AppEnv>, miniatura: boolean) {
  const { s, f } = await cargarAutorizada(c);
  const etag = `"${(miniatura ? f.miniatura_sha256 : f.sha256).slice(0, 32)}"`;
  const comunes = {
    ETag: etag,
    // Los archivos no cambian nunca (la clave es el id): el navegador puede conservarlos, pero sólo él (privado).
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  };
  if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers: comunes });
  const o = await bucket(c).get(miniatura ? claveMiniatura(s.tallerId, f.id) : claveFoto(s.tallerId, f.id));
  if (!o) throw notFound('Archivo de la fotografía');
  return new Response(o.body, { headers: { ...comunes, 'Content-Type': f.mime, 'Content-Length': String(miniatura ? f.miniatura_bytes : f.bytes), 'Content-Disposition': 'inline' } });
}
fotos.get('/fotos/:id/archivo', (c) => servir(c, false));
fotos.get('/fotos/:id/miniatura', (c) => servir(c, true));

// ───────────── Descripción y eliminación ─────────────
fotos.patch('/fotos/:id', requirePerm('fotos.subir'), async (c) => {
  const { s, f } = await cargarAutorizada(c);
  const { descripcion } = await body(c, z.object({ descripcion: z.string().trim().max(300).nullish() }));
  if (f.orden_id ? !(await trabajaOrden(c, s, f.orden_id)) : !tiene(s, 'vehiculos.editar') && !tiene(s, 'vehiculos.crear')) throw forbidden();
  await c.env.DB.prepare('UPDATE fotos SET descripcion = ? WHERE taller_id = ? AND id = ?').bind(descripcion || null, s.tallerId, f.id).run();
  return c.json(await fotoJson(c, s.tallerId, f.id));
});

fotos.delete('/fotos/:id', requirePerm('fotos.eliminar'), async (c) => {
  const { s, f } = await cargarAutorizada(c);
  const r2 = bucket(c);
  // Una fotografía incluida en una recepción o entrega confirmada es parte de la evidencia: no se elimina (la base también lo impide).
  if (await first(c.env.DB, 'SELECT 1 FROM ck_fotos WHERE taller_id = ? AND foto_id = ?', s.tallerId, f.id)) throw conflict('Esta fotografía forma parte de una recepción o entrega confirmada y no se puede eliminar', 'foto_en_checklist');
  // 1) Se oculta y se deja constancia (usuario y fecha) en una sola transacción.
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE fotos SET estado = 'eliminada', eliminada_at = ?, eliminada_por = ? WHERE taller_id = ? AND id = ? AND estado = 'lista'").bind(ahora(), s.usuarioId, s.tallerId, f.id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'foto', f.id, 'eliminar', { vehiculo_id: f.vehiculo_id, orden_id: f.orden_id, bytes: f.bytes + f.miniatura_bytes, sha256: f.sha256 }),
  ]);
  // 2) Se borran los objetos y la fila. Si R2 falla, la fila queda "eliminada" y el Cron termina el trabajo: no quedan objetos huérfanos.
  try {
    await r2.delete([claveFoto(s.tallerId, f.id), claveMiniatura(s.tallerId, f.id)]);
    await c.env.DB.prepare("DELETE FROM fotos WHERE taller_id = ? AND id = ? AND estado = 'eliminada'").bind(s.tallerId, f.id).run();
  } catch {
    /* lo completa el mantenimiento periódico */
  }
  return c.json({ ok: true });
});
