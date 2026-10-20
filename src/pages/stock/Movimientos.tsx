import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Boxes, Download } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { cantidad, fechaHora } from '@/lib/format';
import { descargarCSV } from '@/lib/csv';
import { Boton, Buscador, Cargando, Encabezado, ErrorCaja, Input, Select, Tabla, Tarjeta, useDebounce, Vacio } from '@/components/ui';
import { TIPOS_MOVIMIENTO_STOCK_LABEL } from '@shared/dominio';

function origen(m: any) {
  if (m.origen_tipo === 'orden') return <Link className="text-marca-700" to={`/ordenes/${m.origen_id}`}>{m.notas ?? 'OT'}</Link>;
  if (m.origen_tipo === 'venta') return <Link className="text-marca-700" to={`/ventas/${m.origen_id}`}>Venta</Link>;
  if (m.origen_tipo === 'compra') return <Link className="text-marca-700" to={`/compras?ver=${m.origen_id}`}>{m.notas ?? 'Compra'}</Link>;
  return m.notas ?? '—';
}

export function Movimientos() {
  const [tipo, setTipo] = useState('');
  const [q, setQ] = useState('');
  const [articuloId, setArticuloId] = useState<{ id: string; nombre: string } | null>(null);
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const dq = useDebounce(q);
  // Búsqueda de artículo para filtrar el libro de movimientos.
  const { data: sugeridos = [] } = useQuery({ queryKey: ['articulos', { q: dq, mov: 1 }], queryFn: () => api.get<any[]>(`/articulos?limite=8&q=${encodeURIComponent(dq)}`), enabled: dq.length >= 2 && !articuloId });
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['movimientos', { tipo, articuloId: articuloId?.id, desde, hasta }], queryFn: () => api.get<any[]>(`/stock/movimientos${qs({ tipo, articulo_id: articuloId?.id, desde, hasta })}`) });
  return (
    <>
      <Encabezado
        titulo="Movimientos de stock"
        subtitulo="Cada entrada y salida queda registrada con su origen; el stock solo cambia mediante movimientos"
        acciones={data.length > 0 && <Boton icono={<Download className="size-4" />} onClick={() => descargarCSV('movimientos-stock', ['Fecha', 'Artículo', 'Tipo', 'Cantidad', 'Stock resultante', 'Detalle'], data.map((m) => [m.created_at, m.articulo, TIPOS_MOVIMIENTO_STOCK_LABEL[m.tipo] ?? m.tipo, m.cantidad, m.stock_resultante, m.notas ?? '']))}>CSV</Boton>}
      />
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="relative min-w-56 flex-1">
          {articuloId ? (
            <div className="flex h-10 items-center justify-between rounded-lg border border-marca-300 bg-marca-50 px-3 text-sm"><span className="truncate font-medium">{articuloId.nombre}</span><button type="button" className="ml-2 text-marca-700 underline" onClick={() => { setArticuloId(null); setQ(''); }}>Quitar</button></div>
          ) : (
            <>
              <Buscador value={q} onChange={setQ} placeholder="Filtrar por artículo…" />
              {sugeridos.length > 0 && (
                <ul className="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-borde bg-white text-sm shadow-lg">
                  {sugeridos.map((a) => <li key={a.id}><button type="button" className="w-full px-3 py-2 text-left hover:bg-marca-50" onClick={() => { setArticuloId({ id: a.id, nombre: a.nombre }); setQ(''); }}>{a.nombre} <span className="text-tenue">{a.codigo ?? ''}</span></button></li>)}
                </ul>
              )}
            </>
          )}
        </div>
        <Select value={tipo} onChange={(e) => setTipo(e.target.value)} className="w-auto" aria-label="Tipo de movimiento">
          <option value="">Todos los tipos</option>
          {Object.entries(TIPOS_MOVIMIENTO_STOCK_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className="w-auto" aria-label="Desde" />
        <Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className="w-auto" aria-label="Hasta" />
      </div>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={data}
            clave={(m) => m.id}
            vacio={<Vacio icono={<Boxes className="size-5" />} titulo="Sin movimientos con esos filtros" />}
            columnas={[
              { clave: 'f', titulo: 'Fecha', render: (m) => fechaHora(m.created_at), movil: 'meta' },
              { clave: 'a', titulo: 'Artículo', render: (m) => <Link to={`/articulos/${m.articulo_id}`} className="font-medium text-marca-700">{m.articulo}</Link>, movil: 'titulo' },
              { clave: 't', titulo: 'Tipo', render: (m) => TIPOS_MOVIMIENTO_STOCK_LABEL[m.tipo] ?? m.tipo, movil: 'subtitulo' },
              { clave: 'o', titulo: 'Origen', render: origen, movil: 'meta' },
              { clave: 'u', titulo: 'Usuario', render: (m) => m.usuario ?? '—', movil: 'oculta' },
              { clave: 'c', titulo: 'Cantidad', alinear: 'derecha', render: (m) => <span className={m.cantidad < 0 ? 'text-red-600' : 'text-emerald-700'}>{m.cantidad > 0 ? '+' : ''}{cantidad(m.cantidad)}</span>, movil: 'derecha' },
              { clave: 's', titulo: 'Stock resultante', alinear: 'derecha', render: (m) => cantidad(m.stock_resultante), movil: 'meta' },
            ]}
          />
        </Tarjeta>
      )}
    </>
  );
}
