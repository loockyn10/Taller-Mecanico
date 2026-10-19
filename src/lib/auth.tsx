import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { alPerderSesion, api, ApiError } from './api';
import type { Permiso, Rol } from '@shared/permisos';

export interface Me {
  usuario: { id: string; nombre: string; email: string; rol: Rol };
  permisos: Permiso[];
  taller: { id: string; nombre: string; razon_social: string | null; cuit: string | null; condicion_iva: string; direccion: string | null; localidad: string | null; telefono: string | null; email: string | null };
  licencia: { plan: string; usuarios_incluidos: number; usuarios_adicionales: number; estado: string } | null;
}

interface AuthCtx {
  me: Me | null;
  cargando: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  recargar: () => Promise<void>;
  puede: (p: Permiso) => boolean;
}

const Ctx = createContext<AuthCtx>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [cargando, setCargando] = useState(true);
  const qc = useQueryClient();

  const recargar = useCallback(async () => {
    try {
      setMe(await api.get<Me>('/auth/me'));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setMe(null);
      else throw e;
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    alPerderSesion(() => {
      setMe(null);
      qc.clear();
    });
    recargar().catch(() => setCargando(false));
  }, [recargar, qc]);

  const login = async (email: string, password: string) => {
    await api.post('/auth/login', { email, password });
    qc.clear();
    await recargar();
  };
  const logout = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    qc.clear();
    setMe(null);
  };
  const puede = (p: Permiso) => !!me?.permisos.includes(p);

  return <Ctx.Provider value={{ me, cargando, login, logout, recargar, puede }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
