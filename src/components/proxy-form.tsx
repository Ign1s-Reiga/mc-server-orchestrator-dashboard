'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { jsonBody, listSecrets, validateDefinition } from '@/lib/api/client';
import { describeError, isApiError, isValidationFailure } from '@/lib/api/errors';
import type { Definition, SecretSummary, ServerResource, Violation } from '@/lib/api/types';
import { indexViolations, NO_VIOLATIONS, parseLabels } from '@/lib/form/definition-form';
import {
  PROXY_DEFAULT_HINTS,
  PROXY_KNOWN_PATHS,
  asViolation,
  parseList,
  proxyInvariantProblems,
  toProxyInput,
  type ProxyFormState,
} from '@/lib/form/proxy-form';
import { selectorMatches } from '@/lib/fleet-tree';
import { useFleet } from './fleet-provider';
import {
  AreaField,
  EffectivePreview,
  Section,
  TextField,
  ViolationSummary,
  type FieldContext,
} from './form-fields';
import { FALLBACK_DRAIN_POLICIES, useMeta } from './meta-provider';
import { Button, Note, Panel } from './ui';

/**
 * The structured editor for a `VelocityProxy`.
 *
 * This kind was edited as a raw document for a long time, on a stated argument
 * worth keeping in view: §5 reports a line and column into the text as sent, so
 * a hand-written document gets violations pointing at the exact line typed, and
 * a form covering only part of a spec silently drops the rest. `proxy-form.ts`
 * answers the coverage half with a round-trip test. This file answers the other
 * half — it has to be *better* than a text box, not merely friendlier, and two
 * things here are what a document cannot do:
 *
 * - **The selector says what it currently matches.** An empty `matchLabels` is
 *   refused and a selector matching nothing leaves a proxy up, accepting
 *   players and routing them nowhere — `DEGRADED`, and the reconcile loop
 *   cannot fix it. Both are invisible in YAML and obvious here.
 * - **The forwarding secret is checked for existence.** It is a coordinate, not
 *   a value, so a typo in it parses perfectly and fails much later as
 *   `FORWARDING_SECRET_UNAVAILABLE`.
 *
 * The document editor is still one click away, and remains the way to express
 * anything this form has not caught up with.
 */
export function ProxyForm({
  state,
  onChange,
  onSubmit,
  submitLabel,
  busy,
  nameLocked = false,
  submitViolations,
  header,
  footer,
  onSwitchToDocument,
}: {
  state: ProxyFormState;
  onChange: (next: ProxyFormState) => void;
  onSubmit: () => void;
  submitLabel: string;
  busy: boolean;
  nameLocked?: boolean;
  submitViolations: readonly Violation[] | null;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  onSwitchToDocument?: () => void;
}) {
  const meta = useMeta();
  const drainPolicies = meta?.enums.drainPolicy ?? FALLBACK_DRAIN_POLICIES;
  const forwardingModes = meta?.enums.forwardingMode ?? (['modern'] as const);

  const [liveViolations, setLiveViolations] = useState<readonly Violation[] | null>(null);
  const [effective, setEffective] = useState<Definition | null>(null);
  const [validateError, setValidateError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const sentTextRef = useRef<string | null>(null);
  const [sentText, setSentText] = useState<string | null>(null);

  const setValue = useCallback(
    (path: string, value: string) => {
      onChange({ ...state, values: { ...state.values, [path]: value } });
    },
    [state, onChange],
  );

  const body = useMemo(() => jsonBody(toProxyInput(state)), [state]);

  /*
   * Live validation against `POST /validate` — the same parser that would
   * reject the document on submit, so the two cannot disagree (§6). It writes
   * nothing, and its 200 carries the effective definition.
   */
  useEffect(() => {
    if (state.values['metadata.name'].trim().length === 0) {
      setLiveViolations(null);
      setEffective(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setChecking(true);
      sentTextRef.current = body.text;
      void validateDefinition(body)
        .then((result) => {
          if (controller.signal.aborted) return;
          setEffective(result.definition);
          setLiveViolations([]);
          setValidateError(null);
          setSentText(sentTextRef.current);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setEffective(null);
          if (isValidationFailure(cause)) {
            setLiveViolations(cause.violations);
            setValidateError(null);
            setSentText(sentTextRef.current);
          } else {
            setLiveViolations(null);
            setValidateError(isApiError(cause) ? describeError(cause) : 'validation could not run');
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setChecking(false);
        });
    }, 500);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [body, state]);

  // A write's own 422 outranks the live check: it is the answer to the exact
  // document that was submitted, not to whatever has been typed since. The
  // locally-derived invariants are appended rather than substituted — they are
  // the same rejections the parser would give, reached sooner.
  const active = submitViolations ?? liveViolations;
  const violations = useMemo(() => {
    // Verified against a live parser: `spec.control.port` is the path both this
    // and `SpecInvariants.proxyPortProblem` report on. So the API's own wording
    // wins wherever it has spoken, and the local copy only fills the gap before
    // the debounce lands — otherwise the field carries the same sentence twice.
    const spoken = new Set((active ?? []).map((violation) => violation.field));
    const local = proxyInvariantProblems(state)
      .filter((problem) => !spoken.has(problem.path))
      .map(asViolation);
    if (active === null) {
      return local.length === 0 ? NO_VIOLATIONS : indexViolations(local, PROXY_KNOWN_PATHS);
    }
    return indexViolations([...active, ...local], PROXY_KNOWN_PATHS);
  }, [active, state]);

  const ctx: FieldContext = {
    values: state.values,
    setValue,
    violations,
    sentText,
    hints: PROXY_DEFAULT_HINTS,
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className="flex flex-col gap-4"
    >
      {header}

      <ViolationSummary violations={violations} />

      {validateError !== null && (
        <Note tone="work" title="live checking is not available">
          {validateError} The form still submits; the API validates on write either way.
        </Note>
      )}

      <Section title="identity">
        <TextField
          ctx={ctx}
          path="metadata.name"
          label="name"
          required
          className={nameLocked ? 'opacity-60 pointer-events-none' : undefined}
          help={
            nameLocked
              ? 'Renaming is a create and a delete, not an edit — the old proxy has to be drained before its name is released.'
              : 'Lowercase. This is the identity the reconcile loop and the drain protocol use.'
          }
        />
        <AreaField
          ctx={ctx}
          path="metadata.labels"
          label="labels"
          value={state.labels}
          onChange={(labels) => onChange({ ...state, labels })}
          rows={2}
          placeholder={'role=edge\nregion=eu-west'}
          help="One key=value per line. These are this proxy's own labels — not what it selects. Changing only labels does not move the generation, so it causes no drain."
        />
      </Section>

      <Section title="image" columns={1}>
        <TextField
          ctx={ctx}
          path="spec.image"
          label="image"
          required
          help="Pinned to a tag or a digest. A moving tag like `latest` makes an image change invisible to reconcile."
        />
      </Section>

      <BackendsSection ctx={ctx} state={state} onChange={onChange} />

      <ForwardingSection ctx={ctx} state={state} onChange={onChange} modes={forwardingModes} />

      <Section title="capacity and network">
        <TextField ctx={ctx} path="spec.maxPlayers" label="max players" type="number" />
        <div />
        <TextField
          ctx={ctx}
          path="spec.network.port"
          label="player port"
          type="number"
          help="Inside the sandbox. The image's stock velocity.toml binds 25577, which is why that is the default and not Velocity's own 25565."
        />
        <TextField
          ctx={ctx}
          path="spec.network.hostPort"
          label="host port"
          type="number"
          help="What players actually connect to. A proxy is the front door, so unlike a backend this usually is published."
        />
      </Section>

      <Section title="resources">
        <TextField
          ctx={ctx}
          path="spec.resources.memory"
          label="container memory"
          required
          help="At least 1Gi. A proxy holds no world, so it needs far less than a server."
        />
        <TextField ctx={ctx} path="spec.resources.cpu" label="cpu" help="Example: 2500m or 2." />
        <TextField
          ctx={ctx}
          path="spec.resources.heap.max"
          label="jvm heap max"
          help="Left blank, the parser leaves headroom below the container limit so the JVM cannot be OOM-killed."
        />
        <TextField ctx={ctx} path="spec.resources.heap.min" label="jvm heap min" />
      </Section>

      <ControlSection ctx={ctx} state={state} />

      <Section title="lifecycle" hint="how this proxy is allowed to stop">
        <div className="flex flex-col gap-1 sm:col-span-2">
          <span className="label">drain policy</span>
          <p className="mono text-[13px]">{drainPolicies.join(', ')}</p>
          <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
            {drainPolicies.length === 1
              ? 'The only policy the schema defines, so it is applied and not asked about. A second one would appear here from /meta with no frontend release.'
              : 'Served by the API — this build renders whatever the schema defines.'}
          </p>
        </div>
        <TextField
          ctx={ctx}
          path="spec.lifecycle.drain.sealTimeout"
          label="seal timeout"
          help="How long this proxy gets to stop accepting new players when it is itself being drained."
        />
        <TextField
          ctx={ctx}
          path="spec.lifecycle.stopGracePeriod"
          label="stop grace period"
          help="A proxy holds no world, so there is no save to outlast and no rule tying this to one."
        />
        <TextField ctx={ctx} path="spec.lifecycle.startupTimeout" label="startup timeout" />
        <div />
      </Section>

      <Section title="placement" columns={1}>
        <TextField
          ctx={ctx}
          path="spec.placement.node"
          label="node"
          help="Pin this proxy to one node. Leave blank and the scheduler chooses."
        />
      </Section>

      <EffectivePreview effective={effective} checking={checking} />

      <div className="flex items-center gap-3 flex-wrap">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Sending…' : submitLabel}
        </Button>
        {footer}
        {onSwitchToDocument !== undefined && (
          <Button onClick={onSwitchToDocument} variant="ghost">
            Edit as a document
          </Button>
        )}
      </div>
    </form>
  );
}

/**
 * The selector, and what it currently matches.
 *
 * The single most useful thing a form can add over a text box here. Two states
 * a document cannot show, and both cost an outage:
 *
 * - **Empty is refused.** `BackendSelector` will not construct with an empty
 *   `matchLabels`, because it would enrol the whole fleet — including servers
 *   deliberately kept off this proxy and including another proxy's backends,
 *   which is how two proxies end up fighting over one forwarding secret.
 * - **Matching nothing is worse than it looks.** The proxy comes up, accepts
 *   players and has nowhere to send them. That is `DEGRADED`, and the reconcile
 *   loop cannot fix a selector.
 */
function BackendsSection({
  ctx,
  state,
  onChange,
}: {
  ctx: FieldContext;
  state: ProxyFormState;
  onChange: (next: ProxyFormState) => void;
}) {
  const fleet = useFleet();
  const selector = parseLabels(state.matchLabels);

  const matched = useMemo(() => {
    // Guarded, and the guard is the point: `matchLabels.every(...)` on an empty
    // map is vacuously true, so an unguarded preview would report "matches all
    // 12 servers" for the one selector the parser refuses outright.
    if (selector === undefined) return null;
    return [...fleet.servers.values()].filter(
      (server) =>
        server.definition.kind === 'PaperServer' &&
        selectorMatches(selector, server.definition.metadata.labels),
    );
  }, [selector, fleet.servers]);

  const fallback = parseList(state.fallback) ?? [];
  const unmatchedFallback = fallback.filter(
    (name) => matched !== null && !matched.some((server) => server.name === name),
  );

  return (
    <Section title="backends" hint="which servers this proxy routes to" columns={1}>
      <AreaField
        ctx={ctx}
        path="spec.backends.selector.matchLabels"
        label="selector"
        required
        value={state.matchLabels}
        onChange={(matchLabels) => onChange({ ...state, matchLabels })}
        rows={3}
        placeholder={'mcorch.dev/fleet=main\ntier=survival'}
        help="One key=value per line. A server is enrolled when it carries every one of them — an AND, never an OR."
      >
        <SelectorPreview selector={selector} matched={matched} />
      </AreaField>

      <AreaField
        ctx={ctx}
        path="spec.backends.fallback"
        label="fallback order"
        value={state.fallback}
        onChange={(next) => onChange({ ...state, fallback: next })}
        rows={2}
        placeholder={'lobby-01\nlobby-02'}
        help="One server name per line, tried in order when a player needs somewhere to go. Naming a server here does not enrol it — it still has to match the selector."
      >
        {unmatchedFallback.length > 0 && (
          <p className="text-[11px] mt-1" style={{ color: 'var(--work)' }}>
            {unmatchedFallback.map((name) => (
              <span key={name} className="mono">
                {name}{' '}
              </span>
            ))}
            {unmatchedFallback.length === 1 ? 'is' : 'are'} not matched by the selector above, so{' '}
            {unmatchedFallback.length === 1 ? 'it' : 'they'} cannot receive players from this proxy.
          </p>
        )}
      </AreaField>

      <div className="grid sm:grid-cols-3 gap-4 pt-1 border-t">
        <TextField
          ctx={ctx}
          path="spec.backends.drain.sealTimeout"
          label="seal timeout"
          help="Step 2: acknowledge no new player will be routed to a backend."
        />
        <TextField
          ctx={ctx}
          path="spec.backends.drain.destinationTimeout"
          label="destination timeout"
          help="Step 3: answer with a backend that has capacity, or with nothing."
        />
        <TextField
          ctx={ctx}
          path="spec.backends.drain.deregisterTimeout"
          label="deregister timeout"
          help="Step 6: acknowledge a backend has left the routing table."
        />
      </div>
      <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
        These measure how long <em>this proxy</em> takes to answer during a{' '}
        <strong>backend&apos;s</strong> drain, which is why they live here and not on the server. A
        backend&apos;s own player-transfer timeout scales with how many players it is moving, so it
        stays on that server.
      </p>
    </Section>
  );
}

function SelectorPreview({
  selector,
  matched,
}: {
  selector: Record<string, string> | undefined;
  matched: readonly ServerResource[] | null;
}) {
  if (selector === undefined || matched === null) {
    return (
      <p className="text-[11px] mt-1" style={{ color: 'var(--fault)' }}>
        An empty selector is refused, not treated as &ldquo;match everything&rdquo; — it would enrol
        the whole fleet, including another proxy&apos;s backends.
      </p>
    );
  }

  if (matched.length === 0) {
    return (
      <p className="text-[11px] mt-1" style={{ color: 'var(--fault)' }}>
        No server in the fleet carries every one of these labels. This parses and runs — the proxy
        comes up, accepts players and has nowhere to send them, which reads as{' '}
        <span className="mono">DEGRADED</span>. The reconcile loop cannot fix a selector.
      </p>
    );
  }

  return (
    <p className="text-[11px] mt-1" style={{ color: 'var(--text-faint)' }}>
      Matches {matched.length} server{matched.length === 1 ? '' : 's'} right now:{' '}
      {matched.map((server, index) => (
        <span key={server.name}>
          {index > 0 && ', '}
          <Link href={`/servers/${encodeURIComponent(server.name)}`} className="mono underline">
            {server.name}
          </Link>
        </span>
      ))}
      . Enrolment is re-evaluated on every pass, so this is what it would claim today.
    </p>
  );
}

/**
 * The forwarding secret, checked for existence.
 *
 * It is a coordinate and never a value, so a typo parses perfectly and surfaces
 * much later as `FORWARDING_SECRET_UNAVAILABLE` on a proxy that will not start.
 * `GET /secrets` lists names and keys — never material — which is exactly
 * enough to catch that here.
 */
function ForwardingSection({
  ctx,
  state,
  onChange,
  modes,
}: {
  ctx: FieldContext;
  state: ProxyFormState;
  onChange: (next: ProxyFormState) => void;
  modes: readonly string[];
}) {
  const secrets = useSecrets();
  const name = state.values['spec.forwarding.secret.name'].trim();
  const key = state.values['spec.forwarding.secret.key'].trim();

  return (
    <Section title="forwarding" hint="how backends trust players this proxy sends them">
      <TextField ctx={ctx} path="spec.forwarding.secret.name" label="secret name" required />
      <TextField
        ctx={ctx}
        path="spec.forwarding.secret.key"
        label="secret key"
        required
        help="Coordinates only. The value lives in the secret store and no endpoint reads it back."
      />
      <div className="sm:col-span-2">
        <SecretCheck secrets={secrets} name={name} secretKey={key} />
      </div>
      <div className="flex flex-col gap-1 sm:col-span-2">
        <span className="label">mode</span>
        {modes.length === 1 ? (
          <>
            <p className="mono text-[13px]">{modes[0]}</p>
            <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
              The only forwarding this orchestrator will run, so it is applied and not asked about.
            </p>
          </>
        ) : (
          <div className="flex gap-4">
            {modes.map((mode) => (
              <label key={mode} className="flex items-center gap-2 text-[13px]">
                <input
                  type="radio"
                  name="forwarding-mode"
                  checked={state.forwardingMode === mode}
                  onChange={() => onChange({ ...state, forwardingMode: mode as 'modern' })}
                />
                <span className="mono">{mode}</span>
              </label>
            ))}
          </div>
        )}
      </div>
    </Section>
  );
}

function SecretCheck({
  secrets,
  name,
  secretKey,
}: {
  secrets: readonly SecretSummary[] | null;
  name: string;
  secretKey: string;
}) {
  // Silent until there is something to check and something to check against.
  // A form that lit up before the operator had finished typing would be noise.
  if (secrets === null || name.length === 0 || secretKey.length === 0) {
    return (
      <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
        Store the value under{' '}
        <Link href="/secrets" className="underline">
          secrets
        </Link>{' '}
        before creating this, or the reconcile loop cannot start the proxy.
      </p>
    );
  }

  const found = secrets.find((secret) => secret.name === name);
  if (found === undefined) {
    return (
      <Note tone="fault" title={`no secret named ${name}`}>
        This parses — a secret reference is a coordinate, and the parser does not resolve it — and
        then fails at reconcile as <span className="mono">FORWARDING_SECRET_UNAVAILABLE</span>.{' '}
        <Link href="/secrets" className="underline">
          Store it first
        </Link>
        .
      </Note>
    );
  }
  if (!found.keys.includes(secretKey)) {
    return (
      <Note tone="fault" title={`${name} has no key ${secretKey}`}>
        It holds {found.keys.length === 0 ? 'no keys' : <span className="mono">{found.keys.join(', ')}</span>}.
      </Note>
    );
  }
  return (
    <p className="text-[11px]" style={{ color: 'var(--ok)' }}>
      <span className="mono">
        {name}/{secretKey}
      </span>{' '}
      exists in the secret store.
    </p>
  );
}

/**
 * The control endpoint: how `:core` seals, transfers and deregisters.
 *
 * Worth its own section because of what its absence costs — if it will not
 * answer, *no backend behind this proxy can finish a drain*, which is a fleet
 * problem rather than a proxy problem.
 */
function ControlSection({ ctx, state }: { ctx: FieldContext; state: ProxyFormState }) {
  const published = state.values['spec.control.hostPort'].trim().length > 0;
  return (
    <Section title="control endpoint" hint="how :core seals, transfers and deregisters backends">
      <TextField
        ctx={ctx}
        path="spec.control.port"
        label="control port"
        type="number"
        help="Inside the sandbox. Must differ from the player port."
      />
      <TextField
        ctx={ctx}
        path="spec.control.hostPort"
        label="host port"
        type="number"
        help="Leave blank. :core reaches the endpoint through the node without publishing it."
      />
      {published && (
        <Note tone="work" title="publishing this exposes a control plane">
          It can move every player in the fleet, so a token secret stops being optional — the parser
          checks that pairing rather than leaving it to be remembered.
        </Note>
      )}
      <TextField
        ctx={ctx}
        path="spec.control.tokenSecret.name"
        label="token secret"
        required={published}
      />
      <TextField
        ctx={ctx}
        path="spec.control.tokenSecret.key"
        label="secret key"
        required={published}
      />
      <p className="text-[11px] sm:col-span-2" style={{ color: 'var(--text-faint)' }}>
        The plugin&apos;s protocol version is deliberately not declared here. It is a property of the
        binary pair, so it is observed instead — the plugin reports what it speaks and a mismatch
        surfaces as <span className="mono">PROXY_PLUGIN_INCOMPATIBLE</span>.
      </p>
    </Section>
  );
}

/** `GET /secrets` — coordinates only, never material (§9). */
function useSecrets(): readonly SecretSummary[] | null {
  const [secrets, setSecrets] = useState<readonly SecretSummary[] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void listSecrets(controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) setSecrets(items);
      })
      .catch(() => {
        // A form that cannot render because one auxiliary read failed is worse
        // than one that skips a convenience check. `null` reads as "unknown".
      });
    return () => controller.abort();
  }, []);
  return secrets;
}

/** Kept exported so the pages can offer the document editor as the other half. */
export function DocumentEscapeHatch({ onSwitch }: { onSwitch: () => void }) {
  return (
    <Panel>
      <div className="px-4 py-3 flex flex-wrap items-center gap-3">
        <p className="text-[12px] flex-1" style={{ color: 'var(--text-dim)' }}>
          Editing as a document sends the text you write, so violations point at the exact line you
          typed — and it can express anything this form has not caught up with.
        </p>
        <Button onClick={onSwitch}>Edit as a document</Button>
      </div>
    </Panel>
  );
}
