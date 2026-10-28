// Importación de datos (clientes, vehículos, artículos y proveedores): campos, sugerencia de columnas, lectura de valores y normalización
// de cada fila. Lo usan el navegador (asistente de importación) y el servidor, que vuelve a validar TODO: nada de lo que llega se da por bueno.
import { CONDICIONES_IVA, cuitValido, normalizarPatente, type CondicionIva } from './dominio';

export const TIPOS_IMPORTACION = ['clientes', 'vehiculos', 'articulos', 'proveedores'] as const;
export type TipoImportacion = (typeof TIPOS_IMPORTACION)[number];
export const TIPO_IMPORTACION_LABEL: Record<TipoImportacion, string> = {
  clientes: 'Clientes',
  vehiculos: 'Vehículos',
  articulos: 'Artículos',
  proveedores: 'Proveedores',
};

export const MODOS_IMPORTACION = ['omitir', 'actualizar', 'solo_nuevos'] as const;
export type ModoImportacion = (typeof MODOS_IMPORTACION)[number];
export const MODO_IMPORTACION_LABEL: Record<ModoImportacion, { titulo: string; detalle: string }> = {
  omitir: {
    titulo: 'Omitir duplicados',
    detalle: 'Crea los registros nuevos y deja sin tocar los que ya existen. Las filas sin identificador (por ejemplo, un artículo sin código) se cargan como nuevas.',
  },
  actualizar: {
    titulo: 'Actualizar registros existentes',
    detalle: 'Crea los nuevos y completa o corrige los que ya existen, solo en los campos que cambian y que se muestran antes de confirmar. Una celda vacía nunca borra un dato.',
  },
  solo_nuevos: {
    titulo: 'Importar únicamente nuevos',
    detalle: 'Es la opción más estricta: solo carga filas con un identificador que todavía no existe. Las filas sin identificador se omiten porque no se puede comprobar que sean nuevas.',
  },
};

/** Límites de una importación (también se aplican en el servidor). */
export const LIMITES_IMPORTACION = {
  maxFilas: 5000,
  tamanoLote: 50,
  maxBytesArchivo: 5 * 1024 * 1024,
  maxCelda: 500,
  maxErroresGuardados: 1000,
} as const;

export type Celda = string | number | null | undefined;
export type Valores = Record<string, Celda>;

export interface CampoImportable {
  clave: string;
  etiqueta: string;
  requerido?: boolean;
  /** Identifica al registro para detectar duplicados. */
  identificador?: boolean;
  /** Referencia a otro registro (cliente, proveedor...). */
  referencia?: boolean;
  /** Valor monetario o de costo: exige el permiso de precios correspondiente. */
  sensible?: 'costo' | 'precio';
  ayuda?: string;
  ejemplo: string;
  /** Nombres de columna habituales (se comparan sin tildes ni mayúsculas). */
  alias: string[];
}

const campo = (clave: string, etiqueta: string, ejemplo: string, alias: string[], extra: Partial<CampoImportable> = {}): CampoImportable => ({ clave, etiqueta, ejemplo, alias, ...extra });

export const CAMPOS_IMPORTACION: Record<TipoImportacion, CampoImportable[]> = {
  clientes: [
    campo('nombre', 'Nombre y apellido / razón social', 'Juan Pérez', ['nombre', 'nombre y apellido', 'apellido y nombre', 'razon social', 'cliente', 'denominacion', 'nombre completo', 'apellido nombre'], { requerido: true }),
    campo('documento', 'Documento (DNI o CUIT)', '30123456', ['documento', 'dni', 'cuit', 'cuil', 'cuit/dni', 'dni/cuit', 'nro documento', 'numero documento', 'nro doc', 'doc', 'cuit cuil', 'nro de documento'], {
      identificador: true,
      ayuda: 'Identifica al cliente para no duplicarlo. Si no lo tenés, el cliente se carga igual pero no se pueden detectar repetidos.',
    }),
    campo('documento_tipo', 'Tipo de documento', 'DNI', ['tipo documento', 'tipo de documento', 'tipo doc', 'tipo dni'], { ayuda: 'Opcional: se deduce del número (7-8 dígitos DNI, 11 dígitos CUIT).' }),
    campo('codigo_externo', 'Código del sistema anterior', 'C-0125', ['codigo', 'cod', 'codigo cliente', 'cod cliente', 'id', 'id cliente', 'nro cliente', 'numero cliente', 'codigo anterior', 'legajo'], {
      identificador: true,
      ayuda: 'Sirve para vincular vehículos con sus clientes y para reconocer al cliente en otra importación.',
    }),
    campo('condicion_iva', 'Condición frente al IVA', 'Consumidor final', ['condicion iva', 'condicion frente al iva', 'iva', 'situacion iva', 'cond iva', 'tipo responsable', 'responsable']),
    campo('telefono', 'Teléfono', '11 5555-5555', ['telefono', 'tel', 'celular', 'cel', 'whatsapp', 'movil', 'telefono celular', 'nro telefono']),
    campo('email', 'Email', 'juan@correo.com', ['email', 'e-mail', 'mail', 'correo', 'correo electronico']),
    campo('direccion', 'Dirección', 'Av. Siempreviva 742', ['direccion', 'domicilio', 'calle', 'direccion postal']),
    campo('localidad', 'Localidad', 'Rosario', ['localidad', 'ciudad', 'partido', 'poblacion']),
    campo('notas', 'Notas', '', ['notas', 'observaciones', 'comentarios', 'obs', 'nota']),
  ],
  vehiculos: [
    campo('patente', 'Patente', 'AB123CD', ['patente', 'dominio', 'matricula', 'chapa', 'nro patente'], { requerido: true, identificador: true }),
    campo('cliente_documento', 'Cliente: documento (DNI o CUIT)', '30123456', ['cliente documento', 'documento cliente', 'dni cliente', 'cuit cliente', 'documento', 'dni', 'cuit', 'dni titular', 'documento titular'], {
      referencia: true,
      ayuda: 'Para vincular el vehículo con su cliente. Es la forma más segura.',
    }),
    campo('cliente_codigo', 'Cliente: código del sistema anterior', 'C-0125', ['cliente codigo', 'codigo cliente', 'cod cliente', 'id cliente', 'nro cliente', 'numero cliente', 'cliente id'], {
      referencia: true,
      ayuda: 'Debe coincidir con el "Código del sistema anterior" que cargaste al importar los clientes.',
    }),
    campo('cliente_nombre', 'Cliente: nombre', 'Juan Pérez', ['cliente nombre', 'nombre cliente', 'titular', 'propietario', 'cliente', 'dueno', 'nombre titular'], {
      referencia: true,
      ayuda: 'Solo se usa si no hay documento ni código, y únicamente cuando hay un solo cliente con ese nombre exacto.',
    }),
    campo('marca', 'Marca', 'Volkswagen', ['marca', 'fabricante']),
    campo('modelo', 'Modelo', 'Gol Trend', ['modelo', 'version', 'modelo vehiculo']),
    campo('anio', 'Año', '2016', ['anio', 'ano', 'year', 'modelo ano', 'anio fabricacion']),
    campo('color', 'Color', 'Gris', ['color']),
    campo('vin', 'Chasis / VIN', '', ['vin', 'chasis', 'nro chasis', 'numero chasis', 'chasis vin']),
    campo('motor', 'Motor', '1.6 8v', ['motor', 'nro motor', 'motorizacion', 'numero motor']),
    campo('combustible', 'Combustible', 'Nafta', ['combustible', 'tipo combustible']),
    campo('km', 'Kilometraje', '85000', ['km', 'kilometraje', 'kilometros', 'km actual', 'odometro']),
    campo('notas', 'Notas', '', ['notas', 'observaciones', 'comentarios', 'obs']),
  ],
  articulos: [
    campo('nombre', 'Descripción / nombre', 'Filtro de aceite Mann W712', ['nombre', 'descripcion', 'articulo', 'detalle', 'producto', 'denominacion', 'descripcion articulo'], { requerido: true }),
    campo('codigo', 'Código interno', 'FA-0001', ['codigo', 'cod', 'codigo interno', 'sku', 'codigo articulo', 'cod articulo', 'nro articulo', 'referencia', 'codigo producto'], { identificador: true }),
    campo('codigo_barras', 'Código de barras', '7791234567890', ['codigo de barras', 'codigo barras', 'barras', 'ean', 'ean13', 'upc', 'cod barras', 'codbarra', 'codigo barra'], {
      identificador: true,
      ayuda: 'Si Excel lo muestra como 7,79E+12, formateá la columna como texto antes de guardar el archivo.',
    }),
    campo('marca', 'Marca', 'Mann', ['marca', 'fabricante']),
    campo('categoria', 'Categoría / rubro', 'Filtros', ['categoria', 'rubro', 'familia', 'grupo', 'linea', 'subrubro', 'tipo']),
    campo('unidad', 'Unidad', 'un', ['unidad', 'unidad de medida', 'um', 'u m', 'medida']),
    campo('costo', 'Costo', '8500,00', ['costo', 'precio costo', 'precio de costo', 'costo unitario', 'precio compra', 'compra', 'costo neto'], { sensible: 'costo', ayuda: 'En pesos, sin símbolo.' }),
    campo('precio', 'Precio de venta', '12000,00', ['precio', 'precio venta', 'precio de venta', 'pvp', 'venta', 'precio publico', 'precio lista', 'precio final'], { sensible: 'precio', ayuda: 'En pesos, sin símbolo.' }),
    campo('alicuota_iva', 'IVA (%)', '21', ['iva', 'alicuota', 'alicuota iva', '% iva', 'iva %', 'porcentaje iva']),
    campo('stock_minimo', 'Stock mínimo', '2', ['stock minimo', 'minimo', 'stock min', 'punto de pedido', 'min']),
    campo('stock_objetivo', 'Stock ideal', '10', ['stock ideal', 'stock objetivo', 'objetivo', 'maximo', 'stock maximo', 'max']),
    campo('ubicacion', 'Ubicación', 'Estante B3', ['ubicacion', 'estante', 'deposito ubicacion', 'posicion', 'lugar']),
    campo('proveedor_cuit', 'Proveedor: CUIT', '30-71234567-8', ['proveedor cuit', 'cuit proveedor'], { referencia: true }),
    campo('proveedor_codigo', 'Proveedor: código del sistema anterior', 'P-014', ['proveedor codigo', 'codigo proveedor', 'cod proveedor', 'id proveedor'], { referencia: true }),
    campo('proveedor', 'Proveedor: nombre', 'Repuestos del Sur', ['proveedor', 'proveedor nombre', 'nombre proveedor'], { referencia: true, ayuda: 'Solo se usa si no hay CUIT ni código y hay un único proveedor con ese nombre exacto.' }),
    campo('stock_inicial', 'Existencia actual (carga inicial)', '5', ['stock', 'existencia', 'existencias', 'cantidad', 'stock actual', 'saldo', 'stock inicial', 'cant'], {
      ayuda: 'No se carga por defecto: es un procedimiento aparte que hay que activar y confirmar en el paso de opciones.',
    }),
  ],
  proveedores: [
    campo('nombre', 'Razón social / nombre', 'Repuestos del Sur SA', ['nombre', 'razon social', 'proveedor', 'denominacion', 'nombre proveedor', 'empresa'], { requerido: true }),
    campo('cuit', 'CUIT', '30-71234567-8', ['cuit', 'cuit proveedor', 'documento', 'nro cuit', 'cuit/cuil'], { identificador: true, ayuda: 'Identifica al proveedor para no duplicarlo.' }),
    campo('codigo_externo', 'Código del sistema anterior', 'P-014', ['codigo', 'cod', 'codigo proveedor', 'cod proveedor', 'id', 'id proveedor', 'nro proveedor', 'numero proveedor'], { identificador: true }),
    campo('condicion_iva', 'Condición frente al IVA', 'Responsable inscripto', ['condicion iva', 'condicion frente al iva', 'iva', 'situacion iva', 'cond iva']),
    campo('telefono', 'Teléfono', '11 4444-4444', ['telefono', 'tel', 'celular', 'cel', 'whatsapp']),
    campo('email', 'Email', 'ventas@proveedor.com', ['email', 'e-mail', 'mail', 'correo', 'correo electronico']),
    campo('direccion', 'Dirección', '', ['direccion', 'domicilio', 'calle']),
    campo('notas', 'Notas', '', ['notas', 'observaciones', 'comentarios', 'obs']),
  ],
};

export const camposDe = (tipo: TipoImportacion) => CAMPOS_IMPORTACION[tipo];

// ───────────────────────── Texto y números ─────────────────────────

/** Minúsculas, sin tildes ni signos, espacios simples. */
export const normalizarTextoImport = (s: string | null | undefined): string =>
  (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ')
    .trim();

/** Texto de una celda: números enteros sin decimales, espacios recortados. */
export function texto(c: Celda): string {
  if (c == null) return '';
  if (typeof c === 'number') return Number.isFinite(c) ? (Number.isInteger(c) ? c.toFixed(0) : String(c)) : '';
  return String(c).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Número decimal de una celda. `undefined` = vacía, `NaN` = inválida. Con separador decimal ",": "1.234,56"; con ".": "1,234.56".
 * Los valores con un solo separador seguido de 1-2 dígitos ("1234.5") se leen siempre como decimales: los miles siempre llevan 3 dígitos.
 */
export function parseDecimal(c: Celda, sep: ',' | '.' = ','): number | undefined {
  if (c == null) return undefined;
  if (typeof c === 'number') return Number.isFinite(c) ? c : NaN;
  let s = String(c).replace(/[\s ]/g, '').replace(/^(ARS|AR\$|\$)/i, '').replace(/\$/g, '');
  if (!s) return undefined;
  let neg = false;
  if (/^\(.*\)$/.test(s)) (neg = true), (s = s.slice(1, -1));
  if (s.startsWith('-')) (neg = !neg), (s = s.slice(1));
  if (s.endsWith('%')) s = s.slice(0, -1);
  const miles = sep === ',' ? '.' : ',';
  const cuenta = (ch: string) => s.split(ch).length - 1;
  if (cuenta(sep) === 0 && cuenta(miles) === 1 && /^\d+[.,]\d{1,2}$/.test(s)) s = s.replace(miles, '.');
  else if (sep === ',') s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
  const n = Number(s);
  return neg ? -n : n;
}

/** Centavos a partir de un importe en pesos. */
export function parseCentavos(c: Celda, sep: ',' | '.' = ','): number | undefined {
  const n = parseDecimal(c, sep);
  return n === undefined || Number.isNaN(n) ? n : Math.round(n * 100);
}

/** Entero ("85.000" son 85000 km). `undefined` = vacío, `NaN` = inválido. */
export function parseEntero(c: Celda): number | undefined {
  if (c == null) return undefined;
  if (typeof c === 'number') return Number.isFinite(c) && Math.abs(c - Math.round(c)) < 1e-9 ? Math.round(c) : NaN;
  const s = String(c).replace(/[\s ]/g, '');
  if (!s) return undefined;
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, ''));
  if (/^\d+$/.test(s)) return Number(s);
  if (/^\d+[.,]0+$/.test(s)) return Number(s.replace(/[.,]0+$/, ''));
  return NaN;
}

/** Decide el separador decimal más probable mirando los valores de las columnas numéricas del archivo. */
export function detectarSeparadorDecimal(valores: Celda[]): ',' | '.' {
  let punto = 0;
  let coma = 0;
  for (const v of valores) {
    if (typeof v !== 'string') continue;
    const s = v.replace(/[\s$]/g, '');
    if (/\d\.\d{1,2}$/.test(s) && !s.includes(',')) punto++;
    else if (/\d,\d{1,2}$/.test(s)) coma++;
  }
  return punto > coma ? '.' : ',';
}

const UNIDADES: Record<string, 'un' | 'lt' | 'kg' | 'm' | 'juego'> = {
  un: 'un', u: 'un', unidad: 'un', unidades: 'un', uni: 'un', unid: 'un', pza: 'un', pieza: 'un', piezas: 'un', par: 'un', pares: 'un', c: 'un',
  lt: 'lt', lts: 'lt', l: 'lt', litro: 'lt', litros: 'lt', lit: 'lt',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogramo: 'kg', kilogramos: 'kg',
  m: 'm', mt: 'm', mts: 'm', metro: 'm', metros: 'm',
  juego: 'juego', juegos: 'juego', jgo: 'juego', jgos: 'juego', kit: 'juego', kits: 'juego', set: 'juego',
};
export function interpretarUnidad(t: string): 'un' | 'lt' | 'kg' | 'm' | 'juego' | null {
  return UNIDADES[normalizarTextoImport(t)] ?? null;
}

const ALICUOTAS = [0, 2.5, 5, 10.5, 21, 27];

export function interpretarCondicionIva(t: string): CondicionIva | null {
  const n = normalizarTextoImport(t);
  if (!n) return null;
  if (n === 'ri' || n.includes('inscripto') && !n.includes('no inscripto')) return 'responsable_inscripto';
  if (n.includes('monotrib') || n === 'mt' || n === 'rm') return 'monotributo';
  if (n.includes('exento') || n === 'ex') return 'exento';
  if (n.includes('consumidor') || n === 'cf' || n === 'final' || n.includes('no inscripto') || n === 'rni') return 'consumidor_final';
  return null;
}

// ───────────────────────── Documentos ─────────────────────────

export type TipoDocumento = 'DNI' | 'CUIT' | 'CUIL' | 'OTRO';

/** ¿Es un documento "de relleno" (todo ceros, todo unos...)? Los sistemas viejos lo usan para el consumidor final: no identifica a nadie. */
export const documentoGenerico = (digitos: string): boolean => digitos.length > 0 && /^(\d)\1*$/.test(digitos);

export const formatearCuit = (d: string): string => `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`;

/** Clave de comparación de un documento (solo letras y números, en mayúsculas). */
export const claveDocumento = (raw: string): string => raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

export type DocumentoInterpretado = { tipo: TipoDocumento; valor: string; clave: string; aviso?: string } | { error: string } | null;

export function interpretarDocumento(rawIn: Celda, tipoIn?: Celda): DocumentoInterpretado {
  const raw = texto(rawIn);
  if (!raw) return null;
  const tipoTxt = normalizarTextoImport(texto(tipoIn));
  const tipoPedido: TipoDocumento | null = tipoTxt.includes('cuit') ? 'CUIT' : tipoTxt.includes('cuil') ? 'CUIL' : tipoTxt === 'dni' || tipoTxt.includes('documento nacional') ? 'DNI' : tipoTxt ? 'OTRO' : null;
  if (tipoPedido === 'OTRO') {
    const v = claveDocumento(raw);
    if (v.length < 3 || v.length > 20) return { error: 'Documento inválido (entre 3 y 20 caracteres)' };
    return { tipo: 'OTRO', valor: v, clave: v };
  }
  const d = raw.replace(/\D/g, '');
  if (!d) return { error: `Documento "${raw}" sin dígitos` };
  if (documentoGenerico(d)) return null;
  if (d.length === 11) {
    if (!cuitValido(d)) return { error: `CUIT/CUIL ${raw} inválido (el dígito verificador no coincide)` };
    return { tipo: tipoPedido === 'CUIL' ? 'CUIL' : 'CUIT', valor: formatearCuit(d), clave: d };
  }
  if (d.length >= 6 && d.length <= 8) {
    if (tipoPedido === 'CUIT' || tipoPedido === 'CUIL') return { error: `${tipoPedido} ${raw} inválido (tiene que tener 11 dígitos)` };
    return { tipo: 'DNI', valor: d, clave: d };
  }
  return { error: `Documento "${raw}" no reconocido: un DNI tiene 7 u 8 dígitos y un CUIT 11` };
}

// ───────────────────────── Sugerencia de columnas ─────────────────────────

/**
 * Para cada campo de ORVELAN propone la columna del archivo que mejor le corresponde (índice) o null. Cada columna se usa una sola vez;
 * primero se asignan las coincidencias exactas con un nombre habitual y después las parciales.
 */
export function sugerirMapeo(tipo: TipoImportacion, columnas: string[]): Record<string, number | null> {
  const cols = columnas.map((c) => normalizarTextoImport(c));
  const campos = camposDe(tipo);
  const res: Record<string, number | null> = Object.fromEntries(campos.map((c) => [c.clave, null]));
  const usada = new Set<number>();
  const asignar = (coincide: (alias: string, col: string, clave: string) => boolean) => {
    for (const c of campos) {
      if (res[c.clave] !== null) continue;
      const alias = [normalizarTextoImport(c.etiqueta), normalizarTextoImport(c.clave), ...c.alias.map(normalizarTextoImport)];
      const i = cols.findIndex((col, idx) => col && !usada.has(idx) && alias.some((a) => coincide(a, col, c.clave)));
      if (i >= 0) {
        res[c.clave] = i;
        usada.add(i);
      }
    }
  };
  asignar((a, col) => a === col);
  asignar((a, col, clave) => a.length >= 4 && (col.includes(a) || (col.length >= 4 && a.includes(col))) && !(clave === 'codigo' && col.includes('barra')));
  return res;
}

// ───────────────────────── Normalización de filas ─────────────────────────

export interface OpcionesFila {
  decimal: ',' | '.';
}

export interface FilaNormalizada<D> {
  /** Solo los campos con valor: una celda vacía nunca pisa un dato existente. */
  datos: D;
  errores: string[];
  avisos: string[];
  /** Texto corto para identificar la fila en los informes (sin datos sensibles). */
  ref: string;
}

export interface ReferenciaCliente { documento?: string; codigo?: string; nombre?: string }
export interface ReferenciaProveedor { cuit?: string; codigo?: string; nombre?: string }

export interface DatosCliente {
  nombre?: string;
  documento_tipo?: TipoDocumento;
  documento?: string;
  /** Clave de comparación del documento. */
  documento_clave?: string;
  codigo_externo?: string;
  condicion_iva?: CondicionIva;
  telefono?: string;
  email?: string;
  direccion?: string;
  localidad?: string;
  notas?: string;
}
export interface DatosProveedor {
  nombre?: string;
  cuit?: string;
  cuit_clave?: string;
  codigo_externo?: string;
  condicion_iva?: CondicionIva;
  telefono?: string;
  email?: string;
  direccion?: string;
  notas?: string;
}
export interface DatosVehiculo {
  patente?: string;
  cliente_ref?: ReferenciaCliente;
  marca?: string;
  modelo?: string;
  anio?: number;
  color?: string;
  vin?: string;
  motor?: string;
  combustible?: string;
  km?: number;
  notas?: string;
}
export interface DatosArticulo {
  nombre?: string;
  codigo?: string;
  codigo_barras?: string;
  marca?: string;
  categoria?: string;
  unidad?: 'un' | 'lt' | 'kg' | 'm' | 'juego';
  costo?: number;
  precio?: number;
  alicuota_iva?: number;
  stock_minimo?: number;
  stock_objetivo?: number;
  ubicacion?: string;
  proveedor_ref?: ReferenciaProveedor;
  stock_inicial?: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

class Acumulador {
  errores: string[] = [];
  avisos: string[] = [];
  constructor(private v: Valores) {}
  raw(k: string): Celda { return this.v[k]; }
  txt(k: string, max: number, etiqueta: string): string | undefined {
    const t = texto(this.v[k]);
    if (!t) return undefined;
    if (t.length > max) {
      this.errores.push(`${etiqueta}: demasiado largo (máximo ${max} caracteres)`);
      return undefined;
    }
    return t;
  }
  email(k: string): string | undefined {
    const t = texto(this.v[k]);
    if (!t) return undefined;
    if (t.length > 120 || !EMAIL_RE.test(t)) {
      this.errores.push(`Email inválido: "${t.slice(0, 40)}"`);
      return undefined;
    }
    return t.toLowerCase();
  }
  codigo(k: string, etiqueta: string): string | undefined {
    const t = texto(this.v[k]).replace(/\s+/g, '');
    if (!t) return undefined;
    if (/^\d(\.\d+)?e\+\d+$/i.test(t)) {
      this.errores.push(`${etiqueta} "${t}" está en notación científica: Excel lo deformó. Guardá esa columna como texto`);
      return undefined;
    }
    if (t.length > 60) {
      this.errores.push(`${etiqueta}: demasiado largo (máximo 60 caracteres)`);
      return undefined;
    }
    return t;
  }
}

/** Quita las claves sin valor para que el resultado solo tenga lo que el archivo realmente aporta. */
function compacto<T extends object>(o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] === undefined) delete o[k];
  return o;
}

const corto = (s: string | undefined, n = 60) => (s ?? '').slice(0, n);

export function normalizarCliente(v: Valores): FilaNormalizada<DatosCliente> {
  const a = new Acumulador(v);
  const d: DatosCliente = {};
  d.nombre = a.txt('nombre', 160, 'Nombre');
  if (!d.nombre) a.errores.push('Falta el nombre');
  else if (d.nombre.length < 2) a.errores.push('El nombre es demasiado corto (mínimo 2 caracteres)');
  const doc = interpretarDocumento(v.documento, v.documento_tipo);
  if (doc && 'error' in doc) a.errores.push(doc.error);
  else if (doc) (d.documento_tipo = doc.tipo), (d.documento = doc.valor), (d.documento_clave = doc.clave);
  else if (texto(v.documento)) a.avisos.push('Documento genérico (ceros o repetido): se ignora');
  d.codigo_externo = a.codigo('codigo_externo', 'Código del sistema anterior');
  const iva = texto(v.condicion_iva);
  if (iva) {
    const ci = interpretarCondicionIva(iva);
    if (ci) d.condicion_iva = ci;
    else a.errores.push(`Condición frente al IVA no reconocida: "${corto(iva, 30)}" (usá consumidor final, monotributo, responsable inscripto o exento)`);
  }
  d.telefono = a.txt('telefono', 40, 'Teléfono');
  d.email = a.email('email');
  d.direccion = a.txt('direccion', 200, 'Dirección');
  d.localidad = a.txt('localidad', 120, 'Localidad');
  d.notas = a.txt('notas', 1000, 'Notas');
  return { datos: compacto(d), errores: a.errores, avisos: a.avisos, ref: corto(d.nombre) };
}

export function normalizarProveedor(v: Valores): FilaNormalizada<DatosProveedor> {
  const a = new Acumulador(v);
  const d: DatosProveedor = {};
  d.nombre = a.txt('nombre', 160, 'Nombre');
  if (!d.nombre) a.errores.push('Falta el nombre');
  else if (d.nombre.length < 2) a.errores.push('El nombre es demasiado corto (mínimo 2 caracteres)');
  const cuitTxt = texto(v.cuit);
  if (cuitTxt) {
    const dig = cuitTxt.replace(/\D/g, '');
    if (documentoGenerico(dig)) a.avisos.push('CUIT genérico (ceros o repetido): se ignora');
    else if (dig.length !== 11 || !cuitValido(dig)) a.errores.push(`CUIT "${corto(cuitTxt, 20)}" inválido (11 dígitos con dígito verificador correcto)`);
    else (d.cuit = formatearCuit(dig)), (d.cuit_clave = dig);
  }
  d.codigo_externo = a.codigo('codigo_externo', 'Código del sistema anterior');
  const iva = texto(v.condicion_iva);
  if (iva) {
    const ci = interpretarCondicionIva(iva);
    if (ci) d.condicion_iva = ci;
    else a.errores.push(`Condición frente al IVA no reconocida: "${corto(iva, 30)}"`);
  }
  d.telefono = a.txt('telefono', 40, 'Teléfono');
  d.email = a.email('email');
  d.direccion = a.txt('direccion', 200, 'Dirección');
  d.notas = a.txt('notas', 1000, 'Notas');
  return { datos: compacto(d), errores: a.errores, avisos: a.avisos, ref: corto(d.nombre) };
}

export function normalizarVehiculo(v: Valores, anioMaximo: number): FilaNormalizada<DatosVehiculo> {
  const a = new Acumulador(v);
  const d: DatosVehiculo = {};
  const patenteTxt = texto(v.patente);
  if (!patenteTxt) a.errores.push('Falta la patente');
  else {
    const p = normalizarPatente(patenteTxt);
    if (!/^[A-Z0-9]{5,8}$/.test(p) || !/[A-Z]/.test(p) || !/\d/.test(p)) a.errores.push(`Patente "${corto(patenteTxt, 15)}" inválida (formato como ABC123 o AB123CD)`);
    else d.patente = p;
  }
  // Referencia al cliente: nunca por nombre "parecido". Los documentos genéricos no identifican a nadie.
  const ref: ReferenciaCliente = {};
  const docTxt = texto(v.cliente_documento);
  if (docTxt) {
    const clave = claveDocumento(docTxt);
    if (!clave) a.errores.push('Documento del cliente inválido');
    else if (!documentoGenerico(clave)) ref.documento = clave;
  }
  const cod = a.codigo('cliente_codigo', 'Código de cliente');
  if (cod) ref.codigo = cod;
  const nom = a.txt('cliente_nombre', 160, 'Nombre del cliente');
  if (nom) ref.nombre = nom;
  // El cliente es opcional: un vehículo puede importarse sin clientes vinculados. Si el archivo trae una referencia, tiene que poder resolverse.
  if (ref.documento || ref.codigo || ref.nombre) d.cliente_ref = ref;
  d.marca = a.txt('marca', 60, 'Marca');
  d.modelo = a.txt('modelo', 80, 'Modelo');
  if (d.modelo && !d.marca) a.errores.push('Hay modelo pero falta la marca');
  const anio = parseEntero(v.anio);
  if (anio !== undefined) {
    if (Number.isNaN(anio) || anio < 1930 || anio > anioMaximo) a.errores.push(`Año inválido: "${corto(texto(v.anio), 10)}" (entre 1930 y ${anioMaximo})`);
    else d.anio = anio;
  }
  d.color = a.txt('color', 40, 'Color');
  const vin = a.txt('vin', 40, 'Chasis/VIN');
  if (vin) d.vin = vin.toUpperCase();
  d.motor = a.txt('motor', 60, 'Motor');
  d.combustible = a.txt('combustible', 30, 'Combustible');
  const km = parseEntero(v.km);
  if (km !== undefined) {
    if (Number.isNaN(km) || km < 0 || km > 5_000_000) a.errores.push(`Kilometraje inválido: "${corto(texto(v.km), 12)}"`);
    else d.km = km;
  }
  d.notas = a.txt('notas', 1000, 'Notas');
  return { datos: compacto(d), errores: a.errores, avisos: a.avisos, ref: corto(d.patente ?? patenteTxt) };
}

export function normalizarArticulo(v: Valores, op: OpcionesFila): FilaNormalizada<DatosArticulo> {
  const a = new Acumulador(v);
  const d: DatosArticulo = {};
  d.nombre = a.txt('nombre', 200, 'Descripción');
  if (!d.nombre) a.errores.push('Falta la descripción del artículo');
  else if (d.nombre.length < 2) a.errores.push('La descripción es demasiado corta (mínimo 2 caracteres)');
  d.codigo = a.codigo('codigo', 'Código');
  d.codigo_barras = a.codigo('codigo_barras', 'Código de barras');
  d.marca = a.txt('marca', 80, 'Marca');
  d.categoria = a.txt('categoria', 80, 'Categoría');
  const un = texto(v.unidad);
  if (un) {
    const u = interpretarUnidad(un);
    if (u) d.unidad = u;
    else a.errores.push(`Unidad no reconocida: "${corto(un, 20)}" (usá unidad, litro, kg, metro o juego)`);
  }
  const dinero = (k: 'costo' | 'precio', etiqueta: string) => {
    const n = parseCentavos(v[k], op.decimal);
    if (n === undefined) return;
    if (Number.isNaN(n) || n < 0 || n > 1e13) a.errores.push(`${etiqueta} inválido: "${corto(texto(v[k]), 20)}"`);
    else d[k] = n;
  };
  dinero('costo', 'Costo');
  dinero('precio', 'Precio de venta');
  const iva = parseDecimal(v.alicuota_iva, op.decimal);
  if (iva !== undefined) {
    if (Number.isNaN(iva) || !ALICUOTAS.includes(iva)) a.errores.push(`IVA inválido: "${corto(texto(v.alicuota_iva), 10)}" (0, 2,5, 5, 10,5, 21 o 27)`);
    else d.alicuota_iva = iva;
  }
  const cantidad = (k: 'stock_minimo' | 'stock_objetivo' | 'stock_inicial', etiqueta: string) => {
    const n = parseDecimal(v[k], op.decimal);
    if (n === undefined) return;
    if (Number.isNaN(n) || n < 0 || n > 1e9 || Math.abs(n * 1000 - Math.round(n * 1000)) > 1e-6) a.errores.push(`${etiqueta} inválido: "${corto(texto(v[k]), 15)}" (cantidad positiva con hasta 3 decimales)`);
    else d[k] = Math.round(n * 1000) / 1000;
  };
  cantidad('stock_minimo', 'Stock mínimo');
  cantidad('stock_objetivo', 'Stock ideal');
  cantidad('stock_inicial', 'Existencia');
  if (d.stock_objetivo != null && d.stock_minimo != null && d.stock_objetivo < d.stock_minimo) a.errores.push('El stock ideal no puede ser menor al mínimo');
  d.ubicacion = a.txt('ubicacion', 80, 'Ubicación');
  const ref: ReferenciaProveedor = {};
  const cuitTxt = texto(v.proveedor_cuit);
  if (cuitTxt) {
    const dig = cuitTxt.replace(/\D/g, '');
    if (dig.length !== 11 || !cuitValido(dig)) a.errores.push(`CUIT del proveedor "${corto(cuitTxt, 20)}" inválido`);
    else ref.cuit = dig;
  }
  const pc = a.codigo('proveedor_codigo', 'Código de proveedor');
  if (pc) ref.codigo = pc;
  const pn = a.txt('proveedor', 160, 'Proveedor');
  if (pn) ref.nombre = pn;
  if (ref.cuit || ref.codigo || ref.nombre) d.proveedor_ref = ref;
  return { datos: compacto(d), errores: a.errores, avisos: a.avisos, ref: corto(d.codigo ?? d.nombre ?? '') };
}

// ───────────────────────── Identificadores y referencias ─────────────────────────

/**
 * Claves con las que se reconoce a un registro (dos filas con alguna clave en común son el mismo registro). Los nombres comerciales
 * NUNCA son una clave: dos personas pueden llamarse igual.
 */
export function clavesDeFila(tipo: TipoImportacion, datos: DatosCliente | DatosProveedor | DatosVehiculo | DatosArticulo): string[] {
  const k: string[] = [];
  if (tipo === 'clientes') {
    const d = datos as DatosCliente;
    if (d.documento_clave) k.push(`d:${d.documento_clave}`);
    if (d.codigo_externo) k.push(`c:${d.codigo_externo.toLowerCase()}`);
  } else if (tipo === 'proveedores') {
    const d = datos as DatosProveedor;
    if (d.cuit_clave) k.push(`t:${d.cuit_clave}`);
    if (d.codigo_externo) k.push(`c:${d.codigo_externo.toLowerCase()}`);
  } else if (tipo === 'vehiculos') {
    const d = datos as DatosVehiculo;
    if (d.patente) k.push(`p:${d.patente}`);
  } else {
    const d = datos as DatosArticulo;
    if (d.codigo) k.push(`c:${d.codigo.toLowerCase()}`);
    if (d.codigo_barras) k.push(`b:${d.codigo_barras.toLowerCase()}`);
  }
  return k;
}

/** Clave estable de una referencia a otro registro (sirve para agrupar los pendientes y para guardar la resolución elegida). */
export function claveReferenciaCliente(r: ReferenciaCliente): string {
  return r.documento ? `doc:${r.documento}` : r.codigo ? `cod:${r.codigo.toLowerCase()}` : `nom:${normalizarTextoImport(r.nombre)}`;
}
export function claveReferenciaProveedor(r: ReferenciaProveedor): string {
  return r.cuit ? `cuit:${r.cuit}` : r.codigo ? `cod:${r.codigo.toLowerCase()}` : `nom:${normalizarTextoImport(r.nombre)}`;
}

export const CONDICIONES_IVA_IMPORT = CONDICIONES_IVA;

// ───────────────────────── Resultado de una fila ─────────────────────────

export type AccionFila = 'crear' | 'actualizar' | 'omitir' | 'error';

export interface CambioCampo {
  campo: string;
  antes: string | null;
  despues: string | null;
}

export interface ResultadoFila {
  /** Número de fila en el archivo (la primera fila de datos es la 2 si el archivo tiene encabezados). */
  n: number;
  accion: AccionFila;
  ref: string;
  errores: string[];
  avisos: string[];
  /** Por qué se omite (duplicado, sin cambios...). */
  motivo?: string;
  cambios?: CambioCampo[];
  /** Referencia que no se pudo resolver: el asistente permite elegir a qué registro corresponde. */
  pendiente?: { tipo: 'cliente' | 'proveedor'; clave: string; etiqueta: string; motivo: 'inexistente' | 'ambiguo' };
  /** Categorías, marcas o modelos que se crearían con esta fila. */
  nuevos?: string[];
}

export interface ResumenLote {
  filas: number;
  crear: number;
  actualizar: number;
  omitir: number;
  error: number;
}
export const resumir = (r: ResultadoFila[]): ResumenLote => ({
  filas: r.length,
  crear: r.filter((x) => x.accion === 'crear').length,
  actualizar: r.filter((x) => x.accion === 'actualizar').length,
  omitir: r.filter((x) => x.accion === 'omitir').length,
  error: r.filter((x) => x.accion === 'error').length,
});

/** Nombres de las columnas de un archivo de ejemplo del tipo indicado (para descargar una plantilla). */
export const encabezadosEjemplo = (tipo: TipoImportacion): string[] => camposDe(tipo).map((c) => c.etiqueta);
export const filaEjemplo = (tipo: TipoImportacion): string[] => camposDe(tipo).map((c) => c.ejemplo);
