// Selectores de entidades con alta rápida (cliente, vehículo) y formularios compartidos.
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Car, Plus, UserRound, X } from 'lucide-react';
import { api } from '@/lib/api';
import { Boton, Buscador, Campo, cn, Input, Modal, Select, Textarea, useDebounce, useToast } from './ui';
import { CONDICIONES_IVA, CONDICION_IVA_LABEL } from '@shared/dominio';

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
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Boton onClick={onCancelar}>Cancelar</Boton>
        <Boton type="submit" variante="primario" cargando={m.isPending}>Guardar</Boton>
      </div>
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
  const { data: marcas = [] } = useMarcas();
  const [f, setF] = useState({
    patente: inicial?.patente ?? '',
    marca_id: inicial?.marca_id ?? '',
    modelo_id: inicial?.modelo_id ?? '',
    anio: inicial?.anio ? String(inicial.anio) : '',
    color: inicial?.color ?? '',
    km_actual: inicial?.km_actual ? String(inicial.km_actual) : '',
    combustible: inicial?.combustible ?? '',
    motor: inicial?.motor ?? '',
    vin: inicial?.vin ?? '',
    notas: inicial?.notas ?? '',
  });
  const [nuevoModelo, setNuevoModelo] = useState('');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value, ...(k === 'marca_id' ? { modelo_id: '' } : {}) });
  const modelos = marcas.find((m) => m.id === f.marca_id)?.modelos ?? [];
  const m = useMutation({
    mutationFn: async () => {
      let modeloId = f.modelo_id || null;
      if (f.marca_id && nuevoModelo.trim()) {
        const r = await api.post('/modelos', { marca_id: f.marca_id, nombre: nuevoModelo.trim() });
        modeloId = r.id;
        qc.invalidateQueries({ queryKey: ['marcas'] });
      }
      const datos = {
        cliente_id: clienteId,
        patente: f.patente,
        marca_id: f.marca_id || null,
        modelo_id: modeloId,
        anio: f.anio ? Number(f.anio) : null,
        color: f.color,
        km_actual: f.km_actual ? Number(f.km_actual) : 0,
        combustible: f.combustible,
        motor: f.motor,
        vin: f.vin,
        notas: f.notas,
      };
      return inicial?.id ? api.put(`/vehiculos/${inicial.id}`, datos) : api.post('/vehiculos', datos);
    },
    onSuccess: (v) => {
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
      <Campo label="Marca">
        <Select value={f.marca_id} onChange={set('marca_id')}>
          <option value="">— Elegir —</option>
          {marcas.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
        </Select>
      </Campo>
      <Campo label="Modelo" hint={f.marca_id ? 'Si no está en la lista, escribilo abajo' : undefined}>
        <Select value={f.modelo_id} onChange={set('modelo_id')} disabled={!f.marca_id}>
          <option value="">— Elegir —</option>
          {modelos.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
        </Select>
        {f.marca_id && !f.modelo_id && <Input value={nuevoModelo} onChange={(e) => setNuevoModelo(e.target.value)} placeholder="Nuevo modelo (opcional)" className="mt-1.5" />}
      </Campo>
      <Campo label="Año">
        <Input value={f.anio} onChange={set('anio')} inputMode="numeric" maxLength={4} />
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
      <Campo label="Motor">
        <Input value={f.motor} onChange={set('motor')} placeholder="1.6 16v" />
      </Campo>
      <Campo label="N° de chasis (VIN)" className="sm:col-span-2">
        <Input value={f.vin} onChange={set('vin')} className="uppercase" />
      </Campo>
      <Campo label="Notas" className="sm:col-span-2">
        <Textarea value={f.notas} onChange={set('notas')} rows={2} />
      </Campo>
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Boton onClick={onCancelar}>Cancelar</Boton>
        <Boton type="submit" variante="primario" cargando={m.isPending}>Guardar</Boton>
      </div>
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
      <div className="flex items-center justify-between gap-2 rounded-lg border border-marca-200 bg-marca-50/60 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <UserRound className="size-4 shrink-0 text-marca-600" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{valor.nombre}</div>
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
        <ul className="mt-1.5 max-h-56 overflow-y-auto rounded-lg border border-borde bg-white text-sm shadow-sm">
          {data.map((c) => (
            <li key={c.id}>
              <button type="button" className="flex w-full justify-between gap-2 px-3 py-2 text-left hover:bg-marca-50" onClick={() => onCambio(c)}>
                <span className="truncate font-medium">{c.nombre}</span>
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
  if (!clienteId) return <p className="rounded-lg border border-dashed border-borde px-3 py-2.5 text-sm text-tenue">Elegí primero el cliente</p>;
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {data.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => onCambio(v.id, v)}
            className={cn('flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm', valor === v.id ? 'border-marca-400 bg-marca-50 ring-2 ring-marca-100' : 'border-borde bg-white hover:bg-slate-50')}
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
