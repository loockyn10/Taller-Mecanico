// Devoluciones parciales (nota de crédito interna), anticipos de clientes y saldo a favor.
// Cada operación que mueve dinero, stock o cuenta corriente muestra sus consecuencias ANTES de confirmarse.
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Plus, Printer, Trash2, Undo2 } from 'lucide-react';
import { api, nuevaClave } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { invalidarDinero } from '@/lib/caja';
import { cantidad as fmtCant, fecha, hoyISO, money, numero } from '@/lib/format';
import { MEDIO_PAGO_LABEL, MOTIVO_DEVOLUCION_LABEL, MOTIVOS_DEVOLUCION, type MedioPago, type MotivoDevolucion } from '@shared/dominio';
import { Aviso, Boton, Campo, Check, Input, InputMoneda, Modal, Select, Textarea, useToast } from './ui';
import { CamposMedio, errorMedio, extraAPayload, SelectorMedio } from './MedioPago';
import { AvisoCaja, FormaPago, formaVacia, useCajaBloqueada, type FormaPagoUI } from './Cobro';
import { SelectorCliente, type ClienteMin } from './selectores';
import { useDepositos } from './SelectorDeposito';

// ───────────── Formas de pago de un reintegro (sin cheques) ─────────────
function FormaReintegro({ x, onChange, onQuitar, soloUna }: { x: FormaPagoUI; onChange: (v: FormaPagoUI) => void; onQuitar: () => void; soloUna: boolean }) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[1fr_140px_auto] gap-2 sm:grid-cols-[180px_1fr_160px_auto]">
        <SelectorMedio value={x.medio} onChange={(medio) => onChange({ ...x, medio })} excluir={['cheque']} />
        <Input className="col-span-3 row-start-2 sm:col-span-1 sm:row-start-auto" placeholder="Referencia (N° de operación…)" value={x.referencia} onChange={(e) => onChange({ ...x, referencia: e.target.value })} aria-label="Referencia" />
        <InputMoneda value={x.importe} onChange={(v) => onChange({ ...x, importe: v })} />
        <Boton variante="fantasma" disabled={soloUna} onClick={onQuitar} icono={<Trash2 className="size-4" />} aria-label="Quitar forma de pago" />
      </div>
      <CamposMedio medio={x.medio} valor={x.extra} onChange={(extra) => onChange({ ...x, extra })} ctx="gasto" importe={x.importe} />
    </div>
  );
}

const mediosParaApi = (medios: FormaPagoUI[]) =>
  medios.map((x) => ({ medio: x.medio, importe: x.importe, referencia: x.referencia.trim() || null, ...extraAPayload(x.medio, x.extra, 'gasto') }));

function EditorReintegro({ medios, onChange, maximo }: { medios: FormaPagoUI[]; onChange: (m: FormaPagoUI[]) => void; maximo: number }) {
  const total = medios.reduce((a, m) => a + m.importe, 0);
  return (
    <div className="space-y-2">
      {medios.map((x, i) => (
        <FormaReintegro key={i} x={x} soloUna={medios.length === 1} onChange={(v) => onChange(medios.map((y, j) => (j === i ? v : y)))} onQuitar={() => onChange(medios.filter((_, j) => j !== i))} />
      ))}
      <Boton tam="sm" variante="fantasma" icono={<Plus className="size-4" />} onClick={() => onChange([...medios, formaVacia('transferencia', Math.max(0, maximo - total))])}>Agregar forma de pago</Boton>
      {total > maximo && <p className="text-sm text-red-600">Los medios suman {money(total)} y el máximo a reintegrar es {money(maximo)}.</p>}
    </div>
  );
}

const MEDIOS_LABEL = (medios: string | null | undefined) => (medios ? medios.split(',').map((m) => MEDIO_PAGO_LABEL[m as MedioPago] ?? m).join(', ') : '—');

// ───────────── Devolución parcial de un comprobante ─────────────
interface LineaUI { cantidad: number; importe: number | null; reingresa: boolean; deposito: string }

export function ModalDevolucion({ ventaId, onCerrar }: { ventaId: string; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useAuth();
  const bloqueada = useCajaBloqueada();
  const { data: depositos = [] } = useDepositos();
  const activos = depositos.filter((d) => d.activo);
  const { data: info, isLoading, error } = useQuery({ queryKey: ['devolvible', ventaId], queryFn: () => api.get<any>(`/ventas/${ventaId}/devolvible`) });
  const [sel, setSel] = useState<Record<string, LineaUI>>({});
  const [motivoTipo, setMotivoTipo] = useState<MotivoDevolucion>('repuesto_incorrecto');
  const [detalle, setDetalle] = useState('');
  const [reintegrar, setReintegrar] = useState(false);
  const [medios, setMedios] = useState<FormaPagoUI[]>([formaVacia('efectivo', 0)]);
  const [clave] = useState(nuevaClave());
  const [hecha, setHecha] = useState<{ id: string; numero: number } | null>(null);
  const [ajustando, setAjustando] = useState<Record<string, boolean>>({});

  const lineas: any[] = info?.lineas ?? [];
  const motivo = `${MOTIVO_DEVOLUCION_LABEL[motivoTipo]}${detalle.trim() ? ` — ${detalle.trim()}` : ''}`;
  const items = Object.entries(sel).filter(([, l]) => l.cantidad > 0).map(([venta_item_id, l]) => ({
    venta_item_id, cantidad: l.cantidad, importe: l.importe, reingresa: l.reingresa, deposito_id: l.reingresa && l.deposito ? l.deposito : null,
  }));
  const puedeReintegrar = puede('cobros.anular');
  const cuerpoBase = { venta_id: ventaId, motivo, items };

  // La simulación calcula en el servidor las mismas cifras que se registrarán (sin guardar nada).
  const cuerpoSim = { ...cuerpoBase, reintegro: reintegrar && medios.every((m) => m.importe > 0) ? { medios: mediosParaApi(medios) } : null };
  const sim = useQuery({
    queryKey: ['devolucion-simulacion', JSON.stringify(cuerpoSim)],
    queryFn: () => api.post<any>('/devoluciones/simular', cuerpoSim),
    enabled: items.length > 0 && motivo.length >= 3,
    retry: false,
    staleTime: 0,
  });
  const c = sim.data;
  const yaPagado: number = c?.credito.ya_pagado ?? 0;

  // Al aparecer dinero ya cobrado, se propone reintegrarlo; sin dinero cobrado no hay nada que reintegrar.
  useEffect(() => {
    if (!c) return;
    if (yaPagado === 0 && reintegrar) setReintegrar(false);
    if (reintegrar && medios.length === 1 && medios[0].importe === 0) setMedios([{ ...medios[0], importe: yaPagado }]);
  }, [yaPagado, reintegrar]); // eslint-disable-line react-hooks/exhaustive-deps
  const consumidorFinal = !!info?.cliente?.consumidor_final;
  useEffect(() => {
    if (consumidorFinal && yaPagado > 0 && !reintegrar) {
      setReintegrar(true);
      setMedios([formaVacia('efectivo', yaPagado)]);
    }
  }, [consumidorFinal, yaPagado]); // eslint-disable-line react-hooks/exhaustive-deps

  const errorMediosForma = medios.map((m) => errorMedio(m.medio as MedioPago, m.referencia, m.extra, 'gasto')).find(Boolean) ?? null;
  const totalMedios = medios.reduce((a, m) => a + m.importe, 0);
  const reintegroOk = !reintegrar || (totalMedios > 0 && totalMedios <= yaPagado && (!consumidorFinal || totalMedios === yaPagado) && !errorMediosForma && !bloqueada);
  const valido = items.length > 0 && motivo.length >= 3 && !!c && !sim.isFetching && reintegroOk;

  const confirmar = useMutation({
    mutationFn: () => api.post<any>('/devoluciones', { ...cuerpoSim, idem_key: clave }),
    onSuccess: (r) => {
      invalidarDinero(qc);
      toast.ok(r.duplicado ? 'La devolución ya estaba registrada' : `Devolución #${numero(r.numero)} registrada`);
      setHecha({ id: r.id, numero: r.numero });
    },
    onError: toast.error,
  });

  const fijar = (id: string, cambio: Partial<LineaUI> | null, linea: any) =>
    setSel((s) => {
      const n = { ...s };
      if (cambio === null) delete n[id];
      else { const base: LineaUI = s[id] ?? { cantidad: linea.restante, importe: null, reingresa: linea.tipo === 'articulo', deposito: '' }; n[id] = { ...base, ...cambio }; }
      return n;
    });
  const infoLinea = (id: string) => c?.lineas.find((l: any) => l.venta_item_id === id);

  if (hecha) {
    return (
      <Modal abierto onCerrar={onCerrar} titulo="Devolución registrada" ancho="sm" pie={<><Boton onClick={onCerrar}>Cerrar</Boton><Boton variante="primario" icono={<Printer className="size-4" />} onClick={() => window.open(`/imprimir/devolucion/${hecha.id}`, '_blank')}>Imprimir nota de crédito interna</Boton></>}>
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <CheckCircle2 className="size-10 text-emerald-600" />
          <p className="font-semibold">Nota de crédito interna N° {numero(hecha.numero)}</p>
          <p className="text-sm text-tenue">El comprobante original no se modificó. El stock, la caja y la cuenta corriente del cliente ya reflejan la devolución.</p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo={`Devolución del comprobante #${numero(info?.venta?.numero ?? 0)}`}
      ancho="xl"
      pie={
        <>
          <Boton onClick={onCerrar}>Cancelar</Boton>
          <Boton variante="primario" icono={<Undo2 className="size-4" />} disabled={!valido} cargando={confirmar.isPending} onClick={() => confirmar.mutate()}>
            Confirmar devolución {c ? money(c.credito.total) : ''}
          </Boton>
        </>
      }
    >
      {isLoading ? <p className="text-sm text-tenue">Cargando…</p> : error ? <Aviso tono="rojo">{(error as Error).message}</Aviso> : (
        <div className="space-y-5">
          <Aviso>Nota de crédito <strong>interna (no fiscal)</strong>. Se registra aparte: el comprobante original no se modifica ni se borra.</Aviso>
          <div>
            <h3 className="mb-2 text-sm font-semibold">1. Qué se devuelve</h3>
            <ul className="divide-y divide-borde rounded-ctl border border-borde">
              {lineas.map((l) => {
                const agotada = l.restante <= 0;
                const x = sel[l.venta_item_id];
                const ci = x ? infoLinea(l.venta_item_id) : null;
                return (
                  <li key={l.venta_item_id} className={`px-3 py-2.5 text-sm ${agotada ? 'bg-slate-50 text-tenue' : ''}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Check
                        checked={!!x}
                        disabled={agotada}
                        onChange={(v) => fijar(l.venta_item_id, v ? {} : null, l)}
                        label={<span><span className="font-medium">{l.descripcion}</span><span className="text-tenue"> · {l.tipo === 'articulo' ? 'repuesto' : 'servicio'} · vendido {fmtCant(l.cantidad)}{l.devuelta > 0 ? ` · ya devuelto ${fmtCant(l.devuelta)}` : ''}{agotada ? ' · devuelto por completo' : ''}</span></span>}
                      />
                      {x && (
                        <div className="flex flex-wrap items-center gap-2">
                          <label className="flex items-center gap-1.5 text-xs text-tenue">Cantidad
                            <Input type="number" min={0} max={l.restante} step="any" value={x.cantidad} onChange={(e) => fijar(l.venta_item_id, { cantidad: Math.min(l.restante, Math.max(0, Math.round(Number(e.target.value) * 1000) / 1000)) }, l)} className="h-9 w-24 text-right" aria-label={`Cantidad a devolver de ${l.descripcion}`} />
                          </label>
                          <span className="w-28 text-right tabular-nums">{ci ? money(ci.importe) : '…'}</span>
                          <Boton tam="sm" variante="fantasma" onClick={() => { setAjustando((a) => ({ ...a, [l.venta_item_id]: !a[l.venta_item_id] })); if (ajustando[l.venta_item_id]) fijar(l.venta_item_id, { importe: null }, l); }}>{ajustando[l.venta_item_id] ? 'Importe automático' : 'Ajustar importe'}</Boton>
                        </div>
                      )}
                    </div>
                    {x && ajustando[l.venta_item_id] && (
                      <div className="mt-2 flex flex-wrap items-center gap-2 pl-6 text-xs text-tenue">
                        <span>Importe a acreditar (máximo {money(l.importe_restante)}):</span>
                        <InputMoneda value={x.importe ?? 0} onChange={(v) => fijar(l.venta_item_id, { importe: Math.min(v, l.importe_restante) }, l)} className="w-40" />
                      </div>
                    )}
                    {x && l.tipo === 'articulo' && (
                      <div className="mt-2 flex flex-wrap items-center gap-3 pl-6 text-xs">
                        <Select value={x.reingresa ? 'si' : 'no'} onChange={(e) => fijar(l.venta_item_id, { reingresa: e.target.value === 'si' }, l)} className="h-9 w-auto" aria-label="Destino de la mercadería">
                          <option value="si">Vuelve físicamente al inventario</option>
                          <option value="no">No vuelve (dañado, instalado o descartado)</option>
                        </Select>
                        {x.reingresa && activos.length > 1 && (
                          <Select value={x.deposito} onChange={(e) => fijar(l.venta_item_id, { deposito: e.target.value }, l)} className="h-9 w-auto" aria-label="Depósito de destino">
                            <option value="">{activos.find((d) => d.es_principal)?.nombre ?? 'Depósito principal'} (predeterminado)</option>
                            {activos.filter((d) => !d.es_principal).map((d) => <option key={d.id} value={d.id}>{d.nombre}</option>)}
                          </Select>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Campo label="Motivo" requerido>
              <Select value={motivoTipo} onChange={(e) => setMotivoTipo(e.target.value as MotivoDevolucion)}>
                {MOTIVOS_DEVOLUCION.map((m) => <option key={m} value={m}>{MOTIVO_DEVOLUCION_LABEL[m]}</option>)}
              </Select>
            </Campo>
            <Campo label="Detalle (opcional)"><Textarea rows={1} value={detalle} onChange={(e) => setDetalle(e.target.value)} /></Campo>
          </div>

          {sim.error && items.length > 0 && <Aviso tono="rojo">{(sim.error as Error).message}</Aviso>}

          {c && !sim.error && (
            <>
              {yaPagado > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold">2. Dinero ya cobrado: {money(yaPagado)}</h3>
                  {puedeReintegrar ? (
                    <div className="space-y-3 rounded-ctl border border-borde p-3">
                      <div className="flex flex-wrap gap-4">
                        <label className="flex items-center gap-2 text-sm"><input type="radio" className="accent-marca-600" checked={!reintegrar} disabled={consumidorFinal} onChange={() => setReintegrar(false)} /> Dejar como saldo a favor del cliente</label>
                        <label className="flex items-center gap-2 text-sm"><input type="radio" className="accent-marca-600" checked={reintegrar} onChange={() => { setReintegrar(true); setMedios([formaVacia('efectivo', yaPagado)]); }} /> Reintegrar dinero ahora</label>
                      </div>
                      {consumidorFinal && <p className="text-xs text-tenue">“Consumidor final” no tiene cuenta corriente: el dinero cobrado se reintegra por completo.</p>}
                      {reintegrar && (
                        <>
                          <AvisoCaja />
                          <EditorReintegro medios={medios} onChange={setMedios} maximo={yaPagado} />
                          {errorMediosForma && <p className="text-sm text-red-600">{errorMediosForma}</p>}
                          {totalMedios < yaPagado && !consumidorFinal && <p className="text-xs text-tenue">Los {money(yaPagado - totalMedios)} restantes quedan como saldo a favor del cliente.</p>}
                        </>
                      )}
                    </div>
                  ) : (
                    <Aviso tono="ambar">Todo lo cobrado queda como saldo a favor del cliente. Reintegrar dinero requiere permiso para anular cobros.</Aviso>
                  )}
                </div>
              )}

              <div>
                <h3 className="mb-2 text-sm font-semibold">{yaPagado > 0 ? '3' : '2'}. Consecuencias — revisalas antes de confirmar</h3>
                <div className="grid gap-3 text-sm sm:grid-cols-2">
                  <div className="rounded-ctl bg-slate-50 p-3">
                    <p className="text-xs font-semibold uppercase text-tenue">Comprobante #{numero(c.comprobante.numero)}</p>
                    <p>Total {money(c.comprobante.total)} (no cambia) · devuelto {money(c.comprobante.devuelto_antes)} → <strong>{money(c.comprobante.devuelto_despues)}</strong></p>
                    <p>Saldo pendiente {money(c.comprobante.saldo_antes)} → <strong>{money(c.comprobante.saldo_despues)}</strong></p>
                    <p>Crédito de esta nota: <strong>{money(c.credito.total)}</strong> ({money(c.credito.cancela_deuda)} cancela deuda{c.credito.ya_pagado > 0 ? `, ${money(c.credito.ya_pagado)} ya cobrado` : ''})</p>
                  </div>
                  <div className="rounded-ctl bg-slate-50 p-3">
                    <p className="text-xs font-semibold uppercase text-tenue">Cuenta corriente de {c.cuenta_corriente.cliente}</p>
                    <p>Saldo {money(c.cuenta_corriente.saldo_antes)} → <strong>{money(c.cuenta_corriente.saldo_despues)}</strong></p>
                    {c.cuenta_corriente.saldo_despues < 0 && <p className="text-xs text-tenue">Un saldo negativo es saldo a favor del cliente.</p>}
                  </div>
                  <div className="rounded-ctl bg-slate-50 p-3">
                    <p className="text-xs font-semibold uppercase text-tenue">Dinero</p>
                    {c.dinero.reintegro > 0 ? (
                      <>
                        <p>Se reintegra <strong>{money(c.dinero.reintegro)}</strong>{c.dinero.por_medio.map((m: any) => ` · ${MEDIO_PAGO_LABEL[m.medio as MedioPago]} ${money(m.importe)}`).join('')}</p>
                        <p className="text-xs text-tenue">Sale de la caja y de las cuentas elegidas.</p>
                      </>
                    ) : <p>No sale dinero.</p>}
                    {c.dinero.saldo_a_favor > 0 && <p>Queda a favor del cliente: <strong>{money(c.dinero.saldo_a_favor)}</strong></p>}
                  </div>
                  <div className="rounded-ctl bg-slate-50 p-3">
                    <p className="text-xs font-semibold uppercase text-tenue">Stock</p>
                    {c.stock.reingresan.length === 0 && c.stock.no_reingresan.length === 0 && <p>No hay repuestos en esta devolución.</p>}
                    {c.stock.reingresan.map((s: any, i: number) => <p key={i}>+{fmtCant(s.cantidad)} {s.descripcion} → {s.deposito}</p>)}
                    {c.stock.no_reingresan.map((s: any, i: number) => <p key={i} className="text-tenue">{fmtCant(s.cantidad)} {s.descripcion}: no vuelve al inventario</p>)}
                  </div>
                </div>
                {c.avisos.map((a: string, i: number) => <Aviso key={i} tono="ambar" className="mt-3">{a}</Aviso>)}
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

// ───────────── Aplicar saldo a favor (anticipos y créditos de devoluciones) a un comprobante ─────────────
export function ModalAplicarCreditos({ venta, onCerrar }: { venta: { id: string; cliente_id: string; numero: number; saldo: number; orden_id?: string | null }; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ['creditos', venta.cliente_id], queryFn: () => api.get<any>(`/creditos?cliente_id=${venta.cliente_id}`) });
  const creditos: any[] = data?.creditos ?? [];
  const [sel, setSel] = useState<Record<string, number>>({});
  const [clave] = useState(nuevaClave());
  const k = (c: any) => `${c.origen_tipo}:${c.origen_id}`;
  // Propone usar primero lo asociado a la misma orden y luego lo más antiguo, hasta cubrir el saldo.
  useEffect(() => {
    if (!creditos.length) return;
    let resto = venta.saldo;
    const ord = [...creditos].sort((a, b) => Number(b.orden_id === venta.orden_id && !!venta.orden_id) - Number(a.orden_id === venta.orden_id && !!venta.orden_id));
    const n: Record<string, number> = {};
    for (const c of ord) {
      if (resto <= 0) break;
      const u = Math.min(c.disponible, resto);
      n[k(c)] = u;
      resto -= u;
    }
    setSel(n);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = Object.values(sel).reduce((a, b) => a + b, 0);
  const m = useMutation({
    mutationFn: () => api.post(`/ventas/${venta.id}/aplicar-creditos`, {
      idem_key: clave,
      aplicaciones: creditos.filter((c) => (sel[k(c)] ?? 0) > 0).map((c) => ({ origen_tipo: c.origen_tipo, origen_id: c.origen_id, importe: sel[k(c)] })),
    }),
    onSuccess: () => { invalidarDinero(qc); toast.ok('Saldo a favor aplicado'); onCerrar(); },
    onError: toast.error,
  });
  return (
    <Modal abierto onCerrar={onCerrar} titulo={`Aplicar saldo a favor al comprobante #${numero(venta.numero)}`} ancho="lg"
      pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="exito" disabled={total <= 0 || total > venta.saldo} cargando={m.isPending} onClick={() => m.mutate()}>Aplicar {money(total)}</Boton></>}>
      {isLoading ? <p className="text-sm text-tenue">Cargando…</p> : creditos.length === 0 ? <Aviso>El cliente no tiene anticipos ni saldo a favor disponible.</Aviso> : (
        <div className="space-y-3">
          <Aviso>Aplicar saldo a favor <strong>no mueve dinero</strong>: el dinero ya ingresó cuando se cobró el anticipo o el comprobante original. Solo reduce la deuda de este comprobante (pendiente {money(venta.saldo)}).</Aviso>
          <ul className="divide-y divide-borde rounded-ctl border border-borde">
            {creditos.map((c) => (
              <li key={k(c)} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <Check
                  checked={(sel[k(c)] ?? 0) > 0}
                  onChange={(v) => setSel((s) => { const n = { ...s }; if (v) n[k(c)] = Math.min(c.disponible, Math.max(0, venta.saldo - (total - (s[k(c)] ?? 0)))); else delete n[k(c)]; return n; })}
                  label={<span><span className="font-medium">{c.origen_tipo === 'anticipo' ? `Anticipo (recibo #${numero(c.numero)})` : `Crédito de la devolución #${numero(c.numero)}`}</span><span className="text-tenue"> · {fecha(c.fecha)}{c.orden_numero ? ` · OT #${numero(c.orden_numero)}` : ''}{c.presupuesto_numero ? ` · presupuesto #${numero(c.presupuesto_numero)}` : ''} · disponible {money(c.disponible)}</span></span>}
                />
                {(sel[k(c)] ?? 0) > 0 && <InputMoneda value={sel[k(c)]} onChange={(v) => setSel((s) => ({ ...s, [k(c)]: Math.min(v, c.disponible) }))} className="w-40" />}
              </li>
            ))}
          </ul>
          {total > venta.saldo && <p className="text-sm text-red-600">Lo aplicado supera el saldo pendiente del comprobante.</p>}
          <p className="text-xs text-tenue">Tras aplicar, el saldo pendiente del comprobante será {money(Math.max(0, venta.saldo - total))}.</p>
        </div>
      )}
    </Modal>
  );
}

// ───────────── Registrar un anticipo ─────────────
export function ModalAnticipo({ clienteFijo, ordenId, presupuestoId, onCerrar }: { clienteFijo?: ClienteMin | null; ordenId?: string | null; presupuestoId?: string | null; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useAuth();
  const bloqueada = useCajaBloqueada();
  const [cliente, setCliente] = useState<ClienteMin | null>(clienteFijo ?? null);
  const [medios, setMedios] = useState<FormaPagoUI[]>([formaVacia('efectivo', 0)]);
  const [fechaAnt, setFecha] = useState(hoyISO());
  const [notas, setNotas] = useState('');
  const [clave] = useState(nuevaClave());
  const [hecho, setHecho] = useState<{ id: string; numero: number; total: number } | null>(null);
  const total = medios.reduce((a, m) => a + m.importe, 0);
  const errorForma = medios.map((m) => errorMedio(m.medio as MedioPago, m.referencia, m.extra, 'cobro')).find(Boolean) ?? null;
  const valido = !!cliente && total > 0 && medios.every((m) => m.importe > 0) && !errorForma && !bloqueada;
  const m = useMutation({
    mutationFn: () => api.post<any>('/anticipos', {
      cliente_id: cliente!.id, fecha: fechaAnt, notas, idem_key: clave, orden_id: ordenId ?? null, presupuesto_id: presupuestoId ?? null,
      medios: medios.map((x) => ({ medio: x.medio, importe: x.importe, referencia: x.referencia.trim() || null, ...extraAPayload(x.medio, x.extra, 'cobro') })),
    }),
    onSuccess: (r) => { invalidarDinero(qc); toast.ok(r.duplicado ? 'El anticipo ya estaba registrado' : `Anticipo registrado (recibo #${numero(r.numero)})`); setHecho(r); },
    onError: toast.error,
  });
  if (hecho) {
    return (
      <Modal abierto onCerrar={onCerrar} titulo="Anticipo registrado" ancho="sm" pie={<><Boton onClick={onCerrar}>Cerrar</Boton><Boton variante="primario" icono={<Printer className="size-4" />} onClick={() => window.open(`/imprimir/recibo/${hecho.id}`, '_blank')}>Imprimir recibo</Boton></>}>
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <CheckCircle2 className="size-10 text-emerald-600" />
          <p className="font-semibold">Recibo de anticipo N° {numero(hecho.numero)} · {money(hecho.total)}</p>
          <p className="text-sm text-tenue">El dinero ingresó a la caja y quedó a favor del cliente. No es una venta: se aplica al comprobante cuando se facture el trabajo.</p>
        </div>
      </Modal>
    );
  }
  return (
    <Modal abierto onCerrar={onCerrar} titulo="Registrar anticipo de cliente" ancho="lg"
      pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="exito" disabled={!valido} cargando={m.isPending} onClick={() => m.mutate()}>Registrar anticipo {money(total)}</Boton></>}>
      <div className="space-y-4">
        <AvisoCaja />
        <Aviso>Un anticipo es dinero que el cliente entrega <strong>antes</strong> de la venta. No genera un comprobante: queda como saldo a favor en su cuenta corriente y se aplica después al comprobante del trabajo (total o parcialmente).</Aviso>
        {!clienteFijo && <SelectorCliente valor={cliente} onCambio={setCliente} />}
        {clienteFijo && <p className="text-sm">Cliente: <strong>{clienteFijo.nombre}</strong></p>}
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Forma de pago</h3>
          {medios.map((x, i) => (
            <FormaPago key={i} x={x} soloUna={medios.length === 1} onChange={(v) => setMedios(medios.map((y, j) => (j === i ? v : y)))} onQuitar={() => setMedios(medios.filter((_, j) => j !== i))} />
          ))}
          <Boton tam="sm" variante="fantasma" icono={<Plus className="size-4" />} onClick={() => setMedios([...medios, formaVacia('transferencia', 0)])}>Agregar forma de pago</Boton>
          {errorForma && <p className="text-sm text-red-600">{errorForma}</p>}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Campo label="Fecha" hint={puede('fechas.retroactivas') ? undefined : 'Sólo se puede registrar con la fecha de hoy'}>
            <Input type="date" value={fechaAnt} max={hoyISO()} disabled={!puede('fechas.retroactivas')} onChange={(e) => setFecha(e.target.value)} />
          </Campo>
          <Campo label="Notas"><Input value={notas} onChange={(e) => setNotas(e.target.value)} placeholder="Ej.: seña para repuestos" /></Campo>
        </div>
      </div>
    </Modal>
  );
}

// ───────────── Reintegrar dinero (saldo de una devolución o anticipo) ─────────────
export function ModalReintegro({ origen, onCerrar }: { origen: { tipo: 'anticipo' | 'devolucion'; id: string; numero: number; disponible: number }; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const bloqueada = useCajaBloqueada();
  const [medios, setMedios] = useState<FormaPagoUI[]>([formaVacia('efectivo', origen.disponible)]);
  const [motivo, setMotivo] = useState('');
  const [clave] = useState(nuevaClave());
  const total = medios.reduce((a, m) => a + m.importe, 0);
  const errorForma = medios.map((m) => errorMedio(m.medio as MedioPago, m.referencia, m.extra, 'gasto')).find(Boolean) ?? null;
  const valido = total > 0 && total <= origen.disponible && medios.every((m) => m.importe > 0) && !errorForma && !bloqueada && (origen.tipo === 'devolucion' || motivo.trim().length >= 3);
  const url = origen.tipo === 'anticipo' ? `/anticipos/${origen.id}/devolver` : `/devoluciones/${origen.id}/reintegrar`;
  const m = useMutation({
    mutationFn: () => api.post<any>(url, { medios: mediosParaApi(medios), idem_key: clave, ...(origen.tipo === 'anticipo' ? { motivo: motivo.trim() } : {}) }),
    onSuccess: () => { invalidarDinero(qc); toast.ok('Reintegro registrado'); onCerrar(); },
    onError: toast.error,
  });
  const hacia = useMemo(() => (origen.tipo === 'anticipo' ? `anticipo (recibo #${numero(origen.numero)})` : `devolución #${numero(origen.numero)}`), [origen]);
  return (
    <Modal abierto onCerrar={onCerrar} titulo="Devolver dinero al cliente" ancho="lg"
      pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="peligro" disabled={!valido} cargando={m.isPending} onClick={() => m.mutate()}>Devolver {money(total)}</Boton></>}>
      <div className="space-y-4">
        <AvisoCaja />
        <Aviso tono="ambar">Se devuelve dinero del {hacia}. Disponible: <strong>{money(origen.disponible)}</strong>. Sale de la caja (o de la cuenta elegida) y baja el saldo a favor del cliente.</Aviso>
        <EditorReintegro medios={medios} onChange={setMedios} maximo={origen.disponible} />
        {errorForma && <p className="text-sm text-red-600">{errorForma}</p>}
        {origen.tipo === 'anticipo' && <Campo label="Motivo" requerido><Input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ej.: el cliente canceló la reparación" /></Campo>}
      </div>
    </Modal>
  );
}

export { MEDIOS_LABEL };
