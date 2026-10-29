// Mensaje de WhatsApp del presupuesto. Sólo usa datos que existen: lo que falta (cliente, vehículo, patente, validez, importe)
// simplemente no aparece, sin dejar líneas vacías. El importe y la fecha llegan ya formateados.
export interface DatosMensajePresupuesto {
  taller?: string | null;
  cliente?: string | null;
  /** Marca y modelo, ya unidos (p. ej. «Volkswagen Amarok»). */
  vehiculo?: string | null;
  patente?: string | null;
  /** Número ya formateado (p. ej. «0042»). */
  numero: string;
  /** Importe total ya formateado; vacío si la persona no puede verlo. */
  total?: string | null;
  /** Fecha de vencimiento ya formateada; sólo si el presupuesto tiene validez configurada. */
  validez?: string | null;
}

const limpio = (v?: string | null) => v?.trim() || '';

export function mensajePresupuestoWhatsApp(d: DatosMensajePresupuesto): string {
  const taller = limpio(d.taller);
  const cliente = limpio(d.cliente);
  const vehiculo = limpio(d.vehiculo);
  const patente = limpio(d.patente);
  const total = limpio(d.total);
  const validez = limpio(d.validez);
  const detalle = [
    vehiculo && `🚗 Vehículo: ${vehiculo}`,
    patente && `🔢 Patente: ${patente}`,
    `📋 Presupuesto: #${d.numero}`,
    total && `💰 Importe total: ${total}`,
    validez && `📅 Validez: ${validez}`,
  ].filter(Boolean);
  const bloques = [
    taller && `🔧 ${taller}`,
    `¡Hola${cliente ? `, ${cliente}` : ''}! 👋\nTe compartimos el presupuesto para tu vehículo:`,
    detalle.join('\n'),
    'Si estás de acuerdo con el presupuesto o tenés alguna consulta, podés responder directamente a este mensaje.',
    '¡Muchas gracias por confiar en nosotros!',
  ].filter(Boolean);
  return bloques.join('\n\n');
}
