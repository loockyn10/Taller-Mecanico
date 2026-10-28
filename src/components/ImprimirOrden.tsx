// "Imprimir orden": elegir la copia (mecánico, administración o ambas), ver el PDF A4 generado por el servidor y descargarlo o imprimirlo desde el navegador.
// Nunca imprime solo: el diálogo de impresión se abre únicamente cuando la persona aprieta «Imprimir».
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, ExternalLink, Printer } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Aviso, Boton, Cargando, ErrorCaja, Modal } from '@/components/ui';
import { useSeguimiento } from '@/components/SeguimientoCliente';

type Copia = 'mecanico' | 'administracion' | 'ambas' | 'cliente';

async function pedirPdf(ordenId: string, copia: Copia): Promise<Blob> {
  let r: Response;
  try {
    r = await fetch(`/api/ordenes/${ordenId}/pdf?copia=${copia}`, { credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'sin_conexion', 'No hay conexión con el servidor. Verificá tu conexión a internet.');
  }
  if (!r.ok) {
    let mensaje = `No se pudo generar el PDF (error ${r.status})`;
    try {
      mensaje = (await r.json())?.error?.message ?? mensaje;
    } catch {
      /* respuesta sin cuerpo JSON */
    }
    throw new ApiError(r.status, 'error', mensaje);
  }
  return r.blob();
}

const OPCIONES: Array<{ copia: Copia; titulo: string; detalle: string }> = [
  { copia: 'mecanico', titulo: 'Mecánico', detalle: 'Datos para trabajar y media hoja para anotaciones. Sin precios ni datos personales del cliente (aunque la imprima un administrador).' },
  { copia: 'administracion', titulo: 'Administración', detalle: 'Copia identificada como «COPIA ADMINISTRACIÓN». Incluye el cliente responsable de la orden, según tus permisos.' },
  { copia: 'ambas', titulo: 'Ambas copias', detalle: 'Un solo PDF con una hoja A4 por cada copia.' },
  { copia: 'cliente', titulo: 'Seguimiento del cliente', detalle: 'Hoja con el código QR para que el cliente siga su vehículo desde el celular.' },
];

export function ImprimirOrden({ ordenId, numero, abierto, onCerrar }: { ordenId: string; numero: number; abierto: boolean; onCerrar: () => void }) {
  const { puede } = useAuth();
  const admin = puede('ordenes.imprimir_administracion');
  // La hoja del cliente lleva el QR del seguimiento: hace falta poder compartir el enlace y que esté activo (activarlo es una decisión aparte).
  const conQr = puede('seguimiento.compartir');
  const { data: seg } = useSeguimiento(ordenId, abierto && conQr);
  const qrListo = !!seg?.activo && !!seg.url;
  const opciones = OPCIONES.filter((o) => (o.copia === 'cliente' ? conQr : admin || o.copia === 'mecanico'));
  const [copia, setCopia] = useState<Copia>('mecanico');
  const marco = useRef<HTMLIFrameElement>(null);

  const { data: blob, isFetching, error } = useQuery({
    queryKey: ['orden-pdf', ordenId, copia],
    queryFn: () => pedirPdf(ordenId, copia),
    enabled: abierto && (copia !== 'cliente' || qrListo),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  const archivo = `OT-${String(numero).padStart(4, '0')}-${copia === 'ambas' ? 'ambas-copias' : copia === 'cliente' ? 'seguimiento-cliente' : copia}.pdf`;
  const imprimir = () => {
    if (!url) return;
    try {
      marco.current?.contentWindow?.focus();
      marco.current?.contentWindow?.print();
    } catch {
      window.open(url, '_blank');
    }
  };

  return (
    <Modal
      abierto={abierto}
      onCerrar={onCerrar}
      ancho="xl"
      titulo={`Imprimir orden #${String(numero).padStart(4, '0')}`}
      pie={
        <>
          <Boton onClick={onCerrar}>Cerrar</Boton>
          <a href={url ?? undefined} download={archivo} className={!url ? 'pointer-events-none' : undefined}>
            <Boton icono={<Download className="size-4" />} disabled={!url} className="max-sm:w-full">Descargar PDF</Boton>
          </a>
          <Boton icono={<ExternalLink className="size-4" />} disabled={!url} onClick={() => url && window.open(url, '_blank')}>Abrir en otra pestaña</Boton>
          <Boton variante="primario" icono={<Printer className="size-4" />} disabled={!url} onClick={imprimir}>Imprimir</Boton>
        </>
      }
    >
      <div className="space-y-4">
        <fieldset>
          <legend className="mb-2 text-sm font-medium">¿Qué copia querés?</legend>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {opciones.map((o) => (
              <label key={o.copia} className={`flex items-start gap-2 rounded-ctl border p-3 text-sm ${o.copia === 'cliente' && !qrListo ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'} ${copia === o.copia ? 'border-marca-500 bg-marca-50' : 'border-borde'}`}>
                <input type="radio" name="copia" className="mt-1" checked={copia === o.copia} disabled={o.copia === 'cliente' && !qrListo} onChange={() => setCopia(o.copia)} />
                <span><strong className="block">{o.titulo}</strong><span className="text-xs text-slate-600">{o.copia === 'cliente' && !qrListo ? 'Primero activá el seguimiento del cliente en el detalle de la orden.' : o.detalle}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
        {error && <ErrorCaja error={error} />}
        {isFetching && !url && <Cargando />}
        {url && (
          <>
            <iframe ref={marco} src={url} title="Vista previa de la orden" className="hidden h-[60dvh] w-full rounded-ctl border border-borde bg-slate-100 sm:block" />
            <Aviso tono="azul" className="sm:hidden">En el celular el PDF no se muestra acá: usá «Abrir en otra pestaña» o «Descargar PDF».</Aviso>
          </>
        )}
        <p className="text-xs text-slate-500">Hoja A4 vertical, lista para imprimir en blanco y negro. Se imprime recién cuando apretás «Imprimir».</p>
      </div>
    </Modal>
  );
}
