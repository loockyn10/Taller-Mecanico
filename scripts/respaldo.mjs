// Respaldo, verificación y exportación (ver docs/RESPALDOS.md).
//
//   npm run respaldo -- plataforma [--etiqueta antes-sprint12]   Respaldo de TODA la D1 remota (operador). Lo deja en respaldos/, anota el bookmark de
//                                                                Time Travel y verifica el archivo con un ensayo de restauración en memoria.
//   npm run respaldo -- verificar <archivo.sql>                  Ensayo de restauración en memoria: integridad, claves foráneas, filas por tabla y migraciones.
//   npm run respaldo -- ensayar-migraciones <archivo.sql>        Aplica las migraciones pendientes del proyecto sobre una COPIA EN MEMORIA del respaldo y demuestra
//                                                                que los datos existentes quedan idénticos (filas y contenido) y la base íntegra.
//   npm run respaldo -- talleres <archivo.sql>                   Lista los talleres que contiene un respaldo.
//   npm run respaldo -- exportar-taller <archivo.sql> <taller> [--salida carpeta]
//                                                                Exporta los datos de UN taller (por id o nombre exacto): JSON + CSV sin credenciales ni
//                                                                datos de otros talleres. Es lo único que puede recibir un propietario.
//
//   npm run respaldo -- programado [--salida carpeta] [--avisar]  Respaldo PROGRAMADO (GitHub Actions): exporta, verifica, cifra con la clave pública y deja el .fbk.
//   npm run respaldo -- generar-claves --salida carpeta           Par de claves RSA para cifrar los respaldos (la privada se guarda fuera de GitHub y de Cloudflare).
//   npm run respaldo -- descifrar <archivo.fbk> --clave-privada pem
//   npm run respaldo -- restaurar-aislado <archivo> [--clave-privada pem] [--migrar] [--servir]   Restaura sobre una instancia LOCAL aislada y verifica.
//
// NO restaura nada en producción. La restauración ante un incidente se hace con Time Travel (`wrangler d1 time-travel restore`) o aplicando el .sql a una base nueva:
// ver docs/RESPALDOS.md. El respaldo de plataforma contiene TODOS los talleres y los hashes de las contraseñas: se guarda en respaldos/ (fuera de git) y no se entrega.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, esperarServidor, wrangler } from './lib.mjs';
import { cargarRespaldo, controlesContables, ensayarMigraciones, escribirExportacion, exportarTaller, haySqlite, sha256Archivo, verificarRespaldo } from './respaldo-lib.mjs';
import { cifrarArchivo, descifrarArchivo, generarClaves, huellaClavePublica } from './respaldo-cifrado.mjs';

const [, , comando, ...resto] = process.argv;

function opciones(args) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) o[args[i].slice(2)] = args[i + 1] === undefined || args[i + 1].startsWith('--') ? '' : args[++i];
    else o._.push(args[i]);
  }
  return o;
}
const migracionesDelProyecto = () => fs.readdirSync(path.join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
const ahoraCorto = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2');

function salida(proceso) {
  return new Promise((resolve, reject) => {
    let out = '';
    proceso.stdout?.on('data', (d) => (out += d));
    proceso.stderr?.on('data', (d) => (out += d));
    proceso.on('error', reject);
    proceso.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`wrangler terminó con código ${code}\n${out.slice(-600)}`))));
  });
}

function informe(v, archivo) {
  console.log(`Archivo: ${archivo}`);
  console.log(`  Integridad de la base: ${v.integridadOk ? 'ok' : `FALLA (${v.integridad.slice(0, 3).join(' | ')})`}`);
  console.log(`  Claves foráneas rotas: ${v.violacionesClaves}`);
  console.log(`  Tablas: ${v.tablas.length} · filas: ${v.totalFilas}`);
  console.log(`  Talleres: ${v.talleres.map((t) => t.nombre).join(', ') || '—'}`);
  console.log(`  Migraciones aplicadas: ${v.migracionesAplicadas.length}${v.migracionesPendientes.length ? ` · pendientes respecto del proyecto: ${v.migracionesPendientes.join(', ')}` : ' · al día con el proyecto'}`);
  return v.integridadOk && v.violacionesClaves === 0;
}

async function plataforma(o) {
  fs.mkdirSync(path.join(ROOT, 'respaldos'), { recursive: true });
  const etiqueta = (o.etiqueta ?? 'manual').replace(/[^A-Za-z0-9_-]/g, '');
  const archivo = path.join(ROOT, 'respaldos', `d1-${etiqueta}-${ahoraCorto()}.sql`);
  if (fs.existsSync(archivo)) throw new Error(`Ya existe ${archivo}`);
  console.log('Exportando la D1 remota (puede demorar unos segundos)…');
  await salida(wrangler(['d1', 'export', 'DB', '--remote', '--output', archivo], { stdio: 'pipe' }));
  let bookmark = null;
  try {
    const t = await salida(wrangler(['d1', 'time-travel', 'info', 'DB'], { stdio: 'pipe' }));
    bookmark = /bookmark[^\n]*?([0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32})/i.exec(t)?.[1] ?? null;
  } catch {
    /* sin Time Travel no se pierde el respaldo */
  }
  const db = cargarRespaldo(archivo);
  const v = verificarRespaldo(db, { migracionesDelProyecto: migracionesDelProyecto() });
  db.close();
  const ok = informe(v, archivo);
  const manifiesto = { archivo: path.basename(archivo), generado: new Date().toISOString(), sha256: sha256Archivo(archivo), bookmarkTimeTravel: bookmark, ok, integridad: v.integridadOk, violacionesClaves: v.violacionesClaves, tablas: v.tablas, migracionesAplicadas: v.migracionesAplicadas };
  fs.writeFileSync(`${archivo}.manifiesto.json`, JSON.stringify(manifiesto, null, 2));
  console.log(`  SHA-256: ${manifiesto.sha256}`);
  console.log(`  Bookmark de Time Travel (anotalo antes de migrar): ${bookmark ?? 'no se pudo leer'}`);
  console.log(`  Manifiesto: ${archivo}.manifiesto.json`);
  console.log('ATENCIÓN: este archivo contiene TODOS los talleres y los hashes de las contraseñas. No se entrega a ningún cliente ni se sube a git.');
  if (!ok) process.exit(1);
}

function verificar(o) {
  const archivo = o._[0];
  if (!archivo) throw new Error('Indicá el archivo .sql');
  if (!haySqlite()) throw new Error('Este Node no incluye node:sqlite (usá Node 22.5 o superior)');
  const db = cargarRespaldo(archivo);
  const v = verificarRespaldo(db, { migracionesDelProyecto: migracionesDelProyecto() });
  db.close();
  let ok = informe(v, archivo);
  const mf = `${archivo}.manifiesto.json`;
  if (fs.existsSync(mf)) {
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    const igual = m.sha256 === sha256Archivo(archivo);
    console.log(`  Manifiesto: el archivo ${igual ? 'coincide' : 'NO coincide (fue modificado)'} con su huella SHA-256`);
    ok = ok && igual;
  }
  if (!ok) process.exit(1);
}

function ensayar(o) {
  const archivo = o._[0];
  if (!archivo) throw new Error('Indicá el archivo .sql');
  const db = cargarRespaldo(archivo);
  const aplicadas = db.prepare('SELECT name FROM d1_migrations').all().map((r) => r.name);
  const pendientes = migracionesDelProyecto().filter((m) => !aplicadas.includes(m)).map((name) => ({ name, sql: fs.readFileSync(path.join(ROOT, 'migrations', name), 'utf8') }));
  if (!pendientes.length) {
    console.log('No hay migraciones pendientes respecto de este respaldo.');
    db.close();
    return;
  }
  const r = ensayarMigraciones(db, pendientes);
  db.close();
  console.log(`Migraciones ensayadas: ${r.aplicadas.join(', ') || '—'}`);
  console.log(`  Tablas comparadas: ${r.tablasComparadas} · filas comparadas: ${r.filasComparadas} → ${r.cambios.length ? `${r.cambios.length} CON CAMBIOS` : 'todas idénticas'}`);
  for (const c of r.cambios) console.log(`    ✗ ${c.tabla}: ${c.motivo}`);
  console.log(`  Tablas nuevas: ${r.nuevas.join(', ') || '—'}`);
  console.log(`  Columnas nuevas: ${r.columnasNuevas.map((x) => `${x.tabla}(${x.columnas.join(',')})`).join(' ') || '—'}`);
  console.log(`  Integridad: ${r.integridadOk ? 'ok' : 'FALLA'} · claves foráneas rotas: ${r.violacionesClaves}`);
  for (const e of r.errores) console.log(`  ✗ ${e}`);
  if (!r.ok) process.exit(1);
}

function talleres(o) {
  const db = cargarRespaldo(o._[0]);
  for (const t of db.prepare('SELECT id, nombre, activo FROM talleres ORDER BY nombre').all()) console.log(`${t.id}  ${t.nombre}${t.activo ? '' : '  (inactivo)'}`);
  db.close();
}

function exportar(o) {
  const [archivo, taller] = o._;
  if (!archivo || !taller) throw new Error('Uso: exportar-taller <archivo.sql> <taller id o nombre exacto> [--salida carpeta]');
  const db = cargarRespaldo(archivo);
  const candidatos = db.prepare('SELECT id, nombre FROM talleres WHERE id = ? OR nombre = ?').all(taller, taller);
  if (candidatos.length !== 1) {
    db.close();
    throw new Error(candidatos.length ? `El nombre «${taller}» coincide con ${candidatos.length} talleres: usá el id` : `No hay ningún taller «${taller}» en el respaldo`);
  }
  const exp = exportarTaller(db, candidatos[0].id);
  db.close();
  const carpeta = path.resolve(o.salida ?? path.join(ROOT, 'respaldos', `taller-${candidatos[0].id.slice(0, 8)}-${ahoraCorto()}`));
  const r = escribirExportacion(exp, carpeta, { origenSha256: sha256Archivo(archivo) });
  console.log(`Exportación de «${exp.taller.nombre}»: ${r.manifiesto.totalFilas} filas en ${exp.resumen.length} tablas → ${carpeta}`);
  console.log(`Tablas omitidas (secretos o de la plataforma): ${exp.omitidas.map((x) => x.tabla).join(', ')}`);
}


// ───────────────────────── Sprint 13: respaldo programado, cifrado y restauración aislada ─────────────────────────
const sinSecretos = (m) => String(m).split('\n')[0].replace(/(token|bearer|secret|clave)[^\s]*/gi, '$1…').slice(0, 200);
const sello = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const mb = (b) => `${(b / 1024 / 1024).toFixed(2)} MB`;

/** Aviso al Worker (si hay token): lo recibe /api/plataforma/respaldo-latido y lo muestra la salud de plataforma. Nunca hace fallar el respaldo. */
async function avisar(cuerpo) {
  const url = process.env.FIERRO_URL;
  const token = process.env.BACKUP_REPORT_TOKEN;
  if (!url || !token) {
    console.log('  Aviso a la plataforma: omitido (faltan FIERRO_URL y/o BACKUP_REPORT_TOKEN)');
    return;
  }
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/api/plataforma/respaldo-latido`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(cuerpo), signal: AbortSignal.timeout(20000) });
    console.log(`  Aviso a la plataforma: HTTP ${r.status}`);
  } catch (e) {
    console.log(`  Aviso a la plataforma: no se pudo enviar (${sinSecretos(e.message)})`);
  }
}

/**
 * Respaldo PROGRAMADO (lo ejecuta GitHub Actions, ver .github/workflows/respaldo-d1.yml; también sirve a mano): exporta la D1 completa, la verifica
 * (integridad, claves foráneas, migraciones, controles contables), la comprime y la CIFRA con la clave pública, comprueba que el cifrado se puede
 * deshacer y deja el archivo .fbk + un manifiesto SIN datos comerciales en la carpeta de salida. El SQL sin cifrar vive sólo en una carpeta temporal que se
 * borra siempre. Termina con error ante cualquier falla. No imprime credenciales ni nombres de talleres.
 */
async function programado(o) {
  const salidaDir = path.resolve(o.salida || path.join(os.tmpdir(), 'fierro-respaldo-salida'));
  const pem = process.env.FIERRO_RESPALDO_CLAVE_PUBLICA || (o['clave-publica'] ? fs.readFileSync(o['clave-publica'], 'utf8') : null);
  if (!pem) throw new Error('Falta la clave pública: variable FIERRO_RESPALDO_CLAVE_PUBLICA (o --clave-publica archivo.pem). Se genera con «generar-claves».');
  if (!haySqlite()) throw new Error('Este Node no incluye node:sqlite (usá Node 22.13 o superior)');
  const etiqueta = sello();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fierro-bak-'));
  const t0 = Date.now();
  let manifiesto = null;
  try {
    const sql = path.join(tmp, 'export.sql');
    console.log(`Respaldo programado ${etiqueta}: exportando la D1 remota…`);
    try {
      await salida(wrangler(['d1', 'export', 'DB', '--remote', '--output', sql], { stdio: 'pipe' }));
    } catch (e) {
      throw new Error(`La exportación de la D1 falló (${sinSecretos(e.message)}). Revisá CLOUDFLARE_API_TOKEN (permiso D1: Edit) y CLOUDFLARE_ACCOUNT_ID.`);
    }
    const bytes = fs.statSync(sql).size;
    if (bytes < 20_000) throw new Error(`El respaldo exportado pesa ${bytes} bytes: es demasiado chico para ser una base de Fierro`);
    const db = cargarRespaldo(sql);
    const v = verificarRespaldo(db, { migracionesDelProyecto: migracionesDelProyecto() });
    const cc = controlesContables(db);
    db.close();
    const problemas = [];
    if (!v.integridadOk) problemas.push('la integridad de la base falla');
    if (v.violacionesClaves) problemas.push(`${v.violacionesClaves} claves foráneas rotas`);
    if (!v.talleres.length) problemas.push('no hay talleres en el respaldo');
    if (v.migracionesPendientes.length > 2) problemas.push(`faltan ${v.migracionesPendientes.length} migraciones aplicadas`);
    if (cc.aplica && !cc.ok) problemas.push(`controles contables con diferencias (${cc.controles.filter((c) => !c.ok).map((c) => c.clave).join(', ') || 'debe≠haber'})`);
    console.log(`  Verificación: integridad ${v.integridadOk ? 'ok' : 'FALLA'} · claves foráneas rotas ${v.violacionesClaves} · ${v.tablas.length} tablas · ${v.totalFilas} filas · ${v.talleres.length} talleres · migraciones ${v.migracionesAplicadas.length}`);
    if (cc.aplica) console.log(`  Contabilidad: ${cc.ok ? 'ok' : 'CON DIFERENCIAS'} (${cc.controles.map((c) => `${c.clave}=${c.valor}`).join(' · ')}) · cola: ${cc.cola.pendientes} pendientes, ${cc.cola.fallidas} fallidas`);
    fs.mkdirSync(salidaDir, { recursive: true });
    const nombre = `fierro-d1-${etiqueta}.sql.fbk`;
    const destino = path.join(salidaDir, nombre);
    const c = await cifrarArchivo(sql, destino, pem);
    // Prueba del cifrado: se vuelve a descifrar con la clave de datos y debe dar exactamente el mismo contenido.
    const comprobado = path.join(tmp, 'comprobacion.sql');
    const d = await descifrarArchivo(destino, comprobado, { claveDatos: c.claveDatos });
    if (d.sha256 !== c.sha256Original) throw new Error('El archivo cifrado no reproduce el original: se descarta el respaldo');
    fs.rmSync(comprobado, { force: true });
    manifiesto = {
      generado: new Date().toISOString(), archivo: nombre, formato: 'FIERRO-BAK1 (gzip + AES-256-GCM, clave de datos envuelta con RSA-4096)', huellaClavePublica: huellaClavePublica(pem),
      sha256Original: c.sha256Original, bytesOriginal: c.bytesOriginal, bytesCifrado: c.bytesCifrado, duracionSeg: Math.round((Date.now() - t0) / 1000),
      tablas: v.tablas.length, filas: v.totalFilas, talleres: v.talleres.length, migraciones: v.migracionesAplicadas.length, integridad: v.integridadOk, violacionesClaves: v.violacionesClaves,
      contabilidad: cc.aplica ? { ok: cc.ok, controles: Object.fromEntries(cc.controles.map((x) => [x.clave, x.valor])), asientos: cc.porTaller.reduce((a, t) => a + t.asientos, 0), cola: cc.cola } : null,
      problemas,
    };
    fs.writeFileSync(path.join(salidaDir, `${nombre}.manifiesto.json`), JSON.stringify(manifiesto, null, 2));
    console.log(`  Archivo cifrado: ${nombre} (${mb(c.bytesCifrado)}; el SQL original pesaba ${mb(c.bytesOriginal)}) · SHA-256 del original ${c.sha256Original.slice(0, 16)}… · comprobado: descifra igual`);
    if (problemas.length) throw new Error(`El respaldo se generó pero NO pasó las verificaciones: ${problemas.join('; ')}`);
    console.log(`Respaldo programado terminado en ${manifiesto.duracionSeg} s.`);
    if (o.avisar !== undefined) await avisar({ ok: true, sha256: c.sha256Original, bytes: c.bytesCifrado, tablas: v.tablas.length, filas: v.totalFilas, talleres: v.talleres.length, etiqueta });
  } catch (e) {
    console.error(`Respaldo programado FALLÓ: ${sinSecretos(e.message)}`);
    if (o.avisar !== undefined) await avisar({ ok: false, error: sinSecretos(e.message), etiqueta });
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function generarClavesCmd(o) {
  if (!o.salida) throw new Error('Indicá una carpeta NUEVA y FUERA del repositorio: --salida C:\\ruta\\segura');
  const carpeta = path.resolve(o.salida);
  if (carpeta.startsWith(ROOT)) throw new Error('La carpeta de claves no puede estar dentro del repositorio');
  const r = generarClaves(carpeta);
  console.log(`Claves generadas en ${carpeta}`);
  console.log(`  Pública : ${r.publica}   (va en la variable del repositorio FIERRO_RESPALDO_CLAVE_PUBLICA; huella ${r.huella})`);
  console.log(`  PRIVADA : ${r.privada}   (guardala FUERA de GitHub y de Cloudflare, con al menos dos copias; sin ella los respaldos no se pueden abrir)`);
}

async function descifrarCmd(o) {
  const [entrada] = o._;
  if (!entrada || !o['clave-privada']) throw new Error('Uso: descifrar <archivo.sql.fbk> --clave-privada <PRIVADA.pem> [--salida archivo.sql]');
  const destino = path.resolve(o.salida || entrada.replace(/\.fbk$/, ''));
  const r = await descifrarArchivo(entrada, destino, { clavePrivadaPem: fs.readFileSync(o['clave-privada'], 'utf8'), frase: process.env.FIERRO_RESPALDO_FRASE });
  console.log(`Descifrado en ${destino} (${mb(r.bytes)}, SHA-256 ${r.sha256.slice(0, 16)}…). Es la base completa con TODOS los talleres: guardala con el mismo cuidado.`);
}

function archivoSqliteLocal(estado) {
  const dir = path.join(estado, 'v3', 'd1', 'miniflare-D1DatabaseObject');
  const f = fs.readdirSync(dir).find((x) => x.endsWith('.sqlite'));
  if (!f) throw new Error('No se encontró la base restaurada');
  return path.join(dir, f);
}

/**
 * Restauración sobre una instancia AISLADA (D1 local de Miniflare en una carpeta temporal; jamás la base de producción): carga el respaldo, lo compara tabla por
 * tabla con el archivo original, corre integridad, claves foráneas y los controles contables, y con `--servir` levanta el Worker sobre lo restaurado y
 * consulta la API de plataforma. `--migrar` aplica además las migraciones del proyecto que falten (el camino real: restaurar y llevar al día).
 */
async function restaurarAislado(o) {
  let [entrada] = o._;
  if (!entrada) throw new Error('Uso: restaurar-aislado <archivo.sql | archivo.sql.fbk> [--clave-privada PRIVADA.pem] [--migrar] [--servir] [--conservar]');
  if (!haySqlite()) throw new Error('Este Node no incluye node:sqlite (usá Node 22.13 o superior)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fierro-restauracion-'));
  let servidor = null;
  try {
    if (entrada.endsWith('.fbk')) {
      if (!o['clave-privada']) throw new Error('El archivo está cifrado: indicá --clave-privada');
      const claro = path.join(tmp, 'respaldo.sql');
      await descifrarArchivo(entrada, claro, { clavePrivadaPem: fs.readFileSync(o['clave-privada'], 'utf8'), frase: process.env.FIERRO_RESPALDO_FRASE });
      entrada = claro;
      console.log('Respaldo descifrado en una carpeta temporal (se borra al terminar).');
    }
    // 1) Lo que dice el archivo, leído en memoria
    const fuente = cargarRespaldo(entrada);
    const vFuente = verificarRespaldo(fuente, { migracionesDelProyecto: migracionesDelProyecto() });
    fuente.close();
    // 2) Restauración real sobre un D1 local vacío
    const estado = path.join(tmp, 'estado');
    console.log('Restaurando sobre una instancia local aislada (wrangler d1 execute --local)…');
    await salida(wrangler(['d1', 'execute', 'DB', '--local', '--persist-to', estado, '--file', entrada], { stdio: 'pipe' }));
    if (o.migrar !== undefined) {
      console.log('Aplicando las migraciones del proyecto que falten (sobre la copia restaurada)…');
      await salida(wrangler(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', estado], { stdio: 'pipe' }));
    }
    const { DatabaseSync } = await import('node:sqlite');
    const restaurada = new DatabaseSync(archivoSqliteLocal(estado), { readOnly: true });
    const vRest = verificarRespaldo(restaurada, { migracionesDelProyecto: migracionesDelProyecto() });
    const cc = controlesContables(restaurada);
    // 3) Comparación tabla por tabla (si se migró, sólo las tablas que ya existían en el respaldo)
    const origen = new Map(vFuente.tablas.map((t) => [t.tabla, t.filas]));
    const destino = new Map(vRest.tablas.map((t) => [t.tabla, t.filas]));
    const faltan = [...origen.keys()].filter((t) => !destino.has(t));
    const distintas = [...origen.entries()].filter(([t, n]) => destino.has(t) && destino.get(t) !== n && t !== 'd1_migrations').map(([t, n]) => `${t}: ${n} → ${destino.get(t)}`);
    console.log(`  Integridad: ${vRest.integridadOk ? 'ok' : 'FALLA'} · claves foráneas rotas: ${vRest.violacionesClaves} · tablas: ${vRest.tablas.length} (respaldo: ${vFuente.tablas.length}) · filas: ${vRest.totalFilas} (respaldo: ${vFuente.totalFilas})`);
    console.log(`  Tablas del respaldo que faltan en la restauración: ${faltan.length ? faltan.join(', ') : 'ninguna'} · con filas distintas: ${distintas.length ? distintas.join('; ') : 'ninguna'}`);
    console.log(`  Talleres restaurados: ${vRest.talleres.length}`);
    if (cc.aplica) {
      console.log(`  Contabilidad restaurada: ${cc.ok ? 'ok' : 'CON DIFERENCIAS'}`);
      for (const c of cc.controles) console.log(`    ${c.ok ? '✓' : '✗'} ${c.nombre}: ${c.valor}`);
      for (const t of cc.porTaller.filter((x) => x.asientos)) console.log(`    · ${t.nombre}: ${t.asientos} asientos, ${t.lineas} líneas, Debe ${t.debe / 100} = Haber ${t.haber / 100}${t.debe === t.haber ? '' : '  ✗ NO CUADRA'}`);
      console.log(`    · cola de contabilización: ${cc.cola.pendientes} pendientes, ${cc.cola.fallidas} fallidas`);
    }
    restaurada.close();
    let ok = vRest.integridadOk && vRest.violacionesClaves === 0 && !faltan.length && !distintas.length && cc.ok;
    // 4) La aplicación sobre lo restaurado
    if (o.servir !== undefined) {
      const puerto = Number(o.puerto || 8793);
      const token = `restauracion-${Math.random().toString(36).slice(2)}-${Date.now()}`;
      servidor = wrangler(['dev', '--port', String(puerto), '--persist-to', estado, '--var', `PLATFORM_ADMIN_TOKEN:${token}`, '--show-interactive-dev-session=false'], { stdio: 'pipe' });
      servidor.stdout?.on('data', () => {});
      servidor.stderr?.on('data', () => {});
      await esperarServidor(`http://127.0.0.1:${puerto}/api/salud`, 120_000);
      const get = async (ruta) => {
        const r = await fetch(`http://127.0.0.1:${puerto}${ruta}`, { headers: { authorization: `Bearer ${token}` } });
        return { status: r.status, body: await r.json().catch(() => null) };
      };
      const talleres = await get('/api/platform/talleres');
      const salud = await get('/api/platform/salud');
      const coincide = talleres.status === 200 && talleres.body.length === vRest.talleres.length;
      console.log(`  La aplicación sobre lo restaurado: /api/salud ok · plataforma lista ${talleres.body?.length ?? '?'} talleres (${coincide ? 'coincide' : 'NO coincide'}) · salud de plataforma HTTP ${salud.status}`);
      ok = ok && coincide && salud.status === 200;
    }
    console.log(ok ? 'RESTAURACIÓN VERIFICADA: tablas, relaciones y registros contables recuperados en la instancia aislada.' : 'RESTAURACIÓN CON PROBLEMAS: revisá el detalle de arriba.');
    if (!ok) process.exitCode = 1;
  } finally {
    if (servidor) {
      if (process.platform === 'win32') {
        try {
          const { execSync } = await import('node:child_process');
          execSync(`taskkill /pid ${servidor.pid} /T /F`, { stdio: 'ignore' });
        } catch { /* ya terminó */ }
      } else servidor.kill();
      await new Promise((r) => setTimeout(r, 800));
    }
    if (o.conservar === undefined) fs.rmSync(tmp, { recursive: true, force: true });
    else console.log(`Carpeta conservada (contiene datos reales de clientes si el respaldo era de producción): ${tmp}`);
  }
}

try {
  const o = opciones(resto);
  if (comando === 'plataforma') await plataforma(o);
  else if (comando === 'verificar') verificar(o);
  else if (comando === 'talleres') talleres(o);
  else if (comando === 'ensayar-migraciones') ensayar(o);
  else if (comando === 'exportar-taller') exportar(o);
  else if (comando === 'programado') await programado(o);
  else if (comando === 'generar-claves') generarClavesCmd(o);
  else if (comando === 'descifrar') await descifrarCmd(o);
  else if (comando === 'restaurar-aislado') await restaurarAislado(o);
  else {
    console.log('Uso: npm run respaldo -- plataforma [--etiqueta x] | verificar <archivo.sql> | ensayar-migraciones <archivo.sql> | talleres <archivo.sql> | exportar-taller <archivo.sql> <taller> [--salida carpeta]');
    console.log('     programado [--salida carpeta] [--clave-publica pem] [--avisar] | generar-claves --salida carpeta | descifrar <archivo.fbk> --clave-privada pem | restaurar-aislado <archivo> [--clave-privada pem] [--migrar] [--servir]');
    process.exit(comando ? 2 : 0);
  }
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
