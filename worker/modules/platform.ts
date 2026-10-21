// Administración de la plataforma (alta de talleres y licencias). Protegido por PLATFORM_ADMIN_TOKEN.
// Las licencias se gestionan manualmente: no hay pasarela de pago.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ApiError, body, notFound, zTextoOpt } from '../lib/http';
import { all, first, uid } from '../lib/db';
import { hashPassword, igualSeguro } from '../lib/crypto';
import { sentenciasAltaTaller } from './provision';

export const platform = new Hono<AppEnv>();

platform.use('*', async (c, next) => {
  const esperado = c.env.PLATFORM_ADMIN_TOKEN;
  const recibido = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!esperado || esperado.length < 16 || !igualSeguro(recibido, esperado)) {
    throw new ApiError(401, 'no_autorizado', 'Token de plataforma inválido');
  }
  await next();
});

platform.get('/talleres', async (c) => {
  const rows = await all(
    c.env.DB,
    `SELECT t.id, t.nombre, t.cuit, t.activo, t.created_at, l.plan, l.usuarios_incluidos, l.usuarios_adicionales, l.estado,
            (SELECT COUNT(*) FROM usuarios u WHERE u.taller_id = t.id AND u.activo = 1 AND u.acceso_erp = 1) AS usuarios_activos
       FROM talleres t LEFT JOIN licencias l ON l.taller_id = t.id ORDER BY t.created_at`,
  );
  return c.json(rows);
});

platform.post('/talleres', async (c) => {
  const d = await body(
    c,
    z.object({
      nombre: z.string().trim().min(2).max(120),
      cuit: zTextoOpt(20),
      telefono: zTextoOpt(40),
      email: zTextoOpt(120),
      usuarios_adicionales: z.number().int().min(0).max(500).default(0),
      propietario: z.object({ nombre: z.string().trim().min(2).max(120), email: z.string().trim().email(), password: z.string().min(8).max(200) }),
    }),
  );
  const existe = await first(c.env.DB, 'SELECT 1 FROM usuarios WHERE email = ?', d.propietario.email);
  if (existe) throw new ApiError(409, 'duplicado', 'Ya existe un usuario con ese email');
  const hash = await hashPassword(d.propietario.password, Number(c.env.PBKDF2_ITERATIONS ?? 100000));
  const { tallerId, propietarioId, stmts } = sentenciasAltaTaller(c.env.DB, {
    nombre: d.nombre,
    cuit: d.cuit,
    telefono: d.telefono,
    email: d.email,
    usuarios_adicionales: d.usuarios_adicionales,
    propietario: { nombre: d.propietario.nombre, email: d.propietario.email, password_hash: hash },
  });
  await c.env.DB.batch(stmts);
  return c.json({ tallerId, propietarioId }, 201);
});

platform.patch('/talleres/:id/licencia', async (c) => {
  const id = c.req.param('id');
  const d = await body(
    c,
    z.object({
      usuarios_adicionales: z.number().int().min(0).max(500).optional(),
      estado: z.enum(['activa', 'suspendida']).optional(),
      plan: z.string().trim().max(40).optional(),
      notas: zTextoOpt(500),
    }),
  );
  const lic = await first(c.env.DB, 'SELECT * FROM licencias WHERE taller_id = ?', id);
  if (!lic) throw notFound('Taller');
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE licencias SET usuarios_adicionales = COALESCE(?, usuarios_adicionales), estado = COALESCE(?, estado),
              plan = COALESCE(?, plan), notas = COALESCE(?, notas), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ?`,
    ).bind(d.usuarios_adicionales ?? null, d.estado ?? null, d.plan ?? null, d.notas ?? null, id),
    c.env.DB.prepare('INSERT INTO licencia_eventos (id, taller_id, tipo, detalle) VALUES (?, ?, ?, ?)').bind(uid(), id, 'modificacion', JSON.stringify(d)),
  ]);
  return c.json(await first(c.env.DB, 'SELECT * FROM licencias WHERE taller_id = ?', id));
});
