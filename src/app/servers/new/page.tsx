'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { createServer, jsonBody } from '@/lib/api/client';
import { describeError, isConflict, isValidationFailure } from '@/lib/api/errors';
import type { Violation } from '@/lib/api/types';
import { EMPTY_FORM, toDefinitionInput, type FormState } from '@/lib/form/definition-form';
import { DefinitionForm } from '@/components/definition-form';
import { useFleetActions } from '@/components/fleet-provider';
import { LinkButton, Note } from '@/components/ui';

export default function NewServerPage() {
  const router = useRouter();
  const { merge } = useFleetActions();
  const [state, setState] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [violations, setViolations] = useState<readonly Violation[] | null>(null);
  const [conflict, setConflict] = useState<{ reason: string; explanation: string; name: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setViolations(null);
    setConflict(null);
    setError(null);
    try {
      const { server } = await createServer(
        jsonBody(toDefinitionInput(state)),
      );
      merge(server);
      // Nothing is running yet: the resource comes back with `status: null`
      // and `display.state: "PENDING"`. The detail page is where that becomes
      // visible, which is the honest place to land.
      router.push(`/servers/${encodeURIComponent(server.name)}`);
    } catch (cause) {
      if (isValidationFailure(cause)) setViolations(cause.violations);
      else if (isConflict(cause)) setConflict(cause.conflict);
      else setError(describeError(cause));
      setBusy(false);
    }
  }

  return (
    <>
      <header className="flex flex-col gap-1">
        <Link href="/" className="label w-fit">
          ← fleet
        </Link>
        <h1 className="mono text-[20px] font-semibold tracking-tight">new server</h1>
        <p className="text-[13px]" style={{ color: 'var(--text-dim)' }}>
          This writes a definition. The reconcile loop pulls the image, creates the sandbox and
          starts the container over the following seconds — the server will read{' '}
          <span className="mono">PENDING</span> until it does.
        </p>
      </header>

      <DefinitionForm
        state={state}
        onChange={(next) => {
          setState(next);
          setViolations(null);
        }}
        onSubmit={() => void submit()}
        submitLabel="Create server"
        busy={busy}
        submitViolations={violations}
        header={
          <>
            {conflict !== null && (
              <Note
                tone="fault"
                title={`that name is not available — ${conflict.reason}`}
                actions={
                  <LinkButton href={`/servers/${encodeURIComponent(conflict.name)}`}>
                    Open {conflict.name}
                  </LinkButton>
                }
              >
                {conflict.explanation}
              </Note>
            )}
            {error !== null && <Note tone="fault" title="the server was not created">{error}</Note>}
          </>
        }
        footer={<LinkButton href="/">Cancel</LinkButton>}
      />
    </>
  );
}
