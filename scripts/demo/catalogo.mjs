// Datos ficticios (pero verosímiles para Argentina) del taller de demostración.
// Ninguna persona, empresa, CUIT, patente ni teléfono es real: los CUIT son válidos sólo por dígito verificador.
import { cuit, pesos, rng, redondear } from './util.mjs';

export const TALLER = {
  nombre: 'Taller Demo Fierro',
  razon_social: 'Demo Mecánica SRL',
  cuit: cuit('30', 71234567),
  condicion_iva: 'responsable_inscripto',
  direccion: 'Av. Rivadavia 14250',
  localidad: 'Ramos Mejía, Buenos Aires',
  telefono: '11 4658-0000',
  email: 'contacto@tallerdemo.example',
  ingresos_brutos: '901-234567-8',
  inicio_actividades: '2016-03-01',
  sitio_web: 'www.tallerdemo.example',
};
export const CONFIG = {
  iva_default: 21,
  recargo_default: 0,
  validez_presupuesto_dias: 15,
  margen_default: 40,
  pie_documentos: 'Garantía de mano de obra: 3 meses o 5.000 km. Los repuestos tienen la garantía del fabricante.',
  pie_presupuesto: 'Presupuesto sujeto a revisión si surgen fallas adicionales al desarmar. Precios sin diagnóstico previo no incluyen fallas ocultas.',
  pie_recibo: 'Gracias por confiar en Taller Demo Fierro.',
  pie_orden_compra: 'Entregar con remito. Horario de recepción: lunes a viernes de 8 a 17 h.',
  permitir_stock_negativo: false,
  caja_obligatoria: true,
  tolerancia_caja: pesos(500),
  alerta_cheques_dias: 7,
  plazo_pago_dias: 30,
  medios_pago: null,
};

export const USUARIOS = [
  { nombre: 'Administración Demo', email: 'administracion@fierro.local', rol: 'administrador' },
  { nombre: 'Mostrador Demo', email: 'mostrador@fierro.local', rol: 'empleado' },
];

export const MECANICOS = [
  { key: 'M1', nombre: 'Carlos Gómez', especialidad: 'Motor, distribución y refrigeración', telefono: '11 5521-4410' },
  { key: 'M2', nombre: 'Lucía Fernández', especialidad: 'Frenos, suspensión y tren delantero', telefono: '11 5530-7821' },
  { key: 'M3', nombre: 'Ramiro Acosta', especialidad: 'Electricidad, inyección y diagnóstico', telefono: '11 5544-2093' },
  { key: 'M4', nombre: 'Nicolás Peralta', especialidad: 'Service, aire acondicionado y mantenimiento', telefono: '11 5517-6638' },
];

// ───── Proveedores ─────
export const PROVEEDORES = [
  { key: 'P1', nombre: 'Lubricantes Pampa SRL', cuit: cuit('30', 70112233), tel: '11 4631-2200', cond: 'responsable_inscripto', dir: 'Av. Gaona 4510, CABA' },
  { key: 'P2', nombre: 'Filtros Argentinos SA', cuit: cuit('30', 70445566), tel: '11 4612-8844', cond: 'responsable_inscripto', dir: 'Cnel. Díaz 780, Haedo' },
  { key: 'P3', nombre: 'Frenos Rioplatense SRL', cuit: cuit('30', 70778899), tel: '11 4623-1155', cond: 'responsable_inscripto', dir: 'Bartolomé Mitre 2300, Morón' },
  { key: 'P4', nombre: 'Autopartes Norte Distribuidora SRL', cuit: cuit('30', 71002244), tel: '11 4755-9000', cond: 'responsable_inscripto', dir: 'Ruta 8 km 22, San Martín' },
  { key: 'P5', nombre: 'Suspensiones del Sur SA', cuit: cuit('30', 71335577), tel: '11 4202-3377', cond: 'responsable_inscripto', dir: 'Av. Mitre 1900, Avellaneda' },
  { key: 'P6', nombre: 'Correas y Rodamientos Cuyo SRL', cuit: cuit('30', 71668800), tel: '11 4811-6420', cond: 'responsable_inscripto', dir: 'Av. Warnes 600, CABA' },
  { key: 'P7', nombre: 'Baterías Libertad SA', cuit: cuit('30', 71990011), tel: '11 4637-5050', cond: 'responsable_inscripto', dir: 'Av. Rivadavia 15800, Ramos Mejía' },
  { key: 'P8', nombre: 'Ferretería Industrial Ramos', cuit: cuit('20', 25311478), tel: '11 4658-7799', cond: 'monotributo', dir: 'Belgrano 120, Ramos Mejía' },
];

// ───── Artículos ─────
// [código, nombre, marca, categoría, proveedor, costo $, margen %, mínimo, unidad, stock inicial]
const ART = [
  // Aceites y lubricantes
  ['ACE-5W30-4', 'Aceite sintético 5W30 x 4 L', 'Lubrimax', 'Aceites y lubricantes', 'P1', 31000, 45, 6, 'un', 22],
  ['ACE-5W40-4', 'Aceite sintético 5W40 x 4 L', 'Lubrimax', 'Aceites y lubricantes', 'P1', 33500, 45, 4, 'un', 14],
  ['ACE-10W40-4', 'Aceite semisintético 10W40 x 4 L', 'Aceitex', 'Aceites y lubricantes', 'P1', 24500, 42, 6, 'un', 18],
  ['ACE-15W40-4', 'Aceite mineral 15W40 x 4 L', 'Aceitex', 'Aceites y lubricantes', 'P1', 17800, 40, 4, 'un', 10],
  ['ACE-15W40-D7', 'Aceite diésel 15W40 x 7 L', 'Motorlux', 'Aceites y lubricantes', 'P1', 41500, 40, 4, 'un', 14],
  ['ACE-ATF-L', 'Aceite ATF caja automática (por litro)', 'Motorlux', 'Aceites y lubricantes', 'P1', 8400, 50, 20, 'lt', 60],
  ['ACE-75W90-L', 'Aceite transmisión 75W90 (por litro)', 'Motorlux', 'Aceites y lubricantes', 'P1', 9700, 50, 10, 'lt', 30],
  ['GRA-MP-400', 'Grasa multipropósito x 400 g', 'Lubrimax', 'Aceites y lubricantes', 'P1', 5200, 60, 4, 'un', 10],
  ['LIM-INY-500', 'Limpia inyectores x 500 ml', 'Lubrimax', 'Aceites y lubricantes', 'P1', 6800, 70, 4, 'un', 12],
  // Refrigeración
  ['REF-ORG-5', 'Refrigerante orgánico 50 % x 5 L', 'CoolMax', 'Refrigeración', 'P1', 12800, 50, 6, 'un', 16],
  ['REF-VER-5', 'Refrigerante verde 50 % x 5 L', 'CoolMax', 'Refrigeración', 'P1', 9800, 50, 4, 'un', 10],
  ['TER-A', 'Termostato con junta tipo A', 'Termix', 'Refrigeración', 'P4', 9600, 60, 2, 'un', 5],
  ['BOM-AGU-A', 'Bomba de agua tipo A', 'Hidrotec', 'Refrigeración', 'P6', 38500, 45, 2, 'un', 4],
  ['BOM-AGU-B', 'Bomba de agua tipo B', 'Hidrotec', 'Refrigeración', 'P6', 44800, 45, 2, 'un', 3],
  ['TAP-RAD', 'Tapa de radiador 1,1 bar', 'Termix', 'Refrigeración', 'P4', 5400, 70, 3, 'un', 6],
  // Filtros
  ['FIL-ACE-A', 'Filtro de aceite tipo A', 'FiltroPro', 'Filtros', 'P2', 4800, 60, 8, 'un', 26],
  ['FIL-ACE-B', 'Filtro de aceite tipo B', 'FiltroPro', 'Filtros', 'P2', 5600, 60, 8, 'un', 28],
  ['FIL-ACE-C', 'Filtro de aceite tipo C (pickups)', 'FiltroPro', 'Filtros', 'P2', 7200, 60, 6, 'un', 18],
  ['FIL-ACE-D', 'Filtro de aceite tipo D', 'FiltroPro', 'Filtros', 'P2', 6300, 60, 6, 'un', 18],
  ['FIL-AIR-A', 'Filtro de aire tipo A', 'Filtrex', 'Filtros', 'P2', 6200, 60, 6, 'un', 14],
  ['FIL-AIR-B', 'Filtro de aire tipo B', 'Filtrex', 'Filtros', 'P2', 7400, 60, 6, 'un', 16],
  ['FIL-AIR-C', 'Filtro de aire tipo C (pickups)', 'Filtrex', 'Filtros', 'P2', 11800, 60, 4, 'un', 10],
  ['FIL-AIR-D', 'Filtro de aire tipo D', 'Filtrex', 'Filtros', 'P2', 9600, 60, 4, 'un', 10],
  ['FIL-COM-A', 'Filtro de combustible tipo A', 'FiltroPro', 'Filtros', 'P2', 7900, 60, 4, 'un', 10],
  ['FIL-COM-B', 'Filtro de combustible tipo B', 'FiltroPro', 'Filtros', 'P2', 8800, 60, 4, 'un', 10],
  ['FIL-COM-C', 'Filtro de combustible diésel', 'FiltroPro', 'Filtros', 'P2', 18500, 55, 4, 'un', 8],
  ['FIL-COM-D', 'Filtro de combustible tipo D', 'FiltroPro', 'Filtros', 'P2', 9900, 60, 4, 'un', 8],
  ['FIL-HAB-A', 'Filtro de habitáculo tipo A', 'AireMax', 'Filtros', 'P2', 6900, 65, 4, 'un', 10],
  ['FIL-HAB-B', 'Filtro de habitáculo tipo B', 'AireMax', 'Filtros', 'P2', 7800, 65, 4, 'un', 10],
  ['FIL-HAB-C', 'Filtro de habitáculo tipo C', 'AireMax', 'Filtros', 'P2', 8600, 65, 4, 'un', 8],
  // Frenos
  ['PAS-DEL-A', 'Pastillas de freno delanteras tipo A (juego)', 'Frenar', 'Frenos', 'P3', 15800, 55, 4, 'juego', 10],
  ['PAS-DEL-B', 'Pastillas de freno delanteras tipo B (juego)', 'Frenar', 'Frenos', 'P3', 19800, 55, 4, 'juego', 10],
  ['PAS-DEL-C', 'Pastillas de freno delanteras tipo C (juego)', 'Frenar', 'Frenos', 'P3', 29500, 55, 3, 'juego', 6],
  ['PAS-DEL-D', 'Pastillas de freno delanteras tipo D (juego)', 'Frenar', 'Frenos', 'P3', 24800, 55, 3, 'juego', 6],
  ['PAS-TRA-A', 'Pastillas / cintas traseras tipo A (juego)', 'Fricción Sur', 'Frenos', 'P3', 13900, 55, 3, 'juego', 6],
  ['PAS-TRA-B', 'Pastillas / cintas traseras tipo B (juego)', 'Fricción Sur', 'Frenos', 'P3', 16800, 55, 3, 'juego', 6],
  ['PAS-TRA-C', 'Pastillas / cintas traseras tipo C (juego)', 'Fricción Sur', 'Frenos', 'P3', 24500, 55, 2, 'juego', 4],
  ['PAS-TRA-D', 'Pastillas / cintas traseras tipo D (juego)', 'Fricción Sur', 'Frenos', 'P3', 20800, 55, 2, 'juego', 4],
  ['DIS-DEL-A', 'Discos de freno delanteros tipo A (par)', 'Frenar', 'Frenos', 'P3', 31000, 50, 2, 'juego', 5],
  ['DIS-DEL-B', 'Discos de freno delanteros tipo B (par)', 'Frenar', 'Frenos', 'P3', 38500, 50, 2, 'juego', 5],
  ['DIS-DEL-C', 'Discos de freno delanteros tipo C (par)', 'Frenar', 'Frenos', 'P3', 56000, 50, 2, 'juego', 3],
  ['DIS-DEL-D', 'Discos de freno delanteros tipo D (par)', 'Frenar', 'Frenos', 'P3', 47500, 50, 2, 'juego', 3],
  ['LIQ-FRE-D4', 'Líquido de frenos DOT4 x 500 ml', 'Frenar', 'Frenos', 'P3', 3900, 80, 8, 'un', 20],
  // Encendido
  ['BUJ-A', 'Bujía convencional tipo A', 'Chispa', 'Encendido', 'P4', 3400, 70, 8, 'un', 36],
  ['BUJ-B', 'Bujía convencional tipo B', 'Chispa', 'Encendido', 'P4', 4200, 70, 8, 'un', 36],
  ['BUJ-C', 'Bujía de precalentamiento (diésel)', 'Chispa', 'Encendido', 'P4', 9800, 60, 8, 'un', 24],
  ['BUJ-D', 'Bujía de iridio tipo D', 'Ignitec', 'Encendido', 'P4', 11800, 60, 8, 'un', 24],
  ['BOB-ENC', 'Bobina de encendido', 'Ignitec', 'Encendido', 'P4', 26500, 50, 2, 'un', 4],
  ['CAB-BUJ', 'Cables de bujía (juego)', 'Ignitec', 'Encendido', 'P4', 14800, 55, 2, 'juego', 4],
  ['SEN-OXI', 'Sensor de oxígeno (sonda lambda)', 'Ignitec', 'Encendido', 'P4', 31500, 50, 2, 'un', 3],
  ['SEN-CIG', 'Sensor de posición de cigüeñal', 'Ignitec', 'Encendido', 'P4', 22800, 50, 1, 'un', 2],
  // Suspensión
  ['AMO-DEL-A', 'Amortiguador delantero tipo A', 'Amortex', 'Suspensión', 'P5', 28000, 50, 4, 'un', 8],
  ['AMO-DEL-B', 'Amortiguador delantero tipo B', 'Amortex', 'Suspensión', 'P5', 33500, 50, 4, 'un', 8],
  ['AMO-DEL-C', 'Amortiguador delantero tipo C (pickups)', 'Amortex', 'Suspensión', 'P5', 52000, 50, 2, 'un', 4],
  ['AMO-DEL-D', 'Amortiguador delantero tipo D', 'Amortex', 'Suspensión', 'P5', 44500, 50, 2, 'un', 4],
  ['AMO-TRA-A', 'Amortiguador trasero tipo A', 'Amortex', 'Suspensión', 'P5', 21500, 50, 4, 'un', 8],
  ['AMO-TRA-B', 'Amortiguador trasero tipo B', 'Amortex', 'Suspensión', 'P5', 26000, 50, 4, 'un', 8],
  ['AMO-TRA-C', 'Amortiguador trasero tipo C (pickups)', 'Amortex', 'Suspensión', 'P5', 41000, 50, 2, 'un', 4],
  ['AMO-TRA-D', 'Amortiguador trasero tipo D', 'Amortex', 'Suspensión', 'P5', 35500, 50, 2, 'un', 4],
  ['BUJ-SUS', 'Kit de bujes de parrilla (juego)', 'SuspenSur', 'Suspensión', 'P5', 18500, 60, 3, 'juego', 6],
  ['EXT-DIR', 'Extremo de dirección', 'SuspenSur', 'Suspensión', 'P5', 11500, 60, 4, 'un', 8],
  // Correas y distribución
  ['KIT-DIS-A', 'Kit de distribución tipo A (correa, tensor y rodillos)', 'Tensor-Pro', 'Correas y distribución', 'P6', 48500, 45, 2, 'juego', 4],
  ['KIT-DIS-B', 'Kit de distribución tipo B (correa, tensor y rodillos)', 'Tensor-Pro', 'Correas y distribución', 'P6', 56500, 45, 2, 'juego', 4],
  ['KIT-DIS-C', 'Kit de distribución diésel tipo C', 'Tensor-Pro', 'Correas y distribución', 'P6', 88000, 45, 1, 'juego', 2],
  ['KIT-DIS-D', 'Kit de distribución tipo D (correa, tensor y rodillos)', 'Tensor-Pro', 'Correas y distribución', 'P6', 64500, 45, 1, 'juego', 3],
  ['COR-PV-A', 'Correa poly-V tipo A', 'Correa-Plus', 'Correas y distribución', 'P6', 9800, 60, 3, 'un', 6],
  ['COR-PV-B', 'Correa poly-V tipo B', 'Correa-Plus', 'Correas y distribución', 'P6', 11800, 60, 3, 'un', 6],
  ['COR-PV-C', 'Correa poly-V tipo C', 'Correa-Plus', 'Correas y distribución', 'P6', 15400, 60, 3, 'un', 5],
  ['TEN-AUT', 'Tensor automático de correa poly-V', 'Tensor-Pro', 'Correas y distribución', 'P6', 17500, 55, 2, 'un', 3],
  // Baterías
  ['BAT-45', 'Batería 12 V 45 Ah', 'PowerCell', 'Baterías', 'P7', 78000, 35, 2, 'un', 5],
  ['BAT-65', 'Batería 12 V 65 Ah', 'PowerCell', 'Baterías', 'P7', 96000, 35, 3, 'un', 7],
  ['BAT-75', 'Batería 12 V 75 Ah', 'PowerCell', 'Baterías', 'P7', 112000, 35, 2, 'un', 5],
  ['BAT-100', 'Batería 12 V 100 Ah (pickups)', 'PowerCell', 'Baterías', 'P7', 148000, 35, 2, 'un', 4],
  ['BOR-BAT', 'Par de bornes para batería', 'EnerBat', 'Baterías', 'P7', 3800, 80, 4, 'juego', 10],
  // Varios
  ['DES-MOT-5', 'Desengrasante para motores x 5 L', 'Limpiex', 'Varios', 'P8', 9800, 50, 3, 'un', 8],
  ['TRA-IND', 'Trapos industriales (por kg)', 'Limpiex', 'Varios', 'P8', 2800, 60, 10, 'kg', 40],
  ['LAM-H4', 'Lámpara H4 12 V (juego)', 'LuzMax', 'Varios', 'P8', 7200, 70, 6, 'juego', 16],
  ['ESC-LIM', 'Escobillas limpiaparabrisas (juego)', 'Visiotec', 'Varios', 'P8', 11500, 70, 4, 'juego', 10],
  ['FUS-KIT', 'Kit de fusibles surtidos', 'Ignitec', 'Varios', 'P8', 4900, 80, 4, 'un', 10],
  ['GAS-R134', 'Gas refrigerante R134a (por kg)', 'CoolMax', 'Varios', 'P8', 14200, 50, 3, 'kg', 8],
];

/** Redondea el precio de venta a múltiplos de $100 (centavos). */
/**
 * El stock mínimo y el inicial se ajustan para un taller de este tamaño: los repuestos caros se tienen de a pocos.
 * El stock inicial es también el nivel al que se repone ("stock ideal").
 */
export const ARTICULOS = ART.map(([codigo, nombre, marca, categoria, prov, costo, margen, minBase, unidad]) => {
  const min = Math.max(1, Math.ceil(minBase * (costo >= 40000 ? 0.4 : 0.6)));
  const ideal = Math.max(min + 1, Math.ceil(min * 1.5));
  return {
    codigo, nombre, marca, categoria, prov,
    costo: pesos(costo),
    precio: redondear(pesos(costo) * (1 + margen / 100), 10000),
    min, unidad, stock0: ideal, objetivo: ideal,
  };
});

/** Precios de lista de los servicios del catálogo inicial (debe coincidir con worker/modules/provision.ts; el ejecutor usa los reales de la API). */
export const SERVICIOS = {
  'Service de aceite y filtros': 60000,
  'Service completo': 95000,
  'Service caja automática': 120000,
  'Cambio de pastillas delanteras': 45000,
  'Cambio de pastillas y discos delanteros': 80000,
  'Cambio de cintas / pastillas traseras': 50000,
  'Cambio de líquido de frenos': 30000,
  'Cambio de kit de distribución': 180000,
  'Cambio de correa poly-V': 35000,
  'Alineación y balanceo': 35000,
  'Cambio de amortiguadores delanteros': 90000,
  'Cambio de amortiguadores traseros': 70000,
  'Cambio de bujes / extremos': 55000,
  'Cambio de bujías': 25000,
  'Cambio de batería': 15000,
  'Diagnóstico con escáner': 25000,
  'Cambio de líquido refrigerante': 35000,
  'Cambio de bomba de agua': 90000,
  'Carga de gas A/A': 45000,
  'Mano de obra por hora': 25000,
  'Revisión general / pre-VTV': 30000,
};

/** El taller actualiza su mano de obra apenas arranca (ajuste masivo de servicios, redondeado a $100). */
export const AJUSTE_SERVICIOS_PCT = 45;

// ───── Perfiles de vehículo: qué repuesto usa cada familia ─────
export const PERFILES = {
  A: { aceite: 'ACE-10W40-4', fAceite: 'FIL-ACE-A', fAire: 'FIL-AIR-A', fComb: 'FIL-COM-A', fHab: 'FIL-HAB-A', pastDel: 'PAS-DEL-A', pastTra: 'PAS-TRA-A', disDel: 'DIS-DEL-A', bujia: 'BUJ-A', amDel: 'AMO-DEL-A', amTra: 'AMO-TRA-A', kit: 'KIT-DIS-A', correa: 'COR-PV-A', bomba: 'BOM-AGU-A', refri: 'REF-VER-5', bateria: 'BAT-45', bujia_n: 4 },
  B: { aceite: 'ACE-5W30-4', fAceite: 'FIL-ACE-B', fAire: 'FIL-AIR-B', fComb: 'FIL-COM-B', fHab: 'FIL-HAB-B', pastDel: 'PAS-DEL-B', pastTra: 'PAS-TRA-B', disDel: 'DIS-DEL-B', bujia: 'BUJ-B', amDel: 'AMO-DEL-B', amTra: 'AMO-TRA-B', kit: 'KIT-DIS-B', correa: 'COR-PV-B', bomba: 'BOM-AGU-B', refri: 'REF-ORG-5', bateria: 'BAT-65', bujia_n: 4 },
  C: { aceite: 'ACE-15W40-D7', fAceite: 'FIL-ACE-C', fAire: 'FIL-AIR-C', fComb: 'FIL-COM-C', fHab: 'FIL-HAB-C', pastDel: 'PAS-DEL-C', pastTra: 'PAS-TRA-C', disDel: 'DIS-DEL-C', bujia: 'BUJ-C', amDel: 'AMO-DEL-C', amTra: 'AMO-TRA-C', kit: 'KIT-DIS-C', correa: 'COR-PV-C', bomba: 'BOM-AGU-B', refri: 'REF-ORG-5', bateria: 'BAT-100', bujia_n: 4 },
  D: { aceite: 'ACE-5W40-4', fAceite: 'FIL-ACE-D', fAire: 'FIL-AIR-D', fComb: 'FIL-COM-D', fHab: 'FIL-HAB-C', pastDel: 'PAS-DEL-D', pastTra: 'PAS-TRA-D', disDel: 'DIS-DEL-D', bujia: 'BUJ-D', amDel: 'AMO-DEL-D', amTra: 'AMO-TRA-D', kit: 'KIT-DIS-D', correa: 'COR-PV-B', bomba: 'BOM-AGU-B', refri: 'REF-ORG-5', bateria: 'BAT-75', bujia_n: 4 },
};

// ───── Clientes y vehículos ─────
// v: [marca, modelo, año, perfil, combustible, color]
const P = (nombre, localidad, veh, extra = {}) => ({ nombre, localidad, veh, ...extra });
const CLIENTES_BASE = [
  P('Martín Ríos', 'Ramos Mejía', [['Volkswagen', 'Gol Trend', 2014, 'A', 'Nafta/GNC', 'Gris plata'], ['Chevrolet', 'Onix', 2018, 'B', 'Nafta', 'Blanco']]),
  P('Sofía Herrera', 'Haedo', [['Toyota', 'Corolla', 2019, 'D', 'Nafta', 'Gris oscuro'], ['Renault', 'Kwid', 2021, 'B', 'Nafta', 'Naranja']]),
  P('Diego Paz', 'Morón', [['Fiat', 'Palio', 2013, 'A', 'Nafta/GNC', 'Rojo']]),
  P('Valeria Núñez', 'Ramos Mejía', [['Peugeot', '208', 2018, 'B', 'Nafta', 'Blanco']]),
  P('Javier Domínguez', 'Castelar', [['Volkswagen', 'Amarok', 2018, 'C', 'Diésel', 'Gris']]),
  P('Carolina Benítez', 'San Justo', [['Honda', 'Civic', 2017, 'D', 'Nafta', 'Negro'], ['Hyundai', 'HB20', 2020, 'B', 'Nafta', 'Rojo']]),
  P('Matías Sosa', 'Haedo', [['Fiat', 'Cronos', 2020, 'B', 'Nafta', 'Blanco']]),
  P('Luciana Torres', 'Ramos Mejía', [['Jeep', 'Renegade', 2019, 'D', 'Nafta', 'Verde']]),
  P('Federico Acuña', 'Villa Luzuriaga', [['Chevrolet', 'Corsa', 2010, 'A', 'Nafta/GNC', 'Gris']]),
  P('Natalia Giménez', 'Morón', [['Renault', 'Sandero', 2017, 'B', 'Nafta', 'Azul']]),
  P('Pablo Cabrera', 'Castelar', [['Ford', 'Ranger', 2019, 'C', 'Diésel', 'Blanco'], ['Fiat', 'Uno', 2012, 'A', 'Nafta/GNC', 'Rojo']]),
  P('Mariana Ledesma', 'Ramos Mejía', [['Volkswagen', 'Polo', 2019, 'B', 'Nafta', 'Gris']]),
  P('Hernán Quiroga', 'San Justo', [['Chevrolet', 'S10', 2020, 'C', 'Diésel', 'Negro']]),
  P('Gabriela Molina', 'Haedo', [['Volkswagen', 'Vento', 2016, 'D', 'Nafta', 'Plata']]),
  P('Sebastián Ibarra', 'Morón', [['Renault', 'Clio', 2011, 'A', 'Nafta/GNC', 'Bordó']]),
  P('Florencia Rojas', 'Ramos Mejía', [['Nissan', 'March', 2016, 'B', 'Nafta', 'Blanco']]),
  P('Ezequiel Vera', 'Castelar', [['Nissan', 'Frontier', 2017, 'C', 'Diésel', 'Gris']]),
  P('Romina Salazar', 'Villa Luzuriaga', [['Ford', 'EcoSport', 2018, 'D', 'Nafta', 'Naranja']]),
  P('Gustavo Medina', 'San Justo', [['Fiat', 'Toro', 2019, 'C', 'Diésel', 'Blanco']]),
  P('Andrea Villalba', 'Haedo', [['Hyundai', 'Tucson', 2016, 'D', 'Nafta', 'Gris']]),
  P('Leandro Suárez', 'Morón', [['Peugeot', '207', 2012, 'A', 'Nafta', 'Negro']]),
  P('Paula Cardozo', 'Ramos Mejía', [['Fiat', 'Argo', 2019, 'B', 'Nafta', 'Rojo']]),
  P('Marcelo Franco', 'Castelar', [['Chevrolet', 'Prisma', 2015, 'A', 'Nafta/GNC', 'Plata']]),
  P('Cecilia Navarro', 'Haedo', [['Chevrolet', 'Tracker', 2021, 'D', 'Nafta', 'Blanco']]),
  P('Walter Ojeda', 'San Justo', [['Renault', 'Oroch', 2020, 'C', 'Diésel', 'Gris']]),
  P('Daniela Pereyra', 'Ramos Mejía', [['Peugeot', '2008', 2020, 'D', 'Nafta', 'Azul']]),
  P('Transportes Lago SRL', 'San Justo', [['Toyota', 'Hilux', 2021, 'C', 'Diésel', 'Blanco'], ['Toyota', 'Hilux', 2018, 'C', 'Diésel', 'Blanco']], { empresa: cuit('30', 71234111) }),
  P('Logística Ribera SA', 'Haedo', [['Renault', 'Kangoo', 2018, 'B', 'Nafta', 'Blanco']], { empresa: cuit('30', 70981234) }),
  P('Constructora Del Valle SA', 'Morón', [['Ford', 'Ranger', 2020, 'C', 'Diésel', 'Gris']], { empresa: cuit('30', 70556677) }),
  P('Panadería La Espiga SRL', 'Ramos Mejía', [['Fiat', 'Fiorino', 2016, 'A', 'Nafta/GNC', 'Blanco']], { empresa: cuit('30', 71440099) }),
];

const CALLES = ['Av. de Mayo', 'Rivadavia', 'Belgrano', 'San Martín', 'Mitre', 'Sarmiento', 'Pellegrini', 'Alsina', 'Moreno', 'Güemes', 'Perón', 'Yrigoyen', 'Lamadrid', 'Castelli'];
const sinTildes = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Clientes y vehículos con datos de contacto, documentos y patentes deterministas. */
export function construirClientes(semilla) {
  const R = rng(semilla + 11);
  const patentes = new Set();
  const letras = 'ABCDEFGHJKLMNPRSTUVXZ';
  const L = () => letras[R.int(0, letras.length - 1)];
  const patente = (anio) => {
    for (;;) {
      const p = anio >= 2016 ? `A${L()}${R.int(100, 999)}${L()}${L()}` : `${L()}${L()}${L()}${R.int(100, 999)}`;
      if (!patentes.has(p)) return (patentes.add(p), p);
    }
  };
  return CLIENTES_BASE.map((c, i) => {
    const dni = R.int(17_000_000, 41_000_000);
    const [nom, ...ape] = c.nombre.split(' ');
    return {
      key: `C${String(i + 1).padStart(2, '0')}`,
      nombre: c.nombre,
      documento_tipo: c.empresa ? 'CUIT' : 'DNI',
      documento: c.empresa ? c.empresa.replace(/\D/g, '') : String(dni),
      cuit: c.empresa ?? cuit(R.chance(0.5) ? '20' : '27', dni),
      condicion_iva: c.empresa ? 'responsable_inscripto' : 'consumidor_final',
      telefono: `11 ${R.int(5100, 6999)}-${String(R.int(0, 9999)).padStart(4, '0')}`,
      email: c.empresa ? `compras@${sinTildes(nom).toLowerCase()}${sinTildes(ape[0] ?? '').toLowerCase()}.example` : `${sinTildes(nom).toLowerCase()}.${sinTildes(ape.join('')).toLowerCase()}@example.com`,
      direccion: `${R.pick(CALLES)} ${R.int(100, 3900)}`,
      localidad: c.localidad,
      empresa: !!c.empresa,
      vehiculos: c.veh.map(([marca, modelo, anio, perfil, combustible, color], j) => ({
        key: `V${String(i + 1).padStart(2, '0')}${String.fromCharCode(97 + j)}`,
        marca, modelo, anio, perfil, combustible, color,
        patente: patente(anio),
        km: Math.round(((2026 - anio) * R.int(8500, 14500) + R.int(500, 6000)) / 100) * 100,
      })),
    };
  });
}

// ───── Cuentas bancarias ─────
export const CUENTAS = [
  { key: 'galicia', nombre: 'Banco Galicia · Cta. Cte. $', banco: 'Banco Galicia', tipo: 'cuenta_corriente', alias: 'taller.demo.galicia', cbu: '0070999020000041234567', saldo: 2_400_000 },
  { key: 'mp', nombre: 'Mercado Pago · Billetera', banco: 'Mercado Pago', tipo: 'billetera_virtual', alias: 'taller.demo.mp', cbu: '0000003100001234567890', saldo: 120_000 },
  { key: 'santander', nombre: 'Banco Santander · Caja de ahorro $', banco: 'Banco Santander', tipo: 'caja_ahorro', alias: 'demo.fierro.ahorro', cbu: '0720000788000035987654', saldo: 650_000 },
];

export const LISTAS = [
  { key: 'mayorista', nombre: 'Mayorista / flotas', descripcion: 'Empresas y flotas: costo + 28 %, mano de obra con 10 % de descuento', base: 'costo', porcentaje: 28, redondeo: 1000, servicios_pct: -10 },
  { key: 'tarjeta', nombre: 'Tarjeta de crédito (3 cuotas)', descripcion: 'Recargo por financiación sobre el precio de lista', base: 'precio', porcentaje: 12, redondeo: 1000, servicios_pct: 12 },
];

export const BANCOS_CHEQUE = ['Banco Nación', 'Banco Provincia', 'Banco Santander', 'Banco Galicia', 'BBVA', 'Banco Macro', 'ICBC'];
