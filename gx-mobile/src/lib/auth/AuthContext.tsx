import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { ApiError, apiGet, apiPost } from '@/lib/api/client';

type AuthUser = { id: string; email: string };

type AuthState = {
  user: AuthUser | null;
  checking: boolean;
  error: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGet<{ user: AuthUser }>('/api/auth/me')
      .then((payload) => {
        if (!cancelled) setUser(payload.user);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      const payload = await apiPost<{ user: AuthUser }>('/api/auth/login', { email, password });
      setUser(payload.user);
    } catch (reason) {
      const message = reason instanceof ApiError ? reason.message : 'Could not reach the workspace. Try again.';
      setError(message);
      throw reason;
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await apiPost('/api/auth/logout');
    } finally {
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({ user, checking, error, signIn, signOut }),
    [user, checking, error, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
