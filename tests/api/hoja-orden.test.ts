// Sprint 19: hoja de la orden de trabajo en PDF (GET /api/ordenes/:id/pdf) — contenido real del archivo, ausencia total de datos financieros,
// permisos por copia, alcance de los mecánicos, aislamiento entre talleres y registro de la impresión.
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, consultaLocal, dormir, nuevoPersonal, nuevoTaller } from './cliente';
import { PUERTO } from './global-setup';

const BASE = `http://127.0.0.1:${PUERTO}`;

async function pedirPdf(api: Api, id: string, copia?: string) {
  const r = await fetch(`${BASE}/api/ordenes/${id}/pdf${copia ? `?copia=${copia}` : ''}`, { headers: { cookie: api.cookie, 'cf-connecting-ip': api.ip } });
  const bytes = new Uint8Array(await r.arrayBuffer());
  return { status: r.status, headers: r.headers, bytes, texto: Buffer.from(bytes).toString('latin1') };
}
/** Texto que el PDF muestra (lo que está entre paréntesis de cada Tj), con los escapes de WinAnsi resueltos. */
const visible = (texto: string) =>
  [...texto.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)]
    .map((m) => m[1].replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))).replace(/\\([()\\])/g, '$1'))
    .join('\n');
const paginas = (texto: string) => (texto.match(/\/Type \/Page /g) ?? []).length;

const T: any = {};
beforeAll(async () => {
  T.a = await nuevoTaller('Taller Hoja A', 8);
  T.b = await nuevoTaller('Taller Hoja B');
  T.rec = await nuevoPersonal(T.a.api, 'recepcion');
  T.mec = await nuevoPersonal(T.a.api, 'mecanico');
  T.mec2 = await nuevoPersonal(T.a.api, 'mecanico');
  T.dep = await nuevoPersonal(T.a.api, 'deposito');
  T.caja = await nuevoPersonal(T.a.api, 'caja');
  const cli = (await T.a.api.post('/api/clientes', { nombre: 'Rosario Ñañez', telefono: '341 555-7788' })).body;
  T.veh = (await T.a.api.post('/api/vehiculos', { cliente_id: cli.id, patente: 'PDF123', anio: 2017 })).body;
  const mecs = (await T.a.api.get('/api/mecanicos')).body;
  T.mecId = mecs.find((m: any) => m.usuario_id === T.mec.id).id;
  const items = [
    { tipo: 'libre', descripcion: 'Cambio de pastillas de freno', cantidad: 1, precio_unitario: 8765432 },
    { tipo: 'libre', descripcion: 'Alineación y balanceo', cantidad: 1, precio_unitario: 3456789 },
  ];
  T.ot = (await T.a.api.post('/api/ordenes', { cliente_id: cli.id, vehiculo_id: T.veh.id, mecanico_id: T.mecId, falla_reportada: 'Ruido al frenar', km_ingreso: 98765, observaciones: 'Llamar antes de cambiar discos', items })).body;
  T.ot2 = (await T.a.api.post('/api/ordenes', { cliente_id: cli.id, vehiculo_id: T.veh.id, falla_reportada: 'Otra', items: [] })).body;
  // una nota interna con un dato que jamás debe salir en la hoja
  await T.a.api.post(`/api/ordenes/${T.ot.id}/notas`, { texto: 'NOTA-INTERNA-RESERVADA el cliente debe plata' });
  const cliB = (await T.b.api.post('/api/clientes', { nombre: 'Cliente B' })).body;
  T.vehB = (await T.b.api.post('/api/vehiculos', { cliente_id: cliB.id, patente: 'PDF999' })).body;
  T.otB = (await T.b.api.post('/api/ordenes', { cliente_id: cliB.id, vehiculo_id: T.vehB.id, falla_reportada: 'B', items: [] })).body;
});

describe('contenido del PDF', () => {
  it('copia del mecánico: PDF A4 legible con los datos operativos y la zona de anotaciones', async () => {
    const r = await pedirPdf(T.a.api, T.ot.id);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.headers.get('content-disposition')).toMatch(/^inline; filename="OT-\d{4}-mecanico\.pdf"$/);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.texto.startsWith('%PDF-1.4')).toBe(true);
    expect(paginas(r.texto)).toBe(1);
    const t = visible(r.texto);
    for (const x of ['COPIA MECÁNICO', 'Taller Hoja A', 'Rosario Ñañez', '341 555-7788', 'PDF123', '2017', '98.765 km', 'Ruido al frenar', 'Cambio de pastillas de freno', 'Alineación y balanceo', 'Llamar antes de cambiar discos', 'ANOTACIONES DEL MECÁNICO']) expect(t, x).toContain(x);
  });

  it('no contiene precios, costos, totales, IVA ni notas internas: ni en el documento ni en los metadatos', async () => {
    for (const copia of ['mecanico', 'administracion', 'ambas']) {
      const r = await pedirPdf(T.a.api, T.ot.id, copia);
      expect(r.status, copia).toBe(200);
      for (const prohibido of ['8765432', '87.654', '87654', '3456789', '34.567', '$', 'Subtotal', 'IVA', 'Total', 'Precio', 'Costo', 'Margen', 'NOTA-INTERNA', 'debe plata']) {
        expect(r.texto.includes(prohibido), `${copia}: ${prohibido}`).toBe(false);
      }
      expect(r.texto).not.toMatch(/\/Author/);
      expect(r.texto).not.toContain(T.rec.email);
    }
  });

  it('"ambas" devuelve un único PDF con dos hojas A4 identificadas; la de administración usa los mismos datos operativos', async () => {
    const r = await pedirPdf(T.a.api, T.ot.id, 'ambas');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toContain('ambas-copias');
    expect(paginas(r.texto)).toBe(2);
    const [a, b] = [...r.texto.matchAll(/<< \/Length \d+ >>\nstream\n([\s\S]*?)\nendstream/g)].map((m) => visible(m[1]));
    expect(a).toContain('COPIA MECÁNICO');
    expect(a).not.toContain('COPIA ADMINISTRACIÓN');
    expect(b).toContain('COPIA ADMINISTRACIÓN');
    expect(b).toContain('Cambio de pastillas de freno');
    expect(b).toContain('PDF123');
    const adm = await pedirPdf(T.a.api, T.ot.id, 'administracion');
    expect(visible(adm.texto)).toContain('COPIA ADMINISTRACIÓN');
    expect(visible(adm.texto)).not.toContain('COPIA MECÁNICO');
  });

  it('copia inválida: 400; sin sesión: 401', async () => {
    expect((await pedirPdf(T.a.api, T.ot.id, 'desconocida')).status).toBe(400);
    const anon = new Api();
    expect((await pedirPdf(anon, T.ot.id)).status).toBe(401);
  });
});

describe('permisos y alcance', () => {
  it('recepción imprime ambas copias; el mecánico asignado sólo la suya y sin datos del cliente', async () => {
    expect((await pedirPdf(T.rec.api, T.ot.id, 'ambas')).status).toBe(200);
    const m = await pedirPdf(T.mec.api, T.ot.id);
    expect(m.status).toBe(200);
    const t = visible(m.texto);
    expect(t).toContain('PDF123');
    expect(t).toContain('Cambio de pastillas de freno');
    // el mecánico no tiene permiso para ver clientes: ni nombre ni teléfono
    expect(t).not.toContain('Rosario');
    expect(t).not.toContain('341 555-7788');
    expect(t).toContain('No disponible con los permisos de quien imprime');
    expect((await pedirPdf(T.mec.api, T.ot.id, 'administracion')).status).toBe(403);
    expect((await pedirPdf(T.mec.api, T.ot.id, 'ambas')).status).toBe(403);
  });

  it('un mecánico no imprime órdenes que no son suyas; quien ve órdenes pero no tiene el permiso de imprimir, tampoco', async () => {
    expect((await pedirPdf(T.mec2.api, T.ot.id)).status).toBe(404);
    expect((await pedirPdf(T.mec.api, T.ot2.id)).status).toBe(404);
    expect((await pedirPdf(T.dep.api, T.ot.id)).status).toBe(403); // depósito ve órdenes pero no las imprime
    expect((await pedirPdf(T.caja.api, T.ot.id)).status).toBe(403);
  });

  it('el propietario otorga y retira permisos de impresión y rige de inmediato', async () => {
    const u = (await T.a.api.get(`/api/taller/usuarios/${T.dep.id}`)).body;
    expect(u.permisos).not.toContain('ordenes.imprimir');
    await T.a.api.put(`/api/taller/usuarios/${T.dep.id}/permisos`, { permisos: [...u.permisos, 'ordenes.imprimir'] });
    expect((await pedirPdf(T.dep.api, T.ot.id)).status).toBe(200);
    expect((await pedirPdf(T.dep.api, T.ot.id, 'administracion')).status).toBe(403);
    await T.a.api.put(`/api/taller/usuarios/${T.dep.id}/permisos`, { permisos: u.permisos });
    expect((await pedirPdf(T.dep.api, T.ot.id)).status).toBe(403);
    // quitarle al mecánico el permiso de imprimir lo deja sin hoja aunque siga viendo la orden
    const m = (await T.a.api.get(`/api/taller/usuarios/${T.mec.id}`)).body;
    await T.a.api.put(`/api/taller/usuarios/${T.mec.id}/permisos`, { permisos: m.permisos.filter((p: string) => p !== 'ordenes.imprimir') });
    expect((await pedirPdf(T.mec.api, T.ot.id)).status).toBe(403);
    await T.a.api.put(`/api/taller/usuarios/${T.mec.id}/permisos`, { permisos: m.permisos });
    expect((await pedirPdf(T.mec.api, T.ot.id)).status).toBe(200);
  });

  it('aislamiento entre talleres: la orden de otro taller no existe', async () => {
    expect((await pedirPdf(T.a.api, T.otB.id)).status).toBe(404);
    expect((await pedirPdf(T.b.api, T.ot.id)).status).toBe(404);
    const propia = await pedirPdf(T.b.api, T.otB.id);
    expect(propia.status).toBe(200);
    const t = visible(propia.texto);
    expect(t).toContain('PDF999');
    expect(t).not.toContain('PDF123');
    expect(t).not.toContain('Taller Hoja A');
  });
});

describe('registro', () => {
  it('cada impresión queda en la auditoría con quién, qué orden y qué copia', async () => {
    await pedirPdf(T.rec.api, T.ot.id, 'ambas');
    let filas: any[] = [];
    for (let i = 0; i < 20 && !filas.length; i++) {
      await dormir(100);
      filas = await consultaLocal(`SELECT usuario_id, entidad_id, detalle FROM auditoria WHERE accion = 'imprimir_pdf' AND entidad_id = '${T.ot.id}' AND usuario_id = '${T.rec.id}'`);
    }
    expect(filas.length).toBeGreaterThan(0);
    expect(JSON.parse(filas[0].detalle)).toMatchObject({ copia: 'ambas', hojas: 2 });
  });
});
