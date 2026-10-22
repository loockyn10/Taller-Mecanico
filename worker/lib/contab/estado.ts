// Estado de la contabilidad de un taller: SOLO LECTURA. Responde "¿está activada?, ¿está al día?, ¿qué falta contabilizar y por qué?" sin generar nada.
// Es lo que mira la pantalla de Contabilidad en lugar de disparar la sincronización al abrirse.
import { all, ahora, first, lotes } from '../db';
import { FUENTES, type Ctx } from './fuentes';
import { cargarMapa } from './plan';

export interface EstadoOrigen {
  tipo: string;
  etiqueta: string;
  documentos: number;
  contabilizados: number;
  sin_efecto: number;
  errores: number;
  pendientes: number;
}

export interface EstadoContabilidad {
  activada: boolean;
  activada_at: string | null;
  /** Hay un proceso de contabilización corriendo en este momento. */
  sincronizando: boolean;
  /** Llegó una operación mientras corría otro proceso: se va a repetir. */
  repeticion_pedida: boolean;
  ultima_sincronizacion: string | null;
  ultimo_error: { mensaje: string; fecha: string | null } | null;
  asientos: number;
  cuentas: number;
  /** Altas de operaciones que todavía no tienen asiento. */
  pendientes: number;
  /** Anulaciones de operaciones ya contabilizadas cuyo contra-asiento falta (se cuenta hasta 50 por tipo de operación). */
  anulaciones_pendientes: number;
  errores: number;
  sin_efecto: number;
  /** Activada, sin pendientes ni errores y sin proceso corriendo. */
  al_dia: boolean;
  por_origen: EstadoOrigen[];
  ultima_corrida: { iniciada_at: string; disparador: string; asientos_creados: number; asientos_historicos: number; omitidos: number } | null;
}

export async function estadoContabilidad(db: D1Database, tallerId: string): Promise<EstadoContabilidad> {
  const [cfg, totales, altas, omit, corrida] = await Promise.all([
    first<{ inicializado_at: string; ultima_corrida_at: string | null; sync_bloqueo_hasta: string | null; sync_solicitada: number; ultimo_error: string | null; ultimo_error_at: string | null }>(
      db, 'SELECT inicializado_at, ultima_corrida_at, sync_bloqueo_hasta, sync_solicitada, ultimo_error, ultimo_error_at FROM contab_config WHERE taller_id = ?', tallerId,
    ),
    first<{ asientos: number; cuentas: number }>(
      db, 'SELECT (SELECT COUNT(*) FROM asientos WHERE taller_id = ?) AS asientos, (SELECT COUNT(*) FROM cuentas_contables WHERE taller_id = ?) AS cuentas', tallerId, tallerId,
    ),
    all<{ origen_tipo: string; n: number }>(db, "SELECT origen_tipo, COUNT(*) AS n FROM asientos WHERE taller_id = ? AND evento = 'alta' GROUP BY origen_tipo", tallerId),
    all<{ origen_tipo: string; tipo: string; n: number }>(db, "SELECT origen_tipo, tipo, COUNT(*) AS n FROM contab_omitidos WHERE taller_id = ? AND evento = 'alta' GROUP BY origen_tipo, tipo", tallerId),
    first<{ iniciada_at: string; disparador: string; asientos_creados: number; asientos_historicos: number; omitidos: number }>(
      db, 'SELECT iniciada_at, disparador, asientos_creados, asientos_historicos, omitidos FROM contab_corridas WHERE taller_id = ? ORDER BY iniciada_at DESC LIMIT 1', tallerId,
    ),
  ]);
  const hechas = new Map(altas.map((r) => [r.origen_tipo, r.n]));
  const por_origen: EstadoOrigen[] = [];
  for (const f of FUENTES) {
    const docs = (await first<{ docs: number }>(db, f.cobertura.sql, tallerId))?.docs ?? 0;
    const o = (t: string) => omit.find((x) => x.origen_tipo === f.tipo && x.tipo === t)?.n ?? 0;
    const contabilizados = hechas.get(f.tipo) ?? 0;
    por_origen.push({
      tipo: f.tipo, etiqueta: f.etiqueta, documentos: docs, contabilizados, sin_efecto: o('sin_efecto'), errores: o('error'),
      pendientes: Math.max(0, docs - contabilizados - o('sin_efecto') - o('error')),
    });
  }
  const pendientes = por_origen.reduce((a, x) => a + x.pendientes, 0);
  const errores = por_origen.reduce((a, x) => a + x.errores, 0);
  const sin_efecto = por_origen.reduce((a, x) => a + x.sin_efecto, 0);

  // Anulaciones pendientes: sólo tienen sentido cuando la contabilidad está activada (si no, ni siquiera hay altas).
  let anulaciones_pendientes = 0;
  if (cfg) {
    const mapa = await cargarMapa(db, tallerId);
    const ctx: Ctx = { db, tallerId, inicio: cfg.inicializado_at, rol: (r) => mapa.porRol.get(r) ?? '', banco: (id) => (id ? mapa.porBanco.get(id) ?? null : null), esValida: (id) => mapa.validas.has(id) };
    for (const f of FUENTES) {
      if (!f.anulados) continue;
      try {
        const anuladas = await f.anulados(ctx, 50);
        for (const lote of lotes(anuladas.map((a) => a.origenId))) {
          const n = (await first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM asientos WHERE taller_id = ? AND origen_tipo = ? AND evento = 'alta' AND estado = 'registrado' AND origen_id IN (${lote.map(() => '?').join(',')})`, tallerId, f.tipo, ...lote))?.n ?? 0;
          anulaciones_pendientes += n;
        }
      } catch {
        /* una fuente que no se puede leer ya se informa en Controles; acá no se rompe el estado */
      }
    }
  }
  const sincronizando = !!cfg?.sync_bloqueo_hasta && cfg.sync_bloqueo_hasta > ahora();
  return {
    activada: !!cfg,
    activada_at: cfg?.inicializado_at ?? null,
    sincronizando,
    repeticion_pedida: !!cfg?.sync_solicitada,
    ultima_sincronizacion: cfg?.ultima_corrida_at ?? null,
    ultimo_error: cfg?.ultimo_error ? { mensaje: cfg.ultimo_error, fecha: cfg.ultimo_error_at } : null,
    asientos: totales?.asientos ?? 0,
    cuentas: totales?.cuentas ?? 0,
    pendientes, anulaciones_pendientes, errores, sin_efecto,
    al_dia: !!cfg && !sincronizando && pendientes === 0 && anulaciones_pendientes === 0 && errores === 0,
    por_origen: por_origen.filter((x) => x.documentos > 0 || x.contabilizados > 0),
    ultima_corrida: corrida ?? null,
  };
}
