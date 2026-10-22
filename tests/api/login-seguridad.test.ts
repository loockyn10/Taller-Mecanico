// Sprint 13: protección del inicio de sesión (límites por origen, por cuenta y por cuenta+origen), respuestas uniformes, bloqueos temporales que
// nunca dejan afuera a la persona legítima y registro de eventos de seguridad sin datos sensibles.
import { describe, expect, it } from 'vitest';
import { Api, consultaLocal, nuevoTaller, platformHeaders, sqlLocal } from './cliente';

const CLAVE = 'clave-segura-1';
const mala = (a: Api, email: string) => a.post('/api/auth/login', { email, password: 'incorrecta-123' });
const buena = (a: Api, email: string) => a.post('/api/auth/login', { email, password: CLAVE });
const desde = (ip: string) => {
  const a = new Api();
  a.ip = ip;
  return a;
};

describe('respuestas uniformes (sin enumeración de usuarios)', () => {
  it('un correo inexistente y una contraseña incorrecta responden exactamente lo mismo', async () => {
    const t = await nuevoTaller('Taller Uniforme');
    const a = await mala(desde('192.0.2.10'), t.email);
    const b = await mala(desde('192.0.2.11'), 'nadie-existe@test.local');
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(b.body).toEqual(a.body);
    expect(a.body.error.code).toBe('credenciales_invalidas');
  });

  it('el bloqueo se aplica igual exista o no la cuenta (no revela cuáles existen)', async () => {
    const t = await nuevoTaller('Taller Bloqueo Uniforme');
    const ra = desde('192.0.2.20');
    const rb = desde('192.0.2.21');
    for (let i = 0; i < 5; i++) {
      await mala(ra, t.email);
      await mala(rb, 'fantasma@test.local');
    }
    const a = await mala(ra, t.email);
    const b = await mala(rb, 'fantasma@test.local');
    expect(a.status).toBe(429);
    expect(b.status).toBe(429);
    expect(b.body).toEqual(a.body);
    // Ni siquiera con la contraseña correcta mientras dura el bloqueo desde ese origen
    expect((await buena(ra, t.email)).status).toBe(429);
  });

  it('una cuenta deshabilitada no se distingue de una inexistente hasta que la contraseña es correcta', async () => {
    const t = await nuevoTaller('Taller Inactivo', 2);
    const email = `inactivo-${Date.now()}@test.local`;
    const u = await t.api.post('/api/taller/usuarios', { nombre: 'Persona Inactiva', email, rol: 'recepcion', password: CLAVE });
    expect(u.status).toBe(201);
    await sqlLocal(`UPDATE usuarios SET activo = 0 WHERE email = '${email}'`);
    const mal = await mala(desde('192.0.2.30'), email);
    expect(mal.status).toBe(401);
    expect(mal.body.error.code).toBe('credenciales_invalidas');
    expect((await buena(desde('192.0.2.31'), email)).status).toBe(403);
  });
});

describe('bloqueos temporales razonables', () => {
  it('una persona que se equivoca de clave queda frenada unos minutos, no para siempre', async () => {
    const t = await nuevoTaller('Taller Bloqueo Temporal');
    const a = desde('192.0.2.40');
    for (let i = 0; i < 5; i++) await mala(a, t.email);
    expect((await buena(a, t.email)).status).toBe(429);
    const [b] = await consultaLocal<{ bloqueado_hasta: string }>("SELECT bloqueado_hasta FROM limites_intentos WHERE clave LIKE 'login:co:%' AND bloqueado_hasta IS NOT NULL ORDER BY bloqueado_hasta DESC LIMIT 1");
    expect(Date.parse(b.bloqueado_hasta) - Date.now()).toBeLessThan(16 * 60_000); // 15 minutos, no permanente
    // Vence el bloqueo (simulado): vuelve a poder entrar y el contador queda en cero
    await sqlLocal("UPDATE limites_intentos SET bloqueado_hasta = '2020-01-01T00:00:00.000Z' WHERE clave LIKE 'login:%'");
    expect((await buena(a, t.email)).status).toBe(200);
    expect((await consultaLocal<{ n: number }>("SELECT COUNT(*) AS n FROM limites_intentos WHERE clave LIKE 'login:co:%' AND bloqueado_hasta IS NOT NULL AND bloqueado_hasta > '2021'"))[0].n).toBe(0);
  });

  it('un tercero que se equivoca a propósito no deja afuera a la persona legítima en otro origen', async () => {
    const t = await nuevoTaller('Taller Tercero');
    const atacante = desde('192.0.2.50');
    for (let i = 0; i < 6; i++) await mala(atacante, t.email);
    expect((await mala(atacante, t.email)).status).toBe(429);
    const legitima = desde('192.0.2.51');
    expect((await buena(legitima, t.email)).status).toBe(200);
  });

  it('el bloqueo de un origen no alcanza a otras cuentas mientras no abuse (ni a otros orígenes)', async () => {
    const t1 = await nuevoTaller('Taller Origen A');
    const t2 = await nuevoTaller('Taller Origen B');
    const o = desde('192.0.2.60');
    for (let i = 0; i < 5; i++) await mala(o, t1.email);
    expect((await buena(o, t1.email)).status).toBe(429);
    expect((await buena(o, t2.email)).status).toBe(200); // otra cuenta desde el mismo origen
  });

  it('un ataque repartido en muchos orígenes frena a los desconocidos, pero no a un origen desde el que la cuenta ya entró bien', async () => {
    const t = await nuevoTaller('Taller Distribuido');
    const habitual = desde('198.51.100.1');
    expect((await buena(habitual, t.email)).status).toBe(200); // queda como origen conocido
    for (let i = 0; i < 30; i++) await mala(desde(`198.51.100.${10 + i}`), t.email);
    // Desde un origen nuevo, aun con la clave correcta, rige el bloqueo temporal de la cuenta
    expect((await buena(desde('198.51.100.200'), t.email)).status).toBe(429);
    // La persona de siempre, desde su origen habitual, entra con normalidad
    expect((await buena(habitual, t.email)).status).toBe(200);
  });

  it('muchas cuentas probadas desde un mismo origen terminan bloqueando a ese origen', async () => {
    const t = await nuevoTaller('Taller Rociado');
    const spray = desde('203.0.113.7');
    for (let i = 0; i < 25; i++) await mala(spray, `usuario${i}@test.local`);
    expect((await mala(spray, 'otro@test.local')).status).toBe(429);
    expect((await buena(spray, t.email)).status).toBe(429);
    expect((await buena(desde('203.0.113.8'), t.email)).status).toBe(200);
  });

  it('un inicio de sesión correcto reinicia los contadores de la cuenta desde ese origen', async () => {
    const t = await nuevoTaller('Taller Reinicio');
    const a = desde('192.0.2.70');
    for (let i = 0; i < 4; i++) await mala(a, t.email);
    expect((await buena(a, t.email)).status).toBe(200);
    for (let i = 0; i < 4; i++) await mala(a, t.email); // otros 4: sigue sin bloquear porque empezó de cero
    expect((await buena(a, t.email)).status).toBe(200);
  });
});

describe('registro de eventos de seguridad', () => {
  it('deja constancia de fallos y bloqueos sin guardar contraseñas, correos ni IP en claro', async () => {
    const t = await nuevoTaller('Taller Eventos');
    const ip = '192.0.2.80';
    const a = desde(ip);
    for (let i = 0; i < 6; i++) await mala(a, t.email);
    const filas = await consultaLocal<{ tipo: string; origen: string; cuenta: string; detalle: string | null }>('SELECT tipo, origen, cuenta, detalle FROM eventos_seguridad ORDER BY creado_at DESC LIMIT 200');
    const tipos = new Set(filas.map((f) => f.tipo));
    expect(tipos.has('login_fallido')).toBe(true);
    expect(tipos.has('login_bloqueo_aplicado')).toBe(true);
    const todo = JSON.stringify(filas);
    expect(todo).not.toContain(t.email);
    expect(todo).not.toContain(ip);
    expect(todo).not.toContain('incorrecta-123');
    expect(filas.filter((f) => f.origen).every((f) => /^[0-9a-f]{12}$/.test(f.origen))).toBe(true);
    // Y el operador lo ve resumido (sin detalle personal)
    const salud = await new Api().req('GET', '/api/platform/salud', undefined, platformHeaders);
    expect(salud.status).toBe(200);
    expect(salud.body.seguridad.ultimas_24h.login_fallido).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(salud.body)).not.toContain(t.email);
  });

  it('un token de plataforma inválido también queda registrado', async () => {
    const antes = (await consultaLocal<{ n: number }>("SELECT COUNT(*) AS n FROM eventos_seguridad WHERE tipo = 'plataforma_token_invalido'"))[0].n;
    expect((await desde('192.0.2.90').req('GET', '/api/platform/salud', undefined, { authorization: 'Bearer incorrecto-incorrecto' })).status).toBe(401);
    const despues = (await consultaLocal<{ n: number }>("SELECT COUNT(*) AS n FROM eventos_seguridad WHERE tipo = 'plataforma_token_invalido'"))[0].n;
    expect(despues).toBe(antes + 1);
  });
});
