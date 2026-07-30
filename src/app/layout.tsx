import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import './globals.css';
import { SessionProvider } from '@/components/session-provider';
import { FleetProvider } from '@/components/fleet-provider';
import { Shell } from '@/components/shell';

/*
 * Two faces, and the split between them is the design's one structural idea:
 * mono is the system's own vocabulary, sans is language written for a person.
 * See the note at the top of globals.css.
 */
const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-sans',
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'mcorch',
  description: 'Operator dashboard for the mc-server-orchestrator.',
};

export const viewport: Viewport = {
  colorScheme: 'light dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable} h-full`}>
      <body className="min-h-full">
        <SessionProvider>
          <FleetProvider>
            <Shell>{children}</Shell>
          </FleetProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
