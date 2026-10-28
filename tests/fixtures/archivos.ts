// Archivos sintéticos con estructura válida para probar comprobantes (JPEG, PNG, WEBP y PDF). El servidor no decodifica los píxeles: valida y reescribe el contenedor.
const seg = (m: number, datos: number[]) => [0xff, m, (datos.length + 2) >> 8, (datos.length + 2) & 0xff, ...datos];
export function jpeg(relleno = 500, gps = true, ancho = 800, alto = 600): Uint8Array {
  const exif = [...Buffer.from('Exif\0\0GPSLATITUDE-34.6037')];
  return Uint8Array.from([
    0xff, 0xd8, ...seg(0xe0, [...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]), ...(gps ? seg(0xe1, exif) : []),
    ...seg(0xc0, [8, alto >> 8, alto & 0xff, ancho >> 8, ancho & 0xff, 1, 1, 0x11, 0]), ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]),
    ...Array.from({ length: relleno }, (_, i) => (i * 7) & 0x7f), 0xff, 0xd9,
  ]);
}
const TABLA = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = (b: number[]) => { let c = 0xffffffff; for (const x of b) c = TABLA[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (tipo: string, d: number[]) => { const cuerpo = [...Buffer.from(tipo), ...d]; return [...be(d.length), ...cuerpo, ...be(crc(cuerpo))]; };
export function png(conTexto = true, ancho = 300, alto = 200, corromper = false): Uint8Array {
  const ihdr = chunk('IHDR', [...be(ancho), ...be(alto), 8, 2, 0, 0, 0]);
  const texto = conTexto ? chunk('tEXt', [...Buffer.from('GPS\0LATITUDE-34.60')]) : [];
  const idat = chunk('IDAT', Array.from({ length: 200 }, (_, i) => (i * 13) & 0xff));
  const b = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr, ...texto, ...idat, ...chunk('IEND', [])];
  if (corromper) b[40] ^= 0xff;
  return Uint8Array.from(b);
}
export function webp(conExif: boolean): Uint8Array {
  const le = (n: number, k = 4) => Array.from({ length: k }, (_, i) => (n >> (8 * i)) & 0xff);
  const ch = (tipo: string, d: number[]) => [...Buffer.from(tipo), ...le(d.length), ...d, ...(d.length & 1 ? [0] : [])];
  const vp8x = ch('VP8X', [conExif ? 0x08 : 0, 0, 0, 0, ...le(799, 3), ...le(599, 3)]);
  const exif = conExif ? ch('EXIF', [...Buffer.from('Exif\0\0GPSLATITUDE')]) : [];
  const vp8 = ch('VP8 ', [0x10, 0, 0, 0x9d, 0x01, 0x2a, ...le(800, 2), ...le(600, 2), 1, 2, 3, 4]);
  const cuerpo = [...Buffer.from('WEBP'), ...vp8x, ...exif, ...vp8];
  return Uint8Array.from([...Buffer.from('RIFF'), ...le(cuerpo.length), ...cuerpo]);
}
export const pdf = (extra = '') => new TextEncoder().encode(`%PDF-1.4\n1 0 obj<< /Type /Catalog >>endobj\n${extra}\ntrailer<< /Root 1 0 R >>\n%%EOF\n`);
export const tiene = (b: Uint8Array, t: string) => Buffer.from(b).includes(Buffer.from(t));

