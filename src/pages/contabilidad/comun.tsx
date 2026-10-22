// Piezas compartidas por las pantallas de contabilidad.
import { Link } from 'react-router-dom';
import { Printer } from 'lucide-react';
import { Boton, Insignia } from '@/components/ui';
import { money } from '@/lib/format';

export const AVISO_INTERNO = 'Información contable y administrativa interna: no son libros fiscales ni tienen validez ante ARCA.';

/** Importe contable: vacío cuando es cero (las columnas Debe / Haber se leen mejor así). */
export const imp = (c: number | null | undefined) => (c ? money(c) : '');

export const ESTADO_ASIENTO: Record<string, { texto: string; tono: 'gris' | 'verde' | 'ambar' }> = {
  borrador: { texto: 'Borrador', tono: 'ambar' },
  registrado: { texto: 'Registrado', tono: 'verde' },
  revertido: { texto: 'Revertido', tono: 'gris' },
};

export function EstadoAsiento({ estado }: { estado: string }) {
  const e = ESTADO_ASIENTO[estado] ?? { texto: estado, tono: 'gris' as const };
  return <Insignia tono={e.tono}>{e.texto}</Insignia>;
}

/** Enlace al documento de origen cuando existe una pantalla para verlo. */
export function OrigenLink({ tipo, id, children }: { tipo: string; id: string | null; children: React.ReactNode }) {
  if (id && tipo === 'venta') return <Link to={`/ventas/${id}`} className="text-marca-700 hover:underline">{children}</Link>;
  return <>{children}</>;
}

export function BotonImprimir() {
  return <Boton icono={<Printer className="size-4" />} onClick={() => window.print()}>Imprimir / PDF</Boton>;
}

/** Nombre del archivo de exportación sin caracteres raros. */
export const nombreArchivo = (base: string, desde: string, hasta: string) => `${base}-${desde}_${hasta}`;

export function Periodo({ desde, hasta }: { desde: string; hasta: string }) {
  return <p className="mb-3 hidden text-sm print:block">Período: {desde.split('-').reverse().join('/')} al {hasta.split('-').reverse().join('/')} · {AVISO_INTERNO}</p>;
}
