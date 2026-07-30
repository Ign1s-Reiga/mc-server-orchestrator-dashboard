'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useFleet, useNow } from '@/components/fleet-provider';
import { AttentionFlag, GenerationGauge, StateBadge } from '@/components/state-badge';
import { DrainInline } from '@/components/drain-ribbon';
import { Button, Empty, LinkButton, Panel, Spinner, cx } from '@/components/ui';
import { age } from '@/lib/display';
import { FALLBACK_DISPLAY_STATES, useMeta } from '@/components/meta-provider';
import type { DisplayState, ServerResource } from '@/lib/api/types';

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

  // Anything observed but not in the served list still gets a chip, so a badge
  // this build has never heard of is filterable rather than invisible.
  const states = [...known, ...[...present.keys()].filter((state) => !known.includes(state))];

  const attention = servers.filter((server) => server.display.needsAttention).length;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
      {states.filter((state) => present.has(state)).map((state) => {
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
                {Object.keys(server.definition.metadata.labels ?? {}).length > 0 && (
                  <div className="mono text-[10px] mt-0.5" style={{ color: 'var(--text-faint)' }}>
                    {Object.entries(server.definition.metadata.labels ?? {})
                      .map(([key, value]) => `${key}=${value}`)
                      .join(' ')}
                  </div>
                )}
              </td>
              <td className="px-4 py-2.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <StateBadge state={server.display.state} />
                  {server.display.needsAttention && <AttentionFlag />}
                </div>
                {server.display.drainState !== null && (
                  <div className="mt-0.5">
                    <DrainInline server={server} />
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
