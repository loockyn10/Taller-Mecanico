import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, ClipboardCheck, MessageCircle, Pencil, Printer, Receipt, Wallet, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fecha, fechaHora, km, money, numero, whatsapp } from '@/lib/format';
import { Aviso, Boton, Campo, Cargando, Chip, Dato, Encabezado, ErrorCaja, Input, Modal, Pestanas, Select, Tarjeta, Textarea, useConfirmar, useToast } from '@/components/ui';
import { EstadoCobroBadge, EstadoOTBadge } from '@/components/estados';
import { EditorItems, itemsDesdeApi, itemsParaApi, ResumenTotales, type ItemUI, type ParamsUI } from '@/components/EditorItems';
import { Cronometro, EquipoOrden, NotasTecnicas, Tareas } from '@/components/TrabajoMecanico';
import { useMecanicos } from '@/components/selectores';
import { ModalCobro, ModalEmitirCobrar } from '@/components/Cobro';
import { SelectorLista } from '@/components/SelectorLista';
import { calcularTotales } from '@shared/totals';
import { CHECKLIST_ITEMS, COMBUSTIBLE_NIVELES, ESTADOS_OT_CON_STOCK, ESTADOS_OT_EDITABLES, ESTADO_OT_LABEL, TRANSICIONES_OT, type EstadoOT } from '@shared/dominio';

function Checklist({ orden }: { orden: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const c = orden.checklist;
  const [f, setF] = useState({
    combustible: c?.combustible ?? '',
    km: c?.km ?? orden.km_ingreso ?? '',
    danos: (c?.datos?.danos ?? []) as string[],
    testigos: (c?.datos?.testigos ?? []) as string[],
    accesorios: (c?.datos?.accesorios ?? []) as string[],
    ingreso: c?.datos?.ingreso ?? '',
    objetos_personales: c?.datos?.objetos_personales ?? '',
    observaciones: c?.observaciones ?? '',
    recibido_por: c?.recibido_por ?? '',
  });
  const toggle = (k: 'danos' | 'testigos' | 'accesorios', v: string) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] });
  const m = useMutation({
    mutationFn: () =>
      api.put(`/ordenes/${orden.id}/checklist`, {
        combustible: f.combustible || null,
        km: f.km === '' ? null : Number(f.km),
        datos: { danos: f.danos, testigos: f.testigos, accesorios: f.accesorios, ingreso: f.ingreso || null, objetos_personales: f.objetos_personales || null },
        observaciones: f.observaciones,
        recibido_por: f.recibido_por,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orden', orden.id] });
      toast.ok('Check-list guardado');
    },
    onError: toast.error,
  });
  const grupo = (titulo: string, k: 'danos' | 'testigos' | 'accesorios', peligro = false) => (
    <div>
      <h3 className="mb-2 text-sm font-semibold">{titulo}</h3>
      <div className="flex flex-wrap gap-2">{CHECKLIST_ITEMS[k].map((x) => <Chip key={x} activo={f[k].includes(x)} onClick={() => toggle(k, x)} tono={peligro ? 'peligro' : 'marca'}>{x}</Chip>)}</div>
    </div>
  );
  return (
    <div className="space-y-5">
      {!c && <Aviso tono="ambar">Todavía no se cargó el check-list de ingreso de este vehículo.</Aviso>}
      <div>
        <h3 className="mb-2 text-sm font-semibold">Estado al ingresar</h3>
        <div className="flex flex-wrap gap-2">{CHECKLIST_ITEMS.ingreso.map((x) => <Chip key={x} activo={f.ingreso === x} onClick={() => setF({ ...f, ingreso: f.ingreso === x ? '' : x })}>{x}</Chip>)}</div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-semibold">Combustible</h3>
          <div className="flex flex-wrap gap-2">{COMBUSTIBLE_NIVELES.map((x) => <Chip key={x} activo={f.combustible === x} onClick={() => setF({ ...f, combustible: x })}>{x === 'reserva' ? 'Reserva' : x === 'lleno' ? 'Lleno' : x}</Chip>)}</div>
        </div>
        <Campo label="Kilometraje">
          <Input value={f.km} onChange={(e) => setF({ ...f, km: e.target.value.replace(/\D/g, '') })} inputMode="numeric" />
        </Campo>
      </div>
      {grupo('Daños visibles', 'danos', true)}
      {grupo('Testigos encendidos en el tablero', 'testigos', true)}
      {grupo('Accesorios entregados', 'accesorios')}
      <div className="grid gap-3 sm:grid-cols-2">
        <Campo label="Objetos personales en el vehículo"><Textarea rows={2} value={f.objetos_personales} onChange={(e) => setF({ ...f, objetos_personales: e.target.value })} /></Campo>
        <Campo label="Observaciones"><Textarea rows={2} value={f.observaciones} onChange={(e) => setF({ ...f, observaciones: e.target.value })} /></Campo>
        <Campo label="Recibido por"><Input value={f.recibido_por} onChange={(e) => setF({ ...f, recibido_por: e.target.value })} /></Campo>
      </div>
      <div className="flex justify-end">
        <Boton variante="primario" icono={<ClipboardCheck className="size-4" />} cargando={m.isPending} onClick={() => m.mutate()}>Guardar check-list</Boton>
      </div>
      <p className="text-xs text-tenue">Fotos y firma del cliente: pendiente para una próxima versión.</p>
    </div>
  );
}

function CambiarEstado({ orden, onCerrar, soloTaller }: { orden: any; onCerrar: () => void; soloTaller?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [destino, setDestino] = useState<EstadoOT | null>(null);
  const [nota, setNota] = useState('');
  const opciones = TRANSICIONES_OT[orden.estado as EstadoOT].filter((e) => !soloTaller || ['diagnostico', 'en_reparacion', 'esperando_repuestos', 'lista'].includes(e));
  const m = useMutation({
    mutationFn: () => api.post(`/ordenes/${orden.id}/estado`, { estado: destino, nota }),
    onSuccess: (r) => {
      ['orden', 'ordenes', 'dashboard', 'articulos', 'turnos'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.ok(r.stock === 'descontado' ? 'Estado actualizado. Se descontaron los repuestos del stock.' : r.stock === 'repuesto' ? 'Estado actualizado. Los repuestos volvieron al stock.' : 'Estado actualizado');
      onCerrar();
    },
    onError: toast.error,
  });
  const descontara = destino && ESTADOS_OT_CON_STOCK.includes(destino) && !orden.stock_aplicado && orden.items.some((i: any) => i.tipo === 'articulo');
  const repondra = destino && !ESTADOS_OT_CON_STOCK.includes(destino) && orden.stock_aplicado;
  return (
    <Modal abierto onCerrar={onCerrar} titulo="Cambiar estado" pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" disabled={!destino} cargando={m.isPending} onClick={() => m.mutate()}>Confirmar</Boton></>}>
      <div className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2">
          {opciones.map((e) => (
            <button key={e} type="button" onClick={() => setDestino(e)} className={`rounded-lg border px-3 py-2.5 text-left text-sm font-medium ${destino === e ? 'border-marca-400 bg-marca-50 ring-2 ring-marca-100' : 'border-borde hover:bg-slate-50'}`}>
              {ESTADO_OT_LABEL[e]}
            </button>
          ))}
        </div>
        {descontara && <Aviso tono="ambar">Al pasar a “{ESTADO_OT_LABEL[destino!]}” se descontarán del stock los repuestos de la OT.</Aviso>}
        {repondra && <Aviso>Los repuestos descontados volverán al stock y la OT podrá editarse.</Aviso>}
        <Campo label="Nota (opcional)"><Input value={nota} onChange={(e) => setNota(e.target.value)} placeholder="Ej.: se espera repuesto del proveedor" /></Campo>
      </div>
    </Modal>
  );
}

/** Lista de trabajos y repuestos sin importes (para quien no tiene permiso para ver presupuestos valorizados). */
function ItemsSinImportes({ items }: { items: any[] }) {
  if (!items.length) return <p className="text-sm text-tenue">La orden no tiene trabajos ni repuestos cargados.</p>;
  return (
    <ul className="divide-y divide-borde text-sm">
      {items.map((i) => (
        <li key={i.id} className="flex items-center justify-between gap-3 py-2.5">
          <span className="min-w-0 truncate">{i.descripcion}</span>
          <span className="shrink-0 tabular-nums text-tenue">{i.tipo === 'articulo' ? 'Repuesto' : 'Trabajo'} · ×{i.cantidad}</span>
        </li>
      ))}
    </ul>
  );
}

export function OrdenDetalle() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { puede, me } = useAuth();
  const { confirmar, dialogo } = useConfirmar();
  const { data: o, isLoading, error, refetch } = useQuery({ queryKey: ['orden', id], queryFn: () => api.get(`/ordenes/${id}`) });
  const { data: mecanicos = [] } = useMecanicos();
  const [tab, setTab] = useState<'trabajo' | 'tareas' | 'checklist' | 'historial' | 'cobro'>('trabajo');
  const [editando, setEditando] = useState(false);
  const [estadoModal, setEstadoModal] = useState(false);
  const [cobro, setCobro] = useState(false);
  const [items, setItems] = useState<ItemUI[]>([]);
  const [params, setParams] = useState<ParamsUI>({ desc_global_pct: 0, desc_global_monto: 0, iva_pct: 0, recargo_pct: 0 });
  const [cab, setCab] = useState({ mecanico_id: '', km_ingreso: '', falla_reportada: '', diagnostico: '', observaciones: '', fecha_prometida: '' });
  const [lista, setLista] = useState<string | null>(null);
  const [emitirCobrar, setEmitirCobrar] = useState(false);

  useEffect(() => {
    if (!o) return;
    setItems(itemsDesdeApi(o.items));
    setLista(o.lista_precio_id ?? null);
    setParams({ desc_global_pct: o.desc_global_pct, desc_global_monto: o.desc_global_monto, iva_pct: o.iva_pct, recargo_pct: o.recargo_pct });
    setCab({
      mecanico_id: o.mecanico_id ?? '',
      km_ingreso: o.km_ingreso != null ? String(o.km_ingreso) : '',
      falla_reportada: o.falla_reportada ?? '',
      diagnostico: o.diagnostico ?? '',
      observaciones: o.observaciones ?? '',
      fecha_prometida: o.fecha_prometida ?? '',
    });
  }, [o]);

  const guardar = useMutation({
    mutationFn: () =>
      api.put(`/ordenes/${id}`, {
        cliente_id: o.cliente_id,
        vehiculo_id: o.vehiculo_id,
        mecanico_id: cab.mecanico_id || null,
        km_ingreso: cab.km_ingreso ? Number(cab.km_ingreso) : null,
        falla_reportada: cab.falla_reportada,
        diagnostico: cab.diagnostico,
        observaciones: cab.observaciones,
        fecha_prometida: cab.fecha_prometida || null,
        lista_precio_id: lista,
        items: itemsParaApi(items),
        version: o.version,
        ...params,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orden', id] });
      qc.invalidateQueries({ queryKey: ['ordenes'] });
      setEditando(false);
      toast.ok('OT actualizada');
    },
    onError: toast.error,
  });

  const comprobante = useMutation({
    mutationFn: (datos: { condicion: string; cobro?: Record<string, unknown> }) => api.post(`/ordenes/${id}/comprobante`, datos),
    onSuccess: (v) => {
      ['orden', 'ventas', 'dashboard', 'cuentas', 'cobros', 'caja', 'finanzas'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.ok(`Comprobante interno #${numero(v.numero)} generado`);
      setEmitirCobrar(false);
      setTab('cobro');
    },
    onError: toast.error,
  });

  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;

  const valorizado = puede('presupuestos.valorizados.ver') && o.total !== undefined;
  const puedeModificar = puede('ordenes.modificar');
  const cerrada = o.estado === 'entregada' || o.estado === 'cancelada';
  const puedeTrabajar = !cerrada && (puedeModificar || (puede('ordenes.trabajar_asignadas') && o.asignada_a_mi));
  // Asignar responsable, participantes y tareas no requiere ver ni modificar importes.
  const puedeAsignar = !cerrada && (puedeModificar || puede('ordenes.asignar'));
  // Editar ítems exige ver precios e importes (el servidor también lo verifica).
  const editable = ESTADOS_OT_EDITABLES.includes(o.estado) && puedeModificar && valorizado && puede('precios.venta.ver');
  const saldo = o.venta_id ? o.venta_total - o.venta_cobrado : null;
  const vehiculo = [o.marca, o.modelo, o.anio].filter(Boolean).join(' ');
  const wa = !o.cliente ? null : whatsapp(
    o.cliente_telefono,
    o.estado === 'lista'
      ? `Hola ${o.cliente}! Te avisamos de ${me?.taller.nombre} que tu vehículo ${o.patente} ya está listo para retirar.${valorizado ? ` Total: ${money(o.total)}.` : ''}`
      : `Hola ${o.cliente}! Te escribimos de ${me?.taller.nombre} por tu vehículo ${o.patente} (OT #${numero(o.numero)}). Estado: ${ESTADO_OT_LABEL[o.estado as EstadoOT]}.`,
  );

  return (
    <>
      {dialogo}
      <Encabezado
        volver="/ordenes"
        titulo={<span className="flex flex-wrap items-center gap-3">OT #{numero(o.numero)} <EstadoOTBadge estado={o.estado} /></span>}
        subtitulo={<>{[o.patente, vehiculo || 'Vehículo', o.cliente].filter(Boolean).join(' · ')}</>}
        acciones={
          <>
            {wa && <a href={wa} target="_blank" rel="noreferrer"><Boton icono={<MessageCircle className="size-4" />}>WhatsApp</Boton></a>}
            <Boton icono={<Printer className="size-4" />} onClick={() => window.open(`/imprimir/orden/${o.id}`, '_blank')}>Imprimir</Boton>
            <Boton icono={<Printer className="size-4" />} onClick={() => window.open(`/imprimir/orden-taller/${o.id}`, '_blank')} title="Orden para el mecánico, sin precios">Hoja taller</Boton>
            {puedeTrabajar && <Boton variante="primario" icono={<ArrowRight className="size-4" />} onClick={() => setEstadoModal(true)}>Cambiar estado</Boton>}
          </>
        }
      />

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <Pestanas
            activo={tab}
            onCambio={setTab}
            items={[
              { clave: 'trabajo', titulo: 'Trabajo' },
              { clave: 'tareas', titulo: 'Equipo, tareas y tiempos', contador: o.tareas.length || undefined },
              { clave: 'checklist', titulo: 'Check-list de ingreso' },
              ...(puede('ventas.ver') ? [{ clave: 'cobro' as const, titulo: 'Comprobante y cobro' }] : []),
              { clave: 'historial', titulo: 'Historial', contador: o.eventos.length },
            ]}
          />
          {tab === 'trabajo' && (
            <Tarjeta
              titulo="Trabajos y repuestos"
              acciones={
                editable &&
                (editando ? (
                  <>
                    <Boton tam="sm" icono={<X className="size-4" />} onClick={() => { setEditando(false); setItems(itemsDesdeApi(o.items)); }}>Descartar</Boton>
                    <Boton tam="sm" variante="primario" cargando={guardar.isPending} onClick={() => guardar.mutate()}>Guardar cambios</Boton>
                  </>
                ) : (
                  <Boton tam="sm" icono={<Pencil className="size-4" />} onClick={() => setEditando(true)}>Editar</Boton>
                ))
              }
            >
              {!ESTADOS_OT_EDITABLES.includes(o.estado) && <Aviso className="mb-4">La OT está “{ESTADO_OT_LABEL[o.estado as EstadoOT]}”: los ítems no se pueden modificar. Para corregirlos, volvela a “En reparación”{o.venta_id ? ' (antes hay que anular el comprobante)' : ''}.</Aviso>}
              {!valorizado ? (
                <ItemsSinImportes items={o.items} />
              ) : editando ? (
                <div className="space-y-5">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Campo label="Mecánico">
                      <Select value={cab.mecanico_id} onChange={(e) => setCab({ ...cab, mecanico_id: e.target.value })}>
                        <option value="">Sin asignar</option>
                        {mecanicos.filter((m) => m.activo || m.id === cab.mecanico_id).map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
                      </Select>
                    </Campo>
                    <Campo label="Fecha prometida"><Input type="date" value={cab.fecha_prometida} onChange={(e) => setCab({ ...cab, fecha_prometida: e.target.value })} /></Campo>
                    <Campo label="Km de ingreso"><Input value={cab.km_ingreso} onChange={(e) => setCab({ ...cab, km_ingreso: e.target.value.replace(/\D/g, '') })} inputMode="numeric" /></Campo>
                    <Campo label="Falla reportada"><Input value={cab.falla_reportada} onChange={(e) => setCab({ ...cab, falla_reportada: e.target.value })} /></Campo>
                    <Campo label="Diagnóstico" className="sm:col-span-2"><Textarea value={cab.diagnostico} onChange={(e) => setCab({ ...cab, diagnostico: e.target.value })} rows={2} /></Campo>
                    <Campo label="Observaciones" className="sm:col-span-2"><Textarea value={cab.observaciones} onChange={(e) => setCab({ ...cab, observaciones: e.target.value })} rows={2} /></Campo>
                  </div>
                  <SelectorLista valor={lista} onCambio={setLista} items={items} onItems={setItems} nombreActual={o.lista_precio_nombre} />
                  <EditorItems items={items} onItems={setItems} params={params} onParams={setParams} listaId={lista} vehiculoId={o.vehiculo_id} />
                </div>
              ) : (
                <EditorItems items={items} onItems={setItems} params={params} onParams={setParams} soloLectura />
              )}
            </Tarjeta>
          )}
          {tab === 'tareas' && (
            <div className="space-y-5">
              <Tarjeta titulo="Equipo de trabajo" subtitulo="Mecánico responsable y quienes participan en la orden"><EquipoOrden orden={o} puedeAsignar={puedeAsignar} /></Tarjeta>
              <Tarjeta titulo="Tareas del trabajo" subtitulo="Cada tarea tiene su responsable, estado, tiempo estimado y tiempo real"><Tareas orden={o} puedeEditar={puedeTrabajar} puedeAsignar={puedeAsignar} /></Tarjeta>
              <Tarjeta titulo="Diagnóstico, resultado y observaciones técnicas"><NotasTecnicas orden={o} puedeEditar={puedeTrabajar} /></Tarjeta>
              <Tarjeta titulo="Tiempo dedicado a la reparación" subtitulo="Aparte de las horas de asistencia al taller"><Cronometro orden={o} puedeEditar={puedeTrabajar} /></Tarjeta>
            </div>
          )}
          {tab === 'checklist' && <Tarjeta titulo="Check-list de ingreso"><Checklist orden={o} /></Tarjeta>}
          {tab === 'historial' && (
            <Tarjeta titulo="Historial de la OT">
              <ol className="relative space-y-4 border-l border-borde pl-5">
                {o.eventos.map((e: any) => (
                  <li key={e.id}>
                    <span className="absolute -left-1.5 mt-1.5 size-3 rounded-full border-2 border-white bg-marca-500" />
                    <div className="text-sm font-medium">{e.estado_anterior ? `${ESTADO_OT_LABEL[e.estado_anterior as EstadoOT]} → ` : ''}{ESTADO_OT_LABEL[e.estado_nuevo as EstadoOT]}</div>
                    <div className="text-xs text-tenue">{fechaHora(e.created_at)} · {e.usuario ?? 'Sistema'}</div>
                    {e.nota && <div className="mt-1 text-sm">{e.nota}</div>}
                  </li>
                ))}
              </ol>
            </Tarjeta>
          )}
          {tab === 'cobro' && (
            <Tarjeta titulo="Comprobante interno y cobro">
              {!o.venta_id ? (
                ESTADOS_OT_CON_STOCK.includes(o.estado) ? (
                  puede('ventas.emitir') ? (
                    <div className="space-y-4">
                      <p className="text-sm text-tenue">Generá el comprobante interno con los ítems de la OT para registrar la deuda del cliente y cobrarla.</p>
                      {valorizado && <ResumenTotales t={calcularTotales(o.items, o)} params={o} />}
                      <div className="flex flex-wrap gap-2">
                        {puede('cobros.registrar') && <Boton variante="primario" icono={<Wallet className="size-4" />} cargando={comprobante.isPending} onClick={() => setEmitirCobrar(true)}>Emitir y cobrar ({money(o.total)})</Boton>}
                        <Boton icono={<Receipt className="size-4" />} disabled={o.cliente_codigo === 0} title={o.cliente_codigo === 0 ? 'La cuenta corriente requiere un cliente identificado' : undefined} cargando={comprobante.isPending} onClick={() => comprobante.mutate({ condicion: 'cuenta_corriente' })}>Emitir a cuenta corriente</Boton>
                      </div>
                      <p className="text-xs text-tenue">Comprobante interno, no fiscal. La facturación electrónica ARCA todavía no está integrada.</p>
                    </div>
                  ) : (
                    <Aviso>No tenés permiso para emitir comprobantes.</Aviso>
                  )
                ) : (
                  <Aviso>El comprobante se genera cuando la OT está “Lista para entregar”.</Aviso>
                )
              ) : (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <Link to={`/ventas/${o.venta_id}`} className="font-semibold text-marca-700">Comprobante interno #{numero(o.venta_numero)}</Link>
                      <div className="text-sm text-tenue">Total {money(o.venta_total)} · cobrado {money(o.venta_cobrado)}</div>
                    </div>
                    <EstadoCobroBadge total={o.venta_total} cobrado={o.venta_cobrado} />
                  </div>
                  {saldo! > 0 && puede('cobros.registrar') && <Boton variante="exito" icono={<Wallet className="size-4" />} onClick={() => setCobro(true)}>Registrar cobro ({money(saldo!)})</Boton>}
                </div>
              )}
            </Tarjeta>
          )}
        </div>

        <div className="space-y-5">
          <Tarjeta titulo="Datos">
            <dl className="grid grid-cols-2 gap-4">
              {o.cliente !== undefined && <Dato etiqueta="Cliente"><Link className="text-marca-700" to={`/clientes/${o.cliente_id}`}>{o.cliente}</Link></Dato>}
              {o.cliente !== undefined && <Dato etiqueta="Teléfono">{o.cliente_telefono}</Dato>}
              <Dato etiqueta="Vehículo">{puede('vehiculos.ver') ? <Link className="text-marca-700" to={`/vehiculos/${o.vehiculo_id}`}>{o.patente}</Link> : o.patente}</Dato>
              <Dato etiqueta="Km de ingreso">{km(o.km_ingreso)}</Dato>
              <Dato etiqueta="Mecánico">{o.mecanico}</Dato>
              {o.participantes?.length > 0 && <Dato etiqueta="Participan">{o.participantes.map((p: any) => p.nombre).join(', ')}</Dato>}
              <Dato etiqueta="Ingreso">{fecha(o.fecha_ingreso)}</Dato>
              <Dato etiqueta="Prometida">{fecha(o.fecha_prometida)}</Dato>
              <Dato etiqueta="Entregada">{fecha(o.fecha_entregada)}</Dato>
              {o.presupuesto_id && <Dato etiqueta="Origen" className="col-span-2"><Link className="text-marca-700" to={`/presupuestos/${o.presupuesto_id}`}>Presupuesto #{numero(o.presupuesto_numero)}</Link></Dato>}
              <Dato etiqueta="Falla reportada" className="col-span-2">{o.falla_reportada}</Dato>
              <Dato etiqueta="Diagnóstico" className="col-span-2">{o.diagnostico}</Dato>
              {o.resultado && <Dato etiqueta="Resultado del trabajo" className="col-span-2">{o.resultado}</Dato>}
              <Dato etiqueta="Observaciones" className="col-span-2">{o.observaciones}</Dato>
              {o.lista_precio_nombre && <Dato etiqueta="Lista de precios" className="col-span-2">{o.lista_precio_nombre}</Dato>}
            </dl>
          </Tarjeta>
          {valorizado ? (
            <Tarjeta titulo="Importe">
              <div className="text-3xl font-bold tabular-nums">{money(o.total)}</div>
              {o.venta_id ? <div className="mt-2"><EstadoCobroBadge total={o.venta_total} cobrado={o.venta_cobrado} /></div> : <p className="mt-1 text-sm text-tenue">Sin comprobante emitido</p>}
              {o.stock_aplicado ? <p className="mt-2 text-xs text-tenue">Repuestos descontados del stock.</p> : null}
            </Tarjeta>
          ) : null}
          {o.estado === 'cancelada' && puedeModificar && (
            <Boton
              className="w-full"
              onClick={async () => {
                if (await confirmar('Reabrir OT', 'La OT volverá al estado “Recibida”.')) {
                  await api.post(`/ordenes/${o.id}/estado`, { estado: 'recibida' }).catch(toast.error);
                  qc.invalidateQueries({ queryKey: ['orden', id] });
                }
              }}
            >
              Reabrir OT
            </Boton>
          )}
          <Boton variante="fantasma" className="w-full" onClick={() => nav(`/vehiculos/${o.vehiculo_id}`)}>Ver historial del vehículo</Boton>
        </div>
      </div>

      {estadoModal && <CambiarEstado orden={o} soloTaller={!puedeModificar} onCerrar={() => setEstadoModal(false)} />}
      {cobro && <ModalCobro abierto onCerrar={() => setCobro(false)} clienteId={o.cliente_id} ventaId={o.venta_id} />}
      {emitirCobrar && <ModalEmitirCobrar total={o.total} cargando={comprobante.isPending} onCerrar={() => setEmitirCobrar(false)} onConfirmar={(cobro) => comprobante.mutate({ condicion: 'contado', cobro })} />}
    </>
  );
}
