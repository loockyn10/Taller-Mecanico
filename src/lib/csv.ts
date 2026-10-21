// Exportación de tablas a CSV (compatible con Excel en español: separador ";" y BOM UTF-8).
import { api } from './api';

function celda(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  // Evita la inyección de fórmulas al abrir el archivo en una planilla.
  const seguro = /^[=+\-@]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
  return /[";\n\r]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
}

export function descargarCSV(nombre: string, columnas: string[], filas: Array<Array<unknown>>) {
  const texto = [columnas, ...filas].map((f) => f.map(celda).join(';')).join('\r\n');
  const blob = new Blob(['﻿', texto], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre.endsWith('.csv') ? nombre : `${nombre}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Pide al servidor autorización para exportar (permiso `informes.exportar`; queda registrado en la auditoría) y recién entonces ejecuta
 * la descarga. `ruta` es la misma consulta que alimenta la pantalla.
 */
export async function exportarAutorizado(ruta: string, descargar: () => void): Promise<void> {
  await api.get(`${ruta}${ruta.includes('?') ? '&' : '?'}exportar=1`);
  descargar();
}

/** Importe en pesos con coma decimal para planillas (sin símbolo). */
export const pesosCSV = (centavos: number) => (centavos / 100).toFixed(2).replace('.', ',');
