import { formatoMoneda } from '@shared/totals';
export { aCentavos } from '@shared/totals';

/** Importe en pesos. Si la API no lo envió (la persona no tiene permiso para verlo) muestra un guion. */
export const money = (centavos?: number | null): string => (centavos == null ? '—' : formatoMoneda(centavos));

// ───── Horarios en la zona del taller (los instantes llegan en UTC desde el servidor) ─────
const ZONA_DEFECTO = 'America/Argentina/Buenos_Aires';
export function horaZona(iso?: string | null, zona = ZONA_DEFECTO): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('es-AR', { timeZone: zona, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}
export function fechaZona(iso?: string | null, zona = ZONA_DEFECTO): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('es-AR', { timeZone: zona, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso));
}
export function fechaHoraZona(iso?: string | null, zona = ZONA_DEFECTO): string {
  if (!iso) return '—';
  return `${fechaZona(iso, zona)} ${horaZona(iso, zona)}`;
}
/** Día de la semana y fecha de un AAAA-MM-DD ("lun 20/10"). */
export function diaCorto(f: string): string {
  return new Date(`${f}T12:00:00`).toLocaleDateString('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit' });
}
/** Duración en horas y minutos ("7 h 32 min"). */
export function duracion(seg?: number | null): string {
  if (seg == null) return '—';
  const m = Math.floor(seg / 60);
  const h = Math.floor(m / 60);
  return h ? `${h} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
}
/** Horas decimales para planillas ("7,53"). */
export const horasDecimal = (seg: number): string => (seg / 3600).toFixed(2).replace('.', ',');

export function fecha(iso?: string | null): string {
  if (!iso) return '—';
  const d = iso.length === 10 ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function fechaHora(iso?: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Tamaño legible de un archivo o de un consumo de almacenamiento (MB / GB, base 1024). */
export function tamano(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2).replace(/\.?0+$/, '').replace('.', ',')} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

export function hoyISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function sumarDias(iso: string, dias: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + dias);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function km(n?: number | null): string {
  return n == null ? '—' : `${n.toLocaleString('es-AR')} km`;
}

export function numero(n: number, ancho = 4): string {
  return String(n).padStart(ancho, '0');
}

export function cantidad(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toLocaleString('es-AR', { maximumFractionDigits: 3 });
}

/** Enlace de WhatsApp (wa.me). Asume números argentinos si no tienen código de país. */
export function whatsapp(telefono: string | null | undefined, texto: string): string | null {
  if (!telefono) return null;
  let d = telefono.replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('0')) d = d.slice(1);
  if (!d.startsWith('54')) d = `549${d}`;
  return `https://wa.me/${d}?text=${encodeURIComponent(texto)}`;
}
