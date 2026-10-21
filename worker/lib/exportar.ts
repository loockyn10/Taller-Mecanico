// La exportación (CSV) es una acción distinta de consultar en pantalla: el cliente la pide con `exportar=1`,
// el servidor exige el permiso `informes.exportar` y deja constancia en la auditoría.
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { auditar } from './db';
import { forbidden } from './http';
import { tiene } from './auth';

export async function autorizarExportacion(c: Context<AppEnv>, informe: string): Promise<void> {
  if (c.req.query('exportar') !== '1') return;
  const s = c.get('sesion');
  if (!tiene(s, 'informes.exportar')) throw forbidden('No tenés permiso para exportar informes');
  await auditar(c.env.DB, s.tallerId, s.usuarioId, 'informe', null, 'exportar', { informe, filtros: c.req.query() }).run();
}
