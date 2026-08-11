'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { jsonBody, validateDefinition } from '@/lib/api/client';
import { describeError, isApiError, isValidationFailure } from '@/lib/api/errors';
import type { Definition, Violation } from '@/lib/api/types';
import {
  DEFAULT_HINTS,
  NO_VIOLATIONS,
  PAPER_KNOWN_PATHS,
  indexViolations,
  toDefinitionInput,
  type FieldPath,
  type FormState,
} from '@/lib/form/definition-form';
import { Button, Note } from './ui';
import {
  AreaField,
  EffectivePreview,
  ProblemList,
  Section,
  TextField,
  ViolationSummary,
  type FieldContext,
} from './form-fields';
import {
  FALLBACK_DRAIN_POLICIES,
  FALLBACK_STORAGE_MODES,
  useMeta,
} from './meta-provider';

/**
 * What each storage mode means, keyed by wire value.
 *
 * The *list* comes from `/meta`; only the prose lives here, so a mode added to
 * `:schema` still appears in the form — it just arrives without a description
 * until this table catches up, which is the right way round.
 */
const STORAGE_MODE_MEANING: Record<string, string> = {
  persistent:
    'A volume that outlives the container. The default, and the right answer for anything with a world.',
  ephemeral:
    'World data does not survive the container. Only for disposable lobbies and minigame instances.',
};

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
  const meta = useMeta();
  const storageModes = meta?.enums.storageMode ?? FALLBACK_STORAGE_MODES;
  const drainPolicies = meta?.enums.drainPolicy ?? FALLBACK_DRAIN_POLICIES;

  const [liveViolations, setLiveViolations] = useState<readonly Violation[] | null>(null);
  const [effective, setEffective] = useState<Definition | null>(null);
  const [validateError, setValidateError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const sentTextRef = useRef<string | null>(null);
  const [sentText, setSentText] = useState<string | null>(null);

  const setValue = useCallback(
    (path: string, value: string) => {
      onChange({ ...state, values: { ...state.values, [path as FieldPath]: value } });
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
    () => (active === null ? NO_VIOLATIONS : indexViolations(active, PAPER_KNOWN_PATHS)),
    [active],
  );

  const ctx: FieldContext = {
    values: state.values,
    setValue,
    violations,
    sentText,
    hints: DEFAULT_HINTS,
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
          readOnly={nameLocked}
          className={nameLocked ? 'opacity-60' : undefined}
          help={
            nameLocked
              ? 'Renaming is a create and a delete, not an edit — the old server has to be drained before its name is released.'
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
          placeholder={'tier=survival\nregion=eu-west'}
          help="One key=value per line. Changing only labels does not move the generation, so it causes no drain — but it can change which proxy enrols this server."
        />
      </Section>

      <Section title="image">
        <TextField
          ctx={ctx}
          path="spec.image"
          label="image"
          required
          className="sm:col-span-2"
          help="Pinned to a tag or a digest. A moving tag like `latest` makes an image change invisible to reconcile."
        />
        <TextField ctx={ctx} path="spec.paper.minecraftVersion" label="minecraft version" required help="A release, such as 1.21.8." />
        <TextField ctx={ctx} path="spec.paper.build" label="paper build" type="number" />

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
        <TextField ctx={ctx} path="spec.maxPlayers" label="max players" type="number" />
        <TextField ctx={ctx} path="spec.network.port" label="game port" type="number" />
        <TextField ctx={ctx} path="spec.network.hostPort" label="host port" type="number" help="Publish the game port on the host. Leave blank to keep it internal." />
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
              <TextField ctx={ctx} path="spec.network.rcon.port" label="rcon port" type="number" />
              <TextField
                ctx={ctx}
                path="spec.network.rcon.passwordSecret.name"
                label="password secret"
                required
                help="A secret name."
              />
              <TextField
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
        <TextField ctx={ctx} path="spec.resources.memory" label="container memory" required help="At least 1Gi. Example: 4Gi." />
        <TextField ctx={ctx} path="spec.resources.cpu" label="cpu" help="Example: 2500m or 2." />
        <TextField ctx={ctx} path="spec.resources.heap.max" label="jvm heap max" help="Left blank, the parser leaves headroom below the container limit so the JVM cannot be OOM-killed." />
        <TextField ctx={ctx} path="spec.resources.heap.min" label="jvm heap min" />
      </Section>

      <Section title="storage" columns={1}>
        <fieldset className="flex flex-col gap-2">
          <legend className="label mb-1">mode</legend>
          {/*
            §10 serves these as YAML *wire* values, which is why they render
            verbatim rather than title-cased: `persistent` is what goes into the
            document, and a form offering `PERSISTENT` would build one the
            parser rejects.
          */}
          {storageModes.map((mode) => (
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
                  {STORAGE_MODE_MEANING[mode] ?? 'a storage mode this build has no description for'}
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
          <TextField ctx={ctx} path="spec.storage.mountPath" label="mount path" />
          {state.storageMode === 'persistent' && (
            <>
              <TextField ctx={ctx} path="spec.storage.volume.name" label="volume name" />
              <TextField ctx={ctx} path="spec.storage.volume.size" label="volume size" />
            </>
          )}
        </div>
      </Section>

      <Section title="lifecycle" hint="how this server is allowed to stop">
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
          path="spec.lifecycle.drain.playerTransferTimeout"
          label="player transfer timeout"
          help="How long to spend moving players off before giving up."
        />
        <TextField
          ctx={ctx}
          path="spec.lifecycle.drain.saveTimeout"
          label="save timeout"
          help="How long to wait for the world save to be confirmed."
        />
        <TextField
          ctx={ctx}
          path="spec.lifecycle.stopGracePeriod"
          label="stop grace period"
          help="The last-resort net, not the save path. It must stay above the save timeout."
        />
        <TextField ctx={ctx} path="spec.lifecycle.startupTimeout" label="startup timeout" />
      </Section>

      <Section title="placement" columns={1}>
        <TextField
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

