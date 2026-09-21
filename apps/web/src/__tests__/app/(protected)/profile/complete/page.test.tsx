/**
 * Server-component test: `(protected)/profile/complete/page.tsx`.
 *
 * Since #640 the page reads the published `profile` form rather than a file on
 * disk, so the loader is mocked rather than the filesystem. Invokes the async
 * page function directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { loadPublishedForm } = vi.hoisted(() => ({ loadPublishedForm: vi.fn() }));
vi.mock('@/lib/aggregator-forms.server', () => ({ loadPublishedForm }));

import ProfileCompletePage from '@/app/(protected)/profile/complete/page';
import { SchemaUnavailableError } from '@/lib/aggregator-schema.server';

describe('ProfileCompletePage (server component)', () => {
  beforeEach(() => {
    loadPublishedForm.mockReset();
  });

  it('derives the UI schema from the published profile schema and passes both through', async () => {
    loadPublishedForm.mockResolvedValue({
      title: 'Complete your profile',
      'x-rjsf': { order: ['org_name'] },
      properties: { org_name: {} },
    });

    const el = await ProfileCompletePage();

    expect(loadPublishedForm).toHaveBeenCalledWith('profile');
    expect(el.props.schema).toMatchObject({ title: 'Complete your profile' });
    expect(el.props.uiSchema).toEqual({ 'ui:order': ['org_name'] });
  });

  it('throws SchemaUnavailableError when the bundle carries no profile form', async () => {
    // No on-disk copy remains to fall back to. Rendering an empty form the
    // user could "submit" would be worse than failing loudly.
    loadPublishedForm.mockResolvedValue(null);
    await expect(ProfileCompletePage()).rejects.toBeInstanceOf(SchemaUnavailableError);
  });
});
