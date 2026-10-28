// Movimientos financieros con personas: aportes y retiros de capital, préstamos de socios, préstamos y adelantos al personal.
//
// Principios (ver docs/MOVIMIENTOS_PERSONAS.md):
//  * La PERSONA que entrega o recibe el dinero no es el operador que lo registra: se guardan las dos identidades. Una persona puede no tener acceso al ERP
//    (un empleado que sólo ficha con PIN, un socio que nunca entra al sistema).
//  * El dinero se registra UNA vez, en el libro que corresponde (caja_movimientos si es efectivo, banco_movimientos si es una cuenta bancaria), dentro del
//    MISMO batch del movimiento. No se crea ninguna caja ni libro paralelo; la contabilidad lo deriva (lib/contab/fuentes.ts › mov_persona).
//  * Un movimiento registrado no se edita. Se corrige anulándolo: contra-asiento en el libro de dinero y contable, con motivo, usuario y fecha.
//  * Las obligaciones (préstamos y adelantos) se regularizan con movimientos que apuntan a ellas; `regularizado` + CHECK impiden devolver de más aunque dos
//    personas operen a la vez. Préstamos recibidos, préstamos otorgados y adelantos son saldos distintos: nunca se netean entre sí.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, conflict, forbidden, notFound, query, zCentavos, zFecha, zId, zTextoOpt } from '../lib/http';
import { all, auditar, first, guard, like, ahora, SEQ_VALOR, seqIncrementar, uid, type Stmt } from '../lib/db';
import { requirePerm, tiene } from '../lib/auth';
import { estadoCaja, exigirCajaAbiertaSiCorresponde, guardCajaObligatoria, sentenciaReversos } from '../lib/caja';
import { guardCuentaActiva, sentenciaReversosBanco, validarCuentaOperable } from '../lib/banco';
import { fechaComercial } from '../lib/fechas';
import {
  CATEGORIAS_SISTEMA, DEF_TIPOS_FIN, DIRECCION_LABEL, estadoMovimiento, errorImporte, MONEDAS_ADMITIDAS, MONEDAS_MOVIMIENTO, OBLIGACIONES, TIPOS_FIN,
  type Obligacion, type TipoFin,
} from '../../shared/movpersonas';

export const movpersonas = new Hono<AppEnv>();

const OBLIGACIONES_SQL = OBLIGACIONES.map((o) => `'${o}'`).join(',');
/** Nombre visible de la persona: el empleado se lee del registro de personal (no se duplica); el resto, de su propia ficha. */
const NOMBRE_PERSONA = "CASE WHEN p.usuario_id IS NOT NULL THEN TRIM(u.nombre || ' ' || COALESCE(u.apellido, '')) ELSE p.nombre END";
const JOIN_PERSONA = 'JOIN personas_financieras p ON p.taller_id = m.taller_id AND p.id = m.persona_id LEFT JOIN usuarios u ON u.taller_id = p.taller_id AND u.id = p.usuario_id';
const idCategoriaSistema = (tallerId: string, clave: string) => `${tallerId}:cat:${clave}`;
const idPersonaEmpleado = (usuarioId: string) => `u:${usuarioId}`;
const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// ───────────────────────── Categorías ─────────────────────────
interface CategoriaFila {
  id: string;
  clave: string | null;
  nombre: string;
  tipo_fin: TipoFin;
  activa: number;
  sistema: number;
}

/** Las del sistema existen siempre (aunque la fila de la empresa todavía no se haya creado); las propias vienen de la base. Un GET nunca escribe. */
async function categoriasDe(db: D1Database, tallerId: string) {
  const [filas, usos] = await Promise.all([
    all<CategoriaFila>(db, 'SELECT id, clave, nombre, tipo_fin, activa, sistema FROM categorias_movimiento WHERE taller_id = ? ORDER BY nombre', tallerId),
    all<{ categoria_id: string; n: number }>(db, 'SELECT categoria_id, COUNT(*) AS n FROM movimientos_personas WHERE taller_id = ? GROUP BY categoria_id', tallerId),
  ]);
  const uso = new Map(usos.map((u) => [u.categoria_id, u.n]));
  const porClave = new Map(filas.filter((f) => f.clave).map((f) => [f.clave as string, f]));
  const sistema = CATEGORIAS_SISTEMA.map((c) => {
    const fila = porClave.get(c.clave);
    const id = fila?.id ?? idCategoriaSistema(tallerId, c.clave);
    const tipo = c.tipo;
    return {
      id, clave: c.clave, nombre: c.nombre, tipo_fin: tipo, tipo_etiqueta: tipo ? DEF_TIPOS_FIN[tipo].etiqueta : null, direccion: tipo ? DEF_TIPOS_FIN[tipo].direccion : null,
      grupo: c.grupo, activa: c.pendiente ? 0 : fila ? fila.activa : 1, sistema: 1, pendiente: c.pendiente ?? null, movimientos: uso.get(id) ?? 0,
    };
  });
  const propias = filas.filter((f) => !f.sistema).map((f) => ({
    id: f.id, clave: null, nombre: f.nombre, tipo_fin: f.tipo_fin, tipo_etiqueta: DEF_TIPOS_FIN[f.tipo_fin].etiqueta, direccion: DEF_TIPOS_FIN[f.tipo_fin].direccion,
    grupo: 'Categorías propias', activa: f.activa, sistema: 0, pendiente: null, movimientos: uso.get(f.id) ?? 0,
  }));
  return [...sistema, ...propias];
}

movpersonas.get('/categorias', requirePerm('movpersonas.ver'), async (c) => c.json(await categoriasDe(c.env.DB, c.get('sesion').tallerId)));

const zNombreCategoria = z.string().trim().min(3).max(80);

movpersonas.post('/categorias', requirePerm('movpersonas.administrar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, z.object({ nombre: zNombreCategoria, tipo_fin: z.enum(TIPOS_FIN) }));
  if (CATEGORIAS_SISTEMA.some((x) => sinTildes(x.nombre) === sinTildes(d.nombre))) throw conflict('Ya existe una categoría con ese nombre', 'duplicado');
  const id = uid();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO categorias_movimiento (id, taller_id, clave, nombre, tipo_fin, sistema, creado_por) VALUES (?, ?, NULL, ?, ?, 0, ?)').bind(id, s.tallerId, d.nombre, d.tipo_fin, s.usuarioId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'categoria_movimiento', id, 'crear', { nombre: d.nombre, tipo_fin: d.tipo_fin }),
  ]);
  return c.json((await categoriasDe(c.env.DB, s.tallerId)).find((x) => x.id === id), 201);
});

movpersonas.patch('/categorias/:id', requirePerm('movpersonas.administrar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, z.object({ nombre: zNombreCategoria.optional(), activa: z.boolean().optional() }));
  const todas = await categoriasDe(c.env.DB, s.tallerId);
  const cat = todas.find((x) => x.id === id);
  if (!cat) throw notFound('Categoría');
  if (cat.pendiente) throw conflict(`Esta categoría todavía no está disponible. ${cat.pendiente}`, 'categoria_pendiente');
  if (d.nombre !== undefined) {
    if (cat.sistema) throw conflict('Las categorías del sistema no se renombran: creá una categoría propia si necesitás otro nombre', 'categoria_sistema');
    if (todas.some((x) => x.id !== id && sinTildes(x.nombre) === sinTildes(d.nombre!))) throw conflict('Ya existe una categoría con ese nombre', 'duplicado');
  }
  const stmts: Stmt[] = [];
  if (cat.sistema) {
    // La fila de la empresa se crea la primera vez que hace falta (activar/desactivar o registrar un movimiento).
    stmts.push(asegurarCategoriaSistema(c.env.DB, s.tallerId, cat.clave as string));
  }
  if (d.nombre !== undefined) stmts.push(c.env.DB.prepare('UPDATE categorias_movimiento SET nombre = ? WHERE taller_id = ? AND id = ?').bind(d.nombre, s.tallerId, id));
  if (d.activa !== undefined) stmts.push(c.env.DB.prepare('UPDATE categorias_movimiento SET activa = ? WHERE taller_id = ? AND id = ?').bind(d.activa ? 1 : 0, s.tallerId, id));
  if (!stmts.length || (cat.sistema && stmts.length === 1)) return c.json(cat);
  stmts.push(auditar(c.env.DB, s.tallerId, s.usuarioId, 'categoria_movimiento', id, 'editar', d));
  await c.env.DB.batch(stmts);
  return c.json((await categoriasDe(c.env.DB, s.tallerId)).find((x) => x.id === id));
});

movpersonas.delete('/categorias/:id', requirePerm('movpersonas.administrar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const cat = (await categoriasDe(c.env.DB, s.tallerId)).find((x) => x.id === id);
  if (!cat) throw notFound('Categoría');
  if (cat.sistema) throw conflict('Las categorías del sistema no se eliminan; se pueden desactivar', 'categoria_sistema');
  if (cat.movimientos > 0) throw conflict('La categoría tiene movimientos registrados: no se puede eliminar (se puede desactivar)', 'categoria_con_movimientos');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM categorias_movimiento WHERE taller_id = ? AND id = ?').bind(s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'categoria_movimiento', id, 'eliminar', { nombre: cat.nombre }),
  ]);
  return c.json({ ok: true });
});

function asegurarCategoriaSistema(db: D1Database, tallerId: string, clave: string): Stmt {
  const def = CATEGORIAS_SISTEMA.find((x) => x.clave === clave);
  if (!def?.tipo) throw conflict('Esta categoría todavía no está disponible', 'categoria_pendiente');
  return db
    .prepare('INSERT OR IGNORE INTO categorias_movimiento (id, taller_id, clave, nombre, tipo_fin, sistema) VALUES (?, ?, ?, ?, ?, 1)')
    .bind(idCategoriaSistema(tallerId, clave), tallerId, clave, def.nombre, def.tipo);
}

// ───────────────────────── Personas ─────────────────────────
movpersonas.get('/personas', requirePerm('movpersonas.ver'), async (c) => {
  const s = c.get('sesion');
  const f = query(c, z.object({ q: z.string().optional(), inactivas: z.string().optional() }));
  const [propias, personal] = await Promise.all([
    all<any>(
      c.env.DB,
      `SELECT p.id, p.tipo, ${NOMBRE_PERSONA} AS nombre, CASE WHEN p.usuario_id IS NULL THEN p.documento END AS documento, p.usuario_id, p.activa, p.notas,
              u.acceso_erp AS acceso_erp, (SELECT COUNT(*) FROM movimientos_personas m WHERE m.taller_id = p.taller_id AND m.persona_id = p.id) AS movimientos
         FROM personas_financieras p LEFT JOIN usuarios u ON u.taller_id = p.taller_id AND u.id = p.usuario_id
        WHERE p.taller_id = ? ${f.inactivas ? '' : 'AND p.activa = 1'} ORDER BY nombre COLLATE NOCASE`,
      s.tallerId,
    ),
    // Personal que todavía no tiene ficha financiera: se ofrece igual (la ficha se crea al registrar el primer movimiento). No se expone ni su correo ni su documento.
    all<any>(
      c.env.DB,
      `SELECT u.id AS usuario_id, TRIM(u.nombre || ' ' || COALESCE(u.apellido, '')) AS nombre, u.acceso_erp AS acceso_erp
         FROM usuarios u WHERE u.taller_id = ? AND u.activo = 1 AND NOT EXISTS (SELECT 1 FROM personas_financieras p WHERE p.taller_id = u.taller_id AND p.usuario_id = u.id)
        ORDER BY nombre COLLATE NOCASE`,
      s.tallerId,
    ),
  ]);
  let filas = [
    ...propias.map((p) => ({ ...p, acceso_erp: p.usuario_id ? !!p.acceso_erp : null, nueva: false })),
    ...personal.map((u) => ({ id: idPersonaEmpleado(u.usuario_id), tipo: 'empleado', nombre: u.nombre, documento: null, usuario_id: u.usuario_id, activa: 1, notas: null, acceso_erp: !!u.acceso_erp, movimientos: 0, nueva: true })),
  ];
  if (f.q) {
    const q = sinTildes(f.q);
    filas = filas.filter((p) => sinTildes(p.nombre).includes(q));
  }
  return c.json(filas.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')));
});

movpersonas.post('/personas', requirePerm('movpersonas.registrar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, z.object({ tipo: z.enum(['socio', 'propietario', 'otra']), nombre: z.string().trim().min(2).max(120), documento: zTextoOpt(30), notas: zTextoOpt(300) }));
  const id = uid();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO personas_financieras (id, taller_id, tipo, nombre, documento, notas, creado_por) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, s.tallerId, d.tipo, d.nombre, d.documento, d.notas, s.usuarioId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'persona_financiera', id, 'crear', { tipo: d.tipo, nombre: d.nombre }),
  ]);
  return c.json({ id, tipo: d.tipo, nombre: d.nombre, documento: d.documento, usuario_id: null, activa: 1, notas: d.notas, acceso_erp: null, movimientos: 0, nueva: false }, 201);
});

movpersonas.patch('/personas/:id', requirePerm('movpersonas.administrar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, z.object({ nombre: z.string().trim().min(2).max(120).optional(), documento: zTextoOpt(30).optional(), notas: zTextoOpt(300).optional(), activa: z.boolean().optional() }));
  const p = await first<{ usuario_id: string | null }>(c.env.DB, 'SELECT usuario_id FROM personas_financieras WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!p) throw notFound('Persona');
  if (p.usuario_id && (d.nombre !== undefined || d.documento !== undefined)) throw conflict('Los datos del personal se editan en Equipo y permisos', 'persona_personal');
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (d.nombre !== undefined) (sets.push('nombre = ?'), vals.push(d.nombre));
  if (d.documento !== undefined) (sets.push('documento = ?'), vals.push(d.documento));
  if (d.notas !== undefined) (sets.push('notas = ?'), vals.push(d.notas));
  if (d.activa !== undefined) (sets.push('activa = ?'), vals.push(d.activa ? 1 : 0));
  if (!sets.length) return c.json({ ok: true });
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE personas_financieras SET ${sets.join(', ')} WHERE taller_id = ? AND id = ?`).bind(...vals, s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'persona_financiera', id, 'editar', d),
  ]);
  return c.json({ ok: true });
});

/** Cuentas donde puede entrar o salir el dinero (caja en efectivo y cuentas bancarias en pesos) y el estado de la caja. Evita exigir permisos de bancos para registrar. */
movpersonas.get('/cuentas', requirePerm('movpersonas.ver'), async (c) => {
  const s = c.get('sesion');
  const f = query(c, z.object({ todas: z.string().optional() }));
  const [cuentas, caja] = await Promise.all([
    all(c.env.DB, `SELECT id, nombre, banco, activa FROM cuentas_bancarias WHERE taller_id = ? AND moneda = 'ARS' ${f.todas ? '' : 'AND activa = 1'} ORDER BY activa DESC, nombre`, s.tallerId),
    estadoCaja(c.env.DB, s.tallerId),
  ]);
  return c.json({ cuentas, caja: { obligatoria: caja.obligatoria, abierta: !!caja.sesionId } });
});

// ───────────────────────── Consulta de movimientos ─────────────────────────
const ESTADOS_FILTRO = ['registrado', 'parcial', 'regularizado', 'anulado'] as const;
const OBL_SQL = `m.tipo_fin IN (${OBLIGACIONES_SQL})`;
const CONDICION_ESTADO: Record<(typeof ESTADOS_FILTRO)[number], string> = {
  anulado: "m.estado = 'anulado'",
  registrado: `m.estado = 'registrado' AND (NOT (${OBL_SQL}) OR m.regularizado = 0)`,
  parcial: `m.estado = 'registrado' AND ${OBL_SQL} AND m.regularizado > 0 AND m.regularizado < m.importe`,
  regularizado: `m.estado = 'registrado' AND ${OBL_SQL} AND m.regularizado >= m.importe`,
};
const ORDENES: Record<string, string> = {
  fecha_desc: 'm.fecha DESC, m.numero DESC',
  fecha_asc: 'm.fecha ASC, m.numero ASC',
  importe_desc: 'm.importe DESC, m.numero DESC',
  importe_asc: 'm.importe ASC, m.numero ASC',
};

const zFiltros = z.object({
  persona_id: z.string().optional(),
  categoria_id: z.string().optional(),
  tipo_fin: z.enum(TIPOS_FIN).optional(),
  direccion: z.enum(['entrada', 'salida', 'sin_dinero']).optional(),
  desde: zFecha.optional(),
  hasta: zFecha.optional(),
  cuenta: z.string().optional(),
  estado: z.enum(ESTADOS_FILTRO).optional(),
  moneda: z.enum(MONEDAS_MOVIMIENTO).optional(),
  q: z.string().trim().max(80).optional(),
});

/** Condiciones SQL de los filtros (alias m, p, u). Se usan igual en el listado, en los totales y en los reportes: los totales nunca dependen de la página visible. */
function condiciones(tallerId: string, f: z.infer<typeof zFiltros>) {
  const cond = ['m.taller_id = ?'];
  const params: unknown[] = [tallerId];
  if (f.persona_id) (cond.push('m.persona_id = ?'), params.push(f.persona_id));
  if (f.categoria_id) (cond.push('m.categoria_id = ?'), params.push(f.categoria_id));
  if (f.tipo_fin) (cond.push('m.tipo_fin = ?'), params.push(f.tipo_fin));
  if (f.direccion) (cond.push('m.direccion = ?'), params.push(f.direccion));
  if (f.desde) (cond.push('m.fecha >= ?'), params.push(f.desde));
  if (f.hasta) (cond.push('m.fecha <= ?'), params.push(f.hasta));
  if (f.cuenta === 'caja') cond.push("m.via = 'caja'");
  else if (f.cuenta) (cond.push('m.cuenta_id = ?'), params.push(f.cuenta));
  if (f.estado) cond.push(`(${CONDICION_ESTADO[f.estado]})`);
  if (f.moneda) (cond.push('m.moneda = ?'), params.push(f.moneda));
  if (f.q) {
    cond.push(`(${NOMBRE_PERSONA} LIKE ? OR m.motivo LIKE ? OR m.referencia LIKE ?)`);
    params.push(like(f.q), like(f.q), like(f.q));
  }
  return { where: cond.join(' AND '), params };
}

const SELECT_MOV = `SELECT m.id, m.numero, m.fecha, m.persona_id, ${NOMBRE_PERSONA} AS persona, p.tipo AS persona_tipo, m.categoria_id, cm.nombre AS categoria, m.tipo_fin, m.direccion,
    m.importe, m.moneda, m.via, m.cuenta_id, CASE m.via WHEN 'caja' THEN 'Caja en efectivo' WHEN 'banco' THEN cb.nombre ELSE NULL END AS cuenta,
    m.motivo, m.referencia, m.regulariza_id, ro.numero AS regulariza_numero, m.regularizado, m.liquidacion_ref, m.autorizado_por, m.estado, m.anulado_motivo, m.anulado_at,
    ua.nombre AS anulado_por_nombre, uo.nombre AS operador, m.created_at
  FROM movimientos_personas m
  ${JOIN_PERSONA}
  JOIN categorias_movimiento cm ON cm.taller_id = m.taller_id AND cm.id = m.categoria_id
  LEFT JOIN cuentas_bancarias cb ON cb.taller_id = m.taller_id AND cb.id = m.cuenta_id
  LEFT JOIN movimientos_personas ro ON ro.taller_id = m.taller_id AND ro.id = m.regulariza_id
  LEFT JOIN usuarios uo ON uo.taller_id = m.taller_id AND uo.id = m.usuario_id
  LEFT JOIN usuarios ua ON ua.taller_id = m.taller_id AND ua.id = m.anulado_por`;

const conEstado = (m: any) => {
  const estado_visible = estadoMovimiento(m);
  return { ...m, estado_visible, saldo: m.estado === 'registrado' && DEF_TIPOS_FIN[m.tipo_fin as TipoFin].abre ? m.importe - m.regularizado : 0, direccion_etiqueta: DIRECCION_LABEL[m.direccion as keyof typeof DIRECCION_LABEL] };
};

movpersonas.get('/movimientos', requirePerm('movpersonas.ver'), async (c) => {
  const s = c.get('sesion');
  const f = query(c, zFiltros.extend({ pagina: z.coerce.number().int().min(1).max(100000).default(1), por_pagina: z.coerce.number().int().min(5).max(100).default(25), orden: z.enum(['fecha_desc', 'fecha_asc', 'importe_desc', 'importe_asc']).default('fecha_desc') }));
  const { where, params } = condiciones(s.tallerId, f);
  const base = `FROM movimientos_personas m ${JOIN_PERSONA} WHERE ${where}`;
  const [filas, totales] = await Promise.all([
    all<any>(c.env.DB, `${SELECT_MOV} WHERE ${where} ORDER BY ${ORDENES[f.orden]} LIMIT ? OFFSET ?`, ...params, f.por_pagina, (f.pagina - 1) * f.por_pagina),
    // Totales sobre TODOS los movimientos que cumplen los filtros (no sobre la página), por moneda y sin contar anulados.
    all<{ moneda: string; entradas: number; salidas: number; cantidad: number; anulados: number }>(
      c.env.DB,
      `SELECT m.moneda, COALESCE(SUM(CASE WHEN m.estado = 'registrado' AND m.direccion = 'entrada' THEN m.importe END), 0) AS entradas,
              COALESCE(SUM(CASE WHEN m.estado = 'registrado' AND m.direccion = 'salida' THEN m.importe END), 0) AS salidas,
              SUM(CASE WHEN m.estado = 'registrado' THEN 1 ELSE 0 END) AS cantidad, SUM(CASE WHEN m.estado = 'anulado' THEN 1 ELSE 0 END) AS anulados
         ${base} GROUP BY m.moneda ORDER BY m.moneda`,
      ...params,
    ),
  ]);
  const total = totales.reduce((a, t) => a + t.cantidad + t.anulados, 0);
  return c.json({ filas: filas.map(conEstado), total, pagina: f.pagina, por_pagina: f.por_pagina, paginas: Math.max(1, Math.ceil(total / f.por_pagina)), totales });
});

movpersonas.get('/movimientos/:id', requirePerm('movpersonas.ver'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const m = await first<any>(c.env.DB, `${SELECT_MOV} WHERE m.taller_id = ? AND m.id = ?`, s.tallerId, id);
  if (!m) throw notFound('Movimiento');
  const [regularizaciones, historial] = await Promise.all([
    all<any>(
      c.env.DB,
      `SELECT m.id, m.numero, m.fecha, m.importe, m.estado, m.tipo_fin, m.liquidacion_ref, m.autorizado_por, uo.nombre AS operador
         FROM movimientos_personas m LEFT JOIN usuarios uo ON uo.taller_id = m.taller_id AND uo.id = m.usuario_id WHERE m.taller_id = ? AND m.regulariza_id = ? ORDER BY m.fecha, m.numero`,
      s.tallerId, id,
    ),
    all<any>(c.env.DB, `SELECT a.accion, a.detalle, a.created_at, u.nombre AS usuario FROM auditoria a LEFT JOIN usuarios u ON u.taller_id = a.taller_id AND u.id = a.usuario_id WHERE a.taller_id = ? AND a.entidad = 'movimiento_persona' AND a.entidad_id = ? ORDER BY a.created_at`, s.tallerId, id),
  ]);
  return c.json({ ...conEstado(m), regularizaciones, historial });
});

/** Obligaciones con saldo de una persona (lo que una devolución o aplicación puede regularizar). */
movpersonas.get('/obligaciones', requirePerm('movpersonas.ver'), async (c) => {
  const s = c.get('sesion');
  const f = query(c, z.object({ persona_id: zId, obligacion: z.enum(['prestamo_recibido', 'prestamo_otorgado', 'adelanto_sueldo']).optional() }));
  const filas = await all<any>(
    c.env.DB,
    `SELECT m.id, m.numero, m.fecha, m.tipo_fin, m.importe, m.moneda, m.regularizado, m.importe - m.regularizado AS saldo, m.motivo
       FROM movimientos_personas m WHERE m.taller_id = ? AND m.persona_id = ? AND m.estado = 'registrado' AND ${OBL_SQL} AND m.regularizado < m.importe ${f.obligacion ? 'AND m.tipo_fin = ?' : ''}
      ORDER BY m.fecha, m.numero`,
    s.tallerId, f.persona_id, ...(f.obligacion ? [f.obligacion] : []),
  );
  return c.json(filas);
});

// ───────────────────────── Registro ─────────────────────────
const zMovimiento = z.object({
  persona_id: zId.nullish(),
  usuario_id: zId.nullish(),
  // el id de una categoría del sistema lleva el id de la empresa (uuid) y su clave
  categoria_id: z.string().min(1).max(120),
  importe: zCentavos,
  moneda: z.enum(MONEDAS_MOVIMIENTO).default('ARS'),
  fecha: zFecha.optional(),
  via: z.enum(['caja', 'banco']).nullish(),
  cuenta_id: zId.nullish(),
  motivo: z.string().trim().min(3, 'indicá el motivo').max(300),
  referencia: zTextoOpt(120),
  regulariza_id: zId.nullish(),
  liquidacion_ref: zTextoOpt(120),
  autorizado_por: zTextoOpt(120),
  idem_key: z.string().min(8).max(80),
});

const resultadoPrevio = async (db: D1Database, tallerId: string, key: string) => first<{ id: string; numero: number }>(db, 'SELECT id, numero FROM movimientos_personas WHERE taller_id = ? AND idem_key = ?', tallerId, key);

movpersonas.post('/movimientos', requirePerm('movpersonas.registrar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zMovimiento);
  const previo = await resultadoPrevio(c.env.DB, s.tallerId, d.idem_key);
  if (previo) return c.json({ ...previo, duplicado: true }, 200);

  // Categoría: define el tipo financiero (y con él la dirección y el asiento). Nunca se acepta un tipo enviado por el cliente.
  const cats = await categoriasDe(c.env.DB, s.tallerId);
  const cat = cats.find((x) => x.id === d.categoria_id);
  if (!cat) throw badRequest('Categoría inexistente');
  if (cat.pendiente || !cat.tipo_fin) throw conflict(`Esta categoría todavía no está disponible. ${cat.pendiente ?? ''}`.trim(), 'categoria_pendiente');
  if (!cat.activa) throw conflict('La categoría está desactivada', 'categoria_inactiva');
  const tipo = cat.tipo_fin as TipoFin;
  const def = DEF_TIPOS_FIN[tipo];
  if (tipo === 'aplicacion_adelanto' && !tiene(s, 'movpersonas.regularizar')) throw forbidden('No tenés permiso para aplicar adelantos de sueldo');

  if (!(MONEDAS_ADMITIDAS as readonly string[]).includes(d.moneda)) throw badRequest('Por ahora los movimientos con personas se registran en pesos: la caja y los bancos operan en pesos');
  const eImporte = errorImporte(d.importe);
  if (eImporte) throw badRequest(eImporte);
  const fecha = fechaComercial(s, d.fecha);

  // Persona: una ficha existente o un integrante del personal (con o sin acceso al ERP) que todavía no tiene ficha financiera.
  let personaId = d.persona_id ?? null;
  let usuarioNuevo: string | null = null;
  if (!personaId && !d.usuario_id) throw badRequest('Elegí la persona');
  if (!personaId && d.usuario_id) personaId = idPersonaEmpleado(d.usuario_id);
  let persona = await first<{ id: string; tipo: string; activa: number; usuario_id: string | null }>(c.env.DB, 'SELECT id, tipo, activa, usuario_id FROM personas_financieras WHERE taller_id = ? AND id = ?', s.tallerId, personaId);
  if (!persona && personaId!.startsWith('u:')) {
    const uId = personaId!.slice(2);
    const u = await first<{ id: string; activo: number }>(c.env.DB, 'SELECT id, activo FROM usuarios WHERE taller_id = ? AND id = ?', s.tallerId, uId);
    if (!u) throw badRequest('Persona inexistente');
    if (!u.activo && !def.regulariza) throw conflict('Esa persona del personal está dada de baja', 'persona_inactiva');
    usuarioNuevo = uId;
    persona = { id: personaId!, tipo: 'empleado', activa: 1, usuario_id: uId };
  }
  if (!persona) throw badRequest('Persona inexistente');
  // Una devolución puede registrarse aunque la persona ya esté inactiva (alguien que se fue y devuelve lo que debe); un movimiento que abre deuda o mueve capital, no.
  if (!persona.activa && !def.regulariza) throw conflict('La persona está inactiva', 'persona_inactiva');
  if (def.soloPersonal && persona.tipo !== 'empleado') throw badRequest(`${def.etiqueta} sólo corresponde a personal de la empresa`);

  // Obligación que se regulariza.
  let origen: { id: string; numero: number; importe: number; regularizado: number; fecha: string } | null = null;
  if (def.regulariza) {
    if (!d.regulariza_id) throw badRequest(`Elegí ${tipo === 'aplicacion_adelanto' ? 'el adelanto' : 'el préstamo'} que se regulariza`);
    origen = await first(
      c.env.DB,
      `SELECT id, numero, importe, regularizado, fecha FROM movimientos_personas WHERE taller_id = ? AND id = ? AND persona_id = ? AND tipo_fin = ? AND moneda = ? AND estado = 'registrado'`,
      s.tallerId, d.regulariza_id, persona.id, def.regulariza, d.moneda,
    );
    if (!origen) throw badRequest('La obligación no existe, está anulada o pertenece a otra persona o moneda');
    const saldo = origen.importe - origen.regularizado;
    if (d.importe > saldo) throw conflict(`El importe supera el saldo pendiente de la obligación #${origen.numero} (${(saldo / 100).toFixed(2)})`, 'saldo_excedido');
    if (fecha < origen.fecha) throw badRequest('La fecha no puede ser anterior a la de la obligación que se regulariza');
  } else if (d.regulariza_id) throw badRequest('Este tipo de movimiento no regulariza ninguna obligación');

  if (tipo === 'aplicacion_adelanto') {
    if (!d.liquidacion_ref || d.liquidacion_ref.length < 2) throw badRequest('Indicá la liquidación (período o número) contra la que se aplica el adelanto');
    if (!d.autorizado_por || d.autorizado_por.length < 2) throw badRequest('Indicá quién autorizó la aplicación del adelanto');
  }

  // Dinero: efectivo en la caja o una cuenta bancaria en pesos. La aplicación de un adelanto no mueve dinero.
  const via = def.direccion === 'sin_dinero' ? 'ninguna' : (d.via ?? (d.cuenta_id ? 'banco' : 'caja'));
  if (def.direccion === 'sin_dinero' && (d.via || d.cuenta_id)) throw badRequest('Esta operación no mueve dinero: no lleva caja ni cuenta');
  let cuentaId: string | null = null;
  if (via === 'banco') {
    if (!d.cuenta_id) throw badRequest('Elegí la cuenta bancaria');
    await validarCuentaOperable(c.env.DB, s.tallerId, d.cuenta_id);
    cuentaId = d.cuenta_id;
  } else if (via === 'caja') {
    if (d.cuenta_id) throw badRequest('Un movimiento en efectivo no lleva cuenta bancaria');
    await exigirCajaAbiertaSiCorresponde(c.env.DB, s.tallerId);
  }

  const id = uid();
  const stmts: Stmt[] = [];
  if (via === 'caja') stmts.push(guardCajaObligatoria(c.env.DB, s.tallerId));
  if (via === 'banco') stmts.push(guardCuentaActiva(c.env.DB, s.tallerId, cuentaId as string));
  if (usuarioNuevo) {
    stmts.push(c.env.DB.prepare("INSERT OR IGNORE INTO personas_financieras (id, taller_id, tipo, usuario_id, creado_por) VALUES (?, ?, 'empleado', ?, ?)").bind(persona.id, s.tallerId, usuarioNuevo, s.usuarioId));
  }
  if (cat.sistema) stmts.push(asegurarCategoriaSistema(c.env.DB, s.tallerId, cat.clave as string));
  // La categoría y la persona tienen que seguir activas al momento de escribir (otro usuario pudo desactivarlas entre la validación y el lote).
  stmts.push(guard(c.env.DB, 'NOT EXISTS (SELECT 1 FROM categorias_movimiento WHERE taller_id = ? AND id = ? AND activa = 1)', s.tallerId, cat.id));
  if (!def.regulariza) stmts.push(guard(c.env.DB, 'NOT EXISTS (SELECT 1 FROM personas_financieras WHERE taller_id = ? AND id = ? AND activa = 1)', s.tallerId, persona.id));
  stmts.push(
    ...seqIncrementar(c.env.DB, s.tallerId, 'mov_persona'),
    c.env.DB
      .prepare(
        `INSERT INTO movimientos_personas (id, taller_id, numero, persona_id, categoria_id, tipo_fin, direccion, importe, moneda, fecha, via, cuenta_id, motivo, referencia, regulariza_id, liquidacion_ref, autorizado_por, idem_key, usuario_id)
         VALUES (?, ?, ${SEQ_VALOR}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, s.tallerId, s.tallerId, 'mov_persona', persona.id, cat.id, tipo, def.direccion, d.importe, d.moneda, fecha, via, cuentaId, d.motivo, d.referencia, origen?.id ?? null, d.liquidacion_ref, d.autorizado_por, d.idem_key, s.usuarioId),
  );
  // CHECK (regularizado <= importe): aunque dos operadores regularicen a la vez, el segundo lote falla completo.
  if (origen) stmts.push(c.env.DB.prepare('UPDATE movimientos_personas SET regularizado = regularizado + ? WHERE taller_id = ? AND id = ?').bind(d.importe, s.tallerId, origen.id));
  if (via === 'caja') {
    stmts.push(
      c.env.DB
        .prepare(
          `INSERT INTO caja_movimientos (id, taller_id, sesion_id, tipo, rubro, medio, importe, concepto, referencia, origen_tipo, origen_id, fecha, usuario_id)
           SELECT lower(hex(randomblob(16))), m.taller_id, (SELECT id FROM caja_sesiones WHERE taller_id = m.taller_id AND estado = 'abierta'), CASE m.direccion WHEN 'entrada' THEN 'ingreso' ELSE 'egreso' END,
                  'persona', 'efectivo', m.importe, cm.nombre || ' #' || m.numero || ' · ' || ${NOMBRE_PERSONA}, m.referencia, 'persona_mov', m.id, m.fecha, m.usuario_id
             FROM movimientos_personas m ${JOIN_PERSONA} JOIN categorias_movimiento cm ON cm.taller_id = m.taller_id AND cm.id = m.categoria_id
            WHERE m.taller_id = ? AND m.id = ?`,
        )
        .bind(s.tallerId, id),
    );
  } else if (via === 'banco') {
    // El movimiento bancario no genera resultado propio (afecta_resultado = 0): es dinero de socios o préstamos, no ingresos ni gastos del negocio.
    stmts.push(
      c.env.DB
        .prepare(
          `INSERT INTO banco_movimientos (id, taller_id, cuenta_id, fecha, tipo, categoria, importe, concepto, referencia, origen_tipo, origen_id, afecta_resultado, usuario_id)
           SELECT lower(hex(randomblob(16))), m.taller_id, m.cuenta_id, m.fecha, CASE m.direccion WHEN 'entrada' THEN 'ingreso' ELSE 'egreso' END, 'manual', m.importe,
                  cm.nombre || ' #' || m.numero || ' · ' || ${NOMBRE_PERSONA}, m.referencia, 'persona_mov', m.id, 0, m.usuario_id
             FROM movimientos_personas m ${JOIN_PERSONA} JOIN categorias_movimiento cm ON cm.taller_id = m.taller_id AND cm.id = m.categoria_id
            WHERE m.taller_id = ? AND m.id = ?`,
        )
        .bind(s.tallerId, id),
    );
  }
  stmts.push(auditar(c.env.DB, s.tallerId, s.usuarioId, 'movimiento_persona', id, 'crear', { tipo_fin: tipo, importe: d.importe, persona_id: persona.id, via, regulariza_id: origen?.id ?? null, liquidacion_ref: d.liquidacion_ref, autorizado_por: d.autorizado_por }));
  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    // Reintento idéntico que llegó en paralelo (doble clic): devolver el movimiento ya registrado.
    if (String(e).includes('idem_key')) {
      const ex = await resultadoPrevio(c.env.DB, s.tallerId, d.idem_key);
      if (ex) return c.json({ ...ex, duplicado: true }, 200);
    }
    throw e;
  }
  const creado = await first<{ id: string; numero: number }>(c.env.DB, 'SELECT id, numero FROM movimientos_personas WHERE taller_id = ? AND id = ?', s.tallerId, id);
  const saldoRestante = origen ? origen.importe - origen.regularizado - d.importe : null;
  return c.json({ ...creado, saldo_restante: saldoRestante }, 201);
});

// ───────────────────────── Anulación ─────────────────────────
movpersonas.post('/movimientos/:id/anular', requirePerm('movpersonas.anular'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const { motivo } = await body(c, z.object({ motivo: z.string().trim().min(3).max(300) }));
  const m = await first<{ estado: string; via: string; importe: number; regulariza_id: string | null; regularizado: number; numero: number; tipo_fin: TipoFin }>(
    c.env.DB, 'SELECT estado, via, importe, regulariza_id, regularizado, numero, tipo_fin FROM movimientos_personas WHERE taller_id = ? AND id = ?', s.tallerId, id,
  );
  if (!m) throw notFound('Movimiento');
  if (m.estado !== 'registrado') throw conflict('El movimiento ya está anulado', 'ya_anulado');
  if (m.regularizado > 0) throw conflict(`El movimiento #${m.numero} tiene devoluciones o aplicaciones vigentes: anulá primero esas operaciones`, 'tiene_regularizaciones');
  if (m.via === 'banco') {
    const b = await first<{ conciliado: number }>(c.env.DB, "SELECT conciliado FROM banco_movimientos WHERE taller_id = ? AND origen_tipo = 'persona_mov' AND origen_id = ?", s.tallerId, id);
    if (b?.conciliado) throw conflict('El movimiento bancario está conciliado: deshacé la conciliación primero', 'conciliado');
  }
  if (m.via === 'caja') await exigirCajaAbiertaSiCorresponde(c.env.DB, s.tallerId);

  const stmts: Stmt[] = [guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM movimientos_personas WHERE taller_id = ? AND id = ? AND estado = 'registrado' AND regularizado = 0)", s.tallerId, id)];
  if (m.via === 'caja') stmts.push(guardCajaObligatoria(c.env.DB, s.tallerId));
  if (m.via === 'banco') {
    stmts.push(guard(c.env.DB, "EXISTS (SELECT 1 FROM banco_movimientos WHERE taller_id = ? AND origen_tipo = 'persona_mov' AND origen_id = ? AND conciliado = 1)", s.tallerId, id));
  }
  stmts.push(
    c.env.DB.prepare("UPDATE movimientos_personas SET estado = 'anulado', anulado_motivo = ?, anulado_por = ?, anulado_at = ? WHERE taller_id = ? AND id = ? AND estado = 'registrado'").bind(motivo, s.usuarioId, ahora(), s.tallerId, id),
  );
  // Una devolución anulada devuelve el saldo a la obligación que regularizaba.
  if (m.regulariza_id) stmts.push(c.env.DB.prepare('UPDATE movimientos_personas SET regularizado = regularizado - ? WHERE taller_id = ? AND id = ?').bind(m.importe, s.tallerId, m.regulariza_id));
  if (m.via === 'caja') stmts.push(sentenciaReversos(c.env.DB, s.tallerId, "m.origen_tipo = 'persona_mov' AND m.origen_id = ?", [id], s.usuarioId));
  if (m.via === 'banco') stmts.push(sentenciaReversosBanco(c.env.DB, s.tallerId, "m.origen_tipo = 'persona_mov' AND m.origen_id = ?", [id], s.usuarioId));
  stmts.push(auditar(c.env.DB, s.tallerId, s.usuarioId, 'movimiento_persona', id, 'anular', { motivo, importe: m.importe }));
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

// ───────────────────────── Indicadores y reportes ─────────────────────────
/**
 * Flujos del período (aportes, retiros) y obligaciones pendientes A LA FECHA, por separado y por moneda. Los pendientes respetan la persona elegida pero no el
 * período: un saldo es lo que se debe hoy, no lo que se prestó en el mes.
 */
movpersonas.get('/indicadores', requirePerm('movpersonas.ver'), async (c) => {
  const s = c.get('sesion');
  const f = query(c, z.object({ persona_id: z.string().optional(), desde: zFecha.optional(), hasta: zFecha.optional() }));
  const flujo = condiciones(s.tallerId, { persona_id: f.persona_id, desde: f.desde, hasta: f.hasta });
  const stock = condiciones(s.tallerId, { persona_id: f.persona_id });
  const [flujos, pendientes] = await Promise.all([
    all<{ moneda: string; tipo_fin: string; total: number; cantidad: number }>(
      c.env.DB,
      `SELECT m.moneda, m.tipo_fin, COALESCE(SUM(m.importe), 0) AS total, COUNT(*) AS cantidad FROM movimientos_personas m
        WHERE ${flujo.where} AND m.estado = 'registrado' AND m.tipo_fin IN ('aporte_capital','retiro_capital') GROUP BY m.moneda, m.tipo_fin`,
      ...flujo.params,
    ),
    all<{ moneda: string; tipo_fin: string; saldo: number; cantidad: number; personas: number }>(
      c.env.DB,
      `SELECT m.moneda, m.tipo_fin, COALESCE(SUM(m.importe - m.regularizado), 0) AS saldo, COUNT(*) AS cantidad, COUNT(DISTINCT m.persona_id) AS personas FROM movimientos_personas m
        WHERE ${stock.where} AND m.estado = 'registrado' AND ${OBL_SQL} AND m.regularizado < m.importe GROUP BY m.moneda, m.tipo_fin`,
      ...stock.params,
    ),
  ]);
  const monedas = [...new Set([...flujos.map((x) => x.moneda), ...pendientes.map((x) => x.moneda)])];
  if (!monedas.length) monedas.push('ARS');
  return c.json(
    monedas.sort().map((moneda) => {
      const fl = (t: string) => flujos.find((x) => x.moneda === moneda && x.tipo_fin === t);
      const pe = (t: Obligacion) => pendientes.find((x) => x.moneda === moneda && x.tipo_fin === t);
      return {
        moneda,
        aportes: fl('aporte_capital')?.total ?? 0, aportes_cantidad: fl('aporte_capital')?.cantidad ?? 0,
        retiros: fl('retiro_capital')?.total ?? 0,
        prestamos_recibidos_pendiente: pe('prestamo_recibido')?.saldo ?? 0, prestamos_recibidos_personas: pe('prestamo_recibido')?.personas ?? 0,
        prestamos_otorgados_pendiente: pe('prestamo_otorgado')?.saldo ?? 0, prestamos_otorgados_personas: pe('prestamo_otorgado')?.personas ?? 0,
        adelantos_pendiente: pe('adelanto_sueldo')?.saldo ?? 0, adelantos_personas: pe('adelanto_sueldo')?.personas ?? 0,
      };
    }),
  );
});

/** Resumen de una persona, separado por concepto: nunca un único saldo neto que mezcle obligaciones de distinta naturaleza. */
movpersonas.get('/resumen/persona/:id', requirePerm('movpersonas.reportes'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const f = query(c, z.object({ desde: zFecha.optional(), hasta: zFecha.optional() }));
  const p = await first<any>(
    c.env.DB,
    `SELECT p.id, p.tipo, ${NOMBRE_PERSONA} AS nombre, p.activa, u.acceso_erp AS acceso_erp, p.usuario_id FROM personas_financieras p LEFT JOIN usuarios u ON u.taller_id = p.taller_id AND u.id = p.usuario_id WHERE p.taller_id = ? AND p.id = ?`,
    s.tallerId, id,
  );
  if (!p) throw notFound('Persona');
  const cond = condiciones(s.tallerId, { persona_id: id, desde: f.desde, hasta: f.hasta });
  const filas = await all<{ moneda: string; tipo_fin: TipoFin; total: number; cantidad: number; pendiente: number }>(
    c.env.DB,
    `SELECT m.moneda, m.tipo_fin, COALESCE(SUM(m.importe), 0) AS total, COUNT(*) AS cantidad,
            COALESCE(SUM(CASE WHEN ${OBL_SQL} THEN m.importe - m.regularizado ELSE 0 END), 0) AS pendiente
       FROM movimientos_personas m WHERE ${cond.where} AND m.estado = 'registrado' GROUP BY m.moneda, m.tipo_fin`,
    ...cond.params,
  );
  // El saldo pendiente es lo que se debe HOY (todas las fechas); los totales respetan el período pedido.
  const pend = await all<{ moneda: string; tipo_fin: TipoFin; saldo: number }>(
    c.env.DB,
    `SELECT m.moneda, m.tipo_fin, COALESCE(SUM(m.importe - m.regularizado), 0) AS saldo FROM movimientos_personas m
      WHERE m.taller_id = ? AND m.persona_id = ? AND m.estado = 'registrado' AND ${OBL_SQL} GROUP BY m.moneda, m.tipo_fin`,
    s.tallerId, id,
  );
  const monedas = [...new Set([...filas.map((x) => x.moneda), ...pend.map((x) => x.moneda)])].sort();
  const t = (mon: string, tf: TipoFin) => filas.find((x) => x.moneda === mon && x.tipo_fin === tf)?.total ?? 0;
  const sd = (mon: string, tf: TipoFin) => pend.find((x) => x.moneda === mon && x.tipo_fin === tf)?.saldo ?? 0;
  return c.json({
    persona: { id: p.id, tipo: p.tipo, nombre: p.nombre, activa: p.activa, acceso_erp: p.usuario_id ? !!p.acceso_erp : null },
    periodo: { desde: f.desde ?? null, hasta: f.hasta ?? null },
    por_moneda: monedas.map((moneda) => ({
      moneda,
      aportes: t(moneda, 'aporte_capital'), retiros: t(moneda, 'retiro_capital'),
      prestamos_a_la_empresa: t(moneda, 'prestamo_recibido'), devoluciones_de_la_empresa: t(moneda, 'devolucion_prestamo_recibido'),
      prestamos_de_la_empresa: t(moneda, 'prestamo_otorgado'), devoluciones_a_la_empresa: t(moneda, 'devolucion_prestamo_otorgado'),
      adelantos: t(moneda, 'adelanto_sueldo'), adelantos_aplicados: t(moneda, 'aplicacion_adelanto'),
      pendiente_prestamos_recibidos: sd(moneda, 'prestamo_recibido'), pendiente_prestamos_otorgados: sd(moneda, 'prestamo_otorgado'), pendiente_adelantos: sd(moneda, 'adelanto_sueldo'),
    })),
  });
});

/** Total por categoría con el desglose por persona, calculado sobre los registros reales (sin anulados), con los filtros pedidos. */
movpersonas.get('/resumen/categoria', requirePerm('movpersonas.reportes'), async (c) => {
  const s = c.get('sesion');
  const f = query(c, zFiltros.extend({ orden: z.enum(['importe_desc', 'importe_asc', 'nombre', 'cantidad']).default('importe_desc') }));
  const cond = condiciones(s.tallerId, { ...f, estado: undefined });
  const where = `${cond.where} AND m.estado = 'registrado'`;
  const orden = { importe_desc: 'total DESC, persona', importe_asc: 'total ASC, persona', nombre: 'persona COLLATE NOCASE', cantidad: 'cantidad DESC, persona' }[f.orden];
  const [porPersona, porCategoria] = await Promise.all([
    all<any>(
      c.env.DB,
      `SELECT m.moneda, m.persona_id, ${NOMBRE_PERSONA} AS persona, COALESCE(SUM(m.importe), 0) AS total, COUNT(*) AS cantidad
         FROM movimientos_personas m ${JOIN_PERSONA} WHERE ${where} GROUP BY m.moneda, m.persona_id ORDER BY m.moneda, ${orden}`,
      ...cond.params,
    ),
    all<any>(
      c.env.DB,
      `SELECT m.moneda, m.categoria_id, cm.nombre AS categoria, m.direccion, COALESCE(SUM(m.importe), 0) AS total, COUNT(*) AS cantidad
         FROM movimientos_personas m ${JOIN_PERSONA} JOIN categorias_movimiento cm ON cm.taller_id = m.taller_id AND cm.id = m.categoria_id
        WHERE ${where} GROUP BY m.moneda, m.categoria_id ORDER BY m.moneda, ${f.orden === 'nombre' ? 'categoria COLLATE NOCASE' : f.orden === 'importe_asc' ? 'total ASC' : f.orden === 'cantidad' ? 'cantidad DESC' : 'total DESC'}`,
      ...cond.params,
    ),
  ]);
  const monedas = [...new Set([...porPersona, ...porCategoria].map((x) => x.moneda))].sort();
  return c.json({
    filtros: { categoria_id: f.categoria_id ?? null, desde: f.desde ?? null, hasta: f.hasta ?? null },
    por_moneda: monedas.map((moneda) => {
      const personas = porPersona.filter((x) => x.moneda === moneda);
      return {
        moneda,
        total: personas.reduce((a, x) => a + x.total, 0), cantidad: personas.reduce((a, x) => a + x.cantidad, 0),
        personas: personas.map(({ moneda: _m, ...x }) => x),
        categorias: porCategoria.filter((x) => x.moneda === moneda).map(({ moneda: _m, ...x }) => x),
      };
    }),
  });
});

