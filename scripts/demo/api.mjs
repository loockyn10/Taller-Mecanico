// Cliente HTTP del generador. Todas las escrituras pasan por la API real del Worker (con sus validaciones y reglas de negocio).
import { dormir } from './util.mjs';

export class ErrorApi extends Error {
  constructor(metodo, ruta, status, cuerpo) {
    super(`${metodo} ${ruta} → ${status}: ${cuerpo?.error?.message ?? JSON.stringify(cuerpo)}`);
    this.status = status;
    this.codigo = cuerpo?.error?.code;
    this.cuerpo = cuerpo;
  }
}

export class Sesion {
  cookie = '';
  escrituras = 0;
  constructor(base, etiqueta = '') {
    this.base = base.replace(/\/$/, '');
    this.etiqueta = etiqueta;
  }

  async req(metodo, ruta, cuerpo, { reintentos } = {}) {
    const esLectura = metodo === 'GET';
    const intentos = reintentos ?? (esLectura ? 3 : 1);
    let ultimo;
    for (let i = 0; i < intentos; i++) {
      try {
        const r = await fetch(`${this.base}/api${ruta}`, {
          method: metodo,
          headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}) },
          body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
        });
        const sc = r.headers.get('set-cookie');
        if (sc) this.cookie = sc.split(';')[0];
        const texto = await r.text();
        let json;
        try { json = JSON.parse(texto); } catch { json = { raw: texto }; }
        if (!r.ok) {
          if (esLectura && r.status >= 500 && i < intentos - 1) { await dormir(400 * (i + 1)); continue; }
          throw new ErrorApi(metodo, ruta, r.status, json);
        }
        if (!esLectura) this.escrituras++;
        return json;
      } catch (e) {
        if (e instanceof ErrorApi) throw e;
        ultimo = e;
        if (i < intentos - 1) await dormir(500 * (i + 1));
      }
    }
    throw new Error(`${metodo} ${ruta}: error de red (${ultimo?.message ?? ultimo})`);
  }
  get = (r) => this.req('GET', r);
  post = (r, b = {}) => this.req('POST', r, b);
  put = (r, b) => this.req('PUT', r, b);
  patch = (r, b) => this.req('PATCH', r, b);

  async login(email, password) {
    await this.req('POST', '/auth/login', { email, password });
    return this;
  }
}

/** Mide la diferencia entre el reloj del servidor (cabecera Date, resolución de 1 s) y el local, para delimitar las jornadas. */
export async function medirReloj(base) {
  let mejor = null;
  let segAnterior = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 2500) {
    const antes = Date.now();
    const r = await fetch(`${base.replace(/\/$/, '')}/api/salud`).catch(() => null);
    const despues = Date.now();
    const d = r?.headers.get('date');
    if (!d) return { skewMs: 0, preciso: false };
    const seg = Math.floor(Date.parse(d) / 1000);
    if (segAnterior !== null && seg !== segAnterior) {
      // el servidor acaba de pasar al segundo `seg`: su reloj valía seg*1000 en algún punto entre `antes` y `despues`
      mejor = seg * 1000 - (antes + despues) / 2;
      break;
    }
    segAnterior = seg;
    await dormir(40);
  }
  return mejor === null ? { skewMs: 0, preciso: false } : { skewMs: mejor, preciso: true };
}
