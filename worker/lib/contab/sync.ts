// Contabilización de las operaciones existentes: proceso idempotente y trazable.
//
// Cómo se evita duplicar o desbalancear:
//  * cada documento de origen tiene como máximo un asiento por evento (alta / anulacion): índice único de la base;
//  * cada asiento se escribe en un batch atómico (cabecera + líneas + registro) y los triggers de la base rechazan todo lo que no balancea;
//  * un documento que no cierra (importes inconsistentes) NO se contabiliza ni se "ajusta": queda registrado en `contab_omitidos` con su motivo;
//  * la generación histórica es este mismo proceso aplicado a documentos anteriores a la inicialización: se marcan como `historico`,
//    llevan la fecha de la operación original y quedan registrados en `contab_corridas`.
import { all, ahora, first, lotes, type Stmt } from '../db';
import { FUENTES, type Anulacion, type Ctx, type Omision, type Propuesta } from './fuentes';
import { invertir, sentenciasAsiento, type LineaIn } from './asientos';
import { cargarMapa, inicializarPlan, rolFaltante } from './plan';
import { ORIGEN_LABEL, type RolCuenta } from '../../../shared/contabilidad';

const POR_FUENTE = 400;
const MAXIMO_POR_CORRIDA = 600;
const POR_BATCH = 25;

export interface ResultadoSync {
  corridaId: string;
  creados: number;
  historicos: number;
  omitidos: number;
  /** Quedan documentos pendientes (se alcanzó el tope de la corrida): volver a ejecutar. */
  hayMas: boolean;
  porOrigen: Record<string, number>;
}

export interface OpcionesSync {
  usuarioId: string | null;
  disparador: 'consulta' | 'manual' | 'inicial';
  /** Vuelve a intentar los documentos que fallaron antes. */
  reintentar?: boolean;
}

export async function sincronizar(db: D1Database, tallerId: string, op: OpcionesSync): Promise<ResultadoSync> {
  const inicio = ahora();
  await inicializarPlan(db, tallerId);
  if (op.reintentar) await db.prepare("UPDATE contab_omitidos SET intentos = 0 WHERE taller_id = ? AND tipo = 'error'").bind(tallerId).run();
  const cfg = await first<{ inicializado_at: string }>(db, 'SELECT inicializado_at FROM contab_config WHERE taller_id = ?', tallerId);
  const mapa = await cargarMapa(db, tallerId);
  const ctx: Ctx = {
    db, tallerId, inicio: cfg?.inicializado_at ?? inicio,
    rol(r: RolCuenta) {
      const id = mapa.porRol.get(r);
      if (!id) throw rolFaltante(r);
      return id;
    },
    banco: (id) => (id ? mapa.porBanco.get(id) ?? null : null),
    esValida: (id) => mapa.validas.has(id),
  };

  // 1) Altas pendientes de todas las fuentes.
  const propuestas: Propuesta[] = [];
  const omisiones: Omision[] = [];
  let hayMas = false;
  for (const f of FUENTES) {
    let resultados;
    try {
      resultados = await f.pendientes(ctx, POR_FUENTE);
    } catch (e) {
      omisiones.push({ kind: 'omision', origenTipo: f.tipo, origenId: '*', evento: 'alta', tipo: 'error', motivo: `No se pudo leer la fuente: ${(e as Error).message}` });
      continue;
    }
    if (resultados.length >= POR_FUENTE) hayMas = true;
    for (const r of resultados) (r.kind === 'asiento' ? propuestas : omisiones).push(r as never);
  }

  // 2) Anulaciones pendientes: el contra-asiento invierte las líneas del asiento de alta (nuevo en esta corrida o ya existente).
  const altaEnCorrida = new Map(propuestas.map((p) => [`${p.origenTipo}|${p.origenId}`, p]));
  for (const f of FUENTES) {
    if (!f.anulados) continue;
    let anuladas: Anulacion[];
    try {
      anuladas = await f.anulados(ctx, POR_FUENTE);
    } catch (e) {
      omisiones.push({ kind: 'omision', origenTipo: f.tipo, origenId: '*', evento: 'anulacion', tipo: 'error', motivo: `No se pudo leer las anulaciones: ${(e as Error).message}` });
      continue;
    }
    if (anuladas.length >= POR_FUENTE) hayMas = true;
    const enDb = await altasExistentes(db, tallerId, f.tipo, anuladas.filter((a) => !altaEnCorrida.has(`${f.tipo}|${a.origenId}`)).map((a) => a.origenId));
    for (const an of anuladas) {
      const nueva = altaEnCorrida.get(`${f.tipo}|${an.origenId}`);
      const alta = nueva
        ? { id: nueva.id, fecha: nueva.fecha, descripcion: nueva.descripcion, lineas: nueva.lineas, createdAt: nueva.orden }
        : enDb.get(an.origenId);
      if (!alta) continue; // el alta todavía no existe (falló o es sin efecto): nada que revertir
      const fecha = an.fecha && an.fecha > alta.fecha ? an.fecha : alta.fecha;
      propuestas.push({
        kind: 'asiento', id: crypto.randomUUID(), origenTipo: f.tipo, origenId: an.origenId, evento: 'anulacion', fecha, descripcion: `Anulación: ${alta.descripcion}`, usuarioId: an.usuarioId,
        lineas: invertir(alta.lineas), orden: an.orden, revierteId: alta.id, historico: false,
        advertencia: an.fecha ? null : 'No se registró cuándo se anuló la operación: se usó la fecha del asiento original',
      });
    }
  }

  // 3) Orden cronológico (los números de asiento siguen las fechas de las operaciones); el alta siempre antes que su anulación.
  const prioridad = new Map(FUENTES.map((f) => [f.tipo, f.prioridad]));
  propuestas.sort(
    (a, b) =>
      (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0) ||
      (a.evento === b.evento ? 0 : a.evento === 'alta' ? -1 : 1) ||
      (prioridad.get(a.origenTipo) ?? 0) - (prioridad.get(b.origenTipo) ?? 0) ||
      (a.orden < b.orden ? -1 : a.orden > b.orden ? 1 : 0),
  );
  const aplicar = propuestas.slice(0, MAXIMO_POR_CORRIDA);
  if (propuestas.length > MAXIMO_POR_CORRIDA) hayMas = true;

  // 4) Escritura: batches atómicos; si uno falla se reintenta de a un asiento para aislar el documento problemático.
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
  await registrarOmisiones(db, tallerId, [...omisiones, ...fallidos]);

  // 5) Resultado y registro de la corrida.
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
  const ultima = await first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM contab_corridas WHERE taller_id = ?', tallerId);
  // Las consultas que no cambian nada no dejan huella: sólo se registran las corridas que crearon asientos u omitieron documentos (y la primera).
  if (total > 0 || omitidosN > 0 || !ultima?.n || op.disparador !== 'consulta') {
    await db
      .prepare(
        `INSERT INTO contab_corridas (id, taller_id, iniciada_at, terminada_at, usuario_id, disparador, asientos_creados, asientos_historicos, omitidos, restantes, detalle)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(corridaId, tallerId, inicio, ahora(), op.usuarioId, !ultima?.n && op.disparador === 'consulta' ? 'inicial' : op.disparador, total, historicos, omitidosN, hayMas ? 1 : 0, JSON.stringify({ por_origen: porOrigen, omitidos: [...omisiones, ...fallidos].slice(0, 20).map((o) => ({ origen: o.origenTipo, id: o.origenId, evento: o.evento, motivo: o.motivo })) }))
      .run();
  }
  await db.prepare('UPDATE contab_config SET ultima_corrida_at = ? WHERE taller_id = ?').bind(ahora(), tallerId).run();
  return { corridaId, creados: total, historicos, omitidos: omitidosN, hayMas, porOrigen };
}

function sentencias(db: D1Database, tallerId: string, usuarioSync: string | null, p: Propuesta): Stmt[] {
  return sentenciasAsiento(db, tallerId, {
    id: p.id, fecha: p.fecha, descripcion: p.descripcion, modo: p.evento === 'anulacion' ? 'reversion' : p.historico ? 'historico' : 'automatico', origenTipo: p.origenTipo, origenId: p.origenId,
    evento: p.evento, revierteId: p.revierteId ?? null, advertencia: p.advertencia ?? null, costoIncompleto: p.costoIncompleto, usuarioId: p.usuarioId ?? usuarioSync, lineas: p.lineas, registrar: true,
  });
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
