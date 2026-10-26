// Página pública de seguimiento: HTML completo generado en el servidor, sin JavaScript, sin recursos externos (ni tipografías, ni imágenes, ni scripts de terceros).
// Así no hay nada que pueda filtrar el enlace por cabeceras de referencia, la página carga rápido en cualquier celular y funciona aunque falle el resto de la aplicación.
// Todo texto que viene de la base se escapa: el mensaje del taller es texto plano, nunca HTML.
import type { SeguimientoPublico } from './seguimiento';
import { ISOTIPO_ORVELAN_SVG } from './marca-orvelan';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: string | null | undefined) => (s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function partes(iso: string, tz: string): Record<string, string> | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const o: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d)) o[p.type] = p.value;
  return o;
}
/** «24/10/2026 · 14:30» en la zona del taller. */
export function fechaHoraCorta(iso: string, tz: string): string {
  const p = partes(iso, tz);
  return p ? `${p.day}/${p.month}/${p.year} · ${p.hour}:${p.minute}` : '';
}
/** «viernes 30 de octubre» de una fecha AAAA-MM-DD (se interpreta como fecha de calendario: no depende de ninguna zona). */
export function fechaLarga(f: string): string {
  const [y, m, d] = f.split('-').map(Number);
  const dia = DIAS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${dia} ${d} de ${MESES[m - 1]}`;
}
const fechaCorta = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;

const CSS = `
:root{color-scheme:light dark;--fondo:#eef2f5;--tarjeta:#fff;--texto:#14232b;--tenue:#5a6b75;--borde:#d9e1e7;--marca:#0658af;--marca-fondo:#e6f1fc;--ok:#1a7f4b;--ok-fondo:#e5f5ec;--aviso:#8a5a00;--aviso-fondo:#fff4db;--rojo:#a32a2a;--rojo-fondo:#fdeaea;--gris-paso:#c3ced6}
@media (prefers-color-scheme:dark){:root{--fondo:#0f1a20;--tarjeta:#16262e;--texto:#e8eff3;--tenue:#9fb2bd;--borde:#2a3f4a;--marca:#5db4fb;--marca-fondo:#0f2a4a;--ok:#5fd495;--ok-fondo:#10301f;--aviso:#f1c261;--aviso-fondo:#33270c;--rojo:#f19a9a;--rojo-fondo:#3a1b1b;--gris-paso:#3c525e}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--fondo);color:var(--texto);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;overflow-wrap:anywhere}
main{max-width:34rem;margin:0 auto;padding:max(1rem,env(safe-area-inset-top)) 1rem max(2rem,env(safe-area-inset-bottom))}
header.taller{padding:.5rem .25rem 1rem}
header.taller .t{font-size:.8rem;letter-spacing:.06em;text-transform:uppercase;color:var(--tenue)}
header.taller .n{font-size:1.2rem;font-weight:700;margin:.1rem 0 0}
.tarjeta{background:var(--tarjeta);border:1px solid var(--borde);border-radius:1rem;padding:1.1rem;margin:0 0 1rem;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.veh{font-size:1.5rem;line-height:1.2;font-weight:800;margin:0}
.meta{margin:.35rem 0 0;color:var(--tenue);font-size:.95rem}
.meta b{color:var(--texto);letter-spacing:.08em}
.estado{margin-top:1rem;border-radius:.85rem;padding:1rem;background:var(--marca-fondo);border:1px solid var(--marca)}
.estado small{display:block;font-size:.75rem;letter-spacing:.06em;text-transform:uppercase;color:var(--tenue)}
.estado strong{display:block;font-size:1.45rem;line-height:1.2;margin:.15rem 0 .35rem;color:var(--marca)}
.estado p{margin:0}
.estado.espera{background:var(--aviso-fondo);border-color:var(--aviso)}.estado.espera strong{color:var(--aviso)}
.estado.listo{background:var(--ok-fondo);border-color:var(--ok)}.estado.listo strong{color:var(--ok)}
.estado.cancelado{background:var(--rojo-fondo);border-color:var(--rojo)}.estado.cancelado strong{color:var(--rojo)}
.estado.cerrado{background:var(--ok-fondo);border-color:var(--ok)}.estado.cerrado strong{color:var(--ok)}
.listo-aviso{margin:1rem 0 0;padding:.9rem 1rem;border-radius:.85rem;background:var(--ok);color:#fff;font-weight:700;font-size:1.1rem;text-align:center}
@media (prefers-color-scheme:dark){.listo-aviso{color:#06210f}}
h2{font-size:1rem;margin:0 0 .8rem}
.msg{white-space:pre-line}
.msg-fecha{display:block;margin-top:.4rem;font-size:.8rem;color:var(--tenue)}
.entrega b{font-size:1.1rem}
.entrega p{margin:.35rem 0 0;color:var(--tenue);font-size:.9rem}
.entrega.vencida{background:var(--aviso-fondo);border-color:var(--aviso)}
.pasos{list-style:none;margin:0;padding:0}
.paso{position:relative;display:flex;gap:.8rem;padding:0 0 1.15rem}
.paso:last-child{padding-bottom:0}
.paso::before{content:"";position:absolute;left:.85rem;top:1.8rem;bottom:0;width:2px;background:var(--gris-paso)}
.paso:last-child::before{display:none}
.paso.hecho::before{background:var(--ok)}
.punto{flex:none;width:1.7rem;height:1.7rem;border-radius:50%;display:grid;place-items:center;font-size:.9rem;font-weight:800;border:2px solid var(--gris-paso);color:var(--tenue);background:var(--tarjeta)}
.paso.hecho .punto{background:var(--ok);border-color:var(--ok);color:#fff}
.paso.actual .punto{border-color:var(--marca);background:var(--marca);color:#fff;box-shadow:0 0 0 .3rem var(--marca-fondo)}
@media (prefers-color-scheme:dark){.paso.hecho .punto,.paso.actual .punto{color:#06210f}}
.paso .tx{min-width:0;padding-top:.1rem}
.paso .ti{font-weight:600}
.paso.pendiente .ti{color:var(--tenue);font-weight:500}
.paso.actual .ti{font-size:1.05rem;font-weight:800}
.paso .de{font-size:.88rem;color:var(--tenue)}
.paso .fe{font-size:.8rem;color:var(--tenue)}
details summary{cursor:pointer;font-weight:600;min-height:2.75rem;display:flex;align-items:center}
details ol{list-style:none;margin:.2rem 0 0;padding:0}
details li{display:flex;justify-content:space-between;gap:1rem;padding:.55rem 0;border-top:1px solid var(--borde);font-size:.92rem}
details li span:last-child{flex:none;color:var(--tenue);font-size:.82rem;text-align:right}
.pie{color:var(--tenue);font-size:.85rem;text-align:center;margin:1.2rem 0 0}
.pie a.btn{display:inline-flex;align-items:center;justify-content:center;min-height:2.75rem;padding:0 1.2rem;margin:.6rem 0 .2rem;border:1px solid var(--marca);border-radius:.7rem;color:var(--marca);font-weight:700;text-decoration:none}
.pie a.btn:focus-visible,details summary:focus-visible{outline:3px solid var(--marca);outline-offset:2px}
.sr{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.orvelan{display:flex;align-items:center;justify-content:center;gap:.4rem;margin:1.5rem 0 .5rem;font-size:.75rem;color:var(--tenue)}.orvelan svg{flex:none}
.nodisp{text-align:center;padding:2.5rem 1rem}
.nodisp h1{font-size:1.4rem;margin:0 0 .6rem}
.nodisp p{color:var(--tenue);margin:0}
@media (prefers-reduced-motion:no-preference){.paso.actual .punto{animation:pulso 2.4s ease-in-out infinite}}
@keyframes pulso{50%{box-shadow:0 0 0 .5rem transparent}}
`;

function documento(titulo: string, cuerpo: string): string {
  return `<!doctype html>
<html lang="es-AR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow,noarchive,nosnippet,noimageindex">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#081F41">
<title>${esc(titulo)}</title>
<meta property="og:title" content="Seguimiento de tu vehículo">
<meta property="og:description" content="Consultá el estado de la reparación.">
<style>${CSS}</style>
</head>
<body>
<main>
${cuerpo}
</main>
<footer class="orvelan">${ISOTIPO_ORVELAN_SVG}<span>ORVELAN Sistemas · Taller Mecánico</span></footer>
</body>
</html>`;
}

/** Enlace inexistente, desactivado o reemplazado: el mismo texto para los tres casos (no revela cuál es). */
export function paginaNoDisponible(): string {
  return documento(
    'Seguimiento no disponible',
    `<div class="tarjeta nodisp"><h1>Este enlace no está disponible</h1><p>Puede que el taller lo haya desactivado o reemplazado por uno nuevo. Pedile al taller el enlace actualizado.</p></div>`,
  );
}

export function paginaDemasiadosIntentos(): string {
  return documento('Demasiados intentos', `<div class="tarjeta nodisp"><h1>Demasiados intentos</h1><p>Esperá unos minutos y volvé a probar.</p></div>`);
}

const MARCAS_PASO: Record<string, string> = { hecho: '✓', actual: '●', pendiente: '' };

export function paginaSeguimiento(s: SeguimientoPublico): string {
  const tz = s.zona_horaria;
  const vehiculo = [s.vehiculo.marca, s.vehiculo.modelo].filter(Boolean).join(' ') || 'Tu vehículo';

  const mensaje = s.mensaje
    ? `<section class="tarjeta" aria-labelledby="h-msg"><h2 id="h-msg">Mensaje del taller</h2><div class="msg">${esc(s.mensaje.texto)}</div><span class="msg-fecha">${esc(fechaHoraCorta(s.mensaje.at, tz))}</span></section>`
    : '';

  let entrega = '';
  if (s.entrega) {
    entrega = s.entrega.vencida
      ? `<section class="tarjeta entrega vencida" aria-labelledby="h-ent"><h2 id="h-ent">Fecha estimada de entrega</h2><b>Estaba prevista para el ${esc(fechaCorta(s.entrega.fecha))}</b><p>Esa fecha ya pasó y todavía no tenemos una nueva confirmada. Consultá con el taller para saber cuándo estará listo.</p></section>`
      : `<section class="tarjeta entrega" aria-labelledby="h-ent"><h2 id="h-ent">Fecha estimada de entrega</h2><b>${esc(fechaLarga(s.entrega.fecha))}</b><p>Es una estimación: puede cambiar según cómo avance el trabajo.</p></section>`;
  }

  const pasos = s.recorrido
    .map((p) => {
      const fecha = p.at && p.situacion !== 'pendiente' ? `<div class="fe">${esc(fechaHoraCorta(p.at, tz))}</div>` : '';
      const sit = p.situacion === 'hecho' ? 'hecho' : p.situacion === 'actual' ? 'actual' : 'pendiente';
      const lectura = p.situacion === 'hecho' ? ' (completado)' : p.situacion === 'actual' ? ' (etapa actual)' : ' (pendiente)';
      return `<li class="paso ${sit}"${p.situacion === 'actual' ? ' aria-current="step"' : ''}><span class="punto" aria-hidden="true">${MARCAS_PASO[sit]}</span><div class="tx"><div class="ti">${esc(p.titulo)}<span class="sr">${lectura}</span></div>${p.situacion === 'actual' ? `<div class="de">${esc(p.detalle)}</div>` : ''}${fecha}</div></li>`;
    })
    .join('');
  const recorrido = pasos ? `<section class="tarjeta" aria-labelledby="h-rec"><h2 id="h-rec">Cómo va la reparación</h2><ol class="pasos">${pasos}</ol></section>` : '';

  const hist = s.historial.length
    ? `<section class="tarjeta"><details><summary>Ver historial completo (${s.historial.length})</summary><ol>${s.historial.map((h) => `<li><span>${esc(h.titulo)}</span><span>${esc(fechaHoraCorta(h.at, tz))}</span></li>`).join('')}</ol></details></section>`
    : '';

  const cuerpo = `<header class="taller"><div class="t">Seguimiento de tu vehículo</div><p class="n">${esc(s.taller.nombre)}</p></header>
<section class="tarjeta" aria-labelledby="h-veh">
<h1 class="veh" id="h-veh">${esc(vehiculo)}</h1>
<p class="meta">Patente <b>${esc(s.vehiculo.patente)}</b> · Orden N° ${esc(s.orden.referencia)}</p>
<div class="estado ${esc(s.estado.tono)}" role="status"><small>Estado actual</small><strong>${esc(s.estado.titulo)}</strong><p>${esc(s.estado.explicacion)}</p></div>
${s.estado.listo ? '<div class="listo-aviso">¡Tu vehículo está listo para retirar!</div>' : ''}
</section>
${mensaje}${entrega}${recorrido}${hist}
<p class="pie">Última actualización: ${esc(fechaHoraCorta(s.actualizado_at, tz))}<br>Esta página muestra la información al momento de abrirla.<br><a class="btn" href="">Actualizar</a><br>No hace falta iniciar sesión. Si compartís este enlace, quien lo tenga podrá ver el estado de la reparación.</p>`;
  return documento(`Seguimiento · ${s.taller.nombre}`, cuerpo);
}
