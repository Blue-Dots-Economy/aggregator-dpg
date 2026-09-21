/**
 * Unit tests for the shared registration server helpers (#619):
 * `isOrgHierarchyEnabled`, `loadConsentContent`, `loadOrgSchema`.
 *
 * The page tests mock this module, so its function bodies are exercised
 * directly here — deps (config-loader, fs, the published-form loader, logger)
 * are mocked so no real I/O happens.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { loadConsentConfig } = vi.hoisted(() => ({ loadConsentConfig: vi.fn() }));
const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));
const { loadPublishedForm } = vi.hoisted(() => ({ loadPublishedForm: vi.fn() }));
const { loggerWarn } = vi.hoisted(() => ({ loggerWarn: vi.fn() }));

vi.mock('@aggregator-dpg/config-loader/fs', () => ({ loadConsentConfig }));
vi.mock('node:fs/promises', () => ({ readFile, default: { readFile } }));
vi.mock('@/lib/aggregator-forms.server', () => ({ loadPublishedForm }));
vi.mock('@/lib/logger', () => ({ logger: { warn: loggerWarn, error: vi.fn(), info: vi.fn() } }));

import {
  isOrgHierarchyEnabled,
  loadConsentContent,
  loadOrgSchema,
} from '@/app/(public)/register/register-server';

function consentCfg() {
  const doc = (title: string, content: string) => ({
    current_version: 1,
    versions: [{ version: 1, title, content, effective_from: '2024-01-01' }],
  });
  return {
    audiences: {
      aggregator: { documents: { terms: doc('AT', 'a-terms'), privacy: doc('AP', 'a-priv') } },
      org: { documents: { terms: doc('OT', 'o-terms'), privacy: doc('OP', 'o-priv') } },
    },
  };
}

describe('isOrgHierarchyEnabled', () => {
  let orig: string | undefined;
  beforeEach(() => {
    orig = process.env.ORG_HIERARCHY_ENABLED;
  });
  afterEach(() => {
    if (orig === undefined) delete process.env.ORG_HIERARCHY_ENABLED;
    else process.env.ORG_HIERARCHY_ENABLED = orig;
  });

  it('true only for the exact string "true"', () => {
    process.env.ORG_HIERARCHY_ENABLED = 'true';
    expect(isOrgHierarchyEnabled()).toBe(true);
  });
  it('false when unset', () => {
    delete process.env.ORG_HIERARCHY_ENABLED;
    expect(isOrgHierarchyEnabled()).toBe(false);
  });
  it('false for other values', () => {
    process.env.ORG_HIERARCHY_ENABLED = 'yes';
    expect(isOrgHierarchyEnabled()).toBe(false);
  });
});

describe('loadConsentContent', () => {
  beforeEach(() => {
    loadConsentConfig.mockReset();
    loggerWarn.mockReset();
  });

  it('returns current-version aggregator + org docs on success', async () => {
    loadConsentConfig.mockResolvedValue(consentCfg());
    const out = await loadConsentContent();
    expect(out).toEqual({
      aggregator: {
        terms: { version: 1, title: 'AT', content: 'a-terms' },
        privacy: { version: 1, title: 'AP', content: 'a-priv' },
      },
      org: {
        terms: { version: 1, title: 'OT', content: 'o-terms' },
        privacy: { version: 1, title: 'OP', content: 'o-priv' },
      },
    });
  });

  it('returns null + warns when the config load throws', async () => {
    loadConsentConfig.mockRejectedValue(new Error('missing file'));
    expect(await loadConsentContent()).toBeNull();
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'loadConsentContent', status: 'failure' }),
    );
  });

  it('returns null when current_version has no matching version entry', async () => {
    loadConsentConfig.mockResolvedValue({
      audiences: {
        aggregator: {
          documents: {
            terms: { current_version: 9, versions: [{ version: 1, title: 'T', content: 'c' }] },
            privacy: { current_version: 1, versions: [{ version: 1, title: 'P', content: 'p' }] },
          },
        },
        org: { documents: { terms: { current_version: 1, versions: [] }, privacy: {} } },
      },
    });
    expect(await loadConsentContent()).toBeNull();
    expect(loggerWarn).toHaveBeenCalled();
  });
});

describe('loadOrgSchema', () => {
  beforeEach(() => {
    loadPublishedForm.mockReset();
  });

  it("derives the ui schema from the published schema's own x- annotations", async () => {
    // One document now: presentation lives in `x-rjsf` inside the schema and
    // the uiSchema is computed, not read from a sibling file.
    loadPublishedForm.mockResolvedValue({
      title: 'Org',
      'x-rjsf': { order: ['name'] },
      properties: { name: { type: 'string', 'x-rjsf': { placeholder: 'e.g. ABC Limited' } } },
    });
    const out = await loadOrgSchema();
    expect(loadPublishedForm).toHaveBeenCalledWith('org-registration');
    expect(out?.uiSchema).toEqual({
      'ui:order': ['name'],
      name: { 'ui:placeholder': 'e.g. ABC Limited' },
    });
    // The annotations stay on the schema — Ajv ignores unknown keywords, and
    // stripping them would mean the browser and the API validate different docs.
    expect(out?.schema).toHaveProperty('x-rjsf');
  });

  it('returns null when the published bundle carries no org form', async () => {
    // Same outcome a deployment without the org tab has always had: the owner
    // route 404s and registration stays coordinator-only.
    loadPublishedForm.mockResolvedValue(null);
    expect(await loadOrgSchema()).toBeNull();
  });
});
