// Cliente HTTP mínimo con manejo de cookie de sesión, para las pruebas de integración.
import { PLATFORM_TOKEN, PUERTO } from './global-setup';

const BASE = `http://127.0.0.1:${PUERTO}`;

export interface Resp<T = any> {
  status: number;
  body: T;
}

export class Api {
  cookie = '';

  async req<T = any>(method: string, path: string, data?: unknown, headers: Record<string, string> = {}): Promise<Resp<T>> {
    const r = await fetch(BASE + path, {
      method,
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const text = await r.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* texto plano */
    }
    return { status: r.status, body };
  }
  get<T = any>(p: string) {
    return this.req<T>('GET', p);
  }
  post<T = any>(p: string, d: unknown = {}) {
    return this.req<T>('POST', p, d);
  }
  put<T = any>(p: string, d: unknown) {
    return this.req<T>('PUT', p, d);
  }
  patch<T = any>(p: string, d: unknown) {
    return this.req<T>('PATCH', p, d);
  }
  del<T = any>(p: string) {
    return this.req<T>('DELETE', p);
  }

  static async login(email: string, password: string) {
    const a = new Api();
    const r = await a.post('/api/auth/login', { email, password });
    if (r.status !== 200) throw new Error(`login falló: ${JSON.stringify(r.body)}`);
    return a;
  }
}

export const plataforma = new Api();
export const platformHeaders = { authorization: `Bearer ${PLATFORM_TOKEN}` };

let n = 0;
/** Crea un taller nuevo vía API de plataforma y devuelve la sesión del propietario. */
export async function nuevoTaller(nombre: string, usuarios_adicionales = 0) {
  n++;
  const email = `owner${n}-${Date.now()}@test.local`;
  const r = await plataforma.req('POST', '/api/platform/talleres', { nombre, usuarios_adicionales, propietario: { nombre: `Dueño ${nombre}`, email, password: 'clave-segura-1' } }, platformHeaders);
  if (r.status !== 201) throw new Error(`alta de taller falló: ${JSON.stringify(r.body)}`);
  const api = await Api.login(email, 'clave-segura-1');
  return { api, tallerId: r.body.tallerId as string, email };
}

export const idem = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;
