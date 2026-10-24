// Tipografía de los PDF: Helvetica y Helvetica-Bold, fuentes estándar de todo lector de PDF e impresora (no se incrustan).
// Los anchos son los de las métricas AFM oficiales (milésimas de em) para los caracteres ASCII; las letras acentuadas miden como su letra base.

export type Fuente = 'normal' | 'negrita';

const ANCHO_NORMAL = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const ANCHO_NEGRITA = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
/** Signos fuera del ASCII: [normal, negrita]. */
const ESPECIALES: Record<string, [number, number]> = {
  '¡': [333, 333], '¿': [611, 611], '°': [400, 400], 'º': [365, 365], 'ª': [370, 370], '«': [556, 556], '»': [556, 556], '·': [278, 278],
  '—': [1000, 1000], '–': [556, 556], '‘': [222, 278], '’': [222, 278], '“': [333, 500], '”': [333, 500], '•': [350, 350], '…': [1000, 1000],
  '€': [556, 556], '×': [584, 584], '±': [584, 584], '§': [556, 556], '©': [737, 737], '®': [737, 737], 'ß': [611, 611], 'Æ': [1000, 1000], 'æ': [889, 889],
};

/** Tabla Unicode → byte de WinAnsi (cp1252) para lo que no coincide con Latin-1. */
const CP1252: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e,
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};

/** Limpia el texto: normaliza (NFC), unifica los saltos de línea y descarta lo que no se puede escribir. */
export function limpiarTexto(t: string): string {
  return t
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .replace(/[\u00a0\u2007\u202f]/g, ' ');
}

/** Byte de WinAnsi de un carácter (63 = «?» si no existe en la fuente). */
export function byteWinAnsi(ch: string): number {
  const c = ch.codePointAt(0)!;
  if (c >= 32 && c <= 126) return c;
  if (c >= 0xa0 && c <= 0xff) return c;
  return CP1252[ch] ?? 63;
}

function anchoCaracter(ch: string, f: Fuente): number {
  const c = ch.codePointAt(0)!;
  if (c >= 32 && c <= 126) return (f === 'negrita' ? ANCHO_NEGRITA : ANCHO_NORMAL)[c - 32];
  const e = ESPECIALES[ch];
  if (e) return e[f === 'negrita' ? 1 : 0];
  // Letra acentuada: mide como la letra base.
  const base = ch.normalize('NFD')[0];
  if (base && base !== ch) return anchoCaracter(base, f);
  return 556;
}

/** Ancho del texto en puntos tipográficos. */
export function anchoTexto(t: string, f: Fuente, tam: number): number {
  let u = 0;
  for (const ch of t) u += anchoCaracter(ch, f);
  return (u * tam) / 1000;
}

/**
 * Parte el texto en renglones que entren en `max` puntos, cortando en los espacios (y, si una palabra sola no entra, dentro de la palabra).
 * Respeta los saltos de línea del texto. Nunca devuelve renglones que se pasen del ancho.
 */
export function envolver(texto: string, f: Fuente, tam: number, max: number): string[] {
  const salida: string[] = [];
  for (const parrafo of limpiarTexto(texto).split('\n')) {
    const palabras = parrafo.split(/ +/).filter(Boolean);
    if (!palabras.length) {
      salida.push('');
      continue;
    }
    let actual = '';
    const cerrar = () => {
      if (actual) salida.push(actual);
      actual = '';
    };
    for (let p of palabras) {
      // Palabra más ancha que el renglón: se corta en tramos que entren.
      while (anchoTexto(p, f, tam) > max) {
        cerrar();
        let n = 1;
        while (n < p.length && anchoTexto(p.slice(0, n + 1), f, tam) <= max) n++;
        salida.push(p.slice(0, n));
        p = p.slice(n);
      }
      const prueba = actual ? `${actual} ${p}` : p;
      if (!actual || anchoTexto(prueba, f, tam) <= max) actual = prueba;
      else {
        cerrar();
        actual = p;
      }
    }
    cerrar();
  }
  return salida;
}

/** Recorta con «…» para que entre en una sola línea. */
export function recortar(texto: string, f: Fuente, tam: number, max: number): string {
  const t = limpiarTexto(texto).replace(/\n/g, ' ');
  if (anchoTexto(t, f, tam) <= max) return t;
  let n = t.length;
  while (n > 1 && anchoTexto(`${t.slice(0, n)}…`, f, tam) > max) n--;
  return `${t.slice(0, n).trimEnd()}…`;
}
