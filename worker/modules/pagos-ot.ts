// Pago del cliente de una orden (Sprint 25), lado del taller: ver cuánto se informó, qué eligió el cliente y los comprobantes recibidos; confirmar el cobro o rechazarlo.
//   GET  /ordenes/pagos/pendientes                         comprobantes esperando verificación (aviso discreto del personal administrativo)
//   GET  /ordenes/:id/pago-cliente                         estado económico + elección + comprobantes de la orden
//   POST /ordenes/:id/pago-cliente/importe                 informar (o retirar) el importe de la OT al cliente
//   GET  /ordenes/:id/comprobantes/:cid/archivo            ver / descargar el comprobante (bucket privado: sólo por acá, con sesión y permisos)
//   POST /ordenes/:id/comprobantes/:cid/confirmar          confirmar la recepción del dinero → cobro real (o enlace a uno ya registrado)
//   POST /ordenes/:id/comprobantes/:cid/rechazar           rechazar con un motivo (el cliente lo ve y puede enviar otro)
//
// Permisos (se reutilizan los de siempre; no hay permisos nuevos): todo exige poder ver las órdenes y las ventas (`ordenes.ver` + `ventas.ver`), de modo que el mecánico
// —que sólo tiene «órdenes asignadas» y no ve importes— nunca accede a nada de esto; informar el importe pide además `seguimiento.gestionar` (es lo que ve el público) y
// confirmar o rechazar pide `cobros.registrar` (es el permiso de registrar un cobro). El taller sale SIEMPRE de la sesión.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, conflict, notFound, zCentavos, zFecha, zId } from '../lib/http';
import { all, auditar, first, ahora } from '../lib/db';
import { requirePerm } from '../lib/auth';
import { nombreUsuarioSql } from '../lib/tareas';
import { claveComprobante } from '../lib/comprobantes';
import { ApiError } from '../lib/http';
import { numeroOrden } from '../lib/hoja-orden';
import {
  cobrosVinculables, comprobantesDeOrden, confirmarComprobante, cuentaReceptora, eleccionActual, finanzasOrden, historialElecciones, rechazarComprobante,
} from '../lib/pago-cliente';
import { LIMITES_COMPROBANTE, detallePagoCliente, estadoPagoCliente, ESTADO_PAGO_LABEL } from '../../shared/pago-portal';

export const pagosOrden = new Hono<AppEnv>();
const base = requirePerm('ordenes.ver', 'ventas.ver');

/** Comprobantes pendientes de verificar: cuántos y en qué órdenes (la lista abre desde el aviso). */
pagosOrden.get('/pagos/pendientes', base, async (c) => {
  const s = c.get('sesion');
  const filas = await all<{ id: string; numero: number; patente: string; cantidad: number; desde: string }>(
    c.env.DB,
    `SELECT o.id, o.numero, v.patente, COUNT(*) AS cantidad, MIN(pc.created_at) AS desde
       FROM pago_comprobantes pc
       JOIN ordenes o ON o.taller_id = pc.taller_id AND o.id = pc.orden_id
       JOIN vehiculos v ON v.taller_id = o.taller_id AND v.id = o.vehiculo_id
      WHERE pc.taller_id = ? AND pc.estado = 'pendiente'
      GROUP BY o.id ORDER BY desde LIMIT 50`,
    s.tallerId,
  );
  return c.json({ total: filas.reduce((a, f) => a + f.cantidad, 0), ordenes: filas });
});

async function ordenDelTaller(db: D1Database, tallerId: string, id: string) {
  const f = await finanzasOrden(db, tallerId, id);
  if (!f) throw notFound('Orden de trabajo');
  return f;
}

async function armarVista(c: { env: AppEnv['Bindings'] }, tallerId: string, ordenId: string, sesion: AppEnv['Variables']['sesion']) {
  const db = c.env.DB;
  const f = await ordenDelTaller(db, tallerId, ordenId);
  const [eleccion, historial, comps, cuenta, enlace, informadoPor, vinculables] = await Promise.all([
    eleccionActual(db, tallerId, ordenId),
    historialElecciones(db, tallerId, ordenId),
    comprobantesDeOrden(db, tallerId, ordenId),
    cuentaReceptora(db, tallerId),
    first<{ activo: number }>(db, 'SELECT activo FROM seguimiento_enlaces WHERE taller_id = ? AND orden_id = ?', tallerId, ordenId),
    f.informado?.por ? first<{ nombre: string }>(db, `SELECT ${nombreUsuarioSql('u')} AS nombre FROM usuarios u WHERE u.taller_id = ? AND u.id = ?`, tallerId, f.informado.por) : null,
    cobrosVinculables(db, tallerId, f),
  ]);
  // Nombres de quien resolvió cada comprobante y estado del cobro respaldado (un cobro anulado deja de contar en el saldo, pero el vínculo queda en el historial).
  const usuarios = await all<{ id: string; nombre: string }>(db, `SELECT u.id, ${nombreUsuarioSql('u')} AS nombre FROM usuarios u WHERE u.taller_id = ? AND u.id IN (SELECT revisado_por FROM pago_comprobantes WHERE taller_id = ? AND orden_id = ? AND revisado_por IS NOT NULL)`, tallerId, tallerId, ordenId);
  const cobros = await all<{ id: string; numero: number; estado: string }>(db, 'SELECT id, numero, estado FROM cobros WHERE taller_id = ? AND id IN (SELECT cobro_id FROM pago_comprobantes WHERE taller_id = ? AND orden_id = ? AND cobro_id IS NOT NULL)', tallerId, tallerId, ordenId);
  const nombre = (id: string | null) => usuarios.find((u) => u.id === id)?.nombre ?? null;
  const clave = estadoPagoCliente({
    importeConfirmado: f.confirmado, total: f.total, pendiente: f.pendiente, abonado: f.abonado,
    eleccion: eleccion ? { medio: eleccion.medio, estado: eleccion.estado, at: eleccion.created_at } : null,
    comprobantes: comps.map((x) => ({ estado: x.estado, at: x.created_at })),
  });
  const eleccionJson = eleccion && {
    medio: eleccion.medio, estado: eleccion.estado, at: eleccion.created_at, importe_total: eleccion.importe_total, importe_pendiente: eleccion.importe_pendiente,
    // El importe cambió después de la elección: se muestra el actual y se advierte (nada se confirma solo).
    importe_cambio: eleccion.importe_total !== f.total ? { desde: eleccion.importe_total, hasta: f.total, diferencia: f.total - eleccion.importe_total } : null,
  };
  return {
    orden: { id: ordenId, numero: f.orden.numero, estado: f.orden.estado },
    importe: {
      total: f.total, fuente: f.fuente, abonado: f.abonado, pendiente: f.pendiente, confirmado: f.confirmado,
      comprobante: f.venta ? { id: f.venta.id, numero: f.venta.numero } : null,
      informado: f.informado && {
        at: f.informado.at, por: informadoPor?.nombre ?? null, importe_al_informar: f.informado.importe_al_informar,
        importe_cambio: f.informado.importe_al_informar !== f.total ? { desde: f.informado.importe_al_informar, hasta: f.total, diferencia: f.total - f.informado.importe_al_informar } : null,
      },
    },
    estado: { clave, etiqueta: ESTADO_PAGO_LABEL[clave], detalle: detallePagoCliente(clave, eleccion ? { medio: eleccion.medio, estado: eleccion.estado, at: eleccion.created_at } : null) },
    eleccion: eleccionJson,
    historial_elecciones: historial.map((h) => ({ medio: h.medio, estado: h.estado, at: h.created_at, importe_total: h.importe_total, importe_pendiente: h.importe_pendiente })),
    comprobantes: comps.map((x) => {
      const cobro = cobros.find((k) => k.id === x.cobro_id);
      return {
        id: x.id, estado: x.estado, mime: x.mime, bytes: x.bytes, nombre: x.nombre, at: x.created_at,
        importe_total: x.importe_total, importe_pendiente: x.importe_pendiente,
        importe_cambio: x.estado === 'pendiente' && x.importe_total !== f.total ? { desde: x.importe_total, hasta: f.total, diferencia: f.total - x.importe_total } : null,
        revisado_por: nombre(x.revisado_por), revisado_at: x.revisado_at, motivo_rechazo: x.motivo_rechazo,
        cobro: cobro ? { id: cobro.id, numero: cobro.numero, anulado: cobro.estado === 'anulado' } : null,
        importe_confirmado: x.importe_confirmado, vinculo: x.vinculo,
      };
    }),
    cuenta: cuenta && { id: cuenta.id, banco: cuenta.banco, alias: cuenta.alias, titular: cuenta.titular },
    cobros_vinculables: f.pendiente > 0 || comps.some((x) => x.estado === 'pendiente') ? vinculables : [],
    seguimiento_activo: !!enlace?.activo,
    limites: { pendientes: LIMITES_COMPROBANTE.pendientesPorOrden, total: LIMITES_COMPROBANTE.totalPorOrden },
    puede: { informar: sesion.permisos.has('seguimiento.gestionar'), resolver: sesion.permisos.has('cobros.registrar') },
  };
}

pagosOrden.get('/:id/pago-cliente', base, async (c) => c.json(await armarVista(c, c.get('sesion').tallerId, c.req.param('id'), c.get('sesion'))));

/** Informa al cliente el importe de la OT (o lo retira). Mientras no se informa —y no hay comprobante emitido— la página pública dice «Importe pendiente de confirmación». */
pagosOrden.post('/:id/pago-cliente/importe', requirePerm('ordenes.ver', 'ventas.ver', 'seguimiento.gestionar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const { informar } = await body(c, z.object({ informar: z.boolean() }));
  const f = await ordenDelTaller(c.env.DB, s.tallerId, id);
  if (informar) {
    if (f.cerrada) throw conflict('La orden de trabajo está cancelada', 'orden_cancelada');
    if (f.total <= 0) throw badRequest('La orden no tiene un importe para informar: cargá los trabajos y repuestos primero');
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `INSERT INTO pago_importe_ot (taller_id, orden_id, informado, importe_al_informar, informado_por, informado_at) VALUES (?, ?, 1, ?, ?, ?)
           ON CONFLICT (taller_id, orden_id) DO UPDATE SET informado = 1, importe_al_informar = excluded.importe_al_informar, informado_por = excluded.informado_por, informado_at = excluded.informado_at, retirado_at = NULL`,
        )
        .bind(s.tallerId, id, f.total, s.usuarioId, ahora()),
      auditar(c.env.DB, s.tallerId, s.usuarioId, 'orden', id, 'pago_importe_informado', { importe: f.total }),
    ]);
  } else {
    if (f.venta) throw conflict('La orden ya tiene un comprobante emitido: el importe está confirmado y no se puede retirar', 'importe_confirmado');
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE pago_importe_ot SET informado = 0, retirado_at = ? WHERE taller_id = ? AND orden_id = ? AND informado = 1').bind(ahora(), s.tallerId, id),
      auditar(c.env.DB, s.tallerId, s.usuarioId, 'orden', id, 'pago_importe_retirado'),
    ]);
  }
  return c.json(await armarVista(c, s.tallerId, id, s));
});

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

/** Archivo del comprobante. El objeto se busca con la clave derivada del taller de la SESIÓN y del id de la fila: un id de otra orden u otro taller no encuentra nada. */
pagosOrden.get('/:id/comprobantes/:cid/archivo', base, async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const cp = await first<{ id: string; mime: string; bytes: number; sha256: string; created_at: string }>(
    c.env.DB,
    "SELECT id, mime, bytes, sha256, created_at FROM pago_comprobantes WHERE taller_id = ? AND orden_id = ? AND id = ? AND estado <> 'subiendo'",
    s.tallerId, id, zId.parse(c.req.param('cid')),
  );
  if (!cp) throw notFound('Comprobante');
  if (!c.env.FIERRO_FOTOS) throw new ApiError(503, 'almacenamiento_no_habilitado', 'El almacenamiento de archivos no está habilitado en este servidor');
  const o = await c.env.FIERRO_FOTOS.get(claveComprobante(s.tallerId, cp.id));
  if (!o) throw notFound('Archivo del comprobante');
  const num = await first<{ numero: number }>(c.env.DB, 'SELECT numero FROM ordenes WHERE taller_id = ? AND id = ?', s.tallerId, id);
  const descargar = c.req.query('descargar') === '1';
  c.executionCtx.waitUntil(auditar(c.env.DB, s.tallerId, s.usuarioId, 'orden', id, descargar ? 'pago_comprobante_descargado' : 'pago_comprobante_visto', { comprobante_id: cp.id }).run().catch(() => undefined));
  const esPdf = cp.mime === 'application/pdf';
  return new Response(o.body, {
    headers: {
      'content-type': cp.mime,
      'content-length': String(cp.bytes),
      'content-disposition': `${descargar ? 'attachment' : 'inline'}; filename="comprobante-OT-${numeroOrden(num?.numero ?? 0)}-${cp.created_at.slice(0, 10)}.${EXT[cp.mime]}"`,
      // Datos financieros privados: nada de caché compartida ni de adivinar el tipo; las imágenes se sirven aisladas y el PDF sólo puede mostrarse en la propia aplicación.
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': esPdf ? "frame-ancestors 'self'" : "default-src 'none'; sandbox",
    },
  });
});

/** Confirma que el dinero ingresó (crea el cobro real o enlaza uno ya registrado). Reintentos y doble clic devuelven el mismo resultado. */
pagosOrden.post('/:id/comprobantes/:cid/confirmar', requirePerm('ordenes.ver', 'ventas.ver', 'cobros.registrar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(
    c,
    z.object({ importe: zCentavos.refine((v) => v > 0, 'importe debe ser mayor a 0').optional(), cuenta_id: zId.nullish(), cobro_id: zId.nullish(), fecha: zFecha.nullish() }),
  );
  if (d.cobro_id && (d.importe !== undefined || d.cuenta_id)) throw badRequest('Al enlazar un cobro ya registrado no se indican importe ni cuenta: se toman del cobro');
  await ordenDelTaller(c.env.DB, s.tallerId, id);
  const r = await confirmarComprobante(c.env.DB, s, id, zId.parse(c.req.param('cid')), { importe: d.importe, cuentaId: d.cuenta_id, cobroId: d.cobro_id, fecha: d.fecha });
  return c.json({ ...r, vista: await armarVista(c, s.tallerId, id, s) }, r.duplicado ? 200 : 201);
});

pagosOrden.post('/:id/comprobantes/:cid/rechazar', requirePerm('ordenes.ver', 'ventas.ver', 'cobros.registrar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const { motivo } = await body(c, z.object({ motivo: z.string().trim().min(LIMITES_COMPROBANTE.motivoMin, 'Indicá el motivo del rechazo (el cliente lo va a ver)').max(LIMITES_COMPROBANTE.motivoMax) }));
  await ordenDelTaller(c.env.DB, s.tallerId, id);
  const r = await rechazarComprobante(c.env.DB, s, id, zId.parse(c.req.param('cid')), motivo);
  return c.json({ ...r, vista: await armarVista(c, s.tallerId, id, s) });
});
