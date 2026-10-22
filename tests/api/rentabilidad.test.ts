// Sprint 09: costo de mano de obra (por persona y general), rentabilidad histórica de las OT y stock mínimo por depósito.
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, dormir, hoyAR, idem, nuevoPersonal, nuevoTaller } from './cliente';

let T: Awaited<ReturnType<typeof nuevoTaller>>;
let OTRO: Awaited<ReturnType<typeof nuevoTaller>>;
let api: Api;
const d: Record<string, any> = {};

const HORA = 3600000; // $36.000 por hora, en centavos: 1.000 centavos por segundo trabajado
const rentab = async (id: string, a: Api = api) => (await a.get(`/api/ordenes/${id}/rentabilidad`)).body;

/** Crea una OT con un trabajo del tempario de 60 min, la trabaja `ms` milisegundos con el cronómetro, la completa y la deja lista. */
async function otTrabajada(mecanico: { api: Api; id: string }, precio = 50000, ms = 1100, extraItems: any[] = [], terminar = true) {
  const ot = (await api.post('/api/ordenes', {
    cliente_id: d.cliente.id, vehiculo_id: d.vehiculo.id, falla_reportada: 'Prueba de costos',
    items: [{ tipo: 'servicio', servicio_id: d.servicio.id, descripcion: 'Cambio de distribución', cantidad: 1, precio_unitario: precio, tiempo_min: 60 }, ...extraItems],
  })).body;
  await api.put(`/api/ordenes/${ot.id}/participantes`, { usuario_ids: [mecanico.id] });
  const det = (await api.get(`/api/ordenes/${ot.id}`)).body;
  const tarea = det.tareas[0];
  expect((await mecanico.api.post(`/api/ordenes/${ot.id}/tiempo/iniciar`, { tarea_id: tarea.id })).status).toBe(201);
  await dormir(ms);
  expect((await mecanico.api.patch(`/api/ordenes/${ot.id}/tareas/${tarea.id}`, { estado: 'completada' })).status).toBe(200);
  if (terminar) expect((await api.post(`/api/ordenes/${ot.id}/estado`, { estado: 'lista' })).status).toBe(200);
  return ot;
}

beforeAll(async () => {
  T = await nuevoTaller('Taller Rentabilidad', 12);
  OTRO = await nuevoTaller('Otro Taller Rentabilidad', 2);
  api = T.api;
  d.recepcion = await nuevoPersonal(api, 'recepcion');
  d.mecanico = await nuevoPersonal(api, 'mecanico');
  d.mecanico2 = await nuevoPersonal(api, 'mecanico');
  d.caja = await nuevoPersonal(api, 'caja');
  d.admin = await nuevoPersonal(api, 'administrador');
  d.cliente = (await api.post('/api/clientes', { nombre: 'Cliente Rentabilidad', telefono: '1155' })).body;
  d.vehiculo = (await api.post('/api/vehiculos', { cliente_id: d.cliente.id, patente: 'REN111' })).body;
  d.servicio = (await api.post('/api/servicios', { nombre: 'Cambio de distribución', precio: 50000 })).body;
});

describe('costo horario de la mano de obra', () => {
  it('lo configuran solo quienes tienen permisos económicos y nunca lo ven los demás', async () => {
    expect((await api.get('/api/costos-mano-obra')).body).toMatchObject({ general: null });
    for (const u of [d.mecanico, d.recepcion, d.caja]) {
      expect((await u.api.get('/api/costos-mano-obra')).status).toBe(403);
      expect((await u.api.put('/api/costos-mano-obra', { general: 1 })).status).toBe(403);
    }
    const r = await api.put('/api/costos-mano-obra', { general: HORA, personas: [{ usuario_id: d.mecanico2.id, costo_hora: 2 * HORA }] });
    expect(r.status).toBe(200);
    const cfg = (await api.get('/api/costos-mano-obra')).body;
    expect(cfg.general).toBe(HORA);
    expect(cfg.personas.find((p: any) => p.usuario_id === d.mecanico2.id)).toMatchObject({ costo_hora: 2 * HORA, mecanico: true });
    expect(cfg.personas.find((p: any) => p.usuario_id === d.mecanico.id).costo_hora).toBeNull();
    // otro taller: ni ve ni toca personas ajenas
    expect((await OTRO.api.put('/api/costos-mano-obra', { personas: [{ usuario_id: d.mecanico.id, costo_hora: 1 }] })).status).toBe(400);
    expect((await OTRO.api.get('/api/costos-mano-obra')).body.general).toBeNull();
    // el administrador (tiene márgenes y gestión de precios) también puede; el costo no aparece en la configuración general para quien no tiene márgenes
    expect((await d.admin.api.get('/api/costos-mano-obra')).status).toBe(200);
    expect((await d.recepcion.api.get('/api/taller/config')).body.config.costo_hora_general).toBeUndefined();
    expect((await d.mecanico.api.get('/api/taller/config')).body.config.costo_hora_general).toBeUndefined();
    expect((await api.get('/api/taller/config')).body.config.costo_hora_general).toBe(HORA);
    // los listados de personal no exponen el costo
    const lista = (await api.get('/api/taller/usuarios')).body.usuarios;
    expect(JSON.stringify(lista)).not.toMatch(/costo_hora/);
    expect((await d.mecanico.api.get('/api/taller/usuarios')).status).toBe(403);
    // las auditorías no guardan importes
    const aud = (await api.get('/api/taller/auditoria')).body.filter((a: any) => a.entidad === 'costos_mano_obra');
    expect(aud.length).toBeGreaterThan(0);
    expect(JSON.stringify(aud)).not.toMatch(String(HORA));
    expect((await api.put('/api/costos-mano-obra', { general: -1 })).status).toBe(400);
  });
});

describe('rentabilidad de la OT con mano de obra', () => {
  it('sin costo configurado el margen es parcial y no se reconstruye con costos posteriores', async () => {
    // otro taller de pruebas aislado de la configuración: este taller ya tiene costo general, así que se usa la persona sin costo propio y se quita el general
    await api.put('/api/costos-mano-obra', { general: null });
    const ot = await otTrabajada(d.mecanico);
    const r = await rentab(ot.id);
    expect(r.resumen).toMatchObject({ calidad: 'parcial', mo_base: 'parcial', mo_cobrada: 50000, cerrada: true });
    expect(r.resumen.mo_segundos).toBeGreaterThanOrEqual(1);
    expect(r.resumen.mo_costo_real).toBe(0);
    expect(r.resumen.faltantes.join(' ')).toMatch(/sin costo horario/);
    // la estimación congelada al cerrar tampoco existe (no había costo): la orden queda marcada como incompleta
    expect(r.resumen).toMatchObject({ mo_estimado_congelado: true, mo_estimado_completo: false });
    // configurar el costo después NO reescribe la historia
    await api.put('/api/costos-mano-obra', { general: HORA });
    const despues = await rentab(ot.id);
    expect(despues.resumen).toMatchObject({ calidad: 'parcial', mo_costo_real: 0, mo_segundos_sin_costo: r.resumen.mo_segundos_sin_costo });
    d.otParcial = ot;
  });

  it('con costo general: el tramo congela el costo, el estimado queda guardado y cambiar el costo no altera lo ya cerrado', async () => {
    const ot = await otTrabajada(d.mecanico); // sin costo propio → usa el general
    const r = (await rentab(ot.id)).resumen;
    expect(r.mo_segundos).toBeGreaterThanOrEqual(1);
    expect(r.mo_costo_real).toBe(Math.round((r.mo_segundos * HORA) / 3600));
    expect(r).toMatchObject({ mo_base: 'real', calidad: 'definitivo', mo_estimado_congelado: true, mo_estimado_completo: true, mo_costo_estimado: HORA, mo_cobrada: 50000, repuestos_venta: 0, faltantes: [] });
    expect(r.margen_bruto).toBe(50000 - r.mo_costo_real);
    const tramos = (await api.get(`/api/ordenes/${ot.id}`)).body.tiempos;
    expect(tramos.length).toBeGreaterThan(0);
    // sube el costo general y el de la persona: la OT cerrada no cambia
    await api.put('/api/costos-mano-obra', { general: 5 * HORA, personas: [{ usuario_id: d.mecanico.id, costo_hora: 9 * HORA }] });
    const r2 = (await rentab(ot.id)).resumen;
    expect(r2).toMatchObject({ mo_costo_real: r.mo_costo_real, mo_costo_estimado: HORA, margen_bruto: r.margen_bruto, calidad: 'definitivo' });
    d.otGeneral = ot;
  });

  it('con costo propio de la persona se usa ese; el estimado usa el costo del responsable de cada tarea', async () => {
    const ot = await otTrabajada(d.mecanico2, 80000); // mecanico2 tiene 2×HORA
    const r = (await rentab(ot.id)).resumen;
    expect(r.mo_costo_real).toBe(Math.round((r.mo_segundos * 2 * HORA) / 3600));
    expect(r.mo_costo_estimado).toBe(2 * HORA); // 60 min × 2×HORA
    expect(r.margen_bruto).toBe(80000 - r.mo_costo_real);
    // mecánico 1 ahora cuesta 9×HORA: se usa su propio costo
    const ot2 = await otTrabajada(d.mecanico);
    expect((await rentab(ot2.id)).resumen).toMatchObject({ mo_costo_estimado: 9 * HORA });
    expect((await rentab(ot2.id)).resumen.mo_costo_real).toBe(Math.round(((await rentab(ot2.id)).resumen.mo_segundos * 9 * HORA) / 3600));
  });

  it('una OT abierta es provisoria; reabrirla descarta la estimación congelada y al cerrarla de nuevo se vuelve a congelar', async () => {
    const abierta = await otTrabajada(d.mecanico2, 40000, 1100, [], false);
    const r = (await rentab(abierta.id)).resumen;
    expect(r).toMatchObject({ cerrada: false, calidad: 'estimado', mo_estimado_congelado: false });
    expect(r.faltantes.join(' ')).toMatch(/todavía está abierta/);
    expect((await api.post(`/api/ordenes/${abierta.id}/estado`, { estado: 'lista' })).status).toBe(200);
    expect((await rentab(abierta.id)).resumen).toMatchObject({ cerrada: true, mo_estimado_congelado: true, mo_costo_estimado: 2 * HORA });
    expect((await api.post(`/api/ordenes/${abierta.id}/estado`, { estado: 'en_reparacion' })).status).toBe(200);
    expect((await rentab(abierta.id)).resumen).toMatchObject({ cerrada: false, mo_estimado_congelado: false });
    // el costo de la persona cambia mientras está abierta: al volver a cerrar se congela el vigente
    await api.put('/api/costos-mano-obra', { personas: [{ usuario_id: d.mecanico2.id, costo_hora: 3 * HORA }] });
    expect((await api.post(`/api/ordenes/${abierta.id}/estado`, { estado: 'lista' })).status).toBe(200);
    expect((await rentab(abierta.id)).resumen.mo_costo_estimado).toBe(3 * HORA);
    // el tramo anterior (costo 2×HORA) conserva su costo
    const r2 = (await rentab(abierta.id)).resumen;
    expect(r2.mo_costo_real).toBe(Math.round((r2.mo_segundos * 2 * HORA) / 3600));
    d.otAbierta = abierta;
  });

  it('un repuesto sin descontar del stock y el costo de repuestos se combinan en el margen; las devoluciones lo ajustan', async () => {
    const art = (await api.post('/api/articulos', { nombre: 'Kit distribución', costo: 20000, precio: 35000, stock_inicial: 5 })).body;
    const ot = await otTrabajada(d.mecanico2, 60000, 1100, [{ tipo: 'articulo', articulo_id: art.id, descripcion: 'Kit distribución', cantidad: 1, precio_unitario: 35000 }]);
    const r = (await rentab(ot.id)).resumen;
    expect(r).toMatchObject({ mo_cobrada: 60000, repuestos_venta: 35000, repuestos_costo: 20000, repuestos_costo_estimado: false, calidad: 'definitivo' });
    expect(r.margen_bruto).toBe(60000 + 35000 - 20000 - r.mo_costo_real);
    // comprobante de la OT y devolución del repuesto (vuelve al inventario) + parte de la mano de obra
    const comp = (await api.post(`/api/ordenes/${ot.id}/comprobante`, { condicion: 'cuenta_corriente' })).body;
    const v = (await api.get(`/api/ventas/${comp.id}`)).body;
    const lArt = v.items.find((i: any) => i.tipo === 'articulo');
    const lSrv = v.items.find((i: any) => i.tipo === 'servicio');
    const nc = await api.post('/api/devoluciones', { venta_id: comp.id, motivo: 'Bonificación y repuesto sobrante', idem_key: idem(), items: [{ venta_item_id: lArt.id, cantidad: 1, reingresa: true }, { venta_item_id: lSrv.id, cantidad: 1, importe: 10000 }] });
    expect(nc.status).toBe(201);
    const r2 = (await rentab(ot.id)).resumen;
    expect(r2).toMatchObject({ mo_cobrada: 50000, mo_devuelta: 10000, repuestos_venta: 0, repuestos_devuelto: 35000, repuestos_costo: 0 });
    expect(r2.margen_bruto).toBe(50000 - r2.mo_costo_real);
    // si el repuesto devuelto NO vuelve al inventario, su costo sigue siendo una pérdida
    const ot3 = await otTrabajada(d.mecanico2, 10000, 1100, [{ tipo: 'articulo', articulo_id: art.id, descripcion: 'Kit distribución', cantidad: 1, precio_unitario: 35000 }]);
    const comp3 = (await api.post(`/api/ordenes/${ot3.id}/comprobante`, { condicion: 'cuenta_corriente' })).body;
    const l3 = (await api.get(`/api/ventas/${comp3.id}`)).body.items.find((i: any) => i.tipo === 'articulo');
    await api.post('/api/devoluciones', { venta_id: comp3.id, motivo: 'Dañado en el taller', idem_key: idem(), items: [{ venta_item_id: l3.id, cantidad: 1, reingresa: false }] });
    expect((await rentab(ot3.id)).resumen).toMatchObject({ repuestos_venta: 0, repuestos_costo: 20000 });
  });

  it('la rentabilidad y los costos son confidenciales y se aíslan por taller', async () => {
    const ot = d.otGeneral;
    for (const u of [d.mecanico, d.recepcion, d.caja]) expect((await u.api.get(`/api/ordenes/${ot.id}/rentabilidad`)).status).toBe(403);
    expect((await d.admin.api.get(`/api/ordenes/${ot.id}/rentabilidad`)).status).toBe(200);
    expect((await OTRO.api.get(`/api/ordenes/${ot.id}/rentabilidad`)).status).toBe(404);
    // los datos de costo no viajan en la ficha de la OT para quien no tiene márgenes
    const m = (await d.mecanico.api.get(`/api/ordenes/${ot.id}`)).body;
    expect(JSON.stringify(m)).not.toMatch(/mo_costo|costo_hora|mo_estimado/);
    const rec = (await d.recepcion.api.get(`/api/ordenes/${ot.id}`)).body;
    expect(JSON.stringify(rec)).not.toMatch(/mo_costo|costo_hora|mo_estimado/);
    const lista = (await d.recepcion.api.get('/api/ordenes')).body;
    expect(JSON.stringify(lista)).not.toMatch(/mo_costo|costo_hora|mo_estimado/);
    expect(JSON.stringify((await api.get(`/api/ordenes/${ot.id}`)).body)).toMatch(/mo_costo_estimado/);
    // los tramos del cronómetro no exponen el costo horario a nadie por la ficha de la OT
    expect(JSON.stringify((await api.get(`/api/ordenes/${ot.id}`)).body.tiempos)).not.toMatch(/costo/);
  });
});

describe('stock mínimo por depósito', () => {
  it('se configura por depósito, convive con el mínimo general y alerta por depósito', async () => {
    d.principal = (await api.get('/api/depositos')).body.find((x: any) => x.es_principal);
    d.camioneta = { id: (await api.post('/api/depositos', { nombre: 'Camioneta' })).body.id };
    d.prov = (await api.post('/api/proveedores', { nombre: 'Proveedor Mínimos', cuit: '30-71234567-1' })).body;
    d.aceite = (await api.post('/api/articulos', { nombre: 'Aceite 5W30', costo: 10000, precio: 18000, stock_inicial: 20, stock_minimo: 6, proveedor_id: d.prov.id })).body;
    d.filtro = (await api.post('/api/articulos', { nombre: 'Filtro mínimo', costo: 3000, precio: 6000, stock_inicial: 10, proveedor_id: d.prov.id })).body;
    // 8 al mostrador/camioneta
    expect((await api.post('/api/transferencias', { origen_id: d.principal.id, destino_id: d.camioneta.id, items: [{ articulo_id: d.aceite.id, cantidad: 4 }], idem_key: idem() })).status).toBe(201);
    // mínimo por depósito: camioneta 5 (tiene 4), principal 10 (tiene 16)
    const put = await api.put(`/api/articulos/${d.aceite.id}/minimos-deposito`, { minimos: [{ deposito_id: d.camioneta.id, minimo: 5, objetivo: 12 }, { deposito_id: d.principal.id, minimo: 10 }] });
    expect(put.status).toBe(200);
    const det = (await api.get(`/api/articulos/${d.aceite.id}`)).body;
    expect(det.minimos_deposito).toEqual(expect.arrayContaining([expect.objectContaining({ deposito_id: d.camioneta.id, minimo: 5, objetivo: 12 })]));
    expect(det.stock_minimo).toBe(6); // el general se conserva
    // alerta por depósito: solo la camioneta está bajo su mínimo
    const rep = (await api.get(`/api/reposicion?deposito_id=${d.camioneta.id}`)).body;
    expect(rep).toHaveLength(1);
    expect(rep[0]).toMatchObject({ id: d.aceite.id, deposito: 'Camioneta', stock: 4, stock_minimo: 5, objetivo: 12, sugerido: 8 });
    expect((await api.get(`/api/reposicion?deposito_id=${d.principal.id}`)).body).toHaveLength(0);
    // el modo general no cambia: el total 20 no está bajo el mínimo general de 6
    expect((await api.get('/api/reposicion')).body.some((x: any) => x.id === d.aceite.id)).toBe(false);
    // vista de todos los depósitos
    const todos = (await api.get('/api/reposicion?deposito_id=todos')).body;
    expect(todos.map((x: any) => x.deposito)).toEqual(['Camioneta']);
    // el stock del depósito y el listado de existencias muestran el mínimo del depósito
    const stockDep = (await api.get(`/api/depositos/${d.camioneta.id}/stock`)).body.items.find((i: any) => i.articulo_id === d.aceite.id);
    expect(stockDep).toMatchObject({ stock: 4, minimo_deposito: 5, bajo_minimo: 1 });
  });

  it('no crea órdenes de compra sin una acción del usuario y las genera con la lógica existente', async () => {
    const antes = (await api.get('/api/ordenes-compra')).body.length;
    await api.get('/api/reposicion?deposito_id=todos');
    expect((await api.get('/api/ordenes-compra')).body).toHaveLength(antes);
    const r = await api.post('/api/reposicion/ordenes', { items: [{ articulo_id: d.aceite.id, cantidad: 8 }], emitir: false, idem_key: idem() });
    expect(r.status).toBe(201);
    expect((await api.get('/api/ordenes-compra')).body).toHaveLength(antes + 1);
  });

  it('valida depósitos del taller, permisos y aislamiento', async () => {
    expect((await api.put(`/api/articulos/${d.aceite.id}/minimos-deposito`, { minimos: [{ deposito_id: 'no-existe', minimo: 1 }] })).status).toBe(400);
    expect((await api.put(`/api/articulos/${d.aceite.id}/minimos-deposito`, { minimos: [{ deposito_id: d.principal.id, minimo: 1 }, { deposito_id: d.principal.id, minimo: 2 }] })).status).toBe(400);
    expect((await api.put(`/api/articulos/${d.aceite.id}/minimos-deposito`, { minimos: [{ deposito_id: d.principal.id, minimo: -1 }] })).status).toBe(400);
    expect((await d.recepcion.api.put(`/api/articulos/${d.aceite.id}/minimos-deposito`, { minimos: [] })).status).toBe(403);
    expect((await OTRO.api.put(`/api/articulos/${d.aceite.id}/minimos-deposito`, { minimos: [] })).status).toBe(404);
    expect((await OTRO.api.get(`/api/reposicion?deposito_id=${d.camioneta.id}`)).status).toBe(404);
    // quitar los mínimos por depósito
    expect((await api.put(`/api/articulos/${d.aceite.id}/minimos-deposito`, { minimos: [] })).status).toBe(200);
    expect((await api.get(`/api/reposicion?deposito_id=todos`)).body).toHaveLength(0);
  });
});

void hoyAR;

describe('informes de rentabilidad y mano de obra', () => {
  it('muestran la calidad del dato y respetan los permisos', async () => {
    const inf = (await api.get(`/api/informes/rentabilidad-ot?desde=${hoyAR(-1)}&hasta=${hoyAR()}`)).body;
    expect(inf.filas.length).toBeGreaterThan(0);
    expect(inf.filas.every((f: any) => ['Definitivo', 'Estimado', 'Parcial'].includes(f.calidad))).toBe(true);
    expect(inf.filas.some((f: any) => f.calidad === 'Parcial')).toBe(true); // la OT trabajada sin costo configurado
    expect(inf.nota).toMatch(/parcial/i);
    const mo = (await api.get(`/api/informes/mano-obra?desde=${hoyAR(-1)}&hasta=${hoyAR()}`)).body;
    expect(mo.filas.length).toBeGreaterThan(0);
    expect((await d.recepcion.api.get(`/api/informes/rentabilidad-ot?desde=${hoyAR(-1)}&hasta=${hoyAR()}`)).status).toBe(403);
    expect((await OTRO.api.get(`/api/informes/mano-obra?desde=${hoyAR(-1)}&hasta=${hoyAR()}`)).body.filas).toEqual([]);
  });
});
