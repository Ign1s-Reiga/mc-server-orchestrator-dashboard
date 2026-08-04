'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { createServer, jsonBody, yamlBody } from '@/lib/api/client';
import { describeError, isConflict, isValidationFailure } from '@/lib/api/errors';
import type { Kind, Violation } from '@/lib/api/types';
import { EMPTY_FORM, toDefinitionInput, type FormState } from '@/lib/form/definition-form';
import { DefinitionForm } from '@/components/definition-form';
import { DocumentEditor } from '@/components/document-editor';
import { useFleetActions } from '@/components/fleet-provider';
import { FALLBACK_KINDS, useMeta } from '@/components/meta-provider';
import { Button, LinkButton, Note, Panel, cx } from '@/components/ui';

/**
 * A starting document for a proxy.
 *
 * Only the fields §14 marks required, so the operator sees what the parser
 * fills in rather than a wall of defaults they did not choose — `/validate`
 * shows the effective definition alongside. The forwarding secret is a
 * coordinate, and has to exist in the secret store before this will run.
 */
const PROXY_SKELETON = `apiVersion: mcorch.dev/v1alpha1
kind: VelocityProxy
metadata:
  name: lobby-proxy
spec:
  image: docker.io/itzg/mc-proxy:2026.6.1
  resources:
    memory: 1Gi
  forwarding:
    # Coordinates only. Put the value in the secret store first;
    # it never appears in a definition.
    secret:
      name: velocity-forwarding
      key: secret
  backends:
    # Servers carrying every one of these labels are enrolled.
    # An empty selector would enrol the whole fleet, so it is rejected.
    selector:
      matchLabels:
        tier: survival
`;

const KIND_BLURB: Record<string, string> = {
  PaperServer: 'A Minecraft server. Holds a world, so it gets a persistent volume by default.',
  VelocityProxy:
    'A front door that routes players to servers matching a label selector. Holds no world, and cannot be given storage.',
};

export default function NewServerPage() {
  const router = useRouter();
  const { merge } = useFleetActions();
  const meta = useMeta();
  const kinds: readonly Kind[] = meta?.kinds ?? FALLBACK_KINDS;

  const [kind, setKind] = useState<Kind>('PaperServer');
  const [state, setState] = useState<FormState>(EMPTY_FORM);
  const [document, setDocument] = useState(PROXY_SKELETON);
  const [busy, setBusy] = useState(false);
  const [violations, setViolations] = useState<readonly Violation[] | null>(null);
  const [conflict, setConflict] = useState<{
    reason: string;
    explanation: string;
    name: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setViolations(null);
    setConflict(null);
    setError(null);
    try {
      const body =
        kind === 'PaperServer' ? jsonBody(toDefinitionInput(state)) : yamlBody(document);
      const { server } = await createServer(body);
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

  const header = (
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
      {error !== null && (
        <Note tone="fault" title="the server was not created">
          {error}
        </Note>
      )}
    </>
  );

  return (
    <>
      <header className="flex flex-col gap-1">
        <Link href="/" className="label w-fit">
          ← fleet
        </Link>
        <h1 className="mono text-[20px] font-semibold tracking-tight">new</h1>
        <p className="text-[13px]" style={{ color: 'var(--text-dim)' }}>
          This writes a definition. The reconcile loop pulls the image, creates the sandbox and
          starts the container over the following seconds — it will read{' '}
          <span className="mono">PENDING</span> until it does.
        </p>
      </header>

      {/* The kind list is served by /meta, so a kind added to the orchestrator
          appears here with no frontend release. */}
      <Panel title="kind">
        <div className="p-4 flex flex-col sm:flex-row gap-3">
          {kinds.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={kind === option}
              onClick={() => {
                setKind(option);
                setViolations(null);
                setConflict(null);
              }}
              className={cx(
                'flex-1 text-left px-3 py-2.5 border rounded-sm cursor-pointer transition-colors',
              )}
              style={{
                background: kind === option ? 'var(--bg-sunken)' : 'transparent',
                borderColor: kind === option ? 'var(--accent)' : 'var(--line)',
              }}
            >
              <span className="mono text-[13px]">{option}</span>
              <span className="block text-[11px] mt-0.5" style={{ color: 'var(--text-faint)' }}>
                {KIND_BLURB[option] ?? 'a kind this build has no description for'}
              </span>
            </button>
          ))}
        </div>
      </Panel>

      {kind === 'PaperServer' ? (
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
          header={header}
          footer={<LinkButton href="/">Cancel</LinkButton>}
        />
      ) : (
        <DocumentEditor
          value={document}
          onChange={(next) => {
            setDocument(next);
            setViolations(null);
          }}
          onSubmit={() => void submit()}
          submitLabel="Create proxy"
          busy={busy}
          submitViolations={violations}
          header={
            <>
              {header}
              <Note tone="work" title="the forwarding secret has to exist first">
                A proxy refers to its modern-forwarding secret by name and key. Store the value
                under <Link href="/secrets" className="mono underline">secrets</Link> before
                creating this, or the reconcile loop will not be able to start it.
              </Note>
            </>
          }
          footer={<LinkButton href="/">Cancel</LinkButton>}
        />
      )}
    </>
  );
}
