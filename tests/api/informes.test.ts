// Informes (venta → reportes), registros internos de contabilidad y configuración administrativa.
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, hoyAR, idem, nuevoTaller, nuevoUsuario } from './cliente';

let api: Api;
let emp: Api;
let B: Awaited<ReturnType<typeof nuevoTaller>>;
let cliente: any;
let art: any;
let prov: any;
const hoy = hoyAR();
const periodo = `desde=${hoy}&hasta=${hoy}`;
const informe = async (tipo: string, q = '', a: Api = api) => a.get(`/api/informes/${tipo}?${periodo}${q}`);

beforeAll(async () => {
  ({ api } = await nuevoTaller('Taller Informes', 2));
  emp = await nuevoUsuario(api, 'empleado');
  B = await nuevoTaller('Taller Informes B');
  cliente = (await api.post('/api/clientes', { nombre: 'Cliente Informes' })).body;
  prov = (await api.post('/api/proveedores', { nombre: 'Prov Informes', cuit: '30-71234567-1' })).body;
  const cat = (await api.post('/api/categorias-articulo', { nombre: 'Frenos y más' })).body;
  art = (await api.post('/api/articulos', { nombre: 'Pastillas Informe', categoria_id: cat.id, costo: 4000, precio: 10000, stock_inicial: 50, proveedor_id: prov.id })).body;
  // Dos ventas: una de contado en efectivo con IVA 21 % (3 pastillas + servicio) y otra a cuenta corriente
  await api.post('/api/ventas', { cliente_id: cliente.id, iva_pct: 21, items: [{ tipo: 'articulo', articulo_id: art.id, descripcion: 'Pastillas Informe', cantidad: 3, precio_unitario: 10000 }, { tipo: 'libre', descripcion: 'Colocación', cantidad: 1, precio_unitario: 20000 }], cobro: { medio: 'efectivo' }, idem_key: idem() });
  await api.post('/api/ventas', { cliente_id: cliente.id, condicion: 'cuenta_corriente', items: [{ tipo: 'articulo', articulo_id: art.id, descripcion: 'Pastillas Informe', cantidad: 2, precio_unitario: 10000 }], idem_key: idem() });
  await api.post('/api/compras', { proveedor_id: prov.id, numero_doc: '0001-00000010', iva: 21000, items: [{ articulo_id: art.id, cantidad: 10, costo_unitario: 10000 }], idem_key: idem() });
  const cats = (await api.get('/api/categorias-gasto')).body;
  await api.post('/api/gastos', { categoria_id: cats[0].id, concepto: 'Alquiler del mes', importe: 15000, medio: 'efectivo', idem_key: idem() });
});

describe('venta → reportes (datos reales)', () => {
  it('ventas por período, por comprobante, artículo, categoría y rentabilidad coinciden entre sí', async () => {
    const dia = (await informe('ventas')).body;
    expect(dia.totales).toMatchObject({ comprobantes: 2, total: 60500 + 20000 });
    expect(dia.filas).toHaveLength(1);
    const det = (await informe('ventas', '&agrupar=detalle')).body;
    expect(det.filas).toHaveLength(2);
    expect(det.totales.total).toBe(dia.totales.total);
    const porArt = (await informe('ventas-articulo')).body;
    expect(porArt.filas[0]).toMatchObject({ articulo: 'Pastillas Informe', categoria: 'Frenos y más', cantidad: 5, total: 50000 });
    const cat = (await informe('ventas-categoria')).body;
    expect(cat.filas.map((f: any) => f.categoria).sort()).toEqual(['Frenos y más', 'Servicios y mano de obra']);
    const ren = (await informe('rentabilidad')).body;
    // El costo del artículo pasó a 10000 con la compra: 5 u × 10000
    expect(ren.filas[0]).toMatchObject({ total: 50000, costo: 50000, margen: 0 });
    expect(ren.columnas.map((c: any) => c.clave)).toContain('margen_pct');
    const top = (await informe('mas-vendidos')).body;
    expect(top.filas[0].articulo).toBe('Pastillas Informe');
    const srv = (await informe('servicios')).body;
    expect(srv.filas[0]).toMatchObject({ servicio: 'Colocación', cantidad: 1, total: 20000 });
  });

  it('cobranzas, deudores, compras, gastos, proveedores, inventario y actividad financiera', async () => {
    const cob = (await informe('cobranzas', '&agrupar=medio')).body;
    expect(cob.filas).toEqual([{ medio: 'efectivo', cantidad: 1, importe: 60500 }]);
    const deu = (await informe('deudores')).body;
    expect(deu.filas[0]).toMatchObject({ cliente: 'Cliente Informes', saldo: 20000 });
    expect((await informe('deudores', '&cliente_id=inexistente')).body.filas).toEqual([]);
    const co = (await informe('compras')).body;
    expect(co.filas[0]).toMatchObject({ proveedor: 'Prov Informes', comprobante: '0001-00000010', iva: 21000, total: 121000 });
    expect((await informe('compras', '&agrupar=proveedor')).body.totales.total).toBe(121000);
    expect((await informe('gastos')).body.totales.importe).toBe(15000);
    expect((await informe('gastos', '&agrupar=detalle')).body.filas[0].concepto).toBe('Alquiler del mes');
    expect((await informe('proveedores')).body.filas[0]).toMatchObject({ proveedor: 'Prov Informes', saldo: 121000 });
    const inv = (await informe('inventario-valorizado')).body;
    expect(inv.filas[0]).toMatchObject({ articulo: 'Pastillas Informe', stock: 55, costo: 10000, valor_costo: 550000, valor_venta: 550000 });
    const fin = (await informe('actividad-financiera')).body;
    expect(fin.totales).toMatchObject({ ingresos: 60500, egresos: 15000, resultado: 45500 });
    expect((await informe('ordenes')).status).toBe(200);
    expect((await informe('mecanicos')).status).toBe(200);
  });

  it('filtros por cliente, artículo, categoría y estado; períodos inválidos; informe inexistente', async () => {
    expect((await informe('ventas', '&cliente_id=otro')).body.totales.total).toBe(0);
    expect((await informe('ventas-articulo', `&articulo_id=${art.id}`)).body.filas).toHaveLength(1);
    expect((await informe('ventas-articulo', '&categoria_id=sin')).body.filas).toHaveLength(0);
    expect((await informe('ventas', '&estado=anulada')).body.filas).toEqual([]);
    expect((await api.get(`/api/informes/ventas?desde=${hoyAR(1)}&hasta=${hoy}`)).status).toBe(400);
    expect((await api.get('/api/informes/ventas')).status).toBe(400);
    expect((await informe('no-existe')).status).toBe(404);
  });

  it('los informes con costos o finanzas exigen permiso y otro taller ve los suyos en cero', async () => {
    expect((await informe('ventas', '', emp)).status).toBe(403);
    expect((await informe('inventario-valorizado', '', emp)).status).toBe(403);
    const b = (await informe('ventas', '', B.api)).body;
    expect(b.totales.total).toBe(0);
    expect((await informe('ventas-articulo', '', B.api)).body.filas).toEqual([]);
    expect((await informe('proveedores', '', B.api)).body.filas).toEqual([]);
    expect((await informe('cobranzas', '', B.api)).body.filas).toEqual([]);
  });
});

describe('registros internos de contabilidad', () => {
  it('libro de ventas con desglose de IVA por alícuota y aviso de que no es un libro fiscal', async () => {
    const l = (await api.get(`/api/contabilidad/libro-ventas?${periodo}`)).body;
    expect(l.nota).toMatch(/no es un libro fiscal/i);
    expect(l.filas).toHaveLength(2);
    expect(l.filas.every((f: any) => f.tipo === 'Comprobante interno')).toBe(true);
    expect(l.totales).toMatchObject({ comprobantes: 2, neto: 70000, iva: 10500 });
    expect(l.por_alicuota.find((a: any) => a.iva_pct === 21)).toMatchObject({ neto: 50000, iva: 10500 });
    expect(l.por_alicuota.find((a: any) => a.iva_pct === 0)).toMatchObject({ neto: 20000, iva: 0 });
  });

  it('libro de compras sin duplicar facturas asociadas, y resumen de ingresos/egresos con impuestos', async () => {
    const compra = (await api.get('/api/compras')).body[0];
    await api.post('/api/facturas-proveedor', { proveedor_id: prov.id, tipo: 'factura_a', nro_comprobante: '1-10', fecha: hoy, compra_id: compra.id, neto_gravado: 100000, iva_21: 21000, total: 121000, idem_key: idem() });
    await api.post('/api/facturas-proveedor', { proveedor_id: prov.id, tipo: 'factura_a', nro_comprobante: '1-11', fecha: hoy, neto_gravado: 50000, iva_10_5: 5250, total: 55250, idem_key: idem() });
    const l = (await api.get(`/api/contabilidad/libro-compras?${periodo}`)).body;
    expect(l.filas).toHaveLength(2); // la compra (con su factura asociada) + la factura independiente
    expect(l.filas.find((f: any) => f.origen === 'Compra').comprobante).toBe('0001-00000010');
    expect(l.totales).toMatchObject({ total: 121000 + 55250, iva_10_5: 5250, iva_otros: 21000, comprobantes: 2 });
    const r = (await api.get(`/api/contabilidad/resumen?${periodo}`)).body;
    expect(r.ingresos).toMatchObject({ cobros: 60500, total: 60500 });
    expect(r.egresos).toMatchObject({ gastos: 15000, total: 15000 });
    expect(r.resultado).toBe(45500);
    expect(r.impuestos_registrados).toMatchObject({ iva_ventas: 10500, iva_compras: 21000 + 5250, saldo_informativo: 10500 - 26250 });
    expect(r.devengado.ventas_netas).toBe(70000);
  });

  it('registro consolidado de operaciones: una fila por hecho y filtros', async () => {
    const o = (await api.get(`/api/contabilidad/operaciones?${periodo}`)).body;
    const tipos = o.filas.map((f: any) => f.tipo);
    expect(tipos.filter((t: string) => t === 'venta')).toHaveLength(2);
    expect(tipos.filter((t: string) => t === 'cobro')).toHaveLength(1);
    expect(tipos.filter((t: string) => t === 'compra')).toHaveLength(1);
    expect(tipos.filter((t: string) => t === 'gasto')).toHaveLength(1);
    expect(o.filas.find((f: any) => f.tipo === 'factura_proveedor' && f.efecto === 'informativo')).toBeTruthy();
    expect((await api.get(`/api/contabilidad/operaciones?${periodo}&tipo=gasto`)).body.filas).toHaveLength(1);
    expect((await api.get(`/api/contabilidad/operaciones?${periodo}&q=Alquiler`)).body.filas).toHaveLength(1);
    expect((await emp.get(`/api/contabilidad/libro-ventas?${periodo}`)).status).toBe(403);
    expect((await B.api.get(`/api/contabilidad/operaciones?${periodo}`)).body.filas).toEqual([]);
    expect((await B.api.get(`/api/contabilidad/libro-ventas?${periodo}`)).body.filas).toEqual([]);
  });
});

describe('configuración administrativa', () => {
  it('guarda datos fiscales, pies de documentos, parámetros y medios de pago por taller', async () => {
    const cfg = (await api.get('/api/taller/config')).body;
    expect(cfg.config.iva_default).toBe(0); // monotributo por defecto: no discrimina IVA
    const r = await api.put('/api/taller/config', {
      taller: { ...cfg.taller, cuit: '30-71234567-1', condicion_iva: 'responsable_inscripto', ingresos_brutos: '901-123456-7', inicio_actividades: '2019-03-01', sitio_web: 'www.ejemplo.com' },
      config: { ...cfg.config, permitir_stock_negativo: !!cfg.config.permitir_stock_negativo, caja_obligatoria: !!cfg.config.caja_obligatoria, iva_default: 21, recargo_default: 5, pie_recibo: 'Gracias por su pago', pie_orden_compra: 'Entregar en el taller', tolerancia_caja: 500, alerta_cheques_dias: 10, plazo_pago_dias: 15, medios_pago: ['transferencia', 'cheque'] },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const n = (await api.get('/api/taller/config')).body;
    expect(n.taller).toMatchObject({ ingresos_brutos: '901-123456-7', inicio_actividades: '2019-03-01', sitio_web: 'www.ejemplo.com' });
    expect(n.config).toMatchObject({ iva_default: 21, recargo_default: 5, pie_recibo: 'Gracias por su pago', tolerancia_caja: 500, alerta_cheques_dias: 10, plazo_pago_dias: 15 });
    expect(n.config.medios_pago).toEqual(['efectivo', 'transferencia', 'cheque']); // el efectivo no se puede deshabilitar
    // El taller B no se ve afectado
    expect((await B.api.get('/api/taller/config')).body.config).toMatchObject({ recargo_default: 0, medios_pago: null });
    const cfgOk = { ...n.config, permitir_stock_negativo: !!n.config.permitir_stock_negativo, caja_obligatoria: !!n.config.caja_obligatoria };
    expect((await emp.put('/api/taller/config', { taller: n.taller, config: cfgOk })).status).toBe(403);
    expect((await api.put('/api/taller/config', { taller: { ...n.taller, cuit: '20-12345678-0' }, config: cfgOk })).status).toBe(400);
  });

  it('los medios deshabilitados se rechazan en cobros y pagos', async () => {
    const venta = (await api.post('/api/ventas', { cliente_id: cliente.id, condicion: 'cuenta_corriente', items: [{ tipo: 'libre', descripcion: 'X', cantidad: 1, precio_unitario: 1000 }], idem_key: idem() })).body;
    const cobro = (medio: string) => api.post('/api/cobros', { cliente_id: cliente.id, medios: [{ medio, importe: 1000 }], aplicaciones: [{ venta_id: venta.id, importe: 1000 }], idem_key: idem() });
    expect((await cobro('debito')).status).toBe(400);
    expect((await api.post('/api/pagos-proveedor', { proveedor_id: prov.id, importe: 100, medio: 'credito', permitir_anticipo: true, idem_key: idem() })).status).toBe(400);
    expect((await cobro('efectivo')).status).toBe(201);
  });

  it('la tolerancia de caja permite cerrar con diferencias chicas sin justificarlas', async () => {
    await api.post('/api/caja/abrir', { saldo_inicial: 10000 });
    const est = (await api.get('/api/caja/estado')).body.sesion.resumen.efectivo_esperado;
    const chica = await api.post('/api/caja/cerrar', { declarados: [{ medio: 'efectivo', importe: est - 300 }] });
    expect(chica.status).toBe(200); // $3 de diferencia: dentro de la tolerancia de $5
    await api.post('/api/caja/abrir', { saldo_inicial: 10000 });
    const e2 = (await api.get('/api/caja/estado')).body.sesion.resumen.efectivo_esperado;
    expect((await api.post('/api/caja/cerrar', { declarados: [{ medio: 'efectivo', importe: e2 - 600 }] })).status).toBe(400);
  });
});
