// Movimientos financieros con personas (Sprint 24): aportes de capital, préstamos de socios, préstamos y adelantos al personal.
// Reglas de negocio puras compartidas por el servidor y la pantalla. Todo importe son centavos enteros (nunca coma flotante).

/**
 * Tipo financiero: lo que un movimiento ES para la empresa. Decide la dirección del dinero y el asiento contable; las categorías (propias o
 * personalizadas) sólo le ponen nombre. Una categoría libre jamás define un asiento arbitrario: elige uno de estos tipos.
 */
export const TIPOS_FIN = [
  'aporte_capital',
  'retiro_capital',
  'prestamo_recibido',
  'devolucion_prestamo_recibido',
  'prestamo_otorgado',
  'devolucion_prestamo_otorgado',
  'adelanto_sueldo',
  'aplicacion_adelanto',
] as const;
export type TipoFin = (typeof TIPOS_FIN)[number];
export const esTipoFin = (x: unknown): x is TipoFin => typeof x === 'string' && (TIPOS_FIN as readonly string[]).includes(x);

/** Dirección del dinero desde la empresa. `sin_dinero`: la regularización de un adelanto no mueve caja ni bancos. */
export type Direccion = 'entrada' | 'salida' | 'sin_dinero';

/** Obligación que abre o regulariza un tipo: los saldos pendientes se llevan por separado y nunca se mezclan entre sí. */
export type Obligacion = 'prestamo_recibido' | 'prestamo_otorgado' | 'adelanto_sueldo';
export const OBLIGACIONES: readonly Obligacion[] = ['prestamo_recibido', 'prestamo_otorgado', 'adelanto_sueldo'];
export const OBLIGACION_LABEL: Record<Obligacion, string> = {
  prestamo_recibido: 'Préstamos recibidos (la empresa debe)',
  prestamo_otorgado: 'Préstamos otorgados (la persona debe)',
  adelanto_sueldo: 'Adelantos de sueldo pendientes de aplicar',
};

export interface DefTipoFin {
  etiqueta: string;
  direccion: Direccion;
  /** Obligación que ABRE este tipo (el movimiento queda con saldo pendiente). */
  abre?: Obligacion;
  /** Obligación que REGULARIZA este tipo (cada movimiento se asocia a una obligación concreta). */
  regulariza?: Obligacion;
  /** Sólo se admite para personas del personal. */
  soloPersonal?: boolean;
  /** Cómo se asienta, en lenguaje de pantalla. */
  asiento: string;
}

export const DEF_TIPOS_FIN: Record<TipoFin, DefTipoFin> = {
  aporte_capital: { etiqueta: 'Aporte de capital', direccion: 'entrada', asiento: 'Aumenta la caja o el banco y el capital. No es una venta ni una ganancia.' },
  retiro_capital: { etiqueta: 'Retiro o devolución de capital', direccion: 'salida', asiento: 'Baja la caja o el banco y el capital aportado. No es un gasto.' },
  prestamo_recibido: { etiqueta: 'Préstamo recibido por la empresa', direccion: 'entrada', abre: 'prestamo_recibido', asiento: 'Aumenta la caja o el banco y una deuda de la empresa. No es un ingreso.' },
  devolucion_prestamo_recibido: { etiqueta: 'Devolución de un préstamo recibido', direccion: 'salida', regulariza: 'prestamo_recibido', asiento: 'Baja la caja o el banco y la deuda con la persona.' },
  prestamo_otorgado: { etiqueta: 'Préstamo otorgado por la empresa', direccion: 'salida', abre: 'prestamo_otorgado', asiento: 'Baja la caja o el banco y genera una cuenta a cobrar a la persona. No es un gasto.' },
  devolucion_prestamo_otorgado: { etiqueta: 'Devolución de un préstamo otorgado', direccion: 'entrada', regulariza: 'prestamo_otorgado', asiento: 'Aumenta la caja o el banco y baja la cuenta a cobrar a la persona. No es una venta.' },
  adelanto_sueldo: { etiqueta: 'Adelanto de sueldo', direccion: 'salida', abre: 'adelanto_sueldo', soloPersonal: true, asiento: 'Baja la caja o el banco y queda como adelanto pendiente de aplicar. No es todavía un gasto de sueldos.' },
  aplicacion_adelanto: { etiqueta: 'Aplicación de un adelanto de sueldo', direccion: 'sin_dinero', regulariza: 'adelanto_sueldo', soloPersonal: true, asiento: 'No mueve dinero: cancela el adelanto contra una liquidación y reconoce el costo de sueldos.' },
};

export const direccionDe = (t: TipoFin): Direccion => DEF_TIPOS_FIN[t].direccion;
export const DIRECCION_LABEL: Record<Direccion, string> = { entrada: 'Ingreso de dinero a la empresa', salida: 'Salida de dinero de la empresa', sin_dinero: 'Sin movimiento de dinero' };

export const TIPOS_PERSONA = ['socio', 'propietario', 'empleado', 'otra'] as const;
export type TipoPersona = (typeof TIPOS_PERSONA)[number];
export const TIPO_PERSONA_LABEL: Record<TipoPersona, string> = { socio: 'Socio', propietario: 'Propietario', empleado: 'Personal', otra: 'Otra persona' };

export interface CategoriaSistema {
  clave: string;
  nombre: string;
  tipo: TipoFin | null;
  grupo: string;
  /** Categorías que todavía no se pueden usar (con el motivo): se muestran pero no se ofrecen al registrar. */
  pendiente?: string;
}

/** Categorías iniciales. El orden es el de la pantalla. La clave es el identificador estable (el id es `clave` dentro de cada empresa). */
export const CATEGORIAS_SISTEMA: readonly CategoriaSistema[] = [
  { clave: 'aporte_capital', nombre: 'Aporte de capital', tipo: 'aporte_capital', grupo: 'Capital' },
  { clave: 'retiro_capital', nombre: 'Retiro o devolución de capital', tipo: 'retiro_capital', grupo: 'Capital' },
  { clave: 'prestamo_a_empresa', nombre: 'Préstamo de persona a empresa', tipo: 'prestamo_recibido', grupo: 'Préstamos de socios o propietarios' },
  { clave: 'devolucion_prestamo_a_persona', nombre: 'Devolución de préstamo recibido (paga la empresa)', tipo: 'devolucion_prestamo_recibido', grupo: 'Préstamos de socios o propietarios' },
  { clave: 'prestamo_a_persona', nombre: 'Préstamo de empresa a persona', tipo: 'prestamo_otorgado', grupo: 'Préstamos al personal' },
  { clave: 'devolucion_prestamo_a_empresa', nombre: 'Devolución de préstamo otorgado (paga la persona)', tipo: 'devolucion_prestamo_otorgado', grupo: 'Préstamos al personal' },
  { clave: 'adelanto_sueldo', nombre: 'Adelanto de sueldo', tipo: 'adelanto_sueldo', grupo: 'Remuneraciones' },
  { clave: 'aplicacion_adelanto', nombre: 'Aplicación de adelanto de sueldo', tipo: 'aplicacion_adelanto', grupo: 'Remuneraciones' },
  {
    clave: 'reintegro_gastos', nombre: 'Reintegro de gastos realizados por una persona', tipo: null, grupo: 'Otros',
    pendiente: 'Los gastos del sistema siempre salen de la caja o de un banco de la empresa: registrar el gasto y además reintegrarlo contaría el egreso dos veces. Queda pendiente hasta poder registrar un gasto pagado por una persona.',
  },
];
export const categoriaSistema = (clave: string) => CATEGORIAS_SISTEMA.find((c) => c.clave === clave);
export const GRUPOS_CATEGORIA = ['Capital', 'Préstamos de socios o propietarios', 'Préstamos al personal', 'Remuneraciones', 'Otros'] as const;

export const MONEDAS_ADMITIDAS = ['ARS'] as const;
export const MONEDAS_MOVIMIENTO = ['ARS', 'USD'] as const;

// ───────────────────────── Estados ─────────────────────────
export type EstadoMovimiento = 'registrado' | 'parcial' | 'regularizado' | 'anulado';
export const ESTADO_MOV_LABEL: Record<EstadoMovimiento, string> = { registrado: 'Registrado', parcial: 'Parcialmente regularizado', regularizado: 'Regularizado', anulado: 'Anulado' };

export const abreObligacion = (t: TipoFin): boolean => !!DEF_TIPOS_FIN[t].abre;
export const regularizaObligacion = (t: TipoFin): boolean => !!DEF_TIPOS_FIN[t].regulariza;

/**
 * Estado visible. «Parcialmente regularizado» y «Regularizado» sólo tienen sentido en los movimientos que abren una obligación
 * (préstamos y adelantos); el resto —aportes, retiros, devoluciones— queda simplemente «Registrado».
 */
export function estadoMovimiento(m: { estado: string; tipo_fin: TipoFin; importe: number; regularizado: number }): EstadoMovimiento {
  if (m.estado === 'anulado') return 'anulado';
  if (!abreObligacion(m.tipo_fin)) return 'registrado';
  if (m.regularizado <= 0) return 'registrado';
  return m.regularizado >= m.importe ? 'regularizado' : 'parcial';
}

/** Saldo pendiente de una obligación (0 si está anulada o no abre obligación). */
export function saldoPendiente(m: { estado: string; tipo_fin: TipoFin; importe: number; regularizado: number }): number {
  if (m.estado === 'anulado' || !abreObligacion(m.tipo_fin)) return 0;
  return Math.max(0, m.importe - m.regularizado);
}

/** Valida un importe en centavos enteros y positivos. Devuelve el error o null. */
export function errorImporte(importe: number): string | null {
  if (!Number.isInteger(importe)) return 'El importe debe estar en centavos exactos';
  if (importe <= 0) return 'El importe debe ser mayor a 0';
  if (importe > 99_999_999_999) return 'El importe es demasiado grande';
  return null;
}
