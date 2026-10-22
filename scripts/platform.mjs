// CLI de administración de la plataforma (licencias manuales). Requiere la API en ejecución.
//
//   npm run platform -- listar
//   npm run platform -- crear-taller --nombre "Taller X" --email dueño@x.com --password clave123 [--propietario "Nombre"] [--adicionales 2]
//   npm run platform -- licencia <tallerId> --adicionales 3
//   npm run platform -- suspender <tallerId>
//   npm run platform -- activar <tallerId>
//
// Alta comercial por invitación (el cliente crea su propia contraseña y configura su taller; el token de plataforma nunca sale de acá):
//   npm run platform -- invitar [--nombre "Taller X"] [--email dueño@x.com] [--adicionales 2] [--dias 7] [--notas "Venta #12"]
//   npm run platform -- invitaciones
//   npm run platform -- revocar <invitacionId>
//
// Operación (solo lectura salvo `mantenimiento`, que hace lo mismo que el Cron cada 5 minutos):
//   npm run platform -- salud            Informe de salud: mantenimiento, cola contable, seguridad, errores del Worker y respaldo externo (con alertas).
//   npm run platform -- mantenimiento    Corre ahora el mantenimiento periódico (vacía colas de contabilización, avanza reconciliaciones).
//
// Variables: FIERRO_API (por defecto http://127.0.0.1:8787) y PLATFORM_ADMIN_TOKEN (por defecto se lee de .dev.vars).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib.mjs';

const API = process.env.FIERRO_API ?? 'http://127.0.0.1:8787';
function token() {
  if (process.env.PLATFORM_ADMIN_TOKEN) return process.env.PLATFORM_ADMIN_TOKEN;
  const vars = fs.existsSync(path.join(ROOT, '.dev.vars')) ? fs.readFileSync(path.join(ROOT, '.dev.vars'), 'utf8') : '';
  return /PLATFORM_ADMIN_TOKEN=(.+)/.exec(vars)?.[1]?.trim();
}

export async function plataforma(method, ruta, body) {
  const r = await fetch(`${API}/api/platform${ruta}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`${r.status}: ${json?.error?.message ?? JSON.stringify(json)}`);
  return json;
}

function opciones(args) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) o[args[i].slice(2)] = args[++i];
    else o._.push(args[i]);
  }
  return o;
}

async function main() {
  const [cmd, ...resto] = process.argv.slice(2);
  const o = opciones(resto);
  switch (cmd) {
    case 'salud': {
      const r = await plataforma('GET', '/salud');
      console.log(`Salud de la plataforma · ${r.generado_at}`);
      console.log(r.alertas.length ? `ALERTAS (${r.alertas.length}):\n${r.alertas.map((a) => `  ! ${a}`).join('\n')}` : 'Sin alertas.');
      console.log(`\nMantenimiento periódico: último ${r.mantenimiento.ultimo_at ?? 'nunca'} · ${r.mantenimiento.ok === null ? '—' : r.mantenimiento.ok ? 'ok' : 'CON ERRORES'}${r.mantenimiento.atrasado ? ' · ATRASADO' : ''}`);
      console.log(`Respaldo externo: último aviso ${r.respaldo_externo.ultimo_at ?? 'nunca'} · ${r.respaldo_externo.ok === null ? '—' : r.respaldo_externo.ok ? 'ok' : 'CON ERROR'}${r.respaldo_externo.atrasado ? ' · ATRASADO' : ''}`);
      const c = r.contabilidad;
      console.log(`Contabilidad: ${c.talleres_activados} taller(es) activados · cola: ${c.cola_pendiente} pendientes, ${c.cola_fallida} fallidas${c.cola_mas_antigua ? ` (la más antigua: ${c.cola_mas_antigua})` : ''} · reconciliando: ${c.reconciliando}`);
      for (const t of c.talleres_con_cola) console.log(`  cola · ${t.taller}: ${t.pendientes} pendientes, ${t.fallidas} fallidas desde ${t.mas_antigua}`);
      for (const t of c.talleres_con_error) console.log(`  error · ${t.taller}: ${t.ultimo_error} (${t.fecha})`);
      console.log(`Seguridad (24 h): ${JSON.stringify(r.seguridad.ultimas_24h)} · bloqueos vigentes: ${r.seguridad.bloqueos_vigentes}${r.seguridad.origenes_con_mas_fallos.length ? ` · orígenes con más fallos (huellas): ${r.seguridad.origenes_con_mas_fallos.map((x) => `${x.origen}=${x.fallos}`).join(', ')}` : ''}`);
      console.log(`Errores del Worker: ${r.errores_worker.problemas_24h} problema(s) / ${r.errores_worker.ocurrencias_24h} ocurrencia(s) en 24 h`);
      for (const e of r.errores_worker.recientes) console.log(`  ${e.ultima_at} · ${e.metodo} ${e.ruta} · ${e.veces}× · ${e.mensaje}`);
      if (r.alertas.length) process.exitCode = 1;
      break;
    }
    case 'mantenimiento': {
      const r = await plataforma('POST', '/mantenimiento', {});
      console.log(`Mantenimiento: ${r.ok ? 'ok' : 'CON ERRORES'} · ${JSON.stringify(r.contable)}${r.error ? ` · ${r.error}` : ''}`);
      if (!r.ok) process.exitCode = 1;
      break;
    }
    case 'listar': {
      const t = await plataforma('GET', '/talleres');
      console.table(t.map((x) => ({ id: x.id, nombre: x.nombre, estado: x.estado, usuarios: `${x.usuarios_activos}/${x.usuarios_incluidos + x.usuarios_adicionales}` })));
      break;
    }
    case 'crear-taller': {
      if (!o.nombre || !o.email || !o.password) throw new Error('Faltan --nombre, --email o --password');
      const r = await plataforma('POST', '/talleres', {
        nombre: o.nombre,
        usuarios_adicionales: Number(o.adicionales ?? 0),
        propietario: { nombre: o.propietario ?? o.nombre, email: o.email, password: o.password },
      });
      console.log('Taller creado:', r);
      break;
    }
    case 'licencia':
      console.log(await plataforma('PATCH', `/talleres/${o._[0]}/licencia`, { usuarios_adicionales: Number(o.adicionales) }));
      break;
    case 'suspender':
      console.log(await plataforma('PATCH', `/talleres/${o._[0]}/licencia`, { estado: 'suspendida' }));
      break;
    case 'activar':
      console.log(await plataforma('PATCH', `/talleres/${o._[0]}/licencia`, { estado: 'activa' }));
      break;
    case 'invitar': {
      const r = await plataforma('POST', '/invitaciones', {
        nombre_sugerido: o.nombre || undefined,
        email: o.email || undefined,
        usuarios_adicionales: Number(o.adicionales ?? 0),
        dias: Number(o.dias ?? 7),
        notas: o.notas || undefined,
      });
      console.log(`Invitación creada (id ${r.id}). Vence: ${r.vence_at}`);
      console.log('Enlace de activación (se muestra una sola vez; es de un solo uso):');
      console.log(r.enlace);
      break;
    }
    case 'invitaciones': {
      const t = await plataforma('GET', '/invitaciones');
      console.table(t.map((x) => ({ id: x.id, para: x.nombre_sugerido ?? x.email_destino ?? '', estado: x.estado, vence: x.vence_at, taller: x.taller ?? '' })));
      break;
    }
    case 'revocar':
      console.log(await plataforma('POST', `/invitaciones/${o._[0]}/revocar`, {}));
      break;
    default:
      console.log('Comandos: listar | crear-taller | licencia | suspender | activar | invitar | invitaciones | revocar (ver encabezado del archivo)');
  }
}

if (process.argv[1]?.endsWith('platform.mjs')) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
