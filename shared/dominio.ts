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

export const RUBROS_CAJA = ['cobro', 'pago_proveedor', 'gasto', 'otro_ingreso', 'traspaso', 'devolucion', 'persona'] as const;
export type RubroCaja = (typeof RUBROS_CAJA)[number];
export const RUBRO_CAJA_LABEL: Record<RubroCaja, string> = {
  cobro: 'Cobros de clientes',
  pago_proveedor: 'Pagos a proveedores',
  gasto: 'Gastos',
  otro_ingreso: 'Otros ingresos',
  traspaso: 'Traspasos con bancos',
  devolucion: 'Reintegros a clientes',
  persona: 'Movimientos con personas',
};

export const DESTINOS_PRECIO_BASE = ['costo', 'precio'] as const;
export const REDONDEOS_PRECIO = [0, 100, 1000, 10000] as const; // en centavos: sin redondeo, $1, $10, $100
export const REDONDEO_PRECIO_LABEL: Record<number, string> = { 0: 'Sin redondeo', 100: 'A $1', 1000: 'A $10', 10000: 'A $100' };

/** Cantidades de stock: se operan siempre con 3 decimales (evita errores de coma flotante). */
export const redondearCantidad = (n: number) => Math.round(n * 1000) / 1000;
export const esCantidadValida = (n: number) => Number.isFinite(n) && Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6;

// ───── Bancos, cheques y tesorería ─────
export const TIPOS_CUENTA_BANCARIA = ['cuenta_corriente', 'caja_ahorro', 'billetera_virtual', 'otra'] as const;
export const TIPO_CUENTA_LABEL: Record<(typeof TIPOS_CUENTA_BANCARIA)[number], string> = {
  cuenta_corriente: 'Cuenta corriente',
  caja_ahorro: 'Caja de ahorro',
  billetera_virtual: 'Billetera virtual (CVU)',
  otra: 'Otra',
};
export const MONEDAS = ['ARS', 'USD'] as const;
/** Medios de pago que se acreditan en una cuenta bancaria (el efectivo va a caja; el cheque, a la cartera). */
export const MEDIOS_BANCARIOS: readonly string[] = ['transferencia', 'debito', 'credito', 'otro'];

export const CATEGORIA_BANCO_LABEL: Record<string, string> = {
  cobro: 'Cobro',
  pago_proveedor: 'Pago a proveedor',
  gasto: 'Gasto',
  deposito: 'Depósito de efectivo',
  extraccion: 'Extracción de efectivo',
  transferencia: 'Transferencia entre cuentas',
  cheque: 'Cheque',
  manual: 'Movimiento manual',
  ajuste: 'Ajuste autorizado',
  reverso: 'Anulación',
  devolucion: 'Reintegro a cliente',
};

export const ESTADOS_CHEQUE = ['en_cartera', 'depositado', 'entregado', 'acreditado', 'rechazado', 'anulado'] as const;
export type EstadoCheque = (typeof ESTADOS_CHEQUE)[number];
export const ESTADO_CHEQUE_LABEL: Record<EstadoCheque, string> = {
  en_cartera: 'En cartera',
  depositado: 'Depositado',
  entregado: 'Entregado',
  acreditado: 'Acreditado',
  rechazado: 'Rechazado',
  anulado: 'Anulado',
};
/** Estados en los que un cheque ya salió de la cartera hacia un banco o un tercero (el cobro/pago que lo originó no se puede anular). */
export const ESTADOS_CHEQUE_COMPROMETIDO: readonly EstadoCheque[] = ['depositado', 'entregado', 'acreditado'];
/** Cheque con dinero todavía pendiente de acreditarse. */
export const ESTADOS_CHEQUE_PENDIENTE: readonly EstadoCheque[] = ['en_cartera', 'depositado', 'entregado'];
/** Días corridos de validez de un cheque común desde la fecha de pago (plazo para presentarlo al cobro). */
export const DIAS_VALIDEZ_CHEQUE = 30;

// ───── Compras ─────
export const ESTADOS_ORDEN_COMPRA = ['borrador', 'pendiente', 'parcial', 'recibida', 'cancelada'] as const;
export type EstadoOrdenCompra = (typeof ESTADOS_ORDEN_COMPRA)[number];
export const ESTADO_OC_LABEL: Record<EstadoOrdenCompra, string> = {
  borrador: 'Borrador',
  pendiente: 'Pendiente',
  parcial: 'Parcialmente recibida',
  recibida: 'Recibida',
  cancelada: 'Cancelada',
};

export const TIPOS_COMPROBANTE_PROVEEDOR = ['factura_a', 'factura_b', 'factura_c', 'factura_m', 'nota_credito_a', 'nota_credito_b', 'nota_credito_c', 'nota_debito_a', 'nota_debito_b', 'nota_debito_c', 'ticket', 'otro'] as const;
export type TipoComprobanteProveedor = (typeof TIPOS_COMPROBANTE_PROVEEDOR)[number];
export const TIPO_COMPROBANTE_LABEL: Record<TipoComprobanteProveedor, string> = {
  factura_a: 'Factura A', factura_b: 'Factura B', factura_c: 'Factura C', factura_m: 'Factura M',
  nota_credito_a: 'Nota de crédito A', nota_credito_b: 'Nota de crédito B', nota_credito_c: 'Nota de crédito C',
  nota_debito_a: 'Nota de débito A', nota_debito_b: 'Nota de débito B', nota_debito_c: 'Nota de débito C',
  ticket: 'Ticket', otro: 'Otro comprobante',
};
export const esNotaCredito = (t: string) => t.startsWith('nota_credito');

/** Normaliza un número de comprobante a PPPP-NNNNNNNN (8 dígitos). Devuelve null si no tiene forma de comprobante. */
export function normalizarNroComprobante(texto: string): string | null {
  const m = texto.trim().match(/^(\d{1,5})\s*[-\s]\s*(\d{1,8})$/);
  if (!m) return null;
  return `${m[1].padStart(4, '0').slice(-4)}-${m[2].padStart(8, '0')}`;
}

/** Valida un CUIT/CUIL con su dígito verificador (acepta guiones). */
export function cuitValido(texto: string): boolean {
  const d = texto.replace(/\D/g, '');
  if (d.length !== 11) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((a, p, i) => a + p * Number(d[i]), 0);
  let v = 11 - (suma % 11);
  if (v === 11) v = 0;
  if (v === 10) v = 9;
  return v === Number(d[10]);
}

// ───── Inventario ─────
export const MOTIVOS_AJUSTE = ['conteo', 'rotura', 'merma', 'robo', 'vencimiento', 'error_carga', 'uso_interno', 'otro'] as const;
export type MotivoAjuste = (typeof MOTIVOS_AJUSTE)[number];
export const MOTIVO_AJUSTE_LABEL: Record<MotivoAjuste, string> = {
  conteo: 'Diferencia de conteo físico',
  rotura: 'Rotura o daño',
  merma: 'Merma',
  robo: 'Robo o pérdida',
  vencimiento: 'Vencimiento',
  error_carga: 'Error de carga',
  uso_interno: 'Uso interno del taller',
  otro: 'Otro motivo',
};

// ───── Devoluciones, anticipos y saldo a favor ─────
/** Medios con los que se reintegra dinero a un cliente (no se emiten cheques propios en un reintegro). */
export const MEDIOS_REINTEGRO: readonly MedioPago[] = ['efectivo', 'transferencia', 'debito', 'credito', 'otro'];

export const MOTIVOS_DEVOLUCION = ['arrepentimiento', 'repuesto_incorrecto', 'repuesto_defectuoso', 'servicio_no_conforme', 'error_de_facturacion', 'otro'] as const;
export type MotivoDevolucion = (typeof MOTIVOS_DEVOLUCION)[number];
export const MOTIVO_DEVOLUCION_LABEL: Record<MotivoDevolucion, string> = {
  arrepentimiento: 'Arrepentimiento / ya no lo necesita',
  repuesto_incorrecto: 'Repuesto incorrecto',
  repuesto_defectuoso: 'Repuesto defectuoso',
  servicio_no_conforme: 'Trabajo no conforme',
  error_de_facturacion: 'Error de facturación',
  otro: 'Otro',
};

/** Estado de uso de un anticipo, derivado de lo aplicado y devuelto. */
export type EstadoAnticipo = 'pendiente' | 'parcial' | 'utilizado' | 'devuelto' | 'anulado';
export const ESTADO_ANTICIPO_LABEL: Record<EstadoAnticipo, string> = {
  pendiente: 'Pendiente de aplicar',
  parcial: 'Aplicado en parte',
  utilizado: 'Utilizado',
  devuelto: 'Devuelto',
  anulado: 'Anulado',
};
export function estadoAnticipo(a: { estado: string; total: number; credito_aplicado: number; devuelto: number }): EstadoAnticipo {
  if (a.estado === 'anulado') return 'anulado';
  const libre = a.total - a.credito_aplicado - a.devuelto;
  if (libre === a.total) return 'pendiente';
  if (libre > 0) return 'parcial';
  return a.credito_aplicado > 0 ? 'utilizado' : 'devuelto';
}

/** Relación de un cliente con un vehículo (opcional). Un vehículo puede tener varios clientes vinculados a la vez. */
export const RELACIONES_VEHICULO = ['titular', 'familiar', 'conductor', 'responsable_comercial', 'otro'] as const;
export type RelacionVehiculo = (typeof RELACIONES_VEHICULO)[number];
export const RELACION_VEHICULO_LABEL: Record<RelacionVehiculo, string> = {
  titular: 'Titular',
  familiar: 'Familiar',
  conductor: 'Conductor',
  responsable_comercial: 'Responsable comercial',
  otro: 'Otro',
};
