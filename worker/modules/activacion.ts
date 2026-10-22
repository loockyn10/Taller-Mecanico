// Activación de un taller nuevo a partir de una invitación (enlace de un solo uso con vencimiento).
//
// Seguridad:
//  * la invitación la genera la plataforma con PLATFORM_ADMIN_TOKEN (nunca desde el navegador); acá solo se la canjea;
//  * el enlace lleva un token aleatorio de 256 bits; en la base solo queda su hash SHA-256;
//  * un enlace vencido, ya usado o revocado responde siempre lo mismo (no se puede saber cuál de los casos es);
//  * el canje es atómico: el batch verifica que la invitación siga pendiente y la marca como usada junto con el alta del taller, de modo que dos
//    canjes simultáneos o un reintento no pueden crear dos talleres con la misma invitación;
//  * los intentos con enlaces inválidos se limitan por origen.
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ApiError, body, zTextoOpt } from '../lib/http';
import { ahora, auditar, first, guard } from '../lib/db';
import { hashPassword, sha256Hex } from '../lib/crypto';
import { crearSesion } from '../lib/auth';
import { exigirNoBloqueado, registrarFallo } from '../lib/limites';
import { sentenciasAltaTaller } from './provision';

export const activacion = new Hono<AppEnv>();

const TOKEN_RE = /^[A-Za-z0-9_-]{40,64}$/;
const zToken = z.string().regex(TOKEN_RE, 'enlace inválido');

const enlaceInvalido = () => new ApiError(404, 'enlace_invalido', 'El enlace de activación no es válido, ya fue usado o venció. Pedí uno nuevo a quien te lo envió.');
const claveLimite = (c: Context<AppEnv>) => `activar:${c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'local'}`;

interface Invitacion {
  id: string;
  nombre_sugerido: string | null;
  email_destino: string | null;
  plan: string;
  usuarios_incluidos: number;
  usuarios_adicionales: number;
  vence_at: string;
}

async function buscarVigente(c: Context<AppEnv>, token: string): Promise<Invitacion> {
  const clave = claveLimite(c);
  await exigirNoBloqueado(c.env.DB, clave, 'Demasiados intentos con enlaces inválidos. Probá de nuevo en un rato.');
  const inv = TOKEN_RE.test(token)
    ? await first<Invitacion>(
        c.env.DB,
        "SELECT id, nombre_sugerido, email_destino, plan, usuarios_incluidos, usuarios_adicionales, vence_at FROM invitaciones_activacion WHERE token_hash = ? AND estado = 'pendiente' AND vence_at > ?",
        await sha256Hex(token),
        ahora(),
      )
    : null;
  if (!inv) {
    await registrarFallo(c.env.DB, clave, 10, 15, 30);
    throw enlaceInvalido();
  }
  return inv;
}

/** Datos que la persona ve antes de activar: a qué taller corresponde la invitación y hasta cuándo vale. */
activacion.post('/consultar', async (c) => {
  const { token } = await body(c, z.object({ token: z.string().max(200) }));
  const inv = await buscarVigente(c, token);
  return c.json({ nombre_sugerido: inv.nombre_sugerido, email: inv.email_destino, vence_at: inv.vence_at });
});

activacion.post('/completar', async (c) => {
  const d = await body(
    c,
    z.object({
      token: zToken,
      propietario: z.object({
        nombre: z.string().trim().min(2).max(120),
        email: z.string().trim().email().max(120),
        password: z.string().min(8, 'mínimo 8 caracteres').max(200),
      }),
      taller: z.object({ nombre: z.string().trim().min(2).max(120), telefono: zTextoOpt(40) }),
    }),
  );
  const inv = await buscarVigente(c, d.token);
  if (d.propietario.password.toLowerCase() === d.propietario.email.toLowerCase()) throw new ApiError(400, 'datos_invalidos', 'La contraseña no puede ser igual al correo');
  if (inv.email_destino && inv.email_destino.toLowerCase() !== d.propietario.email.toLowerCase()) {
    throw new ApiError(400, 'email_no_corresponde', `Esta invitación es para ${inv.email_destino}: usá ese correo para activarla`);
  }
  if (await first(c.env.DB, 'SELECT 1 FROM usuarios WHERE email = ?', d.propietario.email)) throw new ApiError(409, 'duplicado', 'Ya existe un usuario con ese correo');

  const hash = await hashPassword(d.propietario.password, Number(c.env.PBKDF2_ITERATIONS ?? 100000));
  const { tallerId, propietarioId, stmts } = sentenciasAltaTaller(c.env.DB, {
    nombre: d.taller.nombre,
    telefono: d.taller.telefono,
    email: d.propietario.email,
    propietario: { nombre: d.propietario.nombre, email: d.propietario.email, password_hash: hash },
    plan: inv.plan,
    usuarios_incluidos: inv.usuarios_incluidos,
    usuarios_adicionales: inv.usuarios_adicionales,
    servicios: false,
    asistente: true,
    origen: `invitacion:${inv.id}`,
  });
  const ts = ahora();
  try {
    await c.env.DB.batch([
    // Verificación dentro de la transacción: si otra solicitud ya canjeó la invitación (o venció en el medio), todo el alta se revierte.
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM invitaciones_activacion WHERE id = ? AND estado = 'pendiente' AND vence_at > ?)", inv.id, ts),
    ...stmts,
    c.env.DB.prepare("UPDATE invitaciones_activacion SET estado = 'usada', usada_at = ?, taller_id = ? WHERE id = ? AND estado = 'pendiente'").bind(ts, tallerId, inv.id),
    auditar(c.env.DB, tallerId, propietarioId, 'taller', tallerId, 'activar', { invitacion: inv.id }),
    ]);
  } catch (e) {
    // Otra solicitud canjeó la misma invitación un instante antes (o venció en el medio): el alta completa se revirtió.
    if (e instanceof Error && /tx_guard|ok = 1/.test(e.message)) throw enlaceInvalido();
    throw e;
  }
  await crearSesion(c, propietarioId, tallerId);
  return c.json({ ok: true }, 201);
});
