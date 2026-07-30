import type { Definition, Kind, PaperServerSpec, Violation } from '../api/types';

/**
 * The document a form sends.
 *
 * §14 declares `Definition` and says it is "valid input to POST/PUT" — true of
 * a *complete* one, which is what `GET` returns, because `definition.spec` is
 * the effective spec with every default already resolved. It is not the type of
 * a minimal input: `minimal.yaml` omits `maxPlayers`, `network`, `storage`,
 * `lifecycle` and `resources.heap` entirely and validates fine, but that
 * document does not satisfy `PaperServerSpec`. So the outgoing shape gets its
 * own type rather than being forced through the returned one.
 *
 * Optional fields are OMITTED, never sent as `null` — §6 is explicit that the
 * schema treats an explicit `null` as a violation rather than as "unset".
 */
export interface DefinitionInput {
  apiVersion: Definition['apiVersion'];
  kind: Kind;
  metadata: { name: string; labels?: Record<string, string> };
  spec: {
    image: string;
    paper: { minecraftVersion: string; build?: number };
    eulaAccepted: true;
    maxPlayers?: number;
    network?: {
      port?: number;
      hostPort?: number;
      rcon?: { enabled: true; port?: number; passwordSecret: { name: string; key: string } };
    };
    resources: { memory: string; cpu?: string; heap?: { max?: string; min?: string } };
    storage?:
      | { mode: 'persistent'; mountPath?: string; volume?: { name?: string; size?: string } }
      | { mode: 'ephemeral'; mountPath?: string };
    lifecycle?: {
      drain?: { policy?: 'waitForZeroPlayers'; playerTransferTimeout?: string; saveTimeout?: string };
      stopGracePeriod?: string;
      startupTimeout?: string;
    };
    placement?: { node: string };
  };
}

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
  storageMode: 'persistent' | 'ephemeral';
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

export function toDefinitionInput(state: FormState): DefinitionInput {
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

  const storage: DefinitionInput['spec']['storage'] =
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

  return {
    apiVersion: 'mcorch.dev/v1alpha1',
    kind: 'PaperServer',
    metadata: compact({
      name: state.values['metadata.name'].trim(),
      labels: parseLabels(state.labels),
    }) as DefinitionInput['metadata'],
    spec: compact({
      image: state.values['spec.image'].trim(),
      paper: compact({
        minecraftVersion: state.values['spec.paper.minecraftVersion'].trim(),
        build: asNumber(trimmed(state, 'spec.paper.build')),
      }) as DefinitionInput['spec']['paper'],
      eulaAccepted: state.eulaAccepted ? (true as const) : (undefined as never),
      maxPlayers: asNumber(trimmed(state, 'spec.maxPlayers')),
      network,
      resources: compact({
        memory: state.values['spec.resources.memory'].trim(),
        cpu: trimmed(state, 'spec.resources.cpu'),
        heap,
      }) as DefinitionInput['spec']['resources'],
      storage,
      lifecycle,
      placement: node !== undefined ? { node } : undefined,
    }) as DefinitionInput['spec'],
  };
}

/** Loads an existing (effective) definition back into the form for editing. */
export function fromDefinition(definition: Definition): FormState {
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

export function indexViolations(violations: readonly Violation[]): ViolationIndex {
  const known = new Set<string>([...FIELD_PATHS, ...CONTROL_PATHS]);
  const byField = new Map<string, Violation[]>();
  const unattached: Violation[] = [];

  for (const violation of violations) {
    if (known.has(violation.field)) {
      const existing = byField.get(violation.field);
      if (existing === undefined) byField.set(violation.field, [violation]);
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
