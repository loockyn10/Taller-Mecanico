// Lectura de las fotografías para el respaldo programado (GitHub Actions → copia cifrada fuera de Cloudflare).
// Credencial propia y MÍNIMA: FOTOS_BACKUP_TOKEN sólo permite leer el manifiesto y bajar archivos. No sirve para crear talleres, cambiar licencias ni tocar datos,
// que es lo que sí puede hacer PLATFORM_ADMIN_TOKEN; por eso ese otro token nunca se carga en GitHub.
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { ApiError } from '../lib/http';
import { igualSeguro } from '../lib/crypto';
import { exigirNoBloqueado, limpiarFallos, registrarFallo } from '../lib/limites';
import { huellaCorta, registrarEvento } from '../lib/seguridad';
import { archivoParaExportar, manifiestoFotos } from '../lib/fotos';

export const respaldoFotos = new Hono<AppEnv>();

respaldoFotos.use('*', async (c, next) => {
  const clave = `fotos-respaldo:${c.req.header('cf-connecting-ip') ?? 'local'}`;
  await exigirNoBloqueado(c.env.DB, clave);
  const esperado = c.env.FOTOS_BACKUP_TOKEN;
  const recibido = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!esperado || esperado.length < 24 || !igualSeguro(recibido, esperado)) {
    const restantes = await registrarFallo(c.env.DB, clave, 10, 15, 30);
    await registrarEvento(c.env.DB, { tipo: 'plataforma_token_invalido', origen: await huellaCorta(c.req.header('cf-connecting-ip') ?? 'local'), detalle: { via: 'fotos_respaldo', ...(restantes === 0 ? { bloqueo: true } : {}) } });
    throw new ApiError(401, 'no_autorizado', 'Token inválido');
  }
  await limpiarFallos(c.env.DB, clave);
  await next();
});

respaldoFotos.get('/manifiesto', async (c) => c.json(await manifiestoFotos(c.env.DB, null, c.req.query('despues') ?? '')));
respaldoFotos.get('/:id/archivo', (c) => archivoParaExportar(c.env.DB, c.env.FIERRO_FOTOS, c.req.param('id'), c.req.query('variante') === 'miniatura'));
