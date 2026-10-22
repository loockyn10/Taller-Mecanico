// Apertura de saldos: cómo empieza a operar en Fierro un taller que viene de otro sistema. Los saldos de caja, bancos e inventario ya se cargan en sus pantallas;
// acá se ve cuáles están declarados y se cargan las deudas con proveedores (sin crear compras falsas ni tocar los resultados).
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, FileUp, Plus, Trash2 } from 'lucide-react';
import { api, nuevaClave } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fecha, hoyISO, money } from '@/lib/format';
import { leerArchivo, type ArchivoLeido } from '@/lib/archivo';
import { Aviso, Boton, Campo, Cargando, Check, Encabezado, ErrorCaja, Input, Insignia, Modal, Select, Tabla, Tarjeta, Textarea, useToast } from '@/components/ui';

interface FilaEntrada { n: number; proveedor_id?: string; proveedor?: string; importe: string; referencia: string; vencimiento: string }
interface FilaRevisada { n: number; estado: 'ok' | 'aviso' | 'error'; proveedor: string | null; importe: number | null; referencia: string | null; vencimiento: string | null; mensajes: string[] }
interface Revision { filas: FilaRevisada[]; resumen: { filas: number; correctas: number; con_aviso: number; con_error: number; deuda: number; a_favor: number; total: number; puede_confirmar: boolean } }

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Fecha de una celda de planilla: número de serie de Excel, dd/mm/aaaa o ya ISO. Devuelve '' si no se reconoce (el servidor lo informa). */
function fechaDeCelda(c: string | number | undefined): string {
  if (c == null || c === '') return '';
  if (typeof c === 'number' && c > 20000 && c < 80000) return new Date(Date.UTC(1899, 11, 30) + c * 86400000).toISOString().slice(0, 10);
  const t = String(c).trim();
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return t;
}

function adivinarColumnas(cols: string[]) {
  const buscar = (re: RegExp, usadas: number[]) => cols.findIndex((c, i) => !usadas.includes(i) && re.test(norm(c)));
  const proveedor = buscar(/cuit|proveedor|razon|nombre|codigo/, []);
  const importe = buscar(/saldo|deuda|importe|monto|total/, [proveedor]);
  const referencia = buscar(/comprobante|referencia|factura|detalle/, [proveedor, importe]);
  const vencimiento = buscar(/vencim/, [proveedor, importe, referencia]);
  return { proveedor, importe, referencia, vencimiento };
}

export function AperturaSaldos() {
  const { puede } = useAuth();
  if (!puede('aperturas.gestionar')) return <Aviso tono="ambar">No tenés permiso para cargar saldos de apertura.</Aviso>;
  return (
    <>
      <Encabezado titulo="Apertura de saldos" subtitulo="Los saldos con que el taller empieza a operar en Fierro si viene de otro sistema" />
      <div className="space-y-5">
        <EstadoApertura />
        <CargarProveedores />
        <Aperturas />
      </div>
    </>
  );
}

function EstadoApertura() {
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['aperturas', 'estado'], queryFn: () => api.get('/aperturas/estado') });
  if (isLoading) return <Cargando />;
  if (error || !data) return <ErrorCaja error={error} reintentar={refetch} />;
  const ok = (b: boolean) => <Insignia tono={b ? 'verde' : 'gris'}>{b ? 'Declarado' : 'Sin declarar'}</Insignia>;
  return (
    <Tarjeta titulo="¿Qué saldos iniciales tiene el taller?" subtitulo="Cada uno se carga donde corresponde; ninguno se registra como venta, compra ni resultado.">
      <ul className="divide-y divide-borde text-sm">
        <li className="flex flex-wrap items-center justify-between gap-2 py-2.5">
          <div>
            <p className="font-medium">Caja (efectivo)</p>
            <p className="text-xs text-tenue">Se declara como efectivo inicial al abrir la primera caja. {data.caja.operaciones_previas ? 'Ya hubo movimientos: no se puede cambiar.' : ''}</p>
          </div>
          <div className="text-right">{ok(data.caja.estado === 'declarada')} {data.caja.efectivo_inicial != null && <span className="ml-1 tabular-nums">{money(data.caja.efectivo_inicial)}</span>}</div>
        </li>
        <li className="py-2.5">
          <p className="font-medium">Cuentas bancarias</p>
          <p className="text-xs text-tenue">El saldo inicial se indica al crear cada cuenta (con su fecha). Las cuentas en dólares se registran pero no se contabilizan todavía.</p>
          {data.bancos.length === 0 ? <p className="mt-1 text-xs">No hay cuentas bancarias.</p> : (
            <ul className="mt-1 space-y-0.5">{data.bancos.map((b: any) => (
              <li key={b.nombre} className="flex justify-between text-xs"><span>{b.nombre}{b.moneda !== 'ARS' ? ` (${b.moneda})` : ''}</span><span className="tabular-nums">{money(b.saldo_inicial)}{b.fecha ? ` · ${fecha(b.fecha)}` : ''}</span></li>
            ))}</ul>
          )}
        </li>
        <li className="flex flex-wrap items-center justify-between gap-2 py-2.5">
          <div>
            <p className="font-medium">Inventario</p>
            <p className="text-xs text-tenue">Se carga como entrada de stock inicial valorizada (al crear el artículo o con la importación «Existencias iniciales»). Queda «a clasificar» en contabilidad.</p>
          </div>
          <div className="text-right text-xs tabular-nums">{data.inventario.con_existencias} de {data.inventario.articulos} artículos con existencias</div>
        </li>
        <li className="flex flex-wrap items-center justify-between gap-2 py-2.5">
          <div>
            <p className="font-medium">Deudas con proveedores</p>
            <p className="text-xs text-tenue">Se cargan abajo, una vez por proveedor y con fecha de corte.</p>
          </div>
          <div className="text-right text-sm">{ok(data.proveedores.aperturas_vigentes > 0)} {data.proveedores.aperturas_vigentes > 0 && <span className="ml-1 tabular-nums">{money(data.proveedores.total)}</span>}</div>
        </li>
        <li className="py-2.5">
          <p className="font-medium">Deudas de clientes <Insignia tono="ambar">Todavía no disponible</Insignia></p>
          <p className="mt-0.5 text-xs text-tenue">{data.clientes.motivo}</p>
        </li>
      </ul>
    </Tarjeta>
  );
}

function CargarProveedores() {
  const toast = useToast();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const clave = useRef(nuevaClave());
  const [corte, setCorte] = useState(hoyISO());
  const [origen, setOrigen] = useState('');
  const [notas, setNotas] = useState('');
  const [decimal, setDecimal] = useState<',' | '.'>(',');
  const [filas, setFilas] = useState<FilaEntrada[]>([]);
  const [archivo, setArchivo] = useState<ArchivoLeido | null>(null);
  const [cols, setCols] = useState<{ proveedor: number; importe: number; referencia: number; vencimiento: number }>({ proveedor: -1, importe: -1, referencia: -1, vencimiento: -1 });
  const [rev, setRev] = useState<Revision | null>(null);
  const [aceptaAvisos, setAceptaAvisos] = useState(false);
  const provs = useQuery({ queryKey: ['proveedores', 'selector'], queryFn: () => api.get('/proveedores') });

  const hoja = archivo?.hojas[0];
  const encabezados = (hoja?.filas[0] ?? []).map((c) => String(c ?? ''));

  const cargarArchivo = async (f: File | undefined) => {
    if (!f) return;
    try {
      const a = await leerArchivo(f);
      setArchivo(a);
      const h = a.hojas[0].filas[0].map((c) => String(c ?? ''));
      const c = adivinarColumnas(h);
      setCols(c);
      aplicarArchivo(a, c);
    } catch (e) {
      toast.error(e);
    }
  };
  const aplicarArchivo = (a: ArchivoLeido, c: typeof cols) => {
    if (c.proveedor < 0 || c.importe < 0) {
      setFilas([]);
      return;
    }
    const celda = (r: (string | number)[], i: number) => (i >= 0 ? r[i] : undefined);
    setFilas(
      a.hojas[0].filas
        .slice(1)
        .map((r, i) => ({ n: i + 2, r }))
        .filter(({ r }) => r.some((x) => String(x ?? '').trim() !== ''))
        .map(({ n, r }) => ({
          n, proveedor: String(celda(r, c.proveedor) ?? ''), importe: String(celda(r, c.importe) ?? ''),
          referencia: String(celda(r, c.referencia) ?? ''), vencimiento: fechaDeCelda(celda(r, c.vencimiento)),
        })),
    );
    setRev(null);
  };

  const revisar = useMutation({
    mutationFn: () => api.post('/aperturas/proveedores/validar', { fecha_corte: corte, decimal, filas: filas.map((f) => ({ n: f.n, proveedor_id: f.proveedor_id || null, proveedor: f.proveedor || null, importe: f.importe, referencia: f.referencia || null, vencimiento: f.vencimiento || null })) }),
    onSuccess: (r: Revision) => { setRev(r); setAceptaAvisos(false); },
    onError: (e) => toast.error(e),
  });
  const confirmar = useMutation({
    mutationFn: () => api.post('/aperturas/proveedores', { fecha_corte: corte, origen, notas: notas || null, decimal, idem_key: clave.current, acepta_avisos: aceptaAvisos, filas: filas.map((f) => ({ n: f.n, proveedor_id: f.proveedor_id || null, proveedor: f.proveedor || null, importe: f.importe, referencia: f.referencia || null, vencimiento: f.vencimiento || null })) }),
    onSuccess: (r: any) => {
      toast.ok(r.duplicado ? `La apertura N° ${r.numero} ya estaba registrada` : `Apertura N° ${r.numero} registrada`);
      clave.current = nuevaClave();
      setFilas([]); setRev(null); setArchivo(null); setOrigen(''); setNotas('');
      qc.invalidateQueries({ queryKey: ['aperturas'] });
      qc.invalidateQueries({ queryKey: ['contab'] });
    },
    onError: (e) => toast.error(e),
  });

  const cambiar = (i: number, p: Partial<FilaEntrada>) => { setFilas((x) => x.map((f, j) => (j === i ? { ...f, ...p } : f))); setRev(null); };
  const listo = filas.length > 0 && origen.trim().length >= 3 && corte;

  return (
    <Tarjeta titulo="Deudas con proveedores al corte" subtitulo="Una sola vez por proveedor. Quedan en su cuenta corriente y se pagan como cualquier deuda; no son compras, no mueven stock ni afectan el resultado.">
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Campo label="Fecha de corte" requerido hint="Hasta qué día están los saldos"><Input type="date" max={hoyISO()} value={corte} onChange={(e) => { setCorte(e.target.value); setRev(null); }} /></Campo>
          <Campo label="Sistema o planilla de origen" requerido className="sm:col-span-2"><Input value={origen} maxLength={200} placeholder="Ej.: Caldén · cuentas corrientes de proveedores al 30/09" onChange={(e) => setOrigen(e.target.value)} /></Campo>
        </div>
        <Campo label="Notas (opcional)"><Textarea rows={2} maxLength={500} value={notas} onChange={(e) => setNotas(e.target.value)} /></Campo>

        <div className="flex flex-wrap items-center gap-2">
          <input ref={input} type="file" accept=".xlsx,.csv,.txt,.tsv" className="hidden" onChange={(e) => { cargarArchivo(e.target.files?.[0]); e.target.value = ''; }} />
          <Boton icono={<FileUp className="size-4" />} onClick={() => input.current?.click()}>Cargar desde Excel o CSV</Boton>
          <Boton icono={<Plus className="size-4" />} onClick={() => { setFilas((x) => [...x, { n: x.length + 1, proveedor_id: '', importe: '', referencia: '', vencimiento: '' }]); setRev(null); }}>Agregar un proveedor</Boton>
          <Campo label="Decimales" className="ml-auto"><Select value={decimal} onChange={(e) => setDecimal(e.target.value as ',' | '.')}><option value=",">Coma (1.234,56)</option><option value=".">Punto (1,234.56)</option></Select></Campo>
        </div>

        {archivo && (
          <div className="rounded-lg bg-slate-50 p-3 text-sm">
            <p className="mb-2 font-medium">{archivo.nombre} · indicá qué columna es cada dato</p>
            <div className="grid gap-2 sm:grid-cols-4">
              {([['proveedor', 'Proveedor (CUIT, código o nombre)'], ['importe', 'Saldo'], ['referencia', 'Comprobante (opcional)'], ['vencimiento', 'Vencimiento (opcional)']] as const).map(([k, t]) => (
                <Campo key={k} label={t}>
                  <Select value={cols[k]} onChange={(e) => { const c = { ...cols, [k]: Number(e.target.value) }; setCols(c); aplicarArchivo(archivo, c); }}>
                    <option value={-1}>— ninguna —</option>
                    {encabezados.map((h, i) => <option key={i} value={i}>{h || `Columna ${i + 1}`}</option>)}
                  </Select>
                </Campo>
              ))}
            </div>
            <p className="mt-2 text-xs text-tenue">La primera fila se toma como títulos. Un saldo positivo es lo que se debe; uno negativo, un saldo a favor del taller.</p>
          </div>
        )}

        {filas.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-borde text-left text-xs font-semibold uppercase text-tenue"><th className="py-1.5 pr-2">Proveedor</th><th className="pr-2">Saldo</th><th className="pr-2">Comprobante</th><th className="pr-2">Vence</th><th /></tr></thead>
              <tbody>
                {filas.map((f, i) => (
                  <tr key={i} className="border-b border-borde last:border-0">
                    <td className="py-1 pr-2">
                      {f.proveedor_id !== undefined ? (
                        <Select value={f.proveedor_id} onChange={(e) => cambiar(i, { proveedor_id: e.target.value })}>
                          <option value="">Elegí un proveedor…</option>
                          {(provs.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                        </Select>
                      ) : <Input value={f.proveedor ?? ''} onChange={(e) => cambiar(i, { proveedor: e.target.value })} />}
                    </td>
                    <td className="pr-2"><Input inputMode="decimal" className="w-32" value={f.importe} onChange={(e) => cambiar(i, { importe: e.target.value })} /></td>
                    <td className="pr-2"><Input className="w-36" value={f.referencia} onChange={(e) => cambiar(i, { referencia: e.target.value })} /></td>
                    <td className="pr-2"><Input type="date" className="w-40" value={f.vencimiento} onChange={(e) => cambiar(i, { vencimiento: e.target.value })} /></td>
                    <td><Boton variante="fantasma" tam="sm" aria-label="Quitar" icono={<Trash2 className="size-4" />} onClick={() => { setFilas((x) => x.filter((_, j) => j !== i)); setRev(null); }} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {filas.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Boton variante="primario" disabled={!listo} cargando={revisar.isPending} onClick={() => revisar.mutate()}>Revisar antes de guardar</Boton>
            {!listo && <span className="text-xs text-tenue">Completá la fecha de corte y el origen.</span>}
          </div>
        )}

        {rev && (
          <div className="space-y-3">
            <Aviso tono={rev.resumen.con_error ? 'rojo' : rev.resumen.con_aviso ? 'ambar' : 'verde'}>
              {rev.resumen.filas} fila(s): {rev.resumen.correctas} correcta(s), {rev.resumen.con_aviso} con aviso, {rev.resumen.con_error} con error. Deuda {money(rev.resumen.deuda)}
              {rev.resumen.a_favor ? ` · a favor del taller ${money(rev.resumen.a_favor)}` : ''} · total {money(rev.resumen.total)}. Todavía no se guardó nada.
            </Aviso>
            <Tabla
              clave={(f: FilaRevisada) => String(f.n)}
              filas={rev.filas.filter((f) => f.estado !== 'ok' || rev.filas.length <= 30)}
              columnas={[
                { clave: 'n', titulo: 'Fila', render: (f: FilaRevisada) => f.n, movil: 'meta' },
                { clave: 'p', titulo: 'Proveedor', render: (f: FilaRevisada) => f.proveedor ?? '—', movil: 'titulo' },
                { clave: 'i', titulo: 'Saldo', render: (f: FilaRevisada) => (f.importe == null ? '—' : money(f.importe)), alinear: 'derecha', movil: 'derecha' },
                { clave: 'e', titulo: 'Estado', render: (f: FilaRevisada) => <Insignia tono={f.estado === 'ok' ? 'verde' : f.estado === 'aviso' ? 'ambar' : 'rojo'}>{f.estado === 'ok' ? 'Correcta' : f.estado === 'aviso' ? 'Aviso' : 'Error'}</Insignia>, movil: 'meta' },
                { clave: 'm', titulo: 'Detalle', render: (f: FilaRevisada) => f.mensajes.join(' · ') || '—', movil: 'subtitulo' },
              ]}
            />
            {rev.resumen.con_aviso > 0 && rev.resumen.puede_confirmar && (
              <Check checked={aceptaAvisos} onChange={setAceptaAvisos} label="Revisé los avisos y confirmo que los saldos no incluyen operaciones ya cargadas en Fierro" />
            )}
            <Boton variante="primario" disabled={!rev.resumen.puede_confirmar || (rev.resumen.con_aviso > 0 && !aceptaAvisos)} cargando={confirmar.isPending} onClick={() => confirmar.mutate()}>
              Guardar la apertura
            </Boton>
          </div>
        )}
      </div>
    </Tarjeta>
  );
}

function Aperturas() {
  const toast = useToast();
  const qc = useQueryClient();
  const [anular, setAnular] = useState<any>(null);
  const [motivo, setMotivo] = useState('');
  const [ver, setVer] = useState<any>(null);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['aperturas', 'lista'], queryFn: () => api.get('/aperturas') });
  const detalle = useQuery({ queryKey: ['aperturas', 'detalle', ver?.id], queryFn: () => api.get(`/aperturas/${ver.id}`), enabled: !!ver });
  const anulando = useMutation({
    mutationFn: () => api.post(`/aperturas/${anular.id}/anular`, { motivo }),
    onSuccess: () => { toast.ok('Apertura anulada'); setAnular(null); setMotivo(''); qc.invalidateQueries({ queryKey: ['aperturas'] }); qc.invalidateQueries({ queryKey: ['contab'] }); },
    onError: (e) => toast.error(e),
  });
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  return (
    <>
      <Tarjeta titulo="Aperturas registradas" sinPadding>
        <Tabla
          clave={(a: any) => a.id}
          filas={data ?? []}
          onFila={setVer}
          vacio={<p className="p-5 text-sm text-tenue">Todavía no se cargó ninguna apertura de saldos.</p>}
          columnas={[
            { clave: 'n', titulo: 'N°', render: (a: any) => a.numero, movil: 'titulo' },
            { clave: 'f', titulo: 'Corte', render: (a: any) => fecha(a.fecha_corte), movil: 'subtitulo' },
            { clave: 'o', titulo: 'Origen', render: (a: any) => a.origen, movil: 'meta' },
            { clave: 'c', titulo: 'Proveedores', render: (a: any) => a.cantidad, alinear: 'derecha', movil: 'meta' },
            { clave: 't', titulo: 'Total', render: (a: any) => money(a.total), alinear: 'derecha', movil: 'derecha' },
            { clave: 'u', titulo: 'Cargó', render: (a: any) => a.usuario ?? '—', movil: 'meta' },
            { clave: 'e', titulo: 'Estado', render: (a: any) => <Insignia tono={a.estado === 'vigente' ? 'verde' : 'gris'}>{a.estado === 'vigente' ? 'Vigente' : 'Anulada'}</Insignia>, movil: 'meta' },
            { clave: 'x', titulo: '', render: (a: any) => a.estado === 'vigente' ? <Boton tam="sm" variante="fantasma" icono={<Ban className="size-4" />} onClick={(e) => { e.stopPropagation(); setAnular(a); }}>Anular</Boton> : null, movil: 'meta' },
          ]}
        />
      </Tarjeta>
      <Modal abierto={!!anular} onCerrar={() => setAnular(null)} titulo={`Anular la apertura N° ${anular?.numero ?? ''}`}
        pie={<><Boton onClick={() => setAnular(null)}>Cancelar</Boton><Boton variante="peligro" disabled={motivo.trim().length < 3} cargando={anulando.isPending} onClick={() => anulando.mutate()}>Anular apertura</Boton></>}>
        <p className="mb-3 text-sm text-tenue">Las deudas cargadas dejan de figurar en las cuentas corrientes de los proveedores y se contabiliza el contra-asiento. No se puede anular si alguna deuda ya tiene pagos aplicados: anulá primero esos pagos.</p>
        <Campo label="Motivo" requerido><Textarea rows={2} maxLength={300} value={motivo} onChange={(e) => setMotivo(e.target.value)} /></Campo>
      </Modal>
      <Modal abierto={!!ver} onCerrar={() => setVer(null)} titulo={`Apertura N° ${ver?.numero ?? ''} · corte ${ver ? fecha(ver.fecha_corte) : ''}`} ancho="lg">
        {detalle.isLoading ? <Cargando /> : detalle.data && (
          <div className="space-y-2 text-sm">
            <p className="text-tenue">Origen: {detalle.data.origen}{detalle.data.notas ? ` · ${detalle.data.notas}` : ''}</p>
            {detalle.data.estado === 'anulada' && <Aviso tono="ambar">Anulada: {detalle.data.motivo_anulacion}</Aviso>}
            <Tabla
              clave={(i: any) => i.id}
              filas={detalle.data.items}
              columnas={[
                { clave: 'p', titulo: 'Proveedor', render: (i: any) => i.proveedor, movil: 'titulo' },
                { clave: 'r', titulo: 'Comprobante', render: (i: any) => i.referencia ?? '—', movil: 'subtitulo' },
                { clave: 'v', titulo: 'Vence', render: (i: any) => (i.vencimiento ? fecha(i.vencimiento) : '—'), movil: 'meta' },
                { clave: 'i', titulo: 'Saldo', render: (i: any) => money(i.importe), alinear: 'derecha', movil: 'derecha' },
              ]}
            />
          </div>
        )}
      </Modal>
    </>
  );
}
