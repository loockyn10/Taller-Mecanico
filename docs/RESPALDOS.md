# Respaldos, exportación y recuperación de Fierro

Estado al **22/10/2026 (Sprint 13)**. Este documento separa cuatro cosas que no deben mezclarse y dice, para cada una, qué existe hoy, qué se verificó y qué falta.

| # | Necesidad | Quién la hace | Qué existe hoy | Estado |
|---|---|---|---|---|
| 1 | **Respaldo de toda la plataforma** | Operador de Fierro | `wrangler d1 export` + Time Travel; `npm run respaldo -- plataforma` (manual) y `programado` (GitHub Actions, cifrado) lo automatizan y lo verifican | **Disponible**. Respaldo programado y cifrado **preparado** (§7); **aún sin una ejecución real en GitHub Actions** |
| 2 | **Exportación de los datos de UN taller** | Operador (por pedido del propietario) | `npm run respaldo -- exportar-taller` (JSON + CSV, sin credenciales ni datos ajenos) | **Disponible para el operador**. El propietario **no** puede exportar solo: P1 |
| 3 | **Restauración ante un incidente** | Operador | Time Travel de Cloudflare (todo o nada, toda la base) o el `.sql` sobre una base nueva | **Disponible, con límites claros** (ver 3). Restaurar UN taller: **no existe** y no se improvisa |
| 4 | **Migración hacia otra instalación** | Operador | El `.sql` completo en una base vacía con las migraciones al día; o la exportación del punto 2 para llevar un taller | **Disponible a nivel de plataforma**; por taller solo como datos (no restaurable) |

> **Regla de oro:** el respaldo de la plataforma contiene **todos los talleres** y los **hashes de las contraseñas**. No se entrega a ningún cliente, no se sube a git (`respaldos/` está en `.gitignore`) y si se guarda fuera del equipo se cifra. Lo único que puede recibir un propietario es la exportación de su propio taller (punto 2).

---

## 1. Respaldo de toda la plataforma

**Procedimiento (antes de cualquier migración remota):**

```bash
npm run respaldo -- plataforma --etiqueta antes-sprint13
```

Hace, en orden: `wrangler d1 export DB --remote` → `respaldos/d1-<etiqueta>-<fecha>.sql`; anota el *bookmark* de Time Travel (`wrangler d1 time-travel info DB`); **carga el archivo en una base en memoria** (ensayo de restauración) y comprueba `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, filas por tabla, talleres contenidos y migraciones aplicadas frente a las del proyecto; y deja `…sql.manifiesto.json` con la huella SHA‑256, el bookmark y los conteos. Si la verificación falla, el comando termina con error.

Antes de aplicar una migración remota, **ensayarla sobre el respaldo** (copia en memoria; no toca ninguna base real). Demuestra que las filas y el contenido de las columnas previas de cada tabla quedan idénticos y que la base sigue íntegra:

```bash
npm run respaldo -- ensayar-migraciones respaldos/d1-antes-sprint13-<fecha>.sql
```

Para revisar un respaldo ya existente (por ejemplo antes de usarlo):

```bash
npm run respaldo -- verificar respaldos/d1-antes-sprint11-20261022.sql
```

Resultado real sobre el respaldo del Sprint 11 (copia de producción, 22/10/2026): integridad **ok**, **0** claves foráneas rotas, **86** tablas, **3.740** filas, dos talleres, 10 migraciones aplicadas (las 0011 y 0012 figuran como pendientes respecto del proyecto, que es lo esperado en un respaldo previo a esas migraciones).

**Límites que conviene conocer**
- **Respaldos programados:** preparados en el Sprint 13 (ver §7) pero **todavía sin una ejecución real en GitHub Actions** (faltan las credenciales y la clave que solo puede cargar el propietario). Hasta entonces el único resguardo automático es Time Travel (30 días según la [documentación de Cloudflare](https://developers.cloudflare.com/d1/reference/time-travel/); esa página no confirma si la ventana difiere entre el plan gratuito y el pago: verificarlo en la cuenta).
- Time Travel y los `.sql` viven en la misma cuenta de Cloudflare: **no protegen contra la pérdida de la cuenta**. Guardar copias cifradas fuera de Cloudflare es una decisión operativa pendiente (no se contrató ni se configuró ningún servicio externo).
- `wrangler d1 export` puede dejar la base momentáneamente no disponible mientras exporta. Con el tamaño actual (≈ 1,6 MB) es imperceptible; hay que reevaluarlo cuando crezca.

## 2. Exportación de los datos de un taller

```bash
npm run respaldo -- talleres respaldos/<respaldo>.sql
npm run respaldo -- exportar-taller respaldos/<respaldo>.sql <id o nombre exacto del taller> --salida C:\ruta\nueva
```

Genera una **carpeta nueva** (no pisa nada) con `tablas/<tabla>.json` y `tablas/<tabla>.csv` por cada tabla con datos, `manifiesto.json` y `LEEME.txt`. Garantías, todas cubiertas por `tests/unit/respaldo.test.ts`:

- Solo filas con `taller_id` = ese taller (se comprueba fila por fila y la exportación aborta si encuentra otra). **Una tabla sin `taller_id` no se exporta** (se lista como omitida): mejor omitir que filtrar a ciegas.
- **Sin credenciales:** de `usuarios` se quitan `password_hash`, `pin_hash` y los contadores de PIN; no salen `sesiones`, `invitaciones_activacion`, `dispositivos_reloj` (tokens), `limites_intentos`, `d1_migrations` ni `tx_guard`.
- Los CSV neutralizan fórmulas (`=`, `+`, `-`, `@`) y escapan comillas y comas. Los importes están en centavos.
- Verificado con datos reales: el taller «Taller de Pruebas» del respaldo de producción → 177 filas en 14 tablas, **sin** ninguna mención del otro taller ni ningún hash `pbkdf2`.

**Esto no es un respaldo restaurable**: sirve para entregar, auditar o migrar a otro sistema. En una instalación nueva los usuarios deben crear contraseña nueva.

**Falta (P1):** que el propietario lo pida desde la aplicación (hoy depende del operador). Propuesta segura: permiso nuevo `datos.exportar` (propietario por defecto), el servidor arma el archivo con **las mismas reglas** (solo `taller_id` de la sesión, sin columnas secretas, lista cerrada de tablas), deja constancia en la auditoría y limita la frecuencia; por tamaño, por tablas en tandas. No debe compartir código con el flujo de respaldo de plataforma para que un error de uno no filtre el otro.

## 3. Restauración ante un incidente

| Caso | Herramienta | Alcance | Riesgo |
|---|---|---|---|
| Se rompió o borró algo **en toda la plataforma** (migración mala, borrado masivo) | `wrangler d1 time-travel restore DB --bookmark=<bookmark>` (o `--timestamp`) | **Toda la base, todos los talleres**, en el lugar | Se pierde **todo** lo que cargaron *todos* los talleres después de ese punto. Cancela consultas en curso. Devuelve un *bookmark* para deshacer la restauración |
| Se perdió la base | Crear una D1 nueva, aplicar las migraciones y cargar el `.sql` (ver 4) | Toda la plataforma, hasta el momento del respaldo | Lo posterior al respaldo se pierde |
| **Un solo taller** pide volver atrás | **No existe y no se debe improvisar** | — | Ver abajo |

**Por qué no hay restauración parcial por taller (y por qué no se hizo un parche):** las filas de un taller están encadenadas por claves foráneas compuestas, secuencias de numeración (`secuencias`), stock por depósito, saldos de caja, cuentas corrientes y una contabilidad **inmutable** cuyos asientos se numeran correlativamente y se derivan de las operaciones. Reinsertar tablas de un taller en una base viva puede duplicar números, desbalancear el stock con los depósitos, dejar asientos sin su operación (o al revés) o pisar datos que el taller cargó después. Un parche que "parezca funcionar" y deje esas inconsistencias es peor que no tenerlo.

**Propuesta segura (P2, desarrollo considerable):**
1. *Restaurar a un taller NUEVO y vacío*, nunca fusionar con uno existente: un importador transaccional lee el paquete de exportación (punto 2), **remapea los ids** y reconstruye tabla por tabla en el orden de las claves foráneas.
2. Tras importar, correr automáticamente los controles que ya existen (`/cuentas-corrientes/verificar`, `/inventario/verificar`, controles de Contabilidad, `PRAGMA foreign_key_check`) y **no habilitar el taller restaurado** si alguno falla.
3. Previamente: ensayo de restauración automático y periódico (exportar → importar a un taller temporal → comparar saldos) para saber que funciona *antes* del incidente.
4. El taller original no se toca; el propietario compara y decide cuál usar.

**Procedimiento de incidente (plataforma):** 1) congelar cambios (no desplegar); 2) `npm run respaldo -- plataforma --etiqueta incidente` del estado actual **antes** de restaurar; 3) elegir el *bookmark* (`wrangler d1 time-travel info DB --timestamp=<momento anterior al problema>`); 4) restaurar; 5) `npm run verificar:online` y los controles contables; 6) avisar a los talleres del período perdido.

## 4. Migración a otra instalación

1. Crear la D1 nueva y volcar el respaldo: `wrangler d1 create <nombre>` → poner su `database_id` en `wrangler.jsonc` → `wrangler d1 execute <nombre> --remote --file respaldos/<respaldo>.sql`. El volcado incluye el esquema y la tabla `d1_migrations`, así que después `wrangler d1 migrations apply` aplica solo lo que falte.
2. Configurar los secretos (`PLATFORM_ADMIN_TOKEN`) en la instalación nueva y desplegar.
3. Verificar con `npm run verificar:online` (con un usuario de prueba) y `npm run respaldo -- verificar` sobre un export de la base nueva.
4. **Las sesiones activas no se migran** (se pide iniciar sesión de nuevo) y los dispositivos de reloj compartido deben vincularse otra vez.

Para llevar **un solo taller** a otra instalación hoy solo se puede como datos (punto 2): quien migra necesita cargarlos con el importador o con el importador de bundle propuesto arriba.

## 5. Resumen de lo que se verificó en este sprint

- `tests/unit/respaldo.test.ts` (7 pruebas): ensayo de restauración, detección de claves foráneas rotas, aislamiento y ausencia de secretos en la exportación, tabla sin `taller_id`, carpeta que no se pisa, CSV seguro y ensayo de migraciones (datos idénticos / migración que toca datos detectada / migración rota informada).
- Ejecución real de `verificar`, `talleres` y `exportar-taller` sobre `respaldos/d1-antes-sprint11-20261022.sql` (resultados arriba).
- El respaldo remoto previo a las migraciones de este sprint se generó con el procedimiento del punto 1 (ver `docs/PROGRESO.md`, sección de despliegue del Sprint 12).

## 6. Pendientes ordenados

| Prioridad | Qué | Por qué |
|---|---|---|
| P0 operativo | **Cargar la configuración de §7 y lograr una primera ejecución real del workflow** (más una prueba de apertura del artefacto) | Hasta entonces un incidente de cuenta no es recuperable. Preparado; falta el paso del propietario |
| P1 | Exportación por el propietario desde la app (`datos.exportar`) | Cumplir con pedidos de portabilidad sin depender del operador |
| P1 | Si el respaldo crece (> ~15 MB cifrado), mover las copias a R2/otro destino | El cupo gratuito de artefactos (500 MB) se agotaría. Requiere decisión de costos |
| P2 | Restauración de un taller a un taller nuevo con controles | Ver 3 |
| P3 | Exportación a `.xlsx` y a formatos de otros sistemas | Comodidad de migración |

## 7. Respaldo programado y copia fuera de Cloudflare (Sprint 13)

**Qué se preparó:** `.github/workflows/respaldo-d1.yml` (GitHub Actions, gratuito) ejecuta todos los días a las 03:17 (hora de Argentina) `npm run respaldo -- programado`, que reutiliza la herramienta de siempre: exporta la D1 completa (`wrangler d1 export`), la **verifica** (integridad, claves foráneas, migraciones, controles contables: partida doble, numeración, duplicados, reversiones), la **comprime y cifra** (AES-256-GCM, con la clave de datos envuelta con una **clave pública RSA-4096**), comprueba que el archivo cifrado se puede deshacer, y lo guarda como **artefacto** de la ejecución (`fierro-d1-<fecha>.sql.fbk` + un manifiesto sin datos comerciales). Si algo falla, el paso termina con error: GitHub marca la ejecución en rojo y envía un correo, y (si está configurado el aviso) la salud de la plataforma muestra el fallo.

**Por qué cifrado:** el repositorio es **público** y los artefactos de un repositorio público pueden descargarlos otras personas con cuenta de GitHub. El respaldo contiene todos los talleres y los hashes de las contraseñas. Sin la **clave privada**, el artefacto es ilegible. La clave pública (que sí está en GitHub) no permite abrirlo.

**Conservación:** artefactos diarios 14 días; los domingos 90 días (el máximo de GitHub). Eso deja del orden de 14 respaldos diarios + 13 semanales. Tamaño hoy: **0,23 MB por respaldo** (1,58 MB de SQL comprimido y cifrado) → unos 6 MB en total. El cupo de artefactos del plan gratuito es de **500 MB**: *tamaño del respaldo × ~27 versiones* debe quedar por debajo. Con un respaldo de 15 MB ya se rozaría el cupo: llegado ese punto hay que acortar la retención diaria o mover las copias a R2/otro destino (decisión y costo de ustedes; no se hizo).

**Estado real:** ✅ el procedimiento (`programado`, cifrado, descifrado, restauración) se **ejecutó de verdad contra la D1 de producción desde esta computadora** con claves descartables (ver §8). ❌ **El workflow de GitHub Actions todavía NO se ejecutó**: necesita datos de la cuenta que esta sesión no puede ni debe crear. Hasta que una ejecución real termine en verde y se haya probado abrir su artefacto, **no hay copia automática fuera de Cloudflare**.

### Configuración única (la hace el propietario; ~15 minutos)
1. **Generar el par de claves** en una carpeta **fuera del repositorio**:
   ```bash
   npm run respaldo -- generar-claves --salida C:\Users\TU_USUARIO\Documents\fierro-claves
   ```
   Guardar `fierro-respaldo-PRIVADA.pem` en **dos lugares** que no sean GitHub ni Cloudflare (por ejemplo un gestor de contraseñas y un pendrive). **Sin ella, los respaldos cifrados no se pueden abrir.** Nunca la subas ni la pegues en un chat.
2. **GitHub › Settings › Secrets and variables › Actions › Variables › New repository variable**: `FIERRO_RESPALDO_CLAVE_PUBLICA` = el contenido completo de `fierro-respaldo-publica.pem` (empieza con `-----BEGIN PUBLIC KEY-----`; no es secreto).
3. **Token de Cloudflare** (dash.cloudflare.com › My Profile › API Tokens › Create Token › Custom token): permiso **Account › D1 › Edit**, limitado a tu cuenta, sin ningún otro permiso. Cargarlo en **GitHub › Secrets › New repository secret** como `CLOUDFLARE_API_TOKEN`; y `CLOUDFLARE_ACCOUNT_ID` (el id de la cuenta, visible en `npx wrangler whoami`).
4. *(Opcional, recomendado)* **Aviso a la plataforma** para detectar respaldos que dejan de llegar: inventar un valor aleatorio de 32+ caracteres, cargarlo en el Worker (`npx wrangler secret put BACKUP_REPORT_TOKEN --name taller-mecanico`) y en GitHub como secreto `BACKUP_REPORT_TOKEN`; además la variable `FIERRO_URL` = `https://taller-mecanico.estrubia455.workers.dev`. Es un token distinto del de plataforma y solo sirve para avisar.
5. **Primera ejecución real:** GitHub › Actions › *Respaldo D1* › *Run workflow*. Debe terminar en verde. Descargar el artefacto, y **probar abrirlo**:
   ```bash
   npm run respaldo -- restaurar-aislado C:\ruta\fierro-d1-XXXX.sql.fbk --clave-privada C:\ruta\fierro-respaldo-PRIVADA.pem --migrar --servir
   ```
   Recién con esa prueba exitosa la copia externa se considera operativa. Repetir esta prueba **cada trimestre**: un respaldo que nunca se restauró no es un respaldo.

**Límites a conocer:** (a) GitHub **desactiva los workflows programados de un repositorio público tras 60 días sin actividad**: si pasa, Actions › *Respaldo D1* › *Enable workflow*; la salud de plataforma avisa cuando pasan 36 h sin un aviso correcto. (b) El horario del cron de GitHub puede atrasarse en horas de mucha carga. (c) `wrangler d1 export` deja la base **no disponible unos segundos**: hoy es imperceptible (1,6 MB, ~4 s); hay que reevaluarlo cuando crezca (por eso corre de madrugada). (d) La clave de datos viaja envuelta en el propio archivo: perder la privada = perder todos los respaldos cifrados con esa clave pública (para rotar la clave se genera un par nuevo y se cambia la variable; los respaldos viejos siguen necesitando la privada vieja).

## 8. Restauración sobre una instancia aislada (verificada)

```bash
npm run respaldo -- restaurar-aislado <archivo.sql | archivo.sql.fbk> [--clave-privada PRIVADA.pem] [--migrar] [--servir]
```
Crea una carpeta temporal, restaura el respaldo en un **D1 local de Miniflare** (`wrangler d1 execute --local`; **nunca** toca la base de producción ni acepta `--remote`), lo compara tabla por tabla con el archivo, corre integridad, claves foráneas y los controles contables de arriba, con `--migrar` lleva la copia al esquema actual (el camino real: restaurar y actualizar), y con `--servir` levanta el Worker sobre lo restaurado y consulta la API de plataforma. Borra todo al terminar (con `--conservar` deja la carpeta; contiene datos reales si el respaldo era de producción).

**Resultados reales (22/10/2026):**

| Caso | Resultado |
|---|---|
| Respaldo **cifrado** (`.fbk`) de la D1 de **producción**, generado con `programado` | Descifrado con la clave privada; **94 tablas y 3.750 filas** restauradas idénticas; integridad ok; 0 claves foráneas rotas; 2 talleres; con `--migrar` (+4 tablas de la 0013) el Worker arrancó y la API de plataforma listó los 2 talleres. El SHA-256 del contenido descifrado coincidió con el del respaldo manual hecho aparte. *Los talleres de producción todavía no tienen la contabilidad activada, por lo que esta prueba no incluye asientos reales.* |
| Base de ensayo con **contabilidad** (4 talleres ficticios, 2.048 asientos, 7.480 líneas, generada por la prueba de capacidad) | Restauradas **todas las tablas, índices y triggers**; 0 asientos descuadrados, 0 sin líneas, 0 duplicados, numeración correlativa sin saltos en cada taller, 0 reversiones sin contra-asiento, **Debe = Haber en cada taller**, cola de contabilización vacía; el Worker arrancó sobre lo restaurado y la API de plataforma listó los 4 talleres. |
| Archivo cifrado alterado, truncado, con otra clave o con la cabecera modificada | Se rechaza y no queda ningún archivo a medias (`tests/unit/respaldo-cifrado.test.ts`, 9 pruebas). |

**No se implementó la restauración de un solo taller** (sigue sin poder garantizarse la integridad; ver §3). Restaurar siempre es de toda la plataforma, y siempre primero en una instancia aislada.
