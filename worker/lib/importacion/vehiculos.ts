// Importación de vehículos. Identidad: patente. El cliente es opcional: si el archivo lo trae, se vincula al vehículo nuevo (como titular) por documento,
// por código del sistema anterior o, solo si no hay ninguno de los dos, por nombre exacto único. Nunca se adivina: ante la duda la fila queda pendiente de
// resolver. Sin referencia a un cliente el vehículo se crea sin clientes vinculados. Un vehículo que ya existe no cambia sus vínculos al importar.
import { all, ahora, lotes, uid, type Stmt } from '../db';
import {
  claveReferenciaCliente, normalizarTextoImport, normalizarVehiculo, type CambioCampo, type ReferenciaCliente, type ResultadoFila,
} from '../../../shared/importacion';
import { agregar, buscar, cambio, decidir, idsDelTrabajo, igualesSinCaso, prepararFilas, SQL_IN, unicos, type Contexto, type FilaEntrada, type Plan } from './comun';
import { DOC_SQL } from './clientes';

interface ClienteMin { id: string; nombre: string; activo: number; codigo_externo: string | null }
export type ResolucionCliente = { ok: true; id: string; nombre: string; aviso?: string } | { ok: false; motivo: 'inexistente' | 'ambiguo' | 'baja'; texto: string };

const etiquetaRef = (r: ReferenciaCliente) => (r.documento ? `documento ${r.documento}` : r.codigo ? `código ${r.codigo}` : `nombre "${r.nombre}"`);

/** Resuelve las referencias a clientes del lote. Devuelve el resultado por clave de referencia. */
export async function resolverClientes(ctx: Contexto, refs: ReferenciaCliente[]): Promise<Map<string, ResolucionCliente>> {
  const claves = new Map<string, ReferenciaCliente>();
  for (const r of refs) claves.set(claveReferenciaCliente(r), r);
  const out = new Map<string, ResolucionCliente>();

  // Resoluciones elegidas por la persona: el cliente debe existir, estar activo y ser de este taller.
  const elegidas = new Map<string, string>();
  for (const [k] of claves) {
    const id = ctx.resoluciones[`cliente:${k}`];
    if (id) elegidas.set(k, id);
  }
  const validasElegidas = new Map<string, ClienteMin>();
  for (const l of lotes(unicos([...elegidas.values()]))) {
    for (const c of await all<ClienteMin>(ctx.db, `SELECT id, nombre, activo, codigo_externo FROM clientes WHERE taller_id = ? AND codigo <> 0 AND id IN (${SQL_IN(l.length)})`, ctx.tallerId, ...l)) validasElegidas.set(c.id, c);
  }

  const docs = unicos([...claves.values()].map((r) => r.documento).filter((x): x is string => !!x));
  const cods = unicos([...claves.values()].map((r) => r.codigo).filter((x): x is string => !!x));
  const noms = unicos([...claves.values()].filter((r) => !r.documento && !r.codigo && r.nombre).map((r) => r.nombre!));
  const porDoc = new Map<string, ClienteMin[]>();
  const porCod = new Map<string, ClienteMin[]>();
  const porNom = new Map<string, ClienteMin[]>();
  for (const l of lotes(docs)) for (const c of await all<ClienteMin & { dk: string }>(ctx.db, `SELECT id, nombre, activo, codigo_externo, ${DOC_SQL} AS dk FROM clientes WHERE taller_id = ? AND codigo <> 0 AND ${DOC_SQL} IN (${SQL_IN(l.length)})`, ctx.tallerId, ...l)) agregar(porDoc, c.dk, c);
  for (const l of lotes(cods)) for (const c of await all<ClienteMin>(ctx.db, `SELECT id, nombre, activo, codigo_externo FROM clientes WHERE taller_id = ? AND codigo <> 0 AND lower(codigo_externo) IN (${SQL_IN(l.length)})`, ctx.tallerId, ...l.map((x) => x.toLowerCase()))) agregar(porCod, (c.codigo_externo ?? '').toLowerCase(), c);
  for (const l of lotes(noms)) for (const c of await all<ClienteMin>(ctx.db, `SELECT id, nombre, activo, codigo_externo FROM clientes WHERE taller_id = ? AND codigo <> 0 AND nombre COLLATE NOCASE IN (${SQL_IN(l.length)})`, ctx.tallerId, ...l)) agregar(porNom, normalizarTextoImport(c.nombre), c);

  for (const [k, r] of claves) {
    const elegido = elegidas.get(k);
    if (elegido) {
      const c = validasElegidas.get(elegido);
      out.set(k, c && c.activo ? { ok: true, id: c.id, nombre: c.nombre } : { ok: false, motivo: 'inexistente', texto: 'El cliente elegido ya no existe o está dado de baja' });
      continue;
    }
    const activos = (xs: ClienteMin[] | undefined) => (xs ?? []).filter((c) => c.activo);
    const aDoc = r.documento ? porDoc.get(r.documento) : undefined;
    const aCod = r.codigo ? porCod.get(r.codigo.toLowerCase()) : undefined;
    let res: ResolucionCliente;
    if (r.documento || r.codigo) {
      const d = activos(aDoc);
      const c = activos(aCod);
      if (d.length > 1) res = { ok: false, motivo: 'ambiguo', texto: `Hay ${d.length} clientes con ${etiquetaRef({ documento: r.documento })}` };
      else if (d.length === 1 && c.length === 1 && d[0].id !== c[0].id) res = { ok: false, motivo: 'ambiguo', texto: 'El documento y el código del cliente apuntan a clientes distintos' };
      else if (d.length === 1) res = { ok: true, id: d[0].id, nombre: d[0].nombre };
      else if (c.length === 1) res = { ok: true, id: c[0].id, nombre: c[0].nombre };
      else if ((aDoc?.length ?? 0) + (aCod?.length ?? 0) > 0) res = { ok: false, motivo: 'baja', texto: `El cliente (${etiquetaRef(r)}) está dado de baja` };
      else res = { ok: false, motivo: 'inexistente', texto: `No existe un cliente con ${etiquetaRef(r.documento ? { documento: r.documento } : { codigo: r.codigo })}` };
    } else {
      const n = activos(porNom.get(normalizarTextoImport(r.nombre)));
      if (n.length === 1) res = { ok: true, id: n[0].id, nombre: n[0].nombre, aviso: `Cliente asociado por nombre exacto ("${n[0].nombre}"): verificá que sea la misma persona` };
      else if (n.length > 1) res = { ok: false, motivo: 'ambiguo', texto: `Hay ${n.length} clientes llamados "${r.nombre}": no se sabe cuál es` };
      else res = { ok: false, motivo: 'inexistente', texto: `No existe un cliente llamado "${r.nombre}"` };
    }
    out.set(k, res);
  }
  return out;
}

interface VehiculoExistente {
  id: string;
  /** Ids de los clientes vinculados vigentes, separados por coma. */
  vinculados: string | null;
  patente: string;
  activo: number;
  anio: number | null;
  color: string | null;
  vin: string | null;
  motor: string | null;
  combustible: string | null;
  km_actual: number;
  notas: string | null;
  marca: string | null;
  modelo: string | null;
}

export async function planificarVehiculos(ctx: Contexto, filas: FilaEntrada[]): Promise<Plan> {
  const anioMax = new Date().getFullYear() + 1;
  const trab = prepararFilas('vehiculos', filas, (v) => normalizarVehiculo(v, anioMax));
  const validas = trab.filter((t) => t.res.accion !== 'error');

  // Vehículos existentes por patente.
  const existentes = new Map<string, VehiculoExistente[]>();
  for (const l of lotes(unicos(validas.map((t) => t.datos.patente!).filter(Boolean)))) {
    const rows = await all<VehiculoExistente>(
      ctx.db,
      `SELECT v.id, (SELECT GROUP_CONCAT(x.cliente_id) FROM vehiculo_clientes x WHERE x.taller_id = v.taller_id AND x.vehiculo_id = v.id AND x.desvinculado_at IS NULL) AS vinculados, v.patente, v.activo, v.anio, v.color, v.vin, v.motor, v.combustible, v.km_actual, v.notas, ma.nombre AS marca, mo.nombre AS modelo
         FROM vehiculos v
         LEFT JOIN marcas ma ON ma.taller_id = v.taller_id AND ma.id = v.marca_id
         LEFT JOIN modelos mo ON mo.taller_id = v.taller_id AND mo.id = v.modelo_id
        WHERE v.taller_id = ? AND v.patente IN (${SQL_IN(l.length)})`,
      ctx.tallerId, ...l,
    );
    for (const r of rows) agregar(existentes, `p:${r.patente}`, r);
  }
  const delTrabajo = await idsDelTrabajo(ctx, unicos([...existentes.values()].flat().map((e) => e.id)));

  // Catálogo de marcas y modelos del taller.
  const marcas = new Map((await all<{ id: string; nombre: string }>(ctx.db, 'SELECT id, nombre FROM marcas WHERE taller_id = ?', ctx.tallerId)).map((m) => [normalizarTextoImport(m.nombre), m]));
  const modelos = new Set((await all<{ marca_id: string; nombre: string }>(ctx.db, 'SELECT marca_id, nombre FROM modelos WHERE taller_id = ?', ctx.tallerId)).map((m) => `${m.marca_id}|${normalizarTextoImport(m.nombre)}`));

  // Primera pasada: qué hacer con cada patente (para resolver clientes solo donde hace falta).
  const necesitaCliente: Array<(typeof trab)[number]> = [];
  const decisiones = new Map<number, ReturnType<typeof decidir>>();
  for (const t of validas) {
    const ex = buscar(t.claves, existentes);
    if (ex.some((e) => delTrabajo.has(e.id))) {
      t.res.accion = 'error';
      t.res.errores.push('Duplicado en el archivo: esta patente ya fue cargada en un lote anterior de esta misma importación');
      continue;
    }
    const dec = decidir(ctx.modo, true, ex.length, 'vehículos');
    decisiones.set(t.n, dec);
    if (dec.tipo === 'omitir') (t.res.accion = 'omitir'), (t.res.motivo = dec.motivo + (ex[0] && !ex[0].activo ? ' (dado de baja)' : ''));
    else if (dec.tipo === 'error') (t.res.accion = 'error'), t.res.errores.push(dec.motivo);
    else necesitaCliente.push(t);
  }
  const clientes = await resolverClientes(ctx, necesitaCliente.map((t) => t.datos.cliente_ref!).filter(Boolean));

  const stmts: Stmt[] = [];
  const registros: Plan['registros'] = [];
  const marcasNuevas = new Map<string, string>();
  const modelosNuevos = new Map<string, { marca: string; modelo: string }>();

  for (const t of necesitaCliente) {
    const d = t.datos;
    const ref = d.cliente_ref;
    const clave = ref ? claveReferenciaCliente(ref) : '';
    const cl = ref ? clientes.get(clave)! : null;
    if (ref && cl && !cl.ok) {
      t.res.accion = 'error';
      t.res.errores.push(cl.texto + (cl.motivo === 'inexistente' ? '. Importalo primero, elegí a qué cliente corresponde o dejá la columna vacía para cargar el vehículo sin cliente' : cl.motivo === 'ambiguo' ? '. Elegí a qué cliente corresponde' : ''));
      if (cl.motivo !== 'baja') t.res.pendiente = { tipo: 'cliente', clave, etiqueta: etiquetaRef(ref), motivo: cl.motivo };
      continue;
    }
    if (cl?.ok && cl.aviso) t.res.avisos.push(cl.aviso);
    const clienteId = cl?.ok ? cl.id : null;

    // Marca y modelo.
    let errorCatalogo: string | null = null;
    const nuevos: string[] = [];
    let marcaId: string | null = null;
    if (d.marca) {
      const m = marcas.get(normalizarTextoImport(d.marca));
      if (m) marcaId = m.id;
      else if (!ctx.opciones.crear_catalogos) errorCatalogo = `La marca "${d.marca}" no existe (activá "crear marcas y modelos nuevos" o cargala antes)`;
      else (nuevos.push(`marca ${d.marca}`), marcasNuevas.set(normalizarTextoImport(d.marca), d.marca));
    }
    if (!errorCatalogo && d.modelo && d.marca) {
      const existe = marcaId ? modelos.has(`${marcaId}|${normalizarTextoImport(d.modelo)}`) : false;
      if (!existe) {
        if (!ctx.opciones.crear_catalogos) errorCatalogo = `El modelo "${d.modelo}" no existe para la marca ${d.marca} (activá "crear marcas y modelos nuevos" o cargalo antes)`;
        else (nuevos.push(`modelo ${d.modelo}`), modelosNuevos.set(`${normalizarTextoImport(d.marca)}|${normalizarTextoImport(d.modelo)}`, { marca: d.marca, modelo: d.modelo }));
      }
    }
    if (errorCatalogo) {
      t.res.accion = 'error';
      t.res.errores.push(errorCatalogo);
      continue;
    }
    if (nuevos.length) t.res.nuevos = nuevos;

    const dec = decisiones.get(t.n)!;
    if (dec.tipo === 'actualizar') {
      const e = buscar(t.claves, existentes)[0];
      // Los vínculos con clientes no se tocan al importar: se administran desde la ficha del vehículo.
      if (clienteId && !(e.vinculados ?? '').split(',').includes(clienteId)) t.res.avisos.push('El cliente del archivo no está vinculado a este vehículo: la importación no modifica los vínculos (hacelo desde la ficha del vehículo)');
      const cambios: CambioCampo[] = [];
      const c = [
        cambio('marca', e.marca, d.marca, igualesSinCaso),
        cambio('modelo', e.modelo, d.modelo, igualesSinCaso),
        cambio('año', e.anio, d.anio),
        cambio('color', e.color, d.color, igualesSinCaso),
        cambio('chasis', e.vin, d.vin),
        cambio('motor', e.motor, d.motor),
        cambio('combustible', e.combustible, d.combustible, igualesSinCaso),
        cambio('notas', e.notas, d.notas),
      ];
      for (const x of c) if (x) cambios.push(x);
      let km: number | undefined;
      if (d.km !== undefined) {
        if (d.km > e.km_actual) (km = d.km), cambios.push({ campo: 'kilometraje', antes: String(e.km_actual), despues: String(d.km) });
        else if (d.km < e.km_actual) t.res.avisos.push(`El kilometraje del archivo (${d.km}) es menor al registrado (${e.km_actual}): no se modifica`);
      }
      if (d.marca && e.marca && e.marca.toLowerCase() !== d.marca.toLowerCase() && !d.modelo) {
        t.res.accion = 'error';
        t.res.errores.push('Cambia la marca del vehículo pero el archivo no trae el modelo: completalo para no dejar un modelo de otra marca');
        continue;
      }
      if (!cambios.length) {
        t.res.accion = 'omitir';
        t.res.motivo = 'Sin cambios';
        continue;
      }
      t.res.accion = 'actualizar';
      t.res.cambios = cambios;
      if (!e.activo) t.res.avisos.push('El vehículo existente está dado de baja: se actualizan sus datos pero no se reactiva');
      if (ctx.aplicar) {
        const sets: string[] = [];
        const vals: unknown[] = [];
        const poner = (col: string, v: unknown) => (sets.push(`${col} = ?`), vals.push(v));
        if (d.marca) (sets.push('marca_id = (SELECT id FROM marcas WHERE taller_id = ? AND nombre = ?)'), vals.push(ctx.tallerId, d.marca));
        if (d.modelo) (sets.push('modelo_id = (SELECT id FROM modelos WHERE taller_id = ? AND marca_id = (SELECT id FROM marcas WHERE taller_id = ? AND nombre = ?) AND nombre = ?)'), vals.push(ctx.tallerId, ctx.tallerId, d.marca, d.modelo));
        if (d.anio !== undefined) poner('anio', d.anio);
        for (const k of ['color', 'vin', 'motor', 'combustible', 'notas'] as const) if (d[k] !== undefined) poner(k, d[k]);
        if (km !== undefined) poner('km_actual', km);
        stmts.push(ctx.db.prepare(`UPDATE vehiculos SET ${sets.join(', ')}, updated_at = ? WHERE taller_id = ? AND id = ?`).bind(...vals, ahora(), ctx.tallerId, e.id));
        registros.push({ id: e.id, accion: 'actualizado' });
      }
      continue;
    }

    t.res.accion = 'crear';
    if (ctx.aplicar) {
      const id = uid();
      stmts.push(
        ctx.db.prepare(
          `INSERT INTO vehiculos (id, taller_id, patente, marca_id, modelo_id, anio, color, vin, motor, combustible, km_actual, notas)
           VALUES (?, ?, ?, (SELECT id FROM marcas WHERE taller_id = ? AND nombre = ?),
                   (SELECT id FROM modelos WHERE taller_id = ? AND marca_id = (SELECT id FROM marcas WHERE taller_id = ? AND nombre = ?) AND nombre = ?), ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(id, ctx.tallerId, d.patente, ctx.tallerId, d.marca ?? null, ctx.tallerId, ctx.tallerId, d.marca ?? null, d.modelo ?? null, d.anio ?? null, d.color ?? null, d.vin ?? null, d.motor ?? null, d.combustible ?? null, d.km ?? 0, d.notas ?? null),
      );
      if (clienteId) {
        stmts.push(
          ctx.db.prepare("INSERT INTO vehiculo_clientes (id, taller_id, vehiculo_id, cliente_id, relacion, vinculado_por) VALUES (?, ?, ?, ?, 'titular', ?)").bind(uid(), ctx.tallerId, id, clienteId, ctx.sesion.usuarioId),
        );
      }
      registros.push({ id, accion: 'creado' });
    }
  }

  // Marcas y modelos nuevos: se crean antes que los vehículos que los usan (INSERT OR IGNORE: respeta los únicos por nombre).
  if (ctx.aplicar) {
    const previos: Stmt[] = [];
    for (const m of marcasNuevas.values()) previos.push(ctx.db.prepare('INSERT OR IGNORE INTO marcas (id, taller_id, nombre) VALUES (?, ?, ?)').bind(uid(), ctx.tallerId, m));
    for (const m of modelosNuevos.values()) {
      previos.push(
        ctx.db.prepare('INSERT OR IGNORE INTO modelos (id, taller_id, marca_id, nombre) SELECT ?, taller_id, id, ? FROM marcas WHERE taller_id = ? AND nombre = ?').bind(uid(), m.modelo, ctx.tallerId, m.marca),
      );
    }
    stmts.unshift(...previos);
  }
  return { resultados: trab.map((t) => t.res as ResultadoFila), stmts, registros };
}
