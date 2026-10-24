// Código QR del enlace de seguimiento. Se genera localmente (librería MIT sin dependencias, sin servicios externos ni costos) y contiene ÚNICAMENTE la dirección
// pública del enlace: ningún dato del cliente, del vehículo ni de la orden viaja en el código.
import qrcode from 'qrcode-generator';

/** Matriz de módulos del QR (true = oscuro). Corrección de errores media: tolera un poco de suciedad o desgaste en una hoja impresa. */
export function matrizQr(texto: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(texto, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** SVG vectorial del QR con zona de silencio de 4 módulos (lo que exige la especificación para que lo lea cualquier cámara). */
export function svgQr(texto: string, opciones: { color?: string; fondo?: string } = {}): string {
  const { color = '#000', fondo = '#fff' } = opciones;
  const m = matrizQr(texto);
  const silencio = 4;
  const lado = m.length + silencio * 2;
  let d = '';
  m.forEach((fila, r) => {
    let c = 0;
    while (c < fila.length) {
      if (!fila[c]) { c++; continue; }
      const ini = c;
      while (c < fila.length && fila[c]) c++;
      d += `M${ini + silencio} ${r + silencio}h${c - ini}v1h-${c - ini}z`;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lado} ${lado}" shape-rendering="crispEdges" role="img" aria-label="Código QR del enlace de seguimiento"><rect width="${lado}" height="${lado}" fill="${fondo}"/><path d="${d}" fill="${color}"/></svg>`;
}
