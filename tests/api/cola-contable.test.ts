// Sprint 13: contabilización incremental y recuperable.
// El pedido de contabilizar nace DENTRO de la transacción de la operación (triggers), se procesa por cola, se reintenta si falla y sólo se saca de la cola
// cuando el asiento quedó registrado. Estas pruebas fuerzan los fallos con SQL directo sobre la base local de ensayo (nunca remota).
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, consultaLocal, hoyAR, idem, nuevoTaller, platformHeaders, plataforma, sqlLocal } from './cliente';

let T: Awaited<ReturnType<typeof nuevoTaller>>;
let OTRO: Awaited<ReturnType<typeof nuevoTaller>>;
let api: Api;
let cliente: any;
let clienteOtro: any;

const venta = async (a: Api, clienteId: string, importe: number) => {
  const r = await a.post('/api/ventas', { cliente_id: clienteId, condicion: 'cuenta_corriente', idem_key: idem(), items: [{ tipo: 'libre', descripcion: 'Trabajo', cantidad: 1, precio_unitario: importe }] });
  if (r.status !== 201) throw new Error(`venta falló: ${JSON.stringify(r.body)}`);
  return r.body;
};
const cola = (tallerId = T.tallerId) => consultaLocal<{ origen_tipo: string; origen_id: string; evento: string; estado: string; intentos: number; ultimo_error: string | null; proximo_intento_at: string | null }>(
  `SELECT origen_tipo, origen_id, evento, estado, intentos, ultimo_error, proximo_intento_at FROM contab_cola WHERE taller_id = '${tallerId}' ORDER BY creada_at`,
);
const asientosDe = (id: string) => consultaLocal<{ evento: string; estado: string; total: number }>(`SELECT evento, estado, total FROM asientos WHERE taller_id = '${T.tallerId}' AND origen_id = '${id}' ORDER BY numero`);
const n = async (tabla: string, tallerId = T.tallerId) => (await consultaLocal<{ n: number }>(`SELECT COUNT(*) AS n FROM ${tabla} WHERE taller_id = '${tallerId}'`))[0].n;
const estado = async (a: Api = api, qs = '') => (await a.get(`/api/contabilidad/estado${qs}`)).body;
const bloquearTurno = (tallerId = T.tallerId) => sqlLocal(`UPDATE contab_config SET sync_bloqueo_hasta = '${new Date(Date.now() + 3600_000).toISOString()}' WHERE taller_id = '${tallerId}'`);
const liberarTurno = (tallerId = T.tallerId) => sqlLocal(`UPDATE contab_config SET sync_bloqueo_hasta = NULL WHERE taller_id = '${tallerId}'`);
const inyectarFallo = () => sqlLocal("CREATE TRIGGER IF NOT EXISTS inyectar_fallo BEFORE INSERT ON asientos WHEN NEW.origen_tipo = 'venta' BEGIN SELECT RAISE(ABORT, 'fallo inyectado por la prueba'); END");
const quitarFallo = () => sqlLocal('DROP TRIGGER IF EXISTS inyectar_fallo');
const sinDuplicados = async () =>
  (await consultaLocal<{ n: number }>(`SELECT COUNT(*) AS n FROM (SELECT origen_tipo, origen_id, evento FROM asientos WHERE taller_id = '${T.tallerId}' GROUP BY 1,2,3 HAVING COUNT(*) > 1)`))[0].n;
const descuadrados = async (tallerId = T.tallerId) =>
  (await consultaLocal<{ n: number }>(`SELECT COUNT(*) AS n FROM (SELECT asiento_id FROM asiento_lineas WHERE taller_id = '${tallerId}' GROUP BY asiento_id HAVING SUM(debe) <> SUM(haber))`))[0].n;

beforeAll(async () => {
  T = await nuevoTaller('Taller Cola Contable', 2);
  OTRO = await nuevoTaller('Otro Taller Cola', 2);
  api = T.api;
  cliente = (await api.post('/api/clientes', { nombre: 'Cliente Cola', telefono: '1111' })).body;
  clienteOtro = (await OTRO.api.post('/api/clientes', { nombre: 'Cliente Otro', telefono: '2222' })).body;
  expect((await api.post('/api/contabilidad/activar', {})).status).toBe(200);
  expect((await OTRO.api.post('/api/contabilidad/activar', {})).status).toBe(200);
});

describe('el pedido nace con la operación', () => {
  it('sin activar la contabilidad no se encola nada (la activación sigue siendo explícita)', async () => {
    const libre = await nuevoTaller('Taller Sin Activar');
    const c = (await libre.api.post('/api/clientes', { nombre: 'C Libre', telefono: '1111' })).body;
    await venta(libre.api, c.id, 5000);
    expect(await n('contab_cola', libre.tallerId)).toBe(0);
    expect(await n('contab_config', libre.tallerId)).toBe(0);
  });

  it('si el proceso contable no llega a correr, el pedido queda persistido, la venta existe y después se recupera', async () => {
    await bloquearTurno();
    const antes = await n('asientos');
    const v = await venta(api, cliente.id, 25000);
    // La operación comercial está completa y el pedido quedó en la cola (misma transacción)
    expect(await n('ventas')).toBeGreaterThan(0);
    expect(await asientosDe(v.id)).toHaveLength(0);
    expect(await cola()).toEqual([expect.objectContaining({ origen_tipo: 'venta', origen_id: v.id, evento: 'alta', estado: 'pendiente', intentos: 0 })]);
    expect(await n('asientos')).toBe(antes);
    const e = await estado();
    expect(e).toMatchObject({ al_dia: false, pendientes: 1, cola: { pendientes: 1, fallidas: 0 } });
    expect(e.cola.mas_antigua).toBeTruthy();
    // El comprobante original no se tocó
    expect((await consultaLocal<{ total: number; estado: string }>(`SELECT total, estado FROM ventas WHERE id = '${v.id}'`))[0]).toMatchObject({ total: 25000, estado: 'emitida' });
    // El mantenimiento periódico (el que corre el Cron) también lo recupera cuando el turno se libera: acá lo pedimos por la ruta de plataforma
    await liberarTurno();
    const r = await plataforma.req('POST', '/api/platform/mantenimiento', {}, platformHeaders);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.contable.creados).toBeGreaterThanOrEqual(1);
    expect(await cola()).toHaveLength(0);
    const as = await asientosDe(v.id);
    expect(as).toEqual([expect.objectContaining({ evento: 'alta', estado: 'registrado', total: 25000 })]);
    expect(await sinDuplicados()).toBe(0);
    expect(await descuadrados()).toBe(0);
    expect(await estado()).toMatchObject({ al_dia: true, pendientes: 0 });
  });

  it('pasar dos veces por el mismo pedido no duplica nada', async () => {
    const v = await venta(api, cliente.id, 4000);
    expect((await asientosDe(v.id))).toHaveLength(1);
    const antes = await n('asientos');
    for (let i = 0; i < 3; i++) expect((await api.post('/api/contabilidad/sincronizar', {})).body.creados).toBe(0);
    expect(await n('asientos')).toBe(antes);
    expect(await sinDuplicados()).toBe(0);
  });
});

describe('fallos temporales: la operación no se pierde y hay recuperación', () => {
  it('si el asiento no se puede registrar, el pedido queda con su motivo y una espera; al corregirse se contabiliza', async () => {
    await inyectarFallo();
    const antes = await n('asientos');
    const v = await venta(api, cliente.id, 18000); // la venta se registra igual
    expect(v.id).toBeTruthy();
    expect(await asientosDe(v.id)).toHaveLength(0);
    expect(await n('asientos')).toBe(antes);
    const [p] = await cola();
    expect(p).toMatchObject({ origen_tipo: 'venta', origen_id: v.id, estado: 'pendiente', intentos: 1 });
    expect(p.ultimo_error).toContain('fallo inyectado');
    expect(Date.parse(p.proximo_intento_at!)).toBeGreaterThan(Date.now()); // espera creciente antes del próximo intento automático
    const e = await estado();
    expect(e).toMatchObject({ al_dia: false, pendientes: 1 });
    expect(JSON.stringify((await api.get('/api/contabilidad/cola')).body)).toContain(v.id);
    // La espera todavía no venció: una pasada común no vuelve a intentarlo (no insiste a ciegas)
    await api.post('/api/contabilidad/sincronizar', {});
    expect((await cola())[0].intentos).toBe(1);
    // Se corrige la causa y se pide reintentar (o vence la espera): queda contabilizada, una sola vez
    await quitarFallo();
    const r = await api.post('/api/contabilidad/sincronizar', { reintentar: true });
    expect(r.status).toBe(200);
    expect(r.body.creados).toBe(1);
    expect(await cola()).toHaveLength(0);
    expect(await asientosDe(v.id)).toEqual([expect.objectContaining({ evento: 'alta', estado: 'registrado' })]);
    expect(await sinDuplicados()).toBe(0);
    expect(await estado()).toMatchObject({ al_dia: true });
  });

  it('agotados los reintentos el pedido pasa a "fallida", queda a la vista de la plataforma y se destraba con "reintentar"', async () => {
    await inyectarFallo();
    const v = await venta(api, cliente.id, 9000);
    await sqlLocal(`UPDATE contab_cola SET intentos = 5, proximo_intento_at = NULL WHERE taller_id = '${T.tallerId}' AND origen_id = '${v.id}'`);
    await api.post('/api/contabilidad/sincronizar', {});
    expect((await cola())[0]).toMatchObject({ estado: 'fallida', intentos: 6 });
    const e = await estado();
    expect(e).toMatchObject({ al_dia: false, errores: 1, cola: { pendientes: 0, fallidas: 1 } });
    // Una fallida no se reintenta sola (evita un bucle infinito) y la salud de plataforma lo avisa
    await api.post('/api/contabilidad/sincronizar', {});
    expect((await cola())[0].intentos).toBe(6);
    const salud = (await plataforma.req('GET', '/api/platform/salud', undefined, platformHeaders)).body;
    expect(salud.contabilidad.cola_fallida).toBeGreaterThanOrEqual(1);
    expect(salud.alertas.join(' | ')).toContain('agotaron los reintentos');
    await quitarFallo();
    const r = await api.post('/api/contabilidad/sincronizar', { reintentar: true });
    expect(r.body.creados).toBe(1);
    expect(await cola()).toHaveLength(0);
    expect(await estado()).toMatchObject({ al_dia: true, errores: 0 });
  });

  it('una anulación espera a que se contabilice el alta y deja los dos asientos, que se compensan', async () => {
    await inyectarFallo();
    const v = await venta(api, cliente.id, 12345);
    expect((await api.post(`/api/ventas/${v.id}/anular`, { motivo: 'Error de carga' })).status).toBe(200);
    // Sin alta no hay nada que revertir: la anulación queda esperando (no se descarta)
    expect((await cola()).map((x) => x.evento).sort()).toEqual(['alta', 'anulacion']);
    expect(await asientosDe(v.id)).toHaveLength(0);
    await quitarFallo();
    expect((await api.post('/api/contabilidad/sincronizar', { reintentar: true })).status).toBe(200);
    // Una pasada contabiliza el alta; la anulación puede necesitar la siguiente
    await api.post('/api/contabilidad/sincronizar', {});
    expect((await asientosDe(v.id)).map((x) => `${x.evento}:${x.estado}`)).toEqual(['alta:revertido', 'anulacion:registrado']);
    expect(await cola()).toHaveLength(0);
    expect(await descuadrados()).toBe(0);
    const saldo = await consultaLocal<{ d: number; h: number }>(`SELECT SUM(l.debe) AS d, SUM(l.haber) AS h FROM asiento_lineas l JOIN asientos a ON a.id = l.asiento_id WHERE a.taller_id = '${T.tallerId}' AND a.origen_id = '${v.id}'`);
    expect(saldo[0].d).toBe(saldo[0].h);
  });

  it('anular una venta ya contabilizada deja la cola vacía y los dos asientos', async () => {
    const v = await venta(api, cliente.id, 3000);
    expect((await api.post(`/api/ventas/${v.id}/anular`, { motivo: 'Prueba' })).status).toBe(200);
    expect(await cola()).toHaveLength(0);
    expect((await asientosDe(v.id)).map((x) => x.evento)).toEqual(['alta', 'anulacion']);
  });
});

describe('aislamiento entre talleres', () => {
  it('la cola, el procesamiento y los asientos de cada taller son propios', async () => {
    await bloquearTurno(OTRO.tallerId);
    const vo = await venta(OTRO.api, clienteOtro.id, 7000);
    const vt = await venta(api, cliente.id, 8000); // el taller T no está bloqueado: se contabiliza solo
    expect((await cola(OTRO.tallerId)).map((x) => x.origen_id)).toEqual([vo.id]);
    expect(await cola()).toHaveLength(0);
    // Procesar el taller T no toca el pedido del otro
    await api.post('/api/contabilidad/sincronizar', {});
    expect((await cola(OTRO.tallerId)).map((x) => x.origen_id)).toEqual([vo.id]);
    expect(await asientosDe(vt.id)).toHaveLength(1);
    expect((await consultaLocal<{ n: number }>(`SELECT COUNT(*) AS n FROM asientos WHERE taller_id = '${T.tallerId}' AND origen_id = '${vo.id}'`))[0].n).toBe(0);
    await liberarTurno(OTRO.tallerId);
    expect((await OTRO.api.post('/api/contabilidad/sincronizar', {})).body.creados).toBe(1);
    expect(await cola(OTRO.tallerId)).toHaveLength(0);
    expect(await descuadrados(OTRO.tallerId)).toBe(0);
  });
});

describe('lectura sin escritura', () => {
  it('el estado y la cola se consultan sin escribir nada', async () => {
    const antes = { asientos: await n('asientos'), cola: await n('contab_cola'), corridas: await n('contab_corridas'), cfg: await consultaLocal(`SELECT * FROM contab_config WHERE taller_id = '${T.tallerId}'`) };
    for (const r of ['/api/contabilidad/estado', '/api/contabilidad/estado?detalle=1', '/api/contabilidad/cola', '/api/contabilidad/corridas', '/api/contabilidad/omitidos']) expect((await api.get(r)).status, r).toBe(200);
    expect({ asientos: await n('asientos'), cola: await n('contab_cola'), corridas: await n('contab_corridas'), cfg: await consultaLocal(`SELECT * FROM contab_config WHERE taller_id = '${T.tallerId}'`) }).toEqual(antes);
  });

  it('el estado frecuente es liviano; el detalle por origen se pide aparte', async () => {
    const liviano = await estado();
    expect(liviano.detalle).toBe(false);
    expect(liviano.por_origen).toEqual([]);
    const detallado = await estado(api, '?detalle=1');
    expect(detallado.detalle).toBe(true);
    expect(detallado.por_origen.find((o: any) => o.tipo === 'venta').documentos).toBeGreaterThan(3);
  });
});

describe('reconciliación por lotes (histórico al activar y verificación)', () => {
  it('un historial grande se contabiliza en varias pasadas con progreso recuperable, sin duplicar y sin frenar las operaciones nuevas', async () => {
    const G = await nuevoTaller('Taller Historial Grande', 1);
    const c = (await G.api.post('/api/clientes', { nombre: 'C Grande', telefono: '9999' })).body;
    const total = 430; // más que el tope de una pasada (400)
    for (let i = 0; i < total; i += 10) {
      const rs = await Promise.all(Array.from({ length: Math.min(10, total - i) }, (_, k) => G.api.post('/api/ventas', { cliente_id: c.id, condicion: 'cuenta_corriente', idem_key: idem(), items: [{ tipo: 'libre', descripcion: `V${i + k}`, cantidad: 1, precio_unitario: 1000 + i + k }] })));
      expect(rs.every((r) => r.status === 201)).toBe(true);
    }
    expect(await n('contab_cola', G.tallerId)).toBe(0); // antes de activar no hay cola
    // Activar: primera pasada (tope por pasada), queda pendiente la reconciliación
    const a = await G.api.post('/api/contabilidad/activar', {});
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ reconciliando: true, hayMas: true });
    expect(a.body.creados).toBeLessThanOrEqual(400);
    const e1 = await estado(G.api);
    expect(e1).toMatchObject({ reconciliando: true, al_dia: false });
    expect(e1.asientos).toBe(a.body.creados);
    // Mientras tanto una operación nueva se contabiliza por la cola (no espera a lo histórico)
    const nueva = await venta(G.api, c.id, 555);
    expect((await consultaLocal<{ n: number }>(`SELECT COUNT(*) AS n FROM asientos WHERE taller_id = '${G.tallerId}' AND origen_id = '${nueva.id}'`))[0].n).toBe(1);
    // "Se corta" y se retoma: el progreso está en la base (reconciliar_pendiente), no en la solicitud
    const reanudada = await G.api.post('/api/contabilidad/sincronizar', {});
    expect(reanudada.status).toBe(200);
    expect(reanudada.body.reconciliando).toBe(false);
    const e2 = await estado(G.api, '?detalle=1');
    expect(e2).toMatchObject({ reconciliando: false, al_dia: true, pendientes: 0 });
    expect(e2.ultima_reconciliacion).toBeTruthy();
    expect((await consultaLocal<{ n: number }>(`SELECT COUNT(*) AS n FROM asientos WHERE taller_id = '${G.tallerId}'`))[0].n).toBe(total + 1);
    expect((await consultaLocal<{ n: number }>(`SELECT COUNT(*) AS n FROM (SELECT origen_id FROM asientos WHERE taller_id = '${G.tallerId}' GROUP BY origen_tipo, origen_id, evento HAVING COUNT(*) > 1)`))[0].n).toBe(0);
    expect(await descuadrados(G.tallerId)).toBe(0);
    const numeros = await consultaLocal<{ numero: number }>(`SELECT numero FROM asientos WHERE taller_id = '${G.tallerId}' ORDER BY numero`);
    expect(numeros.map((x) => x.numero)).toEqual(numeros.map((_, i) => i + 1));
    expect(await n('contab_cola', G.tallerId)).toBe(0);
  }, 120_000);

  it('la verificación completa encuentra y contabiliza una operación que nunca llegó a la cola', async () => {
    await bloquearTurno();
    const v = await venta(api, cliente.id, 2222);
    // Pérdida simulada del pedido (por ejemplo, un camino de escritura sin disparador): la red de seguridad lo recupera
    await sqlLocal(`DELETE FROM contab_cola WHERE taller_id = '${T.tallerId}' AND origen_id = '${v.id}'`);
    await liberarTurno();
    expect((await api.post('/api/contabilidad/sincronizar', {})).body.creados).toBe(0); // la cola está vacía: no lo ve
    expect(await asientosDe(v.id)).toHaveLength(0);
    expect((await estado(api, '?detalle=1')).pendientes).toBeGreaterThanOrEqual(1); // pero el detalle sí lo ve
    const r = await api.post('/api/contabilidad/sincronizar', { completa: true });
    expect(r.status).toBe(200);
    expect(r.body.creados).toBe(1);
    expect(r.body.reconciliando).toBe(false);
    expect(await asientosDe(v.id)).toHaveLength(1);
    expect(await estado(api, '?detalle=1')).toMatchObject({ al_dia: true, pendientes: 0 });
  });

  it('el mantenimiento semanal agenda la verificación de los talleres que no la tienen al día', async () => {
    await sqlLocal(`UPDATE contab_config SET reconciliada_at = '2020-01-01T00:00:00.000Z', reconciliar_pendiente = 0 WHERE taller_id = '${T.tallerId}'`);
    const r = await plataforma.req('POST', '/api/platform/mantenimiento', {}, platformHeaders);
    expect(r.status).toBe(200);
    // Se agendó y, en el mismo tick, se avanzó (o quedó pendiente para el siguiente)
    const [c] = await consultaLocal<{ reconciliar_pendiente: number; reconciliada_at: string }>(`SELECT reconciliar_pendiente, reconciliada_at FROM contab_config WHERE taller_id = '${T.tallerId}'`);
    expect(c.reconciliada_at === '2020-01-01T00:00:00.000Z' ? c.reconciliar_pendiente : 1).toBe(1);
    let c2 = c;
    for (let i = 0; i < 5 && c2.reconciliar_pendiente; i++) {
      await plataforma.req('POST', '/api/platform/mantenimiento', {}, platformHeaders);
      [c2] = await consultaLocal<{ reconciliar_pendiente: number; reconciliada_at: string }>(`SELECT reconciliar_pendiente, reconciliada_at FROM contab_config WHERE taller_id = '${T.tallerId}'`);
    }
    expect(c2.reconciliar_pendiente).toBe(0);
    expect(c2.reconciliada_at > '2026').toBe(true);
  });
});

describe('integridad general', () => {
  it('la partida doble, la numeración y los controles contables siguen cerrando', async () => {
    expect(await descuadrados()).toBe(0);
    expect(await sinDuplicados()).toBe(0);
    const numeros = await consultaLocal<{ numero: number }>(`SELECT numero FROM asientos WHERE taller_id = '${T.tallerId}' AND estado <> 'borrador' ORDER BY numero`);
    expect(numeros.map((x) => x.numero)).toEqual(numeros.map((_, i) => i + 1));
    const ctl = (await api.get('/api/contabilidad/controles')).body.controles as any[];
    expect(ctl.find((c) => c.clave === 'partida_doble').estado).toBe('ok');
    expect(hoyAR()).toBeTruthy();
  });
});
