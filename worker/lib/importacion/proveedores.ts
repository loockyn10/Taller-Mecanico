// Importación de proveedores. Identidad: CUIT y/o código del sistema anterior. El nombre comercial NUNCA identifica a un proveedor.
import { all, lotes, uid, type Stmt } from '../db';
import { normalizarProveedor, type CambioCampo, type DatosProveedor } from '../../../shared/importacion';
import { CONDICION_IVA_LABEL } from '../../../shared/dominio';
import { agregar, buscar, cambio, decidir, idsDelTrabajo, igualesSinCaso, prepararFilas, SQL_IN, unicos, type Contexto, type FilaEntrada, type Plan } from './comun';

export const CUIT_SQL = "replace(replace(replace(cuit,'-',''),'.',''),' ','')";

export interface ProveedorExistente {
  id: string;
  nombre: string;
  cuit: string | null;
  condicion_iva: string;
  telefono: string | null;
  email: string | null;
  direccion: string | null;
  notas: string | null;
  codigo_externo: string | null;
  activo: number;
  dk: string | null;
}

const COLS = 'id, nombre, cuit, condicion_iva, telefono, email, direccion, notas, codigo_externo, activo';

export async function proveedoresPorClaves(ctx: Contexto, cuits: string[], codigos: string[]): Promise<Map<string, ProveedorExistente[]>> {
  const m = new Map<string, ProveedorExistente[]>();
  for (const l of lotes(cuits)) {
    const rows = await all<ProveedorExistente>(ctx.db, `SELECT ${COLS}, ${CUIT_SQL} AS dk FROM proveedores WHERE taller_id = ? AND ${CUIT_SQL} IN (${SQL_IN(l.length)})`, ctx.tallerId, ...l);
    for (const r of rows) agregar(m, `t:${r.dk}`, r);
  }
  for (const l of lotes(codigos)) {
    const rows = await all<ProveedorExistente>(ctx.db, `SELECT ${COLS}, NULL AS dk FROM proveedores WHERE taller_id = ? AND lower(codigo_externo) IN (${SQL_IN(l.length)})`, ctx.tallerId, ...l.map((x) => x.toLowerCase()));
    for (const r of rows) agregar(m, `c:${(r.codigo_externo ?? '').toLowerCase()}`, r);
  }
  return m;
}

function diferencias(e: ProveedorExistente, d: DatosProveedor): { cambios: CambioCampo[]; conflicto?: string } {
  const cambios: CambioCampo[] = [];
  const cuitExistente = e.cuit ? e.cuit.replace(/\D/g, '') : '';
  if (d.cuit_clave && cuitExistente && cuitExistente !== d.cuit_clave) return { cambios, conflicto: `El CUIT del archivo no coincide con el del proveedor existente "${e.nombre}": no se modifica` };
  if (d.codigo_externo && e.codigo_externo && e.codigo_externo.toLowerCase() !== d.codigo_externo.toLowerCase()) return { cambios, conflicto: `El código del archivo no coincide con el del proveedor existente "${e.nombre}": no se modifica` };
  const c = [
    cambio('nombre', e.nombre, d.nombre),
    d.cuit_clave && !cuitExistente ? { campo: 'CUIT', antes: null, despues: d.cuit ?? null } : null,
    d.codigo_externo && !e.codigo_externo ? { campo: 'código anterior', antes: null, despues: d.codigo_externo } : null,
    cambio('condición IVA', CONDICION_IVA_LABEL[e.condicion_iva as keyof typeof CONDICION_IVA_LABEL] ?? e.condicion_iva, d.condicion_iva && CONDICION_IVA_LABEL[d.condicion_iva]),
    cambio('teléfono', e.telefono, d.telefono),
    cambio('email', e.email, d.email, igualesSinCaso),
    cambio('dirección', e.direccion, d.direccion),
    cambio('notas', e.notas, d.notas),
  ];
  for (const x of c) if (x) cambios.push(x);
  return { cambios };
}

export async function planificarProveedores(ctx: Contexto, filas: FilaEntrada[]): Promise<Plan> {
  const trab = prepararFilas('proveedores', filas, normalizarProveedor);
  const validas = trab.filter((t) => t.res.accion !== 'error');
  const existentes = await proveedoresPorClaves(
    ctx,
    unicos(validas.map((t) => t.datos.cuit_clave).filter((x): x is string => !!x)),
    unicos(validas.map((t) => t.datos.codigo_externo).filter((x): x is string => !!x)),
  );
  const delTrabajo = await idsDelTrabajo(ctx, unicos([...existentes.values()].flat().map((e) => e.id)));
  const stmts: Stmt[] = [];
  const registros: Plan['registros'] = [];

  for (const t of validas) {
    const ex = buscar(t.claves, existentes);
    if (ex.some((e) => delTrabajo.has(e.id))) {
      t.res.accion = 'error';
      t.res.errores.push('Duplicado en el archivo: este proveedor ya fue cargado en un lote anterior de esta misma importación');
      continue;
    }
    const dec = decidir(ctx.modo, t.claves.length > 0, ex.length, 'proveedores');
    if (dec.tipo === 'error') (t.res.accion = 'error'), t.res.errores.push(dec.motivo);
    else if (dec.tipo === 'omitir') (t.res.accion = 'omitir'), (t.res.motivo = dec.motivo + (ex[0] && !ex[0].activo ? ' (dado de baja)' : ''));
    else if (dec.tipo === 'actualizar') {
      const e = ex[0];
      const { cambios, conflicto } = diferencias(e, t.datos);
      if (conflicto) (t.res.accion = 'error'), t.res.errores.push(conflicto);
      else if (!cambios.length) (t.res.accion = 'omitir'), (t.res.motivo = 'Sin cambios');
      else {
        t.res.accion = 'actualizar';
        t.res.cambios = cambios;
        if (!e.activo) t.res.avisos.push('El proveedor existente está dado de baja: se actualizan sus datos pero no se reactiva');
        if (ctx.aplicar) {
          const sets: string[] = [];
          const vals: unknown[] = [];
          const d = t.datos;
          const poner = (col: string, v: unknown) => (sets.push(`${col} = ?`), vals.push(v));
          if (d.nombre && d.nombre !== e.nombre) poner('nombre', d.nombre);
          if (d.cuit_clave && !e.cuit) poner('cuit', d.cuit);
          if (d.codigo_externo && !e.codigo_externo) poner('codigo_externo', d.codigo_externo);
          if (d.condicion_iva && d.condicion_iva !== e.condicion_iva) poner('condicion_iva', d.condicion_iva);
          for (const k of ['telefono', 'email', 'direccion', 'notas'] as const) if (d[k] && d[k] !== e[k]) poner(k, d[k]);
          stmts.push(ctx.db.prepare(`UPDATE proveedores SET ${sets.join(', ')} WHERE taller_id = ? AND id = ?`).bind(...vals, ctx.tallerId, e.id));
          registros.push({ id: e.id, accion: 'actualizado' });
        }
      }
    } else {
      t.res.accion = 'crear';
      if (!t.claves.length) t.res.avisos.push('Sin CUIT ni código: no se pueden detectar repetidos de este proveedor');
      if (ctx.aplicar) {
        const id = uid();
        const d = t.datos;
        stmts.push(
          ctx.db.prepare('INSERT INTO proveedores (id, taller_id, nombre, cuit, condicion_iva, telefono, email, direccion, notas, codigo_externo) VALUES (?,?,?,?,?,?,?,?,?,?)')
            .bind(id, ctx.tallerId, d.nombre, d.cuit ?? null, d.condicion_iva ?? 'responsable_inscripto', d.telefono ?? null, d.email ?? null, d.direccion ?? null, d.notas ?? null, d.codigo_externo ?? null),
        );
        registros.push({ id, accion: 'creado' });
      }
    }
  }
  return { resultados: trab.map((t) => t.res), stmts, registros };
}
