// Sprint 06: roles y permisos granulares, privacidad de precios en la API, vista del mecánico, asistencia y reloj compartido.
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, dormir, hoyAR, nuevoPersonal, nuevoTaller } from './cliente';

let T: Awaited<ReturnType<typeof nuevoTaller>>; // taller principal (propietario = T.api)
let OTRO: Awaited<ReturnType<typeof nuevoTaller>>;
const d: Record<string, any> = {};

beforeAll(async () => {
  T = await nuevoTaller('Taller Personal', 20);
  OTRO = await nuevoTaller('Otro Taller', 3);
  d.recepcion = await nuevoPersonal(T.api, 'recepcion');
  d.deposito = await nuevoPersonal(T.api, 'deposito');
  d.caja = await nuevoPersonal(T.api, 'caja');
  d.mecanico = await nuevoPersonal(T.api, 'mecanico', { telefono: '1155', cargo: 'Mecánico de motor' });
  d.mecanico2 = await nuevoPersonal(T.api, 'mecanico');
  d.admin = await nuevoPersonal(T.api, 'administrador');
  d.empleado = await nuevoPersonal(T.api, 'empleado');
  d.cliente = (await T.api.post('/api/clientes', { nombre: 'Cliente Reservado', telefono: '4444' })).body;
  d.vehiculo = (await T.api.post('/api/vehiculos', { cliente_id: d.cliente.id, patente: 'PER123' })).body;
  d.articulo = (await T.api.post('/api/articulos', { nombre: 'Filtro caro', costo: 50000, precio: 90000, stock_inicial: 10 })).body;
  d.servicio = (await T.api.get('/api/servicios')).body[0];
  const mecs = (await T.api.get('/api/mecanicos')).body;
  d.mecId = mecs.find((m: any) => m.usuario_id === d.mecanico.id)?.id;
  d.mec2Id = mecs.find((m: any) => m.usuario_id === d.mecanico2.id)?.id;
  d.ot = (
    await T.api.post('/api/ordenes', {
      cliente_id: d.cliente.id, vehiculo_id: d.vehiculo.id, mecanico_id: d.mecId, falla_reportada: 'Ruido al frenar',
      items: [
        { tipo: 'articulo', articulo_id: d.articulo.id, descripcion: 'Filtro caro', cantidad: 2, precio_unitario: 90000 },
        { tipo: 'servicio', servicio_id: d.servicio.id, descripcion: d.servicio.nombre, cantidad: 1, precio_unitario: 600000 },
      ],
    })
  ).body;
  d.otAjena = (await T.api.post('/api/ordenes', { cliente_id: d.cliente.id, vehiculo_id: d.vehiculo.id, mecanico_id: d.mec2Id, items: [{ tipo: 'libre', descripcion: 'Otra', cantidad: 1, precio_unitario: 1000 }] })).body;
});

describe('roles como plantillas de permisos', () => {
  it('cada rol recibe los permisos de su plantilla y el cambio de rol los reemplaza', async () => {
    const me = async (a: Api) => (await a.get('/api/auth/me')).body;
    const mec = await me(d.mecanico.api);
    expect(mec.usuario.rol).toBe('mecanico');
    expect(mec.permisos).toContain('ordenes.asignadas');
    expect(mec.permisos).not.toContain('precios.venta.ver');
    expect(mec.permisos).not.toContain('caja.operar');
    const rec = await me(d.recepcion.api);
    expect(rec.permisos).toContain('precios.venta.ver');
    expect(rec.permisos).not.toContain('precios.costo.ver');
    const dep = await me(d.deposito.api);
    expect(dep.permisos).toContain('precios.costo.ver');
    expect(dep.permisos).toContain('stock.ajustar');
    expect((await me(d.caja.api)).permisos).toContain('caja.operar');
    const own = await me(T.api);
    expect(own.usuario.rol).toBe('propietario');
    expect(own.permisos).toContain('permisos.gestionar');
    const adm = await me(d.admin.api);
    expect(adm.permisos).toContain('usuarios.gestionar');
    expect(adm.permisos).not.toContain('permisos.gestionar');
    expect(adm.permisos).not.toContain('bancos.ajustar');
  });

  it('los permisos individuales se ajustan sobre la plantilla y rigen de inmediato, sin volver a ingresar', async () => {
    const u = await nuevoPersonal(T.api, 'recepcion');
    expect((await u.api.get('/api/caja/estado')).status).toBe(403);
    const r = await T.api.put(`/api/taller/usuarios/${u.id}/permisos`, { permisos: [...(await T.api.get(`/api/taller/usuarios/${u.id}`)).body.permisos, 'caja.operar'] });
    expect(r.status).toBe(200);
    expect(r.body.ajustes.g).toContain('caja.operar');
    expect((await u.api.get('/api/caja/estado')).status).toBe(200); // misma sesión, sin reinstalar ni reingresar
    // Retirar "ver clientes" retira también crear y editar (dependen de ver)
    const actuales: string[] = (await T.api.get(`/api/taller/usuarios/${u.id}`)).body.permisos;
    await T.api.put(`/api/taller/usuarios/${u.id}/permisos`, { permisos: actuales.filter((p) => p !== 'clientes.ver') });
    expect((await u.api.get('/api/clientes')).status).toBe(403);
    expect((await u.api.post('/api/clientes', { nombre: 'x' })).status).toBe(403);
    // Restablecer a la plantilla
    await T.api.put(`/api/taller/usuarios/${u.id}/permisos`, { permisos: null });
    expect((await u.api.get('/api/clientes')).status).toBe(200);
    expect((await u.api.get('/api/caja/estado')).status).toBe(403);
  });

  it('lectura y escritura son permisos separados', async () => {
    const u = await nuevoPersonal(T.api, 'recepcion');
    const base: string[] = (await T.api.get(`/api/taller/usuarios/${u.id}`)).body.permisos;
    await T.api.put(`/api/taller/usuarios/${u.id}/permisos`, { permisos: base.filter((p) => !['clientes.crear', 'clientes.editar'].includes(p)) });
    expect((await u.api.get('/api/clientes')).status).toBe(200);
    expect((await u.api.post('/api/clientes', { nombre: 'Nuevo' })).status).toBe(403);
    expect((await u.api.put(`/api/clientes/${d.cliente.id}`, { nombre: 'Editado' })).status).toBe(403);
  });
});

describe('seguridad: sin escalamiento de privilegios', () => {
  it('un empleado no puede darse permisos ni administrar a nadie', async () => {
    expect((await d.recepcion.api.put(`/api/taller/usuarios/${d.recepcion.id}/permisos`, { permisos: ['config.editar'] })).status).toBe(403);
    expect((await d.recepcion.api.patch(`/api/taller/usuarios/${d.recepcion.id}`, { rol: 'administrador' })).status).toBe(403);
    expect((await d.recepcion.api.get('/api/taller/usuarios')).status).toBe(403);
  });

  it('un administrador no puede crear administradores ni tocar permisos si el propietario no se lo habilitó', async () => {
    const r = await d.admin.api.post('/api/taller/usuarios', { nombre: 'Otro Admin', email: `a-${Date.now()}@t.local`, rol: 'administrador', password: 'clave-segura-1' });
    expect(r.status).toBe(403);
    expect((await d.admin.api.put(`/api/taller/usuarios/${d.recepcion.id}/permisos`, { permisos: ['clientes.ver'] })).status).toBe(403); // sin permisos.gestionar
    // sí puede crear personal de nivel empleado
    expect((await d.admin.api.post('/api/taller/usuarios', { nombre: 'Nuevo Mecánico', email: `m-${Date.now()}@t.local`, rol: 'mecanico', password: 'clave-segura-1' })).status).toBe(201);
    // no puede modificar al propietario ni a otro administrador
    const owner = (await T.api.get('/api/taller/usuarios')).body.usuarios.find((u: any) => u.rol === 'propietario');
    expect((await d.admin.api.patch(`/api/taller/usuarios/${owner.id}`, { nombre: 'Hack' })).status).toBe(403);
  });

  it('con permisos.gestionar un administrador solo otorga permisos que ya tiene y no cambia los propios', async () => {
    const adm = await nuevoPersonal(T.api, 'administrador');
    const actuales: string[] = (await T.api.get(`/api/taller/usuarios/${adm.id}`)).body.permisos;
    expect((await T.api.put(`/api/taller/usuarios/${adm.id}/permisos`, { permisos: [...actuales, 'permisos.gestionar'] })).status).toBe(200);
    const objetivo = await nuevoPersonal(T.api, 'recepcion');
    const base: string[] = (await T.api.get(`/api/taller/usuarios/${objetivo.id}`)).body.permisos;
    // bancos.ajustar es exclusivo del propietario: el administrador no puede otorgarlo
    const r = await adm.api.put(`/api/taller/usuarios/${objetivo.id}/permisos`, { permisos: [...base, 'bancos.ajustar'] });
    expect(r.status).toBe(403);
    // lo que sí tiene, sí
    expect((await adm.api.put(`/api/taller/usuarios/${objetivo.id}/permisos`, { permisos: [...base, 'caja.operar'] })).status).toBe(200);
    // no puede modificar sus propios permisos
    expect((await adm.api.put(`/api/taller/usuarios/${adm.id}/permisos`, { permisos: [...actuales, 'bancos.ajustar'] })).status).toBe(403);
    // ni los de otro administrador
    expect((await adm.api.put(`/api/taller/usuarios/${d.admin.id}/permisos`, { permisos: ['clientes.ver'] })).status).toBe(403);
  });

  it('el propietario conserva todos los permisos y nadie desactiva su usuario', async () => {
    const owner = (await T.api.get('/api/taller/usuarios')).body.usuarios.find((u: any) => u.rol === 'propietario');
    expect((await T.api.put(`/api/taller/usuarios/${owner.id}/permisos`, { permisos: [] })).status).toBe(403);
    expect((await d.admin.api.patch(`/api/taller/usuarios/${owner.id}`, { activo: false })).status).toBe(403);
  });

  it('una persona sin acceso al sistema no puede ingresar y no ocupa un lugar de la licencia', async () => {
    const t = await nuevoTaller('Taller licencia', 0); // cupo: 1 (el propietario)
    const r = await t.api.post('/api/taller/usuarios', { nombre: 'Lavadero', apellido: 'Pérez', rol: 'recepcion', acceso_erp: false, pin: '2580' });
    expect(r.status).toBe(201);
    const lista = (await t.api.get('/api/taller/usuarios')).body;
    expect(lista.licencia.usuarios_activos).toBe(1);
    expect(lista.usuarios.find((u: any) => u.id === r.body.id).email).toBeNull();
    // con acceso sí ocupa cupo
    expect((await t.api.post('/api/taller/usuarios', { nombre: 'Con acceso', email: `x-${Date.now()}@t.local`, rol: 'recepcion', password: 'clave-segura-1' })).status).toBe(409);
  });

  it('el aislamiento entre talleres alcanza a usuarios, asistencia y dispositivos', async () => {
    expect((await OTRO.api.get(`/api/taller/usuarios/${d.recepcion.id}`)).status).toBe(404);
    expect((await OTRO.api.patch(`/api/taller/usuarios/${d.recepcion.id}`, { activo: false })).status).toBe(404);
    expect((await OTRO.api.put(`/api/taller/usuarios/${d.recepcion.id}/permisos`, { permisos: null })).status).toBe(404);
    expect((await OTRO.api.put(`/api/taller/usuarios/${d.recepcion.id}/pin`, { pin: '2580' })).status).toBe(404);
    const lista = (await OTRO.api.get('/api/taller/usuarios')).body.usuarios;
    expect(lista).toHaveLength(1);
    expect((await OTRO.api.post('/api/asistencia/registros', { usuario_id: d.recepcion.id, entrada: { fecha: hoyAR(-1), hora: '08:00' }, salida: { fecha: hoyAR(-1), hora: '12:00' }, motivo: 'intento ajeno' })).status).toBe(404);
  });
});

describe('privacidad de precios, costos y márgenes en la API', () => {
  it('el mecánico no recupera precios consultando los endpoints directamente', async () => {
    const m = d.mecanico.api;
    for (const ruta of ['/api/articulos', '/api/servicios', '/api/stock/movimientos', '/api/presupuestos', '/api/clientes', '/api/ventas', '/api/cuentas-corrientes', '/api/reportes?desde=2020-01-01&hasta=2030-01-01', '/api/informes/ventas?desde=2020-01-01&hasta=2030-01-01', '/api/inventario/valorizado', '/api/listas-precios', '/api/caja/estado', '/api/bancos/cuentas']) {
      expect((await m.get(ruta)).status, ruta).toBe(403);
    }
    expect((await m.post(`/api/listas-precios/base/precios`, { articulos: [d.articulo.id], servicios: [] })).status).toBe(403);
    expect((await m.get(`/api/articulos/${d.articulo.id}/precios-lista`)).status).toBe(403);
    // el dashboard y la búsqueda solo devuelven lo que su rol puede ver
    const dash = (await m.get('/api/dashboard')).body;
    expect(dash.finanzas).toBeNull();
    expect(dash.ordenesRecientes).toEqual([]);
    const busq = (await m.get('/api/buscar?q=Reservado')).body;
    expect(busq.clientes).toEqual([]);
  });

  it('en sus órdenes asignadas no hay importes, ítems valorizados ni datos del cliente', async () => {
    const lista = (await d.mecanico.api.get('/api/ordenes?estado=todas')).body;
    expect(lista.map((o: any) => o.id)).toEqual([d.ot.id]); // solo la suya
    for (const o of lista) {
      for (const campo of ['total', 'neto', 'iva', 'subtotal_articulos', 'subtotal_servicios', 'descuento', 'venta_total', 'cliente', 'cliente_telefono']) expect(o, campo).not.toHaveProperty(campo);
      expect(o.patente).toBe('PER123');
    }
    const det = (await d.mecanico.api.get(`/api/ordenes/${d.ot.id}`)).body;
    expect(det.items).toHaveLength(2);
    for (const it of det.items) for (const campo of ['precio_unitario', 'subtotal', 'desc_pct']) expect(it, campo).not.toHaveProperty(campo);
    expect(det.items.map((i: any) => i.descripcion)).toContain('Filtro caro');
    expect(det.falla_reportada).toBe('Ruido al frenar');
    expect(det.asignada_a_mi).toBe(true);
    // las órdenes de otros mecánicos no existen para él
    expect((await d.mecanico.api.get(`/api/ordenes/${d.otAjena.id}`)).status).toBe(404);
    // tampoco puede editar, crear ni entregar
    expect((await d.mecanico.api.post('/api/ordenes', { cliente_id: d.cliente.id, vehiculo_id: d.vehiculo.id })).status).toBe(403);
    expect((await d.mecanico.api.put(`/api/ordenes/${d.ot.id}`, { cliente_id: d.cliente.id, vehiculo_id: d.vehiculo.id, version: 1, items: [] })).status).toBe(403);
    expect((await d.mecanico.api.post(`/api/ordenes/${d.ot.id}/estado`, { estado: 'entregada' })).status).toBe(403);
    expect((await d.mecanico.api.post(`/api/ordenes/${d.ot.id}/comprobante`, {})).status).toBe(403);
  });

  it('recepción ve precios de venta pero no costos; depósito ve costos', async () => {
    const art = (await d.recepcion.api.get(`/api/articulos/${d.articulo.id}`)).body;
    expect(art.precio).toBe(90000);
    expect(art).not.toHaveProperty('costo');
    const lista = (await d.recepcion.api.get('/api/articulos')).body;
    expect(lista.every((a: any) => !('costo' in a))).toBe(true);
    expect((await d.recepcion.api.get('/api/stock/movimientos')).body.every((m: any) => !('costo_unitario' in m))).toBe(true);
    expect((await d.recepcion.api.get('/api/inventario/valorizado')).status).toBe(403);
    // no puede fijar costos a ciegas
    expect((await d.recepcion.api.put(`/api/articulos/${d.articulo.id}`, { costo: 1 })).status).toBe(403);
    const dep = (await d.deposito.api.get(`/api/articulos/${d.articulo.id}`)).body;
    expect(dep.costo).toBe(50000);
    expect(dep.precio).toBe(90000);
  });

  it('sin ver precios de venta el artículo y el servicio no traen precio; las listas de precios tampoco se filtran', async () => {
    const u = await nuevoPersonal(T.api, 'deposito');
    const base: string[] = (await T.api.get(`/api/taller/usuarios/${u.id}`)).body.permisos;
    await T.api.put(`/api/taller/usuarios/${u.id}/permisos`, { permisos: base.filter((p) => !['precios.venta.ver', 'precios.costo.ver'].includes(p)) });
    const art = (await u.api.get(`/api/articulos/${d.articulo.id}`)).body;
    expect(art).not.toHaveProperty('precio');
    expect(art).not.toHaveProperty('costo');
    expect((await u.api.get('/api/servicios')).body.every((s: any) => !('precio' in s))).toBe(true);
    expect((await u.api.put(`/api/articulos/${d.articulo.id}`, { precio: 5 })).status).toBe(403);
  });

  it('los márgenes (costo en estadísticas) requieren su propio permiso', async () => {
    const hoy = hoyAR();
    const r = await T.api.get(`/api/reportes?desde=${hoy}&hasta=${hoy}`);
    expect(r.status).toBe(200);
    // un administrador con el permiso de estadísticas retirado/margen retirado no ve el costo de los artículos
    const u = await nuevoPersonal(T.api, 'administrador');
    const base: string[] = (await T.api.get(`/api/taller/usuarios/${u.id}`)).body.permisos;
    await T.api.put(`/api/taller/usuarios/${u.id}/permisos`, { permisos: base.filter((p) => p !== 'margenes.ver') });
    const rep = await u.api.get(`/api/reportes?desde=${hoy}&hasta=${hoy}`);
    expect(rep.status).toBe(200);
    expect(rep.body.topArticulos.every((a: any) => !('costo' in a))).toBe(true);
    expect((await u.api.get(`/api/informes/rentabilidad?desde=${hoy}&hasta=${hoy}`)).status).toBe(403);
  });

  it('exportar informes exige su permiso y queda auditado', async () => {
    const hoy = hoyAR();
    const u = await nuevoPersonal(T.api, 'administrador');
    expect((await u.api.get(`/api/informes/ventas?desde=${hoy}&hasta=${hoy}&exportar=1`)).status).toBe(200);
    const base: string[] = (await T.api.get(`/api/taller/usuarios/${u.id}`)).body.permisos;
    await T.api.put(`/api/taller/usuarios/${u.id}/permisos`, { permisos: base.filter((p) => p !== 'informes.exportar') });
    expect((await u.api.get(`/api/informes/ventas?desde=${hoy}&hasta=${hoy}`)).status).toBe(200); // ver en pantalla, sí
    expect((await u.api.get(`/api/informes/ventas?desde=${hoy}&hasta=${hoy}&exportar=1`)).status).toBe(403);
    const act = (await T.api.get(`/api/taller/usuarios/${u.id}`)).body.actividad;
    expect(act.some((x: any) => x.entidad === 'informe' && x.accion === 'exportar')).toBe(true);
  });
});

describe('trabajo del mecánico en sus órdenes', () => {
  it('actualiza tareas, observaciones técnicas, cronómetro y estado de su orden', async () => {
    const m = d.mecanico.api;
    const id = d.ot.id;
    expect((await m.post(`/api/ordenes/${id}/tareas`, { descripcion: 'Cambiar pastillas' })).status).toBe(201);
    expect((await m.post(`/api/ordenes/${id}/tareas`, { descripcion: 'Probar frenos' })).status).toBe(201);
    let det = (await m.get(`/api/ordenes/${id}`)).body;
    // la orden trae además la tarea generada desde su trabajo (mano de obra) del catálogo
    expect(det.tareas).toHaveLength(3);
    expect((await m.patch(`/api/ordenes/${id}/tareas/${det.tareas[0].id}`, { hecha: true })).status).toBe(200);
    expect((await m.post(`/api/ordenes/${id}/notas`, { texto: 'Discos con desgaste, avisar a recepción' })).status).toBe(201);
    expect((await m.patch(`/api/ordenes/${id}/tecnico`, { diagnostico: 'Pastillas gastadas' })).status).toBe(200);
    expect((await m.post(`/api/ordenes/${id}/tiempo/iniciar`, {})).status).toBe(201);
    expect((await m.post(`/api/ordenes/${id}/tiempo/iniciar`, {})).status).toBe(409); // un cronómetro a la vez
    expect((await m.post(`/api/ordenes/${id}/estado`, { estado: 'diagnostico' })).status).toBe(200);
    expect((await m.post(`/api/ordenes/${id}/estado`, { estado: 'en_reparacion' })).status).toBe(200);
    await dormir(1100);
    expect((await m.post(`/api/ordenes/${id}/tiempo/detener`, {})).status).toBe(200);
    det = (await m.get(`/api/ordenes/${id}`)).body;
    expect(det.tareas[0].hecha).toBe(1);
    expect(det.notas[0].texto).toMatch(/Discos/);
    expect(det.diagnostico).toBe('Pastillas gastadas');
    expect(det.estado).toBe('en_reparacion');
    expect(det.tiempo_total_seg).toBeGreaterThanOrEqual(1);
    expect(det.mi_cronometro).toBeNull();
    // las tareas y notas llegan también a quienes ven todas las órdenes, con importes si tienen permiso
    const rec = (await d.recepcion.api.get(`/api/ordenes/${id}`)).body;
    expect(rec.tareas).toHaveLength(3);
    expect(rec.total).toBeGreaterThan(0);
    expect(rec.items[0].precio_unitario).toBeGreaterThan(0);
    // no puede trabajar en la orden de otro mecánico
    expect((await m.post(`/api/ordenes/${d.otAjena.id}/tareas`, { descripcion: 'No mía' })).status).toBe(403);
    expect((await m.post(`/api/ordenes/${d.otAjena.id}/estado`, { estado: 'diagnostico' })).status).toBe(403);
  });

  it('el mecánico puede dejar su orden lista pero no entregarla ni reabrirla', async () => {
    expect((await d.mecanico.api.post(`/api/ordenes/${d.ot.id}/estado`, { estado: 'lista' })).status).toBe(200);
    expect((await d.mecanico.api.post(`/api/ordenes/${d.ot.id}/estado`, { estado: 'entregada' })).status).toBe(403);
    await d.recepcion.api.post(`/api/ordenes/${d.ot.id}/estado`, { estado: 'entregada' });
    expect((await d.mecanico.api.post(`/api/ordenes/${d.ot.id}/estado`, { estado: 'en_reparacion' })).status).toBe(403);
    expect((await d.mecanico.api.post(`/api/ordenes/${d.ot.id}/tareas`, { descripcion: 'tarde' })).status).toBe(409);
  });

  it('el mecánico creado desde el personal queda vinculado a su usuario (sin duplicar personas)', async () => {
    const mecs = (await T.api.get('/api/mecanicos')).body.filter((m: any) => m.usuario_id === d.mecanico.id);
    expect(mecs).toHaveLength(1);
    expect(mecs[0].especialidad).toBe('Mecánico de motor');
    // al desactivar al usuario, su mecánico deja de ofrecerse para nuevas órdenes
    const u = await nuevoPersonal(T.api, 'mecanico');
    expect((await T.api.patch(`/api/taller/usuarios/${u.id}`, { activo: false })).status).toBe(200);
    const m2 = (await T.api.get('/api/mecanicos')).body.find((m: any) => m.usuario_id === u.id);
    expect(m2.activo).toBe(0);
  });

  it('otro taller no puede agregar tareas ni notas a la orden', async () => {
    expect((await OTRO.api.post(`/api/ordenes/${d.ot.id}/tareas`, { descripcion: 'xx' })).status).toBe(404);
    expect((await OTRO.api.post(`/api/ordenes/${d.ot.id}/notas`, { texto: 'x x' })).status).toBe(404);
    expect((await OTRO.api.post(`/api/ordenes/${d.ot.id}/tiempo/iniciar`, {})).status).toBe(404);
  });
});

describe('asistencia: fichaje propio', () => {
  it('registra entrada y salida con hora del servidor y evita fichajes duplicados', async () => {
    const u = await nuevoPersonal(T.api, 'recepcion');
    const a = u.api;
    expect((await a.post('/api/asistencia/salida', {})).status).toBe(409); // sin jornada abierta
    const e = await a.post('/api/asistencia/entrada', { entrada_at: '2000-01-01T00:00:00Z', fecha: '2000-01-01' }); // el cliente no fija la hora
    expect(e.status).toBe(201);
    expect(Math.abs(Date.parse(e.body.entrada_at) - Date.now())).toBeLessThan(60_000);
    expect(e.body.origen_entrada).toBe('app');
    expect((await a.post('/api/asistencia/entrada', {})).status).toBe(409); // jornada abierta
    // dos entradas simultáneas: solo una prospera
    const v = await nuevoPersonal(T.api, 'recepcion');
    const rs = await Promise.all([v.api.post('/api/asistencia/entrada', {}), v.api.post('/api/asistencia/entrada', {}), v.api.post('/api/asistencia/entrada', {})]);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(2);
    expect((await a.post('/api/asistencia/salida', {})).status).toBe(409); // toque doble: muy pronto
    await dormir(3300);
    const s = await a.post('/api/asistencia/salida', {});
    expect(s.status).toBe(200);
    expect(s.body.duracion_seg).toBeGreaterThanOrEqual(3);
    expect((await a.post('/api/asistencia/salida', {})).status).toBe(409);
    const mia = (await a.get('/api/asistencia/mia')).body;
    expect(mia.abierta).toBeNull();
    expect(mia.jornadas).toHaveLength(1);
    expect(mia.zona).toBe('America/Argentina/Buenos_Aires');
    // sin permiso de fichar no se puede
    const sin = await nuevoPersonal(T.api, 'recepcion');
    const base: string[] = (await T.api.get(`/api/taller/usuarios/${sin.id}`)).body.permisos;
    await T.api.put(`/api/taller/usuarios/${sin.id}/permisos`, { permisos: base.filter((p) => p !== 'asistencia.fichar') });
    expect((await sin.api.post('/api/asistencia/entrada', {})).status).toBe(403);
  });

  it('cada persona ve solo sus propios fichajes y el panel exige permiso', async () => {
    expect((await d.mecanico.api.get('/api/asistencia/panel')).status).toBe(403);
    expect((await d.mecanico.api.get(`/api/asistencia/registros?desde=${hoyAR(-30)}&hasta=${hoyAR()}`)).status).toBe(403);
    expect((await d.mecanico.api.get(`/api/asistencia/resumen?desde=${hoyAR(-30)}&hasta=${hoyAR()}`)).status).toBe(403);
    expect((await d.mecanico.api.get('/api/asistencia/dispositivos')).status).toBe(403);
  });
});

describe('asistencia: panel, correcciones y exportación', () => {
  it('el panel distingue presentes, ausentes y jornadas abiertas; el resumen suma horas por persona', async () => {
    const t = await nuevoTaller('Taller asistencia', 5);
    const p1 = await nuevoPersonal(t.api, 'mecanico');
    const p2 = await nuevoPersonal(t.api, 'recepcion');
    await p1.api.post('/api/asistencia/entrada', {});
    const panel = (await t.api.get('/api/asistencia/panel')).body;
    expect(panel.presentes.map((x: any) => x.usuario_id)).toEqual([p1.id]);
    expect(panel.ausentes.map((x: any) => x.usuario_id)).toContain(p2.id);
    expect(panel.totales.jornadas_abiertas).toBe(1);
    expect(panel.presentes[0].abierta).toBe(true);
    const aislado = (await OTRO.api.get('/api/asistencia/panel')).body;
    expect(aislado.presentes).toEqual([]);

    // Corrección manual: cargar una jornada de ayer que cruza la medianoche (22:00 → 06:00)
    const ayer = hoyAR(-2);
    const sig = hoyAR(-1);
    const sinMotivo = await t.api.post('/api/asistencia/registros', { usuario_id: p2.id, entrada: { fecha: ayer, hora: '22:00' }, salida: { fecha: sig, hora: '06:00' }, motivo: '' });
    expect(sinMotivo.status).toBe(400);
    const c = await t.api.post('/api/asistencia/registros', { usuario_id: p2.id, entrada: { fecha: ayer, hora: '22:00' }, salida: { fecha: sig, hora: '06:00' }, motivo: 'Olvidó fichar el turno noche' });
    expect(c.status).toBe(201);
    const reg = (await t.api.get(`/api/asistencia/registros?desde=${ayer}&hasta=${sig}&usuario_id=${p2.id}`)).body.filas;
    expect(reg).toHaveLength(1);
    expect(reg[0].fecha).toBe(ayer); // la jornada pertenece al día en que empezó
    expect(reg[0].duracion_seg).toBe(8 * 3600);
    expect(reg[0].corregido).toBe(1);
    expect(reg[0].origen_entrada).toBe('manual');
    // se superpone → rechazado
    const solape = await t.api.post('/api/asistencia/registros', { usuario_id: p2.id, entrada: { fecha: ayer, hora: '23:00' }, salida: { fecha: sig, hora: '01:00' }, motivo: 'solape de prueba' });
    expect(solape.status).toBe(409);
    // Edición con motivo: queda el valor anterior y el nuevo
    const ed = await t.api.patch(`/api/asistencia/registros/${c.body.id}`, { salida: { fecha: sig, hora: '07:30' }, motivo: 'Salió a las 7:30' });
    expect(ed.status).toBe(200);
    const hist = (await t.api.get(`/api/asistencia/registros/${c.body.id}/correcciones`)).body;
    expect(hist.map((h: any) => h.accion)).toEqual(['crear', 'editar']);
    expect(hist[1].anterior.duracion_seg).toBe(8 * 3600);
    expect(hist[1].nuevo.duracion_seg).toBe(9.5 * 3600);
    expect(hist[1].motivo).toBe('Salió a las 7:30');
    expect(hist[1].usuario).toMatch(/Dueño/);
    // resumen por período
    const res = (await t.api.get(`/api/asistencia/resumen?desde=${ayer}&hasta=${hoyAR()}`)).body;
    const fila = res.filas.find((f: any) => f.usuario_id === p2.id);
    expect(fila.horas_seg).toBe(9.5 * 3600);
    expect(fila.jornadas).toBe(1);
    const porDia = (await t.api.get(`/api/asistencia/resumen?desde=${ayer}&hasta=${hoyAR()}&agrupar=dia`)).body;
    expect(porDia.filas.find((f: any) => f.usuario_id === p2.id).fecha).toBe(ayer);
    // anular
    expect((await t.api.post(`/api/asistencia/registros/${c.body.id}/anular`, { motivo: 'cargado por error' })).status).toBe(200);
    expect((await t.api.get(`/api/asistencia/registros?desde=${ayer}&hasta=${sig}&usuario_id=${p2.id}`)).body.filas).toHaveLength(0);
    expect((await t.api.get(`/api/asistencia/registros/${c.body.id}/correcciones`)).body.map((h: any) => h.accion)).toEqual(['crear', 'editar', 'anular']);
  });

  it('nadie corrige libremente sus propios fichajes ni sin permiso', async () => {
    const t = await nuevoTaller('Taller correcciones', 6);
    const jefe = await nuevoPersonal(t.api, 'administrador');
    const emp = await nuevoPersonal(t.api, 'recepcion');
    const body = (uid: string) => ({ usuario_id: uid, entrada: { fecha: hoyAR(-1), hora: '08:00' }, salida: { fecha: hoyAR(-1), hora: '12:00' }, motivo: 'Corrección de prueba' });
    expect((await emp.api.post('/api/asistencia/registros', body(emp.id))).status).toBe(403); // sin permiso
    expect((await jefe.api.post('/api/asistencia/registros', body(jefe.id))).status).toBe(403); // ni siquiera con permiso, sobre sí mismo
    expect((await jefe.api.post('/api/asistencia/registros', body(emp.id))).status).toBe(201);
    const owner = (await t.api.get('/api/taller/usuarios')).body.usuarios.find((u: any) => u.rol === 'propietario');
    expect((await jefe.api.post('/api/asistencia/registros', body(owner.id))).status).toBe(403);
    const fecha = hoyAR();
    const futuro = await t.api.post('/api/asistencia/registros', { usuario_id: emp.id, entrada: { fecha, hora: '23:59' }, salida: { fecha: hoyAR(1), hora: '03:00' }, motivo: 'jornada futura' });
    expect(futuro.status).toBe(400);
    const larga = await t.api.post('/api/asistencia/registros', { usuario_id: emp.id, entrada: { fecha: hoyAR(-5), hora: '01:00' }, salida: { fecha: hoyAR(-4), hora: '23:00' }, motivo: 'jornada demasiado larga' });
    expect(larga.status).toBe(400);
  });

  it('exportar la asistencia es una acción con permiso propio', async () => {
    const t = await nuevoTaller('Taller export', 4);
    const jefe = await nuevoPersonal(t.api, 'administrador');
    const base: string[] = (await t.api.get(`/api/taller/usuarios/${jefe.id}`)).body.permisos;
    await t.api.put(`/api/taller/usuarios/${jefe.id}/permisos`, { permisos: base.filter((p) => p !== 'informes.exportar') });
    const q = `desde=${hoyAR(-7)}&hasta=${hoyAR()}`;
    expect((await jefe.api.get(`/api/asistencia/registros?${q}`)).status).toBe(200);
    expect((await jefe.api.get(`/api/asistencia/registros?${q}&exportar=1`)).status).toBe(403);
    expect((await jefe.api.get(`/api/asistencia/resumen?${q}&exportar=1`)).status).toBe(403);
    expect((await t.api.get(`/api/asistencia/resumen?${q}&exportar=1`)).status).toBe(200);
  });

  it('la zona horaria del taller define el día local de la jornada', async () => {
    const t = await nuevoTaller('Taller zona', 3);
    const cfg = (await t.api.get('/api/taller/config')).body;
    expect(cfg.config.zona_horaria).toBe('America/Argentina/Buenos_Aires');
    const guardar = (zona: string) => t.api.put('/api/taller/config', { taller: cfg.taller, config: { ...cfg.config, medios_pago: cfg.config.medios_pago, zona_horaria: zona, permitir_stock_negativo: !!cfg.config.permitir_stock_negativo, caja_obligatoria: !!cfg.config.caja_obligatoria } });
    expect((await guardar('Marte/Olimpo')).status).toBe(400);
    expect((await guardar('Europe/Madrid')).status).toBe(200);
    const u = await nuevoPersonal(t.api, 'recepcion');
    const j = (await u.api.post('/api/asistencia/entrada', {})).body;
    const esperado = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(j.entrada_at));
    expect(j.fecha).toBe(esperado);
    expect((await u.api.get('/api/asistencia/mia')).body.zona).toBe('Europe/Madrid');
  });
});

describe('reloj compartido', () => {
  let t: Awaited<ReturnType<typeof nuevoTaller>>;
  let emp: Awaited<ReturnType<typeof nuevoPersonal>>;
  let sinAcceso: string;
  let kiosco: Api;
  let dispositivo: string;

  beforeAll(async () => {
    t = await nuevoTaller('Taller reloj', 6);
    emp = await nuevoPersonal(t.api, 'mecanico');
    sinAcceso = (await t.api.post('/api/taller/usuarios', { nombre: 'Lucía', apellido: 'Gómez', rol: 'caja', acceso_erp: false })).body.id;
    expect((await t.api.put(`/api/taller/usuarios/${emp.id}/pin`, { pin: '2580' })).status).toBe(200);
    expect((await t.api.put(`/api/taller/usuarios/${sinAcceso}/pin`, { pin: '1397' })).status).toBe(200);
  });

  it('exige permiso para administrar dispositivos y rechaza PIN triviales', async () => {
    expect((await emp.api.post('/api/asistencia/dispositivos', { nombre: 'Tablet' })).status).toBe(403);
    expect((await t.api.put(`/api/taller/usuarios/${emp.id}/pin`, { pin: '1234' })).status).toBe(400);
    expect((await t.api.put(`/api/taller/usuarios/${emp.id}/pin`, { pin: '0000' })).status).toBe(400);
    expect((await t.api.put(`/api/taller/usuarios/${emp.id}/pin`, { pin: '12' })).status).toBe(400);
    expect((await emp.api.put(`/api/taller/usuarios/${sinAcceso}/pin`, { pin: '2580' })).status).toBe(403);
  });

  it('se activa con un código de un solo uso y solo habilita el fichaje', async () => {
    const r = await t.api.post('/api/asistencia/dispositivos', { nombre: 'Tablet del taller' });
    expect(r.status).toBe(201);
    expect(r.body.codigo).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    dispositivo = r.body.id;
    kiosco = new Api();
    expect((await kiosco.post('/api/reloj/activar', { codigo: 'ZZZZ-ZZZZ' })).status).toBe(400);
    expect((await kiosco.get('/api/reloj/estado')).status).toBe(401); // aún sin activar
    const ok = await kiosco.post('/api/reloj/activar', { codigo: r.body.codigo });
    expect(ok.status).toBe(200);
    expect(ok.body.taller).toBe('Taller reloj');
    expect((await new Api().post('/api/reloj/activar', { codigo: r.body.codigo })).status).toBe(400); // ya usado
    // el token del dispositivo no abre el resto del ERP
    for (const ruta of ['/api/clientes', '/api/auth/me', '/api/ordenes', '/api/asistencia/mia', '/api/taller/usuarios']) expect((await kiosco.get(ruta)).status, ruta).toBe(401);
    // el listado no revela datos de acceso: solo nombres y si está dentro; incluye a la persona sin acceso al ERP
    const est = (await kiosco.get('/api/reloj/estado')).body;
    const nombres: string[] = est.personal.map((p: any) => p.nombre);
    expect(nombres).toContain('Lucía Gómez');
    expect(nombres.some((n) => n.startsWith('mecanico'))).toBe(true);
    expect(JSON.stringify(est)).not.toMatch(/pin|hash|email/i);
    // en el panel figura como dispositivo activo
    const lista = (await t.api.get('/api/asistencia/dispositivos')).body;
    expect(lista.reloj_activo).toBe(true);
    expect(lista.dispositivos.find((x: any) => x.id === dispositivo).estado).toBe('activo');
    expect(JSON.stringify(lista)).not.toContain(r.body.codigo.replace('-', ''));
  });

  it('ficha entrada y salida con el PIN y la hora del servidor, para quien no tiene acceso al sistema también', async () => {
    const e = await kiosco.post('/api/reloj/fichar', { usuario_id: sinAcceso, pin: '1397', accion: 'entrada' });
    expect(e.status).toBe(200);
    expect(e.body.empleado).toBe('Lucía Gómez');
    expect(e.body.hora).toMatch(/^\d{2}:\d{2}$/);
    expect((await kiosco.post('/api/reloj/fichar', { usuario_id: sinAcceso, pin: '1397', accion: 'entrada' })).status).toBe(409);
    expect((await kiosco.get('/api/reloj/estado')).body.personal.find((p: any) => p.id === sinAcceso).dentro).toBe(true);
    await dormir(3300);
    const s = await kiosco.post('/api/reloj/fichar', { usuario_id: sinAcceso, pin: '1397', accion: 'salida' });
    expect(s.status).toBe(200);
    expect(s.body.duracion_seg).toBeGreaterThanOrEqual(3);
    const reg = (await t.api.get(`/api/asistencia/registros?desde=${hoyAR(-1)}&hasta=${hoyAR(1)}&usuario_id=${sinAcceso}`)).body.filas;
    expect(reg).toHaveLength(1);
    expect(reg[0].origen_entrada).toBe('reloj');
    expect(reg[0].origen_salida).toBe('reloj');
  });

  it('limita los intentos de PIN por persona y por dispositivo, y se puede desbloquear', async () => {
    const mal = (pin: string) => kiosco.post('/api/reloj/fichar', { usuario_id: emp.id, pin, accion: 'entrada' });
    for (let i = 0; i < 4; i++) expect((await mal('9999')).status).toBe(401);
    const quinto = await mal('9999');
    expect(quinto.status).toBe(401);
    expect(quinto.body.error.message).toMatch(/bloque/i);
    // bloqueado: ni siquiera el PIN correcto entra
    const bloqueado = await kiosco.post('/api/reloj/fichar', { usuario_id: emp.id, pin: '2580', accion: 'entrada' });
    expect(bloqueado.status).toBe(429);
    expect((await t.api.get('/api/taller/usuarios')).body.usuarios.find((u: any) => u.id === emp.id).pin_bloqueado).toBe(true);
    expect((await t.api.post(`/api/taller/usuarios/${emp.id}/pin/desbloquear`, {})).status).toBe(200);
    const ok = await kiosco.post('/api/reloj/fichar', { usuario_id: emp.id, pin: '2580', accion: 'entrada' });
    expect(ok.status).toBe(200);
    // el dispositivo se bloquea tras demasiados fallos sobre cualquier persona
    for (let i = 0; i < 6; i++) await kiosco.post('/api/reloj/fichar', { usuario_id: sinAcceso, pin: '1111', accion: 'entrada' });
    const lim = await kiosco.post('/api/reloj/fichar', { usuario_id: sinAcceso, pin: '1111', accion: 'entrada' });
    expect([401, 429]).toContain(lim.status);
    const tope = await kiosco.post('/api/reloj/fichar', { usuario_id: sinAcceso, pin: '1397', accion: 'entrada' });
    expect(tope.status).toBe(429);
  });

  it('un dispositivo revocado o el modo reloj apagado dejan de funcionar de inmediato', async () => {
    const t2 = await nuevoTaller('Taller reloj 2', 3);
    const u = await nuevoPersonal(t2.api, 'recepcion');
    await t2.api.put(`/api/taller/usuarios/${u.id}/pin`, { pin: '2580' });
    const k = new Api();
    const c = (await t2.api.post('/api/asistencia/dispositivos', { nombre: 'Tablet' })).body;
    await k.post('/api/reloj/activar', { codigo: c.codigo });
    expect((await k.get('/api/reloj/estado')).status).toBe(200);
    expect((await t2.api.put('/api/asistencia/reloj', { activo: false })).status).toBe(200);
    expect((await k.get('/api/reloj/estado')).status).toBe(403);
    expect((await k.post('/api/reloj/fichar', { usuario_id: u.id, pin: '2580', accion: 'entrada' })).status).toBe(403);
    await t2.api.put('/api/asistencia/reloj', { activo: true });
    expect((await k.post('/api/reloj/fichar', { usuario_id: u.id, pin: '2580', accion: 'entrada' })).status).toBe(200);
    expect((await t2.api.post(`/api/asistencia/dispositivos/${c.id}/revocar`, {})).status).toBe(200);
    expect((await k.get('/api/reloj/estado')).status).toBe(401);
    expect((await k.post('/api/reloj/fichar', { usuario_id: u.id, pin: '2580', accion: 'salida' })).status).toBe(401);
    // otro taller no puede revocar ni ver los dispositivos
    expect((await OTRO.api.post(`/api/asistencia/dispositivos/${dispositivo}/revocar`, {})).status).toBe(404);
    expect((await OTRO.api.get('/api/asistencia/dispositivos')).body.dispositivos).toEqual([]);
  });

  it('el dispositivo solo ficha a personas de su propio taller', async () => {
    const ajeno = await nuevoPersonal(OTRO.api, 'recepcion');
    await OTRO.api.put(`/api/taller/usuarios/${ajeno.id}/pin`, { pin: '2580' });
    const r = await kiosco.post('/api/reloj/fichar', { usuario_id: ajeno.id, pin: '2580', accion: 'entrada' });
    expect([401, 429]).toContain(r.status);
    expect((await OTRO.api.get(`/api/asistencia/registros?desde=${hoyAR(-1)}&hasta=${hoyAR(1)}&usuario_id=${ajeno.id}`)).body.filas).toHaveLength(0);
  });
});
