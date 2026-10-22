// Pruebas de capacidad de Fierro sobre una instancia AISLADA y LOCAL (wrangler dev + D1 local en una carpeta temporal) con datos ficticios.
// Nunca apunta a producción: no acepta una URL; levanta su propio Worker en 127.0.0.1 con la medición de D1 activada (MEDIR_D1=1).
//
//   npm run carga -- --modo mixto  --talleres 20 --vus 20 --duracion 30 --historial 100
//   npm run carga -- --modo escala --historiales 0,200,1000,3000
//   npm run carga -- --modo login  --vus 20
//
// Qué mide (por operación): latencia p50/p95/p99, errores, consultas a D1 por solicitud, filas leídas y escritas, tiempo en D1 y en el Worker.
// Qué NO mide: la latencia de red de D1 real (acá la base es SQLite local) ni el escalado horizontal de Cloudflare (acá hay un solo proceso). Ver docs/CAPACIDAD.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { esperarServidor, migrar, wrangler } from '../lib.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
    return acc;
  }, []),
);
const num = (k, d) => (args[k] !== undefined ? Number(args[k]) : d);
const MODO = args.modo ?? 'mixto';
const PUERTO = num('puerto', 8791);
const TALLERES = num('talleres', 10);
const VUS = num('vus', 10);
const DURACION = num('duracion', 20);
const HISTORIAL = num('historial', 100);
const ITER = num('iteraciones', 100000); // igual que producción (wrangler.jsonc)
const SALIDA = args.salida ?? null;
const TOKEN = 'token-de-capacidad-aislado-123456';
const BASE = `http://127.0.0.1:${PUERTO}`;
const aqui = path.dirname(fileURLToPath(import.meta.url));

// ───────────── utilidades ─────────────
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const idem = () => `carga-${process.pid}-${Date.now()}-${++seq}`;
const pct = (xs, p) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const media = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const f1 = (n) => (Math.round(n * 10) / 10).toString();
const hoy = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const hace = (d) => new Date(Date.now() - 3 * 3600_000 - d * 86400_000).toISOString().slice(0, 10);

class Cliente {
  constructor(ip) {
    this.cookie = '';
    this.ip = ip;
  }
  async req(metodo, ruta, cuerpo, extra = {}) {
    const t0 = performance.now();
    let r, texto, status;
    try {
      r = await fetch(BASE + ruta, {
        method: metodo,
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': this.ip, ...(this.cookie ? { cookie: this.cookie } : {}), ...extra },
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
      });
      texto = await r.text();
      status = r.status;
    } catch (e) {
      return { status: 0, ms: performance.now() - t0, body: null, error: e.message, d1: null };
    }
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    let body = texto;
    try {
      body = JSON.parse(texto);
    } catch {
      /* texto */
    }
    const h = (k) => Number(r.headers.get(k) ?? NaN);
    const top = r.headers.get('x-d1-top');
    const d1 = Number.isNaN(h('x-d1-consultas')) ? null : { top: top ? decodeURIComponent(top) : null, consultas: h('x-d1-consultas'), sentencias: h('x-d1-sentencias'), leidas: h('x-d1-filas-leidas'), escritas: h('x-d1-filas-escritas'), msD1: h('x-d1-ms'), msWorker: h('x-worker-ms') };
    return { status, ms: performance.now() - t0, body, d1 };
  }
  get(r) { return this.req('GET', r); }
  post(r, c = {}) { return this.req('POST', r, c); }
}

async function paralelo(items, concurrencia, f) {
  const res = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrencia, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        res[k] = await f(items[k], k);
      }
    }),
  );
  return res;
}

// ───────────── servidor aislado ─────────────
let proc = null;
let estado = null;
async function levantar() {
  estado = fs.mkdtempSync(path.join(os.tmpdir(), 'fierro-carga-'));
  await migrar(estado);
  proc = wrangler(
    ['dev', '--port', String(PUERTO), '--persist-to', estado, '--var', `PLATFORM_ADMIN_TOKEN:${TOKEN}`, '--var', `PBKDF2_ITERATIONS:${ITER}`, '--var', 'CONTAB_SYNC:esperar', '--var', 'MEDIR_D1:1', '--show-interactive-dev-session=false'],
    { stdio: 'pipe' },
  );
  let log = '';
  proc.stdout?.on('data', (d) => (log += d));
  proc.stderr?.on('data', (d) => (log += d));
  try {
    await esperarServidor(`${BASE}/api/salud`, 120_000);
  } catch (e) {
    console.error(log);
    throw e;
  }
}
async function bajar() {
  if (proc) {
    if (process.platform === 'win32') {
      try {
        const { execSync } = await import('node:child_process');
        execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
      } catch { /* ya terminó */ }
    } else proc.kill();
  }
  await dormir(500);
  try {
    fs.rmSync(estado, { recursive: true, force: true });
  } catch { /* Windows puede retener el archivo unos instantes */ }
}

// ───────────── datos ficticios ─────────────
const NOMBRES = ['García', 'López', 'Martínez', 'Rodríguez', 'Fernández', 'Pérez', 'Gómez', 'Díaz', 'Sosa', 'Romero', 'Torres', 'Álvarez', 'Ruiz', 'Acosta', 'Benítez'];
const PIEZAS = ['Filtro de aceite', 'Pastillas de freno', 'Bujía', 'Correa de distribución', 'Amortiguador', 'Batería', 'Filtro de aire', 'Disco de freno', 'Aceite 10W40', 'Kit de embrague'];
const letras = (n, k) => String.fromCharCode(65 + ((n * 7 + k * 3) % 26)) + String.fromCharCode(65 + ((n * 11 + k) % 26));

async function crearTaller(i) {
  const email = `carga${i}-${Date.now()}@ficticio.test`;
  const plat = new Cliente('10.250.0.1');
  const r = await plat.req('POST', '/api/platform/talleres', { nombre: `Taller Ficticio ${i}`, usuarios_adicionales: 0, propietario: { nombre: `Dueño ${i}`, email, password: 'clave-de-carga-1' } }, { authorization: `Bearer ${TOKEN}` });
  if (r.status !== 201) throw new Error(`alta de taller falló: ${JSON.stringify(r.body)}`);
  return { i, email, tallerId: r.body.tallerId };
}

async function sembrar(t, { clientes, articulos, ventas, activarContab }) {
  const c = new Cliente(`10.${100 + (t.i % 100)}.0.1`);
  const lg = await c.post('/api/auth/login', { email: t.email, password: 'clave-de-carga-1' });
  if (lg.status !== 200) throw new Error(`login de siembra falló: ${lg.status}`);
  t.clientes = [];
  t.vehiculos = [];
  t.articulos = [];
  const idxs = (n) => Array.from({ length: n }, (_, k) => k);
  await paralelo(idxs(clientes), 6, async (k) => {
    const r = await c.post('/api/clientes', { nombre: `${NOMBRES[(k + t.i) % NOMBRES.length]} ${k} T${t.i}`, telefono: `11${String(40000000 + k).padStart(8, '0')}`, documento: String(20000000 + t.i * 1000 + k) });
    if (r.status === 201) {
      t.clientes.push(r.body.id);
      const v = await c.post('/api/vehiculos', { cliente_id: r.body.id, patente: `${letras(t.i, k)}${String(100 + (k % 900))}${letras(k, t.i)}`, km_actual: 10000 + k });
      if (v.status === 201) t.vehiculos.push({ id: v.body.id, cliente_id: r.body.id });
    }
  });
  await paralelo(idxs(articulos), 6, async (k) => {
    const r = await c.post('/api/articulos', { nombre: `${PIEZAS[k % PIEZAS.length]} modelo ${k}`, codigo: `A${t.i}-${k}`, costo: 100000 + k * 100, precio: 180000 + k * 150, stock_inicial: 500, stock_minimo: 5 });
    if (r.status === 201) t.articulos.push(r.body.id);
  });
  if (activarContab) {
    const a = await c.post('/api/contabilidad/activar', {});
    if (a.status !== 200) throw new Error(`activar contabilidad falló: ${JSON.stringify(a.body)}`);
  }
  await paralelo(idxs(ventas), 6, async (k) => {
    const cli = t.clientes[k % t.clientes.length];
    const r = await c.post('/api/ventas', {
      cliente_id: cli, condicion: 'cuenta_corriente', idem_key: idem(),
      items: [{ tipo: 'articulo', articulo_id: t.articulos[k % t.articulos.length], descripcion: 'Repuesto', cantidad: 1, precio_unitario: 200000 + k }, { tipo: 'libre', descripcion: 'Mano de obra', cantidad: 1, precio_unitario: 150000 }],
    });
    if (r.status === 201 && k % 2 === 0) await c.post('/api/cobros', { cliente_id: cli, medios: [{ medio: 'efectivo', importe: r.body.total }], aplicaciones: [{ venta_id: r.body.id, importe: r.body.total }], idem_key: idem() });
  });
  return c;
}

// ───────────── flujo de trabajo ─────────────
const OPS = [
  // [nombre, peso, tipo, función]
  ['clientes_consulta', 14, 'lectura', (c, t) => c.get(`/api/clientes?q=${encodeURIComponent(NOMBRES[Math.floor(Math.random() * NOMBRES.length)].slice(0, 4))}`)],
  ['buscador_global', 8, 'lectura', (c) => c.get(`/api/buscar?q=${encodeURIComponent(NOMBRES[Math.floor(Math.random() * NOMBRES.length)].slice(0, 3))}`)],
  ['articulos_busqueda', 14, 'lectura', (c) => c.get(`/api/articulos?q=${encodeURIComponent(PIEZAS[Math.floor(Math.random() * PIEZAS.length)].split(' ')[0])}`)],
  ['ordenes_lista', 8, 'lectura', (c) => c.get('/api/ordenes')],
  ['dashboard', 5, 'lectura', (c) => c.get('/api/dashboard')],
  ['ventas_lista', 4, 'lectura', (c) => c.get('/api/ventas?estado=pendientes')],
  ['cuentas_corrientes', 3, 'informe', (c) => c.get('/api/cuentas-corrientes')],
  ['informe_ventas', 3, 'informe', (c) => c.get(`/api/informes/ventas?desde=${hace(30)}&hasta=${hoy()}`)],
  ['inventario_valorizado', 2, 'informe', (c) => c.get('/api/inventario/valorizado')],
  ['contab_estado', 4, 'lectura', (c, t) => (t.contab ? c.get('/api/contabilidad/estado') : c.get('/api/auth/me'))],
  ['contab_balance', 2, 'informe', (c, t) => (t.contab ? c.get(`/api/contabilidad/balance?desde=${hace(30)}&hasta=${hoy()}`) : c.get('/api/dashboard'))],
  ['orden_apertura', 8, 'escritura', (c, t) => {
    const v = t.vehiculos[Math.floor(Math.random() * t.vehiculos.length)];
    return c.post('/api/ordenes', { cliente_id: v.cliente_id, vehiculo_id: v.id, falla_reportada: 'Ruido en el tren delantero', items: [] });
  }],
  ['venta', 10, 'escritura', (c, t) => {
    const cli = t.clientes[Math.floor(Math.random() * t.clientes.length)];
    return c.post('/api/ventas', { cliente_id: cli, condicion: 'cuenta_corriente', idem_key: idem(), items: [{ tipo: 'articulo', articulo_id: t.articulos[Math.floor(Math.random() * t.articulos.length)], descripcion: 'Repuesto', cantidad: 1, precio_unitario: 210000 }, { tipo: 'libre', descripcion: 'Mano de obra', cantidad: 1, precio_unitario: 90000 }] });
  }],
  ['cobro', 5, 'escritura', async (c, t) => {
    const lista = await c.get('/api/ventas?estado=pendientes');
    const v = Array.isArray(lista.body) && lista.body.length ? lista.body[Math.floor(Math.random() * Math.min(lista.body.length, 40))] : null;
    if (!v) return { status: 204, ms: 0, d1: null, omitida: true };
    const saldo = v.total - (v.cobrado ?? 0) - (v.devuelto ?? 0);
    return c.post('/api/cobros', { cliente_id: v.cliente_id, medios: [{ medio: 'efectivo', importe: saldo }], aplicaciones: [{ venta_id: v.id, importe: saldo }], idem_key: idem() });
  }],
  ['movimiento_stock', 5, 'escritura', (c, t) => c.post('/api/stock/movimientos', { articulo_id: t.articulos[Math.floor(Math.random() * t.articulos.length)], tipo: 'entrada', cantidad: 3, notas: 'Reposición', idem_key: idem() })],
];
const PESO_TOTAL = OPS.reduce((a, o) => a + o[1], 0);
const elegir = () => {
  let x = Math.random() * PESO_TOTAL;
  for (const o of OPS) if ((x -= o[1]) < 0) return o;
  return OPS[0];
};

class Metricas {
  constructor() { this.porOp = new Map(); this.errores = new Map(); }
  anotar(op, tipo, r) {
    if (r.omitida) return;
    const m = this.porOp.get(op) ?? { tipo, ms: [], consultas: [], leidas: [], escritas: [], msD1: [], msWorker: [], n: 0, errores: 0 };
    m.n++;
    m.ms.push(r.ms);
    if (r.status === 0 || r.status >= 500) {
      m.errores++;
      const k = `${op} → ${r.status || r.error}`;
      this.errores.set(k, (this.errores.get(k) ?? 0) + 1);
    } else if (r.status === 409) {
      m.conflictos = (m.conflictos ?? 0) + 1; // dos usuarios sobre el mismo comprobante: conflicto de negocio esperado, no un error del sistema
    } else if (r.status >= 400 && r.status !== 429) {
      m.errores++;
      const k = `${op} → ${r.status} ${JSON.stringify(r.body?.error?.code ?? '')}`;
      this.errores.set(k, (this.errores.get(k) ?? 0) + 1);
    }
    if (r.d1) {
      m.consultas.push(r.d1.consultas);
      m.leidas.push(r.d1.leidas);
      m.escritas.push(r.d1.escritas);
      m.msD1.push(r.d1.msD1);
      m.msWorker.push(r.d1.msWorker);
      if (r.d1.top) {
        const [filas, ...sql] = r.d1.top.split(' || ')[0].split(':');
        if (Number(filas) > (m.topMax?.filas ?? 0)) m.topMax = { filas: Number(filas), sql: sql.join(':'), todas: r.d1.top.split(' || ').map((x) => x.slice(0, 150)) };
      }
    }
    this.porOp.set(op, m);
  }
  resumen() {
    return [...this.porOp.entries()].map(([op, m]) => ({
      op, tipo: m.tipo, n: m.n, errores: m.errores, conflictos: m.conflictos ?? 0,
      p50: pct(m.ms, 50), p95: pct(m.ms, 95), p99: pct(m.ms, 99), max: Math.max(...m.ms),
      consultas: media(m.consultas), consultasMax: m.consultas.length ? Math.max(...m.consultas) : 0, leidas: media(m.leidas), leidasMax: m.leidas.length ? Math.max(...m.leidas) : 0, escritas: media(m.escritas),
      msD1: media(m.msD1), msWorker: media(m.msWorker), topMax: m.topMax ?? null,
    })).sort((a, b) => b.p95 - a.p95);
  }
}

function tabla(filas, columnas) {
  const anchos = columnas.map((c) => Math.max(c.t.length, ...filas.map((f) => String(c.v(f)).length)));
  const linea = (xs) => xs.map((x, i) => (columnas[i].izq ? String(x).padEnd(anchos[i]) : String(x).padStart(anchos[i]))).join('  ');
  console.log(linea(columnas.map((c) => c.t)));
  console.log(anchos.map((a) => '-'.repeat(a)).join('  '));
  for (const f of filas) console.log(linea(columnas.map((c) => c.v(f))));
}

const COLS_OPS = [
  { t: 'operación', izq: true, v: (f) => f.op }, { t: 'n', v: (f) => f.n }, { t: 'err', v: (f) => f.errores }, { t: '409', v: (f) => f.conflictos },
  { t: 'p50 ms', v: (f) => f1(f.p50) }, { t: 'p95 ms', v: (f) => f1(f.p95) }, { t: 'p99 ms', v: (f) => f1(f.p99) },
  { t: 'cons D1', v: (f) => f1(f.consultas) }, { t: 'máx', v: (f) => f.consultasMax }, { t: 'filas leídas', v: (f) => f1(f.leidas) }, { t: 'máx leídas', v: (f) => f.leidasMax }, { t: 'filas escr.', v: (f) => f1(f.escritas) },
  { t: 'ms D1', v: (f) => f1(f.msD1) }, { t: 'ms Worker', v: (f) => f1(f.msWorker) },
];

// ───────────── modos ─────────────
async function modoLogin(salida) {
  const t = await crearTaller(1);
  const lat = [];
  const ok = { n: 0, err: 0 };
  const rondas = 3;
  for (let r = 0; r < rondas; r++) {
    await Promise.all(
      Array.from({ length: VUS }, async (_, k) => {
        const c = new Cliente(`10.7.${r}.${k + 1}`);
        const x = await c.post('/api/auth/login', { email: t.email, password: 'clave-de-carga-1' });
        lat.push(x.ms);
        if (x.status === 200) ok.n++;
        else ok.err++;
      }),
    );
  }
  const solo = [];
  for (let k = 0; k < 10; k++) solo.push((await new Cliente(`10.8.0.${k + 1}`).post('/api/auth/login', { email: t.email, password: 'clave-de-carga-1' })).ms);
  const resultado = { modo: 'login', iteraciones: ITER, vus: VUS, rondas, ok: ok.n, errores: ok.err, concurrente: { p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99) }, secuencial: { p50: pct(solo, 50), p95: pct(solo, 95) } };
  console.log(`\nLogin (PBKDF2 ${ITER} iteraciones): ${VUS} simultáneos × ${rondas} rondas → ok ${ok.n}, errores ${ok.err}`);
  console.log(`  concurrente  p50 ${f1(resultado.concurrente.p50)} ms · p95 ${f1(resultado.concurrente.p95)} ms · p99 ${f1(resultado.concurrente.p99)} ms`);
  console.log(`  secuencial   p50 ${f1(resultado.secuencial.p50)} ms · p95 ${f1(resultado.secuencial.p95)} ms`);
  salida.login = resultado;
}

async function modoMixto(salida) {
  console.log(`\nSembrando ${TALLERES} talleres ficticios (clientes, vehículos, artículos, ${HISTORIAL} ventas con cobros y contabilidad activada)…`);
  const t0 = performance.now();
  const talleres = await paralelo(Array.from({ length: TALLERES }, (_, i) => i + 1), 4, async (i) => crearTaller(i));
  await paralelo(talleres, 3, async (t) => {
    t.contab = true;
    await sembrar(t, { clientes: 60, articulos: 80, ventas: HISTORIAL, activarContab: true });
  });
  console.log(`  siembra: ${f1((performance.now() - t0) / 1000)} s`);

  const metricas = new Metricas();
  // Cada VU es una sesión de un taller (varios usuarios simultáneos por taller cuando VUS > TALLERES).
  const vus = [];
  for (let k = 0; k < VUS; k++) {
    const t = talleres[k % talleres.length];
    const c = new Cliente(`10.${40 + (k % 150)}.${Math.floor(k / 150)}.1`);
    const tl0 = performance.now();
    const lg = await c.post('/api/auth/login', { email: t.email, password: 'clave-de-carga-1' });
    metricas.anotar('login', 'escritura', lg);
    vus.push({ c, t });
    void tl0;
  }
  console.log(`Carga: ${VUS} usuarios simultáneos sobre ${TALLERES} talleres durante ${DURACION} s (sin pausa entre operaciones: es un máximo, no un uso normal)…`);
  const fin = Date.now() + DURACION * 1000;
  const inicio = performance.now();
  let total = 0;
  await Promise.all(
    vus.map(async ({ c, t }) => {
      while (Date.now() < fin) {
        const [nombre, , tipo, f] = elegir();
        const r = await f(c, t);
        metricas.anotar(nombre, tipo, r);
        total++;
      }
    }),
  );
  const seg = (performance.now() - inicio) / 1000;
  const res = metricas.resumen();
  console.log(`\nResultados: ${total} operaciones en ${f1(seg)} s → ${f1(total / seg)} op/s con ${VUS} usuarios simultáneos\n`);
  tabla(res, COLS_OPS);
  console.log('\nSentencia que más filas leyó en cada operación (donde supera 500):');
  for (const r of res.filter((x) => x.topMax && x.topMax.filas > 500)) {
    console.log(`  ${r.op}:`);
    for (const t of r.topMax.todas) console.log(`     ${t}`);
  }
  const errores = [...metricas.errores.entries()];
  console.log(`\nErrores: ${errores.length ? '' : 'ninguno'}`);
  for (const [k, n] of errores) console.log(`  ${n} × ${k}`);
  // Consistencia después de la carga: ninguna cola atascada y contabilidad al día en cada taller.
  let atascadas = 0;
  let descuadre = 0;
  for (const { c, t } of vus.filter((v, i, a) => a.findIndex((x) => x.t === v.t) === i)) {
    const e = (await c.get('/api/contabilidad/estado')).body;
    if (!e.al_dia) atascadas++;
    const ctl = (await c.get('/api/contabilidad/controles')).body?.controles ?? [];
    if (ctl.find((x) => x.clave === 'partida_doble')?.estado !== 'ok') descuadre++;
    void t;
  }
  console.log(`\nDespués de la carga: talleres con la contabilidad atrasada o con error: ${atascadas}/${Math.min(TALLERES, VUS)}; talleres con partida doble descuadrada: ${descuadre}`);
  salida.mixto = { talleres: TALLERES, vus: VUS, duracion: DURACION, historial: HISTORIAL, operaciones: total, segundos: seg, opPorSeg: total / seg, atascadas, descuadre, ops: res, errores: Object.fromEntries(errores) };
}

async function modoCurva(salida) {
  const niveles = String(args.niveles ?? '1,5,10,25,50').split(',').map(Number);
  console.log(`
Sembrando ${TALLERES} talleres ficticios (${HISTORIAL} ventas c/u, contabilidad activada)…`);
  const talleres = await paralelo(Array.from({ length: TALLERES }, (_, i) => i + 1), 4, async (i) => crearTaller(i));
  await paralelo(talleres, 3, async (t) => {
    t.contab = true;
    await sembrar(t, { clientes: 60, articulos: 80, ventas: HISTORIAL, activarContab: true });
  });
  const filas = [];
  for (const nivel of niveles) {
    const metricas = new Metricas();
    const vus = [];
    for (let k = 0; k < nivel; k++) {
      const t = talleres[k % talleres.length];
      const c = new Cliente(`10.${60 + (k % 150)}.${nivel}.1`);
      await c.post('/api/auth/login', { email: t.email, password: 'clave-de-carga-1' });
      vus.push({ c, t });
    }
    const fin = Date.now() + DURACION * 1000;
    const inicio = performance.now();
    let total = 0;
    await Promise.all(vus.map(async ({ c, t }) => {
      while (Date.now() < fin) {
        const [nombre, , tipo, f] = elegir();
        metricas.anotar(nombre, tipo, await f(c, t));
        total++;
      }
    }));
    const seg = (performance.now() - inicio) / 1000;
    const todos = [...metricas.porOp.values()];
    const lat = todos.flatMap((m) => m.ms);
    const lect = todos.filter((m) => m.tipo !== 'escritura').flatMap((m) => m.ms);
    const escr = todos.filter((m) => m.tipo === 'escritura').flatMap((m) => m.ms);
    const errores = todos.reduce((a, m) => a + m.errores, 0);
    filas.push({ usuarios: nivel, opPorSeg: total / seg, p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), p95Lectura: pct(lect, 95), p95Escritura: pct(escr, 95), errores, operaciones: total });
  }
  tabla(filas, [
    { t: 'usuarios simultáneos', v: (f) => f.usuarios }, { t: 'op/s', v: (f) => f1(f.opPorSeg) }, { t: 'p50 ms', v: (f) => f1(f.p50) }, { t: 'p95 ms', v: (f) => f1(f.p95) }, { t: 'p99 ms', v: (f) => f1(f.p99) },
    { t: 'p95 lecturas', v: (f) => f1(f.p95Lectura) }, { t: 'p95 escrituras', v: (f) => f1(f.p95Escritura) }, { t: 'errores', v: (f) => f.errores }, { t: 'operaciones', v: (f) => f.operaciones },
  ]);
  salida.curva = { talleres: TALLERES, historial: HISTORIAL, duracion: DURACION, filas };
}

async function modoEscala(salida) {
  const historiales = String(args.historiales ?? '0,200,1000,3000').split(',').map(Number);
  console.log('\nCosto de contabilizar UNA venta nueva según el tamaño del historial del taller');
  console.log('  incremental = cómo funciona ahora (cola) · recorrido completo = lo que hacía cada operación en el Sprint 12\n');
  const filas = [];
  for (const h of historiales) {
    const t = await crearTaller(100 + h);
    t.contab = true;
    const c = await sembrar(t, { clientes: 30, articulos: 40, ventas: 0, activarContab: true });
    // Historial: h ventas (con la contabilidad activada se contabilizan una a una por la cola)
    const lotes = Array.from({ length: h }, (_, k) => k);
    await paralelo(lotes, 8, async (k) => {
      await c.post('/api/ventas', { cliente_id: t.clientes[k % t.clientes.length], condicion: 'cuenta_corriente', idem_key: idem(), items: [{ tipo: 'libre', descripcion: 'Trabajo', cantidad: 1, precio_unitario: 100000 + k }] });
    });
    const incr = [];
    for (let k = 0; k < 5; k++) {
      incr.push(await c.post('/api/ventas', { cliente_id: t.clientes[0], condicion: 'cuenta_corriente', idem_key: idem(), items: [{ tipo: 'libre', descripcion: 'Trabajo', cantidad: 1, precio_unitario: 123456 }] }));
    }
    const completo = [];
    for (let k = 0; k < 3; k++) completo.push(await c.post('/api/contabilidad/sincronizar', { completa: true }));
    const est1 = await c.get('/api/contabilidad/estado');
    const estD = await c.get('/api/contabilidad/estado?detalle=1');
    const m = (xs, f) => media(xs.map(f));
    filas.push({
      historial: h,
      venta_cons: m(incr, (x) => x.d1.consultas), venta_leidas: m(incr, (x) => x.d1.leidas), venta_escritas: m(incr, (x) => x.d1.escritas), venta_ms: m(incr, (x) => x.ms),
      completo_cons: m(completo, (x) => x.d1.consultas), completo_leidas: m(completo, (x) => x.d1.leidas), completo_ms: m(completo, (x) => x.ms),
      estado_leidas: est1.d1.leidas, estado_ms: est1.ms, estado_detalle_leidas: estD.d1.leidas, estado_detalle_ms: estD.ms,
    });
  }
  tabla(filas, [
    { t: 'historial', v: (f) => f.historial }, { t: 'venta: cons', v: (f) => f1(f.venta_cons) }, { t: 'venta: filas leídas', v: (f) => f1(f.venta_leidas) }, { t: 'venta: filas escr.', v: (f) => f1(f.venta_escritas) }, { t: 'venta ms', v: (f) => f1(f.venta_ms) },
    { t: 'recorrido completo: cons', v: (f) => f1(f.completo_cons) }, { t: 'recorrido completo: filas leídas', v: (f) => f1(f.completo_leidas) }, { t: 'completo ms', v: (f) => f1(f.completo_ms) },
    { t: 'estado: leídas', v: (f) => f1(f.estado_leidas) }, { t: 'estado ms', v: (f) => f1(f.estado_ms) }, { t: 'estado?detalle: leídas', v: (f) => f1(f.estado_detalle_leidas) }, { t: 'detalle ms', v: (f) => f1(f.estado_detalle_ms) },
  ]);
  salida.escala = filas;
}

async function main() {
  const salida = { fecha: new Date().toISOString(), maquina: `${os.cpus()[0]?.model ?? '?'} × ${os.cpus().length}`, node: process.version, iteraciones: ITER };
  console.log(`Fierro · pruebas de capacidad (instancia local aislada, datos ficticios) · modo ${MODO}`);
  await levantar();
  try {
    if (MODO === 'login') await modoLogin(salida);
    else if (MODO === 'escala') await modoEscala(salida);
    else if (MODO === 'curva') await modoCurva(salida);
    else if (MODO === 'mixto') await modoMixto(salida);
    else throw new Error(`Modo desconocido: ${MODO}`);
    if (args.exportar) {
      // Exporta la base LOCAL de ensayo (datos ficticios con contabilidad) para ensayar la restauración: npm run respaldo -- restaurar-aislado <archivo>
      const { volcarSqlite } = await import('./volcar.mjs');
      await volcarSqlite(estado, path.resolve(args.exportar));
      console.log(`
Base de ensayo exportada a ${args.exportar}`);
    }
  } finally {
    await bajar();
  }
  if (SALIDA) {
    fs.mkdirSync(path.dirname(path.resolve(SALIDA)), { recursive: true });
    fs.writeFileSync(SALIDA, JSON.stringify(salida, null, 2));
    console.log(`\nResultados guardados en ${SALIDA}`);
  }
  void aqui;
}

main().then(
  () => process.exit(0),
  async (e) => {
    console.error(e);
    await bajar().catch(() => {});
    process.exit(1);
  },
);
