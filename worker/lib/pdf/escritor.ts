// Escritor mínimo de PDF 1.4: páginas A4, texto en Helvetica (WinAnsi), líneas, rectángulos e imágenes JPEG.
// Sin dependencias ni servicios externos: corre en el Worker. Los flujos de contenido se dejan sin comprimir a propósito (documentos de una o dos páginas:
// unos pocos KB) para que el resultado se pueda auditar y probar leyendo su texto.
import { byteWinAnsi, limpiarTexto, type Fuente } from './metricas';

export const MM = 72 / 25.4;
export const A4 = { ancho: 210, alto: 297 } as const;

const enc = new TextEncoder();
const num = (n: number) => (Math.round(n * 100) / 100).toString();

/** Cadena PDF literal en WinAnsi: los bytes no ASCII se escriben como escape octal, así el archivo queda en ASCII puro. */
export function cadenaPdf(t: string): string {
  let s = '(';
  for (const ch of limpiarTexto(t)) {
    const b = byteWinAnsi(ch);
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += `\\${String.fromCharCode(b)}`;
    else if (b < 32 || b > 126) s += `\\${b.toString(8).padStart(3, '0')}`;
    else s += String.fromCharCode(b);
  }
  return `${s})`;
}

export interface ImagenJpeg {
  id: string;
  ancho: number;
  alto: number;
}

/** Lee ancho, alto y componentes de un JPEG (marcadores SOFn). Devuelve null si no es un JPEG que se pueda incrustar tal cual. */
export function leerJpeg(b: Uint8Array): { ancho: number; alto: number; componentes: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const m = b[i + 1];
    if (m === 0xff) {
      i++;
      continue;
    }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      i += 2;
      continue;
    }
    const largo = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const precision = b[i + 4];
      const alto = (b[i + 5] << 8) | b[i + 6];
      const ancho = (b[i + 7] << 8) | b[i + 8];
      const componentes = b[i + 9];
      if (precision !== 8 || !ancho || !alto || ![1, 3].includes(componentes)) return null;
      return { ancho, alto, componentes };
    }
    i += 2 + largo;
  }
  return null;
}

export interface EstiloTexto {
  fuente?: Fuente;
  tam?: number;
  /** 0 = negro, 1 = blanco. */
  gris?: number;
}
export interface EstiloTrazo {
  ancho?: number;
  gris?: number;
  /** Trazos discontinuos [raya, hueco] en mm. */
  guiones?: [number, number];
}

/** Una página. Las coordenadas son en milímetros desde la esquina superior izquierda (y hacia abajo). */
export class Pagina {
  readonly ops: string[] = [];
  readonly imagenes = new Set<string>();
  constructor(readonly ancho: number = A4.ancho, readonly alto: number = A4.alto) {}

  private y(mm: number) {
    return num((this.alto - mm) * MM);
  }
  private x(mm: number) {
    return num(mm * MM);
  }
  /** `y` es la línea base del texto. */
  texto(x: number, y: number, t: string, e: EstiloTexto = {}) {
    if (!t) return;
    const { fuente = 'normal', tam = 10, gris = 0 } = e;
    this.ops.push(`BT /${fuente === 'negrita' ? 'F2' : 'F1'} ${num(tam)} Tf ${num(gris)} g ${this.x(x)} ${this.y(y)} Td ${cadenaPdf(t)} Tj ET`);
  }
  linea(x1: number, y1: number, x2: number, y2: number, e: EstiloTrazo = {}) {
    const { ancho = 0.3, gris = 0, guiones } = e;
    this.ops.push(`q ${num(ancho * MM)} w ${num(gris)} G ${guiones ? `[${num(guiones[0] * MM)} ${num(guiones[1] * MM)}] 0 d ` : ''}${this.x(x1)} ${this.y(y1)} m ${this.x(x2)} ${this.y(y2)} l S Q`);
  }
  rect(x: number, y: number, w: number, h: number, e: EstiloTrazo & { relleno?: number } = {}) {
    const { ancho = 0.3, gris = 0, relleno } = e;
    const r = `${this.x(x)} ${this.y(y + h)} ${num(w * MM)} ${num(h * MM)} re`;
    if (relleno !== undefined) this.ops.push(`q ${num(relleno)} g ${r} f Q`);
    if (ancho > 0) this.ops.push(`q ${num(ancho * MM)} w ${num(gris)} G ${r} S Q`);
  }
  imagen(img: ImagenJpeg, x: number, y: number, w: number, h: number) {
    this.imagenes.add(img.id);
    this.ops.push(`q ${num(w * MM)} 0 0 ${num(h * MM)} ${this.x(x)} ${this.y(y + h)} cm /${img.id} Do Q`);
  }
}

export interface Metadatos {
  titulo: string;
  asunto?: string;
  fecha?: Date;
}

export class Documento {
  private paginas: Pagina[] = [];
  private jpegs: Array<{ id: string; bytes: Uint8Array; ancho: number; alto: number; componentes: number }> = [];

  constructor(private meta: Metadatos) {}

  /** Registra un JPEG para usarlo en varias páginas. Devuelve null si el archivo no es un JPEG incrustable. */
  agregarJpeg(bytes: Uint8Array): ImagenJpeg | null {
    const j = leerJpeg(bytes);
    if (!j) return null;
    const id = `Im${this.jpegs.length + 1}`;
    this.jpegs.push({ id, bytes, ...j });
    return { id, ancho: j.ancho, alto: j.alto };
  }

  nuevaPagina(): Pagina {
    const p = new Pagina();
    this.paginas.push(p);
    return p;
  }
  get cantidadPaginas() {
    return this.paginas.length;
  }

  generar(): Uint8Array {
    const partes: Uint8Array[] = [];
    const offsets: number[] = [];
    let largo = 0;
    const poner = (d: Uint8Array | string) => {
      const b = typeof d === 'string' ? enc.encode(d) : d;
      partes.push(b);
      largo += b.length;
    };
    const objeto = (n: number, cuerpo: string | Uint8Array[]) => {
      offsets[n] = largo;
      poner(`${n} 0 obj\n`);
      if (typeof cuerpo === 'string') poner(cuerpo);
      else cuerpo.forEach(poner);
      poner('\nendobj\n');
    };

    // Numeración: 1 catálogo, 2 páginas, 3-4 fuentes, 5 información, luego imágenes, luego (página, contenido) por página.
    const nImg = (i: number) => 6 + i;
    const base = 6 + this.jpegs.length;
    const nPag = (i: number) => base + i * 2;
    const nCont = (i: number) => base + i * 2 + 1;
    const total = base + this.paginas.length * 2;

    // La segunda línea (bytes altos) marca el archivo como binario para los programas que lo tratan como texto.
    poner(new Uint8Array([...enc.encode('%PDF-1.4\n%'), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
    objeto(1, '<< /Type /Catalog /Pages 2 0 R /ViewerPreferences << /DisplayDocTitle true /PrintScaling /None >> >>');
    objeto(2, `<< /Type /Pages /Count ${this.paginas.length} /Kids [${this.paginas.map((_, i) => `${nPag(i)} 0 R`).join(' ')}] >>`);
    objeto(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    objeto(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const f = this.meta.fecha ?? new Date();
    const dd = (n: number) => String(n).padStart(2, '0');
    const pdfFecha = `D:${f.getUTCFullYear()}${dd(f.getUTCMonth() + 1)}${dd(f.getUTCDate())}${dd(f.getUTCHours())}${dd(f.getUTCMinutes())}${dd(f.getUTCSeconds())}Z`;
    // Metadatos: sólo título, asunto y herramienta. Sin autor ni datos de la persona que lo generó.
    objeto(5, `<< /Title ${cadenaPdf(this.meta.titulo)} ${this.meta.asunto ? `/Subject ${cadenaPdf(this.meta.asunto)} ` : ''}/Creator (Fierro) /Producer (Fierro) /CreationDate (${pdfFecha}) >>`);
    this.jpegs.forEach((j, i) => {
      objeto(nImg(i), [
        enc.encode(`<< /Type /XObject /Subtype /Image /Width ${j.ancho} /Height ${j.alto} /ColorSpace /${j.componentes === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${j.bytes.length} >>\nstream\n`),
        j.bytes,
        enc.encode('\nendstream'),
      ]);
    });
    this.paginas.forEach((p, i) => {
      const imgs = this.jpegs.map((j, k) => ({ j, k })).filter(({ j }) => p.imagenes.has(j.id));
      const xobj = imgs.length ? ` /XObject << ${imgs.map(({ j, k }) => `/${j.id} ${nImg(k)} 0 R`).join(' ')} >>` : '';
      objeto(nPag(i), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(p.ancho * MM)} ${num(p.alto * MM)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobj} >> /Contents ${nCont(i)} 0 R >>`);
      const contenido = enc.encode(p.ops.join('\n'));
      objeto(nCont(i), [enc.encode(`<< /Length ${contenido.length} >>\nstream\n`), contenido, enc.encode('\nendstream')]);
    });

    const xref = largo;
    poner(`xref\n0 ${total}\n0000000000 65535 f \n`);
    for (let n = 1; n < total; n++) poner(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
    poner(`trailer\n<< /Size ${total} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

    const salida = new Uint8Array(largo);
    let o = 0;
    for (const p of partes) {
      salida.set(p, o);
      o += p.length;
    }
    return salida;
  }
}
