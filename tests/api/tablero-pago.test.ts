// Indicador de pago en las tarjetas del tablero de órdenes (GET /api/ordenes): mismas reglas del Sprint 25, sin consultas por tarjeta y sólo con permiso financiero.
import { beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { Api, nuevoPersonal, nuevoTaller } from './cliente';
import { PUERTO } from './global-setup';
import { jpeg } from '../fixtures/archivos';

const BASE = `http://127.0.0.1:${PUERTO}`;
let ipN = 0;
const ip = () => `10.230.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`;
const tok = (url: string) => url.split('/seguimiento/')[1];
const elegir = (url: string, accion: string) => fetch(`${BASE}/seguimiento/${tok(url)}/medio`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip() }, body: `accion=${accion}` });
const enviar = (url: string, n: number) => {
  const f = new FormData();
  f.set('k', crypto.randomUUID());
  f.set('archivo', new Blob([jpeg(300 + n, false)], { type: 'image/jpeg' }), 'c.jpg');
  return fetch(`${BASE}/seguimiento/${tok(url)}/comprobante`, { method: 'POST', redirect: 'manual', headers: { 'cf-connecting-ip': ip() }, body: f });
};

const T: any = {};
let A: Api;
async function nuevaOT(estado?: string) {
  const ot = (await A.post('/api/ordenes', { cliente_id: T.cli.id, vehiculo_id: T.veh.id, falla_reportada: 'x', items: [{ tipo: 'libre', descripcion: 'Trabajo', cantidad: 1, precio_unitario: 10_000_000 }] })).body;
  const url = (await A.get(`/api/ordenes/${ot.id}/seguimiento`)).body.url as string;
  await A.post(`/api/ordenes/${ot.id}/pago-cliente/importe`, { informar: true });
  if (estado) await A.post(`/api/ordenes/${ot.id}/estado`, { estado });
  return { id: ot.id as string, url };
}
const tablero = async (api: Api = A) => (await api.get('/api/ordenes?estado=todas&limite=500')).body as any[];
const pago = async (id: string, api: Api = A) => (await tablero(api)).find((o) => o.id === id)?.pago;
const comps = async (id: string) => (await A.get(`/api/ordenes/${id}/pago-cliente`)).body.comprobantes as any[];

beforeAll(async () => {
  T.a = await nuevoTaller('Taller Tablero', 6);
  A = T.a.api;
  T.rec = await nuevoPersonal(A, 'recepcion');
  T.mec = await nuevoPersonal(A, 'mecanico');
  T.cli = (await A.post('/api/clientes', { nombre: 'Cliente Tablero' })).body;
  T.veh = (await A.post('/api/vehiculos', { cliente_id: T.cli.id, patente: 'TAB123' })).body;
  await A.post('/api/caja/abrir', { saldo_inicial: 0 });
  const cu = (await A.post('/api/bancos/cuentas', { nombre: 'Principal', banco: 'Banco T', alias: 'tablero.pagos', titular: 'Taller T' })).body;
  await A.put(`/api/bancos/cuentas/${cu.id}/portal`, { publicar: true });
});

describe('indicador de pago del tablero', () => {
  it('sin medio seleccionado: pago nulo (tarjeta blanca) y el estado de reparación es independiente', async () => {
    const o = await nuevaOT('en_reparacion');
    expect(await pago(o.id)).toBeNull();
    await elegir(o.url, 'efectivo');
    const fila = (await tablero()).find((x) => x.id === o.id);
    expect(fila.estado).toBe('en_reparacion');
    expect(fila.pago).toEqual({ medio: 'efectivo', estado: null });
  });
  it('transferencia: sin comprobante → pendiente → rechazado → nuevo pendiente → verificado', async () => {
    const o = await nuevaOT();
    await elegir(o.url, 'transferencia');
    expect(await pago(o.id)).toEqual({ medio: 'transferencia', estado: 'sin_comprobante' });
    await enviar(o.url, 1);
    expect(await pago(o.id)).toEqual({ medio: 'transferencia', estado: 'pendiente' });
    const c1 = (await comps(o.id))[0];
    await A.post(`/api/ordenes/${o.id}/comprobantes/${c1.id}/rechazar`, { motivo: 'No figura' });
    expect(await pago(o.id)).toEqual({ medio: 'transferencia', estado: 'rechazado' });
    await enviar(o.url, 2);
    expect(await pago(o.id)).toEqual({ medio: 'transferencia', estado: 'pendiente' }); // el nuevo reemplaza al rechazo viejo
    const c2 = (await comps(o.id))[0];
    expect((await A.post(`/api/ordenes/${o.id}/comprobantes/${c2.id}/confirmar`, {})).status).toBe(201);
    expect(await pago(o.id)).toEqual({ medio: 'transferencia', estado: 'verificado' });
  });
  it('un comprobante verificado por un pago parcial NO marca la OT como verificada', async () => {
    const o = await nuevaOT();
    await elegir(o.url, 'transferencia');
    await enviar(o.url, 3);
    const c = (await comps(o.id))[0];
    await A.post(`/api/ordenes/${o.id}/comprobantes/${c.id}/confirmar`, { importe: 4_000_000 });
    expect(await pago(o.id)).toEqual({ medio: 'transferencia', estado: 'sin_comprobante' });
    await enviar(o.url, 4);
    expect((await pago(o.id)).estado).toBe('pendiente');
  });
  it('cambiar de transferencia a efectivo cambia el indicador', async () => {
    const o = await nuevaOT();
    await elegir(o.url, 'transferencia');
    await enviar(o.url, 5);
    expect((await pago(o.id)).medio).toBe('transferencia');
    await elegir(o.url, 'efectivo');
    expect(await pago(o.id)).toEqual({ medio: 'efectivo', estado: null });
  });
  it('sin permiso financiero la respuesta no trae ningún dato de pago (mecánico), con permiso sí (recepción)', async () => {
    const o = await nuevaOT();
    await elegir(o.url, 'efectivo');
    const mecId = (await A.get('/api/mecanicos')).body.find((m: any) => m.usuario_id === T.mec.id).id;
    const orden = (await A.get(`/api/ordenes/${o.id}`)).body;
    await A.put(`/api/ordenes/${o.id}`, { cliente_id: orden.cliente_id, vehiculo_id: orden.vehiculo_id, mecanico_id: mecId, falla_reportada: 'x', version: orden.version, items: orden.items.map((i: any) => ({ tipo: i.tipo, descripcion: i.descripcion, cantidad: i.cantidad, precio_unitario: i.precio_unitario })) });
    const lista = (await T.mec.api.get('/api/ordenes?estado=todas')).body as any[];
    expect(lista.map((x) => x.id)).toContain(o.id);
    for (const x of lista) expect('pago' in x).toBe(false);
    expect(JSON.stringify(lista)).not.toContain('efectivo');
    expect((await pago(o.id, T.rec.api))).toEqual({ medio: 'efectivo', estado: null });
  });
});
