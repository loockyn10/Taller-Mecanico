// Catálogo automotor: lectura compartida y alta de vehículos desde el catálogo o a mano, sin pisar lo que el taller ya tenía.
import { beforeAll, describe, expect, it } from 'vitest';
import { nuevoTaller, sqlLocal } from './cliente';

beforeAll(async () => {
  // Fixture mínimo en la base local de ensayo (el catálogo real se carga con `npm run catalogo -- cargar`).
  await sqlLocal(`
    INSERT OR REPLACE INTO cat_marcas (id, nombre, clave, busqueda, codigos, n) VALUES ('ma_t_vw', 'Volkswagen', 'volkswagen', 'vw', '["53","136"]', 100), ('ma_t_toyota', 'Toyota', 'toyota', NULL, '["130"]', 90), ('ma_t_zanella', 'Zanella', 'zanella', NULL, '["1"]', 5);
    INSERT OR REPLACE INTO cat_modelos (id, marca_id, nombre, clave, tipo, anios, n) VALUES
      ('mo_t_amarok', 'ma_t_vw', 'Amarok', 'amarok', 'Pick-up', '2018,2019,2020', 80),
      ('mo_t_goltrend', 'ma_t_vw', 'Gol Trend', 'goltrend', 'Sedan 5 puertas', '2017,2018', 70),
      ('mo_t_hilux', 'ma_t_toyota', 'Hilux', 'hilux', 'Pick-up', '2020,2021', 60),
      ('mo_t_ztruck', 'ma_t_zanella', 'Z-Truck', 'ztruck', 'Camion', '2019', 4),
      ('mo_t_zotro', 'ma_t_zanella', 'Otro Zanella', 'otrozanella', NULL, '2019', 1);
    INSERT OR REPLACE INTO cat_versiones (id, modelo_id, descripcion, version, motorizacion, combustible, tipo, codigos, anios, n) VALUES
      ('ve_t_1', 'mo_t_amarok', 'AMAROK HIGHLINE V6 3.0L 258 CV', 'HIGHLINE V6 3.0L 258 CV', '3.0 V6', NULL, 'Pick-up', '["53/8T/20"]', '2019,2020', 50),
      ('ve_t_2', 'mo_t_amarok', 'AMAROK TRENDLINE TDI MT 4X2', 'TRENDLINE TDI MT 4X2', 'TDI', 'Diésel', 'Pick-up', '["53/A3/20"]', '2018,2019', 30),
      ('ve_t_3', 'mo_t_hilux', 'HILUX 4X4 DC SRV 2.8 TDI', '4X4 DC SRV 2.8 TDI', '2.8 TDI', 'Diésel', 'Pick-up', '["68/BM/20"]', '2020,2021', 40);
    INSERT OR REPLACE INTO cat_meta (clave, valor) VALUES ('licencia', 'Creative Commons Attribution 4.0 (CC BY 4.0)');
  `);
});

describe('catálogo automotor', () => {
  it('se lee sin servicios externos, requiere sesión y es de sólo lectura', async () => {
    const { api } = await nuevoTaller('Taller catálogo');
    const marcas = await api.get('/api/catalogo-auto/marcas');
    expect(marcas.status).toBe(200);
    expect(marcas.body.map((m: any) => m.nombre)).toEqual(expect.arrayContaining(['Volkswagen', 'Toyota']));
    const vw = marcas.body.find((m: any) => m.nombre === 'Volkswagen');
    expect(vw.busqueda).toBe('vw');
    const modelos = await api.get(`/api/catalogo-auto/marcas/${vw.id}/modelos`);
    expect(modelos.body.map((m: any) => m.nombre)).toEqual(['Amarok', 'Gol Trend']);
    expect(modelos.body[0].anios).toEqual([2018, 2019, 2020]);
    const det = await api.get('/api/catalogo-auto/modelos/mo_t_amarok');
    expect(det.body.versiones.map((v: any) => v.id)).toEqual(['ve_t_1', 've_t_2']);
    expect(det.body.fichas).toBe(0);
    expect((await api.get('/api/catalogo-auto/modelos/no-existe')).status).toBe(404);
    // El caché de una hora es sólo del catálogo: los datos del taller nunca se guardan en el navegador
    const cab = async (ruta: string) => (await fetch(`http://127.0.0.1:8799${ruta}`, { headers: { cookie: api.cookie, 'cf-connecting-ip': api.ip } })).headers.get('cache-control');
    expect(await cab('/api/catalogo-auto/marcas')).toContain('max-age=3600');
    for (const ruta of ['/api/clientes', '/api/marcas', '/api/vehiculos', '/api/fotos/estado']) expect(await cab(ruta), ruta).toBe('no-store');
    expect((await api.get('/api/catalogo-auto/info')).body.licencia).toContain('CC BY 4.0');
    expect((await api.post('/api/catalogo-auto/marcas', { nombre: 'X' })).status).toBe(404);
    const anonimo = await (await fetch(`http://127.0.0.1:8799/api/catalogo-auto/marcas`)).status;
    expect(anonimo).toBe(401);
  });

  it('un vehículo elegido del catálogo crea sólo la marca y el modelo usados y los reutiliza después', async () => {
    const { api } = await nuevoTaller('Taller alta catálogo');
    expect((await api.get('/api/marcas')).body.some((m: any) => m.nombre === 'Zanella')).toBe(false);
    const c = await api.post('/api/clientes', { nombre: 'Cliente Catálogo' });
    const v1 = await api.post('/api/vehiculos', { cliente_id: c.body.id, patente: 'AA111AA', cat_modelo_id: 'mo_t_ztruck', version: 'Furgón', anio: 2019 });
    expect(v1.status).toBe(201);
    expect(v1.body).toMatchObject({ marca: 'Zanella', modelo: 'Z-Truck', version: 'Furgón', cat_modelo_id: 'mo_t_ztruck', modelo_cat_id: 'mo_t_ztruck', marca_cat_id: 'ma_t_zanella' });
    const v2 = await api.post('/api/vehiculos', { cliente_id: c.body.id, patente: 'AA222AA', cat_modelo_id: 'mo_t_ztruck' });
    expect(v2.body.marca_id).toBe(v1.body.marca_id);
    expect(v2.body.modelo_id).toBe(v1.body.modelo_id);
    const zan = (await api.get('/api/marcas')).body.filter((m: any) => m.nombre === 'Zanella');
    expect(zan).toHaveLength(1);
    // Sólo se materializó lo usado: el otro modelo del catálogo no se copió al taller
    expect(zan[0].modelos.map((m: any) => m.nombre)).toEqual(['Z-Truck']);
  });

  it('reutiliza la marca y el modelo que el taller ya había cargado a mano, sin renombrarlos', async () => {
    const { api } = await nuevoTaller('Taller con marcas propias');
    const marca = await api.post('/api/marcas', { nombre: 'ZANELLA' });
    const modelo = await api.post('/api/modelos', { marca_id: marca.body.id, nombre: 'z-truck' });
    const c = await api.post('/api/clientes', { nombre: 'Otro Cliente' });
    const v = await api.post('/api/vehiculos', { cliente_id: c.body.id, patente: 'AB123AB', cat_modelo_id: 'mo_t_ztruck' });
    expect(v.body.marca_id).toBe(marca.body.id);
    expect(v.body.modelo_id).toBe(modelo.body.id);
    expect(v.body).toMatchObject({ marca: 'ZANELLA', modelo: 'z-truck' });
    expect((await api.get('/api/marcas')).body.filter((m: any) => m.nombre.toLowerCase() === 'zanella')).toHaveLength(1);
    // La plantilla inicial del taller (Volkswagen, etc.) también se reutiliza
    const w = await api.post('/api/vehiculos', { cliente_id: c.body.id, patente: 'AB124AB', cat_modelo_id: 'mo_t_amarok' });
    expect((await api.get('/api/marcas')).body.filter((m: any) => m.nombre === 'Volkswagen')).toHaveLength(1);
    expect(w.body).toMatchObject({ marca: 'Volkswagen', modelo: 'Amarok' });
  });

  it('permite registrar a mano una marca y un modelo que no están en el catálogo', async () => {
    const { api } = await nuevoTaller('Taller manual');
    const c = await api.post('/api/clientes', { nombre: 'Cliente Manual' });
    const v = await api.post('/api/vehiculos', { cliente_id: c.body.id, patente: 'ZZ999ZZ', marca_texto: 'Marca Rara', modelo_texto: 'Modelo Único', version: 'Edición especial', anio: 2001 });
    expect(v.status).toBe(201);
    expect(v.body).toMatchObject({ marca: 'Marca Rara', modelo: 'Modelo Único', version: 'Edición especial', cat_modelo_id: null });
    // Marca del catálogo con un modelo que el catálogo no tiene
    const w = await api.post('/api/vehiculos', { cliente_id: c.body.id, patente: 'ZZ998ZZ', cat_marca_id: 'ma_t_vw', modelo_texto: 'Modelo Nuevo' });
    expect(w.body).toMatchObject({ marca: 'Volkswagen', modelo: 'Modelo Nuevo', cat_modelo_id: null });
    // Un modelo sin marca no tiene dónde colgarse
    const sinMarca = await api.post('/api/vehiculos', { cliente_id: c.body.id, patente: 'ZZ997ZZ', modelo_texto: 'Huérfano' });
    expect(sinMarca.status).toBe(400);
  });

  it('valida los ids del catálogo y mantiene intactos los vehículos al editar otros datos', async () => {
    const { api } = await nuevoTaller('Taller edición');
    const c = await api.post('/api/clientes', { nombre: 'Cliente Edición' });
    expect((await api.post('/api/vehiculos', { cliente_id: c.body.id, patente: 'EE111EE', cat_modelo_id: 'no-existe' })).status).toBe(400);
    expect((await api.post('/api/vehiculos', { cliente_id: c.body.id, patente: 'EE112EE', cat_modelo_id: 'mo_t_amarok', cat_version_id: 've_t_3' })).status).toBe(400);
    const marca = await api.post('/api/marcas', { nombre: 'Citroen' });
    const modelo = await api.post('/api/modelos', { marca_id: marca.body.id, nombre: 'C3' });
    const v = await api.post('/api/vehiculos', { cliente_id: c.body.id, patente: 'EE113EE', marca_id: marca.body.id, modelo_id: modelo.body.id, anio: 2012, notas: 'viejo' });
    expect(v.status).toBe(201);
    // Editar sin tocar marca/modelo: no se pierde nada
    const e1 = await api.put(`/api/vehiculos/${v.body.id}`, { km_actual: 1000, color: 'rojo' });
    expect(e1.body).toMatchObject({ marca: 'Citroen', modelo: 'C3', anio: 2012, notas: 'viejo', color: 'rojo' });
    // Pasarlo al catálogo cambia sólo ese vehículo; la marca anterior del taller sigue existiendo
    const e2 = await api.put(`/api/vehiculos/${v.body.id}`, { cat_modelo_id: 'mo_t_hilux', cat_version_id: 've_t_3', version: '4X4 DC SRV 2.8 TDI' });
    expect(e2.body).toMatchObject({ marca: 'Toyota', modelo: 'Hilux', version: '4X4 DC SRV 2.8 TDI', cat_version_id: 've_t_3' });
    expect((await api.get('/api/marcas')).body.some((m: any) => m.nombre === 'Citroen' && m.modelos.some((x: any) => x.nombre === 'C3'))).toBe(true);
    // Volver a escribir a mano desvincula del catálogo
    const e3 = await api.put(`/api/vehiculos/${v.body.id}`, { marca_texto: 'Toyota', modelo_texto: 'Hilux Especial', cat_modelo_id: null, cat_version_id: null, version: null });
    expect(e3.body).toMatchObject({ marca: 'Toyota', modelo: 'Hilux Especial', cat_modelo_id: null, version: null });
  });
});
