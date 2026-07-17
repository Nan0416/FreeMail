import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { FreeMailClient } from '../api/client.js';

type Status = 'loading' | 'authenticated' | 'unauthenticated';

export interface AuthContextValue {
  status: Status;
  /** The authenticated subject (single-tenant owner), or null when signed out. */
  subject: string | null;
  client: FreeMailClient;
  /** Sign in with the account password. */
  login: (password: string) => Promise<void>;
  /** First-run: set the password, then sign in with it. */
  setPasswordAndLogin: (password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  apiBaseUrl: string;
  /** Injectable for tests (fetch stub). */
  fetchImpl?: typeof fetch;
  children: React.ReactNode;
}

export function AuthProvider({
  apiBaseUrl,
  fetchImpl,
  children,
}: AuthProviderProps): React.JSX.Element {
  const [status, setStatus] = useState<Status>('loading');
  const [subject, setSubject] = useState<string | null>(null);

  const client = useMemo(
    () =>
      new FreeMailClient({
        baseUrl: apiBaseUrl,
        fetchImpl,
        onAuthLost: () => {
          setSubject(null);
          setStatus('unauthenticated');
        },
      }),
    [apiBaseUrl, fetchImpl],
  );

  // The session cookies are httpOnly, so the SPA cannot tell whether it has one
  // without asking the server: probe `/me` on boot (it transparently tries a cookie
  // refresh first), and drop to sign-in if there is no valid session.
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current) {
      return;
    }
    bootstrapped.current = true;
    client
      .getSession()
      .then((session) => {
        setSubject(session.subject);
        setStatus('authenticated');
      })
      .catch(() => {
        setSubject(null);
        setStatus('unauthenticated');
      });
  }, [client]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      subject,
      client,
      login: async (password) => {
        const session = await client.login(password);
        setSubject(session.subject);
        setStatus('authenticated');
      },
      setPasswordAndLogin: async (password) => {
        await client.setPassword(password);
        const session = await client.login(password);
        setSubject(session.subject);
        setStatus('authenticated');
      },
      logout: async () => {
        await client.logout();
        setSubject(null);
        setStatus('unauthenticated');
      },
    }),
    [status, subject, client],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used within an AuthProvider.');
  }
  return value;
}
