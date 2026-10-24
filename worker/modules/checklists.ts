// Recepción y entrega de vehículos (Sprint 18): checklist de ingreso y de salida de una orden de trabajo, con daños, fotografías (las del Sprint 16) y la
// conformidad del cliente. Ver docs/CHECKLIST.md.
//
// Ciclo de un registro:  borrador (se edita y se guarda en el servidor)  →  confirmado (queda congelado: el servidor calcula el sha256 del contenido exacto)
//                        →  firma / "no presente" / "se niega" (se agrega aparte, apunta a ese sha256)  →  corrección = REVISIÓN nueva (el original no se toca).
// Nada de lo que devuelve este módulo contiene precios, costos ni importes: se consulta con `checklists.ver`, independiente de los permisos financieros.
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv, Sesion } from '../env';
import { badRequest, body, conflict, forbidden, notFound, zId } from '../lib/http';
import { all, auditar, ahora, first, guard, uid } from '../lib/db';
import { requirePerm, tiene } from '../lib/auth';
import { sha256 } from '../lib/fotos';
import { ASIGNADA_A_MI, esAsignadaAMi } from './ordenes';
import { COMBUSTIBLE_NIVELES } from '../../shared/dominio';
import {
  CHECKLIST_VERSION, CODIGOS_ITEM, ESTADOS_ITEM, TEXTO_CONFORMIDAD_VERSION, TIPOS_REGISTRO, ZONAS_DANO, jsonCanonico, textoConformidad,
  type ContenidoChecklist, type ContextoConfirmado, type TipoRegistro,
} from '../../shared/checklist';

export const checklists = new Hono<AppEnv>();

const ETAPA_DE: Record<TipoRegistro, 'recepcion' | 'entrega'> = { recepcion: 'recepcion', entrega: 'entrega' };
const PERMISO_DE: Record<TipoRegistro, 'checklists.recepcion' | 'checklists.entrega'> = { recepcion: 'checklists.recepcion', entrega: 'checklists.entrega' };

// ───────────── Validación del contenido ─────────────
const zTipo = z.enum(TIPOS_REGISTRO);
const zItem = z.object({ estado: z.enum(ESTADOS_ITEM), obs: z.string().trim().max(300).optional() }).strict();
const zDano = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9-]{6,64}$/, 'identificador de daño inválido'),
    zona: z.enum(ZONAS_DANO),
    x: z.number().min(0).max(100).optional(),
    y: z.number().min(0).max(100).optional(),
    descripcion: z.string().trim().max(500),
    fotos: z.array(zId).max(12),
  })
  .strict();
const zDescripcion = z.object({ descripcion: z.string().trim().min(1).max(120) }).strict();
export const zContenido = z
  .object({
    fecha_hora: z.string().datetime({ message: 'fecha y hora inválidas' }),
    km: z.number().int().min(0).max(5_000_000).nullable(),
    combustible: z.enum(COMBUSTIBLE_NIVELES).nullable(),
    llaves: z.number().int().min(0).max(20).nullable(),
    observaciones: z.string().trim().max(2000),
    items: z.record(z.string(), zItem),
    danos: z.array(zDano).max(30),
    pertenencias: z.array(zDescripcion).max(40),
    estado_general: z.string().trim().max(1000),
    trabajos: z.array(zDescripcion).max(60),
  })
  .strict();

function validarContenido(tipo: TipoRegistro, c: ContenidoChecklist): void {
  const malos = Object.keys(c.items).filter((k) => !CODIGOS_ITEM.has(k));
  if (malos.length) throw badRequest(`Punto de control desconocido: ${malos[0]}`);
  if (new Set(c.danos.map((d) => d.id)).size !== c.danos.length) throw badRequest('Hay daños con el mismo identificador');
  if (tipo === 'recepcion' && (c.trabajos.length || c.estado_general)) throw badRequest('Los trabajos realizados y el estado general sólo se registran en la entrega');
  if (Date.parse(c.fecha_hora) > Date.now() + 10 * 60_000) throw badRequest('La fecha y hora no puede ser futura');
}

// ───────────── Acceso ─────────────
async function veOrden(c: Context<AppEnv>, s: Sesion, ordenId: string): Promise<boolean> {
  if (tiene(s, 'ordenes.ver')) return true;
  return tiene(s, 'ordenes.asignadas') && (await esAsignadaAMi(c.env.DB, s, ordenId));
}

interface Orden {
  id: string;
  numero: number;
  estado: string;
  cliente_id: string;
  vehiculo_id: string;
  km_ingreso: number | null;
}
async function cargarOrden(c: Context<AppEnv>, s: Sesion, ordenId: string): Promise<Orden> {
  const o = await first<Orden>(c.env.DB, 'SELECT id, numero, estado, cliente_id, vehiculo_id, km_ingreso FROM ordenes WHERE taller_id = ? AND id = ?', s.tallerId, ordenId);
  if (!o) throw notFound('Orden de trabajo');
  if (!(await veOrden(c, s, ordenId))) throw forbidden('No tenés acceso a esta orden de trabajo');
  return o;
}

interface Fila {
  id: string;
  orden_id: string;
  vehiculo_id: string;
  cliente_id: string;
  tipo: TipoRegistro;
  revision: number;
  previo_id: string | null;
  motivo: string | null;
  recepcion_id: string | null;
  estado: 'borrador' | 'confirmado';
  version: number;
  checklist_version: number;
  datos: string;
  contexto: string | null;
  contenido_sha256: string | null;
  fecha_hora: string;
  responsable_id: string | null;
  responsable_nombre: string;
  created_at: string;
  updated_at: string;
  confirmado_at: string | null;
  confirmado_por_nombre: string | null;
}
interface FilaFirma {
  id: string;
  registro_id: string;
  resultado: 'firmada' | 'no_presente' | 'se_niega';
  nombre_firmante: string | null;
  aclaracion: string | null;
  firma: string | null;
  firma_sha256: string | null;
  contenido_sha256: string;
  texto_conformidad: string;
  texto_version: number;
  registrado_por_nombre: string;
  created_at: string;
}

const COLS = `id, orden_id, vehiculo_id, cliente_id, tipo, revision, previo_id, motivo, recepcion_id, estado, version, checklist_version, datos, contexto, contenido_sha256,
  fecha_hora, responsable_id, responsable_nombre, created_at, updated_at, confirmado_at, confirmado_por_nombre`;

async function cargarRegistro(c: Context<AppEnv>, s: Sesion, id: string): Promise<Fila> {
  const r = await first<Fila>(c.env.DB, `SELECT ${COLS} FROM ck_registros WHERE taller_id = ? AND id = ?`, s.tallerId, id);
  if (!r) throw notFound('Registro');
  if (!(await veOrden(c, s, r.orden_id))) throw forbidden('No tenés acceso a esta orden de trabajo');
  return r;
}

/** Quién puede editar, descartar, confirmar y firmar: el permiso del tipo (o el de corregir, si es una revisión). */
function exigirEscritura(s: Sesion, r: Pick<Fila, 'tipo' | 'revision'>) {
  const ok = tiene(s, PERMISO_DE[r.tipo]) || (r.revision > 0 && tiene(s, 'checklists.corregir'));
  if (!ok) throw forbidden(`No tenés permiso para registrar ${r.tipo === 'recepcion' ? 'recepciones' : 'entregas'}`);
}

function firmaEstado(r: Pick<Fila, 'estado'>, firmas: Array<Pick<FilaFirma, 'resultado'>>): 'firmada' | 'no_presente' | 'se_niega' | 'pendiente' | null {
  if (r.estado === 'borrador') return null;
  if (firmas.some((f) => f.resultado === 'firmada')) return 'firmada';
  const ultima = firmas[firmas.length - 1];
  return ultima ? ultima.resultado : 'pendiente';
}

function serializar(r: Fila, firmas: FilaFirma[], verFirmas: boolean) {
  return {
    id: r.id,
    orden_id: r.orden_id,
    vehiculo_id: r.vehiculo_id,
    tipo: r.tipo,
    revision: r.revision,
    previo_id: r.previo_id,
    motivo: r.motivo,
    recepcion_id: r.recepcion_id,
    estado: r.estado,
    version: r.version,
    checklist_version: r.checklist_version,
    datos: JSON.parse(r.datos) as ContenidoChecklist,
    contexto: r.contexto ? (JSON.parse(r.contexto) as ContextoConfirmado) : null,
    contenido_sha256: r.contenido_sha256,
    responsable_nombre: r.responsable_nombre,
    created_at: r.created_at,
    updated_at: r.updated_at,
    confirmado_at: r.confirmado_at,
    confirmado_por_nombre: r.confirmado_por_nombre,
    firma_estado: firmaEstado(r, firmas),
    firmas: firmas.map((f) => ({
      id: f.id,
      resultado: f.resultado,
      created_at: f.created_at,
      registrado_por_nombre: f.registrado_por_nombre,
      contenido_sha256: f.contenido_sha256,
      texto_version: f.texto_version,
      // Los datos de quien firmó y el dibujo de la firma sólo con el permiso específico.
      ...(verFirmas ? { nombre_firmante: f.nombre_firmante, aclaracion: f.aclaracion, firma: f.firma ? JSON.parse(f.firma) : null, firma_sha256: f.firma_sha256, texto_conformidad: f.texto_conformidad } : {}),
    })),
  };
}

async function firmasDe(c: Context<AppEnv>, tallerId: string, ids: string[]): Promise<Map<string, FilaFirma[]>> {
  const m = new Map<string, FilaFirma[]>();
  if (!ids.length) return m;
  const filas = await all<FilaFirma>(
    c.env.DB,
    `SELECT id, registro_id, resultado, nombre_firmante, aclaracion, firma, firma_sha256, contenido_sha256, texto_conformidad, texto_version, registrado_por_nombre, created_at
       FROM ck_firmas WHERE taller_id = ? AND registro_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at, id`,
    tallerId,
    ...ids,
  );
  for (const f of filas) m.set(f.registro_id, [...(m.get(f.registro_id) ?? []), f]);
  return m;
}

async function devolver(c: Context<AppEnv>, s: Sesion, id: string, status: 200 | 201 = 200) {
  const r = await cargarRegistro(c, s, id);
  const f = await firmasDe(c, s.tallerId, [id]);
  return c.json(serializar(r, f.get(id) ?? [], tiene(s, 'checklists.firmas')), status);
}

/** Todas las fotografías indicadas deben ser de esta OT, de este taller y estar listas. */
async function validarFotos(c: Context<AppEnv>, s: Sesion, ordenId: string, contenido: ContenidoChecklist) {
  const ids = [...new Set(contenido.danos.flatMap((d) => d.fotos))];
  if (!ids.length) return;
  const ok = await all<{ id: string }>(
    c.env.DB,
    `SELECT id FROM fotos WHERE taller_id = ? AND orden_id = ? AND estado = 'lista' AND id IN (${ids.map(() => '?').join(',')})`,
    s.tallerId,
    ordenId,
    ...ids,
  );
  if (ok.length !== ids.length) throw badRequest('Alguna fotografía de los daños no existe o no pertenece a esta orden');
}

async function sugerirTrabajos(c: Context<AppEnv>, s: Sesion, ordenId: string): Promise<Array<{ descripcion: string }>> {
  const tareas = await all<{ descripcion: string }>(c.env.DB, "SELECT descripcion FROM orden_tareas WHERE taller_id = ? AND orden_id = ? AND estado = 'completada' ORDER BY posicion LIMIT 60", s.tallerId, ordenId);
  const base = tareas.length
    ? tareas
    : await all<{ descripcion: string }>(c.env.DB, "SELECT descripcion FROM orden_items WHERE taller_id = ? AND orden_id = ? AND tipo IN ('servicio', 'libre') ORDER BY orden LIMIT 60", s.tallerId, ordenId);
  const vistos = new Set<string>();
  const out: Array<{ descripcion: string }> = [];
  for (const t of base) {
    const d = t.descripcion.trim().slice(0, 120);
    if (d && !vistos.has(d.toLowerCase())) (vistos.add(d.toLowerCase()), out.push({ descripcion: d }));
  }
  return out;
}

// ───────────── Consultas ─────────────
checklists.get('/ordenes/:id/checklists', requirePerm('checklists.ver'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  await cargarOrden(c, s, id);
  const filas = await all<Fila>(c.env.DB, `SELECT ${COLS} FROM ck_registros WHERE taller_id = ? AND orden_id = ? ORDER BY tipo, revision`, s.tallerId, id);
  const firmas = await firmasDe(c, s.tallerId, filas.map((f) => f.id));
  const verFirmas = tiene(s, 'checklists.firmas');
  return c.json({ registros: filas.map((f) => serializar(f, firmas.get(f.id) ?? [], verFirmas)) });
});

/** Historial del vehículo: los checklists de todas sus órdenes (sólo las propias para quien únicamente ve las asignadas). */
checklists.get('/vehiculos/:id/checklists', requirePerm('checklists.ver', 'vehiculos.ver'), async (c) => {
  const s = c.get('sesion');
  const id = c.req.param('id');
  if (!(await first(c.env.DB, 'SELECT 1 FROM vehiculos WHERE taller_id = ? AND id = ?', s.tallerId, id))) throw notFound('Vehículo');
  const propias = !tiene(s, 'ordenes.ver');
  const filas = await all<{
    id: string; tipo: TipoRegistro; revision: number; estado: string; fecha_hora: string; km: number | null; combustible: string | null; orden_id: string; orden_numero: number;
    orden_estado: string; orden_fecha: string; danos: number; responsable_nombre: string; firma_estado: string | null;
  }>(
    c.env.DB,
    `SELECT r.id, r.tipo, r.revision, r.estado, r.fecha_hora, r.km, r.combustible, r.orden_id, o.numero AS orden_numero, o.estado AS orden_estado, o.created_at AS orden_fecha,
            COALESCE(json_array_length(json_extract(r.datos, '$.danos')), 0) AS danos, r.responsable_nombre,
            (SELECT CASE WHEN SUM(f.resultado = 'firmada') > 0 THEN 'firmada' ELSE (SELECT f2.resultado FROM ck_firmas f2 WHERE f2.taller_id = r.taller_id AND f2.registro_id = r.id ORDER BY f2.created_at DESC, f2.id DESC LIMIT 1) END
               FROM ck_firmas f WHERE f.taller_id = r.taller_id AND f.registro_id = r.id) AS firma_estado
       FROM ck_registros r JOIN ordenes o ON o.taller_id = r.taller_id AND o.id = r.orden_id
      WHERE r.taller_id = ? AND r.vehiculo_id = ? ${propias ? `AND ${tiene(s, 'ordenes.asignadas') ? ASIGNADA_A_MI : '0'}` : ''}
      ORDER BY o.numero DESC, r.tipo, r.revision DESC LIMIT 300`,
    s.tallerId,
    id,
    ...(propias && tiene(s, 'ordenes.asignadas') ? [s.usuarioId, s.usuarioId, s.usuarioId] : []),
  );
  const ordenes = new Map<string, { orden_id: string; numero: number; estado: string; fecha: string; registros: unknown[] }>();
  for (const f of filas) {
    const o = ordenes.get(f.orden_id) ?? { orden_id: f.orden_id, numero: f.orden_numero, estado: f.orden_estado, fecha: f.orden_fecha, registros: [] };
    o.registros.push({
      id: f.id, tipo: f.tipo, revision: f.revision, estado: f.estado, fecha_hora: f.fecha_hora, km: f.km, combustible: f.combustible, danos: f.danos, responsable_nombre: f.responsable_nombre,
      firma_estado: f.estado === 'borrador' ? null : (f.firma_estado ?? 'pendiente'),
    });
    ordenes.set(f.orden_id, o);
  }
  return c.json([...ordenes.values()]);
});

// ───────────── Crear / editar / descartar el borrador ─────────────
checklists.post('/ordenes/:id/checklists/:tipo/borrador', async (c) => {
  const s = c.get('sesion');
  const tipo = zTipo.safeParse(c.req.param('tipo'));
  if (!tipo.success) throw notFound('Tipo de registro');
  if (!tiene(s, 'checklists.ver') || !tiene(s, PERMISO_DE[tipo.data])) throw forbidden(`No tenés permiso para registrar ${tipo.data === 'recepcion' ? 'recepciones' : 'entregas'}`);
  const o = await cargarOrden(c, s, c.req.param('id'));
  if (o.estado === 'cancelada') throw conflict('La orden de trabajo está cancelada');

  const existentes = await all<{ id: string; estado: string; revision: number }>(c.env.DB, 'SELECT id, estado, revision FROM ck_registros WHERE taller_id = ? AND orden_id = ? AND tipo = ? ORDER BY revision DESC', s.tallerId, o.id, tipo.data);
  const borrador = existentes.find((e) => e.estado === 'borrador');
  if (borrador) return devolver(c, s, borrador.id, 200);
  if (existentes.length) throw conflict(`Ya hay ${tipo.data === 'recepcion' ? 'una recepción confirmada' : 'una entrega confirmada'} en esta orden. Para modificarla usá «Corregir»: el original se conserva.`, 'ya_confirmada');

  const veh = await first<{ km_actual: number }>(c.env.DB, 'SELECT km_actual FROM vehiculos WHERE taller_id = ? AND id = ?', s.tallerId, o.vehiculo_id);
  const datos: ContenidoChecklist = {
    fecha_hora: ahora(),
    km: tipo.data === 'recepcion' ? (o.km_ingreso ?? (veh?.km_actual ? veh.km_actual : null)) : null,
    combustible: null,
    llaves: null,
    observaciones: '',
    items: {},
    danos: [],
    pertenencias: [],
    estado_general: '',
    trabajos: tipo.data === 'entrega' ? await sugerirTrabajos(c, s, o.id) : [],
  };
  const recepcion = tipo.data === 'entrega' ? await first<{ id: string }>(c.env.DB, "SELECT id FROM ck_registros WHERE taller_id = ? AND orden_id = ? AND tipo = 'recepcion' AND estado = 'confirmado' ORDER BY revision DESC LIMIT 1", s.tallerId, o.id) : null;
  const id = uid();
  try {
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `INSERT INTO ck_registros (id, taller_id, orden_id, vehiculo_id, cliente_id, tipo, revision, recepcion_id, estado, version, checklist_version, datos, fecha_hora, km, responsable_id, responsable_nombre, creado_por)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'borrador', 1, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, s.tallerId, o.id, o.vehiculo_id, o.cliente_id, tipo.data, recepcion?.id ?? null, CHECKLIST_VERSION, JSON.stringify(datos), datos.fecha_hora, datos.km, s.usuarioId, s.nombre, s.usuarioId),
      auditar(c.env.DB, s.tallerId, s.usuarioId, 'ck_registro', id, 'crear_borrador', { orden_id: o.id, tipo: tipo.data }),
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) {
      // Dos personas abrieron el borrador a la vez: se devuelve el que ganó.
      const g = await first<{ id: string }>(c.env.DB, "SELECT id FROM ck_registros WHERE taller_id = ? AND orden_id = ? AND tipo = ? AND estado = 'borrador'", s.tallerId, o.id, tipo.data);
      if (g) return devolver(c, s, g.id, 200);
    }
    throw e;
  }
  return devolver(c, s, id, 201);
});

const zGuardar = z.object({ version: z.number().int().min(1), datos: zContenido });
checklists.put('/checklists/:id', requirePerm('checklists.ver'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zGuardar);
  const r = await cargarRegistro(c, s, c.req.param('id'));
  exigirEscritura(s, r);
  if (r.estado !== 'borrador') throw conflict('El registro ya está confirmado y no se modifica: usá «Corregir» para crear una revisión.', 'confirmado');
  const datos = d.datos as ContenidoChecklist;
  validarContenido(r.tipo, datos);
  await validarFotos(c, s, r.orden_id, datos);
  const res = await c.env.DB
    .prepare("UPDATE ck_registros SET datos = ?, fecha_hora = ?, km = ?, combustible = ?, version = version + 1, updated_at = ? WHERE taller_id = ? AND id = ? AND estado = 'borrador' AND version = ?")
    .bind(JSON.stringify(datos), datos.fecha_hora, datos.km, datos.combustible, ahora(), s.tallerId, r.id, d.version)
    .run();
  if (!res.meta.changes) throw conflict('Otra persona modificó este borrador mientras lo editabas. Actualizá para ver sus cambios.', 'conflicto_version');
  return devolver(c, s, r.id);
});

checklists.delete('/checklists/:id', requirePerm('checklists.ver'), async (c) => {
  const s = c.get('sesion');
  const r = await cargarRegistro(c, s, c.req.param('id'));
  exigirEscritura(s, r);
  if (r.estado !== 'borrador') throw conflict('Un registro confirmado no se puede descartar', 'confirmado');
  await c.env.DB.batch([
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM ck_registros WHERE taller_id = ? AND id = ? AND estado = 'borrador')", s.tallerId, r.id),
    c.env.DB.prepare("DELETE FROM ck_registros WHERE taller_id = ? AND id = ? AND estado = 'borrador'").bind(s.tallerId, r.id),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'ck_registro', r.id, 'descartar_borrador', { orden_id: r.orden_id, tipo: r.tipo, revision: r.revision }),
  ]);
  return c.json({ ok: true });
});

// ───────────── Confirmar (congela el contenido) ─────────────
checklists.post('/checklists/:id/confirmar', requirePerm('checklists.ver'), async (c) => {
  const s = c.get('sesion');
  const { version } = await body(c, z.object({ version: z.number().int().min(1) }));
  const r = await cargarRegistro(c, s, c.req.param('id'));
  exigirEscritura(s, r);
  if (r.estado !== 'borrador') throw conflict('El registro ya está confirmado', 'confirmado');
  if (r.version !== version) throw conflict('Otra persona modificó este borrador. Actualizá antes de confirmar.', 'conflicto_version');
  const orden = await first<{ id: string; numero: number; estado: string }>(c.env.DB, 'SELECT id, numero, estado FROM ordenes WHERE taller_id = ? AND id = ?', s.tallerId, r.orden_id);
  if (!orden) throw notFound('Orden de trabajo');
  if (orden.estado === 'cancelada' && r.revision === 0) throw conflict('La orden de trabajo está cancelada');

  const datos = zContenido.parse(JSON.parse(r.datos)) as ContenidoChecklist;
  validarContenido(r.tipo, datos);
  await validarFotos(c, s, r.orden_id, datos);

  // Qué fotografías quedan incluidas: las de la etapa (recepción / entrega) de esta OT que ya están guardadas y las asociadas a los daños.
  const enDanos = new Map<string, string>();
  for (const dano of datos.danos) for (const f of dano.fotos) if (!enDanos.has(f)) enDanos.set(f, dano.id);
  const fotos = await all<{ id: string; sha256: string; etapa: string | null; created_at: string }>(
    c.env.DB,
    "SELECT id, sha256, etapa, created_at FROM fotos WHERE taller_id = ? AND orden_id = ? AND estado = 'lista' AND (etapa = ? OR id IN (SELECT value FROM json_each(?))) ORDER BY created_at, id LIMIT 500",
    s.tallerId,
    r.orden_id,
    ETAPA_DE[r.tipo],
    JSON.stringify([...enDanos.keys()]),
  );
  const [cli, veh] = await Promise.all([
    first<{ id: string; nombre: string }>(c.env.DB, 'SELECT id, nombre FROM clientes WHERE taller_id = ? AND id = ?', s.tallerId, r.cliente_id),
    first<{ id: string; patente: string; marca: string | null; modelo: string | null; anio: number | null }>(
      c.env.DB,
      `SELECT v.id, v.patente, ma.nombre AS marca, mo.nombre AS modelo, v.anio FROM vehiculos v
         LEFT JOIN marcas ma ON ma.taller_id = v.taller_id AND ma.id = v.marca_id LEFT JOIN modelos mo ON mo.taller_id = v.taller_id AND mo.id = v.modelo_id
        WHERE v.taller_id = ? AND v.id = ?`,
      s.tallerId,
      r.vehiculo_id,
    ),
  ]);
  if (!cli || !veh) throw notFound('Cliente o vehículo');
  const contexto: ContextoConfirmado = {
    tipo: r.tipo,
    revision: r.revision,
    checklist_version: r.checklist_version,
    orden: { id: orden.id, numero: orden.numero },
    cliente: { id: cli.id, nombre: cli.nombre },
    vehiculo: veh,
    responsable: { id: r.responsable_id, nombre: r.responsable_nombre },
    fotos: fotos.map((f) => ({ id: f.id, sha256: f.sha256, etapa: f.etapa, tomada_at: f.created_at })),
  };
  const hash = await sha256(new TextEncoder().encode(jsonCanonico({ datos, contexto })));
  const ahoraIso = ahora();
  const recepcion = r.tipo === 'entrega' ? await first<{ id: string }>(c.env.DB, "SELECT id FROM ck_registros WHERE taller_id = ? AND orden_id = ? AND tipo = 'recepcion' AND estado = 'confirmado' ORDER BY revision DESC LIMIT 1", s.tallerId, r.orden_id) : null;

  await c.env.DB.batch([
    guard(c.env.DB, "NOT EXISTS (SELECT 1 FROM ck_registros WHERE taller_id = ? AND id = ? AND estado = 'borrador' AND version = ?)", s.tallerId, r.id, version),
    c.env.DB
      .prepare(
        `UPDATE ck_registros SET estado = 'confirmado', contexto = ?, contenido_sha256 = ?, confirmado_at = ?, confirmado_por = ?, confirmado_por_nombre = ?, recepcion_id = ?, version = version + 1, updated_at = ?
          WHERE taller_id = ? AND id = ? AND estado = 'borrador' AND version = ?`,
      )
      .bind(JSON.stringify(contexto), hash, ahoraIso, s.usuarioId, s.nombre, recepcion?.id ?? null, ahoraIso, s.tallerId, r.id, version),
    ...fotos.map((f) =>
      c.env.DB
        .prepare("INSERT INTO ck_fotos (taller_id, registro_id, foto_id, dano_id) SELECT taller_id, ?, id, ? FROM fotos WHERE taller_id = ? AND id = ? AND estado = 'lista'")
        .bind(r.id, enDanos.get(f.id) ?? null, s.tallerId, f.id),
    ),
    // Si alguna fotografía desapareció mientras tanto, el hash ya no describiría lo que quedó vinculado: se deshace todo.
    guard(c.env.DB, '(SELECT COUNT(*) FROM ck_fotos WHERE taller_id = ? AND registro_id = ?) <> ?', s.tallerId, r.id, fotos.length),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'ck_registro', r.id, 'confirmar', { orden_id: r.orden_id, tipo: r.tipo, revision: r.revision, sha256: hash, fotos: fotos.length }),
  ]);
  return devolver(c, s, r.id);
});

// ───────────── Conformidad del cliente ─────────────
const MAX_PUNTOS_FIRMA = 6000;
const zFirma = z.object({
  ancho: z.number().int().min(100).max(2400),
  alto: z.number().int().min(50).max(1200),
  // Cada trazo es una lista de puntos [x, y] en píxeles del lienzo.
  trazos: z.array(z.array(z.tuple([z.number().int().min(0).max(2400), z.number().int().min(0).max(1200)])).min(1).max(2000)).min(1).max(60),
});
const zFirmar = z.discriminatedUnion('resultado', [
  z.object({ resultado: z.literal('firmada'), nombre_firmante: z.string().trim().min(2, 'Escribí el nombre de quien firma').max(120), firma: zFirma, aclaracion: z.string().trim().max(300).optional() }),
  z.object({ resultado: z.literal('no_presente'), aclaracion: z.string().trim().max(300).optional(), nombre_firmante: z.string().trim().max(120).optional() }),
  z.object({ resultado: z.literal('se_niega'), aclaracion: z.string().trim().max(300).optional(), nombre_firmante: z.string().trim().max(120).optional() }),
]);

checklists.post('/checklists/:id/firma', requirePerm('checklists.ver'), async (c) => {
  const s = c.get('sesion');
  const d = await body(c, zFirmar);
  const r = await cargarRegistro(c, s, c.req.param('id'));
  exigirEscritura(s, r);
  if (r.estado !== 'confirmado' || !r.contenido_sha256) throw conflict('Primero confirmá el registro: el cliente firma el contenido ya confirmado.', 'sin_confirmar');
  const mas = await first(c.env.DB, 'SELECT 1 FROM ck_registros WHERE taller_id = ? AND orden_id = ? AND tipo = ? AND revision > ? AND estado = ?', s.tallerId, r.orden_id, r.tipo, r.revision, 'confirmado');
  if (mas) throw conflict('Este registro fue reemplazado por una revisión posterior: la conformidad corresponde a la revisión vigente.', 'revision_vencida');
  if (await first(c.env.DB, "SELECT 1 FROM ck_firmas WHERE taller_id = ? AND registro_id = ? AND resultado = 'firmada'", s.tallerId, r.id)) throw conflict('Este registro ya está firmado', 'ya_firmada');

  let firma: string | null = null;
  let firmaHash: string | null = null;
  if (d.resultado === 'firmada') {
    const puntos = d.firma.trazos.reduce((n, t) => n + t.length, 0);
    if (puntos > MAX_PUNTOS_FIRMA) throw badRequest('La firma tiene demasiados puntos');
    const xs = d.firma.trazos.flat().map((p) => p[0]);
    const ys = d.firma.trazos.flat().map((p) => p[1]);
    if (puntos < 8 || Math.max(...xs) - Math.min(...xs) < 20 || Math.max(...ys) - Math.min(...ys) < 8) throw badRequest('La firma está vacía o es demasiado corta. Pedile al cliente que firme de nuevo.');
    if (Math.max(...xs) > d.firma.ancho || Math.max(...ys) > d.firma.alto) throw badRequest('La firma excede el lienzo');
    firma = JSON.stringify(d.firma);
    firmaHash = await sha256(new TextEncoder().encode(firma));
  }
  const aclaracion = d.aclaracion || (d.resultado === 'no_presente' ? 'El cliente no estaba presente' : d.resultado === 'se_niega' ? 'El cliente no desea firmar' : null);
  const id = uid();
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `INSERT INTO ck_firmas (id, taller_id, registro_id, resultado, nombre_firmante, aclaracion, firma, firma_sha256, contenido_sha256, checklist_version, texto_conformidad, texto_version, registrado_por, registrado_por_nombre)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, s.tallerId, r.id, d.resultado, d.nombre_firmante || null, aclaracion, firma, firmaHash, r.contenido_sha256, r.checklist_version, textoConformidad(r.tipo), TEXTO_CONFORMIDAD_VERSION, s.usuarioId, s.nombre),
    auditar(c.env.DB, s.tallerId, s.usuarioId, 'ck_registro', r.id, 'conformidad', { resultado: d.resultado, sha256: r.contenido_sha256, firma_sha256: firmaHash }),
  ]);
  return devolver(c, s, r.id, 201);
});

// ───────────── Corrección = revisión nueva ─────────────
checklists.post('/ordenes/:id/checklists/:tipo/corregir', requirePerm('checklists.corregir'), async (c) => {
  const s = c.get('sesion');
  const tipo = zTipo.safeParse(c.req.param('tipo'));
  if (!tipo.success) throw notFound('Tipo de registro');
  const { motivo } = await body(c, z.object({ motivo: z.string().trim().min(5, 'Contá brevemente qué se corrige y por qué').max(500) }));
  const o = await cargarOrden(c, s, c.req.param('id'));
  const filas = await all<Fila>(c.env.DB, `SELECT ${COLS} FROM ck_registros WHERE taller_id = ? AND orden_id = ? AND tipo = ? ORDER BY revision DESC`, s.tallerId, o.id, tipo.data);
  const abierto = filas.find((f) => f.estado === 'borrador');
  if (abierto) throw conflict('Ya hay una corrección en curso para este registro', 'borrador_abierto');
  const vigente = filas.find((f) => f.estado === 'confirmado');
  if (!vigente) throw conflict('Todavía no hay un registro confirmado para corregir', 'sin_confirmar');
  const id = uid();
  const ahoraIso = ahora();
  try {
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `INSERT INTO ck_registros (id, taller_id, orden_id, vehiculo_id, cliente_id, tipo, revision, previo_id, motivo, recepcion_id, estado, version, checklist_version, datos, fecha_hora, km, combustible, responsable_id, responsable_nombre, creado_por, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'borrador', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, s.tallerId, o.id, vigente.vehiculo_id, vigente.cliente_id, tipo.data, vigente.revision + 1, vigente.id, motivo, vigente.recepcion_id, vigente.checklist_version, vigente.datos, vigente.fecha_hora, JSON.parse(vigente.datos).km ?? null, JSON.parse(vigente.datos).combustible ?? null, s.usuarioId, s.nombre, s.usuarioId, ahoraIso, ahoraIso),
      auditar(c.env.DB, s.tallerId, s.usuarioId, 'ck_registro', id, 'crear_revision', { orden_id: o.id, tipo: tipo.data, revision: vigente.revision + 1, previo_id: vigente.id, motivo }),
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) throw conflict('Ya hay una corrección en curso para este registro', 'borrador_abierto');
    throw e;
  }
  return devolver(c, s, id, 201);
});

// ───────────── Verificación de integridad ─────────────
/** Recalcula el hash del contenido confirmado y comprueba que las firmas y las fotografías sigan correspondiendo a él. Sólo lectura. */
checklists.get('/checklists/:id/verificar', requirePerm('checklists.ver'), async (c) => {
  const s = c.get('sesion');
  const r = await cargarRegistro(c, s, c.req.param('id'));
  if (r.estado !== 'confirmado' || !r.contexto) throw conflict('Sólo se verifican registros confirmados', 'sin_confirmar');
  const calculado = await sha256(new TextEncoder().encode(jsonCanonico({ datos: JSON.parse(r.datos), contexto: JSON.parse(r.contexto) })));
  const contexto = JSON.parse(r.contexto) as ContextoConfirmado;
  const fotos = await all<{ id: string; sha256: string; estado: string }>(c.env.DB, 'SELECT f.id, f.sha256, f.estado FROM ck_fotos k JOIN fotos f ON f.taller_id = k.taller_id AND f.id = k.foto_id WHERE k.taller_id = ? AND k.registro_id = ?', s.tallerId, r.id);
  const porId = new Map(fotos.map((f) => [f.id, f]));
  const firmas = await firmasDe(c, s.tallerId, [r.id]);
  return c.json({
    integro: calculado === r.contenido_sha256,
    sha256_guardado: r.contenido_sha256,
    sha256_calculado: calculado,
    fotos: { cantidad: contexto.fotos.length, correctas: contexto.fotos.filter((f) => porId.get(f.id)?.sha256 === f.sha256 && porId.get(f.id)?.estado === 'lista').length },
    firmas: (firmas.get(r.id) ?? []).map((f) => ({ id: f.id, resultado: f.resultado, corresponde_al_contenido: f.contenido_sha256 === r.contenido_sha256 })),
  });
});
