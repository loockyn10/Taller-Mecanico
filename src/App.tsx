import { lazy, Suspense, type ReactElement } from 'react';
import type { Permiso } from '@shared/permisos';
import { Lock } from 'lucide-react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { Cargando, Vacio } from './components/ui';
import { Login } from './pages/Login';
import { Activar } from './pages/Activar';
import { Inicio } from './pages/Inicio';
import { Ordenes } from './pages/ordenes/Ordenes';
import { NuevaOrden } from './pages/ordenes/NuevaOrden';
import { OrdenDetalle } from './pages/ordenes/OrdenDetalle';
import { Presupuestos } from './pages/presupuestos/Presupuestos';
import { PresupuestoForm } from './pages/presupuestos/PresupuestoForm';
import { PresupuestoDetalle } from './pages/presupuestos/PresupuestoDetalle';
import { Clientes, ClienteDetalle } from './pages/Clientes';
import { Vehiculos, VehiculoDetalle } from './pages/Vehiculos';
import { Agenda } from './pages/Agenda';
import { Ventas, VentaDetalle, VentaMostrador } from './pages/comercial/Ventas';
import { Cobros } from './pages/comercial/Cobros';
import { Cuentas, CuentaCliente } from './pages/comercial/Cuentas';
import { Articulos, ArticuloDetalle } from './pages/stock/Articulos';
import { Movimientos } from './pages/stock/Movimientos';
import { Compras, NuevaCompra } from './pages/compras/Compras';
import { Proveedores, ProveedorDetalle } from './pages/compras/Proveedores';
import { Reportes } from './pages/Reportes';
import { Configuracion } from './pages/config/Configuracion';
import { Imprimir } from './pages/Imprimir';
import { Caja } from './pages/caja/Caja';
import { Finanzas } from './pages/finanzas/Finanzas';
import { ListaPreciosDetalle, ListasPrecios } from './pages/stock/ListasPrecios';
import { Reposicion } from './pages/stock/Reposicion';
import { Reloj, modoReloj } from './pages/Reloj';
import { MisTrabajos, MiTrabajo } from './pages/mecanico/MisTrabajos';
import { Asistencia } from './pages/personal/Asistencia';
import { OperacionesRapidas } from './pages/OperacionesRapidas';
// Las pantallas administrativas se cargan bajo demanda para no inflar el paquete inicial.
const Bancos = lazy(() => import('./pages/bancos/Bancos').then((m) => ({ default: m.Bancos })));
const Cheques = lazy(() => import('./pages/bancos/Cheques').then((m) => ({ default: m.Cheques })));
const Tesoreria = lazy(() => import('./pages/bancos/Tesoreria').then((m) => ({ default: m.Tesoreria })));
const OrdenesCompra = lazy(() => import('./pages/compras/OrdenesCompra').then((m) => ({ default: m.OrdenesCompra })));
const OrdenCompraForm = lazy(() => import('./pages/compras/OrdenesCompra').then((m) => ({ default: m.OrdenCompraForm })));
const OrdenCompraDetalle = lazy(() => import('./pages/compras/OrdenesCompra').then((m) => ({ default: m.OrdenCompraDetalle })));
const FacturasProveedor = lazy(() => import('./pages/compras/FacturasProveedor').then((m) => ({ default: m.FacturasProveedor })));
const Depositos = lazy(() => import('./pages/stock/Depositos').then((m) => ({ default: m.Depositos })));
const AperturaSaldos = lazy(() => import('./pages/config/AperturaSaldos').then((m) => ({ default: m.AperturaSaldos })));
const Inventario = lazy(() => import('./pages/stock/Inventario').then((m) => ({ default: m.Inventario })));
const Equipo = lazy(() => import('./pages/personal/Equipo').then((m) => ({ default: m.Equipo })));
const PanelAsistencia = lazy(() => import('./pages/personal/PanelAsistencia').then((m) => ({ default: m.PanelAsistencia })));
const RelojAdmin = lazy(() => import('./pages/personal/RelojAdmin').then((m) => ({ default: m.RelojAdmin })));
const Informes = lazy(() => import('./pages/Informes').then((m) => ({ default: m.Informes })));
const Mantenimientos = lazy(() => import('./pages/Mantenimientos').then((m) => ({ default: m.Mantenimientos })));
const CatalogoAutomotor = lazy(() => import('./pages/CatalogoAutomotor').then((m) => ({ default: m.CatalogoAutomotor })));
const Tempario = lazy(() => import('./pages/Tempario').then((m) => ({ default: m.Tempario })));
const Productividad = lazy(() => import('./pages/Productividad').then((m) => ({ default: m.Productividad })));
const PuestaEnMarcha = lazy(() => import('./pages/config/PuestaEnMarcha').then((m) => ({ default: m.PuestaEnMarcha })));
const Importar = lazy(() => import('./pages/config/Importar').then((m) => ({ default: m.Importar })));
const Contabilidad = lazy(() => import('./pages/Contabilidad').then((m) => ({ default: m.Contabilidad })));

/** Información técnica general: la ve quien trabaja con vehículos, consulta el catálogo o tiene órdenes asignadas (sin exigir precios, finanzas ni estadísticas). */
const PERMISOS_CATALOGO_AUTO: Permiso[] = ['vehiculos.ver', 'catalogo.ver', 'ordenes.asignadas'];

/** Guarda de ruta: el menú ya oculta las opciones, pero quien escribe la dirección a mano ve un aviso claro (la API igual verifica en el servidor). */
function Requiere({ permiso, children }: { permiso: Permiso | Permiso[]; children: ReactElement }) {
  const { puede } = useAuth();
  return [permiso].flat().some((p) => puede(p)) ? <Suspense fallback={<Cargando />}>{children}</Suspense> : <Vacio icono={<Lock className="size-5" />} titulo="No tenés acceso a esta sección" texto="Pedile al propietario o a un administrador que te habilite el permiso." />;
}

/** Quien solo ve sus órdenes asignadas (mecánico) empieza en "Mis trabajos" en vez del tablero general. */
function Portada() {
  const { soloMecanico, me, puede } = useAuth();
  // Taller recién activado: la primera vez se muestra el asistente de configuración inicial (se puede cerrar y retomar después).
  if (me?.taller.asistente_pendiente && puede('config.editar')) return <Navigate to="/puesta-en-marcha" replace />;
  return soloMecanico ? <Navigate to="/mis-trabajos" replace /> : <Inicio />;
}

export function App() {
  const { me, cargando } = useAuth();
  const { pathname } = useLocation();
  // Reloj compartido: pantalla propia (se autentica con el dispositivo, no con una sesión). En un navegador que quedó
  // dedicado al reloj no se puede navegar por el resto del sistema.
  if (pathname === '/reloj') return <Reloj />;
  // Activación de un taller nuevo con el enlace de invitación (todavía no hay sesión).
  if (pathname === '/activar') return <Activar />;
  if (modoReloj()) return <Navigate to="/reloj" replace />;
  if (cargando) return <Cargando texto="Iniciando ORVELAN…" />;
  if (!me) {
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/imprimir/:tipo/:id" element={<Imprimir />} />
      <Route element={<Layout />}>
        <Route index element={<Portada />} />
        <Route path="mis-trabajos" element={<Requiere permiso="ordenes.asignadas"><MisTrabajos /></Requiere>} />
        <Route path="mis-trabajos/:id" element={<Requiere permiso="ordenes.asignadas"><MiTrabajo /></Requiere>} />
        <Route path="operaciones-rapidas" element={<Requiere permiso={['ventas.emitir', 'ordenes.modificar', 'stock.ajustar']}><OperacionesRapidas /></Requiere>} />
        <Route path="ordenes" element={<Requiere permiso="ordenes.ver"><Ordenes /></Requiere>} />
        <Route path="ordenes/nueva" element={<Requiere permiso="ordenes.crear"><NuevaOrden /></Requiere>} />
        <Route path="ordenes/:id" element={<Requiere permiso="ordenes.ver"><OrdenDetalle /></Requiere>} />
        <Route path="presupuestos" element={<Requiere permiso="presupuestos.ver"><Presupuestos /></Requiere>} />
        <Route path="presupuestos/nuevo" element={<Requiere permiso="presupuestos.gestionar"><PresupuestoForm /></Requiere>} />
        <Route path="presupuestos/:id" element={<Requiere permiso="presupuestos.ver"><PresupuestoDetalle /></Requiere>} />
        <Route path="presupuestos/:id/editar" element={<Requiere permiso="presupuestos.gestionar"><PresupuestoForm /></Requiere>} />
        <Route path="clientes" element={<Requiere permiso="clientes.ver"><Clientes /></Requiere>} />
        <Route path="clientes/:id" element={<Requiere permiso="clientes.ver"><ClienteDetalle /></Requiere>} />
        <Route path="vehiculos" element={<Requiere permiso="vehiculos.ver"><Vehiculos /></Requiere>} />
        <Route path="vehiculos/:id" element={<Requiere permiso="vehiculos.ver"><VehiculoDetalle /></Requiere>} />
        <Route path="agenda" element={<Requiere permiso="turnos.ver"><Agenda /></Requiere>} />
        <Route path="mantenimientos" element={<Requiere permiso="mantenimientos.ver"><Mantenimientos /></Requiere>} />
        <Route path="recordatorios" element={<Navigate to="/mantenimientos" replace />} />
        <Route path="catalogo-automotor" element={<Requiere permiso={PERMISOS_CATALOGO_AUTO}><CatalogoAutomotor /></Requiere>} />
        <Route path="tempario" element={<Requiere permiso="catalogo.ver"><Tempario /></Requiere>} />
        <Route path="productividad" element={<Requiere permiso="productividad.ver"><Productividad /></Requiere>} />
        <Route path="asistencia" element={<Requiere permiso="asistencia.fichar"><Asistencia /></Requiere>} />
        <Route path="personal/equipo" element={<Requiere permiso="usuarios.gestionar"><Equipo /></Requiere>} />
        <Route path="personal/asistencia" element={<Requiere permiso="asistencia.ver"><PanelAsistencia /></Requiere>} />
        <Route path="personal/reloj" element={<Requiere permiso="reloj.administrar"><RelojAdmin /></Requiere>} />
        <Route path="ventas" element={<Requiere permiso="ventas.ver"><Ventas /></Requiere>} />
        <Route path="ventas/nueva" element={<Requiere permiso="ventas.emitir"><VentaMostrador /></Requiere>} />
        <Route path="ventas/:id" element={<Requiere permiso="ventas.ver"><VentaDetalle /></Requiere>} />
        <Route path="cobros" element={<Requiere permiso="ventas.ver"><Cobros /></Requiere>} />
        <Route path="cuentas" element={<Requiere permiso="ventas.ver"><Cuentas /></Requiere>} />
        <Route path="cuentas/:id" element={<Requiere permiso="ventas.ver"><CuentaCliente /></Requiere>} />
        <Route path="articulos" element={<Requiere permiso="catalogo.ver"><Articulos /></Requiere>} />
        <Route path="articulos/:id" element={<Requiere permiso="catalogo.ver"><ArticuloDetalle /></Requiere>} />
        <Route path="stock" element={<Requiere permiso="stock.ver"><Movimientos /></Requiere>} />
        <Route path="compras" element={<Requiere permiso="compras.ver"><Compras /></Requiere>} />
        <Route path="compras/nueva" element={<Requiere permiso="compras.gestionar"><NuevaCompra /></Requiere>} />
        <Route path="proveedores" element={<Requiere permiso="compras.ver"><Proveedores /></Requiere>} />
        <Route path="proveedores/:id" element={<Requiere permiso="compras.ver"><ProveedorDetalle /></Requiere>} />
        <Route path="caja" element={<Requiere permiso="caja.operar"><Caja /></Requiere>} />
        <Route path="finanzas" element={<Requiere permiso="finanzas.ver"><Finanzas /></Requiere>} />
        <Route path="listas-precios" element={<Requiere permiso="precios.gestionar"><ListasPrecios /></Requiere>} />
        <Route path="listas-precios/:id" element={<Requiere permiso="precios.gestionar"><ListaPreciosDetalle /></Requiere>} />
        <Route path="reposicion" element={<Requiere permiso="stock.ver"><Reposicion /></Requiere>} />
        <Route path="reportes" element={<Requiere permiso="reportes.ver"><Reportes /></Requiere>} />
        <Route path="informes" element={<Requiere permiso="reportes.ver"><Informes /></Requiere>} />
        <Route path="contabilidad" element={<Requiere permiso="contabilidad.ver"><Contabilidad /></Requiere>} />
        <Route path="tesoreria" element={<Requiere permiso="tesoreria.ver"><Tesoreria /></Requiere>} />
        <Route path="bancos" element={<Requiere permiso="bancos.ver"><Bancos /></Requiere>} />
        <Route path="cheques" element={<Requiere permiso="cheques.gestionar"><Cheques /></Requiere>} />
        <Route path="depositos" element={<Requiere permiso="stock.ver"><Depositos /></Requiere>} />
        <Route path="inventario" element={<Requiere permiso="stock.ver"><Inventario /></Requiere>} />
        <Route path="ordenes-compra" element={<Requiere permiso="compras.ver"><OrdenesCompra /></Requiere>} />
        <Route path="ordenes-compra/nueva" element={<Requiere permiso="compras.gestionar"><OrdenCompraForm /></Requiere>} />
        <Route path="ordenes-compra/:id" element={<Requiere permiso="compras.ver"><OrdenCompraDetalle /></Requiere>} />
        <Route path="ordenes-compra/:id/editar" element={<Requiere permiso="compras.gestionar"><OrdenCompraForm /></Requiere>} />
        <Route path="facturas-proveedor" element={<Requiere permiso="compras.ver"><FacturasProveedor /></Requiere>} />
        <Route path="configuracion" element={<Configuracion />} />
        <Route path="puesta-en-marcha" element={<Requiere permiso="config.editar"><PuestaEnMarcha /></Requiere>} />
        <Route path="importar" element={<Requiere permiso="datos.importar"><Importar /></Requiere>} />
        <Route path="apertura-saldos" element={<Requiere permiso="aperturas.gestionar"><AperturaSaldos /></Requiere>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
