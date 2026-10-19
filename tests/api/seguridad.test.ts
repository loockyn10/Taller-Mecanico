// Aislamiento entre talleres, permisos por rol, licencias y autenticación.
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, idem, nuevoTaller, plataforma, platformHeaders } from './cliente';

let A: Awaited<ReturnType<typeof nuevoTaller>>;
let B: Awaited<ReturnType<typeof nuevoTaller>>;
const a: Record<string, any> = {};

beforeAll(async () => {
  A = await nuevoTaller('Taller A', 1);
  B = await nuevoTaller('Taller B');
  // Datos del taller A
  a.cliente = (await A.api.post('/api/clientes', { nombre: 'Cliente secreto de A', telefono: '111' })).body;
  a.vehiculo = (await A.api.post('/api/vehiculos', { cliente_id: a.cliente.id, patente: 'AAA111' })).body;
  a.articulo = (await A.api.post('/api/articulos', { nombre: 'Pastillas A', stock_inicial: 4, precio: 1000 })).body;
  a.presupuesto = (await A.api.post('/api/presupuestos', { cliente_id: a.cliente.id, vehiculo_id: a.vehiculo.id, items: [{ tipo: 'libre', descripcion: 'x', cantidad: 1, precio_unitario: 1000 }] })).body;
  a.orden = (await A.api.post('/api/ordenes', { cliente_id: a.cliente.id, vehiculo_id: a.vehiculo.id, items: [{ tipo: 'libre', descripcion: 'trabajo', cantidad: 1, precio_unitario: 5000 }] })).body;
  await A.api.post(`/api/ordenes/${a.orden.id}/estado`, { estado: 'lista' });
  a.venta = (await A.api.post(`/api/ordenes/${a.orden.id}/comprobante`, {})).body;
});

describe('aislamiento entre talleres', () => {
  it('B no ve datos de A en listados ni búsqueda', async () => {
    const clientes = (await B.api.get('/api/clientes')).body;
    expect(clientes.map((c: any) => c.nombre)).not.toContain('Cliente secreto de A');
    expect((await B.api.get('/api/vehiculos?q=AAA111')).body).toHaveLength(0);
    expect((await B.api.get('/api/ordenes?estado=todas')).body).toHaveLength(0);
    const busq = (await B.api.get('/api/buscar?q=secreto')).body;
    expect(busq.clientes).toHaveLength(0);
  });

  it('B no puede leer registros de A aunque conozca sus IDs', async () => {
    for (const p of [`/api/clientes/${a.cliente.id}`, `/api/vehiculos/${a.vehiculo.id}`, `/api/articulos/${a.articulo.id}`, `/api/presupuestos/${a.presupuesto.id}`, `/api/ordenes/${a.orden.id}`, `/api/ventas/${a.venta.id}`, `/api/cuentas-corrientes/${a.cliente.id}`]) {
      expect((await B.api.get(p)).status, p).toBe(404);
    }
  });

  it('B no puede modificar ni operar sobre registros de A', async () => {
    expect((await B.api.put(`/api/clientes/${a.cliente.id}`, { nombre: 'hackeado' })).status).toBe(404);
    expect((await B.api.post(`/api/presupuestos/${a.presupuesto.id}/convertir`, {})).status).toBe(404);
    expect((await B.api.post(`/api/ordenes/${a.orden.id}/estado`, { estado: 'entregada' })).status).toBe(404);
    expect((await B.api.put(`/api/ordenes/${a.orden.id}/checklist`, { datos: {} })).status).toBe(404);
    expect((await B.api.post('/api/stock/movimientos', { articulo_id: a.articulo.id, tipo: 'salida', cantidad: 1, idem_key: idem() })).status).toBe(404);
    expect((await B.api.post(`/api/ventas/${a.venta.id}/anular`, { motivo: 'xxx' })).status).toBe(404);
    // Verificación del lado de A: nada cambió
    expect((await A.api.get(`/api/clientes/${a.cliente.id}`)).body.nombre).toBe('Cliente secreto de A');
    expect((await A.api.get(`/api/articulos/${a.articulo.id}`)).body.stock).toBe(4);
    expect((await A.api.get(`/api/ordenes/${a.orden.id}`)).body.estado).toBe('lista');
  });

  it('B no puede referenciar entidades de A dentro de sus propios documentos', async () => {
    const cB = (await B.api.post('/api/clientes', { nombre: 'Cliente B' })).body;
    const vB = (await B.api.post('/api/vehiculos', { cliente_id: cB.id, patente: 'BBB222' })).body;
    // vehículo para un cliente ajeno
    expect((await B.api.post('/api/vehiculos', { cliente_id: a.cliente.id, patente: 'CCC333' })).status).toBe(400);
    // OT con vehículo ajeno
    expect((await B.api.post('/api/ordenes', { cliente_id: a.cliente.id, vehiculo_id: a.vehiculo.id })).status).toBe(400);
    // presupuesto con artículo ajeno
    expect(
      (await B.api.post('/api/presupuestos', { cliente_id: cB.id, vehiculo_id: vB.id, items: [{ tipo: 'articulo', articulo_id: a.articulo.id, descripcion: 'x', cantidad: 1, precio_unitario: 1 }] })).status,
    ).toBe(400);
    // cobro aplicado a un comprobante ajeno
    expect(
      (await B.api.post('/api/cobros', { cliente_id: cB.id, medios: [{ medio: 'efectivo', importe: 100 }], aplicaciones: [{ venta_id: a.venta.id, importe: 100 }], idem_key: idem() })).status,
    ).toBe(400);
    expect((await A.api.get(`/api/ventas/${a.venta.id}`)).body.cobrado).toBe(0);
  });

  it('la misma patente puede existir en talleres distintos (unicidad por taller)', async () => {
    const cB = (await B.api.post('/api/clientes', { nombre: 'Cliente B2' })).body;
    expect((await B.api.post('/api/vehiculos', { cliente_id: cB.id, patente: 'AAA111' })).status).toBe(201);
  });
});

describe('roles, permisos y licencias', () => {
  it('el propietario crea usuarios hasta el límite de la licencia', async () => {
    const lic = (await A.api.get('/api/taller/licencia')).body;
    expect(lic.usuarios_max).toBe(2);
    a.empleadoEmail = `emp-${Date.now()}@test.local`;
    const r = await A.api.post('/api/taller/usuarios', { nombre: 'Empleado Uno', email: a.empleadoEmail, rol: 'empleado', password: 'clave-empleado-1' });
    expect(r.status).toBe(201);
    const extra = await A.api.post('/api/taller/usuarios', { nombre: 'Sobra', email: `sobra-${Date.now()}@test.local`, rol: 'empleado', password: 'clave-empleado-1' });
    expect(extra.status).toBe(409);
    expect(extra.body.error.code).toBe('limite_licencia');
  });

  it('el empleado opera el taller pero no administra', async () => {
    const emp = await Api.login(a.empleadoEmail, 'clave-empleado-1');
    const me = (await emp.get('/api/auth/me')).body;
    expect(me.usuario.rol).toBe('empleado');
    expect((await emp.post('/api/clientes', { nombre: 'Cliente del empleado' })).status).toBe(201);
    expect((await emp.get('/api/taller/usuarios')).status).toBe(403);
    expect((await emp.post('/api/taller/usuarios', { nombre: 'x', email: 'x@x.com', rol: 'administrador', password: '12345678' })).status).toBe(403);
    expect((await emp.put('/api/taller/config', {})).status).toBe(403);
    expect((await emp.get('/api/compras')).status).toBe(403);
    expect((await emp.get('/api/reportes?desde=2026-01-01&hasta=2026-12-31')).status).toBe(403);
    expect((await emp.post(`/api/ventas/${a.venta.id}/anular`, { motivo: 'no autorizado' })).status).toBe(403);
    expect((await emp.post('/api/articulos', { nombre: 'Art del empleado' })).status).toBe(403);
    expect((await emp.post('/api/stock/movimientos', { articulo_id: a.articulo.id, tipo: 'entrada', cantidad: 1, idem_key: idem() })).status).toBe(403);
    // Puede ver el dashboard, pero sin datos financieros
    const dash = (await emp.get('/api/dashboard')).body;
    expect(dash.finanzas).toBeNull();
    // Y sí puede registrar cobros
    expect(
      (await emp.post('/api/cobros', { cliente_id: a.cliente.id, medios: [{ medio: 'efectivo', importe: 1000 }], aplicaciones: [{ venta_id: a.venta.id, importe: 1000 }], idem_key: idem() })).status,
    ).toBe(201);
  });

  it('desactivar un usuario cierra sus sesiones y libera cupo', async () => {
    const emp = await Api.login(a.empleadoEmail, 'clave-empleado-1');
    const usuarios = (await A.api.get('/api/taller/usuarios')).body.usuarios;
    const id = usuarios.find((u: any) => u.email === a.empleadoEmail).id;
    expect((await A.api.patch(`/api/taller/usuarios/${id}`, { activo: false })).status).toBe(200);
    expect((await emp.get('/api/auth/me')).status).toBe(401);
    expect((await Api.login(a.empleadoEmail, 'clave-empleado-1').catch(() => null))).toBeNull();
    expect((await A.api.get('/api/taller/licencia')).body.disponibles).toBe(1);
  });

  it('el propietario no puede ser desactivado', async () => {
    const usuarios = (await A.api.get('/api/taller/usuarios')).body.usuarios;
    const owner = usuarios.find((u: any) => u.rol === 'propietario');
    expect((await A.api.patch(`/api/taller/usuarios/${owner.id}`, { activo: false })).status).toBe(403);
  });

  it('con licencia suspendida el taller solo puede consultar', async () => {
    expect((await plataforma.req('PATCH', `/api/platform/talleres/${B.tallerId}/licencia`, { estado: 'suspendida' }, platformHeaders)).status).toBe(200);
    expect((await B.api.get('/api/clientes')).status).toBe(200);
    const r = await B.api.post('/api/clientes', { nombre: 'No debería crearse' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('licencia_suspendida');
    await plataforma.req('PATCH', `/api/platform/talleres/${B.tallerId}/licencia`, { estado: 'activa' }, platformHeaders);
    expect((await B.api.post('/api/clientes', { nombre: 'Ahora sí' })).status).toBe(201);
  });

  it('la API de plataforma exige token', async () => {
    expect((await new Api().get('/api/platform/talleres')).status).toBe(401);
    expect((await new Api().req('GET', '/api/platform/talleres', undefined, { authorization: 'Bearer incorrecto' })).status).toBe(401);
  });
});

describe('autenticación', () => {
  it('rechaza credenciales inválidas y endpoints sin sesión', async () => {
    expect((await new Api().post('/api/auth/login', { email: A.email, password: 'mala' })).status).toBe(401);
    expect((await new Api().get('/api/clientes')).status).toBe(401);
  });

  it('exige JSON en mutaciones (protección CSRF)', async () => {
    const r = await A.api.req('POST', '/api/clientes', undefined, { 'content-type': 'application/x-www-form-urlencoded' });
    expect(r.status).toBe(415);
  });

  it('bloquea temporalmente tras 5 intentos fallidos', async () => {
    const t = await nuevoTaller('Taller Bloqueo');
    for (let i = 0; i < 5; i++) await new Api().post('/api/auth/login', { email: t.email, password: 'incorrecta' });
    const r = await new Api().post('/api/auth/login', { email: t.email, password: 'clave-segura-1' });
    expect(r.status).toBe(429);
  });

  it('logout invalida la sesión en el servidor', async () => {
    const t = await nuevoTaller('Taller Logout');
    const cookie = t.api.cookie;
    await t.api.post('/api/auth/logout');
    const viejo = new Api();
    viejo.cookie = cookie;
    expect((await viejo.get('/api/auth/me')).status).toBe(401);
  });
});
