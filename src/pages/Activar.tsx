import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, ShieldCheck, Wrench } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Aviso, Boton, Campo, Cargando, Input } from '@/components/ui';
import { MarcaProducto } from '@/components/Marca';

/** El token viaja en el fragmento (#) del enlace: no se envía al servidor al abrir la página ni queda en registros o en el Referer. */
function tokenDelEnlace(): string {
  const h = window.location.hash.replace(/^#/, '');
  return new URLSearchParams(h.includes('=') ? h : `t=${h}`).get('t') ?? '';
}

export function Activar() {
  const { recargar } = useAuth();
  const nav = useNavigate();
  const [token] = useState(tokenDelEnlace);
  const [info, setInfo] = useState<{ nombre_sugerido: string | null; email: string | null; vence_at: string } | null>(null);
  const [problema, setProblema] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [f, setF] = useState({ taller: '', telefono: '', nombre: '', email: '', password: '', repetir: '' });
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    // Se saca el token de la barra de direcciones: no queda en el historial ni se comparte sin querer.
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
    if (!token) {
      setProblema('Este enlace está incompleto. Abrilo tal como te lo enviaron.');
      setCargando(false);
      return;
    }
    api
      .post('/activacion/consultar', { token })
      .then((r) => {
        setInfo(r);
        setF((x) => ({ ...x, taller: r.nombre_sugerido ?? '', email: r.email ?? '' }));
      })
      .catch((e) => setProblema(e instanceof Error ? e.message : 'No se pudo comprobar el enlace'))
      .finally(() => setCargando(false));
  }, [token]);

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (f.password.length < 8) return setError('La contraseña debe tener al menos 8 caracteres');
    if (f.password !== f.repetir) return setError('Las contraseñas no coinciden');
    setEnviando(true);
    try {
      await api.post('/activacion/completar', { token, propietario: { nombre: f.nombre, email: f.email, password: f.password }, taller: { nombre: f.taller, telefono: f.telefono || null } });
      await recargar();
      nav('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'No se pudo activar el taller');
      if (err instanceof ApiError && err.code === 'enlace_invalido') setProblema(err.message);
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="grid min-h-full lg:grid-cols-2">
      <div className="hidden flex-col justify-between bg-petroleo-900 p-10 text-white lg:flex">
        <MarcaProducto oscuro ancho="w-72" />
        <div className="max-w-md">
          <h1 className="text-3xl font-bold leading-tight">Bienvenido a ORVELAN Taller Mecánico.</h1>
          <p className="mt-3 text-petroleo-200">En unos minutos tu taller queda listo para trabajar: creás tu acceso, completás los datos del negocio y te acompañamos con la configuración inicial.</p>
          <ul className="mt-6 space-y-2 text-sm text-petroleo-200">
            {['Creás tu contraseña', 'Cargás los datos de tu taller', 'Configurás servicios y precios a tu ritmo', 'Importás tus clientes y repuestos desde Excel'].map((t) => (
              <li key={t} className="flex items-center gap-2"><CheckCircle2 className="size-4 shrink-0" />{t}</li>
            ))}
          </ul>
        </div>
        <p className="flex items-center gap-2 text-sm text-petroleo-300"><Wrench className="size-4" /> Hecho para talleres mecánicos</p>
      </div>
      <div className="flex items-center justify-center p-4 sm:p-6">
        {cargando ? (
          <Cargando texto="Comprobando tu invitación…" />
        ) : problema || !info ? (
          <div className="w-full max-w-sm space-y-4 rounded-card border border-borde bg-white p-5 shadow-card sm:p-7">
            <MarcaProducto />
            <h2 className="text-2xl font-bold">No pudimos abrir tu invitación</h2>
            <Aviso tono="ambar">{problema ?? 'El enlace no es válido.'}</Aviso>
            <Boton onClick={() => nav('/', { replace: true })}>Ir al ingreso</Boton>
          </div>
        ) : (
          <form className="w-full max-w-sm space-y-4 rounded-card border border-borde bg-white p-5 shadow-card sm:p-7" onSubmit={enviar}>
            <div>
              <MarcaProducto className="mb-4 lg:hidden" />
              <h2 className="text-2xl font-bold">Activá tu taller</h2>
              <p className="mt-1 text-sm text-tenue">Este enlace sirve una sola vez y vence el {new Date(info.vence_at).toLocaleDateString('es-AR', { day: 'numeric', month: 'long' })}.</p>
            </div>
            <Campo label="Nombre del taller" requerido><Input value={f.taller} onChange={set('taller')} required minLength={2} autoFocus /></Campo>
            <Campo label="Teléfono / WhatsApp"><Input value={f.telefono} onChange={set('telefono')} inputMode="tel" /></Campo>
            <hr className="border-borde" />
            <Campo label="Tu nombre y apellido" requerido><Input value={f.nombre} onChange={set('nombre')} required minLength={2} autoComplete="name" /></Campo>
            <Campo label="Tu correo (es tu usuario para ingresar)" requerido hint={info.email ? 'La invitación es para este correo.' : undefined}>
              <Input type="email" value={f.email} onChange={set('email')} required autoComplete="username" readOnly={!!info.email} />
            </Campo>
            <Campo label="Contraseña" requerido hint="Al menos 8 caracteres."><Input type="password" value={f.password} onChange={set('password')} required autoComplete="new-password" minLength={8} /></Campo>
            <Campo label="Repetir contraseña" requerido><Input type="password" value={f.repetir} onChange={set('repetir')} required autoComplete="new-password" /></Campo>
            {error && <p className="rounded-ctl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            <Boton type="submit" variante="primario" tam="lg" className="w-full" cargando={enviando}>Activar mi taller</Boton>
            <p className="flex items-center justify-center gap-1.5 text-center text-xs text-tenue"><ShieldCheck className="size-3.5" /> Tus datos son solo de tu taller: ningún otro negocio puede verlos.</p>
          </form>
        )}
      </div>
    </div>
  );
}
