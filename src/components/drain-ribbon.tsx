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

  const failed = drain.state === 'DRAIN_FAILED';
  const currentIndex = failed ? -1 : drainStepIndex(drain.state);

  return (
    <div
      className="border rounded-sm overflow-hidden"
      style={{ background: 'var(--bg-raised)', borderColor: failed ? 'var(--fault)' : 'var(--line)' }}
    >
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-2.5 border-b">
        <h2 className="label" style={{ color: failed ? 'var(--fault)' : 'var(--work)' }}>
          {failed ? 'drain failed' : 'draining'}
        </h2>
        <span className="mono text-[13px] font-medium" style={{ color: failed ? 'var(--fault)' : 'var(--work)' }}>
          {drain.state}
        </span>
        <p className="text-[13px] flex-1" style={{ color: 'var(--text-dim)' }}>
          {DRAIN_STEP_MEANING[drain.state]}
        </p>
        <span className="mono text-[11px]" style={{ color: 'var(--text-faint)' }}>
          started {age(drain.startedAt, now)} ago · in this step {age(drain.enteredStateAt, now)}
        </span>
      </header>

      <div className="px-4 pt-4 pb-3">
        <Track currentIndex={currentIndex} failed={failed} />
        <Latches drain={drain} now={now} />
      </div>

      {failed && (
        <div className="px-4 pb-4">
          <Note tone="fault" title="the server is still running">
            The drain aborted part-way. There is no path from here to a stop and no endpoint that
            could force one — that is the point of the drain protocol. Whatever blocked it has to be
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
  const failed = drain.state === 'DRAIN_FAILED';
  return (
    <span
      className="mono text-[11px] whitespace-nowrap"
      style={{ color: failed ? 'var(--fault)' : 'var(--work)' }}
      title={DRAIN_STEP_MEANING[drain.state]}
    >
      {drain.state} {age(drain.enteredStateAt, now)}
    </span>
  );
}
