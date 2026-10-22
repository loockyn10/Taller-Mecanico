// Sprint 13: observabilidad mínima. Salud de plataforma, aviso del respaldo externo, mantenimiento periódico y errores sin datos personales.
import { describe, expect, it } from 'vitest';
import { Api, consultaLocal, nuevoTaller, platformHeaders } from './cliente';
import { BACKUP_TOKEN } from './global-setup';

const salud = async () => (await new Api().req('GET', '/api/platform/salud', undefined, platformHeaders)).body;
const aviso = (cuerpo: unknown, token = BACKUP_TOKEN) => new Api().req('POST', '/api/plataforma/respaldo-latido', cuerpo, { authorization: `Bearer ${token}` });

describe('salud de la plataforma', () => {
  it('exige el token de plataforma y no se muestra a un usuario común', async () => {
    const t = await nuevoTaller('Taller Salud');
    expect((await new Api().get('/api/platform/salud')).status).toBe(401);
    expect((await t.api.get('/api/platform/salud')).status).toBe(401);
  });

  it('informa mantenimiento, cola contable, seguridad, errores y respaldo en un solo vistazo', async () => {
    await new Api().req('POST', '/api/platform/mantenimiento', {}, platformHeaders);
    const s = await salud();
    expect(s.mantenimiento).toMatchObject({ ok: true, atrasado: false });
    expect(s.contabilidad).toEqual(expect.objectContaining({ talleres_activados: expect.any(Number), cola_pendiente: expect.any(Number), cola_fallida: expect.any(Number) }));
    expect(s.seguridad).toEqual(expect.objectContaining({ ultimas_24h: expect.any(Object), bloqueos_vigentes: expect.any(Number) }));
    expect(s.errores_worker).toEqual(expect.objectContaining({ problemas_24h: expect.any(Number), recientes: expect.any(Array) }));
    expect(Array.isArray(s.alertas)).toBe(true);
  });

  it('sin aviso de respaldo externo lo advierte; no afirma que haya respaldos que nunca llegaron', async () => {
    await consultaLocal('SELECT 1'); // la base de ensayo existe
    const s = await salud();
    if (!s.respaldo_externo.ultimo_at) expect(s.alertas.join(' | ')).toContain('Nunca se recibió aviso de un respaldo externo');
  });
});

describe('aviso del respaldo externo (GitHub Actions)', () => {
  it('sin token o con un token ajeno (incluido el de plataforma) se rechaza', async () => {
    expect((await new Api().req('POST', '/api/plataforma/respaldo-latido', { ok: true })).status).toBe(401);
    expect((await aviso({ ok: true }, 'token-incorrecto-incorrecto')).status).toBe(401);
    expect((await aviso({ ok: true }, 'token-de-pruebas-de-plataforma-123')).status).toBe(401); // el token de plataforma NO sirve acá
  });

  it('un aviso correcto queda registrado y la salud lo muestra al día', async () => {
    const r = await aviso({ ok: true, sha256: 'a'.repeat(64), bytes: 1234, tablas: 98, filas: 4000, talleres: 3, etiqueta: '20261022T061700Z' });
    expect(r.status).toBe(200);
    const s = await salud();
    expect(s.respaldo_externo).toMatchObject({ ok: true, atrasado: false });
    expect(s.respaldo_externo.detalle).toMatchObject({ tablas: 98, talleres: 3 });
    expect(s.alertas.join(' | ')).not.toContain('respaldo externo');
  });

  it('un aviso de fallo se convierte en alerta, y datos inválidos se rechazan', async () => {
    expect((await aviso({ ok: false, error: 'La exportación de la D1 falló para juan@correo.com con clave 123456789' })).status).toBe(200);
    const s = await salud();
    expect(s.respaldo_externo.ok).toBe(false);
    expect(s.alertas.join(' | ')).toContain('El último respaldo externo informó un error');
    expect(JSON.stringify(s.respaldo_externo.detalle)).not.toContain('juan@correo.com'); // el mensaje se depura
    expect((await aviso({ ok: 'si' })).status).toBe(400);
    expect((await aviso({ ok: true, sha256: 'no-es-un-hash' })).status).toBe(400);
    await aviso({ ok: true }); // deja el estado sano para las demás pruebas
  });
});

describe('mantenimiento periódico', () => {
  it('es idempotente y deja su latido', async () => {
    const a = await new Api().req('POST', '/api/platform/mantenimiento', {}, platformHeaders);
    const b = await new Api().req('POST', '/api/platform/mantenimiento', {}, platformHeaders);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.ok).toBe(true);
    const [l] = await consultaLocal<{ ok: number }>("SELECT ok FROM plataforma_latidos WHERE clave = 'mantenimiento'");
    expect(l.ok).toBe(1);
  });

  it('exige el token de plataforma', async () => {
    expect((await new Api().req('POST', '/api/platform/mantenimiento', {})).status).toBe(401);
  });
});
