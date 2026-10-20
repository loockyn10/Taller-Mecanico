// Selector de período (desde/hasta) con atajos, compartido por las pantallas de finanzas, tesorería e informes.
import { hoyISO, sumarDias } from '@/lib/format';
import { Boton, Campo, Input } from './ui';

export function primerDiaMes(offset = 0) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
export const ultimoDiaMes = (offset = 0) => sumarDias(primerDiaMes(offset + 1), -1);

export function SelectorPeriodo({ desde, hasta, onCambio }: { desde: string; hasta: string; onCambio: (d: string, h: string) => void }) {
  const preset = (d: string, h: string, texto: string) => <Boton tam="sm" variante={desde === d && hasta === h ? 'primario' : 'secundario'} onClick={() => onCambio(d, h)}>{texto}</Boton>;
  return (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <Campo label="Desde"><Input type="date" value={desde} onChange={(e) => onCambio(e.target.value, hasta)} /></Campo>
      <Campo label="Hasta"><Input type="date" value={hasta} onChange={(e) => onCambio(desde, e.target.value)} /></Campo>
      <div className="mb-0.5 flex flex-wrap gap-1.5">
        {preset(hoyISO(), hoyISO(), 'Hoy')}
        {preset(primerDiaMes(), hoyISO(), 'Este mes')}
        {preset(primerDiaMes(-1), ultimoDiaMes(-1), 'Mes anterior')}
        {preset(`${new Date().getFullYear()}-01-01`, hoyISO(), 'Este año')}
      </div>
    </div>
  );
}
