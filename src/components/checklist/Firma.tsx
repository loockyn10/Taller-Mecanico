// Firma manuscrita en pantalla táctil (dedo o lápiz). Se guarda como trazos vectoriales (listas de puntos), no como imagen: pesa unos pocos KB, no usa el
// almacenamiento de fotografías y se puede volver a dibujar idéntica. Es una constancia de conformidad, no una firma digital certificada.
import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { Eraser } from 'lucide-react';
import { Boton, cn } from '../ui';

export interface FirmaTrazos {
  ancho: number;
  alto: number;
  trazos: Array<Array<[number, number]>>;
}

// Espacio lógico de la firma: el servidor guarda estas coordenadas sin importar el tamaño de la pantalla.
const ANCHO = 600;
const ALTO = 220;
const MAX_PUNTOS_TRAZO = 1900;
const MAX_TRAZOS = 58;
const MAX_PUNTOS = 5800;

export interface FirmaPadRef {
  limpiar: () => void;
  trazos: () => FirmaTrazos;
}

export const FirmaPad = forwardRef<FirmaPadRef, { onCambio?: (hayFirma: boolean) => void; deshabilitado?: boolean }>(function FirmaPad({ onCambio, deshabilitado }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const trazos = useRef<Array<Array<[number, number]>>>([]);
  const actual = useRef<Array<[number, number]> | null>(null);
  const puntos = useRef(0);
  const [hay, setHay] = useState(false);

  const dibujar = useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = Math.round((w * ALTO) / ANCHO);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.height = `${h}px`;
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // Renglón de firma
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(16, h - 38);
    ctx.lineTo(w - 16, h - 38);
    ctx.stroke();
    ctx.setLineDash([]);
    const k = w / ANCHO;
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const t of [...trazos.current, ...(actual.current ? [actual.current] : [])]) {
      ctx.beginPath();
      t.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * k, y * k) : ctx.lineTo(x * k, y * k)));
      if (t.length === 1) ctx.lineTo(t[0][0] * k + 0.1, t[0][1] * k);
      ctx.stroke();
    }
  }, []);

  useEffect(() => {
    dibujar();
    const o = new ResizeObserver(dibujar);
    if (canvas.current) o.observe(canvas.current);
    return () => o.disconnect();
  }, [dibujar]);

  const punto = (e: React.PointerEvent): [number, number] => {
    const r = canvas.current!.getBoundingClientRect();
    return [Math.max(0, Math.min(ANCHO, Math.round(((e.clientX - r.left) / r.width) * ANCHO))), Math.max(0, Math.min(ALTO, Math.round(((e.clientY - r.top) / r.height) * ALTO)))];
  };
  const marcar = (v: boolean) => {
    setHay(v);
    onCambio?.(v);
  };

  const limpiar = () => {
    trazos.current = [];
    actual.current = null;
    puntos.current = 0;
    dibujar();
    marcar(false);
  };
  useImperativeHandle(ref, () => ({
    limpiar,
    trazos: () => ({ ancho: ANCHO, alto: ALTO, trazos: trazos.current.map((t) => t.map(([x, y]) => [x, y] as [number, number])) }),
  }));

  return (
    <div className="space-y-2">
      <div className={cn('relative overflow-hidden rounded-card border-2 border-dashed bg-white', hay ? 'border-marca-300' : 'border-borde-fuerte')}>
        <canvas
          ref={canvas}
          className="block w-full touch-none"
          style={{ aspectRatio: `${ANCHO} / ${ALTO}` }}
          aria-label="Espacio para la firma del cliente"
          onPointerDown={(e) => {
            if (deshabilitado || trazos.current.length >= MAX_TRAZOS || puntos.current >= MAX_PUNTOS) return;
            try {
              e.currentTarget.setPointerCapture(e.pointerId); // sigue el trazo aunque el dedo salga del lienzo
            } catch {
              /* no es crítico */
            }
            actual.current = [punto(e)];
            puntos.current++;
            dibujar();
          }}
          onPointerMove={(e) => {
            const t = actual.current;
            if (!t || t.length >= MAX_PUNTOS_TRAZO || puntos.current >= MAX_PUNTOS) return;
            const p = punto(e);
            const u = t[t.length - 1];
            if (Math.abs(p[0] - u[0]) + Math.abs(p[1] - u[1]) < 2) return; // descarta puntos casi iguales
            t.push(p);
            puntos.current++;
            dibujar();
          }}
          onPointerUp={() => {
            if (!actual.current) return;
            trazos.current.push(actual.current);
            actual.current = null;
            dibujar();
            marcar(true);
          }}
          onPointerCancel={() => {
            actual.current = null;
            dibujar();
          }}
        />
        {!hay && <span className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-slate-400">Firmá acá con el dedo o con un lápiz táctil</span>}
      </div>
      <div className="flex justify-end">
        <Boton tam="sm" icono={<Eraser className="size-4" />} disabled={!hay || deshabilitado} onClick={limpiar}>
          Borrar y firmar de nuevo
        </Boton>
      </div>
    </div>
  );
});

/** Firma ya guardada, dibujada a partir de sus trazos. */
export function FirmaVista({ firma, className }: { firma: FirmaTrazos; className?: string }) {
  return (
    <svg viewBox={`0 0 ${firma.ancho} ${firma.alto}`} className={cn('block h-auto w-full rounded-ctl border border-borde bg-white', className)} role="img" aria-label="Firma del cliente">
      {firma.trazos.map((t, i) => (
        <polyline key={i} points={t.length === 1 ? `${t[0][0]},${t[0][1]} ${t[0][0] + 0.1},${t[0][1]}` : t.map(([x, y]) => `${x},${y}`).join(' ')} fill="none" stroke="#0f172a" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  );
}
