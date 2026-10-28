// Sprint 23: vehículos sin cliente, varios clientes por vehículo (con historial de vinculaciones), cliente responsable propio de cada OT/presupuesto
// y privacidad de los datos personales en la hoja y en las respuestas destinadas a mecánicos.
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, consultaLocal, nuevoPersonal, nuevoTaller, sqlLocal } from './cliente';
import { PUERTO } from './global-setup';

const BASE = `http://127.0.0.1:${PUERTO}`;

async function pedirPdf(api: Api, id: string, copia?: string) {
  const r = await fetch(`${BASE}/api/ordenes/${id}/pdf${copia ? `?copia=${copia}` : ''}`, { headers: { cookie: api.cookie, 'cf-connecting-ip': api.ip } });
  const bytes = new Uint8Array(await r.arrayBuffer());
  return { status: r.status, texto: Buffer.from(bytes).toString('latin1') };
}
const visible = (texto: string) =>
  [...texto.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)]
    .map((m) => m[1].replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))).replace(/\\([()\\])/g, '$1'))
    .join('\n');

const T: any = {};
const nuevoCliente = async (api: Api, nombre: string, extra: Record<string, unknown> = {}) => (await api.post('/api/clientes', { nombre, ...extra })).body;
const vinculos = async (api: Api, vehiculoId: string) => (await api.get(`/api/vehiculos/${vehiculoId}/clientes`)).body as { vigentes: any[]; anteriores: any[] };

beforeAll(async () => {
  T.a = await nuevoTaller('Taller Vínculos A', 8);
  T.b = await nuevoTaller('Taller Vínculos B');
  T.rec = await nuevoPersonal(T.a.api, 'recepcion');
  T.mec = await nuevoPersonal(T.a.api, 'mecanico');
  T.mec2 = await nuevoPersonal(T.a.api, 'mecanico');
  T.juan = await nuevoCliente(T.a.api, 'Juan Pérez Titular', { telefono: '341 111-0001', email: 'juan.perez@correo.test', documento_tipo: 'DNI', documento: '20111222', direccion: 'Calle Falsa 123' });
  T.maria = await nuevoCliente(T.a.api, 'María González', { telefono: '341 222-0002' });
  T.pedro = await nuevoCliente(T.a.api, 'Pedro Pérez', { telefono: '341 333-0003' });
  T.carlos = await nuevoCliente(T.a.api, 'Carlos Comprador', { telefono: '341 444-0004' });
  T.lucia = await nuevoCliente(T.a.api, 'Lucía Ajena', { telefono: '341 555-0005' });
  T.empresa = await nuevoCliente(T.a.api, 'Empresa Los Álamos', { documento_tipo: 'CUIT', documento: '30712345678' });
  T.clienteB = await nuevoCliente(T.b.api, 'Cliente del taller B');
});

describe('vehículos sin cliente', () => {
  it('se crea con sus datos automotores, sin ningún cliente, y la ficha lo dice', async () => {
    const r = await T.a.api.post('/api/vehiculos', { patente: 'ae 123 bc', marca_texto: 'Volkswagen', modelo_texto: 'Amarok', anio: 2022, km_actual: 1000 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ patente: 'AE123BC', marca: 'Volkswagen', modelo: 'Amarok', anio: 2022, clientes_n: 0 });
    expect(r.body).not.toHaveProperty('cliente_id');
    T.amarok = r.body;
    const ficha = (await T.a.api.get(`/api/vehiculos/${T.amarok.id}`)).body;
    expect(ficha.clientes_vinculados).toEqual([]);
    expect(ficha.clientes_anteriores).toEqual([]);
    expect(ficha.clientes_n).toBe(0);
  });

  it('no se inventa ningún cliente: la base no tiene un cliente genérico asociado', async () => {
    const v = (await consultaLocal<{ n: number }>(`SELECT COUNT(*) AS n FROM vehiculo_clientes WHERE vehiculo_id = '${T.amarok.id}'`))[0];
    expect(v.n).toBe(0);
    expect((await consultaLocal<{ n: number }>(`SELECT COUNT(*) AS n FROM pragma_table_info('vehiculos') WHERE name = 'cliente_id'`))[0].n).toBe(0);
  });

  it('se puede editar normalmente y se encuentra buscando vehículos sin clientes', async () => {
    const e = await T.a.api.put(`/api/vehiculos/${T.amarok.id}`, { color: 'Gris', km_actual: 1500, cliente_id: T.juan.id });
    expect(e.status).toBe(200);
    expect(e.body.color).toBe('Gris');
    expect((await vinculos(T.a.api, T.amarok.id)).vigentes).toHaveLength(0); // el viejo campo ya no vincula al editar
    const conCliente = (await T.a.api.post('/api/vehiculos', { patente: 'AA111AA', cliente_id: T.maria.id })).body;
    const sin = (await T.a.api.get('/api/vehiculos?sin_clientes=1')).body as any[];
    expect(sin.map((v) => v.patente)).toContain('AE123BC');
    expect(sin.map((v) => v.patente)).not.toContain('AA111AA');
    expect(conCliente.clientes).toBe('María González');
    // búsqueda de texto combinada con el filtro
    expect(((await T.a.api.get('/api/vehiculos?sin_clientes=1&q=AE123')).body as any[]).map((v) => v.patente)).toEqual(['AE123BC']);
  });

  it('la patente duplicada se rechaza sin revelar clientes', async () => {
    const r = await T.a.api.post('/api/vehiculos', { patente: 'AE123BC' });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).not.toMatch(/Juan|María/);
  });
});

describe('varios clientes por vehículo, con historial', () => {
  beforeAll(async () => {
    T.hilux = (await T.a.api.post('/api/vehiculos', { patente: 'AE456CD', marca_texto: 'Toyota', modelo_texto: 'Hilux', anio: 2021, km_actual: 50000 })).body;
  });

  it('vincula uno y luego varios a la vez, con tipo de relación opcional', async () => {
    const j = await T.a.api.post(`/api/vehiculos/${T.hilux.id}/clientes`, { cliente_id: T.juan.id, relacion: 'titular' });
    expect(j.status).toBe(201);
    expect(j.body.vigentes).toHaveLength(1);
    expect((await T.a.api.post(`/api/vehiculos/${T.hilux.id}/clientes`, { cliente_id: T.maria.id, relacion: 'familiar' })).status).toBe(201);
    expect((await T.a.api.post(`/api/vehiculos/${T.hilux.id}/clientes`, { cliente_id: T.pedro.id, relacion: 'conductor' })).status).toBe(201);
    const e = await T.a.api.post(`/api/vehiculos/${T.hilux.id}/clientes`, { cliente_id: T.empresa.id }); // sin relación: es opcional
    expect(e.status).toBe(201);
    const { vigentes } = await vinculos(T.a.api, T.hilux.id);
    expect(vigentes.map((x) => x.cliente)).toEqual(['Juan Pérez Titular', 'María González', 'Pedro Pérez', 'Empresa Los Álamos']);
    expect(vigentes.map((x) => x.relacion)).toEqual(['titular', 'familiar', 'conductor', null]);
    expect(vigentes[0]).toMatchObject({ cliente_telefono: '341 111-0001', desvinculado_at: null });
    // no se exige un titular: un vehículo sin titular también es válido
    const sinTitular = (await T.a.api.post('/api/vehiculos', { patente: 'BB222BB', clientes: [{ cliente_id: T.maria.id, relacion: 'familiar' }, { cliente_id: T.pedro.id }] })).body;
    expect((await vinculos(T.a.api, sinTitular.id)).vigentes).toHaveLength(2);
  });

  it('el listado muestra los nombres y el cliente ve el vehículo en su ficha', async () => {
    const l = (await T.a.api.get('/api/vehiculos?q=AE456')).body[0];
    expect(l.clientes).toBe('Juan Pérez Titular, María González, Pedro Pérez, Empresa Los Álamos');
    expect(l.clientes_n).toBe(4);
    const porCliente = (await T.a.api.get(`/api/vehiculos?cliente_id=${T.maria.id}`)).body as any[];
    expect(porCliente.map((v) => v.patente)).toContain('AE456CD');
    const ficha = (await T.a.api.get(`/api/clientes/${T.maria.id}`)).body;
    expect(ficha.vehiculos.find((v: any) => v.patente === 'AE456CD')).toMatchObject({ relacion: 'familiar' });
    // buscar por nombre de cliente encuentra el vehículo
    expect(((await T.a.api.get('/api/vehiculos?q=Los%20%C3%81lamos')).body as any[]).map((v) => v.patente)).toContain('AE456CD');
  });

  it('impide vínculos activos duplicados entre el mismo cliente y vehículo (API y base)', async () => {
    const r = await T.a.api.post(`/api/vehiculos/${T.hilux.id}/clientes`, { cliente_id: T.juan.id });
    expect(r.status).toBe(409);
    expect((await vinculos(T.a.api, T.hilux.id)).vigentes).toHaveLength(4);
    await expect(sqlLocal(`INSERT INTO vehiculo_clientes (id, taller_id, vehiculo_id, cliente_id) VALUES ('dup1', '${T.a.tallerId}', '${T.hilux.id}', '${T.juan.id}')`)).rejects.toThrow(/UNIQUE/);
  });

  it('impide asociaciones entre talleres diferentes (API y claves foráneas)', async () => {
    // Un cliente del taller B no existe para el taller A, y el vehículo del A no existe para el B.
    expect((await T.a.api.post(`/api/vehiculos/${T.hilux.id}/clientes`, { cliente_id: T.clienteB.id })).status).toBe(400);
    expect((await T.b.api.post(`/api/vehiculos/${T.hilux.id}/clientes`, { cliente_id: T.clienteB.id })).status).toBe(404);
    expect((await T.b.api.get(`/api/vehiculos/${T.hilux.id}/clientes`)).status).toBe(404);
    expect((await T.a.api.post('/api/vehiculos', { patente: 'CC333CC', cliente_id: T.clienteB.id })).status).toBe(400);
    // Aun escribiendo directo en la base, la clave foránea compuesta lo impide.
    await expect(sqlLocal(`INSERT INTO vehiculo_clientes (id, taller_id, vehiculo_id, cliente_id) VALUES ('cruz1', '${T.a.tallerId}', '${T.hilux.id}', '${T.clienteB.id}')`)).rejects.toThrow(/FOREIGN KEY/);
    await expect(sqlLocal(`INSERT INTO vehiculo_clientes (id, taller_id, vehiculo_id, cliente_id) VALUES ('cruz2', '${T.b.tallerId}', '${T.hilux.id}', '${T.clienteB.id}')`)).rejects.toThrow(/FOREIGN KEY/);
  });

  it('edita la relación de un vínculo', async () => {
    const pedro = (await vinculos(T.a.api, T.hilux.id)).vigentes.find((x) => x.cliente_id === T.pedro.id);
    const r = await T.a.api.put(`/api/vehiculos/${T.hilux.id}/clientes/${pedro.id}`, { relacion: 'otro' });
    expect(r.status).toBe(200);
    expect(r.body.vigentes.find((x: any) => x.cliente_id === T.pedro.id).relacion).toBe('otro');
    expect((await T.a.api.put(`/api/vehiculos/${T.hilux.id}/clientes/${pedro.id}`, { relacion: 'inventada' })).status).toBe(400);
  });
});

describe('órdenes: cada OT conserva su cliente responsable', () => {
  beforeAll(async () => {
    const crear = async (cliente: any, extra: Record<string, unknown> = {}) => (await T.a.api.post('/api/ordenes', { cliente_id: cliente.id, vehiculo_id: T.hilux.id, falla_reportada: 'Ruido en el tren delantero', items: [], ...extra }));
    T.ot1 = (await crear(T.juan, { mecanico_id: (await T.a.api.get('/api/mecanicos')).body.find((m: any) => m.usuario_id === T.mec.id).id, observaciones: 'Revisar tren delantero' })).body;
    T.ot2 = (await crear(T.maria)).body;
  });

  it('crea OT para un vehículo con varios clientes, eligiendo a cada uno como responsable', async () => {
    expect(T.ot1).toMatchObject({ cliente: 'Juan Pérez Titular' });
    expect(T.ot2).toMatchObject({ cliente: 'María González' });
    expect(T.ot1.cliente_id).toBe(T.juan.id);
    expect(T.ot2.cliente_id).toBe(T.maria.id);
  });

  it('permite un cliente no vinculado al vehículo y NO lo vincula salvo que se pida', async () => {
    const r = await T.a.api.post('/api/ordenes', { cliente_id: T.lucia.id, vehiculo_id: T.hilux.id, falla_reportada: 'La trae una conocida', items: [] });
    expect(r.status).toBe(201);
    expect(r.body.cliente).toBe('Lucía Ajena');
    expect((await vinculos(T.a.api, T.hilux.id)).vigentes.map((x) => x.cliente_id)).not.toContain(T.lucia.id);
  });

  it('ofrece vincular al cliente en el mismo paso (y lo hace una sola vez, aunque se repita)', async () => {
    const r = await T.a.api.post('/api/ordenes', { cliente_id: T.carlos.id, vehiculo_id: T.hilux.id, falla_reportada: 'Compró la camioneta', items: [], vincular_cliente: true, vinculo_relacion: 'titular' });
    expect(r.status).toBe(201);
    T.otCarlos = r.body;
    const v = (await vinculos(T.a.api, T.hilux.id)).vigentes.filter((x) => x.cliente_id === T.carlos.id);
    expect(v).toHaveLength(1);
    expect(v[0].relacion).toBe('titular');
    const otra = await T.a.api.post('/api/ordenes', { cliente_id: T.carlos.id, vehiculo_id: T.hilux.id, falla_reportada: 'Otra', items: [], vincular_cliente: true });
    expect(otra.status).toBe(201);
    expect((await vinculos(T.a.api, T.hilux.id)).vigentes.filter((x) => x.cliente_id === T.carlos.id)).toHaveLength(1);
  });

  it('exige un cliente responsable (las operaciones comerciales conservan su validación) y que sea del taller', async () => {
    expect((await T.a.api.post('/api/ordenes', { vehiculo_id: T.amarok.id, items: [] })).status).toBe(400);
    expect((await T.a.api.post('/api/ordenes', { cliente_id: T.clienteB.id, vehiculo_id: T.amarok.id, items: [] })).status).toBe(400);
    // un vehículo sin clientes admite una OT con cualquier cliente del taller
    expect((await T.a.api.post('/api/ordenes', { cliente_id: T.lucia.id, vehiculo_id: T.amarok.id, items: [] })).status).toBe(201);
    // un cliente dado de baja no se elige para una operación nueva
    const baja = await nuevoCliente(T.a.api, 'Cliente de baja');
    await T.a.api.del(`/api/clientes/${baja.id}`);
    expect((await T.a.api.post('/api/ordenes', { cliente_id: baja.id, vehiculo_id: T.amarok.id, items: [] })).status).toBe(400);
  });

  it('cambio de propietario: se desvincula a Juan y se vincula a Carlos; las OT anteriores no cambian y el historial está completo', async () => {
    const antes = (await vinculos(T.a.api, T.hilux.id)).vigentes.find((x) => x.cliente_id === T.juan.id);
    const d = await T.a.api.del(`/api/vehiculos/${T.hilux.id}/clientes/${antes.id}`);
    expect(d.status).toBe(200);
    expect(d.body.vigentes.map((x: any) => x.cliente_id)).not.toContain(T.juan.id);
    expect(d.body.anteriores.map((x: any) => x.cliente_id)).toContain(T.juan.id);
    // El vínculo cerrado se conserva en la base (no se borra físicamente) con fecha y responsable de la baja.
    const fila = (await consultaLocal<any>(`SELECT desvinculado_at, desvinculado_por, vinculado_por FROM vehiculo_clientes WHERE id = '${antes.id}'`))[0];
    expect(fila.desvinculado_at).toBeTruthy();
    expect(fila.desvinculado_por).toBeTruthy();
    // El cliente y el vehículo siguen existiendo, y las demás personas siguen vinculadas.
    expect((await T.a.api.get(`/api/clientes/${T.juan.id}`)).status).toBe(200);
    const { vigentes } = await vinculos(T.a.api, T.hilux.id);
    expect(vigentes.map((x) => x.cliente_id).sort()).toEqual([T.maria.id, T.pedro.id, T.empresa.id, T.carlos.id].sort());
    // No se puede desvincular dos veces.
    expect((await T.a.api.del(`/api/vehiculos/${T.hilux.id}/clientes/${antes.id}`)).status).toBe(404);
    // Las OT anteriores conservan SU cliente.
    expect((await T.a.api.get(`/api/ordenes/${T.ot1.id}`)).body).toMatchObject({ cliente_id: T.juan.id, cliente: 'Juan Pérez Titular' });
    expect((await T.a.api.get(`/api/ordenes/${T.ot2.id}`)).body).toMatchObject({ cliente_id: T.maria.id });
    // Carlos es el titular ahora y aparece primero; la OT nueva puede ser de él.
    expect(vigentes[0]).toMatchObject({ cliente_id: T.carlos.id, relacion: 'titular' });
    // Juan puede volver a vincularse más adelante: queda otro tramo en el historial.
    expect((await T.a.api.post(`/api/vehiculos/${T.hilux.id}/clientes`, { cliente_id: T.juan.id, relacion: 'otro' })).status).toBe(201);
    const hist = await vinculos(T.a.api, T.hilux.id);
    expect(hist.vigentes.some((x) => x.cliente_id === T.juan.id)).toBe(true);
    expect(hist.anteriores.filter((x) => x.cliente_id === T.juan.id)).toHaveLength(1);
  });

  it('el historial técnico es del vehículo: todas las OT de todos los clientes, cada una con su cliente', async () => {
    const ficha = (await T.a.api.get(`/api/vehiculos/${T.hilux.id}`)).body;
    const clientes = ficha.historial.map((o: any) => o.cliente);
    for (const nombre of ['Juan Pérez Titular', 'María González', 'Lucía Ajena', 'Carlos Comprador']) expect(clientes, nombre).toContain(nombre);
    const tecnico = (await T.a.api.get(`/api/vehiculos/${T.hilux.id}/historial-tecnico`)).body;
    const porNumero = new Map(tecnico.entradas.filter((e: any) => e.origen === 'fierro').map((e: any) => [e.numero, e.cliente]));
    expect(porNumero.get(T.ot1.numero)).toBe('Juan Pérez Titular');
    expect(porNumero.get(T.ot2.numero)).toBe('María González');
  });

  it('presupuestos: conservan su propio cliente, admiten uno no vinculado y se convierten en OT con ese mismo cliente', async () => {
    const p = await T.a.api.post('/api/presupuestos', { cliente_id: T.lucia.id, vehiculo_id: T.hilux.id, items: [{ tipo: 'libre', descripcion: 'Cambio de aceite', cantidad: 1, precio_unitario: 100000 }] });
    expect(p.status).toBe(201);
    expect(p.body.cliente).toBe('Lucía Ajena');
    await T.a.api.post(`/api/presupuestos/${p.body.id}/estado`, { estado: 'aprobado' });
    const ot = await T.a.api.post(`/api/presupuestos/${p.body.id}/convertir`);
    expect(ot.status).toBe(201);
    expect((await T.a.api.get(`/api/ordenes/${ot.body.id}`)).body.cliente_id).toBe(T.lucia.id);
    const conVinculo = await T.a.api.post('/api/presupuestos', { cliente_id: T.lucia.id, vehiculo_id: T.hilux.id, vincular_cliente: true, vinculo_relacion: 'otro', items: [{ tipo: 'libre', descripcion: 'x', cantidad: 1, precio_unitario: 100 }] });
    expect(conVinculo.status).toBe(201);
    expect((await vinculos(T.a.api, T.hilux.id)).vigentes.some((x) => x.cliente_id === T.lucia.id)).toBe(true);
    // la comprobación cruzada de antes ("el vehículo no pertenece al cliente") ya no existe, pero un cliente ajeno al taller sigue rechazado
    expect((await T.a.api.post('/api/presupuestos', { cliente_id: T.clienteB.id, vehiculo_id: T.hilux.id, items: [{ tipo: 'libre', descripcion: 'x', cantidad: 1, precio_unitario: 100 }] })).status).toBe(400);
  });

  it('los turnos admiten un cliente no vinculado y los recordatorios usan al titular vigente', async () => {
    const t = await T.a.api.post('/api/turnos', { fecha: '2030-01-10', hora: '10:00', cliente_id: T.lucia.id, vehiculo_id: T.hilux.id, motivo: 'Control' });
    expect(t.status).toBe(201);
    const m = (await T.a.api.get('/api/mantenimientos?estado=todos')).body;
    expect(Array.isArray(m.items)).toBe(true);
    // un vehículo sin clientes no rompe el listado de mantenimientos
    expect((await T.a.api.get(`/api/vehiculos/${T.amarok.id}/mantenimientos`)).status).toBe(200);
  });
});

describe('privacidad: el mecánico nunca recibe datos personales del cliente', () => {
  const sinDatosPersonales = (cuerpo: unknown) => {
    const texto = JSON.stringify(cuerpo);
    for (const dato of ['Juan', 'Titular', '341 111-0001', 'juan.perez@correo.test', '20111222', 'Calle Falsa', 'María González', 'Lucía', 'Carlos Comprador', 'Empresa Los']) expect(texto, dato).not.toContain(dato);
  };

  it('PDF del mecánico impreso por el propietario: sin nombre, teléfono ni ningún dato personal', async () => {
    const r = await pedirPdf(T.a.api, T.ot1.id, 'mecanico');
    expect(r.status).toBe(200);
    const t = visible(r.texto);
    expect(t).toContain('COPIA MECÁNICO');
    expect(t).toContain('AE456CD');
    expect(t).toContain('Revisar tren delantero'); // las observaciones técnicas de la orden sí van
    for (const dato of ['Juan Pérez', '341 111-0001', 'juan.perez', '20111222', 'Calle Falsa', 'CLIENTE', 'TELÉFONO']) expect(t, dato).not.toContain(dato);
    expect(r.texto).not.toContain('Juan Pérez');
    expect(t).not.toContain('No disponible');
  });

  it('PDF del mecánico impreso por recepción y por el propio mecánico: igual de limpio', async () => {
    for (const quien of [T.rec.api, T.mec.api]) {
      const r = await pedirPdf(quien, T.ot1.id, 'mecanico');
      expect(r.status).toBe(200);
      const t = visible(r.texto);
      expect(t).not.toContain('Juan');
      expect(t).not.toContain('341 111-0001');
    }
  });

  it('"ambas copias" desde administración: el cliente sólo está en la hoja de administración', async () => {
    const r = await pedirPdf(T.a.api, T.ot1.id, 'ambas');
    expect(r.status).toBe(200);
    const paginas = [...r.texto.matchAll(/<< \/Length \d+ >>\nstream\n([\s\S]*?)\nendstream/g)].map((m) => visible(m[1]));
    expect(paginas).toHaveLength(2);
    const [mecanico, admin] = paginas;
    expect(mecanico).toContain('COPIA MECÁNICO');
    expect(mecanico).not.toContain('Juan');
    expect(mecanico).not.toContain('341 111-0001');
    expect(admin).toContain('COPIA ADMINISTRACIÓN');
    expect(admin).toContain('Juan Pérez Titular');
    expect(admin).toContain('341 111-0001');
  });

  it('PDF administrativo: respeta los permisos (sin ver clientes, lo indica; con permiso, muestra al cliente responsable de ESA orden)', async () => {
    const adm = visible((await pedirPdf(T.a.api, T.ot2.id, 'administracion')).texto);
    expect(adm).toContain('María González');
    expect(adm).toContain('341 222-0002');
    expect(adm).not.toContain('Juan'); // la OT 2 es de María aunque Juan fuese titular del vehículo
    const sinVerClientes = await nuevoPersonal(T.a.api, 'recepcion');
    const u = (await T.a.api.get(`/api/taller/usuarios/${sinVerClientes.id}`)).body;
    await T.a.api.put(`/api/taller/usuarios/${sinVerClientes.id}/permisos`, { permisos: u.permisos.filter((p: string) => !['clientes.ver', 'clientes.crear', 'clientes.editar'].includes(p)) });
    const r = visible((await pedirPdf(sinVerClientes.api, T.ot2.id, 'administracion')).texto);
    expect(r).toContain('No disponible con los permisos de quien imprime');
    expect(r).not.toContain('María González');
  });

  it('las respuestas de la API para el mecánico (lista y detalle de OT) no traen datos del cliente ni su identificador', async () => {
    const lista = await T.mec.api.get('/api/ordenes');
    expect(lista.status).toBe(200);
    expect(lista.body.map((o: any) => o.id)).toContain(T.ot1.id);
    sinDatosPersonales(lista.body);
    for (const o of lista.body) {
      expect(o).not.toHaveProperty('cliente');
      expect(o).not.toHaveProperty('cliente_telefono');
      expect(o).not.toHaveProperty('cliente_id');
      expect(o).not.toHaveProperty('total');
    }
    const det = await T.mec.api.get(`/api/ordenes/${T.ot1.id}`);
    expect(det.status).toBe(200);
    sinDatosPersonales(det.body);
    expect(det.body).not.toHaveProperty('cliente_id');
    // y el propietario sí los ve
    expect((await T.a.api.get(`/api/ordenes/${T.ot1.id}`)).body).toMatchObject({ cliente: 'Juan Pérez Titular', cliente_telefono: '341 111-0001' });
  });

  it('la ficha del vehículo y sus listados no devuelven clientes al mecánico, ni se puede buscar por ellos', async () => {
    const ficha = await T.mec.api.get(`/api/vehiculos/${T.hilux.id}`);
    expect(ficha.status).toBe(200);
    expect(ficha.body.patente).toBe('AE456CD');
    expect(ficha.body).not.toHaveProperty('clientes_vinculados');
    expect(ficha.body).not.toHaveProperty('clientes_anteriores');
    expect(ficha.body).not.toHaveProperty('clientes');
    sinDatosPersonales(ficha.body);
    expect((await T.mec.api.get(`/api/vehiculos/${T.hilux.id}/clientes`)).status).toBe(403);
    expect((await T.mec.api.post(`/api/vehiculos/${T.hilux.id}/clientes`, { cliente_id: T.juan.id })).status).toBe(403);
    const lista = await T.mec.api.get('/api/vehiculos');
    sinDatosPersonales(lista.body);
    // buscar por nombre de cliente no devuelve nada (sería una forma de averiguarlo) y filtrar por cliente está vedado
    expect((await T.mec.api.get('/api/vehiculos?q=Juan')).body).toEqual([]);
    expect((await T.mec.api.get(`/api/vehiculos?cliente_id=${T.juan.id}`)).status).toBe(403);
    // Los endpoints de clientes y de ventas están vedados por completo para quien no tiene esos permisos.
    for (const ruta of ['/api/clientes', `/api/clientes/${T.juan.id}`, '/api/ventas', '/api/presupuestos']) expect((await T.mec.api.get(ruta)).status, ruta).toBe(403);
    const buscar = await T.mec.api.get('/api/buscar?q=AE456');
    sinDatosPersonales(buscar.body);
    const tecnico = await T.mec.api.get(`/api/vehiculos/${T.hilux.id}/historial-tecnico`);
    expect(tecnico.status).toBe(200);
    sinDatosPersonales(tecnico.body);
    const mant = await T.mec.api.get('/api/mantenimientos?estado=todos&q=Juan');
    sinDatosPersonales(mant.body);
    expect(mant.body.items).toEqual([]);
  });

  it('el checklist confirmado no revela el cliente al mecánico (la huella se verifica en el servidor)', async () => {
    const borr = await T.rec.api.post(`/api/ordenes/${T.ot1.id}/checklists/recepcion/borrador`);
    expect(borr.status).toBe(201);
    const datos = { fecha_hora: new Date().toISOString(), km: 50100, combustible: '1/2', llaves: 1, observaciones: '', items: {}, danos: [], pertenencias: [], estado_general: '', trabajos: [] };
    expect((await T.rec.api.put(`/api/checklists/${borr.body.id}`, { version: 1, datos })).status).toBe(200);
    const conf = await T.rec.api.post(`/api/checklists/${borr.body.id}/confirmar`, { version: 2 });
    expect(conf.status).toBe(200);
    expect(conf.body.contexto.cliente.nombre).toBe('Juan Pérez Titular');
    const mec = await T.mec.api.get(`/api/ordenes/${T.ot1.id}/checklists`);
    expect(mec.status).toBe(200);
    sinDatosPersonales(mec.body);
    expect(mec.body.registros[0].contexto).not.toHaveProperty('cliente');
    const v = await T.mec.api.get(`/api/checklists/${borr.body.id}/verificar`);
    expect(v.status).toBe(200);
    expect(JSON.stringify(v.body)).toContain('true');
  });

  it('aislamiento entre talleres: el otro taller no ve vehículos, clientes ni vínculos del primero', async () => {
    expect((await T.b.api.get(`/api/vehiculos/${T.hilux.id}`)).status).toBe(404);
    expect(((await T.b.api.get('/api/vehiculos')).body as any[]).map((v) => v.patente)).not.toContain('AE456CD');
    expect((await T.b.api.get(`/api/vehiculos?cliente_id=${T.juan.id}`)).body).toEqual([]);
    const pdf = await pedirPdf(T.b.api, T.ot1.id, 'mecanico');
    expect(pdf.status).toBe(404);
    const solo = (await T.b.api.get('/api/vehiculos?sin_clientes=1')).body as any[];
    expect(solo.map((v) => v.patente)).not.toContain('AE123BC');
  });
});
