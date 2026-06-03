import type { ReactNode } from 'react';
import { LanguageSwitcher } from '../../components/shell/LanguageSwitcher';

/**
 * Public-auth routes (`/login`, `/register`) ship a fixed light-theme
 * hero + card design. Wrap the subtree in `bd-public-light` so descendants
 * always read light-theme CSS variables, and expose the language switcher in
 * a top-right slot so users can choose a language before signing in.
 */
export default function PublicAuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="bd-public-light relative">
      <div className="absolute right-4 top-4 z-10">
        <LanguageSwitcher />
      </div>
      {children}
    </div>
  );
}
