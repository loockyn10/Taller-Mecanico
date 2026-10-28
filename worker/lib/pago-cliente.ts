// Pago del cliente de una orden (Sprint 25): estado económico, elección del medio de pago, comprobantes de transferencia y confirmación del cobro.
//
// Principio: NADA acá es un sistema de cobros paralelo. El dinero se reconoce una sola vez y por el camino de siempre (`lib/cobros.ts` → cobro, caja, banco, asientos):
//   · elegir un medio o enviar un comprobante sólo deja evidencia (tablas `pago_elecciones` y `pago_comprobantes`);
//   · confirmar crea el cobro real (o enlaza uno que el taller ya había registrado) y marca el comprobante, todo en el MISMO batch.
// El importe y lo abonado salen de la OT, del comprobante interno y de los cobros ya existentes: no se guardan copias que puedan desactualizarse.
import type { Sesion } from '../env';
import { ahora, all, auditar, first, guard, uid, type Stmt } from './db';
import { ApiError, badRequest, conflict, notFound } from './http';
import { exigirCajaAbiertaSiCorresponde } from './caja';
import { sentenciasCobro, validarMediosCobro } from './cobros';
import { mediosHabilitados } from './config';
import { fechaComercial } from './fechas';
import { claveComprobante, validarComprobante } from './comprobantes';
import { sha256 } from './fotos';
import { LIMITES_COMPROBANTE, MEDIO_PORTAL_LABEL, detallePagoCliente, estadoPagoCliente, nombreVisible, type EstadoComprobante, type EstadoPagoCliente, type MedioPortal } from '../../shared/pago-portal';

// ───────────────────────── Estado económico de la OT ─────────────────────────

export interface FinanzasOrden {
  orden: { id: string; numero: number; estado: string; cliente_id: string; presupuesto_id: string | null };
  /** Importe que se le comunica al cliente (centavos): el comprobante interno vigente (neto de devoluciones) o, si todavía no hay, el total de la OT. */
  total: number;
  fuente: 'comprobante' | 'orden';
  venta: { id: string; numero: number; total: number; cobrado: number; devuelto: number } | null;
  /** Lo cobrado por el cliente: lo aplicado al comprobante + los anticipos de esta OT que todavía están disponibles. Sólo cobros confirmados en el módulo financiero. */
  abonado: number;
  pendiente: number;
  /** El taller informó el importe al cliente (o ya hay comprobante emitido) y es mayor que cero: recién ahí se le puede mostrar y recibir su comprobante. */
  confirmado: boolean;
  informado: { at: string; por: string | null; importe_al_informar: number } | null;
  /** Si la OT no admite más pagos (cancelada). */
  cerrada: boolean;
}

export async function finanzasOrden(db: D1Database, tallerId: string, ordenId: string): Promise<FinanzasOrden | null> {
  const r = await first<{
    id: string; numero: number; estado: string; cliente_id: string; presupuesto_id: string | null; total: number;
    venta_id: string | null; venta_numero: number | null; venta_total: number | null; venta_cobrado: number | null; venta_devuelto: number | null;
    anticipos: number; inf: number | null; inf_importe: number | null; inf_at: string | null; inf_por: string | null;
  }>(
    db,
    `SELECT o.id, o.numero, o.estado, o.cliente_id, o.presupuesto_id, o.total,
            ve.id AS venta_id, ve.numero AS venta_numero, ve.total AS venta_total, ve.cobrado AS venta_cobrado, ve.devuelto AS venta_devuelto,
            COALESCE((SELECT SUM(co.total - co.credito_aplicado - co.devuelto) FROM cobros co
                       WHERE co.taller_id = o.taller_id AND co.tipo = 'anticipo' AND co.estado = 'registrado'
                         AND (co.orden_id = o.id OR (o.presupuesto_id IS NOT NULL AND co.presupuesto_id = o.presupuesto_id))), 0) AS anticipos,
            pi.informado AS inf, pi.importe_al_informar AS inf_importe, pi.informado_at AS inf_at, pi.informado_por AS inf_por
       FROM ordenes o
       LEFT JOIN ventas ve ON ve.taller_id = o.taller_id AND ve.orden_id = o.id AND ve.estado = 'emitida'
       LEFT JOIN pago_importe_ot pi ON pi.taller_id = o.taller_id AND pi.orden_id = o.id
      WHERE o.taller_id = ? AND o.id = ?`,
    tallerId, ordenId,
  );
  if (!r) return null;
  const venta = r.venta_id ? { id: r.venta_id, numero: r.venta_numero!, total: r.venta_total!, cobrado: r.venta_cobrado!, devuelto: r.venta_devuelto! } : null;
  const total = venta ? venta.total - venta.devuelto : r.total;
  const abonado = (venta?.cobrado ?? 0) + Math.max(0, r.anticipos);
  const informado = r.inf === 1 && r.inf_at ? { at: r.inf_at, por: r.inf_por, importe_al_informar: r.inf_importe! } : null;
  return {
    orden: { id: r.id, numero: r.numero, estado: r.estado, cliente_id: r.cliente_id, presupuesto_id: r.presupuesto_id },
    total,
    fuente: venta ? 'comprobante' : 'orden',
    venta,
    abonado,
    pendiente: Math.max(0, total - abonado),
    confirmado: total > 0 && (venta !== null || informado !== null),
    informado,
    cerrada: r.estado === 'cancelada',
  };
}

// ───────────────────────── Cuenta receptora del taller ─────────────────────────

export interface CuentaReceptora {
  id: string;
  titular: string | null;
  banco: string;
  alias: string | null;
  cbu: string | null;
}

/**
 * La cuenta bancaria que el taller publica para recibir transferencias de clientes (la ya cargada en Finanzas). Sólo se ofrece si está activa, es en pesos, tiene
 * alias o CBU y el medio «transferencia» no fue deshabilitado en la configuración. Sin cuenta publicada no existe la opción de transferencia.
 */
export async function cuentaReceptora(db: D1Database, tallerId: string): Promise<CuentaReceptora | null> {
  const c = await first<CuentaReceptora>(
    db,
    "SELECT id, titular, banco, alias, cbu FROM cuentas_bancarias WHERE taller_id = ? AND publica_en_portal = 1 AND activa = 1 AND moneda = 'ARS' AND (alias IS NOT NULL OR cbu IS NOT NULL)",
    tallerId,
  );
  if (!c) return null;
  return (await mediosHabilitados(db, tallerId)).includes('transferencia') ? c : null;
}

// ───────────────────────── Elecciones y comprobantes ─────────────────────────

export interface Eleccion {
  id: string;
  medio: MedioPortal;
  estado: 'seleccionado' | 'confirmado';
  importe_total: number;
  importe_pendiente: number;
  created_at: string;
}

export const eleccionActual = (db: D1Database, tallerId: string, ordenId: string) =>
  first<Eleccion>(db, 'SELECT id, medio, estado, importe_total, importe_pendiente, created_at FROM pago_elecciones WHERE taller_id = ? AND orden_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', tallerId, ordenId);

export const historialElecciones = (db: D1Database, tallerId: string, ordenId: string) =>
  all<Eleccion>(db, 'SELECT id, medio, estado, importe_total, importe_pendiente, created_at FROM pago_elecciones WHERE taller_id = ? AND orden_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50', tallerId, ordenId);

export interface FilaComprobante {
  id: string;
  estado: Exclude<EstadoComprobante, 'subiendo'>;
  mime: string;
  bytes: number;
  nombre: string | null;
  importe_total: number;
  importe_pendiente: number;
  created_at: string;
  revisado_por: string | null;
  revisado_at: string | null;
  motivo_rechazo: string | null;
  cobro_id: string | null;
  importe_confirmado: number | null;
  vinculo: 'nuevo' | 'existente' | null;
}

/** Comprobantes recibidos de la orden (los que todavía se están subiendo no existen para nadie), el más nuevo primero. */
export const comprobantesDeOrden = (db: D1Database, tallerId: string, ordenId: string) =>
  all<FilaComprobante>(
    db,
    `SELECT id, estado, mime, bytes, nombre, importe_total, importe_pendiente, created_at, revisado_por, revisado_at, motivo_rechazo, cobro_id, importe_confirmado, vinculo
       FROM pago_comprobantes WHERE taller_id = ? AND orden_id = ? AND estado <> 'subiendo' ORDER BY created_at DESC, rowid DESC LIMIT 50`,
    tallerId, ordenId,
  );

/**
 * Pago del cliente para la copia de administración de la hoja de la OT (medio elegido, estado y saldo). Null si no corresponde: importe sin informar, o el cliente todavía no
 * eligió nada ni envió comprobantes. El llamador comprueba el permiso de ver ventas; la copia del mecánico nunca llega acá.
 */
export async function resumenPagoParaHoja(db: D1Database, tallerId: string, ordenId: string): Promise<{ medio: string | null; estado: string; saldo: number | null } | null> {
  const f = await finanzasOrden(db, tallerId, ordenId);
  if (!f || !f.confirmado) return null;
  const [eleccion, comps] = await Promise.all([eleccionActual(db, tallerId, ordenId), comprobantesDeOrden(db, tallerId, ordenId)]);
  const e = eleccion ? { medio: eleccion.medio, estado: eleccion.estado, at: eleccion.created_at } : null;
  const clave = estadoPagoCliente({ importeConfirmado: true, total: f.total, pendiente: f.pendiente, abonado: f.abonado, eleccion: e, comprobantes: comps.map((c) => ({ estado: c.estado, at: c.created_at })) });
  if (clave === 'pendiente_de_pago') return null;
  return { medio: eleccion ? MEDIO_PORTAL_LABEL[eleccion.medio] : null, estado: detallePagoCliente(clave, e), saldo: f.pendiente };
}

// ───────────────────────── Vista pública (lo que ve el cliente) ─────────────────────────

export interface PagoPublico {
  /** sin_importe: el taller todavía no informó el importe. cancelada. saldado. pendiente: hay saldo por cobrar. */
  situacion: 'sin_importe' | 'cancelada' | 'saldado' | 'pendiente';
  total: number | null;
  abonado: number | null;
  pendiente: number | null;
  medio: MedioPortal | null;
  medio_estado: 'seleccionado' | 'confirmado' | null;
  transferencia_disponible: boolean;
  /** Datos del taller para transferir: sólo cuando el cliente eligió transferencia y hay saldo por pagar. */
  cuenta: { titular: string | null; banco: string; alias: string | null; cbu: string | null } | null;
  /** Estado de verificación del pago para el cliente (separado del estado de la reparación). */
  verificacion: EstadoPagoCliente;
  comprobantes: Array<{ estado: 'pendiente' | 'confirmado' | 'rechazado'; at: string; motivo: string | null }>;
  puede_enviar: boolean;
  /** Motivo por el que no puede enviar otro por ahora (límite alcanzado), o null. */
  limite_envio: 'pendientes' | 'total' | null;
}

export async function pagoPublico(db: D1Database, tallerId: string, ordenId: string): Promise<PagoPublico> {
  const f = await finanzasOrden(db, tallerId, ordenId);
  const vacio = (situacion: PagoPublico['situacion']): PagoPublico => ({
    situacion, total: null, abonado: null, pendiente: null, medio: null, medio_estado: null, transferencia_disponible: false, cuenta: null,
    verificacion: 'sin_importe', comprobantes: [], puede_enviar: false, limite_envio: null,
  });
  if (!f) return vacio('sin_importe');
  if (f.cerrada) return vacio('cancelada');
  if (!f.confirmado) return vacio('sin_importe');
  const [eleccion, comps, cuenta] = await Promise.all([eleccionActual(db, tallerId, ordenId), comprobantesDeOrden(db, tallerId, ordenId), cuentaReceptora(db, tallerId)]);
  const saldado = f.pendiente <= 0;
  const eleccionActiva = eleccion && !saldado ? eleccion : null;
  const pendientes = comps.filter((c) => c.estado === 'pendiente').length;
  const limite: PagoPublico['limite_envio'] = pendientes >= LIMITES_COMPROBANTE.pendientesPorOrden ? 'pendientes' : comps.length >= LIMITES_COMPROBANTE.totalPorOrden ? 'total' : null;
  const verificacion = estadoPagoCliente({
    importeConfirmado: true, total: f.total, pendiente: f.pendiente, abonado: f.abonado,
    eleccion: eleccion ? { medio: eleccion.medio, estado: eleccion.estado, at: eleccion.created_at } : null,
    comprobantes: comps.map((c) => ({ estado: c.estado, at: c.created_at })),
  });
  return {
    situacion: saldado ? 'saldado' : 'pendiente',
    total: f.total,
    abonado: f.abonado,
    pendiente: f.pendiente,
    medio: eleccionActiva?.medio ?? null,
    medio_estado: eleccionActiva?.estado ?? null,
    transferencia_disponible: !!cuenta,
    cuenta: eleccionActiva?.medio === 'transferencia' && cuenta ? { titular: cuenta.titular, banco: cuenta.banco, alias: cuenta.alias, cbu: cuenta.cbu } : null,
    verificacion,
    // El cliente ve la fecha y el estado de cada envío; el archivo y los datos de la decisión no salen del taller (sólo el motivo si fue rechazado).
    comprobantes: comps.map((c) => ({ estado: c.estado, at: c.created_at, motivo: c.estado === 'rechazado' ? c.motivo_rechazo : null })),
    puede_enviar: !saldado && !!cuenta && eleccionActiva?.medio === 'transferencia' && limite === null,
    limite_envio: saldado ? null : limite,
  };
}

// ───────────────────────── Acciones del cliente (portal público) ─────────────────────────

export type AccionMedio = 'efectivo' | 'transferencia' | 'confirmar_efectivo';
/** Códigos que la página traduce a un aviso. Los `e_*` son errores. */
export type CodigoPortal =
  | 'medio_ok' | 'efectivo_ok' | 'comprobante_ok' | 'comprobante_dup'
  | 'e_sin_importe' | 'e_cancelada' | 'e_saldado' | 'e_sin_cuenta' | 'e_sin_medio' | 'e_formato' | 'e_tamano' | 'e_limite' | 'e_pendientes' | 'e_archivo' | 'e_almacenamiento' | 'e_origen' | 'e_demasiados' | 'e_dato';

interface Contexto { tallerId: string; ordenId: string }

/** Registra lo que eligió el cliente. No toca caja, bancos ni cobros: sólo deja la preferencia (y el saldo del momento) en el historial. */
export async function elegirMedio(db: D1Database, ctx: Contexto, accion: AccionMedio): Promise<CodigoPortal> {
  const f = await finanzasOrden(db, ctx.tallerId, ctx.ordenId);
  if (!f) return 'e_dato';
  if (f.cerrada) return 'e_cancelada';
  if (!f.confirmado) return 'e_sin_importe';
  if (f.pendiente <= 0) return 'e_saldado';
  const medio: MedioPortal = accion === 'transferencia' ? 'transferencia' : 'efectivo';
  if (medio === 'transferencia' && !(await cuentaReceptora(db, ctx.tallerId))) return 'e_sin_cuenta';
  const estado = accion === 'confirmar_efectivo' ? 'confirmado' : 'seleccionado';
  const actual = await eleccionActual(db, ctx.tallerId, ctx.ordenId);
  // Repetir lo mismo (refrescar, doble clic) no agrega filas; elegir efectivo estando ya confirmado tampoco lo degrada a «seleccionado».
  if (actual && actual.medio === medio && (actual.estado === estado || actual.estado === 'confirmado')) return accion === 'confirmar_efectivo' ? 'efectivo_ok' : 'medio_ok';
  await db.batch([
    db.prepare('INSERT INTO pago_elecciones (id, taller_id, orden_id, medio, estado, importe_total, importe_pendiente) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(uid(), ctx.tallerId, ctx.ordenId, medio, estado, f.total, f.pendiente),
    auditar(db, ctx.tallerId, null, 'orden', ctx.ordenId, accion === 'confirmar_efectivo' ? 'pago_efectivo_confirmado' : 'pago_medio_elegido', { medio, estado, importe_total: f.total, importe_pendiente: f.pendiente, origen: 'portal' }),
  ]);
  return accion === 'confirmar_efectivo' ? 'efectivo_ok' : 'medio_ok';
}

/**
 * Recibe el comprobante de una transferencia. Orden de las cosas, pensado para que un corte en cualquier punto no deje datos a medias:
 *   1) valida el estado de la orden, el contenido real del archivo y los límites; 2) reserva el lugar en D1 (fila «subiendo», con los límites comprobados DENTRO de
 *   la transacción); 3) guarda el objeto en R2; 4) pasa a «pendiente». Si falla el paso 3 se deshace la reserva; si se corta entre 3 y 4 el mantenimiento borra el objeto
 *   y la fila (`limpiarComprobantes`). El mismo formulario enviado dos veces (clave de reintento) o el mismo archivo enviado de nuevo no duplican nada.
 */
export async function recibirComprobante(
  env: { DB: D1Database; FIERRO_FOTOS?: R2Bucket },
  ctx: Contexto,
  archivo: { bytes: Uint8Array; nombre: string | null },
  idemKey: string,
): Promise<CodigoPortal> {
  const db = env.DB;
  const bucket = env.FIERRO_FOTOS;
  if (!bucket) return 'e_almacenamiento';
  const f = await finanzasOrden(db, ctx.tallerId, ctx.ordenId);
  if (!f) return 'e_dato';
  if (f.cerrada) return 'e_cancelada';
  if (!f.confirmado) return 'e_sin_importe';
  if (f.pendiente <= 0) return 'e_saldado';
  if (!(await cuentaReceptora(db, ctx.tallerId))) return 'e_sin_cuenta';

  // Reintento del mismo formulario.
  const previo = await first<{ orden_id: string; estado: string }>(db, 'SELECT orden_id, estado FROM pago_comprobantes WHERE taller_id = ? AND idem_key = ?', ctx.tallerId, idemKey);
  if (previo) return previo.orden_id === ctx.ordenId && previo.estado !== 'subiendo' ? 'comprobante_dup' : 'e_dato';

  let valido;
  try {
    valido = validarComprobante(archivo.bytes, archivo.nombre);
  } catch (e) {
    if (e instanceof ApiError) return e.status === 413 ? 'e_tamano' : e.code === 'comprobante_invalido' || e.code === 'imagen_invalida' ? 'e_formato' : 'e_archivo';
    throw e;
  }
  const hash = await sha256(valido.bytes);
  // El mismo archivo ya recibido (y no rechazado) no se vuelve a guardar.
  if (await first(db, "SELECT 1 FROM pago_comprobantes WHERE taller_id = ? AND orden_id = ? AND sha256 = ? AND estado IN ('subiendo', 'pendiente', 'confirmado')", ctx.tallerId, ctx.ordenId, hash)) return 'comprobante_dup';

  const id = uid();
  const actual = await eleccionActual(db, ctx.tallerId, ctx.ordenId);
  const L = LIMITES_COMPROBANTE;
  try {
    await db.batch([
      // Los límites se comprueban DENTRO de la transacción: envíos simultáneos no pueden saltearlos.
      guard(db, "(SELECT COUNT(*) FROM pago_comprobantes WHERE taller_id = ? AND orden_id = ? AND estado IN ('subiendo', 'pendiente')) >= ?", ctx.tallerId, ctx.ordenId, L.pendientesPorOrden),
      guard(db, "(SELECT COUNT(*) FROM pago_comprobantes WHERE taller_id = ? AND orden_id = ?) >= ?", ctx.tallerId, ctx.ordenId, L.totalPorOrden),
      guard(db, "(SELECT COALESCE(SUM(bytes), 0) FROM pago_comprobantes WHERE taller_id = ? AND orden_id = ?) + ? > ?", ctx.tallerId, ctx.ordenId, valido.bytes.length, L.bytesPorOrden),
      db.prepare(
        `INSERT INTO pago_comprobantes (id, taller_id, orden_id, estado, idem_key, mime, bytes, sha256, nombre, importe_total, importe_pendiente)
         VALUES (?, ?, ?, 'subiendo', ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, ctx.tallerId, ctx.ordenId, idemKey, valido.mime, valido.bytes.length, hash, nombreVisible(archivo.nombre), f.total, f.pendiente),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('idem_key')) return 'comprobante_dup';
    if (msg.includes('tx_guard') || msg.includes('ok = 1')) {
      const n = await first<{ p: number }>(db, "SELECT COUNT(*) AS p FROM pago_comprobantes WHERE taller_id = ? AND orden_id = ? AND estado IN ('subiendo', 'pendiente')", ctx.tallerId, ctx.ordenId);
      return (n?.p ?? 0) >= L.pendientesPorOrden ? 'e_pendientes' : 'e_limite';
    }
    throw e;
  }

  const clave = claveComprobante(ctx.tallerId, id);
  try {
    await bucket.put(clave, valido.bytes, { sha256: hash, httpMetadata: { contentType: valido.mime }, customMetadata: { taller: ctx.tallerId, orden: ctx.ordenId, comprobante: id } });
  } catch {
    await db.prepare("DELETE FROM pago_comprobantes WHERE taller_id = ? AND id = ? AND estado = 'subiendo'").bind(ctx.tallerId, id).run().catch(() => undefined);
    await bucket.delete(clave).catch(() => undefined);
    return 'e_almacenamiento';
  }
  const stmts: Stmt[] = [];
  // Enviar un comprobante implica que va a pagar por transferencia: queda registrado en el historial de elecciones si todavía no lo estaba.
  if (actual?.medio !== 'transferencia') {
    stmts.push(db.prepare("INSERT INTO pago_elecciones (id, taller_id, orden_id, medio, estado, importe_total, importe_pendiente) VALUES (?, ?, ?, 'transferencia', 'seleccionado', ?, ?)").bind(uid(), ctx.tallerId, ctx.ordenId, f.total, f.pendiente));
  }
  stmts.push(
    db.prepare("UPDATE pago_comprobantes SET estado = 'pendiente' WHERE taller_id = ? AND id = ? AND estado = 'subiendo'").bind(ctx.tallerId, id),
    auditar(db, ctx.tallerId, null, 'orden', ctx.ordenId, 'pago_comprobante_recibido', { comprobante_id: id, mime: valido.mime, bytes: valido.bytes.length, importe_pendiente: f.pendiente, origen: 'portal' }),
  );
  await db.batch(stmts);
  return 'comprobante_ok';
}

/**
 * Mantenimiento (Cron): termina lo que quedó a medias. Un comprobante «subiendo» de hace más de una hora es una subida cortada: se borra el objeto de R2 (idempotente)
 * y recién después la fila, así nunca queda un objeto sin fila que lo explique.
 */
export async function limpiarComprobantes(db: D1Database, bucket: R2Bucket | undefined): Promise<{ limpiados: number }> {
  if (!bucket) return { limpiados: 0 };
  const filas = await all<{ id: string; taller_id: string }>(db, "SELECT id, taller_id FROM pago_comprobantes WHERE estado = 'subiendo' AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour') LIMIT 50");
  let limpiados = 0;
  for (const c of filas) {
    try {
      await bucket.delete(claveComprobante(c.taller_id, c.id));
      await db.prepare("DELETE FROM pago_comprobantes WHERE taller_id = ? AND id = ? AND estado = 'subiendo'").bind(c.taller_id, c.id).run();
      limpiados++;
    } catch {
      /* se reintenta en la próxima pasada */
    }
  }
  return { limpiados };
}

// ───────────────────────── Verificación administrativa ─────────────────────────

export interface CobroVinculable {
  id: string;
  numero: number;
  fecha: string;
  tipo: 'cobro' | 'anticipo';
  total: number;
  /** Lo que ese cobro recibió por transferencia (lo que se enlazaría al comprobante). */
  transferido: number;
}

/**
 * Cobros ya registrados en el módulo financiero que corresponden a esta orden, se recibieron por transferencia y no respaldan ningún otro comprobante.
 * Sirven para RECONOCER una transferencia que el taller ya había cobrado, en vez de contabilizarla otra vez.
 */
export async function cobrosVinculables(db: D1Database, tallerId: string, f: FinanzasOrden): Promise<CobroVinculable[]> {
  return all<CobroVinculable>(
    db,
    `SELECT co.id, co.numero, co.fecha, co.tipo, co.total, SUM(cm.importe) AS transferido
       FROM cobros co
       JOIN cobro_medios cm ON cm.taller_id = co.taller_id AND cm.cobro_id = co.id AND cm.medio = 'transferencia'
      WHERE co.taller_id = ? AND co.estado = 'registrado' AND co.cliente_id = ?
        AND ((co.tipo = 'anticipo' AND (co.orden_id = ? OR (? IS NOT NULL AND co.presupuesto_id = ?)))
             OR EXISTS (SELECT 1 FROM cobro_aplicaciones ca WHERE ca.taller_id = co.taller_id AND ca.cobro_id = co.id AND ca.venta_id = ?))
        AND NOT EXISTS (SELECT 1 FROM pago_comprobantes pc WHERE pc.taller_id = co.taller_id AND pc.cobro_id = co.id)
      GROUP BY co.id ORDER BY co.numero DESC LIMIT 20`,
    tallerId, f.orden.cliente_id, f.orden.id, f.orden.presupuesto_id, f.orden.presupuesto_id, f.venta?.id ?? '',
  );
}

export interface EntradaConfirmar {
  /** Lo que realmente se recibió (por defecto, el saldo pendiente). No puede superar el saldo. */
  importe?: number;
  /** Cuenta donde se acreditó (por defecto, la cuenta publicada en el portal). */
  cuentaId?: string | null;
  /** En lugar de crear un cobro: reconocer uno que ya está registrado. */
  cobroId?: string | null;
  fecha?: string | null;
}

async function comprobanteDeOrden(db: D1Database, tallerId: string, ordenId: string, id: string) {
  const c = await first<{ id: string; estado: EstadoComprobante; cobro_id: string | null; vinculo: 'nuevo' | 'existente' | null; importe_confirmado: number | null }>(
    db, 'SELECT id, estado, cobro_id, vinculo, importe_confirmado FROM pago_comprobantes WHERE taller_id = ? AND orden_id = ? AND id = ?', tallerId, ordenId, id,
  );
  if (!c || c.estado === 'subiendo') throw notFound('Comprobante');
  return c;
}

/**
 * Confirma que el dinero ingresó. Un único camino hacia el dinero:
 *  · cobro nuevo → `sentenciasCobro` (el mismo código de /cobros): si la OT ya tiene comprobante interno, el cobro se aplica a él; si no, queda como anticipo de la OT
 *    (que se imputa al emitirlo), con su ingreso de caja, su movimiento bancario y su asiento;
 *  · cobro existente → sólo se enlaza (no se crea ni se contabiliza nada otra vez).
 * Todo va en UN batch con una guarda sobre el estado del comprobante: doble clic, reintento o dos administrativos a la vez dan un único cobro (el segundo recibe el resultado del
 * primero). Si algo no se puede registrar (caja cerrada, cuenta inválida, saldo), el comprobante sigue pendiente y no se marca nada como cobrado.
 */
export async function confirmarComprobante(db: D1Database, s: Sesion, ordenId: string, comprobanteId: string, e: EntradaConfirmar): Promise<{ cobro_id: string; vinculo: 'nuevo' | 'existente'; importe: number; duplicado: boolean }> {
  const cp = await comprobanteDeOrden(db, s.tallerId, ordenId, comprobanteId);
  if (cp.estado === 'confirmado') return { cobro_id: cp.cobro_id!, vinculo: cp.vinculo!, importe: cp.importe_confirmado!, duplicado: true };
  if (cp.estado !== 'pendiente') throw conflict('Ese comprobante ya fue rechazado: el cliente tiene que enviar otro', 'comprobante_resuelto');
  const f = await finanzasOrden(db, s.tallerId, ordenId);
  if (!f) throw notFound('Orden de trabajo');
  if (f.cerrada) throw conflict('La orden de trabajo está cancelada', 'orden_cancelada');
  const t = ahora();
  const marcar = (cobroId: string, importe: number, vinculo: 'nuevo' | 'existente') =>
    db.prepare(
      `UPDATE pago_comprobantes SET estado = 'confirmado', cobro_id = ?, importe_confirmado = ?, vinculo = ?, revisado_por = ?, revisado_at = ? WHERE taller_id = ? AND id = ? AND estado = 'pendiente'`,
    ).bind(cobroId, importe, vinculo, s.usuarioId, t, s.tallerId, comprobanteId);
  const sinPendiente = () => guard(db, "NOT EXISTS (SELECT 1 FROM pago_comprobantes WHERE taller_id = ? AND id = ? AND estado = 'pendiente')", s.tallerId, comprobanteId);

  let stmts: Stmt[];
  let resultado: { cobro_id: string; vinculo: 'nuevo' | 'existente'; importe: number };
  if (e.cobroId) {
    const candidato = (await cobrosVinculables(db, s.tallerId, f)).find((c) => c.id === e.cobroId);
    if (!candidato) throw conflict('Ese cobro no se puede enlazar: no es una transferencia de esta orden o ya respalda otro comprobante', 'cobro_no_vinculable');
    resultado = { cobro_id: candidato.id, vinculo: 'existente', importe: candidato.transferido };
    stmts = [
      sinPendiente(),
      guard(db, "NOT EXISTS (SELECT 1 FROM cobros WHERE taller_id = ? AND id = ? AND estado = 'registrado')", s.tallerId, candidato.id),
      marcar(candidato.id, candidato.transferido, 'existente'),
      auditar(db, s.tallerId, s.usuarioId, 'orden', ordenId, 'pago_cobro_vinculado', { comprobante_id: comprobanteId, cobro_id: candidato.id, importe: candidato.transferido }),
    ];
  } else {
    const importe = e.importe ?? f.pendiente;
    if (!Number.isInteger(importe) || importe <= 0) throw badRequest(f.pendiente <= 0 ? 'La orden no tiene saldo pendiente: rechazá el comprobante o enlazá un cobro ya registrado' : 'Indicá el importe recibido');
    if (importe > f.pendiente) throw conflict(`El importe supera el saldo pendiente de la orden (${(f.pendiente / 100).toLocaleString('es-AR', { minimumFractionDigits: 2 })}). Si el cliente transfirió más, registrá la diferencia en el módulo de cobros`, 'saldo_excedido');
    const cuentaId = e.cuentaId ?? (await cuentaReceptora(db, s.tallerId))?.id ?? null;
    if (!cuentaId) throw badRequest('Elegí la cuenta bancaria donde se acreditó la transferencia');
    await validarMediosCobro(db, s.tallerId, [{ medio: 'transferencia', importe, cuentaId }]);
    const cli = await first<{ codigo: number }>(db, 'SELECT codigo FROM clientes WHERE taller_id = ? AND id = ?', s.tallerId, f.orden.cliente_id);
    if (!f.venta && cli?.codigo === 0) throw conflict('La orden es de «Consumidor final»: emití el comprobante y registrá el cobro desde ahí (un anticipo requiere un cliente identificado)', 'consumidor_final');
    const fecha = fechaComercial(s, e.fecha);
    await exigirCajaAbiertaSiCorresponde(db, s.tallerId);
    const cobroId = uid();
    // Con comprobante interno emitido el cobro se aplica a él; sin comprobante es un anticipo de la OT (dinero recibido antes de la venta).
    const aplicaciones = f.venta ? [{ ventaId: f.venta.id, importe }] : [];
    resultado = { cobro_id: cobroId, vinculo: 'nuevo', importe };
    stmts = [
      sinPendiente(),
      ...sentenciasCobro(db, s, {
        id: cobroId, clienteId: f.orden.cliente_id, fecha, idemKey: `pagoportal:${comprobanteId}`, tipo: f.venta ? 'cobro' : 'anticipo', ordenId,
        notas: `Transferencia informada por el cliente desde el portal (OT #${f.orden.numero}); recepción verificada por ${s.nombre}`,
        medios: [{ medio: 'transferencia', importe, referencia: `OT #${f.orden.numero} · comprobante del portal`, cuentaId }],
        aplicaciones,
      }),
      marcar(cobroId, importe, 'nuevo'),
      auditar(db, s.tallerId, s.usuarioId, 'orden', ordenId, 'pago_cobro_confirmado', { comprobante_id: comprobanteId, cobro_id: cobroId, importe, cuenta_id: cuentaId, tipo: f.venta ? 'cobro' : 'anticipo' }),
    ];
  }
  try {
    await db.batch(stmts);
  } catch (err) {
    // Carrera con otra confirmación del mismo comprobante: se devuelve la del primero (nada se duplicó: el batch entero se revirtió).
    const ahoraCp = await comprobanteDeOrden(db, s.tallerId, ordenId, comprobanteId).catch(() => null);
    if (ahoraCp?.estado === 'confirmado') return { cobro_id: ahoraCp.cobro_id!, vinculo: ahoraCp.vinculo!, importe: ahoraCp.importe_confirmado!, duplicado: true };
    throw err;
  }
  return { ...resultado, duplicado: false };
}

export async function rechazarComprobante(db: D1Database, s: Sesion, ordenId: string, comprobanteId: string, motivo: string): Promise<{ duplicado: boolean }> {
  const cp = await comprobanteDeOrden(db, s.tallerId, ordenId, comprobanteId);
  if (cp.estado === 'rechazado') return { duplicado: true };
  if (cp.estado === 'confirmado') throw conflict('Ese comprobante ya fue confirmado: no se puede rechazar', 'comprobante_resuelto');
  try {
    await db.batch([
      guard(db, "NOT EXISTS (SELECT 1 FROM pago_comprobantes WHERE taller_id = ? AND id = ? AND estado = 'pendiente')", s.tallerId, comprobanteId),
      db.prepare("UPDATE pago_comprobantes SET estado = 'rechazado', motivo_rechazo = ?, revisado_por = ?, revisado_at = ? WHERE taller_id = ? AND id = ? AND estado = 'pendiente'").bind(motivo, s.usuarioId, ahora(), s.tallerId, comprobanteId),
      auditar(db, s.tallerId, s.usuarioId, 'orden', ordenId, 'pago_comprobante_rechazado', { comprobante_id: comprobanteId, motivo }),
    ]);
  } catch (err) {
    const cur = await comprobanteDeOrden(db, s.tallerId, ordenId, comprobanteId).catch(() => null);
    if (cur?.estado === 'rechazado') return { duplicado: true };
    if (cur?.estado === 'confirmado') throw conflict('Ese comprobante ya fue confirmado: no se puede rechazar', 'comprobante_resuelto');
    throw err;
  }
  return { duplicado: false };
}

// ───────────────────────── Indicador de pago del tablero de órdenes ─────────────────────────

export type IndicadorPago = { medio: MedioPortal; estado: 'sin_comprobante' | 'pendiente' | 'verificado' | 'rechazado' | null } | null;

interface OrdenParaIndicador { id: string; total: number; presupuesto_id: string | null; venta_total: number | null; venta_cobrado: number | null; venta_devuelto: number | null }

/**
 * Indicador de pago de varias órdenes con 3 consultas en total (no una por tarjeta), con las mismas reglas del Sprint 25:
 * total/abonado/saldo como `finanzasOrden` y estado como `estadoPagoCliente`. «Verificado» sólo si el saldo quedó cubierto (un comprobante parcial no cuenta).
 * Sin elección del cliente → null (tarjeta neutra). El llamador decide si quien pregunta puede ver información financiera.
 */
export async function indicadoresPago(db: D1Database, tallerId: string, ordenes: OrdenParaIndicador[]): Promise<Map<string, IndicadorPago>> {
  const res = new Map<string, IndicadorPago>();
  const eleciones = new Map<string, Eleccion>();
  const comps = new Map<string, Array<{ estado: EstadoComprobante; at: string }>>();
  const anticipos = new Map<string, number>();
  for (let i = 0; i < ordenes.length; i += 80) {
    const lote = ordenes.slice(i, i + 80);
    const ids = lote.map((o) => o.id);
    const q = ids.map(() => '?').join(',');
    for (const e of await all<Eleccion & { orden_id: string }>(db, `SELECT orden_id, medio, estado, importe_total, importe_pendiente, created_at FROM pago_elecciones WHERE taller_id = ? AND orden_id IN (${q}) ORDER BY created_at, rowid`, tallerId, ...ids)) eleciones.set(e.orden_id, e);
    for (const c of await all<{ orden_id: string; estado: EstadoComprobante; created_at: string }>(db, `SELECT orden_id, estado, created_at FROM pago_comprobantes WHERE taller_id = ? AND orden_id IN (${q}) AND estado <> 'subiendo'`, tallerId, ...ids)) {
      (comps.get(c.orden_id) ?? comps.set(c.orden_id, []).get(c.orden_id)!).push({ estado: c.estado, at: c.created_at });
    }
    for (const a of await all<{ orden_id: string; n: number }>(
      db,
      `SELECT o.id AS orden_id, COALESCE(SUM(co.total - co.credito_aplicado - co.devuelto), 0) AS n FROM ordenes o
         JOIN cobros co ON co.taller_id = o.taller_id AND co.tipo = 'anticipo' AND co.estado = 'registrado' AND (co.orden_id = o.id OR (o.presupuesto_id IS NOT NULL AND co.presupuesto_id = o.presupuesto_id))
        WHERE o.taller_id = ? AND o.id IN (${q}) GROUP BY o.id`,
      tallerId, ...ids,
    )) anticipos.set(a.orden_id, a.n);
  }
  for (const o of ordenes) {
    const el = eleciones.get(o.id);
    if (!el) { res.set(o.id, null); continue; }
    const total = o.venta_total != null ? o.venta_total - (o.venta_devuelto ?? 0) : o.total;
    const abonado = (o.venta_cobrado ?? 0) + Math.max(0, anticipos.get(o.id) ?? 0);
    const pendiente = Math.max(0, total - abonado);
    const clave = estadoPagoCliente({ importeConfirmado: true, total, pendiente, abonado, eleccion: { medio: el.medio, estado: el.estado, at: el.created_at }, comprobantes: comps.get(o.id) ?? [] });
    const estado = el.medio !== 'transferencia' ? null : clave === 'cobro_confirmado' ? 'verificado' : clave === 'comprobante_recibido' ? 'pendiente' : clave === 'comprobante_rechazado' ? 'rechazado' : 'sin_comprobante';
    res.set(o.id, { medio: el.medio, estado });
  }
  return res;
}
