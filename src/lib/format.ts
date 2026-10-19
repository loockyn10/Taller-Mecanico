export { formatoMoneda as money, aCentavos } from '@shared/totals';

export function fecha(iso?: string | null): string {
  if (!iso) return '—';
  const d = iso.length === 10 ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function fechaHora(iso?: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
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
