// Hoja de la orden de trabajo en PDF (A4 vertical, pensada para imprimir en blanco y negro).
//
// Una sola máquina de maquetación (`generarHojaOrden`) y una definición por variante (`VARIANTES`): qué secciones lleva, en qué orden, cómo se rotula y
// qué permiso exige. Cambiar el contenido de la copia del mecánico o de la copia de administración es editar SU definición, sin tocar el dibujo.
//
// Regla de datos: este módulo sólo recibe `DatosHoja`, que contiene datos operativos (nunca precios, costos, márgenes, totales ni notas internas).
// Privacidad: la copia del MECÁNICO nunca lleva datos personales del cliente (nombre, teléfono, etc.), sin importar quién la imprima: depende del tipo de
// documento (`DefVariante.datosCliente`) y no del rol de quien la genera. Sólo la copia de administración muestra al cliente (y únicamente con permiso).
// Una variante que algún día necesite importes tendrá que sumarlos a `DatosHoja` desde `hoja-orden-datos.ts` exigiendo los permisos de valorización.
import type { Permiso } from '../../shared/permisos';
import { Documento, MM, type ImagenJpeg, type Pagina } from './pdf/escritor';
import { anchoTexto, envolver, recortar, type Fuente } from './pdf/metricas';
import { dineroAR } from '../../shared/pago-portal';

// ───────────────────────── Datos ─────────────────────────

export interface DatosHoja {
  taller: { nombre: string; razonSocial: string | null; direccion: string | null; telefono: string | null; email: string | null };
  /** JPEG del logo del taller, si lo tiene cargado en ese formato. */
  logo: Uint8Array | null;
  /** JPEG (miniatura) de la fotografía del vehículo, si tiene alguna a la que quien imprime pueda acceder. */
  foto?: Uint8Array | null;
  orden: { numero: number; fechaApertura: string; fechaPrometida: string | null };
  /** Cliente responsable de la orden. Sólo se lee cuando se pide una copia que lo muestra y la sesión puede ver clientes; si no, llega vacío. */
  cliente: { visible: boolean; nombre: string | null; telefono: string | null };
  vehiculo: { patente: string; marca: string | null; modelo: string | null; anio: number | null; km: number | null };
  tecnico: { responsable: string | null; participantes: string[] };
  motivo: string | null;
  diagnostico: string | null;
  observaciones: string | null;
  trabajos: Array<{ descripcion: string; cantidad: number }>;
  repuestos: Array<{ descripcion: string; cantidad: number; unidad: string | null }>;
  /**
   * Pago del cliente (medio elegido, estado y saldo). Sólo lo llevan las copias con `datosPago` y sólo se lee con permiso de ver ventas: la copia del mecánico
   * nunca lo recibe, quien la imprima. Sin elección ni comprobantes (o sin importe informado) llega vacío y la copia no dibuja la sección.
   */
  pago?: { medio: string | null; estado: string; saldo: number | null } | null;
  zonaHoraria: string;
  impresoAt: Date;
}

// ───────────────────────── Variantes ─────────────────────────

export type VarianteId = 'mecanico' | 'administracion';
export type SeccionId = 'identidad' | 'datos' | 'motivo' | 'trabajos' | 'repuestos' | 'diagnostico' | 'observaciones' | 'pago';

export interface DefVariante {
  id: VarianteId;
  /** Texto que identifica la copia en el recuadro del encabezado y en el pie de cada hoja. */
  rotulo: string;
  /** Parte del nombre del archivo. */
  archivo: string;
  /** Permisos que exige imprimir esta variante (además de poder ver la orden). */
  permisos: readonly Permiso[];
  /** Secciones, en orden de aparición. */
  secciones: readonly SeccionId[];
  /** Zona de renglones para escribir a mano; `null` si la variante no la lleva. */
  anotaciones: { titulo: string } | null;
  /** Si la copia muestra los datos del cliente. La del mecánico nunca (privacidad por tipo de documento, no por quién imprime). */
  datosCliente: boolean;
  /** Si la copia muestra el pago del cliente (sólo administración; la del mecánico nunca lleva información financiera). */
  datosPago: boolean;
}

/**
 * Variantes de la hoja. Hoy comparten los mismos datos operativos básicos (el cliente piloto todavía no confirmó qué necesita administración);
 * cada una tiene su propia lista de secciones para poder diferenciarlas sin reescribir nada.
 */
export const VARIANTES: Record<VarianteId, DefVariante> = {
  mecanico: {
    id: 'mecanico',
    rotulo: 'COPIA MECÁNICO',
    archivo: 'mecanico',
    permisos: ['ordenes.imprimir'],
    secciones: ['identidad', 'datos', 'motivo', 'trabajos', 'repuestos', 'diagnostico', 'observaciones'],
    anotaciones: { titulo: 'ANOTACIONES DEL MECÁNICO' },
    datosCliente: false,
    datosPago: false,
  },
  administracion: {
    id: 'administracion',
    rotulo: 'COPIA ADMINISTRACIÓN',
    archivo: 'administracion',
    permisos: ['ordenes.imprimir', 'ordenes.imprimir_administracion'],
    secciones: ['identidad', 'datos', 'motivo', 'trabajos', 'repuestos', 'diagnostico', 'observaciones', 'pago'],
    anotaciones: { titulo: 'ANOTACIONES DEL MECÁNICO' },
    datosCliente: true,
    datosPago: true,
  },
};

export const COPIAS = ['mecanico', 'administracion', 'ambas'] as const;
export type Copia = (typeof COPIAS)[number];
export const variantesDeCopia = (c: Copia): VarianteId[] => (c === 'ambas' ? ['mecanico', 'administracion'] : [c]);
/** Alguna de las variantes pedidas muestra al cliente: sólo entonces hace falta leer sus datos. */
export const muestraCliente = (variantes: VarianteId[]) => variantes.some((id) => VARIANTES[id].datosCliente);

// ───────────────────────── Medidas (mm) ─────────────────────────

export const PAGINA = {
  izq: 15,
  der: 195,
  arriba: 10,
  /** Último punto donde puede llegar el contenido (deja libre el pie y el margen de impresión). */
  limite: 283,
  /** Las anotaciones manuscritas ocupan desde acá hasta el límite: ~47 % de la hoja A4. */
  anotacionesDesde: 145,
  paso: 9,
} as const;
const ANCHO = PAGINA.der - PAGINA.izq;
const pt = (mm: number) => mm * MM;
const MM_PT = 25.4 / 72;
const interlineado = (tam: number) => tam * MM_PT * 1.38;
const linea = (y: number, tam: number) => y + tam * MM_PT * 0.82;
const GRIS_ROTULO = 0.38;

// ───────────────────────── Formato ─────────────────────────

function partesZona(instante: Date, tz: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instante)) o[p.type] = p.value;
  return o;
}
export function fechaHoraLocal(iso: string | Date, tz: string): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '—';
  const p = partesZona(d, tz);
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}
function fechaLocalTexto(iso: string, tz: string): string {
  // Las fechas sin hora (AAAA-MM-DD) se muestran tal cual, sin pasarlas por la zona horaria.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  return fechaHoraLocal(iso, tz).slice(0, 10);
}
const miles = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
export const cantidadTexto = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace('.', ','));
export const numeroOrden = (n: number) => String(n).padStart(4, '0');

// ───────────────────────── Elementos y paginación ─────────────────────────

/** Pieza indivisible de contenido: nunca se corta entre dos hojas. */
interface Elemento {
  alto: number;
  dibujar(p: Pagina, y: number): void;
  /** Debe quedar en la misma hoja que el elemento que le sigue (títulos y encabezados de tabla). */
  pegado?: boolean;
  /** Si este elemento abre una hoja de continuación, se repiten antes estos (título y encabezado de su tabla). */
  continuacion?: Elemento[];
  /** Espacio en blanco: no cuenta como contenido al decidir dónde terminó la hoja. */
  blando?: boolean;
}

interface Contexto {
  d: DatosHoja;
  v: DefVariante;
  logo: ImagenJpeg | null;
  foto: ImagenJpeg | null;
}

const separador = (alto = 2.2): Elemento => ({ alto, blando: true, dibujar: () => undefined });

function tituloSeccion(texto: string, cont = false): Elemento {
  return {
    alto: 6.6,
    pegado: true,
    dibujar: (p, y) => {
      p.texto(PAGINA.izq, linea(y + 0.7, 9), cont ? `${texto} (continuación)` : texto, { fuente: 'negrita', tam: 9 });
      p.linea(PAGINA.izq, y + 5, PAGINA.der, y + 5, { ancho: 0.5 });
    },
  };
}

function parrafo(texto: string, tam = 9.5): Elemento[] {
  const lh = interlineado(tam);
  return envolver(texto, 'normal', tam, pt(ANCHO)).map((t) => ({ alto: lh, dibujar: (p: Pagina, y: number) => p.texto(PAGINA.izq, linea(y, tam), t, { tam }) }));
}

function sinDato(texto: string): Elemento {
  return { alto: interlineado(9.5) + 1, dibujar: (p, y) => p.texto(PAGINA.izq, linea(y, 9.5), texto, { tam: 9.5, gris: 0.4 }) };
}

// Columnas de las tablas (mm)
const COL = { num: PAGINA.izq, desc: PAGINA.izq + 9, cant: 168, hecho: 187 };

function encabezadoTabla(conHecho: boolean): Elemento {
  return {
    alto: 5,
    pegado: true,
    dibujar: (p, y) => {
      const b = linea(y + 0.5, 7.5);
      const e = { fuente: 'negrita' as Fuente, tam: 7.5, gris: GRIS_ROTULO };
      if (conHecho) p.texto(COL.num, b, 'N°', e);
      p.texto(conHecho ? COL.desc : COL.num, b, 'DESCRIPCIÓN', e);
      p.texto(COL.cant - anchoTexto('CANT.', 'negrita', 7.5) * MM_PT, b, 'CANT.', e);
      if (conHecho) p.texto(COL.hecho + 2.2 - (anchoTexto('HECHO', 'negrita', 7.5) * MM_PT) / 2, b, 'HECHO', e);
      p.linea(PAGINA.izq, y + 4.4, PAGINA.der, y + 4.4, { ancho: 0.3 });
    },
  };
}

function filaTabla(n: number | null, descripcion: string, cantidad: string, conHecho: boolean, continuacion: Elemento[]): Elemento {
  const tam = 9.5;
  const x0 = conHecho ? COL.desc : COL.num;
  const lineas = envolver(descripcion, 'normal', tam, pt(COL.cant - 16 - x0));
  const lh = interlineado(tam);
  const alto = Math.max(1.1 + lineas.length * lh + 1.1, 6.3);
  return {
    alto,
    continuacion,
    dibujar: (p, y) => {
      const b = linea(y + 1.1, tam);
      if (n !== null) p.texto(COL.num, b, `${n}.`, { tam });
      lineas.forEach((t, i) => p.texto(x0, b + i * lh, t, { tam }));
      p.texto(COL.cant - anchoTexto(cantidad, 'normal', tam) * MM_PT, b, cantidad, { tam });
      if (conHecho) p.rect(COL.hecho, y + (alto - 4.2) / 2, 4.2, 4.2, { ancho: 0.45 });
      p.linea(PAGINA.izq, y + alto, PAGINA.der, y + alto, { ancho: 0.15, gris: 0.55 });
    },
  };
}

// ── Identidad y datos de la orden ──

function seccionIdentidad({ d, v, logo }: Contexto): Elemento[] {
  const T = d.taller;
  const xBox = 128;
  const wBox = PAGINA.der - xBox;
  let xTexto = PAGINA.izq;
  const bloque: Array<{ t: string; f: Fuente; tam: number; gris: number }> = [];
  let anchoLogo = 0;
  let altoLogo = 0;
  if (logo) {
    const escala = Math.min(40 / logo.ancho, 16 / logo.alto);
    anchoLogo = logo.ancho * escala;
    altoLogo = logo.alto * escala;
    xTexto = PAGINA.izq + anchoLogo + 4;
  }
  const maxTexto = pt(xBox - 6 - xTexto);
  for (const t of envolver(T.nombre, 'negrita', 15, maxTexto).slice(0, 2)) bloque.push({ t, f: 'negrita', tam: 15, gris: 0 });
  if (T.razonSocial && T.razonSocial.trim().toLowerCase() !== T.nombre.trim().toLowerCase()) bloque.push({ t: recortar(T.razonSocial, 'normal', 9, maxTexto), f: 'normal', tam: 9, gris: 0.2 });
  if (T.direccion) bloque.push({ t: recortar(T.direccion, 'normal', 9, maxTexto), f: 'normal', tam: 9, gris: 0.2 });
  const contacto = [T.telefono ? `Tel. ${T.telefono}` : null, T.email].filter(Boolean).join(' · ');
  if (contacto) bloque.push({ t: recortar(contacto, 'normal', 9, maxTexto), f: 'normal', tam: 9, gris: 0.2 });

  const altoBox = 23;
  const altoTexto = bloque.reduce((a, b) => a + interlineado(b.tam), 0);
  const alto = Math.max(altoBox, altoTexto, altoLogo) + 2.5;
  return [
    {
      alto,
      dibujar: (p, y) => {
        if (logo) p.imagen(logo, PAGINA.izq, y + 0.5, anchoLogo, altoLogo);
        let cy = y;
        for (const b of bloque) {
          p.texto(xTexto, linea(cy, b.tam), b.t, { fuente: b.f, tam: b.tam, gris: b.gris });
          cy += interlineado(b.tam);
        }
        // Recuadro de la hoja: copia, tipo de documento, número y apertura.
        p.rect(xBox, y, wBox, altoBox, { ancho: 0.6 });
        p.rect(xBox, y, wBox, 6, { ancho: 0, relleno: 0.14 });
        const rot = recortar(v.rotulo, 'negrita', 9.5, pt(wBox - 4));
        p.texto(xBox + (wBox - anchoTexto(rot, 'negrita', 9.5) * MM_PT) / 2, linea(y + 1.1, 9.5), rot, { fuente: 'negrita', tam: 9.5, gris: 1 });
        const sub = 'ORDEN DE TRABAJO';
        p.texto(xBox + (wBox - anchoTexto(sub, 'negrita', 7.5) * MM_PT) / 2, linea(y + 7.2, 7.5), sub, { fuente: 'negrita', tam: 7.5, gris: GRIS_ROTULO });
        const nro = `N° ${numeroOrden(d.orden.numero)}`;
        p.texto(xBox + (wBox - anchoTexto(nro, 'negrita', 19) * MM_PT) / 2, linea(y + 9.6, 19), nro, { fuente: 'negrita', tam: 19 });
        const ap = `Apertura: ${fechaHoraLocal(d.orden.fechaApertura, d.zonaHoraria)}`;
        p.texto(xBox + (wBox - anchoTexto(ap, 'normal', 8.5) * MM_PT) / 2, linea(y + 17.9, 8.5), ap, { tam: 8.5 });
        p.linea(PAGINA.izq, y + alto - 0.8, PAGINA.der, y + alto - 0.8, { ancho: 0.8 });
      },
    },
  ];
}

interface Celda {
  etiqueta: string;
  valor: string;
  x: number;
  ancho: number;
  negrita?: boolean;
  tam?: number;
  atenuado?: boolean;
}
function filaDatos(celdas: Celda[]): Elemento {
  const medidas = celdas.map((c) => {
    const tam = c.tam ?? 10;
    const lineas = envolver(c.valor || '—', c.negrita ? 'negrita' : 'normal', tam, pt(c.ancho - 2));
    return { c, tam, lineas };
  });
  const alto = 3.6 + Math.max(...medidas.map((m) => m.lineas.length * interlineado(m.tam))) + 1;
  return {
    alto,
    dibujar: (p, y) => {
      for (const { c, tam, lineas } of medidas) {
        p.texto(c.x, linea(y + 0.6, 6.5), c.etiqueta, { fuente: 'negrita', tam: 6.5, gris: GRIS_ROTULO });
        lineas.forEach((t, i) => p.texto(c.x, linea(y + 3.4 + i * interlineado(tam), tam), t, { fuente: c.negrita ? 'negrita' : 'normal', tam, gris: c.atenuado ? 0.4 : 0 }));
      }
      p.linea(PAGINA.izq, y + alto - 0.2, PAGINA.der, y + alto - 0.2, { ancho: 0.15, gris: 0.6 });
    },
  };
}

/** Recuadro máximo de la fotografía del vehículo (mm): se ajusta dentro, sin deformarla, en el extremo derecho del bloque de datos. */
const FOTO = { ancho: 30, alto: 23 } as const;
const X_FOTO = PAGINA.der - FOTO.ancho;

function seccionDatos({ d, v, foto }: Contexto): Elemento[] {
  const vh = d.vehiculo;
  // Con foto, las filas terminan antes de su columna (sin ella conservan el ancho completo de siempre).
  const fin = foto ? X_FOTO - 4 : PAGINA.der;
  const veh = [vh.marca, vh.modelo].filter(Boolean).join(' ');
  const tecnico = [d.tecnico.responsable, ...d.tecnico.participantes.map((n) => `${n} (participa)`)].filter(Boolean).join(' · ');
  const filas: Elemento[] = [];
  if (!v.datosCliente) {
    // Copia del mecánico: sin fila de cliente.
  } else if (d.cliente.visible) {
    filas.push(filaDatos([
      { etiqueta: 'CLIENTE', valor: d.cliente.nombre ?? '', x: PAGINA.izq, ancho: foto ? 88 : 100, negrita: true },
      { etiqueta: 'TELÉFONO', valor: d.cliente.telefono ?? '', x: foto ? 106 : 118, ancho: fin - (foto ? 106 : 118) },
    ]));
  } else {
    filas.push(filaDatos([{ etiqueta: 'CLIENTE', valor: 'No disponible con los permisos de quien imprime', x: PAGINA.izq, ancho: fin - PAGINA.izq, atenuado: true }]));
  }
  filas.push(filaDatos(foto ? [
    { etiqueta: 'VEHÍCULO (MARCA Y MODELO)', valor: veh, x: PAGINA.izq, ancho: 62 },
    { etiqueta: 'PATENTE', valor: vh.patente, x: 78, ancho: 34, negrita: true, tam: 14 },
    { etiqueta: 'AÑO', valor: vh.anio ? String(vh.anio) : '', x: 114, ancho: 14 },
    { etiqueta: 'KM REGISTRADO', valor: vh.km != null ? `${miles(vh.km)} km` : '', x: 130, ancho: fin - 130 },
  ] : [
    { etiqueta: 'VEHÍCULO (MARCA Y MODELO)', valor: veh, x: PAGINA.izq, ancho: 74 },
    { etiqueta: 'PATENTE', valor: vh.patente, x: 92, ancho: 36, negrita: true, tam: 14 },
    { etiqueta: 'AÑO', valor: vh.anio ? String(vh.anio) : '', x: 130, ancho: 18 },
    { etiqueta: 'KM REGISTRADO', valor: vh.km != null ? `${miles(vh.km)} km` : '', x: 150, ancho: PAGINA.der - 150 },
  ]));
  filas.push(filaDatos([
    { etiqueta: 'TÉCNICO ASIGNADO', valor: tecnico, x: PAGINA.izq, ancho: foto ? 92 : 120 },
    { etiqueta: 'ENTREGA PROMETIDA', valor: d.orden.fechaPrometida ? fechaLocalTexto(d.orden.fechaPrometida, d.zonaHoraria) : '', x: foto ? 110 : 138, ancho: fin - (foto ? 110 : 138) },
  ]));
  if (!foto) return [...filas, separador(3)];
  // La foto ocupa el costado derecho de las tres filas: el bloque se dibuja junto (no se parte entre hojas) y no agrega altura a la hoja.
  const suma = filas.reduce((a, f) => a + f.alto, 0);
  const escala = Math.min(FOTO.ancho / foto.ancho, FOTO.alto / foto.alto);
  const w = foto.ancho * escala;
  const h = foto.alto * escala;
  const bloque: Elemento = {
    alto: Math.max(suma, FOTO.alto + 1),
    dibujar: (p, y) => {
      let cy = y;
      for (const f of filas) {
        f.dibujar(p, cy);
        cy += f.alto;
      }
      const x = PAGINA.der - w;
      p.imagen(foto, x, y + 0.5, w, h);
      p.rect(x, y + 0.5, w, h, { ancho: 0.25, gris: 0.35 });
    },
  };
  return [bloque, separador(3)];
}

// ── Secciones de contenido ──

function seccionTexto(titulo: string, texto: string | null, vacio?: string): Elemento[] {
  if (!texto?.trim()) return vacio ? [tituloSeccion(titulo), sinDato(vacio), separador()] : [];
  return [tituloSeccion(titulo), ...parrafo(texto), separador()];
}

function seccionTabla(titulo: string, filas: Array<{ n: number | null; texto: string; cant: string }>, conHecho: boolean, vacio?: string): Elemento[] {
  if (!filas.length) return vacio ? [tituloSeccion(titulo), sinDato(vacio), separador()] : [];
  const cont = [tituloSeccion(titulo, true), encabezadoTabla(conHecho)];
  return [tituloSeccion(titulo), encabezadoTabla(conHecho), ...filas.map((f) => filaTabla(f.n, f.texto, f.cant, conHecho, cont)), separador()];
}

/** Repuestos y materiales: lista compacta a dos columnas («cantidad × descripción»), porque el mecánico sólo necesita saber qué lleva. */
function seccionRepuestos(titulo: string, filas: Array<{ cant: string; texto: string }>): Elemento[] {
  if (!filas.length) return [];
  const tam = 9.5;
  const lh = interlineado(tam);
  const ancho = (ANCHO - 6) / 2;
  const celda = (f: { cant: string; texto: string }) => {
    const x0 = anchoTexto(`${f.cant} × `, 'negrita', tam) * MM_PT;
    return { f, x0, lineas: envolver(f.texto, 'normal', tam, pt(ancho - x0 - 1)) };
  };
  const cont = [tituloSeccion(titulo, true)];
  const elementos: Elemento[] = [];
  for (let i = 0; i < filas.length; i += 2) {
    const par = filas.slice(i, i + 2).map(celda);
    const alto = 1.1 + Math.max(...par.map((c) => c.lineas.length)) * lh + 1.1;
    elementos.push({
      alto,
      continuacion: cont,
      dibujar: (p, y) => {
        par.forEach((c, k) => {
          const x = PAGINA.izq + k * (ancho + 6);
          const b = linea(y + 1.1, tam);
          p.texto(x, b, `${c.f.cant} × `, { fuente: 'negrita', tam });
          c.lineas.forEach((l, n) => p.texto(x + c.x0, b + n * lh, l, { tam }));
        });
        p.linea(PAGINA.izq, y + alto, PAGINA.der, y + alto, { ancho: 0.15, gris: 0.6, guiones: [0.8, 0.8] });
      },
    });
  }
  return [tituloSeccion(titulo), ...elementos, separador()];
}

/** Pago del cliente (copia de administración): medio elegido, estado del pago y saldo pendiente. No se dibuja si el cliente todavía no eligió nada. */
function seccionPago({ d }: Contexto): Elemento[] {
  const p = d.pago;
  if (!p) return [];
  return [
    tituloSeccion('PAGO DEL CLIENTE'),
    filaDatos([
      { etiqueta: 'MEDIO ELEGIDO', valor: p.medio ?? 'Sin elegir', x: PAGINA.izq, ancho: 46 },
      { etiqueta: 'ESTADO DEL PAGO', valor: p.estado, x: 64, ancho: 92 },
      { etiqueta: 'SALDO PENDIENTE', valor: p.saldo != null ? dineroAR(p.saldo) : '', x: 158, ancho: PAGINA.der - 158, negrita: true },
    ]),
    separador(3),
  ];
}

const SECCIONES: Record<SeccionId, (c: Contexto) => Elemento[]> = {
  identidad: seccionIdentidad,
  datos: seccionDatos,
  motivo: ({ d }) => seccionTexto('MOTIVO DE INGRESO', d.motivo, 'No registrado.'),
  trabajos: ({ d }) => seccionTabla('TRABAJOS SOLICITADOS', d.trabajos.map((t, i) => ({ n: i + 1, texto: t.descripcion, cant: cantidadTexto(t.cantidad) })), true, 'No hay trabajos cargados en la orden.'),
  repuestos: ({ d }) => seccionRepuestos('REPUESTOS Y MATERIALES', d.repuestos.map((r) => ({ texto: r.descripcion, cant: `${cantidadTexto(r.cantidad)}${r.unidad && r.unidad !== 'un' ? ` ${r.unidad}` : ''}` }))),
  diagnostico: ({ d }) => seccionTexto('DIAGNÓSTICO PREVIO', d.diagnostico),
  observaciones: ({ d }) => seccionTexto('OBSERVACIONES', d.observaciones),
  pago: seccionPago,
};

// ── Encabezado compacto de las hojas de continuación ──

function encabezadoContinuacion({ d, v }: Contexto): Elemento {
  return {
    alto: 14,
    dibujar: (p, y) => {
      const der = `${v.rotulo} · OT N° ${numeroOrden(d.orden.numero)} · ${d.vehiculo.patente}`;
      p.texto(PAGINA.izq, linea(y, 12), recortar(d.taller.nombre, 'negrita', 12, pt(ANCHO - anchoTexto(der, 'negrita', 9) * MM_PT - 6)), { fuente: 'negrita', tam: 12 });
      p.texto(PAGINA.der - anchoTexto(der, 'negrita', 9) * MM_PT, linea(y + 0.6, 9), der, { fuente: 'negrita', tam: 9 });
      p.linea(PAGINA.izq, y + 8, PAGINA.der, y + 8, { ancho: 0.8 });
      p.texto(PAGINA.izq, linea(y + 9.4, 8), 'Continuación de la orden de trabajo', { tam: 8, gris: GRIS_ROTULO });
    },
  };
}

interface Colocado {
  e: Elemento;
  y: number;
}

/** Reparte los elementos en hojas sin cortar ninguno. Devuelve, por hoja, los elementos con su posición vertical y el punto donde termina el contenido. */
export function paginar(elementos: Elemento[], continuacion: Elemento, limite = PAGINA.limite): Array<{ items: Colocado[]; fin: number }> {
  const hojas: Array<{ items: Colocado[]; fin: number }> = [];
  let items: Colocado[] = [];
  let y: number = PAGINA.arriba;
  let inicioContenido = y;
  let fin = y;
  const nuevaHoja = () => {
    hojas.push({ items, fin });
    items = [];
    y = PAGINA.arriba;
    items.push({ e: continuacion, y });
    y += continuacion.alto + 3;
    inicioContenido = y;
    fin = y;
  };
  for (let i = 0; i < elementos.length; i++) {
    const e = elementos[i];
    // Lo "pegado" viaja junto con lo que le sigue (hasta el primer elemento que no lo está, inclusive).
    let necesita = e.alto;
    for (let k = i; elementos[k].pegado && elementos[k + 1]; k++) necesita += elementos[k + 1].alto;
    if (y + necesita > limite && y > inicioContenido) {
      nuevaHoja();
      // Una tabla que sigue en la hoja nueva repite su título y su encabezado.
      for (const c of e.continuacion ?? []) {
        items.push({ e: c, y });
        y += c.alto;
      }
    }
    items.push({ e, y });
    y += e.alto;
    if (!e.blando) fin = y;
  }
  hojas.push({ items, fin });
  return hojas;
}

// ───────────────────────── Dibujo de una variante ─────────────────────────

function pie(p: Pagina, c: Contexto, n: number, total: number) {
  const { d, v } = c;
  p.linea(PAGINA.izq, 285.2, PAGINA.der, 285.2, { ancho: 0.2, gris: 0.5 });
  const izq = `${v.rotulo} · OT N° ${numeroOrden(d.orden.numero)} · ${recortar(d.taller.nombre, 'normal', 7.5, pt(70))}`;
  p.texto(PAGINA.izq, 288.8, izq, { tam: 7.5, gris: 0.35 });
  const der = `Hoja ${n} de ${total} · Impreso ${fechaHoraLocal(d.impresoAt, d.zonaHoraria)}`;
  p.texto(PAGINA.der - anchoTexto(der, 'normal', 7.5) * MM_PT, 288.8, der, { tam: 7.5, gris: 0.35 });
}

function zonaAnotaciones(p: Pagina, titulo: string, desde: number) {
  p.rect(PAGINA.izq, desde, ANCHO, 7.5, { ancho: 0.6, relleno: 0.9 });
  p.texto(PAGINA.izq + 3, linea(desde + 1.6, 10), titulo, { fuente: 'negrita', tam: 10 });
  const renglones = Math.floor((PAGINA.limite - (desde + 7.5 + 2)) / PAGINA.paso);
  for (let i = 1; i <= renglones; i++) {
    const y = desde + 7.5 + 2 + i * PAGINA.paso - 1;
    p.linea(PAGINA.izq, y, PAGINA.der, y, { ancho: 0.25, gris: 0.45 });
  }
}

function dibujarVariante(doc: Documento, datos: DatosHoja, v: DefVariante, logo: ImagenJpeg | null, foto: ImagenJpeg | null): number {
  // Defensa en profundidad: una copia sin datos del cliente recibe una versión de los datos donde el cliente ya no existe.
  const sinCliente: DatosHoja = v.datosCliente ? datos : { ...datos, cliente: { visible: false, nombre: null, telefono: null } };
  // Lo mismo con la información financiera: una copia que no la lleva recibe los datos sin ella.
  const d: DatosHoja = v.datosPago ? sinCliente : { ...sinCliente, pago: null };
  const ctx: Contexto = { d, v, logo, foto };
  const elementos = v.secciones.flatMap((s) => SECCIONES[s](ctx));
  const hojas = paginar(elementos, encabezadoContinuacion(ctx));
  const ultima = hojas[hojas.length - 1];
  // Las anotaciones van en la mitad inferior de la última hoja; si el contenido llega hasta ahí, tienen una hoja propia.
  const anotacionesAparte = !!v.anotaciones && ultima.fin > PAGINA.anotacionesDesde - 1.5;
  const total = hojas.length + (anotacionesAparte ? 1 : 0);
  hojas.forEach((h, i) => {
    const p = doc.nuevaPagina();
    for (const { e, y } of h.items) e.dibujar(p, y);
    if (v.anotaciones && !anotacionesAparte && i === hojas.length - 1) zonaAnotaciones(p, v.anotaciones.titulo, PAGINA.anotacionesDesde);
    pie(p, ctx, i + 1, total);
  });
  if (anotacionesAparte) {
    const p = doc.nuevaPagina();
    const cab = encabezadoContinuacion(ctx);
    cab.dibujar(p, PAGINA.arriba);
    zonaAnotaciones(p, v.anotaciones!.titulo, PAGINA.arriba + cab.alto + 4);
    pie(p, ctx, total, total);
  }
  return total;
}

export interface HojaGenerada {
  pdf: Uint8Array;
  /** Cantidad de hojas A4 de cada variante, en el orden pedido. */
  hojas: number[];
}

/** Genera un único PDF A4 con una o varias copias de la hoja de la orden. */
export function generarHojaOrden(d: DatosHoja, variantes: VarianteId[]): HojaGenerada {
  const defs = variantes.map((id) => VARIANTES[id]);
  const rotulos = defs.map((v) => v.rotulo.replace('COPIA ', '').toLowerCase()).join(' y ');
  const doc = new Documento({ titulo: `Orden de trabajo N° ${numeroOrden(d.orden.numero)} - copia ${rotulos}`, asunto: 'Orden de trabajo', fecha: d.impresoAt });
  const logo = d.logo ? doc.agregarJpeg(d.logo) : null;
  // Una foto que no se pueda incrustar (formato o estructura inesperados) se omite: nunca impide generar la orden.
  const foto = d.foto ? doc.agregarJpeg(d.foto) : null;
  const hojas = defs.map((v) => dibujarVariante(doc, d, v, logo, foto));
  return { pdf: doc.generar(), hojas };
}

