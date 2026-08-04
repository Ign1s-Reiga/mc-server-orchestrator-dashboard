'use client';

import type { FailureStatus, ServerResource, VelocityProxyStatus } from '@/lib/api/types';
import { absolute, age, relative } from '@/lib/display';
import { useNow } from './fleet-provider';
import { Empty, Field, Nil, Note, Panel } from './ui';
import { BackendsPanel, ControlEndpointField } from './proxy-panels';

/**
 * Observed state — what the reconcile loop has actually seen.
 *
 * Everything here is `null` until something has been observed, and every
 * `null` renders as an em dash rather than as a zero or a blank. "0 players"
 * and "we have never looked" are different facts and an operator has to be
 * able to tell them apart.
 *
 * `status` is a union tagged by `kind`. The common half is rendered once; the
 * kind-specific half is `storage` for a Paper server and `backends`/`control`
 * for a proxy.
 */
export function ObservedPanel({ server }: { server: ServerResource }) {
  const now = useNow();
  const status = server.status;

  if (status === null) {
    // §6: `status: null` has two meanings and they call for opposite things
    // from an operator — one you wait out, one you fix. `neverObserved` is the
    // discriminator; testing `status === null` alone keeps working and keeps
    // being wrong in the second case.
    if (server.unreadable !== null) {
      return (
        <Panel title="observed" hint="the stored observation will not decode">
          <div className="p-4">
            <Note tone="fault" title={`unreadable ${server.unreadable.part.toLowerCase()} state`}>
              <p>{server.unreadable.reason}</p>
              <p className="mt-2">
                This is a fact about the record, not about the container. The workload is most
                likely running exactly as it was — what needs repairing is the stored row, in the
                store. The reconcile loop reads the same bytes on every pass, so it cannot move this
                server on its own
                {!server.unreadable.retryable && ' and re-reading will not help'}.
              </p>
            </Note>
          </div>
        </Panel>
      );
    }
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
          {/*
            The kind-specific slot. A proxy has no `storage` at all — not a null
            one — so this branches on the discriminant rather than reaching for
            a field that does not exist on the union.
          */}
          {status.kind === 'VelocityProxy' ? (
            <ControlEndpointField control={status.control} />
          ) : (
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
          )}

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

      {status.kind === 'VelocityProxy' && <BackendsPanel status={status} />}

      {status.failure !== null && <FailurePanel failure={status.failure} />}
    </div>
  );
}

/** Narrowing helper, so callers can ask for the proxy view without a cast. */
export function asProxyStatus(server: ServerResource): VelocityProxyStatus | null {
  return server.status !== null && server.status.kind === 'VelocityProxy' ? server.status : null;
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
