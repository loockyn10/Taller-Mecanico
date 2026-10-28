// Finanzas › Movimientos con personas: aportes de capital, préstamos de socios, préstamos y adelantos al personal.
// Información sensible: la pantalla se muestra sólo con permiso y la API vuelve a verificarlo en cada consulta.
import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, ChevronLeft, ChevronRight, HandCoins, Landmark, Plus, UserRoundCheck, Wallet, X } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { invalidarDinero } from '@/lib/caja';
import { fecha, fechaHora, hoyISO, money } from '@/lib/format';
import { Aviso, Boton, Buscador, Campo, Cargando, Dato, Encabezado, ErrorCaja, Indicador, Input, Insignia, Modal, Pestanas, Select, Tabla, Tarjeta, Textarea, useDebounce, useToast, Vacio, type Tono } from '@/components/ui';
import { ESTADO_MOV_LABEL, DEF_TIPOS_FIN, TIPO_PERSONA_LABEL, type EstadoMovimiento, type TipoFin } from '@shared/movpersonas';
import { DIRECCION_ESTILO, NuevoMovimiento, useCategorias, useCuentas, usePersonas, type Preset } from './movpersonas/NuevoMovimiento';
import { Categorias, ResumenCategoria, ResumenPersona } from './movpersonas/Resumenes';

const TONO_ESTADO: Record<EstadoMovimiento, Tono> = { registrado: 'azul', parcial: 'ambar', regularizado: 'verde', anulado: 'gris' };
const ESTADOS_OBLIGACION: TipoFin[] = ['prestamo_recibido', 'prestamo_otorgado', 'adelanto_sueldo'];

export const EstadoMov = ({ m }: { m: { estado_visible: EstadoMovimiento } }) => <Insignia tono={TONO_ESTADO[m.estado_visible]}>{ESTADO_MOV_LABEL[m.estado_visible]}</Insignia>;

interface Filtros { persona_id: string; categoria_id: string; direccion: string; cuenta: string; estado: string; desde: string; hasta: string; q: string }
const SIN_FILTROS: Filtros = { persona_id: '', categoria_id: '', direccion: '', cuenta: '', estado: '', desde: '', hasta: '', q: '' };

function Detalle({ id, onCerrar, onRegularizar }: { id: string; onCerrar: () => void; onRegularizar: (p: Preset) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useAuth();
  const { data: m, isLoading, error } = useQuery({ queryKey: ['movpersonas', 'detalle', id], queryFn: () => api.get<any>(`/movimientos-personas/movimientos/${id}`) });
  const [anulando, setAnulando] = useState(false);
  const [motivo, setMotivo] = useState('');
  const anular = useMutation({
    mutationFn: () => api.post(`/movimientos-personas/movimientos/${id}/anular`, { motivo }),
    onSuccess: () => {
      invalidarDinero(qc);
      qc.invalidateQueries({ queryKey: ['movpersonas'] });
      toast.ok('Movimiento anulado');
      onCerrar();
    },
    onError: toast.error,
  });
  const clavePreset: Partial<Record<TipoFin, string>> = { prestamo_recibido: 'devolucion_prestamo_a_persona', prestamo_otorgado: 'devolucion_prestamo_a_empresa', adelanto_sueldo: 'aplicacion_adelanto' };
  const puedeRegularizar = m && m.saldo > 0 && ((m.tipo_fin === 'adelanto_sueldo' ? puede('movpersonas.regularizar') : puede('movpersonas.registrar')));
  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo={m ? `Movimiento #${m.numero}` : 'Movimiento'}
      ancho="lg"
      pie={
        m && !anulando ? (
          <>
            <Boton onClick={onCerrar}>Cerrar</Boton>
            {puedeRegularizar && <Boton variante="primario" onClick={() => onRegularizar({ persona_id: m.persona_id, clave: clavePreset[m.tipo_fin as TipoFin], regulariza_id: m.id })}>{m.tipo_fin === 'adelanto_sueldo' ? 'Aplicar adelanto' : 'Registrar devolución'}</Boton>}
            {m.estado === 'registrado' && puede('movpersonas.anular') && <Boton variante="peligro" icono={<Ban className="size-4" />} onClick={() => setAnulando(true)}>Anular</Boton>}
          </>
        ) : m ? (
          <>
            <Boton onClick={() => setAnulando(false)}>Volver</Boton>
            <Boton variante="peligro" disabled={motivo.trim().length < 3} cargando={anular.isPending} onClick={() => anular.mutate()}>Confirmar anulación</Boton>
          </>
        ) : undefined
      }
    >
      {isLoading ? <Cargando /> : error || !m ? <ErrorCaja error={error} /> : anulando ? (
        <div className="space-y-3">
          <Aviso tono="ambar">Se genera el contra-asiento en {m.via === 'caja' ? 'la caja abierta' : m.via === 'banco' ? 'la cuenta bancaria' : 'la contabilidad'} y la contabilidad. El movimiento queda en el historial como anulado; no se borra.</Aviso>
          {m.regularizado > 0 && <Aviso tono="rojo">Tiene devoluciones o aplicaciones vigentes: anulalas primero.</Aviso>}
          <Campo label="Motivo de la anulación" requerido><Textarea rows={3} value={motivo} onChange={(e) => setMotivo(e.target.value)} autoFocus /></Campo>
        </div>
      ) : (
        <div className="space-y-4">
          <div className={`flex flex-wrap items-center justify-between gap-2 rounded-card border p-3 ${DIRECCION_ESTILO[m.direccion].clase}`}>
            <span className="flex items-center gap-2 font-semibold">{DIRECCION_ESTILO[m.direccion].icono}{DIRECCION_ESTILO[m.direccion].titulo}</span>
            <span className="text-lg font-bold tabular-nums">{money(m.importe)}</span>
          </div>
          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <Dato etiqueta="Persona">{m.persona} <span className="text-tenue">· {TIPO_PERSONA_LABEL[m.persona_tipo as keyof typeof TIPO_PERSONA_LABEL]}</span></Dato>
            <Dato etiqueta="Categoría">{m.categoria}</Dato>
            <Dato etiqueta="Fecha">{fecha(m.fecha)}</Dato>
            <Dato etiqueta="Cuenta">{m.cuenta ?? 'No mueve dinero'}</Dato>
            <Dato etiqueta="Estado"><EstadoMov m={m} /></Dato>
            <Dato etiqueta="Registrado por">{m.operador ?? '—'} · {fechaHora(m.created_at)}</Dato>
            <Dato etiqueta="Motivo" className="sm:col-span-2">{m.motivo}</Dato>
            {m.referencia && <Dato etiqueta="Comprobante o referencia">{m.referencia}</Dato>}
            {m.regulariza_numero && <Dato etiqueta="Regulariza">Movimiento #{m.regulariza_numero}</Dato>}
            {m.liquidacion_ref && <Dato etiqueta="Liquidación">{m.liquidacion_ref}</Dato>}
            {m.autorizado_por && <Dato etiqueta="Autorizado por">{m.autorizado_por}</Dato>}
            {ESTADOS_OBLIGACION.includes(m.tipo_fin) && <Dato etiqueta="Saldo pendiente">{money(m.saldo)} <span className="text-tenue">de {money(m.importe)}</span></Dato>}
            {m.estado === 'anulado' && <Dato etiqueta="Anulado" className="sm:col-span-2">{m.anulado_por_nombre ?? '—'} · {fechaHora(m.anulado_at)} · {m.anulado_motivo}</Dato>}
          </div>
          <p className="text-xs text-tenue">{DEF_TIPOS_FIN[m.tipo_fin as TipoFin].asiento}</p>
          {m.regularizaciones.length > 0 && (
            <div>
              <h4 className="mb-1 text-sm font-semibold">{m.tipo_fin === 'adelanto_sueldo' ? 'Aplicaciones' : 'Devoluciones'}</h4>
              <ul className="divide-y divide-borde-suave rounded-card border border-borde text-sm">
                {m.regularizaciones.map((r: any) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <span>#{r.numero} · {fecha(r.fecha)} · {r.operador ?? '—'}{r.liquidacion_ref ? ` · ${r.liquidacion_ref}` : ''}</span>
                    <span className="tabular-nums">{money(r.importe)} {r.estado === 'anulado' && <Insignia tono="gris">Anulado</Insignia>}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <h4 className="mb-1 text-sm font-semibold">Historial</h4>
            <ul className="space-y-1 text-sm text-tenue">
              {m.historial.map((h: any, i: number) => <li key={i}>{fechaHora(h.created_at)} · {h.usuario ?? '—'} · {h.accion === 'crear' ? 'registró el movimiento' : h.accion === 'anular' ? 'anuló el movimiento' : h.accion}</li>)}
            </ul>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Movimientos() {
  const { puede } = useAuth();
  const { data: categorias = [] } = useCategorias();
  const { data: personas = [] } = usePersonas(true);
  const { data: cuentasInfo } = useCuentas();
  const [f, setF] = useState<Filtros>(SIN_FILTROS);
  const [pagina, setPagina] = useState(1);
  const [orden, setOrden] = useState('fecha_desc');
  const [ver, setVer] = useState<string | null>(null);
  const [nuevo, setNuevo] = useState<Preset | null>(null);
  const dq = useDebounce(f.q);
  const filtros = { ...f, q: dq };
  const cambiar = (k: keyof Filtros, v: string) => {
    setF((x) => ({ ...x, [k]: v }));
    setPagina(1);
  };

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['movpersonas', 'lista', filtros, pagina, orden],
    queryFn: () => api.get<any>(`/movimientos-personas/movimientos${qs({ ...filtros, pagina, por_pagina: 25, orden })}`),
    placeholderData: keepPreviousData,
  });
  const { data: ind } = useQuery({
    queryKey: ['movpersonas', 'indicadores', f.persona_id, f.desde, f.hasta],
    queryFn: () => api.get<any[]>(`/movimientos-personas/indicadores${qs({ persona_id: f.persona_id, desde: f.desde, hasta: f.hasta })}`),
    placeholderData: keepPreviousData,
  });

  const hayFiltros = JSON.stringify(f) !== JSON.stringify(SIN_FILTROS);
  const monedas: any[] = ind ?? [];
  const i0 = monedas[0];
  const varias = monedas.length > 1;
  const periodo = f.desde || f.hasta ? `${f.desde ? fecha(f.desde) : 'el inicio'} al ${f.hasta ? fecha(f.hasta) : 'hoy'}` : 'Todo el historial';
  const filas: any[] = data?.filas ?? [];
  const personasConMov = useMemo(() => personas.filter((p) => p.movimientos > 0 || p.id === f.persona_id), [personas, f.persona_id]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Indicador titulo="Aportes de capital" valor={money(i0?.aportes ?? 0)} detalle={`${periodo}${i0?.retiros ? ` · retiros ${money(i0.retiros)}` : ''}`} icono={<Landmark className="size-5" />} tono="verde" />
        <Indicador titulo="Préstamos de socios pendientes" valor={money(i0?.prestamos_recibidos_pendiente ?? 0)} detalle={`La empresa debe · ${i0?.prestamos_recibidos_personas ?? 0} persona(s)`} icono={<HandCoins className="size-5" />} tono="ambar" />
        <Indicador titulo="Préstamos a empleados pendientes" valor={money(i0?.prestamos_otorgados_pendiente ?? 0)} detalle={`Deben a la empresa · ${i0?.prestamos_otorgados_personas ?? 0} persona(s)`} icono={<UserRoundCheck className="size-5" />} tono="azul" />
        <Indicador titulo="Adelantos de sueldo pendientes" valor={money(i0?.adelantos_pendiente ?? 0)} detalle={`A aplicar · ${i0?.adelantos_personas ?? 0} persona(s)`} icono={<Wallet className="size-5" />} tono="violeta" />
      </div>
      {varias && <Aviso tono="ambar">Hay movimientos en más de una moneda: los indicadores muestran sólo {i0.moneda}. Las monedas no se suman entre sí.</Aviso>}
      <p className="text-xs text-tenue">El aporte es un flujo del período elegido; los préstamos y adelantos son saldos pendientes a hoy (respetan la persona elegida, no las fechas). Son cuentas distintas y no se suman.</p>

      <Tarjeta>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Campo label="Persona"><Select value={f.persona_id} onChange={(e) => cambiar('persona_id', e.target.value)}><option value="">Todas</option>{personasConMov.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</Select></Campo>
          <Campo label="Categoría"><Select value={f.categoria_id} onChange={(e) => cambiar('categoria_id', e.target.value)}><option value="">Todas</option>{categorias.filter((c) => !c.pendiente).map((c) => <option key={c.id} value={c.id}>{c.nombre}{c.activa ? '' : ' (inactiva)'}</option>)}</Select></Campo>
          <Campo label="Tipo de movimiento"><Select value={f.direccion} onChange={(e) => cambiar('direccion', e.target.value)}><option value="">Todos</option><option value="entrada">Ingresos de dinero</option><option value="salida">Salidas de dinero</option><option value="sin_dinero">Sin movimiento de dinero</option></Select></Campo>
          <Campo label="Caja o banco"><Select value={f.cuenta} onChange={(e) => cambiar('cuenta', e.target.value)}><option value="">Todas</option><option value="caja">Caja en efectivo</option>{(cuentasInfo?.cuentas ?? []).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</Select></Campo>
          <Campo label="Estado"><Select value={f.estado} onChange={(e) => cambiar('estado', e.target.value)}><option value="">Todos</option>{(Object.keys(ESTADO_MOV_LABEL) as EstadoMovimiento[]).map((k) => <option key={k} value={k}>{ESTADO_MOV_LABEL[k]}</option>)}</Select></Campo>
          <Campo label="Desde"><Input type="date" value={f.desde} max={f.hasta || hoyISO()} onChange={(e) => cambiar('desde', e.target.value)} /></Campo>
          <Campo label="Hasta"><Input type="date" value={f.hasta} min={f.desde || undefined} onChange={(e) => cambiar('hasta', e.target.value)} /></Campo>
          <Campo label="Buscar"><Buscador value={f.q} onChange={(v) => cambiar('q', v)} placeholder="Persona o motivo…" /></Campo>
        </div>
        {hayFiltros && <div className="mt-3"><Boton tam="sm" icono={<X className="size-4" />} onClick={() => { setF(SIN_FILTROS); setPagina(1); }}>Limpiar filtros</Boton></div>}
      </Tarjeta>

      <Tarjeta
        sinPadding
        titulo={<span>Movimientos {isFetching && <span className="text-xs font-normal text-tenue">· actualizando…</span>}</span>}
        acciones={
          <div className="flex items-center gap-2">
            <Select value={orden} onChange={(e) => { setOrden(e.target.value); setPagina(1); }} aria-label="Orden" className="!w-auto">
              <option value="fecha_desc">Más recientes</option><option value="fecha_asc">Más antiguos</option><option value="importe_desc">Mayor importe</option><option value="importe_asc">Menor importe</option>
            </Select>
          </div>
        }
      >
        {data?.totales?.length > 0 && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-borde-suave bg-superficie-2 px-4 py-2 text-sm">
            {data.totales.map((t: any) => (
              <span key={t.moneda} className="tabular-nums">
                {data.totales.length > 1 && <b>{t.moneda}: </b>}
                Entradas <b className="text-emerald-700">{money(t.entradas)}</b> · Salidas <b className="text-red-600">{money(t.salidas)}</b> · {t.cantidad} movimiento(s){t.anulados ? ` · ${t.anulados} anulado(s)` : ''}
              </span>
            ))}
            <span className="text-xs text-tenue">Totales de todos los movimientos filtrados, sin contar anulados.</span>
          </div>
        )}
        {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={() => refetch()} /> : (
          <Tabla
            filas={filas}
            clave={(m) => m.id}
            onFila={(m) => setVer(m.id)}
            vacio={<Vacio icono={<HandCoins className="size-5" />} titulo={hayFiltros ? 'Ningún movimiento coincide con los filtros' : 'Todavía no hay movimientos con personas'} texto={hayFiltros ? undefined : 'Registrá un aporte de capital, un préstamo de un socio o un adelanto de sueldo.'} accion={puede('movpersonas.registrar') && !hayFiltros ? <Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => setNuevo({})}>Nuevo movimiento</Boton> : undefined} />}
            columnas={[
              { clave: 'f', titulo: 'Fecha', render: (m) => fecha(m.fecha), movil: 'meta' },
              { clave: 'p', titulo: 'Persona', render: (m) => <span>{m.persona}<span className="block text-xs text-tenue">{TIPO_PERSONA_LABEL[m.persona_tipo as keyof typeof TIPO_PERSONA_LABEL]}</span></span>, movil: 'titulo' },
              { clave: 'c', titulo: 'Categoría', render: (m) => m.categoria, movil: 'subtitulo' },
              { clave: 'm', titulo: 'Motivo', render: (m) => <span className="line-clamp-2 max-w-[22rem]">{m.motivo}</span>, movil: 'oculta' },
              { clave: 'e', titulo: 'Entrada', alinear: 'derecha', render: (m) => (m.direccion === 'entrada' ? <span className={`font-medium ${m.estado === 'anulado' ? 'text-slate-400 line-through' : 'text-emerald-700'}`}>{money(m.importe)}</span> : ''), movil: 'oculta' },
              { clave: 's', titulo: 'Salida', alinear: 'derecha', render: (m) => (m.direccion === 'salida' ? <span className={`font-medium ${m.estado === 'anulado' ? 'text-slate-400 line-through' : 'text-red-600'}`}>{money(m.importe)}</span> : ''), movil: 'oculta' },
              { clave: 'd', titulo: 'Importe', alinear: 'derecha', render: (m) => <span className={m.direccion === 'entrada' ? 'text-emerald-700' : m.direccion === 'salida' ? 'text-red-600' : 'text-slate-600'}>{m.direccion === 'entrada' ? '+' : m.direccion === 'salida' ? '−' : ''}{money(m.importe)}</span>, movil: 'derecha', className: 'hidden' },
              { clave: 'u', titulo: 'Cuenta', render: (m) => m.cuenta ?? 'Sin dinero', movil: 'meta' },
              { clave: 'x', titulo: 'Estado', render: (m) => <EstadoMov m={m} />, movil: 'meta' },
              { clave: 'a', titulo: '', render: () => <ChevronRight className="size-4 text-slate-500" />, movil: 'oculta' },
            ]}
          />
        )}
        {data && data.paginas > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-borde-suave px-4 py-3 text-sm">
            <span className="text-tenue">Página {data.pagina} de {data.paginas} · {data.total} movimiento(s)</span>
            <div className="flex gap-2">
              <Boton tam="sm" icono={<ChevronLeft className="size-4" />} disabled={pagina <= 1} onClick={() => setPagina(pagina - 1)}>Anterior</Boton>
              <Boton tam="sm" disabled={pagina >= data.paginas} onClick={() => setPagina(pagina + 1)}>Siguiente <ChevronRight className="size-4" /></Boton>
            </div>
          </div>
        )}
      </Tarjeta>

      {ver && <Detalle id={ver} onCerrar={() => setVer(null)} onRegularizar={(p) => { setVer(null); setNuevo(p); }} />}
      {nuevo && <NuevoMovimiento preset={nuevo} onCerrar={() => setNuevo(null)} />}
    </div>
  );
}

type Pestana = 'movimientos' | 'persona' | 'categoria' | 'categorias';

export function MovimientosPersonas() {
  const { puede } = useAuth();
  const [tab, setTab] = useState<Pestana>('movimientos');
  const [nuevo, setNuevo] = useState(false);
  const items = [
    { clave: 'movimientos' as const, titulo: 'Movimientos' },
    ...(puede('movpersonas.reportes') ? [{ clave: 'persona' as const, titulo: 'Totales por persona' }, { clave: 'categoria' as const, titulo: 'Totales por categoría' }] : []),
    ...(puede('movpersonas.administrar') ? [{ clave: 'categorias' as const, titulo: 'Categorías y personas' }] : []),
  ];
  return (
    <div>
      <Encabezado
        titulo="Movimientos con personas"
        subtitulo="Aportes, préstamos y adelantos entre la empresa y sus socios, propietarios y personal. Información sensible: sólo la ven quienes tienen permiso."
        acciones={puede('movpersonas.registrar') ? <Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => setNuevo(true)}>Nuevo movimiento</Boton> : undefined}
      />
      {items.length > 1 && <div className="mb-4"><Pestanas items={items} activo={tab} onCambio={setTab} /></div>}
      {tab === 'movimientos' && <Movimientos />}
      {tab === 'persona' && <ResumenPersona />}
      {tab === 'categoria' && <ResumenCategoria />}
      {tab === 'categorias' && <Categorias />}
      {nuevo && <NuevoMovimiento onCerrar={() => setNuevo(false)} />}
    </div>
  );
}
