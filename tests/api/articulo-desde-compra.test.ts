// Sprint 26: alta de un artículo desde «Nueva compra». Mismo endpoint de Artículos: permiso en el servidor, sin movimientos por el alta,
// y el stock entra sólo por la recepción de la compra.
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, idem, nuevoPersonal, nuevoTaller } from './cliente';

let T: Awaited<ReturnType<typeof nuevoTaller>>;
let api: Api;
const d: Record<string, any> = {};

beforeAll(async () => {
  T = await nuevoTaller('Taller Alta Compra', 3);
  api = T.api;
  d.mecanico = await nuevoPersonal(api, 'mecanico');
  d.prov = (await api.post('/api/proveedores', { nombre: 'Proveedor Alta' })).body;
});

describe('artículo creado desde la compra', () => {
  it('quien no puede crear artículos recibe 403 y no se crea nada', async () => {
    const r = await d.mecanico.api.post('/api/articulos', { nombre: 'Intruso', stock_inicial: 0 });
    expect(r.status).toBe(403);
    expect((await api.get('/api/articulos?q=Intruso')).body).toEqual([]);
  });

  it('el alta sin stock inicial no crea movimientos de stock', async () => {
    const r = await api.post('/api/articulos', { nombre: 'Bujía nueva', costo: 5000, precio: 9000, stock_inicial: 0 });
    expect(r.status).toBe(201);
    d.art = r.body;
    expect((await api.get(`/api/stock/movimientos?articulo_id=${d.art.id}`)).body).toEqual([]);
    expect((await api.get(`/api/articulos/${d.art.id}`)).body.stock).toBe(0);
  });

  it('la compra recibida suma el stock una sola vez, aun con reintento', async () => {
    const clave = idem();
    const cuerpo = { proveedor_id: d.prov.id, fecha: new Date().toISOString().slice(0, 10), tipo_doc: 'factura', iva: 0, otros: 0, actualizar_costos: true, items: [{ articulo_id: d.art.id, cantidad: 4, costo_unitario: 5000 }], idem_key: clave, pago: null };
    const a = await api.post('/api/compras', cuerpo);
    expect(a.status).toBe(201);
    await api.post('/api/compras', cuerpo);
    expect((await api.get(`/api/articulos/${d.art.id}`)).body.stock).toBe(4);
    const movs = (await api.get(`/api/stock/movimientos?articulo_id=${d.art.id}`)).body;
    expect(movs).toHaveLength(1);
    expect(movs[0].origen_tipo).toBe('compra');
    expect((await api.get('/api/inventario/verificar')).body.diferencias).toEqual([]);
  });
});
