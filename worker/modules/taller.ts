// Configuración del taller, usuarios (empleados con acceso) y licencia.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, notFound, zCentavos, zFecha, zTextoOpt } from '../lib/http';
import { all, auditar, first } from '../lib/db';
import { requirePerm, tiene } from '../lib/auth';
import { datosLicencia } from '../lib/licencia';
import { zonaValida } from '../lib/zona';
import { CONDICIONES_IVA, cuitValido, MEDIOS_PAGO } from '../../shared/dominio';
import { LOGO_MAX_CHARS, validarHorarios, type HorariosAtencion } from '../../shared/puesta';

export const taller = new Hono<AppEnv>();

// ───── Configuración ─────
taller.get('/config', async (c) => {
  const s = c.get('sesion');
  const t = await first(c.env.DB, 'SELECT id, nombre, razon_social, cuit, condicion_iva, direccion, localidad, provincia, telefono, email, ingresos_brutos, inicio_actividades, sitio_web FROM talleres WHERE id = ?', s.tallerId);
  const cfg = await first<{ medios_pago: string | null; horarios_atencion: string | null; logo: string | null }>(c.env.DB, 'SELECT * FROM taller_config WHERE taller_id = ?', s.tallerId);
  // medios_pago se entrega como lista (null = todos habilitados). El margen sugerido es información de márgenes.
  const config = cfg && { ...cfg, logo: undefined, tiene_logo: !!cfg.logo, horarios_atencion: cfg.horarios_atencion ? JSON.parse(cfg.horarios_atencion) : null, medios_pago: cfg.medios_pago ? JSON.parse(cfg.medios_pago) : null, ...(tiene(s, 'margenes.ver') ? {} : { margen_default: undefined, costo_hora_general: undefined }) };
  return c.json({ taller: t, config });
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
        /** Sin enviar: se conserva la que ya tenía. */
        provincia: z.string().trim().max(80).nullish(),
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
        margen_default: z.number().min(0).max(1000).nullish(),
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
        // Zona horaria con la que se muestran los horarios y se agrupan los reportes de asistencia.
        zona_horaria: z.string().max(60).refine(zonaValida, 'zona horaria inválida').default('America/Argentina/Buenos_Aires'),
      }),
    }),
  );
  const t = d.taller;
  const k = d.config;
  if (t.cuit && !cuitValido(t.cuit)) throw badRequest('El CUIT del taller no es válido');
  const medios = k.medios_pago ? MEDIOS_PAGO.filter((m) => m === 'efectivo' || k.medios_pago!.includes(m)) : null;
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE talleres SET nombre=?, razon_social=?, cuit=?, condicion_iva=?, direccion=?, localidad=?, provincia=CASE WHEN ? = 1 THEN ? ELSE provincia END, telefono=?, email=?, ingresos_brutos=?, inicio_actividades=?, sitio_web=? WHERE id=?')
      .bind(t.nombre, t.razon_social, t.cuit, t.condicion_iva, t.direccion, t.localidad, t.provincia === undefined ? 0 : 1, t.provincia || null, t.telefono, t.email, t.ingresos_brutos, t.inicio_actividades, t.sitio_web, s.tallerId),
    c.env.DB.prepare(
      `UPDATE taller_config SET iva_default=?, recargo_default=?, validez_presupuesto_dias=?, margen_default=COALESCE(?, margen_default), pie_documentos=?, pie_presupuesto=?, pie_recibo=?, pie_orden_compra=?,
              permitir_stock_negativo=?, caja_obligatoria=?, tolerancia_caja=?, alerta_cheques_dias=?, plazo_pago_dias=?, medios_pago=?, zona_horaria=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id=?`,
    ).bind(k.iva_default, k.recargo_default, k.validez_presupuesto_dias, tiene(s, 'margenes.ver') ? k.margen_default ?? null : null, k.pie_documentos, k.pie_presupuesto, k.pie_recibo, k.pie_orden_compra, k.permitir_stock_negativo ? 1 : 0, k.caja_obligatoria ? 1 : 0, k.tolerancia_caja, k.alerta_cheques_dias, k.plazo_pago_dias, medios ? JSON.stringify(medios) : null, k.zona_horaria, s.tallerId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'config', s.tallerId, 'actualizar'),
  ]);
  return c.json({ ok: true });
});

// ───── Licencia ─────
taller.get('/licencia', requirePerm('licencia.ver'), async (c) => {
  const s = c.get('sesion');
  const lic = await datosLicencia(c.env.DB, s.tallerId);
  const eventos = await all(c.env.DB, 'SELECT tipo, detalle, created_at FROM licencia_eventos WHERE taller_id = ? ORDER BY created_at DESC LIMIT 20', s.tallerId);
  return c.json({ ...lic, eventos });
});

// Los usuarios, roles y permisos están en modules/personal.ts (montado también bajo /taller).

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

// ───── Horarios de atención ─────
taller.put('/horarios', requirePerm('config.editar'), async (c) => {
  const s = c.get('sesion');
  const d = await body(
    c,
    z.object({
      dias: z.array(z.object({ dia: z.number().int().min(1).max(7), abierto: z.boolean(), tramos: z.array(z.object({ desde: z.string().max(5), hasta: z.string().max(5) })).max(2) })).length(7),
    }),
  );
  const h: HorariosAtencion = { dias: d.dias.map((x) => ({ ...x, tramos: x.abierto ? x.tramos : [] })) };
  const problema = validarHorarios(h);
  if (problema) throw badRequest(problema);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE taller_config SET horarios_atencion = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ?").bind(JSON.stringify(h), s.tallerId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'config', s.tallerId, 'horarios'),
  ]);
  return c.json({ ok: true });
});

// ───── Logo ─────
// Se guarda como imagen (png, jpeg o webp) de hasta ~200 KB y se sirve con su tipo real: nunca SVG ni HTML, que podrían ejecutar código.
const FIRMAS: Record<string, (b: Uint8Array) => boolean> = {
  png: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
};

taller.put('/logo', requirePerm('config.editar'), async (c) => {
  const s = c.get('sesion');
  const { imagen } = await body(c, z.object({ imagen: z.string().max(LOGO_MAX_CHARS, 'El logo es demasiado pesado (máximo 200 KB)') }));
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(imagen);
  if (!m) throw badRequest('El logo debe ser una imagen PNG, JPG o WebP');
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(m[2]), (ch) => ch.charCodeAt(0));
  } catch {
    throw badRequest('La imagen está dañada');
  }
  if (!FIRMAS[m[1]](bytes)) throw badRequest('El contenido del archivo no corresponde a una imagen ' + m[1].toUpperCase());
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE taller_config SET logo = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE taller_id = ?").bind(imagen, s.tallerId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'config', s.tallerId, 'logo'),
  ]);
  return c.json({ ok: true });
});

taller.delete('/logo', requirePerm('config.editar'), async (c) => {
  const s = c.get('sesion');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE taller_config SET logo = NULL WHERE taller_id = ?').bind(s.tallerId),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'config', s.tallerId, 'quitar_logo'),
  ]);
  return c.json({ ok: true });
});

/** Imagen del logo del propio taller (para pantallas y documentos). */
taller.get('/logo', async (c) => {
  const s = c.get('sesion');
  const r = await first<{ logo: string | null }>(c.env.DB, 'SELECT logo FROM taller_config WHERE taller_id = ?', s.tallerId);
  const m = r?.logo ? /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(r.logo) : null;
  if (!m) throw notFound('Logo');
  const bytes = Uint8Array.from(atob(m[2]), (ch) => ch.charCodeAt(0));
  return new Response(bytes, { headers: { 'content-type': 'image/' + m[1], 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'private, no-store' } });
});
