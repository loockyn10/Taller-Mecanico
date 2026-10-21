// Sprint 07: gestión mecánica avanzada — tempario, tareas y participantes de las OT, historial técnico, mantenimientos y productividad.
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, dormir, hoyAR, nuevoPersonal, nuevoTaller } from './cliente';

let T: Awaited<ReturnType<typeof nuevoTaller>>;
let OTRO: Awaited<ReturnType<typeof nuevoTaller>>;
const d: Record<string, any> = {};

const servicioPorCodigo = async (api: Api, codigo: string) => (await api.get('/api/servicios?todos=1')).body.find((s: any) => s.codigo === codigo);

beforeAll(async () => {
  T = await nuevoTaller('Taller Mecánica', 25);
  OTRO = await nuevoTaller('Otro Taller Mecánica', 3);
  d.recepcion = await nuevoPersonal(T.api, 'recepcion');
  d.mecanico = await nuevoPersonal(T.api, 'mecanico');
  d.mecanico2 = await nuevoPersonal(T.api, 'mecanico');
  d.mecanico3 = await nuevoPersonal(T.api, 'mecanico');
  d.admin = await nuevoPersonal(T.api, 'administrador');
  d.caja = await nuevoPersonal(T.api, 'caja');
  d.cliente = (await T.api.post('/api/clientes', { nombre: 'Cliente Mecánica', telefono: '1166' })).body;
  const marcas = (await T.api.get('/api/marcas')).body;
  const fiat = marcas.find((m: any) => m.nombre === 'Fiat');
  const chevrolet = marcas.find((m: any) => m.nombre === 'Chevrolet');
  d.fiat = fiat;
  d.cronos = fiat.modelos.find((m: any) => m.nombre === 'Cronos');
  d.onix = chevrolet.modelos.find((m: any) => m.nombre === 'Onix');
  d.chevrolet = chevrolet;
  d.vehiculo = (await T.api.post('/api/vehiculos', { cliente_id: d.cliente.id, patente: 'MEC111', marca_id: fiat.id, modelo_id: d.cronos.id, anio: 2020, motor: '1.3 Firefly', km_actual: 40000 })).body;
  d.vehiculo2 = (await T.api.post('/api/vehiculos', { cliente_id: d.cliente.id, patente: 'MEC222', marca_id: chevrolet.id, modelo_id: d.onix.id, anio: 2016, km_actual: 90000 })).body;
  const mecs = (await T.api.get('/api/mecanicos')).body;
  d.mecId = mecs.find((m: any) => m.usuario_id === d.mecanico.id).id;
  d.mec2Id = mecs.find((m: any) => m.usuario_id === d.mecanico2.id).id;
});

describe('tempario', () => {
  it('la plantilla es general y de solo lectura; se copia al taller y queda marcada como orientativa', async () => {
    const pl = (await T.api.get('/api/tempario/plantilla')).body;
    expect(pl.aviso).toMatch(/orientativos/);
    expect(pl.operaciones.length).toBeGreaterThan(30);
    const antes = await servicioPorCodigo(T.api, 'SRV-001');
    expect(antes).toBeUndefined(); // todavía no se copió nada
    const exist = (await T.api.get('/api/servicios?todos=1')).body.find((s: any) => s.nombre === 'Service de aceite y filtros');
    const r = await T.api.post('/api/tempario/plantilla/importar', {});
    expect(r.status).toBe(200);
    expect(r.body.creadas).toBeGreaterThan(20);
    expect(r.body.completadas).toBeGreaterThan(5);
    // lo que el taller ya tenía conserva su precio; solo se le completa el tiempo
    const despues = await servicioPorCodigo(T.api, 'SRV-001');
    expect(despues.id).toBe(exist.id);
    expect(despues.precio).toBe(exist.precio);
    expect(despues.tiempo_min).toBe(45);
    expect(despues.origen).toBe('plantilla');
    // lo nuevo se calcula por tiempo
    const filtro = await servicioPorCodigo(T.api, 'SRV-002');
    expect(filtro).toMatchObject({ tiempo_min: 15, modo_precio: 'por_tiempo', origen: 'plantilla' });
    // importar de nuevo no duplica nada
    expect((await T.api.post('/api/tempario/plantilla/importar', {})).body).toEqual({ creadas: 0, completadas: 0 });
    d.filtro = filtro;
  });

  it('cada taller tiene su propio tempario: nada se comparte', async () => {
    expect((await OTRO.api.get('/api/servicios?todos=1')).body.some((s: any) => s.codigo === 'SRV-002')).toBe(false);
    expect((await OTRO.api.get(`/api/tempario/servicios/${d.filtro.id}/tiempos`)).status).toBe(404);
    expect((await OTRO.api.post(`/api/tempario/servicios/${d.filtro.id}/tiempos`, { marca_id: null, motor: '1.0', tiempo_min: 5 })).status).toBe(404);
    expect((await OTRO.api.get(`/api/tempario/estimar?servicio_id=${d.filtro.id}`)).status).toBe(404);
  });

  it('la mano de obra se calcula con la tarifa del taller y el tiempo específico del vehículo gana al genérico', async () => {
    // sin tarifa configurada se conserva el precio cargado
    expect((await T.api.get('/api/servicios?todos=1')).body.find((s: any) => s.codigo === 'SRV-002').precio).toBe(0);
    expect((await T.api.put('/api/tempario/tarifas', { tarifa_hora: 2400000, categorias: [] })).status).toBe(200);
    expect((await T.api.get('/api/tempario/tarifas')).body.tarifa_hora).toBe(2400000);
    let s = (await T.api.get(`/api/servicios?vehiculo_id=${d.vehiculo.id}`)).body.find((x: any) => x.codigo === 'SRV-002');
    expect(s).toMatchObject({ tiempo_efectivo_min: 15, tiempo_origen: 'generico', precio: 600000 });
    // regla por modelo (Cronos): 25 minutos
    const regla = await T.api.post(`/api/tempario/servicios/${d.filtro.id}/tiempos`, { marca_id: d.fiat.id, modelo_id: d.cronos.id, tiempo_min: 25, notas: 'Acceso complicado' });
    expect(regla.status).toBe(201);
    s = (await T.api.get(`/api/servicios?vehiculo_id=${d.vehiculo.id}`)).body.find((x: any) => x.codigo === 'SRV-002');
    expect(s).toMatchObject({ tiempo_efectivo_min: 25, tiempo_origen: 'especifico', precio: 1000000 });
    // otro vehículo sigue con el tiempo general
    s = (await T.api.get(`/api/servicios?vehiculo_id=${d.vehiculo2.id}`)).body.find((x: any) => x.codigo === 'SRV-002');
    expect(s).toMatchObject({ tiempo_efectivo_min: 15, tiempo_origen: 'generico' });
    // una regla por marca y año más específica por motor gana a la de marca
    await T.api.post(`/api/tempario/servicios/${d.filtro.id}/tiempos`, { marca_id: d.chevrolet.id, anio_desde: 2010, anio_hasta: 2018, tiempo_min: 20 });
    const est = (await T.api.get(`/api/tempario/estimar?servicio_id=${d.filtro.id}&vehiculo_id=${d.vehiculo2.id}`)).body;
    expect(est).toMatchObject({ tiempo_min: 20, origen: 'especifico' });
    // la tarifa por categoría reemplaza a la general
    const cat = (await T.api.get('/api/categorias-servicio')).body.find((c: any) => c.nombre === 'Service');
    await T.api.put('/api/tempario/tarifas', { tarifa_hora: 2400000, categorias: [{ id: cat.id, tarifa_hora: 3600000 }] });
    s = (await T.api.get(`/api/servicios?vehiculo_id=${d.vehiculo.id}`)).body.find((x: any) => x.codigo === 'SRV-002');
    expect(s.precio).toBe(1500000); // 25 min a $36.000 la hora
    await T.api.put('/api/tempario/tarifas', { tarifa_hora: 2400000, categorias: [{ id: cat.id, tarifa_hora: null }] });
  });

  it('valida las reglas específicas', async () => {
    const base = `/api/tempario/servicios/${d.filtro.id}/tiempos`;
    expect((await T.api.post(base, { tiempo_min: 10 })).status).toBe(400); // sin ningún criterio
    expect((await T.api.post(base, { marca_id: d.chevrolet.id, modelo_id: d.cronos.id, tiempo_min: 10 })).status).toBe(400); // modelo de otra marca
    expect((await T.api.post(base, { anio_desde: 2020, anio_hasta: 2010, tiempo_min: 10 })).status).toBe(400);
    expect((await T.api.post(base, { marca_id: 'inexistente', tiempo_min: 10 })).status).toBe(400);
  });

  it('editar o confirmar el tiempo orientativo lo vuelve propio del taller', async () => {
    const os = await servicioPorCodigo(T.api, 'SRV-003');
    expect(os.origen).toBe('plantilla');
    expect((await T.api.put(`/api/servicios/${os.id}`, { tiempo_min: 35 })).status).toBe(200);
    expect(await servicioPorCodigo(T.api, 'SRV-003')).toMatchObject({ tiempo_min: 35, origen: 'propio' });
    const os2 = await servicioPorCodigo(T.api, 'SRV-004');
    expect((await T.api.put(`/api/servicios/${os2.id}`, { origen: 'propio' })).status).toBe(200);
    expect((await servicioPorCodigo(T.api, 'SRV-004')).origen).toBe('propio');
  });

  it('respeta permisos: el mecánico no ve el catálogo ni sus precios; recepción ve precios pero no edita el tempario', async () => {
    expect((await d.mecanico.api.get('/api/servicios')).status).toBe(403);
    expect((await d.mecanico.api.get('/api/tempario/tarifas')).status).toBe(403);
    expect((await d.mecanico.api.get('/api/tempario/plantilla')).status).toBe(403);
    expect((await d.recepcion.api.get('/api/servicios')).body[0].precio).toBeDefined();
    expect((await d.recepcion.api.get('/api/tempario/tarifas')).status).toBe(200);
    expect((await d.recepcion.api.put('/api/tempario/tarifas', { tarifa_hora: 1, categorias: [] })).status).toBe(403);
    expect((await d.recepcion.api.post(`/api/tempario/servicios/${d.filtro.id}/tiempos`, { motor: '1.0', tiempo_min: 5 })).status).toBe(403);
    expect((await d.recepcion.api.post('/api/tempario/plantilla/importar', {})).status).toBe(403);
    expect((await d.caja.api.get('/api/tempario/tarifas')).status).toBe(200);
    // sin permiso de precios, la tarifa y los precios no se recuperan de la API
    const sinPrecios = await nuevoPersonal(T.api, 'deposito');
    await T.api.put(`/api/taller/usuarios/${sinPrecios.id}/permisos`, { permisos: ['catalogo.ver', 'asistencia.fichar'] });
    expect((await sinPrecios.api.get('/api/tempario/tarifas')).status).toBe(403);
    const lista = (await sinPrecios.api.get('/api/servicios')).body;
    expect(lista[0].precio).toBeUndefined();
    expect(lista[0].precio_cargado).toBeUndefined();
    expect(lista[0].tarifa_hora).toBeUndefined();
    expect(lista.find((x: any) => x.codigo === 'SRV-002').tiempo_min).toBe(15); // el tiempo es dato técnico
  });
});

describe('tareas, equipo y cronómetro de la OT', () => {
  it('los trabajos con tiempo del tempario se convierten en tareas con su tiempo estimado', async () => {
    const r = await T.api.post('/api/ordenes', {
      cliente_id: d.cliente.id, vehiculo_id: d.vehiculo.id, mecanico_id: d.mecId, falla_reportada: 'Service',
      items: [
        { tipo: 'servicio', servicio_id: d.filtro.id, descripcion: 'Cambio de filtro de aire', cantidad: 2, precio_unitario: 1000000, tiempo_min: 25 },
        { tipo: 'libre', descripcion: 'Insumos varios', cantidad: 1, precio_unitario: 5000 },
      ],
    });
    expect(r.status).toBe(201);
    d.ot = r.body;
    const o = (await T.api.get(`/api/ordenes/${d.ot.id}`)).body;
    expect(o.items.find((i: any) => i.tipo === 'servicio').tiempo_min).toBe(25);
    expect(o.tareas).toHaveLength(1);
    expect(o.tareas[0]).toMatchObject({ descripcion: 'Cambio de filtro de aire', estado: 'pendiente', tiempo_estimado_min: 50, hecha: 0 });
    expect(o.tiempo_estimado_total_min).toBe(50);
    // generar tareas es idempotente
    expect((await T.api.post(`/api/ordenes/${d.ot.id}/tareas/desde-trabajos`)).body.creadas).toBe(0);
    // el mecánico ve el tiempo pero ningún importe
    const m = (await d.mecanico.api.get(`/api/ordenes/${d.ot.id}`)).body;
    expect(m.items[0].tiempo_min).toBe(25);
    expect(m.items[0].precio_unitario).toBeUndefined();
    expect(m.total).toBeUndefined();
    // la conversión de un presupuesto también arma las tareas
    const p = (await T.api.post('/api/presupuestos', { cliente_id: d.cliente.id, vehiculo_id: d.vehiculo.id, items: [{ tipo: 'servicio', servicio_id: d.filtro.id, descripcion: 'Cambio de filtro de aire', cantidad: 1, precio_unitario: 1000000, tiempo_min: 25 }] })).body;
    await T.api.post(`/api/presupuestos/${p.id}/estado`, { estado: 'aprobado' });
    const conv = (await T.api.post(`/api/presupuestos/${p.id}/convertir`, {})).body;
    const oc = (await T.api.get(`/api/ordenes/${conv.id}`)).body;
    expect(oc.tareas).toHaveLength(1);
    expect(oc.tareas[0].tiempo_estimado_min).toBe(25);
  });

  it('recepción asigna responsable y participantes sin tocar importes; el participante ve y trabaja la orden', async () => {
    const rec = d.recepcion.api;
    expect((await d.mecanico2.api.get(`/api/ordenes/${d.ot.id}`)).status).toBe(404); // todavía no figura
    expect((await d.mecanico2.api.get('/api/ordenes')).body.some((o: any) => o.id === d.ot.id)).toBe(false);
    expect((await rec.patch(`/api/ordenes/${d.ot.id}/responsable`, { mecanico_id: d.mecId })).status).toBe(200);
    expect((await rec.put(`/api/ordenes/${d.ot.id}/participantes`, { usuario_ids: [d.mecanico2.id] })).status).toBe(200);
    const o = (await rec.get(`/api/ordenes/${d.ot.id}`)).body;
    expect(o.participantes.map((p: any) => p.usuario_id)).toEqual([d.mecanico2.id]);
    expect(o.participantes_n ?? o.participantes.length).toBe(1);
    expect((await d.mecanico2.api.get('/api/ordenes')).body.some((x: any) => x.id === d.ot.id)).toBe(true);
    expect((await d.mecanico2.api.post(`/api/ordenes/${d.ot.id}/tareas`, { descripcion: 'Revisar correas' })).status).toBe(201);
    // el que no figura no entra; el mecánico no asigna a otros ni cambia el responsable
    expect((await d.mecanico3.api.get(`/api/ordenes/${d.ot.id}`)).status).toBe(404);
    expect((await d.mecanico.api.patch(`/api/ordenes/${d.ot.id}/responsable`, { mecanico_id: d.mec2Id })).status).toBe(403);
    expect((await d.mecanico.api.put(`/api/ordenes/${d.ot.id}/participantes`, { usuario_ids: [d.mecanico3.id] })).status).toBe(403);
    expect((await d.caja.api.put(`/api/ordenes/${d.ot.id}/participantes`, { usuario_ids: [] })).status).toBe(403);
    // otro taller no se puede asignar ni aparece como participante
    expect((await OTRO.api.patch(`/api/ordenes/${d.ot.id}/responsable`, { mecanico_id: null })).status).toBe(404);
    const ajeno = await nuevoPersonal(OTRO.api, 'mecanico');
    expect((await rec.put(`/api/ordenes/${d.ot.id}/participantes`, { usuario_ids: [ajeno.id] })).status).toBe(400);
    // quitar participantes
    expect((await rec.put(`/api/ordenes/${d.ot.id}/participantes`, { usuario_ids: [d.mecanico2.id, d.mecanico3.id] })).status).toBe(200);
    expect((await rec.put(`/api/ordenes/${d.ot.id}/participantes`, { usuario_ids: [d.mecanico2.id] })).status).toBe(200);
    expect((await d.mecanico3.api.get(`/api/ordenes/${d.ot.id}`)).status).toBe(404);
  });

  it('una persona con una tarea a su cargo ve la orden aunque no sea participante', async () => {
    const o = (await T.api.get(`/api/ordenes/${d.ot.id}`)).body;
    const tarea = o.tareas.find((t: any) => t.descripcion === 'Revisar correas');
    // recepción reparte la tarea a mecanico3
    expect((await d.recepcion.api.patch(`/api/ordenes/${d.ot.id}/tareas/${tarea.id}`, { responsable_id: d.mecanico3.id })).status).toBe(200);
    const m3 = (await d.mecanico3.api.get(`/api/ordenes/${d.ot.id}`)).body;
    expect(m3.tareas.find((t: any) => t.id === tarea.id).responsable_id).toBe(d.mecanico3.id);
    // y la devuelve: vuelve a quedar sin acceso
    await d.recepcion.api.patch(`/api/ordenes/${d.ot.id}/tareas/${tarea.id}`, { responsable_id: null });
    expect((await d.mecanico3.api.get(`/api/ordenes/${d.ot.id}`)).status).toBe(404);
  });

  it('el cronómetro por tarea registra estado, responsable y tiempo real', async () => {
    const m = d.mecanico.api;
    const o = (await m.get(`/api/ordenes/${d.ot.id}`)).body;
    const tarea = o.tareas.find((t: any) => t.descripcion === 'Cambio de filtro de aire');
    expect((await m.post(`/api/ordenes/${d.ot.id}/tiempo/iniciar`, { tarea_id: tarea.id })).status).toBe(201);
    let det = (await m.get(`/api/ordenes/${d.ot.id}`)).body;
    expect(det.mi_cronometro.tarea_id).toBe(tarea.id);
    let t1 = det.tareas.find((t: any) => t.id === tarea.id);
    expect(t1).toMatchObject({ estado: 'en_proceso', responsable_id: d.mecanico.id });
    expect((await m.get('/api/ordenes/cronometro/activo')).body).toMatchObject({ orden_id: d.ot.id, tarea_id: tarea.id });
    expect((await m.post(`/api/ordenes/${d.ot.id}/tiempo/iniciar`, {})).status).toBe(409); // un cronómetro a la vez
    await dormir(1200);
    expect((await m.post(`/api/ordenes/${d.ot.id}/tiempo/detener`, {})).status).toBe(200);
    det = (await m.get(`/api/ordenes/${d.ot.id}`)).body;
    t1 = det.tareas.find((t: any) => t.id === tarea.id);
    expect(t1.estado).toBe('pausada');
    expect(t1.tiempo_real_seg).toBeGreaterThanOrEqual(1);
    expect((await m.get('/api/ordenes/cronometro/activo')).body).toBeNull();
    // retomar y terminar: terminar detiene el reloj y deja constancia de quién la completó
    expect((await m.post(`/api/ordenes/${d.ot.id}/tiempo/iniciar`, { tarea_id: tarea.id })).status).toBe(201);
    expect((await m.patch(`/api/ordenes/${d.ot.id}/tareas/${tarea.id}`, { estado: 'completada', observaciones: 'Filtro anterior muy sucio' })).status).toBe(200);
    det = (await m.get(`/api/ordenes/${d.ot.id}`)).body;
    t1 = det.tareas.find((t: any) => t.id === tarea.id);
    expect(t1).toMatchObject({ estado: 'completada', hecha: 1, observaciones: 'Filtro anterior muy sucio' });
    expect(t1.hecha_por).toMatch(/mecanico/);
    expect(det.mi_cronometro).toBeNull();
    // una tarea completada no se puede cronometrar sin reabrirla
    expect((await m.post(`/api/ordenes/${d.ot.id}/tiempo/iniciar`, { tarea_id: tarea.id })).status).toBe(409);
    expect((await m.patch(`/api/ordenes/${d.ot.id}/tareas/${tarea.id}`, { estado: 'pendiente' })).status).toBe(200);
    // una tarea de otra orden no se puede cronometrar en ésta
    expect((await m.post(`/api/ordenes/${d.ot.id}/tiempo/iniciar`, { tarea_id: 'no-existe' })).status).toBe(400);
  });

  it('un mecánico no cambia importes ni entrega la orden; al dejarla lista se cierran los cronómetros', async () => {
    const m = d.mecanico.api;
    const o = (await m.get(`/api/ordenes/${d.ot.id}`)).body;
    expect((await m.put(`/api/ordenes/${d.ot.id}`, { ...o, items: [], version: o.version })).status).toBe(403);
    expect((await m.post(`/api/ordenes/${d.ot.id}/comprobante`, {})).status).toBe(403);
    // inicia el reloj en otra tarea y deja la orden lista: no queda nada corriendo
    const tarea = o.tareas.find((t: any) => t.descripcion === 'Cambio de filtro de aire');
    expect((await m.post(`/api/ordenes/${d.ot.id}/tiempo/iniciar`, { tarea_id: tarea.id })).status).toBe(201);
    expect((await m.post(`/api/ordenes/${d.ot.id}/estado`, { estado: 'en_reparacion' })).status).toBe(200);
    expect((await m.post(`/api/ordenes/${d.ot.id}/estado`, { estado: 'lista' })).status).toBe(200);
    expect((await m.post(`/api/ordenes/${d.ot.id}/estado`, { estado: 'entregada' })).status).toBe(403);
    const det = (await m.get(`/api/ordenes/${d.ot.id}`)).body;
    expect(det.mi_cronometro).toBeNull();
    expect(det.tareas.find((t: any) => t.id === tarea.id).estado).toBe('pausada');
    // resultado del trabajo
    expect((await m.patch(`/api/ordenes/${d.ot.id}/tecnico`, { resultado: 'Filtro cambiado, prueba de ruta correcta' })).status).toBe(200);
    expect((await m.get(`/api/ordenes/${d.ot.id}`)).body).toMatchObject({ resultado: 'Filtro cambiado, prueba de ruta correcta' });
    // solo recepción entrega
    expect((await d.recepcion.api.post(`/api/ordenes/${d.ot.id}/estado`, { estado: 'entregada' })).status).toBe(200);
    expect((await m.post(`/api/ordenes/${d.ot.id}/tareas`, { descripcion: 'tarde' })).status).toBe(409);
    expect((await d.recepcion.api.patch(`/api/ordenes/${d.ot.id}/responsable`, { mecanico_id: null })).status).toBe(409);
  });
});

describe('historial técnico del vehículo', () => {
  it('se arma con las órdenes: trabajos, repuestos, mecánicos y tiempos, y el mecánico no ve importes', async () => {
    const h = (await d.mecanico.api.get(`/api/vehiculos/${d.vehiculo.id}/historial-tecnico`)).body;
    const e = h.entradas.find((x: any) => x.id === d.ot.id);
    expect(e).toMatchObject({ origen: 'fierro', numero: d.ot.numero, resultado: 'Filtro cambiado, prueba de ruta correcta', km: null });
    expect(e.trabajos.map((t: any) => t.descripcion)).toContain('Cambio de filtro de aire');
    expect(e.mecanicos.map((m: any) => m.nombre).join()).toMatch(/mecanico/);
    expect(e.mecanicos.find((m: any) => m.responsable)).toBeTruthy();
    expect(e.tareas[0]).toHaveProperty('tiempo_estimado_min');
    expect(e.total).toBeUndefined();
    expect(JSON.stringify(h)).not.toMatch(/precio_unitario|costo/);
    // con permiso de importes sí aparece el total
    const rec = (await d.recepcion.api.get(`/api/vehiculos/${d.vehiculo.id}/historial-tecnico`)).body.entradas.find((x: any) => x.id === d.ot.id);
    expect(rec.total).toBeGreaterThan(0);
  });

  it('permite cargar antecedentes anteriores a Fierro, diferenciados de las órdenes, y anularlos', async () => {
    const rec = d.recepcion.api;
    const r = await rec.post(`/api/vehiculos/${d.vehiculo.id}/antecedentes`, { fecha: hoyAR(-400), km: 20000, tipo: 'reparacion', descripcion: 'Cambio de embrague en otro taller', realizado_por: 'Taller Pérez', repuestos: 'Kit de embrague' });
    expect(r.status).toBe(201);
    expect((await rec.post(`/api/vehiculos/${d.vehiculo.id}/antecedentes`, { fecha: hoyAR(5), descripcion: 'Futuro' })).status).toBe(400);
    expect((await d.mecanico.api.post(`/api/vehiculos/${d.vehiculo.id}/antecedentes`, { fecha: hoyAR(-1), descripcion: 'Intento' })).status).toBe(403);
    let h = (await d.mecanico.api.get(`/api/vehiculos/${d.vehiculo.id}/historial-tecnico`)).body;
    const man = h.entradas.find((x: any) => x.id === r.body.id);
    expect(man).toMatchObject({ origen: 'manual', tipo: 'reparacion', realizado_por: 'Taller Pérez', km: 20000 });
    expect(h.resumen.antecedentes).toBe(1);
    // ordenado cronológicamente: la OT (hoy) antes que el antecedente (hace más de un año)
    expect(h.entradas.findIndex((x: any) => x.id === d.ot.id)).toBeLessThan(h.entradas.findIndex((x: any) => x.id === r.body.id));
    expect((await rec.put(`/api/antecedentes/${r.body.id}`, { fecha: hoyAR(-400), km: 20500, tipo: 'reparacion', descripcion: 'Cambio de embrague (corregido)' })).status).toBe(200);
    // el otro taller no lo ve ni lo toca
    expect((await OTRO.api.get(`/api/vehiculos/${d.vehiculo.id}/historial-tecnico`)).status).toBe(404);
    expect((await OTRO.api.del(`/api/antecedentes/${r.body.id}`)).status).toBe(404);
    expect((await rec.del(`/api/antecedentes/${r.body.id}`)).status).toBe(200);
    h = (await rec.get(`/api/vehiculos/${d.vehiculo.id}/historial-tecnico`)).body;
    expect(h.entradas.some((x: any) => x.id === r.body.id)).toBe(false);
    expect((await rec.del(`/api/antecedentes/${r.body.id}`)).status).toBe(404);
  });
});

describe('mantenimientos programados', () => {
  it('calcula vencimientos con el km de las OT y los antecedentes, y respeta los intervalos del plan', async () => {
    const rec = d.recepcion.api;
    const aceite = await servicioPorCodigo(T.api, 'SRV-001'); // 10.000 km / 12 meses
    d.aceite = aceite;
    // plan sin registro previo
    expect((await rec.put(`/api/vehiculos/${d.vehiculo2.id}/mantenimientos/${aceite.id}`, {})).status).toBe(200);
    let lista = (await rec.get(`/api/vehiculos/${d.vehiculo2.id}/mantenimientos`)).body;
    expect(lista.find((m: any) => m.servicio_id === aceite.id)).toMatchObject({ estado: 'sin_registro', programado: true });
    // última vez informada: hace 14.000 km sobre un vehículo de 90.000 km → vencido
    expect((await rec.put(`/api/vehiculos/${d.vehiculo2.id}/mantenimientos/${aceite.id}`, { ultima: { fecha: hoyAR(-60), km: 76000 } })).status).toBe(200);
    lista = (await rec.get(`/api/vehiculos/${d.vehiculo2.id}/mantenimientos`)).body;
    const m = lista.find((x: any) => x.servicio_id === aceite.id);
    expect(m).toMatchObject({ estado: 'vencido', proximo_km: 86000, km_realizado: 76000, origen_realizado: 'antecedente' });
    expect(m.km_restantes).toBe(-4000);
    // un intervalo propio del plan reemplaza al del servicio: cada 20.000 km ya no está vencido
    expect((await rec.put(`/api/vehiculos/${d.vehiculo2.id}/mantenimientos/${aceite.id}`, { intervalo_km: 20000, intervalo_meses: 12 })).status).toBe(200);
    lista = (await rec.get(`/api/vehiculos/${d.vehiculo2.id}/mantenimientos`)).body;
    expect(lista.find((x: any) => x.servicio_id === aceite.id)).toMatchObject({ estado: 'al_dia', proximo_km: 96000, intervalo_km: 20000 });
    // 5.000 km más y queda próximo (≤ 1.000 km)
    await T.api.put(`/api/vehiculos/${d.vehiculo2.id}`, { km_actual: 95500 });
    lista = (await rec.get(`/api/vehiculos/${d.vehiculo2.id}/mantenimientos`)).body;
    expect(lista.find((x: any) => x.servicio_id === aceite.id)).toMatchObject({ estado: 'proximo', km_restantes: 500 });
    // pausar el plan lo saca de los avisos
    expect((await rec.put(`/api/vehiculos/${d.vehiculo2.id}/mantenimientos/${aceite.id}`, { activo: false })).status).toBe(200);
    expect((await rec.get(`/api/vehiculos/${d.vehiculo2.id}/mantenimientos`)).body.some((x: any) => x.servicio_id === aceite.id)).toBe(false);
    // sin ningún intervalo no se puede programar
    const sinInt = await servicioPorCodigo(T.api, 'MOT-001');
    expect((await rec.put(`/api/vehiculos/${d.vehiculo2.id}/mantenimientos/${sinInt.id}`, {})).status).toBe(400);
    expect((await rec.put(`/api/vehiculos/${d.vehiculo2.id}/mantenimientos/${aceite.id}`, { ultima: { fecha: hoyAR(3) } })).status).toBe(400);
  });

  it('una OT terminada con la operación pasa a ser la última realización', async () => {
    const rec = d.recepcion.api;
    await rec.put(`/api/vehiculos/${d.vehiculo2.id}/mantenimientos/${d.aceite.id}`, { activo: true, intervalo_km: 10000, intervalo_meses: 6 });
    const ot = (await rec.post('/api/ordenes', { cliente_id: d.cliente.id, vehiculo_id: d.vehiculo2.id, km_ingreso: 96000, items: [{ tipo: 'servicio', servicio_id: d.aceite.id, descripcion: 'Service de aceite y filtros', cantidad: 1, precio_unitario: 6000000 }] })).body;
    let m = (await rec.get(`/api/vehiculos/${d.vehiculo2.id}/mantenimientos`)).body.find((x: any) => x.servicio_id === d.aceite.id);
    expect(m.km_realizado).toBe(76000); // todavía no se terminó la OT
    await T.api.post(`/api/ordenes/${ot.id}/estado`, { estado: 'lista' });
    m = (await rec.get(`/api/vehiculos/${d.vehiculo2.id}/mantenimientos`)).body.find((x: any) => x.servicio_id === d.aceite.id);
    expect(m).toMatchObject({ km_realizado: 96000, origen_realizado: 'orden', orden_numero: ot.numero, estado: 'al_dia', proximo_km: 106000 });
    const hist = (await rec.get(`/api/vehiculos/${d.vehiculo2.id}/mantenimientos/${d.aceite.id}/historial`)).body;
    expect(hist.map((x: any) => x.origen)).toEqual(['orden', 'antecedente']);
  });

  it('lista vencidos y próximos del taller, con permisos y aislamiento', async () => {
    const lst = (await d.recepcion.api.get('/api/mantenimientos?estado=todos')).body;
    expect(lst.resumen).toHaveProperty('vencido');
    expect(lst.items.every((x: any) => x.cliente !== undefined)).toBe(true);
    // el mecánico los ve sin datos del cliente
    const mec = (await d.mecanico.api.get('/api/mantenimientos?estado=todos')).body;
    expect(mec.items.length).toBeGreaterThan(0);
    expect(mec.items.every((x: any) => x.cliente === undefined && x.cliente_telefono === undefined && x.cliente_id === undefined)).toBe(true);
    expect((await d.mecanico.api.put(`/api/vehiculos/${d.vehiculo2.id}/mantenimientos/${d.aceite.id}`, {})).status).toBe(403);
    expect((await d.caja.api.get('/api/mantenimientos')).status).toBe(403);
    // el recordatorio de service anterior sigue disponible
    expect(Array.isArray((await T.api.get('/api/recordatorios')).body)).toBe(true);
    // otro taller: lista vacía y 404 sobre vehículos y operaciones ajenos
    expect((await OTRO.api.get('/api/mantenimientos?estado=todos')).body.items).toHaveLength(0);
    expect((await OTRO.api.get(`/api/vehiculos/${d.vehiculo2.id}/mantenimientos`)).status).toBe(404);
    expect((await OTRO.api.put(`/api/vehiculos/${d.vehiculo2.id}/mantenimientos/${d.aceite.id}`, { intervalo_km: 1000 })).status).toBe(404);
  });
});

describe('productividad', () => {
  it('separa horas de asistencia de horas registradas en OT y cuenta órdenes, tareas y carga', async () => {
    const hoy = hoyAR();
    // el mecánico ficha y trabaja en una orden nueva
    expect((await d.mecanico.api.post('/api/asistencia/entrada')).status).toBe(201);
    const ot = (await d.recepcion.api.post('/api/ordenes', { cliente_id: d.cliente.id, vehiculo_id: d.vehiculo.id, mecanico_id: d.mecId, items: [{ tipo: 'libre', descripcion: 'Revisión', cantidad: 1, precio_unitario: 20000 }] })).body;
    const t = (await d.mecanico.api.post(`/api/ordenes/${ot.id}/tareas`, { descripcion: 'Revisar luces', tiempo_estimado_min: 30 })).body;
    await d.mecanico.api.post(`/api/ordenes/${ot.id}/tiempo/iniciar`, { tarea_id: t.id });
    await dormir(1200);
    await d.mecanico.api.patch(`/api/ordenes/${ot.id}/tareas/${t.id}`, { estado: 'completada' });
    const q = `desde=${hoy}&hasta=${hoy}`;
    const p = (await T.api.get(`/api/productividad?${q}`)).body;
    expect(p.nota).toMatch(/no equivale a tiempo improductivo/);
    expect(p.taller.pendientes).toBeGreaterThanOrEqual(1);
    expect(p.taller.completadas_periodo).toBeGreaterThanOrEqual(1);
    expect(p.taller).toHaveProperty('tiempo_promedio_en_taller_horas');
    expect(p.taller.mano_obra_completadas).toBeGreaterThan(0); // el propietario ve los importes
    const fila = p.mecanicos.find((x: any) => x.usuario_id === d.mecanico.id);
    expect(fila.registrado_ot_seg).toBeGreaterThanOrEqual(1);
    expect(fila.dias_asistencia).toBe(1);
    expect(fila.tareas_completadas).toBeGreaterThanOrEqual(1);
    expect(fila.comparables).toBe(1);
    expect(fila.estimado_min).toBe(30);
    expect(fila.real_seg).toBeGreaterThanOrEqual(1);
    expect(fila.ot_abiertas).toBeGreaterThanOrEqual(1);
    // no existe ningún indicador de "improductividad"
    expect(JSON.stringify(p)).not.toMatch(/improductiv(o|a)s?_|ocio|perdid/i);
    await d.mecanico.api.post('/api/asistencia/salida').catch(() => undefined);
  });

  it('los indicadores respetan permisos: sin importes si no ve valorizados, y sin acceso para quien no tiene el permiso', async () => {
    const hoy = hoyAR();
    const q = `desde=${hoy}&hasta=${hoy}`;
    expect((await d.recepcion.api.get(`/api/productividad?${q}`)).status).toBe(403);
    expect((await d.mecanico.api.get(`/api/productividad?${q}`)).status).toBe(403);
    const jefe = await nuevoPersonal(T.api, 'mecanico');
    await T.api.put(`/api/taller/usuarios/${jefe.id}/permisos`, { permisos: ['vehiculos.ver', 'ordenes.asignadas', 'productividad.ver', 'asistencia.fichar'] });
    const sin = (await jefe.api.get(`/api/productividad?${q}`)).body;
    expect(sin.taller.mano_obra_completadas).toBeUndefined();
    expect(sin.taller.pendientes).toBeDefined();
    const adm = (await d.admin.api.get(`/api/productividad?${q}`)).body;
    expect(adm.taller.mano_obra_completadas).toBeDefined();
    expect((await T.api.get(`/api/productividad?desde=${hoy}&hasta=${hoyAR(-1)}`)).status).toBe(400);
    expect((await T.api.get('/api/productividad?desde=2000-01-01&hasta=2026-01-01')).status).toBe(400);
  });

  it('cada persona ve sus propios indicadores y cada taller solo los suyos', async () => {
    const hoy = hoyAR();
    const mia = (await d.mecanico.api.get(`/api/productividad/mia?desde=${hoy}&hasta=${hoy}`)).body;
    expect(mia.yo.usuario_id).toBe(d.mecanico.id);
    expect(mia.yo.tareas_completadas).toBeGreaterThanOrEqual(1);
    expect(mia.yo.cargo === undefined || typeof mia.yo.cargo !== 'number').toBe(true);
    const sinOrdenes = await nuevoPersonal(T.api, 'caja');
    await T.api.put(`/api/taller/usuarios/${sinOrdenes.id}/permisos`, { permisos: ['asistencia.fichar'] });
    expect((await sinOrdenes.api.get(`/api/productividad/mia?desde=${hoy}&hasta=${hoy}`)).status).toBe(403);
    const otro = (await OTRO.api.get(`/api/productividad?desde=${hoy}&hasta=${hoy}`)).body;
    expect(otro.taller).toMatchObject({ pendientes: 0, en_proceso: 0, completadas_periodo: 0, tareas_completadas: 0, registrado_ot_seg: 0 });
    expect(otro.mecanicos.some((m: any) => m.usuario_id === d.mecanico.id)).toBe(false);
  });
});
