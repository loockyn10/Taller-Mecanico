// Bancos, cheques y tesorería: cobro → banco, cobro → caja, transferencias, cheque recibido → depósito, conciliación,
// que nada se cuente dos veces y que un taller no vea ni use las cuentas de otro.
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, hoyAR, idem, nuevoTaller, nuevoUsuario, ventaConSaldo } from './cliente';

let api: Api; // propietario
let adm: Api; // administrador
let emp: Api; // empleado
let cliente: any;
let galicia: any;
let santander: any;
let B: Awaited<ReturnType<typeof nuevoTaller>>;
const ctx: Record<string, any> = {};

const hoy = hoyAR();
const periodo = `desde=${hoy}&hasta=${hoy}`;
const tesoreria = async () => (await api.get(`/api/tesoreria/resumen?${periodo}`)).body;
const movsBanco = async (cuenta: any, q = '') => (await api.get(`/api/bancos/movimientos?cuenta_id=${cuenta.id}${q}`)).body as any[];
const cuentaFresca = async (c: any) => (await api.get(`/api/bancos/cuentas/${c.id}`)).body;
const cobrar = (a: Api, venta: any, importe: number, medio: string, extra: Record<string, unknown> = {}, key = idem()) =>
  a.post('/api/cobros', { cliente_id: cliente.id, medios: [{ medio, importe, ...extra }], aplicaciones: [{ venta_id: venta.id, importe }], idem_key: key });

beforeAll(async () => {
  ({ api } = await nuevoTaller('Taller Bancos', 3));
  adm = await nuevoUsuario(api, 'administrador');
  emp = await nuevoUsuario(api, 'empleado');
  B = await nuevoTaller('Taller Bancos B');
  cliente = (await api.post('/api/clientes', { nombre: 'Cliente Bancos' })).body;
  galicia = (await api.post('/api/bancos/cuentas', { nombre: 'Galicia CC', banco: 'Banco Galicia', saldo_inicial: 100000, alias: 'taller.galicia' })).body;
  santander = (await api.post('/api/bancos/cuentas', { nombre: 'Santander CA', banco: 'Santander', tipo: 'caja_ahorro', saldo_inicial: 0 })).body;
});

describe('cuentas bancarias', () => {
  it('se crean con saldo inicial, validan datos y respetan permisos', async () => {
    expect(galicia.id).toBeTruthy();
    expect(await cuentaFresca(galicia)).toMatchObject({ banco: 'Banco Galicia', moneda: 'ARS', saldo_inicial: 100000, saldo: 100000, activa: 1 });
    expect((await api.post('/api/bancos/cuentas', { nombre: 'Galicia CC', banco: 'Banco X', saldo_inicial: 0 })).status).toBe(409); // nombre duplicado
    expect((await api.post('/api/bancos/cuentas', { nombre: 'Mala', banco: 'Banco', cbu: '123' })).status).toBe(400);
    expect((await api.post('/api/bancos/cuentas', { nombre: 'CUIT mal', banco: 'Banco', cuit_titular: '20-12345678-0' })).status).toBe(400);
    expect((await emp.get('/api/bancos/cuentas')).status).toBe(403);
    expect((await emp.get('/api/tesoreria/resumen?' + periodo)).status).toBe(403);
    expect((await emp.get('/api/cheques')).status).toBe(403);
    // El empleado sólo ve un selector sin saldos (para poder cobrar)
    const sel = (await emp.get('/api/bancos/selector')).body;
    expect(sel.map((x: any) => x.nombre).sort()).toEqual(['Galicia CC', 'Santander CA']);
    expect(sel[0].saldo).toBeUndefined();
  });

  it('con movimientos ya no se puede cambiar el saldo inicial', async () => {
    ctx.cuentaTmp = (await api.post('/api/bancos/cuentas', { nombre: 'Temporal', banco: 'Banco', saldo_inicial: 500 })).body;
    expect((await api.put(`/api/bancos/cuentas/${ctx.cuentaTmp.id}`, { saldo_inicial: 900 })).status).toBe(200);
    await api.post('/api/bancos/movimientos', { cuenta_id: ctx.cuentaTmp.id, tipo: 'ingreso', importe: 100, concepto: 'Interés', idem_key: idem() });
    expect((await api.put(`/api/bancos/cuentas/${ctx.cuentaTmp.id}`, { saldo_inicial: 1 })).status).toBe(409);
  });
});

describe('cobro → banco y cobro → caja (sin duplicar)', () => {
  it('un cobro por transferencia a una cuenta genera UN movimiento bancario, UN ingreso de caja y un reintento no duplica nada', async () => {
    ctx.venta = await ventaConSaldo(api, cliente.id, 200000);
    const key = idem();
    const antes = await tesoreria();
    const r1 = await cobrar(api, ctx.venta, 50000, 'transferencia', { cuenta_id: galicia.id, referencia: 'OP-1' }, key);
    const r2 = await cobrar(api, ctx.venta, 50000, 'transferencia', { cuenta_id: galicia.id, referencia: 'OP-1' }, key);
    expect(r1.status).toBe(201);
    expect(r2.body.duplicado).toBe(true);
    ctx.cobro = r1.body;
    const mb = (await movsBanco(galicia)).filter((m) => m.categoria === 'cobro');
    expect(mb).toHaveLength(1);
    expect(mb[0]).toMatchObject({ tipo: 'ingreso', importe: 50000, origen_tipo: 'cobro_medio', afecta_resultado: 0, conciliado: 0, ref_tipo: 'cobro', ref_id: r1.body.id });
    expect((await cuentaFresca(galicia)).saldo).toBe(150000);
    // caja: sigue habiendo un único ingreso, en el libro comercial
    const caja = (await api.get(`/api/caja/movimientos?${periodo}`)).body.filter((m: any) => m.rubro === 'cobro');
    expect(caja).toHaveLength(1);
    // tesorería: el cobro cuenta UNA vez como ingreso (no suma de nuevo por el espejo bancario) y el banco refleja la plata
    const t = await tesoreria();
    expect(t.periodo.ingresos.total - antes.periodo.ingresos.total).toBe(50000);
    expect(t.bancos.total - antes.bancos.total).toBe(50000);
    expect(t.periodo.ingresos.bancarios).toBe(antes.periodo.ingresos.bancarios); // el espejo bancario del cobro no suma ingresos
  });

  it('un cobro en efectivo va sólo a la caja; una cuenta de otro taller o desactivada se rechaza', async () => {
    const antes = (await cuentaFresca(galicia)).saldo;
    expect((await cobrar(api, ctx.venta, 20000, 'efectivo')).status).toBe(201);
    expect((await cuentaFresca(galicia)).saldo).toBe(antes);
    expect((await cobrar(api, ctx.venta, 1000, 'efectivo', { cuenta_id: galicia.id })).status).toBe(400); // el efectivo no se acredita en un banco
    const ajena = (await B.api.post('/api/bancos/cuentas', { nombre: 'Ajena', banco: 'Banco' })).body;
    expect((await cobrar(api, ctx.venta, 1000, 'transferencia', { cuenta_id: ajena.id })).status).toBe(400);
    const baja = (await api.post('/api/bancos/cuentas', { nombre: 'Dada de baja', banco: 'Banco' })).body;
    await api.put(`/api/bancos/cuentas/${baja.id}`, { activa: false });
    expect((await cobrar(api, ctx.venta, 1000, 'transferencia', { cuenta_id: baja.id })).status).toBe(400);
    // el empleado puede cobrar acreditando en una cuenta (pero no ve el libro del banco)
    expect((await cobrar(emp, ctx.venta, 3000, 'transferencia', { cuenta_id: galicia.id })).status).toBe(201);
    expect((await emp.get(`/api/bancos/movimientos?cuenta_id=${galicia.id}`)).status).toBe(403);
  });

  it('al anular el cobro se revierte el movimiento bancario con un contra-asiento', async () => {
    const saldo = (await cuentaFresca(galicia)).saldo;
    const r = await api.post(`/api/cobros/${ctx.cobro.id}/anular`, { motivo: 'Error de carga' });
    expect(r.status).toBe(200);
    expect((await cuentaFresca(galicia)).saldo).toBe(saldo - 50000);
    const movs = await movsBanco(galicia);
    expect(movs.filter((m) => m.categoria === 'reverso')).toHaveLength(1);
    expect((await api.post(`/api/cobros/${ctx.cobro.id}/anular`, { motivo: 'otra vez' })).status).toBe(409);
    expect((await cuentaFresca(galicia)).saldo).toBe(saldo - 50000);
  });
});

describe('transferencias y efectivo entre caja y banco', () => {
  it('una transferencia entre cuentas propias mueve saldos pero no es ingreso ni egreso del negocio', async () => {
    const antes = await tesoreria();
    const key = idem();
    const body = { origen_id: galicia.id, destino_id: santander.id, importe: 30000, idem_key: key };
    const [a, b] = await Promise.all([api.post('/api/bancos/transferencias', body), api.post('/api/bancos/transferencias', body)]);
    expect([a.status, b.status].every((s) => s === 201 || s === 200 || s === 409), JSON.stringify([a.body, b.body])).toBe(true);
    const ids = new Set([a.body.id, b.body.id].filter(Boolean));
    expect(ids.size).toBe(1);
    ctx.transf = a.body.id ?? b.body.id;
    const t = await tesoreria();
    expect((await cuentaFresca(santander)).saldo).toBe(30000);
    expect(t.periodo.ingresos.total).toBe(antes.periodo.ingresos.total);
    expect(t.periodo.egresos.total).toBe(antes.periodo.egresos.total);
    expect(t.bancos.total).toBe(antes.bancos.total); // plata que cambia de cuenta: el total no se mueve
    expect(t.periodo.transferencias_internas.entre_cuentas).toBe(30000);
    expect((await api.post('/api/bancos/transferencias', { origen_id: galicia.id, destino_id: galicia.id, importe: 1, idem_key: idem() })).status).toBe(400);
    const usd = (await api.post('/api/bancos/cuentas', { nombre: 'Dólares', banco: 'Banco', moneda: 'USD', saldo_inicial: 1000 })).body;
    expect((await api.post('/api/bancos/transferencias', { origen_id: galicia.id, destino_id: usd.id, importe: 1, idem_key: idem() })).status).toBe(400);
  });

  it('se puede anular la transferencia completa (una sola vez)', async () => {
    const r = await api.post(`/api/bancos/transferencias/${ctx.transf}/anular`, { motivo: 'Cargada por error' });
    expect(r.status).toBe(200);
    expect((await cuentaFresca(santander)).saldo).toBe(0);
    expect((await api.post(`/api/bancos/transferencias/${ctx.transf}/anular`, { motivo: 'de nuevo' })).status).toBe(409);
  });

  it('depósito de efectivo: baja el efectivo de la caja, sube el banco y no cambia ingresos/egresos', async () => {
    await api.post('/api/caja/abrir', { saldo_inicial: 100000 });
    const antes = await tesoreria();
    const efAntes = (await api.get('/api/caja/estado')).body.sesion.resumen.efectivo_esperado;
    const key = idem();
    const d1 = await api.post('/api/bancos/depositos', { cuenta_id: santander.id, importe: 40000, idem_key: key });
    const d2 = await api.post('/api/bancos/depositos', { cuenta_id: santander.id, importe: 40000, idem_key: key });
    expect(d1.status).toBe(201);
    expect(d2.body.duplicado).toBe(true);
    ctx.deposito = d1.body.id;
    expect((await api.get('/api/caja/estado')).body.sesion.resumen.efectivo_esperado).toBe(efAntes - 40000);
    expect((await cuentaFresca(santander)).saldo).toBe(40000);
    const t = await tesoreria();
    expect(t.periodo.ingresos.total).toBe(antes.periodo.ingresos.total);
    expect(t.periodo.egresos.total).toBe(antes.periodo.egresos.total);
    expect(t.disponible).toBe(antes.disponible); // sólo cambia de lugar
    // finanzas (base caja) tampoco lo cuenta como egreso
    const fin = (await api.get(`/api/finanzas/resumen?${periodo}`)).body;
    expect(fin.egresos.total).toBe(antes.periodo.egresos.total);
    // no se puede depositar más efectivo del que hay
    expect((await api.post('/api/bancos/depositos', { cuenta_id: santander.id, importe: 99999999, idem_key: idem() })).status).toBe(409);
    // anular el depósito devuelve el efectivo a la caja
    expect((await api.post(`/api/bancos/movimientos/${ctx.deposito}/anular`, { motivo: 'Se depositó en otra sucursal' })).status).toBe(200);
    expect((await api.get('/api/caja/estado')).body.sesion.resumen.efectivo_esperado).toBe(efAntes);
    expect((await cuentaFresca(santander)).saldo).toBe(0);
  });

  it('extracción: sube el efectivo de la caja y baja el banco', async () => {
    const efAntes = (await api.get('/api/caja/estado')).body.sesion.resumen.efectivo_esperado;
    expect((await api.post('/api/bancos/extracciones', { cuenta_id: galicia.id, importe: 10000, idem_key: idem() })).status).toBe(201);
    expect((await api.get('/api/caja/estado')).body.sesion.resumen.efectivo_esperado).toBe(efAntes + 10000);
  });

  it('movimientos manuales sí son resultado; los ajustes sólo los hace el propietario', async () => {
    const antes = await tesoreria();
    expect((await adm.post('/api/bancos/movimientos', { cuenta_id: galicia.id, tipo: 'egreso', importe: 2500, concepto: 'Comisión mantenimiento', idem_key: idem() })).status).toBe(201);
    const t = await tesoreria();
    expect(t.periodo.egresos.bancarios - antes.periodo.egresos.bancarios).toBe(2500);
    expect(t.periodo.resultado).toBe(antes.periodo.resultado - 2500);
    expect((await adm.post('/api/bancos/ajustes', { cuenta_id: galicia.id, tipo: 'ingreso', importe: 100, motivo: 'Diferencia con el extracto', idem_key: idem() })).status).toBe(403);
    expect((await api.post('/api/bancos/ajustes', { cuenta_id: galicia.id, tipo: 'ingreso', importe: 100, motivo: 'corto', idem_key: idem() })).status).toBe(400);
    const aj = await api.post('/api/bancos/ajustes', { cuenta_id: galicia.id, tipo: 'ingreso', importe: 100, motivo: 'Diferencia con el extracto', idem_key: idem() });
    expect(aj.status).toBe(201);
    expect((await tesoreria()).periodo.resultado).toBe(t.periodo.resultado); // el ajuste no es resultado
  });
});

describe('cheque recibido → depósito → acreditación', () => {
  it('un cobro con cheque lo deja en cartera con sus datos; el mismo cheque no se registra dos veces', async () => {
    const v = await ventaConSaldo(api, cliente.id, 80000);
    ctx.ventaCheque = v;
    const r = await cobrar(api, v, 80000, 'cheque', { referencia: '00112233', cheque: { banco: 'Banco Nación', librador: 'Juan Pérez', cuit: '20-12345678-6', fecha_pago: hoy } });
    expect(r.status).toBe(201);
    ctx.cobroCheque = r.body;
    const lista = (await api.get('/api/cheques?direccion=recibido')).body;
    const ch = lista.find((c: any) => c.nro_cheque === '00112233');
    expect(ch).toMatchObject({ estado: 'en_cartera', importe: 80000, banco: 'Banco Nación', cliente: 'Cliente Bancos', origen_tipo: 'cobro_medio', modalidad: 'fisico' });
    ctx.cheque = ch;
    // otro cobro con el mismo cheque (banco+número+librador) → 409
    const v2 = await ventaConSaldo(api, cliente.id, 1000);
    const dup = await cobrar(api, v2, 1000, 'cheque', { referencia: '00112233', cheque: { banco: 'banco nación', cuit: '20-12345678-6' } });
    expect(dup.status).toBe(409);
    // el rechazo del cobro duplicado no dejó medios sueltos
    expect((await api.get(`/api/ventas/${v2.id}`)).body.cobrado).toBe(0);
  });

  it('el cheque exige fecha de pago cumplida para depositar, y valida la cuenta', async () => {
    const futuro = (await api.post('/api/cheques', { direccion: 'recibido', banco: 'Banco Provincia', nro_cheque: '777', importe: 5000, fecha_emision: hoy, fecha_pago: hoyAR(10), librador: 'Cliente X', cliente_id: cliente.id })).body;
    expect((await api.post(`/api/cheques/${futuro.id}/depositar`, { cuenta_id: galicia.id })).status).toBe(409);
    expect((await api.post(`/api/cheques/${ctx.cheque.id}/depositar`, { cuenta_id: 'inexistente' })).status).toBe(400);
    ctx.chequeFuturo = futuro;
  });

  it('depositar y acreditar mueve plata de la cartera al banco SIN contarla otra vez como ingreso', async () => {
    const antes = await tesoreria();
    const saldo = (await cuentaFresca(galicia)).saldo;
    expect((await api.post(`/api/cheques/${ctx.cheque.id}/depositar`, { cuenta_id: galicia.id })).status).toBe(200);
    expect((await api.post(`/api/cheques/${ctx.cheque.id}/depositar`, { cuenta_id: galicia.id })).status).toBe(409); // ya depositado
    // con el cheque depositado no se puede anular el cobro
    expect((await api.post(`/api/cobros/${ctx.cobroCheque.id}/anular`, { motivo: 'prueba' })).status).toBe(409);
    expect((await api.post(`/api/cheques/${ctx.cheque.id}/acreditar`, {})).status).toBe(200);
    const t = await tesoreria();
    expect((await cuentaFresca(galicia)).saldo).toBe(saldo + 80000);
    expect(t.periodo.ingresos.total).toBe(antes.periodo.ingresos.total);
    expect(t.cheques.en_cartera).toBe(antes.cheques.en_cartera - 80000);
    const mov = (await movsBanco(galicia)).find((m) => m.categoria === 'cheque');
    expect(mov).toMatchObject({ tipo: 'ingreso', importe: 80000, afecta_resultado: 0, origen_tipo: 'cheque' });
    const det = (await api.get(`/api/cheques/${ctx.cheque.id}`)).body;
    expect(det.estado).toBe('acreditado');
    expect(det.eventos.map((e: any) => e.estado_hacia)).toEqual(['en_cartera', 'depositado', 'acreditado']);
  });

  it('un cheque acreditado que el banco rechaza revierte el ingreso bancario y permite anular el cobro', async () => {
    const saldo = (await cuentaFresca(galicia)).saldo;
    const r = await api.post(`/api/cheques/${ctx.cheque.id}/rechazar`, { motivo: 'Sin fondos', comision: 1500 });
    expect(r.status).toBe(200);
    expect(r.body.aviso).toMatch(/cobro/i);
    expect((await cuentaFresca(galicia)).saldo).toBe(saldo - 80000 - 1500);
    expect((await api.get(`/api/cheques/${ctx.cheque.id}`)).body).toMatchObject({ estado: 'rechazado', motivo_rechazo: 'Sin fondos' });
    expect((await api.post(`/api/cobros/${ctx.cobroCheque.id}/anular`, { motivo: 'Cheque rechazado' })).status).toBe(200);
    expect((await api.get(`/api/ventas/${ctx.ventaCheque.id}`)).body.cobrado).toBe(0);
    expect((await api.get(`/api/cheques/${ctx.cheque.id}`)).body.estado).toBe('rechazado'); // el historial no se pisa
  });

  it('un cheque cargado a mano no pasó por la caja: su acreditación sí es un ingreso', async () => {
    const antes = await tesoreria();
    const m = (await api.post('/api/cheques', { direccion: 'recibido', banco: 'Banco Macro', nro_cheque: '9001', importe: 12000, fecha_emision: hoyAR(-5), fecha_pago: hoyAR(-1), librador: 'Taller Vecino' })).body;
    expect(m.estado).toBe('en_cartera');
    await api.post(`/api/cheques/${m.id}/depositar`, { cuenta_id: galicia.id });
    await api.post(`/api/cheques/${m.id}/acreditar`, {});
    const t = await tesoreria();
    expect(t.periodo.ingresos.bancarios - antes.periodo.ingresos.bancarios).toBe(12000);
    expect((await api.post(`/api/cheques/${m.id}/anular`, { motivo: 'prueba' })).status).toBe(409); // ya acreditado
  });

  it('resumen: totales por estado, próximos a vencer y vencidos; eCheq exige ID; filtros', async () => {
    expect((await api.post('/api/cheques', { direccion: 'recibido', modalidad: 'echeq', banco: 'Banco BBVA', nro_cheque: '5555', importe: 7000, fecha_emision: hoy, fecha_pago: hoy })).status).toBe(400);
    const e = await api.post('/api/cheques', { direccion: 'recibido', modalidad: 'echeq', echeq_id: 'ECHEQ-77', banco: 'Banco BBVA', nro_cheque: '5555', importe: 7000, fecha_emision: hoy, fecha_pago: hoy });
    expect(e.status).toBe(201);
    const viejo = await api.post('/api/cheques', { direccion: 'recibido', banco: 'Banco Ciudad', nro_cheque: '1', importe: 3000, fecha_emision: hoyAR(-90), fecha_pago: hoyAR(-60) });
    expect(viejo.status).toBe(201);
    const res = (await api.get('/api/cheques/resumen')).body;
    expect(res.cartera).toBeGreaterThanOrEqual(7000 + 3000);
    expect(res.vencidos.map((c: any) => c.nro_cheque)).toContain('1');
    expect(res.proximos.map((c: any) => c.nro_cheque)).toContain('5555');
    expect((await api.get('/api/cheques?modalidad=echeq')).body.every((c: any) => c.modalidad === 'echeq')).toBe(true);
    expect((await api.get('/api/cheques?q=ECHEQ-77')).body).toHaveLength(1);
    expect((await api.get('/api/cheques?estado=rechazado')).body.length).toBeGreaterThanOrEqual(1);
    // un cheque vencido pide confirmación para depositarse
    expect((await api.post(`/api/cheques/${viejo.body.id}/depositar`, { cuenta_id: galicia.id })).status).toBe(409);
    expect((await api.post(`/api/cheques/${viejo.body.id}/depositar`, { cuenta_id: galicia.id, confirmar_vencido: true })).status).toBe(200);
  });
});

describe('conciliación bancaria manual', () => {
  it('concilia movimientos contra el extracto, informa la diferencia y se puede deshacer', async () => {
    const c = (await api.get(`/api/bancos/conciliacion/${santander.id}`)).body;
    expect(c.pendientes.length).toBeGreaterThan(0); // transferencia, depósito y sus anulaciones
    const ids = c.pendientes.map((m: any) => m.id);
    const saldoLibros = c.cuenta.saldo; // 0: todo se anuló
    const r = await api.post('/api/bancos/conciliaciones', { cuenta_id: santander.id, fecha_corte: hoy, saldo_extracto: saldoLibros + 700, movimiento_ids: ids, notas: 'Extracto de octubre' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ saldo_libros: saldoLibros, saldo_extracto: saldoLibros + 700, diferencia: 700, cantidad: ids.length, estado: 'vigente' });
    // los conciliados no se vuelven a conciliar ni se pueden anular
    expect((await api.post('/api/bancos/conciliaciones', { cuenta_id: santander.id, fecha_corte: hoy, saldo_extracto: 0, movimiento_ids: [ids[0]] })).status).toBe(409);
    expect((await movsBanco(santander, '&conciliado=1')).length).toBe(ids.length);
    expect((await api.get(`/api/bancos/conciliacion/${santander.id}`)).body.pendientes).toHaveLength(0);
    // el historial lo muestra con su detalle
    const hist = (await api.get(`/api/bancos/conciliaciones?cuenta_id=${santander.id}`)).body;
    expect(hist).toHaveLength(1);
    expect((await api.get(`/api/bancos/conciliaciones/${r.body.id}`)).body.movimientos).toHaveLength(ids.length);
    expect((await api.post(`/api/bancos/conciliaciones/${r.body.id}/deshacer`, {})).status).toBe(200);
    expect((await api.post(`/api/bancos/conciliaciones/${r.body.id}/deshacer`, {})).status).toBe(409);
    expect((await api.get(`/api/bancos/conciliacion/${santander.id}`)).body.pendientes).toHaveLength(ids.length);
  });

  it('no concilia movimientos de otra cuenta ni posteriores a la fecha de corte', async () => {
    const g = (await movsBanco(galicia))[0];
    expect((await api.post('/api/bancos/conciliaciones', { cuenta_id: santander.id, fecha_corte: hoy, saldo_extracto: 0, movimiento_ids: [g.id] })).status).toBe(400);
    expect((await api.post('/api/bancos/conciliaciones', { cuenta_id: galicia.id, fecha_corte: hoyAR(-3), saldo_extracto: 0, movimiento_ids: [g.id] })).status).toBe(400);
  });
});

describe('tesorería general', () => {
  it('centraliza efectivo, bancos, cheques, cuentas por cobrar y por pagar', async () => {
    const prov = (await api.post('/api/proveedores', { nombre: 'Proveedor Tesorería' })).body;
    const art = (await api.post('/api/articulos', { nombre: 'Artículo T', costo: 1000 })).body;
    await api.post('/api/compras', { proveedor_id: prov.id, items: [{ articulo_id: art.id, cantidad: 10, costo_unitario: 1000 }], idem_key: idem() });
    const t = await tesoreria();
    expect(t.efectivo.caja_abierta).toBe(true);
    expect(t.efectivo.saldo).toBe((await api.get('/api/caja/estado')).body.sesion.resumen.efectivo_esperado);
    expect(t.cuentas_por_pagar.total).toBe(10000);
    expect(t.cuentas_por_cobrar.total).toBe((await api.get('/api/finanzas/resumen?' + periodo)).body.devengado.por_cobrar);
    expect(t.bancos.cuentas.find((c: any) => c.id === galicia.id).saldo).toBe((await cuentaFresca(galicia)).saldo);
    expect(t.disponible).toBe(t.efectivo.saldo + t.bancos.total);
    expect(t.bancos.otras_monedas).toEqual([{ moneda: 'USD', total: 1000 }]);
    // pago al proveedor por transferencia desde el banco: baja el banco y la deuda, y es un egreso una sola vez
    const antes = await tesoreria();
    const p = await api.post('/api/pagos-proveedor', { proveedor_id: prov.id, importe: 4000, medio: 'transferencia', cuenta_id: galicia.id, idem_key: idem() });
    expect(p.status).toBe(201);
    const d = await tesoreria();
    expect(d.bancos.total).toBe(antes.bancos.total - 4000);
    expect(d.cuentas_por_pagar.total).toBe(6000);
    expect(d.periodo.egresos.total - antes.periodo.egresos.total).toBe(4000);
    // anular el pago devuelve la plata al banco y la deuda
    await api.post(`/api/pagos-proveedor/${p.body.id}/anular`, { motivo: 'Error' });
    const e = await tesoreria();
    expect(e.bancos.total).toBe(antes.bancos.total);
    expect(e.cuentas_por_pagar.total).toBe(10000);
    expect(e.periodo.egresos.total).toBe(antes.periodo.egresos.total);
  });
});

describe('aislamiento entre talleres (bancos y cheques)', () => {
  it('otro taller no ve, usa ni modifica cuentas, movimientos, cheques ni conciliaciones', async () => {
    expect((await B.api.get('/api/bancos/cuentas')).body.map((c: any) => c.nombre)).toEqual(['Ajena']); // sólo la propia
    expect((await B.api.get(`/api/bancos/cuentas/${galicia.id}`)).status).toBe(404);
    expect((await B.api.put(`/api/bancos/cuentas/${galicia.id}`, { nombre: 'Hackeada' })).status).toBe(404);
    expect((await B.api.get(`/api/bancos/conciliacion/${galicia.id}`)).status).toBe(404);
    expect((await B.api.get('/api/cheques')).body).toEqual([]);
    expect((await B.api.get(`/api/cheques/${ctx.cheque.id}`)).status).toBe(404);
    expect((await B.api.post(`/api/cheques/${ctx.chequeFuturo.id}/depositar`, { cuenta_id: galicia.id })).status).toBe(404);
    expect((await B.api.post('/api/bancos/movimientos', { cuenta_id: galicia.id, tipo: 'ingreso', importe: 1, concepto: 'intruso', idem_key: idem() })).status).toBe(400);
    expect((await B.api.post('/api/bancos/transferencias', { origen_id: galicia.id, destino_id: santander.id, importe: 1, idem_key: idem() })).status).toBe(400);
    expect((await B.api.get(`/api/bancos/movimientos?cuenta_id=${galicia.id}`)).body).toEqual([]);
    const tb = (await B.api.get(`/api/tesoreria/resumen?${periodo}`)).body;
    expect(tb.bancos.cuentas.map((c: any) => c.nombre)).toEqual(['Ajena']);
    expect(tb.disponible).toBe(0);
    expect((await B.api.post(`/api/bancos/transferencias/${ctx.transf}/anular`, { motivo: 'intento' })).status).toBe(404);
    expect((await api.get(`/api/bancos/cuentas/${galicia.id}`)).body.nombre).toBe('Galicia CC');
  });
});
