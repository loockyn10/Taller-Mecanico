import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Boxes } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { cantidad, fechaHora } from '@/lib/format';
import { Cargando, Encabezado, ErrorCaja, Select, Tabla, Tarjeta, Vacio } from '@/components/ui';
import { TIPOS_MOVIMIENTO_STOCK_LABEL } from '@shared/dominio';

export function Movimientos() {
  const [tipo, setTipo] = useState('');
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['movimientos', tipo], queryFn: () => api.get<any[]>(`/stock/movimientos${qs({ tipo })}`) });
  return (
    <>
      <Encabezado titulo="Movimientos de stock" subtitulo="Cada entrada y salida queda registrada con su origen; el stock solo cambia mediante movimientos" />
      <Select value={tipo} onChange={(e) => setTipo(e.target.value)} className="mb-4 w-auto">
        <option value="">Todos los tipos</option>
        {Object.entries(TIPOS_MOVIMIENTO_STOCK_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </Select>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={data}
            clave={(m) => m.id}
            vacio={<Vacio icono={<Boxes className="size-5" />} titulo="Sin movimientos" />}
            columnas={[
              { clave: 'f', titulo: 'Fecha', render: (m) => fechaHora(m.created_at), movil: 'meta' },
              { clave: 'a', titulo: 'Artículo', render: (m) => <Link to={`/articulos/${m.articulo_id}`} className="font-medium text-marca-700">{m.articulo}</Link>, movil: 'titulo' },
              { clave: 't', titulo: 'Tipo', render: (m) => TIPOS_MOVIMIENTO_STOCK_LABEL[m.tipo] ?? m.tipo, movil: 'subtitulo' },
              { clave: 'o', titulo: 'Origen', render: (m) => (m.origen_tipo === 'orden' ? <Link className="text-marca-700" to={`/ordenes/${m.origen_id}`}>{m.notas ?? 'OT'}</Link> : m.origen_tipo === 'venta' ? <Link className="text-marca-700" to={`/ventas/${m.origen_id}`}>Venta</Link> : m.notas ?? '—'), movil: 'meta' },
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
