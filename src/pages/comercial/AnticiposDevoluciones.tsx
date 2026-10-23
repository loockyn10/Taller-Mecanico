// Pestañas "Anticipos" y "Devoluciones" de Cobranzas: consulta de anticipos pendientes/utilizados/devueltos y de las notas de crédito internas.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Ban, Printer, Undo2, Wallet } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { invalidarDinero } from '@/lib/caja';
import { fecha, hoyISO, money, numero, sumarDias } from '@/lib/format';
import { ESTADO_ANTICIPO_LABEL, type EstadoAnticipo } from '@shared/dominio';
import { Aviso, Boton, Buscador, Campo, Cargando, Dato, ErrorCaja, Input, Insignia, Modal, Select, Tabla, Tarjeta, useDebounce, useToast, Vacio } from '@/components/ui';
import { ModalAnticipo, ModalReintegro, MEDIOS_LABEL } from '@/components/Devolucion';

const TONO: Record<EstadoAnticipo, 'ambar' | 'azul' | 'verde' | 'violeta' | 'gris'> = { pendiente: 'ambar', parcial: 'azul', utilizado: 'verde', devuelto: 'violeta', anulado: 'gris' };

function Filtros({ desde, hasta, setDesde, setHasta, q, setQ, children }: any) {
  return (
    <div className="filtros mb-4 flex flex-wrap items-end gap-3">
      <Campo label="Desde"><Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} /></Campo>
      <Campo label="Hasta"><Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} /></Campo>
      {children}
      <Buscador value={q} onChange={setQ} placeholder="Cliente o número" className="min-w-48 flex-1" />
    </div>
  );
}

export function AnticiposTab() {
  const { puede } = useAuth();
  const [desde, setDesde] = useState(sumarDias(hoyISO(), -90));
  const [hasta, setHasta] = useState(hoyISO());
  const [estado, setEstado] = useState('todos');
  const [q, setQ] = useState('');
  const [nuevo, setNuevo] = useState(false);
  const [ver, setVer] = useState<string | null>(null);
  const dq = useDebounce(q);
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['anticipos', { desde, hasta, estado, dq }], queryFn: () => api.get<any[]>(`/anticipos${qs({ desde, hasta, estado, q: dq })}`) });
  const vigentes = data.filter((a) => a.estado === 'registrado');
  return (
    <>
      <Aviso className="mb-4">Un anticipo es dinero recibido <strong>antes</strong> de la venta. No es una venta ni se vuelve a contar como cobro cuando se aplica a un comprobante.</Aviso>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Insignia tono="verde" className="px-3 py-1 text-sm">Recibido: {money(vigentes.reduce((a, c) => a + c.total, 0))}</Insignia>
        <Insignia tono="ambar" className="px-3 py-1 text-sm">Pendiente de aplicar: {money(vigentes.reduce((a, c) => a + c.disponible, 0))}</Insignia>
        <Insignia className="px-3 py-1 text-sm">Aplicado a ventas: {money(vigentes.reduce((a, c) => a + c.credito_aplicado, 0))}</Insignia>
        <Insignia tono="violeta" className="px-3 py-1 text-sm">Devuelto: {money(vigentes.reduce((a, c) => a + c.devuelto, 0))}</Insignia>
        {puede('cobros.registrar') && <Boton variante="primario" icono={<Wallet className="size-4" />} className="ml-auto" onClick={() => setNuevo(true)}>Registrar anticipo</Boton>}
      </div>
      <Filtros desde={desde} hasta={hasta} setDesde={setDesde} setHasta={setHasta} q={q} setQ={setQ}>
        <Campo label="Estado"><Select value={estado} onChange={(e) => setEstado(e.target.value)} className="w-auto"><option value="todos">Vigentes</option><option value="pendientes">Pendientes de aplicar</option><option value="utilizados">Utilizados</option><option value="devueltos">Devueltos</option><option value="anulados">Anulados</option></Select></Campo>
      </Filtros>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={data}
            clave={(a) => a.id}
            onFila={(a) => setVer(a.id)}
            vacio={<Vacio icono={<Wallet className="size-5" />} titulo="Sin anticipos con esos filtros" />}
            columnas={[
              { clave: 'n', titulo: 'Recibo', render: (a) => <span className="font-medium">#{numero(a.numero)}</span>, movil: 'meta' },
              { clave: 'f', titulo: 'Fecha', render: (a) => fecha(a.fecha), movil: 'meta' },
              { clave: 'c', titulo: 'Cliente', render: (a) => a.cliente, movil: 'titulo' },
              { clave: 'v', titulo: 'Vinculado a', render: (a) => (a.orden_numero ? `OT #${numero(a.orden_numero)}` : a.presupuesto_numero ? `Presupuesto #${numero(a.presupuesto_numero)}` : '—'), movil: 'subtitulo' },
              { clave: 'e', titulo: 'Estado', render: (a) => <Insignia tono={TONO[a.estado_uso as EstadoAnticipo]}>{ESTADO_ANTICIPO_LABEL[a.estado_uso as EstadoAnticipo]}</Insignia>, movil: 'meta' },
              { clave: 'ap', titulo: 'Aplicado', alinear: 'derecha', render: (a) => money(a.credito_aplicado), movil: 'oculta' },
              { clave: 'dv', titulo: 'Devuelto', alinear: 'derecha', render: (a) => money(a.devuelto), movil: 'oculta' },
              { clave: 'di', titulo: 'Pendiente', alinear: 'derecha', render: (a) => money(a.disponible), movil: 'oculta' },
              { clave: 't', titulo: 'Recibido', alinear: 'derecha', render: (a) => <span className={a.estado === 'anulado' ? 'text-tenue line-through' : ''}>{money(a.total)}</span>, movil: 'derecha' },
            ]}
          />
        </Tarjeta>
      )}
      {nuevo && <ModalAnticipo onCerrar={() => setNuevo(false)} />}
      {ver && <DetalleAnticipo id={ver} onCerrar={() => setVer(null)} />}
    </>
  );
}

function DetalleAnticipo({ id, onCerrar }: { id: string; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useAuth();
  const [reintegro, setReintegro] = useState(false);
  const [anular, setAnular] = useState<{ tipo: 'aplicacion' | 'reintegro' | 'anticipo'; id: string } | null>(null);
  const [motivo, setMotivo] = useState('');
  const { data: a, isLoading, error } = useQuery({ queryKey: ['anticipos', 'detalle', id], queryFn: () => api.get<any>(`/anticipos/${id}`) });
  const m = useMutation({
    mutationFn: () => api.post(anular!.tipo === 'aplicacion' ? `/credito-aplicaciones/${anular!.id}/anular` : anular!.tipo === 'reintegro' ? `/reintegros/${anular!.id}/anular` : `/cobros/${anular!.id}/anular`, { motivo }),
    onSuccess: () => { invalidarDinero(qc); qc.invalidateQueries({ queryKey: ['anticipos'] }); toast.ok('Operación anulada'); setAnular(null); setMotivo(''); },
    onError: toast.error,
  });
  return (
    <Modal abierto onCerrar={onCerrar} titulo={a ? `Anticipo — recibo #${numero(a.numero)}` : 'Anticipo'} ancho="lg"
      pie={a && a.estado === 'registrado' && (
        <>
          {puede('cobros.anular') && a.disponible > 0 && <Boton icono={<Undo2 className="size-4" />} onClick={() => setReintegro(true)}>Devolver dinero</Boton>}
          {puede('cobros.anular') && a.credito_aplicado === 0 && a.devuelto === 0 && <Boton variante="peligro" icono={<Ban className="size-4" />} onClick={() => setAnular({ tipo: 'anticipo', id: a.id })}>Anular anticipo</Boton>}
          <Boton icono={<Printer className="size-4" />} onClick={() => window.open(`/imprimir/recibo/${a.id}`, '_blank')}>Recibo</Boton>
        </>
      )}>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} /> : (
        <div className="space-y-4">
          {a.estado === 'anulado' && <Aviso tono="rojo">Anticipo anulado: {a.anulado_motivo}</Aviso>}
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Dato etiqueta="Cliente"><Link className="text-marca-700" to={`/cuentas/${a.cliente_id}`}>{a.cliente}</Link></Dato>
            <Dato etiqueta="Fecha">{fecha(a.fecha)}</Dato>
            <Dato etiqueta="Medios">{MEDIOS_LABEL(a.medios)}</Dato>
            <Dato etiqueta="Vinculado a">{a.orden_id ? <Link className="text-marca-700" to={`/ordenes/${a.orden_id}`}>OT #{numero(a.orden_numero)}</Link> : a.presupuesto_id ? <Link className="text-marca-700" to={`/presupuestos/${a.presupuesto_id}`}>Presupuesto #{numero(a.presupuesto_numero)}</Link> : '—'}</Dato>
            <Dato etiqueta="Recibido">{money(a.total)}</Dato>
            <Dato etiqueta="Aplicado a ventas">{money(a.credito_aplicado)}</Dato>
            <Dato etiqueta="Devuelto">{money(a.devuelto)}</Dato>
            <Dato etiqueta="Pendiente">{money(a.disponible)}</Dato>
          </dl>
          <div>
            <h3 className="mb-2 text-sm font-semibold">Aplicaciones a comprobantes</h3>
            {a.aplicaciones.length === 0 ? <p className="text-sm text-tenue">Todavía no se aplicó a ningún comprobante.</p> : (
              <ul className="divide-y divide-borde rounded-ctl border border-borde text-sm">
                {a.aplicaciones.map((x: any) => (
                  <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <span><Link className="text-marca-700" to={`/ventas/${x.venta_id}`}>Comprobante #{numero(x.venta_numero)}</Link>{x.orden_numero ? ` · OT #${numero(x.orden_numero)}` : ''} · {fecha(x.fecha)} {x.estado === 'anulada' && <Insignia tono="gris">Deshecha</Insignia>}</span>
                    <span className="flex items-center gap-2"><span className="tabular-nums">{money(x.importe)}</span>{x.estado === 'vigente' && puede('cobros.anular') && <Boton tam="sm" variante="fantasma" onClick={() => setAnular({ tipo: 'aplicacion', id: x.id })}>Deshacer</Boton>}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {a.reintegros.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold">Devoluciones de dinero</h3>
              <ul className="divide-y divide-borde rounded-ctl border border-borde text-sm">
                {a.reintegros.map((x: any) => (
                  <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <span>Reintegro #{numero(x.numero)} · {fecha(x.fecha)} · {MEDIOS_LABEL(x.medios)} {x.estado === 'anulado' && <Insignia tono="gris">Anulado</Insignia>}</span>
                    <span className="flex items-center gap-2"><span className="tabular-nums">{money(x.total)}</span>{x.estado === 'registrado' && puede('cobros.anular') && <Boton tam="sm" variante="fantasma" onClick={() => setAnular({ tipo: 'reintegro', id: x.id })}>Anular</Boton>}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {a.notas && <p className="text-sm"><span className="font-medium">Notas:</span> {a.notas}</p>}
        </div>
      )}
      {reintegro && a && <ModalReintegro origen={{ tipo: 'anticipo', id: a.id, numero: a.numero, disponible: a.disponible }} onCerrar={() => setReintegro(false)} />}
      <Modal abierto={!!anular} onCerrar={() => setAnular(null)} titulo="Confirmar anulación" ancho="sm" pie={<><Boton onClick={() => setAnular(null)}>Cancelar</Boton><Boton variante="peligro" disabled={motivo.trim().length < 3} cargando={m.isPending} onClick={() => m.mutate()}>Anular</Boton></>}>
        <div className="space-y-3">
          <p className="text-sm text-tenue">{anular?.tipo === 'aplicacion' ? 'El comprobante recupera su deuda y el saldo vuelve a estar disponible. No se mueve dinero.' : anular?.tipo === 'reintegro' ? 'El dinero vuelve a la caja abierta (contra-asiento) y el saldo a favor se restablece.' : 'Se registra la salida del dinero en la caja abierta. No se puede anular si ya se aplicó o se devolvió.'}</p>
          <Campo label="Motivo" requerido><Input value={motivo} onChange={(e) => setMotivo(e.target.value)} autoFocus /></Campo>
        </div>
      </Modal>
    </Modal>
  );
}

export function DevolucionesTab({ abrirId }: { abrirId?: string | null }) {
  const [desde, setDesde] = useState(sumarDias(hoyISO(), -90));
  const [hasta, setHasta] = useState(hoyISO());
  const [estado, setEstado] = useState('');
  const [q, setQ] = useState('');
  const [ver, setVer] = useState<string | null>(abrirId ?? null);
  const dq = useDebounce(q);
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['devoluciones', { desde, hasta, estado, dq }], queryFn: () => api.get<any[]>(`/devoluciones${qs({ desde, hasta, estado, q: dq })}`) });
  const vig = data.filter((d) => d.estado === 'registrada');
  return (
    <>
      <Aviso className="mb-4">Notas de crédito <strong>internas (no fiscales)</strong>. Para devolver, abrí el comprobante y usá “Registrar devolución”.</Aviso>
      <div className="mb-3 flex flex-wrap gap-2">
        <Insignia tono="violeta" className="px-3 py-1 text-sm">Devuelto: {money(vig.reduce((a, d) => a + d.total, 0))}</Insignia>
        <Insignia className="px-3 py-1 text-sm">Reintegrado en dinero: {money(vig.reduce((a, d) => a + d.reintegrado, 0))}</Insignia>
        <Insignia tono="ambar" className="px-3 py-1 text-sm">Saldo a favor sin usar: {money(vig.reduce((a, d) => a + d.credito_disponible, 0))}</Insignia>
      </div>
      <Filtros desde={desde} hasta={hasta} setDesde={setDesde} setHasta={setHasta} q={q} setQ={setQ}>
        <Campo label="Estado"><Select value={estado} onChange={(e) => setEstado(e.target.value)} className="w-auto"><option value="">Todas</option><option value="registrada">Vigentes</option><option value="anulada">Anuladas</option></Select></Campo>
      </Filtros>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={data}
            clave={(d) => d.id}
            onFila={(d) => setVer(d.id)}
            vacio={<Vacio icono={<Undo2 className="size-5" />} titulo="Sin devoluciones con esos filtros" />}
            columnas={[
              { clave: 'n', titulo: 'N°', render: (d) => <span className="font-medium">#{numero(d.numero)}</span>, movil: 'meta' },
              { clave: 'f', titulo: 'Fecha', render: (d) => fecha(d.fecha), movil: 'meta' },
              { clave: 'c', titulo: 'Cliente', render: (d) => d.cliente, movil: 'titulo' },
              { clave: 'v', titulo: 'Comprobante', render: (d) => `#${numero(d.venta_numero)}${d.orden_numero ? ` · OT #${numero(d.orden_numero)}` : ''}`, movil: 'subtitulo' },
              { clave: 'm', titulo: 'Motivo', render: (d) => d.motivo, movil: 'oculta' },
              { clave: 'e', titulo: 'Estado', render: (d) => (d.estado === 'anulada' ? <Insignia tono="gris">Anulada</Insignia> : <Insignia tono="violeta">Vigente</Insignia>), movil: 'meta' },
              { clave: 'r', titulo: 'Reintegrado', alinear: 'derecha', render: (d) => money(d.reintegrado), movil: 'oculta' },
              { clave: 't', titulo: 'Total', alinear: 'derecha', render: (d) => <span className={d.estado === 'anulada' ? 'text-tenue line-through' : ''}>{money(d.total)}</span>, movil: 'derecha' },
            ]}
          />
        </Tarjeta>
      )}
      {ver && <DetalleDevolucion id={ver} onCerrar={() => setVer(null)} />}
    </>
  );
}

function DetalleDevolucion({ id, onCerrar }: { id: string; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useAuth();
  const [reintegro, setReintegro] = useState(false);
  const [anular, setAnular] = useState<{ tipo: 'devolucion' | 'reintegro'; id: string } | null>(null);
  const [motivo, setMotivo] = useState('');
  const { data: d, isLoading, error } = useQuery({ queryKey: ['devoluciones', 'detalle', id], queryFn: () => api.get<any>(`/devoluciones/${id}`) });
  const m = useMutation({
    mutationFn: () => api.post(anular!.tipo === 'devolucion' ? `/devoluciones/${anular!.id}/anular` : `/reintegros/${anular!.id}/anular`, { motivo }),
    onSuccess: () => { invalidarDinero(qc); toast.ok('Operación anulada'); setAnular(null); setMotivo(''); },
    onError: toast.error,
  });
  return (
    <Modal abierto onCerrar={onCerrar} titulo={d ? `Nota de crédito interna #${numero(d.numero)}` : 'Devolución'} ancho="lg"
      pie={d && (
        <>
          {d.estado === 'registrada' && puede('cobros.anular') && d.credito_disponible > 0 && <Boton icono={<Undo2 className="size-4" />} onClick={() => setReintegro(true)}>Reintegrar dinero</Boton>}
          {d.estado === 'registrada' && puede('ventas.anular') && d.reintegrado === 0 && d.credito_aplicado === 0 && <Boton variante="peligro" icono={<Ban className="size-4" />} onClick={() => setAnular({ tipo: 'devolucion', id: d.id })}>Anular devolución</Boton>}
          <Boton variante="primario" icono={<Printer className="size-4" />} onClick={() => window.open(`/imprimir/devolucion/${d.id}`, '_blank')}>Imprimir</Boton>
        </>
      )}>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} /> : (
        <div className="space-y-4">
          {d.estado === 'anulada' && <Aviso tono="rojo">Devolución anulada: {d.anulada_motivo}</Aviso>}
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Dato etiqueta="Cliente"><Link className="text-marca-700" to={`/cuentas/${d.cliente_id}`}>{d.cliente}</Link></Dato>
            <Dato etiqueta="Comprobante"><Link className="text-marca-700" to={`/ventas/${d.venta_id}`}>#{numero(d.venta_numero)}</Link></Dato>
            <Dato etiqueta="Fecha">{fecha(d.fecha)}</Dato>
            <Dato etiqueta="Registró">{d.usuario}</Dato>
            <Dato etiqueta="Total acreditado">{money(d.total)}</Dato>
            <Dato etiqueta="Canceló deuda">{money(d.a_deuda)}</Dato>
            <Dato etiqueta="Reintegrado">{money(d.reintegrado)}</Dato>
            <Dato etiqueta="Saldo a favor">{money(d.credito_disponible)}</Dato>
            <Dato etiqueta="Motivo" className="col-span-2 sm:col-span-4">{d.motivo}</Dato>
          </dl>
          <ul className="divide-y divide-borde rounded-ctl border border-borde text-sm">
            {d.items.map((i: any) => (
              <li key={i.id} className="flex flex-wrap justify-between gap-2 px-3 py-2">
                <span>{i.cantidad} × {i.descripcion}{i.tipo === 'articulo' ? (i.reingresa ? ` · vuelve a ${i.deposito}` : ' · no vuelve al inventario') : ''}</span>
                <span className="tabular-nums">{money(i.importe)}</span>
              </li>
            ))}
          </ul>
          {d.reintegros.length > 0 && (
            <ul className="divide-y divide-borde rounded-ctl border border-borde text-sm">
              {d.reintegros.map((x: any) => (
                <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span>Reintegro #{numero(x.numero)} · {fecha(x.fecha)} · {MEDIOS_LABEL(x.medios)} {x.estado === 'anulado' && <Insignia tono="gris">Anulado</Insignia>}</span>
                  <span className="flex items-center gap-2"><span className="tabular-nums">{money(x.total)}</span>{x.estado === 'registrado' && puede('cobros.anular') && <Boton tam="sm" variante="fantasma" onClick={() => setAnular({ tipo: 'reintegro', id: x.id })}>Anular</Boton>}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {reintegro && d && <ModalReintegro origen={{ tipo: 'devolucion', id: d.id, numero: d.numero, disponible: d.credito_disponible }} onCerrar={() => setReintegro(false)} />}
      <Modal abierto={!!anular} onCerrar={() => setAnular(null)} titulo="Confirmar anulación" ancho="sm" pie={<><Boton onClick={() => setAnular(null)}>Cancelar</Boton><Boton variante="peligro" disabled={motivo.trim().length < 3} cargando={m.isPending} onClick={() => m.mutate()}>Anular</Boton></>}>
        <div className="space-y-3">
          <p className="text-sm text-tenue">{anular?.tipo === 'devolucion' ? 'El comprobante recupera lo devuelto y la mercadería reingresada vuelve a salir del depósito.' : 'El dinero vuelve a la caja abierta (contra-asiento) y el saldo a favor se restablece.'}</p>
          <Campo label="Motivo" requerido><Input value={motivo} onChange={(e) => setMotivo(e.target.value)} autoFocus /></Campo>
        </div>
      </Modal>
    </Modal>
  );
}

export const hoy = hoyISO;
