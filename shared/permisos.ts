// Roles, permisos granulares y plantillas. Un rol es una PLANTILLA de permisos; cada usuario puede además tener ajustes
// individuales (permisos otorgados y revocados respecto de su plantilla). La API los verifica en cada endpoint;
// el frontend solo los usa para ocultar opciones.

export const PERMISOS = [
  // ── Clientes y vehículos
  'clientes.ver',
  'clientes.crear',
  'clientes.editar',
  'vehiculos.ver',
  'vehiculos.crear',
  'vehiculos.editar',
  // ── Presupuestos, órdenes de trabajo y agenda
  'presupuestos.ver',
  'presupuestos.gestionar', // crear, modificar, cambiar de estado y convertir en OT
  'ordenes.ver', // todas las órdenes de trabajo
  'ordenes.asignadas', // solo las órdenes asignadas a la persona (vista simplificada para mecánicos)
  'ordenes.trabajar_asignadas', // actualizar tareas, estado y observaciones técnicas de sus órdenes asignadas
  'ordenes.crear',
  'ordenes.modificar', // editar ítems, cambiar estados y completar el check-list de cualquier orden
  'ordenes.asignar', // asignar el mecánico responsable, los participantes y las tareas de las órdenes (sin tocar importes)
  'ordenes.imprimir', // imprimir la hoja de la orden para el mecánico (PDF A4 sin precios), sólo de las órdenes a las que tiene acceso
  'ordenes.imprimir_administracion', // imprimir además la copia de administración
  'turnos.ver',
  'turnos.gestionar',
  // ── Fotografías de vehículos y órdenes de trabajo
  'fotos.ver',
  'fotos.subir',
  'fotos.eliminar',
  // ── Recepción y entrega de vehículos (checklist con daños y firma)
  'checklists.ver', // consultar las recepciones y entregas de las órdenes a las que tiene acceso
  'checklists.recepcion', // crear la recepción, registrar daños y obtener la conformidad del cliente
  'checklists.entrega', // registrar la entrega del vehículo
  'checklists.corregir', // corregir un registro ya confirmado (queda una revisión; el original se conserva)
  'checklists.firmas', // ver las firmas capturadas y los datos de quien firmó
  // ── Seguimiento público de órdenes (enlace para el cliente)
  'seguimiento.ver', // consultar la configuración del seguimiento de una orden (si está activo, mensajes publicados, transiciones visibles). No incluye el enlace
  'seguimiento.gestionar', // activar, desactivar y regenerar el enlace; ocultar la fecha estimada y las transiciones internas
  'seguimiento.compartir', // ver y copiar el enlace, mostrar el QR, compartirlo por WhatsApp o imprimirlo
  'seguimiento.mensajes', // publicar y retirar observaciones visibles para el cliente
  // ── Mantenimientos programados
  'mantenimientos.ver',
  'mantenimientos.gestionar', // planes por vehículo, intervalos y mantenimientos realizados antes de usar ORVELAN
  // ── Precios (visibilidad)
  'precios.venta.ver', // precios de venta de servicios y artículos
  'precios.costo.ver', // costos de artículos
  'margenes.ver', // márgenes de ganancia y rentabilidad
  'presupuestos.valorizados.ver', // importes de presupuestos, órdenes y documentos valorizados
  'precios.gestionar', // listas de precios y ajustes masivos
  // ── Catálogo e inventario
  'catalogo.ver',
  'catalogo.editar', // servicios, artículos, categorías, marcas y modelos
  'stock.ver',
  'stock.ajustar',
  'stock.valorizar', // inventario valorizado e historial de costos
  // ── Ventas y cobranzas
  'ventas.ver',
  'ventas.emitir',
  'ventas.anular',
  'cobros.registrar',
  'cobros.anular',
  // ── Compras
  'compras.ver',
  'compras.gestionar',
  // ── Dinero
  'caja.operar', // abrir/cerrar caja, arqueo, ingresos y egresos manuales
  'finanzas.ver', // historial de cajas, resúmenes y reportes financieros, listado de gastos
  'gastos.gestionar', // categorías, gastos recurrentes, anulación de gastos y movimientos manuales
  'bancos.ver', // consultar cuentas y movimientos bancarios
  'bancos.gestionar', // cuentas bancarias, movimientos, transferencias y conciliación
  'bancos.ajustar', // ajustes manuales de saldo bancario
  'cheques.gestionar', // cartera de cheques y eCheq
  'tesoreria.ver', // tablero de tesorería
  'contabilidad.ver', // contabilidad de gestión: plan de cuentas, asientos, libros, balance, resultados y controles
  'contabilidad.gestionar', // administrar el plan de cuentas y registrar, revertir y corregir asientos manuales
  // ── Movimientos financieros con personas (aportes, préstamos, adelantos): información sensible, nunca se otorga por defecto a personal operativo
  'movpersonas.ver', // consultar movimientos, saldos pendientes y personas
  'movpersonas.registrar', // registrar aportes, retiros, préstamos y devoluciones, y dar de alta personas
  'movpersonas.regularizar', // aplicar un adelanto de sueldo contra una liquidación (requiere autorización y deja constancia)
  'movpersonas.anular', // anular un movimiento (contra-asiento en caja, bancos y contabilidad)
  'movpersonas.administrar', // categorías propias y datos de las personas
  'movpersonas.reportes', // totales y resúmenes por persona, categoría y período
  // ── Informes
  'reportes.ver', // estadísticas e informes
  'productividad.ver', // indicadores operativos de mecánicos y taller (horas, tareas, carga de trabajo)
  'informes.exportar', // exportar informes y listados
  // ── Personal y asistencia
  'usuarios.gestionar', // administrar empleados
  'permisos.gestionar', // asignar roles y personalizar permisos
  'asistencia.fichar', // registrar la propia entrada y salida
  'asistencia.ver', // panel de asistencia de todo el personal
  'asistencia.corregir', // correcciones manuales de fichajes
  'reloj.administrar', // dispositivos de reloj compartido y PIN del personal
  // ── Administración del taller
  'config.editar',
  'datos.importar', // importar clientes, vehículos, artículos y proveedores desde Excel o CSV (además del permiso de crear/editar de cada tipo)
  'aperturas.gestionar', // cargar y anular los saldos de apertura (deudas con proveedores) de un taller que migra de otro sistema
  'licencia.ver',
  'registros.eliminar',
  'fechas.retroactivas', // cargar comprobantes con fecha pasada
] as const;
export type Permiso = (typeof PERMISOS)[number];

export const PERMISOS_VALIDOS: ReadonlySet<string> = new Set(PERMISOS);
export const esPermiso = (x: unknown): x is Permiso => typeof x === 'string' && PERMISOS_VALIDOS.has(x);

/** Dependencias: tener el permiso de la izquierda exige tener los de la derecha (escribir implica poder leer). */
export const REQUIERE: Partial<Record<Permiso, readonly Permiso[]>> = {
  'clientes.crear': ['clientes.ver'],
  'clientes.editar': ['clientes.ver'],
  'vehiculos.crear': ['vehiculos.ver'],
  'vehiculos.editar': ['vehiculos.ver'],
  'presupuestos.gestionar': ['presupuestos.ver'],
  'fotos.subir': ['fotos.ver'],
  'fotos.eliminar': ['fotos.ver'],
  'checklists.recepcion': ['checklists.ver'],
  'checklists.entrega': ['checklists.ver'],
  'checklists.corregir': ['checklists.ver'],
  'checklists.firmas': ['checklists.ver'],
  'seguimiento.gestionar': ['seguimiento.ver'],
  'seguimiento.compartir': ['seguimiento.ver'],
  'seguimiento.mensajes': ['seguimiento.ver'],
  'ordenes.crear': ['ordenes.ver'],
  'ordenes.modificar': ['ordenes.ver'],
  'ordenes.asignar': ['ordenes.ver'],
  'ordenes.imprimir': ['ordenes.asignadas'],
  'ordenes.imprimir_administracion': ['ordenes.ver', 'ordenes.imprimir'],
  'mantenimientos.ver': ['vehiculos.ver'],
  'mantenimientos.gestionar': ['mantenimientos.ver'],
  'ordenes.ver': ['ordenes.asignadas'],
  'ordenes.trabajar_asignadas': ['ordenes.asignadas'],
  'turnos.gestionar': ['turnos.ver'],
  'margenes.ver': ['precios.venta.ver', 'precios.costo.ver'],
  'stock.valorizar': ['precios.costo.ver'],
  'catalogo.editar': ['catalogo.ver'],
  'stock.ajustar': ['stock.ver'],
  'ventas.emitir': ['ventas.ver'],
  'ventas.anular': ['ventas.ver'],
  'cobros.registrar': ['ventas.ver'],
  'cobros.anular': ['ventas.ver'],
  'compras.gestionar': ['compras.ver'],
  'bancos.gestionar': ['bancos.ver'],
  'bancos.ajustar': ['bancos.gestionar'],
  'contabilidad.gestionar': ['contabilidad.ver'],
  'movpersonas.registrar': ['movpersonas.ver'],
  'movpersonas.regularizar': ['movpersonas.registrar'],
  'movpersonas.anular': ['movpersonas.ver'],
  'movpersonas.administrar': ['movpersonas.ver'],
  'movpersonas.reportes': ['movpersonas.ver'],
  'aperturas.gestionar': ['compras.ver'],
  'permisos.gestionar': ['usuarios.gestionar'],
  'asistencia.corregir': ['asistencia.ver'],
  'reloj.administrar': ['asistencia.ver'],
};

// ───────────────────────── Roles (plantillas) ─────────────────────────

export const ROLES = ['propietario', 'administrador', 'recepcion', 'mecanico', 'deposito', 'caja', 'empleado'] as const;
export type Rol = (typeof ROLES)[number];

/** Nivel de privilegio guardado en usuarios.rol (la base lo restringe a estos tres valores). */
export type Nivel = 'propietario' | 'administrador' | 'empleado';
export const nivelDeRol = (r: Rol): Nivel => (r === 'propietario' ? 'propietario' : r === 'administrador' ? 'administrador' : 'empleado');

const SIN_BANCOS_AJUSTE = (p: Permiso) => p !== 'bancos.ajustar' && p !== 'permisos.gestionar';

const RECEPCION: Permiso[] = [
  'clientes.ver', 'clientes.crear', 'clientes.editar', 'vehiculos.ver', 'vehiculos.crear', 'vehiculos.editar',
  'presupuestos.ver', 'presupuestos.gestionar', 'ordenes.ver', 'ordenes.crear', 'ordenes.modificar', 'ordenes.asignar', 'ordenes.imprimir', 'ordenes.imprimir_administracion', 'turnos.ver', 'turnos.gestionar',
  'precios.venta.ver', 'presupuestos.valorizados.ver', 'catalogo.ver', 'stock.ver', 'ventas.ver', 'mantenimientos.ver', 'mantenimientos.gestionar', 'asistencia.fichar',
  'fotos.ver', 'fotos.subir', 'checklists.ver', 'checklists.recepcion', 'checklists.entrega', 'checklists.firmas',
  'seguimiento.ver', 'seguimiento.gestionar', 'seguimiento.compartir', 'seguimiento.mensajes',
];
const MECANICO: Permiso[] = ['vehiculos.ver', 'ordenes.asignadas', 'ordenes.trabajar_asignadas', 'ordenes.imprimir', 'mantenimientos.ver', 'asistencia.fichar', 'fotos.ver', 'fotos.subir', 'checklists.ver'];
const DEPOSITO: Permiso[] = [
  'catalogo.ver', 'catalogo.editar', 'stock.ver', 'stock.ajustar', 'compras.ver', 'compras.gestionar', 'precios.venta.ver', 'precios.costo.ver',
  'ordenes.ver', 'vehiculos.ver', 'asistencia.fichar',
];
const CAJA: Permiso[] = [
  'clientes.ver', 'clientes.crear', 'vehiculos.ver', 'ordenes.ver', 'precios.venta.ver', 'presupuestos.valorizados.ver', 'catalogo.ver',
  'ventas.ver', 'ventas.emitir', 'cobros.registrar', 'caja.operar', 'asistencia.fichar',
];
/** Plantilla anterior a este sprint: se conserva para los usuarios ya creados (mismos accesos que tenían). */
const EMPLEADO: Permiso[] = [
  'clientes.ver', 'clientes.crear', 'clientes.editar', 'vehiculos.ver', 'vehiculos.crear', 'vehiculos.editar',
  'presupuestos.ver', 'presupuestos.gestionar', 'ordenes.ver', 'ordenes.crear', 'ordenes.modificar', 'ordenes.asignar', 'ordenes.imprimir', 'ordenes.imprimir_administracion', 'turnos.ver', 'turnos.gestionar',
  'precios.venta.ver', 'presupuestos.valorizados.ver', 'catalogo.ver', 'stock.ver', 'ventas.ver', 'ventas.emitir', 'cobros.registrar', 'caja.operar',
  'mantenimientos.ver', 'mantenimientos.gestionar', 'asistencia.fichar', 'fotos.ver', 'fotos.subir', 'checklists.ver', 'checklists.recepcion', 'checklists.entrega', 'checklists.firmas',
  'seguimiento.ver', 'seguimiento.gestionar', 'seguimiento.compartir', 'seguimiento.mensajes',
];

export interface Plantilla {
  etiqueta: string;
  descripcion: string;
  permisos: readonly Permiso[];
  /** No se ofrece al crear usuarios nuevos (existe solo para los usuarios anteriores al sprint). */
  heredada?: boolean;
}

export const PLANTILLAS: Record<Rol, Plantilla> = {
  propietario: { etiqueta: 'Propietario', descripcion: 'Acceso total, incluidos la licencia, los usuarios y los permisos.', permisos: PERMISOS },
  administrador: {
    etiqueta: 'Administrador',
    descripcion: 'Acceso a toda la operación, finanzas, compras, informes y administración de empleados. No gestiona permisos ni ajusta saldos bancarios.',
    permisos: PERMISOS.filter(SIN_BANCOS_AJUSTE),
  },
  recepcion: { etiqueta: 'Recepción', descripcion: 'Recibe clientes y vehículos, arma presupuestos y órdenes y gestiona la agenda. Ve precios de venta; no ve costos ni márgenes.', permisos: RECEPCION },
  mecanico: { etiqueta: 'Mecánico', descripcion: 'Ve y trabaja sus órdenes asignadas. No ve precios, costos, facturación, caja ni estadísticas.', permisos: MECANICO },
  deposito: { etiqueta: 'Depósito / Repuestos', descripcion: 'Administra artículos, inventario y compras. Ve precios de venta y costos de los repuestos.', permisos: DEPOSITO },
  caja: { etiqueta: 'Caja / Ventas', descripcion: 'Vende en mostrador, emite comprobantes, cobra y opera la caja diaria.', permisos: CAJA },
  empleado: { etiqueta: 'Empleado (general)', descripcion: 'Rol anterior: operación completa de recepción más ventas, cobros y caja.', permisos: EMPLEADO, heredada: true },
};

export const ROL_LABEL: Record<Rol, string> = Object.fromEntries(ROLES.map((r) => [r, PLANTILLAS[r].etiqueta])) as Record<Rol, string>;
export const esRol = (x: unknown): x is Rol => typeof x === 'string' && (ROLES as readonly string[]).includes(x);

// ───────────────────────── Permisos efectivos ─────────────────────────

/** Ajustes individuales respecto de la plantilla: g = permisos otorgados de más, r = permisos retirados. */
export interface AjustesPermisos {
  g: Permiso[];
  r: Permiso[];
}
export const SIN_AJUSTES: AjustesPermisos = { g: [], r: [] };

/** Lee el JSON guardado en la base; ignora permisos desconocidos (por ejemplo de versiones futuras). */
export function leerAjustes(json: string | null | undefined): AjustesPermisos {
  if (!json) return { g: [], r: [] };
  try {
    const o = JSON.parse(json);
    return { g: (Array.isArray(o?.g) ? o.g : []).filter(esPermiso), r: (Array.isArray(o?.r) ? o.r : []).filter(esPermiso) };
  } catch {
    return { g: [], r: [] };
  }
}

/** Agrega las dependencias faltantes de cada permiso presente. */
function conDependencias(base: Set<Permiso>): Set<Permiso> {
  let cambio = true;
  while (cambio) {
    cambio = false;
    for (const p of [...base]) for (const q of REQUIERE[p] ?? []) if (!base.has(q)) (base.add(q), (cambio = true));
  }
  return base;
}

/** Quita los permisos cuyas dependencias ya no están. */
function sinHuerfanos(s: Set<Permiso>): Set<Permiso> {
  let cambio = true;
  while (cambio) {
    cambio = false;
    for (const p of [...s]) if ((REQUIERE[p] ?? []).some((q) => !s.has(q))) (s.delete(p), (cambio = true));
  }
  return s;
}

/**
 * Permisos de un usuario = plantilla + otorgados − retirados, respetando las dependencias.
 * El propietario siempre conserva todos (no se le pueden retirar permisos).
 */
export function permisosEfectivos(rol: Rol, ajustes: AjustesPermisos = SIN_AJUSTES): Permiso[] {
  if (rol === 'propietario') return [...PERMISOS];
  const s = conDependencias(new Set<Permiso>([...(PLANTILLAS[rol]?.permisos ?? []), ...ajustes.g]));
  for (const p of ajustes.r) s.delete(p);
  sinHuerfanos(s);
  return PERMISOS.filter((p) => s.has(p));
}

/**
 * Convierte una lista deseada de permisos en ajustes respecto de la plantilla del rol (lo mínimo que se debe guardar).
 * La lista se toma literal: si falta un permiso del que otros dependen (por ejemplo "ver clientes"), esos otros se descartan.
 */
export function ajustesDesde(rol: Rol, deseados: readonly Permiso[]): AjustesPermisos {
  const base = new Set(permisosEfectivos(rol, SIN_AJUSTES));
  const quiero = sinHuerfanos(new Set(deseados));
  return { g: PERMISOS.filter((p) => quiero.has(p) && !base.has(p)), r: PERMISOS.filter((p) => base.has(p) && !quiero.has(p)) };
}

export const tienePermiso = (permisos: readonly Permiso[] | ReadonlySet<Permiso>, p: Permiso): boolean =>
  Array.isArray(permisos) ? (permisos as readonly Permiso[]).includes(p) : (permisos as ReadonlySet<Permiso>).has(p);

// ───────────────────────── Catálogo para la pantalla de permisos ─────────────────────────

export interface InfoPermiso {
  etiqueta: string;
  /** Aclaración corta para quien configura permisos. */
  ayuda?: string;
}
export const INFO_PERMISOS: Record<Permiso, InfoPermiso> = {
  'clientes.ver': { etiqueta: 'Ver clientes' },
  'clientes.crear': { etiqueta: 'Crear clientes' },
  'clientes.editar': { etiqueta: 'Editar clientes' },
  'vehiculos.ver': { etiqueta: 'Ver vehículos', ayuda: 'Incluye el historial de reparaciones del vehículo' },
  'vehiculos.crear': { etiqueta: 'Crear vehículos' },
  'vehiculos.editar': { etiqueta: 'Editar vehículos' },
  'presupuestos.ver': { etiqueta: 'Ver presupuestos' },
  'presupuestos.gestionar': { etiqueta: 'Crear y modificar presupuestos', ayuda: 'Requiere ver presupuestos valorizados y precios de venta' },
  'ordenes.ver': { etiqueta: 'Ver todas las órdenes de trabajo' },
  'ordenes.asignadas': { etiqueta: 'Ver órdenes asignadas', ayuda: 'Solo las órdenes donde la persona figura como mecánico' },
  'ordenes.trabajar_asignadas': { etiqueta: 'Actualizar órdenes asignadas', ayuda: 'Tareas, estado y observaciones técnicas de sus órdenes' },
  'ordenes.crear': { etiqueta: 'Crear órdenes de trabajo' },
  'ordenes.asignar': { etiqueta: 'Asignar mecánicos y tareas', ayuda: 'Responsable, participantes y reparto de tareas de cada orden. No permite modificar importes' },
  'ordenes.imprimir': { etiqueta: 'Imprimir la orden para el mecánico', ayuda: 'PDF A4 con los datos para trabajar y renglones para anotar. Sin precios ni costos. Sólo de las órdenes a las que tiene acceso' },
  'ordenes.imprimir_administracion': { etiqueta: 'Imprimir la copia de administración', ayuda: 'Segunda copia de la orden, identificada para administración' },
  'ordenes.modificar': { etiqueta: 'Modificar órdenes de trabajo', ayuda: 'Editar ítems, estados y check-list. La edición de ítems requiere ver precios y presupuestos valorizados' },
  'turnos.ver': { etiqueta: 'Ver agenda de turnos' },
  'turnos.gestionar': { etiqueta: 'Gestionar turnos' },
  'fotos.ver': { etiqueta: 'Ver fotografías', ayuda: 'De los vehículos y de las órdenes a las que tiene acceso' },
  'fotos.subir': { etiqueta: 'Subir fotografías', ayuda: 'Sacar o elegir fotos para un vehículo o una orden a la que tiene acceso' },
  'fotos.eliminar': { etiqueta: 'Eliminar fotografías', ayuda: 'Queda registrado quién y cuándo. Las fotos incluidas en una recepción o entrega confirmada no se pueden eliminar' },
  'checklists.ver': { etiqueta: 'Consultar recepciones y entregas', ayuda: 'Checklist de ingreso y de salida de las órdenes a las que tiene acceso. No incluye precios' },
  'checklists.recepcion': { etiqueta: 'Registrar recepciones', ayuda: 'Estado de ingreso, daños y conformidad del cliente' },
  'checklists.entrega': { etiqueta: 'Registrar entregas', ayuda: 'Estado de salida, trabajos realizados y conformidad del cliente' },
  'checklists.corregir': { etiqueta: 'Corregir recepciones y entregas confirmadas', ayuda: 'No se pisa el original: se crea una revisión con el motivo y queda todo el historial' },
  'checklists.firmas': { etiqueta: 'Consultar firmas', ayuda: 'Ver la firma capturada y el nombre de quien firmó' },
  'seguimiento.ver': { etiqueta: 'Consultar el seguimiento del cliente', ayuda: 'Si el enlace de seguimiento está activo y qué se publicó. No incluye el enlace: para verlo hace falta «Compartir el enlace de seguimiento»' },
  'seguimiento.gestionar': { etiqueta: 'Activar y desactivar el seguimiento', ayuda: 'Activar, desactivar o regenerar el enlace (el anterior deja de funcionar) y elegir qué se muestra: fecha estimada y transiciones' },
  'seguimiento.compartir': { etiqueta: 'Compartir el enlace de seguimiento', ayuda: 'Ver y copiar el enlace, mostrar el QR y enviarlo por WhatsApp. Quien tiene el enlace ve el estado de la reparación sin iniciar sesión' },
  'seguimiento.mensajes': { etiqueta: 'Publicar mensajes para el cliente', ayuda: 'Observaciones que ve el cliente en la página de seguimiento. Son independientes de las notas internas' },
  'mantenimientos.ver': { etiqueta: 'Ver mantenimientos programados', ayuda: 'Vencimientos por kilometraje y tiempo de cada vehículo' },
  'mantenimientos.gestionar': { etiqueta: 'Gestionar mantenimientos', ayuda: 'Planes por vehículo, intervalos y mantenimientos realizados antes de usar ORVELAN' },
  'precios.venta.ver': { etiqueta: 'Ver precios de venta' },
  'precios.costo.ver': { etiqueta: 'Ver precios de costo' },
  'margenes.ver': { etiqueta: 'Ver márgenes de ganancia', ayuda: 'Implica ver precios de venta y de costo' },
  'presupuestos.valorizados.ver': { etiqueta: 'Ver presupuestos y órdenes valorizados', ayuda: 'Importes y totales de presupuestos, órdenes y listados' },
  'precios.gestionar': { etiqueta: 'Gestionar listas de precios y ajustes masivos' },
  'catalogo.ver': { etiqueta: 'Consultar catálogo (servicios y artículos)' },
  'catalogo.editar': { etiqueta: 'Modificar catálogo', ayuda: 'Servicios, artículos, categorías, marcas y modelos' },
  'stock.ver': { etiqueta: 'Consultar inventario' },
  'stock.ajustar': { etiqueta: 'Modificar inventario', ayuda: 'Movimientos, ajustes y conteos' },
  'stock.valorizar': { etiqueta: 'Inventario valorizado e historial de costos' },
  'ventas.ver': { etiqueta: 'Ver ventas, cobranzas y cuentas corrientes' },
  'ventas.emitir': { etiqueta: 'Emitir ventas y comprobantes' },
  'ventas.anular': { etiqueta: 'Anular ventas' },
  'cobros.registrar': { etiqueta: 'Registrar cobros' },
  'cobros.anular': { etiqueta: 'Anular cobros' },
  'compras.ver': { etiqueta: 'Consultar compras y proveedores' },
  'compras.gestionar': { etiqueta: 'Gestionar compras', ayuda: 'Órdenes de compra, recepciones, facturas y pagos a proveedores' },
  'caja.operar': { etiqueta: 'Gestionar caja', ayuda: 'Abrir, cerrar, arquear y registrar ingresos y egresos' },
  'finanzas.ver': { etiqueta: 'Ver finanzas y gastos' },
  'gastos.gestionar': { etiqueta: 'Gestionar gastos', ayuda: 'Categorías, gastos recurrentes y anulaciones' },
  'bancos.ver': { etiqueta: 'Consultar bancos' },
  'bancos.gestionar': { etiqueta: 'Gestionar bancos', ayuda: 'Movimientos, transferencias y conciliación' },
  'bancos.ajustar': { etiqueta: 'Ajustar saldos bancarios' },
  'cheques.gestionar': { etiqueta: 'Gestionar cheques y eCheq' },
  'tesoreria.ver': { etiqueta: 'Ver tesorería' },
  'contabilidad.ver': { etiqueta: 'Ver la contabilidad', ayuda: 'Plan de cuentas, libro diario y mayor, balance, estado de resultados, controles y registros internos. Información de gestión: no son libros fiscales' },
  'contabilidad.gestionar': { etiqueta: 'Gestionar la contabilidad', ayuda: 'Modificar el plan de cuentas y registrar, revertir y corregir asientos manuales' },
  'movpersonas.ver': { etiqueta: 'Ver movimientos con personas', ayuda: 'Aportes de capital, préstamos de socios, préstamos y adelantos al personal, y lo que cada persona debe. Información sensible' },
  'movpersonas.registrar': { etiqueta: 'Registrar movimientos con personas', ayuda: 'Aportes, retiros, préstamos, devoluciones y adelantos de sueldo; también dar de alta socios y otras personas' },
  'movpersonas.regularizar': { etiqueta: 'Aplicar adelantos de sueldo', ayuda: 'Regularizar un adelanto contra una liquidación. Exige indicar quién autorizó el descuento; no es una autorización legal por sí sola' },
  'movpersonas.anular': { etiqueta: 'Anular movimientos con personas', ayuda: 'Genera el contra-asiento en caja, bancos y contabilidad; queda quién, cuándo y por qué' },
  'movpersonas.administrar': { etiqueta: 'Administrar categorías y personas', ayuda: 'Categorías propias (sobre los tipos financieros admitidos) y datos de las personas' },
  'movpersonas.reportes': { etiqueta: 'Ver totales y resúmenes de personas', ayuda: 'Cuánto aportó, retiró, debe o recibió cada persona y total por categoría y período' },
  'reportes.ver': { etiqueta: 'Ver estadísticas e informes' },
  'informes.exportar': { etiqueta: 'Exportar informes' },
  'productividad.ver': { etiqueta: 'Ver productividad', ayuda: 'Horas, tareas y carga de trabajo del taller y de cada mecánico. Los importes requieren además ver presupuestos valorizados' },
  'usuarios.gestionar': { etiqueta: 'Administrar empleados', ayuda: 'Crear, editar y desactivar usuarios (no cambia permisos)' },
  'permisos.gestionar': { etiqueta: 'Gestionar permisos', ayuda: 'Asignar roles y personalizar permisos. Solo puede otorgar los permisos que ya tiene' },
  'asistencia.fichar': { etiqueta: 'Registrar su propia asistencia' },
  'asistencia.ver': { etiqueta: 'Ver asistencia del personal' },
  'asistencia.corregir': { etiqueta: 'Corregir fichajes' },
  'reloj.administrar': { etiqueta: 'Administrar reloj compartido y PIN' },
  'config.editar': { etiqueta: 'Configurar el taller', ayuda: 'Datos del negocio, preferencias y asistente de puesta en marcha' },
  'datos.importar': { etiqueta: 'Importar datos desde Excel o CSV', ayuda: 'Además hacen falta los permisos de crear (y de editar, para actualizar) de lo que se importa: clientes, vehículos, artículos o proveedores' },
  'aperturas.gestionar': { etiqueta: 'Cargar saldos de apertura', ayuda: 'Registrar y anular los saldos con que el taller empieza a operar (hoy, deudas con proveedores). No son compras ni ventas y no afectan los resultados' },
  'licencia.ver': { etiqueta: 'Ver la licencia' },
  'registros.eliminar': { etiqueta: 'Eliminar clientes y vehículos' },
  'fechas.retroactivas': { etiqueta: 'Cargar operaciones con fecha anterior' },
};

export const GRUPOS_PERMISOS: Array<{ titulo: string; permisos: Permiso[] }> = [
  { titulo: 'Clientes y vehículos', permisos: ['clientes.ver', 'clientes.crear', 'clientes.editar', 'vehiculos.ver', 'vehiculos.crear', 'vehiculos.editar'] },
  { titulo: 'Presupuestos, órdenes, agenda y mantenimientos', permisos: ['presupuestos.ver', 'presupuestos.gestionar', 'ordenes.ver', 'ordenes.asignadas', 'ordenes.trabajar_asignadas', 'ordenes.crear', 'ordenes.modificar', 'ordenes.asignar', 'ordenes.imprimir', 'ordenes.imprimir_administracion', 'turnos.ver', 'turnos.gestionar', 'mantenimientos.ver', 'mantenimientos.gestionar'] },
  { titulo: 'Fotografías', permisos: ['fotos.ver', 'fotos.subir', 'fotos.eliminar'] },
  { titulo: 'Recepción y entrega de vehículos', permisos: ['checklists.ver', 'checklists.recepcion', 'checklists.entrega', 'checklists.corregir', 'checklists.firmas'] },
  { titulo: 'Seguimiento del cliente', permisos: ['seguimiento.ver', 'seguimiento.gestionar', 'seguimiento.compartir', 'seguimiento.mensajes'] },
  { titulo: 'Precios y márgenes', permisos: ['precios.venta.ver', 'precios.costo.ver', 'margenes.ver', 'presupuestos.valorizados.ver', 'precios.gestionar'] },
  { titulo: 'Catálogo e inventario', permisos: ['catalogo.ver', 'catalogo.editar', 'stock.ver', 'stock.ajustar', 'stock.valorizar'] },
  { titulo: 'Ventas y cobranzas', permisos: ['ventas.ver', 'ventas.emitir', 'ventas.anular', 'cobros.registrar', 'cobros.anular'] },
  { titulo: 'Compras', permisos: ['compras.ver', 'compras.gestionar'] },
  { titulo: 'Caja, bancos y finanzas', permisos: ['caja.operar', 'finanzas.ver', 'gastos.gestionar', 'bancos.ver', 'bancos.gestionar', 'bancos.ajustar', 'cheques.gestionar', 'tesoreria.ver', 'contabilidad.ver', 'contabilidad.gestionar'] },
  { titulo: 'Movimientos con personas (socios y personal)', permisos: ['movpersonas.ver', 'movpersonas.registrar', 'movpersonas.regularizar', 'movpersonas.anular', 'movpersonas.administrar', 'movpersonas.reportes'] },
  { titulo: 'Informes', permisos: ['reportes.ver', 'informes.exportar', 'productividad.ver'] },
  { titulo: 'Personal y asistencia', permisos: ['usuarios.gestionar', 'permisos.gestionar', 'asistencia.fichar', 'asistencia.ver', 'asistencia.corregir', 'reloj.administrar'] },
  { titulo: 'Administración', permisos: ['config.editar', 'datos.importar', 'aperturas.gestionar', 'licencia.ver', 'registros.eliminar', 'fechas.retroactivas'] },
];

/** Zonas horarias ofrecidas para el taller (la hora siempre se registra en el servidor, en UTC). */
export const ZONAS_HORARIAS: ReadonlyArray<readonly [string, string]> = [
  ['America/Argentina/Buenos_Aires', 'Argentina (Buenos Aires)'],
  ['America/Montevideo', 'Uruguay (Montevideo)'],
  ['America/Santiago', 'Chile (Santiago)'],
  ['America/Asuncion', 'Paraguay (Asunción)'],
  ['America/La_Paz', 'Bolivia (La Paz)'],
  ['America/Sao_Paulo', 'Brasil (São Paulo)'],
  ['America/Lima', 'Perú (Lima)'],
  ['America/Bogota', 'Colombia (Bogotá)'],
  ['America/Mexico_City', 'México (Ciudad de México)'],
  ['Europe/Madrid', 'España (Madrid)'],
];
export const ZONA_HORARIA_DEFECTO = 'America/Argentina/Buenos_Aires';

/** Marca o desmarca un permiso en una selección, arrastrando sus dependencias (marcar "editar" marca "ver"; desmarcar "ver" desmarca lo que depende). */
export function alternarPermiso(seleccion: ReadonlySet<Permiso>, p: Permiso, activar: boolean): Set<Permiso> {
  const s = new Set(seleccion);
  if (activar) {
    s.add(p);
    return conDependencias(s);
  }
  s.delete(p);
  return sinHuerfanos(s);
}
