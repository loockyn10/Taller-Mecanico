import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fechaHora, money } from '@/lib/format';
import { Aviso, Boton, Campo, Cargando, Check, Encabezado, Input, InputMoneda, Insignia, Modal, Pestanas, Select, Tabla, Tarjeta, Textarea, useConfirmar, useToast } from '@/components/ui';
import { useMarcas } from '@/components/selectores';
import { CONDICIONES_IVA, CONDICION_IVA_LABEL, MEDIO_PAGO_LABEL, MEDIOS_PAGO, TIPOS_VEHICULO, TIPO_VEHICULO_LABEL } from '@shared/dominio';
import { ROL_LABEL, type Rol } from '@shared/permisos';

function DatosTaller() {
  const qc = useQueryClient();
  const toast = useToast();
  const { puede, recargar } = useAuth();
  const { data } = useQuery({ queryKey: ['config'], queryFn: () => api.get('/taller/config') });
  const [t, setT] = useState<any>(null);
  const [c, setC] = useState<any>(null);
  useEffect(() => {
    if (data) {
      setT({ ...data.taller });
      setC({ ...data.config, permitir_stock_negativo: !!data.config.permitir_stock_negativo, caja_obligatoria: !!data.config.caja_obligatoria });
    }
  }, [data]);
  const m = useMutation({
    mutationFn: () => api.put('/taller/config', { taller: { ...t, inicio_actividades: t.inicio_actividades || null }, config: c }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['config'] });
      recargar();
      toast.ok('Configuración guardada');
    },
    onError: toast.error,
  });
  if (!t || !c) return <Cargando />;
  const ro = !puede('config.editar');
  const st = (k: string) => (e: any) => setT({ ...t, [k]: e.target.value });
  const sc = (k: string) => (e: any) => setC({ ...c, [k]: e.target.value });
  const nc = (k: string) => (e: any) => setC({ ...c, [k]: Number(e.target.value) });
  const habilitados: string[] = c.medios_pago ?? MEDIOS_PAGO;
  const alternarMedio = (medio: string, on: boolean) => {
    const actuales = new Set(habilitados);
    on ? actuales.add(medio) : actuales.delete(medio);
    actuales.add('efectivo');
    setC({ ...c, medios_pago: MEDIOS_PAGO.every((x) => actuales.has(x)) ? null : MEDIOS_PAGO.filter((x) => actuales.has(x)) });
  };
  return (
    <div className="space-y-5">
      {ro && <Aviso>Solo el propietario o un administrador pueden modificar la configuración.</Aviso>}
      <Tarjeta titulo="Datos comerciales" subtitulo="Aparecen en presupuestos, órdenes, recibos y demás documentos impresos">
        <fieldset disabled={ro} className="grid gap-3 sm:grid-cols-2">
          <Campo label="Nombre comercial" requerido><Input value={t.nombre ?? ''} onChange={st('nombre')} /></Campo>
          <Campo label="Razón social"><Input value={t.razon_social ?? ''} onChange={st('razon_social')} /></Campo>
          <Campo label="Dirección"><Input value={t.direccion ?? ''} onChange={st('direccion')} /></Campo>
          <Campo label="Localidad"><Input value={t.localidad ?? ''} onChange={st('localidad')} /></Campo>
          <Campo label="Teléfono / WhatsApp"><Input value={t.telefono ?? ''} onChange={st('telefono')} /></Campo>
          <Campo label="Email"><Input value={t.email ?? ''} onChange={st('email')} /></Campo>
          <Campo label="Sitio web"><Input value={t.sitio_web ?? ''} onChange={st('sitio_web')} /></Campo>
        </fieldset>
      </Tarjeta>
      <Tarjeta titulo="Datos fiscales" subtitulo="Se imprimen en los documentos. La facturación electrónica con ARCA se incorpora en una etapa posterior.">
        <fieldset disabled={ro} className="grid gap-3 sm:grid-cols-2">
          <Campo label="CUIT" hint="Se valida el dígito verificador"><Input value={t.cuit ?? ''} onChange={st('cuit')} placeholder="30-12345678-9" /></Campo>
          <Campo label="Condición frente al IVA">
            <Select value={t.condicion_iva} onChange={st('condicion_iva')}>
              {CONDICIONES_IVA.filter((x) => x !== 'consumidor_final').map((x) => <option key={x} value={x}>{CONDICION_IVA_LABEL[x]}</option>)}
            </Select>
          </Campo>
          <Campo label="Ingresos Brutos (N° de inscripción)"><Input value={t.ingresos_brutos ?? ''} onChange={st('ingresos_brutos')} /></Campo>
          <Campo label="Inicio de actividades"><Input type="date" value={t.inicio_actividades ?? ''} onChange={st('inicio_actividades')} /></Campo>
        </fieldset>
      </Tarjeta>
      <Tarjeta titulo="Precios e impuestos" subtitulo="Se aplican como valores iniciales al crear presupuestos, órdenes de trabajo y ventas; en cada documento se pueden cambiar">
        <fieldset disabled={ro} className="grid gap-3 sm:grid-cols-2">
          <Campo label="IVA por defecto" hint="Los talleres que no discriminan IVA lo dejan en “Sin IVA”">
            <Select value={c.iva_default} onChange={nc('iva_default')}>{[0, 10.5, 21, 27].map((v) => <option key={v} value={v}>{v ? `${String(v).replace('.', ',')} %` : 'Sin IVA'}</option>)}</Select>
          </Campo>
          <Campo label="Recargo por defecto (%)" hint="Por ejemplo, recargo por pago con tarjeta"><Input type="number" min={0} max={100} step="any" value={c.recargo_default} onChange={nc('recargo_default')} /></Campo>
          <Campo label="Margen sugerido sobre costo (%)"><Input type="number" min={0} value={c.margen_default} onChange={nc('margen_default')} /></Campo>
          <Campo label="Validez de presupuestos (días)"><Input type="number" min={1} value={c.validez_presupuesto_dias} onChange={nc('validez_presupuesto_dias')} /></Campo>
        </fieldset>
      </Tarjeta>
      <Tarjeta titulo="Preferencias de documentos" subtitulo="Texto al pie de cada tipo de documento. Si dejás uno vacío se usa el pie general.">
        <fieldset disabled={ro} className="grid gap-3">
          <Campo label="Pie general"><Textarea rows={2} value={c.pie_documentos ?? ''} onChange={sc('pie_documentos')} placeholder="Ej.: Garantía de mano de obra 3 meses. Precios sujetos a disponibilidad." /></Campo>
          <Campo label="Pie de presupuestos"><Textarea rows={2} value={c.pie_presupuesto ?? ''} onChange={sc('pie_presupuesto')} /></Campo>
          <Campo label="Pie de recibos y estados de cuenta"><Textarea rows={2} value={c.pie_recibo ?? ''} onChange={sc('pie_recibo')} /></Campo>
          <Campo label="Pie de órdenes de compra"><Textarea rows={2} value={c.pie_orden_compra ?? ''} onChange={sc('pie_orden_compra')} placeholder="Ej.: Entregar en horario de 8 a 17. Enviar remito con la mercadería." /></Campo>
        </fieldset>
      </Tarjeta>
      <Tarjeta titulo="Caja, medios de pago y cheques">
        <fieldset disabled={ro} className="space-y-4">
          <div>
            <p className="mb-2 text-[13px] font-medium">Medios de pago habilitados</p>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {MEDIOS_PAGO.map((x) => <Check key={x} checked={habilitados.includes(x)} onChange={(v) => alternarMedio(x, v)} label={x === 'efectivo' ? 'Efectivo (siempre)' : MEDIO_PAGO_LABEL[x]} className={x === 'efectivo' ? 'pointer-events-none opacity-70' : ''} />)}
            </div>
            <p className="mt-1 text-xs text-tenue">Los medios deshabilitados no se ofrecen al cobrar, pagar ni registrar gastos, y el servidor los rechaza.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Campo label="Tolerancia de diferencia en el cierre de caja" hint="Diferencias de efectivo hasta este importe no exigen justificación"><InputMoneda value={c.tolerancia_caja} onChange={(v) => setC({ ...c, tolerancia_caja: v })} /></Campo>
            <Campo label="Alerta de cheques (días antes)" hint="Para avisar de cheques a depositar, vencer o debitar"><Input type="number" min={0} max={60} value={c.alerta_cheques_dias} onChange={nc('alerta_cheques_dias')} /></Campo>
            <Campo label="Plazo de pago a proveedores (días)" hint="Vencimiento por defecto de compras y facturas"><Input type="number" min={0} max={365} value={c.plazo_pago_dias} onChange={nc('plazo_pago_dias')} /></Campo>
          </div>
          <div>
            <Check checked={c.caja_obligatoria} onChange={(v) => setC({ ...c, caja_obligatoria: v })} label="Exigir caja abierta para cobrar, pagar y registrar gastos" />
            <p className="mt-1 pl-6 text-xs text-tenue">Con esta opción, los cobros y pagos sólo se registran con una caja abierta (así ninguno queda fuera del arqueo). Sin ella, los movimientos se registran igual y quedan marcados como “sin caja”.</p>
          </div>
          <div className="flex flex-wrap gap-2 border-t border-borde pt-3 no-print">
            {puede('bancos.gestionar') && <Link to="/bancos"><Boton tam="sm" type="button">Cuentas bancarias</Boton></Link>}
            {puede('gastos.gestionar') && <Link to="/finanzas?tab=categorias"><Boton tam="sm" type="button">Categorías de gastos</Boton></Link>}
          </div>
        </fieldset>
      </Tarjeta>
      <Tarjeta titulo="Preferencias generales">
        <fieldset disabled={ro}>
          <Check checked={c.permitir_stock_negativo} onChange={(v) => setC({ ...c, permitir_stock_negativo: v })} label="Permitir stock negativo (no recomendado)" />
        </fieldset>
      </Tarjeta>
      {!ro && <div className="flex justify-end"><Boton variante="primario" cargando={m.isPending} onClick={() => m.mutate()}>Guardar configuración</Boton></div>}
      <Tarjeta titulo="Facturación electrónica (ARCA)">
        <p className="text-sm text-tenue">No disponible en esta versión. Los comprobantes que emite Fierro son internos. El modelo de datos ya separa comprobantes internos y fiscales para incorporar la emisión con CAE sin modificar ventas ni cobros.</p>
      </Tarjeta>
    </div>
  );
}

function Usuarios() {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const { confirmar, dialogo } = useConfirmar();
  const { data, isLoading } = useQuery({ queryKey: ['usuarios'], queryFn: () => api.get('/taller/usuarios') });
  const [nuevo, setNuevo] = useState(false);
  const [reset, setReset] = useState<any>(null);
  const [f, setF] = useState({ nombre: '', email: '', rol: 'empleado', password: '' });
  const [pass, setPass] = useState('');
  const inv = () => qc.invalidateQueries({ queryKey: ['usuarios'] });
  const crear = useMutation({
    mutationFn: () => api.post('/taller/usuarios', f),
    onSuccess: () => { inv(); setNuevo(false); setF({ nombre: '', email: '', rol: 'empleado', password: '' }); toast.ok('Usuario creado'); },
    onError: toast.error,
  });
  const patch = useMutation({
    mutationFn: ({ id, d }: { id: string; d: any }) => api.patch(`/taller/usuarios/${id}`, d),
    onSuccess: () => { inv(); toast.ok('Usuario actualizado'); setReset(null); setPass(''); },
    onError: toast.error,
  });
  if (isLoading) return <Cargando />;
  const lic = data.licencia;
  return (
    <>
      {dialogo}
      <Tarjeta
        titulo="Usuarios con acceso"
        subtitulo={`${lic.usuarios_activos} de ${lic.usuarios_max} usuarios activos según la licencia`}
        sinPadding
        acciones={<Boton variante="primario" tam="sm" icono={<Plus className="size-4" />} disabled={lic.disponibles <= 0} onClick={() => setNuevo(true)}>Nuevo usuario</Boton>}
      >
        {lic.disponibles <= 0 && <Aviso tono="ambar" className="m-4">Alcanzaste el límite de usuarios de la licencia. Para sumar usuarios, contratá usuarios adicionales.</Aviso>}
        <Tabla
          filas={data.usuarios}
          clave={(u: any) => u.id}
          columnas={[
            { clave: 'n', titulo: 'Nombre', render: (u: any) => <span className="font-medium">{u.nombre}{u.id === me?.usuario.id ? ' (vos)' : ''}</span>, movil: 'titulo' },
            { clave: 'e', titulo: 'Email', render: (u: any) => u.email, movil: 'subtitulo' },
            {
              clave: 'r', titulo: 'Rol', movil: 'meta',
              render: (u: any) => u.rol === 'propietario' ? <Insignia tono="violeta">Propietario</Insignia> : (
                <Select value={u.rol} onChange={(e) => patch.mutate({ id: u.id, d: { rol: e.target.value } })} className="h-8 w-40">
                  <option value="administrador">Administrador</option>
                  <option value="empleado">Empleado</option>
                </Select>
              ),
            },
            { clave: 'l', titulo: 'Último ingreso', render: (u: any) => fechaHora(u.ultimo_login), movil: 'oculta' },
            { clave: 'a', titulo: 'Estado', render: (u: any) => <Insignia tono={u.activo ? 'verde' : 'gris'}>{u.activo ? 'Activo' : 'Inactivo'}</Insignia>, movil: 'meta' },
            {
              clave: 'x', titulo: '', movil: 'meta',
              render: (u: any) => u.rol === 'propietario' && u.id !== me?.usuario.id ? null : (
                <div className="flex gap-1">
                  <Boton tam="sm" variante="fantasma" icono={<KeyRound className="size-4" />} onClick={() => setReset(u)}>Clave</Boton>
                  {u.rol !== 'propietario' && u.id !== me?.usuario.id && (
                    <Boton tam="sm" variante="fantasma" onClick={async () => { if (u.activo ? await confirmar('Desactivar usuario', `${u.nombre} no podrá ingresar y se cerrarán sus sesiones.`, true) : true) patch.mutate({ id: u.id, d: { activo: !u.activo } }); }}>
                      {u.activo ? 'Desactivar' : 'Activar'}
                    </Boton>
                  )}
                </div>
              ),
            },
          ]}
        />
      </Tarjeta>
      <Tarjeta titulo="Permisos por rol" className="mt-5">
        <ul className="space-y-2 text-sm">
          <li><strong>{ROL_LABEL.propietario}:</strong> acceso total, incluida la licencia y los usuarios.</li>
          <li><strong>{ROL_LABEL.administrador}:</strong> acceso total a la operación, el catálogo, compras, reportes, configuración y usuarios (salvo el propietario).</li>
          <li><strong>{ROL_LABEL.empleado}:</strong> clientes, vehículos, presupuestos, órdenes, agenda, check-list, emitir comprobantes, registrar cobros, operar la caja (abrir, cerrar, arquear, registrar gastos e ingresos) y consultar el stock. Sólo carga operaciones con la fecha de hoy. No ve reportes financieros ni compras, no modifica precios ni configuración y no anula.</li>
        </ul>
      </Tarjeta>
      <Modal abierto={nuevo} onCerrar={() => setNuevo(false)} titulo="Nuevo usuario" pie={<><Boton onClick={() => setNuevo(false)}>Cancelar</Boton><Boton variante="primario" cargando={crear.isPending} onClick={() => crear.mutate()}>Crear</Boton></>}>
        <div className="grid gap-3">
          <Campo label="Nombre" requerido><Input value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} /></Campo>
          <Campo label="Email (usuario de ingreso)" requerido><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Campo>
          <Campo label="Rol">
            <Select value={f.rol} onChange={(e) => setF({ ...f, rol: e.target.value as Rol })}>
              <option value="empleado">Empleado</option>
              <option value="administrador">Administrador</option>
            </Select>
          </Campo>
          <Campo label="Contraseña inicial" requerido hint="Mínimo 8 caracteres. Pedile que la cambie al ingresar."><Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></Campo>
        </div>
      </Modal>
      <Modal abierto={!!reset} onCerrar={() => setReset(null)} titulo={`Nueva contraseña · ${reset?.nombre ?? ''}`} ancho="sm" pie={<><Boton onClick={() => setReset(null)}>Cancelar</Boton><Boton variante="primario" disabled={pass.length < 8} onClick={() => patch.mutate({ id: reset.id, d: { password: pass } })}>Guardar</Boton></>}>
        <Campo label="Contraseña" hint="Mínimo 8 caracteres. Se cerrarán sus sesiones abiertas."><Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" /></Campo>
      </Modal>
    </>
  );
}

function MiCuenta() {
  const toast = useToast();
  const [a, setA] = useState('');
  const [n, setN] = useState('');
  const m = useMutation({ mutationFn: () => api.post('/auth/password', { actual: a, nueva: n }), onSuccess: () => { toast.ok('Contraseña actualizada'); setA(''); setN(''); }, onError: toast.error });
  return (
    <Tarjeta titulo="Cambiar mi contraseña" className="max-w-md">
      <div className="space-y-3">
        <Campo label="Contraseña actual"><Input type="password" value={a} onChange={(e) => setA(e.target.value)} autoComplete="current-password" /></Campo>
        <Campo label="Nueva contraseña" hint="Mínimo 8 caracteres. Se cerrarán tus otras sesiones."><Input type="password" value={n} onChange={(e) => setN(e.target.value)} autoComplete="new-password" /></Campo>
        <Boton variante="primario" disabled={!a || n.length < 8} cargando={m.isPending} onClick={() => m.mutate()}>Actualizar</Boton>
      </div>
    </Tarjeta>
  );
}

function Licencia() {
  const { data, isLoading } = useQuery({ queryKey: ['licencia'], queryFn: () => api.get('/taller/licencia') });
  if (isLoading) return <Cargando />;
  return (
    <Tarjeta titulo="Licencia">
      <dl className="grid gap-4 sm:grid-cols-4">
        <div><dt className="text-xs text-tenue">Estado</dt><dd><Insignia tono={data.estado === 'activa' ? 'verde' : 'rojo'}>{data.estado === 'activa' ? 'Activa' : 'Suspendida'}</Insignia></dd></div>
        <div><dt className="text-xs text-tenue">Usuarios incluidos</dt><dd className="text-lg font-semibold">{data.usuarios_incluidos}</dd></div>
        <div><dt className="text-xs text-tenue">Usuarios adicionales</dt><dd className="text-lg font-semibold">{data.usuarios_adicionales}</dd></div>
        <div><dt className="text-xs text-tenue">En uso</dt><dd className="text-lg font-semibold">{data.usuarios_activos} / {data.usuarios_max}</dd></div>
      </dl>
      <p className="mt-4 text-sm text-tenue">Para contratar usuarios adicionales comunicate con el proveedor del sistema.</p>
    </Tarjeta>
  );
}

function Mecanicos() {
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useAuth();
  const { data = [] } = useQuery({ queryKey: ['mecanicos'], queryFn: () => api.get<any[]>('/mecanicos') });
  const [f, setF] = useState<any>(null);
  const m = useMutation({
    mutationFn: () => (f.id ? api.put(`/mecanicos/${f.id}`, { nombre: f.nombre, telefono: f.telefono, especialidad: f.especialidad, activo: f.activo }) : api.post('/mecanicos', f)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['mecanicos'] }); setF(null); toast.ok('Mecánico guardado'); },
    onError: toast.error,
  });
  return (
    <>
      <Tarjeta titulo="Mecánicos" subtitulo="Personal al que se asignan las órdenes (no necesitan usuario)" sinPadding acciones={puede('catalogo.editar') && <Boton tam="sm" variante="primario" icono={<Plus className="size-4" />} onClick={() => setF({ nombre: '', telefono: '', especialidad: '', activo: true })}>Nuevo</Boton>}>
        <Tabla
          filas={data}
          clave={(x) => x.id}
          onFila={puede('catalogo.editar') ? (x) => setF({ ...x, activo: !!x.activo }) : undefined}
          vacio={<p className="px-4 py-6 text-center text-sm text-tenue">Todavía no cargaste mecánicos</p>}
          columnas={[
            { clave: 'n', titulo: 'Nombre', render: (x) => <span className="font-medium">{x.nombre}</span>, movil: 'titulo' },
            { clave: 'e', titulo: 'Especialidad', render: (x) => x.especialidad ?? '—', movil: 'subtitulo' },
            { clave: 't', titulo: 'Teléfono', render: (x) => x.telefono ?? '—', movil: 'meta' },
            { clave: 'o', titulo: 'OT abiertas', render: (x) => x.ot_abiertas, movil: 'meta' },
            { clave: 'a', titulo: 'Estado', render: (x) => <Insignia tono={x.activo ? 'verde' : 'gris'}>{x.activo ? 'Activo' : 'Inactivo'}</Insignia>, movil: 'derecha' },
          ]}
        />
      </Tarjeta>
      {f && (
        <Modal abierto onCerrar={() => setF(null)} titulo={f.id ? 'Editar mecánico' : 'Nuevo mecánico'} ancho="sm" pie={<><Boton onClick={() => setF(null)}>Cancelar</Boton><Boton variante="primario" disabled={f.nombre.trim().length < 2} cargando={m.isPending} onClick={() => m.mutate()}>Guardar</Boton></>}>
          <div className="space-y-3">
            <Campo label="Nombre" requerido><Input value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} autoFocus /></Campo>
            <Campo label="Especialidad"><Input value={f.especialidad ?? ''} onChange={(e) => setF({ ...f, especialidad: e.target.value })} placeholder="Motor, electricidad, tren delantero…" /></Campo>
            <Campo label="Teléfono"><Input value={f.telefono ?? ''} onChange={(e) => setF({ ...f, telefono: e.target.value })} /></Campo>
            {f.id && <Check checked={f.activo} onChange={(v) => setF({ ...f, activo: v })} label="Activo" />}
          </div>
        </Modal>
      )}
    </>
  );
}

function Servicios() {
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useAuth();
  const { data: servicios = [] } = useQuery({ queryKey: ['servicios', 'todos'], queryFn: () => api.get<any[]>('/servicios?todos=1') });
  const { data: cats = [] } = useQuery({ queryKey: ['categorias-servicio'], queryFn: () => api.get<any[]>('/categorias-servicio') });
  const [f, setF] = useState<any>(null);
  const [ajuste, setAjuste] = useState<any>(null);
  const [nuevaCat, setNuevaCat] = useState('');
  const inv = () => { qc.invalidateQueries({ queryKey: ['servicios'] }); qc.invalidateQueries({ queryKey: ['categorias-servicio'] }); };
  const guardar = useMutation({
    mutationFn: () => {
      const d = { categoria_id: f.categoria_id || null, nombre: f.nombre, descripcion: f.descripcion, precio: f.precio, tipo_vehiculo: f.tipo_vehiculo, intervalo_km: f.intervalo_km ? Number(f.intervalo_km) : null, intervalo_meses: f.intervalo_meses ? Number(f.intervalo_meses) : null, checks: f.checks, activo: f.activo };
      return f.id ? api.put(`/servicios/${f.id}`, d) : api.post('/servicios', d);
    },
    onSuccess: () => { inv(); setF(null); toast.ok('Servicio guardado'); },
    onError: toast.error,
  });
  const masivo = useMutation({
    mutationFn: () => api.post('/servicios/ajuste-masivo', { categoria_id: ajuste.categoria_id || null, porcentaje: Number(ajuste.porcentaje), redondeo: ajuste.redondeo }),
    onSuccess: (r) => { inv(); setAjuste(null); toast.ok(`${r.actualizados} precios actualizados`); },
    onError: toast.error,
  });
  const crearCat = useMutation({ mutationFn: () => api.post('/categorias-servicio', { nombre: nuevaCat, orden: cats.length }), onSuccess: () => { inv(); setNuevaCat(''); }, onError: toast.error });
  const edita = puede('catalogo.editar');
  return (
    <>
      <Tarjeta
        titulo="Servicios y mano de obra"
        subtitulo="Catálogo de trabajos con precio sugerido e intervalos para recordatorios"
        sinPadding
        acciones={edita && (
          <>
            <Boton tam="sm" onClick={() => setAjuste({ categoria_id: '', porcentaje: 10, redondeo: '100' })}>Ajuste masivo de precios</Boton>
            <Boton tam="sm" variante="primario" icono={<Plus className="size-4" />} onClick={() => setF({ nombre: '', categoria_id: cats[0]?.id ?? '', precio: 0, tipo_vehiculo: 'todos', intervalo_km: '', intervalo_meses: '', checks: [], activo: true, descripcion: '' })}>Nuevo servicio</Boton>
          </>
        )}
      >
        <Tabla
          filas={servicios}
          clave={(s) => s.id}
          onFila={edita ? (s) => setF({ ...s, activo: !!s.activo, intervalo_km: s.intervalo_km ?? '', intervalo_meses: s.intervalo_meses ?? '' }) : undefined}
          columnas={[
            { clave: 'c', titulo: 'Categoría', render: (s) => s.categoria ?? '—', movil: 'subtitulo' },
            { clave: 'n', titulo: 'Servicio', render: (s) => <span className={s.activo ? 'font-medium' : 'text-tenue line-through'}>{s.nombre}</span>, movil: 'titulo' },
            { clave: 't', titulo: 'Vehículo', render: (s) => TIPO_VEHICULO_LABEL[s.tipo_vehiculo as keyof typeof TIPO_VEHICULO_LABEL] ?? s.tipo_vehiculo, movil: 'oculta' },
            { clave: 'i', titulo: 'Intervalo', render: (s) => [s.intervalo_km ? `${s.intervalo_km.toLocaleString('es-AR')} km` : null, s.intervalo_meses ? `${s.intervalo_meses} meses` : null].filter(Boolean).join(' / ') || '—', movil: 'meta' },
            { clave: 'p', titulo: 'Precio', alinear: 'derecha', render: (s) => money(s.precio), movil: 'derecha' },
          ]}
        />
      </Tarjeta>
      {edita && (
        <Tarjeta titulo="Categorías de servicio" className="mt-5">
          <div className="flex flex-wrap gap-2">
            {cats.map((c) => <Insignia key={c.id} className="px-3 py-1 text-sm">{c.nombre}</Insignia>)}
          </div>
          <div className="mt-3 flex max-w-md gap-2">
            <Input value={nuevaCat} onChange={(e) => setNuevaCat(e.target.value)} placeholder="Nueva categoría" />
            <Boton disabled={!nuevaCat.trim()} onClick={() => crearCat.mutate()}>Agregar</Boton>
          </div>
        </Tarjeta>
      )}
      {f && (
        <Modal abierto onCerrar={() => setF(null)} titulo={f.id ? 'Editar servicio' : 'Nuevo servicio'} ancho="lg" pie={<><Boton onClick={() => setF(null)}>Cancelar</Boton><Boton variante="primario" disabled={f.nombre.trim().length < 2} cargando={guardar.isPending} onClick={() => guardar.mutate()}>Guardar</Boton></>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Campo label="Nombre" requerido className="sm:col-span-2"><Input value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} autoFocus /></Campo>
            <Campo label="Categoría">
              <Select value={f.categoria_id ?? ''} onChange={(e) => setF({ ...f, categoria_id: e.target.value })}>
                <option value="">Sin categoría</option>
                {cats.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </Select>
            </Campo>
            <Campo label="Precio"><InputMoneda value={f.precio} onChange={(v) => setF({ ...f, precio: v })} /></Campo>
            <Campo label="Tipo de vehículo">
              <Select value={f.tipo_vehiculo} onChange={(e) => setF({ ...f, tipo_vehiculo: e.target.value })}>
                {TIPOS_VEHICULO.map((t) => <option key={t} value={t}>{TIPO_VEHICULO_LABEL[t]}</option>)}
              </Select>
            </Campo>
            <div className="grid grid-cols-2 gap-3">
              <Campo label="Cada (km)"><Input value={f.intervalo_km} onChange={(e) => setF({ ...f, intervalo_km: e.target.value.replace(/\D/g, '') })} inputMode="numeric" /></Campo>
              <Campo label="Cada (meses)"><Input value={f.intervalo_meses} onChange={(e) => setF({ ...f, intervalo_meses: e.target.value.replace(/\D/g, '') })} inputMode="numeric" /></Campo>
            </div>
            <Campo label="Incluye (uno por línea)" className="sm:col-span-2" hint="Ej.: filtro de aceite, filtro de aire…">
              <Textarea rows={3} value={(f.checks ?? []).join('\n')} onChange={(e) => setF({ ...f, checks: e.target.value.split('\n').map((x: string) => x.trim()).filter(Boolean) })} />
            </Campo>
            {f.id && <Check checked={f.activo} onChange={(v) => setF({ ...f, activo: v })} label="Activo (visible al cargar trabajos)" />}
          </div>
        </Modal>
      )}
      {ajuste && (
        <Modal abierto onCerrar={() => setAjuste(null)} titulo="Ajuste masivo de precios" ancho="sm" pie={<><Boton onClick={() => setAjuste(null)}>Cancelar</Boton><Boton variante="primario" cargando={masivo.isPending} onClick={() => masivo.mutate()}>Aplicar</Boton></>}>
          <div className="space-y-3">
            <Campo label="Categoría">
              <Select value={ajuste.categoria_id} onChange={(e) => setAjuste({ ...ajuste, categoria_id: e.target.value })}>
                <option value="">Todas</option>
                {cats.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </Select>
            </Campo>
            <Campo label="Porcentaje (negativo para bajar)"><Input type="number" value={ajuste.porcentaje} onChange={(e) => setAjuste({ ...ajuste, porcentaje: e.target.value })} /></Campo>
            <Campo label="Redondeo">
              <Select value={ajuste.redondeo} onChange={(e) => setAjuste({ ...ajuste, redondeo: e.target.value })}>
                <option value="ninguno">Sin redondeo</option><option value="10">A múltiplo de $10</option><option value="100">A múltiplo de $100</option><option value="1000">A múltiplo de $1.000</option>
              </Select>
            </Campo>
          </div>
        </Modal>
      )}
    </>
  );
}

function Catalogos() {
  const qc = useQueryClient();
  const toast = useToast();
  const { confirmar, dialogo } = useConfirmar();
  const { data: marcas = [] } = useMarcas();
  const { data: cats = [] } = useQuery({ queryKey: ['categorias-articulo'], queryFn: () => api.get<any[]>('/categorias-articulo') });
  const [marcaSel, setMarcaSel] = useState('');
  const [nuevaMarca, setNuevaMarca] = useState('');
  const [nuevoModelo, setNuevoModelo] = useState('');
  const [nuevaCat, setNuevaCat] = useState('');
  const inv = (k: string) => qc.invalidateQueries({ queryKey: [k] });
  const op = (fn: () => Promise<unknown>, k: string) => fn().then(() => inv(k)).catch(toast.error);
  const marca = marcas.find((m) => m.id === marcaSel);
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {dialogo}
      <Tarjeta titulo="Marcas y modelos">
        <div className="flex gap-2">
          <Select value={marcaSel} onChange={(e) => setMarcaSel(e.target.value)}>
            <option value="">— Elegir marca —</option>
            {marcas.map((m) => <option key={m.id} value={m.id}>{m.nombre} ({m.modelos.length})</option>)}
          </Select>
        </div>
        <div className="mt-2 flex gap-2">
          <Input value={nuevaMarca} onChange={(e) => setNuevaMarca(e.target.value)} placeholder="Nueva marca" />
          <Boton disabled={!nuevaMarca.trim()} onClick={() => op(() => api.post('/marcas', { nombre: nuevaMarca.trim() }), 'marcas').then(() => setNuevaMarca(''))}>Agregar</Boton>
        </div>
        {marca && (
          <div className="mt-4">
            <h3 className="mb-2 text-sm font-semibold">Modelos de {marca.nombre}</h3>
            <ul className="flex flex-wrap gap-1.5">
              {marca.modelos.map((mo) => (
                <li key={mo.id} className="flex items-center gap-1 rounded-full border border-borde bg-white py-0.5 pl-3 pr-1 text-sm">
                  {mo.nombre}
                  <button type="button" className="rounded-full p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label="Eliminar modelo" onClick={async () => { if (await confirmar('Eliminar modelo', `¿Eliminar ${mo.nombre}?`, true)) op(() => api.del(`/modelos/${mo.id}`), 'marcas'); }}><Trash2 className="size-3.5" /></button>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex gap-2">
              <Input value={nuevoModelo} onChange={(e) => setNuevoModelo(e.target.value)} placeholder="Nuevo modelo" />
              <Boton disabled={!nuevoModelo.trim()} onClick={() => op(() => api.post('/modelos', { marca_id: marca.id, nombre: nuevoModelo.trim() }), 'marcas').then(() => setNuevoModelo(''))}>Agregar</Boton>
            </div>
          </div>
        )}
      </Tarjeta>
      <Tarjeta titulo="Categorías de artículos">
        <ul className="divide-y divide-borde text-sm">
          {cats.map((c) => (
            <li key={c.id} className="flex items-center justify-between py-2">
              <span>{c.nombre} <span className="text-tenue">({c.articulos})</span></span>
              <Boton tam="sm" variante="fantasma" icono={<Trash2 className="size-4" />} aria-label="Eliminar" onClick={async () => { if (await confirmar('Eliminar categoría', `¿Eliminar ${c.nombre}?`, true)) op(() => api.del(`/categorias-articulo/${c.id}`), 'categorias-articulo'); }} />
            </li>
          ))}
        </ul>
        <div className="mt-3 flex gap-2">
          <Input value={nuevaCat} onChange={(e) => setNuevaCat(e.target.value)} placeholder="Nueva categoría" />
          <Boton disabled={!nuevaCat.trim()} onClick={() => op(() => api.post('/categorias-articulo', { nombre: nuevaCat.trim() }), 'categorias-articulo').then(() => setNuevaCat(''))}>Agregar</Boton>
        </div>
      </Tarjeta>
    </div>
  );
}

function Auditoria() {
  const { data = [], isLoading } = useQuery({ queryKey: ['auditoria'], queryFn: () => api.get<any[]>('/taller/auditoria') });
  if (isLoading) return <Cargando />;
  return (
    <Tarjeta titulo="Registro de actividad" subtitulo="Últimas 200 acciones" sinPadding>
      <Tabla
        filas={data}
        clave={(a) => `${a.created_at}-${a.entidad_id}-${a.accion}`}
        columnas={[
          { clave: 'f', titulo: 'Fecha', render: (a) => fechaHora(a.created_at), movil: 'meta' },
          { clave: 'u', titulo: 'Usuario', render: (a) => a.usuario ?? '—', movil: 'subtitulo' },
          { clave: 'e', titulo: 'Acción', render: (a) => `${a.entidad} · ${a.accion}`, movil: 'titulo' },
        ]}
      />
    </Tarjeta>
  );
}

type Tab = 'taller' | 'usuarios' | 'mecanicos' | 'servicios' | 'catalogos' | 'licencia' | 'cuenta' | 'auditoria';

export function Configuracion() {
  const { puede } = useAuth();
  const [tab, setTab] = useState<Tab>('taller');
  const items: Array<{ clave: Tab; titulo: string; ok: boolean }> = [
    { clave: 'taller', titulo: 'Taller y preferencias', ok: true },
    { clave: 'usuarios', titulo: 'Usuarios y permisos', ok: puede('usuarios.gestionar') },
    { clave: 'mecanicos', titulo: 'Mecánicos', ok: true },
    { clave: 'servicios', titulo: 'Servicios', ok: true },
    { clave: 'catalogos', titulo: 'Marcas y categorías', ok: puede('catalogo.editar') },
    { clave: 'licencia', titulo: 'Licencia', ok: puede('licencia.ver') },
    { clave: 'auditoria', titulo: 'Actividad', ok: puede('config.editar') },
    { clave: 'cuenta', titulo: 'Mi cuenta', ok: true },
  ];
  return (
    <>
      <Encabezado titulo="Configuración" />
      <Pestanas items={items.filter((i) => i.ok).map(({ clave, titulo }) => ({ clave, titulo }))} activo={tab} onCambio={setTab} />
      {tab === 'taller' && <DatosTaller />}
      {tab === 'usuarios' && <Usuarios />}
      {tab === 'mecanicos' && <Mecanicos />}
      {tab === 'servicios' && <Servicios />}
      {tab === 'catalogos' && <Catalogos />}
      {tab === 'licencia' && <Licencia />}
      {tab === 'auditoria' && <Auditoria />}
      {tab === 'cuenta' && <MiCuenta />}
    </>
  );
}
