// Sprint 09: devoluciones parciales (nota de crédito interna), anticipos de clientes y saldo a favor.
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, hoyAR, idem, nuevoPersonal, nuevoTaller } from './cliente';

let T: Awaited<ReturnType<typeof nuevoTaller>>;
let OTRO: Awaited<ReturnType<typeof nuevoTaller>>;
let api: Api;
const d: Record<string, any> = {};

const art = async (id: string) => (await api.get(`/api/articulos/${id}`)).body;
const stockEn = async (articulo: any, deposito: any) => (await art(articulo.id)).depositos.find((x: any) => x.id === deposito.id)?.stock ?? 0;
const verificar = async () => {
  const v = (await api.get('/api/cuentas-corrientes/verificar')).body;
  expect(v).toMatchObject({ ok: true, comprobantes_con_diferencia: [], anticipos_con_diferencia: [], devoluciones_con_diferencia: [], cobros_sin_cuadrar: [], cobros_con_medios_distintos: [] });
  const inv = (await api.get('/api/inventario/verificar')).body;
  expect(inv.diferencias).toEqual([]);
};
const venta = async (cliente: any, items: any[], extra: any = {}) => {
  const r = await api.post('/api/ventas', { cliente_id: cliente.id, condicion: 'cuenta_corriente', idem_key: idem(), items, ...extra });
  if (r.status !== 201) throw new Error(`venta falló: ${JSON.stringify(r.body)}`);
  return r.body;
};
const NOMBRES: Record<string, string> = {};
const lineaArt = (a: any, cantidad: number, precio = 20000) => ({ tipo: 'articulo', articulo_id: a.id, descripcion: NOMBRES[a.id] ?? 'Artículo', cantidad, precio_unitario: precio });
const lineaSrv = (descripcion: string, precio: number, cantidad = 1) => ({ tipo: 'libre', descripcion, cantidad, precio_unitario: precio });
const detalle = async (id: string) => (await api.get(`/api/ventas/${id}`)).body;
const cobrar = (cliente: any, ventaId: string, importe: number, medio = 'efectivo', extra: any = {}) =>
  api.post('/api/cobros', { cliente_id: cliente.id, medios: [{ medio, importe, ...extra }], aplicaciones: [{ venta_id: ventaId, importe }], idem_key: idem() });
const devolver = (ventaId: string, items: any[], extra: any = {}) =>
  api.post('/api/devoluciones', { venta_id: ventaId, motivo: 'Repuesto incorrecto', items, idem_key: idem(), ...extra });
const cuenta = async (cliente: any) => (await api.get(`/api/cuentas-corrientes/${cliente.id}`)).body;

beforeAll(async () => {
  T = await nuevoTaller('Taller Devoluciones', 10);
  OTRO = await nuevoTaller('Otro Taller Devoluciones', 2);
  api = T.api;
  d.recepcion = await nuevoPersonal(api, 'recepcion');
  d.caja = await nuevoPersonal(api, 'caja');
  d.mecanico = await nuevoPersonal(api, 'mecanico');
  d.cliente = (await api.post('/api/clientes', { nombre: 'Cliente Devoluciones', telefono: '1111' })).body;
  d.cliente2 = (await api.post('/api/clientes', { nombre: 'Cliente Dos', telefono: '2222' })).body;
  d.filtro = (await api.post('/api/articulos', { nombre: 'Filtro Aceite', codigo: 'FA', costo: 10000, precio: 20000, stock_inicial: 10 })).body;
  d.pastilla = (await api.post('/api/articulos', { nombre: 'Pastillas', codigo: 'PA', costo: 30000, precio: 50000, stock_inicial: 6 })).body;
  NOMBRES[d.filtro.id] = 'Filtro Aceite';
  NOMBRES[d.pastilla.id] = 'Pastillas';
  d.principal = (await api.get('/api/depositos')).body.find((x: any) => x.es_principal);
  d.mostrador = { id: (await api.post('/api/depositos', { nombre: 'Mostrador' })).body.id };
  await api.post('/api/caja/abrir', { saldo_inicial: 0 });
});

describe('devoluciones parciales de ventas', () => {
  it('devuelve parte de una venta con saldo pendiente: cancela deuda, repone el stock y respeta el costo histórico', async () => {
    d.v1 = await venta(d.cliente, [lineaArt(d.filtro, 2), lineaSrv('Cambio de aceite', 30000)]); // total 70.000
    expect(d.v1.total).toBe(70000);
    expect((await cobrar(d.cliente, d.v1.id, 20000)).status).toBe(201);
    // el costo del artículo cambia después de vender: la devolución usa el costo con el que se vendió
    await api.put(`/api/articulos/${d.filtro.id}`, { costo: 15000 });
    const venta1 = await detalle(d.v1.id);
    const lFiltro = venta1.items.find((i: any) => i.tipo === 'articulo');
    expect(venta1.items).toHaveLength(2);

    // simulación previa: muestra las consecuencias sin registrar nada
    const sim = await api.post('/api/devoluciones/simular', { venta_id: d.v1.id, motivo: 'Repuesto incorrecto', items: [{ venta_item_id: lFiltro.id, cantidad: 1, reingresa: true }] });
    expect(sim.status).toBe(200);
    expect(sim.body.credito).toMatchObject({ total: 20000, cancela_deuda: 20000, ya_pagado: 0 });
    expect(sim.body.stock.reingresan).toEqual([{ descripcion: 'Filtro Aceite', cantidad: 1, deposito: 'Depósito principal', costo_unitario: 10000 }]);
    expect(sim.body.comprobante).toMatchObject({ saldo_antes: 50000, saldo_despues: 30000, devuelto_despues: 20000 });
    expect(sim.body.cuenta_corriente).toMatchObject({ saldo_antes: 50000, saldo_despues: 30000 });
    expect((await detalle(d.v1.id)).devuelto).toBe(0); // simular no registra nada
    expect(await stockEn(d.filtro, d.principal)).toBe(8);

    const key = idem();
    const body = { venta_id: d.v1.id, motivo: 'Repuesto incorrecto', items: [{ venta_item_id: lFiltro.id, cantidad: 1, reingresa: true }], idem_key: key };
    const r = await api.post('/api/devoluciones', body);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ estado: 'registrada', total: 20000, a_deuda: 20000, liberado: 0, reintegrado: 0, venta_numero: d.v1.numero });
    d.nc1 = r.body;
    // el comprobante original no se modificó: solo su acumulado devuelto
    const v = await detalle(d.v1.id);
    expect(v).toMatchObject({ total: 70000, devuelto: 20000, cobrado: 20000, saldo: 30000, estado: 'emitida' });
    expect(v.items.find((i: any) => i.tipo === 'articulo')).toMatchObject({ cantidad: 2, cantidad_devuelta: 1 });
    expect(await stockEn(d.filtro, d.principal)).toBe(9);
    // movimiento de stock con el costo histórico, el usuario y el origen
    const mov = (await api.get(`/api/stock/movimientos?articulo_id=${d.filtro.id}`)).body.find((m: any) => m.origen_tipo === 'devolucion');
    expect(mov).toMatchObject({ tipo: 'entrada', cantidad: 1, costo_unitario: 10000 });
    expect(mov.usuario).toBeTruthy();
    // el artículo conserva su costo actual (la devolución no lo recalcula)
    expect((await art(d.filtro.id)).costo).toBe(15000);
    // un reintento con la misma clave no duplica nada
    const otra = await api.post('/api/devoluciones', body);
    expect(otra.status).toBe(200);
    expect(otra.body.duplicado).toBe(true);
    expect(await stockEn(d.filtro, d.principal)).toBe(9);
    // cuenta corriente: comprobante 70.000 − cobro 20.000 − devolución 20.000
    const cc = await cuenta(d.cliente);
    expect(cc.saldo).toBe(30000);
    expect(cc.movimientos.map((m: any) => [m.tipo, m.debe, m.haber])).toEqual([['venta', 70000, 0], ['cobro', 0, 20000], ['devolucion', 0, 20000]]);
    await verificar();
  });

  it('no permite devolver más de lo vendido, ni en cantidad ni en importe, ni dos veces la misma línea', async () => {
    const v = await detalle(d.v1.id);
    const lFiltro = v.items.find((i: any) => i.tipo === 'articulo');
    const lSrv = v.items.find((i: any) => i.tipo === 'libre');
    const r = await devolver(d.v1.id, [{ venta_item_id: lFiltro.id, cantidad: 2 }]); // queda 1
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/Solo quedan 1/);
    expect((await devolver(d.v1.id, [{ venta_item_id: lSrv.id, cantidad: 1, importe: 30001 }])).status).toBe(400); // más que lo pagado por la línea
    expect((await devolver(d.v1.id, [{ venta_item_id: lSrv.id, cantidad: 1 }, { venta_item_id: lSrv.id, cantidad: 1 }])).status).toBe(400);
    expect((await devolver(d.v1.id, [{ venta_item_id: 'inexistente', cantidad: 1 }])).status).toBe(400);
    expect((await devolver(d.v1.id, [{ venta_item_id: lFiltro.id, cantidad: 0.0001 }])).status).toBe(400);
    expect((await detalle(d.v1.id)).devuelto).toBe(20000);
    // la última unidad cierra la línea exacta, y después no queda nada
    expect((await devolver(d.v1.id, [{ venta_item_id: lFiltro.id, cantidad: 1 }])).status).toBe(201);
    const agotado = await devolver(d.v1.id, [{ venta_item_id: lFiltro.id, cantidad: 1 }]);
    expect(agotado.status).toBe(400);
    expect(agotado.body.error.message).toMatch(/por completo/);
    // la que no se marcó "reingresa" no tocó el stock (dañada / no vuelve)
    expect(await stockEn(d.filtro, d.principal)).toBe(9);
    // dos devoluciones simultáneas de la misma línea: solo una prospera
    const srvVenta = await venta(d.cliente2, [lineaSrv('Alineación', 10000)]);
    const l = (await detalle(srvVenta.id)).items[0];
    const res = await Promise.all([1, 2, 3].map(() => devolver(srvVenta.id, [{ venta_item_id: l.id, cantidad: 1 }])));
    expect(res.filter((x) => x.status === 201)).toHaveLength(1);
    expect((await detalle(srvVenta.id)).devuelto).toBe(10000);
    await verificar();
  });

  it('con lo ya pagado: libera el cobro y se reintegra en efectivo por la caja, o queda como saldo a favor', async () => {
    d.v2 = await venta(d.cliente2, [lineaArt(d.pastilla, 2, 50000), lineaSrv('Colocación', 20000)]); // 120.000
    await cobrar(d.cliente2, d.v2.id, 120000);
    const v = await detalle(d.v2.id);
    const lP = v.items.find((i: any) => i.tipo === 'articulo');
    // devolución de 1 pastilla (50.000), reintegro en efectivo por 30.000: quedan 20.000 a favor
    const sim = await api.post('/api/devoluciones/simular', { venta_id: d.v2.id, motivo: 'Defectuoso', items: [{ venta_item_id: lP.id, cantidad: 1, reingresa: true, deposito_id: d.mostrador.id }], reintegro: { medios: [{ medio: 'efectivo', importe: 30000 }] } });
    expect(sim.body.credito).toMatchObject({ total: 50000, cancela_deuda: 0, ya_pagado: 50000 });
    expect(sim.body.dinero).toMatchObject({ reintegro: 30000, saldo_a_favor: 20000, sale_de_caja: true });
    expect(sim.body.stock.reingresan[0]).toMatchObject({ deposito: 'Mostrador' });
    const antesCaja = (await api.get('/api/caja/estado')).body;
    const r = await devolver(d.v2.id, [{ venta_item_id: lP.id, cantidad: 1, reingresa: true, deposito_id: d.mostrador.id }], { reintegro: { medios: [{ medio: 'efectivo', importe: 30000 }] } });
    expect(r.status).toBe(201);
    d.nc2 = r.body;
    expect(r.body).toMatchObject({ total: 50000, a_deuda: 0, liberado: 50000, reintegrado: 30000, credito_disponible: 20000 });
    expect(await stockEn(d.pastilla, d.mostrador)).toBe(1);
    expect(await stockEn(d.pastilla, d.principal)).toBe(4);
    // el comprobante: total 120.000, devuelto 50.000, cobrado queda en 70.000 (los 50.000 liberados), sin saldo pendiente
    expect(await detalle(d.v2.id)).toMatchObject({ devuelto: 50000, cobrado: 70000, saldo: 0 });
    // caja: egreso por el reintegro (rubro devolución), una sola vez
    const movs = (await api.get(`/api/caja/movimientos?desde=${hoyAR()}&hasta=${hoyAR()}`)).body.filter((m: any) => m.rubro === 'devolucion');
    expect(movs).toHaveLength(1);
    expect(movs[0]).toMatchObject({ tipo: 'egreso', medio: 'efectivo', importe: 30000, origen_tipo: 'reintegro' });
    const caja = (await api.get('/api/caja/estado')).body;
    expect(caja.sesion.resumen.efectivo_esperado).toBe(antesCaja.sesion.resumen.efectivo_esperado - 30000);
    // cuenta corriente: debe 120.000 + 30.000 reintegro; haber 120.000 cobro + 50.000 NC → saldo −20.000 (a favor)
    const cc = await cuenta(d.cliente2);
    expect(cc.a_favor).toBe(20000);
    expect(cc.creditos).toHaveLength(1);
    expect(cc.creditos[0]).toMatchObject({ origen_tipo: 'devolucion', disponible: 20000 });
    await verificar();
  });

  it('el saldo a favor de una devolución se aplica a otro comprobante o se reintegra, y nunca dos veces', async () => {
    const v3 = await venta(d.cliente2, [lineaSrv('Service', 15000)]);
    const aplicar = (ventaId: string, importe: number, key = idem()) => api.post(`/api/ventas/${ventaId}/aplicar-creditos`, { aplicaciones: [{ origen_tipo: 'devolucion', origen_id: d.nc2.id, importe }], idem_key: key });
    expect((await aplicar(v3.id, 25000)).status).toBe(409); // supera lo disponible (20.000) y el saldo del comprobante
    const key = idem();
    expect((await aplicar(v3.id, 12000, key)).status).toBe(201);
    expect((await aplicar(v3.id, 12000, key)).body.duplicado).toBe(true); // reintento
    expect(await detalle(v3.id)).toMatchObject({ cobrado: 12000, saldo: 3000 });
    // quedan 8.000: aplicar 9.000 falla
    expect((await aplicar(v3.id, 9000)).status).toBe(409);
    // cuatro aplicaciones simultáneas de 8.000 sobre un saldo a favor de 8.000 y un comprobante con 3.000 pendientes: solo entra lo que cabe
    const v4 = await venta(d.cliente2, [lineaSrv('Otro trabajo', 40000)]);
    const res = await Promise.all([1, 2, 3, 4].map(() => aplicar(v4.id, 8000)));
    expect(res.filter((x) => x.status === 201)).toHaveLength(1);
    const a = (await cuenta(d.cliente2)).a_favor;
    expect(a).toBe(0);
    // no se puede reintegrar lo que ya se aplicó
    const rei = await api.post(`/api/devoluciones/${d.nc2.id}/reintegrar`, { medios: [{ medio: 'efectivo', importe: 1000 }], idem_key: idem() });
    expect(rei.status).toBe(409);
    // se deshace una aplicación: el comprobante recupera su deuda y el saldo vuelve a estar disponible
    const det = await detalle(v3.id);
    expect((await api.post(`/api/credito-aplicaciones/${det.creditos[0].id}/anular`, { motivo: 'Error al imputar' })).status).toBe(200);
    expect(await detalle(v3.id)).toMatchObject({ cobrado: 0, saldo: 15000 });
    expect((await cuenta(d.cliente2)).a_favor).toBe(12000);
    expect((await api.post(`/api/credito-aplicaciones/${det.creditos[0].id}/anular`, { motivo: 'Otra vez' })).status).toBe(409);
    // reintegro del saldo restante
    const rei2 = await api.post(`/api/devoluciones/${d.nc2.id}/reintegrar`, { medios: [{ medio: 'efectivo', importe: 12000 }], idem_key: idem() });
    expect(rei2.status).toBe(201);
    expect((await cuenta(d.cliente2)).a_favor).toBe(0);
    await verificar();
  });

  it('anular un reintegro devuelve el dinero a la caja y habilita anular la devolución, que quita el stock reingresado', async () => {
    const v = await venta(d.cliente, [lineaArt(d.pastilla, 1, 50000)]);
    await cobrar(d.cliente, v.id, 50000);
    const l = (await detalle(v.id)).items[0];
    const nc = (await devolver(v.id, [{ venta_item_id: l.id, cantidad: 1, reingresa: true }], { reintegro: { medios: [{ medio: 'efectivo', importe: 50000 }] } })).body;
    const antes = await stockEn(d.pastilla, d.principal);
    expect(nc).toMatchObject({ reintegrado: 50000, credito_disponible: 0 });
    // con reintegro vigente no se puede anular la devolución
    expect((await api.post(`/api/devoluciones/${nc.id}/anular`, { motivo: 'Error' })).status).toBe(409);
    const det = (await api.get(`/api/devoluciones/${nc.id}`)).body;
    expect(det.reintegros).toHaveLength(1);
    expect((await api.post(`/api/reintegros/${det.reintegros[0].id}/anular`, { motivo: 'El cliente no lo retiró' })).status).toBe(200);
    expect((await api.post(`/api/reintegros/${det.reintegros[0].id}/anular`, { motivo: 'otra vez' })).status).toBe(409);
    const movs = (await api.get(`/api/caja/movimientos?desde=${hoyAR()}&hasta=${hoyAR()}`)).body.filter((m: any) => m.rubro === 'devolucion');
    expect(movs.filter((m: any) => m.origen_tipo === 'reverso')).toHaveLength(1);
    expect((await api.post(`/api/devoluciones/${nc.id}/anular`, { motivo: 'Se devolvió por error' })).status).toBe(200);
    expect(await stockEn(d.pastilla, d.principal)).toBe(antes - 1);
    expect(await detalle(v.id)).toMatchObject({ devuelto: 0, cobrado: 50000, saldo: 0 });
    expect((await api.post(`/api/devoluciones/${nc.id}/anular`, { motivo: 'otra' })).status).toBe(409);
    // se puede volver a devolver después de anular
    expect((await devolver(v.id, [{ venta_item_id: l.id, cantidad: 1 }])).status).toBe(201);
    await verificar();
  });

  it('el comprobante con devoluciones no se anula ni se le anula el cobro hasta deshacerlas', async () => {
    const v = await venta(d.cliente, [lineaSrv('Trabajo', 40000)]);
    await cobrar(d.cliente, v.id, 40000);
    const l = (await detalle(v.id)).items[0];
    const nc = (await devolver(v.id, [{ venta_item_id: l.id, cantidad: 1, importe: 10000 }])).body;
    expect(nc).toMatchObject({ total: 10000, liberado: 10000 }); // saldo a favor de 10.000
    expect((await api.post(`/api/ventas/${v.id}/anular`, { motivo: 'Prueba' })).status).toBe(409);
    const cobro = (await detalle(v.id)).cobros[0];
    const r = await api.post(`/api/cobros/${cobro.id}/anular`, { motivo: 'Prueba' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('tiene_devoluciones');
    expect((await api.post(`/api/devoluciones/${nc.id}/anular`, { motivo: 'Deshago' })).status).toBe(200);
    expect((await api.post(`/api/cobros/${cobro.id}/anular`, { motivo: 'Ahora sí' })).status).toBe(200);
    expect((await api.post(`/api/ventas/${v.id}/anular`, { motivo: 'Ahora sí' })).status).toBe(200);
    await verificar();
  });

  it('Consumidor final: el dinero cobrado debe reintegrarse por completo', async () => {
    const cf = (await api.get('/api/clientes?q=Consumidor')).body.find((c: any) => c.codigo === 0);
    const v = await api.post('/api/ventas', { cliente_id: cf.id, condicion: 'contado', idem_key: idem(), cobro: { medio: 'efectivo' }, items: [lineaSrv('Lavado', 8000)] });
    expect(v.status).toBe(201);
    const l = (await detalle(v.body.id)).items[0];
    expect((await devolver(v.body.id, [{ venta_item_id: l.id, cantidad: 1 }])).status).toBe(400); // sin reintegro: no hay a quién dejarle saldo a favor
    expect((await devolver(v.body.id, [{ venta_item_id: l.id, cantidad: 1 }], { reintegro: { medios: [{ medio: 'efectivo', importe: 5000 }] } })).status).toBe(400);
    expect((await devolver(v.body.id, [{ venta_item_id: l.id, cantidad: 1 }], { reintegro: { medios: [{ medio: 'efectivo', importe: 8000 }] } })).status).toBe(201);
    await verificar();
  });

  it('permisos y aislamiento entre talleres', async () => {
    const l = (await detalle(d.v2.id)).items[0];
    const cuerpo = { venta_id: d.v2.id, motivo: 'Prueba permisos', items: [{ venta_item_id: l.id, cantidad: 1 }], idem_key: idem() };
    expect((await d.recepcion.api.post('/api/devoluciones', cuerpo)).status).toBe(403);
    expect((await d.caja.api.post('/api/devoluciones', cuerpo)).status).toBe(403);
    expect((await d.mecanico.api.get('/api/devoluciones')).status).toBe(403);
    expect((await d.caja.api.get('/api/devoluciones')).status).toBe(200);
    // un taller no ve ni toca las devoluciones de otro
    expect((await OTRO.api.get(`/api/devoluciones/${d.nc1.id}`)).status).toBe(404);
    expect((await OTRO.api.get('/api/devoluciones')).body).toEqual([]);
    expect((await OTRO.api.post('/api/devoluciones', cuerpo)).status).toBe(404);
    expect((await OTRO.api.post(`/api/devoluciones/${d.nc1.id}/anular`, { motivo: 'Robo' })).status).toBe(404);
    expect((await OTRO.api.get(`/api/ventas/${d.v1.id}/devolvible`)).status).toBe(404);
    // el costo de la devolución solo lo ve quien puede ver costos
    const det = (await d.caja.api.get(`/api/devoluciones/${d.nc1.id}`)).body;
    expect(det.items[0].costo_unitario).toBeUndefined();
    expect((await api.get(`/api/devoluciones/${d.nc1.id}`)).body.items[0].costo_unitario).toBe(10000);
  });

  it('el listado de devolvible informa lo vendido, lo devuelto y lo que queda', async () => {
    const r = (await api.get(`/api/ventas/${d.v1.id}/devolvible`)).body;
    expect(r.venta).toMatchObject({ total: 70000, devuelto: 40000, saldo: 10000 });
    const f = r.lineas.find((x: any) => x.tipo === 'articulo');
    expect(f).toMatchObject({ cantidad: 2, devuelta: 2, restante: 0, importe_restante: 0 });
    const s = r.lineas.find((x: any) => x.tipo === 'libre');
    expect(s).toMatchObject({ cantidad: 1, devuelta: 0, restante: 1, importe_restante: 30000 });
  });
});

describe('anticipos de clientes', () => {
  it('registra un anticipo asociado a una OT sin generar ninguna venta, e ingresa el dinero una sola vez', async () => {
    d.veh = (await api.post('/api/vehiculos', { cliente_id: d.cliente.id, patente: 'ANT123' })).body;
    d.ot = (await api.post('/api/ordenes', { cliente_id: d.cliente.id, vehiculo_id: d.veh.id, falla_reportada: 'Ruido en frenos', items: [lineaSrv('Cambio de pastillas', 80000)] })).body;
    const ventasAntes = (await api.get('/api/ventas')).body.length;
    const key = idem();
    const caja0 = (await api.get('/api/caja/estado')).body.sesion.resumen.efectivo_esperado;
    const a = await api.post('/api/anticipos', { cliente_id: d.cliente.id, orden_id: d.ot.id, medios: [{ medio: 'efectivo', importe: 50000 }], notas: 'Seña para repuestos', idem_key: key });
    expect(a.status).toBe(201);
    d.ant1 = a.body;
    expect((await api.post('/api/anticipos', { cliente_id: d.cliente.id, orden_id: d.ot.id, medios: [{ medio: 'efectivo', importe: 50000 }], idem_key: key })).body.duplicado).toBe(true);
    expect((await api.get('/api/ventas')).body).toHaveLength(ventasAntes); // no es una venta
    expect((await api.get('/api/caja/estado')).body.sesion.resumen.efectivo_esperado).toBe(caja0 + 50000); // un solo ingreso
    const lista = (await api.get(`/api/anticipos?orden_id=${d.ot.id}`)).body;
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({ total: 50000, disponible: 50000, estado_uso: 'pendiente', orden_numero: d.ot.numero, cliente: 'Cliente Devoluciones' });
    // cuenta corriente: el anticipo es haber, el cliente queda a favor
    const cc = await cuenta(d.cliente);
    expect(cc.movimientos.some((m: any) => m.tipo === 'anticipo' && m.haber === 50000)).toBe(true);
    expect(cc.a_favor).toBeGreaterThanOrEqual(50000);
    // el recibo del anticipo aparece en la lista de cobros como anticipo y no entra como aplicación a comprobantes
    const cobro = (await api.get(`/api/cobros/${d.ant1.id}`)).body;
    expect(cobro).toMatchObject({ tipo: 'anticipo', total: 50000, aplicaciones: [] });
    await verificar();
  });

  it('valida cliente, vínculo con la OT y consumidor final', async () => {
    const cf = (await api.get('/api/clientes?q=Consumidor')).body.find((c: any) => c.codigo === 0);
    const base = { medios: [{ medio: 'efectivo', importe: 1000 }], idem_key: idem() };
    expect((await api.post('/api/anticipos', { ...base, cliente_id: cf.id })).status).toBe(400);
    expect((await api.post('/api/anticipos', { ...base, idem_key: idem(), cliente_id: d.cliente2.id, orden_id: d.ot.id })).status).toBe(400); // la OT es de otro cliente
    expect((await api.post('/api/anticipos', { ...base, idem_key: idem(), cliente_id: 'no-existe' })).status).toBe(400);
    expect((await api.post('/api/anticipos', { ...base, idem_key: idem(), cliente_id: d.cliente.id, medios: [] })).status).toBe(400);
    expect((await OTRO.api.post('/api/anticipos', { ...base, idem_key: idem(), cliente_id: d.cliente.id })).status).toBe(400);
  });

  it('se aplica a la venta posterior en forma parcial y total, con varios anticipos, y nunca dos veces', async () => {
    const a2 = (await api.post('/api/anticipos', { cliente_id: d.cliente.id, orden_id: d.ot.id, medios: [{ medio: 'transferencia', importe: 20000 }], idem_key: idem() })).body;
    const v = await venta(d.cliente, [lineaSrv('Cambio de pastillas', 80000)]);
    const aplicar = (aplicaciones: any[], key = idem()) => api.post(`/api/ventas/${v.id}/aplicar-creditos`, { aplicaciones, idem_key: key });
    // 30.000 del primer anticipo
    expect((await aplicar([{ origen_tipo: 'anticipo', origen_id: d.ant1.id, importe: 30000 }])).status).toBe(201);
    expect(await detalle(v.id)).toMatchObject({ cobrado: 30000, saldo: 50000 });
    let ant = (await api.get(`/api/anticipos/${d.ant1.id}`)).body;
    expect(ant).toMatchObject({ credito_aplicado: 30000, disponible: 20000, estado_uso: 'parcial' });
    expect(ant.aplicaciones[0]).toMatchObject({ importe: 30000, venta_numero: v.numero, estado: 'vigente' });
    // no se puede aplicar más de lo que queda del anticipo
    expect((await aplicar([{ origen_tipo: 'anticipo', origen_id: d.ant1.id, importe: 20001 }])).status).toBe(409);
    // el mismo anticipo dos veces en la misma solicitud
    expect((await aplicar([{ origen_tipo: 'anticipo', origen_id: d.ant1.id, importe: 1000 }, { origen_tipo: 'anticipo', origen_id: d.ant1.id, importe: 1000 }])).status).toBe(400);
    // varios anticipos juntos: lo que queda del primero y todo el segundo
    expect((await aplicar([{ origen_tipo: 'anticipo', origen_id: d.ant1.id, importe: 20000 }, { origen_tipo: 'anticipo', origen_id: a2.id, importe: 20000 }])).status).toBe(201);
    expect(await detalle(v.id)).toMatchObject({ cobrado: 70000, saldo: 10000 });
    ant = (await api.get(`/api/anticipos/${d.ant1.id}`)).body;
    expect(ant).toMatchObject({ credito_aplicado: 50000, disponible: 0, estado_uso: 'utilizado' });
    expect((await api.get('/api/anticipos?estado=utilizados')).body.map((x: any) => x.id)).toEqual(expect.arrayContaining([d.ant1.id, a2.id]));
    expect((await api.get(`/api/anticipos?orden_id=${d.ot.id}&estado=pendientes`)).body).toHaveLength(0);
    // ya utilizado: no se aplica de nuevo ni se anula
    expect((await aplicar([{ origen_tipo: 'anticipo', origen_id: d.ant1.id, importe: 1 }])).status).toBe(409);
    const an = await api.post(`/api/cobros/${d.ant1.id}/anular`, { motivo: 'Prueba' });
    expect(an.status).toBe(409);
    expect(an.body.error.code).toBe('anticipo_en_uso');
    // el detalle del comprobante muestra con qué se pagó
    const det = await detalle(v.id);
    expect(det.creditos).toHaveLength(3);
    expect(det.creditos.every((x: any) => x.origen_tipo === 'anticipo' && x.origen_numero)).toBe(true);
    // concurrencia: dos aplicaciones simultáneas del mismo anticipo nuevo sobre el mismo saldo
    const a3 = (await api.post('/api/anticipos', { cliente_id: d.cliente.id, medios: [{ medio: 'efectivo', importe: 10000 }], idem_key: idem() })).body;
    const res = await Promise.all([1, 2, 3].map(() => aplicar([{ origen_tipo: 'anticipo', origen_id: a3.id, importe: 10000 }])));
    expect(res.filter((x) => x.status === 201)).toHaveLength(1);
    expect(await detalle(v.id)).toMatchObject({ cobrado: 80000, saldo: 0 });
    await verificar();
    d.vAnt = v;
  });

  it('un cobro simultáneo y la aplicación de un anticipo no exceden el saldo del comprobante', async () => {
    const a = (await api.post('/api/anticipos', { cliente_id: d.cliente2.id, medios: [{ medio: 'efectivo', importe: 30000 }], idem_key: idem() })).body;
    const v = await venta(d.cliente2, [lineaSrv('Trabajo extra', 30000)]);
    const [x, y] = await Promise.all([
      api.post(`/api/ventas/${v.id}/aplicar-creditos`, { aplicaciones: [{ origen_tipo: 'anticipo', origen_id: a.id, importe: 30000 }], idem_key: idem() }),
      cobrar(d.cliente2, v.id, 30000),
    ]);
    expect([x.status, y.status].filter((s) => s === 201 || s === 200)).toHaveLength(1);
    expect(await detalle(v.id)).toMatchObject({ cobrado: 30000, saldo: 0 });
    await verificar();
  });

  it('devuelve el anticipo en dinero (egreso de caja) y no deja devolver ni más de lo disponible ni lo ya devuelto', async () => {
    const a = (await api.post('/api/anticipos', { cliente_id: d.cliente2.id, medios: [{ medio: 'efectivo', importe: 40000 }], idem_key: idem() })).body;
    const devolverAnt = (importe: number, key = idem()) => api.post(`/api/anticipos/${a.id}/devolver`, { medios: [{ medio: 'efectivo', importe }], motivo: 'Cancela la reparación', idem_key: key });
    expect((await devolverAnt(40001)).status).toBe(409);
    const caja0 = (await api.get('/api/caja/estado')).body.sesion.resumen.efectivo_esperado;
    const key = idem();
    expect((await devolverAnt(15000, key)).status).toBe(201);
    expect((await devolverAnt(15000, key)).body.duplicado).toBe(true);
    expect((await api.get('/api/caja/estado')).body.sesion.resumen.efectivo_esperado).toBe(caja0 - 15000);
    expect((await api.get(`/api/anticipos/${a.id}`)).body).toMatchObject({ devuelto: 15000, disponible: 25000, estado_uso: 'parcial' });
    // devolución y aplicación simultáneas del mismo saldo
    const v = await venta(d.cliente2, [lineaSrv('Servicio', 25000)]);
    const [p, q] = await Promise.all([devolverAnt(25000), api.post(`/api/ventas/${v.id}/aplicar-creditos`, { aplicaciones: [{ origen_tipo: 'anticipo', origen_id: a.id, importe: 25000 }], idem_key: idem() })]);
    expect([p.status, q.status].filter((s) => s === 201)).toHaveLength(1);
    expect((await api.get('/api/anticipos?estado=devueltos')).body.some((x: any) => x.id === a.id)).toBe(true);
    // anular el reintegro del anticipo vuelve a dejar el saldo disponible
    const rid = (await api.get(`/api/anticipos/${a.id}`)).body.reintegros[0].id;
    expect((await api.post(`/api/reintegros/${rid}/anular`, { motivo: 'Cliente retiró' })).status).toBe(200);
    expect((await api.get(`/api/anticipos/${a.id}`)).body.devuelto).toBeLessThan(40000);
    await verificar();
  });

  it('anular un anticipo sin uso revierte la caja; los permisos y el aislamiento se respetan', async () => {
    const a = (await api.post('/api/anticipos', { cliente_id: d.cliente2.id, medios: [{ medio: 'efectivo', importe: 5000 }], idem_key: idem() })).body;
    expect((await d.recepcion.api.post('/api/anticipos', { cliente_id: d.cliente2.id, medios: [{ medio: 'efectivo', importe: 1000 }], idem_key: idem() })).status).toBe(403);
    expect((await d.caja.api.post('/api/anticipos', { cliente_id: d.cliente2.id, medios: [{ medio: 'efectivo', importe: 1000 }], idem_key: idem() })).status).toBe(201);
    expect((await d.caja.api.post(`/api/anticipos/${a.id}/devolver`, { medios: [{ medio: 'efectivo', importe: 1000 }], motivo: 'x y z', idem_key: idem() })).status).toBe(403);
    expect((await d.mecanico.api.get('/api/anticipos')).status).toBe(403);
    expect((await OTRO.api.get(`/api/anticipos/${a.id}`)).status).toBe(404);
    expect((await OTRO.api.get('/api/anticipos')).body).toEqual([]);
    expect((await OTRO.api.post(`/api/ventas/${d.vAnt.id}/aplicar-creditos`, { aplicaciones: [{ origen_tipo: 'anticipo', origen_id: a.id, importe: 1000 }], idem_key: idem() })).status).toBe(404);
    expect((await OTRO.api.post(`/api/anticipos/${a.id}/devolver`, { medios: [{ medio: 'efectivo', importe: 1000 }], motivo: 'x y z', idem_key: idem() })).status).toBe(404);
    const caja0 = (await api.get('/api/caja/estado')).body.sesion.resumen.efectivo_esperado;
    expect((await api.post(`/api/cobros/${a.id}/anular`, { motivo: 'Cargado por error' })).status).toBe(200);
    expect((await api.get('/api/caja/estado')).body.sesion.resumen.efectivo_esperado).toBe(caja0 - 5000);
    expect((await api.get(`/api/anticipos/${a.id}`)).body.estado_uso).toBe('anulado');
    await verificar();
  });
});

describe('anticipos en el comprobante de la OT', () => {
  it('imputa los anticipos al emitir el comprobante, en la misma transacción y sin duplicar', async () => {
    const veh = (await api.post('/api/vehiculos', { cliente_id: d.cliente2.id, patente: 'ANT999' })).body;
    const ot = (await api.post('/api/ordenes', { cliente_id: d.cliente2.id, vehiculo_id: veh.id, falla_reportada: 'Prueba', items: [lineaSrv('Reparación', 90000)] })).body;
    const a1 = (await api.post('/api/anticipos', { cliente_id: d.cliente2.id, orden_id: ot.id, medios: [{ medio: 'efectivo', importe: 60000 }], idem_key: idem() })).body;
    await api.post(`/api/ordenes/${ot.id}/estado`, { estado: 'lista' });
    const sobra = await api.post(`/api/ordenes/${ot.id}/comprobante`, { condicion: 'cuenta_corriente', creditos: [{ origen_tipo: 'anticipo', origen_id: a1.id, importe: 70000 }] });
    expect(sobra.status).toBe(409);
    const dup = await api.post(`/api/ordenes/${ot.id}/comprobante`, { condicion: 'cuenta_corriente', creditos: [{ origen_tipo: 'anticipo', origen_id: a1.id, importe: 1000 }, { origen_tipo: 'anticipo', origen_id: a1.id, importe: 1000 }] });
    expect(dup.status).toBe(400);
    expect((await api.get(`/api/anticipos/${a1.id}`)).body.credito_aplicado).toBe(0); // los rechazos no dejaron nada a medias
    const ok = await api.post(`/api/ordenes/${ot.id}/comprobante`, { condicion: 'contado', cobro: { medio: 'efectivo' }, creditos: [{ origen_tipo: 'anticipo', origen_id: a1.id, importe: 60000 }] });
    expect(ok.status).toBe(201);
    // 60.000 con el anticipo + 30.000 cobrados en el acto
    expect(await detalle(ok.body.id)).toMatchObject({ total: 90000, cobrado: 90000, saldo: 0 });
    expect((await api.get(`/api/anticipos/${a1.id}`)).body).toMatchObject({ credito_aplicado: 60000, estado_uso: 'utilizado' });
    expect((await api.post(`/api/ordenes/${ot.id}/comprobante`, { condicion: 'cuenta_corriente' })).status).toBe(409); // ya tiene comprobante
    await verificar();
  });
});

describe('informes y resúmenes con devoluciones y anticipos', () => {
  const informe = async (tipo: string, q = '') => (await api.get(`/api/informes/${tipo}?desde=${hoyAR(-1)}&hasta=${hoyAR()}${q}`)).body;
  it('no cuentan los anticipos como ventas ni los cobros dos veces, y restan lo devuelto', async () => {
    const ventas = await informe('ventas', '&agrupar=dia');
    const tot = ventas.totales;
    expect(tot.devuelto).toBeGreaterThan(0);
    expect(tot.neto_final).toBe(tot.total - tot.devuelto);
    const todasVentas = (await api.get('/api/ventas')).body.filter((v: any) => v.estado === 'emitida');
    expect(tot.total).toBe(todasVentas.reduce((a: number, v: any) => a + v.total, 0)); // los anticipos no son ventas
    const cobranzas = await informe('cobranzas', '&agrupar=detalle');
    const anticipos = cobranzas.filas.filter((f: any) => f.tipo === 'Anticipo');
    expect(anticipos.length).toBeGreaterThan(0);
    // cada recibo figura una sola vez: lo aplicado de un anticipo no genera otro cobro
    expect(new Set(cobranzas.filas.map((f: any) => f.numero)).size).toBe(cobranzas.filas.length);
    const ant = await informe('anticipos');
    expect(ant.totales.total).toBeGreaterThan(0);
    expect(ant.totales.disponible).toBe(ant.totales.total - ant.totales.aplicado - ant.totales.devuelto);
    const dev = await informe('devoluciones', '&agrupar=detalle');
    expect(dev.filas.length).toBeGreaterThan(0);
    expect((await informe('devoluciones', '&agrupar=medio')).totales.importe).toBeGreaterThan(0);
    // finanzas: los reintegros son egresos separados; el resultado cierra con la caja
    const fin = (await api.get(`/api/finanzas/resumen?desde=${hoyAR(-1)}&hasta=${hoyAR()}`)).body;
    expect(fin.egresos.devoluciones_clientes).toBeGreaterThan(0);
    expect(fin.egresos.total).toBe(fin.egresos.pagos_proveedor + fin.egresos.gastos + fin.egresos.devoluciones_clientes);
    const tes = (await api.get(`/api/tesoreria/resumen?desde=${hoyAR(-1)}&hasta=${hoyAR()}`)).body;
    expect(tes.periodo.egresos.devoluciones_clientes).toBe(fin.egresos.devoluciones_clientes);
    expect(tes.a_favor_clientes.total).toBeGreaterThanOrEqual(0);
    // contabilidad: la nota de crédito resta en el libro de ventas
    const libro = (await api.get(`/api/contabilidad/libro-ventas?desde=${hoyAR(-1)}&hasta=${hoyAR()}`)).body;
    expect(libro.filas.some((f: any) => f.nota_credito && f.total < 0)).toBe(true);
    // el empleado sin finanzas no ve estos informes de costos
    expect((await d.caja.api.get(`/api/informes/rentabilidad-ot?desde=${hoyAR(-1)}&hasta=${hoyAR()}`)).status).toBe(403);
    expect((await d.caja.api.get(`/api/informes/mano-obra?desde=${hoyAR(-1)}&hasta=${hoyAR()}`)).status).toBe(403);
    expect((await OTRO.api.get(`/api/informes/devoluciones?desde=${hoyAR(-1)}&hasta=${hoyAR()}`)).body.filas).toEqual([]);
  });
});
