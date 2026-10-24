// Seguimiento público de órdenes: administración desde el taller (activar el enlace, compartirlo, publicar mensajes, elegir qué se muestra).
// La página y el JSON que ve el cliente están en `seguimiento-publico.ts`; acá todo exige sesión.
//
// Permisos (cada operación exige el suyo, además de poder ver la orden: las asignadas, para quien sólo tiene ese alcance):
//   seguimiento.ver        consultar la configuración (activo o no, mensajes, transiciones). NO devuelve el enlace.
//   seguimiento.gestionar  activar, desactivar, regenerar, fecha estimada, transiciones visibles.
//   seguimiento.compartir  recibir el enlace (copiar, QR, WhatsApp, impresión).
//   seguimiento.mensajes   publicar y retirar observaciones para el cliente.
// El estado de la OT NO se cambia desde acá: se sigue cambiando donde siempre (con los permisos de siempre) y el seguimiento lo refleja solo.
// Ninguna respuesta de este módulo incluye precios, costos, notas internas ni la nota del cambio de estado.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Sesion } from '../env';
import { badRequest, body, conflict, notFound, zId } from '../lib/http';
import { all, auditar, first, uid, ahora } from '../lib/db';
import { requireAny, requirePerm, tiene } from '../lib/auth';
import { esAsignadaAMi } from './ordenes';
import { nuevoToken, transiciones, urlSeguimiento } from '../lib/seguimiento';
import { zonaDelTaller, fechaLocal } from '../lib/zona';
import { ESTADOS_OT, type EstadoOT } from '../../shared/dominio';
import { ESTADO_PUBLICO, MENSAJE_MAX, entregaEstimada, tituloTransicion } from '../../shared/seguimiento';

export const seguimiento = new Hono<AppEnv>();
seguimiento.use('*', requireAny('ordenes.ver', 'ordenes.asignadas'));

interface OrdenSeg {
  id: string;
  numero: number;
  estado: EstadoOT;
  fecha_prometida: string | null;
}

/** La orden debe ser del taller de la sesión y estar a su alcance. Si no, 404 (no se revela si existe). */
async function ordenAccesible(db: D1Database, s: Sesion, id: string): Promise<OrdenSeg> {
  const o = await first<OrdenSeg>(db, 'SELECT id, numero, estado, fecha_prometida FROM ordenes WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!o || !(ESTADOS_OT as readonly string[]).includes(o.estado)) throw notFound('Orden de trabajo');
  if (!tiene(s, 'ordenes.ver') && !(await esAsignadaAMi(db, s, id))) throw notFound('Orden de trabajo');
  return o;
}

interface Enlace {
  activo: number;
  token: string;
  mostrar_fecha_estimada: number;
  generacion: number;
  creado_at: string;
  token_generado_at: string;
  activado_at: string | null;
  desactivado_at: string | null;
}

/** Estado completo del seguimiento de una orden, a la medida de los permisos de quien pregunta. El enlace (token) sólo se entrega con `seguimiento.compartir` y si está activo. */
async function estadoSeguimiento(db: D1Database, s: Sesion, o: OrdenSeg, origen: string) {
  const [enlace, mensajes, trans, zona] = await Promise.all([
    first<Enlace>(db, 'SELECT activo, token, mostrar_fecha_estimada, generacion, creado_at, token_generado_at, activado_at, desactivado_at FROM seguimiento_enlaces WHERE taller_id = ? AND orden_id = ?', s.tallerId, o.id),
    all<{ id: string; texto: string; creado_at: string; retirado_at: string | null; usuario: string | null; retirado_por: string | null }>(
      db,
      `SELECT m.id, m.texto, m.creado_at, m.retirado_at, u.nombre AS usuario, r.nombre AS retirado_por
         FROM seguimiento_mensajes m
         LEFT JOIN usuarios u ON u.taller_id = m.taller_id AND u.id = m.usuario_id
         LEFT JOIN usuarios r ON r.taller_id = m.taller_id AND r.id = m.retirado_por
        WHERE m.taller_id = ? AND m.orden_id = ? ORDER BY m.creado_at DESC, m.rowid DESC LIMIT 50`,
      s.tallerId, o.id,
    ),
    transiciones(db, s.tallerId, o.id),
    zonaDelTaller(db, s.tallerId),
  ]);
  const activo = !!enlace?.activo;
  const compartir = tiene(s, 'seguimiento.compartir');
  const ultima = trans[trans.length - 1]?.id;
  return {
    existe: !!enlace,
    activo,
    // El enlace sólo se muestra mientras está activo y a quien puede compartirlo.
    url: enlace && activo && compartir ? urlSeguimiento(origen, enlace.token) : null,
    mostrar_fecha_estimada: enlace ? !!enlace.mostrar_fecha_estimada : true,
    generacion: enlace?.generacion ?? 0,
    activado_at: enlace?.activado_at ?? enlace?.creado_at ?? null,
    desactivado_at: enlace && !activo ? enlace.desactivado_at : null,
    token_generado_at: enlace?.token_generado_at ?? null,
    estado: { clave: o.estado, ...ESTADO_PUBLICO[o.estado] },
    fecha_prometida: o.fecha_prometida,
    // Lo que verá el cliente con la configuración actual (null si la fecha no corresponde mostrarla).
    entrega: entregaEstimada(o.fecha_prometida, o.estado, enlace ? !!enlace.mostrar_fecha_estimada : true, fechaLocal(ahora(), zona)),
    mensajes: mensajes.map((m, i) => ({ id: m.id, texto: m.texto, creado_at: m.creado_at, usuario: m.usuario, retirado_at: m.retirado_at, retirado_por: m.retirado_por, vigente: i === 0 && !m.retirado_at })),
    // Más reciente primero. Sólo estado y hora: la nota interna y quién cambió el estado no salen de acá.
    transiciones: [...trans].reverse().map((t) => ({ id: t.id, estado: t.estado, titulo: tituloTransicion(t.estado, t.anterior), at: t.at, visible: !t.oculto, es_actual: t.id === ultima })),
  };
}

const origenDe = (url: string) => new URL(url).origin;

seguimiento.get('/:id/seguimiento', requirePerm('seguimiento.ver'), async (c) => {
  const s = c.get('sesion');
  const o = await ordenAccesible(c.env.DB, s, c.req.param('id')!);
  return c.json(await estadoSeguimiento(c.env.DB, s, o, origenDe(c.req.url)));
});

/** Activa el seguimiento. Si nunca tuvo enlace crea uno con un token nuevo; si estaba desactivado lo reactiva con el MISMO token (para uno nuevo, regenerar). */
seguimiento.post('/:id/seguimiento/activar', requirePerm('seguimiento.gestionar'), async (c) => {
  const s = c.get('sesion');
  const o = await ordenAccesible(c.env.DB, s, c.req.param('id')!);
  const t = ahora();
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `INSERT INTO seguimiento_enlaces (id, taller_id, orden_id, token, activo, creado_por, creado_at, token_generado_at, activado_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
         ON CONFLICT (taller_id, orden_id) DO UPDATE SET activo = 1, activado_at = CASE WHEN seguimiento_enlaces.activo = 1 THEN seguimiento_enlaces.activado_at ELSE excluded.activado_at END, desactivado_at = NULL, updated_at = excluded.updated_at`,
      )
      .bind(uid(), s.tallerId, o.id, nuevoToken(), s.usuarioId, t, t, t, t),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'orden', o.id, 'seguimiento_activado'),
  ]);
  return c.json(await estadoSeguimiento(c.env.DB, s, o, origenDe(c.req.url)));
});

/** Desactiva el enlace: deja de funcionar de inmediato (la página pública exige `activo = 1` en cada consulta). El token se conserva por si se reactiva. */
seguimiento.post('/:id/seguimiento/desactivar', requirePerm('seguimiento.gestionar'), async (c) => {
  const s = c.get('sesion');
  const o = await ordenAccesible(c.env.DB, s, c.req.param('id')!);
  const t = ahora();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE seguimiento_enlaces SET activo = 0, desactivado_at = ?, updated_at = ? WHERE taller_id = ? AND orden_id = ? AND activo = 1').bind(t, t, s.tallerId, o.id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'orden', o.id, 'seguimiento_desactivado'),
  ]);
  return c.json(await estadoSeguimiento(c.env.DB, s, o, origenDe(c.req.url)));
});

/** Reemplaza el token por uno nuevo. El anterior deja de existir en la base: el enlace viejo (y su QR impreso) falla de inmediato. Sólo con el seguimiento activo. */
seguimiento.post('/:id/seguimiento/regenerar', requirePerm('seguimiento.gestionar'), async (c) => {
  const s = c.get('sesion');
  const o = await ordenAccesible(c.env.DB, s, c.req.param('id')!);
  const t = ahora();
  const r = await c.env.DB
    .prepare('UPDATE seguimiento_enlaces SET token = ?, generacion = generacion + 1, token_generado_at = ?, updated_at = ? WHERE taller_id = ? AND orden_id = ? AND activo = 1')
    .bind(nuevoToken(), t, t, s.tallerId, o.id)
    .run();
  if (!r.meta.changes) throw conflict('Primero activá el seguimiento de esta orden', 'seguimiento_inactivo');
  await auditar(c.env.DB, s.tallerId, s.usuarioId, 'orden', o.id, 'seguimiento_regenerado').run();
  return c.json(await estadoSeguimiento(c.env.DB, s, o, origenDe(c.req.url)));
});

/** Qué se muestra: hoy, sólo si se publica la fecha estimada de entrega. */
seguimiento.patch('/:id/seguimiento', requirePerm('seguimiento.gestionar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, z.object({ mostrar_fecha_estimada: z.boolean() }));
  const o = await ordenAccesible(c.env.DB, s, c.req.param('id')!);
  const r = await c.env.DB
    .prepare('UPDATE seguimiento_enlaces SET mostrar_fecha_estimada = ?, updated_at = ? WHERE taller_id = ? AND orden_id = ?')
    .bind(d.mostrar_fecha_estimada ? 1 : 0, ahora(), s.tallerId, o.id)
    .run();
  if (!r.meta.changes) throw conflict('Primero activá el seguimiento de esta orden', 'seguimiento_inactivo');
  await auditar(c.env.DB, s.tallerId, s.usuarioId, 'orden', o.id, 'seguimiento_config', { mostrar_fecha_estimada: d.mostrar_fecha_estimada }).run();
  return c.json(await estadoSeguimiento(c.env.DB, s, o, origenDe(c.req.url)));
});

/**
 * Oculta o vuelve a mostrar una transición del historial público. Sirve para esconder pasos internos que no le interesan al cliente.
 * La transición del estado ACTUAL no se puede ocultar: el cliente siempre ve en qué estado está y desde cuándo.
 */
seguimiento.put('/:id/seguimiento/transiciones/:eventoId', requirePerm('seguimiento.gestionar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, z.object({ visible: z.boolean() }));
  const o = await ordenAccesible(c.env.DB, s, c.req.param('id')!);
  const eventoId = zId.parse(c.req.param('eventoId'));
  const ev = await first<{ id: string }>(c.env.DB, 'SELECT id FROM orden_eventos WHERE taller_id = ? AND orden_id = ? AND id = ?', s.tallerId, o.id, eventoId);
  if (!ev) throw notFound('Transición');
  if (d.visible) {
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM seguimiento_eventos_ocultos WHERE taller_id = ? AND evento_id = ?').bind(s.tallerId, eventoId),
      auditar(c.env.DB, s.tallerId, s.usuarioId, 'orden', o.id, 'seguimiento_transicion_visible', { evento_id: eventoId }),
    ]);
  } else {
    const ultimo = await first<{ id: string }>(c.env.DB, 'SELECT id FROM orden_eventos WHERE taller_id = ? AND orden_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', s.tallerId, o.id);
    if (ultimo?.id === eventoId) throw conflict('No se puede ocultar la transición del estado actual: el cliente siempre ve en qué estado está su vehículo', 'transicion_actual');
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO seguimiento_eventos_ocultos (taller_id, orden_id, evento_id, oculto_por) VALUES (?, ?, ?, ?) ON CONFLICT (taller_id, evento_id) DO NOTHING').bind(s.tallerId, o.id, eventoId, s.usuarioId),
      auditar(c.env.DB, s.tallerId, s.usuarioId, 'orden', o.id, 'seguimiento_transicion_oculta', { evento_id: eventoId }),
    ]);
  }
  return c.json(await estadoSeguimiento(c.env.DB, s, o, origenDe(c.req.url)));
});

/** Texto plano: sin caracteres de control y con los saltos de línea normalizados (se muestra con `white-space: pre-line` y escapado, nunca como HTML). */
const limpiarTexto = (t: string) =>
  t
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, (ch) => (ch === '\n' ? ch : ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
const zMensaje = z.object({ texto: z.string().transform(limpiarTexto).pipe(z.string().min(1, 'escribí el mensaje para el cliente').max(MENSAJE_MAX, `máximo ${MENSAJE_MAX} caracteres`)) });

/**
 * Publica una observación para el cliente. Es un campo APARTE de las notas internas: el texto sale únicamente de lo que se escribe acá.
 * Cada mensaje nuevo reemplaza al anterior en la página (el anterior queda en el historial con quién lo publicó).
 */
seguimiento.post('/:id/seguimiento/mensajes', requirePerm('seguimiento.mensajes'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zMensaje);
  const o = await ordenAccesible(c.env.DB, s, c.req.param('id')!);
  const id = uid();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO seguimiento_mensajes (id, taller_id, orden_id, texto, usuario_id) VALUES (?, ?, ?, ?, ?)').bind(id, s.tallerId, o.id, d.texto, s.usuarioId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'orden', o.id, 'seguimiento_mensaje', { mensaje_id: id }),
  ]);
  return c.json(await estadoSeguimiento(c.env.DB, s, o, origenDe(c.req.url)), 201);
});

/** Retira un mensaje de la página (queda en el historial como retirado). */
seguimiento.delete('/:id/seguimiento/mensajes/:mid', requirePerm('seguimiento.mensajes'), async (c) => {
  const s = c.get('sesion');
  const o = await ordenAccesible(c.env.DB, s, c.req.param('id')!);
  const mid = zId.parse(c.req.param('mid'));
  const r = await c.env.DB
    .prepare('UPDATE seguimiento_mensajes SET retirado_at = ?, retirado_por = ? WHERE taller_id = ? AND orden_id = ? AND id = ? AND retirado_at IS NULL')
    .bind(ahora(), s.usuarioId, s.tallerId, o.id, mid)
    .run();
  if (!r.meta.changes) {
    if (!(await first(c.env.DB, 'SELECT 1 FROM seguimiento_mensajes WHERE taller_id = ? AND orden_id = ? AND id = ?', s.tallerId, o.id, mid))) throw notFound('Mensaje');
    throw badRequest('El mensaje ya estaba retirado');
  }
  await auditar(c.env.DB, s.tallerId, s.usuarioId, 'orden', o.id, 'seguimiento_mensaje_retirado', { mensaje_id: mid }).run();
  return c.json(await estadoSeguimiento(c.env.DB, s, o, origenDe(c.req.url)));
});
