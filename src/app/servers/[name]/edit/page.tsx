'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getServer, jsonBody, replaceServer } from '@/lib/api/client';
import { describeError, isConflict, isNotFound, isValidationFailure } from '@/lib/api/errors';
import type { ConflictDetail, ServerResource, Violation } from '@/lib/api/types';
import {
  FIELD_PATHS,
  fromDefinition,
  toDefinitionInput,
  type FormState,
} from '@/lib/form/definition-form';
import { DefinitionForm } from '@/components/definition-form';
import { useFleetActions, useServer } from '@/components/fleet-provider';
import { Button, LinkButton, Note, Panel, Spinner } from '@/components/ui';
import { relative } from '@/lib/display';

export default function EditServerPage() {
  const params = useParams<{ name: string }>();
  const name = decodeURIComponent(params.name);
  const router = useRouter();
  const { merge } = useFleetActions();
  const live = useServer(name);

  const [loaded, setLoaded] = useState<{ form: FormState; etag: string } | null>(null);
  const [state, setState] = useState<FormState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [violations, setViolations] = useState<readonly Violation[] | null>(null);
  const [conflict, setConflict] = useState<{ detail: ConflictDetail; stored: ServerResource | null } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  /*
   * §14's edit flow starts with a read: GET, edit, PUT with `If-Match`.
   * The stream already carries a current copy, but the read is still done here
   * so the `ETag` sent back is one the API handed over on this exact document.
   */
  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const { server, etag } = await getServer(name, signal);
        if (signal?.aborted === true) return;
        const form = fromDefinition(server.definition);
        setLoaded({ form, etag });
        setState(form);
        setLoadError(null);
      } catch (cause) {
        if (signal?.aborted === true) return;
        setLoadError(isNotFound(cause) ? 'No server by this name is declared.' : describeError(cause));
      }
    },
    [name],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const dirty = useMemo(() => {
    if (loaded === null || state === null) return [];
    return changedPaths(loaded.form, state);
  }, [loaded, state]);

  async function submit() {
    if (busy || state === null || loaded === null) return;
    setBusy(true);
    setViolations(null);
    setConflict(null);
    setError(null);
    try {
      const { server } = await replaceServer(
        name,
        jsonBody(toDefinitionInput(state)),
        loaded.etag,
      );
      merge(server);
      router.push(`/servers/${encodeURIComponent(name)}`);
    } catch (cause) {
      if (isValidationFailure(cause)) {
        setViolations(cause.violations);
      } else if (isConflict(cause)) {
        // Re-read immediately so the recovery loop from §4 — re-read, re-apply,
        // write again with the new ETag — has something concrete to offer
        // rather than just a message saying it happened.
        const detail = cause.conflict;
        try {
          const { server, etag } = await getServer(name);
          setConflict({ detail, stored: server });
          setLoaded({ form: fromDefinition(server.definition), etag });
        } catch {
          setConflict({ detail, stored: null });
        }
      } else {
        setError(describeError(cause));
      }
      setBusy(false);
    }
  }

  if (loadError !== null) {
    return (
      <Panel>
        <div className="px-4 py-10 text-center">
          <p className="text-[13px]" style={{ color: 'var(--text-dim)' }}>
            {loadError}
          </p>
          <div className="mt-4">
            <LinkButton href="/">Back to fleet</LinkButton>
          </div>
        </div>
      </Panel>
    );
  }

  if (state === null || loaded === null) return <Spinner label={`reading ${name}`} />;

  const terminating = live?.metadata.terminating ?? false;
  const online = live?.display.playersOnline ?? null;

  return (
    <>
      <header className="flex flex-col gap-1">
        <Link href={`/servers/${encodeURIComponent(name)}`} className="label w-fit">
          ← {name}
        </Link>
        <h1 className="mono text-[20px] font-semibold tracking-tight">edit {name}</h1>
        <p className="text-[13px]" style={{ color: 'var(--text-dim)' }}>
          Editing the spec is how a server is replaced. There is no restart endpoint — a restart is
          a drain plus a recreate, and the only honest way to ask for one is to change the spec and
          let the loop converge on it.
        </p>
      </header>

      <DefinitionForm
        state={state}
        onChange={(next) => {
          setState(next);
          setViolations(null);
        }}
        onSubmit={() => void submit()}
        submitLabel="Save spec"
        busy={busy || terminating}
        nameLocked
        submitViolations={violations}
        header={
          <>
            {terminating && (
              <Note tone="work" title="this server is being deleted">
                A delete is in flight for this name, so the API will refuse a write with a{' '}
                <span className="mono">409 TERMINATING</span>. Nothing can be edited until the drain
                finishes and the name is released.
              </Note>
            )}

            {conflict !== null && (
              <ConflictPanel
                detail={conflict.detail}
                stored={conflict.stored}
                onTakeTheirs={() => {
                  if (conflict.stored === null) return;
                  setState(fromDefinition(conflict.stored.definition));
                  setConflict(null);
                }}
                onKeepMine={() => setConflict(null)}
              />
            )}

            {error !== null && <Note tone="fault" title="the spec was not saved">{error}</Note>}

            {dirty.length > 0 && !terminating && (
              <Note tone="work" title="saving this drains the server and replaces it">
                <p>
                  A spec change moves the generation, so the reconcile loop drains this server —
                  evacuating players and confirming a world save — before starting the replacement.
                  {online !== null && online > 0 && (
                    <>
                      {' '}
                      <strong>
                        {online} {online === 1 ? 'player is' : 'players are'} on it right now.
                      </strong>
                    </>
                  )}
                </p>
                <p className="mt-2">
                  Changing{' '}
                  {dirty.map((path, index) => (
                    <span key={path}>
                      {index > 0 && ', '}
                      <span className="mono" style={{ color: 'var(--text)' }}>
                        {path}
                      </span>
                    </span>
                  ))}
                  .
                </p>
              </Note>
            )}
          </>
        }
        footer={
          <>
            <LinkButton href={`/servers/${encodeURIComponent(name)}`}>Cancel</LinkButton>
            <span className="mono text-[11px]" style={{ color: 'var(--text-faint)' }}>
              If-Match {loaded.etag}
            </span>
          </>
        }
      />
    </>
  );
}

/**
 * The 409 recovery from §4, as two named choices.
 *
 * "Somebody got there first" is not a generic error: the stored definition has
 * moved, this form is holding an edit against the old one, and both are worth
 * something. Discarding either silently would be the wrong call, so the page
 * says exactly what changed underneath and makes the operator pick.
 */
function ConflictPanel({
  detail,
  stored,
  onTakeTheirs,
  onKeepMine,
}: {
  detail: ConflictDetail;
  stored: ServerResource | null;
  onTakeTheirs: () => void;
  onKeepMine: () => void;
}) {
  if (detail.reason !== 'VERSION_MISMATCH') {
    return (
      <Note tone="fault" title={`the write was refused — ${detail.reason}`}>
        {detail.explanation}
      </Note>
    );
  }

  return (
    <Note
      tone="fault"
      title="someone else changed this server while you were editing"
      actions={
        <>
          <Button onClick={onTakeTheirs} disabled={stored === null}>
            Load the stored spec
          </Button>
          <Button variant="danger" onClick={onKeepMine}>
            Keep my edits and overwrite
          </Button>
        </>
      }
    >
      <p>{detail.explanation}</p>
      {stored !== null && (
        <p className="mt-2 text-[12px]">
          The stored definition is now at{' '}
          <span className="mono">rv {detail.currentResourceVersion ?? stored.metadata.resourceVersion}</span>
          , written {relative(stored.metadata.updatedAt)}. This form has been re-armed with that
          version, so <em>Keep my edits and overwrite</em> will now succeed — and will discard
          whatever the other change was.
        </p>
      )}
    </Note>
  );
}

/** Which fields this form has moved away from what was loaded. */
function changedPaths(before: FormState, after: FormState): string[] {
  const changed: string[] = [];
  for (const path of FIELD_PATHS) {
    if (before.values[path].trim() !== after.values[path].trim()) changed.push(path);
  }
  if (before.eulaAccepted !== after.eulaAccepted) changed.push('spec.eulaAccepted');
  if (before.rconEnabled !== after.rconEnabled) changed.push('spec.network.rcon');
  if (before.storageMode !== after.storageMode) changed.push('spec.storage.mode');
  if (before.labels.trim() !== after.labels.trim()) changed.push('metadata.labels');
  return changed;
}
