// Estado de la contabilidad del taller: activación explícita y aviso de operaciones pendientes. Abrir las pantallas NUNCA contabiliza nada; la contabilidad se
// activa una vez (genera lo ya operado) y después se mantiene al día sola, después de cada operación, o con "Actualizar ahora".
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Power, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fechaHora } from '@/lib/format';
import { Aviso, Boton, Cargando, ErrorCaja, Tarjeta, useToast } from '@/components/ui';

export interface EstadoContab {
  activada: boolean;
  activada_at: string | null;
  sincronizando: boolean;
  repeticion_pedida: boolean;
  ultima_sincronizacion: string | null;
  ultimo_error: { mensaje: string; fecha: string | null } | null;
  asientos: number;
  cuentas: number;
  pendientes: number;
  anulaciones_pendientes: number;
  errores: number;
  sin_efecto: number;
  al_dia: boolean;
  /** Operaciones confirmadas que esperan su asiento (se reintentan solas) y las que agotaron los reintentos. */
  cola: { pendientes: number; fallidas: number; mas_antigua: string | null };
  /** Se está completando el recorrido de lo anterior a la activación (o una verificación completa). */
  reconciliando: boolean;
  por_origen: Array<{ tipo: string; etiqueta: string; documentos: number; contabilizados: number; sin_efecto: number; errores: number; pendientes: number }>;
}

export function useEstadoContabilidad() {
  return useQuery<EstadoContab>({
    queryKey: ['contab', 'estado'],
    queryFn: () => api.get('/contabilidad/estado'),
    // Mientras haya algo pendiente (la contabilización posterior a una operación corre en segundo plano) se vuelve a mirar sola.
    refetchInterval: (q) => (q.state.data && q.state.data.activada && !q.state.data.al_dia ? 8000 : false),
  });
}

/** Pide contabilizar lo pendiente y refresca todo lo contable. */
export function useActualizarContabilidad() {
  const toast = useToast();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reintentar?: boolean) => api.post('/contabilidad/sincronizar', { reintentar: !!reintentar }),
    onSuccess: (x: any) => {
      toast.ok(x.creados ? `Se contabilizaron ${x.creados} operación(es)${x.hayMas || x.reconciliando ? '. Quedan más: volvé a actualizar.' : ''}` : x.reconciliando ? 'Se avanzó con las operaciones anteriores: volvé a actualizar para continuar' : 'La contabilidad ya estaba al día');
      qc.invalidateQueries({ queryKey: ['contab'] });
    },
    onError: (e) => toast.error(e),
  });
}

/** Aviso sobre operaciones sin contabilizar. No aparece cuando todo está al día. */
export function AvisoSincronizacion({ estado }: { estado: EstadoContab }) {
  const { puede } = useAuth();
  const actualizar = useActualizarContabilidad();
  if (!estado.activada || estado.al_dia) return null;
  const falta = estado.pendientes + estado.anulaciones_pendientes;
  const agotadas = estado.cola?.fallidas ?? 0;
  return (
    <Aviso tono={estado.errores || estado.ultimo_error ? 'rojo' : 'ambar'} className="no-print mb-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          {estado.sincronizando
            ? 'Se están contabilizando operaciones nuevas…'
            : agotadas > 0
              ? `${agotadas} operación(es) no se pudieron contabilizar después de varios intentos. La operación comercial está registrada; usá «Reintentar» cuando se corrija la causa (ver Controles).`
              : estado.reconciliando
                ? 'Se está completando la contabilidad de las operaciones anteriores. Podés seguir trabajando; los totales se completan a medida que avanza.'
                : falta > 0
                  ? `${falta} operación(es) todavía no se contabilizaron. Los totales de abajo no las incluyen hasta que se actualice la contabilidad.`
                  : estado.errores > 0
                    ? `${estado.errores} operación(es) no se pudieron contabilizar porque sus importes no cierran (ver Controles).`
                    : 'La contabilidad se está actualizando.'}
          {estado.ultimo_error && <> Último error: {estado.ultimo_error.mensaje}.</>}
        </span>
        {puede('contabilidad.gestionar') && (
          <Boton tam="sm" icono={<RefreshCw className="size-4" />} cargando={actualizar.isPending} onClick={() => actualizar.mutate(agotadas > 0)}>
            {agotadas > 0 ? 'Reintentar' : estado.reconciliando ? 'Continuar' : 'Actualizar ahora'}
          </Boton>
        )}
      </div>
    </Aviso>
  );
}

/** Pantalla de activación: explica qué se va a generar, muestra la vista previa (sin escribir) y activa con un botón explícito. */
export function ActivarContabilidad({ estado }: { estado: EstadoContab }) {
  const { puede } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const activar = useMutation({
    mutationFn: async () => {
      let r = await api.post('/contabilidad/activar', {});
      // Si hay muchas operaciones se sigue en tandas hasta terminar.
      for (let i = 0; i < 25 && (r.hayMas || r.reconciliando); i++) r = await api.post('/contabilidad/sincronizar', {});
      return r;
    },
    onSuccess: (r: any) => {
      toast.ok(r.creados ? `Contabilidad activada: se contabilizaron ${r.creados} operación(es) anteriores` : 'Contabilidad activada');
      qc.invalidateQueries({ queryKey: ['contab'] });
    },
    onError: (e) => {
      toast.error(e);
      qc.invalidateQueries({ queryKey: ['contab'] });
    },
  });
  const total = estado.por_origen.reduce((a, o) => a + o.documentos, 0);
  return (
    <Tarjeta titulo="Activar la contabilidad de este taller" subtitulo="Se hace una sola vez y es seguro repetirlo: no duplica asientos ni modifica ningún comprobante.">
      <div className="space-y-4 text-sm">
        <p>
          Al activarla, Fierro crea el plan de cuentas y genera los asientos de partida doble de lo que ya se operó (con la fecha original de cada operación, marcados como históricos).
          Desde ese momento cada venta, cobro, compra, pago, gasto o movimiento de caja y banco se contabiliza solo.
        </p>
        <p className="text-tenue">Mirar las pantallas de Contabilidad no genera nada: hasta que la actives, estas pantallas están vacías.</p>
        {estado.por_origen.length > 0 ? (
          <div>
            <p className="mb-1.5 font-medium">Lo que se va a contabilizar ({total} documento{total === 1 ? '' : 's'}):</p>
            <ul className="grid gap-1 sm:grid-cols-2">
              {estado.por_origen.map((o) => (
                <li key={o.tipo} className="flex justify-between rounded-lg bg-slate-50 px-3 py-1.5">
                  <span>{o.etiqueta}</span>
                  <span className="tabular-nums text-tenue">{o.documentos}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-tenue">Todavía no hay operaciones para contabilizar: se irán contabilizando a medida que se carguen.</p>
        )}
        {puede('contabilidad.gestionar') ? (
          <Boton variante="primario" icono={<Power className="size-4" />} cargando={activar.isPending} onClick={() => activar.mutate()}>
            Activar la contabilidad y contabilizar lo ya operado
          </Boton>
        ) : (
          <Aviso>La contabilidad todavía no está activada. Pedile a quien gestiona la contabilidad del taller (propietario o administrador) que la active.</Aviso>
        )}
        {estado.ultima_sincronizacion && <p className="text-xs text-tenue">Última actualización: {fechaHora(estado.ultima_sincronizacion)}</p>}
      </div>
    </Tarjeta>
  );
}

/** Envoltorio para pantallas que dependen del estado: muestra la carga o el error y entrega el estado. */
export function ConEstado({ children }: { children: (e: EstadoContab) => React.ReactNode }) {
  const { data, isLoading, error, refetch } = useEstadoContabilidad();
  if (isLoading) return <Cargando />;
  if (error || !data) return <ErrorCaja error={error} reintentar={refetch} />;
  return <>{children(data)}</>;
}
