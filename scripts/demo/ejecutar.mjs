// Ejecutor del plan: lleva cada acción a la API real del Worker, jornada por jornada (caja abierta → operaciones → cierre).
//
// Nada se inserta directamente en la base: cada comprobante, cobro, compra, movimiento de stock, asiento de caja o banco pasa por
// las mismas validaciones y transacciones que usa la aplicación. El estado de avance se guarda en un manifiesto, de modo que una
// ejecución interrumpida se puede reanudar sin duplicar registros.
import { Sesion, ErrorApi, medirReloj } from './api.mjs';
import { AJUSTE_SERVICIOS_PCT, ARTICULOS, CONFIG, CUENTAS, LISTAS, MECANICOS, PROVEEDORES, TALLER, USUARIOS } from './catalogo.mjs';
import { diasEntre, dormir, hoyAR, pesos, sumarDias } from './util.mjs';

const MARCA = '[DEMO]';
const ARQUEO_BILLETES = [1000, 500, 200, 100, 50, 20, 10];

export async function ejecutar({ plan, opts, m, guardar, log }) {
  const ow = new Sesion(opts.api, 'propietario');
  let ad = null, em = null;
  const ses = (u) => (u === 'a' ? ad : u === 'e' ? em : ow);
  const ctx = { simDia: hoyAR(), arts: new Map(), servicios: [], marcas: [], catGasto: [], catArt: [] };
  const rel = (abs) => sumarDias(hoyAR(), diasEntre(ctx.simDia, abs)); // fecha simulada → fecha real equivalente que recibe la API
  const hoyReal = () => hoyAR();
  const ids = (m.ids ??= { cli: {}, veh: {}, mec: {}, prov: {}, cuenta: {}, lista: {}, pres: {}, ot: {}, venta: {}, turno: {}, compra: {}, oc: {}, rec: {}, rec_n: {}, gastoRec: {} });
  m.contadores ??= { aporte: 0, deposito: 0, repo: 0 };

  // ───────────────────────── Sesión, taller y precondiciones ─────────────────────────
  await iniciarSesion();
  const me = await ow.get('/auth/me');
  m.taller = { id: me.taller.id, nombre: me.taller.nombre, email: me.usuario.email };
  log(`Taller destino: "${me.taller.nombre}" (${me.taller.id}) · usuario ${me.usuario.email} · rol ${me.usuario.rol}`);

  async function iniciarSesion() {
    try {
      await ow.login(opts.email, opts.password);
    } catch (e) {
      if (!(e instanceof ErrorApi) || e.status !== 401 || !opts.platformToken) throw e;
      log(`El usuario ${opts.email} no existe: se da de alta el taller con la API de plataforma.`);
      const r = await fetch(`${opts.api.replace(/\/$/, '')}/api/platform/talleres`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.platformToken}` },
        body: JSON.stringify({ nombre: TALLER.nombre, cuit: TALLER.cuit, telefono: TALLER.telefono, email: TALLER.email, usuarios_adicionales: USUARIOS.length, propietario: { nombre: 'Propietario Demo', email: opts.email, password: opts.password } }),
      });
      if (!r.ok) throw new Error(`No se pudo crear el taller: ${r.status} ${await r.text()}`);
      await ow.login(opts.email, opts.password);
    }
  }

  // ───────────────────────── Relojes y ventanas ─────────────────────────
  const reloj = await medirReloj(opts.api);
  m.reloj = { ...reloj, medidoEn: new Date().toISOString() };
  const ahoraS = () => Date.now() + reloj.skewMs;
  const pausa = opts.pausaMs ?? (opts.remoto ? (reloj.preciso ? 2600 : 3600) : 450);
  log(`Reloj: diferencia con el servidor ${Math.round(reloj.skewMs)} ms${reloj.preciso ? '' : ' (no se pudo medir con precisión)'} · pausa entre jornadas ${pausa} ms`);
  m.ventanas ??= [];
  const iso = (ms) => new Date(ms).toISOString();

  // ───────────────────────── Configuración inicial (idempotente) ─────────────────────────
  if (!m.setupHecho) {
    const t0 = m.setupT0 ?? iso(ahoraS());
    m.setupT0 = t0;
    await guardar();
    await configurarTaller();
    const t1 = iso(ahoraS());
    m.ventanas = m.ventanas.filter((v) => v.dia !== null);
    m.ventanas.unshift({ dia: null, simDia: sumarDias(plan.fechas[0], -1), t0, t1 });
    m.setupHecho = true;
    await guardar();
    await dormir(pausa);
  } else {
    await cargarCatalogos();
  }

  async function cargarCatalogos() {
    ctx.servicios = await ow.get('/servicios?todos=1');
    ctx.marcas = await ow.get('/marcas');
    ctx.catGasto = await ow.get('/categorias-gasto');
    ctx.catArt = await ow.get('/categorias-articulo');
    await refrescarArticulos();
    if (!ad) ad = await new Sesion(opts.api, 'administrador').login(USUARIOS[0].email, opts.passwordUsuarios);
    if (!em) em = await new Sesion(opts.api, 'empleado').login(USUARIOS[1].email, opts.passwordUsuarios);
  }
  async function refrescarArticulos() {
    for (const a of await ow.get('/articulos?limite=1000')) ctx.arts.set(a.codigo, a);
  }

  async function configurarTaller() {
    const pre = await ow.get('/clientes?limite=500&inactivos=1');
    const ajenos = pre.filter((c) => c.codigo !== 0);
    if (ajenos.length && Object.keys(ids.cli).length === 0) {
      throw new Error(`El taller "${me.taller.nombre}" ya tiene ${ajenos.length} clientes que no cargó este generador. Para no mezclar datos, usá un taller vacío (el generador no borra nada).`);
    }
    log('Configuración del taller…');
    await ow.put('/taller/config', { taller: { ...TALLER }, config: { ...CONFIG } });
    // Usuarios del taller (cupo de licencia: 1 + adicionales)
    const existentes = (await ow.get('/taller/usuarios')).usuarios;
    for (const u of USUARIOS) {
      if (!existentes.some((x) => x.email === u.email)) await ow.post('/taller/usuarios', { ...u, password: opts.passwordUsuarios });
    }
    ad = await new Sesion(opts.api, 'administrador').login(USUARIOS[0].email, opts.passwordUsuarios);
    em = await new Sesion(opts.api, 'empleado').login(USUARIOS[1].email, opts.passwordUsuarios);
    await cargarCatalogos();

    log('Mecánicos y proveedores…');
    const mecs = await ow.get('/mecanicos');
    for (const x of MECANICOS) {
      let r = mecs.find((y) => y.nombre === x.nombre);
      if (!r) r = await ow.post('/mecanicos', { nombre: x.nombre, telefono: x.telefono, especialidad: x.especialidad });
      ids.mec[x.key] = r.id;
    }
    const provs = await ad.get('/proveedores');
    for (const x of PROVEEDORES) {
      let r = provs.find((y) => y.nombre === x.nombre);
      if (!r) r = await ad.post('/proveedores', { nombre: x.nombre, cuit: x.cuit, condicion_iva: x.cond, telefono: x.tel, direccion: x.dir, notas: `${MARCA} Proveedor ficticio de demostración` });
      ids.prov[x.key] = r.id;
    }
    await guardar();

    log('Cuentas bancarias y listas de precios…');
    const cuentas = await ad.get('/bancos/cuentas?todas=1');
    for (const c of CUENTAS) {
      let r = cuentas.find((y) => y.nombre === c.nombre);
      if (!r) r = await ad.post('/bancos/cuentas', { nombre: c.nombre, banco: c.banco, tipo: c.tipo, alias: c.alias, cbu: c.cbu, titular: TALLER.razon_social, cuit_titular: TALLER.cuit, moneda: 'ARS', saldo_inicial: pesos(c.saldo), notas: `${MARCA} Cuenta ficticia` });
      ids.cuenta[c.key] = r.id;
    }
    const listas = await ow.get('/listas-precios?todas=1');
    for (const l of LISTAS) {
      let r = listas.find((y) => y.nombre === l.nombre);
      if (!r) r = await ow.post('/listas-precios', { nombre: l.nombre, descripcion: l.descripcion, base: l.base, porcentaje: l.porcentaje, redondeo: l.redondeo, servicios_pct: l.servicios_pct });
      ids.lista[l.key] = r.id;
    }
    await guardar();

    if (!m.serviciosAjustados) {
      log(`Mano de obra: ajuste de ${AJUSTE_SERVICIOS_PCT} % sobre el catálogo inicial de servicios…`);
      await ow.post('/servicios/ajuste-masivo', { porcentaje: AJUSTE_SERVICIOS_PCT, redondeo: '100' });
      ctx.servicios = await ow.get('/servicios?todos=1');
      m.serviciosAjustados = true;
      await guardar();
    }
    log(`Artículos (${ARTICULOS.length}) con su stock inicial…`);
    const existentesArt = new Set([...ctx.arts.keys()]);
    for (const a of ARTICULOS) {
      if (existentesArt.has(a.codigo)) continue;
      const cat = ctx.catArt.find((c) => c.nombre === a.categoria);
      await ow.post('/articulos', { codigo: a.codigo, nombre: a.nombre, marca: a.marca, categoria_id: cat?.id ?? null, proveedor_id: ids.prov[a.prov], costo: a.costo, precio: a.precio, alicuota_iva: 21, stock_inicial: a.stock0, stock_minimo: a.min, stock_objetivo: a.objetivo, unidad: a.unidad });
    }
    await refrescarArticulos();
    await guardar();
  }

  // ───────────────────────── Altas bajo demanda ─────────────────────────
  async function ensureCliente(key) {
    if (ids.cli[key]) return ids.cli[key];
    const c = plan.clientes.find((x) => x.key === key);
    const ya = (await ow.get(`/clientes?limite=5&q=${encodeURIComponent(c.documento)}`)).find((x) => x.documento === c.documento);
    if (ya) return (ids.cli[key] = ya.id);
    const r = await ow.post('/clientes', {
      nombre: c.nombre, documento_tipo: c.documento_tipo, documento: c.documento, condicion_iva: c.condicion_iva, telefono: c.telefono, email: c.email,
      direccion: c.direccion, localidad: c.localidad, notas: `${MARCA} Cliente ficticio de demostración`,
    });
    ids.cli[key] = r.id;
    await guardar();
    return r.id;
  }
  async function ensureVeh(key) {
    if (ids.veh[key]) return ids.veh[key];
    const v = plan.vehs.find((x) => x.key === key);
    const cid = await ensureCliente(v.cliente.key);
    const ya = (await ow.get(`/vehiculos?q=${encodeURIComponent(v.patente)}`)).find((x) => x.patente === v.patente);
    if (ya) return (ids.veh[key] = ya.id);
    let marca = ctx.marcas.find((x) => x.nombre.toLowerCase() === v.marca.toLowerCase());
    if (!marca) { const r = await ow.post('/marcas', { nombre: v.marca }); marca = { id: r.id, nombre: v.marca, modelos: [] }; ctx.marcas.push(marca); }
    let modelo = marca.modelos.find((x) => x.nombre.toLowerCase() === v.modelo.toLowerCase());
    if (!modelo) { const r = await ow.post('/modelos', { marca_id: marca.id, nombre: v.modelo }); modelo = { id: r.id, nombre: v.modelo }; marca.modelos.push(modelo); }
    const r = await ow.post('/vehiculos', {
      cliente_id: cid, patente: v.patente, marca_id: marca.id, modelo_id: modelo.id, anio: v.anio, color: v.color, combustible: v.combustible, km_actual: v.km, notas: `${MARCA} Vehículo ficticio de demostración`,
    });
    ids.veh[key] = r.id;
    await guardar();
    return r.id;
  }
  const servicio = (n) => {
    const s = ctx.servicios.find((x) => x.nombre === n) ?? ctx.servicios.find((x) => x.nombre.startsWith(n));
    if (!s) throw new Error(`El servicio "${n}" no existe en el catálogo del taller`);
    return s;
  };
  async function resolverItems(items, listaKey) {
    let pa = {}, ps = {};
    if (listaKey) {
      const r = await ow.post(`/listas-precios/${ids.lista[listaKey]}/precios`, {
        articulos: items.filter((i) => i.t === 'a').map((i) => ctx.arts.get(i.c).id),
        servicios: items.filter((i) => i.t === 's').map((i) => servicio(i.n).id),
      });
      pa = r.articulos; ps = r.servicios;
    }
    return items.map((i) => {
      if (i.t === 'a') {
        const a = ctx.arts.get(i.c);
        return { tipo: 'articulo', articulo_id: a.id, descripcion: a.nombre, cantidad: i.q, precio_unitario: pa[a.id] ?? a.precio, desc_pct: i.desc ?? 0 };
      }
      if (i.t === 's') {
        const s = servicio(i.n);
        return { tipo: 'servicio', servicio_id: s.id, descripcion: s.nombre, cantidad: 1, precio_unitario: ps[s.id] ?? s.precio, desc_pct: 0 };
      }
      return { tipo: 'libre', descripcion: i.d, cantidad: i.q, precio_unitario: i.precio, desc_pct: 0 };
    });
  }
  const chequeDatos = (d, extra = {}) => {
    if (!d) return null;
    const { emision_antes, ...resto } = d;
    return { ...resto, fecha_emision: sumarDias(extra.fecha_pago ?? hoyReal(), -(emision_antes ?? 3)), ...extra };
  };
  const cuentaId = (k) => (k ? ids.cuenta[k] : null);
  const cobroInmediato = (c) => c && { medio: c.medio, referencia: c.referencia ?? null, cuenta_id: cuentaId(c.cuenta), cheque: c.medio === 'cheque' ? chequeDatos(c.cheque) : null };
  const buscarCheque = async (chq) => {
    const nro = chq.replace(/^CH-/, '');
    const r = (await ad.get(`/cheques?q=${encodeURIComponent(nro)}&limite=20`)).find((x) => x.nro_cheque === nro);
    if (!r) throw new Error(`No se encontró el cheque ${nro}`);
    return r;
  };
  async function efectivoEsperado() {
    const e = await ow.get('/caja/estado');
    return e.sesion?.resumen.efectivo_esperado ?? 0;
  }
  /** Asegura efectivo en caja antes de una salida: si falta, el propietario hace un aporte (queda registrado como ingreso manual). */
  async function asegurarEfectivo(importe) {
    const esp = await efectivoEsperado();
    if (esp >= importe + pesos(5000)) return;
    const aporte = Math.ceil((importe + pesos(30000) - esp) / pesos(10000)) * pesos(10000);
    m.contadores.aporte++;
    await ow.post('/caja/movimientos', { medio: 'efectivo', importe: aporte, concepto: 'Aporte del propietario para cubrir pagos en efectivo', idem_key: `demo:aporte:${m.contadores.aporte}` });
    await guardar();
  }
  const cat = (nombre) => {
    const c = ctx.catGasto.find((x) => x.nombre === nombre);
    if (!c) throw new Error(`Categoría de gasto inexistente: ${nombre}`);
    return c.id;
  };
  const ventaDe = async (ref) => {
    let id = ids.venta[ref];
    if (!id && ids.ot[ref]) {
      const o = await ow.get(`/ordenes/${ids.ot[ref]}`);
      id = o.venta_id;
      if (id) ids.venta[ref] = id;
    }
    if (!id) throw new Error(`No hay comprobante para ${ref}`);
    return ow.get(`/ventas/${id}`);
  };

  // ───────────────────────── Acciones ─────────────────────────
  const acciones = {
    async alta_cliente(a) { await ensureVeh(a.veh); },

    async turno(a) {
      const cid = await ensureCliente(a.cliente);
      const r = await ow.post('/turnos', {
        fecha: rel(a.fecha), hora: a.hora, duracion_min: a.dur, cliente_id: cid, vehiculo_id: await ensureVeh(a.veh), mecanico_id: ids.mec[a.mec],
        presupuesto_id: a.presKey ? ids.pres[a.presKey] ?? null : null, motivo: a.motivo,
      });
      ids.turno[a.key] = r.id;
    },
    async turno_estado(a) { await ow.put(`/turnos/${ids.turno[a.key]}`, { estado: a.estado }); },

    async pres(a) {
      const r = await ow.post('/presupuestos', {
        cliente_id: await ensureCliente(a.cliente), vehiculo_id: await ensureVeh(a.veh), km: a.km ?? null, iva_pct: 21,
        lista_precio_id: a.lista ? ids.lista[a.lista] : null, observaciones: a.obs, items: await resolverItems(a.items, a.lista),
      });
      ids.pres[a.key] = r.id;
    },
    async pres_estado(a) { await ow.post(`/presupuestos/${ids.pres[a.key]}/estado`, { estado: a.estado }); },
    async pres_ot(a) {
      await ensureVeh(a.veh);
      const r = await ow.post(`/presupuestos/${ids.pres[a.presKey]}/convertir`, { mecanico_id: ids.mec[a.mec], fecha_prometida: rel(a.prometida), km_ingreso: a.km });
      ids.ot[a.key] = r.id;
    },

    async ot(a) {
      const r = await ow.post('/ordenes', {
        cliente_id: await ensureCliente(a.cliente), vehiculo_id: await ensureVeh(a.veh), mecanico_id: ids.mec[a.mec], km_ingreso: a.km, falla_reportada: a.falla,
        iva_pct: 21, fecha_prometida: rel(a.prometida), lista_precio_id: a.lista ? ids.lista[a.lista] : null, turno_id: a.turnoKey ? ids.turno[a.turnoKey] : null,
        items: await resolverItems(a.items, a.lista),
      });
      ids.ot[a.key] = r.id;
    },
    async ot_items(a) {
      const o = await ow.get(`/ordenes/${ids.ot[a.key]}`);
      await ow.put(`/ordenes/${o.id}`, {
        cliente_id: o.cliente_id, vehiculo_id: o.vehiculo_id, mecanico_id: o.mecanico_id, km_ingreso: o.km_ingreso, falla_reportada: o.falla_reportada,
        diagnostico: 'Se confirma la falla en el diagnóstico y se presupuesta la reparación.', observaciones: o.observaciones, fecha_prometida: o.fecha_prometida,
        desc_global_pct: o.desc_global_pct, desc_global_monto: o.desc_global_monto, iva_pct: 21, recargo_pct: o.recargo_pct, lista_precio_id: o.lista_precio_id,
        items: await resolverItems(a.items, o.lista_precio_id ? Object.keys(ids.lista).find((k) => ids.lista[k] === o.lista_precio_id) : null), version: o.version,
      });
    },
    async ot_check(a) {
      const v = [
        { danos: ['Rayones'], testigos: [], accesorios: ['Rueda de auxilio', 'Criquet / llave'], ingreso: 'Funcionando', combustible: '1/2' },
        { danos: [], testigos: ['Check engine'], accesorios: ['Matafuego', 'Balizas', 'Documentación'], ingreso: 'Funcionando', combustible: '1/4' },
        { danos: ['Golpes'], testigos: [], accesorios: ['Rueda de auxilio', 'Segunda llave'], ingreso: 'Arranca con dificultad', combustible: '3/4' },
      ][a.variante];
      const o = await ow.get(`/ordenes/${ids.ot[a.key]}`);
      await ow.put(`/ordenes/${o.id}/checklist`, {
        combustible: v.combustible, km: o.km_ingreso, datos: { danos: v.danos, testigos: v.testigos, accesorios: v.accesorios, ingreso: v.ingreso }, recibido_por: 'Recepción', observaciones: null,
      });
    },
    async ot_estado(a) { await ow.post(`/ordenes/${ids.ot[a.key]}/estado`, { estado: a.estado, nota: a.nota ?? null }); },
    async ot_comp(a) {
      let r;
      try {
        r = await ow.post(`/ordenes/${ids.ot[a.key]}/comprobante`, { condicion: a.cond, ...(a.cobro ? { cobro: cobroInmediato(a.cobro) } : {}) });
      } catch (e) {
        if (!(e instanceof ErrorApi) || e.codigo !== 'duplicado') throw e;
        r = { id: (await ow.get(`/ordenes/${ids.ot[a.key]}`)).venta_id };
      }
      ids.venta[a.key] = r.id;
    },

    async venta(a) {
      const body = {
        cliente_id: a.cliente ? await ensureCliente(a.cliente) : null, condicion: a.cond, iva_pct: 21, items: await resolverItems(a.items, a.lista),
        lista_precio_id: a.lista ? ids.lista[a.lista] : null, idem_key: `demo:venta:${a.key}`, observaciones: a.cond === 'cuenta_corriente' ? 'Venta a cuenta corriente' : null,
        ...(a.cobro ? { cobro: cobroInmediato(a.cobro) } : {}),
      };
      const r = await ses(a.user).post('/ventas', body);
      ids.venta[a.key] = r.id;
    },
    async venta_anular(a) { await ow.post(`/ventas/${ids.venta[a.key]}/anular`, { motivo: a.motivo }); },
    async cobro(a) {
      const v = await ventaDe(a.ref);
      const saldo = v.total - v.cobrado;
      if (saldo <= 0) return;
      const importe = a.parte === 'saldo' ? saldo : Math.min(saldo, Math.max(100, Math.round((v.total * a.parte) / 100) * 100));
      await ow.post('/cobros', {
        cliente_id: v.cliente_id, notas: a.notas ?? null, idem_key: `demo:cobro:${a.key}`,
        medios: [{ medio: a.medio, importe, referencia: a.referencia ?? null, cuenta_id: cuentaId(a.cuenta), cheque: a.medio === 'cheque' ? chequeDatos(a.cheque) : null }],
        aplicaciones: [{ venta_id: v.id, importe }],
      });
    },
    async cobro_anular(a) {
      const v = await ventaDe(a.ref);
      for (const c of v.cobros.filter((x) => x.estado === 'registrado')) await ow.post(`/cobros/${c.id}/anular`, { motivo: a.motivo });
    },

    async compra(a) {
      if (a.pago?.medio === 'efectivo') await asegurarEfectivo(a.total);
      const r = await ad.post('/compras', {
        proveedor_id: ids.prov[a.prov], tipo_doc: 'factura', numero_doc: a.doc, iva: a.iva, notas: a.nota, vencimiento: a.venc ? rel(a.venc) : null, idem_key: `demo:compra:${a.key}`,
        items: a.items.map((i) => ({ articulo_id: ctx.arts.get(i.c).id, cantidad: i.q, costo_unitario: i.costo })),
        ...(a.pago ? { pago: { medio: a.pago.medio, referencia: a.pago.referencia ?? null, cuenta_id: cuentaId(a.pago.cuenta) } } : {}),
      });
      ids.compra[a.key] = { id: r.id, total: a.total, pagado: a.pago ? a.total : 0, prov: a.prov };
      await refrescarArticulos();
    },
    async factura(a) {
      const body = {
        proveedor_id: ids.prov[a.prov], tipo: a.tipoF, nro_comprobante: a.nro, fecha: hoyReal(), neto_gravado: a.neto, iva_21: a.iva, total: a.total,
        condicion_pago: a.condicion, dias_plazo: a.condicion === 'plazo' ? a.dias : null, notas: a.notas ?? null, idem_key: `demo:factura:${a.key}`,
      };
      if (a.compraKey) body.compra_id = ids.compra[a.compraKey].id;
      if (a.ocKey) body.orden_compra_id = ids.oc[a.ocKey];
      await ad.post('/facturas-proveedor', body);
    },
    async pago(a) {
      const compra = a.compraKey || a.resto ? ids.compra[a.compraKey ?? a.resto] : null;
      const cta = await ad.get(`/proveedores/${ids.prov[a.prov]}/cuenta`);
      let importe = a.importe ?? (a.resto ? compra.total - compra.pagado : Math.round((compra.total * a.parte) / 100) * 100);
      importe = Math.min(importe, cta.saldo);
      if (importe <= 0) return;
      if (a.medio === 'efectivo') await asegurarEfectivo(importe);
      const body = { proveedor_id: ids.prov[a.prov], importe, medio: a.medio, referencia: a.referencia ?? null, notas: a.notas ?? null, idem_key: `demo:pago:${a.key}`, cuenta_id: cuentaId(a.cuenta) };
      if (a.endoso) body.cheque_id = (await buscarCheque(a.endoso)).id;
      if (a.chequePropio) body.cheque = { banco: a.chequePropio.banco, cuenta_id: cuentaId(a.chequePropio.cuenta), fecha_pago: rel(sumarDias(ctx.simDia, a.chequePropio.pagoEn)), fecha_emision: hoyReal() };
      await ad.post('/pagos-proveedor', body);
      if (compra) compra.pagado += importe;
    },

    async oc(a) {
      const r = await ad.post('/ordenes-compra', {
        proveedor_id: ids.prov[a.prov], fecha_prevista: rel(a.prevista), iva_pct: 21, actualizar_costos: true, observaciones: a.obs, emitir: a.emitir, idem_key: `demo:oc:${a.key}`,
        items: a.items.map((i) => ({ articulo_id: ctx.arts.get(i.c).id, cantidad: i.q, costo_unitario: i.costo, desc_pct: 0 })),
      });
      ids.oc[a.key] = r.id;
    },
    async oc_recibir(a) {
      const oc = await ad.get(`/ordenes-compra/${ids.oc[a.ocKey]}`);
      const lineas = a.todo ? oc.items.map((i) => ({ orden_item_id: i.id, cantidad: i.pendiente })).filter((i) => i.cantidad > 0)
        : a.items.map(([c, q]) => ({ orden_item_id: oc.items.find((i) => i.codigo === c).id, cantidad: q }));
      ids.rec_n[a.ocKey] = (ids.rec_n[a.ocKey] ?? 0) + 1;
      await ad.post(`/ordenes-compra/${oc.id}/recepciones`, { remito: a.remito, items: lineas, idem_key: `demo:recepcion:${a.ocKey}:${ids.rec_n[a.ocKey]}` });
      await refrescarArticulos();
    },
    async oc_cancelar(a) { await ad.post(`/ordenes-compra/${ids.oc[a.ocKey]}/cancelar`, { motivo: a.motivo }); },
    async repo_oc() { // (disponible: arma un borrador con lo que esté en o bajo el mínimo)
      const rep = (await ad.get('/reposicion')).filter((x) => x.proveedor_id && x.sugerido > 0).slice(0, 4);
      if (!rep.length) return log('  (reposición: no hay artículos bajo mínimo con proveedor)');
      m.contadores.repo++;
      await ad.post('/reposicion/ordenes', { items: rep.map((x) => ({ articulo_id: x.id, cantidad: x.sugerido })), emitir: false, idem_key: `demo:repo:${m.contadores.repo}` });
    },

    async gasto(a) {
      if (a.medio === 'efectivo') await asegurarEfectivo(a.importe);
      await ad.post('/gastos', { categoria_id: cat(a.cat), concepto: a.concepto, importe: a.importe, medio: a.medio, referencia: a.referencia ?? null, comprobante: a.comprobante ?? null, cuenta_id: cuentaId(a.cuenta), idem_key: `demo:gasto:${a.key}` });
    },
    async gasto_rec_crear(a) {
      const r = await ad.post('/gastos-recurrentes', { categoria_id: cat(a.cat), concepto: a.concepto, importe: a.importe, medio: a.medio, frecuencia: a.frecuencia, dia: a.dia, proxima_fecha: rel(a.proxima) });
      ids.gastoRec[a.key] = r.id;
    },
    async gasto_rec_registrar(a) {
      const r = (await ad.get('/gastos-recurrentes')).find((x) => x.id === ids.gastoRec[a.key]);
      await ad.post(`/gastos-recurrentes/${r.id}/registrar`, { ocurrencia: r.proxima_fecha, medio: a.medio, idem_key: `demo:gastorec:${a.key}:${r.proxima_fecha}` });
    },

    async caja_ingreso(a) { await ow.post('/caja/movimientos', { medio: 'efectivo', importe: a.importe, concepto: a.concepto, idem_key: `demo:ingreso:${a.key}` }); },
    async arqueo(a) {
      const esp = await efectivoEsperado();
      const contado = Math.max(0, esp + (a.delta ?? 0));
      let resto = Math.round(contado / 100);
      const detalle = {};
      for (const b of ARQUEO_BILLETES) { const n = Math.floor(resto / b); if (n) detalle[String(b)] = n; resto -= n * b; }
      await ow.post('/caja/arqueos', { contado, detalle, notas: 'Arqueo parcial de la jornada' });
    },
    async deposito(a) {
      const esp = await efectivoEsperado();
      const importe = Math.floor((esp - a.dejar) / pesos(1000)) * pesos(1000);
      if (importe < pesos(50000)) return;
      m.contadores.deposito++;
      await ad.post('/bancos/depositos', { cuenta_id: cuentaId(a.cuenta), importe, concepto: a.concepto, idem_key: `demo:deposito:${m.contadores.deposito}` });
    },
    async extraccion(a) { await ad.post('/bancos/extracciones', { cuenta_id: cuentaId(a.cuenta), importe: a.importe, concepto: a.concepto, idem_key: `demo:extraccion:${a.concepto.length}:${a.importe}` }); },
    async transferencia(a) { await ad.post('/bancos/transferencias', { origen_id: cuentaId(a.origen), destino_id: cuentaId(a.destino), importe: a.importe, concepto: a.concepto, idem_key: `demo:transf:${a.origen}:${a.destino}:${ctx.simDia}` }); },
    async banco_mov(a) { await ad.post('/bancos/movimientos', { cuenta_id: cuentaId(a.cuenta), tipo: a.mov, importe: a.importe, concepto: a.concepto, idem_key: `demo:bmov:${a.cuenta}:${a.concepto.length}:${ctx.simDia}:${a.mov}` }); },
    async conciliar(a) {
      const c = await ad.get(`/bancos/conciliacion/${cuentaId(a.cuenta)}`);
      const pend = c.pendientes.filter((x) => x.fecha <= hoyReal()).slice(0, 500);
      if (!pend.length) return log(`  (conciliación ${a.cuenta}: no hay movimientos pendientes)`);
      const suma = pend.reduce((s, x) => s + (x.tipo === 'ingreso' ? x.importe : -x.importe), 0);
      await ad.post('/bancos/conciliaciones', { cuenta_id: c.cuenta.id, fecha_corte: hoyReal(), saldo_extracto: c.cuenta.saldo_conciliado + suma + a.dif, movimiento_ids: pend.map((x) => x.id), notas: a.notas });
    },

    async cheque_manual(a) {
      const fechaPago = rel(sumarDias(ctx.simDia, a.pagoEn));
      const d = chequeDatos(a.datos, { fecha_pago: fechaPago });
      await ad.post('/cheques', {
        direccion: 'recibido', modalidad: d.modalidad, banco: d.banco, nro_cheque: a.nro, echeq_id: d.echeq_id ?? null, librador: d.librador, cuit: d.cuit, importe: a.importe,
        fecha_emision: d.fecha_emision, fecha_pago: fechaPago, cliente_id: await ensureCliente(a.cliente), observaciones: 'Recibido en mostrador como pago a cuenta',
      });
    },
    async cheque_dep(a) {
      const c = await buscarCheque(a.chq);
      if (c.estado !== 'en_cartera') return;
      await ad.post(`/cheques/${c.id}/depositar`, { cuenta_id: cuentaId(a.cuenta) });
    },
    async cheque_acr(a) {
      const c = await buscarCheque(a.chq);
      if (!['depositado', 'entregado'].includes(c.estado)) return;
      await ad.post(`/cheques/${c.id}/acreditar`, { cuenta_id: c.cuenta_id ?? cuentaId(a.cuenta) });
    },
    async cheque_rech(a) {
      const c = await buscarCheque(a.chq);
      await ad.post(`/cheques/${c.id}/rechazar`, { motivo: a.motivo, comision: a.comision });
    },

    async stock_ajuste(a) {
      await ad.post('/stock/movimientos', { articulo_id: ctx.arts.get(a.c).id, tipo: a.mov, cantidad: a.q, motivo: a.motivo, notas: a.notas, idem_key: `demo:stock:${a.c}:${ctx.simDia}:${a.mov}` });
      await refrescarArticulos();
    },
    async conteo(a) {
      const c = ctx.catArt.find((x) => x.nombre === a.cat);
      const r = await ad.post('/inventario/conteos', { descripcion: a.desc, categoria_id: c.id, solo_con_stock: false });
      await ad.put(`/inventario/conteos/${r.id}/items`, { items: Object.entries(a.contados).map(([cod, q]) => ({ articulo_id: ctx.arts.get(cod).id, contado: q })) });
      if (a.aplicar) await ad.post(`/inventario/conteos/${r.id}/aplicar`, {});
      await refrescarArticulos();
    },
    async ajuste_precios(a) {
      await ad.post('/articulos/ajuste-masivo', { aplicar_a: 'precio', modo: 'porcentaje', valor: a.precio, redondeo: 100 });
      await ad.post('/servicios/ajuste-masivo', { porcentaje: a.servicios, redondeo: '100' });
      ctx.servicios = await ow.get('/servicios?todos=1');
      await refrescarArticulos();
    },
    async veh_km(a) { await ow.put(`/vehiculos/${await ensureVeh(a.veh)}`, { km_actual: a.km }); },
  };

  // ───────────────────────── Cierre de caja ─────────────────────────
  async function cerrarCaja(i) {
    const esp = await efectivoEsperado();
    const cfg = plan.caja.cierres.get(i);
    const declarado = Math.max(0, esp + (cfg?.delta ?? 0));
    const dif = declarado - esp;
    await ow.post('/caja/cerrar', {
      declarados: [{ medio: 'efectivo', importe: declarado }], esperado_visto: esp,
      notas: Math.abs(dif) > CONFIG.tolerancia_caja ? cfg?.notas ?? 'Diferencia explicada en el cierre' : cfg?.notas ?? null,
    });
  }
  async function abrirCaja(i) {
    const e = await ow.get('/caja/estado');
    if (e.sesion) return;
    const inicial = e.ultima_cierre?.efectivo_declarado ?? pesos(250000);
    await ow.post('/caja/abrir', { saldo_inicial: inicial, notas: `[DEMO·sin fechar] Jornada ${plan.fechas[i]}` });
  }

  // ───────────────────────── Bucle de jornadas ─────────────────────────
  const porDia = Array.from({ length: plan.N }, () => []);
  plan.acciones.forEach((a, idx) => { a.idx = idx; porDia[a.dia].push(a); });
  const hechos = new Set((m.ventanas ?? []).filter((v) => v.dia !== null && v.t1).map((v) => v.dia));
  const tInicioReal = hoyAR();
  const inicio = Date.now();
  for (let i = 0; i < plan.N; i++) {
    if (hechos.has(i)) continue;
    if (hoyAR() !== tInicioReal) throw new Error('La ejecución cruzó la medianoche (hora argentina). Reanudala: el día de hoy cambió y las fechas relativas ya no coincidirían.');
    ctx.simDia = plan.fechas[i];
    const previa = m.ventanas.find((v) => v.dia === i);
    const t0 = previa?.t0 ?? iso(ahoraS());
    if (!previa) { m.ventanas.push({ dia: i, simDia: ctx.simDia, t0, t1: null }); await guardar(); }
    await abrirCaja(i);
    for (const a of porDia[i]) {
      if (a.idx <= (m.hechas ?? -1)) continue;
      try {
        if (!acciones[a.tipo]) throw new Error(`acción desconocida: ${a.tipo}`);
        await acciones[a.tipo](a);
      } catch (e) {
        m.ultimoError = { idx: a.idx, tipo: a.tipo, key: a.key ?? null, dia: ctx.simDia, mensaje: e.message };
        await guardar();
        throw new Error(`Falló la acción #${a.idx} (${a.tipo}${a.key ? ' ' + a.key : ''}) de la jornada ${ctx.simDia}: ${e.message}`);
      }
      m.hechas = a.idx;
      await guardar();
    }
    if (i < plan.N - 1) await cerrarCaja(i);
    const v = m.ventanas.find((x) => x.dia === i);
    v.t1 = iso(ahoraS());
    await guardar();
    const seg = Math.round((Date.now() - inicio) / 1000);
    log(`  jornada ${String(i + 1).padStart(2)}/${plan.N} ${ctx.simDia} · ${porDia[i].length} operaciones · ${seg}s`);
    if (i < plan.N - 1) await dormir(pausa);
  }
  m.estado = 'cargado';
  m.fin = new Date().toISOString();
  await guardar();
  return { ow, ad, em, ids, ctx };
}
