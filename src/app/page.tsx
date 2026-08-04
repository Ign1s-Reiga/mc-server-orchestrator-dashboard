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
import { ProxyInline } from '@/components/proxy-panels';
import { Button, Empty, LinkButton, Note, Panel, Spinner, cx } from '@/components/ui';
import { age } from '@/lib/display';
import { filterChips } from '@/lib/filter-chips';
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

  const servers = useMemo(
    () => fleet.order.map((name) => fleet.servers.get(name)).filter((s): s is ServerResource => s !== undefined),
    [fleet.order, fleet.servers],
  );

  const visible = useMemo(() => servers.filter((server) => matches(server, filters)), [servers, filters]);

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

      <FilterBar filters={filters} onChange={setFilters} servers={servers} />

      <Panel>
        {!fleet.primed ? (
          <Spinner label="waiting for the first snapshot" />
        ) : visible.length === 0 ? (
          <EmptyState filtering={filtering} onClear={() => setFilters({ states: new Set(), labelSelector: '', attentionOnly: false })} />
        ) : (
          <FleetTable servers={visible} />
        )}
      </Panel>

      {fleet.primed && visible.length > 0 && (
        <p className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
          {visible.length === servers.length
            ? `${servers.length} server${servers.length === 1 ? '' : 's'}`
            : `${visible.length} of ${servers.length} servers`}
          . Sorted by name, the way the API sorts its list.
        </p>
      )}
    </>
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

function FleetTable({ servers }: { servers: readonly ServerResource[] }) {
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
          {servers.map((server) => (
            <tr
              key={server.name}
              className="border-b last:border-b-0 hover:bg-[color:var(--bg-sunken)] transition-colors"
            >
              <td className="px-4 py-2.5">
                <Link href={`/servers/${encodeURIComponent(server.name)}`} className="mono text-[13px] font-medium">
                  {server.name}
                </Link>
                <div className="mono text-[10px] mt-0.5" style={{ color: 'var(--text-faint)' }}>
                  {server.kind === 'VelocityProxy' ? 'proxy' : 'server'}
                  {Object.keys(server.definition.metadata.labels ?? {}).length > 0 &&
                    ` · ${Object.entries(server.definition.metadata.labels ?? {})
                      .map(([key, value]) => `${key}=${value}`)
                      .join(' ')}`}
                </div>
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
          ))}
        </tbody>
      </table>
    </div>
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
