// Verificación autenticada de SOLO LECTURA contra una instalación de Fierro (por ejemplo la publicada en Cloudflare).
//
//   FIERRO_URL=https://taller-mecanico.estrubia455.workers.dev FIERRO_EMAIL=... FIERRO_PASSWORD=... npm run verificar:online
//
// Variables (se leen del entorno local; nunca se imprimen ni se guardan):
//   FIERRO_URL                         dirección base (obligatoria)
//   FIERRO_EMAIL / FIERRO_PASSWORD     usuario de prueba del taller A (obligatorios; conviene el propietario de un taller de ensayo)
//   FIERRO_EMAIL_B / FIERRO_PASSWORD_B usuario de OTRO taller (opcional): habilita la prueba de aislamiento multiempresa con datos reales
//   FIERRO_EMAIL_C / FIERRO_PASSWORD_C usuario de rol limitado del taller A (opcional, p. ej. mecánico o recepción): comprueba que no ve lo que no debe
//
// Garantías:
//   * SOLO LECTURA: cualquier pedido que no sea GET está bloqueado en el propio script salvo una lista cerrada (iniciar y cerrar sesión, la validación
//     previa de una importación, que no escribe, y una consulta de activación con un enlace inventado). Las únicas huellas en el servidor son la sesión
//     y el contador de intentos fallidos de esa consulta.
//   * No genera contabilidad: nunca llama a /contabilidad/activar ni a /contabilidad/sincronizar. Si la contabilidad del taller no está activada, solo
//     comprueba que las pantallas contables lo informan (sin escribir). Si está activada, comprueba que consultar NO cambia el estado contable
//     (mismo total de asientos y misma última sincronización antes y después de leerlo todo).
//   * No imprime contraseñas, cookies ni tokens, ni siquiera en un error.
import crypto from 'node:crypto';

const BASE = (process.env.FIERRO_URL ?? '').replace(/\/$/, '');
const EMAIL = process.env.FIERRO_EMAIL;
const PASS = process.env.FIERRO_PASSWORD;
if (!BASE || !EMAIL || !PASS) {
  console.error('Faltan FIERRO_URL, FIERRO_EMAIL o FIERRO_PASSWORD en el entorno.');
  process.exit(2);
}
if (!/^https:\/\//.test(BASE) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(BASE)) {
  console.error('FIERRO_URL debe ser https:// (o un servidor local): las credenciales no viajan sin cifrar.');
  process.exit(2);
}

// Únicos pedidos no-GET permitidos. Cualquier otro se aborta antes de enviarse.
const PERMITIDOS = new Set(['POST /api/auth/login', 'POST /api/auth/logout', 'POST /api/importaciones/validar', 'POST /api/activacion/consultar']);

class Sesion {
  cookie = '';
  async req(metodo, ruta, cuerpo) {
    const clave = `${metodo} ${ruta.split('?')[0]}`;
    if (metodo !== 'GET' && !PERMITIDOS.has(clave)) throw new Error(`Pedido bloqueado por la verificación de solo lectura: ${clave}`);
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
const nota = (t) => console.log(`        ${t}`);

const anon = new Sesion();
chk('Disponibilidad', 'La API responde', (await anon.get('/api/salud')).body?.ok === true);
chk('Disponibilidad', 'La aplicación (SPA) se sirve', (await fetch(BASE + '/')).headers.get('content-type')?.includes('text/html'));
chk('Disponibilidad', 'La pantalla de activación existe', (await fetch(BASE + '/activar')).status === 200);

// ───── Sin sesión ─────
for (const ruta of ['/api/auth/me', '/api/clientes', '/api/vehiculos', '/api/ordenes', '/api/articulos', '/api/puesta-en-marcha', '/api/importaciones', '/api/contabilidad/estado', '/api/contabilidad/plan', '/api/aperturas']) {
  chk('Sin sesión', `${ruta} exige iniciar sesión`, (await anon.get(ruta)).status === 401);
}
chk('Sin sesión', 'La administración de la plataforma exige su token', (await anon.get('/api/platform/talleres')).status === 401);
chk('Sin sesión', 'Un enlace de activación inventado no sirve (y no revela nada)', (await anon.post('/api/activacion/consultar', { token: crypto.randomBytes(32).toString('base64url') })).status === 404);

// ───── Inicio de sesión ─────
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
nota(`Rol: ${me?.usuario?.rol} · Taller: ${me?.taller?.nombre} · Permisos: ${me?.permisos?.length}`);
const tiene = (permisos, p) => permisos?.includes(p);

// ───── Navegación y permisos ─────
// Cada pantalla de lectura: con el permiso responde datos (200); sin él, 403 (nunca datos).
const HOY = new Date().toISOString().slice(0, 10);
const LECTURA = [
  ['clientes.ver', '/api/clientes?limite=5'], ['vehiculos.ver', '/api/vehiculos'], ['catalogo.ver', '/api/articulos?limite=5'], ['catalogo.ver', '/api/servicios'],
  ['stock.ver', '/api/depositos'], ['ventas.ver', '/api/ventas'], ['compras.ver', '/api/proveedores'], ['presupuestos.ver', '/api/presupuestos'], [['ordenes.ver', 'ordenes.asignadas'], '/api/ordenes?limite=5'],
  ['turnos.ver', `/api/turnos?desde=${HOY}&hasta=${HOY}`], ['caja.operar', '/api/caja/estado'], ['bancos.ver', '/api/bancos/cuentas'], ['compras.ver', '/api/deuda-proveedores'],
  ['contabilidad.ver', '/api/contabilidad/estado'], ['aperturas.gestionar', '/api/aperturas/estado'], ['datos.importar', '/api/importaciones'],
];
function navegacion(grupo, sesion, permisos) {
  return Promise.all(
    LECTURA.map(async ([perm, ruta]) => {
      const r = await sesion.get(ruta);
      const con = (Array.isArray(perm) ? perm : [perm]).some((p) => tiene(permisos, p)); // una lista = alcanza con cualquiera (p. ej. el mecánico ve sus órdenes asignadas)
      chk(grupo, `${ruta} → ${con ? 'datos' : 'sin permiso'}`, con ? r.status === 200 : r.status === 403, `HTTP ${r.status}`);
    }),
  );
}
await navegacion('Navegación y permisos', A, me?.permisos);
chk('Navegación y permisos', '/api/dashboard (tablero de inicio)', (await A.get('/api/dashboard')).status === 200);
chk('Navegación y permisos', '/api/buscar (búsqueda global)', (await A.get('/api/buscar?q=ab')).status === 200);

// ───── Datos de gestión: clientes, vehículos, órdenes e inventario ─────
const lista = async (ruta) => {
  const r = await A.get(ruta);
  return Array.isArray(r.body) ? r.body : (r.body?.items ?? r.body?.filas ?? []);
};
const muestras = {};
if (tiene(me?.permisos, 'clientes.ver')) {
  const cs = await lista('/api/clientes?limite=5');
  muestras.cliente = cs[0]?.id;
  if (muestras.cliente) chk('Clientes', 'Se abre la ficha de un cliente', (await A.get(`/api/clientes/${muestras.cliente}`)).status === 200);
  else nota('El taller no tiene clientes: no se prueba la ficha.');
}
if (tiene(me?.permisos, 'vehiculos.ver')) {
  const vs = await lista('/api/vehiculos');
  muestras.vehiculo = vs[0]?.id;
  if (muestras.vehiculo) {
    chk('Vehículos', 'Se abre la ficha de un vehículo', (await A.get(`/api/vehiculos/${muestras.vehiculo}`)).status === 200);
    if (tiene(me?.permisos, 'mantenimientos.ver')) chk('Vehículos', 'Historial técnico del vehículo', (await A.get(`/api/vehiculos/${muestras.vehiculo}/historial-tecnico`)).status === 200);
  } else nota('El taller no tiene vehículos: no se prueba la ficha.');
}
if (tiene(me?.permisos, 'ordenes.ver')) {
  const os = await lista('/api/ordenes?limite=5');
  muestras.orden = os[0]?.id;
  if (muestras.orden) chk('Órdenes de trabajo', 'Se abre el detalle de una orden', (await A.get(`/api/ordenes/${muestras.orden}`)).status === 200);
  else nota('El taller no tiene órdenes: no se prueba el detalle.');
  chk('Órdenes de trabajo', 'Resumen por estados (tablero)', (await A.get('/api/ordenes/resumen/estados')).status === 200);
}
if (tiene(me?.permisos, 'catalogo.ver')) {
  const as = await lista('/api/articulos?limite=5');
  muestras.articulo = as[0]?.id;
  if (muestras.articulo) chk('Inventario', 'Se abre la ficha de un artículo', (await A.get(`/api/articulos/${muestras.articulo}`)).status === 200);
}
if (tiene(me?.permisos, 'stock.ajustar')) {
  const v = await A.get('/api/inventario/verificar'); // depósitos: la suma por depósito debe coincidir con el stock del artículo
  const v2 = v.status === 200 ? v : await A.get('/api/depositos/inventario/verificar');
  chk('Inventario', 'El stock por depósito coincide con el stock de cada artículo', v2.status === 200 && v2.body?.ok === true, `HTTP ${v2.status} · ${v2.body?.diferencias?.length ?? '?'} diferencia(s)`);
  chk('Inventario', 'No hay stock negativo en depósitos', v2.status === 200 && (v2.body?.depositos_negativos?.length ?? 0) === 0);
}
if (tiene(me?.permisos, 'stock.valorizar')) chk('Inventario', 'Inventario valorizado', (await A.get('/api/inventario/valorizado')).status === 200);
if (tiene(me?.permisos, 'ventas.ver') || tiene(me?.permisos, 'finanzas.ver')) {
  const cc = await A.get('/api/cuentas-corrientes/verificar');
  chk('Cuentas corrientes', 'Los saldos de los comprobantes coinciden con sus cobros, créditos y devoluciones', cc.status === 200 && cc.body?.ok === true, `HTTP ${cc.status}`);
}

// ───── Configuración y asistente ─────
if (tiene(me?.permisos, 'config.editar')) {
  const cfg = await A.get('/api/taller/config');
  chk('Configuración', 'Acceso a la configuración del taller', cfg.status === 200 && !!cfg.body?.taller?.nombre);
  chk('Configuración', 'La configuración no arrastra el logo en bruto', cfg.body?.config?.logo === undefined);
  const pm = await A.get('/api/puesta-en-marcha');
  chk('Asistente', 'El progreso de puesta en marcha responde con sus 9 pasos', pm.status === 200 && pm.body?.total === 9 && pm.body?.pasos?.length === 9, `HTTP ${pm.status}`);
  if (pm.status === 200) nota(`Configuración del taller: ${pm.body.completos} de ${pm.body.total} pasos completos (${pm.body.omitidos} omitidos)`);
} else {
  chk('Configuración', 'Sin permiso de configurar: el asistente queda vedado', (await A.get('/api/puesta-en-marcha')).status === 403);
}
if (tiene(me?.permisos, 'licencia.ver')) chk('Configuración', 'Acceso a la licencia', (await A.get('/api/taller/licencia')).status === 200);

// ───── Contabilidad ─────
// Regla del Sprint 12: consultar la contabilidad NO escribe. Esta sección no activa ni sincroniza nada.
if (tiene(me?.permisos, 'contabilidad.ver')) {
  const e0 = (await A.get('/api/contabilidad/estado')).body;
  chk('Contabilidad', 'El estado de la contabilidad responde (solo lectura)', typeof e0?.activada === 'boolean', 'respuesta inesperada');
  if (!e0?.activada) {
    nota('La contabilidad de este taller todavía no está activada: se comprueba que las pantallas lo informan sin generar nada.');
    for (const ruta of ['/api/contabilidad/plan', '/api/contabilidad/controles', '/api/contabilidad/resumen-contable?desde=2026-01-01&hasta=2026-12-31']) {
      const r = await A.get(ruta);
      chk('Contabilidad', `${ruta.split('?')[0]} informa "no activada" y no escribe`, r.status === 409 && r.body?.error?.code === 'contabilidad_no_activada', `HTTP ${r.status}`);
    }
    const e1 = (await A.get('/api/contabilidad/estado')).body;
    chk('Contabilidad', 'Consultar no creó cuentas ni asientos', e1?.activada === false && e1?.cuentas === 0 && e1?.asientos === 0);
  } else {
    const hoy = new Date().toISOString().slice(0, 10);
    const desde = new Date(Date.now() - 400 * 86400_000).toISOString().slice(0, 10);
    const plan = await A.get('/api/contabilidad/plan');
    chk('Contabilidad', 'Plan de cuentas', plan.status === 200 && Array.isArray(plan.body) && plan.body.length > 0, `HTTP ${plan.status}`);
    const ctl = await A.get('/api/contabilidad/controles');
    chk('Contabilidad', 'Controles de consistencia', ctl.status === 200 && Array.isArray(ctl.body?.controles), `HTTP ${ctl.status}`);
    const pd = ctl.body?.controles?.find((c) => c.clave === 'partida_doble');
    chk('Contabilidad', 'Partida doble sin desbalances', pd?.estado === 'ok', pd?.detalle);
    chk('Contabilidad', 'Libro diario', (await A.get(`/api/contabilidad/diario?desde=${desde}&hasta=${hoy}&limite=5`)).status === 200);
    chk('Contabilidad', 'Balance de sumas y saldos', (await A.get(`/api/contabilidad/balance?desde=${desde}&hasta=${hoy}`)).status === 200);
    chk('Contabilidad', 'Resumen contable', (await A.get(`/api/contabilidad/resumen-contable?desde=${desde}&hasta=${hoy}`)).status === 200);
    const e1 = (await A.get('/api/contabilidad/estado')).body;
    chk('Contabilidad', 'Consultar NO cambió la contabilidad (mismos asientos, misma última sincronización)', e1.asientos === e0.asientos && e1.ultima_sincronizacion === e0.ultima_sincronizacion && e1.cuentas === e0.cuentas,
      `asientos ${e0.asientos}→${e1.asientos}`);
    nota(`Asientos: ${e1.asientos} · pendientes de contabilizar: ${e1.pendientes + e1.anulaciones_pendientes} · con error: ${e1.errores} · ${e1.al_dia ? 'al día' : 'NO está al día'}`);
    if (!e1.al_dia) nota('Hay operaciones sin contabilizar: se contabilizan con la próxima operación comercial o con «Actualizar ahora» en Contabilidad (esta verificación no lo hace).');
  }
} else {
  chk('Contabilidad', 'Sin permiso: Contabilidad vedada', (await A.get('/api/contabilidad/estado')).status === 403 && (await A.get('/api/contabilidad/plan')).status === 403);
}

// ───── Aislamiento entre talleres ─────
const inexistente = crypto.randomUUID();
for (const ruta of [`/api/clientes/${inexistente}`, `/api/vehiculos/${inexistente}`, `/api/articulos/${inexistente}`, `/api/ordenes/${inexistente}`, `/api/ventas/${inexistente}`, `/api/importaciones/${inexistente}`, `/api/aperturas/${inexistente}`]) {
  const r = await A.get(ruta);
  chk('Aislamiento', `${ruta.replace(inexistente, ':id ajeno')} no devuelve datos`, r.status === 404 || r.status === 403, `HTTP ${r.status}`);
}
if (tiene(me?.permisos, 'datos.importar') && tiene(me?.permisos, 'vehiculos.crear')) {
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
  const cA = tiene(me?.permisos, 'clientes.ver') ? await lista('/api/clientes?limite=50') : [];
  const cB = tiene(meB?.permisos, 'clientes.ver') ? (await B.get('/api/clientes?limite=50')).body : [];
  const idsB = new Set((Array.isArray(cB) ? cB : []).map((c) => c.id));
  chk('Aislamiento', 'Ningún cliente del taller A aparece en el taller B', cA.every((c) => !idsB.has(c.id)));
  // Ningún registro de A (cliente, vehículo, orden, artículo) se puede abrir desde B
  for (const [tipo, id, perm] of [['clientes', muestras.cliente, 'clientes.ver'], ['vehiculos', muestras.vehiculo, 'vehiculos.ver'], ['ordenes', muestras.orden, 'ordenes.ver'], ['articulos', muestras.articulo, 'catalogo.ver']]) {
    if (id && tiene(meB?.permisos, perm)) chk('Aislamiento', `El taller B no puede abrir ${tipo} del taller A`, (await B.get(`/api/${tipo}/${id}`)).status === 404);
  }
  await B.post('/api/auth/logout');
}

// ───── Usuario de rol limitado (opcional) ─────
if (process.env.FIERRO_EMAIL_C && process.env.FIERRO_PASSWORD_C) {
  const C = await new Sesion().login(process.env.FIERRO_EMAIL_C, process.env.FIERRO_PASSWORD_C);
  const meC = (await C.get('/api/auth/me')).body;
  chk('Rol limitado', 'El usuario de rol limitado pertenece al mismo taller', meC?.taller?.id === me.taller.id);
  nota(`Rol: ${meC?.usuario?.rol} · Permisos: ${meC?.permisos?.length}`);
  await navegacion('Rol limitado', C, meC?.permisos);
  for (const ruta of ['/api/contabilidad/estado', '/api/aperturas', '/api/importaciones', '/api/puesta-en-marcha']) {
    if (!tiene(meC?.permisos, ruta.includes('contab') ? 'contabilidad.ver' : ruta.includes('aperturas') ? 'aperturas.gestionar' : ruta.includes('importaciones') ? 'datos.importar' : 'config.editar')) {
      chk('Rol limitado', `${ruta} está vedado`, (await C.get(ruta)).status === 403);
    }
  }
  await C.post('/api/auth/logout');
}

await A.post('/api/auth/logout');
chk('Sesión', 'Cierre de sesión', (await A.get('/api/auth/me')).status === 401);

const fallas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - fallas.length} de ${resultados.length} comprobaciones correctas.`);
if (fallas.length) console.log(`Fallaron:\n${fallas.map((f) => ` - [${f.grupo}] ${f.nombre}${f.detalle ? ` → ${f.detalle}` : ''}`).join('\n')}`);
process.exit(fallas.length ? 1 : 0);
