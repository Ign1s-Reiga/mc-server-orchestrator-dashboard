'use client';

import { useId, useState } from 'react';
import type { Definition, Violation } from '@/lib/api/types';
import { sourceLine, type ViolationIndex } from '@/lib/form/definition-form';
import { Button, Note, Panel, cx } from './ui';

/**
 * The controls both definition forms are built from.
 *
 * They live here rather than in either form because the two kinds have to agree
 * on how a violation is shown. §5 goes to some trouble to attach every problem
 * to a dotted field path and a line and column; a form that rendered those
 * differently from its sibling would make an operator learn the page as well as
 * the error.
 */

export interface FieldContext {
  values: Record<string, string>;
  setValue: (path: string, value: string) => void;
  violations: ViolationIndex;
  /** The exact text that produced the current violations, for line lookups. */
  sentText: string | null;
  /** What the parser fills in when a field is blank. Documentation, never sent. */
  hints: Partial<Record<string, string>>;
}

export function ProblemList({
  id,
  problems,
  sentText,
}: {
  id?: string;
  problems: readonly Violation[];
  sentText: string | null;
}) {
  return (
    <div id={id} className="flex flex-col gap-1">
      {problems.map((problem, index) => {
        const line =
          problem.location !== null && sentText !== null
            ? sourceLine(sentText, problem.location.line)
            : null;
        return (
          <div key={index}>
            <p className="text-[12px]" style={{ color: 'var(--fault)' }}>
              {problem.problem}
            </p>
            {problem.location !== null && (
              <p className="mono text-[10px] mt-0.5" style={{ color: 'var(--text-faint)' }}>
                line {problem.location.line}:{problem.location.column}
                {line !== null && <span> · {line.trim()}</span>}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * One input, wired to its dotted path.
 *
 * Violations arrive from the API attached to a `field` — the same path this
 * input is keyed by — so an error lands on the control that caused it. Dumping
 * the list at the top of the form would waste that.
 */
export function TextField({
  ctx,
  path,
  label,
  help,
  type = 'text',
  required = false,
  className,
}: {
  ctx: FieldContext;
  path: string;
  label: string;
  help?: string;
  type?: 'text' | 'number';
  required?: boolean;
  className?: string;
}) {
  const id = useId();
  const problems = ctx.violations.byField.get(path) ?? [];
  const invalid = problems.length > 0;
  const hint = ctx.hints[path];

  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="label flex items-baseline gap-1.5">
        {label}
        {required && (
          <span aria-hidden style={{ color: 'var(--fault)' }}>
            *
          </span>
        )}
      </label>
      <input
        id={id}
        type={type}
        inputMode={type === 'number' ? 'numeric' : undefined}
        value={ctx.values[path] ?? ''}
        onChange={(event) => ctx.setValue(path, event.target.value)}
        placeholder={hint}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-problem` : help !== undefined ? `${id}-help` : undefined}
        autoComplete="off"
        spellCheck={false}
        className="mono text-[13px] px-2.5 h-8 border rounded-sm w-full"
        style={{
          background: 'var(--bg-raised)',
          borderColor: invalid ? 'var(--fault)' : undefined,
        }}
      />
      {invalid ? (
        <ProblemList id={`${id}-problem`} problems={problems} sentText={ctx.sentText} />
      ) : (
        help !== undefined && (
          <p id={`${id}-help`} className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
            {help}
          </p>
        )
      )}
      {!invalid && help === undefined && hint !== undefined && (
        <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
          Leave blank for {hint}.
        </p>
      )}
    </div>
  );
}

/** A textarea whose violations attach to a path, for the collection controls. */
export function AreaField({
  ctx,
  path,
  label,
  value,
  onChange,
  placeholder,
  help,
  rows = 3,
  required = false,
  className,
  children,
}: {
  ctx: FieldContext;
  path: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  help?: React.ReactNode;
  rows?: number;
  required?: boolean;
  className?: string;
  /** Rendered under the help line — a live read-out of what the value means. */
  children?: React.ReactNode;
}) {
  const id = useId();
  const problems = ctx.violations.byField.get(path) ?? [];
  const invalid = problems.length > 0;

  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="label flex items-baseline gap-1.5">
        {label}
        {required && (
          <span aria-hidden style={{ color: 'var(--fault)' }}>
            *
          </span>
        )}
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={rows}
        spellCheck={false}
        placeholder={placeholder}
        aria-invalid={invalid}
        className="mono text-[13px] px-2.5 py-1.5 border rounded-sm w-full"
        style={{
          background: 'var(--bg-raised)',
          borderColor: invalid ? 'var(--fault)' : undefined,
        }}
      />
      {invalid && <ProblemList problems={problems} sentText={ctx.sentText} />}
      {help !== undefined && (
        <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
          {help}
        </p>
      )}
      {children}
    </div>
  );
}

export function Section({
  title,
  hint,
  children,
  columns = 2,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  columns?: 1 | 2;
}) {
  return (
    <Panel title={title} hint={hint}>
      <div className={cx('grid gap-4 p-4', columns === 2 && 'sm:grid-cols-2')}>{children}</div>
    </Panel>
  );
}

/**
 * Everything the API said, above the fields.
 *
 * `unattached` is the important half: a violation on a path this build has no
 * control for is still shown, with its path, because the alternative is an
 * operator staring at a form with no errors on it that will not submit. The
 * orchestrator's own troubleshooting notes name that failure by name.
 */
export function ViolationSummary({ violations }: { violations: ViolationIndex }) {
  if (violations.total === 0) return null;
  return (
    <Note tone="fault" title={`${violations.total} problem${violations.total === 1 ? '' : 's'}`}>
      Each one is marked on its field below. The API reports every problem in a document at once, so
      this is the complete list — fixing them all makes the next submit succeed.
      {violations.unattached.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {violations.unattached.map((violation, index) => (
            <li key={index} className="text-[12px]">
              <span className="mono" style={{ color: 'var(--fault)' }}>
                {violation.field}
              </span>{' '}
              {violation.problem}
            </li>
          ))}
        </ul>
      )}
    </Note>
  );
}

/**
 * What the parser makes of the document as typed.
 *
 * §6: "Showing an operator what their omissions became is most of what this is
 * for." A create form full of blanks is otherwise a guess about what will
 * actually run.
 */
export function EffectivePreview({
  effective,
  checking,
}: {
  effective: Definition | null;
  checking: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Panel
      title="effective definition"
      hint={
        checking
          ? 'checking…'
          : effective !== null
            ? 'valid — this is what the reconciler would act on'
            : 'not valid yet'
      }
      actions={
        effective !== null && (
          <Button onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'Hide' : 'Show'}
          </Button>
        )
      }
    >
      {open && effective !== null && (
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
