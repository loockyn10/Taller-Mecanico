// Reposición: artículos en o bajo el stock mínimo, agrupados por proveedor, con la cantidad sugerida para comprar.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Download, PackageCheck, ShoppingCart } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { descargarCSV, pesosCSV } from '@/lib/csv';
import { cantidad, money } from '@/lib/format';
import { Aviso, Boton, Cargando, Check, Encabezado, ErrorCaja, Input, Insignia, Tarjeta, Vacio } from '@/components/ui';

export function Reposicion() {
  const nav = useNavigate();
  const { puede } = useAuth();
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['reposicion'], queryFn: () => api.get<any[]>('/reposicion') });
  const [sel, setSel] = useState<Record<string, number>>({});
  const [cant, setCant] = useState<Record<string, number>>({});
  const grupos = useMemo(() => {
    const m = new Map<string, { id: string | null; nombre: string; items: any[] }>();
    for (const a of data) {
      const k = a.proveedor_id ?? '';
      if (!m.has(k)) m.set(k, { id: a.proveedor_id, nombre: a.proveedor ?? 'Sin proveedor asignado', items: [] });
      m.get(k)!.items.push(a);
    }
    return [...m.values()];
  }, [data]);
  const cantidadDe = (a: any) => cant[a.id] ?? a.sugerido;
  const seleccionados = data.filter((a) => a.id in sel);
  const sinStock = data.filter((a) => a.stock <= 0).length;

  const armarCompra = (items: any[], proveedorId: string | null) =>
    nav('/compras/nueva', { state: { precarga: { proveedor_id: proveedorId, items: items.map((a) => ({ articulo: { id: a.id, nombre: a.nombre, codigo: a.codigo, costo: a.costo, stock: a.stock }, cantidad: cantidadDe(a), costo: a.costo })) } } });

  return (
    <>
      <Encabezado
        titulo="Reposición"
        subtitulo="Artículos con stock igual o inferior al mínimo"
        acciones={data.length > 0 && (
          <Boton icono={<Download className="size-4" />} onClick={() => descargarCSV('reposicion', ['Artículo', 'Código', 'Proveedor', 'Stock', 'Mínimo', 'Sugerido', 'Costo unitario'], data.map((a) => [a.nombre, a.codigo ?? '', a.proveedor ?? '', a.stock, a.stock_minimo, cantidadDe(a), pesosCSV(a.costo)]))}>Exportar CSV</Boton>
        )}
      />
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : data.length === 0 ? (
        <Tarjeta><Vacio icono={<PackageCheck className="size-5" />} titulo="Todo el stock está por encima del mínimo" texto="Definí el stock mínimo de cada artículo para que aparezca acá cuando haya que reponer." /></Tarjeta>
      ) : (
        <div className="space-y-5">
          {sinStock > 0 && <Aviso tono="rojo">{sinStock} artículo(s) sin stock.</Aviso>}
          {grupos.map((g) => {
            const marcados = g.items.filter((a) => a.id in sel);
            return (
              <Tarjeta
                key={g.id ?? 'sin'}
                titulo={g.nombre}
                subtitulo={`${g.items.length} artículo(s)`}
                sinPadding
                acciones={puede('compras.gestionar') && (
                  <>
                    <Check checked={marcados.length === g.items.length} onChange={(v) => setSel((s) => { const n = { ...s }; g.items.forEach((a) => (v ? (n[a.id] = 1) : delete n[a.id])); return n; })} label="Todos" />
                    <Boton variante="primario" tam="sm" icono={<ShoppingCart className="size-4" />} onClick={() => armarCompra(marcados.length ? marcados : g.items, g.id)}>
                      Armar compra{marcados.length ? ` (${marcados.length})` : ''}
                    </Boton>
                  </>
                )}
              >
                <ul className="divide-y divide-borde">
                  {g.items.map((a) => (
                    <li key={a.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-2.5 text-sm">
                      {puede('compras.gestionar') ? <input type="checkbox" className="size-4 accent-marca-600" checked={a.id in sel} onChange={(e) => setSel((s) => { const n = { ...s }; if (e.target.checked) n[a.id] = 1; else delete n[a.id]; return n; })} aria-label={`Seleccionar ${a.nombre}`} /> : <span />}
                      <div className="min-w-0">
                        <div className="truncate font-medium">{a.nombre}</div>
                        <div className="text-xs text-tenue">{[a.codigo, a.marca].filter(Boolean).join(' · ')}</div>
                      </div>
                      <div className="flex items-center gap-3 text-right">
                        <div>
                          <div className={a.stock <= 0 ? 'font-semibold text-red-600' : 'font-semibold text-amber-700'}>{cantidad(a.stock)} {a.unidad}</div>
                          <div className="text-xs text-tenue">mín. {cantidad(a.stock_minimo)} · ideal {cantidad(a.objetivo)}</div>
                        </div>
                        <label className="flex flex-col items-end text-xs text-tenue">Reponer
                          <Input type="number" min={0} step="any" value={cantidadDe(a)} onChange={(e) => setCant({ ...cant, [a.id]: Math.max(0, Math.round(Number(e.target.value) * 1000) / 1000) })} className="h-8 w-20 text-right" />
                        </label>
                        <div className="hidden w-24 sm:block"><div className="text-xs text-tenue">Costo</div><div className="tabular-nums">{money(a.costo)}</div></div>
                      </div>
                    </li>
                  ))}
                </ul>
              </Tarjeta>
            );
          })}
          {seleccionados.length > 0 && (
            <div className="flex items-center justify-between rounded-xl border border-marca-200 bg-marca-50 px-4 py-3 text-sm">
              <span><Insignia tono="azul">{seleccionados.length}</Insignia> seleccionado(s) de distintos proveedores: armá la compra grupo por grupo.</span>
              <Boton tam="sm" onClick={() => setSel({})}>Limpiar selección</Boton>
            </div>
          )}
        </div>
      )}
    </>
  );
}
