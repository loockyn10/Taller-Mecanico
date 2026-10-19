// Hash de contraseñas con PBKDF2-SHA256 (WebCrypto, disponible en Workers).
// Formato almacenado: pbkdf2$<iteraciones>$<salt b64>$<hash b64>, para poder subir iteraciones sin migrar.

const enc = new TextEncoder();

function b64(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
}
function deb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function derivar(password: string, salt: Uint8Array, iteraciones: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iteraciones }, key, 256);
}

export async function hashPassword(password: string, iteraciones = 100_000): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivar(password, salt, iteraciones);
  return `pbkdf2$${iteraciones}$${b64(salt)}$${b64(hash)}`;
}

export async function verificarPassword(password: string, almacenado: string): Promise<boolean> {
  const [alg, it, salt, hash] = almacenado.split('$');
  if (alg !== 'pbkdf2' || !it || !salt || !hash) return false;
  const calculado = new Uint8Array(await derivar(password, deb64(salt), Number(it)));
  const esperado = deb64(hash);
  if (calculado.length !== esperado.length) return false;
  let diff = 0;
  for (let i = 0; i < calculado.length; i++) diff |= calculado[i] ^ esperado[i];
  return diff === 0;
}

export function tokenAleatorio(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Comparación en tiempo constante de strings (tokens). */
export function igualSeguro(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
