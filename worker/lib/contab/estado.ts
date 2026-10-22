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
  /** Cola de contabilización: operaciones confirmadas que esperan su asiento (se reintentan solas) y las que agotaron los reintentos. */
  cola: { pendientes: number; fallidas: number; mas_antigua: string | null };
  /** Hay un recorrido completo (histórico o verificación) en curso o por continuar. */
  reconciliando: boolean;
  ultima_reconciliacion: string | null;
  /** Sólo con `detalle`: cobertura por tipo de operación. Es la parte que recorre el historial; por eso no se incluye en las consultas frecuentes. */
  por_origen: EstadoOrigen[];
  detalle: boolean;
  ultima_corrida: { iniciada_at: string; disparador: string; asientos_creados: number; asientos_historicos: number; omitidos: number } | null;
}

/**
 * Estado de la contabilidad (solo lectura).
 *  * Sin `detalle` (las consultas frecuentes, p. ej. el aviso que se refresca solo): sale de la cola y de contadores, con costo constante.
 *  * Con `detalle` (activación y revisión): además cuenta, por tipo de operación, cuántos documentos hay y cuántos tienen asiento — eso recorre el historial.
 */
export async function estadoContabilidad(db: D1Database, tallerId: string, opciones: { detalle?: boolean } = {}): Promise<EstadoContabilidad> {
  const [cfg, totales, colaFilas, omit, corrida] = await Promise.all([
    first<{ inicializado_at: string; ultima_corrida_at: string | null; sync_bloqueo_hasta: string | null; sync_solicitada: number; ultimo_error: string | null; ultimo_error_at: string | null; reconciliar_pendiente: number; reconciliada_at: string | null }>(
      db, 'SELECT inicializado_at, ultima_corrida_at, sync_bloqueo_hasta, sync_solicitada, ultimo_error, ultimo_error_at, reconciliar_pendiente, reconciliada_at FROM contab_config WHERE taller_id = ?', tallerId,
    ),
    // Los asientos registrados llevan número correlativo sin saltos: el mayor número es la cantidad (y es una búsqueda por índice, no un recorrido).
    first<{ asientos: number; cuentas: number }>(
      db, 'SELECT COALESCE((SELECT MAX(numero) FROM asientos WHERE taller_id = ? AND numero IS NOT NULL), 0) AS asientos, (SELECT COUNT(*) FROM cuentas_contables WHERE taller_id = ?) AS cuentas', tallerId, tallerId,
    ),
    all<{ evento: string; estado: string; n: number; mas_antigua: string | null }>(db, 'SELECT evento, estado, COUNT(*) AS n, MIN(creada_at) AS mas_antigua FROM contab_cola WHERE taller_id = ? GROUP BY evento, estado', tallerId),
    all<{ origen_tipo: string; tipo: string; n: number }>(db, "SELECT origen_tipo, tipo, COUNT(*) AS n FROM contab_omitidos WHERE taller_id = ? AND evento = 'alta' GROUP BY origen_tipo, tipo", tallerId),
    first<{ iniciada_at: string; disparador: string; asientos_creados: number; asientos_historicos: number; omitidos: number }>(
      db, 'SELECT iniciada_at, disparador, asientos_creados, asientos_historicos, omitidos FROM contab_corridas WHERE taller_id = ? ORDER BY iniciada_at DESC LIMIT 1', tallerId,
    ),
  ]);
  const enCola = (evento: string, estado: string) => colaFilas.find((x) => x.evento === evento && x.estado === estado)?.n ?? 0;
  const cola = {
    pendientes: enCola('alta', 'pendiente') + enCola('anulacion', 'pendiente'),
    fallidas: enCola('alta', 'fallida') + enCola('anulacion', 'fallida'),
    mas_antigua: colaFilas.reduce<string | null>((m, x) => (x.mas_antigua && (!m || x.mas_antigua < m) ? x.mas_antigua : m), null),
  };
  const omitErr = omit.filter((x) => x.tipo === 'error').reduce((a, x) => a + x.n, 0);
  const omitSinEfecto = omit.filter((x) => x.tipo === 'sin_efecto').reduce((a, x) => a + x.n, 0);

  const por_origen: EstadoOrigen[] = [];
  let pendientes = enCola('alta', 'pendiente') + enCola('alta', 'fallida');
  let anulaciones_pendientes = enCola('anulacion', 'pendiente') + enCola('anulacion', 'fallida');
  let errores = Math.max(omitErr, cola.fallidas);
  let sin_efecto = omitSinEfecto;
  const detalle = opciones.detalle ?? !cfg;
  if (detalle) {
    const hechas = new Map((await all<{ origen_tipo: string; n: number }>(db, "SELECT origen_tipo, COUNT(*) AS n FROM asientos WHERE taller_id = ? AND evento = 'alta' GROUP BY origen_tipo", tallerId)).map((r) => [r.origen_tipo, r.n]));
    for (const f of FUENTES) {
      const docs = (await first<{ docs: number }>(db, f.cobertura.sql, tallerId))?.docs ?? 0;
      const o = (t: string) => omit.find((x) => x.origen_tipo === f.tipo && x.tipo === t)?.n ?? 0;
      const contabilizados = hechas.get(f.tipo) ?? 0;
      por_origen.push({
        tipo: f.tipo, etiqueta: f.etiqueta, documentos: docs, contabilizados, sin_efecto: o('sin_efecto'), errores: o('error'),
        pendientes: Math.max(0, docs - contabilizados - o('sin_efecto') - o('error')),
      });
    }
    // Con el recorrido completo se ve también lo que nunca llegó a la cola (histórico anterior a la activación).
    pendientes = por_origen.reduce((a, x) => a + x.pendientes, 0);
    errores = por_origen.reduce((a, x) => a + x.errores, 0);
    sin_efecto = por_origen.reduce((a, x) => a + x.sin_efecto, 0);
    // Anulaciones pendientes: sólo tienen sentido cuando la contabilidad está activada (si no, ni siquiera hay altas).
    anulaciones_pendientes = 0;
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
  }
  const sincronizando = !!cfg?.sync_bloqueo_hasta && cfg.sync_bloqueo_hasta > ahora();
  const reconciliando = !!cfg?.reconciliar_pendiente;
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
    al_dia: !!cfg && !sincronizando && !reconciliando && pendientes === 0 && anulaciones_pendientes === 0 && errores === 0 && cola.pendientes === 0 && cola.fallidas === 0,
    cola,
    reconciliando,
    ultima_reconciliacion: cfg?.reconciliada_at ?? null,
    por_origen: por_origen.filter((x) => x.documentos > 0 || x.contabilizados > 0),
    detalle,
    ultima_corrida: corrida ?? null,
  };
}
