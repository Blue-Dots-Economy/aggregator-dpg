/**
 * Server-component test: `(public)/register/page.tsx`.
 *
 * Invokes the async page function directly. Covers: the session-redirect
 * guard, the consent-load-failure → null fallback (per CLAUDE.md's "Consent
 * content has no API round-trip" note), the org-hierarchy flag gating the org
 * schema load, and the org-schema-missing graceful degrade.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }));
const { loadRegistrationSchema, resolveAggregatorSchemaPath } = vi.hoisted(() => ({
  loadRegistrationSchema: vi.fn(),
  resolveAggregatorSchemaPath: vi.fn((file: string) => `/config/aggregator/${file}`),
}));
const { loadConsentConfig } = vi.hoisted(() => ({ loadConsentConfig: vi.fn() }));
const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));
const { loggerWarn } = vi.hoisted(() => ({ loggerWarn: vi.fn() }));

vi.mock('@/lib/server-session', () => ({ getSession }));
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('@/lib/aggregator-schema.server', () => ({
  loadRegistrationSchema,
  resolveAggregatorSchemaPath,
}));
vi.mock('@aggregator-dpg/config-loader/fs', () => ({ loadConsentConfig }));
vi.mock('node:fs/promises', () => ({ readFile, default: { readFile } }));
vi.mock('@/lib/logger', () => ({ logger: { warn: loggerWarn, error: vi.fn(), info: vi.fn() } }));

import RegisterPage from '@/app/(public)/register/page';

const coordSchema = { schema: { title: 'Aggregator Registration', properties: {} }, uiSchema: {} };

function consentCfg() {
  return {
    audiences: {
      aggregator: {
        documents: {
          terms: {
            current_version: 1,
            versions: [{ version: 1, title: 'Terms', content: 'T', effective_from: '2024-01-01' }],
          },
          privacy: {
            current_version: 1,
            versions: [
              { version: 1, title: 'Privacy', content: 'P', effective_from: '2024-01-01' },
            ],
          },
        },
      },
      org: {
        documents: {
          terms: {
            current_version: 1,
            versions: [{ version: 1, title: 'Terms', content: 'T', effective_from: '2024-01-01' }],
          },
          privacy: {
            current_version: 1,
            versions: [
              { version: 1, title: 'Privacy', content: 'P', effective_from: '2024-01-01' },
            ],
          },
        },
      },
    },
  };
}

describe('RegisterPage (server component)', () => {
  let originalOrgFlag: string | undefined;

  beforeEach(() => {
    getSession.mockReset().mockResolvedValue(null);
    redirect.mockReset();
    loadRegistrationSchema.mockReset().mockResolvedValue(coordSchema);
    loadConsentConfig.mockReset();
    readFile.mockReset();
    loggerWarn.mockReset();
    originalOrgFlag = process.env.ORG_HIERARCHY_ENABLED;
    delete process.env.ORG_HIERARCHY_ENABLED;
  });

  afterEach(() => {
    if (originalOrgFlag === undefined) delete process.env.ORG_HIERARCHY_ENABLED;
    else process.env.ORG_HIERARCHY_ENABLED = originalOrgFlag;
  });

  it('redirects to /dashboard when a session already exists', async () => {
    getSession.mockResolvedValue({ sub: 'u1' });
    loadConsentConfig.mockResolvedValue(consentCfg());
    await RegisterPage();
    expect(redirect).toHaveBeenCalledWith('/dashboard');
  });

  it('renders RegisterView with the coordinator schema and consent content when hierarchy is off', async () => {
    loadConsentConfig.mockResolvedValue(consentCfg());
    const el = await RegisterPage();
    expect(el.props.schema).toBe(coordSchema.schema);
    expect(el.props.orgHierarchyEnabled).toBe(false);
    expect(el.props.aggregatorConsentContent).toEqual({
      terms: { version: 1, title: 'Terms', content: 'T' },
      privacy: { version: 1, title: 'Privacy', content: 'P' },
    });
    expect(el.props.orgSchema).toBeUndefined();
  });

  it('degrades consent content to null on a load failure (no API round-trip)', async () => {
    loadConsentConfig.mockRejectedValue(new Error('file not found'));
    const el = await RegisterPage();
    expect(el.props.aggregatorConsentContent).toBeNull();
    expect(el.props.orgConsentContent).toBeNull();
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'loadConsentContent', status: 'failure' }),
    );
  });

  it('loads the org schema and enables the flag when ORG_HIERARCHY_ENABLED=true', async () => {
    process.env.ORG_HIERARCHY_ENABLED = 'true';
    loadConsentConfig.mockResolvedValue(consentCfg());
    readFile.mockImplementation((path: string) => {
      if (path.includes('org-registration.v1.ui.json')) return Promise.resolve('{}');
      return Promise.resolve(JSON.stringify({ title: 'Org', properties: {} }));
    });

    const el = await RegisterPage();
    expect(el.props.orgHierarchyEnabled).toBe(true);
    expect(el.props.orgSchema).toEqual({ title: 'Org', properties: {} });
    expect(el.props.orgUiSchema).toEqual({});
  });

  it('degrades to coordinator-only when the org schema files are missing', async () => {
    process.env.ORG_HIERARCHY_ENABLED = 'true';
    loadConsentConfig.mockResolvedValue(consentCfg());
    readFile.mockRejectedValue(new Error('ENOENT'));

    const el = await RegisterPage();
    expect(el.props.orgHierarchyEnabled).toBe(true);
    expect(el.props.orgSchema).toBeUndefined();
  });

  it('does not attempt to load the org schema when the flag is off', async () => {
    loadConsentConfig.mockResolvedValue(consentCfg());
    await RegisterPage();
    expect(readFile).not.toHaveBeenCalled();
  });
});
