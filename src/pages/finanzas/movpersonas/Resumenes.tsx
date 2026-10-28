// Totales por persona y por categoría (calculados en el servidor sobre todos los registros, no sobre una página) y administración de categorías y personas.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Power, Trash2 } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { fecha, money } from '@/lib/format';
import { primerDiaMes } from '@/components/Periodo';
import { SelectorPeriodo } from '@/components/Periodo';
import { hoyISO } from '@/lib/format';
import { Aviso, Boton, Campo, Cargando, ErrorCaja, Input, Insignia, Select, Tabla, Tarjeta, Vacio, useConfirmar, useToast } from '@/components/ui';
import { DEF_TIPOS_FIN, DIRECCION_LABEL, GRUPOS_CATEGORIA, OBLIGACION_LABEL, TIPOS_FIN, TIPO_PERSONA_LABEL, type TipoFin } from '@shared/movpersonas';
import { useCategorias, usePersonas } from './NuevoMovimiento';

const Cifra = ({ t, v, tono = '' }: { t: string; v: number; tono?: string }) => (
  <div className="rounded-card border border-borde bg-white p-3">
    <p className="text-xs font-medium uppercase tracking-wide text-tenue">{t}</p>
    <p className={`text-lg font-bold tabular-nums ${tono}`}>{money(v)}</p>
  </div>
);

export function ResumenPersona() {
  const { data: personas = [] } = usePersonas(true);
  const [personaId, setPersonaId] = useState('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const conMov = personas.filter((p) => p.movimientos > 0);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['movpersonas', 'resumen-persona', personaId, desde, hasta],
    queryFn: () => api.get<any>(`/movimientos-personas/resumen/persona/${encodeURIComponent(personaId)}${qs({ desde, hasta })}`),
    enabled: !!personaId,
  });
  return (
    <div className="space-y-4">
      <Tarjeta>
        <div className="grid gap-3 sm:grid-cols-2">
          <Campo label="Persona"><Select value={personaId} onChange={(e) => setPersonaId(e.target.value)}><option value="">— Elegir —</option>{conMov.map((p) => <option key={p.id} value={p.id}>{p.nombre} · {TIPO_PERSONA_LABEL[p.tipo]}</option>)}</Select></Campo>
        </div>
        <SelectorPeriodo desde={desde} hasta={hasta} onCambio={(d, h) => { setDesde(d); setHasta(h); }} atajos={[{ texto: 'Todo', desde: '', hasta: '' }, { texto: 'Este mes', desde: primerDiaMes(), hasta: hoyISO() }, { texto: 'Mes anterior', desde: primerDiaMes(-1), hasta: primerDiaMes(0) }, { texto: 'Este año', desde: `${new Date().getFullYear()}-01-01`, hasta: hoyISO() }]} />
      </Tarjeta>
      {!personaId ? <Vacio titulo="Elegí una persona" texto="Vas a ver sus aportes, retiros, préstamos, devoluciones y adelantos por separado, y lo que queda pendiente de cada cosa." />
        : isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={() => refetch()} /> : !data.por_moneda.length ? <Vacio titulo="Sin movimientos" texto="Esa persona no tiene movimientos en el período." /> : (
          data.por_moneda.map((m: any) => (
            <div key={m.moneda} className="space-y-4">
              {data.por_moneda.length > 1 && <h3 className="font-semibold">Moneda: {m.moneda}</h3>}
              <Tarjeta titulo="Saldos pendientes a hoy" subtitulo="Cada obligación por separado: no se compensan entre sí.">
                <div className="grid gap-3 sm:grid-cols-3">
                  <Cifra t={OBLIGACION_LABEL.prestamo_recibido} v={m.pendiente_prestamos_recibidos} tono="text-amber-700" />
                  <Cifra t={OBLIGACION_LABEL.prestamo_otorgado} v={m.pendiente_prestamos_otorgados} tono="text-marca-700" />
                  <Cifra t={OBLIGACION_LABEL.adelanto_sueldo} v={m.pendiente_adelantos} tono="text-violet-700" />
                </div>
              </Tarjeta>
              <Tarjeta titulo="Movimientos del período" subtitulo={data.periodo.desde || data.periodo.hasta ? `${data.periodo.desde ? fecha(data.periodo.desde) : 'Inicio'} al ${data.periodo.hasta ? fecha(data.periodo.hasta) : 'hoy'}` : 'Todo el historial'}>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Cifra t="Aportes de capital" v={m.aportes} />
                  <Cifra t="Retiros de capital" v={m.retiros} />
                  <Cifra t="Préstamos que hizo a la empresa" v={m.prestamos_a_la_empresa} />
                  <Cifra t="Devoluciones que recibió" v={m.devoluciones_de_la_empresa} />
                  <Cifra t="Préstamos que recibió de la empresa" v={m.prestamos_de_la_empresa} />
                  <Cifra t="Devoluciones que hizo" v={m.devoluciones_a_la_empresa} />
                  <Cifra t="Adelantos de sueldo recibidos" v={m.adelantos} />
                  <Cifra t="Adelantos aplicados" v={m.adelantos_aplicados} />
                </div>
              </Tarjeta>
            </div>
          ))
        )}
    </div>
  );
}

export function ResumenCategoria() {
  const { data: categorias = [] } = useCategorias();
  const [categoriaId, setCategoriaId] = useState('');
  const [desde, setDesde] = useState(primerDiaMes());
  const [hasta, setHasta] = useState(hoyISO());
  const [orden, setOrden] = useState('importe_desc');
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['movpersonas', 'resumen-categoria', categoriaId, desde, hasta, orden],
    queryFn: () => api.get<any>(`/movimientos-personas/resumen/categoria${qs({ categoria_id: categoriaId, desde, hasta, orden })}`),
  });
  return (
    <div className="space-y-4">
      <Tarjeta>
        <div className="grid gap-3 sm:grid-cols-2">
          <Campo label="Categoría"><Select value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)}><option value="">Todas</option>{categorias.filter((c) => !c.pendiente).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</Select></Campo>
          <Campo label="Ordenar por"><Select value={orden} onChange={(e) => setOrden(e.target.value)}><option value="importe_desc">Mayor importe</option><option value="importe_asc">Menor importe</option><option value="cantidad">Más movimientos</option><option value="nombre">Nombre</option></Select></Campo>
        </div>
        <SelectorPeriodo desde={desde} hasta={hasta} onCambio={(d, h) => { setDesde(d); setHasta(h); }} />
      </Tarjeta>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={() => refetch()} /> : !data.por_moneda.length ? <Vacio titulo="Sin movimientos en el período" /> : (
        data.por_moneda.map((m: any) => (
          <div key={m.moneda} className="space-y-4">
            {categoriaId ? (
              <Tarjeta titulo={`${categorias.find((c) => c.id === categoriaId)?.nombre} · ${m.moneda}`} subtitulo="Total del período, sin movimientos anulados">
                <p className="text-2xl font-bold tabular-nums">{money(m.total)}</p>
                <p className="text-sm text-tenue">{m.cantidad} movimiento(s) de {m.personas.length} persona(s)</p>
              </Tarjeta>
            ) : (
              <p className="text-sm text-tenue">Cada categoría tiene su total: no se suman entre sí porque mezclarían aportes, préstamos y devoluciones. Elegí una categoría para ver el desglose por persona.</p>
            )}
            {categoriaId && <Tarjeta titulo="Desglose por persona" sinPadding>
              <Tabla filas={m.personas} clave={(p: any) => p.persona_id}
                columnas={[
                  { clave: 'p', titulo: 'Persona', render: (p: any) => p.persona, movil: 'titulo' },
                  { clave: 'c', titulo: 'Movimientos', alinear: 'derecha', render: (p: any) => p.cantidad, movil: 'meta' },
                  { clave: 't', titulo: 'Total', alinear: 'derecha', render: (p: any) => <b>{money(p.total)}</b>, movil: 'derecha' },
                ]} />
            </Tarjeta>}
            {!categoriaId && (
              <Tarjeta titulo="Desglose por categoría" sinPadding>
                <Tabla filas={m.categorias} clave={(c: any) => c.categoria_id}
                  columnas={[
                    { clave: 'c', titulo: 'Categoría', render: (c: any) => c.categoria, movil: 'titulo' },
                    { clave: 'd', titulo: 'Dinero', render: (c: any) => DIRECCION_LABEL[c.direccion as keyof typeof DIRECCION_LABEL], movil: 'meta' },
                    { clave: 'n', titulo: 'Movimientos', alinear: 'derecha', render: (c: any) => c.cantidad, movil: 'meta' },
                    { clave: 't', titulo: 'Total', alinear: 'derecha', render: (c: any) => <b>{money(c.total)}</b>, movil: 'derecha' },
                  ]} />
              </Tarjeta>
            )}
          </div>
        ))
      )}
    </div>
  );
}

export function Categorias() {
  const qc = useQueryClient();
  const toast = useToast();
  const { confirmar, dialogo } = useConfirmar();
  const { data: cats = [], isLoading, error, refetch } = useCategorias();
  const { data: personas = [] } = usePersonas(true);
  const [nueva, setNueva] = useState({ nombre: '', tipo_fin: 'aporte_capital' });
  const refrescar = () => qc.invalidateQueries({ queryKey: ['movpersonas'] });
  const crear = useMutation({ mutationFn: () => api.post('/movimientos-personas/categorias', nueva), onSuccess: () => { refrescar(); setNueva({ ...nueva, nombre: '' }); toast.ok('Categoría creada'); }, onError: toast.error });
  const activar = useMutation({ mutationFn: (c: { id: string; activa: boolean }) => api.patch(`/movimientos-personas/categorias/${encodeURIComponent(c.id)}`, { activa: c.activa }), onSuccess: refrescar, onError: toast.error });
  const borrar = useMutation({ mutationFn: (id: string) => api.del(`/movimientos-personas/categorias/${encodeURIComponent(id)}`), onSuccess: () => { refrescar(); toast.ok('Categoría eliminada'); }, onError: toast.error });
  const persona = useMutation({ mutationFn: (p: { id: string; activa: boolean }) => api.patch(`/movimientos-personas/personas/${encodeURIComponent(p.id)}`, { activa: p.activa }), onSuccess: refrescar, onError: toast.error });
  return (
    <div className="space-y-4">
      {dialogo}
      <Aviso>Una categoría propia es un nombre para un <b>tipo financiero</b> que ya existe: el tipo decide si el dinero entra o sale y cómo se asienta en la contabilidad. No se puede inventar un asiento nuevo. Las categorías con movimientos no se eliminan (se desactivan).</Aviso>
      <Tarjeta titulo="Nueva categoría propia">
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Campo label="Nombre"><Input value={nueva.nombre} onChange={(e) => setNueva({ ...nueva, nombre: e.target.value })} maxLength={80} /></Campo>
          <Campo label="Tipo financiero" hint={DEF_TIPOS_FIN[nueva.tipo_fin as TipoFin].asiento}>
            <Select value={nueva.tipo_fin} onChange={(e) => setNueva({ ...nueva, tipo_fin: e.target.value })}>{TIPOS_FIN.map((t) => <option key={t} value={t}>{DEF_TIPOS_FIN[t].etiqueta} · {DIRECCION_LABEL[DEF_TIPOS_FIN[t].direccion]}</option>)}</Select>
          </Campo>
          <Boton variante="primario" icono={<Plus className="size-4" />} disabled={nueva.nombre.trim().length < 3} cargando={crear.isPending} onClick={() => crear.mutate()}>Crear</Boton>
        </div>
      </Tarjeta>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={() => refetch()} /> : (
        <Tarjeta titulo="Categorías" sinPadding>
          {[...GRUPOS_CATEGORIA, 'Categorías propias'].map((g) => {
            const filas = cats.filter((c) => c.grupo === g);
            if (!filas.length) return null;
            return (
              <div key={g}>
                <p className="border-b border-borde-suave bg-superficie-2 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-tenue">{g}</p>
                <Tabla filas={filas} clave={(c) => c.id}
                  columnas={[
                    { clave: 'n', titulo: 'Nombre', render: (c) => <span>{c.nombre}{c.pendiente && <span className="block max-w-xl text-xs text-tenue">Pendiente: {c.pendiente}</span>}</span>, movil: 'titulo' },
                    { clave: 't', titulo: 'Tipo financiero', render: (c) => (c.tipo_fin ? DEF_TIPOS_FIN[c.tipo_fin].etiqueta : '—'), movil: 'subtitulo' },
                    { clave: 'd', titulo: 'Dinero', render: (c) => (c.direccion ? DIRECCION_LABEL[c.direccion as keyof typeof DIRECCION_LABEL] : '—'), movil: 'meta' },
                    { clave: 'e', titulo: 'Estado', render: (c) => (c.pendiente ? <Insignia tono="ambar">Pendiente</Insignia> : c.activa ? <Insignia tono="verde">Activa</Insignia> : <Insignia tono="gris">Inactiva</Insignia>), movil: 'meta' },
                    { clave: 'm', titulo: 'Movimientos', alinear: 'derecha', render: (c) => c.movimientos, movil: 'meta' },
                    {
                      clave: 'a', titulo: '', movil: 'oculta',
                      render: (c) => c.pendiente ? '' : (
                        <span className="flex justify-end gap-1">
                          <Boton tam="sm" icono={<Power className="size-4" />} onClick={() => activar.mutate({ id: c.id, activa: !c.activa })}>{c.activa ? 'Desactivar' : 'Activar'}</Boton>
                          {!c.sistema && c.movimientos === 0 && <Boton tam="sm" variante="peligro" icono={<Trash2 className="size-4" />} onClick={async () => { if (await confirmar('Eliminar categoría', `¿Eliminar «${c.nombre}»? No tiene movimientos.`, true)) borrar.mutate(c.id); }}>Eliminar</Boton>}
                        </span>
                      ),
                    },
                  ]} />
              </div>
            );
          })}
        </Tarjeta>
      )}
      <Tarjeta titulo="Personas" subtitulo="El personal sale del registro de empleados (con o sin acceso al sistema); los socios y otras personas se agregan al registrar un movimiento." sinPadding>
        <Tabla filas={personas} clave={(p) => p.id}
          columnas={[
            { clave: 'n', titulo: 'Nombre', render: (p) => p.nombre, movil: 'titulo' },
            { clave: 't', titulo: 'Relación', render: (p) => TIPO_PERSONA_LABEL[p.tipo], movil: 'subtitulo' },
            { clave: 'x', titulo: 'Acceso al sistema', render: (p) => (p.acceso_erp == null ? 'No usa el sistema' : p.acceso_erp ? 'Con acceso' : 'Sólo fichaje por PIN'), movil: 'meta' },
            { clave: 'm', titulo: 'Movimientos', alinear: 'derecha', render: (p) => p.movimientos, movil: 'meta' },
            { clave: 'e', titulo: 'Estado', render: (p) => (p.activa ? <Insignia tono="verde">Activa</Insignia> : <Insignia tono="gris">Inactiva</Insignia>), movil: 'meta' },
            { clave: 'a', titulo: '', movil: 'oculta', render: (p) => p.nueva ? '' : <span className="flex justify-end"><Boton tam="sm" icono={<Power className="size-4" />} onClick={() => persona.mutate({ id: p.id, activa: !p.activa })}>{p.activa ? 'Desactivar' : 'Activar'}</Boton></span> },
          ]} />
      </Tarjeta>
    </div>
  );
}
