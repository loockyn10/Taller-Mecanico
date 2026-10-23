// Preparación de fotografías en el navegador: se redimensionan y recomprimen antes de subir (menos datos y menos almacenamiento) y, al
// redibujarlas en un canvas, se pierden los metadatos EXIF (incluida la ubicación GPS). La orientación se aplica al dibujar.
import { ApiError } from './api';

export const LADO_MAX = 2000; // px del lado mayor
export const PESO_OBJETIVO = 800_000; // bytes: se baja la calidad hasta entrar, sin pasar de CALIDADES[último]
const CALIDADES = [0.86, 0.8, 0.74, 0.68, 0.62];
const PESO_TOPE = 3_300_000; // el servidor rechaza más de 3,5 MB
const LADO_MINIATURA = 480;

export interface FotoPreparada {
  blob: Blob;
  miniatura: Blob;
  ancho: number;
  alto: number;
}

async function decodificar(archivo: File): Promise<{ fuente: CanvasImageSource; ancho: number; alto: number; liberar: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const b = await createImageBitmap(archivo, { imageOrientation: 'from-image' });
      return { fuente: b, ancho: b.width, alto: b.height, liberar: () => b.close() };
    } catch {
      /* se prueba con <img> */
    }
  }
  const url = URL.createObjectURL(archivo);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { fuente: img, ancho: img.naturalWidth, alto: img.naturalHeight, liberar: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('No se pudo leer la imagen. Probá con otra foto (formatos como HEIC no siempre son compatibles con este navegador).');
  }
}

function aBlob(canvas: HTMLCanvasElement, calidad: number): Promise<Blob> {
  return new Promise((ok, mal) => canvas.toBlob((b) => (b ? ok(b) : mal(new Error('No se pudo comprimir la imagen'))), 'image/jpeg', calidad));
}

function dibujar(fuente: CanvasImageSource, ancho: number, alto: number, lado: number): HTMLCanvasElement {
  const escala = Math.min(1, lado / Math.max(ancho, alto));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(ancho * escala));
  c.height = Math.max(1, Math.round(alto * escala));
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Este navegador no puede procesar imágenes');
  ctx.fillStyle = '#fff'; // los PNG con transparencia no quedan negros en JPEG
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(fuente, 0, 0, c.width, c.height);
  return c;
}

export async function prepararFoto(archivo: File): Promise<FotoPreparada> {
  if (!archivo.type.startsWith('image/') && archivo.type !== '') throw new Error('El archivo no es una imagen');
  const d = await decodificar(archivo);
  try {
    let lado = LADO_MAX;
    let canvas = dibujar(d.fuente, d.ancho, d.alto, lado);
    let blob = await aBlob(canvas, CALIDADES[0]);
    // Primero se baja la calidad (hasta un piso que sigue permitiendo distinguir daños y piezas); sólo si aun así no entra se reduce el tamaño.
    for (const q of CALIDADES.slice(1)) {
      if (blob.size <= PESO_OBJETIVO) break;
      blob = await aBlob(canvas, q);
    }
    while (blob.size > PESO_TOPE && lado > 800) {
      lado = Math.round(lado * 0.8);
      canvas = dibujar(d.fuente, d.ancho, d.alto, lado);
      blob = await aBlob(canvas, CALIDADES[CALIDADES.length - 1]);
    }
    const mini = await aBlob(dibujar(d.fuente, d.ancho, d.alto, LADO_MINIATURA), 0.72);
    return { blob, miniatura: mini, ancho: canvas.width, alto: canvas.height };
  } finally {
    d.liberar();
  }
}

export interface CamposSubida {
  vehiculo_id: string;
  orden_id?: string;
  etapa?: string;
  descripcion?: string;
  idem_key: string;
}

/** Sube una foto con progreso real (fetch no informa el avance de la subida). Reintentar con la misma idem_key nunca la duplica. */
export function subirFoto(campos: CamposSubida, f: FotoPreparada, onProgreso?: (pct: number) => void): Promise<any> {
  return new Promise((ok, mal) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(campos)) if (v) form.set(k, v);
    form.set('foto', f.blob, 'foto.jpg');
    form.set('miniatura', f.miniatura, 'miniatura.jpg');
    const x = new XMLHttpRequest();
    x.open('POST', '/api/fotos');
    x.setRequestHeader('x-fierro-subida', '1');
    x.timeout = 120_000;
    x.upload.onprogress = (e) => e.lengthComputable && onProgreso?.(Math.round((e.loaded / e.total) * 100));
    x.onload = () => {
      let cuerpo: any = null;
      try {
        cuerpo = x.responseText ? JSON.parse(x.responseText) : null;
      } catch {
        /* respuesta no JSON */
      }
      if (x.status >= 200 && x.status < 300) return ok(cuerpo);
      const e = cuerpo?.error ?? {};
      mal(new ApiError(x.status, e.code ?? 'error', e.message ?? `Error ${x.status}`));
    };
    x.onerror = () => mal(new ApiError(0, 'sin_conexion', 'Se cortó la conexión. Tocá "Reintentar": no se duplica la foto.'));
    x.ontimeout = () => mal(new ApiError(0, 'sin_conexion', 'La subida tardó demasiado. Tocá "Reintentar".'));
    x.send(form);
  });
}
