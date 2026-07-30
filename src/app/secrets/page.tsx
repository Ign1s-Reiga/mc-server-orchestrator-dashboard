'use client';

import { useCallback, useEffect, useState } from 'react';
import { deleteSecret, deleteSecretKey, listSecrets, putSecret } from '@/lib/api/client';
import { describeError } from '@/lib/api/errors';
import type { SecretSummary } from '@/lib/api/types';
import { Button, Empty, Note, Panel, Spinner } from '@/components/ui';

/**
 * Secrets (§9). One-way, always.
 *
 * A definition names a secret; it never contains one. This page writes material
 * and lists coordinates, and there is deliberately nothing on it that reveals,
 * exports, previews or round-trips a value — `GET` on a key is a
 * `405 SECRET_NOT_READABLE` whether or not the secret exists, and a UI with a
 * reveal control would be promising something the API refuses on purpose.
 */
export default function SecretsPage() {
  const [secrets, setSecrets] = useState<SecretSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const items = await listSecrets(signal);
      if (signal?.aborted === true) return;
      setSecrets(items);
      setError(null);
    } catch (cause) {
      if (signal?.aborted === true) return;
      setError(describeError(cause));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="mono text-[20px] font-semibold tracking-tight">secrets</h1>
        <p className="text-[13px]" style={{ color: 'var(--text-dim)' }}>
          Material a definition refers to by name and key. Values go in and are never read back out
          — not here, not by any endpoint, not with a flag.
        </p>
      </header>

      {error !== null && <Note tone="fault" title="the secret store could not be listed">{error}</Note>}
      {notice !== null && <Note tone="ok">{notice}</Note>}

      <SetSecretForm
        onWritten={(message) => {
          setNotice(message);
          void refresh();
        }}
      />

      <Panel title="stored secrets" hint="names and keys only">
        {secrets === null ? (
          <Spinner label="reading secret coordinates" />
        ) : secrets.length === 0 ? (
          <p className="px-4 py-10 text-center text-[13px]" style={{ color: 'var(--text-dim)' }}>
            No secrets are stored. Add one above, then refer to it from a definition.
          </p>
        ) : (
          <ul>
            {secrets.map((secret) => (
              <li key={secret.name} className="border-b last:border-b-0 px-4 py-3">
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <span className="mono text-[13px] font-medium">{secret.name}</span>
                  <Button
                    variant="danger"
                    onClick={() => {
                      void deleteSecret(secret.name)
                        .then((result) => {
                          setNotice(
                            `Removed ${secret.name} and its ${result.removedKeys} key${
                              result.removedKeys === 1 ? '' : 's'
                            }.`,
                          );
                          void refresh();
                        })
                        .catch((cause: unknown) => setError(describeError(cause)));
                    }}
                    className="!h-6 !text-[12px]"
                  >
                    Remove secret
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2 mt-2">
                  {secret.keys.length === 0 ? (
                    <Empty>no keys</Empty>
                  ) : (
                    secret.keys.map((key) => (
                      <span
                        key={key}
                        className="mono text-[11px] inline-flex items-center gap-2 px-2 py-0.5 border rounded-sm"
                        style={{ background: 'var(--bg-sunken)' }}
                      >
                        {key}
                        <button
                          type="button"
                          aria-label={`remove key ${key} from ${secret.name}`}
                          onClick={() => {
                            void deleteSecretKey(secret.name, key)
                              .then(() => {
                                setNotice(`Removed ${secret.name}/${key}.`);
                                void refresh();
                              })
                              .catch((cause: unknown) => setError(describeError(cause)));
                          }}
                          className="cursor-pointer"
                          style={{ color: 'var(--text-faint)' }}
                        >
                          ×
                        </button>
                      </span>
                    ))
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <p className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
        A stored value cannot be displayed, exported or checked against what you think it is. To
        change one, write it again — the response says only how many bytes were stored.
      </p>
    </>
  );
}

function SetSecretForm({ onWritten }: { onWritten: (message: string) => void }) {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [material, setMaterial] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = name.trim().length > 0 && key.trim().length > 0 && material.length > 0;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await putSecret(name.trim(), key.trim(), material);
      // Drop the material as soon as it has been sent. Nothing here keeps it,
      // and the response never contained it — only its length.
      setMaterial('');
      onWritten(
        `${result.replaced ? 'Replaced' : 'Stored'} ${result.name}/${result.key} — ${result.length} bytes.`,
      );
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="set a value" hint="sent as a raw body, never wrapped in JSON">
      <form onSubmit={(event) => void submit(event)} className="p-4 flex flex-col gap-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <label className="flex flex-col gap-1">
            <span className="label">secret name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="survival-02-rcon"
              className="mono text-[13px] px-2.5 h-8 border rounded-sm"
              style={{ background: 'var(--bg-raised)' }}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">key</span>
            <input
              value={key}
              onChange={(event) => setKey(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="password"
              className="mono text-[13px] px-2.5 h-8 border rounded-sm"
              style={{ background: 'var(--bg-raised)' }}
            />
          </label>
        </div>

        <label className="flex flex-col gap-1">
          <span className="label">value</span>
          <input
            type="password"
            value={material}
            onChange={(event) => setMaterial(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="mono text-[13px] px-2.5 h-8 border rounded-sm"
            style={{ background: 'var(--bg-raised)' }}
          />
          <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
            Write-only. Once this is sent there is no way to read it back or confirm it, so check it
            before you submit.
          </span>
        </label>

        {error !== null && <Note tone="fault" title="the value was not stored">{error}</Note>}

        <div>
          <Button type="submit" variant="primary" disabled={!ready || busy}>
            {busy ? 'Storing…' : 'Store value'}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
