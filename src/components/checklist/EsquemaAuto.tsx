// Esquema sencillo del vehículo visto desde arriba (frente hacia arriba) para señalar daños con un toque. No es un editor gráfico: cada zona es un botón grande;
// el toque deja un marcador numerado en el lugar tocado. El interior se marca en el recuadro de al lado, porque desde arriba no se ve.
import type { MouseEvent, KeyboardEvent } from 'react';
import { ZONA_DANO_LABEL, type Dano, type ZonaDano } from '@shared/checklist';
import { cn } from '../ui';

const ANCHO = 360;
const ALTO = 420;

/** Posición por defecto del marcador en cada zona (porcentaje del esquema) cuando se agrega un daño desde la lista y no tocando el dibujo. */
export const POSICION_ZONA: Record<ZonaDano, { x: number; y: number }> = {
  frente: { x: (120 / ANCHO) * 100, y: (62 / ALTO) * 100 },
  trasera: { x: (120 / ANCHO) * 100, y: (368 / ALTO) * 100 },
  lateral_izquierdo: { x: (45 / ANCHO) * 100, y: (220 / ALTO) * 100 },
  lateral_derecho: { x: (195 / ANCHO) * 100, y: (220 / ALTO) * 100 },
  techo: { x: (120 / ANCHO) * 100, y: (220 / ALTO) * 100 },
  interior: { x: (295 / ANCHO) * 100, y: (210 / ALTO) * 100 },
};

// Contorno de cada zona tocable (coordenadas del esquema).
const ZONAS: Record<ZonaDano, { d: string }> = {
  frente: { d: 'M20 72 Q20 18 120 18 Q220 18 220 72 L220 112 L20 112 Z' },
  trasera: { d: 'M20 328 L220 328 L220 350 Q220 402 120 402 Q20 402 20 350 Z' },
  lateral_izquierdo: { d: 'M20 112 L70 112 L70 328 L20 328 Z' },
  lateral_derecho: { d: 'M170 112 L220 112 L220 328 L170 328 Z' },
  techo: { d: 'M70 112 L170 112 L170 328 L70 328 Z' },
  interior: { d: 'M250 130 Q250 122 258 122 L342 122 Q350 122 350 130 L350 290 Q350 298 342 298 L258 298 Q250 298 250 290 Z' },
};

export function EsquemaAuto({ danos, onZona, onDano, deshabilitado }: { danos: Dano[]; onZona: (zona: ZonaDano, x: number, y: number) => void; onDano: (id: string) => void; deshabilitado?: boolean }) {
  const cuenta = (z: ZonaDano) => danos.filter((d) => d.zona === z).length;

  const tocar = (zona: ZonaDano) => (e: MouseEvent<SVGElement>) => {
    if (deshabilitado) return;
    const svg = e.currentTarget.ownerSVGElement!;
    const m = svg.getScreenCTM();
    if (!m) return onZona(zona, POSICION_ZONA[zona].x, POSICION_ZONA[zona].y);
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    onZona(zona, Math.min(100, Math.max(0, (p.x / ANCHO) * 100)), Math.min(100, Math.max(0, (p.y / ALTO) * 100)));
  };
  const teclado = (zona: ZonaDano) => (e: KeyboardEvent<SVGElement>) => {
    if (deshabilitado || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    onZona(zona, POSICION_ZONA[zona].x, POSICION_ZONA[zona].y);
  };

  return (
    <svg viewBox={`0 0 ${ANCHO} ${ALTO}`} className="mx-auto block h-auto w-full max-w-sm select-none touch-manipulation" role="group" aria-label="Esquema del vehículo: tocá la zona donde hay un daño">
      {(Object.keys(ZONAS) as ZonaDano[]).map((z) => (
        <path
          key={z}
          d={ZONAS[z].d}
          role="button"
          tabIndex={deshabilitado ? -1 : 0}
          aria-label={`${ZONA_DANO_LABEL[z]}${cuenta(z) ? `, ${cuenta(z)} ${cuenta(z) === 1 ? 'daño' : 'daños'}` : ''}. Tocar para agregar un daño`}
          onClick={tocar(z)}
          onKeyDown={teclado(z)}
          className={cn(
            'stroke-slate-400 outline-none transition-colors [stroke-width:1.5] focus-visible:stroke-marca-600 focus-visible:[stroke-width:3]',
            cuenta(z) ? 'fill-peligro-50' : 'fill-slate-100',
            deshabilitado ? 'cursor-default' : 'cursor-pointer hover:fill-marca-50 active:fill-marca-100',
          )}
        />
      ))}

      {/* Detalles del dibujo (no se tocan) */}
      <g className="pointer-events-none" fill="none" strokeLinecap="round">
        <rect x="6" y="60" width="14" height="44" rx="6" className="fill-slate-300 stroke-slate-500" />
        <rect x="220" y="60" width="14" height="44" rx="6" className="fill-slate-300 stroke-slate-500" />
        <rect x="6" y="336" width="14" height="44" rx="6" className="fill-slate-300 stroke-slate-500" />
        <rect x="220" y="336" width="14" height="44" rx="6" className="fill-slate-300 stroke-slate-500" />
        <path d="M82 118 L158 118 L166 168 L74 168 Z" className="fill-white stroke-slate-400" />
        <path d="M80 296 L160 296 L156 326 L84 326 Z" className="fill-white stroke-slate-400" />
        <rect x="82" y="176" width="76" height="112" rx="10" className="stroke-slate-300" />
        <path d="M44 42 Q120 28 196 42" className="stroke-slate-400" />
        <path d="M44 392 Q120 402 196 392" className="stroke-slate-400" opacity="0" />
        <text x="120" y="12" textAnchor="middle" className="fill-slate-500 text-[11px]">FRENTE</text>
        <text x="120" y="416" textAnchor="middle" className="fill-slate-500 text-[11px]">ATRÁS</text>
        <text x="45" y="232" textAnchor="middle" className="fill-slate-500 text-[10px]" transform="rotate(-90 45 232)">IZQUIERDO</text>
        <text x="195" y="232" textAnchor="middle" className="fill-slate-500 text-[10px]" transform="rotate(90 195 232)">DERECHO</text>
        <text x="120" y="226" textAnchor="middle" className="fill-slate-500 text-[11px]">TECHO</text>
        {/* Interior: volante y asientos */}
        <circle cx="300" cy="162" r="14" className="stroke-slate-500 [stroke-width:3]" />
        <rect x="266" y="190" width="30" height="34" rx="8" className="fill-white stroke-slate-400" />
        <rect x="304" y="190" width="30" height="34" rx="8" className="fill-white stroke-slate-400" />
        <rect x="266" y="236" width="68" height="28" rx="8" className="fill-white stroke-slate-400" />
        <text x="300" y="116" textAnchor="middle" className="fill-slate-500 text-[11px]">INTERIOR</text>
      </g>

      {/* Marcadores numerados */}
      {danos.map((d, i) => {
        const p = d.x != null && d.y != null ? { x: d.x, y: d.y } : POSICION_ZONA[d.zona];
        const cx = (p.x / 100) * ANCHO;
        const cy = (p.y / 100) * ALTO;
        return (
          <g
            key={d.id}
            role="button"
            tabIndex={0}
            aria-label={`Daño ${i + 1}, ${ZONA_DANO_LABEL[d.zona]}${d.descripcion ? `: ${d.descripcion}` : ''}`}
            className="cursor-pointer outline-none [&:focus-visible>circle]:stroke-marca-700"
            onClick={(e) => {
              e.stopPropagation();
              onDano(d.id);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onDano(d.id);
              }
            }}
          >
            <circle cx={cx} cy={cy} r="15" className="fill-peligro-600 stroke-white [stroke-width:2.5]" />
            <text x={cx} y={cy + 5} textAnchor="middle" className="pointer-events-none fill-white text-[14px] font-bold">{i + 1}</text>
          </g>
        );
      })}
    </svg>
  );
}
