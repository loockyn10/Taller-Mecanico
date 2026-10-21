// Reloj compartido: pantalla para una tablet o computadora fija del taller. NO usa el menú ni la sesión del sistema.
// Se autentica con el token del dispositivo (cookie HttpOnly) y solo puede consultar el personal y registrar entradas y salidas.
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Delete, LogIn, LogOut, ShieldAlert, UserRound } from 'lucide-react';
import { cn } from '@/components/ui';

const CLAVE_MODO = 'fierro.modo_reloj';
export const modoReloj = (): boolean => { try { return localStorage.getItem(CLAVE_MODO) === '1'; } catch { return false; } };
const fijarModo = (v: boolean) => { try { v ? localStorage.setItem(CLAVE_MODO, '1') : localStorage.removeItem(CLAVE_MODO); } catch { /* sin almacenamiento */ } };

interface Persona { id: string; nombre: string; dentro: boolean }
interface Estado { taller: string; dispositivo: string; zona: string; ahora: string; personal: Persona[] }
class ErrorReloj extends Error { constructor(public status: number, public codigo: string, mensaje: string) { super(mensaje); } }

async function rq<T>(metodo: 'GET' | 'POST', ruta: string, datos?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`/api/reloj${ruta}`, { method: metodo, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: datos === undefined ? undefined : JSON.stringify(datos) });
  } catch {
    throw new ErrorReloj(0, 'sin_conexion', 'Sin conexión con el servidor');
  }
  const txt = await r.text();
  const cuerpo = txt ? JSON.parse(txt) : null;
  if (!r.ok) throw new ErrorReloj(r.status, cuerpo?.error?.code ?? 'error', cuerpo?.error?.message ?? `Error ${r.status}`);
  return cuerpo as T;
}

const INACTIVIDAD_MS = 30_000;
const VUELTA_MS = 4_000;

export function Reloj() {
  const [estado, setEstado] = useState<Estado | null>(null);
  const [falla, setFalla] = useState<{ codigo: string; mensaje: string } | null>(null);
  const [desfase, setDesfase] = useState(0);
  const [, tick] = useState(0);
  const [sel, setSel] = useState<Persona | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [listo, setListo] = useState<{ accion: string; nombre: string; hora: string; duracion?: number | null } | null>(null);
  const ultimo = useRef(Date.now());

  const cargar = useCallback(async () => {
    try {
      const e = await rq<Estado>('GET', '/estado');
      setEstado(e);
      setDesfase(Date.parse(e.ahora) - Date.now());
      setFalla(null);
      fijarModo(true);
    } catch (e) {
      if (e instanceof ErrorReloj && e.status === 0) return; // sin conexión: se conserva lo que ya hay en pantalla
      if (e instanceof ErrorReloj) setFalla({ codigo: e.codigo, mensaje: e.message });
    }
  }, []);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('salir') === '1') { fijarModo(false); window.location.replace('/'); return; }
    cargar();
  }, [cargar]);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  // Actualiza quién está dentro cada tanto, solo en la pantalla de inicio.
  useEffect(() => {
    if (sel || listo) return;
    const t = setInterval(cargar, 30_000);
    return () => clearInterval(t);
  }, [sel, listo, cargar]);

  const volver = useCallback(() => { setSel(null); setPin(''); setError(null); setListo(null); cargar(); }, [cargar]);
  // Vuelve sola al inicio tras un fichaje o por inactividad (el PIN no queda a la vista).
  useEffect(() => {
    if (!listo) return;
    const t = setTimeout(volver, VUELTA_MS);
    return () => clearTimeout(t);
  }, [listo, volver]);
  useEffect(() => {
    if (!sel || listo) return;
    ultimo.current = Date.now();
    const t = setInterval(() => { if (Date.now() - ultimo.current > INACTIVIDAD_MS) volver(); }, 2000);
    return () => clearInterval(t);
  }, [sel, listo, volver, pin]);

  const accion = sel?.dentro ? 'salida' : 'entrada';
  const confirmar = useCallback(async () => {
    if (!sel || pin.length < 4 || enviando) return;
    setEnviando(true);
    setError(null);
    try {
      const r = await rq<{ accion: string; empleado: string; hora: string; duracion_seg: number | null }>('POST', '/fichar', { usuario_id: sel.id, pin, accion });
      setListo({ accion: r.accion, nombre: r.empleado, hora: r.hora, duracion: r.duracion_seg });
      setPin('');
    } catch (e) {
      setPin('');
      if (e instanceof ErrorReloj && ['dispositivo_revocado', 'dispositivo_no_activado', 'reloj_desactivado'].includes(e.codigo)) { setSel(null); setFalla({ codigo: e.codigo, mensaje: e.message }); }
      else setError(e instanceof Error ? e.message : 'No se pudo registrar');
      if (e instanceof ErrorReloj && e.codigo === 'jornada_abierta') cargar();
    } finally {
      setEnviando(false);
    }
  }, [sel, pin, enviando, accion, cargar]);

  // Teclado físico
  useEffect(() => {
    if (!sel || listo) return;
    const h = (e: KeyboardEvent) => {
      ultimo.current = Date.now();
      if (/^\d$/.test(e.key)) setPin((p) => (p.length < 8 ? p + e.key : p));
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
      else if (e.key === 'Enter') confirmar();
      else if (e.key === 'Escape') volver();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [sel, listo, confirmar, volver]);

  if (falla && ['dispositivo_no_activado', 'dispositivo_revocado'].includes(falla.codigo)) return <Activar aviso={falla.codigo === 'dispositivo_revocado' ? falla.mensaje : null} onListo={cargar} />;
  if (falla?.codigo === 'reloj_desactivado') return <Pantalla><Mensaje icono={<ShieldAlert className="size-12 text-amber-500" />} titulo="Reloj desactivado" texto="El propietario del taller desactivó el modo reloj. Avisale para volver a activarlo." /></Pantalla>;
  if (!estado) return <Pantalla><p className="text-slate-400">Cargando…</p></Pantalla>;

  const ahora = new Date(Date.now() + desfase);
  const hora = new Intl.DateTimeFormat('es-AR', { timeZone: estado.zona, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ahora);
  const fecha = new Intl.DateTimeFormat('es-AR', { timeZone: estado.zona, weekday: 'long', day: 'numeric', month: 'long' }).format(ahora);

  if (listo) {
    return (
      <Pantalla>
        <div className="text-center">
          <CheckCircle2 className={cn('mx-auto size-24', listo.accion === 'entrada' ? 'text-emerald-400' : 'text-sky-400')} />
          <p className="mt-4 text-4xl font-bold">{listo.accion === 'entrada' ? '¡Bienvenido/a!' : '¡Hasta mañana!'}</p>
          <p className="mt-2 text-2xl">{listo.nombre}</p>
          <p className="mt-1 text-xl text-slate-300">{listo.accion === 'entrada' ? 'Entrada' : 'Salida'} registrada a las {listo.hora}</p>
          {listo.accion === 'salida' && listo.duracion != null && <p className="mt-1 text-slate-400">Jornada: {Math.floor(listo.duracion / 3600)} h {String(Math.floor((listo.duracion % 3600) / 60)).padStart(2, '0')} min</p>}
        </div>
      </Pantalla>
    );
  }

  if (sel) {
    return (
      <Pantalla>
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-4 text-center">
            <p className="text-sm text-slate-400">{sel.dentro ? 'Registrar salida' : 'Registrar entrada'}</p>
            <p className="text-2xl font-bold">{sel.nombre}</p>
          </div>
          <div className="mb-3 flex h-12 items-center justify-center gap-3" aria-label="PIN ingresado">
            {Array.from({ length: Math.max(4, pin.length) }).map((_, i) => <span key={i} className={cn('size-4 rounded-full border-2', i < pin.length ? 'border-white bg-white' : 'border-slate-500')} />)}
          </div>
          <p className={cn('mb-3 min-h-6 text-center text-sm', error ? 'text-red-400' : 'text-transparent')} role="alert">{error ?? '.'}</p>
          <div className="grid grid-cols-3 gap-3">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((n) => <Tecla key={n} onClick={() => { ultimo.current = Date.now(); setPin((p) => (p.length < 8 ? p + n : p)); }}>{n}</Tecla>)}
            <Tecla onClick={volver} suave aria-label="Cancelar">Cancelar</Tecla>
            <Tecla onClick={() => { ultimo.current = Date.now(); setPin((p) => (p.length < 8 ? `${p}0` : p)); }}>0</Tecla>
            <Tecla onClick={() => setPin((p) => p.slice(0, -1))} suave aria-label="Borrar"><Delete className="mx-auto size-7" /></Tecla>
          </div>
          <button
            type="button" onClick={confirmar} disabled={pin.length < 4 || enviando}
            className={cn('mt-4 flex h-16 w-full items-center justify-center gap-3 rounded-2xl text-xl font-bold transition disabled:opacity-40', sel.dentro ? 'bg-sky-600 active:bg-sky-700' : 'bg-emerald-600 active:bg-emerald-700')}
          >
            {sel.dentro ? <LogOut className="size-6" /> : <LogIn className="size-6" />}
            {enviando ? 'Registrando…' : sel.dentro ? 'Registrar salida' : 'Registrar entrada'}
          </button>
        </div>
      </Pantalla>
    );
  }

  return (
    <Pantalla>
      <div className="mx-auto w-full max-w-4xl">
        <header className="mb-6 text-center">
          <p className="text-sm uppercase tracking-widest text-slate-400">{estado.taller}</p>
          <p className="text-7xl font-bold tabular-nums">{hora}</p>
          <p className="text-lg capitalize text-slate-300">{fecha}</p>
        </header>
        <p className="mb-3 text-center text-slate-300">Tocá tu nombre para fichar</p>
        {estado.personal.length === 0 ? (
          <p className="text-center text-slate-400">Todavía no hay personal con PIN. El propietario puede asignarlos desde “Equipo y permisos”.</p>
        ) : (
          <ul className="flex flex-wrap justify-center gap-3">
            {estado.personal.map((p) => (
              <li key={p.id} className="w-[calc(50%-0.375rem)] sm:w-44">
                <button type="button" onClick={() => { setSel(p); setPin(''); setError(null); }} className="flex h-24 w-full flex-col items-center justify-center gap-1 rounded-2xl bg-slate-800 px-2 text-center ring-1 ring-slate-700 transition active:scale-[0.98] active:bg-slate-700">
                  <UserRound className="size-6 text-slate-400" />
                  <span className="line-clamp-2 text-base font-semibold leading-tight">{p.nombre}</span>
                  <span className={cn('text-xs font-medium', p.dentro ? 'text-emerald-400' : 'text-slate-500')}>{p.dentro ? '● Adentro' : 'Afuera'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Pantalla>
  );
}

function Pantalla({ children }: { children: React.ReactNode }) {
  return <main className="flex min-h-dvh w-full select-none flex-col justify-center bg-slate-900 px-4 py-8 text-white">{children}</main>;
}
function Mensaje({ icono, titulo, texto }: { icono: React.ReactNode; titulo: string; texto: string }) {
  return <div className="mx-auto max-w-md text-center"><div className="mb-3 flex justify-center">{icono}</div><p className="text-2xl font-bold">{titulo}</p><p className="mt-2 text-slate-300">{texto}</p></div>;
}
function Tecla({ children, onClick, suave, ...p }: { children: React.ReactNode; onClick: () => void; suave?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" onClick={onClick} className={cn('h-16 rounded-2xl text-2xl font-semibold ring-1 transition active:scale-95', suave ? 'bg-transparent text-base text-slate-300 ring-slate-700 active:bg-slate-800' : 'bg-slate-800 ring-slate-700 active:bg-slate-700')} {...p}>{children}</button>;
}

function Activar({ aviso, onListo }: { aviso: string | null; onListo: () => void }) {
  const [codigo, setCodigo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const enviar = async () => {
    setCargando(true);
    setError(null);
    try {
      await rq('POST', '/activar', { codigo });
      fijarModo(true);
      onListo();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo activar');
    } finally {
      setCargando(false);
    }
  };
  return (
    <Pantalla>
      <form className="mx-auto w-full max-w-sm space-y-4 text-center" onSubmit={(e) => { e.preventDefault(); enviar(); }}>
        <p className="text-2xl font-bold">Activar reloj</p>
        <p className="text-slate-300">Ingresá el código que generó el propietario en <em>Personal → Reloj compartido</em>.</p>
        {aviso && <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-300">{aviso}</p>}
        <input
          value={codigo} onChange={(e) => setCodigo(e.target.value.toUpperCase())} autoFocus autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={9} placeholder="XXXX-XXXX"
          className="h-14 w-full rounded-xl bg-slate-800 text-center text-2xl font-bold tracking-[0.25em] text-white outline-none ring-1 ring-slate-600 focus:ring-2 focus:ring-sky-500"
        />
        {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
        <button type="submit" disabled={codigo.replace(/\W/g, '').length < 8 || cargando} className="h-14 w-full rounded-xl bg-sky-600 text-lg font-bold disabled:opacity-40">{cargando ? 'Activando…' : 'Activar'}</button>
      </form>
    </Pantalla>
  );
}
