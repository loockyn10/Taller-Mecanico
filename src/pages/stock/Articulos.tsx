import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowDownUp, Package, Pencil, Plus, ShoppingCart } from 'lucide-react';
import { api, nuevaClave, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cantidad, fechaHora, money } from '@/lib/format';
import { Boton, Buscador, Campo, Cargando, Check, Dato, Encabezado, ErrorCaja, Input, InputMoneda, Insignia, Modal, Select, Tabla, Tarjeta, useDebounce, useToast, Vacio } from '@/components/ui';
import { MOTIVO_AJUSTE_LABEL, MOTIVOS_AJUSTE, TIPOS_MOVIMIENTO_STOCK_LABEL } from '@shared/dominio';

function useCategoriasArticulo() {
  return useQuery({ queryKey: ['categorias-articulo'], queryFn: () => api.get<any[]>('/categorias-articulo'), staleTime: 60_000 });
}
function useProveedores() {
  return useQuery({ queryKey: ['proveedores'], queryFn: () => api.get<any[]>('/proveedores'), staleTime: 60_000 });
}

export function FormArticulo({ inicial, onCerrar }: { inicial?: any; onCerrar: (id?: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: cats = [] } = useCategoriasArticulo();
  const { data: provs = [] } = useProveedores();
  const { data: cfg } = useQuery({ queryKey: ['config'], queryFn: () => api.get('/taller/config') });
  const margen = cfg?.config.margen_default ?? 40;
  const [f, setF] = useState({
    codigo: inicial?.codigo ?? '',
    nombre: inicial?.nombre ?? '',
    marca: inicial?.marca ?? '',
    categoria_id: inicial?.categoria_id ?? '',
    proveedor_id: inicial?.proveedor_id ?? '',
    costo: inicial?.costo ?? 0,
    precio: inicial?.precio ?? 0,
    alicuota_iva: inicial?.alicuota_iva ?? 21,
    stock_inicial: 0,
    stock_minimo: inicial?.stock_minimo ?? 0,
    stock_objetivo: inicial?.stock_objetivo != null ? String(inicial.stock_objetivo) : '',
    unidad: inicial?.unidad ?? 'un',
    ubicacion: inicial?.ubicacion ?? '',
  });
  const set = (k: keyof typeof f, v: any) => setF({ ...f, [k]: v });
  const m = useMutation({
    mutationFn: () => {
      const d: any = { ...f, categoria_id: f.categoria_id || null, proveedor_id: f.proveedor_id || null, stock_minimo: Number(f.stock_minimo), stock_objetivo: f.stock_objetivo === '' ? null : Number(f.stock_objetivo), alicuota_iva: Number(f.alicuota_iva) };
      if (inicial?.id) {
        delete d.stock_inicial;
        return api.put(`/articulos/${inicial.id}`, d).then(() => ({ id: inicial.id }));
      }
      d.stock_inicial = Number(f.stock_inicial);
      return api.post('/articulos', d);
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['articulos'] });
      qc.invalidateQueries({ queryKey: ['articulo'] });
      toast.ok('Artículo guardado');
      onCerrar(r.id);
    },
    onError: toast.error,
  });
  return (
    <Modal abierto onCerrar={() => onCerrar()} titulo={inicial?.id ? 'Editar artículo' : 'Nuevo artículo'} ancho="lg" pie={<><Boton onClick={() => onCerrar()}>Cancelar</Boton><Boton variante="primario" disabled={f.nombre.trim().length < 2} cargando={m.isPending} onClick={() => m.mutate()}>Guardar</Boton></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Campo label="Nombre" requerido className="sm:col-span-2"><Input value={f.nombre} onChange={(e) => set('nombre', e.target.value)} autoFocus /></Campo>
        <Campo label="Código / SKU"><Input value={f.codigo} onChange={(e) => set('codigo', e.target.value)} /></Campo>
        <Campo label="Marca"><Input value={f.marca} onChange={(e) => set('marca', e.target.value)} /></Campo>
        <Campo label="Categoría">
          <Select value={f.categoria_id} onChange={(e) => set('categoria_id', e.target.value)}>
            <option value="">—</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </Select>
        </Campo>
        <Campo label="Proveedor habitual">
          <Select value={f.proveedor_id} onChange={(e) => set('proveedor_id', e.target.value)}>
            <option value="">—</option>
            {provs.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </Select>
        </Campo>
        <Campo label="Costo"><InputMoneda value={f.costo} onChange={(v) => set('costo', v)} /></Campo>
        <Campo label="Precio de venta" hint={<button type="button" className="text-marca-700 underline" onClick={() => set('precio', Math.round((f.costo * (1 + margen / 100)) / 100) * 100)}>Calcular con margen {margen}%</button>}>
          <InputMoneda value={f.precio} onChange={(v) => set('precio', v)} />
        </Campo>
        <Campo label="Alícuota IVA">
          <Select value={f.alicuota_iva} onChange={(e) => set('alicuota_iva', Number(e.target.value))}>
            {[0, 10.5, 21, 27].map((a) => <option key={a} value={a}>{a}%</option>)}
          </Select>
        </Campo>
        <Campo label="Unidad">
          <Select value={f.unidad} onChange={(e) => set('unidad', e.target.value)}>
            <option value="un">Unidad</option><option value="lt">Litro</option><option value="kg">Kilo</option><option value="m">Metro</option><option value="juego">Juego</option>
          </Select>
        </Campo>
        {!inicial?.id && <Campo label="Stock inicial" hint="Queda registrado como movimiento de entrada"><Input type="number" min={0} step="any" value={f.stock_inicial} onChange={(e) => set('stock_inicial', e.target.value)} /></Campo>}
        <Campo label="Stock mínimo (alerta)"><Input type="number" min={0} step="any" value={f.stock_minimo} onChange={(e) => set('stock_minimo', e.target.value)} /></Campo>
        <Campo label="Stock ideal (opcional)" hint="Hasta cuánto reponer. Vacío = el doble del mínimo"><Input type="number" min={0} step="any" value={f.stock_objetivo} onChange={(e) => set('stock_objetivo', e.target.value)} /></Campo>
        <Campo label="Ubicación"><Input value={f.ubicacion} onChange={(e) => set('ubicacion', e.target.value)} placeholder="Estante A2" /></Campo>
      </div>
      {inicial?.id && <p className="mt-3 text-xs text-tenue">El stock no se edita directamente: usá “Movimiento de stock” para entradas, salidas o ajustes.</p>}
    </Modal>
  );
}

export function ModalMovimiento({ articulo, onCerrar }: { articulo: any; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [tipo, setTipo] = useState<'entrada' | 'salida' | 'ajuste'>('entrada');
  const [cant, setCant] = useState('');
  const [notas, setNotas] = useState('');
  const [motivo, setMotivo] = useState('conteo');
  const [clave] = useState(nuevaClave());
  const m = useMutation({
    mutationFn: () => api.post('/stock/movimientos', { articulo_id: articulo.id, tipo, cantidad: Number(cant), notas, motivo: tipo === 'entrada' ? null : motivo, idem_key: clave }),
    onSuccess: (r) => {
      ['articulos', 'articulo', 'movimientos', 'dashboard'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.ok(`Stock actualizado: ${r.stock} ${articulo.unidad}`);
      onCerrar();
    },
    onError: toast.error,
  });
  return (
    <Modal abierto onCerrar={onCerrar} titulo={`Movimiento de stock · ${articulo.nombre}`} ancho="sm" pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" disabled={cant === '' || (tipo !== 'entrada' && motivo === 'otro' && !notas.trim())} cargando={m.isPending} onClick={() => m.mutate()}>Registrar</Boton></>}>
      <div className="space-y-3">
        <p className="text-sm">Stock actual: <strong>{cantidad(articulo.stock)} {articulo.unidad}</strong></p>
        <Campo label="Tipo">
          <Select value={tipo} onChange={(e) => setTipo(e.target.value as any)}>
            <option value="entrada">Entrada (ingreso de mercadería)</option>
            <option value="salida">Salida (consumo, rotura, uso interno)</option>
            <option value="ajuste">Ajuste por conteo de inventario</option>
          </Select>
        </Campo>
        <Campo label={tipo === 'ajuste' ? 'Stock contado (queda este valor)' : 'Cantidad'}><Input type="number" min={0} step="any" value={cant} onChange={(e) => setCant(e.target.value)} autoFocus /></Campo>
        {tipo !== 'entrada' && (
          <Campo label="Motivo" requerido hint="Queda registrado para auditar mermas y diferencias">
            <Select value={motivo} onChange={(e) => setMotivo(e.target.value)}>{MOTIVOS_AJUSTE.map((x) => <option key={x} value={x}>{MOTIVO_AJUSTE_LABEL[x]}</option>)}</Select>
          </Campo>
        )}
        <Campo label="Notas" requerido={tipo !== 'entrada' && motivo === 'otro'}><Input value={notas} onChange={(e) => setNotas(e.target.value)} /></Campo>
      </div>
    </Modal>
  );
}

export function Articulos() {
  const nav = useNavigate();
  const { puede } = useAuth();
  const [sp] = useSearchParams();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [bajo, setBajo] = useState(sp.get('bajo') === '1');
  const [form, setForm] = useState(false);
  const dq = useDebounce(q);
  const { data: cats = [] } = useCategoriasArticulo();
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['articulos', { dq, cat, bajo }], queryFn: () => api.get<any[]>(`/articulos${qs({ q: dq, categoria_id: cat, bajo_stock: bajo })}`) });
  return (
    <>
      <Encabezado titulo="Artículos y stock" subtitulo="Repuestos, lubricantes e insumos" acciones={<>{puede('stock.ver') && <Boton icono={<ShoppingCart className="size-4" />} onClick={() => nav('/reposicion')}>Reposición</Boton>}{puede('catalogo.editar') && <Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => setForm(true)}>Nuevo artículo</Boton>}</>} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Buscador value={q} onChange={setQ} placeholder="Nombre, código o marca" className="min-w-56 flex-1" />
        <Select value={cat} onChange={(e) => setCat(e.target.value)} className="w-auto">
          <option value="">Todas las categorías</option>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
        </Select>
        <Check checked={bajo} onChange={setBajo} label="Solo stock bajo" />
      </div>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={data}
            clave={(a) => a.id}
            onFila={(a) => nav(`/articulos/${a.id}`)}
            vacio={<Vacio icono={<Package className="size-5" />} titulo="No hay artículos" />}
            columnas={[
              { clave: 'c', titulo: 'Código', render: (a) => a.codigo ?? '—', movil: 'meta' },
              { clave: 'n', titulo: 'Artículo', render: (a) => <span className="font-medium">{a.nombre}</span>, movil: 'titulo' },
              { clave: 'm', titulo: 'Marca', render: (a) => a.marca ?? '—', movil: 'subtitulo' },
              { clave: 'cat', titulo: 'Categoría', render: (a) => a.categoria ?? '—', movil: 'oculta' },
              { clave: 'u', titulo: 'Ubicación', render: (a) => a.ubicacion ?? '—', movil: 'oculta' },
              { clave: 'p', titulo: 'Precio', alinear: 'derecha', render: (a) => money(a.precio), movil: 'meta' },
              {
                clave: 's', titulo: 'Stock', alinear: 'derecha', movil: 'derecha',
                render: (a) => <Insignia tono={a.stock <= 0 ? 'rojo' : a.stock <= a.stock_minimo ? 'ambar' : 'verde'}>{cantidad(a.stock)} {a.unidad}</Insignia>,
              },
            ]}
          />
        </Tarjeta>
      )}
      {form && <FormArticulo onCerrar={(id) => { setForm(false); if (id) nav(`/articulos/${id}`); }} />}
    </>
  );
}

export function ArticuloDetalle() {
  const { id } = useParams();
  const { puede } = useAuth();
  const [editar, setEditar] = useState(false);
  const [mov, setMov] = useState(false);
  const { data: a, isLoading, error, refetch } = useQuery({ queryKey: ['articulo', id], queryFn: () => api.get(`/articulos/${id}`) });
  const { data: costos } = useQuery({ queryKey: ['articulo', id, 'costos'], queryFn: () => api.get(`/inventario/costos/${id}`), enabled: puede('stock.valorizar') });
  const { data: precios = [] } = useQuery({ queryKey: ['articulo', id, 'precios-lista'], queryFn: () => api.get<any[]>(`/articulos/${id}/precios-lista`) });
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  const margen = a.costo > 0 ? Math.round(((a.precio - a.costo) / a.costo) * 100) : null;
  return (
    <>
      <Encabezado
        volver="/articulos"
        titulo={a.nombre}
        subtitulo={[a.codigo, a.marca, a.categoria].filter(Boolean).join(' · ')}
        acciones={
          <>
            {puede('catalogo.editar') && <Boton icono={<Pencil className="size-4" />} onClick={() => setEditar(true)}>Editar</Boton>}
            {puede('stock.ajustar') && <Boton variante="primario" icono={<ArrowDownUp className="size-4" />} onClick={() => setMov(true)}>Movimiento de stock</Boton>}
          </>
        }
      />
      <div className="grid gap-5 lg:grid-cols-3">
        <Tarjeta titulo="Movimientos" className="lg:col-span-2" sinPadding>
          <Tabla
            filas={a.movimientos}
            clave={(m: any) => m.id}
            vacio={<p className="px-4 py-6 text-center text-sm text-tenue">Sin movimientos</p>}
            columnas={[
              { clave: 'f', titulo: 'Fecha', render: (m: any) => fechaHora(m.created_at), movil: 'meta' },
              { clave: 't', titulo: 'Tipo', render: (m: any) => TIPOS_MOVIMIENTO_STOCK_LABEL[m.tipo] ?? m.tipo, movil: 'titulo' },
              { clave: 'n', titulo: 'Detalle', render: (m: any) => [m.motivo ? MOTIVO_AJUSTE_LABEL[m.motivo as keyof typeof MOTIVO_AJUSTE_LABEL] ?? m.motivo : null, m.notas].filter(Boolean).join(' · ') || '—', movil: 'subtitulo' },
              { clave: 'u', titulo: 'Usuario', render: (m: any) => m.usuario ?? '—', movil: 'oculta' },
              { clave: 'c', titulo: 'Cantidad', alinear: 'derecha', render: (m: any) => <span className={m.cantidad < 0 ? 'text-red-600' : 'text-emerald-700'}>{m.cantidad > 0 ? '+' : ''}{cantidad(m.cantidad)}</span>, movil: 'derecha' },
              { clave: 's', titulo: 'Stock', alinear: 'derecha', render: (m: any) => cantidad(m.stock_resultante), movil: 'meta' },
            ]}
          />
        </Tarjeta>
        <Tarjeta titulo="Datos">
          <dl className="grid grid-cols-2 gap-4">
            <Dato etiqueta="Stock actual"><span className="text-xl font-bold">{cantidad(a.stock)} {a.unidad}</span></Dato>
            <Dato etiqueta="Stock mínimo">{cantidad(a.stock_minimo)}</Dato>
            <Dato etiqueta="Stock ideal">{a.stock_objetivo != null ? cantidad(a.stock_objetivo) : `${cantidad(a.stock_minimo * 2)} (automático)`}</Dato>
            <Dato etiqueta="Costo">{money(a.costo)}</Dato>
            <Dato etiqueta="Precio">{money(a.precio)}</Dato>
            <Dato etiqueta="Margen">{margen != null ? `${margen}%` : '—'}</Dato>
            <Dato etiqueta="IVA">{a.alicuota_iva}%</Dato>
            <Dato etiqueta="Proveedor">{a.proveedor}</Dato>
            <Dato etiqueta="Ubicación">{a.ubicacion}</Dato>
          </dl>
        </Tarjeta>
        {costos && costos.historial.length > 0 && (
          <Tarjeta titulo="Historial de costos" subtitulo="Cada cambio del costo queda registrado, venga de una compra, una recepción o una edición" className="lg:col-span-3" sinPadding>
            <ul className="divide-y divide-borde text-sm">
              {costos.historial.map((h: any) => (
                <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                  <span>{fechaHora(h.created_at)} <span className="text-tenue">· {h.origen === 'inicial' || h.origen === 'alta' ? 'Costo inicial' : h.origen?.startsWith('compra:') ? 'Compra' : h.origen?.startsWith('recepcion:') ? 'Recepción de orden de compra' : 'Edición / ajuste'}</span></span>
                  <span className="tabular-nums">{h.costo_anterior != null ? <span className="text-tenue">{money(h.costo_anterior)} → </span> : null}<strong>{money(h.costo_nuevo)}</strong></span>
                </li>
              ))}
            </ul>
          </Tarjeta>
        )}
        {precios.length > 0 && (
          <Tarjeta titulo="Precio por lista" className="lg:col-span-3" sinPadding>
            <ul className="divide-y divide-borde text-sm">
              {precios.map((p: any) => <li key={p.lista_id} className="flex justify-between px-4 py-2"><span>{p.nombre} {p.precio_origen === 'fijo' && <Insignia tono="ambar">Fijo</Insignia>}</span><span className="font-medium tabular-nums">{money(p.precio_lista)}</span></li>)}
            </ul>
          </Tarjeta>
        )}
      </div>
      {editar && <FormArticulo inicial={a} onCerrar={() => setEditar(false)} />}
      {mov && <ModalMovimiento articulo={a} onCerrar={() => setMov(false)} />}
    </>
  );
}
