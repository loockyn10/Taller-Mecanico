// Ejecución de un lote de importación: validación de permisos, planificación por tipo y escritura atómica con su registro.
import type { Sesion } from '../../env';
import { forbidden, badRequest } from '../http';
import { tiene } from '../auth';
import { puedeCosto, puedePrecioVenta } from '../privacidad';
import { first, all, guard, type Stmt } from '../db';
import { resolverDeposito } from '../stock';
import { camposDe, LIMITES_IMPORTACION, type ModoImportacion, type ResultadoFila, type TipoImportacion, type Valores } from '../../../shared/importacion';
import type { Contexto, FilaEntrada, OpcionesImportacion, Plan } from './comun';
import { planificarClientes } from './clientes';
import { planificarProveedores } from './proveedores';
import { planificarVehiculos } from './vehiculos';
import { planificarArticulos } from './articulos';

const PLANIFICADORES: Record<TipoImportacion, (ctx: Contexto, filas: FilaEntrada[]) => Promise<Plan>> = {
  clientes: planificarClientes,
  vehiculos: planificarVehiculos,
  articulos: planificarArticulos,
  proveedores: planificarProveedores,
};

/** Se queda solo con los campos conocidos del tipo y recorta las celdas: lo que llega del navegador no se toma tal cual. */
export function limpiarFilas(tipo: TipoImportacion, filas: Array<{ n: number; v: Record<string, string | number | null> }>): FilaEntrada[] {
  const validos = new Set(camposDe(tipo).map((c) => c.clave));
  const vistos = new Set<number>();
  return filas.map((f) => {
    if (vistos.has(f.n)) throw badRequest(`La fila ${f.n} está repetida en el mismo lote`);
    vistos.add(f.n);
    const v: Valores = {};
    for (const [k, val] of Object.entries(f.v)) {
      if (!validos.has(k) || val === null || val === '') continue;
      v[k] = typeof val === 'string' ? val.slice(0, LIMITES_IMPORTACION.maxCelda) : val;
    }
    return { n: f.n, v };
  });
}

/** Permisos necesarios: el de importar, el de crear (y editar si actualiza) de cada tipo y los de precios si el archivo trae costos o precios. */
export function exigirPermisos(s: Sesion, tipo: TipoImportacion, modo: ModoImportacion, opciones: OpcionesImportacion, filas?: FilaEntrada[]) {
  const necesita = (...p: Parameters<typeof tiene>[1][]) => {
    if (!p.every((x) => tiene(s, x))) throw forbidden('No tenés permiso para importar este tipo de datos');
  };
  if (tipo === 'clientes') necesita(...(modo === 'actualizar' ? (['clientes.crear', 'clientes.editar'] as const) : (['clientes.crear'] as const)));
  else if (tipo === 'vehiculos') necesita(...(modo === 'actualizar' ? (['vehiculos.crear', 'vehiculos.editar'] as const) : (['vehiculos.crear'] as const)));
  else if (tipo === 'proveedores') necesita('compras.gestionar');
  else {
    necesita('catalogo.editar');
    if (opciones.stock_inicial) necesita('stock.ajustar');
    if (filas?.some((f) => f.v.costo !== undefined) && !puedeCosto(s)) throw forbidden('No tenés permiso para ver ni modificar costos');
    if (filas?.some((f) => f.v.precio !== undefined) && !puedePrecioVenta(s)) throw forbidden('No tenés permiso para ver ni modificar precios de venta');
  }
}

export async function validarOpciones(db: D1Database, tallerId: string, tipo: TipoImportacion, opciones: OpcionesImportacion) {
  if (opciones.stock_inicial && tipo !== 'articulos') throw badRequest('La carga de existencias solo se aplica a artículos');
  if (opciones.stock_inicial) await resolverDeposito(db, tallerId, opciones.stock_inicial.deposito_id);
}

export async function planificar(tipo: TipoImportacion, ctx: Contexto, filas: FilaEntrada[]): Promise<Plan> {
  return PLANIFICADORES[tipo](ctx, filas);
}

export interface Contadores { creados: number; actualizados: number; omitidos: number; errores: number }
export const contar = (r: ResultadoFila[]): Contadores => ({
  creados: r.filter((x) => x.accion === 'crear').length,
  actualizados: r.filter((x) => x.accion === 'actualizar').length,
  omitidos: r.filter((x) => x.accion === 'omitir').length,
  errores: r.filter((x) => x.accion === 'error').length,
});

/** Sentencias de registro del lote (contadores, errores guardados y registros tocados). Todo viaja en el mismo batch que los datos. */
export async function sentenciasRegistro(db: D1Database, tallerId: string, importacionId: string, lote: number, plan: Plan): Promise<Stmt[]> {
  const c = contar(plan.resultados);
  const s: Stmt[] = [
    guard(db, "NOT EXISTS (SELECT 1 FROM importaciones WHERE taller_id = ? AND id = ? AND estado = 'en_curso')", tallerId, importacionId),
  ];
  s.push(...plan.stmts);
  for (let i = 0; i < plan.registros.length; i += 24) {
    const parte = plan.registros.slice(i, i + 24);
    s.push(
      db.prepare(`INSERT OR REPLACE INTO importacion_registros (taller_id, importacion_id, entidad_id, accion) VALUES ${parte.map(() => '(?,?,?,?)').join(',')}`)
        .bind(...parte.flatMap((r) => [tallerId, importacionId, r.id, r.accion])),
    );
  }
  const guardados = (await first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM importacion_errores WHERE taller_id = ? AND importacion_id = ?', tallerId, importacionId))?.n ?? 0;
  const capacidad = Math.max(0, LIMITES_IMPORTACION.maxErroresGuardados - guardados);
  // Primero los errores y después las omisiones: lo que hay que corregir tiene prioridad sobre el espacio disponible.
  const problemas = [...plan.resultados.filter((r) => r.accion === 'error'), ...plan.resultados.filter((r) => r.accion === 'omitir')].slice(0, capacidad);
  for (let i = 0; i < problemas.length; i += 14) {
    const parte = problemas.slice(i, i + 14);
    s.push(
      db.prepare(`INSERT INTO importacion_errores (taller_id, importacion_id, lote, fila, severidad, referencia, mensaje) VALUES ${parte.map(() => '(?,?,?,?,?,?,?)').join(',')}`)
        .bind(...parte.flatMap((r) => [tallerId, importacionId, lote, r.n, r.accion === 'error' ? 'error' : 'omitido', r.ref || null, (r.accion === 'error' ? r.errores.join(' · ') : r.motivo ?? '').slice(0, 300)])),
    );
  }
  s.push(
    db.prepare('INSERT INTO importacion_lotes (taller_id, importacion_id, lote, filas, creados, actualizados, omitidos, errores) VALUES (?,?,?,?,?,?,?,?)')
      .bind(tallerId, importacionId, lote, plan.resultados.length, c.creados, c.actualizados, c.omitidos, c.errores),
    db.prepare(
      `UPDATE importaciones SET procesados = procesados + ?, creados = creados + ?, actualizados = actualizados + ?, omitidos = omitidos + ?, errores = errores + ?
        WHERE taller_id = ? AND id = ?`,
    ).bind(plan.resultados.length, c.creados, c.actualizados, c.omitidos, c.errores, tallerId, importacionId),
  );
  return s;
}

export const erroresDeLote = (db: D1Database, tallerId: string, importacionId: string, lote: number) =>
  all<{ fila: number; severidad: string; referencia: string | null; mensaje: string }>(
    db,
    'SELECT fila, severidad, referencia, mensaje FROM importacion_errores WHERE taller_id = ? AND importacion_id = ? AND lote = ? ORDER BY fila',
    tallerId, importacionId, lote,
  );
