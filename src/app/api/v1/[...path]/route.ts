import { forbiddenOrigin, originAllowed, proxy } from '@/lib/upstream';

/**
 * Reverse proxy for the whole orchestrator API.
 *
 * The dashboard and the API are one origin as far as the browser is concerned.
 * That is what lets the `HttpOnly; SameSite=Strict` session cookie reach the
 * API at all, and it is the only way `EventSource` — which cannot set a single
 * header — can authenticate the stream (API.md §2, §8).
 *
 * This handler adds no behaviour of its own beyond the origin check. Status
 * codes, `ETag`, `Location`, `Retry-After`, the error envelope and the event
 * stream all pass through exactly as the API produced them, so the contract the
 * client is written against is the contract it actually meets.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The stream runs for `maxLifetimeMillis` (30 minutes by default) before the
// API says `bye` and the browser reconnects. The proxy must outlive that.
export const maxDuration = 3600;

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

async function handle(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  if (!SAFE.has(request.method)) {
    const origin = request.headers.get('origin');
    if (!originAllowed(origin, request.headers.get('host'))) return forbiddenOrigin();
  }
  const { path } = await context.params;
  return proxy(request, `/api/v1/${path.map(encodeURIComponent).join('/')}`);
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
