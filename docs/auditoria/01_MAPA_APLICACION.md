# 01 — Mapa de la aplicación (Caldén Sistemas · Taller)

- URL: `https://taller.caldensistemasapp.com/` · Versión declarada: **2.4.0** (14/10/2026)
- Sesión auditada: usuario **DEMO**, rol **Operador** · Fecha: 19/10/2026
- Tipo: SPA web (React + Tailwind/shadcn-Radix, íconos Lucide — INFERIDO por las clases del DOM)
- Alcance: **~55 pantallas/rutas** y más de 30 diálogos modales

Leyenda: ✅ inspeccionada · ⛔ inaccesible · 🔸 parcial

## Estructura global

```
┌────────────── Sidebar (colapsable) ──────────────┬──────────── Header ─────────────────────────────┐
│ Logo · "Buscar módulo..."                        │ Breadcrumb · Buscador global ⌘K (clientes, OTs, │
│ GENERAL / OPERACIÓN / ADMINISTRACIÓN / SISTEMA   │ patentes) · Campana novedades · "Actualizar      │
│ Usuario + rol · tema claro/oscuro · logout       │ Sistema" (recarga versión)                       │
└──────────────────────────────────────────────────┴──────────────────────────────────────────────────┘
Flotantes: botón ayuda (rojo) y WhatsApp de soporte del proveedor.
```

## Árbol de navegación

### GENERAL
| Pantalla | Ruta | Estado | Contenido principal |
|---|---|---|---|
| Dashboard | `/` | ✅ | Saludo, accesos rápidos (Nueva OT, Baja rápida, Prefactura, Agenda, Consultar precios, Carrito rápido), KPIs OT activas/finalizadas hoy, OT activas, agenda de hoy, recursos (artículos, clientes, proveedores), stock bajo |
| Agenda | `/agenda` | ✅ | Turnos: calendario mensual + lista, KPIs, presupuestos aprobados sin agendar |
| Presupuestos | `/quotes` | ✅ | Listado, filtros, alta, conversión a OT, PDF, WhatsApp |
| Estadísticas | `/estadisticas` | ✅ | Ventas, compras y rentabilidad por cliente/proveedor/producto |

### OPERACIÓN
| Grupo | Pantalla | Ruta | Estado |
|---|---|---|---|
| Órdenes de Trabajo | Órdenes de Trabajo | `/work-orders` | ✅ |
| | Informe OT | `/work-orders/report` | ✅ |
| | Mecánicos | `/empleados` | ⛔ redirige al Dashboard |
| Servicios | Historia Clínica | `/servicios` | ✅ |
| | Vehículos Clientes | `/servicios/vehiculos` | ✅ |
| | Notificaciones | `/servicios/notificaciones` | ✅ |
| Ficha Técnica | Vehículos (marcas → modelos → variantes) | `/vehicles` | ✅ |
| | Tablas de Service | `/service-tables` | ✅ |

### ADMINISTRACIÓN
| Grupo | Pantalla | Ruta | Estado |
|---|---|---|---|
| Ventas | Clientes | `/clients` | ✅ |
| | Artículos (Inventario) | `/inventory` | ✅ |
| | Categorías | `/categories` | ✅ |
| | Lista de Precios | `/price-lists` | ✅ |
| | Baja Rápida | `/quick-discharge` | ✅ |
| | Venta rápida CF | `/venta-rapida` | ✅ |
| | Prefacturas | `/prefacturas` | ✅ |
| | CC Clientes | `/cuenta-corriente` | ✅ |
| | Cobranzas | `/ventas-cobranzas` | ✅ |
| | Subdiario Ventas | `/subdiario-ventas` | ✅ |
| Compras | Generar Orden | `/purchase-order/generate` | ✅ |
| | Informe OC | `/purchase-order/report` | ✅ |
| | Proveedores | `/suppliers` | ✅ |
| | Facturas Proveedores | `/facturas-proveedores` | 🔸 (no se probó el OCR) |
| | Remitos Proveedores | `/supplier-remitos` | ✅ |
| | Sub-diario Compras | `/subdiario-compras` | ✅ |
| | Pagos Proveedores | `/compras-pagos` | ✅ |
| | CC Proveedores | `/cuenta-corriente-proveedores` | ✅ |
| | Tablas (medios de pago, categorías de gasto) | `/compras/tablas` | ✅ |
| Stock | Reposición | `/replenishment` | ✅ |
| | Depósitos | `/warehouses` | ✅ |
| | Remitos Internos | `/internal-transfers` | ✅ |
| | Movimientos | `/movements` | ✅ |
| Tesorería | Caja Diaria | `/caja-diaria` | ✅ |
| | Bancos (cuentas, movimientos, conciliación, informe) | `/bancos` | 🔸 (solo la pestaña Cuentas) |
| | Cheques de terceros | `/cheques` | ✅ |
| | Cheques propios | `/cheques-propios` | ✅ |
| | Gastos Fijos | `/gastos-fijos` | ✅ |
| Contabilidad | Informe Cobranzas | `/cobranzas` | ✅ |
| | Informe Pagos | `/pagos-proveedores` | ✅ |
| | Libro IVA Digital / Plan de Cuentas / Estado de Resultados | `/contabilidad#…` | 🔸 (pestañas: Archivos, Asientos, Libro Diario, Mayores, Balance, Cierres) |
| Finanzas | Resumen Financiero | `/resumen-financiero` | ✅ |

### SISTEMA (grupo "Caldén Sistemas")
| Pantalla | Ruta | Estado |
|---|---|---|
| Auditoría (consistencia de datos) | `/auditoria` | ✅ |
| Configuración (empresa + ARCA) | `/settings` | ✅ |
| Tutoriales | `/tutoriales` | ✅ |
| Nosotros / Términos | `/nosotros`, `/terminos` | No inspeccionadas (institucionales) |

## Relaciones entre módulos (OBSERVADO)

```
Cliente ──< Vehículo (patente) ──< Ingresos (Historia Clínica)
   │                                   ▲
   ├──< Presupuesto ──(Convertir a OT)──► Orden de Trabajo ──► Prefactura/Proforma ──► Factura ARCA
   │        │                              │  │                     │
   │        └──(vincular)── Turno (Agenda) │  └─ Check-list ingreso │
   │                                       │                        ├──► Cobro / Recibo ──► Caja / Banco / Cheques
   │                                       └─ consume Artículos ──► Movimientos de stock
   └──< Cuenta corriente (saldo)
Artículo ──< Proveedor del artículo (costo) ──► Lista de precios (margen %) ──► precio de venta
Proveedor ──< OC ──► Remito proveedor (suma stock) ──► Factura proveedor ──► Orden de pago ──► CC Proveedores
Tablas de Service (catálogo de mano de obra + intervalos) ──► líneas de OT/presupuesto y Notificaciones de service
Todo comprobante ──► Asientos contables automáticos (cuentas por defecto) ──► Diario / Mayores / Balance
```
