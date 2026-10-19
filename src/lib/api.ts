// Cliente HTTP de la API. La sesión viaja en una cookie HttpOnly (el frontend nunca maneja el token).

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

let onNoAutenticado: (() => void) | null = null;
export function alPerderSesion(fn: () => void) {
  onNoAutenticado = fn;
}

async function req<T>(method: string, path: string, data?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  } catch {
    throw new ApiError(0, 'sin_conexion', 'No hay conexión con el servidor. Verificá tu conexión a internet.');
  }
  const texto = await r.text();
  const cuerpo = texto ? JSON.parse(texto) : null;
  if (!r.ok) {
    const e = cuerpo?.error ?? {};
    if (r.status === 401 && !path.startsWith('/auth/login')) onNoAutenticado?.();
    throw new ApiError(r.status, e.code ?? 'error', e.message ?? `Error ${r.status}`, e.details);
  }
  return cuerpo as T;
}

export const api = {
  get: <T = any>(p: string) => req<T>('GET', p),
  post: <T = any>(p: string, d: unknown = {}) => req<T>('POST', p, d),
  put: <T = any>(p: string, d: unknown) => req<T>('PUT', p, d),
  patch: <T = any>(p: string, d: unknown) => req<T>('PATCH', p, d),
  del: <T = any>(p: string) => req<T>('DELETE', p),
};

/** Construye querystring ignorando valores vacíos. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

/** Clave de idempotencia para operaciones que no deben duplicarse (cobros, ventas, movimientos). */
export const nuevaClave = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
