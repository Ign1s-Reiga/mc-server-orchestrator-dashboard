import type {
  ConditionStatus,
  ConditionType,
  DisplayState,
  DrainState,
  ServerResource,
} from './api/types';

/**
 * How much attention a thing is owed. Drives colour, and only colour.
 *
 * `work` is deliberately not `fault`. A drain is the system behaving correctly
 * — it is how a Minecraft server is allowed to stop — so it must not be painted
 * as an error. It is gold because it is in flight and cannot be called back.
 */
export type Tone = 'ok' | 'work' | 'fault' | 'neutral' | 'quiet';

interface StateFacts {
  tone: Tone;
  /** What this state actually means, in the operator's terms. */
  meaning: string;
}

/**
 * `display.state` is derived by the API (§7) so that every dashboard does not
 * invent its own. Nothing here recomputes it — this table only says how each
 * value is painted and what it means.
 */
const STATES: Record<DisplayState, StateFacts> = {
  READY: { tone: 'ok', meaning: 'running and joinable' },
  RUNNING: { tone: 'neutral', meaning: 'the container is up but the server is not joinable yet' },
  STARTING: { tone: 'neutral', meaning: 'pulling, creating or starting' },
  PENDING: { tone: 'quiet', meaning: 'recorded; the reconcile loop has not acted yet' },
  DRAINING: {
    tone: 'work',
    meaning: 'evacuating players and confirming a world save before anything stops',
  },
  TERMINATING: {
    tone: 'work',
    meaning: 'a delete was recorded; the name is held until the drain finishes',
  },
  STOPPING: { tone: 'work', meaning: 'the container is being stopped' },
  STOPPED: { tone: 'quiet', meaning: 'not running' },
  FAILED: { tone: 'fault', meaning: 'the reconcile loop could not converge' },
  UNKNOWN: { tone: 'fault', meaning: 'the observed state could not be determined' },
};

export function stateTone(state: DisplayState): Tone {
  return STATES[state]?.tone ?? 'neutral';
}

export function stateMeaning(state: DisplayState): string {
  return STATES[state]?.meaning ?? 'an state this dashboard does not know about';
}

export const TONE_COLOR: Record<Tone, string> = {
  ok: 'var(--ok)',
  work: 'var(--work)',
  fault: 'var(--fault)',
  neutral: 'var(--text)',
  quiet: 'var(--text-faint)',
};

/**
 * The drain protocol in order (§6, §14).
 *
 * This is a genuine sequence — each step is a precondition for the next, and
 * the order is what stops a container being killed with players on it — so
 * rendering it as an ordered track carries real information rather than
 * decorating the page with step numbers.
 *
 * `DRAIN_FAILED` is deliberately absent: it is not a position on the track, it
 * is the track breaking.
 */
export const DRAIN_SEQUENCE: readonly DrainState[] = [
  'DRAIN_REQUESTED',
  'SEALED',
  'TARGET_RESOLVED',
  'TRANSFERRING',
  'SAVING',
  'DEREGISTERED',
  'STOPPING',
];

export const DRAIN_STEP_MEANING: Record<DrainState, string> = {
  DRAIN_REQUESTED: 'the drain was recorded and is waiting to start',
  SEALED: 'the server is refusing new logins, so the player count can only fall',
  TARGET_RESOLVED: 'a destination server has been chosen for the players still on',
  TRANSFERRING: 'moving players off',
  SAVING: 'a save has been requested and is not confirmed yet',
  DEREGISTERED: 'the world save is confirmed and the server has left the proxy',
  STOPPING: 'the container is being stopped',
  DRAIN_FAILED: 'the drain aborted and the server is still running',
};

export function drainStepIndex(state: DrainState): number {
  return DRAIN_SEQUENCE.indexOf(state);
}

/**
 * The order conditions are shown in: roughly the order they become true over a
 * server's life, so the list reads as a progression rather than as whatever
 * order the store happened to write.
 */
const CONDITION_ORDER: readonly ConditionType[] = [
  'IMAGE_AVAILABLE',
  'VOLUME_BOUND',
  'CONTAINER_RUNNING',
  'READY',
  'DRAINING',
  'PLAYERS_EVACUATED',
  'WORLD_SAVED',
  'NEEDS_ATTENTION',
];

export function sortConditions<T extends { type: ConditionType }>(conditions: readonly T[]): T[] {
  return [...conditions].sort((a, b) => {
    const ai = CONDITION_ORDER.indexOf(a.type);
    const bi = CONDITION_ORDER.indexOf(b.type);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
}

export function conditionTone(type: ConditionType, status: ConditionStatus): Tone {
  if (type === 'NEEDS_ATTENTION') return status === 'TRUE' ? 'fault' : 'quiet';
  if (type === 'DRAINING') return status === 'TRUE' ? 'work' : 'quiet';
  if (status === 'TRUE') return 'ok';
  if (status === 'UNKNOWN') return 'quiet';
  return 'neutral';
}

/**
 * Whether the reconcile loop has caught up with the spec as written.
 *
 * The API computes `caughtUp` for us; this only names the gap so the UI can say
 * "generation 3 declared, 2 observed" instead of a bare boolean. It is the
 * clearest expression of the idea in §1 — a 2xx recorded the request, and the
 * world changes later.
 */
export interface GenerationGap {
  declared: number;
  observed: number | null;
  caughtUp: boolean;
}

export function generationGap(server: ServerResource): GenerationGap {
  return {
    declared: server.metadata.generation,
    observed: server.status?.observedGeneration ?? null,
    caughtUp: server.caughtUp,
  };
}

/* ------------------------------------------------------------- formatting */

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'narrow' });

/** Compact age, for a column where every row has one. */
export function age(iso: string | null | undefined, now: number = Date.now()): string {
  if (iso === null || iso === undefined) return '—';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** "4 min ago" — for prose, where a bare `4m` would read as a duration. */
export function relative(iso: string | null | undefined, now: number = Date.now()): string {
  if (iso === null || iso === undefined) return 'never';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';
  const seconds = Math.round((then - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return RELATIVE.format(Math.round(seconds), 'second');
  if (abs < 3600) return RELATIVE.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return RELATIVE.format(Math.round(seconds / 3600), 'hour');
  return RELATIVE.format(Math.round(seconds / 86400), 'day');
}

export function absolute(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return iso;
  return then.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

export function millis(value: number): string {
  if (value < 1000) return `${value}ms`;
  if (value < 60_000) return `${Math.round(value / 100) / 10}s`;
  return `${Math.round(value / 60_000)}m`;
}

/**
 * Player occupancy. Counts only — the API has no field an identity could live
 * in, and this dashboard has nowhere to put one.
 */
export function occupancy(server: ServerResource): { online: number | null; max: number | null } {
  return { online: server.display.playersOnline, max: server.display.playersMax };
}
