// Lectores de códigos de barras USB: funcionan como un teclado (escriben el código y terminan con Enter), así que alcanza con
// buscar por coincidencia exacta cuando se presiona Enter en un campo de búsqueda de artículos.
import { api, ApiError } from './api';

/** Artículo cuyo código de barras (o código interno) coincide exactamente; null si no existe. */
export async function buscarPorCodigo(codigo: string): Promise<any | null> {
  const c = codigo.trim();
  if (!c) return null;
  try {
    return await api.get(`/articulos/lector/${encodeURIComponent(c)}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}
