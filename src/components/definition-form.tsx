'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { jsonBody, validateDefinition } from '@/lib/api/client';
import { describeError, isApiError, isValidationFailure } from '@/lib/api/errors';
import type { Definition, Violation } from '@/lib/api/types';
import {
  DEFAULT_HINTS,
  NO_VIOLATIONS,
  indexViolations,
  sourceLine,
  toDefinitionInput,
  type FieldPath,
  type FormState,
  type ViolationIndex,
} from '@/lib/form/definition-form';
import { Button, Note, Panel, cx } from './ui';

/* ------------------------------------------------------------------ inputs */

interface FieldContext {
  state: FormState;
  setValue: (path: FieldPath, value: string) => void;
  violations: ViolationIndex;
  /** The exact JSON that produced the current violations, for line lookups. */
  sentText: string | null;
}

/**
 * One input, wired to its dotted path.
 *
 * Violations arrive from the API attached to a `field` — the same path this
 * input is keyed by — so an error lands on the control that caused it. §5 says
 * the schema went to some trouble to make that possible; dumping the list at
 * the top of the form would waste it.
 */
function Input({
  ctx,
  path,
  label,
  help,
  type = 'text',
  required = false,
  className,
}: {
  ctx: FieldContext;
  path: FieldPath;
  label: string;
  help?: string;
  type?: 'text' | 'number';
  required?: boolean;
  className?: string;
}) {
  const id = useId();
  const problems = ctx.violations.byField.get(path) ?? [];
  const invalid = problems.length > 0;

  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="label flex items-baseline gap-1.5">
        {label}
        {required && (
          <span aria-hidden style={{ color: 'var(--fault)' }}>
            *
          </span>
        )}
      </label>
      <input
        id={id}
        type={type}
        inputMode={type === 'number' ? 'numeric' : undefined}
        value={ctx.state.values[path]}
        onChange={(event) => ctx.setValue(path, event.target.value)}
        placeholder={DEFAULT_HINTS[path]}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-problem` : help !== undefined ? `${id}-help` : undefined}
        autoComplete="off"
        spellCheck={false}
        className="mono text-[13px] px-2.5 h-8 border rounded-sm w-full"
        style={{
          background: 'var(--bg-raised)',
          borderColor: invalid ? 'var(--fault)' : undefined,
        }}
      />
      {invalid ? (
        <ProblemList id={`${id}-problem`} problems={problems} sentText={ctx.sentText} />
      ) : (
        help !== undefined && (
          <p id={`${id}-help`} className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
            {help}
          </p>
        )
      )}
      {!invalid && help === undefined && DEFAULT_HINTS[path] !== undefined && (
        <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
          Leave blank for {DEFAULT_HINTS[path]}.
        </p>
      )}
    </div>
  );
}

function ProblemList({
  id,
  problems,
  sentText,
}: {
  id: string;
  problems: readonly Violation[];
  sentText: string | null;
}) {
  return (
    <div id={id} className="flex flex-col gap-1">
      {problems.map((problem, index) => {
        const line =
          problem.location !== null && sentText !== null
            ? sourceLine(sentText, problem.location.line)
            : null;
        return (
          <div key={index}>
            <p className="text-[12px]" style={{ color: 'var(--fault)' }}>
              {problem.problem}
            </p>
            {problem.location !== null && (
              <p className="mono text-[10px] mt-0.5" style={{ color: 'var(--text-faint)' }}>
                line {problem.location.line}:{problem.location.column}
                {line !== null && <span> · {line.trim()}</span>}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Section({
  title,
  hint,
  children,
  columns = 2,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  columns?: 1 | 2;
}) {
  return (
    <Panel title={title} hint={hint}>
      <div className={cx('grid gap-4 p-4', columns === 2 && 'sm:grid-cols-2')}>{children}</div>
    </Panel>
  );
}

/* -------------------------------------------------------------------- form */

export interface SubmitOutcome {
  violations?: readonly Violation[];
}

export function DefinitionForm({
  state,
  onChange,
  onSubmit,
  submitLabel,
  busy,
  nameLocked = false,
  submitViolations,
  header,
  footer,
}: {
  state: FormState;
  onChange: (next: FormState) => void;
  onSubmit: () => void;
  submitLabel: string;
  busy: boolean;
  /** On edit, the name is part of the identity — renaming is a create + delete. */
  nameLocked?: boolean;
  /** Violations from the last write attempt, which outrank the live ones. */
  submitViolations: readonly Violation[] | null;
  header?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const [liveViolations, setLiveViolations] = useState<readonly Violation[] | null>(null);
  const [effective, setEffective] = useState<Definition | null>(null);
  const [validateError, setValidateError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const sentTextRef = useRef<string | null>(null);
  const [sentText, setSentText] = useState<string | null>(null);

  const setValue = useCallback(
    (path: FieldPath, value: string) => {
      onChange({ ...state, values: { ...state.values, [path]: value } });
    },
    [state, onChange],
  );

  const body = useMemo(() => jsonBody(toDefinitionInput(state)), [state]);

  /*
   * Live validation against `POST /validate` — the same parser that would
   * reject the document on submit, so the two cannot disagree (§6). It writes
   * nothing, and its 200 carries the effective definition, which is the
   * cheapest way to show an operator what their omissions became.
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
  // document that was submitted, not to whatever has been typed since.
  const active = submitViolations ?? liveViolations;
  const violations = useMemo(
    () => (active === null ? NO_VIOLATIONS : indexViolations(active)),
    [active],
  );

  const ctx: FieldContext = { state, setValue, violations, sentText };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className="flex flex-col gap-4"
    >
      {header}

      {violations.total > 0 && (
        <Note tone="fault" title={`${violations.total} problem${violations.total === 1 ? '' : 's'}`}>
          Each one is marked on its field below. The API reports every problem in a document at
          once, so this is the complete list — fixing them all makes the next submit succeed.
          {violations.unattached.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1">
              {violations.unattached.map((violation, index) => (
                <li key={index} className="text-[12px]">
                  <span className="mono" style={{ color: 'var(--fault)' }}>
                    {violation.field}
                  </span>{' '}
                  {violation.problem}
                </li>
              ))}
            </ul>
          )}
        </Note>
      )}

      {validateError !== null && (
        <Note tone="work" title="live checking is not available">
          {validateError} The form still submits; the API validates on write either way.
        </Note>
      )}

      <Section title="identity">
        <Input
          ctx={ctx}
          path="metadata.name"
          label="name"
          required
          className={nameLocked ? 'opacity-60 pointer-events-none' : undefined}
          help={
            nameLocked
              ? 'Renaming is a create and a delete, not an edit — the old server has to be drained before its name is released.'
              : 'Lowercase. This is the identity the reconcile loop and the drain protocol use.'
          }
        />
        <div className="flex flex-col gap-1">
          <label className="label" htmlFor="labels">
            labels
          </label>
          <textarea
            id="labels"
            value={state.labels}
            onChange={(event) => onChange({ ...state, labels: event.target.value })}
            rows={2}
            spellCheck={false}
            placeholder={'tier=survival\nregion=eu-west'}
            className="mono text-[13px] px-2.5 py-1.5 border rounded-sm w-full"
            style={{ background: 'var(--bg-raised)' }}
          />
          <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
            One key=value per line. Changing only labels does not move the generation, so it causes
            no drain.
          </p>
        </div>
      </Section>

      <Section title="image">
        <Input
          ctx={ctx}
          path="spec.image"
          label="image"
          required
          className="sm:col-span-2"
          help="Pinned to a tag or a digest. A moving tag like `latest` makes an image change invisible to reconcile."
        />
        <Input ctx={ctx} path="spec.paper.minecraftVersion" label="minecraft version" required help="A release, such as 1.21.8." />
        <Input ctx={ctx} path="spec.paper.build" label="paper build" type="number" />

        <div className="sm:col-span-2 flex items-start gap-2.5">
          <input
            id="eula"
            type="checkbox"
            checked={state.eulaAccepted}
            onChange={(event) => onChange({ ...state, eulaAccepted: event.target.checked })}
            className="mt-1"
            aria-invalid={violations.byField.has('spec.eulaAccepted')}
          />
          <div>
            <label htmlFor="eula" className="text-[13px]">
              The Minecraft EULA is accepted for this server
            </label>
            {violations.byField.has('spec.eulaAccepted') ? (
              <ProblemList
                id="eula-problem"
                problems={violations.byField.get('spec.eulaAccepted') ?? []}
                sentText={sentText}
              />
            ) : (
              <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
                A Paper server refuses to start until it is, so a definition without it can never
                become joinable.
              </p>
            )}
          </div>
        </div>
      </Section>

      <Section title="capacity and network">
        <Input ctx={ctx} path="spec.maxPlayers" label="max players" type="number" />
        <Input ctx={ctx} path="spec.network.port" label="game port" type="number" />
        <Input ctx={ctx} path="spec.network.hostPort" label="host port" type="number" help="Publish the game port on the host. Leave blank to keep it internal." />
        <div />

        <div className="sm:col-span-2 flex flex-col gap-3 pt-1 border-t">
          <div className="flex items-center gap-2.5 pt-3">
            <input
              id="rcon"
              type="checkbox"
              checked={state.rconEnabled}
              onChange={(event) => onChange({ ...state, rconEnabled: event.target.checked })}
            />
            <label htmlFor="rcon" className="text-[13px]">
              Enable RCON
            </label>
          </div>
          {state.rconEnabled && (
            <div className="grid sm:grid-cols-3 gap-4">
              <Input ctx={ctx} path="spec.network.rcon.port" label="rcon port" type="number" />
              <Input
                ctx={ctx}
                path="spec.network.rcon.passwordSecret.name"
                label="password secret"
                required
                help="A secret name."
              />
              <Input
                ctx={ctx}
                path="spec.network.rcon.passwordSecret.key"
                label="secret key"
                required
                help="Coordinates only — the password itself lives in the secret store."
              />
            </div>
          )}
        </div>
      </Section>

      <Section title="resources">
        <Input ctx={ctx} path="spec.resources.memory" label="container memory" required help="At least 1Gi. Example: 4Gi." />
        <Input ctx={ctx} path="spec.resources.cpu" label="cpu" help="Example: 2500m or 2." />
        <Input ctx={ctx} path="spec.resources.heap.max" label="jvm heap max" help="Left blank, the parser leaves headroom below the container limit so the JVM cannot be OOM-killed." />
        <Input ctx={ctx} path="spec.resources.heap.min" label="jvm heap min" />
      </Section>

      <Section title="storage" columns={1}>
        <fieldset className="flex flex-col gap-2">
          <legend className="label mb-1">mode</legend>
          {(['persistent', 'ephemeral'] as const).map((mode) => (
            <label key={mode} className="flex items-start gap-2.5 text-[13px]">
              <input
                type="radio"
                name="storage-mode"
                checked={state.storageMode === mode}
                onChange={() => onChange({ ...state, storageMode: mode })}
                className="mt-1"
              />
              <span>
                <span className="mono">{mode}</span>
                <span className="block text-[11px]" style={{ color: 'var(--text-faint)' }}>
                  {mode === 'persistent'
                    ? 'A volume that outlives the container. The default, and the right answer for anything with a world.'
                    : 'World data does not survive the container. Only for disposable lobbies and minigame instances.'}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        {state.storageMode === 'ephemeral' && (
          <Note tone="work" title="this world will not survive the container">
            Ephemeral storage is opt-in for a reason. Anything a player builds here is gone when the
            container is replaced — which a spec change does routinely.
          </Note>
        )}

        <div className="grid sm:grid-cols-3 gap-4">
          <Input ctx={ctx} path="spec.storage.mountPath" label="mount path" />
          {state.storageMode === 'persistent' && (
            <>
              <Input ctx={ctx} path="spec.storage.volume.name" label="volume name" />
              <Input ctx={ctx} path="spec.storage.volume.size" label="volume size" />
            </>
          )}
        </div>
      </Section>

      <Section title="lifecycle" hint="how this server is allowed to stop">
        <Input
          ctx={ctx}
          path="spec.lifecycle.drain.playerTransferTimeout"
          label="player transfer timeout"
          help="How long to spend moving players off before giving up."
        />
        <Input
          ctx={ctx}
          path="spec.lifecycle.drain.saveTimeout"
          label="save timeout"
          help="How long to wait for the world save to be confirmed."
        />
        <Input
          ctx={ctx}
          path="spec.lifecycle.stopGracePeriod"
          label="stop grace period"
          help="The last-resort net, not the save path. It must stay above the save timeout."
        />
        <Input ctx={ctx} path="spec.lifecycle.startupTimeout" label="startup timeout" />
      </Section>

      <Section title="placement" columns={1}>
        <Input
          ctx={ctx}
          path="spec.placement.node"
          label="node"
          help="Pin this server to one node. Leave blank and the scheduler chooses."
        />
      </Section>

      <EffectivePreview effective={effective} checking={checking} />

      <div className="flex items-center gap-3 flex-wrap">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Sending…' : submitLabel}
        </Button>
        {footer}
      </div>
    </form>
  );
}

/**
 * What the parser makes of the document as typed.
 *
 * §6: "Showing an operator what their omissions became is most of what this is
 * for." A create form full of blanks is otherwise a guess about what will
 * actually run.
 */
function EffectivePreview({
  effective,
  checking,
}: {
  effective: Definition | null;
  checking: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Panel
      title="effective definition"
      hint={
        checking
          ? 'checking…'
          : effective !== null
            ? 'valid — this is what the reconciler would act on'
            : 'not valid yet'
      }
      actions={
        effective !== null && (
          <Button onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'Hide' : 'Show'}
          </Button>
        )
      }
    >
      {open && effective !== null && (
        <pre
          className="mono text-[12px] leading-relaxed p-4 overflow-x-auto max-h-96"
          style={{ background: 'var(--bg-sunken)' }}
        >
          {JSON.stringify(effective, null, 2)}
        </pre>
      )}
    </Panel>
  );
}
