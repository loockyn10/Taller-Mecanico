// "Seguimiento del cliente" en el detalle de la OT: el enlace público se activa solo al crear la orden; acá se copia, se muestra el QR, se publican mensajes
// para el cliente y elegir qué se muestra. El estado de la orden NO se cambia acá: se sigue cambiando donde siempre y la página pública lo refleja sola.
import { lazy, Suspense, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink, Link2, MessageCircle, QrCode, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fecha, fechaHora, whatsapp } from '@/lib/format';
import { Aviso, Boton, Cargando, Check, ErrorCaja, Insignia, Input, Tarjeta, Textarea, useConfirmar, useToast, type Tono } from '@/components/ui';
import { MENSAJE_MAX } from '@shared/seguimiento';
import { mensajeOrdenWhatsApp } from '@shared/mensaje-ingreso';

const QrEnlace = lazy(() => import('@/components/QrEnlace'));

interface Mensaje { id: string; texto: string; creado_at: string; usuario: string | null; retirado_at: string | null; retirado_por: string | null; vigente: boolean }
interface Transicion { id: string; estado: string; titulo: string; at: string; visible: boolean; es_actual: boolean }
export interface EstadoSeguimiento {
  existe: boolean;
  activo: boolean;
  url: string | null;
  mostrar_fecha_estimada: boolean;
  activado_at: string | null;
  desactivado_at: string | null;
  estado: { clave: string; titulo: string; explicacion: string; tono: string };
  fecha_prometida: string | null;
  entrega: { fecha: string; vencida: boolean } | null;
  mensajes: Mensaje[];
  transiciones: Transicion[];
}

const TONO: Record<string, Tono> = { info: 'azul', trabajo: 'azul', espera: 'ambar', listo: 'verde', cerrado: 'verde', cancelado: 'rojo' };

/** Estado del seguimiento de una orden (se vuelve a leer cuando cambia el estado de la OT: la clave empieza con ['orden', id]). */
export function useSeguimiento(ordenId: string, habilitado = true) {
  return useQuery({ queryKey: ['orden', ordenId, 'seguimiento'], queryFn: () => api.get<EstadoSeguimiento>(`/ordenes/${ordenId}/seguimiento`), enabled: habilitado });
}

interface OrdenWhatsApp {
  id: string;
  numero: number;
  estado: string;
  patente: string;
  marca?: string | null;
  modelo?: string | null;
  cliente?: string | null;
  cliente_telefono?: string | null;
}

/**
 * ÚNICA acción de WhatsApp de la orden: abre WhatsApp con el mensaje armado con los datos reales de la OT y el enlace de seguimiento. No envía nada solo.
 * El teléfono del cliente sólo llega si la persona puede consultar clientes; sin él, WhatsApp pide elegir el contacto. Sin enlace disponible
 * (seguimiento desactivado o sin permiso para compartirlo) el mensaje sale sin esa parte, nunca con un enlace que no funciona.
 */
export function BotonWhatsAppOrden({ orden, tam, variante }: { orden: OrdenWhatsApp; tam?: 'sm'; variante?: 'primario' }) {
  const { puede, me } = useAuth();
  const { data: s, isLoading } = useSeguimiento(orden.id, puede('seguimiento.ver'));
  if (orden.estado === 'entregada' || orden.estado === 'cancelada') return null;
  const texto = mensajeOrdenWhatsApp({
    cliente: orden.cliente,
    vehiculo: [orden.marca, orden.modelo].filter(Boolean).join(' '),
    patente: orden.patente,
    numero: orden.numero,
    taller: me?.taller.nombre,
    url: s?.activo ? s.url : null,
    listo: orden.estado === 'lista',
  });
  const href = whatsapp(orden.cliente_telefono, texto) ?? `https://wa.me/?text=${encodeURIComponent(texto)}`;
  const boton = <Boton tam={tam} variante={variante} disabled={isLoading} icono={<MessageCircle className="size-4" />}>Enviar WhatsApp al cliente</Boton>;
  return isLoading ? boton : <a href={href} target="_blank" rel="noreferrer noopener">{boton}</a>;
}

async function copiar(texto: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    // Navegadores sin portapapeles asíncrono o sin conexión segura: se selecciona un campo y se copia.
    const t = document.createElement('textarea');
    t.value = texto;
    t.setAttribute('readonly', '');
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.appendChild(t);
    t.select();
    try {
      return document.execCommand('copy');
    } finally {
      document.body.removeChild(t);
    }
  }
}

export function SeguimientoCliente({ orden }: { orden: { id: string; numero: number; cliente_telefono?: string | null } }) {
  const { puede } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const { confirmar, dialogo } = useConfirmar();
  const { data: s, isLoading, error, refetch } = useSeguimiento(orden.id);
  const [qr, setQr] = useState(false);
  const [texto, setTexto] = useState('');
  const campo = useRef<HTMLInputElement>(null);

  const gestionar = puede('seguimiento.gestionar');
  const compartir = puede('seguimiento.compartir');
  const mensajes = puede('seguimiento.mensajes');
  const base = `/ordenes/${orden.id}/seguimiento`;
  const guardar = (r: EstadoSeguimiento) => qc.setQueryData(['orden', orden.id, 'seguimiento'], r);
  function accion<V = void>(fn: (v: V) => Promise<EstadoSeguimiento>, ok?: string) {
    return { mutationFn: fn, onSuccess: (r: EstadoSeguimiento) => { guardar(r); if (ok) toast.ok(ok); }, onError: toast.error };
  }

  const activar = useMutation(accion(() => api.post(`${base}/activar`), 'Seguimiento activado'));
  const desactivar = useMutation(accion(() => api.post(`${base}/desactivar`), 'Seguimiento desactivado: el enlace dejó de funcionar'));
  const regenerar = useMutation(accion(() => api.post(`${base}/regenerar`), 'Enlace regenerado: el anterior dejó de funcionar'));
  const fechaVisible = useMutation(accion((v: boolean) => api.patch(base, { mostrar_fecha_estimada: v })));
  const publicar = useMutation({
    mutationFn: () => api.post<EstadoSeguimiento>(`${base}/mensajes`, { texto }),
    onSuccess: (r) => { guardar(r); setTexto(''); toast.ok('Mensaje publicado para el cliente'); },
    onError: toast.error,
  });
  const retirar = useMutation(accion((id: string) => api.del(`${base}/mensajes/${id}`), 'Mensaje retirado de la página'));
  const visibleTransicion = useMutation(accion((p: { id: string; visible: boolean }) => api.put(`${base}/transiciones/${p.id}`, { visible: p.visible })));

  if (isLoading) return <Tarjeta titulo="Seguimiento del cliente"><Cargando /></Tarjeta>;
  if (error || !s) return <Tarjeta titulo="Seguimiento del cliente"><ErrorCaja error={error} reintentar={refetch} /></Tarjeta>;

  const url = s.url;
  const copiarEnlace = async () => {
    if (!url) return;
    if (await copiar(url)) toast.ok('Enlace copiado');
    else { campo.current?.select(); toast.error(new Error('No se pudo copiar solo: seleccionalo y copialo a mano')); }
  };
  const pedir = async (titulo: string, detalle: string, ejecutar: () => void) => {
    if (await confirmar(titulo, detalle, true)) ejecutar();
  };

  return (
    <>
      {dialogo}
      {qr && url && (
        <Suspense fallback={null}>
          <QrEnlace url={url} numero={orden.numero} onCerrar={() => setQr(false)} onCopiar={copiarEnlace} />
        </Suspense>
      )}
      <Tarjeta
        titulo="Seguimiento del cliente"
        subtitulo="Una página para que el cliente vea en qué estado está su vehículo, sin iniciar sesión"
        acciones={<Insignia tono={s.activo ? 'verde' : 'gris'}>{s.activo ? 'Activo' : s.existe ? 'Desactivado' : 'Sin activar'}</Insignia>}
      >
        <div className="space-y-5">
          {!s.activo ? (
            <div className="space-y-3">
              <p className="text-sm text-tenue">
                {s.existe ? `El enlace está desactivado${s.desactivado_at ? ` desde el ${fecha(s.desactivado_at)}` : ''}: quien lo tenga no puede abrirlo.` : 'Esta orden no tiene enlace de seguimiento (es anterior a la activación automática). Activalo para generar un enlace individual.'}
              </p>
              {gestionar ? (
                <Boton variante="primario" icono={<Link2 className="size-4" />} cargando={activar.isPending} onClick={() => activar.mutate()}>{s.existe ? 'Volver a activar el seguimiento' : 'Activar seguimiento'}</Boton>
              ) : (
                <Aviso>No tenés permiso para activar el seguimiento de esta orden.</Aviso>
              )}
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Insignia tono={TONO[s.estado.tono] ?? 'azul'}>El cliente ve: {s.estado.titulo}</Insignia>
                </div>
                <p className="text-xs text-tenue">Cuando cambies el estado de la orden, la página lo refleja sola al abrirla o recargarla.</p>
              </div>
              {compartir && url ? (
                <div className="space-y-3">
                  <Input ref={campo} readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Enlace de seguimiento" className="text-xs" />
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 [&_button]:h-auto [&_button]:min-h-10 [&_button]:py-1.5 [&_button]:leading-tight">
                    <Boton icono={<Copy className="size-4" />} onClick={copiarEnlace}>Copiar enlace</Boton>
                    <Boton icono={<QrCode className="size-4" />} onClick={() => setQr(true)}>Mostrar código QR</Boton>
                    <a href={url} target="_blank" rel="noreferrer noopener" className="contents"><Boton icono={<ExternalLink className="size-4" />} className="w-full">Ver como cliente</Boton></a>
                  </div>
                  <p className="text-xs text-tenue">Para avisarle al cliente usá «Enviar WhatsApp al cliente» (arriba): lleva este enlace y no se envía nada automáticamente.</p>
                </div>
              ) : (
                <Aviso>El seguimiento está activo. No tenés permiso para ver ni compartir el enlace.</Aviso>
              )}
            </>
          )}

          <details className="border-t border-borde-suave pt-3" open={s.mensajes.length > 0}>
            <summary className="min-h-10 cursor-pointer text-sm font-semibold">Mensaje para el cliente y qué se muestra</summary>
            <div className="space-y-5 pt-3">
          {mensajes || s.mensajes.length > 0 ? (
            <section className="space-y-3 border-t border-borde-suave pt-4" aria-labelledby="seg-msg">
              <h3 id="seg-msg" className="text-sm font-semibold">Mensaje para el cliente</h3>
              {mensajes && (
                <div className="space-y-2">
                  <Textarea rows={3} maxLength={MENSAJE_MAX} value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Ej.: Estamos esperando un repuesto solicitado al proveedor." aria-label="Mensaje para el cliente" />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-tenue">{texto.length}/{MENSAJE_MAX} · Lo que escribas acá lo ve el cliente. Las notas internas no se publican.</span>
                    <Boton variante="primario" tam="sm" disabled={!texto.trim()} cargando={publicar.isPending} onClick={() => publicar.mutate()}>Publicar</Boton>
                  </div>
                  {!s.activo && <p className="text-xs text-tenue">El cliente lo verá cuando el seguimiento esté activo.</p>}
                </div>
              )}
              {s.mensajes.length > 0 && (
                <ul className="divide-y divide-borde-suave text-sm">
                  {s.mensajes.map((m) => (
                    <li key={m.id} className="space-y-1 py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Insignia tono={m.vigente ? 'verde' : 'gris'}>{m.vigente ? 'Publicado' : m.retirado_at ? 'Retirado' : 'Reemplazado'}</Insignia>
                        <span className="text-xs text-tenue">{fechaHora(m.creado_at)} · {m.usuario ?? 'Sistema'}</span>
                        {m.vigente && mensajes && (
                          <Boton tam="sm" variante="fantasma" className="ml-auto" icono={<Trash2 className="size-4" />} cargando={retirar.isPending && retirar.variables === m.id} onClick={() => retirar.mutate(m.id)}>Retirar</Boton>
                        )}
                      </div>
                      <p className={`whitespace-pre-line break-words ${m.vigente ? '' : 'text-tenue'}`}>{m.texto}</p>
                      {m.retirado_at && <p className="text-xs text-tenue">Retirado el {fechaHora(m.retirado_at)}{m.retirado_por ? ` por ${m.retirado_por}` : ''}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}

          {s.existe && (
            <section className="space-y-3 border-t border-borde-suave pt-4" aria-labelledby="seg-vis">
              <h3 id="seg-vis" className="text-sm font-semibold">Qué ve el cliente</h3>
              {s.fecha_prometida ? (
                <div className="space-y-1">
                  <Check checked={s.mostrar_fecha_estimada} disabled={!gestionar || fechaVisible.isPending} onChange={(v) => fechaVisible.mutate(v)} label={`Mostrar la fecha estimada de entrega (${fecha(s.fecha_prometida)})`} />
                  <p className="pl-6 text-xs text-tenue">
                    Es la fecha prometida de la orden y se muestra como estimación.
                    {s.mostrar_fecha_estimada && !s.entrega && ' Ahora no se muestra porque la orden ya no está en curso.'}
                    {s.entrega?.vencida && ' Esa fecha ya pasó: el cliente ve una advertencia en lugar de un compromiso vigente.'}
                  </p>
                </div>
              ) : (
                <p className="text-xs text-tenue">La orden no tiene fecha de entrega prometida: no se muestra ninguna fecha.</p>
              )}
              <div>
                <h4 className="mb-1 text-xs font-medium text-tenue">Historial de estados</h4>
                <ul className="divide-y divide-borde-suave text-sm">
                  {s.transiciones.map((t) => (
                    <li key={t.id} className="flex items-center justify-between gap-3 py-2">
                      <span className="min-w-0">
                        <span className={t.visible ? '' : 'text-tenue line-through'}>{t.titulo}</span>
                        <span className="block text-xs text-tenue">{fechaHora(t.at)}{t.visible ? '' : ' · oculto para el cliente'}</span>
                      </span>
                      {gestionar && (
                        <Boton tam="sm" disabled={t.es_actual || visibleTransicion.isPending} title={t.es_actual ? 'El cliente siempre ve el estado actual' : undefined} onClick={() => visibleTransicion.mutate({ id: t.id, visible: !t.visible })}>
                          {t.visible ? 'Ocultar' : 'Mostrar'}
                        </Boton>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-tenue">Ocultá los pasos internos que no le interesan al cliente. El estado actual siempre se muestra.</p>
              </div>
            </section>
          )}

            </div>
          </details>

          {gestionar && s.activo && (
            <section className="flex flex-wrap gap-2 border-t border-borde-suave pt-4">
              <Boton icono={<RefreshCw className="size-4" />} cargando={regenerar.isPending} onClick={() => pedir('Regenerar el enlace', 'Se crea un enlace nuevo. El anterior y su código QR dejan de funcionar de inmediato, así que vas a tener que enviarle el nuevo al cliente.', () => regenerar.mutate())}>Regenerar enlace</Boton>
              <Boton variante="peligro" cargando={desactivar.isPending} onClick={() => pedir('Desactivar el seguimiento', 'El enlace deja de funcionar de inmediato: el cliente ya no va a poder ver el estado de su vehículo. Podés volver a activarlo cuando quieras.', () => desactivar.mutate())}>Desactivar enlace</Boton>
            </section>
          )}
        </div>
      </Tarjeta>
    </>
  );
}
