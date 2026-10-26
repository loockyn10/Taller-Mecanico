// Controles de consistencia: contabilidad contra cuentas corrientes, caja, bancos, cheques e inventario. Solo informan: nunca generan movimientos para cuadrar saldos.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Info, AlertTriangle, XCircle, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fechaHora, money } from '@/lib/format';
import { Aviso, Boton, Cargando, ErrorCaja, TablaApilable, Tarjeta, useToast } from '@/components/ui';

const ESTADO = {
  ok: { icono: <CheckCircle2 className="size-5 text-emerald-600" />, borde: 'border-emerald-200' },
  diferencia: { icono: <XCircle className="size-5 text-red-600" />, borde: 'border-red-300 bg-red-50/40' },
  aviso: { icono: <AlertTriangle className="size-5 text-amber-600" />, borde: 'border-amber-300 bg-amber-50/40' },
  info: { icono: <Info className="size-5 text-sky-600" />, borde: 'border-borde' },
} as const;

function Items({ c }: { c: any }) {
  if (!c.items?.length) return null;
  if (c.clave === 'cobertura')
    return (
      <TablaApilable>
        <table className="w-full text-xs">
          <thead><tr className="text-left text-tenue"><th className="py-1 pr-3">Operación</th><th className="px-2 text-right">Documentos</th><th className="px-2 text-right">Contabilizados</th><th className="px-2 text-right">Sin efecto</th><th className="px-2 text-right">Con error</th><th className="px-2 text-right">Pendientes</th></tr></thead>
          <tbody>
            {c.items.map((i: any) => (
              <tr key={i.origen} className="border-t border-borde">
                <td className="py-1 pr-3">{i.etiqueta}{i.motivo_error && <div className="text-red-700">{i.motivo_error}</div>}</td>
                <td className="px-2 text-right tabular-nums">{i.documentos}</td><td className="px-2 text-right tabular-nums">{i.contabilizados}</td><td className="px-2 text-right tabular-nums">{i.sin_efecto}</td>
                <td className={`px-2 text-right tabular-nums ${i.con_error ? 'font-semibold text-red-700' : ''}`}>{i.con_error}</td><td className="px-2 text-right tabular-nums">{i.pendientes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TablaApilable>
    );
  return (
    <ul className="mt-3 space-y-1 text-xs">
      {c.items.map((i: any, k: number) => (
        <li key={k} className="flex flex-wrap justify-between gap-2 border-t border-borde pt-1">
          <span>{i.cuenta ?? i.concepto}</span>
          <span className="tabular-nums">
            {i.contable != null ? <>contable {money(i.contable)} · operativo {money(i.operativo)} · <strong className={i.diferencia ? 'text-red-700' : ''}>dif. {money(i.diferencia)}</strong></> : money(i.importe)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Controles() {
  const { puede } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['contab', 'controles'], queryFn: () => api.get('/contabilidad/controles') });
  const { data: corridas } = useQuery({ queryKey: ['contab', 'corridas'], queryFn: () => api.get('/contabilidad/corridas') });
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  const cs: any[] = data.controles;
  const dif = cs.filter((c) => c.estado === 'diferencia').length;
  const avisos = cs.filter((c) => c.estado === 'aviso').length;
  const reintentar = async () => {
    try {
      const r = await api.post('/contabilidad/sincronizar', { reintentar: true });
      toast.ok(r.creados ? `Se contabilizaron ${r.creados} operación(es)` : 'Sin cambios');
      qc.invalidateQueries({ queryKey: ['contab'] });
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="space-y-5">
      <Aviso tono={dif ? 'rojo' : avisos ? 'ambar' : 'verde'}>
        {dif ? `${dif} control(es) con diferencias` : avisos ? `Sin diferencias, pero ${avisos} aviso(s) para revisar` : 'Todos los controles están en orden'}. Estos controles solo comparan: ORVELAN nunca crea movimientos ni ajustes para hacer coincidir saldos.
      </Aviso>
      <div className="grid gap-3 lg:grid-cols-2">
        {cs.map((c) => {
          const e = ESTADO[c.estado as keyof typeof ESTADO];
          return (
            <div key={c.clave} className={`rounded-card border p-4 ${e.borde} ${c.clave === 'cobertura' ? 'lg:col-span-2' : ''}`}>
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 shrink-0">{e.icono}</span>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{c.titulo}</div>
                  {c.contable != null && c.operativo != null && (
                    <div className="mt-1 flex flex-wrap gap-x-4 text-sm tabular-nums">
                      <span>Contabilidad: <strong>{money(c.contable)}</strong></span><span>Operaciones: <strong>{money(c.operativo)}</strong></span>
                      {c.diferencia ? <span className="text-red-700">Diferencia: <strong>{money(c.diferencia)}</strong></span> : null}
                    </div>
                  )}
                  {c.contable != null && c.operativo == null && <div className="mt-1 text-sm tabular-nums">Saldo contable: <strong>{money(c.contable)}</strong></div>}
                  <p className="mt-1 text-sm text-tenue">{c.detalle}</p>
                  <Items c={c} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <Tarjeta
        titulo="Historial de contabilización"
        subtitulo="Cada vez que se contabilizan operaciones queda registrado. Las operaciones anteriores a la contabilidad se contabilizaron una sola vez, como históricas."
        acciones={puede('contabilidad.gestionar') ? <Boton tam="sm" icono={<RefreshCw className="size-4" />} onClick={reintentar}>Reintentar operaciones con error</Boton> : undefined}
      >
        {!corridas?.length ? <p className="text-sm text-tenue">Todavía no hay corridas.</p> : (
          <ul className="divide-y divide-borde text-sm">
            {corridas.map((c: any) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span>{fechaHora(c.iniciada_at)} · {c.disparador === 'inicial' ? 'Generación inicial' : c.disparador === 'manual' ? 'Manual' : 'Al consultar'}{c.usuario ? ` · ${c.usuario}` : ''}</span>
                <span className="text-tenue">{c.asientos_creados} asiento(s){c.asientos_historicos ? ` (${c.asientos_historicos} históricos)` : ''}{c.omitidos ? ` · ${c.omitidos} omitido(s)` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </Tarjeta>
    </div>
  );
}
