// Tipos y consultas compartidas del checklist de recepción y entrega (Sprint 18).
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ContenidoChecklist, ContextoConfirmado, TipoRegistro } from '@shared/checklist';
import type { FirmaTrazos } from './Firma';

export type ResultadoFirma = 'firmada' | 'no_presente' | 'se_niega';
export type EstadoFirma = ResultadoFirma | 'pendiente' | null;

export interface FirmaRegistro {
  id: string;
  resultado: ResultadoFirma;
  created_at: string;
  registrado_por_nombre: string;
  contenido_sha256: string;
  texto_version: number;
  // Sólo con el permiso de consultar firmas:
  nombre_firmante?: string | null;
  aclaracion?: string | null;
  firma?: FirmaTrazos | null;
  firma_sha256?: string | null;
  texto_conformidad?: string;
}

export interface Registro {
  id: string;
  orden_id: string;
  vehiculo_id: string;
  tipo: TipoRegistro;
  revision: number;
  previo_id: string | null;
  motivo: string | null;
  recepcion_id: string | null;
  estado: 'borrador' | 'confirmado';
  version: number;
  checklist_version: number;
  datos: ContenidoChecklist;
  contexto: ContextoConfirmado | null;
  contenido_sha256: string | null;
  responsable_nombre: string;
  created_at: string;
  updated_at: string;
  confirmado_at: string | null;
  confirmado_por_nombre: string | null;
  firma_estado: EstadoFirma;
  firmas: FirmaRegistro[];
}

export const claveChecklists = (ordenId: string) => ['checklists', 'orden', ordenId] as const;

export function useChecklistsOrden(ordenId: string, activo = true) {
  return useQuery({ queryKey: claveChecklists(ordenId), queryFn: () => api.get<{ registros: Registro[] }>(`/ordenes/${ordenId}/checklists`), enabled: activo });
}

/** Cómo está un tipo de registro (recepción o entrega) dentro de una OT. */
export function estadoDe(registros: Registro[], tipo: TipoRegistro) {
  const lista = registros.filter((r) => r.tipo === tipo).sort((a, b) => a.revision - b.revision);
  const confirmados = lista.filter((r) => r.estado === 'confirmado');
  return { lista, borrador: lista.find((r) => r.estado === 'borrador') ?? null, vigente: confirmados[confirmados.length - 1] ?? null, original: confirmados[0] ?? null };
}

export const FIRMA_LABEL: Record<Exclude<EstadoFirma, null>, string> = {
  firmada: 'Firmada por el cliente',
  no_presente: 'Cliente no presente',
  se_niega: 'El cliente no quiso firmar',
  pendiente: 'Sin firma del cliente',
};

/** Fecha y hora de ingreso en el formato del campo <input type="datetime-local"> (hora local del dispositivo). */
export function aInputLocal(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export const deInputLocal = (v: string): string => new Date(v).toISOString();
