// Estado de la puesta en marcha de un taller: cada paso se detecta en los datos reales (no solo en lo que la persona marcó) para que el
// indicador de progreso diga la verdad aunque la configuración se haya hecho desde otra pantalla.
import { all, first } from './db';
import { INFO_PASOS, PASOS, resumenHorarios, type EstadoPaso, type HorariosAtencion, type Paso, type PasoCalculado } from '../../shared/puesta';

export interface EstadoPuesta {
  pasos: PasoCalculado[];
  completos: number;
  omitidos: number;
  pendientes: number;
  total: number;
  asistente_pendiente: boolean;
  /** Primer paso recomendado que falta (para sugerir por dónde seguir). */
  siguiente: Paso | null;
}

const pesos = (c: number) => `$ ${(c / 100).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export async function calcularPuesta(db: D1Database, tallerId: string): Promise<EstadoPuesta> {
  const [t, cfg, marcadores, n] = await Promise.all([
    first<{ nombre: string; direccion: string | null; localidad: string | null; provincia: string | null; telefono: string | null; email: string | null }>(
      db, 'SELECT nombre, direccion, localidad, provincia, telefono, email FROM talleres WHERE id = ?', tallerId,
    ),
    first<{ horarios_atencion: string | null; tarifa_hora: number; medios_pago: string | null; asistente_pendiente: number; caja_obligatoria: number }>(
      db, 'SELECT horarios_atencion, tarifa_hora, medios_pago, asistente_pendiente, caja_obligatoria FROM taller_config WHERE taller_id = ?', tallerId,
    ),
    all<{ paso: string; estado: 'hecho' | 'omitido' }>(db, 'SELECT paso, estado FROM puesta_marcha_pasos WHERE taller_id = ?', tallerId),
    first<Record<string, number | string | null>>(
      db,
      `SELECT
         (SELECT COUNT(*) FROM servicios WHERE taller_id = ?1 AND activo = 1) AS servicios,
         (SELECT COUNT(*) FROM servicios se LEFT JOIN categorias_servicio cs ON cs.taller_id = se.taller_id AND cs.id = se.categoria_id
           WHERE se.taller_id = ?1 AND se.activo = 1 AND se.precio = 0
             AND NOT (se.modo_precio = 'por_tiempo' AND se.tiempo_min IS NOT NULL AND COALESCE(cs.tarifa_hora, (SELECT tarifa_hora FROM taller_config WHERE taller_id = ?1), 0) > 0)) AS sin_precio,
         (SELECT COUNT(*) FROM categorias_articulo WHERE taller_id = ?1) AS cat_art,
         (SELECT COUNT(*) FROM categorias_gasto WHERE taller_id = ?1) AS cat_gasto,
         (SELECT COUNT(*) FROM listas_precios WHERE taller_id = ?1) AS listas,
         (SELECT COUNT(*) FROM usuarios WHERE taller_id = ?1 AND activo = 1) AS usuarios,
         (SELECT COUNT(*) FROM cuentas_bancarias WHERE taller_id = ?1) AS cuentas,
         (SELECT COUNT(*) FROM importaciones WHERE taller_id = ?1 AND estado = 'completada') AS importaciones,
         (SELECT nombre FROM depositos WHERE taller_id = ?1 AND es_principal = 1) AS deposito`,
      tallerId,
    ),
  ]);
  const marca = new Map(marcadores.map((m) => [m.paso, m.estado]));
  const num = (k: string) => Number(n?.[k] ?? 0);
  const paso = (clave: Paso, completoPorDatos: boolean, detalle: string, detalleSiFalta?: string): PasoCalculado => {
    const m = marca.get(clave);
    let estado: EstadoPaso;
    let origen: PasoCalculado['origen'] = null;
    if (completoPorDatos) (estado = 'completo'), (origen = 'datos');
    else if (m === 'hecho') (estado = 'completo'), (origen = 'manual');
    else if (m === 'omitido') (estado = 'omitido'), (origen = 'manual');
    else estado = 'pendiente';
    return { clave, estado, origen, detalle: estado === 'pendiente' ? detalleSiFalta ?? detalle : detalle };
  };

  const faltan: string[] = [];
  if (!t?.direccion) faltan.push('domicilio');
  if (!t?.localidad) faltan.push('localidad');
  if (!t?.provincia) faltan.push('provincia');
  if (!t?.telefono && !t?.email) faltan.push('teléfono o correo');

  let horarios: HorariosAtencion | null = null;
  try { horarios = cfg?.horarios_atencion ? (JSON.parse(cfg.horarios_atencion) as HorariosAtencion) : null; } catch { horarios = null; }

  const tarifa = cfg?.tarifa_hora ?? 0;
  const sinPrecio = num('sin_precio');
  const servicios = num('servicios');
  const medios: string[] | null = cfg?.medios_pago ? JSON.parse(cfg.medios_pago) : null;
  const listaPasos: Record<Paso, PasoCalculado> = {
    negocio: paso('negocio', faltan.length === 0, 'Los datos principales están cargados', `Falta completar: ${faltan.join(', ')}`),
    horarios: paso('horarios', !!horarios, horarios ? resumenHorarios(horarios) || 'Horarios guardados' : '', 'Todavía no cargaste tus horarios de atención'),
    deposito: paso('deposito', false, `Depósito principal: ${n?.deposito ?? '—'}`, `Tu depósito principal se llama "${n?.deposito ?? 'Depósito principal'}". Confirmalo o cambiale el nombre`),
    catalogo: paso(
      'catalogo', servicios > 0 && num('cat_art') > 0,
      `${servicios} servicio${servicios === 1 ? '' : 's'}, ${num('cat_art')} categorías de repuestos y ${num('cat_gasto')} tipos de gastos`,
      servicios === 0 ? 'Todavía no tenés servicios: cargá la plantilla de operaciones del tempario' : 'Faltan categorías de repuestos',
    ),
    tarifas: paso(
      'tarifas', tarifa > 0 && servicios > 0 && sinPrecio === 0,
      `Hora de trabajo: ${pesos(tarifa)}`,
      tarifa <= 0 ? 'Definí cuánto cobrás la hora de trabajo' : servicios === 0 ? 'Cargá primero tus servicios' : `${sinPrecio} servicio${sinPrecio === 1 ? '' : 's'} sin precio`,
    ),
    listas: paso('listas', num('listas') > 0, `${num('listas')} lista${num('listas') === 1 ? '' : 's'} de precios`, 'Opcional: solo si vendés a distintos precios según el cliente'),
    personal: paso('personal', num('usuarios') >= 2, `${num('usuarios')} personas cargadas`, 'Por ahora figurás solo vos. Sumá a tu equipo cuando quieras'),
    cobros: paso(
      'cobros', medios !== null || num('cuentas') > 0 || !!cfg?.caja_obligatoria,
      `${medios ? `${medios.length} medios de cobro habilitados` : 'Todos los medios de cobro habilitados'}${num('cuentas') ? ` · ${num('cuentas')} cuenta${num('cuentas') === 1 ? '' : 's'} bancaria${num('cuentas') === 1 ? '' : 's'}` : ''}`,
      'Revisá los medios de cobro y si querés exigir la caja abierta',
    ),
    importacion: paso('importacion', num('importaciones') > 0, `${num('importaciones')} importación${num('importaciones') === 1 ? '' : 'es'} realizada${num('importaciones') === 1 ? '' : 's'}`, 'Opcional: traé tus clientes, vehículos, artículos y proveedores desde Excel o CSV'),
  };
  const pasos = PASOS.map((p) => listaPasos[p]);
  const completos = pasos.filter((p) => p.estado === 'completo').length;
  const omitidos = pasos.filter((p) => p.estado === 'omitido').length;
  return {
    pasos,
    completos,
    omitidos,
    pendientes: pasos.length - completos - omitidos,
    total: pasos.length,
    asistente_pendiente: !!cfg?.asistente_pendiente,
    siguiente: pasos.find((p) => p.estado === 'pendiente' && INFO_PASOS[p.clave].recomendado)?.clave ?? pasos.find((p) => p.estado === 'pendiente')?.clave ?? null,
  };
}
