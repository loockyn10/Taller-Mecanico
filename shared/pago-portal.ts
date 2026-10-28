// Pago del cliente desde el portal de seguimiento (Sprint 25): constantes, estados y textos compartidos entre el servidor (página pública, API del taller) y la
// pantalla de la orden. Código puro (sin acceso a datos): se prueba aparte.
//
// Regla de fondo: elegir un medio de pago o enviar un comprobante NUNCA es un cobro. El dinero se reconoce una sola vez, cuando un administrativo confirma la
// recepción y el sistema registra (o enlaza) el cobro real del módulo financiero.

export const MEDIOS_PORTAL = ['efectivo', 'transferencia'] as const;
export type MedioPortal = (typeof MEDIOS_PORTAL)[number];
export const MEDIO_PORTAL_LABEL: Record<MedioPortal, string> = { efectivo: 'Efectivo', transferencia: 'Transferencia' };

/** Formatos de comprobante que se aceptan (por contenido, no por nombre). */
export const FORMATOS_COMPROBANTE = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export type FormatoComprobante = (typeof FORMATOS_COMPROBANTE)[number];
export const EXTENSIONES_COMPROBANTE = ['jpg', 'jpeg', 'png', 'webp', 'pdf'] as const;

export const LIMITES_COMPROBANTE = {
  /** Imágenes (capturas y fotos de teléfono). */
  imagenBytes: 8_000_000,
  pdfBytes: 5_000_000,
  /** Lado máximo de una imagen: cubre cámaras de 50 MP (no se decodifica, sólo se lee el encabezado). */
  ladoMax: 12_000,
  /** Comprobantes esperando verificación al mismo tiempo, por orden. */
  pendientesPorOrden: 3,
  /** Comprobantes recibidos en toda la vida de una orden (incluye los rechazados). */
  totalPorOrden: 12,
  /** Tope de peso acumulado de los comprobantes de una orden. */
  bytesPorOrden: 40_000_000,
  motivoMin: 3,
  motivoMax: 300,
} as const;

export type EstadoComprobante = 'subiendo' | 'pendiente' | 'confirmado' | 'rechazado';
export const ESTADO_COMPROBANTE_LABEL: Record<Exclude<EstadoComprobante, 'subiendo'>, string> = {
  pendiente: 'Pendiente de verificación',
  confirmado: 'Pago confirmado',
  rechazado: 'Rechazado',
};

/**
 * Estado del pago del cliente, separado del estado de la reparación (una OT puede estar lista para entregar y seguir pendiente de pago):
 *  pendiente_de_pago → medio_seleccionado → comprobante_recibido ⇄ comprobante_rechazado → cobro_confirmado.
 */
export type EstadoPagoCliente = 'sin_importe' | 'pendiente_de_pago' | 'medio_seleccionado' | 'comprobante_recibido' | 'comprobante_rechazado' | 'cobro_confirmado';

export const ESTADO_PAGO_LABEL: Record<EstadoPagoCliente, string> = {
  sin_importe: 'Importe sin informar al cliente',
  pendiente_de_pago: 'Pendiente de pago',
  medio_seleccionado: 'Medio de pago seleccionado',
  comprobante_recibido: 'Comprobante pendiente de verificación',
  comprobante_rechazado: 'Comprobante rechazado',
  cobro_confirmado: 'Cobro confirmado',
};

export interface EntradaEstadoPago {
  /** El importe puede comunicarse al cliente (informado por el taller o con comprobante emitido) y es mayor que cero. */
  importeConfirmado: boolean;
  total: number;
  pendiente: number;
  abonado: number;
  eleccion: { medio: MedioPortal; estado: 'seleccionado' | 'confirmado'; at: string } | null;
  comprobantes: ReadonlyArray<{ estado: EstadoComprobante; at: string }>;
}

export function estadoPagoCliente(e: EntradaEstadoPago): EstadoPagoCliente {
  if (e.total > 0 && e.pendiente <= 0 && e.abonado > 0) return 'cobro_confirmado';
  if (!e.importeConfirmado) return 'sin_importe';
  if (e.comprobantes.some((c) => c.estado === 'pendiente')) return 'comprobante_recibido';
  const ultimo = [...e.comprobantes].filter((c) => c.estado !== 'subiendo').sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  // Un rechazo sólo manda mientras no haya una elección posterior (si el cliente volvió a elegir, parte de ahí).
  if (ultimo?.estado === 'rechazado' && (!e.eleccion || ultimo.at >= e.eleccion.at)) return 'comprobante_rechazado';
  if (e.eleccion) return 'medio_seleccionado';
  return 'pendiente_de_pago';
}

/** Detalle del estado para el personal, según el medio elegido («Pago previsto en efectivo», «Pendiente de cobro»…). */
export function detallePagoCliente(estado: EstadoPagoCliente, eleccion: EntradaEstadoPago['eleccion']): string {
  if (estado === 'medio_seleccionado' && eleccion?.medio === 'efectivo') return eleccion.estado === 'confirmado' ? 'Pago previsto en efectivo · Pendiente de cobro' : 'Eligió efectivo, todavía no confirmó';
  if (estado === 'medio_seleccionado' && eleccion?.medio === 'transferencia') return 'Eligió transferencia, todavía no envió el comprobante';
  return ESTADO_PAGO_LABEL[estado];
}

/** Importe en pesos para el cliente: «$285.000» (con centavos sólo si los hay: «$285.000,50»). Los importes se guardan en centavos. */
export function dineroAR(centavos: number): string {
  const neg = centavos < 0;
  const abs = Math.abs(Math.round(centavos));
  const pesos = Math.floor(abs / 100);
  const cent = abs % 100;
  const miles = String(pesos).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${neg ? '-' : ''}$${miles}${cent ? `,${String(cent).padStart(2, '0')}` : ''}`;
}

/** Nombre de archivo depurado para MOSTRAR (nunca para armar rutas): sin directorios, sin caracteres de control ni marcas de dirección de texto. */
export function nombreVisible(nombre: unknown): string | null {
  if (typeof nombre !== 'string') return null;
  const base = nombre.split(/[\\/]/).pop() ?? '';
  const limpio = base.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return limpio || null;
}

/** Extensión (en minúsculas) de un nombre de archivo, o null si no tiene. */
export function extensionDe(nombre: string | null | undefined): string | null {
  const m = /\.([A-Za-z0-9]{1,6})$/.exec(nombre ?? '');
  return m ? m[1].toLowerCase() : null;
}
