/**
 * Server-component test: `(protected)/profile/complete/page.tsx`.
 *
 * Loads `profile.v1.json`/`profile.v1.ui.json` from disk and hands them to
 * `ProfileCompleteView`. Invokes the async page function directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile, default: { readFile } }));

import ProfileCompletePage from '@/app/(protected)/profile/complete/page';

describe('ProfileCompletePage (server component)', () => {
  beforeEach(() => {
    readFile.mockReset();
  });

  it('derives the UI schema from the profile schema and passes both through', async () => {
    readFile.mockResolvedValue(
      JSON.stringify({
        title: 'Complete your profile',
        'x-form-layout': { order: ['org_name'] },
        properties: { org_name: {} },
      }),
    );

    const el = await ProfileCompletePage();

    expect(el.props.schema).toMatchObject({ title: 'Complete your profile' });
    expect(el.props.uiSchema).toEqual({ 'ui:order': ['org_name'] });
  });

  it('reads one schema file from the resolved aggregator config path', async () => {
    readFile.mockResolvedValue('{}');
    await ProfileCompletePage();
    const paths = readFile.mock.calls.map((c) => String(c[0]));
    expect(paths.some((p) => p.endsWith('profile.v1.json'))).toBe(true);
    // The sibling .ui.json is gone; a read of it would mean a stale caller.
    expect(paths.some((p) => p.endsWith('.ui.json'))).toBe(false);
  });
});
