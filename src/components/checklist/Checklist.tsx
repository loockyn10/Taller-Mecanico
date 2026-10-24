// Recepción y entrega de vehículos dentro de una orden de trabajo (Sprint 18) y su historial en la ficha del vehículo.
// El checklist es opcional: la OT se usa igual si el taller no lo completa.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, Camera, ClipboardList, Eye, FileEdit, PenLine, PlayCircle, Truck } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fechaHora, numero } from '@/lib/format';
import { TIPO_REGISTRO_LABEL, resumenCambios, type TipoRegistro } from '@shared/checklist';
import { Aviso, Boton, Campo, Cargando, ErrorCaja, Insignia, Modal, Tarjeta, Textarea, cn, useToast } from '../ui';
import { EditorRegistro } from './Editor';
import { FirmarRegistro } from './FirmarRegistro';
import { BotonVerificar, Comparacion, ResumenRegistro, type InfoOrden } from './Resumen';
import { FIRMA_LABEL, claveChecklists, estadoDe, useChecklistsOrden, type EstadoFirma, type Registro } from './tipos';

const tonoFirma = (e: EstadoFirma) => (e === 'firmada' ? 'verde' : e === 'pendiente' ? 'ambar' : 'gris');

export function ChecklistOrden({ orden }: { orden: any }) {
  const { puede } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useChecklistsOrden(orden.id);
  const [editando, setEditando] = useState<Registro | null>(null);
  const [firmando, setFirmando] = useState<Registro | null>(null);
  const [viendo, setViendo] = useState<Registro | null>(null);
  const [corrigiendo, setCorrigiendo] = useState<TipoRegistro | null>(null);
  const [motivo, setMotivo] = useState('');

  const info: InfoOrden = { numero: orden.numero, cliente: orden.cliente ?? '', patente: orden.patente ?? '', vehiculo: [orden.marca, orden.modelo, orden.anio].filter(Boolean).join(' ') };
  const abrirBorrador = useMutation({
    mutationFn: (tipo: TipoRegistro) => api.post<Registro>(`/ordenes/${orden.id}/checklists/${tipo}/borrador`),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: claveChecklists(orden.id) });
      setEditando(r);
    },
    onError: toast.error,
  });
  const corregir = useMutation({
    mutationFn: (tipo: TipoRegistro) => api.post<Registro>(`/ordenes/${orden.id}/checklists/${tipo}/corregir`, { motivo: motivo.trim() }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: claveChecklists(orden.id) });
      setCorrigiendo(null);
      setMotivo('');
      setEditando(r);
    },
    onError: toast.error,
  });

  if (isLoading) return <Cargando />;
  if (error || !data) return <ErrorCaja error={error} reintentar={refetch} />;
  const registros = data.registros;
  const rec = estadoDe(registros, 'recepcion');
  const ent = estadoDe(registros, 'entrega');
  const cancelada = orden.estado === 'cancelada';
  const puedeEscribir = (r: Pick<Registro, 'tipo' | 'revision'>) => puede(r.tipo === 'recepcion' ? 'checklists.recepcion' : 'checklists.entrega') || (r.revision > 0 && puede('checklists.corregir'));
  const porId = new Map(registros.map((r) => [r.id, r]));

  const tarjeta = (tipo: TipoRegistro) => {
    const e = tipo === 'recepcion' ? rec : ent;
    const crear = puede(tipo === 'recepcion' ? 'checklists.recepcion' : 'checklists.entrega') && !cancelada;
    const v = e.vigente;
    const hayAviso = tipo === 'entrega' && !e.vigente && !e.borrador && !['lista', 'entregada'].includes(orden.estado);
    return (
      <Tarjeta
        titulo={
          <span className="flex flex-wrap items-center gap-2">
            {tipo === 'recepcion' ? <ClipboardList className="size-5 text-marca-600" aria-hidden /> : <Truck className="size-5 text-violet-600" aria-hidden />}
            {TIPO_REGISTRO_LABEL[tipo]}
            {v ? <Insignia tono="verde">Confirmada{v.revision > 0 ? ` · revisión ${v.revision}` : ''}</Insignia> : e.borrador ? <Insignia tono="ambar">Borrador</Insignia> : <Insignia>Sin registrar</Insignia>}
            {v && <Insignia tono={tonoFirma(v.firma_estado)}>{FIRMA_LABEL[v.firma_estado ?? 'pendiente']}</Insignia>}
          </span>
        }
      >
        <div className="space-y-3">
          {!v && !e.borrador && (
            <>
              <p className="text-sm text-tenue">
                {tipo === 'recepcion'
                  ? 'Todavía no se registró cómo ingresó el vehículo: estado, daños, fotografías y conformidad del cliente. Es opcional.'
                  : 'Todavía no se registró la entrega: estado de salida, trabajos realizados y conformidad del cliente. Es opcional.'}
              </p>
              {hayAviso && <Aviso tono="azul">La orden todavía no está lista para entregar; podés registrar la entrega igual cuando corresponda.</Aviso>}
              {tipo === 'entrega' && !rec.vigente && <p className="text-xs text-tenue">Esta orden no tiene recepción confirmada: la entrega se guarda igual, pero no podrá compararse con el ingreso.</p>}
              {crear ? (
                <Boton variante="primario" tam="lg" className="h-12 w-full sm:w-auto" icono={<PlayCircle className="size-5" />} cargando={abrirBorrador.isPending && abrirBorrador.variables === tipo} onClick={() => abrirBorrador.mutate(tipo)}>
                  Iniciar {tipo === 'recepcion' ? 'recepción' : 'entrega'}
                </Boton>
              ) : (
                !cancelada && <p className="text-xs text-tenue">No tenés permiso para registrar {tipo === 'recepcion' ? 'recepciones' : 'entregas'}.</p>
              )}
            </>
          )}

          {e.borrador && (
            <div className="rounded-card border border-aviso-200 bg-aviso-50 p-3">
              <p className="text-sm">
                {e.borrador.revision > 0 ? <strong>Corrección en curso (revisión {e.borrador.revision}).</strong> : <strong>Hay un borrador sin confirmar.</strong>} Iniciado por {e.borrador.responsable_nombre}, guardado {fechaHora(e.borrador.updated_at)}.
              </p>
              {puedeEscribir(e.borrador) ? (
                <Boton variante="primario" className="mt-2 h-11" icono={<FileEdit className="size-4" />} onClick={() => setEditando(e.borrador)}>Continuar</Boton>
              ) : (
                <Boton className="mt-2" icono={<Eye className="size-4" />} onClick={() => setViendo(e.borrador)}>Ver el borrador</Boton>
              )}
            </div>
          )}

          {v && (
            <>
              <p className="text-sm">
                Confirmada el <strong className="font-medium">{fechaHora(v.confirmado_at)}</strong> por {v.confirmado_por_nombre ?? v.responsable_nombre}
                {v.datos.km != null ? ` · ${v.datos.km.toLocaleString('es-AR')} km` : ''}
                {v.datos.danos.length ? ` · ${v.datos.danos.length} ${v.datos.danos.length === 1 ? 'daño' : 'daños'}` : ' · sin daños registrados'}
                {v.contexto?.fotos.length ? ` · ${v.contexto.fotos.length} ${v.contexto.fotos.length === 1 ? 'foto' : 'fotos'}` : ''}.
              </p>
              {v.firma_estado !== 'firmada' && puedeEscribir(v) && !e.borrador && (
                <Aviso tono="ambar">
                  {v.firma_estado === 'pendiente' ? 'Falta la conformidad del cliente.' : v.firma_estado === 'no_presente' ? 'El cliente no estaba presente. Cuando pase por el taller podés pedirle la firma.' : 'El cliente no quiso firmar.'}
                </Aviso>
              )}
              <div className="flex flex-wrap gap-2">
                <Boton icono={<Eye className="size-4" />} onClick={() => setViendo(v)}>Ver resumen</Boton>
                {v.firma_estado !== 'firmada' && puedeEscribir(v) && !e.borrador && (
                  <Boton variante="primario" icono={<PenLine className="size-4" />} onClick={() => setFirmando(v)}>{v.firma_estado === 'pendiente' ? 'Obtener firma del cliente' : 'Registrar firma'}</Boton>
                )}
                {puede('checklists.corregir') && !e.borrador && <Boton icono={<FileEdit className="size-4" />} onClick={() => setCorrigiendo(tipo)}>Corregir</Boton>}
              </div>
            </>
          )}
        </div>
      </Tarjeta>
    );
  };

  const cronologia = [...registros].sort((a, b) => (b.confirmado_at ?? b.created_at).localeCompare(a.confirmado_at ?? a.created_at));

  return (
    <div className="space-y-4">
      {cancelada && <Aviso tono="ambar">La orden está cancelada: sólo se pueden consultar los registros existentes.</Aviso>}
      {tarjeta('recepcion')}
      {tarjeta('entrega')}

      {rec.vigente && ent.vigente && (
        <Tarjeta titulo="Ingreso y salida, lado a lado" subtitulo="Lo registrado al recibir frente a lo registrado al entregar">
          <Comparacion ingreso={rec.vigente} salida={ent.vigente} />
        </Tarjeta>
      )}

      {registros.some((r) => r.estado === 'confirmado') && (
        <Tarjeta titulo="Historial de registros" subtitulo="Cada corrección es una revisión nueva: el original nunca se pisa">
          <ul className="divide-y divide-borde-suave">
            {cronologia.map((r) => {
              const previo = r.previo_id ? porId.get(r.previo_id) : null;
              const cambios = previo ? resumenCambios(previo.datos, r.datos) : [];
              return (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5">
                  <div className="min-w-0 flex-1 basis-60 space-y-1">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                      {TIPO_REGISTRO_LABEL[r.tipo]} · {r.revision === 0 ? 'original' : `revisión ${r.revision}`}
                      {r.estado === 'borrador' ? <Insignia tono="ambar">Borrador</Insignia> : <Insignia tono={tonoFirma(r.firma_estado)}>{FIRMA_LABEL[r.firma_estado ?? 'pendiente']}</Insignia>}
                    </p>
                    <p className="text-xs text-tenue">
                      {r.estado === 'confirmado' ? `Confirmada ${fechaHora(r.confirmado_at)} por ${r.confirmado_por_nombre ?? r.responsable_nombre}` : `Iniciada ${fechaHora(r.created_at)} por ${r.responsable_nombre}`}
                    </p>
                    {r.motivo && <p className="break-words text-xs"><strong className="font-medium">Motivo:</strong> {r.motivo}</p>}
                    {cambios.length > 0 && (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-marca-700">Qué cambió respecto de la {previo!.revision === 0 ? 'original' : `revisión ${previo!.revision}`} ({cambios.length})</summary>
                        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-tenue">{cambios.map((c) => <li key={c} className="break-words">{c}</li>)}</ul>
                      </details>
                    )}
                  </div>
                  <Boton tam="sm" icono={<Eye className="size-4" />} onClick={() => setViendo(r)}>Ver</Boton>
                </li>
              );
            })}
          </ul>
        </Tarjeta>
      )}

      {editando && (
        <EditorRegistro
          key={editando.id}
          registro={editando}
          info={info}
          vehiculoId={orden.vehiculo_id}
          asignadaAMi={!!orden.asignada_a_mi}
          onCerrar={() => setEditando(null)}
          onConfirmado={(r) => {
            setEditando(null);
            if (puedeEscribir(r)) setFirmando(r); // la conformidad se pide enseguida, con el cliente delante
          }}
        />
      )}
      {firmando && <FirmarRegistro reg={firmando} info={info} onCerrar={() => setFirmando(null)} onFirmado={() => setFirmando(null)} />}

      <Modal
        abierto={!!viendo}
        onCerrar={() => setViendo(null)}
        ancho="xl"
        titulo={viendo ? `${TIPO_REGISTRO_LABEL[viendo.tipo]}${viendo.revision > 0 ? ` · revisión ${viendo.revision}` : viendo.estado === 'confirmado' ? ' · original' : ''}` : ''}
        pie={<Boton onClick={() => setViendo(null)}>Cerrar</Boton>}
      >
        {viendo && (
          <div className="space-y-4">
            <ResumenRegistro reg={viendo} info={info} />
            {viendo.estado === 'confirmado' && <BotonVerificar reg={viendo} />}
          </div>
        )}
      </Modal>

      <Modal
        abierto={!!corrigiendo}
        onCerrar={() => !corregir.isPending && setCorrigiendo(null)}
        titulo={`Corregir ${corrigiendo === 'entrega' ? 'la entrega' : 'la recepción'}`}
        pie={
          <>
            <Boton onClick={() => setCorrigiendo(null)} disabled={corregir.isPending}>Cancelar</Boton>
            <Boton variante="primario" disabled={motivo.trim().length < 5} cargando={corregir.isPending} icono={<ArrowRight className="size-4" />} onClick={() => corrigiendo && corregir.mutate(corrigiendo)}>Crear la corrección</Boton>
          </>
        }
      >
        <div className="space-y-3">
          <Aviso tono="azul">El registro confirmado no se modifica: se crea una <strong>revisión</strong> que parte de su contenido. El original, la firma y las fotografías quedan guardados y se pueden consultar.</Aviso>
          <Campo label="¿Qué se corrige y por qué?" requerido>
            <Textarea rows={3} value={motivo} maxLength={500} autoFocus placeholder="Ej.: se cargó mal el kilometraje; faltaba un daño en el paragolpes trasero" onChange={(e) => setMotivo(e.target.value)} />
          </Campo>
          <p className="text-xs text-tenue">La revisión necesitará su propia conformidad del cliente si el cambio la requiere.</p>
        </div>
      </Modal>
    </div>
  );
}

// ───────────── Historial en la ficha del vehículo ─────────────
interface GrupoOrden {
  orden_id: string;
  numero: number;
  estado: string;
  fecha: string;
  registros: Array<{ id: string; tipo: TipoRegistro; revision: number; estado: 'borrador' | 'confirmado'; fecha_hora: string; km: number | null; combustible: string | null; danos: number; responsable_nombre: string; firma_estado: EstadoFirma }>;
}

export function ChecklistsVehiculo({ vehiculoId }: { vehiculoId: string }) {
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['checklists', 'vehiculo', vehiculoId], queryFn: () => api.get<GrupoOrden[]>(`/vehiculos/${vehiculoId}/checklists`) });
  return (
    <Tarjeta titulo="Recepciones y entregas" subtitulo="Checklists de ingreso y salida de cada orden de trabajo">
      {isLoading ? (
        <Cargando />
      ) : error ? (
        <ErrorCaja error={error} reintentar={refetch} />
      ) : data.length === 0 ? (
        <p className="py-3 text-center text-sm text-tenue">Todavía no hay recepciones ni entregas registradas para este vehículo.</p>
      ) : (
        <ul className="space-y-3">
          {data.map((o) => (
            <li key={o.orden_id} className="rounded-card border border-borde">
              <Link to={`/ordenes/${o.orden_id}?tab=checklist`} className="flex items-center justify-between gap-2 border-b border-borde-suave bg-superficie-2 px-3 py-2 text-sm font-medium text-marca-700 hover:underline">
                <span>OT #{numero(o.numero)}</span>
                <ArrowRight className="size-4" aria-hidden />
              </Link>
              <ul className="divide-y divide-borde-suave">
                {o.registros.map((r) => (
                  <li key={r.id}>
                    <Link to={`/ordenes/${o.orden_id}?tab=checklist`} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm hover:bg-slate-50">
                      <span className="font-medium">{TIPO_REGISTRO_LABEL[r.tipo]}{r.revision > 0 ? ` · rev. ${r.revision}` : ''}</span>
                      {r.estado === 'borrador' ? <Insignia tono="ambar">Borrador</Insignia> : <Insignia tono={tonoFirma(r.firma_estado)}>{FIRMA_LABEL[r.firma_estado ?? 'pendiente']}</Insignia>}
                      <span className={cn('text-xs text-tenue')}>{fechaHora(r.fecha_hora)}{r.km != null ? ` · ${r.km.toLocaleString('es-AR')} km` : ''}</span>
                      {r.danos > 0 && <span className="inline-flex items-center gap-1 text-xs text-peligro-700"><Camera className="size-3.5" aria-hidden />{r.danos} {r.danos === 1 ? 'daño' : 'daños'}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Tarjeta>
  );
}
