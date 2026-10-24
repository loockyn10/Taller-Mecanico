// Fotografías (R2): exportación con manifiesto verificable, verificación, restauración y control del cupo. Ver docs/FOTOGRAFIAS.md.
//
//   npm run fotos -- exportar [--taller <id>] [--salida carpeta]   Baja TODAS las fotos y miniaturas (por la API de plataforma) y arma manifiesto.json
//                                                                  con el sha256 de cada archivo y su relación con D1 (foto, taller, vehículo, OT, etapa).
//   npm run fotos -- verificar <carpeta>                           Revisa una exportación contra su manifiesto (faltantes, corruptas, sobrantes).
//   npm run fotos -- restaurar <carpeta> (--local [--persist-to carpeta] | --remoto)
//                                                                  Vuelve a cargar los objetos en el bucket R2 desde una exportación verificada.
//   npm run fotos -- auditar [--taller <id>]                       Compara R2 contra D1: objetos huérfanos y fotos sin archivo.
//   npm run fotos -- uso                                           Consumo de fotos por taller.
//   npm run fotos -- limite <taller_id> <MB>                       Ajusta el límite de fotografías de un taller (por defecto 2048 MB).
//   npm run fotos -- limpiar                                       Termina de borrar fotos eliminadas o a medias.
//   npm run fotos -- respaldo --salida carpeta [--base indice.json] [--completo] [--plataforma]
//                                                                  Respaldo PROGRAMADO: copia sólo las fotos nuevas, las cifra con la clave pública y las verifica de punta a punta.
//                                                                  Lo ejecuta GitHub Actions (.github/workflows/respaldo-fotos.yml). Con FOTOS_BACKUP_TOKEN (sólo lectura); --plataforma usa el token de plataforma.
//   npm run fotos -- respaldo-restaurar <paquete.fbk>... --indice indice.json --clave-privada PRIVADA.pem --salida carpeta
//                                                                  Deshace la cadena de paquetes (el completo primero) y arma la carpeta que entienden `verificar` y `restaurar`.
//
// Variables: FIERRO_API (por defecto http://127.0.0.1:8787; producción: https://taller-mecanico.estrubia455.workers.dev) y PLATFORM_ADMIN_TOKEN
// (por defecto se lee de .dev.vars, que sólo sirve en local: en producción es un secreto del Worker y hay que exportarlo en el entorno).
// Las exportaciones contienen fotos privadas de los clientes: se guardan en respaldos/ (fuera de git) y no se entregan.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, esperarProceso, wrangler } from './lib.mjs';
import { extension, rutasDe, sha256, verificarCarpeta } from './fotos-lib.mjs';
import { respaldarFotos, restaurarCadena } from './fotos-respaldo-lib.mjs';

const API = (process.env.FIERRO_API ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const BUCKET = 'fierro-fotos';

function token() {
  if (process.env.PLATFORM_ADMIN_TOKEN) return process.env.PLATFORM_ADMIN_TOKEN;
  const vars = fs.existsSync(path.join(ROOT, '.dev.vars')) ? fs.readFileSync(path.join(ROOT, '.dev.vars'), 'utf8') : '';
  const t = /PLATFORM_ADMIN_TOKEN=(.+)/.exec(vars)?.[1]?.trim();
  if (!t) throw new Error('Falta PLATFORM_ADMIN_TOKEN (variable de entorno o .dev.vars)');
  return t;
}
const cab = () => ({ authorization: `Bearer ${token()}`, 'content-type': 'application/json' });

async function api(metodo, ruta, cuerpo) {
  const r = await fetch(`${API}/api/platform${ruta}`, { method: metodo, headers: cab(), body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${metodo} ${ruta} → ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
async function bajar(ruta) {
  const r = await fetch(`${API}/api/platform${ruta}`, { headers: cab() });
  if (!r.ok) throw new Error(`${ruta} → ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

function opciones(args) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) o[args[i].slice(2)] = args[i + 1] === undefined || args[i + 1].startsWith('--') ? true : args[++i];
    else o._.push(args[i]);
  }
  return o;
}

async function exportar(o) {
  const fecha = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2');
  const salida = path.resolve(typeof o.salida === 'string' ? o.salida : path.join(ROOT, 'respaldos', `fotos-${fecha}`));
  fs.mkdirSync(salida, { recursive: true });
  const fotos = [];
  let despues = '';
  do {
    const p = await api('GET', `/fotos/manifiesto?despues=${encodeURIComponent(despues)}${o.taller ? `&taller=${encodeURIComponent(o.taller)}` : ''}`);
    fotos.push(...p.fotos);
    despues = p.siguiente ?? '';
  } while (despues);
  console.log(`Fotos en D1 (listas): ${fotos.length}. Exportando a ${salida}`);
  const errores = [];
  let hechas = 0;
  const cola = [...fotos];
  const trabajar = async () => {
    for (let f = cola.shift(); f; f = cola.shift()) {
      const { archivo, miniatura } = rutasDe(f);
      for (const [ruta, variante, sha] of [
        [archivo, 'original', f.sha256],
        [miniatura, 'miniatura', f.miniatura_sha256],
      ]) {
        const destino = path.join(salida, ruta);
        fs.mkdirSync(path.dirname(destino), { recursive: true });
        if (fs.existsSync(destino) && sha256(fs.readFileSync(destino)) === sha) continue; // exportación reanudable
        try {
          const b = await bajar(`/fotos/${f.id}/archivo${variante === 'miniatura' ? '?variante=miniatura' : ''}`);
          if (sha256(b) !== sha) throw new Error('el sha256 del archivo bajado no coincide con D1');
          fs.writeFileSync(destino, b);
        } catch (e) {
          errores.push({ foto: f.id, archivo: ruta, error: String(e.message ?? e) });
        }
      }
      if (++hechas % 50 === 0) console.log(`  ${hechas}/${fotos.length}`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, trabajar));
  const buenas = fotos.filter((f) => !errores.some((e) => e.foto === f.id));
  fs.writeFileSync(
    path.join(salida, 'manifiesto.json'),
    JSON.stringify({ generado: new Date().toISOString(), origen: API, bucket: BUCKET, nota: 'sha256 tomados de D1 y comprobados contra lo descargado de R2', fotos: buenas.map((f) => ({ ...f, ...rutasDe(f) })), errores }, null, 1),
  );
  const v = verificarCarpeta(salida);
  console.log(`Exportadas ${v.correctas} de ${fotos.length} fotos verificadas por sha256 · errores: ${errores.length}`);
  if (errores.length) console.log(errores.slice(0, 5));
  console.log(`Manifiesto: ${path.join(salida, 'manifiesto.json')}`);
  console.log('ATENCIÓN: contiene fotos privadas de clientes. No se sube a git ni se entrega.');
  if (errores.length || v.faltantes.length || v.corruptas.length) process.exitCode = 1;
}

function verificar(o) {
  const dir = o._[1];
  if (!dir) throw new Error('Indicá la carpeta de la exportación');
  const v = verificarCarpeta(path.resolve(dir));
  console.log(`Exportación del ${v.generado} (origen ${v.origen})`);
  console.log(`  Fotos en el manifiesto: ${v.total} · correctas: ${v.correctas}`);
  console.log(`  Archivos faltantes: ${v.faltantes.length} · corruptos: ${v.corruptas.length} · sobrantes: ${v.sobrantes.length}`);
  for (const l of [...v.faltantes, ...v.corruptas].slice(0, 10)) console.log(`   - ${l}`);
  if (v.faltantes.length || v.corruptas.length) process.exitCode = 1;
  else console.log('  Exportación íntegra.');
}

async function restaurar(o) {
  const dir = path.resolve(o._[1] ?? '');
  const v = verificarCarpeta(dir); // nunca se restaura algo sin verificar
  if (v.faltantes.length || v.corruptas.length) throw new Error('La exportación no está íntegra: corregila antes de restaurar (npm run fotos -- verificar)');
  const remoto = !!o.remoto;
  if (!remoto && !o.local) throw new Error('Indicá --local o --remoto');
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifiesto.json'), 'utf8'));
  let n = 0;
  for (const f of m.fotos) {
    for (const [clave, ruta] of [
      [f.clave, f.archivo],
      [f.clave_miniatura, f.miniatura],
    ]) {
      await esperarProceso(
        wrangler(['r2', 'object', 'put', `${BUCKET}/${clave}`, '--file', path.join(dir, ruta), '--content-type', f.mime, remoto ? '--remote' : '--local', ...(o['persist-to'] ? ['--persist-to', o['persist-to']] : [])], { stdio: 'pipe' }),
      );
    }
    if (++n % 20 === 0) console.log(`  ${n}/${m.fotos.length}`);
  }
  console.log(`Restauradas ${m.fotos.length} fotos en el bucket ${BUCKET} (${remoto ? 'remoto' : 'local'}). Ahora: npm run fotos -- auditar`);
}

async function auditar(o) {
  const a = await api('GET', `/fotos/auditoria${o.taller ? `?taller=${encodeURIComponent(o.taller)}` : ''}`);
  console.log(`Objetos en R2: ${a.objetos_en_r2} · filas en D1: ${a.filas_en_d1}`);
  console.log(`  Huérfanos (en R2 sin fila en D1): ${a.huerfanos_total}`);
  console.log(`  Faltantes (fila "lista" sin archivo en R2): ${a.faltantes_total}`);
  for (const k of [...a.huerfanos, ...a.faltantes].slice(0, 10)) console.log(`   - ${k}`);
  if (a.huerfanos_total || a.faltantes_total) process.exitCode = 1;
}

async function respaldo(o) {
  const pem = process.env.FIERRO_RESPALDO_CLAVE_PUBLICA || (o['clave-publica'] ? fs.readFileSync(o['clave-publica'], 'utf8') : null);
  if (!pem) throw new Error('Falta la clave pública: variable FIERRO_RESPALDO_CLAVE_PUBLICA (o --clave-publica archivo.pem)');
  const plataforma = !!o.plataforma;
  const tokenResp = plataforma ? token() : process.env.FOTOS_BACKUP_TOKEN;
  if (!tokenResp) throw new Error('Falta FOTOS_BACKUP_TOKEN (el secreto de sólo lectura del respaldo de fotos)');
  const indiceBase = typeof o.base === 'string' && fs.existsSync(o.base) ? JSON.parse(fs.readFileSync(o.base, 'utf8')) : null;
  if (typeof o.base === 'string' && !indiceBase) console.log('Sin índice anterior: se hace una copia completa.');
  const dias = Number(o['completo-cada']);
  const indice = await respaldarFotos({
    api: API,
    token: tokenResp,
    modo: plataforma ? 'plataforma' : 'respaldo',
    clavePublicaPem: pem,
    salida: path.resolve(typeof o.salida === 'string' ? o.salida : path.join(ROOT, 'respaldos', 'fotos-programado')),
    indiceBase,
    completo: !!o.completo,
    completoCadaDias: dias > 0 ? dias : 30,
    log: console.log,
  });
  console.log(`Respaldo de fotos terminado (${indice.tipo}): ${indice.fotos_total} fotos vigentes · ${indice.copiadas} copiadas ahora · cadena de ${indice.cadena.length} paquete(s).`);
}

async function respaldoRestaurar(o) {
  const paquetes = o._.slice(1).map((p) => path.resolve(p));
  if (!paquetes.length || typeof o.indice !== 'string' || typeof o['clave-privada'] !== 'string' || typeof o.salida !== 'string') throw new Error('Uso: respaldo-restaurar <paquete.fbk>... --indice indice.json --clave-privada PRIVADA.pem --salida carpetaNueva');
  const r = await restaurarCadena({
    paquetes,
    clavePrivadaPem: fs.readFileSync(o['clave-privada'], 'utf8'),
    indice: JSON.parse(fs.readFileSync(o.indice, 'utf8')),
    salida: path.resolve(o.salida),
  });
  console.log(`Carpeta reconstruida y verificada: ${r.fotos} fotos${r.descartadas ? ` (${r.descartadas} eliminadas después de ese paquete, descartadas)` : ''}.`);
  console.log('Siguiente: npm run fotos -- restaurar <carpeta> --remoto   y después   npm run fotos -- auditar');
}

async function uso() {
  const u = await api('GET', '/almacenamiento');
  console.log(`Almacenamiento de fotos ${u.habilitado ? 'habilitado' : 'NO habilitado (falta el bucket R2)'}`);
  const mb = (b) => `${(b / 1024 ** 2).toFixed(1)} MB`;
  for (const t of u.talleres) console.log(`  ${t.nombre.padEnd(32)} ${String(t.cantidad).padStart(6)} fotos · ${mb(t.usado_bytes).padStart(10)} de ${mb(t.limite_bytes)}  (${t.taller_id})`);
}

const [, , comando, ...resto] = process.argv;
const o = opciones([comando ?? '', ...resto]);
try {
  if (comando === 'exportar') await exportar(o);
  else if (comando === 'verificar') verificar(o);
  else if (comando === 'restaurar') await restaurar(o);
  else if (comando === 'auditar') await auditar(o);
  else if (comando === 'respaldo') await respaldo(o);
  else if (comando === 'respaldo-restaurar') await respaldoRestaurar(o);
  else if (comando === 'uso') await uso();
  else if (comando === 'limite') {
    const [, id, mb] = o._;
    if (!id || !Number(mb)) throw new Error('Uso: limite <taller_id> <MB>');
    const r = await api('PATCH', `/talleres/${id}/almacenamiento`, { fotos_limite_mb: Number(mb) });
    console.log(`Límite de fotografías: ${(r.limite_bytes / 1024 ** 2).toFixed(0)} MB (usados ${(r.usado_bytes / 1024 ** 2).toFixed(1)} MB)`);
  } else if (comando === 'limpiar') console.log(await api('POST', '/fotos/limpiar', {}));
  else console.log('Uso: npm run fotos -- exportar | verificar <carpeta> | restaurar <carpeta> --local|--remoto | auditar | uso | limite <taller> <MB> | limpiar | respaldo | respaldo-restaurar');
} catch (e) {
  console.error(`Error: ${e.message ?? e}`);
  process.exitCode = 1;
}
