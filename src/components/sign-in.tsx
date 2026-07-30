'use client';

import { useState } from 'react';
import { useSession } from './session-provider';
import { describeError, isApiError } from '@/lib/api/errors';
import { Button, Note } from './ui';

/**
 * The token exchange from §2.
 *
 * The operator token is typed here, sent once as `Authorization: Bearer`, and
 * forgotten. What persists is the `HttpOnly` session cookie — which is the
 * whole reason this screen exists rather than the dashboard keeping a bearer
 * token around: `EventSource` cannot set a header, and a token in
 * `localStorage` is one that injected script can post anywhere.
 */
export function SignIn() {
  const { signIn } = useSession();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiReachable, setApiReachable] = useState<boolean | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (token.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(token);
      setToken('');
    } catch (cause) {
      if (isApiError(cause) && cause.code === 'UNAUTHENTICATED') {
        setError('That token was not accepted.');
        // Tell "wrong token" apart from "the orchestrator is not running" —
        // /healthz is the one unauthenticated route and touches no state.
        try {
          const probe = await fetch('/api/healthz', { cache: 'no-store' });
          setApiReachable(probe.ok);
        } catch {
          setApiReachable(false);
        }
      } else {
        setError(describeError(cause));
        setApiReachable(null);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-dvh grid place-items-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <div className="mono text-[22px] font-semibold tracking-tight">mcorch</div>
          <p className="text-[13px] mt-1" style={{ color: 'var(--text-dim)' }}>
            Operator dashboard. Sign in with the token the orchestrator was started with.
          </p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="label" htmlFor="operator-token">
            operator token
          </label>
          <input
            id="operator-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            className="mono text-[13px] px-3 h-9 border rounded-sm w-full"
            style={{ background: 'var(--bg-raised)', color: 'var(--text)' }}
            placeholder="MCORCH_API_TOKEN"
            aria-describedby="operator-token-hint"
          />
          <p id="operator-token-hint" className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
            Exchanged once for a session cookie. The token itself is not stored anywhere in this
            browser.
          </p>

          <Button
            type="submit"
            variant="primary"
            disabled={busy || token.length === 0}
            className="w-full mt-1"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        {error !== null && (
          <div className="mt-4">
            <Note tone="fault" title="sign-in failed">
              {error}
              {apiReachable === false &&
                ' The orchestrator API also did not answer its health check, so it may not be running.'}
              {apiReachable === true && ' The API is running, so the token is the problem.'}
            </Note>
          </div>
        )}
      </div>
    </main>
  );
}
