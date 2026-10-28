// Herramientas de respaldo y exportación de Fierro (sin dependencias: SQLite de Node).
//
// Distinguimos CUATRO cosas que no deben mezclarse (ver docs/RESPALDOS.md):
//   1. Respaldo de TODA la plataforma  → un .sql de la D1 completa (todos los talleres, hashes de contraseñas, sesiones). Es del OPERADOR, jamás de un cliente.
//   2. Exportación de los datos de UN taller → datos del taller sin secretos y sin una sola fila de otro taller. Es lo único que puede recibir un propietario.
//   3. Restauración ante un incidente → Time Travel de Cloudflare (todo o nada, de TODA la base) o el .sql del punto 1 en una base nueva.
//   4. Migración hacia otra instalación → el .sql del punto 1 aplicado a una base vacía con las migraciones al día, o la exportación del punto 2.
//
// Este módulo implementa la verificación del respaldo (ensayo de restauración en memoria) y la exportación de un taller. NO restaura nada por su cuenta.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  /* Node sin node:sqlite */
}
export const haySqlite = () => !!DatabaseSync;

/** Tablas que NUNCA salen en la exportación de un taller: son de la plataforma o guardan secretos. */
export const TABLAS_EXCLUIDAS = new Map([
  ['sesiones', 'sesiones iniciadas (secretos)'],
  ['invitaciones_activacion', 'invitaciones de la plataforma (secretos)'],
  ['dispositivos_reloj', 'dispositivos de reloj: tokens (hay que vincularlos de nuevo)'],
  ['limites_intentos', 'contadores internos de bloqueo'],
  ['d1_migrations', 'control de migraciones de la plataforma'],
  ['tx_guard', 'tabla técnica de control de transacciones'],
  ['plataforma_latidos', 'latidos de procesos de la plataforma'],
  ['eventos_seguridad', 'eventos de seguridad de la plataforma'],
  ['errores_worker', 'errores técnicos de la plataforma'],
  ['contab_cola', 'cola interna de contabilización (se regenera con la reconciliación)'],
  ['cat_marcas', 'catálogo automotor público y compartido (no es de ningún taller; se recarga con npm run catalogo)'],
  ['cat_modelos', 'catálogo automotor público y compartido'],
  ['cat_versiones', 'catálogo automotor público y compartido'],
  ['cat_fichas', 'catálogo automotor público y compartido'],
  ['cat_meta', 'catálogo automotor público y compartido'],
]);

/** Columnas que se quitan de las tablas que sí salen (credenciales). */
export const COLUMNAS_SECRETAS = new Map([['usuarios', ['password_hash', 'pin_hash', 'pin_intentos', 'pin_bloqueado_hasta', 'pin_actualizado_at']]]);

const ident = (n) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) throw new Error(`Nombre de tabla o columna no permitido: ${n}`);
  return `"${n}"`;
};

export function sha256Archivo(archivo) {
  return crypto.createHash('sha256').update(fs.readFileSync(archivo)).digest('hex');
}

/** Carga un respaldo .sql en una base en memoria (ensayo de restauración: no toca ninguna base real). */
export function cargarRespaldo(archivo) {
  if (!DatabaseSync) throw new Error('Este Node no incluye node:sqlite (usá Node 22.5 o superior)');
  const sql = fs.readFileSync(archivo, 'utf8');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = OFF'); // el volcado trae las tablas en cualquier orden; las claves foráneas se revisan después
  db.exec(sql);
  return db;
}

export const tablasDe = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all().map((r) => r.name);
const columnasDe = (db, tabla) => db.prepare(`PRAGMA table_info(${ident(tabla)})`).all().map((c) => c.name);

/** Revisa que un respaldo sea restaurable y devuelve un resumen. */
export function verificarRespaldo(db, { migracionesDelProyecto = [] } = {}) {
  const tablas = tablasDe(db).map((t) => ({ tabla: t, filas: db.prepare(`SELECT COUNT(*) AS n FROM ${ident(t)}`).get().n }));
  const integridad = db.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]);
  const claves = db.prepare('PRAGMA foreign_key_check').all();
  const aplicadas = tablas.some((t) => t.tabla === 'd1_migrations') ? db.prepare('SELECT name FROM d1_migrations ORDER BY id').all().map((r) => r.name) : [];
  const pendientes = migracionesDelProyecto.filter((m) => !aplicadas.includes(m));
  const talleres = tablas.some((t) => t.tabla === 'talleres') ? db.prepare('SELECT id, nombre FROM talleres ORDER BY nombre').all() : [];
  return {
    integridadOk: integridad.length === 1 && integridad[0] === 'ok',
    integridad,
    violacionesClaves: claves.length,
    tablas,
    totalFilas: tablas.reduce((a, t) => a + t.filas, 0),
    migracionesAplicadas: aplicadas,
    migracionesPendientes: pendientes,
    talleres,
  };
}

/**
 * Datos de UN taller, listos para entregar: cada tabla con `taller_id` filtrada por ese taller, la fila del propio taller, sin tablas ni columnas secretas.
 * Falla si encuentra una fila de otro taller (no debería ser posible: se comprueba igual).
 */
export function exportarTaller(db, tallerId) {
  const taller = db.prepare('SELECT * FROM talleres WHERE id = ?').get(tallerId);
  if (!taller) throw new Error('El taller no existe en el respaldo');
  const datos = {};
  const omitidas = [];
  const sinTaller = [];
  for (const t of tablasDe(db)) {
    if (TABLAS_EXCLUIDAS.has(t)) {
      omitidas.push({ tabla: t, motivo: TABLAS_EXCLUIDAS.get(t) });
      continue;
    }
    if (t === 'talleres') {
      datos.talleres = [{ ...taller }];
      continue;
    }
    const cols = columnasDe(db, t);
    if (!cols.includes('taller_id')) {
      // Una tabla nueva sin taller_id no se exporta hasta que alguien decida qué hacer con ella: mejor omitir que filtrar a ciegas.
      sinTaller.push(t);
      omitidas.push({ tabla: t, motivo: 'no tiene taller_id: no se puede garantizar que sea solo de este taller' });
      continue;
    }
    const secretas = COLUMNAS_SECRETAS.get(t) ?? [];
    const visibles = cols.filter((c) => !secretas.includes(c));
    const seleccion = `SELECT ${visibles.map(ident).join(', ')} FROM ${ident(t)} WHERE taller_id = ?`;
    let filas;
    try {
      filas = db.prepare(`${seleccion} ORDER BY rowid`).all(tallerId);
    } catch {
      filas = db.prepare(seleccion).all(tallerId); // tabla WITHOUT ROWID
    }
    if (filas.some((f) => f.taller_id !== tallerId)) throw new Error(`La tabla ${t} devolvió filas de otro taller: se aborta la exportación`);
    datos[t] = filas.map((f) => ({ ...f }));
  }
  return {
    taller: { id: taller.id, nombre: taller.nombre },
    datos,
    omitidas,
    sinTaller,
    columnasQuitadas: Object.fromEntries(COLUMNAS_SECRETAS),
    resumen: Object.entries(datos).map(([tabla, filas]) => ({ tabla, filas: filas.length })).filter((x) => x.filas > 0),
  };
}

const csvCelda = (v) => {
  if (v == null) return '';
  const s = String(v);
  // Evita que una planilla interprete el texto como fórmula.
  const seguro = /^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
  return /[",\n\r;]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
};
export function aCsv(filas) {
  if (!filas.length) return '';
  const cols = Object.keys(filas[0]);
  return `﻿${[cols.join(','), ...filas.map((f) => cols.map((c) => csvCelda(f[c])).join(','))].join('\r\n')}\r\n`;
}

/** Escribe la exportación de un taller en una carpeta nueva: un JSON y un CSV por tabla con datos, el manifiesto y un LEEME. */
export function escribirExportacion(exp, carpeta, { origenSha256 = null } = {}) {
  if (fs.existsSync(carpeta) && fs.readdirSync(carpeta).length) throw new Error(`La carpeta ${carpeta} ya existe y no está vacía: no se pisa nada`);
  fs.mkdirSync(path.join(carpeta, 'tablas'), { recursive: true });
  const archivos = [];
  for (const [tabla, filas] of Object.entries(exp.datos)) {
    if (!filas.length) continue;
    fs.writeFileSync(path.join(carpeta, 'tablas', `${tabla}.json`), JSON.stringify(filas, null, 1));
    fs.writeFileSync(path.join(carpeta, 'tablas', `${tabla}.csv`), aCsv(filas));
    archivos.push(`${tabla}.json`, `${tabla}.csv`);
  }
  const manifiesto = {
    generado: new Date().toISOString(),
    taller: exp.taller,
    origenSha256,
    tablas: exp.resumen,
    totalFilas: exp.resumen.reduce((a, t) => a + t.filas, 0),
    tablasOmitidas: exp.omitidas,
    columnasQuitadas: exp.columnasQuitadas,
    importes: 'Todos los importes están en centavos (enteros).',
  };
  fs.writeFileSync(path.join(carpeta, 'manifiesto.json'), JSON.stringify(manifiesto, null, 2));
  fs.writeFileSync(
    path.join(carpeta, 'LEEME.txt'),
    [
      `Exportación de datos de «${exp.taller.nombre}» (Fierro)`,
      `Generada: ${manifiesto.generado}`,
      '',
      'Contiene SOLO los datos de este taller. No incluye contraseñas, PIN, sesiones, tokens de dispositivos ni datos de otros talleres.',
      'Cada tabla está en JSON (para otro sistema) y en CSV (para abrir con Excel). Los importes están en centavos.',
      'Los usuarios se exportan sin credenciales: en una instalación nueva deben crear una contraseña nueva.',
      'Este archivo NO es un respaldo restaurable: sirve para consultar, auditar o migrar los datos a otro sistema.',
    ].join('\r\n'),
  );
  return { carpeta, archivos: archivos.length, manifiesto };
}

// ───────────────────────── Ensayo de migraciones ─────────────────────────
/** Huella del contenido de cada tabla (filas + SHA-256) usando solo las columnas indicadas (o todas). */
export function huellasTablas(db, columnasPorTabla = null) {
  const res = {};
  for (const t of tablasDe(db)) {
    const todas = columnasDe(db, t);
    const cols = columnasPorTabla ? (columnasPorTabla[t] ?? null) : todas;
    if (!cols) continue; // tabla nueva: no existía antes
    const sel = `SELECT ${cols.map(ident).join(', ')} FROM ${ident(t)}`;
    let filas;
    try {
      filas = db.prepare(`${sel} ORDER BY rowid`).all();
    } catch {
      filas = db.prepare(sel).all();
    }
    res[t] = { columnas: cols, filas: filas.length, hash: crypto.createHash('sha256').update(JSON.stringify(filas)).digest('hex') };
  }
  return res;
}

/**
 * Aplica las migraciones pendientes sobre la copia en memoria de un respaldo y demuestra que NO tocaron los datos que ya existían:
 * mismas filas y mismo contenido en las columnas previas de cada tabla, base íntegra y sin claves foráneas rotas.
 * Como D1, aplica cada archivo dentro de una transacción y con las claves foráneas ACTIVAS (el volcado se carga con ellas apagadas, pero producción no).
 * `pendientes` = [{ name, sql }] en orden. No toca ninguna base real.
 * `quitadasPermitidas` = ['tabla.columna', ...]: columnas que una migración elimina a propósito (por ejemplo al reconstruir una tabla). Si falta alguna de las
 * columnas previas que NO está en esa lista, el ensayo falla; las permitidas se comparan por las columnas que se conservan y se informan aparte.
 */
export function ensayarMigraciones(db, pendientes, { quitadasPermitidas = [] } = {}) {
  const antes = huellasTablas(db);
  const columnasAntes = Object.fromEntries(Object.entries(antes).map(([t, h]) => [t, h.columnas]));
  // Contenido previo de cada tabla (para poder compararlo por las columnas que se conservan si una migración quita alguna a propósito).
  const filasAntes = Object.fromEntries(
    Object.entries(columnasAntes).map(([t, cols]) => {
      const sel = `SELECT ${cols.map(ident).join(', ')} FROM ${ident(t)}`;
      let filas;
      try {
        filas = db.prepare(`${sel} ORDER BY rowid`).all();
      } catch {
        filas = db.prepare(sel).all();
      }
      return [t, filas.map((f) => ({ ...f }))];
    }),
  );
  const errores = [];
  const aplicadas = [];
  db.exec('PRAGMA foreign_keys = ON');
  for (const m of pendientes) {
    try {
      db.exec('BEGIN');
      db.exec(m.sql);
      db.exec('COMMIT');
      aplicadas.push(m.name);
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ya revertida */
      }
      errores.push(`${m.name}: ${e.message}`);
      break;
    }
  }
  const quitadas = [];
  const comparables = {};
  for (const [t, cols] of Object.entries(columnasAntes)) {
    if (!tablasDe(db).includes(t)) continue;
    const ahora = columnasDe(db, t);
    for (const c of cols) if (!ahora.includes(c)) quitadas.push(`${t}.${c}`);
    comparables[t] = cols.filter((c) => ahora.includes(c));
  }
  const despues = huellasTablas(db, comparables);
  const hash = (filas) => crypto.createHash('sha256').update(JSON.stringify(filas)).digest('hex');
  const cambios = [];
  for (const [t, a] of Object.entries(antes)) {
    const d = despues[t];
    if (!d) cambios.push({ tabla: t, motivo: 'la tabla desapareció' });
    else {
      const previo = comparables[t].length === a.columnas.length ? a : { filas: filasAntes[t].length, hash: hash(filasAntes[t].map((f) => Object.fromEntries(comparables[t].map((c) => [c, f[c]])))) };
      if (previo.filas !== d.filas || previo.hash !== d.hash) cambios.push({ tabla: t, motivo: `cambió el contenido (${previo.filas} → ${d.filas} filas)` });
    }
  }
  const noPermitidas = quitadas.filter((c) => !quitadasPermitidas.includes(c));
  for (const c of noPermitidas) cambios.push({ tabla: c.split('.')[0], motivo: `desapareció la columna ${c.split('.')[1]}` });
  const nuevas = tablasDe(db).filter((t) => !antes[t]);
  const columnasNuevas = Object.entries(antes)
    .filter(([t]) => tablasDe(db).includes(t))
    .map(([t, a]) => ({ tabla: t, columnas: columnasDe(db, t).filter((c) => !a.columnas.includes(c)) }))
    .filter((x) => x.columnas.length);
  const integridad = db.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]);
  const claves = db.prepare('PRAGMA foreign_key_check').all().length;
  return {
    aplicadas, errores, cambios, nuevas, columnasNuevas,
    columnasQuitadas: quitadas.filter((c) => quitadasPermitidas.includes(c)),
    integridadOk: integridad.length === 1 && integridad[0] === 'ok', violacionesClaves: claves,
    ok: !errores.length && !cambios.length && integridad[0] === 'ok' && claves === 0,
    filasComparadas: Object.values(antes).reduce((a, h) => a + h.filas, 0),
    tablasComparadas: Object.keys(antes).length,
  };
}

// ───────────────────────── Controles contables sobre un respaldo ─────────────────────────
/**
 * Comprueba que la contabilidad de un respaldo sigue cerrando: partida doble de cada asiento, numeración correlativa sin saltos por taller, ningún
 * asiento registrado sin líneas, ningún documento con dos asientos del mismo evento y cada asiento revertido con su contra-asiento. Sólo lee.
 * Devuelve `{ ok, controles, porTaller }`; en un respaldo anterior a la contabilidad (sin la tabla) devuelve `{ aplica: false }`.
 */
export function controlesContables(db) {
  const tablas = new Set(tablasDe(db));
  if (!tablas.has('asientos') || !tablas.has('asiento_lineas')) return { aplica: false, ok: true, controles: [], porTaller: [] };
  const n = (sql) => db.prepare(sql).get().n;
  const controles = [
    { clave: 'partida_doble', nombre: 'Asientos registrados que no balancean (Debe ≠ Haber)', valor: n("SELECT COUNT(*) AS n FROM (SELECT a.id FROM asientos a JOIN asiento_lineas l ON l.taller_id = a.taller_id AND l.asiento_id = a.id WHERE a.estado <> 'borrador' GROUP BY a.id HAVING SUM(l.debe) <> SUM(l.haber))") },
    { clave: 'sin_lineas', nombre: 'Asientos registrados sin líneas', valor: n("SELECT COUNT(*) AS n FROM asientos a WHERE a.estado <> 'borrador' AND NOT EXISTS (SELECT 1 FROM asiento_lineas l WHERE l.taller_id = a.taller_id AND l.asiento_id = a.id)") },
    { clave: 'numeracion', nombre: 'Talleres con numeración de asientos con saltos o repetidos', valor: n("SELECT COUNT(*) AS n FROM (SELECT taller_id FROM asientos WHERE numero IS NOT NULL GROUP BY taller_id HAVING MIN(numero) <> 1 OR MAX(numero) <> COUNT(*))") },
    { clave: 'duplicados', nombre: 'Documentos con más de un asiento del mismo evento', valor: n('SELECT COUNT(*) AS n FROM (SELECT 1 FROM asientos WHERE origen_id IS NOT NULL GROUP BY taller_id, origen_tipo, origen_id, evento HAVING COUNT(*) > 1)') },
    { clave: 'reversiones', nombre: 'Asientos revertidos sin contra-asiento', valor: n("SELECT COUNT(*) AS n FROM asientos a WHERE a.estado = 'revertido' AND NOT EXISTS (SELECT 1 FROM asientos r WHERE r.taller_id = a.taller_id AND r.revierte_id = a.id)") },
    { clave: 'lineas_huerfanas', nombre: 'Líneas de asiento sin su asiento', valor: n('SELECT COUNT(*) AS n FROM asiento_lineas l WHERE NOT EXISTS (SELECT 1 FROM asientos a WHERE a.taller_id = l.taller_id AND a.id = l.asiento_id)') },
  ].map((c) => ({ ...c, ok: c.valor === 0 }));
  const porTaller = db
    .prepare(
      `SELECT t.id, t.nombre,
              (SELECT COUNT(*) FROM asientos a WHERE a.taller_id = t.id) AS asientos,
              (SELECT COUNT(*) FROM asiento_lineas l WHERE l.taller_id = t.id) AS lineas,
              (SELECT COALESCE(SUM(debe), 0) FROM asiento_lineas l WHERE l.taller_id = t.id) AS debe,
              (SELECT COALESCE(SUM(haber), 0) FROM asiento_lineas l WHERE l.taller_id = t.id) AS haber
         FROM talleres t ORDER BY t.nombre`,
    )
    .all()
    .map((r) => ({ ...r }));
  const cola = tablas.has('contab_cola') ? db.prepare("SELECT COALESCE(SUM(estado = 'pendiente'), 0) AS pendientes, COALESCE(SUM(estado = 'fallida'), 0) AS fallidas FROM contab_cola").get() : { pendientes: 0, fallidas: 0 };
  return { aplica: true, ok: controles.every((c) => c.ok) && porTaller.every((t) => t.debe === t.haber), controles, porTaller, cola: { ...cola } };
}
