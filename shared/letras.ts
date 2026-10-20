// Importe en letras (castellano rioplatense) para recibos: 12345.67 → "doce mil trescientos cuarenta y cinco con 67/100".

const UNIDADES = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const DECENAS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const CENTENAS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

function menorDeMil(n: number): string {
  if (n === 0) return '';
  if (n === 100) return 'cien';
  const c = Math.floor(n / 100);
  const r = n % 100;
  const partes: string[] = [];
  if (c) partes.push(CENTENAS[c]);
  if (r) {
    if (r < 30) partes.push(UNIDADES[r]);
    else {
      const d = Math.floor(r / 10);
      const u = r % 10;
      partes.push(u ? `${DECENAS[d]} y ${UNIDADES[u]}` : DECENAS[d]);
    }
  }
  return partes.join(' ');
}

function enteroEnLetras(n: number): string {
  if (n === 0) return 'cero';
  const millones = Math.floor(n / 1_000_000);
  const miles = Math.floor((n % 1_000_000) / 1000);
  const resto = n % 1000;
  const partes: string[] = [];
  if (millones) partes.push(millones === 1 ? 'un millón' : `${enteroEnLetras(millones)} millones`);
  if (miles) partes.push(miles === 1 ? 'mil' : `${menorDeMil(miles).replace(/veintiuno$/, 'veintiún').replace(/uno$/, 'un')} mil`);
  if (resto) partes.push(menorDeMil(resto));
  // "uno" al final de un número compuesto se mantiene ("veintiuno"); antes de "mil/millones" se apocopa (arriba).
  return partes.join(' ');
}

/** `centavos` entero → texto con los centavos como fracción ("con 07/100"). */
export function importeEnLetras(centavos: number): string {
  const pesos = Math.floor(Math.abs(centavos) / 100);
  const cts = Math.abs(centavos) % 100;
  const texto = enteroEnLetras(pesos);
  return `${texto.charAt(0).toUpperCase()}${texto.slice(1)} con ${String(cts).padStart(2, '0')}/100`;
}
