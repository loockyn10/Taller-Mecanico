// Contabilidad de gestión: plan de cuentas, asientos de partida doble (manuales y automáticos), libro diario y mayor, balance de sumas y saldos,
// estado de resultados y controles de consistencia. Información contable y administrativa INTERNA: no son libros fiscales ni tienen validez ante ARCA.
//
// Los asientos automáticos se generan a partir de las operaciones existentes con un proceso idempotente (lib/contab/sync.ts). Ese proceso NO corre al
// consultar: se activa de forma explícita (POST /activar, que también genera lo histórico), se mantiene al día después de cada operación comercial
// (index.ts) y puede pedirse a mano (POST /sincronizar). Los GET sólo leen. Nada de acá modifica ventas, cobros, compras ni movimientos de caja o banco.
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, conflict, notFound, query, zFecha, zId, zTextoOpt } from '../lib/http';
import { all, auditar, first, guard, hoy, uid, type Stmt } from '../lib/db';
import { requirePerm, tiene } from '../lib/auth';
import { autorizarExportacion } from '../lib/exportar';
import { codigoCuentaValido, naturalezaDe, rolDeGasto, TIPOS_CUENTA, validarLineas } from '../../shared/contabilidad';
import { inicializarPlan } from '../lib/contab/plan';
import { sincronizarControlado } from '../lib/contab/sync';
import { estadoContabilidad } from '../lib/contab/estado';
import { invertir, sentenciaRegistrar, sentenciasAsiento, sentenciasLineas, type LineaIn } from '../lib/contab/asientos';
import { balanceSumasYSaldos, estadoResultados, flujoDeCaja, libroDiario, libroMayor, pendientesContabilizar, planConSaldos } from '../lib/contab/informes';
import { controles } from '../lib/contab/controles';

export const contabilidad = new Hono<AppEnv>();
const ver = requirePerm('contabilidad.ver');
const gestionar = requirePerm('contabilidad.gestionar');

/** Las consultas y las altas de cuentas o asientos exigen que la contabilidad se haya activado: nada de lo que lee se genera "de paso". */
async function exigirActivada(c: Context<AppEnv>) {
  const s = c.get('sesion');
  if (!(await first(c.env.DB, 'SELECT 1 FROM contab_config WHERE taller_id = ?', s.tallerId))) {
    throw conflict('La contabilidad todavía no está activada en este taller. Activala desde Contabilidad › Resumen.', 'contabilidad_no_activada');
  }
}

/** Traduce los mensajes de los triggers contables a errores claros para quien usa la API. */
function errorContable(e: unknown): never {
  const m = e instanceof Error ? e.message : String(e);
  if (m.includes('desbalanceado')) throw badRequest('El asiento no balancea: el Debe y el Haber deben ser iguales');
  if (m.includes('al menos dos líneas')) throw badRequest('El asiento necesita al menos dos líneas');
  if (m.includes('no tiene importes')) throw badRequest('El asiento no tiene importes');
  if (m.includes('no es imputable')) throw badRequest('Una de las cuentas es un rubro (no recibe asientos) o está inactiva');
  if (m.includes('no existe el contra-asiento')) throw conflict('El asiento ya fue revertido');
  if (m.includes('registrado')) throw conflict('Un asiento registrado no se modifica ni se elimina: se corrige con un contra-asiento');
  if (m.includes('sistema') || m.includes('movimientos')) throw conflict(m.replace(/^.*?:\s*/, '').slice(0, 200));
  throw e;
}

const zPeriodo = z.object({ desde: zFecha, hasta: zFecha });
function periodo(c: Context<AppEnv>) {
  const p = query(c, zPeriodo);
  if (p.desde > p.hasta) throw badRequest('El período es inválido: la fecha desde es posterior a la fecha hasta');
  return p;
}

// ═════════════════════════ Estado y proceso de contabilización ═════════════════════════
/** Estado de la contabilidad (SOLO LECTURA): si está activada, si está al día y qué falta contabilizar. */
contabilidad.get('/estado', ver, async (c) => c.json(await estadoContabilidad(c.env.DB, c.get('sesion').tallerId)));

/**
 * Activa la contabilidad del taller: crea el plan de cuentas y contabiliza, una sola vez y de forma idempotente, lo ya operado (los asientos
 * quedan marcados como históricos y con la fecha original de cada operación). Vuelve a llamarse hasta que `hay_mas` sea falso si son muchas.
 */
contabilidad.post('/activar', ver, gestionar, async (c) => {
  const s = c.get('sesion');
  await body(c, z.object({}).passthrough());
  await inicializarPlan(c.env.DB, s.tallerId);
  const nueva = (await c.env.DB.prepare('UPDATE contab_config SET activada_por = ? WHERE taller_id = ? AND activada_por IS NULL').bind(s.usuarioId, s.tallerId).run()).meta?.changes ?? 0;
  const r = await sincronizarControlado(c.env.DB, s.tallerId, { usuarioId: s.usuarioId, disparador: 'inicial' });
  if (r.estado === 'ocupada') throw conflict('Ya hay una actualización contable en curso. Esperá unos segundos y volvé a consultar el estado.', 'sincronizacion_en_curso');
  if (nueva) await auditar(c.env.DB, s.tallerId, s.usuarioId, 'contabilidad', null, 'activar', r.estado === 'ejecutada' ? { creados: r.resultado.creados, historicos: r.resultado.historicos, omitidos: r.resultado.omitidos } : undefined).run();
  return c.json({ activada: true, ya_estaba_activada: nueva === 0, ...(r.estado === 'ejecutada' ? r.resultado : {}) });
});

/** Contabiliza lo pendiente a pedido (por ejemplo después de corregir una operación que tenía error). Idempotente. */
contabilidad.post('/sincronizar', ver, gestionar, async (c) => {
  const s = c.get('sesion');
  const d = await body(c, z.object({ reintentar: z.boolean().default(false) }));
  await exigirActivada(c);
  const r = await sincronizarControlado(c.env.DB, s.tallerId, { usuarioId: s.usuarioId, disparador: 'manual', reintentar: d.reintentar });
  if (r.estado === 'ocupada') throw conflict('Ya hay una actualización contable en curso. Esperá unos segundos y volvé a consultar el estado.', 'sincronizacion_en_curso');
  if (r.estado === 'no_activada') throw conflict('La contabilidad todavía no está activada en este taller.', 'contabilidad_no_activada');
  await auditar(c.env.DB, s.tallerId, s.usuarioId, 'contabilidad', null, 'sincronizar', { creados: r.resultado.creados, omitidos: r.resultado.omitidos }).run();
  return c.json(r.resultado);
});

contabilidad.get('/corridas', ver, async (c) => {
  const s = c.get('sesion');
  return c.json(
    await all(
      c.env.DB,
      `SELECT co.id, co.iniciada_at, co.terminada_at, co.disparador, co.asientos_creados, co.asientos_historicos, co.omitidos, co.restantes, co.detalle, u.nombre AS usuario
         FROM contab_corridas co LEFT JOIN usuarios u ON u.taller_id = co.taller_id AND u.id = co.usuario_id WHERE co.taller_id = ? ORDER BY co.iniciada_at DESC LIMIT 30`,
      s.tallerId,
    ),
  );
});

contabilidad.get('/omitidos', ver, async (c) => {
  const s = c.get('sesion');
  return c.json(await all(c.env.DB, "SELECT origen_tipo, origen_id, evento, tipo, motivo, intentos, updated_at FROM contab_omitidos WHERE taller_id = ? AND tipo = 'error' ORDER BY updated_at DESC LIMIT 200", s.tallerId));
});

// ═════════════════════════ Plan de cuentas ═════════════════════════
contabilidad.get('/plan', ver, async (c) => {
  const s = c.get('sesion');
  await exigirActivada(c);
  const { hasta } = query(c, z.object({ hasta: zFecha.optional() }));
  return c.json(await planConSaldos(c.env.DB, s.tallerId, hasta));
});

const zCuenta = z.object({
  codigo: z.string().trim().min(1).max(24).refine(codigoCuentaValido, 'el código debe tener números separados por puntos (por ejemplo 1.1.07)'),
  nombre: z.string().trim().min(2).max(120),
  tipo: z.enum(TIPOS_CUENTA as unknown as [string, ...string[]]),
  padre_id: zId.nullish(),
  imputable: z.boolean().default(true),
  /** Cuenta regularizadora (saldo contrario al de su tipo). */
  contra: z.boolean().default(false),
  notas: zTextoOpt(300),
});

async function validarPadre(db: D1Database, tallerId: string, padreId: string | null | undefined, tipo: string, propio?: string) {
  if (!padreId) return;
  if (propio && padreId === propio) throw badRequest('Una cuenta no puede ser su propio rubro');
  const p = await first<{ tipo: string; imputable: number; movimientos: number }>(
    db,
    `SELECT c.tipo, c.imputable, (SELECT COUNT(*) FROM asiento_lineas l WHERE l.taller_id = c.taller_id AND l.cuenta_id = c.id) AS movimientos FROM cuentas_contables c WHERE c.taller_id = ? AND c.id = ?`,
    tallerId, padreId,
  );
  if (!p) throw badRequest('El rubro indicado no existe');
  if (p.tipo !== tipo) throw badRequest('La cuenta debe ser del mismo tipo que su rubro');
  if (p.imputable || p.movimientos) throw conflict('Una cuenta imputable o con movimientos no puede agrupar a otras. Elegí un rubro.');
  if (propio) {
    // Evita ciclos: el rubro no puede colgar de la propia cuenta.
    let cur: string | null = padreId;
    for (let i = 0; i < 20 && cur; i++) {
      const r: { padre_id: string | null } | null = await first(db, 'SELECT padre_id FROM cuentas_contables WHERE taller_id = ? AND id = ?', tallerId, cur);
      if (r?.padre_id === propio) throw badRequest('El rubro elegido depende de esta cuenta');
      cur = r?.padre_id ?? null;
    }
  }
}

contabilidad.post('/cuentas', ver, gestionar, async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zCuenta);
  await exigirActivada(c);
  await validarPadre(c.env.DB, s.tallerId, d.padre_id, d.tipo);
  const nat = naturalezaDe(d.tipo as never);
  const naturaleza = d.contra ? (nat === 'deudora' ? 'acreedora' : 'deudora') : nat;
  const id = uid();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO cuentas_contables (id, taller_id, codigo, nombre, tipo, naturaleza, padre_id, imputable, notas) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, s.tallerId, d.codigo, d.nombre, d.tipo, naturaleza, d.padre_id ?? null, d.imputable ? 1 : 0, d.notas),
      auditar(c.env.DB, s.tallerId, s.usuarioId, 'cuenta_contable', id, 'crear', { codigo: d.codigo, nombre: d.nombre }),
    ]);
  } catch (e) {
    if (String(e).includes('UNIQUE') && String(e).includes('codigo')) throw conflict('Ya existe una cuenta con ese código', 'duplicado');
    throw e;
  }
  return c.json(await first(c.env.DB, 'SELECT * FROM cuentas_contables WHERE taller_id = ? AND id = ?', s.tallerId, id), 201);
});

contabilidad.put('/cuentas/:id', ver, gestionar, async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, zCuenta.partial().omit({ tipo: true, contra: true }).extend({ activa: z.boolean().optional() }));
  const cta = await first<{ tipo: string; rol: string | null; cuenta_bancaria_id: string | null; imputable: number; movimientos: number; hijos: number }>(
    c.env.DB,
    `SELECT c.tipo, c.rol, c.cuenta_bancaria_id, c.imputable,
            (SELECT COUNT(*) FROM asiento_lineas l WHERE l.taller_id = c.taller_id AND l.cuenta_id = c.id) AS movimientos,
            (SELECT COUNT(*) FROM cuentas_contables h WHERE h.taller_id = c.taller_id AND h.padre_id = c.id) AS hijos
       FROM cuentas_contables c WHERE c.taller_id = ? AND c.id = ?`,
    s.tallerId, id,
  );
  if (!cta) throw notFound('Cuenta');
  const sistema = !!(cta.rol || cta.cuenta_bancaria_id);
  if (d.activa === false && sistema) throw conflict('Es una cuenta del sistema: no se puede desactivar');
  if (d.imputable !== undefined && d.imputable !== !!cta.imputable) {
    if (sistema || cta.movimientos) throw conflict('La cuenta tiene movimientos o es del sistema: no se puede cambiar si es imputable');
    if (d.imputable && cta.hijos) throw conflict('La cuenta agrupa a otras: no puede ser imputable');
  }
  if (d.padre_id !== undefined) await validarPadre(c.env.DB, s.tallerId, d.padre_id, cta.tipo, id);
  const sets: string[] = [];
  const params: unknown[] = [];
  const poner = (col: string, v: unknown) => (sets.push(`${col} = ?`), params.push(v));
  if (d.codigo !== undefined) poner('codigo', d.codigo);
  if (d.nombre !== undefined) poner('nombre', d.nombre);
  if (d.notas !== undefined) poner('notas', d.notas);
  if (d.activa !== undefined) poner('activa', d.activa ? 1 : 0);
  if (d.imputable !== undefined) poner('imputable', d.imputable ? 1 : 0);
  if (d.padre_id !== undefined) poner('padre_id', d.padre_id ?? null);
  if (!sets.length) throw badRequest('No hay cambios para guardar');
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE cuentas_contables SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ? AND id = ?`).bind(...params, s.tallerId, id),
      auditar(c.env.DB, s.tallerId, s.usuarioId, 'cuenta_contable', id, 'editar', { campos: sets.map((x) => x.split(' ')[0]) }),
    ]);
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw conflict('Ya existe una cuenta con ese código', 'duplicado');
    errorContable(e);
  }
  return c.json(await first(c.env.DB, 'SELECT * FROM cuentas_contables WHERE taller_id = ? AND id = ?', s.tallerId, id));
});

contabilidad.delete('/cuentas/:id', ver, gestionar, async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const cta = await first<{ rol: string | null; cuenta_bancaria_id: string | null; movimientos: number; hijos: number; categorias: number }>(
    c.env.DB,
    `SELECT c.rol, c.cuenta_bancaria_id,
            (SELECT COUNT(*) FROM asiento_lineas l WHERE l.taller_id = c.taller_id AND l.cuenta_id = c.id) AS movimientos,
            (SELECT COUNT(*) FROM cuentas_contables h WHERE h.taller_id = c.taller_id AND h.padre_id = c.id) AS hijos,
            (SELECT COUNT(*) FROM categorias_gasto g WHERE g.taller_id = c.taller_id AND g.cuenta_contable_id = c.id) AS categorias
       FROM cuentas_contables c WHERE c.taller_id = ? AND c.id = ?`,
    s.tallerId, id,
  );
  if (!cta) throw notFound('Cuenta');
  if (cta.rol || cta.cuenta_bancaria_id) throw conflict('Es una cuenta del sistema: no se puede eliminar');
  if (cta.movimientos) throw conflict('La cuenta tiene movimientos: no se puede eliminar. Podés desactivarla para que no reciba nuevos asientos.', 'con_movimientos');
  if (cta.hijos) throw conflict('La cuenta agrupa a otras cuentas: eliminá o movelas primero');
  if (cta.categorias) throw conflict('La cuenta está asignada a categorías de gasto: cambiá esa asignación primero');
  try {
    await c.env.DB.batch([c.env.DB.prepare('DELETE FROM cuentas_contables WHERE taller_id = ? AND id = ?').bind(s.tallerId, id), auditar(c.env.DB, s.tallerId, s.usuarioId, 'cuenta_contable', id, 'eliminar')]);
  } catch (e) {
    errorContable(e);
  }
  return c.json({ ok: true });
});

// Cuenta contable de cada categoría de gasto
contabilidad.get('/categorias-gasto', ver, async (c) => {
  const s = c.get('sesion');
  await exigirActivada(c);
  const cats = await all<{ id: string; nombre: string; tipo: string; activa: number; cuenta_contable_id: string | null }>(
    c.env.DB, 'SELECT id, nombre, tipo, activa, cuenta_contable_id FROM categorias_gasto WHERE taller_id = ? ORDER BY nombre COLLATE NOCASE', s.tallerId,
  );
  const cuentas = await all<{ id: string; rol: string | null; codigo: string; nombre: string }>(c.env.DB, 'SELECT id, rol, codigo, nombre FROM cuentas_contables WHERE taller_id = ?', s.tallerId);
  return c.json(
    cats.map((g) => {
      const porDefecto = cuentas.find((x) => x.rol === rolDeGasto(g.nombre, g.tipo));
      const elegida = cuentas.find((x) => x.id === g.cuenta_contable_id);
      return { ...g, cuenta: elegida ?? porDefecto ?? null, es_por_defecto: !elegida };
    }),
  );
});

contabilidad.put('/categorias-gasto/:id', ver, gestionar, async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, z.object({ cuenta_id: zId.nullable() }));
  if (!(await first(c.env.DB, 'SELECT 1 FROM categorias_gasto WHERE taller_id = ? AND id = ?', s.tallerId, id))) throw notFound('Categoría');
  if (d.cuenta_id) {
    const cta = await first<{ tipo: string; imputable: number; activa: number }>(c.env.DB, 'SELECT tipo, imputable, activa FROM cuentas_contables WHERE taller_id = ? AND id = ?', s.tallerId, d.cuenta_id);
    if (!cta) throw badRequest('Cuenta inexistente');
    if (!cta.imputable || !cta.activa) throw badRequest('La cuenta debe ser imputable y estar activa');
    if (!['gasto', 'costo'].includes(cta.tipo)) throw badRequest('Elegí una cuenta de gastos o de costos');
  }
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE categorias_gasto SET cuenta_contable_id = ? WHERE taller_id = ? AND id = ?').bind(d.cuenta_id, s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'categoria_gasto', id, 'cuenta_contable', { cuenta_id: d.cuenta_id }),
  ]);
  return c.json({ ok: true });
});

// ═════════════════════════ Asientos ═════════════════════════
const zLinea = z.object({ cuenta_id: zId, debe: z.number().int().min(0).max(1e13).default(0), haber: z.number().int().min(0).max(1e13).default(0), detalle: zTextoOpt(200) });
const zAsiento = z.object({
  fecha: zFecha,
  descripcion: z.string().trim().min(3).max(200),
  lineas: z.array(zLinea).min(2).max(60),
  registrar: z.boolean().default(false),
  idem_key: z.string().min(8).max(80),
});

function fechaContable(f: string): string {
  const [y, m, d] = f.split('-').map(Number);
  if (new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) !== f) throw badRequest('La fecha no existe en el calendario');
  if (f > hoy()) throw badRequest('La fecha no puede ser posterior a hoy');
  if (f < '2000-01-01') throw badRequest('La fecha es demasiado antigua');
  return f;
}

async function validarCuentasDeLineas(db: D1Database, tallerId: string, lineas: Array<{ cuenta_id: string }>) {
  const ids = [...new Set(lineas.map((l) => l.cuenta_id))];
  const filas = await all<{ id: string; imputable: number; activa: number; codigo: string }>(db, `SELECT id, imputable, activa, codigo FROM cuentas_contables WHERE taller_id = ? AND id IN (${ids.map(() => '?').join(',')})`, tallerId, ...ids);
  if (filas.length !== ids.length) throw badRequest('Hay cuentas inexistentes en el asiento');
  const mala = filas.find((f) => !f.imputable || !f.activa);
  if (mala) throw badRequest(`La cuenta ${mala.codigo} es un rubro o está inactiva: no recibe asientos`);
}

const aLineasIn = (ls: z.infer<typeof zLinea>[]): LineaIn[] => ls.map((l) => ({ cuentaId: l.cuenta_id, debe: l.debe, haber: l.haber, detalle: l.detalle }));

async function cargarAsiento(db: D1Database, tallerId: string, id: string) {
  const a = await first<Record<string, any>>(
    db,
    `SELECT a.*, u.nombre AS usuario,
            (SELECT r.numero FROM asientos r WHERE r.taller_id = a.taller_id AND r.revierte_id = a.id) AS revertido_por_numero,
            (SELECT r.id FROM asientos r WHERE r.taller_id = a.taller_id AND r.revierte_id = a.id) AS revertido_por_id,
            (SELECT o.numero FROM asientos o WHERE o.taller_id = a.taller_id AND o.id = a.revierte_id) AS revierte_numero,
            (SELECT o.numero FROM asientos o WHERE o.taller_id = a.taller_id AND o.id = a.corrige_id) AS corrige_numero
       FROM asientos a LEFT JOIN usuarios u ON u.taller_id = a.taller_id AND u.id = a.usuario_id WHERE a.taller_id = ? AND a.id = ?`,
    tallerId, id,
  );
  if (!a) throw notFound('Asiento');
  const lineas = await all(
    db,
    `SELECT l.id, l.orden, l.cuenta_id, c.codigo AS cuenta_codigo, c.nombre AS cuenta_nombre, l.debe, l.haber, l.detalle FROM asiento_lineas l
       JOIN cuentas_contables c ON c.taller_id = l.taller_id AND c.id = l.cuenta_id WHERE l.taller_id = ? AND l.asiento_id = ? ORDER BY l.orden`,
    tallerId, id,
  );
  return { ...a, lineas };
}

contabilidad.get('/diario', ver, async (c) => {
  const s = c.get('sesion');
  const f = query(
    c,
    z.object({
      desde: zFecha, hasta: zFecha, estado: z.enum(['registrado', 'revertido', 'borrador', 'contabilizados', 'todos']).default('contabilizados'),
      origen: z.string().max(40).optional(), cuenta_id: z.string().max(64).optional(), q: z.string().max(80).optional(),
      limite: z.coerce.number().int().min(1).max(500).default(100), pagina: z.coerce.number().int().min(0).max(100000).default(0),
    }),
  );
  if (f.desde > f.hasta) throw badRequest('El período es inválido');
  await autorizarExportacion(c, 'contabilidad-libro-diario');
  const exportando = c.req.query('exportar') === '1';
  await exigirActivada(c);
  return c.json(await libroDiario(c.env.DB, s.tallerId, { desde: f.desde, hasta: f.hasta, estado: f.estado, origen: f.origen, cuentaId: f.cuenta_id, q: f.q, limite: exportando ? 500 : f.limite, desplazamiento: exportando ? 0 : f.pagina * f.limite }));
});

contabilidad.get('/asientos/:id', ver, async (c) => c.json(await cargarAsiento(c.env.DB, c.get('sesion').tallerId, c.req.param('id'))));

contabilidad.post('/asientos', ver, gestionar, async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zAsiento);
  const dup = await first<{ id: string }>(c.env.DB, 'SELECT id FROM asientos WHERE taller_id = ? AND idem_key = ?', s.tallerId, d.idem_key);
  if (dup) return c.json({ ...(await cargarAsiento(c.env.DB, s.tallerId, dup.id)), duplicado: true });
  const fecha = fechaContable(d.fecha);
  const error = d.registrar ? validarLineas(d.lineas) : null;
  if (error) throw badRequest(error);
  await exigirActivada(c);
  await validarCuentasDeLineas(c.env.DB, s.tallerId, d.lineas);
  const id = uid();
  try {
    await c.env.DB.batch([
      ...sentenciasAsiento(c.env.DB, s.tallerId, { id, fecha, descripcion: d.descripcion, modo: 'manual', origenTipo: 'manual', idemKey: d.idem_key, usuarioId: s.usuarioId, lineas: aLineasIn(d.lineas), registrar: d.registrar }),
      auditar(c.env.DB, s.tallerId, s.usuarioId, 'asiento', id, d.registrar ? 'crear_y_registrar' : 'crear_borrador'),
    ]);
  } catch (e) {
    if (String(e).includes('idem_key')) {
      const ex = await first<{ id: string }>(c.env.DB, 'SELECT id FROM asientos WHERE taller_id = ? AND idem_key = ?', s.tallerId, d.idem_key);
      if (ex) return c.json({ ...(await cargarAsiento(c.env.DB, s.tallerId, ex.id)), duplicado: true });
    }
    errorContable(e);
  }
  return c.json(await cargarAsiento(c.env.DB, s.tallerId, id), 201);
});

async function exigirBorrador(db: D1Database, tallerId: string, id: string) {
  const a = await first<{ estado: string; modo: string }>(db, 'SELECT estado, modo FROM asientos WHERE taller_id = ? AND id = ?', tallerId, id);
  if (!a) throw notFound('Asiento');
  if (a.estado !== 'borrador') throw conflict('Un asiento registrado no se modifica ni se elimina: se corrige con un contra-asiento', 'asiento_registrado');
  return a;
}

contabilidad.put('/asientos/:id', ver, gestionar, async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, zAsiento.omit({ idem_key: true, registrar: true }).extend({ registrar: z.boolean().default(false) }));
  await exigirBorrador(c.env.DB, s.tallerId, id);
  const fecha = fechaContable(d.fecha);
  if (d.registrar) {
    const e = validarLineas(d.lineas);
    if (e) throw badRequest(e);
  }
  await validarCuentasDeLineas(c.env.DB, s.tallerId, d.lineas);
  const stmts: Stmt[] = [
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM asientos WHERE taller_id = ? AND id = ? AND estado = 'borrador')", s.tallerId, id),
    c.env.DB.prepare("UPDATE asientos SET fecha = ?, descripcion = ? WHERE taller_id = ? AND id = ? AND estado = 'borrador'").bind(fecha, d.descripcion, s.tallerId, id),
    c.env.DB.prepare('DELETE FROM asiento_lineas WHERE taller_id = ? AND asiento_id = ?').bind(s.tallerId, id),
    ...sentenciasLineas(c.env.DB, s.tallerId, id, aLineasIn(d.lineas)),
    ...(d.registrar ? [sentenciaRegistrar(c.env.DB, s.tallerId, id, s.usuarioId)] : []),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'asiento', id, d.registrar ? 'editar_y_registrar' : 'editar_borrador'),
  ];
  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    errorContable(e);
  }
  return c.json(await cargarAsiento(c.env.DB, s.tallerId, id));
});

contabilidad.delete('/asientos/:id', ver, gestionar, async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  await exigirBorrador(c.env.DB, s.tallerId, id);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM asientos WHERE taller_id = ? AND id = ? AND estado = 'borrador'").bind(s.tallerId, id),
      auditar(c.env.DB, s.tallerId, s.usuarioId, 'asiento', id, 'descartar_borrador'),
    ]);
  } catch (e) {
    errorContable(e);
  }
  return c.json({ ok: true });
});

contabilidad.post('/asientos/:id/registrar', ver, gestionar, async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  await exigirBorrador(c.env.DB, s.tallerId, id);
  try {
    await c.env.DB.batch([sentenciaRegistrar(c.env.DB, s.tallerId, id, s.usuarioId), auditar(c.env.DB, s.tallerId, s.usuarioId, 'asiento', id, 'registrar')]);
  } catch (e) {
    errorContable(e);
  }
  return c.json(await cargarAsiento(c.env.DB, s.tallerId, id));
});

/** Datos de un asiento registrado que se puede revertir o corregir a mano. Los automáticos se revierten anulando la operación de origen. */
async function asientoRevertible(db: D1Database, tallerId: string, id: string) {
  const a = await first<{ estado: string; modo: string; fecha: string; numero: number; descripcion: string; revierte_id: string | null }>(
    db, 'SELECT estado, modo, fecha, numero, descripcion, revierte_id FROM asientos WHERE taller_id = ? AND id = ?', tallerId, id,
  );
  if (!a) throw notFound('Asiento');
  if (a.estado === 'revertido') throw conflict('El asiento ya fue revertido');
  if (a.estado !== 'registrado') throw conflict('Sólo se revierte un asiento registrado. Un borrador se puede descartar.');
  if (a.modo !== 'manual') throw conflict('Este asiento nació de una operación: se revierte anulando la operación de origen (venta, cobro, compra…).', 'asiento_automatico');
  const lineas = await all<{ cuenta_id: string; debe: number; haber: number; detalle: string | null }>(db, 'SELECT cuenta_id, debe, haber, detalle FROM asiento_lineas WHERE taller_id = ? AND asiento_id = ? ORDER BY orden', tallerId, id);
  return { ...a, lineas: lineas.map((l) => ({ cuentaId: l.cuenta_id, debe: l.debe, haber: l.haber, detalle: l.detalle })) };
}

contabilidad.post('/asientos/:id/revertir', ver, gestionar, async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, z.object({ motivo: z.string().trim().min(3).max(300), fecha: zFecha.optional() }));
  const a = await asientoRevertible(c.env.DB, s.tallerId, id);
  const fecha = fechaContable(d.fecha ?? hoy());
  if (fecha < a.fecha) throw badRequest('El contra-asiento no puede ser anterior al asiento que revierte');
  const rid = uid();
  try {
    await c.env.DB.batch([
      ...sentenciasAsiento(c.env.DB, s.tallerId, {
        id: rid, fecha, descripcion: `Reversión del asiento N° ${a.numero}: ${d.motivo}`, modo: 'reversion', origenTipo: 'manual', revierteId: id, motivo: d.motivo, usuarioId: s.usuarioId, lineas: invertir(a.lineas), registrar: true,
      }),
      auditar(c.env.DB, s.tallerId, s.usuarioId, 'asiento', id, 'revertir', { motivo: d.motivo, contra_asiento: rid }),
    ]);
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw conflict('El asiento ya fue revertido');
    errorContable(e);
  }
  return c.json({ original: await cargarAsiento(c.env.DB, s.tallerId, id), contra_asiento: await cargarAsiento(c.env.DB, s.tallerId, rid) }, 201);
});

/** Corregir = revertir el asiento original y dejar el asiento corregido, vinculado al original, en la misma operación. */
contabilidad.post('/asientos/:id/corregir', ver, gestionar, async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, zAsiento.omit({ idem_key: true }).extend({ motivo: z.string().trim().min(3).max(300), idem_key: z.string().min(8).max(80) }));
  const a = await asientoRevertible(c.env.DB, s.tallerId, id);
  const fecha = fechaContable(d.fecha);
  if (d.registrar) {
    const e = validarLineas(d.lineas);
    if (e) throw badRequest(e);
  }
  await validarCuentasDeLineas(c.env.DB, s.tallerId, d.lineas);
  const hoyF = hoy();
  const rid = uid();
  const nid = uid();
  try {
    await c.env.DB.batch([
      ...sentenciasAsiento(c.env.DB, s.tallerId, {
        id: rid, fecha: hoyF < a.fecha ? a.fecha : hoyF, descripcion: `Reversión del asiento N° ${a.numero} (corrección): ${d.motivo}`, modo: 'reversion', origenTipo: 'manual', revierteId: id, motivo: d.motivo, usuarioId: s.usuarioId, lineas: invertir(a.lineas), registrar: true,
      }),
      ...sentenciasAsiento(c.env.DB, s.tallerId, { id: nid, fecha, descripcion: d.descripcion, modo: 'manual', origenTipo: 'manual', corrigeId: id, motivo: d.motivo, idemKey: d.idem_key, usuarioId: s.usuarioId, lineas: aLineasIn(d.lineas), registrar: d.registrar }),
      auditar(c.env.DB, s.tallerId, s.usuarioId, 'asiento', id, 'corregir', { motivo: d.motivo, contra_asiento: rid, asiento_corregido: nid }),
    ]);
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw conflict('El asiento ya fue revertido o la corrección ya se registró');
    errorContable(e);
  }
  return c.json({ original: await cargarAsiento(c.env.DB, s.tallerId, id), contra_asiento: await cargarAsiento(c.env.DB, s.tallerId, rid), corregido: await cargarAsiento(c.env.DB, s.tallerId, nid) }, 201);
});

// ═════════════════════════ Libro mayor, balance, resultados ═════════════════════════
contabilidad.get('/mayor', ver, async (c) => {
  const s = c.get('sesion');
  const f = query(c, zPeriodo.extend({ cuenta_id: zId }));
  if (f.desde > f.hasta) throw badRequest('El período es inválido');
  await autorizarExportacion(c, 'contabilidad-libro-mayor');
  await exigirActivada(c);
  const r = await libroMayor(c.env.DB, s.tallerId, f.cuenta_id, f.desde, f.hasta, c.req.query('exportar') === '1' ? 20000 : 2000);
  if (!r) throw notFound('Cuenta');
  return c.json(r);
});

contabilidad.get('/balance', ver, async (c) => {
  const s = c.get('sesion');
  const p = periodo(c);
  await autorizarExportacion(c, 'contabilidad-balance');
  await exigirActivada(c);
  return c.json(await balanceSumasYSaldos(c.env.DB, s.tallerId, p.desde, p.hasta));
});

contabilidad.get('/estado-resultados', ver, requirePerm('margenes.ver'), async (c) => {
  const s = c.get('sesion');
  const p = periodo(c);
  await autorizarExportacion(c, 'contabilidad-estado-resultados');
  await exigirActivada(c);
  const [er, flujo] = await Promise.all([estadoResultados(c.env.DB, s.tallerId, p.desde, p.hasta, true), flujoDeCaja(c.env.DB, s.tallerId, p.desde, p.hasta)]);
  return c.json({ ...er, flujo_caja: flujo });
});

contabilidad.get('/resumen-contable', ver, async (c) => {
  const s = c.get('sesion');
  const p = periodo(c);
  await exigirActivada(c);
  const verResultados = tiene(s, 'margenes.ver');
  const [plan, flujo, er, pend, ctl, asientos, corrida] = await Promise.all([
    planConSaldos(c.env.DB, s.tallerId, p.hasta),
    flujoDeCaja(c.env.DB, s.tallerId, p.desde, p.hasta),
    verResultados ? estadoResultados(c.env.DB, s.tallerId, p.desde, p.hasta, false) : Promise.resolve(null),
    pendientesContabilizar(c.env.DB, s.tallerId),
    controles(c.env.DB, s.tallerId, { valorizar: tiene(s, 'stock.valorizar') }),
    first<{ total: number; borradores: number; automaticos: number; manuales: number; historicos: number }>(
      c.env.DB,
      `SELECT COUNT(*) AS total, SUM(estado = 'borrador') AS borradores, SUM(modo IN ('automatico','reversion')) AS automaticos, SUM(modo = 'manual') AS manuales, SUM(modo = 'historico') AS historicos FROM asientos WHERE taller_id = ?`,
      s.tallerId,
    ),
    first(c.env.DB, 'SELECT iniciada_at, disparador, asientos_creados, asientos_historicos, omitidos FROM contab_corridas WHERE taller_id = ? ORDER BY iniciada_at DESC LIMIT 1', s.tallerId),
  ]);
  const saldo = (rol: string) => plan.find((x) => x.rol === rol)?.saldo ?? 0;
  const bancos = plan.filter((x) => x.cuenta_bancaria_id).reduce((a, x) => a + x.saldo, 0);
  const disponibilidades = saldo('caja_efectivo') + saldo('valores_depositar') + saldo('electronicos_sin_cuenta') + bancos;
  const incons = ctl.filter((x) => x.estado === 'diferencia').length;
  return c.json({
    desde: p.desde, hasta: p.hasta,
    resultado: er ? { ventas_netas: er.ventas_netas, resultado_bruto: er.resultado_bruto, gastos: er.gastos, resultado: er.resultado, calidad: er.calidad, motivos: er.motivos } : null,
    posicion: {
      disponibilidades, caja: saldo('caja_efectivo'), bancos, cheques_en_cartera: saldo('valores_depositar'), por_cobrar: saldo('deudores'), por_pagar: saldo('proveedores') + saldo('mercaderia_a_facturar') + saldo('cheques_emitidos'),
      anticipos_clientes: saldo('anticipos'),
      ...(tiene(s, 'stock.valorizar') ? { inventario: saldo('inventario') } : {}),
    },
    flujo_caja: flujo,
    proceso: { asientos: asientos ?? { total: 0 }, pendientes: pend.pendientes, errores: pend.errores, sin_efecto: pend.sin_efecto, ultima_corrida: corrida, controles_con_diferencia: incons, controles_con_aviso: ctl.filter((x) => x.estado === 'aviso').length },
  });
});

contabilidad.get('/controles', ver, async (c) => {
  const s = c.get('sesion');
  await autorizarExportacion(c, 'contabilidad-controles');
  await exigirActivada(c);
  return c.json({ controles: await controles(c.env.DB, s.tallerId, { valorizar: tiene(s, 'stock.valorizar') }) });
});
