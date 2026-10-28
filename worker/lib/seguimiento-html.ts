// Página pública de seguimiento: HTML completo generado en el servidor, sin recursos externos (ni tipografías, ni imágenes de terceros, ni scripts de terceros).
// Así no hay nada que pueda filtrar el enlace por cabeceras de referencia, la página carga rápido en cualquier celular y funciona aunque falle el resto de la aplicación.
// Todo texto que viene de la base se escapa: el mensaje del taller es texto plano, nunca HTML.
//
// Sprint 25: la página tiene cuatro bloques — encabezado del taller (el protagonista), datos del vehículo y estado de la reparación, resumen de pago (importe total, saldo, elección
// del medio, datos de transferencia y envío del comprobante) y un pie discreto «Gestionado con ORVELAN». Funciona sin JavaScript (formularios comunes); un script en línea con
// `nonce` agrega comodidades (copiar el alias, vista previa del archivo, evitar el doble envío) y nada más.
import type { SeguimientoPublico } from './seguimiento';
import type { CodigoPortal } from './pago-cliente';
import { ISOTIPO_ORVELAN_SVG } from './marca-orvelan';
import { LIMITES_COMPROBANTE, dineroAR } from '../../shared/pago-portal';

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
:root{color-scheme:light dark;--fondo:#eef2f5;--tarjeta:#fff;--texto:#14232b;--tenue:#566771;--borde:#d9e1e7;--marca:#0658af;--marca-fondo:#e6f1fc;--ok:#1a7f4b;--ok-fondo:#e5f5ec;--aviso:#8a5a00;--aviso-fondo:#fff4db;--rojo:#a32a2a;--rojo-fondo:#fdeaea;--gris-paso:#c3ced6;--sombra:0 1px 2px rgba(8,31,65,.06),0 4px 14px rgba(8,31,65,.04)}
@media (prefers-color-scheme:dark){:root{--fondo:#0f1a20;--tarjeta:#16262e;--texto:#e8eff3;--tenue:#9fb2bd;--borde:#2a3f4a;--marca:#5db4fb;--marca-fondo:#0f2a4a;--ok:#5fd495;--ok-fondo:#10301f;--aviso:#f1c261;--aviso-fondo:#33270c;--rojo:#f19a9a;--rojo-fondo:#3a1b1b;--gris-paso:#3c525e;--sombra:none}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--fondo);color:var(--texto);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;overflow-wrap:anywhere}
main{max-width:34rem;margin:0 auto;padding:max(1rem,env(safe-area-inset-top)) 1rem 1.25rem}
header.taller{display:flex;align-items:center;gap:.85rem;padding:.35rem .15rem 1.1rem}
header.taller .logo{flex:none;width:3.5rem;height:3.5rem;border-radius:.9rem;object-fit:contain;background:#fff;border:1px solid var(--borde)}
header.taller .mono{display:grid;place-items:center;background:var(--marca);color:#fff;border:0;font-size:1.5rem;font-weight:800}
@media (prefers-color-scheme:dark){header.taller .mono{color:#06210f}}
header.taller .tx{min-width:0}
header.taller .n{font-size:1.3rem;line-height:1.2;font-weight:800;margin:0}
header.taller .t{margin:.1rem 0 0;font-size:.85rem;color:var(--tenue)}
.tarjeta{background:var(--tarjeta);border:1px solid var(--borde);border-radius:1rem;padding:1.1rem;margin:0 0 1rem;box-shadow:var(--sombra)}
.cli{margin:0 0 .35rem;font-size:.9rem;color:var(--tenue)}.cli b{color:var(--texto);font-weight:700}
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
.entrega-linea{margin:1rem 0 0;padding-top:.85rem;border-top:1px solid var(--borde);font-size:.95rem}
.entrega-linea b{display:block;font-size:1.05rem}
.entrega-linea small{display:block;color:var(--tenue);font-size:.85rem;margin-top:.15rem}
.entrega-linea.vencida b{color:var(--aviso)}
h2{font-size:1rem;margin:0 0 .8rem}
.msg{white-space:pre-line}
.msg-fecha{display:block;margin-top:.4rem;font-size:.8rem;color:var(--tenue)}
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
details.hist{margin-top:1rem;padding-top:.4rem;border-top:1px solid var(--borde)}
details summary{cursor:pointer;font-weight:600;min-height:2.75rem;display:flex;align-items:center}
details ol{list-style:none;margin:.2rem 0 0;padding:0}
details li{display:flex;justify-content:space-between;gap:1rem;padding:.55rem 0;border-top:1px solid var(--borde);font-size:.92rem}
details li span:last-child{flex:none;color:var(--tenue);font-size:.82rem;text-align:right}
.actualizado{margin:-.25rem .25rem 1rem;color:var(--tenue);font-size:.8rem;text-align:center}
.actualizado a{color:var(--marca);font-weight:600}

.pago{border:2px solid var(--marca);scroll-margin-top:1rem}
.pago h2{display:flex;align-items:center;gap:.5rem;font-size:.8rem;letter-spacing:.07em;text-transform:uppercase;color:var(--tenue);margin:0 0 .6rem}
.etiqueta{margin:0;font-size:.85rem;color:var(--tenue)}
.monto{margin:0;font-size:2.1rem;line-height:1.15;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.montos{display:grid;grid-template-columns:1fr 1fr;gap:.75rem;margin-top:.9rem}
.montos>div{padding:.7rem .8rem;border-radius:.75rem;background:var(--fondo);min-width:0}
.montos .monto{font-size:1.3rem}
.montos .pend{background:var(--aviso-fondo)}.montos .pend .monto{color:var(--aviso)}
.sinimporte{margin:0;font-size:1.05rem;font-weight:600}
.sinimporte+p{margin:.35rem 0 0;color:var(--tenue);font-size:.9rem}
.pagado{margin:.9rem 0 0;padding:.8rem 1rem;border-radius:.8rem;background:var(--ok-fondo);border:1px solid var(--ok);color:var(--ok);font-weight:700}
.aviso{margin:0 0 1rem;padding:.8rem 1rem;border-radius:.8rem;font-size:.95rem;border:1px solid var(--marca);background:var(--marca-fondo)}
.aviso.ok{border-color:var(--ok);background:var(--ok-fondo)}.aviso.error{border-color:var(--rojo);background:var(--rojo-fondo)}
.verif{margin:.9rem 0 0;padding:.8rem 1rem;border-radius:.8rem;font-size:.95rem;border:1px solid var(--aviso);background:var(--aviso-fondo)}
.verif.rechazado{border-color:var(--rojo);background:var(--rojo-fondo)}
.verif strong{display:block}
.pregunta{margin:1.3rem 0 .6rem;font-size:1.1rem;font-weight:800}
.medios{display:grid;grid-template-columns:1fr 1fr;gap:.7rem}
.medios.uno{grid-template-columns:1fr}
.medio{appearance:none;font:inherit;color:var(--texto);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.4rem;min-height:5.2rem;padding:.8rem .25rem;border-radius:.9rem;border:2px solid var(--borde);background:var(--tarjeta);font-weight:800;font-size:.85rem;letter-spacing:.02em;text-transform:uppercase;cursor:pointer;width:100%;min-width:0;overflow-wrap:normal;word-break:keep-all}
.medio svg{width:1.8rem;height:1.8rem}
.medio[aria-pressed=true]{border-color:var(--marca);background:var(--marca-fondo);color:var(--marca)}
.medio:hover{border-color:var(--marca)}
.panel{margin-top:1rem;padding:1rem;border-radius:.9rem;background:var(--fondo)}
.panel h3{margin:0 0 .6rem;font-size:1.05rem}
.panel p{margin:.4rem 0}
.datos{margin:.9rem 0 0;display:grid;gap:.6rem}
.dato{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.5rem .7rem;padding:.7rem .8rem;border-radius:.7rem;background:var(--tarjeta);border:1px solid var(--borde)}
.dato>div{flex:1 1 11rem;min-width:0}
.dato small{display:block;font-size:.72rem;letter-spacing:.05em;text-transform:uppercase;color:var(--tenue)}
.dato b{display:block;font-size:1.02rem;word-break:break-all}
.dato.alias b{font-size:1.2rem}
.btn{appearance:none;font:inherit;display:inline-flex;align-items:center;justify-content:center;gap:.4rem;min-height:2.9rem;padding:0 1.1rem;border-radius:.75rem;border:2px solid var(--marca);background:var(--tarjeta);color:var(--marca);font-weight:700;cursor:pointer;text-decoration:none}
.btn.primario{background:var(--marca);color:#fff;width:100%;min-height:3.1rem;font-size:1.05rem}
@media (prefers-color-scheme:dark){.btn.primario{color:#06210f}}
.btn[disabled]{opacity:.55;cursor:not-allowed}
.btn.hecho{border-color:var(--ok);color:var(--ok)}
.copiar{flex:0 0 auto;min-width:5.6rem}
@media (max-width:480px){.dato .copiar{width:100%}}
.btn:focus-visible,.medio:focus-visible,details summary:focus-visible,.drop:focus-within{outline:3px solid var(--marca);outline-offset:2px}
.drop{display:flex;flex-direction:column;align-items:center;gap:.25rem;text-align:center;margin-top:.9rem;padding:1.2rem .8rem;border:2px dashed var(--marca);border-radius:.9rem;background:var(--tarjeta);cursor:pointer;min-height:5.2rem;justify-content:center}
.drop b{color:var(--marca)}
.drop small{color:var(--tenue)}
.archivo{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden}
.vista{display:flex;align-items:center;gap:.8rem;margin-top:.8rem;padding:.6rem;border-radius:.7rem;border:1px solid var(--borde);background:var(--tarjeta)}
.vista[hidden],.vista img[hidden]{display:none}
.vista img{flex:none;width:4.2rem;height:4.2rem;object-fit:cover;border-radius:.5rem}
.vista .nom{min-width:0;font-size:.9rem}.vista .nom b{display:block}.vista .nom span{color:var(--tenue)}
.err{margin:.5rem 0 0;color:var(--rojo);font-size:.9rem;font-weight:600}
form .btn.primario{margin-top:.9rem}
.nota{margin:.6rem 0 0;font-size:.82rem;color:var(--tenue)}
.envios{list-style:none;margin:1rem 0 0;padding:0}
.envios li{display:flex;flex-wrap:wrap;justify-content:space-between;gap:.2rem .8rem;padding:.6rem 0;border-top:1px solid var(--borde);font-size:.92rem}
.envios .est{font-weight:700}.envios .est.pendiente{color:var(--aviso)}.envios .est.confirmado{color:var(--ok)}.envios .est.rechazado{color:var(--rojo)}
.envios .fe{color:var(--tenue);font-size:.82rem}
.envios .mo{flex-basis:100%;font-size:.88rem;color:var(--tenue)}
.sr{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}

footer.orvelan{max-width:34rem;margin:0 auto;padding:.7rem 1rem max(.9rem,env(safe-area-inset-bottom));border-top:1px solid var(--borde);display:flex;flex-direction:column;align-items:center;gap:.1rem;color:var(--tenue);font-size:.75rem;line-height:1.35;text-align:center}
footer.orvelan .linea{display:inline-flex;align-items:center;gap:.4rem}
footer.orvelan svg{display:block;flex:none;width:20px;height:auto;max-width:100px;opacity:.85}
footer.orvelan b{font-weight:700;letter-spacing:.05em}
footer.orvelan small{font-size:.7rem;opacity:.85}
.nodisp{text-align:center;padding:2.5rem 1rem}
.nodisp h1{font-size:1.4rem;margin:0 0 .6rem}
.nodisp p{color:var(--tenue);margin:0}
@media (prefers-reduced-motion:no-preference){.paso.actual .punto{animation:pulso 2.4s ease-in-out infinite}}
@keyframes pulso{50%{box-shadow:0 0 0 .5rem transparent}}
@media (max-width:340px){.medios{grid-template-columns:1fr}.montos{grid-template-columns:1fr}}
`;

/** Isotipo con tamaño propio: el SVG de marca trae width/height de 455×400 y, sin acotarlo, el pie ocupaba media pantalla. */
const ISOTIPO_PIE = ISOTIPO_ORVELAN_SVG.replace('width="455" height="400"', 'width="20" height="18"');

const SCRIPT = `(function(){
var q=function(s){return document.querySelector(s)};
if(location.search.indexOf('m=')>-1&&window.history&&history.replaceState)history.replaceState(null,'',location.pathname+location.hash);
function fb(t){var a=document.createElement('textarea');a.value=t;a.setAttribute('readonly','');a.style.position='fixed';a.style.opacity='0';document.body.appendChild(a);a.select();var r=false;try{r=document.execCommand('copy')}catch(e){}document.body.removeChild(a);return r}
document.querySelectorAll('[data-copiar]').forEach(function(b){b.addEventListener('click',function(){var t=b.getAttribute('data-copiar');var o=b.getAttribute('data-rotulo')||b.textContent;var ok=function(){b.textContent='¡Copiado!';b.classList.add('hecho');var v=q('#vivo');if(v)v.textContent='Copiado al portapapeles';setTimeout(function(){b.textContent=o;b.classList.remove('hecho')},2200)};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(ok,function(){if(fb(t))ok()})}else if(fb(t))ok()})});
var f=q('#arch'),fm=q('#f-comp'),bt=q('#enviar');
if(f&&fm&&bt){
bt.disabled=true;
var kb=function(n){return n>=1e6?(n/1e6).toFixed(1).replace('.',',')+' MB':Math.max(1,Math.round(n/1e3))+' KB'};
f.addEventListener('change',function(){var a=f.files&&f.files[0],p=q('#vista'),im=q('#vista-img'),er=q('#arch-err');if(!a){p.hidden=true;bt.disabled=true;return}
q('#vista-nom').textContent=a.name;q('#vista-tam').textContent=kb(a.size);
if(a.type.indexOf('image/')===0&&window.URL){im.src=URL.createObjectURL(a);im.hidden=false}else{im.hidden=true}
var max=(a.type==='application/pdf'||/\\.pdf$/i.test(a.name))?${LIMITES_COMPROBANTE.pdfBytes}:${LIMITES_COMPROBANTE.imagenBytes};
if(a.size>max){er.textContent='Ese archivo pesa '+kb(a.size)+' y el máximo es '+kb(max)+'. Probá con una captura de pantalla.';bt.disabled=true}else{er.textContent='';bt.disabled=false}
p.hidden=false});
fm.addEventListener('submit',function(e){if(fm.getAttribute('data-env')){e.preventDefault();return}fm.setAttribute('data-env','1');bt.disabled=true;bt.textContent='Enviando…'});
window.addEventListener('pageshow',function(e){if(e.persisted){fm.removeAttribute('data-env');bt.textContent='Enviar comprobante';bt.disabled=!(f.files&&f.files[0])}});
}
})();`;

function documento(titulo: string, cuerpo: string, nonce?: string): string {
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
<footer class="orvelan"><span class="linea">${ISOTIPO_PIE}<span>Gestionado con <b>ORVELAN</b></span></span><small>Software de gestión para talleres.</small></footer>
${nonce ? `<script nonce="${esc(nonce)}">${SCRIPT}</script>` : ''}
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

// ───────────────────────── Pago ─────────────────────────

/** Avisos tras una acción (la página los recibe como código en `?m=`; sólo se muestran los conocidos, el resto se ignora). */
export const AVISOS: Record<CodigoPortal, { tono: 'ok' | 'info' | 'error'; texto: string }> = {
  medio_ok: { tono: 'ok', texto: 'Guardamos tu elección.' },
  efectivo_ok: { tono: 'ok', texto: 'Listo: el taller sabe que vas a pagar en efectivo al retirar tu vehículo. El pago se registra cuando entregues el dinero.' },
  comprobante_ok: { tono: 'ok', texto: 'Comprobante recibido — pendiente de verificación. El taller tiene que confirmar que recibió el dinero.' },
  comprobante_dup: { tono: 'info', texto: 'Ya habíamos recibido ese comprobante. No hace falta volver a enviarlo.' },
  e_sin_importe: { tono: 'error', texto: 'Todavía no se puede pagar desde esta página: el taller aún no confirmó el importe.' },
  e_cancelada: { tono: 'error', texto: 'Esta orden fue cancelada.' },
  e_saldado: { tono: 'info', texto: 'Esta reparación ya está paga.' },
  e_sin_cuenta: { tono: 'error', texto: 'El taller no tiene habilitadas las transferencias desde esta página. Consultá con el taller cómo pagar.' },
  e_sin_medio: { tono: 'error', texto: 'Elegí primero cómo querés pagar.' },
  e_formato: { tono: 'error', texto: 'Ese archivo no se puede usar. Enviá una imagen (JPG, PNG o WEBP) o un PDF.' },
  e_tamano: { tono: 'error', texto: `El archivo es demasiado pesado (máximo ${LIMITES_COMPROBANTE.imagenBytes / 1e6} MB para imágenes y ${LIMITES_COMPROBANTE.pdfBytes / 1e6} MB para PDF). Probá con una captura de pantalla.` },
  e_limite: { tono: 'error', texto: 'Llegaste al máximo de comprobantes para esta orden. Comunicate con el taller.' },
  e_pendientes: { tono: 'error', texto: 'Ya tenés comprobantes esperando verificación. Esperá a que el taller los revise antes de enviar otro.' },
  e_archivo: { tono: 'error', texto: 'No pudimos leer el archivo. Probá de nuevo.' },
  e_almacenamiento: { tono: 'error', texto: 'No pudimos guardar el comprobante en este momento. Probá de nuevo en unos minutos.' },
  e_origen: { tono: 'error', texto: 'No pudimos procesar el envío. Recargá la página e intentá de nuevo.' },
  e_demasiados: { tono: 'error', texto: 'Hiciste demasiados envíos seguidos. Esperá un rato y volvé a probar.' },
  e_dato: { tono: 'error', texto: 'No se pudo completar la operación. Recargá la página e intentá de nuevo.' },
};
export const codigoPortal = (v: unknown): CodigoPortal | null => (typeof v === 'string' && Object.prototype.hasOwnProperty.call(AVISOS, v) ? (v as CodigoPortal) : null);

const ICONO_EFECTIVO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.7"/><path d="M6 9.5v.01M18 14.5v.01"/></svg>';
const ICONO_TRANSFERENCIA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 10 12 4l9 6"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8"/><path d="M3 20h18"/></svg>';

function filaCopiable(etiqueta: string, valor: string, rotulo: string, clase = ''): string {
  return `<div class="dato ${clase}"><div><small>${esc(etiqueta)}</small><b>${esc(valor)}</b></div><button type="button" class="btn copiar" data-copiar="${esc(valor)}" data-rotulo="${esc(rotulo)}">${esc(rotulo)}</button></div>`;
}

function seccionPago(s: SeguimientoPublico, o: OpcionesPagina): string {
  const p = s.pago;
  if (p.situacion === 'cancelada') return '';
  const aviso = o.aviso ? `<div class="aviso ${AVISOS[o.aviso].tono}" role="status">${esc(AVISOS[o.aviso].texto)}</div>` : '';
  const titulo = `<h2 id="h-pago">Resumen de pago</h2>`;
  if (p.situacion === 'sin_importe') {
    return `<section class="tarjeta pago" id="pago" aria-labelledby="h-pago">${titulo}${aviso}<p class="sinimporte">Importe pendiente de confirmación por el taller</p><p>Apenas el taller confirme el importe de la reparación lo vas a ver acá y vas a poder elegir cómo pagar.</p></section>`;
  }
  const total = dineroAR(p.total ?? 0);
  const pendiente = dineroAR(p.pendiente ?? 0);
  const abonado = (p.abonado ?? 0) > 0;
  const montos = p.situacion === 'saldado'
    ? `<p class="etiqueta">Importe total de la reparación</p><p class="monto">${esc(total)}</p><div class="pagado">✓ La reparación está paga. ¡Gracias!</div>`
    : abonado
      ? `<p class="etiqueta">Importe total de la reparación</p><p class="monto">${esc(total)}</p><div class="montos"><div><p class="etiqueta">Abonado</p><p class="monto">${esc(dineroAR(p.abonado ?? 0))}</p></div><div class="pend"><p class="etiqueta">Saldo pendiente</p><p class="monto">${esc(pendiente)}</p></div></div>`
      : `<p class="etiqueta">Importe total de la reparación</p><p class="monto">${esc(total)}</p><div class="montos"><div class="pend" style="grid-column:1/-1"><p class="etiqueta">Saldo pendiente</p><p class="monto">${esc(pendiente)}</p></div></div>`;

  // Verificación de los comprobantes: separada del estado de la reparación y nunca «pagado» por haber cargado un archivo.
  let verif = '';
  if (p.situacion === 'pendiente' && o.aviso !== 'comprobante_ok') {
    const ultimoRechazo = p.verificacion === 'comprobante_rechazado' ? p.comprobantes.find((c) => c.estado === 'rechazado') : null;
    if (p.verificacion === 'comprobante_recibido') verif = `<div class="verif" role="status"><strong>Comprobante recibido — pendiente de verificación</strong>El taller tiene que confirmar que recibió el dinero. Hasta entonces el saldo no cambia.</div>`;
    else if (ultimoRechazo) verif = `<div class="verif rechazado" role="status"><strong>Tu último comprobante fue rechazado</strong>${ultimoRechazo.motivo ? `Motivo: ${esc(ultimoRechazo.motivo)}. ` : ''}Podés enviar otro.</div>`;
  }

  if (p.situacion === 'saldado') {
    const lista = p.comprobantes.length ? listaEnvios(s) : '';
    return `<section class="tarjeta pago" id="pago" aria-labelledby="h-pago">${titulo}${aviso}${montos}${lista}</section>`;
  }

  const sel = (m: string) => (p.medio === m ? 'true' : 'false');
  const boton = (accion: string, icono: string, etiqueta: string) =>
    `<button type="submit" name="accion" value="${accion}" class="medio" aria-pressed="${sel(accion)}">${icono}<span>${etiqueta}</span></button>`;
  const medios = `<form method="post" action="/seguimiento/${esc(o.token)}/medio"><div class="medios${p.transferencia_disponible ? '' : ' uno'}">${boton('efectivo', ICONO_EFECTIVO, 'Efectivo')}${p.transferencia_disponible ? boton('transferencia', ICONO_TRANSFERENCIA, 'Transferencia') : ''}</div></form>`;

  let panel = '';
  if (p.medio === 'efectivo') {
    panel = p.medio_estado === 'confirmado'
      ? `<div class="panel"><h3>Pago en efectivo</h3><p>Podés pagar en efectivo al retirar tu vehículo.</p><p>Saldo pendiente: <b>${esc(pendiente)}</b></p><div class="aviso ok" style="margin:.8rem 0 0">✓ Pago en efectivo registrado como previsto. El taller lo cobrará cuando retires el vehículo; todavía no figura como pagado.</div></div>`
      : `<div class="panel"><h3>Pago en efectivo</h3><p>Podés pagar en efectivo al retirar tu vehículo.</p><p>Saldo pendiente: <b>${esc(pendiente)}</b></p><form method="post" action="/seguimiento/${esc(o.token)}/medio"><button type="submit" name="accion" value="confirmar_efectivo" class="btn primario">Confirmar pago en efectivo</button></form><p class="nota">Esto avisa al taller que vas a pagar en efectivo. No es un pago: se registra cuando entregues el dinero.</p></div>`;
  } else if (p.medio === 'transferencia' && p.cuenta) {
    const c = p.cuenta;
    const cuenta = [
      c.titular ? `<div class="dato"><div><small>Titular</small><b>${esc(c.titular)}</b></div></div>` : '',
      `<div class="dato"><div><small>Banco</small><b>${esc(c.banco)}</b></div></div>`,
      c.alias ? filaCopiable('Alias', c.alias, 'Copiar alias', 'alias') : '',
      c.cbu ? filaCopiable('CBU / CVU', c.cbu, 'Copiar CBU') : '',
    ].join('');
    const envio = p.puede_enviar
      ? `<form method="post" action="/seguimiento/${esc(o.token)}/comprobante" enctype="multipart/form-data" id="f-comp">
<input type="hidden" name="k" value="${esc(o.claveEnvio)}">
<label class="drop" for="arch"><b>Tocá para elegir una captura, foto o PDF</b><small>JPG, PNG, WEBP o PDF · hasta ${LIMITES_COMPROBANTE.imagenBytes / 1e6} MB</small></label>
<input class="archivo" type="file" id="arch" name="archivo" accept="image/jpeg,image/png,image/webp,application/pdf,.jpg,.jpeg,.png,.webp,.pdf" required>
<div class="vista" id="vista" hidden><img id="vista-img" alt="Vista previa del comprobante" hidden><div class="nom"><b id="vista-nom"></b><span id="vista-tam"></span></div></div>
<p class="err" id="arch-err" role="alert"></p>
<button type="submit" class="btn primario" id="enviar">Enviar comprobante</button>
</form>
<p class="nota">Después de enviarlo, el taller verifica que el dinero haya ingresado. Recién ahí se registra el pago.</p>`
      : p.limite_envio === 'pendientes'
        ? `<p class="nota">Ya tenés comprobantes esperando verificación: el taller los va a revisar.</p>`
        : p.limite_envio === 'total'
          ? `<p class="nota">Llegaste al máximo de comprobantes para esta orden. Comunicate con el taller.</p>`
          : '';
    panel = `<div class="panel"><h3>Transferencia bancaria</h3><p class="etiqueta">Importe pendiente</p><p class="monto">${esc(pendiente)}</p><div class="datos" aria-label="Datos bancarios del taller">${cuenta}</div><h3 style="margin-top:1.2rem">Adjuntar comprobante de transferencia</h3>${envio}</div>`;
  }
  const envios = p.comprobantes.length ? listaEnvios(s) : '';
  return `<section class="tarjeta pago" id="pago" aria-labelledby="h-pago">${titulo}${aviso}${montos}${verif}<p class="pregunta" id="q-pago">¿Cómo querés pagar?</p>${medios}${panel}${envios}<span id="vivo" class="sr" role="status" aria-live="polite"></span></section>`;
}

function listaEnvios(s: SeguimientoPublico): string {
  const tz = s.zona_horaria;
  const ROT = { pendiente: 'Pendiente de verificación', confirmado: 'Pago confirmado', rechazado: 'Rechazado' } as const;
  return `<ul class="envios" aria-label="Comprobantes enviados">${s.pago.comprobantes
    .map((c) => `<li><span class="est ${c.estado}">${ROT[c.estado]}</span><span class="fe">${esc(fechaHoraCorta(c.at, tz))}</span>${c.motivo ? `<span class="mo">Motivo: ${esc(c.motivo)}</span>` : ''}</li>`)
    .join('')}</ul>`;
}

export interface OpcionesPagina {
  /** Token del enlace: arma las direcciones de las acciones y del logotipo de esta página (no sale en ningún otro lado). */
  token: string;
  nonce: string;
  aviso: CodigoPortal | null;
  /** Clave de reintento del formulario de comprobante: el mismo formulario enviado dos veces no duplica el envío. */
  claveEnvio: string;
}

export function paginaSeguimiento(s: SeguimientoPublico, o: OpcionesPagina): string {
  const tz = s.zona_horaria;
  const vehiculo = [s.vehiculo.marca, s.vehiculo.modelo].filter(Boolean).join(' ') || 'Tu vehículo';

  const logo = s.taller.logo
    ? `<img class="logo" src="/seguimiento/${esc(o.token)}/logo" alt="" width="56" height="56">`
    : `<span class="logo mono" aria-hidden="true">${esc((s.taller.nombre.trim()[0] ?? '·').toUpperCase())}</span>`;

  const mensaje = s.mensaje
    ? `<section class="tarjeta" aria-labelledby="h-msg"><h2 id="h-msg">Mensaje del taller</h2><div class="msg">${esc(s.mensaje.texto)}</div><span class="msg-fecha">${esc(fechaHoraCorta(s.mensaje.at, tz))}</span></section>`
    : '';

  let entrega = '';
  if (s.entrega) {
    entrega = s.entrega.vencida
      ? `<p class="entrega-linea vencida"><small>Fecha estimada de entrega</small><b>Estaba prevista para el ${esc(fechaCorta(s.entrega.fecha))}</b><small>Esa fecha ya pasó y todavía no tenemos una nueva confirmada. Consultá con el taller para saber cuándo estará listo.</small></p>`
      : `<p class="entrega-linea"><small>Fecha estimada de entrega</small><b>${esc(fechaLarga(s.entrega.fecha))}</b><small>Es una estimación: puede cambiar según cómo avance el trabajo.</small></p>`;
  }

  const pasos = s.recorrido
    .map((p) => {
      const fecha = p.at && p.situacion !== 'pendiente' ? `<div class="fe">${esc(fechaHoraCorta(p.at, tz))}</div>` : '';
      const sit = p.situacion === 'hecho' ? 'hecho' : p.situacion === 'actual' ? 'actual' : 'pendiente';
      const lectura = p.situacion === 'hecho' ? ' (completado)' : p.situacion === 'actual' ? ' (etapa actual)' : ' (pendiente)';
      return `<li class="paso ${sit}"${p.situacion === 'actual' ? ' aria-current="step"' : ''}><span class="punto" aria-hidden="true">${MARCAS_PASO[sit]}</span><div class="tx"><div class="ti">${esc(p.titulo)}<span class="sr">${lectura}</span></div>${p.situacion === 'actual' ? `<div class="de">${esc(p.detalle)}</div>` : ''}${fecha}</div></li>`;
    })
    .join('');
  const hist = s.historial.length
    ? `<details class="hist"><summary>Ver historial completo (${s.historial.length})</summary><ol>${s.historial.map((h) => `<li><span>${esc(h.titulo)}</span><span>${esc(fechaHoraCorta(h.at, tz))}</span></li>`).join('')}</ol></details>`
    : '';
  const recorrido = pasos || hist ? `<section class="tarjeta" aria-labelledby="h-rec"><h2 id="h-rec">Cómo va la reparación</h2>${pasos ? `<ol class="pasos">${pasos}</ol>` : ''}${hist}</section>` : '';

  const cuerpo = `<header class="taller">${logo}<div class="tx"><p class="n">${esc(s.taller.nombre)}</p><p class="t">Seguimiento de tu vehículo</p></div></header>
<section class="tarjeta" aria-labelledby="h-veh">
${s.cliente ? `<p class="cli">Cliente: <b>${esc(s.cliente.nombre)}</b></p>` : ''}<h1 class="veh" id="h-veh">${esc(vehiculo)}</h1>
<p class="meta">Patente <b>${esc(s.vehiculo.patente)}</b> · Orden N° ${esc(s.orden.referencia)}</p>
<div class="estado ${esc(s.estado.tono)}" role="status"><small>Estado actual</small><strong>${esc(s.estado.titulo)}</strong><p>${esc(s.estado.explicacion)}</p></div>
${s.estado.listo ? '<div class="listo-aviso">¡Tu vehículo está listo para retirar!</div>' : ''}${entrega}
</section>
${mensaje}${recorrido}${seccionPago(s, o)}
<p class="actualizado">Última actualización: ${esc(fechaHoraCorta(s.actualizado_at, tz))} · <a href="">Actualizar</a><br>Quien tenga este enlace puede ver el estado de la reparación. No hace falta iniciar sesión.</p>`;
  return documento(`Seguimiento · ${s.taller.nombre}`, cuerpo, o.nonce);
}
