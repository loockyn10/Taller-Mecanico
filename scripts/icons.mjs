// Genera los íconos PNG de la PWA sin dependencias (rasterizado simple del logo: "F" + punto ámbar).
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib.mjs';

const AZUL = [0x2d, 0x5b, 0x87];
const BLANCO = [255, 255, 255];
const AMBAR = [0xf5, 0xa5, 0x24];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(tipo, datos) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(datos.length);
  const td = Buffer.concat([Buffer.from(tipo), datos]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function icono(tam, maskable) {
  const s = tam / 64; // coordenadas del SVG de 64x64
  const pad = maskable ? 0.1 : 0; // zona segura para íconos maskable
  const radio = maskable ? 0 : 14 * s;
  const filas = [];
  for (let y = 0; y < tam; y++) {
    const fila = [0];
    for (let x = 0; x < tam; x++) {
      // coordenadas lógicas (con margen para maskable)
      const lx = ((x / tam - pad) / (1 - 2 * pad)) * 64;
      const ly = ((y / tam - pad) / (1 - 2 * pad)) * 64;
      // esquinas redondeadas
      const cx = Math.min(Math.max(x, radio), tam - radio), cy = Math.min(Math.max(y, radio), tam - radio);
      const fuera = radio > 0 && Math.hypot(x - cx, y - cy) > radio;
      let color = AZUL;
      const enF = (lx >= 20 && lx < 29 && ly >= 16 && ly < 52) || (lx >= 20 && lx < 46 && ly >= 16 && ly < 24) || (lx >= 20 && lx < 43 && ly >= 31 && ly < 39);
      if (enF) color = BLANCO;
      if (Math.hypot(lx - 46, ly - 46) <= 6) color = AMBAR;
      fila.push(...color, fuera ? 0 : 255);
    }
    filas.push(Buffer.from(fila));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(tam, 0);
  ihdr.writeUInt32BE(tam, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(filas))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const pub = path.join(ROOT, 'public');
fs.writeFileSync(path.join(pub, 'icon-192.png'), icono(192, false));
fs.writeFileSync(path.join(pub, 'icon-512.png'), icono(512, false));
fs.writeFileSync(path.join(pub, 'icon-maskable-512.png'), icono(512, true));
console.log('Íconos generados en public/');
