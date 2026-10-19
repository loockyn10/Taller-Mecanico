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
        <Route path="ventas" element={<Ventas />} />
        <Route path="ventas/nueva" element={<VentaMostrador />} />
        <Route path="ventas/:id" element={<VentaDetalle />} />
        <Route path="cobros" element={<Cobros />} />
        <Route path="cuentas" element={<Cuentas />} />
        <Route path="cuentas/:id" element={<CuentaCliente />} />
        <Route path="articulos" element={<Articulos />} />
        <Route path="articulos/:id" element={<ArticuloDetalle />} />
        <Route path="stock" element={<Movimientos />} />
        <Route path="compras" element={<Compras />} />
        <Route path="compras/nueva" element={<NuevaCompra />} />
        <Route path="proveedores" element={<Proveedores />} />
        <Route path="proveedores/:id" element={<ProveedorDetalle />} />
        <Route path="reportes" element={<Reportes />} />
        <Route path="configuracion" element={<Configuracion />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
