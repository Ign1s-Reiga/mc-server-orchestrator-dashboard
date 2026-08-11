'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createServer, jsonBody, yamlBody } from '@/lib/api/client';
import { describeError, isConflict, isValidationFailure } from '@/lib/api/errors';
import type { Kind, ServerResource, Violation } from '@/lib/api/types';
import { EMPTY_FORM, parseLabels, toDefinitionInput, type FormState } from '@/lib/form/definition-form';
import { backendFormFor } from '@/lib/form/backend-prefill';
import { proxiesClaiming } from '@/lib/fleet-tree';
import { DefinitionForm } from '@/components/definition-form';
import { DocumentEditor } from '@/components/document-editor';
import { useFleet, useFleetActions, useServer } from '@/components/fleet-provider';
import { FALLBACK_KINDS, useMeta } from '@/components/meta-provider';
import { Button, LinkButton, Note, Panel, Spinner, cx } from '@/components/ui';

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
  // `useSearchParams` opts this route out of static prerendering unless the
  // read is behind a boundary. The fallback is momentary — the real wait is
  // for the fleet, which `NewServer` handles itself.
  return (
    <Suspense fallback={<Spinner label="loading" />}>
      <NewServer />
    </Suspense>
  );
}

function NewServer() {
  const router = useRouter();
  const { merge } = useFleetActions();
  const meta = useMeta();
  const kinds: readonly Kind[] = meta?.kinds ?? FALLBACK_KINDS;

  const search = useSearchParams();
  const backendOf = search.get('backendOf');
  const fleet = useFleet();
  const target = useServer(backendOf ?? '');

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

  /*
   * Seed from the proxy once, when the fleet has it.
   *
   * The definition is read from the live set rather than passed through the
   * URL, so the labels are the selector as it stands now — a link kept open
   * across an edit to that selector would otherwise enrol the new server behind
   * nothing. Seeding is once-only: after that the form is the operator's, and
   * an arriving `updated` event must not overwrite what they have typed.
   */
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || target === undefined) return;
    const prefilled = backendFormFor(target);
    if (prefilled === null) return;
    seeded.current = true;
    setState(prefilled);
  }, [target]);

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

  // `backendOf` named something, and the fleet has settled enough to say
  // whether it is a proxy. Anything else falls back to the ordinary form with
  // the reason on screen — silently ignoring the parameter would leave an
  // operator who clicked "Add backend" filling in a form that enrols nothing.
  const enrolling = backendOf !== null && target !== undefined && target.kind === 'VelocityProxy';
  const backendProblem =
    backendOf === null || enrolling
      ? null
      : target === undefined
        ? `No server named ${backendOf} is declared on this orchestrator.`
        : `${backendOf} is a ${target.kind}, and only a VelocityProxy enrols backends.`;

  if (backendOf !== null && !fleet.primed) {
    return <Spinner label="waiting for the first snapshot" />;
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
      {backendProblem !== null && (
        <Note tone="fault" title="this form is not enrolling anything">
          {backendProblem} The fields below are the ordinary create form, and nothing has been
          pre-filled from a selector.
        </Note>
      )}
      {enrolling && kind === 'PaperServer' && <EnrolmentNotes proxy={target} state={state} />}
    </>
  );

  return (
    <>
      <header className="flex flex-col gap-1">
        <Link href={enrolling ? `/servers/${encodeURIComponent(target.name)}` : '/'} className="label w-fit">
          ← {enrolling ? target.name : 'fleet'}
        </Link>
        <h1 className="mono text-[20px] font-semibold tracking-tight">
          {enrolling ? 'new backend' : 'new'}
        </h1>
        <p className="text-[13px]" style={{ color: 'var(--text-dim)' }}>
          {enrolling ? (
            <>
              A Minecraft server carrying <span className="mono">{target.name}</span>&apos;s
              selector labels, so the reconcile loop enrols it behind that proxy on its next pass.
              Everything else is yours to fill in.
            </>
          ) : (
            <>
              This writes a definition. The reconcile loop pulls the image, creates the sandbox and
              starts the container over the following seconds — it will read{' '}
              <span className="mono">PENDING</span> until it does.
            </>
          )}
        </p>
      </header>

      {enrolling ? (
        // No kind picker: a proxy is never a backend — `resolve` narrows to
        // `PaperServerDefinition` before it matches a label — so there is no
        // second option here that would mean anything.
        <p className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
          <span className="mono">PaperServer</span>. A proxy cannot stand behind another proxy.{' '}
          <Link href="/servers/new" className="underline">
            Create something else instead
          </Link>
          .
        </p>
      ) : (
        /* The kind list is served by /meta, so a kind added to the orchestrator
           appears here with no frontend release. */
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
      )}

      {kind === 'PaperServer' ? (
        <DefinitionForm
          state={state}
          onChange={(next) => {
            setState(next);
            setViolations(null);
          }}
          onSubmit={() => void submit()}
          submitLabel={enrolling ? 'Create backend' : 'Create server'}
          busy={busy}
          submitViolations={violations}
          header={header}
          footer={
            <LinkButton href={enrolling ? `/servers/${encodeURIComponent(target.name)}` : '/'}>
              Cancel
            </LinkButton>
          }
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

/**
 * What the labels in the form actually mean, checked against the live fleet as
 * they are typed.
 *
 * The labels are editable like any other field, so "this will be enrolled by
 * `lobby`" is a claim that stops being true the moment one is changed. Every
 * case below is one the reconcile loop resolves silently and unhelpfully: a
 * server that matches nothing simply never appears behind a proxy, and one that
 * matches two is refused a container with only a `FORWARDING_SECRET_UNAVAILABLE`
 * on its status to say why. Both are cheaper to say here.
 */
function EnrolmentNotes({ proxy, state }: { proxy: ServerResource; state: FormState }) {
  const fleet = useFleet();
  const claiming = useMemo(() => {
    const proxies = [...fleet.servers.values()].filter((s) => s.kind === 'VelocityProxy');
    return proxiesClaiming(parseLabels(state.labels), proxies);
  }, [fleet.servers, state.labels]);

  const hostPort = state.values['spec.network.hostPort'].trim();

  return (
    <>
      {claiming.length === 0 ? (
        <Note tone="fault" title="these labels enrol it behind nothing">
          Nothing in the fleet has a backend selector these labels satisfy, so this server would be
          created standalone — running, reachable from nowhere, and invisible to{' '}
          <span className="mono">{proxy.name}</span>. Restore the selector labels, or create it from
          the fleet page if standalone is what you meant.
        </Note>
      ) : claiming.length > 1 ? (
        <Note tone="fault" title="these labels are claimed by more than one proxy">
          They satisfy the selector of{' '}
          {claiming.map((name, index) => (
            <span key={name}>
              {index > 0 && ', '}
              <span className="mono">{name}</span>
            </span>
          ))}
          . A backend belongs to one proxy, so the reconcile loop would refuse to create this
          container at all until one of those selectors stops matching it.
        </Note>
      ) : claiming[0] !== proxy.name ? (
        <Note tone="work" title={`these labels enrol it behind ${claiming[0]}`}>
          Not <span className="mono">{proxy.name}</span>. That is a legitimate thing to want — the
          labels are yours to change — but it is not what this form set out to do.
        </Note>
      ) : null}

      {hostPort.length > 0 && (
        // The orchestrator's own troubleshooting notes name this: backends are
        // meant to stay unpublished, and publishing one bypasses the mechanism
        // that makes a drain safe.
        <Note tone="work" title="a backend does not usually need a host port">
          The proxy is the front door and carries the port players type. Publishing{' '}
          <span className="mono">{hostPort}</span> on the host lets players reach this server
          directly, around the proxy — which is around the seal that stops new logins during a
          drain. Leave it blank unless you are deliberately exposing this server.
        </Note>
      )}
    </>
  );
}
