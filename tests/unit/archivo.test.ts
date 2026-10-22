import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { decodificarTexto, detectarDelimitador, ErrorArchivo, leerArchivo, leerXlsx, parsearCSV, sha256Hex } from '../../src/lib/archivo';

// ───── Generador mínimo de .xlsx para las pruebas (ZIP con deflate) ─────
function crc32(b: Buffer): number {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function zip(archivos: Record<string, string>, metodo: 0 | 8 = 8): Buffer {
  const locales: Buffer[] = [];
  const centrales: Buffer[] = [];
  let offset = 0;
  for (const [nombre, contenido] of Object.entries(archivos)) {
    const datos = Buffer.from(contenido, 'utf8');
    const comp = metodo === 8 ? zlib.deflateRawSync(datos) : datos;
    const n = Buffer.from(nombre);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(metodo, 8);
    loc.writeUInt32LE(crc32(datos), 14);
    loc.writeUInt32LE(comp.length, 18);
    loc.writeUInt32LE(datos.length, 22);
    loc.writeUInt16LE(n.length, 26);
    locales.push(loc, n, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(metodo, 10);
    cen.writeUInt32LE(crc32(datos), 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(datos.length, 24);
    cen.writeUInt16LE(n.length, 28);
    cen.writeUInt32LE(offset, 42);
    centrales.push(cen, n);
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrales);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(centrales.length / 2, 8);
  fin.writeUInt16LE(centrales.length / 2, 10);
  fin.writeUInt32LE(cd.length, 12);
  fin.writeUInt32LE(offset, 16);
  return Buffer.concat([...locales, cd, fin]);
}

const LIBRO = `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Clientes" sheetId="1" r:id="rId1"/><sheet name="Vacía" sheetId="2" r:id="rId2"/></sheets></workbook>`;
const RELS = `<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x" Target="worksheets/sheet2.xml"/></Relationships>`;
const COMPARTIDAS = `<sst><si><t>Nombre</t></si><si><t>Documento</t></si><si><r><t>Juan </t></r><r><t>Pérez &amp; Hijos</t></r></si><si><t>Ana</t><rPh><t>fonético</t></rPh></si></sst>`;
const HOJA1 = `<worksheet><sheetData>
  <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Saldo</t></is></c></row>
  <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>30123456</v></c><c r="C2"><v>1234.5</v></c></row>
  <row r="4"><c r="A4" t="s"><v>3</v></c><c r="C4" t="str"><v>texto fórmula</v></c></row>
  <row r="5"/>
</sheetData></worksheet>`;
const HOJA2 = `<worksheet><sheetData/></worksheet>`;

const xlsx = (metodo: 0 | 8 = 8) =>
  zip({ 'xl/workbook.xml': LIBRO, 'xl/_rels/workbook.xml.rels': RELS, 'xl/sharedStrings.xml': COMPARTIDAS, 'xl/worksheets/sheet1.xml': HOJA1, 'xl/worksheets/sheet2.xml': HOJA2 }, metodo);

describe('CSV', () => {
  it('detecta el separador y respeta comillas, saltos de línea internos y comillas escapadas', () => {
    const t = 'Nombre;Nota;Monto\r\n"Pérez; Juan";"dijo ""hola""\nchau";1.234,50\r\n\r\nAna;;10\r\n';
    expect(detectarDelimitador(t)).toBe(';');
    const f = parsearCSV(t);
    expect(f[0]).toEqual(['Nombre', 'Nota', 'Monto']);
    expect(f[1]).toEqual(['Pérez; Juan', 'dijo "hola"\nchau', '1.234,50']);
    expect(f[2]).toEqual([]); // la fila vacía conserva su lugar para que el número de fila coincida con el del archivo
    expect(f[3]).toEqual(['Ana', '', '10']);
  });
  it('detecta coma y tabulación', () => {
    expect(parsearCSV('a,b,c\n1,2,3')[1]).toEqual(['1', '2', '3']);
    expect(parsearCSV('a\tb\n1\t2')[1]).toEqual(['1', '2']);
  });
  it('decodifica UTF-8 con BOM y Windows-1252 (Excel en español)', () => {
    expect(decodificarTexto(new Uint8Array([0xef, 0xbb, 0xbf, 0x4d, 0xc3, 0xa1]))).toBe('Má');
    expect(decodificarTexto(new Uint8Array([0x4d, 0x61, 0x72, 0xed, 0x61]))).toBe('María'); // 0xED = í en Windows-1252, inválido en UTF-8
  });
});

describe('XLSX', () => {
  it('lee hojas, textos compartidos, textos en línea, números y respeta la fila de origen', async () => {
    const hojas = await leerXlsx(new Uint8Array(xlsx()));
    expect(hojas.map((h) => h.nombre)).toEqual(['Clientes']); // la hoja sin datos se descarta
    const f = hojas[0].filas;
    expect(f[0]).toEqual(['Nombre', 'Documento', 'Saldo']);
    expect(f[1]).toEqual(['Juan Pérez & Hijos', 30123456, 1234.5]);
    expect(f[2]).toEqual([]); // fila 3 vacía: la siguiente es la fila 4
    expect(f[3]).toEqual(['Ana', '', 'texto fórmula']); // sin el fonético
    expect(f.length).toBe(4);
  });
  it('lee entradas sin comprimir', async () => {
    const hojas = await leerXlsx(new Uint8Array(xlsx(0)));
    expect(hojas[0].filas[1][1]).toBe(30123456);
  });
  it('rechaza archivos que no son un libro de Excel', async () => {
    await expect(leerXlsx(new Uint8Array(Buffer.from('esto no es un zip')))).rejects.toThrow(ErrorArchivo);
    await expect(leerXlsx(new Uint8Array(zip({ 'otro.txt': 'hola' })))).rejects.toThrow(/Excel/);
  });
  it('corta los archivos que descomprimen a un tamaño absurdo (archivo "bomba")', async () => {
    const enorme = '<worksheet><sheetData>' + ' '.repeat(3 * 1024 * 1024) + '</sheetData></worksheet>';
    const z = zip({ 'xl/workbook.xml': LIBRO, 'xl/_rels/workbook.xml.rels': RELS, 'xl/worksheets/sheet1.xml': enorme });
    expect(z.length).toBeLessThan(1024 * 1024); // se comprime a casi nada: por eso hay que limitar lo descomprimido
    await expect(leerXlsx(new Uint8Array(z), 1024 * 1024)).rejects.toThrow(/demasiado grande/);
  });
});

describe('leerArchivo', () => {
  const archivo = (nombre: string, datos: Buffer | string) => new File([datos as BlobPart], nombre);
  it('calcula la huella y lee CSV y XLSX', async () => {
    const csv = await leerArchivo(archivo('clientes.csv', 'Nombre;DNI\nAna;30123456\n'));
    expect(csv.formato).toBe('csv');
    expect(csv.hojas[0].filas[1]).toEqual(['Ana', '30123456']);
    expect(csv.hash).toBe(await sha256Hex(new TextEncoder().encode('Nombre;DNI\nAna;30123456\n')));
    const x = await leerArchivo(archivo('c.xlsx', xlsx()));
    expect(x.formato).toBe('xlsx');
  });
  it('explica por qué rechaza .xls, archivos vacíos y formatos desconocidos', async () => {
    await expect(leerArchivo(archivo('viejo.xls', 'x'))).rejects.toThrow(/xlsx|CSV/);
    await expect(leerArchivo(archivo('v.csv', ''))).rejects.toThrow(/vacío/);
    await expect(leerArchivo(archivo('doc.pdf', 'x'))).rejects.toThrow(/Formato/);
  });
  it('rechaza archivos que superan el máximo', async () => {
    const grande = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'g.csv');
    await expect(leerArchivo(grande)).rejects.toThrow(/máximo/);
  });
});
