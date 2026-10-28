// Consultas contables: plan con saldos, libro diario, libro mayor, balance de sumas y saldos, estado de resultados y resumen.
// Sólo cuentan los asientos registrados o revertidos (un borrador todavía no es contabilidad). Importes en centavos.
import { all, first, lotes } from '../db';
import { saldoNatural, type Naturaleza } from '../../../shared/contabilidad';
import { rentabilidadOrdenes } from '../rentabilidad';
import { FUENTES } from './fuentes';

const CONTABILIZADO = "a.estado <> 'borrador'";

export interface CuentaConSaldo {
  id: string;
  codigo: string;
  nombre: string;
  tipo: string;
  naturaleza: Naturaleza;
  padre_id: string | null;
  imputable: number;
  rol: string | null;
  cuenta_bancaria_id: string | null;
  activa: number;
  notas: string | null;
  debe: number;
  haber: number;
  movimientos: number;
  saldo: number;
}

/** Plan de cuentas con su movimiento acumulado (hasta `hasta`, si se indica). */
export async function planConSaldos(db: D1Database, tallerId: string, hasta?: string): Promise<CuentaConSaldo[]> {
  const filas = await all<Omit<CuentaConSaldo, 'saldo'>>(
    db,
    `SELECT c.id, c.codigo, c.nombre, c.tipo, c.naturaleza, c.padre_id, c.imputable, c.rol, c.cuenta_bancaria_id, c.activa, c.notas,
            COALESCE(m.debe, 0) AS debe, COALESCE(m.haber, 0) AS haber, COALESCE(m.n, 0) AS movimientos
       FROM cuentas_contables c
       LEFT JOIN (SELECT l.cuenta_id, SUM(l.debe) AS debe, SUM(l.haber) AS haber, COUNT(*) AS n
                    FROM asiento_lineas l JOIN asientos a ON a.taller_id = l.taller_id AND a.id = l.asiento_id
                   WHERE l.taller_id = ? AND ${CONTABILIZADO} ${hasta ? 'AND a.fecha <= ?' : ''} GROUP BY l.cuenta_id) m ON m.cuenta_id = c.id
      WHERE c.taller_id = ? ORDER BY c.codigo`,
    tallerId, ...(hasta ? [hasta] : []), tallerId,
  );
  const hojas = filas.map((f) => ({ ...f, saldo: saldoNatural(f.naturaleza, f.debe, f.haber) }));
  // Los rubros acumulan lo de sus cuentas (en el sentido natural del rubro).
  const hijos = new Map<string, typeof hojas>();
  for (const f of hojas) if (f.padre_id) hijos.set(f.padre_id, [...(hijos.get(f.padre_id) ?? []), f]);
  const total = (f: (typeof hojas)[number]): { debe: number; haber: number; n: number } => {
    const hs = hijos.get(f.id) ?? [];
    return hs.reduce((a, h) => { const t = total(h); return { debe: a.debe + t.debe, haber: a.haber + t.haber, n: a.n + t.n }; }, { debe: f.debe, haber: f.haber, n: f.movimientos });
  };
  return hojas.map((f) => {
    if (f.imputable) return f;
    const t = total(f);
    return { ...f, debe: t.debe, haber: t.haber, movimientos: t.n, saldo: saldoNatural(f.naturaleza, t.debe, t.haber) };
  });
}

export interface FiltrosDiario {
  desde: string;
  hasta: string;
  estado?: 'registrado' | 'revertido' | 'borrador' | 'contabilizados' | 'todos';
  origen?: string;
  cuentaId?: string;
  q?: string;
  limite: number;
  desplazamiento: number;
}

export async function libroDiario(db: D1Database, tallerId: string, f: FiltrosDiario) {
  const cond = ['a.taller_id = ?', 'a.fecha BETWEEN ? AND ?'];
  const params: unknown[] = [tallerId, f.desde, f.hasta];
  const estado = f.estado ?? 'contabilizados';
  if (estado === 'contabilizados') cond.push("a.estado <> 'borrador'");
  else if (estado !== 'todos') (cond.push('a.estado = ?'), params.push(estado));
  if (f.origen) (cond.push('a.origen_tipo = ?'), params.push(f.origen));
  if (f.cuentaId) (cond.push('EXISTS (SELECT 1 FROM asiento_lineas l WHERE l.taller_id = a.taller_id AND l.asiento_id = a.id AND l.cuenta_id = ?)'), params.push(f.cuentaId));
  if (f.q) {
    const t = f.q.replace(/[%_]/g, '');
    cond.push('(a.descripcion LIKE ? OR CAST(a.numero AS TEXT) = ?)');
    params.push(`%${t}%`, t.replace(/\D/g, ''));
  }
  const donde = cond.join(' AND ');
  const [asientos, totales] = await Promise.all([
    all<Record<string, any>>(
      db,
      `SELECT a.id, a.numero, a.fecha, a.descripcion, a.estado, a.modo, a.origen_tipo, a.origen_id, a.evento, a.revierte_id, a.corrige_id, a.motivo, a.advertencia, a.costo_incompleto, a.total,
              a.registrado_at, a.created_at, u.nombre AS usuario,
              (SELECT r.numero FROM asientos r WHERE r.taller_id = a.taller_id AND r.revierte_id = a.id) AS revertido_por_numero,
              (SELECT o.numero FROM asientos o WHERE o.taller_id = a.taller_id AND o.id = a.revierte_id) AS revierte_numero
         FROM asientos a LEFT JOIN usuarios u ON u.taller_id = a.taller_id AND u.id = a.usuario_id
        WHERE ${donde} ORDER BY a.fecha, a.numero IS NULL, a.numero, a.created_at LIMIT ? OFFSET ?`,
      ...params, f.limite, f.desplazamiento,
    ),
    first<{ n: number; total: number }>(db, `SELECT COUNT(*) AS n, COALESCE(SUM(a.total), 0) AS total FROM asientos a WHERE ${donde}`, ...params),
  ]);
  const lineas: Array<{ asiento_id: string }> = [];
  for (const l of lotes(asientos.map((a) => a.id))) {
    lineas.push(
      ...(await all<{ asiento_id: string }>(
        db,
        `SELECT l.asiento_id, l.orden, l.cuenta_id, c.codigo AS cuenta_codigo, c.nombre AS cuenta_nombre, l.debe, l.haber, l.detalle
           FROM asiento_lineas l JOIN cuentas_contables c ON c.taller_id = l.taller_id AND c.id = l.cuenta_id
          WHERE l.taller_id = ? AND l.asiento_id IN (${l.map(() => '?').join(',')}) ORDER BY l.asiento_id, l.orden`,
        tallerId, ...l,
      )),
    );
  }
  return { asientos: asientos.map((a) => ({ ...a, lineas: lineas.filter((l) => l.asiento_id === a.id) })), total: totales?.n ?? 0, importe_total: totales?.total ?? 0 };
}

export async function libroMayor(db: D1Database, tallerId: string, cuentaId: string, desde: string, hasta: string, limite = 2000) {
  const cuenta = await first<{ id: string; codigo: string; nombre: string; tipo: string; naturaleza: Naturaleza; imputable: number }>(
    db, 'SELECT id, codigo, nombre, tipo, naturaleza, imputable FROM cuentas_contables WHERE taller_id = ? AND id = ?', tallerId, cuentaId,
  );
  if (!cuenta) return null;
  // Un rubro agrupa a todas sus cuentas hijas.
  const todas = await all<{ id: string; padre_id: string | null }>(db, 'SELECT id, padre_id FROM cuentas_contables WHERE taller_id = ?', tallerId);
  const ids = new Set<string>([cuentaId]);
  let crecio = true;
  while (crecio) {
    crecio = false;
    for (const c of todas) if (c.padre_id && ids.has(c.padre_id) && !ids.has(c.id)) (ids.add(c.id), (crecio = true));
  }
  const lista = [...ids];
  if (lista.length > 80) return { cuenta, saldo_anterior: 0, movimientos: [], debe: 0, haber: 0, saldo_final: 0, truncado: true, error: 'El rubro tiene demasiadas cuentas: elegí una cuenta puntual' };
  const marcas = lista.map(() => '?').join(',');
  const ant = await first<{ debe: number; haber: number }>(
    db,
    `SELECT COALESCE(SUM(l.debe), 0) AS debe, COALESCE(SUM(l.haber), 0) AS haber FROM asiento_lineas l JOIN asientos a ON a.taller_id = l.taller_id AND a.id = l.asiento_id
      WHERE l.taller_id = ? AND ${CONTABILIZADO} AND a.fecha < ? AND l.cuenta_id IN (${marcas})`,
    tallerId, desde, ...lista,
  );
  const movs = await all<{ debe: number; haber: number }>(
    db,
    `SELECT a.id AS asiento_id, a.numero, a.fecha, a.descripcion, a.estado, a.origen_tipo, a.origen_id, l.cuenta_id, c.codigo AS cuenta_codigo, c.nombre AS cuenta_nombre, l.debe, l.haber, l.detalle
       FROM asiento_lineas l JOIN asientos a ON a.taller_id = l.taller_id AND a.id = l.asiento_id JOIN cuentas_contables c ON c.taller_id = l.taller_id AND c.id = l.cuenta_id
      WHERE l.taller_id = ? AND ${CONTABILIZADO} AND a.fecha BETWEEN ? AND ? AND l.cuenta_id IN (${marcas}) ORDER BY a.fecha, a.numero, l.orden LIMIT ?`,
    tallerId, desde, hasta, ...lista, limite + 1,
  );
  const truncado = movs.length > limite;
  if (truncado) movs.pop();
  const saldoAnterior = saldoNatural(cuenta.naturaleza, ant?.debe ?? 0, ant?.haber ?? 0);
  let acum = saldoAnterior;
  const conSaldo = movs.map((m) => ((acum += saldoNatural(cuenta.naturaleza, m.debe, m.haber)), { ...m, saldo: acum }));
  return {
    cuenta, saldo_anterior: saldoAnterior, movimientos: conSaldo, truncado,
    debe: movs.reduce((a, m) => a + m.debe, 0), haber: movs.reduce((a, m) => a + m.haber, 0), saldo_final: acum,
  };
}

export interface FilaBalance {
  cuenta_id: string;
  codigo: string;
  nombre: string;
  tipo: string;
  naturaleza: Naturaleza;
  rol: string | null;
  /** Saldo anterior al período en términos Debe − Haber (positivo = deudor). */
  inicial: number;
  debe: number;
  haber: number;
  final: number;
  alerta: string | null;
}

// Cuentas cuyo saldo puede ser legítimamente de cualquiera de los dos lados.
const SALDO_LIBRE = new Set(['ajustes_bancarios', 'transferencias_transito', 'apertura', 'resultados_acumulados', 'capital']);

export async function balanceSumasYSaldos(db: D1Database, tallerId: string, desde: string, hasta: string) {
  const filas = await all<{ id: string; codigo: string; nombre: string; tipo: string; naturaleza: Naturaleza; rol: string | null; ini_d: number; ini_h: number; per_d: number; per_h: number }>(
    db,
    `SELECT c.id, c.codigo, c.nombre, c.tipo, c.naturaleza, c.rol,
            COALESCE(m.ini_d, 0) AS ini_d, COALESCE(m.ini_h, 0) AS ini_h, COALESCE(m.per_d, 0) AS per_d, COALESCE(m.per_h, 0) AS per_h
       FROM cuentas_contables c
       LEFT JOIN (SELECT l.cuenta_id,
                         SUM(CASE WHEN a.fecha < ? THEN l.debe ELSE 0 END) AS ini_d, SUM(CASE WHEN a.fecha < ? THEN l.haber ELSE 0 END) AS ini_h,
                         SUM(CASE WHEN a.fecha >= ? THEN l.debe ELSE 0 END) AS per_d, SUM(CASE WHEN a.fecha >= ? THEN l.haber ELSE 0 END) AS per_h
                    FROM asiento_lineas l JOIN asientos a ON a.taller_id = l.taller_id AND a.id = l.asiento_id
                   WHERE l.taller_id = ? AND ${CONTABILIZADO} AND a.fecha <= ? GROUP BY l.cuenta_id) m ON m.cuenta_id = c.id
      WHERE c.taller_id = ? AND c.imputable = 1 AND (COALESCE(m.ini_d, 0) + COALESCE(m.ini_h, 0) + COALESCE(m.per_d, 0) + COALESCE(m.per_h, 0)) > 0 ORDER BY c.codigo`,
    desde, desde, desde, desde, tallerId, hasta, tallerId,
  );
  const cuentas: FilaBalance[] = filas.map((f) => {
    const inicial = f.ini_d - f.ini_h;
    const final = inicial + f.per_d - f.per_h;
    const esperado = f.naturaleza === 'deudora' ? final >= 0 : final <= 0;
    return {
      cuenta_id: f.id, codigo: f.codigo, nombre: f.nombre, tipo: f.tipo, naturaleza: f.naturaleza, rol: f.rol, inicial, debe: f.per_d, haber: f.per_h, final,
      alerta: final !== 0 && !esperado && !(f.rol && SALDO_LIBRE.has(f.rol)) ? `Saldo ${final > 0 ? 'deudor' : 'acreedor'} en una cuenta de naturaleza ${f.naturaleza}` : null,
    };
  });
  const t = cuentas.reduce(
    (a, c) => ({
      inicialD: a.inicialD + Math.max(0, c.inicial), inicialH: a.inicialH + Math.max(0, -c.inicial), debe: a.debe + c.debe, haber: a.haber + c.haber,
      finalD: a.finalD + Math.max(0, c.final), finalH: a.finalH + Math.max(0, -c.final),
    }),
    { inicialD: 0, inicialH: 0, debe: 0, haber: 0, finalD: 0, finalH: 0 },
  );
  const inconsistencias: string[] = [];
  if (t.debe !== t.haber) inconsistencias.push(`Los débitos (${t.debe / 100}) y los créditos (${t.haber / 100}) del período no coinciden: hay asientos desbalanceados`);
  if (t.inicialD !== t.inicialH) inconsistencias.push(`Los saldos iniciales deudores y acreedores difieren en ${Math.abs(t.inicialD - t.inicialH) / 100}`);
  if (t.finalD !== t.finalH) inconsistencias.push(`Los saldos finales deudores y acreedores difieren en ${Math.abs(t.finalD - t.finalH) / 100}`);
  for (const c of cuentas) if (c.alerta) inconsistencias.push(`${c.codigo} ${c.nombre}: ${c.alerta}`);
  return { desde, hasta, cuentas, totales: t, cuadra: t.debe === t.haber && t.inicialD === t.inicialH && t.finalD === t.finalH, inconsistencias };
}

export interface LineaResultado {
  clave: string;
  titulo: string;
  monto: number;
  tipo: 'detalle' | 'subtotal' | 'total';
  ayuda?: string;
}

/**
 * Estado de resultados económico (base devengado) del período. Distinto del flujo de caja: una venta a crédito cuenta cuando se emite aunque no se cobre
 * y una compra de mercadería no es un gasto hasta que se vende.
 */
export async function estadoResultados(db: D1Database, tallerId: string, desde: string, hasta: string, conMargenes: boolean) {
  const filas = await all<{ id: string; codigo: string; nombre: string; tipo: string; padre_id: string | null; rol: string | null; debe: number; haber: number }>(
    db,
    `SELECT c.id, c.codigo, c.nombre, c.tipo, c.padre_id, c.rol, COALESCE(m.debe, 0) AS debe, COALESCE(m.haber, 0) AS haber
       FROM cuentas_contables c
       LEFT JOIN (SELECT l.cuenta_id, SUM(l.debe) AS debe, SUM(l.haber) AS haber FROM asiento_lineas l JOIN asientos a ON a.taller_id = l.taller_id AND a.id = l.asiento_id
                   WHERE l.taller_id = ? AND ${CONTABILIZADO} AND a.fecha BETWEEN ? AND ? GROUP BY l.cuenta_id) m ON m.cuenta_id = c.id
      WHERE c.taller_id = ? AND c.imputable = 1 AND c.tipo IN ('ingreso','costo','gasto') ORDER BY c.codigo`,
    tallerId, desde, hasta, tallerId,
  );
  // Aporte de cada cuenta al resultado: ingresos suman (Haber − Debe); costos y gastos restan (Debe − Haber).
  const aporte = (f: (typeof filas)[number]) => (f.tipo === 'ingreso' ? f.haber - f.debe : f.debe - f.haber);
  const cuentas = filas.map((f) => ({ ...f, monto: aporte(f) })).filter((f) => f.monto !== 0 || f.debe + f.haber > 0);
  const r = (rol: string) => cuentas.find((c) => c.rol === rol)?.monto ?? 0;
  const suma = (tipo: string, excluir: string[] = []) => cuentas.filter((c) => c.tipo === tipo && !(c.rol && excluir.includes(c.rol))).reduce((a, c) => a + c.monto, 0);

  // Las cuentas regularizadoras (devoluciones) ya aportan en negativo: se suman.
  const ventasRep = r('ventas_repuestos') + r('devol_repuestos');
  const serviciosNetos = r('ventas_servicios') + r('devol_servicios');
  const otrosIngresos = suma('ingreso', ['ventas_repuestos', 'ventas_servicios', 'devol_repuestos', 'devol_servicios']);
  const ventasNetas = ventasRep + serviciosNetos;
  const costoRep = r('costo_repuestos');
  const costoMO = r('costo_mano_obra');
  const otrosCostos = suma('costo', ['costo_repuestos', 'costo_mano_obra']);
  const gastos = suma('gasto');
  const resultadoBruto = ventasNetas - costoRep - costoMO - otrosCostos;
  const resultado = resultadoBruto + otrosIngresos - gastos;

  // Información de gestión: costo de mano de obra imputado a las órdenes facturadas en el período (cronómetro / estimación). No se suma al resultado.
  let manoObra: Record<string, unknown> | null = null;
  if (conMargenes) {
    const ots = await all<{ orden_id: string }>(
      db, "SELECT DISTINCT orden_id FROM ventas WHERE taller_id = ? AND estado = 'emitida' AND orden_id IS NOT NULL AND fecha BETWEEN ? AND ? LIMIT 400", tallerId, desde, hasta,
    );
    if (ots.length) {
      const mapa = new Map<string, Awaited<ReturnType<typeof rentabilidadOrdenes>> extends Map<string, infer R> ? R : never>();
      for (const l of lotes(ots.map((o) => o.orden_id))) for (const [k, v] of await rentabilidadOrdenes(db, tallerId, l)) mapa.set(k, v);
      const rs = [...mapa.values()];
      const completas = rs.filter((x) => x.mo_base === 'real' || x.mo_base === 'sin_mano_obra').length;
      manoObra = {
        ordenes: rs.length,
        mano_obra_cobrada: rs.reduce((a, x) => a + x.mo_cobrada, 0),
        costo_imputado: rs.reduce((a, x) => a + x.mo_costo, 0),
        ordenes_con_costo_real: rs.filter((x) => x.mo_base === 'real').length,
        ordenes_estimadas: rs.filter((x) => x.mo_base === 'estimado').length,
        ordenes_parciales: rs.filter((x) => x.mo_base === 'parcial').length,
        calidad: completas === rs.length ? 'definitivo' : rs.some((x) => x.mo_base === 'parcial') ? 'parcial' : 'estimado',
        faltantes: [...new Set(rs.flatMap((x) => x.faltantes))].slice(0, 6),
      };
    }
  }

  // Calidad del resultado: qué le falta para ser una cifra completa.
  const motivos: string[] = [];
  const incompletos = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM asientos a WHERE a.taller_id = ? AND a.estado = 'registrado' AND a.costo_incompleto = 1 AND a.evento = 'alta' AND a.fecha BETWEEN ? AND ?`,
    tallerId, desde, hasta,
  );
  if (incompletos?.n) motivos.push(`${incompletos.n} operación(es) del período no tienen costo histórico de repuestos (comprobantes anteriores al registro del costo): el costo de ventas está incompleto`);
  // Ventas sin costo histórico: se puede estimar con el costo actual, pero NUNCA se suma al resultado contable.
  const faltante = await first<{ n: number; costo: number }>(
    db,
    `SELECT COUNT(*) AS n, COALESCE(SUM(ROUND(vi.cantidad * a.costo)), 0) AS costo FROM venta_items vi
       JOIN ventas v ON v.taller_id = vi.taller_id AND v.id = vi.venta_id JOIN articulos a ON a.taller_id = vi.taller_id AND a.id = vi.articulo_id
      WHERE v.taller_id = ? AND v.estado = 'emitida' AND v.fecha BETWEEN ? AND ? AND vi.tipo = 'articulo' AND vi.costo_unitario IS NULL`,
    tallerId, desde, hasta,
  );
  const estimacion = faltante?.n ? { renglones: faltante.n, costo_estimado: faltante.costo, resultado_con_estimacion: resultado - faltante.costo } : null;
  const pend = await pendientesContabilizar(db, tallerId);
  if (pend.pendientes > 0) motivos.push(`${pend.pendientes} operación(es) todavía no se contabilizaron`);
  if (pend.errores > 0) motivos.push(`${pend.errores} operación(es) no se pudieron contabilizar porque sus importes no cierran (ver Controles)`);
  if (manoObra && manoObra.calidad !== 'definitivo') motivos.push('El costo de mano de obra imputado a las órdenes es estimado o parcial (información de gestión, no se suma al resultado)');

  const lineas: LineaResultado[] = [
    { clave: 'ventas_repuestos', titulo: 'Ventas de repuestos (netas de devoluciones)', monto: ventasRep, tipo: 'detalle' },
    { clave: 'ventas_servicios', titulo: 'Ingresos por servicios y mano de obra (netos de devoluciones)', monto: serviciosNetos, tipo: 'detalle' },
    { clave: 'ventas_netas', titulo: 'Ventas netas', monto: ventasNetas, tipo: 'subtotal', ayuda: 'Lo vendido en el período, se haya cobrado o no, sin IVA y sin las devoluciones.' },
    { clave: 'costo_repuestos', titulo: 'Costo de repuestos vendidos', monto: -costoRep, tipo: 'detalle', ayuda: 'Costo histórico con el que se vendió cada repuesto (no el costo de hoy).' },
    { clave: 'costo_mano_obra', titulo: 'Costo de mano de obra (sueldos y jornales registrados)', monto: -costoMO, tipo: 'detalle', ayuda: 'Lo efectivamente registrado como sueldos y jornales. No es una liquidación de sueldos.' },
    ...(otrosCostos ? [{ clave: 'otros_costos', titulo: 'Otros costos', monto: -otrosCostos, tipo: 'detalle' as const }] : []),
    { clave: 'resultado_bruto', titulo: 'Resultado bruto', monto: resultadoBruto, tipo: 'subtotal' },
    { clave: 'gastos', titulo: 'Gastos operativos, financieros y comerciales', monto: -gastos, tipo: 'detalle' },
    ...(otrosIngresos ? [{ clave: 'otros_ingresos', titulo: 'Otros ingresos', monto: otrosIngresos, tipo: 'detalle' as const }] : []),
    { clave: 'resultado', titulo: 'RESULTADO ECONÓMICO DEL PERÍODO', monto: resultado, tipo: 'total', ayuda: 'Base devengado: no es lo mismo que el dinero que entró o salió (flujo de caja).' },
  ];
  return {
    desde, hasta, lineas, cuentas, ventas_netas: ventasNetas, resultado_bruto: resultadoBruto, gastos, resultado,
    calidad: motivos.length ? 'parcial' : 'definitivo', motivos, estimacion_costo_faltante: estimacion, mano_obra: manoObra,
  };
}

/** Flujo de caja del período (dinero que entró y salió): se muestra junto al resultado económico para que no se confundan. */
export async function flujoDeCaja(db: D1Database, tallerId: string, desde: string, hasta: string) {
  const [rubros, banco] = await Promise.all([
    all<{ rubro: string; neto: number }>(
      db, `SELECT rubro, SUM(CASE tipo WHEN 'ingreso' THEN importe ELSE -importe END) AS neto FROM caja_movimientos WHERE taller_id = ? AND fecha BETWEEN ? AND ? AND rubro NOT IN ('traspaso','persona') GROUP BY rubro`, tallerId, desde, hasta,
    ),
    first<{ ingresos: number; egresos: number }>(
      db,
      `SELECT COALESCE(SUM(CASE WHEN m.tipo = 'ingreso' THEN m.importe END), 0) AS ingresos, COALESCE(SUM(CASE WHEN m.tipo = 'egreso' THEN m.importe END), 0) AS egresos
         FROM banco_movimientos m JOIN cuentas_bancarias cb ON cb.taller_id = m.taller_id AND cb.id = m.cuenta_id
        WHERE m.taller_id = ? AND m.fecha BETWEEN ? AND ? AND m.afecta_resultado = 1 AND cb.moneda = 'ARS'`,
      tallerId, desde, hasta,
    ),
  ]);
  const n = (r: string) => rubros.find((x) => x.rubro === r)?.neto ?? 0;
  const entradas = n('cobro') + n('otro_ingreso') + (banco?.ingresos ?? 0);
  const salidas = -(n('pago_proveedor') + n('gasto') + n('devolucion')) + (banco?.egresos ?? 0);
  return { cobrado: n('cobro'), otros_ingresos: n('otro_ingreso') + (banco?.ingresos ?? 0), pagado_proveedores: -n('pago_proveedor'), gastos: -n('gasto'), reintegros: -n('devolucion'), otros_egresos: banco?.egresos ?? 0, entradas, salidas, neto: entradas - salidas };
}

export interface Pendientes {
  pendientes: number;
  errores: number;
  sin_efecto: number;
}

/** Documentos que todavía no tienen asiento (se calcula contra las fuentes). */
export async function pendientesContabilizar(db: D1Database, tallerId: string): Promise<Pendientes> {
  const altas = new Map((await all<{ origen_tipo: string; n: number }>(db, "SELECT origen_tipo, COUNT(*) AS n FROM asientos WHERE taller_id = ? AND evento = 'alta' GROUP BY origen_tipo", tallerId)).map((r) => [r.origen_tipo, r.n]));
  const omit = await all<{ origen_tipo: string; tipo: string; n: number }>(db, "SELECT origen_tipo, tipo, COUNT(*) AS n FROM contab_omitidos WHERE taller_id = ? AND evento = 'alta' GROUP BY origen_tipo, tipo", tallerId);
  let pendientes = 0;
  for (const f of FUENTES) {
    const docs = (await first<{ docs: number }>(db, f.cobertura.sql, tallerId))?.docs ?? 0;
    const o = (t: string) => omit.find((x) => x.origen_tipo === f.tipo && x.tipo === t)?.n ?? 0;
    pendientes += Math.max(0, docs - (altas.get(f.tipo) ?? 0) - o('sin_efecto') - o('error'));
  }
  return { pendientes, errores: omit.filter((o) => o.tipo === 'error').reduce((a, o) => a + o.n, 0), sin_efecto: omit.filter((o) => o.tipo === 'sin_efecto').reduce((a, o) => a + o.n, 0) };
}
