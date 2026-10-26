import type { Nivel, Permiso, Rol } from '../shared/permisos';

export interface Env {
  DB: D1Database;
  /** Bucket PRIVADO de R2 con las fotografías (vehículos y órdenes). Si falta, las fotos quedan deshabilitadas y el resto de ORVELAN sigue igual. */
  FIERRO_FOTOS?: R2Bucket;
  ASSETS?: Fetcher;
  PLATFORM_ADMIN_TOKEN?: string;
  PBKDF2_ITERATIONS?: string;
  SESSION_DAYS?: string;
  /** 'esperar': la contabilización posterior a cada operación se espera antes de responder (pruebas). Por defecto corre en segundo plano. */
  CONTAB_SYNC?: string;
  /** '1': cuenta consultas/filas de D1 por solicitud y las informa en cabeceras X-D1-* (SOLO pruebas de capacidad en una base aislada). */
  MEDIR_D1?: string;
  /** Secreto del aviso de respaldo externo (GitHub Actions → /api/plataforma/respaldo-latido). Distinto del token de plataforma, que puede mucho más. */
  BACKUP_REPORT_TOKEN?: string;
  /** Secreto de sólo lectura del respaldo programado de las fotografías (GitHub Actions). Sólo exporta manifiesto y archivos; no es el token de plataforma. */
  FOTOS_BACKUP_TOKEN?: string;
  /** Dirección pública para los enlaces absolutos (por defecto https://taller.orvelan.com.ar; en local se usa el origen de la solicitud). */
  URL_PUBLICA?: string;
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
