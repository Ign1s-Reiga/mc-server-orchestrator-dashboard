import type { ApiError } from '../api/types';

/**
 * A controllable `GET /api/v1/stream` for tests.
 *
 * Frames are written the way the API writes them — `id:`, `event:`, `data:`,
 * blank line — rather than handed to the store as objects, so the parser is
 * exercised too. If the wire format changes, these tests notice.
 */
export class FakeStream {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private readonly encoder = new TextEncoder();
  readonly body: ReadableStream<Uint8Array>;
  closed = false;

  constructor() {
    this.body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.closed = true;
      },
    });
  }

  /** Writes one SSE event exactly as `StreamRoutes` does. */
  send(event: string, data: unknown, id?: string): void {
    const lines: string[] = [];
    if (id !== undefined) lines.push(`id: ${id}`);
    lines.push(`event: ${event}`);
    lines.push(`data: ${JSON.stringify(data)}`);
    lines.push('', '');
    this.controller?.enqueue(this.encoder.encode(lines.join('\n')));
  }

  /** The SSE `retry:` preamble the API sends before `hello`. */
  sendRetryPreamble(reconnectMillis: number): void {
    this.controller?.enqueue(this.encoder.encode(`retry: ${reconnectMillis}\n\n`));
  }

  /** A raw comment frame. The API sends none; a proxy might. */
  sendComment(text: string): void {
    this.controller?.enqueue(this.encoder.encode(`: ${text}\n\n`));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller?.close();
  }
}

export interface HelloOptions {
  cursor?: string;
  resumed?: boolean;
  keepAliveMillis?: number;
  maxLifetimeMillis?: number;
  reconnectMillis?: number;
}

export function helloPayload(options: HelloOptions = {}) {
  return {
    cursor: options.cursor ?? '1',
    resumed: options.resumed ?? false,
    changePollMillis: 500,
    statusPollMillis: 2000,
    keepAliveMillis: options.keepAliveMillis ?? 15_000,
    maxLifetimeMillis: options.maxLifetimeMillis ?? 1_800_000,
    reconnectMillis: options.reconnectMillis ?? 3000,
  };
}

export function errorBody(code: ApiError['error']['code'], message: string): ApiError {
  return {
    error: { code, message, retryable: false, violations: null, conflict: null, unreadable: null },
  };
}

/**
 * Installs a `fetch` that hands out prepared streams in order and records the
 * URLs it was called with, so a test can assert *that* a reconnect happened and
 * *what cursor* it resumed from.
 */
export class FakeFetch {
  readonly calls: string[] = [];
  private readonly queue: Array<() => Response> = [];

  /** Queues a 200 `text/event-stream` backed by `stream`. */
  queueStream(stream: FakeStream): void {
    this.queue.push(
      () =>
        new Response(stream.body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    );
  }

  queueStatus(status: number, body: ApiError, headers: Record<string, string> = {}): void {
    this.queue.push(
      () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json', ...headers },
        }),
    );
  }

  queueNetworkError(): void {
    this.queue.push(() => {
      throw new TypeError('fetch failed');
    });
  }

  install(): void {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      this.calls.push(typeof input === 'string' ? input : String(input));
      const next = this.queue.shift();
      if (next === undefined) {
        // Never leave a test hanging on an unexpected reconnect — fail loudly.
        return Promise.reject(new TypeError('fetch failed: nothing queued'));
      }
      try {
        return Promise.resolve(next());
      } catch (cause) {
        return Promise.reject(cause as Error);
      }
    }) as typeof fetch;
  }
}
