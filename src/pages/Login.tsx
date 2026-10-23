import { useState } from 'react';
import { Wrench } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { Boton, Campo, Input } from '@/components/ui';

export function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  return (
    <div className="grid min-h-full lg:grid-cols-2">
      <div className="hidden flex-col justify-between bg-petroleo-900 p-10 text-white lg:flex">
        <div className="flex items-center gap-3">
          <img src="/icon.svg" alt="" className="size-10 rounded-card ring-2 ring-white/15" />
          <span className="text-xl font-extrabold">Fierro</span>
        </div>
        <div className="max-w-md">
          <h1 className="text-3xl font-bold leading-tight">El taller ordenado, de la recepción a la entrega.</h1>
          <p className="mt-3 text-petroleo-200">Órdenes de trabajo, presupuestos, agenda, historial por patente, stock y cobros en un solo lugar.</p>
        </div>
        <p className="flex items-center gap-2 text-sm text-petroleo-300"><Wrench className="size-4" /> Hecho para talleres mecánicos</p>
      </div>
      <div className="flex items-center justify-center p-4 sm:p-6">
        <form
          className="w-full max-w-sm space-y-5 rounded-card border border-borde bg-white p-5 shadow-card sm:p-7"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            setCargando(true);
            try {
              await login(email, password);
            } catch (err) {
              setError(err instanceof Error ? err.message : 'No se pudo iniciar sesión');
            } finally {
              setCargando(false);
            }
          }}
        >
          <div className="lg:hidden">
            <img src="/icon.svg" alt="" className="mb-4 size-12" />
          </div>
          <div>
            <h2 className="text-2xl font-bold">Ingresar</h2>
            <p className="mt-1 text-sm text-tenue">Usá el email y la contraseña de tu usuario del taller.</p>
          </div>
          <Campo label="Email">
            <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </Campo>
          <Campo label="Contraseña">
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Campo>
          {error && <p className="rounded-ctl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <Boton type="submit" variante="primario" tam="lg" className="w-full" cargando={cargando}>Ingresar</Boton>
          <p className="text-center text-xs text-tenue">¿Olvidaste tu contraseña? Pedile al propietario del taller que la restablezca.</p>
        </form>
      </div>
    </div>
  );
}
