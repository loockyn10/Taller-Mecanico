// Configuración del taller, usuarios (empleados con acceso) y licencia.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ApiError, badRequest, body, forbidden, notFound, zCentavos, zFecha, zTextoOpt } from '../lib/http';
import { all, auditar, first, guard, uid } from '../lib/db';
import { requirePerm } from '../lib/auth';
import { hashPassword } from '../lib/crypto';
import { CONDICIONES_IVA, cuitValido, MEDIOS_PAGO } from '../../shared/dominio';

export const taller = new Hono<AppEnv>();

// ───── Configuración ─────
taller.get('/config', async (c) => {
  const s = c.get('sesion');
  const t = await first(c.env.DB, 'SELECT id, nombre, razon_social, cuit, condicion_iva, direccion, localidad, telefono, email, ingresos_brutos, inicio_actividades, sitio_web FROM talleres WHERE id = ?', s.tallerId);
  const cfg = await first<{ medios_pago: string | null }>(c.env.DB, 'SELECT * FROM taller_config WHERE taller_id = ?', s.tallerId);
  // medios_pago se entrega como lista (null = todos habilitados).
  return c.json({ taller: t, config: cfg && { ...cfg, medios_pago: cfg.medios_pago ? JSON.parse(cfg.medios_pago) : null } });
});

taller.put('/config', requirePerm('config.editar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(
    c,
    z.object({
      taller: z.object({
        nombre: z.string().trim().min(2).max(120),
        razon_social: zTextoOpt(160),
        cuit: zTextoOpt(20),
        condicion_iva: z.enum(CONDICIONES_IVA),
        direccion: zTextoOpt(200),
        localidad: zTextoOpt(120),
        telefono: zTextoOpt(40),
        email: zTextoOpt(120),
        ingresos_brutos: zTextoOpt(40),
        inicio_actividades: zFecha.nullish().transform((v) => v ?? null),
        sitio_web: zTextoOpt(120),
      }),
      config: z.object({
        iva_default: z.number().refine((v) => [0, 10.5, 21, 27].includes(v), 'IVA inválido'),
        recargo_default: z.number().min(0).max(100),
        validez_presupuesto_dias: z.number().int().min(1).max(365),
        margen_default: z.number().min(0).max(1000),
        pie_documentos: zTextoOpt(1000),
        pie_presupuesto: zTextoOpt(1000),
        pie_recibo: zTextoOpt(1000),
        pie_orden_compra: zTextoOpt(1000),
        permitir_stock_negativo: z.boolean(),
        caja_obligatoria: z.boolean().default(false),
        tolerancia_caja: zCentavos.default(0),
        alerta_cheques_dias: z.number().int().min(0).max(60).default(7),
        plazo_pago_dias: z.number().int().min(0).max(365).default(30),
        // Lista de medios habilitados (null = todos). El efectivo siempre está habilitado.
        medios_pago: z.array(z.enum(MEDIOS_PAGO)).nullish(),
      }),
    }),
  );
  const t = d.taller;
  const k = d.config;
  if (t.cuit && !cuitValido(t.cuit)) throw badRequest('El CUIT del taller no es válido');
  const medios = k.medios_pago ? MEDIOS_PAGO.filter((m) => m === 'efectivo' || k.medios_pago!.includes(m)) : null;
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE talleres SET nombre=?, razon_social=?, cuit=?, condicion_iva=?, direccion=?, localidad=?, telefono=?, email=?, ingresos_brutos=?, inicio_actividades=?, sitio_web=? WHERE id=?')
      .bind(t.nombre, t.razon_social, t.cuit, t.condicion_iva, t.direccion, t.localidad, t.telefono, t.email, t.ingresos_brutos, t.inicio_actividades, t.sitio_web, s.tallerId),
    c.env.DB.prepare(
      `UPDATE taller_config SET iva_default=?, recargo_default=?, validez_presupuesto_dias=?, margen_default=?, pie_documentos=?, pie_presupuesto=?, pie_recibo=?, pie_orden_compra=?,
              permitir_stock_negativo=?, caja_obligatoria=?, tolerancia_caja=?, alerta_cheques_dias=?, plazo_pago_dias=?, medios_pago=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id=?`,
    ).bind(k.iva_default, k.recargo_default, k.validez_presupuesto_dias, k.margen_default, k.pie_documentos, k.pie_presupuesto, k.pie_recibo, k.pie_orden_compra, k.permitir_stock_negativo ? 1 : 0, k.caja_obligatoria ? 1 : 0, k.tolerancia_caja, k.alerta_cheques_dias, k.plazo_pago_dias, medios ? JSON.stringify(medios) : null, s.tallerId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'config', s.tallerId, 'actualizar'),
  ]);
  return c.json({ ok: true });
});

// ───── Licencia ─────
async function datosLicencia(db: D1Database, tallerId: string) {
  const lic = await first<{ plan: string; usuarios_incluidos: number; usuarios_adicionales: number; estado: string; updated_at: string }>(
    db,
    'SELECT plan, usuarios_incluidos, usuarios_adicionales, estado, updated_at FROM licencias WHERE taller_id = ?',
    tallerId,
  );
  const activos = await first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM usuarios WHERE taller_id = ? AND activo = 1', tallerId);
  const max = lic ? lic.usuarios_incluidos + lic.usuarios_adicionales : 0;
  return { ...lic, usuarios_max: max, usuarios_activos: activos?.n ?? 0, disponibles: Math.max(0, max - (activos?.n ?? 0)) };
}

taller.get('/licencia', requirePerm('licencia.ver'), async (c) => {
  const s = c.get('sesion');
  const lic = await datosLicencia(c.env.DB, s.tallerId);
  const eventos = await all(c.env.DB, 'SELECT tipo, detalle, created_at FROM licencia_eventos WHERE taller_id = ? ORDER BY created_at DESC LIMIT 20', s.tallerId);
  return c.json({ ...lic, eventos });
});

// ───── Usuarios ─────
/** Sentencia que aborta el batch si el taller ya alcanzó el máximo de usuarios activos de su licencia. */
const guardCupo = (db: D1Database, tallerId: string) =>
  guard(
    db,
    `(SELECT COUNT(*) FROM usuarios WHERE taller_id = ? AND activo = 1) >=
     (SELECT usuarios_incluidos + usuarios_adicionales FROM licencias WHERE taller_id = ?)`,
    tallerId,
    tallerId,
  );

taller.get('/usuarios', requirePerm('usuarios.gestionar'), async (c) => {
  const s = c.get('sesion');
  const rows = await all(c.env.DB, 'SELECT id, email, nombre, rol, activo, ultimo_login, created_at FROM usuarios WHERE taller_id = ? ORDER BY nombre', s.tallerId);
  return c.json({ usuarios: rows, licencia: await datosLicencia(c.env.DB, s.tallerId) });
});

taller.post('/usuarios', requirePerm('usuarios.gestionar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(
    c,
    z.object({
      nombre: z.string().trim().min(2).max(120),
      email: z.string().trim().email(),
      rol: z.enum(['administrador', 'empleado']),
      password: z.string().min(8, 'mínimo 8 caracteres').max(200),
    }),
  );
  const lic = await datosLicencia(c.env.DB, s.tallerId);
  if (lic.disponibles <= 0) {
    throw new ApiError(409, 'limite_licencia', `La licencia permite ${lic.usuarios_max} usuario(s) activo(s). Contratá usuarios adicionales para agregar más.`);
  }
  if (await first(c.env.DB, 'SELECT 1 FROM usuarios WHERE email = ?', d.email)) throw new ApiError(409, 'duplicado', 'Ya existe un usuario con ese email');
  const id = uid();
  const hash = await hashPassword(d.password, Number(c.env.PBKDF2_ITERATIONS ?? 100000));
  await c.env.DB.batch([
    guardCupo(c.env.DB, s.tallerId),
    c.env.DB.prepare('INSERT INTO usuarios (id, taller_id, email, nombre, rol, password_hash) VALUES (?, ?, ?, ?, ?, ?)').bind(id, s.tallerId, d.email, d.nombre, d.rol, hash),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'usuario', id, 'crear', { email: d.email, rol: d.rol }),
  ]);
  return c.json({ id }, 201);
});

taller.patch('/usuarios/:id', requirePerm('usuarios.gestionar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(
    c,
    z.object({
      nombre: z.string().trim().min(2).max(120).optional(),
      rol: z.enum(['administrador', 'empleado']).optional(),
      activo: z.boolean().optional(),
      password: z.string().min(8).max(200).optional(),
    }),
  );
  const u = await first<{ id: string; rol: string; activo: number }>(c.env.DB, 'SELECT id, rol, activo FROM usuarios WHERE taller_id = ? AND id = ?', s.tallerId, id);
  if (!u) throw notFound('Usuario');
  if (u.rol === 'propietario' && s.rol !== 'propietario') throw forbidden('Solo el propietario puede modificar su propio usuario');
  if (u.rol === 'propietario' && (d.rol || d.activo === false)) throw forbidden('No se puede cambiar el rol ni desactivar al propietario');
  if (id === s.usuarioId && d.activo === false) throw forbidden('No podés desactivar tu propio usuario');
  const stmts: D1PreparedStatement[] = [];
  if (d.activo === true && !u.activo) stmts.push(guardCupo(c.env.DB, s.tallerId));
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (d.nombre) (sets.push('nombre = ?'), vals.push(d.nombre));
  if (d.rol) (sets.push('rol = ?'), vals.push(d.rol));
  if (d.activo !== undefined) (sets.push('activo = ?'), vals.push(d.activo ? 1 : 0));
  if (d.password) (sets.push('password_hash = ?'), vals.push(await hashPassword(d.password, Number(c.env.PBKDF2_ITERATIONS ?? 100000))));
  if (!sets.length) return c.json({ ok: true });
  stmts.push(c.env.DB.prepare(`UPDATE usuarios SET ${sets.join(', ')} WHERE taller_id = ? AND id = ?`).bind(...vals, s.tallerId, id));
  if (d.activo === false || d.password || d.rol) stmts.push(c.env.DB.prepare('DELETE FROM sesiones WHERE usuario_id = ?').bind(id));
  stmts.push(auditar(c.env.DB, s.tallerId, s.usuarioId, 'usuario', id, 'modificar', { ...d, password: d.password ? '***' : undefined }));
  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    if (String(e).includes('ok = 1')) throw new ApiError(409, 'limite_licencia', 'No hay cupo de usuarios en la licencia para reactivar este usuario');
    throw e;
  }
  return c.json({ ok: true });
});

taller.get('/auditoria', requirePerm('config.editar'), async (c) => {
  const s = c.get('sesion');
  const rows = await all(
    c.env.DB,
    `SELECT a.created_at, a.entidad, a.entidad_id, a.accion, a.detalle, u.nombre AS usuario
       FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id AND u.taller_id = a.taller_id
      WHERE a.taller_id = ? ORDER BY a.created_at DESC LIMIT 200`,
    s.tallerId,
  );
  return c.json(rows);
});
