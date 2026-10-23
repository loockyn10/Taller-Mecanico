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

export interface AtajoPeriodo {
  texto: string;
  desde: string;
  hasta: string;
}

/** Desde / hasta con atajos. En celular las dos fechas comparten la primera fila y los atajos pasan a la siguiente. */
export function SelectorPeriodo({ desde, hasta, onCambio, atajos }: { desde: string; hasta: string; onCambio: (d: string, h: string) => void; atajos?: AtajoPeriodo[] }) {
  const lista = atajos ?? [
    { texto: 'Hoy', desde: hoyISO(), hasta: hoyISO() },
    { texto: 'Este mes', desde: primerDiaMes(), hasta: hoyISO() },
    { texto: 'Mes anterior', desde: primerDiaMes(-1), hasta: ultimoDiaMes(-1) },
    { texto: 'Este año', desde: `${new Date().getFullYear()}-01-01`, hasta: hoyISO() },
  ];
  return (
    <div className="mb-4 flex flex-wrap items-end gap-x-3 gap-y-2.5">
      <div className="grid w-full grid-cols-2 gap-3 sm:flex sm:w-auto">
        <Campo label="Desde"><Input type="date" value={desde} onChange={(e) => onCambio(e.target.value, hasta)} /></Campo>
        <Campo label="Hasta"><Input type="date" value={hasta} onChange={(e) => onCambio(desde, e.target.value)} /></Campo>
      </div>
      <div className="flex flex-wrap gap-1.5 sm:mb-1">
        {lista.map((x) => <Boton key={x.texto} tam="sm" variante={desde === x.desde && hasta === x.hasta ? 'primario' : 'secundario'} onClick={() => onCambio(x.desde, x.hasta)}>{x.texto}</Boton>)}
      </div>
    </div>
  );
}
