// Administración del reloj compartido: activar el modo, registrar dispositivos con un código de un solo uso y revocarlos.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Power, ShieldOff } from 'lucide-react';
import { api } from '@/lib/api';
import { fechaHora } from '@/lib/format';
import { Aviso, Boton, Campo, Cargando, Encabezado, ErrorCaja, Input, Insignia, Modal, Tabla, Tarjeta, useConfirmar, useToast } from '@/components/ui';

export function RelojAdmin() {
  const qc = useQueryClient();
  const toast = useToast();
  const { confirmar, dialogo } = useConfirmar();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['reloj'], queryFn: () => api.get('/asistencia/dispositivos') });
  const [nuevo, setNuevo] = useState(false);
  const [nombre, setNombre] = useState('');
  const [codigo, setCodigo] = useState<{ codigo: string; nombre: string; vence_en_min: number } | null>(null);
  const inv = () => qc.invalidateQueries({ queryKey: ['reloj'] });
  const crear = useMutation({
    mutationFn: () => api.post('/asistencia/dispositivos', { nombre }),
    onSuccess: (r) => { inv(); setNuevo(false); setCodigo({ codigo: r.codigo, nombre, vence_en_min: r.vence_en_min }); setNombre(''); },
    onError: toast.error,
  });
  const alternar = useMutation({
    mutationFn: (activo: boolean) => api.put('/asistencia/reloj', { activo }),
    onSuccess: () => { inv(); toast.ok('Modo reloj actualizado'); },
    onError: toast.error,
  });
  const revocar = useMutation({
    mutationFn: (id: string) => api.post(`/asistencia/dispositivos/${id}/revocar`),
    onSuccess: () => { inv(); toast.ok('Dispositivo revocado: ya no puede fichar'); },
    onError: toast.error,
  });
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  const url = `${window.location.origin}/reloj`;
  const vigentes = (data.dispositivos as any[]).filter((d) => d.estado !== 'revocado');

  return (
    <>
      {dialogo}
      <Encabezado
        titulo="Reloj compartido"
        subtitulo="Una tablet o computadora del taller para que el personal fiche entrada y salida con su PIN"
        acciones={<Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => setNuevo(true)}>Registrar dispositivo</Boton>}
      />
      <div className="space-y-5">
        <Tarjeta
          titulo="Estado del modo reloj"
          acciones={<Boton icono={<Power className="size-4" />} variante={data.reloj_activo ? 'peligro' : 'exito'} cargando={alternar.isPending} onClick={async () => { if (!data.reloj_activo || (await confirmar('Apagar el modo reloj', 'Los dispositivos registrados dejarán de poder fichar hasta que lo vuelvas a activar.', true))) alternar.mutate(!data.reloj_activo); }}>{data.reloj_activo ? 'Desactivar' : 'Activar'}</Boton>}
        >
          <p className="text-sm">{data.reloj_activo ? <Insignia tono="verde">Activo</Insignia> : <Insignia>Desactivado</Insignia>}</p>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-tenue">
            <li>Registrá el dispositivo (botón de arriba) y copiá el código que aparece; vence en 15 minutos y sirve una sola vez.</li>
            <li>En la tablet abrí <strong className="text-texto">{url}</strong> e ingresá el código. Esa pantalla solo permite fichar: no da acceso al resto del sistema.</li>
            <li>Cada persona elige su nombre, escribe su PIN y registra la entrada o la salida. La pantalla vuelve sola al inicio.</li>
            <li>Los PIN se asignan en <em>Equipo y permisos</em>. Tras 5 errores seguidos el PIN se bloquea 15 minutos (podés desbloquearlo ahí mismo).</li>
          </ol>
        </Tarjeta>

        <Tarjeta titulo="Dispositivos" subtitulo={`${vigentes.length} vigente(s)`} sinPadding>
          <Tabla
            filas={data.dispositivos as any[]}
            clave={(d) => d.id}
            vacio={<p className="px-4 py-8 text-center text-sm text-tenue">Todavía no registraste dispositivos.</p>}
            columnas={[
              { clave: 'n', titulo: 'Dispositivo', render: (d) => <span className="font-medium">{d.nombre}</span>, movil: 'titulo' },
              { clave: 'e', titulo: 'Estado', render: (d) => (d.estado === 'activo' ? <Insignia tono="verde">Activo</Insignia> : d.estado === 'revocado' ? <Insignia tono="rojo">Revocado</Insignia> : d.vencido ? <Insignia tono="gris">Código vencido</Insignia> : <Insignia tono="ambar">Esperando activación</Insignia>), movil: 'meta' },
              { clave: 'u', titulo: 'Último uso', render: (d) => (d.ultimo_uso ? fechaHora(d.ultimo_uso) : '—'), movil: 'subtitulo' },
              { clave: 'c', titulo: 'Registrado por', render: (d) => d.creado_por ?? '—', movil: 'oculta' },
              {
                clave: 'x', titulo: '', movil: 'meta',
                render: (d) => d.estado === 'revocado' ? null : (
                  <Boton tam="sm" variante="fantasma" icono={<ShieldOff className="size-4" />} onClick={async () => { if (await confirmar('Revocar dispositivo', `"${d.nombre}" dejará de poder fichar de inmediato.`, true)) revocar.mutate(d.id); }}>Revocar</Boton>
                ),
              },
            ]}
          />
        </Tarjeta>
      </div>

      <Modal abierto={nuevo} onCerrar={() => setNuevo(false)} titulo="Registrar dispositivo" ancho="sm" pie={<><Boton onClick={() => setNuevo(false)}>Cancelar</Boton><Boton variante="primario" cargando={crear.isPending} disabled={nombre.trim().length < 2} onClick={() => crear.mutate()}>Generar código</Boton></>}>
        <Campo label="Nombre del dispositivo" hint="Para reconocerlo después. Ej.: Tablet de la entrada"><Input value={nombre} onChange={(e) => setNombre(e.target.value)} autoFocus /></Campo>
      </Modal>
      <Modal abierto={!!codigo} onCerrar={() => setCodigo(null)} titulo="Código de activación" ancho="sm" pie={<Boton variante="primario" onClick={() => setCodigo(null)}>Listo</Boton>}>
        {codigo && (
          <div className="space-y-3 text-center">
            <p className="text-sm text-tenue">Ingresalo en <strong className="text-texto">{url}</strong> desde “{codigo.nombre}”.</p>
            <p className="rounded-card bg-slate-100 py-4 text-3xl font-bold tracking-[0.3em] tabular-nums">{codigo.codigo}</p>
            <Aviso tono="ambar" className="text-left">Se muestra una sola vez y vence en {codigo.vence_en_min} minutos. Si se pierde, registrá el dispositivo de nuevo.</Aviso>
          </div>
        )}
      </Modal>
    </>
  );
}
