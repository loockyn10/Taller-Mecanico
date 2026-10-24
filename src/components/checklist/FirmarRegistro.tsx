// Conformidad del cliente: el empleado muestra el resumen confirmado y el cliente firma con el dedo o con un lápiz táctil, o se registra que no está presente o
// que no quiso firmar. La firma apunta al contenido exacto confirmado (huella sha256) y al texto de conformidad que se le mostró.
import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PenLine, UserX } from 'lucide-react';
import { api } from '@/lib/api';
import { AVISO_FIRMA, TIPO_REGISTRO_LABEL, textoConformidad } from '@shared/checklist';
import { Aviso, Boton, Campo, Input, Modal, Segmentado, Textarea, useToast } from '../ui';
import { FirmaPad, type FirmaPadRef } from './Firma';
import { ResumenRegistro, type InfoOrden } from './Resumen';
import { claveChecklists, type Registro, type ResultadoFirma } from './tipos';

export function FirmarRegistro({ reg, info, onCerrar, onFirmado }: { reg: Registro; info: InfoOrden; onCerrar: () => void; onFirmado: (r: Registro) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const pad = useRef<FirmaPadRef>(null);
  const [modo, setModo] = useState<ResultadoFirma>('firmada');
  const [hayFirma, setHayFirma] = useState(false);
  const [nombre, setNombre] = useState(info.cliente && info.cliente !== 'Consumidor final' ? info.cliente : '');
  const [aclaracion, setAclaracion] = useState('');

  const m = useMutation({
    mutationFn: () =>
      api.post<Registro>(
        `/checklists/${reg.id}/firma`,
        modo === 'firmada' ? { resultado: 'firmada', nombre_firmante: nombre.trim(), firma: pad.current!.trazos(), ...(aclaracion.trim() ? { aclaracion: aclaracion.trim() } : {}) } : { resultado: modo, ...(aclaracion.trim() ? { aclaracion: aclaracion.trim() } : {}) },
      ),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: claveChecklists(reg.orden_id) });
      qc.invalidateQueries({ queryKey: ['checklists', 'vehiculo'] });
      toast.ok(modo === 'firmada' ? 'Firma registrada' : 'Quedó registrado');
      onFirmado(r);
    },
    onError: toast.error,
  });
  const puede = modo === 'firmada' ? hayFirma && nombre.trim().length >= 2 : true;

  return (
    <Modal
      abierto
      onCerrar={() => !m.isPending && onCerrar()}
      ancho="xl"
      titulo={`Conformidad del cliente · ${TIPO_REGISTRO_LABEL[reg.tipo]}`}
      pie={
        <>
          <Boton onClick={onCerrar} disabled={m.isPending}>Ahora no</Boton>
          <Boton variante="primario" tam="lg" icono={modo === 'firmada' ? <PenLine className="size-5" /> : <UserX className="size-5" />} disabled={!puede} cargando={m.isPending} onClick={() => m.mutate()}>
            {modo === 'firmada' ? 'Guardar firma' : modo === 'no_presente' ? 'Registrar: cliente no presente' : 'Registrar: no quiso firmar'}
          </Boton>
        </>
      }
    >
      <div className="space-y-5">
        <Aviso tono="azul">Mostrale este resumen al cliente y pedile que lo revise. Si está de acuerdo, firma abajo con el dedo o con un lápiz táctil.</Aviso>
        <div className="rounded-card border border-borde bg-white p-3 sm:p-4">
          <ResumenRegistro reg={reg} info={info} firmas={false} />
        </div>

        <div className="space-y-3">
          <Segmentado
            activo={modo}
            onCambio={setModo}
            items={[
              { clave: 'firmada', titulo: 'Firma del cliente' },
              { clave: 'no_presente', titulo: 'No está presente' },
              { clave: 'se_niega', titulo: 'No desea firmar' },
            ]}
          />
          {modo === 'firmada' ? (
            <>
              <p className="rounded-ctl bg-slate-100 px-3 py-2.5 text-sm italic">«{textoConformidad(reg.tipo)}»</p>
              <Campo label="Nombre de quien firma" requerido hint="Puede ser distinto del titular (por ejemplo, un familiar que retira el vehículo)">
                <Input value={nombre} maxLength={120} className="h-12" onChange={(e) => setNombre(e.target.value)} autoComplete="off" />
              </Campo>
              <FirmaPad ref={pad} onCambio={setHayFirma} deshabilitado={m.isPending} />
              <Campo label="Aclaración (opcional)">
                <Input value={aclaracion} maxLength={300} placeholder="Ej.: DNI, parentesco, retira en nombre del titular…" onChange={(e) => setAclaracion(e.target.value)} />
              </Campo>
              <p className="text-xs text-tenue">{AVISO_FIRMA}</p>
            </>
          ) : (
            <>
              <Aviso tono="ambar">
                {modo === 'no_presente' ? 'Queda registrado que el cliente no estaba presente. Podés pedirle la firma más tarde desde esta misma orden.' : 'Queda registrado que el cliente no quiso firmar. El registro igual queda confirmado y no se pierde nada.'}
              </Aviso>
              <Campo label="Aclaración (opcional)">
                <Textarea rows={2} value={aclaracion} maxLength={300} placeholder={modo === 'no_presente' ? 'Ej.: dejó el vehículo en guardia, lo dejó un tercero…' : 'Ej.: dijo que firma al retirarlo'} onChange={(e) => setAclaracion(e.target.value)} />
              </Campo>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
