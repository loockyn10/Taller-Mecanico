// Sprint 11: alta y activación de talleres por invitación (enlace de un solo uso con vencimiento).
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { Api, consultaLocal, nuevoTaller, plataforma, platformHeaders, sqlLocal } from './cliente';

let n = 0;
const ipUnica = () => ({ 'cf-connecting-ip': `10.9.${Math.floor(Math.random() * 250)}.${++n}` });
const invitar = async (extra: Record<string, unknown> = {}) => {
  const r = await plataforma.req('POST', '/api/platform/invitaciones', extra, platformHeaders);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; token: string; enlace: string; vence_at: string };
};
const email = () => `nuevo${++n}-${Date.now()}@taller.test`;
const datos = (token: string, extra: { email?: string; password?: string } = {}) => ({
  token,
  propietario: { nombre: 'Marta Dueña', email: extra.email ?? email(), password: extra.password ?? 'clave-segura-1' },
  taller: { nombre: `Taller Nuevo ${n}`, telefono: '11 5555-0000' },
});
const completar = (token: string, extra: { email?: string; password?: string } = {}, headers: Record<string, string> = ipUnica()) => new Api().req('POST', '/api/activacion/completar', datos(token, extra), headers);
const consultar = (token: string, headers: Record<string, string> = ipUnica()) => new Api().req('POST', '/api/activacion/consultar', { token }, headers);
const talleres = async () => (await plataforma.req('GET', '/api/platform/talleres', undefined, platformHeaders)).body as any[];

describe('generación de invitaciones (solo la plataforma)', () => {
  it('exige el token de plataforma: sin él o con uno incorrecto no se genera nada', async () => {
    expect((await plataforma.req('POST', '/api/platform/invitaciones', {})).status).toBe(401);
    expect((await plataforma.req('POST', '/api/platform/invitaciones', {}, { authorization: 'Bearer cualquier-cosa-que-no-es-el-token' })).status).toBe(401);
    expect((await plataforma.req('GET', '/api/platform/invitaciones')).status).toBe(401);
    // Un usuario común (propietario de un taller) tampoco puede generar licencias
    const { api } = await nuevoTaller('Taller que intenta invitar');
    expect((await api.post('/api/platform/invitaciones', {})).status).toBe(401);
    expect((await api.post('/api/activacion/consultar', {})).status).toBe(400);
  });

  it('el enlace se entrega una sola vez, lleva el token en el fragmento y en la base solo queda su huella', async () => {
    const inv = await invitar({ nombre_sugerido: 'Taller Don Pepe', usuarios_adicionales: 2, dias: 7, notas: 'Venta #123' });
    expect(inv.token.length).toBeGreaterThanOrEqual(40);
    expect(inv.enlace).toMatch(/\/activar#/);
    expect(inv.enlace.endsWith(`#${inv.token}`)).toBe(true);
    expect(Date.parse(inv.vence_at)).toBeGreaterThan(Date.now() + 6 * 86400_000);
    const lista = await plataforma.req('GET', '/api/platform/invitaciones', undefined, platformHeaders);
    expect(JSON.stringify(lista.body)).not.toContain(inv.token);
    expect(lista.body.find((x: any) => x.id === inv.id)).toMatchObject({ estado: 'pendiente', nombre_sugerido: 'Taller Don Pepe', usuarios_adicionales: 2 });
    const fila = (await consultaLocal<{ token_hash: string }>(`SELECT token_hash FROM invitaciones_activacion WHERE id = '${inv.id}'`))[0];
    expect(fila.token_hash).toBe(crypto.createHash('sha256').update(inv.token).digest('hex'));
    expect(fila.token_hash).not.toBe(inv.token);
  });

  it('acota los datos de la invitación', async () => {
    for (const mal of [{ dias: 0 }, { dias: 31 }, { usuarios_adicionales: -1 }, { email: 'no-es-email' }]) {
      expect((await plataforma.req('POST', '/api/platform/invitaciones', mal, platformHeaders)).status, JSON.stringify(mal)).toBe(400);
    }
  });
});

describe('activación', () => {
  it('muestra los datos de la invitación antes de activar y responde igual ante cualquier enlace inválido', async () => {
    const inv = await invitar({ nombre_sugerido: 'Mecánica Rosario', email: 'dueno@rosario.test' });
    const ok = await consultar(inv.token);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ nombre_sugerido: 'Mecánica Rosario', email: 'dueno@rosario.test' });
    const mal = await consultar(crypto.randomBytes(32).toString('base64url'));
    const malFormato = await consultar('corto');
    expect(mal.status).toBe(404);
    expect(malFormato.status).toBe(404);
    expect(mal.body.error.code).toBe('enlace_invalido');
    expect(malFormato.body).toEqual(mal.body);
  });

  it('crea el taller con su licencia, su propietario y sesión iniciada; el taller queda operativo y con el asistente pendiente', async () => {
    const inv = await invitar({ nombre_sugerido: 'Taller Activado', usuarios_adicionales: 3, plan: 'base', notas: 'prueba' });
    const antes = (await talleres()).length;
    const correo = email();
    const api = new Api();
    const r = await api.req('POST', '/api/activacion/completar', datos(inv.token, { email: correo }), ipUnica());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(api.cookie).toContain('fierro_sid');
    expect((await talleres()).length).toBe(antes + 1);
    const me = await api.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.usuario).toMatchObject({ rol: 'propietario', email: correo });
    expect(me.body.taller).toMatchObject({ asistente_pendiente: true, telefono: '11 5555-0000' });
    expect(me.body.licencia).toMatchObject({ plan: 'base', usuarios_incluidos: 1, usuarios_adicionales: 3, estado: 'activa' });
    const lic = await api.get('/api/taller/licencia');
    expect(lic.body.usuarios_max).toBe(4);
    expect(lic.body.eventos.some((e: any) => String(e.detalle).includes(`invitacion:${inv.id}`))).toBe(true);
    // Operativo desde el primer momento: depósito principal, cliente de mostrador, catálogos generales y NINGÚN servicio con precios ajenos
    expect(((await api.get('/api/depositos')).body as any[]).filter((d) => d.es_principal)).toHaveLength(1);
    expect(((await api.get('/api/clientes')).body as any[]).map((c) => c.nombre)).toEqual(['Consumidor final']);
    expect((await api.get('/api/categorias-articulo')).body.length).toBeGreaterThan(0);
    expect((await api.get('/api/marcas')).body.length).toBeGreaterThan(0);
    expect((await api.get('/api/servicios?todos=1')).body).toEqual([]);
    expect(((await api.post('/api/clientes', { nombre: 'Primer cliente' })).status)).toBe(201);
    // La invitación queda usada y asociada al taller
    const lista = (await plataforma.req('GET', '/api/platform/invitaciones', undefined, platformHeaders)).body;
    expect(lista.find((x: any) => x.id === inv.id)).toMatchObject({ estado: 'usada', taller: expect.stringContaining('Taller Nuevo') });
    // y puede volver a ingresar con sus credenciales
    expect((await Api.login(correo, 'clave-segura-1')).cookie).toContain('fierro_sid');
  });

  it('un enlace se usa una sola vez: ni de nuevo, ni dos a la vez', async () => {
    const inv = await invitar();
    const r1 = await completar(inv.token);
    expect(r1.status).toBe(201);
    const antes = (await talleres()).length;
    const r2 = await completar(inv.token);
    expect(r2.status).toBe(404);
    expect((await consultar(inv.token)).status).toBe(404);
    expect((await talleres()).length).toBe(antes);
    // Carrera: dos canjes simultáneos de la misma invitación
    const inv2 = await invitar();
    const antes2 = (await talleres()).length;
    const [a, b] = await Promise.all([completar(inv2.token), completar(inv2.token)]);
    expect([a.status, b.status].sort()).toEqual([201, 404]);
    expect((await talleres()).length).toBe(antes2 + 1);
  });

  it('una invitación vencida o revocada no se puede usar', async () => {
    const vencida = await invitar({ dias: 1 });
    await sqlLocal(`UPDATE invitaciones_activacion SET vence_at = '2020-01-01T00:00:00.000Z' WHERE id = '${vencida.id}'`);
    expect((await consultar(vencida.token)).status).toBe(404);
    expect((await completar(vencida.token)).status).toBe(404);
    const lista = (await plataforma.req('GET', '/api/platform/invitaciones', undefined, platformHeaders)).body;
    expect(lista.find((x: any) => x.id === vencida.id).estado).toBe('vencida');
    const revocada = await invitar();
    expect((await plataforma.req('POST', `/api/platform/invitaciones/${revocada.id}/revocar`, {}, platformHeaders)).status).toBe(200);
    expect((await consultar(revocada.token)).status).toBe(404);
    expect((await completar(revocada.token)).status).toBe(404);
    expect((await plataforma.req('POST', `/api/platform/invitaciones/${revocada.id}/revocar`, {}, platformHeaders)).status).toBe(404);
    const usada = await invitar();
    await completar(usada.token);
    expect((await plataforma.req('POST', `/api/platform/invitaciones/${usada.id}/revocar`, {}, platformHeaders)).status).toBe(404);
  });

  it('una invitación para un correo solo se activa con ese correo', async () => {
    const inv = await invitar({ email: 'Titular@Taller.test' });
    expect((await completar(inv.token, { email: 'otro@taller.test' })).status).toBe(400);
    expect((await completar(inv.token, { email: 'titular@taller.test' })).status).toBe(201);
  });

  it('un correo ya registrado o una contraseña débil no consumen la invitación', async () => {
    const existente = await nuevoTaller('Taller Existente');
    const inv = await invitar();
    expect((await completar(inv.token, { email: existente.email })).status).toBe(409);
    expect((await completar(inv.token, { password: 'corta' })).status).toBe(400);
    const correo = email();
    expect((await completar(inv.token, { email: correo, password: correo })).status).toBe(400);
    expect((await consultar(inv.token)).status).toBe(200); // sigue vigente
    expect((await completar(inv.token)).status).toBe(201);
  });

  it('los intentos con enlaces inválidos se bloquean por origen, sin afectar a otros', async () => {
    const mia = ipUnica();
    for (let i = 0; i < 10; i++) expect((await consultar(crypto.randomBytes(32).toString('base64url'), mia)).status).toBe(404);
    const inv = await invitar();
    const bloqueado = await consultar(inv.token, mia);
    expect(bloqueado.status).toBe(429);
    expect((await completar(inv.token, {}, mia)).status).toBe(429);
    // otra red sigue pudiendo activar
    expect((await completar(inv.token)).status).toBe(201);
  });

  it('el token de plataforma también se protege contra adivinación', async () => {
    const ip = ipUnica();
    for (let i = 0; i < 10; i++) expect((await plataforma.req('GET', '/api/platform/talleres', undefined, { ...ip, authorization: `Bearer intento-${i}-incorrecto-largo` })).status).toBe(401);
    expect((await plataforma.req('GET', '/api/platform/talleres', undefined, { ...ip, ...platformHeaders })).status).toBe(429);
    expect((await plataforma.req('GET', '/api/platform/talleres', undefined, platformHeaders)).status).toBe(200);
  });
});
