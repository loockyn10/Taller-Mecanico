// Hoja para el cliente con el código QR del seguimiento (A4 vertical). Es una copia APARTE: no modifica la hoja del mecánico ni la de administración.
//
// Regla de datos: sólo lleva datos que el cliente ya conoce (taller, número de orden, fecha de ingreso, vehículo) y la dirección pública del enlace.
// Nada de importes, notas ni datos de terceros, y el QR contiene únicamente la dirección (ver shared/qr.ts).
import { Documento, MM, type Pagina } from './pdf/escritor';
import { anchoTexto, envolver, recortar } from './pdf/metricas';
import { fechaHoraLocal, numeroOrden, PAGINA, type DatosHoja } from './hoja-orden';
import { matrizQr } from '../../shared/qr';

const MM_PT = 25.4 / 72;
const pt = (mm: number) => mm * MM;
const linea = (y: number, tam: number) => y + tam * MM_PT * 0.82;
const ANCHO = PAGINA.der - PAGINA.izq;
const centrado = (p: Pagina, y: number, t: string, tam: number, fuente: 'normal' | 'negrita' = 'normal', gris = 0) =>
  p.texto(PAGINA.izq + (ANCHO - anchoTexto(t, fuente, tam) * MM_PT) / 2, linea(y, tam), t, { fuente, tam, gris });

/** Dibuja el QR como rectángulos negros (uno por tramo continuo de módulos oscuros): vectorial, nítido a cualquier tamaño de impresión. */
function dibujarQr(p: Pagina, texto: string, x: number, y: number, lado: number) {
  const m = matrizQr(texto);
  const silencio = 4;
  const modulo = lado / (m.length + silencio * 2);
  p.rect(x, y, lado, lado, { ancho: 0, relleno: 1 });
  m.forEach((fila, r) => {
    let c = 0;
    while (c < fila.length) {
      if (!fila[c]) { c++; continue; }
      const ini = c;
      while (c < fila.length && fila[c]) c++;
      // Cada tramo se agranda un 3 % de módulo: sin ese solapamiento algunos visores y rasterizadores dejan hilos blancos entre filas contiguas.
      p.rect(x + (ini + silencio) * modulo, y + (r + silencio) * modulo, (c - ini) * modulo + modulo * 0.03, modulo * 1.03, { ancho: 0, relleno: 0 });
    }
  });
}

export interface HojaClienteGenerada {
  pdf: Uint8Array;
  hojas: number;
}

export function generarHojaCliente(d: DatosHoja, url: string): HojaClienteGenerada {
  const doc = new Documento({ titulo: `Seguimiento de la orden N° ${numeroOrden(d.orden.numero)}`, asunto: 'Seguimiento de la reparación', fecha: d.impresoAt });
  const logo = d.logo ? doc.agregarJpeg(d.logo) : null;
  const p = doc.nuevaPagina();
  const T = d.taller;

  // ── Encabezado: identidad del taller y datos de la orden ──
  const xBox = 128;
  const wBox = PAGINA.der - xBox;
  let xTexto = PAGINA.izq;
  if (logo) {
    const escala = Math.min(40 / logo.ancho, 16 / logo.alto);
    p.imagen(logo, PAGINA.izq, PAGINA.arriba + 0.5, logo.ancho * escala, logo.alto * escala);
    xTexto = PAGINA.izq + logo.ancho * escala + 4;
  }
  const maxTexto = pt(xBox - 6 - xTexto);
  let y = PAGINA.arriba;
  for (const t of envolver(T.nombre, 'negrita', 15, maxTexto).slice(0, 2)) {
    p.texto(xTexto, linea(y, 15), t, { fuente: 'negrita', tam: 15 });
    y += 15 * MM_PT * 1.38;
  }
  for (const t of [T.direccion, [T.telefono ? `Tel. ${T.telefono}` : null, T.email].filter(Boolean).join(' · ')].filter(Boolean) as string[]) {
    p.texto(xTexto, linea(y, 9), recortar(t, 'normal', 9, maxTexto), { tam: 9, gris: 0.2 });
    y += 9 * MM_PT * 1.38;
  }
  p.rect(xBox, PAGINA.arriba, wBox, 23, { ancho: 0.6 });
  p.rect(xBox, PAGINA.arriba, wBox, 6, { ancho: 0, relleno: 0.14 });
  const rot = 'COPIA PARA EL CLIENTE';
  p.texto(xBox + (wBox - anchoTexto(rot, 'negrita', 9.5) * MM_PT) / 2, linea(PAGINA.arriba + 1.1, 9.5), rot, { fuente: 'negrita', tam: 9.5, gris: 1 });
  const nro = `N° ${numeroOrden(d.orden.numero)}`;
  p.texto(xBox + (wBox - anchoTexto(nro, 'negrita', 19) * MM_PT) / 2, linea(PAGINA.arriba + 8.4, 19), nro, { fuente: 'negrita', tam: 19 });
  const ing = `Ingreso: ${fechaHoraLocal(d.orden.fechaApertura, d.zonaHoraria)}`;
  p.texto(xBox + (wBox - anchoTexto(ing, 'normal', 8.5) * MM_PT) / 2, linea(PAGINA.arriba + 17.2, 8.5), ing, { tam: 8.5 });
  p.linea(PAGINA.izq, PAGINA.arriba + 25.5, PAGINA.der, PAGINA.arriba + 25.5, { ancho: 0.8 });

  // ── Título y vehículo ──
  centrado(p, 46, 'Seguí la reparación de tu vehículo', 20, 'negrita');
  centrado(p, 56, 'desde tu celular, sin instalar nada ni crear una cuenta', 11, 'normal', 0.3);
  const vh = d.vehiculo;
  const veh = [vh.marca, vh.modelo].filter(Boolean).join(' ');
  centrado(p, 68, [veh, vh.patente].filter(Boolean).join(' · ') || `Orden N° ${numeroOrden(d.orden.numero)}`, 13, 'negrita');

  // ── QR ──
  const lado = 78;
  const xQr = PAGINA.izq + (ANCHO - lado) / 2;
  const yQr = 80;
  dibujarQr(p, url, xQr, yQr, lado);
  p.rect(xQr, yQr, lado, lado, { ancho: 0.4 });

  // ── Cómo usarlo ──
  let yt = yQr + lado + 8;
  centrado(p, yt, 'Cómo ver el estado', 11, 'negrita');
  yt += 7;
  const pasos = ['Abrí la cámara de tu celular.', 'Apuntá al código QR de esta hoja.', 'Tocá el enlace que aparece en pantalla.'];
  pasos.forEach((t, i) => {
    centrado(p, yt, `${i + 1}.  ${t}`, 10.5);
    yt += 6.2;
  });
  yt += 3;
  centrado(p, yt, 'Si el QR no se lee, escribí esta dirección en el navegador:', 9, 'normal', 0.35);
  yt += 5.5;
  // La dirección entra en una sola línea si se puede (es lo que alguien tendría que tipear a mano): se achica la letra antes de partirla.
  const tamUrl = [8.5, 8, 7.5, 7, 6.5].find((t) => anchoTexto(url, 'negrita', t) <= pt(ANCHO - 8)) ?? 6.5;
  for (const t of envolver(url, 'negrita', tamUrl, pt(ANCHO - 8))) {
    centrado(p, yt, t, tamUrl, 'negrita');
    yt += 4.4;
  }
  yt += 4;
  p.linea(PAGINA.izq, yt, PAGINA.der, yt, { ancho: 0.2, gris: 0.5 });
  yt += 3.5;
  const notas = [
    'La página se actualiza cada vez que la abrís: ahí vas a ver el estado de tu vehículo, los avisos del taller y, si corresponde, la fecha estimada de entrega.',
    'Este enlace es personal. No lo publiques: cualquier persona que lo tenga puede ver el estado de la reparación.',
  ];
  for (const n of notas) {
    for (const t of envolver(n, 'normal', 9, pt(ANCHO))) {
      p.texto(PAGINA.izq, linea(yt, 9), t, { tam: 9, gris: 0.25 });
      yt += 4.3;
    }
    yt += 1.5;
  }

  // ── Pie ──
  p.linea(PAGINA.izq, 285.2, PAGINA.der, 285.2, { ancho: 0.2, gris: 0.5 });
  p.texto(PAGINA.izq, 288.8, `COPIA PARA EL CLIENTE · OT N° ${numeroOrden(d.orden.numero)} · ${recortar(T.nombre, 'normal', 7.5, pt(70))}`, { tam: 7.5, gris: 0.35 });
  const der = `Impreso ${fechaHoraLocal(d.impresoAt, d.zonaHoraria)}`;
  p.texto(PAGINA.der - anchoTexto(der, 'normal', 7.5) * MM_PT, 288.8, der, { tam: 7.5, gris: 0.35 });
  return { pdf: doc.generar(), hojas: 1 };
}
