// Explorador del catálogo automotor: marcas, modelos, años, versiones y motorizaciones (DNRPA, compartido por todos los talleres) con la ficha de cada versión.
// Lo que el registro no informa (especificaciones técnicas, manuales) se muestra como "Sin datos verificados": nunca se inventa ni se completa con suposiciones.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { BookOpen, Car, CircleSlash, ExternalLink, FileText, Gauge, Plus, Search, Wrench } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Aviso, Boton, Buscador, Campo, Cargando, Dato, Encabezado, ErrorCaja, Insignia, Modal, Select, Tarjeta, useDebounce, useToast, Vacio } from '@/components/ui';
import { FormVehiculo, SelectorCliente } from '@/components/selectores';
import { rangoAnios, useCatModelo } from '@/components/CatalogoAuto';
import { claveBusqueda, type CatVersion } from '@shared/catalogo-auto';

// ───────────── Tipos de las respuestas ─────────────
interface ModeloResumen {
  id: string;
  nombre: string;
  marca_id: string;
  marca: string;
  tipo: string | null;
  anios: number[];
  n: number;
  versiones: number;
}
interface Busqueda {
  total: number;
  desde: number;
  modelos: ModeloResumen[];
  facetas: { marcas: Array<{ id: string; nombre: string; n: number }>; modelos: Array<{ id: string; nombre: string; marca_id: string; marca: string }>; anios: number[] };
}
interface FichaTecnica {
  id: string;
  version_id: string | null;
  motorizacion: string | null;
  anio_desde: number | null;
  anio_hasta: number | null;
  codigo_motor: string | null;
  aceite_recomendado: string | null;
  aceite_capacidad_l: number | null;
  refrigerante: string | null;
  filtros: Record<string, unknown> | null;
  distribucion: string | null;
  intervalos: Record<string, unknown> | null;
  documentacion_url: string | null;
  fuente: string;
  fecha_verificacion: string;
  notas: string | null;
}

const PAGINA = 24;
const VERSIONES_VISIBLES = 40;
const SIN_DATOS = 'Sin datos verificados';

/** Ancho de escritorio: ahí la ficha va al costado; en tablet y celular se abre en una ventana a pantalla completa. */
function useEscritorio() {
  const consulta = '(min-width: 1024px)';
  const [si, setSi] = useState(() => typeof window !== 'undefined' && window.matchMedia(consulta).matches);
  useEffect(() => {
    const m = window.matchMedia(consulta);
    const h = () => setSi(m.matches);
    m.addEventListener('change', h);
    return () => m.removeEventListener('change', h);
  }, []);
  return si;
}

const textoVersion = (v: CatVersion) => v.version ?? v.descripcion;

/** Combustible del registro → opción del formulario de vehículos. */
function combustibleForm(c: string | null): string {
  const k = claveBusqueda(c ?? '');
  if (k.includes('dies')) return 'Diésel';
  if (k.includes('hibrid')) return 'Híbrido';
  if (k.includes('electric')) return 'Eléctrico';
  return '';
}

// ───────────── Pantalla ─────────────
export function CatalogoAutomotor() {
  const [sp, setSp] = useSearchParams();
  const escritorio = useEscritorio();
  const marca = sp.get('marca') ?? '';
  const modelo = sp.get('modelo') ?? '';
  const anio = sp.get('anio') ?? '';
  const version = sp.get('version') ?? '';
  const motor = sp.get('motor') ?? '';
  const [texto, setTexto] = useState(sp.get('q') ?? '');
  const q = useDebounce(texto.trim(), 250);

  /** Cambia filtros en la dirección (se puede compartir y funciona el botón Atrás). Un valor vacío quita el filtro. */
  const poner = (cambios: Record<string, string>, reemplazar = true) =>
    setSp(
      (actual) => {
        const n = new URLSearchParams(actual);
        for (const [k, v] of Object.entries(cambios)) v ? n.set(k, v) : n.delete(k);
        return n;
      },
      { replace: reemplazar },
    );
  useEffect(() => {
    if (q !== (sp.get('q') ?? '')) poner({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const busqueda = useInfiniteQuery({
    queryKey: ['cat-buscar', { q, marca, anio }],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.get<Busqueda>(`/catalogo-auto/buscar?${new URLSearchParams(Object.entries({ q, marca, anio, limite: String(PAGINA), desde: String(pageParam) }).filter(([, v]) => v))}`),
    getNextPageParam: (ult) => (ult.desde + ult.modelos.length < ult.total ? ult.desde + ult.modelos.length : undefined),
    staleTime: 3_600_000,
    placeholderData: (prev) => prev,
  });
  const paginas = busqueda.data?.pages ?? [];
  const facetas = paginas[0]?.facetas;
  const total = paginas[0]?.total ?? 0;
  const resultados = paginas.flatMap((p) => p.modelos);

  const { data: detalle, isLoading: cargandoModelo, error: errorModelo } = useCatModelo(modelo || null);
  const { data: fichas = [] } = useQuery({ queryKey: ['cat-fichas', modelo], queryFn: () => api.get<FichaTecnica[]>(`/catalogo-auto/modelos/${modelo}/fichas`), enabled: !!modelo, staleTime: 3_600_000 });
  const { data: info } = useQuery({ queryKey: ['cat-info'], queryFn: () => api.get<Record<string, string>>('/catalogo-auto/info'), staleTime: 3_600_000 });
  const modeloSel = useMemo(() => resultados.find((m) => m.id === modelo) ?? facetas?.modelos.find((m) => m.id === modelo), [resultados, facetas, modelo]);

  // Al elegir un modelo por su dirección (sin pasar por la lista) se completa la marca para que los filtros queden coherentes.
  useEffect(() => {
    if (modelo && modeloSel && modeloSel.marca_id !== marca) poner({ marca: modeloSel.marca_id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelo, modeloSel?.marca_id]);

  const todasVersiones = detalle?.versiones ?? [];
  const aniosModelo = detalle?.anios ?? [];
  const anioNum = Number(anio) || 0;
  const delAnio = anioNum ? todasVersiones.filter((v) => v.anios.includes(anioNum)) : todasVersiones;
  const motores = useMemo(() => {
    const m = new Map<string, number>();
    for (const v of delAnio) if (v.motorizacion) m.set(v.motorizacion, (m.get(v.motorizacion) ?? 0) + v.n);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([nombre]) => nombre);
  }, [delAnio]);
  const visibles = motor ? delAnio.filter((v) => v.motorizacion === motor) : delAnio;
  const versionSel = version ? todasVersiones.find((v) => v.id === version) ?? null : null;

  const hayFiltros = !!(texto || marca || modelo || anio);
  const limpiar = () => {
    setTexto('');
    setSp({}, { replace: true });
  };

  const elegirMarca = (id: string) => poner({ marca: id, modelo: '', version: '', motor: '' }, false);
  const elegirModelo = (id: string, marcaId?: string) => poner({ modelo: id, ...(marcaId ? { marca: marcaId } : {}), version: '', motor: '' }, false);
  const elegirAnio = (a: string) => {
    // Una versión elegida deja de valer si no existe en el año nuevo.
    const sigue = !a || !versionSel || versionSel.anios.includes(Number(a));
    poner({ anio: a, ...(sigue ? {} : { version: '' }), motor: '' });
  };

  const marcasOpc = facetas?.marcas ?? [];
  const modelosOpc = facetas?.modelos ?? [];
  const aniosOpc = modelo ? aniosModelo.slice().reverse() : facetas?.anios ?? [];
  const nombreMarca = (id: string) => marcasOpc.find((m) => m.id === id)?.nombre ?? modeloSel?.marca ?? '';

  return (
    <>
      <Encabezado titulo="Catálogo automotor" subtitulo="Marcas, modelos, años, versiones y motorizaciones registradas en la Argentina" />

      <Tarjeta className="mb-4">
        <div className="space-y-3">
          <Buscador value={texto} onChange={setTexto} placeholder="Buscar marca, modelo o versión: Amarok, Gol Trend, Highline…" />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <Campo label="Marca">
              <Select value={marca} onChange={(e) => elegirMarca(e.target.value)} aria-label="Marca">
                <option value="">Todas</option>
                {marca && !marcasOpc.some((m) => m.id === marca) && <option value={marca}>{nombreMarca(marca) || 'Marca elegida'}</option>}
                {marcasOpc.map((m) => (
                  <option key={m.id} value={m.id}>{m.nombre}</option>
                ))}
              </Select>
            </Campo>
            <Campo label="Modelo">
              <Select value={modelo} onChange={(e) => elegirModelo(e.target.value, modelosOpc.find((m) => m.id === e.target.value)?.marca_id)} aria-label="Modelo">
                <option value="">{modelosOpc.length ? 'Todos' : 'Sin modelos'}</option>
                {modelo && !modelosOpc.some((m) => m.id === modelo) && <option value={modelo}>{modeloSel?.nombre ?? 'Modelo elegido'}</option>}
                {modelosOpc.map((m) => (
                  <option key={m.id} value={m.id}>{marca ? m.nombre : `${m.marca} · ${m.nombre}`}</option>
                ))}
              </Select>
            </Campo>
            <Campo label="Año">
              <Select value={anio} onChange={(e) => elegirAnio(e.target.value)} aria-label="Año">
                <option value="">Todos</option>
                {anio && !aniosOpc.includes(anioNum) && <option value={anio}>{anio}</option>}
                {aniosOpc.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </Select>
            </Campo>
            <Campo label="Versión">
              <Select value={version} onChange={(e) => poner({ version: e.target.value }, false)} disabled={!modelo || cargandoModelo} aria-label="Versión">
                <option value="">{modelo ? `Todas (${visibles.length})` : 'Elegí un modelo'}</option>
                {visibles.map((v) => (
                  <option key={v.id} value={v.id}>{textoVersion(v)}</option>
                ))}
              </Select>
            </Campo>
            <Campo label="Motorización">
              <Select value={motor} onChange={(e) => poner({ motor: e.target.value, version: '' })} disabled={!modelo || motores.length === 0} aria-label="Motorización">
                <option value="">{!modelo ? 'Elegí un modelo' : motores.length ? 'Todas' : 'No informada'}</option>
                {motores.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </Select>
            </Campo>
          </div>
          {hayFiltros && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-tenue">
              <span>{modelo ? '' : busqueda.isFetching && !paginas.length ? 'Buscando…' : `${total.toLocaleString('es-AR')} modelo${total === 1 ? '' : 's'} encontrado${total === 1 ? '' : 's'}`}</span>
              <Boton tam="sm" variante="fantasma" onClick={limpiar}>Limpiar filtros</Boton>
            </div>
          )}
        </div>
      </Tarjeta>

      {modelo ? (
        <DetalleModelo
          modeloId={modelo}
          resumen={modeloSel}
          cargando={cargandoModelo}
          error={errorModelo}
          versiones={visibles}
          totalVersiones={todasVersiones.length}
          aniosModelo={aniosModelo}
          anio={anioNum}
          versionSel={versionSel}
          fichas={fichas}
          info={info}
          escritorio={escritorio}
          onVersion={(id) => poner({ version: id }, false)}
          onQuitarFiltros={() => poner({ anio: '', motor: '' })}
          onVolver={() => poner({ modelo: '', version: '', motor: '' }, false)}
        />
      ) : busqueda.error ? (
        <ErrorCaja error={busqueda.error} reintentar={() => busqueda.refetch()} />
      ) : busqueda.isLoading ? (
        <Cargando texto="Buscando en el catálogo…" />
      ) : resultados.length === 0 ? (
        <Vacio icono={<Search className="size-5" />} titulo="No encontramos modelos con esos filtros" texto="Probá con menos palabras o quitá algún filtro. Si el vehículo no figura, se puede registrar igual escribiendo sus datos a mano." accion={<Boton onClick={limpiar}>Limpiar filtros</Boton>} />
      ) : (
        <>
          {!hayFiltros && <p className="mb-2 text-sm text-tenue">Los modelos con más inscripciones primero. Buscá por nombre o usá los filtros.</p>}
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {resultados.map((m) => (
              <li key={m.id} className="min-w-0">
                <button type="button" onClick={() => elegirModelo(m.id, m.marca_id)} className="flex h-full w-full min-w-0 flex-col gap-1.5 rounded-card border border-borde bg-superficie p-4 text-left shadow-card transition hover:border-marca-300 hover:bg-marca-50/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-marca-500">
                  <span className="text-xs font-medium uppercase tracking-wide text-tenue">{m.marca}</span>
                  <span className="break-words text-base font-semibold leading-snug text-texto">{m.nombre}</span>
                  <span className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                    {m.tipo && <Insignia>{m.tipo}</Insignia>}
                    {rangoAnios(m.anios) && <Insignia tono="azul">{rangoAnios(m.anios)}</Insignia>}
                    <Insignia tono="cian">{m.versiones} versi{m.versiones === 1 ? 'ón' : 'ones'}</Insignia>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {busqueda.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Boton cargando={busqueda.isFetchingNextPage} onClick={() => busqueda.fetchNextPage()}>Ver más modelos ({(total - resultados.length).toLocaleString('es-AR')} restantes)</Boton>
            </div>
          )}
        </>
      )}
      <p className="mt-6 text-xs text-tenue">
        Datos del registro automotor (DNRPA, inscripciones iniciales de autos, {info?.licencia ?? 'CC BY 4.0'}). Describen cómo se inscribieron los vehículos; no son especificaciones técnicas oficiales de los fabricantes.
      </p>
    </>
  );
}

// ───────────── Modelo elegido: versiones + ficha + vehículos del taller ─────────────
function DetalleModelo({ modeloId, resumen, cargando, error, versiones, totalVersiones, aniosModelo, anio, versionSel, fichas, info, escritorio, onVersion, onQuitarFiltros, onVolver }: {
  modeloId: string;
  resumen?: { nombre: string; marca: string; tipo?: string | null };
  cargando: boolean;
  error: unknown;
  versiones: CatVersion[];
  totalVersiones: number;
  aniosModelo: number[];
  anio: number;
  versionSel: CatVersion | null;
  fichas: FichaTecnica[];
  info?: Record<string, string>;
  escritorio: boolean;
  onVersion: (id: string) => void;
  onQuitarFiltros: () => void;
  onVolver: () => void;
}) {
  const [cuantas, setCuantas] = useState(VERSIONES_VISIBLES);
  useEffect(() => setCuantas(VERSIONES_VISIBLES), [modeloId, versiones.length]);
  if (error) return <ErrorCaja error={error} />;
  if (cargando) return <Cargando />;
  const titulo = resumen ? `${resumen.marca} ${resumen.nombre}` : 'Modelo';
  const ficha = versionSel ? (
    <FichaVersion marca={resumen?.marca ?? ''} modelo={resumen?.nombre ?? ''} version={versionSel} anio={anio} fichas={fichas} info={info} />
  ) : null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="break-words text-lg font-semibold leading-snug">{titulo}</h2>
          <p className="text-sm text-tenue">
            {[resumen?.tipo, rangoAnios(aniosModelo) && `Años ${rangoAnios(aniosModelo)}`, `${totalVersiones} versi${totalVersiones === 1 ? 'ón' : 'ones'} registrada${totalVersiones === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
          </p>
        </div>
        <Boton tam="sm" onClick={onVolver}>Ver otros modelos</Boton>
      </div>

      <div className={escritorio ? 'grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] items-start gap-4' : ''}>
        <div className="min-w-0 space-y-4">
          <Tarjeta titulo={`Versiones${versiones.length !== totalVersiones ? ` (${versiones.length} de ${totalVersiones})` : ` (${totalVersiones})`}`} subtitulo="Tal como figuran en el registro automotor" sinPadding>
            {versiones.length === 0 ? (
              <div className="p-4">
                <Vacio icono={<CircleSlash className="size-5" />} titulo="Ninguna versión con esos filtros" accion={<Boton onClick={onQuitarFiltros}>Quitar año y motorización</Boton>} />
              </div>
            ) : (
              <ul className="divide-y divide-borde-suave">
                {versiones.slice(0, cuantas).map((v) => (
                  <li key={v.id}>
                    <button
                      type="button"
                      onClick={() => onVersion(v.id)}
                      aria-current={versionSel?.id === v.id}
                      className={`flex min-h-14 w-full min-w-0 flex-col gap-1 px-4 py-3 text-left hover:bg-marca-50/50 ${versionSel?.id === v.id ? 'bg-marca-50' : ''}`}
                    >
                      <span className="break-words text-sm font-medium leading-snug">{textoVersion(v)}</span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        {v.motorizacion && <Insignia tono="azul">{v.motorizacion}</Insignia>}
                        {v.combustible && <Insignia tono="ambar">{v.combustible}</Insignia>}
                        {rangoAnios(v.anios) && <span className="text-xs text-tenue">{rangoAnios(v.anios)}</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {versiones.length > cuantas && (
              <div className="border-t border-borde-suave p-3 text-center">
                <Boton tam="sm" onClick={() => setCuantas((c) => c + VERSIONES_VISIBLES)}>Ver más versiones ({versiones.length - cuantas} restantes)</Boton>
              </div>
            )}
          </Tarjeta>
          {!escritorio && <VehiculosDelTaller catModeloId={modeloId} versionId={versionSel?.id} />}
        </div>

        {escritorio ? (
          <div className="min-w-0 space-y-4">
            {ficha ?? <Vacio icono={<BookOpen className="size-5" />} titulo="Elegí una versión" texto="Vas a ver su ficha: identificación, información técnica y documentación." />}
            <VehiculosDelTaller catModeloId={modeloId} versionId={versionSel?.id} />
          </div>
        ) : (
          <Modal abierto={!!versionSel} onCerrar={() => onVersion('')} titulo={`${titulo}`} ancho="xl">
            {ficha}
          </Modal>
        )}
      </div>
    </div>
  );
}

// ───────────── Ficha de la versión ─────────────
/** Ficha verificada más específica: la de esa versión, si no la de su motorización o la general del modelo, siempre dentro de sus años. */
function elegirFicha(fichas: FichaTecnica[], v: CatVersion, anio: number): FichaTecnica | null {
  const anioRef = anio || null;
  const dentro = (f: FichaTecnica) => {
    const a = anioRef ?? (v.anios[0] ?? null);
    return a == null || ((f.anio_desde == null || a >= f.anio_desde) && (f.anio_hasta == null || a <= f.anio_hasta));
  };
  const valida = fichas.filter(dentro);
  return (
    valida.find((f) => f.version_id === v.id) ??
    valida.find((f) => !f.version_id && f.motorizacion && claveBusqueda(f.motorizacion) === claveBusqueda(v.motorizacion ?? '')) ??
    valida.find((f) => !f.version_id && !f.motorizacion) ??
    null
  );
}

/** Valor de la ficha: texto o número tal cual; objetos simples (km/meses) en una línea legible. */
function valorTexto(v: unknown): string {
  if (v == null || v === '') return '';
  if (typeof v === 'number') return v.toLocaleString('es-AR');
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('km' in o || 'meses' in o) return [o.km != null && `${valorTexto(o.km)} km`, o.meses != null && `${valorTexto(o.meses)} meses`].filter(Boolean).join(' o ');
    return Object.entries(o).map(([k, x]) => `${k}: ${valorTexto(x)}`).join(' · ');
  }
  return String(v);
}

const etiquetaClave = (k: string) => (k.charAt(0).toUpperCase() + k.slice(1)).replace(/_/g, ' ');

function Fila({ etiqueta, valor }: { etiqueta: string; valor?: string | number | null }) {
  const hay = valor != null && String(valor).trim() !== '';
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-tenue">{etiqueta}</dt>
      <dd className={`mt-0.5 break-words text-sm ${hay ? 'text-texto' : 'italic text-tenue'}`}>{hay ? valor : SIN_DATOS}</dd>
    </div>
  );
}

function FichaVersion({ marca, modelo, version, anio, fichas, info }: { marca: string; modelo: string; version: CatVersion; anio: number; fichas: FichaTecnica[]; info?: Record<string, string> }) {
  const ficha = elegirFicha(fichas, version, anio);
  const aniosTxt = anio && version.anios.includes(anio) ? String(anio) : rangoAnios(version.anios);
  const filtros = ficha?.filtros ? Object.entries(ficha.filtros).filter(([, v]) => valorTexto(v)) : [];
  const intervalos = ficha?.intervalos ? Object.entries(ficha.intervalos).filter(([, v]) => valorTexto(v)) : [];
  return (
    <div className="min-w-0 space-y-4">
      <Tarjeta
        titulo="Identificación"
        subtitulo={`${marca} ${modelo}`}
        acciones={<AccionesFicha marca={marca} modelo={modelo} version={version} anio={anio} />}
      >
        <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
          <Dato etiqueta="Marca">{marca}</Dato>
          <Dato etiqueta="Modelo">{modelo}</Dato>
          <Dato etiqueta={anio && version.anios.includes(anio) ? 'Año' : 'Años con inscripciones'}>{aniosTxt}</Dato>
          <Dato etiqueta="Versión">{textoVersion(version)}</Dato>
          <Fila etiqueta="Motorización (según la descripción del registro)" valor={version.motorizacion} />
          <Fila etiqueta="Combustible (si el registro lo indica)" valor={version.combustible} />
          <Dato etiqueta="Descripción registral" className="sm:col-span-2">{version.descripcion}</Dato>
          <Dato etiqueta="Fuente de los datos" className="sm:col-span-2">
            {info?.fuente ?? 'DNRPA — Inscripciones iniciales de autos'}
            {info?.licencia ? ` · ${info.licencia}` : ''}
            {info?.url && (
              <>
                {' '}
                <a href={info.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-marca-700 underline-offset-2 hover:underline">
                  datos.jus.gob.ar <ExternalLink className="size-3" />
                </a>
              </>
            )}
          </Dato>
        </dl>
        <Aviso tono="ambar" className="mt-3">
          La descripción registral es lo que informó el registro al inscribir el vehículo. <b>No es una especificación técnica oficial</b> del fabricante.
        </Aviso>
      </Tarjeta>

      <Tarjeta
        titulo="Información técnica"
        subtitulo={ficha ? `Fuente: ${ficha.fuente} · verificado el ${ficha.fecha_verificacion}` : 'Especificaciones verificadas con su fuente'}
      >
        {!ficha && (
          <Aviso tono="azul" className="mb-3">
            Todavía no hay una ficha técnica verificada para esta versión. Los campos se completan sólo con datos que tengan fuente y fecha de verificación: no se estiman ni se deducen.
          </Aviso>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Bloque icono={<Gauge className="size-4" />} titulo="Motor">
            <Fila etiqueta="Código de motor" valor={ficha?.codigo_motor} />
            <Fila etiqueta="Motorización" valor={ficha?.motorizacion} />
            <Fila etiqueta="Distribución" valor={ficha?.distribucion} />
          </Bloque>
          <Bloque icono={<Wrench className="size-4" />} titulo="Lubricantes">
            <Fila etiqueta="Aceite de motor recomendado" valor={ficha?.aceite_recomendado} />
            <Fila etiqueta="Refrigerante" valor={ficha?.refrigerante} />
          </Bloque>
          <Bloque icono={<Gauge className="size-4" />} titulo="Capacidades">
            <Fila etiqueta="Aceite de motor" valor={ficha?.aceite_capacidad_l != null ? `${ficha.aceite_capacidad_l.toLocaleString('es-AR')} L` : null} />
          </Bloque>
          <Bloque icono={<Wrench className="size-4" />} titulo="Filtros">
            {filtros.length ? filtros.map(([k, v]) => <Fila key={k} etiqueta={etiquetaClave(k)} valor={valorTexto(v)} />) : <Fila etiqueta="Aceite, aire, combustible y habitáculo" valor={null} />}
          </Bloque>
          <Bloque icono={<Gauge className="size-4" />} titulo="Intervalos de mantenimiento" className="sm:col-span-2">
            {intervalos.length ? intervalos.map(([k, v]) => <Fila key={k} etiqueta={etiquetaClave(k)} valor={valorTexto(v)} />) : <Fila etiqueta="Intervalos de service" valor={null} />}
          </Bloque>
        </div>
        {ficha?.notas && <p className="mt-3 text-xs text-tenue">Notas: {ficha.notas}</p>}
      </Tarjeta>

      <Tarjeta titulo="Documentación" subtitulo="Sólo documentos que existen y se pueden usar legalmente">
        <div className="grid gap-3 sm:grid-cols-3">
          {['Manual del propietario', 'Manual técnico', 'Documentación de mantenimiento'].map((t) => (
            <div key={t} className="min-w-0 rounded-card border border-dashed border-borde bg-superficie-2 p-3">
              <p className="flex items-start gap-1.5 text-sm font-medium"><FileText className="mt-0.5 size-4 shrink-0 text-tenue" /><span className="min-w-0 break-words">{t}</span></p>
              <p className="mt-1 text-xs italic text-tenue">Sin documentos verificados</p>
            </div>
          ))}
        </div>
        {ficha?.documentacion_url && (
          <p className="mt-3 text-sm">
            Documento enlazado por la ficha verificada:{' '}
            <a href={ficha.documentacion_url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 break-all text-marca-700 underline-offset-2 hover:underline">
              abrir en la fuente <ExternalLink className="size-3 shrink-0" />
            </a>
          </p>
        )}
        <p className="mt-3 text-xs text-tenue">ORVELAN no aloja ni redistribuye manuales protegidos: sólo mostrará enlaces a documentos oficiales o de uso libre cuando se verifique su origen.</p>
      </Tarjeta>
    </div>
  );
}

function Bloque({ icono, titulo, children, className }: { icono: ReactNode; titulo: string; children: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-card border border-borde-suave p-3 ${className ?? ''}`}>
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-700">
        <span className="text-tenue">{icono}</span>
        {titulo}
      </h3>
      <dl className="space-y-2.5">{children}</dl>
    </section>
  );
}

// ───────────── Integración con el taller ─────────────
/** Registrar un vehículo con estos datos: se elige el cliente (privado del taller) y se abre el alta con el modelo ya cargado. */
function AccionesFicha({ marca, modelo, version, anio }: { marca: string; modelo: string; version: CatVersion; anio: number }) {
  const { puede } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [abierto, setAbierto] = useState(false);
  const [cliente, setCliente] = useState<{ id: string; nombre: string } | null>(null);
  if (!puede('vehiculos.crear')) return null;
  const cerrar = () => {
    setAbierto(false);
    setCliente(null);
  };
  return (
    <>
      <Boton tam="sm" variante="primario" icono={<Plus className="size-4" />} onClick={() => setAbierto(true)}>Registrar vehículo</Boton>
      <Modal abierto={abierto} onCerrar={cerrar} titulo={cliente ? 'Datos del vehículo' : 'Registrar vehículo: elegí el cliente'} ancho="lg">
        <p className="mb-3 text-sm text-tenue">{[marca, modelo, textoVersion(version), anio && version.anios.includes(anio) ? anio : null].filter(Boolean).join(' · ')}</p>
        {!cliente ? (
          <SelectorCliente valor={null} onCambio={(c) => c && setCliente(c)} />
        ) : (
          <>
            <div className="mb-3"><SelectorCliente valor={cliente as any} onCambio={() => setCliente(null)} /></div>
            <FormVehiculo
              clienteId={cliente.id}
              inicial={{ marca, modelo, version: textoVersion(version), anio: anio && version.anios.includes(anio) ? anio : version.anios.length === 1 ? version.anios[0] : null, motor: version.motorizacion ?? '', combustible: combustibleForm(version.combustible) }}
              onCancelar={cerrar}
              onGuardado={(v) => {
                cerrar();
                toast.ok('Vehículo registrado');
                nav(`/vehiculos/${v.id}`);
              }}
            />
          </>
        )}
      </Modal>
    </>
  );
}

/** Vehículos de ESTE taller con ese modelo (el servidor filtra por el taller de la sesión: otros talleres no se ven). */
function VehiculosDelTaller({ catModeloId, versionId }: { catModeloId: string; versionId?: string }) {
  const { puede } = useAuth();
  const habilitado = puede('vehiculos.ver');
  const { data = [], isLoading, error } = useQuery({ queryKey: ['vehiculos', { cat_modelo_id: catModeloId }], queryFn: () => api.get<any[]>(`/vehiculos?cat_modelo_id=${encodeURIComponent(catModeloId)}`), enabled: habilitado });
  if (!habilitado) return null;
  return (
    <Tarjeta titulo="En tu taller" subtitulo="Vehículos registrados de este modelo" acciones={!isLoading && !error && <Insignia tono={data.length ? 'azul' : 'gris'}>{data.length}</Insignia>}>
      {isLoading ? (
        <Cargando />
      ) : error ? (
        <p className="text-sm text-peligro-700">No se pudieron cargar los vehículos del taller.</p>
      ) : data.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-tenue"><Car className="size-4 shrink-0" />Todavía no hay vehículos de este modelo en tu taller.</p>
      ) : (
        <ul className="divide-y divide-borde-suave">
          {data.slice(0, 20).map((v) => (
            <li key={v.id}>
              <Link to={`/vehiculos/${v.id}`} className="flex min-h-12 min-w-0 items-center justify-between gap-3 py-2 hover:text-marca-700">
                <span className="min-w-0">
                  <span className="block text-sm font-semibold tracking-wide">{v.patente}</span>
                  <span className="block break-words text-xs text-tenue">{[v.version, v.anio, v.cliente].filter(Boolean).join(' · ')}</span>
                </span>
                {versionId && v.cat_version_id === versionId && <Insignia tono="verde">Misma versión</Insignia>}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {data.length > 20 && <p className="mt-2 text-xs text-tenue">Se muestran 20 de {data.length}. Buscá el resto desde Vehículos.</p>}
    </Tarjeta>
  );
}
