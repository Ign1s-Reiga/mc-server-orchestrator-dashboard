import { describe, expect, it } from 'vitest';
import { attachmentOf, buildFleetTree, observedRegistration, selectorMatches } from './fleet-tree';
import type {
  BackendStatus,
  PaperServerSpec,
  ServerResource,
  VelocityProxySpec,
  VelocityProxyStatus,
} from './api/types';

/**
 * The tree the fleet page draws has to be the one the reconcile loop acts on.
 *
 * `ProxyFleet.resolve` in `:core` is the authority on which proxy claims which
 * backend, and this file computes the same function from the same inputs. Three
 * of its rules are the ones a looser "related servers" view would get wrong, and
 * each is pinned below: only a `PaperServer` is ever a backend, a selector is an
 * AND of equalities, and a server two selectors claim belongs to neither — that
 * last one is not a display ambiguity, it is a state in which the loop refuses
 * to create the container at all.
 */

const PAPER_SPEC: PaperServerSpec = {
  image: 'docker.io/itzg/minecraft-server:2024.1.0',
  paper: { minecraftVersion: '1.20.6' },
  eulaAccepted: true,
  maxPlayers: 20,
  network: { port: 25565 },
  resources: { memory: '2Gi', heap: { max: '1536Mi', min: '512Mi' } },
  storage: { mode: 'persistent', mountPath: '/data', volume: { name: 'world' } },
  lifecycle: {
    drain: { policy: 'waitForZeroPlayers', playerTransferTimeout: '60s', saveTimeout: '30s' },
    stopGracePeriod: '90s',
    startupTimeout: '300s',
  },
};

function proxySpec(matchLabels: Record<string, string>): VelocityProxySpec {
  return {
    image: 'docker.io/itzg/mc-proxy:2024.1.0',
    maxPlayers: 200,
    network: { port: 25577 },
    resources: { memory: '1Gi', heap: { max: '768Mi', min: '256Mi' } },
    forwarding: { mode: 'modern', secret: { name: 'forwarding', key: 'secret' } },
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

function base(name: string): Omit<ServerResource, 'kind' | 'definition' | 'status'> {
  return {
    name,
    apiVersion: 'mcorch.dev/v1alpha1',
    metadata: {
      generation: 1,
      resourceVersion: '1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      deletedAt: null,
      terminating: false,
    },
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
      playersOnline: 0,
      playersMax: 20,
      proxy: null,
      detail: '',
    },
  };
}

function paper(name: string, labels?: Record<string, string>): ServerResource {
  return {
    ...base(name),
    kind: 'PaperServer',
    definition: {
      apiVersion: 'mcorch.dev/v1alpha1',
      kind: 'PaperServer',
      metadata: labels === undefined ? { name } : { name, labels },
      spec: PAPER_SPEC,
    },
    status: null,
  };
}

function proxy(
  name: string,
  matchLabels: Record<string, string>,
  options: { labels?: Record<string, string>; backends?: BackendStatus[] | null } = {},
): ServerResource {
  const routing = options.backends;
  const status: VelocityProxyStatus | null =
    routing === undefined
      ? null
      : {
          apiVersion: 'mcorch.dev/v1alpha1',
          kind: 'VelocityProxy',
          name,
          observedGeneration: 1,
          phase: 'RUNNING',
          observedAt: '2026-01-01T00:00:00Z',
          lastTransitionAt: '2026-01-01T00:00:00Z',
          ready: true,
          draining: false,
          image: null,
          runtime: null,
          endpoint: null,
          players: null,
          backends:
            routing === null
              ? null
              : {
                  observedAt: '2026-01-01T00:00:00Z',
                  matched: routing.length,
                  registered: routing.filter((b) => b.registration === 'REGISTERED' || b.registration === 'SEALED')
                    .length,
                  destinations: routing.filter((b) => b.eligibleAsDestination).length,
                  backends: routing,
                },
          control: null,
          drain: null,
          failure: null,
          conditions: [],
        };
  return {
    ...base(name),
    kind: 'VelocityProxy',
    definition: {
      apiVersion: 'mcorch.dev/v1alpha1',
      kind: 'VelocityProxy',
      metadata: options.labels === undefined ? { name } : { name, labels: options.labels },
      spec: proxySpec(matchLabels),
    },
    status,
  };
}

function backend(server: string, registration: BackendStatus['registration']): BackendStatus {
  return {
    server,
    registration,
    players: { online: 3, max: 20, observedAt: '2026-01-01T00:00:00Z' },
    drainInitiated: false,
    eligibleAsDestination: registration === 'REGISTERED',
    lastTransitionAt: '2026-01-01T00:00:00Z',
  };
}

/** `name@depth`, which is the whole shape of a rendered tree in one string. */
function shape(rows: readonly { server: ServerResource; depth: number; context: boolean }[]): string[] {
  return rows.map((row) => `${row.context ? '~' : ''}${row.server.name}@${row.depth}`);
}

describe('selectorMatches', () => {
  it('is an AND of equalities, like `labelSelector` and `BackendSelector`', () => {
    expect(selectorMatches({ tier: 'survival' }, { tier: 'survival', region: 'eu' })).toBe(true);
    expect(selectorMatches({ tier: 'survival', region: 'eu' }, { tier: 'survival' })).toBe(false);
    expect(selectorMatches({ tier: 'survival' }, { tier: 'creative' })).toBe(false);
    expect(selectorMatches({ tier: 'survival' }, undefined)).toBe(false);
  });
});

describe('attachment', () => {
  const main = proxy('lobby', { fleet: 'main' });

  it('puts a matching Paper server behind the proxy', () => {
    expect(attachmentOf(paper('survival', { fleet: 'main' }), [main])).toEqual({
      kind: 'behind',
      proxy: 'lobby',
    });
  });

  it('leaves a Paper server no selector claims standalone', () => {
    expect(attachmentOf(paper('creative', { fleet: 'other' }), [main])).toEqual({ kind: 'standalone' });
    expect(attachmentOf(paper('bare'), [main])).toEqual({ kind: 'standalone' });
  });

  it('never puts a proxy behind another proxy, even when its labels match', () => {
    // `resolve` narrows to `PaperServerDefinition` before it matches a single
    // label, so a proxy carrying `fleet=main` is still not a backend. Without
    // this the tree could nest proxy under proxy — and, with two proxies whose
    // labels satisfied each other, cycle.
    const labelled = proxy('edge', { fleet: 'edge' }, { labels: { fleet: 'main' } });
    expect(attachmentOf(labelled, [main, labelled])).toEqual({ kind: 'standalone' });
  });

  it('calls a server two selectors claim conflicted, not shared', () => {
    const second = proxy('overflow', { fleet: 'main' });
    expect(attachmentOf(paper('survival', { fleet: 'main' }), [main, second])).toEqual({
      kind: 'conflicted',
      proxies: ['lobby', 'overflow'],
    });
  });
});

describe('buildFleetTree', () => {
  it('nests backends under their proxy and leaves everything else at the top', () => {
    const tree = buildFleetTree([
      proxy('lobby', { fleet: 'main' }),
      paper('alpha', { fleet: 'main' }),
      paper('solo'),
      paper('zulu', { fleet: 'main' }),
    ]);
    expect(shape(tree.rows)).toEqual(['lobby@0', 'alpha@1', 'zulu@1', 'solo@0']);
    expect(tree.matched).toBe(4);
    expect(tree.conflicted).toEqual([]);
  });

  it('keeps the top level in name order rather than floating proxies above it', () => {
    // The API sorts its list by name and so does the store. Nesting already
    // makes a proxy obvious; a top level you cannot predict does not.
    const tree = buildFleetTree([
      paper('aardvark'),
      proxy('lobby', { fleet: 'main' }),
      paper('mid', { fleet: 'main' }),
      paper('zebra'),
    ]);
    expect(shape(tree.rows)).toEqual(['aardvark@0', 'lobby@0', 'mid@1', 'zebra@0']);
  });

  it('marks the last child, so the branch can be drawn with a corner', () => {
    const tree = buildFleetTree([
      proxy('lobby', { fleet: 'main' }),
      paper('alpha', { fleet: 'main' }),
      paper('beta', { fleet: 'main' }),
    ]);
    expect(tree.rows.map((row) => row.last)).toEqual([false, false, true]);
  });

  it('leaves a conflicted server at the top level, under neither claimant', () => {
    const tree = buildFleetTree([
      proxy('lobby', { fleet: 'main' }),
      proxy('overflow', { fleet: 'main' }),
      paper('survival', { fleet: 'main' }),
    ]);
    expect(shape(tree.rows)).toEqual(['lobby@0', 'overflow@0', 'survival@0']);
    expect(tree.conflicted.map((server) => server.name)).toEqual(['survival']);
    expect(tree.rows[2].attachment).toEqual({ kind: 'conflicted', proxies: ['lobby', 'overflow'] });
  });

  it('shows an unmatched proxy as context when a backend under it matched', () => {
    // Dropping it would let the backend float to the top level, which says it
    // is standalone — the one thing this view exists to get right.
    const tree = buildFleetTree(
      [proxy('lobby', { fleet: 'main' }), paper('alpha', { fleet: 'main' }), paper('solo')],
      { matches: (server) => server.name === 'alpha' },
    );
    expect(shape(tree.rows)).toEqual(['~lobby@0', 'alpha@1']);
    // The context row is not one of the results, so it is not counted.
    expect(tree.matched).toBe(1);
  });

  it('shows a matching proxy alone when none of its backends matched', () => {
    const tree = buildFleetTree(
      [proxy('lobby', { fleet: 'main' }), paper('alpha', { fleet: 'main' })],
      { matches: (server) => server.name === 'lobby' },
    );
    expect(shape(tree.rows)).toEqual(['lobby@0']);
    expect(tree.matched).toBe(1);
  });

  it('drops a proxy only when neither it nor any backend matched', () => {
    const tree = buildFleetTree(
      [proxy('lobby', { fleet: 'main' }), paper('alpha', { fleet: 'main' }), paper('solo')],
      { matches: (server) => server.name === 'solo' },
    );
    expect(shape(tree.rows)).toEqual(['solo@0']);
  });

  it('folds a collapsed proxy without dropping its backends from the count', () => {
    const tree = buildFleetTree(
      [proxy('lobby', { fleet: 'main' }), paper('alpha', { fleet: 'main' }), paper('beta', { fleet: 'main' })],
      { collapsed: new Set(['lobby']) },
    );
    expect(shape(tree.rows)).toEqual(['lobby@0']);
    expect(tree.rows[0].collapsed).toBe(2);
    // The filter selected all three; collapsing is a disclosure, not a filter,
    // so "3 of 3" must not quietly become "1 of 3".
    expect(tree.matched).toBe(3);
  });

  it('counts only what the filter kept when a collapsed proxy is also filtered', () => {
    const tree = buildFleetTree(
      [proxy('lobby', { fleet: 'main' }), paper('alpha', { fleet: 'main' }), paper('beta', { fleet: 'main' })],
      { matches: (server) => server.name !== 'beta', collapsed: new Set(['lobby']) },
    );
    expect(tree.rows[0].collapsed).toBe(1);
    expect(tree.matched).toBe(2);
  });

  it('reports every proxy that has backends, filter or no filter', () => {
    const tree = buildFleetTree(
      [proxy('lobby', { fleet: 'main' }), paper('alpha', { fleet: 'main' })],
      { matches: () => false },
    );
    expect(tree.rows).toEqual([]);
    expect([...tree.parents]).toEqual(['lobby']);
  });
});

describe('observedRegistration', () => {
  it("reads the parent proxy's own routing table", () => {
    const lobby = proxy('lobby', { fleet: 'main' }, { backends: [backend('alpha', 'SEALED')] });
    expect(observedRegistration(lobby, 'alpha')).toEqual({
      registration: 'SEALED',
      drainInitiated: false,
      online: 3,
    });
  });

  it('says nothing when the table has never been observed', () => {
    // `backends: null` is "nothing has looked yet" and must not read as a
    // backend that is missing from the table (§6, §14).
    expect(observedRegistration(proxy('lobby', { fleet: 'main' }, { backends: null }), 'alpha')).toBeNull();
    expect(observedRegistration(proxy('lobby', { fleet: 'main' }), 'alpha')).toBeNull();
  });

  it('says nothing when the selector claims a backend the table has not caught up with', () => {
    // Ordinary and transient — a label edit lands in the definition before the
    // next assertion pass. Painting it as a fault would light up every edit.
    const lobby = proxy('lobby', { fleet: 'main' }, { backends: [backend('alpha', 'REGISTERED')] });
    expect(observedRegistration(lobby, 'beta')).toBeNull();
  });
});
