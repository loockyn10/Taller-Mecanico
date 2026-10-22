// Importación de artículos (catálogo). Identidad: código interno y/o código de barras. El nombre NUNCA identifica a un artículo.
// El catálogo y la existencia son cosas distintas: por defecto no se crea ningún movimiento de stock. La carga inicial de existencias
// es un procedimiento aparte, explícito, que solo aplica a artículos nuevos y deja un movimiento de entrada trazable por cada uno.
import { all, ahora, lotes, uid, type Stmt } from '../db';
import {
  claveReferenciaProveedor, normalizarArticulo, normalizarTextoImport, type CambioCampo, type ReferenciaProveedor,
} from '../../../shared/importacion';
import { agregar, buscar, cambio, decidir, idsDelTrabajo, igualesSinCaso, prepararFilas, SQL_IN, unicos, type Contexto, type FilaEntrada, type Plan } from './comun';
import { CUIT_SQL } from './proveedores';
import { sentenciaOrigenCosto, sentenciasMovimiento } from '../stock';
import { puedeCosto, puedePrecioVenta } from '../privacidad';

interface ProveedorMin { id: string; nombre: string; activo: number; codigo_externo: string | null }
export type ResolucionProveedor = { ok: true; id: string; nombre: string; aviso?: string } | { ok: false; motivo: 'inexistente' | 'ambiguo' | 'baja'; texto: string };
const etiquetaRef = (r: ReferenciaProveedor) => (r.cuit ? `CUIT ${r.cuit}` : r.codigo ? `código ${r.codigo}` : `nombre "${r.nombre}"`);

export async function resolverProveedores(ctx: Contexto, refs: ReferenciaProveedor[]): Promise<Map<string, ResolucionProveedor>> {
  const claves = new Map<string, ReferenciaProveedor>();
  for (const r of refs) claves.set(claveReferenciaProveedor(r), r);
  const out = new Map<string, ResolucionProveedor>();
  const elegidas = new Map<string, string>();
  for (const [k] of claves) {
    const id = ctx.resoluciones[`proveedor:${k}`];
    if (id) elegidas.set(k, id);
  }
  const validas = new Map<string, ProveedorMin>();
  for (const l of lotes(unicos([...elegidas.values()]))) for (const p of await all<ProveedorMin>(ctx.db, `SELECT id, nombre, activo, codigo_externo FROM proveedores WHERE taller_id = ? AND id IN (${SQL_IN(l.length)})`, ctx.tallerId, ...l)) validas.set(p.id, p);

  const cuits = unicos([...claves.values()].map((r) => r.cuit).filter((x): x is string => !!x));
  const cods = unicos([...claves.values()].map((r) => r.codigo).filter((x): x is string => !!x));
  const noms = unicos([...claves.values()].filter((r) => !r.cuit && !r.codigo && r.nombre).map((r) => r.nombre!));
  const porCuit = new Map<string, ProveedorMin[]>();
  const porCod = new Map<string, ProveedorMin[]>();
  const porNom = new Map<string, ProveedorMin[]>();
  for (const l of lotes(cuits)) for (const p of await all<ProveedorMin & { dk: string }>(ctx.db, `SELECT id, nombre, activo, codigo_externo, ${CUIT_SQL} AS dk FROM proveedores WHERE taller_id = ? AND ${CUIT_SQL} IN (${SQL_IN(l.length)})`, ctx.tallerId, ...l)) agregar(porCuit, p.dk, p);
  for (const l of lotes(cods)) for (const p of await all<ProveedorMin>(ctx.db, `SELECT id, nombre, activo, codigo_externo FROM proveedores WHERE taller_id = ? AND lower(codigo_externo) IN (${SQL_IN(l.length)})`, ctx.tallerId, ...l.map((x) => x.toLowerCase()))) agregar(porCod, (p.codigo_externo ?? '').toLowerCase(), p);
  for (const l of lotes(noms)) for (const p of await all<ProveedorMin>(ctx.db, `SELECT id, nombre, activo, codigo_externo FROM proveedores WHERE taller_id = ? AND nombre COLLATE NOCASE IN (${SQL_IN(l.length)})`, ctx.tallerId, ...l)) agregar(porNom, normalizarTextoImport(p.nombre), p);

  for (const [k, r] of claves) {
    const elegido = elegidas.get(k);
    if (elegido) {
      const p = validas.get(elegido);
      out.set(k, p && p.activo ? { ok: true, id: p.id, nombre: p.nombre } : { ok: false, motivo: 'inexistente', texto: 'El proveedor elegido ya no existe o está dado de baja' });
      continue;
    }
    const act = (xs: ProveedorMin[] | undefined) => (xs ?? []).filter((p) => p.activo);
    let res: ResolucionProveedor;
    if (r.cuit || r.codigo) {
      const a = act(r.cuit ? porCuit.get(r.cuit) : undefined);
      const b = act(r.codigo ? porCod.get(r.codigo.toLowerCase()) : undefined);
      if (a.length > 1) res = { ok: false, motivo: 'ambiguo', texto: `Hay ${a.length} proveedores con ${etiquetaRef({ cuit: r.cuit })}` };
      else if (a.length === 1 && b.length === 1 && a[0].id !== b[0].id) res = { ok: false, motivo: 'ambiguo', texto: 'El CUIT y el código del proveedor apuntan a proveedores distintos' };
      else if (a.length === 1) res = { ok: true, id: a[0].id, nombre: a[0].nombre };
      else if (b.length === 1) res = { ok: true, id: b[0].id, nombre: b[0].nombre };
      else if ((r.cuit ? porCuit.get(r.cuit)?.length ?? 0 : 0) + (r.codigo ? porCod.get(r.codigo.toLowerCase())?.length ?? 0 : 0) > 0) res = { ok: false, motivo: 'baja', texto: `El proveedor (${etiquetaRef(r)}) está dado de baja` };
      else res = { ok: false, motivo: 'inexistente', texto: `No existe un proveedor con ${etiquetaRef(r.cuit ? { cuit: r.cuit } : { codigo: r.codigo })}` };
    } else {
      const n = act(porNom.get(normalizarTextoImport(r.nombre)));
      if (n.length === 1) res = { ok: true, id: n[0].id, nombre: n[0].nombre, aviso: `Proveedor asociado por nombre exacto ("${n[0].nombre}"): verificá que sea el mismo` };
      else if (n.length > 1) res = { ok: false, motivo: 'ambiguo', texto: `Hay ${n.length} proveedores llamados "${r.nombre}": no se sabe cuál es` };
      else res = { ok: false, motivo: 'inexistente', texto: `No existe un proveedor llamado "${r.nombre}"` };
    }
    out.set(k, res);
  }
  return out;
}

interface ArticuloExistente {
  id: string;
  codigo: string | null;
  codigo_barras: string | null;
  nombre: string;
  marca: string | null;
  categoria_id: string | null;
  categoria: string | null;
  proveedor_id: string | null;
  proveedor: string | null;
  costo: number;
  precio: number;
  alicuota_iva: number;
  stock_minimo: number;
  stock_objetivo: number | null;
  unidad: string;
  ubicacion: string | null;
  activo: number;
  con_movimientos: number;
}

const pesos = (c: number) => (c / 100).toFixed(2).replace('.', ',');

export async function planificarArticulos(ctx: Contexto, filas: FilaEntrada[]): Promise<Plan> {
  const trab = prepararFilas('articulos', filas, (v) => normalizarArticulo(v, { decimal: ctx.opciones.decimal }));
  const validas = trab.filter((t) => t.res.accion !== 'error');
  const verCosto = puedeCosto(ctx.sesion);
  const verPrecio = puedePrecioVenta(ctx.sesion);

  // Artículos existentes por código o por código de barras (sin distinguir mayúsculas).
  const existentes = new Map<string, ArticuloExistente[]>();
  const cols = `a.id, a.codigo, a.codigo_barras, a.nombre, a.marca, a.categoria_id, ca.nombre AS categoria, a.proveedor_id, p.nombre AS proveedor, a.costo, a.precio, a.alicuota_iva, a.stock_minimo, a.stock_objetivo, a.unidad, a.ubicacion, a.activo,
    EXISTS (SELECT 1 FROM stock_movimientos m WHERE m.taller_id = a.taller_id AND m.articulo_id = a.id) AS con_movimientos`;
  const desde = `FROM articulos a LEFT JOIN categorias_articulo ca ON ca.taller_id = a.taller_id AND ca.id = a.categoria_id LEFT JOIN proveedores p ON p.taller_id = a.taller_id AND p.id = a.proveedor_id`;
  for (const l of lotes(unicos(validas.map((t) => t.datos.codigo?.toLowerCase()).filter((x): x is string => !!x)))) {
    for (const r of await all<ArticuloExistente>(ctx.db, `SELECT ${cols} ${desde} WHERE a.taller_id = ? AND lower(a.codigo) IN (${SQL_IN(l.length)})`, ctx.tallerId, ...l)) agregar(existentes, `c:${(r.codigo ?? '').toLowerCase()}`, r);
  }
  for (const l of lotes(unicos(validas.map((t) => t.datos.codigo_barras?.toLowerCase()).filter((x): x is string => !!x)))) {
    for (const r of await all<ArticuloExistente>(ctx.db, `SELECT ${cols} ${desde} WHERE a.taller_id = ? AND lower(a.codigo_barras) IN (${SQL_IN(l.length)})`, ctx.tallerId, ...l)) agregar(existentes, `b:${(r.codigo_barras ?? '').toLowerCase()}`, r);
  }
  const delTrabajo = await idsDelTrabajo(ctx, unicos([...existentes.values()].flat().map((e) => e.id)));
  const categorias = new Map((await all<{ id: string; nombre: string }>(ctx.db, 'SELECT id, nombre FROM categorias_articulo WHERE taller_id = ?', ctx.tallerId)).map((c) => [normalizarTextoImport(c.nombre), c]));

  const decisiones = new Map<number, ReturnType<typeof decidir>>();
  const necesitaProveedor: Array<(typeof trab)[number]> = [];
  for (const t of validas) {
    const ex = buscar(t.claves, existentes);
    if (ex.some((e) => delTrabajo.has(e.id))) {
      t.res.accion = 'error';
      t.res.errores.push('Duplicado en el archivo: este artículo ya fue cargado en un lote anterior de esta misma importación');
      continue;
    }
    // Un código que apunta a un artículo y el código de barras a otro: no se adivina.
    const porCodigo = t.datos.codigo ? existentes.get(`c:${t.datos.codigo.toLowerCase()}`) ?? [] : [];
    const porBarras = t.datos.codigo_barras ? existentes.get(`b:${t.datos.codigo_barras.toLowerCase()}`) ?? [] : [];
    if (porCodigo.length && porBarras.length && !porCodigo.some((a) => porBarras.some((b) => b.id === a.id))) {
      t.res.accion = 'error';
      t.res.errores.push('El código y el código de barras de esta fila corresponden a artículos distintos');
      continue;
    }
    const dec = decidir(ctx.modo, t.claves.length > 0, ex.length, 'artículos');
    decisiones.set(t.n, dec);
    if (dec.tipo === 'omitir') (t.res.accion = 'omitir'), (t.res.motivo = dec.motivo + (ex[0] && !ex[0].activo ? ' (dado de baja)' : ''));
    else if (dec.tipo === 'error') (t.res.accion = 'error'), t.res.errores.push(dec.motivo);
    else {
      if (!t.claves.length) t.res.avisos.push('Sin código ni código de barras: no se pueden detectar repetidos de este artículo');
      if (t.datos.proveedor_ref) necesitaProveedor.push(t);
    }
  }
  const proveedores = await resolverProveedores(ctx, necesitaProveedor.map((t) => t.datos.proveedor_ref!));

  const stmts: Stmt[] = [];
  const registros: Plan['registros'] = [];
  const categoriasNuevas = new Map<string, string>();
  const stockInicial = ctx.opciones.stock_inicial;

  for (const t of validas) {
    if (t.res.accion === 'error' || t.res.accion === 'omitir') continue;
    const d = t.datos;
    // Permisos sobre datos de precios: no se fijan valores que la persona no puede ver.
    // Proveedor.
    let proveedorId: string | null | undefined;
    let proveedorNombre: string | undefined;
    if (d.proveedor_ref) {
      const clave = claveReferenciaProveedor(d.proveedor_ref);
      const pr = proveedores.get(clave)!;
      if (!pr.ok) {
        t.res.accion = 'error';
        t.res.errores.push(pr.texto + (pr.motivo === 'inexistente' ? '. Importalo primero o elegí a qué proveedor corresponde' : pr.motivo === 'ambiguo' ? '. Elegí a qué proveedor corresponde' : ''));
        if (pr.motivo !== 'baja') t.res.pendiente = { tipo: 'proveedor', clave, etiqueta: etiquetaRef(d.proveedor_ref), motivo: pr.motivo };
        continue;
      }
      if (pr.aviso) t.res.avisos.push(pr.aviso);
      proveedorId = pr.id;
      proveedorNombre = pr.nombre;
    }
    // Categoría.
    let categoriaNombre: string | undefined;
    const nuevos: string[] = [];
    if (d.categoria) {
      const c = categorias.get(normalizarTextoImport(d.categoria));
      if (c) categoriaNombre = c.nombre;
      else if (!ctx.opciones.crear_catalogos) {
        t.res.accion = 'error';
        t.res.errores.push(`La categoría "${d.categoria}" no existe (activá "crear categorías nuevas" o cargala antes)`);
        continue;
      } else {
        categoriaNombre = d.categoria;
        nuevos.push(`categoría ${d.categoria}`);
        categoriasNuevas.set(normalizarTextoImport(d.categoria), d.categoria);
      }
    }
    if (nuevos.length) t.res.nuevos = nuevos;

    const dec = decisiones.get(t.n)!;
    if (dec.tipo === 'actualizar') {
      const e = buscar(t.claves, existentes)[0];
      if (d.codigo && e.codigo && e.codigo.toLowerCase() !== d.codigo.toLowerCase()) {
        t.res.accion = 'error';
        t.res.errores.push(`El código del archivo no coincide con el del artículo existente "${e.nombre}": no se modifica`);
        continue;
      }
      if (d.codigo_barras && e.codigo_barras && e.codigo_barras.toLowerCase() !== d.codigo_barras.toLowerCase()) {
        t.res.accion = 'error';
        t.res.errores.push(`El código de barras del archivo no coincide con el del artículo existente "${e.nombre}": no se modifica`);
        continue;
      }
      if (d.unidad && d.unidad !== e.unidad && e.con_movimientos) {
        t.res.accion = 'error';
        t.res.errores.push('No se cambia la unidad de un artículo que ya tiene movimientos de stock');
        continue;
      }
      const cambios: CambioCampo[] = [];
      const c = [
        cambio('descripción', e.nombre, d.nombre),
        d.codigo && !e.codigo ? { campo: 'código', antes: null, despues: d.codigo } : null,
        d.codigo_barras && !e.codigo_barras ? { campo: 'código de barras', antes: null, despues: d.codigo_barras } : null,
        cambio('marca', e.marca, d.marca, igualesSinCaso),
        cambio('categoría', e.categoria, categoriaNombre, igualesSinCaso),
        cambio('proveedor', e.proveedor, proveedorNombre, igualesSinCaso),
        cambio('unidad', e.unidad, d.unidad),
        d.costo !== undefined && d.costo !== e.costo ? { campo: 'costo', antes: verCosto ? pesos(e.costo) : null, despues: pesos(d.costo) } : null,
        d.precio !== undefined && d.precio !== e.precio ? { campo: 'precio de venta', antes: verPrecio ? pesos(e.precio) : null, despues: pesos(d.precio) } : null,
        cambio('IVA %', e.alicuota_iva, d.alicuota_iva),
        cambio('stock mínimo', e.stock_minimo, d.stock_minimo),
        cambio('stock ideal', e.stock_objetivo, d.stock_objetivo),
        cambio('ubicación', e.ubicacion, d.ubicacion),
      ];
      for (const x of c) if (x) cambios.push(x);
      if (d.stock_inicial !== undefined) t.res.avisos.push('La existencia del archivo no se carga en artículos que ya existen (usá un ajuste o un conteo de inventario)');
      if (!cambios.length) {
        t.res.accion = 'omitir';
        t.res.motivo = 'Sin cambios';
        continue;
      }
      t.res.accion = 'actualizar';
      t.res.cambios = cambios;
      if (!e.activo) t.res.avisos.push('El artículo existente está dado de baja: se actualizan sus datos pero no se reactiva');
      if (ctx.aplicar) {
        const sets: string[] = [];
        const vals: unknown[] = [];
        const poner = (col: string, v: unknown) => (sets.push(`${col} = ?`), vals.push(v));
        if (d.nombre && d.nombre !== e.nombre) poner('nombre', d.nombre);
        if (d.codigo && !e.codigo) poner('codigo', d.codigo);
        if (d.codigo_barras && !e.codigo_barras) poner('codigo_barras', d.codigo_barras);
        if (d.marca !== undefined) poner('marca', d.marca);
        if (categoriaNombre) (sets.push('categoria_id = (SELECT id FROM categorias_articulo WHERE taller_id = ? AND nombre = ?)'), vals.push(ctx.tallerId, categoriaNombre));
        if (proveedorId) poner('proveedor_id', proveedorId);
        if (d.unidad) poner('unidad', d.unidad);
        if (d.costo !== undefined) poner('costo', d.costo);
        if (d.precio !== undefined) poner('precio', d.precio);
        if (d.alicuota_iva !== undefined) poner('alicuota_iva', d.alicuota_iva);
        if (d.stock_minimo !== undefined) poner('stock_minimo', d.stock_minimo);
        if (d.stock_objetivo !== undefined) poner('stock_objetivo', d.stock_objetivo);
        if (d.ubicacion !== undefined) poner('ubicacion', d.ubicacion);
        stmts.push(ctx.db.prepare(`UPDATE articulos SET ${sets.join(', ')}, updated_at = ? WHERE taller_id = ? AND id = ?`).bind(...vals, ahora(), ctx.tallerId, e.id));
        if (d.costo !== undefined && d.costo !== e.costo) stmts.push(sentenciaOrigenCosto(ctx.db, ctx.tallerId, e.id, 'importacion'));
        registros.push({ id: e.id, accion: 'actualizado' });
      }
      continue;
    }

    t.res.accion = 'crear';
    if (d.stock_inicial !== undefined && d.stock_inicial > 0) {
      if (!stockInicial) t.res.avisos.push('La existencia del archivo no se carga: el stock inicial es un procedimiento aparte que hay que activar y confirmar');
      else t.res.nuevos = [...(t.res.nuevos ?? []), `existencia inicial ${d.stock_inicial}`];
    }
    if (ctx.aplicar) {
      const id = uid();
      stmts.push(
        ctx.db.prepare(
          `INSERT INTO articulos (id, taller_id, codigo, codigo_barras, nombre, marca, categoria_id, proveedor_id, costo, precio, alicuota_iva, stock, stock_minimo, stock_objetivo, unidad, ubicacion)
           VALUES (?, ?, ?, ?, ?, ?, (SELECT id FROM categorias_articulo WHERE taller_id = ? AND nombre = ?), ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        ).bind(id, ctx.tallerId, d.codigo ?? null, d.codigo_barras ?? null, d.nombre, d.marca ?? null, ctx.tallerId, categoriaNombre ?? null, proveedorId ?? null, d.costo ?? 0, d.precio ?? 0, d.alicuota_iva ?? 21, d.stock_minimo ?? 0, d.stock_objetivo ?? null, d.unidad ?? 'un', d.ubicacion ?? null),
      );
      if (stockInicial && d.stock_inicial && d.stock_inicial > 0) {
        stmts.push(
          ...sentenciasMovimiento(
            ctx.db, ctx.tallerId,
            {
              articuloId: id, depositoId: stockInicial.deposito_id, delta: d.stock_inicial, tipo: 'entrada', notas: 'Existencia inicial (importación)', usuarioId: ctx.sesion.usuarioId,
              costoUnitario: d.costo ?? 0, idemKey: `imp:${ctx.importacionId}:${id}`,
              // Se registra como entrada manual (con la importación como origen): es el circuito que la contabilidad ya conoce, así el inventario
              // contable y el valorizado siguen coincidiendo y la entrada queda a clasificar como "entradas de mercadería sin compra".
              origenTipo: 'manual', origenId: ctx.importacionId,
            },
            true,
          ),
        );
      }
      registros.push({ id, accion: 'creado' });
    }
  }

  if (ctx.aplicar && categoriasNuevas.size) {
    stmts.unshift(...[...categoriasNuevas.values()].map((n) => ctx.db.prepare('INSERT OR IGNORE INTO categorias_articulo (id, taller_id, nombre) VALUES (?, ?, ?)').bind(uid(), ctx.tallerId, n)));
  }
  return { resultados: trab.map((t) => t.res), stmts, registros };
}
