import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ClipboardList, Download, Printer, Wallet } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { descargarCSV, pesosCSV } from '@/lib/csv';
import { fecha, money, numero, whatsapp } from '@/lib/format';
import { Boton, Buscador, Cargando, Encabezado, ErrorCaja, Indicador, Insignia, Pestanas, Select, Tabla, Tarjeta, useDebounce, Vacio } from '@/components/ui';
import { EstadoCobroBadge } from '@/components/estados';
import { ModalCobro } from '@/components/Cobro';
import { ModalAnticipo, ModalReintegro } from '@/components/Devolucion';
import { MEDIO_PAGO_LABEL, type MedioPago } from '@shared/dominio';

export function Cuentas() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [estado, setEstado] = useState('con_deuda');
  const dq = useDebounce(q);
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['cuentas', { dq, estado }], queryFn: () => api.get<any[]>(`/cuentas-corrientes${qs({ q: dq, estado })}`) });
  const suma = (k: string) => data.reduce((a, c) => a + (c[k] ?? 0), 0);
  return (
    <>
      <Encabezado
        titulo="Cuentas corrientes"
        subtitulo="Saldos de clientes y antigüedad de la deuda"
        acciones={data.length > 0 && <Boton icono={<Download className="size-4" />} onClick={() => descargarCSV('cuentas-corrientes', ['Cliente', 'Teléfono', 'Saldo', '0-30 días', '31-60', '61-90', '+90', 'Deuda desde'], data.map((c) => [c.nombre, c.telefono ?? '', pesosCSV(c.saldo), pesosCSV(c.v_0), pesosCSV(c.v_30), pesosCSV(c.v_60), pesosCSV(c.v_90), c.deuda_desde ?? '']))}>CSV</Boton>}
      />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Indicador titulo="Deuda total" valor={money(suma('saldo'))} detalle={`${data.length} cliente(s) · a favor de clientes ${money(suma('a_favor'))}`} tono="rojo" />
        <Indicador titulo="0 a 30 días" valor={money(suma('v_0'))} tono="verde" />
        <Indicador titulo="31 a 60 días" valor={money(suma('v_30'))} tono="ambar" />
        <Indicador titulo="61 a 90 días" valor={money(suma('v_60'))} tono="ambar" />
        <Indicador titulo="Más de 90 días" valor={money(suma('v_90'))} tono="rojo" />
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Buscador value={q} onChange={setQ} placeholder="Cliente, documento o teléfono" className="min-w-56 flex-1" />
        <Select value={estado} onChange={(e) => setEstado(e.target.value)} className="w-auto" aria-label="Estado">
          <option value="con_deuda">Con deuda</option>
          <option value="vencidas">Con deuda de más de 30 días</option>
          <option value="al_dia">Al día (con movimientos)</option>
          <option value="a_favor">Con saldo a favor (anticipos / devoluciones)</option>
          <option value="todos">Todos</option>
        </Select>
      </div>
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={data}
            clave={(c) => c.id}
            onFila={(c) => nav(`/cuentas/${c.id}`)}
            vacio={<Vacio icono={<ClipboardList className="size-5" />} titulo={estado === 'con_deuda' ? 'Ningún cliente tiene deuda' : 'Sin resultados'} />}
            columnas={[
              { clave: 'n', titulo: 'Cliente', render: (c) => <span className="font-medium">{c.nombre}</span>, movil: 'titulo' },
              { clave: 't', titulo: 'Teléfono', render: (c) => c.telefono ?? '—', movil: 'subtitulo' },
              { clave: 'cp', titulo: 'Pendientes', alinear: 'derecha', render: (c) => c.pendientes, movil: 'oculta' },
              { clave: 'd', titulo: 'Deuda desde', render: (c) => (c.deuda_desde ? fecha(c.deuda_desde) : '—'), movil: 'meta' },
              {
                clave: 'ant', titulo: 'Antigüedad de la deuda',
                render: (c) => (
                  <div className="flex flex-wrap gap-1">
                    {c.v_0 > 0 && <Insignia tono="verde">0-30 d · {money(c.v_0)}</Insignia>}
                    {c.v_30 > 0 && <Insignia tono="ambar">31-60 d · {money(c.v_30)}</Insignia>}
                    {c.v_60 > 0 && <Insignia tono="ambar">61-90 d · {money(c.v_60)}</Insignia>}
                    {c.v_90 > 0 && <Insignia tono="rojo">+90 d · {money(c.v_90)}</Insignia>}
                  </div>
                ),
                movil: 'meta',
              },
              { clave: 'af', titulo: 'A favor', alinear: 'derecha', render: (c) => (c.a_favor > 0 ? <span className="font-medium text-emerald-700">{money(c.a_favor)}</span> : '—'), movil: 'meta' },
              { clave: 's', titulo: 'Deuda', alinear: 'derecha', render: (c) => <span className={c.saldo > 0 ? 'font-semibold text-red-600' : 'font-semibold'}>{money(c.saldo)}</span>, movil: 'derecha' },
            ]}
          />
        </Tarjeta>
      )}
    </>
  );
}

export function CuentaCliente() {
  const { id } = useParams();
  const { puede, me } = useAuth();
  const [cobro, setCobro] = useState(false);
  const [anticipo, setAnticipo] = useState(false);
  const [reintegro, setReintegro] = useState<any>(null);
  const [tab, setTab] = useState<'movimientos' | 'pendientes' | 'favor' | 'pagos'>('movimientos');
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['cuenta', id], queryFn: () => api.get(`/cuentas-corrientes/${id}`) });
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  const wa = whatsapp(data.cliente.telefono, `Hola ${data.cliente.nombre}! Te escribimos de ${me?.taller.nombre}: tu saldo pendiente es ${money(data.deuda)}. Cualquier consulta, estamos a disposición.`);
  return (
    <>
      <Encabezado
        volver
        titulo={`Cuenta de ${data.cliente.nombre}`}
        subtitulo={<>Deuda: <span className={data.deuda > 0 ? 'font-semibold text-red-600' : 'font-semibold'}>{money(data.deuda)}</span> · A favor: <span className="font-semibold text-emerald-700">{money(data.a_favor)}</span> · Saldo neto: <span className="font-semibold">{money(data.saldo)}</span></>}
        acciones={
          <>
            <Link to={`/clientes/${id}`}><Boton>Ficha del cliente</Boton></Link>
            <Boton icono={<Printer className="size-4" />} onClick={() => window.open(`/imprimir/cuenta/${id}`, '_blank')}>Estado de cuenta</Boton>
            {wa && data.deuda > 0 && <a href={wa} target="_blank" rel="noreferrer"><Boton>Recordar por WhatsApp</Boton></a>}
            {puede('cobros.registrar') && <Boton icono={<Wallet className="size-4" />} onClick={() => setAnticipo(true)}>Registrar anticipo</Boton>}
            {data.deuda > 0 && puede('cobros.registrar') && <Boton variante="exito" icono={<Wallet className="size-4" />} onClick={() => setCobro(true)}>Registrar cobro</Boton>}
          </>
        }
      />
      <Pestanas
        items={[
          { clave: 'movimientos', titulo: 'Movimientos' },
          { clave: 'pendientes', titulo: 'Comprobantes pendientes', contador: data.pendientes.length },
          { clave: 'favor', titulo: 'Saldo a favor', contador: data.creditos.length },
          { clave: 'pagos', titulo: 'Historial de pagos', contador: data.cobros.length },
        ]}
        activo={tab}
        onCambio={setTab}
      />
      {tab === 'movimientos' && (
        <Tarjeta sinPadding>
          <Tabla
            filas={data.movimientos}
            clave={(m: any) => m.id}
            vacio={<p className="px-4 py-6 text-center text-sm text-tenue">Sin movimientos</p>}
            columnas={[
              { clave: 'f', titulo: 'Fecha', render: (m: any) => fecha(m.fecha), movil: 'meta' },
              { clave: 'c', titulo: 'Concepto', render: (m: any) => (m.tipo === 'venta' ? <Link className="text-marca-700" to={`/ventas/${m.id}`}>Comprobante #{numero(m.numero)}</Link> : m.tipo === 'devolucion' ? <Link className="text-marca-700" to={`/cobros?tab=devoluciones&ver=${m.id}`}>Nota de crédito interna #{numero(m.numero)}</Link> : m.tipo === 'reintegro' ? <span>Reintegro de dinero #{numero(m.numero)}</span> : <Link className="text-marca-700" to={`/cobros?ver=${m.id}`}>{m.tipo === 'anticipo' ? 'Anticipo' : 'Cobro'} #{numero(m.numero)}</Link>), movil: 'titulo' },
              { clave: 'd', titulo: 'Debe', alinear: 'derecha', render: (m: any) => (m.debe ? money(m.debe) : ''), movil: 'meta' },
              { clave: 'h', titulo: 'Haber', alinear: 'derecha', render: (m: any) => (m.haber ? money(m.haber) : ''), movil: 'meta' },
              { clave: 's', titulo: 'Saldo', alinear: 'derecha', render: (m: any) => <span className="font-medium">{money(m.saldo)}</span>, movil: 'derecha' },
            ]}
          />
        </Tarjeta>
      )}
      {tab === 'pendientes' && (
        <Tarjeta sinPadding>
          <Tabla
            filas={data.pendientes}
            clave={(v: any) => v.id}
            vacio={<p className="px-4 py-6 text-center text-sm text-tenue">No hay comprobantes pendientes</p>}
            columnas={[
              { clave: 'n', titulo: 'Comprobante', render: (v: any) => <Link className="text-marca-700" to={`/ventas/${v.id}`}>#{numero(v.numero)}</Link>, movil: 'titulo' },
              { clave: 'f', titulo: 'Fecha', render: (v: any) => fecha(v.fecha), movil: 'subtitulo' },
              { clave: 'o', titulo: 'Origen', render: (v: any) => (v.orden_numero ? `OT #${numero(v.orden_numero)}` : 'Mostrador'), movil: 'meta' },
              { clave: 'e', titulo: 'Estado', render: (v: any) => <EstadoCobroBadge total={v.total} cobrado={v.cobrado} estado={v.estado} />, movil: 'meta' },
              { clave: 't', titulo: 'Total', alinear: 'derecha', render: (v: any) => money(v.total), movil: 'oculta' },
              { clave: 'c', titulo: 'Cobrado', alinear: 'derecha', render: (v: any) => money(v.cobrado), movil: 'oculta' },
              { clave: 's', titulo: 'Saldo', alinear: 'derecha', render: (v: any) => <span className="font-semibold text-red-600">{money(v.saldo)}</span>, movil: 'derecha' },
            ]}
          />
        </Tarjeta>
      )}
      {tab === 'favor' && (
        <Tarjeta sinPadding>
          <Tabla
            filas={data.creditos}
            clave={(x: any) => x.origen_tipo + x.origen_id}
            vacio={<p className="px-4 py-6 text-center text-sm text-tenue">El cliente no tiene anticipos ni saldo a favor disponible</p>}
            columnas={[
              { clave: 'o', titulo: 'Origen', render: (x: any) => (x.origen_tipo === 'anticipo' ? `Anticipo · recibo #${numero(x.numero)}` : `Devolución #${numero(x.numero)} · comprobante #${numero(x.venta_numero)}`), movil: 'titulo' },
              { clave: 'f', titulo: 'Fecha', render: (x: any) => fecha(x.fecha), movil: 'meta' },
              { clave: 'v', titulo: 'Vinculado a', render: (x: any) => (x.orden_numero ? `OT #${numero(x.orden_numero)}` : x.presupuesto_numero ? `Presupuesto #${numero(x.presupuesto_numero)}` : '—'), movil: 'meta' },
              { clave: 't', titulo: 'Recibido', alinear: 'derecha', render: (x: any) => money(x.total), movil: 'oculta' },
              { clave: 'u', titulo: 'Usado / devuelto', alinear: 'derecha', render: (x: any) => money(x.aplicado + x.devuelto), movil: 'oculta' },
              { clave: 'd', titulo: 'Disponible', alinear: 'derecha', render: (x: any) => <span className="font-semibold text-emerald-700">{money(x.disponible)}</span>, movil: 'derecha' },
              { clave: 'a', titulo: '', render: (x: any) => (puede('cobros.anular') ? <Boton tam="sm" onClick={() => setReintegro({ tipo: x.origen_tipo, id: x.origen_id, numero: x.numero, disponible: x.disponible })}>Devolver dinero</Boton> : null), movil: 'meta' },
            ]}
          />
          <p className="border-t border-borde px-4 py-2 text-xs text-tenue">Para usar el saldo a favor, abrí el comprobante pendiente y elegí “Aplicar saldo a favor”.</p>
        </Tarjeta>
      )}
      {tab === 'pagos' && (
        <Tarjeta sinPadding>
          <Tabla
            filas={data.cobros}
            clave={(c: any) => c.id}
            vacio={<p className="px-4 py-6 text-center text-sm text-tenue">El cliente todavía no registró pagos</p>}
            columnas={[
              { clave: 'n', titulo: 'Recibo', render: (c: any) => <Link className="text-marca-700" to={`/cobros?ver=${c.id}`}>#{numero(c.numero)}</Link>, movil: 'titulo' },
              { clave: 'f', titulo: 'Fecha', render: (c: any) => fecha(c.fecha), movil: 'subtitulo' },
              { clave: 'm', titulo: 'Medios', render: (c: any) => c.medios.map((x: any) => MEDIO_PAGO_LABEL[x.medio as MedioPago]).join(', '), movil: 'meta' },
              { clave: 'e', titulo: 'Estado', render: (c: any) => (c.estado === 'anulado' ? <Insignia tono="gris">Anulado</Insignia> : c.tipo === 'anticipo' ? <Insignia tono="violeta">Anticipo</Insignia> : <Insignia tono="verde">Vigente</Insignia>), movil: 'meta' },
              { clave: 'i', titulo: 'Importe', alinear: 'derecha', render: (c: any) => <span className={c.estado === 'anulado' ? 'text-tenue line-through' : ''}>{money(c.total)}</span>, movil: 'derecha' },
              { clave: 'p', titulo: '', render: (c: any) => <Boton tam="sm" variante="fantasma" icono={<Printer className="size-4" />} onClick={() => window.open(`/imprimir/recibo/${c.id}`, '_blank')} aria-label="Imprimir recibo" />, movil: 'meta' },
            ]}
          />
        </Tarjeta>
      )}
      {cobro && <ModalCobro abierto onCerrar={() => setCobro(false)} clienteId={id!} />}
      {anticipo && <ModalAnticipo clienteFijo={{ id: id!, nombre: data.cliente.nombre } as any} onCerrar={() => setAnticipo(false)} />}
      {reintegro && <ModalReintegro origen={reintegro} onCerrar={() => setReintegro(null)} />}
    </>
  );
}
