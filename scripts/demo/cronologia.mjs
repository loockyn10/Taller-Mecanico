// Cronología: reubica cada jornada generada en su fecha real simulada.
//
// Por qué existe: la API no permite fechar en el pasado las OT, los comprobantes de OT ni sus cobros (usan siempre "ahora"). El generador
// opera por la API real (con todas sus validaciones) en tiempo real, una jornada tras otra, y este paso mueve las fechas de cada jornada
// al día que le corresponde. Sólo se ejecutan UPDATE de columnas de fecha / hora del taller indicado: no se crean, borran ni
// cambian importes, estados, vínculos ni cantidades. El SQL resultante se puede leer y auditar antes de aplicarlo.
import fs from 'node:fs';
import path from 'node:path';
import { diasEntre, hoyAR } from './util.mjs';

const MARCA_PENDIENTE = '[DEMO·sin fechar]';
const TRAMO_HORARIO_S = 9.5 * 3600; // la jornada simulada transcurre entre las 08:30 y las 18:00 (hora argentina)
const INICIO_UTC = '11:30:00.000Z'; // 08:30 en UTC-3

// tabla: columnas de hora (ts) y de fecha (dt); `ref` = columna de hora que determina a qué jornada pertenece la fila para las fechas.
const TABLAS = [
  { t: 'usuarios', ts: ['created_at'] },
  { t: 'licencia_eventos', ts: ['created_at'] },
  { t: 'taller_config', ts: ['updated_at'], pk: 'taller_id' },
  { t: 'mecanicos', ts: ['created_at'] },
  { t: 'clientes', ts: ['created_at', 'updated_at'] },
  { t: 'vehiculos', ts: ['created_at', 'updated_at'] },
  { t: 'categorias_servicio', ts: [] },
  { t: 'servicios', ts: ['created_at'] },
  { t: 'proveedores', ts: ['created_at'] },
  { t: 'articulos', ts: ['created_at', 'updated_at'] },
  { t: 'stock_movimientos', ts: ['created_at'] },
  { t: 'presupuestos', ts: ['created_at', 'updated_at'], dt: ['fecha', 'valido_hasta'] },
  { t: 'ordenes', ts: ['fecha_ingreso', 'fecha_lista', 'fecha_entregada', 'created_at', 'updated_at'], dt: ['fecha_prometida'] },
  { t: 'orden_eventos', ts: ['created_at'] },
  { t: 'checklists', ts: ['created_at', 'updated_at'] },
  { t: 'turnos', ts: ['created_at'], dt: ['fecha'] },
  { t: 'ventas', ts: ['created_at'], dt: ['fecha'] },
  { t: 'cobros', ts: ['created_at'], dt: ['fecha'] },
  { t: 'compras', ts: ['created_at'], dt: ['fecha', 'vencimiento'] },
  { t: 'pagos_proveedor', ts: ['created_at'], dt: ['fecha'] },
  { t: 'gastos', ts: ['created_at'], dt: ['fecha', 'recurrente_fecha'] },
  { t: 'gastos_recurrentes', ts: ['created_at'] },
  { t: 'caja_sesiones', ts: ['abierta_at', 'cerrada_at'], dt: ['fecha'], ref: 'abierta_at' },
  { t: 'caja_arqueos', ts: ['created_at'] },
  { t: 'caja_movimientos', ts: ['created_at'], dt: ['fecha'] },
  { t: 'cuentas_bancarias', ts: ['created_at'], dt: ['fecha_saldo_inicial'] },
  { t: 'banco_movimientos', ts: ['created_at', 'conciliado_at'], dt: ['fecha'] },
  { t: 'conciliaciones', ts: ['created_at', 'deshecha_at'], dt: ['fecha_corte'] },
  { t: 'cheques', ts: ['created_at', 'updated_at'], dt: ['fecha_emision', 'fecha_pago', 'fecha_vencimiento'] },
  { t: 'cheque_eventos', ts: ['created_at'], dt: ['fecha'] },
  { t: 'ordenes_compra', ts: ['created_at', 'updated_at'], dt: ['fecha', 'fecha_prevista'] },
  { t: 'recepciones', ts: ['created_at'], dt: ['fecha'] },
  { t: 'facturas_proveedor', ts: ['created_at'], dt: ['fecha', 'vencimiento'] },
  { t: 'conteos', ts: ['created_at', 'aplicado_at'], dt: ['fecha'] },
  { t: 'articulo_costos', ts: ['created_at'] },
  { t: 'auditoria', ts: ['created_at'] },
  { t: 'listas_precios', ts: ['created_at', 'updated_at'] },
  { t: 'lista_precio_items', ts: ['updated_at'] },
].filter((x) => x.ts.length || x.dt?.length);

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Ventanas de tiempo real de cada jornada, con sus límites en el punto medio de la pausa entre jornadas. */
export function ventanas(m, plan) {
  const v = [...m.ventanas].sort((a, b) => (a.dia === null ? -1 : b.dia === null ? 1 : a.dia - b.dia));
  const out = [];
  v.forEach((w, i) => {
    const t0 = Date.parse(w.t0), t1 = Date.parse(w.t1);
    const prev = v[i - 1];
    const b0 = prev ? (Date.parse(prev.t1) + t0) / 2 : Date.parse('2000-01-01T00:00:00Z');
    const sig = v[i + 1];
    const b1 = sig ? (t1 + Date.parse(sig.t0)) / 2 : Date.parse('2999-01-01T00:00:00Z');
    const simDia = w.dia === null ? w.simDia : plan.fechas[w.dia];
    out.push({ dia: w.dia, simDia, t0, t1, b0, b1, off: diasEntre(hoyAR(t0), simDia), k: TRAMO_HORARIO_S / Math.max(1, (t1 - t0) / 1000) });
  });
  return out;
}

export function construirCronologia({ m, plan }) {
  const tallerId = m.taller.id;
  const W = ventanas(m, plan);
  const aMover = W.slice(0, -1); // la jornada de hoy ya está en su fecha real
  const iso = (ms) => new Date(ms).toISOString();
  const L = [];
  L.push(`-- Cronología de la demostración · taller ${tallerId} (${m.taller.nombre})`);
  L.push(`-- Generado ${new Date().toISOString()} · ${aMover.length} jornadas a reubicar (la de hoy no se modifica).`);
  L.push('-- Sólo UPDATE de columnas de fecha y hora de este taller. No cambia importes, estados, vínculos ni cantidades.');
  L.push('');
  L.push(`-- Aborta si la cronología ya fue aplicada (no quedan jornadas "sin fechar").`);
  L.push(`INSERT INTO tx_guard (ok) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM caja_sesiones WHERE taller_id = ${q(tallerId)} AND notas_apertura LIKE ${q(MARCA_PENDIENTE + '%')});`);
  L.push('DROP TABLE IF EXISTS _demo_w;');
  L.push('CREATE TABLE _demo_w (dia TEXT, b0 TEXT, b1 TEXT, t0 TEXT, sim_start TEXT, k REAL, off INTEGER);');
  for (const w of aMover) {
    L.push(`INSERT INTO _demo_w VALUES (${q(w.simDia)}, ${q(iso(w.b0))}, ${q(iso(w.b1))}, ${q(iso(w.t0))}, ${q(`${w.simDia}T${INICIO_UTC}`)}, ${w.k.toFixed(6)}, ${w.off});`);
  }
  L.push('');
  const ts = (col) => `COALESCE((SELECT strftime('%Y-%m-%dT%H:%M:%fZ', w.sim_start, printf('%+.3f seconds', (julianday(t.${col}) - julianday(w.t0)) * 86400.0 * w.k)) FROM _demo_w w WHERE t.${col} >= w.b0 AND t.${col} < w.b1), t.${col})`;
  const dt = (col, ref) => `COALESCE((SELECT date(t.${col}, w.off || ' days') FROM _demo_w w WHERE t.${ref} >= w.b0 AND t.${ref} < w.b1), t.${col})`;
  for (const T of TABLAS) {
    const ref = T.ref ?? 'created_at';
    const sets = [...(T.ts ?? []).map((c) => `${c} = ${ts(c)}`), ...(T.dt ?? []).map((c) => `${c} = ${dt(c, ref)}`)];
    L.push(`UPDATE ${T.t} AS t SET ${sets.join(', ')} WHERE t.${T.pk ?? 'taller_id'} = ${q(tallerId)};`);
  }
  L.push(`UPDATE talleres AS t SET created_at = ${ts('created_at')} WHERE t.id = ${q(tallerId)};`);
  L.push('');
  L.push(`UPDATE caja_sesiones SET notas_apertura = 'Jornada del ' || strftime('%d/%m/%Y', fecha) WHERE taller_id = ${q(tallerId)} AND notas_apertura LIKE ${q(MARCA_PENDIENTE + '%')};`);
  L.push('DROP TABLE _demo_w;');
  return { sql: L.join('\n') + '\n', jornadas: aMover.length, ventanas: W };
}

export function guardarSql(carpeta, nombre, sql) {
  fs.mkdirSync(carpeta, { recursive: true });
  const archivo = path.join(carpeta, nombre);
  fs.writeFileSync(archivo, sql, 'utf8');
  return archivo;
}

export const MARCA_SIN_FECHAR = MARCA_PENDIENTE;
