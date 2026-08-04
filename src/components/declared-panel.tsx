'use client';

import { useState } from 'react';
import type {
  Definition,
  PaperServerDefinition,
  VelocityProxyDefinition,
} from '@/lib/api/types';
import { Button, Empty, Field, Nil, Panel } from './ui';

/**
 * Declared state — the definition exactly as the API would take it back.
 *
 * Three things worth knowing while reading this (§6):
 *
 * - `definition` is a **union tagged by `kind`**. A `VelocityProxy` has no
 *   `storage`, no `paper` and no `eulaAccepted`, and its absence is structural
 *   rather than an omission to default: a proxy holds no world, and one that
 *   claimed to would become a container the orchestrator could never stop,
 *   because it has no save to confirm.
 * - `definition` *omits* absent optional fields rather than nulling them, so
 *   that what `GET` returns is valid input to `POST`/`PUT` unchanged. So this
 *   reads `spec.network.rcon ?? { enabled: false }` rather than checking for
 *   null.
 * - `definition.spec` is the *effective* spec: every default has already been
 *   resolved by the parser. A four-field `minimal.yaml` comes back with all of
 *   them, so what is shown here is what the reconciler acts on, not what the
 *   operator typed.
 */
export function DeclaredPanel({ definition }: { definition: Definition }) {
  return (
    <div className="flex flex-col gap-4">
      {definition.kind === 'VelocityProxy' ? (
        <ProxySpecPanel definition={definition} />
      ) : (
        <PaperSpecPanel definition={definition} />
      )}
      <RawDefinition definition={definition} />
    </div>
  );
}

function LabelsField({ labels }: { labels: Record<string, string> }) {
  return (
    <Field label="labels">
      {Object.keys(labels).length === 0 ? (
        <Nil />
      ) : (
        Object.entries(labels).map(([key, value]) => (
          <div key={key}>
            {key}={value}
          </div>
        ))
      )}
    </Field>
  );
}

function PaperSpecPanel({ definition }: { definition: PaperServerDefinition }) {
  const { spec } = definition;
  const labels = definition.metadata.labels ?? {};
  const rcon = spec.network.rcon ?? { enabled: false as const };

  return (
    <Panel title="declared" hint="PaperServer — the effective spec, every default resolved">
      <div className="grid sm:grid-cols-2">
        <Field label="image" span>
          <span className="break-all">{spec.image}</span>
        </Field>

        <Field label="paper">
            {spec.paper.minecraftVersion}
            {spec.paper.build !== undefined && (
              <span style={{ color: 'var(--text-faint)' }}> · build {spec.paper.build}</span>
            )}
          </Field>
          <Field label="max players">{spec.maxPlayers}</Field>

          <Field label="network">
            port {spec.network.port}
            {spec.network.hostPort !== undefined && (
              <span style={{ color: 'var(--text-faint)' }}> · host {spec.network.hostPort}</span>
            )}
          </Field>
          <Field label="rcon">
            {!rcon.enabled ? (
              <Empty>disabled</Empty>
            ) : (
              <>
                port {rcon.port}
                {/*
                  Coordinates, not a value. There is no endpoint that resolves
                  them and this dashboard offers no affordance implying there
                  might be.
                */}
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-faint)' }}>
                  password from secret {rcon.passwordSecret.name}/{rcon.passwordSecret.key}
                </div>
              </>
            )}
          </Field>

          <Field label="memory / cpu">
            {spec.resources.memory}
            <span style={{ color: 'var(--text-faint)' }}>
              {' '}
              · cpu {spec.resources.cpu ?? 'unlimited'}
            </span>
          </Field>
          <Field label="jvm heap">
            {spec.resources.heap.min} → {spec.resources.heap.max}
          </Field>

          <Field label="storage" span>
            <span
              style={{ color: spec.storage.mode === 'persistent' ? 'var(--ok)' : 'var(--work)' }}
            >
              {spec.storage.mode}
            </span>
            <span style={{ color: 'var(--text-faint)' }}> at {spec.storage.mountPath}</span>
            {spec.storage.mode === 'persistent' ? (
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-faint)' }}>
                volume {spec.storage.volume.name}
                {spec.storage.volume.size !== undefined && ` · ${spec.storage.volume.size}`}
              </div>
            ) : (
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--work)' }}>
                World data does not outlive the container.
              </div>
            )}
          </Field>

          <Field label="drain">
            {spec.lifecycle.drain.policy}
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-faint)' }}>
              transfer within {spec.lifecycle.drain.playerTransferTimeout} · save within{' '}
              {spec.lifecycle.drain.saveTimeout}
            </div>
          </Field>
          <Field label="stop grace / startup">
            {spec.lifecycle.stopGracePeriod}
            <span style={{ color: 'var(--text-faint)' }}> · start {spec.lifecycle.startupTimeout}</span>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-faint)' }}>
              The grace period is the last-resort net, not the save path.
            </div>
          </Field>

          <Field label="placement">
            {spec.placement?.node ?? <Empty>scheduler chooses</Empty>}
          </Field>
          <LabelsField labels={labels} />
        </div>
    </Panel>
  );
}

/**
 * A proxy's declared spec.
 *
 * Deliberately not the Paper panel with fields hidden: the shapes genuinely
 * differ, and the things worth reading are different. What matters here is
 * where players come in (`network`), where they can be sent (`backends`), and
 * whether the orchestrator can talk to it well enough to drain anything
 * (`control`).
 */
function ProxySpecPanel({ definition }: { definition: VelocityProxyDefinition }) {
  const { spec } = definition;
  const labels = definition.metadata.labels ?? {};
  const selector = Object.entries(spec.backends.selector.matchLabels);

  return (
    <Panel title="declared" hint="VelocityProxy — the effective spec, every default resolved">
      <div className="grid sm:grid-cols-2">
        <Field label="image" span>
          <span className="break-all">{spec.image}</span>
        </Field>

        <Field label="network">
          port {spec.network.port}
          {spec.network.hostPort !== undefined && (
            <span style={{ color: 'var(--text-faint)' }}> · host {spec.network.hostPort}</span>
          )}
        </Field>
        <Field label="max players">{spec.maxPlayers}</Field>

        <Field label="backend selector" span>
          {selector.length === 0 ? (
            <Empty>none</Empty>
          ) : (
            selector.map(([key, value]) => (
              <div key={key}>
                {key}={value}
              </div>
            ))
          )}
          <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-faint)' }}>
            Servers carrying every one of these labels are enrolled as backends.
          </div>
        </Field>

        <Field label="fallback">
          {spec.backends.fallback === undefined || spec.backends.fallback.length === 0 ? (
            <Empty>none</Empty>
          ) : (
            spec.backends.fallback.map((name) => <div key={name}>{name}</div>)
          )}
        </Field>
        <Field label="forwarding">
          {spec.forwarding.mode}
          {/*
            Coordinates, never a value. The forwarding secret only ever travels
            through the secret store, and there is no endpoint that resolves it.
          */}
          <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-faint)' }}>
            secret {spec.forwarding.secret.name}/{spec.forwarding.secret.key}
          </div>
        </Field>

        <Field label="control endpoint" span>
          port {spec.control.port}
          {spec.control.hostPort !== undefined && (
            <span style={{ color: 'var(--text-faint)' }}> · host {spec.control.hostPort}</span>
          )}
          <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-faint)' }}>
            {spec.control.tokenSecret !== undefined
              ? `token from secret ${spec.control.tokenSecret.name}/${spec.control.tokenSecret.key}`
              : 'no token — reachable only from inside the sandbox'}
          </div>
          <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-faint)' }}>
            How the orchestrator seals, transfers and deregisters. No backend behind this proxy can
            finish a drain without it.
          </div>
        </Field>

        <Field label="memory / cpu">
          {spec.resources.memory}
          <span style={{ color: 'var(--text-faint)' }}>
            {' '}
            · cpu {spec.resources.cpu ?? 'unlimited'}
          </span>
        </Field>
        <Field label="jvm heap">
          {spec.resources.heap.min} → {spec.resources.heap.max}
        </Field>

        <Field label="backend drain timeouts" span>
          seal {spec.backends.drain.sealTimeout} · destination{' '}
          {spec.backends.drain.destinationTimeout} · deregister{' '}
          {spec.backends.drain.deregisterTimeout}
        </Field>

        <Field label="own drain">
          {spec.lifecycle.drain.policy}
          <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-faint)' }}>
            seal within {spec.lifecycle.drain.sealTimeout}. A proxy holds no world, so there is no
            save to confirm — but it is still drained before it is stopped.
          </div>
        </Field>
        <Field label="stop grace / startup">
          {spec.lifecycle.stopGracePeriod}
          <span style={{ color: 'var(--text-faint)' }}> · start {spec.lifecycle.startupTimeout}</span>
        </Field>

        <Field label="placement">{spec.placement?.node ?? <Empty>scheduler chooses</Empty>}</Field>
        <LabelsField labels={labels} />
      </div>
    </Panel>
  );
}

/** The document itself — copyable, and valid input to `POST` / `PUT` as-is. */
function RawDefinition({ definition }: { definition: Definition }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = JSON.stringify(definition, null, 2);

  return (
    <Panel
      title="document"
      hint="what GET returns here is valid input to POST and PUT, unchanged"
      actions={
        <>
          <Button
            onClick={() => {
              void navigator.clipboard.writeText(text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              });
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'Hide' : 'Show'}
          </Button>
        </>
      }
    >
      {open && (
        <pre
          className="mono text-[12px] leading-relaxed p-4 overflow-x-auto"
          style={{ background: 'var(--bg-sunken)' }}
        >
          {text}
        </pre>
      )}
    </Panel>
  );
}
