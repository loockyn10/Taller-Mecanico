// Selectores de entidades con alta rápida (cliente, vehículo) y formularios compartidos.
import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Car, Plus, UserRound, X } from 'lucide-react';
import { api } from '@/lib/api';
import { AccionesForm, Boton, Buscador, Campo, cn, Input, Modal, Select, Textarea, useDebounce, useToast } from './ui';
import { CONDICIONES_IVA, CONDICION_IVA_LABEL } from '@shared/dominio';
import { claveBusqueda, type CatVersion } from '@shared/catalogo-auto';
import { Combobox, rangoAnios, useCatMarcas, useCatModelo, useCatModelos, type Opcion } from './CatalogoAuto';

export interface ClienteMin {
  id: string;
  codigo: number;
  nombre: string;
  telefono: string | null;
  documento?: string | null;
}

// ───────────── Formulario de cliente ─────────────
export function FormCliente({ inicial, onGuardado, onCancelar }: { inicial?: any; onGuardado: (c: any) => void; onCancelar: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({
    nombre: inicial?.nombre ?? '',
    documento_tipo: inicial?.documento_tipo ?? 'DNI',
    documento: inicial?.documento ?? '',
    condicion_iva: inicial?.condicion_iva ?? 'consumidor_final',
    telefono: inicial?.telefono ?? '',
    email: inicial?.email ?? '',
    direccion: inicial?.direccion ?? '',
    localidad: inicial?.localidad ?? '',
    notas: inicial?.notas ?? '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () => (inicial?.id ? api.put(`/clientes/${inicial.id}`, f) : api.post('/clientes', f)),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['clientes'] });
      qc.invalidateQueries({ queryKey: ['cliente'] });
      toast.ok(inicial?.id ? 'Cliente actualizado' : 'Cliente creado');
      onGuardado(c);
    },
    onError: toast.error,
  });
  const enviar = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <form onSubmit={enviar} className="grid gap-3 sm:grid-cols-2">
      <Campo label="Nombre y apellido / Razón social" requerido className="sm:col-span-2">
        <Input value={f.nombre} onChange={set('nombre')} required minLength={2} autoFocus />
      </Campo>
      <Campo label="Teléfono (WhatsApp)">
        <Input value={f.telefono} onChange={set('telefono')} inputMode="tel" placeholder="11 5555-5555" />
      </Campo>
      <Campo label="Email">
        <Input type="email" value={f.email} onChange={set('email')} />
      </Campo>
      <Campo label="Documento">
        <div className="flex gap-2">
          <Select value={f.documento_tipo} onChange={set('documento_tipo')} className="w-24">
            {['DNI', 'CUIT', 'CUIL', 'OTRO'].map((t) => <option key={t}>{t}</option>)}
          </Select>
          <Input value={f.documento} onChange={set('documento')} inputMode="numeric" />
        </div>
      </Campo>
      <Campo label="Condición frente al IVA">
        <Select value={f.condicion_iva} onChange={set('condicion_iva')}>
          {CONDICIONES_IVA.map((c) => <option key={c} value={c}>{CONDICION_IVA_LABEL[c]}</option>)}
        </Select>
      </Campo>
      <Campo label="Dirección">
        <Input value={f.direccion} onChange={set('direccion')} />
      </Campo>
      <Campo label="Localidad">
        <Input value={f.localidad} onChange={set('localidad')} />
      </Campo>
      <Campo label="Notas" className="sm:col-span-2">
        <Textarea value={f.notas} onChange={set('notas')} rows={2} />
      </Campo>
      <AccionesForm className="sm:col-span-2">
        <Boton onClick={onCancelar}>Cancelar</Boton>
        <Boton type="submit" variante="primario" cargando={m.isPending}>Guardar</Boton>
      </AccionesForm>
    </form>
  );
}

// ───────────── Formulario de vehículo ─────────────
export function useMarcas() {
  return useQuery({ queryKey: ['marcas'], queryFn: () => api.get<Array<{ id: string; nombre: string; modelos: Array<{ id: string; nombre: string }> }>>('/marcas'), staleTime: 300_000 });
}

export function FormVehiculo({ clienteId, inicial, onGuardado, onCancelar }: { clienteId: string; inicial?: any; onGuardado: (v: any) => void; onCancelar: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: marcasTaller = [] } = useMarcas();
  const { data: catMarcas = [], isLoading: cargandoMarcas } = useCatMarcas();
  const [f, setF] = useState({
    patente: inicial?.patente ?? '',
    marca: inicial?.marca ?? '',
    modelo: inicial?.modelo ?? '',
    version: inicial?.version ?? '',
    anio: inicial?.anio ? String(inicial.anio) : '',
    color: inicial?.color ?? '',
    km_actual: inicial?.km_actual ? String(inicial.km_actual) : '',
    combustible: inicial?.combustible ?? '',
    motor: inicial?.motor ?? '',
    vin: inicial?.vin ?? '',
    notas: inicial?.notas ?? '',
  });
  // Si el usuario no toca marca, modelo ni versión, no se envían: el vehículo conserva tal cual lo que ya tenía.
  const [tocado, setTocado] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const cambiar = (parcial: Partial<typeof f>) => {
    setF((a) => ({ ...a, ...parcial }));
    setTocado(true);
  };

  // El vínculo con el catálogo se deduce del texto: el nombre canónico elegido (o escrito igual) lo identifica.
  const claveMarca = claveBusqueda(f.marca);
  const catMarca = claveMarca ? catMarcas.find((m) => m.clave === claveMarca) ?? null : null;
  const { data: catModelos = [], isLoading: cargandoModelos } = useCatModelos(catMarca?.id ?? null);
  const claveModelo = claveBusqueda(f.modelo);
  const catModelo = claveModelo ? catModelos.find((m) => m.clave === claveModelo) ?? null : null;
  const { data: detalle, isLoading: cargandoVersiones } = useCatModelo(catModelo?.id ?? null);
  const anioNum = Number(f.anio);

  const opcionesMarca = useMemo<Opcion[]>(() => {
    const delCatalogo = new Set(catMarcas.map((m) => m.clave));
    return [
      ...catMarcas.map((m) => ({ id: m.id, nombre: m.nombre, clave: m.clave, busqueda: m.busqueda })),
      ...marcasTaller.filter((m) => !delCatalogo.has(claveBusqueda(m.nombre))).map((m) => ({ id: `t:${m.id}`, nombre: m.nombre, clave: claveBusqueda(m.nombre), detalle: 'del taller' })),
    ];
  }, [catMarcas, marcasTaller]);
  const opcionesModelo = useMemo<Opcion[]>(() => {
    const delCatalogo = new Set(catModelos.map((m) => m.clave));
    const propios = marcasTaller.find((m) => claveBusqueda(m.nombre) === claveMarca)?.modelos ?? [];
    return [
      ...catModelos.map((m) => ({ id: m.id, nombre: m.nombre, clave: m.clave, detalle: rangoAnios(m.anios) })),
      ...propios.filter((m) => !delCatalogo.has(claveBusqueda(m.nombre))).map((m) => ({ id: `t:${m.id}`, nombre: m.nombre, clave: claveBusqueda(m.nombre), detalle: 'del taller' })),
    ];
  }, [catModelos, marcasTaller, claveMarca]);

  const versiones = detalle?.versiones ?? [];
  const delAnio = anioNum ? versiones.filter((v) => v.anios.includes(anioNum)) : versiones;
  const candidatas = delAnio.length ? delAnio : versiones; // si el año no figura para ese modelo, se muestran todas
  const opcionesMotor = useMemo<Opcion[]>(() => {
    const m = new Map<string, number>();
    for (const v of candidatas) if (v.motorizacion) m.set(v.motorizacion, (m.get(v.motorizacion) ?? 0) + v.n);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([nombre]) => ({ id: nombre, nombre, clave: claveBusqueda(nombre) }));
  }, [candidatas]);
  const claveMotor = claveBusqueda(f.motor);
  const motorElegido = opcionesMotor.some((o) => o.clave === claveMotor);
  const deMotor = motorElegido ? candidatas.filter((v) => claveBusqueda(v.motorizacion ?? '') === claveMotor) : candidatas;
  const textoVersion = (v: CatVersion) => v.version ?? v.descripcion;
  const opcionesVersion = useMemo<Opcion[]>(
    () => deMotor.map((v) => ({ id: v.id, nombre: textoVersion(v), clave: claveBusqueda(textoVersion(v)), detalle: [v.motorizacion, rangoAnios(v.anios)].filter(Boolean).join(' · ') || undefined })),
    [deMotor],
  );
  const catVersion = f.version ? versiones.find((v) => claveBusqueda(textoVersion(v)) === claveBusqueda(f.version)) ?? null : null;
  const aniosSugeridos = catModelo ? [...catModelo.anios].reverse().slice(0, 14) : [];

  const m = useMutation({
    mutationFn: async () => {
      const datos: Record<string, unknown> = {
        cliente_id: clienteId,
        patente: f.patente,
        anio: f.anio ? Number(f.anio) : null,
        color: f.color,
        km_actual: f.km_actual ? Number(f.km_actual) : 0,
        combustible: f.combustible,
        motor: f.motor,
        vin: f.vin,
        notas: f.notas,
      };
      if (tocado || !inicial?.id) {
        // El servidor reutiliza la marca/modelo que el taller ya tenga con ese nombre (nunca la renombra) y crea sólo la que se usa.
        Object.assign(datos, {
          marca_texto: f.marca.trim() || null,
          modelo_texto: f.marca.trim() ? f.modelo.trim() || null : null,
          cat_marca_id: catMarca?.id ?? null,
          cat_modelo_id: catModelo?.id ?? null,
          cat_version_id: catVersion?.id ?? null,
          version: f.version.trim() || null,
        });
      }
      return inicial?.id ? api.put(`/vehiculos/${inicial.id}`, datos) : api.post('/vehiculos', datos);
    },
    onSuccess: (v) => {
      qc.invalidateQueries({ queryKey: ['marcas'] });
      qc.invalidateQueries({ queryKey: ['vehiculos'] });
      qc.invalidateQueries({ queryKey: ['vehiculo'] });
      qc.invalidateQueries({ queryKey: ['cliente'] });
      toast.ok(inicial?.id ? 'Vehículo actualizado' : 'Vehículo registrado');
      onGuardado(v);
    },
    onError: toast.error,
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
      className="grid gap-3 sm:grid-cols-2"
    >
      <Campo label="Patente" requerido hint="Se guarda sin espacios ni guiones">
        <Input value={f.patente} onChange={set('patente')} required minLength={5} autoFocus className="uppercase tracking-wider" placeholder="AB123CD" />
      </Campo>
      <Campo label="Kilometraje actual">
        <Input value={f.km_actual} onChange={set('km_actual')} inputMode="numeric" placeholder="0" />
      </Campo>
      <Campo label="Marca" hint={catMarca ? undefined : 'Elegí de la lista o escribila si no está'}>
        <Combobox
          valor={f.marca}
          placeholder="Ej.: Volkswagen"
          cargando={cargandoMarcas}
          opciones={opcionesMarca}
          onTexto={(t) => cambiar({ marca: t, ...(claveBusqueda(t) === claveMarca ? {} : { modelo: '', version: '' }) })}
          onElegir={(o) => cambiar({ marca: o.nombre, ...(o.clave === claveMarca ? {} : { modelo: '', version: '' }) })}
        />
      </Campo>
      <Campo label="Modelo" hint={f.marca.trim() ? (catModelo ? undefined : 'Elegí de la lista o escribilo si no está') : 'Primero la marca'}>
        <Combobox
          valor={f.modelo}
          placeholder="Ej.: Amarok"
          disabled={!f.marca.trim()}
          cargando={!!catMarca && cargandoModelos}
          opciones={opcionesModelo}
          vacio={catMarca ? 'Escribí el modelo a mano.' : 'Marca fuera del catálogo: escribí el modelo a mano.'}
          onTexto={(t) => cambiar({ modelo: t, ...(claveBusqueda(t) === claveModelo ? {} : { version: '' }) })}
          onElegir={(o) => cambiar({ modelo: o.nombre, ...(o.clave === claveModelo ? {} : { version: '' }) })}
        />
      </Campo>
      <Campo label="Año" hint={aniosSugeridos.length ? 'Años con registros de este modelo' : undefined}>
        <Input value={f.anio} onChange={set('anio')} inputMode="numeric" maxLength={4} placeholder="2020" />
        {aniosSugeridos.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {aniosSugeridos.map((a) => (
              <button key={a} type="button" onClick={() => setF({ ...f, anio: String(a) })} className={cn('h-8 rounded-ctl border px-2 text-xs', String(a) === f.anio ? 'border-marca-400 bg-marca-50 text-marca-700' : 'border-borde bg-white text-slate-600 hover:bg-slate-50')}>
                {a}
              </button>
            ))}
          </div>
        )}
      </Campo>
      <Campo label="Motorización" hint={opcionesMotor.length ? 'Según las descripciones del registro automotor' : 'Escribila a mano, por ejemplo 1.6 16v'}>
        <Combobox valor={f.motor} placeholder="1.6" opciones={opcionesMotor} onTexto={(t) => cambiar({ motor: t })} onElegir={(o) => cambiar({ motor: o.nombre })} vacio="Escribila a mano." />
      </Campo>
      <Campo label="Versión" className="sm:col-span-2" hint={catModelo ? undefined : 'Opcional'}>
        <Combobox
          valor={f.version}
          placeholder="Ej.: Highline V6 4x4"
          disabled={!f.modelo.trim()}
          cargando={!!catModelo && cargandoVersiones}
          opciones={opcionesVersion}
          vacio="Escribila a mano."
          onTexto={(t) => cambiar({ version: t })}
          onElegir={(o) => {
            const v = versiones.find((x) => x.id === o.id);
            cambiar({ version: o.nombre, ...(v?.motorizacion && !f.motor.trim() ? { motor: v.motorizacion } : {}), ...(v?.combustible && !f.combustible ? { combustible: v.combustible } : {}) });
          }}
        />
      </Campo>
      <Campo label="Color">
        <Input value={f.color} onChange={set('color')} />
      </Campo>
      <Campo label="Combustible">
        <Select value={f.combustible} onChange={set('combustible')}>
          <option value="">—</option>
          {['Nafta', 'Diésel', 'GNC', 'Nafta/GNC', 'Híbrido', 'Eléctrico'].map((c) => <option key={c}>{c}</option>)}
        </Select>
      </Campo>
      <Campo label="N° de chasis (VIN)" className="sm:col-span-2">
        <Input value={f.vin} onChange={set('vin')} className="uppercase" />
      </Campo>
      <Campo label="Notas" className="sm:col-span-2">
        <Textarea value={f.notas} onChange={set('notas')} rows={2} />
      </Campo>
      <p className="text-xs text-tenue sm:col-span-2">Catálogo: DNRPA, inscripciones iniciales de autos (CC BY 4.0). Cualquier dato que falte se puede escribir a mano.</p>
      <AccionesForm className="sm:col-span-2">
        <Boton onClick={onCancelar}>Cancelar</Boton>
        <Boton type="submit" variante="primario" cargando={m.isPending}>Guardar</Boton>
      </AccionesForm>
    </form>
  );
}

// ───────────── Selector de cliente ─────────────
export function SelectorCliente({ valor, onCambio }: { valor: ClienteMin | null; onCambio: (c: ClienteMin | null) => void }) {
  const [q, setQ] = useState('');
  const [alta, setAlta] = useState(false);
  const dq = useDebounce(q);
  const { data = [], isFetching } = useQuery({ queryKey: ['clientes', { q: dq, sel: true }], queryFn: () => api.get<ClienteMin[]>(`/clientes?limite=8&q=${encodeURIComponent(dq)}`), enabled: !valor && dq.length >= 1 });
  if (valor) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-ctl border border-marca-200 bg-marca-50/60 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <UserRound className="size-4 shrink-0 text-marca-600" />
          <div className="min-w-0">
            <div className="break-words text-sm font-medium">{valor.nombre}</div>
            <div className="truncate text-xs text-tenue">#{valor.codigo} {valor.telefono ? `· ${valor.telefono}` : ''}</div>
          </div>
        </div>
        <Boton tam="sm" variante="fantasma" onClick={() => onCambio(null)} icono={<X className="size-4" />}>Cambiar</Boton>
      </div>
    );
  }
  return (
    <div>
      <div className="flex gap-2">
        <Buscador value={q} onChange={setQ} placeholder="Buscar cliente por nombre, teléfono o patente…" className="flex-1" />
        <Boton icono={<Plus className="size-4" />} onClick={() => setAlta(true)}>Nuevo</Boton>
      </div>
      {dq && (
        <ul className="mt-1.5 max-h-56 overflow-y-auto rounded-ctl border border-borde bg-white text-sm shadow-pop">
          {data.map((c) => (
            <li key={c.id}>
              <button type="button" className="flex w-full justify-between gap-2 px-3 py-2 text-left hover:bg-marca-50" onClick={() => onCambio(c)}>
                <span className="break-words font-medium">{c.nombre}</span>
                <span className="shrink-0 text-xs text-tenue">{c.telefono ?? `#${c.codigo}`}</span>
              </button>
            </li>
          ))}
          {!isFetching && !data.length && <li className="px-3 py-2 text-tenue">Sin resultados. Podés crearlo con “Nuevo”.</li>}
        </ul>
      )}
      <Modal abierto={alta} onCerrar={() => setAlta(false)} titulo="Nuevo cliente" ancho="lg">
        <FormCliente
          inicial={{ nombre: q }}
          onCancelar={() => setAlta(false)}
          onGuardado={(c) => {
            setAlta(false);
            onCambio(c);
          }}
        />
      </Modal>
    </div>
  );
}

// ───────────── Selector de vehículo del cliente ─────────────
export function SelectorVehiculo({ clienteId, valor, onCambio }: { clienteId: string | null; valor: string | null; onCambio: (id: string | null, v?: any) => void }) {
  const [alta, setAlta] = useState(false);
  const { data = [] } = useQuery({ queryKey: ['vehiculos', { cliente_id: clienteId }], queryFn: () => api.get<any[]>(`/vehiculos?cliente_id=${clienteId}`), enabled: !!clienteId });
  if (!clienteId) return <p className="rounded-ctl border border-dashed border-borde px-3 py-2.5 text-sm text-tenue">Elegí primero el cliente</p>;
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {data.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => onCambio(v.id, v)}
            className={cn('flex items-center gap-2 rounded-ctl border px-3 py-2 text-left text-sm', valor === v.id ? 'border-marca-400 bg-marca-50 ring-2 ring-marca-100' : 'border-borde bg-white hover:bg-slate-50')}
          >
            <Car className="size-4 text-tenue" />
            <span>
              <span className="block font-semibold tracking-wide">{v.patente}</span>
              <span className="block text-xs text-tenue">{[v.marca, v.modelo, v.anio].filter(Boolean).join(' ') || 'Sin datos'} · {Number(v.km_actual).toLocaleString('es-AR')} km</span>
            </span>
          </button>
        ))}
        <Boton icono={<Plus className="size-4" />} onClick={() => setAlta(true)} className="h-auto min-h-12">Nuevo vehículo</Boton>
      </div>
      <Modal abierto={alta} onCerrar={() => setAlta(false)} titulo="Nuevo vehículo" ancho="lg">
        <FormVehiculo
          clienteId={clienteId}
          onCancelar={() => setAlta(false)}
          onGuardado={(v) => {
            setAlta(false);
            onCambio(v.id, v);
          }}
        />
      </Modal>
    </div>
  );
}

export function useMecanicos(habilitado = true) {
  return useQuery({ queryKey: ['mecanicos'], queryFn: () => api.get<any[]>('/mecanicos'), staleTime: 60_000, enabled: habilitado });
}
