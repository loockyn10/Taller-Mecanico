# Dominio público

Dirección oficial: **https://taller.orvelan.com.ar** (dominio `orvelan.com.ar` en Cloudflare, subdominio conectado al Worker `taller-mecanico`).
La dirección anterior `https://taller-mecanico.estrubia455.workers.dev` sigue activa (`workers_dev: true`): no hay redirecciones, así que los enlaces de seguimiento, las invitaciones y los accesos guardados siguen funcionando.

## Cómo se arma cada enlace
- Un solo lugar: `worker/lib/url-publica.ts` (`urlPublica`). En producción devuelve siempre el dominio oficial, entre el usuario por la dirección que entre; en local (`localhost`, `127.0.0.1`) devuelve el origen de la solicitud, así que el desarrollo y las pruebas no cambian. La variable `URL_PUBLICA` del Worker lo reemplaza sin tocar código.
- Lo usan: enlace de seguimiento (y por lo tanto el botón de WhatsApp y el QR, que parten de esa URL), hoja A4 con el QR del seguimiento (PDF de la OT) e invitaciones de activación (`/activar#token`).
- Todo lo demás de la app usa rutas relativas (`/api/...`, `/reloj`, PWA con `start_url: '/'`). Las sesiones son por dirección (cookie sin dominio): quien entra por el dominio nuevo inicia sesión una vez ahí; las de la dirección anterior no se invalidan.
- El QR de `/reloj` (Personal › Reloj) usa la dirección desde la que se abre la pantalla, a propósito: el dispositivo queda vinculado a ese sitio.

## wrangler.jsonc
`routes: [{ pattern: "taller.orvelan.com.ar", custom_domain: true }]` conserva el dominio en los despliegues (Workers Builds). El dominio ya existía (conectado a mano): no se crean registros DNS nuevos. `scripts/lib.mjs › configLocal` quita `routes` del archivo que usa `wrangler dev`, porque con rutas wrangler serviría las solicitudes locales con ese host.
Un `wrangler deploy` ensaya (`--dry-run`) sin errores; no se renombró el Worker ni se tocó D1, R2, secretos ni variables.

## Respaldos
Los flujos de GitHub Actions usan la variable `FIERRO_URL` del repositorio; la dirección anterior sigue sirviendo, así que no hace falta cambiarla ya. Cuando se retire `workers.dev`, actualizar `FIERRO_URL` (y `FIERRO_API` de los scripts de operación) a la oficial.
