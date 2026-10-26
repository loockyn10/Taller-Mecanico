import type { Env } from '../env';

/** Dirección pública oficial de ORVELAN Taller Mecánico. Los enlaces que se entregan a terceros (seguimiento, invitaciones, QR) parten de acá. */
export const URL_PUBLICA_OFICIAL = 'https://taller.orvelan.com.ar';

const esLocal = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');

/**
 * Origen con el que se construyen enlaces absolutos. En producción es siempre el dominio oficial (aunque la solicitud llegue por la dirección
 * `workers.dev` anterior, que sigue funcionando); en desarrollo local y pruebas es el origen de la propia solicitud.
 * `URL_PUBLICA` (variable del Worker) permite cambiarlo sin tocar código.
 */
export function urlPublica(reqUrl: string, env: Pick<Env, 'URL_PUBLICA'>): string {
  const u = new URL(reqUrl);
  if (esLocal(u.hostname)) return u.origin;
  return (env.URL_PUBLICA || URL_PUBLICA_OFICIAL).replace(/\/+$/, '');
}
