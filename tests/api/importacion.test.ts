// Sprint 11: importación de clientes, vehículos, artículos y proveedores. Se verifican los circuitos completos (validar → importar por lotes → informe),
// los duplicados (dentro del archivo, entre lotes y contra lo existente), las referencias entre entidades, los permisos, el aislamiento entre talleres
// y que importar catálogos no genere stock ni asientos contables.
import { beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { Api, hoyAR, nuevoPersonal, nuevoTaller } from './cliente';

let T: Awaited<ReturnType<typeof nuevoTaller>>;
let B: Awaited<ReturnType<typeof nuevoTaller>>;
let api: Api;

const hash = () => crypto.randomBytes(32).toString('hex');
const trozos = <X>(xs: X[], n = 50) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
type Fila = { n: number; v: Record<string, string | number | null> };
const filas = (...vs: Array<Record<string, string | number | null>>): Fila[] => vs.map((v, i) => ({ n: i + 2, v }));

function cuit(prefijo: string, numero: string): string {
  const base = prefijo + numero;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((a, p, i) => a + p * Number(base[i]), 0);
  let v = 11 - (suma % 11);
  if (v === 11) v = 0;
  if (v === 10) v = 9;
  return base + v;
}

const validar = async (a: Api, tipo: string, f: Fila[], extra: Record<string, unknown> = {}) => {
  const r = await a.post('/api/importaciones/validar', { tipo, modo: 'omitir', opciones: {}, filas: f, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { resultados: any[]; resumen: Record<string, number> };
};

/** Importación completa: alta del trabajo, un request por lote y cierre. */
async function importar(a: Api, tipo: string, f: Fila[], extra: { modo?: string; opciones?: Record<string, unknown>; resoluciones?: Record<string, string>; hash?: string } = {}) {
  const job = await a.post('/api/importaciones', {
    tipo, modo: extra.modo ?? 'omitir', opciones: extra.opciones ?? {}, archivo: { nombre: 'datos.csv', hash: extra.hash ?? hash(), bytes: 1000 }, total_filas: f.length,
  });
  expect(job.status, JSON.stringify(job.body)).toBeLessThan(300);
  const lotes: any[] = [];
  for (const [i, parte] of trozos(f).entries()) {
    if (job.body.lotes_hechos?.includes(i)) continue;
    const r = await a.post(`/api/importaciones/${job.body.id}/lotes/${i}`, { filas: parte, resoluciones: extra.resoluciones ?? {} });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    lotes.push(r.body);
  }
  const fin = await a.post(`/api/importaciones/${job.body.id}/finalizar`);
  expect(fin.status, JSON.stringify(fin.body)).toBe(200);
  const detalle = (await a.get(`/api/importaciones/${job.body.id}`)).body;
  return { id: job.body.id as string, lotes, detalle, resultados: lotes.flatMap((l) => l.resultados ?? []) };
}

const clientes = async (a: Api, q = '') => (await a.get(`/api/clientes?limite=500${q ? `&q=${encodeURIComponent(q)}` : ''}`)).body as any[];

beforeAll(async () => {
  T = await nuevoTaller('Taller Importador', 5);
  B = await nuevoTaller('Otro Taller Importador', 2);
  api = T.api;
});

describe('permisos', () => {
  it('solo quien tiene el permiso de importar y el de crear lo que importa puede usar el importador', async () => {
    const recepcion = await nuevoPersonal(api, 'recepcion');
    expect((await recepcion.api.post('/api/importaciones/validar', { tipo: 'clientes', modo: 'omitir', opciones: {}, filas: filas({ nombre: 'Ana' }) })).status).toBe(403);
    expect((await recepcion.api.get('/api/importaciones')).status).toBe(403);
    // Con el permiso de importar y de crear clientes alcanza para clientes, pero no para artículos ni para actualizar.
    const permisos = (await api.get(`/api/taller/usuarios/${recepcion.id}`)).body.permisos as string[];
    expect((await api.put(`/api/taller/usuarios/${recepcion.id}/permisos`, { permisos: [...permisos, 'datos.importar'] })).status).toBe(200);
    expect((await recepcion.api.post('/api/importaciones/validar', { tipo: 'clientes', modo: 'omitir', opciones: {}, filas: filas({ nombre: 'Ana' }) })).status).toBe(200);
    expect((await recepcion.api.post('/api/importaciones/validar', { tipo: 'articulos', modo: 'omitir', opciones: {}, filas: filas({ nombre: 'Filtro' }) })).status).toBe(403);
    expect((await recepcion.api.post('/api/importaciones/validar', { tipo: 'proveedores', modo: 'omitir', opciones: {}, filas: filas({ nombre: 'Proveedor' }) })).status).toBe(403);
    const adm = await nuevoPersonal(api, 'administrador');
    expect((await adm.api.post('/api/importaciones/validar', { tipo: 'articulos', modo: 'omitir', opciones: {}, filas: filas({ nombre: 'Filtro' }) })).status).toBe(200);
    // El mecánico no tiene ni siquiera acceso a la sección.
    const mec = await nuevoPersonal(api, 'mecanico');
    expect((await mec.api.get('/api/importaciones')).status).toBe(403);
  });

  it('sin sesión no se puede importar', async () => {
    const anon = new Api();
    expect((await anon.post('/api/importaciones/validar', { tipo: 'clientes', modo: 'omitir', opciones: {}, filas: filas({ nombre: 'Ana' }) })).status).toBe(401);
  });
});

describe('clientes', () => {
  it('la validación previa detecta campos obligatorios, formatos y duplicados del archivo, y no escribe nada', async () => {
    const antes = (await clientes(api)).length;
    const v = await validar(api, 'clientes', filas(
      { nombre: 'Ana Gómez', documento: '27.456.789' },
      { nombre: 'Beto Duplicado', documento: '27456789' },
      { nombre: 'Carlos', email: 'mal' },
      { nombre: 'Dora' },
      { nombre: '' },
      { nombre: 'Elsa', documento: '20301234560' },
    ));
    expect(v.resultados.map((r) => r.accion)).toEqual(['crear', 'error', 'error', 'crear', 'error', 'error']);
    expect(v.resultados[1].errores[0]).toContain('Duplicado en el archivo');
    expect(v.resultados[1].errores[0]).toContain('fila 2');
    expect(v.resultados[3].avisos[0]).toContain('Sin documento');
    expect(v.resumen).toMatchObject({ crear: 2, error: 4 });
    expect((await clientes(api)).length).toBe(antes);
  });

  it('importa por lotes, deja el registro de la operación y reintentar un lote no duplica', async () => {
    const f = filas({ nombre: 'Ana Gómez', documento: '27.456.789', telefono: '11 5555-1111', codigo_externo: 'C-001' }, { nombre: 'Dora Sin Documento' });
    const h = hash();
    const job = await api.post('/api/importaciones', { tipo: 'clientes', modo: 'omitir', opciones: {}, archivo: { nombre: 'clientes-2026.xlsx', hash: h, bytes: 4096 }, total_filas: 2, mapeo: { nombre: 'Nombre', documento: 'DNI' } });
    expect(job.status).toBe(201);
    // Cerrar sin procesar los lotes no es posible
    expect((await api.post(`/api/importaciones/${job.body.id}/finalizar`)).status).toBe(409);
    const l0 = await api.post(`/api/importaciones/${job.body.id}/lotes/0`, { filas: f });
    expect(l0.status).toBe(200);
    expect(l0.body.contadores).toMatchObject({ creados: 2, actualizados: 0, omitidos: 0, errores: 0 });
    // El mismo lote otra vez (corte de red): no se aplica de nuevo
    const otra = await api.post(`/api/importaciones/${job.body.id}/lotes/0`, { filas: f });
    expect(otra.body.ya_procesado).toBe(true);
    expect(otra.body.creados).toBe(2);
    // Reabrir el mismo archivo con las mismas opciones retoma la importación
    const retoma = await api.post('/api/importaciones', { tipo: 'clientes', modo: 'omitir', opciones: {}, archivo: { nombre: 'clientes-2026.xlsx', hash: h, bytes: 4096 }, total_filas: 2 });
    expect(retoma.body).toMatchObject({ id: job.body.id, reanudada: true, lotes_hechos: [0] });
    expect((await api.post(`/api/importaciones/${job.body.id}/finalizar`)).status).toBe(200);
    // Un lote fuera de rango se rechaza y una importación cerrada ya no acepta lotes
    expect((await api.post(`/api/importaciones/${job.body.id}/lotes/1`, { filas: f })).status).toBe(409);

    const lista = await clientes(api);
    const ana = lista.filter((c) => c.nombre === 'Ana Gómez');
    expect(ana).toHaveLength(1);
    expect(ana[0]).toMatchObject({ documento: '27456789', documento_tipo: 'DNI', telefono: '11 5555-1111' });
    expect(lista.filter((c) => c.nombre === 'Dora Sin Documento')).toHaveLength(1);
    expect(ana[0].codigo).toBeGreaterThan(0);

    // Trazabilidad: quién, cuándo, archivo, tipo y totales
    const det = (await api.get(`/api/importaciones/${job.body.id}`)).body;
    expect(det).toMatchObject({ tipo: 'clientes', archivo_nombre: 'clientes-2026.xlsx', estado: 'completada', procesados: 2, creados: 2, actualizados: 0, omitidos: 0, errores: 0, usuario: expect.stringContaining('Dueño') });
    expect(det.mapeo).toBeTruthy();
    const hist = (await api.get('/api/importaciones')).body;
    expect(hist.some((x: any) => x.id === job.body.id && x.usuario)).toBe(true);
  });

  it('omitir duplicados deja lo existente sin tocar; sin identificador se carga como nuevo; "solo nuevos" lo omite', async () => {
    const f = filas({ nombre: 'Otro nombre para Ana', documento: '27456789', telefono: '999' }, { nombre: 'Dora Sin Documento' });
    const v = await validar(api, 'clientes', f);
    expect(v.resultados[0]).toMatchObject({ accion: 'omitir', motivo: 'Ya existe' });
    expect(v.resultados[1].accion).toBe('crear'); // sin documento ni código: no se puede saber que es la misma persona
    const s = await validar(api, 'clientes', f, { modo: 'solo_nuevos' });
    expect(s.resultados[1]).toMatchObject({ accion: 'omitir' });
    expect(s.resultados[1].motivo).toContain('Sin identificador');
    const r = await importar(api, 'clientes', filas({ nombre: 'Otro nombre para Ana', documento: '27456789', telefono: '999' }));
    expect(r.detalle).toMatchObject({ creados: 0, omitidos: 1 });
    expect((await clientes(api)).find((c) => c.documento === '27456789')).toMatchObject({ nombre: 'Ana Gómez', telefono: '11 5555-1111' });
    // Las omisiones quedan en el informe
    expect(r.detalle.problemas[0]).toMatchObject({ severidad: 'omitido', fila: 2 });
  });

  it('actualizar muestra qué campos cambian, no borra con celdas vacías y no pisa identificadores', async () => {
    const f = filas({ nombre: 'Ana Gómez', documento: '27456789', telefono: '11 9999-0000', email: 'Ana@Correo.com', localidad: 'Rosario', direccion: '' });
    const v = await validar(api, 'clientes', f, { modo: 'actualizar' });
    expect(v.resultados[0].accion).toBe('actualizar');
    expect(v.resultados[0].cambios).toEqual(
      expect.arrayContaining([{ campo: 'teléfono', antes: '11 5555-1111', despues: '11 9999-0000' }, { campo: 'email', antes: null, despues: 'ana@correo.com' }, { campo: 'localidad', antes: null, despues: 'Rosario' }]),
    );
    expect(v.resultados[0].cambios.some((c: any) => c.campo === 'nombre')).toBe(false);
    // Validar no cambió nada
    expect((await clientes(api)).find((c) => c.documento === '27456789').telefono).toBe('11 5555-1111');
    const r = await importar(api, 'clientes', f, { modo: 'actualizar' });
    expect(r.detalle).toMatchObject({ actualizados: 1, creados: 0 });
    const ana = (await api.get(`/api/clientes/${(await clientes(api)).find((c) => c.documento === '27456789').id}`)).body;
    expect(ana).toMatchObject({ telefono: '11 9999-0000', email: 'ana@correo.com', localidad: 'Rosario', nombre: 'Ana Gómez' });
    // Una celda vacía nunca borra: la dirección sigue como estaba y un nuevo envío idéntico es "sin cambios"
    const otra = await validar(api, 'clientes', f, { modo: 'actualizar' });
    expect(otra.resultados[0]).toMatchObject({ accion: 'omitir', motivo: 'Sin cambios' });
    // El código del archivo no coincide con el del cliente (ya tiene C-001): conflicto, no se pisa
    const c = await validar(api, 'clientes', filas({ nombre: 'Ana Gómez', documento: '27456789', codigo_externo: 'C-999' }), { modo: 'actualizar' });
    expect(c.resultados[0].accion).toBe('error');
    expect(c.resultados[0].errores[0]).toContain('no coincide');
    // Y un documento distinto para el mismo código también
    const d = await validar(api, 'clientes', filas({ nombre: 'Ana Gómez', documento: '30111222', codigo_externo: 'C-001' }), { modo: 'actualizar' });
    expect(d.resultados[0].accion).toBe('error');
  });

  it('detecta el duplicado entre lotes de la misma importación', async () => {
    const f: Fila[] = Array.from({ length: 51 }, (_, i) => ({ n: i + 2, v: { nombre: `Cliente Lote ${i}`, documento: String(40000001 + (i === 50 ? 0 : i)) } }));
    const r = await importar(api, 'clientes', f);
    expect(r.detalle).toMatchObject({ procesados: 51, creados: 50, errores: 1 });
    const ultima = r.resultados.find((x: any) => x.accion === 'error');
    expect(ultima.n).toBe(52);
    expect(ultima.errores[0]).toContain('lote anterior');
    expect((await clientes(api, 'Cliente Lote')).length).toBe(50);
    expect(r.detalle.problemas[0]).toMatchObject({ severidad: 'error', fila: 52 });
  });

  it('el consumidor final nunca se modifica ni se usa como destino', async () => {
    const v = await validar(api, 'clientes', filas({ nombre: 'Consumidor final', documento: '0' }), { modo: 'actualizar' });
    expect(v.resultados[0].accion).toBe('crear'); // documento genérico: no identifica; no toca al "Consumidor final" real
    expect((await clientes(api)).filter((c) => c.codigo === 0)).toHaveLength(1);
  });
});

describe('proveedores', () => {
  it('importa con CUIT válido, rechaza CUIT inválido, no duplica y actualiza mostrando los cambios', async () => {
    const c1 = cuit('30', '71234567');
    const c2 = cuit('30', '50001234');
    const f = filas({ nombre: 'Repuestos del Sur SA', cuit: c1, telefono: '11 4444-0000', codigo_externo: 'P-014' }, { nombre: 'Lubricantes Norte', cuit: c2 }, { nombre: 'Falso SA', cuit: '30-12345678-0' }, { nombre: 'Sin CUIT SRL' });
    const v = await validar(api, 'proveedores', f);
    expect(v.resultados.map((r) => r.accion)).toEqual(['crear', 'crear', 'error', 'crear']);
    const r = await importar(api, 'proveedores', f);
    expect(r.detalle).toMatchObject({ creados: 3, errores: 1 });
    const lista = (await api.get('/api/proveedores')).body as any[];
    expect(lista.find((p) => p.nombre === 'Repuestos del Sur SA')).toMatchObject({ cuit: `30-71234567-${c1.slice(10)}`, codigo_externo: 'P-014' });
    // Reimportar el mismo archivo completo: lo identificable se omite
    const otra = await validar(api, 'proveedores', f);
    expect(otra.resultados.map((x) => x.accion)).toEqual(['omitir', 'omitir', 'error', 'crear']);
    // Actualizar: cambia el teléfono y se completa el email
    const u = await validar(api, 'proveedores', filas({ nombre: 'Repuestos del Sur SA', cuit: c1, telefono: '11 4444-9999', email: 'ventas@sur.com' }), { modo: 'actualizar' });
    expect(u.resultados[0].cambios).toEqual(expect.arrayContaining([{ campo: 'teléfono', antes: '11 4444-0000', despues: '11 4444-9999' }, { campo: 'email', antes: null, despues: 'ventas@sur.com' }]));
  });
});

describe('vehículos', () => {
  let ana: any;
  let beto: any;
  beforeAll(async () => {
    await importar(api, 'clientes', filas(
      { nombre: 'Beto Martínez', documento: '30111333', codigo_externo: 'C-002' },
      { nombre: 'Juan Pérez' },
      { nombre: 'Juan Pérez' },
    ));
    ana = (await clientes(api)).find((c) => c.documento === '27456789');
    beto = (await clientes(api)).find((c) => c.documento === '30111333');
  });

  it('vincula con el cliente por documento o código y crea las marcas y modelos que faltan', async () => {
    const f = filas(
      { patente: 'ab 123 cd', cliente_documento: '27.456.789', marca: 'Fiat', modelo: 'Cronos', anio: '2019', km: '85.000', color: 'Gris' },
      { patente: 'AC456DE', cliente_codigo: 'C-002', marca: 'Marca Nueva', modelo: 'Modelo 1', anio: 2015 },
    );
    const v = await validar(api, 'vehiculos', f);
    expect(v.resultados.map((r) => r.accion)).toEqual(['crear', 'crear']);
    expect(v.resultados[1].nuevos).toEqual(['marca Marca Nueva', 'modelo Modelo 1']);
    const r = await importar(api, 'vehiculos', f);
    expect(r.detalle).toMatchObject({ creados: 2, errores: 0 });
    const lista = (await api.get('/api/vehiculos')).body as any[];
    expect(lista.find((x) => x.patente === 'AB123CD')).toMatchObject({ clientes: ana.nombre, marca: 'Fiat', modelo: 'Cronos', km_actual: 85000, anio: 2019 });
    expect(lista.find((x) => x.patente === 'AC456DE')).toMatchObject({ clientes: beto.nombre, marca: 'Marca Nueva', modelo: 'Modelo 1' });
    const marcas = (await api.get('/api/marcas')).body as any[];
    expect(marcas.find((m) => m.nombre === 'Marca Nueva').modelos.map((m: any) => m.nombre)).toEqual(['Modelo 1']);
  });

  it('sin permiso para crear catálogos las marcas nuevas son un error; el cliente inexistente o ambiguo queda pendiente de resolver', async () => {
    const f = filas(
      { patente: 'AD111AA', cliente_documento: '99999991', marca: 'Fiat' },
      { patente: 'AE222BB', cliente_nombre: 'Juan Pérez' },
      { patente: 'AF333CC', cliente_nombre: 'Beto Martínez' },
      { patente: 'AG444DD', cliente_codigo: 'C-002', marca: 'Marca Inexistente' },
    );
    const v = await validar(api, 'vehiculos', f, { opciones: { crear_catalogos: false } });
    expect(v.resultados.map((r) => r.accion)).toEqual(['error', 'error', 'crear', 'error']);
    expect(v.resultados[0].pendiente).toMatchObject({ tipo: 'cliente', clave: 'doc:99999991', motivo: 'inexistente' });
    expect(v.resultados[1].pendiente).toMatchObject({ clave: 'nom:juan perez', motivo: 'ambiguo' });
    expect(v.resultados[1].errores[0]).toContain('Hay 2 clientes');
    expect(v.resultados[2].avisos[0]).toContain('por nombre exacto'); // única coincidencia por nombre: avisa
    expect(v.resultados[3].errores[0]).toContain('no existe');
  });

  it('permite resolver la referencia eligiendo un cliente y rechaza clientes de otro taller', async () => {
    const pendiente = filas({ patente: 'AD111AA', cliente_documento: '99999991', marca: 'Fiat' });
    const elegido = await validar(api, 'vehiculos', pendiente, { resoluciones: { 'cliente:doc:99999991': beto.id } });
    expect(elegido.resultados[0].accion).toBe('crear');
    // Un cliente de OTRO taller no es una resolución válida
    const ajeno = (await B.api.post('/api/clientes', { nombre: 'Ajeno' })).body;
    const mal = await validar(api, 'vehiculos', pendiente, { resoluciones: { 'cliente:doc:99999991': ajeno.id } });
    expect(mal.resultados[0].accion).toBe('error');
    expect(mal.resultados[0].errores[0]).toContain('ya no existe');
    const r = await importar(api, 'vehiculos', pendiente, { resoluciones: { 'cliente:doc:99999991': beto.id } });
    expect(r.detalle.creados).toBe(1);
    expect(((await api.get('/api/vehiculos')).body as any[]).find((x) => x.patente === 'AD111AA').clientes).toBe(beto.nombre);
  });

  it('una patente existente se omite o se actualiza, pero nunca cambia sus vínculos con clientes ni baja el kilometraje', async () => {
    const o = await validar(api, 'vehiculos', filas({ patente: 'AB123CD', cliente_documento: '27456789' }));
    expect(o.resultados[0]).toMatchObject({ accion: 'omitir', motivo: 'Ya existe' });
    const otroTitular = await validar(api, 'vehiculos', filas({ patente: 'AB123CD', cliente_codigo: 'C-002', color: 'Rojo' }), { modo: 'actualizar' });
    // Sprint 23: el vehículo puede tener varios clientes; la importación actualiza datos pero no toca vínculos y lo avisa.
    expect(otroTitular.resultados[0].accion).toBe('actualizar');
    expect(otroTitular.resultados[0].avisos[0]).toContain('no modifica los vínculos');
    const km = await validar(api, 'vehiculos', filas({ patente: 'AB123CD', cliente_documento: '27456789', km: 1000, color: 'Azul' }), { modo: 'actualizar' });
    expect(km.resultados[0].accion).toBe('actualizar');
    expect(km.resultados[0].avisos[0]).toContain('menor al registrado');
    expect(km.resultados[0].cambios.map((c: any) => c.campo)).toEqual(['color']);
    const r = await importar(api, 'vehiculos', filas({ patente: 'AB123CD', cliente_documento: '27456789', km: 90000, color: 'Azul' }), { modo: 'actualizar' });
    expect(r.detalle.actualizados).toBe(1);
    expect(((await api.get('/api/vehiculos')).body as any[]).find((x) => x.patente === 'AB123CD')).toMatchObject({ km_actual: 90000, color: 'Azul', marca: 'Fiat' });
  });

  it('el cliente es opcional: un vehículo sin referencia a cliente se carga sin clientes vinculados', async () => {
    const f = filas({ patente: 'SC111SC', marca: 'Fiat', modelo: 'Palio' });
    const v = await validar(api, 'vehiculos', f);
    expect(v.resultados[0]).toMatchObject({ accion: 'crear', errores: [] });
    const r = await importar(api, 'vehiculos', f);
    expect(r.detalle).toMatchObject({ creados: 1, errores: 0 });
    const creado = ((await api.get('/api/vehiculos?sin_clientes=1')).body as any[]).find((x) => x.patente === 'SC111SC');
    expect(creado).toMatchObject({ clientes_n: 0 });
    // Con una referencia que no se puede resolver sigue siendo un error (no se descarta en silencio al cliente indicado).
    const mal = await validar(api, 'vehiculos', filas({ patente: 'SC222SC', cliente_documento: '99999991' }));
    expect(mal.resultados[0].accion).toBe('error');
  });

  it('la misma patente repetida en el archivo es un error en la segunda aparición', async () => {
    const v = await validar(api, 'vehiculos', filas({ patente: 'ZZ999ZZ', cliente_codigo: 'C-002' }, { patente: 'zz 999 zz', cliente_codigo: 'C-002' }));
    expect(v.resultados.map((r) => r.accion)).toEqual(['crear', 'error']);
  });
});

describe('artículos', () => {
  let cuitProv: string;
  beforeAll(async () => {
    cuitProv = cuit('30', '71234567');
  });
  const base = () =>
    filas(
      { nombre: 'Filtro de aceite Mann', codigo: 'FA-1', codigo_barras: '7790001', categoria: 'Filtros', unidad: 'un', costo: '1.000,00', precio: '1.800,00', proveedor_cuit: cuitProv, stock_inicial: '5' },
      { nombre: 'Aceite 10W40', codigo: 'AC-1', categoria: 'Lubricantes nuevos', unidad: 'Lts', costo: '3000', precio: '5000', alicuota_iva: '21%' },
      { nombre: 'Artículo sin código' },
    );

  it('importa el catálogo SIN movimientos de stock ni asientos: la existencia es un procedimiento aparte', async () => {
    expect((await api.post('/api/contabilidad/activar', {})).status).toBe(200); // la activación es explícita: consultar no genera nada
    const antesDiario = (await api.get(`/api/contabilidad/diario?desde=${hoyAR(-30)}&hasta=${hoyAR()}&limite=500`)).body;
    const v = await validar(api, 'articulos', base());
    expect(v.resultados.map((r) => r.accion)).toEqual(['crear', 'crear', 'crear']);
    expect(v.resultados[0].avisos.some((a: string) => a.includes('existencia'))).toBe(true);
    expect(v.resultados[1].nuevos).toEqual(['categoría Lubricantes nuevos']);
    expect(v.resultados[2].avisos[0]).toContain('Sin código');
    const r = await importar(api, 'articulos', base());
    expect(r.detalle).toMatchObject({ creados: 3, errores: 0 });
    const lista = (await api.get('/api/articulos?limite=500')).body as any[];
    const fa = lista.find((a) => a.codigo === 'FA-1');
    expect(fa).toMatchObject({ nombre: 'Filtro de aceite Mann', codigo_barras: '7790001', categoria: 'Filtros', unidad: 'un', costo: 100000, precio: 180000, stock: 0 });
    expect(fa.proveedor).toBeTruthy(); // vinculado por CUIT
    const ac = lista.find((a) => a.codigo === 'AC-1');
    expect(ac).toMatchObject({ unidad: 'lt', costo: 300000, precio: 500000, categoria: 'Lubricantes nuevos', alicuota_iva: 21 });
    expect(lista.every((a) => a.stock === 0)).toBe(true);
    expect((await api.get(`/api/articulos/${fa.id}`)).body.movimientos).toEqual([]);
    expect(((await api.get('/api/categorias-articulo')).body as any[]).some((c) => c.nombre === 'Lubricantes nuevos')).toBe(true);
    // La contabilidad no se entera de un catálogo: ni asientos ni omisiones
    await api.post('/api/contabilidad/sincronizar', { reintentar: false });
    const despuesDiario = (await api.get(`/api/contabilidad/diario?desde=${hoyAR(-30)}&hasta=${hoyAR()}&limite=500`)).body;
    expect(JSON.stringify(despuesDiario.asientos ?? despuesDiario)).toBe(JSON.stringify(antesDiario.asientos ?? antesDiario));
  });

  it('el proveedor y la categoría se resuelven sin adivinar; sin catálogos nuevos permitidos la fila falla', async () => {
    const v = await validar(api, 'articulos', filas(
      { nombre: 'Pastillas', codigo: 'PA-1', categoria: 'Frenos', proveedor_cuit: cuit('30', '99999999') },
      { nombre: 'Correa', codigo: 'CO-1', categoria: 'Categoría Inexistente' },
    ), { opciones: { crear_catalogos: false } });
    expect(v.resultados[0].accion).toBe('error');
    expect(v.resultados[0].pendiente).toMatchObject({ tipo: 'proveedor', motivo: 'inexistente' });
    expect(v.resultados[1].accion).toBe('error');
    expect(v.resultados[1].errores[0]).toContain('no existe');
  });

  it('con "carga inicial de existencias" activada se crea un movimiento de entrada trazable solo para artículos nuevos', async () => {
    const f = filas({ nombre: 'Bujía NGK', codigo: 'BU-1', costo: '800', precio: '1500', stock_inicial: '12' }, { nombre: 'Filtro de aceite Mann', codigo: 'FA-1', stock_inicial: '99' });
    const v = await validar(api, 'articulos', f, { opciones: { stock_inicial: { deposito_id: null } } });
    expect(v.resultados[0].nuevos).toContain('existencia inicial 12');
    const r = await importar(api, 'articulos', f, { opciones: { stock_inicial: { deposito_id: null } } });
    expect(r.detalle).toMatchObject({ creados: 1, omitidos: 1 });
    const lista = (await api.get('/api/articulos?limite=500')).body as any[];
    const bu = lista.find((a) => a.codigo === 'BU-1');
    expect(bu.stock).toBe(12);
    const mov = (await api.get(`/api/articulos/${bu.id}`)).body.movimientos;
    expect(mov).toHaveLength(1);
    expect(mov[0]).toMatchObject({ tipo: 'entrada', cantidad: 12, notas: 'Existencia inicial (importación)' });
    // Contabilidad: la entrada se contabiliza por el circuito de ajustes de inventario (contra "entradas sin compra a clasificar") y todo sigue cuadrando
    const sync = await api.post('/api/contabilidad/sincronizar', {});
    expect(sync.status).toBe(200);
    expect(sync.body.omitidos).toBe(0);
    const ctl = Object.fromEntries(((await api.get('/api/contabilidad/controles')).body.controles as any[]).map((c) => [c.clave, c]));
    expect(ctl.partida_doble.estado).toBe('ok');
    expect(ctl.inventario.estado, ctl.inventario.detalle).toBe('ok');
    const entradas = (await api.get(`/api/contabilidad/diario?desde=${hoyAR(-30)}&hasta=${hoyAR()}&limite=500`)).body;
    expect(entradas.asientos).toHaveLength(1);
    expect(entradas.asientos[0]).toMatchObject({ origen_tipo: 'stock_ajuste', total: 960000 }); // 12 unidades a $ 800 de costo
    expect(entradas.asientos[0].lineas.map((l: any) => l.cuenta_nombre)).toEqual(['Inventario de repuestos', expect.stringContaining('a clasificar')]);
    // El artículo que ya existía no recibió la existencia del archivo
    expect(lista.find((a) => a.codigo === 'FA-1').stock).toBe(0);
    // Y exige el permiso de ajustar stock
    const cat = await nuevoPersonal(api, 'deposito');
    expect((await api.put(`/api/taller/usuarios/${cat.id}/permisos`, { permisos: [...(await api.get(`/api/taller/usuarios/${cat.id}`)).body.permisos.filter((p: string) => p !== 'stock.ajustar'), 'datos.importar'] })).status).toBe(200);
    const sin = await cat.api.post('/api/importaciones/validar', { tipo: 'articulos', modo: 'omitir', opciones: { stock_inicial: { deposito_id: null } }, filas: filas({ nombre: 'X Y' }) });
    expect(sin.status).toBe(403);
  });

  it('actualizar muestra costo y precio antes/después, no cambia códigos y no cambia la unidad con movimientos', async () => {
    const u = await validar(api, 'articulos', filas({ nombre: 'Filtro de aceite Mann', codigo: 'FA-1', precio: '2.000,00', costo: '1.100,00', ubicacion: 'B3' }), { modo: 'actualizar' });
    expect(u.resultados[0].accion).toBe('actualizar');
    expect(u.resultados[0].cambios).toEqual(expect.arrayContaining([{ campo: 'costo', antes: '1000,00', despues: '1100,00' }, { campo: 'precio de venta', antes: '1800,00', despues: '2000,00' }, { campo: 'ubicación', antes: null, despues: 'B3' }]));
    await importar(api, 'articulos', filas({ nombre: 'Filtro de aceite Mann', codigo: 'FA-1', precio: '2.000,00', costo: '1.100,00', ubicacion: 'B3' }), { modo: 'actualizar' });
    const fa = ((await api.get('/api/articulos?limite=500')).body as any[]).find((a) => a.codigo === 'FA-1');
    expect(fa).toMatchObject({ costo: 110000, precio: 200000, ubicacion: 'B3' });
    // El código de barras del archivo no coincide con el del artículo; y un código con el barras de otro es ambiguo
    const c1 = await validar(api, 'articulos', filas({ nombre: 'x y', codigo: 'FA-1', codigo_barras: 'OTRO' }), { modo: 'actualizar' });
    expect(c1.resultados[0].errores[0]).toContain('no coincide');
    const c2 = await validar(api, 'articulos', filas({ nombre: 'x y', codigo: 'AC-1', codigo_barras: '7790001' }), { modo: 'actualizar' });
    expect(c2.resultados[0].errores[0]).toContain('artículos distintos');
    // La unidad de un artículo con movimientos no se toca
    const bu = await validar(api, 'articulos', filas({ nombre: 'Bujía NGK', codigo: 'BU-1', unidad: 'Lts' }), { modo: 'actualizar' });
    expect(bu.resultados[0].errores[0]).toContain('movimientos de stock');
  });

  it('rechaza códigos de barras deformados por Excel, importes inválidos y repetidos del archivo', async () => {
    const v = await validar(api, 'articulos', filas(
      { nombre: 'Uno', codigo: 'X-1', codigo_barras: '7.79E+12' },
      { nombre: 'Dos', codigo: 'X-2', costo: 'abc' },
      { nombre: 'Tres', codigo: 'x-3' },
      { nombre: 'Tres repetido', codigo: 'X-3' },
    ));
    expect(v.resultados.map((r) => r.accion)).toEqual(['error', 'error', 'crear', 'error']);
    expect(v.resultados[0].errores[0]).toContain('notación científica');
    expect(v.resultados[3].errores[0]).toContain('Duplicado');
  });

  it('quien no puede ver costos no puede importarlos', async () => {
    const dep = await nuevoPersonal(api, 'deposito');
    const perm = ((await api.get(`/api/taller/usuarios/${dep.id}`)).body.permisos as string[]).filter((p) => p !== 'precios.costo.ver' && p !== 'margenes.ver' && p !== 'stock.valorizar');
    expect((await api.put(`/api/taller/usuarios/${dep.id}/permisos`, { permisos: [...perm, 'datos.importar'] })).status).toBe(200);
    const r = await dep.api.post('/api/importaciones/validar', { tipo: 'articulos', modo: 'omitir', opciones: {}, filas: filas({ nombre: 'Algo', costo: '100' }) });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toContain('costos');
    expect((await dep.api.post('/api/importaciones/validar', { tipo: 'articulos', modo: 'omitir', opciones: {}, filas: filas({ nombre: 'Algo', precio: '100' }) })).status).toBe(200);
  });
});

describe('límites y validación de entrada en el servidor', () => {
  it('rechaza lotes grandes, totales excesivos, huellas inválidas, filas repetidas y cuerpos enormes', async () => {
    const f = Array.from({ length: 51 }, (_, i) => ({ n: i + 2, v: { nombre: `X${i} Y` } }));
    expect((await api.post('/api/importaciones/validar', { tipo: 'clientes', modo: 'omitir', opciones: {}, filas: f })).status).toBe(400);
    const base = { tipo: 'clientes', modo: 'omitir', opciones: {}, archivo: { nombre: 'a.csv', hash: hash(), bytes: 10 } };
    expect((await api.post('/api/importaciones', { ...base, total_filas: 5001 })).status).toBe(400);
    expect((await api.post('/api/importaciones', { ...base, total_filas: 0 })).status).toBe(400);
    expect((await api.post('/api/importaciones', { ...base, archivo: { ...base.archivo, hash: 'zz' }, total_filas: 10 })).status).toBe(400);
    expect((await api.post('/api/importaciones', { ...base, archivo: { ...base.archivo, bytes: 6 * 1024 * 1024 }, total_filas: 10 })).status).toBe(400);
    expect((await api.post('/api/importaciones', { ...base, tipo: 'bancos', total_filas: 10 })).status).toBe(400);
    expect((await api.post('/api/importaciones/validar', { tipo: 'clientes', modo: 'omitir', opciones: {}, filas: [{ n: 2, v: { nombre: 'Ana' } }, { n: 2, v: { nombre: 'Beto' } }] })).status).toBe(400);
    expect((await api.post('/api/importaciones/validar', { tipo: 'clientes', modo: 'omitir', opciones: {}, filas: [], relleno: 'x'.repeat(650_000) })).status).toBe(413);
    // Un lote más allá de las filas informadas
    const job = await api.post('/api/importaciones', { ...base, total_filas: 3 });
    expect((await api.post(`/api/importaciones/${job.body.id}/lotes/1`, { filas: filas({ nombre: 'Ana Q' }) })).status).toBe(400);
    expect((await api.post(`/api/importaciones/${job.body.id}/cancelar`)).status).toBe(200);
    expect((await api.post(`/api/importaciones/${job.body.id}/lotes/0`, { filas: filas({ nombre: 'Ana Q' }) })).status).toBe(409);
  });

  it('ignora columnas desconocidas y celdas que no son datos del tipo: no se puede colar un campo interno', async () => {
    const v = await validar(api, 'clientes', filas({ nombre: 'Colado Raro', taller_id: 'otro-taller', id: 'x', activo: 0, codigo: 777, notas: 'ok' }));
    expect(v.resultados[0].accion).toBe('crear');
    const r = await importar(api, 'clientes', filas({ nombre: 'Colado Raro', taller_id: 'otro-taller', id: 'x', activo: 0, codigo: 777, notas: 'ok' }));
    expect(r.detalle.creados).toBe(1);
    const c = (await clientes(api, 'Colado Raro'))[0];
    expect(c.codigo).not.toBe(777);
    expect(c.activo).toBe(1);
  });
});

describe('aislamiento entre talleres', () => {
  it('lo importado en un taller no se ve ni se modifica desde otro, aunque coincidan los identificadores', async () => {
    const antesA = (await clientes(api)).length;
    // El otro taller importa el mismo documento y la misma patente: son registros suyos
    const rb = await importar(B.api, 'clientes', filas({ nombre: 'Ana del Otro Taller', documento: '27456789', telefono: '000' }));
    expect(rb.detalle).toMatchObject({ creados: 1, omitidos: 0 });
    const rv = await importar(B.api, 'vehiculos', filas({ patente: 'AB123CD', cliente_documento: '27456789' }));
    expect(rv.detalle).toMatchObject({ creados: 1, errores: 0 });
    expect((await clientes(api)).length).toBe(antesA);
    expect((await clientes(api)).find((c) => c.documento === '27456789').nombre).toBe('Ana Gómez');
    // Actualizar desde el otro taller solo toca sus propios registros
    await importar(B.api, 'clientes', filas({ nombre: 'Ana del Otro Taller', documento: '27456789', telefono: '111' }), { modo: 'actualizar' });
    expect((await clientes(api)).find((c) => c.documento === '27456789').telefono).toBe('11 9999-0000');
    expect((await clientes(B.api)).find((c) => c.documento === '27456789').telefono).toBe('111');
    // Las importaciones de uno no figuran en el historial del otro y sus ids no se pueden usar
    const histA = (await api.get('/api/importaciones')).body as any[];
    const histB = (await B.api.get('/api/importaciones')).body as any[];
    expect(histB.every((h) => !histA.some((x) => x.id === h.id))).toBe(true);
    const idA = histA[0].id;
    expect((await B.api.get(`/api/importaciones/${idA}`)).status).toBe(404);
    expect((await B.api.post(`/api/importaciones/${idA}/lotes/0`, { filas: filas({ nombre: 'Intruso' }) })).status).toBe(404);
    expect((await B.api.post(`/api/importaciones/${idA}/finalizar`)).status).toBe(404);
    expect((await B.api.post(`/api/importaciones/${idA}/cancelar`)).status).toBe(404);
  });
});
