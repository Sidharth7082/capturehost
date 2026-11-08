import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  ApiError,
  fetchMe,
  loginWithPassword,
  logoutRequest,
  setCsrfToken,
  setUnauthorizedHandler,
  verifyTwoFactor,
  type MeResponse,
} from '../api/client';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

export interface AuthContextValue {
  status: AuthStatus;
  user: MeResponse | null;
  error: string | null;
  /** Step 1: returns whether a second factor is required. */
  login: (username: string, password: string) => Promise<{ requires2fa: boolean }>;
  /** Step 2: exchanges a TOTP or recovery code for a full session. */
  verifyCode: (code: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Lets Settings keep 2FA/password state in sync after a change. */
  reloadUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Owns the session on the client.
 *
 * The session itself is a httpOnly cookie the JavaScript cannot read; this
 * context only knows "is there a valid session" (from /api/auth/me) and holds
 * the CSRF token the API expects on writes. A 401 from any request drops the
 * whole app back to /login.
 */
export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyUser = useCallback((me: MeResponse | null) => {
    setUser(me);
    setCsrfToken(me?.csrfToken ?? null);
    setStatus(me ? 'authenticated' : 'anonymous');
  }, []);

  const refresh = useCallback(async () => {
    try {
      const me = await fetchMe();
      applyUser(me);
      setError(null);
    } catch (caught) {
      // A 401 is the normal "not logged in" answer, not an error to show.
      if (caught instanceof ApiError && caught.status === 401) {
        applyUser(null);
        return;
      }
      setError(caught instanceof Error ? caught.message : 'Could not reach the backend');
      applyUser(null);
    }
  }, [applyUser]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Any 401 anywhere in the app (expired or revoked session) logs us out
  // locally, so the router can bounce to /login instead of showing dead panels.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setCsrfToken(null);
      setUser(null);
      setStatus('anonymous');
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const result = await loginWithPassword(username, password);
    // The CSRF token is usable straight away: the login response sets the
    // session cookie, and the token is bound to that session row.
    setCsrfToken(result.csrfToken);

    if (!result.requires2fa) {
      const me = await fetchMe();
      applyUser(me);
    }
    return { requires2fa: result.requires2fa };
  }, [applyUser]);

  const verifyCode = useCallback(async (code: string) => {
    await verifyTwoFactor(code);
    const me = await fetchMe();
    applyUser(me);
  }, [applyUser]);

  const logout = useCallback(async () => {
    try {
      await logoutRequest();
    } catch {
      // Even if the call fails, drop local state: the user asked to leave.
    }
    applyUser(null);
  }, [applyUser]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, error, login, verifyCode, logout, refresh, reloadUser: refresh }),
    [status, user, error, login, verifyCode, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
