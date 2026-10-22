// Observabilidad mínima con lo que ya tenemos (D1 + logs del Worker), sin plataformas externas ni datos personales.
//  * Errores no controlados del Worker (HTTP 500): una fila por problema (huella = método + ruta normalizada + mensaje), con contador y fechas.
//  * Medición de consultas D1 por solicitud (sólo si MEDIR_D1=1: para las pruebas de capacidad, nunca en producción).
//  * Informe de salud para el operador de la plataforma.
import type { Env } from '../env';
import { ahora, all, first, run } from './db';
import { sha256Hex } from './crypto';

/** Quita ids y números de una ruta para agrupar el mismo problema ("/api/ventas/8f3c…/anular" → "/api/ventas/:id/anular"). */
export function normalizarRuta(path: string): string {
  return path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/[0-9a-z_-]{20,}(?=\/|$)/gi, '/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:n')
    .slice(0, 160);
}

/** Mensaje sin datos: se quitan correos, cadenas largas de dígitos y valores entre comillas (los errores de SQL a veces repiten el dato). */
export function limpiarMensaje(m: string): string {
  return m
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/\d{6,}/g, '<n>')
    .replace(/'[^']{0,200}'/g, "'…'")
    .replace(/"[^"]{0,200}"/g, '"…"')
    .slice(0, 300);
}

/** Registra un error no controlado. Nunca lanza: la observabilidad no puede producir otro error. */
export async function registrarErrorWorker(db: D1Database, metodo: string, path: string, err: unknown, tallerId?: string | null): Promise<void> {
  try {
    const ruta = normalizarRuta(path);
    const mensaje = limpiarMensaje(`${err instanceof Error ? err.name : 'Error'}: ${err instanceof Error ? err.message : String(err)}`);
    const huella = (await sha256Hex(`${metodo}|${ruta}|${mensaje}`)).slice(0, 16);
    await run(
      db,
      `INSERT INTO errores_worker (huella, metodo, ruta, mensaje, taller_id) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (huella) DO UPDATE SET veces = veces + 1, ultima_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      huella, metodo, ruta, mensaje, tallerId ?? null,
    );
    // Tope: se conservan los 200 problemas más recientes.
    if (Math.random() < 0.02) await run(db, 'DELETE FROM errores_worker WHERE huella NOT IN (SELECT huella FROM errores_worker ORDER BY ultima_at DESC LIMIT 200)');
  } catch {
    /* ignorar */
  }
}

// ───────────────────────── Medición de D1 (pruebas de capacidad) ─────────────────────────
export interface Medicion {
  consultas: number; // llamadas a D1 (first/all/run/raw/exec/batch cuentan una)
  sentencias: number; // sentencias SQL ejecutadas (cada una de un batch cuenta)
  filasLeidas: number;
  filasEscritas: number;
  msD1: number;
  /** Las sentencias que más filas leyeron (texto SQL con marcadores, sin valores): sirve para encontrar cuellos de botella. */
  top: Array<{ filas: number; sql: string }>;
}

type Resultado = { results?: unknown[]; meta?: { rows_read?: number; rows_written?: number } };

/**
 * Envuelve la base para contar consultas, filas leídas/escritas y tiempo en D1. SOLO para mediciones: `first()` se resuelve con `all()` para poder leer
 * los metadatos (la cantidad de filas leídas no está disponible de otro modo).
 */
export function medirD1(db: D1Database, m: Medicion): D1Database {
  const textos = new WeakMap<object, string>();
  const anotarTop = (filas: number, sql: string | undefined) => {
    if (!sql || filas < 50) return;
    m.top.push({ filas, sql: sql.replace(/\s+/g, ' ').slice(0, 140) });
    m.top.sort((a, b) => b.filas - a.filas);
    m.top.length = Math.min(m.top.length, 3);
  };
  const sumar = (r: Resultado | Resultado[], sentencias: number, sql?: string | string[]) => {
    m.consultas += 1;
    m.sentencias += sentencias;
    (Array.isArray(r) ? r : [r]).forEach((x, i) => {
      m.filasLeidas += x?.meta?.rows_read ?? 0;
      m.filasEscritas += x?.meta?.rows_written ?? 0;
      anotarTop(x?.meta?.rows_read ?? 0, Array.isArray(sql) ? sql[i] : sql);
    });
  };
  const cronometrar = async <T>(f: () => Promise<T>): Promise<T> => {
    const t0 = performance.now();
    try {
      return await f();
    } finally {
      m.msD1 += performance.now() - t0;
    }
  };
  const envolver = (st: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy: D1PreparedStatement = new Proxy(st, {
      get(t, p) {
        if (p === 'bind') return (...a: unknown[]) => envolver(t.bind(...a), sql);
        if (p === 'first') {
          return async (col?: string) => {
            const r = await cronometrar(() => t.all());
            sumar(r as Resultado, 1, sql);
            const fila = (r.results?.[0] ?? null) as Record<string, unknown> | null;
            return col ? (fila ? fila[col] ?? null : null) : fila;
          };
        }
        if (p === 'all' || p === 'run' || p === 'raw') {
          return async (...a: unknown[]) => {
            const r = await cronometrar(() => (t as any)[p](...a));
            sumar(Array.isArray(r) ? ({} as Resultado) : (r as Resultado), 1, sql);
            return r;
          };
        }
        const v = (t as any)[p];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    textos.set(proxy, sql);
    return proxy;
  };
  return new Proxy(db, {
    get(t, p) {
      if (p === 'prepare') return (sql: string) => envolver(t.prepare(sql), sql);
      if (p === 'batch') {
        return async (stmts: D1PreparedStatement[]) => {
          const r = await cronometrar(() => t.batch(stmts as never[]));
          sumar(r as Resultado[], stmts.length, stmts.map((x) => textos.get(x) ?? ''));
          return r;
        };
      }
      if (p === 'exec') {
        return async (sql: string) => {
          const r = await cronometrar(() => t.exec(sql));
          m.consultas += 1;
          m.sentencias += 1;
          return r;
        };
      }
      const v = (t as any)[p];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

// ───────────────────────── Mantenimiento periódico y salud ─────────────────────────
export async function latido(db: D1Database, clave: string, ok: boolean, detalle?: unknown): Promise<void> {
  await run(
    db,
    `INSERT INTO plataforma_latidos (clave, ultimo_at, ok, detalle) VALUES (?, ?, ?, ?)
     ON CONFLICT (clave) DO UPDATE SET ultimo_at = excluded.ultimo_at, ok = excluded.ok, detalle = excluded.detalle`,
    clave, ahora(), ok ? 1 : 0, detalle === undefined ? null : JSON.stringify(detalle).slice(0, 1000),
  );
}

/** Limpieza de lo que sólo sirve un tiempo (eventos de seguridad y errores de más de 90 días). No toca datos comerciales ni contables. */
export async function limpiarObservabilidad(db: D1Database): Promise<void> {
  const corte = new Date(Date.now() - 90 * 86400_000).toISOString();
  await db.batch([
    db.prepare('DELETE FROM eventos_seguridad WHERE creado_at < ?').bind(corte),
    db.prepare('DELETE FROM errores_worker WHERE ultima_at < ?').bind(corte),
  ]);
}

export interface InformeSalud {
  generado_at: string;
  alertas: string[];
  mantenimiento: { ultimo_at: string | null; ok: boolean | null; atrasado: boolean; detalle: unknown };
  respaldo_externo: { ultimo_at: string | null; ok: boolean | null; atrasado: boolean; detalle: unknown };
  contabilidad: {
    talleres_activados: number;
    cola_pendiente: number;
    cola_fallida: number;
    cola_mas_antigua: string | null;
    reconciliando: number;
    talleres_con_error: Array<{ taller_id: string; taller: string; ultimo_error: string; fecha: string | null }>;
    talleres_con_cola: Array<{ taller_id: string; taller: string; pendientes: number; fallidas: number; mas_antigua: string }>;
  };
  seguridad: { ultimas_24h: Record<string, number>; origenes_con_mas_fallos: Array<{ origen: string; fallos: number }>; bloqueos_vigentes: number };
  errores_worker: { problemas_24h: number; ocurrencias_24h: number; recientes: Array<{ metodo: string; ruta: string; mensaje: string; veces: number; ultima_at: string }> };
}

const MIN = 60_000;

export async function informeSalud(db: D1Database): Promise<InformeSalud> {
  const ahoraMs = Date.now();
  const hace24h = new Date(ahoraMs - 24 * 3600_000).toISOString();
  const [lat, cont, cola, errorTalleres, colaTalleres, ev, org, bloqueos, errs, errsResumen] = await Promise.all([
    all<{ clave: string; ultimo_at: string; ok: number; detalle: string | null }>(db, 'SELECT clave, ultimo_at, ok, detalle FROM plataforma_latidos'),
    first<{ activados: number; reconciliando: number }>(db, 'SELECT COUNT(*) AS activados, COALESCE(SUM(reconciliar_pendiente), 0) AS reconciliando FROM contab_config'),
    first<{ pendiente: number; fallida: number; mas_antigua: string | null }>(
      db, "SELECT COALESCE(SUM(estado = 'pendiente'), 0) AS pendiente, COALESCE(SUM(estado = 'fallida'), 0) AS fallida, MIN(creada_at) AS mas_antigua FROM contab_cola",
    ),
    all<{ taller_id: string; taller: string; ultimo_error: string; fecha: string | null }>(
      db, 'SELECT c.taller_id, t.nombre AS taller, c.ultimo_error, c.ultimo_error_at AS fecha FROM contab_config c JOIN talleres t ON t.id = c.taller_id WHERE c.ultimo_error IS NOT NULL ORDER BY c.ultimo_error_at DESC LIMIT 20',
    ),
    all<{ taller_id: string; taller: string; pendientes: number; fallidas: number; mas_antigua: string }>(
      db, "SELECT q.taller_id, t.nombre AS taller, SUM(q.estado = 'pendiente') AS pendientes, SUM(q.estado = 'fallida') AS fallidas, MIN(q.creada_at) AS mas_antigua FROM contab_cola q JOIN talleres t ON t.id = q.taller_id GROUP BY q.taller_id ORDER BY MIN(q.creada_at) LIMIT 20",
    ),
    all<{ tipo: string; n: number }>(db, 'SELECT tipo, COUNT(*) AS n FROM eventos_seguridad WHERE creado_at >= ? GROUP BY tipo', hace24h),
    all<{ origen: string; fallos: number }>(db, "SELECT origen, COUNT(*) AS fallos FROM eventos_seguridad WHERE tipo = 'login_fallido' AND creado_at >= ? AND origen IS NOT NULL GROUP BY origen ORDER BY fallos DESC LIMIT 5", hace24h),
    first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM limites_intentos WHERE bloqueado_hasta > ?', ahora()),
    all<{ metodo: string; ruta: string; mensaje: string; veces: number; ultima_at: string }>(db, 'SELECT metodo, ruta, mensaje, veces, ultima_at FROM errores_worker ORDER BY ultima_at DESC LIMIT 10'),
    first<{ problemas: number; veces: number }>(db, 'SELECT COUNT(*) AS problemas, COALESCE(SUM(veces), 0) AS veces FROM errores_worker WHERE ultima_at >= ?', hace24h),
  ]);
  const latDe = (k: string) => lat.find((x) => x.clave === k);
  const parse = (s: string | null | undefined) => {
    try {
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  };
  const mant = latDe('mantenimiento');
  const resp = latDe('respaldo_externo');
  const mantAtrasado = !mant || ahoraMs - Date.parse(mant.ultimo_at) > 20 * MIN;
  const respAtrasado = !resp || ahoraMs - Date.parse(resp.ultimo_at) > 36 * 60 * MIN;
  const ultimas24: Record<string, number> = Object.fromEntries(ev.map((e) => [e.tipo, e.n]));
  const informe: InformeSalud = {
    generado_at: ahora(),
    alertas: [],
    mantenimiento: { ultimo_at: mant?.ultimo_at ?? null, ok: mant ? !!mant.ok : null, atrasado: mantAtrasado, detalle: parse(mant?.detalle) },
    respaldo_externo: { ultimo_at: resp?.ultimo_at ?? null, ok: resp ? !!resp.ok : null, atrasado: respAtrasado, detalle: parse(resp?.detalle) },
    contabilidad: {
      talleres_activados: cont?.activados ?? 0,
      cola_pendiente: cola?.pendiente ?? 0,
      cola_fallida: cola?.fallida ?? 0,
      cola_mas_antigua: cola?.mas_antigua ?? null,
      reconciliando: cont?.reconciliando ?? 0,
      talleres_con_error: errorTalleres,
      talleres_con_cola: colaTalleres,
    },
    seguridad: { ultimas_24h: ultimas24, origenes_con_mas_fallos: org, bloqueos_vigentes: bloqueos?.n ?? 0 },
    errores_worker: { problemas_24h: errsResumen?.problemas ?? 0, ocurrencias_24h: errsResumen?.veces ?? 0, recientes: errs },
  };
  const a = informe.alertas;
  if (mantAtrasado) a.push(mant ? `El mantenimiento periódico no corre desde ${mant.ultimo_at}` : 'El mantenimiento periódico nunca registró actividad (¿Cron Trigger sin desplegar?)');
  if (mant && !mant.ok) a.push('La última ejecución del mantenimiento periódico terminó con errores');
  if (informe.contabilidad.cola_fallida > 0) a.push(`${informe.contabilidad.cola_fallida} operación(es) agotaron los reintentos de contabilización`);
  const viejaCola = informe.contabilidad.cola_mas_antigua;
  if (viejaCola && ahoraMs - Date.parse(viejaCola) > 30 * MIN) a.push(`Hay operaciones esperando contabilización desde ${viejaCola}`);
  if (informe.contabilidad.talleres_con_error.length) a.push(`${informe.contabilidad.talleres_con_error.length} taller(es) con error de contabilización registrado`);
  if (!resp) a.push('Nunca se recibió aviso de un respaldo externo (el procedimiento programado no corrió o no está configurado)');
  else if (!resp.ok) a.push('El último respaldo externo informó un error');
  else if (respAtrasado) a.push(`El último respaldo externo fue el ${resp.ultimo_at} (hace más de 36 h)`);
  const fallosLogin = ultimas24['login_fallido'] ?? 0;
  if (fallosLogin >= 50) a.push(`${fallosLogin} inicios de sesión fallidos en 24 h`);
  if ((ultimas24['login_bloqueo_aplicado'] ?? 0) > 0) a.push(`${ultimas24['login_bloqueo_aplicado']} bloqueo(s) temporal(es) de inicio de sesión en 24 h`);
  if (informe.errores_worker.ocurrencias_24h > 0) a.push(`${informe.errores_worker.ocurrencias_24h} error(es) no controlados del Worker en 24 h`);
  return informe;
}

/** Tarea del Cron Trigger (cada 5 minutos). Devuelve el resumen que también queda en el latido. */
export async function ejecutarMantenimiento(env: Env, mantenimientoContable: (db: D1Database) => Promise<unknown>): Promise<{ ok: boolean; contable: unknown; error?: string }> {
  let ok = true;
  let contable: unknown = null;
  let error: string | undefined;
  try {
    contable = await mantenimientoContable(env.DB);
    if (Math.random() < 0.02) await limpiarObservabilidad(env.DB);
  } catch (e) {
    ok = false;
    error = limpiarMensaje(e instanceof Error ? e.message : String(e));
  }
  const c = contable as { errores?: number } | null;
  if (c?.errores) ok = false;
  await latido(env.DB, 'mantenimiento', ok, { contable, error });
  return { ok, contable, error };
}
