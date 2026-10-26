// Mensaje de WhatsApp de la orden: datos reales, enlace sólo cuando existe y nada de lo que falta.
import { describe, expect, it } from 'vitest';
import { mensajeOrdenWhatsApp } from '../../shared/mensaje-ingreso';

const URL = 'https://taller.example/seguimiento/abc';

describe('mensaje de WhatsApp de la orden', () => {
  it('lleva el nombre, el vehículo, la patente, el número, el taller y el enlace', () => {
    const m = mensajeOrdenWhatsApp({ cliente: 'Juan', vehiculo: 'Volkswagen Amarok', patente: 'AB123CD', numero: 148, taller: 'Mecánica Sur', url: URL });
    expect(m).toBe(
      [
        'Hola, Juan.',
        'Te informamos que tu vehículo Volkswagen Amarok, patente AB123CD, ingresó correctamente a nuestro taller, Mecánica Sur.',
        'Orden de trabajo N.º 0148.',
        `Podés consultar el estado de la reparación en cualquier momento desde el siguiente enlace:\n${URL}`,
        'Muchas gracias.',
      ].join('\n\n'),
    );
  });

  it('sin enlace (seguimiento desactivado o sin permiso) no promete un enlace', () => {
    const m = mensajeOrdenWhatsApp({ cliente: 'Juan', patente: 'AB123CD', numero: 7, url: null });
    expect(m).not.toContain('enlace');
    expect(m).not.toContain('http');
  });

  it('no muestra datos inexistentes: sin nombre, marca, modelo ni taller', () => {
    const m = mensajeOrdenWhatsApp({ cliente: ' ', vehiculo: '', patente: 'AB123CD', numero: 7, taller: null, url: URL });
    expect(m).toContain('Hola.');
    expect(m).toContain('tu vehículo, patente AB123CD, ingresó correctamente a nuestro taller.');
    expect(m).not.toMatch(/undefined|null|, \./);
  });

  it('con la orden lista avisa que puede retirarlo', () => {
    const m = mensajeOrdenWhatsApp({ cliente: 'Ana', vehiculo: 'Fiat Cronos', patente: 'XY999ZZ', numero: 12, taller: 'Taller Norte', url: URL, listo: true });
    expect(m).toContain('ya está listo para retirar en Taller Norte');
    expect(m).not.toContain('ingresó');
  });
});
