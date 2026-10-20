// Planificador del taller de demostración: construye, de forma determinista, ~90 días de actividad.
//
// El plan es declarativo (no toca la red): cada acción describe QUÉ ocurre ese día; el ejecutor la lleva a cabo con la API real.
// Mientras planifica mantiene un libro de stock "sombra" para que ningún flujo deje existencias negativas, y reparte las
// operaciones en historias completas: presupuesto → OT → comprobante → cobro, compra → ingreso de stock → venta, etc.
import { AJUSTE_SERVICIOS_PCT, ARTICULOS, BANCOS_CHEQUE, PERFILES, PROVEEDORES, SERVICIOS, construirClientes } from './catalogo.mjs';
import { diasEntre, jornadas, pesos, redondear, rng, sumarDias } from './util.mjs';

// Orden de las acciones dentro de una jornada.
export const O = { URGENTE: 5, REPO: 6, PRES: 10, TURNO: 12, OT: 20, CHECK: 21, REP: 30, LISTA: 33, COMP: 40, ENTR: 45, VENTA: 50, COBRO: 55, COMPRA: 60, PAGO: 65, GASTO: 70, BANCO: 80, STOCK: 85, CAJA: 90 };

// ───── Recetas de trabajos ─────
const S = (n) => ({ t: 's', n });
const A = (c, q = 1, desc = 0) => ({ t: 'a', c, q, desc });
const Lb = (d, precio, q = 1) => ({ t: 'l', d, precio, q });
const JOBS = {
  service: { w: 22, mec: ['M4', 'M4', 'M1'], presupuesta: 0.1, falla: ['Service de los 10.000 km', 'Cambio de aceite y filtros', 'Service programado', 'Le toca el service, pierde un poco de aceite'], items: (p) => [S('Service de aceite y filtros'), A(p.aceite), A(p.fAceite)] },
  service_comp: { w: 12, mec: ['M4'], presupuesta: 0.3, falla: ['Service completo antes de viajar', 'Service de los 20.000 km con todos los filtros', 'Service completo, quiere revisar niveles'], items: (p) => [S('Service completo'), A(p.aceite), A(p.fAceite), A(p.fAire), A(p.fComb), A(p.fHab)] },
  frenos: { w: 14, mec: ['M2'], presupuesta: 0.4, falla: ['Los frenos chillan al frenar', 'Ruido metálico en el freno delantero', 'Pedal largo y vibración al frenar', 'Pastillas gastadas según el último service'], items: (p) => [S('Cambio de pastillas delanteras'), A(p.pastDel)] },
  frenos_disc: { w: 6, mec: ['M2'], presupuesta: 0.9, falla: ['Vibración en el volante al frenar', 'Discos alabeados, pedal que pulsa'], items: (p) => [S('Cambio de pastillas y discos delanteros'), A(p.pastDel), A(p.disDel), S('Cambio de líquido de frenos'), A('LIQ-FRE-D4')] },
  frenos_tras: { w: 4, mec: ['M2'], presupuesta: 0.3, falla: ['Freno de mano flojo', 'Ruido en las ruedas traseras'], items: (p) => [S('Cambio de cintas / pastillas traseras'), A(p.pastTra)] },
  distribucion: { w: 5, mec: ['M1'], presupuesta: 1, falla: ['Cambio de kit de distribución por kilometraje', 'Ruido en la distribución, prefiere cambiarla'], items: (p) => [S('Cambio de kit de distribución'), A(p.kit), S('Cambio de bomba de agua'), A(p.bomba), S('Cambio de líquido refrigerante'), A(p.refri)] },
  amort: { w: 6, mec: ['M2'], presupuesta: 0.8, falla: ['Rebota mucho en los pozos', 'Pierde aceite el amortiguador delantero'], items: (p) => [S('Cambio de amortiguadores delanteros'), A(p.amDel, 2), S('Alineación y balanceo')] },
  amort_tras: { w: 3, mec: ['M2'], presupuesta: 0.7, falla: ['Ruido en la parte trasera al pasar lomas de burro'], items: (p) => [S('Cambio de amortiguadores traseros'), A(p.amTra, 2)] },
  bujias: { w: 7, mec: ['M3', 'M1'], presupuesta: 0.1, falla: ['Pierde potencia y consume de más', 'Le cuesta arrancar en frío', 'Tironea al acelerar'], items: (p) => [S('Cambio de bujías'), A(p.bujia, 4)] },
  bateria: { w: 5, mec: ['M3'], presupuesta: 0.6, falla: ['No arranca por la mañana', 'La batería no mantiene carga'], items: (p) => [S('Cambio de batería'), A(p.bateria), A('BOR-BAT')] },
  refrigeracion: { w: 4, mec: ['M1'], presupuesta: 0.3, falla: ['Pierde agua y sube la temperatura', 'Hierve en el tránsito'], items: (p) => [S('Cambio de líquido refrigerante'), A(p.refri, 2), A('TER-A')] },
  diagnostico: { w: 6, mec: ['M3'], presupuesta: 0, falla: ['Se enciende el check engine', 'Falla intermitente, se apaga en ralentí', 'Luz de ABS encendida'], items: () => [S('Diagnóstico con escáner'), Lb('Mano de obra por hora (reparación de ficha y sensor)', pesos(25000), 1.5), A('SEN-OXI')] },
  caja_auto: { w: 2, mec: ['M4'], presupuesta: 0.2, falla: ['Service de caja automática, cambia de marcha con golpes'], items: () => [S('Service caja automática'), A('ACE-ATF-L', 8.5)] },
  aa: { w: 3, mec: ['M4'], presupuesta: 0, falla: ['El aire acondicionado no enfría'], items: () => [S('Carga de gas A/A'), A('GAS-R134', 0.6)] },
  prevtv: { w: 4, mec: ['M3', 'M4'], presupuesta: 0, falla: ['Revisión previa a la VTV', 'Pre-VTV, vence la semana próxima'], items: () => [S('Revisión general / pre-VTV'), S('Alineación y balanceo'), A('LAM-H4')] },
  tren_del: { w: 3, mec: ['M2'], presupuesta: 0.5, falla: ['Golpea el tren delantero en las curvas', 'Juego en la dirección'], items: () => [S('Cambio de bujes / extremos'), A('BUJ-SUS'), A('EXT-DIR', 2)] },
};
const JOB_KEYS = Object.keys(JOBS).map((k) => [k, JOBS[k].w]);

// ───── Ventas de mostrador ─────
const MOSTRADOR = [
  { w: 8, items: (p) => [A(p.aceite), A(p.fAceite)] },
  { w: 5, items: (p) => [A(p.bujia, 4)] },
  { w: 3, items: (p) => [A(p.bateria), A('BOR-BAT')] },
  { w: 5, items: () => [A('ESC-LIM'), A('LAM-H4')] },
  { w: 4, items: (p) => [A('LIQ-FRE-D4', 2), A(p.refri)] },
  { w: 3, items: () => [A('ACE-ATF-L', 3.5)] },
  { w: 3, items: (p) => [A(p.fAire), A(p.fHab), A('FUS-KIT')] },
  { w: 2, items: (p) => [A(p.pastDel), A('LIQ-FRE-D4')] },
  { w: 2, items: () => [A('GRA-MP-400'), A('LIM-INY-500'), A('TRA-IND', 2)] },
  { w: 2, items: (p) => [A(p.correa), A('TEN-AUT')] },
];

const MEDIOS_CONTADO = [['efectivo', 44], ['transferencia', 22], ['debito', 16], ['credito', 12], ['otro', 3], ['cheque', 3]];
const CUENTA_DE = { transferencia: ['galicia', 'galicia', 'galicia', 'mp'], debito: ['galicia', 'galicia', 'mp'], credito: ['mp'], otro: ['mp'] };
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const r3 = (n) => Math.round(n * 1000) / 1000;
const PEDIDO_SEMANAL = false; // los pedidos salen sólo cuando hay faltantes (reposición por stock mínimo)
const ESPERA_ENTRE_COMPRAS = 20; // jornadas mínimas entre compras a un mismo proveedor

export function planificar({ semilla = 20261021, hoy, corridos = 90 }) {
  const R = rng(semilla);
  const fechas = jornadas(hoy, corridos);
  const N = fechas.length;
  const last = N - 1;
  /** Escala un día de referencia (jornada de 77 laborables) a la longitud real del plan. */
  const D = (k) => Math.max(0, Math.min(last - 1, Math.round((k * last) / 77)));
  const f = (i) => fechas[Math.max(0, Math.min(last, i))];
  const clientes = construirClientes(semilla);
  const vehs = clientes.flatMap((c) => c.vehiculos.map((v) => ({ ...v, cliente: c })));
  const empresaVehs = vehs.filter((v) => v.cliente.empresa);
  const particularVehs = vehs.filter((v) => !v.cliente.empresa);
  const art = new Map(ARTICULOS.map((a) => [a.codigo, a]));
  const cliente = (k) => clientes.find((c) => c.key === k);

  const acciones = [];
  const porDia = Array.from({ length: N }, () => []);
  const add = (dia, ord, tipo, d = {}) => {
    const dd = Math.max(0, Math.min(last, dia));
    const a = { dia: dd, ord, tipo, ...d, seq: acciones.length };
    acciones.push(a);
    porDia[dd].push(a);
    return a;
  };
  const cnt = {};
  const nextKey = (p) => `${p}-${String((cnt[p] = (cnt[p] ?? 0) + 1)).padStart(2, '0')}`;
  const medioPago = (excluirCheque = false) => {
    const m = R.pesos(excluirCheque ? MEDIOS_CONTADO.filter((x) => x[0] !== 'cheque') : MEDIOS_CONTADO);
    return { medio: m, cuenta: CUENTA_DE[m] ? R.pick(CUENTA_DE[m]) : null };
  };
  const refMedio = (m) => (m === 'transferencia' ? `Transf. ${R.int(100000, 999999)}` : m === 'debito' ? `Déb. ${R.int(1000, 9999)}` : m === 'credito' ? `Créd. ${R.int(1000, 9999)} 3 cuotas` : m === 'otro' ? 'QR Mercado Pago' : null);
  let nCheque = 0;
  const chequeDe = (c, antes = R.int(2, 12), echeq = false) => {
    nCheque++;
    const nro = String(48000 + nCheque * 37 + R.int(1, 30)).padStart(8, '0');
    return {
      nro,
      datos: { banco: R.pick(BANCOS_CHEQUE), librador: c.nombre, cuit: c.cuit, modalidad: echeq ? 'echeq' : 'fisico', ...(echeq ? { echeq_id: `ECHEQ-2026-${R.int(100000, 999999)}` } : {}), emision_antes: antes },
    };
  };

  // ═════════════ Órdenes de trabajo (45) ═════════════
  const destinos = [
    ...Array(25).fill('entregada_contado'), ...Array(8).fill('entregada_cc'), ...Array(2).fill('cancelada'),
    'lista_a', 'lista_b', 'lista_comp_a', 'lista_comp_b', 'en_reparacion', 'en_reparacion', 'esperando_repuestos', 'diagnostico', 'recibida', 'recibida',
  ];
  const ccTipos = ['abierta_vieja', 'abierta_media', 'abierta_reciente', 'pagada_luego', 'pagada_luego', 'pagada_luego', 'parcial', 'parcial'];
  const ccIngreso = [D(4), D(34), last - 8, D(13), D(23), D(33), D(28), D(46)];
  const diasContado = Array.from({ length: 25 }, (_, k) => Math.min(last - 7, Math.floor(((k + R.next() * 0.9) * (last - 6)) / 25))).sort((a, b) => a - b);
  const actuales = { lista_a: last - 4, lista_b: last - 3, lista_comp_a: last - 5, lista_comp_b: last - 4, en_reparacion: last - 2, esperando_repuestos: last - 4, diagnostico: last - 1, recibida: last };
  const specs = [];
  let kContado = 0, kCc = 0, kCan = 0;
  for (const destino of destinos) {
    const s = { destino };
    if (destino === 'entregada_contado') s.i0 = diasContado[kContado++];
    else if (destino === 'entregada_cc') { s.cc = ccTipos[kCc]; s.i0 = Math.min(ccIngreso[kCc], last - 3); kCc++; }
    else if (destino === 'cancelada') s.i0 = [D(11), D(39)][kCan++];
    else s.i0 = Math.max(0, actuales[destino]);
    specs.push(s);
  }
  // Las OT a cuenta corriente son de flotas/empresas; el resto recorre los vehículos de particulares.
  const cicloPart = R.shuffle(particularVehs);
  let kPart = 0, kEmp = 0;
  const empOrden = [empresaVehs[0], empresaVehs[1], empresaVehs[0], empresaVehs[2], empresaVehs[3], empresaVehs[4], empresaVehs[1], empresaVehs[3]];
  for (const s of specs) {
    s.veh = s.cc ? empOrden[kEmp++] : cicloPart[kPart++ % cicloPart.length];
    s.job = R.pesos(JOB_KEYS);
    if (s.destino === 'esperando_repuestos') { s.job = 'distribucion'; s.veh = vehs.find((v) => v.perfil === 'C' && !v.cliente.empresa); }
  }
  // Origen: 17 con presupuesto (los trabajos más grandes); 12 de las OT llegan con turno previo.
  const conPres = [...specs.keys()]
    .filter((i) => !['lista_a', 'recibida', 'diagnostico'].includes(specs[i].destino))
    .map((i) => [i, JOBS[specs[i].job].presupuesta + R.next() * 0.5]).sort((a, b) => b[1] - a[1]).slice(0, 17).map((x) => x[0]);
  const resto = [...specs.keys()].filter((i) => !conPres.includes(i) && specs[i].destino !== 'recibida');
  const conTurno = new Set([...R.shuffle(conPres).slice(0, 7), ...R.shuffle(resto).slice(0, 5)]);
  specs.forEach((s, i) => {
    s.pres = conPres.includes(i);
    s.turno = conTurno.has(i);
    s.sinItems = !s.pres && s.destino !== 'esperando_repuestos' && R.chance(0.2);
    s.key = `OT-${String(i + 1).padStart(2, '0')}`; // etiqueta interna: el número real lo asigna la API
  });
  let nPres = 0;
  for (const s of specs) {
    const job = JOBS[s.job];
    const items = job.items(PERFILES[s.veh.perfil]);
    const mec = R.pick(job.mec);
    const { key, i0 } = s;
    const lista = s.cc && R.chance(0.7) ? 'mayorista' : null;
    const falla = R.pick(job.falla);
    const prometida = f(Math.min(last, i0 + R.int(1, 3)));
    s.items = items;
    let turnoKey = null;
    if (s.pres) {
      const presKey = `PRE-${String(++nPres).padStart(2, '0')}`;
      s.presKey = presKey;
      const dp = Math.max(0, i0 - R.int(1, 3));
      add(dp, O.PRES, 'pres', { key: presKey, cliente: s.veh.cliente.key, veh: s.veh.key, items, lista, obs: `Incluye mano de obra y repuestos. ${R.pick(['Garantía de 3 meses.', 'Se entrega el repuesto reemplazado.', 'Sujeto a revisión al desarmar.'])}` });
      if (R.chance(0.7)) add(Math.min(i0, dp + (R.chance(0.5) ? 1 : 0)), O.PRES + 1, 'pres_estado', { key: presKey, estado: 'aprobado' });
      if (s.turno) {
        turnoKey = nextKey('TUR');
        add(dp, O.TURNO, 'turno', { key: turnoKey, fecha: f(i0), hora: R.pick(['08:00', '08:30', '09:00', '10:00', '11:00', '14:00', '15:30']), dur: 120, cliente: s.veh.cliente.key, veh: s.veh.key, mec, motivo: falla, presKey });
      }
      add(i0, O.OT, 'pres_ot', { presKey, key, mec, prometida, veh: s.veh.key });
    } else {
      if (s.turno) {
        turnoKey = nextKey('TUR');
        add(Math.max(0, i0 - R.int(1, 4)), O.TURNO, 'turno', { key: turnoKey, fecha: f(i0), hora: R.pick(['08:00', '09:00', '10:30', '13:00', '14:00', '16:00']), dur: 90, cliente: s.veh.cliente.key, veh: s.veh.key, mec, motivo: falla });
      }
      add(i0, O.OT, 'ot', { key, cliente: s.veh.cliente.key, veh: s.veh.key, mec, falla, items: s.sinItems ? [] : items, lista, prometida, turnoKey });
    }
    add(i0, O.CHECK, 'ot_check', { key, variante: R.int(0, 2) });
  }

  // Progreso de cada OT hasta su destino
  for (const s of specs) {
    const { key, i0, items } = s;
    const noteRep = R.pick(['Se inicia el trabajo', 'Se asigna al mecánico', 'Repuestos en taller']);
    const diag = () => { if (s.sinItems) add(i0, O.REP, 'ot_estado', { key, estado: 'diagnostico', nota: 'Se revisa el vehículo en elevador' }); };
    const cargarItems = (dia) => { if (s.sinItems) add(dia, O.REP + 1, 'ot_items', { key, items }); };
    switch (s.destino) {
      case 'entregada_contado':
      case 'entregada_cc': {
        const dl = R.pesos([[0, 4], [1, 5], [2, 3], [3, 1]]);
        const iL = Math.min(last - 2, i0 + dl);
        diag();
        cargarItems(Math.min(iL, i0 + (dl > 0 ? 1 : 0)));
        if (R.chance(0.15)) add(i0, O.REP, 'ot_estado', { key, estado: 'esperando_repuestos', nota: 'Falta un repuesto, se pide al proveedor' });
        add(Math.min(iL, i0 + (dl > 1 ? 1 : 0)), O.REP + 2, 'ot_estado', { key, estado: 'en_reparacion', nota: noteRep });
        add(iL, O.LISTA, 'ot_estado', { key, estado: 'lista', nota: 'Trabajo terminado y probado' });
        const iE = Math.min(last - 1, iL + (R.chance(0.35) ? 1 : 0));
        if (s.destino === 'entregada_contado') {
          const pm = medioPago(true);
          add(iL, O.COMP, 'ot_comp', { key, cond: 'contado', cobro: { medio: pm.medio, cuenta: pm.cuenta, referencia: refMedio(pm.medio) } });
        } else {
          add(iL, O.COMP, 'ot_comp', { key, cond: 'cuenta_corriente' });
          const cobros = {
            abierta_vieja: [], abierta_media: [], abierta_reciente: [],
            pagada_luego: [[R.int(3, 6), 0.5], [R.int(11, 20), 'saldo']],
            parcial: [[R.int(4, 8), R.pick([0.4, 0.5, 0.6])]],
          }[s.cc];
          cobros.forEach(([lapso, parte], k) => {
            const m = medioPago(true);
            const ch = k === 0 && s.cc === 'pagada_luego' && R.chance(0.4) ? chequeDe(s.veh.cliente) : null;
            add(Math.min(last - 1, iL + lapso), O.COBRO, 'cobro', {
              key: nextKey('COB'), ref: key, parte, medio: ch ? 'cheque' : m.medio, cuenta: ch ? null : m.cuenta, referencia: ch ? ch.nro : refMedio(m.medio),
              cheque: ch?.datos, chq: ch ? `CH-${ch.nro}` : null, notas: parte === 'saldo' ? 'Cancela el saldo del comprobante' : 'Pago parcial a cuenta',
            });
          });
        }
        add(iE, O.ENTR, 'ot_estado', { key, estado: 'entregada', nota: R.pick(['Retiró el titular', 'Retiró el cliente, se le explicó el trabajo', 'Entregado con las piezas reemplazadas']) });
        break;
      }
      case 'cancelada':
        add(i0, O.REP, 'ot_estado', { key, estado: 'diagnostico', nota: 'Se revisa el vehículo' });
        add(Math.min(last - 3, i0 + 1), O.REP + 2, 'ot_estado', { key, estado: 'cancelada', nota: 'El cliente decidió no hacer la reparación' });
        break;
      case 'lista_a': case 'lista_b': case 'lista_comp_a': case 'lista_comp_b': {
        diag(); cargarItems(i0);
        add(i0, O.REP + 2, 'ot_estado', { key, estado: 'en_reparacion', nota: noteRep });
        const iL = Math.min(last, i0 + 2);
        add(iL, O.LISTA, 'ot_estado', { key, estado: 'lista', nota: 'Trabajo terminado, avisar al cliente' });
        if (s.destino.startsWith('lista_comp')) {
          add(iL, O.COMP, 'ot_comp', { key, cond: 'cuenta_corriente' });
          if (s.destino === 'lista_comp_a') add(Math.min(last, iL + 1), O.COBRO, 'cobro', { key: nextKey('COB'), ref: key, parte: 0.5, medio: 'transferencia', cuenta: 'galicia', referencia: `Transf. ${R.int(100000, 999999)}`, notas: 'Seña por los repuestos' });
        }
        break;
      }
      case 'en_reparacion':
        diag(); cargarItems(i0);
        add(Math.min(last, i0 + (i0 < last ? 1 : 0)), O.REP + 2, 'ot_estado', { key, estado: 'en_reparacion', nota: 'Trabajo en curso' });
        break;
      case 'esperando_repuestos':
        add(i0, O.REP, 'ot_estado', { key, estado: 'esperando_repuestos', nota: 'Esperando el kit de distribución (pedido al proveedor)' });
        break;
      case 'diagnostico':
        add(i0, O.REP, 'ot_estado', { key, estado: 'diagnostico', nota: 'En revisión con escáner' });
        break;
      default: break; // recibida: no avanza
    }
  }
  // Tres OT de contado se pagan con cheque (una con eCheq).
  const contadoCob = acciones.filter((a) => a.tipo === 'ot_comp' && a.cond === 'contado').sort((a, b) => a.dia - b.dia);
  [3, 9, 16].forEach((idx, k) => {
    const a = contadoCob[idx];
    if (!a) return;
    const spec = specs.find((s) => s.key === a.key);
    const ch = chequeDe(spec.veh.cliente, R.int(2, 10), k === 1);
    a.cobro = { medio: 'cheque', cuenta: null, referencia: ch.nro, cheque: ch.datos };
    a.chq = `CH-${ch.nro}`;
  });

  // ═════════════ Presupuestos sin OT (8) y turnos (hasta 30) ═════════════
  const presSueltos = [
    { estado: 'aprobado', dia: last - 6, turnoEn: 2 }, { estado: 'aprobado', dia: last - 3, turnoEn: 1 }, { estado: 'aprobado', dia: last - 1 },
    { estado: 'pendiente', dia: last - 28 }, { estado: 'pendiente', dia: last - 4 }, { estado: 'pendiente', dia: last - 1 },
    { estado: 'rechazado', dia: D(17) }, { estado: 'rechazado', dia: D(52) },
  ];
  for (const p of presSueltos) {
    const v = R.pick(particularVehs);
    const jk = R.pick(['distribucion', 'frenos_disc', 'amort', 'bateria', 'tren_del', 'amort_tras']);
    const key = `PRE-${String(++nPres).padStart(2, '0')}`;
    add(p.dia, O.PRES, 'pres', { key, cliente: v.cliente.key, veh: v.key, items: JOBS[jk].items(PERFILES[v.perfil]), lista: null, obs: R.pick(['Presupuesto solicitado por teléfono.', 'Se recomienda realizar el trabajo antes del invierno.', 'El cliente consultará con su seguro.']) });
    if (p.estado !== 'pendiente') add(Math.min(last, p.dia + (p.estado === 'rechazado' ? 2 : 0)), O.PRES + 1, 'pres_estado', { key, estado: p.estado });
    if (p.turnoEn) add(last, O.TURNO, 'turno', { key: nextKey('TUR'), fecha: sumarDias(hoy, p.turnoEn), hora: p.turnoEn === 2 ? '09:00' : '14:30', dur: 180, cliente: v.cliente.key, veh: v.key, mec: JOBS[jk].mec[0], motivo: 'Trabajo presupuestado y aprobado', presKey: key });
  }
  const turnosHechos = acciones.filter((a) => a.tipo === 'turno').length;
  const pasados = [['cancelado', D(14)], ['cancelado', D(33)], ['cancelado', D(58)], ['ausente', D(21)], ['ausente', D(44)], ['ausente', last - 3], ['completado', D(8)], ['completado', D(26)], ['completado', last - 1], ['completado', last - 2]];
  for (const [estado, dia] of pasados) {
    const v = R.pick(particularVehs);
    const key = nextKey('TUR');
    add(Math.max(0, dia - R.int(1, 3)), O.TURNO, 'turno', { key, fecha: f(dia), hora: R.pick(['09:30', '10:00', '11:30', '15:00', '16:30']), dur: 60, cliente: v.cliente.key, veh: v.key, mec: R.pick(['M3', 'M4']), motivo: R.pick(['Consulta por ruido en el motor', 'Revisión de luces', 'Control de niveles y presión', 'Presupuesto de frenos']) });
    if (estado === 'completado') { add(dia, O.TURNO + 1, 'turno_estado', { key, estado: 'confirmado' }); add(dia, O.TURNO + 2, 'turno_estado', { key, estado: 'completado' }); }
    else add(dia, O.TURNO + 1, 'turno_estado', { key, estado });
  }
  const futuros = [[0, '16:00', 'M3'], [1, '08:30', 'M4'], [1, '10:00', 'M2'], [1, '15:00', 'M3'], [3, '11:00', 'M4'], [5, '09:00', 'M2'], [7, '10:30', 'M1']];
  const faltan = Math.max(0, 30 - (turnosHechos + pasados.length));
  futuros.slice(0, faltan).forEach(([k, hora, mec], i) => {
    const v = R.pick(particularVehs);
    const key = nextKey('TUR');
    add(Math.max(0, last - R.int(0, 2)), O.TURNO, 'turno', { key, fecha: sumarDias(hoy, k), hora, dur: 60, cliente: v.cliente.key, veh: v.key, mec, motivo: R.pick(['Service programado', 'Cambio de pastillas', 'Revisión pre-VTV', 'Diagnóstico por ruido', 'Alineación y balanceo', 'Carga de gas A/A']) });
    if (i % 3 === 0) add(last, O.TURNO + 1, 'turno_estado', { key, estado: 'confirmado' });
  });

  // ═════════════ Ventas de mostrador (35) ═════════════
  const diasVenta = Array.from({ length: 35 }, (_, k) => Math.min(last, Math.floor(((k + R.next() * 0.9) * (last + 1)) / 35))).sort((a, b) => a - b);
  const ccVenta = new Map([[6, 'sin_pago'], [12, 'pago'], [18, 'parcial'], [24, 'pago'], [29, 'anular'], [32, 'sin_pago']]);
  diasVenta.forEach((dia, n) => {
    const key = `VTA-${String(n + 1).padStart(2, '0')}`;
    const v = R.pick(particularVehs);
    const t = R.pesos(MOSTRADOR.map((m, i) => [i, m.w]));
    const items = MOSTRADOR[t].items(PERFILES[v.perfil]);
    const base = { key, items, user: R.chance(0.6) ? 'e' : 'o', lista: null };
    if (ccVenta.has(n)) {
      const cli = R.pick(clientes.filter((c) => c.empresa));
      add(dia, O.VENTA, 'venta', { ...base, cliente: cli.key, cond: 'cuenta_corriente', lista: 'mayorista' });
      const modo = ccVenta.get(n);
      if (modo === 'pago' || modo === 'parcial') {
        const pm = medioPago(true);
        add(Math.min(last - 1, dia + R.int(5, 15)), O.COBRO, 'cobro', { key: nextKey('COB'), ref: key, parte: modo === 'pago' ? 'saldo' : 0.5, medio: pm.medio, cuenta: pm.cuenta, referencia: refMedio(pm.medio), notas: modo === 'pago' ? 'Cancela el saldo' : 'Pago parcial' });
      }
      if (modo === 'anular') add(dia, O.VENTA + 1, 'venta_anular', { key, motivo: 'El cliente desistió de la compra' });
    } else {
      const pm = medioPago();
      const ch = pm.medio === 'cheque' ? chequeDe(R.pick(clientes.filter((c) => !c.empresa)), 3) : null;
      const conTarjeta = pm.medio === 'credito' && R.chance(0.6);
      add(dia, O.VENTA, 'venta', { ...base, cliente: null, cond: 'contado', lista: conTarjeta ? 'tarjeta' : null, cobro: { medio: pm.medio, cuenta: pm.cuenta, referencia: ch ? ch.nro : refMedio(pm.medio), cheque: ch?.datos }, chq: ch ? `CH-${ch.nro}` : null });
    }
  });

  // ═════════════ Cheques recibidos: recorrido ═════════════
  const conCheque = acciones.filter((a) => a.chq).sort((a, b) => a.dia - b.dia);
  conCheque.forEach((a, k) => {
    if (k === 0) return; // el primero queda en cartera y se vence sin depositar
    if (k === conCheque.length - 1 && a.dia > last - 12) return; // el último sigue en cartera
    const dd = Math.min(last - 1, a.dia + R.int(2, 5));
    add(dd, O.BANCO, 'cheque_dep', { chq: a.chq, cuenta: 'galicia' });
    if (k === 2) {
      add(Math.min(last - 1, dd + 3), O.BANCO + 1, 'cheque_rech', { chq: a.chq, motivo: 'Cheque rechazado por falta de fondos', comision: pesos(4500) });
      const ref = a.tipo === 'cobro' ? a.ref : a.key;
      add(Math.min(last - 1, dd + 3), O.BANCO + 2, 'cobro_anular', { ref, motivo: 'Cheque rechazado por el banco' });
      add(Math.min(last - 1, dd + 6), O.COBRO, 'cobro', { key: nextKey('COB'), ref, parte: 'saldo', medio: 'efectivo', notas: 'El cliente reemplazó el cheque rechazado por efectivo' });
    } else add(Math.min(last - 1, dd + 2), O.BANCO + 1, 'cheque_acr', { chq: a.chq, cuenta: 'galicia' });
  });
  // Cheques cargados a mano: uno para endosar a un proveedor y dos a futuro (próximos a vencer)
  const cLago = cliente('C27'), cDelValle = cliente('C29'), cRibera = cliente('C28');
  const chEndoso = chequeDe(cLago, 6);
  add(D(18), O.BANCO, 'cheque_manual', { chq: `CH-${chEndoso.nro}`, nro: chEndoso.nro, cliente: cLago.key, importe: pesos(200000), datos: chEndoso.datos, pagoEn: 0 });
  const chFut = chequeDe(cDelValle, 1, true);
  add(last - 2, O.BANCO, 'cheque_manual', { chq: `CH-${chFut.nro}`, nro: chFut.nro, cliente: cDelValle.key, importe: pesos(310000), datos: chFut.datos, pagoEn: 6 });
  const chFut2 = chequeDe(cRibera, 1);
  add(last - 1, O.BANCO, 'cheque_manual', { chq: `CH-${chFut2.nro}`, nro: chFut2.nro, cliente: cRibera.key, importe: pesos(145000), datos: chFut2.datos, pagoEn: 2 });

  // ═════════════ Compras, órdenes de compra, facturas y pagos a proveedores ═════════════
  const costoEn = (c, dia) => redondear(Math.round(art.get(c).costo * (1 + 0.075 * (dia / Math.max(1, last)))), 100);
  const compras = [];
  const nroDoc = (p, n) => `${String(PROVEEDORES.findIndex((x) => x.key === p) + 1).padStart(4, '0')}-${String(R.int(1000, 99999) + n * 7).padStart(8, '0')}`;
  const nuevaCompra = (dia, prov, lineas, opc = {}) => {
    const key = nextKey('CMP');
    const items = lineas.map(([c, q]) => ({ c, q, costo: costoEn(c, dia) }));
    const neto = items.reduce((s, i) => s + Math.round(i.q * i.costo), 0);
    const mono = PROVEEDORES.find((p) => p.key === prov).cond === 'monotributo';
    const iva = mono ? 0 : Math.round(neto * 0.21);
    const total = neto + iva;
    const r = R.next();
    let pago = null;
    if (!opc.cc && r < 0.2 && total <= pesos(150000)) pago = { medio: 'efectivo' };
    else if (!opc.cc && r < 0.38) pago = { medio: 'transferencia', cuenta: 'galicia', referencia: `Transf. ${R.int(100000, 999999)}` };
    const doc = nroDoc(prov, compras.length);
    const venc = pago ? null : sumarDias(f(dia), R.pick([15, 30, 30, 45]));
    const c = add(dia, opc.ord ?? O.COMPRA, 'compra', { key, prov, items, iva, neto, total, pago, doc, venc, nota: opc.nota ?? null });
    compras.push(c);
    if (!pago && (opc.factura ?? R.chance(0.7))) {
      add(dia, (opc.ord ?? O.COMPRA) + 1, 'factura', { key: nextKey('FAC'), compraKey: key, prov, tipoF: mono ? 'factura_c' : 'factura_a', nro: doc, neto, iva, total, condicion: 'plazo', dias: Math.max(1, diasEntre(f(dia), venc)) });
    }
    // Pago a crédito: la mayoría se cancela (completa o en dos veces) entre 10 y 40 días después.
    if (!pago && !opc.impaga && !opc.sinPago && R.chance(0.85)) {
      const lapso = Math.round(R.int(10, 40) / 1.17);
      const dp = dia + lapso;
      if (dp <= last - 1 && !(dp > last - 15 && R.chance(0.7))) { // los vencimientos más recientes todavía no se pagaron
        const m = R.pesos([['transferencia', 55], ['efectivo', 15], ['cheque_propio', 20], ['debito', 10]]);
        const base = { prov, compraKey: key };
        const instrumento = m === 'cheque_propio'
          ? { medio: 'cheque', referencia: String(30000 + R.int(1, 9000)), chequePropio: { banco: 'Banco Galicia', cuenta: 'galicia', pagoEn: R.int(5, 15) }, aVencer: true }
          : { medio: m, cuenta: m === 'efectivo' ? null : 'galicia', referencia: m === 'efectivo' ? null : refMedio(m === 'debito' ? 'transferencia' : m) };
        if (R.chance(0.35) && dp + 10 <= last - 1) {
          add(dp, O.PAGO, 'pago', { ...base, key: nextKey('PAG'), parte: 0.5, ...instrumento, notas: 'Pago parcial a cuenta' });
          add(dp + 10, O.PAGO, 'pago', { ...base, key: nextKey('PAG'), resto: key, medio: 'transferencia', cuenta: 'galicia', referencia: refMedio('transferencia'), notas: 'Cancela el saldo de la compra' });
        } else add(dp, O.PAGO, 'pago', { ...base, key: nextKey('PAG'), parte: 1, ...instrumento, notas: 'Cancela la compra' });
        if (instrumento.chequePropio && dp + Math.round(instrumento.chequePropio.pagoEn / 1.17) <= last - 1) add(dp + Math.round(instrumento.chequePropio.pagoEn / 1.17) + 1, O.BANCO + 1, 'cheque_acr', { chq: `CH-${instrumento.referencia}`, cuenta: 'galicia' });
      }
    }
    return c;
  };
  // Historias fijas de abastecimiento
  nuevaCompra(D(2), 'P5', [['AMO-DEL-A', 2], ['AMO-DEL-B', 2], ['AMO-TRA-A', 2], ['EXT-DIR', 4]], { cc: true, impaga: true, factura: true, nota: 'Reposición de suspensión' }); // queda vencida sin pagar
  const grande = nuevaCompra(D(10), 'P6', [['KIT-DIS-A', 1], ['KIT-DIS-B', 1], ['KIT-DIS-D', 1], ['KIT-DIS-C', 1], ['COR-PV-B', 2]], { cc: true, factura: true, sinPago: true, nota: 'Kits de distribución para la temporada' });
  add(D(31), O.PAGO, 'pago', { key: nextKey('PAG'), prov: 'P6', importe: pesos(200000), medio: 'cheque', endoso: `CH-${chEndoso.nro}`, compraKey: grande.key, notas: 'Pago con cheque endosado de un cliente' });
  add(D(46), O.PAGO, 'pago', { key: nextKey('PAG'), prov: 'P6', resto: grande.key, medio: 'transferencia', cuenta: 'galicia', referencia: refMedio('transferencia'), notas: 'Cancela el saldo de la compra' });
  nuevaCompra(D(5), 'P8', [['DES-MOT-5', 3], ['TRA-IND', 15], ['FUS-KIT', 4]], { cc: true, impaga: true, factura: false, nota: 'Insumos de taller' });
  // Órdenes de compra (circuito B: orden → recepción → factura)
  const calcOC = (items, dia) => { const neto = items.reduce((s, [c, q]) => s + Math.round(q * costoEn(c, dia)), 0); const iva = Math.round(neto * 0.21); return { neto, iva, total: neto + iva }; };
  const lineasOC = (items, dia) => items.map(([c, q]) => ({ c, q, costo: costoEn(c, dia) }));
  const oc1 = [['BAT-65', 2], ['BAT-45', 2], ['BAT-75', 1], ['BAT-100', 1], ['BOR-BAT', 6]];
  add(D(20), O.COMPRA, 'oc', { key: 'OC-01', prov: 'P7', items: lineasOC(oc1, D(20)), emitir: true, prevista: f(D(24)), obs: 'Pedido semestral de baterías' });
  add(D(24), O.COMPRA, 'oc_recibir', { ocKey: 'OC-01', todo: true, remito: '0003-00071245' });
  const t1 = calcOC(oc1, D(20));
  add(D(24), O.COMPRA + 1, 'factura', { key: nextKey('FAC'), ocKey: 'OC-01', prov: 'P7', tipoF: 'factura_a', nro: '0006-00019876', neto: t1.neto, iva: t1.iva, total: t1.total, condicion: 'plazo', dias: 30, notas: 'Factura de la orden de compra OC-01' });
  const oc2 = [['PAS-DEL-A', 6], ['PAS-DEL-B', 6], ['DIS-DEL-B', 3], ['LIQ-FRE-D4', 16]];
  add(D(40), O.COMPRA, 'oc', { key: 'OC-02', prov: 'P3', items: lineasOC(oc2, D(40)), emitir: true, prevista: f(D(46)), obs: 'Reposición de frenos' });
  add(D(46), O.COMPRA, 'oc_recibir', { ocKey: 'OC-02', items: [['PAS-DEL-A', 6], ['PAS-DEL-B', 6], ['LIQ-FRE-D4', 8]], remito: '0001-00033801' }); // parcial: faltan discos y líquido
  add(D(30), O.COMPRA, 'oc', { key: 'OC-03', prov: 'P2', items: lineasOC([['FIL-AIR-A', 6], ['FIL-HAB-A', 6]], D(30)), emitir: false, prevista: f(D(34)), obs: 'Pedido de prueba' });
  add(D(31), O.COMPRA, 'oc_cancelar', { ocKey: 'OC-03', motivo: 'Se cargó por error: el proveedor ya había enviado la mercadería' });
  add(last - 3, O.COMPRA, 'oc', { key: 'OC-04', prov: 'P6', items: lineasOC([['KIT-DIS-C', 2]], last - 3), emitir: true, prevista: sumarDias(hoy, 1), obs: 'Urgente: kit de distribución para la camioneta en el taller' });
  add(last - 1, O.COMPRA, 'factura', { key: nextKey('FAC'), prov: 'P2', tipoF: 'nota_credito_a', nro: '0004-00005512', neto: pesos(15289), iva: pesos(3211), total: pesos(18500), condicion: 'cuenta_corriente', notas: 'Nota de crédito por filtros con defecto de fábrica' });

  // ═════════════ Gastos, caja, bancos y administración ═════════════
  const caja = { cierres: new Map(), arqueos: new Set([D(9), D(21), D(37), D(50), D(64), last - 4]) };
  [[D(6), -pesos(2500), 'Faltante de $2.500: vuelto entregado de más'], [D(15), pesos(1000), 'Sobrante de $1.000 por redondeo de vueltos'], [D(27), -pesos(5000), 'Faltante de $5.000: se revisan los comprobantes del día'], [D(40), -pesos(1800), 'Faltante de $1.800 por vuelto'], [D(53), pesos(2000), 'Sobrante de $2.000 sin justificar'], [D(68), -pesos(3200), 'Faltante de $3.200: error en el cambio'], [D(76), pesos(800), 'Sobrante de $800']]
    .forEach(([dia, delta, notas]) => caja.cierres.set(dia, { delta, notas }));
  const monto = (base) => pesos(redondear(base * (0.94 + R.next() * 0.12), 100));
  add(0, O.CAJA, 'caja_ingreso', { key: 'ING-01', importe: pesos(150000), concepto: 'Aporte del propietario para fondo de cambio' });
  add(1, O.BANCO, 'extraccion', { cuenta: 'galicia', importe: pesos(400000), concepto: 'Extracción para fondo de cambio y adelantos' });
  add(D(30), O.CAJA, 'caja_ingreso', { key: 'ING-02', importe: pesos(12500), concepto: 'Cobro de venta del sábado que no se había registrado' });
  add(D(62), O.CAJA, 'caja_ingreso', { key: 'ING-03', importe: pesos(8400), concepto: 'Reintegro del proveedor por diferencia de precio' });
  // Depósitos semanales de efectivo
  for (let i = 4; i < last; i += 6) add(i, O.CAJA + 1, 'deposito', { cuenta: 'galicia', dejar: pesos(120000), concepto: 'Depósito de recaudación en efectivo' });
  // Transferencias entre cuentas propias
  [[D(14), 'galicia', 'mp', 150000, 'Fondeo de billetera'], [D(33), 'galicia', 'santander', 250000, 'Reserva de capital de trabajo'], [D(55), 'mp', 'galicia', 180000, 'Retiro de Mercado Pago a cuenta corriente'], [D(75), 'galicia', 'mp', 100000, 'Fondeo de billetera']]
    .forEach(([dia, o, d, imp, concepto]) => add(dia, O.BANCO, 'transferencia', { origen: o, destino: d, importe: pesos(imp), concepto }));
  // Gastos por calendario
  const vistos = new Set();
  const ocurre = (id, mesKey, dm, i) => { const k = `${id}-${mesKey}`; if (vistos.has(k) || Number(fechas[i].slice(8)) < dm || `${mesKey}-${String(dm).padStart(2, '0')}` < fechas[0]) return false; vistos.add(k); return true; };
  fechas.forEach((fecha, i) => {
    const mes = fecha.slice(0, 7);
    const mn = MESES[Number(fecha.slice(5, 7)) - 1];
    const mAnt = MESES[(Number(fecha.slice(5, 7)) + 10) % 12];
    const g = (cat, concepto, base, medio, cuenta = null, extra = {}) => add(i, O.GASTO, 'gasto', { key: nextKey('GAS'), cat, concepto, importe: monto(base), medio, cuenta, ...extra });
    if (ocurre('sueldos', mes, 2, i)) g('Sueldos y jornales', `Sueldos de ${mAnt}: administración y mostrador`, 400_000, 'transferencia', 'galicia', { referencia: `Transf. ${R.int(100000, 999999)}` });
    if (ocurre('alquiler', mes, 5, i)) g('Alquiler', `Alquiler del local · ${mn}`, 340_000, 'transferencia', 'galicia', { referencia: `Transf. ${R.int(100000, 999999)}`, comprobante: `Recibo 0001-${String(R.int(100, 999)).padStart(8, '0')}` });
    if (ocurre('contador', mes, 8, i)) g('Varios', 'Honorarios del contador', 75_000, 'transferencia', 'galicia', { referencia: `Transf. ${R.int(100000, 999999)}` });
    if (ocurre('luz', mes, 10, i)) g('Servicios (luz, agua, internet)', `Servicio de electricidad · ${mn}`, 68_000, 'debito', 'galicia', { referencia: 'Débito automático' });
    if (ocurre('internet', mes, 12, i)) g('Servicios (luz, agua, internet)', `Internet y telefonía · ${mn}`, 29_800, 'credito', 'mp', { referencia: 'Débito en tarjeta' });
    if (ocurre('publicidad', mes, 14, i)) g('Publicidad', 'Publicidad en redes y buscadores', 45_000, 'credito', 'mp', { referencia: 'Débito en tarjeta' });
    if (ocurre('adelanto', mes, 16, i)) g('Sueldos y jornales', 'Adelanto de sueldo (efectivo)', 70_000, 'efectivo');
    if (ocurre('iibb', mes, 18, i)) g('Impuestos y tasas', `Ingresos Brutos · ${mn}`, 94_500, 'transferencia', 'galicia', { referencia: `VEP ${R.int(100000, 999999)}` });
    if (ocurre('tasa', mes, 20, i)) g('Impuestos y tasas', 'Tasa de seguridad e higiene municipal', 38_200, 'transferencia', 'galicia', { referencia: `Transf. ${R.int(100000, 999999)}` });
    if (i % 6 === 1) g('Insumos de taller', R.pick(['Trapos, guantes y desengrasante', 'Insumos de limpieza de piezas', 'Lubricante en aerosol y precintos']), R.int(8, 28) * 1000, 'efectivo');
    if (i % 12 === 5) g('Limpieza', 'Limpieza del taller y baños', 14_000, 'efectivo');
    if (i % 9 === 3) g('Combustible y fletes', 'Flete de repuestos desde el proveedor', R.int(9, 16) * 1000, 'efectivo');
  });
  add(D(30), O.GASTO, 'gasto', { key: nextKey('GAS'), cat: 'Mantenimiento', concepto: 'Service del elevador hidráulico', importe: pesos(85000), medio: 'transferencia', cuenta: 'galicia', referencia: `Transf. ${R.int(100000, 999999)}`, comprobante: 'Factura B 0002-00004510' });
  add(D(48), O.GASTO, 'gasto', { key: nextKey('GAS'), cat: 'Herramientas y equipos', concepto: 'Juego de llaves de impacto y torquímetro', importe: pesos(142000), medio: 'credito', cuenta: 'mp', referencia: 'Débito en tarjeta · 3 cuotas', comprobante: 'Factura B 0001-00019977' });
  add(D(70), O.GASTO, 'gasto', { key: nextKey('GAS'), cat: 'Mantenimiento', concepto: 'Reparación del compresor de aire', importe: pesos(63000), medio: 'debito', cuenta: 'galicia', referencia: 'Débito' });
  // Gastos recurrentes (se cargan el último día para que sus próximas fechas sean actuales)
  add(last, O.GASTO + 1, 'gasto_rec_crear', { key: 'REC-01', cat: 'Alquiler', concepto: 'Alquiler del local', importe: pesos(340000), medio: 'transferencia', frecuencia: 'mensual', dia: 5, proxima: sumarDias(hoy, 12) });
  add(last, O.GASTO + 1, 'gasto_rec_crear', { key: 'REC-02', cat: 'Servicios (luz, agua, internet)', concepto: 'Internet y telefonía', importe: pesos(29800), medio: 'credito', frecuencia: 'mensual', dia: hoy.slice(8) * 1 || 20, proxima: hoy });
  add(last, O.GASTO + 1, 'gasto_rec_crear', { key: 'REC-03', cat: 'Varios', concepto: 'Seguro del local y herramientas', importe: pesos(48500), medio: 'transferencia', frecuencia: 'bimestral', dia: 1, proxima: sumarDias(hoy, -3) });
  add(last, O.GASTO + 2, 'gasto_rec_registrar', { key: 'REC-02', medio: 'debito', cuenta: 'mp' });
  // Movimientos de banco (comisiones, impuestos, intereses) y conciliaciones
  const mesesVistos = new Set();
  fechas.forEach((fecha, i) => {
    const mes = fecha.slice(0, 7);
    const siguiente = fechas[i + 1];
    if (!mesesVistos.has(mes) && Number(fecha.slice(8)) >= 26 && i < last - 1) {
      mesesVistos.add(mes);
      add(i, O.BANCO, 'banco_mov', { cuenta: 'galicia', mov: 'egreso', importe: pesos(8900), concepto: 'Comisión por mantenimiento de cuenta' });
      add(i, O.BANCO, 'banco_mov', { cuenta: 'galicia', mov: 'egreso', importe: monto(23400), concepto: 'Impuesto a los débitos y créditos bancarios' });
      add(i, O.BANCO, 'banco_mov', { cuenta: 'santander', mov: 'ingreso', importe: monto(4100), concepto: 'Intereses ganados caja de ahorro' });
    }
    void siguiente;
  });
  add(D(45), O.BANCO + 3, 'conciliar', { cuenta: 'galicia', dif: 0, notas: 'Conciliación con el extracto del mes' });
  add(D(60), O.BANCO + 3, 'conciliar', { cuenta: 'mp', dif: 0, notas: 'Conciliación de la billetera' });
  add(last - 3, O.BANCO + 3, 'conciliar', { cuenta: 'galicia', dif: -pesos(1250), notas: 'Diferencia por comisión bancaria todavía no registrada' });
  // Actualización de precios (inflación)
  add(D(42), O.STOCK, 'ajuste_precios', { precio: 7, servicios: 6 });
  // Reposición: orden de compra en borrador con lo que está bajo mínimo
  add(last - 1, O.COMPRA, 'oc', { key: 'OC-05', prov: 'P2', items: lineasOC([['FIL-ACE-B', 12], ['FIL-AIR-B', 8], ['FIL-HAB-B', 6]], last - 1), emitir: false, prevista: sumarDias(hoy, 4), obs: 'Borrador: reposición de filtros para la próxima semana' });

  // ═════════════ Simulación cronológica: stock sombra, kilómetros y reposición ═════════════
  const stock = new Map(ARTICULOS.map((a) => [a.codigo, a.stock0]));
  const sumStock = (c, q) => stock.set(c, r3((stock.get(c) ?? 0) + q));
  const kmVeh = new Map(vehs.map((v) => [v.key, v.km]));
  const presItems = new Map(acciones.filter((a) => a.tipo === 'pres').map((a) => [a.key, a]));
  const otItems = new Map();
  for (const a of acciones) {
    if (a.tipo === 'ot') otItems.set(a.key, specs.find((s) => s.key === a.key).items);
    if (a.tipo === 'pres_ot') otItems.set(a.key, presItems.get(a.presKey).items);
  }
  const otVeh = new Map();
  for (const a of acciones) if (a.tipo === 'ot' || a.tipo === 'pres_ot') otVeh.set(a.key, a.veh);
  const ultimaCompraProv = new Map();
  const ultimoServicioKm = new Map();
  const pendienteDeCompra = new Set(); // artículos con compra ya programada para los próximos días
  const programados = [
    [D(20), () => ({ tipo: 'stock_ajuste', c: 'ACE-5W30-4', mov: 'salida', q: 1, delta: -1, motivo: 'rotura', notas: 'Se cayó una lata y se perdió el contenido' })],
    [D(36), () => ({ tipo: 'stock_ajuste', c: 'TRA-IND', mov: 'salida', q: 3, delta: -3, motivo: 'uso_interno', notas: 'Consumo del taller' })],
    [D(52), () => ({ tipo: 'stock_ajuste', c: 'ACE-ATF-L', mov: 'salida', q: 0.8, delta: -0.8, motivo: 'merma', notas: 'Derrame al trasvasar' })],
    [D(66), () => ({ tipo: 'stock_ajuste', c: 'LIQ-FRE-D4', mov: 'salida', q: 2, delta: -2, motivo: 'vencimiento', notas: 'Envases con fecha de vencimiento cumplida' })],
    [D(58), () => ({ tipo: 'stock_ajuste', c: 'BUJ-A', mov: 'entrada', q: 8, delta: 8, motivo: null, notas: 'Ingreso sin factura: compra en mostrador a un colega' })],
    [D(56), () => {
      const items = ARTICULOS.filter((a) => a.categoria === 'Frenos');
      const dif = { 'DIS-DEL-A': -1, 'PAS-TRA-A': 1, 'LIQ-FRE-D4': -2 };
      const contados = Object.fromEntries(items.map((a) => [a.codigo, Math.max(0, r3((stock.get(a.codigo) ?? 0) + (dif[a.codigo] ?? 0)))]));
      return { tipo: 'conteo', cat: 'Frenos', desc: 'Conteo físico de frenos', contados, aplicar: true };
    }],
    [last - 1, () => {
      const items = ARTICULOS.filter((a) => a.categoria === 'Filtros').slice(0, 6);
      return { tipo: 'conteo', cat: 'Filtros', desc: 'Conteo de filtros en curso', contados: Object.fromEntries(items.map((a) => [a.codigo, stock.get(a.codigo) ?? 0])), aplicar: false };
    }],
  ];
  const aplicarCompra = (a) => {
    if (a.tipo === 'compra') for (const it of a.items) sumStock(it.c, it.q);
    if (a.tipo === 'oc_recibir') {
      const oc = acciones.find((x) => x.tipo === 'oc' && x.key === a.ocKey);
      for (const [c, q] of a.todo ? oc.items.map((x) => [x.c, x.q]) : a.items) sumStock(c, q);
    }
  };
  const consumo = (a) => {
    if (a.tipo === 'ot_estado' && a.estado === 'lista') return (otItems.get(a.key) ?? []).filter((i) => i.t === 'a');
    if (a.tipo === 'venta') return a.items.filter((i) => i.t === 'a');
    return [];
  };
  const pedidoPendiente = (c, i) =>
    acciones.some((a) => a.tipo === 'oc' && a.emitir && a.dia <= i + 3 && a.items.some((x) => x.c === c) && !acciones.some((r) => r.tipo === 'oc_cancelar' && r.ocKey === a.key) && !acciones.some((r) => r.tipo === 'oc_recibir' && r.ocKey === a.key && r.dia < i));
  for (let i = 0; i <= last; i++) {
    const orden = porDia[i].slice().sort((a, b) => a.ord - b.ord || a.seq - b.seq);
    for (const a of orden) {
      if (a.tipo === 'ot' || a.tipo === 'pres_ot' || a.tipo === 'pres') {
        const vk = a.veh;
        const km = kmVeh.get(vk) + (a.tipo === 'pres' ? 0 : R.int(300, 3200));
        kmVeh.set(vk, km);
        a.km = km;
      }
      if (a.tipo === 'ot_estado' && a.estado === 'lista' && (otItems.get(a.key) ?? []).some((x) => x.t === 's' && x.n.startsWith('Service'))) ultimoServicioKm.set(otVeh.get(a.key), { km: kmVeh.get(otVeh.get(a.key)), dia: i });
      const sale = consumo(a);
      const faltan = [];
      for (const it of sale) if ((stock.get(it.c) ?? 0) - it.q < -0.0005) faltan.push([it.c, it.q - (stock.get(it.c) ?? 0)]);
      if (faltan.length) { // el taller compra a primera hora lo que falta: el stock nunca queda negativo
        const porProv = new Map();
        for (const [c, falta] of faltan) {
          const x = art.get(c);
          porProv.set(x.prov, [...(porProv.get(x.prov) ?? []), [c, Math.max(x.min * 2, Math.ceil(falta * 2))]]);
        }
        for (const [prov, lineas] of porProv) {
          const nueva = nuevaCompra(i, prov, lineas, { ord: O.URGENTE, nota: 'Compra urgente por faltante de stock', cc: R.chance(0.5) });
          aplicarCompra(nueva);
          ultimaCompraProv.set(prov, i);
        }
      }
      for (const it of sale) sumStock(it.c, -it.q);
      if (a.tipo === 'venta_anular') for (const it of acciones.find((x) => x.tipo === 'venta' && x.key === a.key).items.filter((x) => x.t === 'a')) sumStock(it.c, it.q);
      if (a.tipo === 'compra' && a.ord !== O.URGENTE) aplicarCompra(a);
      if (a.tipo === 'oc_recibir') aplicarCompra(a);
    }
    // Inventario programado: se calcula con el stock real del final de la jornada
    for (const [dia, build] of programados) {
      if (dia !== i) continue;
      const a = build();
      add(i, O.STOCK, a.tipo, a);
      if (a.tipo === 'stock_ajuste') sumStock(a.c, a.delta);
      if (a.tipo === 'conteo' && a.aplicar) for (const [c, q] of Object.entries(a.contados)) stock.set(c, q);
    }
    // Pedido semanal a un proveedor (rotativo): completa lo que está por debajo de ~70 % del stock ideal
    if (PEDIDO_SEMANAL && i % 7 === 3 && i < last - 9) {
      const prov = PROVEEDORES[Math.floor(i / 7) % PROVEEDORES.length].key;
      const propios = ARTICULOS.filter((x) => x.prov === prov);
      const paso = (x, q) => (['lt', 'kg'].includes(x.unidad) ? Math.max(5, Math.ceil(q / 5) * 5) : Math.max(1, Math.ceil(q)));
      let lineas = propios.filter((x) => (stock.get(x.codigo) ?? 0) <= x.objetivo * 0.7 && !pedidoPendiente(x.codigo, i)).slice(0, 6).map((x) => [x.codigo, paso(x, x.objetivo - (stock.get(x.codigo) ?? 0))]);
      if (lineas.length < 2) lineas = R.shuffle(propios.filter((x) => !pedidoPendiente(x.codigo, i))).slice(0, 2).map((x) => [x.codigo, paso(x, x.objetivo * 0.3)]);
      if (lineas.length) {
        nuevaCompra(i + 1, prov, lineas, { ord: O.REPO, nota: 'Pedido semanal al proveedor' });
        ultimaCompraProv.set(prov, i);
      }
    }
    // Reposición de rutina para el día siguiente: artículos en o bajo el mínimo agrupados por proveedor
    if (i < last - 5) {
      const porProv = new Map();
      for (const x of ARTICULOS) {
        if ((stock.get(x.codigo) ?? 0) > x.min || pedidoPendiente(x.codigo, i)) continue;
        const q = Math.max(1, Math.ceil(x.objetivo - (stock.get(x.codigo) ?? 0)));
        porProv.set(x.prov, [...(porProv.get(x.prov) ?? []), [x.codigo, ['lt', 'kg'].includes(x.unidad) ? Math.ceil(q / 5) * 5 : q]]);
      }
      for (const [prov, lineas] of porProv) {
        if (ultimaCompraProv.has(prov) && i - ultimaCompraProv.get(prov) < ESPERA_ENTRE_COMPRAS) continue;
        nuevaCompra(i + 1, prov, lineas, { ord: O.REPO, nota: 'Reposición por stock mínimo' });
        ultimaCompraProv.set(prov, i);
      }
    }
  }
  void pendienteDeCompra;
  // Actualización de kilometraje en mostrador: algunos vehículos ya pasaron su próximo service (alimenta los recordatorios)
  const usoPosterior = new Set(acciones.filter((a) => (a.tipo === 'ot' || a.tipo === 'pres_ot') && a.dia >= last - 3).map((a) => a.veh));
  let nKm = 0;
  for (const [vk, info] of ultimoServicioKm) {
    if (nKm >= 8 || usoPosterior.has(vk) || info.dia > last - 12) continue;
    const aporte = nKm < 5 ? 10500 : 9400; // los primeros ya pasaron su próximo service; los otros están por llegar
    add(last - 2, O.PRES, 'veh_km', { veh: vk, km: kmVeh.get(vk) + aporte });
    kmVeh.set(vk, kmVeh.get(vk) + aporte);
    nKm++;
  }
  // Arqueos parciales de caja y altas de los vehículos que ninguna operación menciona (completa la flota de 35)
  for (const d of caja.arqueos) add(d, O.CAJA + 2, 'arqueo', { delta: R.pick([0, 0, -pesos(300), pesos(200)]) });
  const mencionados = new Set(acciones.filter((a) => a.veh).map((a) => a.veh));
  vehs.filter((v) => !mencionados.has(v.key)).forEach((v, k) => add(D(6 + k * 9), O.PRES - 1, 'alta_cliente', { veh: v.key }));
  // Ordena todo el plan por jornada y orden de ejecución
  acciones.sort((a, b) => a.dia - b.dia || a.ord - b.ord || a.seq - b.seq);
  return { fechas, N, last, clientes, vehs, acciones, stock, caja, hoy, semilla, specs, art };
}

/** Importes estimados con precios de catálogo (sólo para el resumen del plan; el ejecutor usa los precios reales). */
export function estimarTotal(items, art) {
  let neto = 0;
  for (const it of items) {
    if (it.t === 's') neto += pesos(redondear((Object.entries(SERVICIOS).find(([n]) => n === it.n)?.[1] ?? 0) * (1 + AJUSTE_SERVICIOS_PCT / 100), 100));
    else if (it.t === 'a') neto += Math.round(art.get(it.c).precio * it.q);
    else neto += Math.round(it.precio * it.q);
  }
  return Math.round(neto * 1.21);
}
