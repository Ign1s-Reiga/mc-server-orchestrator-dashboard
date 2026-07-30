import 'server-only';

/**
 * Where the orchestrator API lives. Server-side only — the browser never
 * learns this address, and never talks to it directly.
 */
export const UPSTREAM = (process.env.MCORCH_API_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');

/**
 * Extra origins allowed to drive this dashboard, comma-separated. Same-origin
 * requests and header-less requests are always allowed; see `originAllowed`.
 */
const EXTRA_ORIGINS = (process.env.DASHBOARD_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value.length > 0);

/** Hop-by-hop headers, plus the ones `fetch` must compute for itself. */
const NOT_FORWARDED = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'proxy-authenticate',
  'proxy-authorization',
  'host',
  'content-length',
  'accept-encoding',
  // Stripped deliberately: see `proxy()`.
  'origin',
  'referer',
]);

const RESPONSE_NOT_FORWARDED = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
]);

/**
 * The origin check API.md §2 performs, moved to this boundary.
 *
 * The upstream check compares `Origin` against the API's own `Host`. Once the
 * dashboard proxies, every upstream request arrives with no `Origin` at all —
 * which API.md classifies as "a script, not a browser" and allows. That is the
 * correct classification for the proxy itself, but it means the control has to
 * be re-performed here, against the dashboard's host, or it is simply gone.
 */
export function originAllowed(origin: string | null, host: string | null): boolean {
  if (origin === null || origin === 'null') return true; // not a browser, or an opaque origin
  if (EXTRA_ORIGINS.includes(origin)) return true;
  if (host === null) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function forbiddenOrigin(): Response {
  return Response.json(
    {
      error: {
        code: 'ORIGIN_NOT_ALLOWED',
        message: 'the dashboard refused a cross-origin request before forwarding it',
        retryable: false,
        violations: null,
        conflict: null,
      },
    },
    { status: 403, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
  );
}

export function unreachable(cause: unknown): Response {
  const detail = cause instanceof Error ? cause.message : 'unknown cause';
  return Response.json(
    {
      error: {
        code: 'STORE_UNAVAILABLE',
        message: `the dashboard could not reach the orchestrator API at ${UPSTREAM} (${detail})`,
        retryable: true,
        violations: null,
        conflict: null,
      },
    },
    {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '5' },
    },
  );
}

/**
 * Forwards one request to the orchestrator and streams the answer back.
 *
 * `Origin` is stripped on the way up. Keeping it would mean every request
 * arriving at the API carried the dashboard's origin, which does not match the
 * API's `Host` and is not in `MCORCH_API_ALLOWED_ORIGINS`, so every request
 * would be a 403. `originAllowed` above performs the equivalent check here
 * instead, so the control is relocated rather than dropped.
 *
 * Everything else that carries meaning is passed through untouched:
 * `Authorization` (the one-shot token exchange), `Cookie` / `Set-Cookie` (the
 * session), `If-Match`, `X-CSRF-Token`, `Last-Event-ID` (the SSE resume path),
 * `ETag`, `Location` and `Retry-After`.
 */
export async function proxy(request: Request, upstreamPath: string): Promise<Response> {
  const incoming = new URL(request.url);
  const target = `${UPSTREAM}${upstreamPath}${incoming.search}`;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!NOT_FORWARDED.has(key.toLowerCase())) headers.set(key, value);
  });

  const method = request.method;
  const body =
    method === 'GET' || method === 'HEAD' ? undefined : new Uint8Array(await request.arrayBuffer());

  let response: Response;
  try {
    response = await fetch(target, {
      method,
      headers,
      body,
      redirect: 'manual',
      // Aborted when the browser goes away, which is how a closed EventSource
      // reaches the upstream stream loop and lets it release its slot against
      // `maxStreams`.
      signal: request.signal,
      cache: 'no-store',
    });
  } catch (cause) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return unreachable(cause);
  }

  const outgoing = new Headers();
  response.headers.forEach((value, key) => {
    if (!RESPONSE_NOT_FORWARDED.has(key.toLowerCase())) outgoing.append(key, value);
  });

  if (outgoing.get('Content-Type')?.includes('text/event-stream') === true) {
    // Nothing between here and the browser may buffer: the whole point of the
    // stream is that an event written now arrives now.
    outgoing.set('Cache-Control', 'no-cache, no-transform');
    outgoing.set('X-Accel-Buffering', 'no');
    outgoing.delete('Content-Encoding');
  }

  return new Response(response.body, { status: response.status, headers: outgoing });
}
