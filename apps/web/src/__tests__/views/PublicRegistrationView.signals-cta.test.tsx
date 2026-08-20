/**
 * View test: the Signals "Already Registered — Sign In" CTA (#652).
 *
 * Covers the two config gates (per-mode `signals_cta`, per-domain
 * `signals_ui_urls`) across both public form surfaces — the full-profile RJSF
 * form and the account-only MinimalIdentityForm. RJSF is mocked to the same
 * thin shim used by PublicRegistrationView.lookup.test.tsx: the CTA is
 * rendered as a child of the form, so the shim must render `children`.
 *
 * The RJSF shim, the fixture config, and the render helper come from
 * `./publicRegistrationView.testHelpers` — shared with
 * `PublicRegistrationView.signals-redirect.test.tsx`, which exercises the
 * same two config gates on the post-submit hand-off.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { screen } from '@testing-library/react';
import { RjsfShim, CFG, renderPublicRegistrationView } from './publicRegistrationView.testHelpers';

// jsdom does not implement scrollIntoView; the error banner's focus effect
// calls it whenever state transitions to 'error'.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

vi.mock('@/components/forms/RjsfThemed', () => ({ RjsfThemedForm: RjsfShim }));

// Config drives the CTA entirely; each test supplies its own payload.
const cfgMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig: () => ({ data: cfgMock.value }),
  DEFAULT_AGGREGATOR_CONFIG: cfgMock.value,
}));

// Pull the view after mocks register.
import { PublicRegistrationView } from '@/app/[org]/[slug]/PublicRegistrationView';

/**
 * Render the public registration view for one link shape. Everything the CTA
 * depends on comes from the mocked config; the props here only select which
 * form surface renders and which mode/domain the link declares.
 */
function renderView(opts: {
  domain: string;
  registrationMode: string | null;
  submissionShape: 'account_only' | 'account_and_profile';
}) {
  return renderPublicRegistrationView(PublicRegistrationView, opts);
}

describe('Signals sign-in CTA', () => {
  it('renders on the full-profile form and opens the domain URL in a new tab', () => {
    cfgMock.value = CFG;
    renderView({
      domain: 'seeker',
      registrationMode: 'form',
      submissionShape: 'account_and_profile',
    });
    const link = screen.getByRole('link', { name: /already registered/i });
    expect(link).toHaveAttribute('href', 'https://signals-seeker.example/auth/login');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('is absent when the mode has signals_cta false', () => {
    cfgMock.value = CFG;
    renderView({ domain: 'seeker', registrationMode: 'voice', submissionShape: 'account_only' });
    expect(screen.queryByRole('link', { name: /already registered/i })).toBeNull();
  });

  it('is absent when the domain has no configured URL', () => {
    cfgMock.value = { ...CFG, signals_ui_urls: {} };
    renderView({
      domain: 'seeker',
      registrationMode: 'form',
      submissionShape: 'account_and_profile',
    });
    expect(screen.queryByRole('link', { name: /already registered/i })).toBeNull();
  });

  it('renders on the account-only form when signals_cta is explicitly enabled for voice', () => {
    cfgMock.value = {
      ...CFG,
      registration_modes: {
        ...CFG.registration_modes,
        voice: { ...CFG.registration_modes.voice, signals_cta: true },
      },
    };
    renderView({ domain: 'seeker', registrationMode: 'voice', submissionShape: 'account_only' });
    expect(screen.getByRole('link', { name: /already registered/i })).toBeInTheDocument();
  });

  it('falls back to the submission shape when the mode is unknown to the config', () => {
    cfgMock.value = CFG;
    renderView({
      domain: 'seeker',
      registrationMode: 'kiosk',
      submissionShape: 'account_and_profile',
    });
    expect(screen.getByRole('link', { name: /already registered/i })).toBeInTheDocument();
  });
});
