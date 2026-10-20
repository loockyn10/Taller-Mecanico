// Generador de datos de demostración de Fierro ("Taller Demo Fierro").
//
//   npm run demo -- simular                  plan completo en memoria: sin red y sin escrituras
//   npm run demo -- cargar                   ejecuta el plan contra la API (local por defecto)
//   npm run demo -- cronologia               genera (y con --aplicar-local, aplica) el SQL que reubica las jornadas en su fecha
//   npm run demo -- verificar                comprobaciones de consistencia y de que ninguna sección quede vacía
//   npm run demo -- estado                   muestra el avance guardado en el manifiesto
//
// Ver docs/DEMO.md. Contra una API que no sea local exige --remoto y --confirmo <id del taller>: nunca se modifica otro taller.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, carpetaEstado, esperarProceso, wrangler } from '../lib.mjs';
import { Sesion } from './api.mjs';
import { ARTICULOS, USUARIOS } from './catalogo.mjs';
import { construirCronologia, guardarSql, MARCA_SIN_FECHAR } from './cronologia.mjs';
import { ejecutar } from './ejecutar.mjs';
import { estimarTotal, planificar } from './plan.mjs';
import { ars, hoyAR, pesos } from './util.mjs';
import { verificar } from './verificar.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const ESTADO_DIR = path.join(AQUI, 'estado');
const SALIDA_DIR = path.join(AQUI, 'salida');

function opciones(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) o[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) o[k] = argv[++i];
      else o[k] = true;
    } else o._.push(a);
  }
  return o;
}

/** Credenciales: variables de entorno o el archivo local .env.demo-remoto (ignorado por git; ver .env.demo-remoto.example). Nunca se imprimen. */
function cargarArchivoEnv() {
  const f = path.join(ROOT, '.env.demo-remoto');
  if (!fs.existsSync(f)) return;
  for (const linea of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(linea);
    if (m && !linea.trim().startsWith('#') && m[2] !== '' && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
cargarArchivoEnv();

function leerDevVars(nombre) {
  const f = path.join(ROOT, '.dev.vars');
  return fs.existsSync(f) ? new RegExp(`${nombre}=(.+)`).exec(fs.readFileSync(f, 'utf8'))?.[1]?.trim() : undefined;
}

const o = opciones(process.argv.slice(2));
const comando = o._[0] ?? 'ayuda';
const api = (o.api ?? process.env.FIERRO_API ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const esLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(api);
const opts = {
  api,
  esLocal,
  remoto: !esLocal,
  email: o.email ?? process.env.FIERRO_DEMO_EMAIL ?? 'demo@fierro.local',
  password: o.password ?? process.env.FIERRO_DEMO_PASSWORD ?? (esLocal ? 'demo1234' : undefined),
  passwordUsuarios: o['password-usuarios'] ?? process.env.FIERRO_DEMO_PASSWORD_USUARIOS ?? (esLocal ? 'demo1234' : undefined),
  platformToken: o['plataforma-token'] ?? process.env.PLATFORM_ADMIN_TOKEN ?? (esLocal ? leerDevVars('PLATFORM_ADMIN_TOKEN') : undefined),
  pausaMs: o['pausa-ms'] ? Number(o['pausa-ms']) : undefined,
};
const semilla = Number(o.semilla ?? 20261021);
const corridos = Number(o.dias ?? 90);
const slug = `${new URL(api).host}__${opts.email}`.replace(/[^a-z0-9._-]+/gi, '_');
const archivoManifiesto = path.join(ESTADO_DIR, `${slug}.json`);
const log = (...a) => console.log(...a);

function leerManifiesto() {
  return fs.existsSync(archivoManifiesto) ? JSON.parse(fs.readFileSync(archivoManifiesto, 'utf8')) : null;
}
function manifiestoNuevo(hoy) {
  return { version: 1, creado: new Date().toISOString(), api, email: opts.email, semilla, corridos, hoy, estado: 'iniciado', hechas: -1, ids: undefined, ventanas: [] };
}
const guardarManifiesto = (m) => async () => {
  fs.mkdirSync(ESTADO_DIR, { recursive: true });
  fs.writeFileSync(archivoManifiesto, JSON.stringify(m, null, 1), 'utf8');
};

// ───────────────────────── Resumen del plan ─────────────────────────
function resumenPlan(plan) {
  const n = (t) => plan.acciones.filter((a) => a.tipo === t).length;
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  const ot = n('ot') + n('pres_ot');
  const itemsOT = new Map();
  for (const a of plan.acciones) {
    if (a.tipo === 'ot') itemsOT.set(a.key, plan.specs.find((s) => s.key === a.key).items);
    if (a.tipo === 'pres_ot') itemsOT.set(a.key, plan.acciones.find((p) => p.tipo === 'pres' && p.key === a.presKey).items);
  }
  const facturadoOT = sum(plan.acciones.filter((a) => a.tipo === 'ot_comp'), (a) => estimarTotal(itemsOT.get(a.key), plan.art));
  const facturadoVta = sum(plan.acciones.filter((a) => a.tipo === 'venta' && !plan.acciones.some((x) => x.tipo === 'venta_anular' && x.key === a.key)), (a) => estimarTotal(a.items, plan.art));
  const compras = sum(plan.acciones.filter((a) => a.tipo === 'compra'), (a) => a.total);
  const gastos = sum(plan.acciones.filter((a) => a.tipo === 'gasto'), (a) => a.importe);
  const ts = (t, f) => plan.acciones.filter((a) => a.tipo === t && (!f || f(a)));
  return {
    jornadas: `${plan.N} jornadas, del ${plan.fechas[0]} al ${plan.fechas.at(-1)} (hoy)`,
    filas: [
      ['Clientes', plan.clientes.length], ['Vehículos', plan.vehs.length], ['Mecánicos', 4], ['Proveedores', 8], ['Artículos', ARTICULOS.length],
      ['Usuarios (administrador y empleado)', USUARIOS.length], ['Cuentas bancarias', 3], ['Listas de precios', 2],
      ['Presupuestos', n('pres')], ['  · convertidos en OT', n('pres_ot')], ['Órdenes de trabajo', ot], ['  · comprobantes de OT', n('ot_comp')],
      ['Turnos', n('turno')], ['Ventas de mostrador', n('venta')], ['  · anuladas', n('venta_anular')],
      ['Cobros posteriores (cuenta corriente / parciales)', n('cobro')], ['Compras directas', n('compra')], ['Órdenes de compra', n('oc')], ['  · recepciones', n('oc_recibir')],
      ['Facturas / notas de crédito de proveedores', n('factura')], ['Pagos a proveedores', n('pago')], ['Gastos', n('gasto')], ['Gastos recurrentes', n('gasto_rec_crear')],
      ['Aperturas y cierres de caja', plan.N], ['Arqueos de caja', n('arqueo')], ['Depósitos y extracciones', n('deposito') + n('extraccion')], ['Transferencias entre cuentas', n('transferencia')],
      ['Movimientos manuales de banco', n('banco_mov')], ['Conciliaciones bancarias', n('conciliar')],
      ['Cheques (manuales, además de los de cobros)', n('cheque_manual')], ['Cheques depositados / rechazados', `${n('cheque_dep')} / ${n('cheque_rech')}`],
      ['Ajustes de stock y conteos físicos', n('stock_ajuste') + n('conteo')], ['Operaciones en total', plan.acciones.length],
    ],
    importes: [
      ['Facturado en OT (estimado, IVA incluido)', ars(facturadoOT)], ['Vendido en mostrador (estimado)', ars(facturadoVta)], ['Compras a proveedores (con IVA)', ars(compras)], ['Gastos', ars(gastos)],
    ],
  };
}

function mostrarResumen(plan) {
  const r = resumenPlan(plan);
  log(`\nPlan de la demostración (semilla ${plan.semilla}): ${r.jornadas}`);
  log('\nRegistros que se crearán (todos por la API, con sus reglas de negocio):');
  for (const [k, v] of r.filas) log(`  ${k.padEnd(52)} ${v}`);
  log('\nImportes del plan:');
  for (const [k, v] of r.importes) log(`  ${k.padEnd(52)} ${v}`);
  const bajos = [...plan.stock].filter(([c, q]) => q <= plan.art.get(c).min).length;
  log(`\nStock final esperado: ${[...plan.stock].filter(([, q]) => q < 0).length} artículos negativos · ${bajos} en o bajo el mínimo.`);
}

// ───────────────────────── Comandos ─────────────────────────
async function precheckRemoto() {
  if (!opts.remoto) return;
  if (!o.remoto) throw new Error(`La API ${api} no es local. Este comando escribiría en un entorno remoto: agregá --remoto y --confirmo <id del taller> (ver docs/DEMO.md).`);
  if (!opts.password) throw new Error('Falta la contraseña del usuario demo: definí FIERRO_DEMO_PASSWORD (no se acepta por pantalla).');
  if (!o.confirmo) throw new Error('Falta --confirmo <id del taller de destino>. Ejecutá antes `npm run demo -- destino --api ...` para ver el id y confirmarlo.');
  const s = await new Sesion(api, 'precheck').login(opts.email, opts.password);
  const me = await s.get('/auth/me');
  if (me.taller.id !== o.confirmo) throw new Error(`El taller del usuario ${opts.email} es ${me.taller.id} ("${me.taller.nombre}") y no coincide con --confirmo. No se escribió nada.`);
}

async function cmdDestino() {
  if (!opts.password) throw new Error('Definí FIERRO_DEMO_PASSWORD para consultar el taller de destino.');
  const s = await new Sesion(api, 'destino').login(opts.email, opts.password);
  const me = await s.get('/auth/me');
  const clientes = (await s.get('/clientes?limite=500&inactivos=1')).filter((c) => c.codigo !== 0);
  log(`Entorno:  ${api} (${esLocal ? 'local' : 'REMOTO'})`);
  log(`Taller:   ${me.taller.nombre}`);
  log(`Id:       ${me.taller.id}   ← usar en --confirmo`);
  log(`Usuario:  ${me.usuario.email} (${me.usuario.rol})`);
  log(`Licencia: ${me.licencia.plan} · usuarios ${me.licencia.usuarios_incluidos}+${me.licencia.usuarios_adicionales} · ${me.licencia.estado}`);
  log(`Clientes existentes (sin contar "Consumidor final"): ${clientes.length}${clientes.length ? '  ← el generador sólo carga en talleres vacíos' : ''}`);
}

async function cmdSimular() {
  const plan = planificar({ semilla, hoy: hoyAR(), corridos });
  mostrarResumen(plan);
  log('\nSimulación: no se hizo ninguna llamada a la red ni se escribió nada.');
  if (o.json) { fs.mkdirSync(SALIDA_DIR, { recursive: true }); fs.writeFileSync(path.join(SALIDA_DIR, 'plan.json'), JSON.stringify(plan.acciones, null, 1)); log(`Plan exportado en ${path.join(SALIDA_DIR, 'plan.json')}`); }
}

async function cmdCargar() {
  let m = leerManifiesto();
  if (m?.estado === 'cargado' && !o.rehacer) {
    log(`Esta cuenta ya fue cargada (${m.fin}). Nada que hacer: el generador no duplica registros.`);
    log(m.cronologia?.aplicada ? 'La cronología ya está aplicada.' : 'Falta aplicar la cronología: `npm run demo -- cronologia --aplicar-local --estado-wrangler <carpeta>` (o ver docs/DEMO.md para remoto).');
    return;
  }
  const hoy = m?.hoy ?? hoyAR();
  if (m && m.hoy !== hoyAR()) throw new Error(`La carga quedó a medias el ${m.hoy} y hoy es ${hoyAR()}. Las fechas relativas no coincidirían: reiniciá con una base limpia.`);
  await precheckRemoto();
  const plan = planificar({ semilla: m?.semilla ?? semilla, hoy, corridos: m?.corridos ?? corridos });
  mostrarResumen(plan);
  m ??= manifiestoNuevo(hoy);
  log(`\nManifiesto: ${archivoManifiesto}`);
  log(m.hechas >= 0 ? `Se reanuda desde la operación #${m.hechas + 1}.` : 'Carga nueva.');
  log('');
  await ejecutar({ plan, opts, m, guardar: guardarManifiesto(m), log });
  log('\nCarga terminada. Generando la cronología…');
  await generarCronologia(m, plan);
  if (o['aplicar-cronologia'] ?? o['aplicar-local']) await aplicarLocal(m);
  else log('\nPróximo paso: aplicar la cronología (ver docs/DEMO.md) y luego `npm run demo -- verificar`.');
}

async function generarCronologia(m, plan) {
  const { sql, jornadas } = construirCronologia({ m, plan });
  const archivo = guardarSql(SALIDA_DIR, `cronologia-${slug}.sql`, sql);
  m.cronologia = { ...(m.cronologia ?? {}), archivo, jornadas, generada: new Date().toISOString() };
  fs.mkdirSync(ESTADO_DIR, { recursive: true });
  fs.writeFileSync(archivoManifiesto, JSON.stringify(m, null, 1), 'utf8');
  log(`Cronología: ${jornadas} jornadas a reubicar → ${archivo}`);
  return archivo;
}

async function aplicarLocal(m) {
  if (!esLocal) throw new Error('--aplicar-local sólo se permite con la API local. Para un entorno remoto, aplicá el SQL vos mismo con wrangler (ver docs/DEMO.md).');
  const persist = o['estado-wrangler'] ?? carpetaEstado('dev');
  log(`Aplicando la cronología sobre la base local (${persist}). La API local de ese estado debería estar detenida.`);
  await esperarProceso(wrangler(['d1', 'execute', 'DB', '--local', '--persist-to', persist, '--file', m.cronologia.archivo], { stdio: 'inherit' }));
  m.cronologia.aplicada = new Date().toISOString();
  fs.writeFileSync(archivoManifiesto, JSON.stringify(m, null, 1), 'utf8');
  log('Cronología aplicada.');
}

async function cmdCronologia() {
  const m = leerManifiesto();
  if (!m || m.estado !== 'cargado') throw new Error('No hay una carga completa en el manifiesto de esta cuenta.');
  const plan = planificar({ semilla: m.semilla, hoy: m.hoy, corridos: m.corridos });
  await generarCronologia(m, plan);
  if (o['aplicar-local']) await aplicarLocal(m);
}

async function cmdVerificar() {
  const m = leerManifiesto();
  if (!m) throw new Error('No hay manifiesto: primero ejecutá `cargar`.');
  if (!opts.password) throw new Error('Definí FIERRO_DEMO_PASSWORD.');
  const plan = planificar({ semilla: m.semilla, hoy: m.hoy, corridos: m.corridos });
  if (!m.cronologia?.aplicada) log('AVISO: la cronología todavía no se aplicó; las comprobaciones de fechas son de la jornada real, no de la simulada.\n');
  const { fallas } = await verificar({ opts, plan, m, log });
  if (fallas.length) process.exitCode = 1;
}

const PRUEBAS = { nombre: 'Taller de Pruebas', email: process.env.FIERRO_PRUEBAS_EMAIL ?? 'pruebas@fierro.local' };

async function cmdPruebas() {
  const pass = process.env.FIERRO_PRUEBAS_PASSWORD;
  if (!pass) throw new Error('Definí FIERRO_PRUEBAS_PASSWORD (variable de entorno o .env.demo-remoto).');
  if (!opts.platformToken) throw new Error('Definí PLATFORM_ADMIN_TOKEN (variable de entorno o .env.demo-remoto): es el token de administración de plataforma.');
  if (opts.remoto && !o.remoto) throw new Error('La API no es local: agregá --remoto para crear el taller en ese entorno.');
  const r = await fetch(`${api}/api/platform/talleres`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.platformToken}` },
    body: JSON.stringify({ nombre: PRUEBAS.nombre, usuarios_adicionales: 2, propietario: { nombre: 'Propietario de Pruebas', email: PRUEBAS.email, password: pass } }),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 409) log(`El usuario ${PRUEBAS.email} ya existe: no se crea otro taller.`);
  else if (!r.ok) throw new Error(`No se pudo crear el taller: ${r.status} ${j?.error?.message ?? ''}`);
  else log(`Taller "${PRUEBAS.nombre}" creado (id ${j.tallerId}).`);
  const s = await new Sesion(api, 'pruebas').login(PRUEBAS.email, pass);
  const me = await s.get('/auth/me');
  log(`Ingreso correcto: ${me.usuario.email} (${me.usuario.rol}) · taller "${me.taller.nombre}" · id ${me.taller.id}`);
}

async function cmdAislamiento() {
  if (!opts.password || !process.env.FIERRO_PRUEBAS_PASSWORD) throw new Error('Definí FIERRO_DEMO_PASSWORD y FIERRO_PRUEBAS_PASSWORD.');
  const d = await new Sesion(api, 'demo').login(opts.email, opts.password);
  const p = await new Sesion(api, 'pruebas').login(PRUEBAS.email, process.env.FIERRO_PRUEBAS_PASSWORD);
  const [md, mp] = [await d.get('/auth/me'), await p.get('/auth/me')];
  const filas = [];
  const chk = (n, ok, det = '') => { filas.push(ok); log(`  ${ok ? '✔' : '✖'} ${n}${det ? '  → ' + det : ''}`); };
  chk(`Dos talleres distintos: "${md.taller.nombre}" (${md.taller.id}) y "${mp.taller.nombre}" (${mp.taller.id})`, md.taller.id !== mp.taller.id);
  const rubros = [
    ['Clientes (sin Consumidor final)', '/clientes?limite=500', (r) => r.filter((c) => c.codigo !== 0).length], ['Vehículos', '/vehiculos', (r) => r.length],
    ['Órdenes de trabajo', '/ordenes?estado=todas&limite=500', (r) => r.length], ['Presupuestos', '/presupuestos', (r) => r.length], ['Ventas', '/ventas', (r) => r.length],
    ['Cobros', '/cobros?limite=500', (r) => r.length], ['Compras', '/compras', (r) => r.length], ['Artículos', '/articulos?limite=1000', (r) => r.length],
    ['Proveedores', '/proveedores', (r) => r.length], ['Cajas', '/caja/sesiones?limite=200', (r) => r.length], ['Cuentas bancarias', '/bancos/cuentas?todas=1', (r) => r.length],
    ['Cheques', '/cheques?limite=1000', (r) => r.length], ['Gastos', '/gastos?limite=500', (r) => r.length],
  ];
  log('\n  ' + 'Rubro'.padEnd(34) + 'DEMO    PRUEBAS');
  let ceroOk = true;
  for (const [n, ruta, f] of rubros) {
    const [a, b] = [f(await d.get(ruta)), f(await p.get(ruta))];
    if (b !== 0) ceroOk = false;
    log(`  ${n.padEnd(34)}${String(a).padEnd(8)}${b}`);
  }
  log('');
  chk('El taller de pruebas no tiene información operativa', ceroOk);
  const cat = [(await p.get('/servicios')).length, (await p.get('/marcas')).length, (await p.get('/categorias-gasto')).length];
  chk(`Conserva sus catálogos iniciales (${cat[0]} servicios, ${cat[1]} marcas, ${cat[2]} categorías de gasto)`, cat.every((n) => n > 0));
  const ot = (await d.get('/ordenes?estado=todas&limite=5'))[0];
  const cli = (await d.get('/clientes?limite=5')).find((c) => c.codigo !== 0);
  const veh = (await d.get('/vehiculos'))[0];
  const venta = (await d.get('/ventas'))[0];
  for (const [n, ruta] of [['una OT', ot && `/ordenes/${ot.id}`], ['un cliente', cli && `/clientes/${cli.id}`], ['un vehículo', veh && `/vehiculos/${veh.id}`], ['una venta', venta && `/ventas/${venta.id}`]]) {
    if (!ruta) continue;
    const codigo = await p.get(ruta).then(() => 200, (e) => e.status);
    chk(`Pruebas no puede leer ${n} de la demostración (respuesta ${codigo})`, codigo === 404);
  }
  if (cli && veh) {
    const codigo = await p.post('/presupuestos', { cliente_id: cli.id, vehiculo_id: veh.id, items: [{ tipo: 'libre', descripcion: 'x', cantidad: 1, precio_unitario: 100 }] }).then(() => 201, (e) => e.status);
    chk(`Pruebas no puede crear un presupuesto sobre cliente/vehículo de la demostración (respuesta ${codigo})`, codigo === 400);
  }
  log(filas.every(Boolean) ? '\nAislamiento correcto.' : '\nHAY DIFERENCIAS DE AISLAMIENTO.');
  if (!filas.every(Boolean)) process.exitCode = 1;
}

function cmdEstado() {
  const m = leerManifiesto();
  if (!m) return log('Sin manifiesto para esta cuenta.');
  log(JSON.stringify({ taller: m.taller, estado: m.estado, hoy: m.hoy, hechas: m.hechas, jornadas: m.ventanas?.length, cronologia: m.cronologia, ultimoError: m.ultimoError }, null, 2));
}

const COMANDOS = { simular: cmdSimular, cargar: cmdCargar, cronologia: cmdCronologia, verificar: cmdVerificar, estado: cmdEstado, destino: cmdDestino, pruebas: cmdPruebas, aislamiento: cmdAislamiento };
if (!COMANDOS[comando]) {
  console.log(`Comandos: ${Object.keys(COMANDOS).join(' | ')}\nVer docs/DEMO.md`);
} else {
  Promise.resolve().then(() => COMANDOS[comando]()).catch((e) => {
    console.error(`\nError: ${e.message}`);
    process.exit(1);
  });
}
void pesos; void MARCA_SIN_FECHAR;
