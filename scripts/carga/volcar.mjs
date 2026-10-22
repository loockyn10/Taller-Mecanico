// Volcado SQL de una base SQLite LOCAL (la de ensayo de las pruebas de capacidad) con el mismo formato general que `wrangler d1 export`:
// tablas con sus datos, después índices y triggers. Sirve para ensayar la restauración con una base que sí tiene contabilidad. Sólo lee.
import fs from 'node:fs';
import path from 'node:path';

const q = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString('hex')}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
};

export async function volcarSqlite(estado, salida) {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = path.join(estado, 'v3', 'd1', 'miniflare-D1DatabaseObject');
  const archivo = fs.readdirSync(dir).find((f) => f.endsWith('.sqlite'));
  const db = new DatabaseSync(path.join(dir, archivo), { readOnly: true });
  const objetos = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY rowid").all();
  const out = ['PRAGMA defer_foreign_keys=TRUE;'];
  for (const t of objetos.filter((o) => o.type === 'table')) out.push(`${t.sql};`);
  for (const t of objetos.filter((o) => o.type === 'table')) {
    const filas = db.prepare(`SELECT * FROM "${t.name}"`).all();
    for (const f of filas) out.push(`INSERT INTO "${t.name}" (${Object.keys(f).map((c) => `"${c}"`).join(', ')}) VALUES (${Object.values(f).map(q).join(', ')});`);
  }
  for (const o of objetos.filter((o) => o.type === 'index' || o.type === 'trigger')) out.push(`${o.sql};`);
  db.close();
  fs.writeFileSync(salida, out.join('\n') + '\n');
}
