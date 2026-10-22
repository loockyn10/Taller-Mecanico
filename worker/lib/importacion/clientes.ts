// Importación de clientes. Identidad: documento (DNI/CUIT) y/o código del sistema anterior. El nombre NUNCA identifica a un cliente.
import { all, ahora, lotes, uid, type Stmt } from '../db';
import { normalizarCliente, type CambioCampo, type DatosCliente } from '../../../shared/importacion';
import { CONDICION_IVA_LABEL } from '../../../shared/dominio';
import { agregar, buscar, cambio, decidir, idsDelTrabajo, igualesSinCaso, prepararFilas, SQL_IN, unicos, type Contexto, type FilaEntrada, type Plan } from './comun';

/** Documento sin guiones, puntos ni espacios, en mayúsculas (igual que la clave de la importación). */
export const DOC_SQL = "upper(replace(replace(replace(replace(documento,'-',''),'.',''),' ',''),'/',''))";

export interface ClienteExistente {
  id: string;
  codigo: number;
  nombre: string;
  documento_tipo: string;
  documento: string | null;
  condicion_iva: string;
  telefono: string | null;
  email: string | null;
  direccion: string | null;
  localidad: string | null;
  notas: string | null;
  codigo_externo: string | null;
  activo: number;
  dk: string | null;
}

const COLS = 'id, codigo, nombre, documento_tipo, documento, condicion_iva, telefono, email, direccion, localidad, notas, codigo_externo, activo';

export async function clientesPorClaves(ctx: Contexto, docs: string[], codigos: string[]): Promise<Map<string, ClienteExistente[]>> {
  const m = new Map<string, ClienteExistente[]>();
  for (const l of lotes(docs)) {
    const rows = await all<ClienteExistente>(ctx.db, `SELECT ${COLS}, ${DOC_SQL} AS dk FROM clientes WHERE taller_id = ? AND codigo <> 0 AND ${DOC_SQL} IN (${SQL_IN(l.length)})`, ctx.tallerId, ...l);
    for (const r of rows) agregar(m, `d:${r.dk}`, r);
  }
  for (const l of lotes(codigos)) {
    const rows = await all<ClienteExistente>(ctx.db, `SELECT ${COLS}, NULL AS dk FROM clientes WHERE taller_id = ? AND codigo <> 0 AND lower(codigo_externo) IN (${SQL_IN(l.length)})`, ctx.tallerId, ...l.map((x) => x.toLowerCase()));
    for (const r of rows) agregar(m, `c:${(r.codigo_externo ?? '').toLowerCase()}`, r);
  }
  return m;
}

function diferencias(e: ClienteExistente, d: DatosCliente): { cambios: CambioCampo[]; conflicto?: string } {
  const cambios: CambioCampo[] = [];
  const dkExistente = e.documento ? e.documento.replace(/[^A-Za-z0-9]/g, '').toUpperCase() : '';
  if (d.documento_clave && dkExistente && dkExistente !== d.documento_clave) return { cambios, conflicto: `El documento del archivo no coincide con el del cliente existente (cliente N° ${e.codigo}): no se modifica` };
  if (d.codigo_externo && e.codigo_externo && e.codigo_externo.toLowerCase() !== d.codigo_externo.toLowerCase()) return { cambios, conflicto: `El código del archivo no coincide con el del cliente existente (cliente N° ${e.codigo}): no se modifica` };
  const c = [
    cambio('nombre', e.nombre, d.nombre),
    d.documento_clave && !dkExistente ? { campo: 'documento', antes: null, despues: d.documento ?? null } : null,
    d.codigo_externo && !e.codigo_externo ? { campo: 'código anterior', antes: null, despues: d.codigo_externo } : null,
    cambio('condición IVA', CONDICION_IVA_LABEL[e.condicion_iva as keyof typeof CONDICION_IVA_LABEL] ?? e.condicion_iva, d.condicion_iva && CONDICION_IVA_LABEL[d.condicion_iva]),
    cambio('teléfono', e.telefono, d.telefono),
    cambio('email', e.email, d.email, igualesSinCaso),
    cambio('dirección', e.direccion, d.direccion),
    cambio('localidad', e.localidad, d.localidad),
    cambio('notas', e.notas, d.notas),
  ];
  for (const x of c) if (x) cambios.push(x);
  return { cambios };
}

export async function planificarClientes(ctx: Contexto, filas: FilaEntrada[]): Promise<Plan> {
  const trab = prepararFilas('clientes', filas, normalizarCliente);
  const validas = trab.filter((t) => t.res.accion !== 'error');
  const existentes = await clientesPorClaves(
    ctx,
    unicos(validas.map((t) => t.datos.documento_clave).filter((x): x is string => !!x)),
    unicos(validas.map((t) => t.datos.codigo_externo).filter((x): x is string => !!x)),
  );
  const delTrabajo = await idsDelTrabajo(ctx, unicos([...existentes.values()].flat().map((e) => e.id)));
  const stmts: Stmt[] = [];
  const registros: Plan['registros'] = [];
  const nuevos: Array<{ t: (typeof trab)[number]; id: string }> = [];

  for (const t of validas) {
    const ex = buscar(t.claves, existentes);
    if (ex.some((e) => delTrabajo.has(e.id))) {
      t.res.accion = 'error';
      t.res.errores.push('Duplicado en el archivo: este cliente ya fue cargado en un lote anterior de esta misma importación');
      continue;
    }
    const dec = decidir(ctx.modo, t.claves.length > 0, ex.length, 'clientes');
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
        if (!e.activo) t.res.avisos.push('El cliente existente está dado de baja: se actualizan sus datos pero no se reactiva');
        if (ctx.aplicar) {
          const sets: string[] = [];
          const vals: unknown[] = [];
          const d = t.datos;
          const poner = (col: string, v: unknown) => (sets.push(`${col} = ?`), vals.push(v));
          if (d.nombre && d.nombre !== e.nombre) poner('nombre', d.nombre);
          if (d.documento_clave && !e.documento) (poner('documento_tipo', d.documento_tipo), poner('documento', d.documento));
          if (d.codigo_externo && !e.codigo_externo) poner('codigo_externo', d.codigo_externo);
          if (d.condicion_iva && d.condicion_iva !== e.condicion_iva) poner('condicion_iva', d.condicion_iva);
          for (const k of ['telefono', 'email', 'direccion', 'localidad', 'notas'] as const) if (d[k] && d[k] !== e[k]) poner(k, d[k]);
          stmts.push(ctx.db.prepare(`UPDATE clientes SET ${sets.join(', ')}, updated_at = ? WHERE taller_id = ? AND id = ?`).bind(...vals, ahora(), ctx.tallerId, e.id));
          registros.push({ id: e.id, accion: 'actualizado' });
        }
      }
    } else {
      t.res.accion = 'crear';
      if (!t.claves.length) t.res.avisos.push('Sin documento ni código: no se pueden detectar repetidos de este cliente');
      nuevos.push({ t, id: uid() });
    }
  }

  if (ctx.aplicar && nuevos.length) {
    const k = nuevos.length;
    // Un solo UPDATE reserva todos los códigos del lote (el batch de D1 es atómico: no se intercalan otros altas).
    stmts.unshift(
      ctx.db.prepare("INSERT INTO secuencias (taller_id, clave, valor) VALUES (?, 'cliente', 0) ON CONFLICT DO NOTHING").bind(ctx.tallerId),
      ctx.db.prepare("UPDATE secuencias SET valor = valor + ? WHERE taller_id = ? AND clave = 'cliente'").bind(k, ctx.tallerId),
    );
    nuevos.forEach(({ t, id }, i) => {
      const d = t.datos;
      stmts.push(
        ctx.db.prepare(
          `INSERT INTO clientes (id, taller_id, codigo, nombre, documento_tipo, documento, condicion_iva, telefono, email, direccion, localidad, notas, codigo_externo)
           VALUES (?, ?, (SELECT valor FROM secuencias WHERE taller_id = ? AND clave = 'cliente') - ? + ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(id, ctx.tallerId, ctx.tallerId, k, i + 1, d.nombre, d.documento_tipo ?? 'DNI', d.documento ?? null, d.condicion_iva ?? 'consumidor_final', d.telefono ?? null, d.email ?? null, d.direccion ?? null, d.localidad ?? null, d.notas ?? null, d.codigo_externo ?? null),
      );
      registros.push({ id, accion: 'creado' });
    });
  }
  return { resultados: trab.map((t) => t.res), stmts, registros };
}
