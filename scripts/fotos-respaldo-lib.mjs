// Respaldo programado de las fotografías de R2 (Sprint 18): copia INCREMENTAL, cifrada y verificable, fuera de la cuenta de Cloudflare.
//
//   · Reutiliza lo que ya existe: el manifiesto con sha256 de D1 (`/fotos/manifiesto`), la verificación de carpetas (fotos-lib.mjs) y el cifrado híbrido
//     AES-256-GCM + RSA-4096 de los respaldos de D1 (respaldo-cifrado.mjs).
//   · Una foto es inmutable (su id es su identidad y su sha256 no cambia): si ya está en un respaldo anterior no se vuelve a copiar. Cada ejecución guarda sólo
//     lo nuevo ("incremental") y cada N días una copia "completa", para que la cadena de restauración sea corta.
//   · Cada paquete se cifra con la clave PÚBLICA; sin la clave privada es ilegible. El repositorio de GitHub es público, así que nunca se sube una foto en claro.
//   · El índice (indice.json) NO está cifrado a propósito: sólo tiene ids de foto y sha256 (nada de talleres, vehículos ni clientes) y es lo que permite a la
//     siguiente ejecución saber qué ya está respaldado sin necesitar la clave privada.
//   · Las fotos se descargan a una carpeta temporal que se borra siempre al terminar (también si falla). Nada se guarda en el repositorio.
//
// Formato del paquete (antes de cifrar):  "FIERRO-FOTOPACK1\n" + por entrada: línea JSON {"p":ruta,"n":bytes,"sha256":hex} + "\n" + bytes + "\n"
//                                          y al final {"fin":true,"entradas":N}\n.  La primera entrada es siempre manifiesto.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { cifrarArchivo, descifrarArchivo } from './respaldo-cifrado.mjs';
import { rutasDe, sha256, verificarCarpeta } from './fotos-lib.mjs';

const MAGIA = 'FIERRO-FOTOPACK1\n';
const RUTA_VALIDA = /^(manifiesto\.json|[0-9A-Za-z-]{8,64}\/[0-9A-Za-z-]{8,64}(_m)?\.(jpg|webp))$/;
const MAX_ENTRADA = 96 * 1024 * 1024;

// ───────────── Paquete ─────────────

/** Escribe un paquete con `entradas` = [{ p: ruta dentro del paquete, archivo: ruta en disco }]. Devuelve cantidad y bytes. */
export function empaquetar(entradas, salida) {
  const fd = fs.openSync(salida, 'wx', 0o600);
  let bytes = 0;
  try {
    fs.writeSync(fd, MAGIA);
    for (const e of entradas) {
      if (!RUTA_VALIDA.test(e.p)) throw new Error(`Ruta no válida para el paquete: ${e.p}`);
      const datos = fs.readFileSync(e.archivo);
      fs.writeSync(fd, `${JSON.stringify({ p: e.p, n: datos.length, sha256: sha256(datos) })}\n`);
      fs.writeSync(fd, datos);
      fs.writeSync(fd, '\n');
      bytes += datos.length;
    }
    fs.writeSync(fd, `${JSON.stringify({ fin: true, entradas: entradas.length })}\n`);
  } finally {
    fs.closeSync(fd);
  }
  return { entradas: entradas.length, bytes };
}

class Lector {
  constructor(archivo) {
    this.fd = fs.openSync(archivo, 'r');
    this.pos = 0;
    this.tam = fs.fstatSync(this.fd).size;
  }
  cerrar() {
    fs.closeSync(this.fd);
  }
  bytes(n) {
    if (this.pos + n > this.tam) throw new Error('Paquete truncado');
    const b = Buffer.alloc(n);
    let leido = 0;
    while (leido < n) {
      const r = fs.readSync(this.fd, b, leido, n - leido, this.pos + leido);
      if (r === 0) throw new Error('Paquete truncado');
      leido += r;
    }
    this.pos += n;
    return b;
  }
  linea() {
    const partes = [];
    for (;;) {
      const restante = Math.min(4096, this.tam - this.pos);
      if (restante <= 0) throw new Error('Paquete truncado');
      const b = this.bytes(restante);
      const i = b.indexOf(10);
      if (i >= 0) {
        this.pos -= restante - (i + 1); // devuelve lo que sobró
        partes.push(b.subarray(0, i));
        break;
      }
      partes.push(b);
      if (partes.reduce((s, p) => s + p.length, 0) > 8192) throw new Error('Paquete dañado (encabezado demasiado largo)');
    }
    return Buffer.concat(partes).toString('utf8');
  }
}

/**
 * Desempaqueta en `destino` verificando tamaño y sha256 de cada entrada. Rechaza rutas fuera de lo esperado (no se puede escribir fuera de la carpeta)
 * y paquetes sin su cierre. Devuelve las entradas escritas.
 */
export function desempaquetar(archivo, destino) {
  const l = new Lector(archivo);
  const escritas = [];
  try {
    if (l.bytes(MAGIA.length).toString('latin1') !== MAGIA) throw new Error('No es un paquete de fotografías de Fierro');
    for (;;) {
      const cab = JSON.parse(l.linea());
      if (cab.fin) {
        if (cab.entradas !== escritas.length) throw new Error('El paquete declara otra cantidad de entradas: está incompleto o alterado');
        if (l.pos !== l.tam) throw new Error('Hay datos después del cierre del paquete');
        return escritas;
      }
      if (typeof cab.p !== 'string' || !RUTA_VALIDA.test(cab.p) || !Number.isInteger(cab.n) || cab.n < 0 || cab.n > MAX_ENTRADA) throw new Error('Entrada de paquete no válida');
      const datos = l.bytes(cab.n);
      if (l.bytes(1)[0] !== 10) throw new Error('Paquete dañado (separador)');
      if (sha256(datos) !== cab.sha256) throw new Error(`Entrada alterada: ${cab.p}`);
      const dest = path.join(destino, cab.p);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, datos);
      escritas.push({ p: cab.p, bytes: cab.n, sha256: cab.sha256 });
    }
  } finally {
    l.cerrar();
  }
}

// ───────────── Plan incremental ─────────────

/**
 * Compara las fotos actuales de D1 con el índice del respaldo anterior.
 * Una foto "ya respaldada" es una con el mismo id y los mismos sha256 (original y miniatura). Lo demás hay que copiarlo.
 * `eliminadas` son las que estaban en el respaldo anterior y ya no existen (la cadena las conserva hasta que se vence la retención).
 */
export function planIncremental(actuales, indiceBase) {
  const previas = new Map((indiceBase?.fotos ?? []).map((f) => [f.id, f]));
  const nuevas = [];
  const sinCambios = [];
  for (const f of actuales) {
    const p = previas.get(f.id);
    if (p && p.sha256 === f.sha256 && p.miniatura_sha256 === f.miniatura_sha256) sinCambios.push(f);
    else nuevas.push(f);
  }
  const vigentes = new Set(actuales.map((f) => f.id));
  const eliminadas = [...previas.keys()].filter((id) => !vigentes.has(id));
  return { nuevas, sinCambios, eliminadas };
}

const marca = (d = new Date()) => d.toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2');
const DIA = 86_400_000;

// ───────────── Respaldo ─────────────

function cliente({ api, token, modo }) {
  const base = api.replace(/\/$/, '');
  const manifiesto = (despues) => (modo === 'plataforma' ? `${base}/api/platform/fotos/manifiesto?despues=${encodeURIComponent(despues)}` : `${base}/api/plataforma/fotos-respaldo/manifiesto?despues=${encodeURIComponent(despues)}`);
  const archivo = (id, mini) => (modo === 'plataforma' ? `${base}/api/platform/fotos/${id}/archivo${mini ? '?variante=miniatura' : ''}` : `${base}/api/plataforma/fotos-respaldo/${id}/archivo${mini ? '?variante=miniatura' : ''}`);
  const cab = { authorization: `Bearer ${token}` };
  return {
    async listar() {
      const fotos = [];
      let despues = '';
      do {
        const r = await fetch(manifiesto(despues), { headers: cab });
        if (!r.ok) throw new Error(`manifiesto → ${r.status}`);
        const p = await r.json();
        fotos.push(...p.fotos);
        despues = p.siguiente ?? '';
      } while (despues);
      return fotos;
    },
    async bajar(id, mini) {
      const r = await fetch(archivo(id, mini), { headers: cab });
      if (!r.ok) throw new Error(`archivo → ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    },
  };
}

/**
 * Hace una ejecución del respaldo. Opciones:
 *   api, token, modo ('respaldo' = endpoint de sólo lectura con FOTOS_BACKUP_TOKEN | 'plataforma' = token de plataforma, para uso local),
 *   clavePublicaPem, salida (carpeta donde quedan el .fbk y el índice), indiceBase (objeto del índice anterior o null), completo (fuerza copia completa),
 *   completoCadaDias (por defecto 30), ahora (para pruebas), log (función).
 * Devuelve el índice nuevo. Lanza si no se pudo bajar o verificar todo: no deja un respaldo a medias.
 */
export async function respaldarFotos(o) {
  const log = o.log ?? (() => {});
  const ahora = o.ahora ?? new Date();
  const c = cliente(o);
  fs.mkdirSync(o.salida, { recursive: true });
  const actuales = await c.listar();
  const base = o.indiceBase ?? null;
  const vencida = base && ahora.getTime() - Date.parse(base.completo_desde ?? base.generado) > (o.completoCadaDias ?? 30) * DIA;
  const completo = !!o.completo || !base || !!vencida;
  const plan = completo ? { nuevas: actuales, sinCambios: [], eliminadas: base ? planIncremental(actuales, base).eliminadas : [] } : planIncremental(actuales, base);
  log(`Fotos en D1: ${actuales.length} · a copiar: ${plan.nuevas.length} · ya respaldadas: ${plan.sinCambios.length} · eliminadas desde el respaldo anterior: ${plan.eliminadas.length} · tipo: ${completo ? 'completo' : 'incremental'}`);

  const fecha = marca(ahora);
  let paquete = null;
  if (plan.nuevas.length || completo) {
    const trabajo = fs.mkdtempSync(path.join(os.tmpdir(), 'fierro-fotos-resp-'));
    try {
      const carpeta = path.join(trabajo, 'copia');
      fs.mkdirSync(carpeta);
      const errores = [];
      const cola = [...plan.nuevas];
      let hechas = 0;
      const trabajar = async () => {
        for (let f = cola.shift(); f; f = cola.shift()) {
          const r = rutasDe(f);
          for (const [ruta, mini, sha] of [[r.archivo, false, f.sha256], [r.miniatura, true, f.miniatura_sha256]]) {
            try {
              const b = await c.bajar(f.id, mini);
              if (sha256(b) !== sha) throw new Error('el sha256 no coincide con D1');
              const dest = path.join(carpeta, ruta);
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              fs.writeFileSync(dest, b);
            } catch (e) {
              errores.push(`${f.id}${mini ? '_m' : ''}: ${String(e.message ?? e).slice(0, 120)}`);
            }
          }
          if (++hechas % 100 === 0) log(`  ${hechas}/${plan.nuevas.length}`);
        }
      };
      await Promise.all(Array.from({ length: 4 }, trabajar));
      if (errores.length) throw new Error(`No se pudieron bajar ${errores.length} archivos (no se generó el respaldo): ${errores.slice(0, 3).join(' | ')}`);

      const manifiesto = {
        generado: ahora.toISOString(),
        origen: 'respaldo-programado',
        tipo: completo ? 'completo' : 'incremental',
        nota: 'sha256 tomados de D1 y comprobados contra lo descargado de R2. Contiene referencias a D1 (taller, vehículo, OT, etapa) de cada foto.',
        fotos: plan.nuevas.map((f) => ({ ...f, ...rutasDe(f) })),
      };
      fs.writeFileSync(path.join(carpeta, 'manifiesto.json'), JSON.stringify(manifiesto, null, 1));
      const entradas = [{ p: 'manifiesto.json', archivo: path.join(carpeta, 'manifiesto.json') }];
      for (const f of manifiesto.fotos) entradas.push({ p: f.archivo, archivo: path.join(carpeta, f.archivo) }, { p: f.miniatura, archivo: path.join(carpeta, f.miniatura) });
      const crudo = path.join(trabajo, 'fotos.pack');
      empaquetar(entradas, crudo);

      const nombre = `fierro-fotos-${fecha}-${completo ? 'completo' : 'incremental'}.fbk`;
      const cifrado = path.join(o.salida, nombre);
      const cif = await cifrarArchivo(crudo, cifrado, o.clavePublicaPem);

      // Comprobación de punta a punta: se deshace el cifrado, se desempaqueta y se verifica cada foto contra su sha256.
      const claro = path.join(trabajo, 'verificacion.pack');
      await descifrarArchivo(cifrado, claro, { claveDatos: cif.claveDatos });
      const comprobada = path.join(trabajo, 'verificada');
      desempaquetar(claro, comprobada);
      const v = verificarCarpeta(comprobada);
      if (v.total !== plan.nuevas.length || v.correctas !== plan.nuevas.length || v.faltantes.length || v.corruptas.length || v.sobrantes.length) throw new Error('La verificación del paquete cifrado falló: no se publica el respaldo');
      paquete = { nombre, bytes: cif.bytesCifrado, sha256: sha256(fs.readFileSync(cifrado)), fotos: plan.nuevas.length, tipo: completo ? 'completo' : 'incremental', generado: ahora.toISOString() };
      log(`Paquete ${nombre}: ${plan.nuevas.length} fotos · ${(cif.bytesCifrado / 1024 ** 2).toFixed(1)} MB cifrados · verificado de punta a punta.`);
    } finally {
      fs.rmSync(trabajo, { recursive: true, force: true });
    }
  }

  const cadenaPrevia = completo ? [] : (base?.cadena ?? []);
  const indice = {
    v: 1,
    generado: ahora.toISOString(),
    tipo: paquete ? paquete.tipo : 'sin_cambios',
    completo_desde: completo ? ahora.toISOString() : (base?.completo_desde ?? base?.generado ?? ahora.toISOString()),
    cadena: paquete ? [...cadenaPrevia, paquete] : cadenaPrevia,
    fotos_total: actuales.length,
    bytes_total: actuales.reduce((s, f) => s + f.bytes + f.miniatura_bytes, 0),
    copiadas: plan.nuevas.length,
    eliminadas_desde_base: plan.eliminadas.length,
    fotos: actuales.map((f) => ({ id: f.id, sha256: f.sha256, miniatura_sha256: f.miniatura_sha256 })),
  };
  fs.writeFileSync(path.join(o.salida, 'indice.json'), JSON.stringify(indice));
  return indice;
}

// ───────────── Restauración ─────────────

/**
 * Reconstruye una carpeta de exportación (la que entiende `npm run fotos -- verificar|restaurar`) desde la cadena de paquetes cifrados.
 * `paquetes` van en orden cronológico (el completo primero). `indice` es el indice.json MÁS RECIENTE: define qué fotos existían en ese momento; las que se
 * eliminaron después de un paquete viejo se descartan, así el bucket restaurado coincide con D1.
 */
export async function restaurarCadena({ paquetes, clavePrivadaPem, indice, salida, frase }) {
  if (fs.existsSync(salida) && fs.readdirSync(salida).length) throw new Error(`La carpeta ${salida} no está vacía: indicá una nueva`);
  fs.mkdirSync(salida, { recursive: true });
  const trabajo = fs.mkdtempSync(path.join(os.tmpdir(), 'fierro-fotos-rest-'));
  const porId = new Map();
  try {
    const esperados = new Map((indice.cadena ?? []).map((p) => [p.nombre, p]));
    for (const p of esperados.keys()) if (!paquetes.some((x) => path.basename(x) === p)) throw new Error(`Falta el paquete ${p} de la cadena de restauración`);
    for (const archivo of paquetes) {
      const meta = esperados.get(path.basename(archivo));
      if (meta && sha256(fs.readFileSync(archivo)) !== meta.sha256) throw new Error(`El paquete ${path.basename(archivo)} no coincide con el índice (alterado o incompleto)`);
      const claro = path.join(trabajo, `${crypto.randomUUID()}.pack`);
      await descifrarArchivo(archivo, claro, { clavePrivadaPem, frase });
      const parcial = path.join(trabajo, crypto.randomUUID());
      desempaquetar(claro, parcial);
      fs.rmSync(claro);
      const m = JSON.parse(fs.readFileSync(path.join(parcial, 'manifiesto.json'), 'utf8'));
      for (const f of m.fotos) porId.set(f.id, f);
      for (const f of m.fotos) {
        for (const ruta of [f.archivo, f.miniatura]) {
          fs.mkdirSync(path.dirname(path.join(salida, ruta)), { recursive: true });
          fs.copyFileSync(path.join(parcial, ruta), path.join(salida, ruta));
        }
      }
      fs.rmSync(parcial, { recursive: true, force: true });
    }
    const vigentes = new Set(indice.fotos.map((f) => f.id));
    const faltan = [...vigentes].filter((id) => !porId.has(id));
    if (faltan.length) throw new Error(`La cadena no contiene ${faltan.length} fotos del índice (¿falta algún paquete?)`);
    const fotos = [];
    for (const [id, f] of porId) {
      if (vigentes.has(id)) fotos.push(f);
      else for (const ruta of [f.archivo, f.miniatura]) fs.rmSync(path.join(salida, ruta), { force: true });
    }
    fs.writeFileSync(path.join(salida, 'manifiesto.json'), JSON.stringify({ generado: indice.generado, origen: 'restauracion-de-cadena', bucket: 'fierro-fotos', fotos }, null, 1));
    const v = verificarCarpeta(salida);
    if (v.faltantes.length || v.corruptas.length || v.correctas !== fotos.length) throw new Error('La carpeta restaurada no pasa la verificación (faltan o están alteradas algunas fotos)');
    return { fotos: fotos.length, descartadas: porId.size - fotos.length };
  } finally {
    fs.rmSync(trabajo, { recursive: true, force: true });
  }
}
