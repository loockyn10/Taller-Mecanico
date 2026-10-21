// Tempario: catálogo de operaciones con tiempos estimados de mano de obra.
//
// IMPORTANTE: los tiempos de la plantilla inicial son valores GENÉRICOS Y ORIENTATIVOS (promedios de uso común en talleres para un
// vehículo de pasajeros). No provienen de ningún fabricante ni de un tempario oficial. Cada taller los revisa y los ajusta a su
// forma de trabajar, y puede cargar tiempos específicos por marca, modelo, motorización o rango de años.

export interface OperacionPlantilla {
  codigo: string;
  nombre: string;
  categoria: string;
  /** Tiempo genérico orientativo, en minutos. */
  tiempo_min: number;
  descripcion?: string;
  intervalo_km?: number;
  intervalo_meses?: number;
}

export const AVISO_TIEMPOS_ORIENTATIVOS =
  'Los tiempos de la plantilla son valores genéricos y orientativos, no datos oficiales de fabricantes. Revisalos y ajustalos a tu taller.';

const op = (codigo: string, nombre: string, categoria: string, tiempo_min: number, extra: Partial<OperacionPlantilla> = {}): OperacionPlantilla => ({ codigo, nombre, categoria, tiempo_min, ...extra });

export const PLANTILLA_TEMPARIO: readonly OperacionPlantilla[] = [
  // Service
  op('SRV-001', 'Service de aceite y filtros', 'Service', 45, { descripcion: 'Cambio de aceite de motor y filtro de aceite', intervalo_km: 10000, intervalo_meses: 12 }),
  op('SRV-002', 'Cambio de filtro de aire', 'Service', 15, { intervalo_km: 20000, intervalo_meses: 12 }),
  op('SRV-003', 'Cambio de filtro de combustible', 'Service', 30, { intervalo_km: 30000 }),
  op('SRV-004', 'Cambio de filtro de habitáculo', 'Service', 20, { intervalo_km: 10000, intervalo_meses: 12 }),
  op('SRV-005', 'Service completo (aceite, filtros aire/combustible/habitáculo)', 'Service', 90, { intervalo_km: 20000, intervalo_meses: 12 }),
  op('SRV-006', 'Service caja automática', 'Service', 90, { descripcion: 'Cambio de aceite y filtro de caja automática', intervalo_km: 60000, intervalo_meses: 48 }),
  op('SRV-007', 'Cambio de aceite de caja manual', 'Service', 30, { intervalo_km: 60000 }),
  // Frenos
  op('FRE-001', 'Cambio de pastillas delanteras', 'Frenos', 60),
  op('FRE-002', 'Cambio de cintas / pastillas traseras', 'Frenos', 75),
  op('FRE-003', 'Cambio de pastillas y discos delanteros', 'Frenos', 100),
  op('FRE-004', 'Cambio de discos traseros', 'Frenos', 100),
  op('FRE-005', 'Cambio de líquido de frenos', 'Frenos', 45, { descripcion: 'Purga y reposición del líquido de frenos', intervalo_km: 40000, intervalo_meses: 24 }),
  op('FRE-006', 'Revisión del sistema de frenos', 'Frenos', 30),
  op('FRE-007', 'Cambio de flexibles o cañerías de freno', 'Frenos', 90),
  // Distribución y correas
  op('DIS-001', 'Cambio de kit de distribución', 'Distribución', 240, { intervalo_km: 60000, intervalo_meses: 48 }),
  op('DIS-002', 'Cambio de correa poly-V', 'Distribución', 40, { intervalo_km: 60000 }),
  op('DIS-003', 'Cambio de tensor de correa de accesorios', 'Distribución', 45),
  // Embrague y transmisión
  op('EMB-001', 'Cambio de kit de embrague', 'Embrague y transmisión', 300),
  op('EMB-002', 'Cambio de cable o bomba de embrague', 'Embrague y transmisión', 90),
  op('EMB-003', 'Cambio de semieje / junta homocinética', 'Embrague y transmisión', 120),
  // Suspensión y tren delantero
  op('SUS-001', 'Cambio de amortiguadores delanteros', 'Suspensión y tren delantero', 120, { descripcion: 'Par de amortiguadores delanteros' }),
  op('SUS-002', 'Cambio de amortiguadores traseros', 'Suspensión y tren delantero', 90, { descripcion: 'Par de amortiguadores traseros' }),
  op('SUS-003', 'Cambio de bujes / extremos', 'Suspensión y tren delantero', 90),
  op('SUS-004', 'Cambio de rótulas', 'Suspensión y tren delantero', 90),
  op('SUS-005', 'Alineación y balanceo', 'Suspensión y tren delantero', 60, { intervalo_km: 10000, intervalo_meses: 6 }),
  op('SUS-006', 'Reparación de suspensión (diagnóstico y ajuste)', 'Suspensión y tren delantero', 120),
  op('SUS-007', 'Cambio de rulemán de rueda', 'Suspensión y tren delantero', 90),
  op('SUS-008', 'Cambio de brazos de suspensión', 'Suspensión y tren delantero', 120),
  // Encendido y electricidad
  op('ELE-001', 'Cambio de bujías', 'Encendido y electricidad', 45, { intervalo_km: 30000 }),
  op('ELE-002', 'Cambio de batería', 'Encendido y electricidad', 20),
  op('ELE-003', 'Diagnóstico con escáner', 'Encendido y electricidad', 60, { descripcion: 'Diagnóstico electrónico con escáner y lectura de fallas' }),
  op('ELE-004', 'Revisión del sistema de carga y arranque', 'Encendido y electricidad', 45),
  op('ELE-005', 'Cambio de alternador', 'Encendido y electricidad', 120),
  op('ELE-006', 'Cambio de motor de arranque', 'Encendido y electricidad', 90),
  // Refrigeración
  op('REF-001', 'Cambio de líquido refrigerante', 'Refrigeración', 45, { intervalo_km: 40000, intervalo_meses: 24 }),
  op('REF-002', 'Cambio de bomba de agua', 'Refrigeración', 120),
  op('REF-003', 'Cambio de termostato', 'Refrigeración', 60),
  op('REF-004', 'Cambio de radiador', 'Refrigeración', 150),
  // Aire acondicionado
  op('AAC-001', 'Carga de gas A/A', 'Aire acondicionado', 60, { intervalo_meses: 12 }),
  op('AAC-002', 'Diagnóstico de aire acondicionado', 'Aire acondicionado', 45),
  // Motor
  op('MOT-001', 'Cambio de junta de tapa de cilindros', 'Motor', 480),
  op('MOT-002', 'Cambio de retenes de motor', 'Motor', 150),
  op('MOT-003', 'Cambio de soporte de motor', 'Motor', 90),
  // Escape
  op('ESC-001', 'Cambio de silenciador o caño de escape', 'Escape', 60),
  // Varios
  op('VAR-001', 'Revisión general / pre-VTV', 'Varios', 60, { intervalo_meses: 12 }),
  op('VAR-002', 'Mano de obra por hora', 'Varios', 60, { descripcion: 'Reparaciones generales: se cobra por hora de trabajo' }),
  op('VAR-003', 'Diagnóstico general de falla', 'Varios', 60),
];

// ───────────────────────── Tiempos específicos (marca, modelo, motorización, años) ─────────────────────────

export interface ReglaTiempo {
  id: string;
  marca_id: string | null;
  modelo_id: string | null;
  motor: string | null;
  anio_desde: number | null;
  anio_hasta: number | null;
  tiempo_min: number;
}

export interface VehiculoParaTiempo {
  marca_id: string | null;
  modelo_id: string | null;
  motor: string | null;
  anio: number | null;
}

export type OrigenTiempo = 'especifico' | 'generico' | 'sin_dato';
export interface TiempoResuelto {
  tiempo_min: number | null;
  origen: OrigenTiempo;
  regla_id: string | null;
}

export const normalizarTexto = (s: string | null | undefined): string =>
  (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Puntaje de especificidad si la regla aplica al vehículo; null si no aplica. El modelo pesa más que la marca, y ésta más que motor y años. */
export function puntajeRegla(r: ReglaTiempo, v: VehiculoParaTiempo): number | null {
  let puntos = 0;
  if (r.modelo_id) {
    if (r.modelo_id !== v.modelo_id) return null;
    puntos += 8;
  }
  if (r.marca_id) {
    if (r.marca_id !== v.marca_id) return null;
    puntos += 4;
  }
  if (r.motor) {
    const m = normalizarTexto(v.motor);
    if (!m || !m.includes(normalizarTexto(r.motor))) return null;
    puntos += 2;
  }
  if (r.anio_desde != null || r.anio_hasta != null) {
    if (v.anio == null) return null;
    if (r.anio_desde != null && v.anio < r.anio_desde) return null;
    if (r.anio_hasta != null && v.anio > r.anio_hasta) return null;
    puntos += 1;
  }
  return puntos;
}

/**
 * Tiempo que corresponde a una operación para un vehículo: la regla específica más precisa que aplique; si no hay ninguna (o no se
 * indicó vehículo), el tiempo genérico de la operación. La especificidad es siempre opcional.
 */
export function resolverTiempo(generico: number | null, reglas: readonly ReglaTiempo[], v: VehiculoParaTiempo | null): TiempoResuelto {
  let mejor: { r: ReglaTiempo; p: number } | null = null;
  if (v) {
    for (const r of reglas) {
      const p = puntajeRegla(r, v);
      if (p === null || p === 0) continue;
      // Ante igual puntaje gana el último de la lista (el servidor las entrega de la más antigua a la más reciente).
      if (!mejor || p >= mejor.p) mejor = { r, p };
    }
  }
  if (mejor) return { tiempo_min: mejor.r.tiempo_min, origen: 'especifico', regla_id: mejor.r.id };
  if (generico != null) return { tiempo_min: generico, origen: 'generico', regla_id: null };
  return { tiempo_min: null, origen: 'sin_dato', regla_id: null };
}

/**
 * Mano de obra según la tarifa horaria del taller (en centavos por hora): se redondea al peso entero.
 * Con tarifa 0 devuelve 0 (el taller todavía no la configuró).
 */
export function precioPorTiempo(tiempoMin: number, tarifaHora: number): number {
  if (!(tiempoMin > 0) || !(tarifaHora > 0)) return 0;
  return Math.round((tiempoMin * tarifaHora) / 60 / 100) * 100;
}

/** "1 h 30 min", "45 min", "2 h". */
export function formatearMinutos(min: number | null | undefined): string {
  if (min == null) return '—';
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${r} min`;
  return r ? `${h} h ${r} min` : `${h} h`;
}

// ───────────────────────── Tareas de las órdenes ─────────────────────────

export const ESTADOS_TAREA = ['pendiente', 'en_proceso', 'pausada', 'completada'] as const;
export type EstadoTarea = (typeof ESTADOS_TAREA)[number];
export const ESTADO_TAREA_LABEL: Record<EstadoTarea, string> = {
  pendiente: 'Pendiente',
  en_proceso: 'En proceso',
  pausada: 'Pausada',
  completada: 'Completada',
};
