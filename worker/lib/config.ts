// Parámetros administrativos del taller que otros módulos consultan.
import { first } from './db';
import { badRequest } from './http';
import { MEDIO_PAGO_LABEL, MEDIOS_PAGO, type MedioPago } from '../../shared/dominio';

/** Medios de pago habilitados (NULL en la configuración = todos). El efectivo no se puede deshabilitar. */
export async function mediosHabilitados(db: D1Database, tallerId: string): Promise<readonly MedioPago[]> {
  const r = await first<{ medios_pago: string | null }>(db, 'SELECT medios_pago FROM taller_config WHERE taller_id = ?', tallerId);
  if (!r?.medios_pago) return MEDIOS_PAGO;
  try {
    const l = JSON.parse(r.medios_pago) as string[];
    return MEDIOS_PAGO.filter((m) => m === 'efectivo' || l.includes(m));
  } catch {
    return MEDIOS_PAGO;
  }
}

export async function exigirMediosHabilitados(db: D1Database, tallerId: string, medios: string[]) {
  const ok = await mediosHabilitados(db, tallerId);
  for (const m of new Set(medios)) {
    if (!ok.includes(m as MedioPago)) throw badRequest(`El medio de pago "${MEDIO_PAGO_LABEL[m as MedioPago] ?? m}" está deshabilitado en la configuración del taller`);
  }
}
