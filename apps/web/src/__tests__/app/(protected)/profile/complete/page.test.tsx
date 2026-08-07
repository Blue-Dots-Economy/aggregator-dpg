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

  it('loads and parses the profile schema + UI schema, passing them through', async () => {
    readFile.mockImplementation((path: string) => {
      if (path.includes('profile.v1.ui.json')) {
        return Promise.resolve(JSON.stringify({ 'ui:order': ['org_name'] }));
      }
      return Promise.resolve(
        JSON.stringify({ title: 'Complete your profile', properties: { org_name: {} } }),
      );
    });

    const el = await ProfileCompletePage();

    expect(el.props.schema).toEqual({
      title: 'Complete your profile',
      properties: { org_name: {} },
    });
    expect(el.props.uiSchema).toEqual({ 'ui:order': ['org_name'] });
  });

  it('reads both schema files from the resolved aggregator config path', async () => {
    readFile.mockResolvedValue('{}');
    await ProfileCompletePage();
    const paths = readFile.mock.calls.map((c) => String(c[0]));
    expect(paths.some((p) => p.endsWith('profile.v1.json'))).toBe(true);
    expect(paths.some((p) => p.endsWith('profile.v1.ui.json'))).toBe(true);
  });
});
