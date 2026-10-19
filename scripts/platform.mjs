// CLI de administración de la plataforma (licencias manuales). Requiere la API en ejecución.
//
//   npm run platform -- listar
//   npm run platform -- crear-taller --nombre "Taller X" --email dueño@x.com --password clave123 [--propietario "Nombre"] [--adicionales 2]
//   npm run platform -- licencia <tallerId> --adicionales 3
//   npm run platform -- suspender <tallerId>
//   npm run platform -- activar <tallerId>
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
    default:
      console.log('Comandos: listar | crear-taller | licencia | suspender | activar (ver encabezado del archivo)');
  }
}

if (process.argv[1]?.endsWith('platform.mjs')) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
