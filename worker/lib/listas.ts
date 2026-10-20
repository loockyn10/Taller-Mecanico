// Listas de precios: resolución de la lista elegida en un documento y registro en el documento.
import { badRequest } from './http';
import { first, type Stmt } from './db';

export interface ListaRef {
  id: string;
  nombre: string;
}

/**
 * Valida que la lista exista en el taller. Una lista desactivada sólo se acepta si el documento ya la usaba
 * (se pueden seguir editando documentos viejos sin cambiar su lista).
 */
export async function resolverLista(db: D1Database, tallerId: string, listaId: string | null | undefined, actualId?: string | null): Promise<ListaRef | null> {
  if (!listaId) return null;
  const l = await first<{ id: string; nombre: string; activa: number }>(db, 'SELECT id, nombre, activa FROM listas_precios WHERE taller_id = ? AND id = ?', tallerId, listaId);
  if (!l) throw badRequest('Lista de precios inexistente');
  if (!l.activa && l.id !== actualId) throw badRequest('La lista de precios está desactivada');
  return { id: l.id, nombre: l.nombre };
}

/** Deja asentada en el documento la lista usada (nombre copiado). Pasar `null` limpia el campo. */
export function sentenciaListaEnDocumento(db: D1Database, tabla: 'presupuestos' | 'ordenes' | 'ventas', tallerId: string, docId: string, lista: ListaRef | null): Stmt {
  return db.prepare(`UPDATE ${tabla} SET lista_precio_id = ?, lista_precio_nombre = ? WHERE taller_id = ? AND id = ?`).bind(lista?.id ?? null, lista?.nombre ?? null, tallerId, docId);
}
