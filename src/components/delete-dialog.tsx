'use client';

import { useEffect, useRef, useState } from 'react';
import { requestDelete } from '@/lib/api/client';
import { describeError, isConflict } from '@/lib/api/errors';
import type { ServerResource } from '@/lib/api/types';
import { useFleetActions } from './fleet-provider';
import { Button, Note } from './ui';

/**
 * Delete, described as what it actually is.
 *
 * `DELETE` is a drain request (§6). It answers 202, the reconcile loop
 * evacuates players and confirms a world save before anything is stopped, and
 * the name is not released until that finishes. There is no force flag and no
 * way to make it faster — so this dialog sets the expectation up front rather
 * than letting the operator discover it from a row that refuses to disappear.
 */
export function DeleteDialog({
  server,
  ifMatch,
  onClose,
}: {
  server: ServerResource;
  ifMatch?: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { merge } = useFleetActions();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const online = server.display.playersOnline;
  const confirmed = typed === server.name;

  async function confirm() {
    if (!confirmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const accepted = await requestDelete(server.name, ifMatch);
      // The 202 body carries the resource, already terminating. Folding it in
      // means the row switches to TERMINATING immediately — which is a state
      // the API has recorded, not an optimistic guess that it stopped.
      merge(accepted.server);
      onClose();
    } catch (cause) {
      setError(
        isConflict(cause)
          ? cause.conflict.explanation
          : describeError(cause),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      onCancel={onClose}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] border rounded-sm p-0 backdrop:bg-black/50"
      style={{ background: 'var(--bg-raised)', color: 'var(--text)' }}
      aria-labelledby="delete-title"
    >
      <div className="px-5 py-4 border-b">
        <h2 id="delete-title" className="mono text-[15px] font-medium">
          Delete {server.name}
        </h2>
      </div>

      <div className="px-5 py-4 flex flex-col gap-3 text-[13px]">
        <p style={{ color: 'var(--text-dim)' }}>
          This records a delete. It does not stop anything. The reconcile loop runs the drain —
          seals the server, moves players off, waits for the world save to be{' '}
          <em>confirmed</em> — and only then stops the container.
        </p>

        {online !== null && online > 0 ? (
          <Note tone="work" title={`${online} ${online === 1 ? 'player is' : 'players are'} on this server`}>
            They will be moved to another server before anything stops. The drain will not complete
            until they are off.
          </Note>
        ) : null}

        <p style={{ color: 'var(--text-dim)' }}>
          The row stays on the dashboard, showing <span className="mono">TERMINATING</span> and the
          drain&apos;s progress, until the loop confirms the containers are gone and frees the name.
          There is no way to make that faster and no way to cancel it.
        </p>

        <label className="label mt-1" htmlFor="confirm-name">
          type {server.name} to confirm
        </label>
        <input
          id="confirm-name"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="mono text-[13px] px-3 h-9 border rounded-sm"
          style={{ background: 'var(--bg-sunken)' }}
        />

        {error !== null && <Note tone="fault" title="the delete was not recorded">{error}</Note>}
      </div>

      <div className="px-5 py-3 border-t flex justify-end gap-2">
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="danger" onClick={() => void confirm()} disabled={!confirmed || busy}>
          {busy ? 'Recording…' : 'Delete and drain'}
        </Button>
      </div>
    </dialog>
  );
}
