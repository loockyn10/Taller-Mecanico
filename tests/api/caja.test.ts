// Caja diaria: apertura, movimientos, integración con cobros/gastos, arqueo, cierre, permisos y concurrencia.
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, hoyAR, idem, nuevoTaller, nuevoUsuario, ventaConSaldo } from './cliente';

let api: Api; // propietario
let emp: Api; // empleado
let cliente: any;
const ctx: Record<string, any> = {};

const movs = async (a: Api, q = '') => (await a.get(`/api/caja/movimientos?desde=${hoyAR()}&hasta=${hoyAR()}${q}`)).body as any[];
const estado = async (a: Api = api) => (await a.get('/api/caja/estado')).body;
const cobrar = (a: Api, venta: any, importe: number, medio = 'efectivo', key = idem()) =>
  a.post('/api/cobros', { cliente_id: cliente.id, medios: [{ medio, importe }], aplicaciones: [{ venta_id: venta.id, importe }], idem_key: key });

beforeAll(async () => {
  ({ api } = await nuevoTaller('Taller Caja', 2));
  emp = await nuevoUsuario(api, 'empleado');
  cliente = (await api.post('/api/clientes', { nombre: 'Cliente Caja' })).body;
  ctx.venta = await ventaConSaldo(api, cliente.id, 200000); // $2.000
});

describe('caja diaria', () => {
  it('sin caja abierta (y sin ser obligatoria) el cobro se registra igual y queda en el libro sin sesión', async () => {
    expect((await estado()).sesion).toBeNull();
    const r = await cobrar(api, ctx.venta, 10000);
    expect(r.status).toBe(201);
    const m = (await movs(api)).filter((x) => x.concepto.startsWith(`Cobro #${r.body.numero}`));
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ tipo: 'ingreso', rubro: 'cobro', medio: 'efectivo', importe: 10000, sesion_id: null });
    expect((await estado()).sin_caja_hoy).toBe(1);
  });

  it('dos aperturas simultáneas: sólo una prospera', async () => {
    const [a, b] = await Promise.all([api.post('/api/caja/abrir', { saldo_inicial: 50000 }), emp.post('/api/caja/abrir', { saldo_inicial: 50000 })]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const e = await estado();
    expect(e.sesion.estado).toBe('abierta');
    expect(e.sesion.saldo_inicial).toBe(50000);
    expect((await api.post('/api/caja/abrir', { saldo_inicial: 0 })).status).toBe(409);
    ctx.sesionId = e.sesion.id;
  });

  it('cobros en efectivo y transferencia entran a la caja abierta y un reintento no duplica el movimiento', async () => {
    const key = idem();
    const r1 = await cobrar(api, ctx.venta, 20000, 'efectivo', key);
    const r2 = await cobrar(api, ctx.venta, 20000, 'efectivo', key); // reintento / doble clic
    expect(r1.status).toBe(201);
    expect(r2.body.duplicado).toBe(true);
    ctx.cobroEfectivo = r1.body;
    expect((await cobrar(api, ctx.venta, 10000, 'transferencia')).status).toBe(201);
    const delCobro = (await movs(api)).filter((x) => x.sesion_id === ctx.sesionId && x.rubro === 'cobro');
    expect(delCobro).toHaveLength(2); // exactamente uno por cobro/medio
    const r = (await estado()).sesion.resumen;
    expect(r.efectivo_esperado).toBe(50000 + 20000);
    expect(r.por_medio.find((m: any) => m.medio === 'transferencia').neto).toBe(10000);
  });

  it('venta de mostrador de contado: un único ingreso y la venta queda saldada', async () => {
    const antes = (await movs(api)).length;
    const v = await api.post('/api/ventas', { items: [{ tipo: 'libre', descripcion: 'Lavado', cantidad: 1, precio_unitario: 15000 }], cobro: { medio: 'efectivo' }, idem_key: idem() });
    expect(v.status).toBe(201);
    expect(v.body).toMatchObject({ cobrado: 15000, saldo: 0 });
    expect(await movs(api)).toHaveLength(antes + 1);
    expect((await estado()).sesion.resumen.efectivo_esperado).toBe(85000);
  });

  it('un gasto en efectivo sale de la caja; el reintento no lo duplica', async () => {
    const cats = (await api.get('/api/categorias-gasto')).body;
    expect(cats.length).toBeGreaterThan(5);
    const key = idem();
    const g = { categoria_id: cats[0].id, concepto: 'Compra de trapos', importe: 5000, medio: 'efectivo', idem_key: key };
    const r1 = await emp.post('/api/gastos', g); // el empleado puede registrar gastos desde caja
    const r2 = await emp.post('/api/gastos', g);
    expect(r1.status).toBe(201);
    expect(r2.body.duplicado).toBe(true);
    ctx.gasto = r1.body;
    expect((await movs(api)).filter((x) => x.rubro === 'gasto')).toHaveLength(1);
    expect((await estado()).sesion.resumen.efectivo_esperado).toBe(80000);
  });

  it('anular un cobro genera un contra-asiento (no borra) y la anulación doble se rechaza', async () => {
    const r = await api.post(`/api/cobros/${ctx.cobroEfectivo.id}/anular`, { motivo: 'error de carga' });
    expect(r.status).toBe(200);
    expect((await api.post(`/api/cobros/${ctx.cobroEfectivo.id}/anular`, { motivo: 'otra vez' })).status).toBe(409);
    const todos = await movs(api);
    const reversos = todos.filter((x) => x.origen_tipo === 'reverso');
    expect(reversos).toHaveLength(1);
    expect(reversos[0]).toMatchObject({ tipo: 'egreso', rubro: 'cobro', medio: 'efectivo', importe: 20000 });
    expect(todos.some((x) => x.origen_tipo === 'cobro' && x.importe === 20000)).toBe(true); // el original sigue en el libro
    expect((await estado()).sesion.resumen.efectivo_esperado).toBe(60000);
  });

  it('un empleado no anula gastos ni ve el historial y reportes, pero sí opera la caja abierta', async () => {
    expect((await emp.post(`/api/gastos/${ctx.gasto.id}/anular`, { motivo: 'prueba' })).status).toBe(403);
    expect((await emp.get('/api/caja/sesiones')).status).toBe(403);
    expect((await emp.get(`/api/caja/reportes?desde=${hoyAR()}&hasta=${hoyAR()}`)).status).toBe(403);
    expect((await emp.get('/api/finanzas/resumen?desde=2026-01-01&hasta=2026-12-31')).status).toBe(403);
    expect((await emp.get('/api/caja/estado')).status).toBe(200);
    expect((await emp.get('/api/caja/movimientos')).body.length).toBeGreaterThan(0); // sólo la caja abierta
    expect((await emp.post('/api/caja/movimientos', { medio: 'efectivo', importe: 1000, concepto: 'Sobrante de vuelto', idem_key: idem() })).status).toBe(201);
  });

  it('el ingreso manual puede anularse una vez (con permiso de gestión) y vuelve a cuadrar', async () => {
    const m = (await movs(api)).find((x) => x.concepto === 'Sobrante de vuelto');
    expect(m).toBeTruthy();
    expect((await estado()).sesion.resumen.efectivo_esperado).toBe(61000);
    expect((await emp.post(`/api/caja/movimientos/${m.id}/anular`, { motivo: 'error' })).status).toBe(403);
    expect((await api.post(`/api/caja/movimientos/${m.id}/anular`, { motivo: 'error' })).status).toBe(200);
    expect((await api.post(`/api/caja/movimientos/${m.id}/anular`, { motivo: 'error' })).status).toBe(409);
    expect((await estado()).sesion.resumen.efectivo_esperado).toBe(60000);
  });

  it('el arqueo parcial registra la diferencia sin cerrar la caja', async () => {
    const r = await emp.post('/api/caja/arqueos', { contado: 59000, detalle: { '1000': 59 } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ esperado: 60000, contado: 59000, diferencia: -1000 });
    expect((await estado()).sesion.estado).toBe('abierta');
  });

  it('el cierre exige justificar diferencias, detecta cambios mientras se contaba y registra esperado vs declarado', async () => {
    // Diferencia sin justificar
    expect((await api.post('/api/caja/cerrar', { declarados: [{ medio: 'efectivo', importe: 59000 }] })).status).toBe(400);
    // Falta el efectivo
    expect((await api.post('/api/caja/cerrar', { declarados: [{ medio: 'transferencia', importe: 10000 }] })).status).toBe(400);
    // Otro usuario registra un movimiento mientras se contaba: el esperado visto ya no es válido
    await emp.post('/api/caja/movimientos', { medio: 'efectivo', importe: 500, concepto: 'Propina para el taller', idem_key: idem() });
    const viejo = await api.post('/api/caja/cerrar', { declarados: [{ medio: 'efectivo', importe: 59000 }], esperado_visto: 60000, notas: 'faltan $10' });
    expect(viejo.status).toBe(409);
    expect(viejo.body.error.code).toBe('caja_cambio');
    expect((await estado()).sesion.estado).toBe('abierta');
    // Cierre correcto con el nuevo esperado (60500) y una diferencia justificada
    const ok = await api.post('/api/caja/cerrar', { declarados: [{ medio: 'efectivo', importe: 60000 }, { medio: 'transferencia', importe: 10000 }], esperado_visto: 60500, notas: 'faltan $5, vuelto mal dado' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ estado: 'cerrada', efectivo_esperado: 60500, efectivo_declarado: 60000, diferencia: -500 });
    expect(ok.body.cierre.find((c: any) => c.medio === 'efectivo')).toMatchObject({ esperado: 60500, declarado: 60000, diferencia: -500 });
    expect((await api.post('/api/caja/cerrar', { declarados: [{ medio: 'efectivo', importe: 0 }] })).status).toBe(409); // ya cerrada
    expect((await estado()).sesion).toBeNull();
  });

  it('historial y reportes de caja', async () => {
    const hist = (await api.get('/api/caja/sesiones')).body;
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ estado: 'cerrada', diferencia: -500 });
    expect((await api.get('/api/caja/sesiones?con_diferencia=1')).body).toHaveLength(1);
    const rep = (await api.get(`/api/caja/reportes?desde=${hoyAR()}&hasta=${hoyAR()}`)).body;
    expect(rep.diferencia_total).toBe(-500);
    expect(rep.sesiones).toHaveLength(1);
    expect(rep.por_medio.find((m: any) => m.medio === 'efectivo')).toBeTruthy();
    // Un empleado que participó puede ver el detalle de la caja que cerró otro? Sólo quien abrió/cerró o con finanzas.ver
    const det = await api.get(`/api/caja/sesiones/${hist[0].id}`);
    expect(det.body.resumen.movimientos).toBeGreaterThan(5);
    expect(det.body.arqueos).toHaveLength(1);
  });

  it('después del cierre una nueva apertura sugiere el saldo y los movimientos nuevos van a la nueva caja', async () => {
    const e = await estado();
    expect(e.ultima_cierre.efectivo_declarado).toBe(60000);
    expect((await api.post('/api/caja/abrir', { saldo_inicial: 60000 })).status).toBe(201);
    expect((await estado()).sesion.numero).toBe(2);
  });
});

describe('caja obligatoria', () => {
  let t: Api;
  let cli: any;
  let venta: any;
  beforeAll(async () => {
    ({ api: t } = await nuevoTaller('Taller Caja Obligatoria'));
    cli = (await t.post('/api/clientes', { nombre: 'Cliente' })).body;
    venta = await ventaConSaldo(t, cli.id, 50000);
    const cfg = (await t.get('/api/taller/config')).body;
    const r = await t.put('/api/taller/config', { taller: { ...cfg.taller }, config: { ...cfg.config, permitir_stock_negativo: !!cfg.config.permitir_stock_negativo, caja_obligatoria: true } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('sin caja abierta se rechazan cobros, pagos y gastos; con caja abierta se aceptan', async () => {
    const cobro = { cliente_id: cli.id, medios: [{ medio: 'efectivo', importe: 10000 }], aplicaciones: [{ venta_id: venta.id, importe: 10000 }] };
    const r = await t.post('/api/cobros', { ...cobro, idem_key: idem() });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('caja_cerrada');
    const cats = (await t.get('/api/categorias-gasto')).body;
    expect((await t.post('/api/gastos', { categoria_id: cats[0].id, concepto: 'Gasto sin caja', importe: 100, medio: 'efectivo', idem_key: idem() })).status).toBe(409);
    expect((await t.post('/api/ventas', { items: [{ tipo: 'libre', descripcion: 'x', cantidad: 1, precio_unitario: 1000 }], cobro: { medio: 'efectivo' }, idem_key: idem() })).status).toBe(409);
    expect((await t.post('/api/caja/abrir', { saldo_inicial: 0 })).status).toBe(201);
    expect((await t.post('/api/cobros', { ...cobro, idem_key: idem() })).status).toBe(201);
  });
});

describe('aislamiento y concurrencia de la caja', () => {
  it('otro taller no ve ni opera sobre la caja ajena', async () => {
    const B = await nuevoTaller('Taller Caja B');
    const ses = (await api.get('/api/caja/sesiones')).body[0];
    expect((await B.api.get(`/api/caja/sesiones/${ses.id}`)).status).toBe(404);
    expect((await B.api.get('/api/caja/sesiones')).body).toHaveLength(0);
    expect((await B.api.get('/api/caja/estado')).body.sesion).toBeNull();
    const m = (await movs(api))[0];
    expect((await B.api.post(`/api/caja/movimientos/${m.id}/anular`, { motivo: 'xxx' })).status).toBe(404);
  });

  it('cobros simultáneos del mismo saldo: se acepta sólo el que cabe y el libro queda consistente', async () => {
    const v = await ventaConSaldo(api, cliente.id, 30000);
    const antes = (await movs(api)).filter((x) => x.rubro === 'cobro').length;
    const resultados = await Promise.all(Array.from({ length: 5 }, () => cobrar(api, v, 30000, 'efectivo', idem())));
    const ok = resultados.filter((r) => r.status === 201);
    expect(ok).toHaveLength(1);
    expect(resultados.filter((r) => r.status === 409)).toHaveLength(4);
    expect((await movs(api)).filter((x) => x.rubro === 'cobro')).toHaveLength(antes + 1);
    expect((await api.get(`/api/ventas/${v.id}`)).body.cobrado).toBe(30000);
  });
});
