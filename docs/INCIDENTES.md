# Recuperación ante incidentes — guía del operador de Fierro

Estado al **22/10/2026 (Sprint 13)**. Es una guía de **qué mirar y qué hacer**, no una lista de promesas: cada procedimiento dice si ya se ensayó y dónde. Para el detalle de respaldos y restauración, ver `docs/RESPALDOS.md`; para capacidad, `docs/CAPACIDAD.md`.

## 0. Primer paso siempre: mirar la salud de la plataforma

```bash
npm run platform -- salud
```

Muestra, en un solo informe (solo lectura): si el **mantenimiento periódico** (Cron cada 5 minutos) está corriendo, la **cola de contabilización** (pendientes, fallidas, la más antigua y qué talleres), los **eventos de seguridad** de las últimas 24 h, los **errores no controlados del Worker** y cuándo llegó el último **aviso de respaldo externo**. Las `alertas` en la parte superior resumen lo que requiere atención. (Equivale a `GET /api/platform/salud` con el token de plataforma. Contra producción: `FIERRO_API=https://taller-mecanico.estrubia455.workers.dev PLATFORM_ADMIN_TOKEN=… npm run platform -- salud`, con el token cargado en tu terminal y no en el historial de comandos.)

| Alerta | Qué significa | Ir a |
|---|---|---|
| «El mantenimiento periódico no corre desde …» / «nunca registró actividad» | El Cron Trigger no está desplegado o se detuvo | §1 |
| «N operación(es) agotaron los reintentos de contabilización» | Hay operaciones comerciales correctas que no pudieron contabilizarse | §2 |
| «Hay operaciones esperando contabilización desde …» (> 30 min) | La cola no se está vaciando | §2 |
| «El último respaldo externo informó un error» / «fue el … (hace más de 36 h)» / «Nunca se recibió aviso» | El respaldo programado falló, se detuvo o no está configurado | §3 |
| «N inicios de sesión fallidos en 24 h» / «bloqueo(s) temporal(es)» | Intentos repetidos de entrar (ver §4) | §4 |
| «N error(es) no controlados del Worker en 24 h» | Errores 500 (ruta y mensaje depurado en el informe) | §5 |

## 1. El mantenimiento periódico no corre

**Qué es:** un *Cron Trigger* gratuito de Cloudflare (`wrangler.jsonc › triggers.crons`, cada 5 minutos) que (a) vacía las colas de contabilización pendientes de cualquier taller, (b) avanza las reconciliaciones y (c) deja un latido (`plataforma_latidos`). **No es imprescindible para que el sistema funcione**: cada operación comercial contabiliza lo suyo al terminar; el Cron recupera lo que se haya perdido (por ejemplo, un Worker que terminó antes de contabilizar).

**Si no corre:** 1) en el panel de Cloudflare › Workers › `taller-mecanico` › Settings › Triggers verificar que figure el Cron `*/5 * * * *`; 2) si no figura: **Workers Builds publica con `wrangler versions upload`, que no registra los Cron Triggers** (ya pasó en el Sprint 13). Aplicarlos con `npx wrangler triggers deploy --name taller-mecanico` (gratuito; debe mostrar `schedule: */5 * * * *`). Los crons son una configuración del Worker, no de cada versión: los despliegues siguientes la conservan, pero hay que repetir el comando si se cambia la lista en `wrangler.jsonc`; 3) mientras tanto, forzarlo a mano: `npm run platform -- mantenimiento` (hace exactamente lo mismo que el Cron).

## 2. Operaciones sin contabilizar

**Garantías (probadas en `tests/api/cola-contable.test.ts`):** el pedido de contabilizar nace **dentro de la misma transacción** que la operación (triggers de la base): si la operación se confirma, el pedido existe; si se revierte, no. Un pedido **solo sale de la cola cuando su asiento quedó registrado**. Si falla, se reintenta con espera creciente (1, 5, 15, 60, 240 minutos) y a los 6 intentos queda como **fallida**, visible, sin perderse. La operación comercial nunca se bloquea ni se pierde.

**Qué hacer:**
1. Ver el motivo: en la app, Contabilidad › Controles (propietario/administrador) o `GET /api/contabilidad/cola` (cada pedido con su `ultimo_error`).
2. Corregir la causa (típico: una cuenta contable del sistema desactivada, importes de un documento que no cierran).
3. Reintentar: botón **Reintentar** del aviso de Contabilidad (o `POST /api/contabilidad/sincronizar {"reintentar": true}`). Es idempotente: no duplica asientos.
4. **Nunca** se ajustan saldos para que cuadre. Un documento cuyos importes no cierran queda en `contab_omitidos` con su motivo hasta que se corrija en origen.

**Verificación completa de un taller** (por si se sospecha que algo nunca llegó a la cola): `POST /api/contabilidad/sincronizar {"completa": true}`. Recorre todo el historial **por lotes** (hasta 400 asientos por pasada, el progreso queda en la base) y contabiliza lo que falte. El mantenimiento lo hace solo, una vez por semana y por taller, de forma escalonada.

## 3. Respaldos

- **Falla o no llega el respaldo programado:** GitHub envía un correo por cada ejecución fallida del workflow «Respaldo D1» y la salud de la plataforma avisa si pasaron más de 36 horas sin un aviso correcto. Ver el registro de la ejecución en GitHub › Actions (solo muestra cantidades; nunca datos).
- **GitHub desactiva los workflows programados de un repositorio público tras 60 días sin actividad.** Si «hace más de 36 h» aparece y el repositorio estuvo quieto, activarlo de nuevo en Actions › Respaldo D1 › Enable workflow (o con cualquier commit).
- **Hay que recuperar datos:** ver `docs/RESPALDOS.md` §3 (Time Travel para todo el sistema, `.sql` sobre una base nueva) y §8 (restauración sobre una instancia aislada, ya ensayada: `npm run respaldo -- restaurar-aislado`).
- **Antes de cualquier restauración en producción:** congelar despliegues, hacer un respaldo del estado actual (`npm run respaldo -- plataforma --etiqueta incidente`) y anotar el *bookmark* de Time Travel. **No existe** restaurar un solo taller: no se improvisa.

## 4. Intentos de inicio de sesión abusivos

**Qué hace el sistema solo (probado en `tests/api/login-seguridad.test.ts`):**

| Contador | Umbral | Bloqueo |
|---|---|---|
| Por **origen** (muchas cuentas probadas desde un mismo lugar) | 25 fallos / 15 min | 15 min, para ese origen |
| Por **cuenta + origen** (alguien que se equivoca de clave) | 5 fallos / 15 min | 15 min, para esa cuenta desde ese origen |
| Por **cuenta** (ataque repartido en muchos orígenes) | 30 fallos / 60 min | 10 min, **excepto** para orígenes desde los que esa cuenta ya entró bien en los últimos 30 días |

Todos los bloqueos **vencen solos**; nadie queda bloqueado de forma permanente por acciones de un tercero. Un correo inexistente y una clave incorrecta responden exactamente igual (y tardan lo mismo: se verifica contra un hash de relleno). Un inicio de sesión correcto reinicia los contadores de esa cuenta desde ese origen.

**Qué ver:** `npm run platform -- salud` → sección de seguridad (fallos y bloqueos de 24 h, los orígenes con más fallos como huellas de 12 caracteres: se pueden **comparar** entre eventos pero no revelan la IP). Los eventos están en la tabla `eventos_seguridad` (se conservan 90 días). **No hay contraseñas, correos ni IP en claro.**

**Si una persona legítima queda bloqueada:** esperar 15 minutos o intentar desde otra red; el propietario puede además restablecer su contraseña. Si hay un ataque sostenido, el bloqueo por origen ya lo frena; ante un ataque distribuido masivo, activar «Under Attack»/reglas de rate limiting de Cloudflare (herramienta gratuita del panel, fuera de este repositorio).

## 5. Errores del Worker (HTTP 500)

Se agrupan por problema en `errores_worker` (método, **ruta normalizada** —sin ids—, mensaje **depurado** —sin correos, números largos ni valores entre comillas—, cantidad y última vez). Se ven en `npm run platform -- salud`. Para el detalle técnico: `npx wrangler tail taller-mecanico` (registros en vivo del Worker; no llevan cuerpos ni cabeceras). Un error que se repite tras un despliegue indica una regresión: revertir al commit anterior (push de un `git revert` a `main`) y analizar.

## 6. Migración mala o borrado masivo

1. Congelar cambios (no desplegar).
2. `npm run respaldo -- plataforma --etiqueta incidente` del estado actual (antes de tocar nada).
3. Elegir el *bookmark*: `wrangler d1 time-travel info DB --timestamp=<momento anterior al problema>`.
4. `wrangler d1 time-travel restore DB --bookmark=<bookmark>` (todo el sistema; devuelve un bookmark para deshacer la restauración).
5. `npm run verificar:online` y los controles contables; avisar a los talleres del período perdido.

## 7. Pérdida de la cuenta de Cloudflare

Es el caso que Time Travel no cubre. Requiere el **respaldo externo cifrado** (artefactos de GitHub Actions) **y** la clave privada. Procedimiento: `docs/RESPALDOS.md` §4 (crear una D1 nueva, cargar el `.sql` descifrado, configurar secretos, desplegar). **Mientras el workflow no haya corrido de verdad al menos una vez (ver el estado real en `docs/PROGRESO.md`), este caso NO está cubierto.**
