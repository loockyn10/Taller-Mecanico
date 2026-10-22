// Fuentes de asientos automáticos: cada operación comercial existente (venta, cobro, compra, pago, gasto, devolución, anticipo, movimiento de caja o banco…)
// se traduce a un asiento de partida doble. La contabilización NO modifica las operaciones: las lee y deja el asiento con su documento de origen.
//
// Criterios (separar lo económico del movimiento de dinero):
//  * Una venta devenga ingresos contra Deudores; el cobro NO vuelve a ser ingreso: cancela Deudores. Un anticipo es una deuda con el cliente, no una venta.
//  * Una devolución reduce ingresos (y el IVA) y deja el crédito en Deudores o en Anticipos y saldos a favor; el reintegro cancela ese pasivo contra el dinero.
//  * Las transferencias entre cuentas propias, los depósitos y las extracciones mueven dinero entre cuentas del Activo: nunca generan resultado.
//  * Las anulaciones generan un contra-asiento con las líneas invertidas (nunca borran ni modifican el original).
import { all, lotes } from '../db';
import { repartir } from '../../../shared/devoluciones';
import { rolDeGasto, type RolCuenta } from '../../../shared/contabilidad';
import type { LineaIn } from './asientos';

export interface Ctx {
  db: D1Database;
  tallerId: string;
  /** Instante (UTC) en que se inicializó la contabilidad del taller: los documentos creados antes se contabilizan como "históricos". */
  inicio: string;
  rol(r: RolCuenta): string;
  banco(cuentaBancariaId: string | null | undefined): string | null;
  esValida(cuentaId: string): boolean;
}

export interface Propuesta {
  kind: 'asiento';
  id: string;
  origenTipo: string;
  origenId: string;
  evento: 'alta' | 'anulacion';
  fecha: string;
  descripcion: string;
  usuarioId: string | null;
  lineas: LineaIn[];
  advertencia?: string | null;
  costoIncompleto?: boolean;
  /** Clave de orden entre documentos de la misma fecha (instante de creación del documento). */
  orden: string;
  revierteId?: string | null;
  historico: boolean;
}

export interface Omision {
  kind: 'omision';
  origenTipo: string;
  origenId: string;
  evento: 'alta' | 'anulacion';
  tipo: 'sin_efecto' | 'error';
  motivo: string;
}

export type Resultado = Propuesta | Omision;

export interface FuenteDef {
  tipo: string;
  /** Orden entre fuentes cuando coinciden fecha e instante (la venta antes que su cobro). */
  prioridad: number;
  etiqueta: string;
  /** Documentos con alta pendiente. */
  pendientes(ctx: Ctx, limite: number): Promise<Resultado[]>;
  /** Documentos anulados con el contra-asiento pendiente. Sin esta función la fuente no admite anulación. */
  anulados?(ctx: Ctx, limite: number): Promise<Anulacion[]>;
  /** Cuenta cuántos documentos hay y cuántos tienen asiento (para el control de cobertura). */
  cobertura: { sql: string };
}

export interface Anulacion {
  origenId: string;
  /** Fecha (AAAA-MM-DD) en que se anuló, si la operación la registra. */
  fecha: string | null;
  usuarioId: string | null;
  orden: string;
}

// ───────────────────────── Utilidades ─────────────────────────
/** Fecha comercial argentina (UTC-3) de un instante ISO. */
export const fechaAR = (iso: string): string => new Date(Date.parse(iso) - 3 * 3600_000).toISOString().slice(0, 10);

const num = (n: number | string | null | undefined) => (n == null ? '' : String(n));

/** Condición SQL: el documento `alias` todavía no tiene su asiento ni fue descartado de forma definitiva. (El alias del documento NO puede ser `a` ni `o`: son los de las subconsultas.) */
function sinAsiento(alias: string, tipo: string, evento: 'alta' | 'anulacion'): string {
  return `NOT EXISTS (SELECT 1 FROM asientos a WHERE a.taller_id = ${alias}.taller_id AND a.origen_tipo = '${tipo}' AND a.origen_id = ${alias}.id AND a.evento = '${evento}')
    AND NOT EXISTS (SELECT 1 FROM contab_omitidos o WHERE o.taller_id = ${alias}.taller_id AND o.origen_tipo = '${tipo}' AND o.origen_id = ${alias}.id AND o.evento = '${evento}' AND (o.tipo = 'sin_efecto' OR o.intentos >= 3))`;
}

const debe = (cuentaId: string, importe: number, detalle?: string): LineaIn => ({ cuentaId, debe: importe, haber: 0, detalle });
const haber = (cuentaId: string, importe: number, detalle?: string): LineaIn => ({ cuentaId, debe: 0, haber: importe, detalle });

/** Une líneas de la misma cuenta y lado, descarta las de importe cero y pasa a su lado contrario las negativas. */
export function compactar(lineas: LineaIn[]): LineaIn[] {
  const m = new Map<string, LineaIn>();
  for (const l of lineas) {
    let d = l.debe, h = l.haber;
    if (d < 0) [d, h] = [0, h - d];
    if (h < 0) [d, h] = [d - h, 0];
    if (d === 0 && h === 0) continue;
    const net = d - h;
    const lado = net >= 0 ? 'D' : 'H';
    const k = `${l.cuentaId}|${lado}|${l.detalle ?? ''}`;
    const prev = m.get(k);
    if (prev) {
      prev.debe += lado === 'D' ? net : 0;
      prev.haber += lado === 'H' ? -net : 0;
    } else m.set(k, { cuentaId: l.cuentaId, debe: lado === 'D' ? net : 0, haber: lado === 'H' ? -net : 0, detalle: l.detalle });
  }
  return [...m.values()];
}

interface Base {
  origenTipo: string;
  origenId: string;
  fecha: string;
  descripcion: string;
  usuarioId: string | null;
  orden: string;
  createdAt: string;
  advertencia?: string | null;
  costoIncompleto?: boolean;
}

/** Arma la propuesta, verificando la partida doble. Un documento sin importes no tiene efecto contable; uno que no balancea se informa como error (jamás se ajusta). */
function armar(ctx: Ctx, b: Base, lineas: LineaIn[]): Resultado {
  const ls = compactar(lineas);
  const sd = ls.reduce((a, l) => a + l.debe, 0);
  const sh = ls.reduce((a, l) => a + l.haber, 0);
  if (!ls.length) return { kind: 'omision', origenTipo: b.origenTipo, origenId: b.origenId, evento: 'alta', tipo: 'sin_efecto', motivo: 'El documento no tiene importes: no genera asiento' };
  if (sd !== sh) {
    return { kind: 'omision', origenTipo: b.origenTipo, origenId: b.origenId, evento: 'alta', tipo: 'error', motivo: `Los importes del documento no cierran (Debe ${sd / 100} ≠ Haber ${sh / 100}): revisarlo antes de contabilizar` };
  }
  const invalida = ls.find((l) => !ctx.esValida(l.cuentaId));
  if (invalida) return { kind: 'omision', origenTipo: b.origenTipo, origenId: b.origenId, evento: 'alta', tipo: 'error', motivo: 'Una cuenta del plan está inactiva o ya no es imputable' };
  return {
    kind: 'asiento', id: crypto.randomUUID(), origenTipo: b.origenTipo, origenId: b.origenId, evento: 'alta', fecha: b.fecha, descripcion: b.descripcion, usuarioId: b.usuarioId,
    lineas: ls, advertencia: b.advertencia ?? null, costoIncompleto: !!b.costoIncompleto, orden: b.orden, historico: b.createdAt < ctx.inicio,
  };
}

/** Cuenta del Activo/Pasivo donde se mueve el dinero de un medio de pago. */
function cuentaMedio(ctx: Ctx, medio: string, cuentaBancariaId: string | null | undefined, chequeSalida: 'propio' | 'endosado' | null = null): string {
  const banco = ctx.banco(cuentaBancariaId);
  if (banco) return banco;
  if (medio === 'efectivo') return ctx.rol('caja_efectivo');
  if (medio === 'cheque') return chequeSalida === 'propio' ? ctx.rol('cheques_emitidos') : ctx.rol('valores_depositar');
  return ctx.rol('electronicos_sin_cuenta');
}

async function porLotes<T>(ids: string[], f: (lote: string[]) => Promise<T[]>): Promise<T[]> {
  const r: T[] = [];
  for (const l of lotes(ids)) r.push(...(await f(l)));
  return r;
}
const marcas = (l: string[]) => l.map(() => '?').join(',');

// ───────────────────────── Ventas ─────────────────────────
interface VentaRow { id: string; numero: number; fecha: string; created_at: string; usuario_id: string | null; total: number; iva: number; cliente: string }
interface VentaItem { venta_id: string; tipo: string; subtotal: number; cantidad: number; costo_unitario: number | null }

const venta: FuenteDef = {
  tipo: 'venta', prioridad: 10, etiqueta: 'Ventas (comprobantes internos)',
  async pendientes(ctx, limite) {
    const ventas = await all<VentaRow>(
      ctx.db,
      `SELECT v.id, v.numero, v.fecha, v.created_at, v.created_by AS usuario_id, v.total, v.iva, c.nombre AS cliente
         FROM ventas v JOIN clientes c ON c.taller_id = v.taller_id AND c.id = v.cliente_id
        WHERE v.taller_id = ? AND ${sinAsiento('v', 'venta', 'alta')} ORDER BY v.fecha, v.created_at LIMIT ?`,
      ctx.tallerId, limite,
    );
    const items = await porLotes(ventas.map((v) => v.id), (l) =>
      all<VentaItem>(ctx.db, `SELECT venta_id, tipo, subtotal, cantidad, costo_unitario FROM venta_items WHERE taller_id = ? AND venta_id IN (${marcas(l)})`, ctx.tallerId, ...l),
    );
    return ventas.map((v) => {
      const its = items.filter((i) => i.venta_id === v.id);
      const pesos = its.map((i) => Math.max(0, i.subtotal));
      const valor = repartir(v.total, pesos);
      const ivaL = repartir(v.iva, pesos);
      let rep = 0, serv = 0;
      its.forEach((i, k) => {
        const neto = valor[k] - ivaL[k];
        if (i.tipo === 'articulo') rep += neto;
        else serv += neto;
      });
      if (!its.length || pesos.every((p) => p === 0)) {
        rep = 0;
        serv = v.total - v.iva;
      }
      let costo = 0, sinCosto = 0;
      for (const i of its) {
        if (i.tipo !== 'articulo') continue;
        if (i.costo_unitario == null) sinCosto++;
        else costo += Math.round(i.cantidad * i.costo_unitario);
      }
      const lineas: LineaIn[] = [
        debe(ctx.rol('deudores'), v.total),
        haber(ctx.rol('ventas_repuestos'), rep),
        haber(ctx.rol('ventas_servicios'), serv),
        haber(ctx.rol('iva_debito'), v.iva),
        debe(ctx.rol('costo_repuestos'), costo),
        haber(ctx.rol('inventario'), costo),
      ];
      return armar(ctx, {
        origenTipo: 'venta', origenId: v.id, fecha: v.fecha, descripcion: `Venta #${v.numero} · ${v.cliente}`, usuarioId: v.usuario_id, orden: v.created_at, createdAt: v.created_at,
        costoIncompleto: sinCosto > 0,
        advertencia: sinCosto > 0 ? `Costo histórico no disponible en ${sinCosto} renglón(es) de repuestos (comprobante anterior al registro del costo): el costo de ventas de este asiento está incompleto` : null,
      }, lineas);
    });
  },
  anulados: (ctx, limite) => anuladosPorAuditoria(ctx, 'venta', 'ventas', "t.estado = 'anulada'", 'venta', limite),
  cobertura: { sql: "SELECT COUNT(*) AS docs FROM ventas WHERE taller_id = ?" },
};

// ───────────────────────── Cobros y anticipos ─────────────────────────
const cobro: FuenteDef = {
  tipo: 'cobro', prioridad: 20, etiqueta: 'Cobros y anticipos de clientes',
  async pendientes(ctx, limite) {
    const cobros = await all<{ id: string; numero: number; fecha: string; created_at: string; usuario_id: string | null; total: number; tipo: string; cliente: string }>(
      ctx.db,
      `SELECT co.id, co.numero, co.fecha, co.created_at, co.usuario_id, co.total, co.tipo, c.nombre AS cliente
         FROM cobros co JOIN clientes c ON c.taller_id = co.taller_id AND c.id = co.cliente_id
        WHERE co.taller_id = ? AND ${sinAsiento('co', 'cobro', 'alta')} ORDER BY co.fecha, co.created_at LIMIT ?`,
      ctx.tallerId, limite,
    );
    const ids = cobros.map((c) => c.id);
    const [medios, aplic] = await Promise.all([
      porLotes(ids, (l) => all<{ cobro_id: string; medio: string; importe: number; cuenta_id: string | null }>(ctx.db, `SELECT cm.cobro_id, cm.medio, cm.importe, COALESCE((SELECT m.cuenta_id FROM banco_movimientos m WHERE m.taller_id = cm.taller_id AND m.origen_tipo = 'cobro_medio' AND m.origen_id = cm.id), cm.cuenta_id) AS cuenta_id FROM cobro_medios cm WHERE cm.taller_id = ? AND cm.cobro_id IN (${marcas(l)})`, ctx.tallerId, ...l)),
      porLotes(ids, (l) => all<{ cobro_id: string; importe: number }>(ctx.db, `SELECT cobro_id, SUM(importe) AS importe FROM cobro_aplicaciones WHERE taller_id = ? AND cobro_id IN (${marcas(l)}) GROUP BY cobro_id`, ctx.tallerId, ...l)),
    ]);
    return cobros.map((c) => {
      const esAnticipo = c.tipo === 'anticipo';
      const aplicado = esAnticipo ? 0 : aplic.find((a) => a.cobro_id === c.id)?.importe ?? 0;
      const lineas: LineaIn[] = medios.filter((m) => m.cobro_id === c.id).map((m) => debe(cuentaMedio(ctx, m.medio, m.cuenta_id), m.importe, m.medio));
      lineas.push(haber(ctx.rol('deudores'), aplicado), haber(ctx.rol('anticipos'), c.total - aplicado));
      return armar(ctx, {
        origenTipo: 'cobro', origenId: c.id, fecha: c.fecha, usuarioId: c.usuario_id, orden: c.created_at, createdAt: c.created_at,
        descripcion: `${esAnticipo ? 'Anticipo' : 'Cobro'} #${c.numero} · ${c.cliente}`,
      }, lineas);
    });
  },
  anulados: (ctx, limite) => anuladosPorAuditoria(ctx, 'cobro', 'cobros', "t.estado = 'anulado'", 'cobro', limite),
  cobertura: { sql: 'SELECT COUNT(*) AS docs FROM cobros WHERE taller_id = ?' },
};

// ───────────────────────── Aplicación de saldo a favor ─────────────────────────
const creditoAplicacion: FuenteDef = {
  tipo: 'credito_aplicacion', prioridad: 30, etiqueta: 'Aplicaciones de saldo a favor',
  async pendientes(ctx, limite) {
    const filas = await all<{ id: string; fecha: string; created_at: string; usuario_id: string | null; importe: number; origen_tipo: string; origen_numero: number | null; venta_numero: number; cliente: string }>(
      ctx.db,
      `SELECT ca.id, ca.fecha, ca.created_at, ca.usuario_id, ca.importe, ca.origen_tipo, ve.numero AS venta_numero, c.nombre AS cliente,
              CASE ca.origen_tipo WHEN 'anticipo' THEN (SELECT co.numero FROM cobros co WHERE co.taller_id = ca.taller_id AND co.id = ca.origen_id)
                                  ELSE (SELECT d.numero FROM devoluciones d WHERE d.taller_id = ca.taller_id AND d.id = ca.origen_id) END AS origen_numero
         FROM credito_aplicaciones ca
         JOIN ventas ve ON ve.taller_id = ca.taller_id AND ve.id = ca.venta_id
         JOIN clientes c ON c.taller_id = ve.taller_id AND c.id = ve.cliente_id
        WHERE ca.taller_id = ? AND ${sinAsiento('ca', 'credito_aplicacion', 'alta')} ORDER BY ca.fecha, ca.created_at LIMIT ?`,
      ctx.tallerId, limite,
    );
    return filas.map((f) =>
      armar(ctx, {
        origenTipo: 'credito_aplicacion', origenId: f.id, fecha: f.fecha, usuarioId: f.usuario_id, orden: f.created_at, createdAt: f.created_at,
        descripcion: `Aplicación de ${f.origen_tipo === 'anticipo' ? 'anticipo' : 'crédito de devolución'} #${num(f.origen_numero)} al comprobante #${f.venta_numero} · ${f.cliente}`,
      }, [debe(ctx.rol('anticipos'), f.importe), haber(ctx.rol('deudores'), f.importe)]),
    );
  },
  async anulados(ctx, limite) {
    const filas = await all<{ id: string; created_at: string }>(
      ctx.db,
      `SELECT t.id, t.created_at FROM credito_aplicaciones t WHERE t.taller_id = ? AND t.estado = 'anulada' AND ${sinAsiento('t', 'credito_aplicacion', 'anulacion')} ORDER BY t.created_at LIMIT ?`,
      ctx.tallerId, limite,
    );
    if (!filas.length) return [];
    const aud = await all<{ detalle: string | null; created_at: string; usuario_id: string | null }>(ctx.db, "SELECT detalle, created_at, usuario_id FROM auditoria WHERE taller_id = ? AND accion = 'anular_aplicacion_credito'", ctx.tallerId);
    return filas.map((f) => {
      const a = aud.find((x) => x.detalle?.includes(`"aplicacion_id":"${f.id}"`));
      return { origenId: f.id, fecha: a ? fechaAR(a.created_at) : null, usuarioId: a?.usuario_id ?? null, orden: a?.created_at ?? f.created_at };
    });
  },
  cobertura: { sql: 'SELECT COUNT(*) AS docs FROM credito_aplicaciones WHERE taller_id = ?' },
};

// ───────────────────────── Devoluciones ─────────────────────────
const devolucion: FuenteDef = {
  tipo: 'devolucion', prioridad: 40, etiqueta: 'Devoluciones (notas de crédito internas)',
  async pendientes(ctx, limite) {
    const ds = await all<{ id: string; numero: number; fecha: string; created_at: string; usuario_id: string | null; total: number; iva: number; a_deuda: number; liberado: number; venta_numero: number; cliente: string }>(
      ctx.db,
      `SELECT d.id, d.numero, d.fecha, d.created_at, d.usuario_id, d.total, d.iva, d.a_deuda, d.liberado, ve.numero AS venta_numero, c.nombre AS cliente
         FROM devoluciones d JOIN ventas ve ON ve.taller_id = d.taller_id AND ve.id = d.venta_id JOIN clientes c ON c.taller_id = d.taller_id AND c.id = d.cliente_id
        WHERE d.taller_id = ? AND ${sinAsiento('d', 'devolucion', 'alta')} ORDER BY d.fecha, d.created_at LIMIT ?`,
      ctx.tallerId, limite,
    );
    const items = await porLotes(ds.map((d) => d.id), (l) =>
      all<{ devolucion_id: string; tipo: string; cantidad: number; importe_neto: number; costo_unitario: number | null; reingresa: number }>(
        ctx.db, `SELECT devolucion_id, tipo, cantidad, importe_neto, costo_unitario, reingresa FROM devolucion_items WHERE taller_id = ? AND devolucion_id IN (${marcas(l)})`, ctx.tallerId, ...l,
      ),
    );
    return ds.map((d) => {
      const its = items.filter((i) => i.devolucion_id === d.id);
      let rep = 0, serv = 0, costo = 0, sinCosto = 0;
      for (const i of its) {
        if (i.tipo === 'articulo') {
          rep += i.importe_neto;
          if (i.reingresa) {
            if (i.costo_unitario == null) sinCosto++;
            else costo += Math.round(i.cantidad * i.costo_unitario);
          }
        } else serv += i.importe_neto;
      }
      const lineas: LineaIn[] = [
        debe(ctx.rol('devol_repuestos'), rep),
        debe(ctx.rol('devol_servicios'), serv),
        debe(ctx.rol('iva_debito'), d.iva),
        haber(ctx.rol('deudores'), d.a_deuda),
        haber(ctx.rol('anticipos'), d.liberado),
        // Lo que vuelve al inventario recupera su costo; lo dañado o ya instalado sigue siendo costo.
        debe(ctx.rol('inventario'), costo),
        haber(ctx.rol('costo_repuestos'), costo),
      ];
      return armar(ctx, {
        origenTipo: 'devolucion', origenId: d.id, fecha: d.fecha, usuarioId: d.usuario_id, orden: d.created_at, createdAt: d.created_at,
        descripcion: `Devolución #${d.numero} del comprobante #${d.venta_numero} · ${d.cliente}`,
        costoIncompleto: sinCosto > 0,
        advertencia: sinCosto > 0 ? `Costo histórico no disponible en ${sinCosto} renglón(es) que reingresaron al inventario: la recuperación de costo está incompleta` : null,
      }, lineas);
    });
  },
  async anulados(ctx, limite) {
    const filas = await all<{ id: string; anulada_at: string | null; anulada_por: string | null; created_at: string }>(
      ctx.db,
      `SELECT t.id, t.anulada_at, t.anulada_por, t.created_at FROM devoluciones t WHERE t.taller_id = ? AND t.estado = 'anulada' AND ${sinAsiento('t', 'devolucion', 'anulacion')} ORDER BY t.created_at LIMIT ?`,
      ctx.tallerId, limite,
    );
    return filas.map((f) => ({ origenId: f.id, fecha: f.anulada_at ? fechaAR(f.anulada_at) : null, usuarioId: f.anulada_por, orden: f.anulada_at ?? f.created_at }));
  },
  cobertura: { sql: 'SELECT COUNT(*) AS docs FROM devoluciones WHERE taller_id = ?' },
};

// ───────────────────────── Reintegros ─────────────────────────
const reintegro: FuenteDef = {
  tipo: 'reintegro', prioridad: 50, etiqueta: 'Reintegros de dinero a clientes',
  async pendientes(ctx, limite) {
    const rs = await all<{ id: string; numero: number; fecha: string; created_at: string; usuario_id: string | null; total: number; cliente: string; origen_tipo: string }>(
      ctx.db,
      `SELECT r.id, r.numero, r.fecha, r.created_at, r.usuario_id, r.total, r.origen_tipo, c.nombre AS cliente
         FROM reintegros r JOIN clientes c ON c.taller_id = r.taller_id AND c.id = r.cliente_id
        WHERE r.taller_id = ? AND ${sinAsiento('r', 'reintegro', 'alta')} ORDER BY r.fecha, r.created_at LIMIT ?`,
      ctx.tallerId, limite,
    );
    const medios = await porLotes(rs.map((r) => r.id), (l) =>
      all<{ reintegro_id: string; medio: string; importe: number; cuenta_id: string | null }>(ctx.db, `SELECT rm.reintegro_id, rm.medio, rm.importe, COALESCE((SELECT m.cuenta_id FROM banco_movimientos m WHERE m.taller_id = rm.taller_id AND m.origen_tipo = 'reintegro_medio' AND m.origen_id = rm.id), rm.cuenta_id) AS cuenta_id FROM reintegro_medios rm WHERE rm.taller_id = ? AND rm.reintegro_id IN (${marcas(l)})`, ctx.tallerId, ...l),
    );
    return rs.map((r) => {
      const lineas: LineaIn[] = [debe(ctx.rol('anticipos'), r.total), ...medios.filter((m) => m.reintegro_id === r.id).map((m) => haber(cuentaMedio(ctx, m.medio, m.cuenta_id), m.importe, m.medio))];
      return armar(ctx, {
        origenTipo: 'reintegro', origenId: r.id, fecha: r.fecha, usuarioId: r.usuario_id, orden: r.created_at, createdAt: r.created_at,
        descripcion: `Reintegro #${r.numero} (${r.origen_tipo === 'anticipo' ? 'anticipo' : 'devolución'}) · ${r.cliente}`,
      }, lineas);
    });
  },
  anulados: (ctx, limite) => anuladosPorAuditoria(ctx, 'reintegro', 'reintegros', "t.estado = 'anulado'", 'reintegro', limite),
  cobertura: { sql: 'SELECT COUNT(*) AS docs FROM reintegros WHERE taller_id = ?' },
};

// ───────────────────────── Compras ─────────────────────────
const compra: FuenteDef = {
  tipo: 'compra', prioridad: 60, etiqueta: 'Compras de repuestos',
  async pendientes(ctx, limite) {
    const cs = await all<{ id: string; numero: number; fecha: string; created_at: string; usuario_id: string | null; neto: number; iva: number; otros: number; total: number; proveedor: string }>(
      ctx.db,
      `SELECT co.id, co.numero, co.fecha, co.created_at, co.created_by AS usuario_id, co.neto, co.iva, co.otros, co.total, p.nombre AS proveedor
         FROM compras co JOIN proveedores p ON p.taller_id = co.taller_id AND p.id = co.proveedor_id
        WHERE co.taller_id = ? AND ${sinAsiento('co', 'compra', 'alta')} ORDER BY co.fecha, co.created_at LIMIT ?`,
      ctx.tallerId, limite,
    );
    return cs.map((c) =>
      armar(ctx, {
        origenTipo: 'compra', origenId: c.id, fecha: c.fecha, usuarioId: c.usuario_id, orden: c.created_at, createdAt: c.created_at, descripcion: `Compra #${c.numero} · ${c.proveedor}`,
      }, [debe(ctx.rol('inventario'), c.neto), debe(ctx.rol('iva_credito'), c.iva), debe(ctx.rol('otros_tributos_compras'), c.otros), haber(ctx.rol('proveedores'), c.total)]),
    );
  },
  anulados: (ctx, limite) => anuladosPorAuditoria(ctx, 'compra', 'compras', "t.estado = 'anulada'", 'compra', limite),
  cobertura: { sql: 'SELECT COUNT(*) AS docs FROM compras WHERE taller_id = ?' },
};

// ───────────────────────── Recepciones de mercadería ─────────────────────────
const recepcion: FuenteDef = {
  tipo: 'recepcion', prioridad: 70, etiqueta: 'Recepciones de mercadería',
  async pendientes(ctx, limite) {
    const rs = await all<{ id: string; numero: number; fecha: string; created_at: string; usuario_id: string | null; proveedor: string }>(
      ctx.db,
      `SELECT r.id, r.numero, r.fecha, r.created_at, r.usuario_id, p.nombre AS proveedor
         FROM recepciones r JOIN proveedores p ON p.taller_id = r.taller_id AND p.id = r.proveedor_id
        WHERE r.taller_id = ? AND ${sinAsiento('r', 'recepcion', 'alta')} ORDER BY r.fecha, r.created_at LIMIT ?`,
      ctx.tallerId, limite,
    );
    const items = await porLotes(rs.map((r) => r.id), (l) =>
      all<{ recepcion_id: string; cantidad: number; costo_unitario: number }>(ctx.db, `SELECT recepcion_id, cantidad, costo_unitario FROM recepcion_items WHERE taller_id = ? AND recepcion_id IN (${marcas(l)})`, ctx.tallerId, ...l),
    );
    return rs.map((r) => {
      const valor = items.filter((i) => i.recepcion_id === r.id).reduce((a, i) => a + Math.round(i.cantidad * i.costo_unitario), 0);
      return armar(ctx, {
        origenTipo: 'recepcion', origenId: r.id, fecha: r.fecha, usuarioId: r.usuario_id, orden: r.created_at, createdAt: r.created_at, descripcion: `Recepción de mercadería #${r.numero} · ${r.proveedor}`,
      }, [debe(ctx.rol('inventario'), valor), haber(ctx.rol('mercaderia_a_facturar'), valor)]);
    });
  },
  anulados: (ctx, limite) => anuladosPorAuditoria(ctx, 'recepcion', 'recepciones', "t.estado = 'anulada'", 'recepcion', limite),
  cobertura: { sql: 'SELECT COUNT(*) AS docs FROM recepciones WHERE taller_id = ?' },
};

// ───────────────────────── Facturas y notas de crédito de proveedores ─────────────────────────
// La factura asociada a una compra documenta una deuda que la compra ya registró: no genera asiento (igual que en la cuenta corriente del proveedor).
const facturaProveedor: FuenteDef = {
  tipo: 'factura_proveedor', prioridad: 80, etiqueta: 'Facturas y notas de crédito de proveedores',
  async pendientes(ctx, limite) {
    const fs = await all<{
      id: string; numero: number; tipo: string; nro_comprobante: string; fecha: string; created_at: string; usuario_id: string | null; neto_gravado: number; no_gravado: number; iva_21: number;
      iva_10_5: number; iva_27: number; otros_tributos: number; total: number; orden_compra_id: string | null; proveedor: string;
    }>(
      ctx.db,
      `SELECT f.id, f.numero, f.tipo, f.nro_comprobante, f.fecha, f.created_at, f.created_by AS usuario_id, f.neto_gravado, f.no_gravado, f.iva_21, f.iva_10_5, f.iva_27, f.otros_tributos, f.total, f.orden_compra_id, p.nombre AS proveedor
         FROM facturas_proveedor f JOIN proveedores p ON p.taller_id = f.taller_id AND p.id = f.proveedor_id
        WHERE f.taller_id = ? AND (f.compra_id IS NULL OR f.tipo LIKE 'nota_credito%') AND ${sinAsiento('f', 'factura_proveedor', 'alta')} ORDER BY f.fecha, f.created_at LIMIT ?`,
      ctx.tallerId, limite,
    );
    return fs.map((f) => {
      const esNC = f.tipo.startsWith('nota_credito');
      const neto = f.neto_gravado + f.no_gravado;
      const iva = f.iva_21 + f.iva_10_5 + f.iva_27;
      const lineas: LineaIn[] = esNC
        ? [debe(ctx.rol('proveedores'), f.total), haber(ctx.rol('bonif_proveedores'), neto), haber(ctx.rol('iva_credito'), iva), haber(ctx.rol('otros_tributos_compras'), f.otros_tributos)]
        : [
            debe(f.orden_compra_id ? ctx.rol('mercaderia_a_facturar') : ctx.rol('compras_sin_stock'), neto),
            debe(ctx.rol('iva_credito'), iva), debe(ctx.rol('otros_tributos_compras'), f.otros_tributos), haber(ctx.rol('proveedores'), f.total),
          ];
      return armar(ctx, {
        origenTipo: 'factura_proveedor', origenId: f.id, fecha: f.fecha, usuarioId: f.usuario_id, orden: f.created_at, createdAt: f.created_at,
        descripcion: `${esNC ? 'Nota de crédito' : 'Factura'} de proveedor ${f.nro_comprobante} · ${f.proveedor}`,
      }, lineas);
    });
  },
  anulados: (ctx, limite) => anuladosPorAuditoria(ctx, 'factura_proveedor', 'facturas_proveedor', "t.estado = 'anulada' AND (t.compra_id IS NULL OR t.tipo LIKE 'nota_credito%')", 'factura_proveedor', limite),
  cobertura: { sql: "SELECT COUNT(*) AS docs FROM facturas_proveedor WHERE taller_id = ? AND (compra_id IS NULL OR tipo LIKE 'nota_credito%')" },
};

// ───────────────────────── Pagos a proveedores ─────────────────────────
const pagoProveedor: FuenteDef = {
  tipo: 'pago_proveedor', prioridad: 90, etiqueta: 'Pagos a proveedores',
  async pendientes(ctx, limite) {
    const ps = await all<{ id: string; numero: number; fecha: string; created_at: string; usuario_id: string | null; importe: number; medio: string; cuenta_id: string | null; proveedor: string; cheque_dir: string | null; endosado: string | null }>(
      ctx.db,
      `SELECT pp.id, pp.numero, pp.fecha, pp.created_at, pp.usuario_id, pp.importe, pp.medio, COALESCE((SELECT m.cuenta_id FROM banco_movimientos m WHERE m.taller_id = pp.taller_id AND m.origen_tipo = 'pago_proveedor' AND m.origen_id = pp.id), pp.cuenta_id) AS cuenta_id, p.nombre AS proveedor,
              (SELECT ch.direccion FROM cheques ch WHERE ch.taller_id = pp.taller_id AND ch.origen_tipo = 'pago_proveedor' AND ch.origen_id = pp.id LIMIT 1) AS cheque_dir,
              (SELECT ch.origen_tipo FROM cheques ch WHERE ch.taller_id = pp.taller_id AND ch.entrega_pago_id = pp.id LIMIT 1) AS endosado
         FROM pagos_proveedor pp JOIN proveedores p ON p.taller_id = pp.taller_id AND p.id = pp.proveedor_id
        WHERE pp.taller_id = ? AND ${sinAsiento('pp', 'pago_proveedor', 'alta')} ORDER BY pp.fecha, pp.created_at LIMIT ?`,
      ctx.tallerId, limite,
    );
    return ps.map((p) =>
      armar(ctx, {
        origenTipo: 'pago_proveedor', origenId: p.id, fecha: p.fecha, usuarioId: p.usuario_id, orden: p.created_at, createdAt: p.created_at, descripcion: `Pago #${p.numero} a ${p.proveedor}`,
      }, [
        debe(ctx.rol('proveedores'), p.importe),
        // Un cheque de terceros cargado a mano nunca pasó por Valores a depositar (no vino de un cobro): al endosarlo se reconoce como ingreso, igual que cuando se acredita.
        haber(p.endosado === 'manual' && !p.cheque_dir ? ctx.rol('otros_ingresos') : cuentaMedio(ctx, p.medio, p.cuenta_id, p.endosado && !p.cheque_dir ? 'endosado' : 'propio'), p.importe, p.medio),
      ]),
    );
  },
  anulados: (ctx, limite) => anuladosPorAuditoria(ctx, 'pago_proveedor', 'pagos_proveedor', "t.estado = 'anulado'", 'pago_proveedor', limite),
  cobertura: { sql: 'SELECT COUNT(*) AS docs FROM pagos_proveedor WHERE taller_id = ?' },
};

// ───────────────────────── Gastos ─────────────────────────
const gasto: FuenteDef = {
  tipo: 'gasto', prioridad: 100, etiqueta: 'Gastos',
  async pendientes(ctx, limite) {
    const gs = await all<{ id: string; numero: number; fecha: string; created_at: string; usuario_id: string | null; importe: number; medio: string; cuenta_id: string | null; concepto: string; cat: string; cat_tipo: string; cuenta_contable_id: string | null }>(
      ctx.db,
      `SELECT g.id, g.numero, g.fecha, g.created_at, g.usuario_id, g.importe, g.medio, COALESCE((SELECT m.cuenta_id FROM banco_movimientos m WHERE m.taller_id = g.taller_id AND m.origen_tipo = 'gasto' AND m.origen_id = g.id), g.cuenta_id) AS cuenta_id, g.concepto, cg.nombre AS cat, cg.tipo AS cat_tipo, cg.cuenta_contable_id
         FROM gastos g JOIN categorias_gasto cg ON cg.taller_id = g.taller_id AND cg.id = g.categoria_id
        WHERE g.taller_id = ? AND ${sinAsiento('g', 'gasto', 'alta')} ORDER BY g.fecha, g.created_at LIMIT ?`,
      ctx.tallerId, limite,
    );
    return gs.map((g) => {
      const cuentaGasto = g.cuenta_contable_id && ctx.esValida(g.cuenta_contable_id) ? g.cuenta_contable_id : ctx.rol(rolDeGasto(g.cat, g.cat_tipo));
      return armar(ctx, {
        origenTipo: 'gasto', origenId: g.id, fecha: g.fecha, usuarioId: g.usuario_id, orden: g.created_at, createdAt: g.created_at, descripcion: `Gasto #${g.numero} · ${g.cat}: ${g.concepto}`,
      }, [debe(cuentaGasto, g.importe), haber(cuentaMedio(ctx, g.medio, g.cuenta_id, 'propio'), g.importe, g.medio)]);
    });
  },
  anulados: (ctx, limite) => anuladosPorAuditoria(ctx, 'gasto', 'gastos', "t.estado = 'anulado'", 'gasto', limite),
  cobertura: { sql: 'SELECT COUNT(*) AS docs FROM gastos WHERE taller_id = ?' },
};

// ───────────────────────── Movimientos manuales de caja ─────────────────────────
// Sólo los ingresos manuales ("otros ingresos"): los cobros, pagos, gastos y reintegros ya generan su propio asiento y sus filas del libro de caja
// son el mismo hecho; los traspasos con bancos se contabilizan desde el movimiento bancario.
const cajaManual: FuenteDef = {
  tipo: 'caja_manual', prioridad: 110, etiqueta: 'Ingresos manuales de caja',
  async pendientes(ctx, limite) {
    const ms = await all<{ id: string; fecha: string; created_at: string; usuario_id: string | null; tipo: string; medio: string; importe: number; concepto: string }>(
      ctx.db,
      `SELECT m.id, m.fecha, m.created_at, m.usuario_id, m.tipo, m.medio, m.importe, m.concepto FROM caja_movimientos m
        WHERE m.taller_id = ? AND m.origen_tipo = 'manual' AND ${sinAsiento('m', 'caja_manual', 'alta')} ORDER BY m.fecha, m.created_at LIMIT ?`,
      ctx.tallerId, limite,
    );
    return ms.map((m) => {
      const caja = cuentaMedio(ctx, m.medio, null, 'propio');
      const lineas = m.tipo === 'ingreso' ? [debe(caja, m.importe), haber(ctx.rol('otros_ingresos'), m.importe)] : [debe(ctx.rol('gasto_varios'), m.importe), haber(caja, m.importe)];
      return armar(ctx, {
        origenTipo: 'caja_manual', origenId: m.id, fecha: m.fecha, usuarioId: m.usuario_id, orden: m.created_at, createdAt: m.created_at, descripcion: `${m.tipo === 'ingreso' ? 'Ingreso' : 'Egreso'} manual de caja: ${m.concepto}`,
      }, lineas);
    });
  },
  anulados: (ctx, limite) => anuladosPorReverso(ctx, 'caja_manual', 'caja_movimientos', "t.origen_tipo = 'manual'", limite),
  cobertura: { sql: "SELECT COUNT(*) AS docs FROM caja_movimientos WHERE taller_id = ? AND origen_tipo = 'manual'" },
};

// ───────────────────────── Movimientos bancarios propios ─────────────────────────
// Los espejos bancarios de cobros, pagos, gastos y reintegros no se contabilizan acá: su dinero ya está en el asiento del documento.
const ORIGENES_BANCO = "'manual','deposito','extraccion','ajuste','cheque','cheque_comision','transferencia_sal','transferencia_ent'";
const bancoMov: FuenteDef = {
  tipo: 'banco_mov', prioridad: 120, etiqueta: 'Movimientos bancarios (depósitos, transferencias, comisiones, cheques)',
  async pendientes(ctx, limite) {
    const ms = await all<{ id: string; fecha: string; created_at: string; usuario_id: string | null; cuenta_id: string; tipo: string; importe: number; concepto: string; origen_tipo: string; afecta_resultado: number }>(
      ctx.db,
      `SELECT m.id, m.fecha, m.created_at, m.usuario_id, m.cuenta_id, m.tipo, m.importe, m.concepto, m.origen_tipo, m.afecta_resultado
         FROM banco_movimientos m JOIN cuentas_bancarias cb ON cb.taller_id = m.taller_id AND cb.id = m.cuenta_id AND cb.moneda = 'ARS'
        WHERE m.taller_id = ? AND m.origen_tipo IN (${ORIGENES_BANCO}) AND ${sinAsiento('m', 'banco_mov', 'alta')} ORDER BY m.fecha, m.created_at LIMIT ?`,
      ctx.tallerId, limite,
    );
    return ms.map((m) => {
      const banco = ctx.banco(m.cuenta_id);
      if (!banco) return { kind: 'omision', origenTipo: 'banco_mov', origenId: m.id, evento: 'alta', tipo: 'error', motivo: 'La cuenta bancaria no tiene cuenta contable' } as Omision;
      const ing = m.tipo === 'ingreso';
      let contra: string;
      if (m.origen_tipo === 'deposito' || m.origen_tipo === 'extraccion') contra = ctx.rol('caja_efectivo');
      else if (m.origen_tipo.startsWith('transferencia')) contra = ctx.rol('transferencias_transito');
      else if (m.origen_tipo === 'ajuste') contra = ctx.rol('ajustes_bancarios');
      else if (m.origen_tipo === 'cheque' && !m.afecta_resultado) contra = ing ? ctx.rol('valores_depositar') : ctx.rol('cheques_emitidos');
      else if (m.origen_tipo === 'cheque') contra = ing ? ctx.rol('otros_ingresos') : ctx.rol('gasto_varios');
      else contra = ing ? ctx.rol('ingresos_bancarios') : ctx.rol('gastos_bancarios'); // manual / comisión de cheque rechazado
      return armar(ctx, {
        origenTipo: 'banco_mov', origenId: m.id, fecha: m.fecha, usuarioId: m.usuario_id, orden: m.created_at, createdAt: m.created_at, descripcion: m.concepto,
      }, ing ? [debe(banco, m.importe), haber(contra, m.importe)] : [debe(contra, m.importe), haber(banco, m.importe)]);
    });
  },
  anulados: (ctx, limite) => anuladosPorReverso(ctx, 'banco_mov', 'banco_movimientos', `t.origen_tipo IN (${ORIGENES_BANCO}) AND EXISTS (SELECT 1 FROM cuentas_bancarias cb WHERE cb.taller_id = t.taller_id AND cb.id = t.cuenta_id AND cb.moneda = 'ARS')`, limite),
  cobertura: { sql: `SELECT COUNT(*) AS docs FROM banco_movimientos m WHERE m.taller_id = ? AND m.origen_tipo IN (${ORIGENES_BANCO}) AND EXISTS (SELECT 1 FROM cuentas_bancarias cb WHERE cb.taller_id = m.taller_id AND cb.id = m.cuenta_id AND cb.moneda = 'ARS')` },
};

// ───────────────────────── Ajustes de inventario (impacto patrimonial) ─────────────────────────
const COND_STOCK_AJUSTE = "(sm.origen_tipo IN ('manual','conteo') OR (sm.origen_tipo IS NULL AND sm.tipo = 'entrada' AND sm.notas = 'Stock inicial')) AND COALESCE(sm.motivo, '') <> 'transferencia'";
// Sólo los movimientos manuales y los conteos físicos: las compras, ventas, consumos de OT y devoluciones ya están en el asiento de su documento
// y las transferencias entre depósitos no cambian el valor del inventario.
const stockAjuste: FuenteDef = {
  tipo: 'stock_ajuste', prioridad: 130, etiqueta: 'Ajustes de inventario (manuales y conteos)',
  async pendientes(ctx, limite) {
    const ms = await all<{ id: string; created_at: string; usuario_id: string | null; tipo: string; cantidad: number; costo_unitario: number | null; motivo: string | null; origen_tipo: string; articulo: string }>(
      ctx.db,
      `SELECT sm.id, sm.created_at, sm.usuario_id, sm.tipo, sm.cantidad, sm.costo_unitario, sm.motivo, sm.origen_tipo, a.nombre AS articulo
         FROM stock_movimientos sm JOIN articulos a ON a.taller_id = sm.taller_id AND a.id = sm.articulo_id
        WHERE sm.taller_id = ? AND ${COND_STOCK_AJUSTE} AND ${sinAsiento('sm', 'stock_ajuste', 'alta')} ORDER BY sm.created_at LIMIT ?`,
      ctx.tallerId, limite,
    );
    return ms.map((m) => {
      const valor = Math.round(Math.abs(m.cantidad) * (m.costo_unitario ?? 0));
      const entra = m.cantidad > 0;
      const contra = entra && m.tipo === 'entrada' ? ctx.rol('entradas_stock_sin_compra') : ctx.rol('diferencias_inventario');
      const motivo = m.origen_tipo === 'conteo' ? 'conteo físico' : m.origen_tipo == null ? 'stock inicial del artículo' : m.motivo ?? m.tipo;
      return armar(ctx, {
        origenTipo: 'stock_ajuste', origenId: m.id, fecha: fechaAR(m.created_at), usuarioId: m.usuario_id, orden: m.created_at, createdAt: m.created_at,
        descripcion: `Ajuste de inventario (${motivo}): ${m.articulo} ${entra ? '+' : '−'}${Math.abs(m.cantidad)}`,
      }, entra ? [debe(ctx.rol('inventario'), valor), haber(contra, valor)] : [debe(contra, valor), haber(ctx.rol('inventario'), valor)]);
    });
  },
  cobertura: { sql: `SELECT COUNT(*) AS docs FROM stock_movimientos sm WHERE sm.taller_id = ? AND ${COND_STOCK_AJUSTE}` },
};

// ───────────────────────── Saldos iniciales conocidos ─────────────────────────
// Sólo lo que el sistema registra como saldo inicial: cuentas bancarias en pesos y la primera caja. Los demás saldos iniciales (inventario, deudas
// anteriores al uso de Fierro) NO se inventan: se cargan con un asiento manual y mientras tanto el control los marca como no determinados.
const aperturaBanco: FuenteDef = {
  tipo: 'apertura_banco', prioridad: 1, etiqueta: 'Saldos iniciales de cuentas bancarias',
  async pendientes(ctx, limite) {
    const cs = await all<{ id: string; nombre: string; saldo_inicial: number; fecha: string | null; created_at: string }>(
      ctx.db,
      `SELECT cb.id, cb.nombre, cb.saldo_inicial, cb.fecha_saldo_inicial AS fecha, cb.created_at FROM cuentas_bancarias cb
        WHERE cb.taller_id = ? AND cb.moneda = 'ARS' AND cb.saldo_inicial <> 0 AND ${sinAsiento('cb', 'apertura_banco', 'alta')} LIMIT ?`,
      ctx.tallerId, limite,
    );
    return cs.map((c) => {
      const banco = ctx.banco(c.id);
      if (!banco) return { kind: 'omision', origenTipo: 'apertura_banco', origenId: c.id, evento: 'alta', tipo: 'error', motivo: 'La cuenta bancaria no tiene cuenta contable' } as Omision;
      const imp = Math.abs(c.saldo_inicial);
      return armar(ctx, {
        origenTipo: 'apertura_banco', origenId: c.id, fecha: c.fecha ?? fechaAR(c.created_at), usuarioId: null, orden: '0' + c.created_at, createdAt: c.created_at,
        descripcion: `Saldo inicial de la cuenta bancaria ${c.nombre}`,
      }, c.saldo_inicial > 0 ? [debe(banco, imp), haber(ctx.rol('apertura'), imp)] : [debe(ctx.rol('apertura'), imp), haber(banco, imp)]);
    });
  },
  cobertura: { sql: "SELECT COUNT(*) AS docs FROM cuentas_bancarias WHERE taller_id = ? AND moneda = 'ARS' AND saldo_inicial <> 0" },
};

const aperturaCaja: FuenteDef = {
  tipo: 'apertura_caja', prioridad: 2, etiqueta: 'Saldo inicial de caja',
  async pendientes(ctx, limite) {
    const cs = await all<{ id: string; numero: number; fecha: string; saldo_inicial: number; abierta_at: string; abierta_por: string | null }>(
      ctx.db,
      `SELECT cs.id, cs.numero, cs.fecha, cs.saldo_inicial, cs.abierta_at, cs.abierta_por FROM caja_sesiones cs
        WHERE cs.taller_id = ? AND cs.saldo_inicial > 0 AND cs.numero = (SELECT MIN(numero) FROM caja_sesiones WHERE taller_id = cs.taller_id) AND ${sinAsiento('cs', 'apertura_caja', 'alta')} LIMIT ?`,
      ctx.tallerId, limite,
    );
    return cs.map((c) =>
      armar(ctx, {
        origenTipo: 'apertura_caja', origenId: c.id, fecha: c.fecha, usuarioId: c.abierta_por, orden: '0' + c.abierta_at, createdAt: c.abierta_at, descripcion: `Efectivo inicial de la primera caja (#${c.numero})`,
      }, [debe(ctx.rol('caja_efectivo'), c.saldo_inicial), haber(ctx.rol('apertura'), c.saldo_inicial)]),
    );
  },
  cobertura: { sql: "SELECT COUNT(*) AS docs FROM caja_sesiones cs WHERE cs.taller_id = ? AND cs.saldo_inicial > 0 AND cs.numero = (SELECT MIN(numero) FROM caja_sesiones WHERE taller_id = cs.taller_id)" },
};

/** Saldos de apertura de proveedores (migración desde otro sistema): deuda inicial contra el patrimonio, NUNCA contra resultados ni compras. */
const aperturaProveedores: FuenteDef = {
  tipo: 'apertura_proveedores', prioridad: 3, etiqueta: 'Saldos de apertura de proveedores',
  async pendientes(ctx, limite) {
    const as = await all<{ id: string; numero: number; fecha_corte: string; created_at: string; usuario_id: string | null; total: number; origen: string }>(
      ctx.db,
      `SELECT ap.id, ap.numero, ap.fecha_corte, ap.created_at, ap.usuario_id, ap.total, ap.origen FROM aperturas_saldos ap
        WHERE ap.taller_id = ? AND ap.tipo = 'proveedores' AND ${sinAsiento('ap', 'apertura_proveedores', 'alta')} ORDER BY ap.fecha_corte, ap.created_at LIMIT ?`,
      ctx.tallerId, limite,
    );
    return as.map((a) => {
      const imp = Math.abs(a.total);
      return armar(ctx, {
        origenTipo: 'apertura_proveedores', origenId: a.id, fecha: a.fecha_corte, usuarioId: a.usuario_id, orden: '0' + a.created_at, createdAt: a.created_at,
        descripcion: `Saldos de apertura de proveedores #${a.numero} (corte ${a.fecha_corte}) · ${a.origen}`,
      }, a.total > 0 ? [debe(ctx.rol('apertura'), imp), haber(ctx.rol('proveedores'), imp)] : [debe(ctx.rol('proveedores'), imp), haber(ctx.rol('apertura'), imp)]);
    });
  },
  anulados: (ctx, limite) => anuladosPorAuditoria(ctx, 'apertura_proveedores', 'aperturas_saldos', "t.estado = 'anulada' AND t.tipo = 'proveedores'", 'apertura_saldos', limite),
  cobertura: { sql: "SELECT COUNT(*) AS docs FROM aperturas_saldos WHERE taller_id = ? AND tipo = 'proveedores'" },
};

// ───────────────────────── Anulaciones ─────────────────────────
/** Anulaciones cuyo momento y responsable están en la auditoría (acción `anular` de la entidad). */
async function anuladosPorAuditoria(ctx: Ctx, tipo: string, tabla: string, condicion: string, entidad: string, limite: number): Promise<Anulacion[]> {
  const filas = await all<{ id: string; created_at: string }>(
    ctx.db,
    `SELECT t.id, t.created_at FROM ${tabla} t WHERE t.taller_id = ? AND ${condicion} AND ${sinAsiento('t', tipo, 'anulacion')} ORDER BY t.created_at LIMIT ?`,
    ctx.tallerId, limite,
  );
  if (!filas.length) return [];
  const aud = await porLotes(filas.map((f) => f.id), (l) =>
    all<{ entidad_id: string; created_at: string; usuario_id: string | null }>(
      ctx.db,
      `SELECT entidad_id, MAX(created_at) AS created_at, usuario_id FROM auditoria WHERE taller_id = ? AND entidad = ? AND accion = 'anular' AND entidad_id IN (${marcas(l)}) GROUP BY entidad_id`,
      ctx.tallerId, entidad, ...l,
    ),
  );
  return filas.map((f) => {
    const a = aud.find((x) => x.entidad_id === f.id);
    return { origenId: f.id, fecha: a ? fechaAR(a.created_at) : null, usuarioId: a?.usuario_id ?? null, orden: a?.created_at ?? f.created_at };
  });
}

/** Anulaciones de movimientos de caja o banco: el contra-asiento del libro (origen `reverso`) trae la fecha y el responsable. */
async function anuladosPorReverso(ctx: Ctx, tipo: string, tabla: string, condicion: string, limite: number): Promise<Anulacion[]> {
  const filas = await all<{ id: string; fecha: string; usuario_id: string | null; created_at: string }>(
    ctx.db,
    `SELECT t.id, r.fecha, r.usuario_id, r.created_at FROM ${tabla} t
       JOIN ${tabla} r ON r.taller_id = t.taller_id AND r.origen_tipo = 'reverso' AND r.origen_id = t.id
      WHERE t.taller_id = ? AND ${condicion} AND ${sinAsiento('t', tipo, 'anulacion')} ORDER BY r.created_at LIMIT ?`,
    ctx.tallerId, limite,
  );
  return filas.map((f) => ({ origenId: f.id, fecha: f.fecha, usuarioId: f.usuario_id, orden: f.created_at }));
}

export const FUENTES: FuenteDef[] = [
  aperturaBanco, aperturaCaja, aperturaProveedores, venta, cobro, creditoAplicacion, devolucion, reintegro, compra, recepcion, facturaProveedor, pagoProveedor, gasto, cajaManual, bancoMov, stockAjuste,
];
export const fuentePorTipo = (t: string) => FUENTES.find((f) => f.tipo === t);
