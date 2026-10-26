import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { CheckCircle2, ChevronDown, ChevronRight, Circle, Image as ImageIcon, MinusCircle, Rocket, Upload } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { guardarConfig, prepararLogo, usePuesta, type EstadoPuesta } from '@/lib/puesta';
import { Aviso, Boton, Campo, Cargando, Check, cn, Encabezado, ErrorCaja, Input, InputMoneda, Insignia, Select, Tarjeta, useToast } from '@/components/ui';
import { CONDICIONES_IVA, CONDICION_IVA_LABEL, MEDIO_PAGO_LABEL, MEDIOS_PAGO } from '@shared/dominio';
import { ZONAS_HORARIAS } from '@shared/permisos';
import { DIAS_SEMANA, horariosPorDefecto, INFO_PASOS, type HorariosAtencion, type Paso } from '@shared/puesta';
import { AVISO_TIEMPOS_ORIENTATIVOS } from '@shared/tempario';

const PROVINCIAS = ['Buenos Aires', 'CABA', 'Catamarca', 'Chaco', 'Chubut', 'Córdoba', 'Corrientes', 'Entre Ríos', 'Formosa', 'Jujuy', 'La Pampa', 'La Rioja', 'Mendoza', 'Misiones', 'Neuquén', 'Río Negro', 'Salta', 'San Juan', 'San Luis', 'Santa Cruz', 'Santa Fe', 'Santiago del Estero', 'Tierra del Fuego', 'Tucumán'];

/** Cierra un paso y refresca el progreso. */
function useMarcar() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ paso, estado }: { paso: Paso; estado: 'hecho' | 'omitido' | 'pendiente' }) => api.put<EstadoPuesta>(`/puesta-en-marcha/pasos/${paso}`, { estado }),
    onSuccess: (e) => qc.setQueryData(['puesta'], e),
    onError: toast.error,
  });
}

function Acciones({ paso, estado, children }: { paso: Paso; estado: string; children?: ReactNode }) {
  const marcar = useMarcar();
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-borde pt-3">
      {children}
      {estado !== 'completo' && <Boton tam="sm" onClick={() => marcar.mutate({ paso, estado: 'hecho' })} cargando={marcar.isPending}>Marcar como hecho</Boton>}
      {estado === 'pendiente' && <Boton tam="sm" variante="fantasma" onClick={() => marcar.mutate({ paso, estado: 'omitido' })}>Lo hago después</Boton>}
      {estado !== 'pendiente' && <Boton tam="sm" variante="fantasma" onClick={() => marcar.mutate({ paso, estado: 'pendiente' })}>Volver a pendiente</Boton>}
    </div>
  );
}

// ───────────── 1. Datos del negocio ─────────────
function PanelNegocio({ estado }: { estado: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { recargar } = useAuth();
  const { data } = useQuery({ queryKey: ['config'], queryFn: () => api.get('/taller/config') });
  const [t, setT] = useState<any>(null);
  const archivo = useRef<HTMLInputElement>(null);
  useEffect(() => { if (data) setT({ ...data.taller }); }, [data]);
  const guardar = useMutation({
    mutationFn: () => guardarConfig({ nombre: t.nombre, razon_social: t.razon_social || null, cuit: t.cuit || null, condicion_iva: t.condicion_iva, direccion: t.direccion || null, localidad: t.localidad || null, provincia: t.provincia || null, telefono: t.telefono || null, email: t.email || null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['config'] }); qc.invalidateQueries({ queryKey: ['puesta'] }); recargar(); toast.ok('Datos del negocio guardados'); },
    onError: toast.error,
  });
  const logo = useMutation({
    mutationFn: async (f: File | null) => (f ? api.put('/taller/logo', { imagen: await prepararLogo(f) }) : api.del('/taller/logo')),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['config'] }); recargar(); toast.ok('Logo actualizado'); },
    onError: toast.error,
  });
  if (!t || !data) return <Cargando />;
  const s = (k: string) => (e: { target: { value: string } }) => setT({ ...t, [k]: e.target.value });
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Campo label="Nombre comercial" requerido><Input value={t.nombre ?? ''} onChange={s('nombre')} /></Campo>
        <Campo label="Razón social" hint="Si es distinta del nombre comercial"><Input value={t.razon_social ?? ''} onChange={s('razon_social')} /></Campo>
        <Campo label="CUIT" hint="Si corresponde. Se valida el dígito verificador"><Input value={t.cuit ?? ''} onChange={s('cuit')} placeholder="30-12345678-9" /></Campo>
        <Campo label="Condición frente al IVA">
          <Select value={t.condicion_iva} onChange={s('condicion_iva')}>{CONDICIONES_IVA.filter((x) => x !== 'consumidor_final').map((x) => <option key={x} value={x}>{CONDICION_IVA_LABEL[x]}</option>)}</Select>
        </Campo>
        <Campo label="Dirección"><Input value={t.direccion ?? ''} onChange={s('direccion')} /></Campo>
        <Campo label="Localidad"><Input value={t.localidad ?? ''} onChange={s('localidad')} /></Campo>
        <Campo label="Provincia">
          <Select value={t.provincia ?? ''} onChange={s('provincia')}><option value="">Elegí una provincia</option>{PROVINCIAS.map((p) => <option key={p} value={p}>{p}</option>)}</Select>
        </Campo>
        <Campo label="Teléfono / WhatsApp"><Input value={t.telefono ?? ''} onChange={s('telefono')} inputMode="tel" /></Campo>
        <Campo label="Correo del negocio"><Input type="email" value={t.email ?? ''} onChange={s('email')} /></Campo>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-4 rounded-ctl border border-borde p-3">
        <div className="flex size-16 items-center justify-center overflow-hidden rounded-ctl border border-borde bg-slate-50">
          {data.config.tiene_logo ? <img src={`/api/taller/logo?v=${data.config.updated_at}`} alt="Logo" className="max-h-full max-w-full object-contain" /> : <ImageIcon className="size-6 text-slate-300" />}
        </div>
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">Logo</p>
          <p className="text-xs text-tenue">Opcional. Imagen PNG, JPG o WebP; se ajusta sola a un tamaño liviano.</p>
        </div>
        <input ref={archivo} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) logo.mutate(f); e.target.value = ''; }} />
        <Boton tam="sm" icono={<Upload className="size-4" />} onClick={() => archivo.current?.click()} cargando={logo.isPending}>{data.config.tiene_logo ? 'Cambiar' : 'Subir logo'}</Boton>
        {data.config.tiene_logo && <Boton tam="sm" variante="fantasma" onClick={() => logo.mutate(null)}>Quitar</Boton>}
      </div>
      <Acciones paso="negocio" estado={estado}><Boton variante="primario" tam="sm" onClick={() => guardar.mutate()} cargando={guardar.isPending}>Guardar datos</Boton></Acciones>
    </>
  );
}

// ───────────── 2. Horarios y zona horaria ─────────────
function PanelHorarios({ estado }: { estado: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { recargar } = useAuth();
  const { data } = useQuery({ queryKey: ['config'], queryFn: () => api.get('/taller/config') });
  const [h, setH] = useState<HorariosAtencion | null>(null);
  const [zona, setZona] = useState('America/Argentina/Buenos_Aires');
  useEffect(() => {
    if (data) {
      setH(data.config.horarios_atencion ?? horariosPorDefecto());
      setZona(data.config.zona_horaria ?? 'America/Argentina/Buenos_Aires');
    }
  }, [data]);
  const guardar = useMutation({
    mutationFn: async () => {
      await api.put('/taller/horarios', h);
      await guardarConfig({}, { zona_horaria: zona });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['config'] }); qc.invalidateQueries({ queryKey: ['puesta'] }); recargar(); toast.ok('Horarios guardados'); },
    onError: toast.error,
  });
  if (!h) return <Cargando />;
  const cambiar = (i: number, f: (d: HorariosAtencion['dias'][number]) => HorariosAtencion['dias'][number]) => setH({ dias: h.dias.map((d, k) => (k === i ? f(d) : d)) });
  return (
    <>
      <Campo label="Zona horaria" hint="Define la hora con la que se muestran los fichajes y se arman los reportes. La hora siempre la registra el servidor.">
        <Select value={zona} onChange={(e) => setZona(e.target.value)} className="max-w-sm">{ZONAS_HORARIAS.map(([z, n]) => <option key={z} value={z}>{n}</option>)}</Select>
      </Campo>
      <div className="mt-4 space-y-2">
        {h.dias.map((d, i) => (
          <div key={d.dia} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-ctl border border-borde px-3 py-2">
            <div className="w-28"><Check checked={d.abierto} onChange={(v) => cambiar(i, (x) => ({ ...x, abierto: v, tramos: v && !x.tramos.length ? [{ desde: '08:00', hasta: '18:00' }] : x.tramos }))} label={DIAS_SEMANA[i]} /></div>
            {d.abierto ? (
              <>
                {d.tramos.map((t, k) => (
                  <span key={k} className="flex items-center gap-1.5 text-sm">
                    <Input type="time" value={t.desde} className="w-28" onChange={(e) => cambiar(i, (x) => ({ ...x, tramos: x.tramos.map((y, j) => (j === k ? { ...y, desde: e.target.value } : y)) }))} />
                    a
                    <Input type="time" value={t.hasta} className="w-28" onChange={(e) => cambiar(i, (x) => ({ ...x, tramos: x.tramos.map((y, j) => (j === k ? { ...y, hasta: e.target.value } : y)) }))} />
                  </span>
                ))}
                {d.tramos.length < 2 ? (
                  <Boton tam="sm" variante="fantasma" onClick={() => cambiar(i, (x) => ({ ...x, tramos: [...x.tramos, { desde: '14:00', hasta: '18:00' }] }))}>+ Horario cortado</Boton>
                ) : (
                  <Boton tam="sm" variante="fantasma" onClick={() => cambiar(i, (x) => ({ ...x, tramos: x.tramos.slice(0, 1) }))}>Quitar segunda franja</Boton>
                )}
              </>
            ) : <span className="text-sm text-tenue">Cerrado</span>}
          </div>
        ))}
      </div>
      <Acciones paso="horarios" estado={estado}><Boton variante="primario" tam="sm" onClick={() => guardar.mutate()} cargando={guardar.isPending}>Guardar horarios</Boton></Acciones>
    </>
  );
}

// ───────────── 3. Depósito y moneda ─────────────
function PanelDeposito({ estado }: { estado: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: deps } = useQuery({ queryKey: ['depositos'], queryFn: () => api.get<any[]>('/depositos') });
  const principal = deps?.find((d) => d.es_principal);
  const [nombre, setNombre] = useState('');
  useEffect(() => { if (principal) setNombre(principal.nombre); }, [principal?.id]);
  const renombrar = useMutation({
    mutationFn: () => api.put(`/depositos/${principal.id}`, { nombre }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['depositos'] }); qc.invalidateQueries({ queryKey: ['puesta'] }); toast.ok('Depósito actualizado'); },
    onError: toast.error,
  });
  if (!principal) return <Cargando />;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Campo label="Nombre del depósito principal" hint="Ahí entran por defecto las compras y de ahí salen las ventas. Más adelante podés sumar otros (mostrador, camioneta, sucursal)."><Input value={nombre} onChange={(e) => setNombre(e.target.value)} /></Campo>
        <Campo label="Moneda principal" hint="ORVELAN trabaja en pesos argentinos."><Input value="Peso argentino (ARS)" readOnly /></Campo>
      </div>
      <Acciones paso="deposito" estado={estado}>
        <Boton variante="primario" tam="sm" disabled={!nombre.trim() || nombre === principal.nombre} onClick={() => renombrar.mutate()} cargando={renombrar.isPending}>Guardar nombre</Boton>
        <Link to="/depositos"><Boton tam="sm" type="button">Gestionar depósitos</Boton></Link>
      </Acciones>
    </>
  );
}

// ───────────── 4. Catálogo ─────────────
function PanelCatalogo({ estado }: { estado: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useAuth();
  const refrescar = () => { qc.invalidateQueries({ queryKey: ['puesta'] }); qc.invalidateQueries({ queryKey: ['servicios'] }); qc.invalidateQueries({ queryKey: ['categorias-articulo'] }); };
  const tempario = useMutation({
    mutationFn: () => api.post('/tempario/plantilla/importar', {}),
    onSuccess: (r) => { refrescar(); toast.ok(r.creadas || r.completadas ? `Se cargaron ${r.creadas} operaciones nuevas` : 'No faltaba ninguna operación'); },
    onError: toast.error,
  });
  const plantillas = useMutation({
    mutationFn: () => api.post('/puesta-en-marcha/plantillas', { categorias_articulo: puede('catalogo.editar'), tipos_gasto: puede('gastos.gestionar'), marcas: puede('catalogo.editar') }),
    onSuccess: (r) => { refrescar(); const n = r.categorias_articulo + r.tipos_gasto + r.marcas + r.modelos; toast.ok(n ? 'Se agregaron las categorías y marcas que faltaban' : 'No faltaba ninguna'); },
    onError: toast.error,
  });
  return (
    <>
      <Aviso tono="ambar" className="mb-3">{AVISO_TIEMPOS_ORIENTATIVOS} Las operaciones se cargan <b>sin precio</b>: el precio sale de tu valor de hora (paso siguiente). Nada de esto trae precios de otros talleres.</Aviso>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-ctl border border-borde p-3">
          <p className="font-medium">Operaciones de mano de obra (tempario)</p>
          <p className="mt-1 text-sm text-tenue">Service, frenos, distribución, suspensión, electricidad y más, con un tiempo orientativo que podés ajustar.</p>
          <Boton className="mt-3" tam="sm" variante="primario" onClick={() => tempario.mutate()} cargando={tempario.isPending} disabled={!puede('catalogo.editar')}>Cargar operaciones del tempario</Boton>
        </div>
        <div className="rounded-ctl border border-borde p-3">
          <p className="font-medium">Categorías de repuestos, tipos de gastos y marcas</p>
          <p className="mt-1 text-sm text-tenue">Agrega las que falten de la lista general. No toca lo que ya tengas ni lo duplica.</p>
          <Boton className="mt-3" tam="sm" onClick={() => plantillas.mutate()} cargando={plantillas.isPending}>Agregar las que faltan</Boton>
        </div>
      </div>
      <Acciones paso="catalogo" estado={estado}>
        <Link to="/tempario"><Boton tam="sm" type="button">Ver el tempario</Boton></Link>
        <Link to="/configuracion?tab=catalogos"><Boton tam="sm" type="button">Marcas y categorías</Boton></Link>
      </Acciones>
    </>
  );
}

// ───────────── 5. Tarifas ─────────────
function PanelTarifas({ estado, detalle }: { estado: string; detalle: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['tarifas'], queryFn: () => api.get('/tempario/tarifas') });
  const [tarifa, setTarifa] = useState(0);
  useEffect(() => { if (data) setTarifa(data.tarifa_hora); }, [data]);
  const guardar = useMutation({
    mutationFn: () => api.put('/tempario/tarifas', { tarifa_hora: tarifa, categorias: [] }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tarifas'] }); qc.invalidateQueries({ queryKey: ['puesta'] }); qc.invalidateQueries({ queryKey: ['servicios'] }); toast.ok('Tarifa guardada'); },
    onError: toast.error,
  });
  if (!data) return <Cargando />;
  return (
    <>
      <Campo label="Valor de la hora de trabajo" hint="Con este valor y el tiempo de cada operación se calcula su precio. Podés fijar un precio distinto a cada servicio o una tarifa propia por categoría desde el Tempario.">
        <InputMoneda value={tarifa} onChange={setTarifa} className="max-w-xs" />
      </Campo>
      {estado !== 'completo' && <p className="mt-2 text-sm text-amber-800">{detalle}</p>}
      <Acciones paso="tarifas" estado={estado}>
        <Boton variante="primario" tam="sm" onClick={() => guardar.mutate()} cargando={guardar.isPending}>Guardar tarifa</Boton>
        <Link to="/tempario"><Boton tam="sm" type="button">Revisar precios en el Tempario</Boton></Link>
      </Acciones>
    </>
  );
}

// ───────────── 6. Listas de precios ─────────────
function PanelListas({ estado }: { estado: string }) {
  return (
    <>
      <p className="text-sm text-tenue">Si vendés a precios distintos según el cliente (mayoristas, flotas, aseguradoras) armá una lista con un porcentaje sobre costo o sobre tu precio. Si no, podés saltear este paso.</p>
      <Acciones paso="listas" estado={estado}><Link to="/listas-precios"><Boton tam="sm" variante="primario" type="button">Ir a listas de precios</Boton></Link></Acciones>
    </>
  );
}

// ───────────── 7. Personal ─────────────
function PanelPersonal({ estado }: { estado: string }) {
  return (
    <>
      <ul className="list-disc space-y-1 pl-5 text-sm text-tenue">
        <li>Cargá a cada persona con su rol (recepción, mecánico, depósito, caja o administrador).</li>
        <li>Elegí qué puede ver y hacer; podés ajustar permisos de a uno.</li>
        <li>Quien solo ficha su asistencia no necesita acceso al sistema: se registra con un PIN en el reloj compartido.</li>
      </ul>
      <Acciones paso="personal" estado={estado}>
        <Link to="/personal/equipo"><Boton tam="sm" variante="primario" type="button">Ir a Equipo y permisos</Boton></Link>
        <Link to="/personal/reloj"><Boton tam="sm" type="button">Reloj compartido</Boton></Link>
      </Acciones>
    </>
  );
}

// ───────────── 8. Cobros ─────────────
function PanelCobros({ estado }: { estado: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useAuth();
  const { data } = useQuery({ queryKey: ['config'], queryFn: () => api.get('/taller/config') });
  const [medios, setMedios] = useState<string[]>([...MEDIOS_PAGO]);
  const [obligatoria, setObligatoria] = useState(false);
  useEffect(() => {
    if (data) {
      setMedios(data.config.medios_pago ?? [...MEDIOS_PAGO]);
      setObligatoria(!!data.config.caja_obligatoria);
    }
  }, [data]);
  const guardar = useMutation({
    mutationFn: () => guardarConfig({}, { medios_pago: MEDIOS_PAGO.every((m) => medios.includes(m)) ? null : medios, caja_obligatoria: obligatoria }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['config'] }); qc.invalidateQueries({ queryKey: ['puesta'] }); toast.ok('Configuración de cobros guardada'); },
    onError: toast.error,
  });
  if (!data) return <Cargando />;
  const alternar = (m: string, on: boolean) => setMedios(on ? [...new Set([...medios, m, 'efectivo'])] : medios.filter((x) => x !== m));
  return (
    <>
      <p className="mb-2 text-[13px] font-medium">Medios de cobro que aceptás</p>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {MEDIOS_PAGO.map((m) => <Check key={m} checked={medios.includes(m)} onChange={(v) => alternar(m, v)} label={m === 'efectivo' ? 'Efectivo (siempre)' : MEDIO_PAGO_LABEL[m]} className={m === 'efectivo' ? 'pointer-events-none opacity-70' : ''} />)}
      </div>
      <div className="mt-4">
        <Check checked={obligatoria} onChange={setObligatoria} label="Exigir caja abierta para cobrar, pagar y registrar gastos" />
        <p className="mt-1 pl-6 text-xs text-tenue">ORVELAN maneja una caja por día: se abre al empezar y se cierra con arqueo. Así ningún cobro en efectivo queda fuera del control.</p>
      </div>
      <Acciones paso="cobros" estado={estado}>
        <Boton variante="primario" tam="sm" onClick={() => guardar.mutate()} cargando={guardar.isPending}>Guardar</Boton>
        {puede('bancos.gestionar') && <Link to="/bancos"><Boton tam="sm" type="button">Cuentas bancarias (opcional)</Boton></Link>}
        {puede('tesoreria.ver') && <Link to="/tesoreria"><Boton tam="sm" type="button">Tesorería</Boton></Link>}
      </Acciones>
    </>
  );
}

// ───────────── 9. Importación ─────────────
function PanelImportacion({ estado }: { estado: string }) {
  const { puede } = useAuth();
  return (
    <>
      <p className="text-sm text-tenue">Traé clientes, vehículos, artículos y proveedores desde un Excel o CSV de tu sistema anterior. Vas a ver una vista previa y los errores antes de confirmar, y nada se modifica sin que lo revises.</p>
      <Aviso tono="ambar" className="mt-3">Los <b>saldos</b> (de caja, de stock, de clientes o de proveedores) no se importan desde estas planillas: tienen su propio procedimiento para no distorsionar la contabilidad.</Aviso>
      <Acciones paso="importacion" estado={estado}>
        {puede('datos.importar') ? <Link to="/importar"><Boton tam="sm" variante="primario" type="button">Importar datos</Boton></Link> : <span className="text-sm text-tenue">No tenés permiso para importar datos.</span>}
      </Acciones>
    </>
  );
}

// ───────────── Pantalla ─────────────
function Icono({ estado }: { estado: string }) {
  if (estado === 'completo') return <CheckCircle2 className="size-6 text-emerald-600" />;
  if (estado === 'omitido') return <MinusCircle className="size-6 text-slate-500" />;
  return <Circle className="size-6 text-slate-300" />;
}

export function PuestaEnMarcha() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { recargar, me } = useAuth();
  const { data, isLoading, error, refetch } = usePuesta();
  const [abierto, setAbierto] = useState<Paso | null>(null);
  const cerrar = useMutation({
    mutationFn: () => api.post('/puesta-en-marcha/cerrar', {}),
    onSuccess: async () => { await recargar(); qc.invalidateQueries({ queryKey: ['puesta'] }); nav('/'); },
    onError: toast.error,
  });
  useEffect(() => {
    if (data && abierto === null && data.siguiente) setAbierto(data.siguiente);
    // solo la primera vez que llegan los datos
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.siguiente]);
  if (isLoading) return <Cargando />;
  if (error || !data) return <ErrorCaja error={error} reintentar={refetch} />;
  const pct = Math.round((data.completos / data.total) * 100);
  const paneles: Record<Paso, (p: { estado: string; detalle: string }) => ReactNode> = {
    negocio: (p) => <PanelNegocio estado={p.estado} />,
    horarios: (p) => <PanelHorarios estado={p.estado} />,
    deposito: (p) => <PanelDeposito estado={p.estado} />,
    catalogo: (p) => <PanelCatalogo estado={p.estado} />,
    tarifas: (p) => <PanelTarifas estado={p.estado} detalle={p.detalle} />,
    listas: (p) => <PanelListas estado={p.estado} />,
    personal: (p) => <PanelPersonal estado={p.estado} />,
    cobros: (p) => <PanelCobros estado={p.estado} />,
    importacion: (p) => <PanelImportacion estado={p.estado} />,
  };
  return (
    <>
      <Encabezado
        titulo="Puesta en marcha"
        subtitulo={`Configuración de ${me?.taller.nombre ?? 'tu taller'}`}
        acciones={data.asistente_pendiente ? <Boton variante="primario" icono={<Rocket className="size-4" />} onClick={() => cerrar.mutate()} cargando={cerrar.isPending}>Empezar a usar ORVELAN</Boton> : undefined}
      />
      <div className="max-w-formulario">
        <Tarjeta className="mb-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-lg font-semibold">Configuración del taller: {data.completos} de {data.total} pasos completos{data.omitidos ? ` · ${data.omitidos} para después` : ''}</p>
            <span className="text-sm text-tenue">{pct} %</span>
          </div>
          <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={data.completos} aria-valuemin={0} aria-valuemax={data.total}>
            <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-3 text-sm text-tenue">Ya podés usar ORVELAN: nada de esto bloquea el trabajo. Completá los pasos a tu ritmo, saltá los que no necesites y volvé cuando quieras desde <b>Administración › Puesta en marcha</b>.</p>
        </Tarjeta>
        <div className="space-y-2">
          {data.pasos.map((p, i) => {
            const info = INFO_PASOS[p.clave];
            const abiertoEste = abierto === p.clave;
            return (
              <section key={p.clave} className={cn('rounded-card border bg-white', abiertoEste ? 'border-marca-300 shadow-card' : 'border-borde')}>
                <button type="button" onClick={() => setAbierto(abiertoEste ? null : p.clave)} className="flex w-full items-center gap-3 px-4 py-3 text-left" aria-expanded={abiertoEste}>
                  <Icono estado={p.estado} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{i + 1}. {info.titulo}</span>
                      {p.estado === 'completo' && <Insignia tono="verde">Completo</Insignia>}
                      {p.estado === 'omitido' && <Insignia tono="gris">Para después</Insignia>}
                      {p.estado === 'pendiente' && <Insignia tono={info.recomendado ? 'ambar' : 'gris'}>{info.recomendado ? 'Falta' : 'Opcional'}</Insignia>}
                    </div>
                    <p className="text-sm text-tenue">{p.estado === 'pendiente' ? p.detalle : p.detalle || info.resumen}</p>
                  </div>
                  {abiertoEste ? <ChevronDown className="size-5 text-tenue" /> : <ChevronRight className="size-5 text-tenue" />}
                </button>
                {abiertoEste && (
                  <div className="border-t border-borde px-4 py-4">
                    <p className="mb-3 text-sm text-tenue">{info.resumen}</p>
                    {paneles[p.clave]({ estado: p.estado, detalle: p.detalle })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </>
  );
}
