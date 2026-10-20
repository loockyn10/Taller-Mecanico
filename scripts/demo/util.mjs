// Utilidades del generador de datos de demostración: azar determinista, fechas argentinas, CUIT válidos y formato.

/** Generador pseudoaleatorio determinista (mulberry32): la misma semilla produce siempre el mismo taller. */
export function rng(semilla) {
  let a = semilla >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const R = {
    next,
    /** Entero en [a, b]. */
    int: (a, b) => a + Math.floor(next() * (b - a + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** Elige según pesos: [[valor, peso], ...]. */
    pesos(pares) {
      const total = pares.reduce((s, p) => s + p[1], 0);
      let x = next() * total;
      for (const [v, w] of pares) if ((x -= w) < 0) return v;
      return pares[pares.length - 1][0];
    },
    shuffle(arr) {
      const r = [...arr];
      for (let i = r.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [r[i], r[j]] = [r[j], r[i]];
      }
      return r;
    },
  };
  return R;
}

// ───── Fechas (la API usa fechas comerciales de Argentina, UTC-3) ─────
export const hoyAR = (ms = Date.now()) => new Date(ms - 3 * 3600_000).toISOString().slice(0, 10);
export function sumarDias(fecha, n) {
  const [y, m, d] = fecha.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export const diasEntre = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400_000);
/** 0 = domingo. */
export const diaSemana = (fecha) => new Date(`${fecha}T12:00:00Z`).getUTCDay();

/** Fechas de trabajo (lunes a sábado) de los últimos `corridos` días, en orden. `fin` siempre se incluye (es la jornada actual). */
export function jornadas(fin, corridos) {
  const r = [];
  for (let i = corridos - 1; i >= 0; i--) {
    const f = sumarDias(fin, -i);
    if (diaSemana(f) !== 0 || f === fin) r.push(f);
  }
  return r;
}

// ───── Identificadores fiscales ficticios pero válidos ─────
export function cuit(prefijo, cuerpo) {
  const base = `${prefijo}${String(cuerpo).padStart(8, '0')}`;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((a, p, i) => a + p * Number(base[i]), 0);
  let v = 11 - (suma % 11);
  if (v === 11) v = 0;
  if (v === 10) v = 9;
  return `${prefijo}-${String(cuerpo).padStart(8, '0')}-${v}`;
}

// ───── Dinero (centavos) ─────
export const pesos = (n) => Math.round(n * 100);
export const ars = (centavos) => (centavos / 100).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
export const redondear = (n, paso) => Math.round(n / paso) * paso;

export const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
export const pad = (n, w = 2) => String(n).padStart(w, '0');
