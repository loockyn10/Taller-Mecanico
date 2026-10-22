// Resumen contable: los indicadores principales en lenguaje llano, sin necesidad de leer el libro diario.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fechaHora, money } from '@/lib/format';
import { Aviso, Boton, Cargando, ErrorCaja, Indicador, Tarjeta, useToast } from '@/components/ui';

export function ResumenContable({ desde, hasta, ir }: { desde: string; hasta: string; ir: (tab: 'controles' | 'resultados' | 'diario') => void }) {
  const { puede } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const { data: r, isLoading, error, refetch } = useQuery({ queryKey: ['contab', 'resumen', desde, hasta], queryFn: () => api.get(`/contabilidad/resumen-contable?desde=${desde}&hasta=${hasta}`) });
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  const p = r.proceso;
  const res = r.resultado;
  const actualizar = async () => {
    try {
      const x = await api.post('/contabilidad/sincronizar', {});
      toast.ok(x.creados ? `Se contabilizaron ${x.creados} operación(es)` : 'La contabilidad ya estaba al día');
      qc.invalidateQueries({ queryKey: ['contab'] });
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="space-y-5">
      {(p.controles_con_diferencia > 0 || p.errores > 0) && (
        <Aviso tono="rojo">
          Hay {p.errores > 0 ? `${p.errores} operación(es) que no se pudieron contabilizar` : `${p.controles_con_diferencia} control(es) con diferencias`}. Las cifras de abajo pueden no estar completas.{' '}
          <button className="font-semibold underline" onClick={() => ir('controles')}>Ver controles</button>
        </Aviso>
      )}
      {p.hay_mas && <Aviso tono="ambar">Todavía quedan operaciones por contabilizar (son muchas). Volvé a actualizar para continuar.</Aviso>}

      {res ? (
        <Tarjeta
          titulo="¿Cómo le fue al taller en el período?"
          subtitulo="Resultado económico: lo que se vendió menos lo que costó y lo que se gastó, se haya cobrado o pagado ya o no."
        >
          {res.calidad === 'parcial' && (
            <Aviso tono="ambar" className="mb-3">
              <strong>Resultado parcial.</strong> {res.motivos.join(' · ')}{' '}
              <button className="font-semibold underline" onClick={() => ir('resultados')}>Ver detalle</button>
            </Aviso>
          )}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Indicador titulo="Ventas netas" valor={money(res.ventas_netas)} detalle="Sin IVA ni devoluciones" tono="azul" />
            <Indicador titulo="Resultado bruto" valor={money(res.resultado_bruto)} detalle="Ventas − costo de lo vendido" tono="gris" />
            <Indicador titulo="Gastos" valor={money(res.gastos)} detalle="Alquiler, servicios, bancos…" tono="rojo" />
            <Indicador titulo={res.calidad === 'parcial' ? 'Resultado (parcial)' : 'Resultado del período'} valor={money(res.resultado)} tono={res.resultado >= 0 ? 'verde' : 'ambar'} detalle={res.calidad === 'parcial' ? 'Incompleto: ver aviso' : 'Base devengado'} />
          </div>
        </Tarjeta>
      ) : (
        <Aviso>Para ver los resultados económicos necesitás permiso para ver márgenes.</Aviso>
      )}

      <Tarjeta titulo="¿Qué tiene y qué debe hoy el taller?" subtitulo={`Saldos al ${hasta.split('-').reverse().join('/')}`}>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Indicador titulo="Dinero disponible" valor={money(r.posicion.disponibilidades)} detalle={`Caja ${money(r.posicion.caja)} · Bancos ${money(r.posicion.bancos)}`} tono="verde" />
          <Indicador titulo="Clientes nos deben" valor={money(r.posicion.por_cobrar)} detalle="Comprobantes sin cobrar" tono="azul" />
          <Indicador titulo="Debemos a proveedores" valor={money(r.posicion.por_pagar)} detalle="Incluye mercadería sin facturar" tono="rojo" />
          <Indicador titulo="Anticipos de clientes" valor={money(r.posicion.anticipos_clientes)} detalle="Dinero a favor: no es una venta" tono="ambar" />
          {r.posicion.inventario != null && <Indicador titulo="Inventario (contable)" valor={money(r.posicion.inventario)} detalle="Repuestos al costo" tono="gris" />}
          {r.posicion.cheques_en_cartera ? <Indicador titulo="Cheques en cartera" valor={money(r.posicion.cheques_en_cartera)} detalle="Recibidos, a depositar" tono="cian" /> : null}
        </div>
      </Tarjeta>

      <Tarjeta titulo="Dinero que entró y salió (flujo de caja)" subtitulo="No es lo mismo que el resultado: una venta a crédito no entra a la caja hasta que se cobra.">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Indicador titulo="Entradas" valor={money(r.flujo_caja.entradas)} tono="verde" detalle={`Cobrado ${money(r.flujo_caja.cobrado)}`} />
          <Indicador titulo="Salidas" valor={money(r.flujo_caja.salidas)} tono="rojo" detalle={`Proveedores ${money(r.flujo_caja.pagado_proveedores)} · Gastos ${money(r.flujo_caja.gastos)}`} />
          <Indicador titulo="Flujo neto" valor={money(r.flujo_caja.neto)} tono={r.flujo_caja.neto >= 0 ? 'azul' : 'ambar'} detalle="Entradas − salidas" />
        </div>
      </Tarjeta>

      <Tarjeta
        titulo="Estado de la contabilidad"
        acciones={puede('contabilidad.gestionar') ? <Boton tam="sm" icono={<RefreshCw className="size-4" />} onClick={actualizar}>Actualizar ahora</Boton> : undefined}
      >
        <dl className="grid grid-cols-2 gap-4 text-sm lg:grid-cols-4">
          <div><dt className="text-xs font-medium text-tenue">Asientos registrados</dt><dd className="mt-0.5 font-semibold tabular-nums">{p.asientos.total ?? 0}</dd></div>
          <div><dt className="text-xs font-medium text-tenue">Automáticos / manuales</dt><dd className="mt-0.5 tabular-nums">{p.asientos.automaticos ?? 0} / {p.asientos.manuales ?? 0}</dd></div>
          <div><dt className="text-xs font-medium text-tenue">Generados de operaciones anteriores</dt><dd className="mt-0.5 tabular-nums">{p.asientos.historicos ?? 0}</dd></div>
          <div><dt className="text-xs font-medium text-tenue">Última actualización</dt><dd className="mt-0.5">{p.ultima_corrida ? fechaHora(p.ultima_corrida.iniciada_at) : '—'}</dd></div>
        </dl>
        <p className="mt-3 text-xs text-tenue">
          Los asientos se generan solos a partir de ventas, cobros, compras, pagos, gastos y movimientos de caja y banco. Las operaciones anteriores a la contabilidad se contabilizaron una sola vez, con la fecha original, y están marcadas como históricas.{' '}
          <button className="underline" onClick={() => ir('diario')}>Ver libro diario</button>
        </p>
      </Tarjeta>
    </div>
  );
}
