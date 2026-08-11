'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useFleet, useNow } from '@/components/fleet-provider';
import {
  AttentionFlag,
  DrainBlockedFlag,
  GenerationGauge,
  StateBadge,
  UnreadableFlag,
} from '@/components/state-badge';
import { DrainInline } from '@/components/drain-ribbon';
import { ProxyInline, REGISTRATION } from '@/components/proxy-panels';
import { Button, Chip, Empty, LinkButton, Note, Panel, Spinner, cx } from '@/components/ui';
import { TONE_COLOR, age } from '@/lib/display';
import { filterChips } from '@/lib/filter-chips';
import { buildFleetTree, observedRegistration, type FleetTreeRow } from '@/lib/fleet-tree';
import { FALLBACK_DISPLAY_STATES, useMeta } from '@/components/meta-provider';
import type { DisplayState, ServerResource, UnreadableServer } from '@/lib/api/types';

interface Filters {
  states: Set<DisplayState>;
  labelSelector: string;
  attentionOnly: boolean;
}

export default function FleetPage() {
  const fleet = useFleet();
  const [filters, setFilters] = useState<Filters>({
    states: new Set(),
    labelSelector: '',
    attentionOnly: false,
  });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const servers = useMemo(
    () => fleet.order.map((name) => fleet.servers.get(name)).filter((s): s is ServerResource => s !== undefined),
    [fleet.order, fleet.servers],
  );

  const tree = useMemo(
    () => buildFleetTree(servers, { matches: (server) => matches(server, filters), collapsed }),
    [servers, filters, collapsed],
  );

  const toggle = (name: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(name)) next.add(name);
      return next;
    });

  const filtering = filters.states.size > 0 || filters.labelSelector.length > 0 || filters.attentionOnly;

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="mono text-[20px] font-semibold tracking-tight">fleet</h1>
          <p className="text-[13px]" style={{ color: 'var(--text-dim)' }}>
            Everything declared on this orchestrator, and what the reconcile loop has observed of it.
          </p>
        </div>
        <LinkButton href="/servers/new" variant="primary">
          New server
        </LinkButton>
      </header>

      {fleet.removalsSuspended && (
        <Note tone="work" title="removals are paused">
          One of the unreadable rows below has no name at all, so the event stream has stopped
          reporting removals — for every server, not just that one. A record with no name cannot be
          matched against anything, and deriving a deletion anyway could report a running server as
          gone. Until it is repaired, a genuinely purged server may linger in this table.
        </Note>
      )}

      {fleet.unreadable.length > 0 && <UnreadablePanel rows={fleet.unreadable} />}

      {tree.conflicted.length > 0 && <ConflictedNote servers={tree.conflicted} />}

      <FilterBar filters={filters} onChange={setFilters} servers={servers} />

      <Panel>
        {!fleet.primed ? (
          <Spinner label="waiting for the first snapshot" />
        ) : tree.rows.length === 0 ? (
          <EmptyState filtering={filtering} onClear={() => setFilters({ states: new Set(), labelSelector: '', attentionOnly: false })} />
        ) : (
          <FleetTable rows={tree.rows} onToggle={toggle} collapsed={collapsed} />
        )}
      </Panel>

      {fleet.primed && tree.rows.length > 0 && (
        <p className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
          {tree.matched === servers.length
            ? `${servers.length} server${servers.length === 1 ? '' : 's'}`
            : `${tree.matched} of ${servers.length} servers`}
          . Sorted by name, the way the API sorts its list, with each proxy&apos;s backends nested
          beneath it.
        </p>
      )}
    </>
  );
}

/**
 * Servers more than one proxy claims.
 *
 * Not a cosmetic ambiguity in this view — it is a state the reconcile loop
 * refuses to act on. `ProxyFleet.resolve` returns `Conflicted` when two
 * selectors match, and the server is then neither created nor recreated until
 * one of them stops matching, because a backend belongs to one proxy: two would
 * route players to it and a drain would tell only one of them to stop. So these
 * rows are nested under neither, and the reason is said out loud rather than
 * left to be inferred from a server that quietly never starts.
 */
function ConflictedNote({ servers }: { servers: readonly ServerResource[] }) {
  return (
    <Note
      tone="fault"
      title={`${servers.length} server${servers.length === 1 ? ' is' : 's are'} claimed by more than one proxy`}
    >
      <p>
        {servers.map((server, index) => (
          <span key={server.name}>
            {index > 0 && ', '}
            <span className="mono">{server.name}</span>
          </span>
        ))}{' '}
        {servers.length === 1 ? 'carries' : 'carry'} every label in the backend selector of two or
        more proxies. A backend belongs to one proxy — both would route players to it, and a drain
        would tell only one of them to stop — so the reconcile loop will not create or recreate{' '}
        {servers.length === 1 ? 'it' : 'them'} until one of those selectors stops matching. Deleting
        is still allowed and still drains.
      </p>
      <p className="mt-1.5">
        Wherever {servers.length === 1 ? 'it appears' : 'they appear'} below,{' '}
        {servers.length === 1 ? 'it sits' : 'they sit'} at the top level behind no proxy, because
        that is where the orchestrator has left {servers.length === 1 ? 'it' : 'them'}. This note
        covers the whole fleet: a filter can hide the row, and hiding it does not resolve the
        condition.
      </p>
    </Note>
  );
}

/**
 * Rows the store has a name for and nothing else (§6).
 *
 * These sit above the fleet table rather than inside it, which is what keeps
 * them out of `items` without hiding them: a row with no readable definition
 * cannot answer "is it READY", "does it carry this label" or "is it
 * terminating", so any filter would drop it — and dropping it is exactly the
 * mistake, because absence is how a purge is reported.
 */
function UnreadablePanel({ rows }: { rows: readonly UnreadableServer[] }) {
  return (
    <Panel
      title={`${rows.length} unreadable ${rows.length === 1 ? 'row' : 'rows'}`}
      hint="declared, and the stored definition will not decode — never filtered"
    >
      <ul>
        {rows.map((row, index) => (
          // Keyed by index, not by name: two nameless rows are indistinguishable
          // to this API, so `name` is not a key.
          <li key={`${row.name ?? 'nameless'}-${index}`} className="border-b last:border-b-0 px-4 py-3">
            <div className="flex items-baseline gap-3 flex-wrap">
              {row.name === null ? (
                <span className="mono text-[13px]" style={{ color: 'var(--fault)' }}>
                  (no name)
                </span>
              ) : (
                <span className="mono text-[13px] font-medium">{row.name}</span>
              )}
              <UnreadableFlag />
              <span className="mono text-[10px]" style={{ color: 'var(--text-faint)' }}>
                {row.part.toLowerCase()} state{row.retryable ? ' · retryable' : ''}
              </span>
            </div>
            <p className="text-[12px] mt-1" style={{ color: 'var(--text-dim)' }}>
              {row.reason}
            </p>
            {row.name === null ? (
              // Every repair path this API has names a server, so there is no
              // button that could work. Saying so beats showing one that cannot.
              <p className="text-[12px] mt-1" style={{ color: 'var(--fault)' }}>
                This record has no name, so it cannot be fetched, repaired or deleted through the
                API at all. It has to be fixed in the store.
              </p>
            ) : (
              <p className="text-[12px] mt-1" style={{ color: 'var(--text-faint)' }}>
                The container may well still be running. Repair the stored definition — the
                reconcile loop reads the same bytes on every pass and cannot move this on its own.
              </p>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function matches(server: ServerResource, filters: Filters): boolean {
  if (filters.states.size > 0 && !filters.states.has(server.display.state)) return false;
  if (filters.attentionOnly && !server.display.needsAttention) return false;
  if (filters.labelSelector.length > 0) {
    // The same `tier=survival,region=eu-west` form the API accepts (§6): an
    // AND of equalities. Applied here rather than as a query parameter because
    // the event stream is unfiltered — filtering client-side keeps the filter
    // live instead of freezing it to one list response.
    const labels = server.definition.metadata.labels ?? {};
    for (const term of filters.labelSelector.split(',')) {
      const trimmed = term.trim();
      if (trimmed.length === 0) continue;
      const equals = trimmed.indexOf('=');
      if (equals === -1) return false;
      if (labels[trimmed.slice(0, equals).trim()] !== trimmed.slice(equals + 1).trim()) return false;
    }
  }
  return true;
}

function FilterBar({
  filters,
  onChange,
  servers,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  servers: readonly ServerResource[];
}) {
  const meta = useMeta();
  // §10 serves the badge vocabulary so a new one reaches these filters with no
  // frontend release. The fallback only covers the moment before /meta lands.
  const known: readonly DisplayState[] = meta?.enums.displayState ?? FALLBACK_DISPLAY_STATES;

  const present = useMemo(() => {
    const counts = new Map<DisplayState, number>();
    for (const server of servers) {
      counts.set(server.display.state, (counts.get(server.display.state) ?? 0) + 1);
    }
    return counts;
  }, [servers]);

  const states = filterChips(known, present);
  const attention = servers.filter((server) => server.display.needsAttention).length;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
      {states.map((state) => {
        const on = filters.states.has(state);
        return (
          <button
            key={state}
            type="button"
            aria-pressed={on}
            onClick={() => {
              const states = new Set(filters.states);
              if (on) states.delete(state);
              else states.add(state);
              onChange({ ...filters, states });
            }}
            className={cx('px-2 h-7 border rounded-sm cursor-pointer transition-colors')}
            style={{ background: on ? 'var(--bg-raised)' : 'transparent', borderColor: on ? 'var(--line-strong)' : 'var(--line)' }}
          >
            <StateBadge state={state} />
            <span className="mono text-[11px] ml-1.5" style={{ color: 'var(--text-faint)' }}>
              {present.get(state)}
            </span>
          </button>
        );
      })}

      {attention > 0 && (
        <button
          type="button"
          aria-pressed={filters.attentionOnly}
          onClick={() => onChange({ ...filters, attentionOnly: !filters.attentionOnly })}
          className="px-2 h-7 border rounded-sm cursor-pointer"
          style={{
            background: filters.attentionOnly ? 'var(--bg-raised)' : 'transparent',
            borderColor: filters.attentionOnly ? 'var(--fault)' : 'var(--line)',
          }}
        >
          <AttentionFlag />
        </button>
      )}

      <input
        value={filters.labelSelector}
        onChange={(event) => onChange({ ...filters, labelSelector: event.target.value })}
        placeholder="tier=survival,region=eu-west"
        aria-label="label selector"
        className="mono text-[12px] px-2 h-7 border rounded-sm ml-auto w-full sm:w-64"
        style={{ background: 'var(--bg-raised)' }}
      />
    </div>
  );
}

/**
 * The fleet, as a tree.
 *
 * Still one table: the columns are the same questions about every row, and
 * splitting proxies into their own cards would mean reading two scales to
 * compare two servers. The nesting is carried in the name cell instead — an
 * indent and a branch glyph — so a backend sits under the proxy that routes to
 * it without giving up the row it had.
 */
function FleetTable({
  rows,
  onToggle,
  collapsed,
}: {
  rows: readonly FleetTreeRow[];
  onToggle: (name: string) => void;
  collapsed: ReadonlySet<string>;
}) {
  const now = useNow();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="border-b">
            <th className="label font-medium px-4 py-2">name</th>
            <th className="label font-medium px-4 py-2">state</th>
            <th className="label font-medium px-4 py-2 text-right">players</th>
            <th className="label font-medium px-4 py-2">reconcile</th>
            <th className="label font-medium px-4 py-2">detail</th>
            <th className="label font-medium px-4 py-2 text-right">age</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const server = row.server;
            const isProxy = server.kind === 'VelocityProxy';
            const folded = collapsed.has(server.name);
            // One gutter width per depth, so every name at a level starts in the
            // same place whether or not it has a glyph in front of it. A proxy
            // with no disclosure arrow must not sit half a character left of one
            // that has one — the indent is the only thing carrying the nesting,
            // so it has to be the only thing that varies.
            const gutter = row.depth === 1 ? '1.5rem' : '0.875rem';
            const indent = row.depth === 1 ? '2rem' : '1rem';
            const align = `calc(${gutter} + 0.375rem)`;
            return (
            <tr
              key={server.name}
              className="border-b last:border-b-0 hover:bg-[color:var(--bg-sunken)] transition-colors"
              // A context row is on screen only because a backend under it
              // matched. Dimming it says "this is not one of your results"
              // without pretending the backend is standalone.
              style={row.context ? { opacity: 0.6 } : undefined}
            >
              <td className="py-2.5 pr-4" style={{ paddingLeft: indent }}>
                <div className="flex items-baseline gap-1.5">
                  <span
                    className="shrink-0 inline-flex justify-start"
                    style={{ width: gutter }}
                  >
                    {row.depth === 1 ? (
                      <span
                        aria-hidden
                        className="mono text-[13px] select-none"
                        style={{ color: 'var(--line-strong)' }}
                      >
                        {row.last ? '└─' : '├─'}
                      </span>
                    ) : (
                      // Offered whenever the proxy has backends at all, not
                      // only when some are on screen: a collapsed proxy whose
                      // backends the filter rejected still has to be openable,
                      // or the filter has taken away the way back to them.
                      row.backends > 0 && (
                        <button
                          type="button"
                          onClick={() => onToggle(server.name)}
                          aria-expanded={!folded}
                          aria-label={`${folded ? 'show' : 'hide'} the backends of ${server.name}`}
                          className="mono text-[10px] cursor-pointer"
                          style={{ color: 'var(--text-faint)' }}
                        >
                          {folded ? '▸' : '▾'}
                        </button>
                      )
                    )}
                  </span>
                  <Link href={`/servers/${encodeURIComponent(server.name)}`} className="mono text-[13px] font-medium">
                    {server.name}
                  </Link>
                  {row.parent !== null && (
                    // The glyph and the indent are decoration; this is the
                    // relationship, for anything not reading them.
                    <span className="sr-only">— backend of {row.parent.name}</span>
                  )}
                </div>
                <div
                  className="mono text-[10px] mt-0.5"
                  style={{ color: 'var(--text-faint)', paddingLeft: align }}
                >
                  {isProxy ? 'proxy' : 'server'}
                  {Object.keys(server.definition.metadata.labels ?? {}).length > 0 &&
                    ` · ${Object.entries(server.definition.metadata.labels ?? {})
                      .map(([key, value]) => `${key}=${value}`)
                      .join(' ')}`}
                </div>
                {row.parent !== null && (
                  <div className="mt-0.5" style={{ paddingLeft: align }}>
                    <BackendRouting parent={row.parent} name={server.name} />
                  </div>
                )}
                {row.attachment.kind === 'conflicted' && (
                  <div className="mt-1" style={{ paddingLeft: align }}>
                    <Chip
                      tone="fault"
                      title={
                        'A backend belongs to one proxy. While two claim it, the reconcile loop ' +
                        'will not create or recreate its container.'
                      }
                    >
                      claimed by {row.attachment.proxies.join(' + ')}
                    </Chip>
                  </div>
                )}
                {row.collapsed > 0 && (
                  <button
                    type="button"
                    onClick={() => onToggle(server.name)}
                    className="mono text-[10px] mt-1 cursor-pointer block"
                    style={{ color: 'var(--work)', paddingLeft: align }}
                  >
                    {row.collapsed} backend{row.collapsed === 1 ? '' : 's'} folded away — show
                  </button>
                )}
              </td>
              <td className="px-4 py-2.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <StateBadge state={server.display.state} />
                  {/*
                    Flags, not states (§7). They are rendered beside the badge
                    because `TERMINATING` outranks all three, so the badge alone
                    cannot say a row is also unreadable or waiting.

                    `drainBlocked` is shown only when `needsAttention` is not —
                    the two can both be true, and then the one with an action
                    attached wins.
                  */}
                  {server.display.needsAttention && <AttentionFlag />}
                  {server.display.unreadable && <UnreadableFlag />}
                  {server.display.drainBlocked && !server.display.needsAttention && (
                    <DrainBlockedFlag />
                  )}
                </div>
                {server.display.drainState !== null && (
                  <div className="mt-0.5">
                    <DrainInline server={server} />
                  </div>
                )}
                {server.display.proxy !== null && (
                  <div className="mt-0.5">
                    <ProxyInline proxy={server.display.proxy} />
                  </div>
                )}
              </td>
              <td className="px-4 py-2.5 text-right mono text-[13px] whitespace-nowrap">
                {server.display.playersOnline === null ? (
                  <Empty>— / {server.display.playersMax ?? '—'}</Empty>
                ) : (
                  <>
                    <span
                      style={{
                        color: server.display.playersOnline > 0 ? 'var(--text)' : 'var(--text-faint)',
                      }}
                    >
                      {server.display.playersOnline}
                    </span>
                    <span style={{ color: 'var(--text-faint)' }}> / {server.display.playersMax ?? '—'}</span>
                  </>
                )}
              </td>
              <td className="px-4 py-2.5">
                <GenerationGauge server={server} />
              </td>
              <td
                className="px-4 py-2.5 text-[12px] max-w-[26rem]"
                style={{ color: 'var(--text-dim)' }}
              >
                {server.display.detail.length > 0 ? server.display.detail : <Empty>—</Empty>}
              </td>
              <td className="px-4 py-2.5 text-right mono text-[12px]" style={{ color: 'var(--text-faint)' }}>
                {age(server.metadata.createdAt, now)}
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * How the proxy above this row is currently routing to it.
 *
 * The tree is drawn from the declared selector, which is what the reconcile
 * loop resolves parentage from — but that says nothing about whether players
 * can actually reach the server right now. This is the observed half, read from
 * the parent's own routing table: `REGISTERED` → `SEALED` → `DEREGISTERED` is a
 * drain moving, and seeing it against the branch it belongs to is most of why
 * this view is a tree.
 *
 * Silent when there is nothing observed. A selector that matches before the
 * table has caught up is ordinary, and painting it as a problem would light up
 * every label edit.
 */
function BackendRouting({ parent, name }: { parent: ServerResource; name: string }) {
  const routing = observedRegistration(parent, name);
  if (routing === null) return null;
  // The same vocabulary the proxy's own backends panel uses, from the same
  // table. Two places painting `SEALED` differently is the sort of drift that
  // makes an operator distrust both.
  const facts = REGISTRATION[routing.registration] ?? {
    tone: 'neutral' as const,
    meaning: 'a registration state this dashboard does not know about',
  };
  return (
    <span
      className="mono text-[10px] inline-flex gap-1.5"
      style={{ color: TONE_COLOR[facts.tone] }}
      title={facts.meaning}
    >
      <span>{routing.registration.toLowerCase()}</span>
      {routing.drainInitiated && <span style={{ color: 'var(--work)' }}>draining</span>}
    </span>
  );
}

function EmptyState({ filtering, onClear }: { filtering: boolean; onClear: () => void }) {
  if (filtering) {
    return (
      <div className="px-4 py-12 text-center">
        <p className="text-[13px]" style={{ color: 'var(--text-dim)' }}>
          No server matches these filters.
        </p>
        <Button onClick={onClear} className="mt-3">
          Clear filters
        </Button>
      </div>
    );
  }
  return (
    <div className="px-4 py-12 text-center">
      <p className="mono text-[13px]">Nothing is declared yet.</p>
      <p className="text-[13px] mt-1 mb-4" style={{ color: 'var(--text-dim)' }}>
        Declare a server and the reconcile loop pulls its image and starts it.
      </p>
      <LinkButton href="/servers/new" variant="primary">
        New server
      </LinkButton>
    </div>
  );
}
