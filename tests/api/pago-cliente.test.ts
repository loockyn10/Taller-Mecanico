// Sprint 25: pago del cliente desde el portal de seguimiento — importe informado, elección del medio de pago, comprobantes de transferencia (R2 simulado en disco),
// verificación administrativa con el cobro real (caja, banco, asientos), cuenta receptora por taller, privacidad del mecánico y aislamiento entre talleres.
import { beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { Api, consultaLocal, hoyAR, nuevoPersonal, nuevoTaller, sqlLocal } from './cliente';
import { PUERTO } from './global-setup';
import { jpeg, pdf, png, tiene, webp } from '../fixtures/archivos';

const BASE = `http://127.0.0.1:${PUERTO}`;
let ipN = 0;
const ipNueva = () => `10.240.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`;

interface Salida { status: number; code: string | null; location: string | null; texto: string; headers: Headers }
const codigoDe = (loc: string | null) => (loc ? new URL(loc, BASE).searchParams.get('m') : null);

async function anonimo(ruta: string, init: RequestInit = {}, ip = ipNueva()): Promise<Salida & { json: any }> {
  const r = await fetch(BASE + ruta, { redirect: 'manual', ...init, headers: { 'cf-connecting-ip': ip, ...(init.headers as Record<string, string>) } });
  const texto = await r.text();
  let json: any = null;
  try { json = JSON.parse(texto); } catch { /* HTML */ }
  const location = r.headers.get('location');
  return { status: r.status, code: codigoDe(location), location, texto, headers: r.headers, json };
}
const tokenDe = (url: string) => url.split('/seguimiento/')[1];
const pagina = (url: string, ip?: string) => anonimo(`/seguimiento/${tokenDe(url)}`, {}, ip);
const datos = async (url: string, ip?: string) => (await anonimo(`/api/seguimiento/${tokenDe(url)}`, {}, ip)).json;

function elegir(url: string, accion: string, ip?: string) {
  return anonimo(`/seguimiento/${tokenDe(url)}/medio`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ accion }).toString() }, ip);
}
interface OpcionesEnvio { nombre?: string; tipo?: string; k?: string; ip?: string; extra?: Record<string, string>; headers?: Record<string, string> }
function enviar(url: string, bytes: Uint8Array | null, o: OpcionesEnvio = {}) {
  const f = new FormData();
  f.set('k', o.k ?? crypto.randomUUID());
  for (const [k, v] of Object.entries(o.extra ?? {})) f.set(k, v);
  if (bytes) f.set('archivo', new Blob([bytes], { type: o.tipo ?? 'image/jpeg' }), o.nombre ?? 'captura.jpg');
  return anonimo(`/seguimiento/${tokenDe(url)}/comprobante`, { method: 'POST', body: f, headers: o.headers }, o.ip);
}
const sql = async <T = any>(q: string) => consultaLocal<T>(q);
const n = async (q: string) => (await sql<{ n: number }>(q))[0].n;

const T: any = {};
const IMPORTE = 28_500_000;
let A: Api;

/** OT nueva del cliente responsable, con su enlace de seguimiento. `informado`: el taller ya informó el importe. */
async function nuevaOT(opts: { informado?: boolean; items?: any[]; cliente?: string } = {}) {
  const items = opts.items ?? [
    { tipo: 'libre', descripcion: 'Cambio de pastillas de freno', cantidad: 1, precio_unitario: 20_000_000 },
    { tipo: 'libre', descripcion: 'Alineación y balanceo', cantidad: 1, precio_unitario: 8_500_000 },
  ];
  const ot = (await A.post('/api/ordenes', { cliente_id: opts.cliente ?? T.cli1.id, vehiculo_id: T.veh.id, falla_reportada: 'Ruido', items })).body;
  const seg = (await A.get(`/api/ordenes/${ot.id}/seguimiento`)).body;
  if (opts.informado !== false) expect((await A.post(`/api/ordenes/${ot.id}/pago-cliente/importe`, { informar: true })).status).toBe(200);
  return { ot, url: seg.url as string, token: tokenDe(seg.url) };
}
/** Reemplaza los ítems de la OT conservando el resto (la API exige la versión vigente). */
async function editarItems(id: string, cambiar: (items: any[]) => any[], extra: Record<string, unknown> = {}) {
  const orden = (await A.get(`/api/ordenes/${id}`)).body;
  const items = cambiar(orden.items.map((i: any) => ({ tipo: i.tipo, descripcion: i.descripcion, cantidad: i.cantidad, precio_unitario: i.precio_unitario })));
  return A.put(`/api/ordenes/${id}`, { cliente_id: orden.cliente_id, vehiculo_id: orden.vehiculo_id, falla_reportada: 'Ruido', version: orden.version, items, ...extra });
}
const vista = async (id: string, api: Api = A) => (await api.get(`/api/ordenes/${id}/pago-cliente`)).body;
const cobrosDe = (ordenId: string) => n(`SELECT COUNT(*) AS n FROM cobros WHERE orden_id = '${ordenId}'`);
const cajaMovs = () => n(`SELECT COUNT(*) AS n FROM caja_movimientos WHERE taller_id = '${T.a.tallerId}' AND origen_tipo = 'cobro'`);
const bancoMovs = () => n(`SELECT COUNT(*) AS n FROM banco_movimientos WHERE taller_id = '${T.a.tallerId}' AND origen_tipo = 'cobro_medio'`);

beforeAll(async () => {
  T.a = await nuevoTaller('Taller Pagos A', 8);
  T.b = await nuevoTaller('Taller Pagos B', 2);
  A = T.a.api;
  T.rec = await nuevoPersonal(A, 'recepcion');
  T.mec = await nuevoPersonal(A, 'mecanico');
  T.caja = await nuevoPersonal(A, 'caja');
  T.dep = await nuevoPersonal(A, 'deposito');
  // El cliente responsable de la OT (Rosario) NO es el titular del vehículo: el vehículo tiene otros clientes vinculados cuyos datos jamás deben aparecer.
  T.cli1 = (await A.post('/api/clientes', { nombre: 'Rosario Ñañez', telefono: '341 555-7788', direccion: 'Calle Falsa 123', email: 'rosario@privado.test' })).body;
  T.titular = (await A.post('/api/clientes', { nombre: 'Titular Anterior Gómez', telefono: '011 4444-9999', direccion: 'Av. Reservada 742' })).body;
  T.veh = (await A.post('/api/vehiculos', { cliente_id: T.titular.id, patente: 'PAG123', anio: 2018 })).body;
  expect([200, 201]).toContain((await A.post('/api/caja/abrir', { saldo_inicial: 0 })).status);
  expect([200, 201]).toContain((await A.post('/api/contabilidad/activar', {})).status);
  // Cuenta bancaria del taller A (aún sin publicar) y una cuenta de otro taller para verificar que nunca se mezclan.
  T.cuenta = (await A.post('/api/bancos/cuentas', { nombre: 'Cuenta Taller A', banco: 'Banco Provincia', alias: 'taller.a.pagos', cbu: '0140000000000000000012', titular: 'Taller A S.R.L.', cuit_titular: '20-12345678-6' })).body;
  T.cuentaB = (await T.b.api.post('/api/bancos/cuentas', { nombre: 'Cuenta Taller B', banco: 'Banco Nación', alias: 'taller.b.secreto', cbu: '0110000000000000000099', titular: 'Taller B S.A.' })).body;
});

describe('1 · importe sin informar / informado (el importe sale de la OT, nunca del cliente)', () => {
  it('sin importe informado: la página dice «Importe pendiente de confirmación», no muestra $0 ni permite elegir ni enviar', async () => {
    const o = await nuevaOT({ informado: false });
    const p = await pagina(o.url);
    expect(p.status).toBe(200);
    expect(p.texto).toContain('Importe pendiente de confirmación por el taller');
    expect(p.texto).not.toContain('$0');
    expect(p.texto).not.toContain('285.000');
    expect(p.texto).not.toContain('¿Cómo querés pagar?');
    const j = await datos(o.url);
    expect(j.pago).toMatchObject({ situacion: 'sin_importe', total: null, pendiente: null, puede_enviar: false, transferencia_disponible: false });
    // Aunque el visitante fuerce las acciones, el servidor las rechaza y no guarda nada.
    expect((await elegir(o.url, 'efectivo')).code).toBe('e_sin_importe');
    expect((await enviar(o.url, jpeg())).code).toBe('e_sin_importe');
    expect(await n(`SELECT COUNT(*) AS n FROM pago_elecciones WHERE orden_id = '${o.ot.id}'`)).toBe(0);
    expect(await n(`SELECT COUNT(*) AS n FROM pago_comprobantes WHERE orden_id = '${o.ot.id}'`)).toBe(0);
  });
  it('una OT con total 0 no se puede informar (no se comunica «gratis»)', async () => {
    const o = await nuevaOT({ informado: false, items: [] });
    expect((await A.post(`/api/ordenes/${o.ot.id}/pago-cliente/importe`, { informar: true })).status).toBe(400);
    expect((await pagina(o.url)).texto).toContain('Importe pendiente de confirmación');
  });
  it('informar el importe exige seguimiento.gestionar + ventas.ver: el mecánico y el depósito no pueden', async () => {
    const o = await nuevaOT({ informado: false });
    expect((await T.mec.api.post(`/api/ordenes/${o.ot.id}/pago-cliente/importe`, { informar: true })).status).toBe(403);
    expect((await T.dep.api.post(`/api/ordenes/${o.ot.id}/pago-cliente/importe`, { informar: true })).status).toBe(403);
    expect((await T.rec.api.post(`/api/ordenes/${o.ot.id}/pago-cliente/importe`, { informar: true })).status).toBe(200);
  });
  it('con importe informado: total y saldo globales SIN desglose; el cliente responsable es el de la OT y no se filtra nada más', async () => {
    const o = await nuevaOT();
    const p = await pagina(o.url);
    expect(p.status).toBe(200);
    expect(p.texto).toContain('$285.000');
    expect(p.texto).toContain('Saldo pendiente');
    // sin desglose ni costos
    for (const x of ['Cambio de pastillas', 'Alineación', '$200.000', '$85.000', 'precio', 'costo', 'margen']) expect(p.texto.toLowerCase()).not.toContain(x.toLowerCase());
    // cliente responsable de la OT; ningún otro dato personal ni otros clientes vinculados
    expect(p.texto).toContain('Rosario Ñañez');
    for (const x of ['Titular Anterior', 'Gómez', '555-7788', '4444-9999', 'Calle Falsa', 'Reservada', 'rosario@privado', 'PAG123']) expect(p.texto, x).not.toContain(x);
    const j = await datos(o.url);
    expect(j.cliente).toEqual({ nombre: 'Rosario Ñañez' });
    expect(j.pago).toMatchObject({ situacion: 'pendiente', total: IMPORTE, abonado: 0, pendiente: IMPORTE });
    expect(Object.keys(j.pago).sort()).toEqual(['abonado', 'comprobantes', 'cuenta', 'limite_envio', 'medio', 'medio_estado', 'pendiente', 'puede_enviar', 'situacion', 'total', 'transferencia_disponible', 'verificacion']);
    const crudo = JSON.stringify(j);
    for (const x of ['Cambio de pastillas', 'taller_id', 'orden_id', 'cliente_id', o.ot.id, T.cli1.id, T.titular.id, T.a.tallerId]) expect(crudo, x).not.toContain(x);
  });
  it('si el importe sube después de informarlo, el cliente ve el nuevo y el taller recibe la advertencia con la diferencia', async () => {
    const o = await nuevaOT();
    const r = await editarItems(o.ot.id, (it) => [...it, { tipo: 'libre', descripcion: 'Líquido de frenos', cantidad: 1, precio_unitario: 1_500_000 }]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const v = await vista(o.ot.id);
    expect(v.importe.total).toBe(IMPORTE + 1_500_000);
    expect(v.importe.informado.importe_cambio).toEqual({ desde: IMPORTE, hasta: IMPORTE + 1_500_000, diferencia: 1_500_000 });
    expect((await pagina(o.url)).texto).toContain('$300.000');
  });
});

describe('2 · elección del medio de pago (no genera cobros)', () => {
  it('efectivo: se registra la elección con el importe pendiente y luego la intención; no hay cobro, caja ni banco', async () => {
    const o = await nuevaOT();
    const cajaAntes = await cajaMovs();
    const r1 = await elegir(o.url, 'efectivo');
    expect(r1.status).toBe(303);
    expect(r1.code).toBe('medio_ok');
    expect(r1.headers.get('cache-control')).toContain('no-store');
    let p = await pagina(o.url);
    expect(p.texto).toContain('Podés pagar en efectivo al retirar tu vehículo');
    expect(p.texto).toContain('Confirmar pago en efectivo');
    expect(await sql(`SELECT medio, estado, importe_total, importe_pendiente FROM pago_elecciones WHERE orden_id = '${o.ot.id}'`)).toEqual([{ medio: 'efectivo', estado: 'seleccionado', importe_total: IMPORTE, importe_pendiente: IMPORTE }]);
    // repetir lo mismo no agrega filas
    expect((await elegir(o.url, 'efectivo')).code).toBe('medio_ok');
    expect(await n(`SELECT COUNT(*) AS n FROM pago_elecciones WHERE orden_id = '${o.ot.id}'`)).toBe(1);
    const r2 = await elegir(o.url, 'confirmar_efectivo');
    expect(r2.code).toBe('efectivo_ok');
    p = await pagina(o.url);
    expect(p.texto).toContain('todavía no figura como pagado');
    expect(p.texto).not.toContain('La reparación está paga');
    // elegir efectivo estando confirmado no lo degrada
    expect((await elegir(o.url, 'efectivo')).code).toBe('medio_ok');
    expect(await sql(`SELECT estado FROM pago_elecciones WHERE orden_id = '${o.ot.id}' ORDER BY created_at, rowid`)).toEqual([{ estado: 'seleccionado' }, { estado: 'confirmado' }]);
    // el taller lo ve: pago previsto en efectivo, pendiente de cobro, saldo intacto
    const v = await vista(o.ot.id);
    expect(v.estado).toMatchObject({ clave: 'medio_seleccionado', detalle: 'Pago previsto en efectivo · Pendiente de cobro' });
    expect(v.eleccion).toMatchObject({ medio: 'efectivo', estado: 'confirmado' });
    expect(v.importe).toMatchObject({ abonado: 0, pendiente: IMPORTE });
    // cero dinero
    expect(await cobrosDe(o.ot.id)).toBe(0);
    expect(await cajaMovs()).toBe(cajaAntes);
    expect((await A.get(`/api/ordenes/${o.ot.id}`)).body.venta_id).toBeNull();
  });
  it('cambiar de idea conserva el historial', async () => {
    const o = await nuevaOT();
    await elegir(o.url, 'efectivo');
    expect((await A.put(`/api/bancos/cuentas/${T.cuenta.id}/portal`, { publicar: true })).status).toBe(200);
    expect((await elegir(o.url, 'transferencia')).code).toBe('medio_ok');
    expect((await elegir(o.url, 'efectivo')).code).toBe('medio_ok');
    const v = await vista(o.ot.id);
    expect(v.historial_elecciones.map((h: any) => h.medio)).toEqual(['efectivo', 'transferencia', 'efectivo']);
  });
  it('valores inventados y acciones inválidas se rechazan sin tocar nada', async () => {
    const o = await nuevaOT();
    for (const accion of ['paypal', '', 'EFECTIVO', 'efectivo; DROP TABLE cobros']) expect((await elegir(o.url, accion)).code).toBe('e_dato');
    expect(await n(`SELECT COUNT(*) AS n FROM pago_elecciones WHERE orden_id = '${o.ot.id}'`)).toBe(0);
  });
  it('la elección y la cuenta nunca vienen del visitante: parámetros extra se ignoran', async () => {
    const o = await nuevaOT();
    const otra = await nuevaOT();
    const r = await anonimo(`/seguimiento/${o.token}/medio`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ accion: 'efectivo', orden_id: otra.ot.id, taller_id: T.b.tallerId, importe: '1', cuenta_id: T.cuentaB.id }).toString() });
    expect(r.code).toBe('medio_ok');
    expect(await n(`SELECT COUNT(*) AS n FROM pago_elecciones WHERE orden_id = '${o.ot.id}'`)).toBe(1);
    expect(await n(`SELECT COUNT(*) AS n FROM pago_elecciones WHERE orden_id = '${otra.ot.id}'`)).toBe(0);
    expect((await sql(`SELECT importe_total FROM pago_elecciones WHERE orden_id = '${o.ot.id}'`))[0].importe_total).toBe(IMPORTE);
  });
});

describe('3 · cuenta receptora por taller', () => {
  it('sin cuenta publicada no se ofrece la transferencia y el servidor la rechaza', async () => {
    const t = await nuevoTaller('Taller sin cuenta', 1);
    const cli = (await t.api.post('/api/clientes', { nombre: 'Cliente X' })).body;
    const veh = (await t.api.post('/api/vehiculos', { cliente_id: cli.id, patente: 'SIN111' })).body;
    const ot = (await t.api.post('/api/ordenes', { cliente_id: cli.id, vehiculo_id: veh.id, falla_reportada: 'x', items: [{ tipo: 'libre', descripcion: 'T', cantidad: 1, precio_unitario: 1_000_000 }] })).body;
    const url = (await t.api.get(`/api/ordenes/${ot.id}/seguimiento`)).body.url;
    await t.api.post(`/api/ordenes/${ot.id}/pago-cliente/importe`, { informar: true });
    const p = await pagina(url);
    expect(p.texto).toContain('value="efectivo"');
    expect(p.texto).not.toContain('value="transferencia"');
    expect((await datos(url)).pago.transferencia_disponible).toBe(false);
    expect((await elegir(url, 'transferencia')).code).toBe('e_sin_cuenta');
    expect((await enviar(url, jpeg())).code).toBe('e_sin_cuenta');
  });
  it('sólo quien gestiona los bancos publica la cuenta; hace falta titular y alias o CBU; una sola por taller', async () => {
    expect((await T.rec.api.put(`/api/bancos/cuentas/${T.cuenta.id}/portal`, { publicar: true })).status).toBe(403);
    expect((await T.mec.api.put(`/api/bancos/cuentas/${T.cuenta.id}/portal`, { publicar: true })).status).toBe(403);
    const sinDatos = (await A.post('/api/bancos/cuentas', { nombre: 'Sin alias', banco: 'Banco X' })).body;
    expect((await A.put(`/api/bancos/cuentas/${sinDatos.id}/portal`, { publicar: true })).status).toBe(400);
    const usd = (await A.post('/api/bancos/cuentas', { nombre: 'Dólares', banco: 'Banco X', alias: 'usd.cuenta', titular: 'Taller A', moneda: 'USD' })).body;
    expect((await A.put(`/api/bancos/cuentas/${usd.id}/portal`, { publicar: true })).status).toBe(400);
    expect((await A.put(`/api/bancos/cuentas/${T.cuenta.id}/portal`, { publicar: true })).status).toBe(200);
    // otra cuenta válida reemplaza a la anterior (a lo sumo una publicada)
    const otra = (await A.post('/api/bancos/cuentas', { nombre: 'Cuenta alternativa', banco: 'Banco Z', alias: 'taller.alterna', titular: 'Taller A S.R.L.' })).body;
    expect((await A.put(`/api/bancos/cuentas/${otra.id}/portal`, { publicar: true })).status).toBe(200);
    expect(await sql(`SELECT id FROM cuentas_bancarias WHERE taller_id = '${T.a.tallerId}' AND publica_en_portal = 1`)).toEqual([{ id: otra.id }]);
    // volver a la principal; despublicar una que no es la publicada no toca a la publicada
    expect((await A.put(`/api/bancos/cuentas/${T.cuenta.id}/portal`, { publicar: true })).status).toBe(200);
    expect((await A.put(`/api/bancos/cuentas/${otra.id}/portal`, { publicar: false })).status).toBe(200);
    expect(await sql(`SELECT id FROM cuentas_bancarias WHERE taller_id = '${T.a.tallerId}' AND publica_en_portal = 1`)).toEqual([{ id: T.cuenta.id }]);
    // cuentas de otro taller: inexistentes para este
    expect((await A.put(`/api/bancos/cuentas/${T.cuentaB.id}/portal`, { publicar: true })).status).toBe(404);
    // la base garantiza la unicidad aunque alguien saltee la API
    await expect(sqlLocal(`UPDATE cuentas_bancarias SET publica_en_portal = 1 WHERE id = '${otra.id}'`)).rejects.toThrow(/UNIQUE/);
    // desactivar la cuenta publicada la baja del portal
    const desact = (await A.post('/api/bancos/cuentas', { nombre: 'Se desactiva', banco: 'Banco D', alias: 'se.desactiva', titular: 'T' })).body;
    await A.put(`/api/bancos/cuentas/${desact.id}/portal`, { publicar: true });
    await A.put(`/api/bancos/cuentas/${desact.id}`, { activa: false });
    expect(await sql(`SELECT publica_en_portal FROM cuentas_bancarias WHERE id = '${desact.id}'`)).toEqual([{ publica_en_portal: 0 }]);
    expect((await A.put(`/api/bancos/cuentas/${T.cuenta.id}/portal`, { publicar: true })).status).toBe(200);
  });
  it('transferencia: el cliente ve SÓLO los datos de la cuenta de su taller (titular, banco, alias, CBU) y no datos innecesarios', async () => {
    expect((await T.b.api.put(`/api/bancos/cuentas/${T.cuentaB.id}/portal`, { publicar: true })).status).toBe(200);
    const o = await nuevaOT();
    expect((await elegir(o.url, 'transferencia')).code).toBe('medio_ok');
    const p = await pagina(o.url);
    for (const x of ['Taller A S.R.L.', 'Banco Provincia', 'taller.a.pagos', '0140000000000000000012', 'Copiar alias', 'Importe pendiente', '$285.000', 'Adjuntar comprobante de transferencia', 'Enviar comprobante']) expect(p.texto, x).toContain(x);
    for (const x of ['taller.b.secreto', 'Banco Nación', '20-12345678-6', 'Cuenta Taller A', 'saldo']) expect(p.texto, x).not.toContain(x);
    const j = await datos(o.url);
    expect(j.pago.cuenta).toEqual({ titular: 'Taller A S.R.L.', banco: 'Banco Provincia', alias: 'taller.a.pagos', cbu: '0140000000000000000012' });
    // el taller B ve la suya
    const clib = (await T.b.api.post('/api/clientes', { nombre: 'Cliente B' })).body;
    const vehb = (await T.b.api.post('/api/vehiculos', { cliente_id: clib.id, patente: 'BBB222' })).body;
    const otb = (await T.b.api.post('/api/ordenes', { cliente_id: clib.id, vehiculo_id: vehb.id, falla_reportada: 'b', items: [{ tipo: 'libre', descripcion: 'T', cantidad: 1, precio_unitario: 500_000 }] })).body;
    const urlB = (await T.b.api.get(`/api/ordenes/${otb.id}/seguimiento`)).body.url;
    await T.b.api.post(`/api/ordenes/${otb.id}/pago-cliente/importe`, { informar: true });
    await elegir(urlB, 'transferencia');
    const pb = await pagina(urlB);
    expect(pb.texto).toContain('taller.b.secreto');
    expect(pb.texto).not.toContain('taller.a.pagos');
  });
});

describe('4 · comprobantes: formatos, tamaño y almacenamiento', () => {
  it('JPG, PNG, WEBP y PDF válidos quedan «pendientes de verificación»; nunca figuran como pagados', async () => {
    const casos: Array<[string, Uint8Array, string, string]> = [
      ['jpg', jpeg(), 'captura.jpg', 'image/jpeg'], ['png', png(), 'captura.PNG', 'image/png'], ['webp', webp(false), 'captura.webp', 'image/webp'], ['pdf', pdf(), 'comprobante.pdf', 'application/pdf'],
    ];
    for (const [ext, bytes, nombre, mime] of casos) {
      const o = await nuevaOT();
      await elegir(o.url, 'transferencia');
      const r = await enviar(o.url, bytes, { nombre, tipo: mime });
      expect(r.status, ext).toBe(303);
      expect(r.code, ext).toBe('comprobante_ok');
      const p = await pagina(o.url);
      expect(p.texto, ext).toContain('Comprobante recibido — pendiente de verificación');
      expect(p.texto, ext).not.toContain('La reparación está paga');
      const v = await vista(o.ot.id);
      expect(v.estado.clave).toBe('comprobante_recibido');
      expect(v.comprobantes).toHaveLength(1);
      expect(v.comprobantes[0]).toMatchObject({ estado: 'pendiente', mime, nombre });
      expect(v.importe).toMatchObject({ abonado: 0, pendiente: IMPORTE });
      expect(await cobrosDe(o.ot.id)).toBe(0); // subir un comprobante no genera cobro
    }
  });
  it('el taller ve el archivo (imagen o PDF) por un endpoint con sesión; el bucket no es público y los metadatos de la foto se quitan', async () => {
    const o = await nuevaOT();
    await elegir(o.url, 'transferencia');
    await enviar(o.url, jpeg(), { nombre: 'foto.jpg' });
    const cp = (await vista(o.ot.id)).comprobantes[0];
    const ver = await fetch(`${BASE}/api/ordenes/${o.ot.id}/comprobantes/${cp.id}/archivo`, { headers: { cookie: A.cookie, 'cf-connecting-ip': A.ip } });
    expect(ver.status).toBe(200);
    expect(ver.headers.get('content-type')).toBe('image/jpeg');
    expect(ver.headers.get('content-disposition')).toMatch(/^inline; filename="comprobante-OT-\d{4}-\d{4}-\d{2}-\d{2}\.jpg"$/);
    expect(ver.headers.get('cache-control')).toBe('private, no-store');
    expect(ver.headers.get('x-content-type-options')).toBe('nosniff');
    expect(ver.headers.get('content-security-policy')).toContain('sandbox');
    const bytes = new Uint8Array(await ver.arrayBuffer());
    expect(bytes[0]).toBe(0xff);
    expect(tiene(bytes, 'GPSLATITUDE')).toBe(false);
    const des = await fetch(`${BASE}/api/ordenes/${o.ot.id}/comprobantes/${cp.id}/archivo?descargar=1`, { headers: { cookie: A.cookie, 'cf-connecting-ip': A.ip } });
    expect(des.headers.get('content-disposition')).toMatch(/^attachment;/);
    // sin sesión: nada
    expect((await fetch(`${BASE}/api/ordenes/${o.ot.id}/comprobantes/${cp.id}/archivo`)).status).toBe(401);
    // el PDF se sirve como PDF
    const o2 = await nuevaOT();
    await elegir(o2.url, 'transferencia');
    await enviar(o2.url, pdf(), { nombre: 'x.pdf', tipo: 'application/pdf' });
    const cp2 = (await vista(o2.ot.id)).comprobantes[0];
    const pdfResp = await fetch(`${BASE}/api/ordenes/${o2.ot.id}/comprobantes/${cp2.id}/archivo`, { headers: { cookie: A.cookie, 'cf-connecting-ip': A.ip } });
    expect(pdfResp.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await pdfResp.arrayBuffer()).toString('latin1').startsWith('%PDF-')).toBe(true);
    // la vista y la descarga quedan auditadas
    await new Promise((r) => setTimeout(r, 300));
    expect((await sql(`SELECT accion FROM auditoria WHERE entidad_id = '${o.ot.id}' AND accion LIKE 'pago_comprobante_%' ORDER BY rowid`)).map((x: any) => x.accion)).toEqual(expect.arrayContaining(['pago_comprobante_recibido', 'pago_comprobante_visto', 'pago_comprobante_descargado']));
  });
  it('rechaza formatos inválidos aunque el nombre o el tipo declarado parezcan válidos', async () => {
    const o = await nuevaOT();
    await elegir(o.url, 'transferencia');
    const enc = (t: string) => new TextEncoder().encode(t);
    const casos: Array<[string, Uint8Array, string, string]> = [
      ['ejecutable disfrazado', enc('MZ\x90\x00programa'), 'foto.jpg', 'image/jpeg'],
      ['html disfrazado', enc('<html><script>alert(1)</script></html>'), 'foto.png', 'image/png'],
      ['gif', enc('GIF89a....'), 'animado.gif', 'image/gif'],
      ['svg', enc('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'dibujo.svg', 'image/svg+xml'],
      ['extensión no permitida con imagen real', jpeg(), 'foto.exe', 'image/jpeg'],
      ['doble extensión', jpeg(), 'foto.jpg.html', 'image/jpeg'],
      ['pdf con javascript', pdf('/S /JavaScript /JS (app.alert(1))'), 'a.pdf', 'application/pdf'],
      ['jpeg cortado', jpeg().slice(0, 80), 'a.jpg', 'image/jpeg'],
      ['png con crc roto', png(true, 300, 200, true), 'a.png', 'image/png'],
    ];
    for (const [que, bytes, nombre, tipo] of casos) {
      const r = await enviar(o.url, bytes, { nombre, tipo });
      expect(r.status, que).toBe(303);
      expect(['e_formato', 'e_archivo'], `${que}: ${r.code}`).toContain(r.code);
    }
    expect((await enviar(o.url, new Uint8Array(0), { nombre: 'vacio.jpg' })).code).toBe('e_archivo');
    expect((await enviar(o.url, null)).code).toBe('e_dato'); // sin archivo
    expect(await n(`SELECT COUNT(*) AS n FROM pago_comprobantes WHERE orden_id = '${o.ot.id}'`)).toBe(0);
  });
  it('rechaza archivos demasiado grandes (imagen > 8 MB, PDF > 5 MB) sin guardarlos', async () => {
    const o = await nuevaOT();
    await elegir(o.url, 'transferencia');
    expect((await enviar(o.url, jpeg(8_100_000), { nombre: 'gigante.jpg' })).code).toBe('e_tamano');
    const pdfGrande = new Uint8Array(5_200_000);
    pdfGrande.set(pdf());
    expect((await enviar(o.url, pdfGrande, { nombre: 'gigante.pdf', tipo: 'application/pdf' })).code).toBe('e_tamano');
    expect((await enviar(o.url, jpeg(12_000_000), { nombre: 'enorme.jpg' })).code).toBe('e_tamano'); // se descarta por Content-Length antes de leer
    expect(await n(`SELECT COUNT(*) AS n FROM pago_comprobantes WHERE orden_id = '${o.ot.id}'`)).toBe(0);
  });
  it('el nombre que manda el cliente no se usa para nada: se guarda depurado sólo para mostrar y la clave del objeto es interna', async () => {
    const o = await nuevaOT();
    await elegir(o.url, 'transferencia');
    const r = await enviar(o.url, jpeg(), { nombre: '../../../etc/passwd‮<script>alert(1)</script>.jpg' });
    expect(r.code).toBe('comprobante_ok');
    const fila = (await sql<{ id: string; nombre: string }>(`SELECT id, nombre FROM pago_comprobantes WHERE orden_id = '${o.ot.id}'`))[0];
    expect(fila.nombre).not.toMatch(/[\\/‮]/);
    expect(fila.id).toMatch(/^[0-9a-f-]{36}$/);
    // el nombre se muestra siempre escapado en el taller (React) y nunca llega a la página pública
    expect((await pagina(o.url)).texto).not.toContain('passwd');
  });
  it('un envío repetido (mismo formulario o mismo archivo) no duplica el comprobante', async () => {
    const o = await nuevaOT();
    await elegir(o.url, 'transferencia');
    const k = crypto.randomUUID();
    const archivo = jpeg(900, false);
    expect((await enviar(o.url, archivo, { k })).code).toBe('comprobante_ok');
    expect((await enviar(o.url, archivo, { k })).code).toBe('comprobante_dup'); // doble clic / reintento: misma clave
    expect((await enviar(o.url, archivo)).code).toBe('comprobante_dup'); // mismo archivo, otra clave
    expect(await n(`SELECT COUNT(*) AS n FROM pago_comprobantes WHERE orden_id = '${o.ot.id}'`)).toBe(1);
    // varios envíos en paralelo del mismo formulario: uno solo
    const o2 = await nuevaOT();
    await elegir(o2.url, 'transferencia');
    const k2 = crypto.randomUUID();
    const f2 = jpeg(700, false);
    const rs = await Promise.all([1, 2, 3, 4].map(() => enviar(o2.url, f2, { k: k2 })));
    expect(rs.filter((r) => r.code === 'comprobante_ok').length).toBeLessThanOrEqual(1);
    expect(await n(`SELECT COUNT(*) AS n FROM pago_comprobantes WHERE orden_id = '${o2.ot.id}'`)).toBe(1);
  });
  it('límites por orden: 3 pendientes a la vez, 12 en total; y por origen (rate limit)', async () => {
    const o = await nuevaOT();
    await elegir(o.url, 'transferencia');
    for (let i = 0; i < 3; i++) expect((await enviar(o.url, jpeg(300 + i * 11, false))).code).toBe('comprobante_ok');
    expect((await enviar(o.url, jpeg(777, false))).code).toBe('e_pendientes');
    expect((await pagina(o.url)).texto).toContain('Ya tenés comprobantes esperando verificación');
    expect((await pagina(o.url)).texto).not.toContain('type="file"');
    // total de la vida de la orden
    const o2 = await nuevaOT();
    await elegir(o2.url, 'transferencia');
    for (let i = 0; i < 12; i++) {
      const id = crypto.randomUUID();
      await sqlLocal(`INSERT INTO pago_comprobantes (id, taller_id, orden_id, estado, idem_key, mime, bytes, sha256, importe_total, importe_pendiente, revisado_por, revisado_at, motivo_rechazo)
        VALUES ('${id}', '${T.a.tallerId}', '${o2.ot.id}', 'rechazado', 'k-${id}', 'image/jpeg', 10, 'h${i}', ${IMPORTE}, ${IMPORTE}, NULL, '2026-10-28T10:00:00.000Z', 'viejo')`);
    }
    expect((await enviar(o2.url, jpeg(555, false))).code).toBe('e_limite');
    expect((await pagina(o2.url)).texto).toContain('máximo de comprobantes');
    // rate limit por origen: más de 12 envíos en una hora desde la misma IP
    const ip = ipNueva();
    const codigos: string[] = [];
    for (let i = 0; i < 14; i++) codigos.push((await enviar(o.url, jpeg(100 + i, false), { ip })).code ?? '');
    expect(codigos.at(-1)).toBe('e_demasiados');
    expect((await pagina(o.url, ip)).status).toBe(200); // ver la página sigue funcionando
  });
  it('exige origen propio y un cuerpo multipart; las solicitudes entre sitios se rechazan', async () => {
    const o = await nuevaOT();
    await elegir(o.url, 'transferencia');
    const ajeno = await enviar(o.url, jpeg(), { headers: { origin: 'https://sitio-malicioso.example' } });
    expect(ajeno.code).toBe('e_origen');
    const cruzado = await enviar(o.url, jpeg(), { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(cruzado.code).toBe('e_origen');
    const propio = await enviar(o.url, jpeg(444, false), { headers: { origin: BASE, 'sec-fetch-site': 'same-origin' } });
    expect(propio.code).toBe('comprobante_ok');
    // Con `Referrer-Policy: no-referrer` el navegador manda `Origin: null` en un envío al mismo sitio (lo que hace una persona real): se acepta si Sec-Fetch-Site lo confirma…
    expect((await enviar(o.url, jpeg(445, false), { headers: { origin: 'null', 'sec-fetch-site': 'same-origin' } })).code).toBe('comprobante_ok');
    expect((await elegir(o.url, 'efectivo')).code).toBe('medio_ok');
    // …y se rechaza si viene de otro sitio (un iframe aislado de un atacante también manda `null`) o de un subdominio hermano.
    expect((await enviar(o.url, jpeg(446, false), { headers: { origin: 'null', 'sec-fetch-site': 'cross-site' } })).code).toBe('e_origen');
    expect((await enviar(o.url, jpeg(447, false), { headers: { origin: 'null', 'sec-fetch-site': 'same-site' } })).code).toBe('e_origen');
    const medioAjeno = await anonimo(`/seguimiento/${o.token}/medio`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://sitio-malicioso.example' }, body: 'accion=efectivo' });
    expect(medioAjeno.code).toBe('e_origen');
    const noMultipart = await anonimo(`/seguimiento/${o.token}/comprobante`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"k":"x"}' });
    expect(noMultipart.code).toBe('e_dato');
  });
});

describe('5 · tokens: revocados, inválidos y ajenos', () => {
  it('un token inválido o inexistente no opera: 404 idéntico al de la consulta', async () => {
    for (const t of ['x'.repeat(43), 'corto', `${'A'.repeat(42)}%`, 'A'.repeat(60)]) {
      const e1 = await anonimo(`/seguimiento/${t}/medio`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'accion=efectivo' });
      const e2 = await enviar(`/seguimiento/${t}`, jpeg());
      const e3 = await anonimo(`/seguimiento/${t}/logo`);
      for (const e of [e1, e2, e3]) {
        expect(e.status).toBe(404);
        expect(e.texto).toContain('Este enlace no está disponible');
      }
    }
  });
  it('desactivar o regenerar el enlace corta también la elección del medio y el envío de comprobantes', async () => {
    const o = await nuevaOT();
    await elegir(o.url, 'transferencia');
    expect((await enviar(o.url, jpeg(250, false))).code).toBe('comprobante_ok');
    expect((await A.post(`/api/ordenes/${o.ot.id}/seguimiento/desactivar`)).status).toBe(200);
    expect((await elegir(o.url, 'efectivo')).status).toBe(404);
    expect((await enviar(o.url, jpeg(251, false))).status).toBe(404);
    expect(await n(`SELECT COUNT(*) AS n FROM pago_comprobantes WHERE orden_id = '${o.ot.id}'`)).toBe(1);
    // reactivar con el mismo token vuelve a funcionar; regenerar mata el anterior
    await A.post(`/api/ordenes/${o.ot.id}/seguimiento/activar`);
    expect((await elegir(o.url, 'efectivo')).code).toBe('medio_ok');
    const nuevo = (await A.post(`/api/ordenes/${o.ot.id}/seguimiento/regenerar`)).body.url;
    expect((await elegir(o.url, 'efectivo')).status).toBe(404);
    expect((await enviar(o.url, jpeg(252, false))).status).toBe(404);
    expect((await enviar(nuevo, jpeg(253, false))).code).toBe('comprobante_ok');
  });
  it('un token sólo alcanza a su orden: parámetros con otras órdenes se ignoran y los archivos de otras órdenes no se ven desde el taller con otro id', async () => {
    const o1 = await nuevaOT();
    const o2 = await nuevaOT();
    await elegir(o1.url, 'transferencia');
    const r = await enviar(o1.url, jpeg(), { extra: { orden_id: o2.ot.id, taller_id: T.b.tallerId, id: 'otro' } });
    expect(r.code).toBe('comprobante_ok');
    expect(await n(`SELECT COUNT(*) AS n FROM pago_comprobantes WHERE orden_id = '${o1.ot.id}'`)).toBe(1);
    expect(await n(`SELECT COUNT(*) AS n FROM pago_comprobantes WHERE orden_id = '${o2.ot.id}'`)).toBe(0);
    expect((await sql<{ taller_id: string }>(`SELECT taller_id FROM pago_comprobantes WHERE orden_id = '${o1.ot.id}'`))[0].taller_id).toBe(T.a.tallerId);
    const cp = (await vista(o1.ot.id)).comprobantes[0];
    // pedir el comprobante de la orden 1 con la ruta de la orden 2 (mismo taller) no lo entrega
    expect((await A.get(`/api/ordenes/${o2.ot.id}/comprobantes/${cp.id}/archivo`)).status).toBe(404);
    expect((await A.post(`/api/ordenes/${o2.ot.id}/comprobantes/${cp.id}/rechazar`, { motivo: 'cruzado' })).status).toBe(404);
    expect((await A.post(`/api/ordenes/${o2.ot.id}/comprobantes/${cp.id}/confirmar`, {})).status).toBe(404);
    // la página de la orden 2 no muestra nada de la 1
    expect((await datos(o2.url)).pago.comprobantes).toEqual([]);
  });
  it('la página pública y el JSON llevan las cabeceras de privacidad (sin caché, sin indexación, sin Referer) y CSP con nonce', async () => {
    const o = await nuevaOT();
    const p = await pagina(o.url);
    expect(p.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(p.headers.get('x-robots-tag')).toContain('noindex');
    expect(p.headers.get('referrer-policy')).toBe('no-referrer');
    const csp = p.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'self'");
    const nonce = /nonce-([A-Za-z0-9+/=]+)/.exec(csp)![1];
    expect(p.texto).toContain(`<script nonce="${nonce}">`);
    expect((await pagina(o.url)).headers.get('content-security-policy')).not.toContain(nonce); // cambia en cada respuesta
    const j = await anonimo(`/api/seguimiento/${o.token}`);
    expect(j.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    const post = await elegir(o.url, 'efectivo');
    expect(post.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(post.headers.get('referrer-policy')).toBe('no-referrer');
  });
  it('el logotipo del taller se sirve sólo con un enlace activo', async () => {
    const o = await nuevaOT();
    expect((await anonimo(`/seguimiento/${o.token}/logo`)).status).toBe(404); // sin logo cargado
    expect((await pagina(o.url)).texto).toContain('class="logo mono"');
    const logo = 'data:image/jpeg;base64,' + Buffer.from(jpeg(200, false)).toString('base64');
    expect((await A.put('/api/taller/logo', { imagen: logo })).status).toBe(200);
    const img = await fetch(`${BASE}/seguimiento/${o.token}/logo`, { headers: { 'cf-connecting-ip': ipNueva() } });
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/jpeg');
    expect(img.headers.get('cache-control')).toContain('private');
    expect((await pagina(o.url)).texto).toContain(`<img class="logo" src="/seguimiento/${o.token}/logo"`);
    await A.post(`/api/ordenes/${o.ot.id}/seguimiento/desactivar`);
    expect((await anonimo(`/seguimiento/${o.token}/logo`)).status).toBe(404);
    await A.del('/api/taller/logo');
  });
});

describe('6 · verificación administrativa: rechazo y nuevo envío', () => {
  it('rechazar exige un motivo; el cliente lo ve y puede presentar otro; se conserva el historial completo', async () => {
    const o = await nuevaOT();
    await elegir(o.url, 'transferencia');
    await enviar(o.url, jpeg(300, false), { nombre: 'primero.jpg' });
    const cp1 = (await vista(o.ot.id)).comprobantes[0];
    expect((await A.post(`/api/ordenes/${o.ot.id}/comprobantes/${cp1.id}/rechazar`, {})).status).toBe(400);
    expect((await A.post(`/api/ordenes/${o.ot.id}/comprobantes/${cp1.id}/rechazar`, { motivo: 'ab' })).status).toBe(400);
    const rr = await A.post(`/api/ordenes/${o.ot.id}/comprobantes/${cp1.id}/rechazar`, { motivo: 'La transferencia no figura en la cuenta' });
    expect(rr.status).toBe(200);
    expect(rr.body.vista.estado.clave).toBe('comprobante_rechazado');
    // doble clic: idempotente
    expect((await A.post(`/api/ordenes/${o.ot.id}/comprobantes/${cp1.id}/rechazar`, { motivo: 'La transferencia no figura en la cuenta' })).body.duplicado).toBe(true);
    // el cliente lo ve y puede enviar otro
    const p = await pagina(o.url);
    expect(p.texto).toContain('Tu último comprobante fue rechazado');
    expect(p.texto).toContain('La transferencia no figura en la cuenta');
    expect(p.texto).toContain('type="file"');
    expect((await datos(o.url)).pago).toMatchObject({ verificacion: 'comprobante_rechazado', puede_enviar: true });
    expect((await enviar(o.url, jpeg(310, false), { nombre: 'segundo.jpg' })).code).toBe('comprobante_ok');
    const v = await vista(o.ot.id);
    expect(v.comprobantes.map((c: any) => c.estado)).toEqual(['pendiente', 'rechazado']);
    expect(v.comprobantes[1]).toMatchObject({ motivo_rechazo: 'La transferencia no figura en la cuenta' });
    // el archivo rechazado sigue disponible para el taller
    expect((await fetch(`${BASE}/api/ordenes/${o.ot.id}/comprobantes/${cp1.id}/archivo`, { headers: { cookie: A.cookie, 'cf-connecting-ip': A.ip } })).status).toBe(200);
    // un comprobante rechazado no se puede confirmar ni modificar
    expect((await A.post(`/api/ordenes/${o.ot.id}/comprobantes/${cp1.id}/confirmar`, {})).status).toBe(409);
    await expect(sqlLocal(`UPDATE pago_comprobantes SET estado = 'pendiente', motivo_rechazo = NULL, revisado_at = NULL WHERE id = '${cp1.id}'`)).rejects.toThrow(/pago_comprobante_resuelto/);
    await expect(sqlLocal(`DELETE FROM pago_comprobantes WHERE id = '${cp1.id}'`)).rejects.toThrow(/pago_comprobante_inmutable/);
    await expect(sqlLocal(`UPDATE pago_comprobantes SET sha256 = 'x' WHERE id = '${(await vista(o.ot.id)).comprobantes[0].id}'`)).rejects.toThrow(/pago_comprobante_inmutable/);
    await expect(sqlLocal(`UPDATE pago_elecciones SET medio = 'efectivo'`)).rejects.toThrow(/pago_eleccion_inmutable/);
    expect(await cobrosDe(o.ot.id)).toBe(0);
    // quedó auditado quién rechazó y por qué
    const aud = await sql<{ usuario_id: string; detalle: string }>(`SELECT usuario_id, detalle FROM auditoria WHERE entidad_id = '${o.ot.id}' AND accion = 'pago_comprobante_rechazado'`);
    expect(aud).toHaveLength(1);
    expect(aud[0].detalle).toContain('La transferencia no figura');
  });
});

describe('7 · confirmación del cobro: un solo cobro, caja, banco y asiento', () => {
  it('confirmar crea el cobro real (anticipo de la OT) con ingreso de caja, movimiento bancario y asiento; actualiza saldo y página', async () => {
    const o = await nuevaOT();
    await elegir(o.url, 'transferencia');
    await enviar(o.url, jpeg(), { nombre: 'comprobante.jpg' });
    const cp = (await vista(o.ot.id)).comprobantes[0];
    const [caja0, banco0] = [await cajaMovs(), await bancoMovs()];
    const r = await T.caja.api.post(`/api/ordenes/${o.ot.id}/comprobantes/${cp.id}/confirmar`, {});
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ vinculo: 'nuevo', importe: IMPORTE, duplicado: false });
    const cobro = (await sql<any>(`SELECT * FROM cobros WHERE orden_id = '${o.ot.id}'`));
    expect(cobro).toHaveLength(1);
    expect(cobro[0]).toMatchObject({ tipo: 'anticipo', total: IMPORTE, estado: 'registrado', usuario_id: T.caja.id });
    expect(cobro[0].id).toBe(r.body.cobro_id);
    expect(await sql(`SELECT medio, importe, cuenta_id FROM cobro_medios WHERE cobro_id = '${cobro[0].id}'`)).toEqual([{ medio: 'transferencia', importe: IMPORTE, cuenta_id: T.cuenta.id }]);
    expect(await cajaMovs()).toBe(caja0 + 1);
    expect(await bancoMovs()).toBe(banco0 + 1);
    expect(await sql(`SELECT cuenta_id, tipo, importe FROM banco_movimientos WHERE origen_id IN (SELECT id FROM cobro_medios WHERE cobro_id = '${cobro[0].id}')`)).toEqual([{ cuenta_id: T.cuenta.id, tipo: 'ingreso', importe: IMPORTE }]);
    // el comprobante queda confirmado con quién y cuándo
    const v = r.body.vista;
    expect(v.importe).toMatchObject({ abonado: IMPORTE, pendiente: 0 });
    expect(v.estado.clave).toBe('cobro_confirmado');
    expect(v.comprobantes[0]).toMatchObject({ estado: 'confirmado', vinculo: 'nuevo', importe_confirmado: IMPORTE });
    expect(v.comprobantes[0].revisado_por).toMatch(/^caja/);
    expect(v.comprobantes[0].cobro).toMatchObject({ id: cobro[0].id, anulado: false });
    // la página del cliente: paga
    const p = await pagina(o.url);
    expect(p.texto).toContain('La reparación está paga');
    expect(p.texto).not.toContain('¿Cómo querés pagar?');
    expect(p.texto).not.toContain('type="file"');
    expect((await elegir(o.url, 'efectivo')).code).toBe('e_saldado');
    expect((await enviar(o.url, jpeg(901, false))).code).toBe('e_saldado');
    // contabilidad: un asiento por el cobro, balanceado, y los controles en orden
    await A.post('/api/contabilidad/sincronizar', {});
    const diario = (await A.get(`/api/contabilidad/diario?desde=${hoyAR(-2)}&hasta=${hoyAR()}&limite=500&origen=cobro`)).body;
    const propios = (diario.asientos ?? diario).filter((a: any) => a.origen_id === cobro[0].id);
    expect(propios).toHaveLength(1);
    expect(propios[0].lineas.reduce((x: number, l: any) => x + l.debe - l.haber, 0)).toBe(0);
    const ctl = Object.fromEntries((await A.get('/api/contabilidad/controles')).body.controles.map((c: any) => [c.clave, c.estado]));
    for (const k of ['partida_doble', 'caja', 'bancos']) expect(ctl[k], k).toBe('ok');
    // auditoría
    const aud = await sql<{ detalle: string }>(`SELECT detalle FROM auditoria WHERE entidad_id = '${o.ot.id}' AND accion = 'pago_cobro_confirmado'`);
    expect(aud).toHaveLength(1);
    expect(aud[0].detalle).toContain(cobro[0].id);
  });
  it('doble clic, reintentos y confirmaciones simultáneas generan UN solo cobro, un ingreso de caja, un movimiento de banco y un asiento', async () => {
    const o = await nuevaOT();
    await elegir(o.url, 'transferencia');
    await enviar(o.url, jpeg(1200, false));
    const cp = (await vista(o.ot.id)).comprobantes[0];
    const [caja0, banco0] = [await cajaMovs(), await bancoMovs()];
    const url = `/api/ordenes/${o.ot.id}/comprobantes/${cp.id}/confirmar`;
    const rs = await Promise.all([A.post(url, {}), T.caja.api.post(url, {}), A.post(url, {}), A.post(url, {})]);
    for (const r of rs) expect([200, 201]).toContain(r.status);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(rs.map((r) => r.body.cobro_id)).size).toBe(1);
    // reintento posterior
    const otra = await A.post(url, {});
    expect(otra.status).toBe(200);
    expect(otra.body.duplicado).toBe(true);
    expect(await cobrosDe(o.ot.id)).toBe(1);
    expect(await cajaMovs()).toBe(caja0 + 1);
    expect(await bancoMovs()).toBe(banco0 + 1);
    await A.post('/api/contabilidad/sincronizar', {});
    const diario = (await A.get(`/api/contabilidad/diario?desde=${hoyAR(-2)}&hasta=${hoyAR()}&limite=500&origen=cobro`)).body;
    expect((diario.asientos ?? diario).filter((a: any) => a.origen_id === rs[0].body.cobro_id)).toHaveLength(1);
  });
  it('permisos: el mecánico y el depósito no acceden a nada; recepción ve pero no confirma ni rechaza; caja sí', async () => {
    const o = await nuevaOT();
    await elegir(o.url, 'transferencia');
    await enviar(o.url, jpeg(1300, false));
    const cp = (await vista(o.ot.id)).comprobantes[0];
    const base = `/api/ordenes/${o.ot.id}`;
    for (const quien of [T.mec.api, T.dep.api]) {
      expect((await quien.get(`${base}/pago-cliente`)).status).toBe(403);
      expect((await quien.get(`${base}/comprobantes/${cp.id}/archivo`)).status).toBe(403);
      expect((await quien.post(`${base}/comprobantes/${cp.id}/confirmar`, {})).status).toBe(403);
      expect((await quien.post(`${base}/comprobantes/${cp.id}/rechazar`, { motivo: 'no corresponde' })).status).toBe(403);
      expect((await quien.get('/api/ordenes/pagos/pendientes')).status).toBe(403);
      expect((await quien.get('/api/ordenes?comprobantes=pendientes')).status).toBe(403);
    }
    expect((await T.rec.api.get(`${base}/pago-cliente`)).status).toBe(200);
    expect((await T.rec.api.get(`${base}/pago-cliente`)).body.puede.resolver).toBe(false);
    expect((await T.rec.api.post(`${base}/comprobantes/${cp.id}/confirmar`, {})).status).toBe(403);
    expect((await T.rec.api.post(`${base}/comprobantes/${cp.id}/rechazar`, { motivo: 'no corresponde' })).status).toBe(403);
    expect((await fetch(`${BASE}${base}/comprobantes/${cp.id}/archivo`, { headers: { cookie: T.rec.api.cookie, 'cf-connecting-ip': T.rec.api.ip } })).status).toBe(200);
    expect(await cobrosDe(o.ot.id)).toBe(0);
    expect((await T.caja.api.post(`${base}/comprobantes/${cp.id}/confirmar`, {})).status).toBe(201);
    // sin sesión
    expect((await anonimo(`${base}/pago-cliente`)).status).toBe(401);
  });
  it('el mecánico no recibe datos de pago en ninguna respuesta de la orden ni en el PDF de su copia', async () => {
    const o = await nuevaOT();
    await elegir(o.url, 'efectivo');
    await elegir(o.url, 'confirmar_efectivo');
    const mecId = (await A.get('/api/mecanicos')).body.find((m: any) => m.usuario_id === T.mec.id).id;
    expect((await editarItems(o.ot.id, (it) => it, { mecanico_id: mecId })).status).toBe(200);
    const det = JSON.stringify((await T.mec.api.get(`/api/ordenes/${o.ot.id}`)).body);
    for (const x of ['pago_', 'efectivo', 'transferencia', 'comprobante', 'cobro', '285000', 'Rosario']) expect(det.toLowerCase(), x).not.toContain(x.toLowerCase());
    const pdfMec = await fetch(`${BASE}/api/ordenes/${o.ot.id}/pdf?copia=mecanico`, { headers: { cookie: T.mec.api.cookie, 'cf-connecting-ip': T.mec.api.ip } });
    expect(pdfMec.status).toBe(200);
    const crudo = Buffer.from(await pdfMec.arrayBuffer()).toString('latin1');
    for (const x of ['PAGO DEL CLIENTE', 'Efectivo', 'Pendiente de cobro', 'SALDO PENDIENTE', '285.000', 'Rosario']) expect(crudo, x).not.toContain(x);
    // ni siquiera pidiendo ambas copias a un usuario sin ventas.ver (el administrador sí la ve; ver más abajo)
    expect((await fetch(`${BASE}/api/ordenes/${o.ot.id}/pdf?copia=administracion`, { headers: { cookie: T.mec.api.cookie, 'cf-connecting-ip': T.mec.api.ip } })).status).toBe(403);
  });
  it('la copia de administración del PDF muestra medio elegido, estado y saldo; la del mecánico (aun pedida junto) no', async () => {
    const o = await nuevaOT();
    // sin elección todavía: la sección no aparece
    const sin = Buffer.from(await (await fetch(`${BASE}/api/ordenes/${o.ot.id}/pdf?copia=administracion`, { headers: { cookie: A.cookie, 'cf-connecting-ip': A.ip } })).arrayBuffer()).toString('latin1');
    expect(sin).not.toContain('PAGO DEL CLIENTE');
    await elegir(o.url, 'efectivo');
    await elegir(o.url, 'confirmar_efectivo');
    const adm = Buffer.from(await (await fetch(`${BASE}/api/ordenes/${o.ot.id}/pdf?copia=administracion`, { headers: { cookie: A.cookie, 'cf-connecting-ip': A.ip } })).arrayBuffer()).toString('latin1');
    for (const x of ['PAGO DEL CLIENTE', 'Efectivo', 'Pago previsto en efectivo', 'Pendiente de cobro', '285.000']) expect(adm, x).toContain(x);
    const ambas = Buffer.from(await (await fetch(`${BASE}/api/ordenes/${o.ot.id}/pdf?copia=ambas`, { headers: { cookie: A.cookie, 'cf-connecting-ip': A.ip } })).arrayBuffer()).toString('latin1');
    // en el PDF combinado, el bloque de pago aparece una sola vez (sólo en la copia de administración)
    expect(ambas.match(/PAGO DEL CLIENTE/g)).toHaveLength(1);
    const mec = Buffer.from(await (await fetch(`${BASE}/api/ordenes/${o.ot.id}/pdf?copia=mecanico`, { headers: { cookie: A.cookie, 'cf-connecting-ip': A.ip } })).arrayBuffer()).toString('latin1');
    expect(mec).not.toContain('PAGO DEL CLIENTE');
    expect(mec).not.toContain('285.000');
    // recepción (con ventas.ver) también ve el pago en la copia de administración
    const rec = Buffer.from(await (await fetch(`${BASE}/api/ordenes/${o.ot.id}/pdf?copia=administracion`, { headers: { cookie: T.rec.api.cookie, 'cf-connecting-ip': T.rec.api.ip } })).arrayBuffer()).toString('latin1');
    expect(rec).toContain('PAGO DEL CLIENTE');
  });
  it('pagos parciales: se confirma menos que el saldo; el cliente ve total, abonado y pendiente y puede seguir pagando', async () => {
    const o = await nuevaOT();
    await elegir(o.url, 'transferencia');
    await enviar(o.url, jpeg(1500, false));
    const cp = (await vista(o.ot.id)).comprobantes[0];
    expect((await A.post(`/api/ordenes/${o.ot.id}/comprobantes/${cp.id}/confirmar`, { importe: IMPORTE + 1 })).status).toBe(409); // supera el saldo
    expect((await A.post(`/api/ordenes/${o.ot.id}/comprobantes/${cp.id}/confirmar`, { importe: 0 })).status).toBe(400);
    expect(await cobrosDe(o.ot.id)).toBe(0);
    const r = await A.post(`/api/ordenes/${o.ot.id}/comprobantes/${cp.id}/confirmar`, { importe: 10_000_000 });
    expect(r.status).toBe(201);
    expect(r.body.vista.importe).toMatchObject({ total: IMPORTE, abonado: 10_000_000, pendiente: 18_500_000 });
    const p = await pagina(o.url);
    for (const x of ['$285.000', 'Abonado', '$100.000', '$185.000']) expect(p.texto, x).toContain(x);
    expect(p.texto).not.toContain('La reparación está paga');
    expect(p.texto).toContain('Pago confirmado'); // el envío figura confirmado, sin discriminar el monto de cada cobro
    expect((await datos(o.url)).pago).toMatchObject({ situacion: 'pendiente', abonado: 10_000_000, pendiente: 18_500_000, puede_enviar: true });
    // paga el resto con otro comprobante
    expect((await enviar(o.url, jpeg(1501, false))).code).toBe('comprobante_ok');
    const cp2 = (await vista(o.ot.id)).comprobantes[0];
    expect((await A.post(`/api/ordenes/${o.ot.id}/comprobantes/${cp2.id}/confirmar`, {})).body.vista.importe).toMatchObject({ abonado: IMPORTE, pendiente: 0 });
    expect(await cobrosDe(o.ot.id)).toBe(2);
  });
  it('cambio de importe después del comprobante: se advierte, se recalcula el saldo real y no se confirma nada solo', async () => {
    const o = await nuevaOT();
    await elegir(o.url, 'transferencia');
    await enviar(o.url, jpeg(1600, false));
    expect((await editarItems(o.ot.id, (it) => [...it, { tipo: 'libre', descripcion: 'Extra', cantidad: 1, precio_unitario: 3_000_000 }])).status).toBe(200);
    const v = await vista(o.ot.id);
    expect(v.importe).toMatchObject({ total: IMPORTE + 3_000_000, abonado: 0, pendiente: IMPORTE + 3_000_000 });
    expect(v.comprobantes[0]).toMatchObject({ estado: 'pendiente', importe_total: IMPORTE, importe_pendiente: IMPORTE });
    expect(v.comprobantes[0].importe_cambio).toEqual({ desde: IMPORTE, hasta: IMPORTE + 3_000_000, diferencia: 3_000_000 });
    expect(v.eleccion.importe_cambio).toEqual({ desde: IMPORTE, hasta: IMPORTE + 3_000_000, diferencia: 3_000_000 });
    expect(await cobrosDe(o.ot.id)).toBe(0);
    expect((await pagina(o.url)).texto).toContain('$315.000');
    // el historial de lo que el cliente vio al elegir se conserva
    expect(v.historial_elecciones[0]).toMatchObject({ importe_total: IMPORTE, importe_pendiente: IMPORTE });
    // el administrativo confirma lo realmente recibido (el comprobante era por el importe anterior)
    const r = await A.post(`/api/ordenes/${o.ot.id}/comprobantes/${v.comprobantes[0].id}/confirmar`, { importe: IMPORTE });
    expect(r.status).toBe(201);
    expect(r.body.vista.importe).toMatchObject({ abonado: IMPORTE, pendiente: 3_000_000 });
    // los asientos históricos no se modificaron por el cambio de total: sigue habiendo uno por el cobro, por el importe recibido
    const cobro = (await sql<any>(`SELECT total FROM cobros WHERE orden_id = '${o.ot.id}'`))[0];
    expect(cobro.total).toBe(IMPORTE);
  });
  it('con comprobante interno emitido el cobro se aplica a él (no queda como anticipo)', async () => {
    const o = await nuevaOT();
    await elegir(o.url, 'transferencia');
    await enviar(o.url, jpeg(1700, false));
    expect((await A.post(`/api/ordenes/${o.ot.id}/estado`, { estado: 'lista' })).status).toBe(200);
    const venta = (await A.post(`/api/ordenes/${o.ot.id}/comprobante`, { condicion: 'cuenta_corriente' })).body;
    const antes = await vista(o.ot.id);
    expect(antes.importe).toMatchObject({ fuente: 'comprobante', total: IMPORTE, abonado: 0, pendiente: IMPORTE, confirmado: true });
    // con comprobante emitido el importe queda confirmado y no se puede retirar
    expect((await A.post(`/api/ordenes/${o.ot.id}/pago-cliente/importe`, { informar: false })).status).toBe(409);
    const cp = antes.comprobantes[0];
    const r = await A.post(`/api/ordenes/${o.ot.id}/comprobantes/${cp.id}/confirmar`, { importe: 15_000_000 });
    expect(r.status).toBe(201);
    const cobro = (await sql<any>(`SELECT id, tipo FROM cobros WHERE orden_id = '${o.ot.id}'`))[0];
    expect(cobro.tipo).toBe('cobro');
    expect(await sql(`SELECT venta_id, importe FROM cobro_aplicaciones WHERE cobro_id = '${cobro.id}'`)).toEqual([{ venta_id: venta.id, importe: 15_000_000 }]);
    expect((await sql<any>(`SELECT cobrado FROM ventas WHERE id = '${venta.id}'`))[0].cobrado).toBe(15_000_000);
    expect(r.body.vista.importe).toMatchObject({ abonado: 15_000_000, pendiente: IMPORTE - 15_000_000 });
    // la página sigue mostrando el saldo del comprobante, también con la OT lista para retirar
    const p = await pagina(o.url);
    expect(p.texto).toContain('Listo para retirar');
    expect(p.texto).toContain('$135.000');
    expect(p.texto).toContain('$150.000');
  });
  it('si la caja es obligatoria y está cerrada, el comprobante queda pendiente y no se marca nada como cobrado', async () => {
    const t = await nuevoTaller('Taller caja cerrada', 1);
    const ta = t.api;
    const cfg = (await ta.get('/api/taller/config')).body;
    expect((await ta.put('/api/taller/config', { taller: { ...cfg.taller }, config: { ...cfg.config, permitir_stock_negativo: !!cfg.config.permitir_stock_negativo, caja_obligatoria: true } })).status).toBe(200);
    const cuenta = (await ta.post('/api/bancos/cuentas', { nombre: 'Principal', banco: 'Banco Q', alias: 'caja.cerrada', titular: 'Taller Q' })).body;
    await ta.put(`/api/bancos/cuentas/${cuenta.id}/portal`, { publicar: true });
    const cli = (await ta.post('/api/clientes', { nombre: 'Cliente Q' })).body;
    const veh = (await ta.post('/api/vehiculos', { cliente_id: cli.id, patente: 'QQQ111' })).body;
    const ot = (await ta.post('/api/ordenes', { cliente_id: cli.id, vehiculo_id: veh.id, falla_reportada: 'x', items: [{ tipo: 'libre', descripcion: 'T', cantidad: 1, precio_unitario: 2_000_000 }] })).body;
    const url = (await ta.get(`/api/ordenes/${ot.id}/seguimiento`)).body.url;
    await ta.post(`/api/ordenes/${ot.id}/pago-cliente/importe`, { informar: true });
    await elegir(url, 'transferencia');
    await enviar(url, jpeg(1800, false));
    const cp = (await vista(ot.id, ta)).comprobantes[0];
    const r = await ta.post(`/api/ordenes/${ot.id}/comprobantes/${cp.id}/confirmar`, {});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('caja_cerrada');
    const v = await vista(ot.id, ta);
    expect(v.comprobantes[0].estado).toBe('pendiente');
    expect(v.importe.abonado).toBe(0);
    expect(await cobrosDe(ot.id)).toBe(0);
    expect((await pagina(url)).texto).toContain('pendiente de verificación');
    // al abrir la caja, se confirma normalmente
    await ta.post('/api/caja/abrir', { saldo_inicial: 0 });
    expect((await ta.post(`/api/ordenes/${ot.id}/comprobantes/${cp.id}/confirmar`, {})).status).toBe(201);
  });
  it('cuenta inexistente, de otro taller o inactiva: no se confirma y todo sigue pendiente', async () => {
    const o = await nuevaOT();
    await elegir(o.url, 'transferencia');
    await enviar(o.url, jpeg(1900, false));
    const cp = (await vista(o.ot.id)).comprobantes[0];
    for (const cuenta of ['no-existe', T.cuentaB.id]) {
      const r = await A.post(`/api/ordenes/${o.ot.id}/comprobantes/${cp.id}/confirmar`, { cuenta_id: cuenta });
      expect(r.status).toBe(400);
    }
    expect(await cobrosDe(o.ot.id)).toBe(0);
    expect((await vista(o.ot.id)).comprobantes[0].estado).toBe('pendiente');
  });
});

describe('8 · reconocer un cobro ya registrado (sin contabilizarlo dos veces)', () => {
  it('se enlaza el cobro existente: no se crea cobro, caja, banco ni asiento nuevos; un cobro no respalda dos comprobantes', async () => {
    const o = await nuevaOT();
    // el taller ya registró la transferencia como anticipo de la OT
    const anticipo = await A.post('/api/anticipos', { cliente_id: T.cli1.id, orden_id: o.ot.id, medios: [{ medio: 'transferencia', importe: 10_000_000, cuenta_id: T.cuenta.id, referencia: 'Op 123' }], idem_key: `ant-${crypto.randomUUID()}` });
    expect(anticipo.status).toBe(201);
    // ya cuenta como abonado: el cliente ve el saldo real, sin que haga falta confirmar ningún comprobante
    expect((await vista(o.ot.id)).importe).toMatchObject({ abonado: 10_000_000, pendiente: 18_500_000 });
    expect((await datos(o.url)).pago).toMatchObject({ abonado: 10_000_000, pendiente: 18_500_000 });
    await elegir(o.url, 'transferencia');
    await enviar(o.url, jpeg(2000, false));
    await enviar(o.url, jpeg(2001, false));
    const v = await vista(o.ot.id);
    expect(v.cobros_vinculables).toEqual([expect.objectContaining({ id: anticipo.body.id, tipo: 'anticipo', transferido: 10_000_000 })]);
    const [cobros0, caja0, banco0] = [await cobrosDe(o.ot.id), await cajaMovs(), await bancoMovs()];
    const cps = v.comprobantes;
    const r = await A.post(`/api/ordenes/${o.ot.id}/comprobantes/${cps[1].id}/confirmar`, { cobro_id: anticipo.body.id });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ vinculo: 'existente', cobro_id: anticipo.body.id, importe: 10_000_000 });
    expect(await cobrosDe(o.ot.id)).toBe(cobros0);
    expect(await cajaMovs()).toBe(caja0);
    expect(await bancoMovs()).toBe(banco0);
    expect(r.body.vista.importe).toMatchObject({ abonado: 10_000_000, pendiente: 18_500_000 }); // nada se contó dos veces
    expect(r.body.vista.cobros_vinculables).toEqual([]);
    // el mismo cobro no puede respaldar al segundo comprobante
    const otra = await A.post(`/api/ordenes/${o.ot.id}/comprobantes/${cps[0].id}/confirmar`, { cobro_id: anticipo.body.id });
    expect(otra.status).toBe(409);
    expect(otra.body.error.code).toBe('cobro_no_vinculable');
    // cobros de otra orden / de otro cliente no se pueden enlazar
    const ajeno = await nuevaOT();
    const antAjeno = await A.post('/api/anticipos', { cliente_id: T.cli1.id, orden_id: ajeno.ot.id, medios: [{ medio: 'transferencia', importe: 1_000_000, cuenta_id: T.cuenta.id }], idem_key: `ant-${crypto.randomUUID()}` });
    expect((await A.post(`/api/ordenes/${o.ot.id}/comprobantes/${cps[0].id}/confirmar`, { cobro_id: antAjeno.body.id })).status).toBe(409);
    expect((await A.post(`/api/ordenes/${o.ot.id}/comprobantes/${cps[0].id}/confirmar`, { cobro_id: 'inexistente' })).status).toBe(409);
    expect((await A.post(`/api/ordenes/${o.ot.id}/comprobantes/${cps[0].id}/confirmar`, { cobro_id: antAjeno.body.id, importe: 1 })).status).toBe(400);
    // la base impide enlazar el mismo cobro a dos comprobantes aunque se saltee la API
    await expect(sqlLocal(`UPDATE pago_comprobantes SET estado = 'confirmado', cobro_id = '${anticipo.body.id}', importe_confirmado = 1, vinculo = 'existente', revisado_at = '2026-10-28T00:00:00.000Z' WHERE id = '${cps[0].id}'`)).rejects.toThrow(/UNIQUE/);
  });
});

describe('9 · aviso de comprobantes pendientes y aislamiento entre talleres', () => {
  it('el aviso cuenta los pendientes y el listado de órdenes se filtra por ellos', async () => {
    const o = await nuevaOT();
    await elegir(o.url, 'transferencia');
    await enviar(o.url, jpeg(2100, false));
    await enviar(o.url, jpeg(2101, false));
    const antes = (await A.get('/api/ordenes/pagos/pendientes')).body;
    expect(antes.total).toBeGreaterThanOrEqual(2);
    const fila = antes.ordenes.find((x: any) => x.id === o.ot.id);
    expect(fila).toMatchObject({ cantidad: 2, patente: 'PAG123' });
    const lista = (await A.get('/api/ordenes?comprobantes=pendientes')).body;
    expect(lista.map((x: any) => x.id)).toContain(o.ot.id);
    for (const x of lista) expect(antes.ordenes.map((y: any) => y.id)).toContain(x.id);
    // al resolverlos desaparece del aviso
    for (const c of (await vista(o.ot.id)).comprobantes) await A.post(`/api/ordenes/${o.ot.id}/comprobantes/${c.id}/rechazar`, { motivo: 'repetido' });
    expect((await A.get('/api/ordenes?comprobantes=pendientes')).body.map((x: any) => x.id)).not.toContain(o.ot.id);
    expect((await A.get('/api/ordenes/pagos/pendientes')).body.ordenes.map((x: any) => x.id)).not.toContain(o.ot.id);
    // otro taller no ve nada de este
    expect((await T.b.api.get('/api/ordenes/pagos/pendientes')).body.ordenes.map((x: any) => x.id)).not.toContain(o.ot.id);
  });
  it('el taller B no ve ni opera sobre comprobantes, importes ni cuentas del taller A', async () => {
    const o = await nuevaOT();
    await elegir(o.url, 'transferencia');
    await enviar(o.url, jpeg(2200, false));
    const cp = (await vista(o.ot.id)).comprobantes[0];
    const B = T.b.api;
    const base = `/api/ordenes/${o.ot.id}`;
    expect((await B.get(`${base}/pago-cliente`)).status).toBe(404);
    expect((await B.get(`${base}/comprobantes/${cp.id}/archivo`)).status).toBe(404);
    expect((await B.post(`${base}/comprobantes/${cp.id}/confirmar`, {})).status).toBe(404);
    expect((await B.post(`${base}/comprobantes/${cp.id}/rechazar`, { motivo: 'ajeno' })).status).toBe(404);
    expect((await B.post(`${base}/pago-cliente/importe`, { informar: false })).status).toBe(404);
    expect((await B.put(`/api/bancos/cuentas/${T.cuenta.id}/portal`, { publicar: false })).status).toBe(404);
    expect((await vista(o.ot.id)).comprobantes[0].estado).toBe('pendiente');
    // las filas quedan siempre con el taller de la orden
    expect(await n(`SELECT COUNT(*) AS n FROM pago_comprobantes pc JOIN ordenes o ON o.id = pc.orden_id WHERE pc.taller_id <> o.taller_id`)).toBe(0);
    expect(await n(`SELECT COUNT(*) AS n FROM pago_elecciones pe JOIN ordenes o ON o.id = pe.orden_id WHERE pe.taller_id <> o.taller_id`)).toBe(0);
  });
});
