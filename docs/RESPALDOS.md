# Respaldos, exportación y recuperación de Fierro

Estado al **22/10/2026 (Sprint 12)**. Este documento separa cuatro cosas que no deben mezclarse y dice, para cada una, qué existe hoy, qué se verificó y qué falta.

| # | Necesidad | Quién la hace | Qué existe hoy | Estado |
|---|---|---|---|---|
| 1 | **Respaldo de toda la plataforma** | Operador de Fierro | `wrangler d1 export` + Time Travel; `npm run respaldo -- plataforma` lo automatiza y lo verifica | **Disponible (manual)**. Sin respaldos programados |
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
- **No hay respaldos programados.** Si nadie ejecuta el comando, el único resguardo es Time Travel (30 días según la [documentación de Cloudflare](https://developers.cloudflare.com/d1/reference/time-travel/); esa página no confirma si la ventana difiere entre el plan gratuito y el pago: verificarlo en la cuenta). Propuesta: R2.
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
| P0 operativo | Definir **dónde** viven copias cifradas fuera de Cloudflare y con qué frecuencia | Hoy un incidente de cuenta no es recuperable. Requiere decisión (y, si es R2 u otro, autorización) |
| P1 | Exportación por el propietario desde la app (`datos.exportar`) | Cumplir con pedidos de portabilidad sin depender del operador |
| P1 | Respaldos programados (Cron Trigger + R2) con verificación automática | Dejar de depender de que alguien se acuerde |
| P2 | Restauración de un taller a un taller nuevo con controles | Ver 3 |
| P3 | Exportación a `.xlsx` y a formatos de otros sistemas | Comodidad de migración |
