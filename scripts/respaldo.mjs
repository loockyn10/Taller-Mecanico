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
// NO restaura nada. La restauración ante un incidente se hace con Time Travel (`wrangler d1 time-travel restore`) o aplicando el .sql a una base nueva:
// ver docs/RESPALDOS.md. El respaldo de plataforma contiene TODOS los talleres y los hashes de las contraseñas: se guarda en respaldos/ (fuera de git) y no se entrega.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, wrangler } from './lib.mjs';
import { cargarRespaldo, ensayarMigraciones, escribirExportacion, exportarTaller, haySqlite, sha256Archivo, verificarRespaldo } from './respaldo-lib.mjs';

const [, , comando, ...resto] = process.argv;

function opciones(args) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) o[args[i].slice(2)] = args[++i];
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

try {
  const o = opciones(resto);
  if (comando === 'plataforma') await plataforma(o);
  else if (comando === 'verificar') verificar(o);
  else if (comando === 'talleres') talleres(o);
  else if (comando === 'ensayar-migraciones') ensayar(o);
  else if (comando === 'exportar-taller') exportar(o);
  else {
    console.log('Uso: npm run respaldo -- plataforma [--etiqueta x] | verificar <archivo.sql> | ensayar-migraciones <archivo.sql> | talleres <archivo.sql> | exportar-taller <archivo.sql> <taller> [--salida carpeta]');
    process.exit(comando ? 2 : 0);
  }
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
