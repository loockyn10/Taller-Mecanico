// Libro diario: asientos en orden cronológico con su origen, responsable y estado. Alta de asientos manuales y su ciclo (borrador → registrado → revertido).
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plus, Trash2 } from 'lucide-react';
import { api, nuevaClave, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { descargarCSV, exportarAutorizado, pesosCSV } from '@/lib/csv';
import { fecha, hoyISO, money } from '@/lib/format';
import { Aviso, Boton, BotonIcono, Buscador, Campo, Cargando, ErrorCaja, Input, InputMoneda, Insignia, Modal, Select, TablaApilable, Tarjeta, useConfirmar, useDebounce, useToast, Vacio } from '@/components/ui';
import { ORIGEN_LABEL } from '@shared/contabilidad';
import { BotonImprimir, EstadoAsiento, imp, OrigenLink, Periodo } from './comun';

interface Linea { id?: string; cuenta_id: string; cuenta_codigo?: string; cuenta_nombre?: string; debe: number; haber: number; detalle?: string | null }
interface Asiento {
  id: string; numero: number | null; fecha: string; descripcion: string; estado: string; modo: string; origen_tipo: string; origen_id: string | null; evento: string | null; total: number;
  usuario: string | null; advertencia: string | null; costo_incompleto: number; motivo: string | null; revierte_numero: number | null; revertido_por_numero: number | null; corrige_numero?: number | null; lineas: Linea[];
}
interface CuentaPlan { id: string; codigo: string; nombre: string; tipo: string; imputable: number; activa: number }

const MODO: Record<string, string> = { manual: 'Manual', automatico: 'Automático', historico: 'Histórico (operación anterior)', reversion: 'Contra-asiento' };

/** Formulario de asiento manual (alta, edición de borrador y corrección de uno registrado). */
export function FormAsiento({ inicial, modo, onCerrar }: { inicial?: Asiento; modo: 'nuevo' | 'editar' | 'corregir'; onCerrar: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: plan } = useQuery<CuentaPlan[]>({ queryKey: ['contab', 'plan', 'form'], queryFn: () => api.get('/contabilidad/plan') });
  const cuentas = (plan ?? []).filter((c) => c.imputable && c.activa);
  const [clave] = useState(nuevaClave);
  const [f, setF] = useState({
    fecha: modo === 'editar' ? inicial!.fecha : hoyISO(),
    descripcion: inicial?.descripcion ?? '',
    motivo: '',
    lineas: (inicial?.lineas.length ? inicial.lineas : ([{ cuenta_id: '', debe: 0, haber: 0 }, { cuenta_id: '', debe: 0, haber: 0 }] as Linea[])).map((l) => ({ cuenta_id: l.cuenta_id, debe: l.debe, haber: l.haber, detalle: l.detalle ?? '' })),
  });
  const debe = f.lineas.reduce((a, l) => a + l.debe, 0);
  const haber = f.lineas.reduce((a, l) => a + l.haber, 0);
  const balancea = debe === haber && debe > 0;
  const lineasOk = f.lineas.every((l) => l.cuenta_id && (l.debe > 0) !== (l.haber > 0));
  const set = (i: number, p: Partial<{ cuenta_id: string; debe: number; haber: number; detalle: string }>) => setF({ ...f, lineas: f.lineas.map((l, k) => (k === i ? { ...l, ...p } : l)) });
  const cuerpo = (registrar: boolean) => ({
    fecha: f.fecha, descripcion: f.descripcion, registrar,
    lineas: f.lineas.map((l) => ({ cuenta_id: l.cuenta_id, debe: l.debe, haber: l.haber, detalle: l.detalle || null })),
  });
  const guardar = useMutation({
    mutationFn: (registrar: boolean) =>
      modo === 'editar' ? api.put(`/contabilidad/asientos/${inicial!.id}`, cuerpo(registrar))
      : modo === 'corregir' ? api.post(`/contabilidad/asientos/${inicial!.id}/corregir`, { ...cuerpo(registrar), motivo: f.motivo, idem_key: clave })
      : api.post('/contabilidad/asientos', { ...cuerpo(registrar), idem_key: clave }),
    onSuccess: (_r, registrar) => {
      toast.ok(registrar ? 'Asiento registrado' : 'Borrador guardado');
      qc.invalidateQueries({ queryKey: ['contab'] });
      onCerrar();
    },
    onError: toast.error,
  });
  const valido = f.descripcion.trim().length >= 3 && lineasOk && (modo !== 'corregir' || f.motivo.trim().length >= 3);
  return (
    <Modal
      abierto
      ancho="xl"
      onCerrar={onCerrar}
      titulo={modo === 'nuevo' ? 'Nuevo asiento manual' : modo === 'editar' ? `Editar borrador` : `Corregir el asiento N° ${inicial!.numero}`}
      pie={
        <>
          <Boton onClick={onCerrar}>Cancelar</Boton>
          {modo !== 'corregir' && <Boton disabled={!valido} cargando={guardar.isPending} onClick={() => guardar.mutate(false)}>Guardar borrador</Boton>}
          <Boton variante="primario" disabled={!valido || !balancea} cargando={guardar.isPending} onClick={() => guardar.mutate(true)}>{modo === 'corregir' ? 'Revertir y registrar corrección' : 'Registrar'}</Boton>
        </>
      }
    >
      <div className="space-y-3">
        {modo === 'corregir' && <Aviso>El asiento original queda revertido con un contra-asiento y se registra uno nuevo vinculado a él: no se pierde el rastro de la corrección.</Aviso>}
        <div className="grid gap-3 sm:grid-cols-4">
          <Campo label="Fecha" requerido><Input type="date" max={hoyISO()} value={f.fecha} onChange={(e) => setF({ ...f, fecha: e.target.value })} /></Campo>
          <Campo label="Descripción" requerido className="sm:col-span-3"><Input value={f.descripcion} maxLength={200} onChange={(e) => setF({ ...f, descripcion: e.target.value })} placeholder="Ej. Aporte de capital del propietario" /></Campo>
        </div>
        {modo === 'corregir' && <Campo label="Motivo de la corrección" requerido><Input value={f.motivo} maxLength={300} onChange={(e) => setF({ ...f, motivo: e.target.value })} /></Campo>}
        <div className="space-y-2">
          <div className="hidden grid-cols-12 gap-2 text-xs font-semibold uppercase tracking-wide text-tenue sm:grid"><span className="col-span-5">Cuenta</span><span className="col-span-2">Detalle</span><span className="col-span-2 text-right">Debe</span><span className="col-span-2 text-right">Haber</span></div>
          {f.lineas.map((l, i) => (
            <div key={i} className="grid grid-cols-12 items-center gap-2">
              <Select className="col-span-12 sm:col-span-5" value={l.cuenta_id} onChange={(e) => set(i, { cuenta_id: e.target.value })}>
                <option value="">— Elegí una cuenta —</option>
                {cuentas.map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.nombre}</option>)}
              </Select>
              <Input className="col-span-12 sm:col-span-2" placeholder="Detalle" value={l.detalle} maxLength={200} onChange={(e) => set(i, { detalle: e.target.value })} />
              <InputMoneda className="col-span-5 sm:col-span-2" value={l.debe} onChange={(v) => set(i, { debe: v, haber: v ? 0 : l.haber })} />
              <InputMoneda className="col-span-5 sm:col-span-2" value={l.haber} onChange={(v) => set(i, { haber: v, debe: v ? 0 : l.debe })} />
              <BotonIcono etiqueta="Quitar línea" peligro disabled={f.lineas.length <= 2} className="col-span-2 justify-self-end sm:col-span-1" onClick={() => setF({ ...f, lineas: f.lineas.filter((_, k) => k !== i) })}><Trash2 className="size-4" /></BotonIcono>
            </div>
          ))}
          <Boton tam="sm" icono={<Plus className="size-4" />} onClick={() => setF({ ...f, lineas: [...f.lineas, { cuenta_id: '', debe: 0, haber: 0, detalle: '' }] })}>Agregar línea</Boton>
        </div>
        <div className={`flex flex-wrap items-center justify-between gap-2 rounded-ctl px-3 py-2 text-sm ${balancea ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}`}>
          <span>Debe {money(debe)} · Haber {money(haber)}</span>
          <strong>{balancea ? 'El asiento balancea' : debe === haber ? 'Cargá importes' : `Diferencia ${money(Math.abs(debe - haber))}: no se puede registrar`}</strong>
        </div>
      </div>
    </Modal>
  );
}

function TarjetaAsiento({ a, gestiona, onEditar, onCorregir }: { a: Asiento; gestiona: boolean; onEditar: (a: Asiento) => void; onCorregir: (a: Asiento) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { confirmar, dialogo } = useConfirmar();
  const [motivo, setMotivo] = useState<string | null>(null);
  const accion = useMutation({
    mutationFn: ({ ruta, datos }: { ruta: string; datos?: unknown }) => (ruta === 'descartar' ? api.del(`/contabilidad/asientos/${a.id}`) : api.post(`/contabilidad/asientos/${a.id}/${ruta}`, datos ?? {})),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['contab'] }); setMotivo(null); },
    onError: toast.error,
  });
  const manual = a.modo === 'manual';
  return (
    <div className={`rounded-card border bg-white ${a.estado === 'revertido' ? 'border-borde opacity-80' : 'border-borde'} shadow-[0_1px_2px_rgba(16,24,40,0.04)]`}>
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-borde px-4 py-2.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <strong className="tabular-nums">{a.numero ? `N° ${a.numero}` : 'Borrador'}</strong>
            <span className="text-tenue">{fecha(a.fecha)}</span>
            <EstadoAsiento estado={a.estado} />
            <Insignia tono={a.modo === 'historico' ? 'violeta' : a.modo === 'reversion' ? 'ambar' : 'gris'}>{MODO[a.modo] ?? a.modo}</Insignia>
            {a.costo_incompleto ? <Insignia tono="ambar">Costo incompleto</Insignia> : null}
          </div>
          <div className="mt-1 font-medium"><OrigenLink tipo={a.origen_tipo} id={a.origen_id}>{a.descripcion}</OrigenLink></div>
          <div className="text-xs text-tenue">
            Origen: {ORIGEN_LABEL[a.origen_tipo] ?? a.origen_tipo}{a.usuario ? ` · ${a.usuario}` : ''}
            {a.revierte_numero ? ` · revierte el N° ${a.revierte_numero}` : ''}{a.revertido_por_numero ? ` · revertido por el N° ${a.revertido_por_numero}` : ''}{a.corrige_numero ? ` · corrige el N° ${a.corrige_numero}` : ''}
            {a.motivo ? ` · Motivo: ${a.motivo}` : ''}
          </div>
          {a.advertencia && <div className="mt-1 text-xs text-amber-700">⚠ {a.advertencia}</div>}
        </div>
        {gestiona && manual && (
          <div className="no-print flex flex-wrap gap-1.5">
            {a.estado === 'borrador' && (<>
              <Boton tam="sm" onClick={() => onEditar(a)}>Editar</Boton>
              <Boton tam="sm" variante="primario" cargando={accion.isPending} onClick={() => accion.mutate({ ruta: 'registrar' })}>Registrar</Boton>
              <Boton tam="sm" variante="peligro" onClick={async () => { if (await confirmar('Descartar borrador', 'El borrador se elimina (no tiene efecto contable).', true)) accion.mutate({ ruta: 'descartar' }); }}>Descartar</Boton>
            </>)}
            {a.estado === 'registrado' && !a.revierte_numero && (<>
              <Boton tam="sm" onClick={() => onCorregir(a)}>Corregir</Boton>
              <Boton tam="sm" onClick={() => setMotivo('')}>Revertir</Boton>
            </>)}
          </div>
        )}
      </div>
      <TablaApilable>
        <table className="w-full text-sm">
          <tbody>
            {a.lineas.map((l, i) => (
              <tr key={l.id ?? i} className="border-b border-borde last:border-0">
                <td className="whitespace-nowrap px-4 py-1.5 tabular-nums text-tenue">{l.cuenta_codigo}</td>
                <td className={`px-2 py-1.5 ${l.haber ? 'pl-8' : ''}`}>{l.cuenta_nombre}{l.detalle ? <span className="text-tenue"> · {l.detalle}</span> : null}</td>
                <td className="w-32 whitespace-nowrap px-4 py-1.5 text-right tabular-nums">{imp(l.debe)}</td>
                <td className="w-32 whitespace-nowrap px-4 py-1.5 text-right tabular-nums">{imp(l.haber)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TablaApilable>
      <Modal abierto={motivo !== null} onCerrar={() => setMotivo(null)} titulo={`Revertir el asiento N° ${a.numero}`} ancho="sm"
        pie={<><Boton onClick={() => setMotivo(null)}>Cancelar</Boton><Boton variante="peligro" disabled={(motivo ?? '').trim().length < 3} cargando={accion.isPending} onClick={() => accion.mutate({ ruta: 'revertir', datos: { motivo } })}>Revertir</Boton></>}>
        <p className="mb-3 text-sm text-tenue">Se registra un contra-asiento con los importes invertidos. El original no se modifica y queda marcado como revertido.</p>
        <Campo label="Motivo" requerido><Input autoFocus value={motivo ?? ''} maxLength={300} onChange={(e) => setMotivo(e.target.value)} /></Campo>
      </Modal>
      {dialogo}
    </div>
  );
}

export function LibroDiario({ desde, hasta }: { desde: string; hasta: string }) {
  const { puede } = useAuth();
  const toast = useToast();
  const gestiona = puede('contabilidad.gestionar');
  const [estado, setEstado] = useState('contabilizados');
  const [origen, setOrigen] = useState('');
  const [cuentaId, setCuentaId] = useState('');
  const [q, setQ] = useState('');
  const [pagina, setPagina] = useState(0);
  const [form, setForm] = useState<{ modo: 'nuevo' | 'editar' | 'corregir'; asiento?: Asiento } | null>(null);
  const dq = useDebounce(q);
  const limite = 50;
  const consulta = `desde=${desde}&hasta=${hasta}${qs({ estado, origen, cuenta_id: cuentaId, q: dq, limite, pagina }).replace('?', '&')}`;
  const { data: plan } = useQuery<CuentaPlan[]>({ queryKey: ['contab', 'plan', 'form'], queryFn: () => api.get('/contabilidad/plan') });
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['contab', 'diario', consulta], queryFn: () => api.get(`/contabilidad/diario?${consulta}`) });
  const cambiar = (fn: () => void) => { fn(); setPagina(0); };
  const exportar = () =>
    exportarAutorizado(`/contabilidad/diario?desde=${desde}&hasta=${hasta}${qs({ estado, origen, cuenta_id: cuentaId, q: dq }).replace('?', '&')}`, async () => {
      const todo = await api.get(`/contabilidad/diario?desde=${desde}&hasta=${hasta}${qs({ estado, origen, cuenta_id: cuentaId, q: dq, limite: 500 }).replace('?', '&')}`);
      descargarCSV(`libro-diario-${desde}_${hasta}`, ['N°', 'Fecha', 'Estado', 'Origen', 'Responsable', 'Descripción', 'Cuenta', 'Debe', 'Haber'],
        todo.asientos.flatMap((a: Asiento) => a.lineas.map((l) => [a.numero ?? 'Borrador', fecha(a.fecha), a.estado, ORIGEN_LABEL[a.origen_tipo] ?? a.origen_tipo, a.usuario ?? '', a.descripcion, `${l.cuenta_codigo} ${l.cuenta_nombre}`, l.debe ? pesosCSV(l.debe) : '', l.haber ? pesosCSV(l.haber) : ''])));
      if (todo.total > 500) toast.ok('Se exportaron los primeros 500 asientos: acotá el período para el resto');
    }).catch((e) => toast.error(e));
  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap items-end gap-3">
        <Buscador value={q} onChange={(v) => cambiar(() => setQ(v))} placeholder="Descripción o N° de asiento…" className="min-w-52 flex-1" />
        <Campo label="Estado">
          <Select className="w-auto" value={estado} onChange={(e) => cambiar(() => setEstado(e.target.value))}>
            <option value="contabilizados">Contabilizados</option><option value="registrado">Solo registrados</option><option value="revertido">Solo revertidos</option><option value="borrador">Borradores</option><option value="todos">Todos</option>
          </Select>
        </Campo>
        <Campo label="Origen">
          <Select className="w-auto" value={origen} onChange={(e) => cambiar(() => setOrigen(e.target.value))}>
            <option value="">Todos</option>{Object.entries(ORIGEN_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Campo>
        <Campo label="Cuenta">
          <Select className="w-48" value={cuentaId} onChange={(e) => cambiar(() => setCuentaId(e.target.value))}>
            <option value="">Todas</option>{(plan ?? []).filter((c) => c.imputable).map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.nombre}</option>)}
          </Select>
        </Campo>
        <Boton icono={<Download className="size-4" />} onClick={exportar} disabled={!data?.asientos.length}>CSV</Boton>
        <BotonImprimir />
        {gestiona && <Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => setForm({ modo: 'nuevo' })}>Nuevo asiento</Boton>}
      </div>
      <Periodo desde={desde} hasta={hasta} />
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <>
          <p className="text-sm text-tenue">{data.total} asiento(s) · importe total {money(data.importe_total)}</p>
          {!data.asientos.length ? <Tarjeta><Vacio titulo="Sin asientos en el período" texto="Los asientos se generan solos a partir de las operaciones; también podés cargar uno manual." /></Tarjeta> : (
            <div className="space-y-3">
              {data.asientos.map((a: Asiento) => <TarjetaAsiento key={a.id} a={a} gestiona={gestiona} onEditar={(x) => setForm({ modo: 'editar', asiento: x })} onCorregir={(x) => setForm({ modo: 'corregir', asiento: x })} />)}
            </div>
          )}
          {data.total > limite && (
            <div className="no-print flex items-center justify-center gap-3 text-sm">
              <Boton tam="sm" disabled={pagina === 0} onClick={() => setPagina(pagina - 1)}>Anterior</Boton>
              <span>Página {pagina + 1} de {Math.ceil(data.total / limite)}</span>
              <Boton tam="sm" disabled={(pagina + 1) * limite >= data.total} onClick={() => setPagina(pagina + 1)}>Siguiente</Boton>
            </div>
          )}
        </>
      )}
      {form && <FormAsiento modo={form.modo} inicial={form.asiento} onCerrar={() => setForm(null)} />}
    </div>
  );
}
