/**
 * The machine-readable half of the contract.
 *
 * Transcribed from `api/API.md` §14 in the mc-server-orchestrator repo. That
 * document is the specification; this file is its TypeScript block and nothing
 * more. Do not add convenience fields here — if the dashboard needs a derived
 * value, derive it in `display.ts` or a component, so that a diff against §14
 * stays readable.
 */

export type ApiVersion = 'mcorch.dev/v1alpha1';
export type Kind = 'PaperServer';

export type ServerPhase =
  | 'PENDING'
  | 'IMAGE_PULLING'
  | 'CREATING'
  | 'STARTING'
  | 'RUNNING'
  | 'DRAINING'
  | 'STOPPING'
  | 'STOPPED'
  | 'FAILED'
  | 'UNKNOWN';

export type DrainState =
  | 'DRAIN_REQUESTED'
  | 'SEALED'
  | 'TARGET_RESOLVED'
  | 'TRANSFERRING'
  | 'SAVING'
  | 'DEREGISTERED'
  | 'STOPPING'
  | 'DRAIN_FAILED';

export type DisplayState =
  | 'PENDING'
  | 'STARTING'
  | 'RUNNING'
  | 'READY'
  | 'DRAINING'
  | 'TERMINATING'
  | 'STOPPING'
  | 'STOPPED'
  | 'FAILED'
  | 'UNKNOWN';

export type ConditionType =
  | 'IMAGE_AVAILABLE'
  | 'VOLUME_BOUND'
  | 'CONTAINER_RUNNING'
  | 'READY'
  | 'DRAINING'
  | 'PLAYERS_EVACUATED'
  | 'WORLD_SAVED'
  | 'NEEDS_ATTENTION';

export type ConditionStatus = 'TRUE' | 'FALSE' | 'UNKNOWN';
export type FailureClass = 'RETRYABLE' | 'PERMANENT';

export type FailureReason =
  | 'IMAGE_PULL_FAILED'
  | 'IMAGE_REFERENCE_REJECTED'
  | 'SANDBOX_CREATE_FAILED'
  | 'CONTAINER_CREATE_FAILED'
  | 'CONTAINER_START_FAILED'
  | 'CONTAINER_EXITED'
  | 'READINESS_TIMEOUT'
  | 'VOLUME_UNAVAILABLE'
  | 'NODE_UNAVAILABLE'
  | 'RUNTIME_UNREACHABLE'
  | 'DRAIN_NO_DESTINATION'
  | 'DRAIN_TRANSFER_FAILED'
  | 'DRAIN_SAVE_TIMEOUT'
  | 'DRAIN_STALLED'
  | 'UNKNOWN';

/** Wire values, because these are written back into a definition. */
export type StorageMode = 'persistent' | 'ephemeral';
export type DrainPolicy = 'waitForZeroPlayers';

/* ── what you SEND ─────────────────────────────────────────────────────────── */

/**
 * The body of `POST /servers`, `PUT /servers/{name}` and `POST /validate`.
 *
 * Everything the parser defaults is optional, which is most of the spec: a
 * four-field document validates. Note `?:` and NOT `| null` throughout — an
 * explicit `null` is a violation, not "use the default" (§6). `JSON.stringify`
 * drops `undefined` properties, so an optional property left unset is correct;
 * one set to `null` is a 422.
 *
 * Unknown fields are rejected with a violation naming the field, so this is not
 * merely advisory — a typo is a 422 with `did you mean …?` attached.
 */
export interface DefinitionInput {
  apiVersion: ApiVersion;
  kind: Kind;
  metadata: { name: string; labels?: Record<string, string> };
  spec: PaperServerSpecInput;
}

export interface PaperServerSpecInput {
  /** Required. Pinned to a tag or a digest; `latest` is rejected. */
  image: string;
  /** Required. `build` is optional. */
  paper: { minecraftVersion: string; build?: number };
  /** Required, and must be `true`. A Paper server never starts without it. */
  eulaAccepted: true;
  /** Required — but only `memory` inside it is. */
  resources: {
    memory: string;
    cpu?: string;
    /** Defaults to the largest heap that leaves the container headroom. */
    heap?: { max?: string; min?: string };
  };
  maxPlayers?: number;
  network?: {
    port?: number;
    hostPort?: number;
    /** Omit for no RCON. `passwordSecret` is required once `enabled` is true. */
    rcon?: { enabled?: boolean; port?: number; passwordSecret?: SecretRef };
  };
  /** Defaults to persistent, on a volume named after the server. */
  storage?:
    | { mode?: 'persistent'; mountPath?: string; volume?: { name?: string; size?: string } }
    /** `volume` must NOT be set here — a 422 if it is. */
    | { mode: 'ephemeral'; mountPath?: string };
  lifecycle?: {
    drain?: { policy?: DrainPolicy; playerTransferTimeout?: string; saveTimeout?: string };
    /** Must exceed `drain.saveTimeout` by at least 30s. Default: saveTimeout + 60s. */
    stopGracePeriod?: string;
    startupTimeout?: string;
  };
  placement?: { node?: string };
}

/* ── what you RECEIVE ──────────────────────────────────────────────────────── */

/**
 * The `definition` field of a server resource. Absent optional fields are
 * OMITTED, not null (§6) — which is what makes it assignable to
 * `DefinitionInput`, so a fetched definition can be edited and PUT back with no
 * cast:
 *
 *     const draft: DefinitionInput = server.definition;   // compiles
 *
 * Unlike `DefinitionInput`, every defaulted field is present: this is the
 * *effective* definition the reconciler acts on, not what the operator typed.
 */
export interface Definition {
  apiVersion: ApiVersion;
  kind: Kind;
  metadata: { name: string; labels?: Record<string, string> };
  spec: PaperServerSpec;
}

export interface PaperServerSpec {
  /** pinned: a tag or a digest, never `latest` */
  image: string;
  paper: { minecraftVersion: string; build?: number };
  eulaAccepted: true;
  maxPlayers: number;
  network: {
    port: number;
    hostPort?: number;
    rcon?: { enabled: true; port: number; passwordSecret: SecretRef };
  };
  resources: { memory: string; cpu?: string; heap: { max: string; min: string } };
  storage:
    | { mode: 'persistent'; mountPath: string; volume: { name: string; size?: string } }
    | { mode: 'ephemeral'; mountPath: string };
  lifecycle: {
    drain: { policy: 'waitForZeroPlayers'; playerTransferTimeout: string; saveTimeout: string };
    /** always > saveTimeout + 30s */
    stopGracePeriod: string;
    startupTimeout: string;
  };
  placement?: { node: string };
}

/** Coordinates. There is no endpoint that turns this into a value. */
export interface SecretRef {
  name: string;
  key: string;
}

/** Absent optional fields are `null` here, not omitted. */
export interface ServerStatus {
  apiVersion: ApiVersion;
  kind: Kind;
  name: string;
  observedGeneration: number;
  phase: ServerPhase;
  observedAt: string;
  lastTransitionAt: string;
  ready: boolean;
  draining: boolean;
  image: {
    requested: string;
    resolvedDigest: string | null;
    pulledAt: string | null;
    available: boolean;
  } | null;
  runtime: {
    node: string;
    sandboxId: string;
    containerId: string | null;
    createdAt: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    exitCode: number | null;
    restartCount: number;
  } | null;
  /** the SERVER's address */
  endpoint: { node: string; address: string; port: number } | null;
  /** counts only */
  players: { online: number; max: number; observedAt: string } | null;
  storage: {
    persistent: boolean;
    volumeName: string | null;
    bound: boolean;
    lastSaveConfirmedAt: string | null;
  } | null;
  drain: DrainStatus | null;
  failure: FailureStatus | null;
  conditions: Array<{
    type: ConditionType;
    status: ConditionStatus;
    message: string;
    lastTransitionAt: string;
  }>;
}

export interface DrainStatus {
  state: DrainState;
  startedAt: string;
  enteredStateAt: string;
  playersEvacuated: boolean;
  sealRequestedAt: string | null;
  /** a save request that went out and was NOT confirmed */
  saveRequestedAt: string | null;
  /** a COMPLETED save. Disjoint from saveRequestedAt. */
  worldSavedAt: string | null;
  worldSaved: boolean;
  deregisteredAt: string | null;
  transferAttempts: number;
  /** a server name, never a player */
  destination: string | null;
  failure: FailureStatus | null;
}

export interface FailureStatus {
  reason: FailureReason;
  failureClass: FailureClass;
  /** redacted upstream; no unredacted view exists */
  message: string;
  occurredAt: string;
  attempts: number;
}

export interface ServerResource {
  name: string;
  kind: Kind;
  apiVersion: ApiVersion;
  definition: Definition;
  metadata: {
    generation: number;
    resourceVersion: string;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
    terminating: boolean;
  };
  status: ServerStatus | null;
  statusMeta: { resourceVersion: string; recordedAt: string } | null;
  caughtUp: boolean;
  display: {
    state: DisplayState;
    ready: boolean;
    needsAttention: boolean;
    drainState: DrainState | null;
    playersOnline: number | null;
    playersMax: number | null;
    detail: string;
  };
}

export interface ServerList {
  cursor: string;
  count: number;
  items: ServerResource[];
}

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHENTICATED'
  | 'CSRF_REQUIRED'
  | 'CSRF_INVALID'
  | 'ORIGIN_NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'SECRET_NOT_READABLE'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'VALIDATION_FAILED'
  | 'PRECONDITION_REQUIRED'
  | 'INTERNAL'
  | 'STORE_UNAVAILABLE'
  | 'STREAM_LIMIT';

export type ConflictReason =
  | 'ALREADY_EXISTS'
  | 'VERSION_MISMATCH'
  | 'NOT_FOUND'
  | 'TERMINATING'
  | 'NOT_DELETED'
  | 'KIND_MISMATCH'
  | 'DEFINITION_CHANGED';

export interface Violation {
  field: string;
  problem: string;
  location: { source: string; line: number; column: number } | null;
}

export interface ConflictDetail {
  name: string;
  reason: ConflictReason;
  currentResourceVersion: string | null;
  explanation: string;
}

export interface ApiError {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    violations: Violation[] | null;
    conflict: ConflictDetail | null;
  };
}

export type StreamEvent =
  | {
      type: 'hello';
      data: {
        cursor: string;
        resumed: boolean;
        changePollMillis: number;
        statusPollMillis: number;
        keepAliveMillis: number;
        maxLifetimeMillis: number;
        reconnectMillis: number;
      };
    }
  | { type: 'snapshot'; data: { cursor: string; count: number; items: ServerResource[] } }
  | {
      type: 'updated';
      data: { name: string; reason: 'definition' | 'status'; server: ServerResource };
    }
  | { type: 'removed'; data: { name: string; reason: 'PURGED' } }
  /**
   * The liveness beat, every `keepAliveMillis` whether or not anything changed.
   * A named event rather than an SSE comment, so `EventSource` and `fetch` see
   * the same protocol. It carries the cursor, so a watchdog that gives up can
   * resume from here instead of re-listing an idle fleet.
   */
  | { type: 'ping'; data: { at: string; cursor: string } }
  | { type: 'expired'; data: { cursor: string; message: string } }
  | { type: 'bye'; data: { reason: 'MAX_LIFETIME'; cursor: string } };

/* -------------------------------------------------------------------------
 * Response bodies described in prose in API.md but absent from the §14 block.
 * Shapes taken verbatim from the JSON examples in the sections named below.
 * ---------------------------------------------------------------------- */

/** §2 — `POST /auth/session` and `GET /auth/session`. */
export interface SessionInfo {
  authenticated: true;
  method: 'session' | 'bearer';
  /** null for a bearer caller */
  csrfToken: string | null;
  /** null for a bearer caller */
  expiresAt: string | null;
}

/** §6 — `GET /servers/{name}/status`. */
export interface ServerStatusEnvelope {
  name: string;
  observedGeneration: number;
  generation: number;
  caughtUp: boolean;
  recordedAt: string;
  resourceVersion: string;
  status: ServerStatus;
}

/** §6 — `DELETE /servers/{name}`, answered 202. */
export interface DeleteAccepted {
  accepted: true;
  message: string;
  server: ServerResource;
}

/** §6 — `POST /validate`, answered 200. */
export interface ValidateOk {
  valid: true;
  definition: Definition;
}

/** §9 — secrets carry coordinates only, never material. */
export interface SecretSummary {
  name: string;
  keys: string[];
}

export interface SecretList {
  items: SecretSummary[];
}

/** §9 — `PUT /secrets/{name}/{key}` returns the length, never the value. */
export interface SecretWritten {
  name: string;
  key: string;
  replaced: boolean;
  length: number;
}

export interface SecretRemoved {
  name: string;
  removedKeys: number;
}

/** §10 — `GET /meta`. Closed sets, so the dashboard hard-codes no enumerations. */
export interface ApiMeta {
  apiVersions: string[];
  currentApiVersion: string;
  kinds: string[];
  /**
   * Every closed set the API can return **or accept**, so the dashboard
   * hard-codes none — not in a filter and not in a create form.
   *
   * The two spellings are not cosmetic (§10). `…State`/`…Type`/`…Reason`/
   * `…Class` are read back and carry Kotlin names (`RUNNING`, `DRAIN_STALLED`);
   * `storageMode` and `drainPolicy` are *sent* in a definition and carry YAML
   * wire values (`persistent`, `waitForZeroPlayers`). A form offering
   * `PERSISTENT` would build a document the parser rejects.
   */
  enums: {
    phase: ServerPhase[];
    drainState: DrainState[];
    conditionType: ConditionType[];
    conditionStatus: ConditionStatus[];
    failureReason: FailureReason[];
    failureClass: FailureClass[];
    displayState: DisplayState[];
    storageMode: StorageMode[];
    drainPolicy: DrainPolicy[];
  };
  limits: { maxBodyBytes: number; maxStreams: number };
  stream: {
    path: string;
    changePollMillis: number;
    statusPollMillis: number;
    keepAliveMillis: number;
    maxLifetimeMillis: number;
    /** The SSE `retry:` value the API sends. A client with its own backoff
     *  ignores it; this is here so it can see what it is overriding. */
    reconnectMillis: number;
  };
}
