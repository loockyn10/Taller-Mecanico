// Contabilidad de gestión (información contable y administrativa INTERNA; no son libros fiscales ni tienen validez ante ARCA).
// Plan de cuentas inicial para un taller mecánico, roles de las cuentas que usa la contabilización automática y utilidades puras.

export type TipoCuenta = 'activo' | 'pasivo' | 'patrimonio' | 'ingreso' | 'costo' | 'gasto';
export type Naturaleza = 'deudora' | 'acreedora';

export const TIPOS_CUENTA: readonly TipoCuenta[] = ['activo', 'pasivo', 'patrimonio', 'ingreso', 'costo', 'gasto'];
export const TIPO_LABEL: Record<TipoCuenta, string> = { activo: 'Activo', pasivo: 'Pasivo', patrimonio: 'Patrimonio', ingreso: 'Ingresos', costo: 'Costos', gasto: 'Gastos' };
export const naturalezaDe = (t: TipoCuenta): Naturaleza => (t === 'activo' || t === 'costo' || t === 'gasto' ? 'deudora' : 'acreedora');

/** Roles: cuentas que usa la contabilización automática. Una cuenta con rol no se elimina ni se desactiva. */
export const ROLES_CUENTA = [
  'caja_efectivo', 'valores_depositar', 'electronicos_sin_cuenta', 'transferencias_transito', 'ajustes_bancarios',
  'deudores', 'iva_credito', 'otros_tributos_compras', 'inventario',
  'proveedores', 'mercaderia_a_facturar', 'anticipos', 'cheques_emitidos', 'iva_debito', 'obligaciones',
  'capital', 'apertura', 'entradas_stock_sin_compra', 'resultados_acumulados',
  'ventas_repuestos', 'ventas_servicios', 'devol_repuestos', 'devol_servicios', 'otros_ingresos', 'ingresos_bancarios', 'bonif_proveedores',
  'costo_repuestos', 'costo_mano_obra',
  'gasto_alquileres', 'gasto_servicios', 'gasto_impuestos', 'gasto_insumos', 'gasto_herramientas', 'gasto_mantenimiento', 'gasto_combustible', 'gasto_publicidad', 'gasto_varios',
  'compras_sin_stock', 'gastos_bancarios', 'costos_comerciales', 'diferencias_inventario',
] as const;
export type RolCuenta = (typeof ROLES_CUENTA)[number];

export interface CuentaBase {
  codigo: string;
  nombre: string;
  tipo: TipoCuenta;
  imputable: boolean;
  rol?: RolCuenta;
  /** Código del rubro padre. */
  padre?: string;
  /** Cuenta regularizadora: su saldo normal es contrario al de su tipo (p. ej. devoluciones sobre ventas). */
  contra?: boolean;
  notas?: string;
}

/** Plan de cuentas inicial. Cada taller recibe su propia copia, que puede ampliar y renombrar. */
export const PLAN_INICIAL: readonly CuentaBase[] = [
  { codigo: '1', nombre: 'ACTIVO', tipo: 'activo', imputable: false },
  { codigo: '1.1', nombre: 'Disponibilidades', tipo: 'activo', imputable: false, padre: '1' },
  { codigo: '1.1.01', nombre: 'Caja en efectivo', tipo: 'activo', imputable: true, padre: '1.1', rol: 'caja_efectivo' },
  { codigo: '1.1.02', nombre: 'Valores a depositar (cheques en cartera)', tipo: 'activo', imputable: true, padre: '1.1', rol: 'valores_depositar' },
  { codigo: '1.1.03', nombre: 'Bancos y billeteras', tipo: 'activo', imputable: false, padre: '1.1', notas: 'Cada cuenta bancaria del taller tiene aquí su propia cuenta contable.' },
  { codigo: '1.1.04', nombre: 'Medios electrónicos sin cuenta asignada', tipo: 'activo', imputable: true, padre: '1.1', rol: 'electronicos_sin_cuenta', notas: 'Cobros y pagos por transferencia o tarjeta registrados sin elegir una cuenta bancaria.' },
  { codigo: '1.1.05', nombre: 'Transferencias entre cuentas propias (a compensar)', tipo: 'activo', imputable: true, padre: '1.1', rol: 'transferencias_transito', notas: 'Debe quedar en cero: una transferencia entre cuentas propias no es un ingreso ni un gasto.' },
  { codigo: '1.1.06', nombre: 'Ajustes bancarios a clasificar', tipo: 'activo', imputable: true, padre: '1.1', rol: 'ajustes_bancarios', notas: 'Contrapartida de los ajustes manuales de saldo bancario hasta que se identifique su causa.' },
  { codigo: '1.2', nombre: 'Créditos', tipo: 'activo', imputable: false, padre: '1' },
  { codigo: '1.2.01', nombre: 'Deudores por ventas (clientes)', tipo: 'activo', imputable: true, padre: '1.2', rol: 'deudores' },
  { codigo: '1.2.02', nombre: 'IVA crédito fiscal (informativo)', tipo: 'activo', imputable: true, padre: '1.2', rol: 'iva_credito' },
  { codigo: '1.2.03', nombre: 'Otros tributos de compras a recuperar', tipo: 'activo', imputable: true, padre: '1.2', rol: 'otros_tributos_compras' },
  { codigo: '1.3', nombre: 'Bienes de cambio', tipo: 'activo', imputable: false, padre: '1' },
  { codigo: '1.3.01', nombre: 'Inventario de repuestos', tipo: 'activo', imputable: true, padre: '1.3', rol: 'inventario' },
  { codigo: '2', nombre: 'PASIVO', tipo: 'pasivo', imputable: false },
  { codigo: '2.1', nombre: 'Deudas comerciales', tipo: 'pasivo', imputable: false, padre: '2' },
  { codigo: '2.1.01', nombre: 'Proveedores', tipo: 'pasivo', imputable: true, padre: '2.1', rol: 'proveedores' },
  { codigo: '2.1.02', nombre: 'Mercadería recibida pendiente de facturar', tipo: 'pasivo', imputable: true, padre: '2.1', rol: 'mercaderia_a_facturar' },
  { codigo: '2.1.03', nombre: 'Anticipos y saldos a favor de clientes', tipo: 'pasivo', imputable: true, padre: '2.1', rol: 'anticipos', notas: 'Dinero recibido o crédito por devoluciones que todavía no se aplicó a una venta. No es un ingreso.' },
  { codigo: '2.1.04', nombre: 'Cheques propios emitidos pendientes de acreditar', tipo: 'pasivo', imputable: true, padre: '2.1', rol: 'cheques_emitidos' },
  { codigo: '2.2', nombre: 'Deudas fiscales', tipo: 'pasivo', imputable: false, padre: '2' },
  { codigo: '2.2.01', nombre: 'IVA débito fiscal (informativo)', tipo: 'pasivo', imputable: true, padre: '2.2', rol: 'iva_debito' },
  { codigo: '2.3', nombre: 'Otras obligaciones', tipo: 'pasivo', imputable: false, padre: '2' },
  { codigo: '2.3.01', nombre: 'Obligaciones pendientes', tipo: 'pasivo', imputable: true, padre: '2.3', rol: 'obligaciones' },
  { codigo: '3', nombre: 'PATRIMONIO', tipo: 'patrimonio', imputable: false },
  { codigo: '3.1', nombre: 'Capital y saldos iniciales', tipo: 'patrimonio', imputable: false, padre: '3' },
  { codigo: '3.1.01', nombre: 'Capital y aportes', tipo: 'patrimonio', imputable: true, padre: '3.1', rol: 'capital' },
  { codigo: '3.1.02', nombre: 'Saldos iniciales y ajustes de apertura', tipo: 'patrimonio', imputable: true, padre: '3.1', rol: 'apertura', notas: 'Contrapartida de los saldos iniciales de caja y bancos. Los demás saldos iniciales se cargan con un asiento manual.' },
  { codigo: '3.1.03', nombre: 'Entradas de mercadería sin compra registrada (a clasificar)', tipo: 'patrimonio', imputable: true, padre: '3.1', rol: 'entradas_stock_sin_compra' },
  { codigo: '3.2', nombre: 'Resultados', tipo: 'patrimonio', imputable: false, padre: '3' },
  { codigo: '3.2.01', nombre: 'Resultados acumulados', tipo: 'patrimonio', imputable: true, padre: '3.2', rol: 'resultados_acumulados' },
  { codigo: '4', nombre: 'INGRESOS', tipo: 'ingreso', imputable: false },
  { codigo: '4.1', nombre: 'Ventas', tipo: 'ingreso', imputable: false, padre: '4' },
  { codigo: '4.1.01', nombre: 'Ventas de repuestos', tipo: 'ingreso', imputable: true, padre: '4.1', rol: 'ventas_repuestos' },
  { codigo: '4.1.02', nombre: 'Ingresos por servicios y mano de obra', tipo: 'ingreso', imputable: true, padre: '4.1', rol: 'ventas_servicios' },
  { codigo: '4.1.03', nombre: '(−) Devoluciones de repuestos', tipo: 'ingreso', imputable: true, padre: '4.1', rol: 'devol_repuestos', contra: true },
  { codigo: '4.1.04', nombre: '(−) Devoluciones y bonificaciones de servicios', tipo: 'ingreso', imputable: true, padre: '4.1', rol: 'devol_servicios', contra: true },
  { codigo: '4.2', nombre: 'Otros ingresos', tipo: 'ingreso', imputable: false, padre: '4' },
  { codigo: '4.2.01', nombre: 'Otros ingresos', tipo: 'ingreso', imputable: true, padre: '4.2', rol: 'otros_ingresos' },
  { codigo: '4.2.02', nombre: 'Intereses y otros ingresos bancarios', tipo: 'ingreso', imputable: true, padre: '4.2', rol: 'ingresos_bancarios' },
  { codigo: '4.2.03', nombre: 'Bonificaciones y devoluciones de proveedores', tipo: 'ingreso', imputable: true, padre: '4.2', rol: 'bonif_proveedores' },
  { codigo: '5', nombre: 'COSTOS', tipo: 'costo', imputable: false },
  { codigo: '5.1', nombre: 'Costo de ventas', tipo: 'costo', imputable: false, padre: '5' },
  { codigo: '5.1.01', nombre: 'Costo de repuestos vendidos', tipo: 'costo', imputable: true, padre: '5.1', rol: 'costo_repuestos' },
  { codigo: '5.2', nombre: 'Costo de mano de obra', tipo: 'costo', imputable: false, padre: '5' },
  { codigo: '5.2.01', nombre: 'Sueldos y jornales del personal (registrados como gasto)', tipo: 'costo', imputable: true, padre: '5.2', rol: 'costo_mano_obra', notas: 'Lo que el taller efectivamente pagó como sueldos y jornales. No es la liquidación de sueldos.' },
  { codigo: '6', nombre: 'GASTOS', tipo: 'gasto', imputable: false },
  { codigo: '6.1', nombre: 'Gastos operativos y de estructura', tipo: 'gasto', imputable: false, padre: '6' },
  { codigo: '6.1.01', nombre: 'Alquileres', tipo: 'gasto', imputable: true, padre: '6.1', rol: 'gasto_alquileres' },
  { codigo: '6.1.02', nombre: 'Servicios (luz, agua, internet)', tipo: 'gasto', imputable: true, padre: '6.1', rol: 'gasto_servicios' },
  { codigo: '6.1.03', nombre: 'Impuestos y tasas', tipo: 'gasto', imputable: true, padre: '6.1', rol: 'gasto_impuestos' },
  { codigo: '6.1.04', nombre: 'Insumos de taller', tipo: 'gasto', imputable: true, padre: '6.1', rol: 'gasto_insumos' },
  { codigo: '6.1.05', nombre: 'Herramientas y equipos', tipo: 'gasto', imputable: true, padre: '6.1', rol: 'gasto_herramientas' },
  { codigo: '6.1.06', nombre: 'Mantenimiento y limpieza', tipo: 'gasto', imputable: true, padre: '6.1', rol: 'gasto_mantenimiento' },
  { codigo: '6.1.07', nombre: 'Combustible y fletes', tipo: 'gasto', imputable: true, padre: '6.1', rol: 'gasto_combustible' },
  { codigo: '6.1.08', nombre: 'Publicidad', tipo: 'gasto', imputable: true, padre: '6.1', rol: 'gasto_publicidad' },
  { codigo: '6.1.09', nombre: 'Gastos varios', tipo: 'gasto', imputable: true, padre: '6.1', rol: 'gasto_varios' },
  { codigo: '6.1.10', nombre: 'Compras de bienes y servicios sin stock', tipo: 'gasto', imputable: true, padre: '6.1', rol: 'compras_sin_stock', notas: 'Facturas de proveedores que no corresponden a mercadería recibida ni a una compra de repuestos.' },
  { codigo: '6.2', nombre: 'Gastos financieros, comerciales y diferencias', tipo: 'gasto', imputable: false, padre: '6' },
  { codigo: '6.2.01', nombre: 'Gastos y comisiones bancarias', tipo: 'gasto', imputable: true, padre: '6.2', rol: 'gastos_bancarios' },
  { codigo: '6.2.02', nombre: 'Costos comerciales (comisiones, descuentos)', tipo: 'gasto', imputable: true, padre: '6.2', rol: 'costos_comerciales' },
  { codigo: '6.2.03', nombre: 'Diferencias de inventario (mermas, roturas, sobrantes)', tipo: 'gasto', imputable: true, padre: '6.2', rol: 'diferencias_inventario' },
];

/** Rubro bajo el cual se crean las cuentas contables de las cuentas bancarias. */
export const RUBRO_BANCOS = '1.1.03';

const sinAcentos = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Cuenta de gasto que corresponde a una categoría de gasto cuando el taller no eligió una (por nombre y, si no, por tipo). */
export function rolDeGasto(nombre: string, tipo: string): RolCuenta {
  const n = sinAcentos(nombre);
  if (/alquiler/.test(n)) return 'gasto_alquileres';
  if (/sueldo|jornal|salario/.test(n)) return 'costo_mano_obra';
  if (/servicio|luz|agua|internet|telefon/.test(n)) return 'gasto_servicios';
  if (/impuesto|tasa|tribut/.test(n)) return 'gasto_impuestos';
  if (/insumo/.test(n)) return 'gasto_insumos';
  if (/herramienta|equipo/.test(n)) return 'gasto_herramientas';
  if (/mantenimiento|limpieza/.test(n)) return 'gasto_mantenimiento';
  if (/combustible|flete/.test(n)) return 'gasto_combustible';
  if (/publicidad|marketing/.test(n)) return 'gasto_publicidad';
  if (tipo === 'impuestos') return 'gasto_impuestos';
  return 'gasto_varios';
}

// ───────────────────────── Orígenes de los asientos ─────────────────────────
export const ORIGEN_LABEL: Record<string, string> = {
  manual: 'Asiento manual',
  venta: 'Venta (comprobante interno)',
  cobro: 'Cobro',
  credito_aplicacion: 'Aplicación de saldo a favor',
  devolucion: 'Devolución (nota de crédito interna)',
  reintegro: 'Reintegro a cliente',
  compra: 'Compra',
  recepcion: 'Recepción de mercadería',
  factura_proveedor: 'Factura de proveedor',
  pago_proveedor: 'Pago a proveedor',
  gasto: 'Gasto',
  caja_manual: 'Movimiento manual de caja',
  banco_mov: 'Movimiento bancario',
  stock_ajuste: 'Ajuste de inventario',
  apertura_banco: 'Saldo inicial de cuenta bancaria',
  apertura_caja: 'Saldo inicial de caja',
};

export const ESTADO_ASIENTO_LABEL: Record<string, string> = { borrador: 'Borrador', registrado: 'Registrado', revertido: 'Revertido' };

// ───────────────────────── Utilidades puras ─────────────────────────
export interface LineaNum {
  debe: number;
  haber: number;
}

/** Diferencia Debe − Haber de un conjunto de líneas (0 = balanceado). */
export const diferenciaAsiento = (lineas: readonly LineaNum[]): number => lineas.reduce((a, l) => a + l.debe - l.haber, 0);

/** Saldo en el sentido natural de la cuenta (positivo = saldo normal). */
export const saldoNatural = (naturaleza: Naturaleza, debe: number, haber: number): number => (naturaleza === 'deudora' ? debe - haber : haber - debe);

/** Valida el código de una cuenta: dígitos separados por puntos. */
export const codigoCuentaValido = (c: string): boolean => /^[0-9]+(\.[0-9]+)*$/.test(c) && c.length <= 24;

/** Valida y normaliza las líneas de un asiento manual: importes enteros positivos de un solo lado. Devuelve el error o null. */
export function validarLineas(lineas: ReadonlyArray<{ debe: number; haber: number; cuenta_id?: string }>): string | null {
  if (lineas.length < 2) return 'El asiento necesita al menos dos líneas';
  for (const l of lineas) {
    if (!Number.isInteger(l.debe) || !Number.isInteger(l.haber) || l.debe < 0 || l.haber < 0) return 'Los importes deben ser positivos y en centavos exactos';
    if ((l.debe > 0) === (l.haber > 0)) return 'Cada línea debe tener importe en el Debe o en el Haber (no en ambos ni en ninguno)';
  }
  const dif = diferenciaAsiento(lineas);
  if (dif !== 0) return `El asiento no balancea: el Debe y el Haber difieren en ${(Math.abs(dif) / 100).toFixed(2).replace('.', ',')}`;
  return null;
}
