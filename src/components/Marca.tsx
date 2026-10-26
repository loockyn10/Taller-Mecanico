// Identidad de ORVELAN Sistemas (marca madre) y especialidad del producto. Los logotipos son los originales del kit de marca
// (public/brand): no se redibujan ni se les agrega texto. «Taller Mecánico» va como texto aparte.
// La identidad de cada taller cliente (su logo y nombre) es independiente y no pasa por acá.
import { cn } from './ui';

export const MARCA_NOMBRE = 'ORVELAN Sistemas';
export const ESPECIALIDAD = 'Taller Mecánico';

/** Logotipo horizontal. `oscuro` es la versión para fondos oscuros (nombre en blanco). */
export function LogoOrvelan({ oscuro = false, sinDescriptor = false, className }: { oscuro?: boolean; sinDescriptor?: boolean; className?: string }) {
  const archivo = `/brand/orvelan-logo${oscuro ? '-oscuro' : ''}${sinDescriptor ? '-sin-descriptor' : ''}.svg`;
  return <img src={archivo} alt={MARCA_NOMBRE} className={cn('h-auto', className)} />;
}

/** Isotipo (símbolo solo), para poco espacio. */
export function Isotipo({ className }: { className?: string }) {
  return <img src="/brand/orvelan-isotipo.svg" alt={MARCA_NOMBRE} className={className} />;
}

/** Logotipo + especialidad del producto, centrado en columna. */
export function MarcaProducto({ oscuro = false, ancho = 'w-44', className }: { oscuro?: boolean; ancho?: string; className?: string }) {
  return (
    <div className={cn('inline-flex flex-col items-start gap-1', className)}>
      <LogoOrvelan oscuro={oscuro} className={ancho} />
      <span className={cn('pl-1 text-[13px] font-semibold tracking-wide', oscuro ? 'text-petroleo-200' : 'text-marca-700')}>{ESPECIALIDAD}</span>
    </div>
  );
}

/** Pie discreto para los documentos impresos: no reemplaza al logo del taller, sólo indica con qué sistema se emitió. */
export function PieOrvelan() {
  return (
    <p className="mt-6 flex items-center justify-center gap-1.5 text-[10px] text-slate-500">
      <img src="/brand/orvelan-isotipo.svg" alt="" className="size-3.5" />
      Emitido con {MARCA_NOMBRE} · {ESPECIALIDAD}
    </p>
  );
}
