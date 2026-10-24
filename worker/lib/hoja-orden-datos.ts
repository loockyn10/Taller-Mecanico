// Datos de la hoja de la orden de trabajo (PDF). Arma `DatosHoja` con una consulta propia y acotada: NO reutiliza la consulta del detalle de la OT
// (que trae importes, totales y costos de mano de obra) ni el endpoint administrativo; acá sólo se leen columnas operativas.
// El taller y el alcance (todas las órdenes o sólo las asignadas) salen siempre de la sesión.
import type { Sesion } from '../env';
import { tiene } from './auth';
import { all, first } from './db';
import { nombreUsuarioSql } from './tareas';
import { zonaDelTaller } from './zona';
import type { DatosHoja } from './hoja-orden';

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

/** Devuelve los datos operativos de la orden, o null si no existe, es de otro taller o la sesión no tiene acceso a ella. */
/** `alcance`: condición SQL (sobre el alias `o`) y parámetros que limitan las órdenes a las que la sesión tiene acceso. */
export async function datosHojaOrden(db: D1Database, s: Sesion, ordenId: string, alcance: { cond: string[]; params: unknown[] }): Promise<DatosHoja | null> {
  const o = await first<{
    id: string; numero: number; fecha_ingreso: string; fecha_prometida: string | null; km_ingreso: number | null; falla_reportada: string | null; diagnostico: string | null; observaciones: string | null;
    cliente: string; cliente_telefono: string | null; patente: string; anio: number | null; marca: string | null; modelo: string | null; mecanico: string | null;
  }>(
    db,
    `SELECT o.id, o.numero, o.fecha_ingreso, o.fecha_prometida, o.km_ingreso, o.falla_reportada, o.diagnostico, o.observaciones,
            c.nombre AS cliente, c.telefono AS cliente_telefono, v.patente, v.anio, ma.nombre AS marca, mo.nombre AS modelo, m.nombre AS mecanico
       FROM ordenes o
       JOIN clientes c ON c.taller_id = o.taller_id AND c.id = o.cliente_id
       JOIN vehiculos v ON v.taller_id = o.taller_id AND v.id = o.vehiculo_id
       LEFT JOIN marcas ma ON ma.taller_id = v.taller_id AND ma.id = v.marca_id
       LEFT JOIN modelos mo ON mo.taller_id = v.taller_id AND mo.id = v.modelo_id
       LEFT JOIN mecanicos m ON m.taller_id = o.taller_id AND m.id = o.mecanico_id
      WHERE o.taller_id = ? AND o.id = ?${alcance.cond.map((x) => ` AND ${x}`).join('')}`,
    s.tallerId, ordenId, ...alcance.params,
  );
  if (!o) return null;

  const [items, participantes, taller, zona] = await Promise.all([
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
  ]);

  // Con permiso para ver clientes se muestran el nombre y el teléfono; sin él, ninguno de los dos.
  const verCliente = tiene(s, 'clientes.ver');
  return {
    taller: {
      nombre: taller?.nombre ?? '',
      razonSocial: taller?.razon_social ?? null,
      direccion: [taller?.direccion, taller?.localidad].filter(Boolean).join(', ') || null,
      telefono: taller?.telefono ?? null,
      email: taller?.email ?? null,
    },
    logo: jpegDeLogo(taller?.logo ?? null),
    orden: { numero: o.numero, fechaApertura: o.fecha_ingreso, fechaPrometida: o.fecha_prometida },
    cliente: { visible: verCliente, nombre: verCliente ? o.cliente : null, telefono: verCliente ? o.cliente_telefono : null },
    vehiculo: { patente: o.patente, marca: o.marca, modelo: o.modelo, anio: o.anio, km: o.km_ingreso },
    tecnico: { responsable: o.mecanico, participantes: participantes.map((p) => p.nombre).filter(Boolean) },
    motivo: o.falla_reportada,
    diagnostico: o.diagnostico,
    observaciones: o.observaciones,
    trabajos: items.filter((i) => i.tipo !== 'articulo').map((i) => ({ descripcion: i.descripcion, cantidad: i.cantidad })),
    repuestos: items.filter((i) => i.tipo === 'articulo').map((i) => ({ descripcion: i.descripcion, cantidad: i.cantidad, unidad: i.unidad })),
    zonaHoraria: zona,
    impresoAt: new Date(),
  };
}
