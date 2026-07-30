'use client';

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ServerResource } from '@/lib/api/types';
import { FleetStore, type FleetSnapshot } from '@/lib/stream/store';
import { useSession } from './session-provider';

const FleetContext = createContext<FleetStore | null>(null);

/**
 * Owns the one connection to `GET /api/v1/stream`.
 *
 * One stream per tab, not one per screen: `maxStreams` is 16 across the whole
 * deployment (§8), and a dashboard that opened a second connection per route
 * would spend that budget on itself.
 */
export function FleetProvider({ children }: { children: React.ReactNode }) {
  const { state } = useSession();
  const [store] = useState(() => new FleetStore());
  const authenticated = state.status === 'authenticated';

  useEffect(() => {
    if (!authenticated) return;
    store.start();
    return () => store.stop();
  }, [authenticated, store]);

  useEffect(() => {
    if (!authenticated) return;
    // A backgrounded tab routinely has its connection frozen or dropped without
    // an error ever surfacing. Coming back to the tab is the moment to check,
    // not the moment to trust.
    const onVisible = () => {
      if (document.visibilityState === 'visible') store.revalidate();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [authenticated, store]);

  return <FleetContext.Provider value={store}>{children}</FleetContext.Provider>;
}

function useStore(): FleetStore {
  const store = useContext(FleetContext);
  if (store === null) throw new Error('fleet hooks must be used inside FleetProvider');
  return store;
}

const SERVER_SSR_FALLBACK = undefined;

export function useFleet(): FleetSnapshot {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * One server by name.
 *
 * The store keeps object identity for servers whose definition and status
 * versions did not move, so a component watching `survival-01` does not
 * re-render because `lobby-02` gained a player.
 */
export function useServer(name: string): ServerResource | undefined {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().servers.get(name),
    () => SERVER_SSR_FALLBACK,
  );
}

export function useFleetActions(): Pick<FleetStore, 'merge' | 'reconnectNow' | 'resyncNow'> {
  const store = useStore();
  return useMemo(
    () => ({
      merge: (server: ServerResource) => store.merge(server),
      reconnectNow: () => store.reconnectNow(),
      resyncNow: () => store.resyncNow(),
    }),
    [store],
  );
}

/** A ticking clock for relative timestamps, so ages do not freeze on screen. */
export function useNow(intervalMillis = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMillis);
    return () => clearInterval(timer);
  }, [intervalMillis]);
  return now;
}
