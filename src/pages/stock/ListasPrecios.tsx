// Listas de precios: administración, precios por artículo y actualización masiva de costos y precios.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { Lock, Pencil, Percent, Plus, Tags, Wand2 } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { money } from '@/lib/format';
import { precioPorRegla } from '@shared/precios';
import { REDONDEOS_PRECIO, REDONDEO_PRECIO_LABEL } from '@shared/dominio';
import { Aviso, Boton, Buscador, Campo, Cargando, Check, Encabezado, ErrorCaja, Input, InputMoneda, Insignia, Modal, Pestanas, Select, Tabla, TablaApilable, Tarjeta, useConfirmar, useDebounce, useToast, Vacio } from '@/components/ui';

const descripcionRegla = (l: { base: string; porcentaje: number }) =>
  l.base === 'costo'
    ? `Costo ${l.porcentaje >= 0 ? '+' : '−'} ${Math.abs(l.porcentaje)} % de margen`
    : l.porcentaje === 0 ? 'Precio base' : `Precio base ${l.porcentaje > 0 ? '+' : '−'} ${Math.abs(l.porcentaje)} %`;

function FormLista({ inicial, onCerrar }: { inicial?: any; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({
    nombre: inicial?.nombre ?? '', descripcion: inicial?.descripcion ?? '', base: inicial?.base ?? 'costo', porcentaje: inicial ? String(inicial.porcentaje) : '40',
    redondeo: inicial?.redondeo ?? 100, servicios_pct: inicial?.servicios_pct != null ? String(inicial.servicios_pct) : '', es_default: !!inicial?.es_default, activa: inicial ? !!inicial.activa : true,
  });
  const pct = Number(f.porcentaje.replace(',', '.'));
  const valido = f.nombre.trim().length >= 2 && Number.isFinite(pct) && pct >= -100 && pct <= 1000 && (f.servicios_pct === '' || Number.isFinite(Number(f.servicios_pct.replace(',', '.'))));
  const ejemplo = valido ? precioPorRegla({ base: f.base, porcentaje: pct, redondeo: f.redondeo }, { costo: 1000000, precio: 1500000 }) : 0;
  const m = useMutation({
    mutationFn: () => {
      const datos = {
        nombre: f.nombre, descripcion: f.descripcion || null, base: f.base, porcentaje: pct, redondeo: Number(f.redondeo),
        servicios_pct: f.servicios_pct === '' ? null : Number(f.servicios_pct.replace(',', '.')), es_default: f.es_default, activa: f.activa,
      };
      return inicial ? api.put(`/listas-precios/${inicial.id}`, datos) : api.post('/listas-precios', datos);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['listas-precios'] });
      qc.invalidateQueries({ queryKey: ['articulos'] });
      toast.ok('Lista guardada');
      onCerrar();
    },
    onError: toast.error,
  });
  return (
    <Modal abierto onCerrar={onCerrar} titulo={inicial ? 'Editar lista de precios' : 'Nueva lista de precios'} ancho="lg" pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" disabled={!valido} cargando={m.isPending} onClick={() => m.mutate()}>Guardar</Boton></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Campo label="Nombre" requerido><Input value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} placeholder="Ej.: Mayorista, Tarjeta, Flota" autoFocus /></Campo>
        <Campo label="Descripción"><Input value={f.descripcion} onChange={(e) => setF({ ...f, descripcion: e.target.value })} /></Campo>
        <Campo label="Cómo se calcula el precio">
          <Select value={f.base} onChange={(e) => setF({ ...f, base: e.target.value })}>
            <option value="costo">Margen sobre el costo del artículo</option>
            <option value="precio">Recargo o descuento sobre el precio base</option>
          </Select>
        </Campo>
        <Campo label={f.base === 'costo' ? 'Margen (%)' : 'Recargo (+) o descuento (−) (%)'} hint={f.base === 'costo' ? 'Al cambiar el costo (p. ej. por una compra) los precios se actualizan solos' : 'Sigue los cambios del precio base de cada artículo'}>
          <Input inputMode="decimal" value={f.porcentaje} onChange={(e) => setF({ ...f, porcentaje: e.target.value.replace(/[^\d.,-]/g, '') })} />
        </Campo>
        <Campo label="Redondeo del precio">
          <Select value={f.redondeo} onChange={(e) => setF({ ...f, redondeo: Number(e.target.value) })}>{REDONDEOS_PRECIO.map((r) => <option key={r} value={r}>{REDONDEO_PRECIO_LABEL[r]}</option>)}</Select>
        </Campo>
        <Campo label="Servicios / mano de obra (%)" hint="Opcional. Vacío = los servicios mantienen su precio base"><Input inputMode="decimal" value={f.servicios_pct} onChange={(e) => setF({ ...f, servicios_pct: e.target.value.replace(/[^\d.,-]/g, '') })} /></Campo>
        <div className="flex flex-col justify-end gap-2 sm:col-span-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-4">
            <Check checked={f.es_default} onChange={(v) => setF({ ...f, es_default: v })} label="Predeterminada en presupuestos y ventas" />
            {inicial && <Check checked={f.activa} onChange={(v) => setF({ ...f, activa: v })} label="Activa" />}
          </div>
          {valido && <div className="rounded-ctl bg-slate-50 px-3 py-2 text-sm">Ejemplo: {f.base === 'costo' ? 'costo $10.000' : 'precio base $15.000'} → <strong>{money(ejemplo)}</strong></div>}
        </div>
      </div>
    </Modal>
  );
}

function AjusteMasivoArticulos() {
  const qc = useQueryClient();
  const toast = useToast();
  const { confirmar, dialogo } = useConfirmar();
  const { data: cats = [] } = useQuery({ queryKey: ['categorias-articulo'], queryFn: () => api.get<any[]>('/categorias-articulo') });
  const { data: provs = [] } = useQuery({ queryKey: ['proveedores'], queryFn: () => api.get<any[]>('/proveedores') });
  const [f, setF] = useState({ aplicar_a: 'costo', modo: 'porcentaje', valor: '10', categoria_id: '', proveedor_id: '', redondeo: 100 });
  const [sim, setSim] = useState<any | null>(null);
  const valor = Number(f.valor.replace(',', '.'));
  const valido = Number.isFinite(valor) && valor >= -90 && valor <= 1000 && f.valor !== '' && f.valor !== '-';
  const datos = (simular: boolean) => ({ aplicar_a: f.aplicar_a, modo: f.modo, valor, categoria_id: f.categoria_id || null, proveedor_id: f.proveedor_id || null, redondeo: Number(f.redondeo), simular });
  const simular = useMutation({ mutationFn: () => api.post('/articulos/ajuste-masivo', datos(true)), onSuccess: setSim, onError: toast.error });
  const aplicar = useMutation({
    mutationFn: () => api.post('/articulos/ajuste-masivo', datos(false)),
    onSuccess: (r) => {
      ['articulos', 'listas-precios'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.ok(`${r.afectados} artículo(s) actualizados`);
      setSim(null);
    },
    onError: toast.error,
  });
  const cambiar = (c: Partial<typeof f>) => {
    setF({ ...f, ...c });
    setSim(null);
  };
  return (
    <>
      {dialogo}
      <Tarjeta titulo="Actualización masiva de artículos" subtitulo="Cuando suben los costos o querés remarcar: un solo paso en lugar de editar artículo por artículo">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Campo label="Qué actualizar">
            <Select value={f.aplicar_a} onChange={(e) => cambiar({ aplicar_a: e.target.value, modo: e.target.value === 'costo' ? 'porcentaje' : f.modo })}>
              <option value="costo">Costo (aumento del proveedor)</option>
              <option value="precio">Precio de venta base</option>
            </Select>
          </Campo>
          {f.aplicar_a === 'precio' && (
            <Campo label="Método">
              <Select value={f.modo} onChange={(e) => cambiar({ modo: e.target.value })}>
                <option value="porcentaje">Aumentar / bajar un porcentaje</option>
                <option value="margen_sobre_costo">Recalcular como margen sobre el costo</option>
              </Select>
            </Campo>
          )}
          <Campo label={f.modo === 'margen_sobre_costo' ? 'Margen sobre el costo (%)' : 'Variación (%)'} hint={f.modo === 'porcentaje' ? 'Negativo para bajar' : 'Sólo artículos con costo cargado'}>
            <Input inputMode="decimal" value={f.valor} onChange={(e) => cambiar({ valor: e.target.value.replace(/[^\d.,-]/g, '') })} />
          </Campo>
          <Campo label="Categoría"><Select value={f.categoria_id} onChange={(e) => cambiar({ categoria_id: e.target.value })}><option value="">Todas</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</Select></Campo>
          <Campo label="Proveedor"><Select value={f.proveedor_id} onChange={(e) => cambiar({ proveedor_id: e.target.value })}><option value="">Todos</option>{provs.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</Select></Campo>
          <Campo label="Redondeo"><Select value={f.redondeo} onChange={(e) => cambiar({ redondeo: Number(e.target.value) })}>{REDONDEOS_PRECIO.map((r) => <option key={r} value={r}>{REDONDEO_PRECIO_LABEL[r]}</option>)}</Select></Campo>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Boton icono={<Wand2 className="size-4" />} disabled={!valido} cargando={simular.isPending} onClick={() => simular.mutate()}>Simular (sin guardar)</Boton>
        </div>
        {sim && (
          <div className="mt-4 space-y-3">
            <Aviso tono={sim.afectados ? 'azul' : 'ambar'}>{sim.afectados ? <>Se modificarán <strong>{sim.afectados}</strong> artículo(s). Vista previa de los primeros:</> : 'Ningún artículo coincide con el filtro.'}</Aviso>
            {sim.muestra.length > 0 && (
              <TablaApilable><table className="w-full text-sm">
                <thead><tr className="border-b border-borde text-left text-xs font-semibold uppercase tracking-wide text-tenue"><th className="py-2">Artículo</th><th className="py-2 text-right">Antes</th><th className="py-2 text-right">Después</th></tr></thead>
                <tbody>{sim.muestra.map((a: any) => <tr key={a.id} className="border-b border-borde last:border-0"><td className="py-2">{a.nombre}</td><td className="py-2 text-right tabular-nums">{money(a.antes)}</td><td className="py-2 text-right font-medium tabular-nums">{money(a.despues)}</td></tr>)}</tbody>
              </table></TablaApilable>
            )}
            {sim.afectados > 0 && (
              <Boton variante="primario" cargando={aplicar.isPending} onClick={async () => { if (await confirmar('Aplicar actualización masiva', `Se modificará el ${f.aplicar_a === 'costo' ? 'costo' : 'precio de venta'} de ${sim.afectados} artículo(s). Los presupuestos, OT y comprobantes ya emitidos no cambian.`)) aplicar.mutate(); }}>
                Aplicar a {sim.afectados} artículo(s)
              </Boton>
            )}
          </div>
        )}
      </Tarjeta>
    </>
  );
}

export function ListasPrecios() {
  const nav = useNavigate();
  const [tab, setTab] = useState<'listas' | 'masivo'>('listas');
  const [form, setForm] = useState<null | 'nueva' | any>(null);
  const [todas, setTodas] = useState(false);
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['listas-precios', { todas }], queryFn: () => api.get<any[]>(`/listas-precios${qs({ todas })}`) });
  return (
    <>
      <Encabezado
        titulo="Listas de precios"
        subtitulo="Precios alternativos por tipo de cliente o forma de pago, calculados sobre el costo o el precio base"
        acciones={<Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => setForm('nueva')}>Nueva lista</Boton>}
      />
      <Pestanas items={[{ clave: 'listas', titulo: 'Listas' }, { clave: 'masivo', titulo: 'Actualización masiva' }]} activo={tab} onCambio={setTab} />
      {tab === 'masivo' ? <AjusteMasivoArticulos /> : (
        <>
          <Aviso className="mb-4">Las listas sólo sugieren precios al armar presupuestos, órdenes y ventas. Cada documento <strong>conserva el precio con el que se emitió</strong> aunque después cambie la lista o el costo.</Aviso>
          <div className="mb-3"><Check checked={todas} onChange={setTodas} label="Mostrar también las desactivadas" /></div>
          {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
            <Tarjeta sinPadding>
              <Tabla
                filas={data}
                clave={(l) => l.id}
                onFila={(l) => nav(`/listas-precios/${l.id}`)}
                vacio={<Vacio icono={<Tags className="size-5" />} titulo="Todavía no hay listas de precios" texto="Creá, por ejemplo, una lista mayorista (costo + 25 %) y una de tarjeta (precio base + 15 %)." accion={<Boton variante="primario" onClick={() => setForm('nueva')}>Crear la primera lista</Boton>} />}
                columnas={[
                  { clave: 'n', titulo: 'Lista', render: (l) => <span className="flex flex-wrap items-center gap-2 font-medium">{l.nombre}{l.es_default ? <Insignia tono="azul">Predeterminada</Insignia> : null}{!l.activa ? <Insignia tono="gris">Desactivada</Insignia> : null}</span>, movil: 'titulo' },
                  { clave: 'r', titulo: 'Regla', render: (l) => descripcionRegla(l), movil: 'subtitulo' },
                  { clave: 'rd', titulo: 'Redondeo', render: (l) => REDONDEO_PRECIO_LABEL[l.redondeo], movil: 'meta' },
                  { clave: 's', titulo: 'Servicios', render: (l) => (l.servicios_pct == null ? 'Precio base' : `${l.servicios_pct > 0 ? '+' : ''}${l.servicios_pct} %`), movil: 'meta' },
                  { clave: 'f', titulo: 'Precios fijos', alinear: 'derecha', render: (l) => l.precios_fijos, movil: 'derecha' },
                  { clave: 'e', titulo: '', render: (l) => <Boton tam="sm" variante="fantasma" icono={<Pencil className="size-4" />} onClick={(e) => { e.stopPropagation(); setForm(l); }} aria-label="Editar lista" />, movil: 'meta' },
                ]}
              />
            </Tarjeta>
          )}
        </>
      )}
      {form && <FormLista inicial={form === 'nueva' ? undefined : form} onCerrar={() => setForm(null)} />}
    </>
  );
}

// ───────────── Detalle de una lista ─────────────
function ModalPrecioFijo({ lista, articulo, onCerrar }: { lista: any; articulo: any; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [precio, setPrecio] = useState<number>(articulo.precio_lista);
  const refrescar = () => {
    qc.invalidateQueries({ queryKey: ['listas-precios'] });
    onCerrar();
  };
  const guardar = useMutation({ mutationFn: () => api.put(`/listas-precios/${lista.id}/items/${articulo.id}`, { precio }), onSuccess: () => { toast.ok('Precio fijo guardado'); refrescar(); }, onError: toast.error });
  const quitar = useMutation({ mutationFn: () => api.del(`/listas-precios/${lista.id}/items/${articulo.id}`), onSuccess: () => { toast.ok('Vuelve al precio calculado'); refrescar(); }, onError: toast.error });
  return (
    <Modal abierto onCerrar={onCerrar} titulo={articulo.nombre} ancho="sm" pie={<>{articulo.precio_origen === 'fijo' && <Boton cargando={quitar.isPending} onClick={() => quitar.mutate()}>Volver al calculado</Boton>}<Boton variante="primario" cargando={guardar.isPending} onClick={() => guardar.mutate()}>Guardar precio fijo</Boton></>}>
      <div className="space-y-3 text-sm">
        <p className="text-tenue">Costo {money(articulo.costo)} · precio base {money(articulo.precio)}</p>
        <Campo label={`Precio en “${lista.nombre}”`}><InputMoneda value={precio} onChange={setPrecio} autoFocus /></Campo>
        <p className="text-xs text-tenue">Un precio fijo no se mueve con el costo ni con los cambios de la lista.</p>
      </div>
    </Modal>
  );
}

export function ListaPreciosDetalle() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { confirmar, dialogo } = useConfirmar();
  const [q, setQ] = useState('');
  const [categoria, setCategoria] = useState('');
  const [soloFijos, setSoloFijos] = useState(false);
  const [pagina, setPagina] = useState(0);
  const [editar, setEditar] = useState<any | null>(null);
  const [modal, setModal] = useState<null | 'fijar' | 'ajuste' | 'editar'>(null);
  const dq = useDebounce(q);
  const { data: lista, isLoading, error, refetch } = useQuery({ queryKey: ['listas-precios', 'detalle', id], queryFn: () => api.get(`/listas-precios/${id}`) });
  const { data: cats = [] } = useQuery({ queryKey: ['categorias-articulo'], queryFn: () => api.get<any[]>('/categorias-articulo') });
  const { data: filas = [], isLoading: cargando } = useQuery({
    queryKey: ['listas-precios', 'articulos', id, { dq, categoria, soloFijos, pagina }],
    queryFn: () => api.get<any[]>(`/listas-precios/${id}/articulos${qs({ q: dq, categoria_id: categoria, solo_fijos: soloFijos, pagina: pagina || undefined })}`),
    enabled: !!lista,
  });
  const [ajuste, setAjuste] = useState({ porcentaje: '10', redondeo: 100, categoria_id: '' });
  const [sim, setSim] = useState<number | null>(null);
  const [fijarCat, setFijarCat] = useState('');
  const [sobrescribir, setSobrescribir] = useState(false);
  const refrescar = () => ['listas-precios', 'articulos'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const simular = useMutation({ mutationFn: () => api.post(`/listas-precios/${id}/ajuste-masivo`, { porcentaje: Number(ajuste.porcentaje.replace(',', '.')), redondeo: Number(ajuste.redondeo), categoria_id: ajuste.categoria_id || null, simular: true }), onSuccess: (r) => setSim(r.afectados), onError: toast.error });
  const aplicar = useMutation({ mutationFn: () => api.post(`/listas-precios/${id}/ajuste-masivo`, { porcentaje: Number(ajuste.porcentaje.replace(',', '.')), redondeo: Number(ajuste.redondeo), categoria_id: ajuste.categoria_id || null }), onSuccess: (r) => { refrescar(); toast.ok(`${r.afectados} precio(s) fijo(s) ajustados`); setModal(null); setSim(null); }, onError: toast.error });
  const fijar = useMutation({ mutationFn: () => api.post(`/listas-precios/${id}/fijar`, { categoria_id: fijarCat || null, sobrescribir }), onSuccess: (r) => { refrescar(); toast.ok(`${r.afectados} precio(s) fijado(s)`); setModal(null); }, onError: toast.error });
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  return (
    <>
      {dialogo}
      <Encabezado
        volver="/listas-precios"
        titulo={<span className="flex flex-wrap items-center gap-2">{lista.nombre}{lista.es_default ? <Insignia tono="azul">Predeterminada</Insignia> : null}{!lista.activa ? <Insignia tono="gris">Desactivada</Insignia> : null}</span>}
        subtitulo={`${descripcionRegla(lista)} · ${REDONDEO_PRECIO_LABEL[lista.redondeo]}${lista.servicios_pct != null ? ` · servicios ${lista.servicios_pct > 0 ? '+' : ''}${lista.servicios_pct} %` : ''}`}
        acciones={
          <>
            <Boton icono={<Lock className="size-4" />} onClick={() => setModal('fijar')}>Fijar precios calculados</Boton>
            <Boton icono={<Percent className="size-4" />} onClick={() => { setSim(null); setModal('ajuste'); }}>Ajustar precios fijos</Boton>
            <Boton variante="primario" icono={<Pencil className="size-4" />} onClick={() => setModal('editar')}>Editar regla</Boton>
          </>
        }
      />
      <div className="filtros mb-4 flex flex-wrap items-center gap-3">
        <Buscador value={q} onChange={(v) => { setQ(v); setPagina(0); }} placeholder="Buscar artículo, código o marca" className="min-w-52 flex-1" />
        <Select value={categoria} onChange={(e) => { setCategoria(e.target.value); setPagina(0); }} className="w-auto" aria-label="Categoría"><option value="">Todas las categorías</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</Select>
        <Check checked={soloFijos} onChange={(v) => { setSoloFijos(v); setPagina(0); }} label="Sólo precios fijos" />
      </div>
      {cargando ? <Cargando /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={filas}
            clave={(a) => a.id}
            onFila={setEditar}
            vacio={<Vacio icono={<Tags className="size-5" />} titulo="Sin artículos" texto="Ajustá los filtros o cargá artículos en el catálogo." />}
            columnas={[
              { clave: 'a', titulo: 'Artículo', render: (a) => <span><span className="font-medium">{a.nombre}</span>{a.codigo ? <span className="ml-2 text-xs text-tenue">{a.codigo}</span> : null}</span>, movil: 'titulo' },
              { clave: 'k', titulo: 'Categoría', render: (a) => a.categoria ?? '—', movil: 'oculta' },
              { clave: 'c', titulo: 'Costo', alinear: 'derecha', render: (a) => money(a.costo), movil: 'meta' },
              { clave: 'b', titulo: 'Precio base', alinear: 'derecha', render: (a) => money(a.precio), movil: 'meta' },
              { clave: 'o', titulo: 'Origen', render: (a) => (a.precio_origen === 'fijo' ? <Insignia tono="ambar">Fijo</Insignia> : <Insignia tono="gris">Calculado</Insignia>), movil: 'meta' },
              { clave: 'p', titulo: 'En esta lista', alinear: 'derecha', render: (a) => <span className="font-semibold">{money(a.precio_lista)}</span>, movil: 'derecha' },
            ]}
          />
          <div className="flex items-center justify-between border-t border-borde px-4 py-2 text-sm">
            <Boton tam="sm" disabled={pagina === 0} onClick={() => setPagina(pagina - 1)}>Anterior</Boton>
            <span className="text-tenue">Página {pagina + 1}</span>
            <Boton tam="sm" disabled={filas.length < 100} onClick={() => setPagina(pagina + 1)}>Siguiente</Boton>
          </div>
        </Tarjeta>
      )}
      {editar && <ModalPrecioFijo lista={lista} articulo={editar} onCerrar={() => setEditar(null)} />}
      {modal === 'editar' && <FormLista inicial={lista} onCerrar={() => { setModal(null); refetch(); refrescar(); }} />}
      <Modal abierto={modal === 'fijar'} onCerrar={() => setModal(null)} titulo="Fijar precios calculados" ancho="sm" pie={<><Boton onClick={() => setModal(null)}>Cancelar</Boton><Boton variante="primario" cargando={fijar.isPending} onClick={async () => { if (await confirmar('Fijar precios', 'Los precios dejarán de seguir al costo: quedarán como precios fijos de esta lista.')) fijar.mutate(); }}>Fijar</Boton></>}>
        <div className="space-y-3">
          <p className="text-sm text-tenue">Convierte el precio que hoy calcula la regla en un precio fijo editable artículo por artículo.</p>
          <Campo label="Categoría"><Select value={fijarCat} onChange={(e) => setFijarCat(e.target.value)}><option value="">Todas</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</Select></Campo>
          <Check checked={sobrescribir} onChange={setSobrescribir} label="Reemplazar también los precios fijos existentes" />
        </div>
      </Modal>
      <Modal abierto={modal === 'ajuste'} onCerrar={() => setModal(null)} titulo="Ajustar precios fijos" ancho="sm" pie={<><Boton onClick={() => setModal(null)}>Cancelar</Boton><Boton icono={<Wand2 className="size-4" />} cargando={simular.isPending} onClick={() => simular.mutate()}>Simular</Boton><Boton variante="primario" disabled={!sim} cargando={aplicar.isPending} onClick={() => aplicar.mutate()}>Aplicar</Boton></>}>
        <div className="space-y-3">
          <p className="text-sm text-tenue">Aumenta o baja en un porcentaje los precios <strong>fijos</strong> de esta lista. Los calculados siguen a la regla.</p>
          <Campo label="Variación (%)"><Input inputMode="decimal" value={ajuste.porcentaje} onChange={(e) => { setAjuste({ ...ajuste, porcentaje: e.target.value.replace(/[^\d.,-]/g, '') }); setSim(null); }} /></Campo>
          <Campo label="Categoría"><Select value={ajuste.categoria_id} onChange={(e) => { setAjuste({ ...ajuste, categoria_id: e.target.value }); setSim(null); }}><option value="">Todas</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</Select></Campo>
          <Campo label="Redondeo"><Select value={ajuste.redondeo} onChange={(e) => { setAjuste({ ...ajuste, redondeo: Number(e.target.value) }); setSim(null); }}>{REDONDEOS_PRECIO.map((r) => <option key={r} value={r}>{REDONDEO_PRECIO_LABEL[r]}</option>)}</Select></Campo>
          {sim != null && <Aviso tono={sim ? 'azul' : 'ambar'}>{sim ? `Se ajustarán ${sim} precio(s) fijo(s).` : 'No hay precios fijos que coincidan.'}</Aviso>}
        </div>
      </Modal>
    </>
  );
}
