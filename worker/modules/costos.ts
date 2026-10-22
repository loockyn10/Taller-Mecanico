// Costo horario INTERNO de la mano de obra (por persona y general del taller). Es información confidencial: solo la ve y la modifica quien tiene permisos
// económicos (`margenes.ver`, y `precios.gestionar` para cambiarla). Un mecánico sin esos permisos no la recibe en ninguna respuesta de la API.
//
// Cambiar un costo no altera lo ya trabajado: cada tramo del cronómetro congela el costo vigente al cerrarse (ver lib/rentabilidad.ts).
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, zCentavos, zId } from '../lib/http';
import { all, auditar, lotes, type Stmt } from '../lib/db';
import { requirePerm } from '../lib/auth';
import { esRol, nivelDeRol, PLANTILLAS, type Rol } from '../../shared/permisos';

export const costos = new Hono<AppEnv>();

costos.get('/costos-mano-obra', requirePerm('margenes.ver'), async (c) => {
  const s = c.get('sesion');
  const [cfg, personas] = await Promise.all([
    all<{ g: number | null; tarifa: number }>(c.env.DB, 'SELECT costo_hora_general AS g, tarifa_hora AS tarifa FROM taller_config WHERE taller_id = ?', s.tallerId),
    all<{ id: string; nombre: string; apellido: string | null; rol: string; plantilla: string | null; activo: number; costo_hora: number | null; mecanico: number }>(
      c.env.DB,
      `SELECT u.id, u.nombre, u.apellido, u.rol, u.plantilla, u.activo, u.costo_hora,
              EXISTS (SELECT 1 FROM mecanicos m WHERE m.taller_id = u.taller_id AND m.usuario_id = u.id) AS mecanico
         FROM usuarios u WHERE u.taller_id = ? ORDER BY u.activo DESC, mecanico DESC, u.nombre COLLATE NOCASE`,
      s.tallerId,
    ),
  ]);
  return c.json({
    general: cfg[0]?.g ?? null,
    tarifa_hora: cfg[0]?.tarifa ?? 0,
    personas: personas.map((p) => {
      const rol: Rol = esRol(p.plantilla) && nivelDeRol(p.plantilla) === p.rol ? p.plantilla : (p.rol as Rol);
      return { usuario_id: p.id, nombre: p.apellido ? `${p.nombre} ${p.apellido}` : p.nombre, rol: PLANTILLAS[rol]?.etiqueta ?? p.rol, activo: !!p.activo, mecanico: !!p.mecanico, costo_hora: p.costo_hora };
    }),
    nota: 'Costo interno por hora de trabajo. Se usa para calcular la rentabilidad de las órdenes; no se muestra a quienes no tienen permisos económicos. Al cerrar cada tramo del cronómetro se guarda el costo vigente: cambiarlo después no modifica lo ya trabajado.',
  });
});

costos.put('/costos-mano-obra', requirePerm('margenes.ver', 'precios.gestionar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(
    c,
    z.object({
      /** Costo horario general (centavos por hora). null = sin costo general. Se omite = no cambia. */
      general: zCentavos.nullable().optional(),
      personas: z.array(z.object({ usuario_id: zId, costo_hora: zCentavos.nullable() })).max(200).default([]),
    }),
  );
  const ids = [...new Set(d.personas.map((p) => p.usuario_id))];
  if (ids.length !== d.personas.length) throw badRequest('Hay personas repetidas');
  for (const lote of lotes(ids)) {
    const filas = await all(c.env.DB, `SELECT id FROM usuarios WHERE taller_id = ? AND id IN (${lote.map(() => '?').join(',')})`, s.tallerId, ...lote);
    if (filas.length !== lote.length) throw badRequest('Hay personas inexistentes');
  }
  const stmts: Stmt[] = [];
  if (d.general !== undefined) stmts.push(c.env.DB.prepare('UPDATE taller_config SET costo_hora_general = ? WHERE taller_id = ?').bind(d.general, s.tallerId));
  for (const p of d.personas) stmts.push(c.env.DB.prepare('UPDATE usuarios SET costo_hora = ? WHERE taller_id = ? AND id = ?').bind(p.costo_hora, s.tallerId, p.usuario_id));
  if (!stmts.length) return c.json({ ok: true });
  // El historial de auditoría no guarda los importes: es información confidencial y la ve quien tiene acceso a la configuración.
  stmts.push(auditar(c.env.DB, s.tallerId, s.usuarioId, 'costos_mano_obra', null, 'actualizar', { general: d.general !== undefined, personas: d.personas.length }));
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});
