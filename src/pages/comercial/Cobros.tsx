import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Wallet } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fecha, hoyISO, money, numero, sumarDias } from '@/lib/format';
import { Boton, Campo, Cargando, Encabezado, ErrorCaja, Input, Insignia, Modal, Tabla, Tarjeta, useToast, Vacio } from '@/components/ui';
import { MEDIO_PAGO_LABEL, type MedioPago } from '@shared/dominio';

export function Cobros() {
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useAuth();
  const [desde, setDesde] = useState(sumarDias(hoyISO(), -30));
  const [hasta, setHasta] = useState(hoyISO());
  const [anular, setAnular] = useState<any | null>(null);
  const [motivo, setMotivo] = useState('');
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['cobros', { desde, hasta }], queryFn: () => api.get<any[]>(`/cobros${qs({ desde, hasta })}`) });
  const m = useMutation({
    mutationFn: () => api.post(`/cobros/${anular.id}/anular`, { motivo }),
    onSuccess: () => {
      ['cobros', 'ventas', 'venta', 'cuentas', 'cuenta', 'orden', 'dashboard'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.ok('Cobro anulado');
      setAnular(null);
      setMotivo('');
    },
    onError: toast.error,
  });
  const vigentes = data.filter((c) => c.estado === 'registrado');
  const porMedio = new Map<string, number>();
  vigentes.forEach((c) => c.medios.forEach((x: any) => porMedio.set(x.medio, (porMedio.get(x.medio) ?? 0) + x.importe)));

  return (
    <>
      <Encabezado titulo="Cobros" subtitulo="Recibos registrados. Para cobrar, abrí la OT, el comprobante o la cuenta del cliente." />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Campo label="Desde"><Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} /></Campo>
        <Campo label="Hasta"><Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} /></Campo>
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        <Insignia tono="verde" className="px-3 py-1 text-sm">Total: {money(vigentes.reduce((a, c) => a + c.total, 0))}</Insignia>
        {[...porMedio.entries()].map(([medio, t]) => <Insignia key={medio} className="px-3 py-1 text-sm">{MEDIO_PAGO_LABEL[medio as MedioPago]}: {money(t)}</Insignia>)}
      </div>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={data}
            clave={(c) => c.id}
            vacio={<Vacio icono={<Wallet className="size-5" />} titulo="Sin cobros en el período" />}
            columnas={[
              { clave: 'n', titulo: 'Recibo', render: (c) => <span className="font-medium">#{numero(c.numero)}</span>, movil: 'meta' },
              { clave: 'f', titulo: 'Fecha', render: (c) => fecha(c.fecha), movil: 'meta' },
              { clave: 'c', titulo: 'Cliente', render: (c) => c.cliente, movil: 'titulo' },
              { clave: 'm', titulo: 'Medios', render: (c) => c.medios.map((x: any) => `${MEDIO_PAGO_LABEL[x.medio as MedioPago]}${x.referencia ? ` (${x.referencia})` : ''}`).join(', '), movil: 'subtitulo' },
              { clave: 'u', titulo: 'Registró', render: (c) => c.usuario ?? '—', movil: 'oculta' },
              { clave: 'e', titulo: 'Estado', render: (c) => (c.estado === 'anulado' ? <Insignia tono="gris">Anulado</Insignia> : <Insignia tono="verde">Vigente</Insignia>), movil: 'meta' },
              { clave: 't', titulo: 'Importe', alinear: 'derecha', render: (c) => money(c.total), movil: 'derecha' },
              {
                clave: 'a',
                titulo: '',
                render: (c) => c.estado === 'registrado' && puede('cobros.anular') ? <Boton tam="sm" variante="fantasma" icono={<Ban className="size-4" />} onClick={() => setAnular(c)}>Anular</Boton> : null,
                movil: 'meta',
              },
            ]}
          />
        </Tarjeta>
      )}
      <Modal abierto={!!anular} onCerrar={() => setAnular(null)} titulo={`Anular cobro #${anular ? numero(anular.numero) : ''}`} ancho="sm" pie={<><Boton onClick={() => setAnular(null)}>Cancelar</Boton><Boton variante="peligro" disabled={motivo.trim().length < 3} cargando={m.isPending} onClick={() => m.mutate()}>Anular cobro</Boton></>}>
        <div className="space-y-3">
          <p className="text-sm text-tenue">El importe volverá a figurar como saldo pendiente de los comprobantes.</p>
          <Campo label="Motivo" requerido><Input value={motivo} onChange={(e) => setMotivo(e.target.value)} autoFocus /></Campo>
        </div>
      </Modal>
    </>
  );
}
