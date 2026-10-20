import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { Cargando } from './components/ui';
import { Login } from './pages/Login';
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
import { Recordatorios } from './pages/Recordatorios';
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
import type { ReactElement } from 'react';
import type { Permiso } from '@shared/permisos';
import { Vacio } from './components/ui';
import { Lock } from 'lucide-react';

/** Guarda de ruta: el menú ya oculta las opciones, pero quien escribe la dirección a mano ve un aviso claro (la API igual verifica en el servidor). */
function Requiere({ permiso, children }: { permiso: Permiso; children: ReactElement }) {
  const { puede } = useAuth();
  return puede(permiso) ? children : <Vacio icono={<Lock className="size-5" />} titulo="No tenés acceso a esta sección" texto="Pedile al propietario o a un administrador que te habilite el permiso." />;
}

export function App() {
  const { me, cargando } = useAuth();
  if (cargando) return <Cargando texto="Iniciando Fierro…" />;
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
        <Route index element={<Inicio />} />
        <Route path="ordenes" element={<Ordenes />} />
        <Route path="ordenes/nueva" element={<NuevaOrden />} />
        <Route path="ordenes/:id" element={<OrdenDetalle />} />
        <Route path="presupuestos" element={<Presupuestos />} />
        <Route path="presupuestos/nuevo" element={<PresupuestoForm />} />
        <Route path="presupuestos/:id" element={<PresupuestoDetalle />} />
        <Route path="presupuestos/:id/editar" element={<PresupuestoForm />} />
        <Route path="clientes" element={<Clientes />} />
        <Route path="clientes/:id" element={<ClienteDetalle />} />
        <Route path="vehiculos" element={<Vehiculos />} />
        <Route path="vehiculos/:id" element={<VehiculoDetalle />} />
        <Route path="agenda" element={<Agenda />} />
        <Route path="recordatorios" element={<Recordatorios />} />
        <Route path="ventas" element={<Requiere permiso="ventas.ver"><Ventas /></Requiere>} />
        <Route path="ventas/nueva" element={<Requiere permiso="ventas.emitir"><VentaMostrador /></Requiere>} />
        <Route path="ventas/:id" element={<Requiere permiso="ventas.ver"><VentaDetalle /></Requiere>} />
        <Route path="cobros" element={<Requiere permiso="ventas.ver"><Cobros /></Requiere>} />
        <Route path="cuentas" element={<Requiere permiso="ventas.ver"><Cuentas /></Requiere>} />
        <Route path="cuentas/:id" element={<Requiere permiso="ventas.ver"><CuentaCliente /></Requiere>} />
        <Route path="articulos" element={<Requiere permiso="catalogo.ver"><Articulos /></Requiere>} />
        <Route path="articulos/:id" element={<Requiere permiso="catalogo.ver"><ArticuloDetalle /></Requiere>} />
        <Route path="stock" element={<Requiere permiso="stock.ver"><Movimientos /></Requiere>} />
        <Route path="compras" element={<Requiere permiso="compras.gestionar"><Compras /></Requiere>} />
        <Route path="compras/nueva" element={<Requiere permiso="compras.gestionar"><NuevaCompra /></Requiere>} />
        <Route path="proveedores" element={<Requiere permiso="catalogo.ver"><Proveedores /></Requiere>} />
        <Route path="proveedores/:id" element={<Requiere permiso="compras.gestionar"><ProveedorDetalle /></Requiere>} />
        <Route path="caja" element={<Requiere permiso="caja.operar"><Caja /></Requiere>} />
        <Route path="finanzas" element={<Requiere permiso="finanzas.ver"><Finanzas /></Requiere>} />
        <Route path="listas-precios" element={<Requiere permiso="precios.gestionar"><ListasPrecios /></Requiere>} />
        <Route path="listas-precios/:id" element={<Requiere permiso="precios.gestionar"><ListaPreciosDetalle /></Requiere>} />
        <Route path="reposicion" element={<Requiere permiso="stock.ver"><Reposicion /></Requiere>} />
        <Route path="reportes" element={<Requiere permiso="reportes.ver"><Reportes /></Requiere>} />
        <Route path="configuracion" element={<Configuracion />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
