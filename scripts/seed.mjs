// Carga datos de demostración (ficticios) usando la API real. Requiere `npm run dev` en ejecución.
// Crea dos talleres independientes para poder verificar la separación de datos.
import { plataforma } from './platform.mjs';

const API = process.env.FIERRO_API ?? 'http://127.0.0.1:8787';

class Sesion {
  cookie = '';
  async req(method, ruta, body) {
    const r = await fetch(`${API}/api${ruta}`, { method, headers: { 'content-type': 'application/json', cookie: this.cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const j = await r.json();
    if (!r.ok) throw new Error(`${method} ${ruta} → ${r.status}: ${j?.error?.message}`);
    return j;
  }
  post = (r, b = {}) => this.req('POST', r, b);
  get = (r) => this.req('GET', r);
}
const clave = () => `seed-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const dia = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

async function crearTaller(nombre, email, adicionales) {
  try {
    await plataforma('POST', '/talleres', { nombre, usuarios_adicionales: adicionales, propietario: { nombre: `Propietario ${nombre}`, email, password: 'demo1234' } });
  } catch (e) {
    if (!String(e.message).includes('409')) throw e;
    console.log(`  (${email} ya existía, se reutiliza)`);
    return null;
  }
  const s = new Sesion();
  await s.post('/auth/login', { email, password: 'demo1234' });
  return s;
}

async function main() {
  await fetch(`${API}/api/salud`).catch(() => {
    throw new Error(`No se pudo conectar a ${API}. Ejecutá "npm run dev" primero.`);
  });

  console.log('Creando "Taller Demo"…');
  const s = await crearTaller('Taller Demo', 'demo@fierro.local', 2);
  if (s) {
    await s.req('PUT', '/taller/config', {
      taller: { nombre: 'Taller Demo', razon_social: 'Demo Mecánica SRL', cuit: '30-71234567-1', condicion_iva: 'responsable_inscripto', direccion: 'Av. Siempre Viva 742', localidad: 'Ciudad', telefono: '11 4000-0000', email: 'contacto@tallerdemo.local' },
      config: { iva_default: 21, recargo_default: 0, validez_presupuesto_dias: 15, margen_default: 40, pie_documentos: 'Garantía de mano de obra: 3 meses o 5.000 km. Precios sujetos a disponibilidad de repuestos.', permitir_stock_negativo: false },
    });
    await s.post('/taller/usuarios', { nombre: 'Empleado Demo', email: 'empleado@fierro.local', rol: 'empleado', password: 'demo1234' });
    const [m1, m2] = [await s.post('/mecanicos', { nombre: 'Carlos Gómez', especialidad: 'Motor y distribución' }), await s.post('/mecanicos', { nombre: 'Lucía Fernández', especialidad: 'Frenos y tren delantero' })];
    const prov = await s.post('/proveedores', { nombre: 'Repuestos del Sur SA', cuit: '30-11111111-1', telefono: '11 4555-1234' });
    // Caja abierta para que los cobros de la demostración queden asentados en ella.
    await s.post('/caja/abrir', { saldo_inicial: 5000000, notas: 'Fondo de cambio' });
    const cats = await s.get('/categorias-articulo');
    const cat = (n) => cats.find((c) => c.nombre === n)?.id;
    const arts = {};
    for (const [k, a] of Object.entries({
      aceite: { nombre: 'Aceite sintético 5W30 x 4 L', codigo: 'ACE-5W30-4', marca: 'Lubrimax', categoria_id: cat('Aceites y lubricantes'), costo: 2800000, precio: 3900000, stock_inicial: 12, stock_minimo: 4, unidad: 'un' },
      filtroAceite: { nombre: 'Filtro de aceite FA-210', codigo: 'FA-210', marca: 'FiltroPro', categoria_id: cat('Filtros'), costo: 450000, precio: 700000, stock_inicial: 20, stock_minimo: 6 },
      filtroAire: { nombre: 'Filtro de aire FAI-88', codigo: 'FAI-88', marca: 'FiltroPro', categoria_id: cat('Filtros'), costo: 520000, precio: 800000, stock_inicial: 3, stock_minimo: 4 },
      pastillas: { nombre: 'Pastillas de freno delanteras PF-12', codigo: 'PF-12', marca: 'Frenar', categoria_id: cat('Frenos'), costo: 1800000, precio: 2700000, stock_inicial: 6, stock_minimo: 2, unidad: 'juego' },
      bujia: { nombre: 'Bujía iridio BI-4', codigo: 'BI-4', marca: 'Chispa', categoria_id: cat('Encendido'), costo: 650000, precio: 980000, stock_inicial: 16, stock_minimo: 8 },
      liquido: { nombre: 'Líquido de frenos DOT4 500 ml', codigo: 'DOT4-500', marca: 'Frenar', categoria_id: cat('Frenos'), costo: 300000, precio: 480000, stock_inicial: 1, stock_minimo: 3 },
    })) arts[k] = (await s.post('/articulos', { ...a, proveedor_id: prov.id })).id;

    const servicios = await s.get('/servicios');
    const srv = (n) => servicios.find((x) => x.nombre.startsWith(n));
    const marcas = await s.get('/marcas');
    const mm = (marca, modelo) => {
      const m = marcas.find((x) => x.nombre === marca);
      return { marca_id: m.id, modelo_id: m.modelos.find((x) => x.nombre === modelo)?.id };
    };
    const clientes = [];
    for (const [c, v] of [
      [{ nombre: 'Martín Ríos', telefono: '11 5123-4567', documento: '28123456' }, { patente: 'AE123FG', ...mm('Volkswagen', 'Gol Trend'), anio: 2017, km_actual: 98000, combustible: 'Nafta' }],
      [{ nombre: 'Sofía Herrera', telefono: '11 6234-5678', email: 'sofia@example.com' }, { patente: 'AD456HJ', ...mm('Toyota', 'Corolla'), anio: 2019, km_actual: 61000, combustible: 'Nafta' }],
      [{ nombre: 'Transportes Lago SRL', telefono: '11 4789-0000', documento_tipo: 'CUIT', documento: '30712345678', condicion_iva: 'responsable_inscripto' }, { patente: 'AF789KL', ...mm('Toyota', 'Hilux'), anio: 2021, km_actual: 145000, combustible: 'Diésel' }],
      [{ nombre: 'Diego Paz', telefono: '11 3345-6789' }, { patente: 'OKJ321', ...mm('Fiat', 'Palio'), anio: 2014, km_actual: 187000, combustible: 'Nafta/GNC' }],
      [{ nombre: 'Valeria Núñez', telefono: '11 2456-7890' }, { patente: 'AB901CD', ...mm('Peugeot', '208'), anio: 2018, km_actual: 72000, combustible: 'Nafta' }],
    ]) {
      const cli = await s.post('/clientes', c);
      const veh = await s.post('/vehiculos', { cliente_id: cli.id, ...v });
      clientes.push({ cli, veh });
    }
    const item = (tipo, ref, desc, precio, cantidad = 1) => ({ tipo, ...(tipo === 'articulo' ? { articulo_id: ref } : tipo === 'servicio' ? { servicio_id: ref } : {}), descripcion: desc, cantidad, precio_unitario: precio });
    const serviceItems = [
      item('servicio', srv('Service de aceite').id, srv('Service de aceite').nombre, srv('Service de aceite').precio),
      item('articulo', arts.aceite, 'Aceite sintético 5W30 x 4 L', 3900000),
      item('articulo', arts.filtroAceite, 'Filtro de aceite FA-210', 700000),
    ];

    // 1) OT entregada y cobrada (Martín)
    let o = await s.post('/ordenes', { cliente_id: clientes[0].cli.id, vehiculo_id: clientes[0].veh.id, mecanico_id: m1.id, km_ingreso: 98500, falla_reportada: 'Service de 10.000 km', items: serviceItems });
    await s.req('PUT', `/ordenes/${o.id}/checklist`, { combustible: '1/2', km: 98500, datos: { danos: ['Rayones'], testigos: [], accesorios: ['Rueda de auxilio', 'Criquet / llave'], ingreso: 'Funcionando' }, recibido_por: 'Recepción' });
    await s.post(`/ordenes/${o.id}/estado`, { estado: 'en_reparacion' });
    await s.post(`/ordenes/${o.id}/estado`, { estado: 'lista' });
    let v = await s.post(`/ordenes/${o.id}/comprobante`, { condicion: 'contado', cobro: { medio: 'transferencia', referencia: 'Op. 784512' } });
    await s.post(`/ordenes/${o.id}/estado`, { estado: 'entregada', nota: 'Retiró el titular' });

    // 2) Presupuesto aprobado → OT en reparación (Sofía)
    const p = await s.post('/presupuestos', {
      cliente_id: clientes[1].cli.id, vehiculo_id: clientes[1].veh.id, km: 61200, iva_pct: 21,
      items: [item('servicio', srv('Cambio de pastillas delanteras').id, 'Cambio de pastillas delanteras', srv('Cambio de pastillas delanteras').precio), item('articulo', arts.pastillas, 'Pastillas de freno delanteras PF-12', 2700000), item('servicio', srv('Cambio de líquido de frenos').id, 'Cambio de líquido de frenos', srv('Cambio de líquido de frenos').precio), item('articulo', arts.liquido, 'Líquido de frenos DOT4 500 ml', 480000)],
      observaciones: 'Se recomienda rectificar discos en el próximo service.',
    });
    await s.post(`/presupuestos/${p.id}/estado`, { estado: 'aprobado' });
    o = await s.post(`/presupuestos/${p.id}/convertir`, { mecanico_id: m2.id, fecha_prometida: dia(1) });
    await s.post(`/ordenes/${o.id}/estado`, { estado: 'en_reparacion' });

    // 3) OT lista con saldo en cuenta corriente (Transportes Lago)
    o = await s.post('/ordenes', { cliente_id: clientes[2].cli.id, vehiculo_id: clientes[2].veh.id, mecanico_id: m1.id, km_ingreso: 145300, falla_reportada: 'Service completo + revisión de tren delantero', items: [...serviceItems, item('servicio', srv('Alineación y balanceo').id, 'Alineación y balanceo', srv('Alineación y balanceo').precio)] });
    await s.post(`/ordenes/${o.id}/estado`, { estado: 'lista' });
    v = await s.post(`/ordenes/${o.id}/comprobante`, { condicion: 'cuenta_corriente' });
    await s.post('/cobros', { cliente_id: clientes[2].cli.id, medios: [{ medio: 'efectivo', importe: 5000000 }], aplicaciones: [{ venta_id: v.id, importe: 5000000 }], idem_key: clave(), notas: 'Entrega a cuenta' });

    // 4) OT recibida esperando diagnóstico (Diego) y otra esperando repuestos (Valeria)
    await s.post('/ordenes', { cliente_id: clientes[3].cli.id, vehiculo_id: clientes[3].veh.id, km_ingreso: 187200, falla_reportada: 'Pierde potencia y se enciende el check engine', fecha_prometida: dia(2) });
    o = await s.post('/ordenes', { cliente_id: clientes[4].cli.id, vehiculo_id: clientes[4].veh.id, mecanico_id: m1.id, km_ingreso: 72100, falla_reportada: 'Cambio de kit de distribución', items: [item('servicio', srv('Cambio de kit de distribución').id, 'Cambio de kit de distribución', srv('Cambio de kit de distribución').precio)] });
    await s.post(`/ordenes/${o.id}/estado`, { estado: 'esperando_repuestos', nota: 'Kit pedido al proveedor' });

    // 5) Presupuesto pendiente y turnos
    await s.post('/presupuestos', { cliente_id: clientes[3].cli.id, vehiculo_id: clientes[3].veh.id, km: 187200, items: [item('servicio', srv('Cambio de bujías').id, 'Cambio de bujías', srv('Cambio de bujías').precio), item('articulo', arts.bujia, 'Bujía iridio BI-4', 980000, 4), item('servicio', srv('Diagnóstico con escáner').id, 'Diagnóstico con escáner', srv('Diagnóstico con escáner').precio)] });
    await s.post('/turnos', { fecha: dia(0), hora: '10:30', cliente_id: clientes[4].cli.id, vehiculo_id: clientes[4].veh.id, motivo: 'Revisión pre-VTV', mecanico_id: m2.id });
    await s.post('/turnos', { fecha: dia(1), hora: '09:00', cliente_id: clientes[1].cli.id, vehiculo_id: clientes[1].veh.id, motivo: 'Control de frenos' });
    await s.post('/turnos', { fecha: dia(3), hora: '15:00', cliente_id: clientes[0].cli.id, vehiculo_id: clientes[0].veh.id, motivo: 'Alineación y balanceo' });

    // 6) Venta de mostrador y compra
    await s.post('/ventas', { items: [item('articulo', arts.liquido, 'Líquido de frenos DOT4 500 ml', 480000)], cobro: { medio: 'efectivo' }, idem_key: clave() });
    await s.post('/compras', { proveedor_id: prov.id, numero_doc: 'A-0003-00012345', iva: 2184000, items: [{ articulo_id: arts.filtroAire, cantidad: 10, costo_unitario: 520000 }, { articulo_id: arts.liquido, cantidad: 6, costo_unitario: 300000 }], idem_key: clave() });
    await s.post('/pagos-proveedor', { proveedor_id: prov.id, importe: 3000000, medio: 'transferencia', referencia: 'Transf. 99120', idem_key: clave() });

    // 7) Gastos, gasto recurrente y listas de precios
    const categorias = await s.get('/categorias-gasto');
    const catGasto = (n) => categorias.find((c) => c.nombre.startsWith(n))?.id;
    await s.post('/gastos', { categoria_id: catGasto('Insumos'), concepto: 'Trapos y desengrasante', importe: 1850000, medio: 'efectivo', idem_key: clave() });
    await s.post('/gastos', { categoria_id: catGasto('Limpieza'), concepto: 'Limpieza del taller', importe: 900000, medio: 'efectivo', idem_key: clave() });
    await s.post('/gastos-recurrentes', { categoria_id: catGasto('Alquiler'), concepto: 'Alquiler del local', importe: 45000000, medio: 'transferencia', frecuencia: 'mensual', dia: 5, proxima_fecha: dia(-2) });
    await s.post('/listas-precios', { nombre: 'Mayorista', descripcion: 'Talleres y flotas: costo + 25 %', base: 'costo', porcentaje: 25, redondeo: 100, servicios_pct: -10 });
    await s.post('/listas-precios', { nombre: 'Tarjeta de crédito', descripcion: 'Recargo por financiación', base: 'precio', porcentaje: 15, redondeo: 1000 });

    // 8) Bancos, cheques, orden de compra con recepción parcial y factura de proveedor
    const galicia = await s.post('/bancos/cuentas', { nombre: 'Galicia CC $', banco: 'Banco Galicia', alias: 'taller.demo.galicia', titular: 'Taller Demo SRL', saldo_inicial: 120000000 });
    const mp = await s.post('/bancos/cuentas', { nombre: 'Mercado Pago', banco: 'Mercado Pago', tipo: 'billetera_virtual', saldo_inicial: 0 });
    await s.post('/bancos/depositos', { cuenta_id: galicia.id, importe: 2000000, concepto: 'Depósito de recaudación', idem_key: clave() });
    await s.post('/bancos/transferencias', { origen_id: galicia.id, destino_id: mp.id, importe: 5000000, concepto: 'Fondeo de billetera', idem_key: clave() });
    await s.post('/bancos/movimientos', { cuenta_id: galicia.id, tipo: 'egreso', importe: 450000, concepto: 'Comisión de mantenimiento de cuenta', idem_key: clave() });
    await s.post('/cheques', { direccion: 'recibido', banco: 'Banco Nación', nro_cheque: '00458812', importe: 7500000, fecha_emision: dia(-10), fecha_pago: dia(5), librador: 'Transportes del Sur SA', cuit: '30-71234567-1' });
    await s.post('/cheques', { direccion: 'recibido', modalidad: 'echeq', echeq_id: 'ECHEQ-2026-8841', banco: 'Banco Santander', nro_cheque: '9927310', importe: 3200000, fecha_emision: dia(-3), fecha_pago: dia(0), librador: 'Flota Express SRL' });
    const oc = await s.post('/ordenes-compra', { proveedor_id: prov.id, emitir: true, fecha_prevista: dia(4), iva_pct: 21, items: [{ articulo_id: arts.filtroAire, cantidad: 20, costo_unitario: 520000 }, { articulo_id: arts.liquido, cantidad: 12, costo_unitario: 300000 }], idem_key: clave() });
    const ocDet = await s.get(`/ordenes-compra/${oc.id}`);
    await s.post(`/ordenes-compra/${oc.id}/recepciones`, { remito: '0003-00044120', items: [{ orden_item_id: ocDet.items[0].id, cantidad: 12 }], idem_key: clave() });
    await s.post('/facturas-proveedor', { proveedor_id: prov.id, tipo: 'factura_a', nro_comprobante: '3-45001', fecha: dia(0), orden_compra_id: oc.id, neto_gravado: 6240000, iva_21: 1310400, total: 7550400, condicion_pago: 'plazo', dias_plazo: 15, idem_key: clave() });
  }

  console.log('Creando "Taller Norte" (segundo taller para verificar aislamiento)…');
  const n = await crearTaller('Taller Norte', 'norte@fierro.local', 0);
  if (n) {
    const c = await n.post('/clientes', { nombre: 'Cliente exclusivo del Taller Norte', telefono: '351 555-0000' });
    await n.post('/vehiculos', { cliente_id: c.id, patente: 'AA000NN', km_actual: 30000 });
  }

  console.log('\nListo. Accesos de demostración (contraseña: demo1234):');
  console.log('  Propietario Taller Demo: demo@fierro.local');
  console.log('  Empleado Taller Demo:    empleado@fierro.local');
  console.log('  Propietario Taller Norte: norte@fierro.local');
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
