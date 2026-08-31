/**
 * Server-component test: `app/terms/page.tsx`.
 *
 * Invokes the async page function directly and checks the returned element's
 * props, matching the convention used for the other public server-component
 * pages (`register/page.test.tsx`, `[org]/[slug]/page.test.tsx`).
 */
import { describe, it, expect, vi } from 'vitest';

const { loadLegalGroups } = vi.hoisted(() => ({ loadLegalGroups: vi.fn() }));
vi.mock('@/components/legal/load-legal-groups.server', () => ({ loadLegalGroups }));

import TermsPage from '@/app/terms/page';

describe('TermsPage (server component)', () => {
  it('renders LegalDocumentView with doc="terms" and the loaded groups', async () => {
    const groups = [{ audience: 'participant', label: 'For participants', content: {} }];
    loadLegalGroups.mockResolvedValue(groups);

    const el = await TermsPage();

    expect(el.props.doc).toBe('terms');
    expect(el.props.groups).toBe(groups);
  });
});
