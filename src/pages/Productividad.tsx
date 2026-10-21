// Productividad operativa. Dos medidas distintas que nunca se restan ni se interpretan como "tiempo perdido":
// las HORAS DE ASISTENCIA (fichajes) y las HORAS PRODUCTIVAS REGISTRADAS EN OT (cronómetro de las órdenes).
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CheckCircle2, ClipboardList, Clock, Hourglass, Wrench } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { duracion, hoyISO, money, numero } from '@/lib/format';
import { Aviso, Cargando, Encabezado, ErrorCaja, Indicador, Insignia, Tabla, Tarjeta } from '@/components/ui';
import { primerDiaMes, SelectorPeriodo } from '@/components/Periodo';
import { formatearMinutos } from '@shared/tempario';

const horasTxt = (h: number | null | undefined) => (h == null ? '—' : h < 48 ? `${h.toFixed(1).replace('.', ',')} h` : `${(h / 24).toFixed(1).replace('.', ',')} días`);

export function Productividad() {
  const [desde, setDesde] = useState(primerDiaMes());
  const [hasta, setHasta] = useState(hoyISO());
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['productividad', desde, hasta],
    queryFn: () => api.get<any>(`/productividad${qs({ desde, hasta })}`),
    enabled: !!desde && !!hasta && desde <= hasta,
    refetchInterval: 120_000,
  });
  const t = data?.taller;
  return (
    <>
      <Encabezado titulo="Productividad" subtitulo="Carga de trabajo, tareas y horas del taller y de cada mecánico" />
      <SelectorPeriodo desde={desde} hasta={hasta} onCambio={(d, h) => { setDesde(d); setHasta(h); }} />
      <Aviso className="mb-5">
        <strong>Horas de asistencia</strong> son el tiempo que la persona estuvo en el taller (fichajes). <strong>Horas productivas registradas en OT</strong> son lo que cronometró trabajando en órdenes.
        No son lo mismo y su diferencia no es “tiempo perdido”: incluye diagnóstico sin cronómetro, esperas, limpieza, atención y capacitación.
      </Aviso>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : t && (
        <div className="space-y-5">
          <section>
            <h2 className="mb-2 text-sm font-semibold">Órdenes del taller</h2>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Indicador titulo="Pendientes" valor={t.pendientes} detalle="Recibidas, en diagnóstico o esperando repuestos" tono="ambar" icono={<Hourglass className="size-5" />} />
              <Indicador titulo="En proceso" valor={t.en_proceso} detalle="En reparación ahora" tono="azul" icono={<Wrench className="size-5" />} />
              <Indicador titulo="Completadas" valor={t.completadas_periodo} detalle={`Listas en el período · ${t.listas_para_entregar} esperan entrega`} tono="verde" icono={<CheckCircle2 className="size-5" />} />
              <Indicador titulo="Ingresadas" valor={t.ingresadas_periodo} detalle="Nuevas órdenes en el período" tono="gris" icono={<ClipboardList className="size-5" />} />
            </div>
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold">Tiempos</h2>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Indicador titulo="Tiempo promedio en taller" valor={horasTxt(t.tiempo_promedio_en_taller_horas)} detalle="Desde el ingreso hasta que queda lista" tono="azul" icono={<Clock className="size-5" />} />
              <Indicador titulo="Trabajo promedio por orden" valor={t.tiempo_trabajado_promedio_seg != null ? duracion(Math.round(t.tiempo_trabajado_promedio_seg)) : '—'} detalle={`Cronometrado · ${t.ordenes_con_tiempo_registrado} órdenes con tiempo`} tono="azul" icono={<Clock className="size-5" />} />
              <Indicador titulo="Horas de asistencia" valor={duracion(t.asistencia_seg)} detalle="Fichajes de todo el personal" tono="gris" icono={<Clock className="size-5" />} />
              <Indicador titulo="Horas registradas en OT" valor={duracion(t.registrado_ot_seg)} detalle="Cronómetro de las órdenes" tono="cian" icono={<Clock className="size-5" />} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Indicador titulo="Tareas completadas" valor={t.tareas_completadas} tono="verde" icono={<CheckCircle2 className="size-5" />} />
              <Indicador titulo="Estimado vs. real" valor={t.tareas_comparables ? `${formatearMinutos(t.estimado_min)} / ${duracion(t.real_seg)}` : '—'} detalle={t.tareas_comparables ? `${t.tareas_comparables} tareas con estimación y cronómetro` : 'Sin tareas con estimación y cronómetro'} tono="violeta" icono={<Clock className="size-5" />} />
              {t.mano_obra_completadas !== undefined && <Indicador titulo="Mano de obra completada" valor={money(t.mano_obra_completadas)} detalle="Servicios de las órdenes terminadas" tono="verde" />}
            </div>
          </section>

          <Tarjeta titulo="Por mecánico" subtitulo="Carga de trabajo actual y actividad del período" sinPadding>
            <Tabla
              filas={data.mecanicos}
              clave={(m: any) => m.usuario_id}
              vacio={<p className="p-6 text-center text-sm text-tenue">Todavía no hay mecánicos con actividad.</p>}
              columnas={[
                { clave: 'n', titulo: 'Persona', render: (m: any) => <span><span className="font-medium">{m.nombre}</span>{m.cronometro && <Link to={`/ordenes/${m.cronometro.orden_id}`} className="ml-2"><Insignia tono="azul">Trabajando en OT #{numero(m.cronometro.orden_numero)}</Insignia></Link>}</span>, movil: 'titulo' },
                { clave: 'a', titulo: 'Asistencia', alinear: 'derecha', render: (m: any) => (m.dias_asistencia ? `${duracion(m.asistencia_seg)} · ${m.dias_asistencia} d` : '—'), movil: 'meta' },
                { clave: 'r', titulo: 'Registrado en OT', alinear: 'derecha', render: (m: any) => duracion(m.registrado_ot_seg), movil: 'meta' },
                { clave: 'o', titulo: 'OT trabajadas', alinear: 'derecha', render: (m: any) => m.ot_trabajadas, movil: 'meta' },
                { clave: 't', titulo: 'Tareas completadas', alinear: 'derecha', render: (m: any) => m.tareas_completadas, movil: 'meta' },
                { clave: 'e', titulo: 'Estimado / real', alinear: 'derecha', render: (m: any) => (m.comparables ? <span title={`${m.comparables} tareas comparables`}>{formatearMinutos(m.estimado_min)} / {duracion(m.real_seg)}</span> : '—'), movil: 'meta' },
                { clave: 'c', titulo: 'Carga actual', alinear: 'derecha', render: (m: any) => (m.ot_abiertas || m.tareas_pendientes ? <span>{m.ot_abiertas} OT · {m.tareas_pendientes} tareas{m.carga_estimada_min ? ` · ${formatearMinutos(m.carga_estimada_min)}` : ''}</span> : <span className="text-tenue">Sin carga</span>), movil: 'derecha' },
              ]}
            />
          </Tarjeta>
          <p className="text-xs text-tenue">“Estimado / real” compara solo las tareas completadas que tenían tiempo estimado y cronómetro. “Carga actual” cuenta las órdenes abiertas donde la persona es responsable, participante o tiene tareas sin terminar, y el tiempo estimado de esas tareas.</p>
        </div>
      )}
    </>
  );
}
