// Kit de componentes compartidos: toda la aplicación usa estas piezas para mantener un diseño consistente.
// Los colores, radios, sombras y anchos salen de los tokens de src/index.css; ninguna pantalla define los suyos.
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type RefObject,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { AlertTriangle, ArrowLeft, CheckCircle2, ChevronRight, Info, Loader2, Search, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '@/lib/api';

export const cn = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

// ───────────── Botones ─────────────
// Acción principal = relleno azul acero; secundaria = blanco con borde; terciaria = fantasma. Una pantalla debería tener
// una sola acción principal.
type Variante = 'primario' | 'secundario' | 'fantasma' | 'peligro' | 'exito';
const VARIANTES: Record<Variante, string> = {
  primario: 'bg-marca-600 text-white hover:bg-marca-700 active:bg-marca-800 shadow-sm',
  secundario: 'bg-white text-texto border border-borde-fuerte hover:bg-slate-50 hover:border-slate-400 active:bg-slate-100',
  fantasma: 'text-slate-600 hover:bg-slate-100 hover:text-texto active:bg-slate-200',
  peligro: 'bg-peligro-600 text-white hover:bg-red-700 active:bg-red-800 shadow-sm',
  exito: 'bg-exito-600 text-white hover:bg-exito-700 active:bg-emerald-800 shadow-sm',
};

export interface BotonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variante?: Variante;
  tam?: 'sm' | 'md' | 'lg';
  icono?: ReactNode;
  cargando?: boolean;
}

export const Boton = forwardRef<HTMLButtonElement, BotonProps>(function Boton({ variante = 'secundario', tam = 'md', icono, cargando, className, children, disabled, ...p }, ref) {
  const tams = { sm: 'h-8 px-2.5 text-[13px] gap-1.5 max-sm:h-9', md: 'h-10 px-3.5 text-sm gap-2', lg: 'h-12 px-5 text-base gap-2' };
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || cargando}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-ctl font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-marca-500 disabled:cursor-not-allowed disabled:opacity-50',
        tams[tam],
        VARIANTES[variante],
        className,
      )}
      {...p}
    >
      {cargando ? <Loader2 className="size-4 animate-spin" /> : icono}
      {children}
    </button>
  );
});

/** Botón de sólo ícono (editar, quitar, agregar): área táctil de 36 px, con etiqueta accesible obligatoria. */
export const BotonIcono = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { etiqueta: string; peligro?: boolean }>(function BotonIcono({ etiqueta, peligro, className, children, ...p }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={etiqueta}
      title={etiqueta}
      className={cn('inline-grid size-9 shrink-0 place-items-center rounded-ctl text-slate-500 transition-colors disabled:cursor-not-allowed disabled:opacity-40', peligro ? 'hover:bg-peligro-50 hover:text-peligro-600' : 'hover:bg-slate-100 hover:text-texto', className)}
      {...p}
    >
      {children}
    </button>
  );
});

// ───────────── Formularios ─────────────
/** Ancho completo salvo que el llamador indique un ancho propio (w-auto, w-40…). */
const ancho = (className?: string) => (className && /(^|\s)(sm:|md:)?w-/.test(className) ? '' : 'w-full');
// 16 px en celulares evita el zoom automático de iOS al enfocar un campo.
const BASE_INPUT =
  'min-w-0 max-w-full rounded-ctl border border-borde-fuerte bg-white px-3 text-base text-texto placeholder:text-slate-400 focus:border-marca-500 focus:outline-none focus:ring-2 focus:ring-marca-100 disabled:bg-slate-50 disabled:text-tenue sm:text-sm';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={cn(BASE_INPUT, ancho(className), 'h-10', className)} {...p} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...p }, ref) {
  return <textarea ref={ref} className={cn(BASE_INPUT, 'w-full min-h-20 py-2', className)} {...p} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...p }, ref) {
  return (
    <select ref={ref} className={cn(BASE_INPUT, ancho(className), 'h-10 pr-8', className)} {...p}>
      {children}
    </select>
  );
});

export function Campo({ label, hint, error, requerido, children, className }: { label?: ReactNode; hint?: ReactNode; error?: string | null; requerido?: boolean; children: ReactNode; className?: string }) {
  return (
    <label className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {label && (
        <span className="text-[13px] font-medium text-slate-700">
          {label}
          {requerido && <span className="ml-0.5 text-peligro-600">*</span>}
        </span>
      )}
      {children}
      {error ? <span className="text-xs text-peligro-600">{error}</span> : hint ? <span className="text-xs text-tenue">{hint}</span> : null}
    </label>
  );
}

/** Grilla de campos de un formulario: una columna en celular, dos en tablet y hasta 3–4 en escritorio. Los campos anchos usan `sm:col-span-2`. */
export function Grilla({ cols = 2, children, className }: { cols?: 1 | 2 | 3 | 4; children: ReactNode; className?: string }) {
  const c = { 1: 'grid-cols-1', 2: 'grid-cols-1 sm:grid-cols-2', 3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3', 4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4' }[cols];
  return <div className={cn('grid gap-x-4 gap-y-3.5', c, className)}>{children}</div>;
}

/** Sección de un formulario largo: título corto, descripción opcional y el contenido; las secciones consecutivas se separan con una línea. */
export function Seccion({ titulo, descripcion, children, className }: { titulo?: ReactNode; descripcion?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('space-y-3 border-t border-borde-suave pt-4 first:border-0 first:pt-0', className)}>
      {(titulo || descripcion) && (
        <div>
          {titulo && <h3 className="text-sm font-semibold text-texto">{titulo}</h3>}
          {descripcion && <p className="mt-0.5 text-xs text-tenue">{descripcion}</p>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Check({ checked, onChange, label, className, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; className?: string; disabled?: boolean }) {
  return (
    <label className={cn('inline-flex select-none items-start gap-2 text-sm', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer', className)}>
      <input type="checkbox" className="mt-0.5 size-4 shrink-0 rounded border-borde-fuerte accent-marca-600" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** Chip seleccionable (para listas de casillas del check-list, filtros, etc.). */
export function Chip({ activo, onClick, children, tono = 'marca' }: { activo: boolean; onClick: () => void; children: ReactNode; tono?: 'marca' | 'peligro' }) {
  const on = tono === 'peligro' ? 'border-red-300 bg-peligro-50 text-peligro-700' : 'border-marca-300 bg-marca-50 text-marca-700';
  return (
    <button type="button" onClick={onClick} aria-pressed={activo} className={cn('rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors', activo ? on : 'border-borde bg-white text-tenue hover:bg-slate-50')}>
      {children}
    </button>
  );
}

/** Input de importes: muestra pesos con separadores (fuera de edición), entrega centavos. */
const fmtEdicion = (c: number) => (c ? (c / 100).toString().replace('.', ',') : '');
const fmtVista = (c: number) => (c ? (c / 100).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '');
export function InputMoneda({ value, onChange, className, ...p }: { value: number; onChange: (centavos: number) => void; className?: string; placeholder?: string; disabled?: boolean; autoFocus?: boolean }) {
  const [foco, setFoco] = useState(false);
  const [txt, setTxt] = useState(() => fmtEdicion(value));
  const ultimo = useRef(value);
  useEffect(() => {
    if (value !== ultimo.current) {
      ultimo.current = value;
      setTxt(fmtEdicion(value));
    }
  }, [value]);
  return (
    <div className={cn('relative min-w-0 max-w-full', className)}>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-tenue">$</span>
      <input
        inputMode="decimal"
        className={cn(BASE_INPUT, 'h-10 w-full pl-7 text-right tabular-nums')}
        value={foco ? txt : fmtVista(value)}
        onFocus={(e) => {
          setFoco(true);
          setTxt(fmtEdicion(value));
          requestAnimationFrame(() => e.target.select());
        }}
        onBlur={() => setFoco(false)}
        onChange={(e) => {
          const t = e.target.value.replace(/[^\d.,]/g, '');
          setTxt(t);
          const s = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
          const n = Math.round(Number(s || 0) * 100);
          if (Number.isFinite(n)) {
            ultimo.current = n;
            onChange(n);
          }
        }}
        {...p}
      />
    </div>
  );
}

export function Buscador({ value, onChange, placeholder = 'Buscar…', className, autoFocus, onEnter }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; autoFocus?: boolean; onEnter?: (v: string) => void }) {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onEnter ? (e) => { if (e.key === 'Enter' && value.trim()) { e.preventDefault(); onEnter(value.trim()); } } : undefined}
        placeholder={placeholder}
        className="pl-9"
        autoFocus={autoFocus}
        enterKeyHint={onEnter ? 'search' : undefined}
      />
    </div>
  );
}

export function useDebounce<T>(v: T, ms = 300): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

// ───────────── Contenedores ─────────────
export function Tarjeta({ titulo, acciones, children, className, sinPadding, subtitulo }: { titulo?: ReactNode; subtitulo?: ReactNode; acciones?: ReactNode; children: ReactNode; className?: string; sinPadding?: boolean }) {
  return (
    <section className={cn('min-w-0 rounded-card border border-borde bg-superficie shadow-card', className)}>
      {(titulo || acciones) && (
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-t-card border-b border-borde-suave px-4 py-3">
          <div className="min-w-0">
            {titulo && <h2 className="text-[15px] font-semibold leading-snug text-texto">{titulo}</h2>}
            {subtitulo && <p className="text-xs text-tenue">{subtitulo}</p>}
          </div>
          {acciones && <div className="flex flex-wrap items-center gap-2">{acciones}</div>}
        </header>
      )}
      <div className={sinPadding ? '' : 'p-4'} data-sin-padding={sinPadding ? '' : undefined}>{children}</div>
    </section>
  );
}

export function Encabezado({ titulo, subtitulo, acciones, volver }: { titulo: ReactNode; subtitulo?: ReactNode; acciones?: ReactNode; volver?: string | boolean }) {
  const nav = useNavigate();
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="flex min-w-0 flex-1 items-start gap-2 basis-64">
        {volver && (
          <Boton variante="fantasma" tam="sm" className="mt-0.5 -ml-2" icono={<ArrowLeft className="size-4" />} onClick={() => (typeof volver === 'string' ? nav(volver) : nav(-1))} aria-label="Volver" />
        )}
        <div className="min-w-0">
          <h1 className="text-xl font-bold leading-tight tracking-tight text-texto sm:text-2xl">{titulo}</h1>
          {subtitulo && <p className="mt-1 text-sm text-tenue">{subtitulo}</p>}
        </div>
      </div>
      {acciones && <div className="flex flex-wrap items-center gap-2">{acciones}</div>}
    </div>
  );
}

const TONOS = {
  gris: 'bg-slate-100 text-slate-700 ring-slate-200',
  azul: 'bg-marca-50 text-marca-700 ring-marca-200',
  verde: 'bg-exito-50 text-exito-700 ring-exito-200',
  ambar: 'bg-aviso-50 text-aviso-800 ring-aviso-200',
  rojo: 'bg-peligro-50 text-peligro-700 ring-peligro-200',
  violeta: 'bg-violet-50 text-violet-700 ring-violet-200',
  cian: 'bg-cyan-50 text-cyan-800 ring-cyan-200',
} as const;
export type Tono = keyof typeof TONOS;

export function Insignia({ tono = 'gris', children, className }: { tono?: Tono; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', TONOS[tono], className)}>{children}</span>;
}

export function Indicador({ titulo, valor, detalle, icono, tono = 'azul', onClick }: { titulo: string; valor: ReactNode; detalle?: ReactNode; icono?: ReactNode; tono?: Tono; onClick?: () => void }) {
  // Valores compuestos ("a / b") pueden pasar a la línea siguiente entre las dos partes; cada parte queda entera.
  const trozos = typeof valor === 'string' && valor.includes(' / ') ? valor.split(' / ') : null;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="flex w-full min-w-0 items-start gap-3 rounded-card border border-borde bg-white p-3.5 text-left shadow-card transition [container-type:inline-size] enabled:hover:border-marca-300 enabled:hover:shadow-pop sm:p-4"
    >
      {icono && <span className={cn('grid size-8 shrink-0 place-items-center rounded-ctl ring-1 ring-inset @min-[13rem]:size-10', TONOS[tono])}>{icono}</span>}
      <span className="min-w-0">
        <span className="block text-xs font-medium uppercase tracking-wide text-tenue @max-[11rem]:text-[10px] @max-[11rem]:tracking-normal">{titulo}</span>
        {/* Los importes no se parten en dos líneas: la letra se ajusta al ancho real de la tarjeta (consulta de contenedor). */}
        <span className={cn('block font-bold leading-tight tabular-nums text-texto [font-size:clamp(0.8125rem,10.5cqw,1.25rem)]', !trozos && 'whitespace-nowrap')}>
          {trozos ? trozos.map((t, i) => <span key={i} className="inline-block whitespace-nowrap">{i > 0 && "/ "}{t}{i < trozos.length - 1 && " "}</span>) : valor}
        </span>
        {detalle && <span className="block text-xs text-tenue">{detalle}</span>}
      </span>
    </button>
  );
}

export function Vacio({ icono, titulo, texto, accion }: { icono?: ReactNode; titulo: string; texto?: ReactNode; accion?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
      {icono && <div className="mb-3 grid size-12 place-items-center rounded-full bg-slate-100 text-slate-500">{icono}</div>}
      <p className="font-medium text-texto">{titulo}</p>
      {texto && <p className="mt-1 max-w-sm text-sm text-tenue">{texto}</p>}
      {accion && <div className="mt-4">{accion}</div>}
    </div>
  );
}

export function Cargando({ texto = 'Cargando…' }: { texto?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-tenue">
      <Loader2 className="size-4 animate-spin" /> {texto}
    </div>
  );
}

export function ErrorCaja({ error, reintentar }: { error: unknown; reintentar?: () => void }) {
  const msg = error instanceof Error ? error.message : 'Ocurrió un error';
  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-card border border-peligro-200 bg-peligro-50 p-6 text-center text-sm text-red-800">
      <AlertTriangle className="size-5" />
      <p>{msg}</p>
      {reintentar && <Boton tam="sm" onClick={reintentar}>Reintentar</Boton>}
    </div>
  );
}

export function Aviso({ tono = 'azul', children, className }: { tono?: 'azul' | 'ambar' | 'rojo' | 'verde'; children: ReactNode; className?: string }) {
  const t = { azul: 'border-marca-200 bg-marca-50 text-marca-800', ambar: 'border-aviso-200 bg-aviso-50 text-amber-900', rojo: 'border-peligro-200 bg-peligro-50 text-red-800', verde: 'border-exito-200 bg-exito-50 text-emerald-800' }[tono];
  return <div className={cn('flex items-start gap-2 rounded-ctl border px-3 py-2.5 text-sm', t, className)}><Info className="mt-0.5 size-4 shrink-0" /><div className="min-w-0">{children}</div></div>;
}

// ───────────── Tablas responsive ─────────────
/**
 * Mide si el contenido de `ref` entra en el ancho disponible. Si no entra, pide la versión apilada (tarjetas) y recuerda cuánto
 * ancho necesitaba la versión tabla para volver a ella apenas haya lugar. Así ninguna tabla obliga a desplazarse en horizontal:
 * se decide por el espacio real del contenedor (no por el ancho de la pantalla, que con el menú lateral abierto engaña).
 * `dep` es lo que cambia el contenido (las filas): al cambiar se vuelve a medir con la versión tabla.
 */
function useApilar(dep: unknown): [RefObject<HTMLDivElement>, boolean] {
  const ref = useRef<HTMLDivElement>(null);
  const [apilar, setApilar] = useState(false);
  const natural = useRef(0);
  const estado = useRef(false);
  estado.current = apilar;

  // Cambió el contenido: vuelve a probar con la tabla (antes de pintar, sin parpadeo).
  useLayoutEffect(() => {
    if (estado.current) setApilar(false);
  }, [dep]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const medir = () => {
      const disponible = el.clientWidth;
      if (!estado.current) {
        if (el.scrollWidth > disponible + 1) {
          natural.current = el.scrollWidth;
          setApilar(true);
        }
      } else if (disponible > 0 && disponible >= natural.current) {
        setApilar(false);
      }
    };
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, [apilar, dep]);
  return [ref, apilar];
}

export interface Columna<T> {
  clave: string;
  titulo: ReactNode;
  render: (fila: T) => ReactNode;
  className?: string;
  /** En la vista apilada: 'titulo' y 'subtitulo' arman la cabecera de la tarjeta; 'derecha' el importe; 'meta' se muestra abajo; 'oculta' no se muestra. */
  movil?: 'titulo' | 'subtitulo' | 'derecha' | 'meta' | 'oculta';
  alinear?: 'derecha';
}

/**
 * Tabla de datos. Cuando entra en el ancho disponible se ve como tabla; cuando no, como lista de tarjetas con el dato
 * principal destacado y lo secundario agrupado debajo (ver `movil` en cada columna).
 */
export function Tabla<T>({ columnas, filas, clave, onFila, vacio }: { columnas: Columna<T>[]; filas: T[]; clave: (f: T) => string; onFila?: (f: T) => void; vacio?: ReactNode }) {
  const [ref, apilar] = useApilar(filas);
  if (!filas.length) return <>{vacio ?? <Vacio titulo="Sin resultados" />}</>;
  const col = (m: Columna<T>['movil']) => columnas.filter((c) => c.movil === m);
  return (
    <div ref={ref} className="overflow-x-auto">
      {!apilar ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-borde bg-superficie-2 text-left text-xs font-semibold uppercase tracking-wide text-tenue">
              {columnas.map((c) => (
                <th key={c.clave} scope="col" className={cn('px-4 py-2.5', c.alinear === 'derecha' && 'text-right', c.className)}>{c.titulo}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={clave(f)} onClick={onFila ? () => onFila(f) : undefined} className={cn('border-b border-borde-suave last:border-0', onFila && 'cursor-pointer hover:bg-marca-50/50')}>
                {columnas.map((c) => (
                  <td key={c.clave} className={cn('px-4 py-3 align-middle', c.alinear === 'derecha' && 'text-right tabular-nums', c.className)}>{c.render(f)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <ul className="divide-y divide-borde-suave">
          {filas.map((f) => (
            <li key={clave(f)} onClick={onFila ? () => onFila(f) : undefined} className={cn('px-4 py-3', onFila && 'cursor-pointer active:bg-slate-50')}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {col('titulo').map((c) => <div key={c.clave} className="break-words font-medium text-texto">{c.render(f)}</div>)}
                  {col('subtitulo').map((c) => <div key={c.clave} className="break-words text-sm text-tenue">{c.render(f)}</div>)}
                </div>
                <div className="shrink-0 text-right">{col('derecha').map((c) => <div key={c.clave} className="font-medium tabular-nums">{c.render(f)}</div>)}</div>
                {onFila && <ChevronRight className="mt-0.5 size-4 shrink-0 text-slate-500" aria-hidden />}
              </div>
              {col('meta').length > 0 && <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-tenue">{col('meta').map((c) => <span key={c.clave}>{c.render(f)}</span>)}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Envuelve una `<table>` escrita a mano (libros contables, informes, grillas editables): si no entra en el ancho disponible se
 * apila (cada fila pasa a ser una tarjeta con sus etiquetas de columna) en lugar de obligar a desplazarse en horizontal.
 * Las etiquetas se toman de la cabecera; una celda puede fijar la suya con `data-label` o no mostrar ninguna con `data-label=""`.
 */
export function TablaApilable({ children, className }: { children: ReactNode; className?: string }) {
  const [ref, apilar] = useApilar(children);
  // Copia el texto de cada cabecera a las celdas de su columna (para la vista apilada).
  useLayoutEffect(() => {
    const t = ref.current?.querySelector('table');
    if (!t) return;
    const cab = Array.from(t.querySelectorAll('thead tr:last-child th'));
    const nombres: string[] = [];
    cab.forEach((th) => {
      const n = (th as HTMLTableCellElement).colSpan || 1;
      for (let i = 0; i < n; i++) nombres.push((th.textContent ?? '').trim());
    });
    t.querySelectorAll('tbody tr, tfoot tr').forEach((tr) => {
      let pos = 0;
      Array.from(tr.children).forEach((td) => {
        const c = td as HTMLTableCellElement;
        if (c.dataset.label === undefined && nombres[pos]) c.dataset.label = nombres[pos];
        pos += c.colSpan || 1;
      });
    });
  });
  return <div ref={ref} className={cn('overflow-x-auto', apilar && 'tabla-apilada', className)}>{children}</div>;
}

// ───────────── Modal ─────────────
export function Modal({ abierto, onCerrar, titulo, children, pie, ancho = 'md' }: { abierto: boolean; onCerrar: () => void; titulo: ReactNode; children: ReactNode; pie?: ReactNode; ancho?: 'sm' | 'md' | 'lg' | 'xl' }) {
  useEffect(() => {
    if (!abierto) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onCerrar();
    window.addEventListener('keydown', h);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', h);
      document.body.style.overflow = '';
    };
  }, [abierto, onCerrar]);
  if (!abierto) return null;
  const w = { sm: 'sm:max-w-md', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl', xl: 'sm:max-w-4xl' }[ancho];
  // En celular la ventana sube desde abajo, ocupa todo el ancho y su cuerpo se desplaza en vertical: el título y las acciones
  // (guardar / cancelar) quedan siempre a la vista.
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-petroleo-950/50 p-0 backdrop-blur-[2px] sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onCerrar()}>
      <div role="dialog" aria-modal="true" className={cn('flex max-h-[92dvh] w-full min-w-0 flex-col rounded-t-modal bg-white shadow-modal sm:max-h-[90dvh] sm:rounded-modal', w)}>
        <header className="flex items-center justify-between gap-3 border-b border-borde px-4 py-3.5 sm:px-5">
          <h2 className="min-w-0 text-base font-semibold leading-snug">{titulo}</h2>
          <Boton variante="fantasma" tam="sm" onClick={onCerrar} aria-label="Cerrar" icono={<X className="size-4" />} />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">{children}</div>
        {pie && (
          <footer className="flex flex-col-reverse gap-2 border-t border-borde bg-superficie-2 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] max-sm:[&>button]:w-full sm:flex-row sm:flex-wrap sm:justify-end sm:rounded-b-modal sm:px-5 sm:pb-3">
            {pie}
          </footer>
        )}
      </div>
    </div>
  );
}

/** Botonera de un formulario escrito dentro del cuerpo de un modal: queda fija al pie de la ventana mientras se desplaza el contenido. */
export function AccionesForm({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('sticky bottom-0 z-10 -mx-4 -mb-4 flex flex-col-reverse gap-2 border-t border-borde bg-superficie-2 px-4 py-3 max-sm:[&>button]:w-full sm:-mx-5 sm:-mb-4 sm:flex-row sm:justify-end sm:px-5', className)}>
      {children}
    </div>
  );
}

// ───────────── Pestañas ─────────────
/** Pestañas como control segmentado: se reparten en varias filas si no caben (nunca obligan a desplazarse en horizontal). */
export function Pestanas<K extends string>({ items, activo, onCambio }: { items: Array<{ clave: K; titulo: ReactNode; contador?: number }>; activo: K; onCambio: (k: K) => void }) {
  return (
    <div role="tablist" className="mb-4 flex w-fit max-w-full flex-wrap gap-1 rounded-card bg-slate-200/70 p-1">
      {items.map((i) => (
        <button
          key={i.clave}
          type="button"
          role="tab"
          aria-selected={activo === i.clave}
          onClick={() => onCambio(i.clave)}
          className={cn(
            'flex items-center gap-1.5 rounded-ctl px-3 py-1.5 text-sm font-medium transition-colors',
            activo === i.clave ? 'bg-white text-marca-800 shadow-card' : 'text-slate-600 hover:bg-white/60 hover:text-texto',
          )}
        >
          {i.titulo}
          {i.contador != null && <span className={cn('rounded-full px-1.5 text-xs', activo === i.clave ? 'bg-marca-100 text-marca-800' : 'bg-white/80 text-slate-600')}>{i.contador}</span>}
        </button>
      ))}
    </div>
  );
}

/** Control segmentado de dos o tres opciones excluyentes (por ejemplo, Tablero / Lista). */
export function Segmentado<K extends string>({ items, activo, onCambio }: { items: Array<{ clave: K; titulo: ReactNode; icono?: ReactNode }>; activo: K; onCambio: (k: K) => void }) {
  return (
    <div role="group" className="flex rounded-ctl border border-borde-fuerte bg-white p-0.5">
      {items.map((i) => (
        <button key={i.clave} type="button" aria-pressed={activo === i.clave} onClick={() => onCambio(i.clave)} className={cn('flex items-center gap-1.5 rounded-[0.35rem] px-2.5 py-1.5 text-sm font-medium transition-colors', activo === i.clave ? 'bg-marca-50 text-marca-800' : 'text-tenue hover:text-texto')}>
          {i.icono}
          {i.titulo}
        </button>
      ))}
    </div>
  );
}

// ───────────── Notificaciones (toasts) ─────────────
interface Toast {
  id: number;
  tipo: 'ok' | 'error';
  texto: string;
}
const ToastCtx = createContext<{ ok: (t: string) => void; error: (e: unknown) => void }>(null!);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const quitar = (id: number) => setItems((x) => x.filter((t) => t.id !== id));
  const agregar = useCallback((tipo: Toast['tipo'], texto: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-3), { id, tipo, texto }]);
    setTimeout(() => quitar(id), tipo === 'error' ? 6000 : 3000);
  }, []);
  const ok = useCallback((t: string) => agregar('ok', t), [agregar]);
  const error = useCallback((e: unknown) => agregar('error', e instanceof ApiError || e instanceof Error ? e.message : String(e)), [agregar]);
  return (
    <ToastCtx.Provider value={{ ok, error }}>
      {children}
      <div className="no-print pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 md:bottom-6 md:items-end md:pr-6" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cn('pointer-events-auto flex max-w-md items-start gap-2 rounded-card px-4 py-3 text-sm text-white shadow-pop', t.tipo === 'ok' ? 'bg-petroleo-900' : 'bg-peligro-600')}>
            {t.tipo === 'ok' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
            <span className="min-w-0">{t.texto}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ───────────── Confirmación ─────────────
export function useConfirmar() {
  const [estado, setEstado] = useState<{ titulo: string; texto: ReactNode; peligro?: boolean; resolver: (v: boolean) => void } | null>(null);
  const confirmar = (titulo: string, texto: ReactNode, peligro = false) => new Promise<boolean>((resolver) => setEstado({ titulo, texto, peligro, resolver }));
  const cerrar = (v: boolean) => {
    estado?.resolver(v);
    setEstado(null);
  };
  const dialogo = (
    <Modal
      abierto={!!estado}
      onCerrar={() => cerrar(false)}
      titulo={estado?.titulo}
      ancho="sm"
      pie={
        <>
          <Boton onClick={() => cerrar(false)}>Cancelar</Boton>
          <Boton variante={estado?.peligro ? 'peligro' : 'primario'} onClick={() => cerrar(true)}>Confirmar</Boton>
        </>
      }
    >
      <div className="text-sm text-slate-600">{estado?.texto}</div>
    </Modal>
  );
  return { confirmar, dialogo };
}

export function Dato({ etiqueta, children, className }: { etiqueta: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-xs font-medium text-tenue">{etiqueta}</dt>
      <dd className="mt-0.5 break-words text-sm text-texto">{children || '—'}</dd>
    </div>
  );
}
