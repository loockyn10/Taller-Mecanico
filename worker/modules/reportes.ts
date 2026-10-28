// Dashboard, estadísticas y búsqueda global.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { query, zFecha } from '../lib/http';
import { all, first, hoy, like } from '../lib/db';
import { requirePerm, tiene } from '../lib/auth';
import { limpiarDocumento } from '../lib/privacidad';
import { normalizarPatente } from '../../shared/dominio';
import { CLIENTES_TEXTO_SQL } from '../lib/vehiculo-clientes';

export const reportes = new Hono<AppEnv>();

/** Lo devuelto de cada línea de comprobante (devoluciones vigentes): cantidad, subtotal y costo de lo que volvió al inventario. */
const DEV_LINEA = (campo: 'cantidad' | 'subtotal' | 'costo') =>
  `COALESCE((SELECT SUM(${campo === 'costo' ? 'CASE WHEN di.reingresa = 1 THEN di.cantidad * COALESCE(di.costo_unitario, 0) ELSE 0 END' : `di.${campo}`}) FROM devolucion_items di
      JOIN devoluciones dv ON dv.taller_id = di.taller_id AND dv.id = di.devolucion_id AND dv.estado = 'registrada' WHERE di.taller_id = vi.taller_id AND di.venta_item_id = vi.id), 0)`;

/** Cada bloque del tablero se arma solo si la persona tiene permiso para ver ese tipo de información. */
reportes.get('/dashboard', async (c) => {
  const s = c.get('sesion');
  const db = c.env.DB;
  const f = hoy();
  const mes = f.slice(0, 7);
  const verOrdenes = tiene(s, 'ordenes.ver');
  const [porEstado, turnosHoy, stockBajo, presupuestos, ordenesRecientes] = await Promise.all([
    verOrdenes ? all(db, 'SELECT estado, COUNT(*) AS cantidad FROM ordenes WHERE taller_id = ? GROUP BY estado', s.tallerId) : Promise.resolve([]),
    tiene(s, 'turnos.ver')
      ? all(
          db,
          `SELECT t.id, t.hora, t.estado, t.motivo, c.nombre AS cliente, v.patente FROM turnos t JOIN clientes c ON c.taller_id = t.taller_id AND c.id = t.cliente_id
             LEFT JOIN vehiculos v ON v.taller_id = t.taller_id AND v.id = t.vehiculo_id WHERE t.taller_id = ? AND t.fecha = ? ORDER BY t.hora`,
          s.tallerId,
          f,
        )
      : Promise.resolve([]),
    tiene(s, 'stock.ver')
      ? all(
          db,
          `SELECT * FROM (SELECT id, nombre, codigo, stock, stock_minimo, unidad, NULL AS deposito FROM articulos WHERE taller_id = ? AND activo = 1 AND stock <= stock_minimo AND stock_minimo > 0
             UNION ALL
            SELECT a.id, a.nombre, a.codigo, ROUND(COALESCE(sd.stock, 0), 3) AS stock, m.minimo AS stock_minimo, a.unidad, d.nombre AS deposito
              FROM stock_minimos_deposito m JOIN articulos a ON a.taller_id = m.taller_id AND a.id = m.articulo_id JOIN depositos d ON d.taller_id = m.taller_id AND d.id = m.deposito_id
              LEFT JOIN stock_depositos sd ON sd.taller_id = m.taller_id AND sd.articulo_id = m.articulo_id AND sd.deposito_id = m.deposito_id
             WHERE m.taller_id = ? AND a.activo = 1 AND d.activo = 1 AND m.minimo > 0 AND ROUND(COALESCE(sd.stock, 0), 3) <= ROUND(m.minimo, 3)
             ) ORDER BY stock - stock_minimo LIMIT 8`,
          s.tallerId, s.tallerId,
        )
      : Promise.resolve([]),
    tiene(s, 'presupuestos.ver')
      ? first(db, "SELECT SUM(estado = 'pendiente') AS pendientes, SUM(estado = 'aprobado') AS aprobados FROM presupuestos WHERE taller_id = ?", s.tallerId)
      : Promise.resolve(null),
    verOrdenes
      ? all(
          db,
          `SELECT o.id, o.numero, o.estado, o.total, o.fecha_prometida, c.nombre AS cliente, v.patente FROM ordenes o
             JOIN clientes c ON c.taller_id = o.taller_id AND c.id = o.cliente_id JOIN vehiculos v ON v.taller_id = o.taller_id AND v.id = o.vehiculo_id
            WHERE o.taller_id = ? AND o.estado NOT IN ('entregada','cancelada') ORDER BY o.updated_at DESC LIMIT 8`,
          s.tallerId,
        ).then((rows) => rows.map((o) => limpiarDocumento(s, o)))
      : Promise.resolve([]),
  ]);
  let finanzas = null;
  if (tiene(s, 'reportes.ver')) {
    finanzas = await first(
      db,
      `SELECT
         (SELECT COALESCE(SUM(total),0) FROM ventas WHERE taller_id = ? AND estado = 'emitida' AND fecha BETWEEN ? AND ?) AS ventas_mes,
         (SELECT COALESCE(SUM(total),0) FROM cobros WHERE taller_id = ? AND estado = 'registrado' AND fecha = ?) AS cobrado_hoy,
         (SELECT COALESCE(SUM(total - devuelto - cobrado),0) FROM ventas WHERE taller_id = ? AND estado = 'emitida' AND total <> devuelto + cobrado) AS por_cobrar`,
      s.tallerId, `${mes}-01`, `${mes}-31`, s.tallerId, f, s.tallerId,
    );
  }
  return c.json({ porEstado, turnosHoy, stockBajo, presupuestos, ordenesRecientes, finanzas });
});

reportes.get('/reportes', requirePerm('reportes.ver'), async (c) => {
  const s = c.get('sesion');
  const db = c.env.DB;
  const { desde, hasta } = query(c, z.object({ desde: zFecha, hasta: zFecha }));
  const [resumen, porDia, porMedio, topServicios, topArticulos, porMecanico, ordenesPeriodo, compras, devoluciones, anticipos] = await Promise.all([
    first(
      db,
      `SELECT COUNT(*) AS comprobantes, COALESCE(SUM(total),0) AS total, COALESCE(SUM(neto),0) AS neto, COALESCE(SUM(iva),0) AS iva,
              COALESCE(SUM(subtotal_servicios),0) AS servicios, COALESCE(SUM(subtotal_articulos),0) AS articulos, COALESCE(AVG(total),0) AS ticket_promedio
         FROM ventas WHERE taller_id = ? AND estado = 'emitida' AND fecha BETWEEN ? AND ?`,
      s.tallerId, desde, hasta,
    ),
    all(db, "SELECT fecha, SUM(total) AS total, COUNT(*) AS cantidad FROM ventas WHERE taller_id = ? AND estado = 'emitida' AND fecha BETWEEN ? AND ? GROUP BY fecha ORDER BY fecha", s.tallerId, desde, hasta),
    all(
      db,
      `SELECT cm.medio, SUM(cm.importe) AS total, COUNT(*) AS cantidad FROM cobro_medios cm JOIN cobros co ON co.taller_id = cm.taller_id AND co.id = cm.cobro_id
        WHERE cm.taller_id = ? AND co.estado = 'registrado' AND co.fecha BETWEEN ? AND ? GROUP BY cm.medio ORDER BY total DESC`,
      s.tallerId, desde, hasta,
    ),
    all(
      db,
      `SELECT vi.descripcion, SUM(vi.cantidad - ${DEV_LINEA('cantidad')}) AS cantidad, SUM(vi.subtotal - ${DEV_LINEA('subtotal')}) AS total FROM venta_items vi JOIN ventas ve ON ve.taller_id = vi.taller_id AND ve.id = vi.venta_id
        WHERE vi.taller_id = ? AND ve.estado = 'emitida' AND ve.fecha BETWEEN ? AND ? AND vi.tipo IN ('servicio','libre') GROUP BY vi.descripcion ORDER BY total DESC LIMIT 10`,
      s.tallerId, desde, hasta,
    ),
    all(
      db,
      `SELECT vi.descripcion, SUM(vi.cantidad - ${DEV_LINEA('cantidad')}) AS cantidad, SUM(vi.subtotal - ${DEV_LINEA('subtotal')}) AS total, SUM(vi.cantidad * COALESCE(vi.costo_unitario, a.costo, 0) - ${DEV_LINEA('costo')}) AS costo
         FROM venta_items vi JOIN ventas ve ON ve.taller_id = vi.taller_id AND ve.id = vi.venta_id
         LEFT JOIN articulos a ON a.taller_id = vi.taller_id AND a.id = vi.articulo_id
        WHERE vi.taller_id = ? AND ve.estado = 'emitida' AND ve.fecha BETWEEN ? AND ? AND vi.tipo = 'articulo' GROUP BY vi.articulo_id ORDER BY total DESC LIMIT 10`,
      s.tallerId, desde, hasta,
    ),
    all(
      db,
      `SELECT COALESCE(m.nombre, 'Sin asignar') AS mecanico, COUNT(*) AS ordenes, SUM(o.subtotal_servicios) AS mano_obra FROM ordenes o
         LEFT JOIN mecanicos m ON m.taller_id = o.taller_id AND m.id = o.mecanico_id
        WHERE o.taller_id = ? AND o.estado IN ('lista','entregada') AND substr(COALESCE(o.fecha_lista, o.fecha_ingreso),1,10) BETWEEN ? AND ?
        GROUP BY o.mecanico_id ORDER BY ordenes DESC`,
      s.tallerId, desde, hasta,
    ),
    first(
      db,
      `SELECT COUNT(*) AS ingresadas, SUM(estado = 'entregada') AS entregadas, SUM(estado = 'cancelada') AS canceladas
         FROM ordenes WHERE taller_id = ? AND substr(fecha_ingreso,1,10) BETWEEN ? AND ?`,
      s.tallerId, desde, hasta,
    ),
    first(db, "SELECT COUNT(*) AS cantidad, COALESCE(SUM(total),0) AS total FROM compras WHERE taller_id = ? AND estado = 'registrada' AND fecha BETWEEN ? AND ?", s.tallerId, desde, hasta),
    first(db, "SELECT COUNT(*) AS cantidad, COALESCE(SUM(total),0) AS total, COALESCE(SUM(reintegrado),0) AS reintegrado FROM devoluciones WHERE taller_id = ? AND estado = 'registrada' AND fecha BETWEEN ? AND ?", s.tallerId, desde, hasta),
    first(db, "SELECT COUNT(*) AS cantidad, COALESCE(SUM(total),0) AS total FROM cobros WHERE taller_id = ? AND tipo = 'anticipo' AND estado = 'registrado' AND fecha BETWEEN ? AND ?", s.tallerId, desde, hasta),
  ]);
  // El costo (y con él, la ganancia) solo se informa a quien puede ver márgenes.
  const conMargen = tiene(s, 'margenes.ver');
  return c.json({
    resumen, porDia, porMedio, topServicios, ordenesPeriodo, compras, porMecanico, devoluciones, anticipos,
    topArticulos: conMargen ? topArticulos : topArticulos.map((a) => ({ ...a, costo: undefined })),
  });
});

reportes.get('/buscar', async (c) => {
  const s = c.get('sesion');
  const { q } = query(c, z.object({ q: z.string().trim().min(2).max(60) }));
  const pat = normalizarPatente(q);
  const num = q.replace(/\D/g, '');
  const verOrdenes = tiene(s, 'ordenes.ver');
  const [clientes, vehiculos, ordenes] = await Promise.all([
    tiene(s, 'clientes.ver')
      ? all(c.env.DB, 'SELECT id, codigo, nombre, telefono FROM clientes WHERE taller_id = ? AND activo = 1 AND (nombre LIKE ? OR documento LIKE ? OR telefono LIKE ?) LIMIT 6', s.tallerId, like(q), like(q), like(q))
      : Promise.resolve([]),
    tiene(s, 'vehiculos.ver') && pat.length >= 2
      ? all(
          c.env.DB,
          `SELECT v.id, v.patente, ma.nombre AS marca, mo.nombre AS modelo${tiene(s, 'clientes.ver') ? `, ${CLIENTES_TEXTO_SQL} AS cliente` : ''} FROM vehiculos v
             LEFT JOIN marcas ma ON ma.taller_id = v.taller_id AND ma.id = v.marca_id LEFT JOIN modelos mo ON mo.taller_id = v.taller_id AND mo.id = v.modelo_id
            WHERE v.taller_id = ? AND v.activo = 1 AND v.patente LIKE ? LIMIT 6`,
          s.tallerId,
          like(pat),
        )
      : Promise.resolve([]),
    num && (verOrdenes || tiene(s, 'ordenes.asignadas'))
      ? all(
          c.env.DB,
          `SELECT o.id, o.numero, o.estado, c.nombre AS cliente, v.patente FROM ordenes o JOIN clientes c ON c.taller_id = o.taller_id AND c.id = o.cliente_id
             JOIN vehiculos v ON v.taller_id = o.taller_id AND v.id = o.vehiculo_id WHERE o.taller_id = ? AND CAST(o.numero AS TEXT) LIKE ?
              ${verOrdenes ? '' : 'AND o.mecanico_id IN (SELECT m.id FROM mecanicos m WHERE m.taller_id = o.taller_id AND m.usuario_id = ?)'} ORDER BY o.numero DESC LIMIT 6`,
          s.tallerId,
          `${num}%`,
          ...(verOrdenes ? [] : [s.usuarioId]),
        ).then((rows) => rows.map((o) => limpiarDocumento(s, o)))
      : Promise.resolve([]),
  ]);
  return c.json({ clientes, vehiculos, ordenes });
});
