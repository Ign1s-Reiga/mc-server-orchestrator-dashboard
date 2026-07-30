'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from './session-provider';
import { SignIn } from './sign-in';
import { ConnectionBanner, ConnectionPill } from './connection-status';
import { Button, Spinner, cx } from './ui';
import { useFleet } from './fleet-provider';

const NAV = [
  { href: '/', label: 'fleet' },
  { href: '/secrets', label: 'secrets' },
] as const;

/**
 * The frame.
 *
 * Sign-in is a gate rather than a route: the session lives in an `HttpOnly`
 * cookie, so a deep link that arrives unauthenticated should land where it was
 * going once the operator signs in, not be bounced to `/login` and back.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  const { state } = useSession();

  if (state.status === 'unknown') {
    return (
      <main className="min-h-dvh grid place-items-center">
        <Spinner label="checking session" />
      </main>
    );
  }

  if (state.status === 'anonymous') return <SignIn />;

  return (
    <div className="min-h-dvh flex flex-col md:flex-row">
      <Sidebar />
      <main className="flex-1 min-w-0">
        <div className="max-w-[1400px] mx-auto p-4 md:p-6 flex flex-col gap-4">
          <ConnectionBanner />
          {children}
        </div>
      </main>
    </div>
  );
}

function Sidebar() {
  const pathname = usePathname();
  const { signOut, state } = useSession();
  const fleet = useFleet();

  const counts = {
    total: fleet.order.length,
    attention: [...fleet.servers.values()].filter((server) => server.display.needsAttention).length,
    terminating: [...fleet.servers.values()].filter(
      (server) => server.display.state === 'TERMINATING',
    ).length,
  };

  return (
    <nav
      className="md:w-52 md:shrink-0 md:min-h-dvh md:sticky md:top-0 border-b md:border-b-0 md:border-r flex md:flex-col gap-4 px-4 py-3 md:py-5 items-center md:items-stretch"
      style={{ background: 'var(--bg-sunken)' }}
    >
      <Link href="/" className="mono text-[15px] font-semibold tracking-tight">
        mcorch
      </Link>

      <ul className="flex md:flex-col gap-1 md:mt-4 flex-1">
        {NAV.map((item) => {
          const active =
            item.href === '/' ? pathname === '/' || pathname.startsWith('/servers') : pathname.startsWith(item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'label block px-2 py-1.5 rounded-sm border-l-2 transition-colors',
                  active ? 'border-l-current' : 'border-l-transparent',
                )}
                style={{ color: active ? 'var(--text)' : 'var(--text-faint)' }}
              >
                {item.label}
                {item.href === '/' && counts.total > 0 && (
                  <span className="ml-2 tabular-nums" style={{ color: 'var(--text-faint)' }}>
                    {counts.total}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="hidden md:flex flex-col gap-3 pt-4 border-t">
        {counts.attention > 0 && (
          <span className="mono text-[11px]" style={{ color: 'var(--fault)' }}>
            ▲ {counts.attention} need{counts.attention === 1 ? 's' : ''} attention
          </span>
        )}
        {counts.terminating > 0 && (
          <span className="mono text-[11px]" style={{ color: 'var(--work)' }}>
            {counts.terminating} terminating
          </span>
        )}
        <ConnectionPill />
        <div className="flex flex-col gap-1">
          {state.status === 'authenticated' && state.info.expiresAt !== null && (
            <span className="mono text-[10px]" style={{ color: 'var(--text-faint)' }}>
              session to {state.info.expiresAt.slice(11, 16)}Z
            </span>
          )}
          <Button variant="ghost" onClick={() => void signOut()} className="!px-0 !h-6 justify-start">
            <span className="label">sign out</span>
          </Button>
        </div>
      </div>

      <Button
        variant="ghost"
        onClick={() => void signOut()}
        className="md:hidden ml-auto !px-2"
      >
        <span className="label">sign out</span>
      </Button>
    </nav>
  );
}
