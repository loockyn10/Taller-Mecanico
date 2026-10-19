# Fierro · Gestión de talleres mecánicos

Aplicación web multiempresa (PWA) para talleres: órdenes de trabajo, presupuestos, agenda, clientes y vehículos con historial, check-list de ingreso, stock, compras, comprobantes internos, cobros y cuentas corrientes.

- **Frontend:** React 18 + TypeScript + Vite + Tailwind 4 + TanStack Query (PWA instalable, responsive).
- **Backend:** Cloudflare Workers + Hono (API propia, modular).
- **Base de datos:** Cloudflare D1 (SQLite) con migraciones versionadas en `migrations/`.

## Requisitos
- Node.js 20 o superior (probado con Node 26 en Windows).
- No hace falta una cuenta de Cloudflare para desarrollar: D1 y Workers corren localmente con `wrangler`.

## Puesta en marcha (local)
```bash
npm install
npm run dev
```
`npm run dev` crea `.dev.vars` si no existe, aplica las migraciones a la base local y levanta:
- API en http://127.0.0.1:8787
- Aplicación en http://localhost:5173 (Vite redirige `/api` a la API)

Con el entorno levantado, en otra terminal, cargá los datos de demostración (ficticios):
```bash
npm run db:seed
```
Usuarios demo (contraseña `demo1234`):

| Usuario | Taller | Rol |
|---|---|---|
| demo@fierro.local | Taller Demo | Propietario |
| empleado@fierro.local | Taller Demo | Empleado |
| norte@fierro.local | Taller Norte | Propietario (sirve para comprobar el aislamiento) |

Para empezar de cero: detené `npm run dev` y ejecutá `npm run db:reset`.

> **Windows:** si el proyecto está en una ruta muy larga (más de unos 150 caracteres), la base local puede fallar con `SQLITE_CANTOPEN` por el límite de 260 caracteres. En ese caso definí `FIERRO_STATE` con una ruta corta (por ejemplo `set FIERRO_STATE=C:\fierro-state`).

## Pruebas
```bash
npm test            # unitarias + integración
npm run test:unit   # cálculo de totales, reglas de dominio
npm run test:api    # levanta un Worker real con D1 temporal y prueba la API completa
npm run typecheck
npm run build
```
Las pruebas de integración cubren: flujo completo (cliente → vehículo → presupuesto → OT → stock → comprobante → cobros → entrega → historial), aislamiento entre talleres, permisos por rol, límites de licencia, licencia suspendida, idempotencia y concurrencia (doble conversión, doble cobro, triple finalización simultánea), rollback atómico y autenticación.

## Licencias y alta de talleres (administración manual)
No hay registro público: cada taller se da de alta desde la API de plataforma, protegida con `PLATFORM_ADMIN_TOKEN` (definido en `.dev.vars` en local; `wrangler secret put PLATFORM_ADMIN_TOKEN` en producción).
```bash
npm run platform -- listar
npm run platform -- crear-taller --nombre "Taller García" --email dueno@garcia.com --password ClaveSegura123 --adicionales 1
npm run platform -- licencia <tallerId> --adicionales 3
npm run platform -- suspender <tallerId>
npm run platform -- activar <tallerId>
```
Cada licencia incluye 1 usuario (el propietario) más los usuarios adicionales contratados. Con la licencia suspendida, el taller conserva acceso de solo lectura.

## Despliegue (no realizado todavía)
1. `npx wrangler d1 create fierro` y copiar el `database_id` en `wrangler.jsonc`.
2. `npx wrangler d1 migrations apply DB --remote`
3. `npx wrangler secret put PLATFORM_ADMIN_TOKEN`
4. `npm run build && npx wrangler deploy` (el mismo Worker sirve la API y la aplicación).

Antes de producción, revisar los puntos de `docs/PROGRESO.md` → "Problemas conocidos y riesgos".

## Estructura
```
migrations/      esquema D1 versionado
shared/          lógica compartida front/back: totales, estados, permisos
worker/          API (Hono): lib/ (auth, db, stock, documentos) y modules/ (un archivo por dominio)
src/             frontend: components/ (sistema de diseño), pages/ (pantallas), lib/
scripts/         dev, seed, reset, CLI de plataforma, íconos PWA
tests/           unit/ e api/ (integración)
docs/            auditoría de referencia y progreso del desarrollo
```
