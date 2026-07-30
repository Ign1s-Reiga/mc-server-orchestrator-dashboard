'use client';

import { useFleet, useFleetActions, useNow } from './fleet-provider';
import { age, millis } from '@/lib/display';
import { Button, Dot, Note, cx } from './ui';
import type { ConnectionState } from '@/lib/stream/store';

/**
 * How the dashboard talks about its own freshness.
 *
 * The rule everywhere below: never claim live unless frames are actually
 * arriving, and when they are not, say how old the data on screen is. A
 * dashboard quietly showing minutes-old state is worse than one admitting it
 * lost contact.
 */
interface Readout {
  label: string;
  tone: 'ok' | 'work' | 'fault' | 'quiet';
  pulse: boolean;
}

function readout(connection: ConnectionState): Readout {
  switch (connection) {
    case 'live':
      return { label: 'LIVE', tone: 'ok', pulse: true };
    case 'connecting':
      return { label: 'CONNECTING', tone: 'work', pulse: true };
    case 'silent':
      return { label: 'NO SIGNAL', tone: 'fault', pulse: false };
    case 'reconnecting':
      return { label: 'RECONNECTING', tone: 'fault', pulse: true };
    case 'limited':
      return { label: 'STREAM LIMIT', tone: 'fault', pulse: false };
    case 'unauthenticated':
      return { label: 'SIGNED OUT', tone: 'fault', pulse: false };
    case 'stopped':
      return { label: 'STOPPED', tone: 'quiet', pulse: false };
    default:
      return { label: 'IDLE', tone: 'quiet', pulse: false };
  }
}

/** The compact indicator that lives in the sidebar, always visible. */
export function ConnectionPill() {
  const fleet = useFleet();
  const now = useNow();
  const { label, tone, pulse } = readout(fleet.connection);
  const stale = fleet.connection !== 'live' && fleet.lastDataAt !== null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Dot tone={tone} pulse={pulse} />
        <span className="mono text-[11px] tracking-wide">{label}</span>
      </div>
      <span className="mono text-[10px] pl-[15px]" style={{ color: 'var(--text-faint)' }}>
        {stale
          ? `state from ${age(new Date(fleet.lastDataAt ?? now).toISOString(), now)} ago`
          : fleet.hello !== null
            ? `status every ${millis(fleet.hello.statusPollMillis)}`
            : 'no stream yet'}
      </span>
    </div>
  );
}

/**
 * The banner. Appears only when there is something the operator has to know:
 * contact was lost, history was missed, or every stream slot is taken.
 */
export function ConnectionBanner() {
  const fleet = useFleet();
  const { reconnectNow, resyncNow } = useFleetActions();
  const now = useNow();

  if (fleet.connection === 'limited') {
    return (
      <Note
        tone="fault"
        title="every event stream slot is in use"
        actions={<Button onClick={reconnectNow}>Try now</Button>}
      >
        The API allows a fixed number of concurrent streams. Another dashboard tab or a script is
        holding them. Nothing on this screen is updating until one is released
        {fleet.retryAt !== null && ` — retrying in ${Math.max(0, Math.ceil((fleet.retryAt - now) / 1000))}s`}.
      </Note>
    );
  }

  if (fleet.connection === 'reconnecting' || fleet.connection === 'silent') {
    const since = fleet.lastDataAt !== null ? age(new Date(fleet.lastDataAt).toISOString(), now) : null;
    return (
      <Note
        tone="fault"
        title="live updates stopped"
        actions={<Button onClick={reconnectNow}>Reconnect now</Button>}
      >
        {since !== null
          ? `Everything below is the state as of ${since} ago and is not being refreshed.`
          : 'No state has been received yet.'}{' '}
        {fleet.connection === 'silent'
          ? 'The connection was open but the API stopped sending keep-alives.'
          : fleet.lastError ?? 'The connection dropped.'}
        {fleet.retryAt !== null &&
          ` Retrying in ${Math.max(0, Math.ceil((fleet.retryAt - now) / 1000))}s (attempt ${fleet.attempt}).`}
      </Note>
    );
  }

  // §8: the change log is bounded, so a tab left open long enough can be told
  // only what is true now, not what it missed. The set converges — but saying
  // nothing would imply this dashboard saw every transition, and it did not.
  if (fleet.historyGap !== null) {
    return (
      <Note
        tone="work"
        title="some changes were never delivered"
        actions={<Button onClick={resyncNow}>Re-read everything</Button>}
      >
        This tab was connected for longer than the API keeps its change log, so intermediate states
        between {age(new Date(fleet.historyGap.at).toISOString(), now)} ago and now were dropped.
        Current state below is complete and correct; the history between is gone.
      </Note>
    );
  }

  return null;
}

/**
 * A freshness marker for a single screen — used on the detail page, where the
 * operator is watching one server closely and needs to know whether what they
 * are watching is moving.
 */
export function FreshnessLine({ className }: { className?: string }) {
  const fleet = useFleet();
  const now = useNow();
  const live = fleet.connection === 'live';
  const { tone, pulse } = readout(fleet.connection);

  return (
    <span
      className={cx('mono text-[11px] inline-flex items-center gap-2', className)}
      style={{ color: 'var(--text-faint)' }}
    >
      <Dot tone={tone} pulse={pulse} />
      {live
        ? fleet.lastDataAt !== null
          ? `updated ${age(new Date(fleet.lastDataAt).toISOString(), now)} ago`
          : 'connected'
        : fleet.lastDataAt !== null
          ? `stale — from ${age(new Date(fleet.lastDataAt).toISOString(), now)} ago`
          : 'no data'}
    </span>
  );
}
