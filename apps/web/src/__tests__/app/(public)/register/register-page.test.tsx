/**
 * Server-component test: `(public)/register/page.tsx`.
 *
 * Invokes the async page function directly. Covers: the session-redirect
 * guard, the consent-load-failure → null fallback (per CLAUDE.md's "Consent
 * content has no API round-trip" note), and that — after #619 — the main
 * register page never loads the org schema (owner registration moved to the
 * `/register/owner` deep link) yet still surfaces the org-hierarchy flag so the
 * coordinator's parent-org selector can render.
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
    // Owner registration moved to the deep link — no org props here anymore.
    expect(el.props.orgSchema).toBeUndefined();
    expect(el.props.orgConsentContent).toBeUndefined();
  });

  it('degrades consent content to null on a load failure (no API round-trip)', async () => {
    loadConsentConfig.mockRejectedValue(new Error('file not found'));
    const el = await RegisterPage();
    expect(el.props.aggregatorConsentContent).toBeNull();
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'loadConsentContent', status: 'failure' }),
    );
  });

  it('surfaces the org-hierarchy flag without loading the org schema when ORG_HIERARCHY_ENABLED=true', async () => {
    process.env.ORG_HIERARCHY_ENABLED = 'true';
    loadConsentConfig.mockResolvedValue(consentCfg());

    const el = await RegisterPage();
    expect(el.props.orgHierarchyEnabled).toBe(true);
    // The main page never touches the org schema now — that is the owner route's job.
    expect(el.props.orgSchema).toBeUndefined();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('never loads the org schema when the flag is off', async () => {
    loadConsentConfig.mockResolvedValue(consentCfg());
    await RegisterPage();
    expect(readFile).not.toHaveBeenCalled();
  });
});
