// Contabilización de las operaciones existentes: proceso idempotente, incremental y recuperable.
//
// Cómo se evita duplicar o desbalancear:
//  * cada documento de origen tiene como máximo un asiento por evento (alta / anulacion): índice único de la base;
//  * cada asiento se escribe en un batch atómico (cabecera + líneas + registro) y los triggers de la base rechazan todo lo que no balancea;
//  * un documento que no cierra (importes inconsistentes) NO se contabiliza ni se "ajusta": queda registrado en `contab_omitidos` con su motivo;
//  * la generación histórica es este mismo proceso aplicado a documentos anteriores a la inicialización: se marcan como `historico`,
//    llevan la fecha de la operación original y quedan registrados en `contab_corridas`.
//
// Cómo se evita recorrer el historial (Sprint 13):
//  * COLA PERSISTENTE (`contab_cola`): cada operación comercial deja su pedido dentro de su propia transacción (triggers de la migración 0013). El proceso
//    normal ('cola') lee sólo los pedidos vencidos y consulta únicamente esos documentos: el costo depende de lo nuevo, no de cuántos documentos hay.
//  * Un pedido sale de la cola ÚNICAMENTE cuando su asiento quedó registrado (el DELETE va en el mismo batch atómico que el asiento y exige que el asiento
//    exista) o cuando se comprobó que no tiene efecto contable. Si falla, el pedido y su motivo quedan; se reintenta con espera creciente y, agotados los
//    reintentos, pasa a 'fallida' (visible y recuperable con "Reintentar"). La operación comercial nunca se pierde ni se bloquea por esto.
//  * RECONCILIACIÓN (modo 'reconciliar'): el recorrido completo de siempre, pero por lotes y reanudable (`contab_config.reconciliar_pendiente`). Se usa al
//    activar la contabilidad (lo histórico), cuando se pide una verificación y como red de seguridad semanal del Cron. Es el único camino que lee el historial.
import { all, ahora, first, lotes, type Stmt } from '../db';
import { FUENTES, type Anulacion, type Ctx, type Omision, type Propuesta } from './fuentes';
import { invertir, sentenciasAsiento, type LineaIn } from './asientos';
import { cargarMapa, inicializarPlan, rolFaltante } from './plan';
import { ORIGEN_LABEL, PLAN_INICIAL, type RolCuenta } from '../../../shared/contabilidad';

const POR_FUENTE = 400;
/** Asientos por pasada de reconciliación (cada pedido HTTP o tick del Cron hace una sola pasada: el progreso queda en la base). */
const MAXIMO_RECONCILIACION = 400;
/** Pedidos de la cola que se atienden por pasada. */
const MAXIMO_COLA = 300;
/** Ids que se consultan por fuente y por pasada en modo cola. */
const IDS_POR_FUENTE = 150;
const POR_BATCH = 25;
/** Reintentos automáticos de un pedido de la cola antes de pasar a 'fallida'. */
export const MAX_INTENTOS_COLA = 6;
/** Espera (minutos) antes del reintento número n (1-based). */
const ESPERA_MIN = [1, 5, 15, 60, 240];

export type ModoSync = 'cola' | 'reconciliar';

export interface ResultadoSync {
  corridaId: string;
  modo: ModoSync;
  creados: number;
  historicos: number;
  omitidos: number;
  /** Quedan documentos pendientes (se alcanzó el tope de la pasada): volver a ejecutar. */
  hayMas: boolean;
  porOrigen: Record<string, number>;
  /** Pedidos de la cola atendidos en la pasada (sólo modo cola). */
  pedidos: number;
}

export interface OpcionesSync {
  usuarioId: string | null;
  disparador: 'consulta' | 'manual' | 'inicial' | 'operacion' | 'cron' | 'reconciliacion';
  /** Vuelve a intentar los documentos que fallaron antes. */
  reintentar?: boolean;
  /** 'cola' (por defecto): sólo los pedidos pendientes. 'reconciliar': recorrido completo por lotes. */
  modo?: ModoSync;
}

interface Pedido {
  origen_tipo: string;
  origen_id: string;
  evento: 'alta' | 'anulacion';
  intentos: number;
}
const clavePedido = (tipo: string, id: string, evento: string) => `${tipo}|${id}|${evento}`;

export async function sincronizar(db: D1Database, tallerId: string, op: OpcionesSync): Promise<ResultadoSync> {
  const inicio = ahora();
  const modo: ModoSync = op.modo ?? 'cola';
  if (op.reintentar) {
    await db.batch([
      db.prepare("UPDATE contab_omitidos SET intentos = 0 WHERE taller_id = ? AND tipo = 'error'").bind(tallerId),
      db.prepare("UPDATE contab_cola SET estado = 'pendiente', intentos = 0, proximo_intento_at = NULL, actualizada_at = ? WHERE taller_id = ?").bind(ahora(), tallerId),
    ]);
  }
  const cfg = await first<{ inicializado_at: string }>(db, 'SELECT inicializado_at FROM contab_config WHERE taller_id = ?', tallerId);
  // El plan de cuentas sólo se vuelve a revisar cuando hace falta (una cuenta del sistema nueva o una cuenta bancaria sin cuenta contable): en la pasada
  // de la cola alcanza con una consulta liviana en lugar de reconstruirlo. La reconciliación siempre lo revisa.
  let mapa = await cargarMapa(db, tallerId);
  const rolesCompletos = PLAN_INICIAL.every((b) => !b.rol || mapa.porRol.has(b.rol));
  const bancoSinCuenta =
    modo === 'cola' && rolesCompletos
      ? !!(await first(db, "SELECT 1 FROM cuentas_bancarias cb WHERE cb.taller_id = ? AND cb.moneda = 'ARS' AND NOT EXISTS (SELECT 1 FROM cuentas_contables c WHERE c.taller_id = cb.taller_id AND c.cuenta_bancaria_id = cb.id) LIMIT 1", tallerId))
      : false;
  if (modo === 'reconciliar' || !rolesCompletos || bancoSinCuenta) {
    await inicializarPlan(db, tallerId);
    mapa = await cargarMapa(db, tallerId);
  }
  const base: Ctx = {
    db, tallerId, inicio: cfg?.inicializado_at ?? inicio,
    rol(r: RolCuenta) {
      const id = mapa.porRol.get(r);
      if (!id) throw rolFaltante(r);
      return id;
    },
    banco: (id) => (id ? mapa.porBanco.get(id) ?? null : null),
    esValida: (id) => mapa.validas.has(id),
  };

  // 1) Pedidos de la pasada (modo cola): sólo los vencidos, del más antiguo al más nuevo.
  let pedidos: Pedido[] = [];
  let hayMas = false;
  if (modo === 'cola') {
    pedidos = await all<Pedido>(
      db,
      `SELECT origen_tipo, origen_id, evento, intentos FROM contab_cola
        WHERE taller_id = ? AND estado = 'pendiente' AND (proximo_intento_at IS NULL OR proximo_intento_at <= ?) ORDER BY creada_at LIMIT ?`,
      tallerId, ahora(), MAXIMO_COLA,
    );
    if (pedidos.length >= MAXIMO_COLA) hayMas = true;
  }
  const idsDe = (tipo: string, evento: 'alta' | 'anulacion') => pedidos.filter((p) => p.origen_tipo === tipo && p.evento === evento).map((p) => p.origen_id).slice(0, IDS_POR_FUENTE);
  const ctxAlta = (tipo: string): Ctx | null => {
    if (modo === 'reconciliar') return base;
    const ids = idsDe(tipo, 'alta');
    return ids.length ? { ...base, ids } : null;
  };
  const ctxAnul = (tipo: string): Ctx | null => {
    if (modo === 'reconciliar') return base;
    const ids = idsDe(tipo, 'anulacion');
    return ids.length ? { ...base, ids } : null;
  };

  // 2) Altas pendientes.
  const propuestas: Propuesta[] = [];
  const omisiones: Omision[] = [];
  for (const f of FUENTES) {
    const ctx = ctxAlta(f.tipo);
    if (!ctx) continue;
    let resultados;
    try {
      resultados = await f.pendientes(ctx, POR_FUENTE);
    } catch (e) {
      omisiones.push({ kind: 'omision', origenTipo: f.tipo, origenId: '*', evento: 'alta', tipo: 'error', motivo: `No se pudo leer la fuente: ${(e as Error).message}` });
      continue;
    }
    if (modo === 'reconciliar' && resultados.length >= POR_FUENTE) hayMas = true;
    for (const r of resultados) (r.kind === 'asiento' ? propuestas : omisiones).push(r as never);
  }

  // 3) Anulaciones pendientes: el contra-asiento invierte las líneas del asiento de alta (nuevo en esta pasada o ya existente).
  const altaEnCorrida = new Map(propuestas.map((p) => [`${p.origenTipo}|${p.origenId}`, p]));
  for (const f of FUENTES) {
    if (!f.anulados) continue;
    const ctx = ctxAnul(f.tipo);
    if (!ctx) continue;
    let anuladas: Anulacion[];
    try {
      anuladas = await f.anulados(ctx, POR_FUENTE);
    } catch (e) {
      omisiones.push({ kind: 'omision', origenTipo: f.tipo, origenId: '*', evento: 'anulacion', tipo: 'error', motivo: `No se pudo leer las anulaciones: ${(e as Error).message}` });
      continue;
    }
    if (modo === 'reconciliar' && anuladas.length >= POR_FUENTE) hayMas = true;
    const enDb = await altasExistentes(db, tallerId, f.tipo, anuladas.filter((a) => !altaEnCorrida.has(`${f.tipo}|${a.origenId}`)).map((a) => a.origenId));
    for (const an of anuladas) {
      const nueva = altaEnCorrida.get(`${f.tipo}|${an.origenId}`);
      const alta = nueva
        ? { id: nueva.id, fecha: nueva.fecha, descripcion: nueva.descripcion, lineas: nueva.lineas, createdAt: nueva.orden }
        : enDb.get(an.origenId);
      if (!alta) continue; // el alta todavía no existe (falló o es sin efecto): nada que revertir por ahora
      const fecha = an.fecha && an.fecha > alta.fecha ? an.fecha : alta.fecha;
      propuestas.push({
        kind: 'asiento', id: crypto.randomUUID(), origenTipo: f.tipo, origenId: an.origenId, evento: 'anulacion', fecha, descripcion: `Anulación: ${alta.descripcion}`, usuarioId: an.usuarioId,
        lineas: invertir(alta.lineas), orden: an.orden, revierteId: alta.id, historico: false,
        advertencia: an.fecha ? null : 'No se registró cuándo se anuló la operación: se usó la fecha del asiento original',
      });
    }
  }

  // 4) Orden cronológico (los números de asiento siguen las fechas de las operaciones); el alta siempre antes que su anulación.
  const prioridad = new Map(FUENTES.map((f) => [f.tipo, f.prioridad]));
  propuestas.sort(
    (a, b) =>
      (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0) ||
      (a.evento === b.evento ? 0 : a.evento === 'alta' ? -1 : 1) ||
      (prioridad.get(a.origenTipo) ?? 0) - (prioridad.get(b.origenTipo) ?? 0) ||
      (a.orden < b.orden ? -1 : a.orden > b.orden ? 1 : 0),
  );
  const tope = modo === 'reconciliar' ? MAXIMO_RECONCILIACION : MAXIMO_COLA * 2;
  const aplicar = propuestas.slice(0, tope);
  if (propuestas.length > tope) hayMas = true;

  // 5) Escritura: batches atómicos; si uno falla se reintenta de a un asiento para aislar el documento problemático.
  const fallidos: Omision[] = [];
  for (const grupo of cortar(aplicar, POR_BATCH)) {
    try {
      await db.batch(grupo.flatMap((p) => sentencias(db, tallerId, op.usuarioId, p)));
    } catch {
      for (const p of grupo) {
        try {
          await db.batch(sentencias(db, tallerId, op.usuarioId, p));
        } catch (e) {
          fallidos.push({ kind: 'omision', origenTipo: p.origenTipo, origenId: p.origenId, evento: p.evento, tipo: 'error', motivo: mensajeLegible(e) });
        }
      }
    }
  }
  const todasOmisiones = [...omisiones, ...fallidos];
  await registrarOmisiones(db, tallerId, todasOmisiones);
  if (modo === 'cola') await resolverPedidos(db, tallerId, pedidos.filter((p) => idsDe(p.origen_tipo, p.evento).includes(p.origen_id)), aplicar, todasOmisiones);

  // 6) Resultado y registro de la pasada.
  const ids = aplicar.map((p) => p.id);
  const creados = new Set<string>();
  for (const l of lotes(ids)) {
    for (const r of await all<{ id: string }>(db, `SELECT id FROM asientos WHERE taller_id = ? AND id IN (${l.map(() => '?').join(',')})`, tallerId, ...l)) creados.add(r.id);
  }
  const porOrigen: Record<string, number> = {};
  let historicos = 0;
  for (const p of aplicar) {
    if (!creados.has(p.id)) continue;
    porOrigen[p.origenTipo] = (porOrigen[p.origenTipo] ?? 0) + 1;
    if (p.historico) historicos++;
  }
  const corridaId = crypto.randomUUID();
  const total = creados.size;
  const omitidosN = omisiones.length + fallidos.length;
  // Las pasadas automáticas de la cola que no omiten nada no dejan una fila más (cada asiento ya guarda su origen, fecha y usuario): se registran las
  // reconciliaciones, las pedidas a mano, las que omitieron documentos y la primera.
  const rutinaDeCola = modo === 'cola' && (op.disparador === 'operacion' || op.disparador === 'cron');
  const ultima = rutinaDeCola && omitidosN === 0 ? { n: 1 } : await first<{ n: number }>(db, 'SELECT EXISTS (SELECT 1 FROM contab_corridas WHERE taller_id = ?) AS n', tallerId);
  if ((total > 0 || omitidosN > 0 || !ultima?.n || op.disparador === 'manual' || op.disparador === 'inicial') && !(rutinaDeCola && omitidosN === 0 && !!ultima?.n)) {
    await db
      .prepare(
        `INSERT INTO contab_corridas (id, taller_id, iniciada_at, terminada_at, usuario_id, disparador, asientos_creados, asientos_historicos, omitidos, restantes, detalle)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(corridaId, tallerId, inicio, ahora(), op.usuarioId, !ultima?.n && op.disparador !== 'manual' ? 'inicial' : op.disparador, total, historicos, omitidosN, hayMas ? 1 : 0, JSON.stringify({ modo, por_origen: porOrigen, omitidos: todasOmisiones.slice(0, 20).map((o) => ({ origen: o.origenTipo, id: o.origenId, evento: o.evento, motivo: o.motivo })) }))
      .run();
  }
  return { corridaId, modo, creados: total, historicos, omitidos: omitidosN, hayMas, porOrigen, pedidos: pedidos.length };
}

function sentencias(db: D1Database, tallerId: string, usuarioSync: string | null, p: Propuesta): Stmt[] {
  return [
    ...sentenciasAsiento(db, tallerId, {
      id: p.id, fecha: p.fecha, descripcion: p.descripcion, modo: p.evento === 'anulacion' ? 'reversion' : p.historico ? 'historico' : 'automatico', origenTipo: p.origenTipo, origenId: p.origenId,
      evento: p.evento, revierteId: p.revierteId ?? null, advertencia: p.advertencia ?? null, costoIncompleto: p.costoIncompleto, usuarioId: p.usuarioId ?? usuarioSync, lineas: p.lineas, registrar: true,
    }),
    // El pedido sale de la cola en el MISMO batch que el asiento y sólo si el asiento quedó registrado: nunca "contabilizado" antes de tiempo.
    db
      .prepare(
        `DELETE FROM contab_cola WHERE taller_id = ? AND origen_tipo = ? AND origen_id = ? AND evento = ?
            AND EXISTS (SELECT 1 FROM asientos WHERE taller_id = ? AND origen_tipo = ? AND origen_id = ? AND evento = ? AND estado IN ('registrado', 'revertido'))`,
      )
      .bind(tallerId, p.origenTipo, p.origenId, p.evento, tallerId, p.origenTipo, p.origenId, p.evento),
  ];
}

/**
 * Cierra la contabilidad de cada pedido de la pasada: lo contabilizado ya salió de la cola con su asiento; lo que no tiene efecto contable o no corresponde
 * se saca; lo que falló vuelve a la cola con su motivo y una espera; una anulación cuya alta todavía no existe espera a esa alta.
 */
async function resolverPedidos(db: D1Database, tallerId: string, pedidos: Pedido[], aplicados: Propuesta[], omisiones: Omision[]) {
  if (!pedidos.length) return;
  // Los que siguen en la cola (los demás ya salieron junto con su asiento).
  const restantes: Pedido[] = [];
  for (const l of lotes(pedidos.map((p) => p.origen_id))) {
    const filas = await all<Pedido>(db, `SELECT origen_tipo, origen_id, evento, intentos FROM contab_cola WHERE taller_id = ? AND origen_id IN (${l.map(() => '?').join(',')})`, tallerId, ...l);
    for (const f of filas) if (pedidos.some((p) => clavePedido(p.origen_tipo, p.origen_id, p.evento) === clavePedido(f.origen_tipo, f.origen_id, f.evento))) restantes.push(f);
  }
  if (!restantes.length) return;
  const omitida = new Map(omisiones.map((o) => [clavePedido(o.origenTipo, o.origenId, o.evento), o]));
  const intentadas = new Set(aplicados.map((p) => clavePedido(p.origenTipo, p.origenId, p.evento)));

  // ¿Existe el asiento de alta de cada anulación pendiente? ¿Hay un alta todavía en la cola o con error?
  const anulaciones = restantes.filter((r) => r.evento === 'anulacion');
  const conAlta = new Set<string>();
  const altaEnEspera = new Set<string>();
  for (const l of lotes(anulaciones.map((r) => r.origen_id))) {
    const marcas = l.map(() => '?').join(',');
    for (const a of await all<{ origen_tipo: string; origen_id: string }>(db, `SELECT origen_tipo, origen_id FROM asientos WHERE taller_id = ? AND evento = 'alta' AND estado IN ('registrado', 'revertido') AND origen_id IN (${marcas})`, tallerId, ...l)) conAlta.add(`${a.origen_tipo}|${a.origen_id}`);
    for (const a of await all<{ origen_tipo: string; origen_id: string }>(db, `SELECT origen_tipo, origen_id FROM contab_cola WHERE taller_id = ? AND evento = 'alta' AND origen_id IN (${marcas})`, tallerId, ...l)) altaEnEspera.add(`${a.origen_tipo}|${a.origen_id}`);
    for (const a of await all<{ origen_tipo: string; origen_id: string }>(db, `SELECT origen_tipo, origen_id FROM contab_omitidos WHERE taller_id = ? AND evento = 'alta' AND tipo = 'error' AND origen_id IN (${marcas})`, tallerId, ...l)) altaEnEspera.add(`${a.origen_tipo}|${a.origen_id}`);
  }

  const stmts: Stmt[] = [];
  const ahoraIso = ahora();
  const borrar = (r: Pedido) => db.prepare('DELETE FROM contab_cola WHERE taller_id = ? AND origen_tipo = ? AND origen_id = ? AND evento = ?').bind(tallerId, r.origen_tipo, r.origen_id, r.evento);
  const fallar = (r: Pedido, motivo: string) => {
    const n = r.intentos + 1;
    const espera = ESPERA_MIN[Math.min(n, ESPERA_MIN.length) - 1];
    return db
      .prepare('UPDATE contab_cola SET intentos = ?, ultimo_error = ?, estado = ?, proximo_intento_at = ?, actualizada_at = ? WHERE taller_id = ? AND origen_tipo = ? AND origen_id = ? AND evento = ?')
      .bind(n, motivo.slice(0, 300), n >= MAX_INTENTOS_COLA ? 'fallida' : 'pendiente', new Date(Date.now() + espera * 60_000).toISOString(), ahoraIso, tallerId, r.origen_tipo, r.origen_id, r.evento);
  };
  const esperar = (r: Pedido, minutos: number) =>
    db.prepare('UPDATE contab_cola SET proximo_intento_at = ?, actualizada_at = ? WHERE taller_id = ? AND origen_tipo = ? AND origen_id = ? AND evento = ?').bind(new Date(Date.now() + minutos * 60_000).toISOString(), ahoraIso, tallerId, r.origen_tipo, r.origen_id, r.evento);

  for (const r of restantes) {
    const k = clavePedido(r.origen_tipo, r.origen_id, r.evento);
    // Una fuente que no se pudo leer (origen '*') deja en espera a TODOS sus pedidos: nunca se descartan por un fallo de lectura.
    const o = omitida.get(k) ?? omitida.get(clavePedido(r.origen_tipo, '*', r.evento));
    if (o?.tipo === 'sin_efecto') stmts.push(borrar(r));
    else if (o?.tipo === 'error') stmts.push(fallar(r, o.motivo));
    else if (intentadas.has(k)) stmts.push(fallar(r, 'El asiento no quedó registrado'));
    else if (r.evento === 'anulacion' && !conAlta.has(`${r.origen_tipo}|${r.origen_id}`)) {
      // Nada que revertir todavía: si el alta está esperando (cola o error) la anulación espera a que se contabilice; si no hay alta, no hay nada que anular.
      stmts.push(altaEnEspera.has(`${r.origen_tipo}|${r.origen_id}`) ? esperar(r, 1) : borrar(r));
    } else stmts.push(borrar(r)); // no corresponde contabilizarlo (no cumple la condición de la fuente o ya no existe)
  }
  for (const g of cortar(stmts, 50)) await db.batch(g);
}

async function altasExistentes(db: D1Database, tallerId: string, tipo: string, ids: string[]): Promise<Map<string, { id: string; fecha: string; descripcion: string; lineas: LineaIn[]; createdAt: string }>> {
  const res = new Map<string, { id: string; fecha: string; descripcion: string; lineas: LineaIn[]; createdAt: string }>();
  for (const l of lotes(ids)) {
    const altas = await all<{ id: string; origen_id: string; fecha: string; descripcion: string; created_at: string }>(
      db,
      `SELECT id, origen_id, fecha, descripcion, created_at FROM asientos WHERE taller_id = ? AND origen_tipo = ? AND evento = 'alta' AND estado = 'registrado' AND origen_id IN (${l.map(() => '?').join(',')})`,
      tallerId, tipo, ...l,
    );
    for (const lote of lotes(altas.map((a) => a.id))) {
      const lineas = await all<{ asiento_id: string; cuenta_id: string; debe: number; haber: number; detalle: string | null }>(
        db, `SELECT asiento_id, cuenta_id, debe, haber, detalle FROM asiento_lineas WHERE taller_id = ? AND asiento_id IN (${lote.map(() => '?').join(',')}) ORDER BY orden`, tallerId, ...lote,
      );
      for (const a of altas.filter((x) => lote.includes(x.id))) {
        res.set(a.origen_id, { id: a.id, fecha: a.fecha, descripcion: a.descripcion, createdAt: a.created_at, lineas: lineas.filter((x) => x.asiento_id === a.id).map((x) => ({ cuentaId: x.cuenta_id, debe: x.debe, haber: x.haber, detalle: x.detalle })) });
      }
    }
  }
  return res;
}

async function registrarOmisiones(db: D1Database, tallerId: string, omisiones: Omision[]) {
  const stmts = omisiones
    .filter((o) => o.origenId !== '*')
    .map((o) =>
      db
        .prepare(
          `INSERT INTO contab_omitidos (taller_id, origen_tipo, origen_id, evento, tipo, motivo) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (taller_id, origen_tipo, origen_id, evento) DO UPDATE SET motivo = excluded.motivo, tipo = excluded.tipo, intentos = intentos + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        )
        .bind(tallerId, o.origenTipo, o.origenId, o.evento, o.tipo, o.motivo.slice(0, 300)),
    );
  for (const g of cortar(stmts, 50)) await db.batch(g);
}

function cortar<T>(xs: T[], n: number): T[][] {
  const r: T[][] = [];
  for (let i = 0; i < xs.length; i += n) r.push(xs.slice(i, i + n));
  return r;
}

function mensajeLegible(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (m.includes('desbalanceado')) return 'El asiento no balancea';
  if (m.includes('no es imputable')) return 'Usa una cuenta inactiva o no imputable';
  return m.slice(0, 200);
}

/** Texto de un origen para mostrar. */
export const etiquetaOrigen = (t: string) => ORIGEN_LABEL[t] ?? t;

// ───────────────────────── Ejecución coordinada ─────────────────────────
// La sincronización NUNCA corre al consultar. Se ejecuta (a) al activar la contabilidad, (b) a pedido de quien la gestiona, (c) después de cada operación
// comercial que la cambia (ver `sincronizarTrasOperacion`) y (d) desde el Cron Trigger, que recupera lo que haya quedado en la cola. Para que dos procesos
// del mismo taller no se pisen se usa un bloqueo con vencimiento en `contab_config`: si llega una operación mientras otro proceso corre, deja un pedido
// (`sync_solicitada`) y el que corre vuelve a pasar.
const BLOQUEO_MS = 90_000;
const PASADAS_COLA_MAX = 4;

export type ResultadoControlado =
  | { estado: 'no_activada' }
  | { estado: 'ocupada' }
  | { estado: 'ejecutada'; resultado: ResultadoSync; pasadas: number; /** Falta reconciliar historial: volver a llamar. */ reconciliacionPendiente: boolean };

/** Intenta quedarse con el turno de sincronización (una sola consulta cuando está libre). */
async function tomarTurno(db: D1Database, tallerId: string): Promise<'tomado' | 'ocupado' | 'no_activada'> {
  const r = await db
    .prepare('UPDATE contab_config SET sync_bloqueo_hasta = ?, sync_solicitada = 0 WHERE taller_id = ? AND (sync_bloqueo_hasta IS NULL OR sync_bloqueo_hasta < ?)')
    .bind(new Date(Date.now() + BLOQUEO_MS).toISOString(), tallerId, ahora())
    .run();
  if ((r.meta?.changes ?? 0) > 0) return 'tomado';
  // Sin cambios: o no está activada o hay otro proceso con el turno (en ese caso se deja el pedido de repetir).
  if (!(await first(db, 'SELECT 1 FROM contab_config WHERE taller_id = ?', tallerId))) return 'no_activada';
  await db.prepare('UPDATE contab_config SET sync_solicitada = 1 WHERE taller_id = ?').bind(tallerId).run();
  return 'ocupado';
}

/** Suelta el turno, deja constancia del error (si hubo) y de la última pasada, y devuelve si llegó un pedido de repetir mientras corría. */
async function soltarTurno(db: D1Database, tallerId: string, error: string | null, huboPasada: boolean): Promise<boolean> {
  const r = await first<{ s: number }>(
    db,
    `UPDATE contab_config SET sync_bloqueo_hasta = NULL, ultimo_error = ?, ultimo_error_at = CASE WHEN ? IS NULL THEN ultimo_error_at ELSE ? END,
            ultima_corrida_at = CASE WHEN ? THEN ? ELSE ultima_corrida_at END
      WHERE taller_id = ? RETURNING sync_solicitada AS s`,
    error, error, ahora(), huboPasada ? 1 : 0, ahora(), tallerId,
  );
  return !!r?.s;
}

/**
 * Sincroniza un taller cuya contabilidad ya fue activada, de a una sola ejecución a la vez.
 *  * modo 'cola' (por defecto): repite mientras queden pedidos vencidos (tope por pasada) o haya llegado un pedido nuevo.
 *  * modo 'reconciliar': UNA pasada de recorrido completo (tope de asientos); al terminar sin más documentos apaga `reconciliar_pendiente` y drena la cola.
 * Devuelve `ocupada` si otro proceso tiene el turno (en ese caso deja el pedido para que lo retome).
 */
export async function sincronizarControlado(db: D1Database, tallerId: string, op: OpcionesSync): Promise<ResultadoControlado> {
  const turno = await tomarTurno(db, tallerId);
  if (turno === 'no_activada') return { estado: 'no_activada' };
  if (turno === 'ocupado') return { estado: 'ocupada' };
  let acumulado: ResultadoSync | null = null;
  let pasadas = 0;
  let error: string | null = null;
  let reconciliacionPendiente = false;
  let repetirPedido = false;
  try {
    if ((op.modo ?? 'cola') === 'reconciliar') {
      const r = await sincronizar(db, tallerId, { ...op, modo: 'reconciliar' });
      pasadas++;
      acumulado = r;
      if (!r.hayMas) {
        await db.prepare('UPDATE contab_config SET reconciliar_pendiente = 0, reconciliada_at = ? WHERE taller_id = ?').bind(ahora(), tallerId).run();
        // Lo que se encoló mientras se reconciliaba (operaciones nuevas) se atiende ahora.
        const c = await sincronizar(db, tallerId, { ...op, modo: 'cola', disparador: op.disparador === 'inicial' ? 'operacion' : op.disparador, reintentar: false });
        pasadas++;
        acumulado = { ...r, creados: r.creados + c.creados, historicos: r.historicos + c.historicos, omitidos: r.omitidos + c.omitidos, hayMas: c.hayMas, porOrigen: sumar(r.porOrigen, c.porOrigen), pedidos: c.pedidos };
      } else {
        await db.prepare('UPDATE contab_config SET reconciliar_pendiente = 1 WHERE taller_id = ?').bind(tallerId).run();
      }
      reconciliacionPendiente = r.hayMas;
    } else {
      let repetir = true;
      while (repetir && pasadas < PASADAS_COLA_MAX) {
        const r = await sincronizar(db, tallerId, { ...op, modo: 'cola', reintentar: op.reintentar && pasadas === 0 });
        pasadas++;
        acumulado = acumulado
          ? { corridaId: r.corridaId, modo: 'cola', creados: acumulado.creados + r.creados, historicos: acumulado.historicos + r.historicos, omitidos: r.omitidos, hayMas: r.hayMas, porOrigen: sumar(acumulado.porOrigen, r.porOrigen), pedidos: acumulado.pedidos + r.pedidos }
          : r;
        // Sólo se vuelve a pasar si la cola quedó con trabajo VENCIDO (tope de la pasada) o si otro proceso pidió repetir mientras corría.
        const est = await first<{ s: number; r: number }>(db, 'SELECT sync_solicitada AS s, reconciliar_pendiente AS r FROM contab_config WHERE taller_id = ?', tallerId);
        if (est?.s) await db.prepare('UPDATE contab_config SET sync_solicitada = 0 WHERE taller_id = ?').bind(tallerId).run();
        reconciliacionPendiente = !!est?.r;
        repetir = r.hayMas || !!est?.s;
      }
    }
  } catch (e) {
    error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  } finally {
    repetirPedido = await soltarTurno(db, tallerId, error, pasadas > 0 && !error);
  }
  if (error) throw new Error(error);
  // Un pedido que entró justo antes de soltar el turno: se retoma una vez más.
  if (repetirPedido && (await tomarTurno(db, tallerId)) === 'tomado') {
    let err2: string | null = null;
    let hubo = false;
    try {
      await sincronizar(db, tallerId, { ...op, modo: 'cola', reintentar: false });
      hubo = true;
    } catch (e) {
      err2 = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    } finally {
      await soltarTurno(db, tallerId, err2, hubo);
    }
  }
  return { estado: 'ejecutada', resultado: acumulado!, pasadas, reconciliacionPendiente };
}

function sumar(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const r = { ...a };
  for (const [k, v] of Object.entries(b)) r[k] = (r[k] ?? 0) + v;
  return r;
}

/**
 * Mantiene al día la contabilidad después de una operación comercial. No hace nada si el taller no activó la contabilidad. Nunca propaga errores:
 * la operación ya está hecha y su pedido ya está en la cola (se encoló en la misma transacción); si esta pasada falla o se pierde, el motivo queda en
 * `ultimo_error`/`contab_cola` y se reintenta en la próxima operación, en el próximo tick del Cron o a pedido.
 */
export async function sincronizarTrasOperacion(db: D1Database, tallerId: string, usuarioId: string | null): Promise<void> {
  try {
    await sincronizarControlado(db, tallerId, { usuarioId, disparador: 'operacion' });
  } catch {
    /* ya quedó en contab_config.ultimo_error y el pedido sigue en la cola */
  }
}

// ───────────────────────── Mantenimiento periódico (Cron Trigger) ─────────────────────────
export interface ResultadoMantenimiento {
  talleresCola: number;
  talleresReconciliacion: number;
  creados: number;
  errores: number;
  marcadosParaVerificar: number;
}

const RECONCILIACION_CADA_DIAS = 7;

/**
 * Tarea periódica: (1) drena las colas con pedidos vencidos de cualquier taller (recupera lo que se perdió al terminar un Worker o falló antes),
 * (2) avanza una pasada de las reconciliaciones pendientes y (3) agenda la verificación semanal de cada taller (escalonada).
 * El presupuesto acota el trabajo de un tick: lo que no entra se atiende en el siguiente.
 */
export async function mantenimientoContable(db: D1Database, presupuesto = { colas: 6, reconciliaciones: 2, verificaciones: 3 }): Promise<ResultadoMantenimiento> {
  const r: ResultadoMantenimiento = { talleresCola: 0, talleresReconciliacion: 0, creados: 0, errores: 0, marcadosParaVerificar: 0 };
  const colas = await all<{ taller_id: string }>(
    db,
    "SELECT taller_id FROM contab_cola WHERE estado = 'pendiente' AND (proximo_intento_at IS NULL OR proximo_intento_at <= ?) GROUP BY taller_id ORDER BY MIN(creada_at) LIMIT ?",
    ahora(), presupuesto.colas,
  );
  for (const t of colas) {
    try {
      const x = await sincronizarControlado(db, t.taller_id, { usuarioId: null, disparador: 'cron' });
      if (x.estado === 'ejecutada') {
        r.talleresCola++;
        r.creados += x.resultado.creados;
      }
    } catch {
      r.errores++;
    }
  }
  const recs = await all<{ taller_id: string }>(db, 'SELECT taller_id FROM contab_config WHERE reconciliar_pendiente = 1 LIMIT ?', presupuesto.reconciliaciones);
  for (const t of recs) {
    try {
      const x = await sincronizarControlado(db, t.taller_id, { usuarioId: null, disparador: 'reconciliacion', modo: 'reconciliar' });
      if (x.estado === 'ejecutada') {
        r.talleresReconciliacion++;
        r.creados += x.resultado.creados;
      }
    } catch {
      r.errores++;
    }
  }
  const vencidas = new Date(Date.now() - RECONCILIACION_CADA_DIAS * 86400_000).toISOString();
  const m = await db
    .prepare(
      `UPDATE contab_config SET reconciliar_pendiente = 1
        WHERE taller_id IN (SELECT taller_id FROM contab_config WHERE reconciliar_pendiente = 0 AND (reconciliada_at IS NULL OR reconciliada_at < ?) ORDER BY COALESCE(reconciliada_at, '') LIMIT ?)`,
    )
    .bind(vencidas, presupuesto.verificaciones)
    .run();
  r.marcadosParaVerificar = m.meta?.changes ?? 0;
  return r;
}
