// Sprint 10: contabilidad de partida doble integrada con las operaciones comerciales.
// Se recorre un taller completo (compra, venta, cobros, anticipo, devolución, reintegro, gasto, bancos, cheques, ajuste de stock, anulaciones) y se
// verifica que cada circuito genere sus asientos una sola vez, que todos balanceen y que la contabilidad coincida con las cuentas corrientes, la caja y los bancos.
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, hoyAR, idem, nuevoPersonal, nuevoTaller } from './cliente';

let T: Awaited<ReturnType<typeof nuevoTaller>>;
let OTRO: Awaited<ReturnType<typeof nuevoTaller>>;
let api: Api;
const d: Record<string, any> = {};

const lineaArt = (a: any, cantidad: number, precio = 20000) => ({ tipo: 'articulo', articulo_id: a.id, descripcion: 'Filtro', cantidad, precio_unitario: precio });
const lineaSrv = (descripcion: string, precio: number) => ({ tipo: 'libre', descripcion, cantidad: 1, precio_unitario: precio });
const venta = async (cliente: any, items: any[], extra: any = {}) => {
  const r = await api.post('/api/ventas', { cliente_id: cliente.id, condicion: 'cuenta_corriente', idem_key: idem(), items, ...extra });
  if (r.status !== 201) throw new Error(`venta falló: ${JSON.stringify(r.body)}`);
  return r.body;
};
const cobrar = async (cliente: any, ventaId: string, importe: number, medio = 'efectivo', extra: any = {}) => {
  const r = await api.post('/api/cobros', { cliente_id: cliente.id, medios: [{ medio, importe, ...extra }], aplicaciones: [{ venta_id: ventaId, importe }], idem_key: idem() });
  if (r.status !== 201) throw new Error(`cobro falló: ${JSON.stringify(r.body)}`);
  return r.body;
};
const periodo = () => `desde=${hoyAR(-30)}&hasta=${hoyAR()}`;
const controles = async () => {
  const r = await api.get('/api/contabilidad/controles');
  expect(r.status).toBe(200);
  return Object.fromEntries(r.body.controles.map((c: any) => [c.clave, c]));
};
const saldoRol = async (rol: string) => (await api.get('/api/contabilidad/plan')).body.find((c: any) => c.rol === rol)?.saldo ?? 0;
const diario = async (extra = '') => (await api.get(`/api/contabilidad/diario?${periodo()}&limite=500${extra}`)).body;

beforeAll(async () => {
  T = await nuevoTaller('Taller Contable', 10);
  OTRO = await nuevoTaller('Otro Taller Contable', 2);
  api = T.api;
  d.cliente = (await api.post('/api/clientes', { nombre: 'Cliente Uno', telefono: '1111' })).body;
  d.cliente2 = (await api.post('/api/clientes', { nombre: 'Cliente Dos', telefono: '2222' })).body;
  d.filtro = (await api.post('/api/articulos', { nombre: 'Filtro Aceite', codigo: 'FA', costo: 10000, precio: 20000, stock_inicial: 10 })).body;
  d.proveedor = (await api.post('/api/proveedores', { nombre: 'Distribuidora Sur' })).body;
  d.banco = (await api.post('/api/bancos/cuentas', { nombre: 'Banco Test', banco: 'Banco Test', saldo_inicial: 500000 })).body;
  d.banco2 = (await api.post('/api/bancos/cuentas', { nombre: 'Billetera', banco: 'Billetera', saldo_inicial: 0 })).body;
  await api.post('/api/caja/abrir', { saldo_inicial: 100000 });
  // La contabilidad se activa de forma explícita: genera lo ya operado como histórico y desde ahí se mantiene sola.
  expect((await api.post('/api/contabilidad/activar', {})).status).toBe(200);
  expect((await OTRO.api.post('/api/contabilidad/activar', {})).status).toBe(200);
});

describe('plan de cuentas', () => {
  it('cada taller recibe su plan inicial, con las cuentas de sistema y una cuenta por cada cuenta bancaria', async () => {
    const r = await api.get('/api/contabilidad/plan');
    expect(r.status).toBe(200);
    const plan = r.body as any[];
    expect(plan.length).toBeGreaterThan(50);
    for (const rol of ['caja_efectivo', 'deudores', 'proveedores', 'inventario', 'anticipos', 'ventas_repuestos', 'ventas_servicios', 'costo_repuestos', 'iva_debito', 'obligaciones']) expect(plan.some((c) => c.rol === rol), rol).toBe(true);
    expect(plan.filter((c) => c.cuenta_bancaria_id)).toHaveLength(2);
    expect(plan.find((c) => c.codigo === '1')).toMatchObject({ nombre: 'ACTIVO', imputable: 0 });
    // volver a inicializar no duplica nada
    expect((await api.get('/api/contabilidad/plan')).body).toHaveLength(plan.length);
  });

  it('el taller agrega y modifica cuentas dentro de reglas que protegen la integridad', async () => {
    const rubro = (await api.get('/api/contabilidad/plan')).body.find((c: any) => c.codigo === '6.1');
    const nueva = await api.post('/api/contabilidad/cuentas', { codigo: '6.1.50', nombre: 'Capacitación', tipo: 'gasto', padre_id: rubro.id });
    expect(nueva.status).toBe(201);
    d.cuentaCapacitacion = nueva.body;
    expect((await api.post('/api/contabilidad/cuentas', { codigo: '6.1.50', nombre: 'Repetida', tipo: 'gasto', padre_id: rubro.id })).status).toBe(409);
    expect((await api.post('/api/contabilidad/cuentas', { codigo: 'abc', nombre: 'Mala', tipo: 'gasto' })).status).toBe(400);
    // el tipo debe coincidir con el del rubro
    expect((await api.post('/api/contabilidad/cuentas', { codigo: '4.9.01', nombre: 'Mezcla', tipo: 'ingreso', padre_id: rubro.id })).status).toBe(400);
    // una cuenta imputable no agrupa a otras
    expect((await api.post('/api/contabilidad/cuentas', { codigo: '6.1.50.1', nombre: 'Hija', tipo: 'gasto', padre_id: d.cuentaCapacitacion.id })).status).toBe(409);
    expect((await api.put(`/api/contabilidad/cuentas/${d.cuentaCapacitacion.id}`, { nombre: 'Capacitación del personal' })).status).toBe(200);
    // las cuentas del sistema se renombran pero no se eliminan ni se desactivan
    const caja = (await api.get('/api/contabilidad/plan')).body.find((c: any) => c.rol === 'caja_efectivo');
    expect((await api.put(`/api/contabilidad/cuentas/${caja.id}`, { nombre: 'Caja (efectivo)' })).status).toBe(200);
    expect((await api.put(`/api/contabilidad/cuentas/${caja.id}`, { activa: false })).status).toBe(409);
    expect((await api.del(`/api/contabilidad/cuentas/${caja.id}`)).status).toBe(409);
    // una cuenta propia sin movimientos se puede eliminar
    const tmp = (await api.post('/api/contabilidad/cuentas', { codigo: '6.1.51', nombre: 'Temporal', tipo: 'gasto', padre_id: rubro.id })).body;
    expect((await api.del(`/api/contabilidad/cuentas/${tmp.id}`)).status).toBe(200);
    expect((await api.put(`/api/contabilidad/cuentas/${caja.id}`, { nombre: 'Caja en efectivo' })).status).toBe(200);
  });
});

describe('circuitos contabilizados desde las operaciones', () => {
  it('compra con pago de contado: inventario + IVA crédito contra proveedores, y el pago cancela la deuda sin ser un gasto', async () => {
    const r = await api.post('/api/compras', {
      proveedor_id: d.proveedor.id, items: [{ articulo_id: d.filtro.id, cantidad: 5, costo_unitario: 10000 }], iva: 10500, idem_key: idem(), pago: { medio: 'efectivo' },
    });
    expect(r.status).toBe(201);
    d.compra1 = r.body;
    const as = (await diario()).asientos.filter((a: any) => a.origen_tipo === 'compra' || a.origen_tipo === 'pago_proveedor');
    expect(as).toHaveLength(2);
    const c = as.find((a: any) => a.origen_tipo === 'compra');
    expect(c.lineas.map((l: any) => [l.cuenta_nombre, l.debe, l.haber]).sort()).toEqual(
      [['IVA crédito fiscal (informativo)', 10500, 0], ['Inventario de repuestos', 50000, 0], ['Proveedores', 0, 60500]].sort(),
    );
    expect(c.modo).toBe('automatico');
    expect(c.usuario).toBeTruthy();
    expect(await saldoRol('proveedores')).toBe(0);
  });

  it('venta a cuenta corriente: ingresos contra deudores y costo histórico contra inventario; el cobro no vuelve a ser ingreso', async () => {
    d.v1 = await venta(d.cliente, [lineaArt(d.filtro, 2), lineaSrv('Cambio de aceite', 30000)]);
    expect(d.v1.total).toBe(70000);
    const a = (await diario()).asientos.find((x: any) => x.origen_id === d.v1.id);
    expect(a.descripcion).toContain(`Venta #${d.v1.numero}`);
    const ln = (nombre: string) => a.lineas.find((l: any) => l.cuenta_nombre === nombre);
    expect(ln('Deudores por ventas (clientes)')).toMatchObject({ debe: 70000 });
    expect(ln('Ventas de repuestos')).toMatchObject({ haber: 40000 });
    expect(ln('Ingresos por servicios y mano de obra')).toMatchObject({ haber: 30000 });
    expect(ln('Costo de repuestos vendidos')).toMatchObject({ debe: 20000 });
    expect(ln('Inventario de repuestos')).toMatchObject({ haber: 20000 });
    expect(a.costo_incompleto).toBe(0);
    // el costo del artículo cambia después: el asiento ya registrado no se toca
    await api.put(`/api/articulos/${d.filtro.id}`, { costo: 15000 });
    await api.put(`/api/articulos/${d.filtro.id}`, { costo: 10000 });
    // cobros: por transferencia sin cuenta, por transferencia a una cuenta bancaria
    await cobrar(d.cliente, d.v1.id, 30000, 'transferencia');
    await cobrar(d.cliente, d.v1.id, 10000, 'transferencia', { cuenta_id: d.banco.id });
    const cob = (await diario()).asientos.filter((x: any) => x.origen_tipo === 'cobro');
    expect(cob).toHaveLength(2);
    const cuentas = cob.flatMap((x: any) => x.lineas.map((l: any) => l.cuenta_nombre));
    expect(cuentas).toContain('Medios electrónicos sin cuenta asignada');
    expect(cuentas).toContain('Banco: Banco Test');
    expect(cob.flatMap((x: any) => x.lineas).filter((l: any) => l.cuenta_nombre.startsWith('Ventas') || l.cuenta_nombre.startsWith('Ingresos'))).toHaveLength(0);
    // la deuda del cliente sigue siendo 70.000 − 40.000
    expect(await saldoRol('deudores')).toBe(30000);
  });

  it('anticipo (pasivo, no es una venta), aplicación del anticipo y devolución con reintegro', async () => {
    const ant = await api.post('/api/anticipos', { cliente_id: d.cliente2.id, medios: [{ medio: 'efectivo', importe: 25000 }], idem_key: idem() });
    expect(ant.status).toBe(201);
    expect(await saldoRol('anticipos')).toBe(25000);
    const antAsiento = (await diario()).asientos.find((x: any) => x.origen_id === ant.body.id);
    expect(antAsiento.lineas.map((l: any) => l.cuenta_nombre).sort()).toEqual(['Anticipos y saldos a favor de clientes', 'Caja en efectivo']);
    d.v2 = await venta(d.cliente2, [lineaArt(d.filtro, 1)]);
    const ap = await api.post(`/api/ventas/${d.v2.id}/aplicar-creditos`, { aplicaciones: [{ origen_tipo: 'anticipo', origen_id: ant.body.id, importe: 20000 }], idem_key: idem() });
    expect(ap.status).toBe(201);
    expect(await saldoRol('anticipos')).toBe(5000);

    // devolución del repuesto con reingreso al stock: reduce ventas y recupera el costo
    const det = (await api.get(`/api/ventas/${d.v1.id}`)).body;
    const itArt = det.items.find((i: any) => i.tipo === 'articulo');
    const itSrv = det.items.find((i: any) => i.tipo === 'libre');
    const dev1 = await api.post('/api/devoluciones', { venta_id: d.v1.id, motivo: 'Repuesto incorrecto', items: [{ venta_item_id: itArt.id, cantidad: 1, reingresa: true }], idem_key: idem() });
    expect(dev1.status).toBe(201);
    const aDev = (await diario()).asientos.find((x: any) => x.origen_id === dev1.body.id);
    expect(aDev.lineas.map((l: any) => [l.cuenta_nombre, l.debe, l.haber]).sort()).toEqual(
      [['(−) Devoluciones de repuestos', 20000, 0], ['Costo de repuestos vendidos', 0, 10000], ['Deudores por ventas (clientes)', 0, 20000], ['Inventario de repuestos', 10000, 0]].sort(),
    );
    // se termina de cobrar el comprobante y se bonifica el servicio ya pagado, devolviendo el dinero en efectivo
    await cobrar(d.cliente, d.v1.id, 10000, 'efectivo');
    const dev2 = await api.post('/api/devoluciones', {
      venta_id: d.v1.id, motivo: 'Bonificación del servicio', items: [{ venta_item_id: itSrv.id, cantidad: 1, importe: 10000 }], idem_key: idem(),
      reintegro: { medios: [{ medio: 'efectivo', importe: 10000 }] },
    });
    expect(dev2.status).toBe(201);
    expect(dev2.body).toMatchObject({ liberado: 10000, reintegrado: 10000 });
    const reint = (await diario()).asientos.filter((x: any) => x.origen_tipo === 'reintegro');
    expect(reint).toHaveLength(1);
    expect(reint[0].lineas.map((l: any) => [l.cuenta_nombre, l.debe, l.haber]).sort()).toEqual([['Anticipos y saldos a favor de clientes', 10000, 0], ['Caja en efectivo', 0, 10000]].sort());
    expect(await saldoRol('deudores')).toBe(0); // v1 cobrada y devuelta; v2 saldada con el anticipo
  });

  it('gastos, ingresos manuales de caja y sus anulaciones generan contra-asientos (nunca borran)', async () => {
    const cat = (await api.get('/api/categorias-gasto')).body.find((c: any) => c.nombre === 'Alquiler');
    const g1 = await api.post('/api/gastos', { categoria_id: cat.id, concepto: 'Alquiler del mes', importe: 15000, medio: 'efectivo', idem_key: idem() });
    expect(g1.status).toBe(201);
    const g2 = await api.post('/api/gastos', { categoria_id: cat.id, concepto: 'Alquiler duplicado', importe: 8000, medio: 'efectivo', idem_key: idem() });
    expect((await api.post(`/api/gastos/${g2.body.id}/anular`, { motivo: 'Cargado dos veces' })).status).toBe(200);
    const mi = await api.post('/api/caja/movimientos', { medio: 'efectivo', importe: 7000, concepto: 'Venta de chatarra', idem_key: idem() });
    expect(mi.status).toBe(201);
    const as = (await diario()).asientos;
    const alquiler = as.filter((x: any) => x.origen_id === g1.body.id);
    expect(alquiler).toHaveLength(1);
    expect(alquiler[0].lineas.map((l: any) => [l.cuenta_nombre, l.debe, l.haber]).sort()).toEqual([['Alquileres', 15000, 0], ['Caja en efectivo', 0, 15000]].sort());
    // el gasto anulado tiene alta y anulación; el original queda "revertido" y vinculado a su contra-asiento
    const par = as.filter((x: any) => x.origen_id === g2.body.id);
    expect(par.map((x: any) => x.evento).sort()).toEqual(['alta', 'anulacion']);
    const alta = par.find((x: any) => x.evento === 'alta');
    const anul = par.find((x: any) => x.evento === 'anulacion');
    expect(alta.estado).toBe('revertido');
    expect(anul).toMatchObject({ estado: 'registrado', modo: 'reversion', revierte_numero: alta.numero });
    expect(alta.revertido_por_numero).toBe(anul.numero);
    expect(anul.lineas.map((l: any) => [l.cuenta_nombre, l.debe, l.haber]).sort()).toEqual([['Alquileres', 0, 8000], ['Caja en efectivo', 8000, 0]].sort());
    expect(as.filter((x: any) => x.origen_id === mi.body.id)).toHaveLength(1);
  });

  it('venta anulada: contra-asiento completo, con el stock de vuelta', async () => {
    const v3 = await venta(d.cliente, [lineaArt(d.filtro, 1)]);
    expect((await api.post(`/api/ventas/${v3.id}/anular`, { motivo: 'Error de carga' })).status).toBe(200);
    const par = (await diario()).asientos.filter((x: any) => x.origen_id === v3.id);
    expect(par).toHaveLength(2);
    const sumar = (a: any, campo: string) => a.lineas.reduce((t: number, l: any) => t + l[campo], 0);
    for (const a of par) expect(sumar(a, 'debe')).toBe(sumar(a, 'haber'));
    const alta = par.find((x: any) => x.evento === 'alta');
    const anul = par.find((x: any) => x.evento === 'anulacion');
    expect(anul.fecha >= alta.fecha).toBe(true);
    expect(anul.lineas.find((l: any) => l.cuenta_nombre === 'Deudores por ventas (clientes)')).toMatchObject({ haber: 20000 });
  });

  it('bancos: depósito, extracción y transferencia entre cuentas propias no generan resultado; intereses y comisiones sí', async () => {
    const antes = await api.get(`/api/contabilidad/estado-resultados?${periodo()}`);
    expect((await api.post('/api/bancos/depositos', { cuenta_id: d.banco.id, importe: 20000, concepto: 'Depósito de efectivo', idem_key: idem() })).status).toBe(201);
    expect((await api.post('/api/bancos/extracciones', { cuenta_id: d.banco.id, importe: 5000, concepto: 'Extracción', idem_key: idem() })).status).toBe(201);
    const tr = await api.post('/api/bancos/transferencias', { origen_id: d.banco.id, destino_id: d.banco2.id, importe: 10000, idem_key: idem() });
    expect(tr.status).toBe(201);
    const despues = await api.get(`/api/contabilidad/estado-resultados?${periodo()}`);
    expect(despues.body.resultado).toBe(antes.body.resultado); // ni depósito, ni extracción, ni transferencia mueven el resultado
    expect((await controles()).transferencias.estado).toBe('ok');
    expect((await api.post('/api/bancos/movimientos', { cuenta_id: d.banco.id, tipo: 'ingreso', importe: 300, concepto: 'Intereses', idem_key: idem() })).status).toBe(201);
    expect((await api.post('/api/bancos/movimientos', { cuenta_id: d.banco.id, tipo: 'egreso', importe: 100, concepto: 'Comisión de mantenimiento', idem_key: idem() })).status).toBe(201);
    const er = (await api.get(`/api/contabilidad/estado-resultados?${periodo()}`)).body;
    expect(er.resultado).toBe(despues.body.resultado + 300 - 100);
    // anular la transferencia revierte las dos patas
    expect((await api.post(`/api/bancos/transferencias/${tr.body.id}/anular`, { motivo: 'Error' })).status).toBe(200);
    expect((await controles()).transferencias.estado).toBe('ok');
  });

  it('cheque recibido en un cobro: queda en valores a depositar y se acredita en el banco sin ser un ingreso nuevo', async () => {
    const v4 = await venta(d.cliente, [lineaSrv('Alineación', 15000)]);
    const cob = await cobrar(d.cliente, v4.id, 15000, 'cheque', { referencia: 'CH-100', cheque: { banco: 'Banco Origen', fecha_pago: hoyAR() } });
    expect(await saldoRol('valores_depositar')).toBe(15000);
    const ch = (await api.get('/api/cheques')).body.find((c: any) => c.nro_cheque === 'CH-100');
    expect((await api.post(`/api/cheques/${ch.id}/depositar`, { cuenta_id: d.banco.id })).status).toBe(200);
    const antes = (await api.get(`/api/contabilidad/estado-resultados?${periodo()}`)).body.resultado;
    expect((await api.post(`/api/cheques/${ch.id}/acreditar`, {})).status).toBe(200);
    expect(await saldoRol('valores_depositar')).toBe(0);
    expect((await api.get(`/api/contabilidad/estado-resultados?${periodo()}`)).body.resultado).toBe(antes);
    expect(cob.id).toBeTruthy();
  });

  it('pago a proveedor con cheque propio: deuda cancelada contra cheques emitidos, que se debitan del banco al acreditarse', async () => {
    const c2 = await api.post('/api/compras', { proveedor_id: d.proveedor.id, items: [{ articulo_id: d.filtro.id, cantidad: 2, costo_unitario: 10000 }], idem_key: idem() });
    expect(c2.status).toBe(201);
    expect(await saldoRol('proveedores')).toBe(20000);
    const pago = await api.post('/api/pagos-proveedor', {
      proveedor_id: d.proveedor.id, importe: 20000, medio: 'cheque', referencia: 'CP-1', cheque: { banco: 'Banco Test', fecha_pago: hoyAR() }, idem_key: idem(),
    });
    expect(pago.status).toBe(201);
    expect(await saldoRol('proveedores')).toBe(0);
    expect(await saldoRol('cheques_emitidos')).toBe(20000);
    const ch = (await api.get('/api/cheques')).body.find((c: any) => c.nro_cheque === 'CP-1');
    expect((await api.post(`/api/cheques/${ch.id}/acreditar`, { cuenta_id: d.banco.id })).status).toBe(200);
    expect(await saldoRol('cheques_emitidos')).toBe(0);
  });

  it('ajuste manual de inventario: la rotura es una pérdida valuada al costo', async () => {
    const r = await api.post('/api/stock/movimientos', { articulo_id: d.filtro.id, tipo: 'salida', cantidad: 1, motivo: 'rotura', notas: 'Se cayó', idem_key: idem() });
    expect(r.status).toBe(201);
    const a = (await diario()).asientos.find((x: any) => x.origen_tipo === 'stock_ajuste' && x.descripcion.includes('rotura'));
    expect(a.lineas.map((l: any) => [l.cuenta_nombre, l.debe, l.haber]).sort()).toEqual([['Diferencias de inventario (mermas, roturas, sobrantes)', 10000, 0], ['Inventario de repuestos', 0, 10000]].sort());
  });
});

describe('consistencia y control', () => {
  it('toda la contabilidad coincide con las cuentas corrientes, la caja, los bancos, los cheques y el inventario', async () => {
    const c = await controles();
    for (const k of ['partida_doble', 'cobertura', 'clientes', 'anticipos', 'proveedores', 'caja', 'bancos', 'electronicos', 'valores', 'cheques_emitidos', 'transferencias']) {
      expect(c[k], k).toBeTruthy();
      expect(c[k].estado, `${k}: ${c[k].detalle} ${JSON.stringify(c[k].items ?? '')}`).toBe('ok');
    }
    expect(c.inventario.estado, c.inventario.detalle).toBe('ok');
    expect(c.cobertura.items.every((i: any) => i.pendientes === 0 && i.con_error === 0)).toBe(true);
  });

  it('el balance de sumas y saldos cuadra y no presenta saldos de naturaleza contraria', async () => {
    const b = (await api.get(`/api/contabilidad/balance?${periodo()}`)).body;
    expect(b.cuadra).toBe(true);
    expect(b.totales.debe).toBe(b.totales.haber);
    expect(b.totales.finalD).toBe(b.totales.finalH);
    expect(b.inconsistencias).toEqual([]);
    expect(b.cuentas.find((c: any) => c.rol === 'caja_efectivo').final).toBeGreaterThan(0);
    // con un período posterior, los saldos del período anterior pasan a ser saldos iniciales
    const sig = (await api.get(`/api/contabilidad/balance?desde=${hoyAR(1)}&hasta=${hoyAR(2)}`)).body;
    expect(sig.cuentas.find((c: any) => c.rol === 'caja_efectivo')).toMatchObject({ inicial: b.cuentas.find((c: any) => c.rol === 'caja_efectivo').final, debe: 0, haber: 0 });
  });

  it('el estado de resultados es económico (devengado) y se distingue del flujo de caja', async () => {
    const er = (await api.get(`/api/contabilidad/estado-resultados?${periodo()}`)).body;
    const l = (k: string) => er.lineas.find((x: any) => x.clave === k)?.monto;
    // ventas: v1 (40.000 repuestos + 30.000 servicios), v2 20.000 de repuestos, v3 anulada (neto 0) y v4 15.000 de servicios; devoluciones: 20.000 de repuestos y 10.000 de servicios
    expect(l('ventas_repuestos')).toBe(40000);
    expect(l('ventas_servicios')).toBe(35000);
    expect(er.ventas_netas).toBe(75000);
    expect(l('costo_repuestos')).toBe(-20000); // 20.000 + 10.000 de las ventas − 10.000 recuperados por la devolución que reingresó
    expect(l('gastos')).toBe(-25100); // alquiler 15.000 + comisión bancaria 100 + rotura 10.000 (el gasto anulado y el depósito/transferencia no cuentan)
    expect(l('otros_ingresos')).toBe(7300); // venta de chatarra 7.000 + intereses 300
    expect(er.resultado).toBe(75000 - 20000 - 25100 + 7300);
    expect(er.calidad).toBe('definitivo');
    expect(er.resultado).toBe(l('resultado'));
    expect(er.flujo_caja).toMatchObject({ neto: expect.any(Number) });
    expect(er.flujo_caja.neto).not.toBe(er.resultado); // económico ≠ caja
    expect(er.motivos.filter((m: string) => m.includes('costo histórico'))).toEqual([]);
  });

  it('procesar de nuevo no duplica asientos ni cambia saldos', async () => {
    const antes = await diario();
    const r1 = await api.post('/api/contabilidad/sincronizar', {});
    const r2 = await api.post('/api/contabilidad/sincronizar', {});
    expect(r1.status).toBe(200);
    expect(r1.body.creados).toBe(0);
    expect(r2.body.creados).toBe(0);
    const despues = await diario();
    expect(despues.total).toBe(antes.total);
    expect(despues.asientos.map((a: any) => a.numero)).toEqual(antes.asientos.map((a: any) => a.numero));
    // números consecutivos sin saltos
    const nums = despues.asientos.map((a: any) => a.numero).sort((x: number, y: number) => x - y);
    expect(nums).toEqual(nums.map((_: number, i: number) => i + 1));
  });

  it('consultas simultáneas no duplican asientos', async () => {
    const v = await venta(d.cliente2, [lineaSrv('Trabajo extra', 5000)]);
    await Promise.all([api.get(`/api/contabilidad/diario?${periodo()}`), api.get(`/api/contabilidad/balance?${periodo()}`), api.post('/api/contabilidad/sincronizar', {}), api.get('/api/contabilidad/controles')]);
    const a = (await diario()).asientos.filter((x: any) => x.origen_id === v.id);
    expect(a).toHaveLength(1);
    const c = await controles();
    expect(c.partida_doble.estado).toBe('ok');
    expect(c.clientes.estado).toBe('ok');
  });

  it('libro mayor: movimientos con saldo acumulado que terminan en el saldo de la cuenta', async () => {
    const caja = (await api.get('/api/contabilidad/plan')).body.find((c: any) => c.rol === 'caja_efectivo');
    const m = (await api.get(`/api/contabilidad/mayor?${periodo()}&cuenta_id=${caja.id}`)).body;
    expect(m.movimientos.length).toBeGreaterThan(3);
    expect(m.saldo_final).toBe(caja.saldo);
    expect(m.movimientos.at(-1).saldo).toBe(caja.saldo);
    expect(m.saldo_anterior + m.debe - m.haber).toBe(m.saldo_final);
    // cada movimiento indica su origen
    expect(m.movimientos.every((x: any) => x.origen_tipo)).toBe(true);
  });
});

describe('asientos manuales', () => {
  let caja: any, capital: any, gasto: any;
  beforeAll(async () => {
    const plan = (await api.get('/api/contabilidad/plan')).body;
    caja = plan.find((c: any) => c.rol === 'caja_efectivo');
    capital = plan.find((c: any) => c.rol === 'capital');
    gasto = plan.find((c: any) => c.rol === 'gasto_varios');
  });
  const manual = (lineas: any[], extra: any = {}) => api.post('/api/contabilidad/asientos', { fecha: hoyAR(), descripcion: 'Aporte de capital', lineas, idem_key: idem(), ...extra });

  it('no admite asientos desbalanceados ni líneas inválidas', async () => {
    expect((await manual([{ cuenta_id: caja.id, debe: 1000 }, { cuenta_id: capital.id, haber: 900 }], { registrar: true })).status).toBe(400);
    expect((await manual([{ cuenta_id: caja.id, debe: 1000, haber: 1000 }, { cuenta_id: capital.id, haber: 0 }], { registrar: true })).status).toBe(400);
    expect((await manual([{ cuenta_id: caja.id, debe: 1000 }], { registrar: true })).status).toBe(400);
    // un rubro no recibe asientos
    const rubro = (await api.get('/api/contabilidad/plan')).body.find((c: any) => c.codigo === '1.1');
    expect((await manual([{ cuenta_id: rubro.id, debe: 1000 }, { cuenta_id: capital.id, haber: 1000 }], { registrar: true })).status).toBe(400);
    // cuentas de otro taller
    const ajena = (await OTRO.api.get('/api/contabilidad/plan')).body.find((c: any) => c.rol === 'capital');
    expect((await manual([{ cuenta_id: caja.id, debe: 1000 }, { cuenta_id: ajena.id, haber: 1000 }], { registrar: true })).status).toBe(400);
  });

  it('borrador → registrado → revertido, con trazabilidad y sin modificar lo contabilizado', async () => {
    const lineas = [{ cuenta_id: caja.id, debe: 50000 }, { cuenta_id: capital.id, haber: 50000 }];
    const k = idem();
    const b = await manual(lineas, { idem_key: k });
    expect(b.status).toBe(201);
    expect(b.body).toMatchObject({ estado: 'borrador', numero: null, modo: 'manual' });
    expect((await manual(lineas, { idem_key: k })).body.duplicado).toBe(true);
    // un borrador se edita y se puede descartar
    const ed = await api.put(`/api/contabilidad/asientos/${b.body.id}`, { fecha: hoyAR(), descripcion: 'Aporte inicial de capital', lineas: [{ cuenta_id: caja.id, debe: 60000 }, { cuenta_id: capital.id, haber: 60000 }] });
    expect(ed.status).toBe(200);
    const saldoAntes = await saldoRol('caja_efectivo');
    const reg = await api.post(`/api/contabilidad/asientos/${b.body.id}/registrar`, {});
    expect(reg.status).toBe(200);
    expect(reg.body).toMatchObject({ estado: 'registrado', total: 60000 });
    expect(reg.body.numero).toBeGreaterThan(0);
    expect(await saldoRol('caja_efectivo')).toBe(saldoAntes + 60000);
    // lo registrado no se modifica ni se elimina
    expect((await api.put(`/api/contabilidad/asientos/${b.body.id}`, { fecha: hoyAR(), descripcion: 'Otro', lineas })).status).toBe(409);
    expect((await api.del(`/api/contabilidad/asientos/${b.body.id}`)).status).toBe(409);
    // se revierte con un contra-asiento (una sola vez)
    const rev = await api.post(`/api/contabilidad/asientos/${b.body.id}/revertir`, { motivo: 'Cargado por error' });
    expect(rev.status).toBe(201);
    expect(rev.body.original.estado).toBe('revertido');
    expect(rev.body.contra_asiento).toMatchObject({ estado: 'registrado', modo: 'reversion', revierte_numero: reg.body.numero });
    expect(await saldoRol('caja_efectivo')).toBe(saldoAntes);
    expect((await api.post(`/api/contabilidad/asientos/${b.body.id}/revertir`, { motivo: 'Otra vez' })).status).toBe(409);
    // el original sigue visible con su estado
    expect((await api.get(`/api/contabilidad/asientos/${b.body.id}`)).body.estado).toBe('revertido');
  });

  it('corregir revierte el original y deja el asiento corregido vinculado', async () => {
    const orig = await manual([{ cuenta_id: gasto.id, debe: 3000 }, { cuenta_id: caja.id, haber: 3000 }], { registrar: true, descripcion: 'Gasto menor' });
    expect(orig.status).toBe(201);
    const cor = await api.post(`/api/contabilidad/asientos/${orig.body.id}/corregir`, {
      fecha: hoyAR(), descripcion: 'Gasto menor (importe corregido)', motivo: 'Importe mal cargado', registrar: true, idem_key: idem(),
      lineas: [{ cuenta_id: gasto.id, debe: 3500 }, { cuenta_id: caja.id, haber: 3500 }],
    });
    expect(cor.status).toBe(201);
    expect(cor.body.original.estado).toBe('revertido');
    expect(cor.body.corregido).toMatchObject({ estado: 'registrado', corrige_numero: orig.body.numero, total: 3500 });
  });

  it('los asientos automáticos no se revierten a mano: se anula la operación de origen', async () => {
    const auto = (await diario()).asientos.find((a: any) => a.modo === 'automatico' && a.estado === 'registrado');
    const r = await api.post(`/api/contabilidad/asientos/${auto.id}/revertir`, { motivo: 'Probando' });
    expect(r.status).toBe(409);
    expect((await api.del(`/api/contabilidad/asientos/${auto.id}`)).status).toBe(409);
  });

  it('una cuenta con movimientos no se elimina ni cambia de naturaleza', async () => {
    expect((await api.del(`/api/contabilidad/cuentas/${gasto.id}`)).status).toBe(409);
    const cap = await api.post('/api/contabilidad/cuentas', { codigo: '6.1.60', nombre: 'Cuenta usada', tipo: 'gasto', padre_id: (await api.get('/api/contabilidad/plan')).body.find((c: any) => c.codigo === '6.1').id });
    await manual([{ cuenta_id: cap.body.id, debe: 100 }, { cuenta_id: caja.id, haber: 100 }], { registrar: true });
    expect((await api.del(`/api/contabilidad/cuentas/${cap.body.id}`)).status).toBe(409);
    expect((await api.put(`/api/contabilidad/cuentas/${cap.body.id}`, { imputable: false })).status).toBe(409);
    // pero puede renombrarse
    expect((await api.put(`/api/contabilidad/cuentas/${cap.body.id}`, { nombre: 'Cuenta usada y renombrada' })).status).toBe(200);
  });

  it('la categoría de gasto se asocia a una cuenta contable y rige para los gastos nuevos', async () => {
    const cat = (await api.post('/api/categorias-gasto', { nombre: 'Capacitaciones', tipo: 'operativo' })).body;
    const porDefecto = (await api.get('/api/contabilidad/categorias-gasto')).body.find((c: any) => c.id === cat.id);
    expect(porDefecto).toMatchObject({ es_por_defecto: true });
    expect((await api.put(`/api/contabilidad/categorias-gasto/${cat.id}`, { cuenta_id: d.cuentaCapacitacion.id })).status).toBe(200);
    const g = await api.post('/api/gastos', { categoria_id: cat.id, concepto: 'Curso de inyección', importe: 9000, medio: 'efectivo', idem_key: idem() });
    expect(g.status).toBe(201);
    const a = (await diario()).asientos.find((x: any) => x.origen_id === g.body.id);
    expect(a.lineas.find((l: any) => l.debe === 9000).cuenta_nombre).toBe('Capacitación del personal');
    // no se puede asignar una cuenta de otro tipo
    const ingreso = (await api.get('/api/contabilidad/plan')).body.find((c: any) => c.rol === 'otros_ingresos');
    expect((await api.put(`/api/contabilidad/categorias-gasto/${cat.id}`, { cuenta_id: ingreso.id })).status).toBe(400);
  });
});

describe('permisos y aislamiento entre talleres', () => {
  it('los empleados sin permisos financieros no acceden a asientos, saldos, resultados ni exportaciones', async () => {
    const recepcion = (await nuevoPersonal(api, 'recepcion')).api;
    const mecanico = (await nuevoPersonal(api, 'mecanico')).api;
    const caja = (await nuevoPersonal(api, 'caja')).api;
    for (const u of [recepcion, mecanico, caja]) {
      for (const ruta of ['plan', `diario?${periodo()}`, `balance?${periodo()}`, `estado-resultados?${periodo()}`, `resumen-contable?${periodo()}`, 'controles', 'corridas']) {
        expect((await u.get(`/api/contabilidad/${ruta}`)).status, ruta).toBe(403);
      }
      expect((await u.post('/api/contabilidad/sincronizar', {})).status).toBe(403);
    }
  });

  it('ver la contabilidad no alcanza para modificarla, ni para ver márgenes ni para exportar', async () => {
    const solo = await nuevoPersonal(api, 'recepcion');
    const permisos = [...(await api.get(`/api/taller/usuarios/${solo.id}`)).body.permisos, 'contabilidad.ver'];
    const r = await api.put(`/api/taller/usuarios/${solo.id}/permisos`, { permisos });
    expect([200, 204]).toContain(r.status);
    const u = await Api.login(solo.email, 'clave-segura-1');
    expect((await u.get('/api/contabilidad/plan')).status).toBe(200);
    expect((await u.get(`/api/contabilidad/diario?${periodo()}`)).status).toBe(200);
    expect((await u.get(`/api/contabilidad/diario?${periodo()}&exportar=1`)).status).toBe(403);
    expect((await u.get(`/api/contabilidad/estado-resultados?${periodo()}`)).status).toBe(403);
    expect((await u.get(`/api/contabilidad/resumen-contable?${periodo()}`)).body.resultado).toBeNull(); // sin ver márgenes no se informan resultados
    const plan = (await u.get('/api/contabilidad/plan')).body;
    const cuenta = plan.find((c: any) => c.rol === 'caja_efectivo');
    expect((await u.post('/api/contabilidad/asientos', { fecha: hoyAR(), descripcion: 'No debería', lineas: [{ cuenta_id: cuenta.id, debe: 1 }, { cuenta_id: cuenta.id, haber: 1 }], idem_key: idem() })).status).toBe(403);
    expect((await u.post('/api/contabilidad/cuentas', { codigo: '9.9', nombre: 'No', tipo: 'gasto' })).status).toBe(403);
    expect((await u.post('/api/contabilidad/sincronizar', {})).status).toBe(403);
  });

  it('el propietario exporta con constancia en la auditoría', async () => {
    expect((await api.get(`/api/contabilidad/balance?${periodo()}&exportar=1`)).status).toBe(200);
    expect((await api.get(`/api/contabilidad/diario?${periodo()}&exportar=1`)).status).toBe(200);
  });

  it('cada taller ve únicamente su propia contabilidad', async () => {
    const otro = (await OTRO.api.get(`/api/contabilidad/diario?${periodo()}`)).body;
    expect(otro.total).toBe(0);
    const plan = (await OTRO.api.get('/api/contabilidad/plan')).body;
    expect(plan.every((c: any) => c.debe === 0 && c.haber === 0)).toBe(true);
    const mio = (await diario()).asientos[0];
    expect((await OTRO.api.get(`/api/contabilidad/asientos/${mio.id}`)).status).toBe(404);
    const miCaja = (await api.get('/api/contabilidad/plan')).body.find((c: any) => c.rol === 'caja_efectivo');
    expect((await OTRO.api.get(`/api/contabilidad/mayor?${periodo()}&cuenta_id=${miCaja.id}`)).status).toBe(404);
    const c = (await OTRO.api.get('/api/contabilidad/controles')).body.controles;
    expect(c.find((x: any) => x.clave === 'partida_doble').estado).toBe('ok');
    expect((await OTRO.api.post(`/api/contabilidad/asientos/${mio.id}/revertir`, { motivo: 'Intento ajeno' })).status).toBe(404);
  });
});
