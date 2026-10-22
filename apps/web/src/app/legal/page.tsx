import type { Metadata } from 'next';
import { LegalDocumentView } from '../../components/legal/LegalDocumentView';
import { loadLegalGroups } from '../../components/legal/load-legal-groups.server';

export const metadata: Metadata = { title: 'Privacy Policy & Terms of Service' };
export const dynamic = 'force-dynamic';

/**
 * Public, read-only legal page showing both documents for every audience.
 *
 * Does not capture consent. `/privacy` and `/terms` redirect here with a
 * fragment that selects the section.
 */
export default async function LegalPage() {
  return <LegalDocumentView groups={await loadLegalGroups()} />;
}
