// Rentabilidad de las órdenes de trabajo (repuestos + mano de obra), con sus costos HISTÓRICOS.
//
// Qué es histórico y qué no:
//  * Repuestos: el costo es el que tenían al descontarse del stock (movimientos `consumo_ot`); antes de descontarse es una estimación con el costo actual.
//  * Mano de obra real: cada tramo del cronómetro (`orden_tiempos`, el mismo de los Sprints 06/07) congela el costo horario vigente cuando se cierra
//    (trigger de la base). Cambiar los costos configurados después no altera lo ya trabajado. Los tramos anteriores a esta función no tienen costo y se
//    informan como faltantes: NUNCA se reconstruyen con el costo de hoy.
//  * Mano de obra estimada: se calcula con los tiempos estimados de las tareas y los costos horarios del momento en que la orden queda lista/entregada y se
//    guarda en la orden (`mo_costo_estimado`). Mientras la orden está abierta es provisoria.
// Un margen se presenta como definitivo solo cuando todos los datos necesarios están completos; si no, se marca estimado o parcial y se dice qué falta.
import { all, first, lotes } from './db';

export type Calidad = 'definitivo' | 'estimado' | 'parcial';
export type BaseCostoMO = 'real' | 'estimado' | 'parcial' | 'sin_mano_obra';

export interface Rentabilidad {
  orden_id: string;
  estado: string;
  cerrada: boolean;
  // Mano de obra
  mo_cobrada: number; // neta de devoluciones, sin IVA ni descuento global
  mo_devuelta: number;
  mo_costo_estimado: number | null;
  mo_estimado_congelado: boolean;
  mo_estimado_completo: boolean;
  mo_costo_real: number;
  mo_segundos: number;
  mo_segundos_sin_costo: number;
  tramos_abiertos: number;
  tareas_sin_tiempo: number;
  mo_base: BaseCostoMO;
  mo_costo: number; // el que entra en el margen según la base elegida
  // Repuestos
  repuestos_venta: number; // neta de devoluciones
  repuestos_devuelto: number;
  repuestos_costo: number; // neto del costo de lo que volvió al inventario
  repuestos_costo_estimado: boolean;
  // Resultado
  ingresos: number;
  costos: number;
  margen_bruto: number;
  margen_pct: number | null;
  calidad: Calidad;
  faltantes: string[];
}

interface OrdenBase {
  id: string; estado: string; stock_aplicado: number; subtotal_articulos: number; subtotal_servicios: number; descuento: number;
  mo_estimado_at: string | null; mo_costo_estimado: number | null; mo_estimado_completo: number | null;
}

export interface EstimacionMO {
  orden_id: string;
  importe: number;
  minutos: number;
  tareas: number;
  tareas_sin_tiempo: number;
  tareas_sin_costo: number;
  completo: boolean;
}

const COSTO_TAREA = 'COALESCE(u.costo_hora, cfg.g)';

/** Estimación de la mano de obra de las órdenes: tiempo estimado de cada tarea × costo horario de su responsable (o el general del taller). */
export async function estimarManoObra(db: D1Database, tallerId: string, ordenIds: string[]): Promise<EstimacionMO[]> {
  const out: EstimacionMO[] = [];
  for (const lote of lotes(ordenIds)) {
    const filas = await all<{ orden_id: string; tareas: number; sin_tiempo: number; sin_costo: number; importe: number; minutos: number }>(
      db,
      `SELECT t.orden_id, COUNT(*) AS tareas,
              SUM(CASE WHEN t.tiempo_estimado_min IS NULL THEN 1 ELSE 0 END) AS sin_tiempo,
              SUM(CASE WHEN ${COSTO_TAREA} IS NULL THEN 1 ELSE 0 END) AS sin_costo,
              COALESCE(SUM(COALESCE(t.tiempo_estimado_min, 0) * COALESCE(${COSTO_TAREA}, 0) / 60.0), 0) AS importe,
              COALESCE(SUM(COALESCE(t.tiempo_estimado_min, 0)), 0) AS minutos
         FROM orden_tareas t
         LEFT JOIN usuarios u ON u.taller_id = t.taller_id AND u.id = t.responsable_id
         LEFT JOIN (SELECT costo_hora_general AS g FROM taller_config WHERE taller_id = ?) cfg ON 1 = 1
        WHERE t.taller_id = ? AND t.orden_id IN (${lote.map(() => '?').join(',')}) GROUP BY t.orden_id`,
      tallerId, tallerId, ...lote,
    );
    for (const id of lote) {
      const f = filas.find((x) => x.orden_id === id);
      out.push({
        orden_id: id, importe: Math.round(f?.importe ?? 0), minutos: f?.minutos ?? 0, tareas: f?.tareas ?? 0,
        tareas_sin_tiempo: f?.sin_tiempo ?? 0, tareas_sin_costo: f?.sin_costo ?? 0, completo: !!f && f.tareas > 0 && f.sin_tiempo === 0 && f.sin_costo === 0,
      });
    }
  }
  return out;
}

const horas = (seg: number) => `${(seg / 3600).toFixed(1).replace('.', ',')} h`;
const sumaPor = <T extends { orden_id: string }>(filas: T[], id: string) => filas.find((f) => f.orden_id === id);

/** Rentabilidad de un conjunto de órdenes del taller (siempre filtradas por taller_id). */
export async function rentabilidadOrdenes(db: D1Database, tallerId: string, ids: string[]): Promise<Map<string, Rentabilidad>> {
  const resultado = new Map<string, Rentabilidad>();
  for (const lote of lotes(ids)) {
    const marcas = lote.map(() => '?').join(',');
    const [ordenes, repuestosEst, consumo, tramos, completadasSinTiempo, devs, estimaciones] = await Promise.all([
      all<OrdenBase>(db, `SELECT id, estado, stock_aplicado, subtotal_articulos, subtotal_servicios, descuento, mo_estimado_at, mo_costo_estimado, mo_estimado_completo FROM ordenes WHERE taller_id = ? AND id IN (${marcas})`, tallerId, ...lote),
      all<{ orden_id: string; costo: number }>(
        db,
        `SELECT oi.orden_id, SUM(oi.cantidad * COALESCE(a.costo, 0)) AS costo FROM orden_items oi LEFT JOIN articulos a ON a.taller_id = oi.taller_id AND a.id = oi.articulo_id
          WHERE oi.taller_id = ? AND oi.tipo = 'articulo' AND oi.orden_id IN (${marcas}) GROUP BY oi.orden_id`,
        tallerId, ...lote,
      ),
      all<{ orden_id: string; costo: number }>(
        db,
        `SELECT sm.origen_id AS orden_id, SUM(-sm.cantidad * COALESCE(sm.costo_unitario, a.costo, 0)) AS costo FROM stock_movimientos sm LEFT JOIN articulos a ON a.taller_id = sm.taller_id AND a.id = sm.articulo_id
          WHERE sm.taller_id = ? AND sm.origen_tipo = 'orden' AND sm.tipo IN ('consumo_ot','reverso_ot') AND sm.origen_id IN (${marcas}) GROUP BY sm.origen_id`,
        tallerId, ...lote,
      ),
      all<{ orden_id: string; seg: number; costo: number; sin_costo: number; abiertos: number }>(
        db,
        `SELECT orden_id, COALESCE(SUM(duracion_seg), 0) AS seg,
                COALESCE(SUM(CASE WHEN costo_hora IS NOT NULL THEN duracion_seg * costo_hora / 3600.0 END), 0) AS costo,
                COALESCE(SUM(CASE WHEN fin_at IS NOT NULL AND costo_hora IS NULL THEN duracion_seg ELSE 0 END), 0) AS sin_costo,
                SUM(CASE WHEN fin_at IS NULL THEN 1 ELSE 0 END) AS abiertos
           FROM orden_tiempos WHERE taller_id = ? AND orden_id IN (${marcas}) GROUP BY orden_id`,
        tallerId, ...lote,
      ),
      all<{ orden_id: string; n: number }>(
        db,
        `SELECT t.orden_id, COUNT(*) AS n FROM orden_tareas t WHERE t.taller_id = ? AND t.estado = 'completada' AND t.orden_id IN (${marcas})
            AND NOT EXISTS (SELECT 1 FROM orden_tiempos x WHERE x.taller_id = t.taller_id AND x.tarea_id = t.id AND x.duracion_seg > 0) GROUP BY t.orden_id`,
        tallerId, ...lote,
      ),
      all<{ orden_id: string; tipo: string; neto: number; costo: number }>(
        db,
        `SELECT ve.orden_id, CASE di.tipo WHEN 'articulo' THEN 'articulo' ELSE 'mano_obra' END AS tipo, SUM(di.importe_neto) AS neto,
                SUM(CASE WHEN di.reingresa = 1 THEN di.cantidad * COALESCE(di.costo_unitario, 0) ELSE 0 END) AS costo
           FROM devolucion_items di
           JOIN devoluciones dv ON dv.taller_id = di.taller_id AND dv.id = di.devolucion_id AND dv.estado = 'registrada'
           JOIN ventas ve ON ve.taller_id = dv.taller_id AND ve.id = dv.venta_id
          WHERE di.taller_id = ? AND ve.orden_id IN (${marcas}) GROUP BY ve.orden_id, CASE di.tipo WHEN 'articulo' THEN 'articulo' ELSE 'mano_obra' END`,
        tallerId, ...lote,
      ),
      estimarManoObra(db, tallerId, lote),
    ]);
    for (const o of ordenes) {
      const bruto = o.subtotal_articulos + o.subtotal_servicios;
      const factor = bruto > 0 ? (bruto - o.descuento) / bruto : 1;
      const cerrada = o.estado === 'lista' || o.estado === 'entregada';
      const devArt = devs.find((x) => x.orden_id === o.id && x.tipo === 'articulo');
      const devMo = devs.find((x) => x.orden_id === o.id && x.tipo === 'mano_obra');
      const hayRepuestos = o.subtotal_articulos > 0;
      const hayMO = o.subtotal_servicios > 0;
      const mo_cobrada = Math.round(o.subtotal_servicios * factor) - Math.round(devMo?.neto ?? 0);
      const repuestos_venta = Math.round(o.subtotal_articulos * factor) - Math.round(devArt?.neto ?? 0);
      const costoBruto = o.stock_aplicado ? Math.round(sumaPor(consumo, o.id)?.costo ?? 0) : Math.round(sumaPor(repuestosEst, o.id)?.costo ?? 0);
      const repuestos_costo = costoBruto - Math.round(devArt?.costo ?? 0);
      const t = sumaPor(tramos, o.id);
      const seg = t?.seg ?? 0;
      const segSinCosto = t?.sin_costo ?? 0;
      const abiertos = t?.abiertos ?? 0;
      const sinTiempo = sumaPor(completadasSinTiempo, o.id)?.n ?? 0;
      const costoReal = Math.round(t?.costo ?? 0);
      const congelado = !!o.mo_estimado_at;
      const live = estimaciones.find((e) => e.orden_id === o.id)!;
      // Las órdenes cerradas con una estimación congelada la conservan; las cerradas antes de esta función no tienen estimación (no se reconstruye con costos de hoy).
      const estimado: { importe: number | null; completo: boolean } = congelado
        ? { importe: o.mo_costo_estimado, completo: !!o.mo_estimado_completo }
        : cerrada ? { importe: null, completo: false } : { importe: live.importe, completo: live.completo };

      const faltantes: string[] = [];
      let base: BaseCostoMO;
      if (!hayMO && seg === 0) base = 'sin_mano_obra';
      else if (seg > 0 && segSinCosto === 0 && abiertos === 0 && sinTiempo === 0) base = 'real';
      else if (estimado.completo && estimado.importe != null) base = 'estimado';
      else base = 'parcial';
      if (hayMO || seg > 0) {
        if (abiertos > 0) faltantes.push('Hay un cronómetro en marcha: el tiempo real todavía no está completo');
        if (segSinCosto > 0) faltantes.push(`${horas(segSinCosto)} trabajadas sin costo horario configurado (no se reconstruyen con el costo actual)`);
        if (seg === 0) faltantes.push('No hay tiempo registrado con el cronómetro en esta orden');
        if (sinTiempo > 0) faltantes.push(`${sinTiempo} tarea(s) completada(s) sin tiempo cronometrado`);
        if (base === 'parcial') {
          if (cerrada && !congelado) faltantes.push('La orden se cerró antes de configurar el costo de mano de obra: no hay estimación guardada');
          else if (!estimado.completo) faltantes.push(live.tareas === 0 && !congelado ? 'La orden no tiene tareas con tiempo estimado' : 'Faltan tiempos estimados o costos horarios para estimar la mano de obra');
        }
      }
      if (!cerrada) faltantes.push(o.estado === 'cancelada' ? 'La orden está cancelada' : 'La orden todavía está abierta: importes y costos pueden cambiar');
      if (hayRepuestos && !o.stock_aplicado) faltantes.push('Los repuestos aún no se descontaron del stock: su costo es una estimación con el costo actual');

      const mo_costo = base === 'real' ? costoReal : base === 'estimado' ? estimado.importe ?? 0 : base === 'parcial' ? Math.max(costoReal, 0) : 0;
      const ingresos = mo_cobrada + repuestos_venta;
      const costos = repuestos_costo + mo_costo;
      const margen = ingresos - costos;
      const calidad: Calidad = base === 'parcial' ? 'parcial' : cerrada && (o.stock_aplicado || !hayRepuestos) && (base === 'real' || base === 'sin_mano_obra') ? 'definitivo' : 'estimado';
      resultado.set(o.id, {
        orden_id: o.id, estado: o.estado, cerrada,
        mo_cobrada, mo_devuelta: Math.round(devMo?.neto ?? 0), mo_costo_estimado: estimado.importe, mo_estimado_congelado: congelado, mo_estimado_completo: estimado.completo,
        mo_costo_real: costoReal, mo_segundos: seg, mo_segundos_sin_costo: segSinCosto, tramos_abiertos: abiertos, tareas_sin_tiempo: sinTiempo, mo_base: base, mo_costo,
        repuestos_venta, repuestos_devuelto: Math.round(devArt?.neto ?? 0), repuestos_costo, repuestos_costo_estimado: hayRepuestos && !o.stock_aplicado,
        ingresos, costos, margen_bruto: margen, margen_pct: ingresos > 0 ? Math.round((margen / ingresos) * 1000) / 10 : null, calidad, faltantes,
      });
    }
  }
  return resultado;
}

/** Costo horario aplicable a una persona hoy (para mostrar en la configuración): el propio o el general. */
export async function costoHoraVigente(db: D1Database, tallerId: string, usuarioId: string): Promise<{ costo_hora: number | null; origen: 'persona' | 'general' | null }> {
  const f = await first<{ p: number | null; g: number | null }>(
    db, 'SELECT (SELECT costo_hora FROM usuarios WHERE taller_id = ? AND id = ?) AS p, (SELECT costo_hora_general FROM taller_config WHERE taller_id = ?) AS g', tallerId, usuarioId, tallerId,
  );
  if (f?.p != null) return { costo_hora: f.p, origen: 'persona' };
  if (f?.g != null) return { costo_hora: f.g, origen: 'general' };
  return { costo_hora: null, origen: null };
}

