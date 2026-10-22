import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Download, FileSpreadsheet, Upload } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { leerArchivo, type ArchivoLeido } from '@/lib/archivo';
import { descargarCSV } from '@/lib/csv';
import { fechaHora } from '@/lib/format';
import { ETIQUETA_ACCION, informeProblemas, marcarDuplicadosDelArchivo, prepararHoja, valoresDe, type FilaOrigen } from '@/lib/importar';
import { Aviso, Boton, Campo, Cargando, Check, cn, Encabezado, Insignia, Select, Tabla, Tarjeta, useToast } from '@/components/ui';
import { SelectorCliente, type ClienteMin } from '@/components/selectores';
import {
  camposDe, detectarSeparadorDecimal, encabezadosEjemplo, filaEjemplo, LIMITES_IMPORTACION, MODO_IMPORTACION_LABEL, MODOS_IMPORTACION, sugerirMapeo, TIPO_IMPORTACION_LABEL, TIPOS_IMPORTACION,
  type ModoImportacion, type ResultadoFila, type TipoImportacion,
} from '@shared/importacion';

const DESCRIPCION: Record<TipoImportacion, { texto: string; antes?: string }> = {
  clientes: { texto: 'Nombre, documento, contacto y condición frente al IVA.' },
  vehiculos: { texto: 'Patente, marca, modelo, año y kilometraje, vinculados a su cliente.', antes: 'Importá primero los clientes.' },
  articulos: { texto: 'Repuestos e insumos con códigos, categoría, unidad, costo y precio.', antes: 'Si tienen proveedor, importá primero los proveedores.' },
  proveedores: { texto: 'Razón social, CUIT y datos de contacto.' },
};

const PASOS = ['Archivo', 'Columnas', 'Opciones', 'Revisión', 'Importación'] as const;

interface Progreso { hechos: number; total: number; texto: string }

export function Importar() {
  const { puede } = useAuth();
  const toast = useToast();
  const [paso, setPaso] = useState(0);
  const [tipo, setTipo] = useState<TipoImportacion | null>(null);
  const [archivo, setArchivo] = useState<ArchivoLeido | null>(null);
  const [hoja, setHoja] = useState(0);
  const [conTitulos, setConTitulos] = useState(true);
  const [mapeo, setMapeo] = useState<Record<string, number | null>>({});
  const [decimal, setDecimal] = useState<',' | '.'>(',');
  const [modo, setModo] = useState<ModoImportacion>('omitir');
  const [crearCatalogos, setCrearCatalogos] = useState(true);
  const [stock, setStock] = useState<{ activo: boolean; deposito_id: string; confirmado: boolean }>({ activo: false, deposito_id: '', confirmado: false });
  const [resultados, setResultados] = useState<ResultadoFila[]>([]);
  const [resoluciones, setResoluciones] = useState<Record<string, string>>({});
  const [progreso, setProgreso] = useState<Progreso | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aceptaErrores, setAceptaErrores] = useState(false);
  const [final, setFinal] = useState<{ id: string; resultados: ResultadoFila[]; creados: number; actualizados: number; omitidos: number; errores: number; previa?: any } | null>(null);
  const [filtro, setFiltro] = useState<'error' | 'actualizar' | 'omitir' | 'crear'>('error');
  const input = useRef<HTMLInputElement>(null);
  const cancelar = useRef(false);

  const datos = useMemo(() => (archivo ? prepararHoja(archivo.hojas[hoja] ?? archivo.hojas[0], conTitulos) : null), [archivo, hoja, conTitulos]);
  const { data: depositos } = useQuery({ queryKey: ['depositos'], queryFn: () => api.get<any[]>('/depositos'), enabled: tipo === 'articulos' && puede('stock.ver') });
  const { data: proveedores } = useQuery({ queryKey: ['proveedores'], queryFn: () => api.get<any[]>('/proveedores'), enabled: tipo === 'articulos' && puede('compras.ver') });
  const { data: historial, refetch: recargarHistorial } = useQuery({ queryKey: ['importaciones'], queryFn: () => api.get<any[]>('/importaciones') });

  const campos = tipo ? camposDe(tipo) : [];
  const filas: FilaOrigen[] = datos?.filas ?? [];
  const faltantes = campos.filter((c) => c.requerido && mapeo[c.clave] == null);
  const tieneReferencia = tipo === 'vehiculos' ? ['cliente_documento', 'cliente_codigo', 'cliente_nombre'].some((k) => mapeo[k] != null) : true;
  const opciones = () => ({
    decimal,
    crear_catalogos: crearCatalogos,
    stock_inicial: tipo === 'articulos' && stock.activo && stock.confirmado ? { deposito_id: stock.deposito_id || null } : null,
  });

  if (!puede('datos.importar')) {
    return <Aviso tono="ambar">No tenés permiso para importar datos. Pedile al propietario que te habilite “Importar datos desde Excel o CSV”.</Aviso>;
  }

  const reiniciar = () => {
    setPaso(0); setTipo(null); setArchivo(null); setMapeo({}); setResultados([]); setResoluciones({}); setFinal(null); setProgreso(null); setError(null); setAceptaErrores(false);
    setModo('omitir'); setStock({ activo: false, deposito_id: '', confirmado: false });
  };

  const elegirArchivo = async (f: File | undefined) => {
    if (!f || !tipo) return;
    setError(null);
    try {
      const a = await leerArchivo(f);
      setArchivo(a);
      setHoja(0);
      aplicarMapeo(a, 0, true, tipo);
    } catch (e) {
      setArchivo(null);
      setError(e instanceof Error ? e.message : 'No se pudo leer el archivo');
    }
  };

  /** Propone el mapeo de columnas y el separador decimal según lo que trae el archivo. */
  const aplicarMapeo = (a: ArchivoLeido, h: number, titulos: boolean, t: TipoImportacion) => {
    const d = prepararHoja(a.hojas[h], titulos);
    const m = sugerirMapeo(t, d.columnas);
    setMapeo(m);
    const col = (k: string) => (m[k] != null ? d.filas.slice(0, 200).map((f) => f.celdas[m[k]!]) : []);
    setDecimal(detectarSeparadorDecimal([...col('costo'), ...col('precio'), ...col('stock_inicial')]));
  };

  // ───── Validación de todas las filas (el servidor no escribe nada) ─────
  const revisar = async (res = resoluciones) => {
    if (!tipo || !datos) return;
    setError(null);
    cancelar.current = false;
    const lote = LIMITES_IMPORTACION.tamanoLote;
    const todos: ResultadoFila[] = [];
    try {
      for (let i = 0; i < filas.length; i += lote) {
        if (cancelar.current) return;
        setProgreso({ hechos: i, total: filas.length, texto: 'Revisando filas…' });
        const parte = filas.slice(i, i + lote);
        const r = await api.post('/importaciones/validar', { tipo, modo, opciones: opciones(), resoluciones: res, filas: parte.map((f) => ({ n: f.n, v: valoresDe(f, mapeo) })) });
        todos.push(...(r.resultados as ResultadoFila[]));
      }
      setResultados(marcarDuplicadosDelArchivo(tipo, filas, mapeo, todos, { decimal }));
      setFiltro('error');
      setPaso(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo revisar el archivo');
    } finally {
      setProgreso(null);
    }
  };

  // ───── Importación por lotes (reanudable: los lotes ya aplicados no se repiten) ─────
  const importar = async () => {
    if (!tipo || !archivo || !datos) return;
    setError(null);
    setPaso(4);
    const lote = LIMITES_IMPORTACION.tamanoLote;
    try {
      const mapeoNombres = Object.fromEntries(Object.entries(mapeo).filter(([, c]) => c != null).map(([k, c]) => [k, datos.columnas[c!]]));
      const job = await api.post('/importaciones', {
        tipo, modo, opciones: opciones(), archivo: { nombre: archivo.nombre, hash: archivo.hash, bytes: archivo.bytes }, total_filas: filas.length, mapeo: mapeoNombres,
      });
      const hechos: number[] = job.lotes_hechos ?? [];
      const acumulado: ResultadoFila[] = [];
      let c = { creados: 0, actualizados: 0, omitidos: 0, errores: 0 };
      const total = Math.ceil(filas.length / lote);
      for (let k = 0; k < total; k++) {
        setProgreso({ hechos: k, total, texto: hechos.includes(k) ? 'Retomando lo ya importado…' : 'Importando…' });
        const parte = filas.slice(k * lote, k * lote + lote);
        const r = await api.post(`/importaciones/${job.id}/lotes/${k}`, { filas: parte.map((f) => ({ n: f.n, v: valoresDe(f, mapeo) })), resoluciones });
        if (r.ya_procesado) {
          c = { creados: c.creados + r.creados, actualizados: c.actualizados + r.actualizados, omitidos: c.omitidos + r.omitidos, errores: c.errores + r.errores };
          // De un lote aplicado antes solo quedan los problemas guardados; el resto se asume como lo previsto en la revisión.
          const probl = new Map<number, any>((r.problemas as any[]).map((p) => [p.fila, p]));
          acumulado.push(...parte.map((f): ResultadoFila => {
            const p = probl.get(f.n);
            if (!p) return { n: f.n, accion: 'crear', ref: '', errores: [], avisos: [] };
            return p.severidad === 'error' ? { n: f.n, accion: 'error', ref: p.referencia ?? '', errores: [p.mensaje], avisos: [] } : { n: f.n, accion: 'omitir', ref: p.referencia ?? '', errores: [], avisos: [], motivo: p.mensaje };
          }));
        } else {
          c = { creados: c.creados + r.contadores.creados, actualizados: c.actualizados + r.contadores.actualizados, omitidos: c.omitidos + r.contadores.omitidos, errores: c.errores + r.contadores.errores };
          acumulado.push(...(r.resultados as ResultadoFila[]));
        }
      }
      await api.post(`/importaciones/${job.id}/finalizar`, {});
      setFinal({ id: job.id, resultados: acumulado, ...c, previa: job.previa });
      recargarHistorial();
      toast.ok('Importación terminada');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Se interrumpió la importación');
    } finally {
      setProgreso(null);
    }
  };

  const resumen = useMemo(() => ({
    crear: resultados.filter((r) => r.accion === 'crear').length,
    actualizar: resultados.filter((r) => r.accion === 'actualizar').length,
    omitir: resultados.filter((r) => r.accion === 'omitir').length,
    error: resultados.filter((r) => r.accion === 'error').length,
  }), [resultados]);

  // Referencias que no se pudieron resolver (clientes o proveedores), agrupadas.
  const pendientes = useMemo(() => {
    const m = new Map<string, { tipo: 'cliente' | 'proveedor'; clave: string; etiqueta: string; motivo: string; filas: number[] }>();
    for (const r of resultados) {
      if (!r.pendiente) continue;
      const k = `${r.pendiente.tipo}:${r.pendiente.clave}`;
      const x = m.get(k) ?? { ...r.pendiente, filas: [] };
      x.filas.push(r.n);
      m.set(k, x);
    }
    return [...m.entries()];
  }, [resultados]);

  const descargarProblemas = (res: ResultadoFila[], conOmitidos: boolean) => {
    if (!datos) return;
    const inf = informeProblemas(datos.columnas, filas, res, conOmitidos);
    descargarCSV(`informe-${tipo}-${new Date().toISOString().slice(0, 10)}`, inf.encabezado, inf.filas);
  };

  const importables = resumen.crear + resumen.actualizar;

  // ───────────────────────── Pantallas ─────────────────────────
  return (
    <>
      <Encabezado titulo="Importar datos" subtitulo="Traé tus clientes, vehículos, artículos y proveedores desde Excel o CSV. Siempre vas a ver qué se va a cargar antes de confirmar." />
      <ol className="mb-5 flex flex-wrap gap-2 text-sm">
        {PASOS.map((p, i) => (
          <li key={p} className={cn('flex items-center gap-2 rounded-full px-3 py-1', i === paso ? 'bg-marca-600 text-white' : i < paso ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500')}>
            <span className="font-semibold">{i + 1}</span>{p}
          </li>
        ))}
      </ol>
      {error && <Aviso tono="rojo" className="mb-4">{error}</Aviso>}

      {/* ───── 1. Archivo ───── */}
      {paso === 0 && (
        <div className="space-y-4">
          <Tarjeta titulo="¿Qué querés importar?">
            <div className="grid gap-3 sm:grid-cols-2">
              {TIPOS_IMPORTACION.map((t) => (
                <button key={t} type="button" onClick={() => { setTipo(t); setArchivo(null); setError(null); }} className={cn('rounded-xl border p-4 text-left transition-colors', tipo === t ? 'border-marca-500 bg-marca-50 ring-1 ring-marca-300' : 'border-borde hover:bg-slate-50')}>
                  <p className="font-semibold">{TIPO_IMPORTACION_LABEL[t]}</p>
                  <p className="mt-0.5 text-sm text-tenue">{DESCRIPCION[t].texto}</p>
                  {DESCRIPCION[t].antes && <p className="mt-1 text-xs text-amber-700">{DESCRIPCION[t].antes}</p>}
                </button>
              ))}
            </div>
          </Tarjeta>
          {tipo && (
            <Tarjeta
              titulo={`Archivo de ${TIPO_IMPORTACION_LABEL[tipo].toLowerCase()}`}
              subtitulo={`Excel (.xlsx) o CSV, hasta ${LIMITES_IMPORTACION.maxBytesArchivo / 1048576} MB y ${LIMITES_IMPORTACION.maxFilas} filas. No hace falta que las columnas tengan un formato especial: las relacionás en el paso siguiente.`}
              acciones={<Boton tam="sm" icono={<Download className="size-4" />} onClick={() => descargarCSV(`plantilla-${tipo}`, encabezadosEjemplo(tipo), [filaEjemplo(tipo)])}>Descargar planilla de ejemplo</Boton>}
            >
              <input ref={input} type="file" accept=".xlsx,.csv,.txt,.tsv" className="hidden" onChange={(e) => { elegirArchivo(e.target.files?.[0]); e.target.value = ''; }} />
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); elegirArchivo(e.dataTransfer.files?.[0]); }}
                className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-borde px-4 py-8 text-center"
              >
                <FileSpreadsheet className="size-8 text-slate-300" />
                {archivo ? (
                  <p className="text-sm"><b>{archivo.nombre}</b> · {(archivo.bytes / 1024).toFixed(0)} KB</p>
                ) : (
                  <p className="text-sm text-tenue">Arrastrá el archivo acá o elegilo desde tu computadora</p>
                )}
                <Boton icono={<Upload className="size-4" />} onClick={() => input.current?.click()}>{archivo ? 'Elegir otro archivo' : 'Elegir archivo'}</Boton>
              </div>
              {archivo && datos && (
                <div className="mt-4 space-y-3">
                  <div className="flex flex-wrap items-end gap-4">
                    {archivo.hojas.length > 1 && (
                      <Campo label="Hoja del libro">
                        <Select value={hoja} onChange={(e) => { const h = Number(e.target.value); setHoja(h); aplicarMapeo(archivo, h, conTitulos, tipo); }}>{archivo.hojas.map((h, i) => <option key={i} value={i}>{h.nombre}</option>)}</Select>
                      </Campo>
                    )}
                    <Check checked={conTitulos} onChange={(v) => { setConTitulos(v); aplicarMapeo(archivo, hoja, v, tipo); }} label="La primera fila tiene los títulos de las columnas" />
                  </div>
                  <p className="text-sm">Se encontraron <b>{filas.length}</b> filas con datos y {datos.columnas.length} columnas.</p>
                  {filas.length > LIMITES_IMPORTACION.maxFilas && <Aviso tono="rojo">El archivo tiene más de {LIMITES_IMPORTACION.maxFilas} filas. Dividilo en partes y importalas una por una.</Aviso>}
                  {filas.length === 0 && <Aviso tono="rojo">No hay filas con datos después de los títulos.</Aviso>}
                  <div className="flex justify-end">
                    <Boton variante="primario" icono={<ArrowRight className="size-4" />} disabled={!filas.length || filas.length > LIMITES_IMPORTACION.maxFilas} onClick={() => setPaso(1)}>Siguiente: columnas</Boton>
                  </div>
                </div>
              )}
            </Tarjeta>
          )}
          <Tarjeta titulo="Importaciones anteriores" sinPadding>
            {!historial ? <Cargando /> : (
              <Tabla
                filas={historial}
                clave={(h) => h.id}
                vacio={<p className="px-4 py-6 text-center text-sm text-tenue">Todavía no hiciste ninguna importación.</p>}
                columnas={[
                  { clave: 'f', titulo: 'Fecha', render: (h) => fechaHora(h.created_at), movil: 'meta' },
                  { clave: 't', titulo: 'Tipo', render: (h) => TIPO_IMPORTACION_LABEL[h.tipo as TipoImportacion], movil: 'titulo' },
                  { clave: 'a', titulo: 'Archivo', render: (h) => h.archivo_nombre, movil: 'subtitulo' },
                  { clave: 'u', titulo: 'Usuario', render: (h) => h.usuario ?? '—', movil: 'meta' },
                  { clave: 'r', titulo: 'Resultado', render: (h) => `${h.creados} nuevos · ${h.actualizados} actualizados · ${h.omitidos} omitidos · ${h.errores} errores`, movil: 'meta' },
                  { clave: 'e', titulo: 'Estado', render: (h) => <Insignia tono={h.estado === 'completada' ? 'verde' : h.estado === 'en_curso' ? 'ambar' : 'gris'}>{h.estado === 'completada' ? 'Completa' : h.estado === 'en_curso' ? 'Sin terminar' : 'Cancelada'}</Insignia>, movil: 'derecha' },
                  {
                    clave: 'd', titulo: '', movil: 'oculta',
                    render: (h) => h.errores + h.omitidos > 0 ? <Boton tam="sm" variante="fantasma" icono={<Download className="size-4" />} onClick={async () => {
                      const d = await api.get(`/importaciones/${h.id}`);
                      descargarCSV(`informe-${h.tipo}-${h.id.slice(0, 8)}`, ['Fila', 'Resultado', 'Referencia', 'Motivo'], d.problemas.map((p: any) => [p.fila, p.severidad === 'error' ? 'Error' : 'Omitida', p.referencia ?? '', p.mensaje]));
                    }}>Informe</Boton> : null,
                  },
                ]}
              />
            )}
          </Tarjeta>
        </div>
      )}

      {/* ───── 2. Columnas ───── */}
      {paso === 1 && tipo && datos && (
        <div className="space-y-4">
          <Tarjeta titulo="Relacioná las columnas de tu archivo con los campos de Fierro" subtitulo="Ya probamos relacionarlas solas. Revisalas y corregí lo que haga falta. Las columnas que no elijas no se importan.">
            <div className="divide-y divide-borde">
              {campos.map((c) => (
                <div key={c.clave} className="grid gap-2 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-center">
                  <div>
                    <p className="text-sm font-medium">{c.etiqueta}{c.requerido && <span className="ml-1 text-red-600">*</span>}</p>
                    {c.ayuda && <p className="text-xs text-tenue">{c.ayuda}</p>}
                  </div>
                  <Select value={mapeo[c.clave] ?? ''} onChange={(e) => setMapeo({ ...mapeo, [c.clave]: e.target.value === '' ? null : Number(e.target.value) })}>
                    <option value="">— No importar —</option>
                    {datos.columnas.map((col, i) => <option key={i} value={i}>{col}{filas[0]?.celdas[i] !== undefined && filas[0].celdas[i] !== '' ? `  (ej.: ${String(filas[0].celdas[i]).slice(0, 25)})` : ''}</option>)}
                  </Select>
                </div>
              ))}
            </div>
            {Object.entries(mapeo).filter(([, c]) => c != null).length > 0 && new Set(Object.values(mapeo).filter((c) => c != null)).size < Object.values(mapeo).filter((c) => c != null).length && (
              <Aviso tono="ambar" className="mt-3">Elegiste la misma columna para más de un campo. Está permitido, pero revisá que sea lo que querés.</Aviso>
            )}
            {tipo === 'articulos' && (mapeo.costo != null || mapeo.precio != null || mapeo.stock_inicial != null) && (
              <Campo className="mt-3" label="Formato de los números" hint="Detectado según tus datos. Cambialo si los importes se ven mal en la vista previa.">
                <Select value={decimal} onChange={(e) => setDecimal(e.target.value as ',' | '.')} className="max-w-sm">
                  <option value=",">1.234,56 (coma decimal, como en Argentina)</option>
                  <option value=".">1,234.56 (punto decimal)</option>
                </Select>
              </Campo>
            )}
          </Tarjeta>
          <Tarjeta titulo="Vista previa" subtitulo="Las primeras filas, tal como se leerían con esta relación de columnas" sinPadding>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-borde bg-slate-50 text-left text-xs uppercase text-tenue"><th className="px-3 py-2">Fila</th>{campos.filter((c) => mapeo[c.clave] != null).map((c) => <th key={c.clave} className="px-3 py-2">{c.etiqueta}</th>)}</tr></thead>
                <tbody>
                  {filas.slice(0, 6).map((f) => (
                    <tr key={f.n} className="border-b border-borde last:border-0">
                      <td className="px-3 py-2 text-tenue">{f.n}</td>
                      {campos.filter((c) => mapeo[c.clave] != null).map((c) => <td key={c.clave} className="max-w-[220px] truncate px-3 py-2">{String(f.celdas[mapeo[c.clave]!] ?? '')}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Tarjeta>
          {faltantes.length > 0 && <Aviso tono="ambar">Falta relacionar: {faltantes.map((f) => f.etiqueta).join(', ')}.</Aviso>}
          {!tieneReferencia && <Aviso tono="ambar">Para vincular cada vehículo con su cliente relacioná al menos una de las columnas del cliente (documento, código o nombre).</Aviso>}
          <div className="flex justify-between">
            <Boton icono={<ArrowLeft className="size-4" />} onClick={() => setPaso(0)}>Atrás</Boton>
            <Boton variante="primario" icono={<ArrowRight className="size-4" />} disabled={faltantes.length > 0 || !tieneReferencia} onClick={() => setPaso(2)}>Siguiente: opciones</Boton>
          </div>
        </div>
      )}

      {/* ───── 3. Opciones ───── */}
      {paso === 2 && tipo && (
        <div className="space-y-4">
          <Tarjeta titulo="¿Qué hacemos con los registros que ya existen?" subtitulo="Los nombres nunca se usan para detectar repetidos: dos personas pueden llamarse igual. Se usan el documento, la patente, los códigos y el CUIT.">
            <div className="space-y-2">
              {MODOS_IMPORTACION.map((m) => (
                <label key={m} className={cn('flex cursor-pointer gap-3 rounded-lg border p-3', modo === m ? 'border-marca-500 bg-marca-50' : 'border-borde')}>
                  <input type="radio" name="modo" checked={modo === m} onChange={() => setModo(m)} className="mt-1" />
                  <span><span className="block font-medium">{MODO_IMPORTACION_LABEL[m].titulo}</span><span className="block text-sm text-tenue">{MODO_IMPORTACION_LABEL[m].detalle}</span></span>
                </label>
              ))}
            </div>
            {modo === 'actualizar' && <Aviso className="mt-3" tono="ambar">Antes de confirmar vas a ver, fila por fila, qué campos cambian y de qué valor a cuál. Una celda vacía nunca borra un dato.</Aviso>}
          </Tarjeta>
          {(tipo === 'vehiculos' || tipo === 'articulos') && (
            <Tarjeta titulo={tipo === 'vehiculos' ? 'Marcas y modelos' : 'Categorías'}>
              <Check checked={crearCatalogos} onChange={setCrearCatalogos} label={tipo === 'vehiculos' ? 'Crear las marcas y modelos que no existan' : 'Crear las categorías que no existan'} />
              <p className="mt-1 pl-6 text-xs text-tenue">Si lo desactivás, las filas con {tipo === 'vehiculos' ? 'marcas o modelos' : 'categorías'} nuevas se informan como error. En la revisión vas a ver cuáles se crearían.</p>
            </Tarjeta>
          )}
          {tipo === 'articulos' && (
            <Tarjeta titulo="Existencias (stock)" subtitulo="Importar el catálogo no carga stock: son dos cosas distintas.">
              {mapeo.stock_inicial == null ? (
                <p className="text-sm text-tenue">No relacionaste ninguna columna de existencia, así que se importa solo el catálogo. Podés cargar el stock después con un conteo de inventario.</p>
              ) : (
                <div className="space-y-3">
                  <Check checked={stock.activo} onChange={(v) => setStock({ ...stock, activo: v, confirmado: false })} label="Cargar también las existencias del archivo como stock inicial" />
                  {stock.activo && (
                    <div className="ml-6 space-y-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm">
                      <p>Para cada artículo <b>nuevo</b> se registra una <b>entrada de stock</b> valorizada a su costo. En Contabilidad aparece como “entradas de mercadería sin compra (a clasificar)”. No se cargan existencias en artículos que ya existían ni se generan deudas ni saldos.</p>
                      {puede('stock.ajustar') ? (
                        <>
                          <Campo label="Depósito donde entra la mercadería">
                            <Select value={stock.deposito_id} onChange={(e) => setStock({ ...stock, deposito_id: e.target.value })} className="max-w-sm">
                              <option value="">Depósito principal</option>
                              {(depositos ?? []).filter((d) => d.activo).map((d) => <option key={d.id} value={d.id}>{d.nombre}</option>)}
                            </Select>
                          </Campo>
                          <Check checked={stock.confirmado} onChange={(v) => setStock({ ...stock, confirmado: v })} label="Entiendo cómo se registra y quiero cargar las existencias" />
                        </>
                      ) : <p className="text-red-700">No tenés permiso para ajustar stock, así que esta opción no se puede usar.</p>}
                    </div>
                  )}
                </div>
              )}
            </Tarjeta>
          )}
          <Aviso>Los <b>saldos</b> de caja, de clientes y de proveedores no se importan desde estas planillas. Cada uno tiene su propio procedimiento (conteo de inventario, apertura de caja, saldo inicial bancario, comprobantes con fecha de corte o asiento manual) para que Contabilidad y las cuentas corrientes sigan cuadrando. Está explicado en <code>docs/IMPORTACION.md</code>.</Aviso>
          <div className="flex justify-between">
            <Boton icono={<ArrowLeft className="size-4" />} onClick={() => setPaso(1)}>Atrás</Boton>
            <Boton variante="primario" icono={<ArrowRight className="size-4" />} cargando={!!progreso} disabled={tipo === 'articulos' && stock.activo && !stock.confirmado} onClick={() => revisar()}>Revisar el archivo</Boton>
          </div>
          {progreso && (
            <div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-marca-500 transition-all" style={{ width: `${(progreso.hechos / progreso.total) * 100}%` }} /></div>
              <p className="mt-1 text-xs text-tenue">{progreso.texto} {progreso.hechos} de {progreso.total}</p>
            </div>
          )}
        </div>
      )}

      {/* ───── 4. Revisión ───── */}
      {paso === 3 && tipo && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {([['crear', 'Se crean', 'text-emerald-700'], ['actualizar', 'Se actualizan', 'text-marca-700'], ['omitir', 'Se omiten', 'text-slate-600'], ['error', 'Con errores', 'text-red-700']] as const).map(([k, t, c]) => (
              <button key={k} type="button" onClick={() => setFiltro(k)} className={cn('rounded-xl border bg-white p-3 text-left', filtro === k ? 'border-marca-400 ring-1 ring-marca-300' : 'border-borde')}>
                <p className="text-xs text-tenue">{t}</p>
                <p className={cn('text-2xl font-bold tabular-nums', c)}>{resumen[k]}</p>
              </button>
            ))}
          </div>

          {pendientes.length > 0 && (
            <Tarjeta titulo="Referencias para resolver" subtitulo="Estas filas apuntan a registros que no se encontraron (o hay más de uno). Elegí a cuál corresponde cada uno y volvé a revisar; o importá primero lo que falta.">
              <div className="space-y-3">
                {pendientes.map(([k, p]) => (
                  <div key={k} className="grid gap-2 rounded-lg border border-borde p-3 sm:grid-cols-[1fr_1.2fr] sm:items-center">
                    <div className="text-sm">
                      <p className="font-medium">{p.tipo === 'cliente' ? 'Cliente' : 'Proveedor'}: {p.etiqueta}</p>
                      <p className="text-xs text-tenue">{p.motivo === 'ambiguo' ? 'Hay más de uno que coincide' : 'No existe en Fierro'} · {p.filas.length} fila{p.filas.length === 1 ? '' : 's'} (ej.: {p.filas.slice(0, 4).join(', ')})</p>
                    </div>
                    {p.tipo === 'cliente' ? (
                      <ElegirCliente valorId={resoluciones[`cliente:${p.clave}`]} onElegir={(c) => setResoluciones((r) => { const n = { ...r }; if (c) n[`cliente:${p.clave}`] = c.id; else delete n[`cliente:${p.clave}`]; return n; })} />
                    ) : (
                      <Select value={resoluciones[`proveedor:${p.clave}`] ?? ''} onChange={(e) => setResoluciones((r) => { const n = { ...r }; if (e.target.value) n[`proveedor:${p.clave}`] = e.target.value; else delete n[`proveedor:${p.clave}`]; return n; })}>
                        <option value="">Elegir proveedor…</option>
                        {(proveedores ?? []).filter((x) => x.activo).map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
                      </Select>
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Boton variante="primario" tam="sm" disabled={!Object.keys(resoluciones).length} cargando={!!progreso} onClick={() => revisar(resoluciones)}>Volver a revisar con estas elecciones</Boton>
                <Boton tam="sm" icono={<Download className="size-4" />} onClick={() => descargarCSV(`referencias-faltantes-${tipo}`, ['Tipo', 'Referencia', 'Motivo', 'Filas afectadas'], pendientes.map(([, p]) => [p.tipo, p.etiqueta, p.motivo === 'ambiguo' ? 'Hay más de uno' : 'No existe', p.filas.join(', ')]))}>Descargar lista de faltantes</Boton>
              </div>
            </Tarjeta>
          )}

          <Tarjeta
            titulo={`${ETIQUETA_ACCION[filtro]} (${resumen[filtro]})`}
            sinPadding
            acciones={(resumen.error > 0 || resumen.omitir > 0) && <Boton tam="sm" icono={<Download className="size-4" />} onClick={() => descargarProblemas(resultados, true)}>Descargar informe de errores</Boton>}
          >
            <Tabla
              filas={resultados.filter((r) => r.accion === filtro).slice(0, 300)}
              clave={(r) => String(r.n)}
              vacio={<p className="px-4 py-6 text-center text-sm text-tenue">No hay filas en esta categoría.</p>}
              columnas={[
                { clave: 'n', titulo: 'Fila', render: (r) => r.n, movil: 'meta' },
                { clave: 'ref', titulo: 'Registro', render: (r) => r.ref || '—', movil: 'titulo' },
                {
                  clave: 'det', titulo: 'Detalle', movil: 'subtitulo',
                  render: (r) => (
                    <div className="space-y-0.5 whitespace-normal">
                      {r.errores.map((e, i) => <p key={i} className="text-red-700">{e}</p>)}
                      {r.motivo && <p className="text-slate-600">{r.motivo}</p>}
                      {r.cambios?.map((c, i) => <p key={i}><span className="font-medium">{c.campo}:</span> <span className="text-slate-500 line-through">{c.antes ?? '(vacío)'}</span> → <span className="font-medium text-marca-700">{c.despues}</span></p>)}
                      {r.nuevos?.map((x, i) => <p key={i} className="text-emerald-700">Se crea: {x}</p>)}
                      {r.avisos.map((a, i) => <p key={i} className="text-amber-700">⚠ {a}</p>)}
                    </div>
                  ),
                },
              ]}
            />
            {resumen[filtro] > 300 && <p className="border-t border-borde px-4 py-2 text-xs text-tenue">Se muestran las primeras 300. El informe descargable incluye todas.</p>}
          </Tarjeta>

          <Tarjeta titulo="Confirmar">
            {importables === 0 ? (
              <Aviso tono="ambar">No hay nada para importar con esta configuración. Corregí el archivo o cambiá las opciones.</Aviso>
            ) : (
              <p className="text-sm">Se van a <b>crear {resumen.crear}</b> y <b>actualizar {resumen.actualizar}</b> registros de {TIPO_IMPORTACION_LABEL[tipo].toLowerCase()}. {resumen.omitir > 0 && <>Se omiten {resumen.omitir} (ya existían o no cambian). </>}Cada lote se guarda por separado; si se corta la conexión podés retomar sin duplicar nada.</p>
            )}
            {resumen.error > 0 && <div className="mt-3"><Check checked={aceptaErrores} onChange={setAceptaErrores} label={`Entiendo que las ${resumen.error} filas con errores no se van a importar (las puedo corregir y cargar después con el informe)`} /></div>}
          </Tarjeta>
          <div className="flex justify-between">
            <Boton icono={<ArrowLeft className="size-4" />} onClick={() => setPaso(2)}>Cambiar opciones</Boton>
            <Boton variante="primario" disabled={importables === 0 || (resumen.error > 0 && !aceptaErrores)} onClick={importar}>Importar {importables} registros</Boton>
          </div>
        </div>
      )}

      {/* ───── 5. Importación ───── */}
      {paso === 4 && tipo && (
        <Tarjeta titulo={final ? 'Importación terminada' : 'Importando…'}>
          {!final ? (
            <div className="space-y-3">
              {progreso && (
                <>
                  <div className="h-2.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-marca-500 transition-all" style={{ width: `${(progreso.hechos / progreso.total) * 100}%` }} /></div>
                  <p className="text-sm text-tenue">{progreso.texto} Lote {Math.min(progreso.hechos + 1, progreso.total)} de {progreso.total}. No cierres esta pantalla.</p>
                </>
              )}
              {error && (
                <div className="flex flex-wrap items-center gap-2">
                  <AlertTriangle className="size-5 text-amber-600" />
                  <span className="text-sm">Se interrumpió. Lo ya importado quedó guardado y no se va a repetir.</span>
                  <Boton variante="primario" tam="sm" onClick={importar}>Reintentar</Boton>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-emerald-700"><CheckCircle2 className="size-6" /><span className="text-lg font-semibold">Listo</span></div>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {([['Creados', final.creados], ['Actualizados', final.actualizados], ['Omitidos', final.omitidos], ['Con errores', final.errores]] as const).map(([t, v]) => (
                  <div key={t} className="rounded-xl border border-borde p-3"><p className="text-xs text-tenue">{t}</p><p className="text-2xl font-bold tabular-nums">{v}</p></div>
                ))}
              </div>
              {final.previa && <Aviso tono="ambar">Este mismo archivo ya se había importado antes ({fechaHora(final.previa.created_at)}{final.previa.usuario ? `, por ${final.previa.usuario}` : ''}). Lo que ya existía se omitió o actualizó según la opción elegida.</Aviso>}
              <div className="flex flex-wrap gap-2">
                {(final.errores > 0 || final.omitidos > 0) && <Boton icono={<Download className="size-4" />} onClick={() => descargarProblemas(final.resultados, true)}>Descargar informe de errores y omitidos</Boton>}
                <Boton variante="primario" onClick={reiniciar}>Importar otro archivo</Boton>
              </div>
              <p className="text-xs text-tenue">Quedó registrado quién importó, cuándo, con qué archivo y el resultado. Podés verlo en “Importaciones anteriores”.</p>
            </div>
          )}
        </Tarjeta>
      )}
    </>
  );
}

function ElegirCliente({ valorId, onElegir }: { valorId?: string; onElegir: (c: ClienteMin | null) => void }) {
  const [c, setC] = useState<ClienteMin | null>(null);
  return <SelectorCliente valor={valorId ? c : null} onCambio={(x) => { setC(x); onElegir(x); }} />;
}
