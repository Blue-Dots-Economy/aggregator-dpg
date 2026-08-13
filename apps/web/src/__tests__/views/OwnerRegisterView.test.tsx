/**
 * View test: <OwnerRegisterView /> — the owner (organisation) deep-link view
 * (#619). Confirms it renders the org form inside the shared shell with the
 * owner heading and the "Register as aggregator owner" submit CTA.
 *
 * RJSF and useAggregatorConfig are shimmed so the test exercises the view's own
 * composition, not third-party rendering.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

vi.mock('@/components/forms/RjsfThemed', () => ({
  RjsfThemedForm: ({ children }: { children?: ReactNode }) => (
    <form data-testid="rjsf-shim">{children}</form>
  ),
}));

vi.mock('@/hooks/useAggregatorConfig', () => {
  const cfg = { brand: { short_name: 'Test' }, domains: [{ id: 'seeker', label: 'Seeker' }] };
  return {
    useAggregatorConfig: () => ({ data: cfg, isLoading: false }),
    DEFAULT_AGGREGATOR_CONFIG: cfg,
  };
});

import { OwnerRegisterView } from '@/app/(public)/register/owner/OwnerRegisterView';

const orgSchema = { title: 'Organisation Registration', type: 'object', properties: {} } as never;

describe('<OwnerRegisterView />', () => {
  it('renders the org form under the owner heading + CTA', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <OwnerRegisterView schema={orgSchema} uiSchema={{}} orgConsentContent={null} />
      </NextIntlClientProvider>,
    );

    expect(
      screen.getByRole('heading', { name: messages.register.owner_page_title }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: messages.register.org_submit })).toBeInTheDocument();
    expect(screen.getByTestId('rjsf-shim')).toBeInTheDocument();
    // No coordinator/owner tab switch on the deep-link page.
    expect(screen.queryByRole('tab')).toBeNull();
  });
});
