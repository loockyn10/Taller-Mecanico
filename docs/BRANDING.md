# Identidad de marca: ORVELAN Sistemas · Taller Mecánico (Sprint 21)

Fuente oficial: `ORVELAN_Identidad_de_Marca.zip` (kit v1.0, octubre 2026). El ZIP original queda **fuera de git** (`branding/` en `.gitignore`); sólo se versionan los recursos optimizados que usa la app.

## Nombre
- El logotipo del kit y el manual escriben **ORVELAN** (con «RV»). El encargo mencionaba «Overlan»: se tomó como error de tipeo y se respeta el manual. **Si el nombre real fuera otro, hay que pedir el kit corregido**: el nombre está dibujado en el logotipo vectorial y no se recrea con una fuente.
- Marca madre: **ORVELAN Sistemas**. Especialidad: **Taller Mecánico**, siempre como texto aparte (`src/components/Marca.tsx`); no se modificó ningún logotipo.
- En textos corrientes de la interfaz se usa «ORVELAN» (p. ej. «Hechos en ORVELAN»). Identificadores internos (`FIERRO_FOTOS`, `fierro.menu.abierto`, nombre del Worker) no cambian.

## Inventario del ZIP y uso
| Recurso | Uso |
|---|---|
| `01_Logotipos/Principal.svg` | login móvil (fondo claro) → `public/brand/orvelan-logo.svg` |
| `Logotipo_Oscuro.svg` | menú lateral y panel del login (fondo marino) → `orvelan-logo-oscuro.svg` |
| `…Sin_Descriptor` (claro y oscuro) | disponibles para poco espacio (no usados todavía) |
| `02_Isotipo/Isotipo.svg` | cabecera móvil, pie de documentos y página pública de seguimiento (en línea por la CSP) |
| `03_Digital/Favicon.svg` y `.ico` | pestaña del navegador |
| `Icono_App_192/512.png` | PWA (`icon-192.png`, `icon-512.png`); el 512 también como maskable (el isotipo cabe en la zona segura) |
| `Paleta_ORVELAN.json`, `Tokens_ORVELAN.css` | tokens de `src/index.css`: escala `marca-*` (azul #0F8FF5 / #0658AF) y `petroleo-*` (marino #081F41 / #06182F) |
| Manual PDF | reglas: no estirar, sin sombras, ancho recomendado 180 px, descriptor sólo si se lee |
| No usados | logotipo vertical, «solo nombre», PDF vectoriales, avatar, imagen para compartir 1200×630, PNG de logotipos (se prefiere SVG) |

Tipografía: el kit propone Inter (sin archivos); la app ya la declara primera en `--font-sans`.

## Documentos
Los impresos (OT, presupuesto, recibos, compras) conservan el logo y los datos **del taller**; sólo suman un pie discreto «Emitido con ORVELAN Sistemas · Taller Mecánico». Los PDF generados por el Worker llevan `Creator/Producer: ORVELAN Sistemas`.

## Futuros productos (Almacén, PetShop)
`Marca.tsx` separa marca madre (`LogoOrvelan`, `Isotipo`) de especialidad (`ESPECIALIDAD`); otro producto reutiliza los tokens y cambia sólo la especialidad. No se desarrolló ninguno.
