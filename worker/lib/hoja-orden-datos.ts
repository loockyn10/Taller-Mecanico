// Datos de la hoja de la orden de trabajo (PDF). Arma `DatosHoja` con una consulta propia y acotada: NO reutiliza la consulta del detalle de la OT
// (que trae importes, totales y costos de mano de obra) ni el endpoint administrativo; acá sólo se leen columnas operativas.
// El taller y el alcance (todas las órdenes o sólo las asignadas) salen siempre de la sesión.
import type { Sesion } from '../env';
import { tiene } from './auth';
import { all, first } from './db';
import { nombreUsuarioSql } from './tareas';
import { zonaDelTaller } from './zona';
import type { DatosHoja } from './hoja-orden';
import { claveMiniatura, sha256 } from './fotos';
import { leerJpeg } from './pdf/escritor';
import { resumenPagoParaHoja } from './pago-cliente';

const LOGO_JPEG = /^data:image\/jpe?g;base64,([A-Za-z0-9+/=]+)$/;

function jpegDeLogo(logo: string | null): Uint8Array | null {
  const m = logo ? LOGO_JPEG.exec(logo) : null;
  if (!m) return null;
  try {
    return Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Tope de la miniatura que se incrusta: la hoja es de 30 × 23 mm, así que una imagen de hasta 640 px de lado (≤ 200 KB al subirla) sobra. */
const MAX_FOTO_PDF_BYTES = 200_000;
const CANDIDATAS_FOTO = 4;

/**
 * Fotografía del vehículo para el encabezado de la hoja (miniatura JPEG tomada de R2 en el servidor; no hay enlace público al bucket).
 * Orden: 1) fotos de la galería del vehículo (sin OT), la más reciente; 2) fotos de recepción de ESTA orden; 3) las demás fotos de esta orden.
 * Nunca se usan fotos de otras órdenes del vehículo ni imágenes genéricas. Mismos permisos que la descarga normal (`fotos.ver`; la galería exige `vehiculos.ver`).
 * Cualquier problema (sin bucket, objeto faltante, hash distinto, formato no incrustable) pasa a la siguiente candidata y, al final, a ninguna: la hoja sale igual.
 */
export async function fotoParaHoja(db: D1Database, bucket: R2Bucket | undefined, s: Sesion, vehiculoId: string, ordenId: string): Promise<Uint8Array | null> {
  if (!bucket || !tiene(s, 'fotos.ver')) return null;
  try {
    const galeria = tiene(s, 'vehiculos.ver');
    const filas = await all<{ id: string; miniatura_bytes: number; miniatura_sha256: string }>(
      db,
      `SELECT id, miniatura_bytes, miniatura_sha256 FROM fotos
        WHERE taller_id = ? AND vehiculo_id = ? AND estado = 'lista' AND (orden_id = ?${galeria ? ' OR orden_id IS NULL' : ''}) AND miniatura_bytes <= ?
        ORDER BY CASE WHEN orden_id IS NULL THEN 0 WHEN etapa = 'recepcion' THEN 1 ELSE 2 END, created_at DESC, id LIMIT ?`,
      s.tallerId, vehiculoId, ordenId, MAX_FOTO_PDF_BYTES, CANDIDATAS_FOTO,
    );
    for (const f of filas) {
      try {
        const obj = await bucket.get(claveMiniatura(s.tallerId, f.id));
        if (!obj) continue;
        const bytes = new Uint8Array(await obj.arrayBuffer());
        if (bytes.length !== f.miniatura_bytes || (await sha256(bytes)) !== f.miniatura_sha256) continue;
        if (leerJpeg(bytes)) return bytes;
      } catch {
        /* siguiente candidata */
      }
    }
  } catch {
    /* la foto es opcional */
  }
  return null;
}

/** Devuelve los datos operativos de la orden, o null si no existe, es de otro taller o la sesión no tiene acceso a ella. */
/** `alcance`: condición SQL (sobre el alias `o`) y parámetros que limitan las órdenes a las que la sesión tiene acceso. `bucket`: R2 de fotos; sólo se pasa en las hojas que llevan la foto del vehículo. */
export async function datosHojaOrden(db: D1Database, s: Sesion, ordenId: string, alcance: { cond: string[]; params: unknown[] }, bucket?: R2Bucket, opciones: { cliente?: boolean; pago?: boolean } = {}): Promise<DatosHoja | null> {
  // Los datos del cliente se leen únicamente si la copia pedida los muestra (`opciones.cliente`) Y la sesión puede ver clientes. En la copia del mecánico
  // (y en la del cliente, que no los lleva) la consulta ni siquiera selecciona esas columnas: no pueden filtrarse por error.
  const verCliente = !!opciones.cliente && tiene(s, 'clientes.ver');
  const o = await first<{
    id: string; vehiculo_id: string; numero: number; fecha_ingreso: string; fecha_prometida: string | null; km_ingreso: number | null; falla_reportada: string | null; diagnostico: string | null; observaciones: string | null;
    cliente: string | null; cliente_telefono: string | null; patente: string; anio: number | null; marca: string | null; modelo: string | null; mecanico: string | null;
  }>(
    db,
    `SELECT o.id, o.vehiculo_id, o.numero, o.fecha_ingreso, o.fecha_prometida, o.km_ingreso, o.falla_reportada, o.diagnostico, o.observaciones,
            ${verCliente ? 'c.nombre' : 'NULL'} AS cliente, ${verCliente ? 'c.telefono' : 'NULL'} AS cliente_telefono, v.patente, v.anio, ma.nombre AS marca, mo.nombre AS modelo, m.nombre AS mecanico
       FROM ordenes o
       ${verCliente ? 'JOIN clientes c ON c.taller_id = o.taller_id AND c.id = o.cliente_id' : ''}
       JOIN vehiculos v ON v.taller_id = o.taller_id AND v.id = o.vehiculo_id
       LEFT JOIN marcas ma ON ma.taller_id = v.taller_id AND ma.id = v.marca_id
       LEFT JOIN modelos mo ON mo.taller_id = v.taller_id AND mo.id = v.modelo_id
       LEFT JOIN mecanicos m ON m.taller_id = o.taller_id AND m.id = o.mecanico_id
      WHERE o.taller_id = ? AND o.id = ?${alcance.cond.map((x) => ` AND ${x}`).join('')}`,
    s.tallerId, ordenId, ...alcance.params,
  );
  if (!o) return null;

  // El pago del cliente se lee únicamente si la copia pedida lo muestra (`opciones.pago`) Y la sesión puede ver ventas: la copia del mecánico no lo pide jamás.
  const verPago = !!opciones.pago && tiene(s, 'ventas.ver');
  const [items, participantes, taller, zona, foto, pago] = await Promise.all([
    all<{ tipo: string; descripcion: string; cantidad: number; unidad: string | null }>(
      db,
      `SELECT oi.tipo, oi.descripcion, oi.cantidad, a.unidad FROM orden_items oi
         LEFT JOIN articulos a ON a.taller_id = oi.taller_id AND a.id = oi.articulo_id
        WHERE oi.taller_id = ? AND oi.orden_id = ? ORDER BY oi.orden`,
      s.tallerId, o.id,
    ),
    all<{ nombre: string }>(
      db,
      `SELECT ${nombreUsuarioSql('u')} AS nombre FROM orden_participantes p JOIN usuarios u ON u.taller_id = p.taller_id AND u.id = p.usuario_id
        WHERE p.taller_id = ? AND p.orden_id = ? ORDER BY p.created_at`,
      s.tallerId, o.id,
    ),
    first<{ nombre: string; razon_social: string | null; direccion: string | null; localidad: string | null; telefono: string | null; email: string | null; logo: string | null }>(
      db,
      `SELECT t.nombre, t.razon_social, t.direccion, t.localidad, t.telefono, t.email, cf.logo
         FROM talleres t LEFT JOIN taller_config cf ON cf.taller_id = t.id WHERE t.id = ?`,
      s.tallerId,
    ),
    zonaDelTaller(db, s.tallerId),
    fotoParaHoja(db, bucket, s, o.vehiculo_id, o.id),
    verPago ? resumenPagoParaHoja(db, s.tallerId, o.id) : Promise.resolve(null),
  ]);

  return {
    taller: {
      nombre: taller?.nombre ?? '',
      razonSocial: taller?.razon_social ?? null,
      direccion: [taller?.direccion, taller?.localidad].filter(Boolean).join(', ') || null,
      telefono: taller?.telefono ?? null,
      email: taller?.email ?? null,
    },
    logo: jpegDeLogo(taller?.logo ?? null),
    foto,
    orden: { numero: o.numero, fechaApertura: o.fecha_ingreso, fechaPrometida: o.fecha_prometida },
    // `visible` indica que la copia puede mostrar al cliente; en la de administración sin permiso se imprime «No disponible…».
    cliente: { visible: verCliente, nombre: o.cliente, telefono: o.cliente_telefono },
    vehiculo: { patente: o.patente, marca: o.marca, modelo: o.modelo, anio: o.anio, km: o.km_ingreso },
    tecnico: { responsable: o.mecanico, participantes: participantes.map((p) => p.nombre).filter(Boolean) },
    motivo: o.falla_reportada,
    diagnostico: o.diagnostico,
    observaciones: o.observaciones,
    trabajos: items.filter((i) => i.tipo !== 'articulo').map((i) => ({ descripcion: i.descripcion, cantidad: i.cantidad })),
    repuestos: items.filter((i) => i.tipo === 'articulo').map((i) => ({ descripcion: i.descripcion, cantidad: i.cantidad, unidad: i.unidad })),
    pago,
    zonaHoraria: zona,
    impresoAt: new Date(),
  };
}
