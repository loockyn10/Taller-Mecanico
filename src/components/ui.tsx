// Kit de componentes compartidos: toda la aplicación usa estas piezas para mantener un diseño consistente.
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { AlertTriangle, ArrowLeft, CheckCircle2, Info, Loader2, Search, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '@/lib/api';

export const cn = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

// ───────────── Botones ─────────────
type Variante = 'primario' | 'secundario' | 'fantasma' | 'peligro' | 'exito';
const VARIANTES: Record<Variante, string> = {
  primario: 'bg-marca-600 text-white hover:bg-marca-700 shadow-sm',
  secundario: 'bg-white text-texto border border-borde hover:bg-slate-50 shadow-sm',
  fantasma: 'text-tenue hover:bg-slate-100 hover:text-texto',
  peligro: 'bg-red-600 text-white hover:bg-red-700 shadow-sm',
  exito: 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm',
};

export interface BotonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variante?: Variante;
  tam?: 'sm' | 'md' | 'lg';
  icono?: ReactNode;
  cargando?: boolean;
}

export const Boton = forwardRef<HTMLButtonElement, BotonProps>(function Boton({ variante = 'secundario', tam = 'md', icono, cargando, className, children, disabled, ...p }, ref) {
  const tams = { sm: 'h-8 px-2.5 text-[13px] gap-1.5', md: 'h-10 px-3.5 text-sm gap-2', lg: 'h-12 px-5 text-base gap-2' };
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || cargando}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-lg font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-marca-500 disabled:cursor-not-allowed disabled:opacity-50',
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

// ───────────── Formularios ─────────────
/** Ancho completo salvo que el llamador indique un ancho propio (w-auto, w-40…). */
const ancho = (className?: string) => (className && /(^|\s)(sm:|md:)?w-/.test(className) ? '' : 'w-full');
const BASE_INPUT =
  'rounded-lg border border-borde bg-white px-3 text-sm text-texto placeholder:text-slate-400 focus:border-marca-500 focus:outline-none focus:ring-2 focus:ring-marca-100 disabled:bg-slate-50 disabled:text-tenue';

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
    <label className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <span className="text-[13px] font-medium text-texto">
          {label}
          {requerido && <span className="ml-0.5 text-red-600">*</span>}
        </span>
      )}
      {children}
      {error ? <span className="text-xs text-red-600">{error}</span> : hint ? <span className="text-xs text-tenue">{hint}</span> : null}
    </label>
  );
}

export function Check({ checked, onChange, label, className }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; className?: string }) {
  return (
    <label className={cn('inline-flex cursor-pointer select-none items-center gap-2 text-sm', className)}>
      <input type="checkbox" className="size-4 rounded border-borde accent-marca-600" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** Chip seleccionable (para listas de casillas del check-list, filtros, etc.). */
export function Chip({ activo, onClick, children, tono = 'marca' }: { activo: boolean; onClick: () => void; children: ReactNode; tono?: 'marca' | 'peligro' }) {
  const on = tono === 'peligro' ? 'border-red-300 bg-red-50 text-red-700' : 'border-marca-300 bg-marca-50 text-marca-700';
  return (
    <button type="button" onClick={onClick} className={cn('rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors', activo ? on : 'border-borde bg-white text-tenue hover:bg-slate-50')}>
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
    <div className={cn('relative', className)}>
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

export function Buscador({ value, onChange, placeholder = 'Buscar…', className, autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; autoFocus?: boolean }) {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="pl-9" autoFocus={autoFocus} />
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
    <section className={cn('rounded-xl border border-borde bg-superficie shadow-[0_1px_2px_rgba(16,24,40,0.04)]', className)}>
      {(titulo || acciones) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-borde px-4 py-3">
          <div>
            {titulo && <h2 className="text-[15px] font-semibold">{titulo}</h2>}
            {subtitulo && <p className="text-xs text-tenue">{subtitulo}</p>}
          </div>
          {acciones && <div className="flex flex-wrap items-center gap-2">{acciones}</div>}
        </header>
      )}
      <div className={sinPadding ? '' : 'p-4'}>{children}</div>
    </section>
  );
}

export function Encabezado({ titulo, subtitulo, acciones, volver }: { titulo: ReactNode; subtitulo?: ReactNode; acciones?: ReactNode; volver?: string | boolean }) {
  const nav = useNavigate();
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2">
        {volver && (
          <Boton variante="fantasma" tam="sm" className="mt-0.5 -ml-2" icono={<ArrowLeft className="size-4" />} onClick={() => (typeof volver === 'string' ? nav(volver) : nav(-1))} aria-label="Volver" />
        )}
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold tracking-tight sm:text-2xl">{titulo}</h1>
          {subtitulo && <p className="mt-0.5 text-sm text-tenue">{subtitulo}</p>}
        </div>
      </div>
      {acciones && <div className="flex flex-wrap items-center gap-2">{acciones}</div>}
    </div>
  );
}

const TONOS = {
  gris: 'bg-slate-100 text-slate-700 ring-slate-200',
  azul: 'bg-marca-50 text-marca-700 ring-marca-200',
  verde: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  ambar: 'bg-amber-50 text-amber-800 ring-amber-200',
  rojo: 'bg-red-50 text-red-700 ring-red-200',
  violeta: 'bg-violet-50 text-violet-700 ring-violet-200',
  cian: 'bg-cyan-50 text-cyan-800 ring-cyan-200',
} as const;
export type Tono = keyof typeof TONOS;

export function Insignia({ tono = 'gris', children, className }: { tono?: Tono; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', TONOS[tono], className)}>{children}</span>;
}

export function Indicador({ titulo, valor, detalle, icono, tono = 'azul', onClick }: { titulo: string; valor: ReactNode; detalle?: ReactNode; icono?: ReactNode; tono?: Tono; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="flex w-full items-start gap-3 rounded-xl border border-borde bg-white p-4 text-left shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition enabled:hover:border-marca-200 enabled:hover:shadow-sm"
    >
      {icono && <span className={cn('hidden size-10 shrink-0 place-items-center rounded-lg ring-1 ring-inset xl:grid', TONOS[tono])}>{icono}</span>}
      <span className="min-w-0">
        <span className="block text-xs font-medium uppercase tracking-wide text-tenue">{titulo}</span>
        {/* Los importes no se parten en dos líneas: se achican en pantallas angostas (hallazgo de la auditoría). */}
        <span className="block whitespace-nowrap text-[17px] font-bold leading-tight tabular-nums xl:text-xl">{valor}</span>
        {detalle && <span className="block text-xs text-tenue">{detalle}</span>}
      </span>
    </button>
  );
}

export function Vacio({ icono, titulo, texto, accion }: { icono?: ReactNode; titulo: string; texto?: ReactNode; accion?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
      {icono && <div className="mb-3 grid size-12 place-items-center rounded-full bg-slate-100 text-slate-500">{icono}</div>}
      <p className="font-medium">{titulo}</p>
      {texto && <p className="mt-1 max-w-sm text-sm text-tenue">{texto}</p>}
      {accion && <div className="mt-4">{accion}</div>}
    </div>
  );
}

export function Cargando({ texto = 'Cargando…' }: { texto?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-tenue">
      <Loader2 className="size-4 animate-spin" /> {texto}
    </div>
  );
}

export function ErrorCaja({ error, reintentar }: { error: unknown; reintentar?: () => void }) {
  const msg = error instanceof Error ? error.message : 'Ocurrió un error';
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-6 text-center text-sm text-red-800">
      <AlertTriangle className="size-5" />
      <p>{msg}</p>
      {reintentar && <Boton tam="sm" onClick={reintentar}>Reintentar</Boton>}
    </div>
  );
}

export function Aviso({ tono = 'azul', children, className }: { tono?: 'azul' | 'ambar' | 'rojo' | 'verde'; children: ReactNode; className?: string }) {
  const t = { azul: 'border-marca-200 bg-marca-50 text-marca-800', ambar: 'border-amber-200 bg-amber-50 text-amber-900', rojo: 'border-red-200 bg-red-50 text-red-800', verde: 'border-emerald-200 bg-emerald-50 text-emerald-800' }[tono];
  return <div className={cn('flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm', t, className)}><Info className="mt-0.5 size-4 shrink-0" /><div>{children}</div></div>;
}

// ───────────── Tabla responsive ─────────────
export interface Columna<T> {
  clave: string;
  titulo: ReactNode;
  render: (fila: T) => ReactNode;
  className?: string;
  /** En móvil: 'titulo' y 'subtitulo' arman la cabecera de la tarjeta; 'meta' se muestra abajo; 'oculta' no se muestra. */
  movil?: 'titulo' | 'subtitulo' | 'derecha' | 'meta' | 'oculta';
  alinear?: 'derecha';
}

export function Tabla<T>({ columnas, filas, clave, onFila, vacio }: { columnas: Columna<T>[]; filas: T[]; clave: (f: T) => string; onFila?: (f: T) => void; vacio?: ReactNode }) {
  if (!filas.length) return <>{vacio ?? <Vacio titulo="Sin resultados" />}</>;
  const col = (m: Columna<T>['movil']) => columnas.filter((c) => c.movil === m);
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-borde bg-slate-50/70 text-left text-xs font-semibold uppercase tracking-wide text-tenue">
              {columnas.map((c) => (
                <th key={c.clave} className={cn('px-4 py-2.5', c.alinear === 'derecha' && 'text-right', c.className)}>{c.titulo}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={clave(f)} onClick={onFila ? () => onFila(f) : undefined} className={cn('border-b border-borde last:border-0', onFila && 'cursor-pointer hover:bg-marca-50/40')}>
                {columnas.map((c) => (
                  <td key={c.clave} className={cn('px-4 py-3 align-middle', c.alinear === 'derecha' && 'text-right tabular-nums', c.className)}>{c.render(f)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-borde md:hidden">
        {filas.map((f) => (
          <li key={clave(f)} onClick={onFila ? () => onFila(f) : undefined} className={cn('px-4 py-3', onFila && 'cursor-pointer active:bg-slate-50')}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {col('titulo').map((c) => <div key={c.clave} className="truncate font-medium">{c.render(f)}</div>)}
                {col('subtitulo').map((c) => <div key={c.clave} className="truncate text-sm text-tenue">{c.render(f)}</div>)}
              </div>
              <div className="shrink-0 text-right">{col('derecha').map((c) => <div key={c.clave} className="tabular-nums">{c.render(f)}</div>)}</div>
            </div>
            {col('meta').length > 0 && <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-tenue">{col('meta').map((c) => <span key={c.clave}>{c.render(f)}</span>)}</div>}
          </li>
        ))}
      </ul>
    </>
  );
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
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onCerrar()}>
      <div role="dialog" aria-modal="true" className={cn('flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl', w)}>
        <header className="flex items-center justify-between gap-2 border-b border-borde px-5 py-3.5">
          <h2 className="text-base font-semibold">{titulo}</h2>
          <Boton variante="fantasma" tam="sm" onClick={onCerrar} aria-label="Cerrar" icono={<X className="size-4" />} />
        </header>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {pie && <footer className="flex flex-wrap justify-end gap-2 border-t border-borde px-5 py-3">{pie}</footer>}
      </div>
    </div>
  );
}

// ───────────── Pestañas ─────────────
export function Pestanas<K extends string>({ items, activo, onCambio }: { items: Array<{ clave: K; titulo: ReactNode; contador?: number }>; activo: K; onCambio: (k: K) => void }) {
  return (
    <div className="-mx-1 mb-4 flex gap-1 overflow-x-auto border-b border-borde px-1">
      {items.map((i) => (
        <button
          key={i.clave}
          type="button"
          onClick={() => onCambio(i.clave)}
          className={cn('-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium', activo === i.clave ? 'border-marca-600 text-marca-700' : 'border-transparent text-tenue hover:text-texto')}
        >
          {i.titulo}
          {i.contador != null && <span className="rounded-full bg-slate-100 px-1.5 text-xs text-slate-600">{i.contador}</span>}
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
          <div key={t.id} className={cn('pointer-events-auto flex max-w-md items-start gap-2 rounded-xl px-4 py-3 text-sm text-white shadow-lg', t.tipo === 'ok' ? 'bg-slate-900' : 'bg-red-600')}>
            {t.tipo === 'ok' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
            <span>{t.texto}</span>
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
      <div className="text-sm text-tenue">{estado?.texto}</div>
    </Modal>
  );
  return { confirmar, dialogo };
}

export function Dato({ etiqueta, children, className }: { etiqueta: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <dt className="text-xs font-medium text-tenue">{etiqueta}</dt>
      <dd className="mt-0.5 text-sm">{children || '—'}</dd>
    </div>
  );
}
