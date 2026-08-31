import type { Metadata } from 'next';
import { LegalDocumentView } from '../../components/legal/LegalDocumentView';
import { loadLegalGroups } from '../../components/legal/load-legal-groups.server';

export const metadata: Metadata = { title: 'Terms of Service' };
export const dynamic = 'force-dynamic';

/**
 * Public, read-only Terms of Service page. Shows every audience whose
 * consent content loaded (participant / aggregator / org) grouped in a
 * contents rail — no checkbox, no scroll gating, no consent capture.
 */
export default async function TermsPage() {
  return <LegalDocumentView doc="terms" groups={await loadLegalGroups()} />;
}
