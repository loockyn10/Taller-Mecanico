// Alta de un taller nuevo con su licencia, propietario y catálogo inicial.
import { ahora, uid, type Stmt } from '../lib/db';

const MARCAS: Record<string, string[]> = {
  Chevrolet: ['Onix', 'Cruze', 'Tracker', 'S10', 'Corsa', 'Prisma', 'Spin', 'Agile'],
  Citroën: ['C3', 'C4', 'Berlingo', 'C4 Cactus'],
  Fiat: ['Cronos', 'Argo', 'Palio', 'Siena', 'Strada', 'Toro', 'Uno', 'Fiorino', 'Mobi'],
  Ford: ['Ka', 'Fiesta', 'Focus', 'EcoSport', 'Ranger', 'Territory', 'Maverick'],
  Honda: ['Civic', 'City', 'Fit', 'HR-V', 'CR-V'],
  Hyundai: ['HB20', 'Tucson', 'Creta', 'i30'],
  Jeep: ['Renegade', 'Compass', 'Commander'],
  Nissan: ['March', 'Versa', 'Sentra', 'Kicks', 'Frontier'],
  Peugeot: ['208', '2008', '308', '3008', 'Partner', '207', 'Expert'],
  Renault: ['Clio', 'Sandero', 'Logan', 'Kangoo', 'Duster', 'Kwid', 'Oroch', 'Alaskan', 'Fluence'],
  Toyota: ['Etios', 'Yaris', 'Corolla', 'Corolla Cross', 'Hilux', 'SW4', 'RAV4'],
  Volkswagen: ['Gol', 'Gol Trend', 'Polo', 'Virtus', 'Vento', 'Golf', 'T-Cross', 'Taos', 'Nivus', 'Amarok', 'Saveiro', 'Suran'],
  'Mercedes-Benz': ['Clase A', 'Clase C', 'Sprinter', 'Vito'],
  BMW: ['Serie 1', 'Serie 3', 'X1', 'X3'],
  Audi: ['A1', 'A3', 'A4', 'Q3', 'Q5'],
  Kia: ['Picanto', 'Rio', 'Sportage', 'Cerato'],
  Chery: ['Tiggo 2', 'Tiggo 3', 'Tiggo 4'],
  RAM: ['1500', '2500'],
};

const SERVICIOS: Array<[string, Array<[string, number, number | null, number | null]>]> = [
  // [categoría, [[nombre, precio pesos, intervalo km, intervalo meses]]]
  ['Service', [
    ['Service de aceite y filtros', 60000, 10000, 12],
    ['Service completo (aceite, filtros aire/combustible/habitáculo)', 95000, 20000, 12],
    ['Service caja automática', 120000, 60000, 48],
  ]],
  ['Frenos', [
    ['Cambio de pastillas delanteras', 45000, null, null],
    ['Cambio de pastillas y discos delanteros', 80000, null, null],
    ['Cambio de cintas / pastillas traseras', 50000, null, null],
    ['Cambio de líquido de frenos', 30000, 40000, 24],
  ]],
  ['Distribución', [
    ['Cambio de kit de distribución', 180000, 60000, 48],
    ['Cambio de correa poly-V', 35000, 60000, null],
  ]],
  ['Suspensión y tren delantero', [
    ['Alineación y balanceo', 35000, 10000, 6],
    ['Cambio de amortiguadores delanteros', 90000, null, null],
    ['Cambio de amortiguadores traseros', 70000, null, null],
    ['Cambio de bujes / extremos', 55000, null, null],
  ]],
  ['Encendido y electricidad', [
    ['Cambio de bujías', 25000, 30000, null],
    ['Cambio de batería', 15000, null, null],
    ['Diagnóstico con escáner', 25000, null, null],
  ]],
  ['Refrigeración', [
    ['Cambio de líquido refrigerante', 35000, 40000, 24],
    ['Cambio de bomba de agua', 90000, null, null],
  ]],
  ['Aire acondicionado', [['Carga de gas A/A', 45000, null, 12]]],
  ['Varios', [['Mano de obra por hora', 25000, null, null], ['Revisión general / pre-VTV', 30000, null, 12]]],
];

export const CATEGORIAS_GASTO: Array<[string, 'operativo' | 'fijo' | 'impuestos' | 'otro']> = [
  ['Alquiler', 'fijo'], ['Servicios (luz, agua, internet)', 'fijo'], ['Sueldos y jornales', 'fijo'], ['Impuestos y tasas', 'impuestos'], ['Insumos de taller', 'operativo'],
  ['Herramientas y equipos', 'operativo'], ['Mantenimiento', 'operativo'], ['Limpieza', 'operativo'], ['Combustible y fletes', 'operativo'], ['Publicidad', 'fijo'], ['Varios', 'otro'],
];

const CATEGORIAS_ARTICULO = ['Aceites y lubricantes', 'Filtros', 'Frenos', 'Encendido', 'Suspensión', 'Refrigeración', 'Correas y distribución', 'Baterías', 'Varios'];

export interface DatosTallerNuevo {
  nombre: string;
  cuit?: string | null;
  condicion_iva?: string;
  telefono?: string | null;
  email?: string | null;
  propietario: { nombre: string; email: string; password_hash: string };
  usuarios_incluidos?: number;
  usuarios_adicionales?: number;
  plan?: string;
}

export function sentenciasAltaTaller(db: D1Database, d: DatosTallerNuevo): { tallerId: string; propietarioId: string; stmts: Stmt[] } {
  const tallerId = uid();
  const propietarioId = uid();
  const s: Stmt[] = [
    db.prepare('INSERT INTO talleres (id, nombre, cuit, condicion_iva, telefono, email) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(tallerId, d.nombre, d.cuit ?? null, d.condicion_iva ?? 'monotributo', d.telefono ?? null, d.email ?? null),
    db.prepare('INSERT INTO licencias (taller_id, plan, usuarios_incluidos, usuarios_adicionales) VALUES (?, ?, ?, ?)')
      .bind(tallerId, d.plan ?? 'base', d.usuarios_incluidos ?? 1, d.usuarios_adicionales ?? 0),
    db.prepare('INSERT INTO licencia_eventos (id, taller_id, tipo, detalle) VALUES (?, ?, ?, ?)')
      .bind(uid(), tallerId, 'alta', JSON.stringify({ usuarios_incluidos: d.usuarios_incluidos ?? 1, usuarios_adicionales: d.usuarios_adicionales ?? 0, fecha: ahora() })),
    // IVA por defecto de los documentos nuevos: sólo los responsables inscriptos discriminan IVA.
    db.prepare('INSERT INTO taller_config (taller_id, iva_default) VALUES (?, ?)').bind(tallerId, d.condicion_iva === 'responsable_inscripto' ? 21 : 0),
    db.prepare("INSERT INTO usuarios (id, taller_id, email, nombre, rol, plantilla, password_hash) VALUES (?, ?, ?, ?, 'propietario', 'propietario', ?)")
      .bind(propietarioId, tallerId, d.propietario.email, d.propietario.nombre, d.propietario.password_hash),
    // Cliente genérico para ventas de mostrador
    db.prepare("INSERT INTO clientes (id, taller_id, codigo, nombre) VALUES (?, ?, 0, 'Consumidor final')").bind(uid(), tallerId),
    db.prepare("INSERT INTO secuencias (taller_id, clave, valor) VALUES (?, 'cliente', 0)").bind(tallerId),
  ];
  for (const [marca, modelos] of Object.entries(MARCAS)) {
    const marcaId = uid();
    s.push(db.prepare('INSERT INTO marcas (id, taller_id, nombre) VALUES (?, ?, ?)').bind(marcaId, tallerId, marca));
    for (const m of modelos) s.push(db.prepare('INSERT INTO modelos (id, taller_id, marca_id, nombre) VALUES (?, ?, ?, ?)').bind(uid(), tallerId, marcaId, m));
  }
  SERVICIOS.forEach(([cat, items], i) => {
    const catId = uid();
    s.push(db.prepare('INSERT INTO categorias_servicio (id, taller_id, nombre, orden) VALUES (?, ?, ?, ?)').bind(catId, tallerId, cat, i));
    for (const [nombre, precio, km, meses] of items) {
      s.push(
        db.prepare('INSERT INTO servicios (id, taller_id, categoria_id, nombre, precio, intervalo_km, intervalo_meses) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(uid(), tallerId, catId, nombre, precio * 100, km, meses),
      );
    }
  });
  for (const [nombre, tipo] of CATEGORIAS_GASTO) s.push(db.prepare('INSERT INTO categorias_gasto (id, taller_id, nombre, tipo) VALUES (?, ?, ?, ?)').bind(uid(), tallerId, nombre, tipo));
  for (const c of CATEGORIAS_ARTICULO) s.push(db.prepare('INSERT INTO categorias_articulo (id, taller_id, nombre) VALUES (?, ?, ?)').bind(uid(), tallerId, c));
  return { tallerId, propietarioId, stmts: s };
}
