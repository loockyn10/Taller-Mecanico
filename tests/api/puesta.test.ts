// Sprint 11: asistente de puesta en marcha (progreso real, pasos hechos/omitidos, plantillas generales) y datos del negocio (horarios, logo).
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, nuevoPersonal, nuevoTaller, plataforma, platformHeaders } from './cliente';

let n = 0;
async function tallerActivado(nombre: string) {
  const inv = await plataforma.req('POST', '/api/platform/invitaciones', { usuarios_adicionales: 4 }, platformHeaders);
  const api = new Api();
  const r = await api.req(
    'POST', '/api/activacion/completar',
    { token: inv.body.token, propietario: { nombre: 'Dueña', email: `puesta${++n}-${Date.now()}@taller.test`, password: 'clave-segura-1' }, taller: { nombre } },
    { 'cf-connecting-ip': `10.8.0.${n}` },
  );
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return api;
}
const paso = (estado: any, clave: string) => estado.pasos.find((p: any) => p.clave === clave);
// PNG de 1×1 píxel
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let A: Api;
let B: Api;
beforeAll(async () => {
  A = await tallerActivado('Taller A Puesta');
  B = await tallerActivado('Taller B Puesta');
});

describe('progreso de la puesta en marcha', () => {
  it('un taller recién activado arranca con los nueve pasos sin completar, sin bloquear nada', async () => {
    const e = (await A.get('/api/puesta-en-marcha')).body;
    expect(e.total).toBe(9);
    expect(e.pasos.map((p: any) => p.clave)).toEqual(['negocio', 'horarios', 'deposito', 'catalogo', 'tarifas', 'listas', 'personal', 'cobros', 'importacion']);
    expect(e).toMatchObject({ completos: 0, omitidos: 0, pendientes: 9, asistente_pendiente: true, siguiente: 'negocio' });
    expect(paso(e, 'negocio').detalle).toContain('domicilio');
    expect(paso(e, 'catalogo').detalle).toContain('plantilla');
    // El taller opera igual: cliente, artículo, presupuesto y venta de mostrador
    expect((await A.post('/api/clientes', { nombre: 'Cliente de prueba' })).status).toBe(201);
    expect((await A.post('/api/articulos', { nombre: 'Filtro', codigo: 'F1', costo: 100, precio: 200 })).status).toBe(201);
  });

  it('cada paso se detecta en los datos reales y el indicador avanza', async () => {
    // Datos del negocio: se completa guardando domicilio, localidad, provincia y teléfono (por la pantalla de configuración o por el asistente)
    const cfg = (await A.get('/api/taller/config')).body;
    // Siempre se parte de la configuración vigente, como hace la pantalla de configuración.
    const guardar = async (t: Record<string, unknown>, c: Record<string, unknown> = {}) => {
      const actual = (await A.get('/api/taller/config')).body;
      return A.put('/api/taller/config', { taller: { ...actual.taller, ...t }, config: { ...actual.config, permitir_stock_negativo: !!actual.config.permitir_stock_negativo, caja_obligatoria: !!actual.config.caja_obligatoria, ...c } });
    };
    expect((await guardar({ direccion: 'Av. Siempreviva 742', localidad: 'Rosario', provincia: 'Santa Fe', telefono: '341 555-0000' })).status).toBe(200);
    let e = (await A.get('/api/puesta-en-marcha')).body;
    expect(paso(e, 'negocio')).toMatchObject({ estado: 'completo', origen: 'datos' });
    expect(e.completos).toBe(1);
    expect((await A.get('/api/taller/config')).body.taller.provincia).toBe('Santa Fe');
    // Un cliente anterior al Sprint 11 que no envía "provincia" no la borra
    const vigente = (await A.get('/api/taller/config')).body;
    const sinProvincia = { ...vigente.taller, direccion: 'Otra dirección' } as any;
    delete sinProvincia.provincia;
    expect((await A.put('/api/taller/config', { taller: sinProvincia, config: { ...vigente.config, permitir_stock_negativo: false, caja_obligatoria: false } })).status).toBe(200);
    expect((await A.get('/api/taller/config')).body.taller).toMatchObject({ provincia: 'Santa Fe', direccion: 'Otra dirección' });
    // Horarios
    const dias = [1, 2, 3, 4, 5, 6, 7].map((dia) => ({ dia, abierto: dia <= 5, tramos: dia <= 5 ? [{ desde: '08:00', hasta: '12:30' }, { desde: '14:00', hasta: '18:30' }] : [] }));
    expect((await A.put('/api/taller/horarios', { dias: dias.slice(0, 6) })).status).toBe(400);
    expect((await A.put('/api/taller/horarios', { dias: dias.map((d) => (d.dia === 2 ? { ...d, tramos: [{ desde: '18:00', hasta: '08:00' }] } : d)) })).status).toBe(400);
    expect((await A.put('/api/taller/horarios', { dias })).status).toBe(200);
    expect((await A.get('/api/taller/config')).body.config.horarios_atencion.dias[0].tramos).toHaveLength(2);
    e = (await A.get('/api/puesta-en-marcha')).body;
    expect(paso(e, 'horarios')).toMatchObject({ estado: 'completo', origen: 'datos' });
    expect(paso(e, 'horarios').detalle).toContain('Lun a Vie');
    // Catálogo y tarifas: la plantilla del tempario trae operaciones SIN precio; con la tarifa por hora quedan valuadas
    expect(paso(e, 'tarifas').estado).toBe('pendiente');
    const imp = await A.post('/api/tempario/plantilla/importar', {});
    expect(imp.status).toBe(200);
    expect(imp.body.creadas).toBeGreaterThan(30);
    e = (await A.get('/api/puesta-en-marcha')).body;
    expect(paso(e, 'catalogo').estado).toBe('completo');
    expect(paso(e, 'tarifas')).toMatchObject({ estado: 'pendiente' });
    expect(paso(e, 'tarifas').detalle).toContain('hora de trabajo');
    expect((await A.put('/api/tempario/tarifas', { tarifa_hora: 2500000, categorias: [] })).status).toBe(200);
    e = (await A.get('/api/puesta-en-marcha')).body;
    expect(paso(e, 'tarifas')).toMatchObject({ estado: 'completo', origen: 'datos' });
    const servicios = (await A.get('/api/servicios')).body as any[];
    expect(servicios.every((s) => s.precio > 0)).toBe(true); // calculado por tiempo × tarifa
    // Personal: pasa a completo al sumar a alguien
    expect(paso(e, 'personal').estado).toBe('pendiente');
    await nuevoPersonal(A, 'mecanico');
    e = (await A.get('/api/puesta-en-marcha')).body;
    expect(paso(e, 'personal').estado).toBe('completo');
    // Cobros: medios de cobro configurados
    expect(paso(e, 'cobros').estado).toBe('pendiente');
    expect((await guardar({}, { medios_pago: ['efectivo', 'transferencia'] })).status).toBe(200);
    expect(paso((await A.get('/api/puesta-en-marcha')).body, 'cobros').estado).toBe('completo');
    // Importación: se completa al terminar una
    expect(paso(e, 'importacion').estado).toBe('pendiente');
    const job = await A.post('/api/importaciones', { tipo: 'clientes', modo: 'omitir', opciones: {}, archivo: { nombre: 'a.csv', hash: 'a'.repeat(64), bytes: 10 }, total_filas: 1 });
    await A.post(`/api/importaciones/${job.body.id}/lotes/0`, { filas: [{ n: 2, v: { nombre: 'Cliente Importado' } }] });
    await A.post(`/api/importaciones/${job.body.id}/finalizar`);
    e = (await A.get('/api/puesta-en-marcha')).body;
    expect(paso(e, 'importacion')).toMatchObject({ estado: 'completo', origen: 'datos' });
    expect(e.completos, JSON.stringify(e.pasos.map((p: any) => [p.clave, p.estado, p.detalle]))).toBe(7);
  });

  it('los pasos se pueden marcar como hechos u omitidos y volver a pendiente; los demás talleres no se ven afectados', async () => {
    let e = (await A.put('/api/puesta-en-marcha/pasos/deposito', { estado: 'hecho' })).body;
    expect(paso(e, 'deposito')).toMatchObject({ estado: 'completo', origen: 'manual' });
    e = (await A.put('/api/puesta-en-marcha/pasos/listas', { estado: 'omitido' })).body;
    expect(paso(e, 'listas')).toMatchObject({ estado: 'omitido', origen: 'manual' });
    expect(e).toMatchObject({ completos: 8, omitidos: 1, pendientes: 0 });
    e = (await A.put('/api/puesta-en-marcha/pasos/listas', { estado: 'pendiente' })).body;
    expect(paso(e, 'listas').estado).toBe('pendiente');
    expect((await A.put('/api/puesta-en-marcha/pasos/inventado', { estado: 'hecho' })).status).toBe(404);
    expect((await A.put('/api/puesta-en-marcha/pasos/listas', { estado: 'cualquiera' })).status).toBe(400);
    const b = (await B.get('/api/puesta-en-marcha')).body;
    expect(b).toMatchObject({ completos: 0, omitidos: 0 });
    expect(paso(b, 'deposito').estado).toBe('pendiente');
    // Una lista de precios real completa el paso por los datos, aunque se haya omitido
    await A.put('/api/puesta-en-marcha/pasos/listas', { estado: 'omitido' });
    expect((await A.post('/api/listas-precios', { nombre: 'Mayorista', base: 'precio', porcentaje: -10 })).status).toBeLessThan(300);
    expect(paso((await A.get('/api/puesta-en-marcha')).body, 'listas')).toMatchObject({ estado: 'completo', origen: 'datos' });
  });

  it('cerrar el asistente deja de mostrarlo al ingresar; el progreso sigue consultable', async () => {
    expect((await A.get('/api/auth/me')).body.taller.asistente_pendiente).toBe(true);
    expect((await A.post('/api/puesta-en-marcha/cerrar', {})).status).toBe(200);
    expect((await A.get('/api/auth/me')).body.taller.asistente_pendiente).toBe(false);
    expect((await A.get('/api/puesta-en-marcha')).body.total).toBe(9);
    expect((await B.get('/api/auth/me')).body.taller.asistente_pendiente).toBe(true);
  });

  it('los talleres creados antes (alta manual) no reciben el asistente automático', async () => {
    const viejo = await nuevoTaller('Taller Anterior');
    expect((await viejo.api.get('/api/auth/me')).body.taller.asistente_pendiente).toBe(false);
    const e = (await viejo.api.get('/api/puesta-en-marcha')).body;
    expect(e.asistente_pendiente).toBe(false);
    expect(paso(e, 'catalogo').estado).toBe('completo'); // trae servicios y categorías de ejemplo
  });

  it('solo quien puede configurar el taller ve el progreso', async () => {
    const rec = await nuevoPersonal(B, 'recepcion');
    expect((await rec.api.get('/api/puesta-en-marcha')).status).toBe(403);
    expect((await rec.api.put('/api/puesta-en-marcha/pasos/negocio', { estado: 'hecho' })).status).toBe(403);
    expect((await rec.api.post('/api/puesta-en-marcha/cerrar', {})).status).toBe(403);
    expect((await rec.api.post('/api/puesta-en-marcha/plantillas', { categorias_articulo: true })).status).toBe(403);
    expect((await new Api().get('/api/puesta-en-marcha')).status).toBe(401);
  });
});

describe('plantillas generales', () => {
  it('agregan solo lo que falta, sin duplicar ni tocar lo que el taller cambió', async () => {
    const cats = (await B.get('/api/categorias-articulo')).body as any[];
    const filtros = cats.find((c) => c.nombre === 'Filtros');
    expect((await B.del(`/api/categorias-articulo/${filtros.id}`)).status).toBe(200);
    expect((await B.post('/api/categorias-articulo', { nombre: 'Mi categoría propia' })).status).toBe(201);
    const r = await B.post('/api/puesta-en-marcha/plantillas', { categorias_articulo: true, tipos_gasto: true, marcas: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ categorias_articulo: 1, tipos_gasto: 0, marcas: 0, modelos: 0 });
    const otra = await B.post('/api/puesta-en-marcha/plantillas', { categorias_articulo: true, tipos_gasto: true, marcas: true });
    expect(otra.body).toMatchObject({ categorias_articulo: 0, tipos_gasto: 0, marcas: 0, modelos: 0 });
    expect(((await B.get('/api/categorias-articulo')).body as any[]).some((c) => c.nombre === 'Mi categoría propia')).toBe(true);
  });

  it('el catálogo de un taller no se copia a otro: las plantillas son solo las listas generales', async () => {
    await A.post('/api/categorias-articulo', { nombre: 'Categoría privada de A' });
    await A.post('/api/clientes', { nombre: 'Cliente privado de A' });
    await A.post('/api/proveedores', { nombre: 'Proveedor privado de A' });
    const nuevo = await tallerActivado('Taller C Puesta');
    expect(((await nuevo.get('/api/categorias-articulo')).body as any[]).some((c) => c.nombre.includes('privada de A'))).toBe(false);
    expect(((await nuevo.get('/api/clientes')).body as any[]).map((c) => c.nombre)).toEqual(['Consumidor final']);
    expect((await nuevo.get('/api/proveedores')).body).toEqual([]);
    expect((await nuevo.get('/api/vehiculos')).body).toEqual([]);
    expect((await nuevo.get('/api/articulos')).body).toEqual([]);
  });

  it('los tiempos del tempario siguen marcados como orientativos', async () => {
    const t = await A.get('/api/tempario/plantilla');
    expect(t.body.aviso).toContain('orientativos');
    const s = (await A.get('/api/servicios?todos=1')).body as any[];
    expect(s.length).toBeGreaterThan(30);
    expect(s.every((x) => x.origen === 'plantilla')).toBe(true);
  });
});

describe('logo del negocio', () => {
  it('guarda una imagen válida y la sirve con su tipo, sin permitir SVG ni contenidos disfrazados', async () => {
    expect((await A.put('/api/taller/logo', { imagen: PNG })).status).toBe(200);
    const cfg = (await A.get('/api/taller/config')).body;
    expect(cfg.config.tiene_logo).toBe(true);
    expect(cfg.config.logo).toBeUndefined(); // la configuración no arrastra la imagen
    expect((await A.get('/api/auth/me')).body.taller.tiene_logo).toBe(true);
    const r = await fetch(`http://127.0.0.1:8799/api/taller/logo`, { headers: { cookie: A.cookie } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(new Uint8Array(await r.arrayBuffer())[1]).toBe(0x50);
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')}`;
    expect((await A.put('/api/taller/logo', { imagen: svg })).status).toBe(400);
    const html = `data:image/png;base64,${Buffer.from('<html><script>alert(1)</script></html>').toString('base64')}`;
    expect((await A.put('/api/taller/logo', { imagen: html })).status).toBe(400); // dice ser PNG pero no lo es
    expect((await A.put('/api/taller/logo', { imagen: 'data:image/png;base64,' + 'A'.repeat(290_000) })).status).toBe(400);
    expect((await A.put('/api/taller/logo', { imagen: 'http://ejemplo.com/logo.png' })).status).toBe(400);
  });

  it('cada taller ve solo el suyo y solo quien configura puede cambiarlo', async () => {
    expect((await B.get('/api/taller/logo')).status).toBe(404);
    const rec = await nuevoPersonal(A, 'recepcion');
    expect((await rec.api.put('/api/taller/logo', { imagen: PNG })).status).toBe(403);
    expect((await rec.api.get('/api/taller/logo')).status).toBe(200); // el personal lo ve en pantallas y documentos
    expect((await A.del('/api/taller/logo')).status).toBe(200);
    expect((await A.get('/api/taller/logo')).status).toBe(404);
  });
});
