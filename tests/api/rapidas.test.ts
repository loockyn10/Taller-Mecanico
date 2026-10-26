// Sprint 22: consulta rápida de precios y operaciones rápidas (venta, consumo de repuestos en una OT, baja interna e historial).
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, consultaLocal, idem, nuevoPersonal, nuevoTaller, sqlLocal } from './cliente';

let T: Awaited<ReturnType<typeof nuevoTaller>>;
let OTRO: Awaited<ReturnType<typeof nuevoTaller>>;
let api: Api;
const d: Record<string, any> = {};

const stock = async (a: any, dep?: any) => {
  const r = (await api.get(`/api/articulos/${a.id}`)).body;
  return dep ? r.depositos.find((x: any) => x.id === dep.id)?.stock ?? 0 : r.stock;
};
const consistente = async () => {
  const v = (await api.get('/api/inventario/verificar')).body;
  expect(v.diferencias).toEqual([]);
};
const movs = async (articuloId: string, origenTipo?: string) =>
  (await api.get(`/api/stock/movimientos?articulo_id=${articuloId}`)).body.filter((m: any) => !origenTipo || m.origen_tipo === origenTipo);
const nuevaOT = async (items: any[] = [], extra: Record<string, unknown> = {}) => {
  const r = await api.post('/api/ordenes', { cliente_id: d.cliente.id, vehiculo_id: d.vehiculo.id, items, ...extra });
  expect(r.status).toBe(201);
  return r.body;
};

beforeAll(async () => {
  T = await nuevoTaller('Taller Rápidas', 12);
  OTRO = await nuevoTaller('Otro Taller Rápidas', 2);
  api = T.api;
  d.recepcion = await nuevoPersonal(api, 'recepcion');
  d.mecanico = await nuevoPersonal(api, 'mecanico');
  d.deposito = await nuevoPersonal(api, 'deposito');
  d.caja = await nuevoPersonal(api, 'caja');
  d.cliente = (await api.post('/api/clientes', { nombre: 'Cliente Rápidas', telefono: '1111' })).body;
  d.vehiculo = (await api.post('/api/vehiculos', { cliente_id: d.cliente.id, patente: 'RAP123' })).body;
  d.filtro = (await api.post('/api/articulos', { nombre: 'Filtro de aceite Mann', marca: 'Mann', codigo: 'FA-100', codigo_barras: '7790001112223', costo: 10000, precio: 20000, stock_inicial: 10, stock_minimo: 2 })).body;
  d.aceite = (await api.post('/api/articulos', { nombre: 'Aceite 10W40 x4L', marca: 'Elaion', codigo: 'AC-200', costo: 30000, precio: 55000, stock_inicial: 6 })).body;
  d.sinPrecio = (await api.post('/api/articulos', { nombre: 'Junta sin precio', marca: 'Victor', codigo: 'JS-300', costo: 0, precio: 0, stock_inicial: 4 })).body;
  d.ajeno = (await OTRO.api.post('/api/articulos', { nombre: 'Filtro ajeno Mann', marca: 'Mann', codigo: 'FA-100', codigo_barras: '7790001112223', costo: 1, precio: 2, stock_inicial: 5 })).body;
  d.lista = (await api.post('/api/listas-precios', { nombre: 'Mayorista', base: 'precio', porcentaje: -10 })).body;
  d.principal = (await api.get('/api/depositos')).body.find((x: any) => x.es_principal);
});

describe('consulta rápida de precios', () => {
  it('busca por nombre, marca, SKU y código de barras, con precio y existencias reales', async () => {
    for (const q of ['filtro aceite', 'mann', 'FA-100', '7790001112223']) {
      const r = await api.get(`/api/rapidas/consulta-precios?q=${encodeURIComponent(q)}`);
      expect(r.status).toBe(200);
      const f = r.body.items.find((x: any) => x.id === d.filtro.id);
      expect(f, q).toBeTruthy();
      expect(f).toMatchObject({ nombre: 'Filtro de aceite Mann', marca: 'Mann', codigo: 'FA-100', codigo_barras: '7790001112223', stock: 10, precio: 20000, costo: 10000, sin_precio: false });
    }
    // el código exacto aparece primero
    const r = await api.get('/api/rapidas/consulta-precios?q=AC-200');
    expect(r.body.items[0].id).toBe(d.aceite.id);
    // sin texto no se vuelca el catálogo
    expect((await api.get('/api/rapidas/consulta-precios?q=')).body.items).toEqual([]);
  });

  it('aplica la lista de precios elegida y no inventa precios para lo que no tiene precio', async () => {
    const r = await api.get(`/api/rapidas/consulta-precios?q=filtro&lista_id=${d.lista.id}`);
    expect(r.body.lista).toMatchObject({ id: d.lista.id, nombre: 'Mayorista' });
    expect(r.body.items.find((x: any) => x.id === d.filtro.id)).toMatchObject({ precio: 18000, precio_origen: 'regla' });
    const sp = (await api.get('/api/rapidas/consulta-precios?q=junta')).body.items[0];
    expect(sp).toMatchObject({ precio: null, sin_precio: true });
    // una lista sobre costo tampoco inventa un precio para un artículo sin costo ni precio
    const lc = (await api.post('/api/listas-precios', { nombre: 'Sobre costo', base: 'costo', porcentaje: 30 })).body;
    const rr = (await api.get(`/api/rapidas/consulta-precios?q=junta&lista_id=${lc.id}`)).body.items.find((x: any) => x.id === d.sinPrecio.id);
    expect(rr).toMatchObject({ precio: null, sin_precio: true });
    expect((await api.get('/api/rapidas/consulta-precios?q=filtro&lista_id=inexistente')).status).toBe(400);
  });

  it('el costo, el stock y los precios sólo llegan a quien tiene permiso (no viajan al navegador)', async () => {
    const ver = async (a: Api) => (await a.get('/api/rapidas/consulta-precios?q=filtro')).body.items.find((x: any) => x.id === d.filtro.id);
    const rec = await ver(d.recepcion.api);
    expect(rec).toMatchObject({ precio: 20000, stock: 10 });
    expect('costo' in rec).toBe(false);
    const dep = await ver(d.deposito.api);
    expect(dep.costo).toBe(10000);
    // caja: ve precios pero no existencias ni costos
    const caja = await ver(d.caja.api);
    expect(caja.precio).toBe(20000);
    expect('costo' in caja).toBe(false);
    expect('stock' in caja).toBe(false);
    // a quien se le retira ver precios de venta, el servidor deja de enviarlos
    const u = await nuevoPersonal(api, 'recepcion');
    const base = (await api.get(`/api/taller/usuarios/${u.id}`)).body.permisos as string[];
    expect((await api.put(`/api/taller/usuarios/${u.id}/permisos`, { permisos: base.filter((p) => !['precios.venta.ver', 'presupuestos.gestionar', 'presupuestos.valorizados.ver', 'ventas.emitir', 'cobros.registrar', 'margenes.ver'].includes(p)) })).status).toBe(200);
    const sin = await ver(u.api);
    expect(sin).toBeTruthy();
    for (const k of ['precio', 'sin_precio', 'precio_origen', 'costo']) expect(k in sin, k).toBe(false);
    expect(sin.stock).toBe(10);
    const conLista = await u.api.get(`/api/rapidas/consulta-precios?q=filtro&lista_id=${d.lista.id}`);
    expect(conLista.body.lista).toBeNull();
    // el mecánico no consulta el catálogo
    expect((await d.mecanico.api.get('/api/rapidas/consulta-precios?q=filtro')).status).toBe(403);
    expect((await new Api().get('/api/rapidas/consulta-precios?q=filtro')).status).toBe(401);
  });

  it('un taller no ve artículos ni listas de otro', async () => {
    const mio = (await api.get('/api/rapidas/consulta-precios?q=7790001112223')).body.items;
    expect(mio.map((x: any) => x.id)).toEqual([d.filtro.id]);
    const suyo = (await OTRO.api.get('/api/rapidas/consulta-precios?q=7790001112223')).body.items;
    expect(suyo.map((x: any) => x.id)).toEqual([d.ajeno.id]);
    expect(suyo[0].precio).toBe(2);
    expect((await OTRO.api.get(`/api/rapidas/consulta-precios?q=filtro&lista_id=${d.lista.id}`)).status).toBe(400);
  });
});

describe('consumo de repuestos en una OT', () => {
  it('agrega varios repuestos con el precio de la lista y no descuenta stock hasta dejar la orden lista', async () => {
    const ot = await nuevaOT([{ tipo: 'libre', descripcion: 'Mano de obra', cantidad: 1, precio_unitario: 50000 }], { lista_precio_id: d.lista.id });
    const antes = { filtro: await stock(d.filtro), aceite: await stock(d.aceite) };
    const clave = idem();
    const items = [{ articulo_id: d.filtro.id, cantidad: 2 }, { articulo_id: d.aceite.id, cantidad: 1 }, { articulo_id: d.filtro.id, cantidad: 1 }];
    const r = await api.post('/api/rapidas/consumo-ot', { orden_id: ot.id, idem_key: clave, items });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ agregados: 2, orden_numero: ot.numero });
    const o = (await api.get(`/api/ordenes/${ot.id}`)).body;
    const arts = o.items.filter((i: any) => i.tipo === 'articulo');
    expect(arts).toHaveLength(2);
    expect(arts.find((i: any) => i.articulo_id === d.filtro.id)).toMatchObject({ cantidad: 3, precio_unitario: 18000, subtotal: 54000 });
    expect(arts.find((i: any) => i.articulo_id === d.aceite.id)).toMatchObject({ cantidad: 1, precio_unitario: 49500 });
    expect(o.total).toBe(50000 + 54000 + 49500);
    expect(o.notas.some((n: any) => n.texto.includes('Operaciones rápidas'))).toBe(true);
    // el stock no se movió: lo descuenta la OT, una vez, al quedar lista
    expect(await stock(d.filtro)).toBe(antes.filtro);
    expect(await stock(d.aceite)).toBe(antes.aceite);
    expect(await movs(d.filtro.id, 'orden')).toHaveLength(0);

    // reintento (doble clic, mala conexión): misma respuesta, ninguna línea nueva
    const dup = await api.post('/api/rapidas/consumo-ot', { orden_id: ot.id, idem_key: clave, items });
    expect(dup.status).toBe(200);
    expect(dup.body).toMatchObject({ duplicado: true, id: r.body.id });
    const despues = (await api.get(`/api/ordenes/${ot.id}`)).body;
    expect(despues.items.filter((i: any) => i.tipo === 'articulo')).toHaveLength(2);
    expect(despues.total).toBe(153500);
    // la clave de una operación no se puede reutilizar para otra orden
    const ot2 = await nuevaOT();
    expect((await api.post('/api/rapidas/consumo-ot', { orden_id: ot2.id, idem_key: clave, items: [{ articulo_id: d.filtro.id, cantidad: 1 }] })).status).toBe(409);

    // al dejar la orden lista se descuenta UNA sola vez
    expect((await api.post(`/api/ordenes/${ot.id}/estado`, { estado: 'lista' })).status).toBe(200);
    expect(await stock(d.filtro)).toBe(antes.filtro - 3);
    expect(await stock(d.aceite)).toBe(antes.aceite - 1);
    expect(await movs(d.filtro.id, 'orden')).toHaveLength(1);
    // reintentar después de dejarla lista no agrega ni descuenta nada
    expect((await api.post('/api/rapidas/consumo-ot', { orden_id: ot.id, idem_key: clave, items })).body.duplicado).toBe(true);
    expect(await stock(d.filtro)).toBe(antes.filtro - 3);
    // con la orden ya lista no se agregan repuestos por este camino
    const nueva = await api.post('/api/rapidas/consumo-ot', { orden_id: ot.id, idem_key: idem(), items: [{ articulo_id: d.filtro.id, cantidad: 1 }] });
    expect(nueva.status).toBe(409);
    expect(nueva.body.error.code).toBe('orden_cerrada');
    // volver a reparación repone el stock
    await api.post(`/api/ordenes/${ot.id}/estado`, { estado: 'en_reparacion' });
    expect(await stock(d.filtro)).toBe(antes.filtro);
    await consistente();
  });

  it('valida stock insuficiente, artículos sin precio, inexistentes y órdenes de otro taller', async () => {
    const ot = await nuevaOT();
    const antes = await stock(d.aceite);
    const poco = await api.post('/api/rapidas/consumo-ot', { orden_id: ot.id, idem_key: idem(), items: [{ articulo_id: d.aceite.id, cantidad: antes + 1 }] });
    expect(poco.status).toBe(409);
    expect(poco.body.error.code).toBe('stock_insuficiente');
    // lo que la orden ya tenía también cuenta contra el stock
    expect((await api.post('/api/rapidas/consumo-ot', { orden_id: ot.id, idem_key: idem(), items: [{ articulo_id: d.aceite.id, cantidad: antes }] })).status).toBe(201);
    expect((await api.post('/api/rapidas/consumo-ot', { orden_id: ot.id, idem_key: idem(), items: [{ articulo_id: d.aceite.id, cantidad: 1 }] })).status).toBe(409);
    const ot2 = await nuevaOT();
    const sp = await api.post('/api/rapidas/consumo-ot', { orden_id: ot2.id, idem_key: idem(), items: [{ articulo_id: d.sinPrecio.id, cantidad: 1 }] });
    expect(sp.status).toBe(400);
    expect(sp.body.error.message).toContain('precio');
    expect((await api.get(`/api/ordenes/${ot2.id}`)).body.items).toHaveLength(0);
    expect((await api.post('/api/rapidas/consumo-ot', { orden_id: ot2.id, idem_key: idem(), items: [{ articulo_id: 'no-existe', cantidad: 1 }] })).status).toBe(400);
    expect((await api.post('/api/rapidas/consumo-ot', { orden_id: ot2.id, idem_key: idem(), items: [{ articulo_id: d.ajeno.id, cantidad: 1 }] })).status).toBe(400);
    expect((await api.post('/api/rapidas/consumo-ot', { orden_id: ot2.id, idem_key: idem(), items: [] })).status).toBe(400);
    expect((await api.post('/api/rapidas/consumo-ot', { orden_id: ot2.id, idem_key: idem(), items: [{ articulo_id: d.filtro.id, cantidad: 0 }] })).status).toBe(400);
    // otro taller no puede cargar a esta orden
    expect((await OTRO.api.post('/api/rapidas/consumo-ot', { orden_id: ot2.id, idem_key: idem(), items: [{ articulo_id: d.ajeno.id, cantidad: 1 }] })).status).toBe(404);
    await consistente();
  });

  it('respeta los permisos: sólo quien puede modificar órdenes con importes', async () => {
    const ot = await nuevaOT();
    const cuerpo = () => ({ orden_id: ot.id, idem_key: idem(), items: [{ articulo_id: d.filtro.id, cantidad: 1 }] });
    expect((await d.mecanico.api.post('/api/rapidas/consumo-ot', cuerpo())).status).toBe(403);
    expect((await d.caja.api.post('/api/rapidas/consumo-ot', cuerpo())).status).toBe(403);
    expect((await d.deposito.api.post('/api/rapidas/consumo-ot', cuerpo())).status).toBe(403);
    expect((await new Api().post('/api/rapidas/consumo-ot', cuerpo())).status).toBe(401);
    expect((await d.recepcion.api.post('/api/rapidas/consumo-ot', cuerpo())).status).toBe(201);
  });
});

describe('baja interna de inventario', () => {
  it('descuenta el stock con movimientos trazables y sin crear ventas, cobros ni caja', async () => {
    const ventasAntes = (await api.get('/api/ventas')).body.length;
    const cobrosAntes = (await api.get('/api/cobros')).body.length;
    const antes = { filtro: await stock(d.filtro), aceite: await stock(d.aceite) };
    const cuerpo = { motivo: 'rotura', responsable: 'Pedro (mecánico)', notas: 'Se cayó del estante', idem_key: idem(), items: [{ articulo_id: d.filtro.id, cantidad: 2 }, { articulo_id: d.aceite.id, cantidad: 1 }] };
    const r = await api.post('/api/rapidas/bajas', cuerpo);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ articulos: 2, unidades: 3 });
    expect(await stock(d.filtro)).toBe(antes.filtro - 2);
    expect(await stock(d.aceite)).toBe(antes.aceite - 1);
    const m = (await movs(d.filtro.id)).find((x: any) => x.origen_id === r.body.id);
    expect(m).toMatchObject({ tipo: 'salida', cantidad: -2, motivo: 'rotura', origen_tipo: 'manual', stock_resultante: antes.filtro - 2 });
    expect(m.usuario).toBeTruthy();
    expect(m.notas).toContain('Pedro');
    // reintento: nada se duplica
    const dup = await api.post('/api/rapidas/bajas', cuerpo);
    expect(dup.status).toBe(200);
    expect(dup.body).toMatchObject({ duplicado: true, id: r.body.id });
    expect(await stock(d.filtro)).toBe(antes.filtro - 2);
    expect((await movs(d.filtro.id)).filter((x: any) => x.origen_id === r.body.id)).toHaveLength(1);
    // no hay ventas ni cobros nuevos
    expect((await api.get('/api/ventas')).body).toHaveLength(ventasAntes);
    expect((await api.get('/api/cobros')).body).toHaveLength(cobrosAntes);
    await consistente();
  });

  it('valida el motivo, el stock insuficiente y el depósito', async () => {
    expect((await api.post('/api/rapidas/bajas', { motivo: 'otro', idem_key: idem(), items: [{ articulo_id: d.filtro.id, cantidad: 1 }] })).status).toBe(400);
    expect((await api.post('/api/rapidas/bajas', { motivo: 'inventado', idem_key: idem(), items: [{ articulo_id: d.filtro.id, cantidad: 1 }] })).status).toBe(400);
    const ok = await api.post('/api/rapidas/bajas', { motivo: 'otro', notas: 'Donación al club', idem_key: idem(), items: [{ articulo_id: d.filtro.id, cantidad: 1 }] });
    expect(ok.status).toBe(201);
    const antes = await stock(d.filtro);
    const antesAceite = await stock(d.aceite);
    const mucho = await api.post('/api/rapidas/bajas', { motivo: 'merma', idem_key: idem(), items: [{ articulo_id: d.filtro.id, cantidad: antes + 1 }, { articulo_id: d.aceite.id, cantidad: 1 }] });
    expect(mucho.status).toBe(409);
    expect(mucho.body.error.code).toBe('stock_insuficiente');
    expect(await stock(d.filtro)).toBe(antes); // ninguna línea se aplicó a medias
    expect(await stock(d.aceite)).toBe(antesAceite);
    // depósito: se controla y descuenta el del depósito elegido
    const mostr = (await api.post('/api/depositos', { nombre: 'Mostrador rápidas' })).body;
    expect((await api.post('/api/transferencias', { origen_id: d.principal.id, destino_id: mostr.id, idem_key: idem(), items: [{ articulo_id: d.filtro.id, cantidad: 2 }] })).status).toBe(201);
    expect((await api.post('/api/rapidas/bajas', { motivo: 'robo', deposito_id: mostr.id, idem_key: idem(), items: [{ articulo_id: d.filtro.id, cantidad: 3 }] })).status).toBe(409);
    expect((await api.post('/api/rapidas/bajas', { motivo: 'robo', deposito_id: mostr.id, idem_key: idem(), items: [{ articulo_id: d.filtro.id, cantidad: 2 }] })).status).toBe(201);
    expect(await stock(d.filtro, mostr)).toBe(0);
    expect((await api.post('/api/rapidas/bajas', { motivo: 'robo', deposito_id: 'no-existe', idem_key: idem(), items: [{ articulo_id: d.filtro.id, cantidad: 1 }] })).status).toBe(400);
    await consistente();
  });

  it('exige permiso de ajustar inventario y no cruza talleres', async () => {
    const cuerpo = () => ({ motivo: 'rotura', idem_key: idem(), items: [{ articulo_id: d.filtro.id, cantidad: 1 }] });
    for (const u of [d.recepcion, d.mecanico, d.caja]) expect((await u.api.post('/api/rapidas/bajas', cuerpo())).status).toBe(403);
    expect((await d.deposito.api.post('/api/rapidas/bajas', cuerpo())).status).toBe(201);
    const stockAjeno = (await OTRO.api.get(`/api/articulos/${d.ajeno.id}`)).body.stock;
    expect((await OTRO.api.post('/api/rapidas/bajas', cuerpo())).status).toBe(400); // el artículo no es de ese taller
    expect((await OTRO.api.get(`/api/articulos/${d.ajeno.id}`)).body.stock).toBe(stockAjeno);
  });

  it('la baja queda en el circuito contable del ajuste manual (diferencia de inventario)', async () => {
    const r = await api.post('/api/rapidas/bajas', { motivo: 'uso_interno', idem_key: idem(), items: [{ articulo_id: d.aceite.id, cantidad: 1 }] });
    expect(r.status).toBe(201);
    const filas = await consultaLocal<{ origen_tipo: string; tipo: string; motivo: string }>(`SELECT origen_tipo, tipo, motivo FROM stock_movimientos WHERE taller_id = '${T.tallerId}' AND origen_id = '${r.body.id}'`);
    expect(filas).toEqual([{ origen_tipo: 'manual', tipo: 'salida', motivo: 'uso_interno' }]);
  });
});

describe('venta rápida (la venta de siempre)', () => {
  it('emite y cobra con el flujo de ventas, descuenta stock una vez y no se duplica', async () => {
    const antes = await stock(d.filtro);
    const cuerpo = { condicion: 'contado', idem_key: `rapida:${idem()}`, items: [{ tipo: 'articulo', articulo_id: d.filtro.id, descripcion: 'Filtro de aceite Mann', cantidad: 2, precio_unitario: 20000, desc_pct: 10 }], cobro: { medio: 'efectivo' } };
    const r = await api.post('/api/ventas', cuerpo);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ total: 36000, cobrado: 36000 });
    expect(await stock(d.filtro)).toBe(antes - 2);
    const dup = await api.post('/api/ventas', cuerpo);
    expect(dup.body).toMatchObject({ duplicado: true, id: r.body.id });
    expect(await stock(d.filtro)).toBe(antes - 2);
    expect((await movs(d.filtro.id, 'venta')).filter((m: any) => m.origen_id === r.body.id)).toHaveLength(1);
    // sin stock suficiente no se vende nada
    const sin = await api.post('/api/ventas', { condicion: 'cuenta_corriente', cliente_id: d.cliente.id, idem_key: `rapida:${idem()}`, items: [{ tipo: 'articulo', articulo_id: d.filtro.id, descripcion: 'x', cantidad: 9999, precio_unitario: 1 }] });
    expect(sin.status).toBe(409);
    await consistente();
  });
});

describe('historial de operaciones recientes', () => {
  it('lista las tres clases de operación, con permisos y aislamiento entre talleres', async () => {
    const h = (await api.get('/api/rapidas/historial')).body;
    expect(new Set(h.map((x: any) => x.tipo))).toEqual(new Set(['venta', 'consumo_ot', 'baja_interna']));
    expect(h.find((x: any) => x.tipo === 'venta').total).toBe(36000);
    const baja = h.find((x: any) => x.tipo === 'baja_interna' && x.motivo === 'rotura' && x.responsable);
    expect(baja).toMatchObject({ responsable: 'Pedro (mecánico)', articulos: 2, unidades: 3 });
    expect(baja.usuario).toBeTruthy();
    expect(h.find((x: any) => x.tipo === 'consumo_ot').orden_numero).toBeGreaterThan(0);
    // de más nuevo a más viejo
    const fechas = h.map((x: any) => x.created_at);
    expect([...fechas].sort().reverse()).toEqual(fechas);
    // caja (sin ver inventario) ve ventas y consumos pero no las bajas; el depósito ve las bajas y no las ventas
    const caja = new Set((await d.caja.api.get('/api/rapidas/historial')).body.map((x: any) => x.tipo));
    expect(caja.has('baja_interna')).toBe(false);
    expect(caja.has('consumo_ot')).toBe(true);
    expect(caja.has('venta')).toBe(true);
    const dep = new Set((await d.deposito.api.get('/api/rapidas/historial')).body.map((x: any) => x.tipo));
    expect(dep.has('baja_interna')).toBe(true);
    expect(dep.has('venta')).toBe(false);
    expect((await d.mecanico.api.get('/api/rapidas/historial')).status).toBe(403);
    // el otro taller no ve nada de esto
    expect((await OTRO.api.get('/api/rapidas/historial')).body.filter((x: any) => x.tipo !== 'venta')).toEqual([]);
  });

  it('la base no deja reescribir lo registrado', async () => {
    await expect(sqlLocal(`UPDATE operaciones_rapidas SET motivo = 'robo' WHERE taller_id = '${T.tallerId}'`)).rejects.toThrow(/inmutable/);
    await expect(sqlLocal(`UPDATE operacion_rapida_items SET cantidad = 99 WHERE taller_id = '${T.tallerId}'`)).rejects.toThrow(/inmutable/);
  });
});
