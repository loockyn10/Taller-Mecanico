import { describe, expect, it } from 'vitest';
import {
  claveReferenciaCliente, clavesDeFila, detectarSeparadorDecimal, interpretarCondicionIva, interpretarDocumento, interpretarUnidad, normalizarArticulo, normalizarCliente,
  normalizarProveedor, normalizarVehiculo, parseCentavos, parseDecimal, parseEntero, sugerirMapeo, CAMPOS_IMPORTACION, TIPOS_IMPORTACION,
} from '../../shared/importacion';
import { cuitValido } from '../../shared/dominio';
import { horariosPorDefecto, resumenHorarios, validarHorarios } from '../../shared/puesta';

/** Un CUIT con dígito verificador correcto para el prefijo y número dados. */
function cuit(prefijo: string, numero: string): string {
  const base = prefijo + numero;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((a, p, i) => a + p * Number(base[i]), 0);
  let v = 11 - (suma % 11);
  if (v === 11) v = 0;
  if (v === 10) v = 9;
  return base + v;
}

describe('lectura de números', () => {
  it('interpreta importes en formato argentino y con punto decimal', () => {
    expect(parseDecimal('1.234,56', ',')).toBe(1234.56);
    expect(parseDecimal('$ 12.000,00', ',')).toBe(12000);
    expect(parseDecimal('1234.5', ',')).toBe(1234.5); // un solo punto con 1-2 decimales: decimal
    expect(parseDecimal('1.234', ',')).toBe(1234); // los miles llevan 3 dígitos
    expect(parseDecimal('1,234.56', '.')).toBe(1234.56);
    expect(parseDecimal('12,5', '.')).toBe(12.5);
    expect(parseDecimal('(100)', ',')).toBe(-100);
    expect(parseDecimal(15.25)).toBe(15.25);
    expect(parseDecimal('')).toBeUndefined();
    expect(parseDecimal(null)).toBeUndefined();
    expect(Number.isNaN(parseDecimal('abc'))).toBe(true);
    expect(Number.isNaN(parseDecimal('12 34 abc'))).toBe(true);
    expect(parseCentavos('19,99')).toBe(1999);
    expect(parseCentavos(19.99)).toBe(1999);
  });
  it('enteros: los puntos son miles', () => {
    expect(parseEntero('85.000')).toBe(85000);
    expect(parseEntero('85000')).toBe(85000);
    expect(parseEntero(2015)).toBe(2015);
    expect(parseEntero('2015.0')).toBe(2015);
    expect(Number.isNaN(parseEntero('12,5'))).toBe(true);
    expect(Number.isNaN(parseEntero(12.5))).toBe(true);
    expect(parseEntero('')).toBeUndefined();
  });
  it('detecta el separador decimal mirando los valores', () => {
    expect(detectarSeparadorDecimal(['12.50', '3.25', '100.00'])).toBe('.');
    expect(detectarSeparadorDecimal(['12,50', '1.250,00'])).toBe(',');
    expect(detectarSeparadorDecimal(['100', '2000'])).toBe(',');
  });
});

describe('documentos', () => {
  it('reconoce DNI y CUIT, valida el dígito verificador y descarta los documentos genéricos', () => {
    expect(interpretarDocumento('30.123.456')).toMatchObject({ tipo: 'DNI', valor: '30123456', clave: '30123456' });
    const c = cuit('20', '30123456');
    expect(cuitValido(c)).toBe(true);
    expect(interpretarDocumento(c)).toMatchObject({ tipo: 'CUIT', clave: c });
    expect(interpretarDocumento(`${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}`)).toMatchObject({ tipo: 'CUIT', clave: c });
    expect(interpretarDocumento(c, 'CUIL')).toMatchObject({ tipo: 'CUIL' });
    expect(interpretarDocumento('20301234560')).toHaveProperty('error'); // dígito verificador incorrecto
    expect(interpretarDocumento('123')).toHaveProperty('error');
    expect(interpretarDocumento('abc')).toHaveProperty('error');
    expect(interpretarDocumento('')).toBeNull();
    expect(interpretarDocumento('00000000')).toBeNull(); // relleno de consumidor final
    expect(interpretarDocumento('11111111')).toBeNull();
    expect(interpretarDocumento('AB123456', 'Pasaporte')).toMatchObject({ tipo: 'OTRO', clave: 'AB123456' });
    expect(interpretarDocumento(30123456)).toMatchObject({ tipo: 'DNI' });
  });
  it('condiciones frente al IVA y unidades con sus variantes habituales', () => {
    expect(interpretarCondicionIva('Resp. Inscripto')).toBe('responsable_inscripto');
    expect(interpretarCondicionIva('RI')).toBe('responsable_inscripto');
    expect(interpretarCondicionIva('Monotributista')).toBe('monotributo');
    expect(interpretarCondicionIva('IVA Exento')).toBe('exento');
    expect(interpretarCondicionIva('Consumidor Final')).toBe('consumidor_final');
    expect(interpretarCondicionIva('no inscripto')).toBe('consumidor_final');
    expect(interpretarCondicionIva('marciano')).toBeNull();
    expect(interpretarUnidad('Lts')).toBe('lt');
    expect(interpretarUnidad('UNIDAD')).toBe('un');
    expect(interpretarUnidad('Jgo')).toBe('juego');
    expect(interpretarUnidad('Mts')).toBe('m');
    expect(interpretarUnidad('docena')).toBeNull();
  });
});

describe('sugerencia de columnas', () => {
  it('relaciona los encabezados habituales con los campos de Fierro sin repetir columnas', () => {
    const m = sugerirMapeo('articulos', ['Código', 'Descripción', 'Cód. Barras', 'Precio Costo', 'Precio Venta', 'Rubro', 'U.M.', 'Stock', 'Otra cosa']);
    expect(m.codigo).toBe(0);
    expect(m.nombre).toBe(1);
    expect(m.codigo_barras).toBe(2);
    expect(m.costo).toBe(3);
    expect(m.precio).toBe(4);
    expect(m.categoria).toBe(5);
    expect(m.unidad).toBe(6);
    expect(m.stock_inicial).toBe(7);
    const usados = Object.values(m).filter((x) => x !== null);
    expect(new Set(usados).size).toBe(usados.length);
  });
  it('clientes y vehículos', () => {
    const c = sugerirMapeo('clientes', ['Apellido y Nombre', 'DNI/CUIT', 'Teléfono', 'E-mail', 'Domicilio', 'Ciudad']);
    expect(c).toMatchObject({ nombre: 0, documento: 1, telefono: 2, email: 3, direccion: 4, localidad: 5 });
    const v = sugerirMapeo('vehiculos', ['Dominio', 'Marca', 'Modelo', 'Año', 'Kilometraje', 'DNI Cliente']);
    expect(v).toMatchObject({ patente: 0, marca: 1, modelo: 2, anio: 3, km: 4, cliente_documento: 5 });
  });
  it('cada campo tiene un ejemplo y no hay claves repetidas', () => {
    for (const t of TIPOS_IMPORTACION) {
      const claves = CAMPOS_IMPORTACION[t].map((c) => c.clave);
      expect(new Set(claves).size).toBe(claves.length);
      expect(CAMPOS_IMPORTACION[t].some((c) => c.requerido)).toBe(true);
    }
  });
});

describe('normalización de clientes', () => {
  it('una fila válida conserva solo los campos con valor', () => {
    const r = normalizarCliente({ nombre: '  Juan   Pérez ', documento: '30.123.456', email: 'JUAN@Correo.com', telefono: '', condicion_iva: 'Monotributo' });
    expect(r.errores).toEqual([]);
    expect(r.datos).toEqual({ nombre: 'Juan Pérez', documento_tipo: 'DNI', documento: '30123456', documento_clave: '30123456', email: 'juan@correo.com', condicion_iva: 'monotributo' });
    expect('telefono' in r.datos).toBe(false);
  });
  it('informa cada problema por separado', () => {
    const r = normalizarCliente({ nombre: '', documento: '20301234560', email: 'sin-arroba', condicion_iva: 'xx' });
    expect(r.errores).toHaveLength(4);
  });
  it('un documento genérico no identifica a nadie', () => {
    const r = normalizarCliente({ nombre: 'Consumidor', documento: '0' });
    expect(r.errores).toEqual([]);
    expect(r.datos.documento).toBeUndefined();
    expect(clavesDeFila('clientes', r.datos)).toEqual([]);
    expect(r.avisos.length).toBe(1);
  });
  it('los nombres jamás son una clave de duplicado', () => {
    expect(clavesDeFila('clientes', normalizarCliente({ nombre: 'Juan Pérez' }).datos)).toEqual([]);
    expect(clavesDeFila('proveedores', normalizarProveedor({ nombre: 'Repuestos SA' }).datos)).toEqual([]);
    expect(clavesDeFila('articulos', normalizarArticulo({ nombre: 'Filtro' }, { decimal: ',' }).datos)).toEqual([]);
  });
  it('las claves usan documento y código anterior', () => {
    const d = normalizarCliente({ nombre: 'Ana', documento: '27.456.789', codigo_externo: 'C-001' }).datos;
    expect(clavesDeFila('clientes', d)).toEqual(['d:27456789', 'c:c-001']);
  });
});

describe('normalización de proveedores', () => {
  it('valida el CUIT y lo formatea', () => {
    const c = cuit('30', '71234567');
    const r = normalizarProveedor({ nombre: 'Repuestos del Sur', cuit: c });
    expect(r.errores).toEqual([]);
    expect(r.datos.cuit).toBe(`30-71234567-${c.slice(10)}`);
    expect(normalizarProveedor({ nombre: 'X Y', cuit: '30-71234567-0' }).errores.length).toBe(1);
  });
});

describe('normalización de vehículos', () => {
  const anio = 2027;
  it('normaliza la patente y exige cliente', () => {
    const r = normalizarVehiculo({ patente: 'ab 123-cd', cliente_documento: '30123456', marca: 'Fiat', modelo: 'Cronos', anio: '2019', km: '85.000' }, anio);
    expect(r.errores).toEqual([]);
    expect(r.datos).toMatchObject({ patente: 'AB123CD', anio: 2019, km: 85000, cliente_ref: { documento: '30123456' } });
    expect(claveReferenciaCliente(r.datos.cliente_ref!)).toBe('doc:30123456');
    expect(clavesDeFila('vehiculos', r.datos)).toEqual(['p:AB123CD']);
    expect(normalizarVehiculo({ patente: 'AB123CD' }, anio).errores.some((e) => e.includes('cliente'))).toBe(true);
  });
  it('rechaza patentes, años y modelos inválidos', () => {
    expect(normalizarVehiculo({ patente: 'ABC', cliente_codigo: 'C1' }, anio).errores.length).toBe(1);
    expect(normalizarVehiculo({ patente: '123456', cliente_codigo: 'C1' }, anio).errores.length).toBe(1);
    expect(normalizarVehiculo({ patente: 'AB123CD', cliente_codigo: 'C1', anio: 1850 }, anio).errores.length).toBe(1);
    expect(normalizarVehiculo({ patente: 'AB123CD', cliente_codigo: 'C1', modelo: 'Gol' }, anio).errores.length).toBe(1);
  });
  it('el nombre del cliente es la última opción y no se usa si hay documento', () => {
    const r = normalizarVehiculo({ patente: 'AB123CD', cliente_nombre: 'Juan Pérez' }, anio);
    expect(claveReferenciaCliente(r.datos.cliente_ref!)).toBe('nom:juan perez');
  });
});

describe('normalización de artículos', () => {
  it('lee importes, unidad, IVA y existencias', () => {
    const r = normalizarArticulo({ nombre: 'Aceite 5W30', codigo: 'AC-1', costo: '8.500,50', precio: 12000, unidad: 'Lts', alicuota_iva: '21%', stock_minimo: '2', stock_inicial: '10,5' }, { decimal: ',' });
    expect(r.errores).toEqual([]);
    expect(r.datos).toMatchObject({ costo: 850050, precio: 1200000, unidad: 'lt', alicuota_iva: 21, stock_minimo: 2, stock_inicial: 10.5 });
  });
  it('detecta códigos de barras deformados por Excel', () => {
    const r = normalizarArticulo({ nombre: 'Filtro', codigo_barras: '7.79123E+12' }, { decimal: ',' });
    expect(r.errores[0]).toContain('notación científica');
    expect(normalizarArticulo({ nombre: 'Filtro', codigo_barras: 7791234567890 }, { decimal: ',' }).datos.codigo_barras).toBe('7791234567890');
  });
  it('valida importes negativos, IVA y cantidades', () => {
    expect(normalizarArticulo({ nombre: 'Filtro', costo: '-5' }, { decimal: ',' }).errores.length).toBe(1);
    expect(normalizarArticulo({ nombre: 'Filtro', alicuota_iva: '15' }, { decimal: ',' }).errores.length).toBe(1);
    expect(normalizarArticulo({ nombre: 'Filtro', stock_minimo: '5', stock_objetivo: '2' }, { decimal: ',' }).errores.length).toBe(1);
    expect(normalizarArticulo({ nombre: 'Filtro', unidad: 'docena' }, { decimal: ',' }).errores.length).toBe(1);
    expect(normalizarArticulo({ nombre: '' }, { decimal: ',' }).errores.length).toBe(1);
  });
  it('el CUIT del proveedor se valida y se referencia sin guiones', () => {
    const c = cuit('30', '71234567');
    expect(normalizarArticulo({ nombre: 'Filtro', proveedor_cuit: c }, { decimal: ',' }).datos.proveedor_ref).toEqual({ cuit: c });
    expect(normalizarArticulo({ nombre: 'Filtro', proveedor_cuit: '30-71234567-0' }, { decimal: ',' }).errores.length).toBe(1);
  });
  it('códigos e identificadores sin distinguir mayúsculas', () => {
    const d = normalizarArticulo({ nombre: 'Filtro', codigo: 'FA-1', codigo_barras: '779' }, { decimal: ',' }).datos;
    expect(clavesDeFila('articulos', d)).toEqual(['c:fa-1', 'b:779']);
  });
});

describe('horarios de atención', () => {
  it('los horarios por defecto son válidos y se resumen', () => {
    const h = horariosPorDefecto();
    expect(validarHorarios(h)).toBeNull();
    expect(resumenHorarios(h)).toBe('Lun a Vie 08:00–18:00 · Sáb 08:00–13:00');
  });
  it('rechaza horas inválidas, franjas invertidas, superpuestas y días abiertos sin horario', () => {
    const h = horariosPorDefecto();
    h.dias[0].tramos = [{ desde: '18:00', hasta: '08:00' }];
    expect(validarHorarios(h)).toContain('posterior');
    const h2 = horariosPorDefecto();
    h2.dias[1].tramos = [{ desde: '08:00', hasta: '12:00' }, { desde: '11:00', hasta: '18:00' }];
    expect(validarHorarios(h2)).toContain('superponen');
    const h3 = horariosPorDefecto();
    h3.dias[2].tramos = [{ desde: '8am', hasta: '18:00' }];
    expect(validarHorarios(h3)).toContain('hora inválida');
    const h4 = horariosPorDefecto();
    h4.dias[3].tramos = [];
    expect(validarHorarios(h4)).toContain('horario');
  });
});
