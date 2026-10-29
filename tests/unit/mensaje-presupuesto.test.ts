// Mensaje de WhatsApp del presupuesto: datos reales y sin líneas vacías cuando falta algo.
import { describe, expect, it } from 'vitest';
import { mensajePresupuestoWhatsApp } from '../../shared/mensaje-presupuesto';
import { formatoMoneda } from '../../shared/totals';

describe('mensaje de WhatsApp del presupuesto', () => {
  it('completo: taller, cliente, vehículo, patente, número, importe y validez', () => {
    const m = mensajePresupuestoWhatsApp({ taller: 'Mecánica Sur', cliente: 'Juan Pérez', vehiculo: 'Volkswagen Amarok', patente: 'AB123CD', numero: '0042', total: formatoMoneda(15075000), validez: '15/11/2026' });
    expect(m).toBe(
      [
        '🔧 Mecánica Sur',
        '¡Hola, Juan Pérez! 👋\nTe compartimos el presupuesto para tu vehículo:',
        '🚗 Vehículo: Volkswagen Amarok\n🔢 Patente: AB123CD\n📋 Presupuesto: #0042\n💰 Importe total: ' + formatoMoneda(15075000) + '\n📅 Validez: 15/11/2026',
        'Si estás de acuerdo con el presupuesto o tenés alguna consulta, podés responder directamente a este mensaje.',
        '¡Muchas gracias por confiar en nosotros!',
      ].join('\n\n'),
    );
  });

  it('omite lo inexistente sin dejar líneas vacías ni inventar datos', () => {
    const m = mensajePresupuestoWhatsApp({ taller: ' ', cliente: '', vehiculo: '', patente: null, numero: '0007', total: null, validez: null });
    expect(m).not.toContain('🔧');
    expect(m).not.toContain('Vehículo');
    expect(m).not.toContain('Patente');
    expect(m).not.toContain('Validez');
    expect(m).not.toContain('Importe');
    expect(m).toContain('¡Hola! 👋');
    expect(m).toContain('📋 Presupuesto: #0007');
    expect(m).not.toMatch(/\n\n\n/);
    expect(m.split('\n').every((l, i, a) => l !== '' || (a[i - 1] !== '' && i > 0))).toBe(true);
  });

  it('el nombre del taller sale del taller que corresponde', () => {
    expect(mensajePresupuestoWhatsApp({ taller: 'Taller A', numero: '1' })).toContain('🔧 Taller A');
    expect(mensajePresupuestoWhatsApp({ taller: 'Taller B', numero: '1' })).toContain('🔧 Taller B');
  });
});
