// Fechas comerciales (comprobantes, cobros, compras, pagos, gastos).
// Antes cualquier usuario —incluido el empleado— podía cargar fechas arbitrarias (1999 o 2099) y alterar los reportes.
import type { Sesion } from '../env';
import { tiene } from './auth';
import { badRequest, forbidden } from './http';
import { hoy } from './db';

/** Tope de retroactividad incluso para quienes pueden cargar fechas pasadas (cargas atrasadas de hasta ~13 meses). */
export const MAX_DIAS_RETROACTIVOS = 400;

export function sumarDias(fecha: string, dias: number): string {
  const [y, m, d] = fecha.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + dias)).toISOString().slice(0, 10);
}

/** Devuelve la fecha comercial a usar. Sin fecha → hoy (Argentina). */
export function fechaComercial(s: Sesion, fecha?: string | null): string {
  const h = hoy();
  if (!fecha) return h;
  const [y, m, d] = fecha.split('-').map(Number);
  if (new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) !== fecha) throw badRequest('La fecha no existe en el calendario');
  if (fecha > h) throw badRequest('La fecha no puede ser posterior a hoy');
  if (fecha < h) {
    if (!tiene(s, 'fechas.retroactivas')) throw forbidden('Solo el propietario o un administrador pueden cargar operaciones con fecha anterior a hoy');
    if (fecha < sumarDias(h, -MAX_DIAS_RETROACTIVOS)) throw badRequest(`La fecha no puede ser anterior a ${MAX_DIAS_RETROACTIVOS} días`);
  }
  return fecha;
}
