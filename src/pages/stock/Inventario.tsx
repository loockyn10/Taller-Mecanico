// Inventario avanzado: valorización por categoría y conteo físico con diferencias y ajuste auditado.
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Ban, ClipboardCheck, Download, Plus, Printer, Save } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { descargarCSV, pesosCSV } from '@/lib/csv';
import { cantidad, fecha, money, numero } from '@/lib/format';
import { SelectorDeposito } from '@/components/SelectorDeposito';
import { Aviso, Boton, Buscador, Campo, Cargando, Check, Encabezado, ErrorCaja, Indicador, Input, Insignia, Modal, Pestanas, Select, Tabla, Tarjeta, useConfirmar, useDebounce, useToast, Vacio } from '@/components/ui';

const coma = (n: number) => String(n).replace('.', ',');

// ───────────── Valorización ─────────────
function Valorizado() {
  const [cat, setCat] = useState('');
  const [prov, setProv] = useState('');
  const [q, setQ] = useState('');
  const [conStock, setConStock] = useState(true);
  const dq = useDebounce(q);
  const { data: cats = [] } = useQuery({ queryKey: ['categorias-articulo'], queryFn: () => api.get<any[]>('/categorias-articulo') });
  const { data: provs = [] } = useQuery({ queryKey: ['proveedores'], queryFn: () => api.get<any[]>('/proveedores') });
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['inventario', 'valorizado', { cat, prov, dq, conStock }], queryFn: () => api.get(`/inventario/valorizado${qs({ categoria_id: cat, proveedor_id: prov, q: dq, con_stock: conStock ? 1 : undefined })}`) });
  const exportar = () => data && descargarCSV('inventario-valorizado', ['Código', 'Artículo', 'Categoría', 'Proveedor', 'Stock', 'Unidad', 'Costo unitario', 'Valor a costo', 'Precio unitario', 'Valor a precio'], data.items.map((i: any) => [i.codigo ?? '', i.nombre, i.categoria, i.proveedor ?? '', coma(i.stock), i.unidad, pesosCSV(i.costo), pesosCSV(i.valor_costo), pesosCSV(i.precio), pesosCSV(i.valor_venta)]));
  return (
    <>
      <div className="filtros mb-4 flex flex-wrap items-end gap-3 no-print">
        <Buscador value={q} onChange={setQ} placeholder="Artículo o código…" className="min-w-52 flex-1" />
        <Campo label="Categoría"><Select value={cat} onChange={(e) => setCat(e.target.value)} className="w-auto"><option value="">Todas</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}<option value="sin">Sin categoría</option></Select></Campo>
        <Campo label="Proveedor"><Select value={prov} onChange={(e) => setProv(e.target.value)} className="w-auto"><option value="">Todos</option>{provs.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</Select></Campo>
        <Check checked={conStock} onChange={setConStock} label="Sólo con stock" />
        <Boton icono={<Download className="size-4" />} onClick={exportar} disabled={!data?.items.length}>CSV</Boton>
        <Boton icono={<Printer className="size-4" />} onClick={() => window.print()}>Imprimir</Boton>
      </div>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : data && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Indicador titulo="Valor a costo" valor={money(data.totales.valor_costo)} detalle={`${data.totales.articulos} artículo(s)`} tono="azul" />
            <Indicador titulo="Valor a precio de venta" valor={money(data.totales.valor_venta)} tono="verde" />
            <Indicador titulo="Margen potencial" valor={money(data.totales.margen_potencial)} detalle={data.totales.valor_venta ? `${Math.round((data.totales.margen_potencial / data.totales.valor_venta) * 100)}% del valor de venta` : undefined} tono="cian" />
            <Indicador titulo="A revisar" valor={String(data.totales.sin_costo + data.totales.stock_negativo)} detalle={`${data.totales.sin_costo} sin costo · ${data.totales.stock_negativo} con stock negativo`} tono={data.totales.sin_costo + data.totales.stock_negativo ? 'ambar' : 'verde'} />
          </div>
          <Tarjeta titulo="Por categoría" sinPadding>
            <Tabla
              filas={data.por_categoria}
              clave={(c: any) => c.categoria}
              vacio={<p className="px-4 py-6 text-center text-sm text-tenue">Sin artículos</p>}
              columnas={[
                { clave: 'c', titulo: 'Categoría', render: (c: any) => <span className="font-medium">{c.categoria}</span>, movil: 'titulo' },
                { clave: 'a', titulo: 'Artículos', alinear: 'derecha', render: (c: any) => c.articulos, movil: 'meta' },
                { clave: 'u', titulo: 'Unidades', alinear: 'derecha', render: (c: any) => cantidad(c.unidades), movil: 'meta' },
                { clave: 'k', titulo: 'Valor a costo', alinear: 'derecha', render: (c: any) => money(c.valor_costo), movil: 'derecha' },
                { clave: 'v', titulo: 'Valor a precio', alinear: 'derecha', render: (c: any) => money(c.valor_venta), movil: 'meta' },
              ]}
            />
          </Tarjeta>
          <Tarjeta titulo="Detalle" sinPadding>
            <Tabla
              filas={data.items}
              clave={(i: any) => i.id}
              columnas={[
                { clave: 'n', titulo: 'Artículo', render: (i: any) => <span><span className="font-medium">{i.nombre}</span> <span className="text-tenue">{i.codigo ?? ''}</span></span>, movil: 'titulo' },
                { clave: 'c', titulo: 'Categoría', render: (i: any) => i.categoria, movil: 'subtitulo' },
                { clave: 's', titulo: 'Stock', alinear: 'derecha', render: (i: any) => <span className={i.stock < 0 ? 'text-red-600' : ''}>{cantidad(i.stock)} {i.unidad}</span>, movil: 'meta' },
                { clave: 'k', titulo: 'Costo unit.', alinear: 'derecha', render: (i: any) => (i.costo ? money(i.costo) : <span className="text-amber-700">Sin costo</span>), movil: 'meta' },
                { clave: 'vk', titulo: 'Valor a costo', alinear: 'derecha', render: (i: any) => money(i.valor_costo), movil: 'derecha' },
                { clave: 'vv', titulo: 'Valor a precio', alinear: 'derecha', render: (i: any) => money(i.valor_venta), movil: 'meta' },
              ]}
            />
          </Tarjeta>
        </div>
      )}
    </>
  );
}

// ───────────── Conteo físico ─────────────
function ConteoDetalle({ id, onVolver }: { id: string; onVolver: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useAuth();
  const { confirmar, dialogo } = useConfirmar();
  const [q, setQ] = useState('');
  const [soloDif, setSoloDif] = useState(false);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const { data: c, isLoading, error, refetch } = useQuery({ queryKey: ['inventario', 'conteo', id], queryFn: () => api.get(`/inventario/conteos/${id}`) });
  const refrescar = () => ['inventario', 'articulos', 'articulo', 'movimientos', 'reposicion', 'dashboard'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const guardar = useMutation({
    mutationFn: () => api.put(`/inventario/conteos/${id}/items`, { items: Object.entries(edit).slice(0, 300).map(([articulo_id, v]) => ({ articulo_id, contado: v.trim() === '' ? null : Number(v.replace(',', '.')) })) }),
    onSuccess: () => { setEdit({}); refrescar(); toast.ok('Conteo guardado'); },
    onError: toast.error,
  });
  const aplicar = useMutation({
    mutationFn: () => api.post(`/inventario/conteos/${id}/aplicar`, {}),
    onSuccess: (r: any) => { refrescar(); toast.ok(`Conteo aplicado: ${r.ajustes} ajuste(s) de stock`); },
    onError: toast.error,
  });
  const cancelar = useMutation({ mutationFn: () => api.post(`/inventario/conteos/${id}/cancelar`, {}), onSuccess: () => { refrescar(); toast.ok('Conteo cancelado'); onVolver(); }, onError: toast.error });
  const filas = useMemo(() => (c?.items ?? []).filter((i: any) => (!q || `${i.nombre} ${i.codigo ?? ''}`.toLowerCase().includes(q.toLowerCase())) && (!soloDif || (i.diferencia != null && i.diferencia !== 0))), [c, q, soloDif]);
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  const abierto = c.estado === 'abierto';
  const pendientesDeGuardar = Object.keys(edit).length;
  const valorDe = (i: any) => {
    const raw = edit[i.articulo_id];
    if (raw === undefined) return i.contado;
    return raw.trim() === '' || Number.isNaN(Number(raw.replace(',', '.'))) ? null : Number(raw.replace(',', '.'));
  };
  const confirmarAplicar = async () => {
    if (pendientesDeGuardar) await guardar.mutateAsync();
    if (await confirmar('Aplicar el conteo', `Se van a ajustar ${c.con_diferencia} artículo(s) según las diferencias contadas (valor ${money(c.valor_diferencia_total)}). Los movimientos quedan registrados con el motivo “conteo físico”. No se puede deshacer; sí se puede corregir con otro ajuste.`)) aplicar.mutate();
  };
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">Conteo #{numero(c.numero)} <Insignia tono={abierto ? 'azul' : c.estado === 'aplicado' ? 'verde' : 'gris'}>{abierto ? 'Abierto' : c.estado === 'aplicado' ? 'Aplicado' : 'Cancelado'}</Insignia></h2>
          <p className="text-sm text-tenue">{fecha(c.fecha)} · {c.categoria ?? 'Todo el inventario'}{c.descripcion ? ` · ${c.descripcion}` : ''} · {c.contados}/{c.articulos} contados</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Boton onClick={onVolver}>Volver</Boton>
          <Boton icono={<Download className="size-4" />} onClick={() => descargarCSV(`conteo-${c.numero}`, ['Código', 'Artículo', 'Stock sistema', 'Contado', 'Diferencia', 'Costo', 'Valor diferencia'], c.items.map((i: any) => [i.codigo ?? '', i.nombre, coma(i.stock_sistema), i.contado == null ? '' : coma(i.contado), i.diferencia == null ? '' : coma(i.diferencia), pesosCSV(i.costo), i.valor_diferencia == null ? '' : pesosCSV(i.valor_diferencia)]))}>CSV</Boton>
          {abierto && puede('stock.ajustar') && (
            <>
              <Boton icono={<Save className="size-4" />} disabled={!pendientesDeGuardar} cargando={guardar.isPending} onClick={() => guardar.mutate()}>Guardar{pendientesDeGuardar ? ` (${pendientesDeGuardar})` : ''}</Boton>
              <Boton variante="peligro" icono={<Ban className="size-4" />} onClick={async () => { if (await confirmar('Cancelar el conteo', 'Se descarta lo contado. El stock no se modifica.', true)) cancelar.mutate(); }}>Cancelar conteo</Boton>
              <Boton variante="primario" icono={<ClipboardCheck className="size-4" />} disabled={c.contados === 0} cargando={aplicar.isPending} onClick={confirmarAplicar}>Aplicar diferencias</Boton>
            </>
          )}
        </div>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Indicador titulo="Artículos contados" valor={`${c.contados} / ${c.articulos}`} tono="azul" />
        <Indicador titulo="Con diferencia" valor={String(c.con_diferencia)} tono={c.con_diferencia ? 'ambar' : 'verde'} />
        <Indicador titulo="Valor de la diferencia" valor={money(c.valor_diferencia_total)} detalle="A costo" tono={c.valor_diferencia_total < 0 ? 'rojo' : 'verde'} />
      </div>
      {abierto && <Aviso className="mb-4">El stock del sistema es una foto tomada al iniciar el conteo. Al aplicar se ajusta sólo la diferencia contada, así que lo vendido o comprado mientras contabas se conserva. Los artículos sin contar no se tocan.</Aviso>}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Buscador value={q} onChange={setQ} placeholder="Buscar artículo…" className="min-w-52 flex-1" />
        <Check checked={soloDif} onChange={setSoloDif} label="Sólo con diferencia" />
      </div>
      <Tarjeta sinPadding>
        <Tabla
          filas={filas}
          clave={(i: any) => i.articulo_id}
          vacio={<Vacio titulo="Sin artículos con ese filtro" />}
          columnas={[
            { clave: 'n', titulo: 'Artículo', render: (i: any) => <span><span className="font-medium">{i.nombre}</span> <span className="text-tenue">{i.codigo ?? ''}</span></span>, movil: 'titulo' },
            { clave: 's', titulo: 'Sistema', alinear: 'derecha', render: (i: any) => <>{cantidad(i.stock_sistema)} {i.unidad}{i.stock_actual !== i.stock_sistema && abierto ? <span className="block text-xs text-amber-700">hoy {cantidad(i.stock_actual)}</span> : null}</>, movil: 'meta' },
            {
              clave: 'c', titulo: 'Contado', alinear: 'derecha',
              render: (i: any) => abierto && puede('stock.ajustar')
                ? <Input type="text" inputMode="decimal" className="h-9 w-24 text-right" value={edit[i.articulo_id] ?? (i.contado == null ? '' : String(i.contado).replace('.', ','))} onChange={(e) => setEdit({ ...edit, [i.articulo_id]: e.target.value })} aria-label={`Contado de ${i.nombre}`} />
                : i.contado == null ? '—' : cantidad(i.contado),
              movil: 'derecha',
            },
            { clave: 'd', titulo: 'Diferencia', alinear: 'derecha', render: (i: any) => { const v = valorDe(i); if (v == null) return <span className="text-tenue">—</span>; const d = Math.round((v - i.stock_sistema) * 1000) / 1000; return <span className={d === 0 ? 'text-emerald-700' : d < 0 ? 'font-medium text-red-600' : 'font-medium text-amber-700'}>{d > 0 ? '+' : ''}{cantidad(d)}</span>; }, movil: 'meta' },
            { clave: 'v', titulo: 'Valor', alinear: 'derecha', render: (i: any) => { const v = valorDe(i); return v == null ? '' : money(Math.round((v - i.stock_sistema) * i.costo)); }, movil: 'meta' },
          ]}
        />
      </Tarjeta>
      {dialogo}
    </>
  );
}

function Conteos() {
  const { puede } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const abierto = sp.get('conteo');
  const [nuevo, setNuevo] = useState(false);
  const [f, setF] = useState({ categoria_id: '', descripcion: '', solo_con_stock: false, deposito_id: '' });
  const { data: cats = [] } = useQuery({ queryKey: ['categorias-articulo'], queryFn: () => api.get<any[]>('/categorias-articulo') });
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['inventario', 'conteos'], queryFn: () => api.get<any[]>('/inventario/conteos') });
  const iniciar = useMutation({
    mutationFn: () => api.post('/inventario/conteos', { categoria_id: f.categoria_id || null, descripcion: f.descripcion || null, solo_con_stock: f.solo_con_stock, deposito_id: f.deposito_id || null }),
    onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: ['inventario'] }); setNuevo(false); setSp({ tab: 'conteos', conteo: r.id }); toast.ok('Conteo iniciado'); },
    onError: toast.error,
  });
  if (abierto) return <ConteoDetalle id={abierto} onVolver={() => setSp({ tab: 'conteos' })} />;
  return (
    <>
      {puede('stock.ajustar') && <div className="mb-4"><Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => setNuevo(true)}>Iniciar conteo</Boton></div>}
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={data}
            clave={(c: any) => c.id}
            onFila={(c: any) => setSp({ tab: 'conteos', conteo: c.id })}
            vacio={<Vacio icono={<ClipboardCheck className="size-5" />} titulo="Todavía no hiciste conteos físicos" texto="Un conteo toma una foto del stock, te deja cargar lo que contás en el estante y ajusta sólo las diferencias, con trazabilidad." />}
            columnas={[
              { clave: 'n', titulo: 'Conteo', render: (c: any) => <span className="font-medium">#{numero(c.numero)}</span>, movil: 'titulo' },
              { clave: 'f', titulo: 'Fecha', render: (c: any) => fecha(c.fecha), movil: 'meta' },
              { clave: 'a', titulo: 'Alcance', render: (c: any) => `${c.deposito ? `${c.deposito} · ` : ''}${c.categoria ?? 'Todo el inventario'}${c.descripcion ? ` · ${c.descripcion}` : ''}`, movil: 'subtitulo' },
              { clave: 'c', titulo: 'Contados', alinear: 'derecha', render: (c: any) => `${c.contados}/${c.articulos}`, movil: 'meta' },
              { clave: 'd', titulo: 'Con diferencia', alinear: 'derecha', render: (c: any) => c.con_diferencia, movil: 'meta' },
              { clave: 'e', titulo: 'Estado', render: (c: any) => <Insignia tono={c.estado === 'abierto' ? 'azul' : c.estado === 'aplicado' ? 'verde' : 'gris'}>{c.estado === 'abierto' ? 'Abierto' : c.estado === 'aplicado' ? 'Aplicado' : 'Cancelado'}</Insignia>, movil: 'derecha' },
            ]}
          />
        </Tarjeta>
      )}
      <Modal abierto={nuevo} onCerrar={() => setNuevo(false)} titulo="Iniciar conteo físico" ancho="sm" pie={<><Boton onClick={() => setNuevo(false)}>Cancelar</Boton><Boton variante="primario" cargando={iniciar.isPending} onClick={() => iniciar.mutate()}>Iniciar</Boton></>}>
        <div className="space-y-3">
          <Aviso>Se toma una foto del stock actual de los artículos activos. Conviene contar por categoría o estantería para no pasar de 250 ajustes por conteo.</Aviso>
          <Campo label="Categoría"><Select value={f.categoria_id} onChange={(e) => setF({ ...f, categoria_id: e.target.value })}><option value="">Todo el inventario</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</Select></Campo>
          <SelectorDeposito valor={f.deposito_id} onCambio={(v) => setF({ ...f, deposito_id: v })} label="Depósito a contar" />
          <Campo label="Descripción (opcional)"><Input value={f.descripcion} onChange={(e) => setF({ ...f, descripcion: e.target.value })} placeholder="Ej.: estantería 2" /></Campo>
          <Check checked={f.solo_con_stock} onChange={(v) => setF({ ...f, solo_con_stock: v })} label="Incluir sólo artículos con stock distinto de cero" />
        </div>
      </Modal>
    </>
  );
}

export function Inventario() {
  const { puede } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') === 'conteos' || !puede('stock.valorizar') ? 'conteos' : 'valorizado';
  return (
    <>
      <Encabezado titulo="Inventario" subtitulo="Valorización y conteo físico" />
      <Pestanas items={[...(puede('stock.valorizar') ? [{ clave: 'valorizado' as const, titulo: 'Inventario valorizado' }] : []), { clave: 'conteos' as const, titulo: 'Conteo físico' }]} activo={tab} onCambio={(t) => setSp({ tab: t })} />
      {tab === 'valorizado' ? <Valorizado /> : <Conteos />}
    </>
  );
}
