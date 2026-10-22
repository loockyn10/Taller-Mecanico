// Plan de cuentas de cada taller: alta idempotente del plan inicial y de las cuentas contables de las cuentas bancarias.
import { all, type Stmt } from '../db';
import { codigoCuentaValido, naturalezaDe, PLAN_INICIAL, RUBRO_BANCOS, type CuentaBase, type RolCuenta } from '../../../shared/contabilidad';

export interface CuentaFila {
  id: string;
  codigo: string;
  nombre: string;
  tipo: string;
  naturaleza: string;
  padre_id: string | null;
  imputable: number;
  rol: string | null;
  cuenta_bancaria_id: string | null;
  activa: number;
  notas: string | null;
}

/** Id determinístico de las cuentas del sistema: dos procesos que inicializan a la vez nunca duplican una cuenta. */
const idSistema = (tallerId: string, c: CuentaBase) => `${tallerId}:${c.rol ?? `rubro:${c.codigo}`}`;
const idBanco = (tallerId: string, bancoId: string) => `${tallerId}:banco:${bancoId}`;

const INSERT_CUENTA =
  'INSERT OR IGNORE INTO cuentas_contables (id, taller_id, codigo, nombre, tipo, naturaleza, padre_id, imputable, rol, cuenta_bancaria_id, notas) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

/**
 * Crea (si faltan) el plan inicial y la cuenta contable de cada cuenta bancaria en pesos. Es idempotente y no toca lo que el taller ya cambió:
 * una cuenta del sistema renombrada o con otro código se reconoce por su rol.
 */
export async function inicializarPlan(db: D1Database, tallerId: string): Promise<void> {
  const [existentes, bancos] = await Promise.all([
    all<CuentaFila>(db, 'SELECT id, codigo, rol, cuenta_bancaria_id FROM cuentas_contables WHERE taller_id = ?', tallerId) as Promise<Array<Pick<CuentaFila, 'id' | 'codigo' | 'rol' | 'cuenta_bancaria_id'>>>,
    all<{ id: string; nombre: string }>(db, "SELECT id, nombre FROM cuentas_bancarias WHERE taller_id = ? AND moneda = 'ARS'", tallerId),
  ]);
  const stmts: Stmt[] = [db.prepare('INSERT OR IGNORE INTO contab_config (taller_id) VALUES (?)').bind(tallerId)];
  const codigos = new Set(existentes.map((c) => c.codigo));
  const roles = new Set(existentes.map((c) => c.rol).filter(Boolean));
  const idPorCodigo = new Map<string, string>(); // rubros ya existentes por código
  for (const c of existentes) if (!c.rol && !c.cuenta_bancaria_id) idPorCodigo.set(c.codigo, c.id);
  let nuevas = 0;
  for (const base of PLAN_INICIAL) {
    if (base.rol ? roles.has(base.rol) : idPorCodigo.has(base.codigo)) continue;
    let codigo = base.codigo;
    while (codigos.has(codigo)) codigo += '.9'; // código ocupado por una cuenta del taller: se usa otro, nunca se pisa
    if (!codigoCuentaValido(codigo)) continue;
    const id = idSistema(tallerId, base);
    const padreBase = base.padre ? PLAN_INICIAL.find((p) => p.codigo === base.padre) : undefined;
    const padreId = padreBase ? idPorCodigo.get(padreBase.codigo) ?? idSistema(tallerId, padreBase) : null;
    stmts.push(db.prepare(INSERT_CUENTA).bind(id, tallerId, codigo, base.nombre, base.tipo, base.contra ? (naturalezaDe(base.tipo) === 'deudora' ? 'acreedora' : 'deudora') : naturalezaDe(base.tipo), padreId, base.imputable ? 1 : 0, base.rol ?? null, null, base.notas ?? null));
    codigos.add(codigo);
    if (base.rol) roles.add(base.rol);
    else idPorCodigo.set(base.codigo, id);
    nuevas++;
  }
  // Una cuenta contable por cada cuenta bancaria en pesos.
  const conBanco = new Set(existentes.map((c) => c.cuenta_bancaria_id).filter(Boolean));
  const rubroBancos = idPorCodigo.get(RUBRO_BANCOS) ?? `${tallerId}:rubro:${RUBRO_BANCOS}`;
  let n = existentes.filter((c) => c.cuenta_bancaria_id).length;
  for (const b of bancos) {
    if (conBanco.has(b.id)) continue;
    let codigo: string;
    do codigo = `${RUBRO_BANCOS}.${String(++n).padStart(3, '0')}`;
    while (codigos.has(codigo));
    codigos.add(codigo);
    stmts.push(db.prepare(INSERT_CUENTA).bind(idBanco(tallerId, b.id), tallerId, codigo, `Banco: ${b.nombre}`, 'activo', 'deudora', rubroBancos, 1, null, b.id, null));
    nuevas++;
  }
  if (stmts.length > 1) await db.batch(stmts);
  else await stmts[0].run();
  void nuevas;
}

export interface MapaCuentas {
  porRol: Map<string, string>;
  porBanco: Map<string, string>;
  /** Cuentas imputables y activas (las únicas que pueden recibir asientos). */
  validas: Set<string>;
}

export async function cargarMapa(db: D1Database, tallerId: string): Promise<MapaCuentas> {
  const filas = await all<Pick<CuentaFila, 'id' | 'rol' | 'cuenta_bancaria_id' | 'imputable' | 'activa'>>(db, 'SELECT id, rol, cuenta_bancaria_id, imputable, activa FROM cuentas_contables WHERE taller_id = ?', tallerId);
  const m: MapaCuentas = { porRol: new Map(), porBanco: new Map(), validas: new Set() };
  for (const f of filas) {
    if (f.rol) m.porRol.set(f.rol, f.id);
    if (f.cuenta_bancaria_id) m.porBanco.set(f.cuenta_bancaria_id, f.id);
    if (f.imputable && f.activa) m.validas.add(f.id);
  }
  return m;
}

export const rolFaltante = (r: RolCuenta) => new Error(`Falta la cuenta contable del sistema "${r}"`);
