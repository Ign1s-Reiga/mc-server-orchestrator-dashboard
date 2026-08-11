import { describe, expect, it } from 'vitest';
import { backendFormFor, backendSelectorOf, labelLines } from './backend-prefill';
import { EMPTY_FORM, parseLabels, toDefinitionInput } from './definition-form';
import { proxiesClaiming } from '../fleet-tree';
import type { ServerResource, VelocityProxySpec } from '../api/types';

/**
 * The prefill has one job, and it is not "fill in some fields".
 *
 * A form pre-filled from a proxy's selector is a promise that the server it
 * creates will be enrolled behind that proxy. The promise is only kept if the
 * labels survive a round trip through the textarea's `key=value` text and out
 * the other side still satisfying `ProxyFleet.resolve` — so that round trip is
 * what these tests assert, rather than the string the textarea happens to hold.
 */

function proxySpec(matchLabels: Record<string, string>): VelocityProxySpec {
  return {
    image: 'docker.io/itzg/mc-proxy:2026.6.1',
    maxPlayers: 200,
    network: { port: 25577 },
    resources: { memory: '1Gi', heap: { max: '768Mi', min: '256Mi' } },
    forwarding: { mode: 'modern', secret: { name: 'velocity-forwarding', key: 'secret' } },
    backends: {
      selector: { matchLabels },
      drain: { sealTimeout: '30s', destinationTimeout: '30s', deregisterTimeout: '30s' },
    },
    control: { port: 8080 },
    lifecycle: {
      drain: { policy: 'waitForZeroPlayers', sealTimeout: '30s' },
      stopGracePeriod: '60s',
      startupTimeout: '300s',
    },
  };
}

function resource(name: string, kind: 'PaperServer' | 'VelocityProxy', matchLabels?: Record<string, string>) {
  return {
    name,
    kind,
    apiVersion: 'mcorch.dev/v1alpha1',
    definition:
      kind === 'VelocityProxy'
        ? {
            apiVersion: 'mcorch.dev/v1alpha1',
            kind: 'VelocityProxy',
            metadata: { name },
            spec: proxySpec(matchLabels ?? { 'mcorch.dev/fleet': 'main' }),
          }
        : {
            apiVersion: 'mcorch.dev/v1alpha1',
            kind: 'PaperServer',
            metadata: { name },
            spec: {},
          },
    metadata: {
      generation: 1,
      resourceVersion: '1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      deletedAt: null,
      terminating: false,
    },
    status: null,
    statusMeta: null,
    unreadable: null,
    caughtUp: true,
    neverObserved: true,
    display: {
      state: 'READY',
      ready: true,
      needsAttention: false,
      unreadable: false,
      drainBlocked: false,
      drainState: null,
      playersOnline: null,
      playersMax: null,
      proxy: null,
      detail: '',
    },
  } as unknown as ServerResource;
}

describe('backendSelectorOf', () => {
  it('reads the selector off a proxy', () => {
    expect(backendSelectorOf(resource('lobby', 'VelocityProxy', { tier: 'survival' }))).toEqual({
      tier: 'survival',
    });
  });

  it('has nothing to offer for a server', () => {
    expect(backendSelectorOf(resource('survival', 'PaperServer'))).toBeNull();
  });
});

describe('labelLines', () => {
  it('writes key=value per line, sorted by key', () => {
    // Sorted so a form does not reshuffle between visits and read as a change.
    expect(labelLines({ tier: 'survival', 'mcorch.dev/fleet': 'main' })).toBe(
      'mcorch.dev/fleet=main\ntier=survival',
    );
  });

  it('survives a value containing an equals sign', () => {
    const labels = { note: 'a=b' };
    expect(parseLabels(labelLines(labels))).toEqual(labels);
  });
});

describe('backendFormFor', () => {
  const lobby = resource('lobby', 'VelocityProxy', { 'mcorch.dev/fleet': 'main', tier: 'survival' });

  it('produces a form the proxy will actually claim', () => {
    // The whole promise of the button, end to end: selector → textarea text →
    // parsed labels → `resolve` claiming it. A prefill that looked right and
    // did not survive the round trip would create a standalone server that
    // silently never appears behind the proxy.
    const form = backendFormFor(lobby);
    expect(form).not.toBeNull();
    expect(proxiesClaiming(parseLabels(form!.labels), [lobby])).toEqual(['lobby']);
  });

  it('carries every label in the selector, because it is an AND', () => {
    // One missing key and the selector does not match at all.
    expect(parseLabels(backendFormFor(lobby)!.labels)).toEqual({
      'mcorch.dev/fleet': 'main',
      tier: 'survival',
    });
  });

  it('leaves the host port blank', () => {
    // Backends stay unpublished: the proxy is the front door, and publishing a
    // backend directly bypasses the seal that stops new logins during a drain.
    const form = backendFormFor(lobby)!;
    expect(form.values['spec.network.hostPort']).toBe('');
    expect(toDefinitionInput(form).spec.network?.hostPort).toBeUndefined();
  });

  it('refuses to prefill from anything that is not a proxy', () => {
    expect(backendFormFor(resource('survival', 'PaperServer'))).toBeNull();
  });

  it('does not mutate the shared empty form', () => {
    backendFormFor(lobby);
    expect(EMPTY_FORM.labels).toBe('');
    expect(EMPTY_FORM.values['spec.network.hostPort']).toBe('');
  });
});

describe('what the form warns about', () => {
  it('sees a second proxy claiming the same labels', () => {
    // Born conflicted: the loop refuses the container outright, so this is
    // worth saying while the document can still be changed.
    const lobby = resource('lobby', 'VelocityProxy', { tier: 'survival' });
    const overflow = resource('overflow', 'VelocityProxy', { tier: 'survival' });
    const form = backendFormFor(lobby)!;
    expect(proxiesClaiming(parseLabels(form.labels), [lobby, overflow])).toEqual([
      'lobby',
      'overflow',
    ]);
  });

  it('sees labels edited until nothing claims them', () => {
    const lobby = resource('lobby', 'VelocityProxy', { tier: 'survival' });
    expect(proxiesClaiming(parseLabels('tier=creative'), [lobby])).toEqual([]);
    // And an emptied textarea, which parses to `undefined` rather than `{}`.
    expect(proxiesClaiming(parseLabels(''), [lobby])).toEqual([]);
  });
});
