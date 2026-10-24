// Sprint 20: seguimiento público de órdenes de trabajo — generación del enlace, apertura sin sesión, reflejo de los cambios de estado, mensajes públicos,
// transiciones visibles, desactivación y regeneración inmediatas, límites de intentos, cabeceras, permisos, aislamiento entre talleres y ausencia de datos privados.
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, consultaLocal, dormir, nuevoPersonal, nuevoTaller } from './cliente';
import { PUERTO } from './global-setup';

const BASE = `http://127.0.0.1:${PUERTO}`;
let ipN = 0;
const ipNueva = () => `10.250.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`;

/** Visitante anónimo: sin cookie, con su propio origen (los límites de intentos son por origen). */
async function anonimo(ruta: string, ip = ipNueva()) {
  const r = await fetch(BASE + ruta, { headers: { 'cf-connecting-ip': ip } });
  const texto = await r.text();
  let json: any = null;
  try { json = JSON.parse(texto); } catch { /* HTML */ }
  return { status: r.status, headers: r.headers, texto, json };
}
const tokenDe = (url: string) => url.split('/seguimiento/')[1];
const pagina = (url: string, ip?: string) => anonimo(`/seguimiento/${tokenDe(url)}`, ip);
const jsonDe = (url: string, ip?: string) => anonimo(`/api/seguimiento/${tokenDe(url)}`, ip);

const T: any = {};
beforeAll(async () => {
  T.a = await nuevoTaller('Taller Seguimiento A', 8);
  T.b = await nuevoTaller('Taller Seguimiento B');
  T.rec = await nuevoPersonal(T.a.api, 'recepcion');
  T.mec = await nuevoPersonal(T.a.api, 'mecanico');
  T.mec2 = await nuevoPersonal(T.a.api, 'mecanico');
  T.dep = await nuevoPersonal(T.a.api, 'deposito');
  T.caja = await nuevoPersonal(T.a.api, 'caja');
  const cli = (await T.a.api.post('/api/clientes', { nombre: 'Rosario Ñañez', telefono: '341 555-7788', direccion: 'Calle Falsa 123' })).body;
  T.cli = cli;
  T.veh = (await T.a.api.post('/api/vehiculos', { cliente_id: cli.id, patente: 'SEG123', anio: 2017 })).body;
  const mecs = (await T.a.api.get('/api/mecanicos')).body;
  T.mecId = mecs.find((m: any) => m.usuario_id === T.mec.id).id;
  const items = [
    { tipo: 'libre', descripcion: 'Cambio de pastillas de freno', cantidad: 1, precio_unitario: 8765432 },
    { tipo: 'libre', descripcion: 'Alineación y balanceo', cantidad: 1, precio_unitario: 3456789 },
  ];
  const manana = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
  T.ot = (await T.a.api.post('/api/ordenes', { cliente_id: cli.id, vehiculo_id: T.veh.id, mecanico_id: T.mecId, falla_reportada: 'FALLA-PRIVADA ruido al frenar', diagnostico: 'DIAGNOSTICO-PRIVADO discos gastados', observaciones: 'OBSERVACION-PRIVADA llamar antes', km_ingreso: 98765, fecha_prometida: manana, items })).body;
  T.fechaPrometida = manana;
  T.ot2 = (await T.a.api.post('/api/ordenes', { cliente_id: cli.id, vehiculo_id: T.veh.id, falla_reportada: 'Otra', items: [] })).body;
  await T.a.api.post(`/api/ordenes/${T.ot.id}/notas`, { texto: 'NOTA-INTERNA-RESERVADA el cliente debe plata' });
  const cliB = (await T.b.api.post('/api/clientes', { nombre: 'Cliente B' })).body;
  T.vehB = (await T.b.api.post('/api/vehiculos', { cliente_id: cliB.id, patente: 'SEG999' })).body;
  T.otB = (await T.b.api.post('/api/ordenes', { cliente_id: cliB.id, vehiculo_id: T.vehB.id, falla_reportada: 'B', items: [] })).body;
});

describe('1. generación del enlace', () => {
  it('antes de activarlo no existe enlace; al activarlo se genera una dirección con un token aleatorio de 256 bits', async () => {
    const antes = await T.a.api.get(`/api/ordenes/${T.ot.id}/seguimiento`);
    expect(antes.status).toBe(200);
    expect(antes.body).toMatchObject({ existe: false, activo: false, url: null });
    const r = await T.rec.api.post(`/api/ordenes/${T.ot.id}/seguimiento/activar`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ existe: true, activo: true, generacion: 1 });
    expect(r.body.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${PUERTO}/seguimiento/[A-Za-z0-9_-]{43}$`));
    T.url = r.body.url;
    // El token no se deduce del número ni del id de la orden
    const tok = tokenDe(T.url);
    expect(tok).not.toContain(T.ot.id);
    expect(tok).not.toContain(String(T.ot.numero).padStart(4, '0'));
    // Activar de nuevo es idempotente y conserva el mismo enlace
    const otra = await T.rec.api.post(`/api/ordenes/${T.ot.id}/seguimiento/activar`);
    expect(otra.body.url).toBe(T.url);
  });

  it('cada orden tiene su propio token (dos órdenes nunca lo comparten)', async () => {
    const o2 = await T.a.api.post(`/api/ordenes/${T.ot2.id}/seguimiento/activar`);
    expect(tokenDe(o2.body.url)).not.toBe(tokenDe(T.url));
    T.url2 = o2.body.url;
  });
});

describe('2. apertura sin iniciar sesión', () => {
  it('la página abre sin cookie, es HTML en español y muestra el estado, el vehículo, la patente oculta y la última actualización', async () => {
    const r = await pagina(T.url);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(r.texto).toContain('Taller Seguimiento A');
    expect(r.texto).toContain('Vehículo recibido');
    expect(r.texto).toContain('SE•••3');
    expect(r.texto).toContain('Orden N° ');
    expect(r.texto).toContain('Última actualización');
    expect(r.texto).toContain('viewport');
    expect(r.texto).not.toContain('SEG123');
  });

  it('el JSON trae los mismos datos y nada de lo interno', async () => {
    const r = await jsonDe(T.url);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ taller: { nombre: 'Taller Seguimiento A' }, estado: { clave: 'recibida', listo: false }, vehiculo: { patente: 'SE•••3' } });
    expect(r.json.recorrido[0]).toMatchObject({ situacion: 'actual' });
  });
});

describe('3 y 4. cambio de estado en Fierro y reflejo en el seguimiento', () => {
  it('el estado se cambia donde siempre y la página lo refleja al recargar, sin tocar nada del seguimiento', async () => {
    const e1 = await T.rec.api.post(`/api/ordenes/${T.ot.id}/estado`, { estado: 'diagnostico', nota: 'NOTA-DEL-CAMBIO-INTERNA revisar con cuidado' });
    expect(e1.status).toBe(200);
    let j = (await jsonDe(T.url)).json;
    expect(j.estado).toMatchObject({ clave: 'diagnostico', titulo: 'En diagnóstico' });
    expect(j.recorrido.map((p: any) => `${p.situacion}:${p.titulo}`)).toEqual(['hecho:Vehículo recibido', 'actual:Diagnóstico', 'pendiente:Reparación', 'pendiente:Listo para retirar', 'pendiente:Entregado']);

    await T.rec.api.post(`/api/ordenes/${T.ot.id}/estado`, { estado: 'esperando_repuestos' });
    j = (await jsonDe(T.url)).json;
    expect(j.estado.titulo).toBe('Esperando repuestos');
    expect(j.recorrido.map((p: any) => `${p.situacion}:${p.titulo}`)).toEqual(['hecho:Vehículo recibido', 'hecho:Diagnóstico', 'actual:Espera de repuestos', 'pendiente:Reparación', 'pendiente:Listo para retirar', 'pendiente:Entregado']);
    expect((await pagina(T.url)).texto).toContain('Esperando repuestos');
  });

  it('el mecánico asignado cambia el estado con sus permisos de siempre y el seguimiento lo refleja; no puede entregar', async () => {
    expect((await T.mec.api.post(`/api/ordenes/${T.ot.id}/estado`, { estado: 'en_reparacion' })).status).toBe(200);
    expect((await jsonDe(T.url)).json.estado.clave).toBe('en_reparacion');
    expect((await T.mec.api.post(`/api/ordenes/${T.ot.id}/estado`, { estado: 'entregada' })).status).toBe(403);
    expect((await jsonDe(T.url)).json.estado.clave).toBe('en_reparacion');
  });

  it('no hay una progresión lineal: puede volver a diagnóstico y las etapas posteriores vuelven a pendiente; cada cambio tiene hora del servidor', async () => {
    await T.rec.api.post(`/api/ordenes/${T.ot.id}/estado`, { estado: 'diagnostico' });
    const j = (await jsonDe(T.url)).json;
    expect(j.recorrido.map((p: any) => `${p.situacion}:${p.titulo}`)).toEqual(['hecho:Vehículo recibido', 'actual:Diagnóstico', 'pendiente:Reparación', 'pendiente:Listo para retirar', 'pendiente:Entregado']);
    expect(j.historial.map((h: any) => h.titulo)).toEqual(['Volvió a diagnóstico', 'Reparación en curso', 'Esperando repuestos', 'En diagnóstico', 'Vehículo recibido']);
    for (const h of j.historial) expect(Date.now() - Date.parse(h.at)).toBeLessThan(120_000);
    expect(j.actualizado_at).toBe(j.historial[0].at);
    await T.rec.api.post(`/api/ordenes/${T.ot.id}/estado`, { estado: 'en_reparacion' });
  });

  it('listo para retirar: mensaje destacado; entregado: cierra el recorrido', async () => {
    await T.rec.api.post(`/api/ordenes/${T.ot.id}/estado`, { estado: 'lista' });
    const p = await pagina(T.url);
    expect(p.texto).toContain('¡Tu vehículo está listo para retirar!');
    expect(p.texto).toContain('Listo para retirar');
    const j = (await jsonDe(T.url)).json;
    expect(j.estado).toMatchObject({ clave: 'lista', listo: true });
    expect(j.entrega).toBeNull(); // ya no corresponde mostrar una fecha estimada
    await T.rec.api.post(`/api/ordenes/${T.ot.id}/estado`, { estado: 'entregada' });
    const f = (await jsonDe(T.url)).json;
    expect(f.estado).toMatchObject({ clave: 'entregada', cerrado: true });
    expect(f.recorrido.every((p: any) => p.situacion !== 'pendiente')).toBe(true);
    // Se reabre para el resto de las pruebas
    await T.rec.api.post(`/api/ordenes/${T.ot.id}/estado`, { estado: 'lista' });
    await T.rec.api.post(`/api/ordenes/${T.ot.id}/estado`, { estado: 'en_reparacion' });
  });
});

describe('observaciones públicas', () => {
  it('quien tiene el permiso publica un mensaje; es texto aparte de las notas internas y se ve en la página con la fecha', async () => {
    const r = await T.rec.api.post(`/api/ordenes/${T.ot.id}/seguimiento/mensajes`, { texto: '  Estamos esperando un repuesto solicitado al proveedor.  ' });
    expect(r.status).toBe(201);
    expect(r.body.mensajes).toHaveLength(1);
    expect(r.body.mensajes[0]).toMatchObject({ texto: 'Estamos esperando un repuesto solicitado al proveedor.', vigente: true, retirado_at: null });
    expect(r.body.mensajes[0].usuario).toContain('recepcion');
    const j = (await jsonDe(T.url)).json;
    expect(j.mensaje.texto).toBe('Estamos esperando un repuesto solicitado al proveedor.');
    const p = (await pagina(T.url)).texto;
    expect(p).toContain('Mensaje del taller');
    expect(p).toContain('Estamos esperando un repuesto');
  });

  it('nunca se publica una nota interna ni la nota del cambio de estado', async () => {
    const todo = JSON.stringify((await jsonDe(T.url)).json) + (await pagina(T.url)).texto;
    expect(todo).not.toContain('NOTA-INTERNA-RESERVADA');
    expect(todo).not.toContain('NOTA-DEL-CAMBIO-INTERNA');
    const staff = JSON.stringify((await T.rec.api.get(`/api/ordenes/${T.ot.id}/seguimiento`)).body);
    expect(staff).not.toContain('NOTA-INTERNA-RESERVADA');
    expect(staff).not.toContain('NOTA-DEL-CAMBIO-INTERNA');
  });

  it('un mensaje nuevo reemplaza al anterior en la página y ambos quedan en el historial con su responsable; retirar el último no revive el anterior', async () => {
    const r = await T.a.api.post(`/api/ordenes/${T.ot.id}/seguimiento/mensajes`, { texto: 'El repuesto llegó. Mañana retomamos.\n\n\n\nGracias' });
    expect(r.body.mensajes.map((m: any) => [m.texto.slice(0, 12), m.vigente])).toEqual([['El repuesto ', true], ['Estamos espe', false]]);
    expect(r.body.mensajes[0].texto).toBe('El repuesto llegó. Mañana retomamos.\n\nGracias');
    expect((await jsonDe(T.url)).json.mensaje.texto).toContain('El repuesto llegó');
    const retiro = await T.a.api.del(`/api/ordenes/${T.ot.id}/seguimiento/mensajes/${r.body.mensajes[0].id}`);
    expect(retiro.status).toBe(200);
    expect(retiro.body.mensajes[0]).toMatchObject({ vigente: false });
    expect(retiro.body.mensajes[0].retirado_at).toBeTruthy();
    expect(retiro.body.mensajes[0].retirado_por).toBeTruthy();
    expect((await jsonDe(T.url)).json.mensaje).toBeNull();
    expect((await pagina(T.url)).texto).not.toContain('Mensaje del taller');
    // Retirarlo otra vez es un error claro
    expect((await T.a.api.del(`/api/ordenes/${T.ot.id}/seguimiento/mensajes/${r.body.mensajes[0].id}`)).status).toBe(400);
  });

  it('valida el texto: vacío, demasiado largo o sin cuerpo se rechazan; el HTML se muestra como texto, nunca se interpreta', async () => {
    expect((await T.a.api.post(`/api/ordenes/${T.ot.id}/seguimiento/mensajes`, { texto: '   ' })).status).toBe(400);
    expect((await T.a.api.post(`/api/ordenes/${T.ot.id}/seguimiento/mensajes`, { texto: 'x'.repeat(501) })).status).toBe(400);
    expect((await T.a.api.post(`/api/ordenes/${T.ot.id}/seguimiento/mensajes`, {})).status).toBe(400);
    expect((await T.a.api.post(`/api/ordenes/${T.ot.id}/seguimiento/mensajes`, { texto: 'x'.repeat(500) })).status).toBe(201);
    const r = await T.a.api.post(`/api/ordenes/${T.ot.id}/seguimiento/mensajes`, { texto: 'Pasá por <b>caja</b> <script>alert(1)</script>\u0007' });
    expect(r.status).toBe(201);
    const p = (await pagina(T.url)).texto;
    expect(p).not.toContain('<script>');
    expect(p).not.toContain('<b>caja</b>');
    expect(p).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    await T.a.api.del(`/api/ordenes/${T.ot.id}/seguimiento/mensajes/${r.body.mensajes[0].id}`);
  });

  it('el texto publicado no se puede reescribir ni borrar (historial íntegro) ni siquiera por SQL', async () => {
    const filas: any[] = await consultaLocal(`SELECT id FROM seguimiento_mensajes WHERE orden_id = '${T.ot.id}' LIMIT 1`);
    expect(filas.length).toBeGreaterThan(0);
    const { DatabaseSync } = await import('node:sqlite');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join(process.env.FIERRO_TEST_ESTADO!, 'v3', 'd1', 'miniflare-D1DatabaseObject');
    const db = new DatabaseSync(path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.sqlite'))!));
    try {
      expect(() => db.exec(`UPDATE seguimiento_mensajes SET texto = 'otro' WHERE id = '${filas[0].id}'`)).toThrow(/inmutable/);
    } finally {
      db.close();
    }
  });
});

describe('fecha estimada de entrega', () => {
  it('se reutiliza la fecha prometida de la OT, se presenta como estimación y se puede ocultar', async () => {
    let j = (await jsonDe(T.url)).json;
    expect(j.entrega).toEqual({ fecha: T.fechaPrometida, vencida: false });
    expect((await pagina(T.url)).texto).toContain('Es una estimación');
    const r = await T.a.api.patch(`/api/ordenes/${T.ot.id}/seguimiento`, { mostrar_fecha_estimada: false });
    expect(r.body).toMatchObject({ mostrar_fecha_estimada: false, entrega: null });
    j = (await jsonDe(T.url)).json;
    expect(j.entrega).toBeNull();
    expect((await pagina(T.url)).texto).not.toContain('Fecha estimada');
    await T.a.api.patch(`/api/ordenes/${T.ot.id}/seguimiento`, { mostrar_fecha_estimada: true });
  });

  it('una fecha vencida se advierte y no se presenta como compromiso vigente; sin fecha prometida no se muestra nada', async () => {
    const cli = T.cli;
    const ot = (await T.a.api.post('/api/ordenes', { cliente_id: cli.id, vehiculo_id: T.veh.id, falla_reportada: 'vencida', fecha_prometida: '2020-01-15', items: [] })).body;
    const url = (await T.a.api.post(`/api/ordenes/${ot.id}/seguimiento/activar`)).body.url;
    expect((await jsonDe(url)).json.entrega).toEqual({ fecha: '2020-01-15', vencida: true });
    const p = (await pagina(url)).texto;
    expect(p).toContain('Estaba prevista para el 15/01/2020');
    expect(p).not.toContain('Es una estimación');
    expect((await jsonDe(T.url2)).json.entrega).toBeNull(); // la OT 2 no tiene fecha prometida
  });

  it('no se modifica la planificación de la OT: la fecha prometida sigue igual', async () => {
    const o = (await T.a.api.get(`/api/ordenes/${T.ot.id}`)).body;
    expect(o.fecha_prometida).toBe(T.fechaPrometida);
  });
});

describe('transiciones visibles para el cliente', () => {
  it('el taller oculta una transición interna: desaparece del historial y del recorrido; la del estado actual no se puede ocultar', async () => {
    const st = (await T.a.api.get(`/api/ordenes/${T.ot.id}/seguimiento`)).body;
    const tr = st.transiciones;
    expect(tr[0]).toMatchObject({ es_actual: true, visible: true });
    expect(tr[0]).not.toHaveProperty('nota');
    expect(tr[0]).not.toHaveProperty('usuario');
    const antes = (await jsonDe(T.url)).json.historial.length;
    const espera = tr.find((t: any) => t.estado === 'esperando_repuestos' && !t.es_actual);
    const r = await T.a.api.put(`/api/ordenes/${T.ot.id}/seguimiento/transiciones/${espera.id}`, { visible: false });
    expect(r.status).toBe(200);
    expect(r.body.transiciones.find((t: any) => t.id === espera.id).visible).toBe(false);
    const j = (await jsonDe(T.url)).json;
    expect(j.historial.length).toBe(antes - 1);
    expect(j.historial.map((h: any) => h.titulo)).not.toContain('Esperando repuestos');
    expect(j.recorrido.map((p: any) => p.titulo)).not.toContain('Espera de repuestos');
    // La transición del estado actual se rechaza
    const rechazo = await T.a.api.put(`/api/ordenes/${T.ot.id}/seguimiento/transiciones/${tr[0].id}`, { visible: false });
    expect(rechazo.status).toBe(409);
    expect(rechazo.body.error.code).toBe('transicion_actual');
    // Volver a mostrarla
    await T.a.api.put(`/api/ordenes/${T.ot.id}/seguimiento/transiciones/${espera.id}`, { visible: true });
    expect((await jsonDe(T.url)).json.historial.length).toBe(antes);
    expect((await T.a.api.put(`/api/ordenes/${T.ot.id}/seguimiento/transiciones/no-existe`, { visible: false })).status).toBe(404);
  });
});

describe('5, 6 y 7. enlace para compartir (WhatsApp, QR e impresión)', () => {
  it('quien comparte recibe la dirección completa, lista para armar el mensaje de WhatsApp y el QR; el servidor nunca envía mensajes', async () => {
    const st = (await T.rec.api.get(`/api/ordenes/${T.ot.id}/seguimiento`)).body;
    expect(st.url).toBe(T.url);
    const wa = `https://wa.me/?text=${encodeURIComponent(`Hola, podés consultar el estado de reparación de tu vehículo desde este enlace: ${st.url}`)}`;
    expect(wa).toContain(encodeURIComponent(T.url));
  });

  it('copia del cliente del PDF (QR): requiere seguimiento activo y permisos; no lleva datos del cliente ni internos', async () => {
    const pedir = async (api: Api, id: string) => {
      const r = await fetch(`${BASE}/api/ordenes/${id}/pdf?copia=cliente`, { headers: { cookie: api.cookie, 'cf-connecting-ip': api.ip } });
      const bytes = new Uint8Array(await r.arrayBuffer());
      return { status: r.status, headers: r.headers, texto: Buffer.from(bytes).toString('latin1') };
    };
    const ok = await pedir(T.rec.api, T.ot.id);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('application/pdf');
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.texto).toContain('COPIA PARA EL CLIENTE');
    expect(ok.texto).toContain(tokenDe(T.url)); // la dirección escrita debajo del QR
    for (const x of ['Ñañez', '555-7788', 'FALLA-PRIVADA', 'DIAGNOSTICO-PRIVADO', 'OBSERVACION-PRIVADA', 'NOTA-INTERNA', '87654', '34567']) expect(ok.texto).not.toContain(x);
    // Sin seguimiento activo no hay QR que imprimir (la OT B ni siquiera tiene enlace)
    const cliB = (await T.b.api.get(`/api/ordenes/${T.otB.id}`)).body;
    expect(cliB.id).toBe(T.otB.id);
    expect((await pedir(T.b.api, T.otB.id)).status).toBe(409);
    // Mecánico (puede imprimir su hoja pero no compartir enlaces): 403
    expect((await pedir(T.mec.api, T.ot.id)).status).toBe(403);
    // Las copias de siempre no cambiaron
    const mecanico = await fetch(`${BASE}/api/ordenes/${T.ot.id}/pdf?copia=mecanico`, { headers: { cookie: T.rec.api.cookie, 'cf-connecting-ip': T.rec.api.ip } });
    expect(mecanico.status).toBe(200);
    expect(Buffer.from(await mecanico.arrayBuffer()).toString('latin1')).toContain('COPIA MEC');
  });
});

describe('8. desactivación y regeneración inmediatas', () => {
  it('desactivar apaga el enlace de inmediato (no revela si existió) y reactivar lo vuelve a encender con la misma dirección', async () => {
    const d = await T.rec.api.post(`/api/ordenes/${T.ot.id}/seguimiento/desactivar`);
    expect(d.body).toMatchObject({ activo: false, url: null });
    expect(d.body.desactivado_at).toBeTruthy();
    const p = await pagina(T.url);
    const j = await jsonDe(T.url);
    expect(p.status).toBe(404);
    expect(j.status).toBe(404);
    expect(p.texto).toContain('Este enlace no está disponible');
    expect(p.texto).not.toContain('Taller Seguimiento A');
    const inexistente = await pagina(`x/seguimiento/${'z'.repeat(43)}`);
    expect(inexistente.status).toBe(404);
    expect(inexistente.texto).toBe(p.texto); // misma respuesta: desactivado e inexistente no se distinguen
    const re = await T.rec.api.post(`/api/ordenes/${T.ot.id}/seguimiento/activar`);
    expect(re.body.url).toBe(T.url);
    expect((await pagina(T.url)).status).toBe(200);
  });

  it('regenerar reemplaza el token: el enlace anterior deja de funcionar al instante y el nuevo funciona', async () => {
    const r = await T.rec.api.post(`/api/ordenes/${T.ot.id}/seguimiento/regenerar`);
    expect(r.status).toBe(200);
    expect(r.body.generacion).toBe(2);
    expect(r.body.url).not.toBe(T.url);
    expect((await pagina(T.url)).status).toBe(404);
    expect((await jsonDe(T.url)).status).toBe(404);
    expect((await pagina(r.body.url)).status).toBe(200);
    T.urlVieja = T.url;
    T.url = r.body.url;
    // Después de desactivar, un enlace regenerado ya no se puede (hay que activar primero)
    await T.rec.api.post(`/api/ordenes/${T.ot2.id}/seguimiento/desactivar`);
    const sin = await T.rec.api.post(`/api/ordenes/${T.ot2.id}/seguimiento/regenerar`);
    expect(sin.status).toBe(409);
    await T.rec.api.post(`/api/ordenes/${T.ot2.id}/seguimiento/activar`);
  });

  it('la configuración (mensajes, fecha, transiciones ocultas) sobrevive a regenerar', async () => {
    const st = (await T.rec.api.get(`/api/ordenes/${T.ot.id}/seguimiento`)).body;
    expect(st.mensajes.length).toBeGreaterThan(0);
    expect(st.mostrar_fecha_estimada).toBe(true);
  });
});

describe('9. aislamiento entre talleres', () => {
  it('un taller no ve, activa, publica ni oculta nada de las órdenes de otro: 404 en todo', async () => {
    const st = (await T.a.api.get(`/api/ordenes/${T.ot.id}/seguimiento`)).body;
    const idEvento = st.transiciones[0].id;
    for (const [m, ruta, datos] of [
      ['get', `/api/ordenes/${T.ot.id}/seguimiento`, undefined],
      ['post', `/api/ordenes/${T.ot.id}/seguimiento/activar`, {}],
      ['post', `/api/ordenes/${T.ot.id}/seguimiento/desactivar`, {}],
      ['post', `/api/ordenes/${T.ot.id}/seguimiento/regenerar`, {}],
      ['patch', `/api/ordenes/${T.ot.id}/seguimiento`, { mostrar_fecha_estimada: false }],
      ['post', `/api/ordenes/${T.ot.id}/seguimiento/mensajes`, { texto: 'intruso' }],
      ['put', `/api/ordenes/${T.ot.id}/seguimiento/transiciones/${idEvento}`, { visible: false }],
    ] as const) {
      const r = await (T.b.api as any)[m](ruta, datos);
      expect(r.status, `${m} ${ruta}`).toBe(404);
    }
    // Y nada cambió en el taller dueño
    const despues = (await T.a.api.get(`/api/ordenes/${T.ot.id}/seguimiento`)).body;
    expect(despues.activo).toBe(true);
    expect(despues.mostrar_fecha_estimada).toBe(true);
    expect((await jsonDe(T.url)).json.mensaje?.texto ?? '').not.toContain('intruso');
    expect(despues.transiciones[0].visible).toBe(true);
    // El taller A tampoco toca la orden de B
    expect((await T.a.api.post(`/api/ordenes/${T.otB.id}/seguimiento/activar`)).status).toBe(404);
  });

  it('cada enlace muestra sólo su orden: el de B no trae nada de A y viceversa; un token alterado no abre nada', async () => {
    const urlB = (await T.b.api.post(`/api/ordenes/${T.otB.id}/seguimiento/activar`)).body.url;
    const b = (await jsonDe(urlB)).json;
    expect(b.taller.nombre).toBe('Taller Seguimiento B');
    expect(b.vehiculo.patente).toBe('SE•••9');
    expect(JSON.stringify(b)).not.toContain('Taller Seguimiento A');
    const a = (await jsonDe(T.url)).json;
    expect(a.taller.nombre).toBe('Taller Seguimiento A');
    expect(JSON.stringify(a)).not.toContain('Taller Seguimiento B');
    // Alterar un carácter, truncar, ampliar o usar el número de la orden
    const tok = tokenDe(T.url);
    const alterado = tok.slice(0, -1) + (tok.endsWith('A') ? 'B' : 'A');
    for (const t of [alterado, tok.slice(0, 42), `${tok}x`, String(T.ot.numero), T.ot.id, '..%2F..%2Fapi%2Fsalud', '%00', `${tok}%20`]) {
      expect((await anonimo(`/seguimiento/${t}`)).status, t).toBe(404);
      expect((await anonimo(`/api/seguimiento/${t}`)).status, t).toBe(404);
    }
    // Tampoco con parámetros que intenten elegir otra orden o taller
    const conParametros = await anonimo(`/api/seguimiento/${tokenDe(urlB)}?orden=${T.ot.id}&taller=${T.a.tallerId}&id=${T.ot.id}`);
    expect(conParametros.json.taller.nombre).toBe('Taller Seguimiento B');
  });
});

describe('10. ausencia de datos privados y financieros', () => {
  it('ni la página ni el JSON traen cliente, teléfono, dirección, precios, notas, diagnósticos, kilometraje, mecánico ni identificadores', async () => {
    const p = (await pagina(T.url)).texto;
    const j = JSON.stringify((await jsonDe(T.url)).json);
    const prohibidos = [
      'Rosario', 'Ñañez', '555-7788', 'Calle Falsa', 'FALLA-PRIVADA', 'DIAGNOSTICO-PRIVADO', 'OBSERVACION-PRIVADA', 'NOTA-INTERNA-RESERVADA', 'NOTA-DEL-CAMBIO-INTERNA',
      'SEG123', '98765', '98.765', '8765432', '87654', '3456789', 'pastillas', 'Alineación', T.ot.id, T.a.tallerId, T.cli.id, T.veh.id, T.mecId, T.rec.id, 'recepcion',
    ];
    for (const x of prohibidos) {
      expect(p, `HTML: ${x}`).not.toContain(x);
      expect(j, `JSON: ${x}`).not.toContain(x);
    }
    expect(p.toLowerCase()).not.toMatch(/\bprecio|\btotal\b|\bcosto|margen|\bcuit|\bfoto|firma/);
  });

  it('el JSON tiene exactamente los campos previstos (ningún campo privado oculto)', async () => {
    const j = (await jsonDe(T.url)).json;
    expect(Object.keys(j).sort()).toEqual(['actualizado_at', 'entrega', 'estado', 'historial', 'mensaje', 'orden', 'recorrido', 'taller', 'vehiculo', 'zona_horaria']);
    expect(Object.keys(j.vehiculo).sort()).toEqual(['marca', 'modelo', 'patente']);
    expect(Object.keys(j.orden)).toEqual(['referencia']);
    expect(Object.keys(j.taller)).toEqual(['nombre']);
    for (const h of j.historial) expect(Object.keys(h).sort()).toEqual(['at', 'titulo']);
    for (const p of j.recorrido) expect(Object.keys(p).sort()).toEqual(['at', 'detalle', 'situacion', 'titulo']);
  });

  it('las respuestas del taller sobre el seguimiento tampoco traen precios ni datos del cliente', async () => {
    const s = JSON.stringify((await T.rec.api.get(`/api/ordenes/${T.ot.id}/seguimiento`)).body);
    for (const x of ['Ñañez', '555-7788', '8765432', 'precio', 'total', 'costo', 'NOTA-INTERNA', 'DIAGNOSTICO-PRIVADO']) expect(s).not.toContain(x);
  });
});

describe('cabeceras y seguridad de las respuestas públicas', () => {
  it('sin caché, sin indexación, sin Referer, sin marcos y con política de contenido cerrada', async () => {
    for (const r of [await pagina(T.url), await jsonDe(T.url), await pagina(T.urlVieja), await anonimo(`/seguimiento/${'q'.repeat(43)}`)]) {
      expect(r.headers.get('cache-control')).toMatch(/no-store/);
      expect(r.headers.get('cache-control')).toMatch(/private/);
      expect(r.headers.get('x-robots-tag')).toMatch(/noindex/);
      expect(r.headers.get('x-robots-tag')).toMatch(/nofollow/);
      expect(r.headers.get('referrer-policy')).toBe('no-referrer');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('set-cookie')).toBeNull();
    }
    const h = await pagina(T.url);
    expect(h.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(h.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(h.headers.get('x-frame-options')).toBe('DENY');
    expect(h.texto).toContain('noindex');
  });

  it('una ruta desconocida bajo /seguimiento/ no cae en la aplicación: misma página de enlace no disponible', async () => {
    const r = await anonimo('/seguimiento/uno/dos');
    expect(r.status).toBe(404);
    expect(r.texto).toContain('Este enlace no está disponible');
  });

  it('el token no queda en los registros de la plataforma ni en la auditoría', async () => {
    await dormir(300);
    const tok = tokenDe(T.url);
    const tokV = tokenDe(T.urlVieja);
    const aud: any[] = await consultaLocal(`SELECT detalle, entidad_id FROM auditoria WHERE accion LIKE 'seguimiento%'`);
    expect(aud.length).toBeGreaterThan(5);
    const todo = JSON.stringify(aud) + JSON.stringify(await consultaLocal('SELECT * FROM errores_worker')) + JSON.stringify(await consultaLocal('SELECT * FROM limites_intentos'));
    expect(todo).not.toContain(tok);
    expect(todo).not.toContain(tokV);
  });
});

describe('límite de intentos', () => {
  it('quien prueba enlaces al azar se bloquea (429) sin afectar a otros visitantes; los accesos válidos no cuentan', async () => {
    const ip = ipNueva();
    // Muchos accesos válidos desde el mismo origen no se bloquean
    for (let i = 0; i < 30; i++) expect((await pagina(T.url, ip)).status).toBe(200);
    // Intentos con tokens inexistentes: se bloquea al llegar al máximo
    let ultimo = 0;
    for (let i = 0; i < 25; i++) ultimo = (await anonimo(`/seguimiento/${String(i).padStart(43, 'k')}`, ip)).status;
    expect(ultimo).toBe(429);
    // Ya bloqueado, tampoco abre ni siquiera un enlace válido, ni el JSON
    const bloq = await pagina(T.url, ip);
    expect(bloq.status).toBe(429);
    expect(bloq.texto).toContain('Demasiados intentos');
    expect((await jsonDe(T.url, ip)).status).toBe(429);
    // Otro visitante sigue entrando
    expect((await pagina(T.url)).status).toBe(200);
  });
});

describe('permisos', () => {
  it('sin permisos no se consulta ni se opera: depósito y caja 403; el mecánico (sin permisos de seguimiento) tampoco', async () => {
    for (const u of [T.dep.api, T.caja.api, T.mec.api]) {
      expect((await u.get(`/api/ordenes/${T.ot.id}/seguimiento`)).status).toBe(403);
      expect((await u.post(`/api/ordenes/${T.ot.id}/seguimiento/activar`)).status).toBe(403);
      expect((await u.post(`/api/ordenes/${T.ot.id}/seguimiento/mensajes`, { texto: 'x' })).status).toBe(403);
    }
    expect((await Api.login(T.a.email, 'clave-segura-1')).cookie).toBeTruthy();
    const anon = await anonimo(`/api/ordenes/${T.ot.id}/seguimiento`);
    expect(anon.status).toBe(401);
  });

  it('permisos granulares: consultar no entrega el enlace; compartir lo entrega; gestionar, compartir y mensajes son independientes; rige de inmediato', async () => {
    const ver = ['seguimiento.ver'];
    const base = (await T.a.api.get(`/api/taller/usuarios/${T.mec.id}`)).body.permisos as string[];
    const poner = (extra: string[]) => T.a.api.put(`/api/taller/usuarios/${T.mec.id}/permisos`, { permisos: [...base, ...extra] });
    // El mecánico asignado a la OT, sólo con "consultar"
    expect([200, 204]).toContain((await poner(ver)).status);
    const consulta = await T.mec.api.get(`/api/ordenes/${T.ot.id}/seguimiento`);
    expect(consulta.status).toBe(200);
    expect(consulta.body.activo).toBe(true);
    expect(consulta.body.url).toBeNull(); // no incluye el enlace
    expect((await T.mec.api.post(`/api/ordenes/${T.ot.id}/seguimiento/desactivar`)).status).toBe(403);
    expect((await T.mec.api.post(`/api/ordenes/${T.ot.id}/seguimiento/mensajes`, { texto: 'x' })).status).toBe(403);
    // Con "compartir" recibe el enlace
    await poner([...ver, 'seguimiento.compartir']);
    expect((await T.mec.api.get(`/api/ordenes/${T.ot.id}/seguimiento`)).body.url).toBe(T.url);
    expect((await T.mec.api.post(`/api/ordenes/${T.ot.id}/seguimiento/desactivar`)).status).toBe(403);
    // Con "mensajes" publica pero no gestiona
    await poner([...ver, 'seguimiento.mensajes']);
    const m = await T.mec.api.post(`/api/ordenes/${T.ot.id}/seguimiento/mensajes`, { texto: 'Mensaje del mecánico autorizado' });
    expect(m.status).toBe(201);
    expect(m.body.url).toBeNull();
    expect((await T.mec.api.post(`/api/ordenes/${T.ot.id}/seguimiento/regenerar`)).status).toBe(403);
    // La orden de otro mecánico no es accesible aunque tenga todos los permisos
    await poner([...ver, 'seguimiento.gestionar', 'seguimiento.compartir', 'seguimiento.mensajes']);
    expect((await T.mec.api.get(`/api/ordenes/${T.ot2.id}/seguimiento`)).status).toBe(404);
    expect((await T.mec.api.post(`/api/ordenes/${T.ot2.id}/seguimiento/activar`)).status).toBe(404);
    // Quitar todo rige de inmediato
    await T.a.api.put(`/api/taller/usuarios/${T.mec.id}/permisos`, { permisos: base });
    expect((await T.mec.api.get(`/api/ordenes/${T.ot.id}/seguimiento`)).status).toBe(403);
    await T.a.api.del(`/api/ordenes/${T.ot.id}/seguimiento/mensajes/${m.body.mensajes[0].id}`);
  });

  it('recepción y el propietario tienen los cuatro permisos; las plantillas sin atención al cliente, ninguno', async () => {
    const rec = (await T.a.api.get(`/api/taller/usuarios/${T.rec.id}`)).body.permisos as string[];
    for (const p of ['seguimiento.ver', 'seguimiento.gestionar', 'seguimiento.compartir', 'seguimiento.mensajes']) expect(rec).toContain(p);
    for (const u of [T.mec, T.dep, T.caja]) expect(((await T.a.api.get(`/api/taller/usuarios/${u.id}`)).body.permisos as string[]).some((p) => p.startsWith('seguimiento.'))).toBe(false);
  });
});

describe('auditoría', () => {
  it('activar, desactivar, regenerar, publicar y retirar mensajes y ocultar transiciones quedan registrados con quién y qué orden', async () => {
    let acciones: string[] = [];
    for (let i = 0; i < 20; i++) {
      await dormir(100);
      const filas: any[] = await consultaLocal(`SELECT DISTINCT accion FROM auditoria WHERE entidad_id = '${T.ot.id}' AND accion LIKE 'seguimiento%'`);
      acciones = filas.map((f) => f.accion);
      if (acciones.length >= 8) break;
    }
    for (const a of ['seguimiento_activado', 'seguimiento_desactivado', 'seguimiento_regenerado', 'seguimiento_mensaje', 'seguimiento_mensaje_retirado', 'seguimiento_config', 'seguimiento_transicion_oculta', 'seguimiento_transicion_visible']) expect(acciones).toContain(a);
  });
});
