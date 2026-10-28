import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, ChevronDown, ChevronRight, Clock, Gauge, HardHat, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Search, Users, Wrench, X } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { buscarSecciones, gruposVisibles, resaltar, ubicar, type ItemNav } from '@/lib/navegacion';
import type { Permiso } from '@shared/permisos';
import { ROL_LABEL } from '@shared/permisos';
import { Boton, cn, useDebounce } from './ui';
import { Isotipo, MarcaProducto } from './Marca';

function Marca() {
  return (
    <MarcaProducto oscuro />
  );
}

const CLAVE_CONTRAIDO = 'fierro.menu.contraido';
const leerContraido = (): boolean => { try { return localStorage.getItem(CLAVE_CONTRAIDO) === '1'; } catch { return false; } };
const guardarContraido = (v: boolean) => { try { localStorage.setItem(CLAVE_CONTRAIDO, v ? '1' : '0'); } catch { /* sin almacenamiento */ } };

const CLAVE_MENU = 'fierro.menu.abierto';
const leerAbierto = (): string | null => { try { return localStorage.getItem(CLAVE_MENU); } catch { return null; } };
const guardarAbierto = (v: string | null) => { try { v ? localStorage.setItem(CLAVE_MENU, v) : localStorage.removeItem(CLAVE_MENU); } catch { /* sin almacenamiento */ } };

function EnlaceItem({ it, activo, consulta, onNavegar }: { it: ItemNav; activo: boolean; consulta?: string; onNavegar?: () => void }) {
  return (
    <Link
      to={it.a}
      onClick={onNavegar}
      title={it.texto}
      aria-current={activo ? 'page' : undefined}
      className={cn('relative flex items-center gap-2.5 rounded-ctl px-2.5 py-2 text-sm font-medium transition-colors', activo ? 'bg-white/12 text-white before:absolute before:inset-y-1.5 before:-left-0.5 before:w-[3px] before:rounded-full before:bg-sky-400' : 'text-petroleo-100/85 hover:bg-white/7 hover:text-white')}
    >
      {it.icono}
      <span className="truncate">{consulta ? resaltar(it.texto, consulta) : it.texto}</span>
    </Link>
  );
}

/** Menú lateral: buscador de secciones fijo arriba y grupos desplegables (acordeón) que se desplazan solos. */
function Navegacion({ onNavegar, compacto = false, onExpandir }: { onNavegar?: () => void; compacto?: boolean; onExpandir?: () => void }) {
  const { puede } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  const grupos = gruposVisibles(puede);
  const actual = ubicar(loc.pathname, loc.search);
  const [abierto, setAbierto] = useState<string | null>(() => actual?.grupo.id ?? leerAbierto());
  const [q, setQ] = useState('');
  const entrada = useRef<HTMLInputElement>(null);
  const grupoActual = actual?.grupo.id;
  // Menú contraído: el grupo cuyo panel flotante está abierto y dónde anclarlo.
  const [flotante, setFlotante] = useState<{ id: string; top: number; left: number } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => setFlotante(null), [loc.pathname, loc.search, compacto]);
  useEffect(() => {
    if (!flotante) return;
    const fuera = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!panel.current?.contains(t) && !t.closest('[data-grupo-btn]')) setFlotante(null);
    };
    const tecla = (e: KeyboardEvent) => { if (e.key === 'Escape') setFlotante(null); };
    document.addEventListener('mousedown', fuera);
    document.addEventListener('keydown', tecla);
    return () => { document.removeEventListener('mousedown', fuera); document.removeEventListener('keydown', tecla); };
  }, [flotante]);

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

  if (compacto) {
    const base = 'relative grid h-10 w-full place-items-center rounded-ctl transition-colors';
    const estado = (act: boolean) => (act ? 'bg-white/12 text-white before:absolute before:inset-y-1.5 before:-left-0.5 before:w-[3px] before:rounded-full before:bg-sky-400' : 'text-petroleo-100/85 hover:bg-white/7 hover:text-white');
    const gf = flotante ? grupos.find((g) => g.id === flotante.id) : undefined;
    return (
      <>
        <div className="px-2 pb-1 pt-3">
          <button type="button" onClick={onExpandir} title="Buscar sección" aria-label="Buscar sección (expande el menú)" className={cn(base, 'border border-petroleo-700 bg-petroleo-800 text-petroleo-200 hover:text-white')}>
            <Search className="size-4" />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto overflow-x-hidden px-2 pb-4" aria-label="Secciones">
          <ul className="space-y-1">
            {grupos.map((g) => {
              if (g.id === 'inicio') {
                const it = g.items[0];
                return (
                  <li key={g.id}>
                    <Link to={it.a} title="Inicio" aria-label="Inicio" aria-current={actual?.item.id === it.id ? 'page' : undefined} className={cn(base, estado(actual?.item.id === it.id))}>{it.icono}</Link>
                  </li>
                );
              }
              const abre = flotante?.id === g.id;
              return (
                <li key={g.id}>
                  <button
                    type="button"
                    data-grupo-btn
                    title={g.titulo}
                    aria-label={g.titulo}
                    aria-haspopup="true"
                    aria-expanded={abre}
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      setFlotante(abre ? null : { id: g.id, top: r.top, left: r.right + 8 });
                    }}
                    className={cn(base, estado(actual?.grupo.id === g.id || abre))}
                  >
                    {g.icono}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        {flotante && gf && (
          <div
            ref={panel}
            role="menu"
            aria-label={gf.titulo}
            style={{ top: Math.max(8, Math.min(flotante.top, window.innerHeight - 56 - gf.items.length * 36)), left: flotante.left }}
            className="no-print fixed z-50 max-h-[calc(100vh-1rem)] w-60 overflow-y-auto rounded-card border border-petroleo-700 bg-petroleo-900 p-2 shadow-modal"
          >
            <div className="mb-1 px-2 text-micro font-semibold uppercase tracking-wider text-petroleo-300">{gf.titulo}</div>
            <ul className="space-y-0.5">
              {gf.items.map((i) => (
                <li key={i.id}><EnlaceItem it={i} activo={actual?.item.id === i.id} onNavegar={() => setFlotante(null)} /></li>
              ))}
            </ul>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <div className="px-3 pb-2 pt-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-petroleo-300" />
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
            className="h-9 w-full rounded-ctl border border-petroleo-700 bg-petroleo-800 pl-8 pr-7 text-base text-white outline-none placeholder:text-petroleo-300 focus:border-sky-400 focus:ring-2 focus:ring-sky-400/25 sm:text-sm"
          />
          {buscando ? (
            <button type="button" onClick={() => { setQ(''); entrada.current?.focus(); }} aria-label="Limpiar búsqueda" className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-petroleo-300 hover:text-white">
              <X className="size-3.5" />
            </button>
          ) : (
            <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-petroleo-600 bg-petroleo-700 px-1.5 text-micro text-petroleo-200 lg:block">/</kbd>
          )}
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 pb-4" aria-label="Secciones">
        {buscando ? (
          resultados.length ? (
            resultados.map((r) => (
              <div key={r.grupo.id} className="mt-2">
                <div className="mb-1 px-2 text-micro font-semibold uppercase tracking-wider text-petroleo-300">{r.grupo.titulo}</div>
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
            <p className="px-2 py-6 text-center text-sm text-petroleo-300">No se encontraron secciones</p>
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
                    className={cn('flex w-full items-center gap-2.5 rounded-ctl px-2.5 py-2 text-sm font-semibold transition-colors hover:bg-white/7', contieneActivo ? 'text-white' : 'text-petroleo-100')}
                  >
                    {g.icono}
                    <span className="flex-1 text-left">{g.titulo}</span>
                    <ChevronDown className={cn('size-4 text-petroleo-300 transition-transform duration-200', abre && 'rotate-180')} />
                  </button>
                  <div id={`menu-${g.id}`} className={cn('grid transition-[grid-template-rows] duration-200 ease-out', abre ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
                    <ul className={cn('ml-4 min-h-0 space-y-0.5 overflow-hidden border-l border-petroleo-700 pl-2', abre ? 'mt-0.5 pb-1' : 'invisible')}>
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

function Usuario({ compacto = false }: { compacto?: boolean }) {
  const { me, logout } = useAuth();
  if (!me) return null;
  if (compacto) {
    return (
      <div className="flex flex-col items-center gap-1 border-t border-petroleo-800 px-2 py-3">
        <div title={`${me.usuario.nombre} · ${ROL_LABEL[me.usuario.rol]} · ${me.taller.nombre}`} className="grid size-9 shrink-0 place-items-center rounded-full bg-petroleo-600 text-sm font-bold text-white">{me.usuario.nombre.slice(0, 1).toUpperCase()}</div>
        <Boton variante="fantasma" tam="sm" className="text-petroleo-200 hover:bg-white/10 hover:text-white" onClick={logout} aria-label="Cerrar sesión" title="Cerrar sesión" icono={<LogOut className="size-4" />} />
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 border-t border-petroleo-800 p-3">
      <div className="grid size-9 shrink-0 place-items-center rounded-full bg-petroleo-600 text-sm font-bold text-white">{me.usuario.nombre.slice(0, 1).toUpperCase()}</div>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-sm font-medium text-white">{me.usuario.nombre}</div>
        <div className="truncate text-xs text-petroleo-300">{ROL_LABEL[me.usuario.rol]} · {me.taller.nombre}</div>
      </div>
      <Boton variante="fantasma" tam="sm" className="text-petroleo-200 hover:bg-white/10 hover:text-white" onClick={logout} aria-label="Cerrar sesión" title="Cerrar sesión" icono={<LogOut className="size-4" />} />
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
    <div className="fixed inset-0 z-50 bg-petroleo-950/50 p-4 pt-[10vh] backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onCerrar()}>
      <div className="mx-auto max-w-xl overflow-hidden rounded-modal bg-white shadow-modal">
        <div className="flex items-center gap-2 border-b border-borde px-4">
          <Search className="size-4 text-slate-500" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onCerrar()} placeholder="Patente, cliente o N° de OT…" className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none" />
          <Boton variante="fantasma" tam="sm" onClick={onCerrar} icono={<X className="size-4" />} aria-label="Cerrar" />
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-2 text-sm">
          {dq.trim().length < 2 && <p className="px-3 py-6 text-center text-tenue">Escribí al menos 2 caracteres</p>}
          {vacio && <p className="px-3 py-6 text-center text-tenue">Sin resultados para “{dq}”</p>}
          {data?.vehiculos.length > 0 && <Grupo titulo="Vehículos">{data.vehiculos.map((v: any) => <Resultado key={v.id} onClick={() => ir(`/vehiculos/${v.id}`)} titulo={v.patente} detalle={[[v.marca, v.modelo].filter(Boolean).join(' '), v.cliente].filter(Boolean).join(' · ')} />)}</Grupo>}
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
      <div className="px-3 py-1 text-micro font-semibold uppercase tracking-wider text-slate-500">{titulo}</div>
      {children}
    </div>
  );
}
function Resultado({ titulo, detalle, onClick }: { titulo: string; detalle: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full flex-col rounded-ctl px-3 py-2 text-left hover:bg-marca-50">
      <span className="font-medium">{titulo}</span>
      <span className="text-xs text-tenue">{detalle}</span>
    </button>
  );
}

export function Layout() {
  const [menu, setMenu] = useState(false);
  const [busqueda, setBusqueda] = useState(false);
  const [contraido, setContraido] = useState(leerContraido);
  const alternar = (v: boolean) => { setContraido(v); guardarContraido(v); };
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
      <aside className={cn('no-print hidden shrink-0 flex-col bg-petroleo-900 transition-[width] duration-200 lg:flex', contraido ? 'w-[4.25rem]' : 'w-menu')}>
        {contraido ? (
          <div className="flex flex-col items-center gap-2 px-2 pb-1 pt-4">
            <div className="grid size-10 place-items-center rounded-ctl bg-white"><Isotipo className="size-7" /></div>
            <Boton variante="fantasma" tam="sm" className="text-petroleo-200 hover:bg-white/10 hover:text-white" onClick={() => alternar(false)} icono={<PanelLeftOpen className="size-4" />} aria-label="Expandir menú" title="Expandir menú" />
          </div>
        ) : (
          <div className="flex items-start justify-between gap-1 px-4 pb-1 pt-4">
            <Marca />
            <Boton variante="fantasma" tam="sm" className="text-petroleo-200 hover:bg-white/10 hover:text-white" onClick={() => alternar(true)} icono={<PanelLeftClose className="size-4" />} aria-label="Contraer menú" title="Contraer menú" />
          </div>
        )}
        <Navegacion compacto={contraido} onExpandir={() => alternar(false)} />
        <Usuario compacto={contraido} />
      </aside>

      {/* Menú deslizable (móvil/tablet) */}
      {menu && (
        <div className="no-print fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-petroleo-950/55" onClick={() => setMenu(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-petroleo-900 shadow-modal">
            <div className="flex items-center justify-between px-4 pb-1 pt-4">
              <Marca />
              <Boton variante="fantasma" tam="sm" className="text-petroleo-200 hover:bg-white/10 hover:text-white" onClick={() => setMenu(false)} icono={<X className="size-4" />} aria-label="Cerrar menú" />
            </div>
            <Navegacion onNavegar={() => setMenu(false)} />
            <Usuario />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-borde bg-white/95 px-3 backdrop-blur sm:px-5 lg:px-8">
          <Boton variante="fantasma" tam="sm" className="lg:hidden" onClick={() => setMenu(true)} icono={<Menu className="size-5" />} aria-label="Abrir menú" />
          <div className="lg:hidden"><Isotipo className="size-7" /></div>
          {puedeBuscar && (
            <button
              type="button"
              onClick={() => setBusqueda(true)}
              className="ml-1 flex h-9 min-w-0 max-w-md flex-1 items-center gap-2 rounded-ctl border border-borde bg-superficie-2 px-3 text-left text-sm text-slate-500 hover:border-borde-fuerte hover:bg-slate-100"
            >
              <Search className="size-4" />
              <span className="flex-1 truncate">Buscar patente, cliente u OT…</span>
              <kbd className="hidden rounded border border-borde bg-white px-1.5 text-micro text-tenue sm:inline">Ctrl K</kbd>
            </button>
          )}
          <div className="ml-auto hidden min-w-0 max-w-[40%] text-right text-xs leading-tight text-tenue sm:block">
            <div className="truncate font-medium text-texto">{me?.taller.nombre}</div>
            {me?.licencia?.estado === 'suspendida' && <div className="font-medium text-red-600">Licencia suspendida · solo lectura</div>}
          </div>
        </header>
        {me?.licencia?.estado === 'suspendida' && (
          <div className="no-print bg-peligro-600 px-4 py-2 text-center text-sm text-white sm:hidden">Licencia suspendida: solo lectura</div>
        )}
        <main className="min-w-0 flex-1 overflow-y-auto">
          {/* Ancho máximo del contenido (1600 px): en monitores grandes queda centrado y en pantallas chicas ocupa todo el ancho. */}
          <div className="mx-auto w-full max-w-contenido px-4 py-5 pb-24 sm:px-6 lg:px-8 lg:pb-10">
            <Migas />
            <Outlet />
          </div>
        </main>

        {/* Navegación inferior (móvil) */}
        <nav className="no-print fixed inset-x-0 bottom-0 z-30 grid border-t border-borde bg-white pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_12px_-6px_rgb(18_30_48/0.15)] lg:hidden" style={{ gridTemplateColumns: `repeat(${Math.max(atajos.length, 1)}, minmax(0, 1fr))` }}>
          {atajos.map((x) => (
            <NavLink key={x.a} to={x.a} end={x.a === '/'} className={({ isActive }) => cn('flex min-w-0 flex-col items-center gap-0.5 px-1 py-2 text-micro font-medium', isActive ? 'text-marca-700' : 'text-slate-500')}>
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

