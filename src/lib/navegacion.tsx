// Registro único de la navegación de Fierro: lo usan el menú lateral, el buscador de secciones y las migas de pan.
// Para agregar una pantalla al menú se agrega una línea acá (con su permiso y sus palabras clave).
import type { ReactNode } from 'react';
import {
  Banknote, BarChart3, Bell, Boxes, Calculator, CalendarDays, Car, ClipboardCheck, ClipboardList, FileSpreadsheet, FileText, Gauge, Landmark, PackageSearch, Package, PiggyBank,
  Receipt, Scale, ScrollText, Settings, ShoppingCart, Tags, Truck, UserCog, Users, Wallet, Wrench, KeyRound, ShieldCheck, History, UserRound, BadgeDollarSign, ShoppingBasket,
  Warehouse, Clock, MonitorSmartphone, Rocket, Upload, UsersRound, CalendarCheck, HardHat, Timer, Activity, BookOpen,
  type LucideIcon,
} from 'lucide-react';
import type { Permiso } from '@shared/permisos';

export interface ItemNav {
  id: string;
  texto: string;
  /** Destino completo (puede incluir ?tab=). */
  a: string;
  ruta: string;
  tab?: string;
  icono: ReactNode;
  permiso?: Permiso;
  /** Condición adicional de visibilidad (por ejemplo, ocultar "Mis trabajos" a quien ya ve todas las órdenes). */
  visible?: (puede: (p: Permiso) => boolean) => boolean;
  /** Palabras clave para el buscador de secciones (sin tildes ni mayúsculas no hace falta: se normalizan). */
  claves: string;
}
export interface GrupoNav {
  id: string;
  titulo: string;
  icono: ReactNode;
  items: ItemNav[];
}

const ic = (I: LucideIcon) => <I className="size-[18px]" />;
function item(id: string, texto: string, a: string, I: LucideIcon, claves: string, permiso?: Permiso, tabPorDefecto?: string, visible?: ItemNav['visible']): ItemNav {
  const [ruta, qs] = a.split('?');
  const tab = qs ? new URLSearchParams(qs).get('tab') ?? undefined : tabPorDefecto;
  return { id, texto, a, ruta, tab, icono: ic(I), permiso, claves, visible };
}

export const GRUPOS: GrupoNav[] = [
  { id: 'inicio', titulo: 'Inicio', icono: ic(Gauge), items: [item('inicio', 'Dashboard', '/', Gauge, 'inicio resumen panel indicadores')] },
  {
    id: 'taller', titulo: 'Taller', icono: ic(Wrench),
    items: [
      item('mis-trabajos', 'Mis trabajos', '/mis-trabajos', HardHat, 'ot asignados reparaciones tareas mecanico celular', 'ordenes.asignadas', undefined, (puede) => !puede('ordenes.ver')),
      item('ordenes', 'Órdenes de trabajo', '/ordenes', Wrench, 'ot reparaciones trabajos tablero kanban', 'ordenes.ver'),
      item('presupuestos', 'Presupuestos', '/presupuestos', FileText, 'cotizacion cotizaciones', 'presupuestos.ver'),
      item('agenda', 'Agenda', '/agenda', CalendarDays, 'turnos calendario citas', 'turnos.ver'),
      item('clientes', 'Clientes', '/clientes', Users, 'cliente personas contactos', 'clientes.ver'),
      item('vehiculos', 'Vehículos', '/vehiculos', Car, 'autos patentes historial', 'vehiculos.ver'),
      item('mantenimientos', 'Mantenimientos', '/mantenimientos', Bell, 'service vencimientos avisos recordatorios programados kilometraje proximos vencidos', 'mantenimientos.ver'),
      item('catalogo-auto', 'Catálogo automotor', '/catalogo-automotor', BookOpen, 'marcas modelos versiones motor motorizacion ficha tecnica manual aceite dnrpa autos', undefined, undefined, (puede) => puede('vehiculos.ver') || puede('catalogo.ver') || puede('ordenes.asignadas')),
      item('tempario', 'Tempario', '/tempario', Timer, 'tiempos mano de obra operaciones servicios tarifas horas precios catalogo', 'catalogo.ver'),
      item('mecanicos', 'Mecánicos sin usuario', '/configuracion?tab=mecanicos', UserCog, 'operarios equipo tercerizados', 'usuarios.gestionar'),
    ],
  },
  {
    id: 'inventario', titulo: 'Inventario', icono: ic(Package),
    items: [
      item('articulos', 'Artículos', '/articulos', Package, 'stock repuestos productos existencias', 'catalogo.ver'),
      item('stock', 'Movimientos de stock', '/stock', Boxes, 'stock entradas salidas ajustes', 'stock.ver'),
      item('reposicion', 'Reposición', '/reposicion', PackageSearch, 'stock faltantes minimo pedir', 'stock.ver'),
      item('depositos', 'Depósitos y transferencias', '/depositos', Warehouse, 'depositos transferencias sucursal almacen camioneta mostrador stock ubicacion', 'stock.ver'),
      item('inventario', 'Control de inventario', '/inventario', ClipboardCheck, 'stock conteo fisico valorizado existencias', 'stock.ver'),
      item('listas', 'Listas de precios', '/listas-precios', Tags, 'precio precios margen mayorista', 'precios.gestionar'),
    ],
  },
  {
    id: 'ventas', titulo: 'Ventas', icono: ic(Receipt),
    items: [
      item('ventas', 'Ventas y comprobantes', '/ventas', Receipt, 'facturacion comprobantes recibos mostrador', 'ventas.ver'),
      item('mostrador', 'Venta de mostrador', '/ventas/nueva', BadgeDollarSign, 'vender nueva venta rapida', 'ventas.emitir'),
      item('cobros', 'Cobranzas', '/cobros', Wallet, 'cobros pagos recibos', 'ventas.ver'),
      item('cuentas', 'Cuentas corrientes', '/cuentas', ClipboardList, 'cliente deuda saldo deudores', 'ventas.ver'),
    ],
  },
  {
    id: 'compras', titulo: 'Compras', icono: ic(ShoppingCart),
    items: [
      item('oc', 'Órdenes de compra', '/ordenes-compra', ClipboardList, 'pedidos recepcion mercaderia recibir', 'compras.ver'),
      item('compras', 'Compras', '/compras', ShoppingBasket, 'ingreso mercaderia compra directa', 'compras.ver'),
      item('facturas', 'Facturas de proveedores', '/facturas-proveedor', FileText, 'comprobantes vencimientos deuda notas credito', 'compras.ver'),
      item('proveedores', 'Proveedores', '/proveedores', Truck, 'pagos cuenta corriente deuda', 'compras.ver'),
    ],
  },
  {
    id: 'finanzas', titulo: 'Finanzas', icono: ic(Landmark),
    items: [
      item('caja', 'Caja diaria', '/caja', Banknote, 'caja efectivo arqueo cierre apertura', 'caja.operar'),
      item('tesoreria', 'Tesorería', '/tesoreria', Scale, 'disponible dinero liquidez flujo', 'tesoreria.ver'),
      item('bancos', 'Bancos', '/bancos', Landmark, 'cuentas conciliacion transferencias depositos', 'bancos.ver'),
      item('cheques', 'Cheques y eCheq', '/cheques', ScrollText, 'cheque echeq cartera', 'cheques.gestionar'),
      item('gastos', 'Gastos y finanzas', '/finanzas', PiggyBank, 'gastos egresos resultado recurrentes', 'finanzas.ver'),
    ],
  },
  {
    id: 'informes', titulo: 'Informes', icono: ic(BarChart3),
    items: [
      item('estadisticas', 'Estadísticas', '/reportes', BarChart3, 'graficos ventas indicadores mecanicos', 'reportes.ver'),
      item('productividad', 'Productividad', '/productividad', Activity, 'mecanicos horas tareas carga de trabajo rendimiento asistencia tiempos', 'productividad.ver'),
      item('informes', 'Informes', '/informes', FileSpreadsheet, 'reportes exportar excel csv comerciales financieros', 'reportes.ver'),
      item('contabilidad', 'Contabilidad', '/contabilidad', Calculator, 'asientos plan de cuentas libro diario mayor balance resultados libro ventas compras iva impuestos', 'contabilidad.ver'),
    ],
  },
  {
    id: 'personal', titulo: 'Personal', icono: ic(UsersRound),
    items: [
      item('asistencia', 'Mi asistencia', '/asistencia', Clock, 'fichar entrada salida jornada horas reloj', 'asistencia.fichar'),
      item('equipo', 'Equipo y permisos', '/personal/equipo', KeyRound, 'usuarios empleados roles permisos accesos pin', 'usuarios.gestionar'),
      item('panel-asistencia', 'Panel de asistencia', '/personal/asistencia', CalendarCheck, 'presentes ausentes horas fichajes jornadas correcciones', 'asistencia.ver'),
      item('reloj', 'Reloj compartido', '/personal/reloj', MonitorSmartphone, 'tablet fichaje pin dispositivos kiosco', 'reloj.administrar'),
    ],
  },
  {
    id: 'admin', titulo: 'Administración', icono: ic(Settings),
    items: [
      item('config', 'Configuración', '/configuracion', Settings, 'taller datos parametros preferencias documentos medios de pago', undefined, 'taller'),
      item('puesta', 'Puesta en marcha', '/puesta-en-marcha', Rocket, 'configuracion inicial asistente pasos primeros pasos empezar progreso', 'config.editar'),
      item('importar', 'Importar datos', '/importar', Upload, 'excel csv planilla importacion migrar clientes vehiculos articulos proveedores sistema anterior', 'datos.importar'),
      item('apertura', 'Apertura de saldos', '/apertura-saldos', Scale, 'saldos iniciales apertura deudas proveedores migrar sistema anterior corte', 'aperturas.gestionar'),
      item('catalogos', 'Marcas y categorías', '/configuracion?tab=catalogos', Tags, 'catalogos marcas modelos categorias', 'catalogo.editar'),
      item('licencia', 'Licencia', '/configuracion?tab=licencia', ShieldCheck, 'plan suscripcion usuarios', 'licencia.ver'),
      item('actividad', 'Actividad', '/configuracion?tab=auditoria', History, 'auditoria registro cambios', 'config.editar'),
      item('cuenta', 'Mi cuenta', '/configuracion?tab=cuenta', UserRound, 'contrasena clave perfil'),
    ],
  },
];

export const TODOS_LOS_ITEMS: ItemNav[] = GRUPOS.flatMap((g) => g.items);

/** Grupos con sólo las secciones que el usuario puede ver (los grupos vacíos desaparecen). */
export function gruposVisibles(puede: (p: Permiso) => boolean): GrupoNav[] {
  return GRUPOS.map((g) => ({ ...g, items: g.items.filter((i) => (!i.permiso || puede(i.permiso)) && (!i.visible || i.visible(puede))) })).filter((g) => g.items.length);
}

export const normalizar = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export interface ResultadoGrupo {
  grupo: GrupoNav;
  items: ItemNav[];
}
/** Filtra por nombre, módulo y palabras clave; ignora mayúsculas y tildes; todas las palabras escritas deben coincidir. */
export function buscarSecciones(grupos: GrupoNav[], consulta: string): ResultadoGrupo[] {
  const tokens = normalizar(consulta).split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  return grupos
    .map((g) => ({
      grupo: g,
      items: g.items.filter((i) => {
        const pajar = normalizar(`${i.texto} ${g.titulo} ${i.claves}`);
        return tokens.every((t) => pajar.includes(t));
      }),
    }))
    .filter((r) => r.items.length);
}

/** Resalta en `texto` las partes que coinciden con la consulta (sin distinguir tildes ni mayúsculas). */
export function resaltar(texto: string, consulta: string): ReactNode {
  const tokens = normalizar(consulta).split(/\s+/).filter(Boolean);
  const n = normalizar(texto);
  if (!tokens.length || n.length !== texto.length) return texto;
  const marca = new Array(texto.length).fill(false);
  for (const t of tokens) {
    for (let i = n.indexOf(t); i !== -1; i = n.indexOf(t, i + 1)) for (let k = i; k < i + t.length; k++) marca[k] = true;
  }
  const partes: ReactNode[] = [];
  let i = 0;
  while (i < texto.length) {
    let j = i;
    while (j < texto.length && marca[j] === marca[i]) j++;
    const trozo = texto.slice(i, j);
    partes.push(marca[i] ? <mark key={i} className="rounded bg-amber-100 px-0 text-inherit">{trozo}</mark> : trozo);
    i = j;
  }
  return <>{partes}</>;
}

export interface Ubicacion {
  grupo: GrupoNav;
  item: ItemNav;
  /** Pantalla secundaria dentro de la sección ("Nueva", "Editar", "Detalle"). */
  detalle?: string;
}
/** Sección del menú a la que pertenece una ruta (la coincidencia más específica gana). */
export function ubicar(pathname: string, search: string): Ubicacion | null {
  const tab = new URLSearchParams(search).get('tab');
  let mejor: { it: ItemNav; g: GrupoNav; largo: number } | null = null;
  for (const g of GRUPOS) {
    for (const it of g.items) {
      const coincide = it.ruta === '/' ? pathname === '/' : pathname === it.ruta || pathname.startsWith(`${it.ruta}/`);
      if (!coincide) continue;
      if (it.tab && it.ruta === '/configuracion' && (tab ?? 'taller') !== it.tab) continue;
      if (!mejor || it.ruta.length > mejor.largo) mejor = { it, g, largo: it.ruta.length };
    }
  }
  if (!mejor) return null;
  const resto = pathname.slice(mejor.it.ruta === '/' ? 1 : mejor.it.ruta.length).split('/').filter(Boolean);
  let detalle: string | undefined;
  if (resto.includes('editar')) detalle = 'Editar';
  else if (resto[0] === 'nueva') detalle = 'Nueva';
  else if (resto[0] === 'nuevo') detalle = 'Nuevo';
  else if (resto.length) detalle = 'Detalle';
  return { grupo: mejor.g, item: mejor.it, detalle };
}
