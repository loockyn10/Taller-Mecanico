// Depósitos del taller: existencias por depósito, transferencias internas y control de consistencia del stock.
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Download, Plus, ShieldCheck, Trash2, Warehouse } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { descargarCSV, pesosCSV } from '@/lib/csv';
import { cantidad, fecha, money, numero } from '@/lib/format';
import { buscarPorCodigo } from '@/lib/lector';
import { Aviso, Boton, Buscador, Campo, Cargando, Check, Encabezado, ErrorCaja, Input, Insignia, Modal, Pestanas, Select, Tabla, Tarjeta, useConfirmar, useDebounce, useToast, Vacio } from '@/components/ui';
import { useDepositos, type DepositoApi } from '@/components/SelectorDeposito';
import { nuevaClave } from '@/lib/api';

function FormDeposito({ inicial, onCerrar }: { inicial?: DepositoApi; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ nombre: inicial?.nombre ?? '', notas: inicial?.notas ?? '', activo: inicial ? !!inicial.activo : true });
  const guardar = useMutation({
    mutationFn: () => (inicial ? api.put(`/depositos/${inicial.id}`, { nombre: f.nombre, notas: f.notas, ...(inicial.es_principal ? {} : { activo: f.activo }) }) : api.post('/depositos', { nombre: f.nombre, notas: f.notas })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['depositos'] }); toast.ok('Depósito guardado'); onCerrar(); },
    onError: toast.error,
  });
  return (
    <Modal abierto onCerrar={onCerrar} titulo={inicial ? 'Editar depósito' : 'Nuevo depósito'} ancho="sm" pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" disabled={f.nombre.trim().length < 2} cargando={guardar.isPending} onClick={() => guardar.mutate()}>Guardar</Boton></>}>
      <div className="space-y-3">
        <Campo label="Nombre" requerido><Input value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} autoFocus placeholder="Ej.: Taller, Mostrador, Camioneta" /></Campo>
        <Campo label="Notas"><Input value={f.notas} onChange={(e) => setF({ ...f, notas: e.target.value })} /></Campo>
        {inicial && !inicial.es_principal && <Check checked={f.activo} onChange={(v) => setF({ ...f, activo: v })} label="Activo (para desactivarlo no debe tener mercadería)" />}
        {inicial?.es_principal ? <p className="text-xs text-tenue">Es el depósito principal: lo usan por defecto todas las operaciones y no se puede desactivar.</p> : null}
      </div>
    </Modal>
  );
}

function StockDeDeposito({ dep, onCerrar }: { dep: DepositoApi; onCerrar: () => void }) {
  const [q, setQ] = useState('');
  const dq = useDebounce(q);
  const { data, isLoading, error } = useQuery({ queryKey: ['depositos', dep.id, 'stock', dq], queryFn: () => api.get<any>(`/depositos/${dep.id}/stock${qs({ q: dq })}`) });
  const items: any[] = data?.items ?? [];
  const conValor = items.some((i) => i.valor_costo !== undefined);
  return (
    <Modal abierto onCerrar={onCerrar} titulo={`Stock · ${dep.nombre}`} ancho="xl"
      pie={<>
        {items.length > 0 && <Boton icono={<Download className="size-4" />} className="mr-auto" onClick={() => descargarCSV(`stock-${dep.nombre}`, ['Código', 'Código de barras', 'Artículo', 'Stock', 'Unidad', ...(conValor ? ['Costo', 'Valor al costo'] : [])], items.map((i) => [i.codigo, i.codigo_barras, i.nombre, i.stock, i.unidad, ...(conValor ? [pesosCSV(i.costo), pesosCSV(i.valor_costo)] : [])]))}>CSV</Boton>}
        <Boton onClick={onCerrar}>Cerrar</Boton>
      </>}>
      <Buscador value={q} onChange={setQ} placeholder="Artículo, código o código de barras" className="mb-3" />
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} /> : (
        <Tabla
          filas={items}
          clave={(i) => i.articulo_id}
          vacio={<Vacio icono={<Warehouse className="size-5" />} titulo="Sin mercadería en este depósito" />}
          columnas={[
            { clave: 'c', titulo: 'Código', render: (i) => i.codigo ?? '—', movil: 'meta' },
            { clave: 'n', titulo: 'Artículo', render: (i) => <span className="font-medium">{i.nombre}</span>, movil: 'titulo' },
            { clave: 's', titulo: 'Stock', alinear: 'derecha', render: (i) => `${cantidad(i.stock)} ${i.unidad}`, movil: 'derecha' },
            { clave: 'mn', titulo: 'Mínimo del depósito', alinear: 'derecha', render: (i: any) => (i.minimo_deposito != null ? <span className={i.bajo_minimo ? 'font-semibold text-amber-700' : ''}>{cantidad(i.minimo_deposito)}{i.bajo_minimo ? ' · reponer' : ''}</span> : '—'), movil: 'meta' },
            { clave: 't', titulo: 'Total taller', alinear: 'derecha', render: (i) => cantidad(i.stock_total), movil: 'oculta' },
            ...(conValor ? [{ clave: 'v', titulo: 'Valor al costo', alinear: 'derecha' as const, render: (i: any) => money(i.valor_costo), movil: 'meta' as const }] : []),
          ]}
        />
      )}
    </Modal>
  );
}

function FormTransferencia({ deps, onCerrar }: { deps: DepositoApi[]; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const activos = deps.filter((d) => d.activo);
  const [origen, setOrigen] = useState(activos.find((d) => d.es_principal)?.id ?? activos[0]?.id ?? '');
  const [destino, setDestino] = useState(activos.find((d) => d.id !== origen)?.id ?? '');
  const [notas, setNotas] = useState('');
  const [items, setItems] = useState<Array<{ articulo_id: string; nombre: string; unidad: string; disponible: number; cantidad: number }>>([]);
  const [q, setQ] = useState('');
  const dq = useDebounce(q);
  const [clave] = useState(nuevaClave());
  const { data } = useQuery({ queryKey: ['depositos', origen, 'stock', dq, 'transf'], queryFn: () => api.get<any>(`/depositos/${origen}/stock${qs({ q: dq })}`), enabled: !!origen && dq.length >= 1 });
  const agregar = (a: any) => { setItems((prev) => (prev.some((i) => i.articulo_id === a.articulo_id) ? prev : [...prev, { articulo_id: a.articulo_id, nombre: a.nombre, unidad: a.unidad, disponible: a.stock, cantidad: Math.min(1, a.stock) }])); setQ(''); };
  const leer = async (codigo: string) => {
    const a = await buscarPorCodigo(codigo).catch(() => null);
    if (!a) return toast.error(new Error(`No hay ningún artículo con el código ${codigo}`));
    const r = await api.get<any>(`/depositos/${origen}/stock${qs({ q: a.codigo_barras || a.codigo || a.nombre })}`);
    const fila = r.items.find((i: any) => i.articulo_id === a.id);
    if (!fila) return toast.error(new Error(`${a.nombre} no tiene stock en el depósito de origen`));
    agregar(fila);
  };
  const guardar = useMutation({
    mutationFn: () => api.post('/transferencias', { origen_id: origen, destino_id: destino, notas: notas || null, idem_key: clave, items: items.map((i) => ({ articulo_id: i.articulo_id, cantidad: i.cantidad })) }),
    onSuccess: (t: any) => { ['depositos', 'transferencias', 'articulos', 'articulo', 'movimientos'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast.ok(`Transferencia #${numero(t.numero)} registrada`); onCerrar(); },
    onError: toast.error,
  });
  const valido = !!origen && !!destino && origen !== destino && items.length > 0 && items.every((i) => i.cantidad > 0 && i.cantidad <= i.disponible);
  return (
    <Modal abierto onCerrar={onCerrar} titulo="Nueva transferencia entre depósitos" ancho="lg" pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" icono={<ArrowRightLeft className="size-4" />} disabled={!valido} cargando={guardar.isPending} onClick={() => guardar.mutate()}>Transferir</Boton></>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Campo label="Desde"><Select value={origen} onChange={(e) => { setOrigen(e.target.value); setItems([]); }}>{activos.map((d) => <option key={d.id} value={d.id}>{d.nombre}</option>)}</Select></Campo>
          <Campo label="Hacia"><Select value={destino} onChange={(e) => setDestino(e.target.value)}>{activos.filter((d) => d.id !== origen).map((d) => <option key={d.id} value={d.id}>{d.nombre}</option>)}</Select></Campo>
        </div>
        <div className="relative">
          <Buscador value={q} onChange={setQ} onEnter={leer} placeholder="Buscar artículo con stock en el origen (o escaneá el código de barras)" />
          {dq && (data?.items?.length ?? 0) > 0 && (
            <ul className="absolute z-10 mt-1 max-h-56 w-full divide-y divide-borde overflow-y-auto rounded-ctl border border-borde bg-white text-sm shadow-pop">
              {data.items.map((a: any) => <li key={a.articulo_id}><button type="button" className="flex w-full justify-between px-3 py-2 text-left hover:bg-marca-50" onClick={() => agregar(a)}><span>{a.nombre} <span className="text-tenue">{a.codigo ?? ''}</span></span><span className="text-tenue">{cantidad(a.stock)} {a.unidad}</span></button></li>)}
            </ul>
          )}
        </div>
        {items.length === 0 ? <p className="rounded-ctl border border-dashed border-borde px-4 py-6 text-center text-sm text-tenue">Agregá los artículos a transferir</p> : (
          <ul className="divide-y divide-borde rounded-card border border-borde">
            {items.map((i) => (
              <li key={i.articulo_id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 break-words">{i.nombre} <span className="text-xs text-tenue">(disponible {cantidad(i.disponible)})</span></span>
                <span className="flex items-center gap-2">
                  <Input type="number" min={0} step="any" value={i.cantidad} className="h-9 w-24 text-right" aria-label="Cantidad" onChange={(e) => setItems(items.map((x) => (x.articulo_id === i.articulo_id ? { ...x, cantidad: Number(e.target.value) } : x)))} />
                  {i.cantidad > i.disponible && <Insignia tono="rojo">Excede</Insignia>}
                  <Boton variante="fantasma" tam="sm" aria-label="Quitar" icono={<Trash2 className="size-4 text-red-600" />} onClick={() => setItems(items.filter((x) => x.articulo_id !== i.articulo_id))} />
                </span>
              </li>
            ))}
          </ul>
        )}
        <Campo label="Notas"><Input value={notas} onChange={(e) => setNotas(e.target.value)} /></Campo>
      </div>
    </Modal>
  );
}

function DetalleTransferencia({ id, onCerrar }: { id: string; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useAuth();
  const { confirmar, dialogo } = useConfirmar();
  const { data: t } = useQuery({ queryKey: ['transferencias', id], queryFn: () => api.get<any>(`/transferencias/${id}`) });
  const anular = useMutation({
    mutationFn: (motivo: string) => api.post(`/transferencias/${id}/anular`, { motivo }),
    onSuccess: () => { ['depositos', 'transferencias', 'articulos', 'articulo', 'movimientos'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast.ok('Transferencia anulada: la mercadería volvió al origen'); onCerrar(); },
    onError: toast.error,
  });
  return (
    <Modal abierto onCerrar={onCerrar} titulo={t ? `Transferencia #${numero(t.numero)}` : 'Transferencia'} ancho="md"
      pie={<>{t?.estado === 'registrada' && puede('stock.ajustar') && <Boton variante="peligro" className="mr-auto" onClick={async () => { if (await confirmar('Anular transferencia', 'La mercadería vuelve al depósito de origen (el destino debe conservarla).')) anular.mutate('Anulada por el usuario'); }}>Anular</Boton>}<Boton onClick={onCerrar}>Cerrar</Boton></>}>
      {dialogo}
      {!t ? <Cargando /> : (
        <div className="space-y-3 text-sm">
          <p><strong>{t.origen}</strong> → <strong>{t.destino}</strong> · {fecha(t.fecha)} · {t.usuario ?? '—'} {t.estado === 'anulada' && <Insignia tono="gris">Anulada</Insignia>}</p>
          {t.notas && <p className="text-tenue">{t.notas}</p>}
          <ul className="divide-y divide-borde rounded-card border border-borde">{t.items.map((i: any) => <li key={i.articulo_id} className="flex justify-between px-3 py-2"><span>{i.nombre}</span><span className="tabular-nums">{cantidad(i.cantidad)} {i.unidad}</span></li>)}</ul>
        </div>
      )}
    </Modal>
  );
}

function Control() {
  const [ver, setVer] = useState(false);
  const { data, isFetching, refetch } = useQuery({ queryKey: ['inventario', 'verificar'], queryFn: () => api.get<any>('/inventario/verificar'), enabled: ver });
  return (
    <Tarjeta titulo="Control de consistencia del stock" subtitulo="El stock total de cada artículo debe ser exactamente la suma de sus depósitos, y ningún depósito debe quedar en negativo">
      <Boton variante="primario" icono={<ShieldCheck className="size-4" />} cargando={isFetching} onClick={() => (ver ? refetch() : setVer(true))}>Verificar ahora</Boton>
      {data && (data.ok && data.depositos_negativos.length === 0
        ? <Aviso tono="verde" className="mt-4">Todo en orden: los totales coinciden con la suma de los depósitos y no hay depósitos en negativo.</Aviso>
        : <div className="mt-4 space-y-3 text-sm">
            {data.diferencias.length > 0 && <Aviso tono="rojo">Hay {data.diferencias.length} artículos cuyo total no coincide con la suma de sus depósitos: {data.diferencias.map((d: any) => `${d.nombre} (${d.stock_total} vs ${d.suma_depositos})`).join('; ')}</Aviso>}
            {data.depositos_negativos.length > 0 && <Aviso tono="ambar">Depósitos con stock negativo: {data.depositos_negativos.map((d: any) => `${d.nombre} en ${d.deposito} (${d.stock})`).join('; ')}</Aviso>}
          </div>)}
    </Tarjeta>
  );
}

export function Depositos() {
  const { puede } = useAuth();
  const [tab, setTab] = useState<'depositos' | 'transferencias' | 'control'>('depositos');
  const { data: deps = [], isLoading, error, refetch } = useDepositos();
  const [form, setForm] = useState<{ inicial?: DepositoApi } | null>(null);
  const [verStock, setVerStock] = useState<DepositoApi | null>(null);
  const [nueva, setNueva] = useState(false);
  const [detalle, setDetalle] = useState<string | null>(null);
  const [filtroDep, setFiltroDep] = useState('');
  const { data: transf = [] } = useQuery({ queryKey: ['transferencias', filtroDep], queryFn: () => api.get<any[]>(`/transferencias${qs({ deposito_id: filtroDep })}`), enabled: tab === 'transferencias' });
  const puedeAjustar = puede('stock.ajustar');
  const hayValor = useMemo(() => deps.some((d) => d.valor_costo !== undefined), [deps]);
  return (
    <>
      <Encabezado
        titulo="Depósitos y transferencias"
        subtitulo="Dónde está cada repuesto. Los depósitos son internos de tu taller; el stock total es la suma de todos"
        acciones={puedeAjustar && (
          <>
            {deps.filter((d) => d.activo).length > 1 && <Boton icono={<ArrowRightLeft className="size-4" />} onClick={() => setNueva(true)}>Nueva transferencia</Boton>}
            <Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => setForm({})}>Nuevo depósito</Boton>
          </>
        )}
      />
      <Pestanas activo={tab} onCambio={setTab} items={[{ clave: 'depositos', titulo: 'Depósitos' }, { clave: 'transferencias', titulo: 'Transferencias' }, ...(puedeAjustar ? [{ clave: 'control' as const, titulo: 'Control' }] : [])]} />
      {tab === 'depositos' && (isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={deps}
            clave={(d) => d.id}
            onFila={(d) => setVerStock(d)}
            columnas={[
              { clave: 'n', titulo: 'Depósito', render: (d) => <span className={d.activo ? 'font-medium' : 'text-tenue line-through'}>{d.nombre} {d.es_principal ? <Insignia tono="azul" className="ml-1">Principal</Insignia> : null}</span>, movil: 'titulo' },
              { clave: 'a', titulo: 'Artículos con stock', alinear: 'derecha', render: (d) => d.articulos_con_stock, movil: 'meta' },
              { clave: 'u', titulo: 'Unidades', alinear: 'derecha', render: (d) => cantidad(d.unidades), movil: 'meta' },
              ...(hayValor ? [{ clave: 'v', titulo: 'Valor al costo', alinear: 'derecha' as const, render: (d: DepositoApi) => money(d.valor_costo), movil: 'derecha' as const }] : []),
              { clave: 'e', titulo: '', alinear: 'derecha', render: (d) => puedeAjustar ? <Boton tam="sm" onClick={() => setForm({ inicial: d })}>Editar</Boton> : null, movil: 'oculta' },
            ]}
          />
        </Tarjeta>
      ))}
      {tab === 'transferencias' && (
        <>
          <div className="mb-3 max-w-xs"><Select aria-label="Depósito" value={filtroDep} onChange={(e) => setFiltroDep(e.target.value)}><option value="">Todos los depósitos</option>{deps.map((d) => <option key={d.id} value={d.id}>{d.nombre}</option>)}</Select></div>
          <Tarjeta sinPadding>
            <Tabla
              filas={transf}
              clave={(t) => t.id}
              onFila={(t) => setDetalle(t.id)}
              vacio={<Vacio icono={<ArrowRightLeft className="size-5" />} titulo="Sin transferencias" texto="Cuando muevas mercadería entre depósitos queda el historial acá." />}
              columnas={[
                { clave: 'n', titulo: 'N°', render: (t) => <span className="font-medium">#{numero(t.numero)}</span>, movil: 'titulo' },
                { clave: 'f', titulo: 'Fecha', render: (t) => fecha(t.fecha), movil: 'meta' },
                { clave: 'r', titulo: 'Movimiento', render: (t) => `${t.origen} → ${t.destino}`, movil: 'subtitulo' },
                { clave: 'l', titulo: 'Artículos', alinear: 'derecha', render: (t) => t.lineas, movil: 'meta' },
                { clave: 'u', titulo: 'Usuario', render: (t) => t.usuario ?? '—', movil: 'oculta' },
                { clave: 'e', titulo: 'Estado', render: (t) => <Insignia tono={t.estado === 'registrada' ? 'verde' : 'gris'}>{t.estado === 'registrada' ? 'Registrada' : 'Anulada'}</Insignia>, movil: 'derecha' },
              ]}
            />
          </Tarjeta>
        </>
      )}
      {tab === 'control' && puedeAjustar && <Control />}
      {form && <FormDeposito inicial={form.inicial} onCerrar={() => setForm(null)} />}
      {verStock && <StockDeDeposito dep={verStock} onCerrar={() => setVerStock(null)} />}
      {nueva && <FormTransferencia deps={deps} onCerrar={() => setNueva(false)} />}
      {detalle && <DetalleTransferencia id={detalle} onCerrar={() => setDetalle(null)} />}
    </>
  );
}
