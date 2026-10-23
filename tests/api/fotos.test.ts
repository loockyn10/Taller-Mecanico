// Fotografías (R2 simulado en disco por el Worker local): subida con reintento, limpieza de metadatos, permisos, aislamiento entre talleres,
// cupo por taller, eliminación sin objetos huérfanos y exportación/auditoría de plataforma.
import { beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { Api, nuevoPersonal, nuevoTaller, platformHeaders, plataforma } from './cliente';
import { PUERTO } from './global-setup';

const BASE = `http://127.0.0.1:${PUERTO}`;

// JPEG sintético con estructura válida (APP1 con un "GPS" falso, SOF0, SOS, datos, EOI). El servidor no decodifica los píxeles: valida y reescribe el contenedor.
function jpeg(ancho = 800, alto = 600, relleno = 2000, gps = true): Uint8Array {
  const seg = (m: number, datos: number[]) => [0xff, m, (datos.length + 2) >> 8, (datos.length + 2) & 0xff, ...datos];
  const exif = [...Buffer.from('Exif\0\0GPSLATITUDE-34.6037 LONGITUDE-58.3816')];
  return Uint8Array.from([
    0xff, 0xd8,
    ...seg(0xe0, [...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...(gps ? seg(0xe1, exif) : []),
    ...seg(0xc0, [8, alto >> 8, alto & 0xff, ancho >> 8, ancho & 0xff, 1, 1, 0x11, 0]),
    ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]),
    ...Array.from({ length: relleno }, (_, i) => (i * 7) & 0x7f),
    0xff, 0xd9,
  ]);
}
const conTexto = (b: Uint8Array, t: string) => Buffer.from(b).includes(Buffer.from(t));

function webp(conExif: boolean): Uint8Array {
  const le = (n: number, k = 4) => Array.from({ length: k }, (_, i) => (n >> (8 * i)) & 0xff);
  const chunk = (tipo: string, d: number[]) => [...Buffer.from(tipo), ...le(d.length), ...d, ...(d.length & 1 ? [0] : [])];
  const vp8x = chunk('VP8X', [conExif ? 0x08 : 0, 0, 0, 0, ...le(799, 3), ...le(599, 3)]);
  const exif = conExif ? chunk('EXIF', [...Buffer.from('Exif\0\0GPSLATITUDE')]) : [];
  const vp8 = chunk('VP8 ', [0x10, 0, 0, 0x9d, 0x01, 0x2a, ...le(800, 2), ...le(600, 2), 1, 2, 3, 4]);
  const cuerpo = [...Buffer.from('WEBP'), ...vp8x, ...exif, ...vp8];
  return Uint8Array.from([...Buffer.from('RIFF'), ...le(cuerpo.length), ...cuerpo]);
}

interface Campos { vehiculo_id: string; orden_id?: string; etapa?: string; descripcion?: string; idem_key?: string }
async function subir(api: Api, campos: Campos, foto: Uint8Array = jpeg(), mini: Uint8Array = jpeg(200, 150, 100, false), headers: Record<string, string> = { 'x-fierro-subida': '1' }) {
  const f = new FormData();
  for (const [k, v] of Object.entries({ idem_key: crypto.randomUUID(), ...campos })) if (v !== undefined) f.set(k, v);
  f.set('foto', new Blob([foto], { type: 'image/jpeg' }), 'foto.jpg');
  f.set('miniatura', new Blob([mini], { type: 'image/jpeg' }), 'mini.jpg');
  const r = await fetch(`${BASE}/api/fotos`, { method: 'POST', headers: { cookie: api.cookie, 'cf-connecting-ip': api.ip, ...headers }, body: f });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null, idem: f.get('idem_key') as string };
}
const bajar = (api: Api, ruta: string, extra: Record<string, string> = {}) => fetch(`${BASE}${ruta}`, { headers: { cookie: api.cookie, 'cf-connecting-ip': api.ip, ...extra } });

const T: any = {};
beforeAll(async () => {
  T.a = await nuevoTaller('Taller fotos A', 6);
  T.b = await nuevoTaller('Taller fotos B');
  T.mec = await nuevoPersonal(T.a.api, 'mecanico');
  T.mec2 = await nuevoPersonal(T.a.api, 'mecanico');
  T.rec = await nuevoPersonal(T.a.api, 'recepcion');
  T.dep = await nuevoPersonal(T.a.api, 'deposito');
  const cli = (await T.a.api.post('/api/clientes', { nombre: 'Cliente Fotos' })).body;
  T.veh = (await T.a.api.post('/api/vehiculos', { cliente_id: cli.id, patente: 'FOT111', anio: 2020 })).body;
  const mecs = (await T.a.api.get('/api/mecanicos')).body;
  T.mecId = mecs.find((m: any) => m.usuario_id === T.mec.id).id;
  T.ot = (await T.a.api.post('/api/ordenes', { cliente_id: cli.id, vehiculo_id: T.veh.id, mecanico_id: T.mecId, falla_reportada: 'Ruido', items: [] })).body;
  T.ot2 = (await T.a.api.post('/api/ordenes', { cliente_id: cli.id, vehiculo_id: T.veh.id, falla_reportada: 'Otra', items: [] })).body;
  const cliB = (await T.b.api.post('/api/clientes', { nombre: 'Cliente B' })).body;
  T.vehB = (await T.b.api.post('/api/vehiculos', { cliente_id: cliB.id, patente: 'FOT999' })).body;
});

describe('fotografías', () => {
  it('el almacenamiento está habilitado y el taller arranca con 2 GB de límite', async () => {
    const e = (await T.a.api.get('/api/fotos/estado')).body;
    expect(e).toMatchObject({ habilitado: true, usado_bytes: 0, cantidad: 0, limite_bytes: 2 * 1024 ** 3 });
  });

  it('sube una foto del vehículo, quita el EXIF/GPS, la sirve con sesión y no la duplica al reintentar', async () => {
    const orig = jpeg();
    expect(conTexto(orig, 'GPSLATITUDE')).toBe(true);
    const r = await subir(T.a.api, { vehiculo_id: T.veh.id, descripcion: 'Paragolpes delantero' }, orig);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ vehiculo_id: T.veh.id, orden_id: null, etapa: null, descripcion: 'Paragolpes delantero', ancho: 800, alto: 600 });
    T.f1 = r.body;
    const arch = await bajar(T.a.api, `/api/fotos/${T.f1.id}/archivo`);
    expect(arch.status).toBe(200);
    expect(arch.headers.get('content-type')).toBe('image/jpeg');
    expect(arch.headers.get('cache-control')).toContain('private');
    const bytes = Buffer.from(await arch.arrayBuffer());
    expect(bytes.includes(Buffer.from('GPSLATITUDE'))).toBe(false); // el EXIF se descartó en el servidor
    expect(bytes.length).toBeLessThan(orig.length);
    // Condicional: 304 sin volver a bajar el archivo
    const etag = arch.headers.get('etag')!;
    expect((await bajar(T.a.api, `/api/fotos/${T.f1.id}/archivo`, { 'if-none-match': etag })).status).toBe(304);
    expect((await bajar(T.a.api, `/api/fotos/${T.f1.id}/miniatura`)).status).toBe(200);
    // Reintento con la misma clave: devuelve la misma foto, no crea otra
    const again = await subir(T.a.api, { vehiculo_id: T.veh.id, idem_key: r.idem });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(T.f1.id);
    expect((await T.a.api.get(`/api/vehiculos/${T.veh.id}/fotos`)).body).toHaveLength(1);
    const uso = (await T.a.api.get('/api/fotos/estado')).body;
    expect(uso.cantidad).toBe(1);
    expect(uso.usado_bytes).toBeGreaterThan(0);
  });

  it('valida el contenido real: rechaza lo que no es JPEG/WebP, lo cortado y lo gigante, y acepta WebP limpiándolo', async () => {
    const api = T.a.api;
    const texto = Uint8Array.from(Buffer.from('<html><script>alert(1)</script></html>'));
    expect((await subir(api, { vehiculo_id: T.veh.id }, texto)).status).toBe(400);
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect((await subir(api, { vehiculo_id: T.veh.id }, png)).status).toBe(400);
    expect((await subir(api, { vehiculo_id: T.veh.id }, jpeg().slice(0, 100))).status).toBe(400);
    expect((await subir(api, { vehiculo_id: T.veh.id }, jpeg(800, 600, 3_600_000))).status).toBe(413);
    expect((await subir(api, { vehiculo_id: T.veh.id }, jpeg(9000, 9000))).status).toBe(400);
    expect((await subir(api, { vehiculo_id: T.veh.id }, jpeg(), texto)).status).toBe(400);
    const w = await subir(api, { vehiculo_id: T.veh.id }, webp(true));
    expect(w.status).toBe(201);
    const b = Buffer.from(await (await bajar(api, `/api/fotos/${w.body.id}/archivo`)).arrayBuffer());
    expect(b.includes(Buffer.from('EXIF'))).toBe(false);
    expect(b.readUInt32LE(4) + 8).toBe(b.length);
    await api.del(`/api/fotos/${w.body.id}`);
  });

  it('exige el encabezado de subida y la sesión', async () => {
    expect((await subir(T.a.api, { vehiculo_id: T.veh.id }, jpeg(), jpeg(200, 150, 50, false), {})).status).toBe(415);
    const anon = new Api();
    expect((await subir(anon, { vehiculo_id: T.veh.id })).status).toBe(401);
    expect((await bajar(anon, `/api/fotos/${T.f1.id}/archivo`)).status).toBe(401);
  });

  it('las fotos de una OT llevan etapa, se ven también en el vehículo y no se duplican', async () => {
    const api = T.a.api;
    expect((await subir(api, { vehiculo_id: T.veh.id, orden_id: T.ot.id })).status).toBe(400); // falta la etapa
    expect((await subir(api, { vehiculo_id: T.veh.id, etapa: 'recepcion' })).status).toBe(400); // etapa sin OT
    const rec = await subir(api, { vehiculo_id: T.veh.id, orden_id: T.ot.id, etapa: 'recepcion', descripcion: 'Golpe lateral' });
    const rep = await subir(api, { vehiculo_id: T.veh.id, orden_id: T.ot.id, etapa: 'reparacion' });
    const ent = await subir(api, { vehiculo_id: T.veh.id, orden_id: T.ot.id, etapa: 'entrega' });
    expect([rec.status, rep.status, ent.status]).toEqual([201, 201, 201]);
    expect(rec.body).toMatchObject({ orden_id: T.ot.id, orden_numero: T.ot.numero, etapa: 'recepcion' });
    const deOt = (await api.get(`/api/ordenes/${T.ot.id}/fotos`)).body;
    expect(deOt.map((f: any) => f.etapa).sort()).toEqual(['entrega', 'recepcion', 'reparacion']);
    const deVeh = (await api.get(`/api/vehiculos/${T.veh.id}/fotos`)).body;
    expect(deVeh.map((f: any) => f.id)).toEqual(expect.arrayContaining([T.f1.id, rec.body.id, rep.body.id, ent.body.id]));
    expect(deVeh).toHaveLength(4); // el mismo archivo aparece una sola vez
    T.fotoOt = rec.body;
    // Una orden de otro vehículo no sirve
    const cli2 = (await api.post('/api/clientes', { nombre: 'Otro' })).body;
    const v2 = (await api.post('/api/vehiculos', { cliente_id: cli2.id, patente: 'FOT222' })).body;
    expect((await subir(api, { vehiculo_id: v2.id, orden_id: T.ot.id, etapa: 'recepcion' })).status).toBe(400);
  });

  it('un taller no ve ni alcanza las fotos de otro, ni con ids alterados', async () => {
    const b = T.b.api;
    expect((await bajar(b, `/api/fotos/${T.f1.id}/archivo`)).status).toBe(404);
    expect((await bajar(b, `/api/fotos/${T.f1.id}/miniatura`)).status).toBe(404);
    expect((await b.get(`/api/vehiculos/${T.veh.id}/fotos`)).status).toBe(404);
    expect((await b.get(`/api/ordenes/${T.ot.id}/fotos`)).status).toBe(404);
    expect((await b.del(`/api/fotos/${T.f1.id}`)).status).toBe(404);
    expect((await subir(b, { vehiculo_id: T.veh.id })).status).toBe(404);
    expect((await subir(b, { vehiculo_id: T.vehB.id, orden_id: T.ot.id, etapa: 'entrega' })).status).toBe(404);
    expect((await bajar(b, `/api/fotos/..%2F..%2Ffotos%2F${T.a.tallerId}%2F${T.f1.id}/archivo`)).status).toBe(404);
    // y lo propio sigue funcionando
    const propia = await subir(b, { vehiculo_id: T.vehB.id });
    expect(propia.status).toBe(201);
    expect((await bajar(T.a.api, `/api/fotos/${propia.body.id}/archivo`)).status).toBe(404);
  });

  it('permisos: el mecánico sólo trabaja las fotos de sus órdenes; sin permiso de fotos no ve nada; eliminar es aparte', async () => {
    const mec = T.mec.api;
    // Su orden: puede ver y subir (recepción, reparación o entrega)
    expect((await mec.get(`/api/ordenes/${T.ot.id}/fotos`)).body).toHaveLength(3);
    const suya = await subir(mec, { vehiculo_id: T.veh.id, orden_id: T.ot.id, etapa: 'reparacion', descripcion: 'Desde mis trabajos' });
    expect(suya.status).toBe(201);
    expect(suya.body.usuario).toContain('mecanico');
    expect((await bajar(mec, `/api/fotos/${T.fotoOt.id}/archivo`)).status).toBe(200);
    // Otra orden del mismo vehículo, no asignada a él
    expect((await mec.get(`/api/ordenes/${T.ot2.id}/fotos`)).status).toBe(403);
    expect((await subir(mec, { vehiculo_id: T.veh.id, orden_id: T.ot2.id, etapa: 'recepcion' })).status).toBe(403);
    const ajena = await subir(T.a.api, { vehiculo_id: T.veh.id, orden_id: T.ot2.id, etapa: 'recepcion' });
    expect((await bajar(mec, `/api/fotos/${ajena.body.id}/archivo`)).status).toBe(403);
    // En la ficha del vehículo ve las del vehículo y las de SU orden, no las de la ajena
    const vis = (await mec.get(`/api/vehiculos/${T.veh.id}/fotos`)).body.map((f: any) => f.id);
    expect(vis).toContain(T.f1.id);
    expect(vis).toContain(suya.body.id);
    expect(vis).not.toContain(ajena.body.id);
    // Foto del vehículo sin OT: el mecánico no tiene permiso de crear/editar vehículos
    expect((await subir(mec, { vehiculo_id: T.veh.id })).status).toBe(403);
    // Otro mecánico sin asignación
    expect((await T.mec2.api.get(`/api/ordenes/${T.ot.id}/fotos`)).status).toBe(403);
    expect((await bajar(T.mec2.api, `/api/fotos/${T.fotoOt.id}/archivo`)).status).toBe(403);
    // Depósito: ve vehículos pero no tiene permisos de fotos
    expect((await T.dep.api.get(`/api/vehiculos/${T.veh.id}/fotos`)).status).toBe(403);
    expect((await bajar(T.dep.api, `/api/fotos/${T.f1.id}/archivo`)).status).toBe(403);
    expect((await subir(T.dep.api, { vehiculo_id: T.veh.id })).status).toBe(403);
    // Eliminar: ni mecánico ni recepción
    expect((await mec.del(`/api/fotos/${suya.body.id}`)).status).toBe(403);
    expect((await T.rec.api.del(`/api/fotos/${suya.body.id}`)).status).toBe(403);
    // Recepción sí sube a vehículos y órdenes
    expect((await subir(T.rec.api, { vehiculo_id: T.veh.id, descripcion: 'Recepción' })).status).toBe(201);
    T.suya = suya.body;
  });

  it('eliminar deja constancia (usuario y fecha), borra los objetos de R2 y libera el cupo', async () => {
    const antes = (await T.a.api.get('/api/fotos/estado')).body;
    const r = await T.a.api.del(`/api/fotos/${T.suya.id}`);
    expect(r.status).toBe(200);
    expect((await bajar(T.a.api, `/api/fotos/${T.suya.id}/archivo`)).status).toBe(404);
    expect((await T.a.api.get(`/api/ordenes/${T.ot.id}/fotos`)).body.some((f: any) => f.id === T.suya.id)).toBe(false);
    const despues = (await T.a.api.get('/api/fotos/estado')).body;
    expect(despues.cantidad).toBe(antes.cantidad - 1);
    expect(despues.usado_bytes).toBeLessThan(antes.usado_bytes);
    const aud = (await plataforma.req('GET', '/api/platform/fotos/auditoria', undefined, platformHeaders)).body;
    expect(aud.huerfanos_total).toBe(0);
    expect(aud.faltantes_total).toBe(0);
  });

  it('el cupo por taller se valida antes de guardar y lo ajusta la plataforma', async () => {
    const t = await nuevoTaller('Taller cupo');
    const cli = (await t.api.post('/api/clientes', { nombre: 'Cliente cupo' })).body;
    const v = (await t.api.post('/api/vehiculos', { cliente_id: cli.id, patente: 'CUP111' })).body;
    expect((await plataforma.req('PATCH', `/api/platform/talleres/${t.tallerId}/almacenamiento`, { fotos_limite_mb: 0 }, platformHeaders)).status).toBe(400);
    const ajuste = await plataforma.req('PATCH', `/api/platform/talleres/${t.tallerId}/almacenamiento`, { fotos_limite_mb: 1 }, platformHeaders);
    expect(ajuste.body).toMatchObject({ limite_bytes: 1024 * 1024, usado_bytes: 0 });
    expect((await t.api.get('/api/fotos/estado')).body.limite_bytes).toBe(1024 * 1024);
    const u1 = await subir(t.api, { vehiculo_id: v.id }, jpeg(800, 600, 300_000));
    expect(u1.status, JSON.stringify(u1.body)).toBe(201);
    expect((await subir(t.api, { vehiculo_id: v.id }, jpeg(800, 600, 300_000))).status).toBe(201);
    const lleno = await subir(t.api, { vehiculo_id: v.id }, jpeg(800, 600, 500_000));
    expect(lleno.status).toBe(409);
    expect(lleno.body.error.code).toBe('sin_espacio');
    expect(lleno.body.error.message).toMatch(/límite de almacenamiento/);
    expect((await t.api.get('/api/fotos/estado')).body.cantidad).toBe(2); // la rechazada no dejó nada
    // Sólo la plataforma ajusta el límite
    expect((await t.api.req('PATCH', `/api/platform/talleres/${t.tallerId}/almacenamiento`, { fotos_limite_mb: 9999 })).status).toBe(401);
    const lista = (await plataforma.req('GET', '/api/platform/almacenamiento', undefined, platformHeaders)).body;
    expect(lista.talleres.find((x: any) => x.taller_id === t.tallerId)).toMatchObject({ cantidad: 2 });
  });

  it('la plataforma exporta con manifiesto verificable (sha256) y audita R2 contra D1', async () => {
    const m = (await plataforma.req('GET', `/api/platform/fotos/manifiesto?taller=${T.a.tallerId}`, undefined, platformHeaders)).body;
    expect(m.fotos.length).toBeGreaterThanOrEqual(5);
    for (const f of m.fotos) {
      expect(f.clave).toBe(`fotos/${T.a.tallerId}/${f.id}`);
      const r = await fetch(`${BASE}/api/platform/fotos/${f.id}/archivo`, { headers: platformHeaders });
      expect(r.status).toBe(200);
      const b = Buffer.from(await r.arrayBuffer());
      expect(crypto.createHash('sha256').update(b).digest('hex')).toBe(f.sha256);
      expect(b.length).toBe(f.bytes);
      const rm = await fetch(`${BASE}/api/platform/fotos/${f.id}/archivo?variante=miniatura`, { headers: platformHeaders });
      expect(crypto.createHash('sha256').update(Buffer.from(await rm.arrayBuffer())).digest('hex')).toBe(f.miniatura_sha256);
    }
    expect((await fetch(`${BASE}/api/platform/fotos/manifiesto`)).status).toBe(401);
    const aud = (await plataforma.req('GET', `/api/platform/fotos/auditoria?taller=${T.a.tallerId}`, undefined, platformHeaders)).body;
    expect(aud).toMatchObject({ huerfanos_total: 0, faltantes_total: 0 });
    expect(aud.objetos_en_r2).toBe(m.fotos.length * 2);
  });
});
