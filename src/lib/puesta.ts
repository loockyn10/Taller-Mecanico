import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useAuth } from './auth';
import type { PasoCalculado, Paso } from '@shared/puesta';

export interface EstadoPuesta {
  pasos: PasoCalculado[];
  completos: number;
  omitidos: number;
  pendientes: number;
  total: number;
  asistente_pendiente: boolean;
  siguiente: Paso | null;
}

/** Progreso de la configuración inicial (solo para quien puede configurar el taller). */
export function usePuesta() {
  const { puede } = useAuth();
  return useQuery({ queryKey: ['puesta'], queryFn: () => api.get<EstadoPuesta>('/puesta-en-marcha'), enabled: puede('config.editar'), staleTime: 30_000 });
}

/** Guarda datos de la configuración partiendo de lo vigente (así no se pisan campos que esta pantalla no muestra). */
export async function guardarConfig(taller: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  const actual = await api.get('/taller/config');
  await api.put('/taller/config', {
    taller: { ...actual.taller, inicio_actividades: actual.taller.inicio_actividades || null, ...taller },
    config: { ...actual.config, permitir_stock_negativo: !!actual.config.permitir_stock_negativo, caja_obligatoria: !!actual.config.caja_obligatoria, ...config },
  });
}

/** Reduce la imagen a un tamaño razonable y la devuelve como data URL (PNG o JPG) de menos de ~200 KB. */
export async function prepararLogo(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Usá una imagen PNG, JPG o WebP');
  const bmp = await createImageBitmap(file);
  const escala = Math.min(1, 480 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * escala));
  const h = Math.max(1, Math.round(bmp.height * escala));
  const dibujar = (fondo: string | null) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d')!;
    if (fondo) (g.fillStyle = fondo), g.fillRect(0, 0, w, h);
    g.drawImage(bmp, 0, 0, w, h);
    return c;
  };
  let url = file.type === 'image/png' || file.type === 'image/webp' ? dibujar(null).toDataURL('image/png') : dibujar('#ffffff').toDataURL('image/jpeg', 0.88);
  if (url.length > 270_000) url = dibujar('#ffffff').toDataURL('image/jpeg', 0.7);
  if (url.length > 280_000) throw new Error('El logo es demasiado pesado: probá con una imagen más chica');
  return url;
}
