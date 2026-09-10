import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError } from "@/api/client";
import { fetchMe, login as loginRequest, logout as logoutRequest, type GxUser } from "@/api/auth";
import { clearSession, loadToken } from "@/api/session";

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthContextValue {
  status: AuthStatus;
  user: GxUser | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Restores and owns the session. On mount it loads the stored token and asks
 * `/api/auth/me` whether it is still valid; a 401 clears the session and drops
 * to the login screen. Uses the existing GX account system — no separate mobile
 * user store (brief §12).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<GxUser | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const token = await loadToken();
      if (!token) {
        if (active) setStatus("unauthenticated");
        return;
      }
      try {
        const me = await fetchMe();
        if (!active) return;
        setUser(me);
        setStatus("authenticated");
      } catch (error) {
        if (!active) return;
        // Only an actual auth failure should log the user out; a transient
        // network error keeps the stored session so a flaky connection at
        // launch doesn't force a re-login.
        if (error instanceof ApiError && error.isUnauthorized) {
          await clearSession();
          setStatus("unauthenticated");
        } else {
          // Trust the stored token optimistically; screens surface data errors.
          setStatus("authenticated");
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const me = await loginRequest(email, password);
    setUser(me);
    setStatus("authenticated");
  }, []);

  const signOut = useCallback(async () => {
    await logoutRequest();
    setUser(null);
    setStatus("unauthenticated");
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, signIn, signOut }),
    [status, user, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within an AuthProvider.");
  return context;
}
