// Equipo: personal del taller, roles (plantillas), permisos individuales, acceso, PIN del reloj y actividad.
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, RotateCcw, ShieldAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fechaHora, fechaHoraZona } from '@/lib/format';
import { Aviso, Boton, Campo, Cargando, Check, Encabezado, ErrorCaja, Input, Insignia, Modal, Pestanas, Select, Tabla, Tarjeta, useConfirmar, useToast } from '@/components/ui';
import { alternarPermiso, GRUPOS_PERMISOS, INFO_PERMISOS, PLANTILLAS, ROL_LABEL, type Permiso, type Rol } from '@shared/permisos';

const nombreCompleto = (u: any) => [u.nombre, u.apellido].filter(Boolean).join(' ');
const TONO_ROL: Record<string, 'violeta' | 'azul' | 'verde' | 'ambar' | 'cian' | 'gris'> = { propietario: 'violeta', administrador: 'azul', recepcion: 'verde', mecanico: 'ambar', deposito: 'cian', caja: 'verde', empleado: 'gris' };

interface Plantilla { codigo: Rol; etiqueta: string; descripcion: string; heredada: boolean; asignable: boolean; permisos: Permiso[] }

const VACIO = { nombre: '', apellido: '', documento: '', cargo: '', telefono: '', fecha_incorporacion: '', rol: 'recepcion' as Rol, acceso_erp: true, email: '', password: '', es_mecanico: false, pin: '' };

export function Equipo() {
  const qc = useQueryClient();
  const toast = useToast();
  const { me, puede } = useAuth();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['usuarios'], queryFn: () => api.get('/taller/usuarios') });
  const { data: roles = [] } = useQuery({ queryKey: ['roles'], queryFn: () => api.get<Plantilla[]>('/taller/roles') });
  const [nuevo, setNuevo] = useState(false);
  const [f, setF] = useState(VACIO);
  const [editando, setEditando] = useState<string | null>(null);
  const inv = () => qc.invalidateQueries({ queryKey: ['usuarios'] });
  const asignables = roles.filter((r) => r.asignable && (!r.heredada || f.rol === r.codigo));

  const crear = useMutation({
    mutationFn: () =>
      api.post('/taller/usuarios', {
        nombre: f.nombre, apellido: f.apellido || null, documento: f.documento || null, cargo: f.cargo || null, telefono: f.telefono || null,
        fecha_incorporacion: f.fecha_incorporacion || null, rol: f.rol, acceso_erp: f.acceso_erp,
        ...(f.acceso_erp ? { email: f.email, password: f.password } : {}), es_mecanico: f.es_mecanico || f.rol === 'mecanico', pin: f.pin || null,
      }),
    onSuccess: () => { inv(); qc.invalidateQueries({ queryKey: ['mecanicos'] }); setNuevo(false); setF(VACIO); toast.ok('Persona agregada al equipo'); },
    onError: toast.error,
  });

  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  const lic = data.licencia;
  const rolSel = roles.find((r) => r.codigo === f.rol);

  return (
    <>
      <Encabezado
        titulo="Equipo y permisos"
        subtitulo="Personal del taller, roles, permisos individuales y acceso al sistema"
        acciones={<Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => { setF(VACIO); setNuevo(true); }}>Agregar persona</Boton>}
      />
      <Tarjeta
        titulo="Personal"
        subtitulo={`${lic.usuarios_activos} de ${lic.usuarios_max} lugares de la licencia en uso (cuentan las personas activas con acceso al sistema; quien solo ficha con PIN no ocupa lugar)`}
        sinPadding
      >
        {lic.disponibles <= 0 && <Aviso tono="ambar" className="m-4">Alcanzaste el límite de usuarios con acceso de la licencia. Podés seguir agregando personal que solo ficha con PIN; para más usuarios con acceso, contratá usuarios adicionales.</Aviso>}
        <Tabla
          filas={data.usuarios as any[]}
          clave={(u) => u.id}
          onFila={(u) => setEditando(u.id)}
          columnas={[
            { clave: 'n', titulo: 'Persona', render: (u) => <span className="font-medium">{nombreCompleto(u)}{u.id === me?.usuario.id ? ' (vos)' : ''}{u.cargo ? <span className="block text-xs font-normal text-tenue">{u.cargo}</span> : null}</span>, movil: 'titulo' },
            { clave: 'e', titulo: 'Acceso', render: (u) => (u.acceso_erp ? u.email : <span className="text-tenue">Solo fichaje con PIN</span>), movil: 'subtitulo' },
            { clave: 'r', titulo: 'Rol', render: (u) => <span className="flex flex-wrap items-center gap-1"><Insignia tono={TONO_ROL[u.rol] ?? 'gris'}>{ROL_LABEL[u.rol as Rol] ?? u.rol}</Insignia>{u.personalizado && <Insignia tono="ambar">Personalizado</Insignia>}</span>, movil: 'meta' },
            { clave: 'p', titulo: 'PIN', render: (u) => (u.pin_bloqueado ? <Insignia tono="rojo">Bloqueado</Insignia> : u.tiene_pin ? <Insignia tono="verde">Configurado</Insignia> : <Insignia tono="gris">Sin PIN</Insignia>), movil: 'oculta' },
            { clave: 'l', titulo: 'Último ingreso', render: (u) => (u.acceso_erp ? fechaHora(u.ultimo_login) : '—'), movil: 'oculta' },
            { clave: 'a', titulo: 'Estado', render: (u) => <Insignia tono={u.activo ? 'verde' : 'gris'}>{u.activo ? 'Activo' : 'Inactivo'}</Insignia>, movil: 'meta' },
          ]}
        />
      </Tarjeta>

      <Tarjeta titulo="Roles disponibles" className="mt-5" subtitulo="Cada rol es una plantilla de permisos. Después de asignarlo podés ajustar los permisos de cada persona.">
        <ul className="grid gap-3 md:grid-cols-2">
          {(['propietario', 'administrador', 'recepcion', 'mecanico', 'deposito', 'caja'] as Rol[]).map((r) => (
            <li key={r} className="rounded-ctl border border-borde p-3 text-sm">
              <div className="mb-1 flex items-center gap-2"><Insignia tono={TONO_ROL[r]}>{PLANTILLAS[r].etiqueta}</Insignia></div>
              <p className="text-tenue">{PLANTILLAS[r].descripcion}</p>
            </li>
          ))}
        </ul>
      </Tarjeta>

      <Modal abierto={nuevo} onCerrar={() => setNuevo(false)} titulo="Agregar persona" ancho="lg"
        pie={<><Boton onClick={() => setNuevo(false)}>Cancelar</Boton><Boton variante="primario" cargando={crear.isPending} disabled={f.nombre.trim().length < 2 || (f.acceso_erp && (!f.email || f.password.length < 8))} onClick={() => crear.mutate()}>Agregar</Boton></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Campo label="Nombre" requerido><Input value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} /></Campo>
          <Campo label="Apellido"><Input value={f.apellido} onChange={(e) => setF({ ...f, apellido: e.target.value })} /></Campo>
          <Campo label="Identificación personal (DNI)"><Input value={f.documento} inputMode="numeric" onChange={(e) => setF({ ...f, documento: e.target.value })} /></Campo>
          <Campo label="Cargo o función"><Input value={f.cargo} onChange={(e) => setF({ ...f, cargo: e.target.value })} placeholder="Ej.: Mecánico de motor" /></Campo>
          <Campo label="Teléfono"><Input value={f.telefono} inputMode="tel" onChange={(e) => setF({ ...f, telefono: e.target.value })} /></Campo>
          <Campo label="Fecha de incorporación"><Input type="date" value={f.fecha_incorporacion} onChange={(e) => setF({ ...f, fecha_incorporacion: e.target.value })} /></Campo>
          <Campo label="Rol" className="sm:col-span-2" hint={rolSel?.descripcion}>
            <Select value={f.rol} onChange={(e) => setF({ ...f, rol: e.target.value as Rol })}>
              {asignables.map((r) => <option key={r.codigo} value={r.codigo}>{r.etiqueta}</option>)}
            </Select>
          </Campo>
          <div className="space-y-2 sm:col-span-2">
            <Check checked={f.acceso_erp} onChange={(v) => setF({ ...f, acceso_erp: v })} label="Tiene acceso al sistema (correo y contraseña)" />
            {!f.acceso_erp && <p className="pl-6 text-xs text-tenue">Sin acceso, la persona solo ficha su asistencia con un PIN en el reloj compartido y no ocupa un lugar de la licencia.</p>}
            {f.rol !== 'mecanico' && <Check checked={f.es_mecanico} onChange={(v) => setF({ ...f, es_mecanico: v })} label="Se le asignan órdenes de trabajo (aparece como mecánico)" />}
          </div>
          {f.acceso_erp && (
            <>
              <Campo label="Correo de acceso" requerido><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="off" /></Campo>
              <Campo label="Contraseña inicial" requerido hint="Mínimo 8 caracteres."><Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></Campo>
            </>
          )}
          <Campo label="PIN para fichar (opcional)" hint="De 4 a 8 dígitos. También se puede configurar después."><Input value={f.pin} inputMode="numeric" maxLength={8} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '') })} autoComplete="off" /></Campo>
        </div>
      </Modal>

      {editando && <FichaPersona id={editando} roles={roles} onCerrar={() => setEditando(null)} onCambio={inv} puedePermisos={puede('permisos.gestionar')} puedePin={puede('reloj.administrar')} />}
    </>
  );
}

function FichaPersona({ id, roles, onCerrar, onCambio, puedePermisos, puedePin }: { id: string; roles: Plantilla[]; onCerrar: () => void; onCambio: () => void; puedePermisos: boolean; puedePin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const { confirmar, dialogo } = useConfirmar();
  const { data: u, isLoading, error, refetch } = useQuery({ queryKey: ['usuario', id], queryFn: () => api.get(`/taller/usuarios/${id}`) });
  const [tab, setTab] = useState<'perfil' | 'permisos' | 'acceso' | 'actividad'>('perfil');
  const [p, setP] = useState<any>(null);
  const [sel, setSel] = useState<Set<Permiso>>(new Set());
  const [pin, setPin] = useState('');
  const [clave, setClave] = useState('');
  const [acceso, setAcceso] = useState({ email: '', password: '' });
  useEffect(() => {
    if (u) {
      setP({ nombre: u.nombre ?? '', apellido: u.apellido ?? '', documento: u.documento ?? '', cargo: u.cargo ?? '', telefono: u.telefono ?? '', fecha_incorporacion: u.fecha_incorporacion ?? '', rol: u.rol, es_mecanico: !!u.mecanico_id });
      setSel(new Set(u.permisos));
    }
  }, [u]);
  const refrescar = () => { onCambio(); qc.invalidateQueries({ queryKey: ['usuario', id] }); qc.invalidateQueries({ queryKey: ['mecanicos'] }); };
  const patch = useMutation({
    mutationFn: (d: any) => api.patch(`/taller/usuarios/${id}`, d),
    onSuccess: () => { refrescar(); toast.ok('Cambios guardados'); setClave(''); },
    onError: toast.error,
  });
  const guardarPermisos = useMutation({
    mutationFn: (permisos: Permiso[] | null) => api.put(`/taller/usuarios/${id}/permisos`, { permisos }),
    onSuccess: () => { refrescar(); toast.ok('Permisos actualizados: rigen desde la próxima acción de la persona'); },
    onError: toast.error,
  });
  const pinM = useMutation({
    mutationFn: (accion: 'set' | 'quitar' | 'desbloquear') =>
      accion === 'set' ? api.put(`/taller/usuarios/${id}/pin`, { pin }) : accion === 'quitar' ? api.del(`/taller/usuarios/${id}/pin`) : api.post(`/taller/usuarios/${id}/pin/desbloquear`),
    onSuccess: () => { refrescar(); setPin(''); toast.ok('PIN actualizado'); },
    onError: toast.error,
  });

  const soyYo = id === me?.usuario.id;
  const esPropietario = u?.nivel === 'propietario';
  const permisosMios = useMemo(() => new Set(me?.permisos ?? []), [me]);
  const nivelMio = me?.usuario.nivel;
  const puedeEditarPermisos = puedePermisos && !soyYo && !esPropietario && (nivelMio === 'propietario' || u?.nivel === 'empleado');
  const rolesAsignables = roles.filter((r) => r.asignable || r.codigo === u?.rol);

  return (
    <Modal abierto onCerrar={onCerrar} titulo={u ? nombreCompleto(u) : 'Persona'} ancho="xl">
      {dialogo}
      {isLoading || !p ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <>
          <Pestanas items={[{ clave: 'perfil', titulo: 'Perfil' }, { clave: 'permisos', titulo: 'Permisos' }, { clave: 'acceso', titulo: 'Acceso y PIN' }, { clave: 'actividad', titulo: 'Actividad' }]} activo={tab} onCambio={setTab} />
          <div className="mt-4">
            {tab === 'perfil' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Campo label="Nombre" requerido><Input value={p.nombre} onChange={(e) => setP({ ...p, nombre: e.target.value })} /></Campo>
                <Campo label="Apellido"><Input value={p.apellido} onChange={(e) => setP({ ...p, apellido: e.target.value })} /></Campo>
                <Campo label="Identificación personal (DNI)"><Input value={p.documento} onChange={(e) => setP({ ...p, documento: e.target.value })} /></Campo>
                <Campo label="Cargo o función"><Input value={p.cargo} onChange={(e) => setP({ ...p, cargo: e.target.value })} /></Campo>
                <Campo label="Teléfono"><Input value={p.telefono} onChange={(e) => setP({ ...p, telefono: e.target.value })} /></Campo>
                <Campo label="Fecha de incorporación"><Input type="date" value={p.fecha_incorporacion} onChange={(e) => setP({ ...p, fecha_incorporacion: e.target.value })} /></Campo>
                <Campo label="Rol" className="sm:col-span-2" hint={PLANTILLAS[p.rol as Rol]?.descripcion}>
                  <Select value={p.rol} disabled={soyYo || esPropietario} onChange={(e) => setP({ ...p, rol: e.target.value })}>
                    {esPropietario && <option value="propietario">Propietario</option>}
                    {rolesAsignables.map((r) => <option key={r.codigo} value={r.codigo} disabled={!r.asignable}>{r.etiqueta}</option>)}
                  </Select>
                  {p.rol !== u.rol && <span className="mt-1 block text-xs text-amber-700">Al cambiar el rol se reemplazan los permisos personalizados por los de la plantilla.</span>}
                </Campo>
                <div className="sm:col-span-2"><Check checked={p.es_mecanico} onChange={(v) => setP({ ...p, es_mecanico: v })} label="Se le asignan órdenes de trabajo (aparece como mecánico)" /></div>
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-borde pt-3 sm:col-span-2">
                  <div>
                    {!esPropietario && !soyYo && (
                      <Boton variante={u.activo ? 'peligro' : 'exito'} onClick={async () => { if (!u.activo || (await confirmar('Desactivar persona', `${nombreCompleto(u)} no podrá ingresar ni fichar y se cerrarán sus sesiones. Su historial se conserva.`, true))) patch.mutate({ activo: !u.activo }); }}>
                        {u.activo ? 'Desactivar' : 'Reactivar'}
                      </Boton>
                    )}
                  </div>
                  <Boton variante="primario" cargando={patch.isPending} disabled={p.nombre.trim().length < 2}
                    onClick={() => patch.mutate({
                      nombre: p.nombre, apellido: p.apellido || null, documento: p.documento || null, cargo: p.cargo || null, telefono: p.telefono || null,
                      fecha_incorporacion: p.fecha_incorporacion || null, es_mecanico: p.es_mecanico, ...(p.rol !== u.rol ? { rol: p.rol } : {}),
                    })}>
                    Guardar perfil
                  </Boton>
                </div>
              </div>
            )}

            {tab === 'permisos' && (
              <div className="space-y-4">
                {esPropietario ? (
                  <Aviso tono="azul">El propietario siempre tiene todos los permisos.</Aviso>
                ) : !puedePermisos ? (
                  <Aviso tono="ambar">Solo quien tiene el permiso "Gestionar permisos" puede modificarlos.</Aviso>
                ) : soyYo ? (
                  <Aviso tono="ambar">No podés modificar tus propios permisos.</Aviso>
                ) : !puedeEditarPermisos ? (
                  <Aviso tono="ambar">Solo el propietario puede modificar los permisos de un administrador.</Aviso>
                ) : (
                  <Aviso tono="azul">Rol base: <strong>{ROL_LABEL[u.rol as Rol]}</strong>. Marcá o desmarcá permisos para esta persona; los cambios rigen de inmediato, sin que tenga que volver a ingresar. Solo podés otorgar permisos que vos tenés.</Aviso>
                )}
                {u.personalizado && <p className="text-sm text-amber-700">Esta persona tiene permisos personalizados (+{u.ajustes.g.length} / −{u.ajustes.r.length} respecto del rol).</p>}
                <div className="grid gap-4 md:grid-cols-2">
                  {GRUPOS_PERMISOS.map((g) => (
                    <section key={g.titulo} className="rounded-ctl border border-borde p-3">
                      <h3 className="mb-2 text-sm font-semibold">{g.titulo}</h3>
                      <ul className="space-y-1.5">
                        {g.permisos.map((perm) => {
                          const marcado = sel.has(perm);
                          const deRol = PLANTILLAS[u.rol as Rol]?.permisos.includes(perm) || esPropietario;
                          const sinPoder = !esPropietario && nivelMio !== 'propietario' && !permisosMios.has(perm) && !marcado;
                          return (
                            <li key={perm}>
                              <Check checked={marcado} disabled={!puedeEditarPermisos || sinPoder} onChange={(v) => setSel(alternarPermiso(sel, perm, v))}
                                label={<span>{INFO_PERMISOS[perm].etiqueta}{marcado !== deRol && <span className="ml-1.5 rounded bg-amber-100 px-1 text-[10px] font-semibold uppercase text-amber-800">{marcado ? 'agregado' : 'quitado'}</span>}{INFO_PERMISOS[perm].ayuda && <span className="block text-xs font-normal text-tenue">{INFO_PERMISOS[perm].ayuda}</span>}</span>} />
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  ))}
                </div>
                {puedeEditarPermisos && (
                  <div className="flex flex-wrap justify-between gap-2 border-t border-borde pt-3">
                    <Boton icono={<RotateCcw className="size-4" />} onClick={async () => { if (await confirmar('Restablecer permisos', `Se vuelve a los permisos del rol ${ROL_LABEL[u.rol as Rol]}.`)) guardarPermisos.mutate(null); }}>Restablecer según el rol</Boton>
                    <Boton variante="primario" cargando={guardarPermisos.isPending} onClick={() => guardarPermisos.mutate([...sel])}>Guardar permisos</Boton>
                  </div>
                )}
              </div>
            )}

            {tab === 'acceso' && (
              <div className="space-y-5">
                <section>
                  <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><KeyRound className="size-4" /> Acceso al sistema</h3>
                  {u.acceso_erp ? (
                    <div className="space-y-3">
                      <p className="text-sm">Correo de acceso: <strong>{u.email}</strong></p>
                      <div className="flex flex-wrap items-end gap-2">
                        <Campo label="Nueva contraseña" hint="Mínimo 8 caracteres. Se cierran sus sesiones abiertas." className="min-w-56 flex-1">
                          <Input type="password" value={clave} onChange={(e) => setClave(e.target.value)} autoComplete="new-password" />
                        </Campo>
                        <Boton disabled={clave.length < 8} cargando={patch.isPending} onClick={() => patch.mutate({ password: clave })}>Cambiar contraseña</Boton>
                      </div>
                      {!esPropietario && !soyYo && (
                        <Boton variante="fantasma" onClick={async () => { if (await confirmar('Quitar acceso al sistema', `${nombreCompleto(u)} dejará de poder ingresar, pero podrá seguir fichando con su PIN.`, true)) patch.mutate({ acceso_erp: false }); }}>Quitar acceso al sistema (solo fichaje con PIN)</Boton>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-sm text-tenue">Esta persona solo ficha su asistencia con PIN. Para darle acceso al sistema indicá un correo y una contraseña inicial (ocupa un lugar de la licencia).</p>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Campo label="Correo de acceso"><Input type="email" value={acceso.email} onChange={(e) => setAcceso({ ...acceso, email: e.target.value })} /></Campo>
                        <Campo label="Contraseña inicial"><Input type="password" value={acceso.password} onChange={(e) => setAcceso({ ...acceso, password: e.target.value })} autoComplete="new-password" /></Campo>
                      </div>
                      <Boton variante="primario" disabled={!acceso.email || acceso.password.length < 8} cargando={patch.isPending} onClick={() => patch.mutate({ acceso_erp: true, ...acceso })}>Dar acceso al sistema</Boton>
                    </div>
                  )}
                </section>
                <section className="border-t border-borde pt-4">
                  <h3 className="mb-2 text-sm font-semibold">PIN para fichar en el reloj compartido</h3>
                  {!puedePin ? <p className="text-sm text-tenue">No tenés permiso para administrar PIN.</p> : (
                    <div className="space-y-3">
                      <p className="text-sm">{u.tiene_pin ? <Insignia tono={u.pin_bloqueado ? 'rojo' : 'verde'}>{u.pin_bloqueado ? 'PIN bloqueado por intentos fallidos' : 'PIN configurado'}</Insignia> : <Insignia>Sin PIN</Insignia>}</p>
                      <div className="flex flex-wrap items-end gap-2">
                        <Campo label={u.tiene_pin ? 'Nuevo PIN' : 'PIN'} hint="De 4 a 8 dígitos; evitá secuencias y repeticiones. Se guarda cifrado: nadie puede consultarlo." className="min-w-56 flex-1">
                          <Input value={pin} inputMode="numeric" maxLength={8} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} autoComplete="off" />
                        </Campo>
                        <Boton variante="primario" disabled={pin.length < 4} cargando={pinM.isPending} onClick={() => pinM.mutate('set')}>{u.tiene_pin ? 'Cambiar PIN' : 'Asignar PIN'}</Boton>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {u.pin_bloqueado && <Boton onClick={() => pinM.mutate('desbloquear')}>Desbloquear PIN</Boton>}
                        {u.tiene_pin && <Boton variante="fantasma" onClick={async () => { if (await confirmar('Quitar PIN', 'La persona no podrá fichar en el reloj compartido hasta que se le asigne otro.', true)) pinM.mutate('quitar'); }}>Quitar PIN</Boton>}
                      </div>
                    </div>
                  )}
                </section>
              </div>
            )}

            {tab === 'actividad' && (
              u.actividad.length === 0 ? <p className="py-6 text-center text-sm text-tenue">Sin actividad registrada.</p> : (
                <ul className="divide-y divide-borde text-sm">
                  {u.actividad.map((a: any, i: number) => (
                    <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span><strong className="capitalize">{a.entidad}</strong> · {a.accion.replace(/_/g, ' ')}</span>
                      <span className="text-xs text-tenue">{fechaHoraZona(a.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )
            )}
          </div>
          {u.ultimo_login && tab === 'perfil' && <p className="mt-3 flex items-center gap-1.5 text-xs text-tenue"><ShieldAlert className="size-3.5" /> Último ingreso: {fechaHora(u.ultimo_login)}</p>}
        </>
      )}
    </Modal>
  );
}
