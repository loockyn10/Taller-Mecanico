// Checklist de recepción y entrega de vehículos (Sprint 18). Lo comparten el servidor (validación y hash) y la pantalla (formulario, resumen y comparación).
//
// Un "registro" es la recepción o la entrega de una orden de trabajo. Mientras es borrador se puede editar; al confirmarlo queda congelado (el servidor calcula el
// hash del contenido exacto) y desde entonces sólo se puede corregir creando una REVISIÓN que conserva el original. La firma del cliente se guarda aparte y apunta
// a ese hash: así queda registrado qué fue exactamente lo que aceptó.

import { COMBUSTIBLE_NIVELES } from './dominio';

/** Versión del catálogo de puntos de control. Si algún día cambian las secciones o los puntos, se sube este número: los registros viejos conservan el suyo. */
export const CHECKLIST_VERSION = 1;

export const TIPOS_REGISTRO = ['recepcion', 'entrega'] as const;
export type TipoRegistro = (typeof TIPOS_REGISTRO)[number];
export const TIPO_REGISTRO_LABEL: Record<TipoRegistro, string> = { recepcion: 'Recepción', entrega: 'Entrega' };

export const ESTADOS_ITEM = ['correcto', 'con_observaciones', 'no_revisado', 'no_corresponde'] as const;
export type EstadoItem = (typeof ESTADOS_ITEM)[number];
export const ESTADO_ITEM_LABEL: Record<EstadoItem, string> = {
  correcto: 'Correcto',
  con_observaciones: 'Con observaciones',
  no_revisado: 'No revisado',
  no_corresponde: 'No corresponde',
};

export interface SeccionChecklist {
  clave: string;
  titulo: string;
  items: ReadonlyArray<{ clave: string; titulo: string }>;
}

/** Puntos de control. Ninguno es obligatorio: lo que no se toca queda como "No revisado". */
export const SECCIONES_CHECKLIST: readonly SeccionChecklist[] = [
  {
    clave: 'carroceria',
    titulo: 'Carrocería',
    items: [
      { clave: 'frente', titulo: 'Frente (paragolpes, capot, parrilla)' },
      { clave: 'trasera', titulo: 'Parte trasera (paragolpes, baúl o portón)' },
      { clave: 'lateral_izquierdo', titulo: 'Lateral izquierdo' },
      { clave: 'lateral_derecho', titulo: 'Lateral derecho' },
      { clave: 'techo', titulo: 'Techo' },
      { clave: 'pintura', titulo: 'Pintura y brillo en general' },
    ],
  },
  {
    clave: 'cristales',
    titulo: 'Cristales',
    items: [
      { clave: 'parabrisas', titulo: 'Parabrisas' },
      { clave: 'luneta', titulo: 'Luneta' },
      { clave: 'laterales', titulo: 'Cristales laterales' },
      { clave: 'espejos', titulo: 'Espejos' },
    ],
  },
  {
    clave: 'luces',
    titulo: 'Luces',
    items: [
      { clave: 'delanteras', titulo: 'Delanteras' },
      { clave: 'traseras', titulo: 'Traseras' },
      { clave: 'giros', titulo: 'Giros y balizas' },
      { clave: 'stop', titulo: 'Stop / freno' },
    ],
  },
  {
    clave: 'neumaticos',
    titulo: 'Neumáticos',
    items: [
      { clave: 'del_izq', titulo: 'Delantero izquierdo' },
      { clave: 'del_der', titulo: 'Delantero derecho' },
      { clave: 'tras_izq', titulo: 'Trasero izquierdo' },
      { clave: 'tras_der', titulo: 'Trasero derecho' },
      { clave: 'auxilio', titulo: 'Rueda de auxilio' },
    ],
  },
  {
    clave: 'interior',
    titulo: 'Interior',
    items: [
      { clave: 'tapizados', titulo: 'Tapizados y asientos' },
      { clave: 'alfombras', titulo: 'Alfombras y cubre-alfombras' },
      { clave: 'cinturones', titulo: 'Cinturones' },
      { clave: 'comandos', titulo: 'Comandos y botonera' },
    ],
  },
  {
    clave: 'tablero',
    titulo: 'Tablero',
    items: [
      { clave: 'testigos', titulo: 'Testigos encendidos' },
      { clave: 'instrumentos', titulo: 'Instrumentos (velocímetro, nafta, temperatura)' },
      { clave: 'audio', titulo: 'Radio / pantalla' },
      { clave: 'climatizador', titulo: 'Aire acondicionado / calefacción' },
    ],
  },
  {
    clave: 'accesorios',
    titulo: 'Accesorios',
    items: [
      { clave: 'matafuego', titulo: 'Matafuego' },
      { clave: 'balizas', titulo: 'Balizas' },
      { clave: 'criquet', titulo: 'Criquet y llave de ruedas' },
      { clave: 'antena', titulo: 'Antena' },
      { clave: 'tapones', titulo: 'Tapas de rueda / tapón de combustible' },
    ],
  },
];

export const CODIGOS_ITEM: ReadonlySet<string> = new Set(SECCIONES_CHECKLIST.flatMap((s) => s.items.map((i) => `${s.clave}.${i.clave}`)));
export const TOTAL_ITEMS = CODIGOS_ITEM.size;
export const tituloItem = (codigo: string): string => {
  const [s, i] = codigo.split('.');
  const sec = SECCIONES_CHECKLIST.find((x) => x.clave === s);
  return `${sec?.titulo ?? s}: ${sec?.items.find((x) => x.clave === i)?.titulo ?? i}`;
};

/** Sugerencias rápidas para "Elementos y pertenencias" (se pueden agregar otros). */
export const PERTENENCIAS_SUGERIDAS = ['Documentación del vehículo', 'Llave principal', 'Llave de repuesto', 'Matafuego', 'Cargador', 'Anteojos', 'Objetos en la guantera', 'Objetos en el baúl'] as const;

export const ZONAS_DANO = ['frente', 'trasera', 'lateral_izquierdo', 'lateral_derecho', 'techo', 'interior'] as const;
export type ZonaDano = (typeof ZONAS_DANO)[number];
export const ZONA_DANO_LABEL: Record<ZonaDano, string> = {
  frente: 'Frente',
  trasera: 'Parte trasera',
  lateral_izquierdo: 'Lateral izquierdo',
  lateral_derecho: 'Lateral derecho',
  techo: 'Techo',
  interior: 'Interior',
};

export interface Dano {
  /** Identificador estable dentro del registro (lo genera el navegador). */
  id: string;
  zona: ZonaDano;
  /** Posición del marcador sobre el esquema (0–100), opcional. */
  x?: number;
  y?: number;
  descripcion: string;
  /** Ids de fotografías (las mismas del Sprint 16, de esta orden). */
  fotos: string[];
}

export interface ItemChecklist {
  estado: EstadoItem;
  obs?: string;
}

/** Lo que carga la persona (el servidor no le agrega nada: el contexto confirmado va aparte). */
export interface ContenidoChecklist {
  /** Fecha y hora del ingreso o de la entrega (ISO). */
  fecha_hora: string;
  km: number | null;
  combustible: (typeof COMBUSTIBLE_NIVELES)[number] | null;
  llaves: number | null;
  observaciones: string;
  items: Record<string, ItemChecklist>;
  danos: Dano[];
  /** Elementos y pertenencias que el cliente deja (recepción) o se lleva (entrega). */
  pertenencias: Array<{ descripcion: string }>;
  /** Sólo en la entrega: estado general al entregar. */
  estado_general: string;
  /** Sólo en la entrega: trabajos realizados. */
  trabajos: Array<{ descripcion: string }>;
}

export const contenidoVacio = (fechaHoraIso: string): ContenidoChecklist => ({
  fecha_hora: fechaHoraIso,
  km: null,
  combustible: null,
  llaves: null,
  observaciones: '',
  items: {},
  danos: [],
  pertenencias: [],
  estado_general: '',
  trabajos: [],
});

/** Lo que el servidor agrega al confirmar: quién, qué vehículo y qué fotos exactamente quedaron incluidas. Entra en el hash. */
export interface ContextoConfirmado {
  tipo: TipoRegistro;
  revision: number;
  checklist_version: number;
  orden: { id: string; numero: number };
  cliente: { id: string; nombre: string };
  vehiculo: { id: string; patente: string; marca: string | null; modelo: string | null; anio: number | null };
  responsable: { id: string | null; nombre: string };
  fotos: Array<{ id: string; sha256: string; etapa: string | null; tomada_at: string }>;
}

/** JSON canónico (claves ordenadas): el mismo contenido da siempre el mismo texto y, por lo tanto, el mismo hash. */
export function jsonCanonico(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(jsonCanonico).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${jsonCanonico(o[k])}`)
    .join(',')}}`;
}

/** Texto que ve y acepta el cliente al firmar. Queda guardado con la firma, junto con su versión. */
export const TEXTO_CONFORMIDAD_VERSION = 1;
export const textoConformidad = (tipo: TipoRegistro): string =>
  tipo === 'recepcion'
    ? 'Declaro que el estado del vehículo y los elementos que dejo en el taller son los registrados en este resumen.'
    : 'Declaro que recibo el vehículo en el estado registrado en este resumen y los elementos que figuran en él.';
export const AVISO_FIRMA = 'Firma capturada en pantalla como constancia de conformidad. No es una firma digital certificada ni reemplaza una firma legal.';

// ───────────── Progreso y comparación (pantalla) ─────────────

export interface Progreso {
  revisados: number;
  total: number;
  pct: number;
}
export function progresoItems(c: Pick<ContenidoChecklist, 'items'>): Progreso {
  const revisados = Object.entries(c.items).filter(([k, v]) => CODIGOS_ITEM.has(k) && v.estado !== 'no_revisado').length;
  return { revisados, total: TOTAL_ITEMS, pct: Math.round((revisados / TOTAL_ITEMS) * 100) };
}

export interface FilaComparacion {
  codigo: string;
  titulo: string;
  ingreso: ItemChecklist;
  salida: ItemChecklist;
  /** Cambió de estado entre el ingreso y la salida (sólo cuando ambos fueron revisados). */
  cambio: boolean;
}
export interface Comparacion {
  km: { ingreso: number | null; salida: number | null; recorridos: number | null };
  combustible: { ingreso: string | null; salida: string | null };
  llaves: { ingreso: number | null; salida: number | null };
  filas: FilaComparacion[];
  cambios: number;
  danos: { ingreso: Dano[]; salida: Dano[] };
  pertenencias: { ingreso: string[]; salida: string[]; faltan: string[] };
}
const SIN_REVISAR: ItemChecklist = { estado: 'no_revisado' };

/** Compara punto por punto lo registrado al recibir con lo registrado al entregar. No inventa diferencias donde alguno de los dos lados no se revisó. */
export function compararContenidos(ingreso: ContenidoChecklist, salida: ContenidoChecklist): Comparacion {
  const filas: FilaComparacion[] = [];
  for (const sec of SECCIONES_CHECKLIST) {
    for (const it of sec.items) {
      const codigo = `${sec.clave}.${it.clave}`;
      const a = ingreso.items[codigo] ?? SIN_REVISAR;
      const b = salida.items[codigo] ?? SIN_REVISAR;
      const ambos = a.estado !== 'no_revisado' && b.estado !== 'no_revisado';
      filas.push({ codigo, titulo: tituloItem(codigo), ingreso: a, salida: b, cambio: ambos && a.estado !== b.estado });
    }
  }
  const norm = (s: string) => s.trim().toLowerCase();
  const sale = new Set(salida.pertenencias.map((p) => norm(p.descripcion)));
  return {
    km: { ingreso: ingreso.km, salida: salida.km, recorridos: ingreso.km != null && salida.km != null ? salida.km - ingreso.km : null },
    combustible: { ingreso: ingreso.combustible, salida: salida.combustible },
    llaves: { ingreso: ingreso.llaves, salida: salida.llaves },
    filas,
    cambios: filas.filter((f) => f.cambio).length,
    danos: { ingreso: ingreso.danos, salida: salida.danos },
    pertenencias: {
      ingreso: ingreso.pertenencias.map((p) => p.descripcion),
      salida: salida.pertenencias.map((p) => p.descripcion),
      faltan: ingreso.pertenencias.map((p) => p.descripcion).filter((d) => !sale.has(norm(d))),
    },
  };
}

/** Lista, en palabras, lo que cambió entre dos versiones del mismo registro (una revisión frente a su original). Sirve para el historial de modificaciones. */
export function resumenCambios(antes: ContenidoChecklist, despues: ContenidoChecklist): string[] {
  const out: string[] = [];
  const num = (n: number | null) => (n == null ? 'sin dato' : n.toLocaleString('es-AR'));
  if (antes.km !== despues.km) out.push(`Kilometraje: ${num(antes.km)} → ${num(despues.km)}`);
  if (antes.combustible !== despues.combustible) out.push(`Combustible: ${antes.combustible ?? 'sin dato'} → ${despues.combustible ?? 'sin dato'}`);
  if (antes.llaves !== despues.llaves) out.push(`Llaves: ${num(antes.llaves)} → ${num(despues.llaves)}`);
  if (antes.fecha_hora !== despues.fecha_hora) out.push('Fecha y hora del registro');
  if (antes.observaciones.trim() !== despues.observaciones.trim()) out.push('Observaciones generales');
  if (antes.estado_general.trim() !== despues.estado_general.trim()) out.push('Estado general');
  for (const codigo of CODIGOS_ITEM) {
    const a = antes.items[codigo] ?? SIN_REVISAR;
    const b = despues.items[codigo] ?? SIN_REVISAR;
    if (a.estado !== b.estado) out.push(`${tituloItem(codigo)}: ${ESTADO_ITEM_LABEL[a.estado]} → ${ESTADO_ITEM_LABEL[b.estado]}`);
    else if ((a.obs ?? '').trim() !== (b.obs ?? '').trim()) out.push(`${tituloItem(codigo)}: observación modificada`);
  }
  const previos = new Map(antes.danos.map((d) => [d.id, d]));
  const actuales = new Set(despues.danos.map((d) => d.id));
  for (const d of despues.danos) {
    const previo = previos.get(d.id);
    if (!previo) out.push(`Daño agregado (${ZONA_DANO_LABEL[d.zona]}): ${d.descripcion || 'sin descripción'}`);
    else if (previo.descripcion !== d.descripcion || previo.zona !== d.zona || previo.fotos.join() !== d.fotos.join()) out.push(`Daño modificado (${ZONA_DANO_LABEL[d.zona]})`);
  }
  for (const d of antes.danos) if (!actuales.has(d.id)) out.push(`Daño quitado (${ZONA_DANO_LABEL[d.zona]}): ${d.descripcion || 'sin descripción'}`);
  const lista = (x: Array<{ descripcion: string }>) => x.map((p) => p.descripcion.trim().toLowerCase()).sort().join('|');
  if (lista(antes.pertenencias) !== lista(despues.pertenencias)) out.push('Elementos y pertenencias');
  if (lista(antes.trabajos) !== lista(despues.trabajos)) out.push('Trabajos realizados');
  return out;
}
