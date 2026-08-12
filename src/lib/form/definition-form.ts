import type {
  PaperServerDefinition,
  PaperServerInput,
  PaperServerSpec,
  PaperServerSpecInput,
  StorageMode,
  Violation,
} from '../api/types';

/*
 * The outgoing document type is `DefinitionInput`, declared in API.md §14 and
 * transcribed in `../api/types`. This module used to declare its own because
 * the contract had no input type — §14's `Definition` describes the *effective*
 * definition `GET` returns, which a minimal document does not satisfy. The
 * contract now declares both, and a test on the API side pins the required set
 * against the parser, so the local copy is gone: a shape that can drift from
 * the parser is worse than no shape at all.
 */

/**
 * Every editable field, keyed by the dotted path the API uses in
 * `violations[].field`.
 *
 * Keeping the form state keyed by the *server's* path — rather than by a
 * camel-cased local name — is what makes attaching a violation to its input a
 * lookup instead of a mapping table that can drift out of date.
 */
export const FIELD_PATHS = [
  'metadata.name',
  'spec.image',
  'spec.paper.minecraftVersion',
  'spec.paper.build',
  'spec.maxPlayers',
  'spec.network.port',
  'spec.network.hostPort',
  'spec.network.rcon.port',
  'spec.network.rcon.passwordSecret.name',
  'spec.network.rcon.passwordSecret.key',
  'spec.resources.memory',
  'spec.resources.cpu',
  'spec.resources.heap.max',
  'spec.resources.heap.min',
  'spec.storage.mountPath',
  'spec.storage.volume.name',
  'spec.storage.volume.size',
  'spec.lifecycle.drain.playerTransferTimeout',
  'spec.lifecycle.drain.saveTimeout',
  'spec.lifecycle.stopGracePeriod',
  'spec.lifecycle.startupTimeout',
  'spec.placement.node',
] as const;

export type FieldPath = (typeof FIELD_PATHS)[number];

/**
 * Paths the form controls with something other than a text input — a checkbox,
 * a radio group, a textarea. They still have to be recognised so that a
 * violation on one lands next to its control instead of in the leftovers list.
 */
export const CONTROL_PATHS = [
  'spec.eulaAccepted',
  'spec.storage.mode',
  'spec.network.rcon.enabled',
  'metadata.labels',
] as const;

export type ControlPath = (typeof CONTROL_PATHS)[number];

export interface FormState {
  values: Record<FieldPath, string>;
  eulaAccepted: boolean;
  rconEnabled: boolean;
  storageMode: StorageMode;
  /** One `key=value` per line — the same shape as a label selector, unrolled. */
  labels: string;
}

export const EMPTY_FORM: FormState = {
  values: Object.fromEntries(FIELD_PATHS.map((path) => [path, ''])) as Record<FieldPath, string>,
  eulaAccepted: false,
  rconEnabled: false,
  storageMode: 'persistent',
  labels: '',
};

/**
 * Placeholders showing what the parser fills in when a field is left blank.
 *
 * These are documentation, not values: nothing here is sent. The authoritative
 * answer is whatever `POST /validate` returns as the effective definition,
 * which the form shows alongside.
 */
export const DEFAULT_HINTS: Partial<Record<FieldPath, string>> = {
  'spec.maxPlayers': '20',
  'spec.network.port': '25565',
  'spec.network.hostPort': 'not published',
  'spec.network.rcon.port': '25575',
  'spec.resources.cpu': 'unlimited',
  'spec.resources.heap.max': 'memory less headroom',
  'spec.resources.heap.min': 'same as max',
  'spec.storage.mountPath': '/data',
  'spec.storage.volume.name': 'the server name',
  'spec.storage.volume.size': 'unbounded',
  'spec.lifecycle.drain.playerTransferTimeout': '2m',
  'spec.lifecycle.drain.saveTimeout': '3m',
  'spec.lifecycle.stopGracePeriod': 'saveTimeout + 1m',
  'spec.lifecycle.startupTimeout': '5m',
  'spec.placement.node': 'the scheduler chooses',
  'spec.paper.build': 'latest for this version',
};

function trimmed(state: FormState, path: FieldPath): string | undefined {
  const value = state.values[path].trim();
  return value.length > 0 ? value : undefined;
}

function asNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Drops keys whose value is `undefined`, so nothing is ever sent as null. */
function compact<T extends object>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
}

export function parseLabels(text: string): Record<string, string> | undefined {
  const labels: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) continue;
    const equals = trimmedLine.indexOf('=');
    if (equals === -1) continue;
    labels[trimmedLine.slice(0, equals).trim()] = trimmedLine.slice(equals + 1).trim();
  }
  return Object.keys(labels).length > 0 ? labels : undefined;
}

/**
 * What a half-filled form holds: a `DefinitionInput` except that
 * `eulaAccepted` may still be `false`.
 *
 * A draft is not necessarily valid input — that is the entire point of a form —
 * and `DefinitionInput` mandates `eulaAccepted: true`. Sending the `false` the
 * operator actually left there is more honest than casting it away, and it
 * produces exactly the 422 the checkbox needs (`must be true: a Paper server
 * refuses to start until the Minecraft EULA is accepted`), attached to
 * `spec.eulaAccepted`.
 */
export type DefinitionDraft = Omit<PaperServerInput, 'spec'> & {
  spec: Omit<PaperServerSpecInput, 'eulaAccepted'> & { eulaAccepted: boolean };
};

export function toDefinitionInput(state: FormState): DefinitionDraft {
  const heap = compact({
    max: trimmed(state, 'spec.resources.heap.max'),
    min: trimmed(state, 'spec.resources.heap.min'),
  });

  const rcon = state.rconEnabled
    ? ({
        enabled: true as const,
        port: asNumber(trimmed(state, 'spec.network.rcon.port')),
        passwordSecret: {
          name: state.values['spec.network.rcon.passwordSecret.name'].trim(),
          key: state.values['spec.network.rcon.passwordSecret.key'].trim(),
        },
      })
    : undefined;

  const network = compact({
    port: asNumber(trimmed(state, 'spec.network.port')),
    hostPort: asNumber(trimmed(state, 'spec.network.hostPort')),
    rcon,
  });

  const storage: PaperServerSpecInput['storage'] =
    state.storageMode === 'ephemeral'
      ? // Ephemeral has to be asked for by name. Omitting `storage` entirely
        // gives a persistent volume, which is the safe side, so the form never
        // sends `ephemeral` by accident.
        { mode: 'ephemeral', mountPath: trimmed(state, 'spec.storage.mountPath') }
      : {
          mode: 'persistent',
          mountPath: trimmed(state, 'spec.storage.mountPath'),
          volume: compact({
            name: trimmed(state, 'spec.storage.volume.name'),
            size: trimmed(state, 'spec.storage.volume.size'),
          }),
        };

  const drain = compact({
    playerTransferTimeout: trimmed(state, 'spec.lifecycle.drain.playerTransferTimeout'),
    saveTimeout: trimmed(state, 'spec.lifecycle.drain.saveTimeout'),
  });

  const lifecycle = compact({
    drain,
    stopGracePeriod: trimmed(state, 'spec.lifecycle.stopGracePeriod'),
    startupTimeout: trimmed(state, 'spec.lifecycle.startupTimeout'),
  });

  const node = trimmed(state, 'spec.placement.node');

  // Required objects are built directly; only genuinely optional *groups* go
  // through `compact`, which collapses to `undefined` when every child is
  // unset. `JSON.stringify` then drops those properties, which §14 states is
  // the correct way to leave an optional field unset — an explicit `null`
  // would be a violation, not "use the default".
  return {
    apiVersion: 'mcorch.dev/v1alpha1',
    kind: 'PaperServer',
    metadata: {
      name: state.values['metadata.name'].trim(),
      labels: parseLabels(state.labels),
    },
    spec: {
      image: state.values['spec.image'].trim(),
      paper: {
        minecraftVersion: state.values['spec.paper.minecraftVersion'].trim(),
        build: asNumber(trimmed(state, 'spec.paper.build')),
      },
      eulaAccepted: state.eulaAccepted,
      maxPlayers: asNumber(trimmed(state, 'spec.maxPlayers')),
      network,
      resources: {
        memory: state.values['spec.resources.memory'].trim(),
        cpu: trimmed(state, 'spec.resources.cpu'),
        heap,
      },
      storage,
      lifecycle,
      placement: node !== undefined ? { node } : undefined,
    },
  };
}

/**
 * Loads an existing (effective) definition back into the structured form.
 *
 * `PaperServerDefinition`, not `Definition`: this form is built field by field
 * against the Paper spec, and a `VelocityProxy` has a different shape entirely
 * — no `paper`, no `storage`, no `eulaAccepted`, and a backend selector and
 * control endpoint that have no counterpart here. Rather than grow a second
 * field set that would be half-checked, a proxy is edited as a document (see
 * `DocumentEditor`), which goes through the same `/validate`, the same
 * per-field violation attachment and the same `If-Match`.
 */
export function fromDefinition(definition: PaperServerDefinition): FormState {
  const spec: PaperServerSpec = definition.spec;
  const values = { ...EMPTY_FORM.values };

  values['metadata.name'] = definition.metadata.name;
  values['spec.image'] = spec.image;
  values['spec.paper.minecraftVersion'] = spec.paper.minecraftVersion;
  values['spec.paper.build'] = spec.paper.build?.toString() ?? '';
  values['spec.maxPlayers'] = spec.maxPlayers.toString();
  values['spec.network.port'] = spec.network.port.toString();
  values['spec.network.hostPort'] = spec.network.hostPort?.toString() ?? '';
  values['spec.network.rcon.port'] = spec.network.rcon?.port.toString() ?? '';
  values['spec.network.rcon.passwordSecret.name'] = spec.network.rcon?.passwordSecret.name ?? '';
  values['spec.network.rcon.passwordSecret.key'] = spec.network.rcon?.passwordSecret.key ?? '';
  values['spec.resources.memory'] = spec.resources.memory;
  values['spec.resources.cpu'] = spec.resources.cpu ?? '';
  values['spec.resources.heap.max'] = spec.resources.heap.max;
  values['spec.resources.heap.min'] = spec.resources.heap.min;
  values['spec.storage.mountPath'] = spec.storage.mountPath;
  values['spec.storage.volume.name'] =
    spec.storage.mode === 'persistent' ? spec.storage.volume.name : '';
  values['spec.storage.volume.size'] =
    spec.storage.mode === 'persistent' ? (spec.storage.volume.size ?? '') : '';
  values['spec.lifecycle.drain.playerTransferTimeout'] = spec.lifecycle.drain.playerTransferTimeout;
  values['spec.lifecycle.drain.saveTimeout'] = spec.lifecycle.drain.saveTimeout;
  values['spec.lifecycle.stopGracePeriod'] = spec.lifecycle.stopGracePeriod;
  values['spec.lifecycle.startupTimeout'] = spec.lifecycle.startupTimeout;
  values['spec.placement.node'] = spec.placement?.node ?? '';

  return {
    values,
    eulaAccepted: spec.eulaAccepted,
    rconEnabled: spec.network.rcon !== undefined,
    storageMode: spec.storage.mode,
    labels: Object.entries(definition.metadata.labels ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  };
}

/* --------------------------------------------------------------- errors */

/**
 * Violations indexed by field path, plus whatever did not match an input.
 *
 * Nothing is dropped. A violation on a path this form has no control for is
 * still shown — at the top, with its path — because the alternative is an
 * operator staring at a form with no errors on it that will not submit.
 */
export interface ViolationIndex {
  byField: Map<string, Violation[]>;
  unattached: Violation[];
  total: number;
}

/** The paths the Paper form renders a control for. */
export const PAPER_KNOWN_PATHS: readonly string[] = [...FIELD_PATHS, ...CONTROL_PATHS];

/**
 * Attaches each violation to the deepest control that owns it.
 *
 * An exact path match is the common case. The prefix arm exists for the
 * controls that hold a *collection* — `metadata.labels`,
 * `spec.backends.selector.matchLabels` — where the parser reports against the
 * offending entry (`…matchLabels.tier`) rather than the block. Without it those
 * land in `unattached`, which is honest but sends the operator hunting for a
 * field whose input is right there. Longest prefix wins, so a nested control
 * beats its parent, and the `.` guard stops `spec.network.port` from swallowing
 * a hypothetical `spec.network.portRange`.
 */
export function indexViolations(
  violations: readonly Violation[],
  knownPaths: readonly string[] = PAPER_KNOWN_PATHS,
): ViolationIndex {
  const known = new Set<string>(knownPaths);
  const byField = new Map<string, Violation[]>();
  const unattached: Violation[] = [];

  const owner = (field: string): string | null => {
    if (known.has(field)) return field;
    let best: string | null = null;
    for (const candidate of known) {
      if (field.startsWith(`${candidate}.`) && (best === null || candidate.length > best.length)) {
        best = candidate;
      }
    }
    return best;
  };

  for (const violation of violations) {
    const path = owner(violation.field);
    if (path !== null) {
      const existing = byField.get(path);
      if (existing === undefined) byField.set(path, [violation]);
      else existing.push(violation);
    } else {
      unattached.push(violation);
    }
  }

  return { byField, unattached, total: violations.length };
}

export const NO_VIOLATIONS: ViolationIndex = { byField: new Map(), unattached: [], total: 0 };

/**
 * Pulls the line a violation points at out of the exact text that was sent.
 *
 * The API reports `line`/`column` into the request body, and the body this
 * client sends is `JSON.stringify(definition, null, 2)` — so the position is
 * resolvable, and showing the offending line is more use than a number.
 */
export function sourceLine(text: string, line: number): string | null {
  const lines = text.split('\n');
  return line >= 1 && line <= lines.length ? lines[line - 1] : null;
}
