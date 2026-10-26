// Mejora 20B: seguimiento activado automáticamente al crear la orden (por cualquier ruta), sin duplicados y respetando lo desactivado, y fotografía
// del vehículo en el PDF de la orden (miniatura JPEG tomada de R2 en el servidor, con los permisos de siempre).
import { beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { Api, consultaLocal, nuevoPersonal, nuevoTaller, sqlLocal } from './cliente';
import { PUERTO } from './global-setup';

const BASE = `http://127.0.0.1:${PUERTO}`;
let ipN = 0;
const ipNueva = () => `10.249.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`;
const tokenDe = (url: string) => url.split('/seguimiento/')[1];
const paginaPublica = async (url: string) => (await fetch(`${BASE}/seguimiento/${tokenDe(url)}`, { headers: { 'cf-connecting-ip': ipNueva() } })).status;
const filasEnlace = (ordenId: string) => consultaLocal<{ token: string; activo: number }>(`SELECT token, activo FROM seguimiento_enlaces WHERE orden_id = '${ordenId}'`);

/** JPEG sintético con estructura válida (el servidor no decodifica píxeles: valida el contenedor). `comp` = componentes del SOF. */
function jpeg(ancho: number, alto: number, relleno = 300): Uint8Array {
  const seg = (m: number, datos: number[]) => [0xff, m, (datos.length + 2) >> 8, (datos.length + 2) & 0xff, ...datos];
  return Uint8Array.from([
    0xff, 0xd8,
    ...seg(0xe0, [...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...seg(0xc0, [8, alto >> 8, alto & 0xff, ancho >> 8, ancho & 0xff, 1, 1, 0x11, 0]),
    ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]),
    ...Array.from({ length: relleno }, (_, i) => (i * 7) & 0x7f),
    0xff, 0xd9,
  ]);
}
function webp(): Uint8Array {
  const le = (n: number, k = 4) => Array.from({ length: k }, (_, i) => (n >> (8 * i)) & 0xff);
  const chunk = (tipo: string, d: number[]) => [...Buffer.from(tipo), ...le(d.length), ...d, ...(d.length & 1 ? [0] : [])];
  const vp8 = chunk('VP8 ', [0x10, 0, 0, 0x9d, 0x01, 0x2a, ...le(200, 2), ...le(150, 2), 1, 2, 3, 4]);
  const cuerpo = [...Buffer.from('WEBP'), ...vp8];
  return Uint8Array.from([...Buffer.from('RIFF'), ...le(cuerpo.length), ...cuerpo]);
}

async function subir(api: Api, campos: Record<string, string>, foto: Uint8Array, mini: Uint8Array, tipoMini = 'image/jpeg') {
  const f = new FormData();
  for (const [k, v] of Object.entries({ idem_key: crypto.randomUUID(), ...campos })) f.set(k, v);
  f.set('foto', new Blob([foto], { type: 'image/jpeg' }), 'foto.jpg');
  f.set('miniatura', new Blob([mini], { type: tipoMini }), 'mini');
  const r = await fetch(`${BASE}/api/fotos`, { method: 'POST', headers: { cookie: api.cookie, 'cf-connecting-ip': api.ip, 'x-fierro-subida': '1' }, body: f });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function pedirPdf(api: Api, id: string, copia?: string) {
  const r = await fetch(`${BASE}/api/ordenes/${id}/pdf${copia ? `?copia=${copia}` : ''}`, { headers: { cookie: api.cookie, 'cf-connecting-ip': api.ip } });
  const bytes = new Uint8Array(await r.arrayBuffer());
  return { status: r.status, texto: Buffer.from(bytes).toString('latin1') };
}
const imagenes = (texto: string) => (texto.match(/\/Subtype \/Image/g) ?? []).length;
/** Texto visible (lo que está entre paréntesis de cada Tj) y posición del recuadro de anotaciones. */
const visible = (texto: string) =>
  [...texto.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)]
    .map((m) => m[1].replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))).replace(/\\([()\\])/g, '$1'))
    .join('\n');

const T: any = {};
beforeAll(async () => {
  T.a = await nuevoTaller('Taller 20B A', 4);
  T.b = await nuevoTaller('Taller 20B B');
  T.mec = await nuevoPersonal(T.a.api, 'mecanico');
  const cli = (await T.a.api.post('/api/clientes', { nombre: 'Cliente Veinte', telefono: '341 555-0000' })).body;
  T.cli = cli;
  T.veh = (await T.a.api.post('/api/vehiculos', { cliente_id: cli.id, patente: 'VEI001', anio: 2019 })).body;
  T.vehSin = (await T.a.api.post('/api/vehiculos', { cliente_id: cli.id, patente: 'VEI002' })).body;
  const mecs = (await T.a.api.get('/api/mecanicos')).body;
  T.mecId = mecs.find((m: any) => m.usuario_id === T.mec.id).id;
  const cliB = (await T.b.api.post('/api/clientes', { nombre: 'Cliente B20' })).body;
  T.vehB = (await T.b.api.post('/api/vehiculos', { cliente_id: cliB.id, patente: 'VEI999' })).body;
});

describe('seguimiento automático al crear la orden', () => {
  it('la orden nace con su enlace activo, listo para compartir, y la página abre sin sesión', async () => {
    const ot = (await T.a.api.post('/api/ordenes', { cliente_id: T.cli.id, vehiculo_id: T.veh.id, mecanico_id: T.mecId, falla_reportada: 'Ruido', items: [] })).body;
    T.ot = ot;
    const s = await T.a.api.get(`/api/ordenes/${ot.id}/seguimiento`);
    expect(s.body).toMatchObject({ existe: true, activo: true, generacion: 1 });
    expect(s.body.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${PUERTO}/seguimiento/[A-Za-z0-9_-]{43}$`));
    expect(await paginaPublica(s.body.url)).toBe(200);
    T.url = s.body.url;
  });

  it('un solo enlace por orden: activar a mano no crea otro ni cambia el token; hay una única fila', async () => {
    const otra = await T.a.api.post(`/api/ordenes/${T.ot.id}/seguimiento/activar`);
    expect(otra.body.url).toBe(T.url);
    const filas = await filasEnlace(T.ot.id);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ token: tokenDe(T.url), activo: 1 });
  });

  it('la creación de la orden queda auditada con el seguimiento activado en forma automática', async () => {
    const a = await consultaLocal<{ detalle: string }>(`SELECT detalle FROM auditoria WHERE accion = 'seguimiento_activado' AND entidad_id = '${T.ot.id}' AND detalle LIKE '%automatico%'`);
    expect(a).toHaveLength(1);
    expect(JSON.parse(a[0].detalle)).toEqual({ automatico: true });
  });

  it('un enlace desactivado a mano no se reactiva al editar la orden ni al cambiar su estado', async () => {
    await T.a.api.post(`/api/ordenes/${T.ot.id}/seguimiento/desactivar`);
    expect(await paginaPublica(T.url)).toBe(404);
    const o = (await T.a.api.get(`/api/ordenes/${T.ot.id}`)).body;
    const put = await T.a.api.put(`/api/ordenes/${T.ot.id}`, { cliente_id: T.cli.id, vehiculo_id: T.veh.id, mecanico_id: T.mecId, falla_reportada: 'Ruido editado', version: o.version, items: [] });
    expect(put.status).toBe(200);
    expect((await T.a.api.post(`/api/ordenes/${T.ot.id}/estado`, { estado: 'diagnostico' })).status).toBe(200);
    const s = await T.a.api.get(`/api/ordenes/${T.ot.id}/seguimiento`);
    expect(s.body).toMatchObject({ existe: true, activo: false, url: null });
    expect(await paginaPublica(T.url)).toBe(404);
    expect(await filasEnlace(T.ot.id)).toHaveLength(1);
    // reactivar conserva el mismo enlace; regenerar lo reemplaza
    expect((await T.a.api.post(`/api/ordenes/${T.ot.id}/seguimiento/activar`)).body.url).toBe(T.url);
    const nuevo = (await T.a.api.post(`/api/ordenes/${T.ot.id}/seguimiento/regenerar`)).body;
    expect(nuevo.url).not.toBe(T.url);
    expect(await paginaPublica(T.url)).toBe(404);
    expect(await paginaPublica(nuevo.url)).toBe(200);
  });

  it('la orden generada desde un presupuesto también nace con su enlace', async () => {
    const p = (await T.a.api.post('/api/presupuestos', { cliente_id: T.cli.id, vehiculo_id: T.veh.id, items: [{ tipo: 'libre', descripcion: 'x', cantidad: 1, precio_unitario: 100 }] })).body;
    const ot = (await T.a.api.post(`/api/presupuestos/${p.id}/convertir`, {})).body;
    const s = await T.a.api.get(`/api/ordenes/${ot.id}/seguimiento`);
    expect(s.body).toMatchObject({ existe: true, activo: true });
    expect(await paginaPublica(s.body.url)).toBe(200);
    expect(await filasEnlace(ot.id)).toHaveLength(1);
  });

  it('una orden anterior a esta mejora (sin enlace) conserva ese estado: editarla o cambiarle el estado no le crea uno', async () => {
    const ot = (await T.a.api.post('/api/ordenes', { cliente_id: T.cli.id, vehiculo_id: T.veh.id, falla_reportada: 'Vieja', items: [] })).body;
    await sqlLocal(`DELETE FROM seguimiento_enlaces WHERE orden_id = '${ot.id}'`); // como estaban las órdenes de antes
    const o = (await T.a.api.get(`/api/ordenes/${ot.id}`)).body;
    expect((await T.a.api.put(`/api/ordenes/${ot.id}`, { cliente_id: T.cli.id, vehiculo_id: T.veh.id, falla_reportada: 'Vieja editada', version: o.version, items: [] })).status).toBe(200);
    expect((await T.a.api.post(`/api/ordenes/${ot.id}/estado`, { estado: 'diagnostico' })).status).toBe(200);
    expect((await T.a.api.get(`/api/ordenes/${ot.id}/seguimiento`)).body).toMatchObject({ existe: false, activo: false, url: null });
    expect(await filasEnlace(ot.id)).toHaveLength(0);
  });
});

describe('fotografía del vehículo en el PDF', () => {
  it('sin fotos el documento sale igual, sin imagen, con sus 14 renglones de anotaciones', async () => {
    const ot = (await T.a.api.post('/api/ordenes', { cliente_id: T.cli.id, vehiculo_id: T.vehSin.id, falla_reportada: 'Sin fotos', items: [] })).body;
    for (const copia of ['mecanico', 'administracion', 'ambas']) {
      const r = await pedirPdf(T.a.api, ot.id, copia);
      expect(r.status).toBe(200);
      expect(imagenes(r.texto)).toBe(0);
      expect((r.texto.match(/\/Type \/Page /g) ?? []).length).toBe(copia === 'ambas' ? 2 : 1);
    }
  });

  it('con una foto de la galería del vehículo, ambas copias la llevan (una sola imagen compartida) y la hoja sigue siendo de una página', async () => {
    const s = await subir(T.a.api, { vehiculo_id: T.veh.id }, jpeg(1200, 800, 4000), jpeg(320, 240));
    expect(s.status).toBe(201);
    T.fotoGaleria = s.body.id;
    const ot = (await T.a.api.post('/api/ordenes', { cliente_id: T.cli.id, vehiculo_id: T.veh.id, falla_reportada: 'Con foto', items: [] })).body;
    T.otFoto = ot;
    for (const copia of ['mecanico', 'administracion']) {
      const r = await pedirPdf(T.a.api, ot.id, copia);
      expect(imagenes(r.texto)).toBe(1);
      expect(r.texto).toContain('/Width 320');
      expect(r.texto).toContain('/Height 240');
      expect((r.texto.match(/\/Type \/Page /g) ?? []).length).toBe(1);
      expect(visible(r.texto)).toContain('ANOTACIONES DEL MECÁNICO');
    }
    const ambas = await pedirPdf(T.a.api, ot.id, 'ambas');
    expect(imagenes(ambas.texto)).toBe(1);
    expect((ambas.texto.match(/\/Type \/Page /g) ?? []).length).toBe(2);
  });

  it('la foto es la del vehículo de la orden: otro vehículo del mismo taller no la lleva', async () => {
    const ot = (await T.a.api.post('/api/ordenes', { cliente_id: T.cli.id, vehiculo_id: T.vehSin.id, falla_reportada: 'Otro auto', items: [] })).body;
    expect(imagenes((await pedirPdf(T.a.api, ot.id)).texto)).toBe(0);
  });

  it('sin foto de galería se usa la de recepción de la propia orden; con ambas, gana la del vehículo', async () => {
    const veh = (await T.a.api.post('/api/vehiculos', { cliente_id: T.cli.id, patente: 'VEI003' })).body;
    const ot = (await T.a.api.post('/api/ordenes', { cliente_id: T.cli.id, vehiculo_id: veh.id, falla_reportada: 'Recepción', items: [] })).body;
    expect((await subir(T.a.api, { vehiculo_id: veh.id, orden_id: ot.id, etapa: 'reparacion' }, jpeg(900, 600), jpeg(100, 100))).status).toBe(201);
    expect((await subir(T.a.api, { vehiculo_id: veh.id, orden_id: ot.id, etapa: 'recepcion' }, jpeg(900, 600), jpeg(210, 140))).status).toBe(201);
    let r = await pedirPdf(T.a.api, ot.id);
    expect(r.texto).toContain('/Width 210'); // recepción antes que reparación
    expect(r.texto).not.toContain('/Width 100 ');
    expect((await subir(T.a.api, { vehiculo_id: veh.id }, jpeg(900, 600), jpeg(260, 130))).status).toBe(201);
    r = await pedirPdf(T.a.api, ot.id);
    expect(imagenes(r.texto)).toBe(1);
    expect(r.texto).toContain('/Width 260');
  });

  it('las fotos de OTRA orden del mismo vehículo no se usan', async () => {
    const veh = (await T.a.api.post('/api/vehiculos', { cliente_id: T.cli.id, patente: 'VEI004' })).body;
    const vieja = (await T.a.api.post('/api/ordenes', { cliente_id: T.cli.id, vehiculo_id: veh.id, falla_reportada: 'Vieja', items: [] })).body;
    expect((await subir(T.a.api, { vehiculo_id: veh.id, orden_id: vieja.id, etapa: 'recepcion' }, jpeg(900, 600), jpeg(200, 100))).status).toBe(201);
    const nueva = (await T.a.api.post('/api/ordenes', { cliente_id: T.cli.id, vehiculo_id: veh.id, falla_reportada: 'Nueva', items: [] })).body;
    expect(imagenes((await pedirPdf(T.a.api, nueva.id)).texto)).toBe(0);
  });

  it('una miniatura que no se puede incrustar (WebP) no impide generar la orden: se omite la foto', async () => {
    const veh = (await T.a.api.post('/api/vehiculos', { cliente_id: T.cli.id, patente: 'VEI005' })).body;
    expect((await subir(T.a.api, { vehiculo_id: veh.id }, jpeg(900, 600), webp(), 'image/webp')).status).toBe(201);
    const ot = (await T.a.api.post('/api/ordenes', { cliente_id: T.cli.id, vehiculo_id: veh.id, falla_reportada: 'WebP', items: [] })).body;
    const r = await pedirPdf(T.a.api, ot.id);
    expect(r.status).toBe(200);
    expect(imagenes(r.texto)).toBe(0);
    // con una segunda foto utilizable, se salta la WebP y se usa esa
    expect((await subir(T.a.api, { vehiculo_id: veh.id }, jpeg(900, 600), jpeg(240, 180))).status).toBe(201);
    expect(imagenes((await pedirPdf(T.a.api, ot.id)).texto)).toBe(1);
  });

  it('una foto eliminada deja de aparecer', async () => {
    const veh = (await T.a.api.post('/api/vehiculos', { cliente_id: T.cli.id, patente: 'VEI006' })).body;
    const f = await subir(T.a.api, { vehiculo_id: veh.id }, jpeg(900, 600), jpeg(200, 150));
    const ot = (await T.a.api.post('/api/ordenes', { cliente_id: T.cli.id, vehiculo_id: veh.id, falla_reportada: 'Borrada', items: [] })).body;
    expect(imagenes((await pedirPdf(T.a.api, ot.id)).texto)).toBe(1);
    expect((await T.a.api.del(`/api/fotos/${f.body.id}`)).status).toBe(200);
    expect(imagenes((await pedirPdf(T.a.api, ot.id)).texto)).toBe(0);
  });

  it('permisos: sin «ver fotografías» la hoja sale sin foto; el mecánico asignado con ese permiso la ve', async () => {
    const ot = (await T.a.api.post('/api/ordenes', { cliente_id: T.cli.id, vehiculo_id: T.veh.id, mecanico_id: T.mecId, falla_reportada: 'Permisos', items: [] })).body;
    expect(imagenes((await pedirPdf(T.mec.api, ot.id)).texto)).toBe(1);
    const m = (await T.a.api.get(`/api/taller/usuarios/${T.mec.id}`)).body;
    await T.a.api.put(`/api/taller/usuarios/${T.mec.id}/permisos`, { permisos: m.permisos.filter((p: string) => p !== 'fotos.ver' && p !== 'fotos.subir') });
    const sin = await pedirPdf(T.mec.api, ot.id);
    expect(sin.status).toBe(200);
    expect(imagenes(sin.texto)).toBe(0);
    await T.a.api.put(`/api/taller/usuarios/${T.mec.id}/permisos`, { permisos: m.permisos });
    expect(imagenes((await pedirPdf(T.mec.api, ot.id)).texto)).toBe(1);
  });

  it('aislamiento: el otro taller no obtiene fotos ajenas y la hoja de su propia orden no lleva ninguna', async () => {
    const otB = (await T.b.api.post('/api/ordenes', { cliente_id: (await T.b.api.get('/api/clientes')).body[0].id, vehiculo_id: T.vehB.id, falla_reportada: 'B', items: [] })).body;
    expect(imagenes((await pedirPdf(T.b.api, otB.id)).texto)).toBe(0);
    expect((await pedirPdf(T.b.api, T.otFoto.id)).status).toBe(404);
  });

  it('la hoja del cliente con el QR no cambia: no lleva la foto del vehículo', async () => {
    const r = await pedirPdf(T.a.api, T.otFoto.id, 'cliente');
    expect(r.status).toBe(200);
    expect(imagenes(r.texto)).toBe(0);
  });
});
