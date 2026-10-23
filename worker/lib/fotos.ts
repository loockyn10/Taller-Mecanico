// Fotografías: validación del contenido real del archivo, limpieza de metadatos (EXIF/GPS), cupo por taller y claves de R2.
// El navegador ya recomprime y quita los metadatos, pero acá no se confía en eso: se revisa y se limpia lo que llega.
import { all, first } from './db';
import { ApiError } from './http';

export const LIMITE_FOTOS_DEFECTO = 2 * 1024 ** 3; // 2 GB por taller (provisorio, ajustable por la plataforma)
export const MAX_FOTO_BYTES = 3_500_000; // objetivo del navegador: 300–800 KB; esto es el tope duro
export const MAX_MINIATURA_BYTES = 200_000;
export const MAX_LADO_FOTO = 4096;
export const MAX_LADO_MINIATURA = 640;
export const ETAPAS = ['recepcion', 'reparacion', 'entrega'] as const;
export type EtapaFoto = (typeof ETAPAS)[number];

export const claveFoto = (tallerId: string, fotoId: string) => `fotos/${tallerId}/${fotoId}`;
export const claveMiniatura = (tallerId: string, fotoId: string) => `fotos/${tallerId}/${fotoId}_m`;

export interface ImagenValida {
  bytes: Uint8Array;
  mime: 'image/jpeg' | 'image/webp';
  ancho: number;
  alto: number;
}

const invalida = (m: string) => new ApiError(400, 'imagen_invalida', m);

/** JPEG: valida la estructura, toma el tamaño y descarta APP1 (EXIF/XMP), APP2…APP13 y comentarios. Conserva JFIF y Adobe. */
function jpeg(b: Uint8Array): ImagenValida {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw invalida('El archivo no es una imagen JPEG válida');
  const partes: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  let ancho = 0;
  let alto = 0;
  let sos = false;
  while (i < b.length) {
    if (b[i] !== 0xff) throw invalida('JPEG dañado');
    while (b[i] === 0xff) i++; // relleno
    const m = b[i++];
    if (m === 0xd9) break;
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) continue;
    if (i + 2 > b.length) throw invalida('JPEG incompleto');
    const len = (b[i] << 8) | b[i + 1];
    if (len < 2 || i + len > b.length) throw invalida('JPEG incompleto');
    const seg = b.subarray(i - 2, i + len);
    const esSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (esSof) {
      alto = (b[i + 3] << 8) | b[i + 4];
      ancho = (b[i + 5] << 8) | b[i + 6];
    }
    const descartar = (m >= 0xe1 && m <= 0xed) || m === 0xef || m === 0xfe; // conserva APP0 (JFIF) y APP14 (Adobe)
    if (!descartar) partes.push(seg);
    i += len;
    if (m === 0xda) {
      // Datos comprimidos: se copian tal cual hasta el final (incluye EOI).
      partes.push(b.subarray(i));
      sos = true;
      break;
    }
  }
  if (!sos || !ancho || !alto) throw invalida('JPEG sin datos de imagen');
  if (b[b.length - 1] !== 0xd9 || b[b.length - 2] !== 0xff) throw invalida('JPEG cortado: reintentá la subida');
  return { bytes: juntar(partes), mime: 'image/jpeg', ancho, alto };
}

const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const fourcc = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** WebP: valida el contenedor RIFF, toma el tamaño y descarta los bloques EXIF, XMP e ICC. */
function webp(b: Uint8Array): ImagenValida {
  if (b.length < 20 || fourcc(b, 0) !== 'RIFF' || fourcc(b, 8) !== 'WEBP') throw invalida('El archivo no es una imagen WebP válida');
  if (u32(b, 4) + 8 !== b.length) throw invalida('WebP cortado: reintentá la subida');
  const chunks: Uint8Array[] = [];
  let ancho = 0;
  let alto = 0;
  let o = 12;
  while (o + 8 <= b.length) {
    const tipo = fourcc(b, o);
    const len = u32(b, o + 4);
    const total = 8 + len + (len & 1);
    if (o + 8 + len > b.length) throw invalida('WebP dañado');
    const d = b.subarray(o + 8, o + 8 + len);
    if (tipo === 'VP8X' && len >= 10) {
      ancho = 1 + (d[4] | (d[5] << 8) | (d[6] << 16));
      alto = 1 + (d[7] | (d[8] << 8) | (d[9] << 16));
    } else if (tipo === 'VP8 ' && len >= 10 && !ancho) {
      ancho = (d[6] | (d[7] << 8)) & 0x3fff;
      alto = (d[8] | (d[9] << 8)) & 0x3fff;
    } else if (tipo === 'VP8L' && len >= 5 && !ancho) {
      const v = d[1] | (d[2] << 8) | (d[3] << 16) | (d[4] << 24);
      ancho = 1 + (v & 0x3fff);
      alto = 1 + ((v >>> 14) & 0x3fff);
    }
    if (tipo !== 'EXIF' && tipo !== 'XMP ' && tipo !== 'ICCP') {
      const c = b.slice(o, Math.min(o + total, b.length));
      if (tipo === 'VP8X') c[8] &= ~(0x04 | 0x08 | 0x20); // sin XMP, EXIF ni ICC
      chunks.push(c);
    }
    o += total;
  }
  if (!ancho || !alto) throw invalida('WebP sin datos de imagen');
  const cuerpo = juntar(chunks);
  const salida = new Uint8Array(12 + cuerpo.length);
  salida.set(b.subarray(0, 12));
  salida.set(cuerpo, 12);
  const n = salida.length - 8;
  salida[4] = n & 0xff;
  salida[5] = (n >>> 8) & 0xff;
  salida[6] = (n >>> 16) & 0xff;
  salida[7] = (n >>> 24) & 0xff;
  return { bytes: salida, mime: 'image/webp', ancho, alto };
}

function juntar(partes: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(partes.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of partes) (out.set(p, o), (o += p.length));
  return out;
}

/** Reconoce el formato por su contenido (no por el nombre ni el tipo que declare el cliente) y devuelve la imagen sin metadatos. */
export function validarImagen(entrada: Uint8Array, maxBytes: number, maxLado: number, que: string): ImagenValida {
  if (entrada.length === 0) throw invalida(`${que}: archivo vacío`);
  if (entrada.length > maxBytes) throw new ApiError(413, 'imagen_grande', `${que}: pesa ${(entrada.length / 1e6).toFixed(1)} MB y el máximo es ${(maxBytes / 1e6).toFixed(1)} MB`);
  const r = entrada[0] === 0xff ? jpeg(entrada) : entrada[0] === 0x52 ? webp(entrada) : null;
  if (!r) throw invalida(`${que}: sólo se aceptan imágenes JPEG o WebP`);
  if (Math.max(r.ancho, r.alto) > maxLado) throw invalida(`${que}: la imagen es demasiado grande (${r.ancho}×${r.alto}; máximo ${maxLado} px de lado)`);
  return r;
}

export async function sha256(b: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', b));
  return [...h].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export interface UsoFotos {
  usado_bytes: number;
  cantidad: number;
  limite_bytes: number;
}

/** Consumo del taller: las fotos listas y las que están reservando cupo mientras se guardan. */
export async function usoFotos(db: D1Database, tallerId: string): Promise<UsoFotos> {
  const u = await first<{ usado: number; cantidad: number }>(
    db,
    `SELECT COALESCE(SUM(bytes + miniatura_bytes), 0) AS usado, COALESCE(SUM(CASE WHEN estado = 'lista' THEN 1 ELSE 0 END), 0) AS cantidad
       FROM fotos WHERE taller_id = ? AND estado IN ('pendiente', 'lista')`,
    tallerId,
  );
  const l = await first<{ fotos_limite_bytes: number }>(db, 'SELECT fotos_limite_bytes FROM taller_almacenamiento WHERE taller_id = ?', tallerId);
  return { usado_bytes: u?.usado ?? 0, cantidad: u?.cantidad ?? 0, limite_bytes: l?.fotos_limite_bytes ?? LIMITE_FOTOS_DEFECTO };
}

/**
 * Termina lo que quedó a medias: fotos "eliminada" (borrado en R2 incompleto) y "pendiente" de hace más de una hora (corte entre D1 y R2).
 * Primero borra los objetos de R2 (idempotente) y recién después la fila: así nunca queda un objeto sin fila que lo explique.
 */
export async function limpiarFotos(db: D1Database, bucket: R2Bucket | undefined): Promise<{ limpiadas: number }> {
  if (!bucket) return { limpiadas: 0 };
  const filas = await all<{ id: string; taller_id: string }>(
    db,
    `SELECT id, taller_id FROM fotos WHERE estado = 'eliminada' OR (estado = 'pendiente' AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')) LIMIT 50`,
  );
  let limpiadas = 0;
  for (const f of filas) {
    try {
      await bucket.delete([claveFoto(f.taller_id, f.id), claveMiniatura(f.taller_id, f.id)]);
      await db.prepare("DELETE FROM fotos WHERE taller_id = ? AND id = ? AND estado IN ('eliminada', 'pendiente')").bind(f.taller_id, f.id).run();
      limpiadas++;
    } catch {
      /* se reintenta en la próxima pasada */
    }
  }
  return { limpiadas };
}
