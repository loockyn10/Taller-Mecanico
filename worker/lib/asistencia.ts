// Fichaje de entrada y salida. La hora la fija SIEMPRE el servidor. Lo usan la app (sesión) y el reloj compartido (dispositivo + PIN).
import { conflict } from './http';
import { first, run, uid } from './db';
import { fechaLocal, zonaDelTaller } from './zona';

/** Separación mínima entre dos fichajes de la misma persona (protege de toques dobles y solicitudes repetidas). */
export const MIN_ENTRE_FICHAJES_SEG = 3;
/** A partir de esta duración una jornada abierta se considera olvidada y se destaca en el panel. */
export const JORNADA_LARGA_SEG = 16 * 3600;

export type OrigenFichaje = 'app' | 'reloj' | 'manual';

export interface Jornada {
  id: string;
  usuario_id: string;
  fecha: string;
  entrada_at: string;
  salida_at: string | null;
  duracion_seg: number | null;
  origen_entrada: OrigenFichaje;
  origen_salida: OrigenFichaje | null;
  corregido: number;
  anulado: number;
}

const COLS = 'id, usuario_id, fecha, entrada_at, salida_at, duracion_seg, origen_entrada, origen_salida, corregido, anulado';

export const jornadaAbierta = (db: D1Database, tallerId: string, usuarioId: string) =>
  first<Jornada>(db, `SELECT ${COLS} FROM asistencias WHERE taller_id = ? AND usuario_id = ? AND salida_at IS NULL AND anulado = 0`, tallerId, usuarioId);

export async function registrarEntrada(db: D1Database, tallerId: string, usuarioId: string, origen: 'app' | 'reloj', dispositivoId: string | null = null): Promise<Jornada> {
  const ahora = new Date();
  const abierta = await jornadaAbierta(db, tallerId, usuarioId);
  if (abierta) throw conflict('Ya tenés una jornada abierta: registrá primero la salida', 'jornada_abierta');
  const ultima = await first<{ salida_at: string }>(db, 'SELECT salida_at FROM asistencias WHERE taller_id = ? AND usuario_id = ? AND anulado = 0 AND salida_at IS NOT NULL ORDER BY salida_at DESC LIMIT 1', tallerId, usuarioId);
  if (ultima && ahora.getTime() - Date.parse(ultima.salida_at) < MIN_ENTRE_FICHAJES_SEG * 1000) throw conflict('Acabás de registrar tu salida', 'fichaje_reciente');
  const id = uid();
  const zona = await zonaDelTaller(db, tallerId);
  try {
    await run(
      db,
      'INSERT INTO asistencias (id, taller_id, usuario_id, fecha, entrada_at, origen_entrada, dispositivo_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, tallerId, usuarioId, fechaLocal(ahora, zona), ahora.toISOString(), origen, dispositivoId,
    );
  } catch (e) {
    // Dos solicitudes simultáneas: el índice único de jornada abierta deja pasar solo una.
    if (String(e).includes('UNIQUE')) throw conflict('Ya tenés una jornada abierta: registrá primero la salida', 'jornada_abierta');
    throw e;
  }
  return (await first<Jornada>(db, `SELECT ${COLS} FROM asistencias WHERE taller_id = ? AND id = ?`, tallerId, id))!;
}

export async function registrarSalida(db: D1Database, tallerId: string, usuarioId: string, origen: 'app' | 'reloj', dispositivoId: string | null = null): Promise<Jornada> {
  const ahora = new Date();
  const abierta = await jornadaAbierta(db, tallerId, usuarioId);
  if (!abierta) throw conflict('No tenés una jornada abierta: registrá primero la entrada', 'sin_jornada');
  if (ahora.getTime() - Date.parse(abierta.entrada_at) < MIN_ENTRE_FICHAJES_SEG * 1000) throw conflict('Acabás de registrar tu entrada', 'fichaje_reciente');
  const seg = Math.max(0, Math.floor((ahora.getTime() - Date.parse(abierta.entrada_at)) / 1000));
  // La condición salida_at IS NULL hace que una segunda solicitud simultánea no cierre dos veces la misma jornada.
  const r = await run(
    db,
    'UPDATE asistencias SET salida_at = ?, duracion_seg = ?, origen_salida = ?, dispositivo_id = COALESCE(?, dispositivo_id) WHERE taller_id = ? AND id = ? AND salida_at IS NULL AND anulado = 0',
    ahora.toISOString(), seg, origen, dispositivoId, tallerId, abierta.id,
  );
  if (!r.meta.changes) throw conflict('No tenés una jornada abierta: registrá primero la entrada', 'sin_jornada');
  return (await first<Jornada>(db, `SELECT ${COLS} FROM asistencias WHERE taller_id = ? AND id = ?`, tallerId, abierta.id))!;
}
