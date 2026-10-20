// Gastos, categorías, gastos recurrentes, resumen financiero (sin doble conteo), fechas comerciales y validaciones comerciales.
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, hoyAR, idem, nuevoTaller, nuevoUsuario, ventaConSaldo } from './cliente';

let api: Api;
let emp: Api;
let adm: Api;
let cliente: any;
let cats: any[];

beforeAll(async () => {
  ({ api } = await nuevoTaller('Taller Finanzas', 3));
  emp = await nuevoUsuario(api, 'empleado');
  adm = await nuevoUsuario(api, 'administrador');
  cliente = (await api.post('/api/clientes', { nombre: 'Cliente Finanzas' })).body;
  cats = (await api.get('/api/categorias-gasto')).body;
});

const cat = (nombre: string) => cats.find((c) => c.nombre === nombre).id;
const resumen = async (desde = hoyAR(), hasta = hoyAR()) => (await api.get(`/api/finanzas/resumen?desde=${desde}&hasta=${hasta}`)).body;

describe('gastos y categorías', () => {
  it('cada taller recibe sus categorías iniciales y puede gestionarlas', async () => {
    expect(cats.map((c) => c.nombre)).toContain('Alquiler');
    const nueva = await api.post('/api/categorias-gasto', { nombre: 'Seguros', tipo: 'fijo' });
    expect(nueva.status).toBe(201);
    expect((await api.post('/api/categorias-gasto', { nombre: 'seguros', tipo: 'fijo' })).status).toBe(409); // sin duplicar (sin distinguir mayúsculas)
    expect((await emp.post('/api/categorias-gasto', { nombre: 'Otra', tipo: 'otro' })).status).toBe(403);
    expect((await api.put(`/api/categorias-gasto/${nueva.body.id}`, { activa: false })).status).toBe(200);
    expect((await api.get('/api/categorias-gasto')).body.map((c: any) => c.nombre)).not.toContain('Seguros');
    // Una categoría desactivada no admite gastos nuevos
    expect((await api.post('/api/gastos', { categoria_id: nueva.body.id, concepto: 'Seguro del local', importe: 1000, medio: 'transferencia', idem_key: idem() })).status).toBe(400);
  });

  it('registra gastos con validaciones y los anula con contra-asiento', async () => {
    const base = { categoria_id: cat('Alquiler'), concepto: 'Alquiler del mes', importe: 90000, medio: 'transferencia', idem_key: idem() };
    expect((await api.post('/api/gastos', { ...base, importe: 0, idem_key: idem() })).status).toBe(400);
    expect((await api.post('/api/gastos', { ...base, categoria_id: 'inexistente', idem_key: idem() })).status).toBe(400);
    const g = await api.post('/api/gastos', base);
    expect(g.status).toBe(201);
    expect(g.body).toMatchObject({ estado: 'registrado', categoria: 'Alquiler', numero: 1 });
    expect((await adm.post(`/api/gastos/${g.body.id}/anular`, { motivo: 'carga duplicada' })).status).toBe(200);
    expect((await adm.post(`/api/gastos/${g.body.id}/anular`, { motivo: 'otra vez' })).status).toBe(409);
    const lista = (await api.get('/api/gastos?estado=anulado')).body;
    expect(lista.map((x: any) => x.id)).toContain(g.body.id);
    // El resumen no cuenta el gasto anulado
    expect((await resumen()).egresos.gastos).toBe(0);
  });
});

describe('gastos recurrentes', () => {
  it('registra la ocurrencia pendiente una sola vez, avanza la fecha y permite saltear', async () => {
    const r = await api.post('/api/gastos-recurrentes', {
      categoria_id: cat('Servicios (luz, agua, internet)'), concepto: 'Internet y telefonía', importe: 25000, medio: 'transferencia', frecuencia: 'mensual', dia: 31, proxima_fecha: hoyAR(-3),
    });
    expect(r.status).toBe(201);
    const pend = (await api.get('/api/gastos-recurrentes?pendientes=1')).body;
    expect(pend).toHaveLength(1);
    expect(pend[0].vencido).toBe(1);
    const ocurrencia = pend[0].proxima_fecha;
    const key = idem();
    const [a, b] = await Promise.all([
      api.post(`/api/gastos-recurrentes/${r.body.id}/registrar`, { ocurrencia, importe: 26000, idem_key: key }),
      api.post(`/api/gastos-recurrentes/${r.body.id}/registrar`, { ocurrencia, importe: 26000, idem_key: idem() }),
    ]);
    expect([a.status, b.status].filter((s) => s === 201)).toHaveLength(1); // la otra ve que ya se registró
    expect([a.status, b.status].filter((s) => s === 409)).toHaveLength(1);
    const gastos = (await api.get('/api/gastos?q=Internet')).body;
    expect(gastos).toHaveLength(1);
    expect(gastos[0]).toMatchObject({ importe: 26000, recurrente_fecha: ocurrencia });
    const sig = (await api.get('/api/gastos-recurrentes')).body[0];
    expect(sig.proxima_fecha > ocurrencia).toBe(true);
    expect((await api.post(`/api/gastos-recurrentes/${r.body.id}/saltear`, { ocurrencia: sig.proxima_fecha })).status).toBe(200);
    expect((await api.post(`/api/gastos-recurrentes/${r.body.id}/saltear`, { ocurrencia: sig.proxima_fecha })).status).toBe(409);
    expect((await emp.get('/api/gastos-recurrentes')).status).toBe(403);
  });
});

describe('resumen financiero', () => {
  it('cuenta cada operación una sola vez: cobro, pago a proveedor y gasto', async () => {
    const antes = await resumen();
    const v = await ventaConSaldo(api, cliente.id, 100000);
    const cobro = (m: string, imp: number) => api.post('/api/cobros', { cliente_id: cliente.id, medios: [{ medio: m, importe: imp }], aplicaciones: [{ venta_id: v.id, importe: imp }], idem_key: idem() });
    expect((await cobro('efectivo', 60000)).status).toBe(201);
    expect((await cobro('transferencia', 40000)).status).toBe(201);
    // La venta a cuenta corriente por sí sola no es ingreso; los cobros sí, una vez.
    const prov = (await api.post('/api/proveedores', { nombre: 'Proveedor Fin' })).body;
    const art = (await api.post('/api/articulos', { nombre: 'Art Fin', costo: 1000, precio: 2000 })).body;
    expect((await api.post('/api/compras', { proveedor_id: prov.id, items: [{ articulo_id: art.id, cantidad: 10, costo_unitario: 5000 }], idem_key: idem() })).status).toBe(201);
    // La compra tampoco es egreso hasta que se paga
    expect((await resumen()).egresos.total).toBe(antes.egresos.total);
    expect((await api.post('/api/pagos-proveedor', { proveedor_id: prov.id, importe: 20000, medio: 'efectivo', idem_key: idem() })).status).toBe(201);
    expect((await api.post('/api/gastos', { categoria_id: cat('Insumos de taller'), concepto: 'Insumos varios', importe: 3000, medio: 'efectivo', idem_key: idem() })).status).toBe(201);
    const r = await resumen();
    expect(r.ingresos.cobros - antes.ingresos.cobros).toBe(100000);
    expect(r.egresos.pagos_proveedor - antes.egresos.pagos_proveedor).toBe(20000);
    expect(r.egresos.gastos - antes.egresos.gastos).toBe(3000);
    expect(r.resultado - antes.resultado).toBe(100000 - 20000 - 3000);
    // Totales por medio de pago
    const ef = r.por_medio.find((m: any) => m.medio === 'efectivo');
    const tr = r.por_medio.find((m: any) => m.medio === 'transferencia');
    expect(ef.ingresos - (antes.por_medio.find((m: any) => m.medio === 'efectivo')?.ingresos ?? 0)).toBe(60000);
    expect(tr.ingresos - (antes.por_medio.find((m: any) => m.medio === 'transferencia')?.ingresos ?? 0)).toBe(40000);
    expect(r.gastos_por_categoria.find((c: any) => c.nombre === 'Insumos de taller').total).toBe(3000);
    expect(r.devengado.compras_registradas).toBe(50000);
    expect(r.devengado.por_pagar).toBe(30000);
  });

  it('anular el cobro lo descuenta del resumen (no queda contabilizado)', async () => {
    const antes = await resumen();
    const v = await ventaConSaldo(api, cliente.id, 7000);
    const c = await api.post('/api/cobros', { cliente_id: cliente.id, medios: [{ medio: 'efectivo', importe: 7000 }], aplicaciones: [{ venta_id: v.id, importe: 7000 }], idem_key: idem() });
    expect((await resumen()).ingresos.cobros - antes.ingresos.cobros).toBe(7000);
    await api.post(`/api/cobros/${c.body.id}/anular`, { motivo: 'prueba' });
    expect((await resumen()).ingresos.cobros).toBe(antes.ingresos.cobros);
  });

  it('el resumen exige permiso de finanzas y valida el período', async () => {
    expect((await emp.get(`/api/finanzas/resumen?desde=${hoyAR()}&hasta=${hoyAR()}`)).status).toBe(403);
    expect((await api.get(`/api/finanzas/resumen?desde=${hoyAR()}&hasta=${hoyAR(-5)}`)).status).toBe(400);
    expect((await api.get('/api/finanzas/resumen?desde=hoy&hasta=mañana')).status).toBe(400);
  });
});

describe('fechas comerciales', () => {
  const venta = (extra: object) => ({ items: [{ tipo: 'libre', descripcion: 'x', cantidad: 1, precio_unitario: 1000 }], cobro: { medio: 'efectivo' }, idem_key: idem(), ...extra });
  it('rechaza fechas futuras y absurdas; el empleado sólo puede usar hoy', async () => {
    expect((await api.post('/api/ventas', venta({ fecha: hoyAR(2) }))).status).toBe(400);
    expect((await api.post('/api/ventas', venta({ fecha: '2099-01-01' }))).status).toBe(400);
    expect((await api.post('/api/ventas', venta({ fecha: '1999-05-05' }))).status).toBe(400);
    expect((await api.post('/api/ventas', venta({ fecha: '2026-02-30' }))).status).toBe(400); // no existe
    expect((await emp.post('/api/ventas', venta({ fecha: hoyAR(-1) }))).status).toBe(403);
    expect((await emp.post('/api/ventas', venta({ fecha: hoyAR() }))).status).toBe(201);
  });
  it('un administrador puede cargar fechas pasadas razonables; cobros y pagos siguen la misma regla', async () => {
    const v = await adm.post('/api/ventas', venta({ fecha: hoyAR(-2), condicion: 'cuenta_corriente', cobro: null, cliente_id: cliente.id }));
    expect(v.status).toBe(201);
    expect(v.body.fecha).toBe(hoyAR(-2));
    const cobroBase = { cliente_id: cliente.id, medios: [{ medio: 'efectivo', importe: 500 }], aplicaciones: [{ venta_id: v.body.id, importe: 500 }] };
    expect((await emp.post('/api/cobros', { ...cobroBase, fecha: hoyAR(-1), idem_key: idem() })).status).toBe(403);
    expect((await api.post('/api/cobros', { ...cobroBase, fecha: hoyAR(-3), idem_key: idem() })).status).toBe(400); // anterior al comprobante
    expect((await api.post('/api/cobros', { ...cobroBase, fecha: hoyAR(-1), idem_key: idem() })).status).toBe(201);
    expect((await api.post('/api/gastos', { categoria_id: cats[0].id, concepto: 'Gasto futuro', importe: 100, medio: 'efectivo', fecha: hoyAR(1), idem_key: idem() })).status).toBe(400);
  });
});

describe('validaciones comerciales (hallazgos de la auditoría)', () => {
  const items = [{ tipo: 'libre', descripcion: 'x', cantidad: 1, precio_unitario: 1000 }];
  it('venta de contado sin cobro ya no queda impaga: se exige el medio de pago', async () => {
    const r = await api.post('/api/ventas', { items, idem_key: idem() });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/contado/i);
  });
  it('no se admite cuenta corriente para "Consumidor final"', async () => {
    expect((await api.post('/api/ventas', { items, condicion: 'cuenta_corriente', idem_key: idem() })).status).toBe(400);
    const cf = (await api.get('/api/clientes?q=Consumidor')).body.find((c: any) => c.codigo === 0);
    if (cf) expect((await api.post('/api/ventas', { items, condicion: 'cuenta_corriente', cliente_id: cf.id, idem_key: idem() })).status).toBe(400);
  });
  it('contado + cuenta corriente son excluyentes y el cheque exige número', async () => {
    expect((await api.post('/api/ventas', { items, condicion: 'cuenta_corriente', cliente_id: cliente.id, cobro: { medio: 'efectivo' }, idem_key: idem() })).status).toBe(400);
    expect((await api.post('/api/ventas', { items, cobro: { medio: 'cheque' }, idem_key: idem() })).status).toBe(400);
    expect((await api.post('/api/ventas', { items, cobro: { medio: 'cheque', referencia: '00123' }, idem_key: idem() })).status).toBe(201);
  });
  it('comprobante de OT: contado exige cobro, cuenta corriente exige cliente identificado, y "emitir y cobrar" es atómico', async () => {
    const veh = (await api.post('/api/vehiculos', { cliente_id: cliente.id, patente: 'FIN123' })).body;
    const crear = async () => {
      const o = (await api.post('/api/ordenes', { cliente_id: cliente.id, vehiculo_id: veh.id, items: [{ tipo: 'libre', descripcion: 'Trabajo', cantidad: 1, precio_unitario: 80000 }] })).body;
      await api.post(`/api/ordenes/${o.id}/estado`, { estado: 'lista' });
      return o;
    };
    const o1 = await crear();
    expect((await api.post(`/api/ordenes/${o1.id}/comprobante`, { condicion: 'contado' })).status).toBe(400);
    const antes = await resumen();
    const ok = await api.post(`/api/ordenes/${o1.id}/comprobante`, { condicion: 'contado', cobro: { medio: 'debito' } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const v = (await api.get(`/api/ventas/${ok.body.id}`)).body;
    expect(v).toMatchObject({ cobrado: 80000, saldo: 0 });
    expect(v.cobros).toHaveLength(1);
    expect((await resumen()).ingresos.cobros - antes.ingresos.cobros).toBe(80000);
    // Segundo intento sobre la misma OT: no duplica comprobante ni cobro
    expect((await api.post(`/api/ordenes/${o1.id}/comprobante`, { condicion: 'contado', cobro: { medio: 'debito' } })).status).toBe(409);
    expect((await resumen()).ingresos.cobros - antes.ingresos.cobros).toBe(80000);
  });
  it('un cobro con importe distinto del aplicado o a un cliente ajeno se rechaza', async () => {
    const otro = (await api.post('/api/clientes', { nombre: 'Otro cliente' })).body;
    const v = await ventaConSaldo(api, cliente.id, 5000);
    expect((await api.post('/api/cobros', { cliente_id: otro.id, medios: [{ medio: 'efectivo', importe: 5000 }], aplicaciones: [{ venta_id: v.id, importe: 5000 }], idem_key: idem() })).status).toBe(400);
    expect((await api.post('/api/cobros', { cliente_id: cliente.id, medios: [{ medio: 'efectivo', importe: 4000 }], aplicaciones: [{ venta_id: v.id, importe: 5000 }], idem_key: idem() })).status).toBe(400);
  });
});

describe('cuentas corrientes y cobranzas', () => {
  it('lista con filtros por estado, antigüedad de la deuda e historial de pagos', async () => {
    const c2 = (await api.post('/api/clientes', { nombre: 'Moroso Antiguo' })).body;
    await adm.post('/api/ventas', { cliente_id: c2.id, condicion: 'cuenta_corriente', fecha: hoyAR(-45), items: [{ tipo: 'libre', descripcion: 'viejo', cantidad: 1, precio_unitario: 40000 }], idem_key: idem() });
    await adm.post('/api/ventas', { cliente_id: c2.id, condicion: 'cuenta_corriente', items: [{ tipo: 'libre', descripcion: 'nuevo', cantidad: 1, precio_unitario: 10000 }], idem_key: idem() });
    const todos = (await api.get('/api/cuentas-corrientes')).body;
    const fila = todos.find((c: any) => c.id === c2.id);
    expect(fila).toMatchObject({ saldo: 50000, v_0: 10000, v_30: 40000, pendientes: 2 });
    expect((await api.get('/api/cuentas-corrientes?estado=vencidas')).body.map((c: any) => c.id)).toContain(c2.id);
    expect((await api.get('/api/cuentas-corrientes?q=Antiguo')).body).toHaveLength(1);
    expect((await api.get('/api/cuentas-corrientes?q=zzzz')).body).toHaveLength(0);
    // Pago parcial a la deuda más vieja y detalle
    const det = (await api.get(`/api/cuentas-corrientes/${c2.id}`)).body;
    expect(det.pendientes).toHaveLength(2);
    const vieja = det.pendientes[0];
    const c = await api.post('/api/cobros', { cliente_id: c2.id, medios: [{ medio: 'efectivo', importe: 15000 }], aplicaciones: [{ venta_id: vieja.id, importe: 15000 }], idem_key: idem() });
    expect(c.status).toBe(201);
    const det2 = (await api.get(`/api/cuentas-corrientes/${c2.id}`)).body;
    expect(det2.saldo).toBe(35000);
    expect(det2.cobros).toHaveLength(1);
    expect(det2.cobros[0].medios[0]).toMatchObject({ medio: 'efectivo', importe: 15000 });
    // Cobros: filtros por estado/medio/cliente y detalle para el recibo
    expect((await api.get(`/api/cobros?cliente_id=${c2.id}&estado=registrado&medio=efectivo`)).body).toHaveLength(1);
    expect((await api.get(`/api/cobros?cliente_id=${c2.id}&medio=transferencia`)).body).toHaveLength(0);
    const recibo = (await api.get(`/api/cobros/${c.body.id}`)).body;
    expect(recibo).toMatchObject({ cliente: 'Moroso Antiguo', total: 15000 });
    expect(recibo.aplicaciones[0]).toMatchObject({ importe: 15000, total: 40000, cobrado: 15000 });
  });
});

describe('precisión decimal del stock', () => {
  it('0,3 − 0,1 deja exactamente 0,2 y permite la salida legítima de 0,2', async () => {
    const a = (await api.post('/api/articulos', { nombre: 'Aceite a granel', unidad: 'lt', stock_inicial: 0.3, precio: 1000 })).body;
    expect((await api.post('/api/stock/movimientos', { articulo_id: a.id, tipo: 'salida', cantidad: 0.1, idem_key: idem() })).body.stock).toBe(0.2);
    const salida = await api.post('/api/stock/movimientos', { articulo_id: a.id, tipo: 'salida', cantidad: 0.2, idem_key: idem() });
    expect(salida.status).toBe(201);
    expect(salida.body.stock).toBe(0);
    // Y por venta de mostrador
    const b = (await api.post('/api/articulos', { nombre: 'Líquido', unidad: 'lt', stock_inicial: 0.3, precio: 1000 })).body;
    const v1 = await api.post('/api/ventas', { items: [{ tipo: 'articulo', articulo_id: b.id, descripcion: 'Líquido', cantidad: 0.1, precio_unitario: 1000 }], cobro: { medio: 'efectivo' }, idem_key: idem() });
    expect(v1.status).toBe(201);
    const v2 = await api.post('/api/ventas', { items: [{ tipo: 'articulo', articulo_id: b.id, descripcion: 'Líquido', cantidad: 0.2, precio_unitario: 1000 }], cobro: { medio: 'efectivo' }, idem_key: idem() });
    expect(v2.status, JSON.stringify(v2.body)).toBe(201);
    expect((await api.get(`/api/articulos/${b.id}`)).body.stock).toBe(0);
  });
  it('rechaza cantidades con más de 3 decimales', async () => {
    const a = (await api.post('/api/articulos', { nombre: 'Tornillo', stock_inicial: 10, precio: 100 })).body;
    expect((await api.post('/api/stock/movimientos', { articulo_id: a.id, tipo: 'salida', cantidad: 0.0001, idem_key: idem() })).status).toBe(400);
    expect((await api.post('/api/ventas', { items: [{ tipo: 'articulo', articulo_id: a.id, descripcion: 'x', cantidad: 1.0005, precio_unitario: 100 }], cobro: { medio: 'efectivo' }, idem_key: idem() })).status).toBe(400);
  });
});
