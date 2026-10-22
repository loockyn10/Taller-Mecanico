// Sprint 08: depósitos, transferencias, stock por depósito en cada circuito, código de barras, costo histórico y cuentas corrientes consistentes.
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, hoyAR, idem, nuevoPersonal, nuevoTaller } from './cliente';

let T: Awaited<ReturnType<typeof nuevoTaller>>;
let OTRO: Awaited<ReturnType<typeof nuevoTaller>>;
let api: Api;
const d: Record<string, any> = {};

const stockEn = async (articulo: any, deposito: any) => {
  const a = (await api.get(`/api/articulos/${articulo.id}`)).body;
  return a.depositos.find((x: any) => x.id === deposito.id)?.stock ?? 0;
};
const total = async (articulo: any) => (await api.get(`/api/articulos/${articulo.id}`)).body.stock;
const consistente = async () => {
  const v = (await api.get('/api/inventario/verificar')).body;
  expect(v.diferencias).toEqual([]);
  expect(v.ok).toBe(true);
};

beforeAll(async () => {
  T = await nuevoTaller('Taller Depósitos', 12);
  OTRO = await nuevoTaller('Otro Taller Depósitos', 2);
  api = T.api;
  d.recepcion = await nuevoPersonal(api, 'recepcion');
  d.mecanico = await nuevoPersonal(api, 'mecanico');
  d.deposito = await nuevoPersonal(api, 'deposito');
  d.cliente = (await api.post('/api/clientes', { nombre: 'Cliente Depósitos', telefono: '1111' })).body;
  d.vehiculo = (await api.post('/api/vehiculos', { cliente_id: d.cliente.id, patente: 'DEP123' })).body;
  d.prov = (await api.post('/api/proveedores', { nombre: 'Proveedor Depósitos', cuit: '30-71234567-1' })).body;
  d.filtro = (await api.post('/api/articulos', { nombre: 'Filtro Dep', codigo: 'FD-1', codigo_barras: '7791234567890', costo: 10000, precio: 20000, stock_inicial: 10, stock_minimo: 2 })).body;
  d.aceite = (await api.post('/api/articulos', { nombre: 'Aceite Dep', codigo: 'AD-1', costo: 30000, precio: 55000, stock_inicial: 20 })).body;
  d.principal = (await api.get('/api/depositos')).body.find((x: any) => x.es_principal);
});

describe('depósitos del taller', () => {
  it('cada taller nace con su depósito principal, con todo el stock inicial', async () => {
    const deps = (await api.get('/api/depositos')).body;
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ nombre: 'Depósito principal', es_principal: 1, activo: 1, articulos_con_stock: 2, unidades: 30 });
    const otro = (await OTRO.api.get('/api/depositos')).body;
    expect(otro).toHaveLength(1);
    expect(otro[0].id).not.toBe(d.principal.id);
    await consistente();
  });

  it('crea depósitos adicionales sin repetir nombres ni tocar el principal', async () => {
    const r = await api.post('/api/depositos', { nombre: 'Mostrador', notas: 'Repuestos de venta rápida' });
    expect(r.status).toBe(201);
    d.mostrador = { id: r.body.id };
    expect((await api.post('/api/depositos', { nombre: 'mostrador' })).status).toBe(409);
    expect((await api.put(`/api/depositos/${d.principal.id}`, { activo: false })).status).toBe(409);
    expect((await api.put(`/api/depositos/${d.mostrador.id}`, { nombre: 'Mostrador 1' })).status).toBe(200);
    // otro taller no ve ni modifica los depósitos ajenos
    expect((await OTRO.api.get('/api/depositos')).body.some((x: any) => x.id === d.mostrador.id)).toBe(false);
    expect((await OTRO.api.put(`/api/depositos/${d.mostrador.id}`, { nombre: 'Robado' })).status).toBe(404);
    expect((await OTRO.api.get(`/api/depositos/${d.mostrador.id}/stock`)).status).toBe(404);
  });

  it('el costo y el valor del inventario por depósito solo los ve quien puede valorizar', async () => {
    const dep = (await d.deposito.api.get('/api/depositos')).body;
    expect(dep[0].valor_costo).toBeUndefined(); // depósito: ve costos pero no valoriza el inventario
    const adm = (await api.get('/api/depositos')).body;
    expect(adm[0].valor_costo).toBe(10 * 10000 + 20 * 30000);
    expect((await d.mecanico.api.get('/api/depositos')).status).toBe(403);
    const rec = await d.recepcion.api.get('/api/depositos');
    expect(rec.status).toBe(200);
    expect((await d.recepcion.api.post('/api/depositos', { nombre: 'No permitido' })).status).toBe(403);
  });
});

describe('transferencias internas', () => {
  it('mueven stock entre depósitos sin cambiar el total, con usuario e historial', async () => {
    const key = idem();
    const body = { origen_id: d.principal.id, destino_id: d.mostrador.id, notas: 'Reposición de mostrador', items: [{ articulo_id: d.filtro.id, cantidad: 4 }, { articulo_id: d.aceite.id, cantidad: 5 }], idem_key: key };
    const r = await api.post('/api/transferencias', body);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ origen: 'Depósito principal', destino: 'Mostrador 1', estado: 'registrada', lineas: 2 });
    d.transf = r.body;
    expect((await api.post('/api/transferencias', body)).body.duplicado).toBe(true); // reintento: no se mueve dos veces
    expect(await stockEn(d.filtro, d.principal)).toBe(6);
    expect(await stockEn(d.filtro, d.mostrador)).toBe(4);
    expect(await total(d.filtro)).toBe(10);
    expect(await total(d.aceite)).toBe(20);
    const movs = (await api.get(`/api/stock/movimientos?articulo_id=${d.filtro.id}`)).body.filter((m: any) => m.origen_tipo === 'transferencia');
    expect(movs).toHaveLength(2);
    expect(movs.map((m: any) => m.deposito).sort()).toEqual(['Depósito principal', 'Mostrador 1']);
    expect(movs.every((m: any) => m.usuario)).toBe(true);
    const det = (await api.get(`/api/transferencias/${d.transf.id}`)).body;
    expect(det.items).toHaveLength(2);
    expect((await api.get(`/api/transferencias?deposito_id=${d.mostrador.id}`)).body).toHaveLength(1);
    await consistente();
  });

  it('rechaza transferencias inválidas: mismo depósito, sin stock, repetidos o de otro taller', async () => {
    const base = { origen_id: d.principal.id, destino_id: d.mostrador.id, idem_key: idem() };
    expect((await api.post('/api/transferencias', { ...base, destino_id: d.principal.id, items: [{ articulo_id: d.filtro.id, cantidad: 1 }] })).status).toBe(400);
    expect((await api.post('/api/transferencias', { ...base, idem_key: idem(), items: [{ articulo_id: d.filtro.id, cantidad: 7 }] })).status).toBe(409); // en el principal quedan 6
    expect((await api.post('/api/transferencias', { ...base, idem_key: idem(), items: [{ articulo_id: d.filtro.id, cantidad: 1 }, { articulo_id: d.filtro.id, cantidad: 1 }] })).status).toBe(400);
    expect((await api.post('/api/transferencias', { ...base, idem_key: idem(), destino_id: 'inexistente', items: [{ articulo_id: d.filtro.id, cantidad: 1 }] })).status).toBe(400);
    expect((await OTRO.api.post('/api/transferencias', { ...base, idem_key: idem(), items: [{ articulo_id: d.filtro.id, cantidad: 1 }] })).status).toBe(400);
    expect((await d.recepcion.api.post('/api/transferencias', { ...base, idem_key: idem(), items: [{ articulo_id: d.filtro.id, cantidad: 1 }] })).status).toBe(403);
    expect((await OTRO.api.get(`/api/transferencias/${d.transf.id}`)).status).toBe(404);
    await consistente();
  });

  it('la transferencia anulada devuelve la mercadería al origen y solo si el destino todavía la tiene', async () => {
    const t2 = (await api.post('/api/transferencias', { origen_id: d.principal.id, destino_id: d.mostrador.id, items: [{ articulo_id: d.filtro.id, cantidad: 2 }], idem_key: idem() })).body;
    expect(await stockEn(d.filtro, d.mostrador)).toBe(6);
    expect((await api.post(`/api/transferencias/${t2.id}/anular`, { motivo: 'Error de carga' })).status).toBe(200);
    expect(await stockEn(d.filtro, d.mostrador)).toBe(4);
    expect(await stockEn(d.filtro, d.principal)).toBe(6);
    expect((await api.post(`/api/transferencias/${t2.id}/anular`, { motivo: 'Otra vez' })).status).toBe(409);
    // si el destino ya no la tiene, no se puede anular
    const t3 = (await api.post('/api/transferencias', { origen_id: d.principal.id, destino_id: d.mostrador.id, items: [{ articulo_id: d.aceite.id, cantidad: 10 }], idem_key: idem() })).body;
    await api.post('/api/stock/movimientos', { articulo_id: d.aceite.id, tipo: 'salida', cantidad: 12, motivo: 'uso_interno', deposito_id: d.mostrador.id, idem_key: idem() });
    expect((await api.post(`/api/transferencias/${t3.id}/anular`, { motivo: 'Prueba' })).status).toBe(409);
    expect(await stockEn(d.aceite, d.mostrador)).toBe(3);
    await consistente();
  });
});

describe('cada circuito mueve el depósito indicado', () => {
  it('venta de mostrador: sale del depósito elegido y la anulación vuelve al mismo', async () => {
    const venta = (items: number, key = idem(), extra: any = {}) =>
      api.post('/api/ventas', { cliente_id: d.cliente.id, condicion: 'cuenta_corriente', idem_key: key, items: [{ tipo: 'articulo', articulo_id: d.filtro.id, descripcion: 'Filtro Dep', cantidad: items, precio_unitario: 20000 }], ...extra });
    const v = await venta(3, idem(), { deposito_id: d.mostrador.id });
    expect(v.status).toBe(201);
    expect(await stockEn(d.filtro, d.mostrador)).toBe(1);
    expect(await stockEn(d.filtro, d.principal)).toBe(6);
    // en el mostrador queda 1: no alcanza para 2 aunque el taller tenga 7 en total
    const sinStock = await venta(2, idem(), { deposito_id: d.mostrador.id });
    expect(sinStock.status).toBe(409);
    expect(sinStock.body.error.message).toMatch(/Stock insuficiente/);
    // sin indicar depósito sale del principal
    const v2 = await venta(1);
    expect(v2.status).toBe(201);
    expect(await stockEn(d.filtro, d.principal)).toBe(5);
    expect((await api.post(`/api/ventas/${v.body.id}/anular`, { motivo: 'Cliente se arrepintió' })).status).toBe(200);
    expect(await stockEn(d.filtro, d.mostrador)).toBe(4);
    expect((await api.post(`/api/ventas/${v2.body.id}/anular`, { motivo: 'Error' })).status).toBe(200);
    expect(await stockEn(d.filtro, d.principal)).toBe(6);
    expect(await total(d.filtro)).toBe(10);
    // un depósito desactivado o ajeno no se puede usar
    expect((await venta(1, idem(), { deposito_id: 'inexistente' })).status).toBe(400);
    await consistente();
  });

  it('OT: los repuestos se descuentan UNA vez al quedar lista, del depósito de la orden, y vuelven al reabrirla', async () => {
    const ot = (await api.post('/api/ordenes', {
      cliente_id: d.cliente.id, vehiculo_id: d.vehiculo.id, deposito_id: d.mostrador.id,
      items: [{ tipo: 'articulo', articulo_id: d.filtro.id, descripcion: 'Filtro Dep', cantidad: 2, precio_unitario: 20000 }, { tipo: 'libre', descripcion: 'Mano de obra', cantidad: 1, precio_unitario: 30000 }],
    })).body;
    d.ot = ot;
    expect((await api.get(`/api/ordenes/${ot.id}`)).body.deposito).toBe('Mostrador 1');
    expect(await stockEn(d.filtro, d.mostrador)).toBe(4); // nada se descontó todavía
    const rs = await Promise.all([1, 2, 3].map(() => api.post(`/api/ordenes/${ot.id}/estado`, { estado: 'lista' })));
    expect(rs.filter((r) => r.status === 200 && r.body.stock === 'descontado')).toHaveLength(1); // una sola vez aun con solicitudes simultáneas
    expect(await stockEn(d.filtro, d.mostrador)).toBe(2);
    expect(await stockEn(d.filtro, d.principal)).toBe(6);
    // con el stock descontado no se cambia de depósito
    expect((await api.patch(`/api/ordenes/${ot.id}/deposito`, { deposito_id: d.principal.id })).status).toBe(409);
    expect((await api.post(`/api/ordenes/${ot.id}/estado`, { estado: 'en_reparacion' })).body.stock).toBe('repuesto');
    expect(await stockEn(d.filtro, d.mostrador)).toBe(4);
    // ahora sí se puede cambiar: sale del principal
    expect((await api.patch(`/api/ordenes/${ot.id}/deposito`, { deposito_id: d.principal.id })).status).toBe(200);
    expect((await d.mecanico.api.patch(`/api/ordenes/${ot.id}/deposito`, { deposito_id: null })).status).toBe(403);
    expect((await api.post(`/api/ordenes/${ot.id}/estado`, { estado: 'lista' })).body.stock).toBe('descontado');
    expect(await stockEn(d.filtro, d.principal)).toBe(4);
    expect(await stockEn(d.filtro, d.mostrador)).toBe(4);
    // el comprobante de la OT no vuelve a descontar
    const comp = await api.post(`/api/ordenes/${ot.id}/comprobante`, { condicion: 'cuenta_corriente' });
    expect(comp.status).toBe(201);
    expect(await total(d.filtro)).toBe(8);
    await consistente();
  });

  it('compra y recepción ingresan al depósito elegido; anular exige que la mercadería siga ahí', async () => {
    const compra = await api.post('/api/compras', { proveedor_id: d.prov.id, deposito_id: d.mostrador.id, numero_doc: '0001-00000001', items: [{ articulo_id: d.aceite.id, cantidad: 6, costo_unitario: 31000 }], idem_key: idem() });
    expect(compra.status).toBe(201);
    expect(await stockEn(d.aceite, d.mostrador)).toBe(9);
    // el aceite del mostrador se transfiere: la compra ya no se puede anular
    expect((await api.post('/api/transferencias', { origen_id: d.mostrador.id, destino_id: d.principal.id, items: [{ articulo_id: d.aceite.id, cantidad: 8 }], idem_key: idem() })).status).toBe(201);
    expect((await api.post(`/api/compras/${compra.body.id}/anular`, {})).status).toBe(409);
    // recepción de una orden de compra, parcial, en el principal
    const oc = (await api.post('/api/ordenes-compra', { proveedor_id: d.prov.id, items: [{ articulo_id: d.filtro.id, cantidad: 10, costo_unitario: 12000 }], emitir: true, idem_key: idem() })).body;
    const linea = (await api.get(`/api/ordenes-compra/${oc.id}`)).body.items[0];
    const rec = await api.post(`/api/ordenes-compra/${oc.id}/recepciones`, { deposito_id: d.mostrador.id, remito: '0001-0000777', items: [{ orden_item_id: linea.id, cantidad: 4 }], idem_key: idem() });
    expect(rec.status).toBe(201);
    expect(await stockEn(d.filtro, d.mostrador)).toBe(8);
    const detalle = (await api.get(`/api/recepciones/${rec.body.id}`)).body;
    expect(detalle).toMatchObject({ deposito: 'Mostrador 1', remito: '0001-0000777', proveedor_cuit: '30-71234567-1' });
    expect(detalle.usuario).toBeTruthy();
    expect((await api.get(`/api/ordenes-compra/${oc.id}`)).body).toMatchObject({ estado: 'parcial', unidades_recibidas: 4 });
    expect((await api.post(`/api/recepciones/${rec.body.id}/anular`, { motivo: 'Remito equivocado' })).status).toBe(200);
    expect(await stockEn(d.filtro, d.mostrador)).toBe(4);
    expect((await api.get(`/api/ordenes-compra/${oc.id}`)).body.estado).toBe('pendiente');
    await consistente();
  });

  it('movimientos manuales y conteos físicos operan sobre un depósito', async () => {
    const stockMostrador = await stockEn(d.filtro, d.mostrador);
    // salida mayor que lo que hay en ese depósito (aunque el taller lo tenga en total)
    const r = await api.post('/api/stock/movimientos', { articulo_id: d.filtro.id, tipo: 'salida', cantidad: stockMostrador + 1, motivo: 'rotura', deposito_id: d.mostrador.id, idem_key: idem() });
    expect(r.status).toBe(409);
    // ajuste: el stock contado es el del depósito
    const aj = await api.post('/api/stock/movimientos', { articulo_id: d.filtro.id, tipo: 'ajuste', cantidad: 3, motivo: 'conteo', deposito_id: d.mostrador.id, idem_key: idem() });
    expect(aj.status).toBe(201);
    expect(await stockEn(d.filtro, d.mostrador)).toBe(3);
    // conteo del mostrador
    const antes = await total(d.filtro);
    const conteo = (await api.post('/api/inventario/conteos', { deposito_id: d.mostrador.id, solo_con_stock: true })).body;
    expect(conteo.deposito).toBe('Mostrador 1');
    const det = (await api.get(`/api/inventario/conteos/${conteo.id}`)).body;
    const fila = det.items.find((i: any) => i.articulo_id === d.filtro.id);
    expect(fila.stock_sistema).toBe(3);
    await api.put(`/api/inventario/conteos/${conteo.id}/items`, { items: det.items.map((i: any) => ({ articulo_id: i.articulo_id, contado: i.articulo_id === d.filtro.id ? 2 : i.stock_sistema })) });
    expect((await api.post(`/api/inventario/conteos/${conteo.id}/aplicar`, {})).status).toBe(200);
    expect(await stockEn(d.filtro, d.mostrador)).toBe(2);
    expect(await total(d.filtro)).toBe(antes - 1);
    // dos conteos abiertos del mismo depósito no conviven; en otro depósito sí
    expect((await api.post('/api/inventario/conteos', { deposito_id: d.mostrador.id })).status).toBe(201);
    expect((await api.post('/api/inventario/conteos', { deposito_id: d.mostrador.id })).status).toBe(409);
    expect((await api.post('/api/inventario/conteos', {})).status).toBe(201);
    await consistente();
  });

  it('un depósito con mercadería no se desactiva; vacío sí, y deja de ofrecerse', async () => {
    expect((await api.put(`/api/depositos/${d.mostrador.id}`, { activo: false })).status).toBe(409);
    const art = (await api.get('/api/depositos/' + d.mostrador.id + '/stock')).body.items;
    expect(art.length).toBeGreaterThan(0);
    await api.post('/api/transferencias', { origen_id: d.mostrador.id, destino_id: d.principal.id, items: art.map((a: any) => ({ articulo_id: a.articulo_id, cantidad: a.stock })), idem_key: idem() });
    expect((await api.put(`/api/depositos/${d.mostrador.id}`, { activo: false })).status).toBe(200);
    const v = await api.post('/api/ventas', { cliente_id: d.cliente.id, condicion: 'cuenta_corriente', deposito_id: d.mostrador.id, idem_key: idem(), items: [{ tipo: 'libre', descripcion: 'x', cantidad: 1, precio_unitario: 100 }] });
    expect(v.status).toBe(400);
    await consistente();
  });
});

describe('código de barras', () => {
  it('se busca por coincidencia exacta con lectores USB (código de barras o código interno)', async () => {
    const porBarras = (await api.get('/api/articulos/lector/7791234567890')).body;
    expect(porBarras).toMatchObject({ id: d.filtro.id, nombre: 'Filtro Dep', codigo_barras: '7791234567890' });
    expect((await api.get('/api/articulos/lector/FD-1')).body.id).toBe(d.filtro.id);
    expect((await api.get('/api/articulos/lector/0000')).status).toBe(404);
    expect((await api.get('/api/articulos?q=7791234567890')).body.map((a: any) => a.id)).toContain(d.filtro.id);
    // un código de barras no se repite en el taller; sí puede repetirse en otro taller
    expect((await api.post('/api/articulos', { nombre: 'Otro', codigo_barras: '7791234567890' })).status).toBe(409);
    expect((await OTRO.api.post('/api/articulos', { nombre: 'Filtro de otro taller', codigo_barras: '7791234567890' })).status).toBe(201);
    expect((await OTRO.api.get('/api/articulos/lector/7791234567890')).body.nombre).toBe('Filtro de otro taller');
    // el mecánico no consulta el catálogo; sin permiso de precios el lector no devuelve precios ni costos
    expect((await d.mecanico.api.get('/api/articulos/lector/7791234567890')).status).toBe(403);
    const sinPrecios = await nuevoPersonal(api, 'deposito');
    await api.put(`/api/taller/usuarios/${sinPrecios.id}/permisos`, { permisos: ['catalogo.ver', 'asistencia.fichar'] });
    const a = (await sinPrecios.api.get('/api/articulos/lector/7791234567890')).body;
    expect(a.nombre).toBe('Filtro Dep');
    expect(a.costo).toBeUndefined();
    expect(a.precio).toBeUndefined();
    // se puede editar o quitar
    expect((await api.put(`/api/articulos/${d.filtro.id}`, { codigo_barras: '' })).status).toBe(200);
    expect((await api.get('/api/articulos/lector/7791234567890')).status).toBe(404);
    expect((await api.put(`/api/articulos/${d.filtro.id}`, { codigo_barras: '7791234567890' })).status).toBe(200);
  });
});

describe('costo histórico y rentabilidad', () => {
  it('el costo con el que se vendió no cambia cuando el costo del artículo se actualiza', async () => {
    const art = (await api.post('/api/articulos', { nombre: 'Bujía Histórica', costo: 4000, precio: 10000, stock_inicial: 20 })).body;
    const v = (await api.post('/api/ventas', { cliente_id: d.cliente.id, condicion: 'cuenta_corriente', idem_key: idem(), items: [{ tipo: 'articulo', articulo_id: art.id, descripcion: 'Bujía Histórica', cantidad: 5, precio_unitario: 10000 }] })).body;
    await api.put(`/api/articulos/${art.id}`, { costo: 9000 }); // el costo sube después de vender
    const informe = async () => (await api.get(`/api/informes/rentabilidad?desde=${hoyAR()}&hasta=${hoyAR()}&q=Bujía Histórica`)).body.filas.find((f: any) => f.articulo === 'Bujía Histórica');
    expect(await informe()).toMatchObject({ cantidad: 5, total: 50000, costo: 20000, margen: 30000 });
    // la venta nueva usa el costo nuevo
    await api.post('/api/ventas', { cliente_id: d.cliente.id, condicion: 'cuenta_corriente', idem_key: idem(), items: [{ tipo: 'articulo', articulo_id: art.id, descripcion: 'Bujía Histórica', cantidad: 1, precio_unitario: 10000 }] });
    expect(await informe()).toMatchObject({ cantidad: 6, total: 60000, costo: 29000 });
    // el costo del comprobante es un dato de costo: quien no lo ve no lo recupera
    const detalle = (await api.get(`/api/ventas/${v.id}`)).body;
    expect(detalle.items[0].costo_unitario).toBe(4000);
    expect(detalle.items[0].precio_unitario).toBe(10000); // los precios históricos no cambian
    expect((await d.recepcion.api.get(`/api/ventas/${v.id}`)).body.items[0].costo_unitario).toBeUndefined();
  });

  it('rentabilidad de la OT: costo real de los repuestos al descontarlos, estimado antes; requiere permiso de márgenes', async () => {
    const art = (await api.post('/api/articulos', { nombre: 'Correa OT', costo: 5000, precio: 12000, stock_inicial: 10 })).body;
    const ot = (await api.post('/api/ordenes', {
      cliente_id: d.cliente.id, vehiculo_id: d.vehiculo.id,
      items: [{ tipo: 'articulo', articulo_id: art.id, descripcion: 'Correa OT', cantidad: 2, precio_unitario: 12000 }, { tipo: 'libre', descripcion: 'Colocación', cantidad: 1, precio_unitario: 18000 }],
    })).body;
    const r0 = (await api.get(`/api/ordenes/${ot.id}/rentabilidad`)).body;
    expect(r0).toMatchObject({ costo_estimado: true, totales_repuestos: { venta: 24000, costo: 10000, margen: 14000 }, mano_obra: { venta: 18000 } });
    await api.post(`/api/ordenes/${ot.id}/estado`, { estado: 'lista' });
    await api.put(`/api/articulos/${art.id}`, { costo: 8000 }); // el costo sube después de consumir
    const r1 = (await api.get(`/api/ordenes/${ot.id}/rentabilidad`)).body;
    expect(r1).toMatchObject({ costo_estimado: false, totales_repuestos: { venta: 24000, costo: 10000, margen: 14000 } });
    // el comprobante emitido después conserva el costo del consumo, no el nuevo
    const comp = (await api.post(`/api/ordenes/${ot.id}/comprobante`, { condicion: 'cuenta_corriente' })).body;
    expect((await api.get(`/api/ventas/${comp.id}`)).body.items.find((i: any) => i.tipo === 'articulo').costo_unitario).toBe(5000);
    expect((await d.recepcion.api.get(`/api/ordenes/${ot.id}/rentabilidad`)).status).toBe(403);
    expect((await d.mecanico.api.get(`/api/ordenes/${ot.id}/rentabilidad`)).status).toBe(403);
    expect((await OTRO.api.get(`/api/ordenes/${ot.id}/rentabilidad`)).status).toBe(404);
  });
});

describe('cuentas corrientes y circuitos consistentes', () => {
  it('compra → recepción → factura → pago deja el stock, la cuenta del proveedor y la caja cuadrados', async () => {
    const art = (await api.post('/api/articulos', { nombre: 'Pastilla Circuito', costo: 20000, precio: 40000, stock_inicial: 0 })).body;
    const oc = (await api.post('/api/ordenes-compra', { proveedor_id: d.prov.id, iva_pct: 21, emitir: true, items: [{ articulo_id: art.id, cantidad: 10, costo_unitario: 20000 }], idem_key: idem() })).body;
    const linea = (await api.get(`/api/ordenes-compra/${oc.id}`)).body.items[0];
    await api.post(`/api/ordenes-compra/${oc.id}/recepciones`, { items: [{ orden_item_id: linea.id, cantidad: 6 }], idem_key: idem() });
    expect(await total(art)).toBe(6);
    await api.post(`/api/ordenes-compra/${oc.id}/recepciones`, { items: [{ orden_item_id: linea.id, cantidad: 4 }], idem_key: idem() });
    expect((await api.get(`/api/ordenes-compra/${oc.id}`)).body).toMatchObject({ estado: 'recibida', unidades_recibidas: 10 });
    expect(await total(art)).toBe(10);
    // la deuda nace con la factura, una sola vez
    const saldoAntes = (await api.get(`/api/proveedores/${d.prov.id}/cuenta`)).body.saldo;
    const fecha = hoyAR();
    const fac = await api.post('/api/facturas-proveedor', { proveedor_id: d.prov.id, orden_compra_id: oc.id, tipo: 'factura_a', nro_comprobante: '0001-00004321', fecha, neto_gravado: 200000, iva_21: 42000, total: 242000, idem_key: idem() });
    expect(fac.status).toBe(201);
    const cta = (await api.get(`/api/proveedores/${d.prov.id}/cuenta`)).body;
    expect(cta.saldo - saldoAntes).toBe(242000);
    // pago parcial en efectivo: baja la cuenta, sale de la caja y tiene su orden de pago
    const pago = await api.post('/api/pagos-proveedor', { proveedor_id: d.prov.id, importe: 100000, medio: 'efectivo', fecha, idem_key: idem() });
    expect(pago.status).toBe(201);
    const op = (await api.get(`/api/pagos-proveedor/${pago.body.id}`)).body;
    expect(op).toMatchObject({ importe: 100000, medio: 'efectivo', proveedor: 'Proveedor Depósitos', estado: 'registrado' });
    expect(op.usuario).toBeTruthy();
    expect((await api.get(`/api/proveedores/${d.prov.id}/cuenta`)).body.saldo).toBe(cta.saldo - 100000);
    // estado de cuenta con saldo anterior: arranca en lo que se arrastraba antes de la fecha
    const futura = hoyAR(1);
    const conDesde = (await api.get(`/api/proveedores/${d.prov.id}/cuenta?desde=${futura}`)).body;
    expect(conDesde.movimientos).toEqual([]);
    expect(conDesde.saldo_anterior).toBe(cta.saldo - 100000);
    const desdeHoy = (await api.get(`/api/proveedores/${d.prov.id}/cuenta?desde=${fecha}`)).body;
    expect(desdeHoy.saldo_anterior + desdeHoy.movimientos.reduce((a: number, m: any) => (m.anulado ? a : a + m.haber - m.debe), 0)).toBe(desdeHoy.saldo);
    // anular el pago devuelve el saldo y el movimiento queda marcado; reintentar no duplica
    expect((await api.post(`/api/pagos-proveedor/${pago.body.id}/anular`, { motivo: 'Pago duplicado' })).status).toBe(200);
    expect((await api.post(`/api/pagos-proveedor/${pago.body.id}/anular`, { motivo: 'Otra vez' })).status).toBe(409);
    expect((await api.get(`/api/proveedores/${d.prov.id}/cuenta`)).body.saldo).toBe(cta.saldo);
    await consistente();
  });

  it('presupuesto → OT → repuestos → comprobante → cobros parciales → anulación deja cuentas y caja cuadradas', async () => {
    const art = (await api.post('/api/articulos', { nombre: 'Amortiguador Circuito', costo: 30000, precio: 60000, stock_inicial: 8 })).body;
    const cliente = (await api.post('/api/clientes', { nombre: 'Cliente Circuito', telefono: '2222' })).body;
    const veh = (await api.post('/api/vehiculos', { cliente_id: cliente.id, patente: 'CIR123' })).body;
    const items = [{ tipo: 'articulo', articulo_id: art.id, descripcion: 'Amortiguador Circuito', cantidad: 2, precio_unitario: 60000 }, { tipo: 'libre', descripcion: 'Mano de obra', cantidad: 1, precio_unitario: 40000 }];
    const p = (await api.post('/api/presupuestos', { cliente_id: cliente.id, vehiculo_id: veh.id, items })).body;
    await api.post(`/api/presupuestos/${p.id}/estado`, { estado: 'aprobado' });
    const ot = (await api.post(`/api/presupuestos/${p.id}/convertir`, {})).body;
    expect(await total(art)).toBe(8); // convertir no toca el stock
    expect((await api.post(`/api/ordenes/${ot.id}/estado`, { estado: 'lista' })).body.stock).toBe('descontado');
    expect(await total(art)).toBe(6);
    const comp = (await api.post(`/api/ordenes/${ot.id}/comprobante`, { condicion: 'cuenta_corriente', observaciones: 'Sin facturar' })).body;
    expect(comp.total).toBe(160000);
    expect(await total(art)).toBe(6); // el comprobante no descuenta de nuevo
    const cobro = (importe: number, medio = 'efectivo') => api.post('/api/cobros', { cliente_id: cliente.id, medios: [{ medio, importe }], aplicaciones: [{ venta_id: comp.id, importe }], idem_key: idem() });
    const c1 = await cobro(100000);
    expect(c1.status).toBe(201);
    const c2 = await cobro(20000, 'transferencia');
    expect(c2.status).toBe(201);
    expect((await cobro(50000)).status).toBe(409); // excede el saldo (40.000)
    const cta = (await api.get(`/api/cuentas-corrientes/${cliente.id}`)).body;
    expect(cta.saldo).toBe(40000);
    expect(cta.saldo_anterior).toBe(0);
    expect((await api.get(`/api/cuentas-corrientes/${cliente.id}?desde=${hoyAR(1)}`)).body).toMatchObject({ saldo_anterior: 40000, movimientos: [] });
    // anulación autorizada: primero los cobros, después el comprobante; el stock de la OT no se repone solo
    expect((await api.post(`/api/ventas/${comp.id}/anular`, { motivo: 'Prueba' })).status).toBe(409);
    expect((await api.post(`/api/cobros/${c1.body.id}/anular`, { motivo: 'Error' })).status).toBe(200);
    expect((await api.post(`/api/cobros/${c2.body.id}/anular`, { motivo: 'Error' })).status).toBe(200);
    expect((await d.recepcion.api.post(`/api/ventas/${comp.id}/anular`, { motivo: 'Sin permiso' })).status).toBe(403);
    expect((await api.post(`/api/ventas/${comp.id}/anular`, { motivo: 'Prueba' })).status).toBe(200);
    expect((await api.get(`/api/cuentas-corrientes/${cliente.id}`)).body.saldo).toBe(0);
    expect(await total(art)).toBe(6);
    expect((await api.post(`/api/ordenes/${ot.id}/estado`, { estado: 'en_reparacion' })).body.stock).toBe('repuesto');
    expect(await total(art)).toBe(8);
    const ver = (await api.get('/api/cuentas-corrientes/verificar')).body;
    expect(ver).toMatchObject({ ok: true, comprobantes_con_diferencia: [], cobros_sin_cuadrar: [], cobros_con_medios_distintos: [] });
    expect((await d.recepcion.api.get('/api/cuentas-corrientes/verificar')).status).toBe(403);
    await consistente();
  });
});
