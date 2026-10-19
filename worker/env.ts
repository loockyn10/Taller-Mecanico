import type { Rol } from '../shared/permisos';

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  PLATFORM_ADMIN_TOKEN?: string;
  PBKDF2_ITERATIONS?: string;
  SESSION_DAYS?: string;
}

export interface Sesion {
  usuarioId: string;
  tallerId: string;
  rol: Rol;
  nombre: string;
  email: string;
  licenciaActiva: boolean;
}

export type AppEnv = { Bindings: Env; Variables: { sesion: Sesion } };
