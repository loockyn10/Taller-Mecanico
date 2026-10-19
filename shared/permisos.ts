// Roles y permisos. La API los verifica en cada endpoint; el frontend solo los usa para ocultar opciones.

export const ROLES = ['propietario', 'administrador', 'empleado'] as const;
export type Rol = (typeof ROLES)[number];

export const PERMISOS = [
  'operacion', // clientes, vehículos, presupuestos, órdenes, turnos, check-list
  'catalogo.ver',
  'catalogo.editar', // servicios, artículos, categorías, marcas/modelos, mecánicos
  'stock.ver',
  'stock.ajustar',
  'ventas.ver',
  'ventas.emitir',
  'ventas.anular',
  'cobros.registrar',
  'cobros.anular',
  'compras.gestionar',
  'reportes.ver',
  'config.editar',
  'usuarios.gestionar',
  'licencia.ver',
  'registros.eliminar',
] as const;
export type Permiso = (typeof PERMISOS)[number];

const EMPLEADO: Permiso[] = ['operacion', 'catalogo.ver', 'stock.ver', 'ventas.ver', 'ventas.emitir', 'cobros.registrar'];

export const PERMISOS_POR_ROL: Record<Rol, readonly Permiso[]> = {
  propietario: PERMISOS,
  administrador: PERMISOS,
  empleado: EMPLEADO,
};

export function tienePermiso(rol: Rol, p: Permiso): boolean {
  return PERMISOS_POR_ROL[rol].includes(p);
}

export const ROL_LABEL: Record<Rol, string> = {
  propietario: 'Propietario',
  administrador: 'Administrador',
  empleado: 'Empleado',
};
