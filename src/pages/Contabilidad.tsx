// Contabilidad de gestión: resumen, plan de cuentas, libro diario y mayor, balance de sumas y saldos, estado de resultados, controles de consistencia
// y los registros internos de caja, ventas y compras. Información contable y administrativa INTERNA: no son libros fiscales ni tienen validez ante ARCA.
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { fecha, hoyISO } from '@/lib/format';
import { Aviso, Encabezado, Pestanas } from '@/components/ui';
import { primerDiaMes, SelectorPeriodo } from '@/components/Periodo';
import { AVISO_INTERNO } from './contabilidad/comun';
import { ResumenContable } from './contabilidad/ResumenContable';
import { PlanCuentas } from './contabilidad/PlanCuentas';
import { LibroDiario } from './contabilidad/LibroDiario';
import { LibroMayor } from './contabilidad/LibroMayor';
import { Balance } from './contabilidad/Balance';
import { EstadoResultados } from './contabilidad/EstadoResultados';
import { Controles } from './contabilidad/Controles';
import { RegistrosInternos } from './contabilidad/RegistrosInternos';
import { ActivarContabilidad, AvisoSincronizacion, ConEstado, type EstadoContab } from './contabilidad/Estado';

type Tab = 'resumen' | 'plan' | 'diario' | 'mayor' | 'balance' | 'resultados' | 'controles' | 'registros';

export function Contabilidad() {
  return <ConEstado>{(estado) => <ContabilidadActivable estado={estado} />}</ConEstado>;
}

function ContabilidadActivable({ estado }: { estado: EstadoContab }) {
  const { puede } = useAuth();
  const [tab, setTab] = useState<Tab>('resumen');
  const [desde, setDesde] = useState(primerDiaMes());
  const [hasta, setHasta] = useState(hoyISO());
  const valido = desde <= hasta;
  const items: Array<{ clave: Tab; titulo: string }> = !estado.activada
    ? [
        { clave: 'resumen', titulo: 'Activación' },
        { clave: 'registros', titulo: 'Registros internos' },
      ]
    : [
    { clave: 'resumen', titulo: 'Resumen' },
    { clave: 'plan', titulo: 'Plan de cuentas' },
    { clave: 'diario', titulo: 'Libro diario' },
    { clave: 'mayor', titulo: 'Libro mayor' },
    { clave: 'balance', titulo: 'Balance de sumas y saldos' },
    ...(puede('margenes.ver') ? [{ clave: 'resultados' as const, titulo: 'Estado de resultados' }] : []),
    { clave: 'controles', titulo: 'Controles' },
    { clave: 'registros', titulo: 'Registros internos' },
      ];
  const ir = (t: 'controles' | 'resultados' | 'diario') => setTab(t === 'resultados' && !puede('margenes.ver') ? 'resumen' : t);
  return (
    <>
      <Encabezado titulo="Contabilidad" subtitulo="Plan de cuentas, asientos, libros, balance y resultados del taller, generados desde las operaciones" />
      <Aviso tono="ambar" className="no-print mb-4">{AVISO_INTERNO} No reemplazan los libros fiscales (IVA Ventas / IVA Compras) ni las declaraciones ante ARCA.</Aviso>
      <AvisoSincronizacion estado={estado} />
      <div className="no-print"><Pestanas items={items} activo={tab} onCambio={setTab} /></div>
      {!estado.activada && tab !== 'registros' ? <ActivarContabilidad estado={estado} /> : (
      <>
      {tab !== 'controles' && tab !== 'registros' && (
        <>
          <div className="no-print"><SelectorPeriodo desde={desde} hasta={hasta} onCambio={(d, h) => { setDesde(d); setHasta(h); }} /></div>
          <p className="mb-3 hidden text-sm print:block">Período: {fecha(desde)} al {fecha(hasta)}</p>
        </>
      )}
      {!valido && tab !== 'controles' ? <Aviso tono="ambar">Elegí un período válido.</Aviso> : tab === 'resumen' ? <ResumenContable desde={desde} hasta={hasta} ir={ir} />
        : tab === 'plan' ? <PlanCuentas hasta={hasta} />
        : tab === 'diario' ? <LibroDiario desde={desde} hasta={hasta} />
        : tab === 'mayor' ? <LibroMayor desde={desde} hasta={hasta} />
        : tab === 'balance' ? <Balance desde={desde} hasta={hasta} />
        : tab === 'resultados' ? <EstadoResultados desde={desde} hasta={hasta} />
        : tab === 'controles' ? <Controles />
        : (
          <>
            <div className="no-print"><SelectorPeriodo desde={desde} hasta={hasta} onCambio={(d, h) => { setDesde(d); setHasta(h); }} /></div>
            {valido ? <RegistrosInternos desde={desde} hasta={hasta} /> : <Aviso tono="ambar">Elegí un período válido.</Aviso>}
          </>
        )}
      </>
      )}
    </>
  );
}
