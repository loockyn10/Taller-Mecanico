// Mi asistencia: la persona ficha su entrada y salida y consulta su jornada actual y sus fichajes anteriores.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogIn, LogOut } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { diaCorto, duracion, horaZona } from '@/lib/format';
import { Boton, Campo, Cargando, Encabezado, ErrorCaja, Input, Insignia, Tabla, Tarjeta, useToast } from '@/components/ui';

const ORIGEN: Record<string, string> = { app: 'Sistema', reloj: 'Reloj', manual: 'Manual' };

function useReloj(ahoraServidor?: string) {
  // Reloj local anclado a la hora del servidor (evita desfasajes si el equipo tiene la hora mal puesta).
  const [desfase, setDesfase] = useState(0);
  const [, tick] = useState(0);
  useEffect(() => { if (ahoraServidor) setDesfase(Date.parse(ahoraServidor) - Date.now()); }, [ahoraServidor]);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  return Date.now() + desfase;
}

export function Asistencia() {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['asistencia', 'mia'], queryFn: () => api.get('/asistencia/mia'), refetchInterval: 60_000 });
  const ahora = useReloj(data?.ahora);
  const accion = useMutation({
    mutationFn: (a: 'entrada' | 'salida') => api.post(`/asistencia/${a}`),
    onSuccess: (_r, a) => { qc.invalidateQueries({ queryKey: ['asistencia'] }); toast.ok(a === 'entrada' ? 'Entrada registrada' : 'Salida registrada'); },
    onError: (e) => { toast.error(e); qc.invalidateQueries({ queryKey: ['asistencia'] }); },
  });
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  const zona = data.zona as string;
  const ab = data.abierta;
  const transcurrido = ab ? Math.max(0, Math.floor((ahora - Date.parse(ab.entrada_at)) / 1000)) : 0;

  return (
    <>
      <Encabezado titulo="Mi asistencia" subtitulo={`Hora del taller: ${new Intl.DateTimeFormat('es-AR', { timeZone: zona, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ahora)}`} />
      <div className="grid gap-5 lg:grid-cols-3">
        <Tarjeta titulo="Jornada de hoy" className="lg:col-span-1">
          <div className="space-y-4 text-center">
            {ab ? (
              <>
                <Insignia tono="verde">Jornada abierta</Insignia>
                <p className="text-4xl font-bold tabular-nums">{duracion(transcurrido)}</p>
                <p className="text-sm text-tenue">Entraste a las {horaZona(ab.entrada_at, zona)}</p>
                <Boton variante="peligro" tam="lg" className="w-full" icono={<LogOut className="size-5" />} cargando={accion.isPending} onClick={() => accion.mutate('salida')}>Registrar salida</Boton>
              </>
            ) : (
              <>
                <Insignia>Fuera del taller</Insignia>
                <p className="text-sm text-tenue">Total de hoy: <strong>{duracion(data.horas_hoy_seg)}</strong></p>
                <Boton variante="exito" tam="lg" className="w-full" icono={<LogIn className="size-5" />} cargando={accion.isPending} onClick={() => accion.mutate('entrada')}>Registrar entrada</Boton>
              </>
            )}
            <p className="text-xs text-tenue">La hora la registra el servidor. Si olvidaste un fichaje, pedile a quien administra el personal que lo corrija.</p>
          </div>
        </Tarjeta>

        <Tarjeta titulo="Mis fichajes anteriores" subtitulo="Últimos 30 días" sinPadding className="lg:col-span-2">
          <Tabla
            filas={data.jornadas as any[]}
            clave={(j) => j.id}
            vacio={<p className="px-4 py-8 text-center text-sm text-tenue">Todavía no hay fichajes.</p>}
            columnas={[
              { clave: 'f', titulo: 'Día', render: (j) => <span className="font-medium capitalize">{diaCorto(j.fecha)}</span>, movil: 'titulo' },
              { clave: 'e', titulo: 'Entrada', render: (j) => horaZona(j.entrada_at, zona), movil: 'meta' },
              { clave: 's', titulo: 'Salida', render: (j) => (j.salida_at ? horaZona(j.salida_at, zona) : <Insignia tono="verde">En curso</Insignia>), movil: 'meta' },
              { clave: 'd', titulo: 'Duración', render: (j) => (j.salida_at ? duracion(j.duracion_seg) : '—'), movil: 'derecha' },
              { clave: 'o', titulo: 'Origen', render: (j) => <span className="text-tenue">{ORIGEN[j.origen_entrada] ?? j.origen_entrada}{j.corregido ? ' · corregido' : ''}</span>, movil: 'oculta' },
            ]}
          />
        </Tarjeta>
      </div>
      <MiPin tiene={!!me?.usuario.tiene_pin} />
    </>
  );
}

function MiPin({ tiene }: { tiene: boolean }) {
  const toast = useToast();
  const { recargar } = useAuth();
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const m = useMutation({
    mutationFn: () => api.put('/taller/mi-pin', { password, pin }),
    onSuccess: () => { toast.ok('PIN guardado'); setPassword(''); setPin(''); recargar(); },
    onError: toast.error,
  });
  return (
    <Tarjeta titulo="Mi PIN del reloj compartido" subtitulo={tiene ? 'Ya tenés un PIN. Podés cambiarlo cuando quieras.' : 'Elegí un PIN para fichar en la tablet del taller.'} className="mt-5 max-w-xl">
      <div className="grid gap-3 sm:grid-cols-2">
        <Campo label="Tu contraseña"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Campo>
        <Campo label="Nuevo PIN (4 a 8 dígitos)"><Input value={pin} inputMode="numeric" maxLength={8} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} autoComplete="off" /></Campo>
      </div>
      <div className="mt-3"><Boton variante="primario" disabled={!password || pin.length < 4} cargando={m.isPending} onClick={() => m.mutate()}>{tiene ? 'Cambiar PIN' : 'Guardar PIN'}</Boton></div>
    </Tarjeta>
  );
}
