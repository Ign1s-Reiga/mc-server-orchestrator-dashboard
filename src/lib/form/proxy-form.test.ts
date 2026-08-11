import { describe, expect, it } from 'vitest';
import {
  EMPTY_PROXY_FORM,
  changedProxyPaths,
  fromProxyDefinition,
  proxyInvariantProblems,
  toProxyInput,
} from './proxy-form';
import { PAPER_KNOWN_PATHS, indexViolations } from './definition-form';
import { PROXY_KNOWN_PATHS } from './proxy-form';
import type { VelocityProxyDefinition, VelocityProxyInput, Violation } from '../api/types';

/**
 * The objection this form had to get past.
 *
 * A proxy was edited as a raw document on a stated argument: a structured form
 * covering *most* of a spec is worse than a text box, because a violation on a
 * path with no rendered input is dropped silently and the operator is left with
 * a clean-looking form that will not submit. The orchestrator's own
 * `docs/troubleshooting.md` names that failure.
 *
 * The answer is not "we checked". It is the round trip below: a definition goes
 * through `fromProxyDefinition` and back through `toProxyInput`, and the
 * document that comes out has to equal the one that went in. A field the form
 * forgets is a field the round trip drops, and this fails — so coverage is a
 * build-time property rather than a promise. `MAXIMAL` exists to make that bite:
 * every optional field is set, so forgetting one cannot hide behind a default.
 */

/** Field for field what a live `:api` returned for a created proxy. */
const EFFECTIVE: VelocityProxyDefinition = {
  apiVersion: 'mcorch.dev/v1alpha1',
  kind: 'VelocityProxy',
  metadata: { name: 'lobby' },
  spec: {
    image: 'docker.io/itzg/mc-proxy:2026.6.1',
    maxPlayers: 500,
    network: { port: 25577 },
    resources: { memory: '1Gi', heap: { max: '512Mi', min: '512Mi' } },
    forwarding: { mode: 'modern', secret: { name: 'velocity-forwarding', key: 'secret' } },
    backends: {
      selector: { matchLabels: { 'mcorch.dev/fleet': 'main', tier: 'survival' } },
      drain: { sealTimeout: '10s', destinationTimeout: '30s', deregisterTimeout: '10s' },
    },
    control: { port: 8375 },
    lifecycle: {
      drain: { policy: 'waitForZeroPlayers', sealTimeout: '10s' },
      stopGracePeriod: '1m',
      startupTimeout: '2m',
    },
  },
};

/** The same shape with every optional field populated. */
const MAXIMAL: VelocityProxyDefinition = {
  apiVersion: 'mcorch.dev/v1alpha1',
  kind: 'VelocityProxy',
  metadata: { name: 'edge', labels: { role: 'edge', region: 'eu-west' } },
  spec: {
    image: 'docker.io/itzg/mc-proxy@sha256:abc',
    maxPlayers: 200,
    network: { port: 25577, hostPort: 25565 },
    resources: { memory: '2Gi', cpu: '1500m', heap: { max: '1Gi', min: '512Mi' } },
    forwarding: { mode: 'modern', secret: { name: 'velocity-forwarding', key: 'secret' } },
    backends: {
      selector: { matchLabels: { tier: 'survival' } },
      fallback: ['lobby-01', 'lobby-02'],
      drain: { sealTimeout: '15s', destinationTimeout: '45s', deregisterTimeout: '20s' },
    },
    control: { port: 8375, hostPort: 8080, tokenSecret: { name: 'proxy-control', key: 'token' } },
    lifecycle: {
      drain: { policy: 'waitForZeroPlayers', sealTimeout: '12s' },
      stopGracePeriod: '90s',
      startupTimeout: '5m',
    },
    placement: { node: 'node-a' },
  },
};

/** Exactly what would go on the wire, with `undefined` properties dropped. */
function sent(definition: VelocityProxyDefinition) {
  return JSON.parse(JSON.stringify(toProxyInput(fromProxyDefinition(definition))));
}

describe('the round trip', () => {
  it('returns a real effective definition unchanged', () => {
    expect(sent(EFFECTIVE)).toEqual(EFFECTIVE);
  });

  it('returns one with every optional field set unchanged', () => {
    // The test that actually bites. A field the form does not render is a field
    // `fromProxyDefinition` never reads and `toProxyInput` never writes, and it
    // goes missing here rather than in front of an operator.
    expect(sent(MAXIMAL)).toEqual(MAXIMAL);
  });

  it('is assignable to the input type with no cast', () => {
    // §14's round-trip claim for this kind: the assignment *is* the test.
    const draft: VelocityProxyInput = EFFECTIVE;
    expect(draft.kind).toBe('VelocityProxy');
  });
});

describe('toProxyInput', () => {
  it('omits unset optional fields rather than sending null', () => {
    // §6: an explicit `null` is a violation, not "use the default".
    const document = sent(EFFECTIVE);
    expect('hostPort' in document.spec.network).toBe(false);
    expect('cpu' in document.spec.resources).toBe(false);
    expect('fallback' in document.spec.backends).toBe(false);
    expect('tokenSecret' in document.spec.control).toBe(false);
    expect('placement' in document.spec).toBe(false);
    expect('labels' in document.metadata).toBe(false);
    expect(JSON.stringify(document)).not.toContain('null');
  });

  it('sends an empty selector rather than omitting it', () => {
    // `matchLabels: {}` earns the parser's own sentence — "must not be empty: an
    // empty selector matches every server in the fleet" — attached to the path
    // the textarea is keyed by. Omitting `selector` would trade that for a
    // vaguer complaint about a missing parent.
    const document = toProxyInput(EMPTY_PROXY_FORM);
    expect(document.spec.backends.selector.matchLabels).toEqual({});
  });

  it('keeps a token secret only when both halves are filled in', () => {
    const half = {
      ...EMPTY_PROXY_FORM,
      values: { ...EMPTY_PROXY_FORM.values, 'spec.control.tokenSecret.name': 'proxy-control' },
    };
    // A half-filled coordinate is not a coordinate. Sending `{name}` alone
    // would be a violation about a missing key; sending nothing lets the
    // hostPort pairing rule produce the message that actually helps.
    expect(toProxyInput(half).spec.control?.tokenSecret).toEqual({ name: 'proxy-control' });
  });
});

describe('proxyInvariantProblems', () => {
  const withValues = (values: Record<string, string>) => ({
    ...EMPTY_PROXY_FORM,
    values: { ...EMPTY_PROXY_FORM.values, ...values },
  });

  it('catches a control port colliding with the player port', () => {
    const problems = proxyInvariantProblems(
      withValues({ 'spec.network.port': '25577', 'spec.control.port': '25577' }),
    );
    expect(problems.map((p) => p.path)).toContain('spec.control.port');
  });

  it('catches two host ports colliding', () => {
    const problems = proxyInvariantProblems(
      withValues({ 'spec.network.hostPort': '25565', 'spec.control.hostPort': '25565' }),
    );
    expect(problems.map((p) => p.path)).toContain('spec.control.hostPort');
  });

  it('requires a token secret once the control endpoint is published', () => {
    const problems = proxyInvariantProblems(withValues({ 'spec.control.hostPort': '8080' }));
    expect(problems.map((p) => p.path)).toContain('spec.control.tokenSecret.name');
  });

  it('says nothing about an unpublished control endpoint with no token', () => {
    // The safe-by-omission default: reachable through the node, nothing exposed,
    // so no token is needed and no warning is owed.
    expect(proxyInvariantProblems(withValues({ 'spec.control.port': '8375' }))).toEqual([]);
  });

  it('says nothing about a fully valid form', () => {
    expect(proxyInvariantProblems(fromProxyDefinition(MAXIMAL))).toEqual([]);
  });
});

describe('violation attachment', () => {
  const violation = (field: string): Violation => ({ field, problem: 'nope', location: null });

  it('attaches an exact path to its control', () => {
    const index = indexViolations([violation('spec.control.port')], PROXY_KNOWN_PATHS);
    expect(index.byField.has('spec.control.port')).toBe(true);
    expect(index.unattached).toEqual([]);
  });

  it('attaches a violation on one selector entry to the selector control', () => {
    // The parser reports against the offending entry, not the block. Without
    // prefix attachment this lands in `unattached` — honest, but it sends the
    // operator hunting for a field whose input is right there.
    const index = indexViolations(
      [violation('spec.backends.selector.matchLabels.tier')],
      PROXY_KNOWN_PATHS,
    );
    expect(index.byField.get('spec.backends.selector.matchLabels')).toHaveLength(1);
    expect(index.unattached).toEqual([]);
  });

  it('prefers the deepest control that owns a path', () => {
    const index = indexViolations([violation('spec.backends.drain.sealTimeout')], [
      'spec.backends',
      'spec.backends.drain.sealTimeout',
    ]);
    expect(index.byField.has('spec.backends.drain.sealTimeout')).toBe(true);
  });

  it('does not let one path swallow a longer sibling', () => {
    // `spec.network.port` must not claim `spec.network.portRange` — the guard
    // is the `.`, not the prefix.
    const index = indexViolations([violation('spec.network.portRange')], ['spec.network.port']);
    expect(index.unattached).toHaveLength(1);
  });

  it('still surfaces a path this build has never heard of', () => {
    // The whole safety net: nothing is dropped, so a form cannot look clean and
    // refuse to submit.
    const index = indexViolations([violation('spec.somethingNew')], PROXY_KNOWN_PATHS);
    expect(index.unattached).toHaveLength(1);
    expect(index.total).toBe(1);
  });

  it('leaves the Paper form indexing on its own paths', () => {
    const index = indexViolations([violation('spec.storage.volume.name')], PAPER_KNOWN_PATHS);
    expect(index.byField.has('spec.storage.volume.name')).toBe(true);
  });
});

describe('changedProxyPaths', () => {
  it('names the fields an edit moved', () => {
    const before = fromProxyDefinition(EFFECTIVE);
    const after = { ...before, matchLabels: 'tier=creative' };
    expect(changedProxyPaths(before, after)).toEqual(['spec.backends.selector.matchLabels']);
  });

  it('is empty for an untouched form', () => {
    const form = fromProxyDefinition(MAXIMAL);
    expect(changedProxyPaths(form, form)).toEqual([]);
  });
});
