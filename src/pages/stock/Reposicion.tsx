// Reposición: artículos en o bajo el stock mínimo, agrupados por proveedor, con la cantidad sugerida para comprar.
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, Download, PackageCheck, ShoppingCart } from 'lucide-react';
import { api, nuevaClave } from '@/lib/api';
import { invalidarDinero } from '@/lib/caja';
import { useAuth } from '@/lib/auth';
import { descargarCSV, pesosCSV } from '@/lib/csv';
import { cantidad, money } from '@/lib/format';
import { Aviso, Boton, Cargando, Check, Encabezado, ErrorCaja, Input, Insignia, Select, Tarjeta, useToast, Vacio } from '@/components/ui';
import { useDepositos } from '@/components/SelectorDeposito';

export function Reposicion() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useAuth();
  const [clave, setClave] = useState(nuevaClave());
  const { data: depositos = [] } = useDepositos();
  const [vista, setVista] = useState('');
  const porDeposito = vista !== '';
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['reposicion', vista], queryFn: () => api.get<any[]>(`/reposicion${vista ? `?deposito_id=${vista}` : ''}`) });
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
  const clave_fila = (a: any) => (a.deposito_id ? `${a.id}@${a.deposito_id}` : a.id);
  const cantidadDe = (a: any) => cant[clave_fila(a)] ?? a.sugerido;
  const seleccionados = data.filter((a) => clave_fila(a) in sel);
  const sinStock = data.filter((a) => a.stock <= 0).length;

  const generarOrden = useMutation({
    mutationFn: (items: any[]) => {
      // Una orden de compra no tiene depósito: si el mismo artículo falta en varios depósitos se pide la suma (el destino se elige al recibir).
      const suma = new Map<string, number>();
      for (const a of items) if (cantidadDe(a) > 0) suma.set(a.id, Math.round(((suma.get(a.id) ?? 0) + cantidadDe(a)) * 1000) / 1000);
      return api.post('/reposicion/ordenes', { items: [...suma].map(([articulo_id, cantidad]) => ({ articulo_id, cantidad })), emitir: false, idem_key: clave });
    },
    onSuccess: (r: any) => {
      invalidarDinero(qc);
      setClave(nuevaClave());
      toast.ok(r.ordenes.length === 1 ? `Orden de compra #${r.ordenes[0].numero} creada en borrador` : `${r.ordenes.length} órdenes de compra creadas en borrador`);
      nav(r.ordenes.length === 1 ? `/ordenes-compra/${r.ordenes[0].id}` : '/ordenes-compra');
    },
    onError: toast.error,
  });

  const armarCompra = (items: any[], proveedorId: string | null) =>
    nav('/compras/nueva', { state: { precarga: { proveedor_id: proveedorId, items: [...items.reduce((m, a) => m.set(a.id, { articulo: { id: a.id, nombre: a.nombre, codigo: a.codigo, costo: a.costo, stock: a.stock_total ?? a.stock }, cantidad: Math.round(((m.get(a.id)?.cantidad ?? 0) + cantidadDe(a)) * 1000) / 1000, costo: a.costo }), new Map<string, any>()).values()] } } });

  return (
    <>
      <Encabezado
        titulo="Reposición"
        subtitulo="Artículos con stock igual o inferior al mínimo"
        acciones={data.length > 0 && (
          <Boton icono={<Download className="size-4" />} onClick={() => descargarCSV('reposicion', ['Artículo', 'Código', 'Proveedor', 'Stock', 'Mínimo', 'Sugerido', 'Costo unitario'], data.map((a) => [a.nombre, a.codigo ?? '', a.proveedor ?? '', a.stock, a.stock_minimo, cantidadDe(a), pesosCSV(a.costo)]))}>Exportar CSV</Boton>
        )}
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={vista} onChange={(e) => { setVista(e.target.value); setSel({}); setCant({}); }} className="w-auto" aria-label="Vista de reposición">
          <option value="">Mínimo general (sobre el stock total)</option>
          {depositos.filter((d) => d.activo).map((d) => <option key={d.id} value={d.id}>Mínimos del depósito: {d.nombre}</option>)}
          {depositos.filter((d) => d.activo).length > 1 && <option value="todos">Mínimos de todos los depósitos</option>}
        </Select>
        {porDeposito && <span className="text-sm text-tenue">Alertas según el stock mínimo configurado en cada depósito (ficha del artículo).</span>}
      </div>
      <Aviso className="mb-4">La cantidad sugerida llega hasta el stock ideal descontando lo que ya está pedido en órdenes de compra abiertas. “Generar orden de compra” crea una orden en borrador por proveedor; “Registrar compra” carga directamente la compra con su comprobante.</Aviso>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : data.length === 0 ? (
        <Tarjeta><Vacio icono={<PackageCheck className="size-5" />} titulo="Todo el stock está por encima del mínimo" texto="Definí el stock mínimo de cada artículo para que aparezca acá cuando haya que reponer." /></Tarjeta>
      ) : (
        <div className="space-y-5">
          {sinStock > 0 && <Aviso tono="rojo">{sinStock} artículo(s) sin stock.</Aviso>}
          {grupos.map((g) => {
            const marcados = g.items.filter((a) => clave_fila(a) in sel);
            return (
              <Tarjeta
                key={g.id ?? 'sin'}
                titulo={g.nombre}
                subtitulo={`${g.items.length} artículo(s)`}
                sinPadding
                acciones={puede('compras.gestionar') && (
                  <>
                    <Check checked={marcados.length === g.items.length} onChange={(v) => setSel((s) => { const n = { ...s }; g.items.forEach((a) => (v ? (n[clave_fila(a)] = 1) : delete n[clave_fila(a)])); return n; })} label="Todos" />
                    {g.id && <Boton variante="primario" tam="sm" icono={<ClipboardList className="size-4" />} cargando={generarOrden.isPending} onClick={() => generarOrden.mutate(marcados.length ? marcados : g.items)}>Generar orden de compra{marcados.length ? ` (${marcados.length})` : ''}</Boton>}
                    <Boton tam="sm" icono={<ShoppingCart className="size-4" />} onClick={() => armarCompra(marcados.length ? marcados : g.items, g.id)}>
                      Registrar compra{marcados.length ? ` (${marcados.length})` : ''}
                    </Boton>
                  </>
                )}
              >
                <ul className="divide-y divide-borde">
                  {g.items.map((a) => (
                    <li key={clave_fila(a)} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-2.5 text-sm">
                      {puede('compras.gestionar') ? <input type="checkbox" className="size-4 accent-marca-600" checked={clave_fila(a) in sel} onChange={(e) => setSel((s) => { const n = { ...s }; if (e.target.checked) n[clave_fila(a)] = 1; else delete n[clave_fila(a)]; return n; })} aria-label={`Seleccionar ${a.nombre}`} /> : <span />}
                      <div className="min-w-0">
                        <div className="truncate font-medium">{a.nombre}</div>
                        <div className="text-xs text-tenue">{[a.codigo, a.marca].filter(Boolean).join(' · ')}{a.deposito ? <Insignia tono="azul" className="ml-2">{a.deposito}</Insignia> : null}</div>
                      </div>
                      <div className="flex items-center gap-3 text-right">
                        <div>
                          <div className={a.stock <= 0 ? 'font-semibold text-red-600' : 'font-semibold text-amber-700'}>{cantidad(a.stock)} {a.unidad}</div>
                          <div className="text-xs text-tenue">mín. {cantidad(a.stock_minimo)} · ideal {cantidad(a.objetivo)}{a.en_camino > 0 ? <span className="text-marca-700"> · pedido {cantidad(a.en_camino)}</span> : null}</div>
                        </div>
                        <label className="flex flex-col items-end text-xs text-tenue">Reponer
                          <Input type="number" min={0} step="any" value={cantidadDe(a)} onChange={(e) => setCant({ ...cant, [clave_fila(a)]: Math.max(0, Math.round(Number(e.target.value) * 1000) / 1000) })} className="h-8 w-20 text-right" />
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
