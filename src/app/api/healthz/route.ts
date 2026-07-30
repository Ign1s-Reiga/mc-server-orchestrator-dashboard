import { proxy } from '@/lib/upstream';

/**
 * The one unauthenticated route the API exposes (§10), proxied so the sign-in
 * screen can tell "wrong token" apart from "the orchestrator is not running".
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return proxy(request, '/healthz');
}
