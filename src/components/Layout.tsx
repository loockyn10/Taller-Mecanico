import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, ChevronDown, ChevronRight, Clock, Gauge, HardHat, LogOut, Menu, Search, Users, Wrench, X } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { buscarSecciones, gruposVisibles, resaltar, ubicar, type ItemNav } from '@/lib/navegacion';
import type { Permiso } from '@shared/permisos';
import { ROL_LABEL } from '@shared/permisos';
import { Boton, cn, useDebounce } from './ui';

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

const CLAVE_MENU = 'fierro.menu.abierto';
const leerAbierto = (): string | null => { try { return localStorage.getItem(CLAVE_MENU); } catch { return null; } };
const guardarAbierto = (v: string | null) => { try { v ? localStorage.setItem(CLAVE_MENU, v) : localStorage.removeItem(CLAVE_MENU); } catch { /* sin almacenamiento */ } };

function EnlaceItem({ it, activo, consulta, onNavegar }: { it: ItemNav; activo: boolean; consulta?: string; onNavegar?: () => void }) {
  return (
    <Link
      to={it.a}
      onClick={onNavegar}
      aria-current={activo ? 'page' : undefined}
      className={cn('flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors', activo ? 'bg-marca-50 text-marca-700' : 'text-slate-600 hover:bg-slate-100 hover:text-texto')}
    >
      {it.icono}
      <span className="truncate">{consulta ? resaltar(it.texto, consulta) : it.texto}</span>
    </Link>
  );
}

/** Menú lateral: buscador de secciones fijo arriba y grupos desplegables (acordeón) que se desplazan solos. */
function Navegacion({ onNavegar }: { onNavegar?: () => void }) {
  const { puede } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  const grupos = gruposVisibles(puede);
  const actual = ubicar(loc.pathname, loc.search);
  const [abierto, setAbierto] = useState<string | null>(() => actual?.grupo.id ?? leerAbierto());
  const [q, setQ] = useState('');
  const entrada = useRef<HTMLInputElement>(null);
  const grupoActual = actual?.grupo.id;

  // La categoría de la pantalla actual se abre sola al navegar; después se puede cerrar a mano.
  useEffect(() => {
    if (grupoActual && grupoActual !== 'inicio') setAbierto(grupoActual);
  }, [grupoActual]);
  useEffect(() => guardarAbierto(abierto), [abierto]);

  // Atajo "/" para enfocar el buscador cuando no se está escribiendo en otro campo.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const el = entrada.current;
      if (!el || el.offsetParent === null) return; // instancia oculta (otra vista)
      e.preventDefault();
      el.focus();
      el.select();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const resultados = buscarSecciones(grupos, q);
  const buscando = q.trim().length > 0;
  const ir = (it: ItemNav) => {
    setQ('');
    entrada.current?.blur();
    onNavegar?.();
    nav(it.a);
  };

  return (
    <>
      <div className="px-3 pb-2 pt-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input
            ref={entrada}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setQ(''); e.currentTarget.blur(); }
              if (e.key === 'Enter' && resultados[0]) ir(resultados[0].items[0]);
            }}
            placeholder="Buscar sección..."
            aria-label="Buscar sección"
            className="h-9 w-full rounded-lg border border-borde bg-slate-50 pl-8 pr-7 text-sm outline-none placeholder:text-slate-400 focus:border-marca-400 focus:bg-white focus:ring-2 focus:ring-marca-100"
          />
          {buscando ? (
            <button type="button" onClick={() => { setQ(''); entrada.current?.focus(); }} aria-label="Limpiar búsqueda" className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-texto">
              <X className="size-3.5" />
            </button>
          ) : (
            <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-borde bg-white px-1.5 text-[11px] text-tenue lg:block">/</kbd>
          )}
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 pb-4" aria-label="Secciones">
        {buscando ? (
          resultados.length ? (
            resultados.map((r) => (
              <div key={r.grupo.id} className="mt-2">
                <div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{r.grupo.titulo}</div>
                <ul className="space-y-0.5">
                  {r.items.map((i) => (
                    <li key={i.id}>
                      <EnlaceItem it={i} activo={actual?.item.id === i.id} consulta={q} onNavegar={() => { setQ(''); onNavegar?.(); }} />
                    </li>
                  ))}
                </ul>
              </div>
            ))
          ) : (
            <p className="px-2 py-6 text-center text-sm text-tenue">No se encontraron secciones</p>
          )
        ) : (
          <ul className="space-y-0.5">
            {grupos.map((g) => {
              if (g.id === 'inicio') {
                const it = g.items[0];
                return (
                  <li key={g.id}>
                    <EnlaceItem it={{ ...it, texto: 'Inicio' }} activo={actual?.item.id === it.id} onNavegar={onNavegar} />
                  </li>
                );
              }
              const abre = abierto === g.id;
              const contieneActivo = actual?.grupo.id === g.id;
              return (
                <li key={g.id}>
                  <button
                    type="button"
                    onClick={() => setAbierto(abre ? null : g.id)}
                    aria-expanded={abre}
                    aria-controls={`menu-${g.id}`}
                    className={cn('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-semibold transition-colors hover:bg-slate-100', contieneActivo ? 'text-marca-700' : 'text-slate-700')}
                  >
                    {g.icono}
                    <span className="flex-1 text-left">{g.titulo}</span>
                    <ChevronDown className={cn('size-4 text-slate-400 transition-transform duration-200', abre && 'rotate-180')} />
                  </button>
                  <div id={`menu-${g.id}`} className={cn('grid transition-[grid-template-rows] duration-200 ease-out', abre ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
                    <ul className={cn('ml-4 min-h-0 space-y-0.5 overflow-hidden border-l border-borde pl-2', abre ? 'mt-0.5 pb-1' : 'invisible')}>
                      {g.items.map((i) => (
                        <li key={i.id}>
                          <EnlaceItem it={i} activo={actual?.item.id === i.id} onNavegar={onNavegar} />
                        </li>
                      ))}
                    </ul>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </>
  );
}

/** Migas de pan: módulo › sección › pantalla. Sólo aparecen fuera del inicio. */
function Migas() {
  const loc = useLocation();
  const u = ubicar(loc.pathname, loc.search);
  if (!u || u.grupo.id === 'inicio') return null;
  return (
    <nav aria-label="Ubicación" className="no-print mb-3 flex flex-wrap items-center gap-1 text-xs text-tenue">
      <span>{u.grupo.titulo}</span>
      <ChevronRight className="size-3" />
      {u.detalle ? <Link to={u.item.a} className="hover:text-marca-700 hover:underline">{u.item.texto}</Link> : <span className="font-medium text-texto">{u.item.texto}</span>}
      {u.detalle && (
        <>
          <ChevronRight className="size-3" />
          <span className="font-medium text-texto">{u.detalle}</span>
        </>
      )}
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
  const { soloMecanico } = useAuth();
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
          {data?.ordenes.length > 0 && <Grupo titulo="Órdenes">{data.ordenes.map((o: any) => <Resultado key={o.id} onClick={() => ir(soloMecanico ? `/mis-trabajos/${o.id}` : `/ordenes/${o.id}`)} titulo={`OT #${String(o.numero).padStart(4, '0')}`} detalle={[o.patente, o.cliente].filter(Boolean).join(' · ')} />)}</Grupo>}
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
  const { me, puede, soloMecanico } = useAuth();
  const loc = useLocation();
  useEffect(() => setMenu(false), [loc.pathname]);
  const puedeBuscar = puede('clientes.ver') || puede('vehiculos.ver') || puede('ordenes.ver') || puede('ordenes.asignadas');
  // Atajos de la barra inferior (celular/tablet) según lo que la persona puede hacer.
  const atajos = [
    { a: '/', t: 'Inicio', i: <Gauge className="size-5" />, ok: !soloMecanico },
    { a: '/mis-trabajos', t: 'Mis trabajos', i: <HardHat className="size-5" />, ok: soloMecanico },
    { a: '/ordenes', t: 'Órdenes', i: <Wrench className="size-5" />, ok: puede('ordenes.ver') },
    { a: '/agenda', t: 'Agenda', i: <CalendarDays className="size-5" />, ok: puede('turnos.ver') },
    { a: '/clientes', t: 'Clientes', i: <Users className="size-5" />, ok: puede('clientes.ver') },
    { a: '/asistencia', t: 'Asistencia', i: <Clock className="size-5" />, ok: puede('asistencia.fichar') },
  ].filter((x) => x.ok).slice(0, 4);
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
          {puedeBuscar && (
            <button
              type="button"
              onClick={() => setBusqueda(true)}
              className="ml-1 flex h-9 max-w-md flex-1 items-center gap-2 rounded-lg border border-borde bg-slate-50 px-3 text-left text-sm text-slate-400 hover:bg-slate-100"
            >
              <Search className="size-4" />
              <span className="flex-1 truncate">Buscar patente, cliente u OT…</span>
              <kbd className="hidden rounded border border-borde bg-white px-1.5 text-[11px] text-tenue sm:inline">Ctrl K</kbd>
            </button>
          )}
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
            <Migas />
            <Outlet />
          </div>
        </main>

        {/* Navegación inferior (móvil) */}
        <nav className="no-print fixed inset-x-0 bottom-0 z-30 grid border-t border-borde bg-white pb-[env(safe-area-inset-bottom)] lg:hidden" style={{ gridTemplateColumns: `repeat(${Math.max(atajos.length, 1)}, minmax(0, 1fr))` }}>
          {atajos.map((x) => (
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

