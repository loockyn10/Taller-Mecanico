// Verificación de consistencia del taller de demostración (sólo lecturas por la API).
// Comprueba saldos, stock, importes, cronología, duplicados y que ninguna sección de la aplicación quede vacía.
import { Sesion } from './api.mjs';
import { ARTICULOS, CUENTAS, MECANICOS, PROVEEDORES } from './catalogo.mjs';
import { ars, hoyAR, sumarDias } from './util.mjs';

export async function verificar({ opts, plan, m, log }) {
  const ow = await new Sesion(opts.api, 'propietario').login(opts.email, opts.password);
  const R = [];
  const chk = (grupo, nombre, ok, detalle = '') => R.push({ grupo, nombre, ok: !!ok, detalle });
  const desde = sumarDias(plan.fechas[0], -3);
  const hasta = hoyAR();
  const rango = `desde=${desde}&hasta=${hasta}`;
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

  // ───── Datos base ─────
  const clientes = (await ow.get('/clientes?limite=500')).filter((c) => c.codigo !== 0);
  const vehiculos = await ow.get('/vehiculos');
  const mecanicos = await ow.get('/mecanicos');
  const ordenes = await ow.get('/ordenes?estado=todas&limite=500');
  const presupuestos = await ow.get('/presupuestos');
  const turnos = await ow.get(`/turnos?desde=${desde}&hasta=${sumarDias(hasta, 30)}`);
  const articulos = await ow.get('/articulos?limite=1000');
  const proveedores = await ow.get('/proveedores');
  const ventas = await ow.get('/ventas');
  const cobros = await ow.get('/cobros?limite=500');
  const compras = await ow.get('/compras');
  const sesiones = (await ow.get('/caja/sesiones?limite=200')).sort((a, b) => a.numero - b.numero);
  const cuentas = await ow.get('/bancos/cuentas?todas=1');
  const cheques = await ow.get('/cheques?limite=1000');
  const gastos = await ow.get('/gastos?limite=500');
  const pagos = await ow.get('/pagos-proveedor');

  // ───── 1. Volúmenes ─────
  const cuenta = (n, obj, esperado, tol = 0) => chk('Volúmenes', `${n}: ${obj}`, Math.abs(obj - esperado) <= tol, `esperado ${esperado}`);
  cuenta('Clientes', clientes.length, 30);
  cuenta('Vehículos', vehiculos.length, 35);
  cuenta('Mecánicos', mecanicos.length, MECANICOS.length);
  cuenta('Órdenes de trabajo', ordenes.length, 45);
  cuenta('Presupuestos', presupuestos.length, 25);
  cuenta('Turnos', turnos.length, 30);
  cuenta('Artículos', articulos.length, ARTICULOS.length);
  cuenta('Proveedores', proveedores.length, PROVEEDORES.length);
  chk('Volúmenes', `Compras registradas: ${compras.filter((c) => c.estado === 'registrada').length} (+ órdenes de compra)`, compras.length >= 15);
  chk('Volúmenes', `Ventas de mostrador (sin OT): ${ventas.filter((v) => !v.orden_id).length}`, ventas.filter((v) => !v.orden_id).length === 35);
  chk('Volúmenes', `Cuentas bancarias: ${cuentas.length}`, cuentas.length === CUENTAS.length);

  // ───── 2. Stock ─────
  const stockPlan = plan.stock;
  const dif = articulos.filter((a) => Math.abs(a.stock - (stockPlan.get(a.codigo) ?? NaN)) > 0.0005);
  chk('Stock', 'El stock de cada artículo coincide con el libro esperado del plan', dif.length === 0, dif.slice(0, 5).map((a) => `${a.codigo}: ${a.stock} vs ${stockPlan.get(a.codigo)}`).join('; '));
  chk('Stock', 'Ningún artículo con stock negativo', articulos.every((a) => a.stock >= 0));
  let rotos = 0, desorden = 0, detalleRot = '';
  for (const a of articulos) {
    const movs = (await ow.get(`/articulos/${a.id}`)).movimientos.slice().reverse(); // del más viejo al más nuevo
    let acum = 0;
    for (let i = 0; i < movs.length; i++) {
      acum = Math.round((acum + movs[i].cantidad) * 1000) / 1000;
      if (Math.abs(acum - movs[i].stock_resultante) > 0.0005) { rotos++; detalleRot ||= `${a.codigo} mov ${i}`; break; }
      if (i && movs[i].created_at < movs[i - 1].created_at) { desorden++; break; }
    }
    if (movs.length < 100 && Math.abs(acum - a.stock) > 0.0005) { rotos++; detalleRot ||= `${a.codigo} saldo final`; }
  }
  chk('Stock', 'Cada movimiento deja el stock resultante exacto (libro continuo por artículo)', rotos === 0, detalleRot);
  chk('Stock', 'Los movimientos de stock están en orden cronológico', desorden === 0);
  const sinMov = articulos.filter((a) => a.stock > 0).length;
  chk('Stock', `Artículos con existencias: ${sinMov}/${articulos.length}`, sinMov > 60);

  // ───── 3. Caja ─────
  const cerradas = sesiones.filter((s) => s.estado === 'cerrada');
  chk('Caja', `Jornadas de caja: ${sesiones.length} (${cerradas.length} cerradas, ${sesiones.length - cerradas.length} abierta)`, sesiones.length >= plan.N && sesiones.length <= plan.N + 1 && sesiones.filter((s) => s.estado === 'abierta').length === 1 && sesiones.at(-1).estado === 'abierta');
  let cadena = true, detCad = '';
  for (let i = 1; i < sesiones.length; i++) if (sesiones[i].saldo_inicial !== sesiones[i - 1].efectivo_declarado) { cadena = false; detCad ||= `caja #${sesiones[i].numero}`; }
  chk('Caja', 'El saldo inicial de cada caja es lo declarado al cerrar la anterior', cadena, detCad);
  chk('Caja', 'Las diferencias de cierre cierran (declarado − esperado)', cerradas.every((s) => s.diferencia === s.efectivo_declarado - s.efectivo_esperado));
  const conDif = cerradas.filter((s) => s.diferencia);
  chk('Caja', `Cajas con diferencia explicada: ${conDif.length}`, conDif.length >= 3 && conDif.every((s) => s.notas_cierre));
  const fechasSes = sesiones.map((s) => s.fecha);
  chk('Caja', 'Las fechas de las cajas son estrictamente crecientes', fechasSes.every((f, i) => !i || f > fechasSes[i - 1]), `${fechasSes[0]} → ${fechasSes.at(-1)}`);

  // ───── 4. Comprobantes, cobros y cuentas corrientes ─────
  const detV = [];
  for (const v of ventas) detV.push(await ow.get(`/ventas/${v.id}`));
  const malCobrado = detV.filter((v) => v.estado === 'emitida' && v.cobrado !== sum(v.cobros.filter((c) => c.estado === 'registrado'), (c) => c.importe));
  chk('Cobranzas', 'Lo cobrado de cada comprobante = suma de sus cobros vigentes', malCobrado.length === 0, malCobrado.slice(0, 3).map((v) => `#${v.numero}`).join(', '));
  chk('Cobranzas', 'Ningún comprobante cobrado de más', detV.every((v) => v.cobrado <= v.total));
  const duplOT = new Map();
  for (const v of ventas.filter((x) => x.orden_id && x.estado === 'emitida')) duplOT.set(v.orden_id, (duplOT.get(v.orden_id) ?? 0) + 1);
  chk('Duplicados', 'Una sola venta vigente por OT', [...duplOT.values()].every((n) => n === 1));
  const cc = await ow.get('/cuentas-corrientes?estado=todos');
  const saldoVentas = sum(ventas.filter((v) => v.estado === 'emitida'), (v) => v.total - v.cobrado);
  chk('Cobranzas', `Saldo de cuentas corrientes (${ars(sum(cc, (c) => c.saldo))}) = comprobantes pendientes (${ars(saldoVentas)})`, sum(cc, (c) => c.saldo) === saldoVentas);
  chk('Cobranzas', `Clientes con deuda: ${cc.filter((c) => c.saldo > 0).length}`, cc.filter((c) => c.saldo > 0).length >= 5);
  const cobrosVig = cobros.filter((c) => c.estado === 'registrado');
  chk('Cobranzas', 'Todo cobro es igual a la suma de sus medios', cobros.every((c) => c.total === sum(c.medios, (x) => x.importe)));
  const ventasPorId = new Map(ventas.map((v) => [v.id, v]));
  void ventasPorId;
  const noFut = (nombre, filas, campo) => chk('Cronología', `${nombre}: ninguna fecha futura ni anterior al inicio`, filas.every((r) => r[campo] <= hasta && r[campo] >= desde), `${filas.filter((r) => r[campo] > hasta || r[campo] < desde).length} fuera de rango`);
  noFut('Ventas', ventas, 'fecha'); noFut('Cobros', cobros, 'fecha'); noFut('Compras', compras, 'fecha'); noFut('Gastos', gastos, 'fecha'); noFut('Pagos a proveedores', pagos, 'fecha');
  // Cobro nunca anterior al comprobante
  const vFecha = new Map(detV.map((v) => [v.id, v.fecha]));
  let cobroAntes = 0;
  for (const v of detV) for (const c of v.cobros) if (c.fecha < vFecha.get(v.id)) cobroAntes++;
  chk('Cronología', 'Ningún cobro es anterior a su comprobante', cobroAntes === 0);

  // ───── 5. Órdenes de trabajo ─────
  let eventosMal = 0, fechasMal = 0, sinHist = 0;
  const entregadas = ordenes.filter((o) => o.estado === 'entregada');
  for (const o of ordenes) {
    const d = await ow.get(`/ordenes/${o.id}`);
    const ev = d.eventos.map((e) => e.created_at);
    if (ev.some((x, i) => i && x < ev[i - 1])) eventosMal++;
    if (d.fecha_lista && d.fecha_lista < d.fecha_ingreso) fechasMal++;
    if (d.fecha_entregada && (!d.fecha_lista || d.fecha_entregada < d.fecha_lista)) fechasMal++;
    if (d.estado !== 'cancelada' && d.estado !== 'recibida' && d.items.length === 0) sinHist++;
  }
  chk('Órdenes', 'Los eventos de cada OT están en orden cronológico', eventosMal === 0);
  chk('Órdenes', 'ingreso ≤ lista ≤ entrega en cada OT', fechasMal === 0);
  chk('Órdenes', 'Toda OT avanzada tiene trabajos cargados', sinHist === 0);
  const porEstado = Object.fromEntries(Object.entries(ordenes.reduce((a, o) => ((a[o.estado] = (a[o.estado] ?? 0) + 1), a), {})));
  chk('Órdenes', `Estados: ${JSON.stringify(porEstado)}`, entregadas.length >= 30 && ordenes.some((o) => o.estado === 'en_reparacion') && ordenes.some((o) => o.estado === 'esperando_repuestos'));
  chk('Órdenes', 'Las OT entregadas tienen comprobante', entregadas.every((o) => o.venta_id));
  const numeros = ordenes.map((o) => o.numero).sort((a, b) => a - b);
  chk('Duplicados', 'Numeración de OT correlativa sin saltos ni repetidos', numeros.every((n, i) => n === i + 1));
  const histVeh = await ow.get(`/vehiculos/${vehiculos[0].id}`);
  chk('Vehículos', 'La ficha del vehículo muestra su historial', Array.isArray(histVeh.historial));
  const recs = await ow.get('/recordatorios');
  chk('Vehículos', `Recordatorios de service pendientes: ${recs.length}`, recs.length >= 3);

  // ───── 6. Bancos y cheques ─────
  for (const c of cuentas) {
    const movs = await ow.get(`/bancos/movimientos?cuenta_id=${c.id}&limite=1000`);
    const calc = c.saldo_inicial + sum(movs, (x) => (x.tipo === 'ingreso' ? x.importe : -x.importe));
    chk('Bancos', `${c.nombre}: saldo ${ars(c.saldo)} = inicial + movimientos (${movs.length})`, calc === c.saldo);
    chk('Bancos', `${c.nombre}: saldo no negativo`, c.saldo >= 0, ars(c.saldo));
  }
  const ch = Object.fromEntries(Object.entries(cheques.reduce((a, c) => ((a[`${c.direccion}/${c.estado}`] = (a[`${c.direccion}/${c.estado}`] ?? 0) + 1), a), {})));
  chk('Cheques', `Cartera de cheques: ${JSON.stringify(ch)}`, cheques.length >= 8 && cheques.some((c) => c.estado === 'rechazado') && cheques.some((c) => c.estado === 'acreditado') && cheques.some((c) => c.estado === 'en_cartera') && cheques.some((c) => c.modalidad === 'echeq'));
  const resCh = await ow.get('/cheques/resumen');
  chk('Cheques', `Próximos a vencer: ${resCh.proximos.length} · vencidos: ${resCh.vencidos.length}`, resCh.proximos.length >= 1 && resCh.vencidos.length >= 1);

  // ───── 7. Libros: la plata cuenta una sola vez ─────
  const rep = await ow.get(`/caja/reportes?${rango}`);
  const neto = (r) => rep.por_rubro.find((x) => x.rubro === r)?.neto ?? 0;
  chk('Libros', `Caja (cobros ${ars(neto('cobro'))}) = cobros vigentes (${ars(sum(cobrosVig, (c) => c.total))})`, neto('cobro') === sum(cobrosVig, (c) => c.total));
  chk('Libros', 'Caja (pagos a proveedores) = pagos vigentes', -neto('pago_proveedor') === sum(pagos.filter((p) => p.estado === 'registrado'), (p) => p.importe));
  chk('Libros', 'Caja (gastos) = gastos vigentes', -neto('gasto') === sum(gastos.filter((g) => g.estado === 'registrado'), (g) => g.importe));
  const tes = await ow.get(`/tesoreria/resumen?${rango}`);
  const efectivoAbierta = sesiones.at(-1);
  chk('Tesorería', `Disponible ${ars(tes.disponible)} = efectivo ${ars(tes.efectivo.saldo)} + bancos ${ars(tes.bancos.total)}`, tes.disponible === tes.efectivo.saldo + tes.bancos.total && efectivoAbierta.estado === 'abierta');
  const fin = await ow.get(`/finanzas/resumen?${rango}`);
  chk('Tesorería', `Resultado del período: ${ars(fin.resultado)} (ingresos ${ars(fin.ingresos.total)} − egresos ${ars(fin.egresos.total)})`, fin.resultado === fin.ingresos.total - fin.egresos.total && fin.ingresos.total > 0);
  chk('Tesorería', 'El resultado de tesorería = resultado de caja + movimientos bancarios propios (intereses y comisiones)', tes.periodo.resultado === fin.resultado + tes.periodo.ingresos.bancarios - tes.periodo.egresos.bancarios);
  chk('Tesorería', 'El resultado del período es positivo (negocio rentable en la demostración)', fin.resultado > 0, ars(fin.resultado));
  const prov = await ow.get('/deuda-proveedores');
  chk('Compras', `Proveedores con deuda: ${prov.length}`, prov.length >= 3);
  chk('Compras', 'Deuda con proveedores vencida visible', prov.some((p) => p.vencido > 0));
  const ocs = await ow.get('/ordenes-compra');
  chk('Compras', `Órdenes de compra: ${JSON.stringify(Object.fromEntries(Object.entries(ocs.reduce((a, o) => ((a[o.estado] = (a[o.estado] ?? 0) + 1), a), {}))))}`, ['borrador', 'pendiente', 'parcial', 'recibida', 'cancelada'].every((e) => ocs.some((o) => o.estado === e)));
  const stockBajo = (await ow.get('/reposicion')).length;
  chk('Inventario', `Reposición: ${stockBajo} artículos en o bajo el mínimo`, stockBajo >= 1);
  const valorizado = await ow.get('/inventario/valorizado');
  chk('Inventario', `Inventario valorizado: ${ars(valorizado.totales.valor_costo)} a costo en ${valorizado.totales.articulos} artículos`, valorizado.totales.valor_costo > 0 && valorizado.totales.stock_negativo === 0);
  const conteos = await ow.get('/inventario/conteos');
  chk('Inventario', 'Hay un conteo aplicado y otro abierto', conteos.some((c) => c.estado === 'aplicado') && conteos.some((c) => c.estado === 'abierto'));

  // ───── 8. Secciones de la aplicación (que ninguna quede vacía ni falle) ─────
  const seccion = async (nombre, ruta, contar) => {
    try {
      const r = await ow.get(ruta);
      const n = contar ? contar(r) : Array.isArray(r) ? r.length : 1;
      chk('Secciones', `${nombre}: ${n} registros`, n > 0, ruta);
    } catch (e) {
      chk('Secciones', `${nombre}`, false, e.message);
    }
  };
  await seccion('Dashboard', '/dashboard', (r) => r.porEstado.length + r.ordenesRecientes.length + (r.finanzas?.ventas_mes ? 1 : 0));
  await seccion('Estadísticas', `/reportes?${rango}`, (r) => r.porDia.length);
  await seccion('Agenda (próximos 14 días)', `/turnos?desde=${hasta}&hasta=${sumarDias(hasta, 14)}`);
  await seccion('Presupuestos aprobados sin turno', '/turnos/pendientes');
  await seccion('Listas de precios', '/listas-precios');
  await seccion('Gastos recurrentes', '/gastos-recurrentes');
  await seccion('Conciliaciones', '/bancos/conciliaciones');
  await seccion('Recepciones', '/recepciones');
  await seccion('Facturas de proveedores', '/facturas-proveedor');
  await seccion('Vencimientos de proveedores', '/vencimientos-proveedores');
  await seccion('Libro de ventas', `/contabilidad/libro-ventas?${rango}`, (r) => r.filas?.length ?? r.length);
  await seccion('Libro de compras', `/contabilidad/libro-compras?${rango}`, (r) => r.filas?.length ?? r.length);
  await seccion('Operaciones internas', `/contabilidad/operaciones?${rango}`, (r) => r.filas?.length ?? r.length);
  for (const t of ['ventas', 'ventas-articulo', 'ventas-categoria', 'rentabilidad', 'mas-vendidos', 'servicios', 'compras', 'gastos', 'cobranzas', 'deudores', 'proveedores', 'inventario-valorizado', 'mecanicos', 'ordenes', 'actividad-financiera']) {
    await seccion(`Informe «${t}»`, `/informes/${t}?${rango}`, (r) => r.filas.length);
  }

  const fallas = R.filter((x) => !x.ok);
  for (const g of [...new Set(R.map((x) => x.grupo))]) {
    log(`\n${g}`);
    for (const x of R.filter((y) => y.grupo === g)) log(`  ${x.ok ? '✔' : '✖'} ${x.nombre}${x.ok || !x.detalle ? '' : `  → ${x.detalle}`}`);
  }
  log(`\nResultado: ${R.length - fallas.length}/${R.length} comprobaciones correctas${fallas.length ? ` · ${fallas.length} con diferencias` : ''}.`);
  return { resultados: R, fallas };
}
