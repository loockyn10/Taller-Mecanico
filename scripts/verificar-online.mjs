// Verificación autenticada de SOLO LECTURA contra una instalación de Fierro (por ejemplo la publicada en Cloudflare).
//
//   FIERRO_URL=https://taller-mecanico.estrubia455.workers.dev FIERRO_EMAIL=... FIERRO_PASSWORD=... npm run verificar:online
//
// Variables (se leen del entorno local; nunca se imprimen):
//   FIERRO_URL         dirección base (obligatoria)
//   FIERRO_EMAIL / FIERRO_PASSWORD      usuario de prueba del taller A (obligatorios)
//   FIERRO_EMAIL_B / FIERRO_PASSWORD_B  usuario de OTRO taller (opcional): habilita la prueba de aislamiento con datos reales
//
// No crea, modifica ni borra nada: solo GET (y POST de validación previa de la importación, que no escribe). Aclaración sobre Contabilidad: la
// primera vez que se consulta, Fierro genera el plan de cuentas y los asientos de lo ya operado (proceso derivado e idempotente del Sprint 10).
import crypto from 'node:crypto';

const BASE = (process.env.FIERRO_URL ?? '').replace(/\/$/, '');
const EMAIL = process.env.FIERRO_EMAIL;
const PASS = process.env.FIERRO_PASSWORD;
if (!BASE || !EMAIL || !PASS) {
  console.error('Faltan FIERRO_URL, FIERRO_EMAIL o FIERRO_PASSWORD en el entorno.');
  process.exit(2);
}

class Sesion {
  cookie = '';
  async req(metodo, ruta, cuerpo) {
    const r = await fetch(BASE + ruta, {
      method: metodo,
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const texto = await r.text();
    let body = texto;
    try { body = JSON.parse(texto); } catch { /* no es JSON */ }
    return { status: r.status, body };
  }
  get = (ruta) => this.req('GET', ruta);
  post = (ruta, d = {}) => this.req('POST', ruta, d);
  async login(email, password) {
    const r = await this.post('/api/auth/login', { email, password });
    if (r.status !== 200) throw new Error(`No se pudo iniciar sesión (HTTP ${r.status})`);
    return this;
  }
}

const resultados = [];
const chk = (grupo, nombre, ok, detalle = '') => {
  resultados.push({ grupo, nombre, ok: !!ok, detalle });
  console.log(`${ok ? '  OK ' : ' FALLA'}  [${grupo}] ${nombre}${detalle && !ok ? ` → ${detalle}` : ''}`);
};

const anon = new Sesion();
chk('Disponibilidad', 'La API responde', (await anon.get('/api/salud')).body?.ok === true);
chk('Disponibilidad', 'La aplicación (SPA) se sirve', (await fetch(BASE + '/')).headers.get('content-type')?.includes('text/html'));
chk('Disponibilidad', 'La pantalla de activación existe', (await fetch(BASE + '/activar')).status === 200);

// ───── Sin sesión ─────
for (const ruta of ['/api/auth/me', '/api/clientes', '/api/puesta-en-marcha', '/api/importaciones', '/api/contabilidad/plan']) {
  chk('Sin sesión', `${ruta} exige iniciar sesión`, (await anon.get(ruta)).status === 401);
}
chk('Sin sesión', 'La administración de la plataforma exige su token', (await anon.get('/api/platform/talleres')).status === 401);
chk('Sin sesión', 'Un enlace de activación inventado no sirve (y no revela nada)', (await anon.post('/api/activacion/consultar', { token: crypto.randomBytes(32).toString('base64url') })).status === 404);

// ───── Inicio de sesión y navegación ─────
const A = new Sesion();
try {
  await A.login(EMAIL, PASS);
  chk('Sesión', 'Inicio de sesión', true);
} catch (e) {
  chk('Sesión', 'Inicio de sesión', false, e.message);
  console.log('\nNo se pudo continuar sin sesión.');
  process.exit(1);
}
const me = (await A.get('/api/auth/me')).body;
chk('Sesión', 'Se obtiene el usuario, el taller y los permisos', !!me?.usuario?.id && !!me?.taller?.id && Array.isArray(me?.permisos), '');
console.log(`        Rol: ${me?.usuario?.rol} · Taller: ${me?.taller?.nombre} · Permisos: ${me?.permisos?.length}`);
const tiene = (p) => me?.permisos?.includes(p);

const lectura = [
  ['clientes.ver', '/api/clientes?limite=5'], ['vehiculos.ver', '/api/vehiculos'], ['catalogo.ver', '/api/articulos?limite=5'], ['catalogo.ver', '/api/servicios'],
  ['stock.ver', '/api/depositos'], ['ventas.ver', '/api/ventas'], ['compras.ver', '/api/proveedores'], ['presupuestos.ver', '/api/presupuestos'], ['ordenes.ver', '/api/ordenes?limite=5'],
  ['caja.operar', '/api/caja/estado'], ['bancos.ver', '/api/bancos/cuentas'],
];
for (const [perm, ruta] of lectura) {
  const r = await A.get(ruta);
  // Con el permiso debe responder 200; sin él, 403 (nunca datos).
  chk('Navegación y permisos', `${ruta} → ${tiene(perm) ? 'datos' : 'sin permiso'}`, tiene(perm) ? r.status === 200 : r.status === 403, `HTTP ${r.status}`);
}

chk('Navegación y permisos', '/api/dashboard (tablero de inicio)', (await A.get('/api/dashboard')).status === 200);

// ───── Configuración ─────
if (tiene('config.editar')) {
  const cfg = await A.get('/api/taller/config');
  chk('Configuración', 'Acceso a la configuración del taller', cfg.status === 200 && !!cfg.body?.taller?.nombre);
  chk('Configuración', 'La configuración no arrastra el logo en bruto', cfg.body?.config?.logo === undefined);
  const pm = await A.get('/api/puesta-en-marcha');
  chk('Asistente', 'El progreso de puesta en marcha responde con sus 9 pasos', pm.status === 200 && pm.body?.total === 9 && pm.body?.pasos?.length === 9, `HTTP ${pm.status}`);
  if (pm.status === 200) console.log(`        Configuración del taller: ${pm.body.completos} de ${pm.body.total} pasos completos (${pm.body.omitidos} omitidos)`);
  chk('Asistente', 'El historial de importaciones es accesible', tiene('datos.importar') ? (await A.get('/api/importaciones')).status === 200 : (await A.get('/api/importaciones')).status === 403);
} else {
  chk('Configuración', 'Sin permiso de configurar: el asistente queda vedado', (await A.get('/api/puesta-en-marcha')).status === 403);
}
if (tiene('licencia.ver')) chk('Configuración', 'Acceso a la licencia', (await A.get('/api/taller/licencia')).status === 200);

// ───── Contabilidad ─────
if (tiene('contabilidad.ver')) {
  const plan = await A.get('/api/contabilidad/plan');
  chk('Contabilidad', 'Plan de cuentas', plan.status === 200 && Array.isArray(plan.body) && plan.body.length > 0, `HTTP ${plan.status}`);
  const hoy = new Date().toISOString().slice(0, 10);
  const desde = new Date(Date.now() - 400 * 86400_000).toISOString().slice(0, 10);
  const ctl = await A.get('/api/contabilidad/controles');
  chk('Contabilidad', 'Controles de consistencia', ctl.status === 200 && Array.isArray(ctl.body?.controles), `HTTP ${ctl.status}`);
  const pd = ctl.body?.controles?.find((c) => c.clave === 'partida_doble');
  chk('Contabilidad', 'Partida doble sin desbalances', pd?.estado === 'ok', pd?.detalle);
  chk('Contabilidad', 'Libro diario', (await A.get(`/api/contabilidad/diario?desde=${desde}&hasta=${hoy}&limite=5`)).status === 200);
} else {
  chk('Contabilidad', 'Sin permiso: Contabilidad vedada', (await A.get('/api/contabilidad/plan')).status === 403);
}

// ───── Aislamiento entre talleres ─────
const inexistente = crypto.randomUUID();
for (const ruta of [`/api/clientes/${inexistente}`, `/api/vehiculos/${inexistente}`, `/api/articulos/${inexistente}`, `/api/ordenes/${inexistente}`, `/api/ventas/${inexistente}`, `/api/importaciones/${inexistente}`]) {
  const r = await A.get(ruta);
  chk('Aislamiento', `${ruta.replace(inexistente, ':id ajeno')} no devuelve datos`, r.status === 404 || r.status === 403, `HTTP ${r.status}`);
}
if (tiene('datos.importar') && tiene('vehiculos.crear')) {
  // La validación previa NO escribe: se comprueba que una resolución apuntando a un cliente que no es del taller se rechaza.
  const r = await A.post('/api/importaciones/validar', {
    tipo: 'vehiculos', modo: 'omitir', opciones: {}, resoluciones: { 'cliente:doc:99999991': inexistente },
    filas: [{ n: 2, v: { patente: 'ZZ999ZZ', cliente_documento: '99999991' } }],
  });
  chk('Aislamiento', 'Una importación no puede vincular con un cliente que no es del taller', r.status === 200 && r.body?.resultados?.[0]?.accion === 'error', `HTTP ${r.status}`);
}
if (process.env.FIERRO_EMAIL_B && process.env.FIERRO_PASSWORD_B) {
  const B = await new Sesion().login(process.env.FIERRO_EMAIL_B, process.env.FIERRO_PASSWORD_B);
  const meB = (await B.get('/api/auth/me')).body;
  chk('Aislamiento', 'Los dos usuarios pertenecen a talleres distintos', meB?.taller?.id && meB.taller.id !== me.taller.id);
  const cA = tiene('clientes.ver') ? (await A.get('/api/clientes?limite=50')).body : [];
  const cB = meB?.permisos?.includes('clientes.ver') ? (await B.get('/api/clientes?limite=50')).body : [];
  const idsB = new Set(cB.map((c) => c.id));
  chk('Aislamiento', 'Ningún cliente del taller A aparece en el taller B', cA.every((c) => !idsB.has(c.id)));
  if (cA.length) chk('Aislamiento', 'El taller B no puede abrir un cliente del taller A', (await B.get(`/api/clientes/${cA[0].id}`)).status === 404);
  await B.post('/api/auth/logout');
}

await A.post('/api/auth/logout');
chk('Sesión', 'Cierre de sesión', (await A.get('/api/auth/me')).status === 401);

const fallas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - fallas.length} de ${resultados.length} comprobaciones correctas.`);
process.exit(fallas.length ? 1 : 0);
