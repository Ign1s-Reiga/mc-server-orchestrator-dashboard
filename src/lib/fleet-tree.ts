/**
 * Which proxy stands in front of which server, and how that becomes a tree.
 *
 * The orchestrator already answers this question — `ProxyFleet.resolve` in
 * `:core` — and this file computes the same function from the same inputs, so
 * the shape on screen is the shape the reconcile loop acts on rather than a
 * second, looser idea of "related". Three of its rules are load-bearing here:
 *
 * - **The structure comes from the declared selector, not from the observed
 *   routing table.** `resolve` reads definitions only, and so does this. That
 *   also makes the tree available on the first snapshot — `status.backends` is
 *   `null` until something has looked, and a topology that only appears after
 *   the first successful observation would flatten itself during exactly the
 *   incident an operator opened this page for. The observed table still has a
 *   job (see `observedRegistration`); it is just not what decides parentage.
 * - **Only a `PaperServer` can be a backend.** `resolve` narrows to
 *   `PaperServerDefinition` before it matches anything, so a proxy carrying
 *   labels that satisfy another proxy's selector is still not behind it. The
 *   tree is therefore exactly two levels deep and cannot cycle.
 * - **A backend belongs to one proxy.** Two claimants is not "shown twice", it
 *   is `Resolution.Conflicted`: the loop refuses to create or recreate the
 *   container at all. Nesting such a server under either proxy would draw a
 *   relationship the orchestrator has explicitly declined to establish, so it
 *   is nested under neither.
 */

import type { ServerResource, VelocityProxyDefinition } from './api/types';

/**
 * Where a server sits — the dashboard's copy of `ProxyFleet.Resolution`.
 *
 * A proxy is always `standalone`: nothing is ever in front of it.
 */
export type Attachment =
  | { readonly kind: 'standalone' }
  | { readonly kind: 'behind'; readonly proxy: string }
  /** Claimed by more than one selector, so claimed by none. Sorted by name. */
  | { readonly kind: 'conflicted'; readonly proxies: readonly string[] };

/**
 * `BackendSelector.matches`: an AND of equalities, the same reading the
 * `labelSelector` query parameter gets (§6).
 *
 * An empty `matchLabels` would match everything, which is why the schema
 * refuses to construct one — a definition that decoded cannot carry one, and a
 * definition that did not decode never becomes a `ServerResource`. The `every`
 * below is left to mirror the Kotlin exactly rather than special-cased here.
 */
export function selectorMatches(
  matchLabels: Record<string, string>,
  labels: Record<string, string> | undefined,
): boolean {
  const present = labels ?? {};
  return Object.entries(matchLabels).every(([key, value]) => present[key] === value);
}

function proxyDefinitionOf(server: ServerResource): VelocityProxyDefinition | null {
  return server.definition.kind === 'VelocityProxy' ? server.definition : null;
}

/**
 * Every proxy whose selector claims `server`, by name, sorted.
 *
 * Empty for a proxy: `resolve` returns `Standalone` for anything that is not a
 * `PaperServer` before it looks at a single label.
 */
export function claimingProxies(
  server: ServerResource,
  proxies: readonly ServerResource[],
): string[] {
  if (server.definition.kind !== 'PaperServer') return [];
  const labels = server.definition.metadata.labels;
  return proxies
    .filter((proxy) => {
      const definition = proxyDefinitionOf(proxy);
      return definition !== null && selectorMatches(definition.spec.backends.selector.matchLabels, labels);
    })
    .map((proxy) => proxy.name)
    .sort();
}

export function attachmentOf(
  server: ServerResource,
  proxies: readonly ServerResource[],
): Attachment {
  const claiming = claimingProxies(server, proxies);
  if (claiming.length === 0) return { kind: 'standalone' };
  if (claiming.length === 1) return { kind: 'behind', proxy: claiming[0] };
  return { kind: 'conflicted', proxies: claiming };
}

/**
 * How the proxy in front of this backend is currently routing to it.
 *
 * Observed, and deliberately separate from parentage: a backend that the
 * selector claims but that the routing table has not caught up with yet is a
 * normal, transient state, and reading it as "not behind this proxy" would make
 * the tree flicker on every label edit. `null` means the proxy's table has not
 * been observed at all; `undefined`-shaped absence — a table that has been
 * observed and does not list this backend — comes back as `null` too, because
 * both mean "no registration state to show" and neither is a fault.
 */
export function observedRegistration(
  proxy: ServerResource,
  backendName: string,
): { registration: string; drainInitiated: boolean; online: number | null } | null {
  const status = proxy.status;
  if (status === null || status.kind !== 'VelocityProxy') return null;
  const routing = status.backends;
  if (routing === null) return null;
  const entry = routing.backends.find((backend) => backend.server === backendName);
  if (entry === undefined) return null;
  return {
    registration: entry.registration,
    drainInitiated: entry.drainInitiated,
    online: entry.players?.online ?? null,
  };
}

export interface FleetTreeRow {
  readonly server: ServerResource;
  readonly depth: 0 | 1;
  readonly attachment: Attachment;
  /**
   * This row did not match the filter and is on screen only because something
   * beneath it did. Rendered quietly, and **not counted** — otherwise "3 of 12"
   * would include rows the filter rejected.
   */
  readonly context: boolean;
  /** The proxy this row is nested under, for the depth-1 rows that have one. */
  readonly parent: ServerResource | null;
  /** Last child under its parent, so the branch can be drawn with a corner. */
  readonly last: boolean;
  /** Children suppressed because this proxy is collapsed. Always 0 at depth 1. */
  readonly collapsed: number;
}

export interface FleetTree {
  readonly rows: readonly FleetTreeRow[];
  /** Rows that actually matched — what a count should report. */
  readonly matched: number;
  /** Claimed by more than one proxy, so behind none of them. */
  readonly conflicted: readonly ServerResource[];
  /** Proxies with at least one backend, whether or not the filter kept them. */
  readonly parents: ReadonlySet<string>;
}

export interface TreeOptions {
  /** Defaults to "everything matches". */
  readonly matches?: (server: ServerResource) => boolean;
  /** Proxy names whose backends are hidden by an explicit operator action. */
  readonly collapsed?: ReadonlySet<string>;
}

/**
 * Flatten the fleet into rows to render, in reading order.
 *
 * Top-level rows stay in name order — proxies are **not** floated above
 * standalone servers. The API sorts its list by name and so does the store, and
 * a fleet where you cannot predict where a name lands is worse than one where
 * the proxies are not all at the top; nesting already makes the proxies obvious.
 *
 * A proxy whose backends match a filter is emitted even when the proxy itself
 * does not, marked `context`. The alternative — dropping it and letting its
 * backends float to the top level — would say those servers are standalone,
 * which is the one thing this view exists to get right.
 */
export function buildFleetTree(
  servers: readonly ServerResource[],
  options: TreeOptions = {},
): FleetTree {
  const matches = options.matches ?? (() => true);
  const collapsed = options.collapsed ?? new Set<string>();

  const proxies = servers.filter((server) => server.kind === 'VelocityProxy');

  const children = new Map<string, ServerResource[]>();
  const conflicted: ServerResource[] = [];
  const attachments = new Map<string, Attachment>();
  const top: ServerResource[] = [];

  for (const server of servers) {
    const attachment = attachmentOf(server, proxies);
    attachments.set(server.name, attachment);
    if (attachment.kind === 'behind') {
      const siblings = children.get(attachment.proxy);
      if (siblings === undefined) children.set(attachment.proxy, [server]);
      else siblings.push(server);
      continue;
    }
    // Standalone and conflicted alike sit at the top level: a conflicted server
    // is behind no proxy, which is precisely why its container is not created.
    if (attachment.kind === 'conflicted') conflicted.push(server);
    top.push(server);
  }

  const byName = (a: ServerResource, b: ServerResource) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  top.sort(byName);
  for (const siblings of children.values()) siblings.sort(byName);

  const rows: FleetTreeRow[] = [];
  let matched = 0;

  for (const server of top) {
    const attachment = attachments.get(server.name) ?? { kind: 'standalone' as const };
    const brood = children.get(server.name) ?? [];
    const keptChildren = brood.filter(matches);
    const hit = matches(server);

    if (!hit && keptChildren.length === 0) continue;

    const hidden = collapsed.has(server.name) ? keptChildren.length : 0;
    rows.push({
      server,
      depth: 0,
      attachment,
      context: !hit,
      parent: null,
      last: false,
      collapsed: hidden,
    });
    if (hit) matched += 1;

    if (hidden > 0) {
      // Collapsed rows still count. The filter selected them, and the row above
      // says how many are folded away, so the total is not quietly shrinking to
      // follow a disclosure triangle.
      matched += hidden;
      continue;
    }
    keptChildren.forEach((child, index) => {
      rows.push({
        server: child,
        depth: 1,
        attachment: attachments.get(child.name) ?? { kind: 'standalone' },
        context: false,
        parent: server,
        last: index === keptChildren.length - 1,
        collapsed: 0,
      });
      matched += 1;
    });
  }

  return {
    rows,
    matched,
    conflicted,
    parents: new Set(children.keys()),
  };
}
