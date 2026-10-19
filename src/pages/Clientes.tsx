import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Car, FileText, MessageCircle, Pencil, Plus, Trash2, Users, Wallet, Wrench } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fecha, km, money, numero, whatsapp } from '@/lib/format';
import { Boton, Buscador, Cargando, Dato, Encabezado, ErrorCaja, Insignia, Modal, Tabla, Tarjeta, useConfirmar, useDebounce, useToast, Vacio } from '@/components/ui';
import { EstadoOTBadge } from '@/components/estados';
import { FormCliente, FormVehiculo } from '@/components/selectores';
import { ModalCobro } from '@/components/Cobro';
import { CONDICION_IVA_LABEL, type CondicionIva } from '@shared/dominio';

export function Clientes() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [alta, setAlta] = useState(false);
  const dq = useDebounce(q);
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['clientes', { q: dq }], queryFn: () => api.get<any[]>(`/clientes?q=${encodeURIComponent(dq)}&limite=300`) });
  return (
    <>
      <Encabezado titulo="Clientes" subtitulo="Clientes del taller y sus vehículos" acciones={<Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => setAlta(true)}>Nuevo cliente</Boton>} />
      <Buscador value={q} onChange={setQ} placeholder="Nombre, teléfono, documento o patente" className="mb-4" />
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={data}
            clave={(c) => c.id}
            onFila={(c) => nav(`/clientes/${c.id}`)}
            vacio={<Vacio icono={<Users className="size-5" />} titulo="No hay clientes" />}
            columnas={[
              { clave: 'cod', titulo: 'Cód.', render: (c) => <span className="text-tenue">#{numero(c.codigo)}</span>, movil: 'oculta' },
              { clave: 'n', titulo: 'Nombre', render: (c) => <span className="font-medium">{c.nombre}</span>, movil: 'titulo' },
              { clave: 't', titulo: 'Teléfono', render: (c) => c.telefono ?? '—', movil: 'subtitulo' },
              { clave: 'd', titulo: 'Documento', render: (c) => c.documento ?? '—', movil: 'oculta' },
              { clave: 'v', titulo: 'Vehículos', render: (c) => `${c.vehiculos} vehículo${c.vehiculos === 1 ? '' : 's'}`, movil: 'meta' },
              { clave: 's', titulo: 'Saldo', alinear: 'derecha', render: (c) => (c.saldo > 0 ? <span className="font-semibold text-red-600">{money(c.saldo)}</span> : <span className="text-tenue">—</span>), movil: 'derecha' },
            ]}
          />
        </Tarjeta>
      )}
      <Modal abierto={alta} onCerrar={() => setAlta(false)} titulo="Nuevo cliente" ancho="lg">
        <FormCliente onCancelar={() => setAlta(false)} onGuardado={(c) => { setAlta(false); nav(`/clientes/${c.id}`); }} />
      </Modal>
    </>
  );
}

export function ClienteDetalle() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { puede, me } = useAuth();
  const { confirmar, dialogo } = useConfirmar();
  const { data: c, isLoading, error, refetch } = useQuery({ queryKey: ['cliente', id], queryFn: () => api.get(`/clientes/${id}`) });
  const [editar, setEditar] = useState(false);
  const [vehiculo, setVehiculo] = useState(false);
  const [cobro, setCobro] = useState(false);
  const baja = useMutation({
    mutationFn: () => api.del(`/clientes/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clientes'] });
      toast.ok('Cliente desactivado');
      nav('/clientes');
    },
    onError: toast.error,
  });
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  const wa = whatsapp(c.telefono, `Hola ${c.nombre}! Te escribimos de ${me?.taller.nombre}.`);

  return (
    <>
      {dialogo}
      <Encabezado
        volver="/clientes"
        titulo={c.nombre}
        subtitulo={`Cliente #${numero(c.codigo)}${c.activo ? '' : ' · inactivo'}`}
        acciones={
          <>
            {wa && <a href={wa} target="_blank" rel="noreferrer"><Boton icono={<MessageCircle className="size-4" />}>WhatsApp</Boton></a>}
            <Boton icono={<Pencil className="size-4" />} onClick={() => setEditar(true)}>Editar</Boton>
            <Boton icono={<FileText className="size-4" />} onClick={() => nav('/presupuestos/nuevo')}>Presupuesto</Boton>
            <Boton variante="primario" icono={<Wrench className="size-4" />} onClick={() => nav(`/ordenes/nueva?cliente=${c.id}`)}>Nueva OT</Boton>
          </>
        }
      />
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Tarjeta titulo="Vehículos" sinPadding acciones={<Boton tam="sm" icono={<Plus className="size-4" />} onClick={() => setVehiculo(true)}>Agregar</Boton>}>
            {c.vehiculos.length === 0 ? (
              <Vacio icono={<Car className="size-5" />} titulo="Sin vehículos registrados" />
            ) : (
              <ul className="divide-y divide-borde">
                {c.vehiculos.map((v: any) => (
                  <li key={v.id}>
                    <Link to={`/vehiculos/${v.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50">
                      <div>
                        <div className="font-semibold tracking-wide">{v.patente}</div>
                        <div className="text-sm text-tenue">{[v.marca, v.modelo, v.anio].filter(Boolean).join(' ') || 'Sin datos'}</div>
                      </div>
                      <span className="text-sm text-tenue">{km(v.km_actual)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Tarjeta>
          <Tarjeta titulo="Órdenes de trabajo" sinPadding>
            <Tabla
              filas={c.ordenes}
              clave={(o: any) => o.id}
              onFila={(o: any) => nav(`/ordenes/${o.id}`)}
              vacio={<p className="px-4 py-6 text-center text-sm text-tenue">Sin órdenes</p>}
              columnas={[
                { clave: 'n', titulo: 'OT', render: (o: any) => `#${numero(o.numero)}`, movil: 'titulo' },
                { clave: 'p', titulo: 'Patente', render: (o: any) => o.patente, movil: 'subtitulo' },
                { clave: 'f', titulo: 'Ingreso', render: (o: any) => fecha(o.fecha_ingreso), movil: 'meta' },
                { clave: 'e', titulo: 'Estado', render: (o: any) => <EstadoOTBadge estado={o.estado} />, movil: 'meta' },
                { clave: 't', titulo: 'Total', alinear: 'derecha', render: (o: any) => money(o.total), movil: 'derecha' },
              ]}
            />
          </Tarjeta>
        </div>
        <div className="space-y-5">
          <Tarjeta titulo="Cuenta corriente">
            <div className={c.saldo > 0 ? 'text-2xl font-bold text-red-600' : 'text-2xl font-bold'}>{money(c.saldo)}</div>
            <p className="text-sm text-tenue">{c.saldo > 0 ? 'Saldo pendiente de cobro' : 'Sin deuda'}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {c.saldo > 0 && puede('cobros.registrar') && <Boton variante="exito" tam="sm" icono={<Wallet className="size-4" />} onClick={() => setCobro(true)}>Registrar cobro</Boton>}
              {puede('ventas.ver') && <Boton tam="sm" onClick={() => nav(`/cuentas/${c.id}`)}>Ver movimientos</Boton>}
            </div>
          </Tarjeta>
          <Tarjeta titulo="Datos">
            <dl className="grid grid-cols-2 gap-4">
              <Dato etiqueta="Teléfono">{c.telefono}</Dato>
              <Dato etiqueta="Email">{c.email}</Dato>
              <Dato etiqueta="Documento">{c.documento ? `${c.documento_tipo} ${c.documento}` : null}</Dato>
              <Dato etiqueta="Condición IVA"><Insignia>{CONDICION_IVA_LABEL[c.condicion_iva as CondicionIva] ?? c.condicion_iva}</Insignia></Dato>
              <Dato etiqueta="Dirección" className="col-span-2">{[c.direccion, c.localidad].filter(Boolean).join(', ')}</Dato>
              <Dato etiqueta="Notas" className="col-span-2">{c.notas}</Dato>
            </dl>
          </Tarjeta>
          {puede('registros.eliminar') && c.codigo !== 0 && c.activo ? (
            <Boton variante="fantasma" className="w-full text-red-600" icono={<Trash2 className="size-4" />} onClick={async () => { if (await confirmar('Desactivar cliente', 'El cliente dejará de aparecer en las búsquedas. Su historial se conserva.', true)) baja.mutate(); }}>
              Desactivar cliente
            </Boton>
          ) : null}
        </div>
      </div>
      <Modal abierto={editar} onCerrar={() => setEditar(false)} titulo="Editar cliente" ancho="lg">
        <FormCliente inicial={c} onCancelar={() => setEditar(false)} onGuardado={() => setEditar(false)} />
      </Modal>
      <Modal abierto={vehiculo} onCerrar={() => setVehiculo(false)} titulo="Nuevo vehículo" ancho="lg">
        <FormVehiculo clienteId={c.id} onCancelar={() => setVehiculo(false)} onGuardado={() => setVehiculo(false)} />
      </Modal>
      {cobro && <ModalCobro abierto onCerrar={() => setCobro(false)} clienteId={c.id} />}
    </>
  );
}
