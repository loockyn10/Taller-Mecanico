// Listas de precios: reglas, precios fijos, ajustes masivos, uso en presupuestos/ventas y precio histórico.
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, idem, nuevoTaller, nuevoUsuario } from './cliente';

let api: Api;
let emp: Api;
let B: Awaited<ReturnType<typeof nuevoTaller>>;
let cliente: any;
let vehiculo: any;
let a1: any;
let a2: any;
let a3: any;
const ctx: Record<string, any> = {};

const precioLista = async (listaId: string, articuloId: string) => (await api.get(`/api/articulos?lista_id=${listaId}&limite=1000`)).body.find((x: any) => x.id === articuloId).precio_lista;

beforeAll(async () => {
  ({ api } = await nuevoTaller('Taller Precios', 1));
  B = await nuevoTaller('Taller Precios B');
  emp = await nuevoUsuario(api, 'empleado');
  cliente = (await api.post('/api/clientes', { nombre: 'Cliente Precios' })).body;
  vehiculo = (await api.post('/api/vehiculos', { cliente_id: cliente.id, patente: 'LST123' })).body;
  const cat = (await api.post('/api/categorias-articulo', { nombre: 'Lubricantes' })).body;
  a1 = (await api.post('/api/articulos', { nombre: 'Aceite A', costo: 100000, precio: 150000, stock_inicial: 10, categoria_id: cat.id })).body;
  a2 = (await api.post('/api/articulos', { nombre: 'Filtro B', costo: 33333, precio: 60000, stock_inicial: 10 })).body;
  a3 = (await api.post('/api/articulos', { nombre: 'Sin costo C', costo: 0, precio: 20000, stock_inicial: 10 })).body;
  ctx.cat = cat;
});

describe('administración de listas', () => {
  it('crea listas con margen sobre costo y recargo sobre el precio base, con redondeo', async () => {
    const mayorista = await api.post('/api/listas-precios', { nombre: 'Mayorista', base: 'costo', porcentaje: 25, redondeo: 100 });
    expect(mayorista.status).toBe(201);
    ctx.mayorista = mayorista.body;
    const tarjeta = await api.post('/api/listas-precios', { nombre: 'Tarjeta', base: 'precio', porcentaje: 15, redondeo: 1000, descripcion: 'Recargo por cuotas' });
    ctx.tarjeta = tarjeta.body;
    expect((await api.post('/api/listas-precios', { nombre: 'mayorista', base: 'costo', porcentaje: 1 })).status).toBe(409); // nombre repetido
    expect((await api.post('/api/listas-precios', { nombre: 'Rara', base: 'costo', porcentaje: 5000 })).status).toBe(400);
    expect((await api.post('/api/listas-precios', { nombre: 'Rara', redondeo: 7 })).status).toBe(400);
    // Mayorista: 100000 × 1,25 = 125000 (redondeo a $1 = 100 centavos); Filtro: 33333 × 1,25 = 41666,25 → 41700; sin costo → parte del precio base
    expect(await precioLista(ctx.mayorista.id, a1.id)).toBe(125000);
    expect(await precioLista(ctx.mayorista.id, a2.id)).toBe(41700);
    expect(await precioLista(ctx.mayorista.id, a3.id)).toBe(25000);
    // Tarjeta: 150000 × 1,15 = 172500 → a $10 = 173000 (redondeo de 1000 centavos)
    expect(await precioLista(ctx.tarjeta.id, a1.id)).toBe(173000);
  });

  it('los precios calculados siguen al costo: una compra los actualiza sin tocar artículo por artículo', async () => {
    const prov = (await api.post('/api/proveedores', { nombre: 'Prov Precios' })).body;
    await api.post('/api/compras', { proveedor_id: prov.id, items: [{ articulo_id: a1.id, cantidad: 1, costo_unitario: 200000 }], idem_key: idem() });
    expect(await precioLista(ctx.mayorista.id, a1.id)).toBe(250000);
    expect(await precioLista(ctx.tarjeta.id, a1.id)).toBe(173000); // la de tarjeta parte del precio base, que no cambió
  });

  it('precio fijo por artículo y listado con origen; quitar el fijo vuelve a la regla', async () => {
    expect((await api.put(`/api/listas-precios/${ctx.mayorista.id}/items/${a2.id}`, { precio: 45000 })).status).toBe(200);
    expect(await precioLista(ctx.mayorista.id, a2.id)).toBe(45000);
    const det = (await api.get(`/api/listas-precios/${ctx.mayorista.id}/articulos?q=Filtro`)).body;
    expect(det[0]).toMatchObject({ id: a2.id, precio_fijo: 45000, precio_lista: 45000, precio_origen: 'fijo' });
    expect((await api.get(`/api/listas-precios/${ctx.mayorista.id}/articulos?solo_fijos=1`)).body).toHaveLength(1);
    expect((await api.del(`/api/listas-precios/${ctx.mayorista.id}/items/${a2.id}`)).status).toBe(200);
    expect(await precioLista(ctx.mayorista.id, a2.id)).toBe(41700);
    expect((await api.put(`/api/listas-precios/${ctx.mayorista.id}/items/inexistente`, { precio: 1 })).status).toBe(404);
  });

  it('actualización masiva: cambiar el porcentaje de la lista reprecia todo; el ajuste sobre precios fijos admite simulación', async () => {
    expect((await api.put(`/api/listas-precios/${ctx.tarjeta.id}`, { porcentaje: 20 })).status).toBe(200);
    expect(await precioLista(ctx.tarjeta.id, a1.id)).toBe(180000); // 150000 × 1,20
    // "Fijar" convierte los calculados en fijos de la categoría; luego se ajustan en bloque
    const fij = await api.post(`/api/listas-precios/${ctx.tarjeta.id}/fijar`, { categoria_id: ctx.cat.id });
    expect(fij.body.afectados).toBe(1);
    const sim = await api.post(`/api/listas-precios/${ctx.tarjeta.id}/ajuste-masivo`, { porcentaje: 10, redondeo: 100, simular: true });
    expect(sim.body).toMatchObject({ afectados: 1, simulado: true });
    expect(await precioLista(ctx.tarjeta.id, a1.id)).toBe(180000); // simular no escribe
    const real = await api.post(`/api/listas-precios/${ctx.tarjeta.id}/ajuste-masivo`, { porcentaje: 10, redondeo: 100 });
    expect(real.body.afectados).toBe(1);
    expect(await precioLista(ctx.tarjeta.id, a1.id)).toBe(198000);
  });

  it('ajuste masivo de costos y precios base por categoría o proveedor', async () => {
    const sim = await api.post('/api/articulos/ajuste-masivo', { aplicar_a: 'costo', valor: 10, categoria_id: ctx.cat.id, simular: true });
    expect(sim.body.afectados).toBe(1);
    expect(sim.body.muestra[0]).toMatchObject({ nombre: 'Aceite A', antes: 200000, despues: 220000 });
    const costo0 = (await api.get(`/api/articulos/${a1.id}`)).body.costo;
    expect(costo0).toBe(200000);
    expect((await api.post('/api/articulos/ajuste-masivo', { aplicar_a: 'costo', valor: 10, categoria_id: ctx.cat.id, redondeo: 100 })).body.afectados).toBe(1);
    expect((await api.get(`/api/articulos/${a1.id}`)).body.costo).toBe(220000);
    // El precio de venta como margen sobre el costo (sólo artículos con costo)
    const m = await api.post('/api/articulos/ajuste-masivo', { aplicar_a: 'precio', modo: 'margen_sobre_costo', valor: 50, redondeo: 1000 });
    expect(m.body.afectados).toBe(2); // a1 y a2 tienen costo; a3 no
    expect((await api.get(`/api/articulos/${a1.id}`)).body.precio).toBe(330000);
    expect((await api.get(`/api/articulos/${a3.id}`)).body.precio).toBe(20000);
    // Mayorista (base costo) se movió con el costo, sin editar nada más
    expect(await precioLista(ctx.mayorista.id, a1.id)).toBe(275000);
    expect((await api.post('/api/articulos/ajuste-masivo', { aplicar_a: 'costo', modo: 'margen_sobre_costo', valor: 5 })).status).toBe(400);
  });

  it('desactivar una lista la quita de las opciones; la predeterminada es única', async () => {
    expect((await api.put(`/api/listas-precios/${ctx.tarjeta.id}`, { es_default: true })).status).toBe(200);
    expect((await api.put(`/api/listas-precios/${ctx.mayorista.id}`, { es_default: true })).status).toBe(200);
    const todas = (await api.get('/api/listas-precios?todas=1')).body;
    expect(todas.filter((l: any) => l.es_default)).toHaveLength(1);
    expect(todas.find((l: any) => l.es_default).nombre).toBe('Mayorista');
    const extra = (await api.post('/api/listas-precios', { nombre: 'Temporal', base: 'precio', porcentaje: 5 })).body;
    expect((await api.put(`/api/listas-precios/${extra.id}`, { activa: false })).status).toBe(200);
    expect((await api.get('/api/listas-precios')).body.map((l: any) => l.nombre)).not.toContain('Temporal');
    expect((await api.get('/api/listas-precios?todas=1')).body.map((l: any) => l.nombre)).toContain('Temporal');
    ctx.inactiva = extra;
  });

  it('permisos: el empleado consulta las listas pero no las modifica; otro taller no las ve', async () => {
    expect((await emp.get('/api/listas-precios')).status).toBe(200);
    expect((await emp.post('/api/listas-precios', { nombre: 'Hackeada', base: 'costo', porcentaje: -50 })).status).toBe(403);
    expect((await emp.put(`/api/listas-precios/${ctx.mayorista.id}`, { porcentaje: -90 })).status).toBe(403);
    expect((await emp.post('/api/articulos/ajuste-masivo', { aplicar_a: 'precio', valor: -50 })).status).toBe(403);
    expect((await emp.get(`/api/listas-precios/${ctx.mayorista.id}/articulos`)).status).toBe(403);
    expect((await B.api.get(`/api/listas-precios/${ctx.mayorista.id}`)).status).toBe(404);
    expect((await B.api.put(`/api/listas-precios/${ctx.mayorista.id}`, { porcentaje: 0 })).status).toBe(404);
    expect((await B.api.get('/api/listas-precios?todas=1')).body).toHaveLength(0);
    expect((await B.api.get(`/api/articulos?lista_id=${ctx.mayorista.id}`)).status).toBe(400);
    expect((await B.api.put(`/api/listas-precios/${ctx.mayorista.id}/items/${a1.id}`, { precio: 1 })).status).toBe(404);
  });
});

describe('cambio de lista → presupuesto → OT → venta, con precio histórico', () => {
  it('el documento conserva la lista y los precios con los que se armó aunque la lista cambie después', async () => {
    const lista = ctx.mayorista;
    const precios = (await api.post(`/api/listas-precios/${lista.id}/precios`, { articulos: [a1.id, a2.id], servicios: [] })).body;
    expect(precios.articulos[a1.id]).toBe(275000);
    const p = await api.post('/api/presupuestos', {
      cliente_id: cliente.id, vehiculo_id: vehiculo.id, lista_precio_id: lista.id,
      items: [{ tipo: 'articulo', articulo_id: a1.id, descripcion: 'Aceite A', cantidad: 2, precio_unitario: precios.articulos[a1.id] }],
    });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect(p.body).toMatchObject({ lista_precio_id: lista.id, lista_precio_nombre: 'Mayorista', total: 550000 });
    // La lista cambia y se renombra
    await api.put(`/api/listas-precios/${lista.id}`, { porcentaje: 80, nombre: 'Mayorista 2' });
    expect(await precioLista(lista.id, a1.id)).toBe(396000);
    // Presupuesto → OT → comprobante
    await api.post(`/api/presupuestos/${p.body.id}/estado`, { estado: 'aprobado' });
    const ot = (await api.post(`/api/presupuestos/${p.body.id}/convertir`, {})).body;
    const orden = (await api.get(`/api/ordenes/${ot.id}`)).body;
    expect(orden).toMatchObject({ lista_precio_id: lista.id, lista_precio_nombre: 'Mayorista', total: 550000 });
    await api.post(`/api/ordenes/${ot.id}/estado`, { estado: 'lista' });
    const v = await api.post(`/api/ordenes/${ot.id}/comprobante`, { condicion: 'cuenta_corriente' });
    expect(v.status).toBe(201);
    const venta = (await api.get(`/api/ventas/${v.body.id}`)).body;
    expect(venta).toMatchObject({ lista_precio_id: lista.id, lista_precio_nombre: 'Mayorista', total: 550000 });
    expect(venta.items[0].precio_unitario).toBe(275000);
  });

  it('una venta de mostrador registra la lista; una lista inexistente, ajena o desactivada se rechaza', async () => {
    const base = { items: [{ tipo: 'articulo', articulo_id: a1.id, descripcion: 'Aceite', cantidad: 1, precio_unitario: 100 }], cobro: { medio: 'efectivo' } };
    const ok = await api.post('/api/ventas', { ...base, lista_precio_id: ctx.tarjeta.id, idem_key: idem() });
    expect(ok.status).toBe(201);
    expect(ok.body.lista_precio_nombre).toBe('Tarjeta');
    expect((await api.post('/api/ventas', { ...base, lista_precio_id: 'nope', idem_key: idem() })).status).toBe(400);
    expect((await api.post('/api/ventas', { ...base, lista_precio_id: ctx.inactiva.id, idem_key: idem() })).status).toBe(400);
    expect((await B.api.post('/api/ventas', { items: [{ tipo: 'libre', descripcion: 'x', cantidad: 1, precio_unitario: 1 }], cobro: { medio: 'efectivo' }, lista_precio_id: ctx.tarjeta.id, idem_key: idem() })).status).toBe(400);
  });

  it('editar un presupuesto pendiente conserva su lista aunque haya sido desactivada, y la fecha si no se envía', async () => {
    const lst = (await api.post('/api/listas-precios', { nombre: 'Para desactivar', base: 'precio', porcentaje: 0 })).body;
    const items = [{ tipo: 'libre', descripcion: 'Trabajo', cantidad: 1, precio_unitario: 10000 }];
    const p = (await api.post('/api/presupuestos', { cliente_id: cliente.id, vehiculo_id: vehiculo.id, lista_precio_id: lst.id, items })).body;
    await api.put(`/api/listas-precios/${lst.id}`, { activa: false });
    const ed = await api.put(`/api/presupuestos/${p.id}`, { cliente_id: cliente.id, vehiculo_id: vehiculo.id, lista_precio_id: lst.id, items: [{ ...items[0], precio_unitario: 12000 }] });
    expect(ed.status, JSON.stringify(ed.body)).toBe(200);
    const det = (await api.get(`/api/presupuestos/${p.id}`)).body;
    expect(det).toMatchObject({ lista_precio_nombre: 'Para desactivar', total: 12000, fecha: p.fecha });
    // Y se puede quitar la lista
    await api.put(`/api/presupuestos/${p.id}`, { cliente_id: cliente.id, vehiculo_id: vehiculo.id, lista_precio_id: null, items });
    expect((await api.get(`/api/presupuestos/${p.id}`)).body.lista_precio_id).toBeNull();
  });
});
