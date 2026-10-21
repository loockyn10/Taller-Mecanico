// Zona horaria del taller. Los instantes se guardan siempre en UTC (la hora la fija el servidor); la zona solo se usa para
// asignar cada fichaje al día local, agrupar reportes y mostrar horarios.
import { first } from './db';
import { ZONA_HORARIA_DEFECTO } from '../../shared/permisos';

export function zonaValida(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function zonaDelTaller(db: D1Database, tallerId: string): Promise<string> {
  const r = await first<{ zona_horaria: string | null }>(db, 'SELECT zona_horaria FROM taller_config WHERE taller_id = ?', tallerId);
  return r?.zona_horaria && zonaValida(r.zona_horaria) ? r.zona_horaria : ZONA_HORARIA_DEFECTO;
}

/** Partes de fecha y hora de un instante en una zona. */
function partes(instante: Date | number, tz: string) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(instante)) o[p.type] = p.value;
  return o;
}

/** Fecha local (AAAA-MM-DD) de un instante en la zona indicada. */
export function fechaLocal(instante: Date | number | string, tz: string): string {
  const d = typeof instante === 'string' ? new Date(instante) : instante;
  const p = partes(d, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Hora local (HH:MM) de un instante en la zona indicada. */
export function horaLocal(instante: Date | number | string, tz: string): string {
  const d = typeof instante === 'string' ? new Date(instante) : instante;
  const p = partes(d, tz);
  return `${p.hour}:${p.minute}`;
}

/**
 * Instante UTC que corresponde a una fecha y hora locales (AAAA-MM-DD, HH:MM) en la zona. Se resuelve con dos aproximaciones
 * sucesivas del desfase: alcanza para todas las zonas (con o sin horario de verano) fuera de las horas que no existen o se repiten.
 */
export function instanteDesdeLocal(fecha: string, hora: string, tz: string): Date {
  const [y, mo, d] = fecha.split('-').map(Number);
  const [h, mi] = hora.split(':').map(Number);
  const nominal = Date.UTC(y, mo - 1, d, h, mi);
  const desfase = (t: number) => {
    const p = partes(t, tz);
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(t / 1000) * 1000;
  };
  let t = nominal - desfase(nominal);
  t = nominal - desfase(t);
  return new Date(t);
}
