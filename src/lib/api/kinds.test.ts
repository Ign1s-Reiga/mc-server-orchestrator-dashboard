import { describe, expect, it } from 'vitest';
import { conditionTone, drainDisposition } from '../display';
import type {
  Definition,
  DefinitionInput,
  PaperServerDefinition,
  ServerStatus,
  VelocityProxyDefinition,
  VelocityProxyStatus,
} from './types';

/**
 * The multi-kind contract.
 *
 * `definition` and `status` are unions tagged by `kind`, returned from the same
 * routes — there is no `/proxies`. The failure this guards against is a client
 * reaching for `status.storage` unconditionally and breaking on the first proxy.
 */

const PAPER: PaperServerDefinition = {
  apiVersion: 'mcorch.dev/v1alpha1',
  kind: 'PaperServer',
  metadata: { name: 'survival-01', labels: { tier: 'survival' } },
  spec: {
    image: 'docker.io/itzg/minecraft-server:2026.6.1',
    paper: { minecraftVersion: '1.21.8' },
    eulaAccepted: true,
    maxPlayers: 20,
    network: { port: 25565 },
    resources: { memory: '4Gi', heap: { max: '3276Mi', min: '3276Mi' } },
    storage: { mode: 'persistent', mountPath: '/data', volume: { name: 'survival-01' } },
    lifecycle: {
      drain: { policy: 'waitForZeroPlayers', playerTransferTimeout: '2m', saveTimeout: '3m' },
      stopGracePeriod: '4m',
      startupTimeout: '5m',
    },
  },
};

/** Field for field what a live `:api` returned for a created proxy. */
const PROXY: VelocityProxyDefinition = {
  apiVersion: 'mcorch.dev/v1alpha1',
  kind: 'VelocityProxy',
  metadata: { name: 'lobby-proxy' },
  spec: {
    image: 'docker.io/itzg/mc-proxy:2026.6.1',
    maxPlayers: 500,
    network: { port: 25577 },
    resources: { memory: '1Gi', heap: { max: '512Mi', min: '512Mi' } },
    forwarding: { mode: 'modern', secret: { name: 'velocity-forwarding', key: 'secret' } },
    backends: {
      selector: { matchLabels: { tier: 'survival' } },
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

describe('kind discriminates every shape', () => {
  it('narrows a definition to the right spec', () => {
    for (const definition of [PAPER, PROXY] as Definition[]) {
      if (definition.kind === 'VelocityProxy') {
        // Only reachable through the discriminant; `spec.storage` does not
        // exist on this branch and this file would not compile if it were read.
        expect(definition.spec.backends.selector.matchLabels).toEqual({ tier: 'survival' });
        expect(definition.spec.forwarding.mode).toBe('modern');
      } else {
        expect(definition.spec.storage.mode).toBe('persistent');
        expect(definition.spec.paper.minecraftVersion).toBe('1.21.8');
      }
    }
  });

  it('keeps a fetched definition of either kind assignable to DefinitionInput', () => {
    // §14's round-trip claim, which must hold for both members of the union:
    // what comes out is always richer than the minimum that goes in.
    const paperDraft: DefinitionInput = PAPER;
    const proxyDraft: DefinitionInput = PROXY;
    expect(paperDraft.kind).toBe('PaperServer');
    expect(proxyDraft.kind).toBe('VelocityProxy');
  });

  it('gives a proxy no storage at all, rather than a null one', () => {
    // §6: a proxy holds no world, and one that claimed to would become a
    // container the orchestrator could never stop — there would be no save to
    // confirm. The absence is structural, so it must not be defaulted.
    expect('storage' in PROXY.spec).toBe(false);

    const proxyStatus: VelocityProxyStatus = {
      apiVersion: 'mcorch.dev/v1alpha1',
      kind: 'VelocityProxy',
      name: 'lobby-proxy',
      observedGeneration: 1,
      phase: 'RUNNING',
      observedAt: '2026-08-04T18:00:00Z',
      lastTransitionAt: '2026-08-04T18:00:00Z',
      ready: true,
      draining: false,
      image: null,
      runtime: null,
      endpoint: null,
      players: null,
      backends: null,
      control: null,
      drain: null,
      failure: null,
      conditions: [],
    };
    const status: ServerStatus = proxyStatus;
    expect('storage' in status).toBe(false);
    expect(status.kind === 'VelocityProxy' ? status.backends : 'unreachable').toBeNull();
  });
});

describe('the drain flag tri-state is ordered, not exclusive', () => {
  // §7 retracts an earlier claim that these were mutually exclusive, and names
  // the case that broke it: a drain can be *correctly* waiting on players while
  // its node is unreachable. Rendering them as exclusive would show "waiting,
  // nothing to do" on a server whose loop had stopped moving it.
  it('lets needsAttention win when both are true', () => {
    expect(drainDisposition({ needsAttention: true, drainBlocked: true })).toBe('needs-a-human');
  });

  it('says waiting only when nothing needs a human', () => {
    expect(drainDisposition({ needsAttention: false, drainBlocked: true })).toBe(
      'waiting-for-players',
    );
  });

  it('falls through to in-progress', () => {
    expect(drainDisposition({ needsAttention: false, drainBlocked: false })).toBe('in-progress');
  });
});

describe('capability conditions', () => {
  // §7: only an *explicitly* False capability condition degrades, never an
  // absent or unknown one — which is what keeps a PaperServer, that raises
  // neither, from ever being DEGRADED by omission.
  it('treats UNKNOWN as not-yet-looked rather than as a problem', () => {
    expect(conditionTone('BACKENDS_RESOLVED', 'UNKNOWN')).toBe('quiet');
    expect(conditionTone('CONTROL_ENDPOINT_READY', 'UNKNOWN')).toBe('quiet');
  });

  it('paints an explicitly FALSE capability as a fault', () => {
    expect(conditionTone('BACKENDS_RESOLVED', 'FALSE')).toBe('fault');
    expect(conditionTone('CONTROL_ENDPOINT_READY', 'FALSE')).toBe('fault');
  });

  it('never paints a drain block as a fault', () => {
    // A block is the drain behaving correctly — players are still connected and
    // the protocol is waiting rather than disconnecting anybody.
    expect(conditionTone('DRAIN_BLOCKED', 'TRUE')).toBe('work');
  });
});
