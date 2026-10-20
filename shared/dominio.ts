// Estados, transiciones y catálogos fijos del dominio.

export const ESTADOS_OT = ['recibida', 'diagnostico', 'en_reparacion', 'esperando_repuestos', 'lista', 'entregada', 'cancelada'] as const;
export type EstadoOT = (typeof ESTADOS_OT)[number];

export const ESTADO_OT_LABEL: Record<EstadoOT, string> = {
  recibida: 'Recibida',
  diagnostico: 'En diagnóstico',
  en_reparacion: 'En reparación',
  esperando_repuestos: 'Esperando repuestos',
  lista: 'Lista para entregar',
  entregada: 'Entregada',
  cancelada: 'Cancelada',
};

/** Estados abiertos (trabajo en curso). */
export const ESTADOS_OT_ABIERTOS: EstadoOT[] = ['recibida', 'diagnostico', 'en_reparacion', 'esperando_repuestos', 'lista'];

/** Transiciones permitidas. Pasar a 'lista' o 'entregada' consume stock; volver desde ellas lo repone. */
export const TRANSICIONES_OT: Record<EstadoOT, EstadoOT[]> = {
  recibida: ['diagnostico', 'en_reparacion', 'esperando_repuestos', 'lista', 'cancelada'],
  diagnostico: ['recibida', 'en_reparacion', 'esperando_repuestos', 'lista', 'cancelada'],
  en_reparacion: ['diagnostico', 'esperando_repuestos', 'lista', 'cancelada'],
  esperando_repuestos: ['diagnostico', 'en_reparacion', 'lista', 'cancelada'],
  lista: ['en_reparacion', 'entregada', 'cancelada'],
  entregada: ['lista'],
  cancelada: ['recibida'],
};

/** Estados en los que el stock de la OT está descontado. */
export const ESTADOS_OT_CON_STOCK: EstadoOT[] = ['lista', 'entregada'];

/** Estados en los que se pueden editar los ítems de la OT. */
export const ESTADOS_OT_EDITABLES: EstadoOT[] = ['recibida', 'diagnostico', 'en_reparacion', 'esperando_repuestos'];

export const ESTADOS_PRESUPUESTO = ['pendiente', 'aprobado', 'rechazado', 'convertido', 'anulado'] as const;
export type EstadoPresupuesto = (typeof ESTADOS_PRESUPUESTO)[number];
export const ESTADO_PRESUPUESTO_LABEL: Record<EstadoPresupuesto, string> = {
  pendiente: 'Pendiente',
  aprobado: 'Aprobado',
  rechazado: 'Rechazado',
  convertido: 'Convertido en OT',
  anulado: 'Anulado',
};

export const ESTADOS_TURNO = ['agendado', 'confirmado', 'en_taller', 'completado', 'cancelado', 'ausente'] as const;
export type EstadoTurno = (typeof ESTADOS_TURNO)[number];
export const ESTADO_TURNO_LABEL: Record<EstadoTurno, string> = {
  agendado: 'Agendado',
  confirmado: 'Confirmado',
  en_taller: 'En taller',
  completado: 'Completado',
  cancelado: 'Cancelado',
  ausente: 'No asistió',
};

export const MEDIOS_PAGO = ['efectivo', 'transferencia', 'debito', 'credito', 'cheque', 'otro'] as const;
export type MedioPago = (typeof MEDIOS_PAGO)[number];
export const MEDIO_PAGO_LABEL: Record<MedioPago, string> = {
  efectivo: 'Efectivo',
  transferencia: 'Transferencia',
  debito: 'Tarjeta de débito',
  credito: 'Tarjeta de crédito',
  cheque: 'Cheque',
  otro: 'Otro',
};

export const CONDICIONES_IVA = ['consumidor_final', 'monotributo', 'responsable_inscripto', 'exento'] as const;
export type CondicionIva = (typeof CONDICIONES_IVA)[number];
export const CONDICION_IVA_LABEL: Record<CondicionIva, string> = {
  consumidor_final: 'Consumidor final',
  monotributo: 'Monotributista',
  responsable_inscripto: 'Responsable inscripto',
  exento: 'Exento',
};

export const TIPOS_VEHICULO = ['todos', 'auto', 'camioneta', 'camion', 'moto', 'utilitario'] as const;
export const TIPO_VEHICULO_LABEL: Record<(typeof TIPOS_VEHICULO)[number], string> = {
  todos: 'Todos',
  auto: 'Auto',
  camioneta: 'Camioneta / SUV',
  camion: 'Camión',
  moto: 'Moto',
  utilitario: 'Utilitario',
};

export const COMBUSTIBLE_NIVELES = ['reserva', '1/4', '1/2', '3/4', 'lleno'] as const;

export const TIPOS_MOVIMIENTO_STOCK_LABEL: Record<string, string> = {
  entrada: 'Entrada manual',
  salida: 'Salida manual',
  ajuste: 'Ajuste de inventario',
  consumo_ot: 'Consumo en OT',
  reverso_ot: 'Reposición por OT reabierta',
  venta: 'Venta',
  anulacion_venta: 'Anulación de venta',
  compra: 'Compra',
  anulacion_compra: 'Anulación de compra',
};

/** Normaliza una patente: mayúsculas, sin espacios ni guiones. */
export function normalizarPatente(p: string): string {
  return p.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export const CHECKLIST_ITEMS = {
  danos: ['Rayones', 'Golpes', 'Abolladuras', 'Vidrios rotos', 'Llantas dañadas', 'Neumáticos gastados', 'Ópticas rotas'],
  testigos: ['Check engine', 'ABS', 'Airbag', 'Batería', 'Aceite', 'Temperatura', 'Frenos'],
  accesorios: ['Rueda de auxilio', 'Criquet / llave', 'Matafuego', 'Balizas', 'Llave de seguridad', 'Segunda llave', 'Documentación', 'Estéreo / pantalla'],
  ingreso: ['Funcionando', 'Llega en grúa', 'Arranca con dificultad', 'No arranca'],
} as const;

// ───── Caja y finanzas ─────
export const TIPOS_CATEGORIA_GASTO = ['operativo', 'fijo', 'impuestos', 'otro'] as const;
export type TipoCategoriaGasto = (typeof TIPOS_CATEGORIA_GASTO)[number];
export const TIPO_CATEGORIA_GASTO_LABEL: Record<TipoCategoriaGasto, string> = {
  operativo: 'Operativo',
  fijo: 'Fijo',
  impuestos: 'Impuestos',
  otro: 'Otro',
};

export const FRECUENCIAS_GASTO = ['semanal', 'mensual', 'bimestral', 'trimestral', 'anual'] as const;
export type FrecuenciaGasto = (typeof FRECUENCIAS_GASTO)[number];
export const FRECUENCIA_GASTO_LABEL: Record<FrecuenciaGasto, string> = {
  semanal: 'Semanal',
  mensual: 'Mensual',
  bimestral: 'Bimestral',
  trimestral: 'Trimestral',
  anual: 'Anual',
};

export const RUBROS_CAJA = ['cobro', 'pago_proveedor', 'gasto', 'otro_ingreso'] as const;
export type RubroCaja = (typeof RUBROS_CAJA)[number];
export const RUBRO_CAJA_LABEL: Record<RubroCaja, string> = {
  cobro: 'Cobros de clientes',
  pago_proveedor: 'Pagos a proveedores',
  gasto: 'Gastos',
  otro_ingreso: 'Otros ingresos',
};

export const DESTINOS_PRECIO_BASE = ['costo', 'precio'] as const;
export const REDONDEOS_PRECIO = [0, 100, 1000, 10000] as const; // en centavos: sin redondeo, $1, $10, $100
export const REDONDEO_PRECIO_LABEL: Record<number, string> = { 0: 'Sin redondeo', 100: 'A $1', 1000: 'A $10', 10000: 'A $100' };

/** Cantidades de stock: se operan siempre con 3 decimales (evita errores de coma flotante). */
export const redondearCantidad = (n: number) => Math.round(n * 1000) / 1000;
export const esCantidadValida = (n: number) => Number.isFinite(n) && Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6;
