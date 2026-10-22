// Cliente HTTP mínimo con manejo de cookie de sesión, para las pruebas de integración.
import fs from 'node:fs';
import path from 'node:path';
import { PLATFORM_TOKEN, PUERTO } from './global-setup';

const BASE = `http://127.0.0.1:${PUERTO}`;

export interface Resp<T = any> {
  status: number;
  body: T;
}

// Cada cliente de prueba se presenta con su propio origen (cf-connecting-ip), como llegaría cada navegador por Cloudflare: así los límites de intentos por origen
// del inicio de sesión no se acumulan entre pruebas que no tienen nada que ver.
let ipN = 0;

export class Api {
  cookie = '';
  ip = `10.${Math.floor(++ipN / 65025) % 250}.${Math.floor(ipN / 255) % 255}.${(ipN % 255) + 1}`;

  async req<T = any>(method: string, path: string, data?: unknown, headers: Record<string, string> = {}): Promise<Resp<T>> {
    const r = await fetch(BASE + path, {
      method,
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': this.ip, ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
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

let nu = 0;
/** Crea un usuario del rol indicado en el taller del propietario `owner` y devuelve su sesión (el taller debe tener cupo de licencia). */
export async function nuevoUsuario(owner: Api, rol: 'administrador' | 'empleado' | 'recepcion' | 'mecanico' | 'deposito' | 'caja') {
  nu++;
  const email = `${rol}${nu}-${Date.now()}@test.local`;
  const r = await owner.post('/api/taller/usuarios', { nombre: `${rol} ${nu}`, email, rol, password: 'clave-segura-1' });
  if (r.status !== 201) throw new Error(`alta de usuario falló: ${JSON.stringify(r.body)}`);
  return Api.login(email, 'clave-segura-1');
}

/** Fecha comercial argentina (la API usa UTC-3 para las fechas de negocio). */
export const hoyAR = (offsetDias = 0) => new Date(Date.now() - 3 * 3600_000 + offsetDias * 86400_000).toISOString().slice(0, 10);

/** Venta de mostrador a cuenta corriente: genera un comprobante con saldo para cobrar. */
export async function ventaConSaldo(api: Api, clienteId: string, total = 100000) {
  const r = await api.post('/api/ventas', { cliente_id: clienteId, condicion: 'cuenta_corriente', items: [{ tipo: 'libre', descripcion: 'Trabajo', cantidad: 1, precio_unitario: total }], idem_key: idem() });
  if (r.status !== 201) throw new Error(`venta falló: ${JSON.stringify(r.body)}`);
  return r.body;
}

/** Crea una persona del personal con el rol (plantilla) indicado y devuelve su sesión, su id y su correo. */
export async function nuevoPersonal(owner: Api, rol: string, extra: Record<string, unknown> = {}) {
  nu++;
  const email = `${rol}${nu}-${Date.now()}@test.local`;
  const r = await owner.post('/api/taller/usuarios', { nombre: `${rol} ${nu}`, email, rol, password: 'clave-segura-1', ...extra });
  if (r.status !== 201) throw new Error(`alta de personal falló: ${JSON.stringify(r.body)}`);
  return { api: await Api.login(email, 'clave-segura-1'), id: r.body.id as string, email };
}

export const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Ejecuta SQL directamente sobre la base LOCAL de ensayo (la carpeta temporal que levantó global-setup). Solo para preparar situaciones que la API
 * no permite crear (por ejemplo, una invitación ya vencida). Nunca apunta a una base remota.
 */
export async function sqlLocal(sql: string): Promise<void> {
  const estado = process.env.FIERRO_TEST_ESTADO;
  if (!estado) throw new Error('No hay base local de ensayo');
  const dir = path.join(estado, 'v3', 'd1', 'miniflare-D1DatabaseObject');
  const archivo = fs.readdirSync(dir).find((f) => f.endsWith('.sqlite'));
  if (!archivo) throw new Error('No se encontró la base local de ensayo');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dir, archivo));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(sql);
  } finally {
    db.close();
  }
}

/** Lee filas de la base LOCAL de ensayo (ver sqlLocal). */
export async function consultaLocal<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const estado = process.env.FIERRO_TEST_ESTADO;
  if (!estado) throw new Error('No hay base local de ensayo');
  const dir = path.join(estado, 'v3', 'd1', 'miniflare-D1DatabaseObject');
  const archivo = fs.readdirSync(dir).find((f) => f.endsWith('.sqlite'));
  if (!archivo) throw new Error('No se encontró la base local de ensayo');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dir, archivo), { readOnly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}
