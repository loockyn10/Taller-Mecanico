// «Pago del cliente» en el detalle de la OT (Sprint 25): lo que se le informó al cliente, qué medio eligió desde su página de seguimiento, los comprobantes de transferencia que
// envió y la verificación del taller. Confirmar el cobro usa el circuito de cobros de siempre (caja, banco, asientos): acá no se contabiliza nada aparte.
// Información financiera: sólo se muestra a quien puede ver órdenes y ventas (el mecánico no la ve ni la pide).
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote, Check as IconoCheck, Download, Eye, Landmark, Megaphone, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fecha, fechaHora, money, numero, tamano } from '@/lib/format';
import { Aviso, Boton, Cargando, Campo, ErrorCaja, Insignia, InputMoneda, Modal, Select, Tarjeta, Textarea, useConfirmar, useToast, type Tono } from '@/components/ui';
import { LIMITES_COMPROBANTE, MEDIO_PORTAL_LABEL, type EstadoPagoCliente, type MedioPortal } from '@shared/pago-portal';

interface Cambio { desde: number; hasta: number; diferencia: number }
interface Comprobante {
  id: string; estado: 'pendiente' | 'confirmado' | 'rechazado'; mime: string; bytes: number; nombre: string | null; at: string; importe_total: number; importe_pendiente: number;
  importe_cambio: Cambio | null; revisado_por: string | null; revisado_at: string | null; motivo_rechazo: string | null;
  cobro: { id: string; numero: number; anulado: boolean } | null; importe_confirmado: number | null; vinculo: 'nuevo' | 'existente' | null;
}
export interface VistaPago {
  orden: { id: string; numero: number; estado: string };
  importe: { total: number; fuente: 'comprobante' | 'orden'; abonado: number; pendiente: number; confirmado: boolean; comprobante: { id: string; numero: number } | null; informado: { at: string; por: string | null; importe_al_informar: number; importe_cambio: Cambio | null } | null };
  estado: { clave: EstadoPagoCliente; etiqueta: string; detalle: string };
  eleccion: { medio: MedioPortal; estado: 'seleccionado' | 'confirmado'; at: string; importe_total: number; importe_pendiente: number; importe_cambio: Cambio | null } | null;
  historial_elecciones: Array<{ medio: MedioPortal; estado: string; at: string; importe_total: number; importe_pendiente: number }>;
  comprobantes: Comprobante[];
  cuenta: { id: string; banco: string; alias: string | null; titular: string | null } | null;
  cobros_vinculables: Array<{ id: string; numero: number; fecha: string; tipo: 'cobro' | 'anticipo'; total: number; transferido: number }>;
  seguimiento_activo: boolean;
  puede: { informar: boolean; resolver: boolean };
}

const TONO_ESTADO: Record<EstadoPagoCliente, Tono> = { sin_importe: 'gris', pendiente_de_pago: 'gris', medio_seleccionado: 'azul', comprobante_recibido: 'ambar', comprobante_rechazado: 'rojo', cobro_confirmado: 'verde' };
const TONO_COMP: Record<Comprobante['estado'], Tono> = { pendiente: 'ambar', confirmado: 'verde', rechazado: 'rojo' };
const ROTULO_COMP: Record<Comprobante['estado'], string> = { pendiente: 'Pendiente de verificación', confirmado: 'Cobro confirmado', rechazado: 'Rechazado' };
const MOTIVOS_RAPIDOS = ['La transferencia no figura en la cuenta del taller', 'El comprobante es de otra operación o de otro importe', 'La imagen no se lee bien: enviá una captura completa', 'El comprobante está incompleto'];

export const usePagoCliente = (ordenId: string, habilitado = true) =>
  useQuery({ queryKey: ['orden', ordenId, 'pago-cliente'], queryFn: () => api.get<VistaPago>(`/ordenes/${ordenId}/pago-cliente`), enabled: habilitado });

function AvisoCambio({ c, que }: { c: Cambio; que: string }) {
  return (
    <Aviso tono="ambar">
      El importe de la orden cambió de <strong>{money(c.desde)}</strong> a <strong>{money(c.hasta)}</strong> ({c.diferencia > 0 ? '+' : '−'}{money(Math.abs(c.diferencia))}) {que}. El cliente ya ve el importe nuevo y el saldo se recalculó: revisá la diferencia antes de confirmar. Nada se confirma automáticamente.
    </Aviso>
  );
}

export function PagoCliente({ orden, onCobrar }: { orden: { id: string; numero: number }; onCobrar?: () => void }) {
  const { puede } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const { confirmar, dialogo } = useConfirmar();
  const { data: v, isLoading, error, refetch } = usePagoCliente(orden.id);
  const [confirmando, setConfirmando] = useState<Comprobante | null>(null);
  const [rechazando, setRechazando] = useState<Comprobante | null>(null);

  const refrescar = () => qc.invalidateQueries({ queryKey: ['orden', orden.id] });
  const informar = useMutation({
    mutationFn: (informar: boolean) => api.post(`/ordenes/${orden.id}/pago-cliente/importe`, { informar }),
    onSuccess: (_d, informar) => { toast.ok(informar ? 'El cliente ya ve el importe en su página de seguimiento' : 'Importe retirado de la página del cliente'); refrescar(); },
    onError: toast.error,
  });

  if (isLoading) return <Tarjeta titulo="Pago del cliente"><Cargando /></Tarjeta>;
  if (error || !v) return <Tarjeta titulo="Pago del cliente"><ErrorCaja error={error} reintentar={refetch} /></Tarjeta>;

  const cerrada = v.orden.estado === 'cancelada';
  const pendientes = v.comprobantes.filter((c) => c.estado === 'pendiente').length;

  return (
    <>
      {dialogo}
      <Tarjeta
        titulo="Pago del cliente"
        subtitulo="Qué ve el cliente en su página, cómo eligió pagar y los comprobantes de transferencia que envió"
        acciones={<Insignia tono={TONO_ESTADO[v.estado.clave]}>{v.estado.etiqueta}</Insignia>}
      >
        <div className="space-y-4">
          <dl className="grid grid-cols-3 gap-3 text-sm">
            <div className="min-w-0"><dt className="text-xs text-tenue">Importe total</dt><dd className="whitespace-nowrap text-sm font-semibold tabular-nums sm:text-lg">{money(v.importe.total)}</dd></div>
            <div className="min-w-0"><dt className="text-xs text-tenue">Abonado</dt><dd className="whitespace-nowrap text-sm font-semibold tabular-nums sm:text-lg">{money(v.importe.abonado)}</dd></div>
            <div className="min-w-0"><dt className="text-xs text-tenue">Saldo pendiente</dt><dd className={`whitespace-nowrap text-sm font-semibold tabular-nums sm:text-lg ${v.importe.pendiente > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>{money(v.importe.pendiente)}</dd></div>
          </dl>
          <p className="-mt-2 text-xs text-tenue">
            {v.importe.fuente === 'comprobante' ? `Según el comprobante interno #${numero(v.importe.comprobante!.numero)}.` : 'Según el total de la orden (todavía sin comprobante).'} «Abonado» suma sólo cobros ya confirmados en el sistema: un comprobante pendiente no cuenta.
          </p>

          {/* Importe informado al cliente */}
          {cerrada ? (
            <Aviso>La orden está cancelada: el cliente no puede elegir ni pagar desde su página.</Aviso>
          ) : !v.importe.confirmado ? (
            <Aviso tono="ambar">
              <div className="space-y-2">
                <p>El cliente todavía <strong>no ve el importe</strong>: en su página dice «Importe pendiente de confirmación por el taller» y no puede elegir cómo pagar ni enviar comprobantes.</p>
                {v.puede.informar && (
                  <Boton tam="sm" variante="primario" icono={<Megaphone className="size-4" />} disabled={v.importe.total <= 0} cargando={informar.isPending} onClick={async () => { if (await confirmar('Informar el importe al cliente', `El cliente va a ver ${money(v.importe.total)} como importe total de la reparación y va a poder elegir cómo pagar. Informalo sólo cuando el importe esté confirmado.`)) informar.mutate(true); }}>
                    Informar {money(v.importe.total)} al cliente
                  </Boton>
                )}
                {v.importe.total <= 0 && <p className="text-xs">La orden no tiene importe: cargá los trabajos y repuestos primero.</p>}
              </div>
            </Aviso>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-tenue">
                {v.importe.informado ? `Importe informado al cliente el ${fecha(v.importe.informado.at)}${v.importe.informado.por ? ` por ${v.importe.informado.por}` : ''}.` : `Importe confirmado por el comprobante interno #${numero(v.importe.comprobante!.numero)}: el cliente lo ve.`}
              </span>
              {v.importe.informado && !v.importe.comprobante && v.puede.informar && (
                <Boton tam="sm" variante="fantasma" cargando={informar.isPending} onClick={async () => { if (await confirmar('Retirar el importe de la página del cliente', 'El cliente volverá a ver «Importe pendiente de confirmación» y no podrá enviar comprobantes hasta que lo informes de nuevo. Lo ya enviado se conserva.', true)) informar.mutate(false); }}>
                  Retirar importe
                </Boton>
              )}
            </div>
          )}
          {v.importe.informado?.importe_cambio && <AvisoCambio c={v.importe.informado.importe_cambio} que="desde que lo informaste" />}
          {!v.seguimiento_activo && !cerrada && <Aviso tono="ambar">El seguimiento de esta orden está desactivado: el cliente no puede abrir su página, elegir cómo pagar ni enviar comprobantes.</Aviso>}

          {/* Medio elegido */}
          {v.eleccion ? (
            <div className="space-y-2 rounded-card border border-borde p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  {v.eleccion.medio === 'efectivo' ? <Banknote className="size-4 text-marca-700" /> : <Landmark className="size-4 text-marca-700" />}
                  Medio elegido: {MEDIO_PORTAL_LABEL[v.eleccion.medio]}
                </div>
                <span className="text-xs text-tenue">{fechaHora(v.eleccion.at)}</span>
              </div>
              <p className="text-sm">{v.estado.detalle}</p>
              <p className="text-xs text-tenue">Al elegir, faltaba cobrar {money(v.eleccion.importe_pendiente)} de {money(v.eleccion.importe_total)}.</p>
              {v.eleccion.importe_cambio && <AvisoCambio c={v.eleccion.importe_cambio} que="después de que el cliente eligió" />}
              {v.eleccion.medio === 'efectivo' && v.importe.pendiente > 0 && puede('cobros.registrar') && onCobrar && (
                <div className="pt-1"><Boton tam="sm" variante="primario" icono={<Banknote className="size-4" />} onClick={onCobrar}>Registrar el cobro</Boton><p className="mt-1 text-xs text-tenue">La elección de efectivo no cobra nada: cuando el cliente entregue el dinero, registralo con el cobro de siempre.</p></div>
              )}
              {v.historial_elecciones.length > 1 && (
                <details className="text-xs text-tenue">
                  <summary className="cursor-pointer py-1">Historial de elecciones ({v.historial_elecciones.length})</summary>
                  <ul className="space-y-0.5 pt-1">{v.historial_elecciones.map((h, i) => <li key={i}>{fechaHora(h.at)} · {MEDIO_PORTAL_LABEL[h.medio]} ({h.estado === 'confirmado' ? 'confirmó' : 'eligió'}) · faltaba {money(h.importe_pendiente)}</li>)}</ul>
                </details>
              )}
            </div>
          ) : v.importe.confirmado && !cerrada ? (
            <p className="text-sm text-tenue">El cliente todavía no eligió cómo va a pagar.</p>
          ) : null}

          {/* Comprobantes */}
          <section aria-labelledby="pc-comp" className="space-y-2">
            <h3 id="pc-comp" className="text-sm font-semibold">Comprobantes de transferencia{v.comprobantes.length ? ` (${v.comprobantes.length})` : ''}</h3>
            {pendientes > 0 && <Aviso tono="ambar">{pendientes === 1 ? 'Hay 1 comprobante esperando verificación.' : `Hay ${pendientes} comprobantes esperando verificación.`} Un comprobante no demuestra que el dinero ingresó: revisá tu cuenta antes de confirmar.</Aviso>}
            {v.comprobantes.length === 0 ? (
              <p className="text-sm text-tenue">El cliente todavía no envió ningún comprobante.</p>
            ) : (
              <ul className="space-y-2">
                {v.comprobantes.map((c) => (
                  <li key={c.id} className="rounded-card border border-borde p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <Insignia tono={TONO_COMP[c.estado]}>{ROTULO_COMP[c.estado]}</Insignia>
                        <span className="text-xs text-tenue">{fechaHora(c.at)}</span>
                      </div>
                      <span className="text-xs text-tenue">{tamano(c.bytes)} · {c.mime === 'application/pdf' ? 'PDF' : 'Imagen'}</span>
                    </div>
                    {c.nombre && <p className="mt-1 truncate text-xs text-tenue" title={c.nombre}>Archivo: {c.nombre}</p>}
                    <p className="mt-1 text-xs text-tenue">Al enviarlo, faltaban {money(c.importe_pendiente)}.</p>
                    {c.importe_cambio && <div className="mt-2"><AvisoCambio c={c.importe_cambio} que="después de que el cliente envió este comprobante" /></div>}
                    {c.estado === 'rechazado' && <p className="mt-1 text-sm">Motivo del rechazo: <span className="font-medium">{c.motivo_rechazo}</span><span className="text-xs text-tenue"> · {c.revisado_por ?? 'Sistema'} · {c.revisado_at ? fechaHora(c.revisado_at) : ''}</span></p>}
                    {c.estado === 'confirmado' && (
                      <p className="mt-1 text-sm">
                        {c.vinculo === 'existente' ? 'Reconocido con un cobro ya registrado' : 'Cobro registrado'}{c.cobro ? ` (recibo #${numero(c.cobro.numero)}${c.cobro.anulado ? ' · ANULADO' : ''})` : ''}: <span className="font-medium tabular-nums">{money(c.importe_confirmado)}</span>
                        <span className="text-xs text-tenue"> · {c.revisado_por ?? 'Sistema'} · {c.revisado_at ? fechaHora(c.revisado_at) : ''}</span>
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-2">
                      <a href={`/api/ordenes/${orden.id}/comprobantes/${c.id}/archivo`} target="_blank" rel="noreferrer noopener" className="contents"><Boton tam="sm" icono={<Eye className="size-4" />}>Ver comprobante</Boton></a>
                      <a href={`/api/ordenes/${orden.id}/comprobantes/${c.id}/archivo?descargar=1`} className="contents"><Boton tam="sm" variante="fantasma" icono={<Download className="size-4" />}>Descargar</Boton></a>
                      {c.estado === 'pendiente' && v.puede.resolver && (
                        <>
                          <Boton tam="sm" variante="exito" icono={<IconoCheck className="size-4" />} onClick={() => setConfirmando(c)}>Confirmar cobro</Boton>
                          <Boton tam="sm" variante="peligro" icono={<X className="size-4" />} onClick={() => setRechazando(c)}>Rechazar comprobante</Boton>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {pendientes > 0 && !v.puede.resolver && <p className="text-xs text-tenue">Para confirmar o rechazar hace falta el permiso «Registrar cobros».</p>}
          </section>
        </div>
      </Tarjeta>
      {confirmando && <ModalConfirmar vista={v} comprobante={confirmando} ordenId={orden.id} onCerrar={() => setConfirmando(null)} onListo={() => { setConfirmando(null); refrescar(); }} />}
      {rechazando && <ModalRechazar comprobante={rechazando} ordenId={orden.id} onCerrar={() => setRechazando(null)} onListo={() => { setRechazando(null); refrescar(); }} />}
    </>
  );
}

function ModalConfirmar({ vista, comprobante, ordenId, onCerrar, onListo }: { vista: VistaPago; comprobante: Comprobante; ordenId: string; onCerrar: () => void; onListo: () => void }) {
  const { puede } = useAuth();
  const toast = useToast();
  const [modo, setModo] = useState<'nuevo' | 'existente'>('nuevo');
  const [importe, setImporte] = useState(vista.importe.pendiente);
  const [cuenta, setCuenta] = useState(vista.cuenta?.id ?? '');
  const [cobroId, setCobroId] = useState(vista.cobros_vinculables[0]?.id ?? '');
  const { data: cuentas = [] } = useQuery({ queryKey: ['bancos', 'selector'], queryFn: () => api.get<Array<{ id: string; nombre: string; banco: string; alias: string | null }>>('/bancos/selector'), enabled: puede('caja.operar') });
  const opciones = cuentas.length ? cuentas : vista.cuenta ? [{ id: vista.cuenta.id, nombre: vista.cuenta.banco, banco: vista.cuenta.banco, alias: vista.cuenta.alias }] : [];
  const sinSaldo = vista.importe.pendiente <= 0;
  const excede = modo === 'nuevo' && importe > vista.importe.pendiente;
  const mut = useMutation({
    mutationFn: () => api.post(`/ordenes/${ordenId}/comprobantes/${comprobante.id}/confirmar`, modo === 'existente' ? { cobro_id: cobroId } : { importe, cuenta_id: cuenta || undefined }),
    onSuccess: (r: any) => { toast.ok(r.duplicado ? 'Ese comprobante ya estaba confirmado' : modo === 'existente' ? 'Comprobante enlazado al cobro registrado' : 'Cobro registrado'); onListo(); },
    onError: toast.error,
  });
  const listo = modo === 'existente' ? !!cobroId : importe > 0 && !excede && !!cuenta;
  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo="Confirmar cobro por transferencia"
      pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="exito" disabled={!listo} cargando={mut.isPending} onClick={() => mut.mutate()}>{modo === 'existente' ? 'Enlazar al cobro' : 'Confirmar cobro'}</Boton></>}
    >
      <div className="space-y-4 text-sm">
        <Aviso tono="ambar">Confirmá sólo si verificaste en tu cuenta que el dinero <strong>ingresó</strong>. El comprobante del cliente no lo demuestra. Una vez confirmado queda registrado quién y cuándo, y no se puede deshacer desde acá (un cobro se anula desde Cobros).</Aviso>
        {comprobante.importe_cambio && <AvisoCambio c={comprobante.importe_cambio} que="desde que el cliente envió el comprobante" />}
        <dl className="grid grid-cols-3 gap-3">
          <div><dt className="text-xs text-tenue">Importe total</dt><dd className="font-semibold tabular-nums">{money(vista.importe.total)}</dd></div>
          <div><dt className="text-xs text-tenue">Abonado</dt><dd className="font-semibold tabular-nums">{money(vista.importe.abonado)}</dd></div>
          <div><dt className="text-xs text-tenue">Saldo pendiente</dt><dd className="font-semibold tabular-nums">{money(vista.importe.pendiente)}</dd></div>
        </dl>
        {vista.cobros_vinculables.length > 0 && (
          <div className="space-y-1">
            <label className="flex items-center gap-2"><input type="radio" className="accent-marca-600" checked={modo === 'nuevo'} onChange={() => setModo('nuevo')} /> Registrar un cobro nuevo</label>
            <label className="flex items-center gap-2"><input type="radio" className="accent-marca-600" checked={modo === 'existente'} onChange={() => setModo('existente')} /> Esa transferencia ya la registré: reconocer el cobro existente</label>
          </div>
        )}
        {modo === 'nuevo' ? (
          <div className="space-y-3">
            {sinSaldo && <Aviso tono="rojo">La orden no tiene saldo pendiente. Si este comprobante es repetido, rechazalo.</Aviso>}
            <Campo label="Importe recibido" hint={`Hasta el saldo pendiente (${money(vista.importe.pendiente)}). Si recibiste menos, es un pago parcial.`} error={excede ? 'Supera el saldo pendiente' : null}>
              <InputMoneda value={importe} onChange={setImporte} />
            </Campo>
            <Campo label="Cuenta bancaria donde se acreditó" hint={vista.cuenta ? `Cuenta publicada en el portal: ${vista.cuenta.banco}${vista.cuenta.alias ? ` · ${vista.cuenta.alias}` : ''}` : 'Elegí la cuenta del taller que recibió la transferencia'}>
              <Select value={cuenta} onChange={(e) => setCuenta(e.target.value)}>
                <option value="">Elegir cuenta…</option>
                {opciones.map((c) => <option key={c.id} value={c.id}>{c.nombre}{c.alias ? ` · ${c.alias}` : ''}</option>)}
              </Select>
            </Campo>
            <p className="text-xs text-tenue">{vista.importe.comprobante ? `Se aplica al comprobante interno #${numero(vista.importe.comprobante.numero)}.` : 'Como la orden todavía no tiene comprobante, se registra como anticipo de esta orden y se imputa al emitirlo.'} Impacta en la caja y en la cuenta elegida, y genera su asiento contable.</p>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {vista.cobros_vinculables.map((c) => (
              <li key={c.id}>
                <label className="flex items-start gap-2 rounded-card border border-borde p-2.5">
                  <input type="radio" className="mt-1 accent-marca-600" checked={cobroId === c.id} onChange={() => setCobroId(c.id)} />
                  <span>Recibo #{numero(c.numero)} · {fecha(c.fecha)} · {c.tipo === 'anticipo' ? 'anticipo' : 'cobro'}<br /><span className="text-xs text-tenue">Transferencia de {money(c.transferido)}. No se crea ni se contabiliza nada nuevo.</span></span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

function ModalRechazar({ comprobante, ordenId, onCerrar, onListo }: { comprobante: Comprobante; ordenId: string; onCerrar: () => void; onListo: () => void }) {
  const toast = useToast();
  const [motivo, setMotivo] = useState('');
  const mut = useMutation({
    mutationFn: () => api.post(`/ordenes/${ordenId}/comprobantes/${comprobante.id}/rechazar`, { motivo: motivo.trim() }),
    onSuccess: () => { toast.ok('Comprobante rechazado. El cliente verá el motivo y podrá enviar otro.'); onListo(); },
    onError: toast.error,
  });
  const ok = motivo.trim().length >= LIMITES_COMPROBANTE.motivoMin;
  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo="Rechazar comprobante"
      pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="peligro" disabled={!ok} cargando={mut.isPending} onClick={() => mut.mutate()}>Rechazar comprobante</Boton></>}
    >
      <div className="space-y-3 text-sm">
        <p>El cliente va a ver este motivo en su página y va a poder enviar otro comprobante. El rechazado queda guardado en el historial.</p>
        <Campo label="Motivo del rechazo" requerido>
          <Textarea rows={3} maxLength={LIMITES_COMPROBANTE.motivoMax} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ej.: La transferencia no figura en la cuenta del taller" autoFocus />
        </Campo>
        <div className="flex flex-wrap gap-1.5">
          {MOTIVOS_RAPIDOS.map((m) => <button key={m} type="button" className="rounded-full border border-borde px-2.5 py-1 text-xs hover:bg-slate-50" onClick={() => setMotivo(m)}>{m}</button>)}
        </div>
      </div>
    </Modal>
  );
}

// ───────────── Aviso discreto de comprobantes pendientes ─────────────
/** Comprobantes de transferencia esperando verificación (sólo para quien ve órdenes y ventas). Se vuelve a leer cada minuto; no hay notificaciones externas. */
export function usePagosPendientes() {
  const { puede } = useAuth();
  return useQuery({
    queryKey: ['ordenes', 'pagos-pendientes'],
    queryFn: () => api.get<{ total: number; ordenes: Array<{ id: string; numero: number; patente: string; cantidad: number; desde: string }> }>('/ordenes/pagos/pendientes'),
    enabled: puede('ordenes.ver') && puede('ventas.ver'),
    refetchInterval: 60_000,
  });
}
