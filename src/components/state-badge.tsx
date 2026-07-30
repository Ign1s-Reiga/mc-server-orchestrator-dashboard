import type { DisplayState, ServerResource } from '@/lib/api/types';
import { stateMeaning, stateTone, TONE_COLOR } from '@/lib/display';
import { Dot, cx } from './ui';

/**
 * The derived badge from §7.
 *
 * `display.state` is computed by the API precisely so that every dashboard does
 * not invent its own answer, so this renders the value and never recomputes it
 * from `phase`, `ready`, `drain` or `terminating`.
 */
export function StateBadge({
  state,
  size = 'sm',
  className,
}: {
  state: DisplayState;
  size?: 'sm' | 'lg';
  className?: string;
}) {
  const tone = stateTone(state);
  return (
    <span
      className={cx(
        'mono inline-flex items-center gap-2 whitespace-nowrap',
        size === 'lg' ? 'text-[15px] font-medium tracking-tight' : 'text-[12px]',
        className,
      )}
      style={{ color: TONE_COLOR[tone] }}
      title={stateMeaning(state)}
    >
      <Dot tone={tone} pulse={state === 'DRAINING' || state === 'TERMINATING'} />
      {state}
    </span>
  );
}

/**
 * `needsAttention` is a flag, not a state (§7).
 *
 * It sits *beside* the badge and never replaces it: a drain that has been
 * failing for an hour is still `DRAINING`, and showing it as `FAILED` would be
 * a lie about what the reconcile loop is doing.
 */
export function AttentionFlag({ title }: { title?: string }) {
  return (
    <span
      className="mono inline-flex items-center gap-1 text-[11px] px-1.5 border rounded-sm"
      style={{ color: 'var(--fault)', borderColor: 'currentColor' }}
      title={title ?? 'a NEEDS_ATTENTION condition is TRUE — see the conditions table'}
    >
      <span aria-hidden>▲</span>
      ATTENTION
    </span>
  );
}

/**
 * Declared generation against observed generation.
 *
 * The clearest way to show the idea in §1: a write was recorded, and the world
 * has not caught up with it yet.
 */
export function GenerationGauge({ server }: { server: ServerResource }) {
  const declared = server.metadata.generation;
  const observed = server.status?.observedGeneration ?? null;

  if (server.caughtUp) {
    return (
      <span className="mono text-[11px]" style={{ color: 'var(--text-faint)' }} title="the reconcile loop has observed the current spec">
        gen {declared}
      </span>
    );
  }

  return (
    <span
      className="mono text-[11px]"
      style={{ color: 'var(--work)' }}
      title={
        observed === null
          ? 'the spec is recorded; the reconcile loop has not observed it yet'
          : `spec is at generation ${declared}; the loop has observed ${observed}`
      }
    >
      gen {declared}
      <span aria-hidden> ← </span>
      {observed ?? 'none'}
    </span>
  );
}
