// Sprint 12: la contabilidad deja de generarse al consultar. Se activa de forma explícita (y genera lo histórico una sola vez), se mantiene al día
// desde las operaciones comerciales y muestra su estado. Ningún GET escribe.
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, consultaLocal, hoyAR, idem, nuevoPersonal, nuevoTaller, sqlLocal } from './cliente';

let T: Awaited<ReturnType<typeof nuevoTaller>>;
let OTRO: Awaited<ReturnType<typeof nuevoTaller>>;
let api: Api;
const d: Record<string, any> = {};
const periodo = () => `desde=${hoyAR(-30)}&hasta=${hoyAR()}`;

const venta = async (importe: number, extra: Record<string, unknown> = {}) => {
  const r = await api.post('/api/ventas', { cliente_id: d.cliente.id, condicion: 'cuenta_corriente', idem_key: idem(), items: [{ tipo: 'libre', descripcion: 'Trabajo', cantidad: 1, precio_unitario: importe }], ...extra });
  if (r.status !== 201) throw new Error(`venta falló: ${JSON.stringify(r.body)}`);
  return r.body;
};
const n = async (tabla: string, tallerId = T.tallerId) => (await consultaLocal<{ n: number }>(`SELECT COUNT(*) AS n FROM ${tabla} WHERE taller_id = '${tallerId}'`))[0].n;
const estado = async (a: Api = api) => (await a.get('/api/contabilidad/estado')).body;

// Todos los GET contables (los que antes disparaban la sincronización).
const consultas = () => [
  '/api/contabilidad/plan', `/api/contabilidad/diario?${periodo()}`, `/api/contabilidad/balance?${periodo()}`, `/api/contabilidad/estado-resultados?${periodo()}`,
  `/api/contabilidad/resumen-contable?${periodo()}`, '/api/contabilidad/controles', '/api/contabilidad/categorias-gasto', `/api/contabilidad/mayor?${periodo()}&cuenta_id=x`,
];

beforeAll(async () => {
  T = await nuevoTaller('Taller Sync Contable', 6);
  OTRO = await nuevoTaller('Otro Taller Sync', 2);
  api = T.api;
  d.cliente = (await api.post('/api/clientes', { nombre: 'Cliente Sync', telefono: '1111' })).body;
  d.proveedor = (await api.post('/api/proveedores', { nombre: 'Proveedor Sync' })).body;
});

describe('antes de activar: consultar no genera nada', () => {
  it('con operaciones ya cargadas, el estado lo informa y las pantallas contables responden "no activada" sin escribir', async () => {
    await venta(100000);
    await venta(250000);
    const e0 = await estado();
    expect(e0).toMatchObject({ activada: false, cuentas: 0, asientos: 0, al_dia: false });
    expect(e0.por_origen.find((o: any) => o.tipo === 'venta')).toMatchObject({ documentos: 2, contabilizados: 0, pendientes: 2 });
    const antes = { cuentas: await n('cuentas_contables'), asientos: await n('asientos'), config: await n('contab_config'), corridas: await n('contab_corridas'), omitidos: await n('contab_omitidos') };
    expect(antes).toEqual({ cuentas: 0, asientos: 0, config: 0, corridas: 0, omitidos: 0 });
    for (const ruta of consultas()) {
      const r = await api.get(ruta);
      expect(r.status, ruta).toBe(409);
      expect(r.body.error.code, ruta).toBe('contabilidad_no_activada');
    }
    // Ni siquiera el estado ni los registros internos tocan la base
    await api.get('/api/contabilidad/estado');
    await api.get(`/api/contabilidad/libro-ventas?${periodo()}`);
    await api.get('/api/contabilidad/corridas');
    expect({ cuentas: await n('cuentas_contables'), asientos: await n('asientos'), config: await n('contab_config'), corridas: await n('contab_corridas'), omitidos: await n('contab_omitidos') }).toEqual(antes);
  });

  it('tampoco se puede contabilizar a pedido, crear cuentas ni asientos antes de activar', async () => {
    expect((await api.post('/api/contabilidad/sincronizar', {})).status).toBe(409);
    expect((await api.post('/api/contabilidad/cuentas', { codigo: '6.1.80', nombre: 'Prueba', tipo: 'gasto' })).status).toBe(409);
    expect((await api.post('/api/contabilidad/asientos', { fecha: hoyAR(), descripcion: 'Prueba', idem_key: idem(), lineas: [{ cuenta_id: 'a', debe: 1 }, { cuenta_id: 'b', haber: 1 }] })).status).toBe(409);
    expect(await n('asientos')).toBe(0);
    expect(await n('cuentas_contables')).toBe(0);
  });

  it('una operación nueva en un taller sin contabilidad activada no genera asientos', async () => {
    await venta(5000);
    expect(await n('asientos')).toBe(0);
    expect((await estado()).por_origen.find((o: any) => o.tipo === 'venta').pendientes).toBe(3);
  });
});

describe('activación explícita', () => {
  it('requiere permiso de gestión: quien sólo ve la contabilidad no puede activarla', async () => {
    const solo = await nuevoPersonal(api, 'recepcion');
    expect((await solo.api.get('/api/contabilidad/estado')).status).toBe(403);
    const permisos = [...(await api.get(`/api/taller/usuarios/${solo.id}`)).body.permisos, 'contabilidad.ver'];
    expect((await api.put(`/api/taller/usuarios/${solo.id}/permisos`, { permisos })).status).toBe(200);
    expect((await solo.api.get('/api/contabilidad/estado')).status).toBe(200);
    expect((await solo.api.post('/api/contabilidad/activar', {})).status).toBe(403);
    expect((await estado()).activada).toBe(false);
  });

  it('activar crea el plan y contabiliza lo ya operado como histórico, una sola vez', async () => {
    const r = await api.post('/api/contabilidad/activar', {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ activada: true, ya_estaba_activada: false, creados: 3, historicos: 3, omitidos: 0 });
    const e = await estado();
    expect(e).toMatchObject({ activada: true, al_dia: true, pendientes: 0, anulaciones_pendientes: 0, errores: 0, sincronizando: false, asientos: 3 });
    expect(e.cuentas).toBeGreaterThan(50);
    const diario = (await api.get(`/api/contabilidad/diario?${periodo()}&limite=100`)).body;
    expect(diario.asientos).toHaveLength(3);
    expect(diario.asientos.every((a: any) => a.modo === 'historico')).toBe(true);
    // El propietario figura como responsable de la activación
    const aud = (await api.get('/api/taller/auditoria?entidad=contabilidad')).body;
    expect(JSON.stringify(aud)).toContain('activar');
  });

  it('activar de nuevo es inocuo: no duplica asientos ni cambia saldos', async () => {
    const antes = await n('asientos');
    const r = await api.post('/api/contabilidad/activar', {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ya_estaba_activada: true, creados: 0 });
    expect(await n('asientos')).toBe(antes);
    const dup = await consultaLocal<{ n: number }>(`SELECT COUNT(*) AS n FROM (SELECT origen_tipo, origen_id, evento FROM asientos WHERE taller_id = '${T.tallerId}' GROUP BY 1,2,3 HAVING COUNT(*) > 1)`);
    expect(dup[0].n).toBe(0);
  });
});

describe('activada: las consultas no escriben y las operaciones mantienen la contabilidad al día', () => {
  it('ningún GET contable crea asientos, corridas ni cuentas', async () => {
    const plan = (await api.get('/api/contabilidad/plan')).body as any[];
    const caja = plan.find((c) => c.rol === 'caja_efectivo');
    const antes = { asientos: await n('asientos'), corridas: await n('contab_corridas'), cuentas: await n('cuentas_contables'), omitidos: await n('contab_omitidos'), cfg: await consultaLocal(`SELECT ultima_corrida_at FROM contab_config WHERE taller_id = '${T.tallerId}'`) };
    for (const ruta of [...consultas().filter((r) => !r.includes('cuenta_id=x')), `/api/contabilidad/mayor?${periodo()}&cuenta_id=${caja.id}`, '/api/contabilidad/estado', '/api/contabilidad/corridas', '/api/contabilidad/omitidos']) {
      expect((await api.get(ruta)).status, ruta).toBe(200);
    }
    expect({ asientos: await n('asientos'), corridas: await n('contab_corridas'), cuentas: await n('cuentas_contables'), omitidos: await n('contab_omitidos'), cfg: await consultaLocal(`SELECT ultima_corrida_at FROM contab_config WHERE taller_id = '${T.tallerId}'`) }).toEqual(antes);
  });

  it('una venta y su cobro se contabilizan solos, sin abrir la contabilidad', async () => {
    const v = await venta(80000);
    expect(await n('asientos')).toBe(4);
    const c = await api.post('/api/cobros', { cliente_id: d.cliente.id, medios: [{ medio: 'efectivo', importe: 80000 }], aplicaciones: [{ venta_id: v.id, importe: 80000 }], idem_key: idem() });
    expect(c.status).toBe(201);
    const filas = await consultaLocal<{ origen_tipo: string; modo: string }>(`SELECT origen_tipo, modo FROM asientos WHERE taller_id = '${T.tallerId}' ORDER BY numero`);
    expect(filas.map((f) => f.origen_tipo)).toEqual(['venta', 'venta', 'venta', 'venta', 'cobro']);
    expect(filas.slice(3).every((f) => f.modo === 'automatico')).toBe(true);
    expect((await estado()).al_dia).toBe(true);
  });

  it('anular la venta genera el contra-asiento y deja el original sin modificar', async () => {
    const v = await venta(12000);
    const antes = await consultaLocal<{ id: string; estado: string }>(`SELECT id, estado FROM asientos WHERE taller_id = '${T.tallerId}' AND origen_id = '${v.id}'`);
    expect(antes).toHaveLength(1);
    expect((await api.post(`/api/ventas/${v.id}/anular`, { motivo: 'Error de carga' })).status).toBe(200);
    const despues = await consultaLocal<{ evento: string; estado: string }>(`SELECT evento, estado FROM asientos WHERE taller_id = '${T.tallerId}' AND origen_id = '${v.id}' ORDER BY numero`);
    expect(despues.map((x) => x.evento)).toEqual(['alta', 'anulacion']);
    expect(despues[0].estado).toBe('revertido');
    expect((await estado()).al_dia).toBe(true);
  });

  it('el comprobante sigue intacto: la contabilización no modifica ventas ni cobros', async () => {
    const [v] = await consultaLocal<{ total: number; cobrado: number; estado: string }>(`SELECT total, cobrado, estado FROM ventas WHERE taller_id = '${T.tallerId}' ORDER BY numero LIMIT 1`);
    expect(v).toMatchObject({ total: 100000, cobrado: 0, estado: 'emitida' });
  });

  it('muchas operaciones simultáneas no duplican ni pierden asientos', async () => {
    const antes = await n('asientos');
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => api.post('/api/ventas', { cliente_id: d.cliente.id, condicion: 'cuenta_corriente', idem_key: idem(), items: [{ tipo: 'libre', descripcion: `T${i}`, cantidad: 1, precio_unitario: 1000 * (i + 1) }] })));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(await n('asientos')).toBe(antes + 6);
    const dup = await consultaLocal<{ n: number }>(`SELECT COUNT(*) AS n FROM (SELECT origen_tipo, origen_id, evento FROM asientos WHERE taller_id = '${T.tallerId}' GROUP BY 1,2,3 HAVING COUNT(*) > 1)`);
    expect(dup[0].n).toBe(0);
    const numeros = await consultaLocal<{ numero: number }>(`SELECT numero FROM asientos WHERE taller_id = '${T.tallerId}' AND estado <> 'borrador' ORDER BY numero`);
    expect(numeros.map((x) => x.numero)).toEqual(numeros.map((_, i) => i + 1)); // correlativos, sin saltos
    expect((await estado()).al_dia).toBe(true);
    const ctl = Object.fromEntries(((await api.get('/api/contabilidad/controles')).body.controles as any[]).map((c) => [c.clave, c]));
    expect(ctl.partida_doble.estado).toBe('ok');
    expect(ctl.clientes.estado, ctl.clientes.detalle).toBe('ok');
  });
});

describe('estado visible cuando algo queda pendiente', () => {
  it('con otro proceso contabilizando, la operación se hace igual, queda pendiente a la vista y se retoma sola', async () => {
    // Simula un proceso de contabilización en curso (turno tomado hasta dentro de una hora)
    const hasta = new Date(Date.now() + 3600_000).toISOString();
    await sqlLocal(`UPDATE contab_config SET sync_bloqueo_hasta = '${hasta}' WHERE taller_id = '${T.tallerId}'`);
    const antes = await n('asientos');
    const v = await venta(33000);
    expect(v.id).toBeTruthy(); // la operación comercial no depende de la contabilidad
    expect(await n('asientos')).toBe(antes);
    const e = await estado();
    expect(e).toMatchObject({ al_dia: false, sincronizando: true, repeticion_pedida: true, pendientes: 1 });
    // A pedido no se pisan dos procesos
    const pedido = await api.post('/api/contabilidad/sincronizar', {});
    expect(pedido.status).toBe(409);
    expect(pedido.body.error.code).toBe('sincronizacion_en_curso');
    // El turno se libera (el otro proceso terminó o venció): la siguiente pasada contabiliza lo pendiente, una sola vez
    await sqlLocal(`UPDATE contab_config SET sync_bloqueo_hasta = NULL WHERE taller_id = '${T.tallerId}'`);
    const ok = await api.post('/api/contabilidad/sincronizar', {});
    expect(ok.status).toBe(200);
    expect(ok.body.creados).toBe(1);
    expect(await n('asientos')).toBe(antes + 1);
    expect(await estado()).toMatchObject({ al_dia: true, pendientes: 0, sincronizando: false });
    expect((await api.post('/api/contabilidad/sincronizar', {})).body.creados).toBe(0);
  });

  it('un turno vencido (proceso caído) no bloquea para siempre', async () => {
    await sqlLocal(`UPDATE contab_config SET sync_bloqueo_hasta = '2020-01-01T00:00:00.000Z' WHERE taller_id = '${T.tallerId}'`);
    const antes = await n('asientos');
    await venta(7000);
    expect(await n('asientos')).toBe(antes + 1);
    expect((await estado()).sincronizando).toBe(false);
  });
});

describe('aislamiento entre talleres', () => {
  it('cada taller activa y consulta lo suyo', async () => {
    expect((await estado(OTRO.api)).activada).toBe(false);
    expect((await OTRO.api.get('/api/contabilidad/plan')).status).toBe(409);
    expect((await OTRO.api.post('/api/contabilidad/activar', {})).status).toBe(200);
    const e = await estado(OTRO.api);
    expect(e).toMatchObject({ activada: true, asientos: 0, al_dia: true });
    expect(await n('asientos', OTRO.tallerId)).toBe(0);
    // Las operaciones de un taller no se contabilizan en el otro
    await venta(1000);
    expect(await n('asientos', OTRO.tallerId)).toBe(0);
  });
});
