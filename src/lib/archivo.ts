// Lectura de archivos de importación (CSV y Excel .xlsx) en el navegador, sin dependencias externas.
// El archivo NUNCA se sube entero: se lee acá, la persona revisa y mapea las columnas, y solo las filas elegidas viajan al servidor por lotes.
//
// .xlsx es un ZIP con XML. Se lee con el DecompressionStream del navegador. Se limitan el tamaño del archivo y el de lo descomprimido
// (protección contra archivos "bomba") y se ignoran fórmulas, macros y vínculos: solo se toman los valores de las celdas.

export type CeldaArchivo = string | number;
export interface HojaArchivo {
  nombre: string;
  filas: CeldaArchivo[][];
}
export interface ArchivoLeido {
  nombre: string;
  bytes: number;
  /** SHA-256 del contenido: permite reconocer el mismo archivo si se vuelve a importar. */
  hash: string;
  formato: 'csv' | 'xlsx';
  hojas: HojaArchivo[];
}

export const MAX_BYTES = 5 * 1024 * 1024;
const MAX_DESCOMPRIMIDO = 60 * 1024 * 1024;
const MAX_COLUMNAS = 120;
const MAX_FILAS_LEIDAS = 20_000;

export class ErrorArchivo extends Error {}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ───────────────────────── CSV ─────────────────────────

/** UTF-8 si es válido; si no, Windows-1252 (la codificación habitual de los CSV exportados por Excel en español). */
export function decodificarTexto(bytes: Uint8Array): string {
  let t: string;
  try {
    t = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    t = new TextDecoder('windows-1252').decode(bytes);
  }
  return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
}

/** Separador más probable según las primeras líneas (fuera de comillas). */
export function detectarDelimitador(texto: string): string {
  const candidatos = [';', ',', '\t', '|'];
  const cuentas = candidatos.map(() => 0);
  let enComillas = false;
  let lineas = 0;
  for (let i = 0; i < texto.length && lineas < 6; i++) {
    const ch = texto[i];
    if (ch === '"') enComillas = !enComillas;
    else if (!enComillas) {
      if (ch === '\n') lineas++;
      else {
        const k = candidatos.indexOf(ch);
        if (k >= 0) cuentas[k]++;
      }
    }
  }
  const max = Math.max(...cuentas);
  return max === 0 ? ';' : candidatos[cuentas.indexOf(max)];
}

export function parsearCSV(texto: string, delimitador = detectarDelimitador(texto)): string[][] {
  const filas: string[][] = [];
  let fila: string[] = [];
  let celda = '';
  let enComillas = false;
  const cerrarFila = () => {
    fila.push(celda);
    celda = '';
    // Las filas vacías se conservan (como []) para que el número de fila coincida con el del archivo.
    filas.push(fila.some((c) => c.trim() !== '') ? fila : []);
    fila = [];
  };
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (enComillas) {
      if (ch === '"') {
        if (texto[i + 1] === '"') (celda += '"'), i++;
        else enComillas = false;
      } else celda += ch;
    } else if (ch === '"' && celda === '') enComillas = true;
    else if (ch === delimitador) (fila.push(celda), (celda = ''));
    else if (ch === '\n') cerrarFila();
    else if (ch === '\r') {
      if (texto[i + 1] === '\n') i++;
      cerrarFila();
    } else celda += ch;
    if (filas.length > MAX_FILAS_LEIDAS) throw new ErrorArchivo(`El archivo tiene más de ${MAX_FILAS_LEIDAS} filas: dividilo en partes más chicas`);
  }
  if (celda !== '' || fila.length) cerrarFila();
  return filas.map((f) => f.map((c) => c.trim()));
}

// ───────────────────────── XLSX ─────────────────────────

interface EntradaZip {
  metodo: number;
  comprimido: number;
  tamano: number;
  desplazamiento: number;
}

function leerZip(b: Uint8Array): Map<string, EntradaZip> {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ErrorArchivo('El archivo no es un Excel (.xlsx) válido');
  const cantidad = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  if (cantidad === 0xffff || p === 0xffffffff) throw new ErrorArchivo('El archivo Excel es demasiado grande o no está soportado');
  const mapa = new Map<string, EntradaZip>();
  for (let i = 0; i < cantidad; i++) {
    if (p + 46 > b.length || v.getUint32(p, true) !== 0x02014b50) throw new ErrorArchivo('El archivo Excel está dañado');
    const flags = v.getUint16(p + 8, true);
    const metodo = v.getUint16(p + 10, true);
    const comprimido = v.getUint32(p + 20, true);
    const tamano = v.getUint32(p + 24, true);
    const nl = v.getUint16(p + 28, true);
    const el = v.getUint16(p + 30, true);
    const cl = v.getUint16(p + 32, true);
    const desplazamiento = v.getUint32(p + 42, true);
    const nombre = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nl));
    if (flags & 1) throw new ErrorArchivo('El archivo Excel está protegido con contraseña: guardalo sin protección');
    mapa.set(nombre, { metodo, comprimido, tamano, desplazamiento });
    p += 46 + nl + el + cl;
  }
  return mapa;
}

async function inflar(b: Uint8Array, e: EntradaZip, acumulado: { total: number; max: number }): Promise<Uint8Array> {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const o = e.desplazamiento;
  if (o + 30 > b.length || v.getUint32(o, true) !== 0x04034b50) throw new ErrorArchivo('El archivo Excel está dañado');
  const inicio = o + 30 + v.getUint16(o + 26, true) + v.getUint16(o + 28, true);
  const datos = b.subarray(inicio, inicio + e.comprimido);
  if (e.metodo === 0) return datos;
  if (e.metodo !== 8) throw new ErrorArchivo('El archivo Excel usa una compresión no soportada');
  const lector = new Blob([datos as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const partes: Uint8Array[] = [];
  let largo = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    largo += value.length;
    acumulado.total += value.length;
    if (acumulado.total > acumulado.max) {
      await lector.cancel();
      throw new ErrorArchivo('El archivo Excel descomprimido es demasiado grande');
    }
    partes.push(value);
  }
  const r = new Uint8Array(largo);
  let k = 0;
  for (const p of partes) (r.set(p, k), (k += p.length));
  return r;
}

const ENTIDADES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function sinEntidades(s: string): string {
  return s
    .replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, g: string) => {
      if (g[0] === '#') {
        const n = g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
      }
      return ENTIDADES[g] ?? m;
    })
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function atributos(tag: string): Record<string, string> {
  const r: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) r[m[1]] = sinEntidades(m[2]);
  return r;
}

function textoDe(xml: string): string {
  let s = '';
  for (const m of xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) s += m[1];
  return sinEntidades(s);
}

function indiceColumna(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function leerHoja(xml: string, compartidas: string[]): CeldaArchivo[][] {
  const filas: CeldaArchivo[][] = [];
  let siguiente = 0;
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const at = atributos(rm[1]);
    const idx = at.r ? parseInt(at.r, 10) - 1 : siguiente;
    siguiente = idx + 1;
    if (idx >= MAX_FILAS_LEIDAS) throw new ErrorArchivo(`La hoja tiene más de ${MAX_FILAS_LEIDAS} filas: dividila en partes más chicas`);
    const fila: CeldaArchivo[] = [];
    let col = 0;
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = atributos(cm[1]);
      if (a.r) col = indiceColumna(a.r);
      const cuerpo = cm[2] ?? '';
      const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cuerpo)?.[1];
      let valor: CeldaArchivo = '';
      if (a.t === 'inlineStr') valor = textoDe(cuerpo);
      else if (v !== undefined) {
        if (a.t === 's') valor = compartidas[parseInt(v, 10)] ?? '';
        else if (a.t === 'str') valor = sinEntidades(v);
        else if (a.t === 'b') valor = v === '1' ? 'VERDADERO' : 'FALSO';
        else if (a.t === 'e') valor = '';
        else {
          const n = Number(v);
          valor = Number.isFinite(n) ? n : sinEntidades(v);
        }
      }
      if (col < MAX_COLUMNAS && valor !== '') fila[col] = valor;
      col++;
    }
    for (let i = 0; i < fila.length; i++) if (fila[i] === undefined) fila[i] = '';
    while (filas.length < idx) filas.push([]);
    filas[idx] = fila;
  }
  const vacia = (f: CeldaArchivo[] | undefined) => !f || !f.some((c) => c !== '' && !(typeof c === 'string' && c.trim() === ''));
  while (filas.length && vacia(filas[filas.length - 1])) filas.pop();
  return Array.from(filas, (f) => f ?? []);
}

export async function leerXlsx(bytes: Uint8Array, maxDescomprimido = MAX_DESCOMPRIMIDO): Promise<HojaArchivo[]> {
  const zip = leerZip(bytes);
  const acum = { total: 0, max: maxDescomprimido };
  const leer = async (nombre: string): Promise<string | null> => {
    const e = zip.get(nombre);
    return e ? new TextDecoder('utf-8').decode(await inflar(bytes, e, acum)) : null;
  };
  const libro = await leer('xl/workbook.xml');
  if (!libro) throw new ErrorArchivo('El archivo no parece un libro de Excel (.xlsx)');
  const rels = (await leer('xl/_rels/workbook.xml.rels')) ?? '';
  const destinos = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const a = atributos(m[0]);
    if (a.Id && a.Target) destinos.set(a.Id, a.Target.startsWith('/') ? a.Target.slice(1) : `xl/${a.Target}`);
  }
  const compartidasXml = await leer('xl/sharedStrings.xml');
  const compartidas = compartidasXml ? [...compartidasXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)].map((m) => textoDe(m[1] ?? '')) : [];
  const hojas: HojaArchivo[] = [];
  for (const m of libro.matchAll(/<sheet\b[^>]*>/g)) {
    const a = atributos(m[0]);
    const destino = destinos.get(a['r:id']);
    const xml = destino ? await leer(destino) : null;
    if (!xml) continue;
    const filas = leerHoja(xml, compartidas);
    if (filas.length) hojas.push({ nombre: a.name ?? `Hoja ${hojas.length + 1}`, filas });
  }
  if (!hojas.length) throw new ErrorArchivo('El archivo no tiene datos en ninguna hoja');
  return hojas;
}

// ───────────────────────── Entrada ─────────────────────────

export async function leerArchivo(file: File): Promise<ArchivoLeido> {
  if (file.size === 0) throw new ErrorArchivo('El archivo está vacío');
  if (file.size > MAX_BYTES) throw new ErrorArchivo(`El archivo pesa ${(file.size / 1048576).toFixed(1)} MB y el máximo es ${MAX_BYTES / 1048576} MB. Dividilo en partes`);
  const nombre = file.name;
  const ext = nombre.toLowerCase().split('.').pop() ?? '';
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = await sha256Hex(bytes);
  if (ext === 'xls') throw new ErrorArchivo('Los archivos .xls (Excel antiguo) no se pueden leer. Abrilo en Excel y guardalo como .xlsx o como CSV');
  if (ext === 'xlsx') return { nombre, bytes: file.size, hash, formato: 'xlsx', hojas: await leerXlsx(bytes) };
  if (['csv', 'txt', 'tsv'].includes(ext)) {
    const filas = parsearCSV(decodificarTexto(bytes));
    if (!filas.length) throw new ErrorArchivo('El archivo no tiene datos');
    return { nombre, bytes: file.size, hash, formato: 'csv', hojas: [{ nombre: 'Datos', filas }] };
  }
  throw new ErrorArchivo('Formato no soportado: usá un archivo .xlsx o .csv');
}
