import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, getToken, setToken, setUnauthorizedHandler } from "./api";
import type { SessionUser } from "./types";

type AuthState =
  | { status: "loading"; user: null }
  | { status: "anon"; user: null; notice?: string }
  | { status: "authed"; user: SessionUser };

type AuthCtx = {
  state: AuthState;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() =>
    getToken() ? { status: "loading", user: null } : { status: "anon", user: null },
  );

  // Any 401 from a non-auth call → drop the session.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setToken(null);
      setState({ status: "anon", user: null, notice: "Session expired or invalid (401). Please log in again." });
    });
  }, []);

  // Restore session on load.
  useEffect(() => {
    if (!getToken()) return;
    let cancelled = false;
    api
      .me()
      .then(({ user }) => !cancelled && setState({ status: "authed", user }))
      .catch(() => {
        if (cancelled) return;
        setToken(null);
        setState({ status: "anon", user: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const { token, user } = await api.login(email, password);
    setToken(token);
    setState({ status: "authed", user });
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* best effort */
    }
    setToken(null);
    setState({ status: "anon", user: null });
  }, []);

  const value = useMemo(() => ({ state, login, logout }), [state, login, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}

export function useUser(): SessionUser {
  const { state } = useAuth();
  if (state.status !== "authed") throw new Error("useUser requires an authenticated session");
  return state.user;
}
