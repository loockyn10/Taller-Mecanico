// Lógica del asistente de importación que no depende de la pantalla: armado de filas a partir del mapeo, duplicados del archivo e informes.
import {
  clavesDeFila, normalizarArticulo, normalizarCliente, normalizarProveedor, normalizarVehiculo, type OpcionesFila, type ResultadoFila, type TipoImportacion, type Valores,
} from '@shared/importacion';
import type { CeldaArchivo, HojaArchivo } from './archivo';

export interface FilaOrigen {
  /** Número de fila en el archivo (1 = primera fila de la hoja). */
  n: number;
  celdas: CeldaArchivo[];
}

/** Separa encabezados y filas con datos (las filas vacías se saltean pero conservan su número). */
export function prepararHoja(hoja: HojaArchivo, conTitulos: boolean): { columnas: string[]; filas: FilaOrigen[] } {
  const vacia = (f: CeldaArchivo[]) => !f.some((c) => c !== '' && !(typeof c === 'string' && c.trim() === ''));
  const todas = hoja.filas.map((celdas, i) => ({ n: i + 1, celdas })).filter((f) => !vacia(f.celdas));
  const ancho = Math.max(1, ...todas.map((f) => f.celdas.length));
  const letra = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `${String.fromCharCode(64 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`);
  if (conTitulos && todas.length) {
    const [cab, ...resto] = todas;
    return { columnas: Array.from({ length: ancho }, (_, i) => String(cab.celdas[i] ?? '').trim() || `Columna ${letra(i)}`), filas: resto };
  }
  return { columnas: Array.from({ length: ancho }, (_, i) => `Columna ${letra(i)}`), filas: todas };
}

/** Valores de una fila según el mapeo campo → índice de columna. */
export function valoresDe(fila: FilaOrigen, mapeo: Record<string, number | null>): Valores {
  const v: Valores = {};
  for (const [campo, col] of Object.entries(mapeo)) {
    if (col === null || col === undefined) continue;
    const c = fila.celdas[col];
    if (c !== undefined && c !== '') v[campo] = c;
  }
  return v;
}

/** Las claves de duplicado de cada fila según el mismo criterio que usa el servidor. */
function clavesDe(tipo: TipoImportacion, v: Valores, op: OpcionesFila, anioMax: number): { claves: string[]; invalida: boolean } {
  const n =
    tipo === 'clientes' ? normalizarCliente(v)
    : tipo === 'proveedores' ? normalizarProveedor(v)
    : tipo === 'vehiculos' ? normalizarVehiculo(v, anioMax)
    : normalizarArticulo(v, op);
  return { claves: clavesDeFila(tipo, n.datos), invalida: n.errores.length > 0 };
}

/**
 * Marca como error la segunda aparición de un mismo registro dentro del archivo (el servidor lo hace por lote; entre lotes lo verifica
 * contra lo que ya cargó). Solo cuenta las filas que, a juicio del servidor, no tenían errores.
 */
export function marcarDuplicadosDelArchivo(tipo: TipoImportacion, filas: FilaOrigen[], mapeo: Record<string, number | null>, resultados: ResultadoFila[], op: OpcionesFila): ResultadoFila[] {
  const vistas = new Map<string, number>();
  const anioMax = new Date().getFullYear() + 1;
  return resultados.map((r, i) => {
    if (r.accion === 'error') return r;
    const { claves, invalida } = clavesDe(tipo, valoresDe(filas[i], mapeo), op, anioMax);
    if (invalida) return r;
    const previa = claves.map((k) => vistas.get(k)).find((x) => x !== undefined);
    if (previa !== undefined) return { ...r, accion: 'error' as const, errores: [`Duplicado en el archivo: es el mismo registro que la fila ${previa}`], cambios: undefined, motivo: undefined };
    for (const k of claves) vistas.set(k, r.n);
    return r;
  });
}

export const ETIQUETA_ACCION: Record<string, string> = { crear: 'Nuevo', actualizar: 'Se actualiza', omitir: 'Se omite', error: 'Con error' };

/** Filas del informe de problemas: los datos originales de la fila más el motivo. */
export function informeProblemas(columnas: string[], filas: FilaOrigen[], resultados: ResultadoFila[], incluirOmitidos: boolean): { encabezado: string[]; filas: Array<Array<unknown>> } {
  const porN = new Map(filas.map((f) => [f.n, f]));
  const sel = resultados.filter((r) => r.accion === 'error' || (incluirOmitidos && r.accion === 'omitir'));
  return {
    encabezado: ['Fila', 'Resultado', 'Motivo', ...columnas],
    filas: sel.map((r) => [r.n, r.accion === 'error' ? 'Error' : 'Omitida', r.accion === 'error' ? r.errores.join(' · ') : r.motivo ?? '', ...columnas.map((_, i) => porN.get(r.n)?.celdas[i] ?? '')]),
  };
}
