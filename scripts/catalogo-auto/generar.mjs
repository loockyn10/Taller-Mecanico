// Normaliza el agregado de la DNRPA y genera el catálogo compacto (marcas → modelos → versiones).
// Salida: data/catalogo-auto/catalogo.json.gz (se versiona: es chico y permite cargar D1 sin volver a descargar).
//
// Qué trae la fuente: por cada inscripción, marca (código + descripción), "modelo" (código + descripción comercial completa,
// p. ej. "AMAROK TRENDLINE TDI MT 4X2 G2"), año modelo y tipo de vehículo. No hay motorización ni versión estructuradas.
// Por eso: el MODELO es la familia (primer término de la descripción, más reglas explícitas de reglas.json) y la VERSIÓN es
// el resto de la descripción tal cual la informó el registro. La motorización sólo se informa cuando la descripción la dice literalmente.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { CACHE, ROOT } from './lib.mjs';

const minVersion = Number(process.argv.find((a) => a.startsWith('--min-version='))?.split('=')[1] ?? 2);
const reglas = JSON.parse(await fs.readFile(path.join(import.meta.dirname, 'reglas.json'), 'utf8'));
const agregado = JSON.parse(await fs.readFile(path.join(CACHE, 'agregado.json'), 'utf8'));
const dataset = JSON.parse(await fs.readFile(path.join(CACHE, 'dataset.json'), 'utf8').catch(() => '{}'));

const sinTildes = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const mayus = (s) => sinTildes(s).toUpperCase().replace(/\s+/g, ' ').trim();
const limpiarMarca = (s) => mayus(s).replace(/[^A-Z0-9&]+/g, ' ').trim();
const clave = (s) => sinTildes(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const slug = (s) => sinTildes(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const reExcluir = new RegExp(`\\b(${reglas.excluirTipos})\\b`);
const reExcepto = new RegExp(reglas.excluirTiposExcepto);
const marcasExcluidas = new Set(reglas.excluirMarcas);
const compuestas = reglas.compuestas.map((c) => c.split(' '));
const usadas = { compuestas: new Set(), aliasMarcas: new Set(), frases: new Set() };

// ───────── Nombres para mostrar ─────────
const ROMANO = /^(II|III|IV|VI|VII|VIII|IX|XI|XII)$/;
function parte(p) {
  if (/\d/.test(p) || p.length <= 2 || /^[^AEIOUY]{3}$/.test(p) || ROMANO.test(p)) return p;
  return p[0] + p.slice(1).toLowerCase();
}
const palabra = (w) => w.split('-').map(parte).join('-');
const CONECTORES = new Set(['Y', 'DE', 'DEL', 'LA', 'EL']);
function nombreMarca(m) {
  if (reglas.nombresMarcas[m]) return reglas.nombresMarcas[m];
  return m.split(' ').map((w, i) => (i > 0 && CONECTORES.has(w) ? w.toLowerCase() : palabra(w))).join(' ');
}
function nombreModelo(f) {
  if (reglas.nombresModelos[f]) return reglas.nombresModelos[f];
  const w = f.split(' ');
  if (w.length === 2 && /^[A-Z]$/.test(w[0]) && /^[A-Z]{2,}$/.test(w[1])) return `${w[0]}-${parte(w[1])}`;
  return w.map(palabra).join(' ');
}

// ───────── Familia (modelo) y versión ─────────
const PREFIJOS = new Set(['NUEVO', 'NUEVA', 'NUEVOS', 'NEW']);
function separar(marca, desc) {
  let t = desc.split(' ').filter(Boolean);
  for (let k = 3; k >= 1; k--) {
    if (t.length > k && clave(t.slice(0, k).join('')) === clave(marca)) {
      t = t.slice(k);
      break;
    }
  }
  if (t.length > 2 && t[0] === 'ALL' && t[1] === 'NEW') t = t.slice(2);
  while (t.length > 1 && PREFIJOS.has(t[0])) t = t.slice(1);
  for (const [frase, familia] of Object.entries(reglas.frasesModelo[marca] ?? {})) {
    const f = frase.split(' ');
    if (t.length >= f.length && f.every((x, i) => t[i] === x)) {
      usadas.frases.add(`${marca}|${frase}`);
      const fw = familia.split(' ');
      return { fam: familia, version: [...f.filter((x) => !fw.includes(x)), ...t.slice(f.length)].join(' ') };
    }
  }
  let n = 1;
  for (const c of compuestas) {
    if (t.length >= c.length && c.every((x, i) => t[i] === x)) {
      n = c.length;
      usadas.compuestas.add(c.join(' '));
      break;
    }
  }
  if (n === 1 && t.length > 1 && /^[A-Z]$/.test(t[0])) n = 2;
  const fam = t.slice(0, n).join(' ').replace(/[,;.]+$/, '');
  return { fam, version: t.slice(n).join(' ') };
}

// ───────── Motorización (sólo si la descripción lo dice) ─────────
const ETIQUETAS = [
  [/\b(TDI)\b/, 'TDI'], [/\b(TFSI)\b/, 'TFSI'], [/\b(TSI)\b/, 'TSI'], [/\b(BLUEHDI|HDI)\b/, 'HDi'], [/\b(TDCI)\b/, 'TDCi'], [/\b(DCI)\b/, 'dCi'],
  [/\b(CDI)\b/, 'CDI'], [/\b(JTD|MULTIJET)\b/, 'Multijet'], [/\b(CRD)\b/, 'CRDi'], [/\b(PHEV)\b/, 'Híbrido enchufable'], [/\b(HEV|HV|HYBRID|HIBRIDO|MHEV)\b/, 'Híbrido'],
  [/\b(BEV|ELECTRICO)\b/, 'Eléctrico'], [/\bTD\b|\d\.\dTD\b/, 'Turbo Diésel'], [/\bDIESEL\b|\bTURBO DIESEL\b|\d\.\dD\b/, 'Diésel'], [/\bTURBO\b|\d\.\dT\b|\bT200\b|\bTCE\b|\bTHP\b/, 'Turbo'],
];
const DIESEL = new Set(['TDI', 'HDi', 'TDCi', 'dCi', 'CDI', 'Multijet', 'CRDi', 'Turbo Diésel', 'Diésel']);
function motorizacion(desc) {
  const m = /(?<![\d.,])(\d\.\d)(?!\d)/.exec(desc);
  const cil = m && Number(m[1]) >= 0.6 && Number(m[1]) <= 8.5 ? m[1] : null;
  const v = /\b(V6|V8|V10|V12)\b/.exec(desc)?.[1] ?? null;
  const e = ETIQUETAS.find(([re]) => re.test(desc))?.[1] ?? null;
  if (!cil && !v && !e) return { motor: null, combustible: null };
  const motor = [cil, v, e].filter(Boolean).join(' ');
  return { motor, combustible: e && DIESEL.has(e) ? 'Diésel' : e === 'Híbrido' || e === 'Híbrido enchufable' ? 'Híbrido' : e === 'Eléctrico' ? 'Eléctrico' : null };
}

// ───────── Armado ─────────
const marcas = new Map(); // clave de marca → { nombre, codigos:Set, n, modelos: Map }
let descartadasTipo = 0;
let descartadasMarca = 0;
for (const e of agregado.combinaciones) {
  if ((reExcluir.test(mayus(e.t)) && !reExcepto.test(mayus(e.t))) || marcasExcluidas.has(limpiarMarca(e.m))) {
    if (marcasExcluidas.has(limpiarMarca(e.m))) descartadasMarca += e.n;
    else descartadasTipo += e.n;
    continue;
  }
  let mk = limpiarMarca(e.m);
  if (reglas.aliasMarcas[mk]) {
    usadas.aliasMarcas.add(mk);
    mk = reglas.aliasMarcas[mk];
  }
  const desc = mayus(e.o).replace(/^[^A-Z0-9]+/, '');
  if (!mk || !desc) continue;
  const { fam, version } = separar(mk, desc);
  if (!fam || !/[A-Z0-9]/.test(fam) || fam.length > 30) continue;
  let ma = marcas.get(clave(mk));
  if (!ma) marcas.set(clave(mk), (ma = { clave: mk, variantes: new Map(), codigos: new Set(), n: 0, modelos: new Map() }));
  ma.variantes.set(mk, (ma.variantes.get(mk) ?? 0) + e.n);
  ma.codigos.add(e.mc);
  const ck = clave(fam);
  let mo = ma.modelos.get(ck);
  if (!mo) ma.modelos.set(ck, (mo = { ck, variantes: new Map(), versiones: new Map(), tipos: new Map() }));
  mo.variantes.set(fam, (mo.variantes.get(fam) ?? 0) + e.n);
  mo.tipos.set(mayus(e.t), (mo.tipos.get(mayus(e.t)) ?? 0) + e.n);
  let ve = mo.versiones.get(desc);
  if (!ve) mo.versiones.set(desc, (ve = { desc, version, n: 0, anios: new Map(), codigos: new Set(), tipos: new Map() }));
  ve.n += e.n;
  ve.codigos.add(`${e.mc}/${e.oc}/${e.tc}`);
  ve.tipos.set(mayus(e.t), (ve.tipos.get(mayus(e.t)) ?? 0) + e.n);
  for (const [a, c] of Object.entries(e.a)) ve.anios.set(Number(a), (ve.anios.get(Number(a)) ?? 0) + c);
}

const dominante = (mapa) => [...mapa.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
const tipoLindo = (t) => (t ? t[0] + t.slice(1).toLowerCase().replace(/\bpick-up\b/, 'pick-up').replace(/\bc\/(\w)/g, 'c/$1') : null);

for (const ma of marcas.values()) ma.clave = [...ma.variantes.entries()].sort((a, b) => b[1] - a[1])[0][0];
const salida = { marcas: [], modelos: [], versiones: [] };
let verDescartadas = 0;
for (const ma of [...marcas.values()]) {
  const modelosMarca = [];
  for (const mo of ma.modelos.values()) {
    const vs = [...mo.versiones.values()].filter((v) => v.n >= minVersion);
    verDescartadas += mo.versiones.size - vs.length;
    if (!vs.length) continue;
    const fam = dominante(mo.variantes);
    const idModelo = `mo_${slug(ma.clave)}__${mo.ck}`;
    const anios = new Map();
    let n = 0;
    for (const v of vs) {
      n += v.n;
      for (const [a, c] of v.anios) anios.set(a, (anios.get(a) ?? 0) + c);
      const mt = motorizacion(v.desc);
      salida.versiones.push({
        id: `ve_${crypto.createHash('sha1').update(`${idModelo}|${v.desc}`).digest('hex').slice(0, 12)}`,
        modelo_id: idModelo,
        descripcion: v.desc,
        version: v.version || null,
        motorizacion: mt.motor,
        combustible: mt.combustible,
        tipo: tipoLindo(dominante(v.tipos)),
        codigos: [...v.codigos].sort(),
        anios: [...v.anios.keys()].sort((a, b) => a - b),
        n: v.n,
      });
    }
    const ys = [...anios.keys()].sort((a, b) => a - b);
    modelosMarca.push({ id: idModelo, marca_id: `ma_${slug(ma.clave)}`, nombre: nombreModelo(fam), clave: mo.ck, tipo: tipoLindo(dominante(mo.tipos)), anios: ys, n });
  }
  if (!modelosMarca.length) continue;
  salida.modelos.push(...modelosMarca);
  salida.marcas.push({
    id: `ma_${slug(ma.clave)}`,
    nombre: nombreMarca(ma.clave),
    clave: clave(ma.clave),
    busqueda: [...new Set((reglas.busquedaMarcas[ma.clave] ?? '').split(' ').map(clave).filter(Boolean))].join(' ') || null,
    codigos: [...ma.codigos].sort(),
    n: modelosMarca.reduce((s, m) => s + m.n, 0),
  });
}
salida.marcas.sort((a, b) => b.n - a.n);
salida.modelos.sort((a, b) => b.n - a.n);
salida.versiones.sort((a, b) => b.n - a.n);

const sinUsar = [...reglas.compuestas.filter((c) => !usadas.compuestas.has(c)), ...Object.entries(reglas.frasesModelo).flatMap(([m, o]) => Object.keys(o).map((f) => `${m}|${f}`)).filter((c) => !usadas.frases.has(c)), ...Object.keys(reglas.aliasMarcas).filter((c) => !usadas.aliasMarcas.has(c))];
if (sinUsar.length) console.warn('Reglas que no encontraron nada en los datos:', sinUsar.join(', '));

const meta = {
  fuente: 'DNRPA — Inscripciones iniciales de autos',
  url: 'https://datos.jus.gob.ar/dataset/inscripciones-iniciales-de-autos',
  licencia: 'Creative Commons Attribution 4.0 (CC BY 4.0)',
  meses_desde: agregado.meses[0],
  meses_hasta: agregado.meses.at(-1),
  inscripciones: agregado.filas,
  generado: new Date().toISOString().slice(0, 10),
  dataset_modificado: dataset.modificado ?? null,
  min_version: minVersion,
};
const final = { meta, ...salida };
const dir = path.join(ROOT, 'data', 'catalogo-auto');
await fs.mkdir(dir, { recursive: true });
const json = JSON.stringify(final);
await fs.writeFile(path.join(dir, 'catalogo.json.gz'), zlib.gzipSync(json, { level: 9 }));
console.log(`Marcas ${salida.marcas.length}, modelos ${salida.modelos.length}, versiones ${salida.versiones.length} (descartadas por n<${minVersion}: ${verDescartadas}; por tipo: ${descartadasTipo} inscr.; por marca: ${descartadasMarca})`);
console.log(`JSON ${(json.length / 1e6).toFixed(2)} MB → gzip ${(zlib.gzipSync(json, { level: 9 }).length / 1e6).toFixed(2)} MB`);
