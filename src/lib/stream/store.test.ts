import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetStore, silenceBudget } from './store';
import { FakeFetch, FakeStream, errorBody, helloPayload } from './test-stream';
import { onSessionLost, setCsrfToken } from '../api/client';
import type { ServerResource } from '../api/types';

/**
 * Stream liveness.
 *
 * These cover the one behaviour whose failure is invisible: a watchdog that
 * silently stops firing looks exactly like a healthy connection until an
 * operator is reading stale numbers during an incident. Everything here is
 * driven through the real SSE wire format, so the parser is under test too.
 */

const KEEP_ALIVE = 2_000;
const BUDGET = silenceBudget(KEEP_ALIVE); // 5000ms

/** Lets timers fire *and* flush the promise chain the read loop is parked on. */
async function tick(millis: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(millis);
}

/** Yields until the store's async connect/read work has settled. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function serverFixture(name: string, resourceVersion: string): ServerResource {
  return {
    name,
    kind: 'PaperServer',
    apiVersion: 'mcorch.dev/v1alpha1',
    definition: {
      apiVersion: 'mcorch.dev/v1alpha1',
      kind: 'PaperServer',
      metadata: { name },
      spec: {
        image: 'docker.io/itzg/minecraft-server:2026.6.1',
        paper: { minecraftVersion: '1.21.8' },
        eulaAccepted: true,
        maxPlayers: 20,
        network: { port: 25565 },
        resources: { memory: '4Gi', heap: { max: '3276Mi', min: '3276Mi' } },
        storage: { mode: 'persistent', mountPath: '/data', volume: { name } },
        lifecycle: {
          drain: {
            policy: 'waitForZeroPlayers',
            playerTransferTimeout: '2m',
            saveTimeout: '3m',
          },
          stopGracePeriod: '4m',
          startupTimeout: '5m',
        },
      },
    },
    metadata: {
      generation: 1,
      resourceVersion,
      createdAt: '2026-07-30T04:00:00Z',
      updatedAt: '2026-07-30T04:00:00Z',
      deletedAt: null,
      terminating: false,
    },
    status: null,
    statusMeta: null,
    unreadable: null,
    caughtUp: false,
    neverObserved: true,
    display: {
      state: 'PENDING',
      ready: false,
      needsAttention: false,
      unreadable: false,
      drainBlocked: false,
      drainState: null,
      playersOnline: null,
      playersMax: 20,
      proxy: null,
      detail: '',
    },
  };
}

let realFetch: typeof globalThis.fetch;
let store: FleetStore;

beforeEach(() => {
  vi.useFakeTimers();
  realFetch = globalThis.fetch;
  setCsrfToken(null);
  store = new FleetStore();
});

afterEach(() => {
  store.stop();
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

/** Brings a store up to `live` with one server in it. */
async function connectLive(
  fetcher: FakeFetch,
  stream: FakeStream,
  options: { keepAliveMillis?: number } = {},
): Promise<void> {
  fetcher.queueStream(stream);
  fetcher.install();
  store.start();
  await settle();
  stream.sendRetryPreamble(3000);
  stream.send('hello', helloPayload({ keepAliveMillis: options.keepAliveMillis ?? KEEP_ALIVE }), '1');
  stream.send('snapshot', { cursor: '1', count: 1, items: [serverFixture('survival-01', '1')], unreadableCount: 0, unreadable: [] }, '1');
  await settle();
}

describe('liveness watchdog', () => {
  it('treats a ping as proof of life and stays live through an idle fleet', async () => {
    const fetcher = new FakeFetch();
    const stream = new FakeStream();
    await connectLive(fetcher, stream);

    expect(store.getSnapshot().connection).toBe('live');
    expect(store.getSnapshot().hello?.keepAliveMillis).toBe(KEEP_ALIVE);

    // Four keep-alive periods with no fleet change at all — only pings. This is
    // the ordinary state of a healthy orchestrator that nobody is touching.
    for (let beat = 1; beat <= 4; beat += 1) {
      await tick(KEEP_ALIVE);
      stream.send('ping', { at: new Date().toISOString(), cursor: String(10 + beat) }, String(10 + beat));
      await settle();
      expect(store.getSnapshot().connection).toBe('live');
    }

    // Total elapsed is 8s, well past the 5s budget: without pings counting as
    // liveness this would have reconnected. It must not have.
    expect(fetcher.calls).toHaveLength(1);
    expect(store.getSnapshot().lastPingAt).not.toBeNull();
    // And the ping advanced the cursor, so a later resume starts from there.
    expect(store.getSnapshot().cursor).toBe('14');
  });

  it('gives up on a socket that goes quiet and reconnects from the last cursor', async () => {
    const fetcher = new FakeFetch();
    const stream = new FakeStream();
    await connectLive(fetcher, stream);
    expect(store.getSnapshot().connection).toBe('live');

    const resumed = new FakeStream();
    fetcher.queueStream(resumed);

    // Record the transition rather than the end state: a successful reconnect
    // clears `lastError`, so by the time this settles the evidence that the
    // watchdog fired is the state it passed *through*.
    const seen: string[] = [];
    store.subscribe(() => {
      const current = store.getSnapshot();
      if (seen[seen.length - 1] !== current.connection) seen.push(current.connection);
    });

    // The socket stays open — nothing errors, nothing closes — but no ping
    // arrives. This is the half-open connection: a slept laptop, a NAT
    // timeout, a middlebox that dropped the flow silently.
    await tick(BUDGET + 2_500);
    await settle();

    expect(seen).toContain('silent');
    expect(fetcher.calls.length).toBeGreaterThan(1);
    // The reconnect resumes rather than re-listing an idle fleet.
    expect(fetcher.calls[1]).toContain('cursor=1');
    // The fleet is still on screen while this happens — degrade, do not blank.
    expect(store.getSnapshot().servers.size).toBe(1);
  });

  it('derives the threshold from the served keepAliveMillis, not a constant', async () => {
    // §8: "~2.5 keep-alive intervals. Below 2 you will reconnect on ordinary
    // jitter." A server configured slower must widen the budget, not trip it.
    const fetcher = new FakeFetch();
    const stream = new FakeStream();
    await connectLive(fetcher, stream, { keepAliveMillis: 30_000 });

    expect(silenceBudget(30_000)).toBe(75_000);

    // 20s of silence would be fatal at the default cadence and is fine at this
    // one. If the threshold were hard-coded this would reconnect.
    await tick(20_000);
    await settle();
    expect(store.getSnapshot().connection).toBe('live');
    expect(fetcher.calls).toHaveLength(1);
  });

  it('counts a proxy-injected comment as traffic without treating it as an event', async () => {
    const fetcher = new FakeFetch();
    const stream = new FakeStream();
    await connectLive(fetcher, stream);

    await tick(KEEP_ALIVE * 2);
    stream.sendComment('keep-alive');
    await settle();
    await tick(KEEP_ALIVE * 2);
    await settle();

    // Still one connection: the comment reset the clock even though it carried
    // no payload and produced no cursor movement.
    expect(fetcher.calls).toHaveLength(1);
    expect(store.getSnapshot().cursor).toBe('1');
  });
});

describe('reconnect policy', () => {
  it('backs off when the API accepts a stream and closes it immediately', async () => {
    // The regression this pins: a clean `bye` at maxLifetime reconnects with no
    // backoff, and the test for "clean" used to be only "no error recorded" —
    // so a server answering 200 and closing at once was reconnected instantly,
    // forever, as fast as the network allowed.
    const fetcher = new FakeFetch();
    const stream = new FakeStream();
    await connectLive(fetcher, stream);

    stream.close();
    await settle();

    const snapshot = store.getSnapshot();
    expect(snapshot.connection).toBe('reconnecting');
    expect(snapshot.attempt).toBe(1);
    expect(snapshot.retryAt).not.toBeNull();
    expect(snapshot.lastError).toMatch(/closed it immediately/);
    // Crucially: it did NOT immediately redial.
    expect(fetcher.calls).toHaveLength(1);
  });

  it('reconnects at once, without counting an attempt, after a full lifetime', async () => {
    // The other side of the same branch: `bye` at maxLifetimeMillis is ordinary
    // operation and must not be penalised with backoff.
    const fetcher = new FakeFetch();
    const stream = new FakeStream();
    await connectLive(fetcher, stream);

    const next = new FakeStream();
    fetcher.queueStream(next);

    // Stay open past the 5s clean-close grace window, pinging so the watchdog
    // stays content. A real connection reaches this after maxLifetimeMillis.
    for (const cursor of ['2', '3', '4']) {
      await tick(KEEP_ALIVE);
      stream.send('ping', { at: new Date().toISOString(), cursor }, cursor);
      await settle();
    }
    expect(store.getSnapshot().connection).toBe('live');

    stream.send('bye', { reason: 'MAX_LIFETIME', cursor: '4' }, '4');
    stream.close();
    await settle();

    expect(fetcher.calls).toHaveLength(2);
    expect(store.getSnapshot().attempt).toBe(0);
    expect(fetcher.calls[1]).toContain('cursor=4');
  });
});

describe('unreadable rows', () => {
  it('marks a row unreadable without ever deleting it', async () => {
    // §8: the `unreadable` event is emphatically NOT `removed`. The server was
    // declared, its container may well be up with players on it, and treating
    // it as a deletion is the failure the event exists to prevent.
    const fetcher = new FakeFetch();
    const stream = new FakeStream();
    await connectLive(fetcher, stream);
    expect(store.getSnapshot().servers.has('survival-01')).toBe(true);

    stream.send(
      'unreadable',
      { name: 'survival-01', part: 'DESIRED', reason: 'stored definition will not decode', retryable: false },
      '20',
    );
    await settle();

    const snapshot = store.getSnapshot();
    expect(snapshot.servers.has('survival-01')).toBe(true); // the row survives
    expect(snapshot.unreadable).toHaveLength(1);
    expect(snapshot.unreadable[0]?.name).toBe('survival-01');
    expect(snapshot.removalsSuspended).toBe(false);
  });

  it('clears the mark when the row starts decoding again', async () => {
    const fetcher = new FakeFetch();
    const stream = new FakeStream();
    await connectLive(fetcher, stream);

    stream.send(
      'unreadable',
      { name: 'survival-01', part: 'OBSERVED', reason: 'nope', retryable: false },
      '20',
    );
    await settle();
    expect(store.getSnapshot().unreadable).toHaveLength(1);

    // §8: "If it starts decoding again, an ordinary `updated` follows with the
    // full resource."
    stream.send(
      'updated',
      { name: 'survival-01', reason: 'definition', server: serverFixture('survival-01', '9') },
      '21',
    );
    await settle();
    expect(store.getSnapshot().unreadable).toHaveLength(0);
  });

  it('reports removals as suspended while a nameless row exists', async () => {
    // §8: while any unreadable row has `name: null` the API stops emitting
    // `removed` for EVERY row, because a record with no name may be any server
    // whose name column was nulled. A purged server then lingers — so the
    // operator has to be told rather than left with a table quietly going stale.
    const fetcher = new FakeFetch();
    const stream = new FakeStream();
    await connectLive(fetcher, stream);

    stream.send(
      'unreadable',
      { name: null, part: 'DESIRED', reason: 'the record has no name', retryable: false },
      '20',
    );
    await settle();

    expect(store.getSnapshot().removalsSuspended).toBe(true);
    expect(store.getSnapshot().unreadable[0]?.name).toBeNull();
  });

  it('keeps two nameless rows apart instead of collapsing them', async () => {
    // They are indistinguishable to the API, so they cannot be keyed by name —
    // and collapsing them would under-report how many rows need repairing.
    const fetcher = new FakeFetch();
    const stream = new FakeStream();
    await connectLive(fetcher, stream);

    for (const reason of ['first bad row', 'second bad row']) {
      stream.send('unreadable', { name: null, part: 'DESIRED', reason, retryable: false }, '20');
      await settle();
    }
    expect(store.getSnapshot().unreadable).toHaveLength(2);
  });

  it('takes unreadable rows from a snapshot', async () => {
    const fetcher = new FakeFetch();
    const stream = new FakeStream();
    fetcher.queueStream(stream);
    fetcher.install();
    store.start();
    await settle();
    stream.send('hello', helloPayload({ keepAliveMillis: KEEP_ALIVE }), '1');
    stream.send(
      'snapshot',
      {
        cursor: '1',
        count: 1,
        items: [serverFixture('survival-01', '1')],
        unreadableCount: 1,
        unreadable: [{ name: 'broken-01', part: 'DESIRED', reason: 'bad row', retryable: false }],
      },
      '1',
    );
    await settle();

    expect(store.getSnapshot().unreadable).toHaveLength(1);
    expect(store.getSnapshot().servers.size).toBe(1);
  });
});

describe('credential loss', () => {
  it('propagates a 401 on the stream to the session-lost listeners', async () => {
    // The stream is the only always-open connection, so it is usually the first
    // thing to notice a restarted API dropping its in-memory sessions. Without
    // this the dashboard sat looking connected until the operator tried to
    // write something.
    const heard: string[] = [];
    const unsubscribe = onSessionLost(() => heard.push('lost'));

    const fetcher = new FakeFetch();
    fetcher.queueStatus(401, errorBody('UNAUTHENTICATED', 'the session is unknown or has expired'));
    fetcher.install();

    store.start();
    await settle();

    expect(heard).toEqual(['lost']);
    expect(store.getSnapshot().connection).toBe('unauthenticated');
    // It must stop trying: retrying a dead credential is noise, not recovery.
    expect(store.getSnapshot().retryAt).toBeNull();
    await tick(60_000);
    expect(fetcher.calls).toHaveLength(1);

    unsubscribe();
  });

  it('honours Retry-After on a 503 STREAM_LIMIT instead of hammering', async () => {
    const fetcher = new FakeFetch();
    fetcher.queueStatus(503, errorBody('STREAM_LIMIT', 'too many event streams open'), {
      'Retry-After': '7',
    });
    fetcher.install();

    store.start();
    await settle();

    expect(store.getSnapshot().connection).toBe('limited');
    // Nothing at 6s...
    await tick(6_000);
    expect(fetcher.calls).toHaveLength(1);
  });
});
