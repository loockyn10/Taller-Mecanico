// Motor común de las importaciones: preparación de filas, detección de duplicados y decisión según el modo elegido.
import type { Sesion } from '../../env';
import { all, lotes, type Stmt } from '../db';
import {
  clavesDeFila, type FilaNormalizada, type ModoImportacion, type ResultadoFila, type TipoImportacion, type Valores, type CambioCampo,
} from '../../../shared/importacion';

export interface OpcionesImportacion {
  decimal: ',' | '.';
  /** Crear las categorías, marcas y modelos que no existan (si no, esas filas se informan como error). */
  crear_catalogos: boolean;
  /** Solo artículos: cargar la existencia del archivo como stock inicial del depósito indicado (procedimiento explícito). */
  stock_inicial: { deposito_id: string | null } | null;
}

export interface FilaEntrada {
  n: number;
  v: Valores;
}

export interface Contexto {
  db: D1Database;
  tallerId: string;
  sesion: Sesion;
  modo: ModoImportacion;
  opciones: OpcionesImportacion;
  /** null en la validación previa: no se escribe nada. */
  importacionId: string | null;
  /** Resoluciones elegidas por la persona para referencias que no se pudieron resolver solas (`cliente:doc:123` → id). */
  resoluciones: Record<string, string>;
  aplicar: boolean;
}

export interface Plan {
  resultados: ResultadoFila[];
  stmts: Stmt[];
  /** Registros que esta importación crea o modifica (trazabilidad y detección de duplicados entre lotes). */
  registros: Array<{ id: string; accion: 'creado' | 'actualizado' }>;
}

export interface Trabajo<D> {
  n: number;
  datos: D;
  claves: string[];
  res: ResultadoFila;
}

export const unicos = <T>(xs: T[]): T[] => [...new Set(xs)];

export function agregar<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
}

/**
 * Normaliza cada fila y marca como error las que se repiten dentro del mismo lote (la segunda aparición). Los duplicados entre lotes
 * los detecta cada tipo contra los registros que esta misma importación ya creó.
 */
export function prepararFilas<D extends object>(tipo: TipoImportacion, filas: FilaEntrada[], normalizar: (v: Valores) => FilaNormalizada<D>): Trabajo<D>[] {
  const vistas = new Map<string, number>();
  return filas.map((f) => {
    const norm = normalizar(f.v);
    const res: ResultadoFila = { n: f.n, accion: norm.errores.length ? 'error' : 'crear', ref: norm.ref, errores: [...norm.errores], avisos: [...norm.avisos] };
    const claves = clavesDeFila(tipo, norm.datos);
    if (res.accion !== 'error') {
      const previa = claves.map((k) => vistas.get(k)).find((x) => x !== undefined);
      if (previa !== undefined) {
        res.accion = 'error';
        res.errores.push(`Duplicado en el archivo: es el mismo registro que la fila ${previa}`);
      } else for (const k of claves) vistas.set(k, f.n);
    }
    return { n: f.n, datos: norm.datos, claves, res };
  });
}

/** Registros existentes que coinciden con alguna clave de la fila (sin repetir). */
export function buscar<E extends { id: string }>(claves: string[], mapa: Map<string, E[]>): E[] {
  const r = new Map<string, E>();
  for (const k of claves) for (const e of mapa.get(k) ?? []) r.set(e.id, e);
  return [...r.values()];
}

export type Decision = { tipo: 'crear' } | { tipo: 'actualizar' } | { tipo: 'omitir'; motivo: string } | { tipo: 'error'; motivo: string };

/** Qué hacer con una fila según el modo, si tiene identificador y cuántos registros existentes coinciden. */
export function decidir(modo: ModoImportacion, tieneClaves: boolean, coincidencias: number, etiqueta: string): Decision {
  if (coincidencias > 1) {
    return modo === 'actualizar'
      ? { tipo: 'error', motivo: `Hay ${coincidencias} ${etiqueta} que coinciden con esta fila: no se puede saber cuál actualizar` }
      : { tipo: 'omitir', motivo: `Ya existe (coincide con ${coincidencias} registros)` };
  }
  if (coincidencias === 1) return modo === 'actualizar' ? { tipo: 'actualizar' } : { tipo: 'omitir', motivo: 'Ya existe' };
  if (!tieneClaves && modo === 'solo_nuevos') return { tipo: 'omitir', motivo: 'Sin identificador: no se puede comprobar que sea nuevo' };
  return { tipo: 'crear' };
}

/** Ids (entre los indicados) que esta importación ya creó o modificó en lotes anteriores. */
export async function idsDelTrabajo(ctx: Contexto, ids: string[]): Promise<Set<string>> {
  const r = new Set<string>();
  if (!ctx.importacionId) return r;
  for (const l of lotes(ids)) {
    const rows = await all<{ entidad_id: string }>(
      ctx.db,
      `SELECT entidad_id FROM importacion_registros WHERE importacion_id = ? AND entidad_id IN (${l.map(() => '?').join(',')})`,
      ctx.importacionId, ...l,
    );
    for (const x of rows) r.add(x.entidad_id);
  }
  return r;
}

export const SQL_IN = (n: number) => Array.from({ length: n }, () => '?').join(',');

/** Compara un valor del archivo con el existente; devuelve el cambio si difieren. */
export function cambio(campo: string, antes: unknown, despues: unknown, mismo: (a: string, b: string) => boolean = (a, b) => a === b): CambioCampo | null {
  if (despues === undefined || despues === null || despues === '') return null;
  const a = antes == null ? '' : String(antes);
  const b = String(despues);
  return mismo(a, b) ? null : { campo, antes: a === '' ? null : a, despues: b };
}

export const iguales = (a: string, b: string) => a === b;
export const igualesSinCaso = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
