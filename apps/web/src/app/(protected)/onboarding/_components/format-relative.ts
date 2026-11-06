/**
 * Formats a timestamp as a short age such as `5m ago` (onboarding pages, web app).
 *
 * @param iso - ISO timestamp in the past.
 * @returns The age in whole seconds, minutes, hours or days.
 */
export function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}
