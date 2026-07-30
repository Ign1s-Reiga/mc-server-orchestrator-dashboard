'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { getMeta } from '@/lib/api/client';
import type { ApiMeta } from '@/lib/api/types';
import { useSession } from './session-provider';

/**
 * `GET /api/v1/meta` — every closed set the API can return **or accept** (§10).
 *
 * Fetched once per session and held here so nothing downstream hard-codes an
 * enumeration. A value added to one of `:schema`'s enums reaches the filters
 * and the create form with no frontend release; `displayState` is `:api`'s own
 * enum rather than `:schema`'s, but it is served here too, so the guarantee
 * holds for it as well.
 *
 * The two spellings matter and are not interchangeable. `phase`, `drainState`,
 * `conditionType`, `conditionStatus`, `failureReason`, `failureClass` and
 * `displayState` are read back and carry Kotlin names (`RUNNING`,
 * `DRAIN_STALLED`). `storageMode` and `drainPolicy` are *written into a
 * definition* and carry YAML wire values (`persistent`, `waitForZeroPlayers`) —
 * a form offering `PERSISTENT` would build a document the parser rejects.
 */
const MetaContext = createContext<ApiMeta | null>(null);

export function MetaProvider({ children }: { children: React.ReactNode }) {
  const { state } = useSession();
  const [meta, setMeta] = useState<ApiMeta | null>(null);
  const authenticated = state.status === 'authenticated';

  useEffect(() => {
    if (!authenticated) {
      setMeta(null);
      return;
    }
    const controller = new AbortController();
    void getMeta(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setMeta(value);
      })
      .catch(() => {
        // A dashboard that cannot render its filters because one auxiliary
        // request failed is worse than one falling back to what it shipped
        // with. Consumers use `?? FALLBACK` below.
      });
    return () => controller.abort();
  }, [authenticated]);

  return <MetaContext.Provider value={meta}>{children}</MetaContext.Provider>;
}

export function useMeta(): ApiMeta | null {
  return useContext(MetaContext);
}

/*
 * Fallbacks, used only while `/meta` is in flight or if it failed.
 *
 * These are the values as of writing. They are not the source of truth — the
 * point of §10 is that the server is — so anything reading them should prefer
 * the served list and treat these as a way to keep rendering, not as a spec.
 */
export const FALLBACK_DISPLAY_STATES = [
  'READY',
  'RUNNING',
  'STARTING',
  'PENDING',
  'DRAINING',
  'TERMINATING',
  'STOPPING',
  'STOPPED',
  'FAILED',
  'UNKNOWN',
] as const;

export const FALLBACK_STORAGE_MODES = ['persistent', 'ephemeral'] as const;
export const FALLBACK_DRAIN_POLICIES = ['waitForZeroPlayers'] as const;
