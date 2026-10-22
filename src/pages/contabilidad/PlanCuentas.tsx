// Plan de cuentas del taller: consulta con saldos, alta y edición de cuentas y asignación de cuentas a las categorías de gasto.
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { descargarCSV, exportarAutorizado, pesosCSV } from '@/lib/csv';
import { money } from '@/lib/format';
import { Aviso, Boton, Buscador, Campo, Cargando, Check, ErrorCaja, Input, Insignia, Modal, Select, Tarjeta, Textarea, useConfirmar, useToast } from '@/components/ui';
import { TIPO_LABEL, TIPOS_CUENTA } from '@shared/contabilidad';
import { BotonImprimir } from './comun';

interface Cuenta {
  id: string; codigo: string; nombre: string; tipo: string; naturaleza: string; padre_id: string | null; imputable: number; rol: string | null; cuenta_bancaria_id: string | null;
  activa: number; notas: string | null; debe: number; haber: number; movimientos: number; saldo: number;
}

function profundidad(c: Cuenta, porId: Map<string, Cuenta>) {
  let n = 0;
  for (let p = c.padre_id ? porId.get(c.padre_id) : undefined; p && n < 8; p = p.padre_id ? porId.get(p.padre_id) : undefined) n++;
  return n;
}

function FormCuenta({ cuenta, cuentas, onCerrar }: { cuenta: Cuenta | null; cuentas: Cuenta[]; onCerrar: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const sistema = !!(cuenta?.rol || cuenta?.cuenta_bancaria_id);
  const [f, setF] = useState({
    codigo: cuenta?.codigo ?? '', nombre: cuenta?.nombre ?? '', tipo: cuenta?.tipo ?? 'gasto', padre_id: cuenta?.padre_id ?? '', imputable: cuenta ? !!cuenta.imputable : true,
    contra: false, notas: cuenta?.notas ?? '', activa: cuenta ? !!cuenta.activa : true,
  });
  const rubros = cuentas.filter((c) => !c.imputable && c.tipo === f.tipo && c.id !== cuenta?.id);
  const guardar = useMutation({
    mutationFn: () =>
      cuenta
        ? api.put(`/contabilidad/cuentas/${cuenta.id}`, {
            codigo: f.codigo, nombre: f.nombre, notas: f.notas || null, activa: f.activa, padre_id: f.padre_id || null,
            ...(sistema || cuenta.movimientos ? {} : { imputable: f.imputable }),
          })
        : api.post('/contabilidad/cuentas', { codigo: f.codigo, nombre: f.nombre, tipo: f.tipo, padre_id: f.padre_id || null, imputable: f.imputable, contra: f.contra, notas: f.notas || null }),
    onSuccess: () => {
      toast.ok(cuenta ? 'Cuenta actualizada' : 'Cuenta creada');
      qc.invalidateQueries({ queryKey: ['contab'] });
      onCerrar();
    },
    onError: toast.error,
  });
  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo={cuenta ? `Cuenta ${cuenta.codigo}` : 'Nueva cuenta'}
      pie={<><Boton onClick={onCerrar}>Cancelar</Boton><Boton variante="primario" cargando={guardar.isPending} disabled={!f.codigo || f.nombre.trim().length < 2} onClick={() => guardar.mutate()}>Guardar</Boton></>}
    >
      <div className="space-y-3">
        {sistema && <Aviso>Es una cuenta del sistema: la usa la contabilización automática. Podés cambiar su nombre, código y notas, pero no eliminarla ni desactivarla.</Aviso>}
        {cuenta && cuenta.movimientos > 0 && !sistema && <Aviso tono="ambar">Tiene movimientos: no se puede eliminar ni cambiar su tipo. Podés renombrarla o desactivarla para que no reciba nuevos asientos.</Aviso>}
        <div className="grid grid-cols-3 gap-3">
          <Campo label="Código" requerido hint="Ej. 6.1.11"><Input value={f.codigo} onChange={(e) => setF({ ...f, codigo: e.target.value.trim() })} /></Campo>
          <Campo label="Nombre" requerido className="col-span-2"><Input value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} maxLength={120} /></Campo>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Campo label="Tipo">
            <Select value={f.tipo} disabled={!!cuenta} onChange={(e) => setF({ ...f, tipo: e.target.value, padre_id: '' })}>
              {TIPOS_CUENTA.map((t) => <option key={t} value={t}>{TIPO_LABEL[t]}</option>)}
            </Select>
          </Campo>
          <Campo label="Rubro (agrupa la cuenta)">
            <Select value={f.padre_id} onChange={(e) => setF({ ...f, padre_id: e.target.value })}>
              <option value="">— Sin rubro —</option>
              {rubros.map((r) => <option key={r.id} value={r.id}>{r.codigo} {r.nombre}</option>)}
            </Select>
          </Campo>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Check checked={f.imputable} disabled={sistema || (!!cuenta && cuenta.movimientos > 0)} onChange={(v) => setF({ ...f, imputable: v })} label="Recibe asientos (si no, es un rubro que agrupa cuentas)" />
          {!cuenta && f.tipo !== 'patrimonio' && <Check checked={f.contra} onChange={(v) => setF({ ...f, contra: v })} label="Cuenta regularizadora (resta; p. ej. devoluciones)" />}
          {cuenta && <Check checked={f.activa} disabled={sistema} onChange={(v) => setF({ ...f, activa: v })} label="Activa" />}
        </div>
        <Campo label="Notas"><Textarea rows={2} value={f.notas} onChange={(e) => setF({ ...f, notas: e.target.value })} maxLength={300} /></Campo>
      </div>
    </Modal>
  );
}

function CategoriasGasto({ cuentas, puedeEditar }: { cuentas: Cuenta[]; puedeEditar: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['contab', 'categorias-gasto'], queryFn: () => api.get('/contabilidad/categorias-gasto') });
  const asignar = useMutation({
    mutationFn: ({ id, cuenta_id }: { id: string; cuenta_id: string | null }) => api.put(`/contabilidad/categorias-gasto/${id}`, { cuenta_id }),
    onSuccess: () => { toast.ok('Asignación guardada: rige para los gastos nuevos'); qc.invalidateQueries({ queryKey: ['contab', 'categorias-gasto'] }); },
    onError: toast.error,
  });
  const destino = cuentas.filter((c) => c.imputable && c.activa && ['gasto', 'costo'].includes(c.tipo));
  return (
    <Tarjeta titulo="Cuenta contable de cada categoría de gasto" subtitulo="Cada gasto que se registra se asienta en la cuenta de su categoría. Lo ya contabilizado no cambia.">
      {isLoading ? <Cargando /> : error ? <ErrorCaja error={error} reintentar={refetch} /> : (
        <ul className="divide-y divide-borde">
          {data.map((g: any) => (
            <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span className="font-medium">{g.nombre}{!g.activa && <span className="ml-2 text-xs text-tenue">(desactivada)</span>}</span>
              {puedeEditar ? (
                <Select className="w-full sm:w-80" value={g.es_por_defecto ? '' : g.cuenta?.id ?? ''} onChange={(e) => asignar.mutate({ id: g.id, cuenta_id: e.target.value || null })}>
                  <option value="">{g.cuenta ? `Por defecto: ${g.cuenta.codigo} ${g.cuenta.nombre}` : 'Por defecto'}</option>
                  {destino.map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.nombre}</option>)}
                </Select>
              ) : <span className="text-tenue">{g.cuenta ? `${g.cuenta.codigo} ${g.cuenta.nombre}` : '—'}</span>}
            </li>
          ))}
        </ul>
      )}
    </Tarjeta>
  );
}

export function PlanCuentas({ hasta }: { hasta: string }) {
  const { puede } = useAuth();
  const gestiona = puede('contabilidad.gestionar');
  const toast = useToast();
  const qc = useQueryClient();
  const { confirmar, dialogo } = useConfirmar();
  const [q, setQ] = useState('');
  const [editando, setEditando] = useState<Cuenta | 'nueva' | null>(null);
  const { data, isLoading, error, refetch } = useQuery<Cuenta[]>({ queryKey: ['contab', 'plan', hasta], queryFn: () => api.get(`/contabilidad/plan?hasta=${hasta}`) });
  const porId = useMemo(() => new Map((data ?? []).map((c) => [c.id, c])), [data]);
  const filas = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (data ?? []).filter((c) => !t || c.codigo.startsWith(t) || c.nombre.toLowerCase().includes(t));
  }, [data, q]);
  if (isLoading) return <Cargando />;
  if (error) return <ErrorCaja error={error} reintentar={refetch} />;
  const eliminar = async (c: Cuenta) => {
    if (!(await confirmar('Eliminar cuenta', `¿Eliminar la cuenta ${c.codigo} ${c.nombre}? Solo se puede si no tiene movimientos.`, true))) return;
    try {
      await api.del(`/contabilidad/cuentas/${c.id}`);
      toast.ok('Cuenta eliminada');
      qc.invalidateQueries({ queryKey: ['contab'] });
    } catch (e) {
      toast.error(e);
    }
  };
  const exportar = () => exportarAutorizado('/contabilidad/plan', () => descargarCSV(`plan-de-cuentas-${hasta}`, ['Código', 'Cuenta', 'Tipo', 'Imputable', 'Estado', 'Saldo'], filas.map((c) => [c.codigo, c.nombre, TIPO_LABEL[c.tipo as keyof typeof TIPO_LABEL], c.imputable ? 'Sí' : 'Rubro', c.activa ? 'Activa' : 'Inactiva', pesosCSV(c.saldo)]))).catch((e) => toast.error(e));
  return (
    <div className="space-y-5">
      <div className="no-print flex flex-wrap items-end gap-3">
        <Buscador value={q} onChange={setQ} placeholder="Código o nombre…" className="min-w-52 flex-1" />
        <Boton icono={<Download className="size-4" />} onClick={exportar}>CSV</Boton>
        <BotonImprimir />
        {gestiona && <Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => setEditando('nueva')}>Nueva cuenta</Boton>}
      </div>
      <Tarjeta sinPadding titulo="Plan de cuentas" subtitulo={`Saldos al ${hasta.split('-').reverse().join('/')} · el saldo está en el sentido normal de cada cuenta`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-borde bg-slate-50/70 text-left text-xs font-semibold uppercase tracking-wide text-tenue">
                <th className="px-4 py-2.5">Código</th><th className="px-4 py-2.5">Cuenta</th><th className="hidden px-4 py-2.5 sm:table-cell">Tipo</th><th className="px-4 py-2.5 text-right">Saldo</th><th className="no-print w-24 px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {filas.map((c) => (
                <tr key={c.id} className={`border-b border-borde last:border-0 ${c.imputable ? '' : 'bg-slate-50/50 font-semibold'} ${c.activa ? '' : 'text-tenue'}`}>
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums">{c.codigo}</td>
                  <td className="px-4 py-2" style={{ paddingLeft: 16 + profundidad(c, porId) * 14 }}>
                    {c.nombre}
                    {c.rol && <span className="ml-2 align-middle"><Insignia>Sistema</Insignia></span>}
                    {c.cuenta_bancaria_id && <span className="ml-2 align-middle"><Insignia tono="azul">Cuenta bancaria</Insignia></span>}
                    {!c.activa && <span className="ml-2 align-middle"><Insignia tono="ambar">Inactiva</Insignia></span>}
                  </td>
                  <td className="hidden px-4 py-2 text-tenue sm:table-cell">{TIPO_LABEL[c.tipo as keyof typeof TIPO_LABEL]}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">{c.movimientos || !c.imputable ? money(c.saldo) : '—'}</td>
                  <td className="no-print px-4 py-2 text-right">
                    {gestiona && (
                      <span className="inline-flex gap-1">
                        <button title="Editar" className="rounded p-1.5 text-tenue hover:bg-slate-100" onClick={() => setEditando(c)}><Pencil className="size-4" /></button>
                        {!c.rol && !c.cuenta_bancaria_id && !c.movimientos && <button title="Eliminar" className="rounded p-1.5 text-tenue hover:bg-red-50 hover:text-red-600" onClick={() => eliminar(c)}><Trash2 className="size-4" /></button>}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Tarjeta>
      <div className="no-print"><CategoriasGasto cuentas={data ?? []} puedeEditar={gestiona} /></div>
      {editando && <FormCuenta cuenta={editando === 'nueva' ? null : editando} cuentas={data ?? []} onCerrar={() => setEditando(null)} />}
      {dialogo}
    </div>
  );
}
