// Piezas compartidas de los mantenimientos programados: estado, acciones (turno / presupuesto aviso) y formulario del plan de un vehículo.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { CalendarPlus, FileText, MessageCircle } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fecha, km, whatsapp } from '@/lib/format';
import { Boton, Campo, Check, Input, Insignia, Modal, Select, Textarea, useToast } from './ui';

export interface MantenimientoApi {
  vehiculo_id: string;
  patente: string;
  cliente_id?: string;
  cliente?: string;
  cliente_telefono?: string | null;
  km_actual: number;
  servicio_id: string;
  servicio: string;
  intervalo_km: number | null;
  intervalo_meses: number | null;
  programado: boolean;
  km_realizado: number | null;
  fecha_realizado: string | null;
  origen_realizado: 'orden' | 'antecedente' | null;
  orden_numero: number | null;
  proximo_km: number | null;
  proxima_fecha: string | null;
  km_restantes: number | null;
  dias_restantes: number | null;
  estado: 'vencido' | 'proximo' | 'al_dia' | 'sin_registro';
  notas: string | null;
}

export function EstadoMantenimiento({ m }: { m: Pick<MantenimientoApi, 'estado'> }) {
  const mapa = { vencido: ['rojo', 'Vencido'], proximo: ['ambar', 'Próximo'], al_dia: ['verde', 'Al día'], sin_registro: ['gris', 'Sin registro'] } as const;
  const [tono, texto] = mapa[m.estado];
  return <Insignia tono={tono}>{texto}</Insignia>;
}

/** "A los 60.000 km (faltan 1.200) o el 12/03/2027". */
export function proximoTexto(m: MantenimientoApi): string {
  const partes: string[] = [];
  if (m.proximo_km != null) partes.push(`a los ${km(m.proximo_km)}${m.km_restantes != null ? (m.km_restantes > 0 ? ` (faltan ${m.km_restantes.toLocaleString('es-AR')})` : ` (pasado en ${Math.abs(m.km_restantes).toLocaleString('es-AR')})`) : ''}`);
  if (m.proxima_fecha) partes.push(`el ${fecha(m.proxima_fecha)}${m.dias_restantes != null ? (m.dias_restantes > 0 ? ` (en ${m.dias_restantes} días)` : m.dias_restantes === 0 ? ' (hoy)' : ` (hace ${Math.abs(m.dias_restantes)} días)`) : ''}`);
  return partes.join(' o ') || (m.estado === 'sin_registro' ? 'Sin realización registrada: cargá la última vez que se hizo' : '—');
}

/** Acciones sobre un mantenimiento pendiente: generar un turno o un presupuesto, y avisar al cliente por WhatsApp (enlace manual, sin costo). */
export function AccionesMantenimiento({ m, clienteId, tallerNombre }: { m: MantenimientoApi; clienteId?: string; tallerNombre?: string }) {
  const nav = useNavigate();
  const { puede } = useAuth();
  const motivo = `${m.servicio} (mantenimiento programado)`;
  const wa = m.cliente_telefono ? whatsapp(m.cliente_telefono, `Hola ${m.cliente ?? ''}! Te recordamos desde ${tallerNombre ?? 'el taller'} que tu vehículo ${m.patente} tiene pendiente: ${m.servicio}. ¿Querés que te reservemos un turno?`) : null;
  return (
    <div className="flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
      {puede('turnos.gestionar') && <Boton tam="sm" icono={<CalendarPlus className="size-4" />} onClick={() => nav(`/agenda${qs({ nuevo: 1, vehiculo: m.vehiculo_id, motivo })}`)}>Turno</Boton>}
      {puede('presupuestos.gestionar') && puede('precios.venta.ver') && (
        <Boton tam="sm" icono={<FileText className="size-4" />} onClick={() => nav(`/presupuestos/nuevo${qs({ cliente: clienteId, vehiculo: m.vehiculo_id, servicio: m.servicio_id, motivo })}`)}>Presupuesto</Boton>
      )}
      {wa && <a href={wa} target="_blank" rel="noreferrer"><Boton tam="sm" icono={<MessageCircle className="size-4" />}>Avisar</Boton></a>}
    </div>
  );
}

/** Alta o edición del plan de mantenimiento de un vehículo para una operación del taller. */
export function FormPlanMantenimiento({ vehiculoId, inicial, onCerrar }: { vehiculoId: string; inicial?: MantenimientoApi | null; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: servicios = [] } = useQuery({ queryKey: ['servicios', 'todos'], queryFn: () => api.get<any[]>('/servicios?todos=1'), staleTime: 60_000 });
  const [f, setF] = useState({
    servicio_id: inicial?.servicio_id ?? '',
    intervalo_km: inicial?.intervalo_km ? String(inicial.intervalo_km) : '',
    intervalo_meses: inicial?.intervalo_meses ? String(inicial.intervalo_meses) : '',
    notas: inicial?.notas ?? '',
    activo: true,
    ultima_fecha: '',
    ultima_km: '',
  });
  const srv = servicios.find((s) => s.id === f.servicio_id);
  const guardar = useMutation({
    mutationFn: () =>
      api.put(`/vehiculos/${vehiculoId}/mantenimientos/${f.servicio_id}`, {
        intervalo_km: f.intervalo_km ? Number(f.intervalo_km) : null,
        intervalo_meses: f.intervalo_meses ? Number(f.intervalo_meses) : null,
        activo: f.activo,
        notas: f.notas,
        ultima: f.ultima_fecha ? { fecha: f.ultima_fecha, km: f.ultima_km ? Number(f.ultima_km) : null } : null,
      }),
    onSuccess: () => {
      ['mantenimientos', 'vehiculo', 'historial-tecnico', 'recordatorios'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.ok('Plan de mantenimiento guardado');
      onCerrar();
    },
    onError: toast.error,
  });
  const quitar = useMutation({
    mutationFn: () => api.del(`/vehiculos/${vehiculoId}/mantenimientos/${f.servicio_id}`),
    onSuccess: () => { ['mantenimientos', 'vehiculo'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast.ok('Plan eliminado'); onCerrar(); },
    onError: toast.error,
  });
  return (
    <Modal abierto onCerrar={onCerrar} titulo={inicial ? 'Plan de mantenimiento' : 'Programar mantenimiento'} ancho="md"
      pie={<>
        {inicial?.programado && <Boton variante="fantasma" className="mr-auto" cargando={quitar.isPending} onClick={() => quitar.mutate()}>Quitar plan</Boton>}
        <Boton onClick={onCerrar}>Cancelar</Boton>
        <Boton variante="primario" disabled={!f.servicio_id} cargando={guardar.isPending} onClick={() => guardar.mutate()}>Guardar</Boton>
      </>}>
      <div className="space-y-3">
        <Campo label="Operación" requerido>
          <Select value={f.servicio_id} disabled={!!inicial} onChange={(e) => { const s = servicios.find((x) => x.id === e.target.value); setF({ ...f, servicio_id: e.target.value, intervalo_km: s?.intervalo_km ? String(s.intervalo_km) : '', intervalo_meses: s?.intervalo_meses ? String(s.intervalo_meses) : '' }); }}>
            <option value="">Elegí una operación…</option>
            {servicios.filter((s) => s.activo).map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
          </Select>
        </Campo>
        <div className="grid grid-cols-2 gap-3">
          <Campo label="Cada (km)" hint={srv?.intervalo_km ? `Intervalo de la operación: ${srv.intervalo_km.toLocaleString('es-AR')} km` : undefined}>
            <Input value={f.intervalo_km} onChange={(e) => setF({ ...f, intervalo_km: e.target.value.replace(/\D/g, '') })} inputMode="numeric" />
          </Campo>
          <Campo label="Cada (meses)" hint={srv?.intervalo_meses ? `Intervalo de la operación: ${srv.intervalo_meses} meses` : undefined}>
            <Input value={f.intervalo_meses} onChange={(e) => setF({ ...f, intervalo_meses: e.target.value.replace(/\D/g, '') })} inputMode="numeric" />
          </Campo>
        </div>
        {!inicial?.fecha_realizado && (
          <div className="rounded-card border border-borde p-3">
            <p className="mb-2 text-[13px] font-medium">¿Cuándo se hizo por última vez? <span className="font-normal text-tenue">(si fue antes de usar Fierro)</span></p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Campo label="Fecha"><Input type="date" value={f.ultima_fecha} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setF({ ...f, ultima_fecha: e.target.value })} /></Campo>
              <Campo label="Kilometraje"><Input value={f.ultima_km} onChange={(e) => setF({ ...f, ultima_km: e.target.value.replace(/\D/g, '') })} inputMode="numeric" /></Campo>
            </div>
            <p className="mt-1.5 text-xs text-tenue">Queda registrado como antecedente del vehículo. Las próximas veces se toman de las órdenes de trabajo.</p>
          </div>
        )}
        <Campo label="Notas"><Textarea rows={2} value={f.notas} onChange={(e) => setF({ ...f, notas: e.target.value })} /></Campo>
        {inicial && <Check checked={f.activo} onChange={(v) => setF({ ...f, activo: v })} label="Plan activo (si lo pausás deja de avisar)" />}
      </div>
    </Modal>
  );
}
