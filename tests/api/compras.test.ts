// Compras → stock → cuenta del proveedor; pagos a proveedor → caja; anulaciones; reposición; aislamiento de compras/proveedores.
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, hoyAR, idem, nuevoTaller, nuevoUsuario } from './cliente';

let api: Api;
let emp: Api;
let prov: any;
let art: any;
let B: Awaited<ReturnType<typeof nuevoTaller>>;
const ctx: Record<string, any> = {};

const movs = async () => (await api.get(`/api/caja/movimientos?desde=${hoyAR()}&hasta=${hoyAR()}`)).body as any[];
const cuenta = async () => (await api.get(`/api/proveedores/${prov.id}/cuenta`)).body;
const stock = async () => (await api.get(`/api/articulos/${art.id}`)).body;

beforeAll(async () => {
  ({ api } = await nuevoTaller('Taller Compras', 1));
  B = await nuevoTaller('Taller Compras B');
  emp = await nuevoUsuario(api, 'empleado');
  prov = (await api.post('/api/proveedores', { nombre: 'Distribuidora Norte', cuit: '30-22222222-2' })).body;
  art = (await api.post('/api/articulos', { nombre: 'Correa poly-V', costo: 100000, precio: 180000, stock_inicial: 2, stock_minimo: 3, proveedor_id: prov.id })).body;
});

describe('compra → stock → cuenta corriente del proveedor', () => {
  it('registra una compra: suma stock, actualiza costo y genera deuda con el proveedor', async () => {
    const key = idem();
    const c = await api.post('/api/compras', { proveedor_id: prov.id, numero_doc: 'A-1', iva: 210000, items: [{ articulo_id: art.id, cantidad: 10, costo_unitario: 120000 }], idem_key: key });
    expect(c.status).toBe(201);
    ctx.compra = c.body;
    expect(await stock()).toMatchObject({ stock: 12, costo: 120000 });
    expect((await cuenta()).saldo).toBe(1200000 + 210000);
    // Reintento con la misma clave: no duplica stock ni deuda
    expect((await api.post('/api/compras', { proveedor_id: prov.id, numero_doc: 'A-1', iva: 210000, items: [{ articulo_id: art.id, cantidad: 10, costo_unitario: 120000 }], idem_key: key })).status).toBe(409);
    expect((await stock()).stock).toBe(12);
    // Trazabilidad del movimiento de stock
    const m = (await api.get(`/api/stock/movimientos?articulo_id=${art.id}&tipo=compra`)).body;
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ cantidad: 10, stock_resultante: 12, origen_tipo: 'compra', origen_id: ctx.compra.id });
  });

  it('validaciones: artículos repetidos, inexistentes, proveedor inactivo y fecha futura', async () => {
    const base = { proveedor_id: prov.id, idem_key: idem() };
    const it1 = { articulo_id: art.id, cantidad: 1, costo_unitario: 100 };
    expect((await api.post('/api/compras', { ...base, items: [it1, it1] })).status).toBe(400);
    expect((await api.post('/api/compras', { ...base, idem_key: idem(), items: [{ ...it1, articulo_id: 'nope' }] })).status).toBe(400);
    expect((await api.post('/api/compras', { ...base, idem_key: idem(), fecha: hoyAR(1), items: [it1] })).status).toBe(400);
    expect((await api.post('/api/compras', { ...base, idem_key: idem(), items: [{ ...it1, cantidad: 0.0001 }] })).status).toBe(400);
    const inactivo = (await api.post('/api/proveedores', { nombre: 'Proveedor cerrado' })).body;
    await api.put(`/api/proveedores/${inactivo.id}`, { activo: false });
    expect((await api.post('/api/compras', { proveedor_id: inactivo.id, idem_key: idem(), items: [it1] })).status).toBe(400);
  });

  it('pago a proveedor: egreso de caja, no supera la deuda salvo anticipo explícito, y es idempotente', async () => {
    const antes = (await movs()).length;
    const key = idem();
    const pago = { proveedor_id: prov.id, importe: 400000, medio: 'efectivo', idem_key: key };
    const [a, b] = await Promise.all([api.post('/api/pagos-proveedor', pago), api.post('/api/pagos-proveedor', pago)]);
    expect([a, b].filter((r) => r.status === 201 || r.body?.duplicado)).toHaveLength(2);
    expect(new Set([a.body.id, b.body.id]).size).toBe(1); // mismo pago
    ctx.pago = a.body;
    expect((await cuenta()).saldo).toBe(1410000 - 400000);
    const nuevos = (await movs()).slice(0, (await movs()).length - antes);
    expect(nuevos.filter((m) => m.rubro === 'pago_proveedor')).toHaveLength(1);
    expect(nuevos[0]).toMatchObject({ tipo: 'egreso', medio: 'efectivo', importe: 400000 });
    // Excede la deuda
    const exc = await api.post('/api/pagos-proveedor', { proveedor_id: prov.id, importe: 5000000, medio: 'transferencia', idem_key: idem() });
    expect(exc.status).toBe(409);
    expect(exc.body.error.code).toBe('saldo_excedido');
    expect((await api.post('/api/pagos-proveedor', { proveedor_id: prov.id, importe: 100, medio: 'cheque', idem_key: idem() })).status).toBe(400); // cheque sin número
  });

  it('anular un pago lo revierte en la cuenta y en la caja; dos veces no', async () => {
    expect((await api.post(`/api/pagos-proveedor/${ctx.pago.id}/anular`, { motivo: 'se pagó dos veces' })).status).toBe(200);
    expect((await api.post(`/api/pagos-proveedor/${ctx.pago.id}/anular`, { motivo: 'otra vez' })).status).toBe(409);
    expect((await cuenta()).saldo).toBe(1410000);
    const reversos = (await movs()).filter((m) => m.origen_tipo === 'reverso' && m.rubro === 'pago_proveedor');
    expect(reversos).toHaveLength(1);
    expect(reversos[0]).toMatchObject({ tipo: 'ingreso', importe: 400000 });
    // El movimiento anulado se ve (marcado) en la cuenta pero no suma al saldo
    const mov = (await cuenta()).movimientos.find((m: any) => m.tipo === 'pago');
    expect(mov.anulado).toBe(1);
  });

  it('el anticipo debe pedirse explícitamente y deja saldo a favor', async () => {
    const p2 = (await api.post('/api/proveedores', { nombre: 'Proveedor sin deuda' })).body;
    expect((await api.post('/api/pagos-proveedor', { proveedor_id: p2.id, importe: 1000, medio: 'efectivo', idem_key: idem() })).status).toBe(409);
    expect((await api.post('/api/pagos-proveedor', { proveedor_id: p2.id, importe: 1000, medio: 'efectivo', permitir_anticipo: true, idem_key: idem() })).status).toBe(201);
    expect((await api.get(`/api/proveedores/${p2.id}/cuenta`)).body.saldo).toBe(-1000);
  });

  it('pagos simultáneos que juntos superan la deuda: la base impide pagar de más', async () => {
    const p3 = (await api.post('/api/proveedores', { nombre: 'Proveedor concurrencia' })).body;
    await api.post('/api/compras', { proveedor_id: p3.id, items: [{ articulo_id: art.id, cantidad: 1, costo_unitario: 10000 }], idem_key: idem() });
    const rs = await Promise.all(Array.from({ length: 4 }, () => api.post('/api/pagos-proveedor', { proveedor_id: p3.id, importe: 10000, medio: 'transferencia', idem_key: idem() })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await api.get(`/api/proveedores/${p3.id}/cuenta`)).body.saldo).toBe(0);
  });
});

describe('compra de contado y anulación', () => {
  it('paga en el acto desde la caja y al anular revierte stock, pago, caja y costo', async () => {
    const antes = await stock();
    const antesMovs = (await movs()).length;
    const c = await api.post('/api/compras', {
      proveedor_id: prov.id, items: [{ articulo_id: art.id, cantidad: 5, costo_unitario: 150000 }], pago: { medio: 'efectivo' }, idem_key: idem(),
    });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const det = (await api.get(`/api/compras/${c.body.id}`)).body;
    expect(det).toMatchObject({ total: 750000, pagado_contado: 750000 });
    expect(det.pagos).toHaveLength(1);
    expect(await stock()).toMatchObject({ stock: antes.stock + 5, costo: 150000 });
    expect((await movs()).length).toBe(antesMovs + 1); // un solo egreso
    const saldoConPago = (await cuenta()).saldo;
    expect(saldoConPago).toBe(1410000); // la compra y su pago se compensan
    // Anular: vuelve el stock, el costo anterior, el pago y el dinero
    expect((await api.post(`/api/compras/${c.body.id}/anular`, {})).status).toBe(200);
    expect(await stock()).toMatchObject({ stock: antes.stock, costo: antes.costo });
    expect((await cuenta()).saldo).toBe(1410000);
    const rev = (await movs()).filter((m) => m.origen_tipo === 'reverso' && m.rubro === 'pago_proveedor');
    expect(rev).toHaveLength(2); // el del pago anulado antes + el de esta compra
    expect((await api.get(`/api/pagos-proveedor?estado=anulado`)).body.some((p: any) => p.compra_id === c.body.id)).toBe(true);
    expect((await api.post(`/api/compras/${c.body.id}/anular`, {})).status).toBe(409);
  });

  it('no se pisa un costo posterior al anular una compra anterior', async () => {
    const c1 = (await api.post('/api/compras', { proveedor_id: prov.id, items: [{ articulo_id: art.id, cantidad: 1, costo_unitario: 130000 }], idem_key: idem() })).body;
    await api.put(`/api/articulos/${art.id}`, { costo: 175000 }); // el dueño corrigió el costo a mano después
    expect((await api.post(`/api/compras/${c1.id}/anular`, {})).status).toBe(200);
    expect((await stock()).costo).toBe(175000);
  });

  it('una compra no se anula si el stock ya se vendió (sin inconsistencias)', async () => {
    const a2 = (await api.post('/api/articulos', { nombre: 'Bujía', stock_inicial: 0, precio: 5000 })).body;
    const c = (await api.post('/api/compras', { proveedor_id: prov.id, items: [{ articulo_id: a2.id, cantidad: 2, costo_unitario: 1000 }], idem_key: idem() })).body;
    await api.post('/api/ventas', { items: [{ tipo: 'articulo', articulo_id: a2.id, descripcion: 'Bujía', cantidad: 2, precio_unitario: 5000 }], cobro: { medio: 'efectivo' }, idem_key: idem() });
    const r = await api.post(`/api/compras/${c.id}/anular`, {});
    expect(r.status).toBe(409);
    expect((await api.get(`/api/articulos/${a2.id}`)).body.stock).toBe(0);
  });
});

describe('reposición y stock mínimo', () => {
  it('lista los artículos en o bajo el mínimo con la cantidad sugerida y su proveedor', async () => {
    const a = (await api.post('/api/articulos', { nombre: 'Aceite 10W40', stock_inicial: 1, stock_minimo: 4, stock_objetivo: 10, proveedor_id: prov.id, costo: 5000, precio: 9000 })).body;
    const b = (await api.post('/api/articulos', { nombre: 'Filtro raro', stock_inicial: 2, stock_minimo: 2, costo: 100, precio: 200 })).body;
    const ok = (await api.post('/api/articulos', { nombre: 'Sobrado', stock_inicial: 50, stock_minimo: 2 })).body;
    const rep = (await api.get('/api/reposicion')).body;
    const ids = rep.map((r: any) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(ok.id);
    expect(rep.find((r: any) => r.id === a.id)).toMatchObject({ sugerido: 9, objetivo: 10, proveedor: 'Distribuidora Norte' });
    expect(rep.find((r: any) => r.id === b.id)).toMatchObject({ sugerido: 2, proveedor: null }); // sin objetivo: hasta el doble del mínimo
    expect((await api.get(`/api/reposicion?proveedor_id=${prov.id}`)).body.every((r: any) => r.proveedor_id === prov.id)).toBe(true);
    expect((await emp.get('/api/reposicion')).status).toBe(200); // el empleado ve el stock
    expect((await emp.post('/api/compras', { proveedor_id: prov.id, items: [], idem_key: idem() })).status).toBe(403);
  });
});

describe('aislamiento de compras, proveedores y pagos', () => {
  it('otro taller no ve ni opera sobre compras, proveedores y pagos ajenos', async () => {
    const p = (await api.get('/api/pagos-proveedor')).body[0];
    for (const url of [`/api/compras/${ctx.compra.id}`, `/api/proveedores/${prov.id}/cuenta`]) expect((await B.api.get(url)).status, url).toBe(404);
    expect((await B.api.post(`/api/compras/${ctx.compra.id}/anular`, {})).status).toBe(404);
    expect((await B.api.post(`/api/pagos-proveedor/${p.id}/anular`, { motivo: 'xxx' })).status).toBe(404);
    expect((await B.api.post('/api/pagos-proveedor', { proveedor_id: prov.id, importe: 100, medio: 'efectivo', permitir_anticipo: true, idem_key: idem() })).status).toBe(400);
    expect((await B.api.post('/api/compras', { proveedor_id: prov.id, items: [{ articulo_id: art.id, cantidad: 1, costo_unitario: 1 }], idem_key: idem() })).status).toBe(400);
    expect((await B.api.get('/api/compras')).body).toHaveLength(0);
    expect((await B.api.get('/api/reposicion')).body).toHaveLength(0);
    expect((await B.api.get('/api/pagos-proveedor')).body).toHaveLength(0);
    expect((await B.api.get('/api/gastos')).body).toHaveLength(0);
  });
});
