'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createSession, endSession, onSessionLost, readSession, setCsrfToken } from '@/lib/api/client';
import type { SessionInfo } from '@/lib/api/types';

type SessionState =
  | { status: 'unknown' }
  | { status: 'anonymous' }
  | { status: 'authenticated'; info: SessionInfo };

interface SessionContextValue {
  state: SessionState;
  /** Exchanges the operator token for a session cookie. Throws `ApiRequestError`. */
  signIn: (operatorToken: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * Holds the session described in API.md §2.
 *
 * The operator token passes through `signIn` and is never stored — not in
 * `localStorage`, not in state, not in a ref. What survives is the `HttpOnly`
 * cookie, which injected script cannot read, and the CSRF token, which is
 * held in memory in `lib/api/client` and is not a credential on its own.
 */
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'unknown' });

  const probe = useCallback(async (signal?: AbortSignal) => {
    try {
      const info = await readSession(signal);
      setCsrfToken(info.csrfToken);
      setState({ status: 'authenticated', info });
    } catch {
      setCsrfToken(null);
      setState({ status: 'anonymous' });
    }
  }, []);

  // §14 bootstrap: ask who am I on page load, and which CSRF token to send.
  useEffect(() => {
    const controller = new AbortController();
    void probe(controller.signal);
    return () => controller.abort();
  }, [probe]);

  // Any request answering 401 means the session went away underneath us —
  // expired, or the API restarted. Drop to the sign-in rather than letting the
  // dashboard sit there showing state it can no longer refresh.
  useEffect(
    () =>
      onSessionLost(() => {
        setCsrfToken(null);
        setState({ status: 'anonymous' });
      }),
    [],
  );

  const signIn = useCallback(async (operatorToken: string) => {
    const info = await createSession(operatorToken);
    setCsrfToken(info.csrfToken);
    setState({ status: 'authenticated', info });
  }, []);

  const signOut = useCallback(async () => {
    try {
      await endSession();
    } finally {
      setCsrfToken(null);
      setState({ status: 'anonymous' });
    }
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({ state, signIn, signOut }),
    [state, signIn, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
