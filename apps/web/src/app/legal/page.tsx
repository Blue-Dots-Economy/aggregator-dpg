import type { Metadata } from 'next';
import { LegalDocumentView } from '../../components/legal/LegalDocumentView';
import { loadLegalGroups } from '../../components/legal/load-legal-groups.server';

export const metadata: Metadata = { title: 'Privacy Policy & Terms of Service' };
export const dynamic = 'force-dynamic';

/**
 * Public, read-only legal page: both documents, for every audience whose
 * consent content loaded (participant / aggregator / org), on one page with a
 * contents rail. No checkbox, no scroll gating, no consent capture.
 *
 * `/privacy` and `/terms` redirect here with a fragment, so which section a
 * reader lands on is decided by that fragment rather than by the route.
 */
export default async function LegalPage() {
  return <LegalDocumentView groups={await loadLegalGroups()} />;
}
