import { describe, expect, it } from 'vitest';
import { limpiarMensaje, normalizarRuta } from '../../worker/lib/observabilidad';

describe('errores del Worker sin datos personales', () => {
  it('agrupa rutas quitando ids y números', () => {
    expect(normalizarRuta('/api/ventas/8f3c2a1e-1234-4abc-9def-0123456789ab/anular')).toBe('/api/ventas/:id/anular');
    expect(normalizarRuta('/api/clientes/123')).toBe('/api/clientes/:n');
    expect(normalizarRuta('/api/contabilidad/asientos/abcdefghijklmnopqrstuvwxyz0123/registrar')).toBe('/api/contabilidad/asientos/:id/registrar');
  });

  it('el mensaje no conserva correos, números largos ni valores entre comillas', () => {
    const m = limpiarMensaje("D1_ERROR: UNIQUE constraint failed: clientes.email = 'juan.perez@correo.com' documento 20123456789 \"Juan Pérez\"");
    expect(m).not.toContain('juan.perez@correo.com');
    expect(m).not.toContain('20123456789');
    expect(m).not.toContain('Juan Pérez');
    expect(m).toContain('UNIQUE constraint failed');
    expect(limpiarMensaje('x'.repeat(1000)).length).toBeLessThanOrEqual(300);
  });
});
