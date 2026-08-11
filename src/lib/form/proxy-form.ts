/**
 * The `VelocityProxy` spec as form state.
 *
 * This is the second field set the codebase spent a while deliberately not
 * writing. The objection was recorded in `DocumentEditor` and worth restating,
 * because it is the thing this module has to earn its way past: a structured
 * form that covers *most* of a spec is worse than a text box, since a violation
 * on a path with no rendered input is dropped silently and the operator gets a
 * clean-looking form that will not submit. The orchestrator's own
 * `docs/troubleshooting.md` names that exact failure.
 *
 * Two things answer it, and neither is a promise:
 *
 * - **Coverage is pinned by a round-trip test.** `proxy-form.test.ts` takes a
 *   real effective definition, runs it through `fromProxyDefinition` and back
 *   through `toProxyInput`, and asserts the result is unchanged. A field this
 *   form forgets is a field the round trip drops, and the test fails. That is a
 *   stronger guarantee than "we checked".
 * - **Nothing is dropped at runtime either.** `indexViolations` attaches by
 *   longest known prefix and collects the rest in `unattached`, which the form
 *   renders unconditionally. A path this build has never heard of still appears.
 *
 * The document editor is kept alongside rather than replaced. §5 reports a line
 * and column into the text as sent, so for a document written by hand it can
 * point at the exact line typed — that is a real advantage this form cannot
 * reproduce, and it is also the only way to express something a future schema
 * adds before this file catches up.
 */

import type {
  DrainPolicy,
  ForwardingMode,
  VelocityProxyDefinition,
  VelocityProxyInput,
  VelocityProxySpec,
  Violation,
} from '../api/types';
import { parseLabels } from './definition-form';

/**
 * Every scalar field, keyed by the dotted path the API uses in
 * `violations[].field` — so attaching a violation to its input is a lookup
 * rather than a mapping table that drifts out of date.
 */
export const PROXY_FIELD_PATHS = [
  'metadata.name',
  'spec.image',
  'spec.maxPlayers',
  'spec.network.port',
  'spec.network.hostPort',
  'spec.resources.memory',
  'spec.resources.cpu',
  'spec.resources.heap.max',
  'spec.resources.heap.min',
  'spec.forwarding.secret.name',
  'spec.forwarding.secret.key',
  'spec.backends.drain.sealTimeout',
  'spec.backends.drain.destinationTimeout',
  'spec.backends.drain.deregisterTimeout',
  'spec.control.port',
  'spec.control.hostPort',
  'spec.control.tokenSecret.name',
  'spec.control.tokenSecret.key',
  'spec.lifecycle.drain.sealTimeout',
  'spec.lifecycle.stopGracePeriod',
  'spec.lifecycle.startupTimeout',
  'spec.placement.node',
] as const;

export type ProxyFieldPath = (typeof PROXY_FIELD_PATHS)[number];

/**
 * Paths driven by something other than a text input — a textarea of pairs, a
 * list, a radio group. They still have to be recognised so a violation on one
 * lands beside its control instead of in the leftovers.
 */
export const PROXY_CONTROL_PATHS = [
  'metadata.labels',
  'spec.backends.selector.matchLabels',
  'spec.backends.fallback',
  'spec.forwarding.mode',
  'spec.lifecycle.drain.policy',
] as const;

export type ProxyControlPath = (typeof PROXY_CONTROL_PATHS)[number];

export const PROXY_KNOWN_PATHS: readonly string[] = [
  ...PROXY_FIELD_PATHS,
  ...PROXY_CONTROL_PATHS,
];

export interface ProxyFormState {
  values: Record<ProxyFieldPath, string>;
  /** One `key=value` per line. */
  labels: string;
  /** One `key=value` per line. Empty is a violation, not "match everything". */
  matchLabels: string;
  /** One server name per line. */
  fallback: string;
  forwardingMode: ForwardingMode;
  drainPolicy: DrainPolicy;
}

export const EMPTY_PROXY_FORM: ProxyFormState = {
  values: Object.fromEntries(PROXY_FIELD_PATHS.map((path) => [path, ''])) as Record<
    ProxyFieldPath,
    string
  >,
  labels: '',
  matchLabels: '',
  fallback: '',
  forwardingMode: 'modern',
  drainPolicy: 'waitForZeroPlayers',
};

/**
 * What the parser fills in when a field is left blank.
 *
 * Documentation, not values — nothing here is sent. The authoritative answer is
 * whatever `POST /validate` returns as the effective definition, which the form
 * shows alongside. Taken from `VelocityProxyDefaults`.
 */
export const PROXY_DEFAULT_HINTS: Partial<Record<ProxyFieldPath, string>> = {
  'spec.maxPlayers': '500',
  'spec.network.port': '25577',
  'spec.network.hostPort': 'not published',
  'spec.resources.cpu': 'unlimited',
  'spec.resources.heap.max': 'memory less headroom',
  'spec.resources.heap.min': 'same as max',
  'spec.control.port': '8375',
  'spec.control.hostPort': 'not published',
  'spec.backends.drain.sealTimeout': '10s',
  'spec.backends.drain.destinationTimeout': '30s',
  'spec.backends.drain.deregisterTimeout': '10s',
  'spec.lifecycle.drain.sealTimeout': '10s',
  'spec.lifecycle.stopGracePeriod': '1m',
  'spec.lifecycle.startupTimeout': '2m',
  'spec.placement.node': 'the scheduler chooses',
};

function trimmed(state: ProxyFormState, path: ProxyFieldPath): string | undefined {
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

/** One name per line, blanks dropped. `undefined` when nothing is listed. */
export function parseList(text: string): string[] | undefined {
  const items = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return items.length > 0 ? items : undefined;
}

export function listLines(items: readonly string[] | undefined): string {
  return (items ?? []).join('\n');
}

export function pairLines(pairs: Record<string, string> | undefined): string {
  return Object.entries(pairs ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

/**
 * The document this form would send.
 *
 * Required objects are built directly; only genuinely optional *groups* go
 * through `compact`, which collapses to `undefined` when every child is unset.
 * `JSON.stringify` then drops those properties, which §14 states is the correct
 * way to leave an optional field unset — an explicit `null` is a violation, not
 * "use the default".
 *
 * An unfilled required field is sent as it stands — an empty string, an empty
 * `matchLabels` — rather than omitted. That is deliberate: it produces the
 * violation the operator needs, on the path their input is keyed by, instead of
 * a vaguer one about a missing parent.
 */
export function toProxyInput(state: ProxyFormState): VelocityProxyInput {
  const heap = compact({
    max: trimmed(state, 'spec.resources.heap.max'),
    min: trimmed(state, 'spec.resources.heap.min'),
  });

  const network = compact({
    port: asNumber(trimmed(state, 'spec.network.port')),
    hostPort: asNumber(trimmed(state, 'spec.network.hostPort')),
  });

  const tokenSecret = compact({
    name: trimmed(state, 'spec.control.tokenSecret.name'),
    key: trimmed(state, 'spec.control.tokenSecret.key'),
  }) as { name: string; key: string } | undefined;

  const control = compact({
    port: asNumber(trimmed(state, 'spec.control.port')),
    hostPort: asNumber(trimmed(state, 'spec.control.hostPort')),
    tokenSecret,
  });

  const backendDrain = compact({
    sealTimeout: trimmed(state, 'spec.backends.drain.sealTimeout'),
    destinationTimeout: trimmed(state, 'spec.backends.drain.destinationTimeout'),
    deregisterTimeout: trimmed(state, 'spec.backends.drain.deregisterTimeout'),
  });

  const lifecycleDrain = compact({
    policy: state.drainPolicy,
    sealTimeout: trimmed(state, 'spec.lifecycle.drain.sealTimeout'),
  });

  const lifecycle = compact({
    drain: lifecycleDrain,
    stopGracePeriod: trimmed(state, 'spec.lifecycle.stopGracePeriod'),
    startupTimeout: trimmed(state, 'spec.lifecycle.startupTimeout'),
  });

  const node = trimmed(state, 'spec.placement.node');

  return {
    apiVersion: 'mcorch.dev/v1alpha1',
    kind: 'VelocityProxy',
    metadata: {
      name: state.values['metadata.name'].trim(),
      labels: parseLabels(state.labels),
    },
    spec: {
      image: state.values['spec.image'].trim(),
      maxPlayers: asNumber(trimmed(state, 'spec.maxPlayers')),
      network,
      resources: {
        memory: state.values['spec.resources.memory'].trim(),
        cpu: trimmed(state, 'spec.resources.cpu'),
        heap,
      },
      forwarding: {
        mode: state.forwardingMode,
        secret: {
          name: state.values['spec.forwarding.secret.name'].trim(),
          key: state.values['spec.forwarding.secret.key'].trim(),
        },
      },
      backends: {
        // Sent even when empty. An empty selector is a violation the parser
        // names precisely ("matchLabels must not be empty: an empty selector
        // matches every server in the fleet"), and that is the sentence the
        // operator needs — omitting `selector` would trade it for "is required".
        selector: { matchLabels: parseLabels(state.matchLabels) ?? {} },
        fallback: parseList(state.fallback),
        drain: backendDrain,
      },
      control,
      lifecycle,
      placement: node !== undefined ? { node } : undefined,
    },
  };
}

/**
 * Loads an effective definition back into the form.
 *
 * Every field in `VelocityProxySpec` is read here. The round-trip test is what
 * keeps that true: this function and `toProxyInput` are each other's inverse,
 * and a field added to the spec but not to both shows up as a diff.
 */
export function fromProxyDefinition(definition: VelocityProxyDefinition): ProxyFormState {
  const spec: VelocityProxySpec = definition.spec;
  const values = { ...EMPTY_PROXY_FORM.values };

  values['metadata.name'] = definition.metadata.name;
  values['spec.image'] = spec.image;
  values['spec.maxPlayers'] = spec.maxPlayers.toString();
  values['spec.network.port'] = spec.network.port.toString();
  values['spec.network.hostPort'] = spec.network.hostPort?.toString() ?? '';
  values['spec.resources.memory'] = spec.resources.memory;
  values['spec.resources.cpu'] = spec.resources.cpu ?? '';
  values['spec.resources.heap.max'] = spec.resources.heap.max;
  values['spec.resources.heap.min'] = spec.resources.heap.min;
  values['spec.forwarding.secret.name'] = spec.forwarding.secret.name;
  values['spec.forwarding.secret.key'] = spec.forwarding.secret.key;
  values['spec.backends.drain.sealTimeout'] = spec.backends.drain.sealTimeout;
  values['spec.backends.drain.destinationTimeout'] = spec.backends.drain.destinationTimeout;
  values['spec.backends.drain.deregisterTimeout'] = spec.backends.drain.deregisterTimeout;
  values['spec.control.port'] = spec.control.port.toString();
  values['spec.control.hostPort'] = spec.control.hostPort?.toString() ?? '';
  values['spec.control.tokenSecret.name'] = spec.control.tokenSecret?.name ?? '';
  values['spec.control.tokenSecret.key'] = spec.control.tokenSecret?.key ?? '';
  values['spec.lifecycle.drain.sealTimeout'] = spec.lifecycle.drain.sealTimeout;
  values['spec.lifecycle.stopGracePeriod'] = spec.lifecycle.stopGracePeriod;
  values['spec.lifecycle.startupTimeout'] = spec.lifecycle.startupTimeout;
  values['spec.placement.node'] = spec.placement?.node ?? '';

  return {
    values,
    labels: pairLines(definition.metadata.labels),
    matchLabels: pairLines(spec.backends.selector.matchLabels),
    fallback: listLines(spec.backends.fallback),
    forwardingMode: spec.forwarding.mode,
    drainPolicy: spec.lifecycle.drain.policy,
  };
}

/** Which fields this form has moved away from what was loaded. */
export function changedProxyPaths(before: ProxyFormState, after: ProxyFormState): string[] {
  const changed: string[] = [];
  for (const path of PROXY_FIELD_PATHS) {
    if (before.values[path].trim() !== after.values[path].trim()) changed.push(path);
  }
  if (before.labels.trim() !== after.labels.trim()) changed.push('metadata.labels');
  if (before.matchLabels.trim() !== after.matchLabels.trim()) {
    changed.push('spec.backends.selector.matchLabels');
  }
  if (before.fallback.trim() !== after.fallback.trim()) changed.push('spec.backends.fallback');
  if (before.forwardingMode !== after.forwardingMode) changed.push('spec.forwarding.mode');
  if (before.drainPolicy !== after.drainPolicy) changed.push('spec.lifecycle.drain.policy');
  return changed;
}

/**
 * The two parse-time invariants a proxy has that a form can catch first.
 *
 * `SpecInvariants.proxyPortProblem` and the `hostPort` → `tokenSecret` pairing
 * are both rejections, not warnings, so the operator meets them either way. The
 * only question is whether they meet them next to the field or as a 422 after
 * pressing the button.
 */
export function proxyInvariantProblems(state: ProxyFormState): Array<{
  path: ProxyFieldPath;
  problem: string;
}> {
  const problems: Array<{ path: ProxyFieldPath; problem: string }> = [];
  const controlPort = trimmed(state, 'spec.control.port');
  const networkPort = trimmed(state, 'spec.network.port');
  const controlHostPort = trimmed(state, 'spec.control.hostPort');
  const networkHostPort = trimmed(state, 'spec.network.hostPort');

  if (controlPort !== undefined && networkPort !== undefined && controlPort === networkPort) {
    problems.push({
      path: 'spec.control.port',
      problem: `must differ from spec.network.port, both are ${controlPort}. A control endpoint sharing the player listener either does not start or answers seal requests on the port players are connected to`,
    });
  }
  if (
    controlHostPort !== undefined &&
    networkHostPort !== undefined &&
    controlHostPort === networkHostPort
  ) {
    problems.push({
      path: 'spec.control.hostPort',
      problem: `must differ from spec.network.hostPort, both are ${controlHostPort}`,
    });
  }
  if (
    controlHostPort !== undefined &&
    (trimmed(state, 'spec.control.tokenSecret.name') === undefined ||
      trimmed(state, 'spec.control.tokenSecret.key') === undefined)
  ) {
    problems.push({
      path: 'spec.control.tokenSecret.name',
      problem:
        'is required once spec.control.hostPort is set: publishing the control endpoint exposes a plane that can move every player in the fleet',
    });
  }
  return problems;
}

/** Shaped like an API violation so it can be rendered by the same code. */
export function asViolation(problem: { path: string; problem: string }): Violation {
  return { field: problem.path, problem: problem.problem, location: null };
}
