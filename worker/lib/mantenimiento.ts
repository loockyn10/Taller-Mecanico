// Estado de los mantenimientos de los vehículos. Una única fuente para la ficha del vehículo, la pantalla de mantenimientos y los
// recordatorios: se calcula de las órdenes de trabajo (lista/entregada), de los antecedentes cargados a mano y de los planes por vehículo.
//
// Un mantenimiento existe para (vehículo, servicio) cuando:
//   · hay un plan activo del vehículo para ese servicio (aunque nunca se haya realizado), o
//   · el servicio tiene intervalo (km o meses) y se realizó alguna vez en el vehículo (OT o antecedente) y no hay un plan pausado.
// Los intervalos del plan, si los tiene, reemplazan a los del servicio.
import { all } from './db';
import { CLIENTE_PRINCIPAL_SQL } from './vehiculo-clientes';

export type EstadoMantenimiento = 'vencido' | 'proximo' | 'al_dia' | 'sin_registro';

export type Mantenimiento = {
  vehiculo_id: string;
  patente: string;
  marca: string | null;
  modelo: string | null;
  /** Cliente de contacto: el titular vigente del vehículo (o el vinculado más antiguo). Null si el vehículo no tiene clientes vinculados. */
  cliente_id: string | null;
  cliente: string | null;
  cliente_telefono: string | null;
  km_actual: number;
  servicio_id: string;
  servicio: string;
  intervalo_km: number | null;
  intervalo_meses: number | null;
  plan_id: string | null;
  programado: boolean;
  km_realizado: number | null;
  fecha_realizado: string | null;
  origen_realizado: 'orden' | 'antecedente' | null;
  orden_id: string | null;
  orden_numero: number | null;
  proximo_km: number | null;
  proxima_fecha: string | null;
  km_restantes: number | null;
  dias_restantes: number | null;
  estado: EstadoMantenimiento;
  notas: string | null;
}

/** Umbrales para avisar "próximo": hasta 1.000 km o 30 días antes del vencimiento. */
export const AVISO_KM = 1000;
export const AVISO_DIAS = 30;

interface Realizacion {
  vehiculo_id: string;
  servicio_id: string;
  fecha: string;
  km: number | null;
  origen: 'orden' | 'antecedente';
  orden_id: string | null;
  orden_numero: number | null;
}

const DIA_MS = 86400_000;
const aFechaISO = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Suma meses calendario; si el día no existe en el mes de destino queda el último día de ese mes (31/01 + 1 mes = 28/02). */
function sumarMeses(fechaISO: string, meses: number): string {
  const [y, m, dia] = fechaISO.slice(0, 10).split('-').map(Number);
  const destino = new Date(Date.UTC(y, m - 1 + meses, 1, 12));
  const ultimo = new Date(Date.UTC(destino.getUTCFullYear(), destino.getUTCMonth() + 1, 0, 12)).getUTCDate();
  destino.setUTCDate(Math.min(dia, ultimo));
  return destino.toISOString().slice(0, 10);
}

/** Calcula el estado a partir de la última realización conocida y el kilometraje actual (función pura, probada aparte). */
export function evaluarVencimiento(p: {
  intervalo_km: number | null;
  intervalo_meses: number | null;
  km_actual: number;
  km_realizado: number | null;
  fecha_realizado: string | null;
  hoy: string;
}): Pick<Mantenimiento, 'proximo_km' | 'proxima_fecha' | 'km_restantes' | 'dias_restantes' | 'estado'> {
  const proximoKm = p.intervalo_km && p.km_realizado != null ? p.km_realizado + p.intervalo_km : null;
  const proximaFecha = p.intervalo_meses && p.fecha_realizado ? sumarMeses(p.fecha_realizado, p.intervalo_meses) : null;
  if (proximoKm == null && proximaFecha == null) return { proximo_km: null, proxima_fecha: null, km_restantes: null, dias_restantes: null, estado: 'sin_registro' };
  const kmRest = proximoKm != null ? proximoKm - p.km_actual : null;
  const diasRest = proximaFecha != null ? Math.round((Date.parse(`${proximaFecha}T12:00:00Z`) - Date.parse(`${p.hoy}T12:00:00Z`)) / DIA_MS) : null;
  const vencido = (kmRest != null && kmRest <= 0) || (diasRest != null && diasRest <= 0);
  const proximo = !vencido && ((kmRest != null && kmRest <= AVISO_KM) || (diasRest != null && diasRest <= AVISO_DIAS));
  return { proximo_km: proximoKm, proxima_fecha: proximaFecha, km_restantes: kmRest, dias_restantes: diasRest, estado: vencido ? 'vencido' : proximo ? 'proximo' : 'al_dia' };
}

const ORDEN_ESTADO: Record<EstadoMantenimiento, number> = { vencido: 0, proximo: 1, sin_registro: 2, al_dia: 3 };

export async function estadoMantenimientos(db: D1Database, tallerId: string, opts: { vehiculoId?: string } = {}): Promise<Mantenimiento[]> {
  const filtroVeh = opts.vehiculoId ? 'AND v.id = ?' : '';
  const pv = opts.vehiculoId ? [opts.vehiculoId] : [];
  const hoy = aFechaISO(Date.now() - 3 * 3600_000);

  // Última realización: OT terminadas (lista/entregada) y antecedentes manuales.
  const realizaciones = await all<Realizacion>(
    db,
    `SELECT o.vehiculo_id, oi.servicio_id, COALESCE(o.fecha_entregada, o.fecha_lista, o.fecha_ingreso) AS fecha, o.km_ingreso AS km, 'orden' AS origen, o.id AS orden_id, o.numero AS orden_numero
       FROM orden_items oi
       JOIN ordenes o ON o.taller_id = oi.taller_id AND o.id = oi.orden_id AND o.estado IN ('lista','entregada')
       JOIN vehiculos v ON v.taller_id = o.taller_id AND v.id = o.vehiculo_id AND v.activo = 1
      WHERE oi.taller_id = ? AND oi.servicio_id IS NOT NULL ${filtroVeh}
     UNION ALL
     SELECT a.vehiculo_id, a.servicio_id, a.fecha, a.km, 'antecedente', NULL, NULL
       FROM vehiculo_antecedentes a JOIN vehiculos v ON v.taller_id = a.taller_id AND v.id = a.vehiculo_id AND v.activo = 1
      WHERE a.taller_id = ? AND a.anulado = 0 AND a.servicio_id IS NOT NULL ${filtroVeh}`,
    tallerId, ...pv, tallerId, ...pv,
  );
  const ultima = new Map<string, Realizacion>();
  for (const r of realizaciones) {
    const k = `${r.vehiculo_id}|${r.servicio_id}`;
    const prev = ultima.get(k);
    const fecha = (r.fecha ?? '').slice(0, 10);
    const prevFecha = prev ? prev.fecha.slice(0, 10) : '';
    // La más reciente por fecha; ante la misma fecha, la de mayor kilometraje.
    if (!prev || fecha > prevFecha || (fecha === prevFecha && (r.km ?? -1) > (prev.km ?? -1))) ultima.set(k, { ...r, fecha });
  }

  // Candidatos: planes del vehículo (con sus intervalos) y servicios con intervalo ya realizados.
  const planes = await all<{ id: string; vehiculo_id: string; servicio_id: string; intervalo_km: number | null; intervalo_meses: number | null; activo: number; notas: string | null }>(
    db,
    `SELECT p.id, p.vehiculo_id, p.servicio_id, p.intervalo_km, p.intervalo_meses, p.activo, p.notas
       FROM vehiculo_mantenimientos p JOIN vehiculos v ON v.taller_id = p.taller_id AND v.id = p.vehiculo_id AND v.activo = 1
      WHERE p.taller_id = ? ${filtroVeh}`,
    tallerId, ...pv,
  );
  const planPor = new Map(planes.map((p) => [`${p.vehiculo_id}|${p.servicio_id}`, p]));
  const servicios = await all<{ id: string; nombre: string; intervalo_km: number | null; intervalo_meses: number | null }>(db, 'SELECT id, nombre, intervalo_km, intervalo_meses FROM servicios WHERE taller_id = ?', tallerId);
  const servPor = new Map(servicios.map((s) => [s.id, s]));
  const vehiculos = await all<{ id: string; patente: string; km_actual: number; marca: string | null; modelo: string | null; cliente_id: string | null; cliente: string | null; cliente_telefono: string | null }>(
    db,
    `SELECT v.id, v.patente, v.km_actual, c.id AS cliente_id, ma.nombre AS marca, mo.nombre AS modelo, c.nombre AS cliente, c.telefono AS cliente_telefono
       FROM vehiculos v LEFT JOIN clientes c ON c.taller_id = v.taller_id AND c.id = ${CLIENTE_PRINCIPAL_SQL}
       LEFT JOIN marcas ma ON ma.taller_id = v.taller_id AND ma.id = v.marca_id LEFT JOIN modelos mo ON mo.taller_id = v.taller_id AND mo.id = v.modelo_id
      WHERE v.taller_id = ? AND v.activo = 1 ${filtroVeh}`,
    tallerId, ...pv,
  );
  const vehPor = new Map(vehiculos.map((v) => [v.id, v]));

  const claves = new Set<string>([...ultima.keys(), ...planPor.keys()]);
  const salida: Mantenimiento[] = [];
  for (const k of claves) {
    const [vehId, srvId] = k.split('|');
    const v = vehPor.get(vehId);
    const s = servPor.get(srvId);
    if (!v || !s) continue;
    const plan = planPor.get(k) ?? null;
    if (plan && !plan.activo) continue;
    const ult = ultima.get(k) ?? null;
    const intKm = plan?.intervalo_km ?? s.intervalo_km;
    const intMeses = plan?.intervalo_meses ?? s.intervalo_meses;
    // Sin plan, solo cuentan los servicios que tienen algún intervalo.
    if (!plan && !intKm && !intMeses) continue;
    const ev = evaluarVencimiento({ intervalo_km: intKm, intervalo_meses: intMeses, km_actual: v.km_actual, km_realizado: ult?.km ?? null, fecha_realizado: ult?.fecha ?? null, hoy });
    salida.push({
      vehiculo_id: v.id, patente: v.patente, marca: v.marca, modelo: v.modelo, cliente_id: v.cliente_id, cliente: v.cliente, cliente_telefono: v.cliente_telefono, km_actual: v.km_actual,
      servicio_id: s.id, servicio: s.nombre, intervalo_km: intKm, intervalo_meses: intMeses,
      plan_id: plan?.id ?? null, programado: !!plan,
      km_realizado: ult?.km ?? null, fecha_realizado: ult?.fecha ?? null, origen_realizado: ult?.origen ?? null, orden_id: ult?.orden_id ?? null, orden_numero: ult?.orden_numero ?? null,
      ...ev, notas: plan?.notas ?? null,
    });
  }
  return salida.sort((a, b) => ORDEN_ESTADO[a.estado] - ORDEN_ESTADO[b.estado] || (a.dias_restantes ?? 1e9) - (b.dias_restantes ?? 1e9) || (a.km_restantes ?? 1e9) - (b.km_restantes ?? 1e9) || a.patente.localeCompare(b.patente));
}
