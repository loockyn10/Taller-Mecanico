// Comprobantes de transferencia enviados por el cliente desde el portal: validación del contenido REAL del archivo, limpieza de metadatos y claves de R2.
//
// El cliente es un visitante anónimo con un enlace: nada de lo que manda se toma por bueno. El formato se reconoce por los bytes (no por el nombre ni por el tipo que
// declare el navegador), las imágenes se reescriben sin metadatos (EXIF/GPS) y los PDF con contenido activo se rechazan. Las imágenes JPEG/WebP reutilizan el validador de las
// fotografías (`lib/fotos.ts`); PNG y PDF se validan acá.
import { ApiError } from './http';
import { validarImagen } from './fotos';
import { LIMITES_COMPROBANTE, EXTENSIONES_COMPROBANTE, extensionDe, type FormatoComprobante } from '../../shared/pago-portal';

/** Clave del objeto en el bucket privado: se arma SIEMPRE con el taller de la orden y el id interno del comprobante, jamás con datos que mande el cliente. */
export const claveComprobante = (tallerId: string, comprobanteId: string) => `comprobantes/${tallerId}/${comprobanteId}`;

export interface ComprobanteValido {
  bytes: Uint8Array;
  mime: FormatoComprobante;
}

const invalido = (m: string) => new ApiError(400, 'comprobante_invalido', m);
const grande = (m: string) => new ApiError(413, 'comprobante_grande', m);

// ───────────── PNG ─────────────
const FIRMA_PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
let TABLA_CRC: Uint32Array | null = null;
function crc32(b: Uint8Array): number {
  if (!TABLA_CRC) {
    TABLA_CRC = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLA_CRC[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = TABLA_CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const be32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const tipoChunk = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
// Texto, metadatos EXIF y fecha de modificación: se descartan al reescribir.
const CHUNKS_DESCARTADOS = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

function png(b: Uint8Array): ComprobanteValido {
  if (b.length < 45 || FIRMA_PNG.some((v, i) => b[i] !== v)) throw invalido('El archivo no es una imagen PNG válida');
  const partes: Uint8Array[] = [b.subarray(0, 8)];
  let o = 8;
  let ancho = 0;
  let alto = 0;
  let hayDatos = false;
  let fin = false;
  let primero = true;
  while (o + 12 <= b.length) {
    const len = be32(b, o);
    const tipo = tipoChunk(b, o + 4);
    const total = 12 + len;
    if (len > 0x7fffffff || o + total > b.length) throw invalido('PNG dañado o cortado: reintentá la subida');
    if (primero && tipo !== 'IHDR') throw invalido('El archivo no es una imagen PNG válida');
    if (crc32(b.subarray(o + 4, o + 8 + len)) !== be32(b, o + 8 + len)) throw invalido('PNG dañado');
    if (tipo === 'IHDR') {
      if (len !== 13) throw invalido('PNG dañado');
      ancho = be32(b, o + 8);
      alto = be32(b, o + 12);
    }
    if (tipo === 'IDAT') hayDatos = true;
    if (!CHUNKS_DESCARTADOS.has(tipo)) partes.push(b.subarray(o, o + total));
    primero = false;
    o += total;
    if (tipo === 'IEND') {
      fin = true;
      break;
    }
  }
  if (!fin || !hayDatos || !ancho || !alto) throw invalido('PNG incompleto: reintentá la subida');
  if (Math.max(ancho, alto) > LIMITES_COMPROBANTE.ladoMax) throw invalido(`La imagen es demasiado grande (${ancho}×${alto}; máximo ${LIMITES_COMPROBANTE.ladoMax} px de lado)`);
  const salida = new Uint8Array(partes.reduce((s, p) => s + p.length, 0));
  let k = 0;
  for (const p of partes) (salida.set(p, k), (k += p.length));
  return { bytes: salida, mime: 'image/png' };
}

// ───────────── PDF ─────────────
const BUSCAR = (b: Uint8Array, t: string, desde = 0, hasta = b.length) => {
  const n = t.length;
  outer: for (let i = desde; i <= hasta - n; i++) {
    for (let k = 0; k < n; k++) if (b[i + k] !== t.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
};
// Contenido activo o incrustado: un comprobante bancario no lo necesita. Sólo nombres largos: uno corto (`/JS`, `/XFA`) aparece por azar dentro de los datos comprimidos
// y rechazaría PDF legítimos (una acción de script siempre lleva además `/JavaScript`). Limitación: un script dentro de un flujo de objetos comprimido o con el
// nombre escrito con códigos `#xx` no se detecta; por eso el archivo sólo se sirve con sesión, con `nosniff` y para abrirlo en el visor del navegador.
const PDF_ACTIVO = ['/JavaScript', '/Launch', '/EmbeddedFile', '/RichMedia', '/SubmitForm', '/ImportData'] as const;

function pdf(b: Uint8Array): ComprobanteValido {
  if (b.length < 20 || BUSCAR(b, '%PDF-', 0, 8) !== 0) throw invalido('El archivo no es un PDF válido');
  if (BUSCAR(b, '%%EOF', Math.max(0, b.length - 2048)) === -1) throw invalido('PDF cortado: reintentá la subida');
  for (const t of PDF_ACTIVO) {
    // Sólo cuenta si lo que sigue no es una letra o un dígito (`/Launch` ≠ `/LaunchPad`): así termina un nombre PDF.
    let desde = 0;
    for (;;) {
      const i = BUSCAR(b, t, desde);
      if (i === -1) break;
      const sig = b[i + t.length];
      const sigueNombre = sig !== undefined && ((sig >= 0x30 && sig <= 0x39) || (sig >= 0x41 && sig <= 0x5a) || (sig >= 0x61 && sig <= 0x7a));
      if (!sigueNombre) throw invalido('El PDF contiene elementos no permitidos (scripts o archivos incrustados). Enviá una captura o el comprobante original del banco');
      desde = i + t.length;
    }
  }
  return { bytes: b, mime: 'application/pdf' };
}

/**
 * Reconoce el formato por el contenido y devuelve el archivo listo para guardar (imágenes sin metadatos). Valida peso, estructura y, si el nombre trae
 * extensión, que sea una de las permitidas (la del nombre nunca decide el formato: decide el contenido).
 */
export function validarComprobante(entrada: Uint8Array, nombre: string | null): ComprobanteValido {
  if (entrada.length === 0) throw invalido('El archivo está vacío');
  const ext = extensionDe(nombre);
  if (ext && !(EXTENSIONES_COMPROBANTE as readonly string[]).includes(ext)) throw invalido('Formato no permitido: enviá una imagen (JPG, PNG o WEBP) o un PDF');
  const esPdf = entrada[0] === 0x25;
  const maxBytes = esPdf ? LIMITES_COMPROBANTE.pdfBytes : LIMITES_COMPROBANTE.imagenBytes;
  if (entrada.length > maxBytes) throw grande(`El archivo pesa ${(entrada.length / 1e6).toFixed(1)} MB y el máximo es ${(maxBytes / 1e6).toFixed(0)} MB`);
  if (esPdf) return pdf(entrada);
  if (entrada[0] === 0x89) return png(entrada);
  if (entrada[0] === 0xff || entrada[0] === 0x52) {
    const img = validarImagen(entrada, maxBytes, LIMITES_COMPROBANTE.ladoMax, 'El comprobante');
    return { bytes: img.bytes, mime: img.mime };
  }
  throw invalido('Formato no permitido: enviá una imagen (JPG, PNG o WEBP) o un PDF');
}
