import type { ReactNode } from 'react';
import { LanguageSwitcher } from '../../components/shell/LanguageSwitcher';
import { ThemeToggle } from '../../components/shell/ThemeToggle';

/**
 * Public-auth routes (`/login`, `/register`).
 *
 * These used to be wrapped in `bd-public-light`, which pinned light-theme CSS
 * variables and overrode ~30 utilities so the hero + card always rendered
 * light. That made the login page the one surface a dark-mode user could not
 * get out of, which read as a bug rather than a design choice. The wrapper is
 * gone and the subtree now inherits the same `.dark` class on `<html>` that
 * every other route uses, so the no-flash script in `app/layout.tsx` applies
 * here too.
 *
 * `bd-public-light` itself is untouched — the public registration view
 * (`[org]/[slug]`) still applies it explicitly and is deliberately out of
 * scope here.
 *
 * The corner slot carries both controls so a visitor can set language AND
 * theme before signing in.
 */
export default function PublicAuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative">
      <div className="absolute right-4 top-4 z-50 flex items-center gap-2">
        <LanguageSwitcher />
        <ThemeToggle />
      </div>
      {children}
    </div>
  );
}
