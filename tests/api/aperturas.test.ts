// Sprint 12: saldos de apertura de proveedores. Se cargan una sola vez por proveedor, quedan en su cuenta corriente, se pagan como cualquier deuda y en
// contabilidad van contra el patrimonio: no son compras, no mueven stock y no tocan el estado de resultados.
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, consultaLocal, hoyAR, idem, nuevoPersonal, nuevoTaller, sqlLocal } from './cliente';

function cuit(prefijo: string, numero: string): string {
  const base = prefijo + numero;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((a, p, i) => a + p * Number(base[i]), 0);
  let v = 11 - (suma % 11);
  if (v === 11) v = 0;
  if (v === 10) v = 9;
  return base + v;
}

let T: Awaited<ReturnType<typeof nuevoTaller>>;
let B: Awaited<ReturnType<typeof nuevoTaller>>;
let api: Api;
const d: Record<string, any> = {};
const CORTE = hoyAR(-20);
const cuitSur = cuit('30', '71111111');

const validar = (filas: any[], extra: Record<string, unknown> = {}) => api.post('/api/aperturas/proveedores/validar', { fecha_corte: CORTE, filas, ...extra });
const crear = (filas: any[], extra: Record<string, unknown> = {}) => api.post('/api/aperturas/proveedores', { fecha_corte: CORTE, origen: 'Caldén · cuentas corrientes de proveedores', idem_key: idem(), filas, ...extra });
const saldo = async (id: string, a: Api = api) => (await a.get('/api/proveedores')).body.find((p: any) => p.id === id)?.saldo;
const n = async (tabla: string, tallerId = T.tallerId) => (await consultaLocal<{ n: number }>(`SELECT COUNT(*) AS n FROM ${tabla} WHERE taller_id = '${tallerId}'`))[0].n;
const ctl = async () => Object.fromEntries(((await api.get('/api/contabilidad/controles')).body.controles as any[]).map((c) => [c.clave, c]));

beforeAll(async () => {
  T = await nuevoTaller('Taller Apertura', 5);
  B = await nuevoTaller('Taller Ajeno', 2);
  api = T.api;
  const prov = async (a: Api, nombre: string, extra: Record<string, unknown> = {}) => (await a.post('/api/proveedores', { nombre, ...extra })).body;
  d.sur = await prov(api, 'Distribuidora Sur', { cuit: cuitSur });
  d.norte = await prov(api, 'Repuestos del Norte');
  d.este = await prov(api, 'Lubricantes Este');
  d.oeste = await prov(api, 'Frenos Oeste');
  d.doble1 = await prov(api, 'Filtros Doble');
  d.doble2 = await prov(api, 'filtros  doble');
  d.ajeno = await prov(B.api, 'Proveedor de otro taller');
  d.articulo = (await api.post('/api/articulos', { nombre: 'Filtro', codigo: 'F1', costo: 10000, precio: 20000, stock_inicial: 0 })).body;
  expect((await api.post('/api/contabilidad/activar', {})).status).toBe(200);
});

describe('permisos', () => {
  it('sólo quien tiene el permiso de aperturas accede; recepción, caja y mecánico no', async () => {
    for (const rol of ['recepcion', 'caja', 'mecanico', 'deposito']) {
      const u = await nuevoPersonal(api, rol);
      expect((await u.api.get('/api/aperturas')).status, rol).toBe(403);
      expect((await u.api.get('/api/aperturas/estado')).status, rol).toBe(403);
      expect((await u.api.post('/api/aperturas/proveedores/validar', { fecha_corte: CORTE, filas: [{ n: 1, proveedor_id: d.sur.id, importe: '1' }] })).status, rol).toBe(403);
      expect((await u.api.post('/api/aperturas/proveedores', { fecha_corte: CORTE, origen: 'x y z', idem_key: idem(), filas: [] })).status, rol).toBe(403);
    }
    expect((await api.get('/api/aperturas')).status).toBe(200);
  });
});

describe('revisión previa (no escribe nada)', () => {
  it('resuelve el proveedor por id, CUIT o nombre, y rechaza lo ambiguo, lo inexistente y lo ajeno', async () => {
    const antes = await n('aperturas_saldos');
    const r = await validar([
      { n: 2, proveedor_id: d.norte.id, importe: '1.500,50', referencia: 'FC 0001-123', vencimiento: hoyAR(10) },
      { n: 3, proveedor: cuitSur, importe: '$ 2.000' },
      { n: 4, proveedor: 'lubricantes este', importe: '300' },
      { n: 5, proveedor: 'Filtros Doble', importe: '100' }, // dos proveedores con ese nombre
      { n: 6, proveedor: 'No Existe SA', importe: '100' },
      { n: 7, proveedor_id: d.ajeno.id, importe: '100' }, // proveedor de otro taller
      { n: 8, proveedor_id: d.oeste.id, importe: '0' },
      { n: 9, proveedor_id: d.oeste.id, importe: 'abc' },
      { n: 10, proveedor_id: d.oeste.id, importe: '10', vencimiento: '2026-13-45' },
      { n: 11, proveedor: cuitSur, importe: '5' }, // el CUIT ya apareció en la fila 3
    ]);
    expect(r.status).toBe(200);
    const f = (k: number) => r.body.filas.find((x: any) => x.n === k);
    expect(f(2)).toMatchObject({ estado: 'ok', proveedor: 'Repuestos del Norte', importe: 150050, referencia: 'FC 0001-123' });
    expect(f(3)).toMatchObject({ estado: 'ok', proveedor: 'Distribuidora Sur', importe: 200000 });
    expect(f(4)).toMatchObject({ estado: 'ok', proveedor: 'Lubricantes Este', importe: 30000 });
    expect(f(5).estado).toBe('error');
    expect(f(5).mensajes[0]).toContain('más de un proveedor');
    expect(f(6).mensajes[0]).toContain('no existe');
    expect(f(7).estado).toBe('error');
    expect(f(7).mensajes[0]).toContain('no existe en este taller');
    expect(f(8).mensajes[0]).toContain('cero');
    expect(f(9).mensajes[0]).toContain('no es un importe');
    expect(f(10).mensajes[0]).toContain('vencimiento');
    expect(f(11).mensajes[0]).toContain('ya figura en la fila 3');
    expect(r.body.resumen).toMatchObject({ filas: 10, correctas: 3, con_error: 7, puede_confirmar: false, deuda: 150050 + 200000 + 30000 });
    expect(await n('aperturas_saldos')).toBe(antes);
    expect(await n('aperturas_saldos_items')).toBe(0);
  });

  it('la fecha de corte no puede ser futura ni inexistente', async () => {
    expect((await validar([{ n: 1, proveedor_id: d.sur.id, importe: '1' }], { fecha_corte: hoyAR(1) })).status).toBe(400);
    expect((await validar([{ n: 1, proveedor_id: d.sur.id, importe: '1' }], { fecha_corte: '2026-02-30' })).status).toBe(400);
  });
});

describe('carga de la apertura', () => {
  it('con filas con error no se guarda nada, y sin origen tampoco', async () => {
    const mala = await crear([{ n: 1, proveedor_id: d.sur.id, importe: '100' }, { n: 2, proveedor: 'No Existe SA', importe: '1' }]);
    expect(mala.status).toBe(400);
    expect(mala.body.error.code).toBe('filas_con_error');
    expect((await crear([{ n: 1, proveedor_id: d.sur.id, importe: '100' }], { origen: '' })).status).toBe(400);
    expect(await n('aperturas_saldos')).toBe(0);
    expect(await saldo(d.sur.id)).toBe(0);
  });

  it('registra las deudas con su corte, origen y responsable; reintentar con la misma clave no duplica', async () => {
    const k = idem();
    const filas = [
      { n: 1, proveedor_id: d.sur.id, importe: '12.000,00', referencia: 'FC A-0001-777', vencimiento: hoyAR(-5) },
      { n: 2, proveedor: 'Repuestos del Norte', importe: '3.500,50' },
      { n: 3, proveedor_id: d.este.id, importe: '-500' }, // saldo a favor del taller
    ];
    const r = await crear(filas, { idem_key: k });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ numero: 1, cantidad: 3, total: 1200000 + 350050 - 50000 });
    d.apertura1 = r.body.id;
    const otra = await crear(filas, { idem_key: k });
    expect(otra.status).toBe(200);
    expect(otra.body).toMatchObject({ duplicado: true, numero: 1 });
    expect(await n('aperturas_saldos')).toBe(1);
    expect(await n('aperturas_saldos_items')).toBe(3);
    expect(await saldo(d.sur.id)).toBe(1200000);
    expect(await saldo(d.norte.id)).toBe(350050);
    expect(await saldo(d.este.id)).toBe(-50000);
    const det = (await api.get(`/api/aperturas/${d.apertura1}`)).body;
    expect(det).toMatchObject({ numero: 1, fecha_corte: CORTE, estado: 'vigente', origen: 'Caldén · cuentas corrientes de proveedores', total: 1500050 });
    expect(det.usuario).toBeTruthy();
    expect(det.items).toHaveLength(3);
    expect((await api.get('/api/aperturas')).body).toHaveLength(1);
  });

  it('un proveedor no puede tener dos saldos de apertura vigentes: ni con otra clave ni de forma simultánea', async () => {
    const otra = await crear([{ n: 1, proveedor_id: d.sur.id, importe: '999' }]);
    expect(otra.status).toBe(400);
    expect(otra.body.error.code).toBe('filas_con_error');
    expect(JSON.stringify((await validar([{ n: 1, proveedor_id: d.sur.id, importe: '999' }])).body)).toContain('saldo de apertura vigente');
    const rs = await Promise.all([crear([{ n: 1, proveedor_id: d.oeste.id, importe: '700' }]), crear([{ n: 1, proveedor_id: d.oeste.id, importe: '700' }])]);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status !== 201).every((r) => [400, 409].includes(r.status))).toBe(true);
    expect(await saldo(d.oeste.id)).toBe(70000); // no se duplicó
    d.apertura2 = rs.find((r) => r.status === 201)!.body.id;
  });

  it('avisa si el proveedor ya tiene operaciones anteriores al corte y pide confirmarlo expresamente', async () => {
    const compra = await api.post('/api/compras', { proveedor_id: d.doble1.id, fecha: hoyAR(-30), idem_key: idem(), items: [{ articulo_id: d.articulo.id, cantidad: 2, costo_unitario: 10000 }] });
    expect(compra.status).toBe(201);
    expect(await saldo(d.doble1.id)).toBe(20000);
    const v = await validar([{ n: 1, proveedor_id: d.doble1.id, importe: '50' }]);
    expect(v.body.filas[0].estado).toBe('aviso');
    expect(v.body.filas[0].mensajes[0]).toContain('NO debe incluirlos');
    expect(v.body.resumen).toMatchObject({ con_aviso: 1, puede_confirmar: true });
    const sin = await crear([{ n: 1, proveedor_id: d.doble1.id, importe: '50' }]);
    expect(sin.status).toBe(409);
    expect(sin.body.error.code).toBe('avisos_sin_confirmar');
    const con = await crear([{ n: 1, proveedor_id: d.doble1.id, importe: '50' }], { acepta_avisos: true });
    expect(con.status).toBe(201);
    expect(await saldo(d.doble1.id)).toBe(25000); // se suma a lo ya registrado
    d.apertura3 = con.body.id;
  });
});

describe('cuenta corriente del proveedor', () => {
  it('la apertura figura en la cuenta, en la deuda y en los vencimientos, y se paga con los pagos de siempre', async () => {
    const cta = (await api.get(`/api/proveedores/${d.sur.id}/cuenta`)).body;
    expect(cta.saldo).toBe(1200000);
    expect(cta.movimientos).toHaveLength(1);
    expect(cta.movimientos[0]).toMatchObject({ tipo: 'apertura', fecha: CORTE, haber: 1200000, debe: 0, detalle: 'FC A-0001-777', anulado: 0 });
    expect(cta.deuda.docs[0]).toMatchObject({ tipo: 'apertura', total: 1200000, pendiente: 1200000 });
    const deudas = (await api.get('/api/deuda-proveedores')).body as any[];
    expect(deudas.find((x) => x.proveedor_id === d.sur.id)).toMatchObject({ saldo: 1200000, vencido: 1200000 });
    expect((await api.get(`/api/vencimientos-proveedores?proveedor_id=${d.sur.id}`)).body[0]).toMatchObject({ tipo: 'apertura', pendiente: 1200000 });
    // pago parcial
    const caja = await api.post('/api/caja/abrir', { saldo_inicial: 5000000 });
    expect(caja.status).toBe(201);
    const pago = await api.post('/api/pagos-proveedor', { proveedor_id: d.sur.id, importe: 500000, medio: 'efectivo', idem_key: idem() });
    expect(pago.status).toBe(201);
    d.pago = pago.body;
    expect(await saldo(d.sur.id)).toBe(700000);
    expect((await api.get(`/api/proveedores/${d.sur.id}/cuenta`)).body.deuda.docs[0].pendiente).toBe(700000);
    // no se puede pagar más de lo que se debe sin pedir un anticipo
    const demas = await api.post('/api/pagos-proveedor', { proveedor_id: d.sur.id, importe: 800000, medio: 'efectivo', idem_key: idem() });
    expect(demas.status).toBe(409);
    expect(demas.body.error.code).toBe('saldo_excedido');
  });

  it('un saldo a favor del taller se muestra como crédito y se descuenta de lo que se compre después', async () => {
    const cta = (await api.get(`/api/proveedores/${d.este.id}/cuenta`)).body;
    expect(cta.saldo).toBe(-50000);
    expect(cta.movimientos[0]).toMatchObject({ tipo: 'apertura', debe: 50000, haber: 0 });
    expect(cta.deuda.saldo).toBe(-50000);
    const compra = await api.post('/api/compras', { proveedor_id: d.este.id, idem_key: idem(), items: [{ articulo_id: d.articulo.id, cantidad: 10, costo_unitario: 10000 }] });
    expect(compra.status).toBe(201);
    expect(await saldo(d.este.id)).toBe(100000 - 50000);
    expect((await api.get(`/api/proveedores/${d.este.id}/cuenta`)).body.deuda.docs[0]).toMatchObject({ tipo: 'compra', pendiente: 50000 });
  });
});

describe('contabilidad: va contra el patrimonio, no contra resultados', () => {
  it('genera un asiento por apertura (Debe saldos iniciales / Haber proveedores) y no toca el estado de resultados', async () => {
    const diario = (await api.get(`/api/contabilidad/diario?desde=${CORTE}&hasta=${hoyAR()}&origen=apertura_proveedores&limite=50`)).body;
    expect(diario.asientos).toHaveLength(3); // apertura 1, 2 y 3
    const a1 = diario.asientos.find((a: any) => a.origen_id === d.apertura1);
    expect(a1).toMatchObject({ fecha: CORTE, total: 1500050, modo: 'automatico', evento: 'alta' });
    expect(a1.lineas.map((l: any) => [l.cuenta_nombre, l.debe, l.haber])).toEqual([['Saldos iniciales y ajustes de apertura', 1500050, 0], ['Proveedores', 0, 1500050]]);
    const er = (await api.get(`/api/contabilidad/estado-resultados?desde=${hoyAR(-40)}&hasta=${hoyAR()}`)).body;
    expect(er.ventas_netas).toBe(0);
    expect(er.gastos).toBe(0);
    expect(er.resultado).toBe(0);
    const c = await ctl();
    expect(c.partida_doble.estado).toBe('ok');
    expect(c.proveedores.estado, c.proveedores.detalle).toBe('ok');
    expect(c.proveedores.contable).toBe(c.proveedores.operativo);
    expect((await api.get('/api/contabilidad/estado')).body.al_dia).toBe(true);
  });

  it('el stock y las compras no se alteran: la apertura no crea compras ni movimientos', async () => {
    expect(await n('compras')).toBe(2); // la de doble1 y la de este
    expect((await consultaLocal<{ n: number }>(`SELECT COUNT(*) AS n FROM stock_movimientos WHERE taller_id = '${T.tallerId}' AND origen_tipo LIKE '%apertura%'`))[0].n).toBe(0);
  });
});

describe('anulación', () => {
  it('no se anula una deuda que ya tiene pagos aplicados', async () => {
    const r = await api.post(`/api/aperturas/${d.apertura1}/anular`, { motivo: 'Me equivoqué' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('apertura_con_pagos');
    expect((await api.get(`/api/aperturas/${d.apertura1}`)).body.estado).toBe('vigente');
  });

  it('anulando primero el pago se puede anular la apertura: la deuda desaparece y se contabiliza el contra-asiento', async () => {
    expect((await api.post(`/api/pagos-proveedor/${d.pago.id}/anular`, { motivo: 'Pago mal imputado' })).status).toBe(200);
    expect(await saldo(d.sur.id)).toBe(1200000);
    expect((await api.post(`/api/aperturas/${d.apertura1}/anular`, { motivo: 'ok' })).status).toBe(400); // el motivo es obligatorio (mínimo 3 caracteres)
    const r = await api.post(`/api/aperturas/${d.apertura1}/anular`, { motivo: 'Planilla equivocada' });
    expect(r.status).toBe(200);
    expect(await saldo(d.sur.id)).toBe(0);
    expect(await saldo(d.norte.id)).toBe(0);
    expect(await saldo(d.este.id)).toBe(100000); // sólo queda la compra
    const det = (await api.get(`/api/aperturas/${d.apertura1}`)).body;
    expect(det).toMatchObject({ estado: 'anulada', motivo_anulacion: 'Planilla equivocada' });
    expect(det.anulada_por_nombre).toBeTruthy();
    expect(det.items.every((i: any) => i.activo === 0)).toBe(true);
    expect((await api.post(`/api/aperturas/${d.apertura1}/anular`, { motivo: 'Otra vez' })).status).toBe(409);
    const cta = (await api.get(`/api/proveedores/${d.sur.id}/cuenta`)).body;
    expect(cta.saldo).toBe(0);
    expect(cta.movimientos[0].anulado).toBe(1); // queda a la vista, anulado
    // Contabilidad: contra-asiento con la fecha y el responsable de la anulación; el original queda revertido
    const filas = await consultaLocal<{ evento: string; estado: string; fecha: string; modo: string }>(`SELECT evento, estado, fecha, modo FROM asientos WHERE taller_id = '${T.tallerId}' AND origen_id = '${d.apertura1}' ORDER BY numero`);
    expect(filas.map((f) => [f.evento, f.estado, f.modo])).toEqual([['alta', 'revertido', 'automatico'], ['anulacion', 'registrado', 'reversion']]);
    expect(filas[1].fecha).toBe(hoyAR());
    const c = await ctl();
    expect(c.proveedores.estado, c.proveedores.detalle).toBe('ok');
    expect(c.partida_doble.estado).toBe('ok');
    expect((await api.get('/api/contabilidad/estado')).body.al_dia).toBe(true);
  });

  it('después de anular se puede volver a cargar la apertura del proveedor, y ahí sí queda una sola vigente', async () => {
    const r = await crear([{ n: 1, proveedor_id: d.sur.id, importe: '10.000' }]);
    expect(r.status).toBe(201);
    expect(r.body.numero).toBe(4);
    expect(await saldo(d.sur.id)).toBe(1000000);
    const vigentes = await consultaLocal<{ n: number }>(`SELECT COUNT(*) AS n FROM aperturas_saldos_items WHERE taller_id = '${T.tallerId}' AND proveedor_id = '${d.sur.id}' AND activo = 1`);
    expect(vigentes[0].n).toBe(1);
  });
});

describe('la base protege lo registrado', () => {
  it('una apertura no se edita ni se borra, y sus renglones tampoco', async () => {
    await expect(sqlLocal(`UPDATE aperturas_saldos SET total = total + 1 WHERE taller_id = '${T.tallerId}' AND id = '${d.apertura2}'`)).rejects.toThrow(/no se modifica/);
    await expect(sqlLocal(`UPDATE aperturas_saldos SET fecha_corte = '2020-01-01' WHERE taller_id = '${T.tallerId}' AND id = '${d.apertura2}'`)).rejects.toThrow();
    await expect(sqlLocal(`DELETE FROM aperturas_saldos WHERE taller_id = '${T.tallerId}' AND id = '${d.apertura2}'`)).rejects.toThrow(/no se elimina/);
    await expect(sqlLocal(`UPDATE aperturas_saldos_items SET importe = 1 WHERE taller_id = '${T.tallerId}' AND apertura_id = '${d.apertura2}'`)).rejects.toThrow(/no se modifican/);
    await expect(sqlLocal(`DELETE FROM aperturas_saldos_items WHERE taller_id = '${T.tallerId}' AND apertura_id = '${d.apertura2}'`)).rejects.toThrow(/no se eliminan/);
    // un renglón no se desactiva por separado: sólo anulando la apertura completa
    await expect(sqlLocal(`UPDATE aperturas_saldos_items SET activo = 0 WHERE taller_id = '${T.tallerId}' AND apertura_id = '${d.apertura2}'`)).rejects.toThrow();
    // una apertura anulada no admite nada más
    await expect(sqlLocal(`UPDATE aperturas_saldos SET notas = 'x' WHERE taller_id = '${T.tallerId}' AND id = '${d.apertura1}'`)).rejects.toThrow();
    await expect(sqlLocal(`INSERT INTO aperturas_saldos_items (id, taller_id, apertura_id, proveedor_id, importe) VALUES ('x1', '${T.tallerId}', '${d.apertura1}', '${d.oeste.id}', 5)`)).rejects.toThrow(/no admite/);
  });

  it('la base no admite dos saldos vigentes del mismo proveedor', async () => {
    await expect(sqlLocal(`INSERT INTO aperturas_saldos_items (id, taller_id, apertura_id, proveedor_id, importe) VALUES ('x2', '${T.tallerId}', '${d.apertura2}', '${d.oeste.id}', 5)`)).rejects.toThrow();
  });
});

describe('estado de la apertura y aislamiento', () => {
  it('el panel de estado resume caja, bancos, inventario, proveedores y deja claro que los clientes todavía no están', async () => {
    const e = (await api.get('/api/aperturas/estado')).body;
    expect(e.caja).toMatchObject({ estado: 'declarada', efectivo_inicial: 5000000 });
    expect(e.proveedores.aperturas_vigentes).toBe(3); // 2, 3 y 4 (la 1 está anulada)
    expect(e.clientes.disponible).toBe(false);
    expect(e.clientes.motivo).toContain('documento de apertura');
    expect(Array.isArray(e.bancos)).toBe(true);
  });

  it('otro taller no ve, valida ni anula las aperturas ajenas', async () => {
    expect((await B.api.get('/api/aperturas')).body).toEqual([]);
    expect((await B.api.get(`/api/aperturas/${d.apertura2}`)).status).toBe(404);
    expect((await B.api.post(`/api/aperturas/${d.apertura2}/anular`, { motivo: 'Intento ajeno' })).status).toBe(404);
    const v = await B.api.post('/api/aperturas/proveedores/validar', { fecha_corte: CORTE, filas: [{ n: 1, proveedor_id: d.sur.id, importe: '100' }] });
    expect(v.body.filas[0].estado).toBe('error');
    expect((await B.api.post('/api/aperturas/proveedores', { fecha_corte: CORTE, origen: 'Intento ajeno', idem_key: idem(), filas: [{ n: 1, proveedor_id: d.sur.id, importe: '100' }] })).status).toBe(400);
    expect(await saldo(d.sur.id)).toBe(1000000);
    expect((await B.api.get('/api/aperturas/estado')).body.proveedores.aperturas_vigentes).toBe(0);
  });
});
