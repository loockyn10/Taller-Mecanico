// Mensaje de WhatsApp al cliente por su orden de trabajo: una sola redacción para avisar que el vehículo ingresó y darle el enlace de seguimiento.
// Sólo usa datos que existen: lo que falta (nombre, marca y modelo, enlace) simplemente no aparece.
export interface DatosMensajeOrden {
  cliente?: string | null;
  /** Marca y modelo, ya unidos (p. ej. «Volkswagen Amarok»). */
  vehiculo?: string | null;
  patente: string;
  numero: number;
  taller?: string | null;
  /** Enlace de seguimiento; si el seguimiento no está disponible, el mensaje sale sin esa parte. */
  url?: string | null;
  /** Con la orden lista se avisa que puede retirarlo en lugar de que ingresó. */
  listo?: boolean;
}

export function mensajeOrdenWhatsApp(d: DatosMensajeOrden): string {
  const cliente = d.cliente?.trim();
  const taller = d.taller?.trim();
  const veh = d.vehiculo?.trim();
  const sujeto = `tu vehículo${veh ? ` ${veh}` : ''}, patente ${d.patente}`;
  const partes = [
    `Hola${cliente ? `, ${cliente}` : ''}.`,
    d.listo
      ? `Te informamos que ${sujeto}, ya está listo para retirar${taller ? ` en ${taller}` : ''}.`
      : `Te informamos que ${sujeto}, ingresó correctamente a nuestro taller${taller ? `, ${taller}` : ''}.`,
    `Orden de trabajo N.º ${String(d.numero).padStart(4, '0')}.`,
  ];
  if (d.url) partes.push(`Podés consultar el estado de la reparación en cualquier momento desde el siguiente enlace:\n${d.url}`);
  partes.push('Muchas gracias.');
  return partes.join('\n\n');
}
