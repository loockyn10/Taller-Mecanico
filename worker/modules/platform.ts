// Administración de la plataforma (alta de talleres y licencias). Protegido por PLATFORM_ADMIN_TOKEN.
// Las licencias se gestionan manualmente: no hay pasarela de pago.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ApiError, body, notFound, zTextoOpt } from '../lib/http';
import { ahora, all, first, uid } from '../lib/db';
import { hashPassword, igualSeguro, sha256Hex, tokenAleatorio } from '../lib/crypto';
import { exigirNoBloqueado, limpiarFallos, registrarFallo } from '../lib/limites';
import { ejecutarMantenimiento, informeSalud } from '../lib/observabilidad';
import { mantenimientoContable } from '../lib/contab/sync';
import { huellaCorta, registrarEvento } from '../lib/seguridad';
import { sentenciasAltaTaller } from './provision';

export const platform = new Hono<AppEnv>();

platform.use('*', async (c, next) => {
  // Los intentos con un token equivocado se limitan por origen (protección contra adivinación).
  const clave = `platform:${c.req.header('cf-connecting-ip') ?? 'local'}`;
  await exigirNoBloqueado(c.env.DB, clave);
  const esperado = c.env.PLATFORM_ADMIN_TOKEN;
  const recibido = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!esperado || esperado.length < 16 || !igualSeguro(recibido, esperado)) {
    const restantes = await registrarFallo(c.env.DB, clave, 10, 15, 30);
    await registrarEvento(c.env.DB, { tipo: 'plataforma_token_invalido', origen: await huellaCorta(c.req.header('cf-connecting-ip') ?? 'local'), detalle: restantes === 0 ? { bloqueo: true } : undefined });
    throw new ApiError(401, 'no_autorizado', 'Token de plataforma inválido');
  }
  await limpiarFallos(c.env.DB, clave);
  await next();
});

/** Informe de salud para el operador: mantenimiento, cola contable, seguridad, errores y respaldos. Solo lectura. */
platform.get('/salud', async (c) => c.json(await informeSalud(c.env.DB)));

/** Ejecuta ahora el mantenimiento periódico (el mismo que corre el Cron Trigger cada 5 minutos). Idempotente. */
platform.post('/mantenimiento', async (c) => c.json(await ejecutarMantenimiento(c.env, mantenimientoContable)));

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

// ───────────── Invitaciones de activación ─────────────
// El enlace se muestra una sola vez al generarlo; en la base queda únicamente su hash. Es de un solo uso y vence.
platform.post('/invitaciones', async (c) => {
  const d = await body(
    c,
    z.object({
      nombre_sugerido: zTextoOpt(120),
      email: z.string().trim().email().max(120).nullish().transform((v) => v || null),
      usuarios_adicionales: z.number().int().min(0).max(500).default(0),
      plan: z.string().trim().min(1).max(40).default('base'),
      notas: zTextoOpt(500),
      dias: z.number().int().min(1).max(30).default(7),
    }),
  );
  const token = tokenAleatorio();
  const id = uid();
  const vence = new Date(Date.now() + d.dias * 86400_000).toISOString();
  await c.env.DB.prepare(
    'INSERT INTO invitaciones_activacion (id, token_hash, nombre_sugerido, email_destino, plan, usuarios_adicionales, notas, vence_at) VALUES (?,?,?,?,?,?,?,?)',
  ).bind(id, await sha256Hex(token), d.nombre_sugerido, d.email, d.plan, d.usuarios_adicionales, d.notas, vence).run();
  const origen = new URL(c.req.url).origin;
  // El token va en el fragmento (#): el navegador no lo envía al servidor ni lo manda en el encabezado Referer.
  return c.json({ id, token, enlace: `${origen}/activar#${token}`, vence_at: vence }, 201);
});

platform.get('/invitaciones', async (c) => {
  const ts = ahora();
  const rows = await all<{ estado: string; vence_at: string }>(
    c.env.DB,
    `SELECT i.id, i.nombre_sugerido, i.email_destino, i.plan, i.usuarios_adicionales, i.notas, i.estado, i.vence_at, i.created_at, i.usada_at, i.taller_id, t.nombre AS taller
       FROM invitaciones_activacion i LEFT JOIN talleres t ON t.id = i.taller_id ORDER BY i.created_at DESC LIMIT 200`,
  );
  return c.json(rows.map((r) => ({ ...r, estado: r.estado === 'pendiente' && r.vence_at <= ts ? 'vencida' : r.estado })));
});

platform.post('/invitaciones/:id/revocar', async (c) => {
  const r = await c.env.DB.prepare("UPDATE invitaciones_activacion SET estado = 'revocada', revocada_at = ? WHERE id = ? AND estado = 'pendiente'").bind(ahora(), c.req.param('id')).run();
  if (!r.meta.changes) throw notFound('Invitación pendiente');
  return c.json({ ok: true });
});
