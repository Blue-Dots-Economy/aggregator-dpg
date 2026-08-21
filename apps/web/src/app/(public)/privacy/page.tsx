import type { Metadata } from 'next';
import { LegalDocumentView } from '../../../components/legal/LegalDocumentView';
import { loadLegalGroups } from '../../../components/legal/load-legal-groups.server';

export const metadata: Metadata = { title: 'Privacy Policy' };
export const dynamic = 'force-dynamic';

/**
 * Public, read-only Privacy Policy page. Shows every audience whose consent
 * content loaded (participant / aggregator / org) grouped in a contents
 * rail — no checkbox, no scroll gating, no consent capture.
 */
export default async function PrivacyPage() {
  return <LegalDocumentView doc="privacy" groups={await loadLegalGroups()} />;
}
