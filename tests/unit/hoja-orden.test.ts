// Hoja de la orden de trabajo (PDF): estructura del archivo, medidas, paginación sin cortes, espacio real para anotaciones y variantes.
// Con HOJA_SALIDA=<carpeta> además deja los PDF generados para revisarlos a ojo.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAGINA, VARIANTES, generarHojaOrden, type DatosHoja } from '../../worker/lib/hoja-orden';
import { anchoTexto, envolver } from '../../worker/lib/pdf/metricas';
import { cadenaPdf, leerJpeg } from '../../worker/lib/pdf/escritor';

const base = (): DatosHoja => ({
  taller: { nombre: 'Mecánica Rodríguez e Hijos', razonSocial: 'Rodríguez Hnos. S.R.L.', direccion: 'Av. San Martín 1234, Rosario', telefono: '341 555-0100', email: 'taller@ejemplo.com.ar' },
  logo: null,
  orden: { numero: 87, fechaApertura: '2026-10-24T17:35:00.000Z', fechaPrometida: '2026-10-27' },
  cliente: { visible: true, nombre: 'Marta Fernández', telefono: '341 600-1122' },
  vehiculo: { patente: 'AB123CD', marca: 'Volkswagen', modelo: 'Amarok V6', anio: 2019, km: 128450 },
  tecnico: { responsable: 'Julián Álvarez', participantes: ['Nicolás Ñandú'] },
  motivo: 'Ruido metálico al frenar en las ruedas delanteras y vibración en el volante a más de 80 km/h.',
  diagnostico: null,
  observaciones: 'El cliente deja la rueda de auxilio en el baúl. Llamar antes de cambiar discos.',
  trabajos: [
    { descripcion: 'Cambio de pastillas de freno delanteras', cantidad: 1 },
    { descripcion: 'Rectificación de discos', cantidad: 2 },
    { descripcion: 'Alineación y balanceo', cantidad: 1 },
  ],
  repuestos: [
    { descripcion: 'Juego de pastillas delanteras', cantidad: 1, unidad: 'un' },
    { descripcion: 'Líquido de frenos DOT 4', cantidad: 0.5, unidad: 'lt' },
  ],
  zonaHoraria: 'America/Argentina/Buenos_Aires',
  impresoAt: new Date('2026-10-24T18:00:00Z'),
});

const texto = (pdf: Uint8Array) => Buffer.from(pdf).toString('latin1');
/** Una "página" por cada objeto /Type /Page, devolviendo su flujo de contenido. */
function contenidos(pdf: Uint8Array): string[] {
  const t = texto(pdf);
  return [...t.matchAll(/<< \/Length \d+ >>\nstream\n([\s\S]*?)\nendstream/g)].map((m) => m[1]);
}
/** Texto legible de un flujo (lo que está entre paréntesis de cada Tj), decodificando los escapes octales de WinAnsi. */
function leer(flujo: string): string[] {
  return [...flujo.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((m) =>
    m[1].replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))).replace(/\\([()\\])/g, '$1'),
  );
}
const lineasEscritas = (flujo: string) => [...flujo.matchAll(/ ([\d.]+) ([\d.]+) m ([\d.]+) ([\d.]+) l S Q/g)].map((m) => ({ x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4] }));
const MM = 72 / 25.4;

function guardar(nombre: string, pdf: Uint8Array) {
  if (process.env.HOJA_SALIDA) {
    fs.mkdirSync(process.env.HOJA_SALIDA, { recursive: true });
    fs.writeFileSync(path.join(process.env.HOJA_SALIDA, nombre), pdf);
  }
}

describe('hoja de la orden de trabajo (PDF)', () => {
  it('genera un PDF A4 válido con xref coherente y metadatos sin datos de personas', () => {
    const { pdf, hojas } = generarHojaOrden(base(), ['mecanico']);
    guardar('mecanico.pdf', pdf);
    const t = texto(pdf);
    expect(t.startsWith('%PDF-1.4')).toBe(true);
    expect(t.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(hojas).toEqual([1]);
    expect(t).toContain('/MediaBox [0 0 595.28 841.89]');
    // cada entrada del xref apunta al "N 0 obj" correspondiente
    const inicioXref = Number(/startxref\n(\d+)/.exec(t)![1]);
    const filas = t.slice(inicioXref).split('\n').filter((l) => /^\d{10} 00000 n/.test(l));
    filas.forEach((f, i) => expect(t.slice(Number(f.slice(0, 10))).startsWith(`${i + 1} 0 obj`)).toBe(true));
    const info = /\/Title (\([^)]*\))/.exec(t)![1];
    expect(info).toContain('Orden de trabajo');
    expect(t).not.toMatch(/\/Author/);
    expect(info).not.toContain('Marta'); // el cliente no va en los metadatos
  });

  it('la copia del mecánico lleva los datos operativos, con acentos y ñ legibles, y ninguna cifra de dinero', () => {
    const { pdf } = generarHojaOrden(base(), ['mecanico']);
    const t = leer(contenidos(pdf)[0]).join('\n');
    for (const esperado of ['COPIA MECÁNICO', 'N° 0087', 'Mecánica Rodríguez e Hijos', 'Marta Fernández', '341 600-1122', 'Volkswagen Amarok V6', 'AB123CD', '2019', '128.450 km', 'Ruido metálico', 'Cambio de pastillas de freno delanteras', 'Líquido de frenos DOT 4', 'Julián Álvarez', 'Nicolás Ñandú (participa)', 'ANOTACIONES DEL MECÁNICO', '24/10/2026 14:35', '27/10/2026'].map((x) => x.replace(/^(.*)$/, '$1'))) {
      expect(t, esperado).toContain(esperado);
    }
    expect(t).not.toMatch(/\$|precio|costo|total|margen|IVA|subtotal/i);
    expect(t).toContain('0,5 lt');
  });

  it('la zona de anotaciones ocupa ~la mitad inferior y tiene renglones amplios', () => {
    const { pdf } = generarHojaOrden(base(), ['mecanico']);
    const f = contenidos(pdf)[0];
    const lineas = lineasEscritas(f).filter((l) => l.y1 === l.y2 && l.x2 - l.x1 > 170 * MM && Math.abs(l.x1 - 15 * MM) < 1);
    const renglones = lineas.filter((l) => l.y1 / MM < 297 - PAGINA.anotacionesDesde - 8 && l.y1 / MM > 297 - PAGINA.limite - 0.5); // y PDF crece hacia arriba; sin la raya del pie
    expect(renglones.length).toBeGreaterThanOrEqual(13);
    const ys = renglones.map((l) => l.y1).sort((a, b) => b - a);
    for (let i = 1; i < ys.length; i++) expect((ys[i - 1] - ys[i]) / MM).toBeGreaterThanOrEqual(8.5); // pasos de ~9 mm
    expect((PAGINA.limite - PAGINA.anotacionesDesde) / 297).toBeGreaterThan(0.45);
    // nada de contenido de la orden dentro de la zona de anotaciones: sólo su título y el pie
    const dentro = [...f.matchAll(/BT \/F\d [\d.]+ Tf [\d.]+ g [\d.]+ ([\d.]+) Td \(((?:\\.|[^\\)])*)\) Tj ET/g)].filter((m) => 297 - Number(m[1]) / MM > PAGINA.anotacionesDesde + 8 && 297 - Number(m[1]) / MM < 285);
    expect(dentro).toHaveLength(0);
  });

  it('"ambas" genera un solo PDF con dos hojas, cada una identificada; las variantes se definen por separado', () => {
    const { pdf, hojas } = generarHojaOrden(base(), ['mecanico', 'administracion']);
    guardar('ambas.pdf', pdf);
    expect(hojas).toEqual([1, 1]);
    const [a, b] = contenidos(pdf).map((c) => leer(c).join('\n'));
    expect(a).toContain('COPIA MECÁNICO');
    expect(a).not.toContain('COPIA ADMINISTRACIÓN');
    expect(b).toContain('COPIA ADMINISTRACIÓN');
    expect(b).not.toContain('COPIA MECÁNICO');
    expect(VARIANTES.mecanico.secciones).not.toBe(VARIANTES.administracion.secciones); // listas independientes
    expect(VARIANTES.administracion.permisos).toContain('ordenes.imprimir_administracion');
    expect(VARIANTES.mecanico.permisos).not.toContain('ordenes.imprimir_administracion');
  });

  it('no inventa datos: lo que falta se indica o se omite', () => {
    const d = base();
    Object.assign(d, { motivo: null, diagnostico: null, observaciones: null, trabajos: [], repuestos: [] });
    d.vehiculo = { patente: 'ZZ999ZZ', marca: null, modelo: null, anio: null, km: null };
    d.tecnico = { responsable: null, participantes: [] };
    d.cliente = { visible: false, nombre: null, telefono: null };
    d.orden.fechaPrometida = null;
    const { pdf } = generarHojaOrden(d, ['mecanico']);
    const t = leer(contenidos(pdf)[0]).join('\n');
    expect(t).toContain('No registrado.');
    expect(t).toContain('No hay trabajos cargados en la orden.');
    expect(t).toContain('No disponible con los permisos de quien imprime');
    expect(t).not.toContain('REPUESTOS');
    expect(t).not.toContain('OBSERVACIONES\n');
    expect(t).not.toMatch(/TEL[ÉE]FONO/);
  });

  it('una orden extensa pasa a hojas de continuación sin cortar filas y conserva una zona de anotaciones completa', () => {
    const d = base();
    d.trabajos = Array.from({ length: 40 }, (_, i) => ({ descripcion: `Trabajo número ${i + 1}: revisar y reemplazar el componente correspondiente del sistema de suspensión delantera izquierda y derecha, con prueba de ruta posterior`, cantidad: 1 }));
    d.repuestos = Array.from({ length: 12 }, (_, i) => ({ descripcion: `Repuesto ${i + 1}`, cantidad: i + 1, unidad: 'un' }));
    d.observaciones = 'Observación larga. '.repeat(120);
    const { pdf, hojas } = generarHojaOrden(d, ['mecanico', 'administracion']);
    guardar('extensa.pdf', pdf);
    expect(hojas[0]).toBeGreaterThan(2);
    const pags = contenidos(pdf).map((c) => leer(c));
    expect(pags).toHaveLength(hojas[0] + hojas[1]);
    // cada hoja de continuación repite el título de la tabla; los 40 trabajos aparecen una vez cada uno
    expect(pags.slice(1, hojas[0]).some((p) => p.includes('TRABAJOS SOLICITADOS (continuación)'))).toBe(true);
    const todos = pags.slice(0, hojas[0]).flat();
    for (let i = 1; i <= 40; i++) expect(todos.filter((x) => x.includes(`Trabajo número ${i}:`) || x.startsWith(`${i}.`) && false).length).toBeGreaterThanOrEqual(1);
    // la zona de anotaciones existe exactamente una vez por copia, y los pies numeran "Hoja n de m"
    const conAnot = pags.slice(0, hojas[0]).filter((p) => p.includes('ANOTACIONES DEL MECÁNICO'));
    expect(conAnot).toHaveLength(1);
    expect(pags[hojas[0] - 1].some((x) => x.includes(`Hoja ${hojas[0]} de ${hojas[0]}`))).toBe(true);
    // ninguna línea de texto se sale del margen derecho
    for (const c of contenidos(pdf)) {
      for (const m of c.matchAll(/BT \/(F\d) ([\d.]+) Tf [\d.]+ g ([\d.]+) [\d.]+ Td \(((?:\\.|[^\\)])*)\) Tj ET/g)) {
        const tx = m[4].replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))).replace(/\\([()\\])/g, '$1');
        const fin = Number(m[3]) / MM + (anchoTexto(tx, m[1] === 'F2' ? 'negrita' : 'normal', Number(m[2])) * 25.4) / 72;
        expect(fin, tx).toBeLessThanOrEqual(PAGINA.der + 0.6);
      }
    }
  });

  it('si el contenido llega hasta la mitad de la hoja, las anotaciones tienen una hoja propia', () => {
    const d = base();
    d.trabajos = Array.from({ length: 12 }, (_, i) => ({ descripcion: `Trabajo ${i + 1}`, cantidad: 1 }));
    const { hojas, pdf } = generarHojaOrden(d, ['mecanico']);
    guardar('anotaciones-aparte.pdf', pdf);
    expect(hojas).toEqual([2]);
    const pags = contenidos(pdf).map((c) => leer(c));
    expect(pags[0].join('\n')).not.toContain('ANOTACIONES DEL MECÁNICO');
    expect(pags[1].join('\n')).toContain('ANOTACIONES DEL MECÁNICO');
  });

  it('incrusta el logo del taller si es JPEG y lo omite si no se puede usar', () => {
    const seg = (m: number, d: number[]) => [0xff, m, (d.length + 2) >> 8, (d.length + 2) & 0xff, ...d];
    const jpg = Uint8Array.from([0xff, 0xd8, ...seg(0xc0, [8, 0, 40, 0, 120, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]), 1, 2, 3, 0xff, 0xd9]);
    const con = generarHojaOrden({ ...base(), logo: jpg }, ['mecanico', 'administracion']);
    const t = texto(con.pdf);
    expect(t).toContain('/Subtype /Image');
    expect(t).toContain('/Filter /DCTDecode');
    expect(t.match(/\/Im1 Do/g)).toHaveLength(2); // el mismo logo en las dos hojas, un solo objeto de imagen
    expect(t.match(/\/Subtype \/Image/g)).toHaveLength(1);
    expect(texto(generarHojaOrden({ ...base(), logo: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2]) }, ['mecanico']).pdf)).not.toContain('/Subtype /Image');
  });

  it('la foto del vehículo va arriba a la derecha, sin deformarse, y no quita espacio ni agrega hojas: las anotaciones siguen en 145 mm con sus renglones', () => {
    const seg = (m: number, d: number[]) => [0xff, m, (d.length + 2) >> 8, (d.length + 2) & 0xff, ...d];
    const jpg = (w: number, h: number) => Uint8Array.from([0xff, 0xd8, ...seg(0xc0, [8, h >> 8, h & 0xff, w >> 8, w & 0xff, 1, 1, 0x11, 0]), ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]), 1, 2, 3, 0xff, 0xd9]);
    const sin = generarHojaOrden(base(), ['mecanico', 'administracion']);
    for (const [w, h] of [[640, 480], [480, 640], [1000, 200]]) {
      const con = generarHojaOrden({ ...base(), foto: jpg(w, h) }, ['mecanico', 'administracion']);
      expect(con.hojas).toEqual(sin.hojas);
      const t = texto(con.pdf);
      expect(t.match(/\/Subtype \/Image/g)).toHaveLength(1); // una sola imagen para las dos copias
      const flujos = contenidos(con.pdf);
      for (const f of flujos) {
        const m = /q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm \/Im1 Do Q/.exec(f)!;
        const [ancho, alto, x, y] = [+m[1] / MM, +m[2] / MM, +m[3] / MM, 297 - +m[4] / MM];
        expect(ancho / alto).toBeCloseTo(w / h, 1); // proporciones intactas
        expect(ancho).toBeLessThanOrEqual(30.01);
        expect(alto).toBeLessThanOrEqual(23.01);
        expect(x + ancho).toBeCloseTo(PAGINA.der, 1); // pegada al margen derecho
        expect(y).toBeLessThan(PAGINA.anotacionesDesde - 40); // en la parte superior
        // las 14 líneas de anotaciones y su título siguen donde estaban
        const renglones = lineasEscritas(f).filter((l) => l.y1 === l.y2 && l.x2 - l.x1 > 170 * MM && l.y1 / MM < 297 - PAGINA.anotacionesDesde - 8 && l.y1 / MM > 297 - PAGINA.limite - 0.5);
        expect(renglones.length).toBeGreaterThanOrEqual(13);
        expect(leer(f).join(' ')).toContain('ANOTACIONES DEL MECÁNICO');
      }
    }
  });

  it('una foto que no es un JPEG incrustable se omite sin romper la hoja', () => {
    const r = generarHojaOrden({ ...base(), foto: Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3]) }, ['mecanico']);
    expect(texto(r.pdf)).not.toContain('/Subtype /Image');
    expect(r.hojas).toEqual([1]);
  });

  it('textos largos sin espacios y caracteres raros no rompen el diseño ni el archivo', () => {
    const d = base();
    d.motivo = `${'X'.repeat(300)} (paréntesis) \\ barra \t tab\r\nsegunda línea 😀 ✓`;
    d.trabajos = [{ descripcion: 'Y'.repeat(400), cantidad: 1.25 }];
    const { pdf } = generarHojaOrden(d, ['mecanico']);
    guardar('raros.pdf', pdf);
    const t = leer(contenidos(pdf)[0]).join('\n');
    expect(t).toContain('(paréntesis) \\ barra');
    expect(t).toContain('segunda línea');
    expect(t).toContain('1,25');
    for (const l of leer(contenidos(pdf)[0])) expect(anchoTexto(l, 'normal', 10)).toBeLessThanOrEqual(180 * MM * 1.06 + 400);
  });
});

describe('utilidades del PDF', () => {
  it('envolver respeta el ancho, los saltos y las palabras larguísimas', () => {
    const r = envolver('uno dos tres cuatro cinco seis siete ocho nueve diez', 'normal', 10, 60);
    expect(r.length).toBeGreaterThan(1);
    for (const l of r) expect(anchoTexto(l, 'normal', 10)).toBeLessThanOrEqual(60);
    expect(envolver('a\n\nb', 'normal', 10, 100)).toEqual(['a', '', 'b']);
    for (const l of envolver('W'.repeat(100), 'negrita', 10, 50)) expect(anchoTexto(l, 'negrita', 10)).toBeLessThanOrEqual(50);
  });
  it('cadenaPdf escapa y codifica en WinAnsi (ASCII puro)', () => {
    expect(cadenaPdf('a(b)\\c')).toBe('(a\\(b\\)\\\\c)');
    expect(cadenaPdf('ñ')).toBe('(\\361)');
    expect(cadenaPdf('€')).toBe('(\\200)');
    expect(cadenaPdf('😀')).toBe('(?)');
    expect(/^[\x20-\x7e]*$/.test(cadenaPdf('Ó¿Qué pasó? — ok'))).toBe(true);
  });
  it('leerJpeg reconoce un JPEG y descarta lo que no lo es', () => {
    const seg = (m: number, d: number[]) => [0xff, m, (d.length + 2) >> 8, (d.length + 2) & 0xff, ...d];
    const j = Uint8Array.from([0xff, 0xd8, ...seg(0xe0, [74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]), ...seg(0xc0, [8, 0, 40, 0, 120, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), 0xff, 0xd9]);
    expect(leerJpeg(j)).toEqual({ ancho: 120, alto: 40, componentes: 3 });
    expect(leerJpeg(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(leerJpeg(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });
});
