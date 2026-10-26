import { describe, expect, it } from 'vitest';
import { URL_PUBLICA_OFICIAL, urlPublica } from '../../worker/lib/url-publica';

describe('urlPublica', () => {
  it('en desarrollo local usa el origen de la solicitud', () => {
    expect(urlPublica('http://127.0.0.1:8787/api/x', {})).toBe('http://127.0.0.1:8787');
    expect(urlPublica('http://localhost:5173/api/x', {})).toBe('http://localhost:5173');
  });
  it('en producción usa siempre el dominio oficial, entre por donde entre', () => {
    expect(urlPublica('https://taller-mecanico.estrubia455.workers.dev/api/x', {})).toBe(URL_PUBLICA_OFICIAL);
    expect(urlPublica('https://taller.orvelan.com.ar/api/x', {})).toBe('https://taller.orvelan.com.ar');
  });
  it('URL_PUBLICA lo reemplaza y se normaliza la barra final', () => {
    expect(urlPublica('https://a.b/api', { URL_PUBLICA: 'https://otro.example/' })).toBe('https://otro.example');
  });
});
