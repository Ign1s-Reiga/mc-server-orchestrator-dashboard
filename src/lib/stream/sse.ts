/**
 * A minimal server-sent-events reader over `fetch` + `ReadableStream`.
 *
 * ## Why not `EventSource`
 *
 * API.md §8 suggests `EventSource`, and its reasoning is sound: it reconnects
 * and replays `Last-Event-ID` with no client code. This app uses `fetch`
 * instead, for one reason that matters to an operator:
 *
 * **`EventSource` does not expose comment frames.** The API writes
 * `: keep-alive` every `keepAliveMillis` (15s by default) precisely so a client
 * can tell a healthy-but-idle stream from a dead socket. Through `EventSource`
 * those frames are invisible, so on a fleet where nothing is changing the only
 * guaranteed traffic is the `bye` at `maxLifetimeMillis` — 30 minutes. A
 * half-open connection (a slept laptop, a NAT timeout, a proxy that vanished)
 * would leave the dashboard showing half-hour-old state while claiming to be
 * live. That is the exact failure the dashboard must not have.
 *
 * Reading the stream directly makes every keep-alive visible, so silence longer
 * than a couple of keep-alive periods is a reliable signal, and the reconnect
 * uses `?cursor=` — which §8 says wins over `Last-Event-ID` — so the resume is
 * explicit rather than delegated.
 *
 * The cookie still does the authenticating. Nothing here sets an `Authorization`
 * header; the point of the session cookie is unchanged.
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
        // A comment. The API's keep-alive arrives here and nowhere else.
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
