// Puesta en marcha: progreso de la configuración inicial, pasos marcados a mano y plantillas generales.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { body, forbidden } from '../lib/http';
import { auditar, uid } from '../lib/db';
import { requirePerm, tiene } from '../lib/auth';
import { calcularPuesta } from '../lib/puesta-en-marcha';
import { PASOS } from '../../shared/puesta';
import { CATEGORIAS_ARTICULO_PLANTILLA, CATEGORIAS_GASTO_PLANTILLA, MARCAS_PLANTILLA } from '../../shared/plantillas';

export const puesta = new Hono<AppEnv>();
puesta.use('*', requirePerm('config.editar'));

puesta.get('/', async (c) => c.json(await calcularPuesta(c.env.DB, c.get('sesion').tallerId)));

/** Marca un paso como hecho u omitido, o lo vuelve a pendiente. Un paso que los datos ya dan por completo no depende de esta marca. */
puesta.put('/pasos/:paso', async (c) => {
  const s = c.get('sesion');
  const paso = c.req.param('paso');
  const d = await body(c, z.object({ estado: z.enum(['hecho', 'omitido', 'pendiente']) }));
  if (!(PASOS as readonly string[]).includes(paso)) return c.json({ error: { code: 'no_encontrado', message: 'Paso inexistente' } }, 404);
  const db = c.env.DB;
  await db.batch([
    d.estado === 'pendiente'
      ? db.prepare('DELETE FROM puesta_marcha_pasos WHERE taller_id = ? AND paso = ?').bind(s.tallerId, paso)
      : db.prepare(
          `INSERT INTO puesta_marcha_pasos (taller_id, paso, estado, usuario_id) VALUES (?, ?, ?, ?)
           ON CONFLICT (taller_id, paso) DO UPDATE SET estado = excluded.estado, usuario_id = excluded.usuario_id, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        ).bind(s.tallerId, paso, d.estado, s.usuarioId),
    auditar(db, s.tallerId, s.usuarioId, 'puesta_en_marcha', paso, d.estado),
  ]);
  return c.json(await calcularPuesta(db, s.tallerId));
});

/** El asistente deja de aparecer solo al iniciar sesión (el progreso sigue disponible en Administración). */
puesta.post('/cerrar', async (c) => {
  const s = c.get('sesion');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE taller_config SET asistente_pendiente = 0 WHERE taller_id = ?').bind(s.tallerId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'puesta_en_marcha', null, 'cerrar_asistente'),
  ]);
  return c.json({ ok: true });
});

/**
 * Agrega al taller las categorías generales que le falten (rubros de repuestos, tipos de gastos y marcas/modelos). No toca nada de lo que
 * ya tiene ni copia datos de otros talleres: son listas generales de la plataforma, sin precios.
 */
puesta.post('/plantillas', async (c) => {
  const s = c.get('sesion');
  const d = await body(c, z.object({ categorias_articulo: z.boolean().default(false), tipos_gasto: z.boolean().default(false), marcas: z.boolean().default(false) }));
  if ((d.categorias_articulo || d.marcas) && !tiene(s, 'catalogo.editar')) throw forbidden('No tenés permiso para modificar el catálogo');
  if (d.tipos_gasto && !tiene(s, 'gastos.gestionar')) throw forbidden('No tenés permiso para gestionar categorías de gastos');
  const db = c.env.DB;
  const stmts: D1PreparedStatement[] = [];
  const rangos: Record<'categorias_articulo' | 'tipos_gasto' | 'marcas' | 'modelos', [number, number]> = { categorias_articulo: [0, 0], tipos_gasto: [0, 0], marcas: [0, 0], modelos: [0, 0] };
  const seccion = (k: keyof typeof rangos, agregar: () => void) => {
    const ini = stmts.length;
    agregar();
    rangos[k] = [ini, stmts.length];
  };
  const marcasPlantilla = Object.entries(MARCAS_PLANTILLA);
  if (d.categorias_articulo) seccion('categorias_articulo', () => { for (const n of CATEGORIAS_ARTICULO_PLANTILLA) stmts.push(db.prepare('INSERT OR IGNORE INTO categorias_articulo (id, taller_id, nombre) VALUES (?, ?, ?)').bind(uid(), s.tallerId, n)); });
  if (d.tipos_gasto) seccion('tipos_gasto', () => { for (const [n, tipo] of CATEGORIAS_GASTO_PLANTILLA) stmts.push(db.prepare('INSERT OR IGNORE INTO categorias_gasto (id, taller_id, nombre, tipo) VALUES (?, ?, ?, ?)').bind(uid(), s.tallerId, n, tipo)); });
  if (d.marcas) {
    seccion('marcas', () => { for (const [marca] of marcasPlantilla) stmts.push(db.prepare('INSERT OR IGNORE INTO marcas (id, taller_id, nombre) VALUES (?, ?, ?)').bind(uid(), s.tallerId, marca)); });
    seccion('modelos', () => {
      for (const [marca, modelos] of marcasPlantilla) {
        for (const m of modelos) stmts.push(db.prepare('INSERT OR IGNORE INTO modelos (id, taller_id, marca_id, nombre) SELECT ?, taller_id, id, ? FROM marcas WHERE taller_id = ? AND nombre = ?').bind(uid(), m, s.tallerId, marca));
      }
    });
  }
  if (!stmts.length) return c.json({ categorias_articulo: 0, tipos_gasto: 0, marcas: 0, modelos: 0 });
  stmts.push(auditar(db, s.tallerId, s.usuarioId, 'puesta_en_marcha', null, 'plantillas', d));
  const r = await db.batch(stmts);
  const creados = (k: keyof typeof rangos) => r.slice(rangos[k][0], rangos[k][1]).reduce((x, y) => x + (y.meta.changes ?? 0), 0);
  return c.json({ categorias_articulo: creados('categorias_articulo'), tipos_gasto: creados('tipos_gasto'), marcas: creados('marcas'), modelos: creados('modelos') });
});
