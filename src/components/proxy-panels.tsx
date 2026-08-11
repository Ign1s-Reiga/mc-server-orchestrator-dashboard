'use client';

import type {
  BackendRegistration,
  ControlEndpointStatus,
  VelocityProxyStatus,
} from '@/lib/api/types';
import { TONE_COLOR, absolute, age, type Tone } from '@/lib/display';
import { useNow } from './fleet-provider';
import { Empty, Field, Nil, Note, Panel } from './ui';

/**
 * What each registration state means for a player and for a drain.
 *
 * This is the drain protocol's own vocabulary, so the wording is about routing
 * rather than about health: `SEALED` is not a problem, it is the first step of
 * getting people off a server safely.
 */
export const REGISTRATION: Record<BackendRegistration, { tone: Tone; meaning: string }> = {
  PENDING: { tone: 'quiet', meaning: 'matched by the selector, not in the routing table yet' },
  REGISTERED: { tone: 'ok', meaning: 'in the routing table and accepting players' },
  SEALED: {
    tone: 'work',
    meaning: 'still routed, refusing new logins — the player count can only fall',
  },
  DEREGISTERED: { tone: 'quiet', meaning: 'removed from the routing table; no player can reach it' },
  UNREACHABLE: { tone: 'fault', meaning: 'the proxy cannot reach it' },
};

/**
 * The proxy's view of the fleet behind it.
 *
 * This is the only place an operator can watch a drain actually move players:
 * a backend goes `REGISTERED` → `SEALED` (no new logins) → `DEREGISTERED` (out
 * of the table), and the per-backend player count falling to zero in between is
 * the drain working.
 */
export function BackendsPanel({ status }: { status: VelocityProxyStatus }) {
  const now = useNow();
  const routing = status.backends;

  // §6 and §14 keep these two apart deliberately, and flattening them is the
  // mistake this panel exists to avoid: "never looked" is a state that resolves
  // itself, "the selector matched nothing" is one an operator has to fix.
  if (routing === null) {
    return (
      <Panel title="backends" hint="nothing observed yet">
        <div className="px-4 py-8 text-center">
          <p className="mono text-[13px]">not observed yet</p>
          <p className="text-[13px] mt-1" style={{ color: 'var(--text-dim)' }}>
            The reconcile loop has not resolved this proxy&apos;s backend selector yet. This is not
            the same as the selector matching nothing.
          </p>
        </div>
      </Panel>
    );
  }

  const matchedNothing = routing.matched === 0;

  return (
    <Panel
      title="backends"
      hint={`${routing.matched} matched · ${routing.registered} routed · ${routing.destinations} can receive · seen ${age(routing.observedAt, now)} ago`}
    >
      {matchedNothing ? (
        <div className="p-4">
          <Note tone="fault" title="the selector matched no server">
            This proxy is up and accepting connections, and has nowhere to send anybody. No server
            in the fleet carries every label in its selector. The reconcile loop cannot fix this —
            either label a server or change the selector.
          </Note>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b">
                <th className="label font-medium px-4 py-2">server</th>
                <th className="label font-medium px-4 py-2">registration</th>
                <th className="label font-medium px-4 py-2 text-right">players</th>
                <th className="label font-medium px-4 py-2">can receive</th>
                <th className="label font-medium px-4 py-2 text-right">since</th>
              </tr>
            </thead>
            <tbody>
              {routing.backends.map((backend) => {
                const facts = REGISTRATION[backend.registration] ?? {
                  tone: 'neutral' as Tone,
                  meaning: 'a registration state this dashboard does not know about',
                };
                return (
                  <tr key={backend.server} className="border-b last:border-b-0">
                    <td className="px-4 py-2 mono text-[13px]">{backend.server}</td>
                    <td className="px-4 py-2">
                      <span
                        className="mono text-[12px]"
                        style={{ color: TONE_COLOR[facts.tone] }}
                        title={facts.meaning}
                      >
                        {backend.registration}
                      </span>
                      {backend.drainInitiated && (
                        <div className="mono text-[10px]" style={{ color: 'var(--work)' }}>
                          draining
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right mono text-[13px] whitespace-nowrap">
                      {/* Counts only. A proxy sees every player in the fleet and
                          the API exposes none of them — there is no field here
                          an identity could live in. */}
                      {backend.players === null ? (
                        <Empty>—</Empty>
                      ) : (
                        <>
                          <span
                            style={{
                              color:
                                backend.players.online > 0 ? 'var(--text)' : 'var(--text-faint)',
                            }}
                          >
                            {backend.players.online}
                          </span>
                          <span style={{ color: 'var(--text-faint)' }}> / {backend.players.max}</span>
                        </>
                      )}
                    </td>
                    <td className="px-4 py-2 mono text-[12px]">
                      <span
                        style={{
                          color: backend.eligibleAsDestination ? 'var(--ok)' : 'var(--text-faint)',
                        }}
                      >
                        {backend.eligibleAsDestination ? 'yes' : 'no'}
                      </span>
                    </td>
                    <td
                      className="px-4 py-2 mono text-[12px] text-right whitespace-nowrap"
                      style={{ color: 'var(--text-faint)' }}
                      title={absolute(backend.lastTransitionAt)}
                    >
                      {age(backend.lastTransitionAt, now)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!matchedNothing && routing.destinations === 0 && (
        <div className="p-4 pt-0">
          <Note tone="work" title="no backend can receive a transfer right now">
            Servers are matched and routed, but none is currently eligible as a destination — every
            one is sealed, draining or full. A drain that needs somewhere to send players will wait.
          </Note>
        </div>
      )}
    </Panel>
  );
}

/**
 * The control endpoint, in the observed grid.
 *
 * Worth its own prominence because of what its absence costs: the orchestrator
 * seals, transfers and deregisters through this endpoint, so if it will not
 * answer, *no backend behind this proxy can finish a drain* — which is a fleet
 * problem, not a proxy problem.
 */
export function ControlEndpointField({ control }: { control: ControlEndpointStatus | null }) {
  const now = useNow();

  if (control === null) {
    return (
      <Field label="control endpoint">
        <Nil />
      </Field>
    );
  }

  const usable = control.reachable && control.compatible;
  const color = usable ? 'var(--ok)' : 'var(--fault)';

  return (
    <Field label="control endpoint">
      <span style={{ color }}>
        {control.reachable ? (control.compatible ? 'reachable' : 'incompatible plugin') : 'unreachable'}
      </span>
      <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-faint)' }}>
        {control.pluginApiVersion !== null
          ? `plugin api ${control.pluginApiVersion}`
          : 'plugin version not reported'}
        {control.lastContactAt !== null && ` · last contact ${age(control.lastContactAt, now)} ago`}
      </div>
      {!usable && (
        <div className="text-[11px] mt-0.5" style={{ color: 'var(--fault)' }}>
          No backend behind this proxy can finish a drain until this is fixed.
        </div>
      )}
    </Field>
  );
}

/**
 * The compact proxy readout for a fleet row, built from `display.proxy` rather
 * than from `status.backends`.
 *
 * §7: the counts are served precisely so a table does not re-derive them per
 * row — that is the sort of derivation that ends up wrong in one place. In
 * particular `registered` counts `REGISTERED` *and* `SEALED`, because both are
 * in the routing table, which is not what a client would guess.
 */
export function ProxyInline({
  proxy,
}: {
  proxy: {
    backendsMatched: number | null;
    backendsRegistered: number | null;
    backendsDestinations: number | null;
    backendsObserved: boolean;
    controlReachable: boolean | null;
    controlCompatible: boolean | null;
  };
}) {
  // Never observed and "matched nothing" are different facts, and the second is
  // a condition an operator has to see. Rendering the first as "0 backends"
  // would make the second invisible.
  if (!proxy.backendsObserved) {
    return (
      <span className="mono text-[11px]" style={{ color: 'var(--text-faint)' }}>
        backends not observed
      </span>
    );
  }

  const matched = proxy.backendsMatched ?? 0;
  const controlBad = proxy.controlReachable === false || proxy.controlCompatible === false;

  return (
    <span className="mono text-[11px] inline-flex gap-2 flex-wrap">
      <span style={{ color: matched === 0 ? 'var(--fault)' : 'var(--text-faint)' }}>
        {matched === 0
          ? 'selector matched nothing'
          : `${proxy.backendsRegistered ?? 0}/${matched} routed · ${proxy.backendsDestinations ?? 0} can receive`}
      </span>
      {controlBad && (
        <span style={{ color: 'var(--fault)' }}>
          {proxy.controlReachable === false ? 'control unreachable' : 'plugin incompatible'}
        </span>
      )}
    </span>
  );
}
