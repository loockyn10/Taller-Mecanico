// Flujo completo: cliente → vehículo → presupuesto → OT → finalizar (stock) → comprobante → cobros → entrega → historial.
import { beforeAll, describe, expect, it } from 'vitest';
import { Api, idem, nuevoTaller } from './cliente';

// Fecha comercial argentina (la API usa UTC-3 para las fechas de negocio).
const hoyAR = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);

let api: Api;
const ctx: Record<string, any> = {};

beforeAll(async () => {
  ({ api } = await nuevoTaller('Taller Flujo'));
});

describe('flujo operativo completo', () => {
  it('crea cliente y vehículo asociado', async () => {
    const c = await api.post('/api/clientes', { nombre: 'Juana Pérez', telefono: '1155550000', documento: '30111222' });
    expect(c.status).toBe(201);
    expect(c.body.codigo).toBe(1);
    ctx.cliente = c.body;
    const marcas = (await api.get('/api/marcas')).body;
    const vw = marcas.find((m: any) => m.nombre === 'Volkswagen');
    ctx.marca = vw;
    const v = await api.post('/api/vehiculos', { cliente_id: c.body.id, patente: 'ab 123 cd', marca_id: vw.id, modelo_id: vw.modelos[0].id, anio: 2019, km_actual: 50000 });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    expect(v.body.patente).toBe('AB123CD');
    expect(v.body.clientes).toBe('Juana Pérez'); // el cliente de contacto es un vínculo vigente, no un campo del vehículo
    ctx.vehiculo = v.body;
    const dup = await api.post('/api/vehiculos', { cliente_id: c.body.id, patente: 'AB123CD' });
    expect(dup.status).toBe(409);
    const det = await api.get(`/api/clientes/${c.body.id}`);
    expect(det.body.vehiculos).toHaveLength(1);
  });

  it('crea artículo con stock inicial registrado como movimiento', async () => {
    const a = await api.post('/api/articulos', { nombre: 'Filtro de aceite X', codigo: 'FA-1', costo: 500000, precio: 800000, stock_inicial: 5, stock_minimo: 2 });
    expect(a.status).toBe(201);
    ctx.articulo = a.body.id;
    const det = await api.get(`/api/articulos/${a.body.id}`);
    expect(det.body.stock).toBe(5);
    expect(det.body.movimientos).toHaveLength(1);
    const servicios = (await api.get('/api/servicios')).body;
    ctx.servicio = servicios.find((s: any) => s.nombre.startsWith('Service de aceite'));
    expect(ctx.servicio.intervalo_km).toBe(10000);
  });

  it('crea presupuesto con totales calculados por el servidor', async () => {
    const p = await api.post('/api/presupuestos', {
      cliente_id: ctx.cliente.id,
      vehiculo_id: ctx.vehiculo.id,
      km: 51000,
      iva_pct: 21,
      items: [
        { tipo: 'articulo', articulo_id: ctx.articulo, descripcion: 'Filtro de aceite X', cantidad: 2, precio_unitario: 800000, subtotal: 1 },
        { tipo: 'servicio', servicio_id: ctx.servicio.id, descripcion: ctx.servicio.nombre, cantidad: 1, precio_unitario: 6000000 },
      ],
    });
    expect(p.status).toBe(201);
    expect(p.body.neto).toBe(7600000);
    expect(p.body.iva).toBe(1596000);
    expect(p.body.total).toBe(9196000);
    expect(p.body.estado).toBe('pendiente');
    ctx.presupuesto = p.body;
  });

  it('un cliente ajeno al vehículo es válido como responsable del presupuesto (Sprint 23); un cliente inexistente no', async () => {
    const otro = await api.post('/api/clientes', { nombre: 'Otro Cliente' });
    const r = await api.post('/api/presupuestos', { cliente_id: otro.body.id, vehiculo_id: ctx.vehiculo.id, items: [{ tipo: 'libre', descripcion: 'x', cantidad: 1, precio_unitario: 100 }] });
    expect(r.status).toBe(201);
    expect(r.body.cliente).toBe('Otro Cliente');
    await api.post(`/api/presupuestos/${r.body.id}/estado`, { estado: 'anulado' });
    const inexistente = await api.post('/api/presupuestos', { cliente_id: 'no-existe', vehiculo_id: ctx.vehiculo.id, items: [{ tipo: 'libre', descripcion: 'x', cantidad: 1, precio_unitario: 100 }] });
    expect(inexistente.status).toBe(400);
  });

  it('aprueba y convierte el presupuesto en OT una sola vez (trazabilidad)', async () => {
    expect((await api.post(`/api/presupuestos/${ctx.presupuesto.id}/estado`, { estado: 'aprobado' })).status).toBe(200);
    const [r1, r2] = await Promise.all([
      api.post(`/api/presupuestos/${ctx.presupuesto.id}/convertir`, {}),
      api.post(`/api/presupuestos/${ctx.presupuesto.id}/convertir`, {}),
    ]);
    const ok = [r1, r2].filter((r) => r.status === 201);
    expect(ok).toHaveLength(1);
    expect([r1, r2].find((r) => r.status !== 201)!.status).toBe(409);
    ctx.orden = ok[0].body;
    const o = await api.get(`/api/ordenes/${ctx.orden.id}`);
    expect(o.body.presupuesto_numero).toBe(ctx.presupuesto.numero);
    expect(o.body.items).toHaveLength(2);
    expect(o.body.total).toBe(9196000);
    expect(o.body.estado).toBe('recibida');
    const p = await api.get(`/api/presupuestos/${ctx.presupuesto.id}`);
    expect(p.body.estado).toBe('convertido');
    expect(p.body.orden_id).toBe(ctx.orden.id);
    // km del vehículo actualizado
    expect((await api.get(`/api/vehiculos/${ctx.vehiculo.id}`)).body.km_actual).toBe(51000);
  });

  it('guarda el check-list de ingreso', async () => {
    const r = await api.put(`/api/ordenes/${ctx.orden.id}/checklist`, { combustible: '1/2', km: 51000, datos: { danos: ['Rayones'], testigos: [], accesorios: ['Rueda de auxilio'], ingreso: 'Funcionando' }, recibido_por: 'Recepción' });
    expect(r.status).toBe(200);
    const o = await api.get(`/api/ordenes/${ctx.orden.id}`);
    expect(o.body.checklist.datos.danos).toEqual(['Rayones']);
  });

  it('descuenta el stock una sola vez al finalizar, aun con solicitudes simultáneas', async () => {
    expect((await api.post(`/api/ordenes/${ctx.orden.id}/estado`, { estado: 'en_reparacion' })).status).toBe(200);
    const rs = await Promise.all([1, 2, 3].map(() => api.post(`/api/ordenes/${ctx.orden.id}/estado`, { estado: 'lista' })));
    expect(rs.filter((r) => r.status === 200 && r.body.stock === 'descontado')).toHaveLength(1);
    const art = await api.get(`/api/articulos/${ctx.articulo}`);
    expect(art.body.stock).toBe(3);
    expect(art.body.movimientos.filter((m: any) => m.tipo === 'consumo_ot')).toHaveLength(1);
  });

  it('no permite editar ítems de una OT finalizada', async () => {
    const o = (await api.get(`/api/ordenes/${ctx.orden.id}`)).body;
    const r = await api.put(`/api/ordenes/${ctx.orden.id}`, { ...o, items: [], version: o.version });
    expect(r.status).toBe(409);
  });

  it('reabrir la OT repone el stock; volver a finalizar lo descuenta de nuevo', async () => {
    expect((await api.post(`/api/ordenes/${ctx.orden.id}/estado`, { estado: 'en_reparacion' })).body.stock).toBe('repuesto');
    expect((await api.get(`/api/articulos/${ctx.articulo}`)).body.stock).toBe(5);
    expect((await api.post(`/api/ordenes/${ctx.orden.id}/estado`, { estado: 'lista' })).body.stock).toBe('descontado');
    expect((await api.get(`/api/articulos/${ctx.articulo}`)).body.stock).toBe(3);
  });

  it('genera un único comprobante interno desde la OT', async () => {
    const [a, b] = await Promise.all([
      api.post(`/api/ordenes/${ctx.orden.id}/comprobante`, { condicion: 'cuenta_corriente' }),
      api.post(`/api/ordenes/${ctx.orden.id}/comprobante`, { condicion: 'cuenta_corriente' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    ctx.venta = (a.status === 201 ? a : b).body;
    expect(ctx.venta.total).toBe(9196000);
    const v = await api.get(`/api/ventas/${ctx.venta.id}`);
    expect(v.body.tipo).toBe('interno');
    expect(v.body.fiscal.disponible).toBe(false);
    expect(v.body.items).toHaveLength(2);
    // Con comprobante emitido, la OT no se puede reabrir
    expect((await api.post(`/api/ordenes/${ctx.orden.id}/estado`, { estado: 'en_reparacion' })).status).toBe(409);
  });

  it('registra cobros parciales, evita duplicados y excesos', async () => {
    const key = idem();
    const cobro1 = { cliente_id: ctx.cliente.id, medios: [{ medio: 'efectivo', importe: 5000000 }], aplicaciones: [{ venta_id: ctx.venta.id, importe: 5000000 }], idem_key: key };
    const [r1, r2] = await Promise.all([api.post('/api/cobros', cobro1), api.post('/api/cobros', cobro1)]);
    expect([r1.status, r2.status]).toContain(201);
    const ids = new Set([r1.body.id, r2.body.id]);
    expect(ids.size).toBe(1); // mismo cobro, no duplicado
    let v = (await api.get(`/api/ventas/${ctx.venta.id}`)).body;
    expect(v.cobrado).toBe(5000000);
    expect(v.saldo).toBe(4196000);

    const exceso = await api.post('/api/cobros', { cliente_id: ctx.cliente.id, medios: [{ medio: 'transferencia', importe: 5000000 }], aplicaciones: [{ venta_id: ctx.venta.id, importe: 5000000 }], idem_key: idem() });
    expect(exceso.status).toBe(409);

    const resto = await api.post('/api/cobros', {
      cliente_id: ctx.cliente.id,
      medios: [{ medio: 'transferencia', importe: 4000000, referencia: 'TRF 123' }, { medio: 'efectivo', importe: 196000 }],
      aplicaciones: [{ venta_id: ctx.venta.id, importe: 4196000 }],
      idem_key: idem(),
    });
    expect(resto.status).toBe(201);
    v = (await api.get(`/api/ventas/${ctx.venta.id}`)).body;
    expect(v.saldo).toBe(0);
    expect(v.cobros).toHaveLength(2);
    ctx.cobroResto = resto.body.id;
  });

  it('la cuenta corriente refleja comprobantes y cobros; anular un cobro restituye el saldo', async () => {
    let cc = (await api.get(`/api/cuentas-corrientes/${ctx.cliente.id}`)).body;
    expect(cc.saldo).toBe(0);
    expect(cc.movimientos).toHaveLength(3);
    expect((await api.post(`/api/cobros/${ctx.cobroResto}/anular`, { motivo: 'error de carga' })).status).toBe(200);
    expect((await api.post(`/api/cobros/${ctx.cobroResto}/anular`, { motivo: 'otra vez' })).status).toBe(409);
    cc = (await api.get(`/api/cuentas-corrientes/${ctx.cliente.id}`)).body;
    expect(cc.saldo).toBe(4196000);
    const lista = (await api.get('/api/cuentas-corrientes')).body;
    expect(lista.find((x: any) => x.id === ctx.cliente.id).saldo).toBe(4196000);
  });

  it('entrega la OT y aparece en el historial del vehículo con recordatorio de service', async () => {
    expect((await api.post(`/api/ordenes/${ctx.orden.id}/estado`, { estado: 'entregada', nota: 'Retiró el cliente' })).status).toBe(200);
    const v = (await api.get(`/api/vehiculos/${ctx.vehiculo.id}`)).body;
    expect(v.historial).toHaveLength(1);
    expect(v.historial[0].items.map((i: any) => i.descripcion)).toContain('Filtro de aceite X');
    const prox = v.proximos.find((p: any) => p.servicio.startsWith('Service de aceite'));
    expect(prox.proximo_km).toBe(61000);
    const o = (await api.get(`/api/ordenes/${ctx.orden.id}`)).body;
    expect(o.eventos.map((e: any) => e.estado_nuevo)).toEqual(['recibida', 'en_reparacion', 'lista', 'en_reparacion', 'lista', 'entregada']);
    // Stock final coherente: 5 iniciales − 2 consumidos
    expect((await api.get(`/api/articulos/${ctx.articulo}`)).body.stock).toBe(3);
  });

  it('dashboard, reportes y búsqueda global responden con datos del taller', async () => {
    const d = (await api.get('/api/dashboard')).body;
    expect(d.finanzas.por_cobrar).toBe(4196000);
    const hoy = hoyAR();
    const r = (await api.get(`/api/reportes?desde=${hoy}&hasta=${hoy}`)).body;
    expect(r.resumen.total).toBe(9196000);
    const b = (await api.get('/api/buscar?q=AB123')).body;
    expect(b.vehiculos[0].patente).toBe('AB123CD');
  });
});

describe('ventas de mostrador, compras y stock', () => {
  it('venta de mostrador descuenta stock, es idempotente y su anulación lo repone', async () => {
    const key = idem();
    const venta = { items: [{ tipo: 'articulo', articulo_id: ctx.articulo, descripcion: 'Filtro', cantidad: 1, precio_unitario: 800000 }], cliente_id: ctx.cliente.id, condicion: 'cuenta_corriente', idem_key: key };
    const [a, b] = await Promise.all([api.post('/api/ventas', venta), api.post('/api/ventas', venta)]);
    const ok = [a, b].filter((r) => r.status === 201 || r.status === 200);
    expect(new Set(ok.map((r) => r.body.id)).size).toBe(1);
    expect((await api.get(`/api/articulos/${ctx.articulo}`)).body.stock).toBe(2);
    expect(ok[0].body.cliente_id).toBe(ctx.cliente.id);
    expect((await api.post(`/api/ventas/${ok[0].body.id}/anular`, { motivo: 'devolución' })).status).toBe(200);
    expect((await api.get(`/api/articulos/${ctx.articulo}`)).body.stock).toBe(3);
  });

  it('venta de contado con cobro inmediato queda saldada en una sola operación', async () => {
    const r = await api.post('/api/ventas', { items: [{ tipo: 'libre', descripcion: 'Lavado de motor', cantidad: 1, precio_unitario: 1500000 }], cobro: { medio: 'efectivo' }, idem_key: idem() });
    expect(r.status).toBe(201);
    expect(r.body.cobrado).toBe(1500000);
    expect(r.body.saldo).toBe(0);
  });

  it('impide vender más que el stock disponible', async () => {
    const r = await api.post('/api/ventas', { items: [{ tipo: 'articulo', articulo_id: ctx.articulo, descripcion: 'Filtro', cantidad: 99, precio_unitario: 1 }], cobro: { medio: 'efectivo' }, idem_key: idem() });
    expect(r.status).toBe(409);
    expect((await api.get(`/api/articulos/${ctx.articulo}`)).body.stock).toBe(3);
  });

  it('una OT sin stock suficiente no cambia de estado ni genera movimientos (rollback atómico)', async () => {
    const o = await api.post('/api/ordenes', {
      cliente_id: ctx.cliente.id,
      vehiculo_id: ctx.vehiculo.id,
      items: [{ tipo: 'articulo', articulo_id: ctx.articulo, descripcion: 'Filtro', cantidad: 50, precio_unitario: 800000 }],
    });
    expect(o.status).toBe(201);
    const r = await api.post(`/api/ordenes/${o.body.id}/estado`, { estado: 'lista' });
    expect(r.status).toBe(409);
    expect((await api.get(`/api/ordenes/${o.body.id}`)).body.estado).toBe('recibida');
    const art = (await api.get(`/api/articulos/${ctx.articulo}`)).body;
    expect(art.stock).toBe(3);
  });

  it('el km de una OT no puede ser menor al registrado', async () => {
    const r = await api.post('/api/ordenes', { cliente_id: ctx.cliente.id, vehiculo_id: ctx.vehiculo.id, km_ingreso: 100 });
    expect(r.status).toBe(400);
  });

  it('compra a proveedor suma stock y actualiza costo; pago reduce saldo', async () => {
    const p = await api.post('/api/proveedores', { nombre: 'Repuestos Sur', cuit: '30-11111111-1' });
    expect(p.status).toBe(201);
    const c = await api.post('/api/compras', { proveedor_id: p.body.id, numero_doc: 'A-0001-00000001', iva: 210000, items: [{ articulo_id: ctx.articulo, cantidad: 10, costo_unitario: 550000 }], idem_key: idem() });
    expect(c.status).toBe(201);
    const art = (await api.get(`/api/articulos/${ctx.articulo}`)).body;
    expect(art.stock).toBe(13);
    expect(art.costo).toBe(550000);
    expect((await api.post('/api/pagos-proveedor', { proveedor_id: p.body.id, importe: 2000000, medio: 'transferencia', idem_key: idem() })).status).toBe(201);
    const cta = (await api.get(`/api/proveedores/${p.body.id}/cuenta`)).body;
    expect(cta.saldo).toBe(5500000 + 210000 - 2000000);
    expect((await api.post(`/api/compras/${c.body.id}/anular`, {})).status).toBe(200);
    expect((await api.get(`/api/articulos/${ctx.articulo}`)).body.stock).toBe(3);
  });

  it('ajuste de inventario fija el stock contado y es idempotente', async () => {
    const key = idem();
    const r1 = await api.post('/api/stock/movimientos', { articulo_id: ctx.articulo, tipo: 'ajuste', motivo: 'conteo', cantidad: 7, idem_key: key });
    expect(r1.status).toBe(201);
    expect(r1.body.stock).toBe(7);
    const r2 = await api.post('/api/stock/movimientos', { articulo_id: ctx.articulo, tipo: 'entrada', cantidad: 1, idem_key: key });
    expect(r2.status).toBe(409);
    expect((await api.get(`/api/articulos/${ctx.articulo}`)).body.stock).toBe(7);
  });
});

describe('agenda', () => {
  it('crea turno vinculado a presupuesto y lo pasa a OT', async () => {
    const p = await api.post('/api/presupuestos', { cliente_id: ctx.cliente.id, vehiculo_id: ctx.vehiculo.id, items: [{ tipo: 'libre', descripcion: 'Revisión', cantidad: 1, precio_unitario: 100000 }] });
    await api.post(`/api/presupuestos/${p.body.id}/estado`, { estado: 'aprobado' });
    expect((await api.get('/api/turnos/pendientes')).body.map((x: any) => x.id)).toContain(p.body.id);
    const fecha = hoyAR();
    const t = await api.post('/api/turnos', { fecha, hora: '09:30', cliente_id: ctx.cliente.id, vehiculo_id: ctx.vehiculo.id, presupuesto_id: p.body.id, motivo: 'Revisión' });
    expect(t.status).toBe(201);
    expect((await api.get('/api/turnos/pendientes')).body.map((x: any) => x.id)).not.toContain(p.body.id);
    await api.post(`/api/presupuestos/${p.body.id}/convertir`, {});
    const lista = (await api.get(`/api/turnos?desde=${fecha}&hasta=${fecha}`)).body;
    const turno = lista.find((x: any) => x.id === t.body.id);
    expect(turno.estado).toBe('en_taller');
    expect(turno.orden_numero).toBeTruthy();
  });
});
