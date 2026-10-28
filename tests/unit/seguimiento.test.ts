// Seguimiento público (Sprint 20): traducción del estado de la OT al cliente, recorrido sin etapas futuras completadas, patente oculta, fecha estimada,
// proyección sin datos privados, página HTML escapada, QR y copia del cliente del PDF.
import { describe, expect, it } from 'vitest';
import { ESTADOS_OT, type EstadoOT } from '../../shared/dominio';
import { ESTADO_PUBLICO, enmascararPatente, entregaEstimada, recorrido, tituloTransicion, tokenConFormato, type EventoVisible } from '../../shared/seguimiento';
import { proyectar } from '../../worker/lib/seguimiento';
import type { PagoPublico } from '../../worker/lib/pago-cliente';
import { esc, fechaLarga, paginaNoDisponible, paginaSeguimiento } from '../../worker/lib/seguimiento-html';
import { matrizQr, svgQr } from '../../shared/qr';
import { generarHojaCliente } from '../../worker/lib/hoja-cliente';
import type { DatosHoja } from '../../worker/lib/hoja-orden';

const ev = (estado: EstadoOT, at: string, anterior: EstadoOT | null = null): EventoVisible => ({ estado, anterior, at });

describe('estados públicos', () => {
  it('hay una representación para cada estado operativo (no se crea un sistema paralelo)', () => {
    for (const e of ESTADOS_OT) {
      expect(ESTADO_PUBLICO[e].titulo.length).toBeGreaterThan(3);
      expect(ESTADO_PUBLICO[e].explicacion.length).toBeGreaterThan(10);
    }
  });
});

describe('recorrido', () => {
  it('esperando repuestos: lo anterior hecho, el actual destacado y lo siguiente pendiente (nunca completado)', () => {
    const r = recorrido('esperando_repuestos', [ev('recibida', '2026-10-20T10:00:00Z'), ev('diagnostico', '2026-10-21T10:00:00Z', 'recibida'), ev('esperando_repuestos', '2026-10-22T10:00:00Z', 'diagnostico')]);
    expect(r.map((p) => `${p.situacion}:${p.estado}`)).toEqual(['hecho:recibida', 'hecho:diagnostico', 'actual:esperando_repuestos', 'pendiente:en_reparacion', 'pendiente:lista', 'pendiente:entregada']);
    expect(r.filter((p) => p.situacion === 'pendiente').every((p) => p.at === null)).toBe(true);
  });

  it('ninguna etapa posterior a la actual figura como hecha, en ningún estado y con cualquier historial', () => {
    const todos = ESTADOS_OT.map((e, i) => ev(e, `2026-10-2${i}T10:00:00Z`));
    for (const actual of ESTADOS_OT) {
      const r = recorrido(actual, todos);
      const iActual = r.findIndex((p) => p.situacion === 'actual');
      if (actual === 'cancelada') expect(r).toEqual([]);
      else {
        expect(iActual).toBeGreaterThanOrEqual(0);
        expect(r.slice(iActual + 1).every((p) => p.situacion === 'pendiente')).toBe(true);
        expect(r.filter((p) => p.situacion === 'actual')).toHaveLength(1);
      }
    }
  });

  it('un paso que se salteó no se marca como completado y uno oculto no aparece', () => {
    // recibida → en reparación directo (sin diagnóstico)
    const r = recorrido('en_reparacion', [ev('recibida', '2026-10-20T10:00:00Z'), ev('en_reparacion', '2026-10-21T10:00:00Z', 'recibida')]);
    expect(r.map((p) => p.estado)).toEqual(['recibida', 'en_reparacion', 'lista', 'entregada']);
    // el taller oculta la transición a diagnóstico: el paso no se muestra como hecho
    const oculto = recorrido('en_reparacion', [ev('recibida', '2026-10-20T10:00:00Z'), ev('en_reparacion', '2026-10-22T10:00:00Z', 'diagnostico')]);
    expect(oculto.find((p) => p.estado === 'diagnostico')).toBeUndefined();
  });

  it('puede volver atrás: tras volver a diagnóstico, reparación vuelve a ser un paso pendiente', () => {
    const hist = [ev('recibida', '2026-10-20T10:00:00Z'), ev('diagnostico', '2026-10-20T11:00:00Z', 'recibida'), ev('en_reparacion', '2026-10-21T10:00:00Z', 'diagnostico'), ev('diagnostico', '2026-10-22T10:00:00Z', 'en_reparacion')];
    const r = recorrido('diagnostico', hist);
    expect(r.map((p) => `${p.situacion}:${p.estado}`)).toEqual(['hecho:recibida', 'actual:diagnostico', 'pendiente:en_reparacion', 'pendiente:lista', 'pendiente:entregada']);
    // la fecha del paso actual es la de la ÚLTIMA vez que entró
    expect(r.find((p) => p.situacion === 'actual')!.at).toBe('2026-10-22T10:00:00Z');
    expect(tituloTransicion('diagnostico', 'en_reparacion')).toBe('Volvió a diagnóstico');
    expect(tituloTransicion('diagnostico', 'recibida')).toBe('En diagnóstico');
  });

  it('la espera de repuestos que ya ocurrió queda en el recorrido; la que nunca ocurrió, no', () => {
    const con = recorrido('en_reparacion', [ev('recibida', '2026-10-20T10:00:00Z'), ev('esperando_repuestos', '2026-10-21T10:00:00Z', 'recibida'), ev('en_reparacion', '2026-10-23T10:00:00Z', 'esperando_repuestos')]);
    expect(con.find((p) => p.estado === 'esperando_repuestos')?.situacion).toBe('hecho');
    const sin = recorrido('diagnostico', [ev('recibida', '2026-10-20T10:00:00Z'), ev('diagnostico', '2026-10-20T11:00:00Z', 'recibida')]);
    expect(sin.find((p) => p.estado === 'esperando_repuestos')).toBeUndefined();
  });

  it('listo para retirar y entregado', () => {
    const lista = recorrido('lista', [ev('recibida', '2026-10-20T10:00:00Z'), ev('lista', '2026-10-21T10:00:00Z', 'recibida')]);
    expect(lista.at(-1)).toMatchObject({ estado: 'entregada', situacion: 'pendiente' });
    const entregada = recorrido('entregada', [ev('recibida', '2026-10-20T10:00:00Z'), ev('lista', '2026-10-21T10:00:00Z'), ev('entregada', '2026-10-22T10:00:00Z', 'lista')]);
    expect(entregada.at(-1)).toMatchObject({ estado: 'entregada', situacion: 'actual' });
    expect(entregada.filter((p) => p.situacion === 'pendiente')).toEqual([]);
  });
});

describe('patente', () => {
  it('oculta la parte central de los dos formatos vigentes', () => {
    expect(enmascararPatente('AB123CD')).toBe('AB•••CD');
    expect(enmascararPatente('ab 123 cd')).toBe('AB•••CD');
    expect(enmascararPatente('ABC123')).toBe('AB•••3');
    expect(enmascararPatente('A1')).toBe('••');
    expect(enmascararPatente('')).toBe('');
    expect(enmascararPatente(null)).toBe('');
    // nunca queda la patente completa
    for (const p of ['AB123CD', 'ABC123', 'XYZ789', 'AA000AA']) expect(enmascararPatente(p)).not.toBe(p);
  });
});

describe('fecha estimada', () => {
  it('sólo mientras el trabajo está en curso y si el taller no la ocultó', () => {
    expect(entregaEstimada('2026-10-30', 'en_reparacion', true, '2026-10-24')).toEqual({ fecha: '2026-10-30', vencida: false });
    expect(entregaEstimada('2026-10-30', 'en_reparacion', false, '2026-10-24')).toBeNull();
    expect(entregaEstimada(null, 'en_reparacion', true, '2026-10-24')).toBeNull();
    for (const e of ['lista', 'entregada', 'cancelada'] as const) expect(entregaEstimada('2026-10-30', e, true, '2026-10-24')).toBeNull();
  });
  it('una fecha vencida se marca como tal; hoy todavía no está vencida', () => {
    expect(entregaEstimada('2026-10-20', 'diagnostico', true, '2026-10-24')!.vencida).toBe(true);
    expect(entregaEstimada('2026-10-24', 'diagnostico', true, '2026-10-24')!.vencida).toBe(false);
  });
  it('ignora valores que no son una fecha', () => {
    expect(entregaEstimada('mañana', 'recibida', true, '2026-10-24')).toBeNull();
  });
});

describe('token', () => {
  it('sólo se consulta lo que tiene forma de token', () => {
    expect(tokenConFormato('a'.repeat(43))).toBe(true);
    expect(tokenConFormato('A-_0'.repeat(10) + 'abc')).toBe(true);
    for (const x of ['', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}/`, `${'a'.repeat(42)}%`, `${'a'.repeat(42)} `, '1', null, undefined, 5]) expect(tokenConFormato(x)).toBe(false);
  });
});

const SIN_IMPORTE: PagoPublico = { situacion: 'sin_importe', total: null, abonado: null, pendiente: null, medio: null, medio_estado: null, transferencia_disponible: false, cuenta: null, verificacion: 'sin_importe', comprobantes: [], puede_enviar: false, limite_envio: null };
const OPC = { token: 'T'.repeat(43), nonce: 'nonce-de-prueba', aviso: null, claveEnvio: 'clave-de-prueba-123456' };
const datos = () => ({
  taller: 'Taller <b>Ñandú</b>',
  logo: false,
  cliente: 'Rosario Pérez' as string | null,
  numero: 87,
  estado: 'en_reparacion' as EstadoOT,
  patente: 'AB123CD',
  marca: 'Volkswagen',
  modelo: 'Amarok',
  fechaPrometida: '2026-10-30',
  fechaIngreso: '2026-10-20T10:00:00.000Z',
  mostrarFecha: true,
  zona: 'America/Argentina/Buenos_Aires',
});

describe('proyección pública', () => {
  const vis = [ev('recibida', '2026-10-20T10:00:00.000Z'), ev('diagnostico', '2026-10-21T10:00:00.000Z', 'recibida'), ev('en_reparacion', '2026-10-22T10:00:00.000Z', 'diagnostico')];
  it('sólo contiene lo que se muestra: nada de ids, notas, importes ni la patente completa', () => {
    const p = proyectar(datos(), vis, { texto: 'Hola', at: '2026-10-23T10:00:00.000Z' }, '2026-10-24', SIN_IMPORTE);
    expect(Object.keys(p).sort()).toEqual(['actualizado_at', 'cliente', 'entrega', 'estado', 'historial', 'mensaje', 'orden', 'pago', 'recorrido', 'taller', 'vehiculo', 'zona_horaria']);
    expect(p.cliente).toEqual({ nombre: 'Rosario Pérez' });
    const json = JSON.stringify(p);
    expect(json).not.toContain('AB123CD');
    expect(p.vehiculo.patente).toBe('AB•••CD');
    expect(p.orden.referencia).toBe('0087');
    expect(p.actualizado_at).toBe('2026-10-23T10:00:00.000Z');
    expect(p.historial.map((h) => h.titulo)).toEqual(['Reparación en curso', 'En diagnóstico', 'Vehículo recibido']);
    expect(p.entrega).toEqual({ fecha: '2026-10-30', vencida: false });
  });
  it('sin eventos visibles ni mensajes, la última actualización es el ingreso', () => {
    expect(proyectar(datos(), [], null, '2026-10-24', SIN_IMPORTE).actualizado_at).toBe('2026-10-20T10:00:00.000Z');
  });
  it('listo para retirar se destaca y quita la fecha estimada', () => {
    const p = proyectar({ ...datos(), estado: 'lista' }, [ev('lista', '2026-10-22T10:00:00.000Z', 'en_reparacion')], null, '2026-10-24', SIN_IMPORTE);
    expect(p.estado).toMatchObject({ clave: 'lista', listo: true, cerrado: false });
    expect(p.entrega).toBeNull();
  });
});

describe('página HTML', () => {
  const p = proyectar(datos(), [ev('recibida', '2026-10-20T10:00:00.000Z'), ev('en_reparacion', '2026-10-22T13:30:00.000Z', 'recibida')], { texto: 'Estamos esperando <script>alert(1)</script> el repuesto\nsegunda línea', at: '2026-10-23T10:00:00.000Z' }, '2026-10-24', SIN_IMPORTE);
  const html = paginaSeguimiento(p, OPC);

  it('escapa todo lo que viene de la base (nombre del taller y mensaje): no se puede inyectar HTML', () => {
    expect(html).not.toContain('<b>Ñandú</b>');
    expect(html).toContain('Taller &lt;b&gt;Ñandú&lt;/b&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(esc(`"'<>&`)).toBe('&quot;&#39;&lt;&gt;&amp;');
  });
  it('no carga nada externo, su único script es el propio (con nonce), no se indexa y no manda Referer', () => {
    expect(html).not.toMatch(/<link|<iframe|https?:\/\//i);
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain('<script nonce="nonce-de-prueba">');
    expect(html).not.toContain('<img'); // sin logotipo ni archivo elegido no hay imágenes en la página
    expect(html).not.toMatch(/\son[a-z]+=|javascript:/i);
    expect(html).toContain('noindex');
    expect(html).toContain('no-referrer');
    expect(html).toContain('viewport');
  });
  it('muestra el estado actual, el recorrido, la fecha como estimación y las horas en la zona del taller', () => {
    expect(html).toContain('En reparación');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('Es una estimación');
    expect(html).toContain('viernes 30 de octubre');
    expect(html).toContain('22/10/2026 · 10:30');
    expect(html).toContain('AB•••CD');
    expect(html).not.toContain('AB123CD');
  });
  it('una fecha vencida no se presenta como compromiso vigente', () => {
    const v = paginaSeguimiento(proyectar({ ...datos(), fechaPrometida: '2026-10-20' }, [ev('recibida', '2026-10-20T10:00:00.000Z')], null, '2026-10-24', SIN_IMPORTE), OPC);
    expect(v).toContain('Estaba prevista para el 20/10/2026');
    expect(v).toContain('ya pasó');
    expect(v).not.toContain('Es una estimación');
  });
  it('listo para retirar: mensaje destacado', () => {
    const l = paginaSeguimiento(proyectar({ ...datos(), estado: 'lista' }, [ev('lista', '2026-10-22T13:30:00.000Z', 'en_reparacion')], null, '2026-10-24', SIN_IMPORTE), OPC);
    expect(l).toContain('listo-aviso');
    expect(l).toContain('¡Tu vehículo está listo para retirar!');
  });
  it('la página de enlace no disponible no distingue entre inexistente, desactivado o reemplazado', () => {
    const n = paginaNoDisponible();
    expect(n).toContain('no está disponible');
    expect(n).not.toMatch(/desactiv.*porque|no existe/i);
  });
  it('fechas largas en español', () => {
    expect(fechaLarga('2026-01-01')).toBe('jueves 1 de enero');
  });
});

describe('código QR', () => {
  const url = 'https://taller.example/seguimiento/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP';
  it('es una matriz cuadrada con los tres patrones de posición', () => {
    const m = matrizQr(url);
    expect(m.length).toBeGreaterThanOrEqual(25);
    expect(m.every((f) => f.length === m.length)).toBe(true);
    for (const [r, c] of [[0, 0], [0, m.length - 7], [m.length - 7, 0]]) expect(m[r][c]).toBe(true);
  });
  it('el SVG sólo contiene la forma del código (la dirección no se incrusta como texto ni se agrega nada)', () => {
    const svg = svgQr(url);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).not.toContain('abcdefghijkl');
    expect(svg).not.toMatch(/<script|href=/i);
  });
});

describe('copia del cliente (PDF)', () => {
  const d: DatosHoja = {
    taller: { nombre: 'Mecánica Rodríguez', razonSocial: null, direccion: 'Av. San Martín 1234', telefono: '341 555-0100', email: null },
    logo: null,
    orden: { numero: 87, fechaApertura: '2026-10-24T17:35:00.000Z', fechaPrometida: '2026-10-27' },
    cliente: { visible: true, nombre: 'Marta Fernández', telefono: '341 600-1122' },
    vehiculo: { patente: 'AB123CD', marca: 'Volkswagen', modelo: 'Amarok', anio: 2019, km: 128450 },
    tecnico: { responsable: 'Julián', participantes: [] },
    motivo: 'MOTIVO-INTERNO', diagnostico: 'DIAGNOSTICO-INTERNO', observaciones: 'OBS-INTERNA', trabajos: [], repuestos: [], zonaHoraria: 'America/Argentina/Buenos_Aires', impresoAt: new Date('2026-10-24T18:00:00Z'),
  };
  const url = 'https://taller.example/seguimiento/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP';
  const { pdf, hojas } = generarHojaCliente(d, url);
  const texto = Buffer.from(pdf).toString('latin1');
  it('es un PDF de una hoja A4 con la dirección y el QR dibujado', () => {
    expect(hojas).toBe(1);
    expect(texto.startsWith('%PDF-1.4')).toBe(true);
    expect(texto).toContain('/MediaBox [0 0 595.28 841.89]');
    expect((texto.match(/ re\b/g) ?? []).length).toBeGreaterThan(100);
  });
  it('no lleva nombre ni teléfono del cliente, ni motivo, diagnóstico u observaciones', () => {
    for (const x of ['Marta', 'Fern', '600-1122', 'MOTIVO-INTERNO', 'DIAGNOSTICO-INTERNO', 'OBS-INTERNA', 'Juli']) expect(texto).not.toContain(x);
    expect(texto).toContain('COPIA PARA EL CLIENTE');
    expect(texto).toContain(String.raw`N\260 0087`);
  });
});
