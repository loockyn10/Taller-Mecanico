# 06 — Arquitectura propuesta

## Restricciones que guían la decisión
1. **Pago único, sin mantenimiento contratado**: nadie va a pagar ni vigilar servidores, renovaciones o incidentes después de la entrega.
2. Usuario típico: dueño o recepcionista de un taller, casi siempre en **una PC de mostrador**; quizás consulte desde el celular.
3. Sin facturación electrónica en el MVP (ver 07): no hace falta conexión con ARCA.
4. El plazo es mínimo, así que importa más la simplicidad operativa que la escalabilidad.

> Los precios y límites de terceros citados abajo son los que conozco a mi fecha de corte. **Verificarlos antes de cotizar.**

---

## Opción A — Web: React + TypeScript + Supabase + Vercel

| Aspecto | Evaluación |
|---|---|
| Infraestructura | El plan gratuito de Supabase tiene límites de base y almacenamiento, y **pausa proyectos inactivos** (≈1 semana sin uso). Para producción sin sorpresas hace falta el plan Pro (≈ USD 25/mes). Vercel Hobby es para **uso no comercial**; el uso comercial requiere Pro (≈ USD 20/mes por miembro). Alternativas para el frontend: Netlify o Cloudflare Pages (gratis, también estático). |
| Costo recurrente | **Sí**: ≈ USD 25–45/mes, o arriesgarse al plan gratuito. Choca con el modelo de pago único: alguien tiene que pagarlo y sostenerlo. |
| Respaldos | Pro incluye backups diarios. En el plan gratuito son manuales (pg_dump), es decir, nadie los hará. |
| Actualizaciones | Triviales: un deploy actualiza a todos. |
| Instalación | Ninguna (URL + PWA instalable). |
| Multi-dispositivo | ✅ Nativo: PC, celular del mecánico, acceso remoto del dueño. |
| Seguridad | Auth de Supabase + Row Level Security bien escritas (el riesgo es configurarlas mal). Datos en la nube de un tercero. |
| Complejidad operativa | Media: cuentas de terceros, claves, dominio, a nombre de quién quedan, quién paga la tarjeta. |
| Riesgo post-venta | Si el plan gratuito pausa el proyecto o vence la tarjeta, **el taller se queda sin sistema** y llama al desarrollador. |

## Opción B — Escritorio: Tauri 2 + React + TypeScript + SQLite

| Aspecto | Evaluación |
|---|---|
| Infraestructura | **Cero**. Un ejecutable (.msi/.exe de ~10–15 MB; usa WebView2, que viene con Windows 10/11). |
| Costo recurrente | **Ninguno**. Encaja con el pago único. |
| Respaldos | Responsabilidad local: hay que **automatizarlos dentro de la app**: copia diaria de la base (`VACUUM INTO`) a una carpeta elegida (idealmente sincronizada con Google Drive/OneDrive o un pendrive), botón "Respaldar ahora" y "Restaurar". Es imprescindible: si se rompe el disco sin backup, se pierde todo. |
| Actualizaciones | Manual (enviar un instalador nuevo) o con el updater de Tauri, que requiere firmar los releases y publicar un JSON (p. ej. GitHub Releases, gratis). Sin mantenimiento contratado, lo realista es la versión manual. |
| Instalación | Instalador. Sin certificado de firma de código, Windows SmartScreen muestra una advertencia: hay que explicárselo al cliente o comprar el certificado (costo anual). |
| Multi-dispositivo | ❌ Una PC. Compartir en red local o con el celular requiere más trabajo (servidor embebido) y queda fuera del MVP. |
| Seguridad | Los datos nunca salen del taller. El riesgo es físico (robo o rotura de la PC), y se mitiga con los backups. PIN de acceso opcional. |
| Complejidad operativa | Baja para el cliente. Para nosotros: toolchain Rust + build para Windows (una sola vez). |
| Funciona sin internet | ✅ (WhatsApp con enlace `wa.me` solo requiere internet al enviar). |

## Opción C (alternativa evaluada) — Web local-first (PWA + IndexedDB)
- Gratis de hostear (estático), sin instalador, funciona offline.
- ❌ Los datos viven en el almacenamiento del navegador: si alguien borra los datos de navegación, se pierde todo. Demasiado frágil para un sistema de gestión. **Descartada.**

---

## Recomendación: **Opción B (Tauri + React + TS + SQLite)**

Es la única opción en la que **lo que se vende una vez sigue funcionando sin que nadie pague ni mantenga nada**. Las debilidades (un solo puesto, actualizaciones manuales) son aceptables para un taller chico, y se pueden contratar después como servicio adicional.

> Si el cliente exige acceso desde el celular o desde varias PCs, cambiar a la **Opción A con la cuenta de Supabase a nombre del cliente y pagada por él** (plan Pro), y presupuestarlo aparte con un abono de hosting. Si no, el precio de venta no cubre el costo.

### Stack concreto
| Capa | Elección | Motivo |
|---|---|---|
| Shell | Tauri 2 | Instalador liviano, acceso a archivos para backups y PDF |
| UI | React 18 + TypeScript + Vite | Productividad con IA, ecosistema |
| Componentes | Tailwind + shadcn/ui | Rápido y consistente (Dialog, Select, Tabs, Toast, Command para ⌘K) |
| Estado y datos | TanStack Query + capa repositorio | Separar la UI del acceso a datos (permite migrar a Supabase después) |
| Base | SQLite vía `tauri-plugin-sql` | Archivo único, transaccional, fácil de respaldar |
| Migraciones | Archivos SQL numerados que se ejecutan al iniciar | Actualizaciones seguras |
| Validación | Zod (formularios y repositorio) | Las mismas reglas en el front y en la persistencia |
| Formularios | React Hook Form | Formularios largos con líneas dinámicas |
| PDF | Vista HTML imprimible + `window.print()` (guardar como PDF) | Cero dependencias; o `@react-pdf/renderer` si se quiere un PDF directo |
| WhatsApp | `https://wa.me/<tel>?text=<resumen>` | Sin API, sin costo, sin aprobación de Meta |
| Excel | Exportar CSV (UTF-8 con BOM) | Excel lo abre sin librerías |
| Tests | Vitest para cálculos (totales, IVA, stock) + checklist manual E2E | Los cálculos de dinero son el mayor riesgo |

### Estructura del proyecto (propuesta)
```
src/
  app/            rutas y layout (sidebar + header + ⌘K)
  features/
    clientes/ vehiculos/ catalogo/ stock/ presupuestos/ ordenes/ agenda/ caja/ reportes/ config/
  domain/         tipos, cálculo de totales, reglas (puro, testeable)
  data/           repositorios SQLite (interfaz común para migrar a Supabase)
  ui/             componentes shadcn
src-tauri/
  migrations/     001_init.sql, 002_...
  src/            comandos: backup, restore, abrir carpeta
```

### Backups (obligatorio en la entrega)
1. Al abrir la app, si el último backup tiene más de 24 h, se hace uno automático en la carpeta configurada.
2. Se rotan los últimos 30 archivos.
3. Configuración → "Respaldar ahora", "Restaurar desde archivo", "Abrir carpeta de backups".
4. En la capacitación se configura la carpeta dentro de Google Drive o OneDrive del cliente.

### Seguridad mínima
- PIN o contraseña local opcional (hash con salt guardado en la base).
- Sin datos sensibles: no se guardan tarjetas ni claves fiscales.
- Consultas SQL parametrizadas.

### Costos
| Concepto | Opción B | Opción A |
|---|---|---|
| Hosting/infra mensual | $0 | ≈ USD 25–45 (verificar) |
| Dominio | No | Opcional |
| Certificado de firma de código | Opcional (anual) | No aplica |
| Respaldo | Carpeta en la nube del cliente (gratis) | Incluido en Pro |
