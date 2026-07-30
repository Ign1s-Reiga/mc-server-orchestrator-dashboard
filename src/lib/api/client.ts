import { ApiRequestError, toApiError } from './errors';
import type {
  ApiMeta,
  DeleteAccepted,
  Definition,
  SecretList,
  SecretRemoved,
  SecretSummary,
  SecretWritten,
  ServerList,
  ServerResource,
  ServerStatusEnvelope,
  SessionInfo,
  ValidateOk,
} from './types';

/**
 * Requests go to this app's own origin and are reverse-proxied to the
 * orchestrator by `src/app/api/v1/[...path]/route.ts`.
 *
 * Same-origin is not an implementation shortcut. The session cookie is
 * `HttpOnly; SameSite=Strict` and `EventSource` cannot set headers (§2/§8), so
 * every credentialed request — including the stream — has to be one the browser
 * will attach that cookie to. Proxying is the deployment API.md already assumes
 * ("it inherits the cookie, the CORS decision and the reverse-proxy config
 * already in place").
 */
export const API_BASE = '/api/v1';

/**
 * The CSRF token from §2, held in memory only.
 *
 * It is deliberately readable by script — it is not a credential on its own —
 * but it is never persisted, because a token in storage outlives the session
 * that authorised it.
 */
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

/** Fired when any request comes back 401, so the shell can show the sign-in. */
type SessionLostListener = () => void;
const sessionLostListeners = new Set<SessionLostListener>();

export function onSessionLost(listener: SessionLostListener): () => void {
  sessionLostListeners.add(listener);
  return () => sessionLostListeners.delete(listener);
}

/**
 * Announces that the credential is gone.
 *
 * Called from `request` on any 401, and from the event stream when it is
 * refused — the stream is usually the *first* thing to notice, because it is
 * the only connection that is always open. A restarted API drops its in-memory
 * sessions, so a dashboard that only learned this from the next mutation would
 * sit there looking connected until the operator tried to do something.
 */
export function notifySessionLost(): void {
  setCsrfToken(null);
  for (const listener of sessionLostListeners) listener();
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface RequestOptions {
  method?: string;
  /** Serialised as JSON unless `rawBody` is set. */
  body?: unknown;
  /** Sent verbatim. Used for definitions typed as YAML and for secret material. */
  rawBody?: string;
  contentType?: string;
  /** §4 — required on `PUT`. */
  ifMatch?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Suppress the session-lost broadcast, for the session probe itself. */
  quiet401?: boolean;
}

export interface ApiResponse<T> {
  data: T;
  /** §4 — the resourceVersion, quoted. Send it straight back as `If-Match`. */
  etag: string | null;
  status: number;
  location: string | null;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
  const method = options.method ?? 'GET';
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');

  let body: BodyInit | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
    headers.set('Content-Type', options.contentType ?? 'text/plain; charset=utf-8');
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers.set('Content-Type', options.contentType ?? 'application/json; charset=utf-8');
  }

  if (options.ifMatch !== undefined) headers.set('If-Match', options.ifMatch);

  // §2 — a cookie-authenticated mutation needs the double-submit token. A
  // bearer caller does not, but this app is always the cookie caller.
  if (MUTATING.has(method) && csrfToken !== null) headers.set('X-CSRF-Token', csrfToken);

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body,
      credentials: 'same-origin',
      signal: options.signal,
      cache: 'no-store',
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiRequestError({
      status: 0,
      code: 'TRANSPORT',
      message: 'the dashboard could not reach the API',
    });
  }

  if (!response.ok) {
    const error = await toApiError(response);
    if (error.status === 401 && options.quiet401 !== true) notifySessionLost();
    throw error;
  }

  const etag = response.headers.get('ETag');
  const location = response.headers.get('Location');

  if (response.status === 204) {
    return { data: undefined as T, etag, status: response.status, location };
  }

  const text = await response.text();
  const data = (text.length > 0 ? JSON.parse(text) : undefined) as T;
  return { data, etag, status: response.status, location };
}

/* ---------------------------------------------------------------- auth (§2) */

export async function readSession(signal?: AbortSignal): Promise<SessionInfo> {
  const { data } = await request<SessionInfo>('/auth/session', { signal, quiet401: true });
  return data;
}

/**
 * Exchanges the operator token for a session cookie.
 *
 * The token is the one credential this app touches and it goes no further than
 * this call: not to storage, not to a log, not into React state that outlives
 * the submit.
 */
export async function createSession(operatorToken: string): Promise<SessionInfo> {
  const { data } = await request<SessionInfo>('/auth/session', {
    method: 'POST',
    headers: { Authorization: `Bearer ${operatorToken}` },
    quiet401: true,
  });
  return data;
}

export async function endSession(): Promise<void> {
  await request<void>('/auth/session', { method: 'DELETE' });
}

/* ------------------------------------------------------------- servers (§6) */

export interface ListQuery {
  labelSelector?: string;
  state?: string[];
  terminating?: 'true' | 'false' | 'any';
}

export function listQueryString(query: ListQuery): string {
  const params = new URLSearchParams();
  if (query.labelSelector !== undefined && query.labelSelector.length > 0) {
    params.set('labelSelector', query.labelSelector);
  }
  for (const state of query.state ?? []) params.append('state', state);
  if (query.terminating !== undefined && query.terminating !== 'any') {
    params.set('terminating', query.terminating);
  }
  const encoded = params.toString();
  return encoded.length > 0 ? `?${encoded}` : '';
}

export async function listServers(query: ListQuery = {}, signal?: AbortSignal): Promise<ServerList> {
  const { data } = await request<ServerList>(`/servers${listQueryString(query)}`, { signal });
  return data;
}

export async function getServer(
  name: string,
  signal?: AbortSignal,
): Promise<{ server: ServerResource; etag: string }> {
  const { data, etag } = await request<ServerResource>(`/servers/${encodeURIComponent(name)}`, {
    signal,
  });
  // §4 says the ETag and metadata.resourceVersion are the same value. If a
  // proxy strips the header, quoting the resourceVersion reconstructs it
  // rather than leaving the edit form unable to send `If-Match`.
  return { server: data, etag: etag ?? `"${data.metadata.resourceVersion}"` };
}

export async function getServerStatus(
  name: string,
  signal?: AbortSignal,
): Promise<ServerStatusEnvelope> {
  const { data } = await request<ServerStatusEnvelope>(
    `/servers/${encodeURIComponent(name)}/status`,
    { signal },
  );
  return data;
}

export interface DefinitionBody {
  /** The exact text sent, so violation line/column numbers can be resolved. */
  text: string;
  contentType: string;
}

/**
 * Anything shaped like a definition document.
 *
 * `Definition` (§14) describes what `GET` returns — the *effective* spec, with
 * every default resolved. A document being sent may legitimately omit
 * everything the parser can default, so it is not a `Definition`, and forcing
 * it through that type would mean a cast at every call site. Both satisfy this.
 */
export interface DefinitionDocument {
  apiVersion: Definition['apiVersion'];
  kind: Definition['kind'];
  metadata: { name: string };
}

/**
 * Serialises with two-space indentation, and that is load-bearing rather than
 * cosmetic: violations carry a line and column into the body as sent (§5), so
 * the text kept here is what makes those positions resolvable.
 */
export function jsonBody(document: DefinitionDocument): DefinitionBody {
  return {
    text: JSON.stringify(document, null, 2),
    contentType: 'application/json; charset=utf-8',
  };
}

export function yamlBody(text: string): DefinitionBody {
  return { text, contentType: 'application/yaml; charset=utf-8' };
}

export async function createServer(
  body: DefinitionBody,
): Promise<{ server: ServerResource; etag: string | null }> {
  const { data, etag } = await request<ServerResource>('/servers', {
    method: 'POST',
    rawBody: body.text,
    contentType: body.contentType,
  });
  return { server: data, etag };
}

/** §4 — `If-Match` is required. Omitting it is a 428, never a silent overwrite. */
export async function replaceServer(
  name: string,
  body: DefinitionBody,
  ifMatch: string,
): Promise<{ server: ServerResource; etag: string | null }> {
  const { data, etag } = await request<ServerResource>(`/servers/${encodeURIComponent(name)}`, {
    method: 'PUT',
    rawBody: body.text,
    contentType: body.contentType,
    ifMatch,
  });
  return { server: data, etag };
}

/**
 * §6 — a drain request, not a stop. Answers 202 and the server keeps coming
 * back from `GET` with `terminating: true` until `:core` frees the name.
 */
export async function requestDelete(name: string, ifMatch?: string): Promise<DeleteAccepted> {
  const { data } = await request<DeleteAccepted>(`/servers/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    ifMatch,
  });
  return data;
}

/** §6 — validates and writes nothing. 200 carries the effective definition. */
export async function validateDefinition(body: DefinitionBody): Promise<ValidateOk> {
  const { data } = await request<ValidateOk>('/validate', {
    method: 'POST',
    rawBody: body.text,
    contentType: body.contentType,
  });
  return data;
}

/* ------------------------------------------------------------- secrets (§9) */

export async function listSecrets(signal?: AbortSignal): Promise<SecretSummary[]> {
  const { data } = await request<SecretList>('/secrets', { signal });
  return data.items;
}

/**
 * Writes secret material. `text/plain` and a raw body, not JSON — API.md is
 * explicit that material never passes through a JSON escape.
 *
 * There is no read counterpart and there never will be: `GET` on a key is a
 * 405 `SECRET_NOT_READABLE`, always.
 */
export async function putSecret(
  name: string,
  key: string,
  material: string,
): Promise<SecretWritten> {
  const { data } = await request<SecretWritten>(
    `/secrets/${encodeURIComponent(name)}/${encodeURIComponent(key)}`,
    { method: 'PUT', rawBody: material, contentType: 'text/plain; charset=utf-8' },
  );
  return data;
}

export async function deleteSecretKey(name: string, key: string): Promise<void> {
  await request<void>(`/secrets/${encodeURIComponent(name)}/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  });
}

export async function deleteSecret(name: string): Promise<SecretRemoved> {
  const { data } = await request<SecretRemoved>(`/secrets/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  return data;
}

/* ---------------------------------------------------------------- meta (§10) */

export async function getMeta(signal?: AbortSignal): Promise<ApiMeta> {
  const { data } = await request<ApiMeta>('/meta', { signal });
  return data;
}
