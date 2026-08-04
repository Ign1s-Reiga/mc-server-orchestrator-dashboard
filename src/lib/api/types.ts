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
export type Kind = 'PaperServer' | 'VelocityProxy';

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
  /** Up, accepting connections, and unable to do its job — see §7. */
  | 'DEGRADED'
  /** The stored observation will not decode. NOT the same as UNKNOWN — see §7. */
  | 'UNREADABLE'
  | 'UNKNOWN';

/**
 * NOTE — this union follows §7 and `/meta`, not §14.
 *
 * §14's `ConditionType` omits `BACKENDS_RESOLVED` and `CONTROL_ENDPOINT_READY`,
 * but §7 names them by name ("The capability conditions today are
 * `BACKENDS_RESOLVED` and `CONTROL_ENDPOINT_READY`"), `meta.enums.conditionType`
 * serves them, and a live proxy emits both. Verified against a running `:api`.
 * Transcribing §14 literally would make a client switching exhaustively on this
 * type break on the first proxy it saw.
 */
export type ConditionType =
  | 'IMAGE_AVAILABLE'
  | 'VOLUME_BOUND'
  | 'CONTAINER_RUNNING'
  | 'READY'
  | 'DRAINING'
  /** Parked and nothing is wrong. The inverse of NEEDS_ATTENTION — see §7. */
  | 'DRAIN_BLOCKED'
  | 'PLAYERS_EVACUATED'
  | 'WORLD_SAVED'
  /** Capability condition: the backend selector resolved to something. */
  | 'BACKENDS_RESOLVED'
  /** Capability condition: the control endpoint answers and speaks a known API. */
  | 'CONTROL_ENDPOINT_READY'
  | 'NEEDS_ATTENTION';

export type ConditionStatus = 'TRUE' | 'FALSE' | 'UNKNOWN';
export type FailureClass = 'RETRYABLE' | 'PERMANENT';

/**
 * Why a drain has stopped advancing when nothing has gone wrong. Not a
 * `FailureReason`, and deliberately not one: see `DrainBlock`.
 */
export type DrainBlockReason = 'AWAITING_ZERO_PLAYERS';

/** Which half of a server's stored state something is about. */
export type StatePart = 'DESIRED' | 'OBSERVED';

/** How the proxy currently routes to one backend. The drain protocol's vocabulary. */
export type BackendRegistration =
  | 'PENDING'
  | 'REGISTERED'
  | 'SEALED'
  | 'DEREGISTERED'
  | 'UNREACHABLE';

/** Wire value. The only forwarding this orchestrator will run. */
export type ForwardingMode = 'modern';

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
  /**
   * A destination was searched for and no server in the fleet had capacity.
   * NOT "waiting for players to log off" — that is `DrainBlockReason`
   * `AWAITING_ZERO_PLAYERS` and is not a failure at all. This one needs an
   * operator to add capacity.
   */
  | 'DRAIN_NO_DESTINATION'
  | 'DRAIN_TRANSFER_FAILED'
  | 'DRAIN_SAVE_TIMEOUT'
  | 'DRAIN_STALLED'
  | 'PROXY_CONTROL_UNREACHABLE'
  | 'PROXY_PLUGIN_INCOMPATIBLE'
  | 'FORWARDING_SECRET_UNAVAILABLE'
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
export type DefinitionInput = PaperServerInput | VelocityProxyInput;

export interface PaperServerInput {
  apiVersion: ApiVersion;
  kind: 'PaperServer';
  metadata: { name: string; labels?: Record<string, string> };
  spec: PaperServerSpecInput;
}

export interface VelocityProxyInput {
  apiVersion: ApiVersion;
  kind: 'VelocityProxy';
  metadata: { name: string; labels?: Record<string, string> };
  spec: VelocityProxySpecInput;
}

export interface VelocityProxySpecInput {
  /** Required. Pinned to a tag or a digest; `latest` is rejected. */
  image: string;
  /** Required — but only `memory` inside it is. */
  resources: {
    memory: string;
    cpu?: string;
    heap?: { max?: string; min?: string };
  };
  /** Required. The coordinate of the modern-forwarding secret — never a value. */
  forwarding: { secret: SecretRef; mode?: ForwardingMode };
  /** Required. `matchLabels` must be non-empty: an empty selector enrols the fleet. */
  backends: {
    selector: { matchLabels: Record<string, string> };
    fallback?: string[];
    drain?: { sealTimeout?: string; destinationTimeout?: string; deregisterTimeout?: string };
  };
  /** `tokenSecret` becomes required once `hostPort` is set — checked at parse time. */
  control?: { port?: number; hostPort?: number; tokenSecret?: SecretRef };
  maxPlayers?: number;
  network?: { port?: number; hostPort?: number };
  lifecycle?: {
    /** No wait timeout, and there will not be one: the only way to spell it is "disconnect them". */
    drain?: { policy?: DrainPolicy; sealTimeout?: string };
    stopGracePeriod?: string;
    startupTimeout?: string;
  };
  placement?: { node?: string };
  /** There is no `storage` block and no way to ask for one. A proxy holds no world. */
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
export type Definition = PaperServerDefinition | VelocityProxyDefinition;

export interface PaperServerDefinition {
  apiVersion: ApiVersion;
  kind: 'PaperServer';
  metadata: { name: string; labels?: Record<string, string> };
  spec: PaperServerSpec;
}

export interface VelocityProxyDefinition {
  apiVersion: ApiVersion;
  kind: 'VelocityProxy';
  metadata: { name: string; labels?: Record<string, string> };
  spec: VelocityProxySpec;
}

export interface VelocityProxySpec {
  image: string;
  maxPlayers: number;
  network: { port: number; hostPort?: number };
  resources: { memory: string; cpu?: string; heap: { max: string; min: string } };
  forwarding: { mode: ForwardingMode; secret: SecretRef };
  backends: {
    selector: { matchLabels: Record<string, string> };
    fallback?: string[];
    drain: { sealTimeout: string; destinationTimeout: string; deregisterTimeout: string };
  };
  control: { port: number; hostPort?: number; tokenSecret?: SecretRef };
  lifecycle: {
    drain: { policy: DrainPolicy; sealTimeout: string };
    stopGracePeriod: string;
    startupTimeout: string;
  };
  placement?: { node: string };
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

export type ServerStatus = PaperServerStatus | VelocityProxyStatus;

/**
 * Observed state of a proxy.
 *
 * Not a `PaperServerStatus` with fields removed. There is no `storage` — a proxy
 * holds no world, and a nullable storage block would invite "not persistent yet"
 * from an absence. What it has instead is the two observations only a proxy can
 * make.
 */
export interface VelocityProxyStatus {
  apiVersion: ApiVersion;
  kind: 'VelocityProxy';
  name: string;
  observedGeneration: number;
  phase: ServerPhase;
  observedAt: string;
  lastTransitionAt: string;
  /** Accepting player connections. Says nothing about having anywhere to send them. */
  ready: boolean;
  draining: boolean;
  image: ImageStatus | null;
  runtime: RuntimeIdentity | null;
  endpoint: { node: string; address: string; port: number } | null;
  players: { online: number; max: number; observedAt: string } | null;
  /** `null` = never observed. Present with `matched: 0` = the selector matched nothing. */
  backends: BackendRoutingStatus | null;
  control: ControlEndpointStatus | null;
  drain: DrainStatus | null;
  failure: FailureStatus | null;
  conditions: Array<{
    type: ConditionType;
    status: ConditionStatus;
    message: string;
    lastTransitionAt: string;
  }>;
}

export interface ImageStatus {
  requested: string;
  resolvedDigest: string | null;
  pulledAt: string | null;
  available: boolean;
}

export interface RuntimeIdentity {
  node: string;
  sandboxId: string;
  containerId: string | null;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  restartCount: number;
}

export interface BackendRoutingStatus {
  observedAt: string;
  /** Matched by the selector, whatever state they are in. */
  matched: number;
  /** In the routing table: REGISTERED or SEALED. */
  registered: number;
  /** May receive a transfer right now: REGISTERED and not draining. */
  destinations: number;
  backends: BackendStatus[];
}

export interface BackendStatus {
  /** A declared object's name. Never a player. */
  server: string;
  registration: BackendRegistration;
  players: { online: number; max: number; observedAt: string } | null;
  drainInitiated: boolean;
  eligibleAsDestination: boolean;
  lastTransitionAt: string;
}

export interface ControlEndpointStatus {
  reachable: boolean;
  /** What the endpoint reported, never anything declared. */
  pluginApiVersion: string | null;
  compatible: boolean;
  lastContactAt: string | null;
}

/** Absent optional fields are `null` here, not omitted. */
export interface PaperServerStatus {
  apiVersion: ApiVersion;
  kind: 'PaperServer';
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
  /** Parked and healthy. Disjoint from `failure` — see `DrainBlock`. */
  blocked: DrainBlock | null;
  failure: FailureStatus | null;
}

/**
 * A drain that is waiting rather than broken.
 *
 * The same shape as `FailureStatus` minus `failureClass`, and the missing field
 * is the point: a block is always retried, so there is nothing to classify. It
 * is a sibling of `failure` rather than a variant of it, and the two are
 * disjoint — read `blocked !== null && failure === null` as *waiting*:
 *
 *     state             drain.blocked   drain.failure
 *     progressing       null            null           (and state !== 'DRAIN_FAILED')
 *     blocked, healthy  set             null
 *     failed            null            set
 *
 * `since` is when the block was first recorded, not when the loop last looked;
 * `observations` is how many passes have found it still true, which is what says
 * the loop is still watching rather than wedged. Count elapsed time from `since`
 * against your own clock — the server renders no duration, because one would be
 * stale the moment it was written.
 */
export interface DrainBlock {
  reason: DrainBlockReason;
  /** Counts and prose; never a player identity. */
  message: string;
  since: string;
  observations: number;
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
  /** Why `status` is null, when the answer is not "nothing has been observed". */
  unreadable: Unreadable | null;
  caughtUp: boolean;
  /** `status === null && unreadable === null`. Test this, not `status === null`. */
  neverObserved: boolean;
  display: {
    state: DisplayState;
    ready: boolean;
    needsAttention: boolean;
    /**
     * True whenever `unreadable` is set, including when the badge says
     * TERMINATING. `needsAttention` is also true in that case — §7: this one
     * says what is wrong, that one says somebody must act.
     */
    unreadable: boolean;
    /**
     * The drain is parked and nothing is wrong — **do not act**.
     *
     * §7 is explicit that this and `needsAttention` CAN both be true and must be
     * ordered rather than treated as exclusive: a drain can be correctly waiting
     * on players while its node is unreachable. (§14's own comment on this field
     * still carries the retracted "never true at the same time" claim; §7
     * retracts it by name. Following §7.)
     *
     * Do not infer this from `playersOnline > 0`.
     */
    drainBlocked: boolean;
    /** 'DRAIN_FAILED' means *parked*, not *broken*. Read it with `drainBlocked`. */
    drainState: DrainState | null;
    playersOnline: number | null;
    playersMax: number | null;
    /** Kind-specific headline numbers. Null for a kind that has none. */
    proxy: ProxyFacts | null;
    detail: string;
  };
}

export interface ProxyFacts {
  /** All null until something has looked — see `backendsObserved`. */
  backendsMatched: number | null;
  backendsRegistered: number | null;
  backendsDestinations: number | null;
  /** False = never observed. True with `backendsMatched: 0` = the selector matched nothing. */
  backendsObserved: boolean;
  controlReachable: boolean | null;
  controlCompatible: boolean | null;
}

/**
 * A part of a server's stored state the store holds and cannot decode.
 *
 * `reason` is operator-facing text on the same terms as `FailureStatus.message`:
 * safe to show, carrying no stack trace and no storage-level detail. `retryable`
 * is false for anything that failed to decode.
 */
export interface Unreadable {
  part: StatePart;
  reason: string;
  retryable: boolean;
}

/**
 * A row the store has a name for and nothing else — its *definition* will not
 * decode, so there is no resource. Reported rather than omitted because absence
 * is how a purge is reported. `name` is the raw stored string: the name itself
 * can be why the row will not read.
 */
export interface UnreadableServer {
  /** Null when the record has no name at all — see §6. Not a placeholder. */
  name: string | null;
  part: StatePart;
  reason: string;
  retryable: boolean;
}

export interface ServerList {
  cursor: string;
  count: number;
  items: ServerResource[];
  unreadableCount: number;
  /** Never filtered — see §6. */
  unreadable: UnreadableServer[];
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
  | 'SERVER_UNREADABLE'
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
    /** Set on SERVER_UNREADABLE. Not evidence about the container — see §3. */
    unreadable: (Unreadable & { name: string | null }) | null;
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
  | {
      type: 'snapshot';
      data: {
        cursor: string;
        count: number;
        items: ServerResource[];
        unreadableCount: number;
        unreadable: UnreadableServer[];
      };
    }
  | {
      type: 'updated';
      data: { name: string; reason: 'definition' | 'status'; server: ServerResource };
    }
  | { type: 'removed'; data: { name: string; reason: 'PURGED' } }
  /**
   * The store holds this row and cannot decode its **definition**, so there is
   * no resource to send. Emphatically NOT `removed`: the server was declared,
   * its container may well be up with players on it, and treating it as a
   * deletion is the failure this event exists to prevent.
   */
  | { type: 'unreadable'; data: UnreadableServer }
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
  kinds: Kind[];
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
    drainBlockReason: DrainBlockReason[];
    displayState: DisplayState[];
    statePart: StatePart[];
    backendRegistration: BackendRegistration[];
    storageMode: StorageMode[];
    forwardingMode: ForwardingMode[];
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
