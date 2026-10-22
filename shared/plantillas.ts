// Plantillas generales de Fierro: catálogos de arranque útiles para cualquier taller.
//
// NO son datos de ningún taller y NO traen precios de venta: cada taller recibe su propia copia y la personaliza. Los tiempos del tempario
// (shared/tempario.ts) son orientativos. Nada de lo que un taller carga se copia a otro: estas listas son lo único compartido.

export const MARCAS_PLANTILLA: Record<string, string[]> = {
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

export const CATEGORIAS_GASTO_PLANTILLA: Array<[string, 'operativo' | 'fijo' | 'impuestos' | 'otro']> = [
  ['Alquiler', 'fijo'], ['Servicios (luz, agua, internet)', 'fijo'], ['Sueldos y jornales', 'fijo'], ['Impuestos y tasas', 'impuestos'], ['Insumos de taller', 'operativo'],
  ['Herramientas y equipos', 'operativo'], ['Mantenimiento', 'operativo'], ['Limpieza', 'operativo'], ['Combustible y fletes', 'operativo'], ['Publicidad', 'fijo'], ['Varios', 'otro'],
];

export const CATEGORIAS_ARTICULO_PLANTILLA = ['Aceites y lubricantes', 'Filtros', 'Frenos', 'Encendido', 'Suspensión', 'Refrigeración', 'Correas y distribución', 'Baterías', 'Varios'];

