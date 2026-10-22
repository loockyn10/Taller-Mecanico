// Límite de intentos fallidos con ventana y bloqueo temporal (protección contra fuerza bruta), persistido en D1.
import { ApiError } from './http';
import { ahora, first, run } from './db';

interface Fila { intentos: number; desde: string; bloqueado_hasta: string | null }

/** Lanza 429 si la clave está bloqueada. */
export async function exigirNoBloqueado(db: D1Database, clave: string, mensaje = 'Demasiados intentos. Probá de nuevo más tarde'): Promise<void> {
  const f = await first<Fila>(db, 'SELECT intentos, desde, bloqueado_hasta FROM limites_intentos WHERE clave = ?', clave);
  if (f?.bloqueado_hasta && f.bloqueado_hasta > ahora()) throw new ApiError(429, 'bloqueado', mensaje);
}

/** Registra un intento fallido; al superar `max` dentro de la ventana bloquea la clave `bloqueoMin` minutos. Devuelve los intentos que quedan. */
export async function registrarFallo(db: D1Database, clave: string, max: number, ventanaMin: number, bloqueoMin: number): Promise<number> {
  const ahoraMs = Date.now();
  const f = await first<Fila>(db, 'SELECT intentos, desde, bloqueado_hasta FROM limites_intentos WHERE clave = ?', clave);
  const vigente = f && Date.parse(f.desde) > ahoraMs - ventanaMin * 60_000;
  const intentos = vigente ? f.intentos + 1 : 1;
  const desde = vigente ? f.desde : new Date(ahoraMs).toISOString();
  const bloquear = intentos >= max;
  await run(
    db,
    `INSERT INTO limites_intentos (clave, intentos, desde, bloqueado_hasta) VALUES (?, ?, ?, ?)
     ON CONFLICT (clave) DO UPDATE SET intentos = excluded.intentos, desde = excluded.desde, bloqueado_hasta = excluded.bloqueado_hasta`,
    clave,
    bloquear ? 0 : intentos,
    desde,
    bloquear ? new Date(ahoraMs + bloqueoMin * 60_000).toISOString() : null,
  );
  // Limpieza oportunista de contadores viejos.
  // (Las marcas de "origen conocido" del inicio de sesión, `login:ok:*`, viven 30 días; el resto de los contadores, un día.)
  if (Math.random() < 0.05) {
    await run(db, "DELETE FROM limites_intentos WHERE clave NOT LIKE 'login:ok:%' AND desde < ? AND (bloqueado_hasta IS NULL OR bloqueado_hasta < ?)", new Date(ahoraMs - 86400_000).toISOString(), ahora());
    await run(db, "DELETE FROM limites_intentos WHERE clave LIKE 'login:ok:%' AND desde < ?", new Date(ahoraMs - 31 * 86400_000).toISOString());
  }
  return bloquear ? 0 : max - intentos;
}

export async function limpiarFallos(db: D1Database, clave: string): Promise<void> {
  await run(db, 'DELETE FROM limites_intentos WHERE clave = ?', clave);
}
