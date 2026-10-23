// Selectores del catálogo automotor: combobox con búsqueda (sin tildes ni mayúsculas) que siempre permite escribir a mano.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { cn, Input } from './ui';
import { claveBusqueda, type CatMarca, type CatModelo, type CatVersion } from '@shared/catalogo-auto';

export interface Opcion {
  id: string;
  nombre: string;
  clave: string;
  /** Otras escrituras que también deben encontrarla (ya normalizadas). */
  busqueda?: string | null;
  detalle?: string;
}

const MAX = 60;

/**
 * Campo de texto con lista de sugerencias. El texto escrito ES el valor: elegir una sugerencia sólo lo completa con el nombre canónico,
 * así lo que no está en el catálogo se puede registrar a mano sin pasos extra. La lista va en el flujo de la página (no flotante)
 * para que no la recorte un modal ni se salga de la pantalla en celulares.
 */
export function Combobox({ valor, onTexto, onElegir, opciones, placeholder, disabled, cargando, vacio, autoFocus }: {
  valor: string;
  onTexto: (t: string) => void;
  onElegir: (o: Opcion) => void;
  opciones: Opcion[];
  placeholder?: string;
  disabled?: boolean;
  cargando?: boolean;
  vacio?: string;
  autoFocus?: boolean;
}) {
  const [abierto, setAbierto] = useState(false);
  const [tocado, setTocado] = useState(false);
  const [activo, setActivo] = useState(0);
  const cierre = useRef<ReturnType<typeof setTimeout>>();
  const lista = useRef<HTMLDivElement>(null);
  const q = claveBusqueda(valor);

  const visibles = useMemo(() => {
    if (!tocado || !q) return opciones.slice(0, MAX);
    const hit = opciones.filter((o) => o.clave.includes(q) || (o.busqueda ?? '').includes(q));
    return [...hit.filter((o) => o.clave.startsWith(q) || (o.busqueda ?? '').startsWith(q)), ...hit.filter((o) => !(o.clave.startsWith(q) || (o.busqueda ?? '').startsWith(q)))].slice(0, MAX);
  }, [opciones, q, tocado]);
  const exacta = opciones.some((o) => o.clave === q);

  useEffect(() => setActivo(0), [q, abierto]);
  useEffect(() => {
    lista.current?.querySelector<HTMLElement>('[data-activo="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activo]);
  useEffect(() => () => clearTimeout(cierre.current), []);

  const elegir = (o: Opcion) => {
    onElegir(o);
    setAbierto(false);
    setTocado(false);
  };

  return (
    <div className="min-w-0">
      <Input
        value={valor}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={abierto}
        aria-autocomplete="list"
        autoComplete="off"
        autoCapitalize="words"
        onFocus={() => {
          clearTimeout(cierre.current);
          setAbierto(true);
          setTocado(false);
        }}
        onBlur={() => (cierre.current = setTimeout(() => setAbierto(false), 120))}
        onChange={(e) => {
          onTexto(e.target.value);
          setTocado(true);
          setAbierto(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setAbierto(true);
            setActivo((a) => Math.min(a + 1, visibles.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActivo((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter' && abierto && tocado && visibles[activo] && !exacta) {
            e.preventDefault();
            elegir(visibles[activo]);
          } else if (e.key === 'Escape' && abierto) {
            e.stopPropagation();
            setAbierto(false);
          }
        }}
      />
      {abierto && !disabled && (
        <div ref={lista} role="listbox" className="mt-1 max-h-60 overflow-y-auto overscroll-contain rounded-ctl border border-borde bg-white shadow-sm">
          {cargando ? (
            <p className="px-3 py-2.5 text-sm text-tenue">Cargando…</p>
          ) : visibles.length === 0 ? (
            <p className="flex items-start gap-2 px-3 py-2.5 text-sm text-tenue">
              <Search className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 break-words">{valor.trim() ? `«${valor.trim()}» no está en el catálogo: se guarda tal como lo escribiste.` : (vacio ?? 'Sin opciones: escribilo a mano.')}</span>
            </p>
          ) : (
            visibles.map((o, i) => (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={o.clave === q}
                data-activo={i === activo}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => elegir(o)}
                className={cn('flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-marca-50', i === activo && 'bg-marca-50')}
              >
                <span className="min-w-0 flex-1 break-words">{o.nombre}</span>
                {o.detalle && <span className="max-w-[45%] shrink-0 text-right text-xs text-tenue">{o.detalle}</span>}
                {o.clave === q && <Check className="size-4 shrink-0 text-marca-600" />}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ───────────── Datos del catálogo (D1, sin servicios externos; se reutilizan en el navegador) ─────────────
const UNA_HORA = 3_600_000;

export const useCatMarcas = () => useQuery({ queryKey: ['cat-marcas'], queryFn: () => api.get<CatMarca[]>('/catalogo-auto/marcas'), staleTime: UNA_HORA });
export const useCatModelos = (marcaId: string | null) =>
  useQuery({ queryKey: ['cat-modelos', marcaId], queryFn: () => api.get<CatModelo[]>(`/catalogo-auto/marcas/${marcaId}/modelos`), enabled: !!marcaId, staleTime: UNA_HORA });
export const useCatModelo = (modeloId: string | null) =>
  useQuery({ queryKey: ['cat-modelo', modeloId], queryFn: () => api.get<{ id: string; anios: number[]; fichas: number; versiones: CatVersion[] }>(`/catalogo-auto/modelos/${modeloId}`), enabled: !!modeloId, staleTime: UNA_HORA });

export const rangoAnios = (a: number[]) => (a.length === 0 ? undefined : a[0] === a[a.length - 1] ? String(a[0]) : `${a[0]}–${a[a.length - 1]}`);
