// Configuración del taller, usuarios (empleados con acceso) y licencia.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, body, zCentavos, zFecha, zTextoOpt } from '../lib/http';
import { all, auditar, first } from '../lib/db';
import { requirePerm, tiene } from '../lib/auth';
import { datosLicencia } from '../lib/licencia';
import { zonaValida } from '../lib/zona';
import { CONDICIONES_IVA, cuitValido, MEDIOS_PAGO } from '../../shared/dominio';

export const taller = new Hono<AppEnv>();

// ───── Configuración ─────
taller.get('/config', async (c) => {
  const s = c.get('sesion');
  const t = await first(c.env.DB, 'SELECT id, nombre, razon_social, cuit, condicion_iva, direccion, localidad, telefono, email, ingresos_brutos, inicio_actividades, sitio_web FROM talleres WHERE id = ?', s.tallerId);
  const cfg = await first<{ medios_pago: string | null }>(c.env.DB, 'SELECT * FROM taller_config WHERE taller_id = ?', s.tallerId);
  // medios_pago se entrega como lista (null = todos habilitados). El margen sugerido es información de márgenes.
  const config = cfg && { ...cfg, medios_pago: cfg.medios_pago ? JSON.parse(cfg.medios_pago) : null, ...(tiene(s, 'margenes.ver') ? {} : { margen_default: undefined, costo_hora_general: undefined }) };
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
    c.env.DB.prepare('UPDATE talleres SET nombre=?, razon_social=?, cuit=?, condicion_iva=?, direccion=?, localidad=?, telefono=?, email=?, ingresos_brutos=?, inicio_actividades=?, sitio_web=? WHERE id=?')
      .bind(t.nombre, t.razon_social, t.cuit, t.condicion_iva, t.direccion, t.localidad, t.telefono, t.email, t.ingresos_brutos, t.inicio_actividades, t.sitio_web, s.tallerId),
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
