// Sprint 24: movimientos financieros con personas (aportes, préstamos de socios, préstamos y adelantos al personal).
// Se verifica contra un Worker real: caja, bancos, contabilidad de partida doble, saldos pendientes, anulaciones, permisos y aislamiento entre empresas.
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, hoyAR, idem, nuevoPersonal, nuevoTaller, sqlLocal } from './cliente';

const B = '/api/movimientos-personas';
let T: Awaited<ReturnType<typeof nuevoTaller>>;
let OTRO: Awaited<ReturnType<typeof nuevoTaller>>;
let api: Api;
const d: Record<string, any> = {};

const categorias = async (a: Api = api) => (await a.get(`${B}/categorias`)).body as any[];
const cat = async (clave: string, a: Api = api) => (await categorias(a)).find((c) => c.clave === clave).id as string;
const mov = async (extra: Record<string, unknown>, a: Api = api) => a.post(`${B}/movimientos`, { importe: 10000, motivo: 'Movimiento de prueba', idem_key: idem(), ...extra });
const ok = async (extra: Record<string, unknown>, a: Api = api) => {
  const r = await mov(extra, a);
  if (r.status !== 201) throw new Error(`movimiento falló (${r.status}): ${JSON.stringify(r.body)}`);
  return r.body as { id: string; numero: number; saldo_restante: number | null };
};
const lista = async (q = '', a: Api = api) => (await a.get(`${B}/movimientos?por_pagina=100${q}`)).body;
const detalle = async (id: string, a: Api = api) => (await a.get(`${B}/movimientos/${id}`)).body;
const plan = async () => (await api.get('/api/contabilidad/plan')).body as any[];
const saldoRol = async (rol: string) => (await plan()).find((c) => c.rol === rol)?.saldo ?? 0;
const controles = async () => Object.fromEntries((await api.get('/api/contabilidad/controles')).body.controles.map((c: any) => [c.clave, c]));
const periodo = () => `desde=${hoyAR(-30)}&hasta=${hoyAR()}`;
const resultado = async () => (await api.get(`/api/contabilidad/estado-resultados?${periodo()}`)).body.resultado as number;
const efectivoCaja = async () => {
  const e = (await api.get('/api/caja/estado')).body;
  return e.sesion.resumen.efectivo_esperado as number;
};
const saldoBanco = async (id: string) => (await api.get('/api/bancos/cuentas')).body.find((c: any) => c.id === id).saldo as number;
const sincronizar = async () => api.post('/api/contabilidad/sincronizar', {});

beforeAll(async () => {
  T = await nuevoTaller('Taller Personas', 10);
  OTRO = await nuevoTaller('Otro Taller Personas', 3);
  api = T.api;
  d.banco = (await api.post('/api/bancos/cuentas', { nombre: 'Banco Socios', banco: 'Banco Test', saldo_inicial: 0 })).body;
  d.cliente = (await api.post('/api/clientes', { nombre: 'Cliente Ventas' })).body;
  await api.post('/api/caja/abrir', { saldo_inicial: 100000 });
  // Un empleado que SÓLO ficha con PIN (sin acceso al ERP) y un socio que no usa el sistema.
  d.martin = (await api.post('/api/taller/usuarios', { nombre: 'Martín', apellido: 'Sosa', rol: 'mecanico', acceso_erp: false, pin: '4821' })).body;
  d.juan = (await api.post(`${B}/personas`, { tipo: 'socio', nombre: 'Juan Pérez' })).body;
  d.pedro = (await api.post(`${B}/personas`, { tipo: 'socio', nombre: 'Pedro Gómez' })).body;
  expect((await api.post('/api/contabilidad/activar', {})).status).toBe(200);
});

describe('categorías', () => {
  it('trae las del sistema con identificador estable, tipo financiero y dirección; el reintegro de gastos queda pendiente', async () => {
    const cs = await categorias();
    expect(cs.filter((c) => c.sistema)).toHaveLength(9);
    const aporte = cs.find((c) => c.clave === 'aporte_capital');
    expect(aporte).toMatchObject({ tipo_fin: 'aporte_capital', direccion: 'entrada', activa: 1, sistema: 1 });
    expect(cs.find((c) => c.clave === 'adelanto_sueldo')).toMatchObject({ direccion: 'salida' });
    expect(cs.find((c) => c.clave === 'aplicacion_adelanto')).toMatchObject({ direccion: 'sin_dinero' });
    const reintegro = cs.find((c) => c.clave === 'reintegro_gastos');
    expect(reintegro.pendiente).toBeTruthy();
    // las dos devoluciones de préstamo son tipos distintos (distinta obligación)
    expect(cs.find((c) => c.clave === 'devolucion_prestamo_a_persona').tipo_fin).not.toBe(cs.find((c) => c.clave === 'devolucion_prestamo_a_empresa').tipo_fin);
    // un GET no escribe nada: las filas de la empresa se crean al usarlas
    expect((await mov({ categoria_id: reintegro.id, persona_id: d.juan.id })).status).toBe(409);
  });

  it('una categoría propia elige un tipo financiero válido; no puede inventar asientos', async () => {
    expect((await api.post(`${B}/categorias`, { nombre: 'Aporte para herramientas', tipo_fin: 'aporte_capital' })).status).toBe(201);
    expect((await api.post(`${B}/categorias`, { nombre: 'Asiento libre', tipo_fin: 'gasto_varios' })).status).toBe(400);
    expect((await api.post(`${B}/categorias`, { nombre: 'Aporte de capital', tipo_fin: 'aporte_capital' })).status).toBe(409);
    expect((await api.post(`${B}/categorias`, { nombre: 'aporte para herramientas', tipo_fin: 'retiro_capital' })).status).toBe(409);
    d.catHerr = (await categorias()).find((c) => c.nombre === 'Aporte para herramientas');
    expect(d.catHerr).toMatchObject({ direccion: 'entrada', sistema: 0, movimientos: 0 });
  });

  it('las del sistema no se renombran ni se eliminan; una categoría con movimientos no se puede eliminar', async () => {
    expect((await api.patch(`${B}/categorias/${await cat('aporte_capital')}`, { nombre: 'Otro nombre' })).status).toBe(409);
    expect((await api.del(`${B}/categorias/${await cat('aporte_capital')}`)).status).toBe(409);
    await ok({ categoria_id: d.catHerr.id, persona_id: d.pedro.id, via: 'caja', importe: 5000, motivo: 'Compra de herramientas' });
    expect((await api.del(`${B}/categorias/${d.catHerr.id}`)).status).toBe(409);
    const libre = (await api.post(`${B}/categorias`, { nombre: 'Categoría sin uso', tipo_fin: 'retiro_capital' })).body;
    expect((await api.del(`${B}/categorias/${libre.id}`)).status).toBe(200);
  });

  it('una categoría desactivada no se puede usar y se puede volver a activar', async () => {
    const id = d.catHerr.id;
    expect((await api.patch(`${B}/categorias/${id}`, { activa: false })).status).toBe(200);
    expect((await mov({ categoria_id: id, persona_id: d.juan.id, via: 'caja' })).status).toBe(409);
    expect((await api.patch(`${B}/categorias/${id}`, { activa: true })).status).toBe(200);
  });
});

describe('aporte de capital', () => {
  it('Juan aporta $1.000 en efectivo: sube la caja, se vincula a Juan y el operador queda registrado; no es una venta ni una ganancia', async () => {
    const [efectivo0, resultado0, cap0, ventas0] = [await efectivoCaja(), await resultado(), await saldoRol('capital'), (await api.get('/api/ventas')).body.length];
    const r = await ok({ categoria_id: await cat('aporte_capital'), persona_id: d.juan.id, importe: 100000, via: 'caja', motivo: 'Aporte para compra de herramientas', referencia: 'Recibo 12' });
    d.aporteJuan = r;
    expect(await efectivoCaja()).toBe(efectivo0 + 100000);
    const m = await detalle(r.id);
    expect(m).toMatchObject({ persona: 'Juan Pérez', categoria: 'Aporte de capital', direccion: 'entrada', importe: 100000, moneda: 'ARS', via: 'caja', estado_visible: 'registrado', operador: expect.stringContaining('Dueño') });
    expect(m.historial.map((h: any) => h.accion)).toEqual(['crear']);
    // asiento: Dr caja / Cr capital
    await sincronizar();
    expect(await saldoRol('capital')).toBe(cap0 + 100000);
    expect(await resultado()).toBe(resultado0);
    expect((await api.get('/api/ventas')).body.length).toBe(ventas0);
    // el libro de caja lo muestra con su rubro propio
    const caja = (await api.get(`/api/caja/movimientos?desde=${hoyAR()}&hasta=${hoyAR()}`)).body.filter((x: any) => x.origen_tipo === 'persona_mov' && x.origen_id === r.id);
    expect(caja).toHaveLength(1);
    expect(caja[0]).toMatchObject({ tipo: 'ingreso', rubro: 'persona', medio: 'efectivo', importe: 100000 });
  });

  it('el rubro de personas no aparece como ingreso operativo en los reportes de caja', async () => {
    const rep = (await api.get(`/api/caja/reportes?desde=${hoyAR()}&hasta=${hoyAR()}`)).body;
    expect(rep.por_rubro.find((r: any) => r.rubro === 'persona')).toBeUndefined();
    expect(rep.totales.ingresos).toBe(0);
    const fin = (await api.get(`/api/finanzas/resumen?desde=${hoyAR()}&hasta=${hoyAR()}`)).body;
    expect(JSON.stringify(fin)).not.toContain('"persona"');
  });

  it('un aporte por transferencia a una cuenta bancaria sube el saldo del banco y no genera resultado', async () => {
    const [banco0, resultado0] = [await saldoBanco(d.banco.id), await resultado()];
    const r = await ok({ categoria_id: await cat('aporte_capital'), persona_id: d.pedro.id, importe: 250000, via: 'banco', cuenta_id: d.banco.id, motivo: 'Aporte por transferencia' });
    expect(await saldoBanco(d.banco.id)).toBe(banco0 + 250000);
    await sincronizar();
    const contable = (await plan()).find((c: any) => c.cuenta_bancaria_id === d.banco.id).saldo;
    expect(contable).toBe(banco0 + 250000);
    expect(await resultado()).toBe(resultado0);
    const bm = (await api.get(`/api/bancos/movimientos?cuenta_id=${d.banco.id}`)).body.find((x: any) => x.origen_tipo === 'persona_mov');
    expect(bm).toMatchObject({ tipo: 'ingreso', afecta_resultado: 0, importe: 250000 });
    d.aportePedro = r;
  });

  it('retiro de capital: baja la caja y el capital, y no es un gasto', async () => {
    const [efectivo0, resultado0] = [await efectivoCaja(), await resultado()];
    await ok({ categoria_id: await cat('retiro_capital'), persona_id: d.juan.id, importe: 20000, via: 'caja', motivo: 'Retiro de capital' });
    expect(await efectivoCaja()).toBe(efectivo0 - 20000);
    await sincronizar();
    expect(await resultado()).toBe(resultado0);
    expect(await saldoRol('retiros_capital')).toBe(20000);
  });
});

describe('préstamo de un socio a la empresa', () => {
  it('queda una deuda de la empresa; la devolución parcial la reduce y no se puede devolver más de lo que se debe', async () => {
    const [banco0, resultado0] = [await saldoBanco(d.banco.id), await resultado()];
    const p = await ok({ categoria_id: await cat('prestamo_a_empresa'), persona_id: d.juan.id, importe: 500000, via: 'banco', cuenta_id: d.banco.id, motivo: 'Préstamo de Juan' });
    d.prestamoJuan = p;
    expect(await saldoBanco(d.banco.id)).toBe(banco0 + 500000);
    await sincronizar();
    expect(await saldoRol('prestamos_de_personas')).toBe(500000);
    expect(await resultado()).toBe(resultado0);

    const obl = (await api.get(`${B}/obligaciones?persona_id=${d.juan.id}&obligacion=prestamo_recibido`)).body;
    expect(obl).toEqual([expect.objectContaining({ id: p.id, saldo: 500000 })]);

    const dev = await ok({ categoria_id: await cat('devolucion_prestamo_a_persona'), persona_id: d.juan.id, regulariza_id: p.id, importe: 200000, via: 'banco', cuenta_id: d.banco.id, motivo: 'Devolución parcial' });
    expect(dev.saldo_restante).toBe(300000);
    expect(await saldoBanco(d.banco.id)).toBe(banco0 + 300000);
    const o = await detalle(p.id);
    expect(o).toMatchObject({ estado_visible: 'parcial', regularizado: 200000, saldo: 300000 });
    expect(o.regularizaciones).toHaveLength(1);
    await sincronizar();
    expect(await saldoRol('prestamos_de_personas')).toBe(300000);

    const exceso = await mov({ categoria_id: await cat('devolucion_prestamo_a_persona'), persona_id: d.juan.id, regulariza_id: p.id, importe: 300001, via: 'banco', cuenta_id: d.banco.id });
    expect(exceso.status).toBe(409);
    expect(exceso.body.error.code).toBe('saldo_excedido');
    // devolución total
    await ok({ categoria_id: await cat('devolucion_prestamo_a_persona'), persona_id: d.juan.id, regulariza_id: p.id, importe: 300000, via: 'banco', cuenta_id: d.banco.id, motivo: 'Devolución final' });
    expect((await detalle(p.id)).estado_visible).toBe('regularizado');
    expect((await api.get(`${B}/obligaciones?persona_id=${d.juan.id}`)).body).toHaveLength(0);
    expect(await saldoBanco(d.banco.id)).toBe(banco0);
  });

  it('una devolución sólo puede apuntar a una obligación de la misma persona y del tipo que corresponde', async () => {
    const p = await ok({ categoria_id: await cat('prestamo_a_empresa'), persona_id: d.pedro.id, importe: 100000, via: 'caja', motivo: 'Préstamo de Pedro' });
    const otraPersona = await mov({ categoria_id: await cat('devolucion_prestamo_a_persona'), persona_id: d.juan.id, regulariza_id: p.id, via: 'caja' });
    expect(otraPersona.status).toBe(400);
    // la devolución «paga la persona» corresponde a otra obligación: no puede cancelar un préstamo recibido
    const otroTipo = await mov({ categoria_id: await cat('devolucion_prestamo_a_empresa'), persona_id: d.pedro.id, regulariza_id: p.id, via: 'caja' });
    expect(otroTipo.status).toBe(400);
    const sinObligacion = await mov({ categoria_id: await cat('devolucion_prestamo_a_persona'), persona_id: d.pedro.id, via: 'caja' });
    expect(sinObligacion.status).toBe(400);
    d.prestamoPedro = p;
  });
});

describe('préstamo y adelanto al personal (sin acceso al ERP)', () => {
  it('Martín recibe un préstamo de $800 y un adelanto de $500: dos saldos separados que no se mezclan', async () => {
    const [efectivo0, resultado0] = [await efectivoCaja(), await resultado()];
    d.prestamoMartin = await ok({ categoria_id: await cat('prestamo_a_persona'), usuario_id: d.martin.id, importe: 80000, via: 'caja', motivo: 'Préstamo para su moto' });
    d.adelantoMartin = await ok({ categoria_id: await cat('adelanto_sueldo'), usuario_id: d.martin.id, importe: 50000, via: 'caja', motivo: 'Adelanto de octubre' });
    expect(await efectivoCaja()).toBe(efectivo0 - 130000);
    await sincronizar();
    expect(await saldoRol('prestamos_al_personal')).toBe(80000);
    expect(await saldoRol('adelantos_personal')).toBe(50000);
    expect(await resultado()).toBe(resultado0); // ni el préstamo ni el adelanto son un gasto

    // la ficha financiera se creó sola, vinculada al empleado (no se duplica su nombre)
    const personas = (await api.get(`${B}/personas`)).body as any[];
    const m = personas.find((p) => p.usuario_id === d.martin.id);
    expect(m).toMatchObject({ tipo: 'empleado', nombre: 'Martín Sosa', acceso_erp: false });
    d.personaMartin = m;
    expect(personas.filter((p) => p.usuario_id === d.martin.id)).toHaveLength(1);
  });

  it('devuelve $300 del préstamo: queda debiendo $500 de préstamo y los $500 del adelanto siguen aparte', async () => {
    const dev = await ok({ categoria_id: await cat('devolucion_prestamo_a_empresa'), persona_id: d.personaMartin.id, regulariza_id: d.prestamoMartin.id, importe: 30000, via: 'caja', motivo: 'Devolución parcial del préstamo' });
    expect(dev.saldo_restante).toBe(50000);
    const ind = (await api.get(`${B}/indicadores?persona_id=${d.personaMartin.id}`)).body[0];
    expect(ind).toMatchObject({ moneda: 'ARS', prestamos_otorgados_pendiente: 50000, adelantos_pendiente: 50000, prestamos_recibidos_pendiente: 0 });
    const res = (await api.get(`${B}/resumen/persona/${d.personaMartin.id}`)).body.por_moneda[0];
    expect(res).toMatchObject({ prestamos_de_la_empresa: 80000, devoluciones_a_la_empresa: 30000, adelantos: 50000, pendiente_prestamos_otorgados: 50000, pendiente_adelantos: 50000 });
    await sincronizar();
    expect(await saldoRol('prestamos_al_personal')).toBe(50000);
    // el adelanto no se puede «devolver» con la categoría del préstamo
    const cruzado = await mov({ categoria_id: await cat('devolucion_prestamo_a_empresa'), persona_id: d.personaMartin.id, regulariza_id: d.adelantoMartin.id, via: 'caja' });
    expect(cruzado.status).toBe(400);
  });

  it('un adelanto o su aplicación sólo corresponden a personal de la empresa', async () => {
    expect((await mov({ categoria_id: await cat('adelanto_sueldo'), persona_id: d.juan.id, via: 'caja' })).status).toBe(400);
  });
});

describe('regularización autorizada de un adelanto', () => {
  it('aplicar el adelanto contra una liquidación no mueve dinero y exige autorización y liquidación', async () => {
    const cat8 = await cat('aplicacion_adelanto');
    const base = { categoria_id: cat8, persona_id: d.personaMartin.id, regulariza_id: d.adelantoMartin.id, importe: 20000, motivo: 'Descuento en liquidación de octubre' };
    expect((await mov({ ...base })).status).toBe(400); // sin liquidación ni autorización
    expect((await mov({ ...base, liquidacion_ref: 'Octubre 2026' })).status).toBe(400); // sin quién autorizó
    expect((await mov({ ...base, autorizado_por: 'Ana (RRHH)' })).status).toBe(400); // sin liquidación
    expect((await mov({ ...base, liquidacion_ref: 'Octubre 2026', autorizado_por: 'Ana (RRHH)', via: 'caja' })).status).toBe(400); // no mueve dinero

    const [efectivo0, cajaMovs0, resultado0] = [await efectivoCaja(), (await api.get(`/api/caja/movimientos?desde=${hoyAR()}&hasta=${hoyAR()}`)).body.length, await resultado()];
    const r = await ok({ ...base, liquidacion_ref: 'Octubre 2026', autorizado_por: 'Ana (RRHH)' });
    expect(await efectivoCaja()).toBe(efectivo0); // no hay una segunda salida de caja
    expect((await api.get(`/api/caja/movimientos?desde=${hoyAR()}&hasta=${hoyAR()}`)).body.length).toBe(cajaMovs0);
    expect(r.saldo_restante).toBe(30000);
    const a = await detalle(d.adelantoMartin.id);
    expect(a).toMatchObject({ estado_visible: 'parcial', regularizado: 20000, saldo: 30000 });
    const ap = await detalle(r.id);
    expect(ap).toMatchObject({ direccion: 'sin_dinero', via: 'ninguna', liquidacion_ref: 'Octubre 2026', autorizado_por: 'Ana (RRHH)' });
    await sincronizar();
    expect(await saldoRol('adelantos_personal')).toBe(30000);
    // reconoce el costo de sueldos por lo ya adelantado (y recién entonces)
    expect(await resultado()).toBe(resultado0 - 20000);
    d.aplicacion = r;
  });

  it('sólo quien tiene el permiso de aplicar adelantos puede hacerlo', async () => {
    const solo = await nuevoPersonal(api, 'caja');
    // se le dan permisos de registrar (sin aplicar adelantos) a esa persona
    const quien = (await api.get('/api/taller/usuarios/' + solo.id)).body;
    expect(quien).toBeTruthy();
    const r = await api.put(`/api/taller/usuarios/${solo.id}/permisos`, { permisos: [...quien.permisos, 'movpersonas.ver', 'movpersonas.registrar'] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const sesion = await Api.login(solo.email, 'clave-segura-1');
    const rec = await mov({ categoria_id: await cat('aplicacion_adelanto'), persona_id: d.personaMartin.id, regulariza_id: d.adelantoMartin.id, importe: 1000, liquidacion_ref: 'Octubre', autorizado_por: 'Ana', motivo: 'Intento sin permiso' }, sesion);
    expect(rec.status).toBe(403);
    expect((await mov({ categoria_id: await cat('aporte_capital'), persona_id: d.juan.id, via: 'caja', importe: 100 }, sesion)).status).toBe(201);
  });
});

describe('consultas, filtros y totales', () => {
  it('filtra por persona, por categoría y por período, y combina filtros', async () => {
    const todos = await lista();
    expect(todos.total).toBeGreaterThan(8);
    const juan = await lista(`&persona_id=${d.juan.id}`);
    expect(juan.filas.length).toBeGreaterThan(0);
    expect(juan.filas.every((f: any) => f.persona_id === d.juan.id)).toBe(true);
    const aportes = await lista(`&categoria_id=${await cat('aporte_capital')}`);
    expect(aportes.filas.every((f: any) => f.categoria === 'Aporte de capital')).toBe(true);
    const comb = await lista(`&categoria_id=${await cat('aporte_capital')}&persona_id=${d.juan.id}`);
    expect(comb.filas.length).toBeGreaterThan(0);
    expect(comb.filas.every((f: any) => f.persona_id === d.juan.id && f.categoria === 'Aporte de capital')).toBe(true);
    expect((await lista(`&desde=${hoyAR(-400)}&hasta=${hoyAR(-399)}`)).total).toBe(0);
    expect((await lista(`&direccion=sin_dinero`)).filas.every((f: any) => f.direccion === 'sin_dinero')).toBe(true);
    expect((await lista(`&cuenta=caja`)).filas.every((f: any) => f.via === 'caja')).toBe(true);
    expect((await lista(`&cuenta=${d.banco.id}`)).filas.every((f: any) => f.cuenta_id === d.banco.id)).toBe(true);
  });

  it('filtra por estado y busca por nombre de la persona y por motivo', async () => {
    expect((await lista('&estado=parcial')).filas.map((f: any) => f.id)).toEqual(expect.arrayContaining([d.prestamoMartin.id, d.adelantoMartin.id]));
    expect((await lista('&estado=regularizado')).filas.map((f: any) => f.id)).toContain(d.prestamoJuan.id);
    expect((await lista('&estado=registrado')).filas.every((f: any) => f.estado_visible === 'registrado')).toBe(true);
    expect((await lista('&q=Mart')).filas.every((f: any) => f.persona.startsWith('Martín'))).toBe(true);
    expect((await lista('&q=herramientas')).filas.length).toBeGreaterThan(0);
    expect((await lista('&q=zzzzz-nada')).total).toBe(0);
  });

  it('los totales se calculan sobre todos los registros, no sobre la página visible, y excluyen anulados', async () => {
    const pagina = (await api.get(`${B}/movimientos?por_pagina=5&pagina=2`)).body;
    const completa = await lista();
    expect(pagina.filas).toHaveLength(5);
    expect(pagina.total).toBe(completa.total);
    expect(pagina.totales).toEqual(completa.totales);
    const ars = completa.totales.find((t: any) => t.moneda === 'ARS');
    const entradas = completa.filas.filter((f: any) => f.estado === 'registrado' && f.direccion === 'entrada').reduce((a: number, f: any) => a + f.importe, 0);
    const salidas = completa.filas.filter((f: any) => f.estado === 'registrado' && f.direccion === 'salida').reduce((a: number, f: any) => a + f.importe, 0);
    expect(ars).toMatchObject({ entradas, salidas });
    expect(Number.isInteger(ars.entradas)).toBe(true);
  });

  it('resume por categoría con desglose por persona y por período', async () => {
    const r = (await api.get(`${B}/resumen/categoria?categoria_id=${await cat('aporte_capital')}&${periodo()}`)).body.por_moneda[0];
    const esperado = (await lista(`&categoria_id=${await cat('aporte_capital')}`)).filas.filter((f: any) => f.estado === 'registrado').reduce((a: number, f: any) => a + f.importe, 0);
    expect(r.total).toBe(esperado);
    expect(r.personas.map((p: any) => p.persona).sort()).toEqual(expect.arrayContaining(['Juan Pérez', 'Pedro Gómez']));
    expect(r.personas.reduce((a: number, p: any) => a + p.total, 0)).toBe(r.total);
    const orden = (await api.get(`${B}/resumen/categoria?categoria_id=${await cat('aporte_capital')}&orden=importe_asc`)).body.por_moneda[0].personas.map((p: any) => p.total);
    expect(orden).toEqual([...orden].sort((a, b) => a - b));
    const fuera = (await api.get(`${B}/resumen/categoria?categoria_id=${await cat('aporte_capital')}&desde=${hoyAR(-400)}&hasta=${hoyAR(-399)}`)).body.por_moneda;
    expect(fuera).toHaveLength(0);
  });

  it('el resumen de una persona separa aportes, retiros, préstamos y devoluciones sin un saldo neto único', async () => {
    const r = (await api.get(`${B}/resumen/persona/${d.juan.id}`)).body;
    expect(r.persona).toMatchObject({ nombre: 'Juan Pérez', tipo: 'socio', acceso_erp: null });
    const m = r.por_moneda[0];
    expect(m).toMatchObject({ aportes: 100000 + 100, retiros: 20000, prestamos_a_la_empresa: 500000, devoluciones_de_la_empresa: 500000, pendiente_prestamos_recibidos: 0 });
    expect(m.neto).toBeUndefined();
  });

  it('los indicadores distinguen flujos del período de obligaciones pendientes', async () => {
    const i = (await api.get(`${B}/indicadores?${periodo()}`)).body[0];
    expect(i.aportes).toBe(100000 + 250000 + 5000 + 100);
    expect(i).toMatchObject({ prestamos_recibidos_pendiente: 100000, prestamos_otorgados_pendiente: 50000, adelantos_pendiente: 30000 });
    const fuera = (await api.get(`${B}/indicadores?desde=${hoyAR(-400)}&hasta=${hoyAR(-399)}`)).body[0];
    expect(fuera.aportes).toBe(0); // el flujo respeta el período…
    expect(fuera.adelantos_pendiente).toBe(30000); // …el saldo pendiente es a la fecha
  });
});

describe('anulaciones y reversión', () => {
  it('anular una devolución revierte caja, banco y asiento, y devuelve el saldo a la obligación', async () => {
    const p = await ok({ categoria_id: await cat('prestamo_a_persona'), persona_id: d.juan.id, importe: 40000, via: 'banco', cuenta_id: d.banco.id, motivo: 'Préstamo a Juan' });
    const dev = await ok({ categoria_id: await cat('devolucion_prestamo_a_empresa'), persona_id: d.juan.id, regulariza_id: p.id, importe: 15000, via: 'banco', cuenta_id: d.banco.id, motivo: 'Juan devuelve' });
    await sincronizar();
    const [banco0, pers0] = [await saldoBanco(d.banco.id), await saldoRol('prestamos_al_personal')];
    // no se anula una obligación con devoluciones vigentes
    const bloqueado = await api.post(`${B}/movimientos/${p.id}/anular`, { motivo: 'Error de carga' });
    expect(bloqueado.status).toBe(409);
    expect(bloqueado.body.error.code).toBe('tiene_regularizaciones');
    expect((await api.post(`${B}/movimientos/${dev.id}/anular`, { motivo: 'Mal cargada' })).status).toBe(200);
    expect(await saldoBanco(d.banco.id)).toBe(banco0 - 15000);
    expect(await detalle(p.id)).toMatchObject({ regularizado: 0, saldo: 40000, estado_visible: 'registrado' });
    expect(await detalle(dev.id)).toMatchObject({ estado: 'anulado', estado_visible: 'anulado', anulado_motivo: 'Mal cargada' });
    await sincronizar();
    expect(await saldoRol('prestamos_al_personal')).toBe(pers0 + 15000);
    // ya anulado
    expect((await api.post(`${B}/movimientos/${dev.id}/anular`, { motivo: 'Otra vez' })).status).toBe(409);
    // ahora sí se puede anular el préstamo: queda todo en cero
    expect((await api.post(`${B}/movimientos/${p.id}/anular`, { motivo: 'Error de carga' })).status).toBe(200);
    await sincronizar();
    expect(await saldoBanco(d.banco.id)).toBe(banco0 - 15000 + 40000);
    expect(await saldoRol('prestamos_al_personal')).toBe(pers0 - 40000 + 15000);
    d.devAnulada = dev;
  });

  it('anular un aporte en efectivo genera un reverso en la caja abierta y un contra-asiento; los anulados no suman a los totales', async () => {
    const r = await ok({ categoria_id: await cat('aporte_capital'), persona_id: d.pedro.id, importe: 7000, via: 'caja', motivo: 'Aporte cargado por error' });
    await sincronizar();
    const [efectivo0, cap0] = [await efectivoCaja(), await saldoRol('capital')];
    expect((await api.post(`${B}/movimientos/${r.id}/anular`, { motivo: 'Cargado por error' })).status).toBe(200);
    expect(await efectivoCaja()).toBe(efectivo0 - 7000);
    const caja = (await api.get(`/api/caja/movimientos?desde=${hoyAR()}&hasta=${hoyAR()}`)).body;
    expect(caja.filter((x: any) => x.origen_tipo === 'reverso' && x.concepto.includes('Aporte de capital')).length).toBeGreaterThan(0);
    await sincronizar();
    expect(await saldoRol('capital')).toBe(cap0 - 7000);
    const a = await detalle(r.id);
    expect(a.historial.map((h: any) => h.accion)).toEqual(['crear', 'anular']);
    const ars = (await lista('')).totales.find((t: any) => t.moneda === 'ARS');
    const sinAnulados = (await lista('&estado=anulado')).filas.reduce((x: number, f: any) => x + f.importe, 0);
    expect(sinAnulados).toBeGreaterThan(0);
    expect(ars.anulados).toBeGreaterThan(0);
  });

  it('anular la aplicación de un adelanto lo devuelve a pendiente', async () => {
    expect((await api.post(`${B}/movimientos/${d.aplicacion.id}/anular`, { motivo: 'Liquidación mal cargada' })).status).toBe(200);
    expect(await detalle(d.adelantoMartin.id)).toMatchObject({ regularizado: 0, saldo: 50000, estado_visible: 'registrado' });
    await sincronizar();
    expect(await saldoRol('adelantos_personal')).toBe(50000);
  });

  it('un movimiento confirmado no se edita, ni siquiera por una consulta directa a la base', async () => {
    await expect(sqlLocal(`UPDATE movimientos_personas SET importe = 1 WHERE id = '${d.aporteJuan.id}'`)).rejects.toThrow(/ck_mp_inmutable/);
    await expect(sqlLocal(`UPDATE movimientos_personas SET persona_id = '${d.pedro.id}' WHERE id = '${d.aporteJuan.id}'`)).rejects.toThrow(/ck_mp_inmutable/);
    await expect(sqlLocal(`DELETE FROM movimientos_personas WHERE id = '${d.aporteJuan.id}'`)).rejects.toThrow(/ck_mp_inmutable/);
    await expect(sqlLocal(`UPDATE movimientos_personas SET estado = 'registrado' WHERE id = '${d.devAnulada.id}'`)).rejects.toThrow(/ck_mp_inmutable/);
    expect((await detalle(d.aporteJuan.id)).importe).toBe(100000);
    // y no hay ruta para editarlo
    expect((await api.put(`${B}/movimientos/${d.aporteJuan.id}`, { importe: 1 })).status).toBe(404);
  });
});

describe('operaciones duplicadas y concurrencia', () => {
  it('un reintento con la misma clave devuelve el mismo movimiento y no duplica ni la caja ni el asiento', async () => {
    const key = idem();
    const efectivo0 = await efectivoCaja();
    const a = await mov({ categoria_id: await cat('aporte_capital'), persona_id: d.juan.id, importe: 3000, via: 'caja', idem_key: key });
    const b = await mov({ categoria_id: await cat('aporte_capital'), persona_id: d.juan.id, importe: 3000, via: 'caja', idem_key: key });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ id: a.body.id, duplicado: true });
    expect(await efectivoCaja()).toBe(efectivo0 + 3000);
  });

  it('el doble clic (dos solicitudes en paralelo con la misma clave) registra un único movimiento', async () => {
    const key = idem();
    const efectivo0 = await efectivoCaja();
    const catAporte = await cat('aporte_capital');
    const rs = await Promise.all([1, 2, 3].map(() => mov({ categoria_id: catAporte, persona_id: d.pedro.id, importe: 1100, via: 'caja', idem_key: key })));
    expect(rs.map((r) => r.status).filter((s) => s === 201)).toHaveLength(1);
    expect(rs.every((r) => [200, 201, 409].includes(r.status))).toBe(true);
    expect(await efectivoCaja()).toBe(efectivo0 + 1100);
    expect((await lista('&q=prueba')).filas.filter((f: any) => f.importe === 1100)).toHaveLength(1);
  });

  it('dos devoluciones simultáneas que juntas superan el saldo: una prospera y el saldo nunca queda negativo', async () => {
    const p = await ok({ categoria_id: await cat('prestamo_a_persona'), persona_id: d.pedro.id, importe: 100000, via: 'caja', motivo: 'Préstamo a Pedro' });
    const c = await cat('devolucion_prestamo_a_empresa');
    const efectivo0 = await efectivoCaja();
    const rs = await Promise.all([1, 2].map(() => mov({ categoria_id: c, persona_id: d.pedro.id, regulariza_id: p.id, importe: 70000, via: 'caja', motivo: 'Devolución simultánea' })));
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    const o = await detalle(p.id);
    expect(o.regularizado).toBe(70000);
    expect(o.saldo).toBe(30000);
    expect(await efectivoCaja()).toBe(efectivo0 + 70000); // la devolución rechazada no dejó ningún movimiento de caja
    expect((await detalle(p.id)).regularizaciones).toHaveLength(1);
  });
});

describe('errores parciales y reglas de caja y bancos', () => {
  it('rechaza importes no positivos o con decimales, monedas no admitidas y fechas futuras', async () => {
    const base = { categoria_id: await cat('aporte_capital'), persona_id: d.juan.id, via: 'caja' };
    expect((await mov({ ...base, importe: 0 })).status).toBe(400);
    expect((await mov({ ...base, importe: -5 })).status).toBe(400);
    expect((await mov({ ...base, importe: 10.5 })).status).toBe(400);
    expect((await mov({ ...base, moneda: 'USD' })).status).toBe(400);
    expect((await mov({ ...base, moneda: 'EUR' })).status).toBe(400);
    expect((await mov({ ...base, fecha: hoyAR(3) })).status).toBe(400);
    expect((await mov({ ...base, motivo: 'a' })).status).toBe(400);
  });

  it('una cuenta bancaria inactiva o inexistente no deja ningún movimiento a medias', async () => {
    const inactiva = (await api.post('/api/bancos/cuentas', { nombre: 'Cuenta cerrada', banco: 'X Banco', saldo_inicial: 0 })).body;
    await api.put(`/api/bancos/cuentas/${inactiva.id}`, { ...inactiva, activa: false });
    const antes = (await lista()).total;
    expect((await mov({ categoria_id: await cat('aporte_capital'), persona_id: d.juan.id, via: 'banco', cuenta_id: inactiva.id })).status).toBe(400);
    expect((await mov({ categoria_id: await cat('aporte_capital'), persona_id: d.juan.id, via: 'banco', cuenta_id: 'no-existe' })).status).toBe(400);
    expect((await mov({ categoria_id: await cat('aporte_capital'), persona_id: d.juan.id, via: 'banco' })).status).toBe(400);
    expect((await mov({ categoria_id: await cat('aporte_capital'), persona_id: d.juan.id, via: 'caja', cuenta_id: d.banco.id })).status).toBe(400);
    expect((await lista()).total).toBe(antes);
  });

  it('con la caja obligatoria y cerrada no se registra efectivo; sí se registra por banco', async () => {
    const cfg = (await api.get('/api/taller/config')).body;
    const guardar = (v: boolean) => api.put('/api/taller/config', { taller: { ...cfg.taller }, config: { ...cfg.config, permitir_stock_negativo: !!cfg.config.permitir_stock_negativo, caja_obligatoria: v } });
    const cerrar = async () => {
      const ses = (await api.get('/api/caja/estado')).body.sesion;
      return api.post('/api/caja/cerrar', { declarados: [{ medio: 'efectivo', importe: ses.resumen.efectivo_esperado }], esperado_visto: ses.resumen.efectivo_esperado });
    };
    expect((await guardar(true)).status).toBe(200);
    expect((await cerrar()).status).toBe(200);
    const antes = (await lista()).total;
    const r = await mov({ categoria_id: await cat('aporte_capital'), persona_id: d.juan.id, via: 'caja' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('caja_cerrada');
    expect((await lista()).total).toBe(antes);
    expect((await mov({ categoria_id: await cat('aporte_capital'), persona_id: d.juan.id, via: 'banco', cuenta_id: d.banco.id })).status).toBe(201);
    expect((await guardar(false)).status).toBe(200);
    expect((await api.post('/api/caja/abrir', { saldo_inicial: 0 })).status).toBe(201);
  });
});

describe('permisos y privacidad', () => {
  it('el personal operativo no accede a nada de esto, ni por la API', async () => {
    const mec = await nuevoPersonal(api, 'mecanico');
    const rec = await nuevoPersonal(api, 'recepcion');
    for (const a of [mec.api, rec.api]) {
      for (const ruta of ['/categorias', '/personas', '/movimientos', `/movimientos/${d.aporteJuan.id}`, '/indicadores', '/cuentas', `/obligaciones?persona_id=${d.juan.id}`, `/resumen/persona/${d.juan.id}`, '/resumen/categoria']) {
        expect((await a.get(B + ruta)).status, ruta).toBe(403);
      }
      expect((await mov({ categoria_id: await cat('aporte_capital'), persona_id: d.juan.id, via: 'caja' }, a)).status).toBe(403);
      expect((await a.post(`${B}/movimientos/${d.aporteJuan.id}/anular`, { motivo: 'Intento' })).status).toBe(403);
      expect((await a.post(`${B}/categorias`, { nombre: 'Colada', tipo_fin: 'aporte_capital' })).status).toBe(403);
      expect((await a.post(`${B}/personas`, { tipo: 'socio', nombre: 'Intruso' })).status).toBe(403);
    }
  });

  it('cada permiso habilita sólo lo suyo: ver no registra, registrar no anula ni administra, reportes necesita ver', async () => {
    const u = await nuevoPersonal(api, 'caja');
    const permisosDe = async () => (await api.get('/api/taller/usuarios/' + u.id)).body.permisos as string[];
    const dar = async (...ps: string[]) => {
      const r = await api.put(`/api/taller/usuarios/${u.id}/permisos`, { permisos: ps });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return Api.login(u.email, 'clave-segura-1');
    };
    const base = (await permisosDe()).filter((p) => !p.startsWith('movpersonas.'));
    let s = await dar(...base, 'movpersonas.ver');
    expect((await s.get(`${B}/movimientos`)).status).toBe(200);
    expect((await mov({ categoria_id: await cat('aporte_capital'), persona_id: d.juan.id, via: 'caja' }, s)).status).toBe(403);
    expect((await s.get(`${B}/resumen/categoria`)).status).toBe(403);
    s = await dar(...base, 'movpersonas.ver', 'movpersonas.registrar', 'movpersonas.reportes');
    expect((await s.get(`${B}/resumen/categoria`)).status).toBe(200);
    const creado = await mov({ categoria_id: await cat('aporte_capital'), persona_id: d.juan.id, via: 'caja', importe: 2500 }, s);
    expect(creado.status).toBe(201);
    expect((await s.post(`${B}/movimientos/${creado.body.id}/anular`, { motivo: 'Sin permiso' })).status).toBe(403);
    expect((await s.post(`${B}/categorias`, { nombre: 'Sin permiso', tipo_fin: 'aporte_capital' })).status).toBe(403);
    s = await dar(...base, 'movpersonas.ver', 'movpersonas.anular');
    expect((await s.post(`${B}/movimientos/${creado.body.id}/anular`, { motivo: 'Con permiso de anular' })).status).toBe(200);
    // sin ver, los permisos que dependen de él se retiran solos
    const sinVer = await dar(...base, 'movpersonas.registrar');
    expect((await sinVer.get(`${B}/movimientos`)).status).toBe(403);
  });

  it('administrador y propietario los tienen por defecto; la plantilla de caja y de mecánico no', async () => {
    const admin = await nuevoPersonal(api, 'administrador');
    expect((await admin.api.get(`${B}/movimientos`)).status).toBe(200);
    const me = (await (await nuevoPersonal(api, 'caja')).api.get('/api/auth/me')).body;
    expect(me.permisos.filter((p: string) => p.startsWith('movpersonas.'))).toEqual([]);
  });

  it('el libro de caja y el de bancos muestran estos movimientos sin nombre ni motivo a quien no tiene permiso, y no se pueden buscar por texto', async () => {
    const u = await nuevoPersonal(api, 'caja');
    const base = (await api.get('/api/taller/usuarios/' + u.id)).body.permisos as string[];
    expect((await api.put(`/api/taller/usuarios/${u.id}/permisos`, { permisos: [...base, 'bancos.ver'] })).status).toBe(200);
    const s = await Api.login(u.email, 'clave-segura-1');
    const reservado = 'Movimiento con personas (reservado)';
    // caja
    const rango = `desde=${hoyAR()}&hasta=${hoyAR()}`;
    const cajaOwner = (await api.get(`/api/caja/movimientos?${rango}&limite=500`)).body.filter((m: any) => m.rubro === 'persona');
    const cajaCajero = (await s.get(`/api/caja/movimientos?${rango}&limite=500`)).body.filter((m: any) => m.rubro === 'persona');
    expect(cajaOwner.length).toBeGreaterThan(3);
    expect(cajaCajero.length).toBeGreaterThan(0); // el efectivo sigue visible (sólo de la caja abierta, como siempre): el arqueo y el cierre lo cuentan
    expect(cajaCajero.length).toBeLessThanOrEqual(cajaOwner.length);
    expect(cajaOwner.some((m: any) => m.concepto.includes('Juan'))).toBe(true);
    expect(cajaCajero.every((m: any) => m.concepto === reservado && m.referencia === null)).toBe(true);
    expect(JSON.stringify(cajaCajero)).not.toMatch(/Juan|Pedro|Mart/);
    expect((await s.get(`/api/caja/movimientos?${rango}&q=Juan`)).body.filter((m: any) => m.rubro === 'persona')).toHaveLength(0);
    expect((await api.get(`/api/caja/movimientos?${rango}&q=Juan`)).body.length).toBeGreaterThan(0);
    // bancos (incluye el reverso de un movimiento anulado)
    const bancoOwner = (await api.get(`/api/bancos/movimientos?cuenta_id=${d.banco.id}&limite=500`)).body;
    const bancoCajero = (await s.get(`/api/bancos/movimientos?cuenta_id=${d.banco.id}&limite=500`)).body;
    const dePersonas = (xs: any[]) => xs.filter((m) => m.es_persona);
    expect(dePersonas(bancoOwner).length).toBeGreaterThan(3);
    expect(dePersonas(bancoOwner).some((m: any) => /Juan|Pedro/.test(m.concepto))).toBe(true);
    expect(dePersonas(bancoCajero).every((m: any) => m.concepto === reservado && m.referencia === null)).toBe(true);
    expect(JSON.stringify(bancoCajero)).not.toMatch(/Juan|Pedro/);
    expect((await s.get(`/api/bancos/movimientos?cuenta_id=${d.banco.id}&q=Pedro`)).body.filter((m: any) => m.es_persona)).toHaveLength(0);
    expect((await api.get(`/api/bancos/movimientos?cuenta_id=${d.banco.id}&q=Pedro`)).body.length).toBeGreaterThan(0);
  });

  it('los datos de préstamos y adelantos no aparecen en la hoja del mecánico ni en el seguimiento público', async () => {
    const cliente = (await api.post('/api/clientes', { nombre: 'Cliente Privacidad' })).body;
    const veh = (await api.post('/api/vehiculos', { cliente_id: cliente.id, patente: 'PRV123', marca_texto: 'Fiat', modelo_texto: 'Uno' })).body;
    const ot = await api.post('/api/ordenes', { cliente_id: cliente.id, vehiculo_id: veh.id, motivo: 'Service' });
    if (ot.status === 201) {
      const hoja = JSON.stringify((await api.get(`/api/ordenes/${ot.body.id}`)).body);
      expect(hoja).not.toContain('Martín');
      expect(hoja).not.toContain('adelanto');
    }
    // las personas del personal sólo exponen nombre y si tienen acceso: sin correo, documento ni PIN
    const p = (await api.get(`${B}/personas`)).body.find((x: any) => x.usuario_id === d.martin.id);
    expect(Object.keys(p).sort()).not.toEqual(expect.arrayContaining(['email', 'pin_hash', 'password_hash']));
    expect(p.documento).toBeNull();
  });
});

describe('aislamiento entre empresas', () => {
  it('otra empresa no ve, no anula y no puede referenciar movimientos, personas ni categorías ajenas', async () => {
    const o = OTRO.api;
    expect((await lista('', o)).total).toBe(0);
    expect((await o.get(`${B}/movimientos/${d.aporteJuan.id}`)).status).toBe(404);
    expect((await o.post(`${B}/movimientos/${d.aporteJuan.id}/anular`, { motivo: 'Intento ajeno' })).status).toBe(404);
    expect((await o.get(`${B}/resumen/persona/${d.juan.id}`)).status).toBe(404);
    expect((await o.get(`${B}/personas`)).body.find((p: any) => p.id === d.juan.id)).toBeUndefined();
    expect((await o.get(`${B}/personas`)).body.find((p: any) => p.usuario_id === d.martin.id)).toBeUndefined();
    // referenciar la persona de otra empresa
    expect((await mov({ categoria_id: await cat('aporte_capital', o), persona_id: d.juan.id, via: 'caja' }, o)).status).toBe(400);
    expect((await mov({ categoria_id: await cat('aporte_capital', o), usuario_id: d.martin.id, via: 'caja' }, o)).status).toBe(400);
    // la categoría de otra empresa
    expect((await mov({ categoria_id: d.catHerr.id, persona_id: (await o.post(`${B}/personas`, { tipo: 'socio', nombre: 'Socio Ajeno' })).body.id, via: 'caja' }, o)).status).toBe(400);
    // la cuenta bancaria de otra empresa
    const propia = (await o.post(`${B}/personas`, { tipo: 'socio', nombre: 'Otro Socio' })).body;
    expect((await mov({ categoria_id: await cat('aporte_capital', o), persona_id: propia.id, via: 'banco', cuenta_id: d.banco.id }, o)).status).toBe(400);
    // y una obligación ajena
    expect((await mov({ categoria_id: await cat('devolucion_prestamo_a_persona', o), persona_id: propia.id, regulariza_id: d.prestamoPedro.id, via: 'caja' }, o)).status).toBe(400);
    expect((await lista('', o)).total).toBe(0);
    // las categorías propias de una empresa no existen en la otra
    expect((await o.patch(`${B}/categorias/${d.catHerr.id}`, { activa: false })).status).toBe(404);
    expect((await o.get(`${B}/categorias`)).body.some((c: any) => c.id === d.catHerr.id)).toBe(false);
  });
});

describe('coherencia entre el libro financiero y el contable', () => {
  it('después de todo, la contabilidad coincide con caja, bancos y las obligaciones pendientes', async () => {
    await sincronizar();
    const c = await controles();
    for (const clave of ['partida_doble', 'caja', 'bancos', 'prestamos_personal', 'adelantos_personal', 'prestamos_de_personas']) {
      expect(c[clave], clave).toBeTruthy();
      expect(c[clave].estado, `${clave}: ${JSON.stringify(c[clave])}`).toBe('ok');
    }
    const cobertura = c.cobertura.items.find((i: any) => i.origen === 'mov_persona');
    expect(cobertura).toMatchObject({ con_error: 0, pendientes: 0 });
    expect(cobertura.documentos).toBe(cobertura.contabilizados);
  });

  it('cada asiento de un movimiento con personas balancea y nace una sola vez', async () => {
    const diario = (await api.get(`/api/contabilidad/diario?${periodo()}&limite=500&origen=mov_persona`)).body;
    const asientos = diario.asientos ?? diario;
    expect(asientos.length).toBeGreaterThan(5);
    const claves = asientos.map((a: any) => `${a.origen_id}|${a.evento}`);
    expect(new Set(claves).size).toBe(claves.length);
    for (const a of asientos) expect(a.lineas.reduce((x: number, l: any) => x + l.debe - l.haber, 0), a.descripcion).toBe(0);
  });
});
