// Compras avanzadas: orden de compra → recepción → stock; factura de proveedor (sin duplicar deuda ni comprobante);
// pagos parciales → cuenta corriente y vencimientos; cheques en pagos; reposición → orden de compra; inventario avanzado.
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, hoyAR, idem, nuevoTaller, nuevoUsuario } from './cliente';

let api: Api;
let emp: Api;
let B: Awaited<ReturnType<typeof nuevoTaller>>;
let prov: any;
let a1: any;
let a2: any;
const ctx: Record<string, any> = {};

const stockDe = async (a: any) => (await api.get(`/api/articulos/${a.id}`)).body;
const cuenta = async (p = prov) => (await api.get(`/api/proveedores/${p.id}/cuenta`)).body;
const oc = async (id: string) => (await api.get(`/api/ordenes-compra/${id}`)).body;

beforeAll(async () => {
  ({ api } = await nuevoTaller('Taller Abastecimiento', 2));
  emp = await nuevoUsuario(api, 'empleado');
  B = await nuevoTaller('Taller Abastecimiento B');
  prov = (await api.post('/api/proveedores', { nombre: 'Distribuidora Sur', cuit: '30-71234567-1' })).body;
  a1 = (await api.post('/api/articulos', { nombre: 'Filtro de aceite', costo: 10000, precio: 20000, stock_inicial: 1, stock_minimo: 5, stock_objetivo: 20, proveedor_id: prov.id })).body;
  a2 = (await api.post('/api/articulos', { nombre: 'Pastillas', costo: 50000, precio: 90000, stock_inicial: 0, proveedor_id: prov.id })).body;
});

describe('orden de compra → recepción → stock', () => {
  it('se crea en borrador con totales calculados y se emite; el empleado no accede', async () => {
    const items = [{ articulo_id: a1.id, cantidad: 10, costo_unitario: 10000, desc_pct: 10 }, { articulo_id: a2.id, cantidad: 4, costo_unitario: 50000 }];
    const key = idem();
    const r = await api.post('/api/ordenes-compra', { proveedor_id: prov.id, fecha_prevista: hoyAR(5), descuento_pct: 5, iva_pct: 21, observaciones: 'Entregar por la mañana', items, idem_key: key });
    expect(r.status).toBe(201);
    expect((await api.post('/api/ordenes-compra', { proveedor_id: prov.id, items, idem_key: key })).body.duplicado).toBe(true); // doble clic
    ctx.oc = (await oc(r.body.id));
    // subtotal = 10*10000*0.9 + 4*50000 = 90000 + 200000 = 290000; desc 5% = 14500; neto = 275500; iva 21% = 57855
    expect(ctx.oc).toMatchObject({ estado: 'borrador', subtotal: 290000, descuento: 14500, neto: 275500, iva: 57855, total: 333355, unidades: 14, unidades_recibidas: 0 });
    // en borrador no admite recepciones
    const it0 = ctx.oc.items[0];
    expect((await api.post(`/api/ordenes-compra/${ctx.oc.id}/recepciones`, { items: [{ orden_item_id: it0.id, cantidad: 1 }], idem_key: idem() })).status).toBe(409);
    expect((await api.put(`/api/ordenes-compra/${ctx.oc.id}`, { proveedor_id: prov.id, descuento_pct: 5, iva_pct: 21, items: [{ articulo_id: a1.id, cantidad: 10, costo_unitario: 10000, desc_pct: 10 }, { articulo_id: a2.id, cantidad: 4, costo_unitario: 50000 }] })).status).toBe(200);
    expect((await api.post(`/api/ordenes-compra/${ctx.oc.id}/emitir`, {})).status).toBe(200);
    expect((await api.post(`/api/ordenes-compra/${ctx.oc.id}/emitir`, {})).status).toBe(409);
    expect((await emp.get('/api/ordenes-compra')).status).toBe(403);
    expect((await api.post('/api/ordenes-compra', { proveedor_id: prov.id, items: [items[0], items[0]], idem_key: idem() })).status).toBe(400); // artículo repetido
  });

  it('la recepción parcial suma sólo lo recibido, deja la orden "parcial" y registra la diferencia', async () => {
    ctx.oc = await oc(ctx.oc.id);
    const [i1, i2] = ctx.oc.items;
    const key = idem();
    const body = { remito: 'R-0001-0000123', items: [{ orden_item_id: i1.id, cantidad: 6 }], idem_key: key };
    const r = await api.post(`/api/ordenes-compra/${ctx.oc.id}/recepciones`, body);
    expect(r.status).toBe(201);
    expect((await api.post(`/api/ordenes-compra/${ctx.oc.id}/recepciones`, body)).body.duplicado).toBe(true); // reintento: el stock no se duplica
    ctx.rec1 = r.body;
    expect((await stockDe(a1)).stock).toBe(1 + 6);
    expect((await stockDe(a2)).stock).toBe(0);
    // el costo del artículo toma el costo neto (con descuentos): 10000 * 0.9 * 0.95 = 8550
    expect((await stockDe(a1)).costo).toBe(8550);
    const o = await oc(ctx.oc.id);
    expect(o).toMatchObject({ estado: 'parcial', unidades_recibidas: 6 });
    const rec = (await api.get(`/api/recepciones/${ctx.rec1.id}`)).body;
    expect(rec.items[0]).toMatchObject({ cantidad: 6, pendiente_antes: 10, diferencia: -4 });
    // trazabilidad en stock: un único movimiento de compra con origen recepción
    const m = (await api.get(`/api/stock/movimientos?articulo_id=${a1.id}&tipo=compra`)).body;
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ cantidad: 6, origen_tipo: 'recepcion', origen_id: ctx.rec1.id });
  });

  it('no se puede recibir más de lo pendiente, ni repetir el remito; dos recepciones simultáneas del mismo saldo no exceden la orden', async () => {
    const [i1, i2] = (await oc(ctx.oc.id)).items;
    expect((await api.post(`/api/ordenes-compra/${ctx.oc.id}/recepciones`, { items: [{ orden_item_id: i1.id, cantidad: 4.5 }], idem_key: idem() })).status).toBe(409);
    expect((await api.post(`/api/ordenes-compra/${ctx.oc.id}/recepciones`, { remito: 'R-0001-0000123', items: [{ orden_item_id: i1.id, cantidad: 1 }], idem_key: idem() })).status).toBe(409);
    const una = () => api.post(`/api/ordenes-compra/${ctx.oc.id}/recepciones`, { items: [{ orden_item_id: i2.id, cantidad: 3 }], idem_key: idem() });
    const [x, y] = await Promise.all([una(), una()]);
    expect([x.status, y.status].sort()).toEqual([201, 409]); // el CHECK de cantidad_recibida frena a la segunda
    expect((await stockDe(a2)).stock).toBe(3);
    expect((await oc(ctx.oc.id)).items[1].cantidad_recibida).toBe(3);
  });

  it('completa la orden, y anular una recepción revierte stock, costo y estado', async () => {
    const [i1, i2] = (await oc(ctx.oc.id)).items;
    const r2 = await api.post(`/api/ordenes-compra/${ctx.oc.id}/recepciones`, { remito: 'R-0001-0000124', items: [{ orden_item_id: i1.id, cantidad: 4 }, { orden_item_id: i2.id, cantidad: 1 }], idem_key: idem() });
    expect(r2.status).toBe(201);
    expect(await oc(ctx.oc.id)).toMatchObject({ estado: 'recibida', unidades_recibidas: 14 });
    expect((await stockDe(a1)).stock).toBe(11);
    // la orden recibida no admite más recepciones
    expect((await api.post(`/api/ordenes-compra/${ctx.oc.id}/recepciones`, { items: [{ orden_item_id: i1.id, cantidad: 1 }], idem_key: idem() })).status).toBe(409);
    expect((await api.post(`/api/recepciones/${r2.body.id}/anular`, { motivo: 'Remito cargado en la orden equivocada' })).status).toBe(200);
    expect((await api.post(`/api/recepciones/${r2.body.id}/anular`, { motivo: 'otra vez' })).status).toBe(409);
    expect((await stockDe(a1)).stock).toBe(7);
    expect(await oc(ctx.oc.id)).toMatchObject({ estado: 'parcial', unidades_recibidas: 9 });
    // volver a recibir el saldo con el mismo remito (el anterior quedó anulado)
    const r3 = await api.post(`/api/ordenes-compra/${ctx.oc.id}/recepciones`, { remito: 'R-0001-0000124', items: [{ orden_item_id: i1.id, cantidad: 4 }, { orden_item_id: i2.id, cantidad: 1 }], idem_key: idem() });
    expect(r3.status).toBe(201);
    expect((await oc(ctx.oc.id)).estado).toBe('recibida');
    expect((await stockDe(a1)).stock).toBe(11);
  });

  it('cerrar con faltante, cancelar y estados inválidos', async () => {
    const o2 = (await api.post('/api/ordenes-compra', { proveedor_id: prov.id, emitir: true, items: [{ articulo_id: a2.id, cantidad: 10, costo_unitario: 50000 }], idem_key: idem() })).body;
    const det = await oc(o2.id);
    expect((await api.post(`/api/ordenes-compra/${o2.id}/cerrar`, { motivo: 'sin recepciones' })).status).toBe(409);
    await api.post(`/api/ordenes-compra/${o2.id}/recepciones`, { items: [{ orden_item_id: det.items[0].id, cantidad: 6 }], idem_key: idem() });
    expect((await api.post(`/api/ordenes-compra/${o2.id}/cancelar`, { motivo: 'ya recibió algo' })).status).toBe(409);
    expect((await api.post(`/api/ordenes-compra/${o2.id}/cerrar`, { motivo: 'El proveedor no tiene más stock' })).status).toBe(200);
    expect(await oc(o2.id)).toMatchObject({ estado: 'recibida', cerrada_con_faltante: 1, unidades_recibidas: 6, unidades: 10 });
    const o3 = (await api.post('/api/ordenes-compra', { proveedor_id: prov.id, items: [{ articulo_id: a2.id, cantidad: 1, costo_unitario: 1 }], idem_key: idem() })).body;
    expect((await api.post(`/api/ordenes-compra/${o3.id}/cancelar`, { motivo: 'Ya no hace falta' })).status).toBe(200);
    expect((await oc(o3.id)).estado).toBe('cancelada');
    expect((await api.post(`/api/ordenes-compra/${o3.id}/emitir`, {})).status).toBe(409);
    ctx.ocFaltante = o2;
  });
});

describe('factura de proveedor', () => {
  it('la deuda nace con la factura (la recepción sólo movió stock) y no se puede cargar dos veces', async () => {
    expect((await cuenta()).saldo).toBe(0); // recibir mercadería no genera deuda
    const f = {
      proveedor_id: prov.id, tipo: 'factura_a', nro_comprobante: '1-4521', fecha: hoyAR(), orden_compra_id: ctx.oc.id,
      neto_gravado: 275500, iva_21: 57855, total: 333355, condicion_pago: 'plazo', dias_plazo: 15, idem_key: idem(),
    };
    const r = await api.post('/api/facturas-proveedor', f);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ nro_comprobante: '0001-00004521', genera_deuda: true, vencimiento: hoyAR(15) });
    ctx.factura = r.body;
    expect((await cuenta()).saldo).toBe(333355);
    expect((await api.post('/api/facturas-proveedor', { ...f, idem_key: idem() })).status).toBe(409); // mismo comprobante
    expect((await api.post('/api/facturas-proveedor', { ...f, idem_key: f.idem_key })).body.duplicado).toBe(true);
    expect((await cuenta()).saldo).toBe(333355);
  });

  it('valida total, CUIT, número, fecha y la orden asociada', async () => {
    const base = { proveedor_id: prov.id, tipo: 'factura_b', nro_comprobante: '2-1', fecha: hoyAR(), neto_gravado: 1000, total: 1000, idem_key: idem() };
    expect((await api.post('/api/facturas-proveedor', { ...base, total: 1200 })).status).toBe(400); // no cierra con los importes
    expect((await api.post('/api/facturas-proveedor', { ...base, nro_comprobante: 'ABC', idem_key: idem() })).status).toBe(400);
    expect((await api.post('/api/facturas-proveedor', { ...base, cuit: '30-71234567-0', idem_key: idem() })).status).toBe(400); // dígito verificador
    expect((await api.post('/api/facturas-proveedor', { ...base, cuit: '20-12345678-6', idem_key: idem() })).status).toBe(400); // no es el CUIT del proveedor
    expect((await api.post('/api/facturas-proveedor', { ...base, fecha: hoyAR(2), idem_key: idem() })).status).toBe(400);
    expect((await api.post('/api/facturas-proveedor', { ...base, orden_compra_id: 'inexistente', idem_key: idem() })).status).toBe(400);
    const borrador = (await api.post('/api/ordenes-compra', { proveedor_id: prov.id, items: [{ articulo_id: a1.id, cantidad: 1, costo_unitario: 1 }], idem_key: idem() })).body;
    expect((await api.post('/api/facturas-proveedor', { ...base, orden_compra_id: borrador.id, idem_key: idem() })).status).toBe(409); // sin mercadería recibida
  });

  it('una factura asociada a una compra existente no duplica la deuda ni se carga dos veces', async () => {
    const compra = (await api.post('/api/compras', { proveedor_id: prov.id, tipo_doc: 'factura', numero_doc: '0003-00000777', items: [{ articulo_id: a2.id, cantidad: 2, costo_unitario: 50000 }], idem_key: idem() })).body;
    const antes = (await cuenta()).saldo;
    // el mismo comprobante como factura "suelta" sería deuda duplicada
    const suelta = { proveedor_id: prov.id, tipo: 'factura_a', nro_comprobante: '3-777', fecha: hoyAR(), neto_gravado: 100000, total: 100000, idem_key: idem() };
    expect((await api.post('/api/facturas-proveedor', suelta)).status).toBe(409);
    const asociada = await api.post('/api/facturas-proveedor', { ...suelta, compra_id: compra.id, idem_key: idem() });
    expect(asociada.status).toBe(201);
    expect(asociada.body).toMatchObject({ genera_deuda: false, diferencia_con_compra: 0 });
    expect((await cuenta()).saldo).toBe(antes);
    expect((await api.post('/api/facturas-proveedor', { ...suelta, nro_comprobante: '3-778', compra_id: compra.id, idem_key: idem() })).status).toBe(409); // la compra ya tiene factura
    // con factura asociada la compra no se puede anular sin anular la factura
    expect((await api.post(`/api/compras/${compra.id}/anular`, {})).status).toBe(409);
    ctx.compraFacturada = compra;
  });

  it('una nota de crédito reduce la deuda y anular una factura la quita', async () => {
    const antes = (await cuenta()).saldo;
    const nc = await api.post('/api/facturas-proveedor', { proveedor_id: prov.id, tipo: 'nota_credito_a', nro_comprobante: '1-90', fecha: hoyAR(), neto_gravado: 10000, iva_21: 2100, total: 12100, idem_key: idem() });
    expect(nc.status).toBe(201);
    expect((await cuenta()).saldo).toBe(antes - 12100);
    expect((await api.post(`/api/facturas-proveedor/${nc.body.id}/anular`, { motivo: 'Cargada en el proveedor equivocado' })).status).toBe(200);
    expect((await cuenta()).saldo).toBe(antes);
    expect((await api.post(`/api/facturas-proveedor/${nc.body.id}/anular`, { motivo: 'otra vez' })).status).toBe(409);
  });
});

describe('pago parcial → cuenta corriente, vencimientos y cheques', () => {
  it('los pagos parciales se imputan al comprobante más antiguo y el estado de cuenta muestra vencimientos', async () => {
    const p2 = (await api.post('/api/proveedores', { nombre: 'Proveedor Vencimientos' })).body;
    const art = a1;
    // compra antigua ya vencida (30 días) y factura nueva con plazo
    await api.post('/api/compras', { proveedor_id: p2.id, fecha: hoyAR(0), vencimiento: hoyAR(0), items: [{ articulo_id: art.id, cantidad: 1, costo_unitario: 100000 }], idem_key: idem() });
    const fac = await api.post('/api/facturas-proveedor', { proveedor_id: p2.id, tipo: 'factura_c', nro_comprobante: '5-10', fecha: hoyAR(), neto_gravado: 60000, total: 60000, condicion_pago: 'plazo', dias_plazo: 20, idem_key: idem() });
    expect(fac.status).toBe(201);
    let c = await cuenta(p2);
    expect(c.saldo).toBe(160000);
    expect(c.deuda.docs).toHaveLength(2);
    const pago = await api.post('/api/pagos-proveedor', { proveedor_id: p2.id, importe: 70000, medio: 'efectivo', idem_key: idem() });
    expect(pago.status).toBe(201);
    c = await cuenta(p2);
    expect(c.saldo).toBe(90000);
    // FIFO: el pago de 70000 cancela 70000 de los 100000 más antiguos (vence hoy) y queda el resto + la factura
    const docs = c.deuda.docs.sort((a: any, b: any) => (a.vencimiento < b.vencimiento ? -1 : 1));
    expect(docs.map((d: any) => d.pendiente)).toEqual([30000, 60000]);
    expect(docs[0].tipo).toBe('compra');
    expect(c.movimientos.map((m: any) => m.tipo).sort()).toEqual(['compra', 'factura', 'pago']);
    // pagar más que la deuda exige anticipo explícito
    expect((await api.post('/api/pagos-proveedor', { proveedor_id: p2.id, importe: 90001, medio: 'efectivo', idem_key: idem() })).status).toBe(409);
    const todos = (await api.get('/api/vencimientos-proveedores')).body;
    expect(todos.filter((d: any) => d.proveedor_id === p2.id)).toHaveLength(2);
    const deudas = (await api.get('/api/deuda-proveedores')).body;
    expect(deudas.find((d: any) => d.proveedor_id === p2.id)).toMatchObject({ saldo: 90000, comprobantes: 2 });
  });

  it('un cheque recibido se endosa a un proveedor: sale de la cartera, baja la deuda y vuelve a cartera si se anula el pago', async () => {
    const p3 = (await api.post('/api/proveedores', { nombre: 'Proveedor Cheque' })).body;
    await api.post('/api/compras', { proveedor_id: p3.id, items: [{ articulo_id: a1.id, cantidad: 1, costo_unitario: 90000 }], idem_key: idem() });
    const cli = (await api.post('/api/clientes', { nombre: 'Cliente cheque' })).body;
    const ch = (await api.post('/api/cheques', { direccion: 'recibido', banco: 'Banco Nación', nro_cheque: '4040', importe: 50000, fecha_emision: hoyAR(-2), fecha_pago: hoyAR(), cliente_id: cli.id, librador: 'Cliente cheque' })).body;
    expect((await api.get('/api/cheques-cartera')).body.map((c: any) => c.id)).toContain(ch.id);
    expect((await api.post('/api/pagos-proveedor', { proveedor_id: p3.id, importe: 40000, medio: 'cheque', referencia: '4040', cheque_id: ch.id, idem_key: idem() })).status).toBe(400); // importe distinto del cheque
    const pago = await api.post('/api/pagos-proveedor', { proveedor_id: p3.id, importe: 50000, medio: 'cheque', referencia: '4040', cheque_id: ch.id, idem_key: idem() });
    expect(pago.status).toBe(201);
    expect((await api.get(`/api/cheques/${ch.id}`)).body).toMatchObject({ estado: 'entregado', proveedor: 'Proveedor Cheque', entrega_pago_id: pago.body.id });
    expect((await cuenta(p3)).saldo).toBe(40000);
    // el mismo cheque no se puede endosar otra vez
    expect((await api.post('/api/pagos-proveedor', { proveedor_id: p3.id, importe: 50000, medio: 'cheque', referencia: '4040', cheque_id: ch.id, idem_key: idem() })).status).toBe(409);
    expect((await api.post(`/api/pagos-proveedor/${pago.body.id}/anular`, { motivo: 'Error de proveedor' })).status).toBe(200);
    expect((await api.get(`/api/cheques/${ch.id}`)).body.estado).toBe('en_cartera');
    expect((await cuenta(p3)).saldo).toBe(90000);
  });

  it('pagar con un cheque propio lo registra como emitido y se anula con el pago', async () => {
    const p4 = (await api.post('/api/proveedores', { nombre: 'Proveedor Cheque Propio' })).body;
    await api.post('/api/compras', { proveedor_id: p4.id, items: [{ articulo_id: a1.id, cantidad: 1, costo_unitario: 30000 }], idem_key: idem() });
    const cu = (await api.post('/api/bancos/cuentas', { nombre: 'Cuenta de cheques', banco: 'Banco Credicoop', saldo_inicial: 100000 })).body;
    expect((await api.post('/api/pagos-proveedor', { proveedor_id: p4.id, importe: 30000, medio: 'cheque', idem_key: idem() })).status).toBe(400); // sin número
    const pago = await api.post('/api/pagos-proveedor', { proveedor_id: p4.id, importe: 30000, medio: 'cheque', referencia: '000321', cheque: { cuenta_id: cu.id, fecha_pago: hoyAR(10) }, idem_key: idem() });
    expect(pago.status).toBe(201);
    const emitidos = (await api.get('/api/cheques?direccion=emitido')).body;
    const ch = emitidos.find((c: any) => c.nro_cheque === '000321');
    expect(ch).toMatchObject({ estado: 'entregado', banco: 'Banco Credicoop', proveedor: 'Proveedor Cheque Propio', origen_tipo: 'pago_proveedor' });
    expect((await cuenta(p4)).saldo).toBe(0);
    // débito del cheque: baja el banco pero no es un egreso nuevo (ya se contó como pago)
    const t0 = (await api.get(`/api/tesoreria/resumen?desde=${hoyAR()}&hasta=${hoyAR()}`)).body;
    expect((await api.post(`/api/cheques/${ch.id}/acreditar`, {})).status).toBe(200);
    const t1 = (await api.get(`/api/tesoreria/resumen?desde=${hoyAR()}&hasta=${hoyAR()}`)).body;
    expect(t1.bancos.total).toBe(t0.bancos.total - 30000);
    expect(t1.periodo.egresos.total).toBe(t0.periodo.egresos.total);
    // acreditado: el pago ya no se puede anular
    expect((await api.post(`/api/pagos-proveedor/${pago.body.id}/anular`, { motivo: 'prueba' })).status).toBe(409);
  });

  it('un pago desde banco desactivado o de otro taller se rechaza, y el medio deshabilitado también', async () => {
    const ajena = (await B.api.post('/api/bancos/cuentas', { nombre: 'Ajena', banco: 'Banco' })).body;
    expect((await api.post('/api/pagos-proveedor', { proveedor_id: prov.id, importe: 100, medio: 'transferencia', cuenta_id: ajena.id, permitir_anticipo: true, idem_key: idem() })).status).toBe(400);
  });
});

describe('reposición → orden de compra', () => {
  it('sugiere reponer hasta el objetivo, genera una orden por proveedor y no vuelve a sugerir lo que ya está pedido', async () => {
    const art = (await api.post('/api/articulos', { nombre: 'Aceite 5W30', costo: 20000, precio: 35000, stock_inicial: 2, stock_minimo: 4, stock_objetivo: 12, proveedor_id: prov.id })).body;
    const sinProv = (await api.post('/api/articulos', { nombre: 'Sin proveedor', costo: 100, stock_inicial: 0, stock_minimo: 2 })).body;
    let rep = (await api.get('/api/reposicion')).body;
    expect(rep.find((x: any) => x.id === art.id)).toMatchObject({ stock: 2, objetivo: 12, sugerido: 10, en_camino: 0 });
    // el artículo sin proveedor no puede ir a una orden
    expect((await api.post('/api/reposicion/ordenes', { items: [{ articulo_id: sinProv.id, cantidad: 2 }], idem_key: idem() })).status).toBe(400);
    const key = idem();
    const costoA1 = (await stockDe(a1)).costo;
    const g = await api.post('/api/reposicion/ordenes', { items: [{ articulo_id: art.id, cantidad: 10 }, { articulo_id: a1.id, cantidad: 8 }], emitir: true, idem_key: key });
    expect(g.status).toBe(201);
    expect(g.body.ordenes).toHaveLength(1); // ambos son del mismo proveedor
    expect((await api.post('/api/reposicion/ordenes', { items: [{ articulo_id: art.id, cantidad: 10 }, { articulo_id: a1.id, cantidad: 8 }], emitir: true, idem_key: key })).body.ordenes[0].duplicado).toBe(true);
    const o = await oc(g.body.ordenes[0].id);
    expect(o).toMatchObject({ estado: 'pendiente', origen: 'reposicion', subtotal: 10 * 20000 + 8 * costoA1, total: 10 * 20000 + 8 * costoA1 });
    expect(o.items).toHaveLength(2);
    rep = (await api.get('/api/reposicion')).body;
    expect(rep.find((x: any) => x.id === art.id)).toMatchObject({ en_camino: 10, sugerido: 0 });
    // al recibir la orden, el stock sube y desaparece de la reposición
    await api.post(`/api/ordenes-compra/${o.id}/recepciones`, { items: o.items.map((i: any) => ({ orden_item_id: i.id, cantidad: i.cantidad })), idem_key: idem() });
    rep = (await api.get('/api/reposicion')).body;
    expect(rep.find((x: any) => x.id === art.id)).toBeUndefined();
    expect((await stockDe(art)).stock).toBe(12);
  });
});

describe('inventario avanzado', () => {
  it('valoriza el inventario por categoría con cantidades decimales exactas y registra el historial de costos', async () => {
    const cat = (await api.post('/api/categorias-articulo', { nombre: 'Lubricantes' })).body;
    const lt = (await api.post('/api/articulos', { nombre: 'Aceite a granel', categoria_id: cat.id, unidad: 'lt', costo: 1999, precio: 3000, stock_inicial: 0.3 })).body;
    await api.post('/api/stock/movimientos', { articulo_id: lt.id, tipo: 'entrada', cantidad: 0.1, idem_key: idem() });
    await api.post('/api/stock/movimientos', { articulo_id: lt.id, tipo: 'salida', motivo: 'merma', cantidad: 0.2, idem_key: idem() });
    expect((await stockDe(lt)).stock).toBe(0.2);
    const v = (await api.get(`/api/inventario/valorizado?categoria_id=${cat.id}`)).body;
    expect(v.items).toHaveLength(1);
    expect(v.items[0]).toMatchObject({ stock: 0.2, valor_costo: Math.round(0.2 * 1999), valor_venta: 600 });
    expect(v.totales).toMatchObject({ articulos: 1, valor_costo: 400, valor_venta: 600, margen_potencial: 200 });
    const todo = (await api.get('/api/inventario/valorizado')).body;
    expect(todo.por_categoria.find((c: any) => c.categoria === 'Lubricantes')).toMatchObject({ articulos: 1, unidades: 0.2 });
    expect((await emp.get('/api/inventario/valorizado')).status).toBe(403);
    // historial de costos: alta, edición y compra quedan registrados
    await api.put(`/api/articulos/${lt.id}`, { costo: 2200 });
    await api.post('/api/compras', { proveedor_id: prov.id, items: [{ articulo_id: lt.id, cantidad: 1, costo_unitario: 2500 }], idem_key: idem() });
    const h = (await api.get(`/api/inventario/costos/${lt.id}`)).body.historial;
    expect(h.map((x: any) => x.costo_nuevo)).toEqual([2500, 2200, 1999]);
    expect(h[0]).toMatchObject({ costo_anterior: 2200 });
    expect(h[0].origen).toMatch(/^compra:/);
  });

  it('los ajustes exigen motivo y quedan trazados', async () => {
    expect((await api.post('/api/stock/movimientos', { articulo_id: a2.id, tipo: 'ajuste', cantidad: 5, idem_key: idem() })).status).toBe(400);
    expect((await api.post('/api/stock/movimientos', { articulo_id: a2.id, tipo: 'salida', cantidad: 1, motivo: 'otro', idem_key: idem() })).status).toBe(400); // "otro" pide explicación
    const r = await api.post('/api/stock/movimientos', { articulo_id: a2.id, tipo: 'salida', cantidad: 1, motivo: 'rotura', notas: 'Se cayó del estante', idem_key: idem() });
    expect(r.status).toBe(201);
    const m = (await api.get(`/api/stock/movimientos?articulo_id=${a2.id}&tipo=salida`)).body;
    expect(m[0]).toMatchObject({ motivo: 'rotura', cantidad: -1 });
  });

  it('conteo físico: foto del stock, diferencias valorizadas, ajuste auditado y sin pisar movimientos intermedios', async () => {
    const c1 = (await api.post('/api/articulos', { nombre: 'Conteo A', costo: 1000, stock_inicial: 10 })).body;
    const c2 = (await api.post('/api/articulos', { nombre: 'Conteo B', costo: 500, stock_inicial: 4 })).body;
    const cat = (await api.post('/api/categorias-articulo', { nombre: 'Para contar' })).body;
    await api.put(`/api/articulos/${c1.id}`, { categoria_id: cat.id });
    await api.put(`/api/articulos/${c2.id}`, { categoria_id: cat.id });
    expect((await emp.post('/api/inventario/conteos', { categoria_id: cat.id })).status).toBe(403);
    const cn = (await api.post('/api/inventario/conteos', { categoria_id: cat.id, descripcion: 'Estantería 1' })).body;
    expect(cn).toMatchObject({ estado: 'abierto', articulos: 2, contados: 0 });
    expect((await api.post('/api/inventario/conteos', { categoria_id: cat.id })).status).toBe(409); // ya hay uno abierto
    // mientras se cuenta, se vende una unidad (el conteo no debe pisarla)
    await api.post('/api/stock/movimientos', { articulo_id: c1.id, tipo: 'salida', cantidad: 1, motivo: 'uso_interno', idem_key: idem() });
    await api.put(`/api/inventario/conteos/${cn.id}/items`, { items: [{ articulo_id: c1.id, contado: 8 }, { articulo_id: c2.id, contado: 4 }] });
    const det = (await api.get(`/api/inventario/conteos/${cn.id}`)).body;
    expect(det.items.find((i: any) => i.articulo_id === c1.id)).toMatchObject({ stock_sistema: 10, contado: 8, diferencia: -2, valor_diferencia: -2000, stock_actual: 9 });
    expect(det.valor_diferencia_total).toBe(-2000);
    const ap = await api.post(`/api/inventario/conteos/${cn.id}/aplicar`, {});
    expect(ap.status).toBe(200);
    expect(ap.body.ajustes).toBe(1); // sólo el que tiene diferencia
    expect((await stockDe(c1)).stock).toBe(7); // 9 reales − 2 de diferencia (se conserva la salida intermedia)
    expect((await stockDe(c2)).stock).toBe(4);
    const mv = (await api.get(`/api/stock/movimientos?articulo_id=${c1.id}&tipo=ajuste`)).body;
    expect(mv).toHaveLength(1);
    expect(mv[0]).toMatchObject({ motivo: 'conteo', origen_tipo: 'conteo', origen_id: cn.id, cantidad: -2 });
    expect((await api.post(`/api/inventario/conteos/${cn.id}/aplicar`, {})).status).toBe(409); // no se aplica dos veces
    expect((await stockDe(c1)).stock).toBe(7);
  });
});

describe('aislamiento entre talleres (compras avanzadas e inventario)', () => {
  it('otro taller no ve ni opera órdenes, recepciones, facturas, conteos ni valorización ajenas', async () => {
    expect((await B.api.get('/api/ordenes-compra')).body).toEqual([]);
    expect((await B.api.get(`/api/ordenes-compra/${ctx.oc.id}`)).status).toBe(404);
    expect((await B.api.post(`/api/ordenes-compra/${ctx.oc.id}/cancelar`, { motivo: 'intruso' })).status).toBe(404);
    expect((await B.api.get(`/api/recepciones/${ctx.rec1.id}`)).status).toBe(404);
    expect((await B.api.post(`/api/recepciones/${ctx.rec1.id}/anular`, { motivo: 'intruso' })).status).toBe(404);
    expect((await B.api.get('/api/facturas-proveedor')).body).toEqual([]);
    expect((await B.api.post(`/api/facturas-proveedor/${ctx.factura.id}/anular`, { motivo: 'intruso' })).status).toBe(404);
    expect((await B.api.get('/api/deuda-proveedores')).body).toEqual([]);
    expect((await B.api.post('/api/ordenes-compra', { proveedor_id: prov.id, items: [{ articulo_id: a1.id, cantidad: 1, costo_unitario: 1 }], idem_key: idem() })).status).toBe(400);
    expect((await B.api.post('/api/reposicion/ordenes', { items: [{ articulo_id: a1.id, cantidad: 1 }], idem_key: idem() })).status).toBe(400);
    expect((await B.api.get('/api/inventario/valorizado')).body.items).toEqual([]);
    expect((await B.api.get('/api/inventario/conteos')).body).toEqual([]);
    expect((await B.api.get(`/api/inventario/costos/${a1.id}`)).status).toBe(404);
  });
});
