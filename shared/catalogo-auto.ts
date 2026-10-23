// Utilidades del catálogo automotor compartidas por el Worker y la app.

/** Clave de búsqueda: minúsculas, sin tildes ni signos ("HR-V", "hr v" y "Hrv" dan lo mismo). */
export const claveBusqueda = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

export interface CatMarca {
  id: string;
  nombre: string;
  clave: string;
  busqueda: string | null;
  n: number;
}
export interface CatModelo {
  id: string;
  nombre: string;
  clave: string;
  tipo: string | null;
  anios: number[];
  n: number;
}
export interface CatVersion {
  id: string;
  descripcion: string;
  version: string | null;
  motorizacion: string | null;
  combustible: string | null;
  anios: number[];
  n: number;
}
