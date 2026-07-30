'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useFleet, useServer } from '@/components/fleet-provider';
import { AttentionFlag, GenerationGauge, StateBadge } from '@/components/state-badge';
import { DrainRibbon } from '@/components/drain-ribbon';
import { DeclaredPanel } from '@/components/declared-panel';
import { ObservedPanel } from '@/components/observed-panel';
import { ConditionsTable } from '@/components/conditions-table';
import { DeleteDialog } from '@/components/delete-dialog';
import { FreshnessLine } from '@/components/connection-status';
import { Button, LinkButton, Note, Panel, Spinner } from '@/components/ui';
import { stateMeaning } from '@/lib/display';

export default function ServerDetailPage() {
  const params = useParams<{ name: string }>();
  const name = decodeURIComponent(params.name);
  const fleet = useFleet();
  const server = useServer(name);
  const [deleting, setDeleting] = useState(false);

  // Remembering that this server was once here is what lets the page tell
  // "the drain finished and `:core` freed the name" apart from "this name was
  // never declared". Both are a missing row; only one of them is news.
  const wasPresent = useRef(false);
  useEffect(() => {
    if (server !== undefined) wasPresent.current = true;
  }, [server]);

  if (server === undefined) {
    if (!fleet.primed) return <Spinner label="waiting for the first snapshot" />;
    return <Gone name={name} released={wasPresent.current} />;
  }

  const etag = `"${server.metadata.resourceVersion}"`;
  const terminating = server.metadata.terminating;

  return (
    <>
      <header className="flex flex-col gap-3">
        <Link href="/" className="label w-fit">
          ← fleet
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <h1 className="mono text-[22px] font-semibold tracking-tight">{server.name}</h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <StateBadge state={server.display.state} size="lg" />
              {server.display.needsAttention && <AttentionFlag />}
              <span className="mono text-[11px]" style={{ color: 'var(--text-faint)' }}>
                {server.kind}
              </span>
              <GenerationGauge server={server} />
              <span className="mono text-[11px]" style={{ color: 'var(--text-faint)' }}>
                rv {server.metadata.resourceVersion}
              </span>
              <FreshnessLine />
            </div>
            <p className="text-[13px]" style={{ color: 'var(--text-dim)' }}>
              {server.display.detail.length > 0
                ? server.display.detail
                : stateMeaning(server.display.state)}
            </p>
          </div>

          <div className="flex gap-2">
            <LinkButton href={`/servers/${encodeURIComponent(server.name)}/edit`}>
              Edit spec
            </LinkButton>
            <Button variant="danger" onClick={() => setDeleting(true)} disabled={terminating}>
              {terminating ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </div>
      </header>

      {/*
        There is no stop, kill, force or restart control anywhere on this page,
        because there is no such endpoint and there will not be one: an endpoint
        that could stop a container is one that could stop a container with
        players on it. Deleting is the drain trigger; editing the spec is the
        replace trigger. Adding a button that implied otherwise would be
        promising something the system deliberately cannot do.
      */}

      {terminating && (
        <Note tone="work" title="the name is held until the drain finishes">
          A delete has been recorded for this server. It keeps its row and keeps answering{' '}
          <span className="mono">GET</span> until <span className="mono">:core</span> confirms the
          containers are gone. Nothing here can make that faster, and there is no way to cancel it.
        </Note>
      )}

      <DrainRibbon server={server} />

      <div className="grid lg:grid-cols-2 gap-4 items-start">
        <DeclaredPanel definition={server.definition} />
        <ObservedPanel server={server} />
      </div>

      {server.status !== null && (
        <Panel
          title="conditions"
          hint="how long each has held is usually the more useful half"
        >
          <ConditionsTable status={server.status} />
        </Panel>
      )}

      <footer className="flex flex-wrap gap-x-6 gap-y-1 text-[11px] mono" style={{ color: 'var(--text-faint)' }}>
        <span>created {server.metadata.createdAt}</span>
        <span>updated {server.metadata.updatedAt}</span>
        {server.metadata.deletedAt !== null && <span>deleted {server.metadata.deletedAt}</span>}
        {server.statusMeta !== null && <span>status rv {server.statusMeta.resourceVersion}</span>}
      </footer>

      {deleting && (
        <DeleteDialog server={server} ifMatch={etag} onClose={() => setDeleting(false)} />
      )}
    </>
  );
}

function Gone({ name, released }: { name: string; released: boolean }) {
  return (
    <>
      <Link href="/" className="label w-fit">
        ← fleet
      </Link>
      <Panel>
        <div className="px-4 py-12 text-center">
          <h1 className="mono text-[16px]">{name}</h1>
          {released ? (
            <p className="text-[13px] mt-2 max-w-md mx-auto" style={{ color: 'var(--text-dim)' }}>
              The drain finished. <span className="mono">:core</span> confirmed the containers were
              gone and released the name, so the server no longer exists and the name is free to
              reuse.
            </p>
          ) : (
            <p className="text-[13px] mt-2" style={{ color: 'var(--text-dim)' }}>
              No server by this name is declared on this orchestrator.
            </p>
          )}
          <div className="mt-4">
            <LinkButton href="/">Back to fleet</LinkButton>
          </div>
        </div>
      </Panel>
    </>
  );
}
