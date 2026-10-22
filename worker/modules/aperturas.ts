// Saldos de apertura de un taller que migra de otro sistema.
//
// Qué resuelve: una deuda con un proveedor que existía antes de empezar a usar Fierro no se puede cargar como una compra (entraría stock y pasaría por
// resultados) ni conviene como una factura ficticia. Acá se registra UNA VEZ por proveedor, con su fecha de corte, el sistema de origen y quién la cargó.
//  * Entra a la cuenta corriente del proveedor (se paga con los pagos de siempre, que se aplican al comprobante más antiguo) y al saldo total que se debe.
//  * En contabilidad su contrapartida es el patrimonio ("Saldos iniciales y ajustes de apertura"): no es una compra ni un gasto y no toca el estado de resultados.
//  * No se edita: se anula y se vuelve a cargar. Un proveedor no puede tener dos saldos de apertura vigentes (lo impide la base), así que reintentar o cargar
//    el mismo archivo dos veces nunca duplica la deuda.
//  * Los saldos de CLIENTES no se cargan acá todavía (ver docs/PROGRESO.md): exigen un documento de apertura que se cobre contra la cuenta corriente.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ApiError, badRequest, body, conflict, notFound, zFecha, zId, zTextoOpt } from '../lib/http';
import { all, auditar, first, guard, hoy, SEQ_VALOR, seqIncrementar, uid } from '../lib/db';
import { requirePerm } from '../lib/auth';
import { claveDocumento, normalizarTextoImport, parseCentavos, texto } from '../../shared/importacion';
import { paramsSaldoProveedor, SALDO_PROVEEDOR_SQL } from '../lib/proveedores';

export const aperturas = new Hono<AppEnv>();
aperturas.use('*', requirePerm('aperturas.gestionar'));

const MAX_RENGLONES = 300;
const MAX_IMPORTE = 100_000_000_000; // 1.000 millones de pesos, en centavos

const zCelda = z.union([z.string().max(300), z.number().finite(), z.null()]).optional();
const zFilaProveedor = z.object({
  n: z.number().int().min(1).max(1_000_000),
  /** Proveedor ya elegido en pantalla. */
  proveedor_id: zId.nullish(),
  /** Proveedor tal como viene de una planilla: CUIT, código anterior o nombre exacto (único). */
  proveedor: zCelda,
  importe: zCelda,
  referencia: zCelda,
  vencimiento: zCelda,
});
const zApertura = z.object({
  fecha_corte: zFecha,
  origen: z.string().trim().min(3, 'Indicá de qué sistema o planilla salen los saldos').max(200),
  notas: zTextoOpt(500),
  decimal: z.enum([',', '.']).default(','),
  filas: z.array(zFilaProveedor).min(1).max(MAX_RENGLONES),
});

function validarFechaCorte(f: string): string {
  const [y, m, d] = f.split('-').map(Number);
  if (new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) !== f) throw badRequest('La fecha de corte no existe en el calendario');
  if (f > hoy()) throw badRequest('La fecha de corte no puede ser posterior a hoy');
  if (f < '2000-01-01') throw badRequest('La fecha de corte es demasiado antigua');
  return f;
}

interface Prov {
  id: string;
  nombre: string;
  cuit: string | null;
  codigo_externo: string | null;
  activo: number;
}

export interface FilaValidada {
  n: number;
  estado: 'ok' | 'aviso' | 'error';
  proveedor_id: string | null;
  proveedor: string | null;
  importe: number | null;
  referencia: string | null;
  vencimiento: string | null;
  mensajes: string[];
}

/** Resuelve y valida las filas contra los datos del taller. NO escribe. */
async function validarFilas(db: D1Database, tallerId: string, fechaCorte: string, decimal: ',' | '.', filas: z.infer<typeof zFilaProveedor>[]) {
  const provs = await all<Prov>(db, 'SELECT id, nombre, cuit, codigo_externo, activo FROM proveedores WHERE taller_id = ?', tallerId);
  const porId = new Map(provs.map((p) => [p.id, p]));
  const vigentes = new Map(
    (await all<{ proveedor_id: string; numero: number }>(
      db,
      `SELECT i.proveedor_id, a.numero FROM aperturas_saldos_items i JOIN aperturas_saldos a ON a.taller_id = i.taller_id AND a.id = i.apertura_id WHERE i.taller_id = ? AND i.activo = 1`,
      tallerId,
    )).map((r) => [r.proveedor_id, r.numero]),
  );
  const movimientos = new Map(
    (await all<{ proveedor_id: string; n: number }>(
      db,
      `SELECT proveedor_id, SUM(n) AS n FROM (
         SELECT proveedor_id, COUNT(*) AS n FROM compras WHERE taller_id = ? AND estado = 'registrada' AND fecha <= ? GROUP BY proveedor_id
         UNION ALL SELECT proveedor_id, COUNT(*) FROM facturas_proveedor WHERE taller_id = ? AND estado = 'registrada' AND fecha <= ? GROUP BY proveedor_id
         UNION ALL SELECT proveedor_id, COUNT(*) FROM pagos_proveedor WHERE taller_id = ? AND estado = 'registrado' AND fecha <= ? GROUP BY proveedor_id
       ) GROUP BY proveedor_id`,
      tallerId, fechaCorte, tallerId, fechaCorte, tallerId, fechaCorte,
    )).map((r) => [r.proveedor_id, r.n]),
  );
  const porCuit = new Map<string, Prov[]>();
  const porCodigo = new Map<string, Prov[]>();
  const porNombre = new Map<string, Prov[]>();
  const poner = (m: Map<string, Prov[]>, k: string, p: Prov) => k && m.set(k, [...(m.get(k) ?? []), p]);
  for (const p of provs) {
    poner(porCuit, claveDocumento(p.cuit ?? '').replace(/\D/g, ''), p);
    poner(porCodigo, (p.codigo_externo ?? '').trim().toLowerCase(), p);
    poner(porNombre, normalizarTextoImport(p.nombre), p);
  }

  const vistos = new Map<string, number>();
  const res: FilaValidada[] = [];
  for (const f of filas) {
    const msgs: string[] = [];
    let error = false;
    const fallo = (m: string) => (error = true, msgs.push(m));
    let prov: Prov | null = null;
    if (f.proveedor_id) {
      prov = porId.get(f.proveedor_id) ?? null;
      if (!prov) fallo('El proveedor no existe en este taller');
    } else {
      const ref = texto(f.proveedor);
      if (!ref) fallo('Falta el proveedor');
      else {
        const digitos = ref.replace(/\D/g, '');
        const candidatos = digitos.length === 11 && /^[\d\-.\s]+$/.test(ref) ? porCuit.get(digitos) : undefined;
        const porCod = porCodigo.get(ref.toLowerCase());
        const porNom = porNombre.get(normalizarTextoImport(ref));
        const hallados = candidatos?.length ? candidatos : porCod?.length ? porCod : porNom ?? [];
        if (hallados.length === 1) prov = hallados[0];
        else if (hallados.length > 1) fallo(`"${ref}" coincide con más de un proveedor: indicá el CUIT o el código`);
        else fallo(`El proveedor "${ref}" no existe: cargalo (o importalo) antes`);
      }
    }
    const imp = parseCentavos(f.importe ?? null, decimal);
    let importe: number | null = null;
    if (imp === undefined) fallo('Falta el saldo');
    else if (Number.isNaN(imp)) fallo(`El saldo "${texto(f.importe)}" no es un importe válido`);
    else if (imp === 0) fallo('El saldo es cero: no hace falta cargarlo');
    else if (Math.abs(imp) > MAX_IMPORTE) fallo('El saldo es demasiado grande');
    else importe = imp;

    let vencimiento: string | null = null;
    const venc = texto(f.vencimiento);
    if (venc) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(venc) ?? null;
      const ok = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toISOString().slice(0, 10) === venc;
      if (!ok) fallo(`El vencimiento "${venc}" no es una fecha válida (AAAA-MM-DD)`);
      else vencimiento = venc;
    }
    const referencia = texto(f.referencia).slice(0, 120) || null;

    if (prov) {
      const antes = vistos.get(prov.id);
      if (antes) fallo(`El proveedor ya figura en la fila ${antes}: cada proveedor tiene un solo saldo de apertura`);
      else vistos.set(prov.id, f.n);
      const previa = vigentes.get(prov.id);
      if (previa) fallo(`Ya tiene un saldo de apertura vigente (apertura N° ${previa}): anulala primero si hay que rehacerla`);
    }
    let estado: FilaValidada['estado'] = error ? 'error' : 'ok';
    if (!error && prov) {
      if (!prov.activo) {
        estado = 'aviso';
        msgs.push('El proveedor está dado de baja: el saldo igual se registra');
      }
      const mov = movimientos.get(prov.id) ?? 0;
      if (mov) {
        estado = 'aviso';
        msgs.push(`Ya tiene ${mov} compra(s), factura(s) o pago(s) cargados en Fierro con fecha igual o anterior al corte: el saldo de apertura NO debe incluirlos, porque se suma a lo ya registrado`);
      }
    }
    res.push({ n: f.n, estado, proveedor_id: prov?.id ?? null, proveedor: prov?.nombre ?? null, importe, referencia, vencimiento, mensajes: msgs });
  }
  return res;
}

const resumenValidacion = (filas: FilaValidada[]) => {
  const buenas = filas.filter((f) => f.estado !== 'error');
  const deuda = buenas.filter((f) => (f.importe ?? 0) > 0).reduce((a, f) => a + (f.importe ?? 0), 0);
  const aFavor = -buenas.filter((f) => (f.importe ?? 0) < 0).reduce((a, f) => a + (f.importe ?? 0), 0);
  return {
    filas: filas.length, correctas: filas.filter((f) => f.estado === 'ok').length, con_aviso: filas.filter((f) => f.estado === 'aviso').length, con_error: filas.filter((f) => f.estado === 'error').length,
    deuda, a_favor: aFavor, total: deuda - aFavor,
    puede_confirmar: filas.length > 0 && filas.every((f) => f.estado !== 'error'),
  };
};

// ═════════════════════════ Estado de la apertura (panel) ═════════════════════════
/** Qué saldos iniciales tiene el taller y por dónde se cargan los que faltan. SOLO LECTURA. */
aperturas.get('/estado', async (c) => {
  const s = c.get('sesion');
  const t = s.tallerId;
  const [caja, bancos, stock, prov] = await Promise.all([
    first<{ numero: number; fecha: string; saldo_inicial: number; movimientos: number }>(
      c.env.DB,
      `SELECT cs.numero, cs.fecha, cs.saldo_inicial, (SELECT COUNT(*) FROM caja_movimientos WHERE taller_id = cs.taller_id) AS movimientos
         FROM caja_sesiones cs WHERE cs.taller_id = ? ORDER BY cs.numero LIMIT 1`, t,
    ),
    all<{ nombre: string; moneda: string; saldo_inicial: number; fecha_saldo_inicial: string | null; movimientos: number }>(
      c.env.DB,
      `SELECT cb.nombre, cb.moneda, cb.saldo_inicial, cb.fecha_saldo_inicial, (SELECT COUNT(*) FROM banco_movimientos m WHERE m.taller_id = cb.taller_id AND m.cuenta_id = cb.id) AS movimientos
         FROM cuentas_bancarias cb WHERE cb.taller_id = ? ORDER BY cb.nombre`, t,
    ),
    first<{ articulos: number; con_existencias: number; cargas: number }>(
      c.env.DB,
      `SELECT (SELECT COUNT(*) FROM articulos WHERE taller_id = ? AND activo = 1) AS articulos,
              (SELECT COUNT(*) FROM articulos WHERE taller_id = ? AND activo = 1 AND stock > 0) AS con_existencias,
              (SELECT COUNT(*) FROM stock_movimientos WHERE taller_id = ? AND origen_tipo = 'manual' AND tipo = 'entrada') AS cargas`, t, t, t,
    ),
    first<{ cantidad: number; total: number; ultima: string | null }>(
      c.env.DB, "SELECT COUNT(*) AS cantidad, COALESCE(SUM(total), 0) AS total, MAX(fecha_corte) AS ultima FROM aperturas_saldos WHERE taller_id = ? AND tipo = 'proveedores' AND estado = 'vigente'", t,
    ),
  ]);
  return c.json({
    caja: caja
      ? { estado: caja.saldo_inicial > 0 ? 'declarada' : 'sin_efectivo_inicial', primera_caja: caja.numero, fecha: caja.fecha, efectivo_inicial: caja.saldo_inicial, operaciones_previas: caja.movimientos }
      : { estado: 'sin_caja' },
    bancos: bancos.map((b) => ({ nombre: b.nombre, moneda: b.moneda, saldo_inicial: b.saldo_inicial, fecha: b.fecha_saldo_inicial, con_movimientos: b.movimientos > 0, se_contabiliza: b.moneda === 'ARS' })),
    inventario: { articulos: stock?.articulos ?? 0, con_existencias: stock?.con_existencias ?? 0, cargas_manuales: stock?.cargas ?? 0 },
    proveedores: { aperturas_vigentes: prov?.cantidad ?? 0, total: prov?.total ?? 0, ultimo_corte: prov?.ultima ?? null },
    clientes: { disponible: false, motivo: 'Los saldos de clientes todavía no tienen documento de apertura: exigen cobrarse contra la cuenta corriente sin pasar por ventas ni resultados. Está planificado como próxima etapa.' },
  });
});

// ═════════════════════════ Proveedores ═════════════════════════
/** Revisa un archivo o una lista de saldos sin guardar nada. */
aperturas.post('/proveedores/validar', async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zApertura.omit({ origen: true, notas: true }).extend({ origen: z.string().max(200).optional() }));
  const fecha = validarFechaCorte(d.fecha_corte);
  const filas = await validarFilas(c.env.DB, s.tallerId, fecha, d.decimal, d.filas);
  return c.json({ fecha_corte: fecha, filas, resumen: resumenValidacion(filas) });
});

aperturas.post('/proveedores', async (c) => {
  const s = c.get('sesion');
  if (!s.licenciaActiva) throw new ApiError(403, 'licencia_inactiva', 'La licencia del taller no está activa');
  const d = await body(c, zApertura.extend({ idem_key: z.string().min(8).max(80), acepta_avisos: z.boolean().default(false) }));
  const previo = await first<{ id: string; numero: number }>(c.env.DB, 'SELECT id, numero FROM aperturas_saldos WHERE taller_id = ? AND idem_key = ?', s.tallerId, d.idem_key);
  if (previo) return c.json({ ...previo, duplicado: true });
  const fecha = validarFechaCorte(d.fecha_corte);
  const filas = await validarFilas(c.env.DB, s.tallerId, fecha, d.decimal, d.filas);
  const resumen = resumenValidacion(filas);
  if (!resumen.puede_confirmar) throw new ApiError(400, 'filas_con_error', 'Hay filas con error: corregilas antes de confirmar');
  if (resumen.con_aviso && !d.acepta_avisos) throw conflict('Hay filas con avisos: revisalas y confirmalas expresamente', 'avisos_sin_confirmar');

  const id = uid();
  const total = resumen.total;
  const stmts = [
    ...seqIncrementar(c.env.DB, s.tallerId, 'apertura_saldos'),
    c.env.DB
      .prepare(
        `INSERT INTO aperturas_saldos (id, taller_id, numero, tipo, fecha_corte, origen, notas, total, cantidad, idem_key, usuario_id)
         VALUES (?, ?, ${SEQ_VALOR}, 'proveedores', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, s.tallerId, s.tallerId, 'apertura_saldos', fecha, d.origen, d.notas, total, filas.length, d.idem_key, s.usuarioId),
    ...filas.map((f) =>
      c.env.DB
        .prepare('INSERT INTO aperturas_saldos_items (id, taller_id, apertura_id, proveedor_id, importe, referencia, vencimiento) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(uid(), s.tallerId, id, f.proveedor_id, f.importe, f.referencia, f.vencimiento),
    ),
    // La suma de los renglones tiene que ser exactamente el total de la cabecera.
    guard(c.env.DB, '(SELECT COALESCE(SUM(importe), 0) FROM aperturas_saldos_items WHERE taller_id = ? AND apertura_id = ?) <> ?', s.tallerId, id, total),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'apertura_saldos', id, 'crear', { tipo: 'proveedores', fecha_corte: fecha, origen: d.origen, cantidad: filas.length, total }),
  ];
  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    const m = String(e);
    if (m.includes('idem_key')) {
      const ex = await first<{ id: string; numero: number }>(c.env.DB, 'SELECT id, numero FROM aperturas_saldos WHERE taller_id = ? AND idem_key = ?', s.tallerId, d.idem_key);
      if (ex) return c.json({ ...ex, duplicado: true });
    }
    // Otra apertura se cargó en el medio para alguno de estos proveedores: el índice único evita el doble conteo.
    if (m.includes('UNIQUE') && m.includes('proveedor_id')) throw conflict('Alguno de los proveedores ya tiene un saldo de apertura vigente. Revisá las aperturas existentes.', 'apertura_duplicada');
    throw e;
  }
  const n = await first<{ numero: number }>(c.env.DB, 'SELECT numero FROM aperturas_saldos WHERE taller_id = ? AND id = ?', s.tallerId, id);
  return c.json({ id, numero: n?.numero, total, cantidad: filas.length }, 201);
});

// ═════════════════════════ Consulta y anulación ═════════════════════════
aperturas.get('/', async (c) => {
  const s = c.get('sesion');
  return c.json(
    await all(
      c.env.DB,
      `SELECT a.id, a.numero, a.tipo, a.fecha_corte, a.origen, a.notas, a.estado, a.total, a.cantidad, a.created_at, a.anulada_at, a.motivo_anulacion, u.nombre AS usuario, ua.nombre AS anulada_por_nombre
         FROM aperturas_saldos a LEFT JOIN usuarios u ON u.taller_id = a.taller_id AND u.id = a.usuario_id LEFT JOIN usuarios ua ON ua.taller_id = a.taller_id AND ua.id = a.anulada_por
        WHERE a.taller_id = ? ORDER BY a.numero DESC LIMIT 200`,
      s.tallerId,
    ),
  );
});

aperturas.get('/:id', async (c) => {
  const s = c.get('sesion');
  const a = await first<Record<string, unknown>>(
    c.env.DB,
    `SELECT a.*, u.nombre AS usuario, ua.nombre AS anulada_por_nombre FROM aperturas_saldos a
       LEFT JOIN usuarios u ON u.taller_id = a.taller_id AND u.id = a.usuario_id LEFT JOIN usuarios ua ON ua.taller_id = a.taller_id AND ua.id = a.anulada_por
      WHERE a.taller_id = ? AND a.id = ?`,
    s.tallerId, c.req.param('id'),
  );
  if (!a) throw notFound('Apertura');
  const items = await all(
    c.env.DB,
    `SELECT i.id, i.proveedor_id, p.nombre AS proveedor, p.cuit, i.importe, i.referencia, i.vencimiento, i.activo
       FROM aperturas_saldos_items i JOIN proveedores p ON p.taller_id = i.taller_id AND p.id = i.proveedor_id WHERE i.taller_id = ? AND i.apertura_id = ? ORDER BY p.nombre COLLATE NOCASE`,
    s.tallerId, c.req.param('id'),
  );
  return c.json({ ...a, items });
});

aperturas.post('/:id/anular', async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const { motivo } = await body(c, z.object({ motivo: z.string().trim().min(3).max(300) }));
  const a = await first<{ estado: string; numero: number }>(c.env.DB, 'SELECT estado, numero FROM aperturas_saldos WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!a) throw notFound('Apertura');
  if (a.estado !== 'vigente') throw conflict('La apertura ya está anulada');
  const items = await all<{ proveedor_id: string; importe: number; nombre: string }>(
    c.env.DB,
    'SELECT i.proveedor_id, i.importe, p.nombre FROM aperturas_saldos_items i JOIN proveedores p ON p.taller_id = i.taller_id AND p.id = i.proveedor_id WHERE i.taller_id = ? AND i.apertura_id = ? AND i.activo = 1',
    s.tallerId, id,
  );
  // Anular una deuda ya pagada convertiría esos pagos en saldos a favor sin que nadie lo decida: se pide anular primero esos pagos.
  for (const it of items.filter((x) => x.importe > 0)) {
    const saldo = (await first<{ v: number }>(c.env.DB, `SELECT ${SALDO_PROVEEDOR_SQL} AS v`, ...paramsSaldoProveedor(s.tallerId, it.proveedor_id)))?.v ?? 0;
    if (saldo - it.importe < 0) throw conflict(`No se puede anular: ${it.nombre} ya tiene pagos aplicados a esta deuda. Anulá primero esos pagos.`, 'apertura_con_pagos');
  }
  try {
    await c.env.DB.batch([
      ...items.filter((x) => x.importe > 0).map((it) =>
        guard(c.env.DB, `${SALDO_PROVEEDOR_SQL} - ? < 0`, ...paramsSaldoProveedor(s.tallerId, it.proveedor_id), it.importe),
      ),
      guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM aperturas_saldos WHERE taller_id = ? AND id = ? AND estado = 'vigente')", s.tallerId, id),
      c.env.DB
        .prepare("UPDATE aperturas_saldos SET estado = 'anulada', anulada_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), anulada_por = ?, motivo_anulacion = ? WHERE taller_id = ? AND id = ? AND estado = 'vigente'")
        .bind(s.usuarioId, motivo, s.tallerId, id),
      c.env.DB.prepare('UPDATE aperturas_saldos_items SET activo = 0 WHERE taller_id = ? AND apertura_id = ?').bind(s.tallerId, id),
      auditar(c.env.DB, s.tallerId, s.usuarioId, 'apertura_saldos', id, 'anular', { motivo, numero: a.numero }),
    ]);
  } catch (e) {
    if (String(e).includes('CHECK')) throw conflict('Cambió el estado de la apertura o los pagos del proveedor mientras se anulaba: volvé a intentar', 'apertura_con_pagos');
    throw e;
  }
  return c.json({ ok: true });
});

