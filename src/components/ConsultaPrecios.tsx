// Consulta rápida de precios: ventana sobre la pantalla actual. Busca por nombre, marca, SKU o código de barras (un lector USB escribe el código
// y termina con Enter, así que alcanza con tener el cursor en el buscador). Todo sale de los artículos, las listas y las existencias reales.
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Barcode, PackageSearch } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cantidad, money } from '@/lib/format';
import { Aviso, Campo, Cargando, ErrorCaja, Input, Insignia, Modal, Select, useDebounce } from './ui';
import { useListas } from './SelectorLista';

export interface ResultadoPrecio {
  id: string;
  codigo?: string | null;
  codigo_barras?: string | null;
  nombre: string;
  marca?: string | null;
  unidad: string;
  categoria?: string | null;
  stock?: number;
  stock_minimo?: number;
  stock_bajo?: boolean;
  depositos?: Array<{ deposito: string; stock: number }>;
  precio?: number | null;
  sin_precio?: boolean;
  precio_origen?: 'base' | 'fijo' | 'regla';
  costo?: number;
}

interface Respuesta { items: ResultadoPrecio[]; lista: { id: string; nombre: string } | null; hay_mas: boolean }

/** Búsqueda de artículos con precio, stock y (si hay permiso) costo. La usan el modal de consulta y el carrito de operaciones rápidas. */
export function useBuscarArticulos(texto: string, listaId: string, habilitado = true) {
  return useQuery({
    queryKey: ['consulta-precios', texto, listaId],
    queryFn: () => api.get<Respuesta>(`/rapidas/consulta-precios${qs({ q: texto, lista_id: listaId || undefined })}`),
    enabled: habilitado && texto.trim().length > 0,
    placeholderData: (previo) => previo,
  });
}

export function ConsultaPrecios({ abierto, onCerrar }: { abierto: boolean; onCerrar: () => void }) {
  const { puede } = useAuth();
  const verPrecio = puede('precios.venta.ver');
  const { data: listas = [] } = useListas();
  const [q, setQ] = useState('');
  const [enviada, setEnviada] = useState('');
  const [lista, setLista] = useState('');
  const [listaElegida, setListaElegida] = useState(false);
  const entrada = useRef<HTMLInputElement>(null);
  const dq = useDebounce(q, 200);
  // La lista predeterminada del taller se preselecciona una sola vez.
  useEffect(() => {
    if (abierto && !listaElegida && listas.length) setLista(listas.find((l) => l.es_default)?.id ?? '');
  }, [abierto, listas, listaElegida]);
  useEffect(() => {
    if (!abierto) return;
    setQ('');
    setEnviada('');
    // Foco automático: el cursor ya está donde escribe el lector de códigos.
    const t = setTimeout(() => entrada.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [abierto]);
  const texto = (enviada || dq).trim();
  const { data, isFetching, error, refetch } = useBuscarArticulos(texto, lista, abierto && (puede('catalogo.ver')));
  const items = texto ? data?.items ?? [] : [];

  return (
    <Modal abierto={abierto} onCerrar={onCerrar} titulo="Consultar precios" ancho="lg">
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <div className="relative">
            <Barcode className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
            <Input
              ref={entrada}
              value={q}
              onChange={(e) => { setQ(e.target.value); setEnviada(''); }}
              onKeyDown={(e) => {
                // Enter (lo que envía el lector al terminar el código) busca en el acto y deja el texto seleccionado: el próximo escaneo lo reemplaza.
                if (e.key === 'Enter') {
                  e.preventDefault();
                  setEnviada(q.trim());
                  e.currentTarget.select();
                }
              }}
              placeholder="Nombre, marca, SKU o código de barras"
              className="pl-9"
              inputMode="search"
              enterKeyHint="search"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-label="Buscar artículo"
            />
          </div>
          {verPrecio && listas.length > 0 && (
            <Campo className="sm:w-56">
              <Select value={lista} onChange={(e) => { setLista(e.target.value); setListaElegida(true); }} aria-label="Lista de precios">
                <option value="">Precio base</option>
                {listas.map((l) => <option key={l.id} value={l.id}>{l.nombre}{l.es_default ? ' (predeterminada)' : ''}</option>)}
              </Select>
            </Campo>
          )}
        </div>

        {!texto ? (
          <p className="flex items-center gap-2 py-6 text-sm text-tenue"><PackageSearch className="size-5 shrink-0" />Escribí o escaneá un código para ver precio y stock al instante.</p>
        ) : error ? (
          <ErrorCaja error={error} reintentar={refetch} />
        ) : !data ? (
          <Cargando />
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-sm text-tenue">{isFetching ? 'Buscando…' : `No hay artículos para «${texto}».`}</p>
        ) : (
          <ul className="divide-y divide-borde rounded-card border border-borde" aria-live="polite">
            {items.map((a) => <FilaResultado key={a.id} a={a} />)}
          </ul>
        )}
        {data?.hay_mas && <Aviso tono="ambar">Hay más resultados: escribí más letras o el código completo para acotar.</Aviso>}
        {!verPrecio && <p className="text-xs text-tenue">Tu usuario no tiene permiso para ver precios de venta.</p>}
      </div>
    </Modal>
  );
}

export function FilaResultado({ a, acciones }: { a: ResultadoPrecio; acciones?: React.ReactNode }) {
  const sinStock = a.stock != null && a.stock <= 0;
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-3 sm:px-4">
      <div className="min-w-0 flex-1 basis-56">
        <div className="break-words font-semibold leading-snug">{a.nombre}</div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-tenue">
          {a.marca && <span>{a.marca}</span>}
          {a.codigo && <span>SKU {a.codigo}</span>}
          {a.codigo_barras && <span>CB {a.codigo_barras}</span>}
          {a.categoria && <span>{a.categoria}</span>}
        </div>
        {a.stock != null && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Insignia tono={sinStock ? 'rojo' : a.stock_bajo ? 'ambar' : 'verde'}>{sinStock ? 'Sin stock' : `Stock ${cantidad(a.stock)} ${a.unidad}`}</Insignia>
            {(a.depositos?.length ?? 0) > 1 && a.depositos!.map((d) => <span key={d.deposito} className="text-xs text-tenue">{d.deposito}: {cantidad(d.stock)}</span>)}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3 text-right">
        <div>
          {a.sin_precio === true ? (
            <Insignia tono="ambar">Sin precio configurado</Insignia>
          ) : a.precio != null ? (
            <div className="text-lg font-bold tabular-nums">{money(a.precio)}</div>
          ) : null}
          {a.costo != null && <div className="text-xs text-tenue">Costo {money(a.costo)}</div>}
        </div>
        {acciones}
      </div>
    </li>
  );
}
