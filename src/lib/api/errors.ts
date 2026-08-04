import type { ApiError, ConflictDetail, ErrorCode, Unreadable, Violation } from './types';

/** The `unreadable` payload on a `SERVER_UNREADABLE`, plus the row's name. */
export type UnreadableDetail = Unreadable & { name: string | null };

/**
 * Every non-2xx answer from the API, in one shape (§3).
 *
 * `code` is the branch point. API.md is explicit that clients must never branch
 * on `message`, so nothing in this app does.
 */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ErrorCode | 'TRANSPORT';
  readonly retryable: boolean;
  readonly violations: Violation[] | null;
  readonly conflict: ConflictDetail | null;
  /**
   * Set on `SERVER_UNREADABLE` (§3): the stored row will not decode.
   *
   * Explicitly **not evidence about the container** — the workload is very
   * probably running exactly as it was, and what needs repairing is a record.
   */
  readonly unreadable: UnreadableDetail | null;
  /** From the `ETag` header — present on 409, carrying the current version. */
  readonly etag: string | null;
  /** Seconds, from `Retry-After` on the two retryable 503s. */
  readonly retryAfterSeconds: number | null;

  constructor(init: {
    status: number;
    code: ErrorCode | 'TRANSPORT';
    message: string;
    retryable?: boolean;
    violations?: Violation[] | null;
    conflict?: ConflictDetail | null;
    unreadable?: UnreadableDetail | null;
    etag?: string | null;
    retryAfterSeconds?: number | null;
  }) {
    super(init.message);
    this.name = 'ApiRequestError';
    this.status = init.status;
    this.code = init.code;
    this.retryable = init.retryable ?? false;
    this.violations = init.violations ?? null;
    this.conflict = init.conflict ?? null;
    this.unreadable = init.unreadable ?? null;
    this.etag = init.etag ?? null;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
  }
}

/**
 * 500 `SERVER_UNREADABLE` — the stored row will not decode, so there is no
 * resource to send. Deliberately not a 404: that would say the server is gone
 * when it may still be running with players on it.
 */
export function isServerUnreadable(
  value: unknown,
): value is ApiRequestError & { unreadable: UnreadableDetail } {
  return isApiError(value) && value.code === 'SERVER_UNREADABLE' && value.unreadable !== null;
}

export function isApiError(value: unknown): value is ApiRequestError {
  return value instanceof ApiRequestError;
}

/** 422 — every violation the document has, at once, each attached to a field. */
export function isValidationFailure(
  value: unknown,
): value is ApiRequestError & { violations: Violation[] } {
  return isApiError(value) && value.code === 'VALIDATION_FAILED' && value.violations !== null;
}

/** 409 — somebody got there first. One branch, `conflict.reason` says which. */
export function isConflict(
  value: unknown,
): value is ApiRequestError & { conflict: ConflictDetail } {
  return isApiError(value) && value.code === 'CONFLICT' && value.conflict !== null;
}

export function isUnauthenticated(value: unknown): boolean {
  return isApiError(value) && value.code === 'UNAUTHENTICATED';
}

export function isNotFound(value: unknown): boolean {
  return isApiError(value) && value.code === 'NOT_FOUND';
}

function isErrorEnvelope(value: unknown): value is ApiError {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const inner = (value as { error: unknown }).error;
  return typeof inner === 'object' && inner !== null && 'code' in inner;
}

/**
 * Turns a failed `Response` into an `ApiRequestError`.
 *
 * A body that is not the documented envelope is still an error the UI has to
 * render — a proxy 502, a truncated response, an HTML error page. Those become
 * `TRANSPORT` rather than being reported as an API code the server never sent.
 */
export async function toApiError(response: Response): Promise<ApiRequestError> {
  const etag = response.headers.get('ETag');
  const retryAfterHeader = response.headers.get('Retry-After');
  const retryAfterSeconds =
    retryAfterHeader !== null && /^\d+$/.test(retryAfterHeader.trim())
      ? Number(retryAfterHeader.trim())
      : null;

  let body: unknown = null;
  try {
    const text = await response.text();
    body = text.length > 0 ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = null;
  }

  if (isErrorEnvelope(body)) {
    const { error } = body;
    return new ApiRequestError({
      status: response.status,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      violations: error.violations,
      conflict: error.conflict,
      unreadable: error.unreadable ?? null,
      etag,
      retryAfterSeconds,
    });
  }

  return new ApiRequestError({
    status: response.status,
    code: 'TRANSPORT',
    message: `the API answered ${response.status} without the documented error envelope`,
    etag,
    retryAfterSeconds,
  });
}

/**
 * A short, operator-facing line for an error. The API's own `message` is
 * written for an operator and is preferred; this only fills the gaps where a
 * code alone is not self-explanatory.
 */
export function describeError(error: unknown): string {
  if (!isApiError(error)) {
    return error instanceof Error ? error.message : 'something went wrong';
  }
  switch (error.code) {
    case 'TRANSPORT':
      return 'the dashboard could not reach the API';
    case 'UNAUTHENTICATED':
      return 'the session is not valid any more';
    case 'CSRF_REQUIRED':
    case 'CSRF_INVALID':
      return 'the session token did not check out — sign in again';
    case 'STORE_UNAVAILABLE':
      return `the store could not be reached${
        error.retryAfterSeconds !== null ? `; retry in ${error.retryAfterSeconds}s` : ''
      }`;
    case 'PRECONDITION_REQUIRED':
      return 'this write needs the version it is replacing';
    case 'SERVER_UNREADABLE':
      // Say what is broken. The container is probably fine; the record is not,
      // and sending an operator to the host would waste an outage.
      return error.unreadable !== null
        ? `${error.unreadable.reason} — the stored record is broken, most likely not the server`
        : error.message;
    default:
      return error.message;
  }
}
