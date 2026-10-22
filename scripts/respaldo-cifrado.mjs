// Cifrado de los respaldos que salen de la cuenta de Cloudflare (por ejemplo, como artefacto de GitHub Actions).
//
// Esquema híbrido, sólo con módulos de Node (sin instalar nada):
//   * una clave de datos AES-256 aleatoria por respaldo cifra el archivo con AES-256-GCM (autenticado: cualquier alteración se detecta al descifrar);
//   * esa clave de datos se cifra con la CLAVE PÚBLICA RSA-4096 (OAEP, SHA-256) y viaja en la cabecera.
// La clave PÚBLICA puede estar en GitHub (variable del repositorio, no es secreta). La clave PRIVADA es la única que descifra: se genera una vez en un equipo
// propio, se guarda fuera de GitHub y de Cloudflare (por ejemplo, impresa y en un gestor de contraseñas) y NUNCA se sube. Si se pierde, los respaldos cifrados
// no se pueden recuperar: por eso la documentación pide dos copias de la privada y una prueba de restauración periódica.
//
// Formato del archivo (.fbk):  "FIERRO-BAK1\n" + cabecera JSON en una línea + "\n" + texto cifrado + etiqueta GCM (16 bytes).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

const MAGIA = 'FIERRO-BAK1\n';
const TAG = 16;

/** Genera el par de claves en una carpeta nueva (no pisa nada). Devuelve las rutas. */
export function generarClaves(carpeta) {
  const publica = path.join(carpeta, 'fierro-respaldo-publica.pem');
  const privada = path.join(carpeta, 'fierro-respaldo-PRIVADA.pem');
  if (fs.existsSync(publica) || fs.existsSync(privada)) throw new Error(`Ya hay claves en ${carpeta}: no se pisan`);
  fs.mkdirSync(carpeta, { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 4096, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  fs.writeFileSync(publica, publicKey);
  fs.writeFileSync(privada, privateKey, { mode: 0o600 });
  return { publica, privada, huella: huellaClavePublica(publicKey) };
}

/** Huella corta de la clave pública (para comprobar que la variable de GitHub es la correcta sin mostrar nada sensible). */
export function huellaClavePublica(pem) {
  return crypto.createHash('sha256').update(crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

/**
 * Comprime (gzip) y cifra `entrada` en `salida`. Devuelve los tamaños y la huella SHA-256 del archivo ORIGINAL (para el manifiesto).
 * Comprimir antes de cifrar: un archivo cifrado ya no se puede comprimir y los artefactos tienen cupo.
 */
export async function cifrarArchivo(entrada, salida, clavePublicaPem) {
  const publica = crypto.createPublicKey(clavePublicaPem);
  if (publica.asymmetricKeyType !== 'rsa' || (publica.asymmetricKeyDetails?.modulusLength ?? 0) < 3072) throw new Error('La clave pública debe ser RSA de 3072 bits o más');
  const claveDatos = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const envuelta = crypto.publicEncrypt({ key: publica, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, claveDatos);
  const cabecera = JSON.stringify({ v: 1, alg: 'AES-256-GCM+gzip', kw: 'RSA-OAEP-SHA256', clave: envuelta.toString('base64'), iv: iv.toString('base64'), pub: huellaClavePublica(clavePublicaPem) });
  const cifrador = crypto.createCipheriv('aes-256-gcm', claveDatos, iv);
  cifrador.setAAD(Buffer.from(cabecera));
  const hash = crypto.createHash('sha256');
  let bytesOriginal = 0;
  const lector = fs.createReadStream(entrada);
  lector.on('data', (d) => {
    hash.update(d);
    bytesOriginal += d.length;
  });
  const out = fs.createWriteStream(salida, { flags: 'wx', mode: 0o600 });
  out.write(`${MAGIA}${cabecera}\n`);
  await pipeline(lector, zlib.createGzip({ level: 9 }), cifrador, out, { end: false });
  out.write(cifrador.getAuthTag());
  await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  return { sha256Original: hash.digest('hex'), bytesOriginal, bytesCifrado: fs.statSync(salida).size, claveDatos };
}

function leerCabecera(archivo) {
  const fd = fs.openSync(archivo, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const texto = buf.subarray(0, n).toString('latin1');
    if (!texto.startsWith(MAGIA)) throw new Error('No es un respaldo cifrado de Fierro (cabecera inválida)');
    const fin = texto.indexOf('\n', MAGIA.length);
    if (fin < 0) throw new Error('Cabecera incompleta');
    return { cabeceraTexto: texto.slice(MAGIA.length, fin), inicioDatos: fin + 1 };
  } finally {
    fs.closeSync(fd);
  }
}

/** Descifra y descomprime con la clave privada (o con la clave de datos si se la tiene, para verificar el recorrido completo). Verifica la etiqueta GCM. */
export async function descifrarArchivo(entrada, salida, { clavePrivadaPem, claveDatos, frase } = {}) {
  const { cabeceraTexto, inicioDatos } = leerCabecera(entrada);
  const cab = JSON.parse(cabeceraTexto);
  if (cab.v !== 1) throw new Error(`Versión de respaldo no soportada: ${cab.v}`);
  let clave = claveDatos;
  if (!clave) {
    if (!clavePrivadaPem) throw new Error('Falta la clave privada');
    clave = crypto.privateDecrypt({ key: crypto.createPrivateKey({ key: clavePrivadaPem, passphrase: frase }), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(cab.clave, 'base64'));
  }
  const total = fs.statSync(entrada).size;
  if (total < inicioDatos + TAG) throw new Error('Archivo truncado');
  const tag = Buffer.alloc(TAG);
  const fd = fs.openSync(entrada, 'r');
  try {
    fs.readSync(fd, tag, 0, TAG, total - TAG);
  } finally {
    fs.closeSync(fd);
  }
  const descifrador = crypto.createDecipheriv('aes-256-gcm', clave, Buffer.from(cab.iv, 'base64'));
  descifrador.setAAD(Buffer.from(cabeceraTexto));
  descifrador.setAuthTag(tag);
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(salida, { flags: 'wx', mode: 0o600 });
  const lector = fs.createReadStream(entrada, { start: inicioDatos, end: total - TAG - 1 });
  const gunzip = zlib.createGunzip();
  gunzip.on('data', (d) => hash.update(d));
  try {
    await pipeline(lector, descifrador, gunzip, out);
  } catch (e) {
    fs.rmSync(salida, { force: true });
    throw new Error(`No se pudo descifrar (clave incorrecta o archivo alterado): ${e.message}`);
  }
  return { sha256: hash.digest('hex'), bytes: fs.statSync(salida).size };
}
