import type { JSX, ReactNode } from 'react';

/** Page background used by every state of the public registration page. */
const PAGE_BACKGROUND =
  'radial-gradient(1200px 600px at 50% -10%, var(--bd-tint-primary), transparent 70%), #FBFCFE';

/** Props for {@link PublicPageShell}. */
export interface PublicPageShellProps {
  children: ReactNode;
  /** Marks the page busy while the config loads. */
  busy?: boolean;
}

/**
 * Full-page background of the public registration page.
 */
export function PublicPageShell({ children, busy }: Readonly<PublicPageShellProps>): JSX.Element {
  return (
    <div
      className="bd-public-light min-h-screen w-full"
      style={{ background: PAGE_BACKGROUND }}
      aria-busy={busy || undefined}
    >
      {children}
    </div>
  );
}
