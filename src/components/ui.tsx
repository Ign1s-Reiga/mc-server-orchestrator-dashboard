import type { ReactNode } from 'react';
import { TONE_COLOR, type Tone } from '@/lib/display';

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

/* -------------------------------------------------------------- structure */

export function Panel({
  title,
  hint,
  actions,
  children,
  className,
}: {
  title?: string;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cx('border rounded-sm', className)}
      style={{ background: 'var(--bg-raised)' }}
    >
      {(title !== undefined || actions !== undefined) && (
        <header className="flex items-baseline gap-3 px-4 py-2.5 border-b">
          {title !== undefined && <h2 className="label">{title}</h2>}
          {hint !== undefined && (
            <p className="text-xs flex-1" style={{ color: 'var(--text-faint)' }}>
              {hint}
            </p>
          )}
          {actions !== undefined && <div className="ml-auto flex gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/**
 * A label/value row. The label is mono-uppercase and the value is mono too —
 * both come from the data model. Prose values pass `prose` to switch to sans.
 */
export function Field({
  label,
  children,
  prose = false,
  span = false,
}: {
  label: string;
  children: ReactNode;
  prose?: boolean;
  span?: boolean;
}) {
  return (
    <div className={cx('px-4 py-2.5 border-b last:border-b-0', span && 'sm:col-span-2')}>
      <div className="label mb-1">{label}</div>
      <div className={cx('text-[13px] break-words', prose ? '' : 'mono')}>{children}</div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <span className="mono" style={{ color: 'var(--text-faint)' }}>
      {children}
    </span>
  );
}

/** A value that is `null` in the API. Rendered as absence, not as zero. */
export function Nil() {
  return <Empty>—</Empty>;
}

/* ------------------------------------------------------------- indicators */

export function Dot({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) {
  return (
    <span
      aria-hidden
      className={cx('inline-block size-[7px] rounded-full shrink-0', pulse && 'pulse-live')}
      style={{ background: TONE_COLOR[tone] }}
    />
  );
}

export function Chip({
  tone = 'neutral',
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      className="mono inline-flex items-center gap-1.5 px-1.5 py-0.5 text-[11px] border rounded-sm whitespace-nowrap"
      title={title}
      style={{ color: TONE_COLOR[tone], borderColor: 'currentColor' }}
    >
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------- controls */

type ButtonVariant = 'primary' | 'default' | 'danger' | 'ghost';

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 px-3 h-8 text-[13px] border rounded-sm ' +
  'transition-colors disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer';

function buttonStyle(variant: ButtonVariant): React.CSSProperties {
  switch (variant) {
    case 'primary':
      return { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' };
    case 'danger':
      return { background: 'transparent', borderColor: 'var(--fault)', color: 'var(--fault)' };
    case 'ghost':
      return { background: 'transparent', borderColor: 'transparent', color: 'var(--text-dim)' };
    default:
      return { background: 'var(--bg-raised)', color: 'var(--text)' };
  }
}

export function Button({
  variant = 'default',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(BUTTON_BASE, className)}
      style={{ ...buttonStyle(variant), ...props.style }}
    />
  );
}

export function LinkButton({
  variant = 'default',
  className,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant }) {
  return (
    <a {...props} className={cx(BUTTON_BASE, className)} style={buttonStyle(variant)} />
  );
}

/* ------------------------------------------------------------------ notes */

/**
 * A standing message: an error, a warning, an admission that the data on
 * screen might be old. Never a transient toast — an operator who looked away
 * should still be able to find out what happened.
 */
export function Note({
  tone = 'neutral',
  title,
  children,
  actions,
}: {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      role={tone === 'fault' ? 'alert' : 'status'}
      className="border-l-2 px-4 py-3 rounded-r-sm"
      style={{ borderLeftColor: TONE_COLOR[tone], background: 'var(--bg-raised)' }}
    >
      {title !== undefined && (
        <div className="mono text-[12px] font-medium mb-1" style={{ color: TONE_COLOR[tone] }}>
          {title}
        </div>
      )}
      {children !== undefined && (
        <div className="text-[13px]" style={{ color: 'var(--text-dim)' }}>
          {children}
        </div>
      )}
      {actions !== undefined && <div className="flex flex-wrap gap-2 mt-2.5">{actions}</div>}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-8 justify-center">
      <Dot tone="quiet" pulse />
      <span className="mono text-[12px]" style={{ color: 'var(--text-faint)' }}>
        {label}
      </span>
    </div>
  );
}
