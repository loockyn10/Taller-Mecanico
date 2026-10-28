// Alta de un movimiento con una persona: persona → categoría → importe y motivo → caja o banco → confirmar.
// La categoría fija el tipo financiero, y con él si el dinero entra o sale de la empresa y cómo se asienta: el formulario sólo lo muestra, no lo deja elegir.
import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, CircleSlash, Plus } from 'lucide-react';
import { api, nuevaClave } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { invalidarDinero } from '@/lib/caja';
import { fecha as fmtFecha, hoyISO, money } from '@/lib/format';
import { Aviso, Boton, Campo, Cargando, Input, InputMoneda, Modal, Select, useToast } from '@/components/ui';
import { DEF_TIPOS_FIN, DIRECCION_LABEL, GRUPOS_CATEGORIA, TIPO_PERSONA_LABEL, errorImporte, type TipoFin } from '@shared/movpersonas';

export interface Categoria { id: string; clave: string | null; nombre: string; tipo_fin: TipoFin | null; direccion: string | null; grupo: string; activa: number; sistema: number; pendiente: string | null; movimientos: number }
export interface Persona { id: string; tipo: keyof typeof TIPO_PERSONA_LABEL; nombre: string; usuario_id: string | null; activa: number; acceso_erp: boolean | null; movimientos: number; nueva: boolean; notas?: string | null; documento?: string | null }
export interface CuentasInfo { cuentas: Array<{ id: string; nombre: string; banco: string; activa: number }>; caja: { obligatoria: boolean; abierta: boolean } }

export const useCategorias = () => useQuery({ queryKey: ['movpersonas', 'categorias'], queryFn: () => api.get<Categoria[]>('/movimientos-personas/categorias') });
export const usePersonas = (inactivas = false) => useQuery({ queryKey: ['movpersonas', 'personas', inactivas], queryFn: () => api.get<Persona[]>(`/movimientos-personas/personas${inactivas ? '?inactivas=1' : ''}`) });
export const useCuentas = () => useQuery({ queryKey: ['movpersonas', 'cuentas'], queryFn: () => api.get<CuentasInfo>('/movimientos-personas/cuentas?todas=1'), staleTime: 15_000 });

export const DIRECCION_ESTILO: Record<string, { clase: string; icono: JSX.Element; titulo: string }> = {
  entrada: { clase: 'border-emerald-200 bg-emerald-50 text-emerald-900', icono: <ArrowDownLeft className="size-5" />, titulo: DIRECCION_LABEL.entrada },
  salida: { clase: 'border-red-200 bg-red-50 text-red-900', icono: <ArrowUpRight className="size-5" />, titulo: DIRECCION_LABEL.salida },
  sin_dinero: { clase: 'border-slate-200 bg-slate-50 text-slate-800', icono: <CircleSlash className="size-5" />, titulo: DIRECCION_LABEL.sin_dinero },
};

/** Alta rápida de un socio, propietario u otra persona (sin acceso al sistema). */
function AltaPersona({ onCreada, onCancelar }: { onCreada: (p: Persona) => void; onCancelar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ tipo: 'socio', nombre: '', documento: '' });
  const m = useMutation({
    mutationFn: () => api.post<Persona>('/movimientos-personas/personas', { tipo: f.tipo, nombre: f.nombre, documento: f.documento || null }),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ['movpersonas', 'personas'] });
      toast.ok('Persona agregada');
      onCreada(p);
    },
    onError: toast.error,
  });
  return (
    <div className="space-y-3 rounded-card border border-borde bg-superficie-2 p-3">
      <p className="text-sm font-medium">Nueva persona (no necesita acceso al sistema)</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Campo label="Relación"><Select value={f.tipo} onChange={(e) => setF({ ...f, tipo: e.target.value })}><option value="socio">Socio</option><option value="propietario">Propietario</option><option value="otra">Otra persona</option></Select></Campo>
        <Campo label="Nombre y apellido" requerido className="sm:col-span-2"><Input value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} autoFocus /></Campo>
        <Campo label="Documento (opcional)"><Input value={f.documento} onChange={(e) => setF({ ...f, documento: e.target.value })} /></Campo>
      </div>
      <div className="flex justify-end gap-2">
        <Boton tam="sm" onClick={onCancelar}>Cancelar</Boton>
        <Boton tam="sm" variante="primario" disabled={f.nombre.trim().length < 2} cargando={m.isPending} onClick={() => m.mutate()}>Agregar persona</Boton>
      </div>
    </div>
  );
}

export interface Preset { persona_id?: string; clave?: string; regulariza_id?: string }

export function NuevoMovimiento({ preset, onCerrar }: { preset?: Preset; onCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useAuth();
  const { data: categorias = [], isLoading: cargandoCat } = useCategorias();
  const { data: personas = [], isLoading: cargandoPer } = usePersonas();
  const { data: cuentasInfo } = useCuentas();
  // Una sola clave por apertura del formulario: un doble clic o un reintento devuelven el mismo movimiento.
  const clave = useRef(nuevaClave());
  const [altaPersona, setAltaPersona] = useState(false);
  const [f, setF] = useState({
    persona_id: preset?.persona_id ?? '', categoria_id: '', importe: 0, fecha: hoyISO(), cuenta: 'caja', motivo: '', referencia: '', regulariza_id: preset?.regulariza_id ?? '', liquidacion_ref: '', autorizado_por: '',
  });

  const disponibles = useMemo(() => categorias.filter((c) => c.activa && !c.pendiente && c.tipo_fin && (c.tipo_fin !== 'aplicacion_adelanto' || puede('movpersonas.regularizar'))), [categorias, puede]);
  // La categoría que pide el atajo («Registrar devolución»…) se elige una vez, cuando llegan las categorías.
  const [inicial, setInicial] = useState(false);
  if (!inicial && categorias.length) {
    setInicial(true);
    const c = preset?.clave ? categorias.find((x) => x.clave === preset.clave) : undefined;
    if (c) setF((x) => ({ ...x, categoria_id: c.id }));
  }
  const cat = categorias.find((c) => c.id === f.categoria_id);
  const tipo = cat?.tipo_fin ?? null;
  const def = tipo ? DEF_TIPOS_FIN[tipo] : null;
  const persona = personas.find((p) => p.id === f.persona_id);
  const regulariza = def?.regulariza ?? null;

  const { data: obligaciones = [], isLoading: cargandoObl } = useQuery({
    queryKey: ['movpersonas', 'obligaciones', f.persona_id, regulariza],
    queryFn: () => api.get<Array<{ id: string; numero: number; fecha: string; importe: number; saldo: number; motivo: string }>>(`/movimientos-personas/obligaciones?persona_id=${encodeURIComponent(f.persona_id)}&obligacion=${regulariza}`),
    enabled: !!regulariza && !!f.persona_id,
  });
  // Con una sola obligación abierta no hay nada que elegir.
  const oblig = obligaciones.find((o) => o.id === f.regulariza_id) ?? (obligaciones.length === 1 ? obligaciones[0] : undefined);
  const obligId = oblig?.id ?? '';

  const personasPosibles = personas.filter((p) => !def?.soloPersonal || p.tipo === 'empleado');
  const porGrupo = (g: string) => disponibles.filter((c) => c.grupo === g);
  const cuentas = (cuentasInfo?.cuentas ?? []).filter((c) => c.activa);
  const mueveDinero = def ? def.direccion !== 'sin_dinero' : true;
  const cajaCerrada = f.cuenta === 'caja' && mueveDinero && !!cuentasInfo?.caja.obligatoria && !cuentasInfo.caja.abierta;
  const saldoDespues = oblig ? oblig.saldo - f.importe : null;

  const error = (() => {
    if (!f.persona_id) return 'Elegí la persona';
    if (!cat || !tipo) return 'Elegí la categoría';
    if (f.importe > 0 && errorImporte(f.importe)) return errorImporte(f.importe);
    if (f.importe <= 0) return 'Escribí el importe';
    if (regulariza && cargandoObl) return 'Buscando lo que está pendiente…';
    if (regulariza && !obligId) return obligaciones.length ? (tipo === 'aplicacion_adelanto' ? 'Elegí el adelanto' : 'Elegí el préstamo') : 'La persona no tiene nada pendiente para regularizar';
    if (oblig && f.importe > oblig.saldo) return `El importe supera el saldo pendiente (${money(oblig.saldo)})`;
    if (f.motivo.trim().length < 3) return 'Escribí el motivo';
    if (tipo === 'aplicacion_adelanto' && (f.liquidacion_ref.trim().length < 2 || f.autorizado_por.trim().length < 2)) return 'Indicá la liquidación y quién autorizó la aplicación';
    if (cajaCerrada) return 'La caja está cerrada: abrila para registrar efectivo o elegí una cuenta bancaria';
    return null;
  })();

  const m = useMutation({
    mutationFn: () =>
      api.post<{ id: string; numero: number; saldo_restante: number | null; duplicado?: boolean }>('/movimientos-personas/movimientos', {
        persona_id: persona?.nueva ? null : f.persona_id, usuario_id: persona?.nueva ? persona.usuario_id : null, categoria_id: f.categoria_id, importe: f.importe, moneda: 'ARS', fecha: f.fecha,
        via: mueveDinero ? (f.cuenta === 'caja' ? 'caja' : 'banco') : null, cuenta_id: mueveDinero && f.cuenta !== 'caja' ? f.cuenta : null,
        motivo: f.motivo, referencia: f.referencia || null, regulariza_id: regulariza ? obligId : null,
        liquidacion_ref: tipo === 'aplicacion_adelanto' ? f.liquidacion_ref : null, autorizado_por: tipo === 'aplicacion_adelanto' ? f.autorizado_por : null, idem_key: clave.current,
      }),
    onSuccess: (r) => {
      invalidarDinero(qc);
      qc.invalidateQueries({ queryKey: ['movpersonas'] });
      toast.ok(r.duplicado ? `El movimiento #${r.numero} ya estaba registrado` : r.saldo_restante != null ? `Movimiento #${r.numero} registrado. Saldo pendiente: ${money(r.saldo_restante)}` : `Movimiento #${r.numero} registrado`);
      onCerrar();
    },
    onError: toast.error,
  });

  const estilo = def ? DIRECCION_ESTILO[def.direccion] : null;
  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo="Nuevo movimiento"
      ancho="lg"
      pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" disabled={!!error} cargando={m.isPending} onClick={() => m.mutate()}>Confirmar</Boton></>}
    >
      {cargandoCat || cargandoPer ? <Cargando /> : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Campo label="Persona" requerido hint={persona ? `${TIPO_PERSONA_LABEL[persona.tipo]}${persona.acceso_erp === false ? ' · sin acceso al sistema' : ''}` : 'Quien entrega o recibe el dinero'}>
              <Select value={f.persona_id} onChange={(e) => (e.target.value === '+' ? setAltaPersona(true) : setF({ ...f, persona_id: e.target.value, regulariza_id: '' }))}>
                <option value="">— Elegir —</option>
                {personasPosibles.some((p) => p.tipo === 'empleado') && (
                  <optgroup label="Personal">{personasPosibles.filter((p) => p.tipo === 'empleado').map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</optgroup>
                )}
                {personasPosibles.some((p) => p.tipo !== 'empleado') && (
                  <optgroup label="Socios y otras personas">{personasPosibles.filter((p) => p.tipo !== 'empleado').map((p) => <option key={p.id} value={p.id}>{p.nombre} · {TIPO_PERSONA_LABEL[p.tipo]}</option>)}</optgroup>
                )}
                {!def?.soloPersonal && <option value="+">＋ Agregar socio u otra persona…</option>}
              </Select>
            </Campo>
            <Campo label="Categoría" requerido>
              <Select value={f.categoria_id} onChange={(e) => setF({ ...f, categoria_id: e.target.value, regulariza_id: '', cuenta: f.cuenta })}>
                <option value="">— Elegir —</option>
                {GRUPOS_CATEGORIA.filter((g) => porGrupo(g).length).map((g) => <optgroup key={g} label={g}>{porGrupo(g).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</optgroup>)}
                {porGrupo('Categorías propias').length > 0 && <optgroup label="Categorías propias">{porGrupo('Categorías propias').map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</optgroup>}
              </Select>
            </Campo>
          </div>
          {altaPersona && <AltaPersona onCancelar={() => setAltaPersona(false)} onCreada={(p) => { setAltaPersona(false); setF((x) => ({ ...x, persona_id: p.id })); }} />}
          {def && persona && def.soloPersonal && persona.tipo !== 'empleado' && <Aviso tono="rojo">{def.etiqueta} sólo corresponde a personal de la empresa.</Aviso>}

          {estilo && def && (
            <div className={`flex items-start gap-3 rounded-card border p-3 ${estilo.clase}`}>
              <span className="mt-0.5 shrink-0">{estilo.icono}</span>
              <div className="min-w-0">
                <p className="font-semibold">{estilo.titulo}</p>
                <p className="text-sm opacity-90">{def.asiento}</p>
              </div>
            </div>
          )}

          {regulariza && f.persona_id && (
            <div className="space-y-2">
              {cargandoObl ? (
                <p className="text-sm text-tenue">Buscando lo que está pendiente…</p>
              ) : obligaciones.length === 0 ? (
                <Aviso tono="ambar">{persona?.nombre ?? 'La persona'} no tiene {tipo === 'aplicacion_adelanto' ? 'adelantos pendientes de aplicar' : 'préstamos de este tipo pendientes'}.</Aviso>
              ) : (
                <Campo label={tipo === 'aplicacion_adelanto' ? 'Adelanto que se aplica' : 'Préstamo que se devuelve'} requerido>
                  <Select value={obligId} onChange={(e) => setF({ ...f, regulariza_id: e.target.value })}>
                    {obligaciones.length > 1 && <option value="">— Elegir —</option>}
                    {obligaciones.map((o) => <option key={o.id} value={o.id}>#{o.numero} · {fmtFecha(o.fecha)} · {money(o.importe)} · pendiente {money(o.saldo)}</option>)}
                  </Select>
                </Campo>
              )}
              {oblig && (
                <p className="text-sm">
                  Saldo pendiente: <b className="tabular-nums">{money(oblig.saldo)}</b>
                  {f.importe > 0 && saldoDespues != null && saldoDespues >= 0 && <> · después de este movimiento quedan <b className="tabular-nums">{money(saldoDespues)}</b>{saldoDespues === 0 && ' (queda regularizado)'}</>}
                  {f.importe > 0 && saldoDespues != null && saldoDespues < 0 && <span className="text-red-700"> · el importe supera el saldo</span>}
                </p>
              )}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <Campo label="Importe" requerido><InputMoneda value={f.importe} onChange={(v) => setF({ ...f, importe: v })} /></Campo>
            <Campo label="Moneda" hint="Por ahora, pesos"><Select value="ARS" disabled><option value="ARS">ARS · Pesos</option></Select></Campo>
            <Campo label="Fecha"><Input type="date" value={f.fecha} max={hoyISO()} disabled={!puede('fechas.retroactivas')} onChange={(e) => setF({ ...f, fecha: e.target.value })} /></Campo>
          </div>

          {mueveDinero ? (
            <Campo label={!def ? 'Cuenta (caja o banco)' : def.direccion === 'salida' ? 'Cuenta de origen (de dónde sale el dinero)' : 'Cuenta de destino (a dónde entra el dinero)'} requerido>
              <Select value={f.cuenta} onChange={(e) => setF({ ...f, cuenta: e.target.value })}>
                <option value="caja">Caja en efectivo</option>
                {cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre} · {c.banco}</option>)}
              </Select>
            </Campo>
          ) : (
            <Aviso>Esta operación no mueve dinero: el adelanto se cancela contra una liquidación y no hay una segunda salida de caja.</Aviso>
          )}
          {cajaCerrada && <Aviso tono="rojo">La caja está cerrada. Abrila desde Caja diaria o elegí una cuenta bancaria.</Aviso>}

          {tipo === 'aplicacion_adelanto' && (
            <div className="space-y-3 rounded-card border border-aviso-200 bg-aviso-50 p-3">
              <p className="text-sm text-aviso-800">La aplicación queda a nombre de quien la registra, con la liquidación y la autorización que indiques. El sistema no descuenta sueldos ni sustituye la conformidad que exige la ley: registrá acá solamente un descuento que ya está autorizado.</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Campo label="Liquidación" requerido hint="Período o número, por ejemplo «Octubre 2026»"><Input value={f.liquidacion_ref} onChange={(e) => setF({ ...f, liquidacion_ref: e.target.value })} /></Campo>
                <Campo label="Autorizado por" requerido hint="Quién autorizó el descuento"><Input value={f.autorizado_por} onChange={(e) => setF({ ...f, autorizado_por: e.target.value })} /></Campo>
              </div>
              <p className="text-xs text-aviso-800">Cargá el gasto de sueldos de esa liquidación por lo efectivamente pagado (neto del adelanto): este movimiento ya reconoce el costo de lo adelantado.</p>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <Campo label="Motivo o descripción" requerido className="sm:col-span-2"><Input value={f.motivo} onChange={(e) => setF({ ...f, motivo: e.target.value })} placeholder="Aporte para compra de herramientas" maxLength={300} /></Campo>
            <Campo label="Comprobante o referencia"><Input value={f.referencia} onChange={(e) => setF({ ...f, referencia: e.target.value })} placeholder="Recibo, transferencia…" maxLength={120} /></Campo>
          </div>
          {error && f.persona_id && f.categoria_id && <p className="text-sm text-tenue">{error}</p>}
          {!altaPersona && !f.persona_id && <Boton tam="sm" icono={<Plus className="size-4" />} onClick={() => setAltaPersona(true)}>Agregar socio u otra persona</Boton>}
        </div>
      )}
    </Modal>
  );
}
