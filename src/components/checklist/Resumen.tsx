// Resumen de un registro de recepción o entrega (el mismo que ve el cliente antes de firmar), comparación entre ingreso y salida y verificación de integridad.
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Circle, MinusCircle, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fechaHora, km as fmtKm, numero } from '@/lib/format';
import { urlFoto, urlMiniatura } from '../Fotos';
import { Aviso, Boton, Insignia, Modal, cn, useToast } from '../ui';
import {
  AVISO_FIRMA, ESTADO_ITEM_LABEL, SECCIONES_CHECKLIST, TIPO_REGISTRO_LABEL, ZONA_DANO_LABEL, compararContenidos, progresoItems,
  type ContenidoChecklist, type EstadoItem,
} from '@shared/checklist';
import { FirmaVista } from './Firma';
import { FIRMA_LABEL, type Registro } from './tipos';

/** Datos de la orden para el encabezado cuando el registro todavía es borrador (el servidor guarda su propia copia recién al confirmar). */
export interface InfoOrden {
  numero: number;
  cliente: string;
  patente: string;
  vehiculo: string;
}

const ICONO_ITEM: Record<EstadoItem, React.ReactNode> = {
  correcto: <CheckCircle2 className="size-4 shrink-0 text-exito-600" aria-hidden />,
  con_observaciones: <AlertTriangle className="size-4 shrink-0 text-aviso-600" aria-hidden />,
  no_revisado: <Circle className="size-4 shrink-0 text-slate-300" aria-hidden />,
  no_corresponde: <MinusCircle className="size-4 shrink-0 text-slate-400" aria-hidden />,
};
export const IconoEstadoItem = ({ estado }: { estado: EstadoItem }) => <>{ICONO_ITEM[estado]}</>;

export const textoCombustible = (c: string | null) => (c ? (c === 'reserva' ? 'Reserva' : c === 'lleno' ? 'Lleno' : c) : 'Sin dato');

// ───────────── Fotografías en miniatura (y visor) ─────────────
export function Miniaturas({ ids, tam = 'size-16' }: { ids: string[]; tam?: string }) {
  const { puede } = useAuth();
  const [abierta, setAbierta] = useState<string | null>(null);
  if (!ids.length) return null;
  if (!puede('fotos.ver')) return <p className="text-xs text-tenue">{ids.length} {ids.length === 1 ? 'fotografía' : 'fotografías'} (no tenés permiso para verlas)</p>;
  return (
    <>
      <ul className="flex flex-wrap gap-1.5">
        {ids.map((id) => (
          <li key={id}>
            <button type="button" onClick={() => setAbierta(id)} className={cn('block overflow-hidden rounded-ctl border border-borde bg-slate-100 focus-visible:ring-2 focus-visible:ring-marca-300', tam)} aria-label="Ampliar fotografía">
              <img src={urlMiniatura(id)} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
            </button>
          </li>
        ))}
      </ul>
      <Modal abierto={!!abierta} onCerrar={() => setAbierta(null)} ancho="xl" titulo="Fotografía" pie={<Boton onClick={() => setAbierta(null)}>Cerrar</Boton>}>
        {abierta && <img src={urlFoto(abierta)} alt="Fotografía ampliada" className="mx-auto max-h-[70dvh] w-full rounded-card bg-slate-900 object-contain" />}
      </Modal>
    </>
  );
}

// ───────────── Resumen ─────────────
export function ResumenRegistro({ reg, info, firmas = true }: { reg: Registro; info: InfoOrden; firmas?: boolean }) {
  const d = reg.datos;
  const ctx = reg.contexto;
  const cliente = ctx?.cliente.nombre ?? info.cliente;
  const vehiculo = ctx ? [ctx.vehiculo.patente, [ctx.vehiculo.marca, ctx.vehiculo.modelo, ctx.vehiculo.anio].filter(Boolean).join(' ')].filter(Boolean).join(' · ') : [info.patente, info.vehiculo].filter(Boolean).join(' · ');
  const prog = progresoItems(d);
  const observados = SECCIONES_CHECKLIST.flatMap((s) => s.items.map((i) => ({ sec: s.titulo, titulo: i.titulo, codigo: `${s.clave}.${i.clave}` }))).filter((i) => (d.items[i.codigo]?.estado ?? 'no_revisado') !== 'no_revisado');
  const fotosGenerales = (ctx?.fotos ?? []).map((f) => f.id);
  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Insignia tono={reg.tipo === 'recepcion' ? 'azul' : 'violeta'}>{TIPO_REGISTRO_LABEL[reg.tipo]}{reg.revision > 0 ? ` · revisión ${reg.revision}` : ''}</Insignia>
        {reg.estado === 'borrador' ? <Insignia tono="ambar">Borrador</Insignia> : <Insignia tono="verde">Confirmada</Insignia>}
        {reg.firma_estado && <Insignia tono={reg.firma_estado === 'firmada' ? 'verde' : reg.firma_estado === 'pendiente' ? 'ambar' : 'gris'}>{FIRMA_LABEL[reg.firma_estado]}</Insignia>}
      </div>
      {reg.motivo && <Aviso tono="ambar"><strong>Motivo de la corrección:</strong> {reg.motivo}</Aviso>}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
        <Par k="Orden de trabajo" v={`#${numero(ctx?.orden.numero ?? info.numero)}`} />
        <Par k="Cliente" v={cliente} />
        <Par k="Vehículo" v={vehiculo} />
        <Par k="Fecha y hora" v={fechaHora(d.fecha_hora)} />
        <Par k="Responsable" v={ctx?.responsable.nombre ?? reg.responsable_nombre} />
        <Par k="Kilometraje" v={d.km != null ? `${fmtKm(d.km)}` : 'Sin dato'} />
        <Par k="Combustible" v={textoCombustible(d.combustible)} />
        <Par k="Llaves recibidas" v={d.llaves != null ? String(d.llaves) : 'Sin dato'} />
      </dl>
      {d.observaciones && <Bloque titulo="Observaciones generales"><p className="whitespace-pre-wrap break-words">{d.observaciones}</p></Bloque>}
      {d.estado_general && <Bloque titulo="Estado general al entregar"><p className="whitespace-pre-wrap break-words">{d.estado_general}</p></Bloque>}

      <Bloque titulo={`Estado del vehículo · ${prog.revisados} de ${prog.total} puntos revisados`}>
        {observados.length === 0 ? (
          <p className="text-tenue">No se marcó ningún punto de control.</p>
        ) : (
          <ul className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
            {observados.map((i) => {
              const it = d.items[i.codigo];
              return (
                <li key={i.codigo} className="flex min-w-0 items-start gap-2">
                  {ICONO_ITEM[it.estado]}
                  <span className="min-w-0 break-words">
                    <span className="text-tenue">{i.sec}:</span> {i.titulo} — <strong className="font-medium">{ESTADO_ITEM_LABEL[it.estado]}</strong>
                    {it.obs && <span className="block text-xs text-tenue">{it.obs}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Bloque>

      <Bloque titulo={`Daños registrados · ${d.danos.length}`}>
        {d.danos.length === 0 ? (
          <p className="text-tenue">No se registraron daños.</p>
        ) : (
          <ol className="space-y-2.5">
            {d.danos.map((x, i) => (
              <li key={x.id} className="flex min-w-0 gap-2.5">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-peligro-600 text-xs font-bold text-white">{i + 1}</span>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <p className="break-words"><strong className="font-medium">{ZONA_DANO_LABEL[x.zona]}</strong>{x.descripcion ? `: ${x.descripcion}` : ''}</p>
                  <Miniaturas ids={x.fotos} />
                </div>
              </li>
            ))}
          </ol>
        )}
      </Bloque>

      <Bloque titulo="Elementos y pertenencias">
        {d.pertenencias.length === 0 ? <p className="text-tenue">Ninguno registrado.</p> : <ul className="list-disc space-y-0.5 pl-5">{d.pertenencias.map((p, i) => <li key={i} className="break-words">{p.descripcion}</li>)}</ul>}
      </Bloque>

      {reg.tipo === 'entrega' && (
        <Bloque titulo="Trabajos realizados">
          {d.trabajos.length === 0 ? <p className="text-tenue">Ninguno registrado.</p> : <ul className="list-disc space-y-0.5 pl-5">{d.trabajos.map((p, i) => <li key={i} className="break-words">{p.descripcion}</li>)}</ul>}
        </Bloque>
      )}

      {fotosGenerales.length > 0 && <Bloque titulo={`Fotografías de ${reg.tipo === 'recepcion' ? 'recepción' : 'entrega'} · ${fotosGenerales.length}`}><Miniaturas ids={fotosGenerales} /></Bloque>}

      {reg.estado === 'confirmado' && (
        <p className="break-all text-xs text-tenue">
          Confirmada el {fechaHora(reg.confirmado_at)} por {reg.confirmado_por_nombre ?? reg.responsable_nombre} · versión del checklist {reg.checklist_version} · huella del contenido <span className="font-mono">{reg.contenido_sha256?.slice(0, 16)}…</span>
        </p>
      )}
      {firmas && reg.firmas.length > 0 && <ConformidadCliente reg={reg} />}
    </div>
  );
}

const Par = ({ k, v }: { k: string; v: string }) => (
  <div className="min-w-0">
    <dt className="text-xs font-medium text-tenue">{k}</dt>
    <dd className="mt-0.5 break-words text-texto">{v || '—'}</dd>
  </div>
);
const Bloque = ({ titulo, children }: { titulo: string; children: React.ReactNode }) => (
  <section className="space-y-1.5 border-t border-borde-suave pt-3">
    <h4 className="text-[13px] font-semibold text-slate-700">{titulo}</h4>
    {children}
  </section>
);

/** Historial de la conformidad: cada intento queda (no presente, no quiso firmar, firma). La firma y el nombre sólo con el permiso de firmas. */
export function ConformidadCliente({ reg }: { reg: Registro }) {
  const { puede } = useAuth();
  return (
    <Bloque titulo="Conformidad del cliente">
      <ul className="space-y-3">
        {reg.firmas.map((f) => (
          <li key={f.id} className="space-y-1.5">
            <p>
              <strong className="font-medium">{f.resultado === 'firmada' ? 'Firmó' : f.resultado === 'no_presente' ? 'El cliente no estaba presente' : 'El cliente no quiso firmar'}</strong>
              {f.nombre_firmante ? ` — ${f.nombre_firmante}` : ''} · {fechaHora(f.created_at)} · registrado por {f.registrado_por_nombre}
            </p>
            {f.aclaracion && <p className="text-xs text-tenue">{f.aclaracion}</p>}
            {f.firma && <FirmaVista firma={f.firma} className="max-w-md" />}
            {f.texto_conformidad && <p className="text-xs italic text-tenue">«{f.texto_conformidad}»</p>}
            {f.resultado === 'firmada' && !f.firma && !puede('checklists.firmas') && <p className="text-xs text-tenue">La firma sólo la ven quienes tienen permiso para consultar firmas.</p>}
          </li>
        ))}
      </ul>
      {reg.firmas.some((f) => f.resultado === 'firmada') && <p className="text-xs text-tenue">{AVISO_FIRMA}</p>}
    </Bloque>
  );
}

// ───────────── Verificación de integridad ─────────────
export function BotonVerificar({ reg }: { reg: Registro }) {
  const toast = useToast();
  const [r, setR] = useState<{ integro: boolean; fotos: { cantidad: number; correctas: number }; firmas: Array<{ corresponde_al_contenido: boolean }> } | null>(null);
  const m = useMutation({ mutationFn: () => api.get(`/checklists/${reg.id}/verificar`), onSuccess: setR, onError: toast.error });
  const todoBien = r && r.integro && r.fotos.correctas === r.fotos.cantidad && r.firmas.every((f) => f.corresponde_al_contenido);
  return (
    <div className="space-y-2">
      <Boton tam="sm" icono={<ShieldCheck className="size-4" />} cargando={m.isPending} onClick={() => m.mutate()}>Verificar integridad</Boton>
      {r && (
        <Aviso tono={todoBien ? 'verde' : 'rojo'}>
          {todoBien
            ? `Íntegro: el contenido coincide con la huella guardada al confirmar, ${r.fotos.cantidad} ${r.fotos.cantidad === 1 ? 'fotografía' : 'fotografías'} sin cambios y las firmas corresponden a este contenido.`
            : `Atención: ${!r.integro ? 'el contenido no coincide con la huella guardada. ' : ''}${r.fotos.correctas !== r.fotos.cantidad ? `Faltan o cambiaron ${r.fotos.cantidad - r.fotos.correctas} fotografías. ` : ''}${r.firmas.some((f) => !f.corresponde_al_contenido) ? 'Alguna firma no corresponde a este contenido.' : ''}`}
        </Aviso>
      )}
    </div>
  );
}

// ───────────── Comparación entre el ingreso y la salida ─────────────
export function Comparacion({ ingreso, salida }: { ingreso: Registro; salida: Registro }) {
  const c = compararContenidos(ingreso.datos as ContenidoChecklist, salida.datos as ContenidoChecklist);
  const filas = c.filas.filter((f) => f.ingreso.estado !== 'no_revisado' || f.salida.estado !== 'no_revisado');
  return (
    <div className="space-y-4 text-sm">
      <div className="grid gap-3 sm:grid-cols-3">
        <Dif titulo="Kilometraje" a={c.km.ingreso != null ? fmtKm(c.km.ingreso) : 'Sin dato'} b={c.km.salida != null ? fmtKm(c.km.salida) : 'Sin dato'} nota={c.km.recorridos != null ? (c.km.recorridos >= 0 ? `${fmtKm(c.km.recorridos)} recorridos en el taller` : 'La salida tiene menos km que el ingreso: revisá') : undefined} alerta={c.km.recorridos != null && c.km.recorridos < 0} />
        <Dif titulo="Combustible" a={textoCombustible(c.combustible.ingreso)} b={textoCombustible(c.combustible.salida)} alerta={!!c.combustible.ingreso && !!c.combustible.salida && c.combustible.ingreso !== c.combustible.salida} />
        <Dif titulo="Llaves" a={c.llaves.ingreso != null ? String(c.llaves.ingreso) : 'Sin dato'} b={c.llaves.salida != null ? String(c.llaves.salida) : 'Sin dato'} alerta={c.llaves.ingreso != null && c.llaves.salida != null && c.llaves.ingreso !== c.llaves.salida} />
      </div>

      <section className="space-y-1.5">
        <h4 className="text-[13px] font-semibold text-slate-700">Puntos de control {c.cambios ? `· ${c.cambios} ${c.cambios === 1 ? 'cambio' : 'cambios'}` : '· sin cambios'}</h4>
        {filas.length === 0 ? (
          <p className="text-tenue">No hay puntos de control revisados en ninguno de los dos registros.</p>
        ) : (
          <ul className="divide-y divide-borde-suave rounded-card border border-borde">
            {filas.map((f) => (
              <li key={f.codigo} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2', f.cambio && 'bg-aviso-50')}>
                <span className="min-w-0 flex-1 basis-48 break-words">{f.titulo}</span>
                <span className="flex items-center gap-1.5 text-xs"><span className="text-tenue">Ingreso</span> {ICONO_ITEM[f.ingreso.estado]} {ESTADO_ITEM_LABEL[f.ingreso.estado]}</span>
                <span className="flex items-center gap-1.5 text-xs"><span className="text-tenue">Salida</span> {ICONO_ITEM[f.salida.estado]} {ESTADO_ITEM_LABEL[f.salida.estado]}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-3 sm:grid-cols-2">
        <section className="space-y-1.5">
          <h4 className="text-[13px] font-semibold text-slate-700">Daños al ingresar · {c.danos.ingreso.length}</h4>
          {c.danos.ingreso.length ? <ul className="list-disc space-y-0.5 pl-5">{c.danos.ingreso.map((d) => <li key={d.id} className="break-words">{ZONA_DANO_LABEL[d.zona]}{d.descripcion ? `: ${d.descripcion}` : ''}</li>)}</ul> : <p className="text-tenue">Ninguno.</p>}
        </section>
        <section className="space-y-1.5">
          <h4 className="text-[13px] font-semibold text-slate-700">Daños al entregar · {c.danos.salida.length}</h4>
          {c.danos.salida.length ? <ul className="list-disc space-y-0.5 pl-5">{c.danos.salida.map((d) => <li key={d.id} className="break-words">{ZONA_DANO_LABEL[d.zona]}{d.descripcion ? `: ${d.descripcion}` : ''}</li>)}</ul> : <p className="text-tenue">Ninguno registrado.</p>}
        </section>
      </div>

      {c.pertenencias.faltan.length > 0 && (
        <Aviso tono="ambar">
          <strong>Elementos recibidos que no figuran en la entrega:</strong> {c.pertenencias.faltan.join(', ')}. Verificá que se hayan devuelto.
        </Aviso>
      )}
    </div>
  );
}

const Dif = ({ titulo, a, b, nota, alerta }: { titulo: string; a: string; b: string; nota?: string; alerta?: boolean }) => (
  <div className={cn('rounded-card border px-3 py-2.5', alerta ? 'border-aviso-200 bg-aviso-50' : 'border-borde bg-white')}>
    <p className="text-xs font-medium text-tenue">{titulo}</p>
    <p className="mt-1 break-words"><span className="text-tenue">Ingreso</span> <strong className="font-medium">{a}</strong></p>
    <p className="break-words"><span className="text-tenue">Salida</span> <strong className="font-medium">{b}</strong></p>
    {nota && <p className="mt-1 text-xs text-tenue">{nota}</p>}
  </div>
);
