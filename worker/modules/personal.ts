// Personal del taller: usuarios (con o sin acceso al sistema), roles, permisos individuales, PIN del reloj y actividad.
// Reutiliza la tabla usuarios y la autenticación existentes: no hay un segundo sistema de identidades.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Sesion } from '../env';
import { ApiError, badRequest, body, forbidden, notFound, zFecha, zId, zTextoOpt } from '../lib/http';
import { all, auditar, ahora, first, uid, type Stmt } from '../lib/db';
import { requirePerm } from '../lib/auth';
import { hashPassword, verificarPassword } from '../lib/crypto';
import { datosLicencia, guardCupo } from '../lib/licencia';
import { validarPinSeguro, zPin } from '../lib/pin';
import {
  ajustesDesde, esPermiso, leerAjustes, nivelDeRol, permisosEfectivos, PLANTILLAS, ROLES, esRol,
  type Nivel, type Permiso, type Rol,
} from '../../shared/permisos';

export const personal = new Hono<AppEnv>();

interface FilaUsuario {
  id: string; nombre: string; apellido: string | null; documento: string | null; cargo: string | null; telefono: string | null; fecha_incorporacion: string | null;
  email: string; acceso_erp: number; nivel: Nivel; plantilla: string | null; permisos_ajustes: string | null; activo: number; ultimo_login: string | null;
  created_at: string; tiene_pin: number; pin_bloqueado_hasta: string | null; mecanico_id: string | null;
}

const COLS = `u.id, u.nombre, u.apellido, u.documento, u.cargo, u.telefono, u.fecha_incorporacion, u.email, u.acceso_erp, u.rol AS nivel, u.plantilla, u.permisos_ajustes,
  u.activo, u.ultimo_login, u.created_at, (u.pin_hash IS NOT NULL) AS tiene_pin, u.pin_bloqueado_hasta,
  (SELECT m.id FROM mecanicos m WHERE m.taller_id = u.taller_id AND m.usuario_id = u.id) AS mecanico_id`;

const rolDe = (u: { plantilla: string | null; nivel: Nivel }): Rol => (esRol(u.plantilla) && nivelDeRol(u.plantilla) === u.nivel ? u.plantilla : u.nivel);

function presentar(u: FilaUsuario) {
  const rol = rolDe(u);
  const ajustes = leerAjustes(u.permisos_ajustes);
  return {
    id: u.id,
    nombre: u.nombre,
    apellido: u.apellido,
    documento: u.documento,
    cargo: u.cargo,
    telefono: u.telefono,
    fecha_incorporacion: u.fecha_incorporacion,
    email: u.acceso_erp ? u.email : null,
    acceso_erp: !!u.acceso_erp,
    rol,
    nivel: u.nivel,
    activo: !!u.activo,
    ultimo_login: u.ultimo_login,
    created_at: u.created_at,
    tiene_pin: !!u.tiene_pin,
    pin_bloqueado: !!(u.pin_bloqueado_hasta && u.pin_bloqueado_hasta > ahora()),
    mecanico_id: u.mecanico_id,
    personalizado: ajustes.g.length + ajustes.r.length > 0,
  };
}

async function cargar(db: D1Database, tallerId: string, id: string): Promise<FilaUsuario> {
  const u = await first<FilaUsuario>(db, `SELECT ${COLS} FROM usuarios u WHERE u.taller_id = ? AND u.id = ?`, tallerId, id);
  if (!u) throw notFound('Usuario');
  return u;
}

// ───────────── Reglas contra el escalamiento de privilegios ─────────────

/** ¿Puede la sesión asignar este rol? El propietario asigna cualquiera salvo propietario; el resto solo roles de nivel empleado que no superen sus propios permisos. */
function puedeAsignarRol(s: Sesion, rol: Rol): boolean {
  if (rol === 'propietario') return false;
  if (s.nivel === 'propietario') return true;
  if (nivelDeRol(rol) !== 'empleado') return false;
  return permisosEfectivos(rol).every((p) => s.permisos.has(p));
}

/** Quién puede administrar a quién: el propietario a todos; los demás solo a personal de nivel empleado y a sí mismos (datos personales). */
function exigirGestion(s: Sesion, objetivo: FilaUsuario) {
  if (objetivo.id === s.usuarioId) return;
  if (objetivo.nivel === 'propietario') throw forbidden('Solo el propietario puede modificar su propio usuario');
  if (s.nivel !== 'propietario' && objetivo.nivel !== 'empleado') throw forbidden('Solo el propietario puede administrar a un administrador');
}

// ───────────── Listado y ficha ─────────────
personal.get('/usuarios', requirePerm('usuarios.gestionar'), async (c) => {
  const s = c.get('sesion');
  const rows = await all<FilaUsuario>(c.env.DB, `SELECT ${COLS} FROM usuarios u WHERE u.taller_id = ? ORDER BY u.activo DESC, u.nombre COLLATE NOCASE, u.apellido COLLATE NOCASE`, s.tallerId);
  return c.json({ usuarios: rows.map(presentar), licencia: await datosLicencia(c.env.DB, s.tallerId) });
});

personal.get('/usuarios/:id', requirePerm('usuarios.gestionar'), async (c) => {
  const s = c.get('sesion');
  const u = await cargar(c.env.DB, s.tallerId, c.req.param('id'));
  const rol = rolDe(u);
  const ajustes = leerAjustes(u.permisos_ajustes);
  const actividad = await all(
    c.env.DB,
    'SELECT entidad, entidad_id, accion, detalle, created_at FROM auditoria WHERE taller_id = ? AND usuario_id = ? ORDER BY created_at DESC LIMIT 60',
    s.tallerId,
    u.id,
  );
  return c.json({ ...presentar(u), ajustes, permisos: permisosEfectivos(rol, ajustes), actividad });
});

// ───────────── Alta ─────────────
const zNuevo = z
  .object({
    nombre: z.string().trim().min(2).max(80),
    apellido: zTextoOpt(80),
    documento: zTextoOpt(20),
    cargo: zTextoOpt(80),
    telefono: zTextoOpt(40),
    fecha_incorporacion: zFecha.nullish(),
    rol: z.enum(['administrador', 'recepcion', 'mecanico', 'deposito', 'caja', 'empleado']),
    acceso_erp: z.boolean().default(true),
    email: z.string().trim().email().max(120).nullish(),
    password: z.string().min(8, 'mínimo 8 caracteres').max(200).nullish(),
    es_mecanico: z.boolean().optional(),
    mecanico_id: zId.nullish(),
    pin: zPin.nullish(),
  })
  .superRefine((d, ctx) => {
    if (d.acceso_erp && !d.email) ctx.addIssue({ code: 'custom', path: ['email'], message: 'el correo de acceso es obligatorio' });
    if (d.acceso_erp && !d.password) ctx.addIssue({ code: 'custom', path: ['password'], message: 'la contraseña inicial es obligatoria' });
  });

personal.post('/usuarios', requirePerm('usuarios.gestionar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zNuevo);
  if (!puedeAsignarRol(s, d.rol)) throw forbidden('No podés asignar ese rol');
  if (!d.acceso_erp && nivelDeRol(d.rol) !== 'empleado') throw badRequest('Un administrador necesita acceso al sistema');
  if (d.acceso_erp) {
    const lic = await datosLicencia(c.env.DB, s.tallerId);
    if (lic.disponibles <= 0) {
      throw new ApiError(409, 'limite_licencia', `La licencia permite ${lic.usuarios_max} usuario(s) activo(s) con acceso. Contratá usuarios adicionales para agregar más.`);
    }
    if (await first(c.env.DB, 'SELECT 1 FROM usuarios WHERE email = ?', d.email)) throw new ApiError(409, 'duplicado', 'Ya existe un usuario con ese email');
  }
  if (d.pin) validarPinSeguro(d.pin);
  const id = uid();
  const iteraciones = Number(c.env.PBKDF2_ITERATIONS ?? 100000);
  const hash = d.acceso_erp ? await hashPassword(d.password!, iteraciones) : 'sin-acceso';
  const email = d.acceso_erp ? d.email! : `sin-acceso-${id}@fierro.invalid`;
  const pinHash = d.pin ? await hashPassword(d.pin, iteraciones) : null;
  const esMecanico = d.es_mecanico ?? d.rol === 'mecanico';
  const stmts: Stmt[] = [];
  if (d.acceso_erp) stmts.push(guardCupo(c.env.DB, s.tallerId));
  stmts.push(
    c.env.DB.prepare(
      `INSERT INTO usuarios (id, taller_id, email, nombre, apellido, documento, cargo, telefono, fecha_incorporacion, rol, plantilla, acceso_erp, password_hash, pin_hash, pin_actualizado_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, s.tallerId, email, d.nombre, d.apellido, d.documento, d.cargo, d.telefono, d.fecha_incorporacion ?? null, nivelDeRol(d.rol), d.rol, d.acceso_erp ? 1 : 0, hash, pinHash, pinHash ? ahora() : null),
  );
  if (esMecanico) stmts.push(...(await sentenciasMecanico(c.env.DB, s.tallerId, id, d, d.mecanico_id)));
  stmts.push(auditar(c.env.DB, s.tallerId, s.usuarioId, 'usuario', id, 'crear', { email: d.acceso_erp ? d.email : null, rol: d.rol, acceso_erp: d.acceso_erp }));
  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    if (String(e).includes('ok = 1')) throw new ApiError(409, 'limite_licencia', 'No hay cupo de usuarios en la licencia');
    throw e;
  }
  return c.json({ id }, 201);
});

/** Crea el mecánico vinculado al usuario, o vincula uno existente que no tenga usuario (sin duplicar personas). */
async function sentenciasMecanico(db: D1Database, tallerId: string, usuarioId: string, d: { nombre: string; apellido?: string | null; telefono?: string | null; cargo?: string | null }, mecanicoId?: string | null): Promise<Stmt[]> {
  const nombre = d.apellido ? `${d.nombre} ${d.apellido}` : d.nombre;
  if (mecanicoId) {
    const m = await first<{ usuario_id: string | null }>(db, 'SELECT usuario_id FROM mecanicos WHERE taller_id = ? AND id = ?', tallerId, mecanicoId);
    if (!m) throw badRequest('Mecánico inexistente');
    if (m.usuario_id && m.usuario_id !== usuarioId) throw badRequest('Ese mecánico ya está vinculado a otro usuario');
    return [db.prepare('UPDATE mecanicos SET usuario_id = ?, activo = 1 WHERE taller_id = ? AND id = ?').bind(usuarioId, tallerId, mecanicoId)];
  }
  return [db.prepare('INSERT INTO mecanicos (id, taller_id, nombre, telefono, especialidad, usuario_id) VALUES (?, ?, ?, ?, ?, ?)').bind(uid(), tallerId, nombre, d.telefono ?? null, d.cargo ?? null, usuarioId)];
}

// ───────────── Modificación ─────────────
const zCambios = z.object({
  nombre: z.string().trim().min(2).max(80).optional(),
  apellido: zTextoOpt(80).optional(),
  documento: zTextoOpt(20).optional(),
  cargo: zTextoOpt(80).optional(),
  telefono: zTextoOpt(40).optional(),
  fecha_incorporacion: zFecha.nullish().optional(),
  rol: z.enum(['administrador', 'recepcion', 'mecanico', 'deposito', 'caja', 'empleado']).optional(),
  activo: z.boolean().optional(),
  password: z.string().min(8).max(200).optional(),
  /** Conceder o quitar el acceso al sistema (quitarlo deja a la persona solo con fichaje por PIN). */
  acceso_erp: z.boolean().optional(),
  email: z.string().trim().email().max(120).optional(),
  es_mecanico: z.boolean().optional(),
  mecanico_id: zId.nullish().optional(),
});

personal.patch('/usuarios/:id', requirePerm('usuarios.gestionar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, zCambios);
  const u = await cargar(c.env.DB, s.tallerId, id);
  exigirGestion(s, u);
  const propio = id === s.usuarioId;
  const rolActual = rolDe(u);
  // Rol, estado y acceso solo se cambian en otras personas y nunca en el propietario.
  if ((d.rol || d.activo !== undefined || d.acceso_erp !== undefined) && (propio || u.nivel === 'propietario')) {
    throw forbidden(u.nivel === 'propietario' ? 'No se puede cambiar el rol, el estado ni el acceso del propietario' : 'No podés cambiar tu propio rol, estado ni acceso');
  }
  if (d.rol && !puedeAsignarRol(s, d.rol)) throw forbidden('No podés asignar ese rol');

  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => (sets.push(`${col} = ?`), vals.push(v));
  for (const k of ['nombre', 'apellido', 'documento', 'cargo', 'telefono', 'fecha_incorporacion'] as const) if (d[k] !== undefined) set(k, d[k] ?? null);
  if (d.rol) {
    set('rol', nivelDeRol(d.rol));
    set('plantilla', d.rol);
    set('permisos_ajustes', null); // un rol nuevo parte de su plantilla
  }
  const stmts: Stmt[] = [];
  const iteraciones = Number(c.env.PBKDF2_ITERATIONS ?? 100000);
  let cierraSesiones = false;

  let accesoFinal = !!u.acceso_erp;
  if (d.acceso_erp === true && !u.acceso_erp) {
    if (!d.email || !d.password) throw badRequest('Para dar acceso al sistema indicá el correo y la contraseña inicial');
    if (await first(c.env.DB, 'SELECT 1 FROM usuarios WHERE email = ?', d.email)) throw new ApiError(409, 'duplicado', 'Ya existe un usuario con ese email');
    set('acceso_erp', 1);
    set('email', d.email);
    set('password_hash', await hashPassword(d.password, iteraciones));
    if (u.activo) stmts.push(guardCupo(c.env.DB, s.tallerId));
    accesoFinal = true;
  } else if (d.acceso_erp === false && u.acceso_erp) {
    if (nivelDeRol(d.rol ?? rolActual) !== 'empleado') throw badRequest('Un administrador necesita acceso al sistema');
    set('acceso_erp', 0);
    set('email', `sin-acceso-${id}@fierro.invalid`);
    set('password_hash', 'sin-acceso');
    cierraSesiones = true;
    accesoFinal = false;
  } else {
    if (d.email && u.acceso_erp) {
      if (await first(c.env.DB, 'SELECT 1 FROM usuarios WHERE email = ? AND id <> ?', d.email, id)) throw new ApiError(409, 'duplicado', 'Ya existe un usuario con ese email');
      set('email', d.email);
    }
    if (d.password) {
      if (!u.acceso_erp) throw badRequest('Esta persona no tiene acceso al sistema');
      set('password_hash', await hashPassword(d.password, iteraciones));
      cierraSesiones = true;
    }
  }
  if (d.activo !== undefined) {
    set('activo', d.activo ? 1 : 0);
    if (d.activo && !u.activo && accesoFinal && u.acceso_erp) stmts.push(guardCupo(c.env.DB, s.tallerId));
    if (!d.activo) cierraSesiones = true;
  }

  // Vinculación con el mecánico de las OT (una sola persona, no dos registros).
  const nombreCompleto = (d.nombre ?? u.nombre) + ((d.apellido !== undefined ? d.apellido : u.apellido) ? ` ${d.apellido !== undefined ? d.apellido : u.apellido}` : '');
  const quiereMecanico = d.es_mecanico ?? (d.rol === 'mecanico' && !u.mecanico_id ? true : undefined);
  const mecStmts: Stmt[] = [];
  if (quiereMecanico === true && (!u.mecanico_id || d.mecanico_id)) {
    mecStmts.push(...(await sentenciasMecanico(c.env.DB, s.tallerId, id, { nombre: d.nombre ?? u.nombre, apellido: d.apellido !== undefined ? d.apellido : u.apellido, telefono: d.telefono !== undefined ? d.telefono : u.telefono, cargo: d.cargo !== undefined ? d.cargo : u.cargo }, d.mecanico_id)));
  } else if (quiereMecanico === false && u.mecanico_id) {
    mecStmts.push(c.env.DB.prepare('UPDATE mecanicos SET usuario_id = NULL, activo = 0 WHERE taller_id = ? AND id = ?').bind(s.tallerId, u.mecanico_id));
  } else if (u.mecanico_id) {
    // El mecánico vinculado acompaña los datos y el estado de la persona.
    mecStmts.push(
      c.env.DB.prepare('UPDATE mecanicos SET nombre = ?, telefono = ?, especialidad = COALESCE(?, especialidad), activo = ? WHERE taller_id = ? AND id = ?')
        .bind(nombreCompleto, d.telefono !== undefined ? d.telefono : u.telefono, d.cargo ?? null, d.activo !== undefined ? (d.activo ? 1 : 0) : u.activo, s.tallerId, u.mecanico_id),
    );
  }
  if (!sets.length && !mecStmts.length) return c.json({ ok: true });
  if (sets.length) stmts.push(c.env.DB.prepare(`UPDATE usuarios SET ${sets.join(', ')} WHERE taller_id = ? AND id = ?`).bind(...vals, s.tallerId, id));
  stmts.push(...mecStmts);
  if (cierraSesiones) stmts.push(c.env.DB.prepare('DELETE FROM sesiones WHERE usuario_id = ? AND taller_id = ?').bind(id, s.tallerId));
  stmts.push(auditar(c.env.DB, s.tallerId, s.usuarioId, 'usuario', id, 'modificar', { ...d, password: d.password ? '***' : undefined, rol_anterior: d.rol ? rolActual : undefined }));
  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    if (String(e).includes('ok = 1')) throw new ApiError(409, 'limite_licencia', 'No hay cupo de usuarios en la licencia para dar acceso a este usuario');
    throw e;
  }
  return c.json({ ok: true });
});

// ───────────── Permisos individuales ─────────────
personal.put('/usuarios/:id/permisos', requirePerm('permisos.gestionar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, z.object({ permisos: z.array(z.string()).max(100).nullable() }));
  const u = await cargar(c.env.DB, s.tallerId, id);
  if (id === s.usuarioId) throw forbidden('No podés modificar tus propios permisos');
  if (u.nivel === 'propietario') throw forbidden('El propietario siempre tiene todos los permisos');
  if (s.nivel !== 'propietario' && u.nivel !== 'empleado') throw forbidden('Solo el propietario puede modificar los permisos de un administrador');
  const rol = rolDe(u);
  const antes = leerAjustes(u.permisos_ajustes);
  const actuales = new Set(permisosEfectivos(rol, antes));
  let despues: { g: Permiso[]; r: Permiso[] };
  if (d.permisos === null) {
    despues = { g: [], r: [] }; // restablecer a la plantilla del rol
  } else {
    const invalidos = d.permisos.filter((p) => !esPermiso(p));
    if (invalidos.length) throw badRequest(`Permisos desconocidos: ${invalidos.join(', ')}`);
    const deseados = d.permisos as Permiso[];
    // Nadie puede otorgar lo que no tiene (un administrador no puede crear otro administrador "por la ventana").
    if (s.nivel !== 'propietario') {
      const indebidos = deseados.filter((p) => !s.permisos.has(p) && !actuales.has(p));
      if (indebidos.length) throw forbidden(`No podés otorgar permisos que vos no tenés (${indebidos.join(', ')})`);
    }
    despues = ajustesDesde(rol, deseados);
  }
  const json = despues.g.length + despues.r.length ? JSON.stringify(despues) : null;
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE usuarios SET permisos_ajustes = ? WHERE taller_id = ? AND id = ?').bind(json, s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'usuario', id, 'permisos', { rol, antes, despues }),
  ]);
  return c.json({ ok: true, permisos: permisosEfectivos(rol, despues), ajustes: despues });
});

// ───────────── PIN del reloj ─────────────
personal.put('/usuarios/:id/pin', requirePerm('reloj.administrar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const d = await body(c, z.object({ pin: zPin }));
  validarPinSeguro(d.pin);
  const u = await cargar(c.env.DB, s.tallerId, id);
  exigirGestion(s, u);
  const hash = await hashPassword(d.pin, Number(c.env.PBKDF2_ITERATIONS ?? 100000));
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE usuarios SET pin_hash = ?, pin_intentos = 0, pin_bloqueado_hasta = NULL, pin_actualizado_at = ? WHERE taller_id = ? AND id = ?').bind(hash, ahora(), s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'usuario', id, 'pin_asignado'),
  ]);
  return c.json({ ok: true });
});

personal.delete('/usuarios/:id/pin', requirePerm('reloj.administrar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const u = await cargar(c.env.DB, s.tallerId, id);
  exigirGestion(s, u);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE usuarios SET pin_hash = NULL, pin_intentos = 0, pin_bloqueado_hasta = NULL WHERE taller_id = ? AND id = ?').bind(s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'usuario', id, 'pin_quitado'),
  ]);
  return c.json({ ok: true });
});

/** Desbloquea el PIN de una persona (por ejemplo tras errores repetidos en el reloj). */
personal.post('/usuarios/:id/pin/desbloquear', requirePerm('reloj.administrar'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  const u = await cargar(c.env.DB, s.tallerId, id);
  exigirGestion(s, u);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE usuarios SET pin_intentos = 0, pin_bloqueado_hasta = NULL WHERE taller_id = ? AND id = ?').bind(s.tallerId, id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'usuario', id, 'pin_desbloqueado'),
  ]);
  return c.json({ ok: true });
});

/** Cada persona puede cambiar su propio PIN confirmando su contraseña. */
personal.put('/mi-pin', requirePerm('asistencia.fichar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, z.object({ password: z.string().min(1).max(200), pin: zPin }));
  validarPinSeguro(d.pin);
  const u = await first<{ password_hash: string }>(c.env.DB, 'SELECT password_hash FROM usuarios WHERE taller_id = ? AND id = ?', s.tallerId, s.usuarioId);
  if (!u || !(await verificarPassword(d.password, u.password_hash))) throw badRequest('La contraseña no es correcta');
  const hash = await hashPassword(d.pin, Number(c.env.PBKDF2_ITERATIONS ?? 100000));
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE usuarios SET pin_hash = ?, pin_intentos = 0, pin_bloqueado_hasta = NULL, pin_actualizado_at = ? WHERE taller_id = ? AND id = ?').bind(hash, ahora(), s.tallerId, s.usuarioId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'usuario', s.usuarioId, 'pin_cambiado'),
  ]);
  return c.json({ ok: true });
});

/** Catálogo de roles para armar formularios (los roles son plantillas de permisos fijas del sistema). */
personal.get('/roles', requirePerm('usuarios.gestionar'), (c) => {
  const s = c.get('sesion');
  return c.json(
    ROLES.filter((r) => r !== 'propietario').map((r) => ({
      codigo: r,
      etiqueta: PLANTILLAS[r].etiqueta,
      descripcion: PLANTILLAS[r].descripcion,
      heredada: !!PLANTILLAS[r].heredada,
      asignable: puedeAsignarRol(s, r),
      permisos: permisosEfectivos(r),
    })),
  );
});
