// Gastos y finanzas: resumen por período (base caja), gastos, gastos recurrentes y categorías.
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Ban, Download, Pencil, Plus, Receipt, Repeat, SkipForward } from 'lucide-react';
import { api, nuevaClave, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { invalidarDinero } from '@/lib/caja';
import { descargarCSV, pesosCSV } from '@/lib/csv';
import { fecha, hoyISO, money } from '@/lib/format';
import { Aviso, Boton, Buscador, Campo, Cargando, Check, Dato, Encabezado, ErrorCaja, Indicador, Input, InputMoneda, Insignia, Modal, Pestanas, Select, Tabla, Tarjeta, useConfirmar, useDebounce, useToast, Vacio } from '@/components/ui';
import { ModalGasto } from '@/components/FormGasto';
import { primerDiaMes, SelectorPeriodo } from '@/components/Periodo';
import { FRECUENCIAS_GASTO, FRECUENCIA_GASTO_LABEL, MEDIOS_PAGO, MEDIO_PAGO_LABEL, TIPOS_CATEGORIA_GASTO, TIPO_CATEGORIA_GASTO_LABEL, type MedioPago, type TipoCategoriaGasto } from '@shared/dominio';

// ───────────── Resumen ─────────────
function Resumen() {
  const [desde, setDesde] = useState(primerDiaMes());
  const [hasta, setHasta] = useState(hoyISO());
  const valido = desde && hasta && desde <= hasta;
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['finanzas', 'resumen', { desde, hasta }], queryFn: () => api.get(`/finanzas/resumen?desde=${desde}&hasta=${hasta}`), enabled: !!valido });
  const maxSerie = useMemo(() => Math.max(1, ...(data?.serie ?? []).map((s: any) => Math.max(s.ingresos, s.egresos))), [data]);
  const exportar = () => {
    if (!data) return;
    descargarCSV(`finanzas-${desde}_${hasta}`, ['Período', 'Ingresos', 'Egresos', 'Resultado'], data.serie.map((s: any) => [s.periodo, pesosCSV(s.ingresos), pesosCSV(s.egresos), pesosCSV(s.ingresos - s.egresos)]));
  };
  return (
    <>
      <SelectorPeriodo desde={desde} hasta={hasta} onCambio={(d, h) => { setDesde(d); setHasta(h); }} />
      {!valido ? <Aviso tono="ambar">Elegí un período válido (la fecha inicial no puede ser posterior a la final).</Aviso> : isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <div className="space-y-5">
          <Aviso>Resumen en base <strong>caja</strong>: cuenta lo efectivamente cobrado y pagado, una sola vez. Las ventas a crédito y las compras sin pagar se muestran aparte como “devengado”.</Aviso>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Indicador titulo="Ingresos" valor={money(data.ingresos.total)} detalle={`Cobros ${money(data.ingresos.cobros)} · otros ${money(data.ingresos.otros)}`} tono="verde" />
            <Indicador titulo="Egresos" valor={money(data.egresos.total)} detalle={`Proveedores ${money(data.egresos.pagos_proveedor)} · gastos ${money(data.egresos.gastos)}`} tono="rojo" />
            <Indicador titulo="Resultado" valor={money(data.resultado)} detalle="Ingresos − egresos" tono={data.resultado >= 0 ? 'azul' : 'ambar'} />
            <Indicador titulo="Por cobrar / por pagar" valor={`${money(data.devengado.por_cobrar)} / ${money(data.devengado.por_pagar)}`} detalle="Saldos actuales" tono="gris" />
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <Tarjeta titulo="Por medio de pago" sinPadding>
              {data.por_medio.length === 0 ? <p className="px-4 py-6 text-center text-sm text-tenue">Sin movimientos en el período</p> : (
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-borde text-left text-xs uppercase text-tenue"><th className="px-4 py-2">Medio</th><th className="px-2 py-2 text-right">Ingresos</th><th className="px-2 py-2 text-right">Egresos</th><th className="px-4 py-2 text-right">Neto</th></tr></thead>
                  <tbody>{data.por_medio.map((m: any) => <tr key={m.medio} className="border-b border-borde last:border-0"><td className="px-4 py-2">{MEDIO_PAGO_LABEL[m.medio as MedioPago]}</td><td className="px-2 py-2 text-right tabular-nums">{money(m.ingresos)}</td><td className="px-2 py-2 text-right tabular-nums">{money(m.egresos)}</td><td className="px-4 py-2 text-right font-medium tabular-nums">{money(m.ingresos - m.egresos)}</td></tr>)}</tbody>
                </table>
              )}
            </Tarjeta>
            <Tarjeta titulo="Gastos por categoría" sinPadding>
              {data.gastos_por_categoria.length === 0 ? <p className="px-4 py-6 text-center text-sm text-tenue">Sin gastos en el período</p> : (
                <ul className="divide-y divide-borde text-sm">
                  {data.gastos_por_categoria.map((c: any) => (
                    <li key={c.id} className="px-4 py-2">
                      <div className="flex items-center justify-between gap-2"><span>{c.nombre} <span className="text-xs text-tenue">({c.cantidad})</span></span><span className="font-medium tabular-nums">{money(c.total)}</span></div>
                      <div className="mt-1 h-1.5 rounded-full bg-slate-100"><div className="h-1.5 rounded-full bg-red-400" style={{ width: `${Math.max(2, (c.total / data.egresos.gastos) * 100)}%` }} /></div>
                    </li>
                  ))}
                </ul>
              )}
            </Tarjeta>
            <Tarjeta titulo="Devengado en el período" subtitulo="No son ingresos ni egresos hasta cobrarse o pagarse">
              <dl className="grid grid-cols-2 gap-4">
                <Dato etiqueta={`Ventas emitidas (${data.devengado.ventas_cantidad})`}>{money(data.devengado.ventas_emitidas)}</Dato>
                <Dato etiqueta="Compras registradas">{money(data.devengado.compras_registradas)}</Dato>
              </dl>
            </Tarjeta>
            <Tarjeta titulo={data.serie_tipo === 'mes' ? 'Evolución mensual' : 'Evolución diaria'} acciones={<Boton tam="sm" icono={<Download className="size-4" />} onClick={exportar}>CSV</Boton>} sinPadding>
              {data.serie.length === 0 ? <p className="px-4 py-6 text-center text-sm text-tenue">Sin datos</p> : (
                <ul className="max-h-80 divide-y divide-borde overflow-y-auto text-sm">
                  {data.serie.map((s: any) => (
                    <li key={s.periodo} className="px-4 py-2">
                      <div className="flex justify-between"><span>{s.periodo.length === 7 ? s.periodo : fecha(s.periodo)}</span><span className="tabular-nums text-tenue">{money(s.ingresos)} / {money(s.egresos)}</span></div>
                      <div className="mt-1 space-y-0.5"><div className="h-1.5 rounded-full bg-emerald-400" style={{ width: `${(s.ingresos / maxSerie) * 100}%` }} /><div className="h-1.5 rounded-full bg-red-400" style={{ width: `${(s.egresos / maxSerie) * 100}%` }} /></div>
                    </li>
                  ))}
                </ul>
              )}
            </Tarjeta>
          </div>
        </div>
      )}
    </>
  );
}

// ───────────── Gastos ─────────────
function Gastos() {
  const { puede } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [desde, setDesde] = useState(primerDiaMes());
  const [hasta, setHasta] = useState(hoyISO());
  const [categoria, setCategoria] = useState('');
  const [medio, setMedio] = useState('');
  const [estado, setEstado] = useState('registrado');
  const [q, setQ] = useState('');
  const [nuevo, setNuevo] = useState(false);
  const [anular, setAnular] = useState<any | null>(null);
  const [motivo, setMotivo] = useState('');
  const dq = useDebounce(q);
  const { data: cats = [] } = useQuery({ queryKey: ['gastos', 'categorias', 'todas'], queryFn: () => api.get<any[]>('/categorias-gasto?todas=1') });
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['gastos', 'lista', { desde, hasta, categoria, medio, estado, dq }], queryFn: () => api.get<any[]>(`/gastos${qs({ desde, hasta, categoria_id: categoria, medio, estado, q: dq })}`) });
  const vigentes = data.filter((g) => g.estado === 'registrado');
  const m = useMutation({
    mutationFn: () => api.post(`/gastos/${anular.id}/anular`, { motivo }),
    onSuccess: () => {
      invalidarDinero(qc);
      toast.ok('Gasto anulado');
      setAnular(null);
      setMotivo('');
    },
    onError: toast.error,
  });
  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Campo label="Desde"><Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} /></Campo>
        <Campo label="Hasta"><Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} /></Campo>
        <Campo label="Categoría"><Select value={categoria} onChange={(e) => setCategoria(e.target.value)} className="w-auto"><option value="">Todas</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</Select></Campo>
        <Campo label="Medio"><Select value={medio} onChange={(e) => setMedio(e.target.value)} className="w-auto"><option value="">Todos</option>{MEDIOS_PAGO.map((x) => <option key={x} value={x}>{MEDIO_PAGO_LABEL[x]}</option>)}</Select></Campo>
        <Campo label="Estado"><Select value={estado} onChange={(e) => setEstado(e.target.value)} className="w-auto"><option value="registrado">Vigentes</option><option value="anulado">Anulados</option><option value="">Todos</option></Select></Campo>
        <Buscador value={q} onChange={setQ} placeholder="Concepto, comprobante o proveedor" className="min-w-52 flex-1" />
        <div className="flex gap-2">
          <Boton icono={<Download className="size-4" />} disabled={!data.length} onClick={() => descargarCSV(`gastos-${desde}_${hasta}`, ['N°', 'Fecha', 'Categoría', 'Concepto', 'Medio', 'Importe', 'Estado'], data.map((g) => [g.numero, g.fecha, g.categoria, g.concepto, MEDIO_PAGO_LABEL[g.medio as MedioPago], pesosCSV(g.importe), g.estado]))}>CSV</Boton>
          <Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => setNuevo(true)}>Nuevo gasto</Boton>
        </div>
      </div>
      <div className="mb-3"><Insignia tono="rojo" className="px-3 py-1 text-sm">Total vigente: {money(vigentes.reduce((a, g) => a + g.importe, 0))} ({vigentes.length})</Insignia></div>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={data}
            clave={(g) => g.id}
            vacio={<Vacio icono={<Receipt className="size-5" />} titulo="No hay gastos con esos filtros" accion={<Boton variante="primario" onClick={() => setNuevo(true)}>Registrar un gasto</Boton>} />}
            columnas={[
              { clave: 'n', titulo: 'N°', render: (g) => `#${g.numero}`, movil: 'meta' },
              { clave: 'f', titulo: 'Fecha', render: (g) => fecha(g.fecha), movil: 'meta' },
              { clave: 'c', titulo: 'Concepto', render: (g) => <span className={g.estado === 'anulado' ? 'text-tenue line-through' : 'font-medium'}>{g.concepto}</span>, movil: 'titulo' },
              { clave: 'k', titulo: 'Categoría', render: (g) => g.categoria, movil: 'subtitulo' },
              { clave: 'm', titulo: 'Medio', render: (g) => MEDIO_PAGO_LABEL[g.medio as MedioPago], movil: 'meta' },
              { clave: 'p', titulo: 'Proveedor', render: (g) => g.proveedor ?? '—', movil: 'oculta' },
              { clave: 'u', titulo: 'Registró', render: (g) => g.usuario ?? '—', movil: 'oculta' },
              { clave: 'i', titulo: 'Importe', alinear: 'derecha', render: (g) => money(g.importe), movil: 'derecha' },
              { clave: 'a', titulo: '', render: (g) => g.estado === 'anulado' ? <Insignia tono="gris">Anulado</Insignia> : puede('gastos.gestionar') ? <Boton tam="sm" variante="fantasma" icono={<Ban className="size-4" />} onClick={() => setAnular(g)}>Anular</Boton> : null, movil: 'meta' },
            ]}
          />
        </Tarjeta>
      )}
      {nuevo && <ModalGasto onCerrar={() => setNuevo(false)} />}
      <Modal abierto={!!anular} onCerrar={() => setAnular(null)} titulo={`Anular gasto #${anular?.numero ?? ''}`} ancho="sm" pie={<><Boton onClick={() => setAnular(null)}>Cancelar</Boton><Boton variante="peligro" disabled={motivo.trim().length < 3} cargando={m.isPending} onClick={() => m.mutate()}>Anular gasto</Boton></>}>
        <div className="space-y-3">
          <p className="text-sm text-tenue">El gasto deja de contar en los resúmenes y se registra el contra-asiento en la caja (si fue en efectivo, el dinero vuelve a la caja abierta).</p>
          <Campo label="Motivo" requerido><Input value={motivo} onChange={(e) => setMotivo(e.target.value)} autoFocus /></Campo>
        </div>
      </Modal>
    </>
  );
}

// ───────────── Recurrentes ─────────────
function FormRecurrente({ inicial, onCerrar }: { inicial?: any; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: cats = [] } = useQuery({ queryKey: ['gastos', 'categorias'], queryFn: () => api.get<any[]>('/categorias-gasto') });
  const [f, setF] = useState({
    categoria_id: inicial?.categoria_id ?? '', concepto: inicial?.concepto ?? '', importe: inicial?.importe ?? 0, medio: (inicial?.medio ?? 'transferencia') as MedioPago,
    frecuencia: inicial?.frecuencia ?? 'mensual', dia: inicial?.dia ? String(inicial.dia) : '', proxima_fecha: inicial?.proxima_fecha ?? hoyISO(), notas: inicial?.notas ?? '',
  });
  const cat = f.categoria_id || cats[0]?.id || '';
  const m = useMutation({
    mutationFn: () => {
      const datos = { ...f, categoria_id: cat, dia: f.dia ? Number(f.dia) : null, notas: f.notas || null };
      return inicial ? api.put(`/gastos-recurrentes/${inicial.id}`, datos) : api.post('/gastos-recurrentes', datos);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['gastos'] });
      toast.ok('Gasto recurrente guardado');
      onCerrar();
    },
    onError: toast.error,
  });
  return (
    <Modal abierto onCerrar={onCerrar} titulo={inicial ? 'Editar gasto recurrente' : 'Nuevo gasto recurrente'} ancho="lg" pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" disabled={f.concepto.trim().length < 3 || f.importe <= 0 || !cat} cargando={m.isPending} onClick={() => m.mutate()}>Guardar</Boton></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Campo label="Concepto" requerido className="sm:col-span-2"><Input value={f.concepto} onChange={(e) => setF({ ...f, concepto: e.target.value })} placeholder="Ej.: alquiler del local" autoFocus /></Campo>
        <Campo label="Categoría"><Select value={cat} onChange={(e) => setF({ ...f, categoria_id: e.target.value })}>{cats.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</Select></Campo>
        <Campo label="Importe habitual" requerido><InputMoneda value={f.importe} onChange={(v) => setF({ ...f, importe: v })} /></Campo>
        <Campo label="Medio de pago habitual"><Select value={f.medio} onChange={(e) => setF({ ...f, medio: e.target.value as MedioPago })}>{MEDIOS_PAGO.map((x) => <option key={x} value={x}>{MEDIO_PAGO_LABEL[x]}</option>)}</Select></Campo>
        <Campo label="Frecuencia"><Select value={f.frecuencia} onChange={(e) => setF({ ...f, frecuencia: e.target.value })}>{FRECUENCIAS_GASTO.map((x) => <option key={x} value={x}>{FRECUENCIA_GASTO_LABEL[x]}</option>)}</Select></Campo>
        <Campo label="Próximo vencimiento"><Input type="date" value={f.proxima_fecha} onChange={(e) => setF({ ...f, proxima_fecha: e.target.value })} /></Campo>
        {f.frecuencia !== 'semanal' && <Campo label="Día del mes (opcional)" hint="Si el mes es más corto se usa el último día"><Input type="number" min={1} max={31} value={f.dia} onChange={(e) => setF({ ...f, dia: e.target.value })} /></Campo>}
      </div>
    </Modal>
  );
}

function ModalRegistrarRecurrente({ r, onCerrar }: { r: any; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [importe, setImporte] = useState<number>(r.importe);
  const [medio, setMedio] = useState<MedioPago>(r.medio);
  const [clave] = useState(nuevaClave());
  const m = useMutation({
    mutationFn: () => api.post(`/gastos-recurrentes/${r.id}/registrar`, { ocurrencia: r.proxima_fecha, importe, medio, idem_key: clave }),
    onSuccess: () => {
      invalidarDinero(qc);
      toast.ok('Gasto registrado');
      onCerrar();
    },
    onError: (e) => {
      qc.invalidateQueries({ queryKey: ['gastos'] });
      toast.error(e);
    },
  });
  return (
    <Modal abierto onCerrar={onCerrar} titulo={`Registrar: ${r.concepto}`} ancho="sm" pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" disabled={importe <= 0} cargando={m.isPending} onClick={() => m.mutate()}>Registrar gasto</Boton></>}>
      <div className="space-y-3">
        <p className="text-sm text-tenue">Vencimiento del {fecha(r.proxima_fecha)}. Podés ajustar el importe real de esta vez.</p>
        <Campo label="Importe"><InputMoneda value={importe} onChange={setImporte} autoFocus /></Campo>
        <Campo label="Medio de pago"><Select value={medio} onChange={(e) => setMedio(e.target.value as MedioPago)}>{MEDIOS_PAGO.map((x) => <option key={x} value={x}>{MEDIO_PAGO_LABEL[x]}</option>)}</Select></Campo>
      </div>
    </Modal>
  );
}

function Recurrentes() {
  const qc = useQueryClient();
  const toast = useToast();
  const { confirmar, dialogo } = useConfirmar();
  const [form, setForm] = useState<null | 'nuevo' | any>(null);
  const [registrar, setRegistrar] = useState<any | null>(null);
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['gastos', 'recurrentes'], queryFn: () => api.get<any[]>('/gastos-recurrentes') });
  const saltear = useMutation({
    mutationFn: (r: any) => api.post(`/gastos-recurrentes/${r.id}/saltear`, { ocurrencia: r.proxima_fecha }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['gastos'] });
      toast.ok('Ocurrencia salteada');
    },
    onError: (e) => {
      qc.invalidateQueries({ queryKey: ['gastos'] });
      toast.error(e);
    },
  });
  const toggle = useMutation({
    mutationFn: (r: any) => api.put(`/gastos-recurrentes/${r.id}`, { activo: !r.activo }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gastos'] }),
    onError: toast.error,
  });
  const pendientes = data.filter((r) => r.vencido);
  return (
    <>
      {dialogo}
      {pendientes.length > 0 && <Aviso tono="ambar" className="mb-4"><strong>{pendientes.length} gasto(s) recurrente(s) vencido(s)</strong> esperan que los registres o los saltees.</Aviso>}
      <div className="mb-4 flex justify-end"><Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => setForm('nuevo')}>Nuevo gasto recurrente</Boton></div>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={data}
            clave={(r) => r.id}
            vacio={<Vacio icono={<Repeat className="size-5" />} titulo="Sin gastos recurrentes" texto="Cargá el alquiler, los servicios o los sueldos para que el sistema te avise cuando vencen." />}
            columnas={[
              { clave: 'c', titulo: 'Concepto', render: (r) => <span className={r.activo ? 'font-medium' : 'text-tenue'}>{r.concepto}</span>, movil: 'titulo' },
              { clave: 'k', titulo: 'Categoría', render: (r) => r.categoria, movil: 'subtitulo' },
              { clave: 'f', titulo: 'Frecuencia', render: (r) => FRECUENCIA_GASTO_LABEL[r.frecuencia as keyof typeof FRECUENCIA_GASTO_LABEL], movil: 'meta' },
              { clave: 'p', titulo: 'Próximo', render: (r) => (r.activo ? <span className={r.vencido ? 'font-semibold text-red-600' : ''}>{fecha(r.proxima_fecha)}{r.vencido ? ' · vencido' : ''}</span> : <Insignia tono="gris">Inactivo</Insignia>), movil: 'meta' },
              { clave: 'i', titulo: 'Importe', alinear: 'derecha', render: (r) => money(r.importe), movil: 'derecha' },
              {
                clave: 'a', titulo: '',
                render: (r) => (
                  <div className="flex flex-wrap justify-end gap-1">
                    {r.activo ? <Boton tam="sm" variante={r.vencido ? 'primario' : 'secundario'} icono={<Receipt className="size-4" />} onClick={() => setRegistrar(r)}>Registrar</Boton> : null}
                    {r.activo ? <Boton tam="sm" variante="fantasma" icono={<SkipForward className="size-4" />} onClick={async () => { if (await confirmar('Saltear ocurrencia', `No se registrará el gasto del ${fecha(r.proxima_fecha)} y pasará al período siguiente.`)) saltear.mutate(r); }}>Saltear</Boton> : null}
                    <Boton tam="sm" variante="fantasma" icono={<Pencil className="size-4" />} onClick={() => setForm(r)} aria-label="Editar" />
                    <Boton tam="sm" variante="fantasma" onClick={() => toggle.mutate(r)}>{r.activo ? 'Desactivar' : 'Activar'}</Boton>
                  </div>
                ),
                movil: 'meta',
              },
            ]}
          />
        </Tarjeta>
      )}
      {form && <FormRecurrente inicial={form === 'nuevo' ? undefined : form} onCerrar={() => setForm(null)} />}
      {registrar && <ModalRegistrarRecurrente r={registrar} onCerrar={() => setRegistrar(null)} />}
    </>
  );
}

// ───────────── Categorías ─────────────
function Categorias() {
  const qc = useQueryClient();
  const toast = useToast();
  const [nombre, setNombre] = useState('');
  const [tipo, setTipo] = useState<TipoCategoriaGasto>('operativo');
  const [soloActivas, setSoloActivas] = useState(false);
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['gastos', 'categorias', 'todas'], queryFn: () => api.get<any[]>('/categorias-gasto?todas=1') });
  const crear = useMutation({
    mutationFn: () => api.post('/categorias-gasto', { nombre, tipo }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['gastos'] });
      setNombre('');
      toast.ok('Categoría creada');
    },
    onError: toast.error,
  });
  const cambiar = useMutation({
    mutationFn: ({ id, datos }: { id: string; datos: object }) => api.put(`/categorias-gasto/${id}`, datos),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gastos'] }),
    onError: toast.error,
  });
  const filas = data.filter((c) => !soloActivas || c.activa);
  return (
    <>
      <Tarjeta titulo="Nueva categoría" className="mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <Campo label="Nombre" className="min-w-52 flex-1"><Input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Ej.: Seguros" /></Campo>
          <Campo label="Tipo"><Select value={tipo} onChange={(e) => setTipo(e.target.value as TipoCategoriaGasto)} className="w-auto">{TIPOS_CATEGORIA_GASTO.map((t) => <option key={t} value={t}>{TIPO_CATEGORIA_GASTO_LABEL[t]}</option>)}</Select></Campo>
          <Boton variante="primario" icono={<Plus className="size-4" />} disabled={nombre.trim().length < 2} cargando={crear.isPending} onClick={() => crear.mutate()}>Agregar</Boton>
        </div>
      </Tarjeta>
      <div className="mb-3"><Check checked={soloActivas} onChange={setSoloActivas} label="Ocultar desactivadas" /></div>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={filas}
            clave={(c) => c.id}
            columnas={[
              { clave: 'n', titulo: 'Categoría', render: (c) => <span className={c.activa ? 'font-medium' : 'text-tenue line-through'}>{c.nombre}</span>, movil: 'titulo' },
              { clave: 't', titulo: 'Tipo', render: (c) => TIPO_CATEGORIA_GASTO_LABEL[c.tipo as TipoCategoriaGasto], movil: 'subtitulo' },
              { clave: 'g', titulo: 'Gastos', alinear: 'derecha', render: (c) => c.gastos, movil: 'derecha' },
              { clave: 'a', titulo: '', render: (c) => <Boton tam="sm" variante="fantasma" onClick={() => cambiar.mutate({ id: c.id, datos: { activa: !c.activa } })}>{c.activa ? 'Desactivar' : 'Activar'}</Boton>, movil: 'meta' },
            ]}
          />
        </Tarjeta>
      )}
    </>
  );
}

export function Finanzas() {
  const { puede } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tabs = [
    { clave: 'resumen', titulo: 'Resumen' },
    { clave: 'gastos', titulo: 'Gastos' },
    ...(puede('gastos.gestionar') ? [{ clave: 'recurrentes', titulo: 'Recurrentes' }, { clave: 'categorias', titulo: 'Categorías' }] : []),
  ];
  const tab = tabs.some((t) => t.clave === sp.get('tab')) ? sp.get('tab')! : 'resumen';
  return (
    <>
      <Encabezado titulo="Gastos y finanzas" subtitulo="Ingresos, egresos y gastos del taller" />
      <Pestanas items={tabs} activo={tab} onCambio={(t) => setSp({ tab: t })} />
      {tab === 'resumen' && <Resumen />}
      {tab === 'gastos' && <Gastos />}
      {tab === 'recurrentes' && <Recurrentes />}
      {tab === 'categorias' && <Categorias />}
    </>
  );
}
