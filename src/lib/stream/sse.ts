/**
 * A minimal server-sent-events reader over `fetch` + `ReadableStream`.
 *
 * ## Why `fetch` and not `EventSource`
 *
 * **The original reason is gone; this is the current one.** This client was
 * first written over `fetch` because the API's keep-alive was an SSE *comment*
 * (`: keep-alive`) and `EventSource` does not expose comment frames to script —
 * so on an idle fleet an `EventSource` client could render half-hour-old state
 * with `readyState === OPEN` and no way to notice. §8 now sends a named `ping`
 * event instead, visible to both transports, and presents `EventSource` as a
 * legitimate choice again. That argument no longer applies.
 *
 * `fetch` is kept for a different reason that does still apply: **`EventSource`
 * cannot see the HTTP status of a failed connection.** Its `onerror` is opaque.
 * This dashboard has to tell three failures apart and treats each differently:
 *
 * - `401 UNAUTHENTICATED` — the session went away (an API restart drops its
 *   in-memory sessions). Stop retrying and show the sign-in.
 * - `503 STREAM_LIMIT` — every stream slot upstream is taken. Retryable, and
 *   `Retry-After` says when; hammering makes it worse.
 * - a transport failure — back off and keep trying.
 *
 * Through `EventSource` all three are one indistinguishable `error` event
 * followed by an automatic reconnect at a fixed `reconnectMillis`, with no
 * jitter and no ceiling. Owning the reconnect also buys exponential backoff
 * with jitter, which is what stops every open tab retrying a restarting
 * orchestrator on the same tick.
 *
 * The cookie still does the authenticating. Nothing here sets an
 * `Authorization` header; the point of the session cookie is unchanged.
 *
 * Comment frames are still parsed. §8 says the stream sends none, but a proxy
 * may inject one, and treating it as liveness rather than choking on it is free.
 */

export interface SseFrame {
  /** The `event:` field. SSE defaults this to `message` when absent. */
  event: string;
  data: string;
  /** The `id:` field — the API sets it to the current cursor on every event. */
  id: string | null;
  /** True for a `: comment` frame. The API's keep-alive. */
  comment: boolean;
}

/**
 * Incremental SSE parser. Feed it decoded text; it yields complete frames.
 *
 * Frames are separated by a blank line, fields are `name: value`, and a leading
 * space after the colon is stripped. Multiple `data:` lines join with `\n`.
 */
export class SseParser {
  private buffer = '';
  private event: string | null = null;
  private data: string[] = [];
  private id: string | null = null;

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];

    // Normalise line endings, then take whole lines only; a partial trailing
    // line stays in the buffer until the rest of it arrives.
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const raw = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

      if (line.length === 0) {
        const frame = this.flush();
        if (frame !== null) frames.push(frame);
        continue;
      }

      if (line.startsWith(':')) {
        // The API sends none of these — liveness is the named `ping` event —
        // but a proxy may inject one, so it counts as traffic and nothing more.
        frames.push({ event: '', data: line.slice(1).trim(), id: null, comment: true });
        continue;
      }

      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      switch (field) {
        case 'event':
          this.event = value;
          break;
        case 'data':
          this.data.push(value);
          break;
        case 'id':
          // Per the SSE spec an id containing NUL is ignored.
          if (!value.includes('\0')) this.id = value;
          break;
        default:
          // `retry:` and anything unknown. Reconnect timing is this client's
          // own concern, so `retry` is deliberately not honoured.
          break;
      }
    }

    return frames;
  }

  private flush(): SseFrame | null {
    if (this.data.length === 0 && this.event === null) {
      this.id = null;
      return null;
    }
    const frame: SseFrame = {
      event: this.event ?? 'message',
      data: this.data.join('\n'),
      id: this.id,
      comment: false,
    };
    this.event = null;
    this.data = [];
    this.id = null;
    return frame;
  }
}
