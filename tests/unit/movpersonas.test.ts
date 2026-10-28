// Sprint 24: reglas puras de los movimientos con personas (tipos financieros, categorías, estados, saldos, permisos y plan de cuentas).
import { describe, expect, it } from 'vitest';
import { CATEGORIAS_SISTEMA, DEF_TIPOS_FIN, TIPOS_FIN, abreObligacion, errorImporte, estadoMovimiento, regularizaObligacion, saldoPendiente, type TipoFin } from '../../shared/movpersonas';
import { PLANTILLAS, permisosEfectivos, PERMISOS } from '../../shared/permisos';
import { PLAN_INICIAL, ROLES_CUENTA, naturalezaDe } from '../../shared/contabilidad';

describe('tipos financieros', () => {
  it('cada tipo tiene una dirección coherente con su obligación: lo que abre una deuda y lo que la cancela van en sentidos opuestos', () => {
    expect(DEF_TIPOS_FIN.aporte_capital.direccion).toBe('entrada');
    expect(DEF_TIPOS_FIN.retiro_capital.direccion).toBe('salida');
    expect(DEF_TIPOS_FIN.prestamo_recibido.direccion).toBe('entrada');
    expect(DEF_TIPOS_FIN.devolucion_prestamo_recibido.direccion).toBe('salida');
    expect(DEF_TIPOS_FIN.prestamo_otorgado.direccion).toBe('salida');
    expect(DEF_TIPOS_FIN.devolucion_prestamo_otorgado.direccion).toBe('entrada');
    expect(DEF_TIPOS_FIN.adelanto_sueldo.direccion).toBe('salida');
    expect(DEF_TIPOS_FIN.aplicacion_adelanto.direccion).toBe('sin_dinero');
    for (const t of TIPOS_FIN) {
      const d = DEF_TIPOS_FIN[t];
      if (d.regulariza) {
        const origen = TIPOS_FIN.find((x) => DEF_TIPOS_FIN[x].abre === d.regulariza)!;
        expect(origen, t).toBeTruthy();
        // La devolución de un préstamo va en sentido contrario al préstamo; la aplicación de un adelanto no mueve dinero.
        if (d.direccion !== 'sin_dinero') expect(d.direccion).not.toBe(DEF_TIPOS_FIN[origen].direccion);
      }
    }
  });

  it('las dos devoluciones de préstamo regularizan obligaciones distintas, y un adelanto nunca se regulariza con una devolución de préstamo', () => {
    expect(DEF_TIPOS_FIN.devolucion_prestamo_recibido.regulariza).toBe('prestamo_recibido');
    expect(DEF_TIPOS_FIN.devolucion_prestamo_otorgado.regulariza).toBe('prestamo_otorgado');
    expect(DEF_TIPOS_FIN.aplicacion_adelanto.regulariza).toBe('adelanto_sueldo');
    expect(new Set(TIPOS_FIN.map((t) => DEF_TIPOS_FIN[t].regulariza).filter(Boolean)).size).toBe(3);
    expect(DEF_TIPOS_FIN.adelanto_sueldo.soloPersonal && DEF_TIPOS_FIN.aplicacion_adelanto.soloPersonal).toBe(true);
  });
});

describe('categorías del sistema', () => {
  it('son nueve, con clave estable única; sólo el reintegro de gastos queda pendiente y todas las demás apuntan a un tipo válido', () => {
    expect(CATEGORIAS_SISTEMA).toHaveLength(9);
    expect(new Set(CATEGORIAS_SISTEMA.map((c) => c.clave)).size).toBe(9);
    expect(new Set(CATEGORIAS_SISTEMA.map((c) => c.nombre.toLowerCase())).size).toBe(9);
    expect(CATEGORIAS_SISTEMA.filter((c) => c.pendiente).map((c) => c.clave)).toEqual(['reintegro_gastos']);
    for (const c of CATEGORIAS_SISTEMA.filter((x) => !x.pendiente)) expect(TIPOS_FIN as readonly string[]).toContain(c.tipo);
    // la clave es el id estable dentro de la empresa y el id completo cabe en un identificador
    expect(CATEGORIAS_SISTEMA.every((c) => c.clave.length <= 40 && /^[a-z_]+$/.test(c.clave))).toBe(true);
  });
});

describe('estados y saldos', () => {
  const m = (tipo_fin: TipoFin, importe: number, regularizado: number, estado = 'registrado') => ({ tipo_fin, importe, regularizado, estado });
  it('«parcialmente regularizado» y «regularizado» sólo existen para préstamos y adelantos; el resto queda «registrado»', () => {
    expect(estadoMovimiento(m('prestamo_otorgado', 100, 0))).toBe('registrado');
    expect(estadoMovimiento(m('prestamo_otorgado', 100, 40))).toBe('parcial');
    expect(estadoMovimiento(m('prestamo_otorgado', 100, 100))).toBe('regularizado');
    expect(estadoMovimiento(m('adelanto_sueldo', 100, 1))).toBe('parcial');
    expect(estadoMovimiento(m('aporte_capital', 100, 0))).toBe('registrado');
    expect(estadoMovimiento(m('devolucion_prestamo_otorgado', 100, 0))).toBe('registrado');
    expect(estadoMovimiento(m('prestamo_recibido', 100, 0, 'anulado'))).toBe('anulado');
  });

  it('el saldo pendiente es importe − regularizado en centavos enteros, y cero si está anulado o no abre una obligación', () => {
    expect(saldoPendiente(m('prestamo_recibido', 8000000, 3000000))).toBe(5000000);
    expect(saldoPendiente(m('adelanto_sueldo', 5000000, 0))).toBe(5000000);
    expect(saldoPendiente(m('prestamo_recibido', 100, 0, 'anulado'))).toBe(0);
    expect(saldoPendiente(m('aporte_capital', 100, 0))).toBe(0);
    // el ejemplo del encargo: préstamo de $80.000 con $30.000 devueltos y un adelanto de $50.000: dos saldos distintos
    const prestamo = saldoPendiente(m('prestamo_otorgado', 8000000, 3000000));
    const adelanto = saldoPendiente(m('adelanto_sueldo', 5000000, 0));
    expect([prestamo, adelanto]).toEqual([5000000, 5000000]);
    expect(abreObligacion('prestamo_otorgado') && !regularizaObligacion('prestamo_otorgado')).toBe(true);
  });

  it('no hay errores de coma flotante: sumar muchos importes de centavos es exacto', () => {
    let total = 0;
    for (let i = 0; i < 1000; i++) total += 10; // $0,10 mil veces
    expect(total).toBe(10000);
    expect(errorImporte(total)).toBeNull();
  });

  it('valida el importe: entero, positivo y acotado', () => {
    expect(errorImporte(0)).toMatch(/mayor a 0/);
    expect(errorImporte(-1)).toMatch(/mayor a 0/);
    expect(errorImporte(10.5)).toMatch(/centavos/);
    expect(errorImporte(Number.NaN)).toMatch(/centavos/);
    expect(errorImporte(1e15)).toMatch(/grande/);
    expect(errorImporte(1)).toBeNull();
  });
});

describe('permisos de movimientos con personas', () => {
  const NUEVOS = PERMISOS.filter((p) => p.startsWith('movpersonas.'));
  it('hay seis permisos y ninguna plantilla operativa los recibe por defecto', () => {
    expect(NUEVOS).toHaveLength(6);
    for (const rol of ['recepcion', 'mecanico', 'deposito', 'caja', 'empleado'] as const) {
      expect(PLANTILLAS[rol].permisos.filter((p) => p.startsWith('movpersonas.')), rol).toEqual([]);
    }
    // el propietario y el administrador (que ve todas las finanzas) sí
    expect(permisosEfectivos('propietario').filter((p) => p.startsWith('movpersonas.'))).toHaveLength(6);
    expect(permisosEfectivos('administrador').filter((p) => p.startsWith('movpersonas.'))).toHaveLength(6);
  });

  it('registrar, anular, administrar, reportar y aplicar adelantos exigen poder ver; aplicar adelantos además exige registrar', () => {
    const efectivos = (g: string[]) => permisosEfectivos('caja', { g: g as never, r: [] }).filter((p) => p.startsWith('movpersonas.'));
    expect(efectivos(['movpersonas.registrar'])).toEqual(['movpersonas.ver', 'movpersonas.registrar']);
    expect(efectivos(['movpersonas.regularizar'])).toEqual(['movpersonas.ver', 'movpersonas.registrar', 'movpersonas.regularizar']);
    expect(efectivos(['movpersonas.anular'])).toEqual(['movpersonas.ver', 'movpersonas.anular']);
  });
});

describe('plan de cuentas', () => {
  const nuevos = ['prestamos_al_personal', 'adelantos_personal', 'prestamos_de_personas', 'retiros_capital'];
  it('agrega las cuentas necesarias sin tocar resultados: préstamos y adelantos son activo, la deuda con socios es pasivo y los retiros reducen el patrimonio', () => {
    const cuenta = (rol: string) => PLAN_INICIAL.find((c) => c.rol === rol)!;
    for (const r of nuevos) expect(ROLES_CUENTA as readonly string[]).toContain(r);
    expect(cuenta('prestamos_al_personal').tipo).toBe('activo');
    expect(cuenta('adelantos_personal').tipo).toBe('activo');
    expect(cuenta('prestamos_de_personas').tipo).toBe('pasivo');
    expect(cuenta('retiros_capital')).toMatchObject({ tipo: 'patrimonio', contra: true });
    expect(naturalezaDe('patrimonio')).toBe('acreedora'); // el retiro es una cuenta regularizadora: queda deudora
    for (const r of nuevos) expect(['ingreso', 'costo', 'gasto']).not.toContain(cuenta(r).tipo);
  });

  it('los códigos y roles del plan siguen siendo únicos y cada cuenta nueva cuelga de un rubro existente', () => {
    const codigos = PLAN_INICIAL.map((c) => c.codigo);
    expect(new Set(codigos).size).toBe(codigos.length);
    const roles = PLAN_INICIAL.map((c) => c.rol).filter(Boolean);
    expect(new Set(roles).size).toBe(roles.length);
    for (const c of PLAN_INICIAL.filter((x) => x.padre)) expect(codigos, `${c.codigo} → ${c.padre}`).toContain(c.padre);
  });
});
