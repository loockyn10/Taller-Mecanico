// Puesta en marcha de un taller nuevo: pasos del asistente y horarios de atención.
// Ningún paso bloquea el uso del sistema: el taller queda operativo desde el primer ingreso y estos pasos solo lo ayudan a completar su configuración.

export const PASOS = [
  'negocio',
  'horarios',
  'deposito',
  'catalogo',
  'tarifas',
  'listas',
  'personal',
  'cobros',
  'importacion',
] as const;
export type Paso = (typeof PASOS)[number];
export const esPaso = (x: unknown): x is Paso => typeof x === 'string' && (PASOS as readonly string[]).includes(x);

export interface InfoPaso {
  titulo: string;
  /** Qué se configura, en una línea. */
  resumen: string;
  /** Cuánto importa: los recomendados conviene hacerlos antes de operar; los opcionales se pueden dejar para después. */
  recomendado: boolean;
}

export const INFO_PASOS: Record<Paso, InfoPaso> = {
  negocio: { titulo: 'Datos del negocio', resumen: 'Nombre, domicilio, CUIT, teléfono, correo y logo. Salen impresos en tus presupuestos y comprobantes.', recomendado: true },
  horarios: { titulo: 'Zona horaria y horarios de atención', resumen: 'Para que los fichajes y los turnos usen tu hora y tus días de trabajo.', recomendado: false },
  deposito: { titulo: 'Depósito principal y moneda', resumen: 'El lugar donde guardás los repuestos. Fierro trabaja en pesos argentinos.', recomendado: false },
  catalogo: { titulo: 'Categorías y servicios iniciales', resumen: 'Rubros de repuestos, tipos de gastos y operaciones de mano de obra para arrancar sin tipear todo.', recomendado: true },
  tarifas: { titulo: 'Mano de obra y precios de servicios', resumen: 'El valor de tu hora de trabajo. Con ella se calculan los precios de las operaciones del tempario.', recomendado: true },
  listas: { titulo: 'Listas de precios', resumen: 'Opcional: precios distintos para mayoristas, flotas o aseguradoras.', recomendado: false },
  personal: { titulo: 'Empleados y accesos', resumen: 'Sumá a tu equipo, elegí qué puede hacer cada uno y creá el PIN para fichar.', recomendado: false },
  cobros: { titulo: 'Caja, medios de cobro y bancos', resumen: 'Cómo cobrás y pagás, si exigís caja abierta y tus cuentas bancarias.', recomendado: true },
  importacion: { titulo: 'Traer tus datos', resumen: 'Cargá clientes, vehículos, artículos y proveedores desde Excel o CSV.', recomendado: false },
};

export type EstadoPaso = 'completo' | 'omitido' | 'pendiente';

export interface PasoCalculado {
  clave: Paso;
  estado: EstadoPaso;
  /** Cómo se llegó al estado: se detectó en los datos o lo marcó la persona. */
  origen: 'datos' | 'manual' | null;
  /** Qué falta o qué hay hecho, en lenguaje llano. */
  detalle: string;
}

// ───────────────────────── Horarios de atención ─────────────────────────

export const DIAS_SEMANA = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'] as const;

export interface Tramo {
  desde: string;
  hasta: string;
}
export interface DiaAtencion {
  /** 1 = lunes … 7 = domingo. */
  dia: number;
  abierto: boolean;
  /** Hasta dos tramos (por ejemplo, mañana y tarde). */
  tramos: Tramo[];
}
export interface HorariosAtencion {
  dias: DiaAtencion[];
}

export const horariosPorDefecto = (): HorariosAtencion => ({
  dias: DIAS_SEMANA.map((_, i) => ({
    dia: i + 1,
    abierto: i < 6,
    tramos: i < 5 ? [{ desde: '08:00', hasta: '18:00' }] : i === 5 ? [{ desde: '08:00', hasta: '13:00' }] : [],
  })),
});

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const esHoraValida = (x: string) => HHMM.test(x);

/** Devuelve el primer problema de los horarios o null si están bien. */
export function validarHorarios(h: HorariosAtencion): string | null {
  if (h.dias.length !== 7) return 'Faltan días en los horarios';
  for (const [i, d] of h.dias.entries()) {
    if (d.dia !== i + 1) return 'Los días deben ir de lunes a domingo';
    if (d.tramos.length > 2) return `${DIAS_SEMANA[i]}: como máximo dos franjas por día`;
    if (d.abierto && !d.tramos.length) return `${DIAS_SEMANA[i]}: indicá el horario o marcá el día como cerrado`;
    let ultimo = '';
    for (const t of d.tramos) {
      if (!esHoraValida(t.desde) || !esHoraValida(t.hasta)) return `${DIAS_SEMANA[i]}: hora inválida`;
      if (t.hasta <= t.desde) return `${DIAS_SEMANA[i]}: la hora de cierre debe ser posterior a la de apertura`;
      if (ultimo && t.desde < ultimo) return `${DIAS_SEMANA[i]}: las franjas se superponen`;
      ultimo = t.hasta;
    }
  }
  return null;
}

/** Texto corto para mostrar los horarios ("Lun a Vie 08:00–18:00 · Sáb 08:00–13:00"). */
export function resumenHorarios(h: HorariosAtencion): string {
  const abreviado = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
  const texto = (d: DiaAtencion) => (d.abierto ? d.tramos.map((t) => `${t.desde}–${t.hasta}`).join(' y ') : 'cerrado');
  const grupos: Array<{ desde: number; hasta: number; t: string }> = [];
  h.dias.forEach((d, i) => {
    const t = texto(d);
    const ult = grupos[grupos.length - 1];
    if (ult && ult.t === t && ult.hasta === i - 1) ult.hasta = i;
    else grupos.push({ desde: i, hasta: i, t });
  });
  return grupos
    .filter((g) => g.t !== 'cerrado')
    .map((g) => `${g.desde === g.hasta ? abreviado[g.desde] : `${abreviado[g.desde]} a ${abreviado[g.hasta]}`} ${g.t}`)
    .join(' · ');
}

/** Tamaño máximo del logo (en caracteres del data URL ≈ 200 KB de imagen). */
export const LOGO_MAX_CHARS = 280_000;
export const LOGO_TIPOS = ['png', 'jpeg', 'webp'] as const;
