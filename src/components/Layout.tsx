import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart3, Banknote, Bell, Boxes, CalendarDays, Car, ClipboardList, FileText, Gauge, LogOut, Menu, Package, PackageSearch, PiggyBank, Receipt, Search, Settings, ShoppingCart, Tags, Truck, Users, Wallet, Wrench, X,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import type { Permiso } from '@shared/permisos';
import { ROL_LABEL } from '@shared/permisos';
import { Boton, cn, useDebounce } from './ui';

interface ItemNav {
  a: string;
  texto: string;
  icono: ReactNode;
  permiso?: Permiso;
}
const SECCIONES: Array<{ titulo: string; items: ItemNav[] }> = [
  {
    titulo: 'Taller',
    items: [
      { a: '/', texto: 'Inicio', icono: <Gauge className="size-[18px]" /> },
      { a: '/ordenes', texto: 'Órdenes de trabajo', icono: <Wrench className="size-[18px]" />, permiso: 'operacion' },
      { a: '/presupuestos', texto: 'Presupuestos', icono: <FileText className="size-[18px]" />, permiso: 'operacion' },
      { a: '/agenda', texto: 'Agenda', icono: <CalendarDays className="size-[18px]" />, permiso: 'operacion' },
      { a: '/clientes', texto: 'Clientes', icono: <Users className="size-[18px]" />, permiso: 'operacion' },
      { a: '/vehiculos', texto: 'Vehículos', icono: <Car className="size-[18px]" />, permiso: 'operacion' },
      { a: '/recordatorios', texto: 'Recordatorios', icono: <Bell className="size-[18px]" />, permiso: 'operacion' },
    ],
  },
  {
    titulo: 'Comercial',
    items: [
      { a: '/ventas', texto: 'Ventas y comprobantes', icono: <Receipt className="size-[18px]" />, permiso: 'ventas.ver' },
      { a: '/cobros', texto: 'Cobros', icono: <Wallet className="size-[18px]" />, permiso: 'ventas.ver' },
      { a: '/cuentas', texto: 'Cuentas corrientes', icono: <ClipboardList className="size-[18px]" />, permiso: 'ventas.ver' },
      { a: '/caja', texto: 'Caja', icono: <Banknote className="size-[18px]" />, permiso: 'caja.operar' },
      { a: '/finanzas', texto: 'Gastos y finanzas', icono: <PiggyBank className="size-[18px]" />, permiso: 'finanzas.ver' },
      { a: '/articulos', texto: 'Artículos y stock', icono: <Package className="size-[18px]" />, permiso: 'catalogo.ver' },
      { a: '/stock', texto: 'Movimientos de stock', icono: <Boxes className="size-[18px]" />, permiso: 'stock.ver' },
      { a: '/reposicion', texto: 'Reposición', icono: <PackageSearch className="size-[18px]" />, permiso: 'stock.ver' },
      { a: '/listas-precios', texto: 'Listas de precios', icono: <Tags className="size-[18px]" />, permiso: 'precios.gestionar' },
      { a: '/compras', texto: 'Compras', icono: <ShoppingCart className="size-[18px]" />, permiso: 'compras.gestionar' },
      { a: '/proveedores', texto: 'Proveedores', icono: <Truck className="size-[18px]" />, permiso: 'catalogo.ver' },
      { a: '/reportes', texto: 'Estadísticas', icono: <BarChart3 className="size-[18px]" />, permiso: 'reportes.ver' },
    ],
  },
  {
    titulo: 'Administración',
    items: [{ a: '/configuracion', texto: 'Configuración', icono: <Settings className="size-[18px]" /> }],
  },
];

function Marca() {
  return (
    <div className="flex items-center gap-2.5">
      <img src="/icon.svg" alt="" className="size-8" />
      <div className="leading-tight">
        <div className="text-[15px] font-extrabold tracking-tight">Fierro</div>
        <div className="text-[11px] text-tenue">Gestión de talleres</div>
      </div>
    </div>
  );
}

function Navegacion({ onNavegar }: { onNavegar?: () => void }) {
  const { puede } = useAuth();
  return (
    <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
      {SECCIONES.map((s) => {
        const items = s.items.filter((i) => !i.permiso || puede(i.permiso));
        if (!items.length) return null;
        return (
          <div key={s.titulo}>
            <div className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{s.titulo}</div>
            <ul className="space-y-0.5">
              {items.map((i) => (
                <li key={i.a}>
                  <NavLink
                    to={i.a}
                    end={i.a === '/'}
                    onClick={onNavegar}
                    className={({ isActive }) =>
                      cn('flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors', isActive ? 'bg-marca-50 text-marca-700' : 'text-slate-600 hover:bg-slate-100 hover:text-texto')
                    }
                  >
                    {i.icono}
                    {i.texto}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

function Usuario() {
  const { me, logout } = useAuth();
  if (!me) return null;
  return (
    <div className="flex items-center gap-2 border-t border-borde p-3">
      <div className="grid size-9 place-items-center rounded-full bg-marca-100 text-sm font-bold text-marca-700">{me.usuario.nombre.slice(0, 1).toUpperCase()}</div>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-sm font-medium">{me.usuario.nombre}</div>
        <div className="truncate text-xs text-tenue">{ROL_LABEL[me.usuario.rol]} · {me.taller.nombre}</div>
      </div>
      <Boton variante="fantasma" tam="sm" onClick={logout} aria-label="Cerrar sesión" title="Cerrar sesión" icono={<LogOut className="size-4" />} />
    </div>
  );
}

/** Búsqueda global por patente, cliente o número de OT (atajo Ctrl+K). */
function BusquedaGlobal({ abierto, onCerrar }: { abierto: boolean; onCerrar: () => void }) {
  const [q, setQ] = useState('');
  const dq = useDebounce(q, 250);
  const nav = useNavigate();
  const { data } = useQuery({ queryKey: ['buscar', dq], queryFn: () => api.get(`/buscar?q=${encodeURIComponent(dq)}`), enabled: abierto && dq.trim().length >= 2 });
  useEffect(() => {
    if (!abierto) setQ('');
  }, [abierto]);
  if (!abierto) return null;
  const ir = (to: string) => {
    onCerrar();
    nav(to);
  };
  const vacio = data && !data.clientes.length && !data.vehiculos.length && !data.ordenes.length;
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 p-4 pt-[10vh] backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onCerrar()}>
      <div className="mx-auto max-w-xl overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center gap-2 border-b border-borde px-4">
          <Search className="size-4 text-slate-400" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onCerrar()} placeholder="Patente, cliente o N° de OT…" className="h-14 flex-1 bg-transparent text-base outline-none" />
          <Boton variante="fantasma" tam="sm" onClick={onCerrar} icono={<X className="size-4" />} aria-label="Cerrar" />
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-2 text-sm">
          {dq.trim().length < 2 && <p className="px-3 py-6 text-center text-tenue">Escribí al menos 2 caracteres</p>}
          {vacio && <p className="px-3 py-6 text-center text-tenue">Sin resultados para “{dq}”</p>}
          {data?.vehiculos.length > 0 && <Grupo titulo="Vehículos">{data.vehiculos.map((v: any) => <Resultado key={v.id} onClick={() => ir(`/vehiculos/${v.id}`)} titulo={v.patente} detalle={`${[v.marca, v.modelo].filter(Boolean).join(' ')} · ${v.cliente}`} />)}</Grupo>}
          {data?.ordenes.length > 0 && <Grupo titulo="Órdenes">{data.ordenes.map((o: any) => <Resultado key={o.id} onClick={() => ir(`/ordenes/${o.id}`)} titulo={`OT #${String(o.numero).padStart(4, '0')}`} detalle={`${o.patente} · ${o.cliente}`} />)}</Grupo>}
          {data?.clientes.length > 0 && <Grupo titulo="Clientes">{data.clientes.map((c: any) => <Resultado key={c.id} onClick={() => ir(`/clientes/${c.id}`)} titulo={c.nombre} detalle={c.telefono ?? ''} />)}</Grupo>}
        </div>
      </div>
    </div>
  );
}
function Grupo({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <div className="mb-2">
      <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{titulo}</div>
      {children}
    </div>
  );
}
function Resultado({ titulo, detalle, onClick }: { titulo: string; detalle: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full flex-col rounded-lg px-3 py-2 text-left hover:bg-marca-50">
      <span className="font-medium">{titulo}</span>
      <span className="text-xs text-tenue">{detalle}</span>
    </button>
  );
}

export function Layout() {
  const [menu, setMenu] = useState(false);
  const [busqueda, setBusqueda] = useState(false);
  const { me } = useAuth();
  const loc = useLocation();
  useEffect(() => setMenu(false), [loc.pathname]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setBusqueda(true);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  return (
    <div className="flex h-full">
      {/* Barra lateral (escritorio) */}
      <aside className="no-print hidden w-64 shrink-0 flex-col border-r border-borde bg-white lg:flex">
        <div className="px-4 pb-1 pt-4"><Marca /></div>
        <Navegacion />
        <Usuario />
      </aside>

      {/* Menú deslizable (móvil/tablet) */}
      {menu && (
        <div className="no-print fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setMenu(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-white shadow-xl">
            <div className="flex items-center justify-between px-4 pb-1 pt-4">
              <Marca />
              <Boton variante="fantasma" tam="sm" onClick={() => setMenu(false)} icono={<X className="size-4" />} aria-label="Cerrar menú" />
            </div>
            <Navegacion onNavegar={() => setMenu(false)} />
            <Usuario />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-borde bg-white/90 px-3 backdrop-blur sm:px-5">
          <Boton variante="fantasma" tam="sm" className="lg:hidden" onClick={() => setMenu(true)} icono={<Menu className="size-5" />} aria-label="Abrir menú" />
          <div className="lg:hidden"><img src="/icon.svg" alt="Fierro" className="size-7" /></div>
          <button
            type="button"
            onClick={() => setBusqueda(true)}
            className="ml-1 flex h-9 max-w-md flex-1 items-center gap-2 rounded-lg border border-borde bg-slate-50 px-3 text-left text-sm text-slate-400 hover:bg-slate-100"
          >
            <Search className="size-4" />
            <span className="flex-1 truncate">Buscar patente, cliente u OT…</span>
            <kbd className="hidden rounded border border-borde bg-white px-1.5 text-[11px] text-tenue sm:inline">Ctrl K</kbd>
          </button>
          <div className="ml-auto hidden text-right text-xs leading-tight text-tenue sm:block">
            <div className="font-medium text-texto">{me?.taller.nombre}</div>
            {me?.licencia?.estado === 'suspendida' && <div className="font-medium text-red-600">Licencia suspendida · solo lectura</div>}
          </div>
        </header>
        {me?.licencia?.estado === 'suspendida' && (
          <div className="no-print bg-red-600 px-4 py-2 text-center text-sm text-white sm:hidden">Licencia suspendida: solo lectura</div>
        )}
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-7xl px-3 py-5 pb-24 sm:px-6 lg:pb-8">
            <Outlet />
          </div>
        </main>

        {/* Navegación inferior (móvil) */}
        <nav className="no-print fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-borde bg-white pb-[env(safe-area-inset-bottom)] lg:hidden">
          {[
            { a: '/', t: 'Inicio', i: <Gauge className="size-5" /> },
            { a: '/ordenes', t: 'Órdenes', i: <Wrench className="size-5" /> },
            { a: '/agenda', t: 'Agenda', i: <CalendarDays className="size-5" /> },
            { a: '/clientes', t: 'Clientes', i: <Users className="size-5" /> },
          ].map((x) => (
            <NavLink key={x.a} to={x.a} end={x.a === '/'} className={({ isActive }) => cn('flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium', isActive ? 'text-marca-700' : 'text-slate-500')}>
              {x.i}
              {x.t}
            </NavLink>
          ))}
        </nav>
      </div>
      <BusquedaGlobal abierto={busqueda} onCerrar={() => setBusqueda(false)} />
    </div>
  );
}

export function SoloSiPuede({ permiso, children }: { permiso: Permiso; children: ReactNode }) {
  const { puede } = useAuth();
  return puede(permiso) ? <>{children}</> : null;
}

