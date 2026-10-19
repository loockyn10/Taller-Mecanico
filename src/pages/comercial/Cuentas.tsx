import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ClipboardList, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fecha, money, numero } from '@/lib/format';
import { Boton, Cargando, Encabezado, ErrorCaja, Tabla, Tarjeta, Vacio } from '@/components/ui';
import { ModalCobro } from '@/components/Cobro';

export function Cuentas() {
  const nav = useNavigate();
  const { data = [], isLoading, error, refetch } = useQuery({ queryKey: ['cuentas'], queryFn: () => api.get<any[]>('/cuentas-corrientes') });
  const total = data.reduce((a, c) => a + c.saldo, 0);
  return (
    <>
      <Encabezado titulo="Cuentas corrientes" subtitulo={`Clientes con saldo pendiente · total ${money(total)}`} />
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <Tarjeta sinPadding>
          <Tabla
            filas={data}
            clave={(c) => c.id}
            onFila={(c) => nav(`/cuentas/${c.id}`)}
            vacio={<Vacio icono={<ClipboardList className="size-5" />} titulo="Ningún cliente tiene deuda" />}
            columnas={[
              { clave: 'n', titulo: 'Cliente', render: (c) => <span className="font-medium">{c.nombre}</span>, movil: 'titulo' },
              { clave: 't', titulo: 'Teléfono', render: (c) => c.telefono ?? '—', movil: 'subtitulo' },
              { clave: 'cp', titulo: 'Comprobantes', render: (c) => c.comprobantes, movil: 'oculta' },
              { clave: 'd', titulo: 'Deuda desde', render: (c) => fecha(c.deuda_desde), movil: 'meta' },
              { clave: 'f', titulo: 'Facturado', alinear: 'derecha', render: (c) => money(c.facturado), movil: 'oculta' },
              { clave: 'c', titulo: 'Cobrado', alinear: 'derecha', render: (c) => money(c.cobrado), movil: 'oculta' },
              { clave: 's', titulo: 'Saldo', alinear: 'derecha', render: (c) => <span className="font-semibold text-red-600">{money(c.saldo)}</span>, movil: 'derecha' },
            ]}
          />
        </Tarjeta>
      )}
    </>
  );
}

export function CuentaCliente() {
  const { id } = useParams();
  const { puede } = useAuth();
  const [cobro, setCobro] = useState(false);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['cuenta', id], queryFn: () => api.get(`/cuentas-corrientes/${id}`) });
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  return (
    <>
      <Encabezado
        volver
        titulo={`Cuenta de ${data.cliente.nombre}`}
        subtitulo={<>Saldo: <span className={data.saldo > 0 ? 'font-semibold text-red-600' : 'font-semibold'}>{money(data.saldo)}</span></>}
        acciones={
          <>
            <Link to={`/clientes/${id}`}><Boton>Ficha del cliente</Boton></Link>
            {data.saldo > 0 && puede('cobros.registrar') && <Boton variante="exito" icono={<Wallet className="size-4" />} onClick={() => setCobro(true)}>Registrar cobro</Boton>}
          </>
        }
      />
      <Tarjeta titulo="Movimientos" sinPadding>
        <Tabla
          filas={data.movimientos}
          clave={(m: any) => m.id}
          vacio={<p className="px-4 py-6 text-center text-sm text-tenue">Sin movimientos</p>}
          columnas={[
            { clave: 'f', titulo: 'Fecha', render: (m: any) => fecha(m.fecha), movil: 'meta' },
            { clave: 'c', titulo: 'Concepto', render: (m: any) => (m.tipo === 'venta' ? <Link className="text-marca-700" to={`/ventas/${m.id}`}>Comprobante #{numero(m.numero)}</Link> : `Cobro #${numero(m.numero)}`), movil: 'titulo' },
            { clave: 'd', titulo: 'Debe', alinear: 'derecha', render: (m: any) => (m.debe ? money(m.debe) : ''), movil: 'meta' },
            { clave: 'h', titulo: 'Haber', alinear: 'derecha', render: (m: any) => (m.haber ? money(m.haber) : ''), movil: 'meta' },
            { clave: 's', titulo: 'Saldo', alinear: 'derecha', render: (m: any) => <span className="font-medium">{money(m.saldo)}</span>, movil: 'derecha' },
          ]}
        />
      </Tarjeta>
      {cobro && <ModalCobro abierto onCerrar={() => setCobro(false)} clienteId={id!} />}
    </>
  );
}
