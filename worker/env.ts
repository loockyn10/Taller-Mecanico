import type { Nivel, Permiso, Rol } from '../shared/permisos';

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
  /** Rol de plantilla del usuario (propietario, administrador, recepcion, mecanico, ...). */
  rol: Rol;
  /** Nivel de privilegio (propietario | administrador | empleado). */
  nivel: Nivel;
  nombre: string;
  email: string;
  /** Permisos efectivos (plantilla + ajustes individuales), calculados en cada solicitud: un cambio rige de inmediato. */
  permisos: ReadonlySet<Permiso>;
  licenciaActiva: boolean;
}

export type AppEnv = { Bindings: Env; Variables: { sesion: Sesion } };
