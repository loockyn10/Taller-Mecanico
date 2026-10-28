// Sprint 25 · Pago del cliente desde el portal: estados, formatos de importe, validación del contenido real de los comprobantes (JPG/PNG/WEBP/PDF) y la sección de pago de la página pública.
import { describe, expect, it } from 'vitest';
import { LIMITES_COMPROBANTE, detallePagoCliente, dineroAR, estadoPagoCliente, extensionDe, nombreVisible } from '../../shared/pago-portal';
import { validarComprobante, claveComprobante } from '../../worker/lib/comprobantes';
import { paginaSeguimiento, AVISOS, codigoPortal } from '../../worker/lib/seguimiento-html';
import { proyectar } from '../../worker/lib/seguimiento';
import type { PagoPublico } from '../../worker/lib/pago-cliente';

import { jpeg, pdf, png, tiene, webp } from '../fixtures/archivos';

describe('importes y nombres', () => {
  it('dineroAR: pesos con puntos de miles, centavos sólo si los hay', () => {
    expect(dineroAR(28_500_000)).toBe('$285.000');
    expect(dineroAR(28_500_050)).toBe('$285.000,50');
    expect(dineroAR(0)).toBe('$0');
    expect(dineroAR(99)).toBe('$0,99');
    expect(dineroAR(123_456_789_00)).toBe('$123.456.789');
  });
  it('nombreVisible: sin directorios ni caracteres de control o de dirección de texto; nunca vacío', () => {
    expect(nombreVisible('C:\\Users\\Ana\\captura.png')).toBe('captura.png');
    expect(nombreVisible('../../etc/passwd')).toBe('passwd');
    expect(nombreVisible('a\u202Eb\u0000c.jpg')).toBe('abc.jpg');
    expect(nombreVisible('x'.repeat(200))).toHaveLength(80);
    expect(nombreVisible('   ')).toBeNull();
    expect(nombreVisible(undefined)).toBeNull();
  });
  it('extensionDe', () => {
    expect(extensionDe('Foto.JPG')).toBe('jpg');
    expect(extensionDe('sin_extension')).toBeNull();
    expect(extensionDe(null)).toBeNull();
  });
  it('la clave del objeto en R2 sale del taller y del id interno, jamás del nombre del archivo', () => {
    expect(claveComprobante('taller-1', 'cp-9')).toBe('comprobantes/taller-1/cp-9');
  });
});

describe('estado del pago del cliente (separado del estado de la reparación)', () => {
  const base = { importeConfirmado: true, total: 28_500_000, pendiente: 28_500_000, abonado: 0, eleccion: null, comprobantes: [] as Array<{ estado: 'pendiente' | 'confirmado' | 'rechazado' | 'subiendo'; at: string }> };
  const e = (medio: 'efectivo' | 'transferencia', estado: 'seleccionado' | 'confirmado', at: string) => ({ medio, estado, at });
  it('recorre los cinco estados', () => {
    expect(estadoPagoCliente({ ...base, importeConfirmado: false })).toBe('sin_importe');
    expect(estadoPagoCliente(base)).toBe('pendiente_de_pago');
    expect(estadoPagoCliente({ ...base, eleccion: e('efectivo', 'confirmado', '2026-10-28T10:00:00Z') })).toBe('medio_seleccionado');
    expect(estadoPagoCliente({ ...base, eleccion: e('transferencia', 'seleccionado', '2026-10-28T10:00:00Z'), comprobantes: [{ estado: 'pendiente', at: '2026-10-28T10:05:00Z' }] })).toBe('comprobante_recibido');
    expect(estadoPagoCliente({ ...base, eleccion: e('transferencia', 'seleccionado', '2026-10-28T10:00:00Z'), comprobantes: [{ estado: 'rechazado', at: '2026-10-28T10:05:00Z' }] })).toBe('comprobante_rechazado');
    expect(estadoPagoCliente({ ...base, pendiente: 0, abonado: 28_500_000 })).toBe('cobro_confirmado');
  });
  it('un comprobante pendiente nunca equivale a pagado; un rechazo posterior a una elección nueva deja de mandar', () => {
    expect(estadoPagoCliente({ ...base, comprobantes: [{ estado: 'pendiente', at: '2026-10-28T10:05:00Z' }] })).not.toBe('cobro_confirmado');
    expect(estadoPagoCliente({ ...base, eleccion: e('efectivo', 'seleccionado', '2026-10-28T11:00:00Z'), comprobantes: [{ estado: 'rechazado', at: '2026-10-28T10:05:00Z' }] })).toBe('medio_seleccionado');
  });
  it('un total en cero no es «cobrado»', () => {
    expect(estadoPagoCliente({ ...base, total: 0, pendiente: 0, abonado: 0, importeConfirmado: false })).toBe('sin_importe');
  });
  it('detalle para el personal: efectivo previsto / pendiente de cobro', () => {
    const el = { medio: 'efectivo' as const, estado: 'confirmado' as const, at: '2026-10-28T10:00:00Z' };
    expect(detallePagoCliente('medio_seleccionado', el)).toBe('Pago previsto en efectivo · Pendiente de cobro');
    expect(detallePagoCliente('comprobante_recibido', null)).toBe('Comprobante pendiente de verificación');
  });
});

describe('validación del contenido real del comprobante', () => {
  it('acepta JPEG y lo reescribe sin metadatos (EXIF/GPS)', () => {
    const r = validarComprobante(jpeg(), 'captura.jpg');
    expect(r.mime).toBe('image/jpeg');
    expect(tiene(r.bytes, 'GPSLATITUDE')).toBe(false);
  });
  it('acepta PNG válido y descarta sus textos y metadatos', () => {
    const origen = png(true);
    expect(tiene(origen, 'LATITUDE')).toBe(true);
    const r = validarComprobante(origen, 'captura.PNG');
    expect(r.mime).toBe('image/png');
    expect(tiene(r.bytes, 'LATITUDE')).toBe(false);
    expect(r.bytes.length).toBeLessThan(origen.length);
    expect(() => validarComprobante(r.bytes, null)).not.toThrow(); // lo reescrito sigue siendo un PNG válido
  });
  it('acepta WEBP y le quita el EXIF', () => {
    const r = validarComprobante(webp(true), 'x.webp');
    expect(r.mime).toBe('image/webp');
    expect(tiene(r.bytes, 'GPSLATITUDE')).toBe(false);
  });
  it('acepta un PDF común', () => {
    expect(validarComprobante(pdf(), 'comprobante.pdf')).toMatchObject({ mime: 'application/pdf' });
  });
  it('el formato lo decide el contenido, no el nombre: un JPEG llamado .png se acepta como JPEG; un ejecutable con nombre de imagen se rechaza', () => {
    expect(validarComprobante(jpeg(), 'engano.png').mime).toBe('image/jpeg');
    expect(() => validarComprobante(new TextEncoder().encode('MZ\x90\x00 programa'), 'virus.jpg')).toThrow();
    expect(() => validarComprobante(new TextEncoder().encode('<html><script>alert(1)</script>'), 'pagina.png')).toThrow();
    expect(() => validarComprobante(new TextEncoder().encode('GIF89a....'), 'animado.gif')).toThrow();
  });
  it('rechaza extensiones no permitidas aunque el contenido sea una imagen', () => {
    for (const n of ['x.exe', 'x.svg', 'x.html', 'x.gif', 'x.jpg.exe', 'x.zip']) expect(() => validarComprobante(jpeg(), n)).toThrow();
    expect(() => validarComprobante(jpeg(), 'sin-extension')).not.toThrow(); // algunos teléfonos no mandan extensión
  });
  it('rechaza archivos vacíos, cortados, dañados o con estructura inválida', () => {
    expect(() => validarComprobante(new Uint8Array(), 'a.jpg')).toThrow();
    expect(() => validarComprobante(jpeg().slice(0, 60), 'a.jpg')).toThrow();
    expect(() => validarComprobante(png().slice(0, 60), 'a.png')).toThrow();
    expect(() => validarComprobante(png(true, 300, 200, true), 'a.png')).toThrow(); // CRC roto
    expect(() => validarComprobante(pdf().slice(0, 30), 'a.pdf')).toThrow(); // sin %%EOF
    expect(() => validarComprobante(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), 'a.png')).toThrow();
  });
  it('rechaza PDF con contenido activo o incrustado', () => {
    for (const extra of ['/S /JavaScript /JS (app.alert(1))', '/S /Launch /F (cmd.exe)', '/Type /EmbeddedFile', '/Subtype /RichMedia']) {
      expect(() => validarComprobante(pdf(extra), 'a.pdf'), extra).toThrow(/no permitidos/);
    }
    expect(() => validarComprobante(pdf('/Name /JavaScriptoso'), 'a.pdf')).not.toThrow(); // otro nombre que sólo empieza igual
  });
  it('límites de peso: 8 MB para imágenes y 5 MB para PDF (413)', () => {
    const grande = jpeg(LIMITES_COMPROBANTE.imagenBytes + 10);
    expect(() => validarComprobante(grande, 'a.jpg')).toThrow(/máximo/);
    const pdfGrande = new Uint8Array(LIMITES_COMPROBANTE.pdfBytes + 1);
    pdfGrande.set(pdf());
    try { validarComprobante(pdfGrande, 'a.pdf'); throw new Error('debía fallar'); } catch (e: any) { expect(e.status).toBe(413); }
  });
  it('rechaza imágenes con dimensiones absurdas', () => {
    expect(() => validarComprobante(jpeg(100, false, 20_000, 20_000), 'a.jpg')).toThrow();
    expect(() => validarComprobante(png(false, 30_000, 10), 'a.png')).toThrow();
  });
});

// ───────── Sección de pago de la página pública ─────────
const datos = () => ({
  taller: 'Taller Ñandú', logo: false, cliente: 'Rosario Pérez' as string | null, numero: 87, estado: 'lista' as const, patente: 'AB123CD', marca: 'Volkswagen', modelo: 'Amarok',
  fechaPrometida: null, fechaIngreso: '2026-10-20T10:00:00.000Z', mostrarFecha: true, zona: 'America/Argentina/Buenos_Aires',
});
const OPC = { token: 'T'.repeat(43), nonce: 'nonce-x', aviso: null as ReturnType<typeof codigoPortal>, claveEnvio: 'clave-envio-1234567890' };
const pago = (p: Partial<PagoPublico>): PagoPublico => ({
  situacion: 'pendiente', total: 28_500_000, abonado: 0, pendiente: 28_500_000, medio: null, medio_estado: null, transferencia_disponible: true, cuenta: null, verificacion: 'pendiente_de_pago',
  comprobantes: [], puede_enviar: false, limite_envio: null, ...p,
});
const pagina = (p: PagoPublico, opc = OPC, d = datos()) => paginaSeguimiento(proyectar(d, [], null, '2026-10-24', p), opc);
/** Sólo el contenido visible (sin hoja de estilos ni script): las búsquedas de texto no deben toparse con el CSS. */
const visible = (h: string) => h.slice(h.indexOf('<main>'), h.indexOf('<script'));
const CUENTA = { titular: 'Taller Ñandú S.R.L.', banco: 'Banco Provincia', alias: 'ñandu.taller.mp', cbu: '0140000000000000000012' };

describe('página pública · resumen de pago', () => {
  it('sin importe confirmado: lo dice y no ofrece pagar ni muestra $0', () => {
    const h = pagina(pago({ situacion: 'sin_importe', total: null, abonado: null, pendiente: null, transferencia_disponible: false, verificacion: 'sin_importe' }));
    expect(h).toContain('Importe pendiente de confirmación por el taller');
    expect(h).not.toContain('$0');
    expect(h).not.toContain('¿Cómo querés pagar?');
    expect(h).not.toContain('type="file"');
    expect(h).not.toContain('/medio');
  });
  it('con importe: total y saldo globales, sin desglose', () => {
    const h = pagina(pago({}));
    expect(h).toContain('Importe total de la reparación');
    expect(h).toContain('$285.000');
    expect(h).toContain('Saldo pendiente');
    expect(h).not.toMatch(/Mano de obra|Repuestos|Cantidad|Precio|Costo|Margen/i);
    expect(h).toContain('¿Cómo querés pagar?');
  });
  it('pagos parciales: total, abonado y pendiente (sin discriminar cada cobro)', () => {
    const h = pagina(pago({ abonado: 10_000_000, pendiente: 18_500_000 }));
    expect(h).toContain('$285.000');
    expect(h).toContain('Abonado');
    expect(h).toContain('$100.000');
    expect(h).toContain('$185.000');
  });
  it('dos botones con estado de selección; sin cuenta receptora no se ofrece la transferencia', () => {
    const con = pagina(pago({}));
    expect(con).toContain('value="efectivo"');
    expect(con).toContain('value="transferencia"');
    expect(con).toContain('aria-pressed="false"');
    const sin = pagina(pago({ transferencia_disponible: false }));
    expect(sin).toContain('value="efectivo"');
    expect(sin).not.toContain('value="transferencia"');
  });
  it('efectivo elegido: avisa que se paga al retirar y ofrece confirmar la intención (no un pago)', () => {
    const h = pagina(pago({ medio: 'efectivo', medio_estado: 'seleccionado', verificacion: 'medio_seleccionado' }));
    expect(h).toContain('Podés pagar en efectivo al retirar tu vehículo');
    expect(h).toContain('Confirmar pago en efectivo');
    expect(h).toContain('aria-pressed="true"');
    expect(h).toContain('No es un pago');
    expect(h).not.toContain('type="file"');
    const c = pagina(pago({ medio: 'efectivo', medio_estado: 'confirmado', verificacion: 'medio_seleccionado' }));
    expect(c).not.toContain('value="confirmar_efectivo"');
    expect(c).toContain('todavía no figura como pagado');
  });
  it('transferencia: importe, datos del taller (titular, banco, alias, CBU), copiar alias y subir comprobante', () => {
    const h = pagina(pago({ medio: 'transferencia', medio_estado: 'seleccionado', cuenta: CUENTA, puede_enviar: true, verificacion: 'medio_seleccionado' }));
    expect(h).toContain('Transferencia bancaria');
    expect(h).toContain('Importe pendiente');
    for (const x of ['Taller Ñandú S.R.L.', 'Banco Provincia', 'ñandu.taller.mp', '0140000000000000000012']) expect(h).toContain(x);
    expect(h).toContain('data-copiar="ñandu.taller.mp"');
    expect(h).toContain('Copiar alias');
    expect(h).toContain('Adjuntar comprobante de transferencia');
    expect(h).toContain('type="file"');
    expect(h).toContain('accept="image/jpeg,image/png,image/webp,application/pdf');
    expect(h).toContain('Enviar comprobante');
    expect(h).toContain('enctype="multipart/form-data"');
    expect(h).toContain('value="clave-envio-1234567890"');
    expect(h).toContain('action="/seguimiento/' + 'T'.repeat(43) + '/comprobante"');
  });
  it('comprobante recibido: «pendiente de verificación», nunca «pagado»', () => {
    const h = pagina(pago({ medio: 'transferencia', cuenta: CUENTA, verificacion: 'comprobante_recibido', comprobantes: [{ estado: 'pendiente', at: '2026-10-28T13:00:00.000Z', motivo: null }] }));
    expect(h).toContain('Comprobante recibido — pendiente de verificación');
    expect(h).toContain('El taller tiene que confirmar que recibió el dinero');
    expect(h).not.toContain('La reparación está paga');
    expect(h).toContain('$285.000');
  });
  it('comprobante rechazado: muestra el motivo (escapado) y permite enviar otro', () => {
    const h = pagina(pago({ medio: 'transferencia', cuenta: CUENTA, puede_enviar: true, verificacion: 'comprobante_rechazado', comprobantes: [{ estado: 'rechazado', at: '2026-10-28T13:00:00.000Z', motivo: 'No figura <b>en la cuenta</b>' }] }));
    expect(h).toContain('Tu último comprobante fue rechazado');
    expect(h).toContain('No figura &lt;b&gt;en la cuenta&lt;/b&gt;');
    expect(h).not.toContain('<b>en la cuenta</b>');
    expect(h).toContain('Podés enviar otro');
    expect(h).toContain('type="file"');
  });
  it('saldado: sin botones de pago ni formulario', () => {
    const h = pagina(pago({ situacion: 'saldado', abonado: 28_500_000, pendiente: 0, verificacion: 'cobro_confirmado' }));
    expect(h).toContain('La reparación está paga');
    expect(h).not.toContain('¿Cómo querés pagar?');
    expect(h).not.toContain('type="file"');
  });
  it('orden cancelada: no hay sección de pago', () => {
    expect(visible(pagina(pago({ situacion: 'cancelada', total: null, abonado: null, pendiente: null })))).not.toContain('Resumen de pago');
  });
  it('escapa los datos bancarios y los avisos solo se muestran si son códigos conocidos', () => {
    const h = pagina(pago({ medio: 'transferencia', cuenta: { ...CUENTA, titular: '<img src=x onerror=alert(1)>', alias: 'a"b' }, puede_enviar: true }));
    expect(h).not.toContain('<img src=x');
    expect(h).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(h).toContain('data-copiar="a&quot;b"');
    expect(codigoPortal('comprobante_ok')).toBe('comprobante_ok');
    expect(codigoPortal('<script>')).toBeNull();
    expect(codigoPortal('__proto__')).toBeNull();
    expect(codigoPortal('toString')).toBeNull();
    expect(pagina(pago({}), { ...OPC, aviso: 'comprobante_ok' })).toContain(AVISOS.comprobante_ok.texto.slice(0, 30));
  });
});

describe('página pública · encabezado y pie', () => {
  it('el taller es el protagonista: nombre y cliente de la OT; sin logotipo cargado, monograma (no el de Orvelan)', () => {
    const h = pagina(pago({}));
    expect(h).toContain('<p class="n">Taller Ñandú</p>');
    expect(h).toContain('Cliente: <b>Rosario Pérez</b>');
    expect(h).toContain('class="logo mono"');
    // El encabezado nunca lleva la marca de Orvelan.
    const cabecera = h.slice(h.indexOf('<header'), h.indexOf('</header>'));
    expect(cabecera).not.toMatch(/orvelan|<svg/i);
  });
  it('con logotipo propio lo pide con el mismo token y sin dejar rastro del cliente en la imagen', () => {
    const h = pagina(pago({}), OPC, { ...datos(), logo: true });
    expect(h).toContain('<img class="logo" src="/seguimiento/' + 'T'.repeat(43) + '/logo"');
  });
  it('«Consumidor final»: no se muestra nombre de cliente', () => {
    expect(pagina(pago({}), OPC, { ...datos(), cliente: null })).not.toContain('Cliente:');
  });
  it('el pie es discreto: «Gestionado con ORVELAN», logotipo acotado a ≤ 100 px, sin enlaces ni anuncios', () => {
    const h = pagina(pago({}));
    const pie = h.slice(h.indexOf('<footer'), h.indexOf('</footer>'));
    expect(pie).toContain('Gestionado con <b>ORVELAN</b>');
    expect(pie).toContain('Software de gestión para talleres.');
    expect(pie).toContain('width="20"');
    expect(pie).not.toContain('width="455"');
    expect(pie).not.toContain('<a ');
    expect(h).toMatch(/footer\.orvelan svg\{[^}]*width:20px[^}]*max-width:100px/);
    expect(h).not.toMatch(/footer\.orvelan svg\{[^}]*width:(?:[2-9]\d\d|\d{4})px/);
  });
  it('no muestra datos personales del cliente ni de otros', () => {
    const h = visible(pagina(pago({})));
    expect(h).not.toMatch(/DNI|CUIT|tel[eé]fono|@|direcci[oó]n/i);
  });
});
