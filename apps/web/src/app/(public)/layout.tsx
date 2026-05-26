import type { ReactNode } from 'react';

/**
 * Public-auth routes (`/login`, `/register`) ship a fixed light-theme
 * hero + card design — the brand panel's dark gradient is baked in
 * and the right card assumes a white background. Wrap the subtree in
 * `bd-public-light` so its descendants always read light-theme CSS
 * variables, regardless of the `.dark` class on `<html>` set by the
 * authenticated-app theme toggle.
 */
export default function PublicAuthLayout({ children }: { children: ReactNode }) {
  return <div className="bd-public-light">{children}</div>;
}
