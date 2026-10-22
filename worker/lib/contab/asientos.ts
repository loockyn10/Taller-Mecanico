// Sentencias que escriben un asiento de partida doble. Todo asiento nace como borrador, recibe sus líneas y se registra en el MISMO batch:
// los triggers de la base (migración 0010) rechazan el batch completo si el asiento no balancea, tiene menos de dos líneas o usa una cuenta no imputable.
//
// Idempotencia: el índice único (taller, origen_tipo, origen_id, evento) hace que un segundo intento con el mismo documento de origen no inserte la
// cabecera; las líneas y el registro dependen de que la cabecera sea la de ESTE intento (mismo id), de modo que tampoco se duplican.
import { diferenciaAsiento } from '../../../shared/contabilidad';
import { ahora, uid, type Stmt } from '../db';

export interface LineaIn {
  cuentaId: string;
  debe: number;
  haber: number;
  detalle?: string | null;
}

export interface AsientoIn {
  id: string;
  fecha: string;
  descripcion: string;
  modo: 'manual' | 'automatico' | 'historico' | 'reversion';
  origenTipo: string;
  origenId?: string | null;
  evento?: string | null;
  /** Este asiento es el contra-asiento de otro (que debe estar registrado). */
  revierteId?: string | null;
  corrigeId?: string | null;
  motivo?: string | null;
  idemKey?: string | null;
  advertencia?: string | null;
  costoIncompleto?: boolean;
  usuarioId: string | null;
  lineas: LineaIn[];
  registrar: boolean;
}

/** Líneas por sentencia: D1 admite hasta 100 parámetros por consulta. */
const LINEAS_POR_SENTENCIA = 12;

export function sentenciasAsiento(db: D1Database, tallerId: string, a: AsientoIn): Stmt[] {
  if (a.registrar && diferenciaAsiento(a.lineas) !== 0) throw new Error(`Asiento desbalanceado (${a.descripcion})`);
  const s: Stmt[] = [];
  s.push(
    db
      .prepare(
        `INSERT OR IGNORE INTO asientos (id, taller_id, fecha, descripcion, estado, modo, origen_tipo, origen_id, evento, revierte_id, corrige_id, motivo, idem_key, advertencia, costo_incompleto, usuario_id)
         SELECT ?, ?, ?, ?, 'borrador', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE ${a.revierteId ? "EXISTS (SELECT 1 FROM asientos WHERE taller_id = ? AND id = ? AND estado = 'registrado')" : '1 = 1'}`,
      )
      .bind(
        a.id, tallerId, a.fecha, a.descripcion, a.modo, a.origenTipo, a.origenId ?? null, a.evento ?? null, a.revierteId ?? null, a.corrigeId ?? null, a.motivo ?? null,
        a.idemKey ?? null, a.advertencia ?? null, a.costoIncompleto ? 1 : 0, a.usuarioId,
        ...(a.revierteId ? [tallerId, a.revierteId] : []),
      ),
  );
  s.push(...sentenciasLineas(db, tallerId, a.id, a.lineas));
  if (a.registrar) s.push(sentenciaRegistrar(db, tallerId, a.id, a.usuarioId));
  if (a.revierteId) {
    // El original pasa a "revertido" sólo si este contra-asiento quedó registrado.
    s.push(
      db
        .prepare(
          `UPDATE asientos SET estado = 'revertido'
            WHERE taller_id = ? AND id = ? AND estado = 'registrado'
              AND EXISTS (SELECT 1 FROM asientos WHERE taller_id = ? AND id = ? AND estado = 'registrado')`,
        )
        .bind(tallerId, a.revierteId, tallerId, a.id),
    );
  }
  if (a.origenId && a.evento) {
    s.push(db.prepare('DELETE FROM contab_omitidos WHERE taller_id = ? AND origen_tipo = ? AND origen_id = ? AND evento = ?').bind(tallerId, a.origenTipo, a.origenId, a.evento));
  }
  return s;
}

/** Inserta líneas en un borrador (sólo si el asiento sigue siendo un borrador en la misma transacción). */
export function sentenciasLineas(db: D1Database, tallerId: string, asientoId: string, lineas: LineaIn[], desdeOrden = 0): Stmt[] {
  const s: Stmt[] = [];
  for (let i = 0; i < lineas.length; i += LINEAS_POR_SENTENCIA) {
    const grupo = lineas.slice(i, i + LINEAS_POR_SENTENCIA);
    const valores = grupo.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    s.push(
      db
        .prepare(
          `WITH v(id, orden, cuenta_id, debe, haber, detalle) AS (VALUES ${valores})
           INSERT INTO asiento_lineas (id, taller_id, asiento_id, orden, cuenta_id, debe, haber, detalle)
           SELECT v.id, ?, ?, v.orden, v.cuenta_id, v.debe, v.haber, v.detalle FROM v
            WHERE EXISTS (SELECT 1 FROM asientos WHERE taller_id = ? AND id = ? AND estado = 'borrador')`,
        )
        .bind(...grupo.flatMap((l, j) => [uid(), desdeOrden + i + j, l.cuentaId, l.debe, l.haber, l.detalle ?? null]), tallerId, asientoId, tallerId, asientoId),
    );
  }
  return s;
}

/** Pasa un borrador a registrado: asigna el número siguiente (sin saltos) y fija el total. El trigger valida la partida doble. */
export function sentenciaRegistrar(db: D1Database, tallerId: string, asientoId: string, usuarioId: string | null): Stmt {
  return db
    .prepare(
      `UPDATE asientos
          SET estado = 'registrado',
              numero = (SELECT COALESCE(MAX(numero), 0) + 1 FROM asientos WHERE taller_id = ?),
              total = (SELECT COALESCE(SUM(debe), 0) FROM asiento_lineas WHERE taller_id = ? AND asiento_id = ?),
              registrado_por = ?, registrado_at = ?
        WHERE taller_id = ? AND id = ? AND estado = 'borrador'`,
    )
    .bind(tallerId, tallerId, asientoId, usuarioId, ahora(), tallerId, asientoId);
}

/** Contra-asiento: las mismas cuentas con el Debe y el Haber intercambiados. */
export const invertir = (lineas: Array<{ cuentaId: string; debe: number; haber: number; detalle?: string | null }>): LineaIn[] =>
  lineas.map((l) => ({ cuentaId: l.cuentaId, debe: l.haber, haber: l.debe, detalle: l.detalle ?? null }));
