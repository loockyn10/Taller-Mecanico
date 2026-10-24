// Sprint 18: checklist de recepción y entrega — borrador, confirmación con hash, daños con fotografías (Sprint 16), conformidad del cliente, revisiones,
// permisos, aislamiento entre talleres y ausencia de precios en las respuestas.
import { beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { Api, nuevoPersonal, nuevoTaller, sqlLocal, consultaLocal } from './cliente';
import { PUERTO } from './global-setup';

const BASE = `http://127.0.0.1:${PUERTO}`;

function jpeg(relleno = 2000, ancho = 800, alto = 600): Uint8Array {
  const seg = (m: number, datos: number[]) => [0xff, m, (datos.length + 2) >> 8, (datos.length + 2) & 0xff, ...datos];
  return Uint8Array.from([
    0xff, 0xd8,
    ...seg(0xe0, [...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...seg(0xc0, [8, alto >> 8, alto & 0xff, ancho >> 8, ancho & 0xff, 1, 1, 0x11, 0]),
    ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]),
    ...Array.from({ length: relleno }, (_, i) => (i * 7 + relleno) & 0x7f),
    0xff, 0xd9,
  ]);
}
async function subirFoto(api: Api, campos: { vehiculo_id: string; orden_id: string; etapa: string }, relleno = 2000) {
  const f = new FormData();
  for (const [k, v] of Object.entries({ idem_key: crypto.randomUUID(), ...campos })) f.set(k, v);
  f.set('foto', new Blob([jpeg(relleno)], { type: 'image/jpeg' }), 'f.jpg');
  f.set('miniatura', new Blob([jpeg(100, 200, 150)], { type: 'image/jpeg' }), 'm.jpg');
  const r = await fetch(`${BASE}/api/fotos`, { method: 'POST', headers: { cookie: api.cookie, 'cf-connecting-ip': api.ip, 'x-fierro-subida': '1' }, body: f });
  return { status: r.status, body: await r.json() };
}

const contenido = (extra: Record<string, unknown> = {}) => ({
  fecha_hora: new Date().toISOString(),
  km: 120500,
  combustible: '1/2',
  llaves: 2,
  observaciones: 'Llega con ruido en el tren delantero',
  items: { 'carroceria.frente': { estado: 'con_observaciones', obs: 'Rayón en el paragolpes' }, 'luces.delanteras': { estado: 'correcto' }, 'accesorios.matafuego': { estado: 'no_corresponde' } },
  danos: [] as any[],
  pertenencias: [{ descripcion: 'Documentación del vehículo' }, { descripcion: 'Llave de repuesto' }],
  estado_general: '',
  trabajos: [] as any[],
  ...extra,
});
const firmaOk = () => ({ ancho: 600, alto: 200, trazos: [[[20, 150], [60, 60], [100, 140], [140, 70], [180, 130], [260, 90], [330, 120]], [[40, 170], [300, 172]]] });

/** Recorre el JSON buscando claves que parezcan importes. */
function clavesDeDinero(v: unknown, ruta = ''): string[] {
  if (!v || typeof v !== 'object') return [];
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [...(/precio|costo|importe|subtotal|^total$|margen|iva/i.test(k) ? [`${ruta}${k}`] : []), ...clavesDeDinero(x, `${ruta}${k}.`)]);
}

const T: any = {};
beforeAll(async () => {
  T.a = await nuevoTaller('Taller checklist A', 8);
  T.b = await nuevoTaller('Taller checklist B');
  T.rec = await nuevoPersonal(T.a.api, 'recepcion');
  T.mec = await nuevoPersonal(T.a.api, 'mecanico');
  T.mec2 = await nuevoPersonal(T.a.api, 'mecanico');
  T.dep = await nuevoPersonal(T.a.api, 'deposito');
  const cli = (await T.a.api.post('/api/clientes', { nombre: 'Cliente Checklist' })).body;
  T.cli = cli;
  T.veh = (await T.a.api.post('/api/vehiculos', { cliente_id: cli.id, patente: 'CHK111', anio: 2019 })).body;
  const mecs = (await T.a.api.get('/api/mecanicos')).body;
  T.mecId = mecs.find((m: any) => m.usuario_id === T.mec.id).id;
  const items = [{ tipo: 'libre', descripcion: 'Cambio de pastillas de freno', cantidad: 1, precio_unitario: 8000000 }];
  T.ot = (await T.a.api.post('/api/ordenes', { cliente_id: cli.id, vehiculo_id: T.veh.id, mecanico_id: T.mecId, falla_reportada: 'Ruido', km_ingreso: 120000, items })).body;
  T.ot2 = (await T.a.api.post('/api/ordenes', { cliente_id: cli.id, vehiculo_id: T.veh.id, falla_reportada: 'Otra', items: [] })).body;
  const cliB = (await T.b.api.post('/api/clientes', { nombre: 'Cliente B' })).body;
  T.vehB = (await T.b.api.post('/api/vehiculos', { cliente_id: cliB.id, patente: 'CHK999' })).body;
  T.otB = (await T.b.api.post('/api/ordenes', { cliente_id: cliB.id, vehiculo_id: T.vehB.id, falla_reportada: 'B', items: [] })).body;
});

describe('permisos y alcance', () => {
  it('quien no tiene el permiso no ve ni crea; el mecánico sólo ve las suyas y no registra recepciones por defecto', async () => {
    expect((await T.dep.api.get(`/api/ordenes/${T.ot.id}/checklists`)).status).toBe(403);
    expect((await T.mec.api.get(`/api/ordenes/${T.ot.id}/checklists`)).status).toBe(200); // asignada a él
    expect((await T.mec2.api.get(`/api/ordenes/${T.ot.id}/checklists`)).status).toBe(403); // no es suya
    expect((await T.mec.api.post(`/api/ordenes/${T.ot.id}/checklists/recepcion/borrador`)).status).toBe(403); // sólo consulta
    expect((await T.rec.api.post(`/api/ordenes/${T.ot.id}/checklists/otro/borrador`)).status).toBe(404);
  });

  it('el propietario configura quién puede cada cosa: otorgar y retirar permisos cambia lo que se puede hacer de inmediato', async () => {
    const u = (await T.a.api.get(`/api/taller/usuarios/${T.mec.id}`)).body;
    expect(u.permisos).toContain('checklists.ver');
    expect(u.permisos).not.toContain('checklists.recepcion');
    const r = await T.a.api.put(`/api/taller/usuarios/${T.mec.id}/permisos`, { permisos: [...u.permisos, 'checklists.recepcion'] });
    expect([200, 204]).toContain(r.status);
    const borr = await T.mec.api.post(`/api/ordenes/${T.ot2.id}/checklists/recepcion/borrador`);
    expect(borr.status).toBe(403); // la OT 2 no es suya, aunque ahora pueda registrar recepciones
    // Se devuelve a la plantilla para no alterar el resto de las pruebas
    await T.a.api.put(`/api/taller/usuarios/${T.mec.id}/permisos`, { permisos: u.permisos });
    expect((await T.mec.api.post(`/api/ordenes/${T.ot.id}/checklists/recepcion/borrador`)).status).toBe(403);
  });
});

describe('recepción: borrador, daños con fotografías y confirmación', () => {
  it('crea el borrador una sola vez (idempotente) con el kilometraje de la OT', async () => {
    const r = await T.rec.api.post(`/api/ordenes/${T.ot.id}/checklists/recepcion/borrador`);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ tipo: 'recepcion', revision: 0, estado: 'borrador', version: 1, checklist_version: 1, firma_estado: null });
    expect(r.body.datos.km).toBe(120000);
    T.reg = r.body;
    const otra = await T.rec.api.post(`/api/ordenes/${T.ot.id}/checklists/recepcion/borrador`);
    expect(otra.status).toBe(200);
    expect(otra.body.id).toBe(T.reg.id);
  });

  it('valida el contenido en el servidor', async () => {
    const p = (datos: unknown, version = 1) => T.rec.api.put(`/api/checklists/${T.reg.id}`, { version, datos });
    expect((await p(contenido({ items: { 'carroceria.inventado': { estado: 'correcto' } } }))).status).toBe(400);
    expect((await p(contenido({ items: { 'luces.stop': { estado: 'roto' } } }))).status).toBe(400);
    expect((await p(contenido({ fecha_hora: new Date(Date.now() + 3600_000).toISOString() }))).status).toBe(400);
    expect((await p(contenido({ trabajos: [{ descripcion: 'Algo' }] }))).status).toBe(400); // los trabajos son de la entrega
    expect((await p(contenido({ combustible: '5/8' }))).status).toBe(400);
    expect((await p(contenido({ danos: [{ id: 'dano-0001', zona: 'techo', descripcion: 'x', fotos: ['no-existe'] }] }))).status).toBe(400);
    expect((await p(contenido({ danos: [{ id: 'dano-0001', zona: 'cielo', descripcion: 'x', fotos: [] }] }))).status).toBe(400);
    expect((await p({ ...contenido(), extra: 1 })).status).toBe(400);
  });

  it('guarda el borrador con daños y fotos de la misma OT, detecta ediciones simultáneas y rechaza fotos de otra OT', async () => {
    const f1 = await subirFoto(T.rec.api, { vehiculo_id: T.veh.id, orden_id: T.ot.id, etapa: 'recepcion' }, 2000);
    const f2 = await subirFoto(T.rec.api, { vehiculo_id: T.veh.id, orden_id: T.ot.id, etapa: 'recepcion' }, 2100);
    const fOtra = await subirFoto(T.rec.api, { vehiculo_id: T.veh.id, orden_id: T.ot2.id, etapa: 'recepcion' }, 2200);
    expect([f1.status, f2.status, fOtra.status], JSON.stringify([f1.body, f2.body])).toEqual([201, 201, 201]);
    T.fotos = [f1.body.id, f2.body.id];
    T.fotoOtraOT = fOtra.body.id;
    const danos = [{ id: 'dano-0001', zona: 'frente', x: 50, y: 12, descripcion: 'Rayón profundo en el paragolpes', fotos: [f1.body.id] }, { id: 'dano-0002', zona: 'interior', descripcion: 'Quemadura en el asiento', fotos: [] }];
    const ok = await T.rec.api.put(`/api/checklists/${T.reg.id}`, { version: 1, datos: contenido({ danos }) });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(2);
    expect(ok.body.datos.danos).toHaveLength(2);
    // Alguien más guardó antes: la versión vieja se rechaza
    const viejo = await T.rec.api.put(`/api/checklists/${T.reg.id}`, { version: 1, datos: contenido() });
    expect(viejo.status).toBe(409);
    expect(viejo.body.error.code).toBe('conflicto_version');
    // Una foto de otra OT no se puede asociar
    const mal = await T.rec.api.put(`/api/checklists/${T.reg.id}`, { version: 2, datos: contenido({ danos: [{ id: 'dano-0003', zona: 'techo', descripcion: 'x', fotos: [T.fotoOtraOT] }] }) });
    expect(mal.status).toBe(400);
    T.danos = danos;
  });

  it('no se puede firmar un borrador ni confirmarlo con una versión vieja', async () => {
    expect((await T.rec.api.post(`/api/checklists/${T.reg.id}/firma`, { resultado: 'firmada', nombre_firmante: 'Juan', firma: firmaOk() })).status).toBe(409);
    expect((await T.rec.api.post(`/api/checklists/${T.reg.id}/confirmar`, { version: 1 })).status).toBe(409);
  });

  it('confirma: queda congelado, con hash, contexto y las fotos de la etapa vinculadas', async () => {
    const r = await T.rec.api.post(`/api/checklists/${T.reg.id}/confirmar`, { version: 2 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ estado: 'confirmado', firma_estado: 'pendiente', revision: 0 });
    expect(r.body.contenido_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.contexto).toMatchObject({ tipo: 'recepcion', orden: { numero: T.ot.numero }, cliente: { nombre: 'Cliente Checklist' }, vehiculo: { patente: 'CHK111' }, responsable: { nombre: expect.any(String) } });
    expect(r.body.contexto.fotos.map((f: any) => f.id).sort()).toEqual([...T.fotos].sort());
    T.hash = r.body.contenido_sha256;
    const v = await T.rec.api.get(`/api/checklists/${T.reg.id}/verificar`);
    expect(v.body).toMatchObject({ integro: true, sha256_guardado: T.hash, fotos: { cantidad: 2, correctas: 2 } });
  });

  it('un registro confirmado no se modifica ni se descarta, ni por la API ni directamente en la base', async () => {
    expect((await T.rec.api.put(`/api/checklists/${T.reg.id}`, { version: 3, datos: contenido({ km: 1 }) })).status).toBe(409);
    expect((await T.rec.api.del(`/api/checklists/${T.reg.id}`)).status).toBe(409);
    expect((await T.rec.api.post(`/api/checklists/${T.reg.id}/confirmar`, { version: 3 })).status).toBe(409);
    expect((await T.rec.api.post(`/api/ordenes/${T.ot.id}/checklists/recepcion/borrador`)).status).toBe(409); // ya hay una confirmada: hay que corregir
    await expect(sqlLocal(`UPDATE ck_registros SET km = 1 WHERE id = '${T.reg.id}'`)).rejects.toThrow(/inmutable/);
    await expect(sqlLocal(`UPDATE ck_registros SET datos = '{}' WHERE id = '${T.reg.id}'`)).rejects.toThrow(/inmutable/);
    await expect(sqlLocal(`DELETE FROM ck_registros WHERE id = '${T.reg.id}'`)).rejects.toThrow(/inmutable/);
    await expect(sqlLocal(`DELETE FROM ck_fotos WHERE registro_id = '${T.reg.id}'`)).rejects.toThrow(/inmutable/);
    const v = await T.rec.api.get(`/api/checklists/${T.reg.id}/verificar`);
    expect(v.body.integro).toBe(true);
  });

  it('las fotografías incluidas no se pueden eliminar; las que no están en ningún registro, sí', async () => {
    const r = await T.a.api.del(`/api/fotos/${T.fotos[0]}`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('foto_en_checklist');
    await expect(sqlLocal(`UPDATE fotos SET estado = 'eliminada' WHERE id = '${T.fotos[1]}'`)).rejects.toThrow(/foto_en_checklist/);
    const suelta = await subirFoto(T.rec.api, { vehiculo_id: T.veh.id, orden_id: T.ot.id, etapa: 'reparacion' }, 2300);
    expect((await T.a.api.del(`/api/fotos/${suelta.body.id}`)).status).toBe(200);
  });
});

describe('conformidad del cliente', () => {
  it('rechaza una firma vacía o demasiado corta y exige el nombre', async () => {
    const f = (firma: unknown, nombre = 'Cliente Checklist') => T.rec.api.post(`/api/checklists/${T.reg.id}/firma`, { resultado: 'firmada', nombre_firmante: nombre, firma });
    expect((await f({ ancho: 600, alto: 200, trazos: [[[10, 10]]] })).status).toBe(400);
    expect((await f({ ancho: 600, alto: 200, trazos: [[[10, 10], [11, 10], [12, 10], [13, 10], [14, 10], [15, 10], [16, 10], [17, 10]]] })).status).toBe(400); // línea de 7 px
    expect((await f(firmaOk(), '')).status).toBe(400);
    expect((await f({ ancho: 600, alto: 200, trazos: [[[10, 10], [900, 10]]] })).status).toBe(400); // fuera del lienzo
  });

  it('firma: guarda trazos, nombre, hora del servidor, responsable y el hash del contenido aceptado; no se firma dos veces', async () => {
    const antes = Date.now();
    const r = await T.rec.api.post(`/api/checklists/${T.reg.id}/firma`, { resultado: 'firmada', nombre_firmante: 'Cliente Checklist', firma: firmaOk() });
    expect(r.status).toBe(201);
    expect(r.body.firma_estado).toBe('firmada');
    const f = r.body.firmas[0];
    expect(f).toMatchObject({ resultado: 'firmada', nombre_firmante: 'Cliente Checklist', contenido_sha256: T.hash, texto_version: 1, registrado_por_nombre: expect.any(String) });
    expect(f.firma.trazos).toHaveLength(2);
    expect(f.texto_conformidad).toMatch(/Declaro que el estado del vehículo/);
    expect(Math.abs(Date.parse(f.created_at) - antes)).toBeLessThan(60_000); // hora del servidor
    expect((await T.rec.api.post(`/api/checklists/${T.reg.id}/firma`, { resultado: 'firmada', nombre_firmante: 'Otra persona', firma: firmaOk() })).status).toBe(409);
    expect((await T.rec.api.get(`/api/checklists/${T.reg.id}/verificar`)).body.firmas).toEqual([{ id: f.id, resultado: 'firmada', corresponde_al_contenido: true }]);
  });

  it('la firma y el nombre sólo los ve quien tiene el permiso de firmas; el resto ve que está firmada', async () => {
    const mec = (await T.mec.api.get(`/api/ordenes/${T.ot.id}/checklists`)).body.registros[0];
    expect(mec.firma_estado).toBe('firmada');
    expect(mec.firmas[0]).toMatchObject({ resultado: 'firmada' });
    expect(mec.firmas[0].firma).toBeUndefined();
    expect(mec.firmas[0].nombre_firmante).toBeUndefined();
    const rec = (await T.rec.api.get(`/api/ordenes/${T.ot.id}/checklists`)).body.registros[0];
    expect(rec.firmas[0].firma.trazos.length).toBeGreaterThan(0);
  });

  it('la firma es de sólo agregar: no se modifica ni se borra, ni se puede apuntar a otro contenido', async () => {
    const id = (await consultaLocal<{ id: string }>(`SELECT id FROM ck_firmas WHERE registro_id = '${T.reg.id}'`))[0].id;
    await expect(sqlLocal(`UPDATE ck_firmas SET nombre_firmante = 'Otro' WHERE id = '${id}'`)).rejects.toThrow(/inmutable/);
    await expect(sqlLocal(`DELETE FROM ck_firmas WHERE id = '${id}'`)).rejects.toThrow(/inmutable/);
    await expect(
      sqlLocal(`INSERT INTO ck_firmas (id, taller_id, registro_id, resultado, aclaracion, contenido_sha256, checklist_version, texto_conformidad, texto_version, registrado_por_nombre) SELECT 'x1', taller_id, id, 'no_presente', 'x', 'hash-distinto', 1, 't', 1, 'n' FROM ck_registros WHERE id = '${T.reg.id}'`),
    ).rejects.toThrow(/contenido_distinto/);
  });
});

describe('correcciones: el original se conserva', () => {
  it('sólo con el permiso de corregir y con un motivo; crea una revisión en borrador copiando el contenido', async () => {
    expect((await T.rec.api.post(`/api/ordenes/${T.ot.id}/checklists/recepcion/corregir`, { motivo: 'Se cargó mal el kilometraje' })).status).toBe(403);
    expect((await T.a.api.post(`/api/ordenes/${T.ot.id}/checklists/recepcion/corregir`, { motivo: 'no' })).status).toBe(400);
    const r = await T.a.api.post(`/api/ordenes/${T.ot.id}/checklists/recepcion/corregir`, { motivo: 'Se cargó mal el kilometraje' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ revision: 1, previo_id: T.reg.id, estado: 'borrador', motivo: 'Se cargó mal el kilometraje' });
    expect(r.body.datos.km).toBe(120500);
    T.rev = r.body;
    expect((await T.a.api.post(`/api/ordenes/${T.ot.id}/checklists/recepcion/corregir`, { motivo: 'Otra corrección más' })).status).toBe(409); // ya hay una en curso
  });

  it('al confirmarla es la vigente; la original sigue íntegra y firmada, y ya no se puede firmar la vieja', async () => {
    const g = await T.a.api.put(`/api/checklists/${T.rev.id}`, { version: 1, datos: contenido({ km: 125000, danos: T.danos }) });
    expect(g.status).toBe(200);
    const c = await T.a.api.post(`/api/checklists/${T.rev.id}/confirmar`, { version: 2 });
    expect(c.status).toBe(200);
    expect(c.body.contenido_sha256).not.toBe(T.hash);
    const lista = (await T.a.api.get(`/api/ordenes/${T.ot.id}/checklists`)).body.registros.filter((x: any) => x.tipo === 'recepcion');
    expect(lista.map((x: any) => [x.revision, x.estado, x.firma_estado])).toEqual([[0, 'confirmado', 'firmada'], [1, 'confirmado', 'pendiente']]);
    expect(lista[0].datos.km).toBe(120500); // el original no cambió
    expect(lista[0].contenido_sha256).toBe(T.hash);
    expect((await T.a.api.get(`/api/checklists/${T.reg.id}/verificar`)).body.integro).toBe(true);
    // La conformidad va a la revisión vigente
    const vieja = await T.a.api.post(`/api/checklists/${T.reg.id}/firma`, { resultado: 'no_presente' });
    expect(vieja.status).toBe(409);
    const ok = await T.rec.api.post(`/api/checklists/${T.rev.id}/firma`, { resultado: 'firmada', nombre_firmante: 'Cliente Checklist', firma: firmaOk() });
    expect(ok.status).toBe(201);
  });
});

describe('entrega', () => {
  it('prefiere los trabajos de la OT sin precios, se relaciona con la recepción vigente y no pisa la recepción', async () => {
    const b = await T.rec.api.post(`/api/ordenes/${T.ot.id}/checklists/entrega/borrador`);
    expect(b.status).toBe(201);
    expect(b.body.datos.trabajos).toEqual([{ descripcion: 'Cambio de pastillas de freno' }]);
    expect(b.body.recepcion_id).toBe(T.rev.id);
    expect(b.body.datos.km).toBeNull();
    const fe = await subirFoto(T.rec.api, { vehiculo_id: T.veh.id, orden_id: T.ot.id, etapa: 'entrega' }, 2400);
    const datos = contenido({
      km: 120580,
      combustible: '3/4',
      llaves: 2,
      observaciones: '',
      estado_general: 'Funciona correctamente. Se lavó por fuera.',
      trabajos: b.body.datos.trabajos,
      items: { 'carroceria.frente': { estado: 'con_observaciones', obs: 'El rayón ya estaba' }, 'luces.delanteras': { estado: 'correcto' } },
      danos: [{ id: 'dano-e001', zona: 'frente', descripcion: 'El mismo rayón del ingreso', fotos: [fe.body.id] }],
      pertenencias: [{ descripcion: 'Documentación del vehículo' }],
    });
    expect((await T.rec.api.put(`/api/checklists/${b.body.id}`, { version: 1, datos })).status).toBe(200);
    const c = await T.rec.api.post(`/api/checklists/${b.body.id}/confirmar`, { version: 2 });
    expect(c.status).toBe(200);
    expect(c.body.contexto.fotos.map((f: any) => f.etapa)).toEqual(['entrega']); // sólo las de la etapa de entrega
    expect(c.body.recepcion_id).toBe(T.rev.id);
    const nr = await T.rec.api.post(`/api/checklists/${b.body.id}/firma`, { resultado: 'no_presente', aclaracion: 'Retira un familiar' });
    expect(nr.status).toBe(201);
    expect(nr.body.firma_estado).toBe('no_presente');
    // Desde la OT se consultan ambos registros sin que uno pise al otro
    const todo = (await T.rec.api.get(`/api/ordenes/${T.ot.id}/checklists`)).body.registros;
    expect(todo.map((x: any) => `${x.tipo}#${x.revision}:${x.estado}`)).toEqual(['entrega#0:confirmado', 'recepcion#0:confirmado', 'recepcion#1:confirmado']);
    // El cliente que se había ausentado puede firmar después: queda el historial completo
    const luego = await T.rec.api.post(`/api/checklists/${b.body.id}/firma`, { resultado: 'firmada', nombre_firmante: 'Cliente Checklist', firma: firmaOk() });
    expect(luego.status).toBe(201);
    expect(luego.body.firmas.map((x: any) => x.resultado)).toEqual(['no_presente', 'firmada']);
    expect(luego.body.firma_estado).toBe('firmada');
    T.entrega = c.body;
  });

  it('una OT cancelada no admite nuevos registros', async () => {
    const o = (await T.a.api.post('/api/ordenes', { cliente_id: T.cli.id, vehiculo_id: T.veh.id, falla_reportada: 'Cancelada', items: [] })).body;
    expect((await T.a.api.post(`/api/ordenes/${o.id}/estado`, { estado: 'cancelada', nota: 'prueba' })).status).toBe(200);
    expect((await T.rec.api.post(`/api/ordenes/${o.id}/checklists/recepcion/borrador`)).status).toBe(409);
  });
});

describe('historial, aislamiento y privacidad', () => {
  it('desde la ficha del vehículo se ven los checklists de todas sus órdenes; el mecánico sólo los de las suyas', async () => {
    const b2 = await T.rec.api.post(`/api/ordenes/${T.ot2.id}/checklists/recepcion/borrador`);
    expect(b2.status).toBe(201);
    const rec = (await T.rec.api.get(`/api/vehiculos/${T.veh.id}/checklists`)).body;
    expect(rec.map((o: any) => o.numero)).toEqual([T.ot2.numero, T.ot.numero].sort((a, b) => b - a));
    const ot1 = rec.find((o: any) => o.orden_id === T.ot.id);
    expect(ot1.registros.map((r: any) => `${r.tipo}#${r.revision}`)).toEqual(['entrega#0', 'recepcion#1', 'recepcion#0']);
    expect(ot1.registros.find((r: any) => r.tipo === 'recepcion' && r.revision === 1)).toMatchObject({ danos: 2, firma_estado: 'firmada', km: 125000 });
    expect(rec.find((o: any) => o.orden_id === T.ot2.id).registros[0]).toMatchObject({ estado: 'borrador', firma_estado: null });
    const mec = (await T.mec.api.get(`/api/vehiculos/${T.veh.id}/checklists`)).body;
    expect(mec.map((o: any) => o.orden_id)).toEqual([T.ot.id]);
    expect((await T.dep.api.get(`/api/vehiculos/${T.veh.id}/checklists`)).status).toBe(403);
  });

  it('otro taller no puede ver, editar, confirmar, firmar ni verificar nada (404)', async () => {
    expect((await T.b.api.get(`/api/ordenes/${T.ot.id}/checklists`)).status).toBe(404);
    expect((await T.b.api.get(`/api/vehiculos/${T.veh.id}/checklists`)).status).toBe(404);
    expect((await T.b.api.post(`/api/ordenes/${T.ot.id}/checklists/recepcion/borrador`)).status).toBe(404);
    for (const [m, ruta, cuerpo] of [
      ['PUT', `/api/checklists/${T.rev.id}`, { version: 1, datos: contenido() }],
      ['DELETE', `/api/checklists/${T.rev.id}`, undefined],
      ['POST', `/api/checklists/${T.rev.id}/confirmar`, { version: 1 }],
      ['POST', `/api/checklists/${T.rev.id}/firma`, { resultado: 'no_presente' }],
      ['GET', `/api/checklists/${T.rev.id}/verificar`, undefined],
    ] as const) expect((await T.b.api.req(m, ruta, cuerpo)).status, `${m} ${ruta}`).toBe(404);
    expect((await T.b.api.post(`/api/ordenes/${T.ot.id}/checklists/recepcion/corregir`, { motivo: 'Intento ajeno' })).status).toBe(404);
    // Ni siquiera con el id de una foto propia se puede colar una foto de otro taller
    const fb = await subirFoto(T.b.api, { vehiculo_id: T.vehB.id, orden_id: T.otB.id, etapa: 'recepcion' });
    const bb = await T.b.api.post(`/api/ordenes/${T.otB.id}/checklists/recepcion/borrador`);
    expect((await T.b.api.put(`/api/checklists/${bb.body.id}`, { version: 1, datos: contenido({ danos: [{ id: 'dano-9999', zona: 'techo', descripcion: 'x', fotos: [T.fotos[0]] }] }) })).status).toBe(400);
    expect((await T.b.api.put(`/api/checklists/${bb.body.id}`, { version: 1, datos: contenido({ danos: [{ id: 'dano-9999', zona: 'techo', descripcion: 'x', fotos: [fb.body.id] }] }) })).status).toBe(200);
  });

  it('ninguna respuesta incluye precios, costos ni importes, aunque la OT tenga trabajos valorizados', async () => {
    const respuestas = [
      (await T.rec.api.get(`/api/ordenes/${T.ot.id}/checklists`)).body,
      (await T.mec.api.get(`/api/ordenes/${T.ot.id}/checklists`)).body,
      (await T.rec.api.get(`/api/vehiculos/${T.veh.id}/checklists`)).body,
      (await T.a.api.get(`/api/ordenes/${T.ot.id}/checklists`)).body,
      (await T.rec.api.get(`/api/checklists/${T.reg.id}/verificar`)).body,
    ];
    for (const r of respuestas) expect(clavesDeDinero(r)).toEqual([]);
    const texto = JSON.stringify(respuestas);
    expect(texto).not.toContain('8000000');
  });

  it('queda registro en la auditoría de crear, confirmar y firmar', async () => {
    const acciones = (await consultaLocal<{ accion: string }>(`SELECT accion FROM auditoria WHERE entidad = 'ck_registro' AND entidad_id = '${T.reg.id}' ORDER BY created_at`)).map((x) => x.accion);
    expect(acciones).toEqual(['crear_borrador', 'confirmar', 'conformidad']);
  });
});
