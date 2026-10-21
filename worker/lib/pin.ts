// PIN personal del reloj compartido. Se guarda con el mismo hash salado (PBKDF2) que las contraseñas.
// Un PIN corto tiene poco espacio de búsqueda: la defensa real son el bloqueo por intentos y el límite por dispositivo.
import { z } from 'zod';
import { badRequest } from './http';

export const zPin = z.string().regex(/^\d{4,8}$/, 'El PIN debe tener entre 4 y 8 dígitos');

/** Rechaza PIN triviales (0000, 1234, 4321...). */
export function validarPinSeguro(pin: string) {
  const asc = '01234567890123456789';
  const desc = '98765432109876543210';
  if (/^(\d)\1+$/.test(pin) || asc.includes(pin) || desc.includes(pin)) throw badRequest('Elegí un PIN menos obvio (evitá repetir dígitos o usar secuencias)');
}

export const PIN_MAX_INTENTOS = 5;
export const PIN_BLOQUEO_MIN = 15;
