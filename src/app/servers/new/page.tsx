'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { createServer, jsonBody, yamlBody } from '@/lib/api/client';
import { describeError, isConflict, isValidationFailure } from '@/lib/api/errors';
import type { Kind, ServerResource, Violation } from '@/lib/api/types';
import { EMPTY_FORM, parseLabels, toDefinitionInput, type FormState } from '@/lib/form/definition-form';
import {
  EMPTY_PROXY_FORM,
  toProxyInput,
  type ProxyFormState,
} from '@/lib/form/proxy-form';
import { backendFormFor } from '@/lib/form/backend-prefill';
import { proxiesClaiming } from '@/lib/fleet-tree';
import { DefinitionForm } from '@/components/definition-form';
import { ProxyForm } from '@/components/proxy-form';
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

/**
 * Reads the parameter, and waits for the fleet before anything stateful mounts.
 *
 * The `key` is the whole reason this split exists. `/servers/new?backendOf=x`
 * and `/servers/new` are the same route, so moving between them is a soft
 * navigation: without a key React keeps the form mounted and every piece of its
 * state survives — including a proxy's selector labels, on a page that has
 * stopped saying it is enrolling anything. Keying on the parameter makes a
 * change to it a remount, which is the only honest reading of "this is now a
 * different form".
 *
 * Waiting for `primed` here rather than inside means the form below can seed
 * itself synchronously from state that has already arrived.
 */
function NewServer() {
  const search = useSearchParams();
  const backendOf = search.get('backendOf');
  const fleet = useFleet();

  if (backendOf !== null && !fleet.primed) {
    return <Spinner label="waiting for the first snapshot" />;
  }
  return <NewServerForm key={backendOf ?? ''} backendOf={backendOf} />;
}

function NewServerForm({ backendOf }: { backendOf: string | null }) {
  const router = useRouter();
  const { merge } = useFleetActions();
  const meta = useMeta();
  const kinds: readonly Kind[] = meta?.kinds ?? FALLBACK_KINDS;

  const target = useServer(backendOf ?? '');

  /*
   * Seeded once, synchronously, at mount.
   *
   * The selector is read from the live set rather than passed through the URL,
   * so the labels are the selector as it stands now — a link kept open across
   * an edit to it would otherwise enrol the new server behind nothing. Doing it
   * in a lazy initialiser rather than an effect matters twice over: an effect
   * runs after paint, so the first frame would show empty labels and
   * `EnrolmentNotes` would announce "these labels enrol it behind nothing" —
   * `role="alert"` — before the prefill landed; and the once-only guard becomes
   * the mount itself rather than a ref that has to be reasoned about.
   *
   * After this the form is the operator's, and an arriving `updated` event
   * cannot overwrite what they have typed.
   */
  const [prefill] = useState<FormState | null>(() =>
    backendOf === null || target === undefined ? null : backendFormFor(target),
  );
  /** Whether this form was set up to enrol. A fact about the mount, not a live read. */
  const enrolling = prefill !== null;

  /*
   * Why the parameter did not produce a prefill. Also fixed at mount: derived
   * live it would start claiming "nothing has been pre-filled from a selector"
   * the moment the proxy was deleted, on a form whose labels plainly hold that
   * proxy's selector.
   */
  const [problem] = useState<string | null>(() => {
    if (backendOf === null) return null;
    if (target === undefined) return `No server named ${backendOf} is declared on this orchestrator.`;
    if (target.kind !== 'VelocityProxy') {
      return `${backendOf} is a ${target.kind}, and only a VelocityProxy enrols backends.`;
    }
    return null;
  });

  const [kind, setKind] = useState<Kind>('PaperServer');
  const [state, setState] = useState<FormState>(prefill ?? EMPTY_FORM);
  const [proxyForm, setProxyForm] = useState<ProxyFormState>(EMPTY_PROXY_FORM);
  // The document editor is the other half of the same contract, not a fallback
  // — §5 positions violations into the text as sent, which a form cannot do —
  // so it stays reachable rather than being replaced by the structured editor.
  const [proxyMode, setProxyMode] = useState<'form' | 'document'>('form');
  const [document, setDocument] = useState(PROXY_SKELETON);
  const [busy, setBusy] = useState(false);
  const [violations, setViolations] = useState<readonly Violation[] | null>(null);
  const [conflict, setConflict] = useState<{
    reason: string;
    explanation: string;
    name: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The kind picker is hidden while enrolling, so this is belt and braces
  // rather than a live control — but a rendered proxy editor with no way back
  // to PaperServer is a dead end, and one `?:` is cheaper than trusting that
  // no path can reach it.
  const effectiveKind: Kind = enrolling ? 'PaperServer' : kind;

  async function submit() {
    if (busy) return;
    setBusy(true);
    setViolations(null);
    setConflict(null);
    setError(null);
    try {
      const body =
        effectiveKind === 'PaperServer'
          ? jsonBody(toDefinitionInput(state))
          : proxyMode === 'form'
            ? jsonBody(toProxyInput(proxyForm))
            : yamlBody(document);
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
      {problem !== null && (
        <Note tone="fault" title="this form is not enrolling anything">
          {problem} The fields below are the ordinary create form, and nothing has been pre-filled
          from a selector.
        </Note>
      )}
      {enrolling && backendOf !== null && (
        <EnrolmentNotes name={backendOf} target={target} state={state} />
      )}
    </>
  );

  return (
    <>
      <header className="flex flex-col gap-1">
        {/* `backendOf`, not `target.name`: the same string, and it survives the
            proxy being deleted while this form is open. */}
        <Link
          href={enrolling && backendOf !== null ? `/servers/${encodeURIComponent(backendOf)}` : '/'}
          className="label w-fit"
        >
          ← {enrolling && backendOf !== null ? backendOf : 'fleet'}
        </Link>
        <h1 className="mono text-[20px] font-semibold tracking-tight">
          {enrolling ? 'new backend' : 'new'}
        </h1>
        <p className="text-[13px]" style={{ color: 'var(--text-dim)' }}>
          {enrolling ? (
            <>
              A Minecraft server carrying <span className="mono">{backendOf}</span>&apos;s selector
              labels, so the reconcile loop enrols it behind that proxy on its next pass. Everything
              else is yours to fill in.
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

      {effectiveKind === 'PaperServer' ? (
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
            <LinkButton
              href={
                enrolling && backendOf !== null ? `/servers/${encodeURIComponent(backendOf)}` : '/'
              }
            >
              Cancel
            </LinkButton>
          }
        />
      ) : proxyMode === 'form' ? (
        <ProxyForm
          state={proxyForm}
          onChange={(next) => {
            setProxyForm(next);
            setViolations(null);
          }}
          onSubmit={() => void submit()}
          submitLabel="Create proxy"
          busy={busy}
          submitViolations={violations}
          header={header}
          footer={<LinkButton href="/">Cancel</LinkButton>}
          onSwitchToDocument={() => {
            // Seeded from the form so nothing typed is lost. The reverse is not
            // offered as a conversion: reading YAML back would mean a second
            // parser in this app disagreeing with the one that decides.
            setDocument(JSON.stringify(toProxyInput(proxyForm), null, 2));
            setProxyMode('document');
            setViolations(null);
          }}
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
          footer={
            <>
              <LinkButton href="/">Cancel</LinkButton>
              <Button
                onClick={() => {
                  setProxyMode('form');
                  setViolations(null);
                }}
                variant="ghost"
                title="the form is restored as it was — edits made to this document are not read back"
              >
                Back to the form
              </Button>
            </>
          }
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
function EnrolmentNotes({
  name,
  target,
  state,
}: {
  name: string;
  /** Live, so this notices the proxy going away underneath the form. */
  target: ServerResource | undefined;
  state: FormState;
}) {
  const fleet = useFleet();
  const claiming = useMemo(() => {
    const proxies = [...fleet.servers.values()].filter((s) => s.kind === 'VelocityProxy');
    return proxiesClaiming(parseLabels(state.labels), proxies);
  }, [fleet.servers, state.labels]);

  const hostPort = state.values['spec.network.hostPort'].trim();

  return (
    <>
      {target === undefined ? (
        // Gone since this form opened. The labels below are still that proxy's
        // selector, so saying "nothing was pre-filled" here would be a lie —
        // and the labels may now match nothing at all.
        <Note tone="fault" title={`${name} no longer exists`}>
          The proxy this form was opened from has been deleted and its name released. The labels
          below still carry the selector it had.
        </Note>
      ) : (
        target.metadata.terminating && (
          // The same reason the detail page withholds the button: the name is
          // held until the drain finishes and then released, so anything
          // declared against this selector now is claimed by nothing shortly
          // after it is created.
          <Note tone="work" title={`${name} is being deleted`}>
            Its name is held until the drain finishes and is then released. A server declared
            against its selector now would be enrolled by a proxy that is on its way out, and left
            behind nothing the moment it goes.
          </Note>
        )
      )}

      {claiming.length === 0 ? (
        <Note tone="fault" title="these labels enrol it behind nothing">
          Nothing in the fleet has a backend selector these labels satisfy, so this server would be
          created standalone — running, reachable from nowhere, and invisible to{' '}
          <span className="mono">{name}</span>. Restore the selector labels, or create it from the
          fleet page if standalone is what you meant.
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
      ) : claiming[0] !== name ? (
        <Note tone="work" title={`these labels enrol it behind ${claiming[0]}`}>
          Not <span className="mono">{name}</span>. That is a legitimate thing to want — the
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
