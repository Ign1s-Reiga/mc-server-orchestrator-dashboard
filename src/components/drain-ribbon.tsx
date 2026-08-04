'use client';

import type { DrainStatus, ServerResource } from '@/lib/api/types';
import { DRAIN_SEQUENCE, DRAIN_STEP_MEANING, absolute, age, drainStepIndex, relative } from '@/lib/display';
import { useNow } from './fleet-provider';
import { Note, cx } from './ui';

/** Short labels for the track. The full meaning is in the `title`. */
const STEP_LABEL: Record<string, string> = {
  DRAIN_REQUESTED: 'REQ',
  SEALED: 'SEAL',
  TARGET_RESOLVED: 'TARGET',
  TRANSFERRING: 'TRANSFER',
  SAVING: 'SAVE',
  DEREGISTERED: 'DEREG',
  STOPPING: 'STOP',
};

/**
 * The drain protocol, rendered as the ordered track it actually is.
 *
 * This is the one place in the dashboard that gets a bold treatment, because
 * it is the one place where the ordering is the safety property: players are
 * evacuated, then the save is *confirmed*, and only then is anything stopped.
 * An operator watching this needs to see which of those has actually happened,
 * not a spinner.
 */
export function DrainRibbon({ server }: { server: ServerResource }) {
  const now = useNow();
  const drain = server.status?.drain ?? null;

  // A delete is recorded the moment the API answers 202, but the reconcile
  // loop starts the drain on its own cadence. That gap is real and the UI has
  // to name it rather than showing an empty track that looks stuck.
  if (drain === null) {
    if (!server.metadata.terminating) return null;
    return (
      <Note tone="work" title="delete recorded — the drain has not started yet">
        The API accepted the delete{' '}
        {server.metadata.deletedAt !== null && `${relative(server.metadata.deletedAt, now)} `}
        and is holding the name. The reconcile loop starts the drain on its next pass; nothing has
        been stopped and players are still connected.
      </Note>
    );
  }

  /*
   * §7/§14: `DRAIN_FAILED` means *parked*, not *broken* — a drain that is not
   * advancing reports it whether it is stuck or merely waiting. `blocked` and
   * `failure` are what tell those apart, and they are disjoint:
   *
   *   progressing        blocked null   failure null
   *   blocked, healthy   blocked set    failure null
   *   failed             blocked null   failure set
   *
   * Painting a waiting drain as a failure was this component's own bug. A
   * blocked drain records no failure precisely so a server with people happily
   * playing on it does not light up every "is anything wrong" panel.
   */
  const aborted = drain.failure !== null;
  const blocked = !aborted && drain.blocked !== null;
  const currentIndex = drain.state === 'DRAIN_FAILED' ? -1 : drainStepIndex(drain.state);
  const accent = aborted ? 'var(--fault)' : 'var(--work)';

  return (
    <div
      className="border rounded-sm overflow-hidden"
      style={{
        background: 'var(--bg-raised)',
        borderColor: aborted ? 'var(--fault)' : 'var(--line)',
      }}
    >
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-2.5 border-b">
        <h2 className="label" style={{ color: accent }}>
          {aborted ? 'drain failed' : blocked ? 'drain waiting' : 'draining'}
        </h2>
        <span className="mono text-[13px] font-medium" style={{ color: accent }}>
          {drain.state}
        </span>
        <p className="text-[13px] flex-1" style={{ color: 'var(--text-dim)' }}>
          {blocked && drain.blocked !== null
            ? drain.blocked.message
            : DRAIN_STEP_MEANING[drain.state]}
        </p>
        <span className="mono text-[11px]" style={{ color: 'var(--text-faint)' }}>
          started {age(drain.startedAt, now)} ago · in this step {age(drain.enteredStateAt, now)}
        </span>
      </header>

      <div className="px-4 pt-4 pb-3">
        <Track currentIndex={currentIndex} failed={aborted} />
        <Latches drain={drain} now={now} />
      </div>

      {blocked && drain.blocked !== null && (
        <div className="px-4 pb-4">
          <Note tone="work" title="waiting, not stuck — there is nothing to do">
            <p>
              The drain has stopped advancing because players are still connected and there is no
              proxy to move them through, so the protocol waits rather than disconnecting anybody.
              The container keeps running and the server stays joinable.
            </p>
            <p className="mono text-[11px] mt-2" style={{ color: 'var(--text-faint)' }}>
              {drain.blocked.reason} · blocked for {age(drain.blocked.since, now)} ·{' '}
              {drain.blocked.observations} pass
              {drain.blocked.observations === 1 ? '' : 'es'} found it still true
            </p>
            <p className="text-[12px] mt-1.5">
              The pass count is what says the loop is still watching rather than wedged. A pass that
              fails leaves the block untouched and records on the server&apos;s failure instead — so
              read that alongside this rather than taking a block as permission to ignore the row.
            </p>
          </Note>
        </div>
      )}

      {aborted && (
        <div className="px-4 pb-4">
          <Note tone="fault" title="the server is still running">
            The drain aborted part-way. There is no path from here to a stop and no endpoint that
            could force one — that is the point of the drain protocol. Whatever stopped it has to be
            resolved on the host, and the players on this server are still connected.
          </Note>
        </div>
      )}

      {drain.failure !== null && (
        <dl className="grid sm:grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-4 pb-4 text-[13px]">
          <dt className="label pt-0.5">reason</dt>
          <dd className="mono" style={{ color: 'var(--fault)' }}>
            {drain.failure.reason}{' '}
            <span style={{ color: 'var(--text-faint)' }}>({drain.failure.failureClass})</span>
          </dd>
          <dt className="label pt-0.5">detail</dt>
          <dd style={{ color: 'var(--text-dim)' }}>{drain.failure.message}</dd>
          <dt className="label pt-0.5">since</dt>
          <dd className="mono" style={{ color: 'var(--text-dim)' }}>
            {absolute(drain.failure.occurredAt)} · {drain.failure.attempts} attempts
          </dd>
        </dl>
      )}
    </div>
  );
}

function Track({ currentIndex, failed }: { currentIndex: number; failed: boolean }) {
  return (
    <ol className="flex gap-[3px]" aria-label="drain progress">
      {DRAIN_SEQUENCE.map((step, index) => {
        const passed = currentIndex > index;
        const active = currentIndex === index;
        return (
          <li key={step} className="flex-1 flex flex-col gap-1.5" title={DRAIN_STEP_MEANING[step]}>
            <div
              className={cx('h-[6px] rounded-[1px]', active && !failed && 'ribbon-active')}
              style={{
                background: active && !failed
                  ? undefined
                  : passed
                    ? 'var(--work)'
                    : failed
                      ? 'var(--bg-sunken)'
                      : 'var(--bg-sunken)',
                // A failed drain leaves the track visibly broken rather than
                // simply unfilled: it did not stop cleanly, it came apart.
                opacity: failed && !passed ? 0.35 : 1,
                outline: failed && passed ? '1px solid var(--fault)' : undefined,
              }}
              aria-current={active ? 'step' : undefined}
            />
            <span
              className="label text-[9px] leading-none"
              style={{
                color: active ? 'var(--work)' : passed ? 'var(--text-dim)' : 'var(--text-faint)',
              }}
            >
              {STEP_LABEL[step] ?? step}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The two facts that make a stop safe.
 *
 * Everything else on the track is progress; these two are the irreversible
 * latches the whole protocol exists to close. `worldSaved` is shown as
 * confirmed only when `worldSavedAt` is set — a save that was *requested* and
 * never confirmed is the dangerous middle state, and API.md keeps the two
 * timestamps disjoint precisely so a client cannot conflate them.
 */
function Latches({ drain, now }: { drain: DrainStatus; now: number }) {
  return (
    <div className="grid sm:grid-cols-2 gap-2 mt-4">
      <Latch
        closed={drain.playersEvacuated}
        label="players evacuated"
        detail={
          drain.playersEvacuated
            ? drain.destination !== null
              ? `moved to ${drain.destination}`
              : 'no players left on the server'
            : `${drain.transferAttempts} transfer ${drain.transferAttempts === 1 ? 'attempt' : 'attempts'}${
                drain.destination !== null ? ` → ${drain.destination}` : ''
              }`
        }
      />
      <Latch
        closed={drain.worldSaved}
        label="world save confirmed"
        detail={
          drain.worldSavedAt !== null
            ? `confirmed ${age(drain.worldSavedAt, now)} ago`
            : drain.saveRequestedAt !== null
              ? `requested ${age(drain.saveRequestedAt, now)} ago — not confirmed`
              : 'not requested yet'
        }
        warn={drain.saveRequestedAt !== null && !drain.worldSaved}
      />
    </div>
  );
}

function Latch({
  closed,
  label,
  detail,
  warn = false,
}: {
  closed: boolean;
  label: string;
  detail: string;
  warn?: boolean;
}) {
  const color = closed ? 'var(--ok)' : warn ? 'var(--work)' : 'var(--text-faint)';
  return (
    <div
      className="flex items-start gap-2.5 px-3 py-2 border rounded-sm"
      style={{ borderColor: color, background: 'var(--bg-sunken)' }}
    >
      <span aria-hidden className="mono text-[13px] leading-5" style={{ color }}>
        {closed ? '■' : '□'}
      </span>
      <div>
        <div className="mono text-[12px]" style={{ color }}>
          {label}
        </div>
        <div className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
          {detail}
        </div>
      </div>
    </div>
  );
}

/**
 * The one-line version for a table row: which step, and how long it has been
 * sitting there. The elapsed time is what tells an operator a drain is stuck.
 */
export function DrainInline({ server }: { server: ServerResource }) {
  const now = useNow();
  const drain = server.status?.drain ?? null;
  if (drain === null) return null;

  // A parked drain and a broken one both report `DRAIN_FAILED`, so the state
  // alone cannot answer the only question an operator has about the row. The
  // elapsed time comes from `blocked.since` when there is one, because that is
  // when the block was first recorded rather than when the loop last looked.
  const aborted = drain.failure !== null;
  const blocked = !aborted && drain.blocked !== null;
  const since = blocked && drain.blocked !== null ? drain.blocked.since : drain.enteredStateAt;

  return (
    <span
      className="mono text-[11px] whitespace-nowrap"
      style={{ color: aborted ? 'var(--fault)' : 'var(--work)' }}
      title={
        blocked && drain.blocked !== null
          ? drain.blocked.message
          : DRAIN_STEP_MEANING[drain.state]
      }
    >
      {blocked && drain.blocked !== null ? drain.blocked.reason : drain.state}{' '}
      {age(since, now)}
    </span>
  );
}
