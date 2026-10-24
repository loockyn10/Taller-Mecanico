// Código QR del enlace de seguimiento: se genera en el navegador (sin servicios externos) y contiene únicamente la dirección pública.
import { useMemo } from 'react';
import { Copy, Download, Share2 } from 'lucide-react';
import { matrizQr, svgQr } from '@shared/qr';
import { Aviso, Boton, Modal, useToast } from '@/components/ui';

const SILENCIO = 4;

/** PNG del QR (10 px por módulo + zona de silencio): sirve para pegarlo en un mensaje o imprimirlo. */
function pngDeQr(url: string): Promise<Blob | null> {
  const m = matrizQr(url);
  const lado = (m.length + SILENCIO * 2) * 10;
  const canvas = document.createElement('canvas');
  canvas.width = lado;
  canvas.height = lado;
  const g = canvas.getContext('2d');
  if (!g) return Promise.resolve(null);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, lado, lado);
  g.fillStyle = '#000';
  m.forEach((fila, r) => fila.forEach((oscuro, c) => oscuro && g.fillRect((c + SILENCIO) * 10, (r + SILENCIO) * 10, 10, 10)));
  return new Promise((ok) => canvas.toBlob((b) => ok(b), 'image/png'));
}

export default function QrEnlace({ url, numero, onCerrar, onCopiar }: { url: string; numero: number; onCerrar: () => void; onCopiar: () => void }) {
  const toast = useToast();
  const svg = useMemo(() => svgQr(url), [url]);
  const archivo = `seguimiento-OT-${String(numero).padStart(4, '0')}.png`;

  const descargar = async () => {
    const blob = await pngDeQr(url);
    if (!blob) return toast.error(new Error('No se pudo generar la imagen'));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = archivo;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const compartir = async () => {
    const blob = await pngDeQr(url);
    if (!blob) return;
    const f = new File([blob], archivo, { type: 'image/png' });
    try {
      if (navigator.canShare?.({ files: [f] })) await navigator.share({ files: [f], text: 'Código QR para seguir la reparación de tu vehículo' });
      else await navigator.share({ text: 'Seguí la reparación de tu vehículo desde este enlace:', url });
    } catch {
      /* la persona cerró el selector */
    }
  };
  const puedeCompartir = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo="Código QR del seguimiento"
      ancho="sm"
      pie={
        <>
          <Boton onClick={onCerrar}>Cerrar</Boton>
          <Boton icono={<Copy className="size-4" />} onClick={onCopiar}>Copiar enlace</Boton>
          {puedeCompartir && <Boton icono={<Share2 className="size-4" />} onClick={compartir}>Compartir</Boton>}
          <Boton variante="primario" icono={<Download className="size-4" />} onClick={descargar}>Descargar imagen</Boton>
        </>
      }
    >
      <div className="space-y-4">
        <div className="mx-auto w-full max-w-[18rem] rounded-card border border-borde bg-white p-1" dangerouslySetInnerHTML={{ __html: svg }} />
        <p className="text-center text-sm text-tenue">El cliente apunta la cámara del celular y abre la página con el estado de su vehículo.</p>
        <Aviso>El código contiene únicamente la dirección del enlace: no lleva datos del cliente ni de la orden. Si el enlace se regenera o se desactiva, este código deja de funcionar.</Aviso>
        <p className="break-all rounded-ctl bg-slate-50 px-3 py-2 text-xs text-tenue">{url}</p>
      </div>
    </Modal>
  );
}
