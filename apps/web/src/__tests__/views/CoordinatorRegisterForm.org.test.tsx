/**
 * View test: the organisation picker of <CoordinatorRegisterForm />.
 *
 * Covers: the Default org is preselected when it is the only active org; a
 * real org fills the hidden `name` with its name; switching back to the
 * Default org clears that name; an invite fills it with the invite's org.
 * The RJSF form and the Radix select are replaced by plain elements so the
 * test can read the form data and pick an org.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';
import { makeQueryClient } from '@/__tests__/test-utils';

vi.mock('@/components/forms/RjsfThemed', () => ({
  RjsfThemedForm: ({
    formData,
    children,
  }: {
    formData: Record<string, unknown>;
    children?: ReactNode;
  }) => (
    <form data-testid="rjsf-shim">
      <output data-testid="form-name">{String(formData['name'] ?? '')}</output>
      {children}
    </form>
  ),
}));

vi.mock('@/components/ui/Select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange: (v: string) => void;
    children?: ReactNode;
  }) => (
    <select
      aria-label="Organisation"
      value={value ?? ''}
      onChange={(e) => onValueChange(e.currentTarget.value)}
    >
      <option value="">none</option>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

vi.mock('@/hooks/useAggregatorConfig', () => {
  const cfg = { brand: { short_name: 'Test' }, domains: [{ id: 'seeker', label: 'Seeker' }] };
  return {
    useAggregatorConfig: () => ({ data: cfg, isLoading: false }),
    DEFAULT_AGGREGATOR_CONFIG: cfg,
  };
});

import { CoordinatorRegisterForm } from '@/app/(public)/register/CoordinatorRegisterForm';

const SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string', title: 'Organisation Name' } },
} as never;

const DEFAULT_ORG = { id: 'org-default', slug: 'default', display_name: 'Default' };
const REAL_ORG = { id: 'org-real', slug: 'jfc', display_name: 'JFC' };

function stubOrgs(orgs: Array<typeof DEFAULT_ORG>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ orgs }), { status: 200 })),
  );
}

function renderForm(props: { inviteToken?: string; lockedOrgName?: string } = {}) {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <NextIntlClientProvider locale="en" messages={messages}>
        <CoordinatorRegisterForm schema={SCHEMA} uiSchema={{}} consentContent={null} {...props} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe('<CoordinatorRegisterForm /> organisation picker', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preselects the Default org when it is the only active org', async () => {
    stubOrgs([DEFAULT_ORG]);
    renderForm();
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue(DEFAULT_ORG.id));
    expect(screen.getByTestId('form-name')).toHaveTextContent('');
  });

  it('leaves the picker empty when there is more than one org', async () => {
    stubOrgs([DEFAULT_ORG, REAL_ORG]);
    renderForm();
    await screen.findByRole('option', { name: REAL_ORG.display_name });
    expect(screen.getByRole('combobox')).toHaveValue('');
  });

  it('fills the hidden name with a real org, and clears it on switching to Default', async () => {
    stubOrgs([DEFAULT_ORG, REAL_ORG]);
    renderForm();
    await screen.findByRole('option', { name: REAL_ORG.display_name });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: REAL_ORG.id } });
    expect(screen.getByTestId('form-name')).toHaveTextContent('JFC');

    fireEvent.change(screen.getByRole('combobox'), { target: { value: DEFAULT_ORG.id } });
    expect(screen.getByTestId('form-name')).toHaveTextContent('');
  });

  it("fills the hidden name with the invite's org", () => {
    stubOrgs([]);
    renderForm({ inviteToken: 'h.p.s', lockedOrgName: 'JFC' });
    expect(screen.getByTestId('form-name')).toHaveTextContent('JFC');
  });
});
