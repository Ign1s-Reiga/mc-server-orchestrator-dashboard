'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { validateDefinition, yamlBody } from '@/lib/api/client';
import { describeError, isApiError, isValidationFailure } from '@/lib/api/errors';
import type { Definition, Violation } from '@/lib/api/types';
import { sourceLine } from '@/lib/form/definition-form';
import { Button, Note, Panel } from './ui';

/**
 * A definition editor for kinds the structured form does not cover.
 *
 * This is not a fallback so much as the other half of the same contract. §5:
 * JSON and YAML go through one parser, every problem comes back at once, and
 * each one carries a line and column *into the text the client sent* — so for a
 * document a client wrote by hand, a violation can point at the exact line the
 * operator typed. That is a better experience than a form for a spec with a
 * label selector and two secret references in it.
 *
 * Everything else is identical to the structured form: the same `POST /validate`
 * on a debounce, the same complete violation list, the same `If-Match` and 409
 * handling in the page above.
 */
export function DocumentEditor({
  value,
  onChange,
  onSubmit,
  submitLabel,
  busy,
  submitViolations,
  header,
  footer,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  submitLabel: string;
  busy: boolean;
  submitViolations: readonly Violation[] | null;
  header?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const [liveViolations, setLiveViolations] = useState<readonly Violation[] | null>(null);
  const [effective, setEffective] = useState<Definition | null>(null);
  const [checking, setChecking] = useState(false);
  const [validateError, setValidateError] = useState<string | null>(null);
  const sentRef = useRef<string>('');
  const [sentText, setSentText] = useState('');

  // Always sent as YAML. §5: YAML 1.2 is a strict superset of JSON, both go
  // through one parser, and the positions come back against the text as sent —
  // so one content type covers a document the operator pasted in either syntax.
  const body = useMemo(() => yamlBody(value), [value]);

  useEffect(() => {
    if (value.trim().length === 0) {
      setLiveViolations(null);
      setEffective(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setChecking(true);
      sentRef.current = body.text;
      void validateDefinition(body)
        .then((result) => {
          if (controller.signal.aborted) return;
          setEffective(result.definition);
          setLiveViolations([]);
          setValidateError(null);
          setSentText(sentRef.current);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setEffective(null);
          if (isValidationFailure(cause)) {
            setLiveViolations(cause.violations);
            setValidateError(null);
            setSentText(sentRef.current);
          } else {
            setLiveViolations(null);
            setValidateError(isApiError(cause) ? describeError(cause) : 'validation could not run');
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setChecking(false);
        });
    }, 500);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [body, value]);

  // A write's own 422 outranks the live check: it answers the exact document
  // that was submitted, not whatever has been typed since.
  const violations = submitViolations ?? liveViolations;
  const lineCount = value.split('\n').length;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className="flex flex-col gap-4"
    >
      {header}

      {violations !== null && violations.length > 0 && (
        <Note tone="fault" title={`${violations.length} problem${violations.length === 1 ? '' : 's'}`}>
          The API reports every problem in a document at once, so this is the complete list.
          <ul className="mt-2 flex flex-col gap-2">
            {violations.map((violation, index) => {
              const line =
                violation.location !== null ? sourceLine(sentText, violation.location.line) : null;
              return (
                <li key={index}>
                  <span className="mono text-[12px]" style={{ color: 'var(--fault)' }}>
                    {violation.field}
                  </span>
                  <div className="text-[12px]">{violation.problem}</div>
                  {violation.location !== null && (
                    <div className="mono text-[10px] mt-0.5" style={{ color: 'var(--text-faint)' }}>
                      line {violation.location.line}:{violation.location.column}
                      {line !== null && <span> · {line.trim()}</span>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Note>
      )}

      {validateError !== null && (
        <Note tone="work" title="live checking is not available">
          {validateError} The document still submits; the API validates on write either way.
        </Note>
      )}

      <Panel
        title="definition"
        hint={
          checking
            ? 'checking…'
            : effective !== null
              ? 'valid — this is what the reconciler would act on'
              : `${lineCount} lines · YAML or JSON`
        }
      >
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          rows={26}
          aria-label="definition document"
          className="mono text-[12px] leading-relaxed p-4 w-full resize-y"
          style={{ background: 'var(--bg-sunken)', color: 'var(--text)' }}
        />
      </Panel>

      <EffectivePreview effective={effective} />

      <div className="flex items-center gap-3 flex-wrap">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Sending…' : submitLabel}
        </Button>
        {footer}
      </div>
    </form>
  );
}

/** §6: showing an operator what their omissions became is most of what /validate is for. */
function EffectivePreview({ effective }: { effective: Definition | null }) {
  const [open, setOpen] = useState(false);
  if (effective === null) return null;
  return (
    <Panel
      title="effective definition"
      hint="every default resolved"
      actions={
        <Button onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Hide' : 'Show'}
        </Button>
      }
    >
      {open && (
        <pre
          className="mono text-[12px] leading-relaxed p-4 overflow-x-auto max-h-96"
          style={{ background: 'var(--bg-sunken)' }}
        >
          {JSON.stringify(effective, null, 2)}
        </pre>
      )}
    </Panel>
  );
}
