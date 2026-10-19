import type { Context } from 'hono';
import { z, type ZodTypeAny } from 'zod';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export const notFound = (what = 'Registro') => new ApiError(404, 'no_encontrado', `${what} no encontrado`);
export const badRequest = (msg: string, details?: unknown) => new ApiError(400, 'datos_invalidos', msg, details);
export const conflict = (msg: string, code = 'conflicto') => new ApiError(409, code, msg);
export const forbidden = (msg = 'No tenés permiso para esta acción') => new ApiError(403, 'sin_permiso', msg);

/** Lee y valida el cuerpo JSON con un esquema Zod. */
export async function body<T extends ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest('El cuerpo de la solicitud no es JSON válido');
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0];
    throw badRequest(`${first.path.join('.') || 'datos'}: ${first.message}`, r.error.flatten());
  }
  return r.data;
}

export function query<T extends ZodTypeAny>(c: Context, schema: T): z.infer<T> {
  const r = schema.safeParse(c.req.query());
  if (!r.success) {
    const first = r.error.issues[0];
    throw badRequest(`${first.path.join('.')}: ${first.message}`);
  }
  return r.data;
}

/** Traduce errores de D1/SQLite a respuestas útiles. */
export function traducirErrorDb(e: unknown): ApiError | null {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('tx_guard') || msg.includes('ok = 1')) {
    return conflict('La operación no se pudo completar porque los datos cambiaron o una regla de negocio lo impide. Actualizá y reintentá.', 'regla_negocio');
  }
  if (msg.includes('UNIQUE constraint failed')) {
    if (msg.includes('patente')) return conflict('Ya existe un vehículo con esa patente en el taller', 'duplicado');
    if (msg.includes('email')) return conflict('Ya existe un usuario con ese email', 'duplicado');
    if (msg.includes('idem_key')) return conflict('La operación ya fue registrada', 'duplicado');
    if (msg.includes('idx_ordenes_presupuesto') || msg.includes('ordenes.taller_id, ordenes.presupuesto_id'))
      return conflict('El presupuesto ya fue convertido en una OT', 'duplicado');
    if (msg.includes('ventas.taller_id, ventas.orden_id')) return conflict('La OT ya tiene un comprobante vigente', 'duplicado');
    if (msg.includes('codigo')) return conflict('Ya existe un registro con ese código', 'duplicado');
    if (msg.includes('nombre')) return conflict('Ya existe un registro con ese nombre', 'duplicado');
    return conflict('Registro duplicado', 'duplicado');
  }
  if (msg.includes('FOREIGN KEY constraint failed')) {
    return conflict('El registro está relacionado con datos inexistentes o de otro taller, o tiene registros que dependen de él', 'referencia_invalida');
  }
  if (msg.includes('CHECK constraint failed')) {
    if (msg.includes('cobrado')) return conflict('El importe supera el saldo pendiente del comprobante', 'saldo_excedido');
    return badRequest('Algún valor está fuera de rango');
  }
  return null;
}

// Esquemas reutilizables
export const zId = z.string().min(1).max(64);
export const zTexto = (max = 200) => z.string().trim().max(max);
export const zTextoOpt = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
export const zFecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha inválida (AAAA-MM-DD)');
export const zCentavos = z.number().int().min(0).max(1e13);
export const zPct = z.number().min(0).max(100);
