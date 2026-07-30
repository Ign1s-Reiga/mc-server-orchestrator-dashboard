'use client';

import type { FailureStatus, ServerResource } from '@/lib/api/types';
import { absolute, age, relative } from '@/lib/display';
import { useNow } from './fleet-provider';
import { Empty, Field, Nil, Note, Panel } from './ui';

/**
 * Observed state — what the reconcile loop has actually seen.
 *
 * Everything here is `null` until something has been observed, and every
 * `null` renders as an em dash rather than as a zero or a blank. "0 players"
 * and "we have never looked" are different facts and an operator has to be
 * able to tell them apart.
 */
export function ObservedPanel({ server }: { server: ServerResource }) {
  const now = useNow();
  const status = server.status;

  if (status === null) {
    return (
      <Panel title="observed" hint="status">
        <div className="px-4 py-8 text-center">
          <p className="mono text-[13px]">nothing observed yet</p>
          <p className="text-[13px] mt-1" style={{ color: 'var(--text-dim)' }}>
            The definition is recorded. The reconcile loop has not reported on it yet — it pulls the
            image, creates the sandbox and starts the container over the next few seconds.
          </p>
        </div>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="observed"
        hint={`phase ${status.phase} · recorded ${age(status.observedAt, now)} ago`}
      >
        <div className="grid sm:grid-cols-2">
          <Field label="phase">
            {status.phase}
            <span style={{ color: 'var(--text-faint)' }}>
              {' '}
              · {status.ready ? 'joinable' : 'not joinable'}
            </span>
          </Field>
          <Field label="players online">
            {status.players === null ? (
              <Nil />
            ) : (
              <>
                {status.players.online}
                <span style={{ color: 'var(--text-faint)' }}> / {status.players.max}</span>
                <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
                  {' '}
                  seen {age(status.players.observedAt, now)} ago
                </span>
              </>
            )}
          </Field>

          <Field label="endpoint">
            {status.endpoint === null ? (
              <Nil />
            ) : (
              `${status.endpoint.address}:${status.endpoint.port}`
            )}
          </Field>
          <Field label="node">{status.endpoint?.node ?? status.runtime?.node ?? <Nil />}</Field>

          <Field label="image">
            {status.image === null ? (
              <Nil />
            ) : (
              <>
                <div className="break-all">{status.image.requested}</div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-faint)' }}>
                  {status.image.available ? 'available' : 'not available'}
                  {status.image.pulledAt !== null && ` · pulled ${age(status.image.pulledAt, now)} ago`}
                </div>
                {status.image.resolvedDigest !== null && (
                  <div className="text-[11px] break-all mt-0.5" style={{ color: 'var(--text-faint)' }}>
                    {status.image.resolvedDigest}
                  </div>
                )}
              </>
            )}
          </Field>
          <Field label="storage">
            {status.storage === null ? (
              <Nil />
            ) : (
              <>
                {status.storage.persistent ? 'persistent' : 'ephemeral'}
                {status.storage.volumeName !== null && ` · ${status.storage.volumeName}`}
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-faint)' }}>
                  {status.storage.bound ? 'bound' : 'not bound'}
                  {' · last confirmed save '}
                  {status.storage.lastSaveConfirmedAt === null
                    ? 'never'
                    : relative(status.storage.lastSaveConfirmedAt, now)}
                </div>
              </>
            )}
          </Field>

          <Field label="container">
            {status.runtime === null ? (
              <Nil />
            ) : (
              <>
                <div className="break-all text-[12px]">
                  {status.runtime.containerId ?? <Empty>no container</Empty>}
                </div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-faint)' }}>
                  sandbox {status.runtime.sandboxId}
                </div>
              </>
            )}
          </Field>
          <Field label="restarts / exit">
            {status.runtime === null ? (
              <Nil />
            ) : (
              <>
                {status.runtime.restartCount} restarts
                {status.runtime.exitCode !== null && ` · last exit ${status.runtime.exitCode}`}
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-faint)' }}>
                  {status.runtime.startedAt !== null
                    ? `started ${relative(status.runtime.startedAt, now)}`
                    : 'never started'}
                  {status.runtime.finishedAt !== null &&
                    ` · finished ${relative(status.runtime.finishedAt, now)}`}
                </div>
              </>
            )}
          </Field>

          <Field label="observed generation">
            {status.observedGeneration}
            <span style={{ color: 'var(--text-faint)' }}> of {server.metadata.generation} declared</span>
          </Field>
          <Field label="last transition">
            <span title={absolute(status.lastTransitionAt)}>{age(status.lastTransitionAt, now)} ago</span>
          </Field>
        </div>
      </Panel>

      {status.failure !== null && <FailurePanel failure={status.failure} />}
    </div>
  );
}

/**
 * A failure the loop hit. `failureClass` is the part that matters: a RETRYABLE
 * failure is the loop still working on it, a PERMANENT one is waiting for a
 * person. Saying which stops an operator either ignoring a real outage or
 * paging themselves over a transient pull error.
 */
export function FailurePanel({ failure }: { failure: FailureStatus }) {
  const now = useNow();
  const retryable = failure.failureClass === 'RETRYABLE';
  return (
    <Note tone={retryable ? 'work' : 'fault'} title={failure.reason}>
      <p>{failure.message}</p>
      <p className="mono text-[11px] mt-2" style={{ color: 'var(--text-faint)' }}>
        {failure.failureClass} · {failure.attempts} attempt{failure.attempts === 1 ? '' : 's'} · first
        seen {age(failure.occurredAt, now)} ago
      </p>
      <p className="text-[12px] mt-1.5">
        {retryable
          ? 'The reconcile loop is still retrying this on a backoff.'
          : 'The reconcile loop has stopped retrying. This needs a change to the definition or a fix on the host.'}
      </p>
    </Note>
  );
}
