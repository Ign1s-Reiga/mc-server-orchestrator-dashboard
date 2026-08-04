import { API_BASE, notifySessionLost } from '../api/client';
import { toApiError } from '../api/errors';
import type { ServerResource, StreamEvent, UnreadableServer } from '../api/types';
import { SseParser } from './sse';

/**
 * How honest the dashboard is being about what it is showing.
 *
 * `live` is claimed only while frames are actually arriving. Everything else
 * is a degraded mode the operator gets told about, because state that is
 * quietly minutes old is worse than an admission that contact was lost.
 */
export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'live'
  /** Open, but no frame for longer than the keep-alive promises. Reconnecting. */
  | 'silent'
  | 'reconnecting'
  /** 503 STREAM_LIMIT — every stream slot upstream is taken. Retryable. */
  | 'limited'
  | 'unauthenticated'
  | 'stopped';

export interface FleetSnapshot {
  /** Keyed by name. Entries keep identity across events that did not change them. */
  readonly servers: ReadonlyMap<string, ServerResource>;
  /** Names sorted the way the API sorts its list. */
  readonly order: readonly string[];
  /**
   * Rows the store has a name for and whose *definition* will not decode, so
   * there is no resource to render (§6).
   *
   * Kept rather than dropped, because absence is how a purge is reported:
   * omitting one would silently report a deletion that never happened, on a
   * server that may still be running with players on it. They are also never
   * filtered — a row with no readable definition cannot answer "is it READY" or
   * "does it carry this label", so any filter would drop it.
   */
  readonly unreadable: readonly UnreadableServer[];
  /**
   * True while any unreadable row has `name: null`.
   *
   * §8: in that situation the API stops emitting `removed` **for every row**,
   * because a record with no name cannot be matched against anything and may be
   * any server whose name column was nulled. A genuinely purged server then
   * lingers in this table until the row is repaired or the connection cycles
   * into a fresh snapshot — so the operator has to be told.
   */
  readonly removalsSuspended: boolean;
  readonly connection: ConnectionState;
  /** Whether a snapshot has ever arrived. Distinguishes "empty fleet" from "no data yet". */
  readonly primed: boolean;
  /** `Date.now()` of the last frame of any kind. What the watchdog measures. */
  readonly lastFrameAt: number | null;
  /** `Date.now()` of the last `ping` — the API's explicit liveness beat. */
  readonly lastPingAt: number | null;
  /** `Date.now()` of the last event that carried fleet data. */
  readonly lastDataAt: number | null;
  readonly cursor: string | null;
  readonly hello: {
    changePollMillis: number;
    statusPollMillis: number;
    keepAliveMillis: number;
    maxLifetimeMillis: number;
    /** The SSE `retry:` value this client deliberately overrides. */
    reconnectMillis: number;
    resumed: boolean;
  } | null;
  /**
   * Set when the API said `expired`: the change log had rolled past our cursor,
   * so some intermediate states were never delivered. A snapshot follows and
   * the set converges, but the gap is real and is worth admitting once.
   */
  readonly historyGap: { at: number; message: string } | null;
  readonly attempt: number;
  /** `Date.now()` at which the next connection attempt fires. */
  readonly retryAt: number | null;
  readonly lastError: string | null;
}

const EMPTY: FleetSnapshot = {
  servers: new Map(),
  order: [],
  unreadable: [],
  removalsSuspended: false,
  connection: 'idle',
  primed: false,
  lastFrameAt: null,
  lastPingAt: null,
  lastDataAt: null,
  cursor: null,
  hello: null,
  historyGap: null,
  attempt: 0,
  retryAt: null,
  lastError: null,
};

/**
 * Fallback for `keepAliveMillis` until `hello` supplies the real number.
 *
 * The server is the authority — it is in `hello` and in `meta.stream` — so this
 * only covers the sub-second window before `hello` lands.
 */
const DEFAULT_KEEP_ALIVE_MILLIS = 15_000;

/**
 * Silence tolerated before the stream is treated as dead.
 *
 * §8: "~2.5 keep-alive intervals. Below 2 you will reconnect on ordinary
 * jitter." A `ping` is due every `keepAliveMillis` whether or not anything
 * changed, so missing two in a row is a socket nothing is coming out of — but
 * one late one is a scheduler hiccup, not an outage.
 */
export function silenceBudget(keepAliveMillis: number): number {
  return Math.round(keepAliveMillis * 2.5);
}

const BACKOFF_MIN_MILLIS = 500;
const BACKOFF_MAX_MILLIS = 30_000;

function backoffMillis(attempt: number): number {
  const base = Math.min(BACKOFF_MAX_MILLIS, BACKOFF_MIN_MILLIS * 2 ** Math.max(0, attempt - 1));
  // Jitter, so a restarted API is not hit by every open tab on the same tick.
  return Math.round(base * (0.7 + Math.random() * 0.6));
}

function sameVersion(a: ServerResource, b: ServerResource): boolean {
  return (
    a.metadata.resourceVersion === b.metadata.resourceVersion &&
    (a.statusMeta?.resourceVersion ?? null) === (b.statusMeta?.resourceVersion ?? null)
  );
}

/**
 * The live fleet, fed by `GET /api/v1/stream`.
 *
 * A `useSyncExternalStore` source: `snapshot` is replaced wholesale on every
 * change, but individual `ServerResource` objects keep their identity when
 * their versions did not move, so a component watching one server does not
 * re-render because a different one did.
 */
export class FleetStore {
  private snapshot: FleetSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();

  private controller: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private generation = 0;

  getSnapshot = (): FleetSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(patch: Partial<FleetSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  /* ------------------------------------------------------------ lifecycle */

  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    this.set({ connection: 'connecting', attempt: 0, retryAt: null, lastError: null });
    this.startWatchdog();
    void this.connect(this.generation);
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.watchdog !== null) clearInterval(this.watchdog);
    this.watchdog = null;
    this.set({ connection: 'stopped', retryAt: null });
  }

  /** Drops the current connection and reconnects now, from the current cursor. */
  reconnectNow(): void {
    if (!this.running) {
      this.start();
      return;
    }
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.generation += 1;
    this.controller?.abort();
    this.set({ connection: 'connecting', attempt: 0, retryAt: null });
    void this.connect(this.generation);
  }

  /**
   * Forces a full re-read by reconnecting with an empty cursor.
   *
   * §8: "`?cursor=` set to the empty string forces a snapshot". The escape
   * hatch for an operator who does not trust what is on screen.
   */
  resyncNow(): void {
    this.set({ cursor: null, historyGap: null });
    this.reconnectNow();
  }

  /**
   * Replaces one server from a direct read.
   *
   * A mutation's own response body is the most current thing the client has;
   * folding it in closes the up-to-two-second window before the stream would
   * have said the same thing. It is still observed state from the API, never a
   * guess about what the reconcile loop is going to do.
   */
  merge(server: ServerResource): void {
    const existing = this.snapshot.servers.get(server.name);
    if (existing !== undefined && sameVersion(existing, server)) return;
    const servers = new Map(this.snapshot.servers);
    servers.set(server.name, server);
    this.set({ servers, order: [...servers.keys()].sort() });
  }

  /* ------------------------------------------------------------ watchdog */

  private startWatchdog(): void {
    if (this.watchdog !== null) clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      const { connection, lastFrameAt, hello } = this.snapshot;
      if (connection !== 'live' || lastFrameAt === null) return;
      const budget = silenceBudget(hello?.keepAliveMillis ?? DEFAULT_KEEP_ALIVE_MILLIS);
      if (Date.now() - lastFrameAt > budget) {
        // The socket is open as far as the runtime is concerned but nothing is
        // coming out of it. §8: an open readyState is not evidence of liveness,
        // a recent `ping` is. Do not keep claiming this data is live.
        this.set({
          connection: 'silent',
          lastError: 'the stream went quiet — no ping within the promised window',
        });
        this.reconnectNow();
      }
    }, 2_000);
  }

  /**
   * Called when the tab becomes visible again.
   *
   * A backgrounded tab's connection is routinely killed or frozen without an
   * error ever surfacing, so returning to the tab is the moment to re-verify
   * rather than to trust.
   */
  revalidate(): void {
    if (!this.running) return;
    const { connection, lastFrameAt, hello } = this.snapshot;
    if (connection === 'live' && lastFrameAt !== null) {
      const budget = silenceBudget(hello?.keepAliveMillis ?? DEFAULT_KEEP_ALIVE_MILLIS);
      if (Date.now() - lastFrameAt <= budget) return;
    }
    if (connection === 'unauthenticated' || connection === 'stopped') return;
    this.reconnectNow();
  }

  /* ---------------------------------------------------------- connection */

  private scheduleRetry(generation: number, overrideMillis?: number): void {
    if (!this.running || generation !== this.generation) return;
    const attempt = this.snapshot.attempt + 1;
    const delay = overrideMillis ?? backoffMillis(attempt);
    this.set({
      connection: this.snapshot.connection === 'limited' ? 'limited' : 'reconnecting',
      attempt,
      retryAt: Date.now() + delay,
    });
    this.retryTimer = setTimeout(() => {
      if (!this.running || generation !== this.generation) return;
      void this.connect(generation);
    }, delay);
  }

  private async connect(generation: number): Promise<void> {
    if (!this.running || generation !== this.generation) return;

    const controller = new AbortController();
    this.controller = controller;

    // §8: with no cursor the stream opens with a full snapshot, so there is no
    // window between listing and subscribing in which a change can be lost.
    // With one, it resumes — and `?cursor=` wins over `Last-Event-ID`.
    const cursor = this.snapshot.cursor;
    const url = cursor === null ? `${API_BASE}/stream` : `${API_BASE}/stream?cursor=${encodeURIComponent(cursor)}`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: 'text/event-stream' },
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted || generation !== this.generation) return;
      this.set({ lastError: 'the dashboard could not reach the API' });
      this.scheduleRetry(generation);
      return;
    }

    if (generation !== this.generation) return;

    if (!response.ok) {
      const error = await toApiError(response);
      if (error.code === 'UNAUTHENTICATED') {
        this.set({ connection: 'unauthenticated', retryAt: null, lastError: error.message });
        // The always-open connection is usually the first to find out — an API
        // restart drops its in-memory sessions. Tell the shell, so it shows the
        // sign-in instead of a dashboard frozen at whatever it last saw.
        notifySessionLost();
        return;
      }
      if (error.code === 'STREAM_LIMIT') {
        // Retryable and self-inflicted: another tab or a script holds the slot.
        this.set({ connection: 'limited', lastError: error.message });
        this.scheduleRetry(generation, (error.retryAfterSeconds ?? 5) * 1000);
        return;
      }
      this.set({ lastError: error.message });
      this.scheduleRetry(generation);
      return;
    }

    if (response.body === null) {
      this.set({ lastError: 'the stream carried no body' });
      this.scheduleRetry(generation);
      return;
    }

    const openedAt = Date.now();
    this.set({ connection: 'live', attempt: 0, retryAt: null, lastError: null, lastFrameAt: openedAt });

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    const parser = new SseParser();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (generation !== this.generation) return;
        for (const frame of parser.push(value)) {
          // Any frame is evidence the socket is alive; `ping` is the one the
          // API guarantees on an idle fleet, and is what the watchdog relies on.
          this.set({ lastFrameAt: Date.now() });
          if (frame.comment) continue; // not sent by this API; liveness only
          if (frame.id !== null) this.set({ cursor: frame.id });
          this.apply(frame.event, frame.data);
        }
      }
    } catch {
      // A read error is a dropped connection; fall through to the retry below.
    }

    if (!this.running || generation !== this.generation) return;

    // The stream ended. `bye` at max lifetime is the ordinary case and is not
    // an error — §8 notes the resume path is exercised in normal operation
    // rather than only after a failure — so reconnect immediately and without
    // counting it as a failed attempt.
    //
    // "Lasted a while" is part of the test on purpose. A connection that opens
    // 200 OK and closes straight away is not a clean lifetime rollover, it is a
    // sick server, and treating it as clean would spin this loop as fast as the
    // network allows. Anything shorter than the grace window backs off instead.
    const CLEAN_CLOSE_GRACE_MILLIS = 5_000;
    const lasted = Date.now() - openedAt;
    if (
      this.snapshot.connection === 'live' &&
      this.snapshot.lastError === null &&
      lasted >= CLEAN_CLOSE_GRACE_MILLIS
    ) {
      this.set({ connection: 'connecting' });
      void this.connect(generation);
      return;
    }
    if (lasted < CLEAN_CLOSE_GRACE_MILLIS && this.snapshot.lastError === null) {
      this.set({ lastError: 'the API accepted the stream and then closed it immediately' });
    }
    this.scheduleRetry(generation);
  }

  /* -------------------------------------------------------------- events */

  private apply(eventName: string, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.set({ lastError: `the API sent a ${eventName} event this client could not parse` });
      return;
    }
    const event = { type: eventName, data: parsed } as StreamEvent;

    switch (event.type) {
      case 'hello': {
        // The cadences are the server's to decide, so the watchdog threshold is
        // derived from `keepAliveMillis` rather than hard-coded here.
        this.set({
          hello: {
            changePollMillis: event.data.changePollMillis,
            statusPollMillis: event.data.statusPollMillis,
            keepAliveMillis: event.data.keepAliveMillis,
            maxLifetimeMillis: event.data.maxLifetimeMillis,
            reconnectMillis: event.data.reconnectMillis,
            resumed: event.data.resumed,
          },
          cursor: event.data.cursor,
          connection: 'live',
        });
        return;
      }
      case 'ping': {
        // The liveness beat. It carries the cursor, so if the watchdog does
        // fire, the reconnect resumes from here rather than re-listing an idle
        // fleet — which §8 notes is the expensive path.
        this.set({ lastPingAt: Date.now(), cursor: event.data.cursor });
        return;
      }
      case 'snapshot': {
        const servers = new Map<string, ServerResource>();
        for (const item of event.data.items) {
          const existing = this.snapshot.servers.get(item.name);
          // Keep the old object when nothing about it moved, so that a
          // periodic re-snapshot does not re-render the whole dashboard.
          servers.set(item.name, existing !== undefined && sameVersion(existing, item) ? existing : item);
        }
        // A snapshot re-states everything, unreadable rows included.
        const unreadable = event.data.unreadable ?? [];
        this.set({
          servers,
          order: [...servers.keys()].sort(),
          unreadable,
          removalsSuspended: unreadable.some((row) => row.name === null),
          primed: true,
          cursor: event.data.cursor,
          lastDataAt: Date.now(),
          historyGap: null,
        });
        return;
      }
      case 'updated': {
        // A row that starts decoding again arrives as an ordinary `updated`
        // with the full resource, so this is also where an unreadable mark is
        // cleared.
        const stillUnreadable = this.snapshot.unreadable.filter(
          (row) => row.name !== event.data.name,
        );
        const clearedMark = stillUnreadable.length !== this.snapshot.unreadable.length;

        const existing = this.snapshot.servers.get(event.data.name);
        if (existing !== undefined && sameVersion(existing, event.data.server) && !clearedMark) {
          this.set({ lastDataAt: Date.now() });
          return;
        }
        const servers = new Map(this.snapshot.servers);
        servers.set(event.data.name, event.data.server);
        this.set({
          servers,
          order: [...servers.keys()].sort(),
          unreadable: clearedMark ? stillUnreadable : this.snapshot.unreadable,
          removalsSuspended: stillUnreadable.some((row) => row.name === null),
          lastDataAt: Date.now(),
        });
        return;
      }
      case 'unreadable': {
        // §8: emphatically NOT `removed`. The server was declared, its container
        // may well be up with players on it, and treating this as a deletion is
        // the failure this event exists to prevent. The row keeps whatever this
        // client last knew about it, with an error badge on top.
        const row = event.data;
        const rest = this.snapshot.unreadable.filter(
          (existing) => existing.name === null || existing.name !== row.name,
        );
        const unreadable = row.name === null ? [...this.snapshot.unreadable, row] : [...rest, row];
        this.set({
          unreadable,
          removalsSuspended: unreadable.some((entry) => entry.name === null),
          lastDataAt: Date.now(),
        });
        return;
      }
      case 'removed': {
        // The drain finished and `:core` freed the name. This — not the 202
        // from DELETE — is when a row is allowed to disappear.
        const unreadable = this.snapshot.unreadable.filter((row) => row.name !== event.data.name);
        if (!this.snapshot.servers.has(event.data.name)) {
          if (unreadable.length !== this.snapshot.unreadable.length) {
            this.set({
              unreadable,
              removalsSuspended: unreadable.some((row) => row.name === null),
              lastDataAt: Date.now(),
            });
          }
          return;
        }
        const servers = new Map(this.snapshot.servers);
        servers.delete(event.data.name);
        this.set({
          servers,
          order: [...servers.keys()].sort(),
          unreadable,
          removalsSuspended: unreadable.some((row) => row.name === null),
          lastDataAt: Date.now(),
        });
        return;
      }
      case 'expired': {
        // Nothing to do — a snapshot follows immediately and the set converges.
        // Recorded so the UI can say once that intermediate states were missed.
        this.set({ historyGap: { at: Date.now(), message: event.data.message } });
        return;
      }
      case 'bye': {
        this.set({ cursor: event.data.cursor });
        return;
      }
      default:
        // An event type added to the API after this client was written. A
        // client that handles snapshot/updated/removed is already correct.
        return;
    }
  }
}
